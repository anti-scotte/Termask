// src/components/graph/WordLibraryPanel.tsx
// 词库收纳区：图谱区 / 收集区之外的第三个区域
//
// 分门别类收纳概念词（按 ConceptKind 五类分组）：
//   - 条目可拖入画布（复用 TERM_MIME 协议，与收集区词条同一拖拽通路）
//   - 点击条目 → 定位关联画布节点（有 nodeId 时）
//   - 类型角标可点击循环换组？（否——类型修改走画布右键菜单，此处只读展示）
//   - 词条来源：画布节点填充时自动登记（upsert），删除节点自动解除关联

import { useState } from "react";
import { Library, X, GripVertical } from "lucide-react";
import type { ConceptKind } from "@/types/graph";
import { CONCEPT_KINDS, KIND_META } from "@/types/graph";
import { useWordLibraryStore, type WordEntry } from "@/stores/useWordLibraryStore";

const TERM_MIME = "application/termask-term";

interface WordLibraryPanelProps {
  open: boolean;
  onClose: () => void;
  /** 点击条目：加入当前图谱（无关联节点新建 / 有关联节点定位） */
  onLocate: (entry: WordEntry) => void;
}

export function WordLibraryPanel({ open, onClose, onLocate }: WordLibraryPanelProps) {
  const entries = useWordLibraryStore((s) => s.entries);
  const remove = useWordLibraryStore((s) => s.remove);
  /** 折叠的类型组 */
  const [collapsed, setCollapsed] = useState<Set<ConceptKind>>(new Set());

  if (!open) return null;

  const toggleGroup = (k: ConceptKind) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  return (
    <aside
      data-word-library
      aria-label="词库收纳区"
      className="absolute inset-y-0 right-0 z-30 flex w-[36%] min-w-[320px] max-w-[480px] flex-col border-l border-border bg-card shadow-2xl animate-in fade-in slide-in-from-right-6 fill-mode-both duration-300"
    >
      {/* 头部 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
        <Library className="h-4 w-4 shrink-0 text-violet-400" />
        <h2 className="text-sm font-semibold text-foreground">词库收纳</h2>
        <span className="rounded-full bg-violet-400/10 px-2 py-0.5 text-[11px] text-violet-300">
          {entries.length} 个词条
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
          title="收起词库"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 分组列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <Library className="h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 text-xs text-muted-foreground/70">词库还是空的</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/50">
              在画布上填充概念词后会自动登记到这里，
              <br />
              右键节点可修改它的类型分类
            </p>
          </div>
        ) : (
          CONCEPT_KINDS.map((k) => {
            const meta = KIND_META[k];
            const group = entries.filter((e) => e.kind === k);
            if (group.length === 0) return null;
            const isCollapsed = collapsed.has(k);
            return (
              <div key={k} className="mb-2">
                {/* 组头 */}
                <button
                  type="button"
                  onClick={() => toggleGroup(k)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: meta.color }}
                    aria-hidden
                  />
                  <span className="text-xs font-medium text-foreground">
                    {meta.label}
                  </span>
                  <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {group.length}
                  </span>
                  <span className="flex-1" />
                  <span
                    className={`text-[10px] text-muted-foreground/60 transition-transform ${
                      isCollapsed ? "-rotate-90" : ""
                    }`}
                    aria-hidden
                  >
                    ▾
                  </span>
                </button>
                {/* 条目 */}
                {!isCollapsed && (
                  <div className="mt-0.5 space-y-0.5 pl-3">
                    {group.map((e) => (
                      <div
                        key={e.id}
                        draggable
                        onDragStart={(ev) => {
                          ev.dataTransfer.setData(TERM_MIME, e.term);
                          ev.dataTransfer.setData("text/plain", e.term);
                          ev.dataTransfer.effectAllowed = "copy";
                        }}
                        className="group flex cursor-grab items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-accent/30 active:cursor-grabbing"
                        title={`${e.term}\n类型：${meta.label}${e.kindSource === "manual" ? "（手动）" : "（自动识别）"}\n拖入画布创建节点${e.nodeId ? "，点击定位原节点" : ""}`}
                        onClick={() => onLocate(e)}
                      >
                        <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground/60" />
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
                          {e.term}
                        </span>
                        {e.kindSource === "manual" && (
                          <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">
                            手动
                          </span>
                        )}
                        <button
                          type="button"
                          title={`从词库移除「${e.term}」`}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            remove(e.term);
                          }}
                          className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground/40 opacity-0 transition-all hover:bg-red-500/20 hover:text-red-300 group-hover:opacity-100"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 底部说明 */}
      <div className="border-t border-border/60 px-4 py-2.5">
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          类型由启发式规则自动识别，右键画布节点可手动归类；
          词条可随时拖回画布
        </p>
      </div>
    </aside>
  );
}
