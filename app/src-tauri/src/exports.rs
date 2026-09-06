//! 导出写文件：把前端生成的导出内容原子写入 exports 分区，
//! 或用户在保存对话框选择的绝对路径。fileName 只做单段安全名校验；
//! targetPath 视为可信的用户选择路径，但其父目录必须已存在。
//!
//! targetPath 是用户经系统保存对话框亲自选择的绝对路径，属「JS 不接触绝对路径」
//! 原则的显式例外：该路径不出库、不持久化、仅供这一次写出使用，对话框回传后
//! 经 exports.write@1 一次性消费。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use std::path::Path;

use crate::bridge::BRIDGE_SCHEMA_VERSION;
use crate::error::BridgeError;
use crate::files::{require_safe_segment, write_atomic};
use crate::library::Library;

pub fn write_export(library: &Library, input: &Value) -> Result<Value, BridgeError> {
    let file_name = input
        .get("fileName")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::invalid_input("exports.write@1 需要字符串参数 fileName"))?;
    require_safe_segment(file_name, "fileName")?;
    let content = input
        .get("contentBase64")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::invalid_input("exports.write@1 需要字符串参数 contentBase64"))?;
    let bytes = BASE64
        .decode(content.trim())
        .map_err(|_| BridgeError::invalid_input("contentBase64 无效"))?;
    let target_path = input
        .get("targetPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match target_path {
        Some(target) => write_chosen(target, &bytes),
        None => write_partition(library.root(), file_name, &bytes),
    }
}

/// 写入用户在保存对话框选择的绝对路径：父目录必须存在，原子写覆盖同名文件。
fn write_chosen(target: &str, bytes: &[u8]) -> Result<Value, BridgeError> {
    let dest = Path::new(target);
    let parent = dest
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| BridgeError::invalid_input("targetPath 必须包含父目录"))?;
    if !parent.is_dir() {
        return Err(BridgeError::invalid_input("targetPath 的父目录不存在"));
    }
    if dest.is_dir() {
        return Err(BridgeError::invalid_input("targetPath 指向目录而不是文件"));
    }
    write_atomic(dest, bytes)?;
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| BridgeError::invalid_input("targetPath 文件名无效"))?;
    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "fileName": file_name,
        "size": bytes.len() as u64,
        "location": "chosen",
    }))
}

/// 写入书库 exports 分区：重名时在扩展名前加 -1、-2 后缀避让，返回实际使用的 fileName。
fn write_partition(root: &Path, file_name: &str, bytes: &[u8]) -> Result<Value, BridgeError> {
    let dir = root.join("exports");
    let mut actual = file_name.to_string();
    if dir.join(&actual).exists() {
        let (stem, extension) = split_stem_extension(file_name);
        let mut suffix = 1_u32;
        loop {
            actual = format!("{stem}-{suffix}{extension}");
            if !dir.join(&actual).exists() {
                break;
            }
            suffix += 1;
        }
    }
    write_atomic(&dir.join(&actual), bytes)?;
    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION,
        "fileName": actual,
        "size": bytes.len() as u64,
        "location": "exports",
    }))
}

/// 拆出扩展名前的部分与扩展名（含点）；无扩展名时返回原名与空串。
fn split_stem_extension(file_name: &str) -> (&str, &str) {
    match file_name.rfind('.') {
        Some(pos) if pos > 0 => (&file_name[..pos], &file_name[pos..]),
        _ => (file_name, ""),
    }
}
