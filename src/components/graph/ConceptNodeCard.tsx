// src/components/graph/ConceptNodeCard.tsx
// 自定义概念节点组件（深色卡片审美 + 模板配色 + 模板填充框 + 图标系统）
//
// - 配色由 node.data.template 决定：自由发散=绿 / 逻辑链=蓝 / 韦恩图=紫 / 流程图=橙
// - 图标系统（右键菜单可调，全部可缺省回退模板样式）：
//     · icon          lucide 图标（iconPalette.ts 白名单），缺省按词语类型推导
//     · shape         节点形状：card 圆角卡 / circle 圆 / pill 胶囊 / diamond 菱形 / note 便签
//     · colorOverride 边框/图标强调色
//     · sizeScale     大小档位（映射字号与内边距，不用 transform 避免连线锚点错位）
//     · kind          词语类型（KIND_META 决定默认角标色）
// - 填充框（placeholder=true）：虚线空框 + 槽位语义标签，单击进编辑态或拖词填充
// - 四向 Handle：支持自由连线（top/left 为 target，bottom/right 为 source）

import { memo, useEffect, useRef, useState } from "react";
import {
  Handle,
  NodeToolbar,
  Position,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import {
  BookOpen,
  Link2,
  ScanSearch,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Plus } from "lucide-react";
import type { ConceptNodeData, FlowNode } from "@/types/graph";
import {
  KIND_META,
  TEMPLATE_STYLES,
  DEFAULT_TEMPLATE_STYLE,
  levelToSizeClass,
  isGraphTemplate,
} from "@/types/graph";
import { findIcon } from "@/components/graph/iconPalette";
import type { NodeToolbarActions } from "@/types/graph";

export const ConceptNodeCard = memo(function ConceptNodeCard({
  id,
  data,
  selected,
}: NodeProps<FlowNode>) {
  const nodeData = data as ConceptNodeData;
  const template = isGraphTemplate(nodeData.template)
    ? nodeData.template
    : "free";
  const style = TEMPLATE_STYLES[template] ?? DEFAULT_TEMPLATE_STYLE;
  const size = levelToSizeClass(nodeData.level);
  const isPlaceholder = Boolean(nodeData.placeholder) && !nodeData.label;

  const { updateNodeData } = useReactFlow();

  /* ---------- 图标系统派生 ---------- */
  const kindMeta = nodeData.kind ? KIND_META[nodeData.kind] : undefined;
  const iconColor = nodeData.colorOverride ?? kindMeta?.color;
  const IconComp = findIcon(nodeData.icon);
  const shape = nodeData.shape ?? "card";
  const scale = nodeData.sizeScale ?? 1;

  // 形状 → 容器类（diamond 用 clip-path 裁切，note 便签带硬阴影折纸感）
  const shapeClass =
    shape === "circle" || shape === "pill"
      ? "rounded-full"
      : shape === "diamond" || shape === "note"
        ? "rounded-sm"
        : "rounded-lg";

  // 大小档位 → 字号/内边距（em 相对缩放，避免 transform 破坏 React Flow 锚点计算）
  const sizeStyle =
    scale !== 1
      ? { fontSize: `${scale * 12}px`, padding: `${0.5 * scale}em 0.875em` }
      : undefined;

  /* ---------- 填充框编辑态 ---------- */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* ---------- 节点工具栏（选中浮现；动作由 GraphPage 注入 data._actions） ---------- */
  const actions = (nodeData as { _actions?: NodeToolbarActions })._actions;
  const connectActive = Boolean((nodeData as { _connectActive?: boolean })._connectActive);
  const aiConnectActive = Boolean((nodeData as { _aiConnectActive?: boolean })._aiConnectActive);
  const stop = (fn?: (id: string) => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn?.(id);
  };

  useEffect(() => {
    if (editing) {
      // 等输入框挂载后聚焦
      const t = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(t);
    }
  }, [editing]);

  const commitEdit = () => {
    const v = draft.trim();
    setEditing(false);
    if (v) updateNodeData(id, { label: v, placeholder: false });
    // 空提交 → 维持占位态
  };

  /* ---------- 占位框外观 ---------- */
  if (isPlaceholder) {
    return (
      <div
        data-concept-node={id}
        onClick={(e) => {
          e.stopPropagation(); // 占位框单击 = 编辑，不进入两段式连线/深度解析
          if (!editing) {
            setDraft("");
            setEditing(true);
          }
        }}
        className={`
          w-[150px] cursor-text border-2 border-dashed shadow-sm
          transition-all duration-200 hover:-translate-y-0.5
          ${shapeClass} ${style.border} ${style.bg}
          hover:shadow-[0_0_12px_rgba(148,163,184,0.25)]
          px-3 py-2.5 text-center
        `}
        title={nodeData.slot ? `${nodeData.slot}：点击填写，或拖入收集区词条` : "点击填写概念词"}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder={nodeData.slot ?? "输入概念词"}
            maxLength={30}
            className="w-full bg-transparent text-center text-xs font-medium text-slate-100 outline-none placeholder:text-slate-500"
          />
        ) : (
          <>
            <span
              className={`mx-auto mb-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-current opacity-60 ${style.text}`}
              aria-hidden
            >
              <Plus className="h-2.5 w-2.5" />
            </span>
            <span className={`block truncate text-xs font-medium ${style.text} opacity-80`}>
              {nodeData.slot ?? "概念词"}
            </span>
            <span className="mt-0.5 block text-[10px] leading-tight text-slate-400/70">
              点击填写 · 或拖词放入
            </span>
          </>
        )}
      {/* 隐形 Handle：React Flow 边锚点计算依赖 Handle 存在；拖线已由
          nodesConnectable=false 全局禁用，连线走工具栏「拉线」模式 */}
      <Handle id="top" type="target" position={Position.Top} className="!h-1.5 !w-1.5 !opacity-0 !border-0 !bg-transparent pointer-events-none" />
      <Handle id="left" type="target" position={Position.Left} className="!h-1.5 !w-1.5 !opacity-0 !border-0 !bg-transparent pointer-events-none" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !opacity-0 !border-0 !bg-transparent pointer-events-none" />
      <Handle id="right" type="source" position={Position.Right} className="!h-1.5 !w-1.5 !opacity-0 !border-0 !bg-transparent pointer-events-none" />
      </div>
    );
  }

  return (
    <div
      data-concept-node={id}
      onContextMenu={() => {
        // 右键菜单由 GraphPage 的 onNodeContextMenu 统一处理，这里仅诊断日志
        console.log("[ConceptNodeCard] 卡片右键:", id);
      }}
      onClick={() => {
        console.log("[ConceptNodeCard] 卡片 DOM 被点击:", id);
      }}
      className={`
        relative border-2 shadow-md transition-all duration-200
        hover:-translate-y-0.5
        ${
          nodeData.pending
            ? // 连线交互：第一个被点击的待选节点 → 琥珀色高亮
              "ring-2 ring-amber-300 shadow-[0_0_20px_rgba(252,211,77,0.55)] border-amber-300/80"
            : selected
              ? style.selected
              : style.glow
        }
        ${style.bg} ${style.text} ${size} ${shapeClass}
        ${shape === "note" ? "shadow-[3px_3px_0_rgba(0,0,0,0.35)]" : ""}
      `}
      style={{
        ...(sizeStyle ?? {}),
        ...(nodeData.colorOverride
          ? { borderColor: `${nodeData.colorOverride}aa` }
          : {}),
        ...(shape === "diamond"
          ? { clipPath: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)" }
          : {}),
      }}
      title={nodeData.description ?? nodeData.label}
    >
      {/* 节点工具栏（选中浮现）：连线 / AI 连线 / 解释 / 上下文 / 删除
          —— 取代原「四向 Handle 拖线 + 点按解释」交互（v0.1.0） */}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={6}>
        <div className="flex items-center gap-0.5 rounded-md border border-white/15 bg-[rgba(20,20,30,0.95)] p-0.5 shadow-lg">
          {(
            [
              {
                key: "connect",
                icon: Link2,
                title: "拉线连线：再点目标词框即连（Esc 取消）",
                active: connectActive,
                fn: actions?.connect,
              },
              {
                key: "ai",
                icon: Sparkles,
                title: "AI 连线：点击目标词框，模型生成关系词与解释",
                active: aiConnectActive,
                fn: actions?.aiConnect,
              },
              {
                key: "explain",
                icon: BookOpen,
                title: "AI 解释词语含义",
                active: false,
                fn: actions?.explain,
              },
              {
                key: "ctx",
                icon: ScanSearch,
                title: "AI 分析上下文作用",
                active: false,
                fn: actions?.analyzeContext,
              },
              {
                key: "del",
                icon: Trash2,
                title: "删除节点（可撤销）",
                active: false,
                fn: actions?.remove,
              },
            ] as const
          ).map((b) => (
            <button
              key={b.key}
              type="button"
              title={b.title}
              onClick={stop(b.fn)}
              onMouseDown={(e) => e.stopPropagation()}
              className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors ${
                b.active
                  ? "bg-amber-400/80 text-slate-900"
                  : "text-slate-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              <b.icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </NodeToolbar>


      <div className="flex items-center gap-1.5">
        {/* 图标（右键可选）或模板色条 */}
        {IconComp ? (
          <IconComp
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: iconColor ?? "currentColor" }}
            aria-hidden
          />
        ) : (
          <span
            className={`h-3 w-1 shrink-0 rounded-full ${style.accent}`}
            style={
              nodeData.colorOverride
                ? { background: nodeData.colorOverride }
                : undefined
            }
            aria-hidden
          />
        )}
        <span className="block max-w-[170px] truncate leading-snug">
          {nodeData.label}
        </span>
      </div>

      {nodeData.description && (
        <span
          className={`mt-0.5 block max-w-[180px] truncate text-[10px] leading-tight ${style.subText}`}
        >
          {nodeData.description}
        </span>
      )}

      {/* 词语类型角标（右上小圆点，悬浮说明；可经设置/右键隐藏） */}
      {kindMeta && !nodeData.hideKindBadge && (
        <span
          className="absolute -right-1.5 -top-1.5 h-2.5 w-2.5 rounded-full border border-slate-900"
          style={{ background: kindMeta.color }}
          title={`类型：${kindMeta.label}${nodeData.kindSource === "manual" ? "（手动）" : "（自动识别）"}`}
          aria-hidden
        />
      )}
      {/* 隐形 Handle：React Flow 边锚点计算依赖 Handle 存在；拖线已由
          nodesConnectable=false 全局禁用，连线走工具栏「拉线」模式 */}
      <Handle id="top" type="target" position={Position.Top} className="!h-1.5 !w-1.5 !opacity-0 !border-0 !bg-transparent pointer-events-none" />
      <Handle id="left" type="target" position={Position.Left} className="!h-1.5 !w-1.5 !opacity-0 !border-0 !bg-transparent pointer-events-none" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !opacity-0 !border-0 !bg-transparent pointer-events-none" />
      <Handle id="right" type="source" position={Position.Right} className="!h-1.5 !w-1.5 !opacity-0 !border-0 !bg-transparent pointer-events-none" />
    </div>
  );
});
