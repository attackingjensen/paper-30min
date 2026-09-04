import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  BUILTIN_SKILLS, buildPrompt, skillFromFile, fileSkillsFrom, importCustomSkills,
} from '../public/js/skills.js';

const skillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/** 读取 skills/ 目录，模拟 /api/skills 返回的文件清单（按文件名排序）。 */
function loadSkillFiles() {
  return readdirSync(skillsDir)
    .filter(f => f.toLowerCase().endsWith('.md'))
    .sort()
    .map(file => ({ file, text: readFileSync(path.join(skillsDir, file), 'utf-8') }));
}

test('每个内置兜底技能都有内容完全一致的 skills/*.md 对应文件', () => {
  const fromFiles = fileSkillsFrom(loadSkillFiles());
  for (const builtin of BUILTIN_SKILLS) {
    const fromFile = fromFiles.find(s => s.id === builtin.id);
    assert.ok(fromFile, `skills/ 缺少 section 为 ${builtin.id} 的技能文件`);
    assert.deepEqual(
      { id: fromFile.id, name: fromFile.name, section: fromFile.section, description: fromFile.description, prompt: fromFile.prompt },
      { id: builtin.id, name: builtin.name, section: builtin.section, description: builtin.description, prompt: builtin.prompt },
      `内置技能 ${builtin.id} 与 skills/ 文件内容漂移，兜底副本需同步`,
    );
  }
});

test('skillFromFile 以 frontmatter 的 section 作为 id（统一小写）', () => {
  const skill = skillFromFile('demo.md', '---\nname: 演示\nsection: Method\n---\n正文');
  assert.equal(skill.id, 'method');
  assert.equal(skill.section, 'method');
  assert.equal(skill.name, '演示');
  assert.equal(skill.prompt, '正文');
});

test('fileSkillsFrom 按核心章节优先级排序，未知 section 按字典序排在后面', () => {
  const files = [
    { file: 'zeta.md', text: '---\nsection: zeta\n---\nZ' },
    { file: 'method-deep-dive.md', text: '---\nsection: method\n---\nM' },
    { file: 'alpha.md', text: '---\nsection: alpha\n---\nA' },
    { file: 'abstract-translation.md', text: '---\nsection: abstract\n---\nAB' },
  ];
  assert.deepEqual(fileSkillsFrom(files).map(s => s.id), ['abstract', 'method', 'alpha', 'zeta']);
});

test('fileSkillsFrom 忽略缺少 frontmatter section 的文件', () => {
  const files = [
    { file: 'no-section.md', text: '---\nname: 无章节\n---\n正文' },
    { file: 'ok.md', text: '---\nsection: method\n---\nM' },
  ];
  assert.deepEqual(fileSkillsFrom(files).map(s => s.id), ['method']);
});

test('fileSkillsFrom 对重复 section 保留先出现的文件', () => {
  const files = [
    { file: 'a-method.md', text: '---\nsection: method\n---\n第一个' },
    { file: 'b-method.md', text: '---\nsection: method\n---\n第二个' },
  ];
  const skills = fileSkillsFrom(files);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].prompt, '第一个');
});

test('buildPrompt substitutes placeholders for every builtin skill', () => {
  for (const skill of BUILTIN_SKILLS) {
    const prompt = buildPrompt(skill, 'Sample Title', 'Sample Content', '第 1 部分');

    assert.ok(prompt.includes('Sample Title'), skill.id);
    assert.ok(prompt.includes('Sample Content'), skill.id);
    assert.ok(!prompt.includes('{title}'), skill.id);
    assert.ok(!prompt.includes('{section}'), skill.id);
    assert.ok(!prompt.includes('{content}'), skill.id);
  }
});

test('buildPrompt injects title, section and content literally despite $ replacement patterns', () => {
  const skill = BUILTIN_SKILLS.find(s => s.id === 'part');
  const title = 'A $& paper on $` quoting';
  const section = "Part $' 1";
  const content = 'regex $& and $\' and $` and $$ in one line';

  const prompt = buildPrompt(skill, title, content, section);

  assert.ok(prompt.includes(title));
  assert.ok(prompt.includes(section));
  assert.ok(prompt.includes(content));
});

test('importCustomSkills overwrites same ids, adds new ones, ignores non-string values', () => {
  const backup = globalThis.localStorage;
  const backing = new Map();
  globalThis.localStorage = {
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => backing.set(key, String(value)),
  };
  try {
    backing.set('pr.skills.v1', JSON.stringify({ method: '旧提示词', abstract: '保留' }));

    const stats = importCustomSkills({ method: '新提示词', part: '新增', broken: 42 });

    assert.deepEqual(stats, { added: 1, overwritten: 1 });
    assert.deepEqual(JSON.parse(backing.get('pr.skills.v1')), {
      method: '新提示词',
      abstract: '保留',
      part: '新增',
    });
  } finally {
    globalThis.localStorage = backup;
  }
});
