// src/lib/graphTransform.ts
// 扩展推送的 ConceptGraphPayload ↔ React Flow 数据 双向转换
//
// 布局策略按模板区分：
//   - free / venn / tree：圆形布局（circular layout，推送数据无层级语义）
//   - chain / flow：横向线性布局（逻辑链/流程图从左到右依次排列）

import type { ConceptGraphPayload } from "@/types";
import type {
  FlowNode,
  FlowEdge,
  ConceptNodeData,
  ConceptEdgeData,
  GraphTemplate,
} from "@/types/graph";

/** 圆形布局：节点均匀分布在圆周上 */
function circularLayout(count: number, radius = 220): Array<{ x: number; y: number }> {
  if (count === 0) return [];
  if (count === 1) return [{ x: 0, y: 0 }];

  const positions: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * 2 * Math.PI;
    positions.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }
  return positions;
}

/** 横向线性布局：逻辑链从左到右 */
function linearLayout(count: number, gap = 240): Array<{ x: number; y: number }> {
  const positions: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    positions.push({ x: i * gap, y: 0 });
  }
  return positions;
}

/**
 * payload → React Flow 数据转换
 *
 * - 节点 data 携带 template（卡片据此着色）
 * - 布局按模板：chain / flow 横向一排，free / venn 圆形
 */
export function payloadToFlow(
  payload: ConceptGraphPayload,
  template: GraphTemplate = "free",
): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const positions =
    template === "chain" || template === "flow"
      ? linearLayout(payload.nodes.length)
      : circularLayout(payload.nodes.length);

  const nodes: FlowNode[] = payload.nodes.map((node, index) => {
    const data: ConceptNodeData = {
      label: node.label,
      level: node.level,
      description: node.description,
      template,
    };

    return {
      id: node.id,
      type: "concept" as const,
      position: positions[index] ?? { x: 0, y: 0 },
      data,
    };
  });

  const edges: FlowEdge[] = payload.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    // 节点为四向 Handle，推送边默认走 下→上
    sourceHandle: "bottom",
    targetHandle: "top",
    label: edge.label,
    type: "relation",
    animated: true,
    data: { label: edge.label } as ConceptEdgeData,
  }));

  return { nodes, edges };
}
