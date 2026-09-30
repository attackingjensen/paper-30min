import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceTarget, evidenceRects } from '../ui/js/pdf-evidence.js';
import { parseRefs } from '../ui/js/protocol.js';

const viewport = { width: 600, height: 800, rotation: 0, transform: [1, 0, 0, -1, 0, 800] };
const item = (str, x = 20, y = 700) => ({ str, width: 120, height: 12, transform: [12, 0, 0, 12, x, y], dir: 'ltr', fontName: 'font' });
const styles = { font: { ascent: 1, descent: 0 } };
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
test('invalid references have no target; multi-page blocks retain only the trusted first page', () => {
  const mapped = { pageCount: 2, sections: [{ id: 'sec_1_intro', blocks: [
    { id: 1, text: 'first', page: 1 }, { id: 2, text: 'second', page: 2 },
  ] }] };
  assert.deepEqual(evidenceTarget(parseRefs('(sec_1:L1-2)')[0], mapped), { page: 1 });
  assert.equal(evidenceTarget(parseRefs('(p0)')[0], mapped), null);
  assert.equal(evidenceTarget(parseRefs('(sec_1:L3)')[0], mapped), null);
  assert.deepEqual(evidenceTarget(parseRefs('(p2)')[0], mapped), { page: 2 });
});
