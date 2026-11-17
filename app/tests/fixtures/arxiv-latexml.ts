// 真实 LaTeXML HTML 结构 fixture（vx0.3 转换器）。
// 结构对照 arXiv 官方 LaTeXML 输出：ltx_document/ltx_section/ltx_para/ltx_p、
// ltx_Math alttext、ltx_equation 表格包装、ltx_figure/ltx_table/ltx_tabular、
// ltx_note+ltx_note_mark、ltx_bibliography、ltx_appendix、ltx_ref 交叉引用。

export const FIG1_SRC = "extracted/6543210/figures/overview.png";
export const FIG2_SRC = "x2.png";

const MATH_INLINE = `<math class="ltx_Math" alttext="E=mc^{2}" display="inline"><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">E=mc^{2}</annotation></semantics></math>`;

const MATH_BLOCK = `<math class="ltx_Math" alttext="a^{2}+b^{2}=c^{2}" display="block"><semantics><mrow><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup><mo>=</mo><msup><mi>c</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">a^{2}+b^{2}=c^{2}</annotation></semantics></math>`;

const MATH_ONLY_MML = `<math class="ltx_Math" display="inline"><semantics><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></semantics></math>`;

function body(extra: string): string {
  return `
<section id="S1" class="ltx_section">
<h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">1 </span>Introduction</h2>
<div id="S1.p1" class="ltx_para">
<p id="S1.p1.1" class="ltx_p">Energy equals mass, written ${MATH_INLINE} in prose. See Figure <a id="S1.p1.1.1" href="#S2.F1" class="ltx_ref"><span class="ltx_text ltx_ref_title">1</span></a> and Equation <a href="#S2.E1" class="ltx_ref"><span class="ltx_text ltx_ref_title">1</span></a>. Prior work <cite class="ltx_cite"><a href="#bib.bib1" class="ltx_ref">[1]</a></cite> studied this.<span id="footnote1" class="ltx_note ltx_role_footnote"><span class="ltx_note_mark">1</span><span class="ltx_note_content">A footnote about units.</span></span></p>
<p class="ltx_p">Only MathML here: ${MATH_ONLY_MML} stays readable.</p>
</div>
<ul id="S1.I1" class="ltx_itemize">
<li id="S1.I1.i1" class="ltx_item"><div class="ltx_para"><p class="ltx_p">First item.</p></div></li>
<li id="S1.I1.i2" class="ltx_item"><div class="ltx_para"><p class="ltx_p">Second item.</p></div></li>
</ul>
</section>
<section id="S2" class="ltx_section">
<h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">2 </span>Method</h2>
<div id="S2.p1" class="ltx_para">
<p class="ltx_p">We repeat the claim. We repeat the claim.</p>
</div>
<figure id="S2.F1" class="ltx_figure">
<img src="${FIG1_SRC}" id="S2.F1.g1" class="ltx_graphics" alt="Overview diagram" />
<figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_figure">Figure 1: </span>System overview.</figcaption>
</figure>
<figure id="S2.F2" class="ltx_figure">
<img src="${FIG2_SRC}" id="S2.F2.g1" class="ltx_graphics" alt="Second plot" />
<figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_figure">Figure 2: </span>Second plot.</figcaption>
</figure>
<table id="S2.E1" class="ltx_equation ltx_eqn_table">
<tbody><tr class="ltx_equation ltx_eqn_row ltx_align_baseline">
<td class="ltx_eqn_cell ltx_eqn_center_padleft"></td>
<td class="ltx_eqn_cell ltx_align_center">${MATH_BLOCK}</td>
<td class="ltx_eqn_cell ltx_eqn_center_padright"></td>
<td class="ltx_eqn_cell ltx_align_right"><span class="ltx_tag ltx_tag_equation ltx_align_right">(1)</span></td>
</tr></tbody>
</table>
<figure id="S2.T1" class="ltx_table">
<figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_table">Table 1: </span>Measured results.</figcaption>
<table class="ltx_tabular">
<tbody>
<tr class="ltx_tr"><td class="ltx_td" rowspan="2">Alpha</td><td class="ltx_td">one</td></tr>
<tr class="ltx_tr"><td class="ltx_td">two</td></tr>
</tbody>
</table>
</figure>
<div id="S2.Thmthm1" class="ltx_theorem ltx_theorem_theorem">
<h6 class="ltx_title ltx_title_theorem"><span class="ltx_tag ltx_tag_theorem">Theorem 1</span>.</h6>
<div class="ltx_para"><p class="ltx_p">Every right triangle satisfies the identity.</p></div>
</div>
${extra}
</section>
<section id="S3" class="ltx_section">
<h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">3 </span>Conclusion</h2>
<div class="ltx_para"><p class="ltx_p">We conclude with <a href="https://example.org/data" class="ltx_ref ltx_url">open data</a>.</p></div>
</section>
<section id="A1" class="ltx_appendix">
<h2 class="ltx_title ltx_title_appendix"><span class="ltx_tag ltx_tag_appendix">Appendix A </span>Proofs</h2>
<section id="A1.SS1" class="ltx_subsection">
<h3 class="ltx_title ltx_title_subsection"><span class="ltx_tag ltx_tag_subsection">A.1 </span>Details</h3>
<div class="ltx_para"><p class="ltx_p">Proof details are deferred here.</p></div>
</section>
</section>
<section id="bib" class="ltx_bibliography">
<h2 class="ltx_title ltx_title_bibliography">References</h2>
<ul class="ltx_biblist">
<li id="bib.bib1" class="ltx_bibitem"><span class="ltx_tag ltx_tag_bibitem">[1]</span><span class="ltx_bibblock">Author, A. (2020). A study of energy. Journal of Examples.</span></li>
</ul>
</section>`;
}

export function latexmlDocument(options: { extra?: string; head?: string } = {}): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<title>Fixture Study of Energy</title>
<meta name="citation_arxiv_id" content="2401.01234v1" />
<script>window.track && window.track("pageview");</script>
<style>.ltx_p { color: red; }</style>
${options.head ?? ""}
</head><body>
<div class="ltx_page_main">
<article id="main" class="ltx_document">
<h1 class="ltx_title ltx_title_document">Fixture Study of Energy</h1>
<div class="ltx_authors"><span class="ltx_personname">Ada Lovelace</span></div>
<div id="abstract" class="ltx_abstract">
<h6 class="ltx_title ltx_title_abstract">Abstract</h6>
<p class="ltx_p">We study energy and mass.</p>
</div>
${body(options.extra ?? "")}
</article>
</div>
</body></html>`;
}

/** 只有标题、作者与摘要：没有实际正文，不能宣称可读。 */
export function abstractOnlyDocument(): string {
  return `<!DOCTYPE html><html><head><title>Stub</title></head><body>
<article class="ltx_document">
<h1 class="ltx_title ltx_title_document">Stub</h1>
<div id="abstract" class="ltx_abstract"><p class="ltx_p">Only an abstract.</p></div>
</article></body></html>`;
}

/** abs 页面冒充 full-text。 */
export function absPageDocument(): string {
  return `<!DOCTYPE html><html><head><title>[2401.01234] Stub</title></head><body>
<div id="abs"><h1 class="title">Title: Stub</h1>
<blockquote class="abstract">Only an abstract.</blockquote></div>
</body></html>`;
}

/** 内联 SVG 图片：快照保留原样，revision 中不得执行其内容。 */
export const SVG_EXTRA = `
<figure id="S2.F3" class="ltx_figure">
<svg class="ltx_picture" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>
<figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_figure">Figure 3: </span>Inline vector plot.</figcaption>
</figure>`;

/** 未知可见容器：必须结构化降级或 fatal，不能静默丢弃。 */
export const UNKNOWN_CONTENT_EXTRA = `
<div class="ltx_custom_block">Unrecognized visible content.</div>`;

/** 全部图片都指向未抓取的外部资产（系统性失败，不能拆成局部 warning）。 */
export function allExternalImagesDocument(): string {
  return `<!DOCTYPE html><html><head><title>External</title></head><body>
<article class="ltx_document">
<h1 class="ltx_title ltx_title_document">External</h1>
<section id="S1" class="ltx_section"><h2 class="ltx_title">1 Body</h2>
<div class="ltx_para"><p class="ltx_p">Body text one.</p></div>
<figure id="S1.F1" class="ltx_figure"><img src="https://cdn.example.org/a.png" alt="a" />
<figcaption class="ltx_caption">A.</figcaption></figure>
<figure id="S1.F2" class="ltx_figure"><img src="https://cdn.example.org/b.png" alt="b" />
<figcaption class="ltx_caption">B.</figcaption></figure>
</section></article></body></html>`;
}

/** 全部公式都缺可读表示（系统性失败）。 */
export function allBlankMathDocument(): string {
  return `<!DOCTYPE html><html><head><title>BlankMath</title></head><body>
<article class="ltx_document">
<h1 class="ltx_title ltx_title_document">BlankMath</h1>
<section id="S1" class="ltx_section"><h2 class="ltx_title">1 Body</h2>
<div class="ltx_para"><p class="ltx_p">Formula <math class="ltx_Math" display="inline"></math> one.</p></div>
<table id="S1.E1" class="ltx_equation ltx_eqn_table"><tbody><tr>
<td class="ltx_eqn_cell"><math class="ltx_Math" display="block"></math></td>
</tr></tbody></table>
</section></article></body></html>`;
}

/** 表格带跨列嵌套结构，无法无损表达为行列跨度。 */
export const NESTED_TABLE_EXTRA = `
<figure id="S2.T2" class="ltx_table">
<figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_table">Table 2: </span>Nested layout.</figcaption>
<table class="ltx_tabular"><tbody>
<tr class="ltx_tr"><td class="ltx_td">outer<table class="ltx_tabular"><tbody><tr><td class="ltx_td">inner</td></tr></tbody></table></td></tr>
</tbody></table>
</figure>`;

/** 引用目标在来源中不存在：保留显示文本与 sourceTarget，记 warning 而非 fatal。 */
export const MISSING_TARGET_EXTRA = `
<div id="S2.p2" class="ltx_para"><p class="ltx_p">See <a href="#S2.E9" class="ltx_ref">Equation 9</a>.</p></div>`;
