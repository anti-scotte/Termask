// src/stores/useAuthStore.ts
// 账户会话全局状态（Zustand）。
//
// 数据流：
//   App 挂载 → init() → invoke("get_current_session")
//   → 有会话：session 就绪，数据目录 users/{user_id}/
//   → 无会话：游客模式（数据落根目录），账户相关 UI 显示登录表单
//   登录/注册/退出 → Rust AuthState（含会话文件持久化）→ 本 store 同步。
//
// 设计说明：未登录不做硬性功能墙——游客模式是产品支持的一等公民
// （数据落根目录），仅在侧边栏与设置页明示当前身份。

import { create } from "zustand";
import {
  getCurrentSession,
  loginAccount,
  logoutAccount,
  registerAccount,
} from "@/lib/bridge";
import type { AuthSession } from "@/types";

interface AuthState {
  /** 当前会话；null = 未登录（游客模式） */
  session: AuthSession | null;
  /** 初始会话探测是否完成（防止启动期间误判为游客） */
  ready: boolean;
  /** 登录/注册/退出等变更操作的互斥标记 */
  busy: boolean;
  /** App 挂载时调用：读取磁盘会话文件恢复登录态 */
  init: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<AuthSession>;
  register: (payload: {
    identifier: string;
    password: string;
    code: string;
    nickname?: string;
  }) => Promise<AuthSession>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  ready: false,
  busy: false,

  init: async () => {
    try {
      const session = await getCurrentSession();
      set({ session, ready: true });
      if (session) {
        console.log(
          "[Auth] 会话恢复:",
          session.identifier,
          "(" + session.accountType + ")",
        );
      } else {
        console.log("[Auth] 无会话，游客模式");
      }
    } catch (e) {
      console.warn("[Auth] get_current_session 失败:", e);
      set({ session: null, ready: true });
    }
  },

  login: async (identifier, password) => {
    set({ busy: true });
    try {
      const session = await loginAccount(identifier, password);
      set({ session });
      return session;
    } finally {
      set({ busy: false });
    }
  },

  register: async (payload) => {
    set({ busy: true });
    try {
      const session = await registerAccount(payload);
      set({ session });
      return session;
    } finally {
      set({ busy: false });
    }
  },

  logout: async () => {
    set({ busy: true });
    try {
      await logoutAccount();
      set({ session: null });
    } finally {
      set({ busy: false });
    }
  },
}));
