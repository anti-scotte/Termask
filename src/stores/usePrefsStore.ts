// src/stores/usePrefsStore.ts
// 个性化/专区偏好（Zustand persist, key = termask-prefs）
//
// 与 useSettingsStore（后端同步）不同：这些是纯前端视觉/交互偏好，
// localStorage 持久化即可，不占后端 settings.json 契约。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { EdgeLineStyle, GraphTemplate } from "@/types/graph";

interface PrefsState {
  /** 工作台氛围背景（光带 + 织纹） */
  ambientBackdrop: boolean;
  /** 图谱画布点阵网格 */
  canvasDots: boolean;
  /** 图谱 MiniMap */
  showMiniMap: boolean;
  /** 新连线默认形态（缺省 orthogonal 规整折线） */
  defaultEdgeStyle: EdgeLineStyle;
  /** 连线动态特效（流动虚线动画；可关闭） */
  edgeAnimated: boolean;
  /** 规整折线弯折处的圆弧半径（px，0 = 直角） */
  edgeCornerRadius: number;
  /** 词语类型角标（全局显示开关；单节点可在右键覆盖） */
  showKindBadge: boolean;
  /** 图谱导出默认格式（与后端 export_graph_project 格式名一致） */
  defaultExportFormat: "json" | "markdown" | "html" | "png" | "pdf" | "docx";
  /** 新建图谱默认模板 */
  defaultTemplate: GraphTemplate;
  /** 新建图谱自动铺开填充框 */
  autoScaffold: boolean;

  update: (patch: Partial<Omit<PrefsState, "update">>) => void;
}

export const usePrefsStore = create<PrefsState>()(
  persist(
    (set) => ({
      ambientBackdrop: true,
      canvasDots: true,
      showMiniMap: true,
      defaultEdgeStyle: "orthogonal",
      edgeAnimated: true,
      edgeCornerRadius: 12,
      showKindBadge: true,
      defaultExportFormat: "html",
      defaultTemplate: "free",
      autoScaffold: true,
      update: (patch) => set(patch),
    }),
    {
      name: "termask-prefs",
      partialize: (s) => ({
        ambientBackdrop: s.ambientBackdrop,
        canvasDots: s.canvasDots,
        showMiniMap: s.showMiniMap,
        defaultEdgeStyle: s.defaultEdgeStyle,
        edgeAnimated: s.edgeAnimated,
        edgeCornerRadius: s.edgeCornerRadius,
        showKindBadge: s.showKindBadge,
        defaultExportFormat: s.defaultExportFormat,
        defaultTemplate: s.defaultTemplate,
        autoScaffold: s.autoScaffold,
      }),
    },
  ),
);
