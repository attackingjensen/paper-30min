import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceTarget, evidenceRects, evidenceRangeRects } from '../ui/js/pdf-evidence.js';
import { parseRefs } from '../ui/js/protocol.js';

const viewport = { width: 600, height: 800, rotation: 0, transform: [1, 0, 0, -1, 0, 800] };
const item = (str, x = 20, y = 700) => ({ str, width: 120, height: 12, transform: [12, 0, 0, 12, x, y], dir: 'ltr', fontName: 'font' });
const styles = { font: { ascent: 1, descent: 0 } };
test('source regions preserve columns and pages without matching PDF text', () => {
  const sourceRegions = [
    { page: 1, bbox: [40, 1400, 500, 80], pageSize: [600, 800] },
    { page: 1, bbox: [640, 100, 500, 120], pageSize: [600, 800] },
    { page: 2, bbox: [40, 100, 500, 120], pageSize: [600, 800] },
  ];
  const mapped = { pageCount: 2, sections: [{ id: 'sec_1', blocks: [{ id: 1, page: 1, text: 'different normalized text', sourceRegions }] }] };
  const target = evidenceTarget(parseRefs('(sec_1:L1)')[0], mapped);
  assert.deepEqual(target, { page: 1, sourceRegions });
  const pages = [{ page: 1, viewport }, { page: 2, viewport }];
  assert.deepEqual(evidenceRangeRects(target, pages), [
    { page: 1, rects: [[20, 700, 250, 40], [320, 50, 250, 60]] },
    { page: 2, rects: [[20, 50, 250, 60]] },
  ]);
  assert.deepEqual(evidenceRangeRects(target, pages.slice(0, 1)), []);
  assert.deepEqual(evidenceRangeRects(target, [pages[0], { page: 2, viewport: { ...viewport, width: 601 } }]), []);
});
test('asset boxes use the stored scale=2 contract and reject out-of-page or rotated geometry', () => {
  assert.deepEqual(evidenceRects({ bbox: [100, 200, 400, 100] }, viewport), [[50, 100, 200, 50]]);
  assert.deepEqual(evidenceRects({ bbox: [1000, 200, 400, 100] }, viewport), []);
  assert.deepEqual(evidenceRects({ bbox: [100, 200, -4, 100] }, viewport), []);
  assert.deepEqual(evidenceRects({ bbox: [100, 200, 400, 100] }, { ...viewport, rotation: 90 }), []);
});
test('text highlights require one complete match with verified horizontal geometry', () => {
  const target = { text: 'Unique evidence text' };
  assert.deepEqual(evidenceRects(target, viewport, { styles, items: [item('Unique evidence text')] }), [[20, 88, 120, 12]]);
  assert.deepEqual(evidenceRects(target, viewport, { styles, items: [item('Unique evidence text'), item('Unique evidence text', 20, 600)] }), []);
  assert.deepEqual(evidenceRects({ text: 'evidence' }, viewport, { items: [item('Unique evidence text')] }), []);
  assert.deepEqual(evidenceRects(target, viewport, { items: [] }), []);
});
test('block citations retain text and a bounded candidate range across pages', () => {
  const mapped = { pageCount: 2, sections: [{ id: 'sec_1_intro', blocks: [
    { id: 1, text: 'first', page: 1 }, { id: 2, text: 'second', page: 2 },
  ] }] };
  assert.deepEqual(evidenceTarget(parseRefs('(sec_1:L1-2)')[0], mapped), { page: 1, pageEnd: 2, text: 'first\nsecond', segments: [
    { page: 1, pageEnd: 2, text: 'first' }, { page: 2, pageEnd: 2, text: 'second' },
  ] });
  assert.equal(evidenceTarget(parseRefs('(p0)')[0], mapped), null);
  assert.equal(evidenceTarget(parseRefs('(sec_1:L3)')[0], mapped), null);
  assert.deepEqual(evidenceTarget(parseRefs('(p2)')[0], mapped), { page: 2 });
});

test('a block with only its first page uses the next block or section end as a search bound', () => {
  const mapped = { pageCount: 4, sections: [{ id: 'sec_1', pageEnd: 4, blocks: [
    { id: 1, page: 1, text: 'A paragraph continued on another page' },
    { id: 2, page: 3, text: 'The last paragraph' },
  ] }] };
  assert.equal(evidenceTarget(parseRefs('(sec_1:L1)')[0], mapped).pageEnd, 3);
  assert.equal(evidenceTarget(parseRefs('(sec_1:L2)')[0], mapped).pageEnd, 4);
  mapped.sections[0].blocks[0].assetId = 'tbl_1';
  assert.deepEqual(evidenceTarget(parseRefs('(sec_1:L1)')[0], mapped), { page: 1 });
  const finalBlock = { pageCount: 2, sections: [{ id: 'sec_2', pageEnd: 1, blocks: [{ id: 1, page: 1, text: 'A continued paragraph' }] }] };
  assert.equal(evidenceTarget(parseRefs('(sec_2:L1)')[0], finalBlock).pageEnd, 2);
});

test('multi-page text matches complete items once, preserving each page geometry', () => {
  const pages = [
    { page: 1, viewport, content: { styles, items: [item('Unrelated heading'), item('Unique evidence', 20, 100)] } },
    { page: 2, viewport, content: { styles, items: [item('continued on next page', 30, 700), item('Unrelated ending')] } },
  ];
  const target = { page: 1, text: 'Unique evidence continued on next page' };
  assert.deepEqual(evidenceRangeRects(target, pages), [
    { page: 1, rects: [[20, 688, 120, 12]] },
    { page: 2, rects: [[30, 88, 120, 12]] },
  ]);
  assert.deepEqual(evidenceRangeRects({ ...target, text: 'Unique evidence continued on next' }, pages), []);
  pages[1].content.items.unshift(item('Page header'));
  assert.deepEqual(evidenceRangeRects(target, pages), []);
  pages[1].content.items.shift();
  pages[1].viewport = { ...viewport, rotation: 90 };
  assert.deepEqual(evidenceRangeRects(target, pages), []);
});

test('separate blocks on different pages match independently around page furniture', () => {
  const target = { page: 1, text: 'Unique evidence\ncontinued on next page', segments: [
    { page: 1, pageEnd: 2, text: 'Unique evidence' },
    { page: 2, pageEnd: 2, text: 'continued on next page' },
  ] };
  const pages = [
    { page: 1, viewport, content: { styles, items: [item('Unique evidence'), item('Footer')] } },
    { page: 2, viewport, content: { styles, items: [item('Header'), item('continued on next page')] } },
  ];
  assert.deepEqual(evidenceRangeRects(target, pages), [
    { page: 1, rects: [[20, 88, 120, 12]] }, { page: 2, rects: [[20, 88, 120, 12]] },
  ]);
  pages[1].content.items.push(item('continued on next page', 20, 600));
  assert.deepEqual(evidenceRangeRects(target, pages), []);
});
