// src/components/graph/ExportDialog.tsx
// 图谱导出对话框（2026-11-07 对接后端 export_graph_project）
//
// 主路径：invoke `export_graph_project`（bridge-ext.exportGraphProject）——
// 后端把 GraphProject 渲染为 html/docx/pdf/png/markdown/json 并落盘到
// `数据目录/exports`，返回 { path, format, bytes }。
// （后端 PDF/PNG 依赖系统中文字体；缺字体时返回可读错误而不是乱码文件。）
//
// 回退路径：后端命令不存在（旧版本）→ 前端 graphExport.ts 浏览器管线
// （HTML/JSON/MD 直接下载；PNG Canvas 重绘；PDF 调起打印）。
//
// 裁剪范围：有纸张边框 → 导出时按边框几何；否则按内容包围盒外扩。

import { useState } from "react";
import {
  FileCode2,
  FileJson,
  FileText,
  FileImage,
  Printer,
  FileBadge,
  Loader2,
  FolderOpen,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { usePrefsStore } from "@/stores/usePrefsStore";
import type { GraphProject } from "@/types";
import type { FlowEdge, FlowNode } from "@/types/graph";
import {
  exportGraphProject,
  type ExportFormat as BackendFormat,
} from "@/lib/bridge-ext";

const FORMATS: Array<{
  id: BackendFormat;
  label: string;
  desc: string;
  icon: typeof FileJson;
}> = [
  { id: "json", label: "JSON", desc: "完整结构数据，可回导入", icon: FileJson },
  { id: "markdown", label: "Markdown", desc: "节点/命题列表 + mermaid", icon: FileText },
  { id: "html", label: "HTML", desc: "自包含单文件，离线可看", icon: FileCode2 },
  { id: "png", label: "PNG", desc: "高清位图（后端渲染，需系统中文字体）", icon: FileImage },
  { id: "pdf", label: "PDF", desc: "矢量文档（后端渲染）", icon: Printer },
  { id: "docx", label: "docx", desc: "Word 文档（后端渲染）", icon: FileBadge },
];

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** 当前图谱 → GraphProject（GraphPage 转换，后端渲染入参） */
  buildProject: () => GraphProject;
  /** 回退管线用的画布原始节点/边（旧后端无导出命令时） */
  nodes: FlowNode[];
  edges: FlowEdge[];
  title: string;
  paperBounds?: { x: number; y: number; w: number; h: number };
  hasPaper: boolean;
}

export function ExportDialog({
  open,
  onClose,
  buildProject,
  nodes,
  edges,
  title,
  paperBounds,
  hasPaper,
}: ExportDialogProps) {
  const defaultFormat = usePrefsStore((s) => s.defaultExportFormat) as BackendFormat;
  const [format, setFormat] = useState<BackendFormat>(defaultFormat);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ path: string; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const project = buildProject();
      const r = await exportGraphProject(project, format);
      setResult({ path: r.path, bytes: r.bytes });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 后端命令不存在（旧版本）→ 前端浏览器管线回退
      if (
        msg.includes("unknown command") ||
        msg.includes("找不到") ||
        msg.includes("not found")
      ) {
        try {
          const { downloadJson, downloadMarkdown, downloadHtml, downloadPng, printAsPdf } =
            await import("@/lib/graphExport");
          if (format === "json") downloadJson(nodes, edges, title);
          else if (format === "markdown") downloadMarkdown(nodes, edges, title);
          else if (format === "html") downloadHtml(nodes, edges, title, paperBounds);
          else if (format === "png") await downloadPng(nodes, edges, title, paperBounds);
          else if (format === "pdf") printAsPdf(nodes, edges, title, paperBounds);
          if (format !== "docx") {
            setResult({ path: "（浏览器下载目录 / 打印对话框）", bytes: 0 });
          } else {
            setError("docx 需要新版后端 export_graph_project 支持，请更新后端");
          }
        } catch (e2) {
          setError(`导出失败：${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      } else {
        setError(`导出失败：${msg}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导出图谱「{title}」</DialogTitle>
          <DialogDescription>
            {hasPaper
              ? "将按纸张边框裁剪导出。"
              : "未设纸张边框：按内容包围盒外扩导出（可用画布「纸张」按钮添加边界）。文件落盘到数据目录 exports/。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 py-1">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFormat(f.id)}
              title={f.desc}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-left transition-colors ${
                format === f.id
                  ? "border-sky-400/60 bg-sky-400/10"
                  : "border-border hover:bg-accent/40"
              }`}
            >
              <f.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground">
                  {f.label}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {f.desc}
                </span>
              </span>
            </button>
          ))}
        </div>

        {result && (
          <p className="flex items-start gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-600">
            <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-all">
              导出成功：{result.path}
              {result.bytes > 0 && `（${(result.bytes / 1024).toFixed(1)} KB）`}
            </span>
          </p>
        )}
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button onClick={() => void run()} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            导出 {FORMATS.find((f) => f.id === format)?.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
