// src/types/graph.ts
// React Flow 渲染层类型定义 + 图谱模板样式系统
//
// 设计要点：
//   - 图谱模板（GraphTemplate）决定节点主色调：自由发散=翡翠绿、逻辑链=天蓝、韦恩图=紫罗兰
//   - level 仅决定字号档位（大/中/小），颜色语义让位给模板
//   - 节点 data.template 由 payloadToFlow / 图谱加载时写入，卡片据此着色

import type { Node, Edge } from "@xyflow/react";

/* ------------------------------------------------------------------ *
 *  图谱模板
 * ------------------------------------------------------------------ */

/** 图谱模板：决定布局策略与节点配色 */
export type GraphTemplate = "free" | "chain" | "venn" | "flow" | "tree";

/** 节点形状（图标系统的形状维度） */
export type NodeShape = "card" | "circle" | "pill" | "diamond" | "note";

/** 词语类型（收纳区分类维度；清单可扩展，见 useWordLibraryStore） */
export type ConceptKind = "term" | "academic" | "engineering" | "popular" | "note";

export const KIND_META: Record<
  ConceptKind,
  { label: string; color: string; desc: string }
> = {
  term: {
    label: "专业名词",
    color: "#38bdf8",
    desc: "领域内的标准术语与专名",
  },
  academic: {
    label: "学术用语",
    color: "#a78bfa",
    desc: "理论、定理、效应等学术表述",
  },
  engineering: {
    label: "工程用语",
    color: "#f59e0b",
    desc: "工程实践中的工具、协议与工艺",
  },
  popular: {
    label: "民间科普",
    color: "#34d399",
    desc: "通俗化、比喻式的科普表达",
  },
  note: {
    label: "自定义笔记",
    color: "#f43f5e",
    desc: "个人批注、疑问与联想",
  },
};

export const CONCEPT_KINDS: ConceptKind[] = [
  "term",
  "academic",
  "engineering",
  "popular",
  "note",
];

/** 节点工具栏动作（GraphPage 渲染时注入 data._actions，不参与持久化） */
export interface NodeToolbarActions {
  /** 拉线连线：进入连线模式，下一个点击的节点为目标 */
  connect: (id: string) => void;
  /** AI 连线：连线模式 + 到达目标后由模型生成关系词 */
  aiConnect: (id: string) => void;
  /** AI 解释词语含义（无上下文） */
  explain: (id: string) => void;
  /** AI 分析上下文作用（带全文） */
  analyzeContext: (id: string) => void;
  /** 删除节点（可撤销） */
  remove: (id: string) => void;
}

/** 节点形状语义注释（右键菜单「外观」区展示，帮助用户理解形状含义） */
export const SHAPE_LEGEND: Array<{ shape: NodeShape; label: string; note: string }> = [
  { shape: "card", label: "卡片", note: "普通概念（默认）" },
  { shape: "circle", label: "圆形", note: "集合成员 / 树状分支" },
  { shape: "pill", label: "胶囊", note: "起点 / 终点 / 串行边界" },
  { shape: "diamond", label: "菱形", note: "核心主题 / 判断分支 / 交集" },
  { shape: "note", label: "便签", note: "个人批注与联想" },
];

/** 节点外观可调色板（图标系统的颜色维度） */
export const NODE_COLOR_PALETTE: string[] = [
  "#38bdf8",
  "#34d399",
  "#a78bfa",
  "#f59e0b",
  "#f43f5e",
  "#22d3ee",
  "#fb7185",
  "#94a3b8",
];

/**
 * 连线形态（Novak 命题规则：连线应携带连接词才有意义）
 *  - orthogonal 规整折线：直线 + 90° 折线，弯折处圆弧半径可调（默认，
 *    流程图/逻辑图的标准画法，学习白板工具的连线规范）
 *  - smooth  自由连线：柔和贝塞尔曲线（发散联想）
 *  - straight 直线：干净的直连（因果箭头）
 *  - sketch  随手写：seeded 手绘抖动线 + 箭头指向（GoodNotes 压感笔迹）
 */
export type EdgeLineStyle =
  | "orthogonal"
  | "smooth"
  | "straight"
  | "sketch";

export const EDGE_STYLE_META: Record<
  EdgeLineStyle,
  { label: string; desc: string }
> = {
  orthogonal: {
    label: "规整折线",
    desc: "直线 + 90° 折线，弯折圆弧可调（默认）",
  },
  smooth: { label: "自由连线", desc: "柔和曲线，发散联想" },
  straight: { label: "直线", desc: "干净直连，因果箭头" },
  sketch: { label: "随手写", desc: "手绘抖动线 + 箭头指向" },
};

/** 循环切换连线形态（双击边时使用） */
export function nextEdgeLineStyle(cur: EdgeLineStyle): EdgeLineStyle {
  const order: EdgeLineStyle[] = [
    "orthogonal",
    "smooth",
    "straight",
    "sketch",
  ];
  return order[(order.indexOf(cur) + 1) % order.length];
}

export interface TemplateMeta {
  /** 展示名 */
  label: string;
  /** 一句话说明（新建弹窗里展示） */
  desc: string;
  /** 模板代表色（徽章 / 小地图） */
  dot: string;
}

export const TEMPLATE_META: Record<GraphTemplate, TemplateMeta> = {
  free: {
    label: "自由发散",
    desc: "围绕核心概念自由延展，适合头脑风暴",
    dot: "#34d399",
  },
  chain: {
    label: "逻辑链梳理",
    desc: "按因果/步骤横向串联概念",
    dot: "#38bdf8",
  },
  flow: {
    label: "工业流程图",
    desc: "工序步骤/判断分支/输入输出，工业流程框图样式",
    dot: "#fb923c",
  },
  tree: {
    label: "树状逻辑图",
    desc: "中心主题向外散射分层，树状梳理概念脉络",
    dot: "#fb7185",
  },
  venn: {
    label: "韦恩图概念归类",
    desc: "突出概念间的交叠与归类关系",
    dot: "#a78bfa",
  },
};

export function isGraphTemplate(v: unknown): v is GraphTemplate {
  return (
    v === "free" ||
    v === "chain" ||
    v === "venn" ||
    v === "flow" ||
    v === "tree"
  );
}

/* ------------------------------------------------------------------ *
 *  React Flow 节点/边 类型定义
 * ------------------------------------------------------------------ */

/**
 * React Flow 自定义节点 data
 */
export interface ConceptNodeData {
  label: string;
  level?: number;
  /** 概念释义，悬浮展示 */
  description?: string;
  /** 所属图谱模板（决定配色） */
  template?: GraphTemplate;
  /** 连线交互：待选中的第一个节点（琥珀色高亮） */
  pending?: boolean;
  /* ---------- 模板填充框（脚手架节点）---------- */
  /**
   * 占位填充框：label 为空时呈虚线框，单击进入编辑态或拖词填充，
   * 填充后 placeholder 置 false 变成普通概念节点
   */
  placeholder?: boolean;
  /** 槽位语义标签（如「核心概念」「A∩B 共有」），空框内展示引导文案 */
  slot?: string;
  /* ---------- 韦恩图区域节点（vennZone）专属 ---------- */
  /** 左集合标题（vennZone 可编辑标签） */
  titleA?: string;
  /** 右集合标题（vennZone 可编辑标签） */
  titleB?: string;
  /* ---------- 图标系统（右键菜单可调）---------- */
  /** lucide 图标名（iconPalette.ts 白名单内），缺省按词语类型推导 */
  icon?: string;
  /** 节点形状（缺省 card 圆角卡片） */
  shape?: NodeShape;
  /** 边框/图标强调色（缺省按模板配色） */
  colorOverride?: string;
  /** 大小档位（0.8 缩小 / 1 标准 / 1.25 放大，映射字号与内边距） */
  sizeScale?: number;
  /** 词语类型（决定收纳区分组与默认图标） */
  kind?: ConceptKind;
  /** 类型来源：auto=启发式/LLM 自动识别，manual=用户右键指定 */
  kindSource?: "auto" | "manual";
  /** 隐藏该节点的词语类型角标（全局开关在设置页，此处为单节点覆盖） */
  hideKindBadge?: boolean;
  /* ---------- 纸张边框节点（paperFrame）专属 ---------- */
  frameW?: number;
  frameH?: number;
  [key: string]: unknown; // React Flow 要求允许扩展属性
}

export interface ConceptEdgeData {
  label?: string;
  /** 关系的一句话解释（模型返回，悬停/副文本展示） */
  explanation?: string;
  /** 连线形态（缺省 = orthogonal 规整折线） */
  lineStyle?: EdgeLineStyle;
  /** orthogonal 形态的弯折圆弧半径（px，0=直角） */
  cornerRadius?: number;
  [key: string]: unknown;
}

/** React Flow 可消费的节点类型（concept 概念卡 / vennZone 韦恩图区域） */
export type FlowNode = Node<ConceptNodeData>;

/** React Flow 可消费的边类型 */
export type FlowEdge = Edge<ConceptEdgeData>;

/* ------------------------------------------------------------------ *
 *  模板 → 节点样式映射（深色卡片审美）
 * ------------------------------------------------------------------ */

export interface TemplateStyle {
  /** 节点背景（深色） */
  bg: string;
  /** 发光边框颜色 */
  border: string;
  /** 文字颜色 */
  text: string;
  /** 悬浮发光阴影 */
  glow: string;
  /** 选中态光环 */
  selected: string;
  /** 副文本（description）颜色 */
  subText: string;
  /** 左侧模板色条 */
  accent: string;
}

export const TEMPLATE_STYLES: Record<GraphTemplate, TemplateStyle> = {
  // 自由发散：翡翠绿
  free: {
    bg: "bg-slate-900",
    border: "border-emerald-400/60",
    text: "text-emerald-50",
    glow: "hover:shadow-[0_0_14px_rgba(52,211,153,0.4)] hover:border-emerald-300",
    selected: "ring-2 ring-emerald-300/90 shadow-[0_0_18px_rgba(52,211,153,0.5)]",
    subText: "text-emerald-200/55",
    accent: "bg-emerald-400",
  },
  // 逻辑链梳理：天蓝
  chain: {
    bg: "bg-slate-900",
    border: "border-sky-400/70",
    text: "text-sky-50",
    glow: "hover:shadow-[0_0_16px_rgba(56,189,248,0.45)] hover:border-sky-300",
    selected: "ring-2 ring-sky-300/90 shadow-[0_0_20px_rgba(56,189,248,0.55)]",
    subText: "text-sky-200/60",
    accent: "bg-sky-400",
  },
  // 韦恩图概念归类：紫罗兰
  venn: {
    bg: "bg-slate-900",
    border: "border-violet-400/60",
    text: "text-violet-50",
    glow: "hover:shadow-[0_0_14px_rgba(167,139,250,0.4)] hover:border-violet-300",
    selected: "ring-2 ring-violet-300/90 shadow-[0_0_18px_rgba(167,139,250,0.5)]",
    subText: "text-violet-200/55",
    accent: "bg-violet-400",
  },
  // 工业流程图：工业橙
  flow: {
    bg: "bg-slate-900",
    border: "border-orange-400/70",
    text: "text-orange-50",
    glow: "hover:shadow-[0_0_16px_rgba(251,146,60,0.45)] hover:border-orange-300",
    selected: "ring-2 ring-orange-300/90 shadow-[0_0_20px_rgba(251,146,60,0.55)]",
    subText: "text-orange-200/60",
    accent: "bg-orange-400",
  },
  // 树状逻辑图：玫红
  tree: {
    bg: "bg-slate-900",
    border: "border-rose-400/60",
    text: "text-rose-50",
    glow: "hover:shadow-[0_0_14px_rgba(251,113,133,0.4)] hover:border-rose-300",
    selected: "ring-2 ring-rose-300/90 shadow-[0_0_18px_rgba(251,113,133,0.5)]",
    subText: "text-rose-200/55",
    accent: "bg-rose-400",
  },
};

export const DEFAULT_TEMPLATE_STYLE: TemplateStyle = TEMPLATE_STYLES.free;

/* ------------------------------------------------------------------ *
 *  level → 字号档位（颜色语义已让位给模板，只保留大小层级）
 * ------------------------------------------------------------------ */

export function levelToSizeClass(level?: number): string {
  switch (level) {
    case 1:
      return "text-sm font-semibold px-4 py-2.5";
    case 3:
      return "text-xs px-3 py-1.5";
    case 4:
      return "text-[11px] px-2.5 py-1";
    default:
      return "text-xs font-medium px-3.5 py-2";
  }
}

/**
 * MiniMap 中的节点填充色——暗色系映射（同色相压暗，避免白色小地图里刺眼的高饱和色块）
 */
const MINIMAP_DARK_COLORS: Record<GraphTemplate, string> = {
  free: "#166534", // dark emerald
  chain: "#075985", // dark sky
  venn: "#5b21b6", // dark violet
  flow: "#9a3412", // dark orange
  tree: "#9f1239", // dark rose
};

export function templateMinimapColor(template?: GraphTemplate): string {
  return MINIMAP_DARK_COLORS[template ?? "free"] ?? MINIMAP_DARK_COLORS.free;
}
