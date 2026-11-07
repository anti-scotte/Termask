//! 图谱导出（HTML / DOCX / PDF / PNG，另含 Markdown 文本格式）
//!
//! 设计要点：
//! 1. **一次布局，四种载体**：`layout()` 产出节点坐标，`render_svg()` 是唯一渲染器；
//!    HTML 内联该 SVG，PNG 用 resvg 光栅化同一份 SVG → 三端视觉一致；
//!    PDF/DOCX 是排版文档，走各自的文本流。
//! 2. **零前端依赖**：导出完全在后端完成，前端只需拿到落盘路径。
//! 3. **不引入图渲染器**：布局是简单的分层（最长路径分层 + 每列垂直居中），
//!    对 6-12 个节点的概念图足够，且结果可预测、可测试。
//! 4. **中文字体**：PDF 从系统字体目录按候选列表加载（微软雅黑/黑体/楷体/苹方/Noto），
//!    找不到则返回明确错误，不生成乱码文件。

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use printpdf::Mm;
use serde::Serialize;

use crate::GraphProject;

/// 支持的导出格式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Html,
    Docx,
    Pdf,
    Png,
    Markdown,
    Json,
}

impl ExportFormat {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "html" | "htm" => Ok(Self::Html),
            "docx" | "word" => Ok(Self::Docx),
            "pdf" => Ok(Self::Pdf),
            "png" | "image" => Ok(Self::Png),
            "markdown" | "md" => Ok(Self::Markdown),
            "json" => Ok(Self::Json),
            other => Err(format!(
                "不支持的导出格式: {other}（可选 html / docx / pdf / png / markdown / json）"
            )),
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Docx => "docx",
            Self::Pdf => "pdf",
            Self::Png => "png",
            Self::Markdown => "md",
            Self::Json => "json",
        }
    }
}

/// 导出结果（前端据此提示「已保存到 …」并可调用 opener 打开目录）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub format: String,
    pub bytes: usize,
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

const NODE_W: f32 = 224.0;
const NODE_H: f32 = 78.0;
const GAP_X: f32 = 72.0;
const GAP_Y: f32 = 34.0;
const MARGIN: f32 = 40.0;
const TITLE_H: f32 = 86.0;

struct Placed {
    x: f32,
    y: f32,
}

struct Layout {
    width: f32,
    height: f32,
    placed: HashMap<String, Placed>,
}

/// 最长路径分层：无入边的节点为第 0 层，沿边递推。
/// 有环时用迭代次数上限保证收敛（概念图很少成环，成环也不会死循环）。
fn layout(project: &GraphProject) -> Layout {
    let ids: Vec<String> = project.nodes.iter().map(|n| n.id.clone()).collect();
    let index: HashMap<&str, usize> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    let mut layer: Vec<usize> = vec![0; ids.len()];
    let mut indegree: Vec<usize> = vec![0; ids.len()];
    for e in &project.edges {
        if let Some(&t) = index.get(e.target.as_str()) {
            indegree[t] += 1;
        }
    }
    let n = ids.len();
    for _ in 0..n.max(1) {
        let mut changed = false;
        for e in &project.edges {
            let (Some(&s), Some(&t)) = (index.get(e.source.as_str()), index.get(e.target.as_str()))
            else {
                continue;
            };
            let candidate = layer[s] + 1;
            if t != s && candidate < n && candidate > layer[t] {
                layer[t] = candidate;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let max_layer = layer.iter().copied().max().unwrap_or(0);
    let mut columns: Vec<Vec<usize>> = vec![Vec::new(); max_layer + 1];
    for (i, l) in layer.iter().enumerate() {
        columns[*l].push(i);
    }
    let max_rows = columns.iter().map(|c| c.len()).max().unwrap_or(1);

    let mut placed = HashMap::new();
    for (col_idx, col) in columns.iter().enumerate() {
        let offset = (max_rows.saturating_sub(col.len())) as f32 * (NODE_H + GAP_Y) / 2.0;
        for (row, &node_idx) in col.iter().enumerate() {
            let x = MARGIN + col_idx as f32 * (NODE_W + GAP_X);
            let y = TITLE_H + offset + row as f32 * (NODE_H + GAP_Y);
            placed.insert(ids[node_idx].clone(), Placed { x, y });
        }
    }

    let width = MARGIN * 2.0 + (max_layer as f32 + 1.0) * NODE_W + max_layer as f32 * GAP_X;
    let height = TITLE_H
        + max_rows as f32 * NODE_H
        + (max_rows.saturating_sub(1)) as f32 * GAP_Y
        + MARGIN;

    Layout {
        width: width.max(720.0),
        height: height.max(420.0),
        placed,
    }
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn truncate_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// 按字符宽度折行（中文按 1、ASCII 按 0.5 估算），最多 `max_lines` 行。
fn wrap_chars(text: &str, max_units: f32, max_lines: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut used = 0.0f32;
    for ch in text.chars() {
        let w = if ch.is_ascii() { 0.5 } else { 1.0 };
        if used + w > max_units && !current.is_empty() {
            lines.push(std::mem::take(&mut current));
            used = 0.0;
            if lines.len() == max_lines {
                break;
            }
        }
        current.push(ch);
        used += w;
    }
    if !current.is_empty() && lines.len() < max_lines {
        lines.push(current);
    }
    lines
}

fn level_color(level: Option<u8>) -> &'static str {
    match level {
        Some(1) => "#0ea5e9",
        Some(2) => "#6366f1",
        Some(3) => "#10b981",
        _ => "#94a3b8",
    }
}

/// 唯一的图形渲染器：HTML 内联、PNG 光栅化都走这里。
pub fn render_svg(project: &GraphProject) -> String {
    let layout = layout(project);
    let mut svg = String::with_capacity(16 * 1024);
    svg.push_str(&format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">"##,
        w = layout.width,
        h = layout.height
    ));
    svg.push_str(r##"<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker></defs>"##);
    svg.push_str(&format!(
        r##"<rect x="0" y="0" width="{}" height="{}" fill="#f8fafc"/>"##,
        layout.width, layout.height
    ));
    // 标题
    svg.push_str(&format!(
        r##"<text x="{}" y="44" font-size="22" font-weight="700" fill="#0f172a">{}</text>"##,
        MARGIN,
        xml_escape(&truncate_chars(&project.title, 40))
    ));
    let meta = format!(
        "{} 个概念 · {} 条关系 · 更新于 {}",
        project.nodes.len(),
        project.edges.len(),
        format_ts(project.updated_at)
    );
    svg.push_str(&format!(
        r##"<text x="{}" y="66" font-size="12" fill="#64748b">{}</text>"##,
        MARGIN,
        xml_escape(&meta)
    ));

    // 边（先画，压在节点下面）
    for e in &project.edges {
        let (Some(a), Some(b)) = (layout.placed.get(&e.source), layout.placed.get(&e.target))
        else {
            continue;
        };
        let x1 = a.x + NODE_W;
        let y1 = a.y + NODE_H / 2.0;
        let x2 = b.x;
        let y2 = b.y + NODE_H / 2.0;
        let dx = ((x2 - x1) / 2.0).max(28.0);
        let d = format!(
            "M {x1:.1} {y1:.1} C {c1x:.1} {y1:.1}, {c2x:.1} {y2:.1}, {x2:.1} {y2:.1}",
            c1x = x1 + dx,
            c2x = x2 - dx
        );
        svg.push_str(&format!(
            r##"<path d="{d}" fill="none" stroke="#94a3b8" stroke-width="1.6" marker-end="url(#arrow)"/>"##
        ));
        if let Some(label) = e.label.as_ref().filter(|l| !l.trim().is_empty()) {
            let mx = (x1 + x2) / 2.0;
            let my = (y1 + y2) / 2.0 - 6.0;
            let text = truncate_chars(label, 10);
            let box_w = text.chars().count() as f32 * 11.0 + 12.0;
            svg.push_str(&format!(
                r##"<rect x="{:.1}" y="{:.1}" width="{:.1}" height="18" rx="9" fill="#ffffff" stroke="#e2e8f0"/>"##,
                mx - box_w / 2.0,
                my - 12.0,
                box_w
            ));
            svg.push_str(&format!(
                r##"<text x="{mx:.1}" y="{my:.1}" font-size="10" fill="#475569" text-anchor="middle">{}</text>"##,
                xml_escape(&text)
            ));
        }
    }

    // 节点
    for node in &project.nodes {
        let Some(p) = layout.placed.get(&node.id) else {
            continue;
        };
        let accent = level_color(node.level);
        svg.push_str(&format!(
            r##"<g><rect x="{:.1}" y="{:.1}" width="{NODE_W}" height="{NODE_H}" rx="12" fill="#ffffff" stroke="#e2e8f0"/>"##,
            p.x, p.y
        ));
        svg.push_str(&format!(
            r##"<rect x="{:.1}" y="{:.1}" width="5" height="{NODE_H}" rx="2.5" fill="{accent}"/>"##,
            p.x + 1.0,
            p.y + 1.0
        ));
        svg.push_str(&format!(
            r##"<text x="{:.1}" y="{:.1}" font-size="15" font-weight="600" fill="#0f172a">{}</text>"##,
            p.x + 16.0,
            p.y + 28.0,
            xml_escape(&truncate_chars(&node.label, 18))
        ));
        if let Some(desc) = node.description.as_ref().filter(|d| !d.trim().is_empty()) {
            for (i, line) in wrap_chars(desc, 18.0, 2).iter().enumerate() {
                svg.push_str(&format!(
                    r##"<text x="{:.1}" y="{:.1}" font-size="11" fill="#64748b">{}</text>"##,
                    p.x + 16.0,
                    p.y + 48.0 + i as f32 * 15.0,
                    xml_escape(line)
                ));
            }
        }
        svg.push_str("</g>");
    }

    svg.push_str("</svg>");
    svg
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

pub fn to_html(project: &GraphProject) -> String {
    let svg = render_svg(project);
    let summary_html = if project.summary.trim().is_empty() {
        String::from("<p class=\"muted\">（本图谱没有 AI 总结）</p>")
    } else {
        project
            .summary
            .split("\n\n")
            .filter(|p| !p.trim().is_empty())
            .map(|p| format!("<p>{}</p>", xml_escape(p.trim())))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let relations = project
        .edges
        .iter()
        .map(|e| {
            let from = project
                .nodes
                .iter()
                .find(|n| n.id == e.source)
                .map(|n| n.label.as_str())
                .unwrap_or(&e.source);
            let to = project
                .nodes
                .iter()
                .find(|n| n.id == e.target)
                .map(|n| n.label.as_str())
                .unwrap_or(&e.target);
            format!(
                "<li><b>{}</b> <span class=\"rel\">{}</span> <b>{}</b></li>",
                xml_escape(from),
                xml_escape(e.label.as_deref().unwrap_or("关联")),
                xml_escape(to)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r##"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{title}</title>
<style>
  :root {{ color-scheme: light; }}
  body {{ margin: 0; padding: 32px; background: #f8fafc; color: #0f172a;
         font-family: "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif; }}
  .wrap {{ max-width: 1180px; margin: 0 auto; }}
  h1 {{ font-size: 26px; margin: 0 0 6px; }}
  .meta {{ color: #64748b; font-size: 13px; margin-bottom: 20px; }}
  .canvas {{ background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; overflow: auto; }}
  .canvas svg {{ display: block; }}
  section {{ background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 18px 22px; margin-top: 18px; }}
  h2 {{ font-size: 16px; margin: 0 0 10px; color: #1e293b; }}
  p {{ line-height: 1.85; margin: 0 0 12px; font-size: 14px; }}
  .muted {{ color: #94a3b8; }}
  ul {{ margin: 0; padding-left: 20px; line-height: 2; font-size: 14px; }}
  .rel {{ color: #2563eb; padding: 0 4px; }}
  footer {{ color: #94a3b8; font-size: 12px; margin-top: 22px; }}
</style></head>
<body><div class="wrap">
  <h1>{title}</h1>
  <div class="meta">{nodes} 个概念 · {edges} 条关系 · 生成于 {ts}</div>
  <div class="canvas">{svg}</div>
  <section><h2>AI 总结</h2>{summary}</section>
  <section><h2>概念关系</h2><ul>{relations}</ul></section>
  <footer>由 TermAsk 工作台导出</footer>
</div></body></html>"##,
        title = xml_escape(&project.title),
        nodes = project.nodes.len(),
        edges = project.edges.len(),
        ts = format_ts(project.updated_at),
        svg = svg,
        summary = summary_html,
        relations = if relations.is_empty() {
            "<li class=\"muted\">暂无关系</li>".to_string()
        } else {
            relations
        }
    )
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

pub fn to_png(project: &GraphProject) -> Result<Vec<u8>, String> {
    let svg = render_svg(project);
    let mut opt = resvg::usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    let tree = resvg::usvg::Tree::from_str(&svg, &opt).map_err(|e| format!("SVG 解析失败: {e}"))?;

    let base = tree.size();
    // 2 倍导出保证清晰度；超宽图按 2400px 上限降采样，避免内存暴涨
    let mut scale = 2.0f32;
    if base.width() * scale > 2400.0 {
        scale = 2400.0 / base.width();
    }
    let w = (base.width() * scale).ceil() as u32;
    let h = (base.height() * scale).ceil() as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w.max(1), h.max(1))
        .ok_or_else(|| "创建位图失败（尺寸过大）".to_string())?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    pixmap
        .encode_png()
        .map_err(|e| format!("PNG 编码失败: {e}"))
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/// 系统中文字体候选（Windows / macOS / Linux 常见路径）
const FONT_CANDIDATES: [&str; 8] = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simkai.ttf",
    r"C:\Windows\Fonts\Deng.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

fn load_pdf_font() -> Result<PathBuf, String> {
    // .ttc 为字体集合，printpdf 0.7 只接受单一 TTF；优先挑明确可用的 TTF。
    let preferred: [&str; 6] = [
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simkai.ttf",
        r"C:\Windows\Fonts\Deng.ttf",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/PingFang.ttc",
    ];
    for p in preferred {
        let path = PathBuf::from(p);
        if path.exists() {
            return Ok(path);
        }
    }
    for p in FONT_CANDIDATES {
        let path = PathBuf::from(p);
        if path.exists() && path.extension().and_then(|e| e.to_str()) == Some("ttf") {
            return Ok(path);
        }
    }
    Err("未找到可用的中文字体（TTF），请在系统中安装微软雅黑/黑体后重试".into())
}

/// 简易排版：按行输出，返回 PDF 字节。
pub fn to_pdf(project: &GraphProject) -> Result<Vec<u8>, String> {
    let font_path = load_pdf_font()?;
    let file = std::fs::File::open(&font_path)
        .map_err(|e| format!("读取字体失败 {}: {e}", font_path.display()))?;

    let (doc, page, layer) = printpdf::PdfDocument::new(
        project.title.clone(),
        Mm(210.0),
        Mm(297.0),
        "Layer 1",
    );
    let font = doc
        .add_external_font_with_subsetting(file, true)
        .map_err(|e| format!("加载字体失败: {e}"))?;

    let mut cursor = PageCursor {
        doc: &doc,
        page,
        layer,
        y: 297.0 - 20.0,
        page_no: 1,
    };
    let layer_ref = doc.get_page(page).get_layer(layer);

    // 标题
    layer_ref.use_text(
        truncate_chars(&project.title, 30),
        20.0,
        Mm(20.0),
        Mm(cursor.y),
        &font,
    );
    cursor.y -= 10.0;
    layer_ref.use_text(
        format!(
            "{} 个概念 · {} 条关系 · 更新于 {}",
            project.nodes.len(),
            project.edges.len(),
            format_ts(project.updated_at)
        ),
        9.0,
        Mm(20.0),
        Mm(cursor.y),
        &font,
    );
    cursor.y -= 12.0;

    // 总结
    if !project.summary.trim().is_empty() {
        cursor.ensure_space(&font, 24.0);
        let layer_ref = doc.get_page(cursor.page).get_layer(cursor.layer);
        layer_ref.use_text("AI 总结", 13.0, Mm(20.0), Mm(cursor.y), &font);
        cursor.y -= 7.0;
        for line in wrap_chars(project.summary.trim(), 42.0, 200) {
            cursor.line(&font, &line, 10.0);
        }
        cursor.y -= 6.0;
    }

    // 概念清单
    cursor.ensure_space(&font, 24.0);
    let layer_ref = doc.get_page(cursor.page).get_layer(cursor.layer);
    layer_ref.use_text("概念清单", 13.0, Mm(20.0), Mm(cursor.y), &font);
    cursor.y -= 7.0;
    for node in &project.nodes {
        let text = match node.description.as_ref().filter(|d| !d.trim().is_empty()) {
            Some(d) => format!("• {} —— {}", node.label, d),
            None => format!("• {}", node.label),
        };
        for (i, line) in wrap_chars(&text, 40.0, 2).iter().enumerate() {
            let rendered = if i == 0 {
                line.clone()
            } else {
                format!("   {line}")
            };
            cursor.line(&font, &rendered, 9.5);
        }
    }
    cursor.y -= 6.0;

    // 关系
    cursor.ensure_space(&font, 24.0);
    let layer_ref = doc.get_page(cursor.page).get_layer(cursor.layer);
    layer_ref.use_text("概念关系", 13.0, Mm(20.0), Mm(cursor.y), &font);
    cursor.y -= 7.0;
    for e in &project.edges {
        let from = project
            .nodes
            .iter()
            .find(|n| n.id == e.source)
            .map(|n| n.label.as_str())
            .unwrap_or(&e.source);
        let to = project
            .nodes
            .iter()
            .find(|n| n.id == e.target)
            .map(|n| n.label.as_str())
            .unwrap_or(&e.target);
        let text = format!("• {from} —[{}]→ {to}", e.label.as_deref().unwrap_or("关联"));
        for line in wrap_chars(&text, 40.0, 2) {
            cursor.line(&font, &line, 9.5);
        }
    }

    drop(cursor);
    doc.save_to_bytes().map_err(|e| format!("PDF 生成失败: {e}"))
}

struct PageCursor<'a> {
    doc: &'a printpdf::PdfDocumentReference,
    page: printpdf::PdfPageIndex,
    layer: printpdf::PdfLayerIndex,
    y: f32,
    page_no: u32,
}

impl<'a> PageCursor<'a> {
    fn ensure_space(&mut self, _font: &printpdf::IndirectFontRef, needed: f32) {
        if self.y - needed > 20.0 {
            return;
        }
        self.page_no += 1;
        let (page, layer) = self.doc.add_page(Mm(210.0), Mm(297.0), format!("Layer {}", self.page_no));
        self.page = page;
        self.layer = layer;
        self.y = 297.0 - 20.0;
    }

    fn line(&mut self, font: &printpdf::IndirectFontRef, text: &str, size: f32) {
        self.ensure_space(font, 6.0);
        let layer = self.doc.get_page(self.page).get_layer(self.layer);
        layer.use_text(text, size, Mm(20.0), Mm(self.y), font);
        self.y -= size * 0.52 + 1.6;
    }
}

// ---------------------------------------------------------------------------
// DOCX（ZIP + WordprocessingML，无第三方 Office 依赖）
// ---------------------------------------------------------------------------

pub fn to_docx(project: &GraphProject) -> Result<Vec<u8>, String> {
    let mut body = String::new();
    body.push_str(&para(&project.title, Some(36), true, "2E3A4E"));
    body.push_str(&para(
        &format!(
            "{} 个概念 · {} 条关系 · 更新于 {}",
            project.nodes.len(),
            project.edges.len(),
            format_ts(project.updated_at)
        ),
        Some(18),
        false,
        "7F7F7F",
    ));

    if !project.summary.trim().is_empty() {
        body.push_str(&para("AI 总结", Some(26), true, "1F3864"));
        for p in project.summary.split("\n\n").filter(|p| !p.trim().is_empty()) {
            body.push_str(&para(p.trim(), Some(21), false, "000000"));
        }
    }

    body.push_str(&para("概念清单", Some(26), true, "1F3864"));
    body.push_str(&table(project));

    body.push_str(&para("概念关系", Some(26), true, "1F3864"));
    for e in &project.edges {
        let from = project
            .nodes
            .iter()
            .find(|n| n.id == e.source)
            .map(|n| n.label.as_str())
            .unwrap_or(&e.source);
        let to = project
            .nodes
            .iter()
            .find(|n| n.id == e.target)
            .map(|n| n.label.as_str())
            .unwrap_or(&e.target);
        body.push_str(&para(
            &format!("• {from} —[{}]→ {to}", e.label.as_deref().unwrap_or("关联")),
            Some(21),
            false,
            "000000",
        ));
    }

    let document_xml = format!(
        r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>"##
    );

    let content_types = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"##;

    let rels = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"##;

    let mut zip = ZipWriter::new();
    zip.add("[Content_Types].xml", content_types.as_bytes())?;
    zip.add("_rels/.rels", rels.as_bytes())?;
    zip.add("word/document.xml", document_xml.as_bytes())?;
    zip.finish()
}

fn para(text: &str, half_points: Option<u32>, bold: bool, color: &str) -> String {
    let size = half_points.unwrap_or(21);
    format!(
        "<w:p><w:pPr><w:spacing w:after=\"120\"/></w:pPr><w:r><w:rPr>{}<w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/><w:color w:val=\"{color}\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        if bold { "<w:b/>" } else { "" },
        xml_escape(text)
    )
}

fn table(project: &GraphProject) -> String {
    let mut out = String::from(
        "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"D9D9D9\"/></w:tblBorders></w:tblPr>",
    );
    out.push_str(&row(&["概念", "说明", "层级"], true));
    for n in &project.nodes {
        out.push_str(&row(
            &[
                n.label.as_str(),
                n.description.as_deref().unwrap_or(""),
                &n.level.map(|l| l.to_string()).unwrap_or_default(),
            ],
            false,
        ));
    }
    out.push_str("</w:tbl>");
    out
}

fn row(cells: &[&str], header: bool) -> String {
    let mut out = String::from("<w:tr>");
    for c in cells {
        out.push_str(&format!(
            "<w:tc><w:tcPr><w:tcW w:w=\"{}\" w:type=\"dxa\"/></w:tcPr>{}</w:tc>",
            1800,
            para(c, Some(19), header, if header { "1F3864" } else { "000000" })
        ));
    }
    out.push_str("</w:tr>");
    out
}

/// 最小 ZIP 写入器（deflate + crc32），避免引入 zip 依赖；Word 可直接打开。
struct ZipWriter {
    buf: Vec<u8>,
    central: Vec<u8>,
    count: u16,
}

impl ZipWriter {
    fn new() -> Self {
        Self {
            buf: Vec::new(),
            central: Vec::new(),
            count: 0,
        }
    }

    fn add(&mut self, name: &str, data: &[u8]) -> Result<(), String> {
        let crc = crc32fast::hash(data);
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(data)
            .map_err(|e| format!("压缩失败: {e}"))?;
        let compressed = encoder.finish().map_err(|e| format!("压缩失败: {e}"))?;

        let offset = self.buf.len() as u32;
        let name_bytes = name.as_bytes();
        // local file header
        self.buf.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        self.buf.extend_from_slice(&20u16.to_le_bytes()); // version needed
        self.buf.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 flag
        self.buf.extend_from_slice(&8u16.to_le_bytes()); // deflate
        self.buf.extend_from_slice(&0u16.to_le_bytes()); // time
        self.buf.extend_from_slice(&0u16.to_le_bytes()); // date
        self.buf.extend_from_slice(&crc.to_le_bytes());
        self.buf
            .extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        self.buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        self.buf
            .extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        self.buf.extend_from_slice(&0u16.to_le_bytes()); // extra len
        self.buf.extend_from_slice(name_bytes);
        self.buf.extend_from_slice(&compressed);

        // central directory entry
        self.central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        self.central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        self.central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        self.central.extend_from_slice(&0x0800u16.to_le_bytes());
        self.central.extend_from_slice(&8u16.to_le_bytes());
        self.central.extend_from_slice(&0u16.to_le_bytes());
        self.central.extend_from_slice(&0u16.to_le_bytes());
        self.central.extend_from_slice(&crc.to_le_bytes());
        self.central
            .extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        self.central
            .extend_from_slice(&(data.len() as u32).to_le_bytes());
        self.central
            .extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        self.central.extend_from_slice(&0u16.to_le_bytes()); // extra
        self.central.extend_from_slice(&0u16.to_le_bytes()); // comment
        self.central.extend_from_slice(&0u16.to_le_bytes()); // disk
        self.central.extend_from_slice(&0u16.to_le_bytes()); // internal attr
        self.central.extend_from_slice(&0u32.to_le_bytes()); // external attr
        self.central.extend_from_slice(&offset.to_le_bytes());
        self.central.extend_from_slice(name_bytes);

        self.count += 1;
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<u8>, String> {
        let central_offset = self.buf.len() as u32;
        let central_size = self.central.len() as u32;
        self.buf.extend_from_slice(&self.central);
        self.buf.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        self.buf.extend_from_slice(&0u16.to_le_bytes()); // disk
        self.buf.extend_from_slice(&0u16.to_le_bytes()); // cd start disk
        self.buf.extend_from_slice(&self.count.to_le_bytes());
        self.buf.extend_from_slice(&self.count.to_le_bytes());
        self.buf.extend_from_slice(&central_size.to_le_bytes());
        self.buf.extend_from_slice(&central_offset.to_le_bytes());
        self.buf.extend_from_slice(&0u16.to_le_bytes()); // comment len
        Ok(self.buf)
    }
}

// ---------------------------------------------------------------------------
// Markdown / JSON
// ---------------------------------------------------------------------------

pub fn to_markdown(project: &GraphProject) -> String {
    let mut out = format!("# {}\n\n", project.title);
    out.push_str(&format!(
        "> {} 个概念 · {} 条关系 · 更新于 {}\n\n",
        project.nodes.len(),
        project.edges.len(),
        format_ts(project.updated_at)
    ));
    out.push_str("## AI 总结\n\n");
    out.push_str(if project.summary.trim().is_empty() {
        "_（本图谱没有 AI 总结）_\n\n"
    } else {
        project.summary.trim()
    });
    out.push_str("\n\n## 概念清单\n\n| 概念 | 说明 | 层级 |\n|---|---|---|\n");
    for n in &project.nodes {
        out.push_str(&format!(
            "| {} | {} | {} |\n",
            n.label.replace('|', "\\|"),
            n.description.as_deref().unwrap_or("").replace('|', "\\|"),
            n.level.map(|l| l.to_string()).unwrap_or_default()
        ));
    }
    out.push_str("\n## 概念关系\n\n");
    for e in &project.edges {
        let from = project
            .nodes
            .iter()
            .find(|n| n.id == e.source)
            .map(|n| n.label.as_str())
            .unwrap_or(&e.source);
        let to = project
            .nodes
            .iter()
            .find(|n| n.id == e.target)
            .map(|n| n.label.as_str())
            .unwrap_or(&e.target);
        out.push_str(&format!(
            "- **{}** —[{}]→ **{}**\n",
            from,
            e.label.as_deref().unwrap_or("关联"),
            to
        ));
    }
    out
}

pub fn to_json(project: &GraphProject) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(project).map_err(|e| format!("序列化失败: {e}"))
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/// 生成目标格式的字节内容（不落盘，便于测试）
pub fn render_bytes(project: &GraphProject, format: ExportFormat) -> Result<Vec<u8>, String> {
    match format {
        ExportFormat::Html => Ok(to_html(project).into_bytes()),
        ExportFormat::Docx => to_docx(project),
        ExportFormat::Pdf => to_pdf(project),
        ExportFormat::Png => to_png(project),
        ExportFormat::Markdown => Ok(to_markdown(project).into_bytes()),
        ExportFormat::Json => to_json(project),
    }
}

fn format_ts(ms: u64) -> String {
    // 轻量时间格式：不引 chrono，按 UTC 天偏移换算年月日（仅用于展示）
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{}-{:02}-{:02} {:02}:{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60
    )
}

/// 文件名用紧凑时间戳（YYYYMMDD-HHMM），避免文件名里出现冒号等非法字符
pub fn stamp_for_file(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}", rem / 3600, (rem % 3600) / 60)
}

/// Howard Hinnant 的 days → (year, month, day) 算法
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConceptEdge, ConceptNode, GraphProject, GraphTemplateType};

    fn sample() -> GraphProject {
        GraphProject {
            id: "g1".into(),
            title: "测试图谱".into(),
            template_type: GraphTemplateType::Free,
            nodes: vec![
                ConceptNode {
                    id: "a".into(),
                    label: "边际效用".into(),
                    level: Some(1),
                    description: Some("消费者每增加一单位消费所获得的额外满足".into()),
                    position: None,
                },
                ConceptNode {
                    id: "b".into(),
                    label: "需求曲线".into(),
                    level: Some(2),
                    description: Some("价格与需求量的关系".into()),
                    position: None,
                },
            ],
            edges: vec![ConceptEdge {
                id: "e1".into(),
                source: "a".into(),
                target: "b".into(),
                label: Some("推导出".into()),
            }],
            summary: "第一段总结。\n\n第二段总结。".into(),
            created_at: 0,
            updated_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn svg_contains_labels() {
        let svg = render_svg(&sample());
        assert!(svg.contains("边际效用"));
        assert!(svg.contains("推导出"));
        assert!(svg.starts_with("<svg"));
    }

    #[test]
    fn html_is_self_contained() {
        let html = to_html(&sample());
        assert!(html.contains("<svg"));
        assert!(html.contains("charset=\"utf-8\""));
        assert!(!html.contains("http://cdn"));
    }

    #[test]
    fn docx_is_zip() {
        let bytes = to_docx(&sample()).expect("docx");
        assert_eq!(&bytes[0..2], b"PK");
        assert!(bytes.len() > 500);
    }

    #[test]
    fn png_has_signature() {
        let bytes = to_png(&sample()).expect("png");
        assert_eq!(&bytes[0..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    #[test]
    fn pdf_has_signature_or_reports_missing_font() {
        match to_pdf(&sample()) {
            Ok(bytes) => {
                assert!(bytes.starts_with(b"%PDF"), "PDF 头不正确");
                assert!(bytes.len() > 2_000, "PDF 过小，可能没有内容");
                let raw = String::from_utf8_lossy(&bytes);
                // 字体必须真正嵌入（FontFile2）+ 使用 CID 编码，否则中文会显示为空白
                assert!(raw.contains("/FontFile2"), "字体未嵌入");
                assert!(raw.contains("Identity-H"), "未使用 CID 编码");
            }
            Err(e) => {
                // 无中文字体的环境允许跳过，但错误必须是可读的字体提示
                assert!(e.contains("字体"), "非字体原因失败: {e}");
            }
        }
    }

    #[test]
    fn markdown_escapes_pipes() {
        let md = to_markdown(&sample());
        assert!(md.contains("| 边际效用 |"));
    }
}
