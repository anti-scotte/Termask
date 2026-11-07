//! TermAsk 工作台 - Tauri 后端
//!
//! 核心职责：
//! 1. 起一个仅监听 127.0.0.1 的本地 HTTP 桥接服务（Axum），
//!    接收浏览器扩展推送的概念关系数据 / 划词词条，
//!    再通过 Tauri Event 转发给前端；划词词条同时存入内存暂存区。
//! 2. 提供若干 command：测试连接、关系推导、逻辑链生成、图谱生成、
//!    图谱本地持久化、暂存区读写（含增删清空与计数）。
//!
//! LLM 侧全部走「OpenAI 兼容」通用协议（`/chat/completions`），
//! 因此 DeepSeek-V4-Flash、免费 Gemini（`/v1beta/openai`）、Kimi、GLM、
//! Ollama 兼容层等只要 baseUrl + model 填对即可，无需改代码。

//! 模块划分（2026-11-05 结构治理）：
//! - `cache`   —— 内存暂存区（概念 / 白板 / 全文快照 / 批量开关），单一托管状态
//! - `bridge`  —— 本地 HTTP 桥接（Axum），只做协议转换与事件广播
//! - `security`—— 桥接安全层（Origin 白名单 / 令牌 / 限流 / 响应头）
//! - 本文件    —— 领域数据、LLM 调用、账户与文件存储、Tauri command 与入口装配

mod bridge;
mod cache;
mod classify;
pub mod export;
mod security;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::ShortcutState;

pub use cache::{StagedWord, FULL_CONTEXT_MARKER};
use cache::{CacheStore, Target};

/// 桥接服务端口。扩展侧通过 fetch("http://127.0.0.1:17570/...") 调用。
pub const BRIDGE_PORT: u16 = bridge::BRIDGE_PORT;

// ---------------------------------------------------------------------------
// 概念图谱数据结构（与前端 src/types/index.ts 对齐，camelCase）
// ---------------------------------------------------------------------------

/// 节点坐标（布局持久化用，缺省时由前端布局算法计算）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptNode {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub level: Option<u8>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub position: Option<GraphPosition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptGraphPayload {
    pub session_id: String,
    #[serde(default)]
    pub source_excerpt: Option<String>,
    pub nodes: Vec<ConceptNode>,
    pub edges: Vec<ConceptEdge>,
}

/// 图谱模板类型（序列化为 "free" | "venn" | "chain"，与前端 GraphTemplate 对齐）。
/// 额外加 alias "logic-chain" 兜底兼容早期可能落盘的旧值。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum GraphTemplateType {
    Free,
    Venn,
    #[serde(alias = "logic-chain")]
    Chain,
}

/// AI 总结粒度：前端可选「低 / 中 / 高」，控制 summary 字数区间。
/// - Low（粗读）：120-200 字，只要主干结论
/// - Medium（标准）：200-400 字，讲清因果推进（默认，前端不传即此档）
/// - High（精读）：450-800 字，逐层展开 + 适用边界
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Granularity {
    Low,
    Medium,
    High,
}

impl Default for Granularity {
    fn default() -> Self {
        Granularity::Medium
    }
}

impl Granularity {
    /// summary 字数区间 (min, max)，喂进 prompt 与字数校验。
    fn summary_bounds(self) -> (usize, usize) {
        match self {
            Granularity::Low => (120, 200),
            Granularity::Medium => (200, 400),
            Granularity::High => (450, 800),
        }
    }

    /// 展示名（日志用）
    fn label(self) -> &'static str {
        match self {
            Granularity::Low => "粗读",
            Granularity::Medium => "标准",
            Granularity::High => "精读",
        }
    }
}

/// 多图谱工作区中的一个图谱项目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphProject {
    pub id: String,
    pub title: String,
    pub template_type: GraphTemplateType,
    pub nodes: Vec<ConceptNode>,
    pub edges: Vec<ConceptEdge>,
    /// 图谱核心逻辑链总结（字数由 granularity 决定：low 120-200 / medium 200-400 / high 450-800；
    /// 旧文件缺省为空串）
    #[serde(default)]
    pub summary: String,
    pub created_at: u64,
    pub updated_at: u64,
}

/// 通用 LLM 调用配置（测试连接 / 图谱生成共用）。
/// 现阶段由前端传入（apiKey 仍在前端），后续迁 keyring 后可省。
///
/// `kind` 决定协议：`openai-compatible`（DeepSeek / Gemini / Kimi / GLM / Ollama 兼容层 /
/// 任意 OpenAI 兼容网关）、`anthropic`、`ollama`（原生 /api/chat）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub kind: String, // "openai-compatible" | "anthropic" | "ollama"
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// `generate_graph_from_cache` 入参：划词词汇列表 + 上下文数组
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateGraphPayload {
    pub title: String,
    pub template_type: GraphTemplateType,
    /// 划词收集的概念词汇（可为空：整页对话场景完全由上下文提炼）
    pub concepts: Vec<String>,
    /// 上下文片段数组（可选）
    #[serde(default)]
    pub contexts: Vec<String>,
    /// 上下文送入 LLM 的字符总上限（可选）。
    /// 长窗口模型（DeepSeek-V4-Flash / Gemini 2.x）可传 100000+；
    /// 缺省 48000，硬上限 200000，低于 4000 按 4000 处理。
    #[serde(default)]
    pub max_context_chars: Option<usize>,
    /// AI 总结粒度（可选，缺省 Medium）：
    /// low=120-200 字 / medium=200-400 字 / high=450-800 字
    #[serde(default)]
    pub granularity: Option<Granularity>,
    pub provider: LlmConfig,
}

// 说明：LLM 返回的图谱不再用固定结构体反序列化——廉价/免费模型的字段名
// （name / relation / from-to 等）与数字 id 太不稳定，改用 `serde_json::Value`
// + 多字段名兜底解析（见 `parse_generated_graph`），否则整张图会因一个字段名不匹配而报废。

// ---------------------------------------------------------------------------
// 模型连接测试数据结构
// ---------------------------------------------------------------------------

/// 前端传入的连接测试请求。
/// 注意：必须加 `rename_all = "camelCase"`，否则前端传的
/// `baseUrl` / `apiKey` 无法反序列化到 Rust 的 `base_url` / `api_key`，
/// 会报 `invalid args payload`。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionPayload {
    pub kind: String, // "openai-compatible" | "anthropic" | "ollama"
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// 返回给前端的结果。
/// 加 `rename_all = "camelCase"` 后，`latency_ms` 序列化为 `latencyMs`、
/// `model_echo` 序列化为 `modelEcho`，与前端 bridge.ts 对齐。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub success: bool,
    pub latency_ms: u64,
    pub model_echo: Option<String>,
    pub error: Option<String>,
}


// ---------------------------------------------------------------------------
// 通用 LLM 工具函数
// ---------------------------------------------------------------------------

/// 判断 baseUrl 是否已带版本段（`/v1`、`/v4`、`/v1beta`…）。
/// 用「最后一段是否 v+数字」来判定，比白名单更耐新供应商
/// （GLM 是 `/api/paas/v4`、DashScope 是 `/compatible-mode/v1`、Ollama 是 `/v1`）。
fn base_has_version_segment(base: &str) -> bool {
    let last = base.rsplit('/').next().unwrap_or("");
    let mut chars = last.chars();
    if chars.next() != Some('v') {
        return false;
    }
    chars.next().map(|c| c.is_ascii_digit()).unwrap_or(false)
}

/// 拼接 OpenAI 兼容协议的端点 URL（统一入口）。
///
/// 兼容四种写法：
/// - `https://api.deepseek.com`            → `/v1/chat/completions`（补 v1）
/// - `https://api.deepseek.com/v1`         → `/v1/chat/completions`（不重复补）
/// - `https://open.bigmodel.cn/api/paas/v4`→ `/api/paas/v4/chat/completions`
/// - `https://generativelanguage.googleapis.com/v1beta/openai`
///                                         → `/v1beta/openai/chat/completions`（Gemini）
fn openai_endpoint(base_url: &str, tail: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base_has_version_segment(base) || base.ends_with("/openai") {
        format!("{base}/{tail}")
    } else {
        format!("{base}/v1/{tail}")
    }
}

/// `/chat/completions` 完整 URL（生成、关系推导、连接探测共用）。
fn openai_chat_url(base_url: &str) -> String {
    openai_endpoint(base_url, "chat/completions")
}

/// `/models` 完整 URL（连接探测用；部分网关不实现该端点，调用方需容错）。
fn openai_models_url(base_url: &str) -> String {
    openai_endpoint(base_url, "models")
}

/// 字符串按字符截断，超长追加省略号（日志/错误信息防爆）。
fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max_chars).collect();
        out.push_str("…");
        out
    }
}

/// 读取非 2xx 响应体，拼出带正文的详细错误（截断避免过长）。
/// 这是定位 400/401/404 根因的关键：把上游实际返回的原因透传出去。
async fn llm_error_detail(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp
        .text()
        .await
        .unwrap_or_else(|_| "<无法读取响应体>".to_string());
    format!("HTTP {status}: {}", truncate(body.trim(), 600))
}

// ---------------------------------------------------------------------------
// 模型连接测试 command
// ---------------------------------------------------------------------------

/// Tauri Command：测试模型连接。
/// 前端通过 invoke("test_model_connection", { payload }) 调用。
#[tauri::command]
async fn test_model_connection(
    payload: TestConnectionPayload,
) -> Result<TestConnectionResult, String> {
    let start = Instant::now();

    // 10 秒超时，防止请求无限挂起（QA 建议）
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let result: Result<String, String> = match payload.kind.as_str() {
        "openai-compatible" => {
            // 探测策略：优先 GET /models（不耗 token、最快）；
            // 部分 OpenAI 兼容网关（Gemini 兼容层等）未实现该端点，
            // 此时退化为一次 max_tokens=1 的最小 chat 请求，保证「填对了就能连上」。
            let models_url = openai_models_url(&payload.base_url);
            let resp = client
                .get(&models_url)
                .bearer_auth(&payload.api_key)
                .send()
                .await
                .map_err(|e| format!("网络请求失败: {e}"))?;

            if resp.status().is_success() {
                Ok(payload.model.clone())
            } else if matches!(resp.status().as_u16(), 404 | 405 | 501) {
                eprintln!(
                    "[test] {models_url} 不支持模型列表（HTTP {}），改用 /chat/completions 最小探测",
                    resp.status().as_u16()
                );
                let url = openai_chat_url(&payload.base_url);
                let body = serde_json::json!({
                    "model": payload.model,
                    "max_tokens": 1,
                    "temperature": 0.0,
                    "stream": false,
                    "messages": [{"role": "user", "content": "ping"}]
                });
                let resp = client
                    .post(&url)
                    .bearer_auth(&payload.api_key)
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| format!("网络请求失败: {e}"))?;

                if resp.status().is_success() {
                    Ok(payload.model.clone())
                } else {
                    Err(llm_error_detail(resp).await)
                }
            } else {
                Err(llm_error_detail(resp).await)
            }
        }
        "anthropic" => {
            let url = format!("{}/v1/messages", payload.base_url.trim_end_matches('/'));
            let body = serde_json::json!({
                "model": &payload.model,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "ping"}]
            });

            let resp = client
                .post(&url)
                .header("x-api-key", &payload.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("网络请求失败: {e}"))?;

            if resp.status().is_success() {
                Ok(payload.model.clone())
            } else {
                Err(llm_error_detail(resp).await)
            }
        }
        "ollama" => {
            let url = format!("{}/api/tags", payload.base_url.trim_end_matches('/'));
            let resp = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("网络请求失败: {e}"))?;

            if resp.status().is_success() {
                Ok(payload.model.clone())
            } else {
                Err(llm_error_detail(resp).await)
            }
        }
        other => Err(format!(
            "不支持的供应商类型: {other}（DeepSeek / Gemini / Kimi / GLM 等请统一选 openai-compatible）"
        )),
    };

    let latency_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(model_echo) => Ok(TestConnectionResult {
            success: true,
            latency_ms,
            model_echo: Some(model_echo),
            error: None,
        }),
        Err(err) => Ok(TestConnectionResult {
            success: false,
            latency_ms,
            model_echo: None,
            error: Some(err),
        }),
    }
}

// ---------------------------------------------------------------------------
// 生成节点关系 command（图谱工作区：多选两节点 → LLM 生成关系词）
// ---------------------------------------------------------------------------

/// generate_relation 请求负载（前端 camelCase）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRelationPayload {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub node_a: String,
    pub node_b: String,
    /// 原文语境（可选，帮助消歧）
    pub context: Option<String>,
}

/// generate_relation 返回
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRelationResult {
    pub success: bool,
    /// 关系词（2-8 字中文，如「包含」「因果关系」）
    pub label: Option<String>,
    /// 关系的简短解释（一句话，渲染在连线气泡上）
    pub explanation: Option<String>,
    pub error: Option<String>,
}

/**
 * 解析模型返回的关系 JSON：{"relation": "词", "explanation": "一句话解释"}。
 * 三层容错：剥围栏 → 截 {..} → 字段提取；整体失败时把原文当关系词（兼容旧格式）。
 */
fn parse_relation_json(raw: &str) -> (Option<String>, Option<String>) {
    let mut s = raw.trim();
    if let Some(st) = s.find("```") {
        let inner = &s[st..];
        let inner = inner.trim_start_matches("```").trim_start_matches("json");
        let end = inner.find("```").unwrap_or(inner.len());
        s = inner[..end].trim();
    }
    if let (Some(a), Some(b)) = (s.find('{'), s.rfind('}')) {
        if b > a {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s[a..=b]) {
                let rel = v["relation"]
                    .as_str()
                    .map(|x| x.trim().trim_matches('"').to_string())
                    .filter(|x| !x.is_empty());
                let exp = v["explanation"]
                    .as_str()
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty());
                if let Some(r) = rel {
                    return (Some(r), exp);
                }
            }
        }
    }
    // 兼容：模型没给 JSON → 整体当关系词
    let plain = raw.trim().trim_matches('"').trim_matches('。').trim().to_string();
    (if plain.is_empty() { None } else { Some(plain) }, None)
}

/// Tauri Command：分析两个概念间的关系（图谱工作区：点击两节点气泡触发）。
/// 走 OpenAI 兼容协议（默认 Provider），webview 直连会有 CORS 限制，
/// 统一由 Rust 代理。
#[tauri::command]
async fn analyze_concepts_relationship(
    payload: GenerateRelationPayload,
) -> Result<GenerateRelationResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let system = "你是知识图谱构建助手。给定两个概念，输出它们之间的关系。\
严格输出 JSON 格式：{\"relation\": \"关系词\", \"explanation\": \"一句话解释\"}。\
relation 是 2-8 个字的中文动词或短语（如「包含」「因果关系」「相互对立」）；\
explanation 是约 30 字的关系简释，解释这两个概念为什么存在这种关系。\
禁止输出任何其他多余文本或 Markdown 代码块。";

    let mut user = format!("概念A：{}\n概念B：{}", payload.node_a, payload.node_b);
    if let Some(ctx) = payload.context.as_deref() {
        if !ctx.trim().is_empty() {
            user.push_str(&format!("\n原文语境：{}", ctx.trim()));
        }
    }

    let url = openai_chat_url(&payload.base_url);
    let body = serde_json::json!({
        "model": payload.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "temperature": 0.2,
        "max_tokens": 120,
        "stream": false
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", payload.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;

    if !resp.status().is_success() {
        let detail = llm_error_detail(resp).await;
        eprintln!("[relation] LLM 调用失败: {detail}");
        return Ok(GenerateRelationResult {
            success: false,
            label: None,
            explanation: None,
            error: Some(format!("LLM 调用失败: {detail}")),
        });
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;

    let content = data["choices"][0]["message"]["content"].as_str().unwrap_or("");
    let (label, explanation) = parse_relation_json(content);

    Ok(match label {
        Some(l) => GenerateRelationResult {
            success: true,
            label: Some(l),
            explanation,
            error: None,
        },
        None => GenerateRelationResult {
            success: false,
            label: None,
            explanation: None,
            error: Some("模型未返回有效的关系词".to_string()),
        },
    })
}

// ---------------------------------------------------------------------------
// 一键生成逻辑链 command（收集区词汇 → LLM 排链 → 节点+带关系词的边）
// ---------------------------------------------------------------------------

/// generate_logic_chain 请求负载
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateLogicChainPayload {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// 收集区待排链的概念词
    pub words: Vec<String>,
}

/// 逻辑链节点
#[derive(Debug, Serialize)]
pub struct LogicChainNode {
    pub id: String,
    pub label: String,
}

/// 逻辑链边（带关系词）
#[derive(Debug, Serialize)]
pub struct LogicChainEdge {
    pub source: String,
    pub target: String,
    pub label: Option<String>,
}

/// generate_logic_chain 返回
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateLogicChainResult {
    pub success: bool,
    pub nodes: Vec<LogicChainNode>,
    pub edges: Vec<LogicChainEdge>,
    /// 模型对整条链路逻辑的一句话总结（前端「AI 逻辑梳理总结」面板展示）
    pub summary: Option<String>,
    pub error: Option<String>,
}

/// 剥围栏 + 截取 JSON 片段 + 严格结构反序列化；返回 (nodes, edges, summary)
fn parse_chain_json(
    raw: &str,
) -> Result<(Vec<LogicChainNode>, Vec<LogicChainEdge>, Option<String>), String> {
    let mut s = raw.trim();
    if let Some(start) = s.find("```") {
        // 有围栏：取围栏内第一段
        let inner = &s[start..];
        let inner = inner.trim_start_matches("```").trim_start_matches("json");
        let end = inner.find("```").unwrap_or(inner.len());
        s = inner[..end].trim();
    }
    let start = s.find('{').ok_or("BAD_JSON")?;
    let end = s.rfind('}').ok_or("BAD_JSON")?;
    if end <= start {
        return Err("BAD_JSON".to_string());
    }

    #[derive(Debug, Deserialize)]
    struct RawNode {
        id: serde_json::Value,
        label: serde_json::Value,
    }
    #[derive(Debug, Deserialize)]
    struct RawEdge {
        source: serde_json::Value,
        target: serde_json::Value,
        #[serde(default)]
        label: Option<String>,
    }
    #[derive(Debug, Deserialize)]
    struct RawChain {
        nodes: Vec<RawNode>,
        #[serde(default)]
        edges: Vec<RawEdge>,
        #[serde(default)]
        summary: Option<String>,
    }

    let chain: RawChain =
        serde_json::from_str(&s[start..=end]).map_err(|_| "BAD_JSON".to_string())?;

    let nodes: Vec<LogicChainNode> = chain
        .nodes
        .into_iter()
        .map(|n| LogicChainNode {
            id: n.id.to_string().trim_matches('"').to_string(),
            label: n.label.as_str().unwrap_or("").trim().to_string(),
        })
        .filter(|n| !n.id.is_empty() && !n.label.is_empty())
        .collect();
    if nodes.is_empty() {
        return Err("BAD_JSON".to_string());
    }

    let valid: std::collections::HashSet<&str> =
        nodes.iter().map(|n| n.id.as_str()).collect();
    let edges: Vec<LogicChainEdge> = chain
        .edges
        .into_iter()
        .map(|e| LogicChainEdge {
            source: e.source.to_string().trim_matches('"').to_string(),
            target: e.target.to_string().trim_matches('"').to_string(),
            label: e
                .label
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty()),
        })
        .filter(|e| valid.contains(e.source.as_str()) && valid.contains(e.target.as_str()))
        .collect();

    let summary = chain
        .summary
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok((nodes, edges, summary))
}

/// Tauri Command：把收集区的词汇交给 LLM 排成一条逻辑链。
#[tauri::command]
async fn generate_logic_chain(
    payload: GenerateLogicChainPayload,
) -> Result<GenerateLogicChainResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let system = "你是知识图谱构建助手。给定一组概念词，请把它们按逻辑顺序排成一条链\
（按因果、递进、组成、前提等关系排序），相邻概念之间给出关系词。\
严格输出 JSON 格式：{\"nodes\": [{\"id\": \"1\", \"label\": \"概念A\"}], \
\"edges\": [{\"source\": \"1\", \"target\": \"2\", \"label\": \"包含\"}], \
\"summary\": \"一句话（30 字内）总结整条链的逻辑脉络\"}，\
必须使用全部输入词且只用一次，禁止输出任何其他多余文本或 Markdown 代码块。";

    let words: Vec<String> = payload
        .words
        .into_iter()
        .map(|w| w.trim().to_string())
        .filter(|w| !w.is_empty())
        .collect();
    if words.len() < 2 {
        return Ok(GenerateLogicChainResult {
            success: false,
            nodes: vec![],
            edges: vec![],
            summary: None,
            error: Some("至少需要 2 个概念词（暂存区可能没有数据）".to_string()),
        });
    }

    let body = serde_json::json!({
        "model": payload.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": format!("概念词列表：{}", words.join("、"))}
        ],
        "temperature": 0.2,
        "stream": false
    });

    let url = openai_chat_url(&payload.base_url);
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", payload.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;

    if !resp.status().is_success() {
        let detail = llm_error_detail(resp).await;
        eprintln!("[logic-chain] LLM 调用失败: {detail}");
        return Ok(GenerateLogicChainResult {
            success: false,
            nodes: vec![],
            edges: vec![],
            summary: None,
            error: Some(format!("LLM 调用失败: {detail}")),
        });
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");

    match parse_chain_json(content) {
        Ok((nodes, edges, summary)) => Ok(GenerateLogicChainResult {
            success: true,
            nodes,
            edges,
            summary,
            error: None,
        }),
        Err(_) => {
            eprintln!(
                "[logic-chain] 模型返回无法解析: {}",
                truncate(content, 300)
            );
            Ok(GenerateLogicChainResult {
                success: false,
                nodes: vec![],
                edges: vec![],
                summary: None,
                error: Some("模型未返回可解析的逻辑链 JSON".to_string()),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// 图谱工作区：本地磁盘持久化
// ---------------------------------------------------------------------------

/// 图谱存储目录（按登录身份隔离）：
/// - 已登录：`app_data_dir/users/{user_id}/graphs`（多账户数据互不可见）
/// - 未登录：`app_data_dir/graphs`（游客，向后兼容历史数据，不做自动迁移）
fn graph_storage_dir(app: &AppHandle, auth: &AuthState) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?;
    match current_user_id(auth) {
        Some(uid) => Ok(base.join("users").join(uid).join("graphs")),
        None => Ok(base.join("graphs")),
    }
}

/// 校验项目 id，防止路径穿越（虽然 id 由前端/后端生成，仍要挡一手）。
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.contains('\\') && !id.contains("..")
}

/// 保存（覆盖写）一个图谱项目。原子写：先写 .tmp 再 rename，避免崩溃留下半截文件。
/// 落盘目录随登录身份切换（见 `graph_storage_dir`）。
#[tauri::command]
fn save_graph_project(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
    project: GraphProject,
) -> Result<(), String> {
    let dir = graph_storage_dir(&app, &auth)?;
    write_json_atomic(&dir, &project.id, &project)
}

/// 原子写 JSON 到 `dir/<id>.json`（先写 .tmp 再 rename，崩溃不留半截文件）。
/// 图谱 / 白板共用：后端只负责「标识 + 原子落盘」，不解析业务字段。
fn write_json_atomic<T: Serialize>(dir: &Path, id: &str, value: &T) -> Result<(), String> {
    if !is_safe_id(id) {
        return Err("非法的 id".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;

    let json = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;

    let tmp = dir.join(format!("{id}.json.tmp"));
    let final_path = dir.join(format!("{id}.json"));
    std::fs::write(&tmp, json).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &final_path).map_err(|e| format!("替换文件失败: {e}"))?;

    Ok(())
}

/// `write_json_atomic` 的异步版本（`tokio::fs`），供 async command 使用，避免阻塞 Tokio 线程。
async fn write_json_atomic_async<T: Serialize>(
    dir: &Path,
    id: &str,
    value: &T,
) -> Result<(), String> {
    if !is_safe_id(id) {
        return Err("非法的 id".into());
    }
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| format!("创建目录失败: {e}"))?;

    let json = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;

    let tmp = dir.join(format!("{id}.json.tmp"));
    let final_path = dir.join(format!("{id}.json"));
    tokio::fs::write(&tmp, &json)
        .await
        .map_err(|e| format!("写入失败: {e}"))?;
    tokio::fs::rename(&tmp, &final_path)
        .await
        .map_err(|e| format!("替换文件失败: {e}"))?;

    Ok(())
}

/// 加载全部图谱项目，按 updatedAt 倒序；损坏文件跳过并打印告警。
/// 读取目录随登录身份切换：登录用户只见自己的图谱。
#[tauri::command]
fn load_graph_projects(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
) -> Result<Vec<GraphProject>, String> {
    let dir = graph_storage_dir(&app, &auth)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        // 只认 .json，跳过 .tmp 等中间文件
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<GraphProject>(&raw) {
                Ok(p) => projects.push(p),
                Err(e) => eprintln!("[graph] 跳过损坏文件 {}: {e}", path.display()),
            },
            Err(e) => eprintln!("[graph] 读取失败 {}: {e}", path.display()),
        }
    }

    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(projects)
}

// ---------------------------------------------------------------------------
// 白板（Whiteboard）：tldraw 快照持久化 + AI 批注/助读
//
// 设计要点：
// 1. `elements` 是 tldraw 的 JSON 快照，后端**不解析**（结构随 tldraw 版本变化），
//    只按 id 原子落盘 / 原样读回；前端升级 tldraw 无需改后端。
// 2. 目录与图谱同级、同样按登录身份隔离：users/{user_id}/whiteboards。
// 3. 批注结果既可随白板一起存（`annotations`），也可只留前端内存。
// ---------------------------------------------------------------------------

/// 白板画布类型（前端切换「无限 / A4 / 适应屏幕」）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WhiteboardCanvasType {
    /// 无限画布（默认）
    #[default]
    Infinite,
    /// A4 纸面（导出/打印）
    #[serde(rename = "a4")]
    A4,
    /// 适应屏幕
    Screen,
}

/// 白板 AI 批注结果（AI 面板直接渲染）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardAnnotation {
    /// 批注正文（150-300 字，可直接贴在白板上）
    pub annotation: String,
    /// 关键词/术语（2-4 个，可一键加入暂存区）
    #[serde(default)]
    pub keywords: Vec<String>,
    /// 建议追问（1-3 条，AI 面板的「继续追问」）
    #[serde(default)]
    pub follow_ups: Vec<String>,
}

/// 一块白板
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardProject {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub canvas_type: WhiteboardCanvasType,
    /// tldraw 的 JSON 快照：后端不解析，原样落盘 / 读回
    #[serde(default)]
    pub elements: serde_json::Value,
    /// 缩略图（data URL，可选；用于白板列表预览）
    #[serde(default)]
    pub thumbnail: Option<String>,
    /// 这块白板上产生过的 AI 批注（可选持久化）
    #[serde(default)]
    pub annotations: Vec<WhiteboardAnnotation>,
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

/// 白板存储目录（与图谱同级，按登录身份隔离）：
/// - 已登录：`app_data_dir/users/{user_id}/whiteboards`
/// - 未登录：`app_data_dir/whiteboards`（游客）
fn whiteboard_storage_dir(app: &AppHandle, auth: &AuthState) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?;
    match current_user_id(auth) {
        Some(uid) => Ok(base.join("users").join(uid).join("whiteboards")),
        None => Ok(base.join("whiteboards")),
    }
}

/// 保存（覆盖写）一块白板。原子写，目录随登录身份切换。
#[tauri::command]
fn save_whiteboard(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
    project: WhiteboardProject,
) -> Result<(), String> {
    let dir = whiteboard_storage_dir(&app, &auth)?;
    write_json_atomic(&dir, &project.id, &project)
}

/// 加载当前用户的全部白板，按 updatedAt 倒序；损坏文件跳过并告警。
#[tauri::command]
fn load_whiteboards(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
) -> Result<Vec<WhiteboardProject>, String> {
    let dir = whiteboard_storage_dir(&app, &auth)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut items = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        // 只认 .json，跳过 .tmp 等中间文件
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<WhiteboardProject>(&raw) {
                Ok(p) => items.push(p),
                Err(e) => eprintln!("[whiteboard] 跳过损坏文件 {}: {e}", path.display()),
            },
            Err(e) => eprintln!("[whiteboard] 读取失败 {}: {e}", path.display()),
        }
    }

    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

/// 从对象里按候选键名取字符串数组。
fn json_string_array(v: &serde_json::Value, keys: &[&str]) -> Vec<String> {
    for k in keys {
        if let Some(arr) = v.get(*k).and_then(|x| x.as_array()) {
            let out: Vec<String> = arr
                .iter()
                .filter_map(|i| i.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !out.is_empty() {
                return out;
            }
        }
    }
    Vec::new()
}

/// 解析批注结果：优先 JSON，失败则把整段文本当批注正文
///（免费模型常直接回纯文本，不能因此报错让面板空着）。
fn parse_whiteboard_annotation(
    text: &str,
    content: &str,
) -> Result<WhiteboardAnnotation, String> {
    if let Some(json_str) = extract_json_object(text) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json_str) {
            let annotation =
                json_text_field(&v, &["annotation", "comment", "text", "content"])
                    .unwrap_or_default();
            if !annotation.is_empty() {
                return Ok(WhiteboardAnnotation {
                    annotation,
                    keywords: json_string_array(&v, &["keywords", "tags"]),
                    follow_ups: json_string_array(
                        &v,
                        &["followUps", "follow_ups", "questions", "next"],
                    ),
                });
            }
        }
    }

    let plain = text.trim().trim_matches('"').trim();
    if plain.chars().count() < 20 {
        eprintln!(
            "[whiteboard] 批注返回过短，内容「{}」: {plain}",
            truncate(content, 40)
        );
        return Err(format!(
            "模型没有返回可用的批注（仅 {} 字），请重试",
            plain.chars().count()
        ));
    }
    Ok(WhiteboardAnnotation {
        annotation: plain.to_string(),
        keywords: Vec::new(),
        follow_ups: Vec::new(),
    })
}

/// Tauri Command：白板 AI 批注 / 助读。
/// 输入：白板上选中的文本或用户写的描述（content）+ 白板上下文（context）。
/// 输出：批注正文 + 关键词 + 建议追问，供前端 AI 面板展示。
#[tauri::command]
async fn ai_annotate_whiteboard(
    content: String,
    context: String,
    provider: LlmConfig,
) -> Result<WhiteboardAnnotation, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("批注内容为空：请先选中白板上的文本，或写下想追问的描述".into());
    }
    let content = truncate(content, 4_000);
    let ctx = truncate(context.trim(), 8_000);
    eprintln!(
        "[whiteboard] 批注请求: content={} 字, context={} 字, model={}",
        content.chars().count(),
        ctx.chars().count(),
        provider.model
    );

    let system = "你是白板助读助手。用户在无限白板上选中了一段文字或写下了一个问题，\
你要给出能直接贴在白板上的批注：解释这段话在讲什么、它与上下文的关键联系、以及一个值得继续追问的点。\
只输出一个 JSON 对象，不要 Markdown、不要前言，尽量精简：\
{\"annotation\":\"150-300 字的中文批注\",\"keywords\":[\"术语1\",\"术语2\"],\"followUps\":[\"追问1\"]}。\
annotation 必须具体到这段文字本身，不要写空泛套话；keywords 2-4 个；followUps 1-3 条。";

    let user = if ctx.is_empty() {
        format!("选中内容：\n{content}\n\n（白板暂无其他上下文）")
    } else {
        format!("选中内容：\n{content}\n\n白板上下文（其它便签/节点，供参考）：\n{ctx}")
    };

    let raw = call_llm_text(&provider, system, &user).await.map_err(|e| {
        eprintln!("[whiteboard] 批注失败: {e}");
        e
    })?;

    parse_whiteboard_annotation(&raw, &content)
}

// ---------------------------------------------------------------------------
// 图谱生成：划词词汇列表 → LLM → 图谱 → 落盘返回
// ---------------------------------------------------------------------------

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 项目 id 生成：纳秒级时间戳十六进制，单机单用户场景碰撞可忽略。
fn gen_project_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("g{:x}", d.as_nanos()))
        .unwrap_or_else(|_| "g0".to_string())
}

/// 从 LLM 返回的文本里抽出第一个 JSON 对象（兼容 ```json 围栏、前后缀废话）。
fn extract_json_object(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(text[start..=end].to_string())
}

/// 图谱规范化：节点 id 去重/兜底、丢弃自环与悬空边、边 id 兜底。
fn normalize_graph(
    nodes: Vec<ConceptNode>,
    edges: Vec<ConceptEdge>,
) -> (Vec<ConceptNode>, Vec<ConceptEdge>) {
    use std::collections::HashSet;

    let mut seen: HashSet<String> = HashSet::new();
    let mut counter: usize = 0;
    let mut cleaned_nodes: Vec<ConceptNode> = Vec::with_capacity(nodes.len());

    for mut n in nodes {
        if n.id.trim().is_empty() || seen.contains(&n.id) {
            loop {
                let candidate = format!("n{}", counter);
                counter += 1;
                if !seen.contains(&candidate) {
                    n.id = candidate;
                    break;
                }
            }
        }
        seen.insert(n.id.clone());
        cleaned_nodes.push(n);
    }

    let valid_ids: HashSet<String> = cleaned_nodes.iter().map(|n| n.id.clone()).collect();

    let mut cleaned_edges: Vec<ConceptEdge> = Vec::with_capacity(edges.len());
    for mut e in edges {
        if e.source == e.target {
            continue; // 自环
        }
        if !valid_ids.contains(&e.source) || !valid_ids.contains(&e.target) {
            continue; // 悬空端点
        }
        if e.id.trim().is_empty() {
            e.id = format!("e{}-{}", e.source, e.target);
        }
        cleaned_edges.push(e);
    }

    (cleaned_nodes, cleaned_edges)
}

/// 图谱兜底：模型只给了节点、没给连线时，按节点顺序串成一条链。
///
/// 为什么不再直接报错：`edges` 为空在弱模型 / 长上下文下很常见，
/// 直接 Err 会让用户「整张图都拿不到」（历史故障之一）。这里退化为
/// 「按 level/顺序串联」的最小可用图，并在 summary 末尾标注原因。
/// 返回 true = 发生过兜底。
fn ensure_edges(nodes: &[ConceptNode], edges: &mut Vec<ConceptEdge>) -> bool {
    if !edges.is_empty() || nodes.len() < 2 {
        return false;
    }
    for pair in nodes.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        edges.push(ConceptEdge {
            id: format!("auto-{}-{}", a.id, b.id),
            source: a.id.clone(),
            target: b.id.clone(),
            label: Some("递进".to_string()),
        });
    }
    true
}

/// 逻辑连接词的封闭候选集。
/// 强制模型从这批词里选，而不是自由发挥出「相关」「有关」这类零信息 label——
/// 这是「逻辑辅助节点必须落在 edges.label 上」的落地手段。
const LOGIC_LINKERS: &str =
    "导致 / 前提 / 因此 / 从而 / 反之 / 例如 / 属于 / 推导出 / 依赖 / 对比 / 递进 / 转折 / 并列 / 互斥";

/// summary 字数下限由 Granularity 决定（low 120 / medium 200 / high 450），
/// 不再用全局常量——「总结太短」的根因之一就是阈值写死且只判下限。
/// 单概念解析的目标字数区间（点击节点弹出的小解析）保持独立：
const CONCEPT_MIN_CHARS: usize = 120;
const CONCEPT_MAX_CHARS: usize = 220;

/// 上下文送入 LLM 的默认字符预算（长窗口模型可由前端传 maxContextChars 调大）
const DEFAULT_MAX_CONTEXT_CHARS: usize = 48_000;
/// 硬上限，防止误传 10万+ 直接把免费额度打光 / 触发 400
const MAX_CONTEXT_CHARS: usize = 200_000;
/// 单个片段上限：防止某一条整页 HTML 独占全部预算
const PER_PIECE_MAX_CHARS: usize = 12_000;

/// 按模板类型 + 粒度生成 system prompt。
///
/// 三条硬约束（缺一不可，删任何一条图就会退化成名词云）：
/// 1. nodes 只放真实概念，「导致/前提」这类词禁止成为节点；
/// 2. 逻辑辅助节点必须落在 edges.label，每条边必须有 label；
/// 3. summary 落在粒度区间 [MIN_SUMMARY, MAX_SUMMARY] 内，
///    且必须像讲课一样讲因果，不许罗列词汇。
fn build_system_prompt(template_type: &GraphTemplateType, granularity: Granularity) -> String {
    let (min_chars, max_chars) = granularity.summary_bounds();
    let base = "你是知识图谱构建器，同时是一名会把逻辑讲透的老师。输入是一组划词概念和抓取到的上下文\
（可能是整页网页或一整段 AI 对话），你要把它们压缩成一张能推演的有向图，而不是把名词罗列成一堆孤立节点。硬性规则：\
【nodes】提炼 5-10 个核心概念，每项含 id（n0,n1,...）、label（概念名，≤12 字）、\
description（20-40 字释义，必须依据上下文，不得编造）、level（1=核心 2=次要 3=细节）；\
只放真实概念——禁止把「导致」「前提」「因此」这类关系词写成节点，那样图会立刻失去信息量。\
【edges】必须把「逻辑辅助节点」以连线形式呈现，让图谱成为流程而不是散点：每条边都要有 label，\
label 从【逻辑连接词】中选最贴切的一个（2-6 字），不得留空、不得用「相关」「有关」凑数；\
至少 4 条边；不得自环；每个 node 至少接入一条边，禁止孤立节点；\
方向必须表达真实推理方向：因果写「导致」，先后写「前提／从而」，对立写「反之／互斥」，包含写「属于」。\
【summary】输出的 summary 必须在【MIN_SUMMARY】到【MAX_SUMMARY】字之间，\
详细阐述核心概念之间的因果、递进或对立逻辑。不要只罗列词汇，要像老师在讲课一样梳理：\
先交代起点概念是什么、它在解决什么问题，再按推理顺序讲清每一步为什么能推下去\
（指明「因为…所以…」「先…再…」「与之相反…」），最后给出结论以及这个结论的适用边界；分 2-3 段，允许换行。\
低于【MIN_SUMMARY】字或超过【MAX_SUMMARY】字都视为不合格输出。\
【格式】请直接输出 JSON，不要包含任何解释性文字或 Markdown 代码块，禁止注释，尽量精简，格式：\
{\"nodes\":[{\"id\":\"n0\",\"label\":\"概念名\",\"description\":\"20-40 字释义\",\"level\":1}],\
\"edges\":[{\"id\":\"e0\",\"source\":\"n0\",\"target\":\"n1\",\"label\":\"导致\"}],\
\"summary\":\"【MIN_SUMMARY】-【MAX_SUMMARY】字的讲课式中文总结\"}。\
id 用 n0,n1,... 与 e0,e1,...；edges 的 source/target 必须引用已存在的 node id。";

    let rule = match template_type {
        GraphTemplateType::Chain => {
            "这是逻辑链模板：edges 必须形成一条或数条有向链，label 优先用\"导致\"\"前提\"\"因此\"\"推导出\"\"递进\"，\
让读者能顺着箭头读完整个推理过程。"
        }
        GraphTemplateType::Venn => {
            "这是维恩模板：edges 表达集合关系，label 优先用\"包含\"\"相交\"\"并列\"\"互斥\"\"属于\"，\
明确区分概念间的包含、交集与对立。"
        }
        GraphTemplateType::Free => {
            "这是自由模板：识别概念间最关键的逻辑关系即可，label 仍必须从逻辑连接词中选，\
关系类型不限但每条边都要有信息量。"
        }
    };

    let base = base
        .replace("【逻辑连接词】", LOGIC_LINKERS)
        .replace("【MIN_SUMMARY】", &min_chars.to_string())
        .replace("【MAX_SUMMARY】", &max_chars.to_string());
    format!("{base} {rule}")
}

/// 拼 user prompt：概念词 + 上下文（按预算分片截断）。
/// 预算由 `GenerateGraphPayload.max_context_chars` 控制，缺省 48000 字，
/// 长窗口模型（DeepSeek-V4-Flash / Gemini 2.x Flash）可放开到 10 万以上。
fn build_user_prompt(payload: &GenerateGraphPayload) -> String {
    let mut s = String::new();

    if payload.concepts.is_empty() {
        s.push_str("本次没有人工划词，概念请完全从下面的上下文里提炼。\n");
    } else {
        s.push_str(&format!(
            "划词概念（必须全部出现在 nodes 中，并可从上下文补充关键概念）：{}\n",
            payload.concepts.join("、")
        ));
    }

    if payload.contexts.is_empty() {
        s.push_str("（无上下文，请仅依据概念词之间公认的学术关系构图，不要编造事实。）\n");
    } else {
        let budget = payload
            .max_context_chars
            .unwrap_or(DEFAULT_MAX_CONTEXT_CHARS)
            .clamp(4_000, MAX_CONTEXT_CHARS);
        s.push_str(&format!(
            "以下是抓取到的网页/对话上下文（预算约 {budget} 字），请基于它深度提炼概念与逻辑关系：\n"
        ));

        let mut used = 0usize;
        let mut truncated = false;
        for (i, piece) in payload.contexts.iter().enumerate() {
            if used >= budget {
                truncated = true;
                break;
            }
            let cap = PER_PIECE_MAX_CHARS.min(budget - used);
            let text = truncate(piece, cap);
            if text.chars().count() < piece.trim().chars().count() {
                truncated = true;
            }
            used += text.chars().count();
            s.push_str(&format!("[片段{}] {}\n", i + 1, text));
        }
        if truncated {
            s.push_str("…（上下文超出预算，后文已截断）\n");
        }
    }

    s.push_str(&format!(
        "现在输出 JSON：nodes 提炼 5-10 个核心概念；edges 至少 4 条，每条 label 必须是逻辑连接词，\
把概念串成流程而不是散点；summary 必须在 {min_chars}-{max_chars} 字之间（当前粒度：{label}），\
按「起点 → 逐步推进 → 结论与边界」的顺序讲清因果、递进与对立，不要罗列词汇。\
只输出 JSON 本身，不要任何解释。",
        min_chars = payload.granularity.unwrap_or_default().summary_bounds().0,
        max_chars = payload.granularity.unwrap_or_default().summary_bounds().1,
        label = payload.granularity.unwrap_or_default().label(),
    ));
    s
}

// ---------------------------------------------------------------------------
// 极速模式：LLM 请求统一参数与超时
// ---------------------------------------------------------------------------

/// 降低随机性 → 出词更稳更快（替换旧的 0.0/0.2）
const LLM_TEMPERATURE: f32 = 0.1;
/// 限制最大输出 token，防止模型「啰嗦」把时间花在无意义的冗长上。
/// 4096 而非 1500：整张图谱的 JSON（8-12 节点 + 6-10 边 + 300-800 字 summary）
/// 稳定在 1200-2500 token 区间，1500 会频繁触发 finish_reason=length 被截断，
/// 表现为「模型生成分析直接失败」。
const LLM_MAX_TOKENS: u32 = 4096;
/// 常规 LLM 请求绝对超时（秒）：短请求（单概念解析、关系推导）走这个
const LLM_TIMEOUT_SECS: u64 = 60;
/// 长上下文生成（全文分析 / 图谱生成）的绝对超时（秒）。
/// 3-5 万字上下文 + 4096 输出在低价模型上常需 60-100s，用 60s 会误杀正常请求；
/// 仍设硬上限，避免真正挂死时前端无限等待。
const LLM_TIMEOUT_LONG_SECS: u64 = 120;

/// AI 追问 / 图谱质量测评（`ask_llm`）专用参数：
/// temperature 0.3 允许适度展开；max_tokens 4096 满足前端契约下限；超时 120s。
const LLM_ASK_TEMPERATURE: f32 = 0.3;
const LLM_ASK_MAX_TOKENS: u32 = 4096;
const LLM_ASK_TIMEOUT_SECS: u64 = 120;

/// 单次 LLM 请求的采样参数：三种协议分支共用同一份，避免参数漂移。
/// 只决定请求体里的 temperature / max_tokens 字段，不改变「一个 HTTP 入口」的结构。
#[derive(Clone, Copy)]
struct LlmSampling {
    temperature: f32,
    max_tokens: u32,
}

impl Default for LlmSampling {
    fn default() -> Self {
        Self {
            temperature: LLM_TEMPERATURE,
            max_tokens: LLM_MAX_TOKENS,
        }
    }
}

/// 全局复用的 `reqwest::Client`：连接池复用，避免每次调用重建、重复 TCP 握手。
/// 各请求的超时由 `tokio::time::timeout` 单独控制，故 client 不设全局 timeout。
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder().build().unwrap_or_else(|e| {
            // 极端情况下（TLS 后端初始化失败）回退默认客户端，绝不 panic：
            // 单次 LLM 请求失败可以重试，进程崩掉不行。
            eprintln!("[http] 构建共享 Client 失败，回退默认客户端: {e}");
            reqwest::Client::new()
        })
    })
}

/// 请求 id：`gs` + 纳秒十六进制，用于把流式事件与最终结果关联起来。
fn gen_request_id() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("gs{:x}", d.as_nanos()))
        .unwrap_or_else(|_| "gs0".to_string())
}

/// 通用 LLM 文本调用：返回模型生成的文本内容。
/// 失败时把上游 HTTP 状态 + 响应正文透传，便于前端定位 400 根因。
///
/// 绝对超时 60s：长上下文在免费/低价模型上单次生成常需 40-90s，
/// 但超过 60s 说明模型/网络出问题或输出失控，与其让前端死等不如显式中止并给出可重试的报错。
async fn call_llm_text(provider: &LlmConfig, system: &str, user: &str) -> Result<String, String> {
    call_llm_text_with_timeout(provider, system, user, LLM_TIMEOUT_SECS).await
}

/// 带自定义超时的 LLM 调用：长上下文生成（全文分析/图谱生成）用 `LLM_TIMEOUT_LONG_SECS`，
/// 避免把「其实能成」的长任务按短请求的超时误杀。
async fn call_llm_text_with_timeout(
    provider: &LlmConfig,
    system: &str,
    user: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    call_llm_text_with_options(provider, system, user, timeout_secs, LlmSampling::default()).await
}

/// 同一 HTTP 入口的可配置版本：仅超时与采样参数不同，供 `ask_llm` 使用。
/// 三种协议分支仍全部落在 `call_llm_text_inner`，不新增任何请求逻辑。
async fn call_llm_text_with_options(
    provider: &LlmConfig,
    system: &str,
    user: &str,
    timeout_secs: u64,
    sampling: LlmSampling,
) -> Result<String, String> {
    tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        call_llm_text_inner(provider, system, user, sampling),
    )
    .await
    .map_err(|_| {
        format!(
            "LLM 请求超过 {timeout_secs}s 已中止：请稍后重试，或在模型设置里换用更快的模型（如 DeepSeek-V4-Flash）"
        )
    })?
}

/// `call_llm_text` 的实际请求体（三协议分支），被 `tokio::time::timeout` 包裹。
/// `sampling` 只替换请求体里的采样字段，URL 拼接、鉴权、响应解析保持原样。
async fn call_llm_text_inner(
    provider: &LlmConfig,
    system: &str,
    user: &str,
    sampling: LlmSampling,
) -> Result<String, String> {
    let client = http_client();

    match provider.kind.as_str() {
        "openai-compatible" => {
            let url = openai_chat_url(&provider.base_url);
            // 采样参数由调用方给出：常规命令走默认档，ask_llm 走追问档（见 LlmSampling）。
            let body = serde_json::json!({
                "model": provider.model,
                "temperature": sampling.temperature,
                "max_tokens": sampling.max_tokens,
                "stream": false,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user}
                ]
            });
            eprintln!("[graph] 调用 LLM: url={url} model={}", provider.model);

            let resp = client
                .post(&url)
                .bearer_auth(&provider.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("网络请求失败: {e}"))?;
            if !resp.status().is_success() {
                let detail = llm_error_detail(resp).await;
                eprintln!("[graph] LLM 调用失败: {detail}");
                return Err(format!("LLM 调用失败: {detail}"));
            }
            let json: serde_json::Value =
                resp.json().await.map_err(|e| format!("解析响应失败: {e}"))?;

            // 截断单独识别：报「输出被截断」比报「JSON 解析失败」有用得多
            let choice = &json["choices"][0];
            if choice["finish_reason"].as_str() == Some("length") {
                return Err(
                    "模型输出达到 max_tokens 上限被截断（finish_reason=length）：\
请缩短上下文、降低总结粒度，或换用输出上限更大的模型后重试"
                        .to_string(),
                );
            }

            let content = choice["message"]["content"]
                .as_str()
                .or_else(|| choice["message"]["reasoning_content"].as_str())
                .ok_or("响应缺少 choices[0].message.content")?;
            Ok(content.to_string())
        }
        "anthropic" => {
            let url = format!("{}/v1/messages", provider.base_url.trim_end_matches('/'));
            let body = serde_json::json!({
                "model": provider.model,
                "max_tokens": sampling.max_tokens,
                "temperature": sampling.temperature,
                "system": system,
                "messages": [{"role": "user", "content": user}]
            });
            eprintln!("[graph] 调用 LLM (anthropic): url={url} model={}", provider.model);

            let resp = client
                .post(&url)
                .header("x-api-key", &provider.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("网络请求失败: {e}"))?;
            if !resp.status().is_success() {
                let detail = llm_error_detail(resp).await;
                eprintln!("[graph] LLM 调用失败: {detail}");
                return Err(format!("LLM 调用失败: {detail}"));
            }
            let json: serde_json::Value =
                resp.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
            let content = json["content"][0]["text"]
                .as_str()
                .ok_or("响应缺少 content[0].text")?;
            Ok(content.to_string())
        }
        "ollama" => {
            let url = format!("{}/api/chat", provider.base_url.trim_end_matches('/'));
            let body = serde_json::json!({
                "model": provider.model,
                "stream": false,
                "options": {
                    "temperature": sampling.temperature,
                    "num_predict": sampling.max_tokens
                },
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user}
                ]
            });
            eprintln!("[graph] 调用 LLM (ollama): url={url} model={}", provider.model);

            let resp = client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("网络请求失败: {e}"))?;
            if !resp.status().is_success() {
                let detail = llm_error_detail(resp).await;
                eprintln!("[graph] LLM 调用失败: {detail}");
                return Err(format!("LLM 调用失败: {detail}"));
            }
            let json: serde_json::Value =
                resp.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
            let content = json["message"]["content"]
                .as_str()
                .ok_or("响应缺少 message.content")?;
            Ok(content.to_string())
        }
        other => Err(format!("不支持的供应商类型: {}", other)),
    }
}

// ---------------------------------------------------------------------------
// AI 追问（前端 `bridge.askLlm` / 图谱质量测评）
// ---------------------------------------------------------------------------

/// 单次自由问答：不做图谱结构解析，直接把模型正文回传给前端。
/// 契约：temperature 0.3、max_tokens 4096（满足 ≥4096）、超时 120s；
/// 三种协议仍走 `call_llm_text_inner`，不新增 HTTP 请求逻辑。
#[tauri::command]
async fn ask_llm(
    question: String,
    context: Option<String>,
    provider: LlmConfig,
) -> Result<String, String> {
    let q = question.trim();
    if q.is_empty() {
        return Err("请输入要追问的问题".into());
    }
    if provider.base_url.trim().is_empty() || provider.model.trim().is_empty() {
        return Err("请先在模型设置里填写服务地址与模型名称".into());
    }

    let system = "你是 TermAsk 工作台的知识整理助手。请依据给定上下文，用简体中文回答用户的问题：\
先给结论，再分点说明依据；上下文不足以支持结论时明确说明「上下文未提供」，不要编造事实。\
只返回回答正文，不要输出 JSON、Markdown 标题或思考过程。";

    let user = match context.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(ctx) => format!("【上下文】\n{ctx}\n\n【问题】\n{q}"),
        None => format!("【上下文】\n（无）\n\n【问题】\n{q}"),
    };

    let sampling = LlmSampling {
        temperature: LLM_ASK_TEMPERATURE,
        max_tokens: LLM_ASK_MAX_TOKENS,
    };
    let answer = call_llm_text_with_options(
        &provider,
        system,
        &user,
        LLM_ASK_TIMEOUT_SECS,
        sampling,
    )
    .await
    .map_err(|e| format!("AI 回答失败：{e}"))?;

    let text = answer.trim().to_string();
    if text.is_empty() {
        return Err("模型没有返回内容，请重试或换用其它模型".into());
    }
    Ok(text)
}

// ---------------------------------------------------------------------------
// LLM 图谱响应的宽容解析
//
// 为什么不用固定 struct 反序列化：DeepSeek 好用，但免费 Gemini / 各类兼容网关
// 经常返回 name 而不是 label、from/to 而不是 source/target、数字 id，
// 一个字段名不匹配就整张图报废。这里按候选字段名逐个兜底。
// ---------------------------------------------------------------------------

/// 按候选键名取字符串字段（取到第一个非空值）。
fn json_text_field(v: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            let t = s.trim().trim_matches('"').trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// 按候选键名取 id 字段，允许字符串或数字。
fn json_id_field(v: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        match v.get(*k) {
            Some(serde_json::Value::String(s)) => {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
            Some(serde_json::Value::Number(n)) => return Some(n.to_string()),
            _ => {}
        }
    }
    None
}

/// 解析 LLM 返回的图谱 JSON 文本，返回 (nodes, edges, summary)。
fn parse_generated_graph(
    text: &str,
) -> Result<(Vec<ConceptNode>, Vec<ConceptEdge>, String), String> {
    let json_str = extract_json_object(text)
        .ok_or_else(|| "LLM 未返回有效 JSON（返回原文已记录到后端日志）".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| format!("解析图谱 JSON 失败: {e}"))?;
    Ok(parse_graph_from_value(&v))
}

/// 从已解析的 JSON 对象里取 nodes / edges / summary。
/// 全文分析接口要在同一份 JSON 里额外取 outline，所以把「取值」与「JSON 语法解析」拆开复用。
fn parse_graph_from_value(v: &serde_json::Value) -> (Vec<ConceptNode>, Vec<ConceptEdge>, String) {
    let raw_nodes = v
        .get("nodes")
        .or_else(|| v.get("concepts"))
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();

    let mut nodes: Vec<ConceptNode> = Vec::with_capacity(raw_nodes.len());
    // label → id：模型常把 edge 的 source 写成概念名而不是 id，需要回映射
    let mut label_to_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for (i, n) in raw_nodes.iter().enumerate() {
        let Some(label) = json_text_field(n, &["label", "name", "term", "title"]) else {
            continue; // 没名字的节点无意义
        };
        let id = json_id_field(n, &["id", "key"]).unwrap_or_else(|| format!("n{i}"));
        let description =
            json_text_field(n, &["description", "desc", "explanation", "definition"]);
        let level = n
            .get("level")
            .and_then(|x| x.as_u64())
            .map(|x| x.clamp(1, 4) as u8);

        label_to_id.insert(label.clone(), id.clone());
        nodes.push(ConceptNode {
            id,
            label,
            level,
            description,
            position: None,
        });
    }

    let raw_edges = v
        .get("edges")
        .or_else(|| v.get("links"))
        .or_else(|| v.get("relations"))
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();

    let mut edges: Vec<ConceptEdge> = Vec::with_capacity(raw_edges.len());
    for (i, e) in raw_edges.iter().enumerate() {
        let Some(source) = json_id_field(e, &["source", "from", "start"]) else {
            continue;
        };
        let Some(target) = json_id_field(e, &["target", "to", "end"]) else {
            continue;
        };
        let source = label_to_id.get(&source).cloned().unwrap_or(source);
        let target = label_to_id.get(&target).cloned().unwrap_or(target);
        let label = json_text_field(e, &["label", "relation", "type", "name", "predicate"]);
        let id = json_id_field(e, &["id", "key"]).unwrap_or_else(|| format!("e{i}"));

        edges.push(ConceptEdge {
            id,
            source,
            target,
            label,
        });
    }

    let summary =
        json_text_field(v, &["summary", "conclusion", "overview", "text"]).unwrap_or_default();

    (nodes, edges, summary)
}

/// 按 id 取节点名（取不到就回显 id，便于排查脏数据）。
fn node_label<'a>(nodes: &'a [ConceptNode], id: &'a str) -> &'a str {
    nodes
        .iter()
        .find(|n| n.id == id)
        .map(|n| n.label.as_str())
        .unwrap_or(id)
}

/// 把图谱压成纯文本清单，供 summary 二次扩写时喂给模型。
fn graph_digest(nodes: &[ConceptNode], edges: &[ConceptEdge]) -> String {
    let mut s = String::from("概念：\n");
    for n in nodes {
        s.push_str(&format!(
            "- {}：{}\n",
            n.label,
            n.description.as_deref().unwrap_or("（无释义）")
        ));
    }
    s.push_str("连线：\n");
    for e in edges {
        s.push_str(&format!(
            "- {} -[{}]-> {}\n",
            node_label(nodes, &e.source),
            e.label.as_deref().unwrap_or("关联"),
            node_label(nodes, &e.target)
        ));
    }
    truncate(&s, 4_000)
}

/// 兜底总结：LLM 两次都没给够字数时，用图结构本身拼一段。
/// 只复述已产出的节点/连线，不引入模型没说过的事实；
/// `min_chars` 由调用方给（一键生成 300、全文分析 500）。
fn compose_summary(nodes: &[ConceptNode], edges: &[ConceptEdge], min_chars: usize) -> String {
    let mut s = String::from("这张图谱把核心概念组织成一条可推演的链路：");
    for e in edges.iter().take(10) {
        s.push_str(&format!(
            "「{}」{}「{}」；",
            node_label(nodes, &e.source),
            e.label.as_deref().unwrap_or("关联"),
            node_label(nodes, &e.target)
        ));
    }
    s.push_str("沿箭头方向读，这条路从起点概念出发，经由上述逻辑环节逐步推进到结论：每一步的连线标签都是继续往前走所依赖的条件，跳过任何一环，后面的结论都不再成立。\n\n");

    s.push_str("逐个看这些概念各自承担什么：");
    for n in nodes.iter().take(10) {
        if let Some(d) = n
            .description
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
        {
            s.push_str(&format!("「{}」指{}；", n.label, d));
        }
    }
    s.push_str("\n\n整体上，这些概念不是并列罗列，而是靠因果、前提、递进与对立彼此支撑：理解了每条连线为什么成立，也就掌握了整段材料想表达的论证结构。阅读时可以先确认起点概念的定义，再顺着连线逐段核对前提是否成立，最后回到结论，检查它有没有超出前提允许的范围。");

    if s.chars().count() < min_chars {
        let names: Vec<&str> = nodes.iter().map(|n| n.label.as_str()).collect();
        s.push_str(&format!(
            "\n\n补充说明：这份材料涉及的概念共 {} 个——{}。它们之间的连线依次为：",
            names.len(),
            names.join("、")
        ));
        for (i, e) in edges.iter().enumerate() {
            s.push_str(&format!(
                "{}.「{}」{}「{}」",
                i + 1,
                node_label(nodes, &e.source),
                e.label.as_deref().unwrap_or("关联"),
                node_label(nodes, &e.target)
            ));
            if i + 1 < edges.len() {
                s.push('；');
            }
        }
        s.push_str("。建议沿箭头逐段回读原文，核对每一步的前提是否成立。");
    }
    s
}

/// 全文分析第二步：基于「原文摘录 + 骨架 + 图谱」生成总结。
///
/// 与 `ensure_summary` 的区别：`ensure_summary` 只吃图谱摘要（适合一键生成的补写），
/// 这里额外带上原文（截断到 24000 字），保证总结仍能讲出原文的深层联系，
/// 而不是复述节点释义——分步返回不能以牺牲质量为代价。
async fn summarize_with_context(
    provider: &LlmConfig,
    sent_text: &str,
    outline: &[OutlineItem],
    nodes: &[ConceptNode],
    edges: &[ConceptEdge],
    min_chars: usize,
    max_chars: usize,
) -> String {
    let outline_text = outline
        .iter()
        .map(|o| format!("- {}：{}", o.heading, o.detail))
        .collect::<Vec<_>>()
        .join("\n");

    let system = "你是擅长讲课的中文老师。只输出一段纯文本讲解，不要 JSON、不要 Markdown、不要标题。";
    let user = format!(
        "以下是原文（可能已截断）：\n{}\n\n已提炼的骨架：\n{outline_text}\n\n已提炼的概念与连线：\n{}\n\n\
请写 {min_chars}-{max_chars} 字的讲解，像老师讲课一样按「起点概念 → 每一步怎么推下去 → 结论与适用边界」展开，\
必须点明因果（因为…所以…）、递进（先…再…）与对立（与之相反…）关系，不要罗列词汇。只输出讲解正文。",
        truncate(sent_text, 24_000),
        graph_digest(nodes, edges)
    );

    // 带 24000 字原文，属长上下文生成，用放宽后的超时
    match call_llm_text_with_timeout(provider, system, &user, LLM_TIMEOUT_LONG_SECS).await {
        Ok(t) => {
            let t = t.trim().trim_matches('"').trim().to_string();
            if t.chars().count() >= min_chars {
                t
            } else {
                eprintln!(
                    "[analyze] 总结仅 {} 字（要求 ≥{min_chars}），改用图结构兜底",
                    t.chars().count()
                );
                compose_summary(nodes, edges, min_chars)
            }
        }
        Err(e) => {
            eprintln!("[analyze] 总结生成失败，改用图结构兜底: {e}");
            compose_summary(nodes, edges, min_chars)
        }
    }
}

/// 保证 summary 落在 [min_chars, max_chars]：不足则让模型扩写一次，
/// 仍不足则按图结构兜底；超长不裁剪（宁可超不可短，前端面板可滚动）。
///
/// 为什么不直接信模型：低价/免费模型对字数的服从度很差，
/// 提示词写 300 字，实际常回 120 字的名词解释。
async fn ensure_summary(
    provider: &LlmConfig,
    nodes: &[ConceptNode],
    edges: &[ConceptEdge],
    summary: String,
    min_chars: usize,
    max_chars: usize,
) -> String {
    let mut out = summary.trim().to_string();

    if out.chars().count() < min_chars {
        eprintln!(
            "[graph] summary 仅 {} 字（要求 {min_chars}-{max_chars}），触发一次扩写",
            out.chars().count()
        );
        let system = "你是擅长讲课的中文老师。只输出一段纯文本讲解，不要 JSON、不要 Markdown、不要标题。";
        let user = format!(
            "下面是一张知识图谱的节点与连线清单：\n{}\n\n上一版总结只有 {} 字，不满足要求。\
请重写为 {min_chars}-{max_chars} 字的讲解，像老师讲课一样按「起点概念 → 每一步怎么推下去 → 结论与适用边界」\
展开，必须点明因果（因为…所以…）、递进（先…再…）与对立（与之相反…）关系，\
不要罗列词汇、不要复制节点释义。只输出讲解正文。\n\n上一版：{}",
            graph_digest(nodes, edges),
            out.chars().count(),
            truncate(&out, 1_200)
        );

        match call_llm_text(provider, system, &user).await {
            Ok(t) => {
                let t = t.trim().trim_matches('"').trim().to_string();
                if t.chars().count() > out.chars().count() {
                    out = t;
                }
            }
            Err(e) => eprintln!("[graph] summary 扩写失败，沿用原总结: {e}"),
        }
    }

    if out.chars().count() < min_chars {
        eprintln!(
            "[graph] summary 仍仅 {} 字（要求 >{min_chars}），改用图结构兜底生成",
            out.chars().count()
        );
        out = compose_summary(nodes, edges, min_chars);
    }

    out
}

/// Tauri Command：把划词词汇列表 + 上下文交给 LLM 生成图谱，落盘后返回完整项目。
///
/// 与旧版的差异：
/// 1. 允许「无划词、只有上下文」（整页 AI 对话一次性成图）；
/// 2. prompt 强制逻辑辅助节点落在 edges.label，不再允许它们变成节点污染图；
/// 3. summary 不足 200 字自动二次扩写，仍不足则按图结构兜底，前端永远有内容可展示；
/// 4. 解析走宽容模式，兼容免费/廉价模型的字段名漂移。
#[tauri::command]
async fn generate_graph_from_cache(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
    mut payload: GenerateGraphPayload,
) -> Result<GraphProject, String> {
    // 清洗空词条 / 空上下文
    payload.concepts = payload
        .concepts
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    payload.contexts = payload
        .contexts
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();

    let granularity = payload.granularity.unwrap_or_default();
    let context_chars: usize = payload.contexts.iter().map(|c| c.chars().count()).sum();
    eprintln!(
        "[graph] 生成开始: title={} template={:?} granularity={} concepts={} contexts={} context_chars={} kind={} model={}",
        payload.title,
        payload.template_type,
        granularity.label(),
        payload.concepts.len(),
        payload.contexts.len(),
        context_chars,
        payload.provider.kind,
        payload.provider.model
    );

    if payload.concepts.is_empty() && payload.contexts.is_empty() {
        eprintln!("[graph] 概念词与上下文均为空");
        return Err(
            "暂存区与上下文都是空的：请先通过浏览器扩展划词收集，或提供待分析的上下文文本".into(),
        );
    }

    // 流式事件：立即告知前端「已开始」，节点/总结随后分步推送，避免界面死等无反馈。
    let request_id = gen_request_id();
    let _ = app.emit(
        "graph-stream-start",
        serde_json::json!({ "requestId": request_id, "kind": "generate" }),
    );

    let system = build_system_prompt(&payload.template_type, granularity);
    let user = build_user_prompt(&payload);
    eprintln!(
        "[graph] user prompt {} 字，前 200 字: {}",
        user.chars().count(),
        truncate(&user, 200)
    );

    let text = call_llm_text_with_timeout(
        &payload.provider,
        &system,
        &user,
        LLM_TIMEOUT_LONG_SECS,
    )
    .await
    .map_err(|e| {
        eprintln!("[graph] LLM 调用失败: {e}");
        e
    })?;
    eprintln!(
        "[graph] LLM 返回原文（前 300 字）: {}",
        truncate(&text, 300)
    );

    let (raw_nodes, raw_edges, summary) = parse_generated_graph(&text).map_err(|e| {
        eprintln!(
            "[graph] 图谱解析失败: {e} | 原文前 500 字: {}",
            truncate(&text, 500)
        );
        e
    })?;

    let (nodes, mut edges) = normalize_graph(raw_nodes, raw_edges);
    if nodes.is_empty() {
        eprintln!("[graph] LLM 未返回任何节点");
        return Err(
            "LLM 未返回任何节点：可能是模型不支持稳定 JSON 输出，或上下文不足以提炼概念".into(),
        );
    }
    // 弱模型常只给节点不给连线：兜底串成链，而不是让用户整张图都拿不到
    let auto_chained = ensure_edges(&nodes, &mut edges);
    if auto_chained {
        eprintln!("[graph] LLM 未返回连线，已按节点顺序自动串联（{} 条）", edges.len());
    }

    // 先推节点：前端拿到就能立刻渲染画布，summary 随后到达
    let _ = app.emit(
        "graph-stream-nodes",
        serde_json::json!({
            "requestId": request_id,
            "nodes": nodes,
            "edges": edges
        }),
    );

    let (min_chars, max_chars) = granularity.summary_bounds();
    let mut summary = ensure_summary(
        &payload.provider,
        &nodes,
        &edges,
        summary,
        min_chars,
        max_chars,
    )
    .await;
    if auto_chained {
        summary.push_str("\n\n（说明：模型未给出概念连线，已按节点顺序自动串联，可手动调整。）");
    }

    // 总结随后推送
    let _ = app.emit(
        "graph-stream-summary",
        serde_json::json!({ "requestId": request_id, "summary": summary }),
    );

    eprintln!(
        "[graph] 生成完成: nodes={} edges={} summary={} 字",
        nodes.len(),
        edges.len(),
        summary.chars().count()
    );

    let now = now_millis();
    let project = GraphProject {
        id: gen_project_id(),
        title: payload.title,
        template_type: payload.template_type,
        nodes,
        edges,
        summary,
        created_at: now,
        updated_at: now,
    };

    // 落盘（随登录身份进入 users/{user_id}/graphs 或游客 graphs；tokio::fs 不阻塞 Tokio 线程）
    let dir = graph_storage_dir(&app, &auth)?;
    write_json_atomic_async(&dir, &project.id, &project).await?;

    Ok(project)
}

// ---------------------------------------------------------------------------
// 全文深度分析 / 单节点深度解析
//
// 两个接口都要求前端传 provider：API Key 目前仍存在前端 localStorage，
// 后端不持有任何凭证，无法自行决定用哪个模型。
// ---------------------------------------------------------------------------

/// 全文骨架中的一条
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    /// 小标题（≤16 字）
    pub heading: String,
    /// 这一段在论证什么（30-60 字）
    pub detail: String,
}

/// `analyze_full_context` 出参：骨架 + 图谱 + 详细总结
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullContextAnalysis {
    /// 全文主题（模型提炼；取不到时退化为正文前 20 字）
    pub title: String,
    /// 一句话主旨
    pub thesis: String,
    /// 骨架：按原文推进顺序排列
    pub outline: Vec<OutlineItem>,
    pub nodes: Vec<ConceptNode>,
    pub edges: Vec<ConceptEdge>,
    /// 详细总结（字数由 granularity 决定：low 120-200 / medium 200-400 / high 450-800，讲课式）
    pub summary: String,
    /// 实际送入模型的字符数（含截断后的长度，供 UI 提示「只分析了前段」）
    pub context_chars: usize,
    /// 本次使用的模型 id（回显，便于排查是哪次调用出的问题）
    pub model: String,
}

/// `analyze_single_concept` 出参：针对当前上下文的小解析
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptAnalysis {
    pub concept: String,
    /// 该词在当前上下文中的具体含义（约 150 字）
    pub analysis: String,
    /// 它在文中承担的角色，一句话
    pub role: Option<String>,
    /// 与上下文中其他概念的关系，2-3 条
    pub relations: Vec<String>,
}

/// 全文分析第一步「结构」system prompt：只产出骨架 + 图谱，不写总结。
/// 让前端先拿到节点快速渲染，总结由第二步 `ensure_summary` 生成并事件推送。
fn build_analysis_structure_prompt() -> String {
    let base = "你是知识结构分析专家，输入是一整段完整材料（可能是一整章教材、一篇长文、或一整段 AI 对话）。\
只提炼结构与图谱，不要写总结：\
【outline 骨架】3-8 条，按原文论述的真实顺序排列（不要按重要性重排），每条含 \
heading（≤16 字的小标题）与 detail（30-60 字，说明这一段到底在论证什么、用什么支撑）；\
【nodes/edges 图谱】提炼 6-12 个核心概念作为 nodes（id/label/description/level）；\
概念之间的逻辑辅助节点必须以连线形式呈现：每条边都要有 label，label 从【逻辑连接词】中选，\
禁止留空、禁止把「导致」「前提」写成节点、禁止孤立节点、禁止自环；至少 6 条边，方向表示真实推理方向。\
【格式】请直接输出 JSON，不要包含任何解释性文字或 Markdown 代码块，尽量精简：\
{\"title\":\"全文主题\",\"thesis\":\"一句话主旨（≤40 字）\",\
\"outline\":[{\"heading\":\"小标题\",\"detail\":\"这一段在论证什么\"}],\
\"nodes\":[…],\"edges\":[…]}。\
nodes 每项形如 {\"id\":\"n0\",\"label\":\"概念\",\"description\":\"释义\",\"level\":1}；\
edges 每项形如 {\"id\":\"e0\",\"source\":\"n0\",\"target\":\"n1\",\"label\":\"导致\"}。";

    base.replace("【逻辑连接词】", LOGIC_LINKERS)
}

/// 全文分析第一步「结构」的 user prompt（正文已由调用方按预算截断，无总结要求）。
fn build_analysis_structure_user_prompt(sent_text: &str, cut: bool) -> String {
    format!(
        "以下是待分析全文{}：\n\n{}\n\n请按 system 要求只输出 outline + nodes + edges 的 JSON，不要 summary，尽量精简。",
        if cut {
            "（超出预算，只分析前段）"
        } else {
            ""
        },
        sent_text
    )
}

/// 从分析结果里取骨架（兼容对象数组与纯字符串数组两种形态）。
fn parse_outline(v: &serde_json::Value) -> Vec<OutlineItem> {
    let raw = v
        .get("outline")
        .or_else(|| v.get("skeleton"))
        .or_else(|| v.get("sections"))
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::with_capacity(raw.len());
    for item in raw {
        // 形态一：直接给字符串
        if let Some(s) = item.as_str() {
            let t = s.trim();
            if !t.is_empty() {
                out.push(OutlineItem {
                    heading: truncate(t, 32),
                    detail: String::new(),
                });
            }
            continue;
        }
        // 形态二：对象
        let Some(heading) = json_text_field(&item, &["heading", "title", "name", "point", "label"])
        else {
            continue;
        };
        let detail =
            json_text_field(&item, &["detail", "description", "summary", "content"]).unwrap_or_default();
        out.push(OutlineItem { heading, detail });
    }
    out
}

/// 解析单概念解析结果：优先 JSON，失败则把整段文本当解析正文
///（免费模型经常直接回纯文本，这里不能因此报错让用户点了没反应）。
fn parse_concept_analysis(text: &str, concept: &str) -> Result<ConceptAnalysis, String> {
    if let Some(json_str) = extract_json_object(text) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json_str) {
            let analysis =
                json_text_field(&v, &["analysis", "explanation", "definition", "content", "text"])
                    .unwrap_or_default();
            if !analysis.is_empty() {
                let role = json_text_field(&v, &["role", "function", "position"]);
                let relations = v
                    .get("relations")
                    .and_then(|x| x.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|i| i.as_str().map(|s| s.trim().to_string()))
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<String>>()
                    })
                    .unwrap_or_default();
                return Ok(ConceptAnalysis {
                    concept: concept.to_string(),
                    analysis,
                    role,
                    relations,
                });
            }
        }
    }

    let plain = text.trim().trim_matches('"').trim();
    if plain.chars().count() < 40 {
        eprintln!("[concept] 返回内容过短，无法作为解析: {plain}");
        return Err(format!(
            "模型没有返回可用的解析（仅 {} 字），请重试",
            plain.chars().count()
        ));
    }
    Ok(ConceptAnalysis {
        concept: concept.to_string(),
        analysis: plain.to_string(),
        role: None,
        relations: Vec::new(),
    })
}

/// Tauri Command：全文深度分析。
/// 分两步返回以降低「界面死等」的体感延迟：
///   1) 结构调用：只出 title/outline/nodes/edges（无 summary，更快）→ emit `graph-stream-nodes`；
///   2) 总结调用：`ensure_summary` 生成 → emit `graph-stream-summary`；
/// 全程异步 reqwest + 60s 绝对超时，不阻塞主线程。不落盘，是否存项目由前端决定。
#[tauri::command]
async fn analyze_full_context(
    app: AppHandle,
    context_text: String,
    provider: LlmConfig,
    granularity: Option<Granularity>,
) -> Result<FullContextAnalysis, String> {
    let granularity = granularity.unwrap_or_default();
    let text = context_text.trim();
    if text.is_empty() {
        return Err("待分析文本为空：请先抓取或粘贴需要分析的全文".into());
    }

    let sent = truncate(text, DEFAULT_MAX_CONTEXT_CHARS);
    let cut = sent.chars().count() < text.chars().count();
    let context_chars = sent.chars().count();
    let request_id = gen_request_id();
    eprintln!(
        "[analyze] 全文分析开始: 原文 {} 字 / 送入 {} 字, granularity={}, model={}",
        text.chars().count(),
        context_chars,
        granularity.label(),
        provider.model
    );

    // 立即告知前端「已开始」（零网络开销，避免界面长时间无反馈）
    let _ = app.emit(
        "graph-stream-start",
        serde_json::json!({ "requestId": request_id, "kind": "full", "contextChars": context_chars }),
    );

    // ── 第一步：结构（不含 summary） ──
    let structure_raw = call_llm_text_with_timeout(
        &provider,
        &build_analysis_structure_prompt(),
        &build_analysis_structure_user_prompt(&sent, cut),
        LLM_TIMEOUT_LONG_SECS,
    )
    .await
    .map_err(|e| {
        eprintln!("[analyze] 结构提取失败: {e}");
        let _ = app.emit(
            "graph-stream-error",
            serde_json::json!({ "requestId": request_id, "error": e }),
        );
        e
    })?;

    let v: serde_json::Value = extract_json_object(&structure_raw)
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or_else(|| {
            eprintln!(
                "[analyze] 结构 JSON 解析失败，原文前 500 字: {}",
                truncate(&structure_raw, 500)
            );
            "模型没有返回结构 JSON：部分免费模型不支持稳定结构化输出，请重试或换用 DeepSeek-V4-Flash"
                .to_string()
        })?;

    let (raw_nodes, raw_edges, _ignored) = parse_graph_from_value(&v);
    let (nodes, mut edges) = normalize_graph(raw_nodes, raw_edges);
    if ensure_edges(&nodes, &mut edges) {
        eprintln!("[analyze] 模型未给连线，已按节点顺序自动串联（{} 条）", edges.len());
    }
    if nodes.is_empty() {
        eprintln!("[analyze] 模型未提炼出任何节点");
        return Err("模型没有提炼出任何概念节点：请重试，或换用更强的模型".into());
    }

    let mut outline = parse_outline(&v);
    if outline.is_empty() {
        eprintln!("[analyze] 模型未给 outline，改用核心概念兜底");
        outline = nodes
            .iter()
            .take(6)
            .map(|n| OutlineItem {
                heading: n.label.clone(),
                detail: n.description.clone().unwrap_or_default(),
            })
            .collect();
    }
    let title =
        json_text_field(&v, &["title", "topic", "theme"]).unwrap_or_else(|| truncate(text, 20));
    let thesis =
        json_text_field(&v, &["thesis", "mainIdea", "core", "claim"]).unwrap_or_default();

    // 先推节点：前端拿到即可渲染画布，总结随后到达
    let _ = app.emit(
        "graph-stream-nodes",
        serde_json::json!({
            "requestId": request_id,
            "title": title,
            "thesis": thesis,
            "outline": outline,
            "nodes": nodes,
            "edges": edges
        }),
    );

    // ── 第二步：总结（带原文，保证深层联系不被分步返回牺牲） ──
    let (min_chars, max_chars) = granularity.summary_bounds();
    let summary = summarize_with_context(
        &provider, &sent, &outline, &nodes, &edges, min_chars, max_chars,
    )
    .await;

    let _ = app.emit(
        "graph-stream-summary",
        serde_json::json!({ "requestId": request_id, "summary": summary }),
    );

    eprintln!(
        "[analyze] 完成: outline={} nodes={} edges={} summary={} 字",
        outline.len(),
        nodes.len(),
        edges.len(),
        summary.chars().count()
    );

    Ok(FullContextAnalysis {
        title,
        thesis,
        outline,
        nodes,
        edges,
        summary,
        context_chars,
        model: provider.model,
    })
}

/// Tauri Command：单节点深度解析。
/// 只解释「这个词在当前上下文中的具体含义」，不写百科通用定义。
#[tauri::command]
async fn analyze_single_concept(
    concept: String,
    context: String,
    provider: LlmConfig,
) -> Result<ConceptAnalysis, String> {
    let concept = concept.trim().to_string();
    if concept.is_empty() {
        return Err("概念名为空：该节点没有 label".into());
    }
    // 单节点解析只需要定位语境，8000 字足够，避免把整本书重复送一次
    let ctx = truncate(context.trim(), 8_000);
    eprintln!(
        "[concept] 解析「{concept}」: 上下文 {} 字, model={}",
        ctx.chars().count(),
        provider.model
    );

    let system = format!(
        "你是概念释义专家。用户给出一个词和它出现的一段上下文，你要解释的是「这个词在这段上下文里具体指什么」，\
不是百科通用定义。只输出一个 JSON 对象，不要 Markdown、不要前言：\
{{\"analysis\":\"...\",\"role\":\"...\",\"relations\":[\"...\"]}}。\
analysis：{CONCEPT_MIN_CHARS}-{CONCEPT_MAX_CHARS} 字，先说明它在这里指什么，\
再说它在论证中起什么作用，最后点出容易与什么概念混淆；必须紧扣上下文，禁止空话套话。\
role：一句话（≤20 字），说明它在文中承担的角色，如「全文的起点概念」。\
relations：2-3 条，每条一句「与「X」是因→果关系」这样的表述。"
    );
    let user = format!("概念：{concept}\n\n上下文：\n{ctx}");

    let raw = call_llm_text(&provider, &system, &user).await.map_err(|e| {
        eprintln!("[concept] LLM 调用失败: {e}");
        e
    })?;

    parse_concept_analysis(&raw, &concept)
}

// ---------------------------------------------------------------------------
// 账户系统（本地账户）：注册 / 登录 / 验证码 / 按用户隔离的数据目录
//
// 设计约束：
// 1. SHA-256 手写（见 `sha256`），密码 = 盐 + 10000 轮迭代哈希；
//    验证码优先走 SMTP 真实邮件投递，未配置 / 非邮箱账号 / 投递失败时
//    回退 MOCK 备用模式（直接回传前端 devCode），保证注册流程不被阻断。
// 2. 数据隔离：登录后图谱落 `app_data_dir/users/{user_id}/graphs/`，
//    设置落 `app_data_dir/users/{user_id}/settings.json`；
//    未登录保持 `app_data_dir/graphs/`（游客数据向后兼容，不做自动迁移）。
// 3. 重启恢复：会话写 `app_data_dir/session.json`，setup 时读回注入 AuthState；
//    前端启动后 getCurrentSession() → load_graph_projects()/load_user_settings()
//    即完成「登录后数据自动拉取」。
// ---------------------------------------------------------------------------

/// 验证码有效期（秒）
const CODE_TTL_SECS: u64 = 300;
/// 验证码最大错误次数，超过作废（防本地爆破）
const MAX_CODE_ATTEMPTS: u8 = 5;
/// 备用（MOCK）模式总开关：未配置 SMTP、非邮箱账号或真实投递失败时，
/// 把验证码直接回传前端展示。发布环境若要求强制真实邮件，可置 false。
const MOCK_FALLBACK_ENABLED: bool = true;
/// 密码哈希迭代轮数（SHA-256，本地应用量级够用）
const PASSWORD_ROUNDS: usize = 10_000;

/// 本地账户（`users/{user_id}/account.json`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAccount {
    pub user_id: String,
    /// "email" | "phone"
    pub account_type: String,
    /// 规范化后的手机号/邮箱（登录匹配键：邮箱转小写，手机号保留 + 与数字）
    pub identifier: String,
    pub nickname: String,
    /// hex(salt + password 迭代哈希)
    pub password_hash: String,
    /// hex 随机盐
    pub salt: String,
    pub created_at: u64,
}

/// 登录会话（前端持有一份，session.json 持久化一份用于重启恢复）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub user_id: String,
    pub identifier: String,
    pub nickname: String,
    /// "email" | "phone"
    pub account_type: String,
    /// 会话令牌（本地生成，当前仅用于前端标识会话，未做网络鉴权）
    pub token: String,
    pub logged_in_at: u64,
}

/// register_account 入参
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPayload {
    pub identifier: String,
    pub password: String,
    pub code: String,
    pub nickname: Option<String>,
}

/// send_verification_code 出参
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendCodeResult {
    pub success: bool,
    /// 验证码剩余有效期（秒）
    pub expires_in: u64,
    /// 模拟模式下的验证码（无 SMTP，前端直接展示；真实发送时恒为 None）
    pub dev_code: Option<String>,
    pub error: Option<String>,
}

/// 已发送、待校验的验证码
#[derive(Debug, Clone)]
struct PendingCode {
    code: String,
    expires_at: u64,
    attempts: u8,
}

/// 登录失败记录（按账号标识累计，用于限流；重启即清）
#[derive(Debug, Clone, Copy, Default)]
struct FailRecord {
    count: u8,
    /// 锁定截止时间（毫秒时间戳；0 = 未锁定）
    locked_until: u64,
}

/// 登录态（managed state）：None = 游客模式
#[derive(Default)]
struct AuthState {
    current: Mutex<Option<AuthSession>>,
    /// 登录失败/锁定记录：identifier → FailRecord
    failures: Mutex<std::collections::HashMap<String, FailRecord>>,
}

/// 验证码仓（managed state）：identifier → 待校验验证码，纯内存、重启即清
#[derive(Default)]
struct CodeStore(Mutex<std::collections::HashMap<String, PendingCode>>);

// ── SHA-256（纯 Rust 实现，避免新增依赖）────────────────────────────

/// SHA-256 常量表（FIPS 180-4）
const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// 纯 Rust SHA-256。用于密码哈希与盐/令牌生成，
/// 不追求抗侧信道——数据不出本机，威胁模型只到「落盘文件不可逆推密码」。
pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // 附加 0x80 + 0 填充到 56 (mod 64) + 8 字节大端位长
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[4 * i],
                block[4 * i + 1],
                block[4 * i + 2],
                block[4 * i + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for i in 0..8 {
        out[4 * i..4 * i + 4].copy_from_slice(&h[i].to_be_bytes());
    }
    out
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 密码哈希：salt + password 迭代 PASSWORD_ROUNDS 轮 SHA-256。
/// 注册与登录走同一函数，盐随账户存 account.json。
/// 密码策略（注册与改密共用）：8-64 位，至少一个字母、一个数字。
/// 纯数字/纯字母一律拒绝；错误文案直接说明要求，避免用户反复试。
fn validate_password(password: &str) -> Result<(), String> {
    let pw = password.trim();
    if pw.chars().count() < 8 {
        return Err("密码至少 8 位".into());
    }
    if pw.chars().count() > 64 {
        return Err("密码过长（最多 64 位）".into());
    }
    if !pw.chars().any(|c| c.is_ascii_alphabetic()) {
        return Err("密码需包含至少一个字母".into());
    }
    if !pw.chars().any(|c| c.is_ascii_digit()) {
        return Err("密码需包含至少一个数字".into());
    }
    Ok(())
}

fn hash_password(password: &str, salt: &str) -> String {
    let mut digest = format!("{salt}:{password}").into_bytes();
    for _ in 0..PASSWORD_ROUNDS {
        digest = sha256(&digest).to_vec();
    }
    hex_encode(&digest)
}

// ── 账号标识与目录工具 ─────────────────────────────────────────────

/// 归一化并校验账号标识，返回 ("email"|"phone", 归一化标识)。
/// 邮箱转小写；手机号去掉 - 和空格，保留 + 前缀。
fn validate_identifier(identifier: &str) -> Result<(String, String), String> {
    let id = identifier.trim();
    if id.is_empty() {
        return Err("账号不能为空".into());
    }
    if id.contains('@') {
        let email = id.to_lowercase();
        let Some((local, domain)) = email.split_once('@') else {
            return Err("邮箱格式不正确".into());
        };
        if local.is_empty()
            || domain.len() < 3
            || !domain.contains('.')
            || domain.starts_with('.')
            || domain.ends_with('.')
        {
            return Err("邮箱格式不正确".into());
        }
        Ok(("email".into(), email))
    } else {
        let phone = id.replace('-', "").replace(' ', "");
        let digits = phone.trim_start_matches('+');
        if digits.len() < 7 || digits.len() > 15 || !digits.chars().all(|c| c.is_ascii_digit()) {
            return Err("手机号格式不正确（7-15 位数字，可带 + 前缀）".into());
        }
        Ok(("phone".into(), phone))
    }
}

/// 昵称缺省值：邮箱取 @ 前缀；手机号保留前 3 后 4 位、中间打码。
fn identifier_masked(identifier: &str) -> String {
    if let Some((local, _)) = identifier.split_once('@') {
        return local.to_string();
    }
    let chars: Vec<char> = identifier.chars().collect();
    if chars.len() > 7 {
        let head: String = chars[..3].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{head}****{tail}")
    } else {
        identifier.to_string()
    }
}

/// 数据根目录指针（`<app_data_dir>/location.json`）。
/// 用户可在设置页把数据目录迁到其它磁盘；指针文件本身始终留在系统默认目录，
/// 这样即使目标盘暂时不可用，应用仍能回落到默认目录启动。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocation {
    pub root: String,
}

/// 系统默认数据目录（Tauri 决定，不可改）
fn base_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))
}

/// 生效的数据根目录：优先指针文件指向的目录，失效则回落默认目录
fn app_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = base_data_dir(app)?;
    let pointer = base.join("location.json");
    if let Ok(raw) = std::fs::read_to_string(&pointer) {
        if let Ok(loc) = serde_json::from_str::<DataLocation>(&raw) {
            let path = PathBuf::from(loc.root.trim());
            if path.is_absolute() && path.exists() {
                return Ok(path);
            }
        }
    }
    Ok(base)
}

fn users_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_root(app)?.join("users"))
}

fn user_dir(app: &AppHandle, user_id: &str) -> Result<PathBuf, String> {
    // user_id 由后端生成，仍按路径穿越挡一手
    if !is_safe_id(user_id) {
        return Err("非法的用户 id".into());
    }
    Ok(users_root(app)?.join(user_id))
}

fn account_file(app: &AppHandle, user_id: &str) -> Result<PathBuf, String> {
    Ok(user_dir(app, user_id)?.join("account.json"))
}

fn session_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_root(app)?.join("session.json"))
}

/// 原子写账户文件（注册 / 改密共用）。先写 `.tmp` 再 rename，避免半截 JSON。
fn save_account(app: &AppHandle, account: &UserAccount) -> Result<(), String> {
    let json = serde_json::to_string_pretty(account).map_err(|e| format!("序列化账户失败: {e}"))?;
    let path = account_file(app, &account.user_id)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入账户文件失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换账户文件失败: {e}"))
}

/// 设置文件位置：登录 → users/{user_id}/settings.json；游客 → settings.json
fn settings_file(app: &AppHandle, auth: &AuthState) -> Result<PathBuf, String> {
    match current_user_id(auth) {
        Some(uid) => Ok(user_dir(app, &uid)?.join("settings.json")),
        None => Ok(app_root(app)?.join("settings.json")),
    }
}

/// 当前登录用户 id（None = 游客）
fn current_user_id(auth: &AuthState) -> Option<String> {
    match auth.current.lock() {
        Ok(g) => g.as_ref().map(|s| s.user_id.clone()),
        Err(p) => p.into_inner().as_ref().map(|s| s.user_id.clone()),
    }
}

/// 遍历 users/*/account.json 按标识找账户。
/// 用户量是本机量级（个位数到几十），线性扫描即可，无需索引文件
///（也避免「注册写一半崩溃导致索引与文件不一致」的问题）。
fn find_account_by_identifier(
    app: &AppHandle,
    identifier: &str,
) -> Result<Option<UserAccount>, String> {
    let root = users_root(app)?;
    if !root.exists() {
        return Ok(None);
    }
    let entries = std::fs::read_dir(&root).map_err(|e| format!("读取用户目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path().join("account.json");
        if !path.is_file() {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<UserAccount>(&raw) {
                Ok(acc) if acc.identifier == identifier => return Ok(Some(acc)),
                Ok(_) => {}
                Err(e) => eprintln!("[auth] 跳过损坏账户文件 {}: {e}", path.display()),
            },
            Err(_) => continue,
        }
    }
    Ok(None)
}

// ── 会话持久化（session.json）──────────────────────────────────────

fn persist_session(app: &AppHandle, session: &AuthSession) -> Result<(), String> {
    let path = session_file(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(session).map_err(|e| format!("序列化会话失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入会话失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换会话文件失败: {e}"))?;
    Ok(())
}

fn read_session_file(app: &AppHandle) -> Option<AuthSession> {
    let path = session_file(app).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str(&raw) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[auth] 会话文件损坏，按未登录处理: {e}");
            None
        }
    }
}

fn clear_session_file(app: &AppHandle) {
    if let Ok(path) = session_file(app) {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[auth] 清理会话文件失败: {e}");
            }
        }
    }
}

/// 写会话文件 + 更新内存登录态（先落盘成功再改内存，失败不留半态）
fn set_session(
    app: &AppHandle,
    auth: &AuthState,
    session: AuthSession,
) -> Result<AuthSession, String> {
    persist_session(app, &session)?;
    let mut current = match auth.current.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    *current = Some(session.clone());
    Ok(session)
}

// ---------------------------------------------------------------------------
// SMTP 邮箱验证码（真实投递 + MOCK 备用）
//
// 安全约定：
// - 授权码只落在 <系统默认数据目录>/smtp.json，绝不写入代码、文档或日志；
// - 返回给前端的配置视图恒不携带授权码，用 hasPassword 表示已保存；
// - smtp.json 与 bridge.json 一样属于本机安全配置，不随数据目录迁移；
// - 写盘统一 .tmp → rename，避免崩溃留下半截配置。
// ---------------------------------------------------------------------------

/// 邮件投递超时（秒）：超时即回退备用模式，不让注册流程无限等待
const SMTP_SEND_TIMEOUT_SECS: u64 = 20;
const DEFAULT_FROM_NAME: &str = "Termask";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmtpConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// 授权码 / 应用专用密码（仅落盘，不回传前端、不进日志）
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub from_name: String,
    /// "starttls"（默认，587）| "ssl"（465）| "none"（明文，仅内网调试）
    #[serde(default)]
    pub encryption: String,
}

/// 设置页读到的脱敏视图：绝不包含授权码明文。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpConfigView {
    pub enabled: bool,
    pub server: String,
    pub port: u16,
    pub username: String,
    pub from_name: String,
    pub encryption: String,
    pub has_password: bool,
    /// true = 配置未就绪，当前会走备用（MOCK）模式
    pub mock_mode: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpConfigInput {
    pub enabled: bool,
    pub server: String,
    pub port: Option<u16>,
    pub username: String,
    /// 留空表示保留已保存的授权码（前端读不到明文，避免误清空）
    pub password: Option<String>,
    pub from_name: Option<String>,
    pub encryption: Option<String>,
}

fn smtp_config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?
        .join("smtp.json"))
}

fn load_smtp_config(app: &AppHandle) -> SmtpConfig {
    smtp_config_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<SmtpConfig>(&raw).ok())
        .unwrap_or_default()
}

fn save_smtp_config(app: &AppHandle, cfg: &SmtpConfig) -> Result<(), String> {
    let path = smtp_config_file(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入 SMTP 配置失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换 SMTP 配置失败: {e}"))
}

impl SmtpConfig {
    /// 配置是否足以发起真实投递
    fn is_ready(&self) -> bool {
        self.enabled
            && !self.server.trim().is_empty()
            && !self.username.trim().is_empty()
            && !self.password.is_empty()
            && self.port > 0
    }

    fn normalized_encryption(&self) -> &'static str {
        match self.encryption.trim().to_ascii_lowercase().as_str() {
            "ssl" => "ssl",
            "none" => "none",
            _ => "starttls",
        }
    }

    fn default_port(&self) -> u16 {
        if self.normalized_encryption() == "ssl" {
            465
        } else {
            587
        }
    }

    fn view(&self) -> SmtpConfigView {
        SmtpConfigView {
            enabled: self.enabled,
            server: self.server.clone(),
            port: self.port,
            username: self.username.clone(),
            from_name: if self.from_name.trim().is_empty() {
                DEFAULT_FROM_NAME.to_string()
            } else {
                self.from_name.clone()
            },
            encryption: self.normalized_encryption().to_string(),
            has_password: !self.password.is_empty(),
            mock_mode: !self.is_ready(),
        }
    }
}

/// Tauri Command：读取 SMTP 配置（授权码脱敏）。
#[tauri::command]
fn get_smtp_config(app: AppHandle) -> SmtpConfigView {
    load_smtp_config(&app).view()
}

/// Tauri Command：保存 SMTP 配置。授权码留空 = 保留原值。
#[tauri::command]
fn set_smtp_config(app: AppHandle, config: SmtpConfigInput) -> Result<SmtpConfigView, String> {
    let mut next = load_smtp_config(&app);
    next.enabled = config.enabled;
    next.server = config.server.trim().to_string();
    next.username = config.username.trim().to_string();
    next.encryption = config
        .encryption
        .as_deref()
        .unwrap_or("starttls")
        .trim()
        .to_ascii_lowercase();
    next.from_name = config
        .from_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_FROM_NAME)
        .to_string();
    next.port = config.port.unwrap_or_else(|| next.default_port());
    if let Some(pwd) = config
        .password
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        next.password = pwd.to_string();
    }

    if next.enabled {
        if next.server.is_empty() {
            return Err("请填写 SMTP 服务器地址".into());
        }
        if !next.username.contains('@') {
            return Err("请填写合法的发件邮箱账号".into());
        }
        if next.password.is_empty() {
            return Err("请填写邮箱授权码（应用专用密码）".into());
        }
        if next.port == 0 {
            return Err("SMTP 端口不合法".into());
        }
    }

    save_smtp_config(&app, &next)?;
    // 只打印启用状态，绝不打印授权码或上游错误正文
    eprintln!(
        "[smtp] 配置已保存：真实投递{}",
        if next.enabled { "开启" } else { "关闭" }
    );
    Ok(next.view())
}

/// 真实邮件投递（同步 lettre 调用）。只返回中文可读错误，不暴露上游细节或凭证。
fn send_email_code(cfg: &SmtpConfig, to: &str, code: &str) -> Result<(), String> {
    use lettre::message::header::ContentType;
    use lettre::message::{Mailbox, Message};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{SmtpTransport, Transport};

    let name = if cfg.from_name.trim().is_empty() {
        DEFAULT_FROM_NAME
    } else {
        cfg.from_name.trim()
    };
    let from = Mailbox::new(
        Some(name.to_string()),
        cfg.username
            .parse()
            .map_err(|_| "SMTP 发件账号不是合法邮箱".to_string())?,
    );
    let to_mailbox: Mailbox = to
        .parse()
        .map_err(|_| "收件邮箱格式不正确".to_string())?;
    let body = format!(
        "{name} 邮箱验证码\n\n您的验证码是：{code}\n\n验证码 5 分钟内有效，请勿转发给他人。\n如果这不是您本人的操作，请忽略本邮件。\n\n— Termask 工作台"
    );
    let email = Message::builder()
        .from(from)
        .to(to_mailbox)
        .subject("Termask 邮箱验证码")
        .header(ContentType::TEXT_PLAIN)
        .body(body)
        .map_err(|_| "邮件内容构建失败，请检查发件账号".to_string())?;

    let creds = Credentials::new(cfg.username.clone(), cfg.password.clone());
    let timeout = Some(Duration::from_secs(SMTP_SEND_TIMEOUT_SECS));
    let mailer = match cfg.normalized_encryption() {
        "ssl" => SmtpTransport::relay(&cfg.server)
            .map_err(|_| "SMTP 服务器地址无效".to_string())?
            .port(cfg.port)
            .credentials(creds)
            .timeout(timeout)
            .build(),
        "none" => SmtpTransport::builder_dangerous(&cfg.server)
            .port(cfg.port)
            .credentials(creds)
            .timeout(timeout)
            .build(),
        _ => SmtpTransport::starttls_relay(&cfg.server)
            .map_err(|_| "SMTP 服务器地址无效".to_string())?
            .port(cfg.port)
            .credentials(creds)
            .timeout(timeout)
            .build(),
    };
    mailer
        .send(&email)
        .map_err(|_| "邮件投递失败：请检查 SMTP 服务器、端口、账号与授权码".to_string())?;
    Ok(())
}

/// 在独立线程里投递，避免阻塞命令线程；超时即判失败并触发备用模式。
fn try_send_email_code(cfg: SmtpConfig, to: String, code: String) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(send_email_code(&cfg, &to, &code));
    });
    rx.recv_timeout(Duration::from_secs(SMTP_SEND_TIMEOUT_SECS + 5))
        .unwrap_or_else(|_| Err("邮件投递超时，请检查 SMTP 服务器与网络".to_string()))
}

// ── 验证码 ─────────────────────────────────────────────────────────

/// 无 rand 依赖的 6 位验证码：sha256(标识 + 纳秒) 取模。
/// 模拟发送场景够用；接真实通道后可换服务商 SDK 生成的码。
fn gen_verification_code(identifier: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let digest = sha256(format!("{identifier}:{nanos}").as_bytes());
    let num = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{num:06}")
}

/// 校验并消费验证码（一次性；过期 / 连错 MAX_CODE_ATTEMPTS 次作废）。
/// 先克隆出判断所需字段再动 store，避免跨借用的编译问题。
fn consume_verification_code(
    codes: &CodeStore,
    identifier: &str,
    input: &str,
) -> Result<(), String> {
    let mut store = match codes.0.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let pending = match store.get(identifier) {
        Some(p) => p.clone(),
        None => return Err("请先获取验证码".into()),
    };
    if now_millis() > pending.expires_at {
        store.remove(identifier);
        return Err("验证码已过期，请重新获取".into());
    }
    if pending.code != input.trim() {
        let attempts = pending.attempts.saturating_add(1);
        if attempts >= MAX_CODE_ATTEMPTS {
            store.remove(identifier);
            return Err("验证码错误次数过多已失效，请重新获取".into());
        }
        if let Some(p) = store.get_mut(identifier) {
            p.attempts = attempts;
        }
        return Err("验证码不正确".into());
    }
    store.remove(identifier); // 校验通过即作废，防止重复使用
    Ok(())
}

// ── 账户 Commands ──────────────────────────────────────────────────

/// Tauri Command：发送邮箱验证码（有效期 5 分钟）。
///
/// 优先按 SMTP 配置真实投递；未配置、非邮箱账号或投递失败时回退 MOCK 备用模式。
/// 前端 invoke("send_verification_code", { identifier })。
#[tauri::command]
fn send_verification_code(
    app: AppHandle,
    identifier: String,
    codes: tauri::State<'_, CodeStore>,
) -> SendCodeResult {
    let (account_type, identifier) = match validate_identifier(&identifier) {
        Ok((kind, id)) => (kind.to_string(), id),
        Err(e) => {
            return SendCodeResult {
                success: false,
                expires_in: 0,
                dev_code: None,
                error: Some(e),
            }
        }
    };

    let code = gen_verification_code(&identifier);
    let expires_at = now_millis() + CODE_TTL_SECS * 1000;
    {
        let mut store = match codes.0.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // 覆盖式：重发即作废旧码
        store.insert(
            identifier.clone(),
            PendingCode {
                code: code.clone(),
                expires_at,
                attempts: 0,
            },
        );
    }

    let cfg = load_smtp_config(&app);
    if account_type == "email" && cfg.is_ready() {
        match try_send_email_code(cfg, identifier.clone(), code.clone()) {
            Ok(()) => {
                eprintln!("[auth] 验证码邮件已投递至 {identifier}");
                return SendCodeResult {
                    success: true,
                    expires_in: CODE_TTL_SECS,
                    dev_code: None,
                    error: None,
                };
            }
            Err(reason) => {
                eprintln!("[auth] 邮件投递失败，回退备用模式：{reason}");
                if MOCK_FALLBACK_ENABLED {
                    return SendCodeResult {
                        success: true,
                        expires_in: CODE_TTL_SECS,
                        dev_code: Some(code),
                        error: Some("邮件发送失败，已切换为备用验证码，请在界面查看".into()),
                    };
                }
                return SendCodeResult {
                    success: false,
                    expires_in: 0,
                    dev_code: None,
                    error: Some(reason),
                };
            }
        }
    }

    if !MOCK_FALLBACK_ENABLED && account_type == "email" {
        return SendCodeResult {
            success: false,
            expires_in: 0,
            dev_code: None,
            error: Some("尚未配置 SMTP 邮箱服务，请在设置页填写服务器、账号与授权码".into()),
        };
    }

    // 备用模式：验证码直接回传前端展示（不发真实邮件/短信）。
    let note = if account_type == "phone" {
        Some("暂不支持手机短信验证码，已改用备用验证码；建议改用邮箱注册".to_string())
    } else {
        None
    };
    eprintln!("[auth] 备用验证码已「发送」: {identifier} → {code}");
    SendCodeResult {
        success: true,
        expires_in: CODE_TTL_SECS,
        dev_code: Some(code),
        error: note,
    }
}

/// Tauri Command：注册（手机号/邮箱 + 密码 + 验证码），成功即登录。
#[tauri::command]
fn register_account(
    app: AppHandle,
    payload: RegisterPayload,
    codes: tauri::State<'_, CodeStore>,
    auth: tauri::State<'_, AuthState>,
) -> Result<AuthSession, String> {
    let (account_type, identifier) = validate_identifier(&payload.identifier)?;

    let password = payload.password.trim();
    validate_password(password)?;

    if find_account_by_identifier(&app, &identifier)?.is_some() {
        return Err("该账号已注册，请直接登录".into());
    }

    // 查重通过后再消费验证码：避免用户打错码就把名额烧掉
    consume_verification_code(&codes, &identifier, &payload.code)?;

    let now = now_millis();
    let user_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("u{:x}", d.as_nanos()))
        .unwrap_or_else(|_| "u0".to_string());
    let salt = hex_encode(&sha256(format!("{identifier}:{now}").as_bytes()));
    let password_hash = hash_password(password, &salt);
    let nickname = payload
        .nickname
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| identifier_masked(&identifier));

    let account = UserAccount {
        user_id: user_id.clone(),
        account_type: account_type.clone(),
        identifier: identifier.clone(),
        nickname: nickname.clone(),
        password_hash: password_hash.clone(),
        salt,
        created_at: now,
    };

    // 原子写 account.json + 预建用户目录（graphs/）
    let dir = user_dir(&app, &user_id)?;
    std::fs::create_dir_all(dir.join("graphs")).map_err(|e| format!("创建用户目录失败: {e}"))?;
    save_account(&app, &account)?;

    eprintln!("[auth] 注册成功: {identifier} → {user_id}");

    let session = AuthSession {
        user_id: user_id.clone(),
        identifier,
        nickname,
        account_type,
        token: hex_encode(&sha256(format!("{user_id}:{now}:{password_hash}").as_bytes())),
        logged_in_at: now,
    };
    set_session(&app, &auth, session)
}

/// 登录失败上限与锁定时长
const LOGIN_MAX_FAILS: u8 = 5;
const LOGIN_LOCK_MS: u64 = 60_000;

/// 返回剩余锁定秒数（None = 未锁定）
fn login_lock_remaining(auth: &AuthState, identifier: &str) -> Option<u64> {
    let map = match auth.failures.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let rec = map.get(identifier)?;
    if rec.locked_until == 0 {
        return None;
    }
    let now = now_millis();
    if rec.locked_until > now {
        Some((rec.locked_until - now) / 1000 + 1)
    } else {
        None
    }
}

fn record_login_failure(auth: &AuthState, identifier: &str) {
    let mut map = match auth.failures.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let rec = map.entry(identifier.to_string()).or_default();
    rec.count = rec.count.saturating_add(1);
    if rec.count >= LOGIN_MAX_FAILS {
        rec.count = 0;
        rec.locked_until = now_millis() + LOGIN_LOCK_MS;
        eprintln!("[auth] 连续失败 {LOGIN_MAX_FAILS} 次，账号已临时锁定: {identifier}");
    }
}

fn clear_login_failures(auth: &AuthState, identifier: &str) {
    if let Ok(mut map) = auth.failures.lock() {
        map.remove(identifier);
    }
}

/// Tauri Command：登录（手机号/邮箱 + 密码）。
/// 登录后图谱/设置自动切到 users/{user_id}/ 下，前端重新拉取即可见。
#[tauri::command]
fn login_account(
    app: AppHandle,
    identifier: String,
    password: String,
    auth: tauri::State<'_, AuthState>,
) -> Result<AuthSession, String> {
    let (_ty, identifier) = validate_identifier(&identifier)?;

    // 限流：同一账号连续失败 5 次 → 锁定 60 秒（内存态，重启解除）
    if let Some(secs) = login_lock_remaining(&auth, &identifier) {
        return Err(format!("尝试次数过多，请 {secs} 秒后再试"));
    }

    let account = match find_account_by_identifier(&app, &identifier)? {
        Some(a) => a,
        None => {
            record_login_failure(&auth, &identifier);
            // 失败文案保持模糊：不区分「密码错」与「账号不存在」，避免账号枚举
            return Err("账号或密码不正确".into());
        }
    };

    let attempt = hash_password(password.trim(), &account.salt);
    if attempt != account.password_hash {
        record_login_failure(&auth, &identifier);
        return Err("账号或密码不正确".into());
    }
    clear_login_failures(&auth, &identifier);

    let now = now_millis();
    // 目录被手动删除/换机时登录即重建
    let dir = user_dir(&app, &account.user_id)?;
    let _ = std::fs::create_dir_all(dir.join("graphs"));

    eprintln!("[auth] 登录成功: {}", account.identifier);
    let session = AuthSession {
        user_id: account.user_id.clone(),
        identifier: account.identifier.clone(),
        nickname: account.nickname.clone(),
        account_type: account.account_type.clone(),
        token: hex_encode(&sha256(
            format!("{}:{now}:{}", account.user_id, account.password_hash).as_bytes(),
        )),
        logged_in_at: now,
    };
    set_session(&app, &auth, session)
}

/// Tauri Command：修改密码（需已登录 + 校验原密码）。
/// 改密后旧密码立即失效；会话保持有效（本地单机会话，不做强制重登）。
#[tauri::command]
fn change_password(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    let uid = current_user_id(&auth).ok_or_else(|| "请先登录再修改密码".to_string())?;
    let path = account_file(&app, &uid)?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取账户失败: {e}"))?;
    let mut account: UserAccount =
        serde_json::from_str(&raw).map_err(|e| format!("账户文件损坏: {e}"))?;

    if hash_password(old_password.trim(), &account.salt) != account.password_hash {
        return Err("原密码不正确".into());
    }
    validate_password(&new_password)?;
    if old_password.trim() == new_password.trim() {
        return Err("新密码不能与原密码相同".into());
    }

    let salt = hex_encode(&sha256(
        format!("{}:{}", account.identifier, now_millis()).as_bytes(),
    ));
    account.salt = salt.clone();
    account.password_hash = hash_password(new_password.trim(), &salt);
    save_account(&app, &account)?;
    eprintln!("[auth] 密码已修改: {}", account.identifier);
    Ok(())
}

/// Tauri Command：退出登录。回到游客模式，数据落回 app_data_dir 根目录。
#[tauri::command]
fn logout_account(app: AppHandle, auth: tauri::State<'_, AuthState>) -> Result<(), String> {
    {
        let mut current = match auth.current.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        *current = None;
    }
    clear_session_file(&app);
    eprintln!("[auth] 已退出登录（游客模式）");
    Ok(())
}

/// Tauri Command：当前登录会话（None = 未登录）。
/// 前端启动时先调它，再决定拉哪份数据 / 是否显示登录页。
#[tauri::command]
fn get_current_session(auth: tauri::State<'_, AuthState>) -> Option<AuthSession> {
    match auth.current.lock() {
        Ok(g) => g.clone(),
        Err(p) => p.into_inner().clone(),
    }
}

/// Tauri Command：保存设置（字符串透传，后端不解析语义，只做 JSON 合法性预检）。
/// 登录后落 users/{user_id}/settings.json，游客落 settings.json。
#[tauri::command]
fn save_user_settings(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
    settings: String,
) -> Result<(), String> {
    let settings = settings.trim().to_string();
    if settings.is_empty() {
        return Err("设置内容为空".into());
    }
    // 预检：防止把任意文本写进 settings.json
    serde_json::from_str::<serde_json::Value>(&settings)
        .map_err(|e| format!("设置内容不是合法 JSON: {e}"))?;

    let path = settings_file(&app, &auth)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建设置目录失败: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &settings).map_err(|e| format!("写入设置失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换设置文件失败: {e}"))?;
    Ok(())
}

/// Tauri Command：读取设置（未保存过返回 None）。
#[tauri::command]
fn load_user_settings(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
) -> Option<String> {
    let path = settings_file(&app, &auth).ok()?;
    std::fs::read_to_string(&path).ok()
}

// ---------------------------------------------------------------------------
// 内存暂存区 command（读取 / 删除 / 清空 / 计数）
//
// 状态：`CacheStore`（见 cache.rs）是进程级单例，内部按 target 分区：
//   target="graph"      → 概念图谱收集区（GraphPage）
//   target="whiteboard" → 白板收集区（WhiteboardPage）
// 两条链路各自独立读写与计数，避免「白板词写进概念区」的串台。
//
// 锁策略：std::sync::Mutex，临界区只做内存操作，不含 .await（跨 await 持锁会 !Send）。
// 前后端契约：删除/清空都直接回传「操作后的完整列表」，前端不必再查一次。
// ---------------------------------------------------------------------------

/// 前端传来的 target 归一（缺省/非法一律 graph）
fn command_target(raw: Option<String>) -> Target {
    raw.as_deref().map(Target::parse).unwrap_or(Target::Graph)
}

/// 词条入暂存区并广播对应事件（画布节点拖回收集区、白板「加入收集区」共用）。
#[tauri::command]
fn stage_word(
    word: StagedWord,
    state: tauri::State<'_, CacheStore>,
    app: AppHandle,
) -> Result<usize, String> {
    let outcome = state.push(word).map_err(|e| e.to_string())?;
    let event = match outcome.target {
        Target::Graph => "staged-word",
        Target::Whiteboard => "whiteboard-word",
    };
    if let Err(e) = app.emit(event, &outcome.word) {
        eprintln!("[staging] emit {event} failed: {e}");
    }
    Ok(outcome.len)
}

/// 读取某个收集区（target 缺省 graph）。
#[tauri::command]
fn get_staged_words(
    target: Option<String>,
    state: tauri::State<'_, CacheStore>,
) -> Vec<StagedWord> {
    state.words(command_target(target))
}

/// 白板收集区读取（显式命名，白板页无需关心 target 字符串）。
#[tauri::command]
fn get_whiteboard_words(state: tauri::State<'_, CacheStore>) -> Vec<StagedWord> {
    state.words(Target::Whiteboard)
}

/// 读取收集区词条数量（不含 __FULL_CONTEXT__ 标记词，与插件计数口径一致）。
#[tauri::command]
fn get_cache_count(target: Option<String>, state: tauri::State<'_, CacheStore>) -> usize {
    state.count(command_target(target))
}

/// 删除指定词条（trim 后比较，删除所有同名项），返回删除后的最新列表。
#[tauri::command]
fn remove_from_cache(
    target: Option<String>,
    term: String,
    state: tauri::State<'_, CacheStore>,
) -> Vec<StagedWord> {
    state.remove_term(command_target(target), &term)
}

/// 删除白板收集区词条，返回删除后的最新列表。
#[tauri::command]
fn remove_whiteboard_word(term: String, state: tauri::State<'_, CacheStore>) -> Vec<StagedWord> {
    state.remove_term(Target::Whiteboard, &term)
}

/// 清空收集区，返回清空后的列表（空列表），供前端直接刷新状态。
#[tauri::command]
fn clear_cache(target: Option<String>, state: tauri::State<'_, CacheStore>) -> Vec<StagedWord> {
    state.clear(command_target(target))
}

/// 清空白板收集区，返回空列表。
#[tauri::command]
fn clear_whiteboard_words(state: tauri::State<'_, CacheStore>) -> Vec<StagedWord> {
    state.clear(Target::Whiteboard)
}

/// 兼容旧调用点：清空但不返回值（`GraphPage` 生成成功后仍在用）。
#[tauri::command]
fn clear_staged_words(target: Option<String>, state: tauri::State<'_, CacheStore>) {
    state.clear(command_target(target));
}

/// 读取当前待分析的全文快照（单槽位覆盖式；可能为 None）。
#[tauri::command]
fn get_full_context(state: tauri::State<'_, CacheStore>) -> Option<StagedWord> {
    state.full_context()
}

/// 读取批量学习模式开关（GraphPage 初始化用）。
#[tauri::command]
fn get_batch_mode(state: tauri::State<'_, CacheStore>) -> bool {
    state.batch_mode()
}

/// 切换批量学习模式（插件经 GET /api/batch-mode 轮询）。
#[tauri::command]
fn set_batch_mode(enabled: bool, state: tauri::State<'_, CacheStore>) -> bool {
    state.set_batch_mode(enabled)
}

/// 兼容旧调用点：删除并返回删除条数。
#[tauri::command]
fn remove_staged_word(
    target: Option<String>,
    term: String,
    state: tauri::State<'_, CacheStore>,
) -> usize {
    let target = command_target(target);
    let before = state.words(target).len();
    state.remove_term(target, &term);
    before.saturating_sub(state.words(target).len())
}

// ---------------------------------------------------------------------------
// 桥接安全（设置页展示 / 开关 / 令牌轮换）
// ---------------------------------------------------------------------------

/// 桥接安全信息（令牌只经 IPC 回给本应用前端，绝不走 HTTP）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSecurityInfo {
    pub port: u16,
    pub token: String,
    pub require_token: bool,
}

#[tauri::command]
fn get_bridge_security(security: tauri::State<'_, security::Security>) -> BridgeSecurityInfo {
    BridgeSecurityInfo {
        port: BRIDGE_PORT,
        token: security.token(),
        require_token: security.require_token(),
    }
}

#[tauri::command]
fn set_bridge_require_token(
    enabled: bool,
    security: tauri::State<'_, security::Security>,
) -> bool {
    security.set_require_token(enabled)
}

#[tauri::command]
fn rotate_bridge_token(security: tauri::State<'_, security::Security>) -> String {
    security.rotate_token()
}

/// 默认全局快捷键：偏好缺失、注册失败时一律回退到它。
const DEFAULT_SHORTCUT: &str = "Ctrl+Shift+Q";

/// 当前生效的快捷键：读 preferences.json，缺失或空串回退默认键。
fn effective_shortcut(app: &AppHandle) -> String {
    load_preferences(app)
        .global_shortcut
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string())
}

/// Tauri Command：查询当前全局快捷键（设置页回显用）。
#[tauri::command]
fn get_global_shortcut(app: AppHandle) -> String {
    effective_shortcut(&app)
}

/// 应用用户配置的全局快捷键，并持久化到 preferences.json。
/// 先注销旧键再注册新键；失败回滚默认键并同步写盘，保证重启后行为一致。
#[tauri::command]
fn set_global_shortcut(app: AppHandle, accelerator: String) -> Result<String, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let acc = accelerator.trim();
        if acc.is_empty() {
            return Err("快捷键不能为空".into());
        }
        let gs = app.global_shortcut();
        let _ = gs.unregister_all();
        let chosen = match gs.register(acc) {
            Ok(()) => acc.to_string(),
            Err(_) => {
                eprintln!("[shortcut] 注册 {acc} 失败，回滚默认键");
                let _ = gs.register(DEFAULT_SHORTCUT);
                let mut prefs = load_preferences(&app);
                prefs.global_shortcut = Some(DEFAULT_SHORTCUT.to_string());
                save_preferences(&app, &prefs)?;
                return Err("快捷键注册失败，可能已被其它程序占用，已恢复默认快捷键".into());
            }
        };
        let mut prefs = load_preferences(&app);
        prefs.global_shortcut = Some(chosen.clone());
        save_preferences(&app, &prefs)?;
        println!("[shortcut] 已切换并保存全局快捷键: {chosen}");
        Ok(chosen)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, accelerator);
        Err("移动端不支持全局快捷键".into())
    }
}

// ---------------------------------------------------------------------------
// 应用偏好（分类开关等）：与用户设置分开存，避免前端 settings.json 的 blob 冲突
// ---------------------------------------------------------------------------

/// 应用级偏好（全局，不按用户隔离）。
/// 单独文件是为了让后端自有的开关不被前端 `save_user_settings` 的整串覆盖。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    /// 生成图谱后是否自动调用 LLM 分类（前端据此时决定是否自动请求）
    #[serde(default)]
    pub auto_classify: bool,
    /// 用户自定义的全局快捷键；None / 空串 = 回退默认 Ctrl+Shift+Q
    #[serde(default)]
    pub global_shortcut: Option<String>,
}

fn preferences_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_root(app)?.join("preferences.json"))
}

fn load_preferences(app: &AppHandle) -> AppPreferences {
    preferences_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<AppPreferences>(&raw).ok())
        .unwrap_or_default()
}

fn save_preferences(app: &AppHandle, prefs: &AppPreferences) -> Result<(), String> {
    let path = preferences_file(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(prefs).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换失败: {e}"))
}

/// 读取应用偏好（前端进入图谱页时调用，决定自动分类开关的初始状态）
#[tauri::command]
fn get_app_preferences(app: AppHandle) -> AppPreferences {
    load_preferences(&app)
}

/// 设置「自动分类」开关。
///
/// 语义：开启 = 图谱生成/词条入库后前端自动请求 `classify_concepts`；
/// 关闭 = 不自动请求，用户在概念图谱栏点「自动分类」按钮时才调用同一命令。
/// 后端只持久化偏好，不替前端决定何时触发，两种模式共用同一个分类命令。
#[tauri::command]
fn set_auto_classify(app: AppHandle, enabled: bool) -> Result<AppPreferences, String> {
    let mut prefs = load_preferences(&app);
    prefs.auto_classify = enabled;
    save_preferences(&app, &prefs)?;
    eprintln!("[classify] 自动分类开关: {enabled}");
    Ok(prefs)
}

/// Tauri Command：批量概念分类（LLM 优先，失败自动降级本地规则）。
/// 返回体带 `degraded` 标记，前端据此提示「本次为本地规则结果」。
#[tauri::command]
async fn classify_concepts(
    terms: Vec<String>,
    provider: LlmConfig,
) -> classify::ClassifyResult {
    classify::classify_terms(terms, &provider).await
}

// ---------------------------------------------------------------------------
// 数据目录（可迁移）
// ---------------------------------------------------------------------------

/// 递归复制目录（跳过位置指针与本机安全凭据，避免把旧路径/令牌带到新目录）
fn copy_tree(from: &Path, to: &Path) -> Result<u64, String> {
    let mut copied = 0u64;
    std::fs::create_dir_all(to).map_err(|e| format!("创建目标目录失败: {e}"))?;
    let entries = std::fs::read_dir(from).map_err(|e| format!("读取源目录失败: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == "location.json" || name_str == "bridge.json" {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        if src.is_dir() {
            copied += copy_tree(&src, &dst)?;
        } else if src.is_file() {
            std::fs::copy(&src, &dst).map_err(|e| format!("复制 {} 失败: {e}", src.display()))?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// 当前数据根目录
#[tauri::command]
fn get_data_location(app: AppHandle) -> Result<String, String> {
    Ok(app_root(&app)?.display().to_string())
}

/// 迁移数据目录：校验 → 复制 → 写指针。
///
/// 设计取舍：
/// - 只允许迁移到**空目录**，避免覆盖用户已有文件；
/// - 复制完成才写指针，复制失败保持原目录不变（不会出现半迁移状态）；
/// - 不复制 `bridge.json`（桥接令牌属于本机安全配置，跟随系统目录而不是业务数据）。
#[tauri::command]
fn set_data_location(app: AppHandle, path: String) -> Result<String, String> {
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err("请选择绝对路径（例如 D:////TermAskData）".into());
    }
    let current = app_root(&app)?;
    if target == current {
        return Ok(current.display().to_string());
    }
    if target.starts_with(&current) || current.starts_with(&target) {
        return Err("新目录不能是当前数据目录的父目录或子目录".into());
    }
    if target.exists() {
        let mut it = std::fs::read_dir(&target).map_err(|e| format!("读取目标目录失败: {e}"))?;
        if it.next().is_some() {
            return Err("目标目录非空，请选择一个空目录".into());
        }
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("创建目标目录失败: {e}"))?;

    // 写权限探测：避免选到只读盘后在复制中途失败
    let probe = target.join(".termask-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("目标目录不可写: {e}"))?;
    let _ = std::fs::remove_file(&probe);

    let copied = copy_tree(&current, &target)?;
    eprintln!(
        "[data] 数据迁移完成: {} → {}（{copied} 个文件）",
        current.display(),
        target.display()
    );

    let base = base_data_dir(&app)?;
    std::fs::create_dir_all(&base).map_err(|e| format!("创建默认目录失败: {e}"))?;
    let pointer = serde_json::to_string_pretty(&DataLocation {
        root: target.display().to_string(),
    })
    .map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = base.join("location.json.tmp");
    std::fs::write(&tmp, pointer).map_err(|e| format!("写入位置指针失败: {e}"))?;
    std::fs::rename(&tmp, base.join("location.json"))
        .map_err(|e| format!("替换位置指针失败: {e}"))?;

    Ok(target.display().to_string())
}

// ---------------------------------------------------------------------------
// 图谱导出（HTML / DOCX / PDF / PNG / Markdown / JSON）
// ---------------------------------------------------------------------------

/// 导出目录：登录用户 → users/{id}/exports；游客 → exports
fn export_dir(app: &AppHandle, auth: &AuthState) -> Result<PathBuf, String> {
    let base = app_root(app)?;
    Ok(match current_user_id(auth) {
        Some(uid) => base.join("users").join(uid).join("exports"),
        None => base.join("exports"),
    })
}

/// 文件名净化：去掉路径分隔符与 Windows 保留字符，限长 60 字符
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let limited: String = trimmed.chars().take(60).collect();
    if limited.is_empty() {
        "termask-export".to_string()
    } else {
        limited
    }
}

/// 图谱导出的落盘实现：一次布局 → render_bytes → 原子写（.tmp → rename）。
/// `export_graph_project` 与 `export_graph_docx` 共用，避免两条命令的落盘规则漂移。
/// 与 Tauri 命令 `write_export_file`（通用前端产物落盘）区分：此处只处理图谱渲染字节。
fn write_graph_export_file(
    app: &AppHandle,
    auth: &AuthState,
    project: &GraphProject,
    fmt: export::ExportFormat,
    file_name: Option<String>,
) -> Result<export::ExportResult, String> {
    // 落盘前校验 id：挡住路径穿越字符，与 save_graph_project 的约定一致。
    if !is_safe_id(&project.id) {
        return Err("图谱编号不合法，请先保存图谱后再导出".into());
    }
    let bytes = export::render_bytes(project, fmt)?;

    let dir = export_dir(app, auth)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;

    let stem = match file_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => {
            let without_ext = name
                .rsplit_once('.')
                .map(|(s, _)| s)
                .filter(|s| !s.is_empty())
                .unwrap_or(name);
            sanitize_file_name(without_ext)
        }
        None => sanitize_file_name(&format!(
            "{}-{}",
            project.title,
            export::stamp_for_file(project.updated_at)
        )),
    };
    let path = dir.join(format!("{stem}.{}", fmt.extension()));

    let tmp = path.with_extension(format!("{}.tmp", fmt.extension()));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入导出文件失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换导出文件失败: {e}"))?;

    eprintln!(
        "[export] {} → {}（{} 字节）",
        fmt.extension(),
        path.display(),
        bytes.len()
    );
    Ok(export::ExportResult {
        path: path.display().to_string(),
        format: fmt.extension().to_string(),
        bytes: bytes.len(),
    })
}

/// Tauri Command：把图谱导出为指定格式并落盘，返回文件路径。
///
/// `file_name` 为空时用「标题 + 时间戳」生成；扩展名由格式决定，忽略调用方传入。
#[tauri::command]
fn export_graph_project(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
    project: GraphProject,
    format: String,
    file_name: Option<String>,
) -> Result<export::ExportResult, String> {
    let fmt = export::ExportFormat::parse(&format)?;
    write_graph_export_file(&app, &auth, &project, fmt, file_name)
}

/// 前端导出对话框 docx 选项的专用命令：图谱 JSON → OOXML docx，返回落盘路径。
/// `graph` 同时接受图谱对象与 JSON 字符串，避免前端两种序列化方式造成调用失败。
#[tauri::command]
fn export_graph_docx(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
    graph: serde_json::Value,
    file_name: Option<String>,
) -> Result<String, String> {
    let project = parse_graph_value(graph)?;
    let result = write_graph_export_file(
        &app,
        &auth,
        &project,
        export::ExportFormat::Docx,
        file_name,
    )?;
    Ok(result.path)
}

/// 把前端传来的图谱 JSON 还原成 GraphProject（对象或字符串均可）。
/// 错误统一为面向用户的中文，不把反序列化细节透出。
fn parse_graph_value(value: serde_json::Value) -> Result<GraphProject, String> {
    let parsed = match value {
        serde_json::Value::Object(_) => serde_json::from_value(value),
        serde_json::Value::String(s) => serde_json::from_str(&s),
        _ => return Err("请提供完整的图谱数据".into()),
    };
    parsed.map_err(|_| "图谱数据缺少必要字段或字段类型不符，请重新打开图谱后再导出".into())
}

// ---------------------------------------------------------------------------
// 通用导出落盘（前端渲染产物：白板 PNG/SVG、Canvas blob 等）
//
// 与图谱导出的区别：图谱导出由后端 layout → render_bytes 生成字节；
// 这里接收前端已渲染好的 base64 字节，只负责安全落盘，不参与渲染。
// ---------------------------------------------------------------------------

/// 允许的扩展名（与 `src/lib/bridge-ext.ts` 的契约注释一致）。
const EXPORT_EXTENSIONS: [&str; 8] = [
    "png", "svg", "html", "json", "md", "pdf", "docx", "markdown",
];

/// base64 字符串上限（64 MiB），解码后约 48 MiB，避免单次导出撑爆内存。
const MAX_EXPORT_BASE64_LEN: usize = 64 * 1024 * 1024;

fn is_allowed_export_extension(ext: &str) -> bool {
    EXPORT_EXTENSIONS.contains(&ext)
}

/// 标准 base64 解码（RFC 4648）：支持带 / 不带 `=` 填充，忽略空白字符。
/// 不新增依赖，与项目手写 SHA-256 / ZIP 的风格一致。
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn sextet(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut padding = 0u8;
    for &c in input.as_bytes() {
        if c.is_ascii_whitespace() {
            continue;
        }
        if c == b'=' {
            padding += 1;
            if padding > 2 {
                return Err("导出内容的编码格式不正确".into());
            }
            continue;
        }
        if padding > 0 {
            return Err("导出内容的编码格式不正确".into());
        }
        let Some(v) = sextet(c) else {
            return Err("导出内容的编码格式不正确".into());
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1u32 << bits) - 1;
        }
    }
    Ok(out)
}

/// Tauri Command：把前端生成的导出内容写入 `数据目录/exports/{fileName}`。
///
/// 契约：`write_export_file(fileName, base64Content) -> ExportResult`
/// - `fileName` 过 `is_safe_id`（挡路径穿越）+ 扩展名白名单；
/// - base64 解码后 `.tmp` → `rename` 原子写；目录按登录态隔离；
/// - 返回 `{ path, format, bytes }`，错误为中文可读提示。
#[tauri::command]
fn write_export_file(
    app: AppHandle,
    auth: tauri::State<'_, AuthState>,
    file_name: String,
    base64_content: String,
) -> Result<export::ExportResult, String> {
    let name = file_name.trim();
    if name.is_empty() {
        return Err("请填写导出文件名".into());
    }
    if !is_safe_id(name) {
        return Err("导出文件名不合法，不能包含路径分隔符或连续点号".into());
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s, e.to_ascii_lowercase()),
        _ => return Err("导出文件名缺少扩展名".into()),
    };
    if !is_allowed_export_extension(ext.as_str()) {
        return Err(format!(
            "不支持的导出格式：{ext}（可选 {}）",
            EXPORT_EXTENSIONS.join(" / ")
        ));
    }
    if base64_content.is_empty() {
        return Err("导出内容为空，请重新生成后重试".into());
    }
    if base64_content.len() > MAX_EXPORT_BASE64_LEN {
        return Err("导出内容过大，请缩小画布范围或降低图片精度后重试".into());
    }
    let bytes = decode_base64(&base64_content)?;

    let dir = export_dir(&app, &auth)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
    let safe_stem = sanitize_file_name(stem);
    let path = dir.join(format!("{safe_stem}.{ext}"));
    let tmp = path.with_extension(format!("{ext}.tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入导出文件失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换导出文件失败: {e}"))?;

    eprintln!(
        "[export] 通用落盘 {ext} → {}（{} 字节）",
        path.display(),
        bytes.len()
    );
    Ok(export::ExportResult {
        path: path.display().to_string(),
        format: ext,
        bytes: bytes.len(),
    })
}

// ---------------------------------------------------------------------------
// 自动更新（设置页「检查更新」按钮）
// ---------------------------------------------------------------------------

/// 检查结果（camelCase，前端按字段名读取）。
/// `tauri.conf.json` 的 plugins.updater.endpoints / pubkey 未配置时插件会返回错误，
/// 命令把它转成可读中文提示，不影响应用启动。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
}

#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<UpdateCheckResult, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|_| {
        "更新服务尚未配置：请先在发布设置中填写更新清单地址与签名公钥".to_string()
    })?;
    let update = updater.check().await.map_err(|_| {
        "检查更新失败：无法连接更新服务，或更新清单地址与签名公钥尚未配置。请检查网络与发布设置后重试"
            .to_string()
    })?;

    let current_version = env!("CARGO_PKG_VERSION").to_string();
    match update {
        Some(u) => Ok(UpdateCheckResult {
            available: true,
            current_version,
            latest_version: Some(u.version.to_string()),
            notes: u.body.clone(),
        }),
        None => Ok(UpdateCheckResult {
            available: false,
            current_version,
            latest_version: None,
            notes: None,
        }),
    }
}

#[tauri::command]
async fn install_app_update(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|_| {
        "更新服务尚未配置：请先在发布设置中填写更新清单地址与签名公钥".to_string()
    })?;
    let update = updater.check().await.map_err(|_| {
        "获取更新失败：无法连接更新服务，或更新清单地址与签名公钥尚未配置".to_string()
    })?;
    let Some(update) = update else {
        return Ok("当前已是最新版本，无需更新".into());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|_| "下载或安装更新失败，请检查磁盘空间与网络后重试".to_string())?;
    Ok("更新已下载并安装，请重启应用后生效".into())
}

// ---------------------------------------------------------------------------
// Tauri 入口
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 内存暂存区：桥接服务与 command 共享同一实例（CacheStore 内部按 target 分区）
    let cache = CacheStore::new();
    // 登录态 / 验证码仓（纯内存；登录态另经 session.json 持久化用于重启恢复）
    let auth_state = AuthState::default();
    let code_store = CodeStore::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 目录选择：设置页「修改数据保存地址」用它打开系统文件夹选择器
        .plugin(tauri_plugin_dialog::init())
        // 开机自启：前端经 @tauri-apps/plugin-autostart 的 enable()/disable() 控制，
        // 权限见 src-tauri/capabilities/default.json。
        .plugin(tauri_plugin_autostart::Builder::new().build())
        // 自动更新：检查远端 manifest；未配置 endpoints/pubkey 时 check() 返回可读错误，
        // 不影响应用启动（配置见 tauri.conf.json 的 plugins.updater）。
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 全局快捷键：按下时经 with_handler 向前端 emit "trigger-shortcut" 事件。
        // 注册动作放在 setup 里（见下），失败不 panic、仅告警。
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        // 用实际注册键回传，前端/日志不再假设是 Ctrl+Shift+Q
                        let payload =
                            serde_json::json!({ "shortcut": shortcut.clone().into_string() });
                        if let Err(e) = app.emit("trigger-shortcut", &payload) {
                            eprintln!("[shortcut] emit trigger-shortcut 失败: {e}");
                        }
                    }
                })
                .build(),
        )
        // CacheStore 是单一托管状态：概念区 / 白板区 / 全文快照 / 批量开关都在内部，
        // 不再需要多个同类型 Arc<Mutex<...>>（那是 TypeId 托管 panic 的根源）。
        .manage(cache.clone())
        .manage(auth_state)
        .manage(code_store)
        .setup(move |app| {
            // 初始化图谱存储目录并打印实际路径，便于排查数据落在哪
            // （游客目录；登录用户的目录在注册/登录/恢复会话时创建）
            if let Ok(dir) = app.path().app_data_dir().map(|d| d.join("graphs")) {
                let _ = std::fs::create_dir_all(&dir);
                println!("[graph] 图谱存储目录: {}", dir.display());
            }

            // 桥接安全层：读取/生成 bridge.json（令牌 + 是否强制校验）
            let security = match app.path().app_data_dir() {
                Ok(dir) => security::Security::load(&dir),
                Err(e) => {
                    eprintln!("[security] 无法定位应用数据目录，使用内存令牌: {e}");
                    security::Security::load(Path::new("."))
                }
            };
            // 安全层注册为托管状态，供设置页命令读取令牌 / 切开关
            app.manage(security.clone());

            // 注册全局快捷键：优先用 preferences.json 里保存的用户键，
            // 缺失或注册失败回退 Ctrl+Shift+Q；两者都失败只告警不 panic。
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let preferred = effective_shortcut(app.handle());
                let gs = app.global_shortcut();
                let mut ok = gs.register(preferred.as_str()).is_ok();
                if !ok && preferred != DEFAULT_SHORTCUT {
                    eprintln!("[shortcut] 注册 {preferred} 失败，回退 {DEFAULT_SHORTCUT}");
                    ok = gs.register(DEFAULT_SHORTCUT).is_ok();
                }
                if ok {
                    println!("[shortcut] 已注册全局快捷键");
                } else {
                    eprintln!(
                        "[shortcut] 全局快捷键注册失败（可能被其他程序占用或重复注册，忽略继续）"
                    );
                }
            }

            // 重启恢复登录态：session.json → AuthState。
            // dev 与 release 都走这里——上次退出时处于登录状态，
            // 本次启动前端 getCurrentSession() 即可拿到会话，
            // 随后 load_graph_projects()/load_user_settings() 自动拉取该用户数据。
            if let Some(session) = read_session_file(app.handle()) {
                eprintln!("[auth] 恢复登录会话: {}", session.identifier);
                if let Ok(dir) = user_dir(app.handle(), &session.user_id) {
                    if let Err(e) = std::fs::create_dir_all(dir.join("graphs")) {
                        eprintln!("[auth] 重建用户目录失败: {e}");
                    }
                }
                let auth = app.state::<AuthState>();
                let mut current = match auth.current.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                *current = Some(session);
            }

            // 用 async_runtime::spawn 启动桥接服务，避免脱离 Tokio 运行时
            bridge::spawn(app.handle().clone(), cache.clone(), security);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            test_model_connection,
            analyze_concepts_relationship,
            generate_logic_chain,
            save_graph_project,
            load_graph_projects,
            generate_graph_from_cache,
            analyze_full_context,
            analyze_single_concept,
            // ── 白板（持久化 + AI 批注） ──
            save_whiteboard,
            load_whiteboards,
            ai_annotate_whiteboard,
            // ── 账户系统 ──
            send_verification_code,
            register_account,
            login_account,
            logout_account,
            get_current_session,
            save_user_settings,
            load_user_settings,
            // ── 暂存区 / 批量模式（按 target 分区） ──
            stage_word,
            get_staged_words,
            get_whiteboard_words,
            get_cache_count,
            clear_staged_words,
            clear_cache,
            clear_whiteboard_words,
            get_full_context,
            get_batch_mode,
            set_batch_mode,
            remove_staged_word,
            remove_from_cache,
            remove_whiteboard_word,
            // ── 桥接安全 / 快捷键 ──
            get_bridge_security,
            set_bridge_require_token,
            rotate_bridge_token,
            set_global_shortcut,
            // ── 分类 ──
            get_app_preferences,
            set_auto_classify,
            classify_concepts,
            // ── 数据目录 ──
            get_data_location,
            set_data_location,
            // ── 导出 ──
            export_graph_project,
            // ── 账户（改密） ──
            change_password,
            // ── 前端待办对齐：AI 追问 / docx 导出 / 自动更新 ──
            ask_llm,
            export_graph_docx,
            check_app_update,
            install_app_update,
            // ── SMTP 邮箱验证码 / 快捷键同步 ──
            get_smtp_config,
            set_smtp_config,
            get_global_shortcut,
            // ── 通用导出落盘（前端渲染产物） ──
            write_export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// 单测：新增命令中不依赖 Tauri 运行时与网络的纯函数部分
// ---------------------------------------------------------------------------

#[cfg(test)]
mod command_tests {
    use super::*;

    fn graph_json() -> serde_json::Value {
        serde_json::json!({
            "id": "g-ask",
            "title": "追问验证图谱",
            "templateType": "free",
            "nodes": [],
            "edges": [],
            "summary": "",
            "createdAt": 0,
            "updatedAt": 1_700_000_000_000_u64
        })
    }

    #[test]
    fn parse_graph_value_accepts_object_and_string() {
        let from_object = parse_graph_value(graph_json()).expect("对象形态");
        let raw = serde_json::to_string(&graph_json()).expect("序列化");
        let from_string = parse_graph_value(serde_json::Value::String(raw)).expect("字符串形态");
        assert_eq!(from_object.id, from_string.id);
        assert_eq!(from_object.title, "追问验证图谱");
    }

    #[test]
    fn parse_graph_value_rejects_incomplete_graph() {
        let err = parse_graph_value(serde_json::json!({ "title": "缺字段" }))
            .expect_err("缺字段应报错");
        assert!(err.contains("图谱数据"));
    }

    #[test]
    fn ask_llm_sampling_matches_frontend_contract() {
        assert_eq!(LLM_ASK_TEMPERATURE, 0.3);
        assert!(LLM_ASK_MAX_TOKENS >= 4096);
        assert_eq!(LLM_ASK_TIMEOUT_SECS, 120);
        let default = LlmSampling::default();
        assert_eq!(default.temperature, LLM_TEMPERATURE);
        assert_eq!(default.max_tokens, LLM_MAX_TOKENS);
    }

    #[test]
    fn code_ttl_is_five_minutes() {
        assert_eq!(CODE_TTL_SECS, 300);
        assert!(MOCK_FALLBACK_ENABLED);
    }

    #[test]
    fn smtp_view_never_exposes_password() {
        let cfg = SmtpConfig {
            enabled: true,
            server: "smtp.example.com".into(),
            port: 587,
            username: "noreply@example.com".into(),
            password: "placeholder".into(),
            from_name: String::new(),
            encryption: "starttls".into(),
        };
        let view = cfg.view();
        assert!(view.has_password);
        assert!(!view.mock_mode);
        assert_eq!(view.from_name, DEFAULT_FROM_NAME);
        let json = serde_json::to_string(&view).expect("序列化");
        assert!(!json.contains("placeholder"));
        assert!(!json.contains("\"password\""));
    }

    #[test]
    fn smtp_default_port_follows_encryption() {
        let mut cfg = SmtpConfig::default();
        assert_eq!(cfg.normalized_encryption(), "starttls");
        assert_eq!(cfg.default_port(), 587);
        assert!(!cfg.is_ready());
        cfg.encryption = "ssl".into();
        assert_eq!(cfg.default_port(), 465);
    }

    #[test]
    fn shortcut_defaults_to_ctrl_shift_q() {
        assert_eq!(DEFAULT_SHORTCUT, "Ctrl+Shift+Q");
        assert_eq!(AppPreferences::default().global_shortcut, None);
    }

    #[test]
    fn base64_decode_standard_vectors() {
        assert_eq!(decode_base64("TWFu").unwrap(), b"Man");
        assert_eq!(decode_base64("TWE=").unwrap(), b"Ma");
        assert_eq!(decode_base64("TQ==").unwrap(), b"M");
        assert_eq!(decode_base64("TWFu\n").unwrap(), b"Man");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert!(decode_base64("TWF@").is_err());
        assert!(decode_base64("T=Q=").is_err());
        assert!(decode_base64("TQ===").is_err());
    }

    #[test]
    fn export_extension_whitelist_and_filename_guard() {
        assert!(is_allowed_export_extension("png"));
        assert!(is_allowed_export_extension("markdown"));
        assert!(is_allowed_export_extension("svg"));
        assert!(!is_allowed_export_extension("exe"));
        assert!(!is_allowed_export_extension(""));
        assert!(is_safe_id("board.png"));
        assert!(!is_safe_id("../board.png"));
        assert!(!is_safe_id("a\\b.png"));
        assert_eq!(MAX_EXPORT_BASE64_LEN, 64 * 1024 * 1024);
    }
}
