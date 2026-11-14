import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertWindowsHost, appDir as app, listen, createUiServer, claimDebugPort, tauriConfig,
  buildHost, launchWebView, stopWebView, closeServers, restoreLibraryBuild } from './webview-host.mjs';

assertWindowsHost();
const runId = `updater-webview-${Date.now()}`;
const identifier = `com.paper30min.${runId}`;
const output = path.resolve(app, '../../../tmp', runId);
await mkdir(output, { recursive: true });
const signed = JSON.parse(await readFile(path.join(app, 'src-tauri/tests/fixtures/updater/signed-bytes.json'), 'utf8'));
// Every complete native download fails signature verification; never launch fixture bytes as an installer.
const content = Buffer.from(signed.content);
content[0] ^= 1;
let mode = 'available';
let downloadClosed = false;
let checksRequested = 0;
const report = { runId, identifier, checks: [], confirmation: 'plugin message response substituted; native dialog display unverified',
  installer: 'not executed; signature-valid boundary covered by Rust tests' };
const errors = [];
const server = createUiServer((req, res) => {
  if (req.url === '/latest.json') {
    checksRequested++;
    if (mode === 'check-stall') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
      return true;
    }
    if (mode === 'none') { res.writeHead(204); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '9.9.9', notes: 'Local updater fixture',
      url: `${url}/fixture.bin`, signature: signed.signature }));
    return true;
  }
  if (req.url === '/fixture.bin') {
    const requestedMode = mode;
    downloadClosed = false;
    res.on('close', () => { downloadClosed = true; });
    if (requestedMode === 'header-stall') return true;
    res.writeHead(200, { 'Content-Length': content.length });
    if (requestedMode === 'body-stall') { res.write(content.subarray(0, 4)); return true; }
    res.end(content);
    return true;
  }
  return false;
});
const url = `http://127.0.0.1:${await listen(server)}`;
const debugPort = await claimDebugPort();
const config = tauriConfig({ identifier, url, title: 'Paper30Min updater integration',
  plugins: { updater: { pubkey: signed.pubkey, endpoints: [`${url}/latest.json`], requireSignedVersion: true } } });
let child, browser, page;
async function native(command, args = {}) {
  const result = await page.evaluate(async ({ command, args }) => {
    try { return { ok: true, value: await window.__TAURI__.core.invoke(command, args) }; }
    catch (error) { return { ok: false, error }; }
  }, { command, args });
  if (!result.ok) throw Object.assign(new Error(result.error.message || String(result.error)), result.error);
  return result.value;
}
const bridge = (command, input = {}) => native('bridge_invoke', { command, input });
async function check(name, fn) {
  const started = Date.now();
  const details = await fn();
  report.checks.push({ name, elapsedMs: Date.now() - started, details });
  console.log(`PASS ${name}`);
}
async function recovered() {
  const task = await native('bridge_start', { kind: 'demo.stream-text@1', input: { text: 'updater recovery', chunks: 1 } });
  const deadline = Date.now() + 5000;
  let status;
  do {
    status = (await bridge('tasks.get@1', { taskId: task.taskId })).task.status;
    if (status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(status, 'succeeded', 'recovery task must actually finish');
  const active = await bridge('tasks.list@1', { activeOnly: true });
  assert.deepEqual(active.tasks, [], `all native tasks must be terminal: ${JSON.stringify(active.tasks)}`);
  await native('component_remove');
  assert.equal(await page.locator('#btn-check-update').isEnabled(), true);
  return { taskId: task.taskId, component: 'remove admitted' };
}
async function blocked() {
  for (const [command, args] of [
    ['bridge_start', { kind: 'demo.stream-text@1', input: {} }], ['component_remove', {}],
  ]) {
    await assert.rejects(native(command, args), error => error.code === 'update_busy');
  }
}
async function checkAvailable() {
  mode = 'available';
  await page.locator('#btn-check-update').click();
  await page.waitForFunction(() => document.querySelector('#update-status').textContent.includes('9.9.9'));
}
async function waitError(text) {
  await page.waitForFunction(text => document.querySelector('#update-status').textContent.includes(text), text);
  assert.equal(await page.locator('#btn-install-update').isVisible(), true);
  assert.equal(await page.locator('#update-progress').isVisible(), false);
}
try {
  // Reuse the existing isolated native UI host; runtime commands remain the production handlers.
  const executable = await buildHost({ config, output });
  ({ child, browser, page } = await launchWebView({ executable, cwd: app, debugPort, pageTimeout: 45000,
    onPageError: error => errors.push(error.message) }));
  page.on('dialog', dialog => dialog.accept());
  report.browser = await browser.version();
  report.library = await bridge('library.info@1');
  assert.equal(path.basename(report.library.dataRoot), identifier, 'refuse a non-test library');
  await bridge('settings.putUi@1', { settings: { welcomeSeeded: true } });
  await page.locator('#su-enter').click();
  await page.locator('#startup-view').waitFor({ state: 'hidden' });
  await page.locator('#btn-settings').click();
  await page.locator('#settings-tab-about').click();
  await page.evaluate(async () => {
    window.updaterEvents = [];
    window.confirmDecision = 'Ok';
    window.confirmDecisions = [];
    window.confirmations = [];
    const fetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (decodeURIComponent(String(input)).includes('plugin:dialog|message')) {
        const args = JSON.parse(options.body);
        if (args.buttons !== 'OkCancel') return fetch(input, options);
        window.confirmations.push(args);
        return Promise.resolve(new Response(JSON.stringify(window.confirmDecisions.shift() ?? window.confirmDecision), {
          headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
        }));
      }
      return fetch(input, options);
    };
    await window.__TAURI__.event.listen('app:update-progress', event => window.updaterEvents.push(event.payload));
  });
  await check('second confirmation cancellation keeps the active task and skips update', async () => {
    await checkAvailable();
    const task = await native('bridge_start', { kind: 'demo.stream-text@1', input: { chunks: 200, chunkDelayMs: 100 } });
    const requests = checksRequested;
    const before = await page.evaluate(() => window.confirmations.length);
    await page.evaluate(() => { window.confirmDecisions = ['Ok', 'Cancel']; });
    await page.locator('#btn-install-update').click();
    await page.waitForFunction(count => window.confirmations.length === count + 2, before);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(checksRequested, requests);
    assert.equal((await bridge('tasks.get@1', { taskId: task.taskId })).task.status, 'running');
    await bridge('tasks.cancel@1', { taskId: task.taskId });
    const deadline = Date.now() + 5000;
    while ((await bridge('tasks.list@1', { activeOnly: true })).tasks.length && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual((await bridge('tasks.list@1', { activeOnly: true })).tasks, []);
    return { taskId: task.taskId, decision: 'Cancel' };
  });
  await check('accepted second confirmation cancels task before the update recheck', async () => {
    await checkAvailable();
    const task = await native('bridge_start', { kind: 'demo.stream-text@1', input: { chunks: 200, chunkDelayMs: 100 } });
    await page.evaluate(() => { window.confirmDecisions = ['Ok', 'Ok']; });
    mode = 'none';
    await page.locator('#btn-install-update').click();
    await waitError('当前没有可安装的更新');
    assert.equal((await bridge('tasks.get@1', { taskId: task.taskId })).task.status, 'cancelled');
    return recovered();
  });
  await check('cancelled confirmation never enters the installation recheck', async () => {
    await checkAvailable();
    const requests = checksRequested;
    const confirmations = await page.evaluate(() => window.confirmations.length);
    await page.evaluate(() => { window.confirmDecision = 'Cancel'; });
    await page.locator('#btn-install-update').click();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(checksRequested, requests);
    assert.equal(await page.locator('#update-status').textContent(), '发现新版本 9.9.9');
    assert.equal((await page.evaluate(() => window.confirmations)).length, confirmations + 1);
    await page.evaluate(() => { window.confirmDecision = 'Ok'; });
    return { requests, decision: 'Cancel' };
  });
  await check('standalone check timeout restores UI retry', async () => {
    mode = 'check-stall';
    await page.locator('#btn-check-update').click();
    await page.waitForFunction(() => document.querySelector('#update-status').textContent.includes('检查更新超时'));
    assert.equal(await page.locator('#btn-check-update').isEnabled(), true);
    return recovered();
  });
  await check('installation recheck timeout releases native admission', async () => {
    await checkAvailable();
    mode = 'check-stall';
    await page.locator('#btn-install-update').click();
    await page.waitForFunction(() => document.querySelector('#update-status').textContent.includes('正在检查安装更新'));
    await blocked();
    await waitError('检查更新超时');
    return recovered();
  });
  for (const stalled of ['body-stall', 'header-stall']) {
    await check(`${stalled} download stops and native tasks/components recover`, async () => {
      await checkAvailable();
      mode = stalled;
      await page.locator('#btn-install-update').click();
      if (stalled === 'body-stall') {
        await page.waitForFunction(() => document.querySelector('#update-status').textContent.includes('正在下载'));
      } else {
        await page.waitForFunction(() => document.querySelector('#update-status').textContent.includes('正在检查安装更新'));
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      await blocked();
      await waitError('下载更新停流超时');
      const closeDeadline = Date.now() + 2000;
      while (!downloadClosed && Date.now() < closeDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(downloadClosed, 'cancelled request must close');
      assert.ok((await page.evaluate(() => window.updaterEvents)).every(event => !event.finished));
      await page.screenshot({ path: path.join(output, `${stalled}-wide.png`) });
      return recovered();
    });
  }
  await check('retry reaches real signature rejection without launching installer', async () => {
    mode = 'tampered';
    await page.locator('#btn-install-update').click();
    await waitError('下载或校验更新失败');
    assert.ok((await page.evaluate(() => window.updaterEvents)).every(event => !event.finished));
    assert.equal(child.exitCode, null);
    return recovered();
  });
  await check('timeout/retry status fits a 430px emulated WebView viewport', async () => {
    await page.setViewportSize({ width: 430, height: 760 });
    await page.waitForFunction(() => innerWidth === 430);
    await page.screenshot({ path: path.join(output, 'error-narrow.png') });
    const bounds = await page.locator('#update-status').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= 430, 'status must fit the viewport');
    assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, 'status text must wrap');
    return bounds;
  });
  assert.deepEqual(errors, []);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = error.stack || String(error);
  process.exitCode = 1;
  console.error(error);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  report.pageErrors = errors;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await stopWebView({ child, browser });
  await closeServers(server);
  await restoreLibraryBuild();
  console.log(`Report: ${output}`);
}
