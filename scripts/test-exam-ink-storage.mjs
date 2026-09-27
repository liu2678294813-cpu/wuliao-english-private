import test from "node:test";
import assert from "node:assert/strict";

import {
  EXAM_INK_STORE,
  WULIAO_ENGLISH_DB_VERSION,
  openWuliaoEnglishDatabase,
} from "../src/storage.js";
import {
  EXAM_INK_SURFACES,
  ExamInkStaleRevisionError,
  ExamInkStorageError,
  clearExamInkSnapshot,
  examSurfaceIdForItem,
  getExamInkSnapshot,
  saveExamInkSnapshot,
} from "../src/exam/examInkStorage.js";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nameList(names) {
  return { contains: (name) => names.has(name) };
}

class FakeStoreDefinition {
  constructor(keyPath) {
    this.keyPath = keyPath;
    this.records = new Map();
    this.indexes = new Set();
    this.indexNames = nameList(this.indexes);
  }

  createIndex(name) {
    this.indexes.add(name);
  }
}

class FakeObjectStore {
  constructor(definition, transaction) {
    this.definition = definition;
    this.transaction = transaction;
    this.indexNames = definition.indexNames;
  }

  createIndex(name) {
    this.definition.createIndex(name);
  }

  get(key) {
    return this.transaction.request(() => clone(this.definition.records.get(key)) || null);
  }

  put(value) {
    return this.transaction.request(() => {
      this.definition.records.set(value[this.definition.keyPath], clone(value));
      return value[this.definition.keyPath];
    });
  }
}

class FakeTransaction {
  constructor(database) {
    this.database = database;
    this.pending = 0;
    this.completed = false;
    this.aborted = false;
    queueMicrotask(() => this.finishIfIdle());
  }

  objectStore(name) {
    const definition = this.database.stores.get(name);
    if (!definition) throw new Error(`Missing store ${name}`);
    return new FakeObjectStore(definition, this);
  }

  request(run) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending += 1;
    queueMicrotask(() => {
      if (this.aborted) return;
      try {
        request.result = run();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      } finally {
        this.pending -= 1;
        this.finishIfIdle();
      }
    });
    return request;
  }

  abort() {
    if (this.aborted || this.completed) return;
    this.aborted = true;
    queueMicrotask(() => this.onabort?.({ target: this }));
  }

  finishIfIdle() {
    if (this.aborted || this.completed || this.pending) return;
    queueMicrotask(() => {
      if (this.aborted || this.completed || this.pending) return;
      this.completed = true;
      this.oncomplete?.({ target: this });
    });
  }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.stores = new Map();
    this.objectStoreNames = nameList(this.stores);
  }

  createObjectStore(name, options = {}) {
    if (this.stores.has(name)) throw new Error(`Store ${name} already exists`);
    const store = new FakeStoreDefinition(options.keyPath || "id");
    this.stores.set(name, store);
    return store;
  }

  transaction(name) {
    if (!this.stores.has(name)) throw new Error(`Missing store ${name}`);
    return new FakeTransaction(this);
  }

  close() {}
}

class FakeIndexedDb {
  constructor() {
    this.databasesByName = new Map();
  }

  seed(name, version) {
    const database = new FakeDatabase(name, version);
    this.databasesByName.set(name, database);
    return database;
  }

  open(name, version) {
    const request = { result: null, error: null, transaction: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        let database = this.databasesByName.get(name);
        if (!database) {
          database = this.seed(name, 0);
        }
        request.result = database;
        if (version > database.version) {
          request.transaction = new FakeTransaction(database);
          database.version = version;
          request.onupgradeneeded?.({ target: request });
        }
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
    });
    return request;
  }
}

function createV3Database() {
  const indexedDb = new FakeIndexedDb();
  const database = indexedDb.seed("wuliao-english", 3);
  const customPdfs = database.createObjectStore("custom-pdfs", { keyPath: "id" });
  customPdfs.createIndex("username");
  customPdfs.createIndex("fingerprint");
  customPdfs.records.set("keep", { id: "keep", username: "alice", title: "existing.pdf" });
  const unknownWords = database.createObjectStore("unknown-words", { keyPath: "id" });
  unknownWords.createIndex("username");
  unknownWords.createIndex("usernameResource");
  const cache = database.createObjectStore("pdf-parse-cache", { keyPath: "cacheKey" });
  cache.createIndex("fingerprint");
  return indexedDb;
}

test("v3 升级到 v4 只新增 exam-ink，既有数据不迁移或改写", async () => {
  const indexedDb = createV3Database();
  const database = await openWuliaoEnglishDatabase(indexedDb);
  assert.equal(database.version, WULIAO_ENGLISH_DB_VERSION);
  assert.equal(database.objectStoreNames.contains(EXAM_INK_STORE), true);
  assert.equal(database.stores.get("custom-pdfs").records.get("keep").title, "existing.pdf");
  assert.equal(database.stores.get(EXAM_INK_STORE).keyPath, "id");
  assert.equal(database.stores.get(EXAM_INK_STORE).indexNames.contains("username"), true);
  assert.equal(database.stores.get(EXAM_INK_STORE).indexNames.contains("sessionId"), true);
  database.close();
});

test("exam ink 每个账号/Session/Text 覆盖当前 snapshot，revision 仅作 stale guard", async () => {
  const indexedDb = createV3Database();
  const base = {
    username: "alice",
    sessionId: "x1-1",
    surfaceId: "reading:text-1",
    sourceFingerprint: "source-a",
    indexedDb,
  };
  const first = await saveExamInkSnapshot({ ...base, strokes: [[{ x: 1, y: 2 }]], expectedRevision: 0, now: 10 });
  assert.equal(first.revision, 1);
  assert.equal(first.fingerprint.startsWith("fnv-"), true);

  await assert.rejects(
    saveExamInkSnapshot({ ...base, strokes: [], expectedRevision: 0, now: 11 }),
    (error) => error instanceof ExamInkStaleRevisionError && error.actualRevision === 1,
  );
  await assert.rejects(
    saveExamInkSnapshot({ ...base, sourceFingerprint: "source-b", strokes: [], expectedRevision: 1, now: 12 }),
    (error) => error instanceof ExamInkStorageError && error.code === "source-mismatch",
  );

  const second = await saveExamInkSnapshot({ ...base, strokes: [[{ x: 3, y: 4 }]], expectedRevision: 1, now: 13 });
  assert.equal(second.revision, 2);
  const loaded = await getExamInkSnapshot({ ...base, expectedSourceFingerprint: "source-a" });
  assert.equal(loaded.status, "ok");
  loaded.snapshot.strokes[0][0].x = 99;
  assert.equal((await getExamInkSnapshot(base)).snapshot.strokes[0][0].x, 3, "read result must not mutate persisted strokes");

  const cleared = await clearExamInkSnapshot({ ...base, sourceFingerprint: "source-b", expectedRevision: 2, now: 14 });
  assert.equal(cleared.revision, 3);
  assert.deepEqual(cleared.strokes, []);
  assert.equal((await getExamInkSnapshot(base)).snapshot.sourceFingerprint, "source-b");
  assert.deepEqual(
    await getExamInkSnapshot({ ...base, expectedSourceFingerprint: "source-a" }),
    { status: "source-mismatch", snapshot: null, revision: 3 },
  );

  indexedDb.databasesByName.get("wuliao-english").stores.get(EXAM_INK_STORE).records.set(cleared.id, {
    ...cleared,
    fingerprint: "tampered",
  });
  assert.deepEqual(await getExamInkSnapshot(base), { status: "damaged", snapshot: null, revision: 3 });
});

test("exam ink 支持五个正式 Surface（cloze:main + 四个 Reading Text），拒绝未知 surface", async () => {
  const indexedDb = createV3Database();
  for (const surfaceId of EXAM_INK_SURFACES) {
    const saved = await saveExamInkSnapshot({
      username: "alice",
      sessionId: "x1-2",
      surfaceId,
      sourceFingerprint: "source",
      strokes: [],
      expectedRevision: 0,
      indexedDb,
    });
    assert.equal(saved.surfaceId, surfaceId);
  }
  await assert.rejects(
    saveExamInkSnapshot({
      username: "alice",
      sessionId: "x1-2",
      surfaceId: "reading:text-5",
      sourceFingerprint: "source",
      strokes: [],
      indexedDb,
    }),
    (error) => error instanceof ExamInkStorageError && error.code === "invalid-surface",
  );
  await assert.rejects(
    saveExamInkSnapshot({
      username: "alice",
      sessionId: "x1-2",
      surfaceId: "cloze:other",
      sourceFingerprint: "source",
      strokes: [],
      indexedDb,
    }),
    (error) => error instanceof ExamInkStorageError && error.code === "invalid-surface",
  );
});

test("examSurfaceIdForItem 是唯一 Surface 判断（cloze → cloze:main，Text N → reading:text-N）", () => {
  assert.equal(examSurfaceIdForItem({ section: "cloze", resourceId: "postgraduate-2020-cloze" }), "cloze:main");
  assert.equal(examSurfaceIdForItem({ section: "reading", resourceId: "postgraduate-2020-english1-text-1" }), "reading:text-1");
  assert.equal(examSurfaceIdForItem({ section: "reading", resourceId: "postgraduate-2020-english1-text-4" }), "reading:text-4");
  assert.equal(examSurfaceIdForItem({ section: "reading", resourceId: "unknown" }), null);
  assert.equal(examSurfaceIdForItem(null), null);
  assert.equal(examSurfaceIdForItem(undefined), null);
});
