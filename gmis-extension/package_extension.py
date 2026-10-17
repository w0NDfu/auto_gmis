"""Validate runtime assets and package an unpackable Chrome extension ZIP."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent
runtime = ["manifest.json", "background.js", "catalog.js", "categories.js", "core.js", "engine.js",
           "ocr.js", "helper-api.js", "multi.html", "multi.js", "multi.css", "dashboard.html", "redirect.js", "dashboard.css", "README.md", "MULTI_ACCOUNT.md", "THIRD_PARTY_NOTICES.md"]
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
assert manifest["manifest_version"] == 3
assert manifest["host_permissions"] == ["http://127.0.0.1:8767/*"]
assert set(manifest["permissions"]) == {"power"}
for relative in runtime:
    assert (root / relative).is_file(), relative
assets = json.loads((root / "vendor/SHA256SUMS.json").read_text(encoding="utf-8"))
for relative, expected in assets.items():
    path = (root / relative).resolve()
    assert path.is_relative_to(root / "vendor")
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, relative
for stem in ("tesseract-core", "tesseract-core-lstm", "tesseract-core-simd", "tesseract-core-simd-lstm"):
    for suffix in (".wasm", ".wasm.js"):
        assert (root / "vendor/core" / (stem + suffix)).is_file()
target = root.parent / "gmis-extension.zip"
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for relative in runtime:
        archive.write(root / relative, relative)
    for path in (root / "vendor").rglob("*"):
        if path.is_file(): archive.write(path, path.relative_to(root))
print(f"Validated {len(assets)} OCR assets. Package: {target} ({target.stat().st_size:,} bytes)")
