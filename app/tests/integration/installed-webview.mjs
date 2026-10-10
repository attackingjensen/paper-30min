import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, copyFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { appDir, assertWindowsHost, claimDebugPort, launchWebView, stopWebView } from './webview-host.mjs';
import { parseUpdaterPublicKey, verifyInstallerSignature } from '../../../tools/release_manifest.mjs';

assertWindowsHost();
const root = path.resolve(appDir, '..');
const runId = `installed-${Date.now()}`;
const output = path.join(root, 'tmp', runId);
const readingOnly = Boolean(process.env.PAPER30MIN_READING_REPORT);
const installOnly = process.env.PAPER30MIN_INSTALL_ONLY === '1';
const worktreeNsis = process.env.PAPER30MIN_INSTALLED_NSIS_WORKTREE === '1';
const reusedPath = process.env.PAPER30MIN_READING_REPORT ?? process.env.PAPER30MIN_INSTALLED_ARTIFACTS;
const reused = reusedPath ? JSON.parse(await readFile(reusedPath, 'utf8')) : null;
const product = reused?.product ?? `Paper30Min Test ${runId}`;
const identifier = reused?.identifier ?? `com.paper30min.${runId}`;
assert.match(product, /^Paper30Min Test installed-\d+$/);
assert.match(identifier, /^com\.paper30min\.installed-\d+$/);
const target = path.join(appDir, 'src-tauri/target');
const cli = path.join(appDir, 'node_modules/@tauri-apps/cli/tauri.js');
const key = path.join(os.tmpdir(), `${runId}.key`);
const report = { runId, identifier, product, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  input: 'NSIS /S installs; CDP synthesized wheel and zoom-button inputs in installed release WebView2',
  boundaries: ['isolated product/identifier and temporary test signing key', 'no remote upload or official updater channel',
    'animation callback cadence is measured, not physical display presentation',
    '500 ms polling delay plus process enumeration time; sampled aggregate working-set/private-byte peaks, not allocator high-water marks',
    'DPI coverage is the current native Windows setting only',
    'generated mixed-size and 300 DPI rasterized real-paper fixtures; not real scanned-paper quality acceptance'],
  thresholds: { minFps: 45, maxP95FrameMs: 50, maxWorkingSetBytes: 1024 ** 3 }, artifacts: [], checks: [], baseline: [] };
if (reused) {
  assert.ok(!worktreeNsis, 'worktree NSIS builds cannot reuse previous artifacts');
  assert.equal(reused.head, report.head, 'reused installers must match the current HEAD');
  report.reusedArtifacts = path.resolve(reusedPath);
}
await mkdir(output, { recursive: true });
let child, browser, page, sampler;
const pageErrors = [];
async function run(command, args, { cwd = root, env = process.env, quiet = false, windowsVerbatimArguments = false, timeoutMs } = {}) {
  const proc = spawn(command, args, { cwd, env, windowsHide: true, windowsVerbatimArguments, stdio: quiet ? 'ignore' : 'inherit' });
  const timer = timeoutMs ? setTimeout(() => proc.kill(), timeoutMs) : null;
  const [code] = await once(proc, 'exit');
  clearTimeout(timer);
  assert.equal(code, 0, `${command} ${args.join(' ')}`);
}
async function check(name, action) {
  const started = Date.now();
  try { const details = await action(); report.checks.push({ name, status: 'passed', elapsedMs: Date.now() - started, details }); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.stack }); throw error; }
  console.log(`PASS ${name}`);
}
const invoke = (command, input = {}) => page.evaluate(({ command, input }) =>
  window.__TAURI__.core.invoke('bridge_invoke', { command, input }), { command, input });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (reused?.worktreeNsisSha256) {
  assert.equal(hash(await readFile(path.join(appDir, 'src-tauri/windows/installer.nsi'))), reused.worktreeNsisSha256,
    'reused worktree installer must match the current NSIS template');
  report.worktreeNsisSha256 = reused.worktreeNsisSha256;
}
async function build(ref, version, publicKey) {
  const snapshot = path.join(output, version);
  await mkdir(snapshot);
  const archive = path.join(output, `${version}.tar`);
  await run('git', ['archive', '--format=tar', `--output=${archive}`, ref]);
  await run('tar', ['-xf', archive, '-C', snapshot]);
  const app = path.join(snapshot, 'app');
  if (worktreeNsis && version === '1.4.0-beta.1') {
    const template = await readFile(path.join(appDir, 'src-tauri/windows/installer.nsi'));
    await writeFile(path.join(app, 'src-tauri/windows/installer.nsi'), template);
    report.worktreeNsisSha256 = hash(template);
  }
  const configPath = path.join(app, 'src-tauri/tauri.conf.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  Object.assign(config, { productName: product, identifier, version });
  config.plugins.updater.pubkey = publicKey;
  config.plugins.updater.endpoints = ['http://127.0.0.1:18437/latest.json'];
  config.plugins.updater.dangerousInsecureTransportProtocol = true;
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const packagePath = path.join(app, 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  pkg.version = version;
  await writeFile(packagePath, JSON.stringify(pkg, null, 2));
  const cargoPath = path.join(app, 'src-tauri/Cargo.toml');
  await writeFile(cargoPath, (await readFile(cargoPath, 'utf8')).replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`));
  await run(process.execPath, [cli, 'build', '--ci', '--bundles', 'nsis'], { cwd: app,
    env: { ...process.env, CARGO_TARGET_DIR: target, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' } });
  const folder = path.join(target, 'release/bundle/nsis');
  const names = (await readdir(folder)).filter(name => name.startsWith(product) && name.endsWith(`_${version}_x64-setup.exe`));
  assert.equal(names.length, 1, 'exactly one installer for this test version');
  const installer = path.join(output, names[0]);
  await copyFile(path.join(folder, names[0]), installer);
  await copyFile(path.join(folder, `${names[0]}.sig`), `${installer}.sig`);
  await verifyInstallerSignature(installer, (await readFile(`${installer}.sig`, 'utf8')).trim(), parseUpdaterPublicKey(publicKey), version);
  report.artifacts.push({ ref, version, installer, sha256: hash(await readFile(installer)), signatureVerified: true });
  return installer;
}
async function install(installer, destination) {
  // NSIS requires the final /D= value unquoted even when the path contains spaces.
  await run(installer, ['/S', '/NS', ...(destination ? [`/D=${destination}`] : [])], { windowsVerbatimArguments: true, timeoutMs: 60000 });
}
async function uninstall(directory) {
  await runUninstaller(directory);
  const identity = readInstallIdentity();
  assert.equal(identity.location, '', 'retaining the library must clear the install location');
  assert.deepEqual(identity.uninstallValues, [], 'uninstall metadata must be removed');
  assert.deepEqual(identity.uninstallSubkeys, [], 'uninstall subkeys must be removed');
}
async function runUninstaller(directory) {
  // Let NSIS copy itself to temp so it can delete the installed uninstaller too.
  await run(path.join(directory, 'uninstall.exe'), ['/S'], { timeoutMs: 60000 });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const files = await readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const identity = readInstallIdentity();
    if (!files.includes('paper30min.exe') && !files.includes('uninstall.exe')
      && !identity.uninstallValues.length && !identity.uninstallSubkeys.length) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.fail('uninstaller did not finish deleting binaries and uninstall metadata');
}
function readInstallIdentity() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `$location = (Get-Item -LiteralPath 'HKCU:\\Software\\paper30min\\${product}' -ErrorAction SilentlyContinue); ` +
    `$uninstall = (Get-Item -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}' -ErrorAction SilentlyContinue); ` +
    `@{ location = $(if ($location) { [string]$location.GetValue('') } else { '' }); ` +
    `uninstallValues = @($(if ($uninstall) { foreach ($name in $uninstall.GetValueNames()) { @{ name = $name; value = $uninstall.GetValue($name) } } })); ` +
    `uninstallSubkeys = @($(if ($uninstall) { $uninstall.GetSubKeyNames() })) } | ConvertTo-Json -Compress -Depth 5`],
  { encoding: 'utf8' }));
}
async function archiveLibrary(dataRoot, label) {
  assert.equal(path.basename(dataRoot), identifier);
  // Keep the archive on the same volume as AppData; the repo may be on another drive.
  const destination = `${dataRoot}-${runId}-${label}`;
  await rename(dataRoot, destination);
  report.archivedLibraries ??= [];
  report.archivedLibraries.push(destination);
}
async function launch(directory) {
  ({ child, browser, page } = await launchWebView({ executable: path.join(directory, 'paper30min.exe'), cwd: directory,
    debugPort: await claimDebugPort(), onPageError: error => pageErrors.push(error.message), pageTimeout: 30000 }));
  const info = await invoke('library.info@1');
  assert.equal(path.basename(info.dataRoot), identifier, 'only touch the isolated test library');
  report.library = info;
  report.browser = await browser.version();
  report.app = (await invoke('app.info@1')).app;
}
async function stop() {
  await stopWebView({ child, browser });
  child = browser = page = null;
}
async function enter() {
  if (await page.locator('#su-enter').isVisible()) await page.locator('#su-enter').click();
  await page.locator('#startup-view').waitFor({ state: 'hidden' });
}
async function seed() {
  await invoke('settings.putUi@1', { settings: { welcomeSeeded: true } });
  for (const [id, name, pages] of [['long', 'long.pdf', 150], ['mixed', 'mixed.pdf', 3], ['scan', 'scan-paper.pdf', 12]]) {
    await invoke('library.putPaper@1', { paper: { id, title: `Installed ${id}`, numPages: pages,
      addedAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
      chat: [{ role: 'assistant', content: 'Preserve this old-library note.', createdAt: '2026-10-10T00:00:00Z' }] } });
    const bytes = await readFile(path.join(output, name));
    await invoke('files.putAttachment@1', { paperId: id, attachment: { id: 'pdf', name,
      contentType: 'application/pdf', contentBase64: bytes.toString('base64') } });
    report.fixtures ??= [];
    if (!report.fixtures.some(fixture => fixture.id === id)) report.fixtures.push({ id, name, pages, bytes: bytes.length, sha256: hash(bytes) });
  }
  await invoke('library.putReadingPosition@1', { position: { paperId: 'long', view: 'map', pdfPage: 73, updatedAt: '2026-10-10T00:00:00Z' } });
  await page.reload();
  await enter();
}
async function assertLibraryPreserved() {
  const paper = (await invoke('library.getPaper@1', { paperId: 'long' })).paper;
  assert.equal(paper.chat[0].content, 'Preserve this old-library note.');
  assert.equal((await invoke('library.getReadingPosition@1', { paperId: 'long' })).position.pdfPage, 73);
  for (const fixture of report.fixtures) {
    const result = await invoke('files.readRange@1', { paperId: fixture.id, attachmentId: 'pdf', offset: 0, length: fixture.bytes });
    assert.equal(hash(Buffer.from(result.contentBase64, 'base64')), fixture.sha256, `${fixture.id} PDF survives byte for byte`);
  }
  await enter(); await openPaper('long');
  assert.equal(await page.locator('#pdf-page-input').inputValue(), '73');
  return nonblank();
}
async function openPaper(id) {
  const previousTitle = await page.locator('#reader-title').textContent();
  const previous = await page.$('#pdf-pages canvas');
  await page.locator('#nav-library').click();
  await page.locator('.paper-card').filter({ hasText: `Installed ${id}` }).click();
  if (previous && previousTitle !== `Installed ${id}`) await page.waitForFunction(canvas => !canvas.isConnected, previous);
  await previous?.dispose();
  await page.waitForFunction(() => document.querySelector('#pdf-pages canvas')?.width > 0);
}
async function nonblank() {
  return page.evaluate(() => {
    const canvas = document.querySelector('#pdf-pages canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] && Math.min(data[i], data[i + 1], data[i + 2]) < 230) ink++;
    if (ink < 1000) throw new Error('blank PDF canvas');
    return { ink, canvas: [canvas.width, canvas.height], viewport: [innerWidth, innerHeight], dpr: devicePixelRatio };
  });
}
async function measure(id, phase, dpr) {
  await page.evaluate(() => {
    window.__baseline = { start: performance.now(), last: performance.now(), intervals: [], active: true };
    const tick = time => {
      const state = window.__baseline;
      if (!state.active) return;
      state.intervals.push(time - state.last); state.last = time;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const started = Date.now();
  const box = await page.locator('#pdf-canvas-wrap').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 100; i++) {
    if (phase === 'scroll') await page.mouse.wheel(0, (i % 20 < 10 ? 1 : -1) * 200);
    else await page.locator(i % 20 < 10 ? '#btn-pdf-zoom-in' : '#btn-pdf-zoom-out').click();
    await page.waitForTimeout(phase === 'scroll' ? 60 : 200);
  }
  await page.evaluate(() => {
    const state = window.__baseline;
    state.interactionEnd = performance.now(); state.interactionFrames = state.intervals.length;
  });
  await page.waitForTimeout(500);
  let settleError = null;
  await page.waitForFunction(() => {
    const canvases = [...document.querySelectorAll('#pdf-pages canvas')];
    return canvases.length && canvases.every(canvas => Math.abs(canvas.width -
      Math.ceil(canvas.parentElement.getBoundingClientRect().width * Math.min(devicePixelRatio, 2))) <= 2);
  }, undefined, { timeout: 10000 }).catch(error => { settleError = error.message; });
  const metrics = await page.evaluate(() => {
    const state = window.__baseline; state.active = false;
    const intervals = state.intervals.filter(value => value > 0).sort((a, b) => a - b);
    const elapsedMs = performance.now() - state.start;
    const interactionIntervals = state.intervals.slice(0, state.interactionFrames).filter(value => value > 0).sort((a, b) => a - b);
    const interactionMs = state.interactionEnd - state.start;
    return { elapsedMs, frames: intervals.length, fps: intervals.length * 1000 / elapsedMs,
      interaction: { elapsedMs: interactionMs, frames: interactionIntervals.length, fps: interactionIntervals.length * 1000 / interactionMs,
        p95FrameMs: interactionIntervals[Math.floor(interactionIntervals.length * .95)] }, settleElapsedMs: elapsedMs - interactionMs,
      p50FrameMs: intervals[Math.floor(intervals.length * .5)], p95FrameMs: intervals[Math.floor(intervals.length * .95)],
      maxFrameMs: intervals.at(-1), over50Ms: intervals.filter(value => value > 50).length,
      viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, canvases: document.querySelectorAll('#pdf-pages canvas').length,
      scrollTop: document.querySelector('#pdf-canvas-wrap').scrollTop, zoom: document.querySelector('#pdf-zoom-label')?.textContent };
  });
  const renderState = settleError ? await page.evaluate(() => ({ loading: document.querySelector('#pdf-loading').textContent,
    renderError: document.querySelector('#pdf-render-error-message').textContent,
    canvases: [...document.querySelectorAll('#pdf-pages canvas')].map(canvas => ({ page: canvas.parentElement.dataset.page,
      width: canvas.width, cssWidth: canvas.parentElement.getBoundingClientRect().width, dpr: devicePixelRatio })) })) : null;
  const samples = (await readFile(path.join(output, 'memory.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(sample => sample.time >= started && sample.time <= Date.now());
  assert.ok(samples.length, 'memory sampler must observe the interaction');
  const peakWorkingSetBytes = Math.max(...samples.map(sample => sample.workingSetBytes));
  const peakPrivateBytes = Math.max(...samples.map(sample => sample.privateBytes));
  const result = { id, phase, requestedDpr: dpr, ...metrics, settled: !settleError, settleError, renderState,
    peakWorkingSetBytes, peakPrivateBytes, memorySamples: samples.length,
    exceeds: { fps: metrics.interaction.fps < report.thresholds.minFps, p95: metrics.interaction.p95FrameMs > report.thresholds.maxP95FrameMs,
      memory: peakWorkingSetBytes > report.thresholds.maxWorkingSetBytes } };
  report.baseline.push(result);
  console.log('BASELINE', JSON.stringify(result));
}
try {
  // The temporary key is never printed; signing and byte verification use only this isolated identity.
  let old, current;
  if (reused) {
    const config = JSON.parse(await readFile(path.join(path.dirname(reused.artifacts[0].installer), '1.4.0-beta.1/app/src-tauri/tauri.conf.json'), 'utf8'));
    for (const artifact of reused.artifacts) {
      assert.equal(hash(await readFile(artifact.installer)), artifact.sha256);
      await verifyInstallerSignature(artifact.installer, (await readFile(`${artifact.installer}.sig`, 'utf8')).trim(), parseUpdaterPublicKey(config.plugins.updater.pubkey), artifact.version);
    }
    report.artifacts = reused.artifacts;
    old = reused.artifacts.find(artifact => artifact.version === '1.3.0').installer;
    current = reused.artifacts.find(artifact => artifact.version === '1.4.0-beta.1').installer;
  } else {
    await run(process.execPath, [cli, 'signer', 'generate', '--ci', '--write-keys', key], { quiet: true });
    const publicKey = (await readFile(`${key}.pub`, 'utf8')).trim();
    old = await build(execFileSync('git', ['rev-parse', 'main'], { cwd: root, encoding: 'utf8' }).trim(), '1.3.0', publicKey);
    current = await build(report.head, '1.4.0-beta.1', publicKey);
  }
  if (readingOnly) {
    report.reusedInstallation = path.resolve(reusedPath);
    report.checks = reused.checks;
    report.fixtures = reused.fixtures;
    const directory = reused.checks.find(check => check.name === 'fresh current installer custom path with spaces').details.directory;
    await launch(directory); assert.equal(report.app.version, '1.4.0-beta.1'); await enter();
  } else {
    await run('python', [path.join(appDir, 'tests/integration/make_pdf_fixtures.py'), output]);
    await run('python', [path.join(appDir, 'tests/integration/make_scanned_paper.py'), path.join(output, 'scan-paper.pdf')]);
  const defaultDir = path.join(process.env.LOCALAPPDATA, product);
  const customDir = path.join(output, 'custom install path');
  // A previous failed run may leave this exact test identity installed; never touch another product.
  if (reused) {
    const registry = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}' -ErrorAction SilentlyContinue).InstallLocation`], { encoding: 'utf8' }).trim().replace(/^"|"$/g, '');
    if (registry) {
      assert.ok(registry === defaultDir || registry.startsWith(path.join(root, 'tmp') + path.sep));
      await uninstall(registry);
    } else {
      const orphan = readInstallIdentity().location;
      if (orphan) {
        assert.ok(orphan === defaultDir || orphan.startsWith(path.join(root, 'tmp') + path.sep));
        const files = await readdir(orphan).catch(error => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        if (files.includes('uninstall.exe')) await uninstall(orphan);
        else { await install(current, defaultDir); await uninstall(defaultDir); }
        report.previousTestRecovery = { directory: orphan, method: 'production installer/uninstaller' };
      }
    }
    const oldData = path.join(process.env.APPDATA, identifier);
    if (await readdir(oldData).catch(() => null)) await archiveLibrary(oldData, 'previous-test-library');
  }
  assert.ok(!await readdir(defaultDir).then(names => names.includes('paper30min.exe')).catch(() => false), 'fresh test identity must not already be installed');
  await check('fresh current installer default path and launch', async () => {
    await install(current); await launch(defaultDir); assert.equal(report.app.version, '1.4.0-beta.1');
    await seed(); await openPaper('long');
    assert.equal(await page.locator('#pdf-page-input').inputValue(), '73');
    const details = await nonblank(); await page.screenshot({ path: path.join(output, 'default.png') });
    await stop(); return { directory: defaultDir, ...details };
  });
  await check('installed application restart preserves PDF and reading position', async () => {
    await launch(defaultDir); await enter(); await openPaper('long');
    assert.equal(await page.locator('#pdf-page-input').inputValue(), '73');
    const details = await nonblank(); await stop(); return details;
  });
  // Uninstall only the unique test identity. App data is retained by the production uninstaller.
  await check('default path uninstall and reinstall retains library and clears identity', async () => {
    await uninstall(defaultDir); await install(current); await launch(defaultDir);
    const details = await assertLibraryPreserved(); await stop(); await uninstall(defaultDir);
    return details;
  });
  await check('fresh current installer custom path with spaces', async () => {
    await install(current, customDir); await launch(customDir); await enter(); await openPaper('mixed');
    const details = await nonblank(); await page.screenshot({ path: path.join(output, 'custom.png') });
    await stop(); return { directory: customDir, ...details };
  });
  await check('custom path uninstall and reinstall retains library and clears identity', async () => {
    await uninstall(customDir); await install(current, customDir); await launch(customDir);
    const details = await assertLibraryPreserved(); await stop(); await uninstall(customDir);
    return details;
  });
  await check('legacy orphan install location safely recovers without deleting contents', async () => {
    const sentinel = path.join(customDir, 'retained-user-content.txt');
    await mkdir(customDir, { recursive: true });
    await writeFile(sentinel, 'User content must survive orphan recovery.');
    await run('reg.exe', ['add', `HKCU\\Software\\paper30min\\${product}`, '/ve', '/d', customDir, '/f']);
    await install(current); await launch(defaultDir);
    const details = await assertLibraryPreserved(); await stop();
    assert.equal(await readFile(sentinel, 'utf8'), 'User content must survive orphan recovery.');
    await uninstall(defaultDir); return details;
  });
  await check('incomplete or foreign install identities are rejected without mutation', async () => {
    const productKey = `HKCU\\Software\\paper30min\\${product}`;
    const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`;
    const binary = path.join(customDir, 'paper30min.exe');
    const scenarios = ['remaining-binary', 'remaining-uninstaller', 'foreign-metadata', 'unnamed-metadata', 'unknown-metadata', 'metadata-subkey'];
    for (const scenario of scenarios) {
      await run('reg.exe', ['add', productKey, '/ve', '/d', customDir, '/f']);
      if (scenario === 'remaining-binary') await writeFile(binary, 'not an installation');
      else if (scenario === 'remaining-uninstaller') await writeFile(path.join(customDir, 'uninstall.exe'), 'not an uninstaller');
      else if (scenario === 'unnamed-metadata') await run('reg.exe', ['add', uninstallKey, '/ve', '/d', 'Other product', '/f']);
      else if (scenario === 'metadata-subkey') await run('reg.exe', ['add', `${uninstallKey}\\OtherProduct`, '/f']);
      else await run('reg.exe', ['add', uninstallKey, '/v', scenario === 'foreign-metadata' ? 'DisplayName' : 'OtherProduct', '/d', 'Other product', '/f']);
      const before = readInstallIdentity();
      await assert.rejects(install(current), error => error.code === 'ERR_ASSERTION' && error.actual === 1 && error.expected === 0);
      assert.deepEqual(readInstallIdentity(), before);
      assert.ok(!await readdir(defaultDir).then(names => names.includes('paper30min.exe')).catch(() => false));
      if (scenario === 'remaining-binary') {
        assert.equal(await readFile(binary, 'utf8'), 'not an installation');
        await rm(binary);
      } else if (scenario === 'remaining-uninstaller') {
        assert.equal(await readFile(path.join(customDir, 'uninstall.exe'), 'utf8'), 'not an uninstaller');
        await rm(path.join(customDir, 'uninstall.exe'));
      } else await run('reg.exe', ['delete', uninstallKey, '/f']);
      await run('reg.exe', ['delete', productKey, '/ve', '/f']);
    }
    return { scenarios };
  });
  await archiveLibrary(report.library.dataRoot, 'current-library-before-old-install');
  await check('install main 1.3.0 and create old library', async () => {
    await install(old, customDir); await launch(customDir); assert.equal(report.app.version, '1.3.0');
    assert.ok((await invoke('library.listPapers@1')).papers.every(paper => !['long', 'mixed', 'scan'].includes(paper.id)),
      'old installation must not inherit the current-version test papers; the built-in guide is allowed');
    await seed(); report.oldLibrary = await invoke('library.info@1'); await stop();
    return { directory: customDir, version: '1.3.0' };
  });
  await run('python', ['-c', 'import sqlite3,sys; from pathlib import Path; source=sqlite3.connect(Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); destination=sqlite3.connect(sys.argv[2]); source.backup(destination); destination.close(); source.close()',
    path.join(report.library.dataRoot, 'database/library.sqlite'), path.join(output, 'old-library.sqlite')]);
  const oldDatabase = await readFile(path.join(output, 'old-library.sqlite'));
  await check('upgrade old installed library retains custom path despite /D override', async () => {
    await install(current, path.join(output, 'must not redirect')); await launch(customDir);
    assert.equal(report.app.version, '1.4.0-beta.1');
    const paper = (await invoke('library.getPaper@1', { paperId: 'long' })).paper;
    assert.equal(paper.chat[0].content, 'Preserve this old-library note.');
    const position = await invoke('library.getReadingPosition@1', { paperId: 'long' });
    assert.equal(position.position.pdfPage, 73);
    report.oldPosition = position;
    for (const fixture of report.fixtures) {
      const result = await invoke('files.readRange@1', { paperId: fixture.id, attachmentId: 'pdf', offset: 0, length: fixture.bytes });
      assert.equal(hash(Buffer.from(result.contentBase64, 'base64')), fixture.sha256, `${fixture.id} PDF survives upgrade byte for byte`);
    }
    await enter(); await openPaper('long');
    assert.equal(await page.locator('#pdf-page-input').inputValue(), '73');
    const details = await nonblank();
    await page.screenshot({ path: path.join(output, 'upgrade.png') });
    return { oldDatabaseSha256: hash(oldDatabase), ...details };
  });
  await check('historical uninstaller orphan recovers and preserves the library', async () => {
    await stop(); await uninstall(customDir);
    await install(old, customDir); await runUninstaller(customDir);
    const identity = readInstallIdentity();
    assert.equal(identity.location, customDir, 'historical uninstaller reproduces the orphan location');
    assert.deepEqual(identity.uninstallValues, []);
    await install(current, customDir); await launch(customDir);
    return assertLibraryPreserved();
  });
  }
  if (!installOnly) {
  sampler = spawn('powershell.exe', ['-NoProfile', '-File', path.join(appDir, 'tests/integration/installed-memory.ps1'),
    '-RootPid', String(child.pid), '-OutputPath', path.join(output, 'memory.jsonl')], { windowsHide: true, stdio: 'inherit' });
  report.host = { os: os.release(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramBytes: os.totalmem() };
  report.physicalViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screen: [screen.width, screen.height] }));
  const dpr = report.physicalViewport.dpr;
  for (const id of ['long', 'mixed', 'scan']) {
    await openPaper(id); await page.locator('#btn-pdf-fit').click(); await page.waitForTimeout(1500);
    if (id === 'scan') for (let i = 0; i < 10; i++) await page.locator('#btn-pdf-zoom-in').click();
    for (const phase of ['scroll', 'zoom']) await measure(id, phase, dpr);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(output, `${id}-dpr-${dpr}.png`) });
  }
  }
  report.pageErrors = pageErrors;
  assert.deepEqual(pageErrors, []);
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  const samplerExit = sampler && sampler.exitCode === null && sampler.signalCode === null ? once(sampler, 'exit') : null;
  await stop().catch(error => { report.teardownError = error.stack; process.exitCode = 1; });
  if (samplerExit) {
    sampler.kill();
    await Promise.race([samplerExit, new Promise(resolve => setTimeout(resolve, 5000).unref())]);
  }
  await rm(key, { force: true });
  await rm(`${key}.pub`, { force: true });
  if (reused) {
    assert.match(reused.runId, /^installed-\d+$/);
    await rm(path.join(os.tmpdir(), `${reused.runId}.key`), { force: true });
    await rm(path.join(os.tmpdir(), `${reused.runId}.key.pub`), { force: true });
  }
  report.result = report.error ? 'failed' : report.checks.some(check => check.status === 'failed')
    || report.baseline.some(row => !row.settled || Object.values(row.exceeds).some(Boolean)) ? 'completed-with-findings' : 'passed';
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`REPORT ${path.join(output, 'report.json')}`);
}
