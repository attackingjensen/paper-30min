// 协议纯函数缝测试（#65 缝一）：配方拼装、分片合并、出处校验、工具调用块解析、
// 产物 schema 校验。与 Rust protocol.rs 共享规则与常量，锚定同一份块模型磁盘夹具
// （src-tauri/tests/fixtures/protocol/blockmodel-basic.json）与同一格式字符串
// （Rust 契约测试 protocol_contract.rs 断言的 "L1 (p1)：" / "## sec_2_introduction …"）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { initSkills, loadSkills } from '../ui/js/skills.js';
import {
  MAX_TOOL_STEPS, MAX_PARSE_FAILURES, INPUT_TOKEN_HARD_TOP,
  estimateTextTokens, l2Sections, contentSections, partIdForSection, sectionForPart,
  renderSectionText, renderPaperText, renderAssetList,
  assembleMapL2, validateL2Output, mergeL2ShardOutputs, assembleMapL1,
  assembleDeepDive, renderDigBlob, assembleSynthesize,
  parseToolCallBlock, parseRefs, validateRefs, validateProduct,
} from '../ui/js/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.join(here, '..', '..', 'skills');
const fixture = JSON.parse(
  readFileSync(path.join(here, '..', 'src-tauri', 'tests', 'fixtures', 'protocol', 'blockmodel-basic.json'), 'utf-8'),
);

function loadSkillFiles() {
  const top = readdirSync(skillsDir)
    .filter(f => f.toLowerCase().endsWith('.md') || f.toLowerCase().endsWith('.json'))
    .map(file => ({ file, text: readFileSync(path.join(skillsDir, file), 'utf-8') }));
  const legacy = readdirSync(path.join(skillsDir, 'legacy'))
    .filter(f => f.toLowerCase().endsWith('.md'))
    .map(file => ({ file: `legacy/${file}`, text: readFileSync(path.join(skillsDir, 'legacy', file), 'utf-8') }));
  return [...top, ...legacy].sort((a, b) => a.file.localeCompare(b.file));
}

// 技能来源注入一次（composePrompt 依赖 skills.js 的模块状态）。
await initSkills({ listSkillFiles: async () => loadSkillFiles() });
await loadSkills();

test('协议常量与 Rust 侧锚定', () => {
  assert.equal(MAX_TOOL_STEPS, 12);
  assert.equal(MAX_PARSE_FAILURES, 2);
  assert.equal(INPUT_TOKEN_HARD_TOP, 983_616);
});

test('estimateTextTokens 与 Rust estimate_text_tokens 同式', () => {
  assert.equal(estimateTextTokens('深度解读'), 4);
  assert.equal(estimateTextTokens('abcdefgh'), 2);
  assert.equal(estimateTextTokens('深a度b'), 3);
  assert.equal(estimateTextTokens(''), 0);
});

test('节与精读部分的顺序对应约定', () => {
  assert.deepEqual(l2Sections(fixture).map(s => s.id), ['sec_1_abstract', 'sec_2_introduction', 'sec_3_method']);
  assert.deepEqual(contentSections(fixture).map(s => s.id), ['sec_2_introduction', 'sec_3_method']);
  assert.equal(partIdForSection(fixture, 'sec_1_abstract'), 'abstract');
  assert.equal(partIdForSection(fixture, 'sec_2_introduction'), 'part-1');
  assert.equal(partIdForSection(fixture, 'sec_3_method'), 'part-2');
  assert.equal(partIdForSection(fixture, 'sec_4_references'), null);
  assert.equal(sectionForPart(fixture, 'abstract').id, 'sec_1_abstract');
  assert.equal(sectionForPart(fixture, 'part-2').id, 'sec_3_method');
  assert.equal(sectionForPart(fixture, 'part-3'), null);
  assert.equal(sectionForPart(fixture, 'part-0'), null);
});

test('文本层渲染格式与 Rust 契约断言锚定', () => {
  const intro = fixture.sections[1];
  const text = renderSectionText(intro);
  assert.ok(text.startsWith('L1 (p1)：研究背景：小样例问题长期存在。'));
  assert.ok(text.includes('L2 (p2)：[图 fig_1]'));
  const paperText = renderPaperText([intro]);
  assert.ok(paperText.startsWith('## sec_2_introduction Introduction (p1-2)'));
});

test('建图调用①装配：默认每节一片', () => {
  const { sharded, shards } = assembleMapL2({ title: 'Fixture 论文：小样例方法', mapped: fixture });
  assert.equal(sharded, true);
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.map(shard => shard.secIds), [['sec_1_abstract'], ['sec_2_introduction'], ['sec_3_method']]);
  assert.ok(shards[0].prompt.includes('Fixture 论文：小样例方法'));
  assert.ok(shards[1].prompt.includes('## sec_2_introduction Introduction (p1-2)'));
  assert.ok(shards.every(shard => shard.prompt.includes('摘要（abstract）：') || shard.prompt.includes('abstract（摘要）')), '每片叠加全表关注点');
  assert.ok(shards.every(shard => shard.estimatedTokens > 0));
  assert.ok(!shards[0].prompt.includes('## sec_2_introduction'), '单片不含其他节文本层');
});

test('L2 输出校验：覆盖、清理与确定性重排', () => {
  const shard = contentSections(fixture);
  const output = {
    sections: [
      { secId: 'sec_3_method', type: '方法', gist: '方法主旨', points: [{ text: '要点', refs: ['(p2)'] }], keyAssets: ['tbl_1', 'tbl_9'] },
      { secId: 'sec_2_introduction', type: 'introduction', gist: '引言主旨', points: [{ text: '要点', refs: [] }], keyAssets: ['fig_1'] },
    ],
  };
  const { entries, warnings } = validateL2Output(output, shard, fixture);
  assert.deepEqual(entries.map(e => e.secId), ['sec_2_introduction', 'sec_3_method'], '按分片节序重排');
  assert.equal(entries[1].type, 'part', '未知类型回退 part');
  assert.deepEqual(entries[1].keyAssets, ['tbl_1'], 'keyAssets 过滤清单外 id');
  assert.equal(entries[0].title, 'Introduction', 'title 以块模型为准');
  assert.deepEqual(entries[0].pages, { start: 1, end: 2 });
  assert.ok(warnings.some(w => w.startsWith('l2_type_fallback')));
  assert.ok(warnings.some(w => w.startsWith('l2_key_asset_unknown')));
  // 覆盖缺口 / 分片外的节 → 抛错（错误即指令）。
  assert.throws(() => validateL2Output({ sections: [output.sections[0]] }, shard, fixture), /覆盖不完整/);
  assert.throws(
    () => validateL2Output({ sections: [...output.sections, { secId: 'sec_1_abstract', gist: 'x', points: [{ text: 'y' }] }] }, shard, fixture),
    /不在本分片节集内/,
  );
  // 软约束（决策 16）：要点条数超 3–6、gist 超 2 句记 warning 不拒绝。
  const soft = validateL2Output({
    sections: [
      { secId: 'sec_2_introduction', type: 'introduction', gist: '一。二。三。', points: [{ text: 'p', refs: [] }] },
      { secId: 'sec_3_method', type: 'method', gist: 'g', points: Array.from({ length: 7 }, (_, i) => ({ text: `p${i}`, refs: [] })) },
    ],
  }, shard, fixture);
  assert.ok(soft.warnings.some(w => w.startsWith('l2_gist_long:sec_2_introduction')));
  assert.ok(soft.warnings.some(w => w.startsWith('l2_points_count:sec_3_method:7')));
});

test('分片合并是确定性拼装', () => {
  const groups = [[fixture.sections[0]], [fixture.sections[1], fixture.sections[2]]];
  const outputs = [
    { sections: [{ secId: 'sec_1_abstract', type: 'abstract', gist: 'g1', points: [{ text: 'p', refs: [] }] }] },
    { sections: [
      { secId: 'sec_3_method', type: 'method', gist: 'g3', points: [{ text: 'p', refs: [] }] },
      { secId: 'sec_2_introduction', type: 'introduction', gist: 'g2', points: [{ text: 'p', refs: [] }] },
    ] },
  ];
  const { entries } = mergeL2ShardOutputs(outputs, groups, fixture);
  assert.deepEqual(entries.map(e => e.secId), ['sec_1_abstract', 'sec_2_introduction', 'sec_3_method']);
});

test('建图调用②装配：L2 + 图表清单 + 摘要', () => {
  const prompt = assembleMapL1({
    title: 'T', abstract: '摘要文本', l2Entries: [{ secId: 'sec_2_introduction', gist: 'g' }],
    figures: fixture.figures, tables: fixture.tables,
  });
  assert.ok(prompt.includes('摘要文本'));
  assert.ok(prompt.includes('"secId": "sec_2_introduction"'));
  assert.ok(prompt.includes('fig_1（p2，属于 sec_2_introduction）：图 1：样例架构图。（正文引用 1 处）'));
  assert.ok(prompt.includes('tbl_1'));
});

test('深挖配方打底：常驻上下文 + 页图 ±1 页', () => {
  const section = fixture.sections[1];
  const { prompt, imagePages } = assembleDeepDive({
    title: 'T', mapBody: { problem: { text: 'p', refs: [] } },
    l2Bodies: [{ secId: 'sec_2_introduction' }], section, sectionType: 'introduction', pageCount: 3,
  });
  assert.ok(prompt.includes('L2 (p2)：[图 fig_1]'), '当前节原文全送');
  assert.ok(prompt.includes('"problem"'), 'L1 常驻');
  assert.ok(prompt.includes('本节类型关注点（引言）'), '叠加本节类型关注点');
  assert.deepEqual(imagePages, [1, 2, 3], '当前节页图 ±1 页');
  // 页边界收敛：末节 p3-3 → p2..p3。
  const tail = assembleDeepDive({
    title: 'T', mapBody: {}, l2Bodies: [], section: fixture.sections[3], sectionType: 'part', pageCount: 3,
  });
  assert.deepEqual(tail.imagePages, [2, 3]);
});

test('综合装配：深挖材料按节阅读顺序排列', () => {
  const parts = [
    { id: 'part-1', title: 'Introduction' },
    { id: 'part-2', title: 'Method' },
  ];
  const blob = renderDigBlob({
    digs: [
      { partId: 'part-2', body: '方法深挖' },
      { partId: 'part-1', body: '引言深挖' },
    ],
    mapped: fixture,
    parts,
  });
  assert.ok(blob.indexOf('引言深挖') < blob.indexOf('方法深挖'), '按节阅读顺序而非提交顺序');
  assert.ok(blob.includes('### part-1（Introduction）'));
  assert.equal(renderDigBlob({ digs: [], mapped: fixture, parts }), '（尚无深挖结果）');
  const prompt = assembleSynthesize({ title: 'T', mapBody: { problem: {} }, l2Bodies: [], digsBlob: blob });
  assert.ok(prompt.includes('引言深挖'));
});

test('工具调用块解析与 Rust parse_round_output 同规则', () => {
  // 合法调用
  assert.deepEqual(
    parseToolCallBlock('先取证。\n```tool\n{"name": "read_section", "args": {"sec_id": "sec_3_method", "offset": 1}}\n```'),
    { type: 'call', name: 'read_section', args: { sec_id: 'sec_3_method', offset: 1 } },
  );
  // 无围栏 → final
  assert.deepEqual(parseToolCallBlock('## 核心论点\n……'), { type: 'final', text: '## 核心论点\n……' });
  // 各类解析失败
  assert.equal(parseToolCallBlock('```tool\n{"name": "get_figure"').type, 'error');
  assert.match(parseToolCallBlock('```tool\n{bad}\n```').message, /JSON 解析失败/);
  assert.match(parseToolCallBlock('```tool\n{"name": "hack", "args": {}}\n```').message, /未知工具/);
  assert.match(parseToolCallBlock('```tool\n{"name": "get_figure", "args": {}}\n```').message, /fig_id/);
  assert.match(parseToolCallBlock('```tool\n{"name": "search_paper", "args": "x"}\n```').message, /args 必须是对象/);
  assert.match(parseToolCallBlock('```tool\n{"name": "read_section", "args": {"sec_id": "s", "offset": 0}}\n```').message, /offset/);
});

test('出处指针解析：四种统一语法', () => {
  const refs = parseRefs('问题 (p5) 与图 (fig_3) 表 (tbl_2)，本节块 (L12-18) 与跨节 (sec_2:L30-34)。');
  assert.deepEqual(refs.map(r => r.kind), ['page', 'figure', 'table', 'blocks', 'blocks']);
  assert.equal(refs[0].page, 5);
  assert.equal(refs[1].assetId, 'fig_3');
  assert.deepEqual([refs[3].start, refs[3].end], [12, 18]);
  assert.deepEqual([refs[4].secId, refs[4].start, refs[4].end], ['sec_2', 30, 34]);
});

test('出处校验：页/图表/块区间与短形节 id 解析', () => {
  const space = {
    pageCount: 3,
    assetIds: new Set(['fig_1', 'tbl_1']),
    sections: new Map([['sec_2_introduction', 3], ['sec_3_method', 3]]),
    currentSecId: 'sec_3_method',
  };
  const good = validateRefs('有效 (p2) (fig_1) (L1-2) (sec_2:L1-3)', space);
  assert.equal(good.invalid.length, 0);
  assert.equal(good.refs[2].secId, 'sec_3_method', '本节块引用落在当前节');
  assert.equal(good.refs[3].secId, 'sec_2_introduction', '短形 sec_2 前缀唯一解析为全形 id');
  const bad = validateRefs('无效 (p9) (fig_9) (L4-5) (sec_9:L1-2) (L3-1)', space);
  assert.equal(bad.invalid.length, 5, '页越界/清单外图表/块越界/未知节/区间倒置全部检出');
});

test('产物 schema 校验：四种 kind 与中断标记', () => {
  assert.ok(validateProduct('dig', '## 核心论点\n……').ok);
  assert.ok(!validateProduct('dig', '').ok);
  assert.ok(!validateProduct('dig', { text: 'x' }).ok);
  const l2 = {
    secId: 'sec_2_introduction', gist: 'g', type: 'introduction',
    points: [{ text: 'p', refs: ['(p1)'] }], keyAssets: ['fig_1'], pages: { start: 1, end: 2 },
  };
  assert.ok(validateProduct('l2', l2).ok);
  assert.ok(validateProduct('l2', { ...l2, partial: true }).ok, '中断部分结果标记合法');
  assert.ok(!validateProduct('l2', { ...l2, type: 'unknown' }).ok);
  assert.ok(!validateProduct('l2', { ...l2, points: [] }).ok);
  assert.ok(!validateProduct('l2', { ...l2, pages: { start: 3, end: 2 } }).ok);
  const map = {
    problem: { text: 'p', refs: ['(p1)'] }, method: { text: 'm', refs: [] },
    contributions: [], keyEvidence: [{ assetId: 'fig_1', note: '', refs: [] }],
    glossary: [], structure: [{ secId: 'sec_2_introduction' }],
  };
  assert.ok(validateProduct('map', map).ok);
  assert.ok(!validateProduct('map', { ...map, problem: { refs: [] } }).ok);
  assert.ok(!validateProduct('map', { ...map, structure: [{ secId: '' }] }).ok);
  assert.ok(!validateProduct('retell', null).ok);
  assert.ok(!validateProduct('unknown-kind', {}).ok);
});
