//! 本地 HTTP 桥接服务（Axum，仅监听 127.0.0.1:17570）
//!
//! 职责：接收浏览器扩展推送的划词词条 / 概念图，转成 Tauri 事件给前端，
//! 同时把词条写入内存暂存区（`CacheStore`）。
//!
//! 安全：所有请求先过 `security::guard`（限流 → Origin 白名单 → 可选令牌）。

use std::collections::HashMap;

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Query, State},
    http::{header, Method, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::cache::{CacheStore, StagedWord, Target};
use crate::security::{self, Security};

/// 桥接服务端口（扩展侧 fetch("http://127.0.0.1:17570/...")）
pub const BRIDGE_PORT: u16 = 17570;
/// 请求体上限：全文快照 5000 字 + JSON 包装，2 MiB 已有充足余量
const BODY_LIMIT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct BridgeState {
    app: AppHandle,
    cache: CacheStore,
}

fn parse_target(params: &HashMap<String, String>) -> Target {
    params
        .get("target")
        .map(|t| Target::parse(t))
        .unwrap_or(Target::Graph)
}

/// 按 target 广播对应事件（图谱 → staged-word；白板 → whiteboard-word）
fn emit_word(app: &AppHandle, target: Target, word: &StagedWord) {
    let event = match target {
        Target::Graph => "staged-word",
        Target::Whiteboard => "whiteboard-word",
    };
    if let Err(e) = app.emit(event, word) {
        eprintln!("[bridge] emit {event} failed: {e}");
    }
}

async fn health() -> &'static str {
    "ok"
}

/// GET /api/bridge-info —— 供扩展探活与能力协商（不含令牌本身）
async fn bridge_info() -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "service": "termask-workbench",
        "version": env!("CARGO_PKG_VERSION"),
        "routes": ROUTES,
    }))
}

/// GET /api/batch-mode —— 批量学习模式开关状态
async fn get_batch_mode_state(State(state): State<BridgeState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "enabled": state.cache.batch_mode() }))
}

/// POST /api/batch-mode {"enabled": bool} —— 插件快捷键回推
async fn set_batch_mode_state(
    State(state): State<BridgeState>,
    payload: Result<Json<serde_json::Value>, JsonRejection>,
) -> Response {
    let enabled = match payload {
        Ok(Json(v)) => v.get("enabled").and_then(|b| b.as_bool()),
        Err(err) => {
            eprintln!("[bridge] batch-mode 解析失败: {err}");
            return (err.status(), format!("解析失败: {err}")).into_response();
        }
    };
    match enabled {
        Some(b) => {
            state.cache.set_batch_mode(b);
            Json(serde_json::json!({ "enabled": b })).into_response()
        }
        None => (StatusCode::BAD_REQUEST, "缺少 enabled 布尔字段").into_response(),
    }
}

/// GET /api/get-cache-count?target=graph|whiteboard
async fn bridge_cache_count(
    State(state): State<BridgeState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let target = parse_target(&params);
    Json(serde_json::json!({ "count": state.cache.count(target) }))
}

/// GET /api/staged-words?target=graph|whiteboard —— 权威列表（崩溃后重载用）
async fn staged_words(
    State(state): State<BridgeState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Vec<StagedWord>> {
    Json(state.cache.words(parse_target(&params)))
}

/// GET /api/whiteboard-words —— 兼容旧调用（等价 target=whiteboard）
async fn whiteboard_words(State(state): State<BridgeState>) -> Json<Vec<StagedWord>> {
    Json(state.cache.words(Target::Whiteboard))
}

/// POST /api/concept-graph —— 扩展推送概念关系 → 转发前端事件
async fn receive_concept_graph(
    State(state): State<BridgeState>,
    payload: Result<Json<serde_json::Value>, JsonRejection>,
) -> Response {
    let data = match payload {
        Ok(Json(data)) => data,
        Err(err) => {
            eprintln!(
                "[bridge] JSON 解析失败: {err} | body={}",
                err.body_text()
            );
            return (err.status(), format!("解析失败: {err}")).into_response();
        }
    };
    match state.app.emit("concept-graph", &data) {
        Ok(_) => StatusCode::ACCEPTED.into_response(),
        Err(e) => {
            eprintln!("[bridge] emit concept-graph failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// POST /api/add-to-graph —— 划词词条入暂存区（按 target 分发）
async fn add_staged_word(
    State(state): State<BridgeState>,
    payload: Result<Json<StagedWord>, JsonRejection>,
) -> Response {
    let word = match payload {
        Ok(Json(w)) => w,
        Err(err) => {
            eprintln!(
                "[bridge] add-to-graph 解析失败: {err} | body={}",
                err.body_text()
            );
            return (err.status(), format!("解析失败: {err}")).into_response();
        }
    };

    let outcome = match state.cache.push(word) {
        Ok(o) => o,
        Err(msg) => return (StatusCode::BAD_REQUEST, msg).into_response(),
    };

    // 全文快照：先发 full-context（新版前端按需监听），再发 staged-word 驱动 chip
    if outcome.is_full_context {
        if let Some(ctx) = state.cache.full_context() {
            if let Err(e) = state.app.emit("full-context", &ctx) {
                eprintln!("[bridge] emit full-context failed: {e}");
            }
            let chars = ctx
                .context_text
                .as_ref()
                .map(|t| t.chars().count())
                .unwrap_or(0);
            emit_word(&state.app, Target::Graph, &outcome.word);
            return (
                StatusCode::ACCEPTED,
                format!("全文快照已就绪待分析（{chars} 字）"),
            )
                .into_response();
        }
    }

    emit_word(&state.app, outcome.target, &outcome.word);

    let msg = match outcome.target {
        Target::Graph => {
            if outcome.is_new {
                format!("已暂存，当前共 {} 个词", outcome.len)
            } else {
                format!("已更新该词上下文，当前共 {} 个词", outcome.len)
            }
        }
        Target::Whiteboard => {
            if outcome.is_new {
                format!("已暂存到白板收集区，当前共 {} 条", outcome.len)
            } else {
                format!("已更新白板词条，当前共 {} 条", outcome.len)
            }
        }
    };
    (StatusCode::ACCEPTED, msg).into_response()
}

/// POST /api/remove-last?target= —— 删除最后一个普通词条并广播事件
async fn remove_last_staged_word(
    State(state): State<BridgeState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let target = parse_target(&params);
    match state.cache.pop_last(target) {
        Some(word) => {
            if let Err(e) = state.app.emit("staged-word-removed", &word) {
                eprintln!("[bridge] emit staged-word-removed failed: {e}");
            }
            let left = state.cache.count(target);
            (StatusCode::OK, format!("已删除最后一个词：{}（剩余 {left}）", word.term)).into_response()
        }
        None => (StatusCode::OK, "暂存区为空，无可删除").into_response(),
    }
}

/// POST /api/remove-word {"target","term"} —— 删除指定词条，返回权威列表
async fn remove_word(
    State(state): State<BridgeState>,
    payload: Result<Json<serde_json::Value>, JsonRejection>,
) -> Response {
    let v = match payload {
        Ok(Json(v)) => v,
        Err(err) => return (err.status(), format!("解析失败: {err}")).into_response(),
    };
    let target = Target::parse(v.get("target").and_then(|t| t.as_str()).unwrap_or("graph"));
    let term = v.get("term").and_then(|t| t.as_str()).unwrap_or("").trim();
    if term.is_empty() {
        return (StatusCode::BAD_REQUEST, "term 不能为空").into_response();
    }
    Json(state.cache.remove_term(target, term)).into_response()
}

/// POST /api/clear-cache?target= —— 清空指定分区，返回空列表
async fn clear_cache(
    State(state): State<BridgeState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let target = parse_target(&params);
    Json(state.cache.clear(target)).into_response()
}

/// 启动桥接服务。必须跑在 Tauri 的 Tokio runtime 上（`tauri::async_runtime::spawn`），
/// 否则 `tokio::net::TcpListener` 会 panic `there is no reactor running`。
pub fn spawn(app: AppHandle, cache: CacheStore, security: Security) {
    tauri::async_runtime::spawn(async move {
        let cors = CorsLayer::new()
            .allow_origin(AllowOrigin::predicate(|origin, _req_parts| {
                origin
                    .to_str()
                    .map(security::origin_is_allowed)
                    .unwrap_or(false)
            }))
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers([
                header::CONTENT_TYPE,
                header::HeaderName::from_static(crate::security::TOKEN_HEADER),
            ])
            .max_age(std::time::Duration::from_secs(600));

        let state = BridgeState {
            app,
            cache,
        };

        let router = Router::new()
            .route("/health", get(health))
            .route("/api/bridge-info", get(bridge_info))
            .route("/api/concept-graph", post(receive_concept_graph))
            .route("/api/add-to-graph", post(add_staged_word))
            .route("/api/get-cache-count", get(bridge_cache_count))
            .route("/api/staged-words", get(staged_words))
            .route("/api/whiteboard-words", get(whiteboard_words))
            .route("/api/remove-last", post(remove_last_staged_word))
            .route("/api/remove-word", post(remove_word))
            .route("/api/clear-cache", post(clear_cache))
            .route(
                "/api/batch-mode",
                get(get_batch_mode_state).post(set_batch_mode_state),
            )
            .with_state(state)
            .layer(DefaultBodyLimit::max(BODY_LIMIT_BYTES))
            .layer(cors)
            .layer(middleware::from_fn_with_state(
                security.clone(),
                security::guard,
            ));

        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], BRIDGE_PORT));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[bridge] bind {addr} failed: {e}（端口被占用？）");
                return;
            }
        };

        println!(
            "[bridge] listening on http://{addr}（Origin 白名单{}，令牌校验{}）",
            "开启",
            if security.require_token() { "开启" } else { "关闭" }
        );
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[bridge] server error: {e}");
        }
    });
}

/// 供测试/文档使用的路由清单（避免文档与实现漂移）
#[derive(Debug, Serialize)]
pub struct RouteInfo {
    pub method: &'static str,
    pub path: &'static str,
}

pub const ROUTES: [RouteInfo; 11] = [
    RouteInfo { method: "GET", path: "/health" },
    RouteInfo { method: "GET", path: "/api/bridge-info" },
    RouteInfo { method: "POST", path: "/api/concept-graph" },
    RouteInfo { method: "POST", path: "/api/add-to-graph" },
    RouteInfo { method: "GET", path: "/api/get-cache-count" },
    RouteInfo { method: "GET", path: "/api/staged-words" },
    RouteInfo { method: "GET", path: "/api/whiteboard-words" },
    RouteInfo { method: "POST", path: "/api/remove-last" },
    RouteInfo { method: "POST", path: "/api/remove-word" },
    RouteInfo { method: "POST", path: "/api/clear-cache" },
    RouteInfo { method: "GET|POST", path: "/api/batch-mode" },
];
