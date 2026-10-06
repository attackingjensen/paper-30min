import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';

assert.equal(process.platform, 'win32', 'This suite requires Windows WebView2');
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = `pdf-webview-${Date.now()}`;
const identifier = `com.paper30min.${runId}`;
const output = path.resolve(app, '../tmp', runId);
await mkdir(output, { recursive: true });
const report = { runId, identifier, platform: process.platform, node: process.version,
  input: 'CDP synthesized events; physical mouse/trackpad are separate manual checks', checks: [] };
const requests = [];
let responseMode = 'success';
const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (responseMode === 'fail') { res.writeHead(400); res.end('fixture rejection'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Native fixture response.' }, finish_reason: null }] })}\n\n`);
    if (responseMode === 'slow') {
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 100);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.resolve(app, 'ui', relative);
    if (!target.startsWith(path.resolve(app, 'ui') + path.sep)) throw new Error('outside UI');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
    res.end(await readFile(target));
  } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const portProbe = http.createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const debugPort = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const config = JSON.stringify({ identifier, build: { devUrl: url }, app: { security: { capabilities: [
  'default', { identifier: 'pdf-test-resize', windows: ['main'], permissions: ['core:window:allow-set-size'] },
] }, windows: [{
  label: 'main', title: 'Paper30Min PDF integration', width: 1280, height: 900,
}] } });
let child, browser, page;
const errors = [];
const invoke = (command, input = {}) => page.evaluate(({ command, input }) =>
  window.__TAURI__.core.invoke('bridge_invoke', { command, input }), { command, input });
async function check(name, fn) {
  const start = Date.now();
  const details = await fn();
  report.checks.push({ name, elapsedMs: Date.now() - start, details });
  console.log(`PASS ${name}`);
}
async function openPaper(id) {
  const previous = await page.$('#pdf-pages canvas');
  const previousTitle = await page.locator('#reader-title').textContent();
  await page.locator('#nav-library').click();
  await page.locator('.paper-card').filter({ hasText: `U5 ${id}` }).click();
  if (previous && previousTitle !== `U5 ${id}`) {
    await page.waitForFunction(canvas => !canvas.isConnected, previous);
    await previous.dispose();
  }
  await page.waitForFunction(() => document.querySelector('#pdf-pages canvas')?.width > 0);
}
async function jump(number) {
  await page.locator('#pdf-page-input').fill(String(number));
  await page.locator('#pdf-page-input').press('Enter');
  await page.waitForFunction(n => document.querySelector(`.pdf-page[data-page="${n}"] canvas`)?.width > 0, number);
}
async function painted() {
  await page.waitForFunction(() => {
    const canvases = [...document.querySelectorAll('#pdf-pages canvas')];
    return canvases.length && canvases.every(canvas => Math.abs(canvas.width -
      Math.ceil(canvas.parentElement.getBoundingClientRect().width * Math.min(devicePixelRatio, 2))) <= 2);
  });
}
async function savedChats(count) {
  await page.waitForFunction(async count => {
    const { paper } = await window.__TAURI__.core.invoke('bridge_invoke', {
      command: 'library.getPaper@1', input: { paperId: 'resnet' },
    });
    return paper.chat.length === count;
  }, count);
}
async function run(command, args, env = process.env) {
  const processHandle = spawn(command, args, { cwd: app, env, stdio: 'inherit', windowsHide: true });
  const completion = once(processHandle, 'exit');
  const [code] = await completion;
  assert.equal(code, 0, `${command} ${args.join(' ')}`);
}
async function enter() {
  await page.locator('#su-enter').click();
  await page.locator('#startup-view').waitFor({ state: 'hidden' });
}
async function drag(from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}
async function area() {
  await jump(1);
  await page.locator('#btn-pdf-fit').click();
  await page.locator('#pdf-tool-area').click();
  const box = await page.locator('#pdf-canvas-wrap').boundingBox();
  await drag({ x: box.x + 70, y: box.y + 70 }, { x: box.x + 260, y: box.y + 180 });
  await page.locator('#pdf-selection-popup').waitFor({ state: 'visible' });
}
async function inkRegion(rect) {
  return page.evaluate(rect => {
    const canvas = document.querySelector('#pdf-pages canvas');
    const slot = canvas.parentElement;
    const sx = canvas.width / Number(slot.dataset.baseWidth), sy = canvas.height / Number(slot.dataset.baseHeight);
    const [x, y, width, height] = rect;
    const pixels = canvas.getContext('2d').getImageData(Math.round(x * sx), Math.round(y * sy),
      Math.round(width * sx), Math.round(height * sy)).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4)
      if (pixels[index + 3] && Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 230) count++;
    return count;
  }, rect);
}
async function launch(executable) {
  child = spawn(executable, [], {
    cwd: app, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1` },
    stdio: 'ignore', windowsHide: true,
  });
  await Promise.race([once(child, 'error').then(([error]) => { throw error; }), (async () => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Native host exited with code ${child.exitCode}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); return; }
      catch { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    throw new Error('WebView2 CDP did not start');
  })()]);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__TAURI__?.core);
}
async function stopHost() {
  if (browser) { await browser.close(); browser = null; }
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
}
const scrollState = () => page.locator('#pdf-canvas-wrap').evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft }));
try {
  await run('python', [path.join(app, 'tests/integration/make_pdf_fixtures.py'), output]);
  await run('cargo', ['run', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'pdf_webview_fixtures', '--',
    path.join(app, 'src-tauri/tests/fixtures/docling/1512.03385.json.gz'), path.join(output, 'blockmodel.json')],
  { ...process.env, TAURI_CONFIG: config });
  // Cargo examples do not inherit Tauri's executable manifest; dialogs require Common Controls v6.
  await run('cargo', ['rustc', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'pdf_webview_host', '--',
    '-C', 'link-arg=/MANIFEST:EMBED', '-C', "link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"],
  { ...process.env, TAURI_CONFIG: config });
  // Launch away from target/debug/sidecar so startup cannot migrate a developer's legacy parser.
  const executable = path.join(output, 'paper30min.exe');
  await copyFile(path.join(app, 'src-tauri/target/debug/examples/pdf_webview_host.exe'), executable);
  await launch(executable);
  report.build = 'debug; unchanged UI served from loopback devUrl; isolated Tauri identifier';
  report.browser = await browser.version();
  report.library = await invoke('library.info@1');
  assert.equal(path.basename(report.library.dataRoot), identifier, 'refuse to seed a non-test library');
  await invoke('settings.putUi@1', { settings: { welcomeSeeded: true } });
  await invoke('settings.putModel@1', { settings: { baseUrl: `${url}/v1`, apiKey: 'local-fixture', model: 'fixture' } });
  const fixtureRoot = path.join(app, 'src-tauri/tests/fixtures');
  const fixtures = [
    ['resnet', path.join(fixtureRoot, 'regression/corpus/1512.03385.pdf'), 12],
    ['bert', path.join(fixtureRoot, 'regression/corpus/1810.04805.pdf'), 16],
    ['scan', path.join(output, 'scan-image.pdf'), 1],
    ['formula', path.join(fixtureRoot, 'pdfparse_formula_graphics.pdf'), 1],
    ['long', path.join(output, 'long.pdf'), 150],
    ['mixed', path.join(output, 'mixed.pdf'), 3],
  ];
  for (const [id, file, pages] of fixtures) {
    await invoke('library.putPaper@1', { paper: { id, title: `U5 ${id}`, numPages: pages,
      addedAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' } });
    const bytes = await readFile(file);
    await invoke('files.putAttachment@1', { paperId: id, attachment: {
      id: 'pdf', name: path.basename(file), contentType: 'application/pdf', contentBase64: bytes.toString('base64'),
    } });
  }
  const mapped = JSON.parse(await readFile(path.join(output, 'blockmodel.json'), 'utf8'));
  const resnet = (await invoke('library.getPaper@1', { paperId: 'resnet' })).paper;
  const blockSection = mapped.sections.find(section => section.blocks.some(block => block.sourceRegions?.length));
  const block = blockSection.blocks.find(block => block.sourceRegions?.length);
  const cite = `(${blockSection.id}:L${block.id})`;
  resnet.products = [{ kind: 'map', partId: '', body: { problem: { text: 'Native fixture', refs: [cite] } }, updatedAt: resnet.updatedAt }];
  resnet.chat = [{ role: 'assistant', content: `| Evidence |\n| --- |\n| ${cite} |\n\n(p5)`, createdAt: resnet.updatedAt }];
  resnet.translations = [{ sectionId: 'abstract', language: 'zh', text: 'Preserved whole-section translation', source: null, updatedAt: resnet.updatedAt }];
  await invoke('library.putPaper@1', { paper: resnet });
  for (const [id, bytes] of [
    ['blockmodel.json', Buffer.from(JSON.stringify(mapped))],
    ['docling-source.json', gunzipSync(await readFile(path.join(app, 'src-tauri/tests/fixtures/docling/1512.03385.json.gz')))],
  ]) await invoke('files.putAttachment@1', { paperId: 'resnet', attachment: { id, name: id,
    contentType: 'application/json', contentBase64: bytes.toString('base64') } });
  await page.reload();
  await enter();
  await check('two-column PDF native loading and nonblank canvas', async () => {
    await openPaper('resnet');
    return page.evaluate(() => {
      const canvas = document.querySelector('#pdf-pages canvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] && Math.min(data[i], data[i + 1], data[i + 2]) < 230) ink++;
      if (ink < 1000) throw new Error('blank canvas');
      return { ink, width: canvas.width, height: canvas.height, viewport: [innerWidth, innerHeight] };
    });
  });
  await page.screenshot({ path: path.join(output, 'resnet.png') });
  await check('late pages, release and return', async () => {
    await jump(10);
    await page.waitForFunction(() => !document.querySelector('.pdf-page[data-page="1"] canvas'));
    assert.ok(await page.locator('#pdf-pages canvas').count() <= 4);
    await jump(1);
  });
  await check('mode switches preserve current page', async () => {
    await jump(6);
    await page.locator('#btn-pdf-mode').click();
    assert.equal(await page.locator('#pdf-page-input').inputValue(), '6');
    await page.locator('#btn-pdf-mode').click();
    assert.equal(await page.locator('#pdf-page-input').inputValue(), '6');
  });
  await check('native source recovery and Markdown table citation', async () => {
    await page.locator('[data-tab="chat"]').click();
    await page.locator('#chat-log td [data-cite]').click();
    await page.waitForFunction(() => document.querySelector('.pdf-evidence-highlight'));
    await page.locator('#chat-log [data-cite="(p5)"]').click();
    await page.waitForFunction(() => document.querySelector('#pdf-page-input').value === '5');
    assert.equal(await page.locator('.pdf-evidence-highlight').count(), 0);
  });
  await check('hand pans horizontally and vertically in both modes', async () => {
    for (const full of [false, true]) {
      if (full) await page.locator('#btn-pdf-mode').click();
      await jump(3);
      for (let index = 0; index < 8; index++) await page.locator('#btn-pdf-zoom-in').click();
      await painted();
      await page.locator('#pdf-tool-hand').click();
      const box = await page.locator('#pdf-canvas-wrap').boundingBox();
      const before = await scrollState();
      await drag({ x: box.x + 260, y: box.y + 260 }, { x: box.x + 100, y: box.y + 100 });
      const after = await scrollState();
      assert.ok(after.top > before.top + 100);
      assert.ok(after.left > before.left + 100);
      assert.equal(await page.locator('.pdf-dragging').count(), 0);
      await page.locator('#btn-pdf-fit').click();
    }
    await page.locator('#btn-pdf-mode').click();
  });
  await check('Ctrl wheel zoom versus ordinary scroll', async () => {
    await jump(3);
    const box = await page.locator('#pdf-canvas-wrap').boundingBox();
    await page.mouse.move(box.x + 140, box.y + 140);
    const zoom = await page.locator('#pdf-zoom-label').textContent();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForFunction(old => document.querySelector('#pdf-zoom-label').textContent !== old, zoom);
    const changed = await page.locator('#pdf-zoom-label').textContent();
    const before = await scrollState();
    await page.mouse.wheel(0, 250);
    await page.waitForFunction(top => document.querySelector('#pdf-canvas-wrap').scrollTop > top + 100, before.top);
    assert.equal(await page.locator('#pdf-zoom-label').textContent(), changed);
  });
  await check('native screenshot translation, error retry and cancellation', async () => {
    await area();
    responseMode = 'fail';
    await page.locator('#pdf-selection-translate').click();
    await page.waitForFunction(() => document.querySelector('#pdf-selection-status').textContent.includes('翻译失败'));
    responseMode = 'success';
    await page.locator('#pdf-selection-translate').click();
    await page.waitForFunction(() => document.querySelector('#pdf-selection-result').textContent.includes('Native fixture response.'));
    assert.ok(requests.at(-1).messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
    const saved = (await invoke('library.getPaper@1', { paperId: 'resnet' })).paper;
    assert.deepEqual(saved.translations, resnet.translations);
    responseMode = 'slow';
    await page.locator('#pdf-selection-translate').click();
    await page.locator('#pdf-selection-stop').waitFor({ state: 'visible' });
    await page.locator('#pdf-selection-stop').click();
    await page.waitForFunction(() => document.querySelector('#pdf-selection-status').textContent === '已停止');
    responseMode = 'success';
  });
  await check('screenshot question persists native attachments and replayed history', async () => {
    await page.locator('#pdf-selection-ask').click();
    await page.locator('#chat-input').fill('Explain this selected image.');
    await page.locator('#btn-chat-send').click();
    await page.waitForFunction(() => document.querySelector('#chat-log').textContent.includes('Native fixture response.'));
    await page.waitForFunction(() => !document.querySelector('#chat-log .streaming-text'));
    await savedChats(3);
    const saved = (await invoke('library.getPaper@1', { paperId: 'resnet' })).paper;
    assert.equal(saved.chat.at(-1).content, 'Native fixture response.');
    const user = saved.chat.find(message => message.role === 'user');
    assert.equal(user.bindingKind, 'pdf');
    assert.ok(user.pdfSelection.images[0].attachmentId.startsWith('pdf-selection-'));
    assert.equal(user.pdfSelection.images[0].dataUrl, undefined);
    const attachment = (await invoke('files.getAttachment@1', { paperId: 'resnet', attachmentId: user.pdfSelection.images[0].attachmentId })).attachment;
    assert.ok(attachment.size > 100);
    await page.reload();
    await enter();
    await openPaper('resnet');
    await page.locator('[data-tab="chat"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#chat-log .chat-msg').length === 3);
    await page.locator('#chat-input').fill('Follow up on the same image.');
    await page.locator('#btn-chat-send').click();
    await page.waitForFunction(() => document.querySelectorAll('#chat-log .assistant').length === 3 &&
      document.querySelector('#chat-log .assistant:last-child').textContent.includes('Native fixture response.'));
    await savedChats(5);
    assert.ok(requests.at(-1).messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
    await stopHost();
    await launch(executable);
    assert.equal((await invoke('library.info@1')).dataRoot, report.library.dataRoot);
    await enter();
    await openPaper('resnet');
    await page.locator('[data-tab="chat"]').click();
    await page.locator('#chat-input').fill('Follow up after native restart.');
    await page.locator('#btn-chat-send').click();
    await savedChats(7);
    assert.ok(requests.at(-1).messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
    return { attachmentSize: attachment.size };
  });
  await check('text selection spans real PDF text layers across pages', async () => {
    await jump(1);
    await page.locator('#pdf-tool-text').click();
    await page.waitForFunction(() => document.querySelector('.pdf-page[data-page="2"] .pdf-text-layer span'));
    await page.evaluate(() => {
      const first = [...document.querySelectorAll('.pdf-page[data-page="1"] .pdf-text-layer span')].at(-1).firstChild;
      const last = document.querySelector('.pdf-page[data-page="2"] .pdf-text-layer span').firstChild;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.locator('#pdf-selection-popup').waitFor({ state: 'visible' });
    const pages = await page.locator('.pdf-selection-highlight').evaluateAll(nodes => [...new Set(nodes.map(node => node.parentElement.dataset.page))]);
    assert.deepEqual(pages, ['1', '2']);
    await page.locator('#pdf-selection-translate').click();
    await page.waitForFunction(() => document.querySelector('#pdf-selection-result').textContent.includes('Native fixture response.'));
    assert.equal(typeof requests.at(-1).messages.at(-1).content, 'string');
    await page.locator('#pdf-selection-close').click();
  });
  await check('library export/import restores screenshot bytes through native store', async () => {
    const payload = await page.evaluate(async () => {
      const papers = await import('/js/papers.js');
      const payload = papers.parseLibraryFile(await papers.exportLibrary());
      const record = payload.papers.find(paper => paper.id === 'resnet');
      record.id = 'roundtrip';
      record.title = 'U5 roundtrip';
      return { ...payload, papers: [record] };
    });
    const importPath = path.join(output, 'roundtrip.json');
    await writeFile(importPath, JSON.stringify(payload));
    const inspected = await invoke('migration.inspect@1', { sourcePath: importPath });
    const imported = await invoke('migration.commit@1', { token: inspected.token });
    assert.equal(imported.added, 1);
    const original = (await invoke('library.getPaper@1', { paperId: 'resnet' })).paper;
    const restored = (await invoke('library.getPaper@1', { paperId: 'roundtrip' })).paper;
    const normalizeChat = chat => chat.map(message => ({ ...message, createdAt: Date.parse(message.createdAt) }));
    assert.deepEqual(normalizeChat(restored.chat), normalizeChat(original.chat));
    for (const image of payload.papers[0].selectionAttachments) {
      const meta = (await invoke('files.getAttachment@1', { paperId: 'roundtrip', attachmentId: image.id })).attachment;
      const data = await invoke('files.readRange@1', { paperId: 'roundtrip', attachmentId: image.id, offset: 0, length: meta.size });
      assert.equal(data.contentBase64, image.contentBase64);
    }
  });
  await check('replaced PDF rejects obsolete provenance', async () => {
    const replacement = await readFile(path.join(fixtureRoot, 'pdfparse_formula_graphics.pdf'));
    await invoke('files.putAttachment@1', { paperId: 'resnet', attachment: { id: 'pdf', name: 'replacement.pdf',
      contentType: 'application/pdf', contentBase64: replacement.toString('base64') } });
    const metadata = (await invoke('files.getAttachment@1', { paperId: 'resnet', attachmentId: 'blockmodel.json' })).attachment;
    const evidence = await page.evaluate(input => window.__TAURI__.core.invoke('pdfmap_source_regions', { input }),
      { paperId: 'resnet', blockModelSha256: metadata.sha256 });
    assert.deepEqual(evidence.blocks, []);
    await page.reload();
    await enter();
    await openPaper('resnet');
    await page.locator('[data-tab="chat"]').click();
    await page.locator('#chat-log td [data-cite]').click();
    await page.waitForFunction(() => document.querySelector('#pdf-evidence-status').textContent.includes('仅页级'));
    assert.equal(await page.locator('.pdf-evidence-highlight').count(), 0);
  });
  await check('scan page has canvas but no selectable text', async () => {
    await openPaper('scan');
    assert.equal(await page.locator('.pdf-text-layer span').count(), 0);
    const ink = await inkRegion([50, 50, 500, 280]);
    assert.ok(ink > 1000, 'scan text/graph must be visible');
    await page.screenshot({ path: path.join(output, 'scan.png') });
    return { ink };
  });
  await check('formula and embedded image render', async () => {
    await openPaper('formula');
    assert.ok(await page.locator('.pdf-text-layer span').count() > 0);
    const vectorInk = await inkRegion([150, 262, 160, 80]);
    const bitmapInk = await inkRegion([186, 434, 240, 48]);
    assert.ok(vectorInk > 100, 'vector formula must be visible');
    assert.ok(bitmapInk > 100, 'bitmap formula must be visible');
    await page.screenshot({ path: path.join(output, 'formula.png') });
    return { vectorInk, bitmapInk };
  });
  await check('long PDF keeps bounded canvases and redraws after return', async () => {
    await openPaper('long');
    const total = Number((await page.locator('#pdf-page-count').textContent()).replace('/', '').trim());
    assert.ok(total >= 100);
    for (const number of [30, 75, total, 1]) {
      await jump(number);
      assert.ok(await page.locator('#pdf-pages canvas').count() <= 4);
    }
    return { pages: await page.locator('.pdf-page').count(), canvases: await page.locator('#pdf-pages canvas').count() };
  });
  await check('mixed page sizes and legacy page position', async () => {
    await invoke('library.putReadingPosition@1', { position: { paperId: 'mixed', view: 'map', pdfPage: 2, updatedAt: resnet.updatedAt } });
    await openPaper('mixed');
    await page.waitForFunction(() => document.querySelector('#pdf-page-input').value === '2');
    const sizes = await page.locator('.pdf-page').evaluateAll(nodes => nodes.map(node => [node.dataset.baseWidth, node.dataset.baseHeight]));
    assert.notDeepEqual(sizes[0], sizes[1]);
    await jump(3);
    await page.screenshot({ path: path.join(output, 'mixed.png') });
    return sizes;
  });
  await check('actual native narrow window remains readable in full PDF mode', async () => {
    await page.evaluate(async () => {
      await window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.dpi.LogicalSize(430, 760));
    });
    report.narrowNative = await page.evaluate(async () => ({ viewport: [innerWidth, innerHeight],
      native: await window.__TAURI__.window.getCurrentWindow().innerSize(),
      dpi: await window.__TAURI__.window.getCurrentWindow().scaleFactor() }));
    await page.waitForFunction(() => innerWidth === 430);
    await page.locator('#btn-pdf-mode').click();
    await painted();
    await page.screenshot({ path: path.join(output, 'narrow.png') });
    return page.evaluate(() => ({ viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth }));
  });
  assert.deepEqual(errors, []);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = error.stack || String(error);
  if (page) report.selectionStatus = await page.locator('#pdf-selection-status').textContent().catch(() => null);
  if (page) report.chatState = await page.locator('#chat-log').evaluate(node => ({ html: node.innerHTML,
    messages: [...node.querySelectorAll('.chat-msg')].map(message => ({ role: message.className, text: message.textContent })) })).catch(() => null);
  if (page) report.savedChat = await invoke('library.getPaper@1', { paperId: 'resnet' }).then(result => result.paper.chat).catch(() => null);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
  console.error(error);
} finally {
  report.pageErrors = errors;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await stopHost();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--lib']);
  console.log(`Report: ${output}`);
}
