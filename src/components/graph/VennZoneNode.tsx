// src/components/graph/VennZoneNode.tsx
// 韦恩图区域节点（vennZone）：双圆相交的「可填充背景层」
//
// - 纯视觉 + 可拖动：两个半透明相交圆，随 venn 模板紫色系着色
// - 双集合标题 chip：单击进入编辑态（updateNodeData 写回，随图谱持久化）
// - selectable=false：点击圆不参与连线两段式交互，避免误触
// - 概念归类靠落在圆内的 placeholder 概念框（见 graphTemplates.ts），本节点不承担数据

import { memo, useEffect, useRef, useState } from "react";
import { useReactFlow, type NodeProps } from "@xyflow/react";
import type { ConceptNodeData, FlowNode } from "@/types/graph";

/** 单个可编辑集合标题 chip */
function EditableTitle({
  value,
  placeholder,
  side,
  onSubmit,
}: {
  value: string;
  placeholder: string;
  side: "a" | "b";
  onSubmit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      // 等输入框挂载后聚焦并全选，方便直接覆盖输入
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 20);
      return () => window.clearTimeout(t);
    }
  }, [editing, value]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v !== value) onSubmit(v);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-24 rounded-full border border-violet-300/80 bg-violet-500/20 px-2.5 py-0.5 text-center text-xs font-semibold text-violet-50 outline-none"
        placeholder={placeholder}
        maxLength={12}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation(); // 不触发画布空白点击
        setEditing(true);
      }}
      title="点击编辑集合名称"
      className={`cursor-text rounded-full border px-2.5 py-0.5 text-center text-xs font-semibold transition-colors ${
        value
          ? "border-violet-300/50 bg-violet-500/20 text-violet-50 hover:border-violet-200"
          : "border-dashed border-violet-300/50 text-violet-200/60 hover:border-violet-200 hover:text-violet-100"
      } ${side === "a" ? "w-28" : "w-28"}`}
    >
      {value || placeholder}
    </button>
  );
}

export const VennZoneNode = memo(function VennZoneNode({
  id,
  data,
}: NodeProps<FlowNode>) {
  const d = data as ConceptNodeData;
  const { updateNodeData } = useReactFlow();

  return (
    <div
      className="relative h-[340px] w-[600px]"
      // 拖动区域节点：React Flow 依 draggable 属性处理，这里只做视觉
    >
      {/* 双圆：模板紫色系半透明填充 + 描边（group-hover 增亮） */}
      <div
        className="absolute left-[30px] top-[20px] h-[300px] w-[300px] rounded-full border-2 border-violet-400/50 bg-violet-400/10 backdrop-blur-[1px]"
        aria-hidden
      />
      <div
        className="absolute right-[30px] top-[20px] h-[300px] w-[300px] rounded-full border-2 border-fuchsia-400/45 bg-fuchsia-400/10 backdrop-blur-[1px]"
        aria-hidden
      />

      {/* 顶部标题 chips：A 在左圆上部，B 在右圆上部 */}
      <div className="absolute left-[92px] top-[34px]">
        <EditableTitle
          value={d.titleA ?? ""}
          placeholder="集合 A · 点击命名"
          side="a"
          onSubmit={(v) => updateNodeData(id, { titleA: v })}
        />
      </div>
      <div className="absolute right-[92px] top-[34px]">
        <EditableTitle
          value={d.titleB ?? ""}
          placeholder="集合 B · 点击命名"
          side="b"
          onSubmit={(v) => updateNodeData(id, { titleB: v })}
        />
      </div>

      {/* 交集提示（仅装饰，字面提示重叠区语义） */}
      <span className="pointer-events-none absolute left-1/2 top-[52px] -translate-x-1/2 text-[10px] tracking-widest text-violet-200/40">
        A ∩ B
      </span>
    </div>
  );
});
