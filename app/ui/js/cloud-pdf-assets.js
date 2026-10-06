import { base64ToBytes, bytesToBase64 } from './store.js';

function checkpoint(signal) {
  if (signal?.aborted) throw new DOMException('视觉准备已取消', 'AbortError');
}

export async function renderCloudPdfAssets(doc, resources, {
  completedAttachmentIds = [], signal, put,
  createCanvas = () => document.createElement('canvas'),
} = {}) {
  const completed = new Set(completedAttachmentIds);
  const pending = resources.filter(resource => !completed.has(resource.attachmentId)).sort((a, b) => a.page - b.page);
  let page = null, pageNumber = null;
  try {
    for (const resource of pending) {
      checkpoint(signal);
      if (pageNumber !== resource.page) {
        page?.cleanup(); page = null;
        page = await doc.getPage(resource.page); pageNumber = resource.page;
      }
      checkpoint(signal);
      const base = page.getViewport({ scale: 1 });
      if (Math.abs(base.width - resource.pageSize[0]) > 0.05 || Math.abs(base.height - resource.pageSize[1]) > 0.05) throw new Error('PDF 页面尺寸与候选不一致');
      const crop = resource.bbox?.map(value => value / 2);
      const [x, y, width, height] = crop || [0, 0, base.width, base.height];
      const scale = Math.min(2, 1600 / Math.max(width, height));
      if (![x, y, width, height, scale].every(Number.isFinite) || width <= 0 || height <= 0
        || x < 0 || y < 0 || x + width > base.width + 0.01 || y + height > base.height + 0.01
        || resource.width !== Math.min(1600, Math.ceil(width * scale)) || resource.height !== Math.min(1600, Math.ceil(height * scale))) throw new Error('视觉资源尺寸或区域无效');
      const canvas = createCanvas();
      let task;
      const cancelRender = () => task?.cancel();
      try {
        canvas.width = resource.width; canvas.height = resource.height;
        task = page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale }),
          transform: crop ? [1, 0, 0, 1, -x * scale, -y * scale] : undefined,
          background: '#ffffff' });
        signal?.addEventListener('abort', cancelRender, { once: true });
        if (signal?.aborted) cancelRender();
        await task.promise;
        checkpoint(signal);
        const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图像编码失败')), 'image/png'));
        checkpoint(signal);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        checkpoint(signal);
        await put(resource.attachmentId, bytes);
      } finally {
        signal?.removeEventListener('abort', cancelRender);
        canvas.width = canvas.height = 0;
      }
    }
  } finally { page?.cleanup(); }
}

async function loadPdf(data, { signal } = {}) {
  const pdfjs = globalThis.pdfjsLib;
  if (!pdfjs) throw new Error('pdf.js 尚未加载');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.js', import.meta.url).href;
  const loading = pdfjs.getDocument({ data });
  const cancel = () => { void loading.destroy().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try { return await loading.promise; }
  finally { signal?.removeEventListener('abort', cancel); }
}

export async function prepareCloudPdfAssets(bridge, taskId, { signal, openPdf = loadPdf, createCanvas } = {}) {
  const deadline = Date.now() + 30000;
  let plan;
  while (Date.now() < deadline) {
    checkpoint(signal);
    const { task } = await bridge.invoke('tasks.get@1', { taskId });
    if (task?.status === 'succeeded') return task.result;
    if (['failed', 'cancelled', 'cancel_requested'].includes(task?.status)) throw Object.assign(new Error(task.error?.message || '视觉准备已停止'), { code: task.error?.code });
    plan = await bridge.invoke('cloudassets.plan@1', { taskId });
    if (plan.state === 'ready') break;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 200);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  checkpoint(signal);
  if (plan?.state !== 'ready') throw new Error('视觉准备计划等待超时');
  if (plan.resources.every(resource => plan.completedAttachmentIds.includes(resource.attachmentId))) return;
  const read = await bridge.invoke('parsebatch.read@1', { snapshot: plan.snapshot, attachmentId: 'pdf' });
  checkpoint(signal);
  const doc = await openPdf(base64ToBytes(read.contentBase64), { signal });
  try {
    await renderCloudPdfAssets(doc, plan.resources, { completedAttachmentIds: plan.completedAttachmentIds, signal, createCanvas,
      put: async (attachmentId, bytes) => {
        checkpoint(signal);
        const { task } = await bridge.invoke('tasks.get@1', { taskId });
        if (!['running', 'queued'].includes(task?.status)) throw new Error(task?.error?.message || '视觉准备已停止');
        await bridge.invoke('cloudassets.put@1', { taskId, attachmentId, contentBase64: bytesToBase64(bytes) });
      },
    });
  } finally { await doc.destroy(); }
}
