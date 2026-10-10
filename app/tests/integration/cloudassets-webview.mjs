import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertWindowsHost, appDir as app, listen, createUiServer, claimDebugPort, tauriConfig,
  buildHost, launchWebView, stopWebView, closeServers, restoreLibraryBuild } from './webview-host.mjs';

assertWindowsHost();
const readerReportPath = process.env.PAPER30MIN_U6_READER_REPORT;
const readerReport = readerReportPath ? JSON.parse(await readFile(readerReportPath, 'utf8')) : null;
if (readerReport) assert.equal(readerReport.result, 'passed');
const identifier = readerReport ? path.basename(path.dirname(readerReportPath)) : `com.paper30min.cloudassets-webview-${Date.now()}`;
if (readerReport) assert.match(identifier, /^com\.paper30min\.cloudassets-webview-\d+$/);
const output = path.resolve(app, '../tmp', readerReport ? `${identifier}-reader-${Date.now()}` : identifier);
await mkdir(output, { recursive: true });
const report = readerReport ? { ...readerReport, checks: [], errors: [], reusedReport: readerReportPath } : { checks: [], errors: [], sources: [], papers: [] };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const server = createUiServer();
const url = `http://127.0.0.1:${await listen(server)}`;
const debugPort = await claimDebugPort();
const config = tauriConfig({ identifier, url, title: 'Paper30Min visual assets integration' });
let child, browser, page, library;
let executable;
async function memorySnapshot() {
  const script = `$all = Get-CimInstance Win32_Process; $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${child.pid}); do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added); @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PeakWorkingSet64) | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
  const heap = await (await browser.contexts()[0].newCDPSession(page)).send('Runtime.getHeapUsage');
  return { processes: JSON.parse(stdout), heap };
}
async function launch() {
  ({ child, browser, page } = await launchWebView({ executable, cwd: output, debugPort, deadlineMs: 90000, pageTimeout: 30000,
    onPageError: error => report.errors.push(error.message),
    ready: () => window.__TAURI__?.core && window.pdfjsLib }));
  library = await bridge('library.info@1');
  assert.equal(path.basename(library.dataRoot), identifier, 'isolated library required');
}
async function stop() {
  await stopWebView({ child, browser });
  child = browser = page = null;
}
async function native(command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
}
const bridge = (command, input = {}) => page.evaluate(async ({ command, input }) => {
  const { createBridge } = await import('/bridge.js');
  try { return await createBridge(window.__TAURI__).invoke(command, input); }
  catch (error) { throw new Error(`${error.code}: ${error.message}`); }
}, { command, input });
async function expectNativeError(command, input, code) {
  const actual = await page.evaluate(async ({ command, input }) => {
    const { createBridge } = await import('/bridge.js');
    try { await createBridge(window.__TAURI__).invoke(command, input); return null; }
    catch (error) { return error.code; }
  }, { command, input });
  assert.equal(actual, code);
}
async function check(name, fn) { await fn(); report.checks.push(name); console.log(`PASS ${name}`); }
async function terminal(taskId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const { task } = await bridge('tasks.get@1', { taskId });
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Task ${taskId} did not terminate`);
}
async function seed(paperId, batchId, pdf, raw) {
  const existing = (await bridge('library.listPapers@1')).papers.some(paper => paper.id === paperId);
  if (!existing) await bridge('library.putPaper@1', { paper: { id: paperId, title: paperId } });
  await bridge('files.putAttachment@1', { paperId, attachment: {
    id: 'pdf', name: `${paperId}.pdf`, contentType: 'application/pdf', contentBase64: pdf.toString('base64'),
  } });
  const dir = path.join(library.dataRoot, 'operations/cloudparse', paperId, batchId);
  await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'result.jsonl'), raw);
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({ schemaVersion: 1, paperId, batchId,
    provider: 'baidu', model: 'PaddleOCR-VL-1.6',
    options: { useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false },
    pdfSha256: digest(pdf), rawSha256: digest(raw), state: 'downloaded', jobId: 'offline-fixture',
    failureCode: null, updatedAt: new Date().toISOString(), resultReady: false,
  }));
  const { taskId } = await native('bridge_start', { kind: 'cloudparse.map@1', input: { paperId, batchId } });
  const task = await terminal(taskId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
}
async function start(paperId, batchId) {
  const { taskId } = await native('bridge_start', { kind: 'cloudassets.prepare@1', input: { paperId, batchId } });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const plan = await bridge('cloudassets.plan@1', { taskId });
    if (plan.state === 'ready' || plan.state === 'succeeded') return { taskId, plan };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Visual plan did not become ready');
}
// Hooks only observe lifecycle or stop rendering; every PDF render and native upload remains real.
async function render(taskId, mode = 'complete') {
  return page.evaluate(async ({ taskId, mode }) => {
    const { createBridge, trackTask } = await import('/bridge.js');
    const { prepareCloudPdfAssets } = await import('/js/cloud-pdf-assets.js');
    const real = createBridge(window.__TAURI__), controller = new AbortController();
    const stats = { canvases: 0, maxCanvases: 0, reset: 0, destroyed: 0, pageCleanup: 0, uploads: [], renders: 0 };
    window.u5Render = { stats, mode, controller };
    const bridge = { ...real, invoke: async (command, input) => {
      const value = await real.invoke(command, input);
      if (command === 'cloudassets.put@1') {
        stats.uploads.push(input.attachmentId);
        if (mode === 'disconnect' && stats.uploads.length === 1) {
          window.u5Render.paused = true;
          await new Promise(() => {});
        }
      }
      return value;
    } };
    const tracked = trackTask(real, taskId, { signal: controller.signal });
    try {
      await prepareCloudPdfAssets(bridge, taskId, { signal: controller.signal,
        createCanvas: () => {
          const canvas = document.createElement('canvas'); stats.canvases++; stats.maxCanvases = Math.max(stats.maxCanvases, stats.canvases);
          const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
          Object.defineProperty(canvas, 'width', { get: () => width.get.call(canvas), set: value => {
            width.set.call(canvas, value); if (value === 0) { stats.canvases--; stats.reset++; }
          } });
          return canvas;
        },
        openPdf: async data => {
          const doc = await window.pdfjsLib.getDocument({ data }).promise;
          const get = doc.getPage.bind(doc), destroy = doc.destroy.bind(doc);
          doc.destroy = async () => { await destroy(); stats.destroyed++; };
          doc.getPage = async number => {
            const original = await get(number), render = original.render.bind(original), cleanup = original.cleanup.bind(original);
            original.cleanup = () => { stats.pageCleanup++; return cleanup(); };
            original.render = options => {
              const task = render(options); stats.renders++;
              if (mode === 'cancel' && stats.uploads.length === 1) queueMicrotask(() => controller.abort());
              return task;
            };
            return original;
          };
          return doc;
        },
      });
    } catch (error) {
      if (mode !== 'cancel' || !controller.signal.aborted) throw error;
      stats.cancelError = error.name;
    }
    const outcome = await tracked;
    return { stats, outcome };
  }, { taskId, mode });
}
async function validate(paperId, parentBatchId, plan, result) {
  assert.equal(result.visualReady, true); assert.notEqual(result.batchId, parentBatchId);
  await assert.rejects(bridge('files.getAttachment@1', { paperId, attachmentId: 'blockmodel.json' }));
  const validated = await page.evaluate(async ({ paperId, batchId, resources }) => {
    const { createBridge } = await import('/bridge.js'); const bridge = createBridge(window.__TAURI__);
    const { snapshot } = await bridge.invoke('parsebatch.pin@1', { paperId, batchId });
    const read = id => bridge.invoke('parsebatch.read@1', { snapshot, attachmentId: id });
    const decode = value => JSON.parse(atob(value.contentBase64));
    const assets = decode(await read('visual-assets.json'));
    const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    const { loadBatchModel } = await import('/js/pdf-evidence.js');
    const { sectionFigures } = await import('/js/content.js');
    const { assembleQaContext } = await import('/js/qa.js');
    const mapped = await loadBatchModel(bridge, paperId, { snapshot, recoverSource: false });
    if (stable(mapped.visualAssets) !== stable(assets)) throw new Error('Native visual manifest did not reach model consumer');
    for (const asset of assets.assets) {
      const gallery = sectionFigures(mapped, asset.secId);
      if (!gallery.some(item => item.id === asset.id && stable(item.resources) === stable(asset.resources))) throw new Error('Gallery lost visual resources');
      const qa = assembleQaContext({ mapped, title: mapped.title, products: [{ kind: 'map', partId: '', body: { problem: { text: 'Offline test map', refs: [] }, method: { text: 'Offline test', refs: [] } } }], history: [], question: 'Explain',
        binding: { bindingKind: 'fragment', fragmentText: 'selected', cite: { startSecId: asset.secId, startBlock: asset.blockId, endSecId: asset.secId, endBlock: asset.blockId } } });
      if (JSON.stringify(qa.cropAssetIds) !== JSON.stringify([...new Set(asset.resources.map(r => r.attachmentId))])) throw new Error('QA lost visual resources');
    }
    const pixels = [];
    for (const resource of resources) {
      const saved = await read(resource.attachmentId);
      const blob = await (await fetch(`data:image/png;base64,${saved.contentBase64}`)).blob();
      const image = await createImageBitmap(blob), canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, image.width, image.height).data;
      let ink = 0; for (let i = 0; i < rgba.length; i += 4) if (rgba[i] < 220 || rgba[i + 1] < 220 || rgba[i + 2] < 220) ink++;
      pixels.push({ id: resource.attachmentId, width: image.width, height: image.height, ink });
      image.close(); canvas.width = canvas.height = 0;
    }
    return { assets, pixels, batchId: snapshot.manifest.batchId };
  }, { paperId, batchId: result.batchId, resources: plan.resources });
  for (let i = 0; i < plan.resources.length; i++) {
    const actual = validated.pixels[i], expected = plan.resources[i];
    assert.equal(actual.width, expected.width, actual.id); assert.equal(actual.height, expected.height, actual.id);
    // Some tiny provider formula boxes contain whitespace; complete page images must show source ink.
    if (expected.bbox === null) assert.ok(actual.ink > 100, actual.id);
  }
  assert.equal(validated.batchId, result.batchId);
  assert.equal(validated.assets.batchId, result.batchId);
  return validated;
}
function geometryFixture() {
  const stream = '0 0 0 rg 50 70 400 4 re f 50 120 400 4 re f 50 170 400 4 re f\nBT /F1 22 Tf 50 220 Td (ROTATED CROP TABLE) Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1100 400] /CropBox [20 30 1080 370] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1100 400] /CropBox [20 30 1080 370] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let pdf = '%PDF-1.4\n', offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pages = [{ width: 680, height: 2120 }, { width: 2120, height: 680 }];
  const raw = JSON.stringify({ result: { dataInfo: { numPages: 2, pages, type: 'pdf' }, layoutParsingResults: pages.map(size => ({
    prunedResult: { ...size, model_settings: { use_doc_preprocessor: false, merge_layout_blocks: true }, parsing_res_list: [{
      block_label: 'table', block_content: '<table><tr><td>Rotated CropBox</td></tr></table>',
      block_bbox: [100, 100, 500, 500], block_id: 0, block_order: 0, group_id: 0,
    }] },
  })) } });
  return { pdf: Buffer.from(pdf), raw: Buffer.from(raw) };
}
try {
  executable = await buildHost({ config, output });
  await launch();
  if (!readerReport) {
    await check('isolated native library has no full local component', async () => {
      report.component = await native('component_status');
      assert.equal(report.component.ready, false, JSON.stringify(report.component));
      assert.equal(report.component.installedVersion, '');
      assert.ok((await bridge('app.info@1')).taskKinds.includes('cloudassets.prepare@1'));
    });
    let pageCount = 0, multiRegions = 0; const kinds = new Set();
    for (const [index, id] of ['1412.6980', '1503.02531', '1512.03385', '1603.02754'].entries()) {
      const paperId = `u5-${id}`, batchId = `u4-${id}`;
      const pdf = await readFile(path.join(app, `src-tauri/tests/fixtures/regression/corpus/${id}.pdf`));
      let raw, source = path.resolve(app, `../tmp/aistudio-pilot-20261006/${id}/result.jsonl`);
      try { raw = await readFile(source); } catch { source = path.join(app, `src-tauri/tests/fixtures/aistudio/${id}.jsonl`); raw = await readFile(source); }
      report.sources.push({ id, source, pdfSha256: digest(pdf), rawSha256: digest(raw) });
      await seed(paperId, batchId, pdf, raw);
      let current = await start(paperId, batchId), staged = [];
      if (index === 0) await check('cancel during actual PDF render preserves one verified upload for resume', async () => {
        const cancelled = await render(current.taskId, 'cancel');
        assert.equal(cancelled.outcome.status, 'cancelled'); assert.equal(cancelled.stats.uploads.length, 1);
        assert.equal(cancelled.stats.destroyed, 1); assert.equal(cancelled.stats.canvases, 0);
        staged = cancelled.stats.uploads; report.cancellation = cancelled;
        current = await start(paperId, batchId);
        assert.deepEqual(current.plan.completedAttachmentIds, staged);
      });
      if (index === 1) await check('native window process interruption and restart recover persisted staged PNG', async () => {
        const interrupted = render(current.taskId, 'disconnect').catch(() => {});
        await page.waitForFunction(() => window.u5Render?.paused);
        staged = await page.evaluate(() => window.u5Render.stats.uploads);
        assert.equal(staged.length, 1);
        await stop(); await interrupted; await launch();
        current = await start(paperId, batchId);
        assert.deepEqual(current.plan.completedAttachmentIds, staged);
        report.restart = { staged, outputBatchId: current.plan.outputBatchId };
      });
      await check(`${id}: offline native PNG preparation and immutable new candidate`, async () => {
        const complete = await render(current.taskId);
        assert.equal(complete.outcome.status, 'succeeded', JSON.stringify(complete.outcome.error));
        assert.equal(complete.stats.maxCanvases, 1); assert.equal(complete.stats.canvases, 0);
        assert.equal(complete.stats.reset, complete.stats.uploads.length); assert.equal(complete.stats.destroyed, 1);
        assert.ok(complete.stats.pageCleanup > 0);
        for (const id of staged) assert.ok(!complete.stats.uploads.includes(id), 'resumed ID must not rerender');
        const validated = await validate(paperId, batchId, current.plan, complete.outcome.result);
        pageCount += validated.assets.pages.length;
        for (const asset of validated.assets.assets) {
          assert.ok(asset.resources.length > 0);
          if (asset.resources.some(resource => validated.pixels.find(image => image.id === resource.attachmentId)?.ink > 10)) kinds.add(asset.kind);
          if (asset.resources.length > 1) multiRegions++;
        }
        report.papers.push({ paperId, parentBatchId: batchId, batchId: complete.outcome.result.batchId,
          stats: complete.stats, memory: await memorySnapshot(), assets: validated.assets, pixels: validated.pixels });
      });
    }
    await check('four complete PDF documents cover 49 pages, formulas tables figures and multiple regions', async () => {
      assert.equal(pageCount, 49); for (const kind of ['figure', 'table', 'formula']) assert.ok(kinds.has(kind));
      assert.ok(multiRegions > 0); report.coverage = { pageCount, kinds: [...kinds], multiRegions };
    });
    await check('rotated and CropBox PDF tables use complete page evidence without fabricated crop', async () => {
      const { pdf, raw } = geometryFixture(); await seed('u5-geometry', 'u4-geometry', pdf, raw);
      const current = await start('u5-geometry', 'u4-geometry'), complete = await render(current.taskId);
      assert.equal(complete.outcome.status, 'succeeded', JSON.stringify(complete.outcome.error));
      const validated = await validate('u5-geometry', 'u4-geometry', current.plan, complete.outcome.result);
      assert.ok(validated.assets.assets.length >= 2);
      assert.ok(validated.assets.assets.every(asset => asset.resources.every(resource => resource.bbox === null && resource.evidence === 'page')));
      report.geometry = validated;
    });
  }
  if (process.env.PAPER30MIN_U6 === '1') {
    if (!readerReport) {
      await check('publish complete candidate then reject incomplete replacement and retain old snapshot', async () => {
        const first = report.papers[0];
        const { paper } = await bridge('parsebatch.publish@1', { paperId: first.paperId, batchId: first.batchId, expectedBatchId: null });
        assert.equal(paper.parseBatchId, first.batchId);
        paper.products = [{ kind: 'map', partId: '', body: { problem: { text: 'OLD MAP', refs: [] }, method: { text: 'OLD METHOD', refs: [] } }, updatedAt: new Date().toISOString() }];
        const image = await bridge('parsebatch.read@1', { snapshot: (await bridge('parsebatch.pin@1', { paperId: first.paperId })).snapshot, attachmentId: first.assets.pages[0].attachmentId });
        await bridge('files.putAttachment@1', { paperId: first.paperId, attachment: { id: 'pdf-selection-history', name: 'selection.png', contentType: 'image/png', contentBase64: image.contentBase64 } });
        await bridge('files.putAttachment@1', { paperId: first.paperId, attachment: { id: 'recall-history', name: 'recall.png', contentType: 'image/png', contentBase64: image.contentBase64 } });
        paper.recallCard = { markdown: 'OLD RECALL', images: [{ id: 'old-recall-image', name: 'recall.png', attachmentId: 'recall-history' }] };
        paper.chat = [{ role: 'user', content: 'OLD SELECTED TEXT', createdAt: new Date().toISOString(), bindingKind: 'pdf', assetIds: [], pdfSelection: { kind: 'area', text: 'OLD SELECTED TEXT', regions: [{ page: 1, bbox: [0, 0, 100, 100], pageSize: [612, 792] }], images: [{ attachmentId: 'pdf-selection-history' }], hits: [] } }];
        await bridge('library.putPaper@1', { paper, expectedBatchId: first.batchId });
        const pinned = (await bridge('parsebatch.pin@1', { paperId: first.paperId })).snapshot;
        const model = await bridge('parsebatch.read@1', { snapshot: pinned, attachmentId: 'blockmodel.json' });
        const pdf = await readFile(path.join(app, 'src-tauri/tests/fixtures/regression/corpus/1412.6980.pdf'));
        const raw = await readFile(report.sources[0].source);
        await seed(first.paperId, 'u6-reparse', pdf, raw);
        await assert.rejects(bridge('parsebatch.publish@1', { paperId: first.paperId, batchId: 'u6-reparse', expectedBatchId: first.batchId, overwriteConfirmed: true }));
        assert.equal((await bridge('library.getPaper@1', { paperId: first.paperId })).paper.parseBatchId, first.batchId);
        const preparing = await start(first.paperId, 'u6-reparse');
        const complete = await render(preparing.taskId);
        assert.equal(complete.outcome.status, 'succeeded', JSON.stringify(complete.outcome.error));
        const next = complete.outcome.result.batchId;
        await expectNativeError('parsebatch.publish@1', { paperId: first.paperId, batchId: next, expectedBatchId: first.batchId }, 'parse_replace_confirmation_required');
        const published = (await bridge('parsebatch.publish@1', { paperId: first.paperId, batchId: next, expectedBatchId: first.batchId, overwriteConfirmed: true })).paper;
        assert.equal(published.parseBatchId, next); assert.equal(published.products.length, 0);
        assert.equal(published.parseHistory.length, 1);
        assert.equal(published.parseHistory[0].paper.products[0].body.problem.text, 'OLD MAP');
        assert.equal(published.parseHistory[0].paper.chat[0].content, 'OLD SELECTED TEXT');
        await expectNativeError('library.putPaper@1', { paper, expectedBatchId: first.batchId }, 'parse_batch_stale');
        assert.equal((await bridge('parsebatch.read@1', { snapshot: pinned, attachmentId: 'blockmodel.json' })).contentBase64, model.contentBase64);
        await bridge('files.cleanupPdfSelections@1', { paperId: first.paperId, attachmentIds: ['pdf-selection-history'] });
        assert.ok((await bridge('files.getAttachment@1', { paperId: first.paperId, attachmentId: 'pdf-selection-history' })).attachment);
        report.publication = { paperId: first.paperId, oldBatchId: first.batchId, batchId: next };
      });
      await check('restart retains current and historical pointer with complete export/import dependencies', async () => {
        await stop(); await launch();
        const id = report.publication.paperId;
        const { paper } = await bridge('library.getPaper@1', { paperId: id });
        assert.equal(paper.parseBatchId, report.publication.batchId); assert.equal(paper.parseHistory.length, 1);
        const parseBatchExport = await bridge('parsebatch.export@1', { paperId: id });
        assert.equal(parseBatchExport.batches.length, 2);
        const exportFile = path.join(output, 'library-v2.json');
        const selectionMeta = await bridge('files.getAttachment@1', { paperId: id, attachmentId: 'pdf-selection-history' });
        const selection = await bridge('files.readRange@1', { paperId: id, attachmentId: 'pdf-selection-history', offset: 0, length: selectionMeta.attachment.size });
        await writeFile(exportFile, JSON.stringify({ format: 'paper-30min-library', version: 2, papers: [{ ...paper, parseBatchExport, selectionAttachments: [{ id: 'pdf-selection-history', name: 'selection.png', contentType: 'image/png', sha256: selectionMeta.attachment.sha256, size: selectionMeta.attachment.size, contentBase64: selection.contentBase64 }], recallAttachments: [{ id: 'recall-history', name: 'recall.png', contentType: 'image/png', sha256: selectionMeta.attachment.sha256, size: selectionMeta.attachment.size, contentBase64: selection.contentBase64 }] }] }));
        await bridge('library.deletePaper@1', { paperId: id });
        const inspected = await bridge('migration.inspect@1', { sourcePath: exportFile });
        assert.equal(inspected.errors.length, 0, JSON.stringify(inspected));
        await bridge('migration.commit@1', { token: inspected.token });
        const imported = (await bridge('library.getPaper@1', { paperId: id })).paper;
        assert.equal(imported.parseHistory[0].paper.chat[0].content, 'OLD SELECTED TEXT');
        assert.equal((await bridge('files.getAttachment@1', { paperId: id, attachmentId: 'recall-history' })).attachment.sha256, selectionMeta.attachment.sha256);
        for (const batchId of [imported.parseBatchId, imported.parseHistory[0].batchId]) {
          const { snapshot } = await bridge('parsebatch.pin@1', { paperId: id, batchId });
          await bridge('parsebatch.read@1', { snapshot, attachmentId: 'pdf' });
          await bridge('parsebatch.read@1', { snapshot, attachmentId: 'blockmodel.json' });
          await bridge('cloudassets.manifest@1', { snapshot });
        }
      });
    }
    await check('reader groups reparse with rebuild and has no parser selector or history navigation', async () => {
      await page.reload();
      await page.locator('#su-enter').click();
      await page.locator('#nav-library').click();
      await page.locator('.paper-card').filter({ hasText: report.publication.paperId }).click();
      await page.waitForFunction(id => document.querySelector('#reader-title').textContent === id, report.publication.paperId);
      for (const selector of ['#parse-version-select', '#btn-parse-history', '#reader-history-status', '#modal-parser-choice']) {
        assert.equal(await page.locator(selector).count(), 0);
      }
      await page.locator('#btn-rebuild-map').waitFor();
      assert.equal(await page.locator('.reader-head .reader-rebuild-actions #btn-reparse').count(), 1);
      assert.equal(await page.locator('.reader-head .reader-rebuild-actions #btn-rebuild-map').count(), 1);
      await page.waitForFunction(() => !document.querySelector('#pdf-viewer').hidden
        && document.querySelector('#pdf-pages canvas')?.width > 0);
      const session = await browser.contexts()[0].newCDPSession(page);
      for (const width of [1280, 430]) {
        await session.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await page.evaluate(() => window.scrollTo(0, 0));
        const reparse = await page.locator('#btn-reparse').boundingBox();
        const rebuild = await page.locator('#btn-rebuild-map').boundingBox();
        if (reparse && rebuild) assert.ok(Math.abs(reparse.y - rebuild.y) < 2);
        await page.screenshot({ path: path.join(output, `reader-actions-${width}.png`) });
      }
      await session.send('Emulation.clearDeviceMetricsOverride');
      await page.locator('#reader-tabs [data-tab="recall"]').click();
      const notes = `CURRENT NOTES ${Date.now()}`;
      await page.locator('#recall-editor').fill(notes);
      await page.locator('#btn-recall-save').click();
      await page.waitForFunction(async ({ paperId, notes }) => {
        const { createBridge } = await import('/bridge.js');
        const { paper } = await createBridge(window.__TAURI__).invoke('library.getPaper@1', { paperId });
        return paper.recallCard.markdown === notes;
      }, { paperId: report.publication.paperId, notes });
    });
    await check('completed cloud results have no extra verification or provider-switch card', async () => {
      await page.locator('#nav-tasks').click();
      await page.waitForFunction(() => document.querySelector('#view-tasks').hidden === false);
      await page.waitForFunction(() => document.querySelector('#tasks-empty').hidden === false);
      assert.equal(await page.locator('#task-list .task-row').count(), 0);
      for (const label of ['校验正文与来源', '校验视觉资源', '改用本地']) {
        assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0);
      }
      await page.screenshot({ path: path.join(output, 'tasks-completed.png') });
      await page.locator('#nav-reader').click();
    });
    await check('settings gate unavailable providers and reparse follows the saved provider while failure preserves current results', async () => {
      const originalSettings = (await bridge('settings.get@1')).cloudparse;
      const originalPaper = (await bridge('library.getPaper@1', { paperId: report.publication.paperId })).paper;
      await page.evaluate(() => {
        window.reparseFixture = { localReady: false, starts: [] };
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, options) => {
          const command = decodeURIComponent(String(input));
          const reply = (value, status = 'ok') => Promise.resolve(new Response(JSON.stringify(value), {
            headers: { 'Content-Type': 'application/json', 'Tauri-Response': status },
          }));
          if (command.includes('component_status')) return reply({ ready: window.reparseFixture.localReady, phase: 'idle' });
          if (command.includes('plugin:dialog|message')) return reply('Ok');
          if (command.includes('bridge_invoke')) {
            const args = JSON.parse(options.body);
            if (args.command === 'pdfparse.status@1') return reply({ sidecar: { ready: window.reparseFixture.localReady } });
          }
          if (command.includes('bridge_start')) {
            const args = JSON.parse(options.body);
            if (['pdfparse.convert@1', 'cloudparse.parse@1'].includes(args.kind)) {
              window.reparseFixture.starts.push(args);
              return reply({ code: 'fixture_stop', message: 'offline routing check', retryable: false }, 'error');
            }
          }
          return originalFetch(input, options);
        };
      });
      await bridge('settings.putCloudparse@1', { settings: { accessToken: '', uploadConfirmed: false } });
      await page.locator('#btn-settings').click();
      await page.locator('#settings-tab-service').click();
      await page.waitForFunction(() => document.querySelector('[data-parser-provider="local"]').disabled
        && document.querySelector('[data-parser-provider="baidu"]').disabled);
      assert.equal(await page.locator('#open-parser-settings').isEnabled(), true);
      assert.equal(await page.locator('#open-cloud-settings').isEnabled(), true);
      await page.locator('#modal-settings [data-close]').click();
      await page.evaluate(() => { window.reparseFixture.localReady = true; });
      await page.locator('#btn-settings').click();
      await page.locator('#settings-tab-service').click();
      await page.locator('[data-parser-provider="local"]').click();
      await page.waitForFunction(async () => {
        const { createBridge } = await import('/bridge.js');
        return (await createBridge(window.__TAURI__).invoke('settings.get@1')).cloudparse.defaultProvider === 'local';
      });
      await page.locator('#modal-settings [data-close]').click();
      await page.locator('#reader-tabs [data-tab="map"]').click();
      await page.locator('#btn-reparse').click();
      await page.waitForFunction(() => window.reparseFixture.starts.length === 1);
      const local = await page.evaluate(() => window.reparseFixture.starts[0]);
      assert.equal(local.kind, 'pdfparse.convert@1');
      assert.equal(local.input.expectedBatchId, originalPaper.parseBatchId);
      assert.equal(local.input.overwriteConfirmed, true);
      await page.waitForFunction(() => !document.querySelector('#btn-reparse').disabled);
      assert.equal((await bridge('library.getPaper@1', { paperId: originalPaper.id })).paper.parseBatchId, originalPaper.parseBatchId);
      await bridge('settings.putCloudparse@1', { settings: { defaultProvider: 'baidu', accessToken: 'offline-fixture', uploadConfirmed: true } });
      await page.locator('#btn-reparse').click();
      await page.waitForFunction(() => window.reparseFixture.starts.length === 2);
      const cloud = await page.evaluate(() => window.reparseFixture.starts[1]);
      assert.equal(cloud.kind, 'cloudparse.parse@1');
      assert.equal(cloud.input.expectedBatchId, originalPaper.parseBatchId);
      assert.equal(cloud.input.overwriteConfirmed, true);
      await page.waitForFunction(() => !document.querySelector('#btn-reparse').disabled);
      assert.equal((await bridge('library.getPaper@1', { paperId: originalPaper.id })).paper.parseBatchId, originalPaper.parseBatchId);
      await bridge('settings.putCloudparse@1', { settings: originalSettings });
      report.reparseSubstitutions = 'Component availability, confirmation and task starts substituted for offline routing checks; settings and current paper persistence use the native bridge. No vendor upload or actual local conversion.';
    });
  }
  await check('saved source page and original figure table formula PNGs display offline at wide and narrow widths', async () => {
    await page.evaluate(async papers => {
      const { createBridge } = await import('/bridge.js'); const bridge = createBridge(window.__TAURI__);
      const root = document.createElement('main'); root.id = 'u5-offline-preview';
      root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto;padding:16px;box-sizing:border-box;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px;align-content:start;';
      document.body.append(root);
      for (const kind of ['page', 'figure', 'table', 'formula']) {
        const hasInk = (paper, resource) => paper.pixels.find(image => image.id === resource.attachmentId)?.ink > 10;
        const paper = kind === 'page' ? papers[0] : papers.find(paper => paper.assets.assets.some(asset => asset.kind === kind && asset.resources.some(resource => hasInk(paper, resource))));
        const resource = kind === 'page' ? paper.assets.pages[0] : paper.assets.assets.find(asset => asset.kind === kind && asset.resources.some(resource => hasInk(paper, resource))).resources.find(resource => hasInk(paper, resource));
        const { snapshot } = await bridge.invoke('parsebatch.pin@1', { paperId: paper.paperId, batchId: paper.batchId });
        const saved = await bridge.invoke('parsebatch.read@1', { snapshot, attachmentId: resource.attachmentId });
        const figure = document.createElement('figure'); figure.style.cssText = 'margin:0;min-width:0;';
        const caption = document.createElement('figcaption'); caption.textContent = `${kind} · ${paper.paperId} · p${resource.page}`;
        const img = document.createElement('img'); img.src = `data:image/png;base64,${saved.contentBase64}`;
        img.style.cssText = 'display:block;max-width:100%;height:auto;'; await img.decode();
        figure.append(caption, img); root.append(figure);
      }
    }, report.papers);
    const session = await browser.contexts()[0].newCDPSession(page);
    for (const width of [1280, 430]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await page.locator('#u5-offline-preview img').count(), 4);
      const bounds = await page.locator('#u5-offline-preview').evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth }));
      assert.ok(bounds.scroll <= bounds.width);
      await page.screenshot({ path: path.join(output, `offline-assets-${width}.png`) });
    }
    await session.send('Emulation.clearDeviceMetricsOverride');
  });
  assert.deepEqual(report.errors, []);
  report.substitutions = 'Vendor jobs are seeded from stored offline JSONL, not submitted. Geometry PDF and supplier table response are synthetic. Lifecycle hooks observe production PDF.js; cancellation and process interruption are injected. Preview DOM displays real saved PNGs. U6 checks use native publication, migration and the production reader with settings-only parser selection and no history/reparse UI. CI not run.';
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack || String(error); process.exitCode = 1; console.error(error);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await stop(); await closeServers(server);
  await restoreLibraryBuild();
  console.log(`Report: ${output}`);
}
