// 提问 UI 行为契约（#68 / 规格 #52 决策 9–13）：
// 缝 = qa.js 导出的绑定/补全/选区/气泡纯函数。断言 @ 补全覆盖全地址空间、
// 单绑定互斥、选区扩成完整块、气泡 chip/引用块呈现与出处标签、建图门禁；
// 不测 DOM 事件绑定（走真实窗口走查）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  QA_GATE_MESSAGE,
  applyMention,
  composerMessage,
  emptyBinding,
  expandSelectionToCite,
  fragmentBinding,
  fragmentCiteLabel,
  hasMapProduct,
  mentionCandidates,
  parseMentionTrigger,
  sectionBinding,
  userBindingView,
} from '../ui/js/qa.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mapped = JSON.parse(
  readFileSync(path.join(here, '..', 'src-tauri', 'tests', 'fixtures', 'protocol', 'blockmodel-basic.json'), 'utf-8'),
);

const mappedWithAck = {
  ...mapped,
  sections: [
    ...mapped.sections,
    {
      id: 'sec_5_acknowledgments',
      ordinal: 5,
      title: 'Acknowledgments',
      role: 'acknowledgments',
      pageStart: 3,
      pageEnd: 3,
      blocks: [{ id: 1, kind: 'paragraph', text: '感谢审稿人。', page: 3, y: 700 }],
    },
  ],
};

test('建图门禁：有阅读地图才就绪，文案提示先建图', () => {
  assert.equal(hasMapProduct([]), false);
  assert.equal(hasMapProduct([{ kind: 'l2', partId: 'abstract', body: { gist: 'x' } }]), false);
  assert.equal(hasMapProduct([{ kind: 'map', partId: '', body: { problem: { text: 'P' } } }]), true);
  assert.match(QA_GATE_MESSAGE, /未建图/);
  assert.match(QA_GATE_MESSAGE, /先.*建图/);
});

test('@ 补全覆盖全地址空间，含 References 与 Acknowledgments', () => {
  const all = mentionCandidates(mappedWithAck, '');
  assert.deepEqual(all.map(section => section.id), [
    'sec_1_abstract',
    'sec_2_introduction',
    'sec_3_method',
    'sec_4_references',
    'sec_5_acknowledgments',
  ]);
  const refs = mentionCandidates(mappedWithAck, 'ref');
  assert.deepEqual(refs.map(section => section.id), ['sec_4_references']);
  const ack = mentionCandidates(mappedWithAck, 'Ack');
  assert.deepEqual(ack.map(section => section.id), ['sec_5_acknowledgments']);
  const byId = mentionCandidates(mappedWithAck, 'sec_3');
  assert.deepEqual(byId.map(section => section.id), ['sec_3_method']);
});

test('解析 @ 触发：起始或空白后生效，查询可含空格，紧贴单词不触发', () => {
  assert.deepEqual(parseMentionTrigger('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(parseMentionTrigger('@Intro', 6), { start: 0, end: 6, query: 'Intro' });
  assert.deepEqual(parseMentionTrigger('问 @Related Work', 15), { start: 2, end: 15, query: 'Related Work' });
  assert.equal(parseMentionTrigger('hello@Intro', 11), null);
  assert.equal(parseMentionTrigger('没有触发', 4), null);
  assert.equal(parseMentionTrigger('@foo\nbar', 8), null);
});

test('选中 @ 补全写入节绑定，并清掉输入框里的 @查询', () => {
  const intro = mapped.sections[1];
  const applied = applyMention('请解释 @Intro', 10, intro);
  assert.equal(applied.text, '请解释 ');
  assert.equal(applied.cursor, 4);
  assert.equal(applied.binding.bindingKind, 'section');
  assert.equal(applied.binding.secId, 'sec_2_introduction');
  assert.equal(applied.binding.fragmentText, null);
});

test('每条消息至多一个绑定：后写入的节或片段替换前者', () => {
  const intro = mapped.sections[1];
  const method = mapped.sections[2];
  const section = sectionBinding(intro);
  const replaced = sectionBinding(method);
  assert.equal(replaced.bindingKind, 'section');
  assert.equal(replaced.secId, 'sec_3_method');
  assert.notEqual(replaced.secId, section.secId);

  const fragment = fragmentBinding(mapped, [{ secId: 'sec_2_introduction', blockId: 2 }]);
  assert.equal(fragment.bindingKind, 'fragment');
  assert.equal(fragment.secId, null);
  assert.equal(fragment.cite.startSecId, 'sec_2_introduction');
  assert.equal(fragment.cite.startBlock, 2);
  assert.equal(fragment.cite.endBlock, 2);
  assert.ok(fragment.fragmentText.includes('图 fig_1'));
  assert.deepEqual(fragment.assetIds, ['crop-fig_1']);

  assert.equal(emptyBinding().bindingKind, 'none');
});

test('选区扩成完整文本块：同节区间、逆序与跨节并集', () => {
  const same = expandSelectionToCite(mapped, [
    { secId: 'sec_3_method', blockId: 3 },
    { secId: 'sec_3_method', blockId: 1 },
  ]);
  assert.deepEqual(same, {
    startSecId: 'sec_3_method',
    startBlock: 1,
    endSecId: 'sec_3_method',
    endBlock: 3,
    startPage: 2,
    endPage: 3,
  });

  const cross = expandSelectionToCite(mapped, [
    { secId: 'sec_2_introduction', blockId: 3 },
    { secId: 'sec_3_method', blockId: 1 },
  ]);
  assert.equal(cross.startSecId, 'sec_2_introduction');
  assert.equal(cross.startBlock, 3);
  assert.equal(cross.endSecId, 'sec_3_method');
  assert.equal(cross.endBlock, 1);

  assert.throws(
    () => expandSelectionToCite(mapped, []),
    err => err.code === 'invalid_binding',
  );
});

test('气泡呈现：@节为 chip，片段为折叠引用块首行 + 出处', () => {
  const chip = userBindingView({
    bindingKind: 'section',
    secId: 'sec_2_introduction',
  }, mapped);
  assert.equal(chip.kind, 'chip');
  assert.equal(chip.label, '@Introduction');
  assert.equal(chip.cite, '(sec_2_introduction · p1–p2)');
  assert.deepEqual(chip.locate, { type: 'section', secId: 'sec_2_introduction' });

  const quote = userBindingView({
    bindingKind: 'fragment',
    fragmentText: '本文贡献有三点。\n下一句不会出现在首行。',
    cite: {
      startSecId: 'sec_2_introduction',
      startBlock: 3,
      endSecId: 'sec_2_introduction',
      endBlock: 3,
    },
  }, mapped);
  assert.equal(quote.kind, 'quote');
  assert.equal(quote.firstLine, '本文贡献有三点。');
  assert.equal(quote.fullText, '本文贡献有三点。\n下一句不会出现在首行。');
  assert.equal(quote.cite, '(sec_2_introduction:L3)');
  assert.equal(quote.locate.type, 'fragment');
  assert.equal(userBindingView({ bindingKind: 'none' }, mapped), null);
});

test('片段出处标签：同节区间、单块、跨节', () => {
  assert.equal(
    fragmentCiteLabel({ startSecId: 'sec_2_introduction', startBlock: 12, endSecId: 'sec_2_introduction', endBlock: 18 }),
    '(sec_2_introduction:L12-18)',
  );
  assert.equal(
    fragmentCiteLabel({ startSecId: 'sec_2_introduction', startBlock: 2, endSecId: 'sec_2_introduction', endBlock: 2 }),
    '(sec_2_introduction:L2)',
  );
  assert.equal(
    fragmentCiteLabel({
      startSecId: 'sec_2_introduction',
      startBlock: 3,
      endSecId: 'sec_3_method',
      endBlock: 1,
    }),
    '(sec_2_introduction:L3–sec_3_method:L1)',
  );
});

test('发送快照：把当前绑定写入用户消息字段', () => {
  const section = composerMessage('这节在说什么？', sectionBinding(mapped.sections[2]), 1700000080000);
  assert.equal(section.role, 'user');
  assert.equal(section.content, '这节在说什么？');
  assert.equal(section.createdAt, 1700000080000);
  assert.equal(section.bindingKind, 'section');
  assert.equal(section.secId, 'sec_3_method');
  assert.equal(section.fragmentText, null);

  const fragment = composerMessage(
    '这张图什么意思？',
    fragmentBinding(mapped, [{ secId: 'sec_2_introduction', blockId: 2 }]),
    1700000085000,
  );
  assert.equal(fragment.bindingKind, 'fragment');
  assert.equal(fragment.secId, null);
  assert.ok(fragment.fragmentText.includes('图 fig_1'));
  assert.deepEqual(fragment.cite.startBlock, 2);
  assert.deepEqual(fragment.assetIds, ['crop-fig_1']);

  const none = composerMessage('全文怎么讲？', emptyBinding(), 1);
  assert.equal(none.bindingKind, 'none');
  assert.equal(none.secId, null);
  assert.equal(none.cite, null);
});
