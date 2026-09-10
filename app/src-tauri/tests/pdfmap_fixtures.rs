//! 映射层 fixture 测试（Issue #58 验收：以 #46 实测 DoclingDocument JSON 固化为
//! fixture，断言块模型/三清单的结构事实）。fixture 为 gzip 压缩的原样
//! docling.json（来源 `.local/wayfinder/issue-46/docling-out/`，五类坑位各一）：
//! - 1706.03762 Attention：编号节 + 公式表格 + 附录图题误判 + [n] 参考文献
//! - 1512.03385 ResNet：双栏 + 脚注密集 + 图内碎片
//! - 1608.08225 PhysRev：罗马编号 + 附录 + 无 References 节（脚注文献制）
//! - 1712.01815 AlphaZero：Science 无编号 + 字高分层 + "1." 编号文献表
//! - 1810.04805 BERT："1." 带句点编号 + 附录 A-C + "· Batch size" 误判

use flate2::read::GzDecoder;
use paper30min_lib::pdfmap::{map_docling_document, BlockKind, MappedPaper, SectionRole};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("docling")
}

fn load_fixture(name: &str) -> MappedPaper {
    let path = fixture_dir().join(name);
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("读取 fixture 失败 {}: {e}", path.display()));
    let mut text = String::new();
    GzDecoder::new(&bytes[..])
        .read_to_string(&mut text)
        .expect("fixture gzip 解压失败");
    let doc: Value = serde_json::from_str(&text).expect("fixture JSON 解析失败");
    map_docling_document(&doc).expect("映射应成功")
}

fn section_titles(paper: &MappedPaper) -> Vec<&str> {
    paper.sections.iter().map(|s| s.title.as_str()).collect()
}

fn find_section<'a>(
    paper: &'a MappedPaper,
    title_prefix: &str,
) -> &'a paper30min_lib::pdfmap::Section {
    paper
        .sections
        .iter()
        .find(|s| s.title.starts_with(title_prefix))
        .unwrap_or_else(|| panic!("节缺失: {title_prefix}（实有 {:?}）", section_titles(paper)))
}

/// 全部节内块的只读迭代（测试断言共用）。
fn all_blocks(paper: &MappedPaper) -> impl Iterator<Item = &paper30min_lib::pdfmap::Block> {
    paper.sections.iter().flat_map(|s| s.blocks.iter())
}

#[test]
fn fixture_1706_attention_full_structure() {
    let paper = load_fixture("1706.03762.json.gz");
    assert_eq!(paper.title.as_deref(), Some("Attention Is All You Need"));
    assert_eq!(paper.page_count, 15);

    // 节结构：7 个编号节 + Abstract + References（附录图题误判不成节）。
    let titles = section_titles(&paper);
    for expected in [
        "Abstract",
        "1 Introduction",
        "2 Background",
        "3 Model Architecture",
        "5 Training",
        "7 Conclusion",
        "References",
    ] {
        assert!(titles.contains(&expected), "缺节 {expected}: {titles:?}");
    }
    assert!(
        !titles
            .iter()
            .any(|t| t.contains("Attention Visualizations") || t.contains("Layer5")),
        "附录区误判标题不应成节: {titles:?}"
    );
    // 节 ID 形态：sec_{n}_{slug}。
    assert!(
        paper.sections[1].id.starts_with("sec_2_"),
        "节 ID 形态: {}",
        paper.sections[1].id
    );
    let intro = find_section(&paper, "1 Introduction");
    assert_eq!(intro.number.as_deref(), Some("1"));
    assert_eq!(intro.role, SectionRole::Body);
    assert!(intro.page_start >= 1 && intro.page_end >= intro.page_start);

    // 小节索引：3.1/3.2 挂在 Model Architecture 节（小节无一等身份）。
    let model_sec = find_section(&paper, "3 Model Architecture");
    let sub_numbers: Vec<&str> = model_sec
        .subsections
        .iter()
        .filter_map(|s| s.number.as_deref())
        .collect();
    assert!(
        sub_numbers.contains(&"3.1"),
        "小节索引缺 3.1: {sub_numbers:?}"
    );
    assert!(
        sub_numbers.contains(&"3.2"),
        "小节索引缺 3.2: {sub_numbers:?}"
    );
    let sub31 = model_sec
        .subsections
        .iter()
        .find(|s| s.number.as_deref() == Some("3.1"))
        .unwrap();
    assert_eq!(sub31.level, 2);
    assert!(sub31.block_start >= 1 && sub31.block_end >= sub31.block_start);

    // 图清单：fig_1..fig_5，ID 从图注编号派生；caption 并入；bbox 存在。
    let fig_ids: Vec<&str> = paper.figures.iter().map(|f| f.id.as_str()).collect();
    for id in ["fig_1", "fig_2", "fig_3", "fig_4", "fig_5"] {
        assert!(fig_ids.contains(&id), "图清单缺 {id}: {fig_ids:?}");
    }
    let fig1 = paper.figures.iter().find(|f| f.id == "fig_1").unwrap();
    assert_eq!(fig1.number, "1");
    assert!(fig1
        .caption
        .as_deref()
        .unwrap_or("")
        .contains("The Transformer - model architecture"));
    assert_eq!(fig1.page, 3);
    assert!(
        fig1.bbox[2] > 0.0 && fig1.bbox[3] > 0.0,
        "bbox 应有正宽高: {:?}",
        fig1.bbox
    );
    assert!(fig1.section.is_some(), "图应有归属节");

    // 表清单：tbl_1..tbl_4；表格块 text 为 MD 管道表（TableFormer 结构化输出）。
    let tbl_ids: Vec<&str> = paper.tables.iter().map(|t| t.id.as_str()).collect();
    for id in ["tbl_1", "tbl_2", "tbl_3", "tbl_4"] {
        assert!(tbl_ids.contains(&id), "表清单缺 {id}: {tbl_ids:?}");
    }
    let tbl1_block = all_blocks(&paper)
        .find(|b| b.asset_id.as_deref() == Some("tbl_1"))
        .expect("tbl_1 块应存在");
    assert_eq!(tbl1_block.kind, BlockKind::Table);
    assert!(
        tbl1_block.text.contains("| Layer Type |"),
        "表格应为 MD: {:.80}",
        tbl1_block.text
    );
    assert!(
        tbl1_block.text.contains("Self-Attention"),
        "表格内容: {:.120}",
        tbl1_block.text
    );

    // 图占位行：图块 text = [图 fig_n]。
    let fig1_block = all_blocks(&paper)
        .find(|b| b.asset_id.as_deref() == Some("fig_1"))
        .expect("fig_1 块应存在");
    assert_eq!(fig1_block.text, "[图 fig_1]");
    assert_eq!(fig1_block.kind, BlockKind::Figure);

    // 公式块：占位 + bbox（enrichment 关闭无 LaTeX）。
    let formulas: Vec<_> = all_blocks(&paper)
        .filter(|b| b.kind == BlockKind::Formula)
        .collect();
    assert!(formulas.len() >= 5, "公式块应 ≥5: {}", formulas.len());
    assert!(formulas.iter().all(|b| b.text == "[公式]"));
    assert!(formulas
        .iter()
        .all(|b| b.bbox.is_some() && b.latex.is_none()));

    // 参考文献：[1]–[40] 按序补号（#46 报告曾估 37 条，fixture 实测 40 条，
    // orig 编号连续完整，以实测为准），正文 [n] 引用处非空。
    assert_eq!(paper.references.len(), 40, "参考文献条目数");
    let ref1 = &paper.references[0];
    assert_eq!(ref1.id, "ref_1");
    assert!(ref1.text.starts_with("[1] "), "补号前缀: {:.60}", ref1.text);
    assert!(
        ref1.text.contains("Jimmy Lei Ba"),
        "ref_1 内容: {:.80}",
        ref1.text
    );
    let cited = paper
        .references
        .iter()
        .filter(|r| !r.cited_at.is_empty())
        .count();
    assert!(cited >= 20, "正文 [n] 引用应覆盖多数条目: {cited}/40");
    // 引用处带节与块指针。
    let some_cited = paper
        .references
        .iter()
        .find(|r| !r.cited_at.is_empty())
        .unwrap();
    let c = &some_cited.cited_at[0];
    assert!(c.sec_id.starts_with("sec_") && c.block_id >= 1 && c.page >= 1);

    // References 节的条目块文本同样带补号。
    let refs_sec = paper
        .sections
        .iter()
        .find(|s| s.role == SectionRole::References)
        .unwrap();
    assert!(
        refs_sec.blocks[0].text.starts_with("[1] "),
        "节内条目补号: {:.60}",
        refs_sec.blocks[0].text
    );

    // furniture 剔除但保留；正文块不含 arXiv 水印。
    assert!(
        paper.furniture.len() >= 10,
        "furniture 桶: {}",
        paper.furniture.len()
    );
    assert!(paper.furniture.iter().any(|f| f.label == "page_header"));
    let body_has_watermark = all_blocks(&paper).any(|b| b.text.contains("arXiv:1706.03762"));
    assert!(!body_has_watermark, "页眉水印不应进入节块");

    // 脚注保留为脚注类型。
    let footnotes = all_blocks(&paper)
        .filter(|b| b.kind == BlockKind::Footnote)
        .count();
    assert!(footnotes >= 5, "脚注块: {footnotes}");

    // 块级 prov：页码与 y 存在；块编号节内从 1 连续。
    for section in &paper.sections {
        for (i, block) in section.blocks.iter().enumerate() {
            assert_eq!(block.id, (i + 1) as u32, "{} 块编号连续", section.id);
            assert!(block.page >= 1, "{} L{} 页码", section.id, block.id);
        }
    }
}

#[test]
fn fixture_1512_resnet_two_column_and_footnotes() {
    let paper = load_fixture("1512.03385.json.gz");
    assert_eq!(
        paper.title.as_deref(),
        Some("Deep Residual Learning for Image Recognition")
    );

    let titles = section_titles(&paper);
    for expected in ["Abstract", "1. Introduction", "References"] {
        assert!(titles.contains(&expected), "缺节 {expected}: {titles:?}");
    }
    // 双栏阅读顺序：节按 1→5 递增排列（块序即阅读序）。
    let intro_pos = titles.iter().position(|t| *t == "1. Introduction").unwrap();
    let refs_pos = titles.iter().position(|t| *t == "References").unwrap();
    assert!(intro_pos < refs_pos);

    // 图内文字碎片（"iter. (1e4)" 等坐标轴文字）不进入块流。
    let has_axis_fragment = all_blocks(&paper)
        .any(|b| b.kind == BlockKind::Paragraph && b.text.trim() == "iter. (1e4)");
    assert!(!has_axis_fragment, "图内碎片不应成为独立段落块");

    // 脚注密集：ResNet 首页脚注存活为 footnote 块。
    let footnotes: Vec<_> = all_blocks(&paper)
        .filter(|b| b.kind == BlockKind::Footnote)
        .collect();
    assert!(footnotes.len() >= 5, "脚注块: {}", footnotes.len());
    assert!(
        footnotes.iter().any(|b| b.text.contains("image-net.org")),
        "脚注内容: {:?}",
        footnotes.first()
    );

    // 图清单与编号派生。
    assert!(
        paper.figures.iter().any(|f| f.id == "fig_1"),
        "fig_1 应在清单: {:?}",
        paper.figures.iter().map(|f| &f.id).collect::<Vec<_>>()
    );
}

#[test]
fn fixture_1608_physrev_roman_numbering_and_appendix() {
    let paper = load_fixture("1608.08225.json.gz");
    assert_eq!(
        paper.title.as_deref(),
        Some("Why does deep and cheap learning work so well? ∗")
    );

    // 罗马数字一级节 I–IV。
    let titles = section_titles(&paper);
    for expected in ["I. INTRODUCTION", "III. WHY DEEP?", "IV. CONCLUSIONS"] {
        assert!(titles.contains(&expected), "缺节 {expected}: {titles:?}");
    }
    let intro = find_section(&paper, "I. INTRODUCTION");
    assert_eq!(intro.number.as_deref(), Some("I"));

    // A.–H. 为小节索引（罗马体系内字母 = 二级），不各自成节。
    assert!(
        !titles.iter().any(|t| t.starts_with("A. The swindle")),
        "罗马体系字母小节不应成节: {titles:?}"
    );
    let sec2 = find_section(&paper, "II. EXPRESSIBILITY");
    let sub_numbers: Vec<&str> = sec2
        .subsections
        .iter()
        .filter_map(|s| s.number.as_deref())
        .collect();
    assert!(
        sub_numbers.contains(&"A"),
        "II 节应有 A 小节: {sub_numbers:?}"
    );
    // 罗马体系内阿拉伯数字 = 三级小节。
    let sub_c = sec2
        .subsections
        .iter()
        .find(|s| s.number.as_deref() == Some("C"))
        .unwrap();
    assert_eq!(sub_c.level, 2);
    let arabic_sub = sec2
        .subsections
        .iter()
        .find(|s| s.title.starts_with("1. Continuous input"));
    assert!(
        arabic_sub.is_some(),
        "C 下应有 1. 小节: {:?}",
        sec2.subsections
    );
    assert_eq!(arabic_sub.unwrap().level, 3);

    // 附录：Appendix A 为独立附录节，其内 "1. Proof..." 为小节。
    let appendix = find_section(&paper, "Appendix A");
    assert_eq!(appendix.role, SectionRole::Appendix);
    assert_eq!(appendix.number.as_deref(), Some("A"));
    assert!(
        appendix
            .subsections
            .iter()
            .any(|s| s.title.starts_with("1. Proof")),
        "附录内小节: {:?}",
        appendix.subsections
    );

    // PhysRev 脚注文献制：无 References 节 → 空清单 + warning（诚实档）。
    assert!(paper.references.is_empty());
    assert!(paper
        .warnings
        .contains(&"references_section_missing".to_string()));
}

#[test]
fn fixture_1712_alphazero_unnumbered_science_layout() {
    let paper = load_fixture("1712.01815.json.gz");
    assert_eq!(
        paper.title.as_deref(),
        Some("Mastering Chess and Shogi by Self-Play with a General Reinforcement Learning Algorithm")
    );

    // 无编号一级节（白名单 + 字高分层）：Abstract / References / Methods。
    let titles = section_titles(&paper);
    for expected in ["Abstract", "References", "Methods"] {
        assert!(titles.contains(&expected), "缺节 {expected}: {titles:?}");
    }
    // Science 版式：References 在 Methods 之前（按文档顺序组织）。
    let refs_pos = titles.iter().position(|t| *t == "References").unwrap();
    let methods_pos = titles.iter().position(|t| *t == "Methods").unwrap();
    assert!(refs_pos < methods_pos, "节顺序应保持文档顺序: {titles:?}");

    // Methods 的 8 个无编号小节进索引（字高分流，不开节）。
    let methods = find_section(&paper, "Methods");
    let sub_titles: Vec<&str> = methods
        .subsections
        .iter()
        .map(|s| s.title.as_str())
        .collect();
    for expected in [
        "Anatomy of a Computer Chess Program",
        "MCTS and Alpha-Beta Search",
        "Domain Knowledge",
        "Evaluation",
    ] {
        assert!(
            sub_titles.contains(&expected),
            "Methods 缺小节 {expected}: {sub_titles:?}"
        );
    }
    assert!(
        !titles.contains(&"Anatomy of a Computer Chess Program"),
        "无编号小节不应成节: {titles:?}"
    );

    // "1." 句点编号文献表 → 编号引用制，条目建立（正文引用为上标无括号，
    // cited_at 可空，不作断言）。
    assert!(
        paper.references.len() >= 30,
        "参考文献条目: {}",
        paper.references.len()
    );
    assert!(
        paper.references[0].text.starts_with("[1] "),
        "补号: {:.60}",
        paper.references[0].text
    );
}

#[test]
fn fixture_1810_bert_dotted_numbering_and_appendix_filter() {
    let paper = load_fixture("1810.04805.json.gz");
    assert_eq!(
        paper.title.as_deref(),
        Some("BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding")
    );

    let titles = section_titles(&paper);
    for expected in ["1 Introduction", "6 Conclusion", "References"] {
        assert!(titles.contains(&expected), "缺节 {expected}: {titles:?}");
    }

    // 附录：扉页 + A/B/C 各字母为独立节。
    let appendix_a = find_section(&paper, "A Additional Details for BERT");
    assert_eq!(appendix_a.role, SectionRole::Appendix);
    assert_eq!(appendix_a.number.as_deref(), Some("A"));
    find_section(&paper, "B Detailed Experimental Setup");
    find_section(&paper, "C Additional Ablation Studies");

    // A.1–A.5 小节索引。
    let sub_numbers: Vec<&str> = appendix_a
        .subsections
        .iter()
        .filter_map(|s| s.number.as_deref())
        .collect();
    for expected in ["A.1", "A.2", "A.3", "A.4", "A.5"] {
        assert!(
            sub_numbers.contains(&expected),
            "附录 A 缺小节 {expected}: {sub_numbers:?}"
        );
    }

    // "· Batch size : 16, 32" 误判标题降级为段落（不成节、不进小节索引）。
    assert!(
        !titles.iter().any(|t| t.contains("Batch size")),
        "误判标题不应成节"
    );
    assert!(
        !paper
            .sections
            .iter()
            .flat_map(|s| s.subsections.iter())
            .any(|s| s.title.contains("Batch size")),
        "误判标题不应进小节索引"
    );
    let demoted_exists =
        all_blocks(&paper).any(|b| b.kind == BlockKind::Paragraph && b.text.contains("Batch size"));
    assert!(demoted_exists, "降级后文本应保留为段落块");

    // BERT 参考文献为作者-年份制（"Alan Akbik, ... 2018."），按决策 12
    // 降级为空清单（不建 ref 条目），并记 warning。
    assert!(paper.references.is_empty(), "作者-年份制应降级空清单");
    assert!(paper
        .warnings
        .contains(&"references_unnumbered".to_string()));
}
