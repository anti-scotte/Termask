// src/components/models/ConnectionStatusBadge.tsx
// 连接状态徽章：idle / testing / success（延迟 ms）/ error
// 状态切换时通过 key 重挂载触发入场动画（fade + 上滑）

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/stores/useModelStore";

interface ConnectionStatusBadgeProps {
  status?: ConnectionStatus;
  /** 详细模式：成功时展示模型回显、失败时完整换行展示错误信息（表单弹窗用） */
  detailed?: boolean;
  className?: string;
}

export function ConnectionStatusBadge({
  status,
  detailed = false,
  className,
}: ConnectionStatusBadgeProps) {
  const s: ConnectionStatus = status ?? { state: "idle" };

  return (
    <div
      // key 变化 → 节点重挂载 → 入场动画重新触发；
      // 任何新结果必然经过 testing 态，因此按 state 作 key 即可保证每次都重放动画
      key={s.state}
      className={cn(
        "animate-in fade-in slide-in-from-bottom-1 duration-300 fill-mode-both",
        className,
      )}
    >
      {s.state === "idle" && (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
          未测试
        </span>
      )}

      {s.state === "testing" && (
        <span className="inline-flex animate-pulse items-center gap-1.5 rounded-md border border-sky-400/30 bg-sky-400/10 px-2 py-1 text-xs text-sky-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在测试连接…
        </span>
      )}

      {s.state === "success" && (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-xs text-emerald-400">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            连接成功
          </span>
          <span className="rounded bg-emerald-400/15 px-1.5 py-px font-mono tabular-nums">
            {s.latencyMs}ms
          </span>
          {detailed && s.modelEcho && (
            <span className="w-full text-[11px] text-emerald-400/80">
              模型回显：{s.modelEcho}
            </span>
          )}
        </span>
      )}

      {s.state === "error" && (
        <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-red-400/30 bg-red-400/10 px-2 py-1 text-xs text-red-400">
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <XCircle className="h-3.5 w-3.5" />
            连接失败
          </span>
          <span
            className={cn(
              "min-w-0 break-all text-[11px] text-red-400/85",
              !detailed && "line-clamp-1",
            )}
            title={detailed ? undefined : s.message}
          >
            {s.message}
          </span>
        </span>
      )}
    </div>
  );
}
