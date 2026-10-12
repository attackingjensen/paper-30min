//! pdfassets 预渲染契约测试（Issue #59，规格 #48 §双通道资产）。
//! 驱动方式：合成 DoclingDocument JSON（pdfmap 输入契约）→ pdfassets.prerender@1
//! 任务 → 断言附件落库、verify 缝、渲染产物尺寸与 token 预算；只断言外部可观察
//! 行为，不断言侧车内部中间态。
//!
//! 渲染子命令只需 pypdfium2 + Pillow（deps_ready 门禁），不要求布局/OCR 模型；
//! 侧车缺失或依赖未装时跳过并打印原因，`PAPER30MIN_PDFPARSE_REQUIRE=1` 强制失败。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::files::AttachmentWrite;
use paper30min_lib::pdfassets;
use paper30min_lib::tasks::TaskStatus;
use paper30min_lib::testkit::{wait_terminal, Collector};
use serde_json::{json, Value};
use lopdf::dictionary;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 渲染与 convert 共用同一侧车，串行防资源争抢。
static SIDECAR_LOCK: Mutex<()> = Mutex::new(());

/// 取锁：容毒（#89）——单个用例持锁 panic 后，其余用例 `into_inner()` 继续用，
/// 不再以 PoisonError 级联失败。
fn sidecar_guard() -> std::sync::MutexGuard<'static, ()> {
    SIDECAR_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

const PRERENDER_TIMEOUT: Duration = Duration::from_secs(120);

fn sample_pdf() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("ui")
        .join("samples")
        .join("sample_paper.pdf")
}

/// 侧车渲染路径就绪（python + 依赖；渲染不要求模型权重）。
fn render_ready() -> bool {
    let Some(layout) =
        paper30min_lib::pdfparse::resolve_sidecar(Path::new(env!("CARGO_MANIFEST_DIR")))
    else {
        return false;
    };
    paper30min_lib::pdfparse::deps_ready(&layout.root)
}

fn require_render_ready() -> bool {
    if render_ready() {
        return true;
    }
    if std::env::var("PAPER30MIN_PDFPARSE_REQUIRE").is_ok() {
        panic!("PAPER30MIN_PDFPARSE_REQUIRE=1 但侧车依赖未就绪");
    }
    eprintln!("跳过 pdfassets 契约测试（侧车依赖未就绪）");
    false
}

/// 合成 DoclingDocument：与 sample_paper.pdf 对应的两页结构（612×792pt），
/// 第 1 页一张图（图注 "Figure 1: ..." → fig_1，bbox → 视口 [200,384,800,400]）。
fn synthetic_docling_json() -> Value {
    let prov = |page: u32, l: f64, b: f64, r: f64, t: f64| json!([{ "page_no": page, "bbox": { "l": l, "t": t, "r": r, "b": b, "coord_origin": "BOTTOMLEFT" }, "charspan": [0, 0] }]);
    let text = |idx: u32, label: &str, content: &str, page: u32| {
        json!({
            "self_ref": format!("#/texts/{idx}"), "parent": { "$ref": "#/body" }, "children": [],
            "content_layer": "body", "label": label, "prov": prov(page, 72.0, 700.0, 540.0, 712.0),
            "orig": content, "text": content,
        })
    };
    json!({
        "schema_name": "DoclingDocument", "version": "1.10.0", "name": "sample_paper.pdf",
        "texts": [
            text(0, "section_header", "SampleNet: Contrastive Distillation for Neural Paper Summarization", 1),
            text(1, "section_header", "1. Introduction", 1),
            text(2, "text", "We introduce a sample section with one figure.", 1),
            text(3, "caption", "Figure 1: Sample architecture overview.", 1),
            text(4, "section_header", "2. Conclusion", 2),
            text(5, "text", "A short conclusion.", 2),
            text(6, "formula", "", 2),
        ],
        "tables": [],
        "pictures": [
            {
                "self_ref": "#/pictures/0", "parent": { "$ref": "#/body" }, "children": [],
                "label": "picture", "prov": prov(1, 100.0, 400.0, 500.0, 600.0),
                "captions": [{ "$ref": "#/texts/3" }],
            }
        ],
        "groups": [],
        "body": {
            "children": [
                { "$ref": "#/texts/0" },
                { "$ref": "#/texts/1" },
                { "$ref": "#/texts/2" },
                { "$ref": "#/pictures/0" },
                { "$ref": "#/texts/4" },
                { "$ref": "#/texts/5" },
                { "$ref": "#/texts/6" },
            ]
        },
        "pages": {
            "1": { "size": { "width": 612.0, "height": 792.0 }, "page_no": 1 },
            "2": { "size": { "width": 612.0, "height": 792.0 }, "page_no": 2 },
        },
    })
}

fn put_paper(
    registry: &Arc<paper30min_lib::tasks::TaskRegistry>,
    library: &paper30min_lib::library::Library,
    id: &str,
) {
    bridge::invoke(
        registry,
        library,
        "library.putPaper@1",
        &json!({ "paper": {
            "id": id, "title": "SampleNet", "sourceType": "local-pdf", "arxivId": null,
            "pdfName": "sample_paper.pdf", "numPages": 2, "fullText": "", "rating": 3,
            "categories": [], "tags": [],
            "addedAt": "2026-09-01T08:00:00Z", "updatedAt": "2026-09-01T09:00:00Z",
            "sections": [], "parts": [], "analyses": [], "translations": [],
            "recallCard": { "markdown": "", "images": [] }, "chatMessages": [],
        } }),
    )
    .expect("建论文记录");
}

fn start_prerender(
    registry: &Arc<paper30min_lib::tasks::TaskRegistry>,
    input: Value,
) -> (String, Arc<Collector>) {
    let sink = Collector::new();
    let task_id = registry
        .start(pdfassets::TASK_PRERENDER, input, sink.clone())
        .expect("启动 pdfassets.prerender@1");
    (task_id, sink)
}

#[test]
fn prerender_rejects_missing_inputs_at_plan() {
    let (registry, _library, _dir) = common::env();
    let error = registry
        .start(pdfassets::TASK_PRERENDER, json!({}), Collector::new())
        .expect_err("缺 paperId 应在计划阶段拒绝");
    assert_eq!(error.code, "invalid_input");
    let error = registry
        .start(
            pdfassets::TASK_PRERENDER,
            json!({ "paperId": "p-1" }),
            Collector::new(),
        )
        .expect_err("默认 scope=all 缺 doclingJsonPath 应在计划阶段拒绝");
    assert_eq!(error.code, "invalid_input");
    let error = registry
        .start(
            pdfassets::TASK_PRERENDER,
            json!({ "paperId": "p-1", "scope": "crops" }),
            Collector::new(),
        )
        .expect_err("scope=crops 缺 doclingJsonPath 应在计划阶段拒绝");
    assert_eq!(error.code, "invalid_input");
    let error = registry
        .start(
            pdfassets::TASK_PRERENDER,
            json!({ "paperId": "p/1", "doclingJsonPath": "x.json" }),
            Collector::new(),
        )
        .expect_err("非法 paperId 应在计划阶段拒绝");
    assert_eq!(error.code, "invalid_input");
}

#[test]
fn prerender_rejects_invalid_scope_at_plan() {
    let (registry, _library, _dir) = common::env();
    let error = registry
        .start(
            pdfassets::TASK_PRERENDER,
            json!({ "paperId": "p-1", "scope": "both", "doclingJsonPath": "x.json" }),
            Collector::new(),
        )
        .expect_err("非法 scope 应在计划阶段拒绝");
    assert_eq!(error.code, "invalid_input");
    let error = registry
        .start(
            pdfassets::TASK_PRERENDER,
            json!({ "paperId": "p-1", "scope": 1, "doclingJsonPath": "x.json" }),
            Collector::new(),
        )
        .expect_err("非字符串 scope 应在计划阶段拒绝");
    assert_eq!(error.code, "invalid_input");
}

#[test]
fn prerender_pages_scope_does_not_require_docling_json_path() {
    let (registry, _library, _dir) = common::env();
    let error = registry
        .start(
            pdfassets::TASK_PRERENDER,
            json!({ "paperId": "no-such", "scope": "pages" }),
            Collector::new(),
        )
        .expect_err("缺少论文应在捕获解析版本时拒绝");
    assert_eq!(
        error.code, "not_found",
        "scope=pages 不要求 doclingJsonPath，但仍需有效论文身份"
    );
}

#[test]
fn prerender_fails_when_paper_missing() {
    let (registry, _library, dir) = common::env();
    let docling_path = dir.path().join("docling.json");
    std::fs::write(&docling_path, synthetic_docling_json().to_string()).unwrap();
    let error = registry
        .start(
            pdfassets::TASK_PRERENDER,
            json!({ "paperId": "no-such", "doclingJsonPath": docling_path.to_string_lossy() }),
            Collector::new(),
        )
        .expect_err("捕获解析版本时拒绝不存在的论文");
    assert_eq!(error.code, "not_found");
}

#[test]
fn prerender_fails_when_docling_json_missing_or_invalid() {
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "p-1");
    let (task_id, _sink) = start_prerender(
        &registry,
        json!({ "paperId": "p-1", "doclingJsonPath": dir.path().join("none.json").to_string_lossy() }),
    );
    let status = wait_terminal(&registry, &task_id, Duration::from_secs(10)).expect("任务超时");
    assert_eq!(status, TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "docling_json_invalid");

    std::fs::write(dir.path().join("bad.json"), "{ not json").unwrap();
    let (task_id, _sink) = start_prerender(
        &registry,
        json!({ "paperId": "p-1", "doclingJsonPath": dir.path().join("bad.json").to_string_lossy() }),
    );
    let status = wait_terminal(&registry, &task_id, Duration::from_secs(10)).expect("任务超时");
    assert_eq!(status, TaskStatus::Failed);
    assert_eq!(
        registry.get(&task_id).unwrap().error.unwrap().code,
        "docling_json_invalid"
    );
}

#[test]
fn prerender_fails_when_pdf_attachment_missing() {
    // 默认 pdfPath = 论文的 pdf 附件；论文无附件时报 pdf_not_found（不启动子进程）。
    let (registry, library, dir) = common::env();
    put_paper(&registry, &library, "p-1");
    let docling_path = dir.path().join("docling.json");
    std::fs::write(&docling_path, synthetic_docling_json().to_string()).unwrap();
    let (task_id, _sink) = start_prerender(
        &registry,
        json!({ "paperId": "p-1", "doclingJsonPath": docling_path.to_string_lossy() }),
    );
    let status = wait_terminal(&registry, &task_id, Duration::from_secs(10)).expect("任务超时");
    assert_eq!(status, TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "pdf_not_found");
}

#[test]
fn prerender_full_chain_stores_verified_assets() {
    let (registry, library, dir) = common::env();
    if !require_render_ready() {
        return;
    }
    let _guard = sidecar_guard();
    put_paper(&registry, &library, "p-1");
    // PDF 走附件缝落库（id 固定 'pdf'），prerender 用默认路径解析。
    let pdf_bytes = std::fs::read(sample_pdf()).expect("读取示例 PDF");
    library
        .put_attachment(
            "p-1",
            AttachmentWrite {
                id: "pdf".to_string(),
                name: "sample_paper.pdf".to_string(),
                content_type: Some("application/pdf".to_string()),
                content_base64: base64_encode(&pdf_bytes),
            },
        )
        .expect("PDF 附件落库");
    let docling_path = dir.path().join("docling.json");
    std::fs::write(&docling_path, synthetic_docling_json().to_string()).unwrap();

    let (task_id, sink) = start_prerender(
        &registry,
        json!({ "paperId": "p-1", "doclingJsonPath": docling_path.to_string_lossy() }),
    );
    let status = wait_terminal(&registry, &task_id, PRERENDER_TIMEOUT).expect("渲染超时");
    assert_eq!(status, TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    let result = registry
        .get(&task_id)
        .unwrap()
        .result
        .expect("succeeded 应携带 result");
    assert_eq!(result["pages"], json!(2));
    assert_eq!(result["scope"], json!("all"));
    assert_eq!(result["blockModelAssetId"], json!("blockmodel.json"));
    assert!(result["renderMs"].as_u64().is_some(), "应有 renderMs");
    assert!(result["encodeMs"].as_u64().is_some(), "应有 encodeMs");

    // 页图：1224×1584（612×792pt @scale=2），token 预算与 #38 实测一致（1902/页）。
    let page_assets = result["pageAssets"].as_array().unwrap();
    assert_eq!(page_assets.len(), 2);
    for (index, asset) in page_assets.iter().enumerate() {
        assert_eq!(asset["page"], json!(index + 1));
        assert_eq!(asset["assetId"], json!(format!("pageimg-{:04}", index + 1)));
        assert_eq!(asset["width"], json!(1224));
        assert_eq!(asset["height"], json!(1584));
        assert_eq!(asset["estimatedTokens"], json!(1902));
        assert!(asset["bytes"].as_u64().unwrap() > 0);
        assert_eq!(asset["sha256"].as_str().unwrap().len(), 64);
    }
    // 裁切图：bbox 视口 [200,384,800,400] → 800×400。
    let crops = result["crops"].as_array().unwrap();
    assert_eq!(crops.len(), 2, "图裁切 + 公式裁切（#48 决策 13）");
    assert_eq!(crops[0]["id"], json!("fig_1"));
    assert_eq!(crops[0]["assetId"], json!("crop-fig_1"));
    assert_eq!(crops[0]["width"], json!(800));
    assert_eq!(crops[0]["height"], json!(400));
    // 公式块（sec_2 第 2 块）：bbox 视口 [144,160,936,24]，ID 从地址派生。
    assert_eq!(crops[1]["id"], json!("fml-sec_2_2-conclusion-b2"));
    assert_eq!(crops[1]["assetId"], json!("crop-fml-sec_2_2-conclusion-b2"));
    assert_eq!(crops[1]["page"], json!(2));
    assert_eq!(crops[1]["width"], json!(936));
    assert_eq!(crops[1]["height"], json!(24));
    assert_eq!(result["skippedCrops"], json!([]));

    // verify 缝：全部产物（页图 + 裁切图 + 块模型）逐件通过完整性校验。
    let attachments = library.list_attachments("p-1").expect("附件清单");
    let ids: Vec<&str> = attachments.iter().map(|a| a.id.as_str()).collect();
    for expected in [
        "pdf",
        "pageimg-0001",
        "pageimg-0002",
        "crop-fig_1",
        "crop-fml-sec_2_2-conclusion-b2",
        "blockmodel.json",
    ] {
        assert!(ids.contains(&expected), "附件清单缺 {expected}: {ids:?}");
        library
            .verify_attachment("p-1", expected)
            .unwrap_or_else(|err| panic!("附件 {expected} 完整性校验失败: {err}"));
    }

    // webp 魔数：RIFF....WEBP。
    let (_, head) = library
        .read_range("p-1", "pageimg-0001", 0, 12)
        .expect("读页图头");
    assert_eq!(&head[0..4], b"RIFF");
    assert_eq!(&head[8..12], b"WEBP");

    // 块模型附件可读回且图表清单含 fig_1（#55 工具数据源）。
    let blockmodel = library
        .get_attachment("p-1", "blockmodel.json")
        .expect("块模型附件");
    let (_, bytes) = library
        .read_range("p-1", "blockmodel.json", 0, blockmodel.size as u64)
        .expect("读块模型");
    let model: Value = serde_json::from_slice(&bytes).expect("块模型应为合法 JSON");
    assert_eq!(model["figures"][0]["id"], json!("fig_1"));
    assert_eq!(model["pageCount"], json!(2));

    // 幂等：重跑覆盖同名附件，不报错不重复。
    let (task_id, _sink) = start_prerender(
        &registry,
        json!({ "paperId": "p-1", "doclingJsonPath": docling_path.to_string_lossy() }),
    );
    let status = wait_terminal(&registry, &task_id, PRERENDER_TIMEOUT).expect("重跑超时");
    assert_eq!(status, TaskStatus::Succeeded);
    let attachments = library.list_attachments("p-1").expect("附件清单");
    assert_eq!(
        attachments
            .iter()
            .filter(|a| a.id == "pageimg-0001")
            .count(),
        1,
        "重跑不应产生重复附件"
    );
    library
        .verify_attachment("p-1", "pageimg-0001")
        .expect("重跑后校验");
}

fn put_pdf(library: &paper30min_lib::library::Library, paper_id: &str) {
    let pdf_bytes = std::fs::read(sample_pdf()).expect("读取示例 PDF");
    library
        .put_attachment(
            paper_id,
            AttachmentWrite {
                id: "pdf".to_string(),
                name: "sample_paper.pdf".to_string(),
                content_type: Some("application/pdf".to_string()),
                content_base64: base64_encode(&pdf_bytes),
            },
        )
        .expect("PDF 附件落库");
}

fn put_blockmodel(library: &paper30min_lib::library::Library, paper_id: &str) {
    let mapped =
        paper30min_lib::pdfmap::map_docling_json_str(&synthetic_docling_json().to_string())
            .expect("合成块模型");
    let bytes = serde_json::to_vec_pretty(&mapped).expect("序列化块模型");
    library
        .put_attachment(
            paper_id,
            AttachmentWrite {
                id: pdfassets::BLOCKMODEL_ATTACHMENT_ID.to_string(),
                name: pdfassets::BLOCKMODEL_ATTACHMENT_ID.to_string(),
                content_type: Some("application/json".to_string()),
                content_base64: base64_encode(&bytes),
            },
        )
        .expect("块模型附件落库");
}

fn attachment_ids(library: &paper30min_lib::library::Library, paper_id: &str) -> Vec<String> {
    library
        .list_attachments(paper_id)
        .expect("附件清单")
        .into_iter()
        .map(|item| item.id)
        .collect()
}

#[test]
fn prerender_pages_scope_stores_only_page_images() {
    let (registry, library, _dir) = common::env();
    if !require_render_ready() {
        return;
    }
    let _guard = sidecar_guard();
    put_paper(&registry, &library, "p-1");
    put_pdf(&library, "p-1");

    let (task_id, sink) = start_prerender(&registry, json!({ "paperId": "p-1", "scope": "pages" }));
    let status = wait_terminal(&registry, &task_id, PRERENDER_TIMEOUT).expect("渲染超时");
    assert_eq!(status, TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    let result = registry
        .get(&task_id)
        .unwrap()
        .result
        .expect("succeeded 应携带 result");
    assert_eq!(result["scope"], json!("pages"));
    assert_eq!(result["pages"], json!(2));
    assert!(
        result.get("blockModelAssetId").is_none(),
        "scope=pages 不落块模型"
    );
    assert_eq!(result["crops"], json!([]));
    let page_assets = result["pageAssets"].as_array().unwrap();
    assert_eq!(page_assets.len(), 2);
    assert_eq!(page_assets[0]["assetId"], json!("pageimg-0001"));
    assert_eq!(page_assets[1]["assetId"], json!("pageimg-0002"));

    let ids = attachment_ids(&library, "p-1");
    assert!(ids.contains(&"pageimg-0001".to_string()));
    assert!(ids.contains(&"pageimg-0002".to_string()));
    assert!(
        !ids.iter().any(|id| id.starts_with("crop-")),
        "scope=pages 不落裁切图: {ids:?}"
    );
    assert!(
        !ids.iter().any(|id| id == "blockmodel.json"),
        "scope=pages 不落块模型附件: {ids:?}"
    );
}

#[test]
fn prerender_crops_scope_stores_only_crops_and_block_model() {
    // 侧车作业 pages=[]、crops 非空：只渲染裁切所在页且不输出页图（#77）。
    let (registry, library, dir) = common::env();
    if !require_render_ready() {
        return;
    }
    let _guard = sidecar_guard();
    put_paper(&registry, &library, "p-1");
    put_pdf(&library, "p-1");
    put_blockmodel(&library, "p-1");

    let mut document = lopdf::Document::with_version("1.4");
    let pages_id = document.new_object_id();
    let mut page_ids = Vec::new();
    for _ in 0..2 {
        let contents = document.add_object(lopdf::Stream::new(lopdf::dictionary! {}, b"0 0 0 rg 100 400 400 200 re f\n".to_vec()));
        page_ids.push(lopdf::Object::Reference(document.add_object(lopdf::dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(),0.into(),612.into(),792.into()],
            "Resources" => lopdf::dictionary! {}, "Contents" => contents,
        })));
    }
    document.objects.insert(pages_id,lopdf::Object::Dictionary(lopdf::dictionary! { "Type" => "Pages", "Kids" => page_ids, "Count" => 2 }));
    let catalog = document.add_object(lopdf::dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root",catalog);
    let mut pdf_bytes = Vec::new();
    document.save_to(&mut pdf_bytes).unwrap();
    paper30min_lib::pdf_identity::read_pdf_identity_bytes(&pdf_bytes).expect("分步渲染夹具 PDF 身份有效");
    library.put_attachment("p-1",AttachmentWrite { id:"pdf".into(),name:"fixture.pdf".into(),content_type:Some("application/pdf".into()),content_base64:base64_encode(&pdf_bytes) }).unwrap();
    let pdf = library.verify_attachment("p-1", "pdf").unwrap();
    let mut raw = synthetic_docling_json();
    raw["origin"] = json!({"mimetype":"application/pdf","binary_hash":u64::from_str_radix(&pdf.sha256[48..],16).unwrap()});
    library.put_attachment("p-1",AttachmentWrite { id:"docling-source.json".into(),name:"docling-source.json".into(),content_type:Some("application/json".into()),content_base64:base64_encode(&serde_json::to_vec(&raw).unwrap()) }).unwrap();
    let mut paper = library.get_paper("p-1").unwrap();
    paper.products.push(paper30min_lib::library::ProductDto { kind:"map".into(),part_id:String::new(),body:json!({"markdown":"EARLY MAP"}),updated_at:"2026-10-06T00:00:00Z".into() });
    library.put_paper(paper).unwrap();

    let (task_id, sink) = start_prerender(
        &registry,
        json!({
            "paperId": "p-1",
            "scope": "crops",
            "doclingJsonPath": dir.path().join("unused.json").to_string_lossy(),
        }),
    );
    let status = wait_terminal(&registry, &task_id, PRERENDER_TIMEOUT).expect("渲染超时");
    assert_eq!(status, TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    let result = registry
        .get(&task_id)
        .unwrap()
        .result
        .expect("succeeded 应携带 result");
    assert_eq!(result["scope"], json!("crops"));
    assert_eq!(result["pages"], json!(0));
    assert_eq!(result["pageAssets"], json!([]));
    assert_eq!(result["blockModelAssetId"], json!("blockmodel.json"));
    let crops = result["crops"].as_array().unwrap();
    assert_eq!(crops.len(), 2, "图裁切 + 公式裁切");
    assert_eq!(crops[0]["id"], json!("fig_1"));
    assert_eq!(crops[0]["assetId"], json!("crop-fig_1"));

    let ids = attachment_ids(&library, "p-1");
    assert!(
        !ids.contains(&"crop-fig_1".to_string()),
        "候选裁切不覆盖旧逻辑附件"
    );
    assert!(ids.contains(&"blockmodel.json".to_string()));
    assert!(
        !ids.iter().any(|id| id.starts_with("pageimg-")),
        "scope=crops 不落页图: {ids:?}"
    );
    assert_eq!(result["candidateReady"], true);
    assert_eq!(result["visualReady"], false, "仅裁切不足以满足完整视觉替换");
    assert_eq!(result["resultReady"], false);
    assert_eq!(library.current_parse_batch_id("p-1").unwrap(), None);
    let snapshot: paper30min_lib::parsebatch::ParseBatchSnapshot =
        serde_json::from_value(result["snapshot"].clone()).unwrap();
    let (_, bytes) = library
        .read_parse_batch_attachment(&snapshot, "crop-fig_1")
        .expect("固定候选中的裁切可读");
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WEBP");
    let (_, model) = library
        .read_parse_batch_attachment(&snapshot, "blockmodel.json")
        .expect("固定候选中的模型可读");
    assert_eq!(
        serde_json::from_slice::<Value>(&model).unwrap()["figures"][0]["id"],
        "fig_1"
    );
    assert!(!snapshot.manifest.attachments.contains_key("pageimg-0001"));
    assert!(!snapshot.manifest.attachments.contains_key("pageimg-0002"));

    let (pages_task, pages_sink) = start_prerender(&registry, json!({
        "paperId":"p-1", "scope":"pages", "batchId":snapshot.manifest.batch_id,
    }));
    assert_eq!(wait_terminal(&registry,&pages_task,PRERENDER_TIMEOUT).unwrap(),TaskStatus::Succeeded,"事件流: {:?}",pages_sink.events());
    let completed = registry.get(&pages_task).unwrap().result.unwrap();
    assert_eq!(completed["visualReady"],true);
    assert_eq!(completed["resultReady"],true,"旧模型同一解析链补齐页图不要求重新解析确认");
    let current = library.pin_parse_batch("p-1",None).unwrap();
    assert_eq!(current.manifest.batch_id,completed["batchId"]);
    assert!(current.manifest.attachments.contains_key("crop-fig_1"));
    assert!(current.manifest.attachments.contains_key("pageimg-0001"));
    let paper = library.get_paper("p-1").unwrap();
    assert_eq!(paper.products[0].body["markdown"],"EARLY MAP","分步视觉补齐必须保留早期阅读产物");
    assert!(paper.parse_history.is_empty(),"同一解析链补图不创建替换历史");
    assert_eq!(library.read_parse_batch_attachment(&snapshot,"crop-fig_1").unwrap().1,bytes,"首个候选仍可读取");
}

#[test]
fn prerender_crops_falls_back_to_docling_when_block_model_missing() {
    let (registry, library, dir) = common::env();
    if !require_render_ready() {
        return;
    }
    let _guard = sidecar_guard();
    put_paper(&registry, &library, "p-1");
    put_pdf(&library, "p-1");
    let docling_path = dir.path().join("docling.json");
    std::fs::write(&docling_path, synthetic_docling_json().to_string()).unwrap();

    let (task_id, sink) = start_prerender(
        &registry,
        json!({
            "paperId": "p-1",
            "scope": "crops",
            "doclingJsonPath": docling_path.to_string_lossy(),
        }),
    );
    let status = wait_terminal(&registry, &task_id, PRERENDER_TIMEOUT).expect("渲染超时");
    assert_eq!(status, TaskStatus::Succeeded, "事件流: {:?}", sink.events());
    let result = registry.get(&task_id).unwrap().result.expect("result");
    assert_eq!(result["scope"], json!("crops"));
    assert_eq!(result["blockModelAssetId"], json!("blockmodel.json"));
    assert!(result["crops"].as_array().unwrap().len() >= 1);
    let ids = attachment_ids(&library, "p-1");
    assert!(ids.contains(&"blockmodel.json".to_string()));
    assert!(!ids.iter().any(|id| id.starts_with("pageimg-")));
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    BASE64.encode(bytes)
}
