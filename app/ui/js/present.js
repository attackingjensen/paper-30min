// 书库卡片建图状态、任务中心协议任务呈现、导出笔记内容组装的纯函数缝
// （#72 / 规格 #56 决策 12–13、21；#77 任务类型标签按 prerender scope 区分）。
// 无 DOM；UI 壳（main.js）只负责渲染。
//
// 事件流契约（#55/#65，Rust protocol.rs 发射；#72 起快照携带 details 日志）：
// - 建图阶段事件 detail = { stage: 'preflight'|'map-l2'|'map-l1', shard?, shards?, secId?, shardStatus?, sections? }
// - 深挖阶段事件 detail = { stage: 'deep-dive', partId, secId, title, index, total }
// - 工具轨迹事件 detail = { step, partId, secId, name, args, ok, result?, error? }
// - 模型轮事件 detail = { stage, round, ttftMs, elapsedMs, receivedChars,
//   partId?, shard?, promptTokens?, completionTokens?, cachedTokens?, reasoningTokens? }
// - 轮次开始事件 detail = { stage, partId, round, contextTokensEstimated }（#80，深挖每轮）
// - 流式预览事件 detail = { stage, partId?, text }（#80，Markdown 阶段累计全文；text=null 清空）
// - 轮次进度心跳 detail = { stage, shard?, partId?, receivedChars, elapsedMs }（#80，JSON 阶段）
// tasks.list@1 快照的 details 字段是有界日志（[{event, detail}]，容量 500）：
// JS 订阅建立前发出的 detail 事件不经通道重放，任务中心以快照日志为完整源；
// preview / round-progress 是高频瞬态事件，日志里同键只留最新一条（#80）。
// 会话任务登记（main.js sessionTasks）作无 details 时的回退。
//
// 消费方：本模块测试 + main.js（书库卡片 / 任务中心 / 导出笔记）。

import { mappingStageLabel, productOf } from './content.js';
import { l2Sections, partIdForSection, sectionForPart } from './protocol.js';
import { readingParts, paperCategories, paperTags } from './papers.js';

// ---------------- 书库卡片建图状态（决策 12） ----------------

/**
 * 卡片建图状态 chip：未建图 = 状态点；建图中 = 阶段进度；已建图 = 标记进度 n/N。
 * 返回 { tone: 'idle'|'running'|'done', text }。
 */
export function libraryMapState({ mapped = false, mapping = false, mappingStage = null, mappingProgress = null, done = 0, total = 0 } = {}) {
  if (mapping) {
    const l2Total = Number(mappingProgress?.total) - 1;
    if (Number.isFinite(l2Total) && l2Total > 0) {
      const l2Done = Math.min(Number(mappingProgress.done) || 0, l2Total);
      return { tone: 'running', text: `建图中 · 薄摘要 ${l2Done}/${l2Total}` };
    }
    return {
      tone: 'running',
      text: mappingStage ? `建图中 · ${mappingStageLabel(mappingStage)}` : '建图中',
    };
  }
  if (mapped) return { tone: 'done', text: `已建图 · 已读完 ${done}/${total}` };
  return { tone: 'idle', text: '未建图' };
}

// ---------------- 任务类型标签（#77：prerender 按 scope 区分） ----------------

const TASK_KIND_LABELS = {
  'model.chat': '模型生成',
  'model.test': '连接测试',
  'net.fetch-text': '网页抓取',
  'files.download': '文件下载',
  'pdfparse.convert': '解析 PDF',
  'paper.build-map': '建图',
  'paper.deep-dive': '深挖',
  'paper.synthesize': '综合',
};

/** prerender 任务中心类型标签：pages / crops / 缺省（all）三档。 */
export function prerenderTaskLabel(scope) {
  if (scope === 'pages') return '预渲染页图';
  if (scope === 'crops') return '预渲染图表';
  return '预渲染';
}

/** 任务 kind → 中文名；prerender 再按 input.scope 细分。 */
export function taskKindLabel(kind, input = {}) {
  const bare = String(kind || '').replace(/@\d+$/, '');
  if (bare === 'pdfassets.prerender') return prerenderTaskLabel(input?.scope);
  if (TASK_KIND_LABELS[bare]) return TASK_KIND_LABELS[bare];
  if (bare.startsWith('demo.')) return '演示任务';
  return bare || '未知任务';
}

// ---------------- 任务中心协议呈现（决策 13） ----------------

/** 建图内部阶段序（与 Rust 发射顺序一致）。 */
export const MAP_STAGE_FLOW = ['preflight', 'map-l2', 'map-l1'];

/**
 * 建图阶段流：三阶段的完成/进行中/未到达。stageDetail 为最近一条阶段事件载荷。
 * succeeded 终态不再显示阶段流（进度条 100% 已足够），返回 null。
 * failed 时当前阶段标 failed 红，让「停在哪个阶段」可见；cancelled 是用户主动停止，保持 current。
 */
export function buildMapStageFlow(stageDetail = null, status = 'running', progress = null) {
  if (status === 'succeeded') return null;
  const stage = stageDetail?.stage;
  const currentIndex = MAP_STAGE_FLOW.indexOf(stage);
  if (currentIndex === -1) return null;
  const failed = status === 'failed';
  return MAP_STAGE_FLOW.map((key, index) => {
    let label = mappingStageLabel(key);
    if (key === 'map-l2' && index === currentIndex) {
      const l2Total = Number(progress?.total) - 1;
      if (Number.isFinite(l2Total) && l2Total > 1) {
        const l2Done = Math.min(Number(progress.done) || 0, l2Total);
        label += ` · ${l2Done}/${l2Total}`;
      }
    }
    const state = index < currentIndex ? 'done'
      : index === currentIndex ? (failed ? 'failed' : 'current')
        : 'todo';
    return { key, label, state };
  });
}

const SHARD_STATE_LABEL = { queued: '排队', current: '生成中', done: '完成', failed: '失败' };

/**
 * 建图 L2 各片状态：由 stage 事件的 sections / secId / shardStatus 归约。
 * 返回 [{ key, secId, label, state }]；尚无 map-l2 事件时为 null。
 */
export function l2ShardFlow({ details = [], status = 'running', error = null } = {}) {
  if (status === 'succeeded') return null;
  const stages = details.filter(entry => entry?.event === 'stage' && entry.detail?.stage === 'map-l2');
  if (!stages.length) return null;
  const listed = stages.find(entry => Array.isArray(entry.detail?.sections))?.detail.sections
    || stages.map(entry => entry.detail?.secId).filter(Boolean);
  const secIds = [...new Set(listed.map(id => String(id)).filter(Boolean))];
  if (!secIds.length) {
    const shards = Number(stages[0].detail?.shards);
    if (!Number.isFinite(shards) || shards < 1) return null;
    for (let i = 1; i <= shards; i++) secIds.push(`分片 ${i}`);
  }
  const latest = new Map();
  for (const entry of stages) {
    const secId = entry.detail?.secId;
    if (!secId) continue;
    latest.set(String(secId), entry.detail.shardStatus);
  }
  const failedIds = new Set(
    (error?.details?.failedSections ?? []).map(item => String(item?.secId || '')).filter(Boolean),
  );
  const terminalFail = status === 'failed';
  return secIds.map(secId => {
    let state = 'queued';
    if (failedIds.has(secId)) state = 'failed';
    else if (latest.get(secId) === 'done') state = 'done';
    else if (latest.get(secId) === 'failed') state = 'failed';
    else if (latest.get(secId) === 'running') state = terminalFail ? 'failed' : 'current';
    const statusLabel = SHARD_STATE_LABEL[state] || state;
    return { key: secId, secId, label: `${secId} · ${statusLabel}`, state };
  });
}

const SECTION_STATE_LABEL = { queued: '排队', current: '进行中', done: '完成', failed: '失败' };

/** 批量深挖开工目标列表（#83 的 deep-dive-queued 事件）；无该事件（#83 前的任务）为 null。 */
function deepDiveQueuedTargets(details) {
  for (let i = details.length - 1; i >= 0; i--) {
    const entry = details[i];
    const targets = entry?.detail?.targets;
    if (entry?.event === 'stage' && entry.detail?.stage === 'deep-dive-queued' && Array.isArray(targets) && targets.length) {
      return targets;
    }
  }
  return null;
}

/**
 * 批量深挖各节状态流（#83）：deep-dive-queued 事件列出全部目标（开工即画出 N 行），
 * 再按 partId 归约各节开工 / 完成 / 失败（sectionStatus 与 error.details.failedSections），
 * 运行中节附「第 n 轮」（复用 #80 的按 partId 运行态归约）；已取消任务的在飞节标「已取消」。
 * 返回 [{ key, partId, title, label, state }]；无 queued 事件（旧任务）为 null；
 * 成功终态不再显示（与 l2ShardFlow 一致）。
 */
export function deepDiveSectionFlow({ details = [], status = 'running', error = null } = {}) {
  if (status === 'succeeded') return null;
  const targets = deepDiveQueuedTargets(details);
  if (!targets) return null;
  const latest = new Map();
  for (const entry of details) {
    const detail = entry?.detail;
    if (entry?.event !== 'stage' || detail?.stage !== 'deep-dive' || !detail?.partId) continue;
    latest.set(String(detail.partId), detail);
  }
  const failedIds = new Set(
    (error?.details?.failedSections ?? []).map(item => String(item?.partId || '')).filter(Boolean),
  );
  const terminalFail = status === 'failed';
  return targets.map((target, position) => {
    const partId = String(target?.partId ?? '');
    const title = typeof target?.title === 'string' && target.title ? target.title : partId;
    const index = Number.isFinite(Number(target?.index)) ? Number(target.index) : position + 1;
    const stage = latest.get(partId);
    let state = 'queued';
    if (failedIds.has(partId) || stage?.sectionStatus === 'failed') state = 'failed';
    else if (stage?.sectionStatus === 'done') state = 'done';
    else if (stage) state = terminalFail ? 'failed' : 'current';
    let stateLabel = SECTION_STATE_LABEL[state] || state;
    if (state === 'current') {
      if (status === 'cancelled') {
        stateLabel = '已取消';
      } else {
        const run = deepDiveRunState(details, partId, status);
        if (Number.isFinite(run?.round)) stateLabel = `第 ${run.round} 轮`;
      }
    }
    return { key: partId || `section-${index}`, partId, title, label: `${index}. ${title} · ${stateLabel}`, state };
  });
}

/**
 * 批量深挖轨迹按节分栏（#83）：round / tool 按 partId 归位，节序沿用 queued 目标序；
 * 只保留有轨迹的节。targets 为 deep-dive-queued 事件的目标列表。
 * 返回 [{ key, title, items, toolCount }]。
 */
function traceItemsBySection(details, targets) {
  const groups = new Map(targets.map(target => [String(target?.partId ?? ''), []]));
  for (const entry of details) {
    const partId = String(entry?.detail?.partId ?? '');
    const group = groups.get(partId);
    if (!group) continue;
    if (entry.event === 'round') group.push({ kind: 'round', ...roundView(entry.detail) });
    else if (entry.event === 'tool') group.push({ kind: 'tool', ...toolStepView(entry.detail) });
  }
  return targets
    .map((target, position) => {
      const partId = String(target?.partId ?? '');
      const title = typeof target?.title === 'string' && target.title ? target.title : partId;
      return { key: partId || `section-${position}`, title, items: groups.get(partId) ?? [] };
    })
    .filter(section => section.items.length)
    .map(section => ({ ...section, toolCount: section.items.filter(item => item.kind === 'tool').length }));
}

/** 四件取证工具的步骤呈现：目标文本 + 结果摘要同表登记（新增工具只动这一张表）。 */
const TOOL_STEP_FORMAT = {
  read_section: {
    target: args => {
      const sec = args.sec_id || '?';
      const offset = Number(args.offset);
      return Number.isFinite(offset) && offset > 1 ? `${sec} 自第 ${offset} 块` : sec;
    },
    result: result => {
      const blocks = Number(result?.blocks);
      const total = Number(result?.total);
      let text = Number.isFinite(blocks) && Number.isFinite(total) ? `${blocks}/${total} 块` : '已读块窗口';
      if (result?.truncated) text += ' · 余量见页图';
      return text;
    },
  },
  search_paper: {
    target: args => `「${args.pattern ?? ''}」`,
    result: result => {
      const hits = Number(result?.hits);
      let text = Number.isFinite(hits) ? `${hits} 处命中` : '已返回指针';
      if (result?.truncated) text += ' · 超帽截断';
      return text;
    },
  },
  get_figure: {
    target: args => String(args.fig_id ?? '?'),
    result: result => (Number.isFinite(Number(result?.page)) ? `p${result.page} 裁切图` : '裁切图'),
  },
  get_page_image: {
    target: args => `p${args.page ?? '?'}`,
    result: result => (Number.isFinite(Number(result?.page)) ? `p${result.page} 页图` : '页图'),
  },
};

/** 工具轨迹单步呈现：「第 N 步 · name(目标) → 结果摘要」；失败步带错误码。 */
export function toolStepView(detail = {}) {
  const step = Number(detail.step);
  const name = String(detail.name || '');
  const args = detail.args && typeof detail.args === 'object' ? detail.args : {};
  const format = TOOL_STEP_FORMAT[name];
  const target = format ? format.target(args) : '';
  const ok = detail.ok !== false;
  let text = `第 ${Number.isFinite(step) ? step : '?'} 步 · ${name || '未知工具'}(${target})`;
  if (ok) {
    const result = format ? format.result(detail.result) : '完成';
    text += ` → ${result}`;
  } else {
    const code = detail.error?.code || 'error';
    text += ` ✕ ${code}`;
  }
  return { step: Number.isFinite(step) ? step : 0, ok, text };
}

/**
 * 任务的 detail 事件序列：快照 task.details 优先——JS 订阅建立前发出的事件不经事件通道
 * 重放（#72 走查实测：深挖批量推进快于订阅建立时，阶段/首步事件丢失），快照日志是完整源；
 * 无 details 字段时由会话登记（meta.stageDetail/lastDetail/steps）重建回退。
 */
function taskDetails(task, meta) {
  if (Array.isArray(task?.details)) return task.details;
  const out = [];
  if (meta?.stageDetail) out.push({ event: 'stage', detail: meta.stageDetail });
  if (meta?.lastDetail) out.push({ event: 'stage', detail: meta.lastDetail });
  for (const step of meta?.steps ?? []) out.push({ event: 'tool', detail: step });
  return out;
}

function lastDetailOf(details, event) {
  for (let i = details.length - 1; i >= 0; i--) {
    if (details[i]?.event === event) return details[i].detail;
  }
  return null;
}

/**
 * 协议任务在任务中心的附加呈现模型。task 为 tasks.list@1 快照条目（含 details 日志），
 * meta 为会话登记（可缺失——缺失时回退重建）。返回 { stageFlow?, shardFlow?, subProgress?, steps?,
 * stepsTotal?, trace?, timings? }；非协议/解析任务返回 {}。
 * trace 按 details 原序把 round / tool 插成一行，供阶段流/轨迹流就地插入轮次行。
 */
export function taskDetailModel({ task = {}, meta = null } = {}) {
  const bare = String(task.kind || '').replace(/@\d+$/, '');
  const details = taskDetails(task, meta);
  if (bare === 'pdfparse.convert') {
    const timings = convertTimingRows(task.result);
    return timings.length ? { timings } : {};
  }
  if (bare === 'paper.build-map') {
    const stageFlow = buildMapStageFlow(lastDetailOf(details, 'stage'), task.status, task.progress);
    const out = {};
    if (stageFlow) out.stageFlow = stageFlow;
    const shardFlow = l2ShardFlow({ details, status: task.status, error: task.error });
    if (shardFlow) out.shardFlow = shardFlow;
    const liveLine = liveLineOf(details, task.status);
    if (liveLine) out.liveLine = liveLine;
    const trace = traceItems(details);
    if (trace.length) out.trace = trace;
    return out;
  }
  if (bare === 'paper.deep-dive') {
    const out = {};
    // #83：deep-dive-queued 事件驱动的按节分组；无该事件的旧任务回退串行呈现
    // （逐节子进度取最后一条开工 stage 的 index/total）。
    const targets = deepDiveQueuedTargets(details);
    const batch = (targets?.length ?? 0) > 1;
    const sectionFlow = deepDiveSectionFlow({ details, status: task.status, error: task.error });
    // 单节不呈现状态流（一行是噪音，与 #83 前的单节呈现一致）。
    if (batch && sectionFlow) {
      out.sectionFlow = sectionFlow;
    } else if (!targets) {
      const detail = lastDetailOf(details, 'stage');
      const index = Number(detail?.index);
      const total = Number(detail?.total);
      // 逐节子进度只在批量时呈现（单节的 1/1 是噪音）；批量判定取阶段事件的 total，
      // 不依赖会话登记的 input.partIds（订阅前丢失场景下仍正确）。
      if (Number.isFinite(index) && Number.isFinite(total) && total > 1) {
        out.subProgress = { index, total, title: typeof detail.title === 'string' ? detail.title : '' };
      }
    }
    const steps = details
      .filter(entry => entry?.event === 'tool')
      .map(entry => toolStepView(entry.detail));
    if (steps.length) {
      out.steps = steps;
      out.stepsTotal = steps.length;
    }
    const liveLine = liveLineOf(details, task.status);
    if (liveLine) out.liveLine = liveLine;
    // 轨迹：批量按节分栏（含终态回看），单节（或旧任务）保持平铺。
    if (batch) {
      const sectionTraces = traceItemsBySection(details, targets);
      if (sectionTraces.length) out.sectionTraces = sectionTraces;
    } else {
      const trace = traceItems(details);
      if (trace.length) out.trace = trace;
    }
    return out;
  }
  if (bare === 'paper.synthesize') {
    const trace = traceItems(details);
    return trace.length ? { trace } : {};
  }
  return {};
}

/** 按快照 details 原序穿插模型轮与工具步。 */
function traceItems(details) {
  const items = [];
  for (const entry of details) {
    if (entry?.event === 'round') items.push({ kind: 'round', ...roundView(entry.detail) });
    else if (entry?.event === 'tool') items.push({ kind: 'tool', ...toolStepView(entry.detail) });
  }
  return items;
}

// ---------------- #80：轮次进度与最终稿预览 ----------------

const LIVE_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** 工具调用短标签：「name(目标)」，目标文本复用工具步呈现表。 */
export function toolCallLabel(detail = {}) {
  const name = String(detail.name || '');
  const args = detail.args && typeof detail.args === 'object' ? detail.args : {};
  const format = TOOL_STEP_FORMAT[name];
  const target = format ? format.target(args) : '';
  return target ? `${name}(${target})` : (name || '未知工具');
}

/**
 * 深挖运行态归约（#80）：detail 事件序列 → { round, currentTool, receivedChars, previewText }。
 * 只消费本 partId 的 round-start / tool / round / preview；终态返回 null（预览由产物或错误替换）。
 * 容错：重复事件幂等；轮号回退的乱序 round-start 忽略；事件缺失时可由 tool/round/preview 起步。
 */
export function deepDiveRunState(details, partId, status) {
  if (LIVE_TERMINAL.has(status)) return null;
  const want = String(partId ?? '');
  let state = null;
  const ensure = () => (state ??= { round: null, currentTool: null, receivedChars: 0, previewText: null });
  for (const entry of details ?? []) {
    const detail = entry?.detail;
    if (!detail || String(detail.partId ?? '') !== want) continue;
    if (entry.event === 'round-start') {
      const round = Number(detail.round);
      if (!Number.isFinite(round)) continue;
      if (state && Number.isFinite(state.round) && round < state.round) continue;
      state = { round, currentTool: null, receivedChars: 0, previewText: null };
    } else if (entry.event === 'tool') {
      ensure().currentTool = {
        name: String(detail.name || ''),
        args: detail.args && typeof detail.args === 'object' ? detail.args : {},
      };
    } else if (entry.event === 'round') {
      const chars = Number(detail.receivedChars);
      if (Number.isFinite(chars)) ensure().receivedChars = chars;
    } else if (entry.event === 'preview') {
      if (typeof detail.text === 'string') {
        const current = ensure();
        current.previewText = detail.text;
        current.receivedChars = detail.text.length;
      } else if (detail.text === null) {
        ensure().previewText = null;
      }
    }
  }
  return state;
}

/** 深挖状态行：「第 n 轮 · 正在调用 name(目标) · 已收到 x 字」（缺项省略）。 */
export function deepDiveStatusLine(state) {
  if (!state) return '';
  const parts = [];
  if (Number.isFinite(state.round)) parts.push(`第 ${state.round} 轮`);
  if (state.currentTool) parts.push(`正在调用 ${toolCallLabel(state.currentTool)}`);
  const chars = Number(state.receivedChars);
  if (Number.isFinite(chars) && chars > 0) parts.push(`已收到 ${chars} 字`);
  return parts.join(' · ');
}

/**
 * 复述稿运行态归约（#80）：preview 事件序列 → { receivedChars, previewText }；
 * text=null 清空预览；终态返回 null（预览由产物或错误替换）。
 */
export function synthesizeRunState(details, status) {
  if (LIVE_TERMINAL.has(status)) return null;
  let state = null;
  for (const entry of details ?? []) {
    if (entry?.event !== 'preview') continue;
    const detail = entry.detail;
    if (!detail) continue;
    if (typeof detail.text === 'string') {
      state = { receivedChars: detail.text.length, previewText: detail.text };
    } else if (detail.text === null && state) {
      state.previewText = null;
    }
  }
  return state;
}

/** round-start 摘要行（#80）：「第 n 轮开始 · 上下文约 x token」。 */
export function roundStartView(detail = {}) {
  const round = Number(detail.round);
  let text = `第 ${Number.isFinite(round) ? round : '?'} 轮开始`;
  const tokens = Number(detail.contextTokensEstimated);
  if (Number.isFinite(tokens) && tokens > 0) text += ` · 上下文约 ${tokens} token`;
  return { text };
}

/** round-progress 摘要行（#80）：「分片 n · 已收到 x 字 · y s」（无分片时省略前缀）。 */
export function roundProgressView(detail = {}) {
  const parts = [];
  const shard = Number(detail.shard);
  if (Number.isFinite(shard)) parts.push(`分片 ${shard}`);
  const chars = Number(detail.receivedChars);
  parts.push(`已收到 ${Number.isFinite(chars) ? chars : '?'} 字 · ${formatSeconds(detail.elapsedMs)} s`);
  return { text: parts.join(' · ') };
}

/** 轮次进度摘要行选择（#80）：取最新一条 round-start / round-progress；成功终态不再显示。 */
function liveLineOf(details, status) {
  if (status === 'succeeded') return null;
  for (let i = details.length - 1; i >= 0; i--) {
    if (details[i]?.event === 'round-start') return roundStartView(details[i].detail).text;
    if (details[i]?.event === 'round-progress') return roundProgressView(details[i].detail).text;
  }
  return null;
}

function formatSeconds(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? (n / 1000).toFixed(1) : '?';
}

/** 一轮模型调用的任务中心行：「第 n 轮 · 首字 x s · 总 y s · 输入 a / 输出 b · 缓存 c」。 */
export function roundView(detail = {}) {
  const round = Number(detail.round);
  let text = `第 ${Number.isFinite(round) ? round : '?'} 轮 · 首字 ${formatSeconds(detail.ttftMs)} s · 总 ${formatSeconds(detail.elapsedMs)} s`;
  const prompt = Number(detail.promptTokens);
  const completion = Number(detail.completionTokens);
  if (Number.isFinite(prompt) || Number.isFinite(completion)) {
    text += ` · 输入 ${Number.isFinite(prompt) ? prompt : '—'} / 输出 ${Number.isFinite(completion) ? completion : '—'}`;
  }
  const cached = Number(detail.cachedTokens);
  if (Number.isFinite(cached)) text += ` · 缓存 ${cached}`;
  const reasoning = Number(detail.reasoningTokens);
  const reasoningMs = Number(detail.reasoningMs);
  if (Number.isFinite(reasoningMs) && reasoningMs > 0) {
    text += ` · 思考 ${formatSeconds(reasoningMs)} s`;
  }
  return {
    text,
    reasoning: (Number.isFinite(reasoning) && reasoning > 0) || (Number.isFinite(reasoningMs) && reasoningMs > 0),
  };
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 解析任务的计时拆分表：启动 / 模型加载 / 版面 / 表格 / OCR / 其他 / 总计。 */
export function convertTimingRows(result = {}) {
  const timings = result?.timings && typeof result.timings === 'object' ? result.timings : {};
  const secToMs = key => {
    const n = Number(timings[key]);
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  };
  // 「其他」= 未单独成行的阶段：页解析、装配、阅读顺序，以及未归类项。
  const otherKeys = ['page', 'assemble', 'readingOrder', 'other'];
  const otherSeconds = otherKeys.reduce((sum, key) => {
    const n = Number(timings[key]);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
  const otherMs = otherKeys.some(key => Number.isFinite(Number(timings[key])))
    ? Math.round(otherSeconds * 1000)
    : null;
  const rows = [
    { key: 'startup', label: '启动', ms: numOrNull(result.startupMs) },
    { key: 'modelLoad', label: '模型加载', ms: numOrNull(result.modelLoadMs) },
    { key: 'layout', label: '版面分析', ms: secToMs('layout') },
    { key: 'table', label: '表格结构', ms: secToMs('table') },
    { key: 'ocr', label: 'OCR', ms: secToMs('ocr') },
    { key: 'other', label: '其他', ms: otherMs },
    { key: 'total', label: '总计', ms: numOrNull(result.wallClockMs) ?? numOrNull(result.elapsedMs) },
  ];
  return rows.filter(row => row.ms != null);
}

// ---------------- 导出笔记（决策 21） ----------------

/** 导出笔记格式说明：v2 = 协议产物为正源，旧精读结果只读附录。 */
export const NOTES_FORMAT_NOTE = '笔记格式 v2 · 内容源：三层阅读协议产物（L1 阅读地图 / L2 节薄摘要 / 深挖 / 复述稿）；旧精读结果保留于文末附录（只读）';

/** YYYY-MM-DD（main.js 壳与导出共用此唯一实现）。 */
export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 评分 → 星级文本（main.js 壳与导出共用此唯一实现）。 */
export function ratingText(value) {
  const rating = Math.min(Math.max(Number(value) || 0, 0), 5);
  return rating ? `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}` : '未评分';
}

function refsSuffix(refs) {
  const list = (Array.isArray(refs) ? refs : []).filter(item => typeof item === 'string' && item.trim());
  return list.length ? ` ${list.join(' ')}` : '';
}

/** 带出处条目的导出文本：text + 原样保留的出处指针串。 */
function citedLine(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  if (!text) return '';
  return `${text}${refsSuffix(entry.refs)}`;
}

/** 节标题：优先块模型节标题，回退精读部分 label。 */
function sectionTitle(mapped, partId, fallbackLabel) {
  const section = sectionForPart(mapped, partId);
  return section?.title || fallbackLabel || partId;
}

/**
 * 导出笔记 Markdown：内容源为协议产物（L1/L2/深挖/复述稿），旧精读结果只读附录。
 * mapped 为当前块模型（可为 null——未建图或未加载时回退精读部分标签）。
 */
export function notesMarkdown({ paper, mapped = null, now = Date.now() } = {}) {
  if (!paper) return '';
  const products = Array.isArray(paper.products) ? paper.products : [];
  const meta = [
    `导入日期：${fmtDate(paper.addedAt)}`,
    `导出日期：${fmtDate(now)}`,
    `评分：${ratingText(paper.rating)}`,
    paperCategories(paper).length ? `分类：${paperCategories(paper).join('、')}` : '',
    paperTags(paper).length ? `标签：${paperTags(paper).join('、')}` : '',
  ].filter(Boolean).join(' · ');
  const lines = [`# 精读笔记：${paper.title}`, '', `> ${meta}`, `> ${NOTES_FORMAT_NOTE}`, ''];
  let hasProductBody = false;

  if (paper.recallCard?.markdown) {
    lines.push('## 回想卡片', '', paper.recallCard.markdown, '');
  }

  const map = productOf(products, 'map')?.body;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    hasProductBody = true;
    lines.push('## 阅读地图（L1）', '');
    const problem = citedLine(map.problem);
    const method = citedLine(map.method);
    if (problem) lines.push('### 要解决的问题', '', problem, '');
    if (method) lines.push('### 方法概述', '', method, '');
    const contributions = (Array.isArray(map.contributions) ? map.contributions : []).map(citedLine).filter(Boolean);
    if (contributions.length) {
      lines.push('### 贡献声明', '');
      for (const item of contributions) lines.push(`- ${item}`);
      lines.push('');
    }
    const evidence = (Array.isArray(map.keyEvidence) ? map.keyEvidence : [])
      .map(item => {
        if (!item || typeof item !== 'object') return '';
        const head = item.assetId ? `(${item.assetId})` : '';
        const note = typeof item.note === 'string' ? item.note.trim() : '';
        const line = `${head}${head && note ? ' ' : ''}${note}${refsSuffix(item.refs)}`.trim();
        return line;
      })
      .filter(Boolean);
    if (evidence.length) {
      lines.push('### 关键证据', '');
      for (const item of evidence) lines.push(`- ${item}`);
      lines.push('');
    }
    const glossary = (Array.isArray(map.glossary) ? map.glossary : [])
      .map(item => {
        if (!item || typeof item !== 'object') return '';
        const term = typeof item.term === 'string' ? item.term.trim() : '';
        if (!term) return '';
        const defRef = typeof item.defRef === 'string' ? item.defRef : '';
        return defRef ? `${term}（定义见 ${defRef}）` : term;
      })
      .filter(Boolean);
    if (glossary.length) {
      lines.push('### 术语表', '');
      for (const item of glossary) lines.push(`- ${item}`);
      lines.push('');
    }
  }

  const retell = productOf(products, 'retell')?.body;
  if (typeof retell === 'string' && retell.trim()) {
    hasProductBody = true;
    lines.push('## 复述稿（综合）', '', retell, '');
  }

  // 节区：按块模型 L2 节顺序（无块模型回退精读部分），只列有薄摘要或深挖结果的节。
  const partIds = mapped
    ? l2Sections(mapped).map(section => partIdForSection(mapped, section.id)).filter(Boolean)
    : readingParts(paper).map(part => part.id);
  const fallbackLabels = new Map(readingParts(paper).map(part => [part.id, part.label]));
  const sectionLines = [];
  for (const partId of partIds) {
    const l2 = productOf(products, 'l2', partId)?.body;
    const dig = productOf(products, 'dig', partId)?.body;
    const l2Body = l2 && typeof l2 === 'object' && !Array.isArray(l2) ? l2 : null;
    const digBody = typeof dig === 'string' && dig.trim() ? dig : '';
    if (!l2Body && !digBody) continue;
    hasProductBody = true;
    sectionLines.push(`### ${sectionTitle(mapped, partId, fallbackLabels.get(partId))}`, '');
    if (l2Body) {
      if (typeof l2Body.gist === 'string' && l2Body.gist.trim()) {
        sectionLines.push(`**薄摘要**：${l2Body.gist.trim()}`, '');
      }
      const points = (Array.isArray(l2Body.points) ? l2Body.points : []).map(citedLine).filter(Boolean);
      for (const point of points) sectionLines.push(`- ${point}`);
      if (points.length) sectionLines.push('');
      const assets = (Array.isArray(l2Body.keyAssets) ? l2Body.keyAssets : []).filter(item => typeof item === 'string' && item);
      const start = Number(l2Body.pages?.start);
      const end = Number(l2Body.pages?.end);
      const bits = [];
      if (assets.length) bits.push(`关键图表：${assets.join('、')}`);
      if (Number.isFinite(start) && Number.isFinite(end)) bits.push(`页码：p${start}–p${end}`);
      if (bits.length) sectionLines.push(bits.join(' · '), '');
    }
    if (digBody) sectionLines.push('**深挖结果**：', '', dig, '');
  }
  if (sectionLines.length) lines.push('## 节薄摘要与深挖', '', ...sectionLines);

  if (!hasProductBody) {
    lines.push('（本论文尚未建图，暂无协议产物；建图后导出的笔记将以阅读地图、薄摘要与深挖结果为内容源。）', '');
  }

  // 附录：旧精读结果只读留存（决策 21），不参与正文。
  const legacy = readingParts(paper)
    .map(part => ({ part, analysis: paper.analyses?.[part.id] }))
    .filter(item => typeof item.analysis?.text === 'string' && item.analysis.text.trim());
  if (legacy.length) {
    lines.push('## 附录：旧精读结果（只读）', '');
    lines.push('> 以下为旧版精读流程产出的结果，仅作留存回看，不参与新协议。', '');
    for (const { part, analysis } of legacy) {
      const stamp = Number.isFinite(analysis.updatedAt) ? `（更新于 ${fmtDate(analysis.updatedAt)}）` : '';
      lines.push(`### ${part.label}${stamp}`, '', analysis.text, '');
    }
  }

  return lines.join('\n');
}
