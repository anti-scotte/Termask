// src/pages/GraphPage.tsx
// 概念可视化图谱工作区（v7 后端接口全接线 + AI 窗口自由拖拽）
//
// 数据流：
//   WXT 扩展 → POST 127.0.0.1:17570/api/concept-graph（全图推送）
//            → POST 127.0.0.1:17570/api/add-to-graph（划词入暂存区，
//              全文抓取时推入特殊词条 __FULL_CONTEXT__，contextText 携带全文）
//   → Rust axum → app.emit("concept-graph" / "staged-word")
//   → bridge 订阅 → useGraphStore / 收集区
//
// 交互总览：
//   - 自由连线：节点四向 Handle，A 右侧拖到 B 左侧即连线（onConnect，幂等去重）
//   - 删除与撤回：Delete/Backspace 删除选中节点/连线；左上角撤销/重做按钮
//     （内置 50 步快照历史，覆盖 删除/连线/气泡关系/逻辑链/推送/节点拖拽/全文分析）
//   - 双选气泡：点两下节点 → 气泡 → analyze_concepts_relationship，
//     连线主标签=关系词、副标签=模型解释（RelationEdge 自定义边）
//   - 分析全文：收集区含 __FULL_CONTEXT__ 特殊词时可用 → analyze_full_context
//     → 更新画布 + summary + FloatingPanel 展示骨架/主旨 → save_graph_project 落盘
//   - 单击节点 → 深度解析浮窗（analyze_single_concept，含角色/关联概念）
//   - 一键生成逻辑链：generate_logic_chain → 画布 + 结果小窗口 + summary 面板
//   - AI 窗口：全文分析 / 节点解析 / 逻辑链结果 / AI 总结 面板均可拖拽移动、
//     右上角统一关闭按钮（FloatingPanel）
//   - 收集区：右侧大抽屉（≥1/3 屏宽、纵向滚动）；chip 悬浮 X 单删、清空收集区；
//     右缘竖排入口常驻（词数角标）
//   - 拖词入画布：chip draggable（application/termask-term）→ 画布 onDrop
//     screenToFlowPosition 定位生成节点
//     ⚠ 依赖 tauri.conf.json 窗口配置 "dragDropEnabled": false，
//       否则 Windows WebView2 会吞掉所有 HTML5 dragover/drop 事件！
//   - 拖节点回收集区：节点拖拽结束点落在抽屉上 → 删节点 + stage_word 同步后端
//     （staged-word 事件回流，本地不重复加）
//   - AI 总结 >300 字可展开/收起（text-sm leading-relaxed）
//
// 持久化：① useGraphStore（localStorage, key=termask-graphs）实时防抖保存；
//         ② 全文分析链路额外 save_graph_project 落盘为 GraphProject（后端原子写）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  MarkerType,
  type NodeTypes,
  type EdgeTypes,
  type OnNodesChange,
  type OnEdgesChange,
  type Connection,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  RotateCcw,
  Plus,
  Network,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Inbox,
  Workflow,
  ChevronDown,
  Loader2,
  Trash2,
  Undo2,
  Redo2,
  Sparkles,
  X,
  BookOpen,
  RefreshCw,
  CornerDownRight,
  ScanSearch,
  GripVertical,
  Zap,
  Spline,
  Minus,
  PencilLine,
  Route,
  Library,
  GitBranch,
  FilePlus2,
  Frame,
  ClipboardCheck,
  Download,
  MessageCircleQuestion,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  listenConceptGraph,
  listenStagedWord,
  listenStagedWordRemoved,
  listenFullContext,
  getStagedWords,
  getFullContext,
  clearStagedWords,
  removeStagedWord,
  stageWord,
  analyzeSingleConcept,
  analyzeConceptsRelationship,
  generateLogicChain,
  analyzeFullContext,
  saveGraphProject,
  getBatchMode,
  setBatchMode,
} from "@/lib/bridge";
import { payloadToFlow } from "@/lib/graphTransform";
import type {
  ConceptGraphPayload,
  StagedWord,
  ConceptAnalysis,
  ConceptNode,
  ConceptEdge,
  FullContextAnalysis,
  GraphProject,
} from "@/types";
import type {
  FlowNode,
  FlowEdge,
  GraphTemplate,
  EdgeLineStyle,
  ConceptKind,
  ConceptNodeData,
  NodeToolbarActions,
} from "@/types/graph";
import {
  EDGE_STYLE_META,
  nextEdgeLineStyle,
  templateMinimapColor,
} from "@/types/graph";
import { ConceptNodeCard } from "@/components/graph/ConceptNodeCard";
import { RelationEdge } from "@/components/graph/RelationEdge";
import { VennZoneNode } from "@/components/graph/VennZoneNode";
import { PaperFrameNode } from "@/components/graph/PaperFrameNode";
import { GraphSidebar } from "@/components/graph/GraphSidebar";
import { CreateGraphDialog } from "@/components/graph/CreateGraphDialog";
import { NodeContextMenu } from "@/components/graph/NodeContextMenu";
import { WordLibraryPanel } from "@/components/graph/WordLibraryPanel";
import { AiAskPanel } from "@/components/graph/AiAskPanel";
import { ExportDialog } from "@/components/graph/ExportDialog";
import { QuizDialog } from "@/components/graph/QuizDialog";
import { buildTemplateScaffold } from "@/lib/graphTemplates";
import { useGraphStore } from "@/stores/useGraphStore";
import { useModelStore } from "@/stores/useModelStore";
import { useWordLibraryStore } from "@/stores/useWordLibraryStore";
import { usePrefsStore } from "@/stores/usePrefsStore";
import { TEMPLATE_META } from "@/types/graph";

/** 自定义节点：概念卡（含选中工具栏）/ 韦恩图区域 / 纸张边框 */
const nodeTypes: NodeTypes = {
  concept: ConceptNodeCard,
  vennZone: VennZoneNode,
  paperFrame: PaperFrameNode,
};
const edgeTypes: EdgeTypes = { relation: RelationEdge };

/** 拖词入画布的数据传输 MIME（收集区 chip → 画布 onDrop） */
const TERM_MIME = "application/termask-term";

/** 全文抓取的特殊词条：contextText 携带整页全文，供 analyze_full_context 使用 */
const FULL_CONTEXT_TERM = "__FULL_CONTEXT__";

/** 历史/未来快照 */
interface Snapshot {
  nodes: FlowNode[];
  edges: FlowEdge[];
}
const HISTORY_LIMIT = 50;

/* ------------------------------------------------------------------ *
 *  FloatingPanel — 可自由拖拽 + 统一关闭按钮的 AI 浮窗基座
 *
 *  v7.1 拖拽性能重构（消除「跟不上光标」）：
 *  - 旧实现每次 pointermove 都 setState → React 重渲染整个浮窗子树
 *    （含长文本内容），高刷下明显掉帧延迟。
 *  - 新实现：拖拽期间【零 React 渲染】——pointermove 直接写
 *    el.style.left/top（同步布局，光标到哪窗口到哪），并挂
 *    willChange 提示；pointerup 才把最终位置一次性提交到 state。
 *  - 初始位置由 className 定位类决定（right-3 top-3 / left-4 top-16 …），
 *    拖过一次后由 state 提供显式 left/top 覆盖定位类。
 *  - headerExtra 可塞入额外按钮（如 AI 总结的折叠箭头），按钮点击不触发拖拽
 * ------------------------------------------------------------------ */
function FloatingPanel({
  title,
  icon,
  positionClass,
  widthClass = "w-72",
  zIndex = 40,
  accentClass = "border-border",
  onClose,
  headerExtra,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  /** 初始定位类，如 "right-3 top-3" / "left-4 top-16" */
  positionClass?: string;
  widthClass?: string;
  zIndex?: number;
  accentClass?: string;
  onClose: () => void;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 拖拽基准（pointerdown 时快照，move 中只读） */
  const drag = useRef<{
    px: number;
    py: number;
    left: number;
    top: number;
  } | null>(null);
  /** pointerup 才提交，拖拽期间保持 null（不触发任何 React 渲染） */
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(
    null,
  );

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    // 按在按钮上（折叠/关闭）不进入拖拽
    if ((e.target as HTMLElement).closest("button")) return;
    const el = panelRef.current;
    if (!el) return;
    drag.current = {
      px: e.clientX,
      py: e.clientY,
      left: el.offsetLeft,
      top: el.offsetTop,
    };
    el.style.willChange = "left, top"; // 提示布局引擎，减少拖拽期间的重排代价
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onHeaderPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = panelRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!d || !el || !parent) return;
    const maxLeft = Math.max(parent.clientWidth - el.offsetWidth, 0);
    const maxTop = Math.max(parent.clientHeight - el.offsetHeight, 0);
    // 直接写 DOM：不走 React，光标与窗口 1:1 同步
    el.style.left = `${Math.min(Math.max(d.left + (e.clientX - d.px), 0), maxLeft)}px`;
    el.style.top = `${Math.min(Math.max(d.top + (e.clientY - d.py), 0), maxTop)}px`;
  };

  const endDrag = () => {
    const el = panelRef.current;
    if (!drag.current || !el) return;
    drag.current = null;
    el.style.willChange = "";
    // 一次性提交最终位置；React 渲染值与当前 inline style 一致，无视觉跳变
    setDragPos({ left: el.offsetLeft, top: el.offsetTop });
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      className={`
        absolute overflow-hidden rounded-lg border ${accentClass}
        bg-[rgba(20,20,30,0.92)] shadow-xl backdrop-blur
        ${widthClass} ${dragPos ? "" : (positionClass ?? "")}
        animate-in fade-in fill-mode-both duration-200
      `}
      style={dragPos ? { left: dragPos.left, top: dragPos.top, zIndex } : { zIndex }}
    >
      {/* 拖拽把手区 */}
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex cursor-grab touch-none select-none items-center gap-1.5 border-b border-white/5 px-2.5 py-2 active:cursor-grabbing"
        title="按住此处拖动窗口"
      >
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-600" />
        {icon}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100">
          {title}
        </span>
        {headerExtra}
        <button
          type="button"
          title="关闭"
          onClick={onClose}
          className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  GraphPage — 导出组件（ReactFlowProvider 包裹）
 * ------------------------------------------------------------------ */
export function GraphPage() {
  return (
    <ReactFlowProvider>
      <GraphFlow />
    </ReactFlowProvider>
  );
}

/* ------------------------------------------------------------------ *
 *  GraphFlow — 内部组件：在 ReactFlowProvider 上下文内运行
 * ------------------------------------------------------------------ */
function GraphFlow() {
  /* ---------- Store 订阅 ---------- */
  const graphs = useGraphStore((s) => s.graphs);
  const currentGraphId = useGraphStore((s) => s.currentGraphId);
  const setCurrentGraph = useGraphStore((s) => s.setCurrentGraph);
  const deleteGraph = useGraphStore((s) => s.deleteGraph);
  const createGraph = useGraphStore((s) => s.createGraph);
  const updateGraph = useGraphStore((s) => s.updateGraph);
  const applyPush = useGraphStore((s) => s.applyPush);

  const current = useMemo(
    () => graphs.find((g) => g.id === currentGraphId) ?? null,
    [graphs, currentGraphId],
  );

  /* ---------- 个性化偏好（设置页可调） ---------- */
  const canvasDots = usePrefsStore((s) => s.canvasDots);
  const showMiniMap = usePrefsStore((s) => s.showMiniMap);
  const defaultTemplate = usePrefsStore((s) => s.defaultTemplate);
  const autoScaffold = usePrefsStore((s) => s.autoScaffold);
  /** 连线动态特效（设置页可关） */
  const edgeAnimated = usePrefsStore((s) => s.edgeAnimated);
  /** 规整折线弯折圆弧半径（设置页可调，渲染时统一注入） */
  const edgeCornerRadius = usePrefsStore((s) => s.edgeCornerRadius);
  /** 词语类型角标全局显示开关 */
  const showKindBadge = usePrefsStore((s) => s.showKindBadge);

  /* ---------- 本地渲染态 ---------- */
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "ok" | "err";
  } | null>(null);

  /* ---------- 收集区（划词缓存区）：实时同步 Rust 内存暂存区 ---------- */
  // 插件 POST /api/add-to-graph → Rust 暂存 + emit("staged-word") → 此处实时追加。
  // 进入页面时先 getStagedWords() 拉全量（此前推入的词不丢）。
  const [stagedWords, setStagedWords] = useState<StagedWord[]>([]);
  /** 收集区大抽屉（右侧 ≥1/3 屏）开合 */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chainGenerating, setChainGenerating] = useState(false);
  /** 批量学习模式（v10）：开启后插件划词即自动静默入暂存（background 轮询本状态） */
  const [batchMode, setBatchModeState] = useState(false);

  /* ---------- 全文分析（__FULL_CONTEXT__ → full-context 单槽位 → analyze_full_context） ---------- */
  // v8.1 后端契约：全文快照【不进暂存区、不广播 staged-word】，而是写入
  // Rust 单槽位 + 广播 "full-context" 事件，前端经 get_full_context 取出。
  const [fullContextWord, setFullContextWord] = useState<StagedWord | null>(
    null,
  );
  const [fullAnalyzing, setFullAnalyzing] = useState(false);
  const [fullResult, setFullResult] = useState<FullContextAnalysis | null>(null);
  const [fullSaved, setFullSaved] = useState(false);

  /* ---------- 逻辑链结果小窗口（generate_logic_chain 成功后弹出） ---------- */
  const [chainResult, setChainResult] = useState<{
    labels: string[];
    summary?: string;
  } | null>(null);

  /* ---------- 节点深度解析（单击节点 → 浮窗） ---------- */
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    loading: boolean;
    data: ConceptAnalysis | null;
    error: string | null;
  }>({ loading: false, data: null, error: null });
  const [detailNonce, setDetailNonce] = useState(0);
  /** 节点被拖到收集区抽屉上方时的高亮提示 */
  const [nodeOverDrawer, setNodeOverDrawer] = useState(false);
  /** AI 总结面板整体关闭态（X 关闭后可通过角落小按钮重新打开） */
  const [summaryPanelClosed, setSummaryPanelClosed] = useState(false);

  /** 逻辑链生成只需词数组：从暂存词条派生（须在 handleGenerateChain 之前声明） */
  const collection = useMemo(
    () => stagedWords.map((w) => w.term),
    [stagedWords],
  );

  /** 全文快照是否就绪（决定「分析全文」按钮可用性） */
  const hasFullContext = Boolean(
    (fullContextWord?.contextText ?? "").trim(),
  );
  /** 全文快照字数（就绪徽章展示） */
  const fullContextChars = useMemo(
    () => (fullContextWord?.contextText ?? "").trim().length,
    [fullContextWord],
  );

  /* stagedWords / 全文快照的 ref 镜像：供深度解析 effect 读取最新上下文而不触发重跑 */
  const stagedWordsRef = useRef(stagedWords);
  useEffect(() => {
    stagedWordsRef.current = stagedWords;
  }, [stagedWords]);
  const fullContextRef = useRef(fullContextWord);
  useEffect(() => {
    fullContextRef.current = fullContextWord;
  }, [fullContextWord]);

  /* ---------- 连线交互态（v0.1.0）：工具栏拉线模式 ---------- */
  const [connectMode, setConnectMode] = useState<{
    sourceId: string;
    ai: boolean;
  } | null>(null);
  const [relGenerating, setRelGenerating] = useState(false);

  /* ---------- AI 追问区 / 导出 / 测评 ---------- */
  const [aiAskOpen, setAiAskOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [quizOpen, setQuizOpen] = useState(false);

  /* ---------- 连线形态（工具条选择，作用于新连线；双击已有边循环切换） ---------- */
  // 初值取个性化设置 defaultEdgeStyle（后续工具条即时切换）
  const [edgeLineStyle, setEdgeLineStyle] = useState<EdgeLineStyle>(
    usePrefsStore.getState().defaultEdgeStyle,
  );

  /* ---------- 词库收纳区（第三区域）+ 右键菜单 + 深度解析模式 ---------- */
  const wordLibraryOpen = useWordLibraryStore((s) => s.panelOpen);
  const setWordLibraryOpen = useWordLibraryStore((s) => s.setPanelOpen);
  const libraryUpsert = useWordLibraryStore((s) => s.upsert);
  const setLibraryKind = useWordLibraryStore((s) => s.setKind);
  const detachLibraryNode = useWordLibraryStore((s) => s.detachNode);

  /** 右键菜单锚点（clientX/Y）与目标节点 */
  const [ctxMenu, setCtxMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);
  /** 深度解析模式：context=带全文上下文 / plain=仅词义解释 */
  const [detailMode, setDetailMode] = useState<"context" | "plain">("context");

  /* ---------- 撤销/重做历史（50 步快照） ---------- */
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);

  /** fitView / zoom / 坐标换算由 Provider 上下文提供 */
  const { fitView, zoomIn, zoomOut, screenToFlowPosition, getViewport, setCenter } =
    useReactFlow();

  /** 画布容器 ref（点击收集区词条时量取视口中心用） */
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((msg: string, tone: "ok" | "err" = "ok") => {
    setToast({ msg, tone });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  /* ---------- 历史：压栈 / 撤销 / 重做 ---------- */
  const pushHistory = useCallback(
    (snap?: Snapshot) => {
      const s = snap ?? { nodes, edges };
      setPast((p) => [...p.slice(-(HISTORY_LIMIT - 1)), s]);
      setFuture([]);
    },
    [nodes, edges],
  );

  const undo = useCallback(() => {
    if (!past.length) return;
    const prev = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture((f) => [{ nodes, edges }, ...f].slice(0, HISTORY_LIMIT));
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setConnectMode(null);
  }, [past, nodes, edges]);

  const redo = useCallback(() => {
    if (!future.length) return;
    const next = future[0];
    setFuture(future.slice(1));
    setPast((p) => [...p.slice(-(HISTORY_LIMIT - 1)), { nodes, edges }]);
    setNodes(next.nodes);
    setEdges(next.edges);
    setConnectMode(null);
  }, [future, nodes, edges]);

  /* ---------- 切换图谱：从 Store 加载节点/边 ---------- */
  useEffect(() => {
    if (current) {
      setNodes(current.nodes);
      setEdges(current.edges);
    } else {
      setNodes([]);
      setEdges([]);
    }
    setPast([]);
    setFuture([]);
    setConnectMode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGraphId]);

  /* ---------- 节点/边变更 → 防抖写回 Store（含拖拽位置）+ 词库登记 ---------- */
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!currentGraphId) return;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      updateGraph(currentGraphId, { nodes, edges });
      // 词库登记：画布上每个有词的节点 upsert 一条（term 唯一键，幂等）
      // 自动识别走 guessKind（useWordLibraryStore 内置）；后端 LLM 分类接入后在此替换
      nodes.forEach((n) => {
        const label = String((n.data as { label?: string }).label ?? "").trim();
        if (label) {
          libraryUpsert(label, { nodeId: n.id, source: "画布节点" });
        }
      });
    }, 400);
    return () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, currentGraphId]);

  /* ---------- 暂存区：初始拉取 + 实时监听插件推送 ---------- */
  useEffect(() => {
    let mounted = true;
    getStagedWords()
      .then((words) => {
        if (mounted) setStagedWords(words);
      })
      .catch((e) => console.warn("[GraphPage] getStagedWords failed:", e));

    const unlisten = listenStagedWord((word) => {
      setStagedWords((prev) => [...prev, word]);
    });

    // 全文快照：初始拉取单槽位 + 实时监听 full-context 事件（覆盖式更新）
    getFullContext()
      .then((w) => {
        if (mounted && w) {
          console.log(
            "[GraphPage] 全文快照已就绪:",
            (w.contextText ?? "").length,
            "字",
          );
          setFullContextWord(w);
        }
      })
      .catch((e) => console.warn("[GraphPage] getFullContext failed:", e));

    const unlistenFull = listenFullContext((word) => {
      console.log(
        "[GraphPage] 收到 full-context 事件:",
        (word?.contextText ?? "").length,
        "字",
      );
      setFullContextWord(word);
    });

    // 远端删除（插件 Ctrl+Shift+Z → POST /api/remove-last）必须同步到 chip 列表，
    // 否则会出现「后端已删、界面还在」的假数据。
    const unlistenRemoved = listenStagedWordRemoved((word) => {
      setStagedWords((prev) =>
        prev.filter(
          (w) =>
            !(
              w.term === word.term &&
              (w.target ?? "graph") === (word.target ?? "graph")
            ),
        ),
      );
      if (word.term === FULL_CONTEXT_TERM) setFullContextWord(null);
    });

    return () => {
      mounted = false;
      unlisten.then((fn) => fn());
      unlistenFull.then((fn) => fn());
      unlistenRemoved.then((fn) => fn());
    };
  }, []);

  /* ---------- 批量学习模式（v10）：初始拉取 + 切换 ---------- */
  useEffect(() => {
    getBatchMode()
      .then(setBatchModeState)
      .catch((e) => console.warn("[GraphPage] getBatchMode failed:", e));
  }, []);

  const handleToggleBatchMode = useCallback(async () => {
    try {
      const next = await setBatchMode(!batchMode);
      setBatchModeState(next);
      showToast(
        next
          ? "批量模式已开启：浏览器里划词即自动收集，无需点按钮"
          : "批量模式已关闭：划词后需手动「加入图谱」",
      );
    } catch (e) {
      console.warn("[GraphPage] setBatchMode failed:", e);
      showToast("批量模式切换失败", "err");
    }
  }, [batchMode, showToast]);

  const handleClearStaged = useCallback(async () => {
    try {
      await clearStagedWords();
      setStagedWords([]);
    } catch (e) {
      console.warn("[GraphPage] clearStagedWords failed:", e);
    }
  }, []);

  /** 单删词：乐观移除本地条目 + 同步后端；失败则回滚为后端真实状态 */
  const handleRemoveStaged = useCallback(async (term: string) => {
    setStagedWords((prev) => prev.filter((w) => w.term !== term));
    try {
      await removeStagedWord(term);
    } catch (e) {
      console.warn("[GraphPage] removeStagedWord failed:", e);
      getStagedWords()
        .then((words) => setStagedWords(words))
        .catch(() => undefined);
    }
  }, []);

  /* ---------- 全文上下文：优先全文快照单槽位，缺省回退图谱选段 ---------- */
  const resolveContextText = useCallback((): string => {
    const full = (fullContextRef.current?.contextText ?? "").trim();
    if (full) return full;
    return current?.sourceExcerpt ?? "";
  }, [current]);

  /* ---------- 单节点深度解析：detailNodeId 变化 → analyze_single_concept ---------- */
  useEffect(() => {
    if (!detailNodeId) return;
    const node = nodes.find((n) => n.id === detailNodeId);
    if (!node) {
      setDetailNodeId(null);
      return;
    }
    const term = String(node.data.label ?? "").trim();
    if (!term) {
      setDetail({ loading: false, data: null, error: "该节点没有概念词" });
      return;
    }

    console.log("[GraphPage] 开始深度解析:", detailNodeId, "词:", term);

    let cancelled = false;
    setDetail({ loading: true, data: null, error: null });
    (async () => {
      try {
        const provider = useModelStore.getState().getDefaultProvider();
        if (!provider) {
          if (!cancelled)
            setDetail({
              loading: false,
              data: null,
              error: "请先在「模型设置」添加并启用一个 Provider",
            });
          return;
        }
        // 上下文：context 模式优先全文词条（后端只取 8000 字），plain 模式仅解释词义
        const context = detailMode === "context" ? resolveContextText() : "";
        console.log(
          "[GraphPage] analyzeSingleConcept 入参: term=%s, context=%d 字",
          term,
          context.length,
        );
        const r = await analyzeSingleConcept(term, context, {
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey ?? "",
          model: provider.model,
        });
        console.log("[GraphPage] 深度解析返回:", r);
        if (!cancelled) setDetail({ loading: false, data: r, error: null });
      } catch (e) {
        console.error("[GraphPage] 深度解析调用失败:", e);
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : "调用异常";
          setDetail({ loading: false, data: null, error: msg });
          showToast(`「${term}」解析失败：${msg}`, "err");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // nodes/current 取点击瞬间的值即可，避免拖拽期间重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailNodeId, detailNonce, detailMode]);

  /* ---------- 监听扩展推送 → 写入当前图谱并渲染（可撤销） ---------- */
  useEffect(() => {
    const unlistenPromise = listenConceptGraph(
      (payload: ConceptGraphPayload) => {
        pushHistory(); // 推送覆盖前先存快照
        const id = applyPush(payload);
        const template =
          useGraphStore.getState().graphs.find((g) => g.id === id)?.template ??
          "free";
        const { nodes: flowNodes, edges: flowEdges } = payloadToFlow(
          payload,
          template,
        );
        setNodes(flowNodes);
        setEdges(flowEdges);
        setConnectMode(null);
        showToast(
          `已收到推送：${flowNodes.length} 节点 · ${flowEdges.length} 关系`,
        );
      },
    );

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [applyPush, pushHistory, showToast]);

  /* ---------- React Flow 变更回调 ---------- */
  const onNodesChange: OnNodesChange = useCallback(
    (changes) =>
      setNodes((nds) => applyNodeChanges(changes, nds) as FlowNode[]),
    [],
  );
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) =>
      setEdges((eds) => applyEdgeChanges(changes, eds) as FlowEdge[]),
    [],
  );

  /* ---------- 自由连线：拖拽 Handle → onConnect（幂等去重） ---------- */
  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, target, sourceHandle, targetHandle } = connection;
      if (!source || !target || source === target) return;
      const dup = edges.some(
        (e) =>
          (e.source === source && e.target === target) ||
          (e.source === target && e.target === source),
      );
      if (dup) {
        showToast("这两个概念之间已有连线", "err");
        return;
      }
      pushHistory();
      const edge: FlowEdge = {
        id: `conn-${source}-${target}-${Date.now()}`,
        source,
        target,
        sourceHandle: sourceHandle ?? undefined,
        targetHandle: targetHandle ?? undefined,
        type: "relation",
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { label: "自由关联", lineStyle: edgeLineStyle },
      };
      setEdges((es) => [...es, edge]);
    },
    [edges, edgeLineStyle, pushHistory, showToast],
  );

  /* ---------- 双击边 → 循环切换连线形态（自由 → 直线 → 随手写），可撤销 ---------- */
  const onEdgeDoubleClick = useCallback(
    (_e: React.MouseEvent, edge: FlowEdge) => {
      pushHistory();
      setEdges((es) =>
        es.map((e) =>
          e.id === edge.id
            ? {
                ...e,
                data: {
                  ...e.data,
                  lineStyle: nextEdgeLineStyle(
                    ((e.data as { lineStyle?: EdgeLineStyle })?.lineStyle ??
                      "smooth") as EdgeLineStyle,
                  ),
                },
              }
            : e,
        ),
      );
      setEdgeLineStyle(
        nextEdgeLineStyle(
          ((edge.data as { lineStyle?: EdgeLineStyle })?.lineStyle ??
            "smooth") as EdgeLineStyle,
        ),
      );
    },
    [pushHistory],
  );

  /* ---------- 右键菜单：删除 / 更换图标 / 外观 / 词语类型 / AI 助学 ---------- */
  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: FlowNode) => {
      e.preventDefault();
      setCtxMenu({ nodeId: node.id, x: e.clientX, y: e.clientY });
    },
    [],
  );

  /** 按 id 合并节点 data（菜单各项操作的基础） */
  const patchNodeData = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
        ),
      );
    },
    [],
  );

  const handleCtxDelete = useCallback(() => {
    if (!ctxMenu) return;
    const id = ctxMenu.nodeId;
    pushHistory();
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) =>
      es.filter((ed) => ed.source !== id && ed.target !== id),
    );
    detachLibraryNode(id);
    setDetailNodeId(null);
    setCtxMenu(null);
  }, [ctxMenu, pushHistory, detachLibraryNode]);

  const handleCtxSetKind = useCallback(
    (kind: ConceptKind) => {
      if (!ctxMenu) return;
      const node = nodes.find((n) => n.id === ctxMenu.nodeId);
      if (!node) return;
      patchNodeData(ctxMenu.nodeId, { kind, kindSource: "manual" });
      // 词库同步手动归类（词条此刻可能尚未登记 → upsert 兜底）
      const label = String((node.data as { label?: string }).label ?? "").trim();
      if (label) {
        libraryUpsert(label, { nodeId: node.id, source: "画布节点" });
        setLibraryKind(label, kind);
      }
    },
    [ctxMenu, nodes, patchNodeData, libraryUpsert, setLibraryKind],
  );

  const handleCtxExplain = useCallback(() => {
    if (!ctxMenu) return;
    setDetailMode("plain"); // 仅词义解释，不带全文上下文
    setDetailNodeId(ctxMenu.nodeId);
    setDetailNonce((n) => n + 1);
    setCtxMenu(null);
  }, [ctxMenu]);

  const handleCtxAnalyzeContext = useCallback(() => {
    if (!ctxMenu) return;
    setDetailMode("context"); // 带全文上下文分析该词的作用
    setDetailNodeId(ctxMenu.nodeId);
    setDetailNonce((n) => n + 1);
    setCtxMenu(null);
  }, [ctxMenu]);

  /** 词库条目点击 → 有节点则定位 */
  const handleLocateNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      setNodes((ns) =>
        ns.map((n) => ({ ...n, selected: n.id === nodeId })),
      );
      const w = node.measured?.width ?? 150;
      const h = node.measured?.height ?? 48;
      void setCenter(
        node.position.x + w / 2,
        node.position.y + h / 2,
        { zoom: Math.max(getViewport().zoom, 0.9), duration: 400 },
      );
      setWordLibraryOpen(false);
    },
    [nodes, setCenter, getViewport, setWordLibraryOpen],
  );

  /** 词库条目：单击加入当前图谱（无关联节点则新建，有则定位） */
  const handleLibraryClick = useCallback(
    (entry: { term: string; nodeId?: string }) => {
      if (entry.nodeId && nodes.some((n) => n.id === entry.nodeId)) {
        handleLocateNode(entry.nodeId);
        return;
      }
      // 复用收集区单击入图逻辑：视口中心新建节点
      const el = canvasWrapRef.current;
      const rect = el?.getBoundingClientRect();
      const vp = getViewport();
      const cx = rect ? rect.width / 2 : 300;
      const cy = rect ? rect.height / 2 : 200;
      const pos = {
        x: (cx - vp.x) / vp.zoom - 75 + (Math.random() * 60 - 30),
        y: (cy - vp.y) / vp.zoom - 24 + (Math.random() * 40 - 20),
      };
      pushHistory();
      const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setNodes((ns) => [
        ...ns,
        {
          id,
          type: "concept",
          position: pos,
          data: {
            label: entry.term,
            template: current?.template ?? "free",
          },
        } as FlowNode,
      ]);
      libraryUpsert(entry.term, { nodeId: id, source: "词库单击" });
      showToast(`已把「${entry.term}」加入当前图谱`);
      setWordLibraryOpen(false);
    },
    [
      nodes,
      handleLocateNode,
      getViewport,
      current,
      pushHistory,
      libraryUpsert,
      showToast,
      setWordLibraryOpen,
    ],
  );

  /* ---------- 删除：Delete/Backspace 删除选中节点与连线（可撤销） ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // 输入框内不拦截
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;

      const selNodes = nodes.filter((n) => n.selected);
      const selEdges = edges.filter((ed) => ed.selected);
      if (!selNodes.length && !selEdges.length) return;

      e.preventDefault();
      pushHistory();

      const delNodeIds = new Set(selNodes.map((n) => n.id));
      // 被删节点的相连边一并删除
      const delEdgeIds = new Set(selEdges.map((ed) => ed.id));
      for (const ed of edges) {
        if (delNodeIds.has(ed.source) || delNodeIds.has(ed.target)) {
          delEdgeIds.add(ed.id);
        }
      }
      setNodes((ns) => ns.filter((n) => !delNodeIds.has(n.id)));
      setEdges((es) => es.filter((ed) => !delEdgeIds.has(ed.id)));
      // 词库：被删节点解除关联（词条保留，可再拖回画布）
      delNodeIds.forEach((id) => detachLibraryNode(id));
      showToast(
        `已删除 ${delNodeIds.size} 节点 · ${delEdgeIds.size} 连线（可撤销）`,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes, edges, pushHistory, showToast]);


  /* ---------- 节点拖拽：位置纳入撤销 + 拖到收集区抽屉上移回暂存区 ---------- */
  const dragSnap = useRef<Snapshot | null>(null);

  /** 指针坐标是否落在收集区抽屉上（几何判定，与指针捕获无关） */
  const isOverDrawer = (clientX: number, clientY: number) =>
    Number.isFinite(clientX) &&
    Number.isFinite(clientY) &&
    Boolean(
      document
        .elementFromPoint(clientX, clientY)
        ?.closest("[data-collection-drawer]"),
    );

  const onNodeDragStart: OnNodeDrag = useCallback(() => {
    dragSnap.current = { nodes, edges };
    setNodeOverDrawer(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  /** 拖拽过程中实时高亮抽屉，提示「放下即可移回收集区」 */
  const onNodeDrag: OnNodeDrag = useCallback((event) => {
    const mouse = event as MouseEvent;
    setNodeOverDrawer(isOverDrawer(mouse.clientX, mouse.clientY));
  }, []);

  const onNodeDragStop: OnNodeDrag = useCallback(
    (event, node) => {
      const mouse = event as MouseEvent;
      const overDrawer = isOverDrawer(mouse.clientX, mouse.clientY);
      setNodeOverDrawer(false);
      const snap = dragSnap.current;
      dragSnap.current = null;
      if (overDrawer && snap) {
        // 撤销基准 = 拖拽前快照；随后删节点 + 级联删边，词条回流暂存区
        pushHistory(snap);
        setNodes((ns) => ns.filter((n) => n.id !== node.id));
        setEdges((es) =>
          es.filter((ed) => ed.source !== node.id && ed.target !== node.id),
        );
        detachLibraryNode(node.id); // 词库解除关联（词条回流收集区）
        setConnectMode(null);
        setDetailNodeId(null);
        const label = String(
          (node.data as { label?: string }).label ?? "",
        ).trim();
        if (label) {
          // stage_word 会广播 staged-word 事件 → 收集区监听器自动追加，勿本地重复加
          stageWord({ term: label, sourceUrl: "工作台画布拖出" }).catch((e) =>
            console.warn("[GraphPage] stageWord failed:", e),
          );
          showToast(`「${label}」已移回收集区`);
        }
        return;
      }
      if (snap) pushHistory(snap);
    },
    [pushHistory, showToast],
  );

  /* ---------- 连线交互（v0.1.0）：工具栏「拉线」按钮 → 点击目标词框即连 ----------
     原两段式点按交互与「生成概念互联」气泡已取消：
     点按词汇不再触发解释（解释/上下文/连线全部走节点工具栏与右键菜单）。 */

  /** 按两节点相对方位选 Handle id（与视觉方向一致） */
  const pickHandleIds = useCallback(
    (a: FlowNode, b: FlowNode): { sourceHandle: string; targetHandle: string } => {
      const acx = a.position.x + (a.measured?.width ?? 150) / 2;
      const acy = a.position.y + (a.measured?.height ?? 48) / 2;
      const bcx = b.position.x + (b.measured?.width ?? 150) / 2;
      const bcy = b.position.y + (b.measured?.height ?? 48) / 2;
      if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
        return bcx >= acx
          ? { sourceHandle: "right", targetHandle: "left" }
          : { sourceHandle: "left", targetHandle: "right" };
      }
      return bcy >= acy
        ? { sourceHandle: "bottom", targetHandle: "top" }
        : { sourceHandle: "top", targetHandle: "bottom" };
    },
    [],
  );

  /** 直接建边（拉线模式，标签留空 = 自由关联） */
  const addEdgeBetween = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return;
      const a = nodes.find((n) => n.id === sourceId);
      const b = nodes.find((n) => n.id === targetId);
      if (!a || !b) return;
      const dup = edges.some(
        (e) =>
          (e.source === sourceId && e.target === targetId) ||
          (e.source === targetId && e.target === sourceId),
      );
      if (dup) {
        showToast("这两个概念之间已有连线", "err");
        return;
      }
      pushHistory();
      const { sourceHandle, targetHandle } = pickHandleIds(a, b);
      setEdges((es) => [
        ...es,
        {
          id: `conn-${sourceId}-${targetId}-${Date.now()}`,
          source: sourceId,
          target: targetId,
          sourceHandle,
          targetHandle,
          type: "relation",
          animated: edgeAnimated,
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { label: "", lineStyle: edgeLineStyle },
        } as FlowEdge,
      ]);
      showToast("已连线（双击边可切换形态；工具栏「AI 连线」可生成关系词）");
    },
    [nodes, edges, edgeLineStyle, edgeAnimated, pickHandleIds, pushHistory, showToast],
  );

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: FlowNode) => {
      console.log("点击了节点:", node.id, "connectMode:", connectMode);
      if (relGenerating) return;
      // 连线模式：点击目标 → 建边（直接 or AI）
      if (connectMode && node.id !== connectMode.sourceId) {
        const { sourceId, ai } = connectMode;
        setConnectMode(null);
        if (ai) {
          void handleAnalyzeRelation(sourceId, node.id);
        } else {
          addEdgeBetween(sourceId, node.id);
        }
      }
      // 非连线模式：点按 = 选中（工具栏浮现由 React Flow selected 驱动），
      // 不再自动打开深度解析浮窗
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectMode, relGenerating, addEdgeBetween],
  );

  /** 点空白处取消连线模式并收起浮窗 */
  const onPaneClick = useCallback(() => {
    console.log("[GraphPage] 点击了画布空白处（取消待选/收起浮窗）");
    setConnectMode(null);
    setDetailNodeId(null);
    setCtxMenu(null);
  }, []);

  /* ---------- AI 连线：analyze_concepts_relationship 生成关系词与解释 ---------- */
  const handleAnalyzeRelation = useCallback(
    async (sourceId: string, targetId: string) => {
      if (relGenerating || !current) return;
      const a = nodes.find((n) => n.id === sourceId);
      const b = nodes.find((n) => n.id === targetId);
      if (!a || !b || sourceId === targetId) return;

      const provider = useModelStore.getState().getDefaultProvider();
      if (!provider) {
        showToast("请先在「模型设置」添加并启用一个 Provider", "err");
        return;
      }

      setRelGenerating(true);
      try {
        const result = await analyzeConceptsRelationship({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey ?? "",
          model: provider.model,
          nodeA: String(a.data.label),
          nodeB: String(b.data.label),
          context: current.sourceExcerpt,
        });

        if (result.success && result.label) {
          pushHistory();
          const { sourceHandle, targetHandle } = pickHandleIds(a, b);
          const edge: FlowEdge = {
            id: `rel-${a.id}-${b.id}-${Date.now()}`,
            source: a.id,
            target: b.id,
            sourceHandle,
            targetHandle,
            type: "relation",
            animated: edgeAnimated,
            markerEnd: { type: MarkerType.ArrowClosed },
            // 主标签=关系词，副标签=模型解释（RelationEdge 渲染）；形态跟随工具条
            label: result.label,
            data: { label: result.label, explanation: result.explanation, lineStyle: edgeLineStyle },
          };
          setEdges((es) => [...es, edge]);
          showToast(
            result.explanation
              ? `已建立关系「${result.label}」：${result.explanation}`
              : `已建立关系「${result.label}」`,
          );
        } else {
          showToast(`生成失败：${result.error ?? "未知错误"}`, "err");
        }
      } catch (e) {
        showToast(
          `生成失败：${e instanceof Error ? e.message : "调用异常"}`,
          "err",
        );
      } finally {
        setRelGenerating(false);
      }
    },
    [
      relGenerating,
      current,
      nodes,
      edgeLineStyle,
      edgeAnimated,
      pickHandleIds,
      pushHistory,
      showToast,
    ],
  );

  /* ---------- 节点工具栏动作（注入 data._actions 供 ConceptNodeCard 调用） ---------- */
  const toolbarActions: NodeToolbarActions = useMemo(
    () => ({
      connect: (id) => {
        setConnectMode({ sourceId: id, ai: false });
        showToast("拉线模式：点击目标词框即连（Esc 或点空白取消）");
      },
      aiConnect: (id) => {
        setConnectMode({ sourceId: id, ai: true });
        showToast("AI 连线模式：点击目标词框，模型生成关系词");
      },
      explain: (id) => {
        setDetailMode("plain");
        setDetailNodeId(id);
        setDetailNonce((n) => n + 1);
      },
      analyzeContext: (id) => {
        setDetailMode("context");
        setDetailNodeId(id);
        setDetailNonce((n) => n + 1);
      },
      remove: (id) => {
        pushHistory();
        setNodes((ns) => ns.filter((n) => n.id !== id));
        setEdges((es) =>
          es.filter((ed) => ed.source !== id && ed.target !== id),
        );
        detachLibraryNode(id);
        setDetailNodeId(null);
      },
    }),
    [pushHistory, detachLibraryNode, showToast],
  );

  /* ---------- 一键新增词汇框（不再需要拖动） ---------- */
  const addBlankNode = useCallback(() => {
    const el = canvasWrapRef.current;
    const rect = el?.getBoundingClientRect();
    const vp = getViewport();
    const cx = rect ? rect.width / 2 : 300;
    const cy = rect ? rect.height / 2 : 200;
    const pos = {
      x: (cx - vp.x) / vp.zoom - 75 + (Math.random() * 60 - 30),
      y: (cy - vp.y) / vp.zoom - 24 + (Math.random() * 40 - 20),
    };
    pushHistory();
    const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: "concept",
        position: pos,
        data: {
          label: "",
          slot: "新概念",
          placeholder: true,
          template: current?.template ?? "free",
        },
      } as FlowNode,
    ]);
    showToast("已新增空白词汇框：点击填写，或拖入收集区词条");
  }, [getViewport, current, pushHistory, showToast]);

  /* ---------- 纸张边框：一键加入 / 删除 ---------- */
  const togglePaperFrame = useCallback(() => {
    const existing = nodes.find((n) => n.type === "paperFrame");
    pushHistory();
    if (existing) {
      setNodes((ns) => ns.filter((n) => n.id !== existing.id));
      showToast("已移除纸张边框");
      return;
    }
    // 按现有概念节点包围盒自适应（外扩 80px）
    const conceptBoxes = nodes
      .filter((n) => n.type === "concept")
      .map((n) => ({
        x: n.position.x,
        y: n.position.y,
        w: n.measured?.width ?? 150,
        h: n.measured?.height ?? 48,
      }));
    const minX = Math.min(...conceptBoxes.map((b) => b.x)) - 80;
    const minY = Math.min(...conceptBoxes.map((b) => b.y)) - 80;
    const maxX = Math.max(...conceptBoxes.map((b) => b.x + b.w)) + 80;
    const maxY = Math.max(...conceptBoxes.map((b) => b.y + b.h)) + 80;
    setNodes((ns) => [
      ...ns,
      {
        id: "paper-frame",
        type: "paperFrame",
        position: { x: minX, y: minY },
        draggable: true,
        selectable: false,
        zIndex: -1,
        data: {
          label: "",
          frameW: maxX - minX,
          frameH: maxY - minY,
          template: current?.template ?? "free",
        },
      } as FlowNode,
    ]);
    showToast("已加入纸张边框：导出将按边框裁剪（可拖动调整位置）");
  }, [nodes, current, pushHistory, showToast]);

  /** 导出裁剪范围：有纸张边框 → 边框；否则 undefined（按内容包围盒） */
  const paperBounds = useMemo(() => {
    const frame = nodes.find((n) => n.type === "paperFrame");
    if (!frame) return undefined;
    return {
      x: frame.position.x,
      y: frame.position.y,
      w: Number((frame.data as { frameW?: number }).frameW ?? 1200),
      h: Number((frame.data as { frameH?: number }).frameH ?? 800),
    };
  }, [nodes]);

  /** 当前图谱 → GraphProject（后端 export_graph_project 渲染入参） */
  const buildExportProject = useCallback((): GraphProject => {
    const now = Date.now();
    return {
      id: currentGraphId ?? `export-${now}`,
      title: current?.name ?? "未命名图谱",
      templateType: current?.template ?? "free",
      nodes: nodes
        .filter((n) => n.type === "concept")
        .map((n) => {
          const d = n.data as ConceptNodeData;
          return {
            id: n.id,
            label: String(d.label ?? ""),
            level: d.level,
            description: d.description,
            position: { x: n.position.x, y: n.position.y },
          };
        }),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label:
          (e.data as { label?: string })?.label ??
          (typeof e.label === "string" ? e.label : undefined),
      })),
      summary: current?.summary ?? "",
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
  }, [current, currentGraphId, nodes, edges]);

  /* ---------- 图谱概览（AI 追问区模板 {{图谱概览}}） ---------- */
  const graphOverview = useMemo(
    () =>
      [
        "节点：",
        ...nodes
          .filter((n) => n.type === "concept")
          .map((n, i) => {
            const label = String((n.data as { label?: string }).label ?? "");
            return label ? `${i + 1}. ${label}` : null;
          })
          .filter(Boolean),
        "",
        "关系：",
        ...edges.map((e) => {
          const s = nodes.find((n) => n.id === e.source);
          const t = nodes.find((n) => n.id === e.target);
          const label =
            (e.data as { label?: string })?.label ??
            (typeof e.label === "string" ? e.label : "关联");
          const sl = s ? String((s.data as { label?: string }).label ?? "") : "?";
          const tl = t ? String((t.data as { label?: string }).label ?? "") : "?";
          return `- ${sl} —${label}→ ${tl}`;
        }),
      ].join("\n"),
    [nodes, edges],
  );

  /* ---------- 分析全文：全文快照 → analyze_full_context → 画布 + 落盘 ---------- */
  const handleAnalyzeFullContext = useCallback(async () => {
    if (fullAnalyzing) return;
    const fw = fullContextWord;
    const text = (fw?.contextText ?? "").trim();
    if (!text) {
      showToast("暂无全文快照——先在插件端抓取全文", "err");
      return;
    }

    const provider = useModelStore.getState().getDefaultProvider();
    if (!provider) {
      showToast("请先在「模型设置」添加并启用一个 Provider", "err");
      return;
    }

    setFullAnalyzing(true);
    try {
      console.log("[GraphPage] 全文分析开始, 字数:", text.length);
      const analysis = await analyzeFullContext(text, {
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey ?? "",
        model: provider.model,
      });
      console.log(
        "[GraphPage] 全文分析返回: title=%s, nodes=%d, edges=%d, outline=%d, summary=%d 字",
        analysis.title,
        analysis.nodes.length,
        analysis.edges.length,
        analysis.outline.length,
        analysis.summary.length,
      );

      if (!analysis.nodes.length) {
        showToast("全文分析未产出任何概念节点", "err");
        return;
      }

      pushHistory();

      // 后端返回 → 统一转换（沿用当前图谱模板的布局与配色）
      const template: GraphTemplate = current?.template ?? "free";
      const payload: ConceptGraphPayload = {
        sessionId: `full-${Date.now()}`,
        sourceExcerpt: text.slice(0, 2000),
        nodes: analysis.nodes,
        edges: analysis.edges,
      };
      const { nodes: flowNodes, edges: flowEdges } = payloadToFlow(
        payload,
        template,
      );

      // 无当前图谱时自动新建一个承载结果
      let targetId = currentGraphId;
      let doc = current;
      if (!targetId || !doc) {
        targetId = createGraph(
          analysis.title || "全文分析",
          template,
        );
        doc =
          useGraphStore.getState().graphs.find((g) => g.id === targetId) ??
          null;
      }
      updateGraph(targetId, {
        nodes: flowNodes,
        edges: flowEdges,
        sessionId: payload.sessionId,
        sourceExcerpt: payload.sourceExcerpt,
        summary: analysis.summary,
      });
      setNodes(flowNodes);
      setEdges(flowEdges);
      setConnectMode(null);
      setSummaryPanelClosed(false); // 新总结生成 → 确保总结面板可见

      // 保存为 GraphProject（后端原子写落盘）
      let saved = false;
      try {
        const project: GraphProject = {
          id: targetId,
          title: analysis.title || doc?.name || "全文分析",
          templateType: doc?.template ?? template,
          nodes: flowNodes.map(
            (n): ConceptNode => ({
              id: n.id,
              label: String(n.data.label ?? ""),
              level: n.data.level,
              description: n.data.description,
              position: { x: n.position.x, y: n.position.y },
            }),
          ),
          edges: flowEdges.map((e): ConceptEdge => ({
            id: e.id,
            source: e.source,
            target: e.target,
            label:
              e.data?.label ??
              (typeof e.label === "string" ? e.label : undefined),
          })),
          summary: analysis.summary,
          createdAt: doc?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        await saveGraphProject(project);
        saved = true;
        console.log("[GraphPage] GraphProject 已保存:", project.id, project.title);
      } catch (saveErr) {
        console.error("[GraphPage] saveGraphProject 失败:", saveErr);
        showToast(
          `图谱已更新，但保存项目失败：${saveErr instanceof Error ? saveErr.message : "调用异常"}`,
          "err",
        );
      }

      setFullResult(analysis);
      setFullSaved(saved);
      showToast(
        `全文分析完成：${analysis.nodes.length} 概念 · ${analysis.outline.length} 段骨架${saved ? " · 已保存" : ""}`,
      );
    } catch (e) {
      console.error("[GraphPage] 全文分析失败:", e);
      showToast(
        `全文分析失败：${e instanceof Error ? e.message : "调用异常"}`,
        "err",
      );
    } finally {
      setFullAnalyzing(false);
    }
  }, [
    fullAnalyzing,
    fullContextWord,
    current,
    currentGraphId,
    createGraph,
    updateGraph,
    pushHistory,
    showToast,
  ]);

  /* ---------- 一键生成：收集区词汇 → generate_logic_chain（chain 逻辑链 / flow 流程图） ---------- */
  const handleGenerateChain = useCallback(
    async (template: GraphTemplate = "chain") => {
      if (collection.length < 2 || chainGenerating) return;

      const provider = useModelStore.getState().getDefaultProvider();
      if (!provider) {
        showToast("请先在「模型设置」添加并启用一个 Provider", "err");
        return;
      }

      setChainGenerating(true);
      try {
        const result = await generateLogicChain({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey ?? "",
          model: provider.model,
          words: collection,
        });

        if (!result.success || result.nodes.length === 0) {
          showToast(`生成失败：${result.error ?? "未知错误"}`, "err");
          return;
        }

        pushHistory();
        const isFlow = template === "flow";
        // 后端返回 {nodes,edges,summary} → 组装 payload 走统一转换（横向布局）
        const payload: ConceptGraphPayload = {
          sessionId: `${template}-${Date.now()}`,
          sourceExcerpt: `逻辑链：${result.nodes.map((n) => n.label).join(" → ")}`,
          nodes: result.nodes.map((n) => ({ id: n.id, label: n.label })),
          edges: result.edges.map((e) => ({
            id: `${e.source}->${e.target}`,
            source: e.source,
            target: e.target,
            label: e.label,
          })),
        };
        const { nodes: flowNodes0, edges: flowEdges } = payloadToFlow(
          payload,
          template,
        );
        // 流程图风格：首尾胶囊（开始/结束）、中间矩形工序、直线箭头
        const flowNodes = isFlow
          ? flowNodes0.map((n, i) => ({
              ...n,
              data: {
                ...n.data,
                shape:
                  i === 0 || i === flowNodes0.length - 1
                    ? ("pill" as const)
                    : ("card" as const),
              },
            }))
          : flowNodes0;

        // 无当前图谱时自动新建一个承载结果
        let targetId = currentGraphId;
        if (!targetId || !current) {
          targetId = createGraph(
            `${TEMPLATE_META[template].label} ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
            template,
          );
        }
        updateGraph(targetId, {
          nodes: flowNodes,
          edges: flowEdges,
          sessionId: payload.sessionId,
          sourceExcerpt: payload.sourceExcerpt,
          // AI 逻辑总结 → 右上角面板展示
          summary: result.summary,
        });
        setNodes(flowNodes);
        setEdges(flowEdges);
        setConnectMode(null);

        // 结果小窗口（可拖拽）+ 总结面板重新可见
        setChainResult({
          labels: result.nodes.map((n) => n.label),
          summary: result.summary,
        });
        setSummaryPanelClosed(false);

        // 词汇已被消费 → 清空 Rust 暂存区与本地列表
        await clearStagedWords().catch(() => undefined);
        setStagedWords([]);

        showToast(
          isFlow
            ? `工业流程图已生成：${flowNodes.length} 个工序节点（直线箭头 + 起止胶囊）`
            : result.summary
              ? `逻辑链已生成：${result.summary}`
              : `逻辑链已生成：${flowNodes.length} 个概念`,
        );
      } catch (e) {
        showToast(
          `生成失败：${e instanceof Error ? e.message : "调用异常"}`,
          "err",
        );
      } finally {
        setChainGenerating(false);
      }
    },
    [
      collection,
      chainGenerating,
      currentGraphId,
      current,
      createGraph,
      updateGraph,
      pushHistory,
      showToast,
    ],
  );

  /* ---------- 重置视图 ---------- */
  const handleResetView = useCallback(() => {
    void fitView({ padding: 0.2, duration: 400 });
  }, [fitView]);

  /* ---------- 模板填充框：铺开当前模板（或指定模板）的脚手架 ---------- */
  const handleApplyScaffold = useCallback(
    (t: GraphTemplate) => {
      const { nodes: sn, edges: se } = buildTemplateScaffold(t);
      pushHistory();
      let targetId = currentGraphId;
      if (!targetId || !current) {
        targetId = createGraph(
          `${TEMPLATE_META[t].label} ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
          t,
        );
      }
      updateGraph(targetId, { nodes: sn, edges: se });
      setNodes(sn);
      setEdges(se);
      setConnectMode(null);
      setDetailNodeId(null);
      showToast(
        `已铺开「${TEMPLATE_META[t].label}」填充框：点击空框填写，或把收集区词条拖进框里`,
      );
      window.setTimeout(() => {
        void fitView({ padding: 0.25, duration: 400 });
      }, 80);
    },
    [
      currentGraphId,
      current,
      createGraph,
      updateGraph,
      pushHistory,
      showToast,
      fitView,
    ],
  );

  /* 派生：当前模板的配色/文案元数据（canvasTint 与头部徽标共用，须先声明） */
  const templateMeta = current ? TEMPLATE_META[current.template] : null;

  /** 画布底色：模板色极淡径向渐变（视觉重设计，pointer-events-none 不挡交互） */
  const canvasTint = templateMeta
    ? {
        background: `radial-gradient(1100px 520px at 50% -8%, ${templateMeta.dot}14, transparent 62%), radial-gradient(820px 460px at 88% 104%, ${templateMeta.dot}0c, transparent 58%)`,
      }
    : undefined;

  /* ---------- 拖词入画布：收集区 chip 拖到画布上 → 生成节点 ---------- */
  const handleCanvasDragOver = useCallback((e: React.DragEvent) => {
    console.log(
      "触发了拖拽悬停 dragover, types:",
      Array.from(e.dataTransfer.types),
    );
    // ⚠ 必须对目标 MIME preventDefault，否则浏览器判定「不可放置」，
    //   后续 drop 事件永远不会触发
    if (e.dataTransfer.types.includes(TERM_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleCanvasDrop = useCallback(
    (e: React.DragEvent) => {
      console.log("触发了拖拽放下 drop");
      const term = e.dataTransfer.getData(TERM_MIME);
      console.log("[GraphPage] drop 读到词条:", JSON.stringify(term));
      if (!term) return;
      e.preventDefault();
      // 屏幕坐标 → 画布流坐标（自动补偿平移/缩放），再按节点尺寸居中
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

      // 优先命中模板填充框：落在占位框包围盒内 → 填充该框（而非新建节点）
      const hit = nodes.find((n) => {
        const d = n.data as { placeholder?: boolean; label?: string };
        if (!d?.placeholder || d.label) return false;
        const w = n.measured?.width ?? 150;
        const h = n.measured?.height ?? 64;
        return (
          pos.x >= n.position.x &&
          pos.x <= n.position.x + w &&
          pos.y >= n.position.y &&
          pos.y <= n.position.y + h
        );
      });
      if (hit) {
        pushHistory();
        const slot = String(
          (hit.data as { slot?: string }).slot ?? "填充框",
        );
        setNodes((ns) =>
          ns.map((n) =>
            n.id === hit.id
              ? { ...n, data: { ...n.data, label: term, placeholder: false } }
              : n,
          ),
        );
        showToast(`已把「${term}」填入「${slot}」`);
        return;
      }

      console.log(
        `[GraphPage] drop 屏幕坐标(${e.clientX}, ${e.clientY}) → 流坐标(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`,
      );
      pushHistory();
      const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setNodes((ns) => [
        ...ns,
        {
          id,
          type: "concept",
          position: { x: pos.x - 80, y: pos.y - 20 },
          data: { label: term, template: current?.template ?? "free" },
        } as FlowNode,
      ]);
      showToast(`已把「${term}」加入画布`);
    },
    [screenToFlowPosition, nodes, current, pushHistory, showToast],
  );

  /* ---------- 点击收集区词条 → 直接生成节点（拖拽的替代路径） ---------- */
  const handleChipClick = useCallback(
    (term: string) => {
      if (!term || term === FULL_CONTEXT_TERM) return; // 全文词条不入图
      pushHistory();
      // 落点 = 当前视口中心（反推流坐标），轻随机散布避免完全重叠
      const el = canvasWrapRef.current;
      const rect = el?.getBoundingClientRect();
      const vp = getViewport();
      const cx = rect ? rect.width / 2 : 300;
      const cy = rect ? rect.height / 2 : 200;
      const pos = {
        x: (cx - vp.x) / vp.zoom + (Math.random() * 80 - 40),
        y: (cy - vp.y) / vp.zoom + (Math.random() * 60 - 30),
      };
      const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setNodes((ns) => [
        ...ns,
        {
          id,
          type: "concept",
          position: { x: pos.x - 80, y: pos.y - 20 },
          data: { label: term, template: current?.template ?? "free" },
        } as FlowNode,
      ]);
      showToast(`已把「${term}」加入画布`);
    },
    [getViewport, current, pushHistory, showToast],
  );

  /* ---------- 应用内快捷键（学习效率导向；设置页可查键位） ----------
     N 新增词汇框 · B 纸张边框 · Q AI 追问区 · E 导出 · T 质量测验 · Esc 退出连线模式 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case "n":
          addBlankNode();
          break;
        case "b":
          togglePaperFrame();
          break;
        case "q":
          setAiAskOpen((v) => !v);
          break;
        case "e":
          setExportOpen(true);
          break;
        case "t":
          setQuizOpen(true);
          break;
        case "escape":
          if (connectMode) {
            setConnectMode(null);
            showToast("已退出连线模式");
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addBlankNode, togglePaperFrame, connectMode, showToast]);


  /* ---------- 派生 UI 状态 ---------- */
  const hasGraph = nodes.length > 0;
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const summaryText = current?.summary ?? "";
  /** 超过 300 字 → 提供展开/收起 */
  const summaryLong = summaryText.length > 300;
  /** 深度解析浮窗的当前词条 */
  const detailTerm = detailNodeId
    ? String(nodes.find((n) => n.id === detailNodeId)?.data.label ?? "")
    : "";

  return (
    <section className="flex h-full gap-4">
      {/* ---------- 左侧：图谱列表侧边栏 ---------- */}
      <GraphSidebar
        graphs={graphs}
        currentGraphId={currentGraphId}
        onSelect={setCurrentGraph}
        onDelete={deleteGraph}
        onCreate={() => setCreateOpen(true)}
      />

      {/* ---------- 右侧：当前图谱工作区（relative 供收集区抽屉定位） ---------- */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 页头 */}
        <header className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <span className="truncate">
                {current?.name ?? "概念可视化图谱"}
              </span>
              {templateMeta && (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-normal"
                  style={{
                    background: `${templateMeta.dot}1f`,
                    color: templateMeta.dot,
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: templateMeta.dot }}
                    aria-hidden
                  />
                  {templateMeta.label}
                </span>
              )}
            </h1>
            {current && hasGraph ? (
              <p className="mt-2 text-xs text-muted-foreground">
                <span className="rounded bg-muted px-2 py-0.5">
                  {nodes.length} 节点 · {edges.length} 关系
                </span>
                <span className="ml-2 text-muted-foreground/70">
                  单击节点看深度解析 · 点两下生成关系 · 拖边缘自由连线 ·
                  顶部选连线形态 · 双击边切换形态 · Delete 删除 ·
                  拖节点回收集区还原词条
                </span>
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                {current
                  ? "等待浏览器扩展推送概念，或在收集区一键生成逻辑链、分析全文。"
                  : "创建或选择一个图谱开始工作。"}
              </p>
            )}
          </div>

          {hasGraph && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={handleResetView}
            >
              <RotateCcw className="h-4 w-4" />
              重置视图
            </Button>
          )}
        </header>

        {/* 图区 / 空状态。
            onDragOver / onDrop 挂在这一层：React Flow 的 pane 不处理
            HTML5 DnD，事件会冒泡到这里；dragover 必须 preventDefault 才能放下 */}
        {current ? (
          <div
            ref={canvasWrapRef}
            className="relative flex-1 overflow-hidden rounded-lg border border-border bg-card"
            onDragOver={handleCanvasDragOver}
            onDrop={handleCanvasDrop}
          >
            {/* 模板色氛围渐变（视觉重设计：让画布不再是纯白/纯黑死板底色） */}
            {canvasTint && (
              <div
                className="pointer-events-none absolute inset-0 z-0"
                style={canvasTint}
                aria-hidden
              />
            )}
            <ReactFlow
              nodes={nodes.map((n) =>
                n.type === "concept"
                  ? {
                      ...n,
                      data: {
                        ...n.data,
                        _actions: toolbarActions,
                        _connectActive:
                          connectMode?.sourceId === n.id && !connectMode.ai,
                        _aiConnectActive:
                          connectMode?.sourceId === n.id && connectMode.ai,
                        hideKindBadge: !showKindBadge,
                      },
                    }
                  : n,
              )}
              edges={
                // 渲染时统一注入：动态特效开关（设置页）+ 折线圆弧半径（全局生效）
                edges.map((e) => ({
                  ...e,
                  animated: edgeAnimated,
                  data: { ...e.data, cornerRadius: edgeCornerRadius },
                }))
              }
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onEdgeDoubleClick={onEdgeDoubleClick}
              onNodeContextMenu={onNodeContextMenu}
              deleteKeyCode={null} // 删除由本组件接管（纳入撤销历史）
              nodesConnectable={false} // Handle 仅作边锚点，拖线禁用（连线走工具栏拉线模式）
              fitView
              minZoom={0.2}
              onlyRenderVisibleElements
              defaultEdgeOptions={{
                type: "relation",
                animated: edgeAnimated,
              }}
            >
              {canvasDots && (
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={18}
                  color="#8497ab"
                />
              )}

              {/* 左上角：撤销 / 重做 */}
              <div className="absolute left-4 top-4 z-10 flex gap-1 rounded-lg border border-border/80 bg-[rgba(20,20,30,0.85)] p-1 shadow-lg backdrop-blur">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-300 hover:bg-white/10 hover:text-white"
                  title="撤销"
                  disabled={!past.length}
                  onClick={undo}
                >
                  <Undo2 className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-300 hover:bg-white/10 hover:text-white"
                  title="重做"
                  disabled={!future.length}
                  onClick={redo}
                >
                  <Redo2 className="h-4 w-4" />
                </Button>
              </div>

              {/* 顶部居中：连线形态工具条（新连线默认形态；双击已有边循环切换） */}
              <div
                className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 gap-0.5 rounded-lg border border-border/80 bg-[rgba(20,20,30,0.85)] p-1 shadow-lg backdrop-blur"
                role="radiogroup"
                aria-label="连线形态"
              >
                {(
                  Object.keys(EDGE_STYLE_META) as EdgeLineStyle[]
                ).map((k) => {
                  const meta = EDGE_STYLE_META[k];
                  const active = edgeLineStyle === k;
                  return (
                    <Button
                      key={k}
                      variant="ghost"
                      size="sm"
                      title={`${meta.label}：${meta.desc}`}
                      className={`h-7 gap-1 px-2.5 text-xs ${
                        active
                          ? "bg-sky-500/25 text-sky-200"
                          : "text-slate-400 hover:bg-white/10 hover:text-slate-200"
                      }`}
                      onClick={() => setEdgeLineStyle(k)}
                    >
                      {k === "orthogonal" && <Route className="h-3.5 w-3.5" />}
                      {k === "smooth" && <Spline className="h-3.5 w-3.5" />}
                      {k === "straight" && <Minus className="h-3.5 w-3.5" />}
                      {k === "sketch" && (
                        <PencilLine className="h-3.5 w-3.5" />
                      )}
                      {meta.label}
                    </Button>
                  );
                })}
              </div>

              {/* 功能工具条：新增词汇框 / 纸张边框 / AI 追问 / 导出 / 测评（快捷键 N/B/Q/E/T） */}
              <div className="absolute left-1/2 top-14 z-10 flex -translate-x-1/2 gap-0.5 rounded-lg border border-border/80 bg-[rgba(20,20,30,0.85)] p-1 shadow-lg backdrop-blur">
                {(
                  [
                    {
                      key: "add",
                      icon: FilePlus2,
                      label: "词汇框",
                      title: "新增空白词汇框（N）——点击填写或拖词填充",
                      onClick: addBlankNode,
                      active: false,
                    },
                    {
                      key: "paper",
                      icon: Frame,
                      label: "纸张",
                      title: "加入/删除纸张边框（B）——按现有图谱自适应，导出按边框裁剪",
                      onClick: togglePaperFrame,
                      active: nodes.some((n) => n.type === "paperFrame"),
                    },
                    {
                      key: "ask",
                      icon: MessageCircleQuestion,
                      label: "AI 追问",
                      title: "AI 追问区（Q）：导入提问模板引导发散提问，或自由输入",
                      onClick: () => setAiAskOpen((v) => !v),
                      active: aiAskOpen,
                    },
                    {
                      key: "export",
                      icon: Download,
                      label: "导出",
                      title: "导出图谱（E）：JSON / Markdown / HTML / PNG / PDF（docx 待后端）",
                      onClick: () => setExportOpen(true),
                      active: false,
                    },
                    {
                      key: "quiz",
                      icon: ClipboardCheck,
                      label: "测验",
                      title: "图谱质量测验（T）：投喂模型检验可读性，记录评分与用时",
                      onClick: () => setQuizOpen(true),
                      active: false,
                    },
                  ] as const
                ).map((b) => (
                  <Button
                    key={b.key}
                    variant="ghost"
                    size="sm"
                    title={b.title}
                    className={`h-7 gap-1 px-2.5 text-xs ${
                      b.active
                        ? "bg-emerald-500/25 text-emerald-200"
                        : "text-slate-400 hover:bg-white/10 hover:text-slate-200"
                    }`}
                    onClick={b.onClick}
                  >
                    <b.icon className="h-3.5 w-3.5" />
                    {b.label}
                  </Button>
                ))}
              </div>

              {/* 自绘极简缩放控制条（替代默认 Controls） */}
              <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-1 rounded-lg border border-border/80 bg-[rgba(20,20,30,0.85)] p-1 shadow-lg backdrop-blur">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-300 hover:bg-white/10 hover:text-white"
                  title="放大"
                  onClick={() => void zoomIn({ duration: 200 })}
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-300 hover:bg-white/10 hover:text-white"
                  title="缩小"
                  onClick={() => void zoomOut({ duration: 200 })}
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-slate-300 hover:bg-white/10 hover:text-white"
                  title="适应画布"
                  onClick={handleResetView}
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              </div>

              {/* 暗色透明 MiniMap（个性化设置可关闭） */}
              {showMiniMap && (
                <MiniMap
                pannable
                zoomable
                style={{
                  background: "rgba(20, 20, 30, 0.8)",
                  borderRadius: 12,
                  border: "1px solid rgba(148, 163, 184, 0.25)",
                  width: 180,
                  height: 120,
                }}
                nodeColor={(node) =>
                  templateMinimapColor(
                    (node.data as { template?: GraphTemplate })?.template ??
                      current.template,
                  )
                }
                nodeStrokeColor="transparent"
                maskColor="rgba(2, 6, 23, 0.6)"
                className="!bottom-3 !right-3"
              />
              )}
            </ReactFlow>

            {/* AI 追问区（可拖拽浮窗；模板导入 + 自由提问） */}
            {aiAskOpen && (
              <AiAskPanel
                onClose={() => setAiAskOpen(false)}
                currentTerm={detailTerm || ""}
                contextText={resolveContextText().slice(0, 8000)}
                graphOverview={graphOverview}
              />
            )}

            {/* 图谱质量测验（评分 + 用时 + 历史记录） */}
            {quizOpen && (
              <QuizDialog
                open={quizOpen}
                onClose={() => setQuizOpen(false)}
                nodes={nodes}
                edges={edges}
                title={current?.name ?? "未命名图谱"}
              />
            )}

            {/* AI 总结面板被 X 关闭后：角落小入口可重新打开 */}
            {summaryPanelClosed && (
              <button
                type="button"
                onClick={() => setSummaryPanelClosed(false)}
                className="
                  absolute right-3 top-3 z-10 flex cursor-pointer items-center gap-1.5
                  rounded-full border border-violet-400/40 bg-[rgba(20,20,30,0.88)]
                  px-3 py-1.5 text-xs font-medium text-violet-200 shadow-lg backdrop-blur
                  transition-all duration-150 hover:border-violet-300 hover:text-violet-100
                  animate-in fade-in zoom-in-95 fill-mode-both duration-200
                "
                title="重新打开 AI 逻辑梳理总结"
              >
                <Sparkles className="h-3.5 w-3.5" />
                AI 总结
              </button>
            )}

            {/* AI 逻辑梳理总结：可拖拽浮窗（右上角起始；折叠按钮在头部） */}
            {!summaryPanelClosed && (
              <FloatingPanel
                title="AI 逻辑梳理总结"
                icon={<Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-300" />}
                positionClass="right-3 top-3"
                accentClass="border-violet-400/30"
                onClose={() => {
                  console.log("[FloatingPanel] 关闭 AI 总结面板");
                  setSummaryPanelClosed(true);
                }}
                headerExtra={
                  <button
                    type="button"
                    onClick={() => setSummaryOpen((v) => !v)}
                    className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                    title={summaryOpen ? "折叠内容" : "展开内容"}
                    aria-expanded={summaryOpen}
                  >
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform duration-200 ${
                        summaryOpen ? "" : "-rotate-90"
                      }`}
                    />
                  </button>
                }
              >
                {summaryOpen && (
                  <div className="animate-in fade-in slide-in-from-top-1 fill-mode-both duration-200 max-h-64 overflow-y-auto px-4 py-3">
                    {summaryText ? (
                      <>
                        <p
                          className={`whitespace-pre-wrap text-sm leading-relaxed text-slate-200 ${
                            summaryLong && !summaryExpanded
                              ? "line-clamp-5"
                              : ""
                          }`}
                        >
                          {summaryText}
                        </p>
                        {summaryLong && (
                          <button
                            type="button"
                            onClick={() => {
                              console.log(
                                "[GraphPage] 总结展开/收起切换 →",
                                !summaryExpanded,
                              );
                              setSummaryExpanded((v) => !v);
                            }}
                            className="mt-2 cursor-pointer text-xs font-medium text-violet-300 transition-colors duration-150 hover:text-violet-200"
                          >
                            {summaryExpanded
                              ? "收起"
                              : `展开全文（${summaryText.length} 字）`}
                          </button>
                        )}
                      </>
                    ) : (
                      <p className="text-xs leading-relaxed text-slate-500">
                        「一键生成逻辑链」或「分析全文」后，模型对内容逻辑的总结会显示在这里。
                      </p>
                    )}
                  </div>
                )}
              </FloatingPanel>
            )}

            {/* 全文分析结果：可拖拽浮窗（主旨 + 骨架 + 总结 + 保存状态） */}
            {fullResult && (
              <FloatingPanel
                title={fullResult.title || "全文分析"}
                icon={
                  <ScanSearch className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                }
                positionClass="left-[calc(50%-170px)] top-6"
                widthClass="w-[340px]"
                accentClass="border-emerald-400/30"
                onClose={() => {
                  console.log("[FloatingPanel] 关闭全文分析结果窗口");
                  setFullResult(null);
                }}
              >
                <div className="max-h-[380px] overflow-y-auto px-4 py-3">
                  {/* 主旨 */}
                  <p className="text-[13px] leading-relaxed text-emerald-200">
                    {fullResult.thesis}
                  </p>

                  {/* 骨架 outline */}
                  {fullResult.outline.length > 0 && (
                    <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
                      <p className="text-[11px] font-medium text-slate-400">
                        全文骨架（{fullResult.outline.length} 段）
                      </p>
                      {fullResult.outline.map((item, i) => (
                        <div key={i} className="flex gap-2">
                          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-[10px] font-semibold text-emerald-300">
                            {i + 1}
                          </span>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-slate-200">
                              {item.heading}
                            </p>
                            {item.detail && (
                              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
                                {item.detail}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 详细总结 */}
                  <div className="mt-3 border-t border-white/5 pt-3">
                    <p className="text-[11px] font-medium text-slate-400">
                      详细总结（{fullResult.summary.length} 字）
                    </p>
                    <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-[13px] leading-7 text-slate-200">
                      {fullResult.summary}
                    </p>
                  </div>

                  {/* 元信息 + 保存状态 */}
                  <div className="mt-3 flex items-center gap-2 border-t border-white/5 pt-2.5 text-[10px] text-slate-500">
                    <span>送入 {fullResult.contextChars} 字</span>
                    <span>·</span>
                    <span className="truncate font-mono">{fullResult.model}</span>
                    <span className="flex-1" />
                    {fullSaved ? (
                      <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-emerald-300">
                        已保存项目
                      </span>
                    ) : (
                      <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-300">
                        未落盘
                      </span>
                    )}
                  </div>
                </div>
              </FloatingPanel>
            )}

            {/* 逻辑链生成结果：可拖拽浮窗（链路序列 + 总结） */}
            {chainResult && (
              <FloatingPanel
                title="逻辑链生成结果"
                icon={
                  <Workflow className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                }
                positionClass="left-[calc(50%-170px)] top-6"
                widthClass="w-[340px]"
                accentClass="border-sky-400/30"
                onClose={() => {
                  console.log("[FloatingPanel] 关闭逻辑链结果窗口");
                  setChainResult(null);
                }}
              >
                <div className="max-h-[320px] overflow-y-auto px-4 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {chainResult.labels.map((label, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        {i > 0 && (
                          <CornerDownRight className="h-3 w-3 shrink-0 text-sky-400/60" />
                        )}
                        <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-xs text-sky-100">
                          {label}
                        </span>
                      </span>
                    ))}
                  </div>
                  {chainResult.summary && (
                    <p className="mt-3 whitespace-pre-wrap border-t border-white/5 pt-2.5 text-[13px] leading-relaxed text-slate-200">
                      {chainResult.summary}
                    </p>
                  )}
                </div>
              </FloatingPanel>
            )}

            {/* 节点深度解析浮窗（左上，撤销/重做条下方；可拖拽） */}
            {detailNodeId && detailTerm && (
              <FloatingPanel
                title={detailTerm}
                icon={
                  <BookOpen className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                }
                positionClass="left-4 top-16"
                accentClass="border-border"
                onClose={() => {
                  console.log("[FloatingPanel] 关闭节点深度解析浮窗");
                  setDetailNodeId(null);
                }}
              >
                <div className="max-h-[320px] overflow-y-auto px-3.5 py-3">
                  {detail.loading ? (
                    <div className="flex items-center gap-2 py-4 text-xs text-slate-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-300" />
                      正在解析「{detailTerm}」…
                    </div>
                  ) : detail.error ? (
                    <div className="py-1">
                      <p className="text-xs leading-relaxed text-red-300">
                        {detail.error}
                      </p>
                      <button
                        type="button"
                        onClick={() => setDetailNonce((n) => n + 1)}
                        className="mt-2 inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-sky-300 transition-colors hover:text-sky-200"
                      >
                        <RefreshCw className="h-3 w-3" />
                        重试
                      </button>
                    </div>
                  ) : detail.data ? (
                    <div className="space-y-2.5">
                      {detail.data.role && (
                        <p className="inline-block rounded bg-sky-400/10 px-2 py-0.5 text-[11px] text-sky-300">
                          {detail.data.role}
                        </p>
                      )}
                      <p className="whitespace-pre-wrap text-[13px] leading-7 text-slate-200">
                        {detail.data.analysis}
                      </p>
                      {detail.data.relations.length > 0 && (
                        <div className="space-y-1 border-t border-white/5 pt-2.5">
                          <p className="text-[11px] font-medium text-slate-400">
                            与其他概念的关联
                          </p>
                          {detail.data.relations.map((rel, i) => (
                            <p
                              key={i}
                              className="flex gap-1.5 text-xs leading-relaxed text-slate-300"
                            >
                              <CornerDownRight className="mt-0.5 h-3 w-3 shrink-0 text-sky-400/70" />
                              {rel}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </FloatingPanel>
            )}

            {/* 图区为空 → 等待推送占位（浮在 React Flow 上方，pointer-events-none 不挡拖放/点击） */}
            {!hasGraph && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both rounded-lg border border-dashed border-border bg-card/80 p-14 text-center backdrop-blur">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
                    <span className="relative flex h-3 w-3">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-sky-400" />
                    </span>
                  </div>
                  <p className="mt-4 text-sm font-medium text-foreground">
                    等待浏览器插件推送数据...
                  </p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    在网页中划词点「加入图谱」，词条会实时进入右侧收集区，
                    也可以把词条直接拖进画布； 或在收集区一键生成逻辑链 / 分析全文
                  </p>
                  <p className="mt-3 font-mono text-[11px] text-muted-foreground/60">
                    POST http://127.0.0.1:17570/api/add-to-graph
                  </p>

                  {/* 模板填充框快铺：三种图谱模板一键铺开（可点击填写的空框，非图片） */}
                  <div className="pointer-events-auto mt-5 flex items-center justify-center gap-2">
                    {(["free", "tree", "chain", "flow", "venn"] as GraphTemplate[]).map((t) => (
                      <Button
                        key={t}
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 px-3 text-xs"
                        title={`铺开「${TEMPLATE_META[t].label}」模板的可填充概念框`}
                        onClick={() => handleApplyScaffold(t)}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: TEMPLATE_META[t].dot }}
                          aria-hidden
                        />
                        {TEMPLATE_META[t].label}
                      </Button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10px] text-muted-foreground/50">
                    铺开可填充概念框：点击空框输入，或把收集区词条拖进框里
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* 尚无任何图谱 → 引导创建 */
          <div className="flex flex-1 items-center justify-center">
            <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both rounded-lg border border-dashed border-border p-14 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
                <Network className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">
                还没有图谱
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                新建一个图谱，扩展推送的概念会自动写入当前图谱
              </p>
              <Button
                size="sm"
                className="mt-4 gap-1.5"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="h-4 w-4" />
                新建图谱
              </Button>
            </div>
          </div>
        )}

        {/* ---------- 收集区：右侧大抽屉（≥1/3 屏宽） ---------- */}
        {drawerOpen ? (
          <aside
            data-collection-drawer
            aria-label="收集区"
            className={`
              absolute inset-y-0 right-0 z-30 flex w-[42%] min-w-[360px] max-w-[560px]
              flex-col border-l bg-card shadow-2xl
              animate-in fade-in slide-in-from-right-6 fill-mode-both duration-300
              transition-colors duration-150
              ${
                nodeOverDrawer
                  ? "border-sky-400 ring-2 ring-inset ring-sky-400/40"
                  : "border-border"
              }
            `}
          >
            {/* 抽屉头：标题 + 计数 + 分析全文 + 收起 */}
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
              <Inbox className="h-4 w-4 shrink-0 text-sky-400" />
              <h2 className="text-sm font-semibold text-foreground">收集区</h2>
              <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[11px] text-sky-300">
                {stagedWords.length} 个待处理词汇
              </span>
              {hasFullContext && (
                <span
                  className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-300"
                  title={`全文快照就绪（${fullContextChars} 字），可点击「分析全文」`}
                >
                  全文就绪 · {fullContextChars} 字
                </span>
              )}
              <span className="flex-1" />
              {/* 批量学习模式开关（v10）：开启后插件划词即自动静默入暂存 */}
              <Button
                size="sm"
                variant="outline"
                className={`h-7 gap-1.5 px-3 text-xs ${
                  batchMode
                    ? "border-amber-400/50 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                    : "border-border text-muted-foreground"
                }`}
                onClick={() => void handleToggleBatchMode()}
                title={
                  batchMode
                    ? "批量模式开启中：浏览器里划词即自动收集（800ms 防抖合并）。点击关闭"
                    : "开启批量模式：浏览器里划词即自动收集，无需点任何按钮"
                }
              >
                <Zap className="h-3.5 w-3.5" />
                批量模式{batchMode ? " · 开" : ""}
              </Button>
              {/* 分析全文：全文快照就绪时可用 */}
              <Button
                size="sm"
                className="h-7 gap-1.5 border-emerald-400/40 bg-emerald-500/15 px-3 text-xs text-emerald-200 hover:bg-emerald-500/25"
                variant="outline"
                disabled={!hasFullContext || fullAnalyzing}
                onClick={() => void handleAnalyzeFullContext()}
                title={
                  hasFullContext
                    ? `把 ${fullContextChars} 字全文交给模型：产出骨架 + 图谱 + 详细总结，并保存项目`
                    : "等待插件推送全文快照后可用（插件端「抓取全文」）"
                }
              >
                {fullAnalyzing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    分析中…
                  </>
                ) : (
                  <>
                    <ScanSearch className="h-3.5 w-3.5" />
                    分析全文
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                title="收起抽屉"
                onClick={() => setDrawerOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* 词条滚动区：纵向滚动容纳大量划词；chip 悬浮出现 X 单删；chip 可拖入画布 */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {stagedWords.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <Inbox className="h-8 w-8 text-muted-foreground/40" />
                  <p className="mt-3 text-xs text-muted-foreground/70">
                    暂无待处理词汇
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground/50">
                    在网页中划词，点「加入图谱」后会实时出现在这里
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {stagedWords.map((w, i) => (
                    <span
                      key={`${w.addedAt ?? "t"}-${i}-${w.term}`}
                      draggable
                      onDragStart={(e) => {
                        // 拖词入画布：写入自定义 MIME，画布 onDrop 据此生成节点。
                        // text/plain 作为兜底（部分 WebView 只认标准 MIME 才启动拖拽）
                        e.dataTransfer.setData(TERM_MIME, w.term);
                        e.dataTransfer.setData("text/plain", w.term);
                        e.dataTransfer.effectAllowed = "copy";
                        console.log(
                          "[GraphPage] 开始拖拽词条:",
                          w.term,
                          "types:",
                          Array.from(e.dataTransfer.types),
                        );
                      }}
                      onClick={() => handleChipClick(w.term)}
                      title={[
                        w.term === FULL_CONTEXT_TERM
                          ? "全文上下文词条（供「分析全文」使用）"
                          : `${w.contextText ?? ""}\n点击加入图谱，或拖入画布`,
                        w.pageTitle ? `来源：${w.pageTitle}` : "",
                      ]
                        .filter(Boolean)
                        .join("\n")}
                      className={`
                        group inline-flex cursor-grab select-none items-center gap-1 rounded-full
                        py-1 pl-3 pr-1.5 text-xs transition-colors duration-150
                        animate-in fade-in zoom-in-95 fill-mode-both duration-200
                        active:cursor-grabbing
                        ${
                          w.term === FULL_CONTEXT_TERM
                            ? "border border-emerald-400/40 bg-emerald-400/10 text-emerald-100 hover:border-emerald-300/60"
                            : "border border-sky-400/30 bg-sky-400/10 text-sky-100 hover:border-sky-300/60"
                        }
                      `}
                      style={{ animationDelay: `${Math.min(i, 14) * 40}ms` }}
                    >
                      {w.term === FULL_CONTEXT_TERM ? "全文上下文" : w.term}
                      <button
                        type="button"
                        title={`删除「${w.term === FULL_CONTEXT_TERM ? "全文上下文" : w.term}」`}
                        onClick={(e) => {
                          e.stopPropagation(); // 不触发 chip 的「加入图谱」
                          void handleRemoveStaged(w.term);
                        }}
                        className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-full text-sky-300/50 transition-all duration-150 hover:bg-red-500/20 hover:text-red-300"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 抽屉底栏：清空收集区 + 一键生成逻辑链 */}
            <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-4 py-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-3 text-xs text-muted-foreground hover:text-destructive"
                disabled={stagedWords.length === 0}
                onClick={() => void handleClearStaged()}
                title="同步清空后端暂存区与本面板全部词汇"
              >
                <Trash2 className="h-3.5 w-3.5" />
                清空收集区
              </Button>
              <span className="flex-1" />
              {/* 工业流程图：同一条链路，按流程框图符号渲染（学习工业流程图样式） */}
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 border-orange-400/40 bg-orange-500/10 px-3 text-xs text-orange-200 hover:bg-orange-500/20"
                disabled={collection.length < 2 || chainGenerating}
                onClick={() => void handleGenerateChain("flow")}
                title={
                  collection.length < 2
                    ? "至少需要 2 个词汇"
                    : "把收集区词汇交给模型排成工业流程图（起止胶囊 + 工序矩形 + 直线箭头）"
                }
              >
                {chainGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <GitBranch className="h-3.5 w-3.5" />
                )}
                生成流程图
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5 px-4 text-xs"
                disabled={collection.length < 2 || chainGenerating}
                onClick={() => void handleGenerateChain("chain")}
                title={
                  collection.length < 2
                    ? "至少需要 2 个词汇"
                    : "把收集区词汇交给模型排成逻辑链"
                }
              >
                {chainGenerating ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    生成中…
                  </>
                ) : (
                  <>
                    <Workflow className="h-3.5 w-3.5" />
                    一键生成逻辑链
                  </>
                )}
              </Button>
            </div>
          </aside>
        ) : (
          /* 收起态：右缘竖排入口，常驻可见 + 词数角标 */
          <button
            type="button"
            onClick={() => {
              setDrawerOpen(true);
              setWordLibraryOpen(false); // 两个右侧面板互斥
            }}
            className="absolute right-0 top-1/2 z-20 flex -translate-y-1/2 cursor-pointer flex-col items-center gap-1.5 rounded-l-lg border border-r-0 border-border bg-card px-1.5 py-4 text-muted-foreground shadow-lg transition-all duration-150 hover:px-2.5 hover:text-foreground"
            title="打开收集区（划词缓存）"
          >
            <Inbox className="h-4 w-4" />
            <span
              className="text-xs font-medium"
              style={{ writingMode: "vertical-rl" }}
            >
              收集区
            </span>
            {stagedWords.length > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-semibold text-white">
                {stagedWords.length > 99 ? "99+" : stagedWords.length}
              </span>
            )}
          </button>
        )}

        {/* ---------- 词库收纳区入口（第三区域，与收集区互斥） ---------- */}
        {!wordLibraryOpen && (
          <button
            type="button"
            onClick={() => {
              setWordLibraryOpen(true);
              setDrawerOpen(false);
            }}
            className="absolute right-0 top-[62%] z-20 flex -translate-y-1/2 cursor-pointer flex-col items-center gap-1.5 rounded-l-lg border border-r-0 border-border bg-card px-1.5 py-4 text-muted-foreground shadow-lg transition-all duration-150 hover:px-2.5 hover:text-foreground"
            title="打开词库收纳区（分门别类收藏概念词）"
          >
            <Library className="h-4 w-4" />
            <span
              className="text-xs font-medium"
              style={{ writingMode: "vertical-rl" }}
            >
              词库
            </span>
          </button>
        )}
      </div>

      {/* ---------- 导出对话框 ---------- */}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        buildProject={buildExportProject}
        nodes={nodes}
        edges={edges}
        title={current?.name ?? "未命名图谱"}
        paperBounds={paperBounds}
        hasPaper={Boolean(paperBounds)}
      />

      {/* ---------- 词库收纳区（第三区域） ---------- */}
      <WordLibraryPanel
        open={wordLibraryOpen}
        onClose={() => setWordLibraryOpen(false)}
        onLocate={handleLibraryClick}
      />

      {/* ---------- 节点右键菜单 ---------- */}
      {ctxMenu &&
        (() => {
          const node = nodes.find((n) => n.id === ctxMenu.nodeId);
          if (!node) return null;
          const d = node.data as ConceptNodeData;
          return (
            <NodeContextMenu
              x={ctxMenu.x}
              y={ctxMenu.y}
              label={String(d.label ?? "")}
              currentIcon={d.icon}
              currentShape={d.shape}
              currentColor={d.colorOverride}
              currentSize={d.sizeScale}
              currentKind={d.kind}
              onClose={() => setCtxMenu(null)}
              onDelete={handleCtxDelete}
              onSetIcon={(icon) => patchNodeData(node.id, { icon })}
              onSetShape={(shape) => patchNodeData(node.id, { shape })}
              onSetColor={(color) =>
                patchNodeData(node.id, { colorOverride: color })
              }
              onSetSize={(size) => patchNodeData(node.id, { sizeScale: size })}
              onSetKind={handleCtxSetKind}
              onExplain={handleCtxExplain}
              onAnalyzeContext={handleCtxAnalyzeContext}
            />
          );
        })()}

      {/* ---------- 新建图谱弹窗 ---------- */}
      <CreateGraphDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultTemplate={defaultTemplate}
        onCreate={(name, template) => {
          // 新建即铺开该模板的可填充概念框（可经设置关闭）
          const id = createGraph(name, template);
          if (autoScaffold) {
            const { nodes: sn, edges: se } = buildTemplateScaffold(template);
            updateGraph(id, { nodes: sn, edges: se });
            showToast(
              `已创建「${name}」：铺开了「${TEMPLATE_META[template].label}」填充框，点击空框即可填写`,
            );
          } else {
            showToast(`已创建「${name}」`);
          }
        }}
      />

      {/* ---------- 内部 toast ---------- */}
      {toast && (
        <div
          className={`
            fixed bottom-6 left-1/2 z-50 -translate-x-1/2
            rounded-lg px-4 py-2 text-sm shadow-lg
            animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-300
            ${
              toast.tone === "ok"
                ? "bg-emerald-500/90 text-emerald-50"
                : "bg-red-500/90 text-red-50"
            }
          `}
          role="status"
        >
          {toast.msg}
        </div>
      )}
    </section>
  );
}
