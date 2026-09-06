// 从浏览器端原样复制的模块与 public/js 源文件的同步测试：
// generation.js 与 markdown.js 在正式客户端是逐字节副本，改动必须先改浏览器端再同步。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 逐字节比对 app/ui/js 与 public/js 的同名文件。 */
function assertIdenticalCopy(name) {
  const appFile = readFileSync(path.join(appRoot, 'ui', 'js', name));
  const publicFile = readFileSync(path.join(appRoot, '..', 'public', 'js', name));
  assert.ok(
    appFile.equals(publicFile),
    `app/ui/js/${name} 与 public/js/${name} 逐字节不一致，副本需同步`,
  );
}

test('app/ui/js/generation.js 与 public/js/generation.js 逐字节一致', () => {
  assertIdenticalCopy('generation.js');
});

test('app/ui/js/markdown.js 与 public/js/markdown.js 逐字节一致', () => {
  assertIdenticalCopy('markdown.js');
});
