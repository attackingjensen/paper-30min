// 内置兜底技能副本与 skills/*.md 的同步测试：沿用根 tests/skills.test.mjs 的做法，
// 从 .md 文件提取正文，与 app/ui/js/skills.js 的 BUILTIN_SKILLS 比对。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { BUILTIN_SKILLS, fileSkillsFrom } from '../ui/js/skills.js';

const skillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

/** 读取 skills/ 目录，模拟 skills.list@1 返回的文件清单（按文件名排序）。 */
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
