//! 解析组件下载与安装生命周期契约（#94）：停流有界退出、取消及时生效、
//! 慢速下载不被误杀、失败后 busy 复位且暂存文件清理。

mod common;

use paper30min_lib::admission::AdmissionGate;
use paper30min_lib::component_runtime::{download_archive, ComponentRuntime, ComponentSink};
use paper30min_lib::testkit::{MockBody, MockHttp, MockResponse};
use serde_json::Value;
use std::fs::{self, File};
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 记录组件进度事件的测试出口。
#[derive(Default)]
struct CapturingSink {
    events: Mutex<Vec<Value>>,
}

impl ComponentSink for CapturingSink {
    fn component_progress(&self, value: Value) {
        self.events.lock().unwrap().push(value);
    }
}

fn ok_checkpoint() -> impl Fn() -> io::Result<()> + Sync {
    || Ok(())
}

/// 慢速但持续出字节的下载必须完成：不存在整包期限误杀（#94 验收边界）。
#[test]
fn slow_stream_download_completes() {
    let body: Vec<u8> = (0..3000_u32).map(|i| (i % 251) as u8).collect();
    let server = MockHttp::start({
        let body = body.clone();
        move |_, _| MockResponse::slow_bytes(200, "application/zip", body.clone(), 997, Duration::from_millis(30))
    });
    let dir = tempfile::tempdir().expect("临时目录");
    let target = dir.path().join("component.zip.part");
    let mut output = File::create(&target).expect("创建暂存文件");
    let progressed = Arc::new(AtomicU64::new(0));
    let progressed_ref = Arc::clone(&progressed);

    let started = Instant::now();
    download_archive(
        &server.url("/component.zip"),
        &mut output,
        body.len() as u64,
        Duration::from_secs(5),
        Duration::from_secs(5),
        &ok_checkpoint(),
        &move |_| {
            progressed_ref.fetch_add(1, Ordering::SeqCst);
        },
    )
    .expect("慢速下载应完成");

    assert!(started.elapsed() >= Duration::from_millis(60), "确实经过了慢速分片");
    assert_eq!(fs::read(&target).expect("读取下载结果"), body);
    assert!(progressed.load(Ordering::SeqCst) > 0, "下载过程应有进度回调");
}

/// 停流（服务端挂起不再产出字节）必须在按读超时内有界报错，不再无限阻塞（#94 主场景）。
#[test]
fn stalled_stream_times_out_within_read_timeout() {
    let prefix = vec![7_u8; 4096];
    let server = MockHttp::start({
        let prefix = prefix.clone();
        move |_, _| MockResponse {
            status: 200,
            headers: vec![("Content-Type".to_string(), "application/zip".to_string())],
            body: MockBody::Stall { prefix: prefix.clone() },
        }
    });
    let dir = tempfile::tempdir().expect("临时目录");
    let target = dir.path().join("component.zip.part");
    let mut output = File::create(&target).expect("创建暂存文件");
    let read_timeout = Duration::from_secs(2);

    let started = Instant::now();
    let error = download_archive(
        &server.url("/component.zip"),
        &mut output,
        885_407_140,
        Duration::from_secs(5),
        read_timeout,
        &ok_checkpoint(),
        &|_| {},
    )
    .expect_err("停流下载必须有界报错");
    let elapsed = started.elapsed();

    assert!(
        elapsed >= read_timeout && elapsed < read_timeout * 3 + Duration::from_secs(2),
        "停流应在按读超时附近退出，实际 {elapsed:?}"
    );
    assert_eq!(error.code, "component_failed");
    assert!(
        !error.message.contains("大小"),
        "停流错误不应落入大小核对分支：{error}"
    );
    assert_eq!(
        fs::metadata(&target).expect("暂存文件仍在").len(),
        prefix.len() as u64,
        "已下载部分保留在暂存文件，由安装流程清理"
    );
}

/// 取消标记在读取间隙生效：慢速下载中取消应在下一次读取前停止，而不是等整包结束。
#[test]
fn cancel_stops_download_promptly() {
    let body = vec![9_u8; 100 * 1024];
    let server = MockHttp::start({
        let body = body.clone();
        move |_, _| MockResponse::slow_bytes(200, "application/zip", body.clone(), 1024, Duration::from_millis(200))
    });
    let dir = tempfile::tempdir().expect("临时目录");
    let target = dir.path().join("component.zip.part");
    let mut output = File::create(&target).expect("创建暂存文件");
    let progressed = Arc::new(AtomicU64::new(0));
    let progressed_ref = Arc::clone(&progressed);
    let cancel_after = 3_u64;
    let progressed_in_checkpoint = Arc::clone(&progressed);

    let started = Instant::now();
    let error = download_archive(
        &server.url("/component.zip"),
        &mut output,
        body.len() as u64,
        Duration::from_secs(5),
        Duration::from_secs(30),
        &move || {
            if progressed_in_checkpoint.load(Ordering::SeqCst) >= cancel_after {
                Err(io::Error::new(io::ErrorKind::Interrupted, "组件安装已取消"))
            } else {
                Ok(())
            }
        },
        &move |_| {
            progressed_ref.fetch_add(1, Ordering::SeqCst);
        },
    )
    .expect_err("取消后下载应报错退出");

    assert!(
        started.elapsed() < Duration::from_secs(15),
        "取消应及时生效，不应等整包（约 20 秒）完成"
    );
    assert!(error.message.contains("取消"), "错误应体现取消：{error}");
}

/// 服务端提前结束（字节数少于可信清单）必须报大小不符，而不是写出残缺组件包。
#[test]
fn truncated_download_is_rejected() {
    let server = MockHttp::start(|_, _| MockResponse::bytes(200, "application/zip", vec![1_u8; 128]));
    let dir = tempfile::tempdir().expect("临时目录");
    let target = dir.path().join("component.zip.part");
    let mut output = File::create(&target).expect("创建暂存文件");

    let error = download_archive(
        &server.url("/component.zip"),
        &mut output,
        885_407_140,
        Duration::from_secs(5),
        Duration::from_secs(5),
        &ok_checkpoint(),
        &|_| {},
    )
    .expect_err("截断下载必须报错");

    assert!(error.message.contains("大小"), "错误应体现大小不符：{error}");
}

/// 服务端字节数超过可信清单上限：在读取流中提前拒绝，不把超限字节写到底。
#[test]
fn oversize_download_is_rejected() {
    let server = MockHttp::start(|_, _| MockResponse::bytes(200, "application/zip", vec![1_u8; 256]));
    let dir = tempfile::tempdir().expect("临时目录");
    let target = dir.path().join("component.zip.part");
    let mut output = File::create(&target).expect("创建暂存文件");

    let error = download_archive(
        &server.url("/component.zip"),
        &mut output,
        128,
        Duration::from_secs(5),
        Duration::from_secs(5),
        &ok_checkpoint(),
        &|_| {},
    )
    .expect_err("超限下载必须报错");

    assert!(error.message.contains("超出"), "错误应体现超限：{error}");
}

/// HTTP 错误状态（如 Release 资产 404/500）必须映射为组件错误而非静默成功。
#[test]
fn http_error_status_is_rejected() {
    let server = MockHttp::start(|_, _| MockResponse::bytes(500, "text/plain", b"boom".to_vec()));
    let dir = tempfile::tempdir().expect("临时目录");
    let target = dir.path().join("component.zip.part");
    let mut output = File::create(&target).expect("创建暂存文件");

    let error = download_archive(
        &server.url("/component.zip"),
        &mut output,
        885_407_140,
        Duration::from_secs(5),
        Duration::from_secs(5),
        &ok_checkpoint(),
        &|_| {},
    )
    .expect_err("HTTP 500 必须报错");

    assert_eq!(error.code, "component_failed");
}

/// 断网/连接被拒：连接超时有界报错，不挂起（#94 的另一半场景）。
#[test]
fn connect_failure_is_bounded() {
    // 绑定后立即释放的本地端口：连接被快速拒绝。
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定临时端口");
        listener.local_addr().expect("读取端口").port()
    };
    let dir = tempfile::tempdir().expect("临时目录");
    let target = dir.path().join("component.zip.part");
    let mut output = File::create(&target).expect("创建暂存文件");

    let started = Instant::now();
    let error = download_archive(
        &format!("http://127.0.0.1:{port}/component.zip"),
        &mut output,
        885_407_140,
        Duration::from_secs(2),
        Duration::from_secs(5),
        &ok_checkpoint(),
        &|_| {},
    )
    .expect_err("连接失败必须报错");

    assert!(started.elapsed() < Duration::from_secs(10), "连接失败应有界退出");
    assert_eq!(error.code, "component_failed");
}

/// 安装失败（本地来源字节数不足可信清单）后：busy 复位、暂存文件清理、错误进入状态（#94 验收）。
#[test]
fn failed_install_releases_busy_and_cleans_staging() {
    let (registry, _library, dir) = common::env();
    let gate = AdmissionGate::new();
    let root = dir.path().join("component");
    let runtime = ComponentRuntime::new(root.clone(), gate);
    let source = dir.path().join("tiny.zip");
    fs::write(&source, b"not a real component").expect("写假组件包");
    let sink = CapturingSink::default();

    let error = runtime
        .install(&sink, &registry, Some(&source))
        .expect_err("字节数不足可信清单的安装应失败");

    assert!(error.message.contains("大小"), "错误应体现大小不符：{error}");
    assert!(!runtime.is_busy(), "失败后 busy 必须复位");
    let download_dir = root.join("download");
    let leftovers: Vec<_> = fs::read_dir(&download_dir)
        .map(|entries| entries.filter_map(Result::ok).map(|entry| entry.file_name()).collect())
        .unwrap_or_default();
    assert!(leftovers.is_empty(), "暂存目录不应留下半成品：{leftovers:?}");
    let status = runtime.status();
    assert!(status["error"].as_str().unwrap_or_default().contains("大小"));
    assert_eq!(status["phase"].as_str(), Some("idle"));
    assert!(
        sink.events.lock().unwrap().iter().any(|event| event["phase"] == "verifying"),
        "安装过程应有进度事件"
    );
}
