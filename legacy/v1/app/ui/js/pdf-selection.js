import { fragmentBinding } from './qa.js';

const normalize = value => String(value || '').normalize('NFKC').replace(/[\s\u00ad-]+/gu, '');
const overlap = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]))
  * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

export function regionSelection(start, end, pages) {
  const left = Math.min(start.x, end.x), top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x), bottom = Math.max(start.y, end.y);
  return pages.flatMap(page => {
    const x = Math.max(left, page.left), y = Math.max(top, page.top);
    const w = Math.min(right, page.left + page.width) - x;
    const h = Math.min(bottom, page.top + page.height) - y;
    if (w < 2 || h < 2) return [];
    return [{ page: page.page, bbox: [(x - page.left) * page.pageSize[0] / page.width * 2,
      (y - page.top) * page.pageSize[1] / page.height * 2, w * page.pageSize[0] / page.width * 2,
      h * page.pageSize[1] / page.height * 2], pageSize: page.pageSize }];
  });
}

export function selectionBinding(selection, mapped) {
  const blocks = (mapped?.sections || []).flatMap(section => section.blocks.map(block => ({ section, block })));
  const hits = [];
  let reliable = selection.kind === 'text';
  for (const selected of selection.regions) {
    const candidates = blocks.filter(({ block }) => block.sourceRegions?.some(region => region.page === selected.page
      && region.pageSize?.every((value, index) => Math.abs(value - selected.pageSize[index]) < 0.05)
      && overlap(region.bbox, selected.bbox) > (selection.kind === 'text' ? selected.bbox[2] * selected.bbox[3] * 0.5 : 0)));
    // Text rectangles must identify one source; area overlap is contextual, never an exact citation.
    if (candidates.length !== 1) reliable = false;
    for (const entry of candidates) if (!hits.some(hit => hit.secId === entry.section.id && hit.blockId === entry.block.id)) {
      hits.push({ secId: entry.section.id, blockId: entry.block.id });
    }
  }
  const positions = hits.map(hit => blocks.findIndex(({ section, block }) => section.id === hit.secId && block.id === hit.blockId)).sort((a, b) => a - b);
  const text = positions.map(position => blocks[position].block.text).join('\n');
  const needle = normalize(selection.text);
  const haystack = normalize(text);
  if (!needle || haystack.indexOf(needle) < 0 || haystack.indexOf(needle, haystack.indexOf(needle) + 1) >= 0
    || positions.some((position, index) => index && position !== positions[index - 1] + 1)) reliable = false;
  if (reliable && hits.length) {
    const binding = fragmentBinding(mapped, hits);
    return { ...binding, fragmentText: selection.text, pdfSelection: { ...selection } };
  }
  return { bindingKind: 'pdf', secId: null, fragmentText: selection.text || '', cite: null, assetIds: [],
    pdfSelection: { ...selection, hits } };
}

export function createPdfSelection({ scroll, pages, onSelection, onClear = () => {} }) {
  let tool = 'text';
  let drag = null;
  let active = null;
  let selecting = false;
  let textPointerId = null;
  const pageBoxes = () => [...pages.children].map(slot => {
    const box = slot.getBoundingClientRect();
    const wrap = scroll.getBoundingClientRect();
    return { page: Number(slot.dataset.page), left: box.left - wrap.left + scroll.scrollLeft, top: box.top - wrap.top + scroll.scrollTop, width: box.width, height: box.height,
      pageSize: [Number(slot.dataset.baseWidth), Number(slot.dataset.baseHeight)] };
  });
  const contentPoint = event => { const wrap = scroll.getBoundingClientRect(); return { x: event.clientX - wrap.left + scroll.scrollLeft, y: event.clientY - wrap.top + scroll.scrollTop }; };
  function paint(regions = []) {
    pages.querySelectorAll('.pdf-selection-highlight').forEach(node => node.remove());
    for (const region of regions) {
      const slot = pages.querySelector(`[data-page="${region.page}"]`);
      if (!slot) continue;
      const node = document.createElement('div');
      node.className = 'pdf-selection-highlight';
      const [x, y, w, h] = region.bbox;
      Object.assign(node.style, { left: `${x / (region.pageSize[0] * 2) * 100}%`, top: `${y / (region.pageSize[1] * 2) * 100}%`,
        width: `${w / (region.pageSize[0] * 2) * 100}%`, height: `${h / (region.pageSize[1] * 2) * 100}%` });
      slot.appendChild(node);
    }
  }
  function endDrag() {
    const previous = drag;
    drag = null;
    scroll.classList.remove('pdf-dragging');
    if (previous && scroll.hasPointerCapture?.(previous.id)) scroll.releasePointerCapture(previous.id);
    selecting = false;
    textPointerId = null;
  }
  function clear() {
    endDrag();
    active = null;
    paint();
    const selection = window.getSelection();
    if (selection?.anchorNode && pages.contains(selection.anchorNode)) selection.removeAllRanges();
    onClear();
  }
  function publish(selection) {
    active = selection;
    paint(selection.regions);
    onSelection(selection);
  }
  function readTextSelection() {
    const selected = window.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed || !pages.contains(selected.anchorNode)) return;
    const range = selected.getRangeAt(0);
    const regions = [], parts = [];
    for (const span of pages.querySelectorAll('.pdf-text-layer span')) {
      if (!span.firstChild || !range.intersectsNode(span)) continue;
      const piece = document.createRange();
      piece.selectNodeContents(span);
      if (range.compareBoundaryPoints(Range.START_TO_START, piece) > 0) piece.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, piece) < 0) piece.setEnd(range.endContainer, range.endOffset);
      const text = piece.toString();
      if (!text) continue;
      const slot = span.closest('.pdf-page');
      const box = slot.getBoundingClientRect();
      const pageSize = [Number(slot.dataset.baseWidth), Number(slot.dataset.baseHeight)];
      for (const rect of piece.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        regions.push({ page: Number(slot.dataset.page), bbox: [(rect.left - box.left) / box.width * pageSize[0] * 2,
          (rect.top - box.top) / box.height * pageSize[1] * 2, rect.width / box.width * pageSize[0] * 2,
          rect.height / box.height * pageSize[1] * 2], pageSize });
      }
      parts.push(text);
    }
    if (regions.length && parts.join('').trim()) publish({ kind: 'text', text: parts.join(' '), regions });
  }
  scroll.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.target.closest('.pdf-page')) return;
    clear();
    if (tool === 'text') { selecting = true; textPointerId = event.pointerId; return; }
    event.preventDefault();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: contentPoint(event), top: scroll.scrollTop, left: scroll.scrollLeft };
    scroll.setPointerCapture(event.pointerId);
    scroll.classList.toggle('pdf-dragging', tool === 'hand');
  });
  scroll.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (tool === 'hand') {
      scroll.scrollLeft = drag.left - (event.clientX - drag.x);
      scroll.scrollTop = drag.top - (event.clientY - drag.y);
    } else paint(regionSelection(drag.start, contentPoint(event), pageBoxes()));
  });
  scroll.addEventListener('pointerup', event => {
    if (drag && event.pointerId === drag.id && tool === 'area') {
      const regions = regionSelection(drag.start, contentPoint(event), pageBoxes());
      endDrag();
      if (regions.length) publish({ kind: 'area', text: '', regions });
    } else { endDrag(); if (tool === 'text') readTextSelection(); }
  });
  document.addEventListener('pointerup', event => { if (selecting && tool === 'text' && event.pointerId === textPointerId) { endDrag(); readTextSelection(); } });
  for (const event of ['pointercancel', 'lostpointercapture']) scroll.addEventListener(event, () => { if (drag) clear(); else selecting = false; });
  document.addEventListener('selectionchange', () => { if (!selecting && tool === 'text') readTextSelection(); });
  window.addEventListener('blur', () => { if (drag || selecting) clear(); });
  scroll.addEventListener('keydown', event => { if (event.key === 'Escape') clear(); });
  return { clear, repaint: () => { if (active) paint(active.regions); },
    setTool(value) { if (!['text', 'area', 'hand'].includes(value)) return; clear(); tool = value; scroll.dataset.pdfTool = tool; },
    pinnedPages() {
      if (selecting) {
        const selection = window.getSelection();
        const first = Number(selection?.anchorNode?.parentElement?.closest('.pdf-page')?.dataset.page);
        const last = Number(selection?.focusNode?.parentElement?.closest('.pdf-page')?.dataset.page);
        if (first && last) return Array.from({ length: Math.abs(last - first) + 1 }, (_, index) => Math.min(first, last) + index);
      }
      return active?.regions.map(region => region.page) || [];
    },
  };
}

export async function selectionImages(doc, selection) {
  const images = [];
  for (const region of selection.regions) {
    const page = await doc.getPage(region.page);
    const [x, y, width, height] = region.bbox.map(value => value / 2);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('选区坐标无效');
    const base = page.getViewport({ scale: 1 });
    if (base.rotation !== 0 || Math.abs(base.width - region.pageSize[0]) > 0.05 || Math.abs(base.height - region.pageSize[1]) > 0.05) throw new Error('页面坐标已变化');
    const factor = Math.min(2, 1600 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * factor); canvas.height = Math.ceil(height * factor);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: factor }),
      transform: [1, 0, 0, 1, -x * factor, -y * factor] }).promise;
    images.push({ page: region.page, dataUrl: canvas.toDataURL('image/webp', 0.9) });
    canvas.width = canvas.height = 0;
  }
  return images;
}
