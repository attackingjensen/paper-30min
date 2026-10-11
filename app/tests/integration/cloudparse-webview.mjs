import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertWindowsHost, appDir as app, listen, createUiServer, claimDebugPort, tauriConfig,
  buildHost, launchWebView, stopWebView, closeServers, restoreLibraryBuild } from './webview-host.mjs';

assertWindowsHost();
const identifier = `com.paper30min.cloudparse-webview-${Date.now()}`;
const output = path.resolve(app, '../tmp', identifier);
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [] };
const server = createUiServer();
const url = `http://127.0.0.1:${await listen(server)}`;
const debugPort = await claimDebugPort();
const config = tauriConfig({ identifier, url, title: 'Paper30Min cloud parse integration' });
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
async function check(name, fn) { await fn(); report.checks.push(name); console.log(`PASS ${name}`); }
try {
  const executable = await buildHost({ config, output });
  ({ child, browser, page } = await launchWebView({ executable, cwd: output, debugPort,
    onPageError: error => report.errors.push(error.message) }));
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
    assert.equal(await page.locator('[data-parser-provider="local"]').isDisabled(), true);
    assert.equal(await page.locator('[data-parser-provider="baidu"]').isDisabled(), true);
    const previousProvider = (await bridge('settings.get@1')).cloudparse.defaultProvider;
    await page.locator('#open-cloud-settings').click();
    assert.equal((await bridge('settings.get@1')).cloudparse.defaultProvider, previousProvider, 'arrow opens settings without selecting cloud');
    await page.locator('#set-cloud-token').fill('fixture-cloud-token');
    await page.locator('#set-cloud-consent').check();
    await page.locator('#btn-save-cloud-settings').click();
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
  await check('PDF, sample and arXiv use settings and missing consent preserves library', async () => {
    const existing = (await bridge('library.listPapers@1')).papers;
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
      await page.locator('#settings-detail-cloud').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#modal-parser-choice').count(), 0);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      assert.deepEqual((await bridge('library.listPapers@1')).papers, existing);
    }
    await page.keyboard.press('Escape');
  });
  await check('accepted recovery survives reload with jobId and no credential in native status', async () => {
    await bridge('library.putPaper@1', { paper: { id: 'recovery-paper', title: 'Recovery fixture' } });
    await bridge('library.putPaper@1', { paper: { id: 'mapped-fixture', title: 'Mapped fixture', products: [{
      kind: 'map', partId: '', body: { problem: { text: 'Fixture map', refs: [] } }, updatedAt: new Date().toISOString(),
    }] } });
    await bridge('files.putAttachment@1', { paperId: 'mapped-fixture', attachment: {
      id: 'blockmodel.json', name: 'blockmodel.json', contentType: 'application/json',
      contentBase64: Buffer.from(JSON.stringify({ sections: [] })).toString('base64'),
    } });
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
      failureCode: 'cloud_network_error', updatedAt: new Date().toISOString(),
    }));
    await page.reload();
    await page.locator('#su-enter').click();
    await page.locator('#startup-view').waitFor({ state: 'hidden' });
    await page.locator('#nav-tasks').click();
    await page.getByRole('button', { name: '恢复查询 / 取回', exact: true }).waitFor();
    const status = await bridge('cloudparse.status@1');
    assert.equal(status.jobs[0].jobId, 'fixture-job');
    assert.equal(status.jobs[0].resultReady, undefined);
    assert.ok(!JSON.stringify(status).includes('fixture-token'));
    // Missing consent routes to settings before any task or network request.
    await page.getByRole('button', { name: '恢复查询 / 取回', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => node.textContent.includes('确认上传与费用')));
    await page.locator('#close-service-detail').click();
    await page.locator('#modal-settings [data-close]').click();
    assert.deepEqual((await bridge('tasks.list@1')).tasks, []);
    await page.screenshot({ path: path.join(output, 'cloudparse-recovery.png') });
  });
  report.substitutions = 'Dialog responses, outbound arXiv/cloud task starts and one injected settings-read error are substituted; successful library/settings/attachment handlers remain real. Native dialog display and vendor acceptance unverified.';
  await page.evaluate(() => {
    window.cloudFixture = { starts: [], confirmations: [], decision: 'Cancel' };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const command = decodeURIComponent(String(input));
      const reply = (value, status = 'ok') => Promise.resolve(new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': status },
      }));
      if (command.includes('plugin:dialog|message')) {
        window.cloudFixture.confirmations.push(JSON.parse(options.body));
        return reply(window.cloudFixture.decision);
      }
      if (command.includes('bridge_start')) {
        const args = JSON.parse(options.body);
        if (['files.download@1', 'cloudparse.parse@1'].includes(args.kind)) {
          window.cloudFixture.starts.push(args);
          return reply({ code: 'fixture_network_stop', message: 'fixture network stop', retryable: false }, 'error');
        }
      }
      if (command.includes('bridge_invoke') && window.cloudFixture.delayAttachment) {
        const args = JSON.parse(options.body);
        if (args.command === 'files.putAttachment@1' && args.input.attachment?.id === 'pdf') {
          window.cloudFixture.attachmentWaiting = true;
          return new Promise(resolve => { window.cloudFixture.releaseAttachment = resolve; })
            .then(() => originalFetch(input, options));
        }
      }
      if (command.includes('bridge_invoke') && window.cloudFixture.delaySettings) {
        const args = JSON.parse(options.body);
        if (args.command === 'settings.get@1') {
          const reject = window.cloudFixture.rejectSettings === true;
          window.cloudFixture.settingsWaiting = true;
          window.cloudFixture.settingsCalls = (window.cloudFixture.settingsCalls || 0) + 1;
          return new Promise(resolve => { window.cloudFixture.releaseSettings = resolve; })
            .then(() => reject
              ? reply({ code: 'fixture_settings_error', message: 'fixture settings error', retryable: false }, 'error')
              : originalFetch(input, options))
            .then(response => { window.cloudFixture.settingsReturned = true; return response; });
        }
      }
      return originalFetch(input, options);
    };
  });
  await check('cloud arXiv failed download then manual PDF attachment starts first cloud task', async () => {
    await bridge('settings.putCloudparse@1', { settings: { accessToken: 'fixture-token', uploadConfirmed: true } });
    await page.locator('#nav-library').click();
    await page.locator('#btn-arxiv').click();
    await page.locator('#arxiv-input').fill('1706.03762');
    await page.locator('#btn-arxiv-import').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => node.textContent.includes('PDF 下载未完成')));
    const paper = (await bridge('library.listPapers@1')).papers.find(paper => paper.arxivId === '1706.03762');
    assert.ok(paper);
    assert.equal((await bridge('cloudparse.status@1', { paperId: paper.id })).jobs.length, 0);
    await page.locator('#pdf-attach-input').setInputFiles(path.join(app, 'ui/samples/sample_paper.pdf'));
    await page.waitForFunction(paperId => window.cloudFixture.starts.some(call => call.kind === 'cloudparse.parse@1' && call.input.paperId === paperId), paper.id);
    const calls = (await page.evaluate(() => window.cloudFixture.starts)).filter(call => call.kind === 'cloudparse.parse@1' && call.input.paperId === paper.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.action, 'submit');
    assert.equal(calls[0].input.resubmitConfirmed, undefined);
    assert.ok((await bridge('files.listAttachments@1', { paperId: paper.id })).attachments.some(attachment => attachment.id === 'pdf'));
  });
  await check('finishing PDF attachment after switching papers preserves the current mapped QA', async () => {
    await page.evaluate(() => {
      document.querySelectorAll('.toast').forEach(node => node.remove());
      window.cloudFixture.delayAttachment = true;
    });
    await page.locator('#pdf-attach-input').setInputFiles(path.join(app, 'ui/samples/sample_paper.pdf'));
    await page.waitForFunction(() => window.cloudFixture.attachmentWaiting === true);
    await page.locator('#nav-library').click();
    await page.locator('.paper-card').filter({ hasText: 'Mapped fixture' }).click();
    await page.locator('#reader-tabs [data-tab="chat"]').click();
    await page.waitForFunction(() => !document.querySelector('#chat-input').disabled);
    await page.evaluate(() => {
      window.cloudFixture.delayAttachment = false;
      window.cloudFixture.releaseAttachment();
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => node.textContent.includes('PDF 已关联')));
    await page.locator('#reader-tabs [data-tab="map"]').click();
    await page.locator('#reader-tabs [data-tab="chat"]').click();
    assert.equal(await page.locator('#reader-title').textContent(), 'Mapped fixture');
    assert.equal(await page.locator('#chat-input').isEnabled(), true);
  });
  await check('settings read failure stops import and allows a later retry', async () => {
    await page.locator('#nav-library').click();
    const before = (await bridge('library.listPapers@1')).papers.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.evaluate(() => {
        document.querySelectorAll('.toast').forEach(node => node.remove());
        Object.assign(window.cloudFixture, { delaySettings: true, settingsWaiting: false, settingsReturned: false, rejectSettings: true });
      });
      await page.locator('#btn-sample').click();
      await page.waitForFunction(() => window.cloudFixture.settingsWaiting === true);
      await page.evaluate(() => { window.cloudFixture.delaySettings = false; });
      await page.evaluate(() => window.cloudFixture.releaseSettings());
      await page.waitForFunction(() => window.cloudFixture.settingsReturned === true);
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(node => node.textContent.includes('解析设置读取失败')));
      assert.equal((await bridge('library.listPapers@1')).papers.length, before);
    }
  });
  await check('concurrent import entry while settings load starts only one import', async () => {
    const before = await page.evaluate(() => window.cloudFixture.settingsCalls || 0);
    const startsBefore = await page.evaluate(() => window.cloudFixture.starts.length);
    await page.evaluate(() => {
      Object.assign(window.cloudFixture, { delaySettings: true, rejectSettings: false, settingsWaiting: false });
    });
    await page.locator('#btn-sample').click();
    await page.waitForFunction(() => window.cloudFixture.settingsWaiting === true);
    await page.locator('#file-input').setInputFiles(path.join(app, 'ui/samples/sample_paper.pdf'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.cloudFixture.settingsCalls), before + 1);
    await page.evaluate(() => {
      window.cloudFixture.delaySettings = false;
      window.cloudFixture.releaseSettings();
    });
    await page.waitForFunction(count => window.cloudFixture.starts.length === count + 1, startsBefore);
    assert.equal(await page.locator('#modal-parser-choice').count(), 0);
  });
  await check('remote-failed task needs paid resubmit confirmation and cancel sends no task', async () => {
    const dir = path.join(library.dataRoot, 'operations/cloudparse/recovery-paper/cloud-fixture');
    const record = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
    record.state = 'remote-failed'; record.failureCode = 'cloud_remote_failed';
    await writeFile(path.join(dir, 'run.json'), JSON.stringify(record));
    await page.locator('#nav-tasks').click();
    const row = page.locator('.task-row').filter({ hasText: 'Recovery fixture' });
    await row.getByRole('button', { name: '重新提交…', exact: true }).waitFor();
    assert.equal(await row.getByRole('button', { name: '恢复查询 / 取回', exact: true }).count(), 0);
    const before = await page.evaluate(() => window.cloudFixture.starts.length);
    await row.getByRole('button', { name: '重新提交…', exact: true }).click();
    await page.waitForFunction(() => window.cloudFixture.confirmations.length === 1);
    await row.getByRole('button', { name: '重新提交…', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.cloudFixture.starts.length), before);
    assert.match((await page.evaluate(() => window.cloudFixture.confirmations[0])).message, /再次计费/);
    await page.evaluate(() => { window.cloudFixture.decision = 'Ok'; });
    await row.getByRole('button', { name: '重新提交…', exact: true }).click();
    await page.waitForFunction(count => window.cloudFixture.starts.length === count + 1, before);
    const call = await page.evaluate(() => window.cloudFixture.starts.at(-1));
    assert.deepEqual(call, { kind: 'cloudparse.parse@1', input: {
      paperId: 'recovery-paper', action: 'submit', uploadConfirmed: true, batchId: 'cloud-fixture', resubmitConfirmed: true,
    } });
  });
  await check('offline cloud candidate restores native provenance and overlays the original PDF', async () => {
    const paperId = 'u4-native', batchId = 'u4-batch';
    const pdf = await readFile(path.join(app, 'src-tauri/tests/fixtures/regression/corpus/1412.6980.pdf'));
    const raw = await readFile(path.join(app, 'src-tauri/tests/fixtures/aistudio/1412.6980.jsonl'));
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    await bridge('library.putPaper@1', { paper: { id: paperId, title: 'U4 native fixture' } });
    await bridge('files.putAttachment@1', { paperId, attachment: { id: 'pdf', name: 'adam.pdf', contentType: 'application/pdf', contentBase64: pdf.toString('base64') } });
    const jobDir = path.join(library.dataRoot, 'operations/cloudparse', paperId, batchId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, 'result.jsonl'), raw);
    await writeFile(path.join(jobDir, 'run.json'), JSON.stringify({ schemaVersion: 1, paperId, batchId, provider: 'baidu', model: 'PaddleOCR-VL-1.6',
      options: { useDocOrientationClassify: false, useDocUnwarping: false, useChartRecognition: false }, pdfSha256: digest(pdf),
      state: 'downloaded', jobId: 'offline-fixture', rawSha256: digest(raw), failureCode: null, updatedAt: new Date().toISOString() }));
    const started = await native('bridge_start', { kind: 'cloudparse.map@1', input: { paperId, batchId } });
    const deadline = Date.now() + 30000;
    let task;
    do {
      task = (await bridge('tasks.get@1', { taskId: started.taskId })).task;
      if (['succeeded', 'failed', 'cancelled'].includes(task.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
    await assert.rejects(bridge('files.getAttachment@1', { paperId, attachmentId: 'blockmodel.json' }));
    const proof = await page.evaluate(async ({ paperId, batchId }) => {
      const { loadBatchModel, readBatchAttachment, evidenceTarget, evidenceRangeRects } = await import('/js/pdf-evidence.js');
      const { createBridge } = await import('/bridge.js');
      const realBridge = createBridge(window.__TAURI__);
      const mapped = await loadBatchModel(realBridge, paperId, { batchId });
      const section = mapped.sections.find(section => section.blocks.some(block => block.sourceRegions?.length && !block.assetId));
      const block = section.blocks.find(block => block.sourceRegions?.length && !block.assetId);
      const target = evidenceTarget({ kind: 'blocks', secId: section.id, start: block.id, end: block.id }, mapped);
      const pdf = await readBatchAttachment(realBridge, mapped.parseBatch, 'pdf');
      const doc = await window.pdfjsLib.getDocument({ data: Uint8Array.from(atob(pdf.contentBase64), char => char.charCodeAt(0)) }).promise;
      const original = await doc.getPage(target.page), viewport = original.getViewport({ scale: 1 });
      const regions = evidenceRangeRects(target, [{ page: target.page, viewport }]);
      if (!regions.length) throw new Error('No verified source overlay');
      const canvas = document.createElement('canvas'); canvas.id = 'u4-original-proof';
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      canvas.style.cssText = 'position:fixed;inset:0;max-width:100vw;max-height:100vh;width:auto;height:auto;z-index:99999;background:white;';
      document.body.appendChild(canvas);
      const context = canvas.getContext('2d');
      await original.render({ canvasContext: context, viewport }).promise;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 180 && pixels[i + 1] < 180 && pixels[i + 2] < 180) ink++;
      context.strokeStyle = '#1682e8'; context.lineWidth = 1.5;
      for (const rect of regions[0].rects) context.strokeRect(...rect);
      await doc.destroy();
      return { page: target.page, rects: regions[0].rects, ink, batchId: mapped.parseBatch.manifest.batchId };
    }, { paperId, batchId });
    assert.equal(proof.batchId, batchId); assert.ok(proof.ink > 1000);
    report.cloudOverlay = proof;
    const session = await browser.contexts()[0].newCDPSession(page);
    for (const width of [1280, 430]) {
      await session.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.screenshot({ path: path.join(output, `cloud-source-${width}.png`) });
    }
    await session.send('Emulation.clearDeviceMetricsOverride');
    await page.locator('#u4-original-proof').evaluate(node => node.remove());
  });
  assert.deepEqual(report.errors, []);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = error.stack || String(error); process.exitCode = 1; console.error(error);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await stopWebView({ child, browser });
  await closeServers(server);
  await restoreLibraryBuild();
  console.log(`Report: ${output}`);
}
