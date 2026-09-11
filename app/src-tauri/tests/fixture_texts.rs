//! 公式图形合成夹具（fixtures/pdfparse_formula_graphics.pdf）的全部真实文本；
//! 回归 suite（pdfparse_regression.rs）与映射层 fixture（pdfmap_fixtures.rs）
//! 共用同一失真泄漏探针：块流中只允许出现这些文本，多出来的都是图形内容失真。

/// 夹具页面的全部真实文本（与 make_pdfparse_fixtures.py 的 text_ops 保持一致）。
pub const FORMULA_GRAPHICS_TEXTS: [&str; 6] = [
    "Formula Graphics Fixture",
    "1. Introduction",
    "This page mixes real text with a vector-drawn formula and an image formula.",
    "The vector formula above is drawn with path operators only.",
    "The image formula above is a raster bitmap.",
    "Section boundaries must survive graphics regions.",
];
