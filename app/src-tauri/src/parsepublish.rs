//! Candidate validation and one SQLite transaction publish a retained parse version.
use crate::{
    error::BridgeError,
    library::{
        load_paper, normalize_paper, parse_state_stale, upsert_paper, Library, PaperDto, PartDto,
        RecallCardDto, SectionDto,
    },
    parsebatch::ParseBatchSnapshot,
    pdfmap::{MappedPaper, SectionRole},
};
use serde_json::{json, Value};

fn sql_error(error: rusqlite::Error) -> BridgeError {
    BridgeError::internal(error.to_string())
}

fn has_reading_history(paper: &PaperDto) -> bool {
    !paper.products.is_empty()
        || !paper.analyses.is_empty()
        || !paper.translations.is_empty()
        || !paper.chat.is_empty()
        || !paper.read_marks.is_empty()
        || !paper.recall_card.markdown.is_empty()
        || !paper.recall_card.images.is_empty()
}

impl Library {
    pub fn validate_parse_candidate(
        &self,
        snapshot: &ParseBatchSnapshot,
        require_visual: bool,
    ) -> Result<MappedPaper, BridgeError> {
        self.verify_parse_batch(snapshot)?;
        if !matches!(snapshot.manifest.provider.as_str(), "baidu" | "docling") {
            return Err(BridgeError::invalid_input("不支持的解析提供方"));
        }
        if !snapshot
            .manifest
            .attachments
            .contains_key("blockmodel.json")
            && !require_visual
            && snapshot.manifest.provider == "docling"
            && snapshot.manifest.batch_id.starts_with("frozen-")
        {
            let (_, pdf) = self.read_parse_batch_attachment(snapshot, "pdf")?;
            let identity = crate::pdf_identity::read_pdf_identity_bytes(&pdf)?;
            if identity.sha256 != snapshot.manifest.pdf_sha256 {
                return Err(parse_state_stale());
            }
            return Ok(MappedPaper {
                schema_version: crate::pdfmap::PDFMAP_SCHEMA_VERSION,
                title: None,
                source_name: None,
                page_count: identity.pages.len() as u32,
                sections: vec![],
                frontmatter: vec![],
                furniture: vec![],
                figures: vec![],
                tables: vec![],
                references: vec![],
                warnings: vec!["legacy_unparsed".into()],
            });
        }
        let (_, model_bytes) = self.read_parse_batch_attachment(snapshot, "blockmodel.json")?;
        let mapped: MappedPaper = serde_json::from_slice(&model_bytes)
            .map_err(|_| BridgeError::invalid_input("解析块模型无效"))?;
        let (_, pdf_bytes) = self.read_parse_batch_attachment(snapshot, "pdf")?;
        let identity = crate::pdf_identity::read_pdf_identity_bytes(&pdf_bytes)?;
        if identity.sha256 != snapshot.manifest.pdf_sha256
            || mapped.page_count as usize != identity.pages.len()
        {
            return Err(BridgeError::invalid_input("解析页数或 PDF 身份不一致"));
        }
        let model_sha = crate::files::sha256_hex(&model_bytes);
        crate::pdfmap_evidence::get_batch_source_regions(
            self,
            &snapshot.manifest.paper_id,
            &snapshot.manifest.batch_id,
            &model_sha,
        )?;
        if require_visual {
            if snapshot.manifest.provider == "baidu" {
                crate::cloudassets::read_visual_assets(self, snapshot, &mapped)?;
            } else {
                self.validate_local_visual_batch(snapshot, &mapped)?;
            }
        }
        Ok(mapped)
    }

    pub fn publish_parse_batch(
        &self,
        snapshot: &ParseBatchSnapshot,
        expected: Option<&str>,
        overwrite_confirmed: bool,
        allow_incomplete_initial: bool,
        checkpoint: impl Fn() -> Result<(), BridgeError>,
    ) -> Result<PaperDto, BridgeError> {
        checkpoint()?;
        self.verify_parse_batch(snapshot)?;
        let paper_id = &snapshot.manifest.paper_id;
        let before = self.get_paper(paper_id)?;
        if before.parse_batch_id.as_deref() != expected {
            return Err(parse_state_stale());
        }
        if expected == Some(snapshot.manifest.batch_id.as_str()) {
            return Ok(before);
        }
        if !snapshot
            .manifest
            .attachments
            .contains_key("blockmodel.json")
        {
            return Err(BridgeError::invalid_input("发布候选缺少块模型"));
        }
        let mapped = self.validate_parse_candidate(snapshot, false)?;
        let had_legacy_model = self.get_attachment(paper_id, "blockmodel.json").is_ok();
        let old = if before.parse_batch_id.is_some() {
            // 旧批次字节已不可读时归档本无可保全内容；用户确认覆盖后跳过归档继续发布。
            match self.pin_parse_batch(paper_id, None) {
                Ok(snapshot) => Some(snapshot),
                Err(error) if overwrite_confirmed => {
                    eprintln!("旧批次校验失败，按确认覆盖跳过归档: {error}");
                    None
                }
                Err(error) => return Err(error),
            }
        } else {
            // A user may save chat or notes while the candidate is validating.
            // Retain the old PDF before the transaction, and decide whether to archive
            // the latest domain state inside that transaction.
            Some(self.freeze_legacy_parse_batch(paper_id)?)
        };
        let same_generation = old.as_ref().is_some_and(|old| {
            let previous = &old.manifest;
            let current = &snapshot.manifest;
            previous.pdf_sha256 == current.pdf_sha256
                && previous.provider == current.provider
                && previous
                    .attachments
                    .get("blockmodel.json")
                    .map(|r| &r.sha256)
                    == current
                        .attachments
                        .get("blockmodel.json")
                        .map(|r| &r.sha256)
                && (current.batch_id == crate::cloudassets::output_batch_id(&previous.batch_id)
                    || current.options.get("parentBatchId").and_then(Value::as_str)
                        == Some(previous.batch_id.as_str()))
        });
        if (before.parse_batch_id.is_some() || had_legacy_model)
            && !same_generation
            && !overwrite_confirmed
        {
            return Err(BridgeError::new(
                "parse_replace_confirmation_required",
                "替换解析前需确认保留旧阅读历史",
                false,
            ));
        }
        if !(allow_incomplete_initial && before.parse_batch_id.is_none() && !had_legacy_model) {
            if snapshot.manifest.provider == "baidu" {
                crate::cloudassets::read_visual_assets(self, snapshot, &mapped)?;
            } else if snapshot.manifest.provider == "docling" {
                self.validate_local_visual_batch(snapshot, &mapped)?;
            } else {
                return Err(BridgeError::invalid_input("不支持的解析提供方"));
            }
        }
        checkpoint()?;
        self.verify_parse_batch(snapshot)?;
        if self.verify_attachment(paper_id, "pdf")?.sha256 != snapshot.manifest.pdf_sha256 {
            return Err(parse_state_stale());
        }
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction().map_err(sql_error)?;
        let mut paper = load_paper(&tx, paper_id)?;
        if paper.parse_batch_id.as_deref() != expected {
            return Err(parse_state_stale());
        }
        let live_pdf_sha: String = tx
            .query_row(
                "SELECT sha256 FROM attachments WHERE paper_id=?1 AND attachment_id='pdf'",
                rusqlite::params![paper_id],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        if live_pdf_sha != snapshot.manifest.pdf_sha256 {
            return Err(parse_state_stale());
        }
        let now = crate::tasks::now_iso();
        if !same_generation {
            if let Some(old) = old.filter(|old| {
                old.manifest.attachments.contains_key("blockmodel.json")
                    || has_reading_history(&paper)
            }) {
                let mut archived = paper.clone();
                archived.parse_batch_id = Some(old.manifest.batch_id.clone());
                archived.parse_history.clear();
                paper.parse_history.push(json!({"batchId":old.manifest.batch_id,"provider":old.manifest.provider,"createdAt":now,"paper":archived}));
            }
            paper.sections = mapped
                .sections
                .iter()
                .map(|section| SectionDto {
                    id: section.id.clone(),
                    source_text: section
                        .blocks
                        .iter()
                        .map(|block| block.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n\n"),
                    page_start: Some(section.page_start as i64),
                    page_end: Some(section.page_end as i64),
                })
                .collect();
            let mut index = 0;
            paper.parts = mapped
                .sections
                .iter()
                .filter(|section| matches!(section.role, SectionRole::Abstract | SectionRole::Body))
                .map(|section| {
                    let id = if section.role == SectionRole::Abstract {
                        "abstract".into()
                    } else {
                        index += 1;
                        format!("part-{index}")
                    };
                    PartDto {
                        id,
                        title: Some(section.title.clone()),
                        heading: None,
                        semantic_type: None,
                        sort_order: index,
                    }
                })
                .collect();
            paper.full_text = paper
                .sections
                .iter()
                .map(|section| section.source_text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            paper.num_pages = mapped.page_count as i64;
            paper.products.clear();
            paper.analyses.clear();
            paper.translations.clear();
            paper.read_marks.clear();
            paper.chat.clear();
            paper.recall_card = RecallCardDto::default();
        }
        paper.parse_batch_id = Some(snapshot.manifest.batch_id.clone());
        paper.updated_at = now;
        normalize_paper(&mut paper)?;
        upsert_paper(&tx, &paper)?;
        // Cancellation before commit rolls the whole parse pointer and domain snapshot back.
        checkpoint()?;
        tx.commit().map_err(sql_error)?;
        Ok(paper)
    }

    fn validate_local_visual_batch(
        &self,
        snapshot: &ParseBatchSnapshot,
        mapped: &MappedPaper,
    ) -> Result<(), BridgeError> {
        let (_, bytes) = self.read_parse_batch_attachment(snapshot, "local-visual-assets.json")?;
        let visual: Value = serde_json::from_slice(&bytes)
            .map_err(|_| BridgeError::invalid_input("本地视觉清单无效"))?;
        if visual["batchId"] != snapshot.manifest.batch_id
            || visual["pdfSha256"] != snapshot.manifest.pdf_sha256
            || visual["blockModelSha256"] != snapshot.manifest.attachments["blockmodel.json"].sha256
        {
            return Err(BridgeError::invalid_input("本地视觉清单身份不一致"));
        }
        let resources = visual["resources"]
            .as_object()
            .ok_or_else(|| BridgeError::invalid_input("本地视觉清单缺失"))?;
        let expected = crate::pdfassets::build_render_job(mapped);
        let ids = (1..=mapped.page_count)
            .map(crate::pdfassets::page_attachment_id)
            .chain(
                expected
                    .crops
                    .iter()
                    .map(|crop| crate::pdfassets::crop_attachment_id(&crop.id)),
            );
        for id in ids {
            let resource = resources.get(&id).ok_or_else(|| {
                BridgeError::new("preflight_missing", "本地视觉证据尚未齐备", false)
            })?;
            let (meta, image) = self.read_parse_batch_attachment(snapshot, &id)?;
            if resource["sha256"] != meta.sha256
                || resource["bytes"] != meta.size
                || image.is_empty()
                || resource["width"].as_u64().unwrap_or(0) == 0
                || resource["height"].as_u64().unwrap_or(0) == 0
            {
                return Err(BridgeError::invalid_input("本地视觉证据校验失败"));
            }
            if meta.content_type != "image/webp"
                || crate::pdfassets::webp_dimensions(&image)
                    != Some((
                        resource["width"].as_u64().unwrap_or(0) as u32,
                        resource["height"].as_u64().unwrap_or(0) as u32,
                    ))
            {
                return Err(BridgeError::invalid_input("本地视觉图像格式或尺寸不一致"));
            }
        }
        Ok(())
    }
}
