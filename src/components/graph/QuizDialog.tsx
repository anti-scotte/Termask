// src/components/graph/QuizDialog.tsx
// 图谱质量测验（v0.1.0）：把当前图谱投喂给大模型，用固定测评提示词
// 检验「模型能否读懂这张图」，记录 质量评分 + 用时 + 知识缺口。
//
// 评分来源：结构检验模板（defaultTemplates.ts 第 3 个）的 JSON 输出协议
// {"score":0-100,"summary":"...","gaps":[...]} —— 提示词里强制只输出一行 JSON，
// 前端做容错解析（提取首个 { 到末个 }）。
// 历史记录持久化在 localStorage（termask-graph-quiz），供跨次对比。

import { useEffect, useRef, useState } from "react";
import { ClipboardCheck, Loader2, Timer, Trophy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { askLlm } from "@/lib/bridge";
import { useModelStore } from "@/stores/useModelStore";
import type { FlowEdge, FlowNode } from "@/types/graph";

/** 测评历史条目 */
interface QuizRecord {
  at: number;
  score: number;
  elapsedMs: number;
  nodeCount: number;
  edgeCount: number;
  summary: string;
  gaps: string[];
}

const HISTORY_KEY = "termask-graph-quiz";

function loadHistory(): QuizRecord[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as QuizRecord[];
  } catch {
    return [];
  }
}

/** 从模型输出中容错提取评分 JSON */
function parseScore(raw: string): { score: number; summary: string; gaps: string[] } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      score?: number;
      summary?: string;
      gaps?: string[];
    };
    if (typeof obj.score !== "number") return null;
    return {
      score: Math.max(0, Math.min(100, Math.round(obj.score))),
      summary: obj.summary ?? "",
      gaps: Array.isArray(obj.gaps) ? obj.gaps.slice(0, 4) : [],
    };
  } catch {
    return null;
  }
}

interface QuizDialogProps {
  open: boolean;
  onClose: () => void;
  nodes: FlowNode[];
  edges: FlowEdge[];
  title: string;
}

export function QuizDialog({ open, onClose, nodes, edges, title }: QuizDialogProps) {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [record, setRecord] = useState<QuizRecord | null>(null);
  const [rawAnswer, setRawAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<QuizRecord[]>([]);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef(0);

  useEffect(() => {
    if (open) setHistory(loadHistory());
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [open]);

  const runQuiz = async () => {
    const concepts = nodes
      .filter((n) => n.type === "concept")
      .map((n) => String((n.data as { label?: string }).label ?? ""))
      .filter(Boolean);
    if (concepts.length < 2) {
      setError("图谱至少需要 2 个已填写概念词才能测评");
      return;
    }
    const provider = useModelStore.getState().getDefaultProvider();
    if (!provider) {
      setError("请先在「模型设置」添加并启用一个 Provider");
      return;
    }

    // 图谱概览：命题形式（A —关系→ B）
    const overview = [
      "节点：",
      ...concepts.map((c, i) => `${i + 1}. ${c}`),
      "",
      "关系：",
      ...edges.map((e) => {
        const s = nodes.find((n) => n.id === e.source);
        const t = nodes.find((n) => n.id === e.target);
        const label = (e.data as { label?: string })?.label ?? "关联";
        return `- ${s ? String((s.data as { label?: string }).label ?? "") : "?"} —${label}→ ${t ? String((t.data as { label?: string }).label ?? "") : "?"}`;
      }),
    ].join("\n");

    const question = `请作为概念图评审员，检验你能否读懂下面这张概念图谱，并按要求输出。
<图谱>${overview}</图谱>
1. 用 2-3 句话复述核心结构；
2. 指出 1-2 处结构问题（孤立节点/缺连接词/循环依赖/层级混乱）；
3. 提出 3 个检验性问题；
4. 最后一行只输出 JSON：{"score":0到100,"summary":"一句话总评","gaps":["缺口1","缺口2"]}`;

    setRunning(true);
    setError(null);
    setRecord(null);
    setRawAnswer(null);
    startRef.current = Date.now();
    timerRef.current = window.setInterval(
      () => setElapsed(Date.now() - startRef.current),
      200,
    );
    try {
      const r = await askLlm(question, "", {
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey ?? "",
        model: provider.model,
      });
      const elapsedMs = Date.now() - startRef.current;
      setRawAnswer(r);
      const parsed = parseScore(r);
      const rec: QuizRecord = {
        at: Date.now(),
        score: parsed?.score ?? 0,
        elapsedMs,
        nodeCount: concepts.length,
        edgeCount: edges.length,
        summary: parsed?.summary ?? "（模型未按协议输出评分 JSON）",
        gaps: parsed?.gaps ?? [],
      };
      setRecord(rec);
      const next = [rec, ...loadHistory()].slice(0, 20);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      setHistory(next);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes("unknown command") || msg.includes("找不到")
          ? "后端 ask_llm 命令尚未上线（见后端请求清单），上线后即可测评"
          : msg,
      );
    } finally {
      if (timerRef.current) window.clearInterval(timerRef.current);
      setRunning(false);
    }
  };

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-[500] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="max-h-[80%] w-[440px] overflow-hidden rounded-lg border border-amber-400/30 bg-[rgba(20,20,30,0.96)] shadow-2xl">
        {/* 头 */}
        <div className="flex items-center gap-2 border-b border-white/5 px-3.5 py-2.5">
          <ClipboardCheck className="h-4 w-4 text-amber-300" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
            图谱质量测验 · {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-slate-500 hover:bg-white/10 hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[440px] space-y-3 overflow-y-auto px-3.5 py-3">
          <p className="text-[11px] leading-relaxed text-slate-400">
            把当前图谱的节点与关系命题投喂给模型，用固定提示词检验模型能否读懂。
            评分越高说明结构越清晰（可读性代理指标）；用时反映模型消化成本。
          </p>

          <Button
            size="sm"
            className="h-8 w-full gap-1.5 border-amber-400/40 bg-amber-500/15 text-xs text-amber-100 hover:bg-amber-500/25"
            variant="outline"
            disabled={running}
            onClick={() => void runQuiz()}
          >
            {running ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                测评中… {Math.round(elapsed / 100) / 10}s
              </>
            ) : (
              <>
                <ClipboardCheck className="h-3.5 w-3.5" />
                开始测验（{nodes.filter((n) => n.type === "concept").length} 节点 · {edges.length} 关系）
              </>
            )}
          </Button>

          {error && (
            <p className="rounded-md border border-red-400/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
              {error}
            </p>
          )}

          {record && (
            <div className="space-y-2 rounded-md border border-amber-400/25 bg-amber-400/5 p-3">
              <div className="flex items-center gap-3">
                <Trophy className="h-5 w-5 text-amber-300" />
                <span className="text-2xl font-bold text-amber-200">
                  {record.score}
                  <span className="text-sm text-amber-400/70">/100</span>
                </span>
                <span className="ml-auto flex items-center gap-1 text-xs text-slate-400">
                  <Timer className="h-3.5 w-3.5" />
                  {(record.elapsedMs / 1000).toFixed(1)}s
                </span>
              </div>
              <p className="text-xs leading-relaxed text-slate-200">{record.summary}</p>
              {record.gaps.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-slate-400">知识缺口</p>
                  {record.gaps.map((g, i) => (
                    <p key={i} className="text-xs leading-5 text-slate-300">
                      · {g}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {rawAnswer && (
            <details className="rounded-md border border-white/10 px-2.5 py-1.5">
              <summary className="cursor-pointer text-[11px] text-slate-400">
                模型原始回答
              </summary>
              <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-5 text-slate-300">
                {rawAnswer}
              </p>
            </details>
          )}

          {history.length > 0 && (
            <div className="border-t border-white/5 pt-2">
              <p className="mb-1 text-[10px] font-medium text-slate-400">
                历史记录（最近 20 次）
              </p>
              <div className="space-y-0.5">
                {history.slice(0, 8).map((h, i) => (
                  <p key={h.at} className="flex justify-between text-[11px] text-slate-400">
                    <span>
                      #{history.length - i} · {h.score} 分 · {h.nodeCount} 节点
                    </span>
                    <span>
                      {new Date(h.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
