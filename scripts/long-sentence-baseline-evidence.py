"""Supplement clean-file originals from the saved HEAD without changing the worktree."""
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
baseline = root / "output/long-sentence/20260929-104646"
head = (baseline / "head.txt").read_text(encoding="utf-8-sig").strip()
paths = subprocess.check_output(["git", "diff", "--name-only", "-z"], cwd=root).decode("utf-8").split("\0")
initial_dirty = {line[3:].strip().strip('"') for line in (baseline / "status.txt").read_text(encoding="utf-8-sig").splitlines() if line and not line.startswith("??")}
rows = []
for name in filter(None, paths):
    target = baseline / "originals" / name
    if not target.exists():
        original = subprocess.check_output(["git", "show", f"{head}:{name}"], cwd=root)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(original)
        origin = "saved HEAD, initially clean tracked file"
    else:
        origin = "pre-edit worktree snapshot" if name in initial_dirty else "saved HEAD, initially clean tracked file"
    rows.append({"path": name, "origin": origin, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
(baseline / "originals-manifest.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"originals": len(rows), "manifest": str(baseline / "originals-manifest.json")}, ensure_ascii=False))
