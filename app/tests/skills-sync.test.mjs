// 技能库测试（#64 / 规格 #55 决策 23–25）：
// - 结构断言：四段协议提示词的必备段落（任务/工具/出处纪律/输出格式）与必备占位符在位；
// - 防漂移：BUILTIN_* 兜底副本与 skills/ 文件同步（沿用旧 skills-sync 先例）；
// - 叠加规则：协议提示词打底 + 该节类型关注点追加；
// - 迁移路径：v1 平铺覆盖 → v2（关注点覆盖项 + legacy 留档）的夹具测试。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  BUILTIN_PROTOCOL_PROMPTS, BUILTIN_SECTION_FOCUS, BUILTIN_SKILLS,
  PROTOCOL_STAGES, SECTION_TYPES, PROTOCOL_PLACEHOLDERS, PROTOCOL_REQUIRED_SECTIONS,
  protocolPromptsFrom, parseSectionFocusText, fileSkillsFrom,
  migrateSkillsOverrides, initSkills, loadSkills, loadCustomSkills,
  getProtocolPrompt, effectiveProtocolPrompts, getSectionFocus, effectiveSectionFocus,
  composePrompt, effectiveSkills, getSkill, saveCustomSkill, resetSkill,
  savePromptOverride, resetPromptOverride, saveFocusOverride, resetFocusOverride,
  importCustomSkills,
} from '../ui/js/skills.js';

const skillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const legacyDir = path.join(skillsDir, 'legacy');

/** 读取仓库 skills/ 目录，模拟 skills.list@1 返回的文件清单（含 legacy/ 前缀与 json，按文件名排序）。 */
function loadSkillFiles() {
  const top = readdirSync(skillsDir)
    .filter(f => f.toLowerCase().endsWith('.md') || f.toLowerCase().endsWith('.json'))
    .map(file => ({ file, text: readFileSync(path.join(skillsDir, file), 'utf-8') }));
  const legacy = readdirSync(legacyDir)
    .filter(f => f.toLowerCase().endsWith('.md'))
    .map(f => ({ file: `legacy/${f}`, text: readFileSync(path.join(legacyDir, f), 'utf-8') }));
  return [...top, ...legacy].sort((a, b) => a.file.localeCompare(b.file));
}

/** 干净的就绪状态：注入内存缝（空覆盖）并加载真实技能文件。 */
async function freshState({ stored = {}, files = loadSkillFiles() } = {}) {
  const writes = [];
  await initSkills({
    listSkillFiles: async () => files,
    loadOverrides: async () => stored,
    saveOverrides: async obj => { writes.push(obj); },
  });
  const source = await loadSkills();
  return { writes, source };
}

// ---------- 结构断言：四段协议提示词 ----------
const protocolFiles = Object.fromEntries(
  readdirSync(skillsDir)
    .filter(f => f.toLowerCase().endsWith('.md'))
    .map(f => [f, readFileSync(path.join(skillsDir, f), 'utf-8')]),
);

test('skills/ 顶层恰含四段协议提示词与关注点数据文件', () => {
  assert.deepEqual(Object.keys(protocolFiles).sort(), ['deep-dive.md', 'map-l1.md', 'map-l2.md', 'synthesize.md']);
  assert.ok(readdirSync(skillsDir).includes('section-focus.json'), 'skills/ 缺 section-focus.json');
});

test('四段协议提示词 frontmatter 齐备且 stage 与文件名一致', () => {
  const parsed = protocolPromptsFrom(
    Object.entries(protocolFiles).map(([file, text]) => ({ file, text })),
  );
  assert.deepEqual(parsed.map(p => p.id), PROTOCOL_STAGES);
  for (const prompt of parsed) {
    assert.equal(prompt.id, prompt.stage);
    assert.equal(`${prompt.stage}.md`.replace('.md', ''), prompt.id);
    assert.ok(prompt.name.trim(), `${prompt.id} 缺 name`);
    assert.ok(prompt.description.trim(), `${prompt.id} 缺 description`);
    assert.ok(prompt.prompt.length > 100, `${prompt.id} 正文过短`);
  }
});

test('四段协议提示词必备段落（任务/工具/出处纪律/输出格式）在位', () => {
  for (const stage of PROTOCOL_STAGES) {
    const prompt = protocolPromptsFrom([{ file: `${stage}.md`, text: protocolFiles[`${stage}.md`] }])[0];
    for (const section of PROTOCOL_REQUIRED_SECTIONS) {
      assert.ok(prompt.prompt.includes(section), `${stage} 缺必备段落「${section}」`);
    }
  }
});

test('四段协议提示词必备占位符在位（与装配契约 PROTOCOL_PLACEHOLDERS 一致）', () => {
  for (const stage of PROTOCOL_STAGES) {
    const prompt = protocolPromptsFrom([{ file: `${stage}.md`, text: protocolFiles[`${stage}.md`] }])[0];
    for (const key of PROTOCOL_PLACEHOLDERS[stage]) {
      assert.ok(prompt.prompt.includes(`{${key}}`), `${stage} 缺占位符 {${key}}`);
    }
  }
});

test('四段协议提示词出处纪律段携带统一出处语法', () => {
  for (const stage of PROTOCOL_STAGES) {
    const text = protocolFiles[`${stage}.md`];
    for (const syntax of ['(p5)', '(fig_3)', '(L12-18)', '(sec_2:L30-34)']) {
      assert.ok(text.includes(syntax), `${stage} 出处纪律段缺统一语法样例 ${syntax}`);
    }
    assert.ok(text.includes('EXTRACTED'), `${stage} 出处纪律段缺 EXTRACTED 纪律`);
  }
});

test('deep-dive 工具指导段覆盖四件工具与 tool 围栏协议', () => {
  const text = protocolFiles['deep-dive.md'];
  for (const tool of ['read_section', 'search_paper', 'get_figure', 'get_page_image']) {
    assert.ok(text.includes(tool), `deep-dive 工具指导段缺 ${tool}`);
  }
  assert.ok(text.includes('```tool'), 'deep-dive 缺工具调用块围栏示例');
});

test('章节关注点数据文件齐备：五个受控类型、每类 label 与非空关注点清单', () => {
  const focus = parseSectionFocusText(readFileSync(path.join(skillsDir, 'section-focus.json'), 'utf-8'));
  assert.ok(focus, 'section-focus.json 不可解析');
  assert.deepEqual(Object.keys(focus).sort(), [...SECTION_TYPES].sort());
  for (const type of SECTION_TYPES) {
    assert.ok(focus[type].label.trim(), `${type} 缺 label`);
    assert.ok(focus[type].focus.length > 0, `${type} 关注点清单为空`);
  }
});

// ---------- 防漂移：内置兜底副本与文件同步 ----------
test('内置兜底协议提示词与 skills/*.md 内容一致', () => {
  const fromFiles = protocolPromptsFrom(
    Object.entries(protocolFiles).map(([file, text]) => ({ file, text })),
  );
  for (const builtin of BUILTIN_PROTOCOL_PROMPTS) {
    const fromFile = fromFiles.find(p => p.id === builtin.id);
    assert.ok(fromFile, `skills/ 缺少 stage 为 ${builtin.id} 的协议提示词文件`);
    assert.deepEqual(
      { id: fromFile.id, name: fromFile.name, stage: fromFile.stage, description: fromFile.description, prompt: fromFile.prompt },
      { id: builtin.id, name: builtin.name, stage: builtin.stage, description: builtin.description, prompt: builtin.prompt },
      `内置协议提示词 ${builtin.id} 与 skills/ 文件内容漂移，兜底副本需同步`,
    );
  }
});

test('内置兜底关注点与 section-focus.json 内容一致', () => {
  const fromFile = parseSectionFocusText(readFileSync(path.join(skillsDir, 'section-focus.json'), 'utf-8'));
  assert.deepEqual(BUILTIN_SECTION_FOCUS, fromFile, '内置关注点与 section-focus.json 漂移，兜底副本需同步');
});

test('每个内置兜底旧技能都有内容完全一致的 skills/legacy/*.md 对应文件', () => {
  const fromFiles = fileSkillsFrom(
    readdirSync(legacyDir)
      .filter(f => f.toLowerCase().endsWith('.md'))
      .sort()
      .map(file => ({ file, text: readFileSync(path.join(legacyDir, file), 'utf-8') })),
  );
  for (const builtin of BUILTIN_SKILLS) {
    const fromFile = fromFiles.find(s => s.id === builtin.id);
    assert.ok(fromFile, `skills/legacy/ 缺少 section 为 ${builtin.id} 的技能文件`);
    assert.deepEqual(
      { id: fromFile.id, name: fromFile.name, section: fromFile.section, description: fromFile.description, prompt: fromFile.prompt },
      { id: builtin.id, name: builtin.name, section: builtin.section, description: builtin.description, prompt: builtin.prompt },
      `内置旧技能 ${builtin.id} 与 skills/legacy/ 文件内容漂移，兜底副本需同步`,
    );
  }
});

// ---------- 叠加规则 ----------
test('composePrompt(deep-dive)：协议提示词打底 + 该节类型关注点追加', async () => {
  await freshState();
  const composed = composePrompt('deep-dive', {
    sectionType: 'method',
    values: {
      title: 'T', map: 'M', l2Summaries: 'L2', sectionId: 'sec_3_method', sectionTitle: 'Method',
      sectionType: 'method', sectionText: 'TXT', sectionPages: '第 3–4 页',
    },
  });
  const base = getProtocolPrompt('deep-dive');
  assert.ok(composed.includes('《T》') && composed.includes('TXT'), '占位符未注入');
  assert.ok(!composed.includes('{sectionFocus}') && !composed.includes('{map}'), '占位符有残留');
  const focusBlock = `本节类型关注点（${BUILTIN_SECTION_FOCUS.method.label}）：`;
  assert.ok(composed.includes(focusBlock), '缺本节类型关注点块');
  for (const item of BUILTIN_SECTION_FOCUS.method.focus) {
    assert.ok(composed.includes(item), `关注点缺条目: ${item}`);
  }
  // 打底在前、关注点追加在后。
  assert.ok(composed.indexOf('深挖') < composed.indexOf(focusBlock), '关注点未追加到打底之后');
  assert.ok(base.includes('{sectionFocus}'), '文件版 deep-dive 应含 {sectionFocus} 占位符');
});

test('composePrompt(map-l2)：叠加全部类型关注点表并注入受控词表', async () => {
  await freshState();
  const composed = composePrompt('map-l2', { values: { title: 'T', paperText: 'FULLTEXT' } });
  assert.ok(composed.includes('FULLTEXT') && !composed.includes('{sectionTypes}'), '占位符未注入完整');
  assert.ok(composed.includes('["abstract", "introduction", "method", "experiments", "part"]'), '受控词表未注入');
  for (const type of SECTION_TYPES) {
    assert.ok(composed.includes(`${type}（${BUILTIN_SECTION_FOCUS[type].label}）：`), `关注点表缺 ${type}`);
  }
});

test('composePrompt(map-l1 / synthesize)：不叠加关注点', async () => {
  await freshState();
  const l1 = composePrompt('map-l1', { values: { title: 'T', abstract: 'A', l2Summaries: 'L', figureList: 'F', tableList: 'TB' } });
  const syn = composePrompt('synthesize', { values: { title: 'T', map: 'M', l2Summaries: 'L', digResults: 'D' } });
  assert.ok(!l1.includes('关注点'), 'map-l1 不应叠加关注点');
  assert.ok(!syn.includes('关注点'), 'synthesize 不应叠加关注点');
  assert.ok(l1.includes('TB') && syn.includes('D'), '占位符未注入');
});

test('覆盖版提示词丢掉 {sectionFocus} 时叠加规则仍生效（追加到末尾）', async () => {
  await freshState();
  await savePromptOverride('deep-dive', '自定义打底 {title} {map} {l2Summaries} {sectionId} {sectionTitle} {sectionType} {sectionText} {sectionPages}');
  const composed = composePrompt('deep-dive', {
    sectionType: 'experiments',
    values: { title: 'T', map: 'M', l2Summaries: 'L', sectionId: 's', sectionTitle: 'E', sectionType: 'experiments', sectionText: 'X', sectionPages: 'p' },
  });
  assert.ok(composed.startsWith('自定义打底'), '覆盖版打底未生效');
  assert.ok(composed.includes('## 章节关注点'), '覆盖版丢占位符时关注点未追加');
  assert.ok(composed.includes(BUILTIN_SECTION_FOCUS.experiments.focus[0]), '追加的关注点内容不符');
  await resetPromptOverride('deep-dive');
  assert.ok(getProtocolPrompt('deep-dive').includes('{sectionFocus}'), '重置后应回到文件版');
});

test('关注点覆盖整组替换默认清单，重置后回默认；未知类型回退 part', async () => {
  await freshState();
  await saveFocusOverride('method', ['只看这一个关注点']);
  assert.deepEqual(getSectionFocus('method'), ['只看这一个关注点']);
  assert.ok(effectiveSectionFocus().find(e => e.type === 'method').customized);
  await resetFocusOverride('method');
  assert.deepEqual(getSectionFocus('method'), BUILTIN_SECTION_FOCUS.method.focus);
  assert.deepEqual(getSectionFocus('未知类型'), getSectionFocus('part'));
});

// ---------- 迁移路径夹具 ----------
test('迁移夹具：v1 全五键覆盖迁为关注点覆盖项 + 只读留档', () => {
  const v1 = {
    abstract: '自定义摘要提示词',
    introduction: '自定义引言提示词',
    method: '自定义方法提示词',
    experiments: '自定义实验提示词',
    part: '自定义通用提示词',
  };
  const migrated = migrateSkillsOverrides(v1);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.prompts, {});
  for (const [key, text] of Object.entries(v1)) {
    assert.deepEqual(migrated.focus[key], [text], `${key} 未迁为关注点覆盖项`);
    assert.equal(migrated.legacy[key], text, `${key} 原文未留档`);
  }
});

test('迁移夹具：v1 部分键 + 未知键 + 非字符串值', () => {
  const migrated = migrateSkillsOverrides({ method: '自定义', weird: '不知所云', broken: 42, empty: '  ' });
  assert.deepEqual(migrated.focus, { method: ['自定义'] }, '已知类型才迁关注点');
  assert.deepEqual(migrated.legacy, { method: '自定义', weird: '不知所云' }, '未知键仅留档，非字符串与空白剔除');
});

test('迁移夹具：v2 规范化通过且幂等', () => {
  const v2 = {
    version: 2,
    prompts: { 'deep-dive': '自定义深挖', junk: 1 },
    focus: { method: ['甲', ''], part: '单条字符串', bad: [1, 2] },
    legacy: { method: '原文' },
  };
  const once = migrateSkillsOverrides(v2);
  assert.deepEqual(once.prompts, { 'deep-dive': '自定义深挖' }, 'prompts 只留字符串');
  assert.deepEqual(once.focus, { method: ['甲'], part: ['单条字符串'] }, 'focus 归一为非空字符串数组');
  assert.deepEqual(once.legacy, { method: '原文' });
  assert.deepEqual(migrateSkillsOverrides(once), once, '迁移须幂等');
});

test('迁移夹具：垃圾输入一律归为空 v2', () => {
  for (const junk of [null, undefined, 42, '文本', ['method'], true]) {
    assert.deepEqual(migrateSkillsOverrides(junk), { version: 2, prompts: {}, focus: {}, legacy: {} });
  }
});

test('迁移路径：initSkills 检出 v1 覆盖后迁移并写回 settings 缝', async () => {
  const { writes, source } = await freshState({ stored: { method: '旧自定义提示词', abstract: '保留' } });
  assert.equal(source, 'file');
  assert.equal(writes.length, 1, 'v1 → v2 迁移应写回一次');
  assert.equal(writes[0].version, 2);
  assert.deepEqual(writes[0].focus, { method: ['旧自定义提示词'], abstract: ['保留'] });
  assert.deepEqual(writes[0].legacy, { method: '旧自定义提示词', abstract: '保留' });
  // 旧精读路径沿用留档原文（用户调教在旧路径退役前不失效）。
  assert.equal(getSkill('method').prompt, '旧自定义提示词');
  assert.equal(getSkill('method').customized, true);
  assert.equal(getSkill('introduction').customized, false);
  // 新协议层同一调教以关注点形态生效。
  assert.deepEqual(getSectionFocus('method'), ['旧自定义提示词']);
});

test('迁移路径：已是 v2 时 initSkills 不写回', async () => {
  const stored = { version: 2, prompts: {}, focus: { part: ['x'] }, legacy: {} };
  const { writes } = await freshState({ stored });
  assert.equal(writes.length, 0, 'v2 规范化后无变化不应写回');
});

test('旧技能弹窗保存缝：原文进 legacy 留档并同步为关注点覆盖项，重置一并清除', async () => {
  await freshState();
  await saveCustomSkill('experiments', '改过的实验提示词');
  let stored = loadCustomSkills();
  assert.equal(stored.legacy.experiments, '改过的实验提示词');
  assert.deepEqual(stored.focus.experiments, ['改过的实验提示词']);
  await resetSkill('experiments');
  stored = loadCustomSkills();
  assert.ok(!('experiments' in stored.legacy) && !('experiments' in stored.focus));
});

test('整库导入：v1 导出形状先迁移再合并，v2 同键覆盖', async () => {
  await freshState({ stored: { version: 2, prompts: { synthesize: '既有' }, focus: { method: ['既有关注点'] }, legacy: { method: '既有原文' } } });
  // 旧浏览器整库导出（v1 平铺）。
  const statsV1 = await importCustomSkills({ introduction: '浏览器自定义', method: '浏览器方法' });
  let stored = loadCustomSkills();
  assert.equal(stored.legacy.introduction, '浏览器自定义');
  assert.deepEqual(stored.focus.method, ['浏览器方法'], '同键以导入值为准');
  assert.equal(statsV1.overwritten, 2, 'method 的 focus 与 legacy 各计一次覆盖');
  assert.equal(statsV1.added, 2, 'introduction 的 focus 与 legacy 各计一次新增');
  // v2 导出形状。
  const statsV2 = await importCustomSkills({ version: 2, prompts: { 'deep-dive': '新深挖' }, focus: {}, legacy: {} });
  stored = loadCustomSkills();
  assert.equal(stored.prompts['deep-dive'], '新深挖');
  assert.equal(stored.prompts.synthesize, '既有', '未携带的键不动');
  assert.deepEqual(statsV2, { added: 1, overwritten: 0 });
});

// ---------- 加载路由与兜底 ----------
test('loadSkills 按文件名路由三组来源并返回 file', async () => {
  const { source } = await freshState();
  assert.equal(source, 'file');
  for (const stage of PROTOCOL_STAGES) {
    assert.ok(getProtocolPrompt(stage).length > 100, `${stage} 未从文件加载`);
  }
  assert.equal(effectiveProtocolPrompts().length, 4);
  assert.ok(effectiveSkills().length === 5, '旧五技能应从 legacy/ 文件加载');
});

test('缺关注点数据文件时关注点回退内置兜底，协议提示词仍从文件生效', async () => {
  const filesNoFocus = loadSkillFiles()
    .filter(({ file }) => file !== 'section-focus.json')
    .map(entry => entry.file === 'deep-dive.md'
      ? { ...entry, text: entry.text.replace('你是一位资深研究员', '改过的占位开头') }
      : entry);
  const { source } = await freshState({ files: filesNoFocus });
  assert.equal(source, 'file');
  assert.ok(getProtocolPrompt('deep-dive').includes('改过的占位开头'), '协议提示词应从文件生效');
  assert.deepEqual(getSectionFocus('method'), BUILTIN_SECTION_FOCUS.method.focus, '关注点应回退内置');
  assert.ok(getSkill('method').prompt.length > 100, '旧技能仍从 legacy/ 文件加载');
});

test('文件来源整体失败时回退内置兜底', async () => {
  await initSkills({
    listSkillFiles: async () => { throw new Error('来源不可用'); },
    loadOverrides: async () => ({}),
    saveOverrides: async () => {},
  });
  const source = await loadSkills();
  assert.equal(source, 'builtin');
  for (const stage of PROTOCOL_STAGES) {
    assert.ok(getProtocolPrompt(stage).length > 100, `${stage} 应回退内置兜底`);
  }
  assert.ok(getSkill('part').prompt.length > 100, '旧技能应回退内置兜底');
});
