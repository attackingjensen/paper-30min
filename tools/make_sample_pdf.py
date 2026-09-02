#!/usr/bin/env python3
"""生成一篇单栏示例论文 PDF（纯手工构造，无第三方依赖），用于体验精读流程。"""
import os
import textwrap

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'samples', 'sample_paper.pdf')

TITLE = ["SampleNet: Contrastive Distillation for", "Neural Paper Summarization"]
AUTHORS = "Jane Doe, John Smith  -  Institute of Sample Research"

ABSTRACT = (
    "Automatic summarization of scientific papers remains difficult because models tend to "
    "copy surface text instead of capturing the core contribution. We propose SampleNet, "
    "a summarization framework that combines contrastive learning with knowledge "
    "distillation from a large teacher reader. SampleNet first encodes each section with a "
    "structure-aware encoder, then selects salient sentences through a learned gate, and "
    "finally distills the teacher's rationale into a compact summary. On three benchmarks, "
    "SampleNet improves ROUGE-L by 4.2 points over the strongest baseline, and human "
    "evaluators prefer its summaries in 68 percent of cases."
)

INTRO = (
    "Scientific papers are growing in number and length, making it hard for researchers to "
    "keep up with their fields. Summarization systems can help, but existing neural "
    "summarizers often produce generic text that misses the key contribution of a paper. "
    "Prior work falls into two families. Extractive methods select sentences by salience "
    "scores; they are faithful but disjoint. Abstractive methods generate fluent text but "
    "hallucinate facts and ignore section structure. Neither family explains why a result "
    "matters, which is exactly what readers care about. In this work we ask: can a model "
    "learn to summarize like an expert reader, emphasizing the problem, the method, and the "
    "evidence in proportion? Our answer is SampleNet, which has three components: a "
    "structure-aware section encoder, a gated sentence selector, and a distillation stage "
    "that transfers the rationale of a large teacher reader into a small student model. "
    "Our contributions are: (1) a structure-aware encoding scheme for papers; (2) a "
    "contrastive objective that separates core contributions from background; and (3) a "
    "distillation recipe that yields a 12x smaller model with better summaries."
)

RELATED = (
    "Extractive summarization dates back to salience scoring with graph-based ranking, and "
    "recent neural variants score sentences with contextual embeddings. Abstractive "
    "summarization advanced with sequence-to-sequence attention models and large pretrained "
    "language models, which improved fluency but increased hallucination rates. "
    "Distillation has been used to compress language models for efficiency, but using a "
    "teacher reader to transfer summarization rationale is, to our knowledge, new."
)

METHOD = (
    "SampleNet processes a paper in three stages. First, the structure-aware encoder reads "
    "each section separately and tags tokens with their section type, such as abstract, "
    "introduction, method, or experiment, producing contextual embeddings that know where "
    "each sentence comes from. Second, the gated sentence selector computes a saliency gate "
    "g for every sentence, and the contrastive objective pulls the summary representation "
    "close to sentences describing the core contribution while pushing away background "
    "sentences. The training loss is L = L_ce + lambda * L_cl, where L_ce is the standard "
    "cross-entropy of summary generation and L_cl is the contrastive term; we set lambda to "
    "0.5 after a small grid search. Third, the distillation stage uses a large teacher "
    "reader to produce rationales, short explanations of why each selected sentence "
    "matters, and trains the student to imitate both the summaries and the rationales. The "
    "student is 12 times smaller than the teacher. We hypothesize this works because "
    "rationales force the student to attend to causal parts of the paper rather than to "
    "frequent surface phrases, and the contrastive term prevents collapse onto boilerplate."
)

EXPERIMENTS = (
    "We evaluate on three benchmarks: arXiv-Abst, PubMed-Intro, and SciSumm-100, covering "
    "papers from machine learning and biomedicine. Baselines are Lead-3, TextRank, "
    "BertSumExt, and a large language model prompted with a single-shot instruction. Main "
    "results: SampleNet achieves ROUGE-L 41.7 on arXiv-Abst, versus 37.5 for the best "
    "baseline; on PubMed-Intro the gain is 3.1 points; on SciSumm-100 the gain is 2.8 "
    "points. In human evaluation with three expert annotators, SampleNet summaries are "
    "preferred in 68 percent of pairwise comparisons, mainly for faithfulness and coverage "
    "of the contribution. Training details: we train for 60,000 steps with AdamW, learning "
    "rate 3e-5, batch size 32, on four A100 GPUs, taking about 14 hours; inference takes "
    "1.2 seconds per paper on a single GPU. Ablation study: removing the contrastive term "
    "drops ROUGE-L by 2.4 points; removing section-aware encoding drops it by 1.6 points; "
    "removing rationale distillation drops human preference by 11 points, the largest "
    "single effect. We observe that the gains concentrate on papers with long related-work "
    "sections, which suggests that structure awareness, not raw capacity, drives most of "
    "the improvement. A limitation is that SampleNet still copies numbers inaccurately in "
    "about 6 percent of summaries."
)

CONCLUSION = (
    "We presented SampleNet, a framework that combines structure-aware encoding, "
    "contrastive selection, and rationale distillation for paper summarization. It "
    "outperforms strong baselines on three benchmarks and produces summaries that expert "
    "readers prefer. Future work includes extending the approach to multi-document "
    "summaries and to papers outside computer science."
)


def wrap(text, width=88):
    return textwrap.wrap(text, width=width)


def esc(s):
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')


def build_lines():
    lines = []  # (font_size, text); size 0 = spacer
    for t in TITLE:
        lines.append((16, t))
    lines.append((0, ''))
    lines.append((10, AUTHORS))
    lines.append((0, ''))
    lines.append((12, 'Abstract'))
    lines += [(10, t) for t in wrap(ABSTRACT)]
    lines.append((0, ''))
    lines.append((12, '1 Introduction'))
    lines += [(10, t) for t in wrap(INTRO)]
    lines.append((0, ''))
    lines.append((12, '2 Related Work'))
    lines += [(10, t) for t in wrap(RELATED)]
    lines.append((0, ''))
    lines.append((12, '3 Method'))
    lines += [(10, t) for t in wrap(METHOD)]
    lines.append((0, ''))
    lines.append((12, '4 Experiments'))
    lines += [(10, t) for t in wrap(EXPERIMENTS)]
    lines.append((0, ''))
    lines.append((12, '5 Conclusion'))
    lines += [(10, t) for t in wrap(CONCLUSION)]
    return lines


TOP_Y, BOTTOM_Y = 760, 55


def paginate(lines):
    """按页面高度切分内容，放不下就换页。"""
    pages, cur, y = [], [], TOP_Y
    for size, text in lines:
        dy = 9 if size == 0 else size + 5
        if y - dy < BOTTOM_Y and cur:
            pages.append(cur)
            cur, y = [], TOP_Y
        cur.append((size, text))
        y -= dy
    if cur:
        pages.append(cur)
    return pages


def build_stream(lines):
    parts = []
    y = TOP_Y
    for size, text in lines:
        if size == 0:
            y -= 9
            continue
        y -= size + 5
        parts.append(f"BT /F1 {size} Tf 72 {y} Td ({esc(text)}) Tj ET")
    return "\n".join(parts)


def main():
    pages = paginate(build_lines())
    # 对象编号：1 Catalog / 2 Pages / 3 Font；每页占两个对象（Page + Contents）
    kids = ' '.join(f"{4 + 2 * i} 0 R" for i in range(len(pages)))
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for i, page_lines in enumerate(pages):
        stream = build_stream(page_lines)
        stream_bytes = stream.encode('latin-1')
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * i} 0 R >>")
        objects.append(f"<< /Length {len(stream_bytes)} >>\nstream\n{stream}\nendstream")

    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode('latin-1')
    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode('latin-1')
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode('latin-1')
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_pos}\n%%EOF\n").encode('latin-1')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(out)
    print(f"已生成：{os.path.normpath(OUT)}（{len(out)} 字节，{len(pages)} 页）")


if __name__ == '__main__':
    main()
