// src/lib/graphTemplates.ts
// 图谱模板脚手架（Template Scaffold）生成器
//
// 设计依据（Novak 概念图谱四要素：节点 / 连线 / 连接词 / 层级）：
//   - 每个模板铺出「可填充的概念框」而非装饰图片：占位框（placeholder=true）
//     单击进入编辑态或拖收集区词条填充，填充后即成为普通概念节点
//   - free  自由发散：中心核心框 + 6 个放射延展框（脑暴的「锚点 + 辐条」）
//   - chain 逻辑链框架：4 个语义槽位横向串联，直线箭头预留连接词（命题规则）
//   - venn  韦恩图：双集合相交区域 + 5 个归类槽位（仅A / 共有 / 仅B）
//
// 所有坐标以画布原点为中心铺开，调用方负责 fitView。

import { MarkerType } from "@xyflow/react";
import type { FlowNode, FlowEdge, GraphTemplate, NodeShape } from "@/types/graph";

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 占位概念框节点。
 *
 * v0.1.0：每个模板注入【默认专属图标 + 形状】——不同图谱类型的词框
 * 形状/图标明显不同，用户一眼看出「这张图是什么拓扑」（视觉快速理解）。
 * 拓扑设计依据（Novak 命题规则 + 树状规范，参考非照抄）：
 *   - free  散射：菱形核心 + 卡片辐条（平滑曲线，无层级约束）
 *   - tree  树状：菱形根 → 圆形分支（4-7 个，Miller 定律）→ 卡片叶，
 *           逐层收缩，规整折线（90° 圆弧）——对应计算机树状结构的
 *           「根/内部节点/叶子」三层视觉隐喻
 *   - chain 链条：胶囊起止 + 卡片工序（直线箭头，串行因果）
 *   - flow  流程：胶囊起止 + 卡片工序 + 菱形判断（直线箭头 + 是/否
 *           标签 + 反馈回路）——串行为主线、判断分支出并行
 *   - venn  归类：圆形（呼应圆域）+ 菱形交集
 */
function placeholderNode(
  slot: string,
  pos: { x: number; y: number },
  template: GraphTemplate,
  level?: number,
  shape?: NodeShape,
  icon?: string,
): FlowNode {
  return {
    id: genId("ph"),
    type: "concept",
    position: pos,
    data: {
      label: "",
      slot,
      placeholder: true,
      template,
      level,
      ...(shape ? { shape } : {}),
      ...(icon ? { icon } : {}),
    },
  };
}

/** 直线/折线箭头边（流程图语义：工序顺序；树状图用规整折线） */
function flowEdge(
  source: FlowNode,
  target: FlowNode,
  label?: string,
  sourceHandle = "right",
  targetHandle = "left",
  lineStyle: "straight" | "orthogonal" = "straight",
  cornerRadius?: number,
): FlowEdge {
  return {
    id: genId("se"),
    source: source.id,
    target: target.id,
    sourceHandle,
    targetHandle,
    type: "relation",
    animated: true,
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { lineStyle, label, ...(cornerRadius !== undefined ? { cornerRadius } : {}) },
  };
}

/* ------------------------------------------------------------------ *
 *  自由发散（brainstorm）：核心 + 放射辐条
 * ------------------------------------------------------------------ */
function buildFreeScaffold(template: GraphTemplate): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  // 核心：菱形 + 灯泡（发散原点）；辐条：卡片 + 轮换图标
  const center = placeholderNode(
    "核心概念",
    { x: -70, y: -24 },
    template,
    1,
    "diamond",
    "Lightbulb",
  );
  const satelliteSlots: Array<{ slot: string; icon: string }> = [
    { slot: "延展概念 · 定义", icon: "Bookmark" },
    { slot: "延展概念 · 组成", icon: "Tag" },
    { slot: "延展概念 · 原因", icon: "CircleHelp" },
    { slot: "延展概念 · 影响", icon: "MessageCircle" },
    { slot: "延展概念 · 例子", icon: "Puzzle" },
    { slot: "延展概念 · 疑问", icon: "Star" },
  ];
  const R = 260;
  const satellites = satelliteSlots.map(({ slot, icon }, i) => {
    const angle = (i / satelliteSlots.length) * 2 * Math.PI - Math.PI / 2;
    return placeholderNode(
      slot,
      { x: Math.cos(angle) * R - 70, y: Math.sin(angle) * R - 24 },
      template,
      undefined,
      "card",
      icon,
    );
  });

  // 核心到每个辐条预连自由曲线（不带连接词 → 留给 AI/用户填，Novak 命题规则）
  const edges: FlowEdge[] = satellites.map((s, i) => ({
    id: `scaffold-free-${center.id}-${i}`,
    source: center.id,
    target: s.id,
    sourceHandle: i % 2 === 0 ? "right" : "left",
    targetHandle: i % 2 === 0 ? "left" : "right",
    type: "relation",
    animated: true,
    data: { lineStyle: "smooth" as const },
  }));

  return { nodes: [center, ...satellites], edges };
}

/* ------------------------------------------------------------------ *
 *  逻辑链框架（chain）：语义槽位横向串联 + 直线箭头
 * ------------------------------------------------------------------ */
function buildChainScaffold(template: GraphTemplate): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const slots = [
    "起点 · 前提",
    "推进 · 机制",
    "转折 · 条件",
    "落点 · 结论",
  ];
  const GAP = 270;
  // 起终点胶囊（Flag/结论勾），中间卡片（齿轮）
  const nodes = slots.map((slot, i) =>
    placeholderNode(
      slot,
      { x: i * GAP - 70, y: -24 },
      template,
      1,
      i === 0 || i === slots.length - 1 ? "pill" : "card",
      i === 0 ? "Flag" : i === slots.length - 1 ? "BadgeCheck" : "Cog",
    ),
  );

  const edges: FlowEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({
      id: `scaffold-chain-${i}`,
      source: nodes[i].id,
      target: nodes[i + 1].id,
      sourceHandle: "right",
      targetHandle: "left",
      type: "relation",
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { lineStyle: "straight" as const, label: "" },
    });
  }
  return { nodes, edges };
}

/* ------------------------------------------------------------------ *
 *  工业流程图（flow）：工序框图标准符号
 *
 *  学习工业流程框图（工艺流程图 / 算法流程图）惯例：
 *    圆角胶囊 = 开始/结束 · 平行四边形 = 输入/输出 ·
 *    矩形 = 加工工序 · 菱形 = 判断分支（一进两出，标注 是/否）
 * ------------------------------------------------------------------ */
function buildFlowScaffold(template: GraphTemplate): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  const start = placeholderNode("开始", { x: -70, y: -24 }, template, 1, "pill", "Flag");
  const input = placeholderNode("原料 · 输入", { x: 190, y: -24 }, template, 2, "card", "Download");
  const step1 = placeholderNode("加工工序 · A", { x: 450, y: -24 }, template, 2, "card", "Cog");
  const check = placeholderNode("判断 · 质检", { x: 710, y: -30 }, template, 2, "diamond", "Scale");
  const rework = placeholderNode("返工处理", { x: 655, y: -190 }, template, 2, "card", "RefreshCw");
  const output = placeholderNode("成品 · 输出", { x: 970, y: -24 }, template, 2, "card", "Package");
  const end = placeholderNode("结束", { x: 1230, y: -24 }, template, 1, "pill", "BadgeCheck");

  const nodes = [start, input, step1, check, rework, output, end];

  const edges: FlowEdge[] = [
    flowEdge(start, input),
    flowEdge(input, step1),
    flowEdge(step1, check),
    // 判断分支：不合格 → 返工 → 回到工序 A（反馈回路）
    flowEdge(check, rework, "否", "top", "bottom"),
    flowEdge(rework, step1, "返工重检", "left", "bottom"),
    // 判断分支：合格 → 输出 → 结束
    flowEdge(check, output, "是"),
    flowEdge(output, end),
  ];

  return { nodes, edges };
}

/* ------------------------------------------------------------------ *
 *  树状逻辑图（tree）：中心主题散射 + 层级分支
 *
 *  学习可视化笔记（GoodNotes / 小红书模板分享）常用画法：
 *  一个中心主题向外散射，逐层分叉成树状——比自由发散更有结构感，
 *  比逻辑链更开放（每层可横向扩展）。
 * ------------------------------------------------------------------ */
function buildTreeScaffold(template: GraphTemplate): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  // 根：菱形 + 皇冠（根源锚点）；分支：圆形 + 分支图标；叶：卡片 + 书签
  // 三层形状/图标明显不同 —— 对应计算机树状结构的「根 / 内部节点 / 叶子」
  const root = placeholderNode(
    "中心主题",
    { x: -70, y: -24 },
    template,
    1,
    "diamond",
    "Crown",
  );
  const branchSlots = ["分支 · 一", "分支 · 二", "分支 · 三"];
  const leafSlots = [
    ["要点 · A1", "要点 · A2"],
    ["要点 · B1", "要点 · B2"],
    ["要点 · C1", "要点 · C2"],
  ];

  const BR_GAP = 330;
  const branches = branchSlots.map((slot, i) =>
    placeholderNode(
      slot,
      { x: (i - 1) * BR_GAP - 70, y: 190 },
      template,
      2,
      "circle",
      "GitBranch",
    ),
  );
  const leaves = branches.flatMap((b, i) =>
    leafSlots[i].map((slot, j) =>
      placeholderNode(
        slot,
        {
          x: b.position.x - 105 + j * 210,
          y: 400,
        },
        template,
        3,
        "card",
        "Bookmark",
      ),
    ),
  );

  const nodes = [root, ...branches, ...leaves];
  const edges: FlowEdge[] = [
    // 树状层级：规整折线 + 大圆弧（树形连线的柔和转折）
    ...branches.map((b) =>
      flowEdge(root, b, undefined, "bottom", "top", "orthogonal", 18),
    ),
    ...branches.flatMap((b, i) =>
      leaves
        .slice(i * 2, i * 2 + 2)
        .map((l) => flowEdge(b, l, undefined, "bottom", "top", "orthogonal", 18)),
    ),
  ];

  return { nodes, edges };
}

/* ------------------------------------------------------------------ *
 *  韦恩图（venn）：双集合相交区 + 归类槽位
 * ------------------------------------------------------------------ */
function buildVennScaffold(template: GraphTemplate): {
  nodes: FlowNode[];
  edges: FlowEdge[];
} {
  // 背景：可拖动的双圆相交区域（纯视觉层，占位框落在圆内）
  const zone: FlowNode = {
    id: genId("venn-zone"),
    type: "vennZone",
    position: { x: -300, y: -170 },
    draggable: true,
    selectable: false,
    data: {
      label: "",
      template,
      titleA: "",
      titleB: "",
      titleAPlaceholder: "集合 A",
      titleBPlaceholder: "集合 B",
    },
  };

  const nodes: FlowNode[] = [
    zone,
    // 左圆专属 2 格（圆形 + 标签图标，呼应圆域归属）
    placeholderNode("仅属于 A", { x: -260, y: -70 }, template, undefined, "circle", "Tag"),
    placeholderNode("仅属于 A", { x: -220, y: 60 }, template, undefined, "circle", "Tag"),
    // 交集 1 格（菱形 + 拼合图标：两个集合共享）
    placeholderNode("A∩B 共有", { x: -70, y: -16 }, template, 1, "diamond", "Puzzle"),
    // 右圆专属 2 格
    placeholderNode("仅属于 B", { x: 160, y: -70 }, template, undefined, "circle", "Tag"),
    placeholderNode("仅属于 B", { x: 200, y: 60 }, template, undefined, "circle", "Tag"),
  ];

  // 韦恩图重在归类而非连线，预连线仅交集 → 左右各一条（虚线自由曲线示意归属）
  const zoneId = zone.id;
  const edges: FlowEdge[] = [
    {
      id: `scaffold-venn-${zoneId}`,
      source: nodes[3].id,
      target: nodes[1].id,
      sourceHandle: "left",
      targetHandle: "right",
      type: "relation",
      animated: true,
      data: { lineStyle: "smooth" as const, label: "部分重叠" },
    },
    {
      id: `scaffold-venn-${zoneId}-r`,
      source: nodes[3].id,
      target: nodes[4].id,
      sourceHandle: "right",
      targetHandle: "left",
      type: "relation",
      animated: true,
      data: { lineStyle: "smooth" as const, label: "部分重叠" },
    },
  ];

  return { nodes, edges };
}

/** 模板 → 填充框脚手架 */
export function buildTemplateScaffold(
  template: GraphTemplate,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  switch (template) {
    case "chain":
      return buildChainScaffold(template);
    case "venn":
      return buildVennScaffold(template);
    case "flow":
      return buildFlowScaffold(template);
    case "tree":
      return buildTreeScaffold(template);
    default:
      return buildFreeScaffold(template);
  }
}
