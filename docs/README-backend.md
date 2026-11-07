# TermAsk Workbench 后端（src-tauri/）

> 划词即学习 —— 桌面工作台背后唯一持有「状态 + 凭证 + 磁盘」的一层。
> 版本：**v0.1.0**（开源发布版） · 适用范围：`termask-workbench/src-tauri/`
> 配套文档（链接按仓库内文件位置书写）：仓库根 [README.md](../README.md)（产品全景）· [前端项目介绍书](./前端项目介绍书.md) · [后端项目介绍书](./后端项目介绍书.md) · [前端许可证](./LICENSE-frontend.md) · [后端与仓库总体许可证](./LICENSE-backend.md)

TermAsk 是一个桌面端知识整理工作台：浏览器划词 → 本机 HTTP 桥接 → 内存暂存区 → 桌面工作台 → 大模型整理成概念图谱 → 本地 JSON 落盘。后端负责桥接服务、Tauri 命令、LLM 三协议调用、账户与数据落盘、导出渲染与落盘，是三端契约的收敛点。

---

## 1. 边界：什么属于后端

| 属于后端（本文档） | 不属于后端 |
| --- | --- |
| `src-tauri/` Rust 源码、`Cargo.toml`、`tauri.conf.json`、`capabilities/default.json`、`examples/` | `src/` 前端页面、状态与共享类型（见前端项目介绍书） |
| 本机桥接服务（`127.0.0.1:17570`，11 条 HTTP 路由） | `extensions/term-ask/` 浏览器插件（前端范围，另见前端文档） |
| 50 个 Tauri 命令、LLM 调用、账户、JSON 落盘、导出渲染 | 前端 WebView 渲染与交互细节 |

> 前端不直接读写数据文件、不直连远程模型服务（LLM 调用一律经后端命令）；浏览器扩展不直接写磁盘。所有数据只落本机，凭证只在后端与用户所选模型服务之间传输。

---

## 2. 架构与数据流

```text
浏览器扩展（WXT / MV3）
   │  HTTP → 127.0.0.1:17570（仅本机；限流 → Origin 白名单 → 令牌 → 安全响应头）
   ▼
src-tauri/ 后端
   ├─ bridge.rs     Axum 路由与事件广播（不写业务规则、不落盘）
   ├─ cache.rs      CacheStore 单例（graph / whiteboard / full_context / batch_mode）
   ├─ security.rs   Origin 白名单、令牌、限流
   ├─ classify.rs   LLM 概念分类 + 启发式兜底
   ├─ export.rs     布局 → SVG → 六格式渲染
   └─ lib.rs        领域类型、LLM 单一入口、账户、存储、Tauri 命令、入口装配
   │  Tauri IPC（invoke / 事件）
   ▼
桌面工作台（React WebView）
   │
   ▼
用户自配的大模型（OpenAI 兼容 / Anthropic / Ollama）← reqwest（仅后端发起）
```

依赖方向：`bridge → cache/security`；`lib → 全部`；`classify/export` 只依赖 `lib` 的公开类型与 LLM 入口。

---

## 3. 功能全景（v0.1.0，后端侧）

### 3.1 本机 HTTP 桥接（11 条路由）

`GET /health` · `GET /api/bridge-info` · `POST /api/concept-graph` · `POST /api/add-to-graph` · `GET /api/get-cache-count` · `GET /api/staged-words` · `GET /api/whiteboard-words` · `POST /api/remove-last` · `POST /api/remove-word` · `POST /api/clear-cache` · `GET / POST /api/batch-mode`

请求体上限 2 MiB；解析失败按实际原因返回 413 / 422，不再一律 422。网页来源（`https://...`）一律 403，仅放行扩展协议、Tauri 协议与 dev server。

### 3.2 Tauri 命令（50 个）

| 分组 | 数量 | 代表命令 |
| --- | --- | --- |
| 模型与生成 | 8 | `generate_graph_from_cache`、`analyze_concepts_relationship`、`save_graph_project` |
| 白板 | 3 | `save_whiteboard`、`load_whiteboards`、`ai_annotate_whiteboard` |
| 账户 | 8 | `register_account`、`login_account`、`change_password`、`send_verification_code` |
| 暂存区 / 模式 | 13 | `stage_word`、`get_staged_words`、`clear_cache`、`set_batch_mode` |
| 分类 / 偏好 | 3 | `classify_concepts`、`get_app_preferences`、`set_auto_classify` |
| 数据目录 | 2 | `get_data_location`、`set_data_location` |
| 导出落盘 | 2 | `export_graph_project`、`write_export_file` |
| 安全 / 快捷键 | 5 | `rotate_bridge_token`、`set_global_shortcut`、`get_global_shortcut` |
| 前端待办对齐 | 4 | `ask_llm`、`export_graph_docx`、`check_app_update`、`install_app_update` |
| SMTP 邮箱验证码 | 2 | `get_smtp_config`、`set_smtp_config` |

全部命令注册在 `generate_handler!`；跨端结构体统一 `#[serde(rename_all = "camelCase")]`；错误文案为中文、面向用户、不含内部堆栈。

### 3.3 能力与数据

- **LLM**：`call_llm_text` / `call_llm_text_with_timeout` 是唯一入口，支持 `openai-compatible` / `anthropic` / `ollama` 三种协议；模型输出「能救则救」（多字段名兜底、空连线自动串联、分类失败整批降级）。
- **导出**：一次布局多载体，`render_svg()` 是唯一图形渲染器；HTML / PNG / PDF / DOCX / Markdown / JSON 六格式，PDF 依赖系统 TTF 中文字体并嵌入子集，DOCX 由手写 ZIP + WordprocessingML 生成，无 Office 依赖。
- **账户**：盐 + 10000 轮 SHA-256、8–64 位密码策略、连续 5 次失败锁定 60 秒、统一错误文案防账号枚举；验证码有效期 5 分钟，真实邮件由 SMTP 配置驱动，未配置或投递失败回退 MOCK 备用模式。
- **落盘**：本地 JSON + `.tmp` → `rename` 原子写；`id` 过 `is_safe_id`；目录按登录态隔离（`users/{user_id}/...` 或游客根目录）；数据目录可迁移到空目录，复制成功后才切换指针。
- **系统能力**：开机自启动、全局快捷键（默认 `Ctrl+Shift+Q`，持久化到 `preferences.json`）、文件对话框、应用更新检查与安装。

---

## 4. 快速开始

环境要求：Rust edition 2024 工具链（Tauri v2）、Node.js（前端构建）、系统 TrueType 中文字体（PDF / PNG 导出）。

```bash
# 后端编译（独立 target 目录，避免与 tauri dev 抢增量编译锁）
cd src-tauri
CARGO_TARGET_DIR=target-check CARGO_INCREMENTAL=0 cargo check --message-format=short

# 库单测
CARGO_TARGET_DIR=target-check CARGO_INCREMENTAL=0 cargo test --lib

# 导出冒烟：不依赖前端、不读用户数据；无图谱文件时自动使用内置示例
CARGO_TARGET_DIR=target-check cargo run --example export_demo -- target-check/export-sample

# 前端类型（改过跨端契约必跑）
cd .. && npx tsc --noEmit

# 桌面端启动
npm run tauri dev
```

桥接探活：`curl http://127.0.0.1:17570/health`、`curl http://127.0.0.1:17570/api/bridge-info`。

**v0.1.0 实测基线**：`cargo check` 0 error / 0 warning；`cargo test --lib` 24 passed；`npx tsc --noEmit` 通过；`export_demo` 生成 HTML 5332 B、PNG 69615 B、PDF 34967 B、DOCX 1865 B、MD 954 B、JSON 1518 B。**应用启动、命令真实调用、真实邮件投递、快捷键运行时注册未做端到端验证**。判定后端改动完成的最小标准见后端项目介绍书 §10。

---

## 5. 目录速览

```text
src-tauri/
├── src/
│   ├── lib.rs         领域类型、LLM、账户、存储、Tauri 命令与入口（约 3.6k 行）
│   ├── bridge.rs      Axum 路由 / 事件广播（约 330 行）
│   ├── cache.rs       CacheStore 暂存区单例（约 340 行）
│   ├── security.rs    Origin 白名单 / 令牌 / 限流（约 300 行）
│   ├── classify.rs    概念分类与容错解析（约 290 行）
│   ├── export.rs      布局与六格式渲染（约 780 行）
│   └── main.rs        桌面入口
├── examples/           export_demo.rs（导出冒烟工具）
├── capabilities/       default.json（插件权限声明）
├── tauri.conf.json     窗口、CSP、bundle、plugins.updater
└── Cargo.toml          依赖与构建配置
```

前端契约权威源：`src/lib/bridge-ext.ts`（新增命令包装）；`src/types/index.ts` 为共享类型。后端核对契约以当前版 `bridge-ext.ts` 为准。

---

## 6. 隐私与安全

- 桥接端口只监听 `127.0.0.1`；网页来源一律 403；可开启令牌校验防本机伪造 Origin 的进程。
- 所有用户数据（图谱、白板、设置、账户、会话）保存在本机，不上传任何服务器；数据目录可由用户在设置中迁移。
- 模型 API Key、SMTP 授权码、桥接令牌均由用户自行配置，不写入代码、文档、日志或提交信息；SMTP 配置读取接口对授权码脱敏。
- 当前已知风险：SMTP 授权码以明文落在 `smtp.json`（建议改用应用专用授权码并收紧文件权限）；未配置 SMTP 时 MOCK 备用模式会把验证码回传前端，不适合正式找回密码场景。

---

## 7. 已知限制（v0.1.0）

| 级别 | 限制 | 影响 |
| --- | --- | --- |
| P1 | `plugins.updater.endpoints` / `pubkey` 为空，缺签名私钥与 `createUpdaterArtifacts` | 更新命令只能返回可读中文提示，无法真正拉取更新；刻意不编造发布基础设施 |
| P1 | MOCK 备用模式仍启用 | 未配置 SMTP 或投递失败时验证码回传前端，无法防撞库；正式环境应配置 SMTP 并关闭备用 |
| P1 | 真实邮件投递与快捷键运行时注册未端到端验证 | 代码与单测齐备，缺真机回归 |
| P1 | PDF 仅文本排版，且依赖系统 TTF 字体 | 不含图形化图谱；微软雅黑是 `.ttc` 不可用，会回退黑体 / 楷体 |
| P2 | 导出目录固定、暂存区纯内存、`lib.rs` 仍偏大 | 不能逐次选路径；重启丢词；后续可拆 `llm.rs` / `auth.rs` / `storage.rs` |

完整限制清单与变更历史见 `docs/8-后端工程状态-2026-11-05.md`。

---

## 8. 许可证

- **后端（`src-tauri/`）与仓库总体**：MIT，全文见 [LICENSE-backend.md](./LICENSE-backend.md)。
- **前端（`src/`、`extensions/term-ask/` 前端代码）**：MIT，全文与第三方组件声明见 [LICENSE-frontend.md](./LICENSE-frontend.md)。再分发含 tldraw / React Flow 的构建产物时，须同时遵守该文件列出的水印与 attribution 义务。
- 第三方 Rust crate 的许可证以各自上游声明为准，见 LICENSE-backend.md §2。

---

## 9. 版本

**v0.1.0**：首个开源发布版。50 个 Tauri 命令、11 条桥接路由、六格式导出、SMTP 邮箱验证码、全局快捷键持久化、数据目录迁移、应用更新命令框架。GitHub / Gitee 双平台发布流程见 [后端项目介绍书](./后端项目介绍书.md) §11。
