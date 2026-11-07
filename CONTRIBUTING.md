# 贡献指南（Contributing to TermAsk Workbench）

感谢你愿意为 TermAsk 做贡献。本指南覆盖 `v0.1.0` 开源版本的本地开发环境、三端（前端 / 后端 / 浏览器插件）分别启动方式，以及提交 Pull Request 的规范。

> 项目由三部分组成：`src/` 前端工作台（React + Vite）、`src-tauri/` 后端（Tauri v2 / Rust）、`extensions/term-ask/` 浏览器插件（WXT / MV3）。
> 两份许可证并行：前端与插件见 [LICENSE-frontend.md](./docs/LICENSE-frontend.md)；后端与仓库总体见 [LICENSE-backend.md](./docs/LICENSE-backend.md)。
> 后端配套文档：[README-backend.md](./docs/README-backend.md) · [后端项目介绍书](./docs/后端项目介绍书.md)。
> 提交贡献即表示你同意按对应 MIT 许可证授权你的代码。

---

## 1. 本地开发环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11（x86_64） | v0.1.0 的主要验证平台；CI 使用 `windows-latest`。macOS / Linux 未纳入发布流水线 |
| **Node.js** | **≥ 20.19.0，推荐 22 LTS**；npm ≥ 10 | 前端使用 Vite 8（rolldown-vite），不支持 Node 18 与 20.0–20.18。若根 `package.json` 声明了 `engines`，以其为准 |
| **Rust** | **stable ≥ 1.85.0** | `src-tauri/Cargo.toml` 使用 `edition = "2024"`，需要 rustc 1.85+；通过 [rustup](https://rustup.rs) 安装，目标三元组 `x86_64-pc-windows-msvc` |
| **VS C++ Build Tools** | Visual Studio 2022「**使用 C++ 的桌面开发**」工作负载 | 需包含 MSVC v143 生成工具、Windows 10/11 SDK、C++ CMake 工具。Tauri 在 Windows 上编译 Rust 依赖与生成安装包时必需 |
| WebView2 Runtime | Windows 11 及较新 Windows 10 通常已内置 | 桌面端 WebView 运行时；缺失时从微软官方安装 Evergreen Runtime |
| 系统中文字体 | TrueType 中文字体（黑体 / 楷体等） | PDF / PNG 导出依赖；微软雅黑是 `.ttc`，代码会自动回退 |
| 浏览器 | Chrome / Edge（支持 MV3） | 以「加载已解压的扩展程序」方式调试插件 |
| 建议编辑器 | VS Code + rust-analyzer、Tauri、ESLint、Tailwind CSS IntelliSense | 非强制 |

验证工具链：

```bash
node -v
npm -v
rustc -V
cargo -V
rustup target list --installed
```

> **不要提交的内容**：`smtp.json`、`bridge.json`、`account.json`、`session.json`、`location.json`，以及 `graphs/`、`whiteboards/`、`exports/` 下的运行期用户数据。任何 API Key、SMTP 授权码、桥接令牌、更新签名私钥或密码都**不得**写入代码、文档、日志、Issue 或提交信息。

---

## 2. 首次克隆与依赖安装

```bash
git clone <你的仓库地址>
cd termask-workbench
npm ci                    # 根依赖：前端 + Tauri CLI，使用 package-lock.json

# 浏览器插件有独立的 package.json，需单独安装
cd extensions/term-ask
npm ci
cd ../..
```

> 若 `npm ci` 因 lock 文件与 `package.json` 不一致而失败，请先在本地执行 `npm install` 并把更新后的 `package-lock.json` 一并提交，不要绕过 lock 文件。

---

## 3. 分别启动前端、后端、插件

### 3.1 仅启动前端（Vite dev server）

```bash
cd termask-workbench
npm run dev               # http://localhost:1420
npx tsc --noEmit          # 类型检查（strict）
npm run build             # 生产构建，产物 dist/
```

`npm run dev` 与 `npm run build` 也是 `src-tauri/tauri.conf.json` 中 `beforeDevCommand` / `beforeBuildCommand` 所调用的命令。

> 单独启动前端时**没有 Rust 后端在场**：所有 `invoke` 调用、桥接数据与导出落盘不可用，UI 会走能力探测降级。需要完整功能请使用 3.2 的 `npm run tauri dev`。

### 3.2 启动后端 / 完整桌面应用

纯后端验证（不启动 WebView，不占用前端端口）：

```bash
cd termask-workbench/src-tauri

# 独立 target 目录，避免与正在运行的 `tauri dev` 抢增量编译锁
CARGO_TARGET_DIR=target-check CARGO_INCREMENTAL=0 cargo check --message-format=short
CARGO_TARGET_DIR=target-check CARGO_INCREMENTAL=0 cargo test --lib

# 导出冒烟：不依赖前端、不读用户数据；无图谱文件时自动使用内置示例
CARGO_TARGET_DIR=target-check cargo run --example export_demo -- target-check/export-sample
```

完整桌面应用（同时拉起前端 dev server 与 Tauri 窗口）：

```bash
cd termask-workbench
npm run tauri dev
```

桥接服务随应用启动，探活：

```bash
curl http://127.0.0.1:17570/health
curl http://127.0.0.1:17570/api/bridge-info
```

> `cargo check` 出现 `os error 5` 增量锁警告时，说明 `tauri dev` 正持有编译锁。使用上面的 `CARGO_TARGET_DIR=target-check` 与 `CARGO_INCREMENTAL=0` 绕开；**不要杀进程**。

### 3.3 启动浏览器插件（WXT / MV3）

```bash
cd termask-workbench/extensions/term-ask
npm run dev               # WXT 开发模式（HMR），产物 .output/chrome-mv3/
npm run build             # 生产构建
npm run zip               # 打包成可上传的 zip（若该目录定义了此脚本）
```

未定义 `scripts` 时可直接使用 WXT CLI：`npx wxt`、`npx wxt build`、`npx wxt zip`。**以 `extensions/term-ask/package.json` 中的 `scripts` 为最终准绳。**

调试方式：打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3`。

> 插件通过 `127.0.0.1:17570` 把词条推给后端。桥接安全层只放行扩展协议、Tauri 协议与 dev server；普通网页来源（`https://...`）一律返回 403。若推送失败，先确认桌面应用已启动且 `/health` 可访问。

### 3.4 三端联调顺序

1. `npm run tauri dev`（后端 + 前端一起起来）；
2. `extensions/term-ask` 目录执行 `npm run dev`，在浏览器加载已解压扩展；
3. 在网页中划词 → 观察工作台概念收集区是否出现词条；
4. 涉及导出的改动，再跑一次 `export_demo` 确认六格式产物齐全。

---

## 4. 代码与契约纪律

这些是本项目特有的约束，违反后很难在 Code Review 之外被发现：

1. **跨端结构体一律 camelCase**：Rust 侧 `#[serde(rename_all = "camelCase")]`，漏写不会报错，只会让前端字段全变 `undefined`。
2. **暂存区是单例**：`CacheStore` 按 `target`（graph / whiteboard）分区；Tauri 托管状态按 `TypeId` 索引，不要新增第二个同类型 `.manage()`，会 panic。
3. **桥接只信任白名单来源**：新增桥接路由自动继承安全层，但必须同步更新 `bridge.rs` 的 `ROUTES` 常量。
4. **LLM 唯一入口**：`call_llm_text` / `call_llm_text_with_timeout`（`lib.rs`）；三种协议 `openai-compatible` / `anthropic` / `ollama`；不要另起 HTTP 逻辑。
5. **模型输出「能救则救」**：宽容解析、空连线自动串联、分类失败整批降级本地规则，不要改回严格解析。
6. **导出「一次布局，多载体」**：`render_svg()` 是唯一图形渲染器；前端渲染产物走 `write_export_file` 落盘，后端不参与渲染。
7. **新增 Tauri 命令必须加入 `generate_handler!`**；错误信息用中文、面向用户、不含内部堆栈。
8. **写盘必须原子写**（`.tmp` → `rename`）并校验 `id`（`is_safe_id`，挡 `..`、`/`、`\`）；目录按登录态隔离。
9. **契约权威源**：`src/lib/bridge-ext.ts`（新增命令）与 `src/types/index.ts`（共享类型）。任何命令增删改都要同步前者注释。
10. **协作纪律**：前后端常被不同会话并行修改，动 `src/**` 前先看文件修改时间；**禁止整文件覆盖写**，落笔前先读最新内容再做精确替换；不执行删除命令；不擅自升级依赖大版本，新增依赖须说明理由与体积影响；改动后同步 `docs/8-后端工程状态-2026-11-05.md` 的命令清单、已知限制、变更日志。

---

## 5. 提交与 PR 规范

### 5.1 分支

从默认分支新建，命名 `<type>/<scope>-<简述>`：

```
feat/backend-add-export-route
fix/bridge-origin-guard
docs/release-guide
refactor/export-layout
```

`type` 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `ci`。

### 5.2 Commit message

采用 Conventional Commits，建议中文描述：

```
feat(backend): 新增 write_export_file 通用落盘命令
fix(bridge): 修正 413/422 状态码判定
docs: 补充 v0.1.0 贡献指南
ci(release): tag 触发 Windows Draft Release
```

`scope` 建议：`frontend` / `backend` / `bridge` / `extension` / `export` / `docs` / `ci`。**提交信息中不得出现任何凭证值。**

### 5.3 提交前检查清单

- [ ] `cd src-tauri && CARGO_TARGET_DIR=target-check CARGO_INCREMENTAL=0 cargo check --message-format=short` — **0 error / 0 warning**
- [ ] `CARGO_TARGET_DIR=target-check CARGO_INCREMENTAL=0 cargo test --lib` — **24 passed / 0 failed**（新增测试后数字应变大）
- [ ] `npx tsc --noEmit` — 通过
- [ ] `npm run build` — 前端生产构建通过
- [ ] 改动导出时：`cargo run --example export_demo -- target-check/export-sample` 六格式产物齐全
- [ ] 改动跨端字段时：已同步 `src/lib/bridge-ext.ts` 与 `src/types/index.ts`
- [ ] 新增命令已进 `generate_handler!`；新增路由已进 `ROUTES`
- [ ] 新增依赖已说明理由与体积影响；无大版本升级
- [ ] 已更新 `docs/8` 的命令清单 / 已知限制 / 变更日志
- [ ] 工作区不含运行期数据文件与任何凭证

> 判定「后端改动完成」的最小标准：`cargo check` 零警告 + `cargo test` 全绿 + **应用能启动** + **改动的命令有一次真实调用**。仅跑单测不足以结案。

### 5.4 PR 描述

请在 PR 描述中按四段写清楚：

1. **结论**：这个 PR 做了什么，一句话。
2. **改动**：文件路径 + 关键改动点（逐条）。
3. **验证**：实际执行的命令与结果；**没验证就写「未验证」**，不要写「大概」「应该可以」。
4. **风险与后续**：未覆盖的边界、需要前端 / 插件配合的接口、建议的下一步。

另需：关联 Issue（如 `Closes #12`）；UI 改动附截图或录屏；跨端字段变更明确列出新旧字段名。

### 5.5 Review 与合并

- 不直接向默认分支 push；通过 PR 合入。
- CI 通过 + 至少一位维护者 Review 批准后方可合并；推荐 squash merge。
- 后端 PR 不得顺带修改 `src/**` 前端文件；前端 PR 不得顺带改 `src-tauri/`。无法避免时拆成两个 PR。
- 发现前端行为与后端契约不一致时，记录到 `docs/8` 的「契约变更」小节，由对应一侧处理，不越界改对方代码。

---

## 6. 报告 Bug 与发布

- Bug 请使用 [`.github/ISSUE_TEMPLATE/bug_report.md`](./.github/ISSUE_TEMPLATE/bug_report.md) 模板，附系统环境、复现步骤与截图；**粘贴日志前请删除所有凭证**。
- 推送 `v*` 格式的 tag（如 `v0.1.0`）会触发 [`.github/workflows/release.yml`](./.github/workflows/release.yml)，在 Windows 上构建 Tauri 安装包并创建 **Draft Release**。v0.1.0 未配置更新清单 URL、签名公钥与签名私钥，因此 Release 不带更新签名产物。
- GitHub 与 Gitee 双平台使用同一 commit 与同一 tag；Gitee 为镜像同步，需发布方手动执行，本工作流只发布 GitHub Release。
