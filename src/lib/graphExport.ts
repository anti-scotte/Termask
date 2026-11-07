// src/lib/graphExport.ts
// 图谱导出管线（v0.1.0）：JSON / Markdown(含 mermaid) / HTML / PNG / PDF(打印)
//
// 精度策略：连线用 @xyflow/react 公开的路径函数（getSmoothStepPath /
// getBezierPath / getStraightPath）按与画布一致的参数重算 —— HTML 与 PNG
// 的连线形状与画布视觉一致；节点形状用 CSS / Canvas 等价绘制
// （card/circle/pill/diamond/note）。
//
// docx：需要 zip 容器，前端不引入重依赖 —— 列入后端请求清单
// （`export_graph_docx` 命令），导出对话框中置灰并给出说明。
//
// 裁剪范围：传入 paperBounds（纸张边框节点 bounds）优先；否则按内容包围盒
// 外扩 60px。

import {
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  Position,
  MarkerType,
} from "@xyflow/react";
import type { ConceptKind, FlowEdge, FlowNode, GraphTemplate } from "@/types/graph";
import { TEMPLATE_META, KIND_META } from "@/types/graph";

/* ------------------------------------------------------------------ *
 *  几何：包围盒与方向
 * ------------------------------------------------------------------ */

export interface NodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function nodeBoxes(nodes: FlowNode[]): NodeBox[] {
  return nodes.map((n) => ({
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    w: n.measured?.width ?? 150,
    h: n.measured?.height ?? 48,
  }));
}

export function boundsOf(boxes: NodeBox[], pad = 60): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  if (boxes.length === 0) return { x: 0, y: 0, w: 800, h: 600 };
  const minX = Math.min(...boxes.map((b) => b.x)) - pad;
  const minY = Math.min(...boxes.map((b) => b.y)) - pad;
  const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
  const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 按两节点相对方位选 Handle（与视觉方向一致：右→左 或 下→上） */
function pickDirections(
  a: NodeBox,
  b: NodeBox,
): { sp: Position; tp: Position } {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
    return bcx >= acx
      ? { sp: Position.Right, tp: Position.Left }
      : { sp: Position.Left, tp: Position.Right };
  }
  return bcy >= acy
    ? { sp: Position.Bottom, tp: Position.Top }
    : { sp: Position.Top, tp: Position.Bottom };
}

function anchor(
  b: NodeBox,
  p: Position,
): { x: number; y: number } {
  switch (p) {
    case Position.Top:
      return { x: b.x + b.w / 2, y: b.y };
    case Position.Bottom:
      return { x: b.x + b.w / 2, y: b.y + b.h };
    case Position.Left:
      return { x: b.x, y: b.y + b.h / 2 };
    default:
      return { x: b.x + b.w, y: b.y + b.h / 2 };
  }
}

/** 重算一条边的路径（与画布 RelationEdge 参数一致） */
function edgePath(e: FlowEdge, boxMap: Map<string, NodeBox>): string | null {
  const a = boxMap.get(e.source);
  const b = boxMap.get(e.target);
  if (!a || !b) return null;
  const { sp, tp } = pickDirections(a, b);
  const s = anchor(a, sp);
  const t = anchor(b, tp);
  const style = (e.data as { lineStyle?: string })?.lineStyle ?? "orthogonal";
  const radius = (e.data as { cornerRadius?: number })?.cornerRadius ?? 12;
  if (style === "straight") {
    return getStraightPath({ sourceX: s.x, sourceY: s.y, targetX: t.x, targetY: t.y })[0];
  }
  if (style === "smooth") {
    return getBezierPath({
      sourceX: s.x, sourceY: s.y, sourcePosition: sp,
      targetX: t.x, targetY: t.y, targetPosition: tp,
    })[0];
  }
  if (style === "sketch") {
    // 导出近似：随手写笔迹以贝塞尔替代（抖动不影响结构阅读）
    return getBezierPath({
      sourceX: s.x, sourceY: s.y, sourcePosition: sp,
      targetX: t.x, targetY: t.y, targetPosition: tp, curvature: 0.16,
    })[0];
  }
  return getSmoothStepPath({
    sourceX: s.x, sourceY: s.y, sourcePosition: sp,
    targetX: t.x, targetY: t.y, targetPosition: tp,
    borderRadius: Math.max(0, radius),
  })[0];
}

/* ------------------------------------------------------------------ *
 *  节点视觉参数（模板色 / 形状）
 * ------------------------------------------------------------------ */

function nodeBorderColor(n: FlowNode): string {
  const d = n.data as {
    colorOverride?: string;
    template?: GraphTemplate;
  };
  return d.colorOverride ?? TEMPLATE_META[d.template ?? "free"].dot;
}

function nodeShape(n: FlowNode): string {
  return (n.data as { shape?: string }).shape ?? "card";
}

/* ------------------------------------------------------------------ *
 *  HTML 导出（自包含单文件：内联 CSS，离线可打开）
 * ------------------------------------------------------------------ */

export function buildExportHTML(
  nodes: FlowNode[],
  edges: FlowEdge[],
  title: string,
  paperBounds?: { x: number; y: number; w: number; h: number },
): { html: string; bounds: { x: number; y: number; w: number; h: number } } {
  const boxes = nodeBoxes(nodes);
  const bounds = paperBounds ?? boundsOf(boxes);
  const boxMap = new Map(boxes.map((b) => [b.id, b]));

  // SVG 连线层
  const paths = edges
    .map((e) => {
      const d = edgePath(e, boxMap);
      if (!d) return "";
      const label = (e.data as { label?: string })?.label ?? (typeof e.label === "string" ? e.label : "");
      return `<path d="${d}" fill="none" stroke="#64748b" stroke-width="1.8"/>
        ${label ? `<text x="${(boxMap.get(e.source)!.x + boxMap.get(e.target)!.x + boxMap.get(e.source)!.w + boxMap.get(e.target)!.w) / 4}" y="${(boxMap.get(e.source)!.y + boxMap.get(e.target)!.y + boxMap.get(e.source)!.h + boxMap.get(e.target)!.h) / 4 - 6}" font-size="11" fill="#475569" text-anchor="middle">${label}</text>` : ""}`;
    })
    .join("\n");

  const nodeEls = nodes
    .filter((n) => n.type !== "paperFrame" && n.type !== "vennZone")
    .map((n) => {
      const d = n.data as {
        label?: string;
        shape?: string;
        kind?: ConceptKind;
        hideKindBadge?: boolean;
      };
      const b = boxMap.get(n.id)!;
      const color = nodeBorderColor(n);
      const shape = nodeShape(n);
      const radius =
        shape === "circle" || shape === "pill"
          ? "9999px"
          : shape === "diamond"
            ? "4px"
            : "10px";
      const clip = shape === "diamond" ? "clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);padding:14px 22px;" : "";
      const kindDot =
        d.kind && !d.hideKindBadge && KIND_META[d.kind]
          ? `<span title="${KIND_META[d.kind].label}" style="position:absolute;right:-4px;top:-4px;width:10px;height:10px;border-radius:9999px;border:2px solid #fff;background:${KIND_META[d.kind].color}"></span>`
          : "";
      return `<div class="node" style="left:${b.x - bounds.x}px;top:${b.y - bounds.y}px;border-color:${color};border-radius:${radius};${clip}">
        ${d.label ?? `<span style="opacity:.55">${(n.data as { slot?: string }).slot ?? ""}</span>`}${kindDot}
      </div>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${title} · TermAsk 概念图谱导出</title>
<style>
  body{margin:0;background:#f1f5f9;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;}
  .paper{position:relative;margin:24px auto;background:#fff;border:1px solid #cbd5e1;border-radius:8px;
    box-shadow:0 2px 16px rgba(15,23,42,.08);width:${Math.min(bounds.w, 2400)}px;height:${Math.min(bounds.h, 2400)}px;overflow:hidden;}
  h1{position:absolute;left:16px;top:10px;font-size:14px;color:#64748b;font-weight:500;z-index:2;}
  svg.edges{position:absolute;inset:0;}
  .node{position:absolute;display:flex;align-items:center;justify-content:center;gap:6px;
    background:#0f172a;color:#f8fafc;border:2px solid;padding:8px 16px;font-size:13px;
    box-shadow:0 2px 8px rgba(15,23,42,.25);max-width:220px;text-align:center;}
  footer{margin:8px auto 24px;width:fit-content;color:#94a3b8;font-size:12px;}
</style></head>
<body>
  <div class="paper">
    <h1>${title}</h1>
    <svg class="edges" width="100%" height="100%" viewBox="0 0 ${bounds.w} ${bounds.h}">
      <defs><marker id="arw" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M 0 1 L 8 5 L 0 9" fill="none" stroke="#64748b" stroke-width="1.5"/></marker></defs>
      ${paths}
    </svg>
    ${nodeEls}
  </div>
  <footer>由 TermAsk Workbench 导出 · ${new Date().toLocaleString("zh-CN")}</footer>
</body></html>`;

  return { html, bounds };
}

/* ------------------------------------------------------------------ *
 *  Markdown 导出（结构化列表 + mermaid，可在支持 mermaid 的渲染器回读）
 * ------------------------------------------------------------------ */

export function buildExportMarkdown(
  nodes: FlowNode[],
  edges: FlowEdge[],
  title: string,
): string {
  const lines: string[] = [
    `# ${title}`,
    "",
    `> 由 TermAsk Workbench 导出 · ${new Date().toLocaleString("zh-CN")}`,
    "",
    "## 概念节点",
    "",
    "| 节点 | 说明 | 类型 |",
    "|---|---|---|",
    ...nodes
      .filter((n) => n.type === "concept")
      .map((n) => {
        const d = n.data as { label?: string; description?: string; kind?: ConceptKind };
        const kind = d.kind ? KIND_META[d.kind].label : "—";
        return `| ${d.label || "（空）"} | ${d.description ?? ""} | ${kind} |`;
      }),
    "",
    "## 关系（命题）",
    "",
    ...edges.map((e) => {
      const s = nodes.find((n) => n.id === e.source);
      const t = nodes.find((n) => n.id === e.target);
      const label =
        (e.data as { label?: string })?.label ??
        (typeof e.label === "string" ? e.label : "关联");
      return `- **${s ? String((s.data as { label?: string }).label ?? "") : e.source}** —${label}→ **${t ? String((t.data as { label?: string }).label ?? "") : e.target}**`;
    }),
    "",
    "## Mermaid 图",
    "",
    "```mermaid",
    "graph TD",
    ...nodes
      .filter((n) => n.type === "concept")
      .map((n) => {
        const id = n.id.replace(/[^a-zA-Z0-9]/g, "_");
        return `  ${id}["${String((n.data as { label?: string }).label ?? "（空）")}"]`;
      }),
    ...edges.map((e) => {
      const s = e.source.replace(/[^a-zA-Z0-9]/g, "_");
      const t = e.target.replace(/[^a-zA-Z0-9]/g, "_");
      const label =
        (e.data as { label?: string })?.label ??
        (typeof e.label === "string" ? e.label : "");
      return label ? `  ${s} -->|"${label}"| ${t}` : `  ${s} --> ${t}`;
    }),
    "```",
    "",
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 *  PNG 导出（Canvas 2D，零依赖；形状/连线/文字全量绘制）
 * ------------------------------------------------------------------ */

export async function buildExportPng(
  nodes: FlowNode[],
  edges: FlowEdge[],
  title: string,
  paperBounds?: { x: number; y: number; w: number; h: number },
): Promise<Blob> {
  const boxes = nodeBoxes(nodes);
  const bounds = paperBounds ?? boundsOf(boxes);
  const boxMap = new Map(boxes.map((b) => [b.id, b]));
  const scale = 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.min(bounds.w, 2400) * scale;
  canvas.height = Math.min(bounds.h, 2400) * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  // 纸面
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "13px sans-serif";
  ctx.fillText(`${title} · TermAsk 导出`, 12, 20);

  const toLocal = (p: { x: number; y: number }) => ({
    x: p.x - bounds.x,
    y: p.y - bounds.y,
  });

  // 连线
  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 1.8;
  for (const e of edges) {
    const d = edgePath(e, boxMap);
    if (!d) continue;
    const path = new Path2D(d);
    const { x: ox, y: oy } = toLocal({ x: 0, y: 0 });
    ctx.save();
    ctx.translate(ox, oy);
    ctx.stroke(path);
    ctx.restore();
  }

  // 节点
  for (const n of nodes) {
    if (n.type !== "concept") continue;
    const b = boxMap.get(n.id)!;
    const { x, y } = toLocal({ x: b.x, y: b.y });
    const color = nodeBorderColor(n);
    const shape = nodeShape(n);
    const label = String((n.data as { label?: string }).label ?? "") ||
      (n.data as { slot?: string }).slot || "";

    ctx.fillStyle = "#0f172a";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (shape === "circle") {
      ctx.ellipse(x + b.w / 2, y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    } else if (shape === "diamond") {
      ctx.moveTo(x + b.w / 2, y);
      ctx.lineTo(x + b.w, y + b.h / 2);
      ctx.lineTo(x + b.w / 2, y + b.h);
      ctx.lineTo(x, y + b.h / 2);
      ctx.closePath();
    } else if (shape === "pill") {
      const r = b.h / 2;
      if (ctx.roundRect) ctx.roundRect(x, y, b.w, b.h, r);
      else ctx.rect(x, y, b.w, b.h);
    } else {
      if (ctx.roundRect) ctx.roundRect(x, y, b.w, b.h, 8);
      else ctx.rect(x, y, b.w, b.h);
    }
    ctx.fill();
    ctx.stroke();

    // 文字（自动缩放防溢出）
    ctx.fillStyle = "#f8fafc";
    let fontSize = 13;
    ctx.font = `${fontSize}px sans-serif`;
    while (ctx.measureText(label).width > b.w - 18 && fontSize > 9) {
      fontSize -= 1;
      ctx.font = `${fontSize}px sans-serif`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + b.w / 2, y + b.h / 2);

    // 类型角标
    const kd = n.data as { kind?: ConceptKind; hideKindBadge?: boolean };
    if (kd.kind && !kd.hideKindBadge && KIND_META[kd.kind]) {
      ctx.beginPath();
      ctx.fillStyle = KIND_META[kd.kind].color;
      ctx.arc(x + b.w - 2, y + 2, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG 编码失败"));
    }, "image/png");
  });
}

/* ------------------------------------------------------------------ *
 *  下载与打印
 * ------------------------------------------------------------------ */

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadJson(nodes: FlowNode[], edges: FlowEdge[], title: string) {
  const payload = {
    title,
    exportedAt: new Date().toISOString(),
    template: nodes[0]?.data?.template ?? "free",
    nodes,
    edges,
  };
  triggerDownload(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    `${title}.json`,
  );
}

export function downloadMarkdown(nodes: FlowNode[], edges: FlowEdge[], title: string) {
  triggerDownload(
    new Blob([buildExportMarkdown(nodes, edges, title)], {
      type: "text/markdown;charset=utf-8",
    }),
    `${title}.md`,
  );
}

export function downloadHtml(nodes: FlowNode[], edges: FlowEdge[], title: string, paperBounds?: { x: number; y: number; w: number; h: number }) {
  const { html } = buildExportHTML(nodes, edges, title, paperBounds);
  triggerDownload(
    new Blob([html], { type: "text/html;charset=utf-8" }),
    `${title}.html`,
  );
}

export async function downloadPng(
  nodes: FlowNode[],
  edges: FlowEdge[],
  title: string,
  paperBounds?: { x: number; y: number; w: number; h: number },
) {
  const blob = await buildExportPng(nodes, edges, title, paperBounds);
  triggerDownload(blob, `${title}.png`);
}

/** PDF：渲染导出 HTML 到隐藏 iframe 后调起打印（WebView2 打印对话框可另存 PDF） */
export function printAsPdf(nodes: FlowNode[], edges: FlowEdge[], title: string, paperBounds?: { x: number; y: number; w: number; h: number }) {
  const { html } = buildExportHTML(nodes, edges, title, paperBounds);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  iframe.onload = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    window.setTimeout(() => iframe.remove(), 60000);
  };
}

export { MarkerType };
