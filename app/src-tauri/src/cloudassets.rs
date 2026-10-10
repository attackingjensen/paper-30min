//! Offline PDF.js uploads are native-owned staged resources, sealed only as a new batch.
use crate::{
    error::BridgeError,
    files,
    library::Library,
    parsebatch::ParseBatchSnapshot,
    pdfmap::{BlockKind, MappedPaper},
    tasks::{Progress, RunContext, TaskRegistry},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_IMAGE: usize = 8 * 1024 * 1024;
const MAX_BATCH: u64 = 512 * 1024 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug)]
pub(crate) struct CloudAssetsPlan {
    pub(crate) paper_id: String,
    snapshot: ParseBatchSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualResource {
    pub attachment_id: String,
    pub page: u32,
    pub evidence: String,
    pub bbox: Option<[f64; 4]>,
    pub page_size: [f64; 2],
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualAsset {
    pub id: String,
    pub sec_id: String,
    pub block_id: u32,
    pub kind: String,
    pub resources: Vec<VisualResource>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualAssets {
    pub schema_version: u32,
    pub batch_id: String,
    pub pdf_sha256: String,
    pub block_model_sha256: String,
    pub pages: Vec<VisualResource>,
    pub assets: Vec<VisualAsset>,
}

pub fn output_batch_id(parent: &str) -> String {
    format!(
        "visual-{}",
        files::sha256_hex(format!("cloudassets@1:{parent}").as_bytes())
    )
}
fn invalid(message: &str) -> BridgeError {
    BridgeError::invalid_input(message)
}
fn io_error(_: std::io::Error) -> BridgeError {
    BridgeError::internal("Visual staging I/O failed")
}
fn required<'a>(input: &'a Value, name: &str) -> Result<&'a str, BridgeError> {
    input[name]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("Missing visual task field"))
}

pub(crate) fn prepare(library: &Library, input: &Value) -> Result<CloudAssetsPlan, BridgeError> {
    let paper_id = required(input, "paperId")?;
    let snapshot = library.pin_parse_batch(paper_id, Some(required(input, "batchId")?))?;
    if snapshot.manifest.provider != "baidu" {
        return Err(invalid("Visual preparation requires a Baidu candidate"));
    }
    if snapshot
        .manifest
        .attachments
        .contains_key("visual-assets.json")
    {
        return Err(invalid("Candidate already contains visual assets"));
    }
    Ok(CloudAssetsPlan {
        paper_id: paper_id.into(),
        snapshot,
    })
}

fn dimensions(w: f64, h: f64) -> (u32, u32) {
    let scale = 2.0f64.min(1600.0 / w.max(h));
    (
        ((w * scale).ceil() as u32).min(1600),
        ((h * scale).ceil() as u32).min(1600),
    )
}
fn derive(
    library: &Library,
    snapshot: &ParseBatchSnapshot,
    mapped: &MappedPaper,
) -> Result<VisualAssets, BridgeError> {
    let m = &snapshot.manifest;
    let model_hash = &m
        .attachments
        .get("blockmodel.json")
        .ok_or_else(|| invalid("Missing model"))?
        .sha256;
    let source = crate::pdfmap_evidence::get_batch_source_regions(
        library,
        &m.paper_id,
        &m.batch_id,
        model_hash,
    )?;
    let (_, pdf) = library.read_parse_batch_attachment(snapshot, "pdf")?;
    let identity = crate::pdf_identity::read_pdf_identity_bytes(&pdf)?;
    let mut pages = Vec::new();
    for page in &identity.pages {
        let (width, height) = dimensions(page.width, page.height);
        pages.push(VisualResource {
            attachment_id: crate::pdfassets::page_attachment_id(page.page_no),
            page: page.page_no,
            evidence: "page".into(),
            bbox: None,
            page_size: [page.width, page.height],
            width,
            height,
        });
    }
    let mut assets = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for section in &mapped.sections {
        for block in &section.blocks {
            let kind = match block.kind {
                BlockKind::Figure => "figure",
                BlockKind::Table => "table",
                BlockKind::Formula => "formula",
                _ => continue,
            };
            let id = block
                .asset_id
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    if kind == "formula" {
                        crate::pdfassets::formula_crop_id(Some(&section.id), block.id)
                    } else {
                        format!(
                            "visual-{}",
                            files::sha256_hex(format!("{}:{}", section.id, block.id).as_bytes())
                        )
                    }
                });
            files::require_safe_segment(&id, "assetId")?;
            if !ids.insert(id.clone()) {
                return Err(invalid("Duplicate visual asset ID"));
            }
            let entry = source["blocks"]
                .as_array()
                .and_then(|v| {
                    v.iter()
                        .find(|v| v["secId"] == section.id && v["blockId"] == block.id)
                })
                .ok_or_else(|| invalid("Missing visual source"))?;
            let resources = if block.source_regions.is_empty() {
                let related = entry["pages"]
                    .as_array()
                    .ok_or_else(|| invalid("Missing visual page evidence"))?;
                if related.is_empty() {
                    return Err(invalid("Visual asset has no page evidence"));
                }
                let mut unique = std::collections::BTreeSet::new();
                let mut resources = Vec::new();
                let mut previous = 0;
                for page in related {
                    let page = page
                        .as_u64()
                        .and_then(|p| u32::try_from(p).ok())
                        .ok_or_else(|| invalid("Invalid visual page"))?;
                    if page <= previous {
                        return Err(invalid("Visual page evidence must be unique and ordered"));
                    }
                    previous = page;
                    if unique.insert(page) {
                        resources.push(
                            pages
                                .iter()
                                .find(|p| p.page == page)
                                .ok_or_else(|| invalid("Invalid visual page"))?
                                .clone(),
                        );
                    }
                }
                if !unique.contains(&block.page) {
                    return Err(invalid("Visual page evidence does not include block page"));
                }
                resources
            } else {
                block
                    .source_regions
                    .iter()
                    .enumerate()
                    .map(|(index, r)| {
                        let (width, height) = dimensions(r.bbox[2] / 2.0, r.bbox[3] / 2.0);
                        VisualResource {
                            attachment_id: format!("crop-{id}-r{}", index + 1),
                            page: r.page,
                            evidence: "region".into(),
                            bbox: Some(r.bbox),
                            page_size: r.page_size,
                            width,
                            height,
                        }
                    })
                    .collect()
            };
            assets.push(VisualAsset {
                id,
                sec_id: section.id.clone(),
                block_id: block.id,
                kind: kind.into(),
                resources,
            });
        }
    }
    Ok(VisualAssets {
        schema_version: 1,
        batch_id: m.batch_id.clone(),
        pdf_sha256: m.pdf_sha256.clone(),
        block_model_sha256: model_hash.clone(),
        pages,
        assets,
    })
}

fn resources(assets: &VisualAssets) -> Result<BTreeMap<String, VisualResource>, BridgeError> {
    let mut result = BTreeMap::new();
    for r in assets
        .pages
        .iter()
        .chain(assets.assets.iter().flat_map(|a| a.resources.iter()))
    {
        files::require_safe_segment(&r.attachment_id, "visualAttachmentId")?;
        if let Some(old) = result.insert(r.attachment_id.clone(), r.clone()) {
            if old != *r {
                return Err(invalid("Conflicting visual resource"));
            }
        }
    }
    if result.len() > 9996 {
        return Err(invalid("Too many visual resources"));
    }
    Ok(result)
}

/// Fully decode a bounded PNG; metadata alone cannot prove uploaded pixels are valid.
pub fn validate_png(bytes: &[u8], width: u32, height: u32) -> Result<(), BridgeError> {
    if bytes.len() > MAX_IMAGE || width == 0 || height == 0 || width > 1600 || height > 1600 {
        return Err(invalid("Visual image exceeds limits"));
    }
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 32 * 1024 * 1024,
    });
    let mut reader = decoder.read_info().map_err(|_| invalid("Invalid PNG"))?;
    let info = reader.info();
    if info.width != width || info.height != height || info.animation_control.is_some() {
        return Err(invalid("Visual PNG dimensions do not match plan"));
    }
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| invalid("PNG exceeds decoder limits"))?;
    if size > 32 * 1024 * 1024 {
        return Err(invalid("PNG exceeds decoder limits"));
    }
    let mut decoded = vec![0; size];
    reader
        .next_frame(&mut decoded)
        .map_err(|_| invalid("Invalid PNG pixels"))?;
    reader.finish().map_err(|_| invalid("Incomplete PNG"))?;
    Ok(())
}

pub fn read_visual_assets(
    library: &Library,
    snapshot: &ParseBatchSnapshot,
    mapped: &MappedPaper,
) -> Result<VisualAssets, BridgeError> {
    let expected = derive(library, snapshot, mapped)?;
    let missing: Vec<_> = std::iter::once("visual-assets.json".to_string())
        .chain(resources(&expected)?.into_keys())
        .filter(|id| !snapshot.manifest.attachments.contains_key(id))
        .collect();
    if !missing.is_empty() {
        return Err(
            BridgeError::new("preflight_missing", "Visual evidence is incomplete", false)
                .with_details(json!({"missing":missing})),
        );
    }
    let (_, bytes) = library.read_parse_batch_attachment(snapshot, "visual-assets.json")?;
    let assets: VisualAssets =
        serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid visual manifest"))?;
    let (_, model) = library.read_parse_batch_attachment(snapshot, "blockmodel.json")?;
    let saved: MappedPaper =
        serde_json::from_slice(&model).map_err(|_| invalid("Invalid visual model"))?;
    if serde_json::to_value(&saved).map_err(|_| invalid("Invalid model"))?
        != serde_json::to_value(mapped).map_err(|_| invalid("Invalid model"))?
    {
        return Err(invalid("Visual model mismatch"));
    }
    if assets != expected {
        return Err(invalid("Visual manifest provenance mismatch"));
    }
    for r in resources(&assets)?.values() {
        let (meta, image) = library.read_parse_batch_attachment(snapshot, &r.attachment_id)?;
        if meta.content_type != "image/png" {
            return Err(invalid("Visual resource is not PNG"));
        }
        validate_png(&image, r.width, r.height)?;
    }
    Ok(assets)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Completed {
    sha256: String,
    size: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    snapshot: ParseBatchSnapshot,
    output_batch_id: String,
    completed: BTreeMap<String, Completed>,
}
struct Stage {
    owner: usize,
    active: bool,
    dir: PathBuf,
    snapshot: ParseBatchSnapshot,
    assets: VisualAssets,
    resources: BTreeMap<String, VisualResource>,
    completed: BTreeMap<String, Completed>,
    last_change: Instant,
    sealed: Option<ParseBatchSnapshot>,
}
type Stages = Mutex<HashMap<(usize, String), Arc<Mutex<Stage>>>>;
static STAGES: OnceLock<Stages> = OnceLock::new();
fn stages() -> &'static Stages {
    STAGES.get_or_init(|| Mutex::new(HashMap::new()))
}
fn owner(registry: &Arc<TaskRegistry>) -> usize {
    Arc::as_ptr(registry) as usize
}
fn lookup(registry: &Arc<TaskRegistry>, input: &Value) -> Result<Arc<Mutex<Stage>>, BridgeError> {
    let task = required(input, "taskId")?;
    let snap = registry
        .get(task)
        .ok_or_else(|| BridgeError::new("not_found", "Visual task not found", false))?;
    if snap.kind != "cloudassets.prepare@1" {
        return Err(invalid("Wrong visual task kind"));
    }
    stages()
        .lock()
        .map_err(|_| invalid("Visual state unavailable"))?
        .get(&(owner(registry), task.to_string()))
        .cloned()
        .ok_or_else(|| BridgeError::new("visual_preparing", "Visual task is initializing", true))
}
pub(crate) fn plan(registry: &Arc<TaskRegistry>, input: &Value) -> Result<Value, BridgeError> {
    if let Some(task) = registry.get(required(input, "taskId")?) {
        if task.kind == "cloudassets.prepare@1" && task.status.is_terminal() {
            if let Some(result) = task.result {
                return Ok(
                    json!({"schemaVersion":1,"state":"succeeded","outputBatchId":result["batchId"],"outputSnapshot":result["snapshot"],"visualReady":true}),
                );
            }
            return Err(task
                .error
                .unwrap_or_else(|| invalid("Visual task has stopped")));
        }
    }
    let stage = match lookup(registry, input) {
        Err(e) if e.code == "visual_preparing" => {
            return Ok(json!({"schemaVersion":1,"state":"preparing"}))
        }
        other => other?,
    };
    let stage = stage
        .lock()
        .map_err(|_| invalid("Visual state unavailable"))?;
    if stage.owner != owner(registry) {
        return Err(invalid("Visual task identity mismatch"));
    }
    Ok(
        json!({"schemaVersion":1,"state":if stage.sealed.is_some(){"succeeded"}else{"ready"},
        "snapshot":stage.snapshot,"outputBatchId":stage.assets.batch_id,
        "resources":stage.resources.values().collect::<Vec<_>>(),"completedAttachmentIds":stage.completed.keys().collect::<Vec<_>>(),
        "visualReady":stage.sealed.is_some(),"outputSnapshot":stage.sealed}),
    )
}
fn safe(root: &Path, path: &Path) -> Result<(), BridgeError> {
    if !crate::pdfmap_evidence::safe_path(root, path) {
        return Err(invalid("Unsafe visual staging path"));
    }
    Ok(())
}
fn save(root: &Path, stage: &Stage) -> Result<(), BridgeError> {
    let record = Record {
        snapshot: stage.snapshot.clone(),
        output_batch_id: stage.assets.batch_id.clone(),
        completed: stage.completed.clone(),
    };
    write_atomic(
        root,
        &stage.dir.join("run.json"),
        &serde_json::to_vec(&record).map_err(|_| invalid("Invalid visual record"))?,
    )
}
fn write_atomic(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), BridgeError> {
    let part = path.with_extension("part");
    safe(
        root,
        path.parent()
            .ok_or_else(|| invalid("Invalid staging path"))?,
    )?;
    if path.exists() {
        safe(root, path)?;
    }
    if part.exists() {
        safe(root, &part)?;
    }
    let mut file = fs::File::create(&part).map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    fs::rename(part, path).map_err(io_error)
}
pub(crate) fn put(
    registry: &Arc<TaskRegistry>,
    library: &Library,
    input: &Value,
) -> Result<Value, BridgeError> {
    let task = required(input, "taskId")?;
    let stage = lookup(registry, input)?;
    let mut stage = stage
        .lock()
        .map_err(|_| invalid("Visual state unavailable"))?;
    if stage.owner != owner(registry)
        || !stage.active
        || registry.get(task).is_none_or(|s| s.status.is_terminal())
        || registry.cancel_requested(task)
    {
        return Err(invalid("Visual task no longer accepts resources"));
    }
    let id = required(input, "attachmentId")?;
    let r = stage
        .resources
        .get(id)
        .ok_or_else(|| invalid("Unexpected visual attachment"))?;
    let encoded = required(input, "contentBase64")?;
    if encoded.len() > MAX_IMAGE.div_ceil(3) * 4 {
        return Err(invalid("Visual image exceeds limits"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| invalid("Invalid visual base64"))?;
    validate_png(&bytes, r.width, r.height)?;
    let complete = Completed {
        sha256: files::sha256_hex(&bytes),
        size: bytes.len() as u64,
    };
    if let Some(old) = stage.completed.get(id) {
        if old.sha256 != complete.sha256 {
            return Err(invalid("Visual resource already staged"));
        }
        return Ok(json!({"schemaVersion":1,"stored":true}));
    }
    let base = stage
        .snapshot
        .manifest
        .attachments
        .values()
        .map(|a| a.size)
        .sum::<u64>();
    if base + stage.completed.values().map(|a| a.size).sum::<u64>() + complete.size
        > MAX_BATCH - 1024 * 1024
    {
        return Err(invalid("Visual batch exceeds size limit"));
    }
    if registry.cancel_requested(task) {
        return Err(invalid("Visual task no longer accepts resources"));
    }
    write_atomic(library.root(), &stage.dir.join(id), &bytes)?;
    stage.completed.insert(id.into(), complete);
    stage.last_change = Instant::now();
    save(library.root(), &stage)?;
    Ok(json!({"schemaVersion":1,"stored":true}))
}

fn initialize(ctx: &RunContext, plan: &CloudAssetsPlan) -> Result<Stage, BridgeError> {
    ctx.library.verify_parse_batch(&plan.snapshot)?;
    let (_, model) = ctx
        .library
        .read_parse_batch_attachment(&plan.snapshot, "blockmodel.json")?;
    let mapped: MappedPaper =
        serde_json::from_slice(&model).map_err(|_| invalid("Invalid visual model"))?;
    let mut assets = derive(&ctx.library, &plan.snapshot, &mapped)?;
    assets.batch_id = output_batch_id(&plan.snapshot.manifest.batch_id);
    let resources = resources(&assets)?;
    let parent = ctx.library.root().join("operations");
    safe(ctx.library.root(), &parent)?;
    let dir = parent
        .join("cloudassets")
        .join(&plan.paper_id)
        .join(&assets.batch_id);
    let mut probe = dir.as_path();
    while !probe.exists() {
        probe = probe
            .parent()
            .ok_or_else(|| invalid("Invalid staging path"))?;
    }
    safe(ctx.library.root(), probe)?;
    fs::create_dir_all(&dir).map_err(io_error)?;
    safe(ctx.library.root(), &dir)?;
    let mut stage = Stage {
        owner: owner(&ctx.registry),
        active: true,
        dir,
        snapshot: plan.snapshot.clone(),
        assets,
        resources,
        completed: BTreeMap::new(),
        last_change: Instant::now(),
        sealed: None,
    };
    let path = stage.dir.join("run.json");
    if path.exists() {
        safe(ctx.library.root(), &path)?;
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .map_err(io_error)?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > 1024 * 1024 {
            return Err(invalid("Visual record too large"));
        }
        let record: Record =
            serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid visual record"))?;
        if serde_json::to_value(&record.snapshot).map_err(|_| invalid("Invalid record"))?
            != serde_json::to_value(&stage.snapshot).map_err(|_| invalid("Invalid record"))?
            || record.output_batch_id != stage.assets.batch_id
        {
            return Err(invalid("Visual resume identity mismatch"));
        }
        for (id, complete) in record.completed {
            let r = stage
                .resources
                .get(&id)
                .ok_or_else(|| invalid("Unexpected resumed visual resource"))?;
            let image = stage.dir.join(&id);
            safe(ctx.library.root(), &image)?;
            let mut bytes = Vec::new();
            fs::File::open(image)
                .map_err(io_error)?
                .take(MAX_IMAGE as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
            if files::sha256_hex(&bytes) != complete.sha256 || bytes.len() as u64 != complete.size {
                return Err(invalid("Resumed visual resource changed"));
            }
            validate_png(&bytes, r.width, r.height)?;
            stage.completed.insert(id, complete);
        }
    }
    match ctx
        .library
        .pin_parse_batch(&plan.paper_id, Some(&stage.assets.batch_id))
    {
        Ok(snapshot) => {
            read_visual_assets(&ctx.library, &snapshot, &mapped)?;
            stage.sealed = Some(snapshot);
            stage.active = false;
        }
        Err(e) if e.code == "not_found" => {}
        Err(e) => return Err(e),
    }
    save(ctx.library.root(), &stage)?;
    Ok(stage)
}

fn seal(ctx: &RunContext, stage: &mut Stage) -> Result<(), BridgeError> {
    ctx.cancel_checkpoint()?;
    ctx.library.verify_parse_batch(&stage.snapshot)?;
    let mut manifest = stage.snapshot.manifest.clone();
    manifest.batch_id = stage.assets.batch_id.clone();
    let mut paths = BTreeMap::new();
    for id in stage.snapshot.manifest.attachments.keys() {
        ctx.cancel_checkpoint()?;
        let (_, mut bytes) = ctx
            .library
            .read_parse_batch_attachment(&stage.snapshot, id)?;
        if id == "cloud-source.json" {
            let mut source: Value =
                serde_json::from_slice(&bytes).map_err(|_| invalid("Invalid source"))?;
            source["batchId"] = json!(manifest.batch_id);
            source["blockModelSha256"] = json!(stage.assets.block_model_sha256);
            bytes = serde_json::to_vec(&source).map_err(|_| invalid("Invalid source"))?;
        }
        let path = stage.dir.join(format!("parent-{id}"));
        write_atomic(ctx.library.root(), &path, &bytes)?;
        let meta = manifest
            .attachments
            .get_mut(id)
            .ok_or_else(|| invalid("Missing resource"))?;
        meta.sha256 = files::sha256_hex(&bytes);
        meta.size = bytes.len() as u64;
        paths.insert(id.clone(), path);
    }
    for (id, r) in &stage.resources {
        ctx.cancel_checkpoint()?;
        let complete = stage
            .completed
            .get(id)
            .ok_or_else(|| invalid("Visual batch incomplete"))?;
        let path = stage.dir.join(id);
        safe(ctx.library.root(), &path)?;
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .map_err(io_error)?
            .take(MAX_IMAGE as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if files::sha256_hex(&bytes) != complete.sha256 || bytes.len() as u64 != complete.size {
            return Err(invalid("Staged visual resource changed"));
        }
        validate_png(&bytes, r.width, r.height)?;
        manifest.attachments.insert(
            id.clone(),
            crate::parsebatch::ParseBatchAttachment {
                attachment_id: id.clone(),
                sha256: complete.sha256.clone(),
                size: complete.size,
                content_type: "image/png".into(),
            },
        );
        paths.insert(id.clone(), path);
    }
    let bytes =
        serde_json::to_vec(&stage.assets).map_err(|_| invalid("Invalid visual manifest"))?;
    let id = "visual-assets.json";
    let path = stage.dir.join(id);
    write_atomic(ctx.library.root(), &path, &bytes)?;
    manifest.attachments.insert(
        id.into(),
        crate::parsebatch::ParseBatchAttachment {
            attachment_id: id.into(),
            sha256: files::sha256_hex(&bytes),
            size: bytes.len() as u64,
            content_type: "application/json".into(),
        },
    );
    paths.insert(id.into(), path);
    ctx.cancel_checkpoint()?;
    ctx.library
        .write_parse_batch_paths_with_checkpoint(manifest, paths, || ctx.cancel_checkpoint())?;
    stage.sealed = Some(ctx.library.pin_parse_batch(
        &stage.snapshot.manifest.paper_id,
        Some(&stage.assets.batch_id),
    )?);
    Ok(())
}
fn execute(ctx: &RunContext, plan: &CloudAssetsPlan) -> Result<Value, BridgeError> {
    let _paper_lock = crate::cloudparse::lock_paper(&ctx.library, &plan.paper_id)?;
    ctx.cancel_checkpoint()?;
    let stage = Arc::new(Mutex::new(initialize(ctx, plan)?));
    stages()
        .lock()
        .map_err(|_| invalid("Visual state unavailable"))?
        .insert((owner(&ctx.registry), ctx.task_id.clone()), stage.clone());
    let result = (|| loop {
        ctx.cancel_checkpoint()?;
        {
            let mut state = stage
                .lock()
                .map_err(|_| invalid("Visual state unavailable"))?;
            let done = state.completed.len();
            let total = state.resources.len();
            ctx.push_progress(Progress {
                done: done as u64,
                total: total as u64,
            });
            if state.sealed.is_some() || done == total {
                if state.sealed.is_none() {
                    seal(ctx, &mut state)?;
                }
                return Ok(
                    json!({"paperId":plan.paper_id,"batchId":state.assets.batch_id,"parentBatchId":plan.snapshot.manifest.batch_id,"candidateReady":true,"visualReady":true,"resultReady":false,"snapshot":state.sealed}),
                );
            }
            if state.last_change.elapsed() > IDLE_TIMEOUT {
                return Err(BridgeError::new(
                    "visual_render_timeout",
                    "Visual renderer disconnected; preparation can be resumed",
                    false,
                ));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    })();
    if let Ok(mut state) = stage.lock() {
        state.active = false;
        // 封存成功后暂存目录不再服务恢复；失败或取消时保留供恢复。
        if state.sealed.is_some()
            && state.dir.exists()
            && safe(ctx.library.root(), &state.dir).is_ok()
        {
            if let Err(error) = fs::remove_dir_all(&state.dir) {
                eprintln!("视觉暂存目录清理失败: {error}");
            }
        }
    }
    if let Ok(mut entries) = stages().lock() {
        entries.remove(&(owner(&ctx.registry), ctx.task_id.clone()));
    }
    result
}
pub(crate) fn run(ctx: &RunContext, plan: &CloudAssetsPlan) {
    match execute(ctx, plan) {
        Ok(value) => ctx.succeed(Some(value)),
        Err(e) if e.code == crate::tasks::CANCEL_SENTINEL => ctx.cancel_now(),
        Err(e) => ctx.fail(e),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn scaled_dimensions_keep_the_png_limit_despite_rounding() {
        assert_eq!(super::dimensions(340.0, 1060.0), (514, 1600));
        assert_eq!(super::dimensions(1060.0, 340.0), (1600, 514));
    }
}
