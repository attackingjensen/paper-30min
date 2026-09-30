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

export function createPdfReader({ scroll, pages, loading, onPageChange, onError }) {
  let document = null;
  let slots = [];
  let tasks = new Map();
  let epoch = 0;
  let scale = 1;
  let frame = 0;
  let currentPage = 1;
  let stableAnchor = null;
  const failedPages = new Set();
  const positions = {
    get length() { return slots.length; },
    at(index) { return slots[index].offsetTop + slots[index].offsetHeight; },
  };

  function release(index) {
    tasks.get(index)?.task?.cancel();
    tasks.delete(index);
    failedPages.delete(index);
    const slot = slots[index];
    if (slot) slot.replaceChildren();
  }

  function clear() {
    epoch++;
    cancelAnimationFrame(frame);
    frame = 0;
    for (const index of tasks.keys()) release(index);
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
      if (beforeViewport) scroll.scrollTop += slot.offsetHeight - previousHeight;
      const canvas = window.document.createElement('canvas');
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      slot.replaceChildren(canvas);
      const task = page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      });
      entry.task = task;
      await task.promise;
      if (generation === epoch) schedule();
    } catch (error) {
      if (generation !== epoch || tasks.get(index) !== entry) return;
      tasks.delete(index);
      if (error?.name !== 'RenderingCancelledException') {
        failedPages.add(index);
        slots[index].replaceChildren();
        onError(error);
      }
    }
  }

  function update() {
    frame = 0;
    if (!document || !slots.length || !scroll.clientHeight) return;
    reflow();
    const wanted = new Set(pageWindow(positions, scroll.scrollTop, scroll.clientHeight));
    for (const index of tasks.keys()) if (!wanted.has(index)) release(index);
    for (const index of wanted) {
      if (!tasks.has(index) && !failedPages.has(index)) {
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
      restoreAnchor(stableAnchor.anchor);
    }
  }

  function resize(nextScale, point) {
    if (!document || nextScale === scale) return;
    const anchor = captureAnchor(point);
    scale = nextScale;
    if (!slots.length) return;
    epoch++;
    for (const index of tasks.keys()) release(index);
    tasks = new Map();
    for (const slot of slots) {
      slot.style.width = `${Math.ceil(Number(slot.dataset.baseWidth) * scale)}px`;
      slot.style.height = `${Math.ceil(Number(slot.dataset.baseHeight) * scale)}px`;
    }
    restoreAnchor(anchor);
  }

  function retry() {
    failedPages.clear();
    loading.hidden = true;
    schedule();
  }

  scroll.addEventListener('scroll', schedule, { passive: true });
  return { clear, open, jump, resize, retry, schedule, captureAnchor, restoreAnchor, reflow };
}
