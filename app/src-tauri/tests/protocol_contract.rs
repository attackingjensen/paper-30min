//! 三阶段协议任务契约测试（Issue #65 验收缝二）：mock 模型端点按脚本响应驱动
//! 工具循环，断言任务事件序列、产物落库、取消与上限语义。块模型使用磁盘夹具
//! （tests/fixtures/protocol/blockmodel-basic.json，src-tauri/tests/ 首例磁盘夹具）：
//! 三节（abstract + 两个内容节）+ 一图一表 + 一节参考文献，3 页。
//!
//! 驱动方式与既有契约测试一致：真实 Library（临时目录）+ TaskRegistry + testkit
//! MockHttp；只断言外部可观察行为（事件流、protocol_products、活动日、请求体）。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::files::AttachmentWrite;
use paper30min_lib::library::{Library, PaperDto, PartDto, ProductDto};
use paper30min_lib::protocol;
use paper30min_lib::tasks::{TaskRegistry, TaskStatus};
use paper30min_lib::testkit::{wait_terminal, Collector, MockHttp, MockRequest, MockResponse};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);

/// 磁盘夹具路径（块模型 JSON）。
fn fixture_blockmodel() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("protocol")
        .join("blockmodel-basic.json")
}

/// 本文件测试共用一把锁：护栏阈值的环境变量挂钩是进程级状态，且部分测试
/// 改动模型设置/产物，串行执行防串扰（各用例均为毫秒级）。
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 取锁宏：容毒（单个用例 panic 不级联后续用例）。
macro_rules! env_lock {
    () => {
        ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    };
}

/// 环境变量守卫：测试结束（含 panic）时移除，避免污染同进程其他测试。
struct EnvGuard(&'static str);

impl Drop for EnvGuard {
    fn drop(&mut self) {
        std::env::remove_var(self.0);
    }
}

/// 建立论文记录：parts = abstract + part-1（Introduction）+ part-2（Method），
/// 与夹具块模型的节序一一对应。
fn seed_paper(library: &Library) -> String {
    let paper = PaperDto {
        id: "paper-fixture".to_string(),
        title: "Fixture 论文：小样例方法".to_string(),
        parts: vec![
            PartDto { id: "abstract".to_string(), title: Some("Abstract".to_string()), heading: None, semantic_type: Some("abstract".to_string()), sort_order: 0 },
            PartDto { id: "part-1".to_string(), title: Some("Introduction".to_string()), heading: None, semantic_type: Some("introduction".to_string()), sort_order: 1 },
            PartDto { id: "part-2".to_string(), title: Some("Method".to_string()), heading: None, semantic_type: Some("method".to_string()), sort_order: 2 },
        ],
        ..Default::default()
    };
    library.put_paper(paper).expect("写入论文").id
}

/// 块模型附件落库（读磁盘夹具字节）。
fn seed_block_model(library: &Library, paper_id: &str) {
    let bytes = std::fs::read(fixture_blockmodel()).expect("读取块模型夹具");
    put_attachment(library, paper_id, "blockmodel.json", "application/json", &bytes);
}

fn seed_four_section_paper(library: &Library) -> String {
    let paper = PaperDto {
        id: "paper-four".to_string(),
        title: "Fixture 论文：四节并发".to_string(),
        parts: vec![
            PartDto { id: "abstract".to_string(), title: Some("Abstract".to_string()), heading: None, semantic_type: Some("abstract".to_string()), sort_order: 0 },
            PartDto { id: "part-1".to_string(), title: Some("Introduction".to_string()), heading: None, semantic_type: Some("introduction".to_string()), sort_order: 1 },
            PartDto { id: "part-2".to_string(), title: Some("Method".to_string()), heading: None, semantic_type: Some("method".to_string()), sort_order: 2 },
            PartDto { id: "part-3".to_string(), title: Some("Experiments".to_string()), heading: None, semantic_type: Some("experiments".to_string()), sort_order: 3 },
        ],
        ..Default::default()
    };
    let paper_id = library.put_paper(paper).expect("写入论文").id;
    let mut mapped: Value = serde_json::from_slice(&std::fs::read(fixture_blockmodel()).expect("读取块模型夹具"))
        .expect("解析块模型夹具");
    let sections = mapped["sections"].as_array_mut().expect("sections");
    let references = sections.pop().expect("references 节");
    sections.push(json!({
        "id": "sec_4_experiments",
        "ordinal": 4,
        "title": "Experiments",
        "number": "3",
        "role": "body",
        "pageStart": 3,
        "pageEnd": 3,
        "blocks": [
            { "id": 1, "kind": "paragraph", "text": "实验表明方法有效。", "page": 3, "y": 50.0 }
        ],
        "subsections": []
    }));
    let mut references = references;
    references["ordinal"] = json!(5);
    references["id"] = json!("sec_5_references");
    sections.push(references);
    put_attachment(
        library,
        &paper_id,
        "blockmodel.json",
        "application/json",
        &serde_json::to_vec(&mapped).expect("编码四节块模型"),
    );
    paper_id
}

/// 页图与裁切图附件：页 img 3 页 + crop-fig_1 + crop-tbl_1（内容为测试字节，不真渲染）。
fn seed_assets(library: &Library, paper_id: &str) {
    for page in 1..=3u32 {
        let id = format!("pageimg-{page:04}");
        put_attachment(library, paper_id, &id, "image/webp", format!("page-{page}").as_bytes());
    }
    put_attachment(library, paper_id, "crop-fig_1", "image/webp", b"crop-fig");
    put_attachment(library, paper_id, "crop-tbl_1", "image/webp", b"crop-tbl");
}

fn put_attachment(library: &Library, paper_id: &str, id: &str, content_type: &str, bytes: &[u8]) {
    use base64::Engine;
    library
        .put_attachment(
            paper_id,
            AttachmentWrite {
                id: id.to_string(),
                name: id.to_string(),
                content_type: Some(content_type.to_string()),
                content_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            },
        )
        .expect("写入附件");
}

/// 已建图状态：map + 三节 l2 产物。
fn seed_built_products(library: &Library, paper_id: &str) {
    let mut paper = library.get_paper(paper_id).expect("读取论文");
    let now = "2026-09-11T00:00:00Z".to_string();
    paper.products.push(ProductDto {
        kind: "map".to_string(),
        part_id: String::new(),
        body: json!({
            "problem": {"text": "小样例问题", "refs": ["(p1)"]},
            "method": {"text": "样例方法", "refs": ["(p2)"]},
            "contributions": [{"text": "贡献一", "refs": ["(p2)"]}],
            "keyEvidence": [{"assetId": "fig_1", "note": "架构图", "refs": ["(p2)"]}],
            "glossary": [{"term": "样例", "defRef": "(sec_1:L1)"}],
            "structure": [{"secId": "sec_1_abstract"}, {"secId": "sec_2_introduction"}, {"secId": "sec_3_method"}],
        }),
        updated_at: now.clone(),
    });
    for (part_id, sec_id, type_) in [
        ("abstract", "sec_1_abstract", "abstract"),
        ("part-1", "sec_2_introduction", "introduction"),
        ("part-2", "sec_3_method", "method"),
    ] {
        paper.products.push(ProductDto {
            kind: "l2".to_string(),
            part_id: part_id.to_string(),
            body: json!({
                "secId": sec_id,
                "title": sec_id,
                "type": type_,
                "gist": format!("{sec_id} 主旨"),
                "points": [{"text": "要点", "refs": ["(p1)"]}],
                "keyAssets": [],
                "pages": {"start": 1, "end": 2},
            }),
            updated_at: now.clone(),
        });
    }
    library.put_paper(paper).expect("写入产物");
}

fn configure_model(registry: &Arc<TaskRegistry>, library: &Library, base_url: &str) {
    bridge::invoke(
        registry,
        library,
        "settings.putModel@1",
        &json!({ "settings": { "baseUrl": base_url, "apiKey": "sk-test", "model": "qwen-protocol" } }),
    )
    .expect("写入模型设置");
}

fn configure_concurrency(registry: &Arc<TaskRegistry>, library: &Library, concurrency: u64) {
    bridge::invoke(
        registry,
        library,
        "settings.putProtocol@1",
        &json!({ "settings": { "concurrency": concurrency } }),
    )
    .expect("写入并发设置");
}

fn prompt_text(request: &MockRequest) -> String {
    let body: Value = serde_json::from_slice(&request.body).unwrap_or(json!({}));
    match &body["messages"][0]["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn l2_sec_ids_in_prompt(prompt: &str) -> Vec<String> {
    prompt
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("## ")?;
            let id = rest.split_whitespace().next()?;
            id.starts_with("sec_").then(|| id.to_string())
        })
        .collect()
}

fn l2_json_for_sec(sec_id: &str) -> String {
    let (type_, gist, assets) = match sec_id {
        "sec_1_abstract" => ("abstract", "提出样例方法并验证有效", json!([])),
        "sec_2_introduction" => ("introduction", "背景与三点贡献", json!(["fig_1"])),
        "sec_3_method" => ("method", "两步样例方法", json!(["tbl_1"])),
        "sec_4_experiments" => ("experiments", "实验验证有效", json!([])),
        _ => ("part", "本节主旨", json!([])),
    };
    json!({
        "sections": [{
            "secId": sec_id,
            "type": type_,
            "gist": gist,
            "points": [{"text": "要点", "refs": ["(p1)"]}],
            "keyAssets": assets
        }]
    })
    .to_string()
}

fn map_or_l2_response(request: &MockRequest) -> MockResponse {
    let prompt = prompt_text(request);
    let ids = l2_sec_ids_in_prompt(&prompt);
    if let Some(sec_id) = ids.first() {
        return sse_text(&l2_json_for_sec(sec_id));
    }
    sse_text(&map_response())
}

/// SSE 响应：单个 content 载荷 + [DONE]。
fn sse_text(text: &str) -> MockResponse {
    MockResponse::sse(
        vec![
            json!({"choices": [{"delta": {"content": text}, "finish_reason": "stop"}]}).to_string(),
            "[DONE]".to_string(),
        ],
        Duration::from_millis(1),
    )
}

/// 调用①（单片）响应：三节薄摘要。
fn l2_response() -> String {
    json!({
        "sections": [
            {"secId": "sec_1_abstract", "type": "abstract", "gist": "提出样例方法并验证有效",
             "points": [{"text": "研究小样例问题", "refs": ["(p1)"]}], "keyAssets": []},
            {"secId": "sec_2_introduction", "type": "introduction", "gist": "背景与三点贡献",
             "points": [{"text": "问题长期存在", "refs": ["(p1)"]}], "keyAssets": ["fig_1"]},
            {"secId": "sec_3_method", "type": "method", "gist": "两步样例方法",
             "points": [{"text": "读取输入", "refs": ["(p2)"]}], "keyAssets": ["tbl_1"]}
        ]
    })
    .to_string()
}

fn map_response() -> String {
    json!({
        "problem": {"text": "小样例问题", "refs": ["(p1)"]},
        "method": {"text": "两步样例方法", "refs": ["(sec_3:L1-3)"]},
        "contributions": [{"text": "贡献一", "refs": ["(p2)"]}],
        "keyEvidence": [{"assetId": "fig_1", "note": "架构图", "refs": ["(p2)"]}],
        "glossary": [{"term": "样例", "defRef": "(sec_1:L1)"}],
        "structure": [
            {"secId": "sec_1_abstract", "title": "Abstract"},
            {"secId": "sec_2_introduction", "title": "Introduction"},
            {"secId": "sec_3_method", "title": "Method"}
        ]
    })
    .to_string()
}

const DIG_MARKDOWN: &str = "## 核心论点\n本节论点 (L1)。\n\n## 关键细节\n细节 (fig_1)。\n\n## 与全局的关系\n承接引言 (sec_2:L1)。\n\n## 边界与存疑\n无。\n";

const RETELL_MARKDOWN: &str = "## 问题\n小样例问题 (p1)。\n\n## 方法\n两步 (sec_3:L1)。\n\n## 证据\n表 1 (tbl_1)。\n\n## 边界\n未深挖节标注（未经深挖核验）。\n";

fn start_task(registry: &Arc<TaskRegistry>, kind: &str, input: Value) -> (String, Arc<Collector>) {
    let sink = Collector::new();
    let task_id = registry.start(kind, input, sink.clone()).expect("启动任务");
    (task_id, sink)
}

fn terminal(registry: &Arc<TaskRegistry>, task_id: &str) -> TaskStatus {
    wait_terminal(registry, task_id, TIMEOUT).expect("任务未在超时内到达终态")
}

fn events_named(sink: &Collector, name: &str) -> Vec<Value> {
    sink.events()
        .iter()
        .filter(|event| event.event == name)
        .filter_map(|event| event.detail.clone())
        .collect()
}

fn products_of(library: &Library, paper_id: &str, kind: &str) -> Vec<ProductDto> {
    library
        .get_paper(paper_id)
        .expect("读取论文")
        .products
        .into_iter()
        .filter(|product| product.kind == kind)
        .collect()
}

// ============================================================================
// paper.build-map@1
// ============================================================================

#[test]
fn build_map_runs_two_phases_and_persists_products() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|request, _hit| map_or_l2_response(request));
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, sink) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    let stages = events_named(&sink, "stage");
    let stage_names: Vec<&str> = stages.iter().filter_map(|d| d["stage"].as_str()).collect();
    assert_eq!(stage_names.first().copied(), Some("preflight"));
    assert_eq!(stage_names.last().copied(), Some("map-l1"));
    let l2_running: Vec<&Value> = stages
        .iter()
        .filter(|d| d["stage"] == json!("map-l2") && d["shardStatus"] == json!("running"))
        .collect();
    assert_eq!(l2_running.len(), 3, "三节各发一条 running 阶段事件");
    assert_eq!(l2_running[0]["shards"], json!(3));

    let maps = products_of(&library, &paper_id, "map");
    assert_eq!(maps.len(), 1);
    assert_eq!(maps[0].part_id, "");
    assert_eq!(maps[0].body["problem"]["text"], json!("小样例问题"));
    let l2s = products_of(&library, &paper_id, "l2");
    assert_eq!(l2s.len(), 3);
    let abstract_l2 = l2s.iter().find(|p| p.part_id == "abstract").expect("abstract l2");
    assert_eq!(abstract_l2.body["type"], json!("abstract"));
    let part1_l2 = l2s.iter().find(|p| p.part_id == "part-1").expect("part-1 l2");
    assert_eq!(part1_l2.body["title"], json!("Introduction"));
    assert_eq!(part1_l2.body["pages"], json!({"start": 1, "end": 2}));
    assert_eq!(part1_l2.body["points"][0]["refs"], json!(["(p1)"]));
    assert_eq!(part1_l2.body["keyAssets"], json!(["fig_1"]));
    let paper = library.get_paper(&paper_id).unwrap();
    assert!(paper.activity_days.iter().any(|day| day.kind == "analysis"), "建图完成计入打卡");

    let result = registry.get(&task_id).unwrap().result.expect("succeeded 应携带 result");
    assert_eq!(result["sections"], json!(3));
    assert_eq!(result["shards"], json!(3));
    let requests = mock.requests();
    assert_eq!(requests.len(), 4, "三节 L2 + 调用②");
    let mut l2_prompts = Vec::new();
    let mut l1_prompts = Vec::new();
    for request in &requests {
        let prompt = prompt_text(request);
        let ids = l2_sec_ids_in_prompt(&prompt);
        if ids.is_empty() {
            l1_prompts.push(prompt);
        } else {
            assert_eq!(ids.len(), 1, "每个 L2 请求只含一节: {ids:?}");
            l2_prompts.push(prompt);
        }
    }
    assert_eq!(l2_prompts.len(), 3);
    assert_eq!(l1_prompts.len(), 1);
    for request in &requests {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(json!({}));
        if !l2_sec_ids_in_prompt(&prompt_text(request)).is_empty() {
            assert_eq!(body["max_tokens"], json!(8192), "调用① max_tokens 下限 8192");
        }
    }
    assert!(l2_prompts.iter().any(|p| p.contains("Fixture 论文：小样例方法")));
    assert!(l2_prompts.iter().any(|p| p.contains("## sec_2_introduction Introduction (p1-2)")));
    assert!(l2_prompts.iter().any(|p| p.contains("本节类型关注点") || p.contains("章节关注点")));
    assert!(l1_prompts[0].contains("sec_3_method"), "调用②含全部 L2");
    assert!(l1_prompts[0].contains("fig_1"), "调用②含图表清单");
}

#[test]
fn build_map_shards_concurrently_with_bounded_inflight() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let in_flight = Arc::new(AtomicU64::new(0));
    let max_in_flight = Arc::new(AtomicU64::new(0));
    let mock = MockHttp::start({
        let in_flight = Arc::clone(&in_flight);
        let max_in_flight = Arc::clone(&max_in_flight);
        move |request, _hit| {
            let prompt = prompt_text(request);
            let ids = l2_sec_ids_in_prompt(&prompt);
            if ids.len() == 1 {
                let current = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                max_in_flight.fetch_max(current, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(80));
                in_flight.fetch_sub(1, Ordering::SeqCst);
                return sse_text(&l2_json_for_sec(&ids[0]));
            }
            sse_text(&map_response())
        }
    });
    let paper_id = seed_four_section_paper(&library);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));
    configure_concurrency(&registry, &library, 2);

    let (task_id, sink) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    let requests = mock.requests();
    let l2_requests: Vec<_> = requests
        .iter()
        .filter(|request| !l2_sec_ids_in_prompt(&prompt_text(request)).is_empty())
        .collect();
    assert_eq!(l2_requests.len(), 4, "总 L2 请求数 = 4");
    for request in &l2_requests {
        assert_eq!(l2_sec_ids_in_prompt(&prompt_text(request)).len(), 1, "每个请求体只含一节文本");
    }
    assert!(max_in_flight.load(Ordering::SeqCst) <= 2, "同时在飞 L2 请求数 ≤ 2，实际 {}", max_in_flight.load(Ordering::SeqCst));
    assert!(max_in_flight.load(Ordering::SeqCst) >= 2, "并发上限 2 时应真正并行");

    let l2s = products_of(&library, &paper_id, "l2");
    assert_eq!(l2s.len(), 4);
    let order: Vec<&str> = l2s.iter().map(|p| p.part_id.as_str()).collect();
    assert_eq!(order, vec!["abstract", "part-1", "part-2", "part-3"], "产物按节序");

    let progresses: Vec<u64> = sink
        .events()
        .iter()
        .filter_map(|event| event.progress.as_ref().map(|p| p.done))
        .collect();
    assert!(!progresses.is_empty());
    for window in progresses.windows(2) {
        assert!(window[1] >= window[0], "进度 done 应单调递增: {progresses:?}");
    }
    let last = sink.events().iter().rev().find_map(|event| event.progress.clone()).expect("应有进度");
    assert_eq!(last.done, last.total);
    assert_eq!(last.total, 5, "total = 4 节 + 调用②");
    let result = registry.get(&task_id).unwrap().result.unwrap();
    assert_eq!(result["shards"], json!(4));
}

#[test]
fn build_map_rejects_rerun_without_overwrite_confirmation() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|request, _hit| map_or_l2_response(request));
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));
    let (first, _) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &first), TaskStatus::Succeeded);

    // 重跑未确认 → already_exists 错误即指令（不再调用模型）。
    let (second, _) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &second), TaskStatus::Failed);
    let error = registry.get(&second).unwrap().error.unwrap();
    assert_eq!(error.code, "already_exists");
    assert!(!error.retryable);
    assert_eq!(mock.hits(), 4, "拒绝发生在调用模型之前");

    // 确认后覆盖重跑成功。
    let (third, _) = start_task(
        &registry,
        protocol::TASK_BUILD_MAP,
        json!({ "paperId": paper_id, "overwriteConfirmed": true }),
    );
    assert_eq!(terminal(&registry, &third), TaskStatus::Succeeded);
    assert_eq!(products_of(&library, &paper_id, "map").len(), 1, "重跑覆盖不留版本");
}

#[test]
fn build_map_preflight_missing_block_model_fails_with_instruction() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|_request, _hit| sse_text(&l2_response()));
    let paper_id = seed_paper(&library);
    configure_model(&registry, &library, &mock.url(""));

    // 缺块模型附件 → preflight_missing（#76：建图只等块模型）。
    let (task_id, _) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "preflight_missing");
    assert!(!error.retryable);
    assert!(error.message.contains("blockmodel.json"), "错误即指令: {}", error.message);
    assert!(error.message.contains("pdfparse.convert@1"), "错误即指令: {}", error.message);
    assert_eq!(mock.hits(), 0, "preflight 失败不调用模型");
}

#[test]
fn build_map_succeeds_with_only_block_model() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|request, _hit| map_or_l2_response(request));
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, sink) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "事件流: {:?}", sink.events());
    assert_eq!(products_of(&library, &paper_id, "map").len(), 1);
    assert_eq!(products_of(&library, &paper_id, "l2").len(), 3);
    assert_eq!(mock.hits(), 4);
}

#[test]
fn build_map_hard_top_rejects_oversized_prompt() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let _guard = EnvGuard("PAPER30MIN_PROTOCOL_HARD_TOP");
    std::env::set_var("PAPER30MIN_PROTOCOL_HARD_TOP", "10");
    let mock = MockHttp::start(|_request, _hit| sse_text(&l2_response()));
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, _) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "protocol_shard_failed");
    assert!(!error.retryable, "硬顶拒绝不截断也不可自动重试");
    let failed = error.details.expect("失败节清单")["failedSections"].as_array().cloned().unwrap();
    assert!(!failed.is_empty());
    assert!(failed.iter().all(|item| item["code"] == json!("input_too_large")));
    assert_eq!(mock.hits(), 0, "硬顶检查发生在调用模型之前");
}

// ============================================================================
// paper.deep-dive@1
// ============================================================================

#[test]
fn deep_dive_preflight_missing_visual_assets_fails_with_instruction() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|_request, _hit| sse_text(DIG_MARKDOWN));
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_built_products(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    // 仅块模型在位、无页图/裁切图 → 深挖 preflight_missing，details 列出缺失件。
    let (task_id, _) = start_task(
        &registry,
        protocol::TASK_DEEP_DIVE,
        json!({ "paperId": paper_id, "partIds": ["part-1"] }),
    );
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "preflight_missing");
    assert!(!error.retryable);
    assert!(
        error.message.contains("页图 / 裁切图尚未预渲染完成"),
        "错误即指令: {}",
        error.message
    );
    let missing = error.details.expect("缺失清单")["missing"].as_array().unwrap().clone();
    assert!(missing.contains(&json!("pageimg-0001")), "缺失清单含页图: {missing:?}");
    assert!(missing.contains(&json!("crop-fig_1")), "缺失清单含裁切图: {missing:?}");
    assert_eq!(mock.hits(), 0, "preflight 失败不调用模型");
}

#[test]
fn deep_dive_tool_loop_completes_and_persists() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|_request, hit| match hit {
        1 => sse_text("先读方法节。\n```tool\n{\"name\": \"read_section\", \"args\": {\"sec_id\": \"sec_3_method\", \"offset\": 1, \"limit\": 10}}\n```"),
        2 => sse_text("再看图。\n```tool\n{\"name\": \"get_figure\", \"args\": {\"fig_id\": \"fig_1\"}}\n```"),
        _ => sse_text(DIG_MARKDOWN),
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    seed_built_products(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, sink) = start_task(
        &registry,
        protocol::TASK_DEEP_DIVE,
        json!({ "paperId": paper_id, "partIds": ["part-1"] }),
    );
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    // 工具轨迹：两步，均 ok，含结果摘要。
    let tools = events_named(&sink, "tool");
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["step"], json!(1));
    assert_eq!(tools[0]["name"], json!("read_section"));
    assert_eq!(tools[0]["args"]["sec_id"], json!("sec_3_method"));
    assert_eq!(tools[0]["ok"], json!(true));
    assert_eq!(tools[0]["result"]["blocks"], json!(3));
    assert_eq!(tools[0]["result"]["total"], json!(3));
    assert_eq!(tools[1]["name"], json!("get_figure"));
    assert_eq!(tools[1]["result"]["cropAssetId"], json!("crop-fig_1"));

    // 逐节子进度阶段事件。
    let stages = events_named(&sink, "stage");
    assert_eq!(stages.len(), 1);
    assert_eq!(stages[0]["partId"], json!("part-1"));
    assert_eq!(stages[0]["secId"], json!("sec_2_introduction"));
    assert_eq!(stages[0]["index"], json!(1));
    assert_eq!(stages[0]["total"], json!(1));

    // 深挖产物落库（Markdown 字符串）+ analysis 打卡；产物保留出处指针（EXTRACTED 纪律）。
    let digs = products_of(&library, &paper_id, "dig");
    assert_eq!(digs.len(), 1);
    assert_eq!(digs[0].part_id, "part-1");
    let body = digs[0].body.as_str().expect("dig 为 Markdown 字符串");
    assert!(body.contains("## 核心论点") && body.contains("## 边界与存疑"));
    for pointer in ["(L1)", "(fig_1)", "(sec_2:L1)"] {
        assert!(body.contains(pointer), "产物应保留出处指针 {pointer}: {body}");
    }
    let paper = library.get_paper(&paper_id).unwrap();
    assert!(paper.activity_days.iter().any(|day| day.kind == "analysis"));

    // 请求链：3 轮；第 2 轮携带 read_section 观察；第 3 轮携带 get_figure 观察与裁切图。
    let requests = mock.requests();
    assert_eq!(requests.len(), 3);
    let body0: Value = serde_json::from_slice(&requests[0].body).unwrap();
    let first_content = body0["messages"][0]["content"].as_array().expect("深挖首条消息为多模态分段");
    assert_eq!(first_content[0]["type"], json!("text"));
    let prompt = first_content[0]["text"].as_str().unwrap();
    assert!(prompt.contains("L1 (p1)：研究背景"), "当前节原文全送且块号以 L 标注: {prompt}");
    assert!(prompt.contains("小节类型关注点") || prompt.contains("本节类型关注点"), "深挖叠加本节类型关注点");
    let images = first_content.iter().filter(|part| part["type"] == "image_url").count();
    assert_eq!(images, 3, "当前节页图 ±1 页（p1-2 → p1..p3）随消息附图");

    let body1: Value = serde_json::from_slice(&requests[1].body).unwrap();
    let roles: Vec<&str> = body1["messages"].as_array().unwrap().iter().filter_map(|m| m["role"].as_str()).collect();
    assert_eq!(roles, vec!["user", "assistant", "user"], "工具循环消息交替");
    let observation = body1["messages"][2]["content"].as_str().unwrap();
    assert!(observation.contains("\"tool\":\"read_section\""), "观察为工具结果 JSON: {observation}");
    assert!(observation.contains("\"total\":3"), "观察含块窗口: {observation}");

    let body2: Value = serde_json::from_slice(&requests[2].body).unwrap();
    let last = body2["messages"].as_array().unwrap().last().unwrap().clone();
    let parts = last["content"].as_array().unwrap();
    assert!(parts[0]["text"].as_str().unwrap().contains("crop-fig_1"), "get_figure 观察含裁切图指针");
    assert!(parts.iter().any(|part| part["type"] == "image_url"), "get_figure 观察随附裁切图");

    // 深挖中间轮不产生对外 chunk（决策 4）。
    assert!(sink.events().iter().all(|event| event.event != "chunk"), "深挖无对外 chunk");

    // 快照 details 日志：阶段、正文开始与工具轨迹随快照可回看——JS 订阅建立前发出的
    // 事件不经通道重放，任务中心以快照日志为完整源（#72 走查实测订阅窗口丢事件后的补齐）。
    // 每轮正文开始发 content（清思考态），协议轮仍不对外发 chunk。
    let snapshot = registry.get(&task_id).expect("任务快照");
    let details = snapshot.details.expect("快照携带 details 日志");
    let events: Vec<&str> = details.iter().filter_map(|d| d["event"].as_str()).collect();
    assert_eq!(
        events,
        vec!["stage", "content", "round", "tool", "content", "round", "tool", "content", "round"]
    );
    assert_eq!(details[0]["detail"]["stage"], json!("deep-dive"));
    assert_eq!(details[6]["detail"]["name"], json!("get_figure"));
}

#[test]
fn deep_dive_step_limit_fails_and_keeps_trajectory() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    // 模型永远要求继续搜索 → 步数上限收尾。
    let mock = MockHttp::start(|_request, _hit| {
        sse_text("继续搜。\n```tool\n{\"name\": \"search_paper\", \"args\": {\"pattern\": \"样例\"}}\n```")
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    seed_built_products(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, sink) = start_task(
        &registry,
        protocol::TASK_DEEP_DIVE,
        json!({ "paperId": paper_id, "partIds": ["part-1"] }),
    );
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "step_limit_exceeded");
    assert!(error.retryable, "超限保留可手动重试");
    let tools = events_named(&sink, "tool");
    assert_eq!(tools.len(), protocol::MAX_TOOL_STEPS as usize, "工具轨迹记录到上限为止");
    assert!(products_of(&library, &paper_id, "dig").is_empty(), "未完成的节不落产物");
}

#[test]
fn deep_dive_parse_failure_recovers_once_then_fails_after_two() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    // 第一次非法（坏 JSON），第二次恢复 → 成功。
    let mock = MockHttp::start(|_request, hit| {
        if hit == 1 {
            sse_text("```tool\n{不是 json}\n```")
        } else {
            sse_text(DIG_MARKDOWN)
        }
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    seed_built_products(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));
    let (task_id, _sink) = start_task(
        &registry,
        protocol::TASK_DEEP_DIVE,
        json!({ "paperId": paper_id, "partIds": ["part-1"] }),
    );
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    assert_eq!(mock.hits(), 2);
    // 错误观察喂回模型自我纠正。
    let request2: Value = serde_json::from_slice(&mock.requests()[1].body).unwrap();
    let observation = request2["messages"][2]["content"].as_str().unwrap();
    assert!(observation.contains("parse_failed"), "解析失败观察: {observation}");
    assert_eq!(products_of(&library, &paper_id, "dig").len(), 1);

    // 连续两次非法 → protocol_parse_failed。
    let mock = MockHttp::start(|_request, _hit| sse_text("```tool\n{还是不行}\n```"));
    bridge::invoke(
        &registry,
        &library,
        "settings.putModel@1",
        &json!({ "settings": { "baseUrl": mock.url(""), "apiKey": "sk-test", "model": "qwen-protocol" } }),
    )
    .unwrap();
    let (task_id, _) = start_task(
        &registry,
        protocol::TASK_DEEP_DIVE,
        json!({ "paperId": paper_id, "partIds": ["part-2"] }),
    );
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "protocol_parse_failed");
    assert_eq!(mock.hits(), 2, "连续 2 次解析失败即收尾");
}

#[test]
fn deep_dive_invalid_address_is_error_observation_not_parse_failure() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|_request, hit| {
        if hit == 1 {
            sse_text("```tool\n{\"name\": \"read_section\", \"args\": {\"sec_id\": \"sec_9_nope\"}}\n```")
        } else {
            sse_text(DIG_MARKDOWN)
        }
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    seed_built_products(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));
    let (task_id, sink) = start_task(
        &registry,
        protocol::TASK_DEEP_DIVE,
        json!({ "paperId": paper_id, "partIds": ["part-1"] }),
    );
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "无效地址是结构化错误观察，不计入解析失败");
    let tools = events_named(&sink, "tool");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["ok"], json!(false));
    assert_eq!(tools[0]["error"]["code"], json!("unknown_section"));
    let request2: Value = serde_json::from_slice(&mock.requests()[1].body).unwrap();
    let observation = request2["messages"][2]["content"].as_str().unwrap();
    assert!(observation.contains("unknown_section"), "错误观察含结构化错误码: {observation}");
}

#[test]
fn deep_dive_cancel_stops_batch_and_preserves_completed() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    // 第二节第一轮挂起，直到测试置位放行门闩（取消请求已发出）。
    let gate = Arc::new(AtomicBool::new(false));
    let gate_in_mock = Arc::clone(&gate);
    let mock = MockHttp::start(move |_request, hit| {
        if hit == 1 {
            return sse_text(DIG_MARKDOWN);
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !gate_in_mock.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(5));
            assert!(std::time::Instant::now() < deadline, "放行门闩超时");
        }
        sse_text("```tool\n{\"name\": \"search_paper\", \"args\": {\"pattern\": \"方法\"}}\n```")
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    seed_built_products(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, sink) = start_task(
        &registry,
        protocol::TASK_DEEP_DIVE,
        json!({ "paperId": paper_id, "partIds": ["part-1", "part-2"] }),
    );
    // 等第二节的第一轮请求确实在途（命中数到 2）再取消：请求卡在 mock 侧门闩上，
    // 取消 → 门闩放行 → 在途轮完成 → 轮后检查点收敛为 Cancelled（确定性，无竞态）。
    let deadline = std::time::Instant::now() + TIMEOUT;
    while mock.hits() < 2 {
        assert!(std::time::Instant::now() < deadline, "应先推进到第二节的第一轮");
        std::thread::sleep(Duration::from_millis(5));
    }
    registry.request_cancel(&task_id).expect("请求取消");
    gate.store(true, Ordering::SeqCst);

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Cancelled);
    // 取消 = 当前步完成后停止：第二节的在途轮完成后即停（不执行其工具调用、不消费输出），不再推进。
    let tools = events_named(&sink, "tool");
    assert_eq!(tools.len(), 0, "取消后不再执行在途轮请求的工具");
    let digs = products_of(&library, &paper_id, "dig");
    assert_eq!(digs.len(), 1, "已完成的节保留（不白跑）");
    assert_eq!(digs[0].part_id, "part-1");
    assert_eq!(mock.hits(), 2, "取消后不再推进下一节");
}

#[test]
fn deep_dive_requires_map_and_known_parts() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|_request, _hit| sse_text(DIG_MARKDOWN));
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    // 未建图 → map_required（错误即指令）。
    let (task_id, _) = start_task(&registry, protocol::TASK_DEEP_DIVE, json!({ "paperId": paper_id, "partIds": ["part-1"] }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    assert_eq!(registry.get(&task_id).unwrap().error.unwrap().code, "map_required");

    // 已建图但目标部分未知 → invalid_input。
    seed_built_products(&library, &paper_id);
    let (task_id, _) = start_task(&registry, protocol::TASK_DEEP_DIVE, json!({ "paperId": paper_id, "partIds": ["part-9"] }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    assert_eq!(registry.get(&task_id).unwrap().error.unwrap().code, "invalid_input");
    assert_eq!(mock.hits(), 0, "门禁失败不调用模型");

    // 计划阶段拒绝非法 partIds。
    let error = registry
        .start(protocol::TASK_DEEP_DIVE, json!({ "paperId": paper_id, "partIds": [] }), Collector::new())
        .expect_err("空 partIds 应在计划阶段拒绝");
    assert_eq!(error.code, "invalid_input");
}

// ============================================================================
// paper.synthesize@1
// ============================================================================

#[test]
fn synthesize_writes_retell_and_respects_gates() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|_request, _hit| sse_text(RETELL_MARKDOWN));
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    // 未建图 → map_required。
    let (task_id, _) = start_task(&registry, protocol::TASK_SYNTHESIZE, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    assert_eq!(registry.get(&task_id).unwrap().error.unwrap().code, "map_required");

    // 已建图 + 一节深挖 → 复述稿落库。
    seed_built_products(&library, &paper_id);
    let mut paper = library.get_paper(&paper_id).unwrap();
    paper.products.push(ProductDto {
        kind: "dig".to_string(),
        part_id: "part-1".to_string(),
        body: json!(DIG_MARKDOWN),
        updated_at: "2026-09-11T00:00:00Z".to_string(),
    });
    library.put_paper(paper).unwrap();

    let (task_id, sink) = start_task(&registry, protocol::TASK_SYNTHESIZE, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "事件流: {:?}", sink.events());
    let synth_rounds = events_named(&sink, "round");
    assert_eq!(synth_rounds.len(), 1, "复述稿每轮一条 round");
    assert_eq!(synth_rounds[0]["stage"], json!("synthesize"));
    let retells = products_of(&library, &paper_id, "retell");
    assert_eq!(retells.len(), 1);
    assert_eq!(retells[0].part_id, "");
    assert!(retells[0].body.as_str().unwrap().contains("## 边界"));
    let request: Value = serde_json::from_slice(&mock.requests()[0].body).unwrap();
    let prompt = request["messages"][0]["content"].as_str().unwrap();
    assert!(prompt.contains("小样例问题"), "复述稿输入含 L1");
    assert!(prompt.contains("sec_3_method"), "复述稿输入含全部 L2");
    assert!(prompt.contains("核心论点"), "复述稿输入含已有深挖结果");

    // 重跑未确认 → already_exists；确认后覆盖。
    let (task_id, _) = start_task(&registry, protocol::TASK_SYNTHESIZE, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    assert_eq!(registry.get(&task_id).unwrap().error.unwrap().code, "already_exists");
    let (task_id, _) = start_task(
        &registry,
        protocol::TASK_SYNTHESIZE,
        json!({ "paperId": paper_id, "overwriteConfirmed": true }),
    );
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    assert_eq!(products_of(&library, &paper_id, "retell").len(), 1);
}

#[test]
fn build_map_cancel_after_first_call_persists_partial_l2() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    // 调用②挂起，直到取消后放行：验证「当前步完成后停止」+ 已产出 L2 中断落库。
    let gate = Arc::new(AtomicBool::new(false));
    let gate_in_mock = Arc::clone(&gate);
    let mock = MockHttp::start(move |request, _hit| {
        let prompt = prompt_text(request);
        if !l2_sec_ids_in_prompt(&prompt).is_empty() {
            return map_or_l2_response(request);
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !gate_in_mock.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(5));
            assert!(std::time::Instant::now() < deadline, "放行门闩超时");
        }
        sse_text(&map_response())
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, _sink) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    let deadline = std::time::Instant::now() + TIMEOUT;
    loop {
        let has_l1 = mock
            .requests()
            .iter()
            .any(|request| l2_sec_ids_in_prompt(&prompt_text(request)).is_empty());
        if has_l1 {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "应先进入调用②的在途轮");
        std::thread::sleep(Duration::from_millis(5));
    }
    registry.request_cancel(&task_id).expect("请求取消");
    gate.store(true, Ordering::SeqCst);

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Cancelled);
    assert!(products_of(&library, &paper_id, "map").is_empty(), "取消不建地图");
    let l2s = products_of(&library, &paper_id, "l2");
    assert_eq!(l2s.len(), 3, "已产出 L2 按中断部分结果落库");
    assert!(l2s.iter().all(|p| p.body["partial"] == json!(true)), "中断部分结果带警示标记");
    let paper = library.get_paper(&paper_id).unwrap();
    assert!(paper.activity_days.iter().any(|day| day.kind == "partial"), "中断保留计 partial 打卡");
}

#[test]
fn build_map_shard_parse_failure_stops_and_persists_completed_partial() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|request, _hit| {
        let prompt = prompt_text(request);
        let ids = l2_sec_ids_in_prompt(&prompt);
        if ids.first().map(String::as_str) == Some("sec_2_introduction") {
            return sse_text("这不是 json");
        }
        if ids.len() == 1 {
            std::thread::sleep(Duration::from_millis(150));
            return sse_text(&l2_json_for_sec(&ids[0]));
        }
        sse_text(&map_response())
    });
    let paper_id = seed_four_section_paper(&library);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));
    configure_concurrency(&registry, &library, 2);

    let (task_id, _sink) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Failed);
    let error = registry.get(&task_id).unwrap().error.unwrap();
    assert_eq!(error.code, "protocol_shard_failed");
    let failed_sections = error.details.expect("失败节")["failedSections"].as_array().cloned().unwrap();
    assert!(
        failed_sections.iter().any(|item| item["secId"] == json!("sec_2_introduction")),
        "details 应列出失败节: {failed_sections:?}"
    );

    assert!(products_of(&library, &paper_id, "map").is_empty(), "失败不建地图");
    let l2s = products_of(&library, &paper_id, "l2");
    assert!(!l2s.is_empty(), "已完成节应 partial 落库");
    assert!(l2s.iter().all(|p| p.body["partial"] == json!(true)));
    assert!(l2s.iter().all(|p| p.body["secId"] != json!("sec_2_introduction")));
    let paper = library.get_paper(&paper_id).unwrap();
    assert!(paper.activity_days.iter().any(|day| day.kind == "partial"));

    let l2_ids: Vec<String> = mock
        .requests()
        .iter()
        .flat_map(|request| l2_sec_ids_in_prompt(&prompt_text(request)))
        .collect();
    let intro_hits = l2_ids.iter().filter(|id| *id == "sec_2_introduction").count();
    assert_eq!(intro_hits, 2, "失败节连续两次非法 JSON 后停: {l2_ids:?}");
    assert!(
        !l2_ids.contains(&"sec_4_experiments".to_string()),
        "协作停止后不应再取队列末节: {l2_ids:?}"
    );
}

#[test]
fn build_map_cancel_after_partial_shards_persists_completed() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let gate = Arc::new(AtomicBool::new(false));
    let started_second = Arc::new(AtomicBool::new(false));
    let mock = MockHttp::start({
        let gate = Arc::clone(&gate);
        let started_second = Arc::clone(&started_second);
        move |request, _hit| {
            let ids = l2_sec_ids_in_prompt(&prompt_text(request));
            if ids.first().map(String::as_str) == Some("sec_1_abstract") {
                return sse_text(&l2_json_for_sec("sec_1_abstract"));
            }
            if !ids.is_empty() {
                started_second.store(true, Ordering::SeqCst);
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                while !gate.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(5));
                    assert!(std::time::Instant::now() < deadline, "放行门闩超时");
                }
                return sse_text(&l2_json_for_sec(&ids[0]));
            }
            sse_text(&map_response())
        }
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));
    configure_concurrency(&registry, &library, 1);

    let (task_id, _sink) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    let deadline = std::time::Instant::now() + TIMEOUT;
    while !started_second.load(Ordering::SeqCst) {
        assert!(std::time::Instant::now() < deadline, "应进入第二片在途轮");
        std::thread::sleep(Duration::from_millis(5));
    }
    registry.request_cancel(&task_id).expect("请求取消");
    gate.store(true, Ordering::SeqCst);

    assert_eq!(terminal(&registry, &task_id), TaskStatus::Cancelled);
    assert!(products_of(&library, &paper_id, "map").is_empty());
    let l2s = products_of(&library, &paper_id, "l2");
    assert_eq!(l2s.len(), 1, "仅已完成片落库");
    assert_eq!(l2s[0].body["secId"], json!("sec_1_abstract"));
    assert_eq!(l2s[0].body["partial"], json!(true));
}

#[test]
fn protocol_task_kinds_registered_in_app_info() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let info = bridge::invoke(&registry, &library, "app.info@1", &json!({})).unwrap();
    let kinds = info["taskKinds"].as_array().unwrap();
    for kind in [protocol::TASK_BUILD_MAP, protocol::TASK_DEEP_DIVE, protocol::TASK_SYNTHESIZE] {
        assert!(kinds.iter().any(|item| item == kind), "app.info 未列出 {kind}");
    }
}

fn sse_text_usage(text: &str, usage: Value) -> MockResponse {
    MockResponse::sse(
        vec![
            json!({"choices": [{"delta": {"content": text}, "finish_reason": "stop"}]}).to_string(),
            json!({"choices": [], "usage": usage}).to_string(),
            "[DONE]".to_string(),
        ],
        Duration::from_millis(1),
    )
}

#[test]
fn build_map_emits_round_telemetry_and_omits_missing_usage() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|request, _hit| {
        let prompt = prompt_text(request);
        let ids = l2_sec_ids_in_prompt(&prompt);
        if ids.len() == 1 {
            sse_text_usage(
                &l2_json_for_sec(&ids[0]),
                json!({
                    "prompt_tokens": 100,
                    "completion_tokens": 40,
                    "prompt_tokens_details": { "cached_tokens": 20 }
                }),
            )
        } else {
            sse_text(&map_response())
        }
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, sink) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    let rounds = events_named(&sink, "round");
    assert_eq!(rounds.len(), 4, "三节 L2 + 调用② 各一条 round");
    let l2_rounds: Vec<&Value> = rounds.iter().filter(|d| d["stage"] == json!("map-l2")).collect();
    assert_eq!(l2_rounds.len(), 3);
    assert!(l2_rounds.iter().all(|round| round["round"] == json!(1)));
    assert!(l2_rounds.iter().all(|round| round["promptTokens"] == json!(100)));
    assert!(l2_rounds.iter().all(|round| round["completionTokens"] == json!(40)));
    assert!(l2_rounds.iter().all(|round| round["cachedTokens"] == json!(20)));
    assert!(l2_rounds.iter().all(|round| round.get("secId").and_then(Value::as_str).is_some()));
    let l1 = rounds.iter().find(|d| d["stage"] == json!("map-l1")).expect("调用② round");
    assert!(l1.get("promptTokens").is_none(), "无 usage 时 token 字段缺省");
    assert!(l1.get("cachedTokens").is_none());

    let snapshot = registry.get(&task_id).unwrap();
    let details = snapshot.details.expect("快照应带 details");
    let round_in_log = details.iter().filter(|entry| entry["event"] == json!("round")).count();
    assert_eq!(round_in_log, 4);

    let body: Value = serde_json::from_slice(&mock.requests()[0].body).unwrap();
    assert_eq!(body["stream_options"], json!({ "include_usage": true }));
}

#[test]
fn deep_dive_round_events_carry_part_id() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|_request, _hit| sse_text(DIG_MARKDOWN));
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    seed_built_products(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, sink) = start_task(
        &registry,
        protocol::TASK_DEEP_DIVE,
        json!({ "paperId": paper_id, "partIds": ["part-1"] }),
    );
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "事件流: {:?}", sink.events());
    let rounds = events_named(&sink, "round");
    assert!(!rounds.is_empty());
    assert_eq!(rounds[0]["stage"], json!("deep-dive"));
    assert_eq!(rounds[0]["partId"], json!("part-1"));
    assert_eq!(rounds[0]["round"], json!(1));
}

#[test]
fn protocol_stages_default_to_enable_thinking_false() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|request, _hit| {
        let prompt = prompt_text(request);
        if !l2_sec_ids_in_prompt(&prompt).is_empty() || prompt.contains("建图第①步") {
            map_or_l2_response(request)
        } else if prompt.contains("建图第②步") {
            sse_text(&map_response())
        } else if prompt.contains("正在深挖论文") {
            sse_text(DIG_MARKDOWN)
        } else {
            sse_text(RETELL_MARKDOWN)
        }
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, _) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let (task_id, _) = start_task(
        &registry,
        protocol::TASK_DEEP_DIVE,
        json!({ "paperId": paper_id, "partIds": ["part-1"] }),
    );
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);
    let (task_id, _) = start_task(&registry, protocol::TASK_SYNTHESIZE, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded);

    let bodies: Vec<Value> = mock
        .requests()
        .iter()
        .map(|request| serde_json::from_slice(&request.body).unwrap())
        .collect();
    assert!(bodies.len() >= 4, "建图两轮 + 深挖 + 复述稿");
    for (index, body) in bodies.iter().enumerate() {
        assert_eq!(
            body["enable_thinking"],
            json!(false),
            "协议阶段请求 {index} 应关闭思考"
        );
    }
}

#[test]
fn build_map_stage_model_applies_only_to_first_call_and_round_model_matches() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|request, _hit| map_or_l2_response(request));
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    configure_model(&registry, &library, &mock.url(""));
    bridge::invoke(
        &registry,
        &library,
        "settings.putModel@1",
        &json!({ "settings": { "stageModels": { "map-l2": "fast-x" } } }),
    )
    .expect("写入阶段模型");

    let (task_id, sink) = start_task(&registry, protocol::TASK_BUILD_MAP, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    let requests = mock.requests();
    assert_eq!(requests.len(), 4);
    let mut l2_models = Vec::new();
    let mut l1_models = Vec::new();
    for request in &requests {
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        if l2_sec_ids_in_prompt(&prompt_text(request)).is_empty() {
            l1_models.push(body["model"].clone());
        } else {
            l2_models.push(body["model"].clone());
        }
    }
    assert_eq!(l2_models.len(), 3);
    assert!(l2_models.iter().all(|model| model == &json!("fast-x")));
    assert_eq!(l1_models, vec![json!("qwen-protocol")]);

    let rounds = events_named(&sink, "round");
    assert_eq!(rounds.len(), 4);
    for round in rounds.iter().filter(|d| d["stage"] == json!("map-l2")) {
        assert_eq!(round["model"], json!("fast-x"));
    }
    let l1 = rounds.iter().find(|d| d["stage"] == json!("map-l1")).unwrap();
    assert_eq!(l1["model"], json!("qwen-protocol"));
}

#[test]
fn synthesize_emits_thinking_then_content_and_round_reasoning_ms() {
    let (registry, library, _dir) = common::env();
    let _lock = env_lock!();
    let mock = MockHttp::start(|_request, _hit| {
        MockResponse::sse(
            vec![
                json!({"choices": [{"delta": {"reasoning_content": "想"}}]}).to_string(),
                json!({"choices": [{"delta": {"reasoning_content": "一"}}]}).to_string(),
                json!({"choices": [{"delta": {"reasoning_content": "想"}}]}).to_string(),
                json!({"choices": [{"delta": {"content": RETELL_MARKDOWN}, "finish_reason": "stop"}]}).to_string(),
                "[DONE]".to_string(),
            ],
            Duration::from_millis(40),
        )
    });
    let paper_id = seed_paper(&library);
    seed_block_model(&library, &paper_id);
    seed_assets(&library, &paper_id);
    seed_built_products(&library, &paper_id);
    let mut paper = library.get_paper(&paper_id).unwrap();
    paper.products.push(ProductDto {
        kind: "dig".to_string(),
        part_id: "part-1".to_string(),
        body: json!(DIG_MARKDOWN),
        updated_at: "2026-09-11T00:00:00Z".to_string(),
    });
    library.put_paper(paper).unwrap();
    configure_model(&registry, &library, &mock.url(""));

    let (task_id, sink) = start_task(&registry, protocol::TASK_SYNTHESIZE, json!({ "paperId": paper_id }));
    assert_eq!(terminal(&registry, &task_id), TaskStatus::Succeeded, "事件流: {:?}", sink.events());

    let events = sink.events();
    let thinking_at = events.iter().position(|event| event.event == "thinking");
    let content_at = events.iter().position(|event| event.event == "content");
    assert!(thinking_at.is_some(), "应发出 thinking");
    assert!(content_at.is_some(), "正文开始应发出 content");
    assert!(thinking_at.unwrap() < content_at.unwrap(), "thinking 应早于 content");
    assert!(
        events.iter().skip(content_at.unwrap()).all(|event| event.event != "thinking"),
        "正文到达后不应再有 thinking"
    );

    let contents = events_named(&sink, "content");
    assert_eq!(contents[0]["stage"], json!("synthesize"));

    let rounds = events_named(&sink, "round");
    assert_eq!(rounds.len(), 1);
    assert_eq!(rounds[0]["stage"], json!("synthesize"));
    let ttft = rounds[0]["ttftMs"].as_u64().unwrap();
    let reasoning = rounds[0]["reasoningMs"].as_u64().unwrap();
    let elapsed = rounds[0]["elapsedMs"].as_u64().unwrap();
    assert!(reasoning > 0);
    assert!(ttft.saturating_add(reasoning) <= elapsed);
}
