// src/stores/useWordLibraryStore.ts
// 词库收纳区 Store：分门别类收纳画布上的概念词（Zustand persist, key = termask-word-library）
//
// 数据流：
//   - 画布节点填充/新建时 → upsert 登记（kind 默认走 guessKind 本地启发式）
//   - 右键菜单设置类型 → setKind（kindSource=manual，同步更新节点 data）
//   - 收纳区条目可拖回画布（复用 TERM_MIME 拖拽协议）
//   - 删除节点 → remove
//
// 类型清单（ConceptKind）：专业名词 / 学术用语 / 工程用语 / 民间科普 / 自定义笔记。
// 自动识别现阶段用本地启发式（guessKind）；后端 LLM 分类命令（classify_concept）
// 落地后接入（契约建议见交接文档），接入处=upsert 前 replaceKind 钩子。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ConceptKind } from "@/types/graph";
import { CONCEPT_KINDS } from "@/types/graph";

/** 词库条目 */
export interface WordEntry {
  id: string;
  term: string;
  kind: ConceptKind;
  /** auto=启发式 / manual=用户指定 */
  kindSource: "auto" | "manual";
  /** 来源标注（扩展划词页面标题 / 手动输入等） */
  source?: string;
  addedAt: number;
  /** 关联的画布节点 id（用于点击定位；一个词可能对应多节点，取最近） */
  nodeId?: string;
}

/**
 * 本地启发式词语类型识别（零成本兜底；LLM 识别接入后可作为其降级路径）
 *
 * 规则：后缀词形词典匹配，命中即返回；缺省 term（专业名词）。
 */
export function guessKind(term: string): ConceptKind {
  const t = term.trim();
  if (!t) return "term";
  // 学术：理论体系后缀
  if (/(定理|定律|原理|效应|假说|悖论|范式|论$|学说|理论|模型论)/.test(t))
    return "academic";
  // 工程：工程实践词形 + 常见缩写
  if (
    /(算法|协议|接口|架构|引擎|驱动|框架|编译|部署|缓存|中间件|线程|进程|数据库|服务器)$/.test(
      t,
    ) ||
    /^(API|SDK|CPU|GPU|HTTP|TCP|IP|SQL|CI\/CD|DevOps)/i.test(t)
  )
    return "engineering";
  // 科普：通俗/比喻标记
  if (/(俗称|大白话|简单来说|比方|好比|其实就是)/.test(t)) return "popular";
  // 笔记：疑问/批注语气
  if (/(吗|呢|？|\?|为什么|怎么|啥|不懂|没懂)/.test(t) || t.length > 12)
    return "note";
  return "term";
}

function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface WordLibraryState {
  entries: WordEntry[];
  /** 收纳区面板开合（不入持久化也可以，persist 全量简单些） */
  panelOpen: boolean;

  /** 登记/更新词条（term 为唯一键；已存在则刷新 nodeId 引用） */
  upsert: (term: string, opts?: { nodeId?: string; source?: string }) => WordEntry | undefined;
  /** 手动设置类型（kindSource=manual） */
  setKind: (term: string, kind: ConceptKind) => void;
  /** 删除词条 */
  remove: (term: string) => void;
  /** 画布节点删除时按 nodeId 解除关联 */
  detachNode: (nodeId: string) => void;
  setPanelOpen: (open: boolean) => void;
  clear: () => void;
}

export const useWordLibraryStore = create<WordLibraryState>()(
  persist(
    (set, get) => ({
      entries: [],
      panelOpen: false,

      upsert: (term, opts) => {
        const t = term.trim();
        if (!t) return undefined;
        const existing = get().entries.find((e) => e.term === t);
        if (existing) {
          // 已存在：仅刷新节点引用与来源（不覆盖手动设置的类型）
          if (opts?.nodeId && opts.nodeId !== existing.nodeId) {
            set((s) => ({
              entries: s.entries.map((e) =>
                e.term === t ? { ...e, nodeId: opts.nodeId } : e,
              ),
            }));
          }
          return existing;
        }
        const entry: WordEntry = {
          id: genId(),
          term: t,
          kind: guessKind(t),
          kindSource: "auto",
          source: opts?.source,
          addedAt: Date.now(),
          nodeId: opts?.nodeId,
        };
        set((s) => ({ entries: [...s.entries, entry] }));
        return entry;
      },

      setKind: (term, kind) => {
        if (!CONCEPT_KINDS.includes(kind)) return;
        set((s) => ({
          entries: s.entries.map((e) =>
            e.term === term ? { ...e, kind, kindSource: "manual" } : e,
          ),
        }));
      },

      remove: (term) => {
        set((s) => ({ entries: s.entries.filter((e) => e.term !== term) }));
      },

      detachNode: (nodeId) => {
        set((s) => ({
          entries: s.entries.map((e) =>
            e.nodeId === nodeId ? { ...e, nodeId: undefined } : e,
          ),
        }));
      },

      setPanelOpen: (open) => set({ panelOpen: open }),

      clear: () => set({ entries: [] }),
    }),
    {
      name: "termask-word-library",
      partialize: (s) => ({ entries: s.entries }),
    },
  ),
);
