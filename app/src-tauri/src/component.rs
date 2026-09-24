//! Verified, versioned storage for the optional local parser.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::ZipArchive;

pub const COMPONENT_VERSION: &str = "1.2.0-beta.1";
pub const ARCHIVE_NAME: &str = "Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.zip";
pub const MANIFEST_NAME: &str = "Paper30Min_pdfparse_1.2.0-beta.1_windows-x86_64.manifest.json";
const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 200_000;
const REQUIRED: &[&str] = &[
    "python/python.exe",
    "app/pdfparse_sidecar.py",
    "deps.ok",
    "sidecar-manifest.json",
    "models/docling-project--docling-layout-heron/model.safetensors",
    "models/docling-project--docling-layout-heron/config.json",
    "models/docling-project--docling-layout-heron/preprocessor_config.json",
    "models/docling-project--docling-models/model_artifacts/tableformer/accurate/tm_config.json",
    "models/docling-project--docling-models/model_artifacts/tableformer/accurate/tableformer_accurate.safetensors",
    "models/docling-project--docling-models/model_artifacts/tableformer/fast/tm_config.json",
    "models/docling-project--docling-models/model_artifacts/tableformer/fast/tableformer_fast.safetensors",
    "models/RapidOcr/PP-OCRv6_det_small.pth",
    "models/RapidOcr/PP-OCRv6_rec_small.pth",
    "models/RapidOcr/ppocrv6_dict.txt",
    "models/RapidOcr/ch_ptocr_mobile_v2.0_cls_mobile.pth",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentManifest {
    pub schema_version: u32,
    pub component: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub archive: String,
    pub archive_bytes: u64,
    pub sha256: String,
    pub unpacked_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ActiveVersion {
    version: String,
    directory: String,
    sha256: String,
}

#[derive(Debug, Clone)]
pub struct VerifiedArchive {
    manifest: ComponentManifest,
}

fn invalid(message: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn valid_digest(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn component_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("components").join("pdfparse")
}

pub fn active_component(root: &Path) -> io::Result<Option<PathBuf>> {
    let pointer = root.join("active.json");
    let data = match fs::read(pointer) {
        Ok(data) => data,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let active: ActiveVersion = serde_json::from_slice(&data).map_err(invalid)?;
    if active.version != COMPONENT_VERSION
        || !valid_digest(&active.sha256)
        || !active
            .directory
            .starts_with(&format!("{COMPONENT_VERSION}-"))
        || active.directory.len() <= COMPONENT_VERSION.len() + 1
        || !active.directory[COMPONENT_VERSION.len() + 1..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(invalid("invalid active component pointer"));
    }
    let path = root.join("versions").join(&active.directory);
    validate_component_files(&path)?;
    Ok(Some(path))
}

pub fn validate_manifest(manifest: &ComponentManifest, trusted_sha256: &str) -> io::Result<()> {
    if manifest.schema_version != 1
        || manifest.component != "pdfparse"
        || manifest.version != COMPONENT_VERSION
        || manifest.platform != "windows"
        || manifest.arch != "x86_64"
        || manifest.archive != ARCHIVE_NAME
        || manifest.archive_bytes == 0
        || manifest.archive_bytes > MAX_ARCHIVE_BYTES
        || manifest.unpacked_bytes == 0
        || manifest.unpacked_bytes > MAX_UNPACKED_BYTES
        || !valid_digest(&manifest.sha256)
        || !valid_digest(trusted_sha256)
        || !manifest.sha256.eq_ignore_ascii_case(trusted_sha256)
    {
        return Err(invalid(
            "component manifest does not match trusted release metadata",
        ));
    }
    Ok(())
}

pub fn verify_archive(
    archive_path: &Path,
    manifest: &ComponentManifest,
    trusted_sha256: &str,
) -> io::Result<VerifiedArchive> {
    validate_manifest(manifest, trusted_sha256)?;
    if archive_path.file_name().and_then(|name| name.to_str()) != Some(ARCHIVE_NAME) {
        return Err(invalid("unexpected component archive filename"));
    }
    if fs::metadata(archive_path)?.len() != manifest.archive_bytes {
        return Err(invalid("component archive size mismatch"));
    }
    let mut file = File::open(archive_path)?;
    let mut hasher = Sha256::new();
    let mut chunk = [0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        hasher.update(&chunk[..read]);
    }
    if !format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(&manifest.sha256) {
        return Err(invalid("component archive SHA-256 mismatch"));
    }
    let mut archive = ZipArchive::new(File::open(archive_path)?).map_err(invalid)?;
    if archive.len() == 0 || archive.len() > MAX_ENTRIES {
        return Err(invalid("component archive entry count is invalid"));
    }
    let mut seen = HashSet::new();
    let mut size = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(invalid)?;
        let relative = safe_entry_name(entry.name())?;
        let folded = relative.to_ascii_lowercase();
        if !seen.insert(folded) {
            return Err(invalid("duplicate component archive entry"));
        }
        if entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0o100000)
        {
            return Err(invalid("non-regular component archive entry"));
        }
        size = size
            .checked_add(entry.size())
            .ok_or_else(|| invalid("component size overflow"))?;
        if size > MAX_UNPACKED_BYTES {
            return Err(invalid("component unpacked size exceeds limit"));
        }
    }
    if size != manifest.unpacked_bytes {
        return Err(invalid("component unpacked size mismatch"));
    }
    for required in REQUIRED {
        if !seen.contains(&required.to_ascii_lowercase()) {
            return Err(invalid(format!("component file missing: {required}")));
        }
    }
    Ok(VerifiedArchive {
        manifest: manifest.clone(),
    })
}

fn safe_entry_name(name: &str) -> io::Result<String> {
    let Some(relative) = name.strip_prefix("pdfparse/") else {
        return Err(invalid("ZIP entry outside pdfparse/"));
    };
    if relative.is_empty()
        || relative.contains('\\')
        || relative.contains(':')
        || relative.chars().any(char::is_control)
    {
        return Err(invalid("unsafe ZIP entry path"));
    }
    for part in relative.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with('.')
            || part.ends_with(' ')
            || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err(invalid("unsafe ZIP entry path"));
        }
    }
    Ok(relative.to_string())
}

pub fn validate_component_files(root: &Path) -> io::Result<()> {
    if !is_real_directory(&fs::symlink_metadata(root)?) {
        return Err(invalid("component root is not a real directory"));
    }
    for relative in REQUIRED {
        let path = root.join(relative);
        let mut parent = path.parent();
        while let Some(directory) = parent {
            if directory == root {
                break;
            }
            if !is_real_directory(&fs::symlink_metadata(directory)?) {
                return Err(invalid(format!(
                    "component parent is not a real directory: {relative}"
                )));
            }
            parent = directory.parent();
        }
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || is_reparse(&metadata) {
            return Err(invalid(format!(
                "component file is not regular: {relative}"
            )));
        }
    }
    let sidecar: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("sidecar-manifest.json"))?).map_err(invalid)?;
    if sidecar.get("variant").and_then(|value| value.as_str()) != Some("bundled") {
        return Err(invalid("component requires bundled sidecar"));
    }
    Ok(())
}

struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Extract and self-check before publishing a new version and switching the active pointer.
pub fn install_verified_archive<F>(
    root: &Path,
    archive_path: &Path,
    verified: &VerifiedArchive,
    self_check: F,
) -> io::Result<PathBuf>
where
    F: FnMut(&Path) -> io::Result<()>,
{
    install_verified_archive_cancellable(root, archive_path, verified, self_check, || Ok(()))
}

pub fn install_verified_archive_cancellable<F, C>(
    root: &Path,
    archive_path: &Path,
    verified: &VerifiedArchive,
    mut self_check: F,
    mut check_cancelled: C,
) -> io::Result<PathBuf>
where
    F: FnMut(&Path) -> io::Result<()>,
    C: FnMut() -> io::Result<()>,
{
    check_cancelled()?;
    verify_archive(archive_path, &verified.manifest, &verified.manifest.sha256)?;
    fs::create_dir_all(root.join("versions"))?;
    let directory = new_directory_name()?;
    let stage = Stage(root.join(format!(".stage-{directory}")));
    fs::create_dir(&stage.0)?;
    let mut archive = ZipArchive::new(File::open(archive_path)?).map_err(invalid)?;
    let mut written = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(invalid)?;
        let relative = safe_entry_name(entry.name())?;
        let destination = stage.0.join(relative);
        fs::create_dir_all(
            destination
                .parent()
                .ok_or_else(|| invalid("invalid ZIP path"))?,
        )?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let count = copy_with_check(&mut entry, &mut output, &mut check_cancelled)?;
        written = written
            .checked_add(count)
            .ok_or_else(|| invalid("component size overflow"))?;
        if count != entry.size() || written > verified.manifest.unpacked_bytes {
            return Err(invalid("component ZIP extraction size mismatch"));
        }
        output.sync_all()?;
    }
    if written != verified.manifest.unpacked_bytes {
        return Err(invalid("component unpacked size mismatch"));
    }
    verify_archive(archive_path, &verified.manifest, &verified.manifest.sha256)?;
    validate_component_files(&stage.0)?;
    check_cancelled()?;
    self_check(&stage.0)?;
    check_cancelled()?;
    publish_stage(root, &stage, &directory, &verified.manifest.sha256)
}

fn new_directory_name() -> io::Result<String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(invalid)?
        .as_nanos();
    Ok(format!(
        "{COMPONENT_VERSION}-{}-{nonce}",
        std::process::id()
    ))
}

fn publish_stage(root: &Path, stage: &Stage, directory: &str, sha256: &str) -> io::Result<PathBuf> {
    let version_dir = root.join("versions").join(directory);
    fs::rename(&stage.0, &version_dir)?;
    let active = ActiveVersion {
        version: COMPONENT_VERSION.to_string(),
        directory: directory.to_string(),
        sha256: sha256.to_string(),
    };
    if let Err(error) = write_active_pointer(root, &active) {
        let _ = fs::remove_dir_all(&version_dir);
        return Err(error);
    }
    Ok(version_dir)
}

/// Copy a verified v1.1.0 installation without consuming its only original copy.
pub fn migrate_legacy_sidecar<F>(root: &Path, source: &Path, self_check: F) -> io::Result<PathBuf>
where
    F: FnMut(&Path) -> io::Result<()>,
{
    migrate_legacy_sidecar_cancellable(root, source, self_check, || Ok(()))
}

pub fn migrate_legacy_sidecar_cancellable<F, C>(
    root: &Path,
    source: &Path,
    mut self_check: F,
    mut check_cancelled: C,
) -> io::Result<PathBuf>
where
    F: FnMut(&Path) -> io::Result<()>,
    C: FnMut() -> io::Result<()>,
{
    check_cancelled()?;
    validate_component_files(source)?;
    fs::create_dir_all(root.join("versions"))?;
    let directory = new_directory_name()?;
    let stage = Stage(root.join(format!(".stage-{directory}")));
    fs::create_dir(&stage.0)?;
    let mut copied = 0u64;
    copy_regular_tree(source, &stage.0, &mut copied, &mut check_cancelled)?;
    validate_component_files(&stage.0)?;
    check_cancelled()?;
    self_check(&stage.0)?;
    check_cancelled()?;
    let sha256 = format!(
        "{:x}",
        Sha256::digest(fs::read(stage.0.join("sidecar-manifest.json"))?)
    );
    publish_stage(root, &stage, &directory, &sha256)
}

fn copy_regular_tree<C: FnMut() -> io::Result<()>>(
    source: &Path,
    target: &Path,
    copied: &mut u64,
    check_cancelled: &mut C,
) -> io::Result<()> {
    if !is_real_directory(&fs::symlink_metadata(source)?) {
        return Err(invalid(
            "legacy component contains a symlink or reparse directory",
        ));
    }
    for entry in fs::read_dir(source)? {
        check_cancelled()?;
        let entry = entry?;
        let source_file = entry.path();
        let target_file = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_file)?;
        if is_real_directory(&metadata) {
            fs::create_dir(&target_file)?;
            copy_regular_tree(&source_file, &target_file, copied, check_cancelled)?;
        } else if metadata.is_file() && !is_reparse(&metadata) {
            *copied = copied
                .checked_add(metadata.len())
                .ok_or_else(|| invalid("component size overflow"))?;
            if *copied > MAX_UNPACKED_BYTES {
                return Err(invalid("legacy component exceeds unpacked size limit"));
            }
            let mut input = File::open(&source_file)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target_file)?;
            if copy_with_check(&mut input, &mut output, check_cancelled)? != metadata.len() {
                return Err(invalid("legacy component changed during migration"));
            }
            output.sync_all()?;
        } else {
            return Err(invalid(
                "legacy component contains a symlink, reparse point or special file",
            ));
        }
    }
    Ok(())
}

fn copy_with_check<R: Read, W: Write, C: FnMut() -> io::Result<()>>(
    source: &mut R,
    target: &mut W,
    check_cancelled: &mut C,
) -> io::Result<u64> {
    let mut buffer = [0u8; 1024 * 1024];
    let mut copied = 0u64;
    loop {
        check_cancelled()?;
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        target.write_all(&buffer[..count])?;
        copied = copied
            .checked_add(count as u64)
            .ok_or_else(|| invalid("component size overflow"))?;
    }
    Ok(copied)
}

fn is_real_directory(metadata: &fs::Metadata) -> bool {
    metadata.is_dir() && !is_reparse(metadata)
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn write_active_pointer(root: &Path, active: &ActiveVersion) -> io::Result<()> {
    let temporary = root.join(format!(".active-{}.json", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        serde_json::to_writer(&mut file, active).map_err(invalid)?;
        file.sync_all()?;
        drop(file);
        let current = root.join("active.json");
        if current.exists() {
            replace_file(&current, &temporary)
        } else {
            fs::rename(&temporary, &current)
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(windows)]
fn replace_file(current: &Path, replacement: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *const u8,
            reserved: *const u8,
        ) -> i32;
    }
    let current: Vec<u16> = current.as_os_str().encode_wide().chain(Some(0)).collect();
    let replacement: Vec<u16> = replacement
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        ReplaceFileW(
            current.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(current: &Path, replacement: &Path) -> io::Result<()> {
    fs::rename(replacement, current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::FileOptions;

    fn archive_fixture(
        dir: &Path,
        extra: &[(&str, &[u8])],
        omit: Option<&str>,
    ) -> (PathBuf, ComponentManifest) {
        let path = dir.join(ARCHIVE_NAME);
        let file = File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let mut unpacked = 0u64;
        for name in REQUIRED
            .iter()
            .copied()
            .filter(|name| Some(*name) != omit)
            .map(|name| (name, b"x".as_slice()))
            .chain(extra.iter().copied())
        {
            zip.start_file(format!("pdfparse/{}", name.0), FileOptions::<()>::default())
                .unwrap();
            let content = if name.0 == "sidecar-manifest.json" {
                b"{\"variant\":\"bundled\"}".as_slice()
            } else {
                name.1
            };
            zip.write_all(content).unwrap();
            unpacked += content.len() as u64;
        }
        zip.finish().unwrap();
        let bytes = fs::read(&path).unwrap();
        let manifest = ComponentManifest {
            schema_version: 1,
            component: "pdfparse".into(),
            version: COMPONENT_VERSION.into(),
            platform: "windows".into(),
            arch: "x86_64".into(),
            archive: ARCHIVE_NAME.into(),
            archive_bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            unpacked_bytes: unpacked,
        };
        (path, manifest)
    }

    #[test]
    fn rejects_wrong_digest_and_architecture() {
        let dir = tempfile::tempdir().unwrap();
        let (archive, mut manifest) = archive_fixture(dir.path(), &[], None);
        assert!(verify_archive(&archive, &manifest, &"0".repeat(64)).is_err());
        manifest.arch = "aarch64".into();
        let trusted = manifest.sha256.clone();
        assert!(verify_archive(&archive, &manifest, &trusted).is_err());
    }

    #[test]
    fn rejects_traversal_duplicates_and_missing_files() {
        for (extra, omit) in [
            (vec![("../escape", b"x".as_slice())], None),
            (vec![("PYTHON/python.exe", b"x".as_slice())], None),
            (vec![], Some("python/python.exe")),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (archive, manifest) = archive_fixture(dir.path(), &extra, omit);
            assert!(verify_archive(&archive, &manifest, &manifest.sha256).is_err());
        }
    }

    #[test]
    fn failed_self_check_preserves_active_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = component_root(dir.path());
        let (archive, manifest) = archive_fixture(dir.path(), &[], None);
        let verified = verify_archive(&archive, &manifest, &manifest.sha256).unwrap();
        let error = install_verified_archive(&root, &archive, &verified, |_| {
            Err(invalid("self check failed"))
        });
        assert!(error.is_err());
        assert!(!root.join("active.json").exists());
        assert_eq!(fs::read_dir(root.join("versions")).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);

        let installed = install_verified_archive(&root, &archive, &verified, |_| Ok(())).unwrap();
        assert_eq!(active_component(&root).unwrap(), Some(installed.clone()));
        assert!(
            install_verified_archive(&root, &archive, &verified, |_| Err(invalid("retry failed")))
                .is_err()
        );
        assert_eq!(active_component(&root).unwrap(), Some(installed.clone()));
        fs::remove_file(installed.join("python/python.exe")).unwrap();
        assert!(active_component(&root).is_err());
        let repaired = install_verified_archive(&root, &archive, &verified, |_| Ok(())).unwrap();
        assert_ne!(repaired, installed);
        assert_eq!(active_component(&root).unwrap(), Some(repaired));
        assert!(installed.is_dir());
    }

    #[test]
    fn cancellation_does_not_activate_staged_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = component_root(dir.path());
        let (archive, manifest) = archive_fixture(dir.path(), &[], None);
        let verified = verify_archive(&archive, &manifest, &manifest.sha256).unwrap();
        let mut checks = 0;
        let result = install_verified_archive_cancellable(
            &root,
            &archive,
            &verified,
            |_| Ok(()),
            || {
                checks += 1;
                if checks > 2 {
                    Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"))
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(active_component(&root).unwrap(), None);
        assert_eq!(fs::read_dir(root.join("versions")).unwrap().count(), 0);
    }

    #[test]
    fn legacy_migration_preserves_source_and_rolls_back_failed_check() {
        let dir = tempfile::tempdir().unwrap();
        let root = component_root(dir.path());
        let source = dir.path().join("legacy");
        fs::create_dir_all(&source).unwrap();
        let (archive, manifest) = archive_fixture(dir.path(), &[], None);
        let verified = verify_archive(&archive, &manifest, &manifest.sha256).unwrap();
        install_verified_archive(&root, &archive, &verified, |_| Ok(())).unwrap();
        let previous = active_component(&root).unwrap().unwrap();
        for relative in REQUIRED {
            let target = source.join(relative);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            let content = if *relative == "sidecar-manifest.json" {
                b"{\"variant\":\"bundled\"}".as_slice()
            } else {
                b"x".as_slice()
            };
            fs::write(target, content).unwrap();
        }
        assert!(migrate_legacy_sidecar(&root, &source, |_| Err(invalid("bad runtime"))).is_err());
        assert_eq!(active_component(&root).unwrap(), Some(previous.clone()));
        let migrated = migrate_legacy_sidecar(&root, &source, |_| Ok(())).unwrap();
        assert_ne!(migrated, previous);
        assert_eq!(active_component(&root).unwrap(), Some(migrated));
        assert!(source.join("python/python.exe").exists());
    }
}
