import assert from 'node:assert/strict';
import test from 'node:test';

import { renderStreamingTextInto, typesetMath } from '../ui/js/markdown.js';

test('流式公式只追加文本，不替换已输出的节点', () => {
  const classes = new Set();
  const element = {
    classList: { add: value => classes.add(value), contains: value => classes.has(value) },
    firstChild: null,
    set textContent(value) {
      this.firstChild = { nodeType: 3, data: value, appendData(part) { this.data += part; } };
    },
    get textContent() { return this.firstChild?.data ?? ''; },
    set innerHTML(_) { throw new Error('流式阶段不应重写 HTML'); },
  };

  renderStreamingTextInto(element, '前文 $');
  const firstNode = element.firstChild;
  renderStreamingTextInto(element, '前文 $x');
  renderStreamingTextInto(element, '前文 $x$ 后续');

  assert.equal(element.firstChild, firstNode);
  assert.equal(element.textContent, '前文 $x$ 后续');
  assert.equal(classes.has('streaming-text'), true);
});

test('一个区域的流式更新不取消其他区域的公式排版', async () => {
  const typeset = [];
  globalThis.window = { MathJax: { typesetPromise: roots => { typeset.push(roots[0]); return Promise.resolve(); } } };
  const finished = {};
  const streaming = {
    classList: { contains: () => false, add() {} },
    set textContent(_) {},
  };
  try {
    typesetMath(finished);
    typesetMath(streaming);
    renderStreamingTextInto(streaming, '生成中');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.deepEqual(typeset, [finished]);
  } finally {
    delete globalThis.window;
  }
});

test('外部替换容器文本后，下一片流式内容恢复累计全文', () => {
  const classes = new Set();
  const element = {
    classList: { add: value => classes.add(value), contains: value => classes.has(value) },
    firstChild: null,
    set textContent(value) {
      this.firstChild = { nodeType: 3, data: value, appendData(part) { this.data += part; } };
    },
    get textContent() { return this.firstChild?.data ?? ''; },
  };

  renderStreamingTextInto(element, '译文 $x');
  element.textContent = '尚未翻译。';
  renderStreamingTextInto(element, '译文 $x$ 已完成');

  assert.equal(element.textContent, '译文 $x$ 已完成');
});
