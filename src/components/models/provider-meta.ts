// src/components/models/provider-meta.ts
// Provider 协议类型元数据：卡片与表单弹窗共用

import { Bot, Cpu, Globe } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ModelProviderConfig } from "@/types";

export type ProviderKind = ModelProviderConfig["kind"];

export interface KindMeta {
  /** 展示名 */
  label: string;
  /** 类型图标 */
  icon: LucideIcon;
  /** baseUrl 字段下方的提示文案 */
  hint: string;
  /** baseUrl 占位符 */
  baseUrlPlaceholder: string;
  /** model 占位符 */
  modelPlaceholder: string;
}

export const KIND_META: Record<ProviderKind, KindMeta> = {
  "openai-compatible": {
    label: "OpenAI 兼容",
    icon: Globe,
    hint: "兼容 OpenAI 协议的服务：DeepSeek、Kimi、GLM、vLLM 等，一般填域名即可。",
    baseUrlPlaceholder: "https://api.deepseek.com",
    modelPlaceholder: "deepseek-chat",
  },
  anthropic: {
    label: "Anthropic",
    icon: Bot,
    hint: "Claude 官方 API，探测时会向 /v1/messages 发送一条最小请求。",
    baseUrlPlaceholder: "https://api.anthropic.com",
    modelPlaceholder: "claude-sonnet-4-20250514",
  },
  ollama: {
    label: "Ollama（本地）",
    icon: Cpu,
    hint: "本地推理服务，探测 /api/tags；通常无需填写 API Key。",
    baseUrlPlaceholder: "http://localhost:11434",
    modelPlaceholder: "llama3.1",
  },
};

export function kindMeta(kind: ProviderKind): KindMeta {
  return KIND_META[kind];
}

/* ------------------------------------------------------------------ *
 *  预设模型表（防呆：用户不用猜 model_id，下拉选中即填真实 ID）
 * ------------------------------------------------------------------ */

export interface ModelPreset {
  /** 下拉项 key */
  id: string;
  /** 下拉展示名 */
  label: string;
  /** 真实 model_id（API 调用参数，选中后自动填入表单 model 字段） */
  modelId: string;
  /** 所属协议类型（下拉按当前表单 kind 过滤） */
  kind: ProviderKind;
  /** 推荐端点（表单 baseUrl 为空时顺带填入） */
  baseUrl?: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  // OpenAI 兼容
  {
    id: "deepseek-chat",
    label: "DeepSeek-Chat（对话）",
    modelId: "deepseek-chat",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
  },
  {
    id: "deepseek-reasoner",
    label: "DeepSeek-Reasoner（推理）",
    modelId: "deepseek-reasoner",
    kind: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
  },
  {
    id: "kimi-8k",
    label: "Kimi（moonshot-v1-8k）",
    modelId: "moonshot-v1-8k",
    kind: "openai-compatible",
    baseUrl: "https://api.moonshot.cn",
  },
  {
    id: "glm-4-flash",
    label: "GLM-4-Flash（免费）",
    modelId: "glm-4-flash",
    kind: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn",
  },
  {
    id: "gpt-4o",
    label: "GPT-4o",
    modelId: "gpt-4o",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
  },
  // Anthropic
  {
    id: "claude-3-5-sonnet",
    label: "Claude-3.5-Sonnet",
    modelId: "claude-3-5-sonnet-20241022",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
  },
  {
    id: "claude-3-5-haiku",
    label: "Claude-3.5-Haiku",
    modelId: "claude-3-5-haiku-20241022",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
  },
  {
    id: "claude-sonnet-4",
    label: "Claude-Sonnet-4",
    modelId: "claude-sonnet-4-20250514",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
  },
  // Ollama 本地
  {
    id: "ollama-llama31",
    label: "Llama 3.1（本地）",
    modelId: "llama3.1",
    kind: "ollama",
    baseUrl: "http://localhost:11434",
  },
  {
    id: "ollama-qwen25",
    label: "Qwen 2.5（本地）",
    modelId: "qwen2.5",
    kind: "ollama",
    baseUrl: "http://localhost:11434",
  },
];

/** 按协议类型过滤预设（表单下拉用） */
export function modelPresetsFor(kind: ProviderKind): ModelPreset[] {
  return MODEL_PRESETS.filter((p) => p.kind === kind);
}
