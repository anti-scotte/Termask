# TermAsk Workbench

> 划词即学习 —— 浏览器插件 + 本地桥接 + 桌面工作台的知识助读工具。

## 这为谁而做

我们为两类被「概念过载」折磨的学习者打造 TermAsk：

1. **日常在网页端与免费大模型对话的知识型问答用户**：大模型生成的概念常常超出当前认知，越问越懵，认知过载之后学习动力随之丧失。
2. **考研党、科研人员与重度阅读者**：读文献、读教材时被专业领域的复杂概念反复打断，手动搜索每一个词的过程极其折磨——既消耗精力，又摧毁效率。

在这些场景中，学习体验往往极差。TermAsk 把「遇到不懂的词 → 搜索 → 理解 → 回到原文」这条断裂的链路，压缩成「划词 → 即时助读 → 结构化沉淀」：

如果用户能用我们的工具提高学习效率、获得舒适的学习体验，这个工具就算成功了。

## 功能全景（v0.1.0）

### 浏览器插件（extensions/term-ask，WXT / MV3）
- 任意网页划词：**加入图谱 / 生成解释 / 上下文分析 / 加入白板** 四功能
- 全文抓取快照、批量划词模式（静默自动收集）
- 词条经本地桥接实时推送到工作台（127.0.0.1，仅本机）

### 概念图谱（React Flow）
- 五套模板：自由发散 / 树状逻辑图 / 逻辑链 / 工业流程图 / 韦恩图，新图自动铺开可填充概念框，各模板拥有专属形状与图标语义
- 连线：规整折线（90° 圆弧可调，默认）/ 自由曲线 / 直线 / GoodNotes 压感随手写；动态特效可开关
- 节点工具栏：拉线连线 / AI 连线（模型生成关系词）/ AI 解释 / AI 上下文分析 / 删除；右键菜单同源
- 词库收纳区：五类词语自动归类（专业名词 / 学术用语 / 工程用语 / 民间科普 / 自定义笔记），单击入图
- 一键生成：逻辑链 / 工业流程图（收集区词汇 → 模型编排）
- AI 追问区：提问模板导入 + 自由问答
- 图谱质量测验：把图谱投喂给模型检验可读性，记录评分与用时
- 导出：JSON / Markdown(含 mermaid) / HTML / PNG / PDF / docx（后端渲染落盘，按纸张边框裁剪）

### 白板（tldraw）
- 多页白板文档：页签切换、页码角标可选、每页独立画布类型与背景模板
- 画布类型：无限 / A4 / 适应屏幕；背景模板：空白 / 网格 / 康奈尔笔记 / 产婆术引导 / 导入模板
- 手写笔三笔型（钢笔 / 水笔 / 荧光笔）+ 调色盘悬浮窗
- 一键清屏、纸张边框、收集区词条拖入即贴、AI 批注助读
- 导出：PNG / SVG / JSON / Markdown / HTML

### 工作台基建
- 模板管理（提示词模板 CRUD，内置 3 个默认模板）、模型设置（OpenAI 兼容 / Anthropic / Ollama 自配）
- 账户系统（本机注册登录，数据按用户隔离）+ SMTP 真实邮件验证码
- 设置三分区：通用（开机自启动 / 自动更新 / 数据目录迁移 / 桥接安全 / SMTP）/ 个性化（氛围背景 / 连线偏好 / 导出格式）/ 专区（默认模板 / 批量划词）
- 应用内快捷键：N 新增词汇框 / B 纸张边框 / Q AI 追问 / E 导出 / T 质量测验

## 架构

```
浏览器扩展 (WXT/MV3)
   │  HTTP → 127.0.0.1:17570（仅本机）
   ▼
Tauri 2 (Rust) 本地桥 + 数据落盘（登录按用户隔离）
   │  Tauri 事件 / invoke
   ▼
桌面工作台 (React 19 + React Flow + tldraw)
   │  reqwest
   ▼
你自配的大模型（OpenAI 兼容 / Anthropic / Ollama）
```

- 前端：`src/` —— 详见 **[docs/前端项目介绍书.md](./docs/前端项目介绍书.md)**
- 后端：`src-tauri/`（Tauri 2 / Rust，本地 JSON 原子写，文档由后端部分提供）
- 扩展：`extensions/term-ask`（WXT / MV3）

## 开发

```bash
# 前端类型检查 + 生产构建（后端无需在场即可验证）
npx tsc --noEmit
npx vite build

# 桌面端开发
cd src-tauri && cargo check
npm run tauri dev
```

## 目录速览

```
termask-workbench/
├── src/
│   ├── pages/            # 五大页面（Templates/Graph/Whiteboard/Models/Settings）
│   ├── components/       # graph/ 白板 whiteboard/ 通用 ui/
│   ├── lib/              # bridge.ts(既有命令) bridge-ext.ts(新增契约权威源) 导出/模板/笔迹
│   ├── stores/           # Zustand：graph/model/prefs/settings/template/wordLibrary/auth
│   └── types/            # 前后端共享类型（与 Rust serde camelCase 一一对应）
├── src-tauri/            # Rust 后端（另有文档）
├── docs/                 # 设计与交接文档、前端项目介绍书、前端 LICENSE
└── extensions/           # 浏览器插件
```

## 隐私与安全

- 所有数据（图谱、白板、设置、账户）保存在本机，可在设置中迁移数据目录；
- 模型凭证由用户自配，仅在本机与所选模型服务之间传输；
- 桥接端口只监听 `127.0.0.1`，可开启令牌校验（设置 → 通用 → 桥接安全）。

## 文档导航

| 文档 | 内容 | 读者 |
|---|---|---|
| [docs/前端项目介绍书.md](./docs/前端项目介绍书.md) | 前端架构 / 模块职责 / 契约层 / 关键设计 | 前端开发者 |
| [docs/README-backend.md](./docs/README-backend.md) | 后端（Tauri v2 / Rust）说明 | 后端开发者 |
| [docs/后端项目介绍书.md](./docs/后端项目介绍书.md) | 后端架构 / 命令清单 / 数据落盘 / 导出渲染 | 后端开发者 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 三端本地启动 / PR 规范 | 贡献者 |
| [docs/LICENSE-frontend.md](./docs/LICENSE-frontend.md) · [docs/LICENSE-backend.md](./docs/LICENSE-backend.md) | 双许可证与第三方组件声明（tldraw / React Flow 水印义务） | 全部 |
| `docs/1-…10-*.md` | 设计与交接过程文档（工程决议 / 故障排查 / 安全加固） | 维护者 |

## 许可证

- **前端与插件**（`src/`、`extensions/term-ask/` 前端代码）：MIT，全文与第三方组件声明见 [docs/LICENSE-frontend.md](./docs/LICENSE-frontend.md)；
- **后端与仓库总体**：见 [docs/LICENSE-backend.md](./docs/LICENSE-backend.md)。

## 版本

- **v0.1.0**：首个开源发布版。插件四功能 + 工作台五页面（模板管理 / 概念图谱 / 白板 / 模型设置 / 设置）。
