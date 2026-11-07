// src/lib/bridge-ext.ts
// 后端新增能力的前端契约层（2026-11-05 后端批次）
//
// 为什么单独一个文件：
//   本轮后端新增的命令（分类 / 偏好 / 数据目录 / 导出 / 改密）需要前端包装，
//   但前端页面正在并行迭代。为避免与 `src/lib/bridge.ts` 产生同文件冲突，
//   新包装集中放在本文件，页面按需 import，`bridge.ts` 保持不动。
//
// 命令与返回体均由 Rust 端 `#[serde(rename_all = "camelCase")]` 序列化，
// 字段名与下列 TypeScript 接口一一对应。

import { invoke } from "@tauri-apps/api/core";
import type { GraphProject, LlmConfig } from "@/types";
import type { ConceptKind } from "@/types/graph";

/* ------------------------------------------------------------------ *
 *  概念分类
 * ------------------------------------------------------------------ */

/** 单个词的分类结果（对应 Rust `ClassifiedTerm`） */
export interface ClassifiedTerm {
  term: string;
  kind: ConceptKind;
  /** 判定理由，≤20 字；模型未覆盖时说明兜底原因 */
  reason?: string;
  /** true = 该词由本地启发式判定（LLM 未覆盖或整批降级） */
  heuristic: boolean;
}

/** 分类命令返回体（对应 Rust `ClassifyResult`） */
export interface ClassifyResult {
  items: ClassifiedTerm[];
  /** true = 整批降级为本地规则（LLM 调用失败/未配置） */
  degraded: boolean;
  /** 降级原因（可直接展示给用户） */
  error?: string;
  /** 超过单次 60 个词被截断的数量 */
  truncated: number;
}

/**
 * 批量概念分类（LLM 优先，失败自动降级本地规则）。
 *
 * 使用建议：
 * - 自动模式（`autoClassify = true`）：图谱生成/词条入库后，把新词批量丢进来；
 * - 手动模式：用户在概念图谱栏点「自动分类」时调用同一命令，入参为当前画布全部词；
 * - 单次最多 60 个词，超出请分批；返回值 `truncated` 会告知被截断数量。
 *
 * 结果写入词库时请置 `kindSource: "auto"`（与 `useWordLibraryStore` 约定一致），
 * 不要覆盖用户手动设置过的 `manual` 条目。
 */
export async function classifyConcepts(
  terms: string[],
  provider: LlmConfig,
): Promise<ClassifyResult> {
  return invoke<ClassifyResult>("classify_concepts", { terms, provider });
}

/* ------------------------------------------------------------------ *
 *  应用偏好（自动分类开关）
 * ------------------------------------------------------------------ */

/** 应用级偏好（对应 Rust `AppPreferences`） */
export interface AppPreferences {
  autoClassify: boolean;
}

/** 读取偏好（进入图谱页时调用一次，决定开关初始状态） */
export async function getAppPreferences(): Promise<AppPreferences> {
  return invoke<AppPreferences>("get_app_preferences");
}

/**
 * 设置自动分类开关（设置页「通用」）。
 * 后端只持久化偏好；是否真的自动触发由前端决定，关闭后图谱栏仍可手动分类。
 */
export async function setAutoClassify(
  enabled: boolean,
): Promise<AppPreferences> {
  return invoke<AppPreferences>("set_auto_classify", { enabled });
}

/* ------------------------------------------------------------------ *
 *  数据目录
 * ------------------------------------------------------------------ */

/** 当前数据根目录的绝对路径 */
export async function getDataLocation(): Promise<string> {
  return invoke<string>("get_data_location");
}

/**
 * 迁移数据目录（只允许空目录；复制成功后才切换指针）。
 *
 * 典型用法：
 * ```ts
 * const picked = await open({ directory: true, multiple: false });
 * if (typeof picked === "string") await setDataLocation(picked);
 * ```
 * `open` 来自 `@tauri-apps/plugin-dialog`（后端已注册该插件并放行 dialog:default）。
 *
 * 返回新目录路径；失败时抛出可读错误（非空目录 / 不可写 / 父子目录关系）。
 */
export async function setDataLocation(path: string): Promise<string> {
  return invoke<string>("set_data_location", { path });
}

/* ------------------------------------------------------------------ *
 *  导出
 * ------------------------------------------------------------------ */

export type ExportFormat =
  | "html"
  | "docx"
  | "pdf"
  | "png"
  | "markdown"
  | "json";

/** 导出结果（对应 Rust `ExportResult`） */
export interface ExportResult {
  /** 落盘绝对路径 */
  path: string;
  /** 实际格式（扩展名） */
  format: string;
  bytes: number;
}

/**
 * 把图谱导出为指定格式，文件写入 `数据目录/exports`（登录用户为 `users/{id}/exports`）。
 *
 * - `fileName` 可省略：默认「标题 + 时间戳」；扩展名由格式决定，入参里的扩展名会被忽略。
 * - PDF / PNG 需要系统中文字体：PDF 依赖 TTF（微软雅黑为 ttc 不可用，会回退黑体/楷体），
 *   PNG 依赖系统字体库；缺字体时返回可读错误而不是乱码文件。
 */
export async function exportGraphProject(
  project: GraphProject,
  format: ExportFormat,
  fileName?: string,
): Promise<ExportResult> {
  return invoke<ExportResult>("export_graph_project", {
    project,
    format,
    fileName,
  });
}

/* ------------------------------------------------------------------ *
 *  账户
 * ------------------------------------------------------------------ */

/**
 * 修改密码（需已登录）。
 * 新密码策略：8-64 位，至少一个字母 + 一个数字；与原密码相同会被拒绝。
 */
export async function changePassword(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  return invoke<void>("change_password", { oldPassword, newPassword });
}

/* ------------------------------------------------------------------ *
 *  自由问答（2026-11-06 后端批次）
 * ------------------------------------------------------------------ */

/**
 * 自由问答通用入口（AI 追问区 / 图谱质量测评共用）。
 *
 * invoke 名与参数键名：`ask_llm`，`{ question, context?, provider }`
 * （与 src/lib/bridge.ts 中 bridge.askLlm 的封装一致——本文件是契约
 * 权威源，bridge.ts 仅 re-export，避免双份定义漂移）。
 * 后端要求：temperature 0.3，max_tokens ≥ 4096，超时 120s。
 */
export async function askLlm(
  question: string,
  context: string,
  provider: LlmConfig,
): Promise<string> {
  return invoke<string>("ask_llm", { question, context, provider });
}

/* ------------------------------------------------------------------ *
 *  应用更新（tauri-plugin-updater）
 * ------------------------------------------------------------------ */

/** 检查结果（与后端 check_app_update 返回体逐字段对齐） */
export interface AppUpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  notes?: string;
}

export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  return invoke<AppUpdateInfo>("check_app_update");
}

/** 下载并安装更新（后端返回提示字符串；需应用重启生效） */
export async function installAppUpdate(): Promise<string> {
  return invoke<string>("install_app_update");
}

/* ------------------------------------------------------------------ *
 *  导出落盘通用命令（2026-11-07 请求：后端待实现）
 * ------------------------------------------------------------------ */

/**
 * 把前端生成的导出内容写入 `数据目录/exports/{fileName}`（登录按用户隔离）。
 *
 * 后端要求（待实现）：`write_export_file(fileName, base64Content) -> ExportResult`
 *   - fileName 需过 is_safe_id 校验（防路径穿越），扩展名白名单
 *     （png/svg/html/json/md/pdf/docx/markdown）；
 *   - base64Content 解码后原子写（.tmp → rename）；
 *   - 返回与 export_graph_project 相同的 ExportResult { path, format, bytes }。
 *
 * 使用场景：白板导出（tldraw toImage 产出 png/svg blob，前端转 base64 后落盘）。
 * 通用性：任何前端渲染产物（Canvas.toBlob / SVG 序列化）都可走此命令落盘。
 */
export async function writeExportFile(
  fileName: string,
  base64Content: string,
): Promise<ExportResult> {
  return invoke<ExportResult>("write_export_file", {
    fileName,
    base64Content,
  });
}

/** Blob → base64（无依赖，分块避免栈溢出） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/* ------------------------------------------------------------------ *
 *  SMTP 邮件发送配置（2026-11-07 后端批次）
 * ------------------------------------------------------------------ */

/** SMTP 配置（对应 Rust `SmtpConfig`，camelCase） */
export interface SmtpConfig {
  enabled: boolean;
  server: string;
  port: number;
  username: string;
  /** 授权码；保存时【留空 = 保留原授权码】；读取时永不回显 */
  password: string;
  /** 加密方式 */
  encryption: "starttls" | "ssl" | "none";
  fromName: string;
}

/** 读取 SMTP 配置（password 永不回显，返回 hasPassword / mockMode 状态） */
export interface SmtpConfigInfo extends Omit<SmtpConfig, "password"> {
  hasPassword: boolean;
  /** true = 仍为模拟模式（未启用真实邮件） */
  mockMode: boolean;
}

export async function getSmtpConfig(): Promise<SmtpConfigInfo> {
  return invoke<SmtpConfigInfo>("get_smtp_config");
}

/**
 * 保存 SMTP 配置。`config.password` 留空 = 保留原授权码；
 * 保存后建议重新 getSmtpConfig() 刷新 hasPassword / mockMode 展示。
 */
export async function setSmtpConfig(config: SmtpConfig): Promise<SmtpConfigInfo> {
  return invoke<SmtpConfigInfo>("set_smtp_config", { config });
}

/** 读取当前生效的全局快捷键（后端运行时注册态；缺失时后端回退 Ctrl+Shift+Q，永不返回空串） */
export async function getGlobalShortcut(): Promise<string> {
  return invoke<string>("get_global_shortcut");
}
