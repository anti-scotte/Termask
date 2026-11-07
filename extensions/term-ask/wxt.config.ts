import { defineConfig } from "wxt";

/**
 * v5 说明（iframe 兼容）：
 * WXT 的 content_scripts 清单由 entrypoints/content.ts 的
 * defineContentScript({ matches, allFrames, runAt }) 注册项生成，
 * all_frames 已在入口处声明为 true（每帧独立注入、fixed 定位基于本帧视口）。
 * 切勿在 manifest.content_scripts 里再写一份——会导致同一脚本被注册两次。
 */
export default defineConfig({
  manifest: {
    name: "TermAsk 极简验证版",
    description: "划词提问浮层 + 无感收集器（快捷键 / 批量模式）",
    // "alarms" = v10 批量模式兜底轮询（MV3 SW 会休眠，alarm 是唯一可靠定时器）
    permissions: ["storage", "activeTab", "alarms"],
    // 127.0.0.1:17570 = Tauri 桌面端桥接服务（axum），background 里 fetch 推送
    // 概念图谱必需此 host 权限才能绕过跨域限制。
    // 其余为「用户可自选」的 OpenAI 兼容供应商：未列入的域名会被浏览器网络层
    // 直接拦截，表现为 fetch 抛 TypeError: Failed to fetch（不是 401/404）。
    host_permissions: [
      "https://api.deepseek.com/*",
      "https://api.moonshot.cn/*",
      "https://open.bigmodel.cn/*",
      "https://api.openai.com/*",
      "https://generativelanguage.googleapis.com/*",
      "https://dashscope.aliyuncs.com/*",
      "https://api.siliconflow.cn/*",
      "http://127.0.0.1:17570/*",
      "http://localhost:11434/*",
      "http://127.0.0.1:11434/*",
    ],
    // v9/v11 无感收集器：快捷键命令（分发逻辑在 background.ts 的
    // browser.commands.onCommand）。
    // 注意：Chrome 的 global: true（浏览器失焦也可触发）仅允许媒体键和
    // Ctrl+Shift+0~9 组合，此处均为"浏览器内全局"快捷键。
    // ⚠ Ctrl+Shift+B 在部分浏览器是书签栏开关、Ctrl+Shift+Z 是页面"重做"——
    //   扩展 commands 优先级更高会抢占它们；用户可在
    //   chrome://extensions/shortcuts 里自行改键。
    commands: {
      "termask-quick-add": {
        suggested_key: { default: "Alt+Shift+A" },
        description: "TermAsk：无感加入图谱（把选中的词静默加入暂存区）",
      },
      "termask-undo-last": {
        suggested_key: { default: "Ctrl+Shift+Z" },
        description: "TermAsk：删除最后加入的词",
      },
      "termask-toggle-batch": {
        suggested_key: { default: "Ctrl+Shift+B" },
        description: "TermAsk：开关批量学习模式（划词即静默收集）",
      },
    },
  },
  webExt: {
    disabled: true,
  },
  // 强制换个端口，避开 3000 冲突
  vite: () => ({
    server: {
      port: 3001,
    },
  }),
});
