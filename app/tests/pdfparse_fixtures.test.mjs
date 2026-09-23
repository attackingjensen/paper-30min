import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Issue #60：踩坑论文集回归夹具的清单良构校验（CI 可跑，无需侧车）。
// 全链断言（PDF → 侧车 → 映射 → 基线）在 app/src-tauri/tests/pdfparse_regression.rs，
// 由 PAPER30MIN_PDFPARSE_FIXTURES=1 驱动；本文件保证夹具包装本身不进 CI 就烂掉。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'app', 'src-tauri', 'tests', 'fixtures');
const regressionDir = path.join(fixturesDir, 'regression');

const manifest = JSON.parse(readFileSync(path.join(regressionDir, 'manifest.json'), 'utf-8'));

test('版本钉三方一致：manifest == requirements-sidecar.txt', () => {
  const requirements = readFileSync(
    path.join(repoRoot, 'tools', 'pdfparse-sidecar', 'requirements-sidecar.txt'),
    'utf-8',
  );
  const pin = requirements
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('docling=='));
  assert.ok(pin, 'requirements-sidecar.txt 应有 docling== 钉版行');
  assert.equal(manifest.doclingVersion, pin.slice('docling=='.length));
  assert.ok(manifest.perfFactor > 1.0, 'perfFactor 应大于 1');
});

test('踩坑论文集 10 篇夹具在场且与清单一一对应', () => {
  assert.equal(manifest.papers.length, 10);
  for (const paper of manifest.papers) {
    assert.match(paper.id, /^\d{4}\.\d{4,5}$/, `${paper.id} 应为 arXiv 编号`);
    assert.equal(paper.pdf, `corpus/${paper.id}.pdf`, 'PDF 文件名与 arXiv 编号一致');
    const pdfPath = path.join(regressionDir, paper.pdf);
    assert.ok(statSync(pdfPath).size > 10_000, `夹具 PDF 在场且非空: ${paper.pdf}`);
    assert.ok(paper.pages >= 1, 'pages 缺失');
    assert.ok(paper.baselineSeconds > 0, 'baselineSeconds 缺失（性能门禁基线）');
    assert.ok(paper.expect.sectionsContain.length >= 2, `${paper.id} 应至少断言两个节标题`);
    assert.ok(Array.isArray(paper.expect.appendixNumbers), 'appendixNumbers 缺失');
    assert.equal(typeof paper.expect.references.count, 'number', 'references.count 缺失');
  }
});

test('公式密集样例三类登记齐全（#34 验收标准继承）', () => {
  const ids = manifest.papers.map((p) => p.id);
  const samples = manifest.formulaSamples;
  // 文字公式与双栏布局为夹具集成员；矢量与图片公式为合成夹具。
  assert.ok(ids.includes(samples.text), '文字公式样例应在夹具集内');
  assert.ok(ids.includes(samples.twoColumn), '双栏布局样例应在夹具集内');
  assert.equal(samples.graphics, 'pdfparse_formula_graphics.pdf');
  assert.ok(statSync(path.join(fixturesDir, samples.graphics)).size > 0, '合成公式图形夹具在场');
});
