fn main() {
    // 打包护栏：bundle.resources 会收进 sidecar/pdfparse 整个目录；
    // 干净克隆若忘记先跑 tools/pdfparse-sidecar/build_sidecar.py，
    // 安装包会静默只带一个 README。构建期大声警告（不设硬失败：
    // 不打包的 dev/test 不需要侧车）。
    let sidecar = std::path::Path::new("sidecar/pdfparse");
    let manifest = sidecar.join("sidecar-manifest.json");
    if !manifest.is_file() {
        println!(
            "cargo:warning=Docling 侧车未构建（{} 缺失）：打包含 pdfparse 的安装包将不可用；\
             请先运行 python tools/pdfparse-sidecar/build_sidecar.py（详见该目录 README）。",
            manifest.display()
        );
    }
    tauri_build::build()
}
