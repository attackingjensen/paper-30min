// THROWAWAY PROTOTYPE (issue #20) - 无构建步骤，直接用 window.__TAURI__
import { renderMarkdown } from './markdown.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const API = 'http://127.0.0.1:8791';
const SAMPLE_ID = 'demo-paper';

const $ = s => document.querySelector(s);
const logEl = $('#log');
function log(msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

let currentId = null;
let currentView = 'md';
let pdf = { doc: null, page: 1, scale: 1.2 };

async function refreshShelf() {
  const papers = await invoke('list_papers');
  const tbody = $('#papers tbody');
  tbody.innerHTML = '';
  for (const p of papers) {
    const tr = document.createElement('tr');
    const hasPdf = (await invoke('get_attachment', { id: p.id })) !== null;
    tr.innerHTML = `<td>${p.title}</td><td>v${p.version}</td><td>${hasPdf ? '已缓存' : '未缓存'}</td>`;
    const ops = document.createElement('td');
    const open = document.createElement('button');
    open.textContent = '打开';
    open.onclick = () => openPaper(p.id);
    const upd = document.createElement('button');
    upd.textContent = '检查新版本';
    upd.onclick = () => checkUpdate(p.id);
    ops.append(open, upd);
    tr.append(ops);
    tbody.append(tr);
  }
  log(`书架刷新：${papers.length} 篇`);
}

async function importSample(fail) {
  const url = `${API}/api/papers/sample?v=1${fail ? '&fail=mid' : ''}`;
  log(`导入请求 ${url}`);
  try {
    if (fail) {
      // 直接走 Rust 下载路径：中断时不得写库，旧版本必须保持完整可读
      await invoke('fetch_new_version', { id: SAMPLE_ID, url });
      log('异常：中断导入居然成功了');
    } else {
      const resp = await fetch(url);
      const data = await resp.json();
      await invoke('save_paper', { id: SAMPLE_ID, title: data.title, version: data.version, markdown: data.markdown });
      const size = await invoke('import_attachment', { id: SAMPLE_ID, url: `${API}/api/files/sample.pdf`, name: 'sample.pdf' });
      log(`导入完成：${data.title} v${data.version}，PDF ${size} 字节`);
    }
  } catch (e) {
    log(`导入/更新失败：${e}（旧版本保持完整可读）`);
  }
  await refreshShelf();
}

async function checkUpdate(id) {
  log('检查新版本…');
  try {
    const v = await invoke('fetch_new_version', { id, url: `${API}/api/papers/sample?v=2` });
    $(`#update-badge`).hidden = false;
    $(`#update-badge`).textContent = `新版 v${v} 已就绪，退出阅读页后生效`;
    log(`新版本 v${v} 已下载并切换（旧版已原子替换）`);
    await refreshShelf();
  } catch (e) {
    log(`版本下载失败：${e}（旧版本保持可读）`);
  }
}

async function openPaper(id) {
  currentId = id;
  const t0 = performance.now();
  const paper = await invoke('get_paper', { id });
  $('#paper-title').textContent = paper.title;
  $('#paper-version').textContent = `v${paper.version}`;
  $('#view-shelf').hidden = true;
  $('#view-reader').hidden = false;
  $('#btn-back').hidden = false;
  $('#pane-md').innerHTML = renderMarkdown(paper.markdown);
  await MathJax.typesetPromise([$('#pane-md')]).catch(e => log('MathJax: ' + e));
  log(`首屏渲染耗时 ${Math.round(performance.now() - t0)}ms（markdown ${paper.markdown.length} 字符）`);
  const pos = await invoke('get_position', { id });
  switchTab(pos?.view === 'pdf' ? 'pdf' : 'md');
  if (pos?.view !== 'pdf') {
    window.scrollTo(0, Number(pos?.anchor || 0));
    log(`阅读位置恢复：markdown scrollY=${pos?.anchor ?? 0}`);
  }
}

function switchTab(tab) {
  currentView = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#pane-md').hidden = tab !== 'md';
  $('#pane-pdf').hidden = tab !== 'pdf';
  if (tab === 'pdf') openPdf();
}

async function openPdf() {
  if (pdf.doc) return;
  const bytes = await invoke('get_attachment', { id: currentId });
  if (!bytes) {
    $('#pdf-missing').hidden = false;
    log('PDF 未缓存，显示明确状态（不空白不转圈）');
    return;
  }
  $('#pdf-missing').hidden = true;
  const t0 = performance.now();
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  pdf.doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  log(`PDF 加载 ${Math.round(performance.now() - t0)}ms，${bytes.length} 字节，${pdf.doc.numPages} 页`);
  const pos = await invoke('get_position', { id: currentId });
  pdf.page = Math.min(Number(pos?.view === 'pdf' ? pos.anchor : 1) || 1, pdf.doc.numPages);
  await renderPdfPage();
}

async function renderPdfPage() {
  const page = await pdf.doc.getPage(pdf.page);
  const viewport = page.getViewport({ scale: pdf.scale });
  const canvas = $('#pdf-canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  $('#pdf-page').textContent = `${pdf.page}/${pdf.doc.numPages}`;
  savePosition();
}

let saveTimer = null;
function savePosition() {
  if (!currentId || $('#view-reader').hidden) return; // 返回书架等视图切换触发的滚动不覆盖位置
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const anchor = currentView === 'pdf' ? String(pdf.page) : String(Math.round(window.scrollY));
    await invoke('save_position', { id: currentId, view: currentView, anchor });
    log(`位置已保存：${currentView} ${anchor}`);
  }, 500);
}

// 流式：事件监听只注册一次
let streaming = false;
await listen('stream-chunk', e => {
  if (e.payload.id !== currentId) return;
  $('#stream-out').textContent += e.payload.text;
});
await listen('stream-done', e => {
  if (e.payload.id !== currentId) return;
  streaming = false;
  $('#stream-out').classList.remove('streaming');
  $('#btn-stream-stop').disabled = true;
  log('流式结束（收到 [DONE]）');
});
await listen('stream-error', e => {
  if (e.payload.id !== currentId) return;
  streaming = false;
  $('#stream-out').classList.remove('streaming');
  $('#btn-stream-stop').disabled = true;
  log(`流式中断：${e.payload.text}，可点"开始流式精读"重试`);
});
await listen('stream-cancelled', e => {
  if (e.payload.id !== currentId) return;
  streaming = false;
  $('#stream-out').classList.remove('streaming');
  $('#btn-stream-stop').disabled = true;
  log('流式已取消，旧任务不再写入');
});

$('#btn-import').onclick = () => importSample(false);
$('#btn-import-fail').onclick = () => importSample(true);
$('#btn-back').onclick = () => {
  $('#view-reader').hidden = true;
  $('#view-shelf').hidden = false;
  $('#btn-back').hidden = true;
  pdf = { doc: null, page: 1, scale: 1.2 };
  refreshShelf();
};
document.querySelectorAll('.tab').forEach(b => (b.onclick = () => switchTab(b.dataset.tab)));
window.addEventListener('scroll', savePosition);
$('#pdf-prev').onclick = () => { if (pdf.page > 1) { pdf.page--; renderPdfPage(); } };
$('#pdf-next').onclick = () => { if (pdf.doc && pdf.page < pdf.doc.numPages) { pdf.page++; renderPdfPage(); } };
$('#pdf-zoom-in').onclick = () => { pdf.scale += 0.2; renderPdfPage(); };
$('#pdf-zoom-out').onclick = () => { if (pdf.scale > 0.4) { pdf.scale -= 0.2; renderPdfPage(); } };
$('#btn-stream').onclick = async () => {
  streaming = true;
  $('#stream-box').hidden = false;
  $('#stream-out').textContent = '';
  $('#stream-out').classList.add('streaming');
  $('#btn-stream-stop').disabled = false;
  const fail = $('#chk-stream-fail')?.checked ? '&fail=mid' : '';
  log('开始流式请求…');
  await invoke('start_stream', { id: currentId, url: `${API}/api/stream?paper=${currentId}${fail}` });
};
$('#btn-stream-stop').onclick = () => invoke('cancel_stream', { id: currentId });

log('原型 UI 已加载');
await refreshShelf();
