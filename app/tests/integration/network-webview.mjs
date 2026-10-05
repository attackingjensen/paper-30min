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
const identifier = `com.paper30min.network-webview-${Date.now()}`;
const output = path.resolve(app, '../tmp', identifier);
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [] };
const signed = JSON.parse(await readFile(path.join(app, 'src-tauri/tests/fixtures/updater/signed-bytes.json'), 'utf8'));
const updateBytes = Buffer.from(signed.content);
updateBytes[0] ^= 1; // Invalid signature prevents the fixture from ever launching an installer.
let updateAvailable = false;
let proxyHits = 0;
let originHits = 0;
let holdChat = false, heldChat;
let holdManifest = false, heldManifest;
const proxy = http.createServer((req, res) => {
  proxyHits++;
  if (holdChat && req.url.includes('/chat/completions')) { heldChat = res; return; }
  if (holdManifest && req.url.includes('/latest.json')) { heldManifest = res; return; }
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'blocked by fixture proxy' } }));
});
const server = http.createServer(async (req, res) => {
  if (req.url === '/latest.json') {
    originHits++;
    if (!updateAvailable) { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '9.9.9', url: `${url}/fixture.bin`, signature: signed.signature })); return;
  }
  if (req.url === '/fixture.bin') { originHits++; res.writeHead(200); res.end(updateBytes); return; }
  if (req.url === '/v1/models') {
    originHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return;
  }
  if (req.url === '/v1/chat/completions') {
    originHits++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"direct fixture"}}]}\n\ndata: [DONE]\n\n'); return;
  }
  if (req.url === '/text' || req.url === '/paper.pdf') {
    originHits++;
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('fixture bytes'); return;
  }
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const root = path.resolve(app, 'ui');
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new Error('outside UI');
    const bytes = await readFile(target);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
const url = `http://127.0.0.1:${await listen(server)}`;
const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
const probe = http.createServer();
const debugPort = await listen(probe);
await new Promise(resolve => probe.close(resolve));
const config = JSON.stringify({ identifier, build: { devUrl: url },
  plugins: { updater: { pubkey: signed.pubkey, endpoints: [`${url}/latest.json`] } },
  app: { windows: [{ label: 'main', title: 'Paper30Min network integration', width: 1280, height: 900 }] },
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
async function task(kind, input = {}, expected = 'succeeded') {
  const started = await native('bridge_start', { kind, input });
  return finishTask(started.taskId, expected);
}
async function finishTask(taskId, expected = 'succeeded') {
  const deadline = Date.now() + 10000;
  let snapshot;
  do {
    snapshot = (await bridge('tasks.get@1', { taskId })).task;
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(snapshot.status, expected, JSON.stringify(snapshot.error));
  return snapshot;
}
async function waitUntil(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'fixture request must arrive');
}
async function check(name, fn) { await fn(); report.checks.push(name); console.log(`PASS ${name}`); }
async function saveMode(mode) {
  await page.locator(`input[name="proxy-mode"][value="${mode}"]`).check();
  await page.locator('#btn-save-network-settings').click();
  await page.waitForFunction(() => document.querySelector('#btn-save-network-settings').disabled === false);
  assert.equal((await bridge('settings.get@1')).network.proxyMode, mode);
  assert.equal(await page.locator('#network-settings-status').textContent(), '网络设置已保存');
}
try {
  await run('cargo', ['rustc', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'pdf_webview_host', '--',
    '-C', 'link-arg=/MANIFEST:EMBED'], { ...process.env, TAURI_CONFIG: config });
  const executable = path.join(output, 'paper30min.exe');
  await copyFile(path.join(app, 'src-tauri/target/debug/examples/pdf_webview_host.exe'), executable);
  const env = { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: '', no_proxy: '',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1 --no-proxy-server`,
  };
  child = spawn(executable, [], { cwd: app, env, stdio: 'ignore', windowsHide: true });
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
  assert.equal(path.basename(library.dataRoot), identifier, 'must use an isolated library');
  await bridge('settings.putUi@1', { settings: { welcomeSeeded: true } });
  await bridge('settings.putModel@1', { settings: { baseUrl: `${url}/v1`, apiKey: 'fixture', model: 'fixture' } });
  await page.locator('#su-enter').click();
  await page.locator('#startup-view').waitFor({ state: 'hidden' });
  await page.locator('#btn-settings').click();
  await page.locator('#settings-tab-proxy').click();
  await check('automatic mode uses inherited proxy', async () => {
    assert.equal(await page.locator('input[value="system"][name="proxy-mode"]').isChecked(), true);
    const before = proxyHits;
    await task('model.test@1', {}, 'failed');
    assert.ok(proxyHits > before);
  });
  await check('saved direct mode bypasses proxy for model test and streamed chat', async () => {
    await saveMode('direct');
    const before = proxyHits;
    await task('model.test@1');
    const chat = await task('model.chat@1', { messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(chat.result.text, 'direct fixture');
    assert.equal(proxyHits, before);
  });
  await check('direct text and attachment downloads reach origin', async () => {
    const before = proxyHits;
    await task('net.fetch-text@1', { url: `${url}/text` });
    await bridge('library.putPaper@1', { paper: { id: 'proxy-paper', title: 'Fixture paper' } });
    const downloaded = await task('files.download@1', { paperId: 'proxy-paper', attachmentId: 'pdf', name: 'fixture.pdf',
      contentType: 'application/pdf', url: `${url}/paper.pdf` });
    assert.equal(downloaded.result.attachment.size, Buffer.byteLength('fixture bytes'));
    assert.equal(proxyHits, before);
  });
  await check('direct updater check bypasses proxy', async () => {
    const before = proxyHits;
    assert.deepEqual(await native('updater_check'), { available: false });
    assert.equal(proxyHits, before);
  });
  await check('direct update download reaches signature rejection without proxy', async () => {
    updateAvailable = true;
    const before = proxyHits;
    await assert.rejects(native('updater_install', { version: '9.9.9' }), error =>
      error.code === 'update_download_failed' && /signature|签名/i.test(error.message));
    assert.equal(proxyHits, before);
    updateAvailable = false;
  });
  await check('switch back to automatic reuses proxy and switching again restores direct', async () => {
    await saveMode('system');
    const before = proxyHits;
    await task('model.test@1', {}, 'failed');
    await assert.rejects(native('updater_check'));
    assert.ok(proxyHits > before);
    await saveMode('direct');
    await task('model.test@1');
  });
  await check('compatibility retry reads mode saved while first request is waiting', async () => {
    await saveMode('system');
    holdChat = true;
    const before = proxyHits;
    const started = await native('bridge_start', { kind: 'model.chat@1', input: {
      messages: [{ role: 'user', content: 'delayed rejection' }],
    } });
    await waitUntil(() => heldChat);
    await saveMode('direct');
    holdChat = false;
    heldChat.writeHead(400, { 'Content-Type': 'application/json' });
    heldChat.end(JSON.stringify({ error: { message: 'Unsupported parameter: temperature' } }));
    const chat = await finishTask(started.taskId);
    assert.equal(chat.result.text, 'direct fixture');
    assert.equal(proxyHits, before + 1, 'only the already-sent request enters proxy');
  });
  await check('update download reads mode saved while manifest request is waiting', async () => {
    await saveMode('system');
    holdManifest = true;
    const before = proxyHits;
    const installing = native('updater_install', { version: '9.9.9' });
    // Attach the rejection handler immediately while the native check is pending.
    const outcome = installing.then(() => ({ ok: true }), error => ({ error }));
    await waitUntil(() => heldManifest);
    await saveMode('direct');
    holdManifest = false;
    heldManifest.writeHead(200, { 'Content-Type': 'application/json' });
    heldManifest.end(JSON.stringify({ version: '9.9.9', url: `${url}/fixture.bin`, signature: signed.signature }));
    const result = await outcome;
    assert.equal(result.error?.code, 'update_download_failed');
    assert.match(result.error.message, /signature|签名/i);
    assert.equal(proxyHits, before + 1, 'download must bypass the previous proxy');
  });
  await check('mode survives page reload and renders at desktop and narrow widths', async () => {
    await page.reload();
    await page.locator('#su-enter').click();
    await page.locator('#startup-view').waitFor({ state: 'hidden' });
    await page.locator('#btn-settings').click();
    await page.locator('#settings-tab-proxy').click();
    assert.equal(await page.locator('input[value="direct"][name="proxy-mode"]').isChecked(), true);
    const session = await browser.contexts()[0].newCDPSession(page);
    for (const width of [1280, 430]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const bounds = await page.locator('#settings-proxy').evaluate(node => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= width);
      assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1);
      await page.screenshot({ path: path.join(output, `network-${width}.png`) });
    }
    await session.detach();
  });
  assert.deepEqual(report.errors, []);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack || String(error); process.exitCode = 1; console.error(error);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  report.proxyHits = proxyHits; report.originHits = originHits;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close();
  if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
  for (const handle of [server, proxy]) { handle.closeAllConnections(); await new Promise(resolve => handle.close(resolve)); }
  await run('cargo', ['build', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--lib']);
  console.log(`Report: ${output}`);
}
