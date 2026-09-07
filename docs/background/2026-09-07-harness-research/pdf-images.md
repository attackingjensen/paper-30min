# 调研：pdf.js 嵌入图提取与页图导出路径

- 来源 Issue：[#39](https://github.com/attackingjensen/paper-30min/issues/39)（Wayfinder 父图 #35）
- 日期：2026-09-07
- 分支：`research/pdf-images`
- 验证环境：Node v24.15.0 + pdfjs-dist 3.11.174（与仓库 `app/ui/vendor/pdf.min.js` 同版本）+ @napi-rs/canvas；样本为 arXiv:1706.03762（Attention Is All You Need，15 页）与真实 arXiv HTML 页 https://arxiv.org/html/2312.11805

## 结论摘要

三条路径全部可行，建议按「嵌入图优先、页图保底、arXiv HTML 走直链」组合：

1. **页图导出**：现有 `page.render → canvas` 管线加 `canvas.toBlob('image/webp')` 即可，仓库已有 ≤1600px webp q0.86 的压缩先例（`prepareRecallImage`）。推荐 scale=2.0（1224×1584px）webp q86，单页约 130–180 KB，清晰度足以覆盖 10pt 正文与图内小字；PNG 体积约为同档 webp 的 2.7–3.8 倍，仅作回退。
2. **嵌入图提取**：`page.getOperatorList()` + `OPS.paintImageXObject(85)` + `page.objs.get(name)` 路径在 3.11.174 实测可用，可同时拿到原始位图与页面内 bbox（CTM 跟踪），按节归属用「页号 → sectionPages 页范围，页内歧义用 bbox y 坐标对章节标题行 y」两级裁决。局限是**矢量图不进 OperatorList 图像算子**（实测 attention.pdf 第 5–15 页零图像算子，曲线图全是矢量路径），需页内区域渲染兜底；另实测 `page.render()` 会消耗 objs 缓存中的图像对象，提取必须先于渲染。
3. **arXiv HTML**：`figure.ltx_figure > img.ltx_graphics` + `figcaption.ltx_caption` 结构稳定，图片为直链（实测 HTTP 200 且 `access-control-allow-origin: *`）；公式为 `<math alttext="...TeX...">` MathML，alttext 即原始 TeX，可直接接现有 Markdown/MathJax 管线；约 1/5 图是内联 SVG（TikZ 转出的 `ltx_picture`），需序列化后栅格化。HTML 路径天然带章节归属（`<section>` 嵌套），无需坐标反查。

## 路径一：页图导出（canvas → webp/png）

### 现状

`app/ui/js/main.js` `renderPdfPage()`（L1135–1168）已把当前页渲染到 `#pdf-canvas`：`page.getViewport({scale: pdfScale})`，再按 `devicePixelRatio`（封顶 2）放大物理像素，`page.render({canvasContext, viewport, transform})`。导出只需在渲染完成后对同一 canvas 调 `canvas.toBlob(cb, 'image/webp', q)`，或另建离屏 canvas 按导出缩放重渲染（不影响阅读视图）。`prepareRecallImage()`（L775–791）已有 `toBlob('image/webp', 0.86)` + 最长边 1600px 的成熟写法可复用。

### 体积/清晰度实测

612×792pt Letter 页（attention.pdf 文本页 p1、含架构图页 p3、双图页 p4、矢量曲线页 p5），napi-rs/canvas 编码：

| scale | 像素 | PNG | webp q86 | webp q75 | 未压缩 RGBA |
|---|---|---|---|---|---|
| 1.0 | 612×792 | 142–191 KB | 47–63 KB | 38–51 KB | 1.85 MB |
| 1.5 | 918×1188 | 252–331 KB | 81–115 KB | 66–94 KB | 4.16 MB |
| 2.0 | 1224×1584 | 348–476 KB | 128–175 KB | 104–143 KB | 7.40 MB |
| 3.0 | 1836×2376 | 576–748 KB | 215–303 KB | 175–247 KB | 16.64 MB |

清晰度判断：正文 10pt 字在 scale=1.0 下约 13px 字高，视觉模型勉强可读、图内 6–7pt 小字会糊；scale=1.5 起正文清晰；scale=2.0 下图注、坐标轴小字（7pt ≈ 19px）稳定可读；scale=3.0 收益递减（多数视觉模型内部还会重采样到 ~1024–1568px）。webp q86 相对 q75 体积 +25% 左右，文本边缘明显更干净，值得。

**结论**：默认 `scale=2.0 + webp q86`（单页 130–180 KB），对图密集页可升 3.0；PNG 只作编码失败回退。一页 12 页论文按节抽 4–6 页约 0.5–1 MB，可直接进多模态请求。

## 路径二：嵌入图提取（OperatorList 路线）

### API 事实（均经本仓库 vendor 版本实测确认）

- `page.getOperatorList()` 返回 `{fnArray, argsArray}`（官方 API 文档只承诺 PDFOperatorList 类型，内部字段以源码为准）。图像相关算子（3.11.174 实测值，vendor 源码同值）：
  - `OPS.paintImageXObject = 85`（普通嵌入图，参数为对象名如 `img_p2_1`）
  - `OPS.paintInlineImageXObject = 86`（内联图，数据直接在 args）
  - `OPS.paintImageMaskXObject = 83`（1bpp 掩码图，需结合填充色重建）
  - `OPS.paintImageXObjectRepeat = 88`（平铺重复绘制）
  - **`OPS.paintJpegXObject` 在 3.11 已不存在**（`undefined`，vendor 源码零引用）——JPEG 图统一走 85。
- 对象解析：`getOperatorList()` await 返回后依赖对象已就绪，可**同步** `page.objs.get(name)`；跨页共享资源在 `page.commonObjs.get(name)`（官方文档仅列出 commonObjs，page.objs 为源码事实）。返回值形如 `{data: Uint8ClampedArray, width, height, kind}`，`ImageKind = {GRAYSCALE_1BPP:1, RGB_24BPP:2, RGBA_32BPP:3}`。浏览器开启 OffscreenCanvas 时，超过 `MAX_IMAGE_SIZE_TO_CACHE = 1e7`（10 MB）的图会转成 ImageBitmap（`.bitmap` 字段）——消费端要同时兼容 `.data`（putImageData）与 `.bitmap`（drawImage）。
- 坐标：图像绘制在当前变换矩阵（CTM）下的单位正方形。从 `viewport.transform` 出发，顺序应用 `OPS.save/restore/transform(12)` 即可算得页面 CSS 像素系（y 向下）bbox。实测：attention.pdf p3 架构图 `img_p2_1`（1520×2239, kind=3），bbox=(196.6, 72.0) 218.9×322.4 CSS px；按该 bbox 在 scale=3 渲染页上裁剪，得到 657×967 干净架构图（PNG 161 KB / webp86 38 KB），与原文 Figure 1 完全一致。
- **顺序约束（实测坑）**：`page.render()` 之后同一 page 的图像对象会被从 objs 缓存清掉，再 `objs.get(name)` 抛 `Requesting object that isn't resolved yet`。提取必须先于该页任何 render，或用独立 document 实例。
- 解码后体积可能很大（该架构图 RGBA raw 12.98 MB），不能直接把 raw 发给模型，须再编码：原分辨率 PNG 159 KB / webp86 92 KB；按仓库 1600px 约定 webp86 72 KB。

### 局限

- **矢量图不可提取**：矢量绘制的曲线图/TikZ 图在 OperatorList 里是路径算子（constructPath/fill/stroke），不是图像算子。实测 attention.pdf 第 5–15 页图像算子数为 0——英语论文的实验曲线图大多是矢量。兜底方案是「区域渲染」：按图注（`Figure n:` 文本行 y 坐标）或栏宽启发式圈定区域，用路径一的渲染+裁剪出图（已实测可行）。
- 掩码图（83）只有 alpha，颜色来自当前填充色，直接取出的位图不是最终视觉；带 SMask 的图 alpha 通道是独立对象，合成逻辑在 pdf.js 内部，自取数据要处理这一分支。建议这两类直接走区域渲染。
- 装饰性小图（横线、logo、图标）也是图像算子，需按 bbox 面积/宽高比阈值过滤（如面积 < 页面 3% 丢弃）。
- 跨页共享资源（`commonObjs`）与 `paintImageXObjectRepeat` 平铺（88）在论文 PDF 里少见，但实现时要枚举全算子，不能只查 85。

### 按节归属（坐标 → sectionPages）

`parser.js` 产出 `sectionPages: { [sectionId]: {start, end} }`（页号闭区间），且 `splitTextToSections` 的每行带 `page` 与 `y`（注意：**解析管线的 y 是 pdf.js 文本坐标系，y 向上**；OperatorList bbox 的 yTop 是 viewport 系，y 向下，换算 `yTopDown = pageHeight − y_text`）。两级裁决：

1. 页级：图像所在页号落在哪个 sectionPages 区间即归哪节；实测绝大多数论文一页只属于一节正文，已够用。
2. 页内歧义（章节边界页）：图像 bbox 的 yTop 与该页各章节标题行的换算 y 比较，归到「标题行 y ≤ 图像 yTop 的最近标题」。精度受限于标题行粒度，但归属语义正确。

## 路径三：arXiv HTML（LaTeXML）资源形态

以 https://arxiv.org/html/2312.11805（905 KB 真实页）验证：

- 图：`<figure id="S2.F2" class="ltx_figure">` 内 `<img src="2312.11805v5/figs/tech_fig_architecture.png" class="ltx_graphics ltx_img_landscape" width height>` + `<figcaption class="ltx_caption">`（含 `ltx_tag_figure` 的 "Figure 2" 编号）。样本 25 个 figure 中 17 个为 `<img>`（png/jpg/jpeg），3 个为纯内联 SVG（`<svg class="ltx_picture">`，TikZ/pgf 转换产物），其余混合。相对 URL 基于 `https://arxiv.org/html/<id>` 解析；**图片直链实测 HTTP 200 且带 `access-control-allow-origin: *`**，浏览器可直接 fetch。
- 公式：`<math class="ltx_Math" alttext="\cosh{x}+\sinh{y}..." display="inline|block">`——MathML 子树用于渲染，`alttext` 即原始 TeX，可直接进仓库现有 Markdown + MathJax(tex-svg) 管线，无需解析 MathML。
- 章节：`<section>` 嵌套 + `h1–h6`，`parseArxivHtml()` 已在用；图随 section 走，**章节归属天然成立**，无需坐标反查。这也是 HTML 路径相对 PDF 路径的最大优势。
- 集成缺口：现有注入缝 `fetchText`（net.fetch-text@1）只回文本；取图片二进制需要新增桥接（或复用 files.download 类通道），以及 `<img>` 相对 URL 补全。

## 建议

1. **页图导出先行**（风险最低、覆盖面 100%）：在阅读器加 `exportPageImage(pageNum, {scale=2.0, format='webp', quality=0.86})`，复用 `renderPdfPage` 的离屏变体；作为「章节配图」的保底实现。
2. **嵌入图提取作为增强**：`extractEmbeddedImages(doc)` 用 OperatorList + CTM 方案，**先于任何 render 调用**（或独立 doc）；按面积阈值过滤装饰图；归属走「页号 → sectionPages，页内 y 裁决」。对矢量图/掩码图回落到区域渲染（bbox 来自图注行或栏启发式）。浏览器端消费时兼容 `.data` 与 `.bitmap` 两种形态。
3. **arXiv HTML 优先于 PDF 拆图**：来源为 arxiv-html 的论文直接配 `figure.ltx_figure > img` 直链 + figcaption，拿原分辨率且免坐标归属；内联 SVG 图序列化后栅格化或标注跳过；公式用 `math[alttext]` 回灌 TeX。需要为二进制取数加一个桥接缝。
4. 统一出口：无论哪条路径，最终都落成与回想卡片一致的「附件 + webp」形态（`files.putAttachment@1`），模型调用与 UI 展示共用一套读取逻辑。

## 验证脚本与出处

- 提取验证：`node verify-images.mjs attention.pdf`（OperatorList 算子枚举、objs 解析、CTM→bbox）；体积测量：`node measure-render.mjs attention.pdf`（多 scale 渲染 + PNG/webp 编码 + 区域裁剪 + raw 图再编码）。两脚本在 pdfjs-dist 3.11.174（= 仓库 vendor 版本）下实测通过。
- 一手出处：仓库 `app/ui/vendor/pdf.min.js`（版本串 3.11.174、OPS/ImageKind 枚举值、MAX_IMAGE_SIZE_TO_CACHE=1e7）；`app/ui/js/main.js` L1135–1168（渲染管线）、L775–791（webp 压缩先例）；`app/ui/js/parser.js`（sectionPages 与行级 page/y）；官方 API 文档 https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html（getOperatorList/getTextContent/render/commonObjs 签名）；arXiv HTML 实页 https://arxiv.org/html/2312.11805。
