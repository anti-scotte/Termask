// src/components/models/ProviderFormDialog.tsx
// 新建 / 编辑 Provider 弹窗表单
//
// - 「测试连接」针对表单草稿值直接调用 bridge.testModelConnection，
//   未保存也能先验证（对齐 QA 用例 T7：编辑后重新测试用新 apiKey）。
// - 防御性点击（QA P1）：独立 testing 态 + editSeq 序号——
//   请求在途时按钮持续禁用，期间改动表单会丢弃过期结果，杜绝并发重复请求。

import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Moon, PlugZap, Sparkles, Zap, Cpu } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { testModelConnection } from "@/lib/bridge";
import type { ModelProviderConfig } from "@/types";
import type { ConnectionStatus, ModelProviderFormData } from "@/stores/useModelStore";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";
import { KIND_META, modelPresetsFor, type ProviderKind } from "./provider-meta";

/* ------------------------------------------------------------------ *
 *  默认预设卡片（新建时展示：点击填充名称 / 协议类型 / Base URL，
 *  用户只需再填 API Key 和模型名）
 * ------------------------------------------------------------------ */
interface Preset {
  id: string;
  label: string;
  icon: LucideIcon;
  /** 点击后填入的表单数据（model 留空由用户填写） */
  data: { name: string; kind: ProviderKind; baseUrl: string };
  /** 推荐模型名（卡片展示 + 模型输入框 placeholder） */
  modelHint: string;
}

const PRESETS: Preset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    icon: Zap,
    data: { name: "DeepSeek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com" },
    modelHint: "deepseek-chat",
  },
  {
    id: "kimi",
    label: "Kimi",
    icon: Moon,
    data: { name: "Kimi", kind: "openai-compatible", baseUrl: "https://api.moonshot.cn" },
    modelHint: "moonshot-v1-8k",
  },
  {
    id: "glm",
    label: "GLM",
    icon: Sparkles,
    data: { name: "GLM", kind: "openai-compatible", baseUrl: "https://open.bigmodel.cn" },
    modelHint: "glm-4-flash",
  },
  {
    id: "ollama",
    label: "Ollama 本地",
    icon: Cpu,
    data: { name: "Ollama 本地", kind: "ollama", baseUrl: "http://localhost:11434" },
    modelHint: "llama3.1",
  },
];

/* ------------------------------------------------------------------ *
 *  组件
 * ------------------------------------------------------------------ */
interface ProviderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑目标（null = 新建） */
  editing: ModelProviderConfig | null;
  /** 提交（新建或保存编辑） */
  onSubmit: (data: ModelProviderFormData) => void;
}

export function ProviderFormDialog({
  open,
  onOpenChange,
  editing,
  onSubmit,
}: ProviderFormDialogProps) {
  const [form, setForm] = useState<ModelProviderFormData>({
    name: "",
    kind: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    model: "",
    enabled: false,
  });

  /** 草稿测试状态（表单内，未保存也可测） */
  const [draftStatus, setDraftStatus] = useState<ConnectionStatus>({ state: "idle" });
  /** 防连点：请求在途标志（独立于 draftStatus，不被字段编辑重置） */
  const [testing, setTesting] = useState(false);
  /** 表单编辑序号：在途请求返回时序号不一致则丢弃过期结果 */
  const editSeq = useRef(0);
  /** apiKey 可见性 */
  const [showApiKey, setShowApiKey] = useState(false);
  /** 预设推荐的模型名（作 placeholder） */
  const [modelHint, setModelHint] = useState<string | null>(null);

  const meta = KIND_META[form.kind];

  /* ---------- 打开时初始化表单 ---------- */
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name,
        kind: editing.kind,
        baseUrl: editing.baseUrl,
        apiKey: editing.apiKey ?? "",
        model: editing.model,
        enabled: editing.enabled,
      });
      setModelHint(null);
    } else {
      setForm({ name: "", kind: "openai-compatible", baseUrl: "", apiKey: "", model: "", enabled: false });
      setModelHint(null);
    }
    // 打开即视为一次编辑：丢弃之前可能在途的请求结果
    editSeq.current += 1;
    setDraftStatus({ state: "idle" });
    setShowApiKey(false);
  }, [open, editing]);

  /* ---------- 校验：name / baseUrl / model 必填 ---------- */
  const valid = useMemo(
    () => form.name.trim() !== "" && form.baseUrl.trim() !== "" && form.model.trim() !== "",
    [form],
  );

  /* ---------- 表单字段更新（任何修改都使测试结果失效） ---------- */
  const updateField = <K extends keyof ModelProviderFormData>(
    key: K,
    value: ModelProviderFormData[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    // 手动改字段后不再属于某个预设
    if (key === "baseUrl" || key === "kind") setModelHint(null);
    editSeq.current += 1;
    setDraftStatus({ state: "idle" });
  };

  const applyPreset = (preset: Preset) => {
    editSeq.current += 1;
    setForm((prev) => ({
      ...prev,
      name: preset.data.name,
      kind: preset.data.kind,
      baseUrl: preset.data.baseUrl,
      apiKey: "",
      model: "",
      enabled: false,
    }));
    setModelHint(preset.modelHint);
    setDraftStatus({ state: "idle" });
  };

  const isPresetActive = (preset: Preset) =>
    form.kind === preset.data.kind && form.baseUrl.trim() === preset.data.baseUrl;

  /* ---------- 测试连接（针对草稿值，QA P1 防连点） ---------- */
  const handleTest = async () => {
    if (!valid || testing) return; // 请求在途一律忽略
    const seq = editSeq.current;
    setTesting(true);
    setDraftStatus({ state: "testing" });
    try {
      const result = await testModelConnection({
        kind: form.kind,
        baseUrl: form.baseUrl.trim(),
        apiKey: (form.apiKey ?? "").trim(),
        model: form.model.trim(),
      });
      if (seq !== editSeq.current) return; // 在途期间表单被改，丢弃过期结果
      setDraftStatus(
        result.success
          ? { state: "success", latencyMs: result.latencyMs, modelEcho: result.modelEcho }
          : { state: "error", message: result.error ?? "未知错误" },
      );
    } catch (e) {
      if (seq !== editSeq.current) return;
      setDraftStatus({
        state: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  /* ---------- 提交 ---------- */
  const handleSubmit = () => {
    if (!valid) return;
    onSubmit({
      name: form.name.trim(),
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      apiKey: (form.apiKey ?? "").trim(),
      model: form.model.trim(),
      enabled: form.enabled,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑 Provider" : "新建 Provider"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "修改配置后保存。建议先「测试连接」再保存。"
              : "选择预设自动填充，再补上 API Key 和模型名即可。"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 默认预设卡片（仅新建时展示） */}
          {!editing && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                从预设开始（自动填充协议类型与 Base URL）：
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PRESETS.map((p) => {
                  const active = isPresetActive(p);
                  const PIcon = p.icon;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => applyPreset(p)}
                      className={cn(
                        "flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left",
                        "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md",
                        active
                          ? "border-sky-400/60 bg-sky-400/10 shadow-sm"
                          : "border-border bg-muted/30 hover:border-ring/50 hover:bg-accent",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <PIcon
                          className={cn(
                            "h-3.5 w-3.5",
                            active ? "text-sky-400" : "text-muted-foreground",
                          )}
                        />
                        <span
                          className={cn(
                            "text-xs font-medium",
                            active ? "text-sky-400" : "text-foreground",
                          )}
                        >
                          {p.label}
                        </span>
                      </span>
                      <span className="w-full truncate font-mono text-[10px] text-muted-foreground">
                        {p.data.baseUrl}
                      </span>
                      <span className="text-[10px] text-muted-foreground/70">
                        模型：{p.modelHint}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 显示名称（别名）：仅界面展示，API 调用用下方真实模型 ID */}
          <div className="space-y-2">
            <Label htmlFor="provider-name">显示名称（别名）*</Label>
            <Input
              id="provider-name"
              placeholder="如：我的小助手"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              仅用于列表展示，随便起名；实际调用 API 时使用下方「模型 ID」。
            </p>
          </div>

          {/* 协议类型 */}
          <div className="space-y-2">
            <Label>协议类型</Label>
            <Select
              value={form.kind}
              onValueChange={(v) => updateField("kind", v as ProviderKind)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_META) as ProviderKind[]).map((k) => {
                  const m = KIND_META[k];
                  return (
                    <SelectItem key={k} value={k}>
                      <span className="inline-flex items-center gap-2">
                        <m.icon className="h-3.5 w-3.5" />
                        {m.label}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Base URL */}
          <div className="space-y-2">
            <Label htmlFor="provider-baseurl">Base URL *</Label>
            <Input
              id="provider-baseurl"
              placeholder={meta.baseUrlPlaceholder}
              value={form.baseUrl}
              onChange={(e) => updateField("baseUrl", e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">{meta.hint}</p>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="provider-apikey">
              API Key{form.kind === "ollama" ? "（本地服务通常无需填写）" : " *"}
            </Label>
            <div className="relative">
              <Input
                id="provider-apikey"
                type={showApiKey ? "text" : "password"}
                placeholder="sk-…"
                value={form.apiKey}
                onChange={(e) => updateField("apiKey", e.target.value)}
                className="pr-10 font-mono text-sm"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground transition-colors hover:text-foreground"
                tabIndex={-1}
                aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* 模型 ID：预设下拉防呆 + 手动输入 */}
          <div className="space-y-2">
            <Label htmlFor="provider-model">模型 ID *</Label>
            <div className="flex gap-2">
              <Select
                value=""
                onValueChange={(v) => {
                  const preset = modelPresetsFor(form.kind).find((p) => p.id === v);
                  if (!preset) return;
                  editSeq.current += 1;
                  setDraftStatus({ state: "idle" });
                  setForm((prev) => ({
                    ...prev,
                    // 填入真实 model_id；baseUrl 为空时顺带填入推荐端点
                    model: preset.modelId,
                    baseUrl: prev.baseUrl.trim() || preset.baseUrl || prev.baseUrl,
                  }));
                }}
              >
                <SelectTrigger className="w-44 shrink-0" aria-label="预设模型">
                  <SelectValue placeholder="预设模型…" />
                </SelectTrigger>
                <SelectContent>
                  {modelPresetsFor(form.kind).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id="provider-model"
                placeholder={modelHint ?? meta.modelPlaceholder}
                value={form.model}
                onChange={(e) => updateField("model", e.target.value)}
                className="flex-1 font-mono text-sm"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              不知道怎么填？点左侧「预设模型」自动填入真实 ID；也可手动输入。
              API 调用时传的就是这个 ID，与上方别名无关。
            </p>
          </div>

          {/* 测试连接（草稿，防连点） */}
          <div className="space-y-2.5 rounded-lg border border-border bg-muted/30 p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <PlugZap className="h-4 w-4 text-muted-foreground" />
                连接测试
                <span className="text-xs font-normal text-muted-foreground">
                  （基于当前表单内容，保存前即可验证）
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={!valid || testing}
              >
                {testing ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    测试中…
                  </>
                ) : (
                  "测试连接"
                )}
              </Button>
            </div>
            {(testing || draftStatus.state !== "idle") && (
              <ConnectionStatusBadge
                status={testing ? { state: "testing" } : draftStatus}
                detailed
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!valid}>
            {editing ? "保存修改" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
