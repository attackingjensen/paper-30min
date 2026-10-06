//! Baidu asynchronous OCR jobs. Raw downloads are candidates, never current paper content.
use crate::{error::BridgeError, files, library::Library, settings, tasks::RunContext};
use reqwest::blocking::{multipart, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const JOB_URL: &str = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const MODEL: &str = "PaddleOCR-VL-1.6";
const MAX_PDF: u64 = 50 * 1024 * 1024;
const MAX_RESULT: u64 = 256 * 1024 * 1024;
const MAX_RESPONSE: u64 = 1024 * 1024;
fn options() -> Value {
    json!({"useDocOrientationClassify":false,"useDocUnwarping":false,"useChartRecognition":false})
}
fn error(code: &str, message: &str) -> BridgeError {
    BridgeError::new(code, message, false)
}
fn io_error(_: std::io::Error) -> BridgeError {
    error("cloud_io_error", "云端任务本机文件读写失败")
}

pub(crate) struct CloudParsePlan {
    pub(crate) paper_id: String,
    pdf_path: PathBuf,
    pdf_sha256: String,
    token: String,
    resume: Option<Record>,
    previous: Option<(String, String)>,
}
impl std::fmt::Debug for CloudParsePlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudParsePlan")
            .field("paper_id", &self.paper_id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u32,
    paper_id: String,
    batch_id: String,
    provider: String,
    model: String,
    options: Value,
    pdf_sha256: String,
    state: String,
    job_id: Option<String>,
    raw_sha256: Option<String>,
    failure_code: Option<String>,
    updated_at: String,
    result_ready: bool,
}
fn record_dir(library: &Library, r: &Record) -> Result<PathBuf, BridgeError> {
    files::require_safe_segment(&r.paper_id, "paperId")?;
    files::require_safe_segment(&r.batch_id, "batchId")?;
    Ok(library
        .root()
        .join("operations/cloudparse")
        .join(&r.paper_id)
        .join(&r.batch_id))
}
fn save(library: &Library, r: &mut Record) -> Result<(), BridgeError> {
    r.updated_at = files::now_iso();
    let dir = record_dir(library, r)?;
    fs::create_dir_all(&dir).map_err(io_error)?;
    let mut file = File::create(dir.join("run.json.part")).map_err(io_error)?;
    serde_json::to_writer(&mut file, r).map_err(|_| error("cloud_io_error", "任务记录写入失败"))?;
    file.sync_all().map_err(io_error)?;
    fs::rename(dir.join("run.json.part"), dir.join("run.json")).map_err(io_error)
}
fn records(library: &Library, paper: Option<&str>) -> Result<Vec<Record>, BridgeError> {
    if let Some(paper) = paper {
        files::require_safe_segment(paper, "paperId")?;
    }
    let root = library.root().join("operations/cloudparse");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for paper_dir in fs::read_dir(&root).map_err(io_error)? {
        let paper_dir = paper_dir.map_err(io_error)?;
        if paper.is_some_and(|p| paper_dir.file_name() != p) {
            continue;
        }
        if !paper_dir.file_type().map_err(io_error)?.is_dir() {
            continue;
        }
        for batch in fs::read_dir(paper_dir.path()).map_err(io_error)? {
            let path = batch.map_err(io_error)?.path().join("run.json");
            if !path.is_file() {
                continue;
            }
            let file = File::open(&path).map_err(io_error)?;
            if file.metadata().map_err(io_error)?.len() > MAX_RESPONSE {
                return Err(error("cloud_record_invalid", "任务记录超过上限"));
            }
            let mut r: Record = serde_json::from_reader(file)
                .map_err(|_| error("cloud_record_invalid", "云端任务记录损坏"))?;
            if record_dir(library, &r)?.join("run.json") != path
                || r.schema_version != 1
                || r.model != MODEL
                || r.options != options()
                || r.provider != "baidu"
            {
                return Err(error("cloud_record_invalid", "云端任务记录身份不匹配"));
            }
            // A crash during submission does not prove whether the provider accepted it.
            if r.state == "submitting" {
                r.state = "submit-unknown".into();
            }
            r.result_ready = false;
            result.push(r);
        }
    }
    result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(result)
}
pub(crate) fn status(library: &Library, input: &Value) -> Result<Value, BridgeError> {
    if input.get("paperId").is_some_and(|v| !v.is_string()) {
        return Err(BridgeError::invalid_input("paperId 必须是字符串"));
    }
    Ok(
        json!({"schemaVersion":1,"jobs":records(library,input.get("paperId").and_then(Value::as_str))?}),
    )
}
fn digest(file: &mut File, limit: u64) -> Result<String, BridgeError> {
    if file.metadata().map_err(io_error)?.len() > limit {
        return Err(error("too_large", "PDF 超过云端解析 50 MiB 上限"));
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    let mut total = 0;
    loop {
        let n = file.read(&mut buffer).map_err(io_error)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > limit {
            return Err(error("too_large", "文件超过上限"));
        }
        hash.update(&buffer[..n]);
    }
    file.rewind().map_err(io_error)?;
    if total == 0 {
        return Err(error("invalid_input", "PDF 不能为空"));
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(crate) fn prepare(library: &Library, input: &Value) -> Result<CloudParsePlan, BridgeError> {
    let paper = input
        .get("paperId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| BridgeError::invalid_input("需要 paperId"))?;
    files::require_safe_segment(paper, "paperId")?;
    let action = input
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("submit");
    if !matches!(action, "submit" | "resume") {
        return Err(BridgeError::invalid_input("action 必须是 submit 或 resume"));
    }
    let config = settings::cloudparse_config(library)?;
    let token = config
        .get("accessToken")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(error("cloud_not_configured", "请先配置百度云端解析凭据"));
    }
    if config.get("uploadConfirmed").and_then(Value::as_bool) != Some(true) {
        return Err(error(
            "cloud_upload_unconfirmed",
            "请先确认论文上传及可能计费",
        ));
    }
    let pdf_path = files::attachment_path(library.root(), paper, "pdf")?;
    library.verify_attachment(paper, "pdf")?;
    let pdf_sha256 = digest(&mut File::open(&pdf_path).map_err(io_error)?, MAX_PDF)?;
    let jobs = records(library, Some(paper))?;
    let selected = if let Some(batch) = input.get("batchId").and_then(Value::as_str) {
        Some(
            jobs.iter()
                .find(|r| r.batch_id == batch)
                .ok_or_else(|| error("cloud_no_job", "指定的云端任务批次不存在"))?,
        )
    } else {
        jobs.first()
    };
    let resume = if action == "resume" {
        let r = selected.ok_or_else(|| error("cloud_no_job", "没有可恢复的云端任务"))?;
        if r.job_id.as_deref().is_none_or(|s| !valid_job(s)) {
            return Err(error(
                "cloud_submit_unknown",
                "受理状态未知，重新提交需要明确确认，可能重复计费",
            ));
        }
        if r.pdf_sha256 != pdf_sha256 {
            return Err(error(
                "integrity_failed",
                "原 PDF 已改变，不能恢复旧云端任务",
            ));
        }
        Some(r.clone())
    } else {
        if !jobs.is_empty() && input.get("resubmitConfirmed").and_then(Value::as_bool) != Some(true)
        {
            return Err(error(
                "cloud_resubmit_confirmation",
                "已有云端记录，请恢复查询；重新上传需要明确确认，可能再次计费",
            ));
        }
        None
    };
    Ok(CloudParsePlan {
        paper_id: paper.into(),
        pdf_path,
        pdf_sha256,
        token,
        resume,
        previous: jobs
            .first()
            .map(|r| (r.batch_id.clone(), r.updated_at.clone())),
    })
}
fn valid_job(job: &str) -> bool {
    !job.is_empty()
        && job.len() <= 200
        && job
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn resource_url(url: &str) -> Result<reqwest::Url, BridgeError> {
    let u = reqwest::Url::parse(url).map_err(|_| error("cloud_unsafe_url", "结果地址不合法"))?;
    let host = u.host_str().unwrap_or("");
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some_and(|p| p != 443)
        || !(host == "paddleocr.aistudio-app.com" || host.ends_with(".bcebos.com"))
    {
        return Err(error("cloud_unsafe_url", "结果必须来自百度 HTTPS 资源域名"));
    }
    Ok(u)
}
fn client(library: &Library, timeout: u64) -> Result<Client, BridgeError> {
    crate::net::no_redirect_client(library, Duration::from_secs(timeout))
}
fn http_error(status: u16) -> BridgeError {
    match status {
        401 | 403 => error("cloud_auth_error", "百度凭据无效或权限不足，请检查配置"),
        429 => error(
            "cloud_rate_limit",
            "百度服务请求限额或额度不足，请稍后恢复查询",
        ),
        _ => error(
            "cloud_http_error",
            &format!("百度请求失败（HTTP {status}）"),
        ),
    }
}
fn response_data(mut response: reqwest::blocking::Response) -> Result<Value, BridgeError> {
    if response.status().as_u16() != 200 {
        return Err(http_error(response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("cloud_network_error", "百度响应读取中断"))?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err(error("too_large", "百度状态响应超过上限"));
    }
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|_| error("cloud_invalid_response", "百度状态响应格式不合法"))?;
    v.get("data")
        .cloned()
        .ok_or_else(|| error("cloud_invalid_response", "百度状态响应缺少 data"))
}
trait Transport {
    fn submit(&mut self, file: File, size: u64, token: &str) -> Result<Value, BridgeError>;
    fn query(&mut self, job: &str, token: &str) -> Result<Value, BridgeError>;
    fn download(&mut self, url: &str) -> Result<Box<dyn Read>, BridgeError>;
}
struct Baidu<'a>(&'a Library);
impl Transport for Baidu<'_> {
    fn submit(&mut self, file: File, size: u64, token: &str) -> Result<Value, BridgeError> {
        let form = multipart::Form::new()
            .text("model", MODEL)
            .text("optionalPayload", options().to_string())
            .part(
                "file",
                multipart::Part::reader_with_length(file.take(size), size)
                    .file_name("paper.pdf")
                    .mime_str("application/pdf")
                    .map_err(|_| error("cloud_invalid_input", "无法建立 PDF 上传"))?,
            );
        response_data(
            client(self.0, 120)?
                .post(JOB_URL)
                .bearer_auth(token)
                .multipart(form)
                .send()
                .map_err(|_| error("cloud_network_error", "百度提交响应中断，受理状态未知"))?,
        )
    }
    fn query(&mut self, job: &str, token: &str) -> Result<Value, BridgeError> {
        response_data(
            client(self.0, 60)?
                .get(format!("{JOB_URL}/{job}"))
                .bearer_auth(token)
                .send()
                .map_err(|_| error("cloud_network_error", "百度查询中断，请恢复查询"))?,
        )
    }
    fn download(&mut self, url: &str) -> Result<Box<dyn Read>, BridgeError> {
        let response = client(self.0, 120)?
            .get(resource_url(url)?)
            .send()
            .map_err(|_| error("cloud_network_error", "结果下载中断，请恢复查询"))?;
        if response.status().as_u16() != 200 {
            return Err(http_error(response.status().as_u16()));
        }
        if response.content_length().is_some_and(|s| s > MAX_RESULT) {
            return Err(error("too_large", "云端结果超过 256 MiB 上限"));
        }
        Ok(Box::new(response))
    }
}
fn validate_result(path: &Path) -> Result<String, BridgeError> {
    let mut reader = BufReader::new(File::open(path).map_err(io_error)?);
    let mut line = Vec::new();
    let mut count = 0;
    let mut hash = Sha256::new();
    let mut total = 0;
    loop {
        line.clear();
        let n = reader
            .by_ref()
            .take(MAX_RESULT + 1 - total)
            .read_until(b'\n', &mut line)
            .map_err(io_error)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_RESULT {
            return Err(error("too_large", "云端结果超过上限"));
        }
        hash.update(&line);
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let v: Value = serde_json::from_slice(&line)
            .map_err(|_| error("cloud_invalid_result", "云端 JSONL 语法校验失败"))?;
        if !v.get("result").is_some_and(Value::is_object) {
            return Err(error("cloud_invalid_result", "云端 JSONL 缺少 result 对象"));
        }
        count += 1;
    }
    if count == 0 {
        return Err(error("cloud_invalid_result", "云端结果为空"));
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn execute(
    ctx: &RunContext,
    plan: &CloudParsePlan,
    transport: &mut dyn Transport,
    poll: Duration,
    wait: Duration,
) -> Result<Value, BridgeError> {
    ctx.cancel_checkpoint()?;
    let latest = records(&ctx.library, Some(&plan.paper_id))?
        .first()
        .map(|r| (r.batch_id.clone(), r.updated_at.clone()));
    if latest != plan.previous {
        return Err(error(
            "cloud_job_changed",
            "云端任务记录已变化，请重新读取状态",
        ));
    }
    let mut file = File::open(&plan.pdf_path).map_err(io_error)?;
    if digest(&mut file, MAX_PDF)? != plan.pdf_sha256 {
        return Err(error("integrity_failed", "原 PDF 已改变"));
    }
    let mut record = plan.resume.clone().unwrap_or_else(|| Record {
        schema_version: 1,
        paper_id: plan.paper_id.clone(),
        batch_id: format!(
            "cloud-{:x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ),
        provider: "baidu".into(),
        model: MODEL.into(),
        options: options(),
        pdf_sha256: plan.pdf_sha256.clone(),
        state: "preparing".into(),
        job_id: None,
        raw_sha256: None,
        failure_code: None,
        updated_at: files::now_iso(),
        result_ready: false,
    });
    let outcome = (|| {
        if record.job_id.is_none() {
            save(&ctx.library, &mut record)?;
            ctx.cancel_checkpoint()?;
            record.state = "submitting".into();
            save(&ctx.library, &mut record)?;
            ctx.emit_detail(
                "cloudparse-phase",
                json!({"phase":"submitting","batchId":record.batch_id}),
            );
            ctx.cancel_checkpoint()?;
            // Never retry a submit; always consume its response before honoring cancellation.
            let size = file.metadata().map_err(io_error)?.len();
            let data = match transport.submit(file, size, &plan.token) {
                Ok(data) => data,
                Err(e) => {
                    record.state = "submit-unknown".into();
                    save(&ctx.library, &mut record)?;
                    return Err(e);
                }
            };
            let job = data
                .get("jobId")
                .and_then(Value::as_str)
                .filter(|s| valid_job(s));
            if job.is_none() {
                record.state = "submit-unknown".into();
                save(&ctx.library, &mut record)?;
                return Err(error(
                    "cloud_submit_unknown",
                    "百度提交响应无有效 jobId，受理状态未知",
                ));
            }
            record.job_id = job.map(str::to_string);
            record.state = "accepted".into();
            save(&ctx.library, &mut record)?;
        }
        ctx.cancel_checkpoint()?;
        let dir = record_dir(&ctx.library, &record)?;
        if record.state == "downloaded" {
            if Some(validate_result(&dir.join("result.jsonl"))?) != record.raw_sha256 {
                return Err(error("integrity_failed", "已保存云端结果摘要不符"));
            }
            return Ok(json!({"job":record}));
        }
        let started = Instant::now();
        loop {
            ctx.cancel_checkpoint()?;
            record.state = "querying".into();
            save(&ctx.library, &mut record)?;
            ctx.emit_detail(
                "cloudparse-phase",
                json!({"phase":"querying","batchId":record.batch_id,"jobId":record.job_id}),
            );
            let data = transport.query(record.job_id.as_deref().unwrap(), &plan.token)?;
            ctx.cancel_checkpoint()?;
            match data.get("state").and_then(Value::as_str) {
                Some("failed") => {
                    record.state = "remote-failed".into();
                    return Err(error(
                        "cloud_remote_failed",
                        "百度远端解析失败，请查看服务控制台",
                    ));
                }
                Some("done") => {
                    let url = data
                        .pointer("/resultUrl/jsonUrl")
                        .and_then(Value::as_str)
                        .ok_or_else(|| error("cloud_invalid_response", "百度结果缺少下载地址"))?;
                    resource_url(url)?;
                    record.state = "downloading".into();
                    save(&ctx.library, &mut record)?;
                    ctx.emit_detail(
                        "cloudparse-phase",
                        json!({"phase":"downloading","batchId":record.batch_id}),
                    );
                    let mut response = transport.download(url)?;
                    let part = dir.join("result.jsonl.part");
                    let mut out = File::create(&part).map_err(io_error)?;
                    let mut buffer = [0; 65536];
                    let mut total = 0;
                    loop {
                        ctx.cancel_checkpoint()?;
                        let n = response.read(&mut buffer).map_err(|_| {
                            error("cloud_network_error", "结果下载中断，请恢复查询")
                        })?;
                        if n == 0 {
                            break;
                        }
                        total += n as u64;
                        if total > MAX_RESULT {
                            return Err(error("too_large", "云端结果超过 256 MiB 上限"));
                        }
                        out.write_all(&buffer[..n]).map_err(io_error)?;
                    }
                    out.sync_all().map_err(io_error)?;
                    drop(out);
                    record.state = "validating".into();
                    save(&ctx.library, &mut record)?;
                    ctx.emit_detail(
                        "cloudparse-phase",
                        json!({"phase":"validating","batchId":record.batch_id}),
                    );
                    ctx.cancel_checkpoint()?;
                    let raw = validate_result(&part)?;
                    ctx.cancel_checkpoint()?;
                    fs::rename(part, dir.join("result.jsonl")).map_err(io_error)?;
                    record.raw_sha256 = Some(raw);
                    record.state = "downloaded".into();
                    record.failure_code = None;
                    save(&ctx.library, &mut record)?;
                    return Ok(json!({"job":record}));
                }
                Some("pending" | "running") => {}
                _ => return Err(error("cloud_invalid_response", "百度返回未知任务状态")),
            }
            if started.elapsed() >= wait {
                record.state = "poll-timeout".into();
                return Err(error(
                    "cloud_poll_timeout",
                    "本轮查询等待已结束，已受理任务可继续恢复查询",
                ));
            }
            let until = Instant::now() + poll;
            while Instant::now() < until {
                ctx.cancel_checkpoint()?;
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    })();
    if let Err(ref e) = outcome {
        record.failure_code = Some(e.code.clone());
        if e.code == crate::tasks::CANCEL_SENTINEL {
            record.state = "cancelled".into();
        } else if !matches!(
            record.state.as_str(),
            "submit-unknown" | "remote-failed" | "poll-timeout"
        ) {
            record.state = "interrupted".into();
        }
        save(&ctx.library, &mut record)?;
    }
    outcome
}
pub(crate) fn run(ctx: &RunContext, plan: &CloudParsePlan) {
    ctx.push_warning("取消只停止本机后续查询和结果处理；已受理的百度任务可能继续执行或计费".into());
    match execute(
        ctx,
        plan,
        &mut Baidu(&ctx.library),
        Duration::from_secs(5),
        Duration::from_secs(900),
    ) {
        Ok(result) => {
            if ctx.cancel_checkpoint().is_err() {
                ctx.cancel_now();
            } else {
                ctx.succeed(Some(result));
            }
        }
        Err(e) if e.code == crate::tasks::CANCEL_SENTINEL => ctx.cancel_now(),
        Err(e) => ctx.fail(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{tasks::TaskRegistry, testkit::Collector};
    use std::{collections::VecDeque, sync::Arc};

    struct Fake {
        submissions: usize,
        queries: usize,
        submit: Result<Value, BridgeError>,
        query: VecDeque<Result<Value, BridgeError>>,
        body: Vec<u8>,
        on_submit: Option<Box<dyn Fn()>>,
        interrupted_download: bool,
        oversized_download: bool,
    }
    impl Fake {
        fn success() -> Self {
            Self {
                submissions: 0,
                queries: 0,
                submit: Ok(json!({"jobId":"job-42"})),
                query: VecDeque::from([Ok(
                    json!({"state":"done","resultUrl":{"jsonUrl":"https://test.bcebos.com/result"}}),
                )]),
                body: b"{\"result\":{}}\n".to_vec(),
                on_submit: None,
                interrupted_download: false,
                oversized_download: false,
            }
        }
    }
    impl Transport for Fake {
        fn submit(&mut self, _: File, _: u64, token: &str) -> Result<Value, BridgeError> {
            assert_eq!(token, "secret-token");
            self.submissions += 1;
            if let Some(action) = &self.on_submit {
                action();
            }
            self.submit.clone()
        }
        fn query(&mut self, job: &str, _: &str) -> Result<Value, BridgeError> {
            assert_eq!(job, "job-42");
            self.queries += 1;
            self.query.pop_front().expect("unexpected repeated query")
        }
        fn download(&mut self, _: &str) -> Result<Box<dyn Read>, BridgeError> {
            if self.interrupted_download {
                return Ok(Box::new(BrokenStream(false)));
            }
            if self.oversized_download {
                return Ok(Box::new(std::io::repeat(b' ').take(MAX_RESULT + 1)));
            }
            Ok(Box::new(std::io::Cursor::new(self.body.clone())))
        }
    }
    struct BrokenStream(bool);
    impl Read for BrokenStream {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "disconnected",
                ));
            }
            self.0 = true;
            buffer[0] = b'{';
            Ok(1)
        }
    }
    fn env() -> (tempfile::TempDir, RunContext) {
        let dir = tempfile::tempdir().unwrap();
        let library = Arc::new(Library::open(dir.path()).unwrap());
        let registry = TaskRegistry::new(library.clone());
        let sink = Collector::new();
        crate::bridge::invoke(
            &registry,
            &library,
            "library.putPaper@1",
            &json!({"paper":{"id":"p","title":"paper"}}),
        )
        .unwrap();
        crate::bridge::invoke(&registry,&library,"files.putAttachment@1",&json!({"paperId":"p","attachment":{"id":"pdf","name":"paper.pdf","contentType":"application/pdf","contentBase64":"JVBERi0xLjQ="}})).unwrap();
        settings::put_cloudparse(
            &library,
            &json!({"settings":{"accessToken":"secret-token","uploadConfirmed":true}}),
        )
        .unwrap();
        (
            dir,
            RunContext {
                registry,
                task_id: "test".into(),
                sink,
                library,
            },
        )
    }
    fn submit_plan(ctx: &RunContext) -> CloudParsePlan {
        prepare(&ctx.library, &json!({"paperId":"p","action":"submit"})).unwrap()
    }
    fn execute_now(
        ctx: &RunContext,
        plan: &CloudParsePlan,
        http: &mut Fake,
    ) -> Result<Value, BridgeError> {
        execute(ctx, plan, http, Duration::ZERO, Duration::ZERO)
    }

    #[test]
    fn accepted_query_failure_restores_same_job_without_upload() {
        let (_dir, ctx) = env();
        let plan = submit_plan(&ctx);
        let mut http = Fake::success();
        http.query = VecDeque::from([Err(error("cloud_network_error", "offline"))]);
        assert_eq!(
            execute_now(&ctx, &plan, &mut http).unwrap_err().code,
            "cloud_network_error"
        );
        assert_eq!(http.submissions, 1);
        let resume = prepare(&ctx.library, &json!({"paperId":"p","action":"resume"})).unwrap();
        let mut recovered = Fake::success();
        let result = execute_now(&ctx, &resume, &mut recovered).unwrap();
        assert_eq!(recovered.submissions, 0);
        assert_eq!(recovered.queries, 1);
        assert_eq!(result["job"]["state"], "downloaded");
        assert_eq!(result["job"]["resultReady"], false);
        assert!(!status(&ctx.library, &json!({}))
            .unwrap()
            .to_string()
            .contains("secret-token"));
        let downloaded = prepare(&ctx.library, &json!({"paperId":"p","action":"resume"})).unwrap();
        let mut no_network = Fake::success();
        execute_now(&ctx, &downloaded, &mut no_network).unwrap();
        assert_eq!(no_network.queries, 0);
    }
    #[test]
    fn unknown_submission_requires_explicit_resubmit_and_never_retries() {
        let (_dir, ctx) = env();
        let mut http = Fake::success();
        http.submit = Err(error("cloud_network_error", "offline"));
        execute_now(&ctx, &submit_plan(&ctx), &mut http).unwrap_err();
        assert_eq!(http.submissions, 1);
        assert_eq!(
            status(&ctx.library, &json!({})).unwrap()["jobs"][0]["state"],
            "submit-unknown"
        );
        assert_eq!(
            prepare(&ctx.library, &json!({"paperId":"p","action":"resume"}))
                .err()
                .unwrap()
                .code,
            "cloud_submit_unknown"
        );
        assert_eq!(
            prepare(&ctx.library, &json!({"paperId":"p","action":"submit"}))
                .err()
                .unwrap()
                .code,
            "cloud_resubmit_confirmation"
        );
        let confirmed = prepare(
            &ctx.library,
            &json!({"paperId":"p","action":"submit","resubmitConfirmed":true}),
        )
        .unwrap();
        execute_now(&ctx, &confirmed, &mut Fake::success()).unwrap();
        assert_eq!(
            status(&ctx.library, &json!({})).unwrap()["jobs"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn nonexistent_batch_cannot_bypass_existing_job_confirmation() {
        let (_dir, ctx) = env();
        let mut http = Fake::success();
        http.submit = Err(error("cloud_network_error", "offline"));
        execute_now(&ctx, &submit_plan(&ctx), &mut http).unwrap_err();
        let invalid = prepare(
            &ctx.library,
            &json!({"paperId":"p","action":"submit","batchId":"absent"}),
        );
        assert_eq!(
            invalid.err().expect("unknown batch must fail").code,
            "cloud_no_job"
        );
    }
    #[test]
    fn cancelling_during_submission_preserves_accepted_job() {
        let (_dir, mut ctx) = env();
        ctx.task_id = ctx
            .registry
            .start(
                "demo.stream-text@1",
                json!({"text":"one two","chunks":2,"chunkDelayMs":1000}),
                ctx.sink.clone(),
            )
            .unwrap();
        let registry = ctx.registry.clone();
        let task = ctx.task_id.clone();
        let mut http = Fake::success();
        http.on_submit = Some(Box::new(move || {
            registry.request_cancel(&task).unwrap();
        }));
        assert_eq!(
            execute_now(&ctx, &submit_plan(&ctx), &mut http)
                .unwrap_err()
                .code,
            crate::tasks::CANCEL_SENTINEL
        );
        let state = status(&ctx.library, &json!({})).unwrap();
        assert_eq!(state["jobs"][0]["jobId"], "job-42");
        assert_eq!(state["jobs"][0]["state"], "cancelled");
        assert_eq!(http.queries, 0);
    }
    #[test]
    fn interrupted_download_invalid_json_and_saved_hash_do_not_become_ready() {
        let (_dir, ctx) = env();
        let mut http = Fake::success();
        http.body = b"bad json\n".to_vec();
        assert_eq!(
            execute_now(&ctx, &submit_plan(&ctx), &mut http)
                .unwrap_err()
                .code,
            "cloud_invalid_result"
        );
        let resume = prepare(&ctx.library, &json!({"paperId":"p","action":"resume"})).unwrap();
        execute_now(&ctx, &resume, &mut Fake::success()).unwrap();
        let r = records(&ctx.library, Some("p")).unwrap().remove(0);
        fs::write(
            record_dir(&ctx.library, &r).unwrap().join("result.jsonl"),
            b"{\"result\":{\"changed\":true}}\n",
        )
        .unwrap();
        let resume = prepare(&ctx.library, &json!({"paperId":"p","action":"resume"})).unwrap();
        assert_eq!(
            execute_now(&ctx, &resume, &mut Fake::success())
                .unwrap_err()
                .code,
            "integrity_failed"
        );
    }
    #[test]
    fn safe_results_only_use_baidu_https_and_auth_errors_do_not_leak_body() {
        for url in [
            "http://x.bcebos.com/result",
            "https://bcebos.com/result",
            "https://a.bcebos.com.evil.test/result",
            "https://user:secret@a.bcebos.com/result",
            "https://127.0.0.1/result",
            "https://a.bcebos.com:444/result",
        ] {
            assert!(resource_url(url).is_err(), "{url}");
        }
        assert!(resource_url("https://a.bcebos.com/result").is_ok());
        assert_eq!(http_error(401).code, "cloud_auth_error");
        assert_eq!(http_error(429).code, "cloud_rate_limit");
    }
    #[test]
    fn timeout_keeps_job_and_stale_submit_plan_cannot_upload_again() {
        let (_dir, ctx) = env();
        let plan = submit_plan(&ctx);
        let stale = submit_plan(&ctx);
        let mut http = Fake::success();
        http.query = VecDeque::from([Ok(json!({"state":"running"}))]);
        assert_eq!(
            execute_now(&ctx, &plan, &mut http).unwrap_err().code,
            "cloud_poll_timeout"
        );
        let mut second = Fake::success();
        assert_eq!(
            execute_now(&ctx, &stale, &mut second).unwrap_err().code,
            "cloud_job_changed"
        );
        assert_eq!(second.submissions, 0);
        assert!(prepare(&ctx.library, &json!({"paperId":"p","action":"resume"})).is_ok());
    }
    #[test]
    fn pdf_size_and_restart_unknown_are_enforced_before_network() {
        let (_dir, ctx) = env();
        let path = files::attachment_path(ctx.library.root(), "p", "pdf").unwrap();
        let mut pdf = File::options().write(true).read(true).open(&path).unwrap();
        pdf.set_len(MAX_PDF).unwrap();
        assert!(digest(&mut pdf, MAX_PDF).is_ok());
        pdf.set_len(MAX_PDF + 1).unwrap();
        assert_eq!(digest(&mut pdf, MAX_PDF).unwrap_err().code, "too_large");
        let mut r = Record {
            schema_version: 1,
            paper_id: "p".into(),
            batch_id: "restart".into(),
            provider: "baidu".into(),
            model: MODEL.into(),
            options: options(),
            pdf_sha256: "abc".into(),
            state: "submitting".into(),
            job_id: None,
            raw_sha256: None,
            failure_code: None,
            updated_at: "".into(),
            result_ready: false,
        };
        save(&ctx.library, &mut r).unwrap();
        assert_eq!(
            status(&ctx.library, &json!({})).unwrap()["jobs"][0]["state"],
            "submit-unknown"
        );
    }
    #[test]
    fn streaming_download_failure_and_size_limit_preserve_job_and_original_pdf() {
        let (_dir, ctx) = env();
        let mut http = Fake::success();
        http.interrupted_download = true;
        assert_eq!(
            execute_now(&ctx, &submit_plan(&ctx), &mut http)
                .unwrap_err()
                .code,
            "cloud_network_error"
        );
        let r = records(&ctx.library, Some("p")).unwrap().remove(0);
        let result = record_dir(&ctx.library, &r).unwrap().join("result.jsonl");
        assert!(!result.exists());
        assert_eq!(r.job_id.as_deref(), Some("job-42"));
        let resume = prepare(&ctx.library, &json!({"paperId":"p","action":"resume"})).unwrap();
        let mut large = Fake::success();
        large.oversized_download = true;
        assert_eq!(
            execute_now(&ctx, &resume, &mut large).unwrap_err().code,
            "too_large"
        );
        assert_eq!(large.submissions, 0);
        assert!(!result.exists());
        assert!(ctx.library.verify_attachment("p", "pdf").is_ok());
    }
}
