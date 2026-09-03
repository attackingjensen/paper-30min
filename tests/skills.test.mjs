import assert from 'node:assert/strict';
import test from 'node:test';

import { BUILTIN_SKILLS, buildPrompt } from '../public/js/skills.js';

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
