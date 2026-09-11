//! 踩坑论文集回归夹具与性能门禁（Issue #60，规格 #48 §Testing Decisions）。
//!
//! #46 的 10 篇踩坑论文固化为回归夹具：夹具 PDF 全链（侧车转换 → 映射层）→
//! 断言基线 = #48 User Stories 1–8 对应事实（节结构、附录存活、furniture 剔除、
//! prov 覆盖、参考文献编号）；性能门禁 = 单篇转换耗时不超 #46 实测值 1.5 倍
//! （机器状态容差见下）；Docling 版本锁定：侧车自报版本须等于
//! `manifest.doclingVersion`，升级流程见 `tools/pdfparse-sidecar/README.md`
//! 与 `tests/fixtures/regression/README.md`。
//!
//! 运行模式（环境变量 `PAPER30MIN_PDFPARSE_FIXTURES`）：
//! - 未设置：转换类测试全部跳过（打印原因）；`manifest_is_well_formed` 始终运行。
//! - `1`：assert 模式，逐篇全链断言 + 性能门禁（串行，约 15–25 分钟）。
//! - `dump`：全链重跑并把实测事实写 `manifest.dump.json`（版本升级的同机对照
//!   数据与基线草案）；再设 `PAPER30MIN_PDFPARSE_FIXTURES_DUMP_DIR=<dir>` 可跳过
//!   转换、直接从既有 docling.json 目录重建事实（初始基线即由 #46 实测输出生成）。
//!
//! 性能门禁的计时口径：侧车 result.elapsedMs 含 Python 启动与模型加载固定开销，
//! #46 基线（manifest.baselineSeconds）为纯转换耗时；#57 复核实测同机状态波动
//! 可达 1.7×，故门禁为 `elapsed ≤ 基线 × 1.5 × PAPER30MIN_PDFPARSE_PERF_FACTOR`
//! （默认 1.0，机器繁忙/偏慢时由操作员显式放宽并在升级报告中说明）。
//!
//! 公式密集样例三类（继承 #34 验收标准）：文字公式 = 1412.6980（Adam）、
//! 双栏布局 = 1603.02754（XGBoost），均为夹具集成员并在 manifest.formulaSamples
//! 登记；矢量与图片公式 = 合成夹具 pdfparse_formula_graphics.pdf（纯路径矢量
//! 公式 + 嵌入位图公式，生成器见 tests/fixtures/make_pdfparse_fixtures.py）。

mod common;
mod fixture_texts;

use paper30min_lib::pdfmap::{map_docling_json_file, BlockKind, MappedPaper, SectionRole};
use paper30min_lib::pdfparse;
use paper30min_lib::tasks::TaskStatus;
use paper30min_lib::testkit::{wait_terminal, Collector};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// 侧车转换共用一把锁：docling 模型加载吃内存与 CPU，串行防抖动
/// （与 pdfparse_contract / pdfassets_contract 同族）。
static SIDECAR_LOCK: Mutex<()> = Mutex::new(());

const ENV_FIXTURES: &str = "PAPER30MIN_PDFPARSE_FIXTURES";
const ENV_DUMP_DIR: &str = "PAPER30MIN_PDFPARSE_FIXTURES_DUMP_DIR";
const ENV_PERF_FACTOR: &str = "PAPER30MIN_PDFPARSE_PERF_FACTOR";
/// 单篇转换上限：2106.09685 基线 176s × 1.5 ≈ 265s，再留冷启动余量。
const CONVERT_TIMEOUT: Duration = Duration::from_secs(900);
/// furniture 泄漏探针：出现次数 ≥3 且足够长的 furniture 文本不得进入节块。
const FURNITURE_PROBE_MIN_OCCURRENCES: usize = 3;
const FURNITURE_PROBE_MIN_LEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Off,
    Assert,
    Dump,
}

fn mode() -> Mode {
    match std::env::var(ENV_FIXTURES).as_deref() {
        Ok("1") => Mode::Assert,
        Ok("dump") => Mode::Dump,
        _ => Mode::Off,
    }
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("regression")
}

fn load_manifest() -> Value {
    let path = fixtures_dir().join("manifest.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读取回归基线清单失败 {}: {e}", path.display()));
    serde_json::from_str(&text).expect("manifest.json 应为合法 JSON")
}

fn paper_entry<'a>(manifest: &'a Value, id: &str) -> &'a Value {
    manifest["papers"]
        .as_array()
        .expect("manifest.papers 应为数组")
        .iter()
        .find(|p| p["id"].as_str() == Some(id))
        .unwrap_or_else(|| panic!("manifest 缺论文条目 {id}"))
}

fn formula_graphics_pdf() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("pdfparse_formula_graphics.pdf")
}

// ============================================================================
// 始终运行：清单良构（不依赖侧车，干净克隆也覆盖）
// ============================================================================

/// requirements-sidecar.txt 中 docling 的钉版号（`docling==X.Y.Z`，
/// 注意排除 docling-slim/docling-core 等同前缀行）。
fn requirements_docling_pin() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tools")
        .join("pdfparse-sidecar")
        .join("requirements-sidecar.txt");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读取钉版清单失败 {}: {e}", path.display()));
    text.lines()
        .find_map(|line| line.trim().strip_prefix("docling=="))
        .expect("requirements-sidecar.txt 应有 docling== 钉版行")
        .to_string()
}

#[test]
fn manifest_is_well_formed() {
    let manifest = load_manifest();

    // 版本钉三方一致：manifest == requirements-sidecar.txt（侧车 DOCLING_VERSION
    // 由 assert 模式在转换结果上校验）。
    let pin = requirements_docling_pin();
    assert_eq!(
        manifest["doclingVersion"].as_str().expect("doclingVersion"),
        pin,
        "manifest.doclingVersion 与 requirements-sidecar.txt 钉版不一致（升级流程见 tools/pdfparse-sidecar/README.md）"
    );
    assert!(manifest["perfFactor"].as_f64().expect("perfFactor") > 1.0);

    let papers = manifest["papers"].as_array().expect("papers 数组");
    assert_eq!(papers.len(), 10, "踩坑论文集应为 10 篇");
    let mut ids = Vec::new();
    for paper in papers {
        let id = paper["id"].as_str().expect("paper.id");
        ids.push(id.to_string());
        // arXiv ID 与文件名一致；PDF 在场且非空。
        assert_eq!(
            paper["pdf"].as_str().expect("paper.pdf"),
            format!("corpus/{id}.pdf")
        );
        let pdf = fixtures_dir().join(paper["pdf"].as_str().unwrap());
        let size = std::fs::metadata(&pdf)
            .unwrap_or_else(|e| panic!("夹具 PDF 缺失 {}: {e}", pdf.display()))
            .len();
        assert!(size > 10_000, "夹具 PDF 异常小: {}", pdf.display());
        assert!(paper["pages"].as_u64().expect("pages") >= 1);
        assert!(paper["baselineSeconds"].as_f64().expect("baselineSeconds") > 0.0);
        let expect = &paper["expect"];
        assert!(expect["sectionsContain"].as_array().expect("sectionsContain").len() >= 2,
            "{id} 应至少断言两个节标题");
        assert!(expect["references"]["count"].as_u64().is_some(), "{id} references.count");
    }

    // 公式密集样例三类登记齐全（#34 验收标准继承）：文字公式 / 双栏布局指向
    // 夹具集成员；矢量与图片公式指向合成夹具且文件在场。
    let samples = &manifest["formulaSamples"];
    for key in ["text", "twoColumn"] {
        let id = samples[key].as_str().unwrap_or_else(|| panic!("formulaSamples.{key}"));
        assert!(ids.iter().any(|p| p == id), "formulaSamples.{key}={id} 应在夹具集内");
    }
    let graphics = samples["graphics"]
        .as_str()
        .expect("formulaSamples.graphics");
    assert_eq!(graphics, "pdfparse_formula_graphics.pdf");
    assert!(formula_graphics_pdf().is_file(), "合成公式图形夹具应在场");
}

// ============================================================================
// 事实提取与断言引擎
// ============================================================================

fn all_blocks(paper: &MappedPaper) -> impl Iterator<Item = &paper30min_lib::pdfmap::Block> {
    paper.sections.iter().flat_map(|s| s.blocks.iter())
}

fn subsection_count(paper: &MappedPaper) -> usize {
    paper.sections.iter().map(|s| s.subsections.len()).sum()
}

/// 引擎不变量违例（每篇都须为空；对应 #48 User Stories 1–8 的通用事实）。
fn engine_violations(paper: &MappedPaper) -> Vec<String> {
    let mut violations = Vec::new();
    for section in &paper.sections {
        for block in &section.blocks {
            // prov 覆盖：块必须有首页页码。
            if block.page < 1 {
                violations.push(format!("{} L{} 缺页码", section.id, block.id));
            }
            // 不静默产出失真文本的底座：块文本不得为空。
            if block.text.trim().is_empty() {
                violations.push(format!("{} L{} 空文本块（{:?}）", section.id, block.id, block.kind));
            }
            match block.kind {
                // 公式：占位 + 可裁切 bbox，默认管线不出 LaTeX（决策 13）。
                BlockKind::Formula => {
                    if block.text != "[公式]" {
                        violations.push(format!("{} L{} 公式块非占位: {:.40}", section.id, block.id, block.text));
                    }
                    if block.latex.is_some() {
                        violations.push(format!("{} L{} 默认管线不应有 LaTeX", section.id, block.id));
                    }
                }
                // 表格：MD 管道表（TableFormer 结构化输出，决策 8）。
                BlockKind::Table => {
                    if !block.text.contains('|') {
                        violations.push(format!("{} L{} 表块非 MD: {:.40}", section.id, block.id, block.text));
                    }
                }
                _ => {}
            }
            // 图/表/公式块必须带正宽高 bbox（裁切链前提）。
            if matches!(block.kind, BlockKind::Figure | BlockKind::Table | BlockKind::Formula) {
                match block.bbox {
                    Some(bbox) if bbox[2] > 0.0 && bbox[3] > 0.0 => {}
                    _ => violations.push(format!("{} L{} {:?} 块缺有效 bbox", section.id, block.id, block.kind)),
                }
            }
        }
    }

    // furniture 剔除：重复出现的页眉页脚条纹不得泄漏进节块（User Story 4）。
    // 泄漏 = 同一条纹系统性进入正文（≥2 个正文块）；单次出现是页首声明行本身
    // 被标为正文的可接受误标（#46：Adam 首页 "Published as..." 行）。
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for item in &paper.furniture {
        let text = item.text.trim();
        if text.len() >= FURNITURE_PROBE_MIN_LEN {
            *counts.entry(text).or_default() += 1;
        }
    }
    let body_texts: Vec<&str> = all_blocks(paper)
        .filter(|b| matches!(b.kind, BlockKind::Paragraph | BlockKind::Heading | BlockKind::Footnote))
        .map(|b| b.text.as_str())
        .collect();
    for (text, count) in counts {
        if count < FURNITURE_PROBE_MIN_OCCURRENCES {
            continue;
        }
        let leaked = body_texts.iter().filter(|body| body.contains(text)).count();
        if leaked >= 2 {
            violations.push(format!("furniture 条纹系统性泄漏进节块（{leaked} 处）: {text:.60}"));
        }
    }

    // 参考文献：编号引用制下补号必须连续（[1]..[n]，User Story 8）。
    for (index, reference) in paper.references.iter().enumerate() {
        let prefix = format!("[{}] ", index + 1);
        if !reference.text.starts_with(&prefix) {
            violations.push(format!("{} 补号不连续，应以 {prefix} 开头: {:.50}", reference.id, reference.text));
        }
    }

    // prov 覆盖（User Story 13）：清单条目与引用处的坐标指针必须可用。
    for entry in paper.figures.iter().chain(paper.tables.iter()) {
        if entry.page < 1 || entry.bbox[2] <= 0.0 || entry.bbox[3] <= 0.0 {
            violations.push(format!("清单条目 {} prov 无效: page={} bbox={:?}", entry.id, entry.page, entry.bbox));
        }
    }
    for reference in &paper.references {
        for c in &reference.cited_at {
            if c.sec_id.is_empty() || c.block_id < 1 || c.page < 1 {
                violations.push(format!("{} 引用处 prov 无效: {c:?}", reference.id));
            }
        }
    }

    // 阅读顺序（User Story 1，双栏串栏探针）：编号节的编号按文档序严格递增
    // （阿拉伯与罗马各自取值；无编号节不参与）。
    let mut last: Option<u32> = None;
    for section in &paper.sections {
        let value = section
            .number
            .as_deref()
            .and_then(|n| n.parse::<u32>().ok().or_else(|| roman_value(n)));
        if let Some(value) = value {
            if let Some(prev) = last {
                if value <= prev {
                    violations.push(format!(
                        "节编号乱序: {:?}（编号 {value}）出现在编号 {prev} 之后",
                        section.title
                    ));
                }
            }
            last = Some(value);
        }
    }
    violations
}

fn roman_value(s: &str) -> Option<u32> {
    Some(match s {
        "I" => 1,
        "II" => 2,
        "III" => 3,
        "IV" => 4,
        "V" => 5,
        "VI" => 6,
        "VII" => 7,
        "VIII" => 8,
        "IX" => 9,
        "X" => 10,
        _ => return None,
    })
}

/// 清单策展断言违例（per-paper 基线）。
fn expect_violations(entry: &Value, paper: &MappedPaper) -> Vec<String> {
    let expect = &entry["expect"];
    let id = entry["id"].as_str().unwrap();
    let mut violations = Vec::new();

    if let Some(title) = expect["title"].as_str() {
        if paper.title.as_deref() != Some(title) {
            violations.push(format!("title 期望 {title:?}，实得 {:?}", paper.title));
        }
    }
    if paper.page_count != entry["pages"].as_u64().unwrap() as u32 {
        violations.push(format!("页数期望 {}，实得 {}", entry["pages"], paper.page_count));
    }

    let titles: Vec<&str> = paper.sections.iter().map(|s| s.title.as_str()).collect();
    for expected in expect["sectionsContain"].as_array().unwrap() {
        let expected = expected.as_str().unwrap();
        if !titles.contains(&expected) {
            violations.push(format!("缺节 {expected:?}（实有 {titles:?}）"));
        }
    }
    for banned in expect["sectionsNotContain"].as_array().map(|v| v.as_slice()).unwrap_or(&[]) {
        let banned = banned.as_str().unwrap();
        if titles.iter().any(|t| t.contains(banned)) {
            violations.push(format!("误判标题不应成节: {banned:?}"));
        }
    }

    // 附录存活：role==Appendix 的节编号集合精确匹配（User Story 3）；
    // 编号为 null 表示无编号扉页（XGBoost "APPENDIX" / BERT "Appendix for ..."）。
    let mut appendix: Vec<Option<&str>> = paper
        .sections
        .iter()
        .filter(|s| s.role == SectionRole::Appendix)
        .map(|s| s.number.as_deref())
        .collect();
    appendix.sort();
    let mut expected: Vec<Option<&str>> = expect["appendixNumbers"]
        .as_array()
        .map(|v| v.iter().map(|n| n.as_str()).collect())
        .unwrap_or_default();
    expected.sort();
    if appendix != expected {
        violations.push(format!("附录节编号期望 {expected:?}，实得 {appendix:?}"));
    }

    let counts: HashMap<&str, usize> = [
        ("minSubsections", subsection_count(paper)),
        ("minFormulas", all_blocks(paper).filter(|b| b.kind == BlockKind::Formula).count()),
        ("minFootnotes", all_blocks(paper).filter(|b| b.kind == BlockKind::Footnote).count()),
        ("minFigures", paper.figures.len()),
        ("minTables", paper.tables.len()),
        ("minFurniture", paper.furniture.len()),
    ]
    .into_iter()
    .collect();
    for (key, actual) in counts {
        let minimum = expect[key].as_u64().unwrap_or(0) as usize;
        if actual < minimum {
            violations.push(format!("{key} 期望 ≥{minimum}，实得 {actual}"));
        }
    }

    // 参考文献基线：条目数精确（编号引用制），或空清单 + 指定 warning（降级制）。
    let expected_refs = expect["references"]["count"].as_u64().unwrap() as usize;
    if paper.references.len() != expected_refs {
        violations.push(format!("参考文献条目期望 {expected_refs}，实得 {}", paper.references.len()));
    }
    if expected_refs == 0 {
        if let Some(warning) = expect["references"]["warning"].as_str() {
            if !paper.warnings.iter().any(|w| w == warning) {
                violations.push(format!("空参考文献清单应带 warning {warning:?}（实有 {:?}）", paper.warnings));
            }
        }
    } else {
        let cited = paper.references.iter().filter(|r| !r.cited_at.is_empty()).count();
        let min_cited = expect["references"]["minCited"].as_u64().unwrap_or(0) as usize;
        if cited < min_cited {
            violations.push(format!("正文引用覆盖期望 ≥{min_cited}，实得 {cited}"));
        }
    }

    if violations.is_empty() {
        eprintln!("[回归 {id}] 结构断言通过");
    }
    violations
}

/// dump 模式的单篇事实（人工策展 manifest 的依据 + 版本升级同机对照数据）。
fn dump_facts(entry: &Value, paper: &MappedPaper, measured_seconds: Option<f64>, docling_version: Option<&str>) -> Value {
    let counts = |kind: BlockKind| all_blocks(paper).filter(|b| b.kind == kind).count();
    json!({
        "id": entry["id"],
        "pdf": entry["pdf"],
        "pages": paper.page_count,
        "baselineSeconds": entry["baselineSeconds"],
        "measuredSeconds": measured_seconds,
        "doclingVersion": docling_version,
        "facts": {
            "title": paper.title,
            "sections": paper.sections.iter().map(|s| json!({
                "title": s.title, "number": s.number, "role": format!("{:?}", s.role),
            })).collect::<Vec<_>>(),
            "counts": {
                "subsections": subsection_count(paper),
                "paragraphs": counts(BlockKind::Paragraph),
                "headings": counts(BlockKind::Heading),
                "formulas": counts(BlockKind::Formula),
                "footnotes": counts(BlockKind::Footnote),
                "figures": paper.figures.len(),
                "tables": paper.tables.len(),
                "furniture": paper.furniture.len(),
                "references": paper.references.len(),
                "referencesCited": paper.references.iter().filter(|r| !r.cited_at.is_empty()).count(),
            },
            "warnings": paper.warnings,
            "engineViolations": engine_violations(paper),
        }
    })
}

// ============================================================================
// 运行辅助
// ============================================================================

fn perf_factor() -> f64 {
    std::env::var(ENV_PERF_FACTOR)
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|f| *f > 0.0)
        .unwrap_or(1.0)
}

/// assert 模式下侧车必须在场（回归门禁不做"跳过即通过"）。
fn require_sidecar() {
    let dir = tempfile::tempdir().expect("临时目录");
    let library = paper30min_lib::library::Library::open(dir.path()).expect("临时书库");
    let status = pdfparse::status(&library);
    let ready = status["ready"].as_bool().unwrap_or(false);
    assert!(ready, "回归夹具要求侧车就绪（构建见 tools/pdfparse-sidecar/README.md）: {status}");
}

fn convert_pdf(pdf: &Path, work_dir: &Path) -> Value {
    let (registry, _library, _dir) = common::env();
    let sink = Collector::new();
    let task_id = registry
        .start(
            pdfparse::TASK_CONVERT,
            json!({ "pdfPath": pdf.to_string_lossy(), "workDir": work_dir.to_string_lossy() }),
            sink.clone(),
        )
        .expect("启动 pdfparse.convert@1");
    let status = wait_terminal(&registry, &task_id, CONVERT_TIMEOUT).expect("转换超时");
    assert_eq!(status, TaskStatus::Succeeded, "事件流: {:?}", sink.events());
    registry
        .get(&task_id)
        .expect("任务快照")
        .result
        .expect("succeeded 应携带 result")
}

/// assert 模式单篇全流程：转换 → 版本钉 → 映射 → 引擎不变量 + 清单断言 → 性能门禁。
fn run_corpus_paper(id: &str) {
    if mode() != Mode::Assert {
        eprintln!("跳过回归夹具 {id}（设 {ENV_FIXTURES}=1 运行 assert 模式，=dump 重建基线）");
        return;
    }
    require_sidecar();
    let _guard = SIDECAR_LOCK.lock().unwrap();

    let manifest = load_manifest();
    let entry = paper_entry(&manifest, id);
    let pdf = fixtures_dir().join(entry["pdf"].as_str().unwrap());
    let work = tempfile::tempdir().expect("临时工作目录");

    let result = convert_pdf(&pdf, work.path());

    // Docling 版本锁定：升级必须先走基线重建流程再放宽本断言。
    assert_eq!(
        result["doclingVersion"].as_str().unwrap(),
        manifest["doclingVersion"].as_str().unwrap(),
        "Docling 版本与锁定不一致（升级流程见 tools/pdfparse-sidecar/README.md）"
    );

    let docling_path = PathBuf::from(result["doclingJsonPath"].as_str().expect("doclingJsonPath"));
    let paper = map_docling_json_file(&docling_path).expect("映射应成功");

    let mut violations = engine_violations(&paper);
    violations.extend(expect_violations(entry, &paper));
    assert!(violations.is_empty(), "{id} 回归断言失败:\n{}", violations.join("\n"));

    // 性能门禁：elapsed ≤ 基线 × 1.5 × 机器系数。
    let elapsed = result["elapsedMs"].as_u64().unwrap() as f64 / 1000.0;
    let baseline = entry["baselineSeconds"].as_f64().unwrap();
    let factor = manifest["perfFactor"].as_f64().unwrap() * perf_factor();
    let gate = baseline * factor;
    let ratio = elapsed / baseline;
    eprintln!("[回归 {id}] 耗时 {elapsed:.1}s / 基线 {baseline}s = {ratio:.2}×（门禁 ≤{gate:.0}s）");
    assert!(
        elapsed <= gate,
        "{id} 性能门禁失败：{elapsed:.1}s 超基线 {baseline}s 的 {factor:.2} 倍（{gate:.0}s）；\
         机器繁忙时设 {ENV_PERF_FACTOR} 放宽并在升级报告说明"
    );
}

macro_rules! corpus_test {
    ($name:ident, $id:literal) => {
        #[test]
        fn $name() {
            run_corpus_paper($id);
        }
    };
}

corpus_test!(paper_1412_6980_adam, "1412.6980");
corpus_test!(paper_1503_02531_distilling, "1503.02531");
corpus_test!(paper_1512_03385_resnet, "1512.03385");
corpus_test!(paper_1603_02754_xgboost, "1603.02754");
corpus_test!(paper_1608_08225_physrev, "1608.08225");
corpus_test!(paper_1610_00633_naf, "1610.00633");
corpus_test!(paper_1706_03762_attention, "1706.03762");
corpus_test!(paper_1712_01815_alphazero, "1712.01815");
corpus_test!(paper_1810_04805_bert, "1810.04805");
corpus_test!(paper_2106_09685_lora, "2106.09685");

/// 矢量与图片公式样例（#34 三类之「矢量与图片公式」）：图形内容不得静默产出
/// 失真文本；被检出的图形区域必须是占位块 + 可裁切 bbox；节边界不受图形干扰。
#[test]
fn formula_graphics_sample_never_garbles_text() {
    if mode() != Mode::Assert {
        eprintln!("跳过公式图形样例（设 {ENV_FIXTURES}=1 运行）");
        return;
    }
    require_sidecar();
    let _guard = SIDECAR_LOCK.lock().unwrap();

    let work = tempfile::tempdir().expect("临时工作目录");
    let result = convert_pdf(&formula_graphics_pdf(), work.path());
    let manifest = load_manifest();
    assert_eq!(
        result["doclingVersion"].as_str().unwrap(),
        manifest["doclingVersion"].as_str().unwrap()
    );
    let paper = map_docling_json_file(Path::new(result["doclingJsonPath"].as_str().unwrap()))
        .expect("映射应成功");

    assert_eq!(paper.title.as_deref(), Some("Formula Graphics Fixture"));
    let titles: Vec<&str> = paper.sections.iter().map(|s| s.title.as_str()).collect();
    for expected in ["1. Introduction", "2. Conclusion"] {
        assert!(titles.contains(&expected), "缺节 {expected}: {titles:?}");
    }

    // 已知文本全集：图形区域（矢量路径、位图）不含文本层，块流中只允许出现
    // 这些真实文本 —— 任何多出来的文本块都是失真泄漏。
    let known = |text: &str| fixture_texts::FORMULA_GRAPHICS_TEXTS.contains(&text);
    for block in all_blocks(&paper) {
        match block.kind {
            BlockKind::Paragraph | BlockKind::Heading | BlockKind::Footnote => {
                assert!(known(&block.text), "图形内容泄漏为文本块: {:?}", block.text);
            }
            BlockKind::Figure | BlockKind::Formula => {
                assert!(block.text.starts_with('['), "图形块应为占位行: {:?}", block.text);
                let bbox = block.bbox.expect("图形块应有可裁切 bbox");
                assert!(bbox[2] > 0.0 && bbox[3] > 0.0, "bbox 应有正宽高: {bbox:?}");
            }
            BlockKind::Table => {
                assert!(block.text.contains('|'), "表块应为 MD: {:?}", block.text);
            }
        }
    }
    // 非空断言：两个图形区域至少其一被检出为占位块（诚实档允许漏检，但该页
    // 图形区域显著，全漏说明布局模型退化）。
    let detected = all_blocks(&paper)
        .filter(|b| matches!(b.kind, BlockKind::Figure | BlockKind::Formula))
        .count();
    assert!(detected >= 1, "矢量/位图公式区域应至少检出一个占位块");
}

/// dump 模式：全链（或从 DUMP_DIR 既有 docling.json）重建事实，写
/// `manifest.dump.json` 供人工策展；引擎不变量违例一并写入（应为空）。
#[test]
fn dump_baseline_facts() {
    if mode() != Mode::Dump {
        eprintln!("跳过基线 dump（设 {ENV_FIXTURES}=dump 运行）");
        return;
    }
    let manifest = load_manifest();
    let dump_dir = std::env::var(ENV_DUMP_DIR).ok().map(PathBuf::from);
    if dump_dir.is_none() {
        require_sidecar();
    }
    let _guard = SIDECAR_LOCK.lock().unwrap();

    let mut out = Vec::new();
    for entry in manifest["papers"].as_array().unwrap() {
        let id = entry["id"].as_str().unwrap();
        let (docling_path, measured_seconds, docling_version) = match &dump_dir {
            Some(dir) => (dir.join(format!("{id}.json")), None, None),
            None => {
                let pdf = fixtures_dir().join(entry["pdf"].as_str().unwrap());
                let work = tempfile::tempdir().expect("临时工作目录");
                let result = convert_pdf(&pdf, work.path());
                let path = PathBuf::from(result["doclingJsonPath"].as_str().unwrap());
                let seconds = result["elapsedMs"].as_u64().unwrap() as f64 / 1000.0;
                let version = result["doclingVersion"].as_str().map(str::to_string);
                // 临时目录随 work 删除前先把 JSON 读出来映射。
                let paper = map_docling_json_file(&path).expect("映射应成功");
                let facts = dump_facts(entry, &paper, Some(seconds), version.as_deref());
                eprintln!("[dump {id}] {seconds:.1}s 引擎违例 {} 项", facts["facts"]["engineViolations"].as_array().unwrap().len());
                out.push(facts);
                continue;
            }
        };
        let paper = map_docling_json_file(&docling_path)
            .unwrap_or_else(|e| panic!("映射 {id} 失败（{}）: {e}", docling_path.display()));
        let facts = dump_facts(entry, &paper, measured_seconds, docling_version);
        eprintln!("[dump {id}] 引擎违例 {} 项", facts["facts"]["engineViolations"].as_array().unwrap().len());
        out.push(facts);
    }

    let target = fixtures_dir().join("manifest.dump.json");
    let text = serde_json::to_string_pretty(&json!({
        "doclingVersion": manifest["doclingVersion"],
        "papers": out,
    }))
    .expect("序列化 dump");
    std::fs::write(&target, text).expect("写 manifest.dump.json");
    eprintln!("基线草案已写 {}", target.display());
}
