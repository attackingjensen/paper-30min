"""Create and verify the standalone Windows Docling component archive."""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


VERSION = "1.2.0-beta.1"
ARCHIVE_NAME = f"Paper30Min_pdfparse_{VERSION}_windows-x86_64.zip"
MANIFEST_NAME = f"Paper30Min_pdfparse_{VERSION}_windows-x86_64.manifest.json"
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
REPARSE_POINT = 0x400


def required_files():
    source = Path(__file__).with_name("pdfparse_sidecar.py")
    spec = importlib.util.spec_from_file_location("paper30min_pdfparse_sidecar", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {
        "python/python.exe", "app/pdfparse_sidecar.py", "deps.ok",
        "sidecar-manifest.json",
        *(f"models/{name}" for name in module.REQUIRED_MODEL_FILES),
    }


def safe_name(name):
    if (not name or name.startswith("/") or "\\" in name or ":" in name
            or any(part in ("", ".", "..") for part in name.split("/"))):
        raise ValueError(f"unsafe ZIP path: {name}")
    path = PurePosixPath(name)
    if path.parts[0] != "pdfparse" or len(path.parts) < 2:
        raise ValueError(f"ZIP entry outside pdfparse/: {name}")
    for part in path.parts:
        stem = part.split(".", 1)[0].upper()
        if (part.endswith((" ", ".")) or any(ord(char) < 32 for char in part)
                or stem in {"CON", "PRN", "AUX", "NUL"}
                or re.fullmatch(r"(?:COM|LPT)[1-9]", stem)):
            raise ValueError(f"unsafe Windows ZIP path: {name}")
    return path


def check_regular(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT:
        raise ValueError(f"symlink/reparse point forbidden: {path}")
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"non-regular file forbidden: {path}")
    return info.st_size


def source_files(source):
    if (not source.is_dir() or source.is_symlink()
            or getattr(source.lstat(), "st_file_attributes", 0) & REPARSE_POINT):
        raise ValueError("component source must be a real directory")
    files = []
    for root, dirs, names in os.walk(source, followlinks=False):
        for dirname in dirs:
            directory = Path(root, dirname)
            info = directory.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT:
                raise ValueError(f"symlink/reparse point forbidden: {directory}")
        for name in names:
            path = Path(root, name)
            relative = path.relative_to(source).as_posix()
            safe_name(f"pdfparse/{relative}")
            size = check_regular(path)
            files.append((relative, path, size))
    files.sort(key=lambda row: row[0])
    seen = set()
    for relative, _, _ in files:
        folded = relative.casefold()
        if folded in seen:
            raise ValueError(f"case-insensitive duplicate path: {relative}")
        seen.add(folded)
    missing = required_files() - {relative for relative, _, _ in files}
    if missing:
        raise ValueError(f"component files missing: {', '.join(sorted(missing))}")
    sidecar_manifest = json.loads((source / "sidecar-manifest.json").read_text(encoding="utf-8"))
    if sidecar_manifest.get("variant") != "bundled":
        raise ValueError("component source must use bundled variant")
    return files


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def expected_manifest(archive, unpacked_bytes):
    return {
        "schemaVersion": 1,
        "component": "pdfparse",
        "version": VERSION,
        "platform": "windows",
        "arch": "x86_64",
        "archive": ARCHIVE_NAME,
        "archiveBytes": archive.stat().st_size,
        "sha256": digest(archive),
        "unpackedBytes": unpacked_bytes,
    }


def create(source, archive, manifest):
    source = Path(source)
    if source.is_symlink() or getattr(source.lstat(), "st_file_attributes", 0) & REPARSE_POINT:
        raise ValueError("component source must not be a symlink/reparse point")
    source, archive, manifest = map(lambda path: Path(path).resolve(), (source, archive, manifest))
    if archive.name != ARCHIVE_NAME or manifest.name != MANIFEST_NAME:
        raise ValueError("component archive or manifest basename is invalid")
    if source == archive or source in archive.parents or source in manifest.parents:
        raise ValueError("outputs must be outside the component source")
    files = source_files(source)
    archive.parent.mkdir(parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".pdfparse-", suffix=".zip", dir=archive.parent)
    os.close(handle)
    temp_archive = Path(temporary)
    try:
        with zipfile.ZipFile(temp_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as output:
            for relative, path, _ in files:
                entry = zipfile.ZipInfo(f"pdfparse/{relative}", date_time=ZIP_TIMESTAMP)
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | 0o644) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                with path.open("rb") as source_file, output.open(entry, "w", force_zip64=True) as target:
                    for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
                        target.write(chunk)
        unpacked = sum(size for _, _, size in files)
        details = expected_manifest(temp_archive, unpacked)
        os.replace(temp_archive, archive)
        manifest.write_text(json.dumps(details, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return details
    finally:
        temp_archive.unlink(missing_ok=True)


def verify(archive, manifest):
    archive, manifest = Path(archive), Path(manifest)
    if archive.name != ARCHIVE_NAME or manifest.name != MANIFEST_NAME:
        raise ValueError("component archive or manifest basename is invalid")
    details = json.loads(manifest.read_text(encoding="utf-8"))
    if set(details) != {"schemaVersion", "component", "version", "platform", "arch", "archive", "archiveBytes", "sha256", "unpackedBytes"} or type(details.get("unpackedBytes")) is not int or details["unpackedBytes"] < 0:
        raise ValueError("component manifest fields are invalid")
    if details != expected_manifest(archive, details["unpackedBytes"]):
        raise ValueError("component archive digest, size, version or architecture mismatch")
    names = set()
    unpacked = 0
    with zipfile.ZipFile(archive) as package:
        for entry in package.infolist():
            safe_name(entry.filename)
            if entry.is_dir() or stat.S_IFMT(entry.external_attr >> 16) == stat.S_IFLNK:
                raise ValueError(f"non-regular ZIP entry: {entry.filename}")
            relative = entry.filename.removeprefix("pdfparse/")
            folded = relative.casefold()
            if folded in names:
                raise ValueError(f"duplicate ZIP entry: {entry.filename}")
            names.add(folded)
            unpacked += entry.file_size
        missing = {name.casefold() for name in required_files()} - names
        if missing:
            raise ValueError(f"component files missing: {', '.join(sorted(missing))}")
        if unpacked != details["unpackedBytes"]:
            raise ValueError("component unpacked size mismatch")
        if package.testzip() is not None:
            raise ValueError("component ZIP CRC check failed")
        sidecar = json.loads(package.read("pdfparse/sidecar-manifest.json"))
        if sidecar.get("variant") != "bundled":
            raise ValueError("component ZIP must use bundled variant")
    return details


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("create", "verify"))
    parser.add_argument("--source", type=Path)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "create":
        if args.source is None:
            parser.error("create requires --source")
        create(args.source, args.archive, args.manifest)
    else:
        verify(args.archive, args.manifest)
    print(f"component {args.mode} OK: {args.archive}")


if __name__ == "__main__":
    main()
