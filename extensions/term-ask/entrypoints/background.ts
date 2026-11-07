import { defineBackground } from "wxt/utils/define-background";
// WXT 最佳实践：统一走 browser.*（wxt/browser 显式导入，类型来自
// @wxt-dev/browser 的 Promise 化 API 定义），不再依赖 @types/chrome 的
// chrome.* 命名空间；browser.* 同时兼容 Chrome/Edge/Firefox。
import { browser, type Browser } from "wxt/browser";

/**
 * 阶段1极简验证：API 直连（OpenAI 兼容协议，默认 DeepSeek）
 * 关键约束（来自《开发执行决议单》）：
 *  - API 直连，不做浏览器桥接；
 *  - 上一次请求的完整 messages 保存在内存，作为后续「误发撤回」的基座；
 *  - messages 可完整外部构造（硬门槛），system prompt 由我们固定，不接受页面注入。
 *
 * v7 变更：图谱流程从「点按钮直接 LLM 抽取 + 推送」改为「先暂存、后合并」：
 *  - 新增暂存区：browser.storage.local key = 'termask_graph_staging'，
 *    每条 { id, term, contextText, sourceUrl, pageTitle, addedAt }，按 term 去重；
 *    LocalStorage 跨页面/跨标签页持久 → 支持"跨页面连续划词"积累术语；
 *  - 新增消息 ADD_TO_GRAPH_REQUEST：暂存 + 尽力 POST
 *    http://127.0.0.1:17570/api/add-to-graph（工作台离线时仅本地暂存，
 *    返回 pushed:false，不算失败）；
 *  - 新增消息 GRAPH_STAGING_GET / GRAPH_STAGING_CLEAR：查询条数 / 清空暂存区；
 *  - 新增消息 GRAPH_MERGE_REQUEST：暂存 ≥2 条时，把全部暂存条目（术语+上下文）
 *    交给 LLM 抽取概念关系 → 推送 /api/concept-graph（工作台 GraphPage 渲染），
 *    成功后清空暂存区；
 *  - 删除旧 GRAPH_REQUEST 直接生成路径（按钮已改为「加入图谱」）。
 *
 * v8 变更：全文抓取 + 计数同步：
 *  - 新增消息 ANALYZE_PAGE_REQUEST：接收 content script 抓到的整段 AI 对话
 *    文本（≤5000 字），以特殊标记 term='__FULL_CONTEXT__' POST
 *    /api/add-to-graph——后端识别标记后存为「待分析的全文快照」，
 *    不作为普通词汇入暂存列表（v8.1 语义，本地同样分流存独立槽位）；
 *  - 新增消息 GRAPH_CACHE_COUNT_GET：计数同步——优先 GET
 *    http://127.0.0.1:17570/api/get-cache-count 拿工作台权威数量（能感知
 *    工作台侧删除/清空/合并），离线时降级为本地暂存计数；
 *  - 新增消息 GRAPH_COUNT_RESET：「重置数字」小按钮——清空本地暂存区
 *    后重新同步，返回 source: 'workbench' | 'local' 供 UI 区分提示。
 *
 * v8.2 变更（本版）：chrome.* → browser.*（WXT 最佳实践）：
 *  - 所有扩展 API 调用改为 wxt/browser 的 browser.*（Promise 化、多浏览器兼容）；
 *  - onMessage 监听器参数显式标类型，修复 TS 隐式 any 推导报错；
 *  - 消息契约不变：content script 侧的 chrome.runtime.sendMessage 回调式调用
 *    与 browser.* 监听器完全兼容，无需同步修改 content.ts。
 *
 * v9 变更（本版）：无感收集器·第一阶段（快捷键）：
 *  - manifest.commands 注册两个快捷键（见 wxt.config.ts）：
 *      Alt+Shift+A「termask-quick-add」：划词后按下 → 不弹任何浮层，
 *        后台向当前标签页 content script 要选区（QUICK_ADD_GET），
 *        复用 addToGraphStaging 静默加入本地暂存区并推送工作台；
 *      Alt+Shift+Z「termask-undo-last」：删除最后加入的词——本地暂存
 *        pop + 尽力 POST 工作台 /api/remove-last（Rust 端弹出最后一个
 *        词条并广播 staged-word-removed 事件），两处都静默无 UI。
 *  - 仅持有选区的 frame 应答 QUICK_ADD_GET（无选区不回包，多 frame
 *    竞争时天然让位于真正划词的那一帧）；非内容页（chrome:// 等）
 *    sendMessage 抛错被吞掉，快捷键静默无操作。
 *  - 第二阶段（批量学习模式）待工作台指令通道就绪后另行接入。
 *
 * v10 变更（本版）：无感收集器·第二阶段（批量学习模式）：
 *  - 工作台 GraphPage 开关 → Rust Arc<AtomicBool> → GET /api/batch-mode；
 *  - background 维护带 TTL 的缓存 isBatchMode()（≤8s 直接用缓存；过期或
 *    划词时按需刷新，工作台在线时体验"准实时"；离线一律视为关闭）；
 *  - browser.alarms 每 30s 刷新缓存兜底（MV3 SW 会休眠，alarm 是唯一
 *    可靠的定时器；需 "alarms" 权限）；
 *  - 新消息 BATCH_MODE_CHECK：content script 划词时询问是否批量模式；
 *  - 新消息 BATCH_ADD_WORDS：content script 的 800ms 防抖缓冲区到点后
 *    批量提交，逐条复用 addToGraphStaging（本地去重 + 尽力推送）。
 *
 * v11 变更（本版）：批量模式开关收敛到插件端 storage.local（单一事实源）：
 *  - 新快捷键 termask-toggle-batch（Ctrl+Shift+B）：切换 browser.storage.local
 *    的 termask_batch_mode，并尽力 POST /api/batch-mode 回推工作台对齐；
 *  - 撤销快捷键按需求改为 Ctrl+Shift+Z（原 Alt+Shift+Z）；
 *  - alarm 轮询改为"工作台 → 插件"单向同步：工作台开关变化写入本地
 *    storage（30s 内生效）；本地状态是唯一事实源，content script 的
 *    BATCH_MODE_CHECK 查询只读 storage，毫秒级响应、零网络等待；
 *  - 批量模式下划词【完全不弹浮层】（芯片也不显示）——content script
 *    先查批量状态再决定走静默收集还是显示芯片。
 *
 * v12 变更（本版）：白板互通——payload 增加 target 字段：
 *  - ADD_TO_GRAPH_REQUEST / addToGraphStaging 接受 target（"graph" 默认 |
 *    "whiteboard"），透传到 POST /api/add-to-graph 的 body；
 *  - 本地暂存条目记录 target，去重键改为 term+target（同一个词可以同时
 *    加入图谱与白板，互不覆盖）；
 *  - 后端按 target 分发：graph → staged 列表 + "staged-word" 事件；
 *    whiteboard → 白板暂存区 + "whiteboard-word" 事件（白板页监听）。
 */

/** content script → background 消息的宽松契约（payload 各消息自定义） */
interface ExtensionMessage {
  type?: string;
  payload?: any;
}

/** background → content script 的响应回调签名 */
type SendResponse = (response?: any) => void;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── 会话上下文：storage.session ─────────────────────────────────────
// MV3 service worker 随时休眠，纯内存变量会丢；storage.session 是内存级存储，
// 可跨 SW 重启存活，浏览器关闭即清，正好匹配「会话级上下文」语义。
// 仅需 manifest 的 "storage" 权限（已在 wxt.config.ts 声明），无额外权限。
const SESSION_KEY = "termask_ctx";

async function getContext(): Promise<ChatMessage[]> {
  const data = await browser.storage.session.get(SESSION_KEY);
  return (data[SESSION_KEY] as ChatMessage[] | undefined) ?? [];
}

async function saveContext(ctx: ChatMessage[]): Promise<void> {
  await browser.storage.session.set({ [SESSION_KEY]: ctx });
}

/** 追加一轮问答到会话上下文 */
async function pushRound(
  user: ChatMessage,
  assistant: ChatMessage,
): Promise<void> {
  const ctx = await getContext();
  ctx.push(user, assistant);
  await saveContext(ctx);
}

/**
 * 误发撤回：剔除上下文末尾最后一轮（user + assistant 各一条）。
 * 返回 true＝撤回成功；false＝上下文为空，无可撤回。
 * 撤回后下一次请求自然以剔除后的上下文重构 messages。
 */
async function retractLastRound(): Promise<boolean> {
  const ctx = await getContext();
  if (ctx.length < 2) return false;
  ctx.splice(-2, 2);
  await saveContext(ctx);
  return true;
}

// 上一次请求的完整 messages 快照（含 system），仅用于调试核对，不参与撤回逻辑
let lastRequestMessages: ChatMessage[] | null = null;

// 撤回竞态：请求在飞行中被撤回时，响应到达后不再把本轮写入上下文
let requestSeq = 0;
let retractedRequestId = 0;

// L1–L4 四档独立 output_contract（各自完整 prompt，禁用同一 prompt 加长度参数拼接）
const LEVEL_PROMPTS: Record<string, string> = {
  L1: "你是极简术语解释助手。只给最小必要信息，不超过 30 字，不举例，不展开，不追问。",
  L2:
    "你是术语解释助手。用一段连贯、通俗的中文解释用户问的词，最多 100 字，" +
    "必须锚回用户给出的原文语境，不追问，不展开。",
  L3:
    "你是类比解释助手。用生活中常见的现象作类比来解释用户问的词，" +
    "不要用专业术语解释专业术语，不超过 120 字。",
  L4:
    "你是小课堂讲师。分点结构化解释用户问的词（每点一行，以「- 」开头），" +
    "并在末尾提供一行「引导提问：…」，帮助用户继续追问。",
};

function getSystemPrompt(level: string): string {
  return LEVEL_PROMPTS[level] ?? LEVEL_PROMPTS.L2; // 单一默认档＝L2 标准解释
}

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-chat",
};

export default defineBackground(() => {
  // ── v11：批量学习模式——alarm 兜底轮询（工作台 → 插件单向同步） ─────
  // MV3 service worker 会休眠，setInterval 不可靠；browser.alarms 是唯一
  // 可靠定时器（最小周期 0.5 分钟）。工作台开关变化 30s 内写入本地 storage。
  browser.alarms.create(BATCH_POLL_ALARM, { periodInMinutes: 0.5 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BATCH_POLL_ALARM) {
      void syncBatchModeFromWorkbench();
    }
  });

  // ── v9/v11：快捷键命令分发（无感收集器） ───────────────────────────
  browser.commands.onCommand.addListener((command: string) => {
    console.debug("[TermAsk/bg] command:", command);
    if (command === "termask-quick-add") {
      quickAddFromSelection().catch((err) =>
        console.warn("[TermAsk/bg] quick-add failed:", err),
      );
    } else if (command === "termask-undo-last") {
      undoLastStaged().catch((err) =>
        console.warn("[TermAsk/bg] undo-last failed:", err),
      );
    } else if (command === "termask-toggle-batch") {
      toggleBatchMode().catch((err) =>
        console.warn("[TermAsk/bg] toggle-batch failed:", err),
      );
    }
  });

  // 显式类型：修复 msg / sender / sendResponse 的 TS 隐式 any 报错。
  // 返回 true 表示异步 sendResponse（保持消息通道），未命中的消息返回 undefined。
  browser.runtime.onMessage.addListener(
    (
      msg: ExtensionMessage | undefined,
      _sender: Browser.runtime.MessageSender,
      sendResponse: SendResponse,
    ): boolean | undefined => {
      if (msg?.type === "LLM_RETRACT") {
        // 双保险：标记飞行中请求（响应到达后不入库）+ 剔除已入库的最后一轮
        retractedRequestId = requestSeq;
        retractLastRound()
          .then((done) => sendResponse({ ok: true, retracted: done }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      if (msg?.type === "ADD_TO_GRAPH_REQUEST") {
        // v7 加入图谱 / v12 白板互通：暂存（LocalStorage 去重追加）+
        // 尽力转发工作台 /api/add-to-graph；target 决定工作台分发去向
        addToGraphStaging({
          term: String(msg.payload?.term ?? ""),
          contextText: String(msg.payload?.contextText ?? ""),
          sourceUrl: String(msg.payload?.sourceUrl ?? ""),
          pageTitle: String(msg.payload?.pageTitle ?? ""),
          target: msg.payload?.target === "whiteboard" ? "whiteboard" : "graph",
        })
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      if (msg?.type === "GRAPH_STAGING_GET") {
        getStaging()
          .then((items) =>
            sendResponse({ ok: true, count: items.length, items }),
          )
          .catch((err) =>
            sendResponse({ ok: false, count: 0, error: String(err) }),
          );
        return true;
      }
      if (msg?.type === "GRAPH_STAGING_CLEAR") {
        clearStaging()
          .then(() => sendResponse({ ok: true, count: 0 }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      if (msg?.type === "GRAPH_MERGE_REQUEST") {
        // v7 合并生成：读暂存区（≥2 条）→ LLM 抽取概念关系 → 推送 /api/concept-graph
        // → 成功后清空暂存区
        mergeGraphFromStaging()
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      if (msg?.type === "ANALYZE_PAGE_REQUEST") {
        // v8.1 全文快照：整段对话文本以 __FULL_CONTEXT__ 标记推送，
        // 后端存为「待分析的全文快照」，不入普通词条列表
        stageFullText({
          chatText: String(msg.payload?.chatText ?? ""),
          sourceUrl: String(msg.payload?.sourceUrl ?? ""),
          pageTitle: String(msg.payload?.pageTitle ?? ""),
        })
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      if (msg?.type === "GRAPH_CACHE_COUNT_GET") {
        // v8 计数同步：工作台权威数量优先，离线降级本地暂存计数
        syncStagedCount()
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      if (msg?.type === "GRAPH_COUNT_RESET") {
        // v8 重置数字：清空本地暂存区后重新同步（重置按钮专用）
        (async () => {
          await clearStaging();
          return syncStagedCount();
        })()
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      if (msg?.type === "BATCH_MODE_CHECK") {
        // v11 批量模式：content script 划词时询问——只读本地 storage，
        // 毫秒级响应（事实源见 BATCH_MODE_STORAGE_KEY，离线也有值）
        getLocalBatchMode()
          .then((enabled) => sendResponse({ ok: true, enabled }))
          .catch(() => sendResponse({ ok: true, enabled: false }));
        return true;
      }
      if (msg?.type === "BATCH_ADD_WORDS") {
        // v10 批量提交：content script 防抖缓冲区到点后批量入暂存
        const raw = Array.isArray(msg.payload?.items) ? msg.payload.items : [];
        const items = raw
          .slice(0, 20) // 单批上限：防失控
          .map((it: any) => ({
            term: String(it?.term ?? ""),
            contextText: String(it?.contextText ?? ""),
            sourceUrl: String(it?.sourceUrl ?? ""),
            pageTitle: String(it?.pageTitle ?? ""),
          }))
          .filter((it: { term: string }) => it.term);
        Promise.all(
          items.map(
            (it: {
              term: string;
              contextText: string;
              sourceUrl: string;
              pageTitle: string;
            }) => addToGraphStaging(it),
          ),
        )
          .then((results) => {
            const added = results.filter((r) => r?.ok).length;
            const last = results[results.length - 1];
            sendResponse({
              ok: true,
              added,
              stagedCount: last?.stagedCount,
            });
          })
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      if (msg?.type !== "LLM_REQUEST") return undefined;
      callLLM(
        String(msg.payload?.text ?? ""),
        String(msg.payload?.level ?? "L1"),
      )
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // 保持消息通道，异步 sendResponse
    },
  );
});

// ── v9：无感收集器·快捷键（第一阶段） ────────────────────────────────

/** 取当前活动标签页（无需 "tabs" 权限：active/currentWindow 查询不读 url） */
async function getActiveTab() {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab ?? null;
}

/**
 * Alt+Shift+A：无感加入图谱。
 *  1. 向活动标签页的 content script 要选区（QUICK_ADD_GET，仅持有选区的
 *     frame 会应答；无人应答 / 非内容页 → 静默无操作）；
 *  2. 复用 addToGraphStaging：本地暂存去重 + 尽力 POST 工作台。
 * 全程不弹任何浮层，仅 console 留痕。
 */
async function quickAddFromSelection(): Promise<void> {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  let sel:
    | {
        ok?: boolean;
        term?: string;
        contextText?: string;
        sourceUrl?: string;
        pageTitle?: string;
      }
    | undefined;
  try {
    sel = (await browser.tabs.sendMessage(tab.id, {
      type: "QUICK_ADD_GET",
    })) as typeof sel;
  } catch {
    // 非内容页（chrome://、商店页等）没有 content script：静默退出
    console.debug("[TermAsk/bg] quick-add: no content script in tab", tab.id);
    return;
  }
  if (!sel?.ok || !sel.term) {
    console.debug("[TermAsk/bg] quick-add: no selection");
    return;
  }

  const resp = await addToGraphStaging({
    term: sel.term,
    contextText: sel.contextText ?? sel.term,
    sourceUrl: sel.sourceUrl ?? "",
    pageTitle: sel.pageTitle ?? "",
  });
  console.debug('[TermAsk/bg] quick-add staged "%s": %o', sel.term, resp);
}

/**
 * Ctrl+Shift+Z：删除最后加入的词。
 *  1. 本地暂存区弹出最后一个词条（空则无操作）；
 *  2. target="graph" 时尽力 POST 工作台 /api/remove-last 同步删除
 *     （Rust 端 pop + 广播 staged-word-removed 事件）；
 *     target="whiteboard" 时仅删本地（工作台白板暂存暂无删除路由，
 *     待白板模块提供后接入）。
 * 全程静默无 UI。
 */
async function undoLastStaged(): Promise<void> {
  const items = await getStaging();
  const last = items.pop();
  if (!last) {
    console.debug("[TermAsk/bg] undo-last: staging empty");
    return;
  }
  await saveStaging(items);
  console.debug(
    '[TermAsk/bg] undo-last removed "%s" (target=%s) locally',
    last.term,
    last.target,
  );

  // v13：白板收集区也有远端删除路由（?target=whiteboard），两条链路一致
  const removeUrl = `${REMOVE_LAST_ENDPOINT}?target=${encodeURIComponent(last.target)}`;
  try {
    const resp = await bridgeFetch(removeUrl, { method: "POST" });
    const detail = await resp.text().catch(() => "");
    if (resp.ok) {
      console.debug("[TermAsk/bg] undo-last workbench:", detail);
    } else {
      console.error(
        `PUSH_ERROR undo-last HTTP ${resp.status}:`,
        detail.slice(0, 200),
      );
    }
  } catch (err) {
    // 工作台离线：本地已删，远端下次对账时对齐
    console.error("PUSH_ERROR undo-last", err);
  }
}

// ── v11：批量学习模式（storage.local 单一事实源 + 双向同步） ─────────

/** 读本地批量模式开关（storage.local，毫秒级，无网络） */
async function getLocalBatchMode(): Promise<boolean> {
  const data = await browser.storage.local.get(BATCH_MODE_STORAGE_KEY);
  return data[BATCH_MODE_STORAGE_KEY] === true;
}

/** 写本地批量模式开关 */
async function setLocalBatchMode(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [BATCH_MODE_STORAGE_KEY]: enabled });
}

/**
 * 工作台 → 插件 单向同步（alarm 每 30s 兜底）：
 * 工作台 GraphPage 开关状态写入本地 storage，工作台切换 30s 内对插件生效。
 * 离线时保留本地状态不动。
 */
async function syncBatchModeFromWorkbench(): Promise<void> {
  try {
    const resp = await bridgeFetch(BATCH_MODE_ENDPOINT, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) {
      console.error(`PUSH_ERROR batch-mode sync HTTP ${resp.status}`);
      return;
    }
    const data = (await resp.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    const remote = data?.enabled === true;
    const local = await getLocalBatchMode();
    if (remote !== local) {
      await setLocalBatchMode(remote);
      console.debug("[TermAsk/bg] batch-mode synced from workbench:", remote);
    }
  } catch (err) {
    // 工作台离线是常态：保留本地状态
    console.debug("[TermAsk/bg] batch-mode sync offline:", String(err));
  }
}

/**
 * 插件 → 工作台 单向回推（快捷键切换后尽力 POST）：
 * 对齐工作台侧状态（GraphPage 下次读取时显示一致）。
 */
async function pushBatchModeToWorkbench(enabled: boolean): Promise<void> {
  try {
    const resp = await bridgeFetch(BATCH_MODE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(
        `PUSH_ERROR batch-mode push HTTP ${resp.status}:`,
        detail.slice(0, 200),
      );
    }
  } catch (err) {
    // 工作台离线：本地已生效，回推失败不影响插件行为
    console.debug("[TermAsk/bg] batch-mode push offline:", String(err));
  }
}

/** Ctrl+Shift+B：切换批量模式（写 storage + 尽力回推工作台；全程无 UI） */
async function toggleBatchMode(): Promise<void> {
  const next = !(await getLocalBatchMode());
  await setLocalBatchMode(next);
  console.debug("[TermAsk/bg] batch-mode toggled ->", next);
  void pushBatchModeToWorkbench(next);
}

/**
 * 读取桥接令牌（可空）。返回的请求头会被所有桥接 fetch 复用。
 * 注意：带自定义头会触发 CORS 预检，工作台的 CorsLayer 已放行该头。
 */
async function bridgeHeaders(
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  try {
    const data = await browser.storage.local.get(BRIDGE_TOKEN_KEY);
    const token = String(data[BRIDGE_TOKEN_KEY] ?? "").trim();
    if (token) return { ...extra, "X-TermAsk-Token": token };
  } catch {
    /* storage 不可用时按无令牌处理 */
  }
  return extra;
}

/** 带超时的桥接请求（工作台离线时快速失败，不拖住 SW） */
async function bridgeFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = await bridgeHeaders(
    (init.headers as Record<string, string>) ?? {},
  );
  return fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
  });
}

/** 读取 API 配置（问答与图谱抽取共用一份 storage.local 配置） */
async function readLLMConfig() {
  const cfg = await browser.storage.local.get(DEFAULTS);
  return {
    baseUrl: String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ""),
    apiKey: String(cfg.apiKey || ""),
    model: String(cfg.model || DEFAULTS.model),
  };
}

/**
 * 拼接 OpenAI 兼容的 chat/completions URL（与 Rust 端 `openai_endpoint` 同一套规则）：
 * - 已带版本段（`/v1`、`/v4`、`/v1beta`…）或 `/openai` → 直接接 `/chat/completions`
 * - 否则补 `/v1/chat/completions`
 *
 * 旧实现硬拼 `${baseUrl}/chat/completions`：默认 baseUrl 是 `https://api.deepseek.com`，
 * 实际请求 `/chat/completions` → 404，导致「生成解释 / 上下文分析」全部失败。
 */
function joinChatCompletions(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/openai$/i.test(base) || /\/v\d+[a-z]*$/i.test(base)) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

async function callLLM(text: string, level: string) {
  const { baseUrl, apiKey, model } = await readLLMConfig();

  if (!apiKey) return { ok: false, error: "NO_API_KEY" };
  if (!text) return { ok: false, error: "EMPTY_TEXT" };

  const requestId = ++requestSeq;
  const userMsg: ChatMessage = { role: "user", content: text };
  const ctx = await getContext();
  const messages: ChatMessage[] = [
    { role: "system", content: getSystemPrompt(level) },
    ...ctx,
    userMsg,
  ];

  // 调试快照：上一次请求的完整 messages，不参与撤回逻辑
  lastRequestMessages = messages;

  // v13：网络层异常必须归一到可读错误，否则 UI 只能显示 "TypeError: Failed to fetch"
  let resp: Response;
  try {
    resp = await fetch(joinChatCompletions(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.3, stream: false }),
      // 低配/免费模型首次响应可能较慢，90s 兜底（SW 内不能无限等）
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = /abort|timeout/i.test(msg);
    return {
      ok: false,
      error: timedOut ? "TIMEOUT" : `NETWORK: ${msg}`,
    };
  }

  if (!resp.ok) {
    // 401/403 独立成码：content.ts 会翻译成「API Key 无效」而不是笼统的 HTTP_4xx
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: "AUTH_FAILED", status: resp.status };
    }
    return { ok: false, error: `HTTP_${resp.status}`, status: resp.status };
  }

  let data: any;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, error: "BAD_RESPONSE" };
  }
  const reply: string = String(data?.choices?.[0]?.message?.content ?? "");
  if (!reply.trim()) return { ok: false, error: "EMPTY_REPLY" };

  // 追加本轮问答到会话上下文（storage.session，跨 SW 休眠存活）；
  // 若飞行中被撤回则跳过入库
  if (requestId !== retractedRequestId) {
    await pushRound(userMsg, { role: "assistant", content: reply });
  } else {
    console.debug(
      "[TermAsk/bg] request #%d was retracted in flight, skipped",
      requestId,
    );
  }

  // 调试口径核对用：当前上下文长度与上一次请求快照
  console.debug(
    "[TermAsk/bg] level=%s, ctx=%d msgs, lastRequest=%d msgs",
    level,
    ctx.length + 2,
    lastRequestMessages.length,
  );

  return { ok: true, level, reply };
}

// ── v7：图谱暂存区（browser.storage.local，跨页面持久） ───────────────

interface StagedTerm {
  id: string;
  term: string;
  contextText: string;
  sourceUrl: string;
  pageTitle: string;
  addedAt: number;
  /** v12：收集目标 "graph"（默认）| "whiteboard"——去重键为 term+target */
  target: "graph" | "whiteboard";
}

const STAGING_KEY = "termask_graph_staging";
const STAGING_MAX = 50; // 防失控上限：超出后丢弃最旧的

async function getStaging(): Promise<StagedTerm[]> {
  const data = await browser.storage.local.get(STAGING_KEY);
  const items = data[STAGING_KEY] as StagedTerm[] | undefined;
  return Array.isArray(items) ? items : [];
}

async function saveStaging(items: StagedTerm[]): Promise<void> {
  await browser.storage.local.set({ [STAGING_KEY]: items });
}

async function clearStaging(): Promise<void> {
  // v8.1：全文快照与普通暂存同属「收集区」，清空时一并移除
  await browser.storage.local.remove([STAGING_KEY, FULL_CONTEXT_KEY]);
}

/** 工作台侧暂存接口（Rust 需新增 POST /api/add-to-graph 路由） */
const ADD_TO_GRAPH_ENDPOINT = "http://127.0.0.1:17570/api/add-to-graph";
/** Tauri 桌面端正式推送端点（GraphPage 监听此端点） */
const GRAPH_ENDPOINT = "http://127.0.0.1:17570/api/concept-graph";
/** v8：工作台暂存区计数（GET）——插件按钮数字同步的数据源 */
const CACHE_COUNT_ENDPOINT = "http://127.0.0.1:17570/api/get-cache-count";
/** v9：工作台「删除最后加入的词」（POST）——快捷键撤销的远端同步 */
const REMOVE_LAST_ENDPOINT = "http://127.0.0.1:17570/api/remove-last";
/** v10：批量学习模式开关（工作台侧状态端点：GET 同步到本地 / POST 回推插件切换） */
const BATCH_MODE_ENDPOINT = "http://127.0.0.1:17570/api/batch-mode";
/**
 * v11：批量模式插端持久 key（browser.storage.local）。
 * 单一事实源：快捷键切换写这里，工作台轮询同步也写这里，
 * content script 查询只读这里（零网络等待）。
 */
const BATCH_MODE_STORAGE_KEY = "termask_batch_mode";
/** v10：alarm 轮询周期（分钟）：MV3 下最小 0.5（30s） */
const BATCH_POLL_ALARM = "termask-batch-poll";
/**
 * v13：桥接安全令牌（storage.local）。
 * 工作台「设置 → 通用 → 本地桥接安全」里开启令牌校验后，把令牌复制到扩展
 * 配置页；此后所有桥接请求带 X-TermAsk-Token，本机其它进程无法伪造写入。
 */
const BRIDGE_TOKEN_KEY = "termask_bridge_token";
/** 桥接请求超时：工作台未启动时应快速失败，而不是让 SW 挂着 */
const BRIDGE_TIMEOUT_MS = 2500;

/** v8.1：全文快照的特殊标记 term——后端据此存为「待分析全文快照」，不入普通词条列表 */
const FULL_CONTEXT_MARKER = "__FULL_CONTEXT__";
/** v8.1：全文快照的插件本地独立存储 key（与普通划词暂存 termask_graph_staging 分离） */
const FULL_CONTEXT_KEY = "termask_full_context";
/** v8：全文长度上限（与需求一致：5000 字以内） */
const FULL_TEXT_MAX = 5000;

/**
 * 加入暂存区（background 内完成）：
 *  1. 按 term+target 去重（已存在则刷新 contextText / addedAt / 来源信息）；
 *  2. 写入 browser.storage.local（跨页面/跨标签页持久，浏览器重启也在）；
 *  3. 尽力 POST 工作台 /api/add-to-graph——离线/失败仅打日志并返回
 *     pushed:false，不影响本地暂存结果（用户点「加入」永远成功）。
 * v8：maxContextLen 允许全文分析场景放行到 5000 字（默认划词条仍是 2000）。
 * v12：target 透传（"graph" 默认 | "whiteboard"），后端据此分发暂存区。
 */
async function addToGraphStaging(input: {
  term: string;
  contextText: string;
  sourceUrl: string;
  pageTitle: string;
  maxContextLen?: number;
  target?: "graph" | "whiteboard";
}) {
  const term = input.term.trim();
  if (!term) return { ok: false, error: "EMPTY_TERM" };

  const target = input.target === "whiteboard" ? "whiteboard" : "graph";
  const ctxMax = input.maxContextLen ?? 2000;
  const items = await getStaging();
  const existingIdx = items.findIndex(
    (it) => it.term === term && it.target === target,
  );
  const isNew = existingIdx === -1;

  if (isNew) {
    const id =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    items.push({
      id,
      term,
      contextText: input.contextText.slice(0, ctxMax),
      sourceUrl: input.sourceUrl,
      pageTitle: input.pageTitle,
      addedAt: Date.now(),
      target,
    });
    // 超上限：丢最旧的（FIFO）
    while (items.length > STAGING_MAX) items.shift();
  } else {
    // 同词+同目标重复加入：刷新上下文与时间戳，不产生重复条目
    const it = items[existingIdx];
    it.contextText = input.contextText.slice(0, ctxMax);
    it.sourceUrl = input.sourceUrl;
    it.pageTitle = input.pageTitle;
    it.addedAt = Date.now();
  }

  await saveStaging(items);
  console.debug(
    '[TermAsk/bg] staged "%s" (target=%s), total=%d (new=%s)',
    term,
    target,
    items.length,
    isNew,
  );

  // 尽力转发工作台：失败不阻断（本地已暂存，工作台合并时以本地为准），
  // 但失败详情必须打到 SW 控制台（chrome://extensions → Service Worker → F12），
  // 按 PUSH_ERROR 关键字过滤即可定位：Failed to fetch = 连不上/CORS，HTTP_4xx = 字段/契约问题。
  let pushed = false;
  let pushError: string | null = null;
  await bridgeFetch(ADD_TO_GRAPH_ENDPOINT, {
    method: "POST",
    // Content-Type 必须为 application/json，否则 axum 的 Json 提取器直接拒绝
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      term,
      contextText: input.contextText.slice(0, ctxMax),
      sourceUrl: input.sourceUrl,
      pageTitle: input.pageTitle,
      addedAt: Date.now(),
      target,
      stagedCount: items.length,
    }),
  })
    .then(async (resp) => {
      if (resp.ok) {
        pushed = true;
        console.debug("[TermAsk/bg] add-to-graph pushed: HTTP", resp.status);
      } else {
        // 422/400 = 契约不匹配：响应体带 serde 具体报错（缺哪个字段/类型不符）
        const detail = await resp.text().catch(() => "");
        pushError = `HTTP_${resp.status}: ${detail.slice(0, 200)}`;
        console.error(`PUSH_ERROR HTTP ${resp.status}:`, detail.slice(0, 300));
      }
    })
    .catch((err) => {
      // 网络层失败：Failed to fetch = 工作台未启动 / 端口不通 / 权限未生效
      pushError = err instanceof Error ? err.message : String(err);
      console.error("PUSH_ERROR", err);
    });

  if (pushError) {
    console.warn("[TermAsk/bg] staged locally only, push failed:", pushError);
  }

  return { ok: true, stagedCount: items.length, isNew, pushed, pushError };
}

// ── v8.1：全文快照（__FULL_CONTEXT__）+ 计数同步 ─────────────────────

/**
 * 全文快照入槽：content script 抓到的整段对话文本（≤5000 字）以
 * 特殊标记 term='__FULL_CONTEXT__' 推送。与普通划词彻底分流：
 *  - 本地：不进 termask_graph_staging（不占暂存计数、不参与合并），
 *    存独立单槽 key=termask_full_context，重复分析覆盖式刷新；
 *  - 工作台：POST /api/add-to-graph，后端识别标记后存入「待分析的
 *    全文快照」槽位并广播 full-context 事件，不计入普通词条数量。
 */
async function stageFullText(input: {
  chatText: string;
  sourceUrl: string;
  pageTitle: string;
}) {
  const chatText = String(input.chatText ?? "").trim();
  if (!chatText) return { ok: false, error: "EMPTY_TEXT" };

  // 1) 本地独立槽位：覆盖式保存快照（全文快照归属图谱分析链路 → target="graph"）
  const snapshot: StagedTerm = {
    id:
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `fullctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    term: FULL_CONTEXT_MARKER,
    contextText: chatText.slice(0, FULL_TEXT_MAX),
    sourceUrl: input.sourceUrl,
    pageTitle: input.pageTitle,
    addedAt: Date.now(),
    target: "graph",
  };
  await browser.storage.local.set({ [FULL_CONTEXT_KEY]: snapshot });
  console.debug(
    "[TermAsk/bg] full-context snapshot staged: %d chars (limit %d)",
    chatText.length,
    FULL_TEXT_MAX,
  );

  // 2) 尽力推送工作台：term=__FULL_CONTEXT__，失败不阻断（本地快照已在）
  let pushed = false;
  let pushError: string | null = null;
  await bridgeFetch(ADD_TO_GRAPH_ENDPOINT, {
    method: "POST",
    // Content-Type 必须为 application/json，否则 axum 的 Json 提取器直接拒绝
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      term: FULL_CONTEXT_MARKER,
      contextText: snapshot.contextText,
      sourceUrl: input.sourceUrl,
      pageTitle: input.pageTitle,
      addedAt: snapshot.addedAt,
    }),
  })
    .then(async (resp) => {
      if (resp.ok) {
        pushed = true;
        console.debug("[TermAsk/bg] full-context pushed: HTTP", resp.status);
      } else {
        // 4xx = 契约问题：响应体带后端具体报错
        const detail = await resp.text().catch(() => "");
        pushError = `HTTP_${resp.status}: ${detail.slice(0, 200)}`;
        console.error(
          `PUSH_ERROR full-context HTTP ${resp.status}:`,
          detail.slice(0, 300),
        );
      }
    })
    .catch((err) => {
      // 网络层失败：Failed to fetch = 工作台未启动 / 端口不通 / 权限未生效
      pushError = err instanceof Error ? err.message : String(err);
      console.error("PUSH_ERROR full-context", err);
    });

  // 快照不计入普通暂存计数：回传当前普通词条数量，前端按它刷新按钮数字
  const stagedCount = (await getStaging()).length;
  return { ok: true, fullContext: true, stagedCount, pushed, pushError };
}

/**
 * v8 计数同步：按钮上的数字不再只依赖本地暂存——
 *  1. 优先 GET 工作台 /api/get-cache-count（权威数量，能感知工作台侧
 *     的删除/清空/合并成功后清零）；
 *  2. 工作台离线/失败 → 降级返回本地暂存数量（source: 'local'），
 *     前端据此提示「以本地为准」，用户可用「重置数字」小按钮兜底。
 * 网络失败详情照旧打 PUSH_ERROR 前缀日志。
 */
async function syncStagedCount() {
  const localCount = (await getStaging()).length;
  try {
    const resp = await bridgeFetch(`${CACHE_COUNT_ENDPOINT}?target=graph`, {
      method: "GET",
    });
    if (resp.ok) {
      const data = (await resp.json().catch(() => null)) as {
        count?: unknown;
      } | null;
      const count = Number(data?.count);
      if (Number.isFinite(count) && count >= 0) {
        return { ok: true, count, source: "workbench" as const, localCount };
      }
      console.error("PUSH_ERROR count sync: bad payload", data);
    } else {
      const detail = await resp.text().catch(() => "");
      console.error(
        `PUSH_ERROR count sync HTTP ${resp.status}:`,
        detail.slice(0, 200),
      );
    }
  } catch (err) {
    // 工作台未启动是常态：降级本地，不弹错
    console.error("PUSH_ERROR count sync", err);
  }
  return { ok: true, count: localCount, source: "local" as const, localCount };
}

// ── v7：合并生成（暂存 ≥2 条 → LLM 抽取关系 → 推送工作台） ────────────

/**
 * 概念抽取 System Prompt（固定，不接受页面注入）。
 * 模型偶尔仍会包 Markdown 代码块，parseGraphJSON 里做了容错剥离。
 */
const GRAPH_SYSTEM_PROMPT =
  "提取文本中的核心概念与关系，严格输出 JSON 格式：" +
  '{"nodes": [{"id": "1", "label": "概念A"}], "edges": [{"source": "1", "target": "2"}]}，' +
  "禁止输出任何其他多余文本或 Markdown 代码块";

interface GraphPayload {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ source: string; target: string }>;
}

/**
 * 解析模型返回的图谱 JSON，容错三层：
 *  ① 剥离 ```json ... ``` 代码围栏；② 截取首个 { 到末个 } 之间的片段；
 *  ③ 字段规范化——id/label/source/target 一律转字符串，边只保留两端都在
 *     nodes 里且非自环的（脏数据不推给工作台）。
 * 抛 Error('BAD_JSON_FORMAT') = 模型没给出可解析的图谱结构。
 */
function parseGraphJSON(raw: string): GraphPayload {
  let s = String(raw ?? "").trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start)
    throw new Error("BAD_JSON_FORMAT");

  let data: { nodes?: unknown; edges?: unknown };
  try {
    data = JSON.parse(s.slice(start, end + 1)) as {
      nodes?: unknown;
      edges?: unknown;
    };
  } catch {
    throw new Error("BAD_JSON_FORMAT");
  }

  if (!Array.isArray(data.nodes) || data.nodes.length === 0)
    throw new Error("BAD_JSON_FORMAT");
  const nodes = (data.nodes as Array<Record<string, unknown>>)
    .map((n) => ({
      id: String(n?.id ?? "").trim(),
      label: String(n?.label ?? "").trim(),
    }))
    .filter((n) => n.id && n.label);
  if (nodes.length === 0) throw new Error("BAD_JSON_FORMAT");

  const validIds = new Set(nodes.map((n) => n.id));
  const edges = (
    Array.isArray(data.edges)
      ? (data.edges as Array<Record<string, unknown>>)
      : []
  )
    .map((e) => ({
      source: String(e?.source ?? "").trim(),
      target: String(e?.target ?? "").trim(),
    }))
    .filter(
      (e) =>
        validIds.has(e.source) &&
        validIds.has(e.target) &&
        e.source !== e.target,
    );

  return { nodes, edges };
}

/**
 * 合并生成全流程（background SW 内完成）：
 *  1. 读暂存区，不足 2 条直接拒绝（合并 = 找术语之间的关系）；
 *  2. 组装一条 user 消息：逐条列出「术语 + 上下文 + 来源」，要求模型
 *     重点抽取这些术语彼此之间（及与文内其他概念）的关系；
 *  3. LLM 直调（独立 messages，不读/不写问答会话上下文）；
 *  4. 解析规范化 JSON → 组装 ConceptGraphPayload（sessionId / 边 id 合成）；
 *  5. POST /api/concept-graph 推送工作台；成功后清空暂存区。
 */
async function mergeGraphFromStaging() {
  const all = await getStaging();
  // 只有 target="graph" 的词参与合并；白板收集区的词不应污染概念图谱
  const items = all.filter((it) => (it.target ?? "graph") === "graph");
  if (items.length < 2) {
    return { ok: false, error: "NEED_MORE_TERMS", stagedCount: items.length };
  }

  const { baseUrl, apiKey, model } = await readLLMConfig();
  if (!apiKey)
    return { ok: false, error: "NO_API_KEY", stagedCount: items.length };

  const userContent =
    items
      .map(
        (it, i) =>
          `${i + 1}. 术语：${it.term}\n   上下文：${it.contextText || "（无）"}\n   来源：${it.pageTitle || it.sourceUrl || "（未知）"}`,
      )
      .join("\n") +
    "\n\n请重点抽取以上术语彼此之间的关系，以及它们与上下文中其他关键概念的关系。";

  const resp = await fetch(joinChatCompletions(baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: GRAPH_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      // 图谱 JSON（多节点 + 多边）需要足够输出空间；不给则依赖服务端默认值（常见 4096）
      max_tokens: 2048,
      stream: false,
    }),
  });
  if (!resp.ok)
    return {
      ok: false,
      error: `LLM_HTTP_${resp.status}`,
      stagedCount: items.length,
    };

  const data = await resp.json();
  const reply: string = data?.choices?.[0]?.message?.content ?? "";

  let graph: GraphPayload;
  try {
    graph = parseGraphJSON(reply);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "BAD_JSON_FORMAT",
      stagedCount: items.length,
      // 前 200 字符回传，便于在插件 SW 控制台排查模型为什么不守格式
      rawSample: reply.slice(0, 200),
    };
  }

  // 组装成 Rust 端 ConceptGraphPayload 的契约结构（serde rename_all = camelCase）：
  //  - sessionId：必填（Rust 侧无 default，缺失即 422）
  //  - edges：每条必须带 id（Rust ConceptEdge.id 必填）——用 source->target 合成
  const sessionId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pushBody = {
    sessionId,
    sourceExcerpt: items.map((it) => it.term).join(" · "),
    nodes: graph.nodes,
    edges: graph.edges.map((e) => ({ id: `${e.source}->${e.target}`, ...e })),
  };

  const bodyStr = JSON.stringify(pushBody);
  console.log("[TermAsk-Debug] concept-graph request body:", bodyStr);

  const pushResp = await bridgeFetch(GRAPH_ENDPOINT, {
    method: "POST",
    // Content-Type 必须严格为 application/json，否则 axum 的 Json 提取器直接拒绝
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: bodyStr,
  });
  if (!pushResp.ok) {
    // axum 的 422 响应体里带 serde 的具体报错，带回来直接定位
    const respText = await pushResp.text().catch(() => "");
    console.warn(
      `[TermAsk/bg] push failed: HTTP ${pushResp.status}, response:`,
      respText,
    );
    return {
      ok: false,
      error: `PUSH_HTTP_${pushResp.status}`,
      stagedCount: items.length,
      pushDetail: respText.slice(0, 300),
    };
  }

  // 推送成功才清理：只删已合并的图谱词，白板收集区与全文快照不受影响
  await saveStaging(all.filter((it) => (it.target ?? "graph") !== "graph"));
  console.debug(
    "[TermAsk/bg] merged graph pushed: %d nodes, %d edges, staging cleared",
    graph.nodes.length,
    graph.edges.length,
  );
  return {
    ok: true,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    mergedCount: items.length,
  };
}
