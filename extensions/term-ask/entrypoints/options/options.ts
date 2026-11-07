const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
};

/** 桥接安全令牌的 storage key（与 background.ts 的 BRIDGE_TOKEN_KEY 一致） */
const BRIDGE_TOKEN_KEY = 'termask_bridge_token';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load() {
  const cfg = await chrome.storage.local.get({
    ...DEFAULTS,
    [BRIDGE_TOKEN_KEY]: '',
  });
  $('baseUrl').value = String(cfg.baseUrl);
  $('apiKey').value = String(cfg.apiKey);
  $('model').value = String(cfg.model);
  $('bridgeToken').value = String(cfg[BRIDGE_TOKEN_KEY] ?? '');
}

document.getElementById('save')!.addEventListener('click', async () => {
  await chrome.storage.local.set({
    baseUrl: $('baseUrl').value.trim() || DEFAULTS.baseUrl,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || DEFAULTS.model,
    [BRIDGE_TOKEN_KEY]: $('bridgeToken').value.trim(),
  });
  const status = document.getElementById('status')!;
  status.textContent = '已保存';
  setTimeout(() => (status.textContent = ''), 1500);
});

load();
