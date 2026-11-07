import { NavLink } from "react-router-dom";
import { FileText, Network, Settings2, Settings, SquareStack, UserCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/useAuthStore";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/templates", label: "模板管理", icon: FileText },
  { to: "/graph", label: "概念图谱", icon: Network },
  { to: "/whiteboard", label: "白板", icon: SquareStack },
  { to: "/models", label: "模型设置", icon: Settings2 },
  { to: "/settings", label: "设置", icon: Settings },
];

export function Sidebar() {
  const session = useAuthStore((s) => s.session);

  return (
    <aside className="flex h-full w-56 flex-col bg-slate-900 text-slate-300">
      <div className="flex h-14 items-center px-5">
        <span className="text-base font-semibold tracking-wide text-white">
          TermAsk 工作台
        </span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-slate-800 text-white"
                  : "hover:bg-slate-800/60 hover:text-white",
              )
            }
          >
            <Icon size={16} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* 身份区：已登录显示昵称（点击进设置），未登录显示游客模式 */}
      <NavLink
        to="/settings"
        className="flex items-center gap-2 border-t border-slate-800 px-5 py-4 text-xs text-slate-500 transition-colors hover:text-slate-300"
        title={session ? "已登录，点击进入设置" : "游客模式，点击登录/注册"}
      >
        <UserCircle
          size={16}
          className={session ? "text-emerald-400" : ""}
        />
        <span className="min-w-0 flex-1 truncate">
          {session
            ? session.nickname || session.identifier
            : "游客模式 · 未登录"}
        </span>
        <span className="shrink-0">v0.1.0</span>
      </NavLink>
    </aside>
  );
}
