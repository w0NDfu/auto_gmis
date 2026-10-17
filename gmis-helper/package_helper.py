"""Package reproducible helper sources, excluding dependencies and runtime data."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent
files = ["package.json", "package-lock.json", "manager.js", "identity.js", "login-result.js", "operations.js", "sso.js", "sso-form.js", "server.js", "start-helper.cmd", "README.md"]
package = json.loads((root / "package.json").read_text(encoding="utf-8"))
lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
assert package["dependencies"] == {"playwright-core": "1.64.1"}
assert lock["packages"]["node_modules/playwright-core"]["version"] == "1.64.1"
target = root.parent / "gmis-helper.zip"
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, "gmis-helper/" + name)
print(f"Package: {target} ({target.stat().st_size:,} bytes)")
