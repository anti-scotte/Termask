// src/components/whiteboard/PalettePanel.tsx
// 白板调色盘悬浮窗 v2（替代 tldraw 原生右侧 StylePanel）
//
// v2 修复「调色盘无法使用」：旧实现把 getStyleForNextShape 的结果在渲染时
// 读一次，点击色板后组件不重渲染 → 选中态永远不变 → 看起来完全失效。
// 现在：apply() 后本地 bump + store.listen 节流订阅，任何样式/选中变化都会刷新 UI。
//
// 手写笔：钢笔 / 水笔 / 荧光笔 三种笔型（预设 粗细×透明度 组合），
//         叠加 粗细 S~XL、13 色可再调；作用于选中形状或下一个新形状。
// 交互：react-rnd 拖拽 / 折叠成悬浮球（位置记忆）/ 滚轮缩放内容。

import { useCallback, useEffect, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultSizeStyle,
} from "tldraw";
import type { Editor } from "tldraw";
import { ChevronRight, Eraser, Palette, PenLine, Pin, X } from "lucide-react";

/** tldraw 16 色的预览近似色（实际样式由 tldraw 主题渲染，此处仅作 swatch UI） */
const SWATCHES: Array<{ name: string; hex: string }> = [
  { name: "black", hex: "#1d1d1d" },
  { name: "grey", hex: "#939393" },
  { name: "light-violet", hex: "#c6c9f0" },
  { name: "violet", hex: "#7b70ec" },
  { name: "light-blue", hex: "#8fd5f2" },
  { name: "blue", hex: "#3b82f6" },
  { name: "light-green", hex: "#a7e39c" },
  { name: "green", hex: "#2fa96c" },
  { name: "yellow", hex: "#f2c31d" },
  { name: "orange", hex: "#f5790a" },
  { name: "light-red", hex: "#f2a3a8" },
  { name: "red", hex: "#e2382a" },
  { name: "white", hex: "#ffffff" },
];

const FILLS = [
  { value: "none", label: "无" },
  { value: "semi", label: "半" },
  { value: "solid", label: "全" },
  { value: "pattern", label: "纹" },
] as const;

const DASHES = [
  { value: "solid", label: "实线" },
  { value: "dashed", label: "虚线" },
  { value: "dotted", label: "点线" },
  { value: "draw", label: "手绘" },
] as const;

const SIZES = [
  { value: "s", label: "细" },
  { value: "m", label: "中" },
  { value: "l", label: "粗" },
  { value: "xl", label: "特粗" },
] as const;

/** 三种笔型：预设 粗细 × 透明度 组合（可再叠加粗细/颜色微调） */
const PEN_TYPES = [
  {
    id: "fountain",
    label: "钢笔",
    desc: "细线 · 全不透明，书写感",
    size: "s",
    opacity: 1,
    dash: "solid",
  },
  {
    id: "gel",
    label: "水笔",
    desc: "中等 · 近全不透明，日常顺滑",
    size: "m",
    opacity: 0.9,
    dash: "solid",
  },
  {
    id: "highlighter",
    label: "荧光笔",
    desc: "粗线 · 半透明，划重点不遮字",
    size: "l",
    opacity: 0.35,
    dash: "solid",
  },
] as const;

type PenTypeId = (typeof PEN_TYPES)[number]["id"];

/** 折叠球位置的本地持久化 key */
const BALL_POS_KEY = "termask-palette-ball";

export function PalettePanel({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(true);
  /** 内容滚轮缩放（0.6 ~ 1.8） */
  const [uiScale, setUiScale] = useState(1);
  /** 折叠球位置（右缘绝对定位 px） */
  const [ballPos, setBallPos] = useState<{ top: number }>({ top: 160 });
  /** 初始窗口位置（贴宿主右上；宿主宽度挂载后量取） */
  const [initPos, setInitPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startY: number; top: number } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  /** 当前笔型（本地 UI 状态；实际样式落在 editor 上） */
  const [penType, setPenType] = useState<PenTypeId>("gel");
  /** 笔型 ref：供 store.listen 回调读取最新值（不触发重渲染） */
  const penTypeRef = useRef<PenTypeId>("gel");

  /**
   * v2 关键修复：强制重渲染 tick。
   * tldraw editor 是外部可变实例，样式/选中变化不会触发 React 渲染；
   * store.listen 节流 bump + apply 后立即 bump，保证 UI 与编辑器状态同步。
   */
  const [, setTick] = useState(0);
  const lastTickRef = useRef(0);
  useEffect(() => {
    const unlisten = editor.store.listen(
      () => {
        const now = Date.now();
        if (now - lastTickRef.current < 150) return; // 节流：拖拽/连续输入期间不刷
        lastTickRef.current = now;
        setTick((t) => t + 1);
      },
      { scope: "all" },
    );
    return () => unlisten();
  }, [editor]);

  /**
   * 荧光笔自动降透明度：tldraw 无全局 opacity style（opacity 是形状 prop），
   * 无法 setStyleForNextShapes —— 改为监听新建 draw 笔迹，落笔即改为半透明。
   * 只处理 added（updated 分支不碰，避免回环）。
   */
  useEffect(() => {
    const unlisten = editor.store.listen(
      (entry) => {
        if (penTypeRef.current !== "highlighter") return;
        if (entry.source !== "user") return;
        const added = entry.changes.added ?? {};
        const drawIds = Object.values(added)
          .filter(
            (s) =>
              s?.typeName === "shape" &&
              (s as { type?: string }).type === "draw",
          )
          .map((s) => (s as { id: string }).id);
        if (drawIds.length === 0) return;
        editor.updateShapes(
          drawIds.map((id) => ({
            id,
            props: { opacity: 0.35 },
          })) as unknown as Parameters<Editor["updateShapes"]>[0],
        );
      },
      { scope: "document" },
    );
    return () => unlisten();
  }, [editor]);

  /* 量取宿主宽度，计算初始右上位置 */
  useEffect(() => {
    const r = hostRef.current?.getBoundingClientRect();
    if (r) setInitPos({ x: Math.max(8, r.width - 252), y: 56 });
  }, []);

  /* 恢复折叠球位置 */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(BALL_POS_KEY);
      if (raw) {
        const v = JSON.parse(raw) as { top?: number };
        if (typeof v.top === "number") setBallPos({ top: v.top });
      }
    } catch {
      /* 忽略 */
    }
  }, []);

  /** 把样式应用到选中形状（无选中 → 作用于下一个新形状） */
  const apply = useCallback(
    (patch: Record<string, unknown>, bump = true) => {
      const ids = [...editor.getSelectedShapeIds()];
      if (ids.length > 0) {
        // props 走宽化：tldraw 的 updateShapes 入参是按形状类型判别的联合
        editor.updateShapes(
          ids.map((id) => ({ id, props: patch })) as Parameters<
            Editor["updateShapes"]
          >[0],
        );
      }
      if (typeof patch.color === "string") {
        editor.setStyleForNextShapes(
          DefaultColorStyle,
          patch.color as never,
        );
      }
      if (typeof patch.fill === "string") {
        editor.setStyleForNextShapes(DefaultFillStyle, patch.fill as never);
      }
      if (typeof patch.dash === "string") {
        editor.setStyleForNextShapes(DefaultDashStyle, patch.dash as never);
      }
      if (typeof patch.size === "string") {
        editor.setStyleForNextShapes(DefaultSizeStyle, patch.size as never);
      }
      if (bump) setTick((t) => t + 1); // 立即刷新选中态
    },
    [editor],
  );

  /** 切换笔型：预设组合一次性应用（透明度靠自动降透明监听对新笔迹生效） */
  const applyPenType = useCallback(
    (id: PenTypeId) => {
      const p = PEN_TYPES.find((x) => x.id === id);
      if (!p) return;
      setPenType(id);
      penTypeRef.current = id;
      apply({ size: p.size, dash: p.dash, opacity: p.opacity });
    },
    [apply],
  );

  /** 当前生效样式（取"下一个形状"风格；store.listen 已保证组件随时重渲染） */
  const curColor = editor.getStyleForNextShape(DefaultColorStyle);
  const curFill = editor.getStyleForNextShape(DefaultFillStyle);
  const curDash = editor.getStyleForNextShape(DefaultDashStyle);
  const curSize = editor.getStyleForNextShape(DefaultSizeStyle);
  /** 透明度显示跟随当前笔型（新笔迹由监听自动落透明度） */
  const curOpacity =
    PEN_TYPES.find((p) => p.id === penType)?.opacity ?? 1;

  /* 滚轮缩放面板内容 */
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setUiScale((s) =>
      Math.min(1.8, Math.max(0.6, s + (e.deltaY < 0 ? 0.08 : -0.08))),
    );
  }, []);

  /* 折叠球拖动（pointer capture，仅纵向跟随） */
  const onBallPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, top: ballPos.top };
  };
  const onBallPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const next = Math.min(
      window.innerHeight - 80,
      Math.max(64, dragRef.current.top + (e.clientY - dragRef.current.startY)),
    );
    setBallPos({ top: next });
  };
  const onBallPointerUp = (e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (dragRef.current) {
      localStorage.setItem(BALL_POS_KEY, JSON.stringify(ballPos));
      dragRef.current = null;
    }
  };

  if (!initPos) {
    // 宿主测量层：铺满画布容器（pointer-events 关闭，纯量取用）
    return (
      <div ref={hostRef} className="pointer-events-none absolute inset-0" />
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {!open ? (
        <div
          className="pointer-events-auto absolute right-2 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg transition-colors hover:border-violet-400/60 hover:text-violet-500"
          style={{ top: ballPos.top }}
          title="展开调色盘"
          onPointerDown={onBallPointerDown}
          onPointerMove={onBallPointerMove}
          onPointerUp={onBallPointerUp}
          onClick={() => setOpen(true)}
        >
          <Palette size={18} />
        </div>
      ) : (
        <Rnd
          default={{
            x: initPos.x,
            y: initPos.y,
            width: 236,
            height: "auto",
          }}
          bounds="parent"
          dragHandleClassName="palette-drag-handle"
          enableResizing={{ bottomRight: true }}
          minWidth={200}
          minHeight={180}
          style={{ zIndex: 30, pointerEvents: "auto" }}
        >
          <div className="flex max-h-full flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
            {/* 标题栏（拖拽手柄） */}
            <header className="palette-drag-handle flex cursor-move items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
              <Palette size={14} className="text-violet-500" />
              <span className="text-xs font-medium">调色盘</span>
              <span className="flex-1" />
              <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                {Math.round(uiScale * 100)}%
              </span>
              <button
                type="button"
                title="收起到悬浮球"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                <Pin size={12} />
              </button>
              <button
                type="button"
                title="关闭（可用悬浮球重新打开）"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                <X size={13} />
              </button>
            </header>

            {/* 内容（滚轮缩放） */}
            <div onWheel={onWheel}>
              <div
                style={{
                  transform: `scale(${uiScale})`,
                  transformOrigin: "top left",
                }}
                className="w-[236px] space-y-3 p-3"
              >
                {/* 手写笔型 */}
                <section>
                  <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                    <PenLine size={11} />
                    手写笔
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {PEN_TYPES.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        title={p.desc}
                        onClick={() => applyPenType(p.id)}
                        className={
                          "rounded-md border px-1 py-1.5 text-[11px] transition-colors " +
                          (penType === p.id
                            ? "border-foreground bg-muted font-medium"
                            : "border-border hover:bg-muted/60")
                        }
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-muted-foreground/70">
                    {PEN_TYPES.find((p) => p.id === penType)?.desc}
                  </p>
                </section>

                {/* 颜色 */}
                <section>
                  <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                    颜色
                  </div>
                  <div className="grid grid-cols-7 gap-1.5">
                    {SWATCHES.map((s) => (
                      <button
                        key={s.name}
                        type="button"
                        title={s.name}
                        onClick={() => apply({ color: s.name })}
                        className={
                          "h-6 w-6 rounded-md border transition-transform hover:scale-110 " +
                          (curColor === s.name
                            ? "border-foreground ring-2 ring-ring/50"
                            : "border-border")
                        }
                        style={{
                          background: s.hex,
                          boxShadow:
                            s.name === "white"
                              ? "inset 0 0 0 1px rgba(0,0,0,.15)"
                              : undefined,
                        }}
                      />
                    ))}
                  </div>
                </section>

                {/* 粗细（笔触大小） */}
                <section>
                  <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                    粗细
                  </div>
                  <div className="flex gap-1">
                    {SIZES.map((sz) => (
                      <button
                        key={sz.value}
                        type="button"
                        onClick={() => apply({ size: sz.value })}
                        className={
                          "flex-1 rounded-md border py-1 text-[11px] transition-colors " +
                          (curSize === sz.value
                            ? "border-foreground bg-muted font-medium"
                            : "border-border hover:bg-muted/60")
                        }
                      >
                        {sz.label}
                      </button>
                    ))}
                  </div>
                  {/* 笔迹预览条：宽度示意当前粗细 + 透明度 */}
                  <div className="mt-1.5 flex h-2.5 items-center rounded bg-muted/50 px-1.5">
                    <span
                      className="h-1.5 rounded-full"
                      style={{
                        width:
                          curSize === "s"
                            ? "25%"
                            : curSize === "m"
                              ? "50%"
                              : curSize === "l"
                                ? "75%"
                                : "100%",
                        background: "currentColor",
                        opacity: typeof curOpacity === "number" ? curOpacity : 1,
                      }}
                    />
                  </div>
                </section>

                {/* 填充 */}
                <section>
                  <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                    填充
                  </div>
                  <div className="flex gap-1">
                    {FILLS.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        onClick={() => apply({ fill: f.value })}
                        className={
                          "flex-1 rounded-md border px-1 py-1 text-[11px] transition-colors " +
                          (curFill === f.value
                            ? "border-foreground bg-muted font-medium"
                            : "border-border hover:bg-muted/60")
                        }
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </section>

                {/* 线型 */}
                <section>
                  <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                    <Eraser size={11} className="opacity-60" />
                    线型
                  </div>
                  <div className="flex gap-1">
                    {DASHES.map((d) => (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => apply({ dash: d.value })}
                        className={
                          "flex-1 rounded-md border px-1 py-1 text-[11px] transition-colors " +
                          (curDash === d.value
                            ? "border-foreground bg-muted font-medium"
                            : "border-border hover:bg-muted/60")
                        }
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </section>

                <p className="flex items-center gap-1 text-[10px] leading-4 text-muted-foreground">
                  <ChevronRight size={10} />
                  有选中形状时直接改选中；无选中时作用于下一个新形状
                </p>
              </div>
            </div>
          </div>
        </Rnd>
      )}
    </div>
  );
}
