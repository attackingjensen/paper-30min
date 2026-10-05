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
  if (blocks.some(block => !validPage(block.page) || block.assetId)) return { page };
  if (blocks.every(block => Array.isArray(block.sourceRegions) && block.sourceRegions.length)) {
    const sourceRegions = blocks.flatMap(block => block.sourceRegions);
    if (sourceRegions.every(region => validPage(region.page)) && sourceRegions[0].page === page) return { page, sourceRegions };
    return { page };
  }
  const last = blocks.at(-1);
  const next = section.blocks.find(block => block.id === pointer.end + 1);
  // Old block DTOs store only the first page; neighboring metadata bounds a search, not a highlight.
  let pageEnd = last.pageEnd ?? next?.page ?? section.pageEnd ?? last.page;
  // A section-final paragraph may continue even when section metadata only records its first page.
  if (!last.pageEnd && pageEnd === last.page && validPage(last.page + 1) && mapped?.pageCount) pageEnd++;
  if (!validPage(pageEnd) || pageEnd < page || blocks.some(block => block.page < page || block.page > pageEnd)) return { page };
  const target = { page, ...(pageEnd > page ? { pageEnd } : {}), text: blocks.map(block => block.text || '').join('\n') };
  if (blocks.some(block => block.page !== page)) {
    const segments = [];
    for (const block of blocks) {
      if (segments.at(-1)?.page === block.page) segments.at(-1).text += `\n${block.text || ''}`;
      else segments.push({ page: block.page, text: block.text || '' });
    }
    if (segments.some((segment, index) => index && segment.page < segments[index - 1].page)) return { page };
    target.segments = segments.map((segment, index) => ({ ...segment, pageEnd: segments[index + 1]?.page ?? pageEnd }));
  }
  return target;
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
  return evidenceRangeRects({ page: 1, text: target.text }, [{ page: 1, viewport, content }])[0]?.rects ?? [];
}

export function evidenceRangeRects(target, pages) {
  if (target.sourceRegions) {
    const regions = new Map();
    for (const region of target.sourceRegions) {
      const viewport = pages.find(info => info.page === region.page)?.viewport;
      if (!viewport || viewport.rotation !== 0 || !Array.isArray(region.pageSize) || region.pageSize.length !== 2
        || !region.pageSize.every(value => Number.isFinite(value) && value > 0)
        || Math.abs(viewport.width - region.pageSize[0]) > 0.05 || Math.abs(viewport.height - region.pageSize[1]) > 0.05
        || !Array.isArray(region.bbox) || region.bbox.length !== 4) return [];
      const rect = region.bbox.map(value => value / 2);
      if (!inside(rect, viewport)) return [];
      if (!regions.has(region.page)) regions.set(region.page, []);
      regions.get(region.page).push(rect);
    }
    return [...regions].map(([page, rects]) => ({ page, rects }));
  }
  if (target.segments) {
    const regions = new Map();
    for (const segment of target.segments) {
      const matches = evidenceRangeRects(segment, pages.filter(info => info.page >= segment.page && info.page <= segment.pageEnd));
      if (!matches.length) return [];
      for (const { page, rects } of matches) {
        if (!regions.has(page)) regions.set(page, []);
        const previous = regions.get(page);
        if (rects.some(rect => previous.some(other => rect.every((value, index) => value === other[index])))) return [];
        previous.push(...rects);
      }
    }
    return [...regions].map(([page, rects]) => ({ page, rects }));
  }
  const needle = normalize(target.text);
  if (needle.length < 12) return [];
  const items = pages.flatMap(info => (info.content?.items ?? [])
    .filter(item => typeof item.str === 'string' && normalize(item.str)).map(item => ({ item, info })));
  const strings = items.map(({ item }) => normalize(item.str));
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
  if (selected[0]?.info.page !== target.page) return [];
  const regions = new Map();
  for (const { item, info } of selected) {
    const { viewport, content } = info;
    if (viewport.rotation !== 0) return [];
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
    if (!regions.has(info.page)) regions.set(info.page, []);
    regions.get(info.page).push(rect);
  }
  return [...regions].map(([page, rects]) => ({ page, rects }));
}
