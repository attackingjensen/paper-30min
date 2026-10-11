mod common;
use base64::{engine::general_purpose::STANDARD, Engine};
use paper30min_lib::{bridge, tasks::TaskStatus, testkit};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, time::Duration};
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn offline_conversion_stays_candidate_and_native_bridge_recovers_bound_sources() {
    let (registry, library, dir) = common::env();
    bridge::invoke(
        &registry,
        &library,
        "library.putPaper@1",
        &json!({"paper":{"id":"p","title":"Adam"}}),
    )
    .unwrap();
    let pdf = include_bytes!("fixtures/regression/corpus/1412.6980.pdf");
    let raw = include_bytes!("fixtures/aistudio/1412.6980.jsonl");
    bridge::invoke(&registry, &library,"files.putAttachment@1",&json!({"paperId":"p","attachment":{"id":"pdf","name":"adam.pdf","contentType":"application/pdf","contentBase64":STANDARD.encode(pdf)}})).unwrap();
    let job = dir.path().join("operations/cloudparse/p/batch");
    fs::create_dir_all(&job).unwrap();
    fs::write(job.join("result.jsonl"), raw).unwrap();
    fs::write(job.join("run.json"), json!({"schemaVersion":1,"paperId":"p","batchId":"batch","provider":"baidu","model":"PaddleOCR-VL-1.6","options":{"useDocOrientationClassify":false,"useDocUnwarping":false,"useChartRecognition":false},"pdfSha256":digest(pdf),"state":"downloaded","jobId":"fixture","rawSha256":digest(raw),"failureCode":null,"updatedAt":"2026-10-06T00:00:00Z"}).to_string()).unwrap();
    let sink = testkit::Collector::new();
    let task = registry
        .start(
            "cloudparse.map@1",
            json!({"paperId":"p","batchId":"batch"}),
            sink,
        )
        .unwrap();
    assert_eq!(
        testkit::wait_terminal(&registry, &task, Duration::from_secs(30)).unwrap(),
        TaskStatus::Succeeded,
        "{:?}",
        registry.get(&task)
    );
    assert!(library.get_attachment("p", "blockmodel.json").is_err());
    let pinned = bridge::invoke(
        &registry,
        &library,
        "parsebatch.pin@1",
        &json!({"paperId":"p","batchId":"batch"}),
    )
    .unwrap();
    let read = bridge::invoke(
        &registry,
        &library,
        "parsebatch.read@1",
        &json!({"snapshot":pinned["snapshot"],"attachmentId":"blockmodel.json"}),
    )
    .unwrap();
    let source_read = bridge::invoke(
        &registry,
        &library,
        "parsebatch.read@1",
        &json!({"snapshot":pinned["snapshot"],"attachmentId":"cloud-source.json"}),
    )
    .unwrap();
    let source: serde_json::Value = serde_json::from_slice(
        &STANDARD
            .decode(source_read["contentBase64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let mapped: paper30min_lib::pdfmap::MappedPaper = serde_json::from_slice(
        &STANDARD
            .decode(read["contentBase64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(source["blockModelSha256"], read["attachment"]["sha256"]);
    assert_eq!(
        source["projectionSha256"],
        paper30min_lib::cloudparse_map::projection_sha256(&mapped).unwrap()
    );
    let sources = bridge::invoke(
        &registry,
        &library,
        "pdfmap.getSourceRegions@1",
        &json!({"paperId":"p","batchId":"batch","blockModelSha256":read["attachment"]["sha256"]}),
    )
    .unwrap();
    assert_eq!(sources["pdfSha256"], digest(pdf));
    assert!(!sources["blocks"].as_array().unwrap().is_empty());
    let repeat = registry
        .start(
            "cloudparse.map@1",
            json!({"paperId":"p","batchId":"batch"}),
            testkit::Collector::new(),
        )
        .unwrap();
    assert_eq!(
        testkit::wait_terminal(&registry, &repeat, Duration::from_secs(30)).unwrap(),
        TaskStatus::Succeeded
    );
    assert!(bridge::invoke(
        &registry,
        &library,
        "pdfmap.getSourceRegions@1",
        &json!({"paperId":"p","batchId":"batch","blockModelSha256":"0".repeat(64)})
    )
    .is_err());

    let status = bridge::invoke(
        &registry,
        &library,
        "cloudparse.status@1",
        &json!({"paperId":"p"}),
    )
    .unwrap();
    assert_eq!(status["jobs"][0]["candidateStored"], true);
    assert!(status["jobs"][0].get("candidateReady").is_none());
    let resource_id = pinned["snapshot"]["manifest"]["attachments"]["blockmodel.json"]
        ["attachmentId"]
        .as_str()
        .unwrap();
    let resource_path = dir.path().join("attachments/p").join(resource_id);
    let original = fs::read(&resource_path).unwrap();
    fs::write(&resource_path, b"corrupted").unwrap();
    let repeat = registry
        .start(
            "cloudparse.map@1",
            json!({"paperId":"p","batchId":"batch"}),
            testkit::Collector::new(),
        )
        .unwrap();
    assert_eq!(
        testkit::wait_terminal(&registry, &repeat, Duration::from_secs(30)).unwrap(),
        TaskStatus::Failed
    );
    let failed = serde_json::to_value(registry.get(&repeat).unwrap()).unwrap();
    assert_eq!(failed["error"]["code"], "parse_batch_stale", "{failed}");
    fs::write(&resource_path, original).unwrap();
    let manifest_path = dir
        .path()
        .join("attachments/p")
        .join(format!("parsebatch-{}", digest(b"batch")));
    fs::remove_file(manifest_path).unwrap();
    let status = bridge::invoke(
        &registry,
        &library,
        "cloudparse.status@1",
        &json!({"paperId":"p"}),
    )
    .unwrap();
    assert_eq!(status["jobs"][0]["candidateStored"], true);
    let repeat = registry
        .start(
            "cloudparse.map@1",
            json!({"paperId":"p","batchId":"batch"}),
            testkit::Collector::new(),
        )
        .unwrap();
    assert_eq!(
        testkit::wait_terminal(&registry, &repeat, Duration::from_secs(30)).unwrap(),
        TaskStatus::Failed
    );
    let failed = serde_json::to_value(registry.get(&repeat).unwrap()).unwrap();
    assert_eq!(failed["error"]["code"], "parse_batch_stale", "{failed}");
}
