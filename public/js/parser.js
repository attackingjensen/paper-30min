// PDF 解析与章节切分
// 1) 用 pdf.js 逐页提取文本，处理双栏排版（标题/摘要等通栏内容作为分隔带）
// 2) 按标题规则切出 Abstract / Introduction / Related Work / Method / Experiments / Conclusion
// 3) 提取论文标题

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.js', import.meta.url).href;
}

// ---------------- 页面文本提取 ----------------

function itemsToLines(items) {
  // items: [{str, x, y, h}]，按 y 从大到小聚类成行，行内按 x 排序
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = null;
  for (const it of sorted) {
    if (!it.str.trim()) continue;
    if (!cur) { cur = [it]; continue; }
    const refY = cur[0].y;
    const tol = Math.max(2.5, (cur[0].h || 8) * 0.45);
    if (Math.abs(refY - it.y) <= tol) cur.push(it);
    else { lines.push(cur); cur = [it]; }
  }
  if (cur) lines.push(cur);
  return lines.map(group => {
    group.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    for (const it of group) {
      if (prevEnd !== null) {
        const gap = it.x - prevEnd;
        if (gap > 1.2) text += ' ';
      }
      text += it.str;
      prevEnd = it.x + it.w;
    }
    return text.replace(/\s+/g, ' ').trim();
  }).filter(t => t.length);
}

function itemsToLineObjects(items, pageWidth) {
  const sorted = [...items].filter(it => it.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  let row = [];
  for (const item of sorted) {
    if (!row.length) {
      row.push(item);
      continue;
    }
    const tolerance = Math.max(2.5, (row[0].h || 8) * 0.45);
    if (Math.abs(row[0].y - item.y) <= tolerance) row.push(item);
    else {
      rows.push(row);
      row = [item];
    }
  }
  if (row.length) rows.push(row);

  const lines = [];
  for (const itemsInRow of rows) {
    itemsInRow.sort((a, b) => a.x - b.x);
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const x = group[0].x;
      const end = Math.max(...group.map(it => it.x + it.w));
      lines.push({
        text: itemsToLines(group)[0] || '', x, y: group[0].y,
        w: end - x, h: Math.max(...group.map(it => it.h || 8)),
        fontNames: [...new Set(group.map(it => it.fontName).filter(Boolean))],
      });
      group = [];
    };
    for (const item of itemsInRow) {
      const prevEnd = group.length ? Math.max(...group.map(it => it.x + it.w)) : null;
      // 同一高度的左右栏需要拆开；普通单词间距远小于页面宽度的 6%。
      if (prevEnd !== null && item.x - prevEnd > Math.max(24, pageWidth * 0.06)) flush();
      group.push(item);
    }
    flush();
  }
  return lines.filter(line => line.text);
}

function extractPageLines(items, pageWidth) {
  const lines = itemsToLineObjects(items, pageWidth);
  const narrow = lines.filter(line => line.w < pageWidth * 0.46);
  const cx = pageWidth / 2;
  const leftCount = narrow.filter(line => line.x + line.w / 2 < cx).length;
  const rightCount = narrow.filter(line => line.x + line.w / 2 >= cx).length;
  const isTwoColumn = leftCount >= 8 && rightCount >= 8 && (leftCount + rightCount) >= lines.length * 0.45;

  if (!isTwoColumn) {
    return lines.sort((a, b) => b.y - a.y || a.x - b.x);
  }

  const fullWidth = lines.filter(line => line.w >= pageWidth * 0.52);
  const columns = lines.filter(line => line.w < pageWidth * 0.52);
  fullWidth.sort((a, b) => b.y - a.y);
  const bands = new Map();
  for (const line of columns) {
    const bandIdx = fullWidth.filter(full => full.y > line.y).length;
    if (!bands.has(bandIdx)) bands.set(bandIdx, { left: [], right: [] });
    const band = bands.get(bandIdx);
    ((line.x + line.w / 2) < cx ? band.left : band.right).push(line);
  }
  const fwByBand = new Map();
  for (const line of fullWidth) {
    const bandIdx = fullWidth.filter(other => other.y > line.y).length;
    if (!fwByBand.has(bandIdx)) fwByBand.set(bandIdx, []);
    fwByBand.get(bandIdx).push(line);
  }
  const allBandIdx = [...new Set([...bands.keys(), ...fwByBand.keys()])].sort((a, b) => a - b);
  const out = [];
  for (const bi of allBandIdx) {
    const fwLines = (fwByBand.get(bi) || []).sort((a, b) => b.y - a.y || a.x - b.x);
    out.push(...fwLines);
    const band = bands.get(bi);
    if (band) {
      out.push(...band.left.sort((a, b) => b.y - a.y));
      out.push(...band.right.sort((a, b) => b.y - a.y));
    }
  }
  return out;
}

async function getPageItems(page) {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const items = [];
  for (const it of content.items) {
    if (!it.str) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = it.height || Math.abs(it.transform[3]) || 8;
    items.push({ str: it.str, x, y, w: it.width, h, fontName: it.fontName || '' });
  }
  return { items, pageWidth: viewport.width, pageHeight: viewport.height };
}

function extractTitle(firstPageData) {
  const { items, pageHeight } = firstPageData;
  // 页面上部 40% 区域内的最大字号文本视为标题
  const top = items.filter(it => it.y > pageHeight * 0.58 && it.str.trim());
  if (!top.length) return '';
  const maxH = Math.max(...top.map(it => it.h));
  const titleItems = top.filter(it => it.h >= maxH * 0.8);
  const lines = itemsToLines(titleItems);
  const title = lines.join(' ').replace(/\s+/g, ' ').trim();
  return title.slice(0, 300);
}

// ---------------- 章节切分 ----------------

const SECTION_NUMBER = String.raw`(?:(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)]?\s*)?`;

const HEADING_RULES = [
  { type: 'abstract',     re: /^(?:abstract|摘\s*要)\.?$/i },
  { type: 'introduction', re: new RegExp(`^${SECTION_NUMBER}introduction\\s*$`, 'i') },
  { type: 'related',      re: new RegExp(`^${SECTION_NUMBER}(related\\s+works?|background(?:\\s+and\\s+related\\s+work)?|previous\\s+work|相关(?:工作|研究))\\s*[:.]?$`, 'i') },
  { type: 'method',       re: new RegExp(`^${SECTION_NUMBER}(?:the\\s+|our\\s+|proposed\\s+)?(methods?|methodology|approach|framework|model|architecture|system(?:\\s+design)?|technical\\s+approach)(?:\\s+and\\s+(?:methods?|approach))?\\s*$`, 'i') },
  { type: 'experiments',  re: new RegExp(`^${SECTION_NUMBER}(experiments?(?:\\s+(?:and|on|with|for)\\s+.{1,50})?|experimental\\s+(?:results|evaluation|setup|study)|results(?:\\s+and\\s+(?:analysis|discussion))?|evaluation(?:\\s+(?:results|setup|benchmarks?))?|empirical\\s+(?:results|evaluation|study)|实验(?:结果|设置|评估)?)\\s*$`, 'i') },
  { type: 'conclusion',   re: new RegExp(`^${SECTION_NUMBER}(conclusions?|concluding\\s+remarks|discussion\\s+and\\s+conclusion|summary)\\.?$`, 'i') },
  { type: 'references',   re: /^(references|bibliography|参考文献)\.?$/i },
  { type: 'end',          re: /^(acknowledg(e)?ments?|appendix(?:\s+[a-z])?|broader\s+impact|limitations)\s*$/i },
];

function normalizeHeading(text) {
  return String(text)
    .replace(/[\u00a0\u2000-\u200b]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^([0-9]+(?:\.[0-9]+)*|[ivxlcdm]+)\s*[.:]\s+(?=[A-Z])/i, '$1 ')
    .trim();
}

function detectHeadings(lines) {
  const found = [];
  lines.forEach((l, idx) => {
    const t = normalizeHeading(l.text);
    if (!t || t.length > 80) return;
    for (const rule of HEADING_RULES) {
      if (rule.re.test(t)) { found.push({ idx, type: rule.type, text: t }); break; }
    }
  });
  return found;
}

function semanticHeadingType(text) {
  const normalized = normalizeHeading(text);
  for (const rule of HEADING_RULES) {
    if (rule.re.test(normalized)) return rule.type;
  }
  return '';
}

function detectNumberedParts(lines, headings) {
  const candidates = [];
  lines.forEach((line, idx) => {
    const text = normalizeHeading(line.text);
    const match = text.match(/^(\d{1,2}|[ivxlcdm]+)[.)]?\s+(.{2,90})$/i);
    if (!match) return;
    const numeric = /^\d+$/.test(match[1]) ? Number(match[1]) : null;
    const title = match[2].trim().replace(/[.:]\s*$/, '');
    if ((numeric !== null && (numeric < 1 || numeric > 50)) || title.split(/\s+/).length > 14) return;
    if (/[!?。！？]$/.test(title)) return;
    const hasLayout = Number.isFinite(line.h) && Number.isFinite(line.bodySize);
    const isLargeHeading = !hasLayout || line.h >= Math.max(line.bodySize * 1.18, line.bodySize + 1.6);
    if (!isLargeHeading) return;
    candidates.push({ idx, text, title, type: semanticHeadingType(text) });
  });

  const bodyCandidates = candidates.filter(candidate =>
    !['abstract', 'references', 'end'].includes(candidate.type));
  const parts = [];
  for (const candidate of bodyCandidates) {
    const nextCandidate = candidates.find(other => other.idx > candidate.idx);
    const semanticStop = headings.find(heading =>
      heading.idx > candidate.idx && ['references', 'end'].includes(heading.type));
    const endIdx = Math.min(nextCandidate?.idx ?? lines.length, semanticStop?.idx ?? lines.length);
    const bodyLines = lines.slice(candidate.idx + 1, endIdx);
    const text = bodyLines.map(line => line.text).join('\n').trim();
    // 目录中的标题通常连续出现、没有正文；过滤它们，只保留真正的章节。
    if (text.length < 120) continue;
    const pages = lines.slice(candidate.idx, endIdx).map(line => line.page).filter(page => page > 0);
    parts.push({
      id: `part-${parts.length + 1}`,
      title: candidate.title,
      heading: candidate.text,
      semanticType: candidate.type || 'part',
      text,
      pageRange: pages.length ? { start: Math.min(...pages), end: Math.max(...pages) } : null,
      sourceRange: { start: candidate.idx, end: endIdx },
    });
  }
  return parts;
}

function inferAbstract(lines, headings) {
  const intro = headings.find(h => h.type === 'introduction');
  if (!intro || intro.idx < 2) return '';

  const beforeIntro = lines.slice(0, intro.idx);
  const runs = [];
  let run = [];
  const flush = () => {
    if (run.length) runs.push(run);
    run = [];
  };

  for (const line of beforeIntro) {
    const text = line.text.trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    const excluded = /^(?:arxiv:|https?:|www\.|website:|github:|code:|equal contribution|project lead|corresponding author)/i.test(text);
    const prose = !excluded && (words >= 9 || text.length >= 85);
    if (prose) run.push(text);
    else flush();
  }
  flush();

  const candidates = runs
    .map(parts => ({
      text: parts.join(' ').replace(/\s+/g, ' ').trim(),
      score: parts.join(' ').length + (parts.join(' ').match(/[.!?](?:\s|$)/g) || []).length * 80,
    }))
    .filter(candidate => candidate.text.length >= 180);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.text || '';
}

function sliceSection(headings, lines, type, stopTypes, afterIdx = -1, maxLines = 800) {
  const start = headings.find(h => h.type === type && h.idx > afterIdx);
  if (!start) return '';
  const stop = headings.find(h => h.idx > start.idx && stopTypes.includes(h.type));
  const end = stop ? stop.idx : Math.min(start.idx + maxLines, lines.length);
  return lines.slice(start.idx + 1, end).map(l => l.text).join('\n').trim();
}

function sectionPageRange(headings, lines, type, stopTypes, afterIdx = -1, maxLines = 800) {
  const start = headings.find(h => h.type === type && h.idx > afterIdx);
  if (!start) return null;
  const stop = headings.find(h => h.idx > start.idx && stopTypes.includes(h.type));
  const end = stop ? stop.idx : Math.min(start.idx + maxLines, lines.length);
  const pages = lines.slice(start.idx, end).map(line => line.page).filter(page => page > 0);
  return pages.length ? { start: Math.min(...pages), end: Math.max(...pages) } : null;
}

function fixHyphenation(lines) {
  // 合并行尾连字符断词：algo-\nrithm → algorithm
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i];
    let t = lines[i].text;
    while (/[a-zA-Z]-$/.test(t) && i + 1 < lines.length && lines[i + 1].page === first.page && /^[a-z]/.test(lines[i + 1].text)) {
      t = t.replace(/-$/, '') + lines[i + 1].text;
      i++;
    }
    out.push({ ...first, text: t });
  }
  return out;
}

export function splitTextToSections(rawLines) {
  const lines = fixHyphenation(rawLines.map(l => ({ ...l, text: String(l.text).trim(), page: l.page ?? 0 }))).filter(l => l.text);
  const headings = detectHeadings(lines);
  const STOP_MAIN = ['method', 'experiments', 'conclusion', 'references', 'end'];
  const sections = {
    abstract: sliceSection(headings, lines, 'abstract', ['introduction', 'related', ...STOP_MAIN], -1, 120),
    introduction: sliceSection(headings, lines, 'introduction', ['method', 'experiments', 'conclusion', 'references', 'end']),
    method: sliceSection(headings, lines, 'method', ['experiments', 'conclusion', 'references', 'end']),
    experiments: sliceSection(headings, lines, 'experiments', ['related', 'conclusion', 'references', 'end']),
    conclusion: sliceSection(headings, lines, 'conclusion', ['references', 'end'], -1, 250),
  };
  const sectionPages = {
    abstract: sectionPageRange(headings, lines, 'abstract', ['introduction', 'related', ...STOP_MAIN], -1, 120),
    introduction: sectionPageRange(headings, lines, 'introduction', ['method', 'experiments', 'conclusion', 'references', 'end']),
    method: sectionPageRange(headings, lines, 'method', ['experiments', 'conclusion', 'references', 'end']),
    experiments: sectionPageRange(headings, lines, 'experiments', ['related', 'conclusion', 'references', 'end']),
    conclusion: sectionPageRange(headings, lines, 'conclusion', ['references', 'end'], -1, 250),
  };
  const parts = detectNumberedParts(lines, headings);
  for (const part of parts) {
    sections[part.id] = part.text;
    sectionPages[part.id] = part.pageRange;
  }
  const abstractHeading = headings.find(heading => heading.type === 'abstract');
  if (abstractHeading && parts.length) {
    const firstPartIdx = lines.findIndex((line, idx) => idx > abstractHeading.idx && normalizeHeading(line.text) === parts[0].heading);
    if (firstPartIdx > abstractHeading.idx) {
      sections.abstract = lines.slice(abstractHeading.idx + 1, firstPartIdx).map(line => line.text).join('\n').trim();
      const pages = lines.slice(abstractHeading.idx, firstPartIdx).map(line => line.page).filter(page => page > 0);
      sectionPages.abstract = pages.length ? { start: Math.min(...pages), end: Math.max(...pages) } : sectionPages.abstract;
    }
  }
  if (!sections.abstract) sections.abstract = inferAbstract(lines, headings);
  if (sections.abstract && !sectionPages.abstract) sectionPages.abstract = { start: 1, end: 1 };
  // Related Work 若单独存在，附加到 introduction 尾部
  const related = sliceSection(headings, lines, 'related', STOP_MAIN);
  if (related && sections.introduction && !sections.introduction.toLowerCase().includes('related work')) {
    sections.introduction += '\n\n[Related Work 小节]\n' + related;
  }
  const fullText = lines.map(l => l.text).join('\n');
  return { sections, sectionPages, parts, fullText, headingCount: headings.length };
}

// ---------------- 对外入口 ----------------

export async function parsePdfFile(file) {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const allLines = [];
  let firstPageData = null;

  const maxPages = Math.min(doc.numPages, 30); // 正文通常在前 30 页内
  for (let p = 1; p <= maxPages; p++) {
    const page = await doc.getPage(p);
    const { items, pageWidth, pageHeight } = await getPageItems(page);
    if (p === 1) firstPageData = { items, pageWidth, pageHeight };
    const pageLines = extractPageLines(items, pageWidth);
    const bodyHeights = pageLines.filter(line => line.text.length >= 24 && line.h >= 5 && line.h <= 20).map(line => line.h).sort((a, b) => a - b);
    const bodySize = bodyHeights.length ? bodyHeights[Math.floor(bodyHeights.length / 2)] : 9;
    for (const line of pageLines) allLines.push({ ...line, page: p, pageWidth, pageHeight, bodySize });
  }
  const numPages = doc.numPages;
  await doc.destroy();

  const title = (firstPageData && extractTitle(firstPageData)) || (allLines[0]?.text ?? '未命名论文');
  const { sections, sectionPages, parts, fullText, headingCount } = splitTextToSections(allLines);
  return { title, numPages, sections, sectionPages, parts, fullText, headingCount };
}

/** 手动粘贴的纯文本 → 章节切分 */
export function parsePlainText(text) {
  const rawLines = text.split(/\r?\n/).map((text, i) => ({ text, page: 0 }));
  return splitTextToSections(rawLines);
}

function elementText(element) {
  const blocks = [...element.querySelectorAll('p, li')]
    .filter(node => !node.matches('li li'))
    .map(node => node.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return blocks.join('\n\n');
}

function headingType(text) {
  return semanticHeadingType(text);
}

/** arXiv 的 LaTeXML HTML -> 结构化章节。 */
export function parseArxivHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = (doc.querySelector('.ltx_title_document, article h1, h1')?.textContent || '')
    .replace(/\s+/g, ' ').trim();
  const sections = { abstract: '', introduction: '', method: '', experiments: '', conclusion: '' };

  const abstract = doc.querySelector('.ltx_abstract');
  if (abstract) sections.abstract = elementText(abstract);

  const topSections = [...doc.querySelectorAll('section')]
    .filter(section => !section.parentElement?.closest('section'));
  let related = '';
  const parts = [];
  for (const section of topSections) {
    const heading = section.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6');
    if (!heading) continue;
    const type = headingType(heading.textContent);
    const text = elementText(section);
    if (!text) continue;
    if (!['abstract', 'references', 'end'].includes(type)) {
      const titleText = heading.textContent.replace(/\s+/g, ' ').trim();
      parts.push({
        id: `part-${parts.length + 1}`,
        title: titleText.replace(/^(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)]?\s*/i, '').trim(),
        heading: titleText,
        semanticType: type || 'part',
        text,
        pageRange: null,
      });
    }
    if (!type || type === 'references' || type === 'end' || type === 'abstract') continue;
    if (type === 'related') related = text;
    else if (Object.hasOwn(sections, type)) sections[type] = text;
  }
  if (related) sections.introduction = [sections.introduction, `[Related Work 小节]\n${related}`].filter(Boolean).join('\n\n');

  const article = doc.querySelector('article') || doc.body;
  const fullText = elementText(article);
  if (!title || !fullText) throw new Error('arXiv HTML 中没有可识别的论文正文');
  for (const part of parts) sections[part.id] = part.text;
  return { title, numPages: 0, sections, parts, fullText, headingCount: topSections.length, sourceType: 'arxiv-html' };
}
