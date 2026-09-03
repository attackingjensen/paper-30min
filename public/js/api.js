// OpenAI 兼容 API 客户端：设置存取、流式/非流式对话、连接测试
const SETTINGS_KEY = 'pr.settings.v1';

export const DEFAULT_SETTINGS = {
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.3,
  maxTokens: 4096,
  maxChars: 16000, // 单个章节送入模型的最大字符数
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function settingsReady() {
  const s = loadSettings();
  return !!(s.baseUrl && s.apiKey && s.model);
}

export function endpoint(s, path) {
  const raw = s.baseUrl.trim();
  if (!raw) throw new Error('API Base URL 不能为空');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('API Base URL 格式无效，请填写以 http:// 或 https:// 开头的完整地址');
  }

  // 阿里云百炼（DashScope）的 OpenAI 兼容接口在 /compatible-mode/v1，裸域名或
  // 文档里的原生 API 地址都走不通，统一改写以便用户直接粘贴控制台地址。
  if (/^dashscope(-\w+)?\.aliyuncs\.com$/i.test(url.hostname)
      && !/^\/compatible-mode(\/|$)/i.test(url.pathname)) {
    url.pathname = '/compatible-mode/v1';
  }

  const target = path.replace(/^\/+/, '');
  let pathname = url.pathname.replace(/\/+$/, '');

  // 兼容中转站常见的三种写法：域名、/v1、完整 chat/completions 地址。
  if (/\/chat\/completions$/i.test(pathname)) {
    pathname = pathname.replace(/\/chat\/completions$/i, '');
  } else if (/\/models$/i.test(pathname)) {
    pathname = pathname.replace(/\/models$/i, '');
  } else if (!pathname || pathname === '/') {
    pathname = '/v1';
  }

  url.pathname = `${pathname}/${target}`.replace(/\/{2,}/g, '/');
  return url.toString();
}

async function readError(res) {
  let detail = '';
  try {
    const t = await res.text();
    try { detail = JSON.parse(t).error?.message || t; } catch { detail = t; }
  } catch { /* ignore */ }
  if (res.status === 403 && /error code:\s*1010|cloudflare/i.test(detail)) {
    return new Error('中转站的 Cloudflare 拒绝了请求（HTTP 403 / 1010）。请重启本应用后重试；若仍失败，需让中转站解除当前 IP 或 API 客户端限制。');
  }
  const hint = res.status === 404
    ? '（该地址不存在，请检查 Base URL 是否为 OpenAI 兼容端点，阿里云百炼需以 /compatible-mode/v1 结尾）'
    : '';
  return new Error(`API 请求失败（HTTP ${res.status}）${detail ? '：' + detail.slice(0, 300) : ''}${hint}`);
}

async function apiFetch(url, options = {}) {
  // 优先由浏览器直连。部分 Cloudflare 中转站会按 TLS 指纹拒绝 Python 客户端，
  // 浏览器直连既能保留真实指纹，也避免本地代理被误判为自动化流量。
  try {
    return await fetch(url, options);
  } catch (directError) {
    if (options.signal?.aborted) throw directError;
  }

  // 直连被 CORS 或网络策略阻止时，再通过本地服务器转发。
  const headers = Object.fromEntries(new Headers(options.headers || {}).entries());
  let body = options.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* 保留原值 */ }
  }
  return fetch('/api/forward', {
    method: 'POST',
    signal: options.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method: options.method || 'GET', headers, body }),
  });
}

/**
 * 调用 chat/completions。
 * stream=true 时通过 SSE 流式返回，每收到增量调用 onDelta(fullText)。
 * 返回最终完整文本。
 */
export async function chat(messages, { stream = true, signal, onDelta } = {}) {
  const s = loadSettings();
  if (!settingsReady()) {
    throw new Error('尚未配置 API。请先点击右上角「设置」，填写 API Base URL、Key 和模型名称。');
  }
  const res = await apiFetch(endpoint(s, '/chat/completions'), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${s.apiKey}`,
    },
    body: JSON.stringify({
      model: s.model,
      messages,
      temperature: s.temperature,
      max_tokens: s.maxTokens,
      stream,
    }),
  });
  if (!res.ok) throw await readError(res);

  const ct = res.headers.get('content-type') || '';
  if (!stream || !ct.includes('event-stream')) {
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    onDelta?.(text);
    return text;
  }

  // SSE 流式解析
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // 保留未完整的最后一行
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.message?.content ?? '';
        if (delta) {
          full += delta;
          onDelta?.(full);
        }
        const finish = obj.choices?.[0]?.finish_reason;
        if (finish && finish !== 'stop' && finish !== 'end_turn') {
          console.warn('finish_reason:', finish);
        }
      } catch { /* 忽略无法解析的行 */ }
    }
  }
  return full;
}

/** 测试连接：优先拉取模型列表，失败则尝试最小对话 */
export async function testConnection() {
  const s = loadSettings();
  if (!s.baseUrl || !s.apiKey) throw new Error('请先填写 Base URL 和 API Key');
  const headers = { 'Authorization': `Bearer ${s.apiKey}` };
  try {
    const res = await apiFetch(endpoint(s, '/models'), { headers, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      const models = (data.data || []).map(m => m.id);
      const found = s.model && models.includes(s.model);
      return found ? `✅ 连接成功，已找到模型「${s.model}」` : `⚠️ 连接成功，但模型列表中未找到「${s.model || '未填写'}」。可用模型：${models.slice(0, 8).join(', ') || '（空）'}`;
    }
  } catch { /* 继续尝试对话方式 */ }
  // 退路：发一条最小请求
  const res = await apiFetch(endpoint(s, '/chat/completions'), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: s.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw await readError(res);
  return '✅ 连接成功';
}
