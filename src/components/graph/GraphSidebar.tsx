// src/components/graph/GraphSidebar.tsx
// 图谱列表侧边栏：切换当前图谱 / 新建入口 / 删除（两击确认，不用弹窗打断）
//
// 列表项：模板色点 + 名称 + 节点数 + 相对时间；当前项模板色左条 + 高亮底

import { useState } from "react";
import { Plus, Trash2, Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GraphDoc } from "@/stores/useGraphStore";
import { TEMPLATE_META } from "@/types/graph";

/** 相对时间（几分钟前 / 几小时前 / 日期） */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

interface GraphSidebarProps {
  graphs: GraphDoc[];
  currentGraphId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}

export function GraphSidebar({
  graphs,
  currentGraphId,
  onSelect,
  onDelete,
  onCreate,
}: GraphSidebarProps) {
  // 两击确认删除：记录待确认项，3 秒无操作自动复位
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const requestDelete = (id: string) => {
    if (pendingDeleteId === id) {
      onDelete(id);
      setPendingDeleteId(null);
    } else {
      setPendingDeleteId(id);
      window.setTimeout(
        () => setPendingDeleteId((cur) => (cur === id ? null : cur)),
        3000,
      );
    }
  };

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card">
      {/* 头部 */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Network className="h-4 w-4 text-muted-foreground" />
          图谱列表
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
            {graphs.length}
          </span>
        </h2>
        <Button size="sm" variant="default" className="h-7 gap-1 px-2.5 text-xs" onClick={onCreate}>
          <Plus className="h-3.5 w-3.5" />
          新建
        </Button>
      </div>

      {/* 列表 */}
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {graphs.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            还没有图谱
            <br />
            点击「新建」开始创建
          </p>
        )}

        {graphs.map((g) => {
          const meta = TEMPLATE_META[g.template];
          const active = g.id === currentGraphId;
          const confirming = pendingDeleteId === g.id;
          return (
            <div
              key={g.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(g.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect(g.id);
              }}
              className={`
                group relative flex cursor-pointer items-center gap-2.5
                rounded-lg border px-3 py-2.5 transition-all duration-150
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60
                ${
                  active
                    ? "border-sky-400/40 bg-sky-400/10"
                    : "border-transparent hover:border-border hover:bg-accent/40"
                }
              `}
            >
              {/* 模板色点 */}
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: meta.dot }}
                aria-hidden
              />

              <div className="min-w-0 flex-1">
                <p
                  className={`truncate text-sm ${
                    active ? "font-medium text-foreground" : "text-foreground/85"
                  }`}
                  title={g.name}
                >
                  {g.name}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {meta.label} · {g.nodes.length} 节点 · {relativeTime(g.updatedAt)}
                </p>
              </div>

              {/* 删除：两击确认 */}
              <button
                type="button"
                aria-label={confirming ? "再次点击确认删除" : `删除 ${g.name}`}
                title={confirming ? "再点一次确认删除" : "删除"}
                onClick={(e) => {
                  e.stopPropagation(); // 不触发切换
                  requestDelete(g.id);
                }}
                className={`
                  shrink-0 rounded p-1.5 transition-all duration-150 cursor-pointer
                  ${
                    confirming
                      ? "bg-red-500/15 text-red-400 opacity-100"
                      : "text-muted-foreground/0 group-hover:text-muted-foreground hover:!text-red-400 hover:bg-red-500/10"
                  }
                `}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>

              {/* 当前项左侧色条 */}
              {active && (
                <span
                  className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full"
                  style={{ background: meta.dot }}
                  aria-hidden
                />
              )}
            </div>
          );
        })}
      </div>

      {/* 底部提示 */}
      <div className="border-t border-border px-4 py-2.5">
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          扩展推送的概念图会写入当前选中的图谱
        </p>
      </div>
    </aside>
  );
}
