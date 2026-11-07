// src/pages/SettingsPage.tsx
// 设置页（v2）：账户 / 通用 / 快捷键 三个 Tab —— 后端接口全接线
//
// - 账户：真实调用 Rust 命令（register_account / login_account /
//   logout_account / send_verification_code），会话状态存 useAuthStore；
//   模拟发码模式下 devCode 直接展示给用户。
// - 通用：开机自启动（tauri-plugin-autostart 静态导入，依赖已装、不吞错）、
//   自动更新（updater 未配置，占位）、数据存储路径（get_data_location 权威 + setDataLocation 迁移）、
//   数据导出格式（JSON / Markdown，useSettingsStore 持久化到后端）。
// - 快捷键：录制式配置 → useSettingsStore（Zustand）→ 防抖 invoke
//   save_user_settings 同步后端（登录态隔离存储）；真·全局注册待
//   tauri-plugin-global-shortcut 接入。

import { useEffect, useRef, useState } from "react";
import {
  User,
  Lock,
  Mail,
  Phone,
  Keyboard,
  HardDrive,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Eye,
  EyeOff,
  Timer,
  LogIn,
  UserPlus,
  Settings,
  Copy,
  Check,
  Loader2,
  CircleAlert,
  FileDown,
  Palette,
  Sparkles,
} from "lucide-react";
import { isEnabled, enable, disable } from "@tauri-apps/plugin-autostart";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/useAuthStore";
import {
  useSettingsStore,
  DEFAULT_HOTKEYS,
  type HotkeyId,
  type HotkeyConfig,
} from "@/stores/useSettingsStore";
import { sendVerificationCode, getBatchMode, setBatchMode } from "@/lib/bridge";
import { getDataLocation, setDataLocation } from "@/lib/bridge-ext";
import {
  getBridgeSecurity,
  rotateBridgeToken,
  setBridgeRequireToken,
  setGlobalShortcut,
  type BridgeSecurityInfo,
} from "@/lib/bridge";
import { usePrefsStore } from "@/stores/usePrefsStore";
import type { EdgeLineStyle, GraphTemplate } from "@/types/graph";
import { EDGE_STYLE_META, TEMPLATE_META } from "@/types/graph";

/* ------------------------------------------------------------------ *
 *  类型与常量
 * ------------------------------------------------------------------ */
type AuthMode = "login" | "register";
type ContactType = "phone" | "email";

const HOTKEY_META: Array<{
  id: HotkeyId;
  label: string;
  desc: string;
}> = [
  {
    id: "quickTrigger",
    label: "划词直接触发",
    desc: "选中文字后按此组合键，立即送入工作台分析",
  },
  {
    id: "openWorkbench",
    label: "打开工作台",
    desc: "任意界面下呼出 / 收起 TermAsk 主窗口",
  },
];


/** 组合键展示美化 */
function prettyHotkey(hk: string): string {
  return hk
    .split("+")
    .map((k) => (k.length === 1 ? k.toUpperCase() : k))
    .join(" + ");
}

/* ------------------------------------------------------------------ *
 *  个性化偏好分区（usePrefsStore，localStorage 持久化）
 * ------------------------------------------------------------------ */
function PrefToggle({
  title,
  desc,
  value,
  onChange,
}: {
  title: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ${
          value ? "bg-emerald-500" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
            value ? "translate-x-[22px]" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

/** 个性化设置：氛围背景 / 画布点阵 / MiniMap / 默认连线形态 */
function PersonalizationTab() {
  const prefs = usePrefsStore();
  return (
    <div className="space-y-3">
      <PrefToggle
        title="工作台氛围背景"
        desc="三条模板色光带缓慢漂移 + 细织纹质感（关闭后回到纯色底）"
        value={prefs.ambientBackdrop}
        onChange={(v) => prefs.update({ ambientBackdrop: v })}
      />
      <PrefToggle
        title="图谱画布点阵网格"
        desc="概念图谱画布的点阵背景，帮助感知缩放位置"
        value={prefs.canvasDots}
        onChange={(v) => prefs.update({ canvasDots: v })}
      />
      <PrefToggle
        title="图谱 MiniMap 小地图"
        desc="画布右下角的缩略导航（可拖动/缩放定位）"
        value={prefs.showMiniMap}
        onChange={(v) => prefs.update({ showMiniMap: v })}
      />
      <PrefToggle
        title="连线动态特效"
        desc="连线上的流动虚线动画（关闭后连线静态呈现，性能更佳）"
        value={prefs.edgeAnimated}
        onChange={(v) => prefs.update({ edgeAnimated: v })}
      />

      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              规整折线 · 弯折圆弧半径
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              90° 折线在弯折处的圆滑程度（0 = 直角，全局即时生效）
            </p>
          </div>
          <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {prefs.edgeCornerRadius}px
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={32}
          step={2}
          value={prefs.edgeCornerRadius}
          onChange={(e) =>
            prefs.update({ edgeCornerRadius: Number(e.target.value) })
          }
          className="mt-2.5 w-full cursor-pointer accent-sky-500"
          aria-label="弯折圆弧半径"
        />
      </div>

      <PrefToggle
        title="词语类型角标"
        desc="词框右上角的小圆点标注词语类型（专业名词/学术用语/工程用语/民间科普/自定义笔记）"
        value={prefs.showKindBadge}
        onChange={(v) => prefs.update({ showKindBadge: v })}
      />

      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <p className="text-sm font-medium text-foreground">图谱导出默认格式</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          导出对话框默认选中的格式（docx 待后端命令支持）
        </p>
        <div className="mt-2.5 grid grid-cols-5 gap-1.5">
          {(
            ["json", "markdown", "html", "png", "pdf", "docx"] as const
          ).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => prefs.update({ defaultExportFormat: f })}
              className={cn(
                "cursor-pointer rounded-md border px-2 py-1.5 text-xs uppercase transition-colors",
                prefs.defaultExportFormat === f
                  ? "border-sky-400/60 bg-sky-400/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/40",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <p className="text-sm font-medium text-foreground">默认连线形态</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          新建连线使用的形态（画布顶部工具条可随时切换，双击连线循环换形态）
        </p>
        <div className="mt-2.5 flex gap-1.5">
          {(Object.keys(EDGE_STYLE_META) as EdgeLineStyle[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => prefs.update({ defaultEdgeStyle: k })}
              className={cn(
                "flex-1 cursor-pointer rounded-md border px-3 py-1.5 text-xs transition-colors",
                prefs.defaultEdgeStyle === k
                  ? "border-sky-400/60 bg-sky-400/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/40",
              )}
            >
              {EDGE_STYLE_META[k].label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 专区设置：概念图谱 / 收集与词库（各功能区的专属配置） */
function ZoneTab() {
  const prefs = usePrefsStore();
  const [batchMode, setBatchModeState] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    getBatchMode()
      .then(setBatchModeState)
      .catch(() => undefined);
  }, []);

  const toggleBatch = async () => {
    try {
      const next = await setBatchMode(!batchMode);
      setBatchModeState(next);
      setNotice(next ? "批量模式已开启" : "批量模式已关闭");
    } catch {
      setNotice("批量模式切换失败（工作台未运行？）");
    }
  };

  return (
    <div className="space-y-3">
      {/* 概念图谱专区 */}
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        <p className="text-sm font-medium text-foreground">概念图谱 · 默认模板</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          新建图谱弹窗默认选中的模板
        </p>
        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          {(Object.keys(TEMPLATE_META) as GraphTemplate[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => prefs.update({ defaultTemplate: t })}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition-colors",
                prefs.defaultTemplate === t
                  ? "border-sky-400/60 bg-sky-400/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/40",
              )}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: TEMPLATE_META[t].dot }}
                aria-hidden
              />
              {TEMPLATE_META[t].label}
            </button>
          ))}
        </div>
      </div>

      <PrefToggle
        title="概念图谱 · 新建自动铺开填充框"
        desc="创建图谱后立即铺开该模板的可填充概念框（关闭后从空画布开始）"
        value={prefs.autoScaffold}
        onChange={(v) => prefs.update({ autoScaffold: v })}
      />

      {/* 扩展专区 */}
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            浏览器扩展 · 批量划词模式
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            开启后浏览器里划词即自动静默收集，无需点「加入图谱」（与图谱页收集区开关同步）
          </p>
          {notice && (
            <p className="mt-1 text-xs text-emerald-500">{notice}</p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={batchMode}
          onClick={() => void toggleBatch()}
          className={cn(
            "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200",
            batchMode ? "bg-amber-500" : "bg-muted-foreground/30",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200",
              batchMode ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
    </div>
  );
}

/**
 * SMTP 邮件发送配置（2026-11-07 后端批次）：
 * enabled / server / port / username / password（不回显，留空=保留）/ encryption / fromName
 * 命令未上线时整卡优雅降级。
 */
function SmtpCard() {
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);
  const [info, setInfo] = useState<{
    hasPassword: boolean;
    mockMode: boolean;
  } | null>(null);
  const [form, setForm] = useState<{
    enabled: boolean;
    server: string;
    port: number;
    username: string;
    password: string;
    encryption: "starttls" | "ssl" | "none";
    fromName: string;
  }>({
    enabled: false,
    server: "",
    port: 465,
    username: "",
    password: "",
    encryption: "ssl",
    fromName: "TermAsk",
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { getSmtpConfig } = await import("@/lib/bridge-ext");
        const info = await getSmtpConfig();
        if (!alive) return;
        setForm((f) => ({
          ...f,
          enabled: info.enabled,
          server: info.server,
          port: info.port,
          username: info.username,
          password: "", // 授权码永不回显
          encryption: info.encryption,
          fromName: info.fromName,
        }));
        setInfo({ hasPassword: info.hasPassword, mockMode: info.mockMode });
        setLoading(false);
      } catch (e) {
        if (!alive) return;
        setAvailable(false);
        setLoading(false);
        console.warn("[Settings] SMTP 命令不可用（后端未上线）:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const { setSmtpConfig, getSmtpConfig } = await import("@/lib/bridge-ext");
      await setSmtpConfig({
        enabled: form.enabled,
        server: form.server.trim(),
        port: Number(form.port) || 465,
        username: form.username.trim(),
        // 留空 = 保留原授权码（后端约定）
        password: form.password,
        encryption: form.encryption,
        fromName: form.fromName.trim(),
      });
      const fresh = await getSmtpConfig();
      setInfo({ hasPassword: fresh.hasPassword, mockMode: fresh.mockMode });
      setForm((f) => ({ ...f, password: "" }));
      setNotice({
        msg: fresh.mockMode
          ? "已保存（未启用真实邮件，验证码仍为模拟模式）"
          : "已保存（真实邮件模式已启用）",
        ok: true,
      });
    } catch (e) {
      setNotice({
        msg: `保存失败：${e instanceof Error ? e.message : String(e)}`,
        ok: false,
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;
  if (!available) {
    return (
      <div className="rounded-lg border border-border bg-card px-5 py-4">
        <p className="text-sm font-medium text-foreground">SMTP 邮件发送</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          后端 get_smtp_config 命令未上线（见后端请求清单），上线后可在此配置真实邮件发送
        </p>
      </div>
    );
  }

  const field =
    "h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-sky-400/60";

  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">SMTP 邮件发送</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            配置真实邮件发送验证码；关闭时验证码为模拟模式
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {info && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] ${
                info.mockMode
                  ? "bg-amber-500/15 text-amber-600"
                  : "bg-emerald-500/15 text-emerald-600"
              }`}
            >
              {info.mockMode ? "模拟模式" : "真实邮件"}
            </span>
          )}
          {info?.hasPassword && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              已存授权码
            </span>
          )}
        </div>
      </div>

      {/* 启用开关 */}
      <label className="mt-3 flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          className="h-3.5 w-3.5 cursor-pointer accent-emerald-500"
        />
        <span className="text-xs text-foreground">启用真实邮件发送</span>
      </label>

      {/* 配置网格 */}
      <div
        className={`mt-2.5 grid grid-cols-2 gap-2 transition-opacity ${form.enabled ? "" : "pointer-events-none opacity-40"}`}
      >
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">SMTP 服务器</span>
          <input
            className={field}
            value={form.server}
            onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))}
            placeholder="smtp.qq.com"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">端口</span>
          <input
            className={field}
            type="number"
            value={form.port}
            onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))}
            placeholder="465"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">发件账号</span>
          <input
            className={field}
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            placeholder="user@example.com"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">
            授权码{info?.hasPassword ? "（留空保留）" : ""}
          </span>
          <input
            className={field}
            type="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            placeholder={info?.hasPassword ? "••••••（已保存）" : "SMTP 授权码"}
            autoComplete="new-password"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">加密方式</span>
          <select
            className={field + " cursor-pointer"}
            value={form.encryption}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                encryption: e.target.value as "starttls" | "ssl" | "none",
              }))
            }
          >
            <option value="ssl">SSL</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">无加密</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] text-muted-foreground">发件人名称</span>
          <input
            className={field}
            value={form.fromName}
            onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))}
            placeholder="TermAsk"
          />
        </label>
      </div>

      {notice && (
        <p
          className={`mt-2 text-xs ${notice.ok ? "text-emerald-500" : "text-destructive"}`}
        >
          {notice.msg}
        </p>
      )}

      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving}>
          保存 SMTP 配置
        </Button>
      </div>
    </div>
  );
}

/** 检查更新（v0.1.0）：tauri-plugin-updater 能力探测；插件未注册时优雅降级 */
function UpdaterCard() {
  const [state, setState] = useState<{
    checking: boolean;
    available: boolean;
    version?: string;
    notes?: string;
    error: string | null;
    done: boolean;
  }>({ checking: false, available: false, error: null, done: false });

  const check = async () => {
    setState((s) => ({ ...s, checking: true, error: null, done: false }));
    try {
      const { checkAppUpdate, installAppUpdate } = await import("@/lib/bridge");
      const info = await checkAppUpdate();
      if (info.available) {
        setState({
          checking: false,
          available: true,
          version: info.latestVersion,
          notes: info.notes,
          error: null,
          done: false,
        });
        // 自动进入安装（v0.1.0 简化：确认即装）
        try {
          await installAppUpdate();
          setState((s) => ({ ...s, done: true }));
        } catch (e) {
          setState((s) => ({
            ...s,
            error: `安装失败：${e instanceof Error ? e.message : String(e)}`,
          }));
        }
      } else {
        setState({
          checking: false,
          available: false,
          error: null,
          done: true,
        });
      }
    } catch (e) {
      // updater 插件未注册 / 非 Tauri 环境 → 优雅降级
      setState({
        checking: false,
        available: false,
        error: null,
        done: true,
      });
      console.warn("[Settings] updater 不可用（插件未注册或签名未配置）:", e);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">自动更新</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {state.checking
              ? "正在检查更新…"
              : state.done && !state.available
                ? "当前已是最新版本"
                : state.available
                  ? `发现新版本 ${state.version ?? ""}${state.done ? "，安装完成，重启应用生效" : ""}`
                  : "连接更新服务器检查新版本（tauri-plugin-updater）"}
          </p>
          {state.notes && (
            <p className="mt-1 line-clamp-3 text-xs text-muted-foreground/80">
              {state.notes}
            </p>
          )}
          {state.error && (
            <p className="mt-1 text-xs text-destructive">{state.error}</p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => void check()} disabled={state.checking}>
          <RefreshCw className={cn("h-3.5 w-3.5", state.checking && "animate-spin")} />
          {state.available && !state.done ? "安装" : "检查更新"}
        </Button>
      </div>
    </div>
  );
}

/** 应用内快捷键（v0.1.0 固定键位，学习效率导向；后续版本开放自定义录制） */
function InAppHotkeysCard() {
  const rows = [
    { key: "N", desc: "新增空白词汇框（点击填写 / 拖词填充）" },
    { key: "B", desc: "加入 / 删除纸张边框（导出裁剪范围）" },
    { key: "Q", desc: "打开 / 收起 AI 追问区" },
    { key: "E", desc: "打开图谱导出（JSON/MD/HTML/PNG/PDF）" },
    { key: "T", desc: "打开图谱质量测验（评分 + 用时）" },
    { key: "Esc", desc: "退出连线模式 / 关闭右键菜单" },
    { key: "Delete", desc: "删除选中节点与连线（可撤销）" },
  ];
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-sm font-medium text-foreground">应用内快捷键</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        概念图谱页生效；在输入框内按键不会触发。以缩短学习操作路径为目标设定。
      </p>
      <div className="mt-2 space-y-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 text-xs">
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {r.key}
            </kbd>
            <span className="text-muted-foreground">{r.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  SettingsPage — 导出组件
 *
 *  v3：登录页 与 工作台设置 并列展示；设置内分 通用 / 个性化 / 专区 三子页
 * ------------------------------------------------------------------ */
export function SettingsPage() {
  // 主页签：登录页（账户） 与 设置 并列
  const [mainTab, setMainTab] = useState<"account" | "settings">("account");
  // 设置内子页签
  const [subTab, setSubTab] = useState<"general" | "personal" | "zone">(
    "general",
  );

  const MAIN_TABS: Array<{
    id: "account" | "settings";
    label: string;
    icon: typeof User;
  }> = [
    { id: "account", label: "登录页", icon: User },
    { id: "settings", label: "工作台设置", icon: Settings },
  ];

  const SUB_TABS: Array<{
    id: "general" | "personal" | "zone";
    label: string;
    icon: typeof User;
  }> = [
    { id: "general", label: "通用", icon: Settings },
    { id: "personal", label: "个性化", icon: Palette },
    { id: "zone", label: "专区", icon: Sparkles },
  ];

  const tabBtnCls = (active: boolean) => `
    flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md
    px-4 py-2 text-sm font-medium transition-all duration-150
    ${
      active
        ? "bg-accent text-accent-foreground shadow-sm"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
    }
  `;

  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground">设置</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        登录账户，或调整工作台的外观、行为与各功能区偏好。
      </p>

      {/* 主页签：登录页 / 工作台设置 */}
      <div className="mt-5 flex gap-1 rounded-lg border border-border bg-card p-1">
        {MAIN_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setMainTab(id)}
            className={tabBtnCls(mainTab === id)}
            aria-selected={mainTab === id}
            role="tab"
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* 主内容 */}
      <div className="mt-4">
        {mainTab === "account" ? (
          <AccountTab />
        ) : (
          <>
            {/* 子页签：通用 / 个性化 / 专区 */}
            <div className="flex gap-1 rounded-lg border border-border/60 bg-muted/40 p-1">
              {SUB_TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSubTab(id)}
                  className={cn(tabBtnCls(subTab === id), "py-1.5 text-xs")}
                  aria-selected={subTab === id}
                  role="tab"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3">
              {subTab === "general" && (
                <>
                  <GeneralTab />
                  {/* 快捷键归入通用（应用级输入习惯） */}
                  <div className="mt-4">
                    <HotkeysTab />
                  </div>
                  {/* 自动更新（v0.1.0，updater 插件能力探测） */}
                  <div className="mt-4">
                    <UpdaterCard />
                  </div>
                  {/* SMTP 邮件发送配置（验证码真实邮件） */}
                  <div className="mt-4">
                    <SmtpCard />
                  </div>
                  {/* 应用内快捷键速查 */}
                  <div className="mt-4">
                    <InAppHotkeysCard />
                  </div>
                </>
              )}
              {subTab === "personal" && <PersonalizationTab />}
              {subTab === "zone" && <ZoneTab />}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 *  账户 Tab：真实 Rust 命令接线（register/login/logout/send_verification_code)
 * ------------------------------------------------------------------ */
function AccountTab() {
  const session = useAuthStore((s) => s.session);
  const busy = useAuthStore((s) => s.busy);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const logout = useAuthStore((s) => s.logout);

  const [mode, setMode] = useState<AuthMode>("login");
  const [contactType, setContactType] = useState<ContactType>("phone");
  const [contact, setContact] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(
    null,
  );
  const timerRef = useRef<number | null>(null);

  // 验证码倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    timerRef.current = window.setTimeout(
      () => setCountdown((c) => c - 1),
      1000,
    );
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [countdown]);

  const contactValid =
    contactType === "phone"
      ? /^1[3-9]\d{9}$/.test(contact.trim())
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim());
  const canSubmit =
    contactValid &&
    password.length >= 6 &&
    (mode === "login" || /^\d{4,6}$/.test(code.trim()));

  /** 发送验证码：调后端 send_verification_code；模拟模式回显 devCode */
  const handleSendCode = async () => {
    if (!contactValid || countdown > 0 || sendingCode) return;
    setSendingCode(true);
    setNotice(null);
    try {
      const r = await sendVerificationCode(contact.trim());
      if (r.success) {
        setCountdown(Math.max(r.expiresIn, 60));
        setNotice({
          msg: r.devCode
            ? `验证码已生成（模拟模式）：${r.devCode}，请在下方输入`
            : "验证码已发送，请查收",
          ok: true,
        });
      } else {
        setNotice({ msg: r.error ?? "验证码发送失败", ok: false });
      }
    } catch (e) {
      setNotice({
        msg: `发送失败：${e instanceof Error ? e.message : String(e)}`,
        ok: false,
      });
    } finally {
      setSendingCode(false);
    }
  };

  /** 登录 / 注册：调后端真实命令（成功即建立会话） */
  const handleAuthSubmit = async () => {
    if (!canSubmit || busy) return;
    setNotice(null);
    try {
      if (mode === "login") {
        const s = await login(contact.trim(), password);
        console.log("[Auth] 登录成功:", s.identifier);
        setNotice({
          msg: `登录成功，欢迎回来，${s.nickname || s.identifier}`,
          ok: true,
        });
      } else {
        const s = await register({
          identifier: contact.trim(),
          password,
          code: code.trim(),
          nickname: nickname.trim() || undefined,
        });
        console.log("[Auth] 注册成功:", s.identifier);
        setNotice({
          msg: `注册成功，已自动登录，欢迎 ${s.nickname || s.identifier}`,
          ok: true,
        });
      }
      setPassword("");
      setCode("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNotice({ msg, ok: false });
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      setNotice({ msg: "已退出登录（游客模式）", ok: true });
    } catch (e) {
      setNotice({
        msg: `退出失败：${e instanceof Error ? e.message : String(e)}`,
        ok: false,
      });
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      {session ? (
        /* 已登录态 */
        <div className="flex flex-col items-center py-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15">
            <ShieldCheck className="h-7 w-7 text-emerald-400" />
          </div>
          <p className="mt-4 text-sm font-medium text-foreground">
            {session.nickname || session.identifier}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {session.identifier} ·{" "}
            {session.accountType === "phone" ? "手机账号" : "邮箱账号"}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/60">
            数据隔离目录：users/{session.userId}/（图谱与设置随账号保存）
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-5"
            disabled={busy}
            onClick={() => void handleLogout()}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            退出登录
          </Button>
        </div>
      ) : (
        /* 未登录：登录/注册表单 */
        <>
          {/* 模式切换 */}
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {(
              [
                { id: "login", label: "登录", icon: LogIn },
                { id: "register", label: "注册", icon: UserPlus },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setMode(id);
                  setNotice(null);
                }}
                className={`
                  flex flex-1 cursor-pointer items-center justify-center gap-1.5
                  rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-150
                  ${
                    mode === id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }
                `}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          <div className="mt-5 space-y-4">
            {/* 手机 / 邮箱切换 + 输入 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="auth-contact">
                  {contactType === "phone" ? "手机号" : "邮箱地址"}
                </Label>
                <div className="flex gap-1 text-xs">
                  {(
                    [
                      { id: "phone", label: "手机", icon: Phone },
                      { id: "email", label: "邮箱", icon: Mail },
                    ] as const
                  ).map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setContactType(id);
                        setContact("");
                      }}
                      className={cn(
                        "flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 transition-colors",
                        contactType === id
                          ? "bg-sky-500/15 text-sky-300"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="h-3 w-3" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <Input
                id="auth-contact"
                placeholder={
                  contactType === "phone" ? "13800138000" : "you@example.com"
                }
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                autoComplete="username"
              />
              {contact && !contactValid && (
                <p className="flex items-center gap-1 text-xs text-amber-400">
                  <CircleAlert className="h-3 w-3" />
                  {contactType === "phone"
                    ? "请输入 11 位大陆手机号"
                    : "请输入有效的邮箱地址"}
                </p>
              )}
            </div>

            {/* 昵称（注册时可选） */}
            {mode === "register" && (
              <div className="space-y-2">
                <Label htmlFor="auth-nickname">昵称（可选）</Label>
                <Input
                  id="auth-nickname"
                  placeholder="怎么称呼你"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={20}
                />
              </div>
            )}

            {/* 验证码（注册时）：调后端 send_verification_code */}
            {mode === "register" && (
              <div className="space-y-2">
                <Label htmlFor="auth-code">验证码</Label>
                <div className="flex gap-2">
                  <Input
                    id="auth-code"
                    placeholder="4-6 位数字"
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    className="flex-1 font-mono"
                    inputMode="numeric"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 gap-1.5 px-3 text-xs"
                    disabled={!contactValid || countdown > 0 || sendingCode}
                    onClick={() => void handleSendCode()}
                  >
                    {sendingCode ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : countdown > 0 ? (
                      <>
                        <Timer className="h-3.5 w-3.5" />
                        {countdown}s 后重发
                      </>
                    ) : (
                      "获取验证码"
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* 密码 */}
            <div className="space-y-2">
              <Label htmlFor="auth-password">密码</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  id="auth-password"
                  type={showPwd ? "text" : "password"}
                  placeholder="至少 6 位"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-9 pr-10"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAuthSubmit();
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground/60 transition-colors hover:text-foreground"
                  title={showPwd ? "隐藏密码" : "显示密码"}
                >
                  {showPwd ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {/* 提交：调 Rust register_account / login_account */}
            <Button
              className="w-full gap-2"
              disabled={!canSubmit || busy}
              onClick={() => void handleAuthSubmit()}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "login" ? "登录" : "注册并登录"}
            </Button>

            {/* 结果提示条 */}
            {notice && (
              <p
                className={cn(
                  "rounded-md px-3 py-2 text-xs animate-in fade-in slide-in-from-top-1 fill-mode-both duration-200",
                  notice.ok
                    ? "bg-emerald-500/10 text-emerald-300"
                    : "bg-red-500/10 text-red-300",
                )}
              >
                {notice.msg}
              </p>
            )}

            <p className="text-center text-[11px] leading-relaxed text-muted-foreground/60">
              账户数据保存在本机（应用数据目录），登录后图谱与设置按账号隔离存储。
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  通用 Tab：开机自启动 / 自动更新 / 数据导出格式 / 数据存储路径
 * ------------------------------------------------------------------ */
function GeneralTab() {
  /* --- 开机自启动（tauri-plugin-autostart 能力探测） --- */
  const [autostart, setAutostart] = useState<{
    available: boolean;
    enabled: boolean;
    busy: boolean;
  }>({ available: false, enabled: false, busy: false });
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(
    null,
  );

  /* --- 数据存储路径（核心 API appDataDir） --- */
  const [dataDir, setDataDir] = useState("");
  const [copied, setCopied] = useState(false);

  /* --- 导出格式（统一到 prefs.defaultExportFormat，与导出对话框同源） --- */
  const prefsFmt = usePrefsStore(
    (s) => s.defaultExportFormat,
  ) as "json" | "markdown" | "html" | "png" | "pdf" | "docx";
  const updatePrefs = usePrefsStore((s) => s.update);
  void useSettingsStore; // 旧 exportFormat 字段保留兼容，UI 不再读取

  /* --- 更改数据目录：dialog 选文件夹 → setDataLocation（迁移复制，不删旧目录） --- */
  const [dirNotice, setDirNotice] = useState<{ msg: string; ok: boolean } | null>(
    null,
  );
  const [dirBusy, setDirBusy] = useState(false);
  const changeDataDir = async () => {
    if (dirBusy) return;
    setDirBusy(true);
    setDirNotice(null);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择新的数据存储目录（需为空目录）",
      });
      if (typeof picked !== "string") {
        setDirNotice({ msg: "已取消", ok: true });
        return;
      }
      const newPath = await setDataLocation(picked);
      setDataDir(newPath);
      setDirNotice({
        msg: `数据已复制到 ${newPath}，此后读写走新目录。建议重启应用，使各功能区的数据缓存完全切换。`,
        ok: true,
      });
    } catch (e) {
      // 不吞错：后端校验失败（非空目录/不可写/父子目录）或对话框异常，原样呈现
      setDirNotice({
        msg: `迁移失败：${e instanceof Error ? e.message : String(e)}`,
        ok: false,
      });
    } finally {
      setDirBusy(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    // 开机自启动状态：直接调用（依赖已安装；不吞错——异常原样抛出便于定位）
    void isEnabled().then((enabled) => {
      if (mounted) setAutostart({ available: true, enabled, busy: false });
    });
    // 数据目录权威值：后端 get_data_location（迁移后仍正确；appDataDir 只是默认根）
    getDataLocation()
      .then((d) => mounted && setDataDir(d))
      .catch(
        (e) =>
          mounted &&
          setDataDir(`（获取失败：${e instanceof Error ? e.message : String(e)}）`),
      );
    return () => {
      mounted = false;
    };
  }, []);

  const toggleAutostart = async () => {
    if (autostart.busy) return;
    setAutostart((s) => ({ ...s, busy: true }));
    try {
      if (autostart.enabled) {
        await disable();
        setAutostart((s) => ({ ...s, enabled: false }));
        setNotice({ msg: "已关闭开机自启动", ok: true });
      } else {
        await enable();
        setAutostart((s) => ({ ...s, enabled: true }));
        setNotice({ msg: "已开启开机自启动", ok: true });
      }
    } catch (e) {
      setNotice({
        msg: `操作失败：${e instanceof Error ? e.message : String(e)}`,
        ok: false,
      });
    } finally {
      setAutostart((s) => ({ ...s, busy: false }));
    }
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(dataDir);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  return (
    <div className="space-y-4">
      {notice && (
        <p
          className={cn(
            "rounded-md px-3 py-2 text-xs animate-in fade-in slide-in-from-top-1 fill-mode-both duration-200",
            notice.ok
              ? "bg-emerald-500/10 text-emerald-300"
              : "bg-red-500/10 text-red-300",
          )}
        >
          {notice.msg}
        </p>
      )}

      {/* 开机自启动 */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex items-start gap-3">
          <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">开机自启动</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {autostart.available
                ? "系统登录后自动在后台启动 TermAsk 工作台"
                : "需要安装 tauri-plugin-autostart 插件（Cargo.toml + JS 包）后可用"}
            </p>
          </div>
        </div>
        {autostart.available ? (
          <Switch
            checked={autostart.enabled}
            disabled={autostart.busy}
            onChange={() => void toggleAutostart()}
          />
        ) : (
          <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
            插件未安装
          </span>
        )}
      </div>

      {/* 桥接安全 */}
      <BridgeSecurityCard />

      {/* 数据导出格式（与导出对话框同一偏好：prefs.defaultExportFormat） */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex items-start gap-3">
          <FileDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">
              图谱导出格式
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              与画布「导出」对话框共用同一偏好（后端渲染落盘 exports/）
            </p>
          </div>
        </div>
        <Select
          value={prefsFmt}
          onValueChange={(v) => {
            updatePrefs({ defaultExportFormat: v as typeof prefsFmt });
            setNotice({
              msg: `导出格式已设为 ${v.toUpperCase()}`,
              ok: true,
            });
          }}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="选择格式" />
          </SelectTrigger>
          <SelectContent>
            {(["json", "markdown", "html", "png", "pdf", "docx"] as const).map(
              (f) => (
                <SelectItem key={f} value={f}>
                  {f.toUpperCase()}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      </div>

      {/* 数据存储路径 */}
      <div className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex items-start gap-3">
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              数据存储空间
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              图谱项目与本地数据保存在以下目录（登录后按 users/{"{userId}"}
              / 子目录隔离）
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2.5 py-1.5 font-mono text-xs text-foreground/90">
                {dataDir || "读取中…"}
              </code>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                disabled={!dataDir}
                onClick={() => void copyPath()}
                title="复制路径"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1 text-xs"
                disabled={dirBusy}
                onClick={() => void changeDataDir()}
                title="迁移数据目录：从本地磁盘选取一个空文件夹，数据复制后切换（原目录不删除）"
              >
                {dirBusy ? "迁移中…" : "更改位置"}
              </Button>
            </div>
            {dirNotice && (
              <p
                className={`mt-1.5 text-xs ${dirNotice.ok ? "text-emerald-500" : "text-destructive"}`}
              >
                {dirNotice.msg}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  快捷键 Tab：录制式组合键 → useSettingsStore（Zustand）→ 后端同步
 * ------------------------------------------------------------------ */
function HotkeysTab() {
  const hotkeys = useSettingsStore((s) => s.hotkeys);
  const updateSettings = useSettingsStore((s) => s.update);
  const [recording, setRecording] = useState<HotkeyId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 后端运行时注册态回显（get_global_shortcut；未上线时隐藏该行） */
  const [activeShortcut, setActiveShortcut] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { getGlobalShortcut } = await import("@/lib/bridge-ext");
        const cur = await getGlobalShortcut();
        if (alive && cur) setActiveShortcut(cur);
      } catch {
        /* 命令未上线 → 静默隐藏 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 录制：捕获态下监听 keydown（capture 阶段，抢在页面其它处理器之前）。
   * 规则：必须含至少一个修饰键（Ctrl/Alt/Shift/Super）+ 一个非修饰主键；
   * Esc 取消，修饰键单独按下时等待主键。
   * 完成后 update() 写入 Zustand 并防抖 invoke save_user_settings 同步后端。
   */
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Super");
      const key = e.key;
      if (["Control", "Alt", "Shift", "Meta"].includes(key)) return; // 等待主键
      if (parts.length === 0) {
        setNotice("组合键必须包含 Ctrl / Alt / Shift 至少一个修饰键");
        return;
      }
      const main = key.length === 1 ? key.toUpperCase() : key;
      const hotkey = [...parts, main].join("+");
      const targetId = recording;
      updateSettings({ hotkeys: { [targetId]: hotkey } });
      setRecording(null);
      setNotice(null);
      // quickTrigger 对应真实注册的全局快捷键：改完立即重注册，
      // 否则「设置里改了、按下去还是旧键」（旧版就是这么坏的）。
      if (targetId === "quickTrigger") {
        setGlobalShortcut(hotkey)
          .then(() =>
            setNotice(`全局快捷键已切换为 ${prettyHotkey(hotkey)}`),
          )
          .catch((e) =>
            setNotice(
              `快捷键已保存，但注册失败：${e instanceof Error ? e.message : String(e)}（已回滚 Ctrl+Shift+Q）`,
            ),
          );
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, updateSettings]);

  const resetHotkeys = () => {
    const patch: Partial<HotkeyConfig> = { ...DEFAULT_HOTKEYS };
    updateSettings({ hotkeys: patch });
    void setGlobalShortcut(DEFAULT_HOTKEYS.quickTrigger)
      .then(() => setNotice("已恢复默认快捷键"))
      .catch((e) =>
        setNotice(`恢复默认失败：${e instanceof Error ? e.message : String(e)}`),
      );
  };

  return (
    <div className="space-y-4">
      {notice && (
        <p className="rounded-md bg-sky-500/10 px-3 py-2 text-xs text-sky-300 animate-in fade-in slide-in-from-top-1 fill-mode-both duration-200">
          {notice}
        </p>
      )}

      {activeShortcut && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          当前后端注册生效的全局快捷键：
          <kbd className="ml-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {activeShortcut}
          </kbd>
        </p>
      )}

      <div className="rounded-lg border border-border bg-card">
        {HOTKEY_META.map(({ id, label, desc }, i) => (
          <div
            key={id}
            className={cn(
              "flex items-center justify-between gap-4 px-5 py-4",
              i > 0 && "border-t border-border/60",
            )}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
            </div>
            <HotkeyButton
              value={prettyHotkey(hotkeys[id])}
              recording={recording === id}
              onRecord={() => {
                setRecording(id);
                setNotice(null);
              }}
              onCancel={() => setRecording(null)}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[11px] leading-relaxed text-muted-foreground/60">
          录制时直接按下想要的组合键；Esc 取消。配置保存到账号的设置文件
          （settings.json），扩展端与全局注册共用这一份配置。
        </p>
        <Button variant="outline" size="sm" onClick={resetHotkeys}>
          恢复默认
        </Button>
      </div>
    </div>
  );
}

/** 快捷键展示 / 录制按钮 */
function HotkeyButton({
  value,
  recording,
  onRecord,
  onCancel,
}: {
  value: string;
  recording: boolean;
  onRecord: () => void;
  onCancel: () => void;
}) {
  if (recording) {
    return (
      <button
        type="button"
        onClick={onCancel}
        className="
          flex h-9 min-w-36 shrink-0 cursor-pointer items-center justify-center gap-2
          rounded-md border border-sky-400 bg-sky-400/10 px-4 text-sm font-medium
          text-sky-200 animate-in fade-in zoom-in-95 fill-mode-both duration-150
        "
        title="按下组合键完成录制，Esc 取消"
      >
        <Keyboard className="h-4 w-4 animate-pulse" />
        按下组合键…
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onRecord}
      className="
        flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md
        border border-border bg-muted/40 px-4 font-mono text-sm text-foreground
        transition-all duration-150 hover:border-sky-400/50 hover:bg-sky-400/5
      "
      title="点击修改快捷键"
    >
      {value}
    </button>
  );
}

/** 极简开关（无 shadcn Switch 组件，手写可达式版本） */
/* ------------------------------------------------------------------ *
 *  桥接安全卡片：Origin 白名单 / 令牌 / 限流的可视化与开关
 *
 *  威胁模型：本地桥接只监听 127.0.0.1，但浏览器里的任意网页都能向它发请求，
 *  默认靠 Origin 白名单拦截；开启令牌后，本机其它进程即使伪造 Origin 也必须
 *  知道令牌才能写入暂存区。令牌只经 Tauri IPC 展示，不走 HTTP。
 * ------------------------------------------------------------------ */
function BridgeSecurityCard() {
  const [info, setInfo] = useState<BridgeSecurityInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getBridgeSecurity()
      .then((v) => mounted && setInfo(v))
      .catch(() => mounted && setInfo(null));
    return () => {
      mounted = false;
    };
  }, []);

  const toggle = async () => {
    if (!info || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const next = await setBridgeRequireToken(!info.requireToken);
      setInfo({ ...info, requireToken: next });
      setMsg(
        next
          ? "已开启令牌校验：请把下方令牌填进扩展配置页的「桥接令牌」"
          : "已关闭令牌校验（Origin 白名单与限流仍然生效）",
      );
    } catch (e) {
      setMsg(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    if (!info || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const token = await rotateBridgeToken();
      setInfo({ ...info, token });
      setMsg("令牌已轮换：扩展需重新填入新令牌，否则写入会被拒绝");
    } catch (e) {
      setMsg(`轮换失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">本地桥接安全</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {info
                ? `127.0.0.1:${info.port} · Origin 白名单已强制 · 限流 600 次/10 秒`
                : "桥接安全信息读取失败（应用可能未就绪）"}
            </p>
          </div>
        </div>
        {info && (
          <Switch
            checked={info.requireToken}
            disabled={busy}
            onChange={() => void toggle()}
          />
        )}
      </div>

      {info && (
        <div className="mt-3 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            {info.token}
          </code>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => void copyToken()}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "已复制" : "复制"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={busy}
            onClick={() => void rotate()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            轮换
          </Button>
        </div>
      )}

      {msg && (
        <p className="mt-2 text-[11px] text-muted-foreground">{msg}</p>
      )}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200",
        "disabled:cursor-wait disabled:opacity-60",
        checked ? "bg-emerald-500" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-200",
          checked ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}
