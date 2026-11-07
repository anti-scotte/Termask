// src/stores/useSettingsStore.ts
// 用户设置全局状态（Zustand）+ 后端持久化（save_user_settings / load_user_settings）。
//
// 内容：① 快捷键配置（录制后立即同步后端；全局注册待
// tauri-plugin-global-shortcut 接入，扩展端亦可读取同一份配置）；
// ② 图谱导出格式（JSON / Markdown，导出功能的基础）。
//
// 持久化策略：变更后防抖 600ms 全量序列化为 JSON 调 save_user_settings；
// App 挂载时 load() 一次。后端按登录态落 users/{user_id}/settings.json
// 或根目录 settings.json（登录/退出后需重新 load）。

import { create } from "zustand";
import { loadUserSettings, saveUserSettings } from "@/lib/bridge";

/** 图谱导出格式 */
export type ExportFormat = "json" | "markdown";

/** 快捷键配置项 id */
export type HotkeyId = "quickTrigger" | "openWorkbench";
export interface HotkeyConfig {
  /** 划词直接触发 */
  quickTrigger: string;
  /** 打开工作台 */
  openWorkbench: string;
}
export const DEFAULT_HOTKEYS: HotkeyConfig = {
  quickTrigger: "Ctrl+Shift+Q",
  openWorkbench: "Ctrl+Shift+T",
};

/** 序列化到后端 settings.json 的形状（新增字段向后兼容：缺省合并） */
interface PersistedSettings {
  hotkeys?: Partial<HotkeyConfig>;
  exportFormat?: ExportFormat;
}

const SAVE_DEBOUNCE_MS = 600;
const LEGACY_KEY = "termask-hotkeys"; // 旧版 localStorage 键，迁移后清除

interface SettingsState {
  hotkeys: HotkeyConfig;
  exportFormat: ExportFormat;
  /** 初始 load 是否完成 */
  loaded: boolean;
  /** App 挂载 / 登录态切换后调用：从后端读回设置 */
  load: () => Promise<void>;
  /** 局部更新 + 防抖同步后端 */
  update: (patch: {
    hotkeys?: Partial<HotkeyConfig>;
    exportFormat?: ExportFormat;
  }) => void;
}

let saveTimer: number | null = null;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  hotkeys: { ...DEFAULT_HOTKEYS },
  exportFormat: "json",
  loaded: false,

  load: async () => {
    try {
      const raw = await loadUserSettings();
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedSettings;
        set({
          hotkeys: { ...DEFAULT_HOTKEYS, ...(parsed.hotkeys ?? {}) },
          exportFormat: parsed.exportFormat ?? "json",
          loaded: true,
        });
        return;
      }
      // 后端没有存档 → 尝试从旧版 localStorage 迁移（一次性）
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        try {
          const parsedLegacy = JSON.parse(legacy) as Partial<HotkeyConfig>;
          set({
            hotkeys: { ...DEFAULT_HOTKEYS, ...parsedLegacy },
            loaded: true,
          });
          await saveUserSettings(
            JSON.stringify({
              hotkeys: get().hotkeys,
              exportFormat: get().exportFormat,
            } satisfies PersistedSettings),
          );
          localStorage.removeItem(LEGACY_KEY); // 迁移完成即清除
        } catch {
          set({ loaded: true });
        }
        return;
      }
      set({ loaded: true });
    } catch (e) {
      console.warn("[Settings] load_user_settings 失败:", e);
      set({ loaded: true });
    }
  },

  update: (patch) => {
    set((s) => {
      const next: Pick<SettingsState, "hotkeys" | "exportFormat"> = {
        hotkeys: patch.hotkeys ? { ...s.hotkeys, ...patch.hotkeys } : s.hotkeys,
        exportFormat: patch.exportFormat ?? s.exportFormat,
      };
      // 防抖全量同步后端
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        const { hotkeys, exportFormat } = get();
        saveUserSettings(
          JSON.stringify({ hotkeys, exportFormat } satisfies PersistedSettings),
        )
          .then(() =>
            console.log("[Settings] 已同步后端:", { hotkeys, exportFormat }),
          )
          .catch((e) => console.warn("[Settings] save_user_settings 失败:", e));
      }, SAVE_DEBOUNCE_MS);
      return next;
    });
  },
}));
