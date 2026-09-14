// 提问三形态上下文组装（#67 / 规格 #52 决策 4–8）：
// 缝 = assembleQaContext 纯函数。断言配方输出形状、12 条历史窗口、绑定重放形态、
// 图表占位覆盖检测与附图、超长护栏；不测内部拼装顺序之外的实现细节。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { INPUT_TOKEN_HARD_TOP, PAGE_IMAGE_TOKEN_BUDGET, renderSectionText } from '../ui/js/protocol.js';
import {
  CHAT_HISTORY_WINDOW,
  assembleQaContext,
  cropAttachmentId,
  pageAttachmentId,
  prerenderAssetsReady,
} from '../ui/js/qa.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapped = JSON.parse(
  readFileSync(path.join(here, '..', 'src-tauri', 'tests', 'fixtures', 'protocol', 'blockmodel-basic.json'), 'utf-8'),
);

const mapBody = {
  problem: { text: '地图问题：小样例如何解决。', refs: ['(p1)'] },
  method: { text: '用地图方法概述。', refs: [] },
};
const products = [
  { kind: 'map', partId: '', body: mapBody, updatedAt: 1 },
  { kind: 'l2', partId: 'abstract', body: { secId: 'sec_1_abstract', gist: '摘要薄摘要独有句。', points: [{ text: 'p', refs: [] }] }, updatedAt: 1 },
  { kind: 'l2', partId: 'part-1', body: { secId: 'sec_2_introduction', gist: '引言薄摘要独有句。', points: [{ text: 'p', refs: [] }] }, updatedAt: 1 },
  { kind: 'l2', partId: 'part-2', body: { secId: 'sec_3_method', gist: '方法薄摘要独有句。', points: [{ text: 'p', refs: [] }] }, updatedAt: 1 },
];

function assemble(overrides = {}) {
  return assembleQaContext({
    title: mapped.title,
    mapped,
    products,
    history: [],
    question: '这节在说什么？',
    binding: { bindingKind: 'none' },
    ...overrides,
  });
}

function systemText(messages) {
  const system = messages.find(message => message.role === 'system');
  assert.ok(system, '装配结果须含 system 消息');
  assert.equal(typeof system.content, 'string');
  return system.content;
}

function lastUser(messages) {
  const users = messages.filter(message => message.role === 'user');
  assert.ok(users.length, '装配结果须含 user 消息');
  return users.at(-1);
}

function userText(message) {
  if (typeof message.content === 'string') return message.content;
  assert.ok(Array.isArray(message.content), '多模态 user.content 须为 parts 数组');
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('');
}

function imageUrls(message) {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter(part => part.type === 'image_url')
    .map(part => part.image_url?.url);
}

test('协议常量：历史窗口 12、硬顶与裁切图附件 id 约定', () => {
  assert.equal(CHAT_HISTORY_WINDOW, 12);
  assert.equal(INPUT_TOKEN_HARD_TOP, 983_616);
  assert.equal(cropAttachmentId('fig_1'), 'crop-fig_1');
  assert.equal(cropAttachmentId('tbl_1'), 'crop-tbl_1');
});

test('全文提问：L1 + 整篇原文，不含 L2、不含裁切图，不截断', () => {
  const { messages, cropAssetIds, estimatedTokens } = assemble({
    question: '这篇论文要解决什么问题？',
  });
  const system = systemText(messages);
  assert.ok(system.includes(mapped.title));
  assert.ok(system.includes('地图问题：小样例如何解决。'), '全文配方带 L1');
  assert.ok(system.includes('本文研究小样例问题，提出样例方法。'), '摘要原文全送');
  assert.ok(system.includes('研究背景：小样例问题长期存在。'), '引言原文全送');
  assert.ok(system.includes('方法第一步：读取输入。'), '方法原文全送');
  assert.ok(system.includes('[1] 样例文献。'), 'References 进入整篇原文');
  assert.ok(!system.includes('作者甲 作者乙'), 'frontmatter 不进问答原文');
  assert.ok(!system.includes('摘要薄摘要独有句。'), '全文配方不带 L2');
  assert.ok(!system.includes('引言薄摘要独有句。'));
  assert.ok(!system.includes('[……原文过长，已截断……]'), '现行截断注入退役');
  assert.ok(system.includes('(p5)') && system.includes('(fig_3)') && system.includes('(sec_2:L30-34)'), '系统提示含统一出处语法');
  assert.deepEqual(cropAssetIds, []);
  assert.equal(userText(lastUser(messages)), '这篇论文要解决什么问题？');
  assert.equal(typeof lastUser(messages).content, 'string', '全文提问是纯文本消息');
  assert.ok(estimatedTokens > 0);
});

test('未建图时拒绝装配，不静默降级到截断注入', () => {
  assert.throws(
    () => assemble({ products: [] }),
    err => err.code === 'map_required' && /先.*建图/.test(err.message),
  );
});

test('@节提问：L1 + 该节 L2 + 节原文全送，不带其他节原文与页图', () => {
  const { messages, cropAssetIds } = assemble({
    question: '这节的贡献是什么？',
    binding: { bindingKind: 'section', secId: 'sec_2_introduction' },
  });
  const system = systemText(messages);
  assert.ok(system.includes('地图问题：小样例如何解决。'), '@节带 L1');
  assert.ok(system.includes('引言薄摘要独有句。'), '@节带该节 L2');
  assert.ok(!system.includes('方法薄摘要独有句。'), '不带其他节 L2');
  assert.ok(system.includes('研究背景：小样例问题长期存在。'));
  assert.ok(system.includes('[图 fig_1]'), '节内图表占位以文本保留');
  assert.ok(system.includes(renderSectionText(mapped.sections[1])));
  assert.ok(!system.includes('方法第一步：读取输入。'), '不送其他节原文');
  assert.ok(!system.includes('[1] 样例文献。'));
  assert.deepEqual(cropAssetIds, [], '@节不附裁切图（页图也不进问答）');
  assert.match(userText(lastUser(messages)), /^\[@Introduction\]\n这节的贡献是什么？$/);
});

test('@节提问覆盖 References：无 L2 仍送该节原文', () => {
  const { messages } = assemble({
    question: '第一篇文献是什么？',
    binding: { bindingKind: 'section', secId: 'sec_4_references' },
  });
  const system = systemText(messages);
  assert.ok(system.includes('[1] 样例文献。'));
  assert.ok(!system.includes('引言薄摘要独有句。'));
  assert.ok(!system.includes('研究背景：小样例问题长期存在。'));
  assert.match(userText(lastUser(messages)), /^\[@References\]\n/);
});

test('@节提问：内容节缺 L2 时拒绝装配', () => {
  assert.throws(
    () => assemble({
      products: [products[0]],
      question: '这节在说什么？',
      binding: { bindingKind: 'section', secId: 'sec_2_introduction' },
    }),
    err => err.code === 'l2_missing' && /节薄摘要/.test(err.message),
  );
});

test('片段提问：覆盖块并集 + 图表占位检测附图，不设数量帽', () => {
  const citeFig = {
    startSecId: 'sec_2_introduction',
    startBlock: 2,
    endSecId: 'sec_2_introduction',
    endBlock: 2,
    startPage: 2,
    endPage: 2,
  };
  const dataUrl = 'data:image/webp;base64,Zmln';
  const { messages, cropAssetIds } = assemble({
    question: '这张图什么意思？',
    binding: {
      bindingKind: 'fragment',
      fragmentText: 'Figure 1 shows the architecture.',
      cite: citeFig,
    },
    crops: { 'crop-fig_1': dataUrl },
  });
  const system = systemText(messages);
  assert.ok(system.includes('地图问题：小样例如何解决。'), '片段带 L1');
  assert.ok(system.includes('L2 (p2)：[图 fig_1]'));
  assert.ok(!system.includes('研究背景：小样例问题长期存在。'), '未覆盖块不送');
  assert.ok(!system.includes('方法第一步：读取输入。'));
  assert.ok(!system.includes('引言薄摘要独有句。'), '片段配方不带 L2');
  assert.deepEqual(cropAssetIds, ['crop-fig_1']);
  const user = lastUser(messages);
  assert.match(userText(user), /^\[引用："Figure 1 shows the architecture."\]\n这张图什么意思？$/);
  assert.deepEqual(imageUrls(user), [dataUrl], '覆盖图表占位即附裁切图');
  assert.ok(!cropAssetIds.some(id => id.startsWith('pageimg-')), '页图不进问答');
});

test('片段提问：跨节块并集，多图多表覆盖即附', () => {
  const { cropAssetIds, messages } = assemble({
    question: '图和表分别说明什么？',
    binding: {
      bindingKind: 'fragment',
      fragmentText: '选区从图占位跨到方法表',
      cite: {
        startSecId: 'sec_2_introduction',
        startBlock: 2,
        endSecId: 'sec_3_method',
        endBlock: 2,
      },
    },
    crops: {
      'crop-fig_1': 'data:image/webp;base64,Zmln',
      'crop-tbl_1': 'data:image/webp;base64,dGJs',
    },
  });
  const system = systemText(messages);
  assert.ok(system.includes('[图 fig_1]'));
  assert.ok(system.includes('本文贡献有三点。'));
  assert.ok(system.includes('方法第一步：读取输入。'));
  assert.ok(system.includes('| 准确率 | 0.9 |'));
  assert.ok(!system.includes('研究背景：小样例问题长期存在。'));
  assert.deepEqual(cropAssetIds, ['crop-fig_1', 'crop-tbl_1']);
  assert.equal(imageUrls(lastUser(messages)).length, 2);
});

test('片段提问：未覆盖图表占位则不附图', () => {
  const { cropAssetIds, messages } = assemble({
    question: '这句话什么意思？',
    binding: {
      bindingKind: 'fragment',
      fragmentText: '研究背景：小样例问题长期存在。',
      cite: {
        startSecId: 'sec_2_introduction',
        startBlock: 1,
        endSecId: 'sec_2_introduction',
        endBlock: 1,
      },
    },
  });
  assert.deepEqual(cropAssetIds, []);
  assert.equal(typeof lastUser(messages).content, 'string');
});

test('历史窗口取最近 12 条；更早的消息不进入装配', () => {
  const history = Array.from({ length: 13 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `消息${index + 1}`,
    bindingKind: 'none',
  }));
  const { messages } = assemble({ history, question: '当前问' });
  const replayed = messages.filter(message => message.role !== 'system').slice(0, -1);
  assert.equal(replayed.length, 12);
  assert.deepEqual(replayed.map(message => message.content), history.slice(-12).map(message => message.content));
  assert.ok(!replayed.some(message => message.content === '消息1'), '第 13 条之前的消息被丢掉');
});

test('历史绑定重放为标注文本，不重放节原文/块/裁切图', () => {
  const history = [
    {
      role: 'user',
      content: '引言在讲什么？',
      bindingKind: 'section',
      secId: 'sec_2_introduction',
    },
    { role: 'assistant', content: '在讲研究背景。', bindingKind: 'none' },
    {
      role: 'user',
      content: '这张图呢？',
      bindingKind: 'fragment',
      fragmentText: 'Figure 1 shows the architecture.',
      cite: {
        startSecId: 'sec_2_introduction',
        startBlock: 2,
        endSecId: 'sec_2_introduction',
        endBlock: 2,
      },
      assetIds: ['crop-fig_1'],
    },
    { role: 'assistant', content: '是架构图。', bindingKind: 'none' },
  ];
  const { messages, cropAssetIds } = assemble({
    history,
    question: '方法第一步做什么？',
    binding: { bindingKind: 'section', secId: 'sec_3_method' },
  });
  const replayed = messages.filter(message => message.role !== 'system').slice(0, -1);
  assert.equal(replayed[0].content, '[@Introduction]\n引言在讲什么？');
  assert.equal(replayed[1].content, '在讲研究背景。');
  assert.equal(replayed[2].content, '[引用："Figure 1 shows the architecture."]\n这张图呢？');
  assert.equal(typeof replayed[2].content, 'string', '历史片段不重放为多模态');
  assert.equal(replayed[3].content, '是架构图。');

  const system = systemText(messages);
  assert.ok(system.includes('方法第一步：读取输入。'), '当轮 @节注入方法原文');
  assert.ok(system.includes('方法薄摘要独有句。'));
  assert.ok(!system.includes('研究背景：小样例问题长期存在。'), '旧轮引言原文不随历史重放');
  assert.ok(!system.includes('引言薄摘要独有句。'));
  assert.deepEqual(cropAssetIds, [], '旧轮裁切图不随历史重放');
});

test('装配超硬顶时报 input_too_large，不截断输出', () => {
  try {
    assemble({ hardTop: 8, question: '过长吗？' });
    assert.fail('应当拒绝超硬顶装配');
  } catch (err) {
    assert.equal(err.code, 'input_too_large');
    assert.match(err.message, /论文过长/);
    assert.match(err.message, /不截断/);
    assert.ok(err.details?.estimatedTokens > 8);
    assert.equal(err.details?.hardTop, 8);
  }
});

test('图像 token 按页图预算计入硬顶（裁切图保守高估）', () => {
  const citeFig = {
    startSecId: 'sec_2_introduction',
    startBlock: 2,
    endSecId: 'sec_2_introduction',
    endBlock: 2,
  };
  const ok = assemble({
    question: '图',
    binding: { bindingKind: 'fragment', fragmentText: 'fig', cite: citeFig },
    crops: { 'crop-fig_1': 'data:image/webp;base64,Zmln' },
  });
  assert.ok(ok.estimatedTokens >= PAGE_IMAGE_TOKEN_BUDGET);
  assert.throws(
    () => assemble({
      question: '图',
      binding: { bindingKind: 'fragment', fragmentText: 'fig', cite: citeFig },
      crops: { 'crop-fig_1': 'data:image/webp;base64,Zmln' },
      hardTop: PAGE_IMAGE_TOKEN_BUDGET,
    }),
    err => err.code === 'input_too_large',
  );
});

test('页图附件 ID 零填充；预渲染齐备按页数与图表清单逐件检查', () => {
  assert.equal(pageAttachmentId(1), 'pageimg-0001');
  assert.equal(pageAttachmentId(12), 'pageimg-0012');
  const complete = [
    'pageimg-0001', 'pageimg-0002', 'pageimg-0003',
    'crop-fig_1', 'crop-tbl_1', 'crop-fml-extra',
  ];
  assert.equal(prerenderAssetsReady(mapped, complete), true);
  assert.equal(prerenderAssetsReady(mapped, complete.filter(id => id !== 'pageimg-0003')), false);
  assert.equal(prerenderAssetsReady(mapped, complete.filter(id => id !== 'crop-fig_1')), false);
  assert.equal(prerenderAssetsReady(null, complete), false);
});
