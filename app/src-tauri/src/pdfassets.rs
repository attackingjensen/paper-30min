//! 页图与图表裁切预渲染（Issue #59 / #77，规格 #48 §双通道资产 / #74 B2）。
//!
//! 深挖前备妥视觉资产：页图（每页 scale=2 webp，与块模型 prov 的 pdf.js 视口
//! 坐标逐像素一致）+ 图表裁切图（按映射层换算后 bbox）。产物全部走附件缝落库
//! （sha256 + 原子写 + 元数据事务），落库后逐件 verify 读回校验。
//!
//! `pdfassets.prerender@1` 输入可选 `scope`：`pages`（只渲染页图，不需 Docling
//! 产物、不落块模型）/ `crops`（只渲染裁切图，优先读块模型附件）/ `all`（默认，
//! 行为同 #59）。前端导入后页图与解析并行，解析完成后补渲染裁切图。
//!
//! 附件 ID 约定（"论文+页码→assetId" 由 (paper_id, attachment_id) 主键承载）：
//! - 页图：`pageimg-{NNNN}`（页码零填充 4 位，附件列表字典序即页序）；
//! - 裁切图：`crop-{assetId}`（assetId = fig_3 / tbl_2，编号从图注派生，见 pdfmap）；
//! - 块模型：`blockmodel.json`（pdfmap 输出无损 JSON，#48 决策 5 解析产物入书库；
//!   convert 带 paperId 时立即落库，prerender 重映射覆盖以保持幂等。#55/#76
//!   建图只等块模型，页图/裁切图齐备检查在深挖开工前）。
//!
//! arXiv HTML 来源论文不走进渲染管线（HTML 保真升档另票，#48 §Out of Scope）；
//! 其图直链"用到才下载落附件"由既有 files.download@1 承载（流式 + sha256 +
//! 任务生命周期），本模块不重复实现。
//!
//! 渲染由侧车 `render` 子进程执行（pypdfium2 + Pillow，随包依赖；不需要布局/
//! OCR 模型，门禁只看 deps_ready）。取消 = 终止子进程：渲染阶段产物只落工作
//! 目录，子进程失败/被取消时不落任何附件；落库阶段逐件提交（中断会留下部分
//! 附件），但附件 ID 从内容派生且重跑幂等覆盖，配合深挖 preflight 的齐备性
//! 检查可自愈（#48 §诚实档 16 的"不留半成品"由齐备性门禁兜底）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Instant;

use crate::error::BridgeError;
use crate::files;
use crate::library::Library;
use crate::pdfmap::{BlockKind, MappedPaper};
use crate::pdfparse;
use crate::tasks::{Progress, RunContext, CANCEL_SENTINEL};

pub const TASK_PRERENDER: &str = "pdfassets.prerender@1";

/// 页图附件 ID 前缀（页码零填充 4 位）。
pub const PAGE_ID_PREFIX: &str = "pageimg-";
/// 裁切图附件 ID 前缀。
pub const CROP_ID_PREFIX: &str = "crop-";
/// 块模型 JSON 附件 ID。
pub const BLOCKMODEL_ATTACHMENT_ID: &str = "blockmodel.json";

/// 渲染参数：scale=2（144dpi，与 pdf.js 视口坐标逐像素一致）、webp q86
/// （#39 实测 130–180KB/页，正文与图内小字稳定可读）。
pub const RENDER_SCALE: f64 = 2.0;
pub const WEBP_QUALITY: u32 = 86;

/// 块模型 JSON 经附件缝落库（convert 与 prerender 共用同一 ID 与内容类型，pretty JSON
/// 字节一致，prerender 重映射后覆盖幂等）。
pub(crate) fn persist_block_model(
    library: &Library,
    paper_id: &str,
    mapped: &MappedPaper,
) -> Result<files::AttachmentDto, BridgeError> {
    let bytes = serde_json::to_vec_pretty(mapped)
        .map_err(|err| BridgeError::internal(format!("块模型序列化失败: {err}")))?;
    let dto = library.put_attachment_bytes(
        paper_id,
        BLOCKMODEL_ATTACHMENT_ID,
        BLOCKMODEL_ATTACHMENT_ID,
        "application/json",
        &bytes,
    )?;
    library.verify_attachment(paper_id, &dto.id)?;
    Ok(dto)
}

/// 页图附件 ID：`pageimg-0007`。
pub fn page_attachment_id(page: u32) -> String {
    format!("{PAGE_ID_PREFIX}{page:04}")
}

/// 裁切图附件 ID：`crop-fig_3`。assetId 由 pdfmap 从图注派生（字母数字+下划线），
/// 天然满足附件 ID 的 safe segment 约束。
pub fn crop_attachment_id(asset_id: &str) -> String {
    format!("{CROP_ID_PREFIX}{asset_id}")
}

/// 图像 token 预算估算（#38 实测公式）：32×32 patch 计量，
/// `tokens = round32(w)×round32(h)/1024 + 2`，下限 66（小图放大地板）、
/// 上限 2502（约 256 万像素封顶）。1224×1584（612×792pt @scale=2）= 1902。
pub fn estimate_image_tokens(width: u32, height: u32) -> u64 {
    // round32 = 四舍五入到 32 的倍数后除 32（patch 数）；(v+16)/32 整数除法等价。
    let patch32 = |v: u32| u64::from((v + 16) / 32).max(1);
    let tokens = patch32(width) * patch32(height) + 2;
    tokens.clamp(66, 2502)
}

/// 预渲染范围（#74 B2 / #77）：pages 只渲染页图；crops 只渲染裁切图；all 二者都做。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrerenderScope {
    Pages,
    Crops,
    All,
}

impl PrerenderScope {
    pub fn parse(raw: Option<&str>) -> Result<Self, BridgeError> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("all") => Ok(Self::All),
            Some("pages") => Ok(Self::Pages),
            Some("crops") => Ok(Self::Crops),
            Some(other) => Err(BridgeError::invalid_input(format!(
                "pdfassets.prerender@1 的 scope 须为 pages / crops / all，收到 {other}"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pages => "pages",
            Self::Crops => "crops",
            Self::All => "all",
        }
    }
}

/// 侧车 render 子命令的作业描述（camelCase，与 pdfparse_sidecar.py 对齐）。
/// `pages = None`：序列化为 null，侧车按 PDF 实际页数渲染全部页图（scope=pages）。
/// `pages = Some([])`：不输出页图（scope=crops）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderJob {
    pub scale: f64,
    pub quality: u32,
    /// 待渲染页码（1 起）。None = 由侧车按 PDF 页数展开。
    #[serde(default)]
    pub pages: Option<Vec<u32>>,
    /// 裁切清单：bbox 为 scale=2 视口坐标 [x, y, w, h]（左上原点）。
    pub crops: Vec<RenderJobCrop>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderJobCrop {
    /// 清单 ID（fig_3 / tbl_2），同时是裁切图文件名。
    pub id: String,
    pub page: u32,
    pub bbox: [f64; 4],
}

/// 从映射输出构建渲染作业：页图 = 全部页；裁切 = 图/表清单（清单成员必带
/// bbox，无 bbox 在 pdfmap 阶段已被剔除并记 warning）+ 公式块（#48 决策 13：
/// 公式默认占位 + 裁切图，bbox 缺失者在映射层已记 warning，这里跳过）。
pub fn build_render_job(mapped: &MappedPaper) -> RenderJob {
    let mut crops: Vec<RenderJobCrop> = mapped
        .figures
        .iter()
        .chain(mapped.tables.iter())
        .map(|entry| RenderJobCrop {
            id: entry.id.clone(),
            page: entry.page,
            bbox: entry.bbox,
        })
        .collect();
    // 公式块不进图表清单（无图注编号），裁切 ID 从地址空间派生：
    // fml-{sec_id}-b{块号}（frontmatter 区用 fml-frontmatter-b{块号}）。
    let formula = |sec_id: Option<&str>, block: &crate::pdfmap::Block| {
        Some(RenderJobCrop {
            id: formula_crop_id(sec_id, block.id),
            page: block.page,
            bbox: block.bbox?,
        })
    };
    crops.extend(
        mapped
            .frontmatter
            .iter()
            .filter(|b| b.kind == BlockKind::Formula)
            .filter_map(|b| formula(None, b)),
    );
    crops.extend(mapped.sections.iter().flat_map(|section| {
        section
            .blocks
            .iter()
            .filter(|b| b.kind == BlockKind::Formula)
            .filter_map(|b| formula(Some(&section.id), b))
    }));
    RenderJob {
        scale: RENDER_SCALE,
        quality: WEBP_QUALITY,
        pages: Some((1..=mapped.page_count).collect()),
        crops,
    }
}

/// 只渲染页图：pages=null，侧车按 PDF 实际页数展开；crops 为空。
pub fn pages_only_job() -> RenderJob {
    RenderJob {
        scale: RENDER_SCALE,
        quality: WEBP_QUALITY,
        pages: None,
        crops: Vec::new(),
    }
}

/// 只渲染裁切图：pages 为空数组（侧车不落页图），crops 来自块模型。
pub fn crops_only_job(mapped: &MappedPaper) -> RenderJob {
    let mut job = build_render_job(mapped);
    job.pages = Some(Vec::new());
    job
}

/// 公式裁切的清单内 ID（非附件 ID；附件 ID 由 crop_attachment_id 再加前缀）：
/// `fml-sec_1_introduction-b5` / frontmatter 区 `fml-frontmatter-b2`。
/// 公式无图注编号可派生，用地址空间（节 ID + 块号）保证稳定与唯一。
pub fn formula_crop_id(sec_id: Option<&str>, block_id: u32) -> String {
    format!("fml-{}-b{block_id}", sec_id.unwrap_or("frontmatter"))
}

// ============================================================================
// 任务体：pdfassets.prerender@1
// ============================================================================

/// 侧车 render 结果中的单件产物。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderedItem {
    #[serde(default)]
    page: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    path: String,
    width: u32,
    height: u32,
    bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderPayload {
    #[serde(default)]
    pages: Vec<RenderedItem>,
    #[serde(default)]
    crops: Vec<RenderedItem>,
    #[serde(default)]
    skipped_crops: Vec<Value>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    render_ms: Option<u64>,
    #[serde(default)]
    encode_ms: Option<u64>,
}

/// pdfassets.prerender@1：按 scope 渲染页图和/或裁切图。
/// 输入: { paperId, scope?, doclingJsonPath?, pdfPath? }
/// （scope 默认 all；all/crops 需要 doclingJsonPath；pdfPath 缺省 = 论文的 pdf 附件）。
/// 结果: { paperId, scope, pageAssets[], crops[], skippedCrops[], warnings[],
///         blockModelAssetId?, elapsedMs, renderMs, encodeMs }
/// 不做自动重试（与 convert 一致：渲染失败由用户显式重试）。
pub(crate) fn run_prerender(
    ctx: &RunContext,
    paper_id: &str,
    docling_json_path: Option<&Path>,
    pdf_path: Option<&Path>,
    scope: PrerenderScope,
) {
    match prerender_once(ctx, paper_id, docling_json_path, pdf_path, scope) {
        Ok(()) => {}
        Err(error) if error.code == CANCEL_SENTINEL => ctx.cancel_now(),
        Err(error) => ctx.fail(error),
    }
}

fn prerender_once(
    ctx: &RunContext,
    paper_id: &str,
    docling_json_path: Option<&Path>,
    pdf_path: Option<&Path>,
    scope: PrerenderScope,
) -> Result<(), BridgeError> {
    let started = Instant::now();
    ctx.cancel_checkpoint()?;
    files::require_safe_segment(paper_id, "paperId")?;
    {
        let conn = ctx.library.lock_conn()?;
        if !Library::paper_exists(&conn, paper_id)? {
            return Err(BridgeError::paper_not_found(paper_id));
        }
    }

    let mapped = resolve_mapped(&ctx.library, paper_id, docling_json_path, scope)?;
    let job = match scope {
        PrerenderScope::Pages => pages_only_job(),
        PrerenderScope::Crops => {
            let mapped = mapped.as_ref().ok_or_else(|| {
                BridgeError::invalid_input("pdfassets.prerender@1 的 scope=crops 需要块模型")
            })?;
            crops_only_job(mapped)
        }
        PrerenderScope::All => {
            let mapped = mapped.as_ref().ok_or_else(|| {
                BridgeError::invalid_input("pdfassets.prerender@1 的 scope=all 需要块模型")
            })?;
            build_render_job(mapped)
        }
    };

    // PDF 路径：显式参数优先，缺省取论文的 pdf 附件。
    let default_pdf;
    let pdf_path = match pdf_path {
        Some(path) => path,
        None => {
            default_pdf = files::attachment_path(ctx.library.root(), paper_id, "pdf")?;
            &default_pdf
        }
    };
    if !pdf_path.is_file() {
        return Err(BridgeError::new(
            "pdf_not_found",
            format!("PDF 文件不存在: {}", pdf_path.display()),
            false,
        ));
    }

    let layout = pdfparse::require_sidecar(ctx)?;
    if !pdfparse::deps_ready(&layout.root) {
        return Err(BridgeError::new(
            "bootstrap_required",
            "侧车依赖未安装：请先运行 pdfparse.bootstrap@1（首启下载案）",
            false,
        ));
    }

    let out_dir = ctx.library.root().join("pdfassets").join(&ctx.task_id);
    std::fs::create_dir_all(&out_dir)
        .map_err(|err| BridgeError::internal(format!("渲染工作目录创建失败: {err}")))?;
    let job_path = out_dir.join("job.json");
    let job_json = serde_json::to_vec(&job)
        .map_err(|err| BridgeError::internal(format!("渲染作业序列化失败: {err}")))?;
    std::fs::write(&job_path, &job_json)
        .map_err(|err| BridgeError::internal(format!("渲染作业写入失败: {err}")))?;

    let mut command = pdfparse::base_command(&layout, None);
    command
        .arg("--models-dir")
        .arg(&layout.models_dir)
        .arg("render")
        .arg("--pdf")
        .arg(pdf_path)
        .arg("--out-dir")
        .arg(&out_dir)
        .arg("--job")
        .arg(&job_path);
    let mut harness = pdfparse::spawn_child(command)?;
    let exit_code = pdfparse::wait_child(ctx, &mut harness)?;

    let result = pdfparse::read_sidecar_result(&out_dir, &harness);
    let result = match result {
        Some(result) if result.ok => result,
        Some(result) => return Err(pdfparse::map_failure(&result, &harness)),
        None => return Err(pdfparse::crashed_error(exit_code, &harness)),
    };
    ctx.cancel_checkpoint()?;
    let payload: RenderPayload = serde_json::from_value(result.payload).map_err(|err| {
        BridgeError::new(
            "sidecar_result_invalid",
            format!("渲染结果形状不符: {err}"),
            true,
        )
    })?;

    // 渲染全部成功后才进入落库阶段（渲染阶段取消/失败不落任何附件）；
    // 落库逐件提交，中断留下的部分附件由重跑幂等覆盖 + 深挖 preflight 齐备性兜底。
    let blockmodel_id = if let Some(mapped) = mapped.as_ref() {
        if scope != PrerenderScope::Pages {
            Some(persist_block_model(&ctx.library, paper_id, mapped)?.id)
        } else {
            None
        }
    } else {
        None
    };

    let mut page_assets = Vec::with_capacity(payload.pages.len());
    let total = (payload.pages.len() + payload.crops.len()) as u64;
    for (index, item) in payload.pages.iter().enumerate() {
        ctx.cancel_checkpoint()?;
        let page = item.page.ok_or_else(|| {
            BridgeError::new("sidecar_result_invalid", "页图产物缺少 page 字段", true)
        })?;
        let asset_id = page_attachment_id(page);
        let dto = ingest_rendered(
            &ctx.library,
            paper_id,
            &asset_id,
            &format!("{asset_id}.webp"),
            item,
        )?;
        ctx.push_progress(Progress {
            done: index as u64 + 1,
            total,
        });
        page_assets.push(json!({
            "page": page,
            "assetId": dto.id,
            "width": item.width,
            "height": item.height,
            "bytes": dto.size,
            "sha256": dto.sha256,
            "estimatedTokens": estimate_image_tokens(item.width, item.height),
        }));
    }

    let mut crops = Vec::with_capacity(payload.crops.len());
    for (index, item) in payload.crops.iter().enumerate() {
        ctx.cancel_checkpoint()?;
        let id = item.id.clone().ok_or_else(|| {
            BridgeError::new("sidecar_result_invalid", "裁切产物缺少 id 字段", true)
        })?;
        let asset_id = crop_attachment_id(&id);
        let dto = ingest_rendered(
            &ctx.library,
            paper_id,
            &asset_id,
            &format!("{asset_id}.webp"),
            item,
        )?;
        ctx.push_progress(Progress {
            done: payload.pages.len() as u64 + index as u64 + 1,
            total,
        });
        crops.push(json!({
            "id": id,
            "assetId": dto.id,
            "page": item.page,
            "width": item.width,
            "height": item.height,
            "bytes": dto.size,
            "sha256": dto.sha256,
        }));
    }

    // 渲染输出已入附件库，清掉工作目录里的 webp 双份（保留 job/result 供诊断）。
    let _ = std::fs::remove_dir_all(out_dir.join("pages"));
    let _ = std::fs::remove_dir_all(out_dir.join("crops"));

    let mut warnings: Vec<String> = mapped
        .as_ref()
        .map(|mapped| mapped.warnings.clone())
        .unwrap_or_default();
    warnings.extend(payload.warnings);
    let mut result = json!({
        "paperId": paper_id,
        "scope": scope.as_str(),
        "pages": page_assets.len(),
        "pageAssets": page_assets,
        "crops": crops,
        "skippedCrops": payload.skipped_crops,
        "warnings": warnings,
        "elapsedMs": started.elapsed().as_millis() as u64,
        "renderMs": payload.render_ms.unwrap_or(0),
        "encodeMs": payload.encode_ms.unwrap_or(0),
    });
    if let Some(id) = blockmodel_id {
        result["blockModelAssetId"] = json!(id);
    }
    ctx.succeed(Some(result));
    Ok(())
}

/// 按 scope 解析块模型：pages 不需要；crops 先读附件、缺失则重映射 docling；all 始终重映射。
fn resolve_mapped(
    library: &Library,
    paper_id: &str,
    docling_json_path: Option<&Path>,
    scope: PrerenderScope,
) -> Result<Option<MappedPaper>, BridgeError> {
    match scope {
        PrerenderScope::Pages => Ok(None),
        PrerenderScope::Crops => {
            if let Some(mapped) = read_block_model_attachment(library, paper_id)? {
                return Ok(Some(mapped));
            }
            let path = docling_json_path.ok_or_else(|| {
                BridgeError::invalid_input(
                    "pdfassets.prerender@1 的 scope=crops 需要 doclingJsonPath 或已有块模型附件",
                )
            })?;
            Ok(Some(crate::pdfmap::map_docling_json_file(path)?))
        }
        PrerenderScope::All => {
            let path = docling_json_path.ok_or_else(|| {
                BridgeError::invalid_input(
                    "pdfassets.prerender@1 的 scope=all 需要 doclingJsonPath",
                )
            })?;
            Ok(Some(crate::pdfmap::map_docling_json_file(path)?))
        }
    }
}

fn read_block_model_attachment(
    library: &Library,
    paper_id: &str,
) -> Result<Option<MappedPaper>, BridgeError> {
    let Ok(attachment) = library.get_attachment(paper_id, BLOCKMODEL_ATTACHMENT_ID) else {
        return Ok(None);
    };
    let (_, bytes) = library.read_range(
        paper_id,
        BLOCKMODEL_ATTACHMENT_ID,
        0,
        attachment.size as u64,
    )?;
    let mapped = serde_json::from_slice(&bytes).map_err(|err| {
        BridgeError::new(
            "block_model_invalid",
            format!("块模型附件无法解析: {err}"),
            false,
        )
    })?;
    Ok(Some(mapped))
}

/// 单件渲染产物落附件缝并立即 verify（读回 sha256 比对，验收"verify 缝通过"）。
fn ingest_rendered(
    library: &Library,
    paper_id: &str,
    asset_id: &str,
    name: &str,
    item: &RenderedItem,
) -> Result<files::AttachmentDto, BridgeError> {
    let bytes = std::fs::read(&item.path)
        .map_err(|err| BridgeError::internal(format!("渲染产物读取失败 {}: {err}", item.path)))?;
    if bytes.len() as u64 != item.bytes {
        return Err(BridgeError::new(
            "sidecar_result_invalid",
            format!(
                "渲染产物字节数不符 {}: 记录 {} 实际 {}",
                item.path,
                item.bytes,
                bytes.len()
            ),
            true,
        ));
    }
    let dto = library.put_attachment_bytes(paper_id, asset_id, name, "image/webp", &bytes)?;
    library.verify_attachment(paper_id, &dto.id)?;
    Ok(dto)
}

// ============================================================================
// 单元测试（纯函数：ID 约定、token 预算、渲染作业构建）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdfmap::{AssetEntry, MappedPaper};

    #[test]
    fn prerender_scope_parses_pages_crops_all_and_rejects_unknown() {
        assert_eq!(PrerenderScope::parse(None).unwrap(), PrerenderScope::All);
        assert_eq!(
            PrerenderScope::parse(Some("all")).unwrap(),
            PrerenderScope::All
        );
        assert_eq!(
            PrerenderScope::parse(Some("pages")).unwrap(),
            PrerenderScope::Pages
        );
        assert_eq!(
            PrerenderScope::parse(Some("crops")).unwrap(),
            PrerenderScope::Crops
        );
        let err = PrerenderScope::parse(Some("both")).unwrap_err();
        assert_eq!(err.code, "invalid_input");
    }

    #[test]
    fn page_attachment_id_zero_pads_for_lexical_order() {
        assert_eq!(page_attachment_id(1), "pageimg-0001");
        assert_eq!(page_attachment_id(7), "pageimg-0007");
        assert_eq!(page_attachment_id(123), "pageimg-0123");
        // 零填充保证附件列表字典序 = 页序。
        assert!(page_attachment_id(2) < page_attachment_id(10));
    }

    #[test]
    fn crop_attachment_id_prefixes_asset_id() {
        assert_eq!(crop_attachment_id("fig_3"), "crop-fig_3");
        assert_eq!(crop_attachment_id("tbl_12"), "crop-tbl_12");
    }

    #[test]
    fn attachment_ids_are_safe_segments() {
        for id in [
            page_attachment_id(1),
            crop_attachment_id("fig_3"),
            crop_attachment_id("tbl_A2"),
            BLOCKMODEL_ATTACHMENT_ID.to_string(),
        ] {
            files::require_safe_segment(&id, "test").unwrap_or_else(|err| {
                panic!("附件 ID {id} 应满足 safe segment: {err}");
            });
        }
    }

    #[test]
    fn estimate_image_tokens_matches_measured_budget() {
        // #38 实测：612×792pt @scale=2（1224×1584）= 1902 token/页。
        assert_eq!(estimate_image_tokens(1224, 1584), 1902);
        // 下限 66：小图被放大（约 6.5 万像素地板）。
        assert_eq!(estimate_image_tokens(64, 64), 66);
        assert_eq!(estimate_image_tokens(256, 256), 66);
        // 上限 2502：约 256 万像素封顶。
        assert_eq!(estimate_image_tokens(4096, 4096), 2502);
        // A4 @scale=2（595.28×841.89pt → 1191×1684）在预算带内。
        let a4 = estimate_image_tokens(1191, 1684);
        assert!((1800..=2100).contains(&a4), "A4 页图 token 估算异常: {a4}");
    }

    fn asset(id: &str, page: u32) -> AssetEntry {
        AssetEntry {
            id: id.to_string(),
            number: id[4..].to_string(),
            caption: None,
            page,
            bbox: [200.0, 384.0, 800.0, 400.0],
            section: None,
            references: Vec::new(),
        }
    }

    #[test]
    fn build_render_job_covers_all_pages_and_manifest_crops() {
        let mapped = MappedPaper {
            schema_version: 1,
            title: None,
            source_name: None,
            page_count: 3,
            sections: Vec::new(),
            frontmatter: Vec::new(),
            furniture: Vec::new(),
            figures: vec![asset("fig_1", 1), asset("fig_3", 2)],
            tables: vec![asset("tbl_2", 3)],
            references: Vec::new(),
            warnings: Vec::new(),
        };
        let job = build_render_job(&mapped);
        assert_eq!(job.scale, RENDER_SCALE);
        assert_eq!(job.quality, WEBP_QUALITY);
        assert_eq!(job.pages, Some(vec![1, 2, 3]));
        let crop_ids: Vec<&str> = job.crops.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(crop_ids, vec!["fig_1", "fig_3", "tbl_2"]);
        assert_eq!(job.crops[0].page, 1);
        assert_eq!(job.crops[0].bbox, [200.0, 384.0, 800.0, 400.0]);
    }

    #[test]
    fn pages_only_job_sends_null_pages_and_has_no_crops() {
        let job = pages_only_job();
        assert!(job.crops.is_empty());
        assert_eq!(job.pages, None);
        let value = serde_json::to_value(&job).unwrap();
        assert!(
            value["pages"].is_null(),
            "pages=null 让侧车按 PDF 实际页数渲染"
        );
        assert_eq!(value["crops"], json!([]));
    }

    #[test]
    fn crops_only_job_sends_empty_pages_array() {
        let mapped = MappedPaper {
            schema_version: 1,
            title: None,
            source_name: None,
            page_count: 3,
            sections: Vec::new(),
            frontmatter: Vec::new(),
            furniture: Vec::new(),
            figures: vec![asset("fig_1", 1)],
            tables: Vec::new(),
            references: Vec::new(),
            warnings: Vec::new(),
        };
        let job = crops_only_job(&mapped);
        assert_eq!(job.pages, Some(vec![]));
        let crop_ids: Vec<&str> = job.crops.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(crop_ids, vec!["fig_1"]);
        let value = serde_json::to_value(&job).unwrap();
        assert_eq!(value["pages"], json!([]));
    }

    fn formula_block(id: u32, page: u32, bbox: Option<[f64; 4]>) -> crate::pdfmap::Block {
        crate::pdfmap::Block {
            id,
            kind: BlockKind::Formula,
            text: "[公式]".to_string(),
            page,
            y: 0.0,
            bbox,
            level: None,
            asset_id: None,
            caption: None,
            latex: None,
        }
    }

    #[test]
    fn build_render_job_includes_formula_crops_with_address_derived_ids() {
        // #48 决策 13：公式默认占位 + 裁切图；无 bbox 的公式跳过（映射层已记 warning）。
        let mut section = crate::pdfmap::Section {
            id: "sec_1_introduction".to_string(),
            ordinal: 1,
            title: "Introduction".to_string(),
            number: Some("1".to_string()),
            role: crate::pdfmap::SectionRole::Body,
            page_start: 1,
            page_end: 1,
            blocks: vec![
                formula_block(3, 1, Some([10.0, 20.0, 300.0, 40.0])),
                formula_block(4, 1, None),
            ],
            subsections: Vec::new(),
        };
        section.blocks[0].kind = BlockKind::Formula;
        let mapped = MappedPaper {
            schema_version: 1,
            title: None,
            source_name: None,
            page_count: 1,
            sections: vec![section],
            frontmatter: vec![formula_block(1, 1, Some([5.0, 6.0, 100.0, 30.0]))],
            furniture: Vec::new(),
            figures: Vec::new(),
            tables: Vec::new(),
            references: Vec::new(),
            warnings: Vec::new(),
        };
        let job = build_render_job(&mapped);
        let crop_ids: Vec<&str> = job.crops.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            crop_ids,
            vec!["fml-frontmatter-b1", "fml-sec_1_introduction-b3"],
            "公式裁切按地址派生 ID，无 bbox 者跳过"
        );
        assert_eq!(job.crops[1].bbox, [10.0, 20.0, 300.0, 40.0]);
        // 公式裁切附件 ID 也满足 safe segment。
        files::require_safe_segment(&crop_attachment_id(crop_ids[1]), "test").unwrap();
    }

    #[test]
    fn render_job_serializes_camel_case() {
        let job = RenderJob {
            scale: RENDER_SCALE,
            quality: WEBP_QUALITY,
            pages: Some(vec![1]),
            crops: vec![RenderJobCrop {
                id: "fig_1".to_string(),
                page: 1,
                bbox: [1.0, 2.0, 3.0, 4.0],
            }],
        };
        let value = serde_json::to_value(&job).unwrap();
        assert_eq!(value["scale"], json!(2.0));
        assert_eq!(value["quality"], json!(86));
        assert_eq!(value["crops"][0]["bbox"], json!([1.0, 2.0, 3.0, 4.0]));
    }
}
