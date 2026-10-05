use super::*;
use crate::library::Library;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn fixture_registry(directory: &tempfile::TempDir) -> Arc<TaskRegistry> {
    let library = Arc::new(Library::open(directory.path()).unwrap());
    crate::settings::put_network(&library, &json!({ "settings": { "proxyMode": "direct" } })).unwrap();
    TaskRegistry::new(library)
}

fn stalled_updater() -> (tauri::App<tauri::test::MockRuntime>, Updater) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/latest.json", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        socket.read(&mut request).unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n{")
            .unwrap();
        std::thread::sleep(Duration::from_secs(1));
    });
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({ "pubkey": "test", "endpoints": [], "dangerousInsecureTransportProtocol": true }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint.parse().unwrap()])
        .unwrap()
        .no_proxy()
        .build()
        .unwrap();
    (app, updater)
}

#[tokio::test]
async fn check_stall_has_retryable_deadline() {
    let (_app, updater) = stalled_updater();
    let result = tokio::time::timeout(
        Duration::from_millis(500),
        check_update(&updater, Duration::from_millis(100)),
    )
    .await;
    let error = result
        .expect("check must end within its deadline")
        .err()
        .unwrap();
    assert_eq!(error.code, "update_check_timeout");
    assert!(error.retryable);
}

#[tokio::test]
async fn second_check_stall_releases_task_and_component_admission() {
    let (_app, updater) = stalled_updater();
    let directory = tempfile::tempdir().unwrap();
    let library = Arc::new(Library::open(directory.path()).unwrap());
    let registry = TaskRegistry::new(library);
    let gate = AdmissionGate::new();
    let result = tokio::time::timeout(
        Duration::from_millis(500),
        install_from_updater(
            &updater,
            &gate,
            &registry,
            "9.9.9",
            (Duration::from_millis(100), Duration::from_millis(100)),
            |_| {},
            |_, _| panic!("installation must not start after a check timeout"),
        ),
    )
    .await;
    let error = result
        .expect("install must end within the check deadline")
        .unwrap_err();
    assert_eq!(error.code, "update_check_timeout");
    assert!(!gate.installing());
    gate.admit_task(|| Ok::<_, BridgeError>(())).unwrap();
    gate.admit_component(&registry).unwrap();
}

#[derive(Clone, Copy)]
enum DownloadMode {
    StalledHeaders,
    StalledBody,
    Slow,
    Truncated,
    Tampered,
    Complete,
    ChangedVersion,
    NoUpdate,
}

struct DownloadFixture {
    _app: tauri::App<tauri::test::MockRuntime>,
    updater: Updater,
    stop: Arc<AtomicBool>,
    disconnected: Arc<AtomicBool>,
    downloads: Arc<AtomicUsize>,
    server: Option<std::thread::JoinHandle<()>>,
}

impl DownloadFixture {
    fn new(mode: DownloadMode) -> Self {
        let signed: Value =
            serde_json::from_str(include_str!("../tests/fixtures/updater/signed-bytes.json"))
                .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({
                "pubkey": signed["pubkey"], "endpoints": [], "requireSignedVersion": true,
                "dangerousInsecureTransportProtocol": true,
            }),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app
            .updater_builder()
            .endpoints(vec![format!("{url}/latest.json").parse().unwrap()])
            .unwrap()
            .no_proxy()
            .build()
            .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let disconnected = Arc::new(AtomicBool::new(false));
        let downloads = Arc::new(AtomicUsize::new(0));
        let server = {
            let stop = stop.clone();
            let disconnected = disconnected.clone();
            let downloads = downloads.clone();
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let (mut socket, _) = match listener.accept() {
                        Ok(socket) => socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("fixture accept: {error}"),
                    };
                    socket.set_nonblocking(false).unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = [0; 4096];
                    let count = socket.read(&mut request).unwrap();
                    if String::from_utf8_lossy(&request[..count]).starts_with("GET /latest.json ") {
                        if matches!(mode, DownloadMode::NoUpdate) {
                            socket
                                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                                .unwrap();
                            continue;
                        }
                        let version = if matches!(mode, DownloadMode::ChangedVersion) {
                            "9.9.8"
                        } else {
                            "9.9.9"
                        };
                        let body = json!({ "version": version, "url": format!("{url}/fixture.bin"),
                            "signature": signed["signature"] })
                        .to_string();
                        write!(
                            socket,
                            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .unwrap();
                        continue;
                    }
                    downloads.fetch_add(1, Ordering::SeqCst);
                    let mut content = signed["content"].as_str().unwrap().as_bytes().to_vec();
                    if matches!(mode, DownloadMode::Tampered) {
                        content[0] ^= 1;
                    }
                    if !matches!(mode, DownloadMode::StalledHeaders) {
                        write!(
                            socket,
                            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                            content.len()
                        )
                        .unwrap();
                    }
                    match mode {
                        DownloadMode::StalledHeaders | DownloadMode::StalledBody => {
                            if matches!(mode, DownloadMode::StalledBody) {
                                socket.write_all(&content[..4]).unwrap();
                            }
                            let closed = socket.read(&mut request).map(|n| n == 0).unwrap_or(true);
                            disconnected.store(closed, Ordering::SeqCst);
                        }
                        DownloadMode::Truncated => {
                            socket.write_all(&content[..4]).unwrap();
                        }
                        DownloadMode::Slow => {
                            for chunk in content.chunks(4) {
                                if socket.write_all(chunk).is_err() {
                                    break;
                                }
                                std::thread::sleep(Duration::from_millis(50));
                            }
                        }
                        _ => {
                            socket.write_all(&content).unwrap();
                        }
                    }
                }
            })
        };
        Self {
            _app: app,
            updater,
            stop,
            disconnected,
            downloads,
            server: Some(server),
        }
    }
}

impl Drop for DownloadFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.server.take().unwrap().join().unwrap();
    }
}

async fn assert_download_failure(mode: DownloadMode, expected: &str) {
    let fixture = DownloadFixture::new(mode);
    let directory = tempfile::tempdir().unwrap();
    let registry = fixture_registry(&directory);
    let gate = AdmissionGate::new();
    let mut events = Vec::new();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        install_from_updater(
            &fixture.updater,
            &gate,
            &registry,
            "9.9.9",
            (Duration::from_millis(500), Duration::from_millis(200)),
            |event| {
                assert_eq!(
                    gate.admit_task(|| Ok::<_, BridgeError>(()))
                        .unwrap_err()
                        .code,
                    "update_busy"
                );
                assert_eq!(
                    gate.admit_component(&registry).unwrap_err().code,
                    "update_busy"
                );
                events.push(event);
            },
            |_, _| panic!("failed download must never install"),
        ),
    )
    .await;
    let error = result
        .expect("download must end without a total-request timeout")
        .unwrap_err();
    assert_eq!(error.code, expected);
    assert!(error.retryable);
    assert!(events.iter().all(|event| event["finished"] != true));
    assert!(!gate.installing());
    gate.admit_task(|| Ok::<_, BridgeError>(())).unwrap();
    gate.admit_component(&registry).unwrap();
    if expected == "update_download_timeout" {
        for _ in 0..100 {
            if fixture.disconnected.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            fixture.disconnected.load(Ordering::SeqCst),
            "cancelled plugin response must close"
        );
    }
}

#[tokio::test]
async fn download_body_stall_stops_without_install_and_releases_admission() {
    assert_download_failure(DownloadMode::StalledBody, "update_download_timeout").await;
}

#[tokio::test]
async fn download_header_stall_also_has_an_idle_deadline() {
    assert_download_failure(DownloadMode::StalledHeaders, "update_download_timeout").await;
}

#[tokio::test]
async fn truncated_network_response_releases_admission() {
    assert_download_failure(DownloadMode::Truncated, "update_download_failed").await;
}

#[tokio::test]
async fn invalid_signature_never_announces_installation_or_installs() {
    assert_download_failure(DownloadMode::Tampered, "update_download_failed").await;
}

#[tokio::test]
async fn changed_version_does_not_download() {
    let fixture = DownloadFixture::new(DownloadMode::ChangedVersion);
    let directory = tempfile::tempdir().unwrap();
    let registry = fixture_registry(&directory);
    let gate = AdmissionGate::new();
    let error = install_from_updater(
        &fixture.updater,
        &gate,
        &registry,
        "9.9.9",
        (Duration::from_secs(1), Duration::from_millis(200)),
        |_| {},
        |_, _| panic!("changed version must not install"),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "update_changed");
    assert_eq!(fixture.downloads.load(Ordering::SeqCst), 0);
    assert!(!gate.installing());
}

#[tokio::test]
async fn no_update_releases_admission() {
    let fixture = DownloadFixture::new(DownloadMode::NoUpdate);
    assert!(check_update(&fixture.updater, Duration::from_secs(1))
        .await
        .unwrap()
        .is_none());
    let directory = tempfile::tempdir().unwrap();
    let registry = fixture_registry(&directory);
    let gate = AdmissionGate::new();
    let error = install_from_updater(
        &fixture.updater,
        &gate,
        &registry,
        "9.9.9",
        (Duration::from_secs(1), Duration::from_millis(200)),
        |_| {},
        |_, _| panic!("no update must not install"),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "update_unavailable");
    assert!(!gate.installing());
}

#[tokio::test]
async fn progressing_download_verifies_then_installs_without_install_deadline() {
    let fixture = DownloadFixture::new(DownloadMode::Slow);
    let directory = tempfile::tempdir().unwrap();
    let registry = fixture_registry(&directory);
    let gate = AdmissionGate::new();
    let mut events = Vec::new();
    let mut installed = false;
    let started = Instant::now();
    install_from_updater(
        &fixture.updater,
        &gate,
        &registry,
        "9.9.9",
        (Duration::from_secs(1), Duration::from_millis(200)),
        |event| {
            assert!(gate.installing());
            events.push(event);
        },
        |update, bytes| {
            assert_eq!(update.version, "9.9.9");
            assert_eq!(bytes, b"Paper30Min updater fixture; never an executable.\n");
            assert!(gate.installing());
            std::thread::sleep(Duration::from_millis(300));
            assert_eq!(
                gate.admit_task(|| Ok::<_, BridgeError>(()))
                    .unwrap_err()
                    .code,
                "update_busy"
            );
            installed = true;
            Ok(())
        },
    )
    .await
    .unwrap();
    assert!(installed);
    assert!(started.elapsed() > Duration::from_millis(600));
    assert_eq!(events.last().unwrap()["finished"], true);
    assert_eq!(events[events.len() - 2]["downloaded"], 49);
    assert!(!gate.installing());
}

#[tokio::test]
async fn zero_byte_notifications_cannot_extend_idle_deadline() {
    let activity = DownloadActivity::new();
    let download = async {
        loop {
            tokio::time::sleep(Duration::from_millis(10)).await;
            activity.received(0);
        }
        #[allow(unreachable_code)]
        Ok::<_, tauri_plugin_updater::Error>(())
    };
    let started = Instant::now();
    let error = download_with_idle_timeout(download, &activity, Duration::from_millis(100))
        .await
        .unwrap_err();
    assert_eq!(error.code, "update_download_timeout");
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[tokio::test]
async fn signed_version_mismatch_does_not_install() {
    let fixture = DownloadFixture::new(DownloadMode::ChangedVersion);
    let directory = tempfile::tempdir().unwrap();
    let registry = fixture_registry(&directory);
    let gate = AdmissionGate::new();
    let mut finished = false;
    let error = install_from_updater(
        &fixture.updater,
        &gate,
        &registry,
        "9.9.8",
        (Duration::from_secs(1), Duration::from_millis(200)),
        |event| {
            finished |= event["finished"] == true;
        },
        |_, _| panic!("bytes signed for 9.9.9 must not install as 9.9.8"),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "update_download_failed");
    assert!(!finished);
    assert!(!gate.installing());
}

#[tokio::test]
async fn installer_error_preserves_admission_until_it_returns() {
    let fixture = DownloadFixture::new(DownloadMode::Complete);
    let directory = tempfile::tempdir().unwrap();
    let registry = fixture_registry(&directory);
    let gate = AdmissionGate::new();
    let error = install_from_updater(
        &fixture.updater,
        &gate,
        &registry,
        "9.9.9",
        (Duration::from_secs(1), Duration::from_millis(200)),
        |_| {},
        |_, _| {
            assert!(gate.installing());
            Err(tauri_plugin_updater::Error::Network(
                "fixture install failure".into(),
            ))
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "update_install_failed");
    assert!(!gate.installing());
    gate.admit_component(&registry).unwrap();
}
