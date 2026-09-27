// Completed ink strokes are immutable. Reuse only an explicitly append-only
// prefix; deletion callers may explicitly reuse unchanged immutable strokes.
// Tokens attest that the JSON came from JSON.stringify, not from imported text.
// They exist only in memory; storage and backups still receive the same string.
const snapshots = new WeakSet();

export function isSerializedInkSnapshot(value) {
  return snapshots.has(value);
}

export function createInkSnapshotSerializer() {
  let previous = null;
  let encoded = new WeakMap();
  let scope;
  return (key, strokes, { appendOnly = false, reuseUnchanged = false } = {}) => {
    if (!Array.isArray(strokes)) throw new TypeError("Ink snapshot must be an array");
    if (scope !== key || (!appendOnly && !reuseUnchanged)) { encoded = new WeakMap(); scope = key; }
    const encode = (stroke) => {
      if (!stroke || typeof stroke !== "object") return JSON.stringify(stroke) ?? "null";
      if (!encoded.has(stroke)) encoded.set(stroke, JSON.stringify(stroke) ?? "null");
      return encoded.get(stroke);
    };
    const reuse = appendOnly && previous?.key === key
      && previous.strokes.length <= strokes.length
      && previous.strokes.every((stroke, index) => stroke === strokes[index]);
    let json;
    if (reuse) {
      const added = strokes.slice(previous.strokes.length).map(encode).join(",");
      json = added
        ? `${previous.snapshot.json.slice(0, -1)}${previous.strokes.length ? "," : ""}${added}]`
        : previous.snapshot.json;
    } else {
      json = `[${strokes.map(encode).join(",")}]`;
    }
    const snapshot = Object.freeze({ json, toString() { return this.json; } });
    snapshots.add(snapshot);
    // Update only after successful serialization so failures retain the prefix.
    previous = { key, strokes: strokes.slice(), snapshot };
    return snapshot;
  };
}
