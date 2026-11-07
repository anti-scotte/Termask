import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2, FileText } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTemplateStore } from "@/stores/useTemplateStore";
import type { PromptTemplate } from "@/types";
import { DEFAULT_TEMPLATES } from "@/lib/defaultTemplates";

/* ------------------------------------------------------------------ *
 *  粒度选项
 * ------------------------------------------------------------------ */
const GRANULARITY_OPTIONS = [
  { value: "L1", label: "L1 · 词语级" },
  { value: "L2", label: "L2 · 句子级" },
  { value: "L3", label: "L3 · 段落级" },
  { value: "L4", label: "L4 · 篇章级" },
];

/* ------------------------------------------------------------------ *
 *  表单数据类型（新建 / 编辑共用）
 * ------------------------------------------------------------------ */
interface TemplateFormData {
  name: string;
  intent: string;
  promptContent: string;
  granularity: string;
  variables: string[];
}

const EMPTY_FORM: TemplateFormData = {
  name: "",
  intent: "",
  promptContent: "",
  granularity: "L1",
  variables: [],
};

/* ------------------------------------------------------------------ *
 *  TemplatesPage — 模板列表 + 新建/编辑 Dialog + 删除
 * ------------------------------------------------------------------ */
export function TemplatesPage() {
  const { templates, createTemplate, updateTemplate, deleteTemplate } = useTemplateStore();

  /** 首装 seed：库为空时注入内置默认提问模板（用户可自行删除/修改） */
  useEffect(() => {
    if (templates.length === 0) {
      DEFAULT_TEMPLATES.forEach((t) =>
        createTemplate({
          name: t.name,
          intent: t.intent,
          promptContent: t.promptContent,
          granularity: t.granularity,
          variables: t.variables,
        }),
      );
    }
    // 仅首次进入且为空时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateFormData>(EMPTY_FORM);

  /** 删除确认弹窗 */
  const [deleteTarget, setDeleteTarget] = useState<PromptTemplate | null>(null);

  // ---- 新建 ----
  const openCreate = useCallback(() => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }, []);

  // ---- 编辑 ----
  const openEdit = useCallback((tpl: PromptTemplate) => {
    setEditingId(tpl.id);
    setForm({
      name: tpl.name,
      intent: tpl.intent,
      promptContent: tpl.promptContent,
      granularity: tpl.granularity,
      variables: tpl.variables,
    });
    setDialogOpen(true);
  }, []);

  // ---- 提交（新建 or 编辑） ----
  const handleSubmit = useCallback(() => {
    if (!form.name.trim()) return;

    if (editingId) {
      updateTemplate(editingId, {
        name: form.name.trim(),
        intent: form.intent.trim(),
        promptContent: form.promptContent,
        granularity: form.granularity,
        variables: form.variables,
      });
    } else {
      createTemplate({
        name: form.name.trim(),
        intent: form.intent.trim(),
        promptContent: form.promptContent,
        granularity: form.granularity,
        variables: form.variables,
      });
    }
    setDialogOpen(false);
  }, [form, editingId, createTemplate, updateTemplate]);

  // ---- 删除 ----
  const handleDelete = useCallback(() => {
    if (deleteTarget) {
      deleteTemplate(deleteTarget.id);
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteTemplate]);

  // ---- 表单字段更新工具 ----
  const updateField = <K extends keyof TemplateFormData>(
    key: K,
    value: TemplateFormData[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  // ---- 变量槽位编辑（逗号分隔输入） ----
  const handleVariablesChange = (raw: string) => {
    const variables = raw
      .split(/[,，]/)
      .map((v) => v.trim())
      .filter(Boolean);
    updateField("variables", variables);
  };

  /* ---------- Dialog 关闭时 reset ---------- */
  useEffect(() => {
    if (!dialogOpen) {
      // 延迟 reset 避免动画期间闪烁
      const timer = setTimeout(() => {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [dialogOpen]);

  /* ---------- 渲染 ---------- */
  return (
    <section className="space-y-6">
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">提问模板管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            创建、编辑提问模板（名称、学习意图、Prompt 内容、粒度要求）。数据持久化在本地 localStorage。
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新建模板
        </Button>
      </div>

      {/* 模板列表 */}
      {templates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-16 text-center">
          <FileText className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <p className="mt-4 text-sm text-muted-foreground">还没有模板，点击「新建模板」开始创建。</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="group flex flex-col rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-medium text-foreground line-clamp-1">{tpl.name}</h3>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {tpl.granularity}
                </span>
              </div>

              <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{tpl.intent || "—"}</p>

              {tpl.promptContent && (
                <p className="mt-2 text-xs text-muted-foreground/80 line-clamp-3 font-mono bg-muted/50 rounded p-2">
                  {tpl.promptContent}
                </p>
              )}

              {tpl.variables.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {tpl.variables.map((v, i) => (
                    <span
                      key={i}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      {`{{${v}}}`}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-auto flex items-center justify-between pt-3">
                <span className="text-xs text-muted-foreground">
                  v{tpl.version} · {new Date(tpl.updatedAt).toLocaleDateString("zh-CN")}
                </span>
                <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => openEdit(tpl)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(tpl)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- 新建 / 编辑 Dialog ---------- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "编辑模板" : "新建模板"}</DialogTitle>
            <DialogDescription>
              {editingId
                ? "修改模板内容，保存后版本号自动递增。"
                : "填写模板基本信息，保存后即生效。"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* 名称 */}
            <div className="space-y-2">
              <Label htmlFor="tpl-name">名称 *</Label>
              <Input
                id="tpl-name"
                placeholder="如：概念追问 · 词语级"
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                autoFocus
              />
            </div>

            {/* 学习意图 */}
            <div className="space-y-2">
              <Label htmlFor="tpl-intent">学习意图</Label>
              <Input
                id="tpl-intent"
                placeholder="如：弄清这个词语在当前语境下的确切含义"
                value={form.intent}
                onChange={(e) => updateField("intent", e.target.value)}
              />
            </div>

            {/* Prompt 内容 */}
            <div className="space-y-2">
              <Label htmlFor="tpl-prompt">Prompt 内容</Label>
              <Textarea
                id="tpl-prompt"
                placeholder="完整提示词正文。可用 {{变量名}} 引用变量槽位，如 {{原文选段}}、{{卡点词}}。"
                className="min-h-[120px] font-mono text-sm"
                value={form.promptContent}
                onChange={(e) => updateField("promptContent", e.target.value)}
              />
            </div>

            {/* 粒度 */}
            <div className="space-y-2">
              <Label>粒度要求</Label>
              <Select
                value={form.granularity}
                onValueChange={(v) => updateField("granularity", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GRANULARITY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 变量槽位 */}
            <div className="space-y-2">
              <Label htmlFor="tpl-variables">变量槽位（逗号分隔）</Label>
              <Input
                id="tpl-variables"
                placeholder="如：原文选段, 卡点词"
                value={form.variables.join(", ")}
                onChange={(e) => handleVariablesChange(e.target.value)}
              />
              {form.variables.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {form.variables.map((v, i) => (
                    <span
                      key={i}
                      className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500"
                    >
                      {`{{${v}}}`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={!form.name.trim()}>
              {editingId ? "保存修改" : "创建模板"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- 删除确认 Dialog ---------- */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除模板「{deleteTarget?.name}」吗？此操作不可撤销。
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
