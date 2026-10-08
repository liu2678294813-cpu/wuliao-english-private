"""Preserving-install evidence. Never uninstalls or clears an application."""
import argparse
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
ADB = ROOT / ".android-sdk/platform-tools/adb.exe"
SERIAL = "7VXYD24229201695"
PACKAGE = "com.wuliao.english"
DATA_DIRS = ["app_hws_webview", "files", "shared_prefs", "no_backup"]

def adb(*args):
    return subprocess.check_output([str(ADB), "-s", SERIAL, *args], cwd=ROOT, creationflags=subprocess.CREATE_NO_WINDOW)

def hashes():
    raw = adb("exec-out", "run-as", PACKAGE, "find", *DATA_DIRS, "-type", "f", "-exec", "sha256sum", "{}", "+").decode("utf-8")
    return {line.split(maxsplit=1)[1]: line.split(maxsplit=1)[0] for line in raw.splitlines() if line.strip()}

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["backup", "verify"])
parser.add_argument("folder")
args = parser.parse_args()
folder = pathlib.Path(args.folder).resolve()
if not folder.is_relative_to(ROOT / "output/long-sentence"):
    raise SystemExit("Evidence must stay in the project's long-sentence output directory")
device = adb("get-state").decode().strip()
if device != "device":
    raise SystemExit("Authorized tablet is unavailable")
if args.mode == "backup":
    folder.mkdir(parents=True, exist_ok=True)
    adb("shell", "am", "force-stop", PACKAGE)
    before = hashes()
    archive = folder / "private-data-before.tar.gz"
    with archive.open("wb") as stream:
        subprocess.run([str(ADB), "-s", SERIAL, "exec-out", "run-as", PACKAGE, "tar", "-czf", "-", *DATA_DIRS], stdout=stream, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    after = hashes()
    if before != after:
        raise SystemExit("Data changed while backing up; installation must wait")
    manifest = {"device": SERIAL, "package": PACKAGE, "fileHashes": before, "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "archiveBytes": archive.stat().st_size}
    (folder / "backup-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (folder / "installed-before.txt").write_bytes(adb("shell", "dumpsys", "package", PACKAGE))
    print(json.dumps({"backedUp": len(before), "archive": str(archive), "sha256": manifest["archiveSha256"]}))
else:
    before = json.loads((folder / "backup-manifest.json").read_text())
    after = hashes()
    previous = before["fileHashes"]
    added = sorted(set(after) - set(previous))
    missing = sorted(set(previous) - set(after))
    changed = sorted(key for key in previous.keys() & after.keys() if previous[key] != after[key])
    result = {"beforeFirstLaunch": True, "filesBefore": len(previous), "filesAfter": len(after), "matched": sum(previous.get(key) == value for key,value in after.items()), "added": added, "missing": missing, "changed": changed, "passed": not (added or missing or changed)}
    (folder / "preservation-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
    if not result["passed"]:
        raise SystemExit(1)
