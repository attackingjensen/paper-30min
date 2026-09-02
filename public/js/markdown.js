// 轻量 Markdown 渲染器（覆盖 LLM 常见输出：标题/列表/表格/代码/引用/加粗等）

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  const math = [];
  // Markdown 的 * 和 _ 规则不能进入 TeX 表达式，否则公式会在 MathJax 处理前损坏。
  s = s.replace(/\\\([\s\S]+?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$\n])+?(?<!\\)\$/g, value => {
    math.push(value);
    return `\u0000MATH${math.length - 1}\u0000`;
  });
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。;；:：!！?？]|$)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\u0000MATH(\d+)\u0000/g, (_, index) => escapeHtml(math[Number(index)]));
  return out;
}

function renderTable(lines) {
  const rows = lines.filter(l => l.trim()).map(l => l.trim().replace(/^\||\|$/g, ''));
  if (rows.length < 2) return '';
  const cells = rows.map(r => r.split('|').map(c => c.trim()));
  const sepIdx = cells.findIndex(c => c.every(x => /^:?-{2,}:?$/.test(x)));
  const head = sepIdx === 1 ? cells[0] : null;
  const body = cells.slice(sepIdx >= 0 ? sepIdx + 1 : (head ? 1 : 0));
  let html = '<table>';
  if (head) html += '<thead><tr>' + head.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead>';
  html += '<tbody>' + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
  return html;
}

export function renderMarkdown(src) {
  if (!src) return '';
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 独立公式块。保留 TeX 定界符，交给 MathJax 统一排版。
    if (/^\s*(\$\$|\\\[)/.test(line)) {
      const opener = line.match(/^\s*(\$\$|\\\[)/)[1];
      const closer = opener === '$$' ? '$$' : '\\]';
      const buf = [line];
      i++;
      const closesOnSameLine = line.slice(line.indexOf(opener) + opener.length).includes(closer);
      if (!closesOnSameLine) {
        while (i < lines.length && !lines[i].includes(closer)) buf.push(lines[i++]);
        if (i < lines.length) buf.push(lines[i++]);
      }
      html.push(`<div class="math-block">${escapeHtml(buf.join('\n'))}</div>`);
      continue;
    }

    // 代码块
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // 跳过结尾 ```
      html.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // 表格
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const tbl = [line];
      i++;
      while (i < lines.length && lines[i].includes('|')) tbl.push(lines[i++]);
      html.push(renderTable(tbl));
      continue;
    }
    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    // 分割线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      html.push('<ul>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>');
      continue;
    }
    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      html.push('<ol>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ol>');
      continue;
    }
    // 空行
    if (!line.trim()) { i++; continue; }
    // 普通段落
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !lines[i].includes('|')) {
      buf.push(lines[i++]);
    }
    html.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return html.join('\n');
}

let mathTimer = null;

export function typesetMath(root) {
  if (!root) return;
  clearTimeout(mathTimer);
  mathTimer = setTimeout(() => {
    const mathJax = window.MathJax;
    if (!mathJax?.typesetPromise) return;
    mathJax.typesetClear?.([root]);
    mathJax.typesetPromise([root]).catch(error => console.warn('公式排版失败', error));
  }, 80);
}
