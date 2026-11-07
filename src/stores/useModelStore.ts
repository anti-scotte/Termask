// src/stores/useModelStore.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ModelProviderConfig } from "@/types";
import { testModelConnection } from "@/lib/bridge";

/* ------------------------------------------------------------------ *
 *  Provider 表单数据（新建/编辑共用，剥离出 id 的纯数据形状）
 * ------------------------------------------------------------------ */
export type ModelProviderFormData = Omit<ModelProviderConfig, "id">;

/* ------------------------------------------------------------------ *
 *  连接测试瞬态状态（不持久化，重启清空）
 * ------------------------------------------------------------------ */
export type ConnectionStatus =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "success"; latencyMs: number; modelEcho?: string }
  | { state: "error"; message: string };

/* ------------------------------------------------------------------ *
 *  Store 接口定义（对齐《阶段3-工程状态交接单》3.1 节）
 * ------------------------------------------------------------------ */
interface ModelState {
  /** 全量 Provider 列表（持久化，含 apiKey） */
  providers: ModelProviderConfig[];
  /** 连接测试瞬态状态，key = provider.id（不持久化） */
  connectionStatuses: Record<string, ConnectionStatus>;

  addProvider: (data: ModelProviderFormData) => string;
  updateProvider: (id: string, patch: Partial<Omit<ModelProviderConfig, "id">>) => void;
  removeProvider: (id: string) => void;
  setDefaultProvider: (id: string) => void;
  getProvider: (id: string) => ModelProviderConfig | undefined;
  getDefaultProvider: () => ModelProviderConfig | undefined;
  testConnection: (id: string) => Promise<void>;
  clearConnectionStatus: (id: string) => void;
}

/** ID 生成器（Tauri webview 中 crypto.randomUUID 可用） */
function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      providers: [],
      connectionStatuses: {},

      addProvider: (data) => {
        const id = genId();
        set((s) => {
          // 新建第一个 Provider 时自动设为默认（单一默认约束）
          const isFirst = s.providers.length === 0;
          const provider: ModelProviderConfig = {
            id,
            ...data,
            enabled: isFirst,
          };
          return { providers: [...s.providers, provider] };
        });
        return id;
      },

      updateProvider: (id, patch) => {
        set((s) => {
          // 配置变更后，旧的连接测试结果不再可信 → 清空瞬态状态（对齐 T7 语义）
          const touchesConn = ["kind", "baseUrl", "apiKey", "model"].some(
            (k) => k in patch,
          );
          const statuses = s.connectionStatuses;
          const nextStatuses =
            touchesConn && id in statuses
              ? (() => {
                  const c = { ...statuses };
                  delete c[id];
                  return c;
                })()
              : statuses;
          return {
            providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
            connectionStatuses: nextStatuses,
          };
        });
      },

      removeProvider: (id) => {
        set((s) => {
          const removed = s.providers.find((p) => p.id === id);
          const rest = s.providers.filter((p) => p.id !== id);
          // 删除默认 Provider 时，自动提升剩余第一条为默认（不可变更新）
          if (removed?.enabled && rest.length > 0) {
            rest[0] = { ...rest[0], enabled: true };
          }
          // 同时清掉该条目的瞬态连接状态
          const statuses = { ...s.connectionStatuses };
          delete statuses[id];
          return { providers: rest, connectionStatuses: statuses };
        });
      },

      setDefaultProvider: (id) => {
        set((s) => ({
          providers: s.providers.map((p) => ({ ...p, enabled: p.id === id })),
        }));
      },

      getProvider: (id) => get().providers.find((p) => p.id === id),

      /** 严格语义：只有 enabled=true 的才是默认，无默认时返回 undefined */
      getDefaultProvider: () => get().providers.find((p) => p.enabled),

      /**
       * 测试已保存 Provider 的连接。
       * P1 风险缓解：testing 中忽略重复调用（Store 层加锁）。
       */
      testConnection: async (id) => {
        const provider = get().providers.find((p) => p.id === id);
        if (!provider) return;
        if (get().connectionStatuses[id]?.state === "testing") return;

        set((s) => ({
          connectionStatuses: { ...s.connectionStatuses, [id]: { state: "testing" } },
        }));

        try {
          const result = await testModelConnection({
            kind: provider.kind,
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey ?? "",
            model: provider.model,
          });
          set((s) => ({
            connectionStatuses: {
              ...s.connectionStatuses,
              [id]: result.success
                ? {
                    state: "success",
                    latencyMs: result.latencyMs,
                    modelEcho: result.modelEcho,
                  }
                : { state: "error", message: result.error ?? "未知错误" },
            },
          }));
        } catch (e) {
          // invoke 通道本身异常（Rust panic / 序列化失败等），同样归入 error 态
          set((s) => ({
            connectionStatuses: {
              ...s.connectionStatuses,
              [id]: {
                state: "error",
                message: e instanceof Error ? e.message : String(e),
              },
            },
          }));
        }
      },

      clearConnectionStatus: (id) => {
        set((s) => {
          const statuses = { ...s.connectionStatuses };
          delete statuses[id];
          return { connectionStatuses: statuses };
        });
      },
    }),
    {
      name: "termask-models",
      // connectionStatuses 为瞬态状态，只持久化 providers。
      // apiKey 当前随 providers 存 localStorage（S1 已知风险，后续迁 keyring）。
      partialize: (s) => ({ providers: s.providers }),
    },
  ),
);
