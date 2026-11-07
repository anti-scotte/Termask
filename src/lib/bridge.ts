// src/lib/bridge.ts 新增导出

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ModelProviderConfig,
  ConceptGraphPayload,
  StagedWord,
  GenerateGraphPayload,
  GraphProject,
  FullContextAnalysis,
  ConceptAnalysis,
  LlmConfig,
  Granularity,
  AuthSession,
  RegisterPayload,
  SendCodeResult,
  WhiteboardProject,
  WhiteboardAnnotation,
} from "@/types";

/** Tauri Command 请求负载 */
export interface TestConnectionPayload {
  kind: ModelProviderConfig["kind"];
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Tauri Command 返回 */
export interface TestConnectionResult {
  success: boolean;
  latencyMs: number;
  modelEcho?: string;
  error?: string;
}

/**
 * 测试模型连接 — 调用 Rust Tauri command `test_model_connection`
 *
 * Rust 侧根据 kind 路由到不同的探测逻辑：
 * - openai-compatible: GET {baseUrl}/models（或 POST /chat/completions 发一条空消息）
 * - anthropic: POST {baseUrl}/v1/messages 发一条最小请求
 * - ollama: GET {baseUrl}/api/tags
 */
export async function testModelConnection(
  payload: TestConnectionPayload,
): Promise<TestConnectionResult> {
  return invoke<TestConnectionResult>("test_model_connection", { payload });
}
// 监听来自 Rust 后端的 concept-graph 事件
export function listenConceptGraph(
  callback: (data: ConceptGraphPayload) => void,
) {
  return listen("concept-graph", (event) => {
    callback(event.payload as ConceptGraphPayload);
  });
}

/** generate_relation 请求负载 */
export interface GenerateRelationPayload {
  baseUrl: string;
  apiKey: string;
  model: string;
  nodeA: string;
  nodeB: string;
  /** 原文语境（可选，帮助消歧） */
  context?: string;
}

/** generate_relation 返回 */
export interface GenerateRelationResult {
  success: boolean;
  /** 关系词（2-8 字中文，如「包含」「因果关系」） */
  label?: string;
  /** 关系解释（约 30 字中文，说明为何存在该关系） */
  explanation?: string;
  error?: string;
}

/**
 * 分析两个概念间的关系 — 调用 Rust Tauri command `analyze_concepts_relationship`。
 * webview 直连模型 API 有 CORS 限制，统一由 Rust 代理请求。
 */
export async function analyzeConceptsRelationship(
  payload: GenerateRelationPayload,
): Promise<GenerateRelationResult> {
  return invoke<GenerateRelationResult>("analyze_concepts_relationship", {
    payload,
  });
}

/** generate_logic_chain 请求负载 */
export interface GenerateLogicChainPayload {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 收集区待排链的概念词 */
  words: string[];
}

/** generate_logic_chain 返回 */
export interface GenerateLogicChainResult {
  success: boolean;
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ source: string; target: string; label?: string }>;
  /** 模型对整条链路逻辑的一句话总结（AI 逻辑梳理总结面板展示） */
  summary?: string;
  error?: string;
}

/**
 * 一键生成逻辑链 — 调用 Rust Tauri command `generate_logic_chain`：
 * 把收集区词汇交给 LLM 排成一条逻辑链，返回节点与带关系词的边。
 */
export async function generateLogicChain(
  payload: GenerateLogicChainPayload,
): Promise<GenerateLogicChainResult> {
  return invoke<GenerateLogicChainResult>("generate_logic_chain", { payload });
}

/** 收集目标：概念图谱 / 白板收集区（与 Rust `Target` 对齐） */
export type StagingTarget = "graph" | "whiteboard";

/** 读取暂存区（target 缺省 graph） */
export async function getStagedWords(
  target: StagingTarget = "graph",
): Promise<StagedWord[]> {
  return invoke<StagedWord[]>("get_staged_words", { target });
}

/** 清空暂存区（target 缺省 graph） */
export async function clearStagedWords(
  target: StagingTarget = "graph",
): Promise<void> {
  return invoke<void>("clear_staged_words", { target });
}

/** 删除暂存区中指定词条（按 term 精确匹配，删除所有同名项），返回删除后的最新列表 */
export async function removeFromCache(
  term: string,
  target: StagingTarget = "graph",
): Promise<StagedWord[]> {
  return invoke<StagedWord[]>("remove_from_cache", { term, target });
}

/** 清空暂存区，返回清空后的最新列表（空列表），供前端直接刷新状态 */
export async function clearCache(
  target: StagingTarget = "graph",
): Promise<StagedWord[]> {
  return invoke<StagedWord[]>("clear_cache", { target });
}

/**
 * 读取暂存区词条数量。
 * 与插件轮询的 `GET /api/get-cache-count?target=` 同源，用于徽标与两端数字对账。
 */
export async function getCacheCount(
  target: StagingTarget = "graph",
): Promise<number> {
  return invoke<number>("get_cache_count", { target });
}

/* ------------------------------------------------------------------ *
 *  白板收集区（target="whiteboard"）—— 与图谱收集区物理隔离
 * ------------------------------------------------------------------ */

/** 读取白板收集区（插件 target=whiteboard 推送 + 白板页写入） */
export async function getWhiteboardWords(): Promise<StagedWord[]> {
  return invoke<StagedWord[]>("get_whiteboard_words");
}

/** 删除白板收集区指定词条，返回删除后的权威列表 */
export async function removeWhiteboardWord(
  term: string,
): Promise<StagedWord[]> {
  return invoke<StagedWord[]>("remove_whiteboard_word", { term });
}

/** 清空白板收集区，返回空列表 */
export async function clearWhiteboardWords(): Promise<StagedWord[]> {
  return invoke<StagedWord[]>("clear_whiteboard_words");
}

/**
 * 暂存区 + 长上下文 → LLM 生成图谱 → 落盘 → 返回完整项目。
 * 失败时 invoke 直接抛错（后端用 Err(String)），错误文案已含上游 HTTP 正文。
 */
export async function generateGraphFromCache(
  payload: GenerateGraphPayload,
): Promise<GraphProject> {
  return invoke<GraphProject>("generate_graph_from_cache", { payload });
}

/**
 * 全文深度分析：一次调用产出「骨架 outline + 图谱 nodes/edges + 详细总结」。
 * `granularity` 控制总结字数（low 120-200 / medium 200-400 / high 450-800），
 * 不传默认 medium。不落盘，需要保存时用 save_graph_project。
 */
export async function analyzeFullContext(
  contextText: string,
  provider: LlmConfig,
  granularity?: Granularity,
): Promise<FullContextAnalysis> {
  return invoke<FullContextAnalysis>("analyze_full_context", {
    contextText,
    provider,
    granularity,
  });
}

/**
 * 保存（覆盖写）一个图谱项目到本地磁盘（Rust 侧原子写：.tmp → rename）。
 * 全文分析完成后由前端显式调用，把 summary 与图谱结构持久化成 GraphProject。
 */
export async function saveGraphProject(project: GraphProject): Promise<void> {
  return invoke<void>("save_graph_project", { project });
}

/**
 * 单节点深度解析：解释该概念在当前上下文中的具体含义（约 150 字）。
 * 只送 8000 字上下文（后端截断），点击节点时可直接调用。
 */
export async function analyzeSingleConcept(
  concept: string,
  context: string,
  provider: LlmConfig,
): Promise<ConceptAnalysis> {
  return invoke<ConceptAnalysis>("analyze_single_concept", {
    concept,
    context,
    provider,
  });
}

/**
 * 删除暂存区中的单个词汇（收集区 chip 悬浮 X → 同步后端）。
 * 同词多次推入会被一并移除；返回实际删除的条数。
 */
export async function removeStagedWord(
  term: string,
  target: StagingTarget = "graph",
): Promise<number> {
  return invoke<number>("remove_staged_word", { term, target });
}

/**
 * 把词条放回暂存区（画布节点拖回收集区、白板「加入收集区」共用）。
 * 后端按 `word.target` 分发并广播对应事件，前端监听器自动追加，勿在本地重复添加。
 */
export async function stageWord(
  word: Partial<StagedWord> & { term: string },
): Promise<number> {
  return invoke<number>("stage_word", { word });
}

/** 监听插件推入新词条（Rust emit "staged-word" 事件） */
export function listenStagedWord(callback: (word: StagedWord) => void) {
  return listen("staged-word", (event) => {
    callback(event.payload as StagedWord);
  });
}

/**
 * 监听白板收集区新词条（Rust emit "whiteboard-word" 事件）。
 * 插件推送 target="whiteboard" 的划词 / 白板页 stageWord 写入时触发。
 */
export function listenWhiteboardWord(
  callback: (word: StagedWord) => void,
) {
  return listen("whiteboard-word", (event) => {
    callback(event.payload as StagedWord);
  });
}

/**
 * 读取「待分析的全文快照」单槽位（Rust `get_full_context` 命令）。
 * 插件以 term=__FULL_CONTEXT__ 推送全文后，后端写入该槽位（覆盖式），
 * 同时会把标记词同步进暂存区列表并广播 staged-word（驱动收集区 chip
 * 与「分析全文」按钮可用性），full-context 事件供新前端按需监听。
 * 无快照时返回 null。
 */
export async function getFullContext(): Promise<StagedWord | null> {
  return invoke<StagedWord | null>("get_full_context");
}

/** 监听全文快照就绪（Rust emit "full-context" 事件，payload 为整个 StagedWord） */
export function listenFullContext(
  callback: (word: StagedWord) => void,
) {
  return listen("full-context", (event) => {
    callback(event.payload as StagedWord);
  });
}

/**
 * 监听「远端删除了最后一个词」（插件 Ctrl+Shift+Z / POST /api/remove-last）。
 * 前端必须据此移除 chip，否则暂存区会「后端已删、界面还在」。
 */
export function listenStagedWordRemoved(
  callback: (word: StagedWord) => void,
) {
  return listen("staged-word-removed", (event) => {
    callback(event.payload as StagedWord);
  });
}

/** 监听全局快捷键唤起（Rust emit "trigger-shortcut"，payload `{shortcut}`） */
export function listenTriggerShortcut(
  callback: (payload: { shortcut: string }) => void,
) {
  return listen("trigger-shortcut", (event) => {
    callback(event.payload as { shortcut: string });
  });
}

/* ------------------------------------------------------------------ *
 *  桥接安全（设置页展示 / 开关 / 令牌轮换）
 * ------------------------------------------------------------------ */

export interface BridgeSecurityInfo {
  port: number;
  token: string;
  requireToken: boolean;
}

/**
 * 读取桥接安全信息。
 * 令牌只经 Tauri IPC 回给本应用前端（不走 HTTP），供用户复制到扩展配置页。
 */
export async function getBridgeSecurity(): Promise<BridgeSecurityInfo> {
  return invoke<BridgeSecurityInfo>("get_bridge_security");
}

/** 开启/关闭「桥接要求令牌」；开启后扩展必须带 X-TermAsk-Token 才能写入 */
export async function setBridgeRequireToken(
  enabled: boolean,
): Promise<boolean> {
  return invoke<boolean>("set_bridge_require_token", { enabled });
}

/** 轮换桥接令牌（旧令牌立即失效，扩展需重新配对） */
export async function rotateBridgeToken(): Promise<string> {
  return invoke<string>("rotate_bridge_token");
}

/**
 * 应用全局快捷键（设置页录制后调用）。
 * 后端「先注册新键、再注销旧键」，失败会回滚默认键并抛出可读错误。
 */
export async function setGlobalShortcut(
  accelerator: string,
): Promise<string> {
  return invoke<string>("set_global_shortcut", { accelerator });
}

/* ------------------------------------------------------------------ *
 *  用户设置 / 账户系统封装：见文件后段（与并行实现合并，单一来源）
 * ------------------------------------------------------------------ */

/** 读取批量学习模式开关（内存态，工作台重启后默认关闭） */
export async function getBatchMode(): Promise<boolean> {
  return invoke<boolean>("get_batch_mode");
}

/** 切换批量学习模式；开启后插件 background 轮询此状态，划词即自动静默入暂存 */
export async function setBatchMode(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_batch_mode", { enabled });
}

/* ------------------------------------------------------------------ *
 *  账户系统（本地账户：注册 / 登录 / 验证码 / 数据隔离）
 * ------------------------------------------------------------------ */

/**
 * 发送验证码（当前为模拟发送：无 SMTP/短信通道，验证码经 devCode 回传，
 * 前端注册页应把它展示给用户）。5 分钟有效，连错 5 次作废。
 */
export async function sendVerificationCode(
  identifier: string,
): Promise<SendCodeResult> {
  return invoke<SendCodeResult>("send_verification_code", { identifier });
}

/** 注册（手机号/邮箱 + 密码 + 验证码），成功即登录并切到该用户数据目录 */
export async function registerAccount(
  payload: RegisterPayload,
): Promise<AuthSession> {
  return invoke<AuthSession>("register_account", { payload });
}

/** 登录；成功后 load_graph_projects()/load_user_settings() 拉取到的即该用户数据 */
export async function loginAccount(
  identifier: string,
  password: string,
): Promise<AuthSession> {
  return invoke<AuthSession>("login_account", { identifier, password });
}

/** 退出登录，回到游客模式（数据落 app_data_dir 根目录） */
export async function logoutAccount(): Promise<void> {
  return invoke<void>("logout_account");
}

/** 当前登录会话；null = 未登录。应用启动时先调它再决定拉哪份数据 */
export async function getCurrentSession(): Promise<AuthSession | null> {
  return invoke<AuthSession | null>("get_current_session");
}

/** 保存设置（JSON 字符串透传）；登录后落 users/{userId}/settings.json */
export async function saveUserSettings(settings: string): Promise<void> {
  return invoke<void>("save_user_settings", { settings });
}

/** 读取设置；未保存过返回 null */
export async function loadUserSettings(): Promise<string | null> {
  return invoke<string | null>("load_user_settings");
}

/* ------------------------------------------------------------------ *
 *  白板（Whiteboard）
 * ------------------------------------------------------------------ */

/** 保存（覆盖写）一块白板；后端原子写，目录随登录身份切换 */
export async function saveWhiteboard(project: WhiteboardProject): Promise<void> {
  return invoke<void>("save_whiteboard", { project });
}

/** 读取当前用户的全部白板，按 updatedAt 倒序 */
export async function loadWhiteboards(): Promise<WhiteboardProject[]> {
  return invoke<WhiteboardProject[]>("load_whiteboards");
}

/**
 * 白板 AI 批注 / 助读：选中文本或描述（content）+ 白板上下文（context）→ 批注。
 * 返回的 keywords 可直接调 `stageWord` 加入收集区（暂存区为跨模块单例）。
 */
export async function aiAnnotateWhiteboard(
  content: string,
  context: string,
  provider: LlmConfig,
): Promise<WhiteboardAnnotation> {
  return invoke<WhiteboardAnnotation>("ai_annotate_whiteboard", {
    content,
    context,
    provider,
  });
}

/* ------------------------------------------------------------------ *
 *  v0.1.0 新增契约：权威定义在 src/lib/bridge-ext.ts（后端核对用契约文件）
 * ------------------------------------------------------------------ */

export {
  askLlm,
  checkAppUpdate,
  installAppUpdate,
} from "./bridge-ext";
export type { AppUpdateInfo } from "./bridge-ext";
