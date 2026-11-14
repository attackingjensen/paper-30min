mod common;
use paper30min_lib::bridge;
use serde_json::json;

#[test]
fn empty_cloud_job_status_has_no_ready_result() {
    let (registry, library, _dir) = common::env();
    let result = bridge::invoke(&registry, &library, "cloudparse.status@1", &json!({})).unwrap();
    assert_eq!(result["jobs"], json!([]));
}

#[test]
fn cloud_submit_without_credentials_is_rejected_before_network() {
    let (registry, _library, _dir) = common::env();
    let result = registry.start(
        "cloudparse.parse@1",
        json!({"paperId":"missing","action":"submit"}),
        paper30min_lib::testkit::Collector::new(),
    );
    assert_eq!(result.unwrap_err().code, "cloud_not_configured");
}
