import { defineContentScript } from "wxt/utils/define-content-script";
// WXT 最佳实践：统一走 browser.*（wxt/browser 显式导入，类型来自
// @wxt-dev/browser 的 Promise 化 API 定义），不再依赖 @types/chrome 的
// chrome.* 命名空间；browser.* 同时兼容 Chrome/Edge/Firefox。
import { browser, type Browser } from "wxt/browser";

/**
 * 阶段2 完整闭环 v5：轻量浮层（划词芯片 → 面板 → 粒度选择 → 发送 → 结果展示）
 *
 * v5 增量（相对 v4，不破坏既有闭环与防崩塌约定）：
 *  1) 返回修改：结果态底部新增「返回修改」按钮，切回 edit，
 *     保留 selectedText 与 levelSelect.value，不重新划词即可改粒度/重发；
 *  2) L4 多轮对话：仅 L4 档结果态下方出现极简追问输入框，追问复用 background
 *     既有会话上下文（storage.session），回答以气泡 appendChild 追加渲染
 *     （仍走 textContent，模型输出永不作 HTML 解析）；L1–L3 不显示追问框；
 *  3) iframe 兼容：defineContentScript 声明 allFrames: true，每帧独立实例，
 *     fixed 定位基于本帧视口（getBoundingClientRect 默认即 frame-local），无需跨 frame 换算。
 *
 * v5.1 增量：面板头部拖拽栏，pointerdown/move/up + 指针捕获实现拖动，
 * 拖拽位置记忆（再次打开保持上次位置，双击标题栏恢复锚定选区）。
 *
 * v7 增量：「生成图谱」→「加入图谱」——点击不再触发 LLM 抽取与
 * 直接推送，而是把「选中词 + 上下文文本 + 来源页信息」交给 background：
 *  1) 写入插件暂存区（browser.storage.local，跨页面/跨标签页持久），
 *     支持连续划词积累多个术语，后续在工作台合并生成关系；
 *  2) 尽力 POST http://127.0.0.1:17570/api/add-to-graph（工作台新接口，
 *     离线时仅本地暂存不报错，打开工作台后仍可合并）；
 *  3) 成功提示语：「已加入暂存区，请去工作台查看」；
 *  4) 按钮实时显示暂存条数「加入图谱（n）」，让用户感知连续选择进度。
 *
 * v8 增量：全文抓取 + 计数同步：
 *  1) 新增「分析当前对话」按钮：用通用选择器抓取当前页（ChatGPT/DeepSeek/
 *     Kimi 等）整段 AI 对话文本（≤5000 字），交给 background 以词条
 *     特殊标记 __FULL_CONTEXT__ 推送 /api/add-to-graph，后端存为
 *     「待分析的全文快照」，不占用普通划词暂存计数；
 *  2) 计数同步：按钮数字不再只靠本地累加——刷新时经 background GET
 *     /api/get-cache-count 拿工作台权威数量（感知工作台删除），离线降级本地；
 *  3) 新增「重置数字」小按钮（⟲）：清空本地暂存计数后重新同步，兜底
 *     本地与工作台数字漂移。
 *
 * v8.3 增量（本版）：chrome.* → browser.*（WXT 最佳实践）：
 *  - 7 个消息助手从「回调式 chrome.runtime.sendMessage + lastError 检查」
 *    收敛为一个 Promise 风格的通用 sendToBackground<T>()（browser.* 的
 *    sendMessage 即返回 Promise，失败直接 reject，无需 lastError）；
 *  - 全部回调参数的隐式 any 随 Promise 化一并消除，通过 TS 严格检查；
 *  - 消息契约与 background 的 browser.runtime.onMessage 监听器完全兼容。
 *
 * v9 增量（本版）：无感收集器·第一阶段（快捷键）：
 *  - 新增 QUICK_ADD_GET 应答：background 收到 Alt+Shift+A 后经
 *    tabs.sendMessage 向本帧要选区——本帧持有非空选区时同步读
 *    window.getSelection() + extractContextText 并回包
 *    { ok, term, contextText, sourceUrl, pageTitle }；
 *  - 无选区的 frame 不回包（多 frame 竞争时真正划词的那一帧获胜，
 *    无人应答则快捷键静默无操作）；
 *  - 全程不弹浮层：加入图谱、删除最后词条（Alt+Shift+Z）的暂存与
 *    推送都在 background 完成。
 *
 * v10 增量（本版）：无感收集器·第二阶段（批量学习模式）：
 *  - 工作台开启「批量模式」后（插件经 background 查询 GET /api/batch-mode，
 *    8s TTL 缓存 + 划词按需刷新），网页上划词鼠标松开即【自动静默】把
 *    词 + 上下文加入工作台暂存区，无需点任何按钮（浮层芯片照常显示，
 *    手动提问链路不受影响）；
 *  - 防抖：连续划词进入缓冲区，800ms 内无新划词才一次性批量提交
 *    （BATCH_ADD_WORDS，background 逐条去重入暂存，单批上限 20 条），
 *    避免快速划多个词时频繁请求；
 *  - 同词重复划不重复入缓冲区。
 *
 * v11 增量（本版）：批量模式开关收敛到插件端 + 划词零浮层：
 *  - 批量模式状态存于 browser.storage.local（key=termask_batch_mode），
 *    快捷键 Ctrl+Shift+B 切换（background 写 storage + 回推工作台），
 *    工作台开关经 alarm 轮询单向同步到本地（30s 内生效）；
 *  - 划词 mouseup 先查批量状态（storage 读取，毫秒级）：批量模式下
 *    【完全不弹浮层——芯片也不显示】，直接静默入 800ms 防抖缓冲区；
 *    非批量模式维持原芯片交互不变；
 *  - 撤销快捷键改为 Ctrl+Shift+Z（background / wxt.config.ts 侧）。
 *
 * v12 增量（本版）：白板互通——「加入图谱」旁新增「加入白板」图标按钮：
 *  - 点击后以 target="whiteboard" 发送 ADD_TO_GRAPH_REQUEST，background
 *    透传到 POST /api/add-to-graph，后端分发到白板暂存区
 *    （事件 "whiteboard-word"，白板页监听）；
 *  - 「加入图谱」保持 target="graph" 不变；同一词可分别加入两者
 *    （插件本地去重键为 term+target，不互相覆盖）；
 *  - 白板暂存计数不计入「加入图谱（n）」按钮（该计数仍是图谱口径）。
 *
 * 视图由 panel.dataset.state 驱动：edit（待发送）/ loading（思考中）/ result（结果展示）
 * 关闭只有三条路径：Esc 键、点击面板外部、结果态「关闭」按钮。
 * 内外判定一律走 composedPath()——closed Shadow DOM 下 path 仍包含 host，
 * 彻底杜绝"点发送/下拉框/追问框被当成点外部"的误关。
 */

type Level = "L1" | "L2" | "L3" | "L4";
type PanelState = "edit" | "loading" | "result";

/** content script → background 消息的宽松契约（payload 各消息自定义） */
interface ExtensionMessage {
  type: string;
  payload?: unknown;
}

/**
 * 通用消息发送（v8.3）：browser.runtime.sendMessage 返回 Promise，
 * 失败（扩展上下文失效 / 接收端抛错）直接 reject，无需 lastError 检查。
 * 泛型 T 供调用点显式声明响应形状，替代旧的回调参数类型标注。
 */
async function sendToBackground<T = unknown>(
  msg: ExtensionMessage,
): Promise<T | undefined> {
  const response = (await browser.runtime.sendMessage(msg)) as T | undefined;
  return response;
}

/**
 * 把 background 返回的结构化错误码翻成可执行提示。
 * background 不再只回 HTTP_4xx，而是区分鉴权/限流/网络/超时/空回复，
 * 用户看到的是「该做什么」，不是「哪里错了」。
 */
function describeLLMError(code?: string): string {
  switch (code) {
    case "NO_API_KEY":
      return "请先在扩展配置页填写 API Key";
    case "AUTH_FAILED":
      return "API Key 无效或无权限（401/403），请检查密钥与模型权限";
    case "TIMEOUT":
      return "模型响应超时，请重试或换用更快的模型";
    case "BAD_RESPONSE":
      return "模型返回的不是 JSON（可能被网关拦截），请检查 Base URL";
    case "EMPTY_REPLY":
      return "模型返回空内容，请重试";
    case "NEED_MORE_TERMS":
      return "至少收集 2 个词才能合并生成图谱";
    default:
      if (code?.startsWith("NETWORK")) {
        return "网络请求失败：请检查 Base URL 是否可访问、供应商域名是否在 host_permissions 内";
      }
      if (code?.startsWith("HTTP_429") || code?.startsWith("LLM_HTTP_429")) {
        return "触发供应商限流（429），请稍后重试";
      }
      return code ? `请求失败（${code}）` : "请求失败，请重试";
  }
}

/**
 * 把 `runtime.sendMessage` 的底层异常翻译成可执行提示。
 *
 * 旧实现所有失败都显示「扩展上下文异常」，把三类完全不同的原因混成一句：
 * 1. 扩展重新加载/更新后，已注入页面的 content script 上下文失效
 *    （`Extension context invalidated`）→ 只有刷新页面能恢复；
 * 2. Service Worker 未就绪/未注册（`Receiving end does not exist`）→ 需重载扩展；
 * 3. 其它通信异常 → 原样透出 message，便于定位。
 */
function describeExtensionError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/context invalidated/i.test(msg)) {
    return "扩展已更新，请刷新当前页面后重试";
  }
  if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
    return "扩展后台未就绪：请在扩展管理页重新加载插件，并刷新页面";
  }
  return msg ? `扩展通信失败（${msg}）` : "扩展通信失败，请刷新页面后重试";
}

/** content script → background：请求 LLM（fetch 放 background 规避页面 CSP） */
function callLLM(text: string, level: Level): Promise<unknown> {
  return sendToBackground({ type: "LLM_REQUEST", payload: { text, level } });
}

/** content script → background：误发撤回（剔除上下文最后一轮） */
function retractLLM(): Promise<unknown> {
  return sendToBackground({ type: "LLM_RETRACT" });
}

/** content script → background：加入图谱暂存区（去重 + POST /api/add-to-graph 均在 background 完成） */
function addToGraphStaging(item: {
  term: string;
  contextText: string;
  sourceUrl: string;
  pageTitle: string;
  target?: "graph" | "whiteboard";
}): Promise<unknown> {
  return sendToBackground({ type: "ADD_TO_GRAPH_REQUEST", payload: item });
}

/** content script → background：查询暂存区条数（按钮计数用） */
function getStagingCount(): Promise<unknown> {
  return sendToBackground({ type: "GRAPH_STAGING_GET" });
}

/** v8：content script → background：全文分析入暂存（抓取在 content 完成，暂存/推送在 background） */
function analyzePageChat(input: {
  chatText: string;
  sourceUrl: string;
  pageTitle: string;
}): Promise<unknown> {
  return sendToBackground({ type: "ANALYZE_PAGE_REQUEST", payload: input });
}

/** v8：content script → background：计数同步（工作台权威数量优先，降级本地） */
function syncStagedCountMsg(): Promise<unknown> {
  return sendToBackground({ type: "GRAPH_CACHE_COUNT_GET" });
}

/** v8：content script → background：重置数字（清本地暂存 + 重新同步） */
function resetStagedCountMsg(): Promise<unknown> {
  return sendToBackground({ type: "GRAPH_COUNT_RESET" });
}

/** v10：content → background：批量学习模式是否开启（background 8s 缓存，离线视为关） */
function batchModeCheck(): Promise<unknown> {
  return sendToBackground({ type: "BATCH_MODE_CHECK" });
}

/** v10：content → background：批量提交防抖缓冲区（逐条去重入暂存） */
function batchAddWords(
  items: Array<{
    term: string;
    contextText: string;
    sourceUrl: string;
    pageTitle: string;
  }>,
): Promise<unknown> {
  return sendToBackground({ type: "BATCH_ADD_WORDS", payload: { items } });
}

/**
 * v7：提取选中文本的上下文。
 * 取选区锚点所在元素的 textContent，围绕选中词截取前后各 ~200 字符，
 * 跨元素/跨节点时自然降级为包含选区的那一块文本；拿不到就只回传词本身。
 */
function extractContextText(sel: Selection, term: string): string {
  const WINDOW = 200;
  try {
    const anchorNode = sel.anchorNode;
    const hostEl =
      anchorNode?.nodeType === Node.ELEMENT_NODE
        ? (anchorNode as Element)
        : anchorNode?.parentElement;
    const full = hostEl?.textContent ?? "";
    if (!full) return term;

    const idx = full.indexOf(term);
    if (idx === -1) return full.slice(0, WINDOW * 2);

    const start = Math.max(0, idx - WINDOW);
    const end = Math.min(full.length, idx + term.length + WINDOW);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < full.length ? "…" : "";
    return `${prefix}${full.slice(start, end)}${suffix}`;
  } catch {
    return term;
  }
}

/**
 * v8：通用 AI 对话文本抓取。
 * 策略：从最具体到最泛化依次尝试已知选择器组，命中 ≥2 个非空块即视为
 * 结构化对话，逐块 innerText 拼接（含包含关系去重，防止嵌套选择器重复收集）；
 * 全部落空则兜底抓 main / body 主体文本。
 * 我们自己的浮层跑在 closed Shadow DOM 里，不会出现在 innerText 中，无需排除。
 */
const CHAT_MSG_SELECTORS = [
  "[data-message-author-role]", // ChatGPT：官方 user/assistant 角色标注
  'article[data-testid^="conversation-turn"]', // ChatGPT：对话轮容器（备选）
  ".ds-markdown, .ds-markdown--block", // DeepSeek：助手 Markdown 回答块
  ".chat-content-item-user, .chat-content-item-assistant, .chat-content-item", // Kimi
  '[class*="chat-message"], [class*="chatMessage"]', // 通用 chat-message 命名约定
  '[class*="message-content"], [class*="messageContent"]', // 通用 message-content 命名约定
];

/** v8：全文分析上限（与 background 的 FULL_TEXT_MAX 对齐） */
const FULL_TEXT_LIMIT = 5000;

function extractChatText(): string {
  for (const sel of CHAT_MSG_SELECTORS) {
    try {
      const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
      const parts = els
        .map((el) => (el.innerText ?? "").trim())
        .filter((t) => t.length >= 2);
      // 包含关系去重：嵌套选择器（如 message-content 出现在 article 内）
      // 会重复收集，长串包含短串时只保留一份
      const deduped: string[] = [];
      for (const t of parts) {
        if (!deduped.some((prev) => prev.includes(t) || t.includes(prev))) {
          deduped.push(t);
        }
      }
      if (deduped.length >= 2) {
        return deduped.join("\n\n").slice(0, FULL_TEXT_LIMIT);
      }
    } catch {
      // 选择器被页面 CSP/异常拦截等：尝试下一组
    }
  }
  // 兜底：main 主体 → body 全文
  try {
    const main = document.querySelector("main")?.innerText ?? "";
    const text = (
      main.trim().length >= 100 ? main : document.body.innerText
    ).trim();
    return text.slice(0, FULL_TEXT_LIMIT);
  } catch {
    return "";
  }
}

const SHADOW_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0;
      font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }

  /* ── 划词芯片 ── */
  .ta-chip {
    position: fixed; z-index: 2147483647; display: none;
    padding: 4px 10px; border: none; border-radius: 6px; cursor: pointer;
    background: #1a1a1a; color: #fff; font-size: 12px; line-height: 20px;
    box-shadow: 0 2px 8px rgba(0,0,0,.25); white-space: nowrap;
  }
  .ta-chip:hover { background: #333; }

  /* ── 主面板 ── */
  .ta-panel {
    position: fixed; z-index: 2147483647; display: none;
    width: 320px; padding: 12px;
    background: #fff; border: 1px solid #d0d0d0; border-radius: 10px;
    box-shadow: 0 6px 24px rgba(0,0,0,.18);
  }

  /* 头部拖拽栏（v5.1：按住可拖动整个面板） */
  .ta-header {
    display: flex; align-items: center; justify-content: space-between;
    margin: -2px -2px 8px; padding: 2px 2px 6px;
    border-bottom: 1px dashed #e5e5e5;
    cursor: grab; user-select: none; -webkit-user-select: none;
    touch-action: none; /* pointer 事件必需：禁用浏览器默认触摸/拖拽手势 */
  }
  .ta-header:active { cursor: grabbing; }
  .ta-title { font-size: 12px; line-height: 18px; color: #999; letter-spacing: .5px; }
  .ta-grip { font-size: 12px; line-height: 18px; color: #ccc; letter-spacing: 2px; }

  /* 顶部：选中文本（最多 2 行，多余省略） */
  .ta-quote {
    display: -webkit-box; -webkit-orient: vertical; -webkit-line-clamp: 2;
    overflow: hidden; margin-bottom: 10px; padding: 6px 8px;
    background: #f5f7fa; border-left: 3px solid #1a73e8; border-radius: 4px;
    font-size: 13px; line-height: 1.6; color: #333; word-break: break-all;
  }

  /* 控制行：粒度下拉框 + 发送按钮 */
  .ta-controls { display: flex; gap: 8px; align-items: center; }
  .ta-level {
    flex: 1; height: 30px; padding: 0 6px;
    border: 1px solid #d0d0d0; border-radius: 6px; outline: none;
    background: #fff; color: #333; font-size: 13px; cursor: pointer;
  }
  .ta-level:focus { border-color: #1a73e8; }
  .ta-level:disabled { background: #f5f5f5; color: #999; cursor: not-allowed; }
  .ta-send {
    flex: none; height: 30px; padding: 0 16px; border: none; border-radius: 6px;
    background: #1a73e8; color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap;
  }
  .ta-send:hover:not(:disabled) { background: #1663c7; }
  .ta-send:disabled { background: #9bbdf0; cursor: wait; }

  /* v7：加入图谱按钮（发送按钮旁的次级动作，描边样式区分主次） */
  .ta-graph {
    flex: none; height: 30px; padding: 0 12px;
    border: 1px solid #1a73e8; border-radius: 6px;
    background: #fff; color: #1a73e8; font-size: 13px; cursor: pointer; white-space: nowrap;
  }
  .ta-graph:hover:not(:disabled) { background: #e8f0fe; }
  .ta-graph:disabled { border-color: #9bbdf0; color: #9bbdf0; cursor: wait; background: #fff; }

  /* v12：加入白板按钮（图谱按钮旁的图标式次级动作） */
  .ta-board {
    flex: none; width: 30px; height: 30px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid #7c3aed; border-radius: 6px;
    background: #fff; cursor: pointer;
  }
  .ta-board svg { display: block; }
  .ta-board:hover:not(:disabled) { background: #f3eefe; }
  .ta-board:disabled { border-color: #c9b8f5; cursor: wait; background: #fff; }
  .ta-board svg [stroke] { transition: stroke .15s; }
  .ta-board:hover:not(:disabled) svg [stroke="#7c3aed"] { stroke: #6d28d9; }

  /* v8：全文分析行（控制行下方的次级动作区：分析按钮 + 重置数字小按钮） */
  .ta-analyze-row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .ta-analyze {
    flex: 1; height: 28px; padding: 0 10px;
    border: 1px dashed #a8c7fa; border-radius: 6px;
    background: #fafcff; color: #1a73e8; font-size: 12px; cursor: pointer;
  }
  .ta-analyze:hover:not(:disabled) { background: #e8f0fe; border-style: solid; }
  .ta-analyze:disabled { color: #9bbdf0; border-color: #d5e3fb; cursor: wait; background: #fafcff; }
  .ta-reset {
    flex: none; width: 28px; height: 28px; padding: 0;
    border: 1px solid #d0d0d0; border-radius: 6px;
    background: #fff; color: #999; font-size: 13px; line-height: 1; cursor: pointer;
  }
  .ta-reset:hover { color: #1a73e8; border-color: #1a73e8; }

  /* 结果展示区（初始隐藏）；多轮时内部追加气泡 */
  .ta-result {
    display: none; margin-top: 10px; padding: 8px;
    max-height: 300px; overflow-y: auto;
    background: #fafbfc; border: 1px solid #eee; border-radius: 6px;
    font-size: 13px; line-height: 1.7; color: #1a1a1a;
    white-space: pre-wrap; word-break: break-word;
  }

  /* 多轮对话气泡（仅 L4 追问产生；首答仍是纯文本，保持「原地替换」语义） */
  .ta-msg {
    margin-top: 8px; padding: 6px 8px; border-radius: 6px;
    font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
  }
  .ta-msg-user { background: #e8f0fe; color: #1a1a1a; border-left: 3px solid #1a73e8; }
  .ta-msg-ai   { background: #f2f3f5; color: #1a1a1a; border-left: 3px solid #9aa0a6; }

  /* 追问行：仅 L4 结果态显示 */
  .ta-followup { display: none; margin-top: 8px; gap: 6px; align-items: center; }
  .ta-followup-input {
    flex: 1; height: 30px; padding: 0 8px;
    border: 1px solid #d0d0d0; border-radius: 6px; outline: none;
    background: #fff; color: #333; font-size: 13px;
  }
  .ta-followup-input:focus { border-color: #1a73e8; }
  .ta-followup-input:disabled { background: #f5f5f5; color: #999; }
  .ta-followup-send {
    flex: none; height: 30px; padding: 0 12px; border: none; border-radius: 6px;
    background: #1a73e8; color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap;
  }
  .ta-followup-send:hover:not(:disabled) { background: #1663c7; }
  .ta-followup-send:disabled { background: #9bbdf0; cursor: wait; }

  /* 底部行：撤回（发送后 2 秒内）+ 返回修改 + 关闭 */
  .ta-footer {
    display: none; margin-top: 8px;
    justify-content: flex-end; align-items: center; gap: 8px;
  }
  .ta-retract {
    height: 20px; padding: 0 8px; border: 1px solid #d0d0d0; border-radius: 4px;
    background: #fff; color: #999; font-size: 11px; cursor: pointer; white-space: nowrap;
  }
  .ta-retract:hover { color: #d32f2f; border-color: #d32f2f; }
  .ta-back {
    height: 26px; padding: 0 12px; border: 1px solid #1a73e8; border-radius: 6px;
    background: #fff; color: #1a73e8; font-size: 12px; cursor: pointer;
  }
  .ta-back:hover { background: #e8f0fe; }
  .ta-close {
    height: 26px; padding: 0 14px; border: 1px solid #d0d0d0; border-radius: 6px;
    background: #fff; color: #555; font-size: 12px; cursor: pointer;
  }
  .ta-close:hover { background: #f5f5f5; }

  /* toast */
  .ta-toast {
    position: fixed; z-index: 2147483647; display: none;
    padding: 4px 10px; border-radius: 6px;
    background: rgba(0,0,0,.75); color: #fff; font-size: 12px; white-space: nowrap;
  }
`;

export default defineContentScript({
  matches: ["<all_urls>"],
  allFrames: true, // v5 需求三：iframe 内也注入（每帧独立实例，定位基于本帧视口）
  runAt: "document_idle",
  main() {
    // 版本标记：控制台看不到这行 = 页面里跑的还是旧 bundle（需重载扩展+强刷页面）
    console.info(
      "[TermAsk] v12 loaded: whiteboard interop (target field + board button)",
    );

    // 重复注入检测：WXT dev 重载扩展后旧 content script 不自动卸载，
    // 新旧两实例并存时旧实例会"吃掉"交互且只打旧日志，表现为"UI 无响应"
    if (document.getElementById("__termask-root__")) {
      console.error(
        "[TermAsk] 检测到重复注入：页面已存在浮层 host（旧 bundle 未卸载）。" +
          "请重载扩展后用 Ctrl+F5 强刷本页，旧实例才会消失。",
      );
      return;
    }

    // ── 环境自检（失效要可见，不默默死掉） ────────────────────────────
    // v5 起 all_frames 已开启，iframe 内注入是预期行为，仅留一条 info 便于排查
    if (window !== window.top) {
      console.info(
        "[TermAsk] 当前为 iframe 内实例（all_frames 已开启），浮层将在本帧视口内定位",
      );
    }
    if (!document.documentElement) {
      console.warn(
        "[TermAsk] 注入失败：document.documentElement 不存在（特权页/异常文档）",
      );
      return;
    }
    let warnedSelection = false;

    // ── Shadow DOM 容器 ──────────────────────────────────────────────
    const host = document.createElement("div");
    host.id = "__termask-root__";
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = SHADOW_CSS;
    shadow.appendChild(style);

    // 划词芯片
    const chip = document.createElement("button");
    chip.className = "ta-chip";
    chip.textContent = "不懂？问一句";

    // 主面板
    const panel = document.createElement("div");
    panel.className = "ta-panel";
    panel.dataset.state = "edit";

    // 1) 头部拖拽栏（v5.1：按住标题栏可拖动整个面板）
    const header = document.createElement("div");
    header.className = "ta-header";
    const title = document.createElement("span");
    title.className = "ta-title";
    title.textContent = "TermAsk";
    const grip = document.createElement("span");
    grip.className = "ta-grip";
    grip.textContent = "⠿ 拖动";
    header.append(title, grip);

    // 2) 顶部：选中文本（2 行省略）
    const quote = document.createElement("div");
    quote.className = "ta-quote";

    // 3) 控制行：粒度下拉框 + 发送按钮
    const controls = document.createElement("div");
    controls.className = "ta-controls";

    const levelSelect = document.createElement("select");
    levelSelect.className = "ta-level";
    const LEVEL_OPTIONS: Array<{ value: Level; label: string }> = [
      { value: "L1", label: "L1 · 一句话" },
      { value: "L2", label: "L2 · 标准解释" },
      { value: "L3", label: "L3 · 给我个类比" },
      { value: "L4", label: "L4 · 小课堂" },
    ];
    for (const opt of LEVEL_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      levelSelect.appendChild(o);
    }
    levelSelect.value = "L2"; // 单一默认档＝标准解释

    const sendBtn = document.createElement("button");
    sendBtn.className = "ta-send";
    sendBtn.textContent = "发送";

    // v7：加入图谱按钮（发送按钮旁的次级动作；带暂存计数）
    const graphBtn = document.createElement("button");
    graphBtn.className = "ta-graph";
    graphBtn.textContent = "加入图谱";

    // v12：加入白板按钮（图标式；静态 SVG，非用户输入，可安全 innerHTML）
    const boardBtn = document.createElement("button");
    boardBtn.className = "ta-board";
    boardBtn.title = "加入白板：把选中词发到白板收集区";
    boardBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" stroke="#7c3aed" stroke-width="1.4"/>' +
      '<path d="M8 11v2.2M5.2 13.5h5.6" stroke="#7c3aed" stroke-width="1.4" stroke-linecap="round"/>' +
      '<path d="M4.2 8.2 6.4 6l2 1.8 3-3" stroke="#7c3aed" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>";

    controls.append(levelSelect, sendBtn, graphBtn, boardBtn);

    // v8：全文分析行——「分析当前对话」主按钮 + 「重置数字」小按钮
    const analyzeRow = document.createElement("div");
    analyzeRow.className = "ta-analyze-row";
    const analyzeBtn = document.createElement("button");
    analyzeBtn.className = "ta-analyze";
    analyzeBtn.textContent = "分析当前对话";
    analyzeBtn.title =
      "抓取本页 AI 对话全文（≤5000 字），以「全文快照」发给工作台分析";
    const resetBtn = document.createElement("button");
    resetBtn.className = "ta-reset";
    resetBtn.textContent = "⟲";
    resetBtn.title = "重置数字：清空本地暂存计数，并尝试从工作台同步最新数量";
    analyzeRow.append(analyzeBtn, resetBtn);

    // 4) 结果展示区（初始隐藏；L4 追问时内部追加气泡）
    const resultEl = document.createElement("div");
    resultEl.className = "ta-result";

    // 5) 追问行（v5 需求二：仅 L4 结果态显示）
    const followupBar = document.createElement("div");
    followupBar.className = "ta-followup";
    const followupInput = document.createElement("input");
    followupInput.className = "ta-followup-input";
    followupInput.type = "text";
    followupInput.placeholder = "继续追问…（Enter 发送）";
    followupInput.maxLength = 500;
    const followupSend = document.createElement("button");
    followupSend.className = "ta-followup-send";
    followupSend.textContent = "追问";
    followupBar.append(followupInput, followupSend);

    // 6) 底部行：撤回（发送后 2 秒内）+ 返回修改（v5 需求一）+ 关闭
    const footer = document.createElement("div");
    footer.className = "ta-footer";
    const retractBtn = document.createElement("button");
    retractBtn.className = "ta-retract";
    retractBtn.textContent = "撤回";
    retractBtn.style.display = "none";
    const backBtn = document.createElement("button");
    backBtn.className = "ta-back";
    backBtn.textContent = "返回修改";
    const closeBtn = document.createElement("button");
    closeBtn.className = "ta-close";
    closeBtn.textContent = "关闭";
    footer.append(retractBtn, backBtn, closeBtn);

    panel.append(
      header,
      quote,
      controls,
      analyzeRow,
      resultEl,
      followupBar,
      footer,
    );

    // toast
    const toast = document.createElement("div");
    toast.className = "ta-toast";

    shadow.append(chip, panel, toast);
    document.documentElement.appendChild(host);

    // ── 运行时状态 ────────────────────────────────────────────────────
    let selectedText = "";
    let lastSentText = "";
    let pos = { x: 0, y: 0 };
    let sending = false;
    let retracted = false;
    let retractTimer: number | null = null;
    // v5：多轮对话状态
    let currentLevel: Level = "L2"; // 本次首答所用粒度（决定结果态是否显示追问框）
    let chatSending = false; // 追问防重入
    let chatRounds = 0; // 已渲染的追问轮数（用于追问撤回时删气泡）
    let lastWasFollowUp = false; // 最近一次成功发送是否为追问（决定撤回回退到哪）
    let lastFollowUpText = ""; // 撤回追问后回填输入框
    // v5.1：拖拽后的面板位置（null = 未被拖过，打开时仍锚定选区）
    let draggedPos: { x: number; y: number } | null = null;
    // v7：加入图谱防重入（纯本地操作很快，但仍防双击）
    let staging = false;
    // v7：暂存区当前条数（按钮计数展示）
    let stagedCount = 0;

    // ── v10：批量学习模式——800ms 防抖缓冲区 ──────────────────────────
    // 连续划词先进缓冲区（按词去重），800ms 内无新划词才一次性提交，
    // background 逐条入暂存 + 推送，避免快速划多个词时频繁请求。
    interface BatchItem {
      term: string;
      contextText: string;
      sourceUrl: string;
      pageTitle: string;
    }
    let batchBuf: BatchItem[] = [];
    let batchFlushTimer: number | null = null;

    /** 把一次划词入缓冲区并重置防抖计时器 */
    function enqueueBatchCapture(item: BatchItem) {
      if (batchBuf.some((it) => it.term === item.term)) return; // 同词去重
      batchBuf.push(item);
      if (batchFlushTimer !== null) clearTimeout(batchFlushTimer);
      batchFlushTimer = window.setTimeout(() => void flushBatchCapture(), 800);
    }

    /** 到点提交：一次性批量交给 background（静默，仅 console 留痕） */
    async function flushBatchCapture() {
      batchFlushTimer = null;
      const items = batchBuf;
      batchBuf = [];
      if (items.length === 0) return;
      try {
        const resp = (await batchAddWords(items)) as
          | { ok: boolean; added?: number; stagedCount?: number }
          | undefined;
        if (resp?.ok) {
          if (typeof resp.stagedCount === "number") {
            stagedCount = resp.stagedCount;
            renderGraphBtn();
          }
          console.debug(
            `[TermAsk] batch captured ${resp.added ?? items.length}/${items.length} words (silent)`,
          );
        } else {
          console.warn("[TermAsk] batch capture rejected:", resp);
        }
      } catch (e) {
        console.warn("[TermAsk] batch capture failed:", e);
      }
    }

    /**
     * 点击是否发生在浮层内部。
     * closed Shadow DOM 下 composedPath() 在 host 处截断但仍包含 host，
     * 比 e.target === host 更稳——发送按钮/下拉框/追问框的点击全在 path 内。
     */
    const isInsideFloat = (e: Event) => e.composedPath().includes(host);

    // ── v7：暂存计数 → 按钮文案 ───────────────────────────────────────
    function renderGraphBtn() {
      graphBtn.textContent =
        stagedCount > 0 ? `加入图谱（${stagedCount}）` : "加入图谱";
    }

    /**
     * v8：刷新按钮计数——经 background 优先拿工作台权威数量
     * （GET /api/get-cache-count，能感知工作台侧删除/清空/合并清零），
     * 工作台离线时降级为插件本地暂存数量（source: 'local'）。
     */
    async function refreshStagedCount() {
      try {
        const resp = (await syncStagedCountMsg()) as
          | { ok: boolean; count?: number; source?: string }
          | undefined;
        if (resp?.ok && typeof resp.count === "number") {
          stagedCount = resp.count;
          renderGraphBtn();
          if (resp.source === "local") {
            console.debug(
              "[TermAsk] workbench offline, count from local staging:",
              stagedCount,
            );
          }
          return;
        }
        // 同步消息异常：兜底退回纯本地暂存查询
        const local = (await getStagingCount()) as
          | { ok: boolean; count?: number }
          | undefined;
        if (local?.ok && typeof local.count === "number") {
          stagedCount = local.count;
          renderGraphBtn();
        }
      } catch (e) {
        console.warn("[TermAsk] staged count sync failed:", e);
      }
    }
    // 注入即查询一次（跨页面累积：用户在别的页已加入过，打开新页也能看到计数）
    void refreshStagedCount();

    // ── v5.1：面板拖拽（pointer 事件 + 指针捕获） ─────────────────────
    /** 把目标坐标钳制在当前帧视口内，防止面板被拖出屏幕 */
    const clampToViewport = (x: number, y: number) => ({
      x: Math.min(
        Math.max(0, x),
        Math.max(0, window.innerWidth - panel.offsetWidth),
      ),
      y: Math.min(
        Math.max(0, y),
        Math.max(0, window.innerHeight - panel.offsetHeight),
      ),
    });

    header.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || panel.style.display === "none") return; // 仅左键、面板可见时
      e.preventDefault(); // 阻止拖拽起点触发网页文本选中（配合 CSS user-select:none）

      const rect = panel.getBoundingClientRect();
      const dx = e.clientX - rect.left; // 指针相对面板左上角的偏移，拖动全程保持
      const dy = e.clientY - rect.top;

      // 指针捕获：move/up 一律派发到 header，拖出面板/iframe 边缘也不断线；
      // 且捕获期间事件不流向 document，天然不会误触「点外部关闭」
      header.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        draggedPos = clampToViewport(ev.clientX - dx, ev.clientY - dy);
        panel.style.left = `${draggedPos.x}px`;
        panel.style.top = `${draggedPos.y}px`;
      };
      const onUp = (ev: PointerEvent) => {
        header.releasePointerCapture(ev.pointerId);
        header.removeEventListener("pointermove", onMove);
        header.removeEventListener("pointerup", onUp);
        header.removeEventListener("pointercancel", onUp);
        console.log("[TermAsk-Debug] panel dragged to", draggedPos); // left/top 已实时写入 draggedPos
      };
      header.addEventListener("pointermove", onMove);
      header.addEventListener("pointerup", onUp);
      header.addEventListener("pointercancel", onUp);
    });
    // 双击标题栏 = 放弃拖拽记忆，下次打开重新锚定选区（可选的逃生口）
    header.addEventListener("dblclick", () => {
      draggedPos = null;
      console.log("[TermAsk-Debug] dragged position reset, will anchor to selection next open",
      );
    });

    // ── 状态切换（单一入口，面板永不在这里隐藏） ──────────────────────
    function setState(state: PanelState) {
      console.log(`[TermAsk-Debug] state: ${panel.dataset.state} -> ${state}`);
      panel.dataset.state = state;
      panel.style.display = "block"; // 任何状态切换都保证面板可见
      sendBtn.disabled = state === "loading";
      levelSelect.disabled = state === "loading";
      graphBtn.disabled = state === "loading" || staging; // v7：思考中/暂存中一并锁定
      analyzeBtn.disabled = state === "loading" || staging; // v8：全文分析同锁
      boardBtn.disabled = state === "loading" || staging; // v12：白板同锁
      sendBtn.textContent = state === "loading" ? "思考中…" : "发送";
      controls.style.display = state === "result" ? "none" : "flex";
      analyzeRow.style.display = state === "result" ? "none" : "flex"; // v8
      resultEl.style.display = state === "result" ? "block" : "none";
      footer.style.display = state === "result" ? "flex" : "none";
      // v5：追问区仅「结果态 + L4 档」可见
      followupBar.style.display =
        state === "result" && currentLevel === "L4" ? "flex" : "none";
      if (state !== "result") setFollowupLoading(false);
    }

    /** 追问发送中的 UI 锁定（不改变 PanelState，面板停留在 result） */
    function setFollowupLoading(loading: boolean) {
      chatSending = loading;
      followupInput.disabled = loading;
      followupSend.disabled = loading;
      followupSend.textContent = loading ? "思考中…" : "追问";
    }

    /** 关闭面板：只有 Esc / 点外部 / 点关闭按钮 三条路径会调它 */
    const hideAll = () => {
      chip.style.display = "none";
      panel.style.display = "none";
      toast.style.display = "none";
      if (retractTimer !== null) {
        clearTimeout(retractTimer);
        retractTimer = null;
      }
    };

    const showToast = (msg: string, at?: { x: number; y: number }) => {
      const p = at ?? pos;
      toast.textContent = msg;
      toast.style.left = `${p.x}px`;
      toast.style.top = `${p.y}px`;
      toast.style.display = "block";
      setTimeout(() => (toast.style.display = "none"), 1800);
    };

    /** 撤回窗口：发送后 2 秒内可撤 */
    function startRetractWindow() {
      retractBtn.style.display = "block";
      if (retractTimer !== null) clearTimeout(retractTimer);
      retractTimer = window.setTimeout(() => {
        retractTimer = null;
        retractBtn.style.display = "none";
      }, 2000);
    }

    /** 追加一轮气泡（防崩塌：textContent 纯文本，永不 innerHTML） */
    function appendBubble(role: "user" | "ai", text: string) {
      const div = document.createElement("div");
      div.className =
        role === "user" ? "ta-msg ta-msg-user" : "ta-msg ta-msg-ai";
      div.textContent = text;
      resultEl.appendChild(div);
    }

    /**
     * 误发撤回：通知 background 剔除最后一轮。
     * - 撤回首答：UI 退回待发送态（v4 行为不变）；
     * - 撤回追问：删掉最后一对气泡、追问文本回填输入框，停留在结果态继续对话。
     */
    async function doRetract() {
      retracted = true;
      if (retractTimer !== null) {
        clearTimeout(retractTimer);
        retractTimer = null;
      }
      retractBtn.style.display = "none";
      await retractLLM();
      if (lastWasFollowUp && chatRounds > 0) {
        for (let i = 0; i < 2; i++) {
          const last = resultEl.lastElementChild;
          if (last && last.classList.contains("ta-msg"))
            resultEl.removeChild(last);
        }
        chatRounds--;
        lastWasFollowUp = chatRounds > 0;
        followupInput.value = lastFollowUpText;
        showToast("已撤回上一轮追问");
      } else {
        quote.textContent = lastSentText;
        setState("edit");
      }
    }
    retractBtn.addEventListener("click", doRetract);

    // v5 需求一：返回修改——切回 edit，selectedText 与 levelSelect.value 本就保留，
    // resultEl 内容保留到下次发送覆盖（体验更顺，不清空）
    backBtn.addEventListener("click", () => {
      quote.textContent = selectedText;
      setState("edit");
    });

    // ── 划词 → 批量模式静默收集 / 手动模式显示芯片 ─────────────────────
    document.addEventListener("mouseup", (e) => {
      // 浮层内的鼠标抬起不触发划词逻辑
      if (isInsideFloat(e)) return;

      setTimeout(() => {
        let sel: Selection | null = null;
        try {
          sel = window.getSelection();
        } catch {
          sel = null;
        }
        // 选区 API 直接抛异常（极少数自定义渲染页）：告警一次，不刷屏
        if (!sel) {
          if (!warnedSelection) {
            warnedSelection = true;
            console.warn(
              "[TermAsk] 选区获取失败：页面可能用了 closed Shadow DOM 或自定义选择渲染（如 canvas/PDF 阅读器），浮层在此页不生效",
            );
          }
          return;
        }
        const text = sel.toString().trim();
        if (!text || text.length > 120 || sel.rangeCount === 0) {
          chip.style.display = "none";
          return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        selectedText = text;
        pos = { x: rect.right, y: rect.bottom + 8 };
        const selection = sel; // 供异步闭包使用（let 不会携带类型收窄）

        // v11：先查批量模式（background 只读 storage，毫秒级）——
        // 批量模式下【完全不弹任何浮层】，直接静默入防抖缓冲区；
        // 非批量模式才显示芯片（锚定选区右下角）。
        void (async () => {
          let batch = false;
          try {
            const resp = (await batchModeCheck()) as
              | { ok: boolean; enabled?: boolean }
              | undefined;
            batch = resp?.ok === true && resp.enabled === true;
          } catch {
            // 查询失败按非批量处理，走原芯片链路
          }

          if (batch) {
            chip.style.display = "none";
            enqueueBatchCapture({
              term: text,
              contextText: extractContextText(selection, text),
              sourceUrl: location.href,
              pageTitle: document.title,
            });
            return;
          }

          chip.style.left = `${pos.x}px`;
          chip.style.top = `${pos.y}px`;
          chip.style.display = "block";
        })();
      }, 0); // 等选区稳定后再读
    });

    // ── 点芯片 → 展开面板（待发送态） ─────────────────────────────────
    chip.addEventListener("click", () => {
      console.log("[TermAsk-Debug] chip clicked, opening panel, text =",
        selectedText,
      );
      chip.style.display = "none";
      quote.textContent = selectedText;
      resultEl.textContent = ""; // 清空上次结果/气泡，原地替换不追加
      chatRounds = 0;
      lastWasFollowUp = false;
      followupInput.value = "";
      // v5.1：若用户拖拽过面板，则保持上次拖拽位置；否则锚定选区右下角
      const anchor = draggedPos ?? pos;
      panel.style.left = `${anchor.x}px`;
      panel.style.top = `${anchor.y}px`;
      setState("edit");
    });

    // ── 发送（首答）→ 思考中 → 结果展示 ───────────────────────────────
    const doSend = async () => {
      const text = selectedText.trim();
      console.log("[TermAsk-Debug] send clicked, text =",
        text,
        ", level =",
        levelSelect.value,
        ", sending =",
        sending,
      );
      if (!text || sending) {
        console.warn(
          "[TermAsk] doSend early-return: text empty =",
          !text,
          ", sending =",
          sending,
        );
        return;
      }
      sending = true;
      retracted = false;
      lastSentText = text;
      currentLevel = levelSelect.value as Level; // v5：记录首答粒度

      setState("loading"); // 按钮变"思考中…"，面板绝不隐藏
      startRetractWindow();

      try {
        const resp = (await callLLM(text, currentLevel)) as
          | { ok: boolean; reply?: string; error?: string }
          | undefined;

        console.log("[TermAsk-Debug] response received:",
          resp?.ok ? `ok, reply ${resp.reply?.length ?? 0} chars` : resp,
        );
        if (retracted) {
          console.log("[TermAsk-Debug] response discarded (retracted)");
          return;
        }

        if (resp?.ok) {
          // 防崩塌：textContent + pre-wrap 纯文本渲染，模型输出永不作 HTML 解析
          // 首答保持「原地替换」：整体覆盖（连带清掉上一轮的气泡）
          resultEl.textContent = resp.reply ?? "";
          chatRounds = 0;
          lastWasFollowUp = false;
          followupInput.value = "";
          setState("result"); // 内部已强制 panel.style.display='block'
        } else {
          setState("edit");
          showToast(`发送失败：${describeLLMError(resp?.error)}`);
        }
      } catch (e) {
        if (!retracted) {
          setState("edit");
          showToast(`发送失败：${describeExtensionError(e)}`);
          console.warn("[TermAsk] callLLM failed:", e);
        }
      } finally {
        sending = false;
      }
    };
    sendBtn.addEventListener("click", doSend);

    // ── v7：加入图谱（选中词 + 上下文 → 插件暂存区 + 工作台暂存接口） ──
    // 不再触发 LLM 抽取/直接推送：先积累，后合并（合并由工作台或
    // GRAPH_MERGE_REQUEST 在暂存 ≥2 条时触发）。
    const doAddToGraph = async () => {
      const text = selectedText.trim();
      if (!text || staging) return;

      staging = true;
      graphBtn.disabled = true;
      analyzeBtn.disabled = true; // v8：暂存期间全文分析同锁
      boardBtn.disabled = true; // v12：白板同锁
      graphBtn.textContent = "加入中…";
      sendBtn.disabled = true;
      levelSelect.disabled = true;

      try {
        let sel: Selection | null = null;
        try {
          sel = window.getSelection();
        } catch {
          sel = null;
        }
        const contextText = sel ? extractContextText(sel, text) : text;

        const resp = (await addToGraphStaging({
          term: text,
          contextText,
          sourceUrl: location.href,
          pageTitle: document.title,
        })) as
          | {
              ok: boolean;
              stagedCount?: number;
              isNew?: boolean;
              pushed?: boolean;
              error?: string;
            }
          | undefined;
        console.log("[TermAsk-Debug] add-to-graph response:", resp);

        if (resp?.ok) {
          stagedCount = resp.stagedCount ?? stagedCount + 1;
          renderGraphBtn();
          // toast 锚定面板下缘，提示紧挨触发它的浮层；
          // pushed=false = 已本地暂存但工作台未连接，明确告知用户而不是静默
          const rect = panel.getBoundingClientRect();
          showToast(
            resp.pushed === false
              ? "已加入暂存区（工作台未连接，请先打开工作台）"
              : "已加入暂存区，请去工作台查看",
            { x: rect.left, y: rect.bottom + 8 },
          );
        } else {
          showToast(`加入失败：${resp?.error ?? "未知错误"}`);
        }
      } catch (e) {
        showToast(`加入失败：${describeExtensionError(e)}`);
        console.warn("[TermAsk] addToGraphStaging failed:", e);
      } finally {
        staging = false;
        renderGraphBtn();
        // 面板若已被关掉（Esc/点外部），无需恢复 UI；仅在仍可见时解锁
        if (panel.style.display !== "none" && panel.dataset.state === "edit") {
          graphBtn.disabled = false;
          analyzeBtn.disabled = false; // v8
          boardBtn.disabled = false; // v12
          sendBtn.disabled = false;
          levelSelect.disabled = false;
        }
        // 推送后重新同步一次（工作台在线时以权威数量为准）
        void refreshStagedCount();
      }
    };
    graphBtn.addEventListener("click", doAddToGraph);

    // ── v12：加入白板（选中词 + 上下文 → target="whiteboard"） ─────────
    // 链路与「加入图谱」完全一致，仅 target 不同：background 透传到
    // POST /api/add-to-graph，后端分发到白板暂存区（whiteboard-word 事件）。
    const doAddToBoard = async () => {
      const text = selectedText.trim();
      if (!text || staging) return;

      staging = true;
      boardBtn.disabled = true;
      graphBtn.disabled = true;
      analyzeBtn.disabled = true;
      sendBtn.disabled = true;
      levelSelect.disabled = true;
      const prevTitle = boardBtn.title;
      boardBtn.title = "加入中…";

      try {
        let sel: Selection | null = null;
        try {
          sel = window.getSelection();
        } catch {
          sel = null;
        }
        const contextText = sel ? extractContextText(sel, text) : text;

        const resp = (await addToGraphStaging({
          term: text,
          contextText,
          sourceUrl: location.href,
          pageTitle: document.title,
          target: "whiteboard",
        })) as
          | { ok: boolean; pushed?: boolean; error?: string }
          | undefined;
        console.log("[TermAsk-Debug] add-to-board response:", resp);

        if (resp?.ok) {
          const rect = panel.getBoundingClientRect();
          showToast(
            resp.pushed === false
              ? "已加入白板收集区（工作台未连接，请先打开工作台）"
              : "已加入白板收集区，请去工作台白板查看",
            { x: rect.left, y: rect.bottom + 8 },
          );
        } else {
          showToast(`加入白板失败：${resp?.error ?? "未知错误"}`);
        }
      } catch (e) {
        showToast(`加入白板失败：${describeExtensionError(e)}`);
        console.warn("[TermAsk] addToGraphStaging(board) failed:", e);
      } finally {
        staging = false;
        boardBtn.title = prevTitle;
        if (panel.style.display !== "none" && panel.dataset.state === "edit") {
          boardBtn.disabled = false;
          graphBtn.disabled = false;
          analyzeBtn.disabled = false;
          sendBtn.disabled = false;
          levelSelect.disabled = false;
        }
      }
    };
    boardBtn.addEventListener("click", doAddToBoard);

    // ── v8.1：分析当前对话（抓取整页 AI 对话 → __FULL_CONTEXT__ 快照推送） ──
    const doAnalyzePage = async () => {
      if (staging) return;
      const chatText = extractChatText();
      if (!chatText || chatText.trim().length < 10) {
        showToast("未抓取到对话内容（本页可能不是 AI 对话页）");
        return;
      }

      staging = true;
      analyzeBtn.disabled = true;
      graphBtn.disabled = true;
      sendBtn.disabled = true;
      levelSelect.disabled = true;
      const prevLabel = analyzeBtn.textContent;
      analyzeBtn.textContent = `抓取中…（${chatText.length} 字）`;

      try {
        const resp = (await analyzePageChat({
          chatText,
          sourceUrl: location.href,
          pageTitle: document.title,
        })) as
          | {
              ok: boolean;
              fullContext?: boolean;
              stagedCount?: number;
              pushed?: boolean;
              error?: string;
            }
          | undefined;
        console.log("[TermAsk-Debug] analyze-page response:", resp);

        if (resp?.ok) {
          // v8.1：全文走 __FULL_CONTEXT__ 快照，不占普通暂存计数——
          // stagedCount 是 background 回传的当前普通词条数（不会 +1）
          if (typeof resp.stagedCount === "number") {
            stagedCount = resp.stagedCount;
          }
          renderGraphBtn();
          const rect = panel.getBoundingClientRect();
          showToast(
            resp.pushed === false
              ? "全文快照已保存（工作台未连接，请先打开工作台）"
              : "全文快照已发送，请去工作台查看",
            { x: rect.left, y: rect.bottom + 8 },
          );
        } else {
          showToast(`分析失败：${resp?.error ?? "未知错误"}`);
        }
      } catch (e) {
        showToast(`分析失败：${describeExtensionError(e)}`);
        console.warn("[TermAsk] analyzePageChat failed:", e);
      } finally {
        staging = false;
        analyzeBtn.textContent = prevLabel;
        renderGraphBtn();
        if (panel.style.display !== "none" && panel.dataset.state === "edit") {
          analyzeBtn.disabled = false;
          graphBtn.disabled = false;
          sendBtn.disabled = false;
          levelSelect.disabled = false;
        }
        // 推送后重新同步一次（工作台在线时以权威数量为准）
        void refreshStagedCount();
      }
    };
    analyzeBtn.addEventListener("click", doAnalyzePage);

    // ── v8：重置数字（清空本地暂存计数 + 重新同步工作台数量） ───────────
    resetBtn.addEventListener("click", async () => {
      try {
        const resp = (await resetStagedCountMsg()) as
          | { ok: boolean; count?: number; source?: string }
          | undefined;
        if (resp?.ok && typeof resp.count === "number") {
          stagedCount = resp.count;
          renderGraphBtn();
          showToast(
            resp.source === "workbench"
              ? `已重置，工作台当前 ${stagedCount} 条`
              : "已重置（工作台未连接，本地计数已清零）",
          );
        } else {
          showToast("重置失败");
        }
      } catch (e) {
        showToast(`重置失败：${describeExtensionError(e)}`);
        console.warn("[TermAsk] reset count failed:", e);
      }
    });

    // ── v5 需求二：L4 追问（多轮对话，气泡追加） ──────────────────────
    const doFollowUp = async () => {
      const q = followupInput.value.trim();
      console.log("[TermAsk-Debug] followup clicked, q =",
        q,
        ", chatSending =",
        chatSending,
      );
      if (!q || chatSending) return;
      retracted = false;

      setFollowupLoading(true); // 停留在 result 态，仅锁定追问行
      startRetractWindow();

      try {
        // 追问仍走 LLM_REQUEST：background 的 messages = [system(L4), ...ctx, userMsg]，
        // ctx 已含首答及历史追问轮次，天然形成多轮；无需新增消息类型
        const resp = (await callLLM(q, "L4")) as
          | { ok: boolean; reply?: string; error?: string }
          | undefined;

        console.log("[TermAsk-Debug] followup response:",
          resp?.ok ? `ok, reply ${resp.reply?.length ?? 0} chars` : resp,
        );
        if (retracted) {
          console.log("[TermAsk-Debug] followup response discarded (retracted)");
          return;
        }

        if (resp?.ok) {
          appendBubble("user", q);
          appendBubble("ai", resp.reply ?? "");
          chatRounds++;
          lastWasFollowUp = true;
          lastFollowUpText = q;
          followupInput.value = "";
          resultEl.scrollTop = resultEl.scrollHeight; // 滚到最新一轮
        } else {
          showToast(`追问失败：${describeLLMError(resp?.error)}`);
        }
      } catch (e) {
        if (!retracted) {
          showToast(`追问失败：${describeExtensionError(e)}`);
          console.warn("[TermAsk] followup callLLM failed:", e);
        }
      } finally {
        setFollowupLoading(false);
        if (panel.dataset.state === "result") followupInput.focus();
      }
    };
    followupSend.addEventListener("click", doFollowUp);
    followupInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doFollowUp();
      if (e.key === "Escape") e.stopPropagation(); // 输入框内 Esc 只失焦语义，不关面板
    });

    // ── v9：快捷键选区应答（无感收集器·第一阶段） ──────────────────────
    // background 收到 Alt+Shift+A 后经 tabs.sendMessage 询问本帧选区。
    // 仅持有非空选区的 frame 回包：多 frame 竞争时真正划词的那一帧获胜，
    // 无人应答（没划词 / 特权页）则 background 静默无操作。
    // 同步读选区 + 同步 sendResponse，无需 return true 保持通道。
    browser.runtime.onMessage.addListener(
      (
        msg: ExtensionMessage | undefined,
        _sender: Browser.runtime.MessageSender,
        sendResponse: (response?: any) => void,
      ): undefined => {
        if (msg?.type !== "QUICK_ADD_GET") return undefined;
        let term = "";
        let contextText = "";
        try {
          const sel = window.getSelection();
          term = (sel?.toString() ?? "").trim();
          if (term && sel) contextText = extractContextText(sel, term);
        } catch {
          // 选区 API 异常（closed Shadow DOM / canvas 渲染页）：视为无选区
        }
        // 划词长度上限与浮层链路一致（>120 视为误选大段文本，不收）
        if (!term || term.length > 120) return undefined;
        sendResponse({
          ok: true,
          term,
          contextText,
          sourceUrl: location.href,
          pageTitle: document.title,
        });
        return undefined;
      },
    );

    // ── 关闭：只有三条路径 ────────────────────────────────────────────
    // ① 结果态的「关闭」按钮
    closeBtn.addEventListener("click", hideAll);
    // ② Esc 键
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideAll();
    });
    // ③ 点击面板外部的网页空白处（浮层内部点击一律不触发）
    document.addEventListener("mousedown", (e) => {
      if (isInsideFloat(e)) return;
      chip.style.display = "none";
      panel.style.display = "none";
    });
  },
});
