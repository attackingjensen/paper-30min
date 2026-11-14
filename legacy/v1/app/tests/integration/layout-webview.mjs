import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertWindowsHost, appDir as app, listen, createUiServer, claimDebugPort, tauriConfig,
  buildHost, launchWebView, stopWebView, closeServers, restoreLibraryBuild } from './webview-host.mjs';

assertWindowsHost();
const identifier = `com.paper30min.layout-${Date.now()}`;
const output = path.resolve(app, '../../../tmp', identifier);
await mkdir(output, { recursive: true });
const report = { layouts: [], errors: [] };
const server = createUiServer();
const url = `http://127.0.0.1:${await listen(server)}`;
const debugPort = await claimDebugPort();
const config = tauriConfig({ identifier, url, title: 'Paper30Min layout integration',
  app: { security: { capabilities: ['default', { identifier: 'layout-resize', windows: ['main'],
    permissions: ['core:window:allow-set-size'] }] } } });
let child, browser, page;
const bridge = (command, input = {}) => page.evaluate(({ command, input }) =>
  window.__TAURI__.core.invoke('bridge_invoke', { command, input }), { command, input });
async function resize(width, height) {
  await page.evaluate(async ({ width, height }) => {
    await window.__TAURI__.window.getCurrentWindow().setSize(new window.__TAURI__.dpi.LogicalSize(width, height));
  }, { width, height });
  // Keep the CSS viewport exact even when Windows rounds the physical size at fractional DPI.
  await page.setViewportSize({ width, height });
  await page.waitForFunction(width => innerWidth === width, width);
}
async function fits(name) {
  const layout = await page.evaluate(async () => ({
    viewport: [innerWidth, innerHeight], documentWidth: document.documentElement.scrollWidth,
    nativeSize: await window.__TAURI__.window.getCurrentWindow().innerSize(),
    dpi: await window.__TAURI__.window.getCurrentWindow().scaleFactor(),
    overflowing: [...document.querySelectorAll('body *')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width && rect.right > innerWidth + 1 && getComputedStyle(node).position !== 'fixed';
    }).slice(0, 12).map(node => node.id || node.className),
  }));
  report.layouts.push({ name, ...layout });
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  assert.ok(layout.documentWidth <= layout.viewport[0], `${name}: ${JSON.stringify(layout)}`);
  console.log(`PASS ${name}: ${layout.documentWidth}px`);
}
try {
  const executable = await buildHost({ config, output });
  ({ child, browser, page } = await launchWebView({ executable, cwd: app, debugPort,
    onPageError: error => report.errors.push(error.message) }));
  const library = await bridge('library.info@1');
  assert.equal(path.basename(library.dataRoot), identifier);
  await bridge('settings.putUi@1', { settings: { welcomeSeeded: true } });
  const model = JSON.parse(await readFile(path.join(app, 'src-tauri/tests/fixtures/protocol/blockmodel-basic.json'), 'utf8'));
  const title = 'Layout fixture: reading a paper with a long title and source sections';
  await bridge('library.putPaper@1', { paper: { id: 'layout-paper', title,
    products: [{ kind: 'map', partId: '', body: { problem: { text: 'Layout fixture', refs: [] } },
      updatedAt: '2026-10-10T00:00:00Z' }],
  } });
  for (const [id, type, bytes] of [
    ['blockmodel.json', 'application/json', Buffer.from(JSON.stringify(model))],
    ['pdf', 'application/pdf', await readFile(path.join(app, 'src-tauri/tests/fixtures/regression/corpus/1512.03385.pdf'))],
  ]) await bridge('files.putAttachment@1', { paperId: 'layout-paper', attachment: {
    id, name: id, contentType: type, contentBase64: bytes.toString('base64'),
  } });
  await page.reload();
  await page.locator('#su-enter').click();
  await page.locator('#startup-view').waitFor({ state: 'hidden' });
  await resize(430, 760);
  await fits('narrow-library');
  await page.locator('.paper-card').filter({ hasText: title }).click();
  await page.locator('#map-tree').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#pdf-pages canvas')?.width > 0);
  await fits('narrow-reader-map');
  await page.locator('[data-tab="source"]').click();
  await fits('narrow-reader-source');
  await resize(1280, 900);
  await fits('wide-reader');
  const panes = await page.evaluate(() => ({
    primary: document.querySelector('.reader-primary').getBoundingClientRect().toJSON(),
    pdf: document.querySelector('#pdf-sidebar').getBoundingClientRect().toJSON(),
    direction: getComputedStyle(document.querySelector('.reader-primary')).flexDirection,
  }));
  assert.equal(panes.direction, 'row');
  assert.ok(panes.pdf.left >= panes.primary.right, 'desktop PDF stays beside reading content');
  await page.locator('#nav-library').click();
  await fits('wide-library');
  assert.deepEqual(report.errors, []);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await stopWebView({ child, browser });
  await closeServers(server);
  await restoreLibraryBuild();
  console.log(`Report: ${output}`);
}
