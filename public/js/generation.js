// 生成任务（ADR-0005）：精读生成（单节与批量生成）的任务身份、生命周期、取消语义与增量流归属。
// 结果经 papers.saveAnalysis 缝提交（ADR-0004）；模型调用与设置读取经 init 注入，Node 可测。
// 任务状态机：running → completed | failed | cancelling → cancelled；done 只 resolve 不 reject。
import * as papers from './papers.js';
import { getSkill, buildPrompt } from './skills.js';

// 中断部分结果的保留规则：trim 后超过该长度才连同警示标记落库，否则丢弃。
const PARTIAL_MIN_CHARS = 60;
const PARTIAL_MARKER = '\n\n> ⚠️ 生成被中断，内容为部分结果。';

let deps = null;            // { chat, loadSettings }
let nextTaskId = 1;
const tasks = new Map();    // 任务 registry：id -> 精读任务，不对外暴露
const batches = new Set();  // 进行中的批量生成

/** 注入模型调用与设置读取；浏览器端在启动时接线，测试注入可控实现。 */
export function init(dependencies) {
  deps = dependencies;
}

function requireDeps() {
  if (!deps) throw new Error('generation.init 尚未调用');
}

// 同论文互斥：running 与 cancelling（收尾中）都占用互斥位。
function activeTaskFor(paper) {
  for (const task of tasks.values()) {
    if (task.paper === paper && (task.status === 'running' || task.status === 'cancelling')) return task;
  }
  return null;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n[……原文过长，已截断……]';
}

// 界面回调（sinks/hooks）的错误不渗入任务生命周期：记录日志后继续，保证 done 只 resolve 不 reject。
function safeCall(fn, ...args) {
  if (!fn) return undefined;
  try {
    return fn(...args);
  } catch (err) {
    console.error('生成任务的界面回调出错：', err);
    return undefined;
  }
}

/**
 * 启动单节精读任务，返回 { accepted, reason?, task?, done? }。
 * reason：'no-source'（无原文，未启动）| 'busy'（同论文已有精读任务进行中，被拒绝）。
 * 任务持有论文引用，完成与中断落库永不读全局当前论文。
 */
export function startSection(paper, sectionId, sinks = {}) {
  requireDeps();
  const content = paper.sections?.[sectionId]?.trim();
  if (!content) return { accepted: false, reason: 'no-source' };
  if (activeTaskFor(paper)) return { accepted: false, reason: 'busy' };
  const def = papers.readingParts(paper).find(section => section.id === sectionId);
  const task = {
    id: nextTaskId++,
    kind: 'analysis',
    paper,
    sectionId,
    status: 'running',
    text: '',  // 原始增量流归属任务：累积缓冲，中断部分结果从此截取
    controller: new AbortController(),
    cancel() { cancelTask(task); },
    done: null,
  };
  tasks.set(task.id, task);
  safeCall(sinks.onStart);
  task.done = runTask(task, def, content, sinks);
  return { accepted: true, task, done: task.done };
}

async function runTask(task, def, content, sinks) {
  const { paper, sectionId } = task;
  try {
    const skill = getSkill(def?.skillId || sectionId);
    const { maxChars } = deps.loadSettings();
    const prompt = buildPrompt(skill, paper.title, truncate(content, maxChars), def?.label || sectionId);
    const text = await deps.chat([{ role: 'user', content: prompt }], {
      stream: true,
      signal: task.controller.signal,
      onDelta: full => {
        task.text = full;
        safeCall(sinks.onUpdate, full);
      },
    });
    if (!text.trim()) throw new Error('模型未返回内容');
    await papers.saveAnalysis(paper, sectionId, text);
    task.status = 'completed';
    const result = { status: 'completed', text };
    safeCall(sinks.onSettled, result);
    return result;
  } catch (err) {
    let result;
    if (err.name === 'AbortError') {
      const partial = task.text.trim();
      let saved = null;
      if (partial.length > PARTIAL_MIN_CHARS) {
        const text = partial + PARTIAL_MARKER;
        try {
          await papers.saveAnalysis(paper, sectionId, text);
          saved = text;
        } catch (saveErr) {
          // 落库失败不改变任务已取消的终态；done 仍须 resolve。
          console.error('中断部分结果落库失败：', saveErr);
        }
      }
      task.status = 'cancelled';
      result = { status: 'cancelled', saved, error: err };
    } else {
      task.status = 'failed';
      result = { status: 'failed', error: err };
    }
    safeCall(sinks.onSettled, result);
    return result;
  } finally {
    tasks.delete(task.id);
  }
}

// 取消幂等：仅 running 可转为 cancelling，cancelling/终态重复取消不动作。
function cancelTask(task) {
  if (task.status !== 'running') return;
  task.status = 'cancelling';
  task.controller.abort();
}

/**
 * 启动批量生成（编排），返回 { accepted, reason?, batch?, done? }。
 * 规则：按 readingParts 顺序串行；单节失败或无原文（skipped）不中断后续；
 * 取消（batch.cancel 或 cancelForPaper）使当前节按中断语义收尾且不再推进。
 * hooks：onSectionStart(def) 可返回该节渲染 sinks；onSectionSettled(def, result) 逐节通知。
 */
export function startBatch(paper, hooks = {}) {
  requireDeps();
  if (activeTaskFor(paper)) return { accepted: false, reason: 'busy' };
  const batch = {
    id: nextTaskId++,
    kind: 'batch',
    paper,
    status: 'running',
    current: null, // 进行中的节任务
    cancel() {
      if (batch.status !== 'running') return;
      batch.status = 'cancelling';
      if (batch.current) cancelTask(batch.current);
    },
    done: null,
  };
  batches.add(batch);
  batch.done = runBatch(batch, hooks);
  return { accepted: true, batch, done: batch.done };
}

async function runBatch(batch, hooks) {
  const results = [];
  try {
    for (const def of papers.readingParts(batch.paper)) {
      if (batch.status !== 'running') break;
      const sinks = safeCall(hooks.onSectionStart, def) || {};
      const started = startSection(batch.paper, def.id, sinks);
      if (!started.accepted) {
        const skipped = { status: 'skipped', reason: started.reason };
        results.push({ sectionId: def.id, ...skipped });
        safeCall(hooks.onSectionSettled, def, skipped);
        continue;
      }
      batch.current = started.task;
      const result = await started.done;
      batch.current = null;
      results.push({ sectionId: def.id, ...result });
      safeCall(hooks.onSectionSettled, def, result);
    }
  } finally {
    batches.delete(batch);
  }
  batch.status = batch.status === 'cancelling' ? 'cancelled' : 'completed';
  return { status: batch.status, results };
}

/** 取消该论文全部进行中的生成（单节或批量），返回等全部收尾（含中断保存）完成的 promise。 */
export async function cancelForPaper(paper) {
  const pending = [];
  for (const batch of batches) {
    if (batch.paper === paper) {
      batch.cancel();
      pending.push(batch.done);
    }
  }
  for (const task of tasks.values()) {
    if (task.paper === paper) {
      cancelTask(task);
      pending.push(task.done);
    }
  }
  await Promise.all(pending);
}
