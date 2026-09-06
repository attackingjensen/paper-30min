//! 网络抓取任务：net.fetch-text@1 文本抓取与 files.download@1 附件流式下载。
//! HTTP 客户端、错误映射与重试策略与 model.rs 一致（code 换成 net_*）。

use serde_json::json;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use crate::error::BridgeError;
use crate::files::{self, AttachmentDto};
use crate::library::Library;
use crate::model::{http_client, http_status_error, network_error, read_body_snippet, READ_CHUNK};
use crate::tasks::{run_with_retry, Progress, RunContext};

/// fetch-text 请求总超时（总超时语义见 model.rs 的说明）。
const FETCH_TEXT_TIMEOUT: Duration = Duration::from_secs(300);
/// 下载请求总超时。
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// url 必须是 http/https；其他 scheme 视为输入错误（invalid_input 语义，不重试）。
fn require_http_url(url: &str) -> Result<(), BridgeError> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(())
    } else {
        Err(BridgeError::invalid_input(format!(
            "url 必须是 http/https 地址: {url}"
        )))
    }
}

/// net.fetch-text@1：GET url，8KB 块读，块间检查取消，超 maxBytes 置 too_large；
/// 完成后发一个 chunk=全部文本（from_utf8_lossy），再 succeeded。
pub(crate) fn run_fetch_text(ctx: &RunContext, url: &str, max_bytes: u64) {
    if let Err(error) = require_http_url(url) {
        return ctx.fail(error);
    }
    let outcome = run_with_retry(ctx, |ctx| fetch_text_once(ctx, url, max_bytes));
    if let Ok(text) = outcome {
        let len = text.len() as u64;
        ctx.push_chunk(Progress { done: len, total: len }, text);
        ctx.succeed(None);
    }
}

fn fetch_text_once(ctx: &RunContext, url: &str, max_bytes: u64) -> Result<String, BridgeError> {
    ctx.cancel_checkpoint()?;
    let client = http_client(FETCH_TEXT_TIMEOUT)?;
    let mut response = client
        .get(url)
        .header("Accept", "application/json, text/event-stream, text/plain, */*")
        .send()
        .map_err(|err| network_error("net_network_error", err))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let snippet = read_body_snippet(response);
        return Err(http_status_error("net_http_error", status, &snippet, false));
    }
    let total = response.content_length().unwrap_or(0);
    let mut bytes: Vec<u8> = Vec::new();
    let mut buf = [0_u8; READ_CHUNK];
    loop {
        ctx.cancel_checkpoint()?;
        let read = response
            .read(&mut buf)
            .map_err(|err| network_error("net_network_error", err))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..read]);
        if bytes.len() as u64 > max_bytes {
            return Err(BridgeError::new(
                "too_large",
                format!("响应超过 maxBytes 上限（{max_bytes} 字节）"),
                false,
            ));
        }
        ctx.push_progress(Progress {
            done: bytes.len() as u64,
            total,
        });
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// files.download@1：流式落盘——边读边写 .part、边算 sha256、发字节进度；
/// 超限清理 .part 后 too_large；完成 fsync + rename 就位 + 元数据行 upsert（事务）。
/// 网络类失败按统一策略重试，每次重试整文件重下，不做断点续传
/// （断点续传属云端契约后续工作）。succeeded 携带 result.attachment。
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_download(
    ctx: &RunContext,
    paper_id: &str,
    attachment_id: &str,
    name: &str,
    content_type: &str,
    url: &str,
    max_bytes: u64,
) {
    // 下载前先确认论文存在，避免白下大文件。
    match paper_exists(&ctx.library, paper_id) {
        Ok(true) => {}
        Ok(false) => return ctx.fail(BridgeError::paper_not_found(paper_id)),
        Err(error) => return ctx.fail(error),
    }
    if let Err(error) = require_http_url(url) {
        return ctx.fail(error);
    }
    let dest = match files::attachment_path(ctx.library.root(), paper_id, attachment_id) {
        Ok(dest) => dest,
        Err(error) => return ctx.fail(error),
    };
    let outcome = run_with_retry(ctx, |ctx| download_once(ctx, url, max_bytes, &dest));
    let Ok((size, sha256)) = outcome else {
        return;
    };
    let dto = AttachmentDto {
        paper_id: paper_id.to_string(),
        id: attachment_id.to_string(),
        name: name.to_string(),
        content_type: content_type.to_string(),
        size: size as i64,
        sha256,
        created_at: files::now_iso(),
    };
    if let Err(error) = commit_metadata(&ctx.library, &dto, &dest) {
        return ctx.fail(error);
    }
    ctx.succeed(Some(json!({ "attachment": dto })));
}

fn paper_exists(library: &Library, paper_id: &str) -> Result<bool, BridgeError> {
    let conn = library.lock_conn()?;
    Library::paper_exists(&conn, paper_id)
}

fn download_once(
    ctx: &RunContext,
    url: &str,
    max_bytes: u64,
    dest: &Path,
) -> Result<(u64, String), BridgeError> {
    ctx.cancel_checkpoint()?;
    let client = http_client(DOWNLOAD_TIMEOUT)?;
    let mut response = client
        .get(url)
        .header("Accept", "*/*")
        .send()
        .map_err(|err| network_error("net_network_error", err))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let snippet = read_body_snippet(response);
        return Err(http_status_error("net_http_error", status, &snippet, false));
    }
    let total = response.content_length().unwrap_or(0);
    // 每次尝试整文件重下：.part 截断重写；writer 中途被 Drop 时清掉 .part。
    let mut writer = files::AttachmentStreamWriter::begin(dest)?;
    let mut buf = [0_u8; READ_CHUNK];
    loop {
        ctx.cancel_checkpoint()?;
        let read = response
            .read(&mut buf)
            .map_err(|err| network_error("net_network_error", err))?;
        if read == 0 {
            break;
        }
        writer.write_chunk(&buf[..read])?;
        if writer.bytes_written() > max_bytes {
            return Err(BridgeError::new(
                "too_large",
                format!("下载超过 maxBytes 上限（{max_bytes} 字节）"),
                false,
            ));
        }
        ctx.push_progress(Progress {
            done: writer.bytes_written(),
            total,
        });
    }
    let size = writer.bytes_written();
    let sha256 = writer.sha256_hex();
    writer.finish()?;
    Ok((size, sha256))
}

/// 元数据行 upsert（事务）；失败时回滚已就位文件（删除新文件、恢复 .old 备份），
/// 与 files.putAttachment 的失败路径一致。
fn commit_metadata(library: &Library, dto: &AttachmentDto, dest: &Path) -> Result<(), BridgeError> {
    let mut conn = library.lock_conn()?;
    let tx = conn
        .transaction()
        .map_err(|err| BridgeError::internal(format!("书库数据库错误: {err}")))?;
    let result = files::insert_attachment_row(&tx, dto).and_then(|_| {
        tx.commit()
            .map_err(|err| BridgeError::internal(format!("书库数据库错误: {err}")))
    });
    if let Err(error) = result {
        files::rollback_promoted(dest);
        return Err(error);
    }
    files::discard_old_backup(dest);
    Ok(())
}
