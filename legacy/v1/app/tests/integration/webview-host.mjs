import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, copyFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Shared WebView2 host scaffolding for the integration suites in this directory.
// Each suite keeps its own fixtures, checks and report; everything that locates,
// builds, launches, drives and tears down the isolated native host lives here.

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function assertWindowsHost() {
  assert.equal(process.platform, 'win32', 'This suite requires Windows WebView2');
}

export async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// Serve the unmodified ui/ tree over loopback. An optional fixture handler gets
// each request first and returns true when it answered; everything else falls
// through to the static files.
export function createUiServer(fixture) {
  return http.createServer(async (req, res) => {
    if (fixture && await fixture(req, res)) return;
    try {
      const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
      const root = path.resolve(appDir, 'ui');
      const target = path.resolve(root, relative);
      assert.ok(target.startsWith(root + path.sep));
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
      res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
      res.end(await readFile(target));
    } catch { res.writeHead(404); res.end(); }
  });
}

// Borrow a free loopback port and release it, so the host can take it as its CDP endpoint.
export async function claimDebugPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  return port;
}

export function tauriConfig({ identifier, url, title, plugins, app }) {
  return JSON.stringify({
    identifier,
    build: { devUrl: url },
    ...(plugins ? { plugins } : {}),
    app: { ...(app ?? {}), windows: [{ label: 'main', title, width: 1280, height: 900 }] },
  });
}

export async function run(command, args, env = process.env) {
  const handle = spawn(command, args, { cwd: appDir, env, stdio: 'inherit', windowsHide: true });
  const [code] = await once(handle, 'exit');
  assert.equal(code, 0, `${command} ${args.join(' ')}`);
}

// Build the isolated native UI host with the suite's Tauri config baked in and
// copy the executable out of target/, so startup never touches a developer's
// real library or the sidecar directory next to the debug build.
export async function buildHost({ config, output, extraLinkArgs = [] }) {
  await run('cargo', ['rustc', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'pdf_webview_host', '--',
    '-C', 'link-arg=/MANIFEST:EMBED', ...extraLinkArgs], { ...process.env, TAURI_CONFIG: config });
  const executable = path.join(output, 'paper30min.exe');
  await copyFile(path.join(appDir, 'src-tauri/target/debug/examples/pdf_webview_host.exe'), executable);
  return executable;
}

export async function launchWebView({ executable, cwd, debugPort, env = {}, browserArgs = '', pageTimeout = 15000, deadlineMs = 45000, onPageError, ready }) {
  const child = spawn(executable, [], { cwd, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1${browserArgs}` } });
  let browser, connectionError;
  try {
    await Promise.race([once(child, 'error').then(([error]) => { throw error; }), (async () => {
      const deadline = Date.now() + deadlineMs;
      while (!browser && Date.now() < deadline) {
        assert.equal(child.exitCode, null, 'native WebView2 host exited before CDP');
        try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); }
        catch (error) { connectionError = error.message; await new Promise(resolve => setTimeout(resolve, 200)); }
      }
    })()]);
    assert.ok(browser, `native WebView2 host must start: ${connectionError ?? 'CDP not reachable before deadline'}`);
    const page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(pageTimeout);
    if (onPageError) page.on('pageerror', onPageError);
    await page.waitForFunction(ready ?? (() => window.__TAURI__?.core));
    return { child, browser, page };
  } catch (error) {
    // Launch failures still own the started host: kill it here, because the
    // destructuring assignment in the caller never runs once we throw.
    await stopWebView({ child, browser }).catch(() => {});
    throw error;
  }
}

// taskkill /T also stops the WebView2 child processes; a plain child.kill() only
// signals the host process and leaves the renderer tree behind.
export async function stopWebView({ child, browser }) {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit');
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await once(killer, 'exit');
    // taskkill /F on our own tree is near-instant; bound the wait so a failed
    // kill can never hang the suite's teardown forever. unref lets the process
    // exit on the normal path without waiting out the losing timer.
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 10000).unref())]);
  }
}

export async function closeServers(...servers) {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

// Suites build the host example with their own identifier; leave the developer's
// normal library build as the final cargo state afterwards.
export async function restoreLibraryBuild() {
  await run('cargo', ['build', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--lib']);
}
