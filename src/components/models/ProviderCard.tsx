// src/components/models/ProviderCard.tsx
// Provider 卡片：悬浮上浮动效 + 默认模型高亮 + 连接状态徽章 + 操作按钮

import { Pencil, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ModelProviderConfig } from "@/types";
import type { ConnectionStatus } from "@/stores/useModelStore";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";
import { kindMeta } from "./provider-meta";

interface ProviderCardProps {
  provider: ModelProviderConfig;
  status?: ConnectionStatus;
  onEdit: (provider: ModelProviderConfig) => void;
  onDelete: (provider: ModelProviderConfig) => void;
  onSetDefault: (provider: ModelProviderConfig) => void;
  onTest: (provider: ModelProviderConfig) => void;
}

export function ProviderCard({
  provider,
  status,
  onEdit,
  onDelete,
  onSetDefault,
  onTest,
}: ProviderCardProps) {
  const meta = kindMeta(provider.kind);
  const Icon = meta.icon;
  const isDefault = provider.enabled;

  return (
    <div
      className={cn(
        // 基础卡片样式：进入列表时上滑入场 + 悬浮时整体上浮、边框呼吸发光
        "group animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both",
        "relative flex flex-col rounded-lg border bg-card p-4 text-card-foreground shadow-sm",
        "transition-[transform,box-shadow,border-color] duration-300",
        "hover:-translate-y-0.5 hover:shadow-lg",
        isDefault
          ? "border-sky-400/60 hover:border-sky-300/80 hover:shadow-sky-400/10"
          : "border-border hover:border-ring/50",
      )}
    >
      {/* 默认模型角标 */}
      {isDefault && (
        <div className="absolute -top-2.5 left-3 inline-flex items-center gap-1 rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
          <Star className="h-3 w-3 fill-current" />
          默认模型
        </div>
      )}

      {/* 头部：图标 + 名称 + kind 标签 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors",
              isDefault
                ? "border-sky-400/40 bg-sky-400/10 text-sky-400"
                : "border-border bg-muted/50 text-muted-foreground group-hover:text-foreground",
            )}
          >
            <Icon className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{provider.name}</h3>
            <span className="text-xs text-muted-foreground">{meta.label}</span>
          </div>
        </div>
        {/* 悬浮时浮现的编辑/删除操作（保持可访问性：focus-within 也显示） */}
        <div className="flex gap-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onEdit(provider)}
            aria-label="编辑"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={() => onDelete(provider)}
            aria-label="删除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 中部：baseUrl / model 元信息 */}
      <div className="mt-3 space-y-1 border-t border-border/60 pt-3 font-mono text-xs">
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-muted-foreground/70">端点</span>
          <span className="min-w-0 truncate" title={provider.baseUrl}>
            {provider.baseUrl}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-muted-foreground/70">模型 ID</span>
          <span className="min-w-0 truncate" title={`${provider.model}（API 调用实际使用）`}>
            {provider.model}
          </span>
        </div>
      </div>

      {/* 连接状态徽章 */}
      <div className="mt-3">
        <ConnectionStatusBadge status={status} />
      </div>

      {/* 底部操作条 */}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => onTest(provider)}
          disabled={status?.state === "testing"}
        >
          {status?.state === "testing" ? (
            <>
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              测试中…
            </>
          ) : (
            "测试连接"
          )}
        </Button>

        {isDefault ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-400">
            <Star className="h-3.5 w-3.5 fill-current" />
            当前默认
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onSetDefault(provider)}
          >
            <Star className="h-3.5 w-3.5" />
            设为默认
          </Button>
        )}
      </div>
    </div>
  );
}
