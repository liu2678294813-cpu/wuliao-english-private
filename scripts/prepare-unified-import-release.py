"""Apply only this task's baseline-to-result delta to an isolated checkout.

No changes to the source checkout's index or historical dirty/untracked files.
Three-way merge preserves independent remote modifications; conflicts stop release.
"""
import hashlib
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / "output/unified-import/20261009"
RELEASE = EVIDENCE / "release-source"
BASE = EVIDENCE / "baseline/files"
snapshot = json.loads((EVIDENCE / "baseline/manifest.json").read_text(encoding="utf-8-sig"))["files"]
known = [
    ".gitattributes",
    "android/app/build.gradle", "package.json", "pnpm-lock.yaml",
    "src/App.jsx", "src/ClozeLearningArchiveModal.jsx", "src/ClozeReader.jsx",
    "src/ClozeReviewSession.jsx", "src/ClozeSummaryPanel.jsx", "src/CustomDeepReader.jsx",
    "src/backup.js", "src/clozeParser.js", "src/clozeProgress.js", "src/clozeView.js",
    "src/libraryView.js", "src/pdfParser.js", "src/readingFlow.js", "src/storage.js", "src/todayTasks.js",
    "src/writing/ui/WritingLibrary.jsx", "src/writing/ui/WritingStages.jsx",
    "src/writing/ui/ImportedWritingLibrary.jsx", "src/writing/writingImportedMaterials.js",
    "scripts/test-cloze-view.mjs", "scripts/test-intense-reading-workflow.mjs",
    "scripts/test-r4-async-recovery.mjs", "scripts/test-r4-regressions.mjs", "scripts/test-today-tasks.mjs",
    "scripts/test-writing-question-ui.mjs", "scripts/test-writing-storage.mjs", "scripts/test-long-sentence-repository.mjs",
    "scripts/test-unified-import.mjs", "scripts/make-unified-import-fixtures.py",
    "scripts/patch-vocabulary-bundle.mjs", "scripts/test-writing-question-bank.mjs",
    "scripts/test-interaction-latency.mjs",
    "scripts/fixtures/writing-question-bank-coverage.json",
    "scripts/generate-unified-import-docs.py", "scripts/prepare-unified-import-release.py",
    "docs/统一导入系统设计.md", "docs/统一导入系统验收报告.md",
    "e2e/unified-import.spec.js", "public/tesseract/lang/chi_sim.traineddata.gz",
]
known += [str(p.relative_to(ROOT)).replace("\\", "/") for directory in (ROOT / "src/import", ROOT / "e2e/fixtures/unified-import") for p in directory.rglob("*") if p.is_file()]
inventory = []
conflicts = []
for name in sorted(set(known)):
    source = ROOT / name
    if not source.is_file():
        continue
    final = source.read_bytes()
    old = (BASE / name).read_bytes() if name in snapshot else b""
    if old == final:
        continue
    destination = RELEASE / name
    # Read the immutable remote baseline, including on a resumed preparation run.
    at_head = subprocess.run(["git", "-C", str(RELEASE), "show", f"HEAD:{name}"], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    remote = at_head.stdout if at_head.returncode == 0 else b""
    if remote == final:
        mode = "already-present"
    elif remote == old or not remote and not old:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(final)
        mode = "task-delta"
    elif b"\x00" in remote or b"\x00" in old or b"\x00" in final:
        conflicts.append(name)
        continue
    else:
        # Windows source files may be CRLF while the clean clone is LF.
        remote = remote.replace(b"\r\n", b"\n")
        old = old.replace(b"\r\n", b"\n")
        final = final.replace(b"\r\n", b"\n")
        with tempfile.TemporaryDirectory(dir=EVIDENCE) as temp:
            temp = pathlib.Path(temp)
            paths = [temp / n for n in ("remote", "baseline", "task")]
            for path, content in zip(paths, (remote, old, final)):
                path.write_bytes(content)
            merge = subprocess.run(["git", "merge-file", "-p", "--diff3", *map(str, paths)], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            if merge.returncode:
                conflicts.append(name)
                (EVIDENCE / (name.replace("/", "_") + ".conflict.txt")).write_bytes(merge.stdout)
                continue
            destination.write_bytes(merge.stdout)
            mode = "remote-preserved-three-way"
    inventory.append({"path": name, "mode": mode, "baselineSha256": hashlib.sha256(old).hexdigest(), "taskSha256": hashlib.sha256(final).hexdigest(), "releaseSha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
report = {"sourceBaselineHead": json.loads((EVIDENCE / "baseline/manifest.json").read_text(encoding="utf-8-sig"))["head"], "remoteBase": subprocess.check_output(["git", "-C", str(RELEASE), "rev-parse", "HEAD"]).decode().strip(), "files": inventory, "conflicts": conflicts}
(EVIDENCE / "release-delta.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"files": len(inventory), "conflicts": conflicts, "remoteBase": report["remoteBase"]}, ensure_ascii=False))
if conflicts:
    raise SystemExit("Release stopped: resolve the recorded task/remote conflicts first")
