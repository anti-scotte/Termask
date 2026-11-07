# 前端许可证（LICENSE for the Front-End）

> 适用范围：TermAsk Workbench 前端代码，即 `src/` 目录与 `extensions/term-ask/` 中的前端部分。
> 后端（`src-tauri/`）与仓库总体许可证由后端部分文档提供；本文档只约束前端。

---

## 1. TermAsk 前端自有代码：MIT License

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

## 2. 第三方组件声明（Third-Party Notices）

前端依赖的第三方库遵循其各自许可证。以下列出**带有额外合规义务**的组件，使用本项目的前端构建产物时请一并遵守：

### tldraw（白板画布）
- 许可证：tldraw 自定义许可（允许商业与非商业使用，**必须保留画布上的 "Made with tldraw" 水印**；去除水印需购买 tldraw 商业授权）。
- 本项目的合规方式：`WhiteboardPage.tsx` 以默认配置渲染 tldraw，未隐藏水印，代码注释中亦保留许可证说明。
- 上游：<https://github.com/tldraw/tldraw>

### React Flow / @xyflow/react（图谱画布）
- 许可证：MIT，但 xyflow 官方**请求保留画布上的 "React Flow" attribution 标记**（商用去标记需购买 Pro 订阅）。
- 本项目的合规方式：未设置 `proOptions={{ hideAttribution: true }}`，默认 attribution 保留在概念图谱画布上。
- 上游：<https://github.com/xyflow/xyflow>

### MIT 许可的其余主要依赖（无额外义务，仅附署名）
- React / React DOM —— Meta 与社区（MIT）
- Tailwind CSS / tailwind-merge / tw-animate-css —— Tailwind Labs 等（MIT）
- Radix UI 基础件（dialog / select / label / slot）—— WorkOS（MIT）
- Zustand —— Poimandres（MIT）
- lucide-react —— Lucide Contributors（ISC）
- react-router-dom —— Remix（MIT）
- react-rnd —— b4stien 等（MIT）
- clsx / class-variance-authority —— Joe Bell / shadcn（MIT/Apache-2.0）
- Vite / TypeScript —— 社区（MIT/Apache-2.0）
- @tauri-apps/* —— Tauri Programme within The Commons Conservancy（MIT/Apache-2.0）

> 完整清单以 `package.json` 与 `npm ls --production` 输出为准；上述列表覆盖直接依赖，传递依赖的许可证可在 npm 安装产物中查验。

---

## 3. 使用者注意事项

1. **再分发**：以本项目前端构建产物（含 tldraw / React Flow 的页面）再分发或部署时，请勿移除上述两个画布的水印/attribution，除非自行取得对应商业授权。
2. **修改声明**：对本项目前端代码的修改版，请保留本文件与原始版权声明（MIT 第 2、3 条）。
3. **字体**：导出功能中由后端使用的系统中文字体（如微软雅黑/黑体）随用户操作系统分发，其授权不在本项目范围内。
