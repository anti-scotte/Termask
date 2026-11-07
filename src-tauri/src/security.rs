//! 本地桥接服务的安全层
//!
//! 威胁模型（本机、仅监听 127.0.0.1）：
//! 1. 任意网页用 JS 向 `http://127.0.0.1:17570` 发跨域请求，污染暂存区或读取用户划词内容
//!    —— 浏览器会带上 `Origin`，这是最容易发生的真实攻击面；
//! 2. 本机其它进程（含恶意脚本）直接 HTTP 请求 —— 可伪造 `Origin`，只能靠令牌拦；
//! 3. 请求体过大 / 高频打爆桥接线程；
//! 4. 敏感内容被下游缓存或 MIME 嗅探。
//!
//! 对应措施：
//! - **Origin 白名单**（默认开启）：只放行扩展协议与 Tauri/开发服务器自身；
//! - **安全令牌**（可选开启，`bridge.json` 持久化，扩展侧可配置）：
//!   `X-TermAsk-Token` 头恒定时间比对，挡住本机伪造 Origin 的进程；
//! - **固定窗口限流**：10 秒内超过阈值直接 429，防止失控循环把桥接打死；
//! - **统一响应头**：`nosniff` + `no-store`。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

/// 扩展/工作台携带令牌的请求头
pub const TOKEN_HEADER: &str = "x-termask-token";
/// 限流窗口
const RATE_WINDOW: Duration = Duration::from_secs(10);
/// 单窗口内允许的请求数（正常使用：划词 + 轮询，远低于此值）
const RATE_MAX_REQUESTS: usize = 600;
/// 允许的 Origin 前缀（扩展）
const EXTENSION_SCHEMES: [&str; 4] = [
    "chrome-extension://",
    "moz-extension://",
    "safari-web-extension://",
    "extension://",
];
/// 允许的 Origin 精确匹配（Tauri 自定义协议 + 开发服务器）
const ALLOWED_ORIGINS: [&str; 6] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "http://localhost:3001",
];

/// 落盘形态（`app_data_dir/bridge.json`）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeConfigFile {
    token: String,
    #[serde(default)]
    require_token: bool,
}

#[derive(Debug, Clone)]
struct Config {
    token: String,
    require_token: bool,
}

struct RateState {
    window_start: Instant,
    hits: VecDeque<Instant>,
}

/// 桥接安全层（Tauri managed state，同时作为 axum 中间件状态）
#[derive(Clone)]
pub struct Security {
    config: Arc<Mutex<Config>>,
    file: Arc<PathBuf>,
    rate: Arc<Mutex<RateState>>,
}

impl Security {
    /// 读取或初始化 `bridge.json`（令牌缺失/为空时自动生成并落盘）
    pub fn load(app_data_dir: &Path) -> Self {
        let file = app_data_dir.join("bridge.json");
        let mut config = std::fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<BridgeConfigFile>(&raw).ok())
            .unwrap_or_else(|| BridgeConfigFile {
                token: String::new(),
                require_token: false,
            });

        if config.token.trim().is_empty() {
            config.token = generate_token();
        }

        let security = Self {
            config: Arc::new(Mutex::new(Config {
                token: config.token.clone(),
                require_token: config.require_token,
            })),
            file: Arc::new(file.clone()),
            rate: Arc::new(Mutex::new(RateState {
                window_start: Instant::now(),
                hits: VecDeque::new(),
            })),
        };
        security.persist(&config.token, config.require_token);
        security
    }

    fn persist(&self, token: &str, require_token: bool) {
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let body = serde_json::to_string_pretty(&BridgeConfigFile {
            token: token.to_string(),
            require_token,
        })
        .unwrap_or_default();
        let _ = std::fs::write(self.file.as_path(), body);
    }

    pub fn token(&self) -> String {
        self.config.lock().map(|c| c.token.clone()).unwrap_or_default()
    }

    pub fn require_token(&self) -> bool {
        self.config
            .lock()
            .map(|c| c.require_token)
            .unwrap_or(false)
    }

    /// 前端设置页开关：开启后扩展必须携带令牌才能写入桥接
    pub fn set_require_token(&self, enabled: bool) -> bool {
        let token = self.token();
        if let Ok(mut cfg) = self.config.lock() {
            cfg.require_token = enabled;
        }
        self.persist(&token, enabled);
        eprintln!(
            "[security] 桥接令牌校验：{}",
            if enabled { "已开启" } else { "已关闭" }
        );
        enabled
    }

    /// 重新生成令牌（旧令牌立即失效，扩展需重新配对）
    pub fn rotate_token(&self) -> String {
        let token = generate_token();
        let require = self.require_token();
        if let Ok(mut cfg) = self.config.lock() {
            cfg.token = token.clone();
        }
        self.persist(&token, require);
        eprintln!("[security] 桥接令牌已轮换");
        token
    }

    /// 固定窗口限流：超阈值返回 false
    fn allow_request(&self) -> bool {
        let now = Instant::now();
        let mut state = match self.rate.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if now.duration_since(state.window_start) >= RATE_WINDOW {
            state.window_start = now;
            state.hits.clear();
        }
        while let Some(front) = state.hits.front() {
            if now.duration_since(*front) > RATE_WINDOW {
                state.hits.pop_front();
            } else {
                break;
            }
        }
        if state.hits.len() >= RATE_MAX_REQUESTS {
            return false;
        }
        state.hits.push_back(now);
        true
    }
}

fn generate_token() -> String {
    // 无额外 crate：以时间 + 进程 + 地址熵做 SHA-256，取 32 字节 hex 前 32 位
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let stack_probe = &now as *const u128 as usize;
    let seed = format!("termask-bridge:{now}:{pid}:{stack_probe}");
    let digest = crate::sha256(seed.as_bytes());
    crate::hex_encode(&digest[..16])
}

/// Origin 是否在白名单内
pub fn origin_is_allowed(origin: &str) -> bool {
    let origin = origin.trim();
    if origin.is_empty() || origin == "null" {
        // 无 Origin：curl / 本机原生客户端（令牌是这一类的防线）；
        // "null"：sandbox iframe / file:// 页面 —— 一律拒绝
        return origin.is_empty();
    }
    if ALLOWED_ORIGINS
        .iter()
        .any(|o| o.eq_ignore_ascii_case(origin))
    {
        return true;
    }
    EXTENSION_SCHEMES
        .iter()
        .any(|scheme| origin.to_ascii_lowercase().starts_with(scheme))
}

/// 恒定时间字符串比较（避免按字节短路泄露前缀）
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// axum 中间件：限流 → Origin → 令牌 → 附加安全响应头
pub async fn guard(State(security): State<Security>, req: Request, next: Next) -> Response {
    // CORS 预检交给 CorsLayer 处理，安全层不参与
    if req.method() == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }

    if !security.allow_request() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "请求过于频繁：本地桥接已限流，请稍后重试",
        )
            .into_response();
    }

    let path = req.uri().path().to_string();
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !origin_is_allowed(origin) {
        eprintln!("[security] 拒绝来源 Origin={origin} path={path}");
        return (StatusCode::FORBIDDEN, "来源不被允许").into_response();
    }

    // /health 永远放行（探活不需要令牌），其余 /api 在开启校验后必须带令牌
    let needs_token = path.starts_with("/api/") && security.require_token();
    if needs_token {
        let presented = req
            .headers()
            .get(TOKEN_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !constant_time_eq(presented, &security.token()) {
            eprintln!("[security] 令牌校验失败 path={path} origin={origin}");
            return (StatusCode::UNAUTHORIZED, "缺少或错误的桥接令牌").into_response();
        }
    }

    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_rules() {
        assert!(origin_is_allowed("chrome-extension://abcdef"));
        assert!(origin_is_allowed("tauri://localhost"));
        assert!(origin_is_allowed("http://localhost:1420"));
        assert!(origin_is_allowed("")); // 本机原生客户端
        assert!(!origin_is_allowed("https://evil.example"));
        assert!(!origin_is_allowed("null"));
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }
}
