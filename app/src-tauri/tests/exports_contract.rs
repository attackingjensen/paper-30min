//! 导出写文件外部行为契约：`exports.write@1` 落 exports 分区或用户选择的绝对路径。

mod common;

use paper30min_lib::bridge;
use paper30min_lib::error::BridgeError;
use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use serde_json::{json, Value};
use std::sync::Arc;

fn invoke(registry: &Arc<TaskRegistry>, library: &Library, command: &str, input: Value) -> Value {
    bridge::invoke(registry, library, command, &input).expect(command)
}

fn invoke_err(
    registry: &Arc<TaskRegistry>,
    library: &Library,
    command: &str,
    input: Value,
) -> BridgeError {
    bridge::invoke(registry, library, command, &input).expect_err(command)
}

/// 9 字节固定内容，便于断言写出的字节与输入一致。
const HELLO: &[u8] = b"hello-pdf";
const HELLO_B64: &str = "aGVsbG8tcGRm";

#[test]
fn write_without_target_lands_in_exports_partition() {
    let (registry, library, dir) = common::env();
    let result = invoke(
        &registry,
        &library,
        "exports.write@1",
        json!({ "fileName": "digest.md", "contentBase64": HELLO_B64 }),
    );
    assert_eq!(result["schemaVersion"], json!(bridge::BRIDGE_SCHEMA_VERSION));
    assert_eq!(result["fileName"], json!("digest.md"));
    assert_eq!(result["size"], json!(HELLO.len() as u64));
    assert_eq!(result["location"], json!("exports"));
    let written = std::fs::read(dir.path().join("exports").join("digest.md")).expect("读取导出文件");
    assert_eq!(written, HELLO, "写出的字节应与输入一致");
}

#[test]
fn name_collisions_get_numeric_suffix_before_extension() {
    let (registry, library, dir) = common::env();
    for _ in 0..3 {
        invoke(
            &registry,
            &library,
            "exports.write@1",
            json!({ "fileName": "digest.md", "contentBase64": HELLO_B64 }),
        );
    }
    let exports = dir.path().join("exports");
    assert!(exports.join("digest.md").is_file());
    assert!(exports.join("digest-1.md").is_file(), "重名应加 -1 后缀");
    assert!(exports.join("digest-2.md").is_file(), "再次重名应加 -2 后缀");

    let second = invoke(
        &registry,
        &library,
        "exports.write@1",
        json!({ "fileName": "digest.md", "contentBase64": HELLO_B64 }),
    );
    assert_eq!(second["fileName"], json!("digest-3.md"), "返回实际使用的 fileName");
    assert_eq!(second["location"], json!("exports"));
}

#[test]
fn write_with_target_path_uses_chosen_location() {
    let (registry, library, dir) = common::env();
    let target_dir = tempfile::tempdir().unwrap();
    let target = target_dir.path().join("chosen-name.md");
    let result = invoke(
        &registry,
        &library,
        "exports.write@1",
        json!({
            "fileName": "ignored-name.md",
            "contentBase64": HELLO_B64,
            "targetPath": target.to_string_lossy(),
        }),
    );
    assert_eq!(result["location"], json!("chosen"));
    assert_eq!(result["fileName"], json!("chosen-name.md"));
    assert_eq!(result["size"], json!(HELLO.len() as u64));
    let written = std::fs::read(&target).expect("读取目标文件");
    assert_eq!(written, HELLO, "写出的字节应与输入一致");
    // targetPath 写入不应落进 exports 分区。
    assert!(!dir.path().join("exports").join("chosen-name.md").exists());
}

#[test]
fn target_path_with_missing_parent_is_rejected() {
    let (registry, library, _dir) = common::env();
    let missing = tempfile::tempdir().unwrap();
    let target = missing.path().join("no-such-dir").join("out.md");
    let error = invoke_err(
        &registry,
        &library,
        "exports.write@1",
        json!({
            "fileName": "out.md",
            "contentBase64": HELLO_B64,
            "targetPath": target.to_string_lossy(),
        }),
    );
    assert_eq!(error.code, "invalid_input");
}

#[test]
fn bad_file_name_and_bad_base64_are_rejected() {
    let (registry, library, _dir) = common::env();
    for name in ["../evil.md", "a/b.md", ".hidden.md", "digest.md.part", ""] {
        let error = invoke_err(
            &registry,
            &library,
            "exports.write@1",
            json!({ "fileName": name, "contentBase64": HELLO_B64 }),
        );
        assert_eq!(error.code, "invalid_input", "应拒绝非法 fileName: {name:?}");
    }
    let error = invoke_err(
        &registry,
        &library,
        "exports.write@1",
        json!({ "fileName": "digest.md", "contentBase64": "!!!not-base64!!!" }),
    );
    assert_eq!(error.code, "invalid_input");
    let error = invoke_err(
        &registry,
        &library,
        "exports.write@1",
        json!({ "fileName": "digest.md" }),
    );
    assert_eq!(error.code, "invalid_input", "缺少 contentBase64 应拒绝");
}

#[test]
fn app_info_lists_exports_command() {
    let (registry, library, _dir) = common::env();
    let info = invoke(&registry, &library, "app.info@1", json!({}));
    let commands = info["commands"].as_array().unwrap();
    assert!(commands.iter().any(|item| item == "exports.write@1"), "app.info 未列出 exports.write@1");
}
