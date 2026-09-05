// THROWAWAY PROTOTYPE (issue #20) - 验证两端共享 Rust 本地能力，不是正式实现。
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppState {
    data_dir: PathBuf,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Serialize)]
pub struct PaperMeta {
    id: String,
    title: String,
    version: i64,
}

#[derive(Serialize)]
pub struct Paper {
    id: String,
    title: String,
    version: i64,
    markdown: String,
}

#[derive(Serialize)]
pub struct Position {
    view: String,
    anchor: String,
}

#[derive(Serialize, Clone)]
struct StreamPayload {
    id: String,
    text: String,
}

fn db(state: &AppState) -> Result<Connection, String> {
    let conn = Connection::open(state.data_dir.join("prototype.sqlite")).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS papers(id TEXT PRIMARY KEY, title TEXT, version INTEGER, markdown TEXT);
         CREATE TABLE IF NOT EXISTS positions(paper_id TEXT PRIMARY KEY, view TEXT, anchor TEXT);
         CREATE TABLE IF NOT EXISTS attachments(paper_id TEXT PRIMARY KEY, name TEXT, path TEXT);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
fn list_papers(state: State<AppState>) -> Result<Vec<PaperMeta>, String> {
    let conn = db(&state)?;
    let mut stmt = conn
        .prepare("SELECT id, title, version FROM papers ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PaperMeta { id: r.get(0)?, title: r.get(1)?, version: r.get(2)? })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
fn get_paper(state: State<AppState>, id: String) -> Result<Paper, String> {
    let conn = db(&state)?;
    conn.query_row(
        "SELECT id, title, version, markdown FROM papers WHERE id = ?1",
        params![id],
        |r| Ok(Paper { id: r.get(0)?, title: r.get(1)?, version: r.get(2)?, markdown: r.get(3)? }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_paper(state: State<AppState>, id: String, title: String, version: i64, markdown: String) -> Result<(), String> {
    let conn = db(&state)?;
    conn.execute(
        "INSERT INTO papers(id, title, version, markdown) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET title=?2, version=?3, markdown=?4",
        params![id, title, version, markdown],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_position(state: State<AppState>, id: String, view: String, anchor: String) -> Result<(), String> {
    let conn = db(&state)?;
    conn.execute(
        "INSERT INTO positions(paper_id, view, anchor) VALUES(?1, ?2, ?3)
         ON CONFLICT(paper_id) DO UPDATE SET view=?2, anchor=?3",
        params![id, view, anchor],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_position(state: State<AppState>, id: String) -> Result<Option<Position>, String> {
    let conn = db(&state)?;
    let mut stmt = conn
        .prepare("SELECT view, anchor FROM positions WHERE paper_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(r) => Ok(Some(Position { view: r.get(0).map_err(|e| e.to_string())?, anchor: r.get(1).map_err(|e| e.to_string())? })),
        None => Ok(None),
    }
}

// 下载附件到 .part 再改名，中断不留下半个文件冒充完整附件。
#[tauri::command]
fn import_attachment(state: State<AppState>, id: String, url: String, name: String) -> Result<u64, String> {
    let dir = state.data_dir.join("attachments").join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let final_path = dir.join(&name);
    let part_path = dir.join(format!("{name}.part"));
    let resp = reqwest::blocking::get(&url).map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    fs::write(&part_path, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    let conn = db(&state)?;
    conn.execute(
        "INSERT INTO attachments(paper_id, name, path) VALUES(?1, ?2, ?3)
         ON CONFLICT(paper_id) DO UPDATE SET name=?2, path=?3",
        params![id, name, final_path.to_string_lossy().to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(bytes.len() as u64)
}

#[tauri::command]
fn get_attachment(state: State<AppState>, id: String) -> Result<Option<Vec<u8>>, String> {
    let conn = db(&state)?;
    let mut stmt = conn
        .prepare("SELECT path FROM attachments WHERE paper_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(r) => {
            let path: String = r.get(0).map_err(|e| e.to_string())?;
            fs::read(path).map(Some).map_err(|e| e.to_string())
        }
        None => Ok(None),
    }
}

// 新版本整体下载完成后一次性切换；中断时旧版本保持可读。
#[tauri::command]
fn fetch_new_version(state: State<AppState>, id: String, url: String) -> Result<i64, String> {
    let resp = reqwest::blocking::get(&url).map_err(|e| format!("下载中断: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status()));
    }
    let body: serde_json::Value = serde_json::from_str(&resp.text().map_err(|e| format!("下载中断: {e}"))?).map_err(|e| e.to_string())?;
    let version = body["version"].as_i64().ok_or("bad version")?;
    let markdown = body["markdown"].as_str().unwrap_or("").to_string();
    let title = body["title"].as_str().unwrap_or("").to_string();
    let conn = db(&state)?;
    conn.execute(
        "UPDATE papers SET version=?1, markdown=?2, title=?3 WHERE id=?4",
        params![version, markdown, title, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(version)
}

#[tauri::command]
fn start_stream(app: AppHandle, state: State<AppState>, id: String, url: String) -> Result<(), String> {
    let flag = Arc::new(AtomicBool::new(false));
    state.cancels.lock().map_err(|e| e.to_string())?.insert(id.clone(), flag.clone());
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let mut resp = reqwest::blocking::get(&url).map_err(|e| e.to_string())?;
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                if flag.load(Ordering::Relaxed) {
                    app.emit("stream-cancelled", StreamPayload { id: id.clone(), text: String::new() }).ok();
                    return Ok(());
                }
                let n = resp.read(&mut chunk).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
                    let line: String = String::from_utf8_lossy(&buf[..pos]).to_string();
                    buf.drain(..pos + 2);
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            app.emit("stream-done", StreamPayload { id: id.clone(), text: String::new() }).ok();
                            return Ok(());
                        }
                        app.emit("stream-chunk", StreamPayload { id: id.clone(), text: data.to_string() }).ok();
                    }
                }
            }
            app.emit("stream-error", StreamPayload { id: id.clone(), text: "连接中断（未收到结束标记）".into() }).ok();
            Ok(())
        })();
        if let Err(e) = result {
            app.emit("stream-error", StreamPayload { id, text: e }).ok();
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_stream(state: State<AppState>, id: String) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().map_err(|e| e.to_string())?.get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            app.manage(AppState { data_dir, cancels: Mutex::new(HashMap::new()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_papers,
            get_paper,
            save_paper,
            save_position,
            get_position,
            import_attachment,
            get_attachment,
            fetch_new_version,
            start_stream,
            cancel_stream
        ])
        .run(tauri::generate_context!())
        .expect("prototype run failed");
}
