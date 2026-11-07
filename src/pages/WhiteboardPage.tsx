// src/pages/WhiteboardPage.tsx
// 白板页（tldraw 5.6）—— v3 多 page 白板文档
//
// 三层「新建」的定位与区别：
//   1. 左上角「新建白板」：创建一块新的白板文档（白板X）——独立的持久化单元，
//      拥有自己的页序列，可从白板下拉随时切换，可删除（软删除，后端零改动）。
//   2. 白板内「新建页」：在同一块白板文档里追加一个 page 画布——
//      每次新建/打开新画布必须先选画布类型 + 背景模板（空白/网格/康奈尔/
//      产婆术/导入模板），可选页码角标；页与页随同一份白板 JSON 持久化。
//   3. 右上角「画布」下拉：只作用于【当前页】——临时切换本页的画布类型
//      （无限/A4/适应屏幕）与背景模板，不影响其他页。
//
// 能力清单：
//   1. 多 page：页签切换 / 新建页（强制选类型+模板）/ 页码角标可选
//   2. 白板文档：新建（选首页画布）/ 删除（软删标记，load 后过滤）
//   3. 一键清屏（当前页；Ctrl+Z 可撤销）
//   4. 手写笔三笔型 + 调色盘（PalettePanel v2）
//   5. 收集区互通 / AI 批注助读（与 v2 一致）
//
// 持久化：WhiteboardProject.pages[]（v3 前端扩展）；旧数据（无 pages）自动
// 迁移为单页；后端仅原样存 JSON，零改动。软删除 deleted:true 由前端过滤。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Tldraw,
  createShapeId,
  getSnapshot,
  loadSnapshot,
  toRichText,
} from "tldraw";
import type { Editor, TLStoreSnapshot } from "tldraw";
import "tldraw/tldraw.css";
import {
  ClipboardPaste,
  Download,
  Eraser,
  FilePlus2,
  Frame,
  LayoutTemplate,
  Plus,
  RefreshCw,
  Sparkles,
  SquareStack,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  aiAnnotateWhiteboard,
  clearWhiteboardWords,
  getWhiteboardWords,
  listenWhiteboardWord,
  loadWhiteboards,
  removeWhiteboardWord,
  saveWhiteboard,
  stageWord,
} from "@/lib/bridge";
import { useModelStore } from "@/stores/useModelStore";
import type {
  StagedWord,
  WhiteboardAnnotation,
  WhiteboardCanvasType,
  WhiteboardPageData,
  WhiteboardProject,
} from "@/types";
import {
  BG_TEMPLATE_LABELS,
  buildTemplateShapes,
  shapeBgTemplate,
} from "@/components/whiteboard/backgroundTemplates";
import { PalettePanel } from "@/components/whiteboard/PalettePanel";
import { WhiteboardExportDialog } from "@/components/whiteboard/WhiteboardExportDialog";
import {
  SelectionBubble,
  getSelectionText,
  richTextToPlain,
} from "@/components/whiteboard/SelectionBubble";

/* ------------------------------------------------------------------ *
 *  常量与工具
 * ------------------------------------------------------------------ */

/** A4 页面尺寸（96dpi CSS 像素，纵向） */
const A4_W = 794;
const A4_H = 1123;

/** 自动保存防抖（毫秒）：拖拽/连续输入期间不落盘 */
const SAVE_DEBOUNCE_MS = 1200;

/** 全文上下文特殊词条（不应被插入白板） */
const FULL_CONTEXT_TERM = "__FULL_CONTEXT__";

type SaveState = "idle" | "saving" | "saved" | "error";

/** 页背景模板（WhiteboardPageData.template）：blank=空白 / grid=网格 / 其余为形状模板 */
type PageTemplate = WhiteboardPageData["template"];

/** 顶部「画布选项」下拉的取值：画布类型 + 背景模板 */
type CanvasOption = WhiteboardCanvasType | `tpl-${PageTemplate}`;

function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A4 参考框的形状 meta 标记（切换回无限画布时据此移除） */
function isA4Frame(shape: { meta?: unknown }): boolean {
  return Boolean(
    (shape.meta as Record<string, unknown> | undefined)?.a4Frame,
  );
}

/** 画布上 A4 参考框：虚线矩形，几何上标记页面边界；已存在则复用 */
function ensureA4Frame(editor: Editor) {
  const existing = editor
    .getCurrentPageShapes()
    .find((s) => isA4Frame(s));
  if (existing) return;
  const vp = editor.getViewportScreenBounds();
  const center = editor.screenToPage({ x: vp.center.x, y: vp.center.y });
  editor.createShape({
    id: createShapeId(),
    type: "geo",
    x: center.x - A4_W / 2,
    y: center.y - A4_H / 2,
    props: {
      w: A4_W,
      h: A4_H,
      geo: "rectangle",
      dash: "dashed",
      fill: "none",
    },
    meta: { a4Frame: true },
  });
}

/** 移除 A4 参考框（固定 → 无限 切换时调用，页面内元素坐标保留） */
function removeA4Frame(editor: Editor) {
  const frames = editor
    .getCurrentPageShapes()
    .filter((s) => isA4Frame(s))
    .map((s) => s.id);
  if (frames.length > 0) {
    editor.deleteShapes(frames);
  }
}

/** 读取白板文档的页序列（旧数据：无 pages → 视为单页） */
function getPages(p: WhiteboardProject): WhiteboardPageData[] {
  if (p.pages && p.pages.length > 0) return p.pages;
  return [
    {
      id: `${p.id}-p1`,
      canvasType: p.canvasType,
      template: "blank",
      elements: p.elements,
      showPageBadge: false,
      pageIndex: 0,
    },
  ];
}

const PAGE_TEMPLATE_LABELS: Record<PageTemplate, string> = {
  blank: "空白",
  grid: "网格",
  cornell: BG_TEMPLATE_LABELS.cornell,
  socratic: BG_TEMPLATE_LABELS.socratic,
};

/* ------------------------------------------------------------------ *
 *  新建页对话框：画布类型 + 背景模板 + 页码角标 + 导入模板
 * ------------------------------------------------------------------ */
interface NewPageSettings {
  canvasType: WhiteboardCanvasType;
  template: PageTemplate;
  showPageBadge: boolean;
  /** 导入模板：从某块白板的某一页复制内容作为起点 */
  importFrom: { boardId: string; pageId: string } | null;
}

function NewPageDialog({
  open,
  boards,
  onClose,
  onConfirm,
}: {
  open: boolean;
  boards: WhiteboardProject[];
  onClose: () => void;
  onConfirm: (s: NewPageSettings) => void;
}) {
  const [canvasType, setCanvasType] = useState<WhiteboardCanvasType>("infinite");
  const [template, setTemplate] = useState<PageTemplate>("blank");
  const [showPageBadge, setShowPageBadge] = useState(true);
  const [importFrom, setImportFrom] = useState<string>("none");

  useEffect(() => {
    if (open) {
      setCanvasType("infinite");
      setTemplate("blank");
      setShowPageBadge(true);
      setImportFrom("none");
    }
  }, [open]);

  const submit = () => {
    let importFromValue: NewPageSettings["importFrom"] = null;
    if (template === "grid" || importFrom !== "none") {
      if (importFrom !== "none") {
        const [boardId, pageId] = importFrom.split("::");
        importFromValue = { boardId, pageId };
      }
    }
    // 选了导入模板 → 覆盖模板类型为来源页的模板（内容连同背景一起复制）
    if (importFromValue) {
      const src = boards
        .find((b) => b.id === importFromValue?.boardId)
        ?.pages?.find?.(
          (pg) => pg.id === importFromValue?.pageId,
        );
      if (src) {
        onConfirm({
          canvasType: src.canvasType,
          template: src.template,
          showPageBadge,
          importFrom: importFromValue,
        });
        onClose();
        return;
      }
    }
    onConfirm({ canvasType, template, showPageBadge, importFrom: null });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建页 · 选择画布</DialogTitle>
          <DialogDescription>
            每块新画布都需要先确定画布类型与背景模板，之后可随时在右上角调整。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* 画布类型 */}
          <div className="space-y-1.5">
            <Label>画布类型</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { v: "infinite", label: "无限画布" },
                  { v: "a4", label: "A4 页面" },
                  { v: "screen", label: "适应屏幕" },
                ] as const
              ).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setCanvasType(o.v)}
                  className={`cursor-pointer rounded-md border px-2 py-1.5 text-xs transition-colors ${
                    canvasType === o.v
                      ? "border-sky-400/60 bg-sky-400/10 font-medium text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/40"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* 背景模板 */}
          <div className="space-y-1.5">
            <Label>背景模板</Label>
            <div className="grid grid-cols-5 gap-1.5">
              {(["blank", "grid", "cornell", "socratic"] as PageTemplate[]).map(
                (t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTemplate(t)}
                    className={`cursor-pointer rounded-md border px-1 py-1.5 text-[11px] transition-colors ${
                      template === t
                        ? "border-violet-400/60 bg-violet-400/10 font-medium text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent/40"
                    }`}
                  >
                    {PAGE_TEMPLATE_LABELS[t]}
                  </button>
                ),
              )}
              <button
                type="button"
                onClick={() => setTemplate("blank")}
                className={`cursor-pointer rounded-md border border-dashed px-1 py-1.5 text-[11px] transition-colors ${
                  importFrom !== "none"
                    ? "border-emerald-400/70 bg-emerald-400/10 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent/40"
                }`}
                title="从已有页面复制内容作为起点"
              >
                导入模板
              </button>
            </div>
            {/* 导入来源（选了导入模板后展开） */}
            <Select
              value={importFrom}
              onValueChange={(v) => {
                setImportFrom(v);
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="选择要导入的页面" />
              </SelectTrigger>
              <SelectContent className="z-[1000]">
                <SelectItem value="none">— 不导入，从空白开始 —</SelectItem>
                {boards.map((b) =>
                  getPages(b).map((pg) => (
                    <SelectItem
                      key={`${b.id}::${pg.id}`}
                      value={`${b.id}::${pg.id}`}
                    >
                      {b.title} · 第 {pg.pageIndex + 1} 页
                    </SelectItem>
                  )),
                )}
              </SelectContent>
            </Select>
          </div>

          {/* 页码角标 */}
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2">
            <input
              type="checkbox"
              checked={showPageBadge}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setShowPageBadge(e.target.checked)
              }
              className="h-4 w-4 cursor-pointer accent-violet-500"
            />
            <span className="text-sm text-foreground">
              显示页码角标
              <span className="ml-1 text-xs text-muted-foreground">
                （画布左上角浮标「第 N 页」）
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit}>创建页面</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 *  WhiteboardPage 主组件
 * ------------------------------------------------------------------ */
export function WhiteboardPage() {
  /* ---- 白板列表 / 当前白板 / 当前页 ---- */
  const [boards, setBoards] = useState<WhiteboardProject[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [pageDialogOpen, setPageDialogOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [hasPaperFrame, setHasPaperFrame] = useState(false);
  /** 当前页元信息（页码角标渲染的权威来源，applyPage/toggle 时同步，防 boards 派生时序问题） */
  const [pageMeta, setPageMeta] = useState<{ pageIndex: number; showPageBadge: boolean } | null>(null);
  /** 删除白板的两击确认 */
  const [pendingDeleteBoard, setPendingDeleteBoard] = useState(false);
  /** 顶部下拉的显示值（画布类型 或 tpl-xxx）；画布类型权威值在 typeRef */
  const [canvasOption, setCanvasOption] = useState<CanvasOption>("infinite");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  /* ---- tldraw 编辑器实例（state 驱动子组件挂载） ---- */
  const [editor, setEditor] = useState<Editor | null>(null);

  /* ---- 收集区（白板收集区 target="whiteboard"） ---- */
  const [words, setWords] = useState<StagedWord[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  /* ---- AI 助读面板 ---- */
  const [ai, setAi] = useState<{
    open: boolean;
    loading: boolean;
    error: string | null;
    result: WhiteboardAnnotation | null;
    content: string;
  }>({ open: false, loading: false, error: null, result: null, content: "" });

  const [toast, setToast] = useState<string | null>(null);

  /* ---- refs（跨回调持有，不触发渲染） ---- */
  const editorRef = useRef<Editor | null>(null);
  const currentRef = useRef<WhiteboardProject | null>(null);
  const currentPageIdRef = useRef<string | null>(null);
  const typeRef = useRef<WhiteboardCanvasType>("infinite");
  /** loadSnapshot 期间屏蔽自动保存（快照写入会被 store.listen 捕获） */
  const loadingRef = useRef(false);
  const saveTimerRef = useRef<number | undefined>(undefined);
  const toastTimerRef = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  /** 当前页（派生） */
  const currentPage = currentId
    ? (() => {
        const b = boards.find((x) => x.id === currentId);
        return b ? getPages(b).find((pg) => pg.id === currentPageId) : null;
      })()
    : null;

  /* ---------- 持久化 ---------- */

  /** 本地更新当前白板文档（boards + ref 同步） */
  const updateCurrentProject = useCallback(
    (mut: (p: WhiteboardProject) => WhiteboardProject) => {
      const p = currentRef.current;
      if (!p) return null;
      const next = { ...mut(p), updatedAt: Date.now() };
      currentRef.current = next;
      setBoards((prev) => prev.map((b) => (b.id === next.id ? next : b)));
      return next;
    },
    [],
  );

  /** 立即落盘（防抖到期 / 切换白板或页 / 卸载前调用）：当前页快照写回 pages */
  const persistNow = useCallback(async (): Promise<boolean> => {
    const ed = editorRef.current;
    const project = currentRef.current;
    if (!ed || !project) return false;
    try {
      setSaveState("saving");
      const snap = getSnapshot(ed.store);
      const pages = getPages(project).map((pg) =>
        pg.id === currentPageIdRef.current
          ? {
              ...pg,
              elements: snap,
              canvasType: typeRef.current,
            }
          : pg,
      );
      await saveWhiteboard({
        ...project,
        pages,
        // 旧结构镜像：第一页快照 + 类型（兼容旧读取方/降级回退）
        elements: pages[0]?.elements ?? null,
        canvasType: (pages[0]?.canvasType ?? typeRef.current) as WhiteboardCanvasType,
        updatedAt: Date.now(),
      });
      setSaveState("saved");
      return true;
    } catch (e) {
      console.error("[Whiteboard] 自动保存失败:", e);
      setSaveState("error");
      return false;
    }
  }, []);

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void persistNow();
    }, SAVE_DEBOUNCE_MS);
  }, [persistNow]);

  /* ---------- 页装载 ---------- */

  /** 把一页应用为「当前页」（编辑器未就绪时仅记录，handleMount 会补一次） */
  const applyPage = useCallback(
    (page: WhiteboardPageData) => {
      currentPageIdRef.current = page.id;
      setCurrentPageId(page.id);
      typeRef.current = page.canvasType;
      setCanvasOption(page.canvasType);
      setPageMeta({ pageIndex: page.pageIndex, showPageBadge: page.showPageBadge });

      const ed = editorRef.current;
      if (!ed) return; // 首次挂载路径：handleMount 里会再恢复一次
      loadingRef.current = true;
      try {
        if (page.elements) {
          loadSnapshot(ed.store, page.elements as TLStoreSnapshot);
        } else {
          ed.deleteShapes([...ed.getCurrentPageShapeIds()]);
        }
        // 背景模板：网格 → tldraw 原生网格模式；形状模板已在快照内
        // （新建空页时下方补建），切走时关闭网格
        ed.updateInstanceState({ isGridMode: page.template === "grid" });
        // 空页 + 形状模板（康奈尔/产婆术）→ 以视口中心补建背景形状
        if (
          !page.elements &&
          (page.template === "cornell" || page.template === "socratic")
        ) {
          const vp = ed.getViewportScreenBounds();
          const center = ed.screenToPage({ x: vp.center.x, y: vp.center.y });
          const specs = buildTemplateShapes(page.template, center.x, center.y);
          if (specs.length > 0) {
            ed.createShapes(
              specs as unknown as Parameters<Editor["createShapes"]>[0],
            );
            ed.sendToBack(specs.map((s) => s.id));
          }
        }
        if (page.canvasType === "a4") ensureA4Frame(ed);
        if (page.canvasType !== "infinite") ed.zoomToFit();
      } catch (e) {
        console.error("[Whiteboard] 恢复页面快照失败:", e);
        showToast("页面数据恢复失败（可能由其他 tldraw 版本写入）");
      } finally {
        window.setTimeout(() => {
          loadingRef.current = false;
        }, 300);
      }
    },
    [showToast],
  );

  /** 把一份白板项目应用为「当前」（装载其第一页） */
  const applyProject = useCallback(
    (p: WhiteboardProject) => {
      currentRef.current = p;
      setCurrentId(p.id);
      const pages = getPages(p);
      if (pages.length > 0) {
        applyPage(pages[0]);
      } else {
        // 空 pages（刚建、待弹窗选择）→ 清空画布
        currentPageIdRef.current = null;
        setCurrentPageId(null);
        const ed = editorRef.current;
        if (ed) {
          loadingRef.current = true;
          ed.deleteShapes([...ed.getCurrentPageShapeIds()]);
          window.setTimeout(() => {
            loadingRef.current = false;
          }, 300);
        }
      }
    },
    [applyPage],
  );

  /** 编辑器挂载：恢复当前页快照 + 挂文档变更监听（自动保存） */
  const handleMount = useCallback(
    (ed: Editor) => {
      editorRef.current = ed;
      setEditor(ed);
      const project = currentRef.current;
      const pageId = currentPageIdRef.current;
      if (project && pageId) {
        const page = getPages(project).find((pg) => pg.id === pageId);
        if (page) applyPage(page);
      }
      // 文档级变更（用户增删改形状）→ 防抖自动保存；
      // 快照恢复期间（loadingRef）的写入不触发
      ed.store.listen(
        (entry) => {
          if (loadingRef.current) return;
          if (entry.source === "user") scheduleSave();
        },
        { scope: "document" },
      );
    },
    [applyPage, scheduleSave],
  );

  /* ---------- 白板文档（新建 / 删除 / 切换） ---------- */

  /** 新建白板：弹出「新建页」对话框（首页也必须选类型+模板） */
  const handleCreateBoard = useCallback(() => {
    setPageDialogOpen(true);
  }, []);

  /** 对话框确认：首建白板 或 追加页 都走这里 */
  const handleConfirmNewPage = useCallback(
    async (s: NewPageSettings) => {
      await persistNow();

      // 解析导入模板：从源页深拷贝快照（tldraw 快照为纯 JSON）
      let elements: unknown = null;
      if (s.importFrom) {
        const srcBoard = boards.find((b) => b.id === s.importFrom?.boardId);
        const srcPage = srcBoard
          ? getPages(srcBoard).find((pg) => pg.id === s.importFrom?.pageId)
          : null;
        if (srcPage?.elements) {
          try {
            elements = JSON.parse(JSON.stringify(srcPage.elements));
          } catch {
            elements = null;
          }
        }
      }

      let project = currentRef.current;
      const isFirstPageOfNewBoard = !project;

      if (isFirstPageOfNewBoard) {
        // 新白板文档：第 1 页即本次选择的画布
        const now = Date.now();
        const page: WhiteboardPageData = {
          id: genId(),
          canvasType: s.canvasType,
          template: s.template,
          elements,
          showPageBadge: s.showPageBadge,
          pageIndex: 0,
        };
        const newBoard: WhiteboardProject = {
          id: genId(),
          title: `白板 ${boards.filter((b) => !b.deleted).length + 1}`,
          canvasType: s.canvasType,
          elements,
          pages: [page],
          annotations: [],
          createdAt: now,
          updatedAt: now,
        };
        setBoards((prev) => [newBoard, ...prev]);
        currentRef.current = newBoard;
        setCurrentId(newBoard.id);
        applyPage(page);
        showToast(`已新建白板：${newBoard.title}（第 1 页）`);
        return;
      }

      // 追加页到当前白板
      if (!project) return;
      const page: WhiteboardPageData = {
        id: genId(),
        canvasType: s.canvasType,
        template: s.template,
        elements,
        showPageBadge: s.showPageBadge,
        pageIndex: getPages(project).length,
      };
      const next = updateCurrentProject((p) => ({
        ...p,
        pages: [...getPages(p), page],
      }));
      if (next) applyPage(page);
      showToast(
        `已新建第 ${page.pageIndex + 1} 页（${PAGE_TEMPLATE_LABELS[page.template]}）`,
      );
    },
    [boards, persistNow, applyPage, updateCurrentProject, showToast],
  );

  /** 删除当前白板：两击确认（软删除标记，后端 load 后由前端过滤） */
  const handleDeleteBoard = useCallback(async () => {
    const project = currentRef.current;
    if (!project) return;
    if (!pendingDeleteBoard) {
      setPendingDeleteBoard(true);
      window.setTimeout(() => setPendingDeleteBoard(false), 3000);
      return;
    }
    setPendingDeleteBoard(false);
    try {
      // 软删除：写入 deleted 标记（saveWhiteboard 为按 id 覆盖写）
      await saveWhiteboard({
        ...project,
        deleted: true,
        updatedAt: Date.now(),
      });
    } catch (e) {
      console.error("[Whiteboard] 删除白板失败:", e);
      showToast("删除失败");
      return;
    }
    const rest = boards.filter((b) => b.id !== project.id && !b.deleted);
    setBoards(rest);
    if (rest.length > 0) {
      applyProject(rest[0]);
    } else {
      currentRef.current = null;
      setCurrentId(null);
      currentPageIdRef.current = null;
      setCurrentPageId(null);
      const ed = editorRef.current;
      if (ed) {
        loadingRef.current = true;
        ed.deleteShapes([...ed.getCurrentPageShapeIds()]);
        window.setTimeout(() => {
          loadingRef.current = false;
        }, 300);
      }
      showToast("白板已删除，点击「新建白板」开始新的一块");
    }
  }, [boards, pendingDeleteBoard, applyProject, showToast]);

  /** 切换白板：先冲刷当前，再装载目标 */
  const handleSwitchBoard = useCallback(
    async (id: string) => {
      if (id === currentRef.current?.id) return;
      await persistNow();
      const target = boards.find((b) => b.id === id);
      if (!target) return;
      applyProject(target);
    },
    [boards, persistNow, applyProject],
  );

  /** 切换页：先冲刷当前页，再装载目标页 */
  const handleSwitchPage = useCallback(
    async (pageId: string) => {
      if (pageId === currentPageIdRef.current) return;
      const project = currentRef.current;
      if (!project) return;
      await persistNow();
      const page = getPages(project).find((pg) => pg.id === pageId);
      if (page) applyPage(page);
    },
    [persistNow, applyPage],
  );

  /** 一键清屏（当前页）：删除全部形状；Ctrl+Z 可撤销 */
  const handleClearCanvas = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const ids = [...ed.getCurrentPageShapeIds()];
    if (ids.length === 0) {
      showToast("当前页已是空白");
      return;
    }
    ed.deleteShapes(ids);
    scheduleSave();
    showToast(`已清屏（移除 ${ids.length} 个形状，Ctrl+Z 可撤销）`);
  }, [scheduleSave, showToast]);

  /** 纸张边框：锁定虚线框（meta.paperFrame），导出按其 bounds 裁剪；再点删除 */
  const togglePaperFrame = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const shapes = ed.getCurrentPageShapes();
    const frame = shapes.find(
      (sh) => (sh.meta as Record<string, unknown> | undefined)?.paperFrame,
    );
    if (frame) {
      ed.deleteShapes([frame.id]);
      setHasPaperFrame(false);
      scheduleSave();
      showToast("已移除纸张边框");
      return;
    }
    const ids = shapes.map((sh) => sh.id);
    const all = ids.length > 0 ? ed.getShapesPageBounds(ids) : null;
    const b = all
      ? { x: all.x - 80, y: all.y - 80, w: all.w + 160, h: all.h + 160 }
      : { x: -400, y: -300, w: 800, h: 600 };
    ed.createShape({
      id: createShapeId(),
      type: "geo",
      x: b.x,
      y: b.y,
      props: {
        w: b.w,
        h: b.h,
        geo: "rectangle",
        dash: "dashed",
        fill: "none",
        color: "light-blue",
      },
      meta: { paperFrame: true },
      isLocked: true,
    });
    setHasPaperFrame(true);
    scheduleSave();
    showToast("已加入纸张边框：导出将按边框裁剪（可先解锁拖动调整）");
  }, [scheduleSave, showToast]);

  /** 首次进入：loadWhiteboards（过滤软删）→ 取最近一块；空库弹新建对话框 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = (await loadWhiteboards()).filter((b) => !b.deleted);
        if (!alive) return;
        if (list.length > 0) {
          setBoards(list);
          applyProject(list[0]); // 后端按 updatedAt 倒序，取最近编辑
        } else {
          setPageDialogOpen(true); // 空库 → 弹「新建页」向导
        }
      } catch (e) {
        console.error("[Whiteboard] 读取白板列表失败:", e);
        if (alive) {
          showToast("读取白板列表失败，请点「新建白板」开始");
          setPageDialogOpen(true);
        }
      }
    })();
    return () => {
      alive = false;
      // 卸载冲刷：页面切走前把画布状态落盘
      void persistNow();
    };
    // 仅挂载时执行一次；persistNow/applyProject 均为稳定或低频依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 当前页的画布类型 / 背景模板（右上角下拉） ---------- */

  const handleCanvasTypeChange = useCallback(
    (t: WhiteboardCanvasType) => {
      typeRef.current = t;
      setCanvasOption(t);
      const ed = editorRef.current;
      if (!ed) return;
      if (t === "a4") {
        ensureA4Frame(ed);
        ed.zoomToFit();
      } else if (t === "screen") {
        ed.zoomToFit();
      } else {
        removeA4Frame(ed);
        ed.resetZoom();
      }
      // 当前页记录 + 白板镜像同步
      const pageId = currentPageIdRef.current;
      if (pageId) {
        updateCurrentProject((p) => ({
          ...p,
          canvasType: t,
          pages: getPages(p).map((pg) =>
            pg.id === pageId ? { ...pg, canvasType: t } : pg,
          ),
        }));
      }
      scheduleSave();
    },
    [scheduleSave, updateCurrentProject],
  );

  /** 应用背景模板：清旧（meta.bgTemplate）→ 以视口中心重建 → 压到最底层 */
  const handleApplyTemplate = useCallback(
    (tpl: PageTemplate) => {
      const ed = editorRef.current;
      if (!ed) return;

      // 网格：原生网格模式，无需形状
      ed.updateInstanceState({ isGridMode: tpl === "grid" });

      // 形状模板：清旧 → 重建
      const olds = ed
        .getCurrentPageShapes()
        .filter((s) => shapeBgTemplate(s.meta) !== null)
        .map((s) => s.id);
      if (olds.length > 0) ed.deleteShapes(olds);

      if (tpl === "cornell" || tpl === "socratic") {
        const vp = ed.getViewportScreenBounds();
        const center = ed.screenToPage({ x: vp.center.x, y: vp.center.y });
        const specs = buildTemplateShapes(tpl, center.x, center.y);
        if (specs.length > 0) {
          ed.createShapes(
            specs as unknown as Parameters<Editor["createShapes"]>[0],
          );
          ed.sendToBack(specs.map((s) => s.id));
          ed.zoomToFit();
        }
      }
      setCanvasOption(`tpl-${tpl}`);
      // 当前页记录模板
      const pageId = currentPageIdRef.current;
      if (pageId) {
        updateCurrentProject((p) => ({
          ...p,
          pages: getPages(p).map((pg) =>
            pg.id === pageId ? { ...pg, template: tpl } : pg,
          ),
        }));
      }
      scheduleSave();
      showToast(
        tpl === "blank"
          ? "已切换为空白背景"
          : tpl === "grid"
            ? "已切换为网格背景"
            : `已应用「${BG_TEMPLATE_LABELS[tpl]}」模板`,
      );
    },
    [scheduleSave, showToast, updateCurrentProject],
  );

  /** 顶部下拉统一入口 */
  const handleCanvasOptionChange = useCallback(
    (v: string) => {
      if (v.startsWith("tpl-")) {
        handleApplyTemplate(v.slice(4) as PageTemplate);
        return;
      }
      handleCanvasTypeChange(v as WhiteboardCanvasType);
    },
    [handleApplyTemplate, handleCanvasTypeChange],
  );

  /** 页码角标开关（当前页） */
  const handleTogglePageBadge = useCallback(
    (on: boolean) => {
      const pageId = currentPageIdRef.current;
      if (!pageId) return;
      updateCurrentProject((p) => ({
        ...p,
        pages: getPages(p).map((pg) =>
          pg.id === pageId ? { ...pg, showPageBadge: on } : pg,
        ),
      }));
      setPageMeta((m) => (m ? { ...m, showPageBadge: on } : m));
      scheduleSave();
    },
    [updateCurrentProject, scheduleSave],
  );

  /* ---------- 收集区（单一数据源：白板收集区 target="whiteboard"） ---------- */

  const refreshWords = useCallback(async () => {
    try {
      setWords(await getWhiteboardWords());
    } catch (e) {
      console.error("[Whiteboard] 读取白板收集区失败:", e);
    }
  }, []);

  useEffect(() => {
    void refreshWords();
    // Tauri listen 返回 Promise<UnlistenFn>，注销须等 Promise 兑现
    const offs: Array<Promise<() => void>> = [
      listenWhiteboardWord((w) => setWords((prev) => [...prev, w])),
    ];
    return () => {
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, [refreshWords]);

  /** 打开抽屉时对账刷新（插件可能在白板页关闭期间推词） */
  const handleToggleDrawer = useCallback(
    (open: boolean) => {
      setDrawerOpen(open);
      if (open) void refreshWords();
    },
    [refreshWords],
  );

  /** 常规插入：视口中心新建文本形状 */
  const insertAtViewportCenter = useCallback(
    (term: string) => {
      const ed = editorRef.current;
      if (!ed) return;
      const vp = ed.getViewportScreenBounds();
      const pt = ed.screenToPage({ x: vp.center.x, y: vp.center.y });
      ed.createShape({
        id: createShapeId(),
        type: "text",
        x: pt.x - 60,
        y: pt.y - 14,
        props: { richText: toRichText(term), autoSize: true },
      });
      scheduleSave();
      showToast(`已插入「${term.slice(0, 12)}${term.length > 12 ? "…" : ""}」`);
    },
    [scheduleSave, showToast],
  );

  /**
   * 词条 → 画布（点击 chip 入口）：
   *   路径 1：正在编辑文本形状（光标闪烁）→ 光标处插入文字，不新建形状。
   *   路径 2：常规 → 视口中心新建文本形状。
   */
  const handleWordClick = useCallback(
    (term: string) => {
      if (!term || term === FULL_CONTEXT_TERM) return;
      const ed = editorRef.current;
      if (!ed) return;

      const editingId = ed.getEditingShapeId();
      if (editingId) {
        const sel = window.getSelection();
        const anchor = sel?.anchorNode ?? null;
        const el =
          anchor && anchor.nodeType === Node.TEXT_NODE
            ? anchor.parentElement
            : (anchor as HTMLElement | null);
        // 选区必须仍停留在 tldraw 的富文本编辑 DOM 内
        if (el && el.closest(".tl-rich-text, .tl-text-content, .ProseMirror")) {
          const ok = document.execCommand("insertText", false, term);
          if (ok) {
            scheduleSave();
            showToast(
              `已插入到光标处「${term.slice(0, 12)}${term.length > 12 ? "…" : ""}」`,
            );
            return;
          }
        }
      }
      insertAtViewportCenter(term);
    },
    [insertAtViewportCenter, scheduleSave, showToast],
  );

  /** 白板收集区词条删除（chip X） */
  const handleRemoveWord = useCallback(
    async (term: string) => {
      try {
        setWords(await removeWhiteboardWord(term)); // 后端返回删除后的权威列表
      } catch (e) {
        console.error("[Whiteboard] 删除词条失败:", e);
        showToast("删除失败");
      }
    },
    [showToast],
  );

  /** 清空白板收集区 */
  const handleClearWords = useCallback(async () => {
    try {
      setWords(await clearWhiteboardWords());
      showToast("收集区已清空");
    } catch (e) {
      console.error("[Whiteboard] 清空收集区失败:", e);
      showToast("清空失败");
    }
  }, [showToast]);

  /** 选中文本形状 → 加入白板收集区（stage_word target=whiteboard） */
  const handleSelectionToCollection = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    const text = getSelectionText(ed);
    if (!text) {
      showToast("选中的形状没有可收集的文字");
      return;
    }
    try {
      await stageWord({ term: text.slice(0, 120), target: "whiteboard" });
      showToast("已加入收集区");
    } catch (e) {
      console.error("[Whiteboard] 加入收集区失败:", e);
      showToast("加入收集区失败");
    }
  }, [showToast]);

  /* ---------- AI 助读 ---------- */

  /** 选区内容 → ai_annotate_whiteboard → 左侧面板 */
  const handleAsk = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) {
        showToast("请先选中包含文字的形状");
        return;
      }
      const provider = useModelStore.getState().getDefaultProvider();
      if (!provider) {
        showToast("请先在「模型设置」中配置并设为默认模型");
        return;
      }
      // 白板上下文：画布上全部文本聚合（截 4000 字，后端亦会截断）
      const ed = editorRef.current;
      const context = ed
        ? ed
            .getCurrentPageShapes()
            .map((s) => {
              const props = (s.props ?? {}) as { richText?: unknown };
              return richTextToPlain(props.richText);
            })
            .filter(Boolean)
            .join("\n")
            .slice(0, 4000)
        : "";
      setAi({
        open: true,
        loading: true,
        error: null,
        result: null,
        content: trimmed,
      });
      try {
        const result = await aiAnnotateWhiteboard(trimmed, context, {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey ?? "",
          model: provider.model,
        });
        setAi((prev) => ({ ...prev, loading: false, result }));
      } catch (e) {
        console.error("[Whiteboard] AI 助读失败:", e);
        setAi((prev) => ({ ...prev, loading: false, error: String(e) }));
      }
    },
    [showToast],
  );

  /** 选中形状 → 直接问 AI（悬浮球入口） */
  const handleAskSelection = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    void handleAsk(getSelectionText(ed));
  }, [handleAsk]);

  /** AI 关键词 → 收集区 */
  const handleKeywordToCollection = useCallback(
    async (kw: string) => {
      try {
        await stageWord({ term: kw, target: "whiteboard" });
        showToast(`已把「${kw}」加入收集区`);
      } catch (e) {
        console.error("[Whiteboard] 关键词入收集区失败:", e);
        showToast("加入失败");
      }
    },
    [showToast],
  );

  /** AI 批注正文 → 贴到画布视口中心（文本形状，可继续拖拽编辑） */
  const pinAnnotationToCanvas = useCallback(() => {
    const ed = editorRef.current || null;
    if (!ed || !ai.result?.annotation) return;
    const vp = ed.getViewportScreenBounds();
    const pt = ed.screenToPage({ x: vp.center.x, y: vp.center.y });
    ed.createShape({
      id: createShapeId(),
      type: "text",
      x: pt.x - 140,
      y: pt.y - 60,
      props: { richText: toRichText(ai.result.annotation), autoSize: true },
    });
    scheduleSave();
    showToast("批注已贴到画布");
  }, [ai.result, scheduleSave, showToast]);

  /* ---------- 渲染 ---------- */

  const totalWords = words.length;
  const currentBoardPages = currentId
    ? (() => {
        const b = boards.find((x) => x.id === currentId);
        return b ? getPages(b) : [];
      })()
    : [];

  /** 收集区 chip 公共交互：mousedown 阻止抢焦点（保住编辑态光标）+ 拖拽数据 */
  const chipDragProps = (term: string) => ({
    draggable: true,
    onMouseDown: (e: React.MouseEvent) => {
      // 关键：阻止 chip 抢走画布编辑器的焦点，否则正在编辑的
      // contenteditable 会 blur → 编辑态消失 → 光标插入退化成新建形状
      e.preventDefault();
    },
    onDragStart: (e: React.DragEvent) => {
      // 交给 tldraw 原生 text/plain 流程：
      // 放到画布上会自动生成文本形状（落点即指针处）
      e.dataTransfer.setData("text/plain", term);
      e.dataTransfer.effectAllowed = "copy";
    },
    onClick: () => handleWordClick(term),
  });

  return (
    <section className="flex h-full flex-col gap-4">
      {/* 顶栏：白板文档层（左上）｜保存状态｜当前页画布选项（右上）｜收集区 */}
      <header className="relative z-20 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <SquareStack size={18} className="text-muted-foreground" />
          <h1 className="text-lg font-semibold">白板</h1>
        </div>

        <Select
          value={currentId ?? ""}
          onValueChange={(v) => void handleSwitchBoard(v)}
        >
          <SelectTrigger className="w-44" title="白板文档：一块白板可含多个页">
            <SelectValue placeholder="选择白板" />
          </SelectTrigger>
          <SelectContent className="z-[1000]">
            {boards
              .filter((b) => !b.deleted)
              .map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.title}（{getPages(b).length} 页）
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        {/* 左上角：新建白板（新文档，首页画布需选择类型与模板） */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleCreateBoard}
          title="新建白板文档（创建后需为第 1 页选择画布类型与模板）"
        >
          <Plus className="h-4 w-4" />
          新建白板
        </Button>

        {/* 删除当前白板：两击确认（软删除） */}
        <Button
          variant="ghost"
          size="sm"
          className={
            pendingDeleteBoard
              ? "bg-red-500/15 text-destructive"
              : "text-muted-foreground hover:text-destructive"
          }
          onClick={() => void handleDeleteBoard()}
          title={
            pendingDeleteBoard
              ? "再点一次确认删除（软删除，可恢复数据文件）"
              : "删除当前白板"
          }
        >
          <Trash2 className="h-4 w-4" />
          {pendingDeleteBoard ? "确认删除？" : "删除"}
        </Button>

        <span
          className={
            "text-xs " +
            (saveState === "error"
              ? "text-destructive"
              : saveState === "saving"
                ? "text-amber-500"
                : "text-muted-foreground")
          }
        >
          {saveState === "saving"
            ? "保存中…"
            : saveState === "saved"
              ? "已自动保存"
              : saveState === "error"
                ? "保存失败"
                : "就绪"}
        </span>

        <div className="flex-1" />

        {/* 右上角：当前页的画布类型 + 背景模板 */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LayoutTemplate size={14} />
          <span>当前页画布</span>
        </div>
        <Select value={canvasOption} onValueChange={handleCanvasOptionChange}>
          <SelectTrigger className="w-40" title="仅作用于当前页">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[1000]">
            <SelectGroup>
              <SelectLabel>画布类型（当前页）</SelectLabel>
              <SelectItem value="infinite">无限画布</SelectItem>
              <SelectItem value="a4">A4 页面</SelectItem>
              <SelectItem value="screen">适应屏幕</SelectItem>
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>背景模板（当前页）</SelectLabel>
              <SelectItem value="tpl-blank">{PAGE_TEMPLATE_LABELS.blank}</SelectItem>
              <SelectItem value="tpl-grid">{PAGE_TEMPLATE_LABELS.grid}</SelectItem>
              <SelectItem value="tpl-cornell">
                {PAGE_TEMPLATE_LABELS.cornell}
              </SelectItem>
              <SelectItem value="tpl-socratic">
                {PAGE_TEMPLATE_LABELS.socratic}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>

        <Button
          variant={drawerOpen ? "default" : "outline"}
          size="sm"
          onClick={() => handleToggleDrawer(!drawerOpen)}
        >
          收集区
          {totalWords > 0 && (
            <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-[11px] leading-4">
              {totalWords}
            </span>
          )}
        </Button>
      </header>

      {/* 页签条：白板内多 page（page 级） */}
      <div className="flex items-center gap-1.5">
        {currentBoardPages.map((pg) => {
          const active = pg.id === currentPageId;
          return (
            <button
              key={pg.id}
              type="button"
              onClick={() => void handleSwitchPage(pg.id)}
              className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                active
                  ? "border-sky-400/60 bg-sky-400/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/40"
              }`}
              title={`${pg.canvasType === "infinite" ? "无限" : pg.canvasType === "a4" ? "A4" : "适应屏幕"} · ${PAGE_TEMPLATE_LABELS[pg.template]}`}
            >
              <span
                className={`rounded px-1 text-[10px] font-semibold ${
                  active
                    ? "bg-sky-500 text-white"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                P{pg.pageIndex + 1}
              </span>
              {pg.showPageBadge && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-violet-400"
                  title="页码角标已开启"
                />
              )}
            </button>
          );
        })}

        {/* 白板内新建 page */}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2.5 text-xs"
          onClick={() => setPageDialogOpen(true)}
          disabled={!currentId}
          title="在当前白板内新建一页（需选择画布类型与模板）"
        >
          <FilePlus2 className="h-3.5 w-3.5" />
          新建页
        </Button>

        {/* 页码角标开关（当前页） */}
        <label className="ml-1 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={currentPage?.showPageBadge ?? false}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              handleTogglePageBadge(e.target.checked)
            }
            disabled={!currentPage}
            className="h-3.5 w-3.5 cursor-pointer accent-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          />
          页码角标
        </label>

        <span className="flex-1" />

        {/* 一键清屏（当前页） */}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2.5 text-xs text-muted-foreground hover:text-destructive"
          onClick={handleClearCanvas}
          title="删除当前页全部形状（Ctrl+Z 可撤销）"
        >
          <Eraser className="h-3.5 w-3.5" />
          一键清屏
        </Button>

        {/* 纸张边框（当前页）：导出裁剪范围 */}
        <Button
          variant="outline"
          size="sm"
          className={`h-7 gap-1 px-2.5 text-xs ${
            hasPaperFrame
              ? "border-sky-400/60 bg-sky-400/10 text-foreground"
              : "text-muted-foreground"
          }`}
          onClick={togglePaperFrame}
          title="加入/删除纸张边框：导出时按边框裁剪（再点一次删除）"
        >
          <Frame className="h-3.5 w-3.5" />
          纸张
        </Button>

        {/* 导出（png/svg/json/md/html；有边框按边框裁剪） */}
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2.5 text-xs"
          disabled={!editor || !currentId}
          onClick={() => setExportOpen(true)}
          title="导出白板：PNG / SVG / JSON / Markdown / HTML（需后端 write_export_file 落盘）"
        >
          <Download className="h-3.5 w-3.5" />
          导出
        </Button>
      </div>

      {/* 画布区：tldraw + 浮层（AI 面板 / 收集区抽屉 / 调色盘 / 页码角标 / toast） */}
      <div className="relative flex-1 overflow-hidden rounded-lg border border-border bg-card">
        <Tldraw
          onMount={handleMount}
          colorScheme="dark"
          // 用自建 react-rnd 调色盘替代原生右侧 StylePanel
          components={{ StylePanel: null }}
          // 许可证：未传 licenseKey（开发模式无需）；水印按 tldraw 条款保留
        />

        {/* 页码角标（HTML 浮标，不污染 tldraw 快照；z-[1000] 防 tldraw 内部 300+ 层级盖住） */}
        {pageMeta?.showPageBadge && (
          <div className="pointer-events-none absolute left-3 top-3 z-[1000] rounded-md border border-violet-400/40 bg-[rgba(30,25,50,0.85)] px-2.5 py-1 text-xs font-medium text-violet-200 shadow-lg backdrop-blur">
            第 {pageMeta.pageIndex + 1} 页
          </div>
        )}

        {editor && (
          <>
            <SelectionBubble
              editor={editor}
              onAsk={handleAskSelection}
              onToCollection={() => void handleSelectionToCollection()}
              asking={ai.loading}
            />
            <PalettePanel editor={editor} />
          </>
        )}

        {/* AI 助读面板（左侧，避免与右侧收集区抽屉/调色盘抢占） */}
        {ai.open && (
          <aside className="absolute bottom-3 left-3 top-3 z-40 flex w-80 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
            <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <Sparkles size={15} className="text-violet-500" />
              <span className="text-sm font-medium">AI 助读</span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setAi((p) => ({ ...p, open: false }))}
              >
                <X className="h-4 w-4" />
              </Button>
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
              {/* 触发内容回显 */}
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
                <div className="mb-1 font-medium text-foreground/70">
                  选区内容
                </div>
                <p className="line-clamp-4 break-all">{ai.content}</p>
              </div>

              {ai.loading && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  正在研读选区内容…
                </p>
              )}

              {ai.error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  助读失败：{ai.error}
                </p>
              )}

              {ai.result && (
                <>
                  <div>
                    <div className="mb-1 text-xs font-medium text-foreground/70">
                      批注
                    </div>
                    <p className="whitespace-pre-wrap leading-6">
                      {ai.result.annotation}
                    </p>
                  </div>

                  {ai.result.keywords.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-xs font-medium text-foreground/70">
                        关键词（点击加入收集区）
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {ai.result.keywords.map((kw) => (
                          <button
                            key={kw}
                            type="button"
                            onClick={() => void handleKeywordToCollection(kw)}
                            className="rounded-full border border-border px-2.5 py-0.5 text-xs transition-colors hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:text-emerald-600"
                          >
                            + {kw}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {ai.result.followUps.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-xs font-medium text-foreground/70">
                        继续追问
                      </div>
                      <div className="space-y-1.5">
                        {ai.result.followUps.map((q) => (
                          <button
                            key={q}
                            type="button"
                            onClick={() => void handleAsk(q)}
                            className="block w-full rounded-md border border-border px-3 py-2 text-left text-xs leading-5 transition-colors hover:border-violet-500/50 hover:bg-violet-500/10"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={pinAnnotationToCanvas}
                  >
                    <ClipboardPaste className="h-4 w-4" />
                    批注贴到画布
                  </Button>
                </>
              )}
            </div>
          </aside>
        )}

        {/* 收集区抽屉（右侧） */}
        {drawerOpen && (
          <aside
            data-collection-drawer
            className="absolute bottom-3 right-3 top-3 z-30 flex w-72 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
          >
            <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <span className="text-sm font-medium">
                收集区
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {totalWords} 条
                </span>
              </span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="刷新"
                onClick={() => void refreshWords()}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="清空白板收集区"
                onClick={() => void handleClearWords()}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setDrawerOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto p-3">
              {totalWords === 0 && (
                <div className="flex h-full flex-col items-center justify-center text-center text-xs text-muted-foreground">
                  <p>收集区还是空的。</p>
                  <p className="mt-1">
                    在浏览器插件里划词推送，或在画布上选中文字后点「加入收集区」。
                  </p>
                </div>
              )}

              {words.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                    白板收集区（插件「加入白板」与画布选中文字都汇到这里）
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {words.map((w, i) => (
                      <span
                        key={`${w.term}-${w.addedAt ?? i}`}
                        {...chipDragProps(w.term)}
                        title={
                          w.contextText
                            ? `上下文：${w.contextText.slice(0, 80)}…`
                            : "拖入画布 / 点击插入（文本编辑中则插入光标处）"
                        }
                        className="group flex cursor-grab items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs transition-colors hover:border-primary/60 active:cursor-grabbing"
                      >
                        <span className="max-w-32 truncate">{w.term}</span>
                        <button
                          type="button"
                          className="hidden rounded-full p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:block"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleRemoveWord(w.term);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </aside>
        )}


        {/* toast */}
        {toast && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 z-[900] -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-lg">
            {toast}
          </div>
        )}
      </div>

      {/* 导出对话框（当前白板；有边框按边框裁剪） */}
      {exportOpen && currentRef.current && editor && (
        <WhiteboardExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          editor={editor}
          project={currentRef.current}
          hasPaperFrame={hasPaperFrame}
        />
      )}

      {/* 新建页对话框（画布类型 + 模板 + 页码角标 + 导入模板） */}
      <NewPageDialog
        open={pageDialogOpen}
        boards={boards.filter((b) => !b.deleted)}
        onClose={() => setPageDialogOpen(false)}
        onConfirm={(s) => void handleConfirmNewPage(s)}
      />
    </section>
  );
}
