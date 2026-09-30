// Book-library asset boxes are PDF.js viewport coordinates at scale=2.
export function evidenceTarget(pointer, mapped, currentSecId = null) {
  const validPage = page => Number.isInteger(page) && page >= 1 && (!mapped?.pageCount || page <= mapped.pageCount);
  if (pointer?.kind === 'page') return validPage(pointer.page) ? { page: pointer.page } : null;
  if (pointer?.kind === 'figure' || pointer?.kind === 'table') {
    const asset = (pointer.kind === 'figure' ? mapped?.figures : mapped?.tables)?.find(item => item.id === pointer.assetId);
    return asset && validPage(asset.page) ? { page: asset.page, bbox: asset.bbox } : null;
  }
  if (pointer?.kind !== 'blocks') return null;
  const secId = pointer.secId || currentSecId;
  const sections = mapped?.sections ?? [];
  const exact = sections.find(section => section.id === secId);
  const matches = sections.filter(section => section.id.startsWith(`${secId}_`));
  const section = exact || (matches.length === 1 ? matches[0] : null);
  if (!section || !Number.isInteger(pointer.start) || !Number.isInteger(pointer.end) || pointer.start < 1 || pointer.end < pointer.start) return null;
  const blocks = section.blocks.filter(block => block.id >= pointer.start && block.id <= pointer.end);
  if (blocks.length !== pointer.end - pointer.start + 1 || !validPage(blocks[0]?.page)) return null;
  const page = blocks[0].page;
  if (blocks.some(block => block.page !== page || (block.pageEnd && block.pageEnd !== page) || block.assetId)) return { page };
  return { page, text: blocks.map(block => block.text || '').join('\n') };
}

function inside(rect, viewport) {
  const [x, y, width, height] = rect;
  return rect.every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0
    && x + width <= viewport.width + 0.01 && y + height <= viewport.height + 0.01;
}

const normalize = text => String(text ?? '').normalize('NFKC').replace(/\s+/gu, '');

export function evidenceRects(target, viewport, content = null) {
  if (viewport.rotation !== 0) return [];
  if (target.bbox) {
    if (!Array.isArray(target.bbox) || target.bbox.length !== 4 || !target.bbox.every(Number.isFinite)) return [];
    const rect = target.bbox.map(value => value / 2);
    return inside(rect, viewport) ? [rect] : [];
  }
  const needle = normalize(target.text);
  if (needle.length < 12) return [];
  const items = (content?.items ?? []).filter(item => typeof item.str === 'string' && normalize(item.str));
  const strings = items.map(item => normalize(item.str));
  const text = strings.join('');
  const start = text.indexOf(needle);
  if (start < 0 || text.indexOf(needle, start + 1) !== -1) return [];
  let offset = 0;
  const selected = [];
  for (const [index, item] of items.entries()) {
    const end = offset + strings[index].length;
    if (end > start && offset < start + needle.length) {
      // Partial glyph widths are not trustworthy: require complete PDF text items.
      if (offset < start || end > start + needle.length) return [];
      selected.push(item);
    }
    offset = end;
  }
  const rects = [];
  for (const item of selected) {
    const t = item.transform;
    const v = viewport.transform;
    if (!t || !v || t.length !== 6 || v.length !== 6 || !t.every(Number.isFinite) || !v.every(Number.isFinite)
      || t[0] <= 0 || t[3] <= 0 || t[1] !== 0 || t[2] !== 0 || item.dir !== 'ltr') return [];
    const x = v[0] * t[4] + v[2] * t[5] + v[4];
    const y = v[1] * t[4] + v[3] * t[5] + v[5];
    const font = content.styles?.[item.fontName];
    if (!Number.isFinite(font?.ascent) || !Number.isFinite(font?.descent)
      || font.ascent <= 0 || font.descent > 0 || font.ascent - font.descent > 2) return [];
    const rect = [x, y - font.ascent * item.height, item.width, (font.ascent - font.descent) * item.height];
    if (!inside(rect, viewport)) return [];
    rects.push(rect);
  }
  return rects;
}
