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

function readerFixture() {
  const frames = [];
  const makeElement = () => ({
    children: [], style: {}, dataset: {}, hidden: false,
    replaceChildren(...nodes) {
      this.children = nodes.flatMap(node => node.fragment ? node.children : [node]);
      for (const child of this.children) child.parent = this;
    },
    appendChild(node) { this.replaceChildren(node); },
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
  const scroll = { scrollTop: 0, scrollLeft: 0, clientLeft: 0, clientTop: 0, clientWidth: 620, clientHeight: 650, getBoundingClientRect: () => ({ top: 0, left: 0 }), addEventListener(name, listener) { this.onScroll = listener; } };
  const pages = makeElement();
  const errors = [];
  const seen = [];
  const reader = createPdfReader({ scroll, pages, loading: makeElement(), onPageChange: page => seen.push(page), onError: error => errors.push(error) });
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
  return { reader, scroll, pages, seen, errors, doc, flush };
}

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
