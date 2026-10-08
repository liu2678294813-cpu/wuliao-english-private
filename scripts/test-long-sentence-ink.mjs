import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { getLongSentenceInkSnapshot, saveLongSentenceInkSnapshot, longSentenceInkIdentity, LONG_SENTENCE_INK_STORE } from "../src/longSentence/ink.js";
import { createWritingInkAdapter } from "../src/writing/writingInkAdapter.js";
import { pointerPointFromSample, resizeInkCanvas } from "../src/annotationTools.js";
import { createWritingPageGeometrySnapshot, finalizeWritingStrokeGeometry, projectWritingStroke } from "../src/writing/writingInkGeometry.js";

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const names = (map) => ({ contains: (name) => map.has(name) });

// Transaction-complete fake includes rollback after put success: the failure
// case must not be mistaken for a durable save by the ink repository.
function database() {
  const stores = new Map();
  let failCommit = false;
  const db = {
    version: 7, objectStoreNames: names(stores), close() {},
    createObjectStore(name) {
      const definition = { records: new Map(), indexes: new Set() };
      stores.set(name, definition);
      return { createIndex(index) { definition.indexes.add(index); } };
    },
    transaction(name, mode) {
      const definition = stores.get(name);
      if (!definition) throw new Error(`Missing store: ${name}`);
      const records = new Map(definition.records);
      let pending = 0;
      let stopped = false;
      let finishQueued = false;
      const tx = {
        abort() { if (stopped) return; stopped = true; queueMicrotask(() => tx.onabort?.()); },
        objectStore() {
          const request = (action) => {
            const req = {};
            pending++;
            queueMicrotask(() => {
              if (stopped) return;
              try { req.result = action(); req.onsuccess?.(); }
              catch (error) { req.error = error; req.onerror?.(); }
              pending--;
              finish();
            });
            return req;
          };
          return {
            indexNames: names(definition.indexes),
            createIndex(index) { definition.indexes.add(index); },
            get(key) { return request(() => clone(records.get(key))); },
            put(value) { return request(() => { records.set(value.id, clone(value)); return value.id; }); },
          };
        },
      };
      function finish() {
        if (stopped || pending || finishQueued) return;
        finishQueued = true;
        queueMicrotask(() => {
          finishQueued = false;
          if (stopped || pending) return;
          if (mode === "readwrite" && failCommit) {
            failCommit = false;
            tx.error = new Error("quota abort after successful put");
            tx.abort();
            return;
          }
          stopped = true;
          if (mode === "readwrite") definition.records = records;
          tx.oncomplete?.();
        });
      }
      queueMicrotask(finish);
      return tx;
    },
  };
  // Existing database capabilities; parent migration adds the feature store.
  for (const name of ["reader-ink", "custom-pdfs", "unknown-words", "pdf-parse-cache", "exam-ink", "writing-ink", "device-private-writing-samples", LONG_SENTENCE_INK_STORE]) {
    db.createObjectStore(name);
  }
  return {
    stores,
    failNextCommit() { failCommit = true; },
    indexedDb: {
      open(_name, version) {
        const req = {};
        queueMicrotask(() => {
          req.result = db;
          if (version > db.version) {
            const oldVersion = db.version;
            req.transaction = { objectStore(name) { return db.transaction(name).objectStore(name); } };
            db.version = version;
            req.onupgradeneeded?.({ oldVersion, target: req });
          }
          req.onsuccess?.();
        });
        return req;
      },
    },
  };
}

const identity = (overrides = {}) => longSentenceInkIdentity({
  username: "alice", sessionId: "session-1", itemId: "item:1", attemptId: "attempt:1", sourceFingerprint: "sentence-and-layout-v1", ...overrides,
});
const stroke = { id: "s1", tool: "pen", color: "#173a62", size: 2.6, points: [{ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.2 }] };

test("attempt ink persists and restores independently across accounts/items/attempts", async () => {
  const db = database();
  const args = { ...identity(), indexedDb: db.indexedDb };
  const first = await saveLongSentenceInkSnapshot({ ...args, strokes: [stroke], expectedRevision: 0 });
  const restored = await getLongSentenceInkSnapshot({ ...args, expectedSourceFingerprint: args.sourceFingerprint });
  assert.equal(restored.status, "ok");
  assert.deepEqual(restored.snapshot, first);
  for (const override of [{ username: "bob" }, { itemId: "item:2" }, { attemptId: "attempt:2" }]) {
    const other = await getLongSentenceInkSnapshot({ ...identity(override), indexedDb: db.indexedDb });
    assert.equal(other.status, "missing");
  }
  assert.equal(db.stores.get("writing-ink").records.size, 0);
  assert.equal(db.stores.get("unknown-words").records.size, 0);
});

test("ink rejects stale revision, changed source, and damaged snapshots", async () => {
  const db = database();
  const args = { ...identity(), indexedDb: db.indexedDb, strokes: [stroke], expectedRevision: 0 };
  const saved = await saveLongSentenceInkSnapshot(args);
  await assert.rejects(saveLongSentenceInkSnapshot(args), { code: "stale-revision" });
  await assert.rejects(saveLongSentenceInkSnapshot({ ...args, expectedRevision: 1, sourceFingerprint: "new-layout" }), { code: "source-mismatch" });
  const mismatch = await getLongSentenceInkSnapshot({ ...args, expectedSourceFingerprint: "new-layout" });
  assert.equal(mismatch.status, "source-mismatch");
  db.stores.get(LONG_SENTENCE_INK_STORE).records.get(saved.id).strokes = [];
  assert.equal((await getLongSentenceInkSnapshot(args)).status, "damaged");
  await assert.rejects(saveLongSentenceInkSnapshot({ ...args, expectedRevision: 1 }), { code: "damaged" });
});

test("invalid attempt ownership and missing feature store fail without touching old stores", async () => {
  const db = database();
  const args = { ...identity(), indexedDb: db.indexedDb, strokes: [stroke], expectedRevision: 0 };
  await assert.rejects(saveLongSentenceInkSnapshot({ ...args, ownerRecordId: "other-attempt" }), { code: "identity-mismatch" });
  // Simulate the verified v7 fallback returned by the common database opener.
  await getLongSentenceInkSnapshot(args);
  db.stores.delete(LONG_SENTENCE_INK_STORE);
  await assert.rejects(saveLongSentenceInkSnapshot(args), { code: "storage-unavailable" });
  assert.equal(db.stores.get("writing-ink").records.size, 0);
  assert.equal(db.stores.get("unknown-words").records.size, 0);
});

test("put success followed by transaction abort preserves retryable adapter ink", async () => {
  const db = database();
  const persistence = {
    getSnapshot: (args) => getLongSentenceInkSnapshot({ ...args, indexedDb: db.indexedDb }),
    saveSnapshot: (args) => saveLongSentenceInkSnapshot({ ...args, indexedDb: db.indexedDb }),
  };
  const adapter = createWritingInkAdapter({ ...persistence, autosaveDelay: 60000 });
  await adapter.attach(identity());
  adapter.replaceCommitted([stroke]);
  db.failNextCommit();
  await assert.rejects(adapter.flush());
  assert.equal(adapter.getState().dirty, true);
  assert.deepEqual(adapter.getState().strokes, [stroke]);
  assert.equal(db.stores.get(LONG_SENTENCE_INK_STORE).records.size, 0);
  await adapter.flush();
  assert.equal(adapter.getState().dirty, false);
  const other = identity({ attemptId: "attempt:2" });
  await adapter.attach(other);
  assert.deepEqual(adapter.getState().strokes, []);
  await adapter.attach(identity());
  assert.deepEqual(adapter.getState().strokes, [stroke]);
  adapter.replaceCommitted([stroke, { ...stroke, id: "s2" }]);
  await adapter.flush();
  adapter.undo();
  await adapter.flush();
  assert.deepEqual((await persistence.getSnapshot(identity())).snapshot.strokes, [stroke]);
  adapter.clear();
  await adapter.flush();
  assert.deepEqual((await persistence.getSnapshot(identity())).snapshot.strokes, []);
  await adapter.dispose();
});

test("scaled paper keeps canvas and restored stroke at the same logical text position", async () => {
  const { createViteModuleRunner } = await import("./vite-module-runner.mjs");
  const vite = await createViteModuleRunner(fileURLToPath(new URL("..", import.meta.url)));
  try {
    const { measureWritingInkSurface } = await vite.import("/src/writing/WritingInkSurface.jsx");
    for (const scale of [1, 0.65, 0.4]) {
      const rect = { left: 40, top: 80, width: 800 * scale, height: 480 * scale };
      const surface = { getBoundingClientRect: () => rect };
      const dimensions = measureWritingInkSurface(surface, 1.5, { width: 800, height: 480 });
      assert.deepEqual(dimensions, { width: 800, height: 480, ratio: 1.5 });
      const canvas = { style: {}, dataset: {}, getContext: () => ({}) };
      resizeInkCanvas(canvas, dimensions.width, dimensions.height, dimensions.ratio);
      assert.equal(canvas.style.width, "800px");
      const point = pointerPointFromSample({ clientX: rect.left + 240 * scale, clientY: rect.top + 120 * scale }, rect, true).normalized;
      const geometry = createWritingPageGeometrySnapshot(surface, [{ pageId: "item:1", element: surface }]);
      const stored = finalizeWritingStrokeGeometry({ ...stroke, points: [point] }, geometry);
      const projected = projectWritingStroke(stored, geometry);
      assert.ok(Math.abs(projected.points[0].x * dimensions.width - 240) < 1e-9);
      assert.ok(Math.abs(projected.points[0].y * dimensions.height - 120) < 1e-9);
      // Writing default remains viewport-sized when no logical paper is supplied.
      assert.equal(measureWritingInkSurface(surface, 1).width, rect.width);
    }
  } finally { await vite.close(); }
});
