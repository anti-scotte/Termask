// src/components/whiteboard/WhiteboardExportDialog.tsx
// 白板导出对话框（2026-11-07）：png / svg / json / md / html
//
// 产物管线：
//   - png / svg：editor.toImage（有纸张边框 → bounds 裁剪到边框；否则全部内容外扩）
//   - html：SVG 内嵌自包含单文件
//   - json：当前白板 pages[] 快照（含各页 tldraw snapshot）
//   - md：各页文本形状聚合
//
// 落盘：write_export_file（bridge-ext，后端待实现）→ base64 写 exports/；
// 命令未上线时给出明确降级提示（WebView 不支持 a.download，无法浏览器下载）。

import { useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { blobToBase64, writeExportFile } from "@/lib/bridge-ext";
import { richTextToPlain } from "@/components/whiteboard/SelectionBubble";
import { Box } from "tldraw";
import type { Editor } from "tldraw";
import type { WhiteboardProject } from "@/types";

type WbFormat = "png" | "svg" | "json" | "md" | "html";

const FORMATS: Array<{ id: WbFormat; label: string; desc: string }> = [
  { id: "png", label: "PNG", desc: "位图（2x），按边界裁剪" },
  { id: "svg", label: "SVG", desc: "矢量图，无限放大不糊" },
  { id: "json", label: "JSON", desc: "全部页快照，可回读" },
  { id: "md", label: "Markdown", desc: "各页文字内容聚合" },
  { id: "html", label: "HTML", desc: "SVG 内嵌自包含页面" },
];

interface WhiteboardExportDialogProps {
  open: boolean;
  onClose: () => void;
  editor: Editor;
  project: WhiteboardProject;
  hasPaperFrame: boolean;
}

export function WhiteboardExportDialog({
  open,
  onClose,
  editor,
  project,
  hasPaperFrame,
}: WhiteboardExportDialogProps) {
  const [format, setFormat] = useState<WbFormat>("png");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 导出裁剪范围：纸张边框 → 其 bounds；否则全部内容外扩 40 */
  const exportBounds = () => {
    const shapes = editor.getCurrentPageShapes();
    const frame = shapes.find(
      (s) => (s.meta as Record<string, unknown> | undefined)?.paperFrame,
    );
    if (frame) {
      const b = editor.getShapePageBounds(frame.id)!;
      return new Box(b.x, b.y, b.w, b.h);
    }
    const all = editor.getShapesPageBounds(shapes.map((s) => s.id));
    if (!all) return new Box(0, 0, 1200, 800);
    return new Box(all.x - 40, all.y - 40, all.w + 80, all.h + 80);
  };

  /** 各页文本聚合（md 用） */
  const collectText = (): string => {
    const pages = project.pages ?? [];
    return pages
      .map((pg, i) => {
        const body = textOfPage(pg.elements);
        return `## 第 ${i + 1} 页\n${body || "（空页）"}`;
      })
      .join("\n\n");
  };

  const textOfPage = (elements: unknown): string => {
    try {
      const snap = elements as { store?: Record<string, { type?: string; props?: { richText?: unknown } }> };
      const records = Object.values(snap?.store ?? {});
      return records
        .filter((r) => r?.type === "shape")
        .map((r) => richTextToPlain(r.props?.richText))
        .filter(Boolean)
        .map((t) => `- ${t}`)
        .join("\n");
    } catch {
      return "（快照解析失败）";
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const stamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[T:]/g, "-");
    const base = (project.title || "白板").replace(/[\\/:*?"<>|]/g, "_");
    try {
      let fileName = "";
      let base64 = "";

      if (format === "png" || format === "svg") {
        const shapes = editor.getCurrentPageShapes();
        const frame = shapes.find(
          (s) => (s.meta as Record<string, unknown> | undefined)?.paperFrame,
        );
        const ids = frame
          ? shapes.filter((s) => (s.meta as Record<string, unknown> | undefined)?.a4Frame !== true).map((s) => s.id)
          : shapes.map((s) => s.id);
        const { blob } = await editor.toImage(ids, {
          bounds: exportBounds(),
          format: format === "png" ? "png" : "svg",
          background: true,
          scale: format === "png" ? 2 : 1,
        });
        fileName = `${base}-${stamp}.${format}`;
        base64 = await blobToBase64(blob);
      } else if (format === "json") {
        fileName = `${base}-${stamp}.json`;
        base64 = btoa(
          encodeURIComponent(JSON.stringify({ ...project }, null, 2)).replace(
            /%([0-9A-F]{2})/g,
            (_, p) => String.fromCharCode(parseInt(p, 16)),
          ),
        );
      } else if (format === "md") {
        fileName = `${base}-${stamp}.md`;
        const md =
          `# ${project.title}\n\n> TermAsk 白板导出 · ${new Date().toLocaleString("zh-CN")}\n\n` +
          collectText();
        base64 = btoa(
          encodeURIComponent(md).replace(/%([0-9A-F]{2})/g, (_, p) =>
            String.fromCharCode(parseInt(p, 16)),
          ),
        );
      } else {
        // html：SVG 内嵌
        const shapes = editor.getCurrentPageShapes();
        const ids = shapes.map((s) => s.id);
        const { blob } = await editor.toImage(ids, {
          bounds: exportBounds(),
          format: "svg",
          background: true,
        });
        const svg = await blob.text();
        fileName = `${base}-${stamp}.html`;
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${project.title}</title><style>body{margin:0;background:#f1f5f9;display:flex;justify-content:center;padding:24px}svg{max-width:100%;height:auto;background:#fff;border:1px solid #cbd5e1;border-radius:8px}</style></head><body>${svg}</body></html>`;
        base64 = btoa(
          encodeURIComponent(html).replace(/%([0-9A-F]{2})/g, (_, p) =>
            String.fromCharCode(parseInt(p, 16)),
          ),
        );
      }

      const r = await writeExportFile(fileName, base64);
      setResult(`${r.path}（${(r.bytes / 1024).toFixed(1)} KB）`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes("unknown command") || msg.includes("找不到")
          ? "后端 write_export_file 命令尚未上线（见后端请求清单），上线后即可落盘导出"
          : `导出失败：${msg}`,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[420px] overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">
            导出白板「{project.title}」
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hasPaperFrame
              ? "将按纸张边框裁剪导出（工具栏「纸张」按钮可加/删边框）。"
              : "未设纸张边框：按全部内容外扩导出。落盘到数据目录 exports/。"}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 px-4 py-3">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFormat(f.id)}
              title={f.desc}
              className={`cursor-pointer rounded-lg border p-2.5 text-left transition-colors ${
                format === f.id
                  ? "border-sky-400/60 bg-sky-400/10"
                  : "border-border hover:bg-accent/40"
              }`}
            >
              <span className="block text-xs font-medium text-foreground">
                {f.label}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {f.desc}
              </span>
            </button>
          ))}
        </div>

        <div className="space-y-2 px-4 pb-3">
          {result && (
            <p className="flex items-start gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-600">
              <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-all">导出成功：{result}</span>
            </p>
          )}
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
          <Button size="sm" onClick={() => void run()} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            导出 {FORMATS.find((f) => f.id === format)?.label}
          </Button>
        </div>
      </div>
    </div>
  );
}
