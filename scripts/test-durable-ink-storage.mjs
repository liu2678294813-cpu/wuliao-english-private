import test from "node:test";
import assert from "node:assert/strict";
import { configureDurableInkStorage, hydrateDurableInk, readDurableInk, writeDurableInk, flushDurableInk, inkStorageStatus, reloadDurableInk } from "../src/durableInkStorage.js";
import { createDebouncedStorageWriter } from "../src/debouncedStorage.js";
import { createInkSnapshotSerializer, isSerializedInkSnapshot } from "../src/ink/inkSnapshot.js";

// Simulates request success followed by transaction abort, a real IDB failure
// that request-only tests miss. Each account has an independent identity.
const rows = new Map();
let failWrite = false;
let gate = null;
configureDurableInkStorage(async () => ({
  close() {},
  transaction(_store, mode) {
    const tx = { error: null };
    const operation = (fn, result) => {
      const request = {};
      queueMicrotask(async () => {
        request.result = result;
        request.onsuccess?.();
        if (gate && mode === "readwrite") await gate;
        if (failWrite && mode === "readwrite") { tx.error = new Error("disk full"); tx.onabort?.(); }
        else { fn?.(); tx.oncomplete?.(); }
      });
      return request;
    };
    tx.objectStore = () => ({
      index: () => ({ getAll: (username) => operation(null, [...rows.values()].filter((row) => row.username === username)) }),
      get: (id) => operation(null, rows.get(id)),
      put: (record) => operation(() => rows.set(record.id, structuredClone(record)), record.id),
      delete: (id) => operation(() => rows.delete(id), undefined),
    });
    return tx;
  },
}));
const key = "wuliao:deep-ink:v2:r:p:stage";

test("migration verifies committed records before deleting legacy, and survives rehydration", async () => {
  let removed = false;
  const value = JSON.stringify([{ points: [{ x: 0.2, y: 0.3 }] }]);
  await hydrateDurableInk("migration", [{ key, value }], () => {
    assert.equal(rows.get(JSON.stringify(["migration", key])).value, value);
    removed = true;
  });
  assert.equal(removed, true);
  await reloadDurableInk("migration");
  assert.equal(readDurableInk("migration", key), value);
});
test("transaction failure retains pending edit, old durable value and allows retry", async () => {
  await hydrateDurableInk("failure");
  writeDurableInk("failure", key, "[1]");
  await flushDurableInk("failure");
  failWrite = true;
  writeDurableInk("failure", key, "[1,2]");
  await assert.rejects(flushDurableInk("failure"), /disk full/);
  assert.equal(inkStorageStatus("failure"), "error");
  assert.equal(rows.get(JSON.stringify(["failure", key])).value, "[1]");
  assert.equal(readDurableInk("failure", key), "[1,2]");
  failWrite = false;
  await flushDurableInk("failure");
  assert.equal(rows.get(JSON.stringify(["failure", key])).value, "[1,2]");
});
test("rapid edits during slow transaction commit newest version and remain account isolated", async () => {
  await hydrateDurableInk("slow"); await hydrateDurableInk("other");
  let release;
  gate = new Promise((resolve) => { release = resolve; });
  writeDurableInk("slow", key, "[1]");
  await Promise.resolve();
  writeDurableInk("slow", key, "[1,2,3]");
  release(); gate = null;
  await flushDurableInk("slow");
  await reloadDurableInk("slow");
  assert.equal(readDurableInk("slow", key), "[1,2,3]");
  assert.equal(readDurableInk("other", key), null);
  writeDurableInk("slow", key, null);
  await flushDurableInk("slow"); await reloadDurableInk("slow");
  assert.equal(readDurableInk("slow", key), null);
});
test("corrupt source or failed migration never deletes legacy", async () => {
  let removed = false;
  await assert.rejects(hydrateDurableInk("corrupt", [{ key, value: "{broken" }], () => { removed = true; }));
  failWrite = true;
  await assert.rejects(hydrateDurableInk("migrate-fail", [{ key, value: "[]" }], () => { removed = true; }));
  failWrite = false;
  assert.equal(removed, false);
});
test("untouched text never writes on unmount; failed edited text can retry", () => {
  let writes = 0;
  let fail = true;
  const writer = createDebouncedStorageWriter({ read: () => "", write: () => { if (fail) throw new Error("quota"); writes++; }, remove() {}, schedule() { return 1; }, cancel() {}, delay: 300 });
  writer.flush(); assert.equal(writes, 0);
  writer.setLatest("draft"); assert.throws(writer.flush, /quota/);
  fail = false; writer.flush(); writer.flush(); assert.equal(writes, 1);
});

test("append snapshots preserve exact legacy JSON, including pressure and region coordinates", () => {
  const serialize = createInkSnapshotSerializer();
  let strokes = [];
  for (let i = 0; i < 200; i++) {
    strokes = [...strokes, {
      tool: "pen", width: 2.6, color: "#111", coordinateSpace: "deep-region-v2",
      deepAnchor: { version: 2, regionId: 'sentence:引号"\\\n' },
      points: Array.from({ length: 40 }, (_, j) => ({
        x: (i + j) / 500, y: j / 41, pressure: j / 40, tiltX: 12,
        deepLocal: { x: j / 40, y: i / 200 },
      })),
    }];
    const snapshot = serialize(key, strokes, { appendOnly: true });
    assert.equal(snapshot.json, JSON.stringify(strokes));
    assert.equal(String(snapshot), snapshot.json);
    assert.ok(isSerializedInkSnapshot(snapshot));
    assert.ok(Object.isFrozen(snapshot));
  }
});

test("append serialization does not revisit historical points; structural edits and scopes invalidate it", () => {
  const serialize = createInkSnapshotSerializer();
  let visits = 0;
  const first = { get points() { visits++; return [{ x: .2, y: .3 }]; } };
  serialize(key, [first]);
  const second = { points: [{ x: .4, y: .5 }] };
  const appended = serialize(key, [first, second], { appendOnly: true });
  assert.equal(visits, 1);
  second.points[0].x = .6;
  assert.equal(serialize(key, [first, second]).json, JSON.stringify([first, second]));
  assert.equal(serialize(key, [second], { appendOnly: true }).json, JSON.stringify([second]));
  assert.equal(serialize("other-stage", [first], { appendOnly: true }).json, JSON.stringify([first]));
  assert.equal(serialize(key, [], { appendOnly: true }).json, "[]");
  assert.notEqual(appended.json, JSON.stringify([first, second]));
});

test("serialization failure retains the last valid snapshot and can retry without dropping a stroke", () => {
  const serialize = createInkSnapshotSerializer();
  const first = { points: [{ x: .2, y: .3 }] };
  serialize(key, [first]);
  const second = { points: [] };
  second.self = second;
  assert.throws(() => serialize(key, [first, second], { appendOnly: true }), /circular/i);
  delete second.self;
  assert.equal(serialize(key, [first, second], { appendOnly: true }).json, JSON.stringify([first, second]));
});

test("serialized snapshots retain transaction retry, disk format, and corrupt-string validation", async () => {
  await hydrateDurableInk("snapshot");
  const serialize = createInkSnapshotSerializer();
  const strokes = [{ points: [{ x: .2, y: .3 }] }];
  writeDurableInk("snapshot", key, serialize(key, strokes));
  await flushDurableInk("snapshot");
  failWrite = true;
  const next = [...strokes, { points: [{ x: .4, y: .5 }] }];
  writeDurableInk("snapshot", key, serialize(key, next, { appendOnly: true }));
  await assert.rejects(flushDurableInk("snapshot"), /disk full/);
  assert.equal(readDurableInk("snapshot", key), JSON.stringify(next));
  assert.equal(rows.get(JSON.stringify(["snapshot", key])).value, JSON.stringify(strokes));
  failWrite = false;
  await flushDurableInk("snapshot");
  await reloadDurableInk("snapshot");
  assert.equal(readDurableInk("snapshot", key), JSON.stringify(next));
  assert.throws(() => writeDurableInk("snapshot", key, "{broken"));
  const forged = { json: "{broken" };
  assert.equal(isSerializedInkSnapshot(forged), false);
  assert.throws(() => writeDurableInk("snapshot", key, forged));
  assert.equal(readDurableInk("snapshot", key), JSON.stringify(next));
});
