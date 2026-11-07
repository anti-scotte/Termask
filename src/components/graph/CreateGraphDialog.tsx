// src/components/graph/CreateGraphDialog.tsx
// 新建图谱弹窗：名称输入 + 图谱模板三选一（卡片式，带配色预览）
//
// - 模板卡片：色点 + 名称 + 说明，选中态模板色描边 + 浅色底
// - Enter 提交、Esc 关闭；名称为空时禁用确定按钮

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GraphTemplate } from "@/types/graph";
import { TEMPLATE_META } from "@/types/graph";

const TEMPLATE_ORDER: GraphTemplate[] = ["free", "tree", "chain", "flow", "venn"];

/** 模板缩略预览（mini SVG：发散 / 链条 / 相交圆，示意结构而非装饰图） */
function TemplateThumb({ t, color }: { t: GraphTemplate; color: string }) {
  return (
    <svg width="56" height="36" viewBox="0 0 56 36" aria-hidden className="shrink-0">
      {t === "free" && (
        <>
          <circle cx="28" cy="18" r="5" fill={color} opacity="0.9" />
          {[0, 60, 120, 180, 240, 300].map((deg) => {
            const rad = (deg * Math.PI) / 180;
            const x = 28 + Math.cos(rad) * 20;
            const y = 18 + Math.sin(rad) * 12;
            return (
              <g key={deg}>
                <line x1="28" y1="18" x2={x} y2={y} stroke={color} strokeWidth="1" opacity="0.5" />
                <rect x={x - 3} y={y - 2} width="6" height="4" rx="1" fill="none" stroke={color} strokeWidth="1" opacity="0.8" />
              </g>
            );
          })}
        </>
      )}
      {t === "chain" && (
        <>
          {[6, 21, 36].map((x, i) => (
            <g key={x}>
              <rect x={x} y="13" width="9" height="10" rx="2" fill="none" stroke={color} strokeWidth="1.2" opacity="0.9" />
              {i < 2 && (
                <line x1={x + 9} y1="18" x2={x + 15} y2="18" stroke={color} strokeWidth="1.2" opacity="0.7" />
              )}
            </g>
          ))}
          <path d="M 45 18 l 5 0" stroke={color} strokeWidth="1.2" opacity="0.7" />
          <path d="M 50 15.5 l 4 2.5 l -4 2.5 z" fill={color} opacity="0.9" />
        </>
      )}
      {t === "venn" && (
        <>
          <circle cx="22" cy="18" r="12" fill={color} opacity="0.18" stroke={color} strokeWidth="1.2" />
          <circle cx="34" cy="18" r="12" fill={color} opacity="0.18" stroke={color} strokeWidth="1.2" />
          <rect x="25" y="15.5" width="6" height="5" rx="1" fill="none" stroke={color} strokeWidth="1" opacity="0.9" />
        </>
      )}
      {t === "flow" && (
        <>
          {/* 胶囊开始 → 矩形工序 → 菱形判断 → 输出 */}
          <rect x="3" y="13" width="10" height="10" rx="5" fill="none" stroke={color} strokeWidth="1.2" opacity="0.9" />
          <rect x="19" y="12.5" width="10" height="11" rx="1.5" fill="none" stroke={color} strokeWidth="1.2" opacity="0.9" />
          <path d="M 36 11 l 6 6 l -6 6 l -6 -6 z" fill="none" stroke={color} strokeWidth="1.2" opacity="0.9" />
          <line x1="13" y1="18" x2="19" y2="18" stroke={color} strokeWidth="1" opacity="0.6" />
          <line x1="29" y1="18" x2="30" y2="18" stroke={color} strokeWidth="1" opacity="0.6" />
          <line x1="42" y1="18" x2="47" y2="18" stroke={color} strokeWidth="1" opacity="0.6" />
          <path d="M 47 15.5 l 4 2.5 l -4 2.5 z" fill={color} opacity="0.9" />
        </>
      )}
      {t === "tree" && (
        <>
          {/* 根 → 三分支 → 叶（树状散射） */}
          <rect x="24" y="3" width="8" height="5" rx="1.5" fill="none" stroke={color} strokeWidth="1.1" />
          <path d="M 28 8 v 3 m 0 0 l -16 4 m 16 -4 l 16 4 m -16 -4 v 4" fill="none" stroke={color} strokeWidth="1" opacity="0.6" />
          <rect x="8" y="15" width="8" height="4.5" rx="1" fill="none" stroke={color} strokeWidth="1" opacity="0.85" />
          <rect x="24" y="15" width="8" height="4.5" rx="1" fill="none" stroke={color} strokeWidth="1" opacity="0.85" />
          <rect x="40" y="15" width="8" height="4.5" rx="1" fill="none" stroke={color} strokeWidth="1" opacity="0.85" />
          <path d="M 12 19.5 v 2.5 m 16 -2.5 v 2.5 m 16 -2.5 v 2.5" stroke={color} strokeWidth="0.9" opacity="0.5" />
          <rect x="9" y="25" width="6" height="4" rx="1" fill="none" stroke={color} strokeWidth="0.9" opacity="0.7" />
          <rect x="17" y="25" width="6" height="4" rx="1" fill="none" stroke={color} strokeWidth="0.9" opacity="0.7" />
          <rect x="25" y="25" width="6" height="4" rx="1" fill="none" stroke={color} strokeWidth="0.9" opacity="0.7" />
          <rect x="33" y="25" width="6" height="4" rx="1" fill="none" stroke={color} strokeWidth="0.9" opacity="0.7" />
          <rect x="41" y="25" width="6" height="4" rx="1" fill="none" stroke={color} strokeWidth="0.9" opacity="0.7" />
        </>
      )}
    </svg>
  );
}

interface CreateGraphDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 确认创建（名称已 trim） */
  onCreate: (name: string, template: GraphTemplate) => void;
  /** 默认选中的模板（个性化设置 defaultTemplate） */
  defaultTemplate?: GraphTemplate;
}

export function CreateGraphDialog({
  open,
  onOpenChange,
  onCreate,
  defaultTemplate = "free",
}: CreateGraphDialogProps) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<GraphTemplate>(defaultTemplate);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开重置表单并聚焦
  useEffect(() => {
    if (open) {
      setName("");
      setTemplate(defaultTemplate);
      // 等 Dialog 动画开始后再聚焦
      const t = window.setTimeout(() => inputRef.current?.focus(), 80);
      return () => window.clearTimeout(t);
    }
  }, [open, defaultTemplate]);

  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), template);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建图谱</DialogTitle>
          <DialogDescription>
            选择一个图谱模板，浏览器扩展推送的概念将按模板着色与布局。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* 名称 */}
          <div className="space-y-1.5">
            <label
              htmlFor="graph-name"
              className="text-sm font-medium text-foreground"
            >
              图谱名称
            </label>
            <Input
              id="graph-name"
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="例如：操作系统核心概念"
              maxLength={40}
            />
          </div>

          {/* 模板选择 */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">图谱模板</span>
            <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label="图谱模板">
              {TEMPLATE_ORDER.map((t) => {
                const meta = TEMPLATE_META[t];
                const active = template === t;
                return (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTemplate(t)}
                    className={`
                      flex items-center gap-3 rounded-lg border p-3 text-left
                      transition-all duration-150 cursor-pointer
                      hover:bg-accent/50
                      ${active ? "border-transparent" : "border-border"}
                    `}
                    style={
                      active
                        ? { boxShadow: `0 0 0 2px ${meta.dot}99` }
                        : undefined
                    }
                  >
                    <TemplateThumb t={t} color={meta.dot} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">
                        {meta.label}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {meta.desc}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!name.trim()}>
            创建图谱
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
