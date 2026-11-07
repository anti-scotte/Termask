// src/components/graph/AiAskPanel.tsx
// AI 追问区（v0.1.0）：可导入提问模板引导发散提问，也允许自由输入
//
// - 模板来自 useTemplateStore（模板管理页维护；首装内置 3 个默认模板）
// - 占位变量替换：{{卡点词}}=当前选中节点词，{{上下文}}=全文快照截断，
//   {{图谱概览}}=当前图谱 JSON 摘要（节点/关系列表）
// - 回答经后端 ask_llm 通用问答命令生成（v0.1.0 契约，未上线时降级提示）
// - 交互：可拖拽浮窗（拖拽期直写 style，pointerup 才提交 state，零渲染卡顿）

import { useCallback, useRef, useState } from "react";
import { GripVertical, Loader2, MessageCircleQuestion, Send, X, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { askLlm } from "@/lib/bridge";
import { useModelStore } from "@/stores/useModelStore";
import { useTemplateStore } from "@/stores/useTemplateStore";

/** 模板占位变量替换 */
function fillTemplate(
  content: string,
  vars: { 卡点词?: string; 上下文?: string; 图谱概览?: string },
): string {
  return content
    .replace(/\{\{\s*卡点词\s*\}\}/g, vars.卡点词 ?? "")
    .replace(/\{\{\s*上下文\s*\}\}/g, vars.上下文 ?? "")
    .replace(/\{\{\s*图谱概览\s*\}\}/g, vars.图谱概览 ?? "");
}

interface AiAskPanelProps {
  onClose: () => void;
  /** 当前选中/解析中的节点词（模板 {{卡点词}}） */
  currentTerm: string;
  /** 全文上下文（模板 {{上下文}}，GraphPage resolveContextText 截断 8000 字） */
  contextText: string;
  /** 图谱概览（模板 {{图谱概览}}：节点 + 关系命题列表） */
  graphOverview: string;
}

export function AiAskPanel({
  onClose,
  currentTerm,
  contextText,
  graphOverview,
}: AiAskPanelProps) {
  const templates = useTemplateStore((s) => s.templates);
  const [templateId, setTemplateId] = useState<string>("none");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* ---- 拖拽（v7.1 模式：move 直写 DOM，up 提交） ---- */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ px: number; py: number; left: number; top: number } | null>(
    null,
  );
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(
    null,
  );

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const el = panelRef.current;
    if (!el) return;
    drag.current = { px: e.clientX, py: e.clientY, left: el.offsetLeft, top: el.offsetTop };
    el.style.willChange = "left, top";
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onHeaderPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = panelRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!d || !el || !parent) return;
    const maxLeft = Math.max(parent.clientWidth - el.offsetWidth, 0);
    const maxTop = Math.max(parent.clientHeight - el.offsetHeight, 0);
    el.style.left = `${Math.min(Math.max(d.left + (e.clientX - d.px), 0), maxLeft)}px`;
    el.style.top = `${Math.min(Math.max(d.top + (e.clientY - d.py), 0), maxTop)}px`;
  };
  const endDrag = () => {
    const el = panelRef.current;
    if (!drag.current || !el) return;
    drag.current = null;
    el.style.willChange = "";
    setDragPos({ left: el.offsetLeft, top: el.offsetTop });
  };

  /** 选模板 → 填充问题输入框（可再手改） */
  const handleTemplatePick = (id: string) => {
    setTemplateId(id);
    if (id === "none") return;
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    setQuestion(
      fillTemplate(tpl.promptContent, {
        卡点词: currentTerm,
        上下文: contextText.slice(0, 4000),
        图谱概览: graphOverview,
      }),
    );
  };

  const handleSend = useCallback(async () => {
    const q = question.trim();
    if (!q || loading) return;
    const provider = useModelStore.getState().getDefaultProvider();
    if (!provider) {
      setError("请先在「模型设置」添加并启用一个 Provider");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await askLlm(q, contextText.slice(0, 8000), {
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey ?? "",
        model: provider.model,
      });
      setAnswer(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // v0.1.0 契约：后端 ask_llm 未上线时给出明确指引
      setError(
        msg.includes("unknown command") || msg.includes("找不到")
          ? "后端 ask_llm 命令尚未上线（见交接单后端请求清单），请等后端同步后重试"
          : msg,
      );
    } finally {
      setLoading(false);
    }
  }, [question, loading, contextText]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="AI 追问区"
      className={`absolute overflow-hidden rounded-lg border border-emerald-400/30 bg-[rgba(20,20,30,0.94)] w-[360px] shadow-xl backdrop-blur animate-in fade-in zoom-in-95 fill-mode-both duration-200 ${
        dragPos ? "" : "left-4 top-16"
      }`}
      style={dragPos ? { left: dragPos.left, top: dragPos.top, zIndex: 45 } : { zIndex: 45 }}
    >
      {/* 标题栏（拖拽把手） */}
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex cursor-grab touch-none select-none items-center gap-1.5 border-b border-white/5 px-2.5 py-2 active:cursor-grabbing"
        title="按住此处拖动窗口"
      >
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-600" />
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100">
          AI 追问区
        </span>
        <button
          type="button"
          title="关闭"
          onClick={onClose}
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-[420px] space-y-2.5 overflow-y-auto px-3 py-3">
        {/* 模板导入 */}
        <div className="flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <Select value={templateId} onValueChange={handleTemplatePick}>
            <SelectTrigger className="h-7 flex-1 border-white/10 bg-white/5 text-xs text-slate-200">
              <SelectValue placeholder="导入提问模板（可留空自由提问）" />
            </SelectTrigger>
            <SelectContent className="z-[1000]">
              <SelectItem value="none">自由提问（不使用模板）</SelectItem>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 问题输入 */}
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={
            currentTerm
              ? `围绕「${currentTerm}」提问…（Ctrl+Enter 发送）`
              : "输入你的问题…（Ctrl+Enter 发送）"
          }
          className="min-h-[88px] w-full resize-y rounded-md border border-white/10 bg-white/5 px-2.5 py-2 text-xs leading-5 text-slate-100 outline-none placeholder:text-slate-500 focus:border-emerald-400/50"
          maxLength={4000}
        />

        {/* 发送 */}
        <Button
          size="sm"
          className="h-7 w-full gap-1.5 border-emerald-400/40 bg-emerald-500/15 text-xs text-emerald-100 hover:bg-emerald-500/25"
          variant="outline"
          disabled={!question.trim() || loading}
          onClick={() => void handleSend()}
        >
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              思考中…
            </>
          ) : (
            <>
              <Send className="h-3.5 w-3.5" />
              发送给模型
            </>
          )}
        </Button>

        {/* 错误 */}
        {error && (
          <p className="rounded-md border border-red-400/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-300">
            {error}
          </p>
        )}

        {/* 回答 */}
        {answer && (
          <div className="rounded-md border border-emerald-400/25 bg-emerald-400/5 px-2.5 py-2">
            <p className="whitespace-pre-wrap text-xs leading-6 text-slate-200">
              {answer}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
