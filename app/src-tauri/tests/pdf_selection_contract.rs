mod common;
use paper30min_lib::{bridge, library::Library};
use serde_json::json;

#[test]
fn pdf_selection_binding_survives_reopening_without_inline_image_bytes() {
    let (registry, library, dir) = common::env();
    let selected = json!({"kind":"area","regions":[{"page":2,"bbox":[40,100,400,200],"pageSize":[600,800]}],
        "images":[{"page":2,"attachmentId":"pdf-selection-test"}],"hits":[]});
    bridge::invoke(&registry, &library, "library.putPaper@1", &json!({"paper":{
        "id":"p","title":"Selection","addedAt":"2026-09-30T00:00:00Z","updatedAt":"2026-09-30T00:00:00Z",
        "chat":[{"role":"user","content":"Explain this figure","createdAt":"2026-09-30T00:00:00Z",
          "bindingKind":"pdf","pdfSelection":selected}]
    }})).unwrap();
    for id in ["pdf-selection-test", "pdf-selection-orphan", "pdf"] {
        bridge::invoke(&registry, &library, "files.putAttachment@1", &json!({"paperId":"p", "attachment":{
            "id":id,"name":"image.webp","contentType":"image/webp","contentBase64":"aGVsbG8="
        }})).unwrap();
    }
    bridge::invoke(&registry, &library, "files.cleanupPdfSelections@1", &json!({"paperId":"p",
        "attachmentIds":["pdf-selection-test","pdf-selection-orphan"]})).unwrap();
    assert!(library.get_attachment("p", "pdf-selection-test").is_ok());
    assert!(library.get_attachment("p", "pdf-selection-orphan").is_err());
    assert!(bridge::invoke(&registry, &library, "files.cleanupPdfSelections@1", &json!({"paperId":"p","attachmentIds":["pdf"]})).is_err());
    assert!(library.get_attachment("p", "pdf").is_ok());
    drop(library);
    let reopened = Library::open(dir.path()).unwrap();
    let paper = bridge::invoke(&registry, &reopened, "library.getPaper@1", &json!({"paperId":"p"})).unwrap();
    assert_eq!(paper["paper"]["chat"][0]["bindingKind"], "pdf");
    assert_eq!(paper["paper"]["chat"][0]["pdfSelection"], selected);
}

#[test]
fn v7_chat_rows_migrate_without_losing_existing_messages() {
    let dir = tempfile::tempdir().unwrap();
    {
        let library = Library::open(dir.path()).unwrap();
        let paper: paper30min_lib::library::PaperDto = serde_json::from_value(json!({
            "id":"old","title":"Old","addedAt":"2026-09-30T00:00:00Z","updatedAt":"2026-09-30T00:00:00Z",
            "chat":[{"role":"user","content":"existing question","createdAt":"2026-09-30T00:00:00Z"}]
        })).unwrap();
        library.put_paper(paper).unwrap();
    }
    let conn = rusqlite::Connection::open(dir.path().join("database/library.sqlite")).unwrap();
    conn.execute_batch("ALTER TABLE chat_messages DROP COLUMN pdf_selection_json; PRAGMA user_version=7;").unwrap();
    drop(conn);
    let library = Library::open(dir.path()).unwrap();
    assert_eq!(library.info().database_version, 8);
    let paper = library.get_paper("old").unwrap();
    assert_eq!(paper.chat[0].content, "existing question");
    assert_eq!(paper.chat[0].binding_kind, "none");
    assert!(paper.chat[0].pdf_selection.is_none());
}
