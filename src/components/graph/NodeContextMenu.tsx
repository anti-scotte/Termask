// src/components/graph/NodeContextMenu.tsx
// 节点右键菜单：删除 / 更换图标 / 外观（形状·颜色·大小）/ 词语类型 / AI 操作
//
// 设计：
//   - fixed 定位 + 视口边缘翻转（右/下溢出时左/上弹）
//   - 图标网格来自 iconPalette 白名单（分 4 组），点击选中再次点击取消
//   - 形状 5 选 / 颜色 8 色 + 「恢复模板默认」 / 大小 3 档
//   - 词语类型 5 类（KIND_META），手动设置后 kindSource=manual、收纳区同步
//   - AI 两项委托 GraphPage（复用 analyze_single_concept 链路与浮窗）

import { useEffect, useRef } from "react";
import {
  Trash2,
  Palette,
  Shapes,
  Type,
  Sparkles,
  X,
} from "lucide-react";
import type { ConceptKind, NodeShape } from "@/types/graph";
import {
  CONCEPT_KINDS,
  KIND_META,
  NODE_COLOR_PALETTE,
  SHAPE_LEGEND,
} from "@/types/graph";
import { ICON_GROUPS } from "@/components/graph/iconPalette";

export const NODE_SHAPES: { id: NodeShape; label: string }[] = [
  { id: "card", label: "卡片" },
  { id: "circle", label: "圆形" },
  { id: "pill", label: "胶囊" },
  { id: "diamond", label: "菱形" },
  { id: "note", label: "便签" },
];

export const SIZE_OPTIONS: { value: number; label: string }[] = [
  { value: 0.8, label: "小" },
  { value: 1, label: "标准" },
  { value: 1.25, label: "大" },
];

interface NodeContextMenuProps {
  x: number;
  y: number;
  label: string;
  currentIcon?: string;
  currentShape?: NodeShape;
  currentColor?: string;
  currentSize?: number;
  currentKind?: ConceptKind;
  onClose: () => void;
  onDelete: () => void;
  onSetIcon: (icon: string | undefined) => void;
  onSetShape: (shape: NodeShape) => void;
  onSetColor: (color: string | undefined) => void;
  onSetSize: (scale: number) => void;
  onSetKind: (kind: ConceptKind) => void;
  onExplain: () => void;
  onAnalyzeContext: () => void;
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-white/5 px-3 py-2 last:border-b-0">
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {icon}
        {title}
      </p>
      {children}
    </div>
  );
}

export function NodeContextMenu(props: NodeContextMenuProps) {
  const {
    x,
    y,
    label,
    currentIcon,
    currentShape,
    currentColor,
    currentSize,
    currentKind,
    onClose,
    onDelete,
    onSetIcon,
    onSetShape,
    onSetColor,
    onSetSize,
    onSetKind,
    onExplain,
    onAnalyzeContext,
  } = props;

  const ref = useRef<HTMLDivElement | null>(null);

  // 点击菜单外关闭；Esc 关闭
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 视口边缘翻转（菜单约 260×520）
  const flipX = x + 280 > window.innerWidth;
  const flipY = y + 540 > window.innerHeight;

  const itemCls =
    "cursor-pointer rounded-md px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-white/10 hover:text-white";

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`节点「${label}」操作菜单`}
      className="fixed z-[1000] max-h-[85vh] w-[264px] overflow-y-auto rounded-lg border border-border/80 bg-[rgba(20,20,30,0.96)] shadow-2xl backdrop-blur animate-in fade-in zoom-in-95 fill-mode-both duration-150"
      style={{
        left: flipX ? x - 280 : x,
        top: flipY ? y - 540 : y,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 标题 */}
      <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100">
          {label || "（空节点）"}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-500 hover:bg-white/10 hover:text-slate-200"
          title="关闭"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* AI 操作 */}
      <Section icon={<Sparkles className="h-3 w-3" />} title="AI 助学">
        <div className="flex flex-col gap-0.5">
          <button type="button" className={itemCls} onClick={onExplain}>
            AI 解释词语含义
          </button>
          <button type="button" className={itemCls} onClick={onAnalyzeContext}>
            AI 分析上下文作用
          </button>
        </div>
      </Section>

      {/* 词语类型 */}
      <Section icon={<Type className="h-3 w-3" />} title="词语类型">
        <div className="flex flex-wrap gap-1">
          {CONCEPT_KINDS.map((k) => {
            const meta = KIND_META[k];
            const active = currentKind === k;
            return (
              <button
                key={k}
                type="button"
                title={meta.desc}
                onClick={() => {
                  onSetKind(k);
                  onClose();
                }}
                className={`cursor-pointer rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  active
                    ? "border-transparent text-white"
                    : "border-white/10 text-slate-300 hover:bg-white/10"
                }`}
                style={active ? { background: meta.color } : undefined}
              >
                <span
                  className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                  style={{ background: active ? "#fff" : meta.color }}
                  aria-hidden
                />
                {meta.label}
              </button>
            );
          })}
        </div>
        {/* 注释区：读取注释即可知晓该类型图标的含义 */}
        <p className="mt-1.5 rounded bg-white/5 px-2 py-1 text-[10px] leading-relaxed text-slate-400">
          {currentKind
            ? `${KIND_META[currentKind].label}：${KIND_META[currentKind].desc}`
            : "选择一种类型：角标颜色即分类色，词条会归入词库对应分组"}
        </p>
      </Section>

      {/* 更换图标 */}
      <Section icon={<Palette className="h-3 w-3" />} title="更换图标">
        <div className="space-y-1.5">
          {ICON_GROUPS.map((g) => (
            <div key={g.group} className="flex items-center gap-1">
              <span className="w-7 shrink-0 text-[10px] text-slate-500">
                {g.group}
              </span>
              <div className="flex flex-wrap gap-0.5">
                {g.icons.map(({ name, label: iconLabel, Icon }) => (
                  <button
                    key={name}
                    type="button"
                    title={iconLabel}
                    onClick={() => {
                      onSetIcon(currentIcon === name ? undefined : name);
                      onClose();
                    }}
                    className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors ${
                      currentIcon === name
                        ? "bg-sky-500/40 text-white"
                        : "text-slate-400 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* 外观：形状 / 颜色 / 大小 */}
      <Section icon={<Shapes className="h-3 w-3" />} title="外观">
        <div className="space-y-1.5">
          {/* 形状 */}
          <div className="flex items-center gap-1">
            <span className="w-7 shrink-0 text-[10px] text-slate-500">形状</span>
            {NODE_SHAPES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onSetShape(s.id);
                  onClose();
                }}
                className={`${itemCls} ${
                  (currentShape ?? "card") === s.id
                    ? "bg-sky-500/40 text-white"
                    : ""
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {/* 颜色 */}
          <div className="flex items-center gap-1">
            <span className="w-7 shrink-0 text-[10px] text-slate-500">颜色</span>
            <div className="flex flex-wrap gap-1">
              {NODE_COLOR_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={`设为 ${c}`}
                  onClick={() => {
                    onSetColor(currentColor === c ? undefined : c);
                    onClose();
                  }}
                  className={`h-4 w-4 cursor-pointer rounded-full border transition-transform hover:scale-110 ${
                    currentColor === c ? "border-white ring-1 ring-white" : "border-white/20"
                  }`}
                  style={{ background: c }}
                  aria-label={`颜色 ${c}`}
                />
              ))}
            </div>
          </div>
          {/* 大小 */}
          <div className="flex items-center gap-1">
            <span className="w-7 shrink-0 text-[10px] text-slate-500">大小</span>
            {SIZE_OPTIONS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => {
                  onSetSize(s.value);
                  onClose();
                }}
                className={`${itemCls} ${
                  (currentSize ?? 1) === s.value
                    ? "bg-sky-500/40 text-white"
                    : ""
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {/* 形状注释区：一眼区分形状语义 */}
          <p className="mt-1 rounded bg-white/5 px-2 py-1 text-[10px] leading-relaxed text-slate-400">
            {SHAPE_LEGEND.map((s) => `${s.label}=${s.note}`).join(" · ")}
          </p>
        </div>
      </Section>

      {/* 删除 */}
      <div className="px-3 py-2">
        <button
          type="button"
          onClick={() => {
            onDelete();
            onClose();
          }}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/15 hover:text-red-200"
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除节点（Delete 可撤销）
        </button>
      </div>
    </div>
  );
}
