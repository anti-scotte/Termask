import { useEffect } from "react";
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { WorkspaceBackdrop } from "@/components/layout/WorkspaceBackdrop";
import { TemplatesPage } from "@/pages/TemplatesPage";
import { GraphPage } from "@/pages/GraphPage";
import { WhiteboardPage } from "@/pages/WhiteboardPage";
import { ModelsPage } from "@/pages/ModelsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useAuthStore } from "@/stores/useAuthStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { usePrefsStore } from "@/stores/usePrefsStore";
import { listenTriggerShortcut } from "@/lib/bridge";

/**
 * 全局快捷键唤起（Ctrl+Shift+Q → Rust emit "trigger-shortcut"）。
 * 必须放在 Router 内部才能用 useNavigate；仅切页，不抢系统焦点
 * （抢焦点需要 core:window:allow-set-focus 权限，暂不申请）。
 */
function ShortcutBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const pending = listenTriggerShortcut(() => navigate("/graph"));
    return () => {
      void pending.then((off) => off());
    };
  }, [navigate]);
  return null;
}

/**
 * Dashboard：深色侧边栏 + 深色主内容区（.dark 挂在 <html> 上，主题令牌见 index.css）
 *
 * 用 HashRouter 而非 BrowserRouter：Tauri 生产环境走自定义协议
 * （tauri://localhost），没有服务端路由回退，hash 模式最稳。
 *
 * 挂载时序（账户系统）：
 *   1. useAuthStore.init() → invoke("get_current_session") 读取磁盘会话文件；
 *      有会话 = 已登录（数据目录 users/{userId}/），无会话 = 游客模式。
 *      游客模式不做硬性功能墙（后端数据本就落根目录），身份明示在侧边栏。
 *   2. useSettingsStore.load() → invoke("load_user_settings") 恢复
 *      快捷键/导出格式等用户设置（登录/退出后再次调用以切换隔离目录）。
 */
export default function App() {
  const session = useAuthStore((s) => s.session);
  const initAuth = useAuthStore((s) => s.init);
  const loadSettings = useSettingsStore((s) => s.load);
  const ambientBackdrop = usePrefsStore((s) => s.ambientBackdrop);

  // 会话探测只跑一次；用户设置在会话确定后加载（登录态决定读取哪份文件）
  useEffect(() => {
    void initAuth();
  }, [initAuth]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings, session?.userId]);

  return (
    <HashRouter>
      <ShortcutBridge />
      <div className="flex h-full bg-background">
        {ambientBackdrop && <WorkspaceBackdrop />}
        {/* 内容层置于氛围背景之上 */}
        <div className="relative z-10 flex min-w-0 flex-1">
          <Sidebar />
          <main className="min-w-0 flex-1 overflow-y-auto p-8">
            <Routes>
              <Route path="/" element={<Navigate to="/templates" replace />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/graph" element={<GraphPage />} />
              <Route path="/whiteboard" element={<WhiteboardPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/templates" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </HashRouter>
  );
}
