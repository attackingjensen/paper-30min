import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionBinding, regionSelection } from '../ui/js/pdf-selection.js';

const mapped = { sections: [{ id: 'sec_1', blocks: [
  { id: 1, page: 1, text: 'The selected phrase belongs to this paragraph.', sourceRegions: [
    { page: 1, bbox: [40, 100, 500, 80], pageSize: [600, 800] },
    { page: 2, bbox: [40, 100, 500, 80], pageSize: [600, 800] },
  ] },
  { id: 2, page: 2, text: 'Another paragraph with a figure.', assetId: 'fig_1', sourceRegions: [
    { page: 2, bbox: [40, 220, 500, 80], pageSize: [600, 800] },
  ] },
] }], figures: [{ id: 'fig_1', page: 2, bbox: [40, 220, 500, 80] }], tables: [] };
const selection = { kind: 'text', text: 'selected phrase', regions: [{ page: 1, bbox: [50, 110, 200, 24], pageSize: [600, 800] }] };

test('partial PDF text binds to its source block without expanding the user quote', () => {
  const binding = selectionBinding(selection, mapped);
  assert.equal(binding.bindingKind, 'fragment');
  assert.equal(binding.fragmentText, 'selected phrase');
  assert.equal(binding.cite.startBlock, 1);
  assert.deepEqual(binding.pdfSelection, selection);
});
test('geometry ambiguity or unmatched text is not promoted to a block citation', () => {
  const duplicate = structuredClone(mapped);
  duplicate.sections[0].blocks.push({ ...duplicate.sections[0].blocks[0], id: 3 });
  assert.equal(selectionBinding(selection, duplicate).cite, null);
  assert.equal(selectionBinding({ ...selection, text: 'unrelated text' }, mapped).cite, null);
});
test('area selection keeps multiple independent hits and permits screenshot-only questions', () => {
  const area = { kind: 'area', text: '', regions: [{ page: 2, bbox: [40, 100, 500, 200], pageSize: [600, 800] }] };
  const binding = selectionBinding(area, mapped);
  assert.equal(binding.bindingKind, 'pdf');
  assert.equal(binding.cite, null);
  assert.deepEqual(binding.pdfSelection.hits.map(hit => hit.blockId), [1, 2]);
  assert.equal(selectionBinding(area, { sections: [] }).bindingKind, 'pdf');
});
test('region selection clips each page separately and excludes the page gap', () => {
  assert.deepEqual(regionSelection({ x: 20, y: 700 }, { x: 250, y: 1000 }, [
    { page: 1, left: 0, top: 0, width: 600, height: 800, pageSize: [600, 800] },
    { page: 2, left: 0, top: 812, width: 600, height: 800, pageSize: [600, 800] },
  ]), [
    { page: 1, bbox: [40, 1400, 460, 200], pageSize: [600, 800] },
    { page: 2, bbox: [40, 0, 460, 376], pageSize: [600, 800] },
  ]);
});
