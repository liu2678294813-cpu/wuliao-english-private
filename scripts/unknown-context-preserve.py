"""Capture and verify private files around an overlay install; never clear data."""
import argparse
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
ADB = ROOT / ".android-sdk/platform-tools/adb.exe"
PACKAGE = "com.wuliao.english"
parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["backup", "verify"])
parser.add_argument("folder")
parser.add_argument("serial")
parser.add_argument("--installed-apk-copy")
args = parser.parse_args()
folder = pathlib.Path(args.folder).resolve()
if not folder.is_relative_to(ROOT / "output/unknown-context"):
    raise SystemExit("Evidence must remain in the project output directory")


def adb(*arguments):
    return subprocess.check_output([str(ADB), "-s", args.serial, *arguments], cwd=ROOT, creationflags=subprocess.CREATE_NO_WINDOW)


def hashes(dirs):
    lines = adb("exec-out", "run-as", PACKAGE, "find", *dirs, "-type", "f", "-exec", "sha256sum", "{}", "+").decode("utf-8").splitlines()
    return {line.split(maxsplit=1)[1]: line.split(maxsplit=1)[0] for line in lines if line.strip()}


if args.mode == "backup":
    adb("shell", "am", "force-stop", PACKAGE)
    existing = adb("exec-out", "run-as", PACKAGE, "ls").decode("utf-8").split()
    dirs = [name for name in ["app_hws_webview", "app_webview", "files", "shared_prefs", "no_backup", "databases"] if name in existing]
    if not dirs:
        raise SystemExit("No private data directories; installation stopped")
    before = hashes(dirs)
    archive = folder / "private-data-before.tar.gz"
    with archive.open("wb") as stream:
        subprocess.run([str(ADB), "-s", args.serial, "exec-out", "run-as", PACKAGE, "tar", "-czf", "-", *dirs], stdout=stream, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    if before != hashes(dirs):
        raise SystemExit("Private files changed during backup; installation stopped")
    apk_path = adb("shell", "pm", "path", PACKAGE).decode().strip().splitlines()[0].removeprefix("package:")
    rollback = folder / "rollback-installed.apk"
    if args.installed_apk_copy:
        saved = pathlib.Path(args.installed_apk_copy).resolve()
        content = saved.read_bytes()
        installed_hash = adb("shell", "sha256sum", apk_path).decode().split()[0]
        if hashlib.sha256(content).hexdigest() != installed_hash:
            raise SystemExit("Saved APK does not match the installed APK; installation stopped")
        rollback.write_bytes(content)
    else:
        adb("pull", apk_path, str(rollback))
    (folder / "installed-before.txt").write_bytes(adb("shell", "dumpsys", "package", PACKAGE))
    manifest = {"device": args.serial, "package": PACKAGE, "directories": dirs, "fileHashes": before,
                "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "archiveBytes": archive.stat().st_size}
    (folder / "backup-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"files": len(before), "archiveBytes": manifest["archiveBytes"], "status": "backed-up"}))
else:
    manifest = json.loads((folder / "backup-manifest.json").read_text(encoding="utf-8"))
    if manifest["device"] != args.serial:
        raise SystemExit("Backup belongs to a different device")
    before, after = manifest["fileHashes"], hashes(manifest["directories"])
    result = {"beforeFirstLaunch": True, "filesBefore": len(before), "filesAfter": len(after),
              "matched": sum(before.get(key) == value for key, value in after.items()),
              "added": sorted(after.keys() - before.keys()), "missing": sorted(before.keys() - after.keys()),
              "changed": sorted(key for key in before.keys() & after.keys() if before[key] != after[key]), "passed": before == after}
    (folder / "preservation-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
    if not result["passed"]:
        raise SystemExit(1)
