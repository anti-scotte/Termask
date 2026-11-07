// src/components/whiteboard/backgroundTemplates.ts
// 白板背景模板：康奈尔笔记法 / 产婆术（苏格拉底式）对话图框
//
// 实现方式：在画布上预绘制一批【锁定】的 geo/text 形状（isLocked: true，
// 用户不可选中/移动/编辑），并用 meta.bgTemplate 标记归属：
//   - 快照持久化时模板形状随 save_whiteboard 一并落盘，后端零改动
//   - 切换模板 = 删除所有带该 meta 的形状 + 重建新模板形状
//   - "空白/网格" = 仅清除模板形状（保留 tldraw 默认点阵网格背景）

import { createShapeId, toRichText } from "tldraw";
import type { TLShapeId } from "tldraw";

/** 背景模板标识（blank 仅表示"无模板"，不落任何形状） */
export type BgTemplate = "blank" | "cornell" | "socratic";

export const BG_TEMPLATE_LABELS: Record<BgTemplate, string> = {
  blank: "空白 / 网格",
  cornell: "康奈尔笔记法",
  socratic: "产婆术对话",
};

/** 从形状 meta 中提取模板归属（无则 null） */
export function shapeBgTemplate(
  meta: unknown,
): BgTemplate | null {
  const t = (meta as Record<string, unknown> | undefined)?.bgTemplate;
  if (t === "cornell" || t === "socratic") return t;
  return null;
}

/** 模板画布区域尺寸（居中于当前视口） */
const TPL_W = 1560;
const TPL_H = 1080;

/** 模板形状规格（交给 editor.createShapes，id 必带） */
interface TemplateShapeSpec {
  id: TLShapeId;
  type: "geo" | "text";
  x: number;
  y: number;
  props: Record<string, unknown>;
  isLocked: true;
  meta: { bgTemplate: BgTemplate };
}

/** 追加一个带模板 meta 的锁定形状 */
function push(
  out: TemplateShapeSpec[],
  tpl: BgTemplate,
  s: Omit<TemplateShapeSpec, "id" | "isLocked" | "meta">,
) {
  out.push({
    id: createShapeId(),
    isLocked: true,
    meta: { bgTemplate: tpl },
    ...s,
  });
}

/** 淡色分区背景块 + 区块标题 */
function zone(
  out: TemplateShapeSpec[],
  tpl: BgTemplate,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  label: string,
) {
  push(out, tpl, {
    type: "geo",
    x,
    y,
    props: { w, h, geo: "rectangle", fill: "semi", dash: "solid", color },
  });
  push(out, tpl, {
    type: "text",
    x: x + 16,
    y: y + 12,
    props: {
      richText: toRichText(label),
      autoSize: true,
      color: "black",
      scale: 1.35,
    },
  });
}

/**
 * 以 (cx, cy) 为中心构建模板形状数组。
 * 返回空数组 = 空白模板（仅需清除旧形状）。
 */
export function buildTemplateShapes(
  tpl: BgTemplate,
  cx: number,
  cy: number,
): TemplateShapeSpec[] {
  if (tpl === "blank") return [];
  const out: TemplateShapeSpec[] = [];
  const x0 = cx - TPL_W / 2;
  const y0 = cy - TPL_H / 2;

  if (tpl === "cornell") {
    // 康奈尔笔记法：右侧大块笔记区 + 左侧窄条线索区 + 底部宽条总结区
    push(out, tpl, {
      type: "text",
      x: x0 + 20,
      y: y0 + 8,
      props: {
        richText: toRichText("康奈尔笔记法 Cornell Notes"),
        autoSize: true,
        color: "black",
        scale: 1.6,
      },
    });
    zone(out, tpl, x0 + 20, y0 + 70, 480, 690, "yellow", "关键词 · 线索 Cue Column");
    zone(out, tpl, x0 + 520, y0 + 70, 1020, 690, "blue", "笔记区 Note-taking");
    zone(out, tpl, x0 + 20, y0 + 780, 1520, 280, "green", "总结 Summary");
    return out;
  }

  // 产婆术（苏格拉底式）对话图框：五区分栏
  push(out, tpl, {
    type: "text",
    x: x0 + 20,
    y: y0 + 8,
    props: {
      richText: toRichText("产婆术对话 · 苏格拉底式提问"),
      autoSize: true,
      color: "black",
      scale: 1.6,
    },
  });
  // 顶部：总结摘要区
  zone(out, tpl, x0 + 20, y0 + 70, 1520, 140, "violet", "总结摘要区 Summary");
  // 左侧最大：核心对话区
  zone(out, tpl, x0 + 20, y0 + 230, 940, 600, "blue", "核心对话区 Dialogue");
  // 右侧上：重要概念收集区
  zone(out, tpl, x0 + 980, y0 + 230, 560, 290, "yellow", "重要概念收集区 Concepts");
  // 右侧下：笔记区
  zone(out, tpl, x0 + 980, y0 + 540, 560, 290, "green", "笔记区 Notes");
  // 底部：引导发问区 + 预置引导标签
  zone(out, tpl, x0 + 20, y0 + 850, 1520, 210, "orange", "引导发问区 Guiding Questions");
  const questions = [
    "这是什么意思？",
    "能举个例子吗？",
    "为什么成立？",
    "反例是什么？",
    "依据是什么？",
    "换个说法？",
    "背后的假设是什么？",
    "与已知概念有何联系？",
    "如果…会怎样？",
    "结论从何而来？",
  ];
  questions.forEach((q, i) => {
    const col = i % 5;
    const row = Math.floor(i / 5);
    push(out, tpl, {
      type: "text",
      x: x0 + 48 + col * 300,
      y: y0 + 930 + row * 62,
      props: {
        richText: toRichText(q),
        autoSize: true,
        color: "orange",
        scale: 0.95,
      },
    });
  });
  return out;
}
