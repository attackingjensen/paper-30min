//! 测试与冒烟共用的支撑代码：事件收集器、终态等待与 mock HTTP 服务器。
//! 生产路径不使用；放在库内以便集成测试与 `--bridge-smoke` 共享同一份实现。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::tasks::{EventSink, TaskEvent, TaskRegistry, TaskStatus};

/// 把任务事件收集到内存里，供断言事件序列。
pub struct Collector {
    events: Mutex<Vec<TaskEvent>>,
}

impl Collector {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
        })
    }

    pub fn events(&self) -> Vec<TaskEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl EventSink for Collector {
    fn emit(&self, event: TaskEvent) {
        self.events.lock().unwrap().push(event);
    }
}

/// 轮询直到任务到达终态或超时；超时返回 None。
pub fn wait_terminal(registry: &Arc<TaskRegistry>, task_id: &str, timeout: Duration) -> Option<TaskStatus> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(snapshot) = registry.get(task_id) {
            if snapshot.status.is_terminal() {
                return Some(snapshot.status);
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    None
}

/// 轮询直到事件流里出现满足条件的事件或超时。
pub fn wait_for_event(
    collector: &Arc<Collector>,
    pred: impl Fn(&TaskEvent) -> bool,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if collector.events().iter().any(|event| pred(event)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

/// mock 服务器收到的一条请求（方法、路径、头、体），供路由与断言。
#[derive(Debug, Clone)]
pub struct MockRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl MockRequest {
    /// 头部查找（忽略大小写）。
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// 预置响应体：一次性字节、分片延迟写出（SSE 流、慢响应共用），
/// 或以 HTTP chunked 编码写出后不写终止块（模拟流式响应中途断连）。
#[derive(Debug, Clone)]
pub enum MockBody {
    Bytes(Vec<u8>),
    Chunked { chunks: Vec<Vec<u8>>, delay: Duration },
    TruncatedChunked { chunks: Vec<Vec<u8>>, delay: Duration },
    /// 停流（#94）：写出响应头（Content-Length 大于已发字节）与 prefix 后不再产出，
    /// 直到服务器关闭——模拟连接挂起，客户端只能靠按读超时退出。
    Stall { prefix: Vec<u8> },
}

/// 预置响应：状态、头与体。
#[derive(Debug, Clone)]
pub struct MockResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: MockBody,
}

impl MockResponse {
    pub fn bytes(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".to_string(), content_type.to_string())],
            body: MockBody::Bytes(body.into()),
        }
    }

    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self::bytes(
            status,
            "application/json",
            serde_json::to_vec(&body).unwrap_or_default(),
        )
    }

    /// SSE 流：每个 payload 写成 `data: {payload}\n\n`，片间延迟；[DONE] 由调用方显式带上。
    pub fn sse(payloads: Vec<String>, delay: Duration) -> Self {
        let chunks = payloads
            .into_iter()
            .map(|payload| format!("data: {payload}\n\n").into_bytes())
            .collect();
        Self {
            status: 200,
            headers: vec![("Content-Type".to_string(), "text/event-stream".to_string())],
            body: MockBody::Chunked { chunks, delay },
        }
    }

    /// 中途断连的 SSE 流：以 chunked 编码逐片写出 payload，随后不写终止块直接
    /// 关闭连接——客户端读到的是「流不完整」的网络错误（可重试），而不是干净 EOF。
    pub fn sse_aborted(payloads: Vec<String>, delay: Duration) -> Self {
        let chunks = payloads
            .into_iter()
            .map(|payload| format!("data: {payload}\n\n").into_bytes())
            .collect();
        Self {
            status: 200,
            headers: vec![
                ("Content-Type".to_string(), "text/event-stream".to_string()),
                ("Transfer-Encoding".to_string(), "chunked".to_string()),
            ],
            body: MockBody::TruncatedChunked { chunks, delay },
        }
    }

    /// 慢响应/大二进制：定长内容分片写出，片间延迟。
    pub fn slow_bytes(status: u16, content_type: &str, body: Vec<u8>, chunk_size: usize, delay: Duration) -> Self {
        let chunks = body
            .chunks(chunk_size.max(1))
            .map(|slice| slice.to_vec())
            .collect();
        Self {
            status,
            headers: vec![("Content-Type".to_string(), content_type.to_string())],
            body: MockBody::Chunked { chunks, delay },
        }
    }
}

type MockHandler = Arc<dyn Fn(&MockRequest, u64) -> MockResponse + Send + Sync>;

/// mock HTTP 服务器：绑 127.0.0.1:0，accept 循环每连接一线程。
/// 路由由闭包按请求与命中次数决定响应，覆盖 SSE、/models、计数式 500→200、
/// 慢响应（取消测试）与超限响应等场景。
pub struct MockHttp {
    port: u16,
    hits: Arc<AtomicU64>,
    connections: Arc<AtomicU64>,
    requests: Arc<Mutex<Vec<MockRequest>>>,
    shutdown: Arc<AtomicBool>,
    accept_thread: Option<JoinHandle<()>>,
}

impl MockHttp {
    pub fn start(handler: impl Fn(&MockRequest, u64) -> MockResponse + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定 mock 服务器");
        listener.set_nonblocking(true).expect("设置非阻塞 accept");
        let port = listener.local_addr().expect("读取 mock 端口").port();
        let hits = Arc::new(AtomicU64::new(0));
        let connections = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let accept_thread = {
            let hits = Arc::clone(&hits);
            let connections = Arc::clone(&connections);
            let requests = Arc::clone(&requests);
            let shutdown = Arc::clone(&shutdown);
            let handler: MockHandler = Arc::new(handler);
            std::thread::spawn(move || {
                while !shutdown.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            connections.fetch_add(1, Ordering::SeqCst);
                            let hits = Arc::clone(&hits);
                            let requests = Arc::clone(&requests);
                            let handler = Arc::clone(&handler);
                            let shutdown = Arc::clone(&shutdown);
                            std::thread::spawn(move || {
                                serve_connection(stream, hits, requests, handler, shutdown)
                            });
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(5)),
                    }
                }
            })
        };
        Self {
            port,
            hits,
            connections,
            requests,
            shutdown,
            accept_thread: Some(accept_thread),
        }
    }

    /// 拼出指向本 mock 的完整 URL。
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }

    /// 已处理请求数（重试测试断言用）。
    pub fn hits(&self) -> u64 {
        self.hits.load(Ordering::SeqCst)
    }

    /// 已 accept 的 TCP 连接数（共享客户端 keep-alive 断言用）。
    pub fn connections(&self) -> u64 {
        self.connections.load(Ordering::SeqCst)
    }

    /// 已记录请求（断言请求头/体用）。
    pub fn requests(&self) -> Vec<MockRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for MockHttp {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(thread) = self.accept_thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve_connection(
    mut stream: std::net::TcpStream,
    hits: Arc<AtomicU64>,
    requests: Arc<Mutex<Vec<MockRequest>>>,
    handler: MockHandler,
    shutdown: Arc<AtomicBool>,
) {
    // 部分平台 accept 出的流会继承非阻塞标志，显式设回阻塞。
    let _ = stream.set_nonblocking(false);
    let mut first = true;
    loop {
        if shutdown.load(Ordering::SeqCst) {
            return;
        }
        let idle = if first {
            Duration::from_secs(10)
        } else {
            Duration::from_millis(200)
        };
        let _ = stream.set_read_timeout(Some(idle));
        let Some(request) = read_request(&mut stream) else {
            return;
        };
        first = false;
        let hit = hits.fetch_add(1, Ordering::SeqCst) + 1;
        requests.lock().unwrap().push(request.clone());
        let response = handler(&request, hit);
        // 客户端中途取消时写会失败（broken pipe），忽略即可。
        let keep_alive = !matches!(response.body, MockBody::TruncatedChunked { .. });
        let _ = write_response(&mut stream, &response, keep_alive, &shutdown);
        if !keep_alive {
            return;
        }
    }
}

/// 解析请求：头读到 \r\n\r\n，按 Content-Length 读体。
fn read_request(stream: &mut std::net::TcpStream) -> Option<MockRequest> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut raw = Vec::new();
    let mut buf = [0_u8; 4096];
    let header_end = loop {
        if let Some(pos) = find_subslice(&raw, b"\r\n\r\n") {
            break pos;
        }
        let read = stream.read(&mut buf).ok()?;
        if read == 0 {
            return None;
        }
        raw.extend_from_slice(&buf[..read]);
        if raw.len() > 1024 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&raw[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = Vec::new();
    let mut content_length = 0_usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let value = value.trim().to_string();
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.parse().unwrap_or(0);
            }
            headers.push((name.trim().to_string(), value));
        }
    }
    let mut body = raw[header_end + 4..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut buf).ok()?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&buf[..read]);
    }
    body.truncate(content_length);
    Some(MockRequest {
        method,
        path,
        headers,
        body,
    })
}

fn write_response(
    stream: &mut std::net::TcpStream,
    response: &MockResponse,
    keep_alive: bool,
    shutdown: &AtomicBool,
) -> std::io::Result<()> {
    let status_text = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Status",
    };
    let mut head = format!("HTTP/1.1 {} {}\r\n", response.status, status_text);
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    // 定长体与完整 SSE 分片带 Content-Length，便于 HTTP/1.1 keep-alive 复用连接；
    // 截断流仍靠 Connection: close 收尾。
    if keep_alive {
        head.push_str("Connection: keep-alive\r\n");
    } else {
        head.push_str("Connection: close\r\n");
    }
    match &response.body {
        MockBody::Bytes(bytes) => {
            head.push_str(&format!("Content-Length: {}\r\n", bytes.len()));
        }
        MockBody::Chunked { chunks, .. } => {
            let total: usize = chunks.iter().map(Vec::len).sum();
            head.push_str(&format!("Content-Length: {total}\r\n"));
        }
        MockBody::TruncatedChunked { .. } => {}
        // 声明比实际更多的字节：客户端发完 prefix 后必然停在读取上。
        MockBody::Stall { prefix } => {
            head.push_str(&format!("Content-Length: {}\r\n", prefix.len() + 1));
        }
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    match &response.body {
        MockBody::Bytes(bytes) => stream.write_all(bytes)?,
        MockBody::Chunked { chunks, delay } => {
            for chunk in chunks {
                stream.write_all(chunk)?;
                stream.flush()?;
                if !delay.is_zero() {
                    std::thread::sleep(*delay);
                }
            }
        }
        // 按 HTTP chunked 编码写片但不写 0 长度终止块：连接关闭即截断，
        // 客户端把这次响应视为不完整流（网络错误）。
        MockBody::TruncatedChunked { chunks, delay } => {
            for chunk in chunks {
                stream.write_all(format!("{:x}\r\n", chunk.len()).as_bytes())?;
                stream.write_all(chunk)?;
                stream.write_all(b"\r\n")?;
                stream.flush()?;
                if !delay.is_zero() {
                    std::thread::sleep(*delay);
                }
            }
        }
        MockBody::Stall { prefix } => {
            stream.write_all(prefix)?;
            stream.flush()?;
            while !shutdown.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    stream.flush()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
