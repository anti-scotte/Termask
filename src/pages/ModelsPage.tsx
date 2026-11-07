// src/pages/ModelsPage.tsx
// 模型设置页：Provider 列表 + 新建/编辑弹窗 + 测试连接 + 设为默认 + 删除确认
// 对齐《阶段3-工程状态交接单》目标 A 与《模块契约设计文档》组件拆分：
//   ModelPageHeader / ProviderList / ProviderCard / ProviderFormDialog / ConnectionStatusBadge

import { useCallback, useState } from "react";
import { Plus, ServerCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useModelStore } from "@/stores/useModelStore";
import type { ModelProviderConfig } from "@/types";
import { ProviderCard } from "@/components/models/ProviderCard";
import { ProviderFormDialog } from "@/components/models/ProviderFormDialog";

/* ------------------------------------------------------------------ *
 *  ModelPageHeader — 页头：标题 + 默认模型摘要 + 新建入口
 * ------------------------------------------------------------------ */
interface ModelPageHeaderProps {
  defaultProvider?: ModelProviderConfig;
  count: number;
  onCreate: () => void;
}

function ModelPageHeader({ defaultProvider, count, onCreate }: ModelPageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">模型设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          配置多个 LLM Provider（DeepSeek、Claude、本地 Ollama 等），手动切换默认模型。
          共 {count} 个配置。
        </p>
        {defaultProvider ? (
          <p className="mt-1 text-xs text-muted-foreground">
            当前默认：
            <span className="font-medium text-foreground">{defaultProvider.name}</span>
            <span className="font-mono"> · {defaultProvider.model}</span>
          </p>
        ) : (
          <p className="mt-1 text-xs text-amber-400">
            尚未设置默认模型，第一个添加的 Provider 将自动成为默认。
          </p>
        )}
      </div>
      <Button onClick={onCreate} className="shrink-0">
        <Plus className="h-4 w-4" />
        新建 Provider
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  ProviderList — 卡片列表 + 空态
 * ------------------------------------------------------------------ */
interface ProviderListProps {
  providers: ModelProviderConfig[];
  onEdit: (p: ModelProviderConfig) => void;
  onDelete: (p: ModelProviderConfig) => void;
  onSetDefault: (p: ModelProviderConfig) => void;
  onTest: (p: ModelProviderConfig) => void;
}

function ProviderList({
  providers,
  onEdit,
  onDelete,
  onSetDefault,
  onTest,
}: ProviderListProps) {
  const statuses = useModelStore((s) => s.connectionStatuses);

  if (providers.length === 0) {
    return (
      <div className="animate-in fade-in duration-500 rounded-lg border border-dashed border-border p-16 text-center">
        <ServerCog className="mx-auto h-10 w-10 text-muted-foreground/40" />
        <p className="mt-4 text-sm text-muted-foreground">
          还没有 Provider，点击「新建 Provider」添加你的第一个模型配置。
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          status={statuses[p.id]}
          onEdit={onEdit}
          onDelete={onDelete}
          onSetDefault={onSetDefault}
          onTest={onTest}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  ModelsPage — 页面组合
 * ------------------------------------------------------------------ */
export function ModelsPage() {
  const {
    providers,
    addProvider,
    updateProvider,
    removeProvider,
    setDefaultProvider,
    getDefaultProvider,
    testConnection,
  } = useModelStore();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ModelProviderConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelProviderConfig | null>(null);

  const defaultProvider = getDefaultProvider();

  /* ---------- 新建 / 编辑 ---------- */
  const openCreate = useCallback(() => {
    setEditing(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((p: ModelProviderConfig) => {
    setEditing(p);
    setFormOpen(true);
  }, []);

  const handleFormSubmit = useCallback(
    (data: Omit<ModelProviderConfig, "id">) => {
      if (editing) {
        // 保留 enabled（默认状态只在列表里通过「设为默认」切换）
        updateProvider(editing.id, { ...data, enabled: editing.enabled });
      } else {
        addProvider(data);
      }
    },
    [editing, addProvider, updateProvider],
  );

  /* ---------- 删除 ---------- */
  const handleDelete = useCallback(() => {
    if (deleteTarget) {
      removeProvider(deleteTarget.id);
      setDeleteTarget(null);
    }
  }, [deleteTarget, removeProvider]);

  /* ---------- 其他操作 ---------- */
  const handleSetDefault = useCallback(
    (p: ModelProviderConfig) => setDefaultProvider(p.id),
    [setDefaultProvider],
  );

  const handleTest = useCallback(
    (p: ModelProviderConfig) => void testConnection(p.id),
    [testConnection],
  );

  return (
    <section className="space-y-6">
      <ModelPageHeader
        defaultProvider={defaultProvider}
        count={providers.length}
        onCreate={openCreate}
      />

      <ProviderList
        providers={providers}
        onEdit={openEdit}
        onDelete={setDeleteTarget}
        onSetDefault={handleSetDefault}
        onTest={handleTest}
      />

      {/* ---------- 新建 / 编辑 Provider ---------- */}
      <ProviderFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        editing={editing}
        onSubmit={handleFormSubmit}
      />

      {/* ---------- 删除确认 ---------- */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除 Provider「{deleteTarget?.name}」吗？
              {deleteTarget?.enabled
                ? "它是当前默认模型，删除后将自动切换到列表中的下一个。"
                : "此操作不可撤销。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
