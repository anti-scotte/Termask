/**
 * TermAsk 工作台核心类型定义（第一阶段骨架）
 *
 * 注意：模板字段与《0-开发执行决议单-最终版》第 5 节对齐，
 * 当前仅保留第一阶段 UI 需要的字段，后续补全 output_contract 等完整契约。
 */

import type { GraphTemplate } from "./graph";

/** 提问模板（Prompt Template） */
export interface PromptTemplate {
  id: string;
  version: number;
  /** 模板名称 */
  name: string;
  /** 学习意图：这个提问想达成什么 */
  intent: string;
  /** Prompt 内容（完整提示词正文，可含 {{变量名}} 占位） */
  promptContent: string;
  /** 变量槽位，如 ["原文选段", "卡点词"] */
  variables: string[];
  /** 粒度要求：L1-L4 或其他粒度描述 */
  granularity: string;
  createdAt: number;
  updatedAt: number;
}

/** 节点坐标（布局持久化用，可选） */
export interface GraphPosition {
  x: number;
  y: number;
}

/** 概念图谱节点 */
export interface ConceptNode {
  id: string;
  /** 概念名 */
  label: string;
  /** 粒度层级（可选，用于着色/分组） */
  level?: number;
  /** 概念释义（可选，悬浮/节点副文本展示） */
  description?: string;
  /** 拖拽后的坐标（可选，缺省由布局算法计算） */
  position?: GraphPosition;
}

/** 概念图谱边 */
export interface ConceptEdge {
  id: string;
  source: string;
  target: string;
  /** 关系描述，如 "是...的前提" */
  label?: string;
}

/** 浏览器扩展推来的概念关系负载 */
export interface ConceptGraphPayload {
  /** 来源会话 ID（扩展侧锚定用） */
  sessionId: string;
  /** 触发来源的原文选段（锚回原文） */
  sourceExcerpt?: string;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
}

/**
 * LLM 协议类型（与 Rust `LlmConfig.kind` 严格一致）。
 *
 * 选型建议：
 * - 绝大多数供应商都走 `openai-compatible`：DeepSeek（`https://api.deepseek.com`）、
 *   免费 Gemini（`https://generativelanguage.googleapis.com/v1beta/openai`，OpenAI 兼容层）、
 *   Kimi（`https://api.moonshot.cn`）、GLM（`https://open.bigmodel.cn/api/paas/v4`）、
 *   本地 Ollama 兼容层（`http://127.0.0.1:11434/v1`）。
 * - baseUrl 一律**不用**手写 `/chat/completions`，后端会自动补版本段；
 *   已带 `/v1`、`/v4`、`/v1beta/openai` 也不会重复拼接。
 */
export type ModelKind = "openai-compatible" | "anthropic" | "ollama";

/** LLM 提供商配置（本地模型路由层） */
export interface ModelProviderConfig {
  id: string;
  /** 显示名，如 DeepSeek / Gemini / Claude / Ollama */
  name: string;
  /** 协议类型，见 ModelKind 注释 */
  kind: ModelKind;
  baseUrl: string;
  /** API Key 只存本地（Tauri store / keyring），绝不入代码库 */
  apiKey?: string;
  /** 上游真实模型 ID，如 deepseek-chat / gemini-2.5-flash / claude-sonnet-4 */
  model: string;
  /** 是否当前启用的默认模型 */
  enabled: boolean;
}

/**
 * AI 总结粒度（Rust `Granularity`，lowercase 序列化）。
 * 控制图谱 / 全文分析 summary 的字数区间：
 * - `low` 粗读：120-200 字，只要主干结论
 * - `medium` 标准：200-400 字，讲清因果推进（**默认**，不传即此档）
 * - `high` 精读：450-800 字，逐层展开 + 适用边界
 */
export type Granularity = "low" | "medium" | "high";

/** 多图谱工作区中的一个图谱项目（与 Rust GraphProject 对齐） */
export interface GraphProject {
  id: string;
  /** 图谱名称，如"高数第一章" */
  title: string;
  templateType: GraphTemplate;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  /**
   * 图谱核心逻辑链总结（字数由生成时的 granularity 决定，见 Granularity 注释）。
   * 生成链路：LLM 首轮产出 → 不足下限自动二次扩写 → 仍不足由后端按图结构兜底，
   * 因此这里可能不是严格的「模型原话」，但一定是非空可展示文本；旧数据可能为空串。
   */
  summary: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * LLM 调用配置（测试连接 / 图谱生成共用，与 Rust LlmConfig 对齐）。
 * `apiKey` 必填但可为空串（Ollama 本地不需要）。
 */
export interface LlmConfig {
  kind: ModelKind;
  baseUrl: string;
  apiKey: string;
  /** 上游真实模型 ID（不是显示名） */
  model: string;
}

/** generate_graph_from_cache 入参：划词词汇列表 + 上下文数组 */
export interface GenerateGraphPayload {
  title: string;
  templateType: GraphTemplate;
  /**
   * 划词收集的概念词汇。
   * 允许为空数组：整页 AI 对话场景下，概念完全由 `contexts` 提炼。
   * 后端会 trim + 过滤空串；与 contexts 同时为空时报错。
   */
  concepts: string[];
  /** 上下文片段数组（可选）；片段之间按顺序拼接后送入 LLM */
  contexts?: string[];
  /**
   * 上下文送入 LLM 的字符总预算（可选）。
   * 缺省 48000，硬上限 200000，低于 4000 按 4000 处理。
   * 用长窗口模型（DeepSeek-V4-Flash / Gemini Flash）抓整页对话时，建议传 100000 以上。
   */
  maxContextChars?: number;
  /** AI 总结粒度（可选，缺省 medium）。见 Granularity 注释。 */
  granularity?: Granularity;
  provider: LlmConfig;
}

/**
 * 全文骨架中的一条（`analyze_full_context` 返回）
 * 顺序即原文的论述顺序，不是按重要性重排。
 */
export interface OutlineItem {
  /** 小标题（≤16 字） */
  heading: string;
  /** 这一段在论证什么（30-60 字；模型只给纯字符串时为空串） */
  detail: string;
}

/**
 * 全文深度分析结果（Rust `FullContextAnalysis`，camelCase 对齐）。
 * 由 `analyzeFullContext(contextText, provider, granularity?)` 返回，不落盘。
 */
export interface FullContextAnalysis {
  /** 全文主题（模型提炼，取不到时为正文前 20 字） */
  title: string;
  /** 一句话主旨 */
  thesis: string;
  /** 骨架，3-8 条；模型漏给时由核心概念兜底填充 */
  outline: OutlineItem[];
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  /** 详细总结，字数由 granularity 决定（见 Granularity 注释） */
  summary: string;
  /** 实际送入模型的字符数（原文超预算时小于原文长度） */
  contextChars: number;
  /** 本次调用的模型 id，便于排查 */
  model: string;
}

/**
 * 单节点深度解析结果（Rust `ConceptAnalysis`）。
 * 由 `analyzeSingleConcept(concept, context, provider)` 返回。
 */
export interface ConceptAnalysis {
  concept: string;
  /** 该词在当前上下文中的具体含义，约 150 字 */
  analysis: string;
  /** 它在文中承担的角色，一句话；模型未给出时为 null */
  role?: string | null;
  /** 与上下文中其他概念的关系，2-3 条；模型未给出时为空数组 */
  relations: string[];
}

/**
 * 暂存区命令契约（与 Rust 后端一一对应，桥接层照此实现即可）：
 *
 * | 命令 | 入参 | 返回 |
 * |---|---|---|
 * | `get_staged_words` | — | `StagedWord[]`，按入站顺序 |
 * | `get_cache_count` | — | `number`，与插件轮询的 `GET /api/get-cache-count` 同源 |
 * | `remove_from_cache` | `term: string` | `StagedWord[]`，删除后的完整列表 |
 * | `clear_cache` | — | `StagedWord[]`，空数组 |
 *
 * 删除语义：`term` 先 trim 再比较，同名项会一并移除（划词重复推入很常见），
 * 返回的是「操作后的权威列表」，前端直接 setState 即可，不必再查一次。
 * `remove_staged_word` / `clear_staged_words` 为兼容旧调用点保留，新代码优先用上面四个。
 */
/** 插件划词暂存的词条（与 Rust StagedWord 对齐，POST /api/add-to-graph 接收） */
export interface StagedWord {
  /** 划词内容（概念词） */
  term: string;
  /** 上下文文本（可选） */
  contextText?: string;
  /** 来源页面 URL（可选） */
  sourceUrl?: string;
  /** 来源页面标题（可选） */
  pageTitle?: string;
  /** 入站时间戳（毫秒，插件传 addedAt；缺省由后端补） */
  addedAt?: number;
  /**
   * 收集目标："graph"（概念图谱，默认）| "whiteboard"（白板收集区）。
   * 后端据此分发到对应暂存区（whiteboard_staged）并广播 "whiteboard-word" 事件。
   * stage_word 写入白板收集区时必须传 "whiteboard"。
   */
  target?: "graph" | "whiteboard";
}

/* ------------------------------------------------------------------ *
 *  账户系统（本地账户：注册 / 登录 / 验证码 / 数据隔离）
 * ------------------------------------------------------------------ */

/** 登录会话（Rust `AuthSession`）。登录/注册成功返回；`getCurrentSession()` 重启后恢复 */
export interface AuthSession {
  userId: string;
  /** 规范化后的手机号/邮箱（邮箱小写；手机号保留 + 与数字） */
  identifier: string;
  nickname: string;
  accountType: "email" | "phone";
  /** 会话令牌（本地生成；当前仅用于前端标识会话） */
  token: string;
  loggedInAt: number;
}

/** register_account 入参（Rust `RegisterPayload`） */
export interface RegisterPayload {
  /** 手机号（7-15 位数字，可带 +）或邮箱（含 @） */
  identifier: string;
  /** 至少 6 位，最多 64 位 */
  password: string;
  /** sendVerificationCode 拿到的 6 位验证码 */
  code: string;
  /** 昵称（可选；缺省用邮箱前缀 / 打码手机号） */
  nickname?: string;
}

/** send_verification_code 出参（Rust `SendCodeResult`） */
export interface SendCodeResult {
  success: boolean;
  /** 验证码剩余有效期（秒，当前固定 300） */
  expiresIn: number;
  /**
   * 模拟发送模式下的验证码——后端暂无 SMTP/短信通道，直接把码回传给前端，
   * 注册页应把它展示给用户。接入真实通道后恒为 null。
   */
  devCode?: string | null;
  error?: string | null;
}

/**
 * 账户命令契约（与 Rust 后端一一对应）：
 *
 * | 命令 | 说明 |
 * |---|---|
 * | `send_verification_code` | 发（模拟）验证码，5 分钟有效，连错 5 次作废 |
 * | `register_account` | 注册成功即登录，自动切换到该用户的数据目录 |
 * | `login_account` | 登录后图谱/设置落 `users/{userId}/`，重新拉取即可见 |
 * | `logout_account` | 退出回游客模式（数据落 app_data_dir 根目录） |
 * | `get_current_session` | 当前会话；null = 未登录。启动时先调它 |
 * | `save_user_settings` / `load_user_settings` | 设置 JSON 字符串按身份落盘/读取 |
 *
 * 数据隔离：登录后 `load_graph_projects()` / `save_graph_project()` 自动指向
 * `users/{userId}/graphs/`，前端无需传任何用户参数；
 * 未登录保持 `graphs/`（游客数据向后兼容）。重启后只要 session.json 有效，
 * `getCurrentSession()` 就能拿回会话，随后拉取的即是该用户数据。
 */

/* ------------------------------------------------------------------ *
 *  白板（Whiteboard）：tldraw 快照 + AI 批注
 * ------------------------------------------------------------------ */

/** 白板画布类型（与 Rust `WhiteboardCanvasType` 一致） */
export type WhiteboardCanvasType = "infinite" | "a4" | "screen";

/** 白板 AI 批注结果（Rust `WhiteboardAnnotation`） */
export interface WhiteboardAnnotation {
  /** 批注正文（150-300 字，可直接贴在白板上） */
  annotation: string;
  /** 关键词/术语，2-4 个；可一键调用 `stageWord` 加入收集区 */
  keywords: string[];
  /** 建议追问，1-3 条；AI 面板的「继续追问」按钮 */
  followUps: string[];
}

/** 白板页（一块白板文档内的多 page 画布；v3 前端扩展，后端原样存 JSON） */
export interface WhiteboardPageData {
  id: string;
  /** 页面标题（页签展示，缺省「第 N 页」） */
  title?: string;
  canvasType: WhiteboardCanvasType;
  /** 背景模板（blank=空白 / grid=网格 / cornell / socratic） */
  template: "blank" | "grid" | "cornell" | "socratic";
  /** tldraw JSON 快照（本页内容；null = 空页） */
  elements: unknown;
  /** 页码角标开关（画布左上角显示「第 N 页」浮标） */
  showPageBadge: boolean;
  /** 页码角标显示的编号（相对全文档的页序，保存时重算） */
  pageIndex: number;
}

/**
 * 一块白板（Rust `WhiteboardProject`）。
 * 与图谱同级持久化：登录后落 `users/{userId}/whiteboards/`，游客落 `whiteboards/`。
 */
export interface WhiteboardProject {
  id: string;
  title: string;
  canvasType: WhiteboardCanvasType;
  /**
   * tldraw 的 JSON 快照。后端不解析（结构随 tldraw 版本变化），原样存取；
   * 前端升级 tldraw 不需要改后端，故这里用 unknown，由白板组件自行收窄类型。
   * v3 起多 page 结构下此字段保留为「第 1 页」的镜像（旧数据兼容）。
   */
  elements: unknown;
  /** v3 多 page：一块白板文档内的多个画布页（缺省 = 单页旧结构，取 elements） */
  pages?: WhiteboardPageData[];
  /** 软删除标记（后端无删除接口，前端 load 后过滤） */
  deleted?: boolean;
  /** 缩略图（data URL，用于白板列表预览） */
  thumbnail?: string | null;
  /** 这块白板上产生过的 AI 批注（可选持久化） */
  annotations: WhiteboardAnnotation[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 白板命令契约（与 Rust 后端一一对应）：
 *
 * | 命令 | 说明 |
 * |---|---|
 * | `save_whiteboard` | 覆盖写一块白板（原子写：.tmp → rename） |
 * | `load_whiteboards` | 读当前用户全部白板，按 `updatedAt` 倒序 |
 * | `ai_annotate_whiteboard` | 选中文本/描述 → 批注正文 + 关键词 + 追问 |
 *
 * 暂存区跨模块可用：`stageWord` / `getStagedWords` / `getCacheCount` /
 * `removeFromCache` / `clearCache` 是进程级单例，白板页直接复用，
 * 无需白板专属接口；把选中的词加入收集区即 `stageWord({ term, contextText })`。
 */
