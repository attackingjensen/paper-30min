use paper30min_lib::library::Library;
use paper30min_lib::tasks::TaskRegistry;
use std::sync::Arc;
use tempfile::TempDir;

pub fn env() -> (Arc<TaskRegistry>, Library, TempDir) {
    let dir = tempfile::tempdir().expect("创建临时书库目录");
    let library = Library::open(dir.path()).expect("打开临时书库");
    (TaskRegistry::new(), library, dir)
}
