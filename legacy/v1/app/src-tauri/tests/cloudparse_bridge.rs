mod common;

use paper30min_lib::{bridge, tasks};
use serde_json::json;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};
use paper30min_lib::tasks::{EventSink, TaskEvent, TaskStatus};

struct HoldRunner { entered: AtomicBool, release: AtomicBool }
impl EventSink for HoldRunner {
    fn emit(&self, event: TaskEvent) {
        if event.event == "status" && event.status == TaskStatus::Running {
            self.entered.store(true, Ordering::SeqCst);
            let until = Instant::now() + Duration::from_secs(5);
            while !self.release.load(Ordering::SeqCst) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

#[test]
fn cloud_commands_and_task_are_registered_without_credentials_in_status() {
    let (registry, library, _dir) = common::env();
    assert!(tasks::available_task_kinds().contains(&"cloudparse.parse@1"));
    let result = bridge::invoke(&registry, &library, "cloudparse.status@1", &json!({})).unwrap();
    assert_eq!(result["jobs"], json!([]));
    assert!(!result.to_string().contains("accessToken"));
    assert!(bridge::available_commands().contains(&"settings.putCloudparse@1"));
}

#[test]
fn cloud_and_reading_admission_is_symmetric_and_cancel_releases_it() {
    let (registry, library, _dir) = common::env();
    bridge::invoke(&registry, &library, "library.putPaper@1", &json!({"paper":{"id":"gate-paper","title":"Gate"}})).unwrap();
    bridge::invoke(&registry, &library, "settings.putCloudparse@1", &json!({"settings":{"accessToken":"fixture","uploadConfirmed":true}})).unwrap();
    let pdf = include_bytes!("../../ui/samples/sample_paper.pdf");
    use base64::Engine;
    bridge::invoke(&registry, &library, "files.putAttachment@1", &json!({"paperId":"gate-paper","attachment":{
        "id":"pdf","name":"fixture.pdf","contentType":"application/pdf",
        "contentBase64":base64::engine::general_purpose::STANDARD.encode(pdf)
    }})).unwrap();
    for kind in ["cloudparse.parse@1", "paper.build-map@1"] {
        let sink = Arc::new(HoldRunner { entered: AtomicBool::new(false), release: AtomicBool::new(false) });
        let task = registry.start(kind, json!({"paperId":"gate-paper","action":"submit","uploadConfirmed":true}), sink.clone()).unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        while !sink.entered.load(Ordering::SeqCst) && Instant::now() < until { std::thread::sleep(Duration::from_millis(5)); }
        assert!(sink.entered.load(Ordering::SeqCst));
        let other = if kind == "cloudparse.parse@1" { "paper.build-map@1" } else { "cloudparse.parse@1" };
        let error = registry.start(other, json!({"paperId":"gate-paper","action":"submit","uploadConfirmed":true}), paper30min_lib::testkit::Collector::new()).unwrap_err();
        assert_eq!(error.code, "paper_busy");
        registry.request_cancel(&task).unwrap();
        sink.release.store(true, Ordering::SeqCst);
        let snapshot = paper30min_lib::testkit::wait_terminal(&registry, &task, Duration::from_secs(5)).unwrap();
        assert_eq!(snapshot, TaskStatus::Cancelled);
    }
}

