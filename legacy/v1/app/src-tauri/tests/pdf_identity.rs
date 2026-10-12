use lopdf::{dictionary, Document, Object};
use paper30min_lib::pdf_identity::{read_pdf_identity, read_pdf_identity_bytes, MAX_PDF_BYTES};
use sha2::{Digest, Sha256};

fn fixture(rotation: i64, crop: bool, cycle: bool) -> tempfile::NamedTempFile {
    let mut doc = Document::with_version("1.5");
    let pages = doc.new_object_id();
    let page = doc.add_object(dictionary! {"Type" => "Page", "Parent" => pages});
    let mut tree = dictionary! {"Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1, "MediaBox" => vec![0.into(),0.into(),612.into(),792.into()], "Rotate" => rotation};
    if crop {
        tree.set(
            "CropBox",
            vec![10.into(), 20.into(), 600.into(), 780.into()],
        );
    }
    if cycle {
        tree.set("Parent", pages);
    }
    doc.objects.insert(pages, Object::Dictionary(tree));
    let root = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages});
    doc.trailer.set("Root", root);
    let file = tempfile::NamedTempFile::new().unwrap();
    doc.save(file.path()).unwrap();
    file
}

#[test]
fn inherited_geometry_and_identity() {
    let file = fixture(0, false, false);
    let result = read_pdf_identity(file.path()).unwrap();
    let bytes = std::fs::read(file.path()).unwrap();
    assert_eq!(result.sha256, format!("{:x}", Sha256::digest(bytes)));
    assert_eq!(
        read_pdf_identity_bytes(&std::fs::read(file.path()).unwrap())
            .unwrap()
            .sha256,
        result.sha256
    );
    assert_eq!(result.pages.len(), 1);
    assert_eq!(result.pages[0].width, 612.0);
    assert_eq!(result.pages[0].height, 792.0);
    assert!(result.pages[0].trusted_geometry);
}

#[test]
fn rotation_and_crop_degrade_geometry() {
    for (rotation, crop) in [(90, false), (0, true), (270, true)] {
        let file = fixture(rotation, crop, false);
        let result = read_pdf_identity(file.path()).unwrap();
        assert!(!result.pages[0].trusted_geometry);
        assert_eq!(result.pages[0].rotation, rotation as i32);
    }
}

#[test]
fn damaged_cycle_and_oversize_fail_closed() {
    let file = fixture(0, false, true);
    assert!(read_pdf_identity(file.path()).is_err());
    let invalid = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(invalid.path(), b"%PDF-1.7\ninvalid").unwrap();
    assert!(read_pdf_identity(invalid.path()).is_err());
    invalid.as_file().set_len(MAX_PDF_BYTES + 1).unwrap();
    assert_eq!(
        read_pdf_identity(invalid.path()).unwrap_err().code,
        "too_large"
    );
}

#[test]
fn existing_corpus_has_complete_geometry() {
    let dir =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/regression/corpus");
    let mut count = 0;
    let mut pages = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|s| s.to_str()) != Some("pdf") {
            continue;
        }
        let result = read_pdf_identity(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(result.pages.iter().all(|p| p.width > 0.0 && p.height > 0.0));
        count += 1;
        pages += result.pages.len();
    }
    assert_eq!(count, 10);
    assert_eq!(pages, 150);
}

fn modify_pdf(file: &tempfile::NamedTempFile, edit: impl FnOnce(&mut Document)) {
    let mut doc = Document::load(file.path()).unwrap();
    edit(&mut doc);
    doc.save(file.path()).unwrap();
}

#[test]
fn invalid_counts_units_references_and_dimensions_fail_closed() {
    for kind in ["count", "unit", "reference", "dimensions"] {
        let file = fixture(0, false, false);
        modify_pdf(&file, |doc| {
            let root = doc
                .catalog()
                .unwrap()
                .get(b"Pages")
                .unwrap()
                .as_reference()
                .unwrap();
            let dict = doc.objects.get_mut(&root).unwrap().as_dict_mut().unwrap();
            match kind {
                "count" => dict.set("Count", 2),
                "unit" => dict.set("UserUnit", 0),
                "reference" => dict.set("MediaBox", root),
                _ => dict.set("MediaBox", vec![0.into(), 0.into(), 0.into(), 792.into()]),
            }
        });
        assert!(read_pdf_identity(file.path()).is_err(), "{kind}");
    }
    let file = fixture(0, false, false);
    modify_pdf(&file, |doc| {
        let root = doc
            .catalog()
            .unwrap()
            .get(b"Pages")
            .unwrap()
            .as_reference()
            .unwrap();
        doc.objects
            .get_mut(&root)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("UserUnit", 2);
    });
    let page = read_pdf_identity(file.path()).unwrap().pages.remove(0);
    assert_eq!(page.user_unit, 2.0);
    assert_eq!(page.width, 1224.0);
    assert!(!page.trusted_geometry);
}

#[test]
fn decompression_bombs_and_aggregate_object_streams_are_bounded() {
    use std::io::Write;
    for (streams, size) in [(1, 2 * 1024 * 1024 + 1), (9, 2 * 1024 * 1024)] {
        let file = fixture(0, false, false);
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        encoder.write_all(&vec![b' '; size]).unwrap();
        let compressed = encoder.finish().unwrap();
        modify_pdf(&file, |doc| {
            for _ in 0..streams {
                doc.add_object(lopdf::Stream::new(dictionary! {"Type" => "BadStm", "N" => 0, "First" => 0, "Filter" => "FlateDecode"}, compressed.clone()));
            }
        });
        // The writer drops ObjStm objects. A same-length type mutation retains
        // them without changing the standard serializer's xref offsets.
        let mut bytes = std::fs::read(file.path()).unwrap();
        for offset in 0..bytes.len().saturating_sub(6) {
            if &bytes[offset..offset + 7] == b"/BadStm" {
                bytes[offset..offset + 7].copy_from_slice(b"/ObjStm");
            }
        }
        std::fs::write(file.path(), bytes).unwrap();
        assert!(
            read_pdf_identity(file.path()).is_err(),
            "streams={streams} size={size}"
        );
    }
}

#[test]
fn unused_content_streams_are_never_decompressed_for_identity() {
    use std::io::Write;
    let file = fixture(0, false, false);
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(&vec![b' '; 4 * 1024 * 1024]).unwrap();
    let compressed = encoder.finish().unwrap();
    modify_pdf(&file, |doc| {
        let id = doc.add_object(lopdf::Stream::new(
            dictionary! {"Filter" => "FlateDecode"},
            compressed,
        ));
        let page_id = *doc.get_pages().get(&1).unwrap();
        doc.objects
            .get_mut(&page_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Contents", id);
    });
    assert!(read_pdf_identity(file.path()).unwrap().pages[0].trusted_geometry);
}

#[test]
fn excessive_page_count_and_depth_are_rejected() {
    for (depth, count) in [(1, 2001), (65, 1)] {
        let mut doc = Document::with_version("1.5");
        let root = doc.new_object_id();
        let mut parent = root;
        for index in 0..depth {
            let child = doc.new_object_id();
            let mut dict = dictionary! {"Type" => "Pages", "Count" => count as i64,
            "Kids" => vec![Object::Reference(child)], "MediaBox" => vec![0.into(),0.into(),612.into(),792.into()]};
            if index > 0 {
                dict.set("Parent", (parent.0 - 1, 0));
            }
            doc.objects.insert(parent, dict.into());
            parent = child;
        }
        if count == 1 {
            doc.objects.insert(
                parent,
                dictionary! {"Type" => "Page", "Parent" => (parent.0 - 1, 0)}.into(),
            );
        } else {
            let mut ids = Vec::new();
            for _ in 0..count {
                ids.push(Object::Reference(
                    doc.add_object(dictionary! {"Type" => "Page", "Parent" => root}),
                ));
            }
            doc.objects
                .get_mut(&root)
                .unwrap()
                .as_dict_mut()
                .unwrap()
                .set("Kids", ids);
        }
        let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => root});
        doc.trailer.set("Root", catalog);
        let file = tempfile::NamedTempFile::new().unwrap();
        doc.save(file.path()).unwrap();
        assert!(read_pdf_identity(file.path()).is_err());
    }
}
