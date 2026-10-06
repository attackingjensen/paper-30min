import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

assert.equal(process.platform, 'win32', 'Windows WebView2 required');
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const identifier = `com.paper30min.cloudparse-webview-${Date.now()}`;
const output = path.resolve(app, '../tmp', identifier);
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [] };
const server = http.createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const root = path.resolve(app, 'ui');
    const target = path.resolve(root, relative);
    assert.ok(target.startsWith(root + path.sep));
    const bytes = await readFile(target);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
async function listen(handle) {
  handle.listen(0, '127.0.0.1'); await once(handle, 'listening'); return handle.address().port;
}
const url = `http://127.0.0.1:${await listen(server)}`;
const probe = http.createServer();
const debugPort = await listen(probe);
await new Promise(resolve => probe.close(resolve));
const config = JSON.stringify({ identifier, build: { devUrl: url },
  app: { windows: [{ label: 'main', title: 'Paper30Min cloud parse integration', width: 1280, height: 900 }] },
});
let child, browser, page;
async function run(command, args, env = process.env) {
  const handle = spawn(command, args, { cwd: app, env, stdio: 'inherit', windowsHide: true });
  const [code] = await once(handle, 'exit'); assert.equal(code, 0);
}
async function native(command, args = {}) {
  const result = await page.evaluate(async ({ command, args }) => {
    try { return { ok: true, value: await window.__TAURI__.core.invoke(command, args) }; }
    catch (error) { return { ok: false, error }; }
  }, { command, args });
  if (!result.ok) throw Object.assign(new Error(result.error.message || String(result.error)), result.error);
  return result.value;
}
const bridge = (command, input = {}) => native('bridge_invoke', { command, input });
async function check(name, fn) { await fn(); report.checks.push(name); console.log(`PASS ${name}`); }
try {
  await run('cargo', ['rustc', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'pdf_webview_host', '--',
    '-C', 'link-arg=/MANIFEST:EMBED'], { ...process.env, TAURI_CONFIG: config });
  const executable = path.join(output, 'paper30min.exe');
  await copyFile(path.join(app, 'src-tauri/target/debug/examples/pdf_webview_host.exe'), executable);
  child = spawn(executable, [], { cwd: output, env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
  }, stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 45000;
  while (!browser && Date.now() < deadline) {
    assert.equal(child.exitCode, null);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(browser, 'native WebView2 host must start');
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.__TAURI__?.core);
  const library = await bridge('library.info@1');
  assert.equal(path.basename(library.dataRoot), identifier, 'must use isolated library');
  await bridge('settings.putUi@1', { settings: { welcomeSeeded: true } });
  await check('registered native cloud bridge returns redacted empty recovery list', async () => {
    assert.deepEqual((await bridge('cloudparse.status@1')).jobs, []);
    const info = await bridge('app.info@1');
    assert.ok(info.taskKinds.includes('cloudparse.parse@1'));
    await assert.rejects(native('bridge_start', { kind: 'cloudparse.parse@1', input: { paperId: 'missing', action: 'submit' } }));
  });
  await page.locator('#su-enter').click();
  await page.locator('#startup-view').waitFor({ state: 'hidden' });
  await page.locator('#btn-settings').click();
  await page.locator('#settings-tab-service').click();
  await page.locator('#open-parser-settings').click();
  await check('local components and cloud configuration use separate existing service entries', async () => {
    assert.equal(await page.locator('#settings-detail-title').textContent(), '本地解析组件');
    assert.equal(await page.locator('#set-cloud-token').isVisible(), false);
    assert.equal(await page.locator('#settings-detail-parser #set-parser-provider').count(), 0);
    assert.equal(await page.locator('#btn-component-install').isVisible(), true);
    await page.locator('#close-service-detail').click();
    await page.locator('#open-cloud-settings').click();
    assert.equal(await page.locator('#settings-detail-title').textContent(), '云端解析 · 百度 AI Studio');
    assert.equal(await page.locator('#btn-component-install').isVisible(), false);
    assert.equal(await page.locator('#settings-detail-cloud #set-parser-provider').count(), 0);
  });
  await check('new library has no implicit parser choice and token stays masked', async () => {
    assert.equal(await page.locator('[data-parser-provider][aria-pressed="true"]').count(), 0);
    assert.equal((await bridge('settings.get@1')).cloudparse.defaultProvider, null);
    assert.equal(await page.locator('#set-cloud-token').getAttribute('type'), 'password');
    assert.equal(await page.locator('#set-cloud-consent').isChecked(), false);
  });
  await check('parser settings save through native bridge and credential change clears consent', async () => {
    await page.locator('#close-service-detail').click();
    await page.locator('[data-parser-provider="local"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-parser-provider="local"]').disabled);
    assert.equal((await bridge('settings.get@1')).cloudparse.defaultProvider, 'local');
    await page.locator('#open-cloud-settings').click();
    assert.equal((await bridge('settings.get@1')).cloudparse.defaultProvider, 'local', 'arrow opens settings without selecting cloud');
    await page.locator('#close-service-detail').click();
    await page.locator('[data-parser-provider="baidu"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-parser-provider="baidu"]').disabled);
    assert.equal(await page.locator('[data-parser-provider="baidu"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-parser-provider="local"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#settings-detail-layer').isVisible(), false, 'selecting row does not open settings');
    assert.equal((await bridge('settings.get@1')).cloudparse.defaultProvider, 'baidu');
    await page.locator('#open-cloud-settings').click();
    await page.locator('#set-cloud-token').fill('fixture-cloud-token');
    await page.locator('#set-cloud-consent').check();
    await page.locator('#btn-save-cloud-settings').click();
    const settings = (await bridge('settings.get@1')).cloudparse;
    assert.equal(settings.defaultProvider, 'baidu');
    assert.equal(settings.uploadConfirmed, true);
    await page.locator('#open-cloud-settings').click();
    await page.locator('#set-cloud-token').fill('changed-fixture-token');
    assert.equal(await page.locator('#set-cloud-consent').isChecked(), false);
    await page.locator('#btn-save-cloud-settings').click();
    assert.equal((await bridge('settings.get@1')).cloudparse.uploadConfirmed, false);
    assert.ok(!JSON.stringify(await bridge('cloudparse.status@1')).includes('fixture'));
  });
  await page.locator('#open-cloud-settings').click();
  await check('parser controls fit desktop and narrow window without panel overflow', async () => {
    const session = await browser.contexts()[0].newCDPSession(page);
    for (const width of [1280, 430]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const bounds = await page.locator('#set-cloud-token').evaluate(node => {
        const r = node.getBoundingClientRect();
        const parent = node.closest('.modal') || node.parentElement;
        return { left: r.left, right: r.right, scrollWidth: parent.scrollWidth, clientWidth: parent.clientWidth };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= width, JSON.stringify(bounds));
      assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, JSON.stringify(bounds));
      await page.screenshot({ path: path.join(output, `cloudparse-${width}.png`) });
      await page.locator('#close-service-detail').click();
      const rows = await page.locator('.service-entry').evaluateAll(nodes => nodes.map(node => {
        const r = node.getBoundingClientRect();
        return { x: r.x, width: r.width, height: r.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
      }));
      assert.equal(rows.length, 3);
      assert.ok(rows.every(row => row.height === rows[0].height && row.x >= 0 && row.x + row.width <= width && row.scrollWidth <= row.clientWidth + 1), JSON.stringify(rows));
      await page.screenshot({ path: path.join(output, `parser-selection-${width}.png`) });
      await page.locator('#open-cloud-settings').click();
    }
    await session.detach();
  });
  await page.reload();
  await page.locator('#su-enter').click();
  await page.locator('#startup-view').waitFor({ state: 'hidden' });
  await check('selected parser stays highlighted after reload and reopening settings', async () => {
    await page.locator('#btn-settings').click();
    await page.locator('#settings-tab-service').click();
    await page.waitForFunction(() => document.querySelector('[data-parser-provider="baidu"]').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('[data-parser-provider="local"]').getAttribute('aria-pressed'), 'false');
    await page.locator('#modal-settings [data-close]').click();
  });
  await check('PDF, sample and arXiv ask before parsing and cancel leaves library empty', async () => {
    const triggers = [
      () => page.locator('#file-input').setInputFiles(path.join(app, 'ui/samples/sample_paper.pdf')),
      () => page.locator('#btn-sample').click(),
      async () => {
        await page.locator('#btn-arxiv').click();
        await page.locator('#arxiv-input').fill('1706.03762');
        await page.locator('#btn-arxiv-import').click();
      },
    ];
    for (const trigger of triggers) {
      await trigger();
      await page.locator('#modal-parser-choice').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#parser-choice-provider').inputValue(), 'baidu');
      await page.locator('#parser-choice-confirm').click();
      await page.waitForFunction(() => document.querySelector('#parser-choice-error').textContent.includes('确认上传'));
      await page.locator('#parser-choice-provider').selectOption('local');
      await page.locator('#parser-choice-cancel').click();
      assert.deepEqual((await bridge('library.listPapers@1')).papers, []);
    }
    await page.keyboard.press('Escape');
  });
  await check('accepted recovery survives reload with jobId and no credential in native status', async () => {
    await bridge('library.putPaper@1', { paper: { id: 'recovery-paper', title: 'Recovery fixture' } });
    const bytes = await readFile(path.join(app, 'ui/samples/sample_paper.pdf'));
    const saved = await bridge('files.putAttachment@1', { paperId: 'recovery-paper', attachment: {
      id: 'pdf', name: 'fixture.pdf', contentType: 'application/pdf', contentBase64: bytes.toString('base64'),
    } });
    const dir = path.join(library.dataRoot, 'operations/cloudparse/recovery-paper/cloud-fixture');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'run.json'), JSON.stringify({ schemaVersion: 1, paperId: 'recovery-paper',
      batchId: 'cloud-fixture', provider: 'baidu', model: 'PaddleOCR-VL-1.6',
      options: { useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false },
      pdfSha256: saved.attachment.sha256, state: 'interrupted', jobId: 'fixture-job', rawSha256: null,
      failureCode: 'cloud_network_error', updatedAt: new Date().toISOString(), resultReady: false,
    }));
    await page.reload();
    await page.locator('#su-enter').click();
    await page.locator('#startup-view').waitFor({ state: 'hidden' });
    await page.locator('#nav-tasks').click();
    await page.getByRole('button', { name: '恢复查询 / 取回', exact: true }).waitFor();
    const status = await bridge('cloudparse.status@1');
    assert.equal(status.jobs[0].jobId, 'fixture-job');
    assert.equal(status.jobs[0].resultReady, false);
    assert.ok(!JSON.stringify(status).includes('fixture-token'));
    // Consent is false: the real native preparation rejects before any network request.
    await page.getByRole('button', { name: '恢复查询 / 取回', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => node.textContent.includes('确认论文上传')));
    assert.deepEqual((await bridge('tasks.list@1')).tasks, []);
    await page.screenshot({ path: path.join(output, 'cloudparse-recovery.png') });
  });
  assert.deepEqual(report.errors, []);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack || String(error); process.exitCode = 1; console.error(error);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await run('cargo', ['build', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--lib']);
  console.log(`Report: ${output}`);
}
