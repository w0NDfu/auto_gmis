"""Bundle pinned npm OCR assets locally. Does not execute package install scripts."""
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor"


def get(url):
    with urllib.request.urlopen(url, timeout=45) as response:
        return response.read()


def package(name, version):
    metadata = json.loads(get(f"https://registry.npmjs.org/{name}/{version}"))
    dist = metadata["dist"]
    url = dist["tarball"]
    if not url.startswith("https://registry.npmjs.org/"):
        raise RuntimeError("Unexpected tarball origin")
    cache = ROOT / ".cache"
    cache.mkdir(exist_ok=True)
    target = cache / f"{name}-{version}.tgz"
    if target.is_file():
        blob = target.read_bytes()
    else:
        print(f"Downloading {name}@{version}...", flush=True)
        blob = get(url)
    actual = "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode()
    if dist["integrity"] != actual:
        raise RuntimeError("Package integrity mismatch")
    target.write_bytes(blob)
    return tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz")


def copy_member(archive, name, target):
    member = archive.getmember("package/" + name)
    if not member.isfile():
        raise RuntimeError("Unexpected non-file package member")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(archive.extractfile(member).read())


def main():
    with package("tesseract.js", "6.0.1") as archive:
        for name in ("tesseract.min.js", "worker.min.js"):
            copy_member(archive, "dist/" + name, VENDOR / "tesseract" / name)
        copy_member(archive, "LICENSE.md", VENDOR / "tesseract" / "LICENSE.md")
    with package("tesseract.js-core", "6.0.0") as archive:
        for member in archive.getmembers():
            name = member.name.removeprefix("package/")
            if "/" not in name and (name.endswith(".wasm") or name.endswith(".wasm.js")):
                copy_member(archive, name, VENDOR / "core" / name)
        # Different package releases use a different license filename.
        for name in ("LICENSE", "LICENSE.md", "LICENSE.txt"):
            if "package/" + name in archive.getnames():
                copy_member(archive, name, VENDOR / "core" / name)
    language = ROOT.parent / "TessOcr" / "tessdata" / "eng.traineddata"
    if not language.is_file():
        raise RuntimeError(f"Missing local English traineddata: {language}")
    (VENDOR / "lang").mkdir(parents=True, exist_ok=True)
    (VENDOR / "lang" / "eng.traineddata.gz").write_bytes(gzip.compress(language.read_bytes(), mtime=0))
    assets = {str(p.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in VENDOR.rglob("*") if p.is_file() and p.name != "SHA256SUMS.json"}
    (VENDOR / "SHA256SUMS.json").write_text(json.dumps(assets, indent=2), encoding="utf-8")
    print(f"Bundled {len(assets)} assets. Ready to load as an unpacked extension.")


if __name__ == "__main__":
    main()
