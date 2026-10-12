#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--bridge-smoke` 不开窗口，直接对桥接做可重复冒烟检查（用 debug 构建保留控制台输出）。
    if std::env::args().any(|arg| arg == "--bridge-smoke") {
        std::process::exit(paper30min_lib::smoke::run());
    }
    paper30min_lib::run();
}
