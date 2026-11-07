// src/components/graph/PaperFrameNode.tsx
// 纸张边框节点（paperFrame）：非自由发散模式下的「纸张边界」
//
// 用途（v0.1.0）：
//   - 一键加入/删除（GraphPage 工具条「纸张」按钮），尺寸自动按现有图谱
//     内容的包围盒外扩 80px（也可以手动拖动调整位置）
//   - 导出时以该边框为裁剪范围（见 graphExport.ts）
//   - 纯视觉：selectable=false、不参与连线/收藏；随图谱持久化（JSON 可序列化）

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import type { ConceptNodeData, FlowNode } from "@/types/graph";

export const PaperFrameNode = memo(function PaperFrameNode({
  data,
}: NodeProps<FlowNode>) {
  const d = data as ConceptNodeData;
  const w = d.frameW ?? 1200;
  const h = d.frameH ?? 800;

  return (
    <div
      className="pointer-events-none flex items-start justify-center rounded-lg"
      style={{ width: w, height: h }}
      aria-hidden
    >
      {/* 纸张：白底 + 细边 + 淡阴影（明确「纸张边界」语义） */}
      <div
        className="h-full w-full rounded-lg border-2 border-dashed border-slate-400/60 bg-white/85 shadow-[0_2px_24px_rgba(15,23,42,0.08)]"
      />
      <span className="absolute left-3 top-2 text-[10px] tracking-wide text-slate-400">
        纸张边界 · 导出裁剪范围
      </span>
    </div>
  );
});
