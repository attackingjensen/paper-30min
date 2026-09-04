// 对仓库自有 JavaScript 做纯语法检查（node --check，不执行代码），
// 覆盖未被测试导入的入口文件；排除第三方目录 public/vendor/。
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skippedDirs = new Set(['.git', 'node_modules', join('public', 'vendor')]);

function collectJsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name) && !skippedDirs.has(rel)) {
        files.push(...collectJsFiles(path));
      }
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      files.push(rel);
    }
  }
  return files;
}

const failures = [];
const files = collectJsFiles(root).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push(`${file}\n${(result.stderr || result.stdout).trim()}`);
  }
}

if (failures.length > 0) {
  console.error(`JavaScript syntax check failed:\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`JavaScript syntax check passed (${files.length} files)`);
