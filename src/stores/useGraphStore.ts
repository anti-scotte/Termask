// src/stores/useGraphStore.ts
// 图谱工作区 Store：多图谱管理（持久化 key = termask-graphs）
//
// 设计要点：
//   - GraphDoc 直接持久化 React Flow 的 FlowNode[]/FlowEdge[]（可 JSON 序列化），
//     拖拽位置、选中态等 UI 状态原样保留，切换图谱零转换成本
//   - 浏览器扩展推送（concept-graph 事件）写入「当前图谱」：
//     当前无图谱时自动新建一个（自由发散模板），保证推送永不丢
//   - 关系边由「生成二者关系」产生后经 addRelationEdge 入库

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ConceptGraphPayload } from "@/types";
import type { FlowNode, FlowEdge, GraphTemplate } from "@/types/graph";
import { isGraphTemplate } from "@/types/graph";
import { payloadToFlow } from "@/lib/graphTransform";

/** 图谱文档（持久化单元） */
export interface GraphDoc {
  id: string;
  name: string;
  template: GraphTemplate;
  /** 最近一次推送的会话 ID（锚定扩展来源） */
  sessionId?: string;
  /** 最近一次推送的原文选段 */
  sourceExcerpt?: string;
  /** AI 逻辑梳理总结（generate_logic_chain 返回时写入） */
  summary?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: number;
  updatedAt: number;
}

function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface GraphState {
  graphs: GraphDoc[];
  /** 当前激活的图谱 id（持久化，重启恢复） */
  currentGraphId: string | null;

  createGraph: (name: string, template: GraphTemplate) => string;
  deleteGraph: (id: string) => void;
  setCurrentGraph: (id: string) => void;
  /** 保存当前图谱的节点/边/元信息（拖拽、生成关系、推送后调用） */
  updateGraph: (
    id: string,
    patch: Partial<
      Pick<GraphDoc, "nodes" | "edges" | "sessionId" | "sourceExcerpt" | "summary">
    >,
  ) => void;
  /** 在图谱中新增一条关系边（已存在同源同目标边时不重复加） */
  addRelationEdge: (
    id: string,
    edge: FlowEdge,
  ) => void;
  /**
   * 浏览器扩展推送 → 写入当前图谱（覆盖其节点/边，记录会话元信息）。
   * 无任何图谱时自动新建。返回实际写入的图谱 id。
   */
  applyPush: (payload: ConceptGraphPayload) => string;
}

/** 推送自动建图时的默认命名 */
function autoGraphName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `推送图谱 ${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const useGraphStore = create<GraphState>()(
  persist(
    (set, get) => ({
      graphs: [],
      currentGraphId: null,

      createGraph: (name, template) => {
        const id = genId();
        const now = Date.now();
        const doc: GraphDoc = {
          id,
          name: name.trim() || "未命名图谱",
          template,
          nodes: [],
          edges: [],
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          graphs: [...s.graphs, doc],
          currentGraphId: id, // 新建即激活
        }));
        return id;
      },

      deleteGraph: (id) => {
        set((s) => {
          const rest = s.graphs.filter((g) => g.id !== id);
          return {
            graphs: rest,
            // 删除的是当前图谱 → 切到剩余第一条，没有则置空
            currentGraphId:
              s.currentGraphId === id ? (rest[0]?.id ?? null) : s.currentGraphId,
          };
        });
      },

      setCurrentGraph: (id) => set({ currentGraphId: id }),

      updateGraph: (id, patch) => {
        set((s) => ({
          graphs: s.graphs.map((g) =>
            g.id === id ? { ...g, ...patch, updatedAt: Date.now() } : g,
          ),
        }));
      },

      addRelationEdge: (id, edge) => {
        set((s) => ({
          graphs: s.graphs.map((g) => {
            if (g.id !== id) return g;
            // 幂等：同 source+target 的边已存在（忽略方向）则跳过
            const dup = g.edges.some(
              (e) =>
                (e.source === edge.source && e.target === edge.target) ||
                (e.source === edge.target && e.target === edge.source),
            );
            if (dup) return g;
            return {
              ...g,
              edges: [...g.edges, edge],
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      applyPush: (payload) => {
        const s = get();
        // 无图谱时自动新建一个承载推送
        let targetId = s.currentGraphId;
        let template: GraphTemplate = "free";
        if (!targetId || !s.graphs.some((g) => g.id === targetId)) {
          targetId = genId();
          const now = Date.now();
          set((st) => ({
            graphs: [
              ...st.graphs,
              {
                id: targetId as string,
                name: autoGraphName(),
                template,
                nodes: [],
                edges: [],
                createdAt: now,
                updatedAt: now,
              },
            ],
            currentGraphId: targetId,
          }));
        } else {
          const cur = s.graphs.find((g) => g.id === targetId);
          if (cur && isGraphTemplate(cur.template)) template = cur.template;
        }

        const { nodes, edges } = payloadToFlow(payload, template);
        const id = targetId;
        set((st) => ({
          graphs: st.graphs.map((g) =>
            g.id === id
              ? {
                  ...g,
                  nodes,
                  edges,
                  sessionId: payload.sessionId,
                  sourceExcerpt: payload.sourceExcerpt,
                  updatedAt: Date.now(),
                }
              : g,
          ),
        }));
        return id;
      },
    }),
    {
      name: "termask-graphs",
    },
  ),
);
