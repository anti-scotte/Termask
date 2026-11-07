// src/stores/useTemplateStore.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PromptTemplate } from "@/types";

/* ------------------------------------------------------------------ *
 *  模板表单数据（新建/编辑共用，剥离出 UI 无关的纯数据形状）
 * ------------------------------------------------------------------ */
export type TemplateFormData = Omit<
  PromptTemplate,
  "id" | "version" | "createdAt" | "updatedAt"
>;

/* ------------------------------------------------------------------ *
 *  Store 接口定义
 * ------------------------------------------------------------------ */
interface TemplateState {
  /** 全量模板列表 */
  templates: PromptTemplate[];

  /** 新建模板，返回新 id */
  createTemplate: (data: TemplateFormData) => string;

  /** 更新模板，自动 bump version + updatedAt */
  updateTemplate: (
    id: string,
    patch: Partial<Omit<PromptTemplate, "id" | "createdAt">>,
  ) => void;

  /** 删除模板 */
  deleteTemplate: (id: string) => void;

  /** 按 id 取单条（非响应式，适合表单初始化读取） */
  getTemplate: (id: string) => PromptTemplate | undefined;

  /** 根据 Prompt 内容自动提取 {{变量名}} 占位，返回去重后的变量数组 */
  extractVariables: (promptContent: string) => string[];

  /** 按 id 复制模板（生成新 id，名称追加" (副本)"） */
  duplicateTemplate: (id: string) => string | undefined;

  /** 批量删除 */
  deleteTemplates: (ids: string[]) => void;

  /** 按名称/意图模糊搜索 */
  searchTemplates: (keyword: string) => PromptTemplate[];
}

/** ID 生成器（Tauri webview 中 crypto.randomUUID 可用） */
function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 从 Prompt 正文提取 {{变量名}} 占位 */
function extractVarNames(content: string): string[] {
  const regex = /\{\{([^}]+)\}\}/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    names.add(match[1].trim());
  }
  return [...names];
}

export const useTemplateStore = create<TemplateState>()(
  persist(
    (set, get) => ({
      templates: [],

      createTemplate: (data) => {
        const now = Date.now();
        const id = genId();
        const tpl: PromptTemplate = {
          id,
          version: 1,
          createdAt: now,
          updatedAt: now,
          ...data,
          // 自动同步变量：若用户没手动填 variables，从 promptContent 提取
          variables:
            data.variables.length > 0
              ? data.variables
              : extractVarNames(data.promptContent),
        };
        set((s) => ({ templates: [...s.templates, tpl] }));
        return id;
      },

      updateTemplate: (id, patch) => {
        set((s) => ({
          templates: s.templates.map((t) => {
            if (t.id !== id) return t;
            const merged = { ...t, ...patch };
            // 如果 promptContent 被修改且 variables 未在 patch 中，重新提取
            if (patch.promptContent && !patch.variables) {
              merged.variables = extractVarNames(patch.promptContent);
            }
            return {
              ...merged,
              version: t.version + 1,
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      deleteTemplate: (id) => {
        set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }));
      },

      getTemplate: (id) => get().templates.find((t) => t.id === id),

      extractVariables: (content) => extractVarNames(content),

      duplicateTemplate: (id) => {
        const src = get().templates.find((t) => t.id === id);
        if (!src) return undefined;
        const now = Date.now();
        const newId = genId();
        const copy: PromptTemplate = {
          ...src,
          id: newId,
          name: `${src.name} (副本)`,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ templates: [...s.templates, copy] }));
        return newId;
      },

      deleteTemplates: (ids) => {
        const idSet = new Set(ids);
        set((s) => ({
          templates: s.templates.filter((t) => !idSet.has(t.id)),
        }));
      },

      searchTemplates: (keyword) => {
        const kw = keyword.trim().toLowerCase();
        if (!kw) return get().templates;
        return get().templates.filter(
          (t) =>
            t.name.toLowerCase().includes(kw) ||
            t.intent.toLowerCase().includes(kw),
        );
      },
    }),
    {
      name: "termask-templates",
      partialize: (s) => ({ templates: s.templates }),
    },
  ),
);
