use serde_json::{json, Value};
use std::sync::Arc;

use crate::error::BridgeError;
use crate::files::AttachmentWrite;
use crate::library::{Library, PaperDto, ReadingPositionDto};
use crate::tasks::{available_task_kinds, TaskRegistry};

pub const BRIDGE_SCHEMA_VERSION: u32 = 1;

/// `invoke(command, input)` 支持的第一组版本化命令。
/// 名称带 `@1` 后缀；不兼容变更升级版本号而不是改变原命令语义。
pub fn available_commands() -> &'static [&'static str] {
    &[
        "app.info@1",
        "bridge.echo@1",
        "tasks.list@1",
        "tasks.get@1",
        "tasks.cancel@1",
        "app.close-window@1",
        "library.info@1",
        "library.listPapers@1",
        "library.getPaper@1",
        "library.putPaper@1",
        "library.deletePaper@1",
        "library.getReadingPosition@1",
        "library.putReadingPosition@1",
        "library.deleteReadingPosition@1",
        "files.putAttachment@1",
        "files.listAttachments@1",
        "files.getAttachment@1",
        "files.readRange@1",
        "files.verifyAttachment@1",
        "files.cleanupTemps@1",
        "migration.inspect@1",
        "migration.commit@1",
    ]
}

/// 统一命令分发。短时、幂等或事务性操作走这里；长任务走 `start`。
/// `app.close-window@1` 需要窗口句柄，由 Tauri 命令层拦截，不在此分发。
pub fn invoke(
    registry: &Arc<TaskRegistry>,
    library: &Library,
    command: &str,
    input: &Value,
) -> Result<Value, BridgeError> {
    match command {
        "app.info@1" => Ok(json!({
            "schemaVersion": BRIDGE_SCHEMA_VERSION,
            "app": {
                "name": "Paper30min",
                "version": env!("CARGO_PKG_VERSION"),
                "identifier": "com.paper30min.reader",
                "platform": std::env::consts::OS,
            },
            "commands": available_commands(),
            "taskKinds": available_task_kinds(),
        })),
        "bridge.echo@1" => Ok(json!({
            "schemaVersion": BRIDGE_SCHEMA_VERSION,
            "echo": input,
        })),
        "tasks.list@1" => {
            let active_only = input
                .get("activeOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "tasks": registry.list(active_only),
            }))
        }
        "tasks.get@1" => {
            let task_id = required_string(command, input, "taskId")?;
            let task = registry
                .get(task_id)
                .ok_or_else(|| BridgeError::task_not_found(task_id))?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "task": task,
            }))
        }
        "tasks.cancel@1" => {
            let task_id = required_string(command, input, "taskId")?;
            let task = registry.request_cancel(task_id)?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "task": task,
            }))
        }
        "library.info@1" => serde_json::to_value(library.info())
            .map_err(|err| BridgeError::internal(format!("序列化书库信息失败: {err}"))),
        "library.listPapers@1" => Ok(json!({
            "schemaVersion": BRIDGE_SCHEMA_VERSION,
            "papers": library.list_papers()?,
        })),
        "library.getPaper@1" => {
            let paper_id = required_string(command, input, "paperId")?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "paper": library.get_paper(paper_id)?,
            }))
        }
        "library.putPaper@1" => {
            let paper = parse_dto::<PaperDto>(command, input, "paper")?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "paper": library.put_paper(paper)?,
            }))
        }
        "library.deletePaper@1" => {
            let paper_id = required_string(command, input, "paperId")?;
            library.delete_paper(paper_id)?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "deleted": true,
            }))
        }
        "library.getReadingPosition@1" => {
            let paper_id = required_string(command, input, "paperId")?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "position": library.get_reading_position(paper_id)?,
            }))
        }
        "library.putReadingPosition@1" => {
            let position = parse_dto::<ReadingPositionDto>(command, input, "position")?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "position": library.put_reading_position(position)?,
            }))
        }
        "library.deleteReadingPosition@1" => {
            let paper_id = required_string(command, input, "paperId")?;
            let deleted = library.delete_reading_position(paper_id)?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "deleted": deleted,
            }))
        }
        "files.putAttachment@1" => {
            let paper_id = required_string(command, input, "paperId")?;
            let attachment = parse_dto::<AttachmentWrite>(command, input, "attachment")?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "attachment": library.put_attachment(paper_id, attachment)?,
            }))
        }
        "files.listAttachments@1" => {
            let paper_id = required_string(command, input, "paperId")?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "attachments": library.list_attachments(paper_id)?,
            }))
        }
        "files.getAttachment@1" => {
            let paper_id = required_string(command, input, "paperId")?;
            let attachment_id = required_string(command, input, "attachmentId")?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "attachment": library.get_attachment(paper_id, attachment_id)?,
            }))
        }
        "files.readRange@1" => {
            let paper_id = required_string(command, input, "paperId")?;
            let attachment_id = required_string(command, input, "attachmentId")?;
            let offset = required_u64(command, input, "offset")?;
            let length = required_u64(command, input, "length")?;
            let (attachment, bytes) = library.read_range(paper_id, attachment_id, offset, length)?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "attachment": attachment,
                "offset": offset,
                "length": bytes.len() as u64,
                "totalSize": attachment.size,
                "contentBase64": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
            }))
        }
        "files.verifyAttachment@1" => {
            let paper_id = required_string(command, input, "paperId")?;
            let attachment_id = required_string(command, input, "attachmentId")?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "attachment": library.verify_attachment(paper_id, attachment_id)?,
            }))
        }
        "files.cleanupTemps@1" => {
            let removed = library.cleanup_temps()?;
            Ok(json!({
                "schemaVersion": BRIDGE_SCHEMA_VERSION,
                "removed": removed,
            }))
        }
        "migration.inspect@1" => {
            let (source_path, ttl_seconds) = crate::migration::inspect_input(input)?;
            library.inspect_migration(source_path, ttl_seconds)
        }
        "migration.commit@1" => {
            let token = required_string(command, input, "token")?;
            library.commit_migration(token)
        }
        _ => Err(BridgeError::unknown_command(command)),
    }
}

fn required_string<'a>(command: &str, input: &'a Value, field: &str) -> Result<&'a str, BridgeError> {
    input
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BridgeError::invalid_input(format!("{command} 需要字符串参数 {field}")))
}

fn required_u64(command: &str, input: &Value, field: &str) -> Result<u64, BridgeError> {
    input
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| BridgeError::invalid_input(format!("{command} 需要整数参数 {field}")))
}

fn parse_dto<T: serde::de::DeserializeOwned>(
    command: &str,
    input: &Value,
    field: &str,
) -> Result<T, BridgeError> {
    let value = input
        .get(field)
        .ok_or_else(|| BridgeError::invalid_input(format!("{command} 需要 {field}")))?;
    serde_json::from_value(value.clone())
        .map_err(|err| BridgeError::invalid_input(format!("{command} 的 {field} 无效: {err}")))
}
