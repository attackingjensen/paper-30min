import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdfReader, pageWindow, pageAtOffset } from '../ui/js/pdf-reader.js';

test('continuous PDF keeps only visible pages and neighbors in the render window', () => {
  const bottoms = Array.from({ length: 1000 }, (_, index) => (index + 1) * 800);
  assert.deepEqual(pageWindow(bottoms, 800 * 500 + 100, 650), [499, 500, 501]);
  assert.deepEqual(pageWindow(bottoms, 0, 650), [0, 1]);
  assert.deepEqual(pageWindow(bottoms, 800 * 999, 650), [998, 999]);
});

test('current page follows the visible position across unequal page heights', () => {
  const bottoms = [600, 1500, 2100];
  assert.equal(pageAtOffset(bottoms, 0), 0);
  assert.equal(pageAtOffset(bottoms, 700), 1);
  assert.equal(pageAtOffset(bottoms, 2050), 2);
});

function readerFixture(options = {}) {
  const frames = [];
  const makeElement = () => ({
    children: [], style: { setProperty(key, value) { this[key] = value; } }, dataset: {}, hidden: false,
    replaceChildren(...nodes) {
      this.children = nodes.flatMap(node => node.fragment ? node.children : [node]);
      for (const child of this.children) child.parent = this;
    },
    appendChild(node) {
      if (node.fragment) this.children.push(...node.children);
      else this.children.push(node);
      for (const child of this.children) child.parent = this;
    },
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); },
    get offsetHeight() { return Number.parseInt(this.style.height, 10) || 0; },
    get offsetWidth() { return Number.parseInt(this.style.width, 10) || 0; },
    getBoundingClientRect() {
      return { top: this.offsetTop - scroll.scrollTop, left: Math.max(0, (scroll.clientWidth - this.offsetWidth) / 2) - scroll.scrollLeft, width: this.offsetWidth, height: this.offsetHeight };
    },
    get offsetTop() {
      if (!this.parent) return 0;
      const index = this.parent.children.indexOf(this);
      return this.parent.children.slice(0, index).reduce((sum, sibling) => sum + sibling.offsetHeight + 12, 0);
    },
    getContext() { return {}; },
  });
  globalThis.window = {
    devicePixelRatio: 1,
    document: {
      createElement: makeElement,
      createDocumentFragment: () => ({ fragment: true, children: [], appendChild(node) { this.children.push(node); } }),
    },
  };
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  const scroll = { scrollTop: 0, scrollLeft: 0, clientLeft: 0, clientTop: 0, clientWidth: 620, clientHeight: 650, getBoundingClientRect: () => ({ top: 0, left: 0 }), addEventListener(name, listener) { if (name === 'scroll') this.onScroll = listener; } };
  const pages = makeElement();
  const errors = [];
  const seen = [];
  const evidenceStates = [];
  const reader = createPdfReader({ scroll, pages, loading: makeElement(), onPageChange: page => seen.push(page), onError: error => errors.push(error), onEvidence: state => evidenceStates.push(state), ...options });
  const doc = count => ({
    numPages: count,
    async getPage() {
      return {
        getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve(), cancel() {} }),
      };
    },
  });
  async function flush() {
    for (let round = 0; round < 5; round++) {
      await Promise.resolve();
      for (const callback of frames.splice(0)) callback();
    }
  }
  return { reader, scroll, pages, seen, errors, evidenceStates, doc, flush };
}

test('PDF text layers publish with their canvas and selected pages remain pinned', async () => {
  let invalidations = 0;
  const f = readerFixture({ renderTextLayer: () => ({ promise: Promise.resolve(), cancel() {} }),
    getPinnedPages: () => [1], onInvalidate: () => invalidations++ });
  const doc = f.doc(12), original = doc.getPage;
  doc.getPage = async number => ({ ...await original(number), getTextContent: async () => ({ items: [] }),
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, scale }) });
  await f.reader.open(doc, 1, 1); await f.flush();
  assert.equal(f.pages.children[0].children[1]?.className, 'pdf-text-layer');
  f.scroll.scrollTop = 8 * 812; f.scroll.onScroll(); await f.flush();
  assert.equal(f.pages.children[0].children[1]?.className, 'pdf-text-layer');
  f.reader.resize(2);
  assert.equal(f.pages.children[0].children.some(node => node.className === 'pdf-text-layer'), false);
  assert.ok(invalidations >= 2);
  f.reader.clear();
});

test('obsolete PDF text fetches and text render tasks never publish partial frames', async () => {
  for (const stage of ['fetch', 'render']) {
    let resolve, canceled = 0;
    const held = new Promise(done => { resolve = done; });
    const f = readerFixture({ renderTextLayer: () => ({ promise: stage === 'render' ? held : Promise.resolve(), cancel() { canceled++; } }) });
    const doc = f.doc(1), original = doc.getPage;
    doc.getPage = async number => ({ ...await original(number),
      getTextContent: () => stage === 'fetch' ? held : Promise.resolve({ items: [] }) });
    await f.reader.open(doc, 1, 1); await f.flush();
    const slot = f.pages.children[0];
    assert.equal(slot.children.length, 0, `${stage} must finish before canvas publication`);
    f.reader.clear();
    resolve({ items: [] }); await f.flush();
    assert.equal(slot.children.length, 0);
    assert.equal(f.pages.children.length, 0);
    if (stage === 'render') assert.equal(canceled, 1);
  }
});

test('evidence overlay uses trusted geometry, survives zoom and redraw, and page-only navigation clears it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = readerFixture();
  const doc = f.doc(12);
  const getPage = doc.getPage;
  doc.getPage = async number => ({ ...await getPage(number), getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, rotation: 0 }) });
  await f.reader.open(doc, 2, 1);
  await f.flush();
  assert.equal(await f.reader.locate({ page: 2, bbox: [100, 200, 400, 100] }), true);
  const slot = f.pages.children[1];
  assert.equal(slot.children.length, 2);
  assert.equal(slot.children[1].style.top, '100px');
  f.reader.resize(2);
  assert.equal(slot.children[1].style.top, '200px');
  t.mock.timers.tick(120);
  await f.flush();
  assert.equal(slot.children.length, 2);
  await f.reader.locate({ page: 2 });
  assert.equal(slot.children.length, 1);
  f.reader.clear();
});

test('source coordinates highlight separate columns across pages without reading text', async () => {
  const f = readerFixture();
  const doc = f.doc(2);
  const getPage = doc.getPage;
  doc.getPage = async number => ({ ...await getPage(number),
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, rotation: 0 }),
    getTextContent: () => { throw new Error('Source mapping should not read text'); },
  });
  await f.reader.open(doc, 1, 1);
  await f.flush();
  await f.reader.locate({ page: 1, sourceRegions: [
    { page: 1, bbox: [40, 1400, 500, 80], pageSize: [600, 800] },
    { page: 1, bbox: [640, 100, 500, 120], pageSize: [600, 800] },
    { page: 2, bbox: [40, 100, 500, 120], pageSize: [600, 800] },
  ] });
  await f.flush();
  assert.equal(f.evidenceStates.at(-1), '已定位出处');
  assert.equal(f.pages.children[0].children.filter(node => node.className === 'pdf-evidence-highlight').length, 2);
  assert.equal(f.pages.children[1].children.filter(node => node.className === 'pdf-evidence-highlight').length, 1);
  f.reader.clear();
});

test('cross-page evidence is published together and survives recycling and zoom', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = readerFixture();
  const doc = f.doc(12);
  const getPage = doc.getPage;
  doc.getPage = async number => ({ ...await getPage(number),
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, rotation: 0, transform: [scale, 0, 0, -scale, 0, 800 * scale] }),
    getTextContent: async () => ({ styles: { font: { ascent: 1, descent: 0 } }, items: [{
      str: number === 2 ? 'Unique evidence' : 'continued on next page',
      width: 120, height: 12, transform: [12, 0, 0, 12, 20, 700], dir: 'ltr', fontName: 'font',
    }] }),
  });
  await f.reader.open(doc, 1, 1);
  await f.flush();
  assert.equal(await f.reader.locate({ page: 2, pageEnd: 3, text: 'Unique evidence continued on next page' }), true);
  await f.flush();
  for (const index of [1, 2]) assert.equal(f.pages.children[index].children[1]?.className, 'pdf-evidence-highlight');
  f.reader.resize(2);
  for (const index of [1, 2]) assert.equal(f.pages.children[index].children[1]?.style.top, '176px');
  t.mock.timers.tick(120);
  await f.flush();
  f.scroll.scrollTop = 8 * 1612;
  f.scroll.onScroll();
  await f.flush();
  f.scroll.scrollTop = 1612;
  f.scroll.onScroll();
  await f.flush();
  for (const index of [1, 2]) assert.equal(f.pages.children[index].children[1]?.className, 'pdf-evidence-highlight');
  await f.reader.locate({ page: 2 });
  for (const index of [1, 2]) assert.equal(f.pages.children[index].children.length, 1);
  f.reader.clear();
});

test('late evidence lookup cannot move or highlight a newer page navigation', async () => {
  const f = readerFixture();
  const doc = f.doc(12);
  await f.reader.open(doc, 2, 1);
  await f.flush();
  const getPage = doc.getPage;
  let complete;
  doc.getPage = () => new Promise(resolve => { complete = resolve; });
  const pending = f.reader.locate({ page: 2, bbox: [100, 200, 400, 100] });
  f.reader.jump(3);
  complete({ ...await getPage(2), getViewport: () => ({ width: 600, height: 800, rotation: 0 }) });
  assert.equal(await pending, null);
  assert.equal(f.scroll.scrollTop, 2 * 812);
  f.reader.clear();
});

test('canceling a second-page lookup never publishes partial highlights or reads further pages', async () => {
  const f = readerFixture();
  const doc = f.doc(12);
  const getPage = doc.getPage;
  const read = [];
  let complete;
  doc.getPage = async number => ({ ...await getPage(number),
    getViewport: () => ({ width: 600, height: 800, rotation: 0, transform: [1, 0, 0, -1, 0, 800] }),
    getTextContent() {
      read.push(number);
      return number === 3 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({
        styles: { font: { ascent: 1, descent: 0 } }, items: [{ str: 'Unique evidence', width: 120, height: 12,
          transform: [12, 0, 0, 12, 20, 700], dir: 'ltr', fontName: 'font' }],
      });
    },
  });
  await f.reader.open(doc, 1, 1);
  await f.flush();
  const pending = f.reader.locate({ page: 2, pageEnd: 8, text: 'Unique evidence continued on next page', segments: [
    { page: 2, pageEnd: 2, text: 'Unique evidence' },
    { page: 3, pageEnd: 8, text: 'continued on next page' },
  ] });
  await f.flush();
  assert.deepEqual(read, [2, 3]);
  assert.equal(f.pages.children.flatMap(slot => slot.children).filter(node => node.className === 'pdf-evidence-highlight').length, 0);
  assert.equal(f.evidenceStates.at(-1), '正在定位出处…');
  f.reader.jump(7);
  complete({ items: [] });
  assert.equal(await pending, null);
  assert.deepEqual(read, [2, 3]);
  assert.equal(f.scroll.scrollTop, 6 * 812);
  assert.equal(f.evidenceStates.includes('已定位出处'), false);
  assert.equal(f.pages.children.flatMap(slot => slot.children).filter(node => node.className === 'pdf-evidence-highlight').length, 0);
  f.reader.clear();
});

test('an imprecise section bound reads at most eight pages and falls back without highlights', async () => {
  const f = readerFixture();
  const doc = f.doc(100);
  const getPage = doc.getPage;
  const read = [];
  doc.getPage = async number => ({ ...await getPage(number), getTextContent: async () => {
    read.push(number);
    return { items: [] };
  } });
  await f.reader.open(doc, 1, 1);
  assert.equal(await f.reader.locate({ page: 2, pageEnd: 100, text: 'Not present in this document' }), true);
  assert.deepEqual(read, [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(f.pages.children.flatMap(slot => slot.children).filter(node => node.className === 'pdf-evidence-highlight').length, 0);
  f.reader.clear();
});

test('duplicate text on a later candidate page must not be accepted as unique', async () => {
  const f = readerFixture();
  const doc = f.doc(3);
  const getPage = doc.getPage;
  const read = [];
  doc.getPage = async number => ({ ...await getPage(number),
    getViewport: () => ({ width: 600, height: 800, rotation: 0, transform: [1, 0, 0, -1, 0, 800] }),
    getTextContent: async () => {
      read.push(number);
      return { styles: { font: { ascent: 1, descent: 0 } }, items: [{ str: 'Duplicated evidence passage',
        width: 120, height: 12, transform: [12, 0, 0, 12, 20, 700], dir: 'ltr', fontName: 'font' }] };
    },
  });
  await f.reader.open(doc, 1, 1);
  await f.flush();
  assert.equal(await f.reader.locate({ page: 1, pageEnd: 2, text: 'Duplicated evidence passage' }), true);
  assert.deepEqual(read, [1, 2]);
  assert.equal(f.pages.children.flatMap(slot => slot.children).filter(node => node.className === 'pdf-evidence-highlight').length, 0);
  f.reader.clear();
});

test('cold evidence pages and recycled pages publish their highlights with the completed canvas', async () => {
  const f = readerFixture();
  const doc = f.doc(12);
  const getPage = doc.getPage;
  doc.getPage = async number => ({ ...await getPage(number), getViewport: () => ({ width: 600, height: 800, rotation: 0 }) });
  await f.reader.open(doc, 1, 1);
  await f.flush();
  await f.reader.locate({ page: 8, bbox: [100, 200, 400, 100] });
  await f.flush();
  assert.equal(f.pages.children[7].children[1]?.className, 'pdf-evidence-highlight');
  f.scroll.scrollTop = 0;
  f.scroll.onScroll();
  await f.flush();
  assert.equal(f.pages.children[7].children.length, 0);
  f.scroll.scrollTop = 7 * 812;
  f.scroll.onScroll();
  await f.flush();
  assert.equal(f.pages.children[7].children[1]?.className, 'pdf-evidence-highlight');
  f.reader.clear();
});

test('user scrolling and paper replacement cancel pending evidence without pulling the reader back', async () => {
  const f = readerFixture();
  const doc = f.doc(12);
  const getPage = doc.getPage;
  let complete;
  doc.getPage = async number => ({ ...await getPage(number),
    getViewport: () => ({ width: 600, height: 800, rotation: 0 }),
    getTextContent: () => new Promise(resolve => { complete = resolve; }),
  });
  await f.reader.open(doc, 1, 1);
  await f.flush();
  const pending = f.reader.locate({ page: 2, text: 'unique evidence text' });
  await f.flush();
  f.scroll.scrollTop = 7 * 812;
  f.scroll.onScroll();
  complete({ items: [] });
  assert.equal(await pending, null);
  assert.equal(f.scroll.scrollTop, 7 * 812);
  const replaced = f.reader.locate({ page: 2, text: 'unique evidence text' });
  await f.flush();
  await f.reader.open(f.doc(3), 3, 1);
  complete({ items: [] });
  assert.equal(await replaced, null);
  assert.equal(f.scroll.scrollTop, 2 * 812);
  f.reader.clear();
});

test('internal anchor restoration during layout does not cancel its own pending evidence', async () => {
  const f = readerFixture();
  const doc = f.doc(12);
  const getPage = doc.getPage;
  let complete;
  doc.getPage = async number => ({ ...await getPage(number), getTextContent: () => new Promise(resolve => { complete = resolve; }) });
  await f.reader.open(doc, 1, 1);
  await f.flush();
  const pending = f.reader.locate({ page: 2, text: 'unique evidence text' });
  await f.flush();
  f.scroll.clientHeight = 600;
  f.reader.reflow();
  f.scroll.onScroll();
  complete({ items: [] });
  assert.equal(await pending, true);
  f.reader.clear();
});

test('zoom preserves the page content beneath the pointer in both axes', async () => {
  const f = readerFixture();
  await f.reader.open(f.doc(12), 8, 1);
  await f.flush();
  f.scroll.scrollTop += 200;
  f.reader.resize(2, { x: 200, y: 100 });
  assert.equal(f.scroll.scrollTop, 7 * 1612 + 500);
  assert.equal(f.scroll.scrollLeft, 180);
  await f.flush();
  assert.equal(f.seen.length, 0);
  f.reader.clear();
});

test('mode layout changes preserve a middle-page anchor through a round trip', async () => {
  const f = readerFixture();
  await f.reader.open(f.doc(12), 8, 1);
  await f.flush();
  f.scroll.scrollTop += 200;
  const anchor = f.reader.captureAnchor();
  f.scroll.clientWidth = 1200;
  f.scroll.clientHeight = 800;
  f.reader.restoreAnchor(anchor);
  assert.equal(f.scroll.scrollTop, 7 * 812 + 125);
  const returning = f.reader.captureAnchor();
  f.scroll.clientWidth = 620;
  f.scroll.clientHeight = 650;
  f.reader.restoreAnchor(returning);
  assert.equal(f.scroll.scrollTop, 7 * 812 + 200);
  f.reader.clear();
});

test('window reflow restores the center saved before the container changed size', async () => {
  const f = readerFixture();
  f.scroll.clientWidth = 1200;
  await f.reader.open(f.doc(12), 8, 1.5);
  await f.flush();
  f.scroll.scrollTop += 200;
  f.scroll.onScroll();
  await f.flush();
  f.scroll.clientWidth = 620;
  f.scroll.clientHeight = 500;
  f.reader.reflow();
  assert.equal(f.scroll.scrollLeft, 140);
  assert.equal(f.scroll.scrollTop, 7 * 1212 + 275);
  f.reader.clear();
});

test('unchanged zoom keeps existing canvases and pending renders', async () => {
  const f = readerFixture();
  await f.reader.open(f.doc(12), 8, 3);
  await f.flush();
  const canvas = f.pages.children[7].children[0];
  const top = f.scroll.scrollTop;
  f.reader.resize(3, { x: 200, y: 100 });
  assert.equal(f.pages.children[7].children[0], canvas);
  assert.equal(f.scroll.scrollTop, top);
  f.reader.clear();
});

test('zoom shows an immediate scaled preview and swaps only a completed canvas', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = readerFixture();
  const doc = f.doc(12);
  await f.reader.open(doc, 8, 1);
  await f.flush();
  const slot = f.pages.children[7];
  const preview = slot.children[0];
  const getPage = doc.getPage;
  const completions = [];
  doc.getPage = async number => {
    const page = await getPage(number);
    page.render = () => ({ promise: new Promise(resolve => completions.push(resolve)), cancel() {} });
    return page;
  };
  f.reader.resize(1.5);
  assert.equal(slot.style.width, '900px');
  assert.equal(slot.children[0], preview);
  assert.equal(preview.style.width, '100%');
  await f.flush();
  assert.equal(completions.length, 0);
  t.mock.timers.tick(120);
  await f.flush();
  assert.ok(completions.length > 0);
  assert.equal(slot.children[0], preview);
  completions.forEach(resolve => resolve());
  await f.flush();
  assert.notEqual(slot.children[0], preview);
  f.reader.clear();
});

test('continuous zoom coalesces renders and rejects an obsolete completed frame', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = readerFixture();
  const doc = f.doc(4);
  await f.reader.open(doc, 1, 1);
  await f.flush();
  const preview = f.pages.children[0].children[0];
  const getPage = doc.getPage;
  const renders = [];
  doc.getPage = async number => {
    const page = await getPage(number);
    page.render = ({ viewport }) => ({ promise: new Promise(resolve => renders.push({ resolve, width: viewport.width })), cancel() {} });
    return page;
  };
  f.reader.resize(1.2);
  await f.flush();
  t.mock.timers.tick(60);
  f.reader.resize(1.4);
  await f.flush();
  t.mock.timers.tick(60);
  assert.equal(renders.length, 0);
  t.mock.timers.tick(60);
  await f.flush();
  assert.ok(renders.length > 0);
  assert.ok(renders.every(render => render.width === 840));
  f.reader.resize(1.6);
  renders.forEach(render => render.resolve());
  await f.flush();
  assert.equal(f.pages.children[0].children[0], preview);
  f.reader.clear();
  t.mock.timers.tick(120);
  await f.flush();
  assert.equal(f.pages.children.length, 0);
});

test('initial rendering never exposes an unfinished opaque canvas', async () => {
  const f = readerFixture();
  const doc = f.doc(2);
  const getPage = doc.getPage;
  const completions = [];
  doc.getPage = async number => {
    const page = await getPage(number);
    page.render = () => ({ promise: new Promise(resolve => completions.push(resolve)), cancel() {} });
    return page;
  };
  await f.reader.open(doc, 1, 1);
  await f.flush();
  assert.equal(f.pages.children[0].children.length, 0);
  completions.forEach(resolve => resolve());
  await f.flush();
  assert.equal(f.pages.children[0].children.length, 1);
  f.reader.clear();
});

test('failed zoom repaint retains the preview and retry can replace it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = readerFixture();
  const doc = f.doc(4);
  await f.reader.open(doc, 1, 1);
  await f.flush();
  const preview = f.pages.children[0].children[0];
  const getPage = doc.getPage;
  let fail = true;
  doc.getPage = async number => {
    const page = await getPage(number);
    page.render = () => ({ promise: fail ? Promise.reject(new Error('repaint failed')) : Promise.resolve(), cancel() {} });
    return page;
  };
  f.reader.resize(1.5);
  t.mock.timers.tick(120);
  await f.flush();
  assert.equal(f.pages.children[0].children[0], preview);
  assert.ok(f.errors.some(error => error.message === 'repaint failed'));
  fail = false;
  f.reader.retry();
  await f.flush();
  assert.notEqual(f.pages.children[0].children[0], preview);
  f.reader.clear();
});

test('scrolling during the zoom delay releases offscreen previews', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = readerFixture();
  await f.reader.open(f.doc(1000), 1, 1);
  await f.flush();
  f.reader.resize(1.5);
  f.scroll.scrollTop = 500 * 1212;
  f.scroll.onScroll();
  await f.flush();
  assert.equal(f.pages.children[0].children.length, 0);
  t.mock.timers.tick(120);
  await f.flush();
  assert.equal(f.seen.at(-1), 501);
  assert.ok(f.pages.children.filter(slot => slot.children.length).length <= 4);
  f.reader.clear();
});

test('scrolling a long PDF releases offscreen canvases and updates the page', async () => {
  const fixture = readerFixture();
  await fixture.reader.open(fixture.doc(1000), 1, 1);
  await fixture.flush();
  fixture.scroll.scrollTop = 500 * 812;
  fixture.scroll.onScroll();
  await fixture.flush();
  assert.equal(fixture.seen.at(-1), 501);
  assert.equal(fixture.pages.children[0].children.length, 0);
  assert.ok(fixture.pages.children.filter(slot => slot.children.length).length <= 4);
  assert.deepEqual(fixture.errors, []);
  fixture.reader.clear();
});

test('late page metadata from the old PDF cannot replace a newer document', async () => {
  const fixture = readerFixture();
  let resolveOld;
  const old = { numPages: 20, getPage: () => new Promise(resolve => { resolveOld = resolve; }) };
  const openingOld = fixture.reader.open(old, 1, 1);
  await fixture.reader.open(fixture.doc(3), 2, 1);
  resolveOld({ getViewport: () => ({ width: 600, height: 800 }) });
  await openingOld;
  assert.equal(fixture.pages.children.length, 3);
  assert.equal(fixture.pages.children[1].dataset.page, '2');
  await fixture.flush();
  assert.ok(fixture.pages.children.some(slot => slot.children.length));
  fixture.reader.clear();
});

test('navigation and zoom during initial metadata loading apply after slots exist', async () => {
  const fixture = readerFixture();
  let resolveFirst;
  const document = fixture.doc(4);
  const originalGetPage = document.getPage;
  document.getPage = page => page === 1 && !resolveFirst
    ? new Promise(resolve => { resolveFirst = resolve; })
    : originalGetPage(page);
  const opening = fixture.reader.open(document, 1, 1);
  fixture.reader.jump(3);
  fixture.reader.resize(1.5);
  resolveFirst(await originalGetPage(1));
  await opening;
  await fixture.flush();
  assert.equal(fixture.scroll.scrollTop, 2 * (1200 + 12));
  assert.equal(fixture.pages.children[2].style.width, '900px');
  assert.equal(fixture.seen.at(-1), 3);
  fixture.reader.clear();
});

test('a released page request cannot render after a newer request for that page', async () => {
  const fixture = readerFixture();
  const document = fixture.doc(5);
  const originalGetPage = document.getPage;
  let resolveOld;
  let firstPageCalls = 0;
  let renders = 0;
  document.getPage = async page => {
    if (page === 1 && ++firstPageCalls === 2) return new Promise(resolve => { resolveOld = resolve; });
    const result = await originalGetPage(page);
    result.render = () => { renders++; return { promise: Promise.resolve(), cancel() {} }; };
    return result;
  };
  await fixture.reader.open(document, 1, 1);
  await fixture.flush();
  fixture.scroll.scrollTop = 3 * 812;
  fixture.scroll.onScroll();
  await fixture.flush();
  fixture.scroll.scrollTop = 0;
  fixture.scroll.onScroll();
  await fixture.flush();
  const before = renders;
  const oldPage = await originalGetPage(1);
  oldPage.render = () => { renders++; return { promise: Promise.resolve(), cancel() {} }; };
  resolveOld(oldPage);
  await fixture.flush();
  assert.equal(renders, before);
  assert.equal(fixture.pages.children[0].children.length, 1);
  fixture.reader.clear();
});

test('failed page render exposes retry and can recover', async () => {
  const fixture = readerFixture();
  const document = fixture.doc(2);
  const originalGetPage = document.getPage;
  let failed = false;
  document.getPage = async page => {
    const result = await originalGetPage(page);
    if (page === 1) result.render = () => failed
      ? { promise: Promise.resolve(), cancel() {} }
      : (failed = true, { promise: Promise.reject(new Error('render failed')), cancel() {} });
    return result;
  };
  await fixture.reader.open(document, 1, 1);
  await fixture.flush();
  assert.equal(fixture.errors[0].message, 'render failed');
  assert.equal(fixture.pages.children[0].children.length, 0);
  fixture.reader.retry();
  await fixture.flush();
  assert.equal(fixture.pages.children[0].children.length, 1);
  fixture.reader.clear();
});

test('a late page-size correction above the viewport preserves the viewed page', async () => {
  const fixture = readerFixture();
  const document = fixture.doc(4);
  const originalGetPage = document.getPage;
  document.getPage = async page => {
    const result = await originalGetPage(page);
    if (page === 2) result.getViewport = ({ scale }) => ({ width: 600 * scale, height: 1000 * scale });
    return result;
  };
  await fixture.reader.open(document, 3, 1);
  await fixture.flush();
  assert.equal(fixture.scroll.scrollTop, 2 * 812 + 200);
  assert.equal(fixture.pages.children[2].dataset.page, '3');
  fixture.reader.clear();
});
