// 模型调用客户端：设置内存缓存 + 经桥接任务的对话与连接测试。
// 端点规范化、鉴权与网络都在 Rust 侧，本模块只面对冻结的桥接契约：
// settings.get@1 / settings.putModel@1，以及长任务 model.chat@1 / model.test@1。
import { trackTask } from '../bridge.js';

export const DEFAULT_SETTINGS = {
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.3,
  maxTokens: 4096,
  maxChars: 16000, // 单个章节送入模型的最大字符数
  stageModels: {},
  extraBody: {},
  stageExtraBody: {},
};

export const MODEL_STAGES = ['map-l2', 'map-l1', 'deep-dive', 'synthesize', 'qa'];
export const REASONING_FAMILY_RE = /qwen3\.\d|qwen-(plus|flash|max)|deepseek|glm-?\d|kimi|r1|reasoner|thinking|o[134]\b|gpt-5/i;
const PROTECTED_BODY_KEYS = new Set(['model', 'messages', 'stream']);

export function isReasoningFamily(model) {
  return REASONING_FAMILY_RE.test(String(model || ''));
}

export function builtinExtraBody(stage) {
  if (stage === 'map-l2' || stage === 'map-l1' || stage === 'deep-dive' || stage === 'synthesize') {
    return { enable_thinking: false };
  }
  if (stage === 'qa') return { enable_thinking: true };
  return {};
}

function applyOverlay(target, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return target;
  for (const [key, value] of Object.entries(overlay)) {
    if (PROTECTED_BODY_KEYS.has(key)) continue;
    if (value === null) delete target[key];
    else target[key] = value;
  }
  return target;
}

/** 当前生效附加参数：内建阶段默认 → extraBody → stageExtraBody[stage]。 */
export function mergeExtraBody(stage, extraBody = {}, stageExtraBody = {}) {
  const merged = applyOverlay(builtinExtraBody(stage), extraBody);
  if (stage) applyOverlay(merged, stageExtraBody?.[stage]);
  return merged;
}

export function extraBodyPreview(extraBody = {}, stageExtraBody = {}) {
  const preview = {};
  for (const stage of MODEL_STAGES) {
    preview[stage] = mergeExtraBody(stage, extraBody, stageExtraBody);
  }
  return preview;
}

/** 温度输入框 → 设置值（#86）：空串 = null（不发送，用端点默认）；否则须为 0–2 数值。 */
export function parseTemperatureInput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error('温度须为 0–2 的数值，或留空使用端点默认');
  }
  return value;
}

/** 设置值 → 温度输入框文本（#86）：null/缺省 → 空串（占位符显示「端点默认」）。 */
export function formatTemperatureInput(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** 思考心跳 → 面板状态：收到 thinking 则激活，正文/轮次结束清除。 */
export function reduceThinkingStatus(events = []) {
  let current = null;
  for (const event of events) {
    if (event?.event === 'thinking') {
      const detail = event.detail || {};
      current = {
        elapsedMs: Number(detail.elapsedMs) || 0,
        reasoningChars: Number(detail.reasoningChars) || 0,
        stage: detail.stage,
        partId: detail.partId,
      };
    } else if (event?.event === 'chunk' || event?.event === 'round' || event?.event === 'content') {
      current = null;
    }
  }
  return current;
}

export function thinkingStatusText(status, { qa = false } = {}) {
  if (!status) return '';
  const seconds = (Number(status.elapsedMs) / 1000).toFixed(1);
  return qa ? `思考中 · ${seconds} s` : `模型思考中 · 已 ${seconds} s`;
}

let bridge = null;
let settingsCache = null;
let taskRegistrar = null;   // main.js 注入的会话任务登记函数，任务中心「重试」依赖

/** 注入桥接客户端与会话任务登记函数；main.js 启动时接线，测试注入可控替身。 */
export function initModel(bridgeInstance, hooks = {}) {
  bridge = bridgeInstance;
  taskRegistrar = hooks.registerTask ?? null;
  settingsCache = null;
}

function requireBridge() {
  if (!bridge) throw new Error('model.initModel 尚未调用');
}

// ---------------- 设置 ----------------

/** 启动时读取设置入内存缓存；读取失败退回默认值，不阻塞应用。 */
export async function initSettings() {
  requireBridge();
  try {
    const result = await bridge.invoke('settings.get@1');
    settingsCache = { ...DEFAULT_SETTINGS, ...(result?.model || {}) };
  } catch (err) {
    console.warn('设置读取失败，使用默认设置：', err);
    settingsCache = { ...DEFAULT_SETTINGS };
  }
  return settingsCache;
}

/** 同步读缓存；initSettings 完成前返回默认值。 */
export function loadSettings() {
  if (!settingsCache) console.warn('model.initSettings 尚未完成，先返回默认设置');
  return { ...(settingsCache || DEFAULT_SETTINGS) };
}

/** 保存模型设置并更新内存缓存。 */
export async function saveSettings(settings) {
  requireBridge();
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  await bridge.invoke('settings.putModel@1', { settings: merged });
  settingsCache = merged;
}

export function settingsReady() {
  const s = loadSettings();
  return !!(s.baseUrl && s.apiKey && s.model);
}

// ---------------- 长任务生命周期 ----------------

// 启动桥接任务并等待终态。事件订阅、退订清理、tasks.get@1 快照复核与 abort 取消
// 统一走 bridge.js 的 trackTask；这里只实现本模块的终态语义：
// - succeeded → resolve({ result })
// - failed → reject Error，携带 error.code / error.retryable
// - cancelled → reject AbortError
async function runBridgeTask(kind, input, { signal, onChunk, onEvent, retry } = {}) {
  requireBridge();
  const { taskId } = await bridge.start(kind, input);
  // 会话任务登记：任务中心对 failed 且 retryable 的任务渲染「重试」，依赖这里的 retry 闭包。
  taskRegistrar?.(taskId, { kind, input, retry });
  const { status, error, result } = await trackTask(bridge, taskId, { signal, onChunk, onEvent });
  if (status === 'succeeded') return { result: result ?? null };
  if (status === 'failed') {
    const info = error || {};
    throw Object.assign(new Error(info.message || '任务失败'), {
      code: info.code || 'unknown',
      retryable: Boolean(info.retryable),
    });
  }
  throw new DOMException('生成已取消', 'AbortError');
}

// ---------------- 对话与连接测试 ----------------

/**
 * 调用模型对话。chunk 事件携带增量文本，按到达顺序拼接即全文；
 * 每收到一片以当前全文调用 onDelta(full)。temperature/maxTokens 取缓存设置。
 * temperature 为 null（设置留空）时显式传给 Rust，请求体不携带该键（#86）。
 * retry 供调用方传入「重试」闭包（任务中心对可重试失败任务渲染按钮时调用）。
 * 未配置模型时任务直接 failed（error.code = 'model_not_configured'），按失败语义抛出。
 */
export async function chat(messages, { stream = true, signal, onDelta, onEvent, retry, stage } = {}) {
  const s = loadSettings();
  let full = '';
  const input = {
    messages,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    stream,
  };
  if (stage) input.stage = stage;
  await runBridgeTask('model.chat@1', input, {
    signal,
    retry,
    onChunk: chunk => {
      full += chunk;
      onDelta?.(full);
    },
    onEvent,
  });
  return full;
}

/** 测试连接：succeeded 返回 result.message，failed 抛 Error(error.message)。 */
export async function testConnection() {
  const { result } = await runBridgeTask('model.test@1', {});
  return result?.message ?? '';
}
