# 后端与仓库总体许可证（LICENSE for the Back-End）

> 适用范围：TermAsk Workbench 后端代码（`src-tauri/`）以及仓库总体（构建配置、脚本、文档、示例）。\
> 前端代码（`src/`、`extensions/term-ask/` 中的前端部分）适用 [LICENSE-frontend.md](./LICENSE-frontend.md)，本文档不重复约束前端。\
> 版本：v0.1.0 · 配套：[README-backend.md](./README-backend.md)、[后端项目介绍书](./后端项目介绍书.md)

---

## 1. 许可证适用范围对照

| 范围 | 路径 | 适用文件 |
| --- | --- | --- |
| 后端 Rust 源码与配置 | `src-tauri/`（含 `src/`、`examples/`、`capabilities/`、`Cargo.toml`、`tauri.conf.json`） | **本文件，MIT** |
| 仓库总体（根配置、构建脚本、文档） | 仓库根与 `docs/` | **本文件，MIT** |
| 前端应用与浏览器插件前端代码 | `src/`、`extensions/term-ask/` | `LICENSE-frontend.md`（MIT + 第三方组件声明） |

> 两份许可证对各自范围内的自有代码均采用 MIT，版权声明一致；差异只在**第三方组件合规义务**——前端侧的 tldraw 水印与 React Flow attribution 义务见 `LICENSE-frontend.md` §2，后端侧的 Rust 依赖声明见本文件 §2。

---

## 2. TermAsk 后端自有代码：MIT License

Copyright (c) 2026 TermAsk contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## 3. 第三方组件声明（Third-Party Notices）

后端通过 `src-tauri/Cargo.toml` 引入下列直接依赖。各组件遵循其**上游自带许可证**；本文件不逐项断言具体许可证类型，完整合规清单以 `Cargo.lock`、`cargo tree` 输出以及各 crate 随附的 LICENSE 文件为准。

| 类别 | 直接依赖 |
| --- | --- |
| 桌面框架 | `tauri 2`、`tauri-build 2`、`tauri-plugin-opener`、`tauri-plugin-autostart`、`tauri-plugin-global-shortcut`、`tauri-plugin-dialog`、`tauri-plugin-updater` |
| 异步与网络 | `tokio 1`、`reqwest 0.12`、`axum 0.8`、`tower-http 0.6` |
| 序列化 | `serde 1`、`serde_json 1` |
| 导出渲染 | `printpdf 0.7`（font_subsetting）、`resvg 0.49`、`flate2 1`、`crc32fast 1` |
| 邮件投递 | `lettre 0.11`（`default-features=false`，仅 `builder` / `smtp-transport` / `rustls-tls`） |

补充要点：

1. **纯 Rust TLS**：`lettre` 关闭默认特性，未引入系统 OpenSSL 依赖；其传递依赖（rustls 相关）同样以各自上游许可证为准。
2. **系统字体**：PDF / PNG 导出使用操作系统自带的中文字体（如黑体、楷体），字体随操作系统分发，其授权**不在本项目授权范围内**，亦不随本仓库再分发。
3. **前端第三方义务随二进制一起生效**：Tauri 打包产物内嵌前端 WebView 资源。再分发桌面安装包时，须一并遵守 `LICENSE-frontend.md` §2 列出的 tldraw「Made with tldraw」水印保留义务与 React Flow attribution 保留义务，除非自行取得对应商业授权。
4. **更新签名材料**：`tauri-plugin-updater` 已接入，但 v0.1.0 未提供更新清单 URL、签名公钥与签名私钥。任何第三方不得以本项目名义生成或分发带签名的更新包；正式启用条件见后端项目介绍书 §9、§11。

---

## 4. 使用者注意事项

1. **再分发**：以桌面安装包或源码形式再分发时，请同时保留本文件、`LICENSE-frontend.md` 与仓库根 README 中的版权与许可证说明（MIT 第 2、3 条）。
2. **修改声明**：对本仓库后端代码的修改版，请保留原始版权声明与本许可全文；建议在发行说明中标注修改内容，但 MIT 不强制要求。
3. **凭证自管**：模型 API Key、SMTP 授权码、桥接令牌、更新签名私钥均由使用者自行配置与保管。本项目源码、文档、日志与示例不包含任何凭证值；使用者不得将自有凭证写入公开仓库或提交信息。
4. **运行期数据**：`smtp.json`、`bridge.json`、`account.json`、`session.json`、`location.json` 以及 `graphs/` / `whiteboards/` / `exports/` 下的用户数据属于本机运行期数据，**不得随源码提交或打包进开源产物**（发布前校验清单见后端项目介绍书 §11.2）。
5. **无担保**：本软件按「现状」提供，导出 PDF / PNG 依赖系统字体、更新功能依赖发布基础设施、SMTP 邮件依赖使用者自有邮箱服务，相关可用性不在本许可担保范围内。
6. **名称与标识**：使用「TermAsk」名称或标识不构成商标授权；派生项目请避免使用易被误认为官方发布的名称与图标。

---

## 5. 发布口径（v0.1.0）

GitHub 与 Gitee 双平台使用同一 commit 与同一 tag `v0.1.0`，Release 产物一致。本文件与 `LICENSE-frontend.md` 必须同时随两个平台的仓库与 Release 分发。完整发布前校验清单、更新签名启用条件见 [后端项目介绍书](./后端项目介绍书.md) §11。
