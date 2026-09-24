"""Small fixture tests for the standalone parser component package."""

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import package_component as component


class ComponentPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        for relative in component.required_files():
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            content = b'{"variant":"bundled"}' if relative == "sidecar-manifest.json" else b"fixture"
            path.write_bytes(content)
        self.archive = self.root / component.ARCHIVE_NAME
        self.manifest = self.root / component.MANIFEST_NAME

    def test_create_verify_and_determinism(self):
        first = component.create(self.source, self.archive, self.manifest)
        self.assertEqual(first["schemaVersion"], 1)
        self.assertEqual(first["component"], "pdfparse")
        self.assertEqual(first["version"], "1.2.0-beta.1")
        self.assertEqual(first["arch"], "x86_64")
        self.assertEqual(first, component.verify(self.archive, self.manifest))
        with zipfile.ZipFile(self.archive) as package:
            self.assertTrue(all(name.startswith("pdfparse/") for name in package.namelist()))
        second = component.create(self.source, self.archive, self.manifest)
        self.assertEqual(first, second)

    def test_rejects_missing_file_and_skeleton_variant(self):
        (self.source / "deps.ok").unlink()
        with self.assertRaisesRegex(ValueError, "component files missing"):
            component.create(self.source, self.archive, self.manifest)
        (self.source / "deps.ok").write_bytes(b"fixture")
        (self.source / "sidecar-manifest.json").write_text('{"variant":"download"}')
        with self.assertRaisesRegex(ValueError, "bundled variant"):
            component.create(self.source, self.archive, self.manifest)

    def test_rejects_symlink(self):
        link = self.source / "app" / "link.py"
        try:
            link.symlink_to(self.source / "deps.ok")
        except OSError:
            self.skipTest("symlink creation unavailable")
        with self.assertRaisesRegex(ValueError, "symlink/reparse"):
            component.create(self.source, self.archive, self.manifest)

    def test_rejects_modified_archive_or_manifest(self):
        component.create(self.source, self.archive, self.manifest)
        with self.archive.open("ab") as package:
            package.write(b"extra")
        with self.assertRaisesRegex(ValueError, "digest"):
            component.verify(self.archive, self.manifest)
        details = component.expected_manifest(self.archive, json.loads(self.manifest.read_text())["unpackedBytes"])
        details["arch"] = "aarch64"
        self.manifest.write_text(json.dumps(details))
        with self.assertRaisesRegex(ValueError, "architecture"):
            component.verify(self.archive, self.manifest)

    def test_rejects_traversal_even_with_matching_archive_digest(self):
        component.create(self.source, self.archive, self.manifest)
        with zipfile.ZipFile(self.archive, "a") as package:
            package.writestr("pdfparse/../escape", "bad")
        details = json.loads(self.manifest.read_text())
        details.update(component.expected_manifest(self.archive, details["unpackedBytes"]))
        self.manifest.write_text(json.dumps(details))
        with self.assertRaisesRegex(ValueError, "unsafe ZIP path"):
            component.verify(self.archive, self.manifest)

    def test_rejects_windows_alias_paths(self):
        for name in ("pdfparse/app/CON.txt", "pdfparse/models/trailing. "):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "unsafe Windows ZIP path"):
                component.safe_name(name)


if __name__ == "__main__":
    unittest.main()
