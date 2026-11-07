//! 暂存区（内存态）——单例托管状态
//!
//! 设计动机（对应 HANDOFF §8-1 P0 缺陷）：
//! 旧实现把「概念收集区」与「白板收集区」分别放在两个 `Arc<Mutex<Vec<StagedWord>>>`
//! 里，而 Tauri 的托管状态按 `TypeId` 索引，同类型第二次 `.manage()` 会直接 panic，
//! 导致白板收集区只能被桥接独占、Tauri command 无法访问，于是 `stage_word` 不区分
//! `target`，白板页写入的词全部落到概念区——两条链路不闭合。
//!
//! 现在收敛为一个 `CacheStore`（内部按 `Target` 分区），只 `.manage()` 一次：
//! - 消除 TypeId 冲突与 newtype 包裹的样板；
//! - `target` 分发、去重、长度上限、全文快照槽位集中在一个地方，桥接与命令层行为一致；
//! - 锁临界区仍然只做内存操作，不跨 `await`（`std::sync::Mutex`）。

use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

/// 全文快照特殊标记：插件「分析当前对话」用该 term 推送整页文本。
/// 前端 `GraphPage` 依赖列表里存在该标记词来决定「分析全文」按钮可用性，**不可移除**。
pub const FULL_CONTEXT_MARKER: &str = "__FULL_CONTEXT__";

/// 单个收集区最多保留的词条数（FIFO 淘汰，防插件失控刷爆内存）
pub const STAGE_LIMIT: usize = 200;
/// 词条 term 最大字符数（划词本身很短，超长一律截断，避免 UI/事件被撑爆）
pub const TERM_MAX_CHARS: usize = 200;
/// 单条上下文最大字符数（插件侧上限 5000，这里再兜一层）
pub const CONTEXT_MAX_CHARS: usize = 24_000;

/// 收集目标：概念图谱 / 白板收集区
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Graph,
    Whiteboard,
}

impl Target {
    pub fn as_str(self) -> &'static str {
        match self {
            Target::Graph => "graph",
            Target::Whiteboard => "whiteboard",
        }
    }

    /// 非法值兜底为 graph（插件/前端历史版本可能不传 target）
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "whiteboard" | "board" => Target::Whiteboard,
            _ => Target::Graph,
        }
    }
}

/// 插件端划词推来的词条（POST /api/add-to-graph 接收）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedWord {
    /// 划词内容（概念词）
    pub term: String,
    #[serde(default)]
    pub context_text: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub page_title: Option<String>,
    /// 入站时间戳（毫秒；缺省由后端补）
    #[serde(default)]
    pub added_at: u64,
    /// 收集目标："graph"（默认）| "whiteboard"
    #[serde(default = "default_target")]
    pub target: String,
}

fn default_target() -> String {
    "graph".to_string()
}

impl StagedWord {
    /// 规范化：trim、截断、target 归一。term 为空返回 None。
    fn normalized(mut self) -> Option<(Target, Self)> {
        self.term = self.term.trim().to_string();
        if self.term.is_empty() {
            return None;
        }
        self.term = truncate_chars(&self.term, TERM_MAX_CHARS);
        if let Some(ctx) = self.context_text.take() {
            let ctx = truncate_chars(ctx.trim(), CONTEXT_MAX_CHARS);
            self.context_text = if ctx.is_empty() { None } else { Some(ctx) };
        }
        self.source_url = self.source_url.map(|s| truncate_chars(&s, 2048));
        self.page_title = self.page_title.map(|s| truncate_chars(&s, 512));
        let target = Target::parse(&self.target);
        self.target = target.as_str().to_string();
        if self.added_at == 0 {
            self.added_at = super::now_millis();
        }
        Some((target, self))
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// 入队结果（回给桥接层拼响应文案）
pub struct PushOutcome {
    pub target: Target,
    /// 入队后该分区的词条总数
    pub len: usize,
    /// true = 新词条；false = 同词同目标已存在，已刷新上下文
    pub is_new: bool,
    /// 本次是否为全文快照
    pub is_full_context: bool,
    /// 规范化后实际入库的词条
    pub word: StagedWord,
}

#[derive(Default)]
struct Inner {
    graph: Vec<StagedWord>,
    whiteboard: Vec<StagedWord>,
    /// 待分析全文快照（覆盖式单槽位；列表里另有标记词，二者同时维护）
    full_context: Option<StagedWord>,
    batch_mode: bool,
}

/// 内存暂存区（Tauri managed state，只注册一次）
///
/// 内部 `Arc` 让桥接层与命令层共享同一实例，且 `Clone` 可直接进入 axum State。
#[derive(Default, Clone)]
pub struct CacheStore(Arc<Mutex<Inner>>);

impl CacheStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// poison 恢复：某次 panic 不应让整个收集区永久不可用
    fn lock(&self) -> MutexGuard<'_, Inner> {
        match self.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// 写入词条（按 target 分发；同词同目标去重刷新）
    pub fn push(&self, word: StagedWord) -> Result<PushOutcome, &'static str> {
        let (target, word) = word.normalized().ok_or("term 不能为空")?;
        let is_full_context = target == Target::Graph && word.term == FULL_CONTEXT_MARKER;

        let mut inner = self.lock();

        if is_full_context {
            // 全文快照：独立槽位 + 列表标记词双写（前端契约，见 HANDOFF 红线 5）
            inner.full_context = Some(word.clone());
            inner.graph.retain(|w| w.term != FULL_CONTEXT_MARKER);
            inner.graph.push(word.clone());
            return Ok(PushOutcome {
                target,
                len: inner.graph.len(),
                is_new: true,
                is_full_context: true,
                word,
            });
        }

        let list = match target {
            Target::Graph => &mut inner.graph,
            Target::Whiteboard => &mut inner.whiteboard,
        };

        if let Some(existing) = list
            .iter_mut()
            .find(|w| w.term == word.term && w.target == word.target)
        {
            existing.context_text = word.context_text;
            existing.source_url = word.source_url;
            existing.page_title = word.page_title;
            existing.added_at = word.added_at;
            let stored = existing.clone();
            return Ok(PushOutcome {
                target,
                len: list.len(),
                is_new: false,
                is_full_context: false,
                word: stored,
            });
        }

        list.push(word.clone());
        // FIFO 淘汰：优先丢最旧的非标记词
        while list.len() > STAGE_LIMIT {
            match list.iter().position(|w| w.term != FULL_CONTEXT_MARKER) {
                Some(idx) => {
                    list.remove(idx);
                }
                None => break,
            }
        }
        Ok(PushOutcome {
            target,
            len: list.len(),
            is_new: true,
            is_full_context: false,
            word,
        })
    }

    pub fn words(&self, target: Target) -> Vec<StagedWord> {
        let inner = self.lock();
        match target {
            Target::Graph => inner.graph.clone(),
            Target::Whiteboard => inner.whiteboard.clone(),
        }
    }

    /// 计数口径：不含 `__FULL_CONTEXT__` 标记词（与插件本地计数对齐）
    pub fn count(&self, target: Target) -> usize {
        let inner = self.lock();
        let list = match target {
            Target::Graph => &inner.graph,
            Target::Whiteboard => &inner.whiteboard,
        };
        list.iter().filter(|w| w.term != FULL_CONTEXT_MARKER).count()
    }

    pub fn full_context(&self) -> Option<StagedWord> {
        self.lock().full_context.clone()
    }

    /// 删除指定词（trim 后相等全部删除），返回删除后的权威列表
    pub fn remove_term(&self, target: Target, term: &str) -> Vec<StagedWord> {
        let needle = term.trim();
        let mut inner = self.lock();
        if target == Target::Graph && needle == FULL_CONTEXT_MARKER {
            inner.full_context = None;
        }
        let list = match target {
            Target::Graph => &mut inner.graph,
            Target::Whiteboard => &mut inner.whiteboard,
        };
        if !needle.is_empty() {
            list.retain(|w| w.term.trim() != needle);
        }
        list.clone()
    }

    /// 清空指定分区（图谱分区同时清空全文快照槽位）
    pub fn clear(&self, target: Target) -> Vec<StagedWord> {
        let mut inner = self.lock();
        if target == Target::Graph {
            inner.full_context = None;
        }
        let list = match target {
            Target::Graph => &mut inner.graph,
            Target::Whiteboard => &mut inner.whiteboard,
        };
        list.clear();
        list.clone()
    }

    /// 弹出最后一个普通词条（跳过全文标记词，避免「撤销」误删全文快照）
    pub fn pop_last(&self, target: Target) -> Option<StagedWord> {
        let mut inner = self.lock();
        let list = match target {
            Target::Graph => &mut inner.graph,
            Target::Whiteboard => &mut inner.whiteboard,
        };
        let idx = list.iter().rposition(|w| w.term != FULL_CONTEXT_MARKER)?;
        Some(list.remove(idx))
    }

    pub fn batch_mode(&self) -> bool {
        self.lock().batch_mode
    }

    pub fn set_batch_mode(&self, enabled: bool) -> bool {
        self.lock().batch_mode = enabled;
        enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(term: &str, target: &str) -> StagedWord {
        StagedWord {
            term: term.to_string(),
            context_text: Some("ctx".into()),
            source_url: None,
            page_title: None,
            added_at: 0,
            target: target.to_string(),
        }
    }

    #[test]
    fn routes_by_target() {
        let store = CacheStore::new();
        store.push(word("甲", "graph")).unwrap();
        store.push(word("乙", "whiteboard")).unwrap();
        assert_eq!(store.count(Target::Graph), 1);
        assert_eq!(store.count(Target::Whiteboard), 1);
        assert_eq!(store.words(Target::Whiteboard)[0].term, "乙");
    }

    #[test]
    fn dedupes_same_term_and_target() {
        let store = CacheStore::new();
        let first = store.push(word("甲", "graph")).unwrap();
        let second = store.push(word("甲", "graph")).unwrap();
        assert!(first.is_new && !second.is_new);
        assert_eq!(store.count(Target::Graph), 1);
    }

    #[test]
    fn full_context_slot_and_marker() {
        let store = CacheStore::new();
        let out = store.push(word(FULL_CONTEXT_MARKER, "graph")).unwrap();
        assert!(out.is_full_context);
        assert!(store.full_context().is_some());
        assert_eq!(store.count(Target::Graph), 0); // 标记词不计入
        assert_eq!(store.words(Target::Graph).len(), 1); // 但列表里保留
        assert!(store.pop_last(Target::Graph).is_none()); // 撤销不误删
    }

    #[test]
    fn caps_list_length() {
        let store = CacheStore::new();
        for i in 0..(STAGE_LIMIT + 20) {
            store.push(word(&format!("w{i}"), "graph")).unwrap();
        }
        assert_eq!(store.words(Target::Graph).len(), STAGE_LIMIT);
    }
}
