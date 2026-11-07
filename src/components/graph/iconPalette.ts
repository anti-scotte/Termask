// src/components/graph/iconPalette.ts
// 图标白名单（图标系统的「图案维度」）
//
// 为什么不用 lucide-react 全量 icons 对象：全量 import 会让 bundle 增加 ~1MB，
// 与「tldraw 分包」待办同源的体积纪律冲突。这里手动挑 30+ 个常用图标分组
// import，右键菜单「更换图标」只从白名单里选。

import {
  BookOpen,
  FlaskConical,
  Sigma,
  Atom,
  Brain,
  Scale,
  Landmark,
  Cog,
  Wrench,
  CircuitBoard,
  Terminal,
  Database,
  GitBranch,
  Server,
  Gauge,
  BadgeCheck,
  Briefcase,
  Microscope,
  ScrollText,
  Lightbulb,
  MessageCircle,
  Newspaper,
  GraduationCap,
  StickyNote,
  PenLine,
  Star,
  Flag,
  Bookmark,
  Tag,
  Heart,
  CircleHelp,
  Puzzle,
  Download,
  Package,
  RefreshCw,
  Crown,
  type LucideIcon,
} from "lucide-react";

export interface IconChoice {
  name: string;
  label: string;
  Icon: LucideIcon;
}

export const ICON_GROUPS: { group: string; icons: IconChoice[] }[] = [
  {
    group: "学术",
    icons: [
      { name: "BookOpen", label: "典籍", Icon: BookOpen },
      { name: "FlaskConical", label: "实验", Icon: FlaskConical },
      { name: "Sigma", label: "公式", Icon: Sigma },
      { name: "Atom", label: "物理", Icon: Atom },
      { name: "Brain", label: "认知", Icon: Brain },
      { name: "Scale", label: "权衡", Icon: Scale },
      { name: "Landmark", label: "建制", Icon: Landmark },
      { name: "Microscope", label: "微观", Icon: Microscope },
    ],
  },
  {
    group: "工程",
    icons: [
      { name: "Cog", label: "机械", Icon: Cog },
      { name: "Wrench", label: "工具", Icon: Wrench },
      { name: "CircuitBoard", label: "电路", Icon: CircuitBoard },
      { name: "Terminal", label: "终端", Icon: Terminal },
      { name: "Database", label: "数据", Icon: Database },
      { name: "GitBranch", label: "分支", Icon: GitBranch },
      { name: "Server", label: "服务", Icon: Server },
      { name: "Gauge", label: "仪表", Icon: Gauge },
      { name: "Download", label: "输入", Icon: Download },
      { name: "Package", label: "输出", Icon: Package },
      { name: "RefreshCw", label: "循环", Icon: RefreshCw },
    ],
  },
  {
    group: "通用",
    icons: [
      { name: "BadgeCheck", label: "确认", Icon: BadgeCheck },
      { name: "Briefcase", label: "实务", Icon: Briefcase },
      { name: "ScrollText", label: "文档", Icon: ScrollText },
      { name: "Puzzle", label: "拼合", Icon: Puzzle },
      { name: "Lightbulb", label: "灵感", Icon: Lightbulb },
      { name: "CircleHelp", label: "疑问", Icon: CircleHelp },
      { name: "GraduationCap", label: "教学", Icon: GraduationCap },
      { name: "Newspaper", label: "资讯", Icon: Newspaper },
      { name: "Crown", label: "根源", Icon: Crown },
    ],
  },
  {
    group: "笔记",
    icons: [
      { name: "StickyNote", label: "便签", Icon: StickyNote },
      { name: "PenLine", label: "手写", Icon: PenLine },
      { name: "Star", label: "重点", Icon: Star },
      { name: "Flag", label: "标记", Icon: Flag },
      { name: "Bookmark", label: "收藏", Icon: Bookmark },
      { name: "Tag", label: "标签", Icon: Tag },
      { name: "Heart", label: "喜欢", Icon: Heart },
      { name: "MessageCircle", label: "讨论", Icon: MessageCircle },
    ],
  },
];

/** 按图标名查找（找不到返回 undefined，调用方回退默认图标） */
export function findIcon(name?: string): LucideIcon | undefined {
  if (!name) return undefined;
  for (const g of ICON_GROUPS) {
    const hit = g.icons.find((i) => i.name === name);
    if (hit) return hit.Icon;
  }
  return undefined;
}
