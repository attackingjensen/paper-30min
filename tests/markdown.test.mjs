import assert from 'node:assert/strict';
import test from 'node:test';

import { renderMarkdown } from '../public/js/markdown.js';

test('renderMarkdown keeps the header of a standard Markdown table', () => {
  const html = renderMarkdown('| Name | Score |\n| --- | --- |\n| A | 1 |');

  assert.equal(
    html,
    '<table><thead><tr><th>Name</th><th>Score</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>',
  );
});

test('renderMarkdown keeps ordinary pipe-delimited text as paragraphs', () => {
  assert.equal(renderMarkdown('Name | Score'), '<p>Name | Score</p>');
});
