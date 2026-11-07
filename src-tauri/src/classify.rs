//! 概念分类（LLM 自动打标）
//!
//! 前端已把「词语类型」定义为封闭集合 `ConceptKind`：
//! `term`（专业名词）/ `academic`（学术用语）/ `engineering`（工程用语）/
//! `popular`（民间科普）/ `note`（自定义笔记）。
//!
//! 本模块做两件事：
//! 1. `classify_terms`：一次批量 LLM 调用给一批词打标，输出严格落在封闭集合内；
//! 2. `heuristic_kind`：LLM 不可用（超时/未配置/返回不合法）时的本地兜底，
//!    规则与前端 `useWordLibraryStore.guessKind` 保持一致，保证两条路径结果同构。
//!
//! 设计约束：
//! - 分类结果**不写入** GraphProject（避免改动前端类型契约），只作为命令回传给前端，
//!   由前端写入自己的词库 store（`kindSource: "auto"`）。
//! - 单次调用最多 60 个词；超出截断并在结果里标注，避免长上下文把免费额度打光。

use serde::{Deserialize, Serialize};

use crate::LlmConfig;

/// 合法类型集合（与前端 `CONCEPT_KINDS` 完全一致，顺序也一致）
pub const KINDS: [&str; 5] = ["term", "academic", "engineering", "popular", "note"];

/// 单次请求最多分类的词数
pub const MAX_TERMS_PER_CALL: usize = 60;

/// 单个分类结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedTerm {
    /// 原词（归一化后的 trim 结果）
    pub term: String,
    /// 类型，取值必在 `KINDS` 内
    pub kind: String,
    /// 判定理由（≤20 字，可空）
    #[serde(default)]
    pub reason: Option<String>,
    /// true = 本次结果来自本地启发式（LLM 不可用）
    #[serde(default)]
    pub heuristic: bool,
}

/// 命令返回体
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyResult {
    pub items: Vec<ClassifiedTerm>,
    /// true = 整批降级为启发式（LLM 调用失败）
    pub degraded: bool,
    /// 降级原因（便于前端提示，不展示内部堆栈）
    pub error: Option<String>,
    /// 因超过 `MAX_TERMS_PER_CALL` 被截断的词数
    pub truncated: usize,
}

/// 本地启发式：与前端 `guessKind` 同规则（改一处必须同步另一处）
pub fn heuristic_kind(term: &str) -> &'static str {
    let t = term.trim();
    if t.is_empty() {
        return "term";
    }
    let academic = ["定理", "定律", "原理", "效应", "假说", "悖论", "范式", "学说", "理论"];
    if academic.iter().any(|k| t.contains(k)) || t.ends_with('论') {
        return "academic";
    }
    let engineering_suffix = [
        "算法", "协议", "接口", "架构", "引擎", "驱动", "框架", "编译", "部署", "缓存", "中间件",
        "线程", "进程", "数据库", "服务器",
    ];
    let engineering_prefix = ["API", "SDK", "CPU", "GPU", "HTTP", "TCP", "IP", "SQL", "CI/CD", "DevOps"];
    if engineering_suffix.iter().any(|k| t.ends_with(k))
        || engineering_prefix
            .iter()
            .any(|k| t.to_ascii_uppercase().starts_with(k))
    {
        return "engineering";
    }
    let popular = ["俗称", "大白话", "简单来说", "比方", "好比", "其实就是"];
    if popular.iter().any(|k| t.contains(k)) {
        return "popular";
    }
    let note = ["吗", "呢", "？", "?", "为什么", "怎么", "啥", "不懂", "没懂"];
    if note.iter().any(|k| t.contains(k)) || t.chars().count() > 12 {
        return "note";
    }
    "term"
}

/// 解析模型输出：容忍 Markdown 围栏、前后废话、对象数组 / `{"items":[...]}` 两种外壳。
/// 返回 **只包含输入词** 的结果列表（模型多给/少给都会被校正）。
pub fn parse_classification(raw: &str, terms: &[String]) -> Option<Vec<ClassifiedTerm>> {
    let start = raw.find('[').or_else(|| raw.find('{'))?;
    let end = raw.rfind(']').or_else(|| raw.rfind('}'))?;
    if end <= start {
        return None;
    }
    let slice = &raw[start..=end];
    let value: serde_json::Value = serde_json::from_str(slice).ok()?;

    let arr = if let Some(a) = value.as_array() {
        a.clone()
    } else {
        value
            .get("items")
            .or_else(|| value.get("results"))
            .or_else(|| value.get("data"))
            .and_then(|v| v.as_array())
            .cloned()?
    };

    let normalize_kind = |k: &str| -> Option<&'static str> {
        let k = k.trim().to_ascii_lowercase();
        KINDS
            .iter()
            .find(|valid| **valid == k)
            .copied()
            .or_else(|| match k.as_str() {
                "专业名词" | "术语" | "名词" | "专业术语" => Some("term"),
                "学术" | "学术用语" | "理论" => Some("academic"),
                "工程" | "工程用语" | "技术" => Some("engineering"),
                "科普" | "民间科普" | "通俗" => Some("popular"),
                "笔记" | "自定义笔记" | "批注" | "疑问" => Some("note"),
                _ => None,
            })
    };

    let by_term: std::collections::HashMap<String, (String, Option<String>)> = arr
        .iter()
        .filter_map(|item| {
            let term = item
                .get("term")
                .or_else(|| item.get("word"))
                .or_else(|| item.get("text"))
                .and_then(|v| v.as_str())?
                .trim()
                .to_string();
            let kind_raw = item
                .get("kind")
                .or_else(|| item.get("type"))
                .or_else(|| item.get("category"))
                .and_then(|v| v.as_str())?;
            let kind = normalize_kind(kind_raw)?;
            let reason = item
                .get("reason")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Some((term, (kind.to_string(), reason)))
        })
        .collect();

    if by_term.is_empty() {
        return None;
    }

    let mut out = Vec::with_capacity(terms.len());
    for term in terms {
        match by_term.get(term) {
            Some((kind, reason)) => out.push(ClassifiedTerm {
                term: term.clone(),
                kind: kind.clone(),
                reason: reason.clone(),
                heuristic: false,
            }),
            None => out.push(ClassifiedTerm {
                term: term.clone(),
                kind: heuristic_kind(term).to_string(),
                reason: Some("模型未覆盖，本地兜底".to_string()),
                heuristic: true,
            }),
        }
    }
    Some(out)
}

fn build_system_prompt() -> String {
    "你是概念词分类器。给定一组从网页划词/文章抽取的中文概念词，为每个词判定唯一类型。\n\
类型只能取以下五个英文枚举之一：\n\
- term：领域内的标准术语、专有名词（如「边际效用」「欧拉公式」）\n\
- academic：理论、定理、效应、假说、范式等学术表述（如「科斯定理」「路径依赖」）\n\
- engineering：工程实践中的工具、协议、架构、算法、工艺（如「反向代理」「依赖注入」）\n\
- popular：通俗化、比喻式、口语化的科普表达（如「大白话讲讲熵」）\n\
- note：个人批注、疑问、联想、非术语短语（如「这里为什么成立?」）\n\
只输出 JSON 数组，不要 Markdown 围栏、不要解释，格式：\n\
[{\"term\":\"原词\",\"kind\":\"term\",\"reason\":\"不超过20字的判定依据\"}]\n\
必须覆盖输入中的每一个词，term 必须与输入完全一致。"
        .to_string()
}

/// 批量分类：LLM 优先，失败整批降级为启发式（命令层据此把 `degraded` 置 true）
pub async fn classify_terms(
    terms: Vec<String>,
    provider: &LlmConfig,
) -> ClassifyResult {
    let mut cleaned: Vec<String> = Vec::new();
    for t in terms {
        let t = t.trim().to_string();
        if !t.is_empty() && !cleaned.contains(&t) {
            cleaned.push(t);
        }
    }
    let total = cleaned.len();
    let truncated = total.saturating_sub(MAX_TERMS_PER_CALL);
    cleaned.truncate(MAX_TERMS_PER_CALL);

    if cleaned.is_empty() {
        return ClassifyResult {
            items: Vec::new(),
            degraded: false,
            error: None,
            truncated: 0,
        };
    }

    // 单词不必调用模型：启发式足够，且省一次网络往返
    if cleaned.len() == 1 {
        let term = cleaned[0].clone();
        return ClassifyResult {
            items: vec![ClassifiedTerm {
                kind: heuristic_kind(&term).to_string(),
                term,
                reason: Some("单词直接走本地规则".to_string()),
                heuristic: true,
            }],
            degraded: false,
            error: None,
            truncated,
        };
    }

    let user = format!("待分类概念词（共 {} 个）：\n{}", cleaned.len(), cleaned.join("\n"));

    match crate::call_llm_text(provider, &build_system_prompt(), &user).await {
        Ok(raw) => match parse_classification(&raw, &cleaned) {
            Some(items) => ClassifyResult {
                items,
                degraded: false,
                error: None,
                truncated,
            },
            None => {
                eprintln!("[classify] 模型输出无法解析，降级启发式。原文前 300 字: {}", crate::truncate(&raw, 300));
                fallback(cleaned, truncated, "模型返回格式不合法，已用本地规则兜底")
            }
        },
        Err(e) => {
            eprintln!("[classify] LLM 调用失败，降级启发式: {e}");
            fallback(cleaned, truncated, &e)
        }
    }
}

fn fallback(terms: Vec<String>, truncated: usize, error: &str) -> ClassifyResult {
    let items = terms
        .into_iter()
        .map(|term| ClassifiedTerm {
            kind: heuristic_kind(&term).to_string(),
            term,
            reason: Some("LLM 不可用，本地规则兜底".to_string()),
            heuristic: true,
        })
        .collect();
    ClassifyResult {
        items,
        degraded: true,
        error: Some(error.to_string()),
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heuristic_matches_frontend_rules() {
        assert_eq!(heuristic_kind("科斯定理"), "academic");
        assert_eq!(heuristic_kind("反向代理"), "term"); // 后缀不在词典内 → term
        assert_eq!(heuristic_kind("依赖注入算法"), "engineering");
        assert_eq!(heuristic_kind("HTTP 缓存"), "engineering");
        assert_eq!(heuristic_kind("简单来说就是熵"), "popular");
        assert_eq!(heuristic_kind("这里为什么成立?"), "note");
        assert_eq!(heuristic_kind("边际效用"), "term");
    }

    #[test]
    fn parse_tolerates_fences_and_shells() {
        let terms = vec!["科斯定理".to_string(), "反向代理".to_string()];
        let raw = "```json\n{\"items\":[{\"term\":\"科斯定理\",\"kind\":\"academic\",\"reason\":\"定理\"}]}\n```";
        let out = parse_classification(raw, &terms).expect("should parse");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].kind, "academic");
        // 缺失的词回落启发式
        assert_eq!(out[1].kind, heuristic_kind("反向代理"));
        assert!(out[1].heuristic);
    }

    #[test]
    fn parse_rejects_unknown_kind() {
        let terms = vec!["甲".to_string()];
        let raw = r#"[{"term":"甲","kind":"unknown"}]"#;
        assert!(parse_classification(raw, &terms).is_none());
    }
}
