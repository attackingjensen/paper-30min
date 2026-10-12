use crate::error::BridgeError;
use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, collections::HashSet, fs::File, io::Read, path::Path};

pub const MAX_PDF_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PAGES: usize = 2000;
const MAX_DEPTH: usize = 64;
const MAX_OBJECTS: usize = 100_000;
const STREAM_LIMIT: usize = 2 * 1024 * 1024;
const OBJECT_STREAM_BUDGET: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfIdentity {
    pub sha256: String,
    pub pages: Vec<PdfPageGeometry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageGeometry {
    pub page_no: u32,
    pub media_box: [f64; 4],
    pub crop_box: [f64; 4],
    pub rotation: i32,
    pub user_unit: f64,
    pub width: f64,
    pub height: f64,
    pub trusted_geometry: bool,
}

#[derive(Default)]
struct LoadBudget {
    decoded: usize,
    objects: usize,
    failed: bool,
}
thread_local! { static BUDGET: RefCell<LoadBudget> = RefCell::new(LoadBudget::default()); }

// lopdf's filter is a function pointer. With rayon disabled it runs on the loading
// thread, so each load has its own aggregate object-stream budget.
fn metadata_filter(id: ObjectId, object: &mut Object) -> Option<(ObjectId, Object)> {
    BUDGET.with(|cell| {
        let mut budget = cell.borrow_mut();
        budget.objects += 1;
        if budget.failed || budget.objects > MAX_OBJECTS {
            budget.failed = true;
            return None;
        }
        if let Object::Stream(stream) = object {
            if !stream.dict.has_type(b"ObjStm") {
                return None;
            }
            let remaining = OBJECT_STREAM_BUDGET
                .saturating_sub(budget.decoded)
                .min(STREAM_LIMIT);
            match stream.decompressed_content_with_limit(remaining) {
                Ok(decoded) => {
                    budget.decoded += decoded.len();
                    stream.set_content(decoded);
                    stream.dict.remove(b"Filter");
                    stream.dict.remove(b"DecodeParms");
                }
                Err(_) => {
                    budget.failed = true;
                    return None;
                }
            }
        }
        Some((id, object.clone()))
    })
}

fn invalid() -> BridgeError {
    BridgeError::new(
        "invalid_pdf",
        "PDF 页树或几何信息无效，无法建立可信身份。",
        false,
    )
}

pub fn read_pdf_identity(path: &Path) -> Result<PdfIdentity, BridgeError> {
    let file = File::open(path).map_err(|_| invalid())?;
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.len() > MAX_PDF_BYTES {
        return Err(BridgeError::new(
            "too_large",
            "PDF 超过 50 MiB 或不是普通文件。",
            false,
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PDF_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    read_pdf_identity_bytes(&bytes)
}

pub fn read_pdf_identity_bytes(bytes: &[u8]) -> Result<PdfIdentity, BridgeError> {
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(BridgeError::new("too_large", "PDF 超过 50 MiB。", false));
    }
    BUDGET.with(|b| *b.borrow_mut() = LoadBudget::default());
    let document = Document::load_mem_with_options(
        bytes,
        LoadOptions {
            strict: true,
            max_decompressed_size: Some(STREAM_LIMIT),
            filter: Some(metadata_filter),
            ..Default::default()
        },
    )
    .map_err(|_| invalid())?;
    if BUDGET.with(|b| b.borrow().failed) || document.trailer.has(b"Encrypt") {
        return Err(invalid());
    }
    let root = document
        .catalog()
        .map_err(|_| invalid())?
        .get(b"Pages")
        .and_then(Object::as_reference)
        .map_err(|_| invalid())?;
    let mut pages = Vec::new();
    visit_pages(
        &document,
        root,
        None,
        &Inherited::default(),
        0,
        &mut HashSet::new(),
        &mut pages,
    )?;
    if pages.is_empty() {
        return Err(invalid());
    }
    Ok(PdfIdentity {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        pages,
    })
}

fn resolve<'a>(doc: &'a Document, mut value: &'a Object) -> Result<&'a Object, BridgeError> {
    let mut seen = HashSet::new();
    while let Object::Reference(id) = value {
        if seen.len() >= MAX_DEPTH || !seen.insert(*id) {
            return Err(invalid());
        }
        value = doc.objects.get(id).ok_or_else(invalid)?;
    }
    Ok(value)
}

fn number(doc: &Document, value: &Object) -> Result<f64, BridgeError> {
    let result = match resolve(doc, value)? {
        Object::Integer(n) => *n as f64,
        Object::Real(n) => *n as f64,
        _ => return Err(invalid()),
    };
    if !result.is_finite() {
        return Err(invalid());
    }
    Ok(result)
}

fn rectangle(doc: &Document, value: &Object) -> Result<[f64; 4], BridgeError> {
    let values = resolve(doc, value)?.as_array().map_err(|_| invalid())?;
    if values.len() != 4 {
        return Err(invalid());
    }
    let mut result = [0.0; 4];
    for (i, value) in values.iter().enumerate() {
        result[i] = number(doc, value)?;
    }
    if result[2] <= result[0]
        || result[3] <= result[1]
        || result.iter().any(|x| x.abs() > 1_000_000.0)
    {
        return Err(invalid());
    }
    Ok(result)
}

#[derive(Clone)]
struct Inherited {
    media: Option<[f64; 4]>,
    crop: Option<[f64; 4]>,
    rotation: i32,
    unit: f64,
}

impl Default for Inherited {
    fn default() -> Self {
        Self {
            media: None,
            crop: None,
            rotation: 0,
            unit: 1.0,
        }
    }
}

fn inherit(
    doc: &Document,
    dict: &Dictionary,
    previous: &Inherited,
) -> Result<Inherited, BridgeError> {
    let mut current = previous.clone();
    if let Ok(value) = dict.get(b"MediaBox") {
        current.media = Some(rectangle(doc, value)?);
    }
    if let Ok(value) = dict.get(b"CropBox") {
        current.crop = Some(rectangle(doc, value)?);
    }
    if let Ok(value) = dict.get(b"Rotate") {
        let rotation = resolve(doc, value)?.as_i64().map_err(|_| invalid())?;
        if rotation % 90 != 0 {
            return Err(invalid());
        }
        current.rotation = rotation.rem_euclid(360) as i32;
    }
    if let Ok(value) = dict.get(b"UserUnit") {
        current.unit = number(doc, value)?;
    }
    if current.unit <= 0.0 || current.unit > 75_000.0 {
        return Err(invalid());
    }
    Ok(current)
}

fn visit_pages(
    doc: &Document,
    id: ObjectId,
    parent: Option<ObjectId>,
    inherited: &Inherited,
    depth: usize,
    seen: &mut HashSet<ObjectId>,
    pages: &mut Vec<PdfPageGeometry>,
) -> Result<usize, BridgeError> {
    if depth >= MAX_DEPTH || seen.len() >= MAX_OBJECTS || !seen.insert(id) {
        return Err(invalid());
    }
    let dict = doc
        .objects
        .get(&id)
        .ok_or_else(invalid)?
        .as_dict()
        .map_err(|_| invalid())?;
    match parent {
        Some(parent) => {
            if dict.get(b"Parent").and_then(Object::as_reference).ok() != Some(parent) {
                return Err(invalid());
            }
        }
        None => {
            if dict.has(b"Parent") {
                return Err(invalid());
            }
        }
    }
    let geometry = inherit(doc, dict, inherited)?;
    if dict.has_type(b"Page") {
        if pages.len() >= MAX_PAGES {
            return Err(invalid());
        }
        let media = geometry.media.ok_or_else(invalid)?;
        let crop = geometry.crop.unwrap_or(media);
        // PDF rendering clips the crop to MediaBox. Unverified transforms retain
        // accurate page dimensions but cannot supply trusted rectangle overlays.
        let crop = [
            crop[0].max(media[0]),
            crop[1].max(media[1]),
            crop[2].min(media[2]),
            crop[3].min(media[3]),
        ];
        if crop[2] <= crop[0] || crop[3] <= crop[1] {
            return Err(invalid());
        }
        let mut width = (crop[2] - crop[0]) * geometry.unit;
        let mut height = (crop[3] - crop[1]) * geometry.unit;
        if geometry.rotation == 90 || geometry.rotation == 270 {
            std::mem::swap(&mut width, &mut height);
        }
        let trusted_geometry = geometry.rotation == 0
            && geometry.unit == 1.0
            && crop == media
            && media[0] == 0.0
            && media[1] == 0.0;
        pages.push(PdfPageGeometry {
            page_no: pages.len() as u32 + 1,
            media_box: media,
            crop_box: crop,
            rotation: geometry.rotation,
            user_unit: geometry.unit,
            width,
            height,
            trusted_geometry,
        });
        return Ok(1);
    }
    if !dict.has_type(b"Pages") {
        return Err(invalid());
    }
    let kids = resolve(doc, dict.get(b"Kids").map_err(|_| invalid())?)?
        .as_array()
        .map_err(|_| invalid())?;
    if kids.is_empty() || kids.len() > MAX_PAGES {
        return Err(invalid());
    }
    let mut count = 0;
    for kid in kids {
        count += visit_pages(
            doc,
            kid.as_reference().map_err(|_| invalid())?,
            Some(id),
            &geometry,
            depth + 1,
            seen,
            pages,
        )?;
    }
    if dict.get(b"Count").and_then(Object::as_i64).ok() != Some(count as i64) {
        return Err(invalid());
    }
    Ok(count)
}
