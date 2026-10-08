"""Sequential Android emulator smoke runner. Never selects a physical device.

Prerequisite: create an AVD as described in docs/Android-兼容性复测指南.md.
Uses the project SDK and records BLOCKED if the emulator/AVD is unavailable.
"""
import argparse
import json
import os
import pathlib
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
SDK = ROOT / ".android-sdk"
parser = argparse.ArgumentParser()
parser.add_argument("--avd", required=True)
parser.add_argument("--apk", default="output/android/wuliao-english-android.apk")
parser.add_argument("--output", default="output/android-compat-20261008/emulator")
parser.add_argument("--port", type=int, default=5580)
args = parser.parse_args()
out = (ROOT / args.output).resolve()
if not out.is_relative_to(ROOT / "output"):
    raise SystemExit("Evidence must stay inside project output")
if args.port % 2 or not 5554 <= args.port <= 5682:
    raise SystemExit("Use an even emulator port from 5554 through 5682")
out.mkdir(parents=True, exist_ok=True)
emulator = SDK / "emulator/emulator.exe"
adb_path = SDK / "platform-tools/adb.exe"
serial = f"emulator-{args.port}"
report = {"avd": args.avd, "serial": serial, "status": "NOT_RUN", "checks": []}
process = None
rotation = None


def run(command, timeout=60):
    return subprocess.check_output([str(x) for x in command], cwd=ROOT, timeout=timeout,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def adb(*argv, timeout=60):
    return run([adb_path, "-s", serial, *argv], timeout)


try:
    if not emulator.exists():
        report.update(status="BLOCKED", reason="Project SDK has no emulator binary/system image; see runbook")
    elif args.avd not in run([emulator, "-list-avds"]).decode().splitlines():
        report.update(status="BLOCKED", reason="Requested AVD does not exist")
    elif not (ROOT / args.apk).is_file():
        report.update(status="BLOCKED", reason="APK is missing; build first")
    else:
        devices = run([adb_path, "devices"]).decode()
        if serial in devices:
            raise RuntimeError("Emulator port already in use; refusing to alter an existing session")
        with (out / "emulator.log").open("wb") as log:
            process = subprocess.Popen([str(emulator), "-avd", args.avd, "-port", str(args.port),
                                        "-no-window", "-no-audio", "-no-snapshot-save", "-memory", "2048"],
                                       stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            deadline = time.monotonic() + 240
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("Emulator exited before boot; check acceleration and emulator.log")
                try:
                    if adb("shell", "getprop", "sys.boot_completed", timeout=5).strip() == b"1":
                        break
                except (subprocess.SubprocessError, OSError):
                    pass
                time.sleep(2)
            else:
                raise RuntimeError("Android boot timeout")
            report["api"] = adb("shell", "getprop", "ro.build.version.sdk").decode().strip()
            report["size"] = adb("shell", "wm", "size").decode().strip()
            report["density"] = adb("shell", "wm", "density").decode().strip()
            (out / "webview.txt").write_bytes(adb("shell", "dumpsys", "webviewupdate"))
            (out / "install.txt").write_bytes(adb("install", "-r", str(ROOT / args.apk), timeout=180))
            launch = adb("shell", "am", "start", "-W", "-n", "com.wuliao.english/.MainActivity")
            (out / "launch.txt").write_bytes(launch)
            adb("shell", "pidof", "com.wuliao.english")
            (out / "portrait.png").write_bytes(adb("exec-out", "screencap", "-p"))
            rotation = [adb("shell", "settings", "get", "system", name).decode().strip()
                        for name in ("accelerometer_rotation", "user_rotation")]
            adb("shell", "settings", "put", "system", "accelerometer_rotation", "0")
            adb("shell", "settings", "put", "system", "user_rotation", "1")
            time.sleep(2)
            (out / "landscape.png").write_bytes(adb("exec-out", "screencap", "-p"))
            adb("shell", "input", "keyevent", "KEYCODE_HOME")
            adb("shell", "am", "start", "-W", "-n", "com.wuliao.english/.MainActivity")
            adb("shell", "pidof", "com.wuliao.english")
            # This bounded lifecycle smoke does not claim UI/business acceptance.
            pid = adb("shell", "pidof", "com.wuliao.english").decode().strip().split()[0]
            logcat = adb("logcat", "-d", "--pid", pid, "-t", "1000").decode(errors="replace")
            (out / "logcat.txt").write_text(logcat, encoding="utf8")
            if "FATAL EXCEPTION" in logcat or "ANR in com.wuliao.english" in logcat:
                raise RuntimeError("Crash/ANR detected")
            report.update(status="PASS", checks=["install", "launch/pid", "rotation commands", "background/resume", "logcat"],
                          businessAcceptance="NOT_RUN: run WebView acceptance separately", physicalStylus="NOT_RUN")
except (OSError, subprocess.SubprocessError, RuntimeError) as error:
    report.update(status="FAIL", reason=str(error))
finally:
    if process is not None:
        if rotation:
            for name, value in zip(("accelerometer_rotation", "user_rotation"), rotation):
                try:
                    if value == "null": adb("shell", "settings", "delete", "system", name)
                    else: adb("shell", "settings", "put", "system", name, value)
                except (OSError, subprocess.SubprocessError): pass
        try: adb("emu", "kill", timeout=10)
        except (OSError, subprocess.SubprocessError): process.terminate()
    (out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(report, ensure_ascii=False))
raise SystemExit(0 if report["status"] == "PASS" else 2 if report["status"] == "BLOCKED" else 1)
