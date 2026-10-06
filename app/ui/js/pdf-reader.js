import { evidenceRects, evidenceRangeRects } from './pdf-evidence.js';

// Page indices are zero-based inside the renderer; the toolbar uses one-based page numbers.
export function pageAtOffset(bottoms, offset) {
  let low = 0;
  let high = bottoms.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (bottoms.at(middle) > offset) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function pageWindow(bottoms, top, height) {
  if (!bottoms.length) return [];
  const first = pageAtOffset(bottoms, top);
  const last = pageAtOffset(bottoms, top + height);
  const pages = [];
  for (let index = Math.max(0, first - 1); index <= Math.min(bottoms.length - 1, last + 1); index++) {
    pages.push(index);
  }
  return pages;
}

export function createPdfReader({ scroll, pages, loading, onPageChange, onError, onEvidence = () => {},
  renderTextLayer = null, getPinnedPages = () => [], onInvalidate = () => {}, onPaint = () => {} }) {
  let document = null;
  let slots = [];
  let tasks = new Map();
  let epoch = 0;
  let scale = 1;
  let frame = 0;
  let currentPage = 1;
  let stableAnchor = null;
  let zoomTimer = null;
  let evidenceRevision = 0;
  let evidence = null;
  let pendingEvidence = null;
  const paintedPages = new Set();
  const failedPages = new Set();
  const positions = {
    get length() { return slots.length; },
    at(index) { return slots[index].offsetTop + slots[index].offsetHeight; },
  };

  function release(index, keepPreview = false) {
    tasks.get(index)?.task?.cancel();
    tasks.delete(index);
    failedPages.delete(index);
    const slot = slots[index];
    if (slot && !keepPreview) {
      slot.replaceChildren();
      paintedPages.delete(index);
    }
  }

  function clear() {
    onInvalidate();
    clearEvidence();
    epoch++;
    clearTimeout(zoomTimer);
    zoomTimer = null;
    cancelAnimationFrame(frame);
    frame = 0;
    for (const index of new Set([...tasks.keys(), ...paintedPages])) release(index);
    tasks = new Map();
    failedPages.clear();
    slots = [];
    pages.replaceChildren();
    document = null;
    currentPage = 1;
    stableAnchor = null;
    scroll.scrollTop = 0;
  }

  async function render(index, generation, entry) {
    const doc = document;
    let page;
    try {
      page = await doc.getPage(index + 1);
      if (generation !== epoch || tasks.get(index) !== entry) return;
      const viewport = page.getViewport({ scale });
      const slot = slots[index];
      const previousHeight = slot.offsetHeight;
      const beforeViewport = slot.offsetTop + previousHeight <= scroll.scrollTop;
      slot.dataset.baseWidth = String(viewport.width / scale);
      slot.dataset.baseHeight = String(viewport.height / scale);
      slot.style.width = `${Math.ceil(viewport.width)}px`;
      slot.style.height = `${Math.ceil(viewport.height)}px`;
      if (beforeViewport) {
        scroll.scrollTop += slot.offsetHeight - previousHeight;
        if (pendingEvidence) pendingEvidence.top = scroll.scrollTop;
      }
      const canvas = window.document.createElement('canvas');
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const task = page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      });
      entry.task = task;
      await task.promise;
      // Publish only a complete frame; canceled or obsolete renders stay offscreen.
      if (generation !== epoch || tasks.get(index) !== entry) return;
      let layer = null;
      if (renderTextLayer) {
        const content = await page.getTextContent();
        if (generation !== epoch || tasks.get(index) !== entry) return;
        layer = window.document.createElement('div');
        layer.className = 'pdf-text-layer';
        layer.style.setProperty('--scale-factor', String(viewport.scale));
        const textTask = renderTextLayer({ textContentSource: content, container: layer, viewport });
        entry.task = textTask;
        await textTask.promise;
        if (generation !== epoch || tasks.get(index) !== entry) return;
      }
      slot.replaceChildren(...(layer ? [canvas, layer] : [canvas]));
      paintedPages.add(index);
      paintEvidence(index);
      onPaint();
      schedule();
    } catch (error) {
      if (generation !== epoch || tasks.get(index) !== entry) return;
      tasks.delete(index);
      if (error?.name !== 'RenderingCancelledException') {
        failedPages.add(index);
        onError(error);
      }
    }
  }

  function update() {
    frame = 0;
    if (!document || !slots.length || !scroll.clientHeight) return;
    reflow();
    const wanted = new Set(pageWindow(positions, scroll.scrollTop, scroll.clientHeight));
    for (const page of getPinnedPages()) if (Number.isInteger(page) && page >= 1 && page <= slots.length) wanted.add(page - 1);
    for (const index of new Set([...tasks.keys(), ...paintedPages])) if (!wanted.has(index)) release(index);
    for (const index of wanted) {
      if (!zoomTimer && !tasks.has(index) && !failedPages.has(index)) {
        const entry = { task: null };
        tasks.set(index, entry);
        void render(index, epoch, entry);
      }
    }
    const page = pageAtOffset(positions, scroll.scrollTop + scroll.clientHeight / 3) + 1;
    if (page !== currentPage) {
      currentPage = page;
      onPageChange(page);
    }
    rememberAnchor();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  async function open(doc, pageNumber, initialScale) {
    clear();
    document = doc;
    scale = initialScale;
    currentPage = Math.min(Math.max(pageNumber, 1), doc.numPages);
    const generation = epoch;
    const first = await doc.getPage(1);
    if (generation !== epoch) return;
    const viewport = first.getViewport({ scale });
    const fragment = window.document.createDocumentFragment();
    for (let index = 0; index < doc.numPages; index++) {
      const slot = window.document.createElement('div');
      slot.className = 'pdf-page';
      slot.dataset.page = String(index + 1);
      slot.style.width = `${Math.ceil(viewport.width)}px`;
      slot.style.height = `${Math.ceil(viewport.height)}px`;
      slot.dataset.baseWidth = String(viewport.width / scale);
      slot.dataset.baseHeight = String(viewport.height / scale);
      fragment.appendChild(slot);
      slots.push(slot);
    }
    pages.appendChild(fragment);
    loading.hidden = true;
    jump(currentPage);
  }

  function jump(pageNumber) {
    onInvalidate();
    clearEvidence();
    if (!document) return;
    const nextPage = Math.min(Math.max(Math.round(pageNumber), 1), document.numPages);
    const changed = nextPage !== currentPage;
    currentPage = nextPage;
    if (slots.length) scroll.scrollTop = slots[currentPage - 1].offsetTop;
    rememberAnchor();
    if (changed) onPageChange(currentPage);
    schedule();
  }

  function captureAnchor(point = {}) {
    if (!slots.length || !scroll.clientHeight) return null;
    const x = point.x ?? scroll.clientWidth / 2;
    const y = point.y ?? scroll.clientHeight / 2;
    const viewport = scroll.getBoundingClientRect();
    const index = pageAtOffset(positions, viewport.top + scroll.clientTop + y - pages.getBoundingClientRect().top);
    const box = slots[index].getBoundingClientRect();
    return { index, x: (viewport.left + scroll.clientLeft + x - box.left) / box.width,
      y: (viewport.top + scroll.clientTop + y - box.top) / box.height,
      viewX: x / scroll.clientWidth, viewY: y / scroll.clientHeight };
  }

  function restoreAnchor(anchor) {
    if (!anchor || !slots[anchor.index]) { schedule(); return; }
    const box = slots[anchor.index].getBoundingClientRect();
    const viewport = scroll.getBoundingClientRect();
    scroll.scrollTop += box.top + anchor.y * box.height - viewport.top - scroll.clientTop - anchor.viewY * scroll.clientHeight;
    scroll.scrollLeft += box.left + anchor.x * box.width - viewport.left - scroll.clientLeft - anchor.viewX * scroll.clientWidth;
    if (pendingEvidence) {
      pendingEvidence.top = scroll.scrollTop;
      pendingEvidence.left = scroll.scrollLeft;
    }
    rememberAnchor();
    schedule();
  }

  function rememberAnchor() {
    const anchor = captureAnchor();
    if (anchor) stableAnchor = { anchor, width: scroll.clientWidth, height: scroll.clientHeight };
  }

  function reflow() {
    if (!scroll.clientWidth || !scroll.clientHeight) return;
    if (stableAnchor && (stableAnchor.width !== scroll.clientWidth || stableAnchor.height !== scroll.clientHeight)) {
      onInvalidate();
      restoreAnchor(stableAnchor.anchor);
    }
  }

  function resize(nextScale, point) {
    if (!document || nextScale === scale) return;
    onInvalidate();
    cancelLocate();
    const anchor = captureAnchor(point);
    scale = nextScale;
    if (!slots.length) return;
    epoch++;
    for (const index of tasks.keys()) release(index, true);
    tasks = new Map();
    failedPages.clear();
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      zoomTimer = null;
      schedule();
    }, 120);
    for (const slot of slots) {
      for (const node of [...slot.children]) if (node.className === 'pdf-text-layer') node.remove();
      slot.style.width = `${Math.ceil(Number(slot.dataset.baseWidth) * scale)}px`;
      slot.style.height = `${Math.ceil(Number(slot.dataset.baseHeight) * scale)}px`;
    }
    if (evidence) for (const page of evidence.keys()) paintEvidence(page - 1);
    restoreAnchor(anchor);
  }

  function retry() {
    failedPages.clear();
    loading.hidden = true;
    schedule();
  }

  scroll.addEventListener('scroll', () => {
    if (pendingEvidence && (scroll.scrollTop !== pendingEvidence.top || scroll.scrollLeft !== pendingEvidence.left)) cancelLocate();
    schedule();
  }, { passive: true });
  scroll.addEventListener('wheel', cancelLocate, { passive: true });
  scroll.addEventListener('pointerdown', cancelLocate);
  scroll.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelLocate();
  });

  function cancelLocate() {
    if (!pendingEvidence) return;
    pendingEvidence = null;
    evidenceRevision++;
    onEvidence('');
  }

  function clearEvidence() {
    evidenceRevision++;
    pendingEvidence = null;
    if (evidence) {
      const indices = [...evidence.keys()].map(page => page - 1);
      evidence = null;
      for (const index of indices) paintEvidence(index);
    }
    onEvidence('');
  }

  function paintEvidence(index) {
    const slot = slots[index];
    if (!slot) return;
    for (const node of [...slot.children]) if (node.className === 'pdf-evidence-highlight') node.remove();
    if (!evidence?.has(index + 1) || !paintedPages.has(index)) return;
    for (const [x, y, width, height] of evidence.get(index + 1)) {
      const node = window.document.createElement('div');
      node.className = 'pdf-evidence-highlight';
      node.style.left = `${x * scale}px`;
      node.style.top = `${y * scale}px`;
      node.style.width = `${width * scale}px`;
      node.style.height = `${height * scale}px`;
      slot.appendChild(node);
    }
  }

  async function locate(target) {
    if (!document || !slots.length || !Number.isInteger(target.page) || target.page < 1 || target.page > document.numPages) return false;
    jump(target.page);
    const revision = evidenceRevision;
    const doc = document;
    pendingEvidence = { top: scroll.scrollTop, left: scroll.scrollLeft };
    onEvidence('正在定位出处…');
    try {
      const infos = [];
      // Bound old, imprecise metadata so a click cannot scan an entire long section.
      const end = target.text && Number.isInteger(target.pageEnd)
        ? Math.min(target.pageEnd, doc.numPages, target.page + 7) : target.page;
      const pageNumbers = target.sourceRegions
        ? [...new Set(target.sourceRegions.map(region => region.page))] : Array.from({ length: end - target.page + 1 }, (_, index) => target.page + index);
      if (pageNumbers.some(number => !Number.isInteger(number) || number < 1 || number > doc.numPages)) throw new Error('Invalid source page');
      for (const number of pageNumbers) {
        const page = await doc.getPage(number);
        if (revision !== evidenceRevision || document !== doc) return null;
        const viewport = page.getViewport({ scale: 1 });
        const content = target.text ? await page.getTextContent() : null;
        // null means a newer navigation superseded this lookup, not an invalid page.
        if (revision !== evidenceRevision || document !== doc) return null;
        infos.push({ page: number, viewport, content });
      }
      const regions = target.text || target.sourceRegions ? evidenceRangeRects(target, infos) : [];
      if (!target.text && !target.sourceRegions) {
        const rects = evidenceRects(target, infos[0].viewport);
        if (rects.length) regions.push({ page: target.page, rects });
      }
      pendingEvidence = null;
      evidence = new Map(regions.map(({ page, rects }) => [page, rects]));
      for (const page of evidence.keys()) paintEvidence(page - 1);
      if (regions.length) {
        const first = regions[0];
        const viewport = infos.find(info => info.page === first.page).viewport;
        const [x, y, width, height] = first.rects[0];
        restoreAnchor({ index: first.page - 1, x: (x + width / 2) / viewport.width,
          y: (y + height / 2) / viewport.height, viewX: 0.5, viewY: 0.35 });
      }
      onEvidence(regions.length ? '已定位出处' : '仅页级定位');
      return true;
    } catch {
      if (revision !== evidenceRevision || document !== doc) return null;
      pendingEvidence = null;
      onEvidence('仅页级定位');
      return true;
    }
  }

  return { clear, open, jump, locate, cancelLocate, resize, retry, schedule, captureAnchor, restoreAnchor, reflow };
}
