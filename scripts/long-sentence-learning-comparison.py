"""Compare counts and hashed learning values; never print credentials or content."""
import json
from pathlib import Path

folder = Path(__file__).resolve().parent.parent / "output/long-sentence/20260929-104646"
before = json.loads((folder / "device-learning-before.json").read_text(encoding="utf-8"))
after = json.loads((folder / "device-learning-after.json").read_text(encoding="utf-8"))
stores = {name: {"before": value["count"], "after": after["stores"].get(name, {}).get("count")}
          for name, value in before["stores"].items()}
changed = [key for key, value in before["local"].items() if after["local"].get(key) != value]
learning_markers = ("translation-progress:", "review-task:", "reading-review", "reading-flow:", "deep-answers:",
                    "question-evidence:", "deep-translations:", "deep-notes:", "writing:", "vocab")
learning_changes = [key for key in changed if any(marker in key for marker in learning_markers)]
new_stores = {name: value["count"] for name, value in after["stores"].items() if name not in before["stores"]}
result = {"databaseVersionBefore": before["dbVersion"], "databaseVersionAfter": after["dbVersion"],
          "existingStoreCounts": stores, "newStoreCounts": new_stores,
          "localKeysBefore": len(before["local"]), "localKeysAfter": len(after["local"]),
          "originalLearningValueChanges": learning_changes, "otherValueChanges": changed,
          "allOriginalLocalValuesUnchanged": not changed,
          "passed": not learning_changes and all(v["before"] == v["after"] for v in stores.values())
                    and before["dbVersion"] == 7 and after["dbVersion"] == 8,
          "limits": "After-startup counts do not prove record content equality. Exact private file hashes before first launch provide the complementary preservation evidence."}
(folder / "learning-preservation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"passed": result["passed"], "storeCounts": stores, "newStores": new_stores,
                  "originalLearningValueChanges": len(learning_changes), "otherValueChanges": len(changed)}))
if not result["passed"]:
    raise SystemExit(1)
