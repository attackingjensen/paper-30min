import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCloudPdfAssets, prepareCloudPdfAssets } from '../ui/js/cloud-pdf-assets.js';

const resources = [
  { attachmentId: 'pageimg-0001', page: 1, bbox: null, pageSize: [600, 800], width: 1200, height: 1600 },
  { attachmentId: 'crop-fig_1-r1', page: 1, bbox: [20, 40, 100, 80], pageSize: [600, 800], width: 100, height: 80 },
  { attachmentId: 'pageimg-0002', page: 2, bbox: null, pageSize: [600, 800], width: 1200, height: 1600 },
];
function fixture(render = () => ({ promise: Promise.resolve(), cancel() {} }), pageSize = [600, 800]) {
  const rendered = [], cleaned = [], loaded = [], canvases = [];
  const doc = { async getPage(page) { loaded.push(page); return {
    getViewport: ({ scale }) => ({ width: pageSize[0] * scale, height: pageSize[1] * scale }),
    render(options) { rendered.push(options); return render(options); },
    cleanup() { cleaned.push(page); },
  }; } };
  const createCanvas = () => {
    assert.ok(canvases.every(c => c.width === 0 && c.height === 0), 'previous canvas released');
    const canvas = { width: 0, height: 0, getContext: () => ({}), toBlob(callback) { callback(new Blob(['png'])); } };
    canvases.push(canvas); return canvas;
  };
  return { doc, createCanvas, rendered, cleaned, loaded, canvases };
}

test('visual rendering emits one PNG at a time and releases each page and canvas', async () => {
  const f = fixture(), saved = [];
  await renderCloudPdfAssets(f.doc, resources, { createCanvas: f.createCanvas, put: async (id, bytes) => saved.push([id, bytes]) });
  assert.deepEqual(saved.map(([id]) => id), resources.map(r => r.attachmentId));
  assert.deepEqual(f.loaded, [1, 2]);
  assert.deepEqual(f.cleaned, [1, 2]);
  assert.deepEqual(f.rendered[1].transform, [1, 0, 0, 1, -20, -40]);
  assert.ok(f.canvases.every(c => c.width === 0 && c.height === 0));
});

test('verified resources are skipped on restart, while an incomplete page resumes', async () => {
  const f = fixture(), saved = [];
  await renderCloudPdfAssets(f.doc, resources, { createCanvas: f.createCanvas, completedAttachmentIds: ['pageimg-0001', 'crop-fig_1-r1'], put: async id => saved.push(id) });
  assert.deepEqual(f.loaded, [2]);
  assert.deepEqual(saved, ['pageimg-0002']);
});

test('render errors still clean the page and canvas and never upload partial bytes', async () => {
  const f = fixture(() => ({ promise: Promise.reject(new Error('render failed')), cancel() {} }));
  await assert.rejects(renderCloudPdfAssets(f.doc, resources, { createCanvas: f.createCanvas, put: async () => assert.fail('no partial upload') }), /render failed/);
  assert.deepEqual(f.cleaned, [1]);
  assert.ok(f.canvases.every(c => c.width === 0));
});

test('cancellation stops an in-flight PDF render and prevents later uploads', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const f = fixture(() => {
    let reject;
    const promise = new Promise((_, fail) => { reject = fail; });
    queueMicrotask(() => controller.abort());
    return { promise, cancel() { cancelled++; reject(new Error('cancelled')); } };
  });
  await assert.rejects(renderCloudPdfAssets(f.doc, resources, { createCanvas: f.createCanvas, signal: controller.signal, put: async () => assert.fail('cancelled upload') }));
  assert.equal(cancelled, 1);
  assert.deepEqual(f.cleaned, [1]);
  assert.deepEqual(f.loaded, [1]);
  assert.ok(f.canvases.every(c => c.width === 0));
});

test('PDF viewport mismatches fail before producing an image', async () => {
  const f = fixture();
  await assert.rejects(renderCloudPdfAssets(f.doc, [{ ...resources[0], pageSize: [800, 600] }], { createCanvas: f.createCanvas, put: async () => assert.fail('wrong page') }), /尺寸/);
  assert.equal(f.rendered.length, 0);
  assert.deepEqual(f.cleaned, [1]);
});

test('preparation reads the pinned PDF and destroys its document when upload fails', async () => {
  const f = fixture(), snapshot = { manifest: { batchId: 'parent' } };
  let destroyed = 0;
  f.doc.destroy = async () => { destroyed++; };
  const bridge = { async invoke(command, input) {
    if (command === 'tasks.get@1') return { task: { status: 'running' } };
    if (command === 'cloudassets.plan@1') return { state: 'ready', snapshot, resources: [resources[0]], completedAttachmentIds: [] };
    if (command === 'parsebatch.read@1') {
      assert.equal(input.snapshot, snapshot); assert.equal(input.attachmentId, 'pdf');
      return { contentBase64: Buffer.from('pdf').toString('base64') };
    }
    assert.equal(command, 'cloudassets.put@1');
    throw new Error('upload failed');
  } };
  await assert.rejects(prepareCloudPdfAssets(bridge, 'task', { createCanvas: f.createCanvas, openPdf: async data => {
    assert.equal(Buffer.from(data).toString(), 'pdf'); return f.doc;
  } }), /upload failed/);
  assert.equal(destroyed, 1); assert.deepEqual(f.cleaned, [1]);
});

test('a verified completed plan does not reopen or rerender the PDF', async () => {
  const bridge = { async invoke(command) {
    if (command === 'tasks.get@1') return { task: { status: 'running' } };
    assert.equal(command, 'cloudassets.plan@1');
    return { state: 'ready', resources, completedAttachmentIds: resources.map(r => r.attachmentId) };
  } };
  await prepareCloudPdfAssets(bridge, 'task', { openPdf: () => assert.fail('completed resources must not render') });
});

test('1060-point page and crop clamp rounded output to the native 1600-pixel limit', async () => {
  for (const resource of [
    { attachmentId: 'pageimg-0001', page: 1, pageSize: [340, 1060], bbox: null, width: 514, height: 1600 },
    { attachmentId: 'crop-f-r1', page: 1, pageSize: [1200, 1400], bbox: [20, 20, 2120, 680], width: 1600, height: 514 },
  ]) {
    const f = fixture(undefined, resource.pageSize);
    let uploaded = 0;
    await renderCloudPdfAssets(f.doc, [resource], { createCanvas: f.createCanvas, put: async () => { uploaded++; } });
    assert.equal(uploaded, 1);
    assert.ok(f.canvases.every(canvas => canvas.width === 0));
  }
});
