import test from "node:test";
import assert from "node:assert/strict";

const copy = (value) => structuredClone(value);
const names = (set) => ({ contains: (name) => set.has(name) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const compare = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      const difference = compare(a[index], b[index]);
      if (difference) return difference;
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

class FakeTransaction {
  constructor(db, storeNames) {
    this.db = db;
    this.storeNames = storeNames;
    this.pending = 0;
    this.aborted = false;
    this.done = false;
    this.before = new Map(storeNames.map((name) => [name, copy(db.stores.get(name).records)]));
    queueMicrotask(() => this.finish());
  }
  objectStore(name) {
    if (!this.storeNames.includes(name)) throw new Error(`store ${name} outside transaction`);
    return new FakeStore(this.db.stores.get(name), this);
  }
  request(run) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending += 1;
    queueMicrotask(() => {
      if (this.aborted) return;
      try { req.result = run(); req.onsuccess?.({ target: req }); }
      catch (error) { req.error = error; req.onerror?.({ target: req }); this.abort(); }
      finally { this.pending -= 1; this.finish(); }
    });
    return req;
  }
  abort() {
    if (this.aborted || this.done) return;
    this.aborted = true;
    for (const [name, records] of this.before) this.db.stores.get(name).records = records;
    queueMicrotask(() => this.onabort?.({ target: this }));
  }
  finish() {
    if (this.aborted || this.done || this.pending) return;
    queueMicrotask(() => {
      if (this.aborted || this.done || this.pending) return;
      this.done = true;
      this.oncomplete?.({ target: this });
    });
  }
}

class FakeIndex {
  constructor(definition, name, transaction) { Object.assign(this, { definition, name, transaction }); }
  values(key) {
    const path = this.definition.indexes.get(this.name);
    const indexKey = (value) => Array.isArray(path) ? path.map((part) => value[part]) : value[path];
    return [...this.definition.records.values()].filter((value) => {
      const candidate = indexKey(value);
      if (this.name === "usernameDue" && typeof candidate?.[1] !== "string") return false;
      return key?.lower ? compare(candidate, key.lower) >= 0 && compare(candidate, key.upper) <= 0 : same(candidate, key);
    }).sort((a, b) => compare(indexKey(a), indexKey(b))).map(copy);
  }
  getAll(key) { return this.transaction.request(() => this.values(key)); }
  count(key) { return this.transaction.request(() => this.values(key).length); }
  openCursor(key, direction = "next") {
    const values = this.values(key);
    if (direction === "prev") values.reverse();
    let position = 0;
    const request = { result: null, onsuccess: null, onerror: null, error: null };
    this.transaction.pending += 1;
    const advance = () => queueMicrotask(() => {
      if (this.transaction.aborted) return;
      const value = values[position++];
      let continued = false;
      request.result = value ? { value, continue: () => { continued = true; advance(); } } : null;
      request.onsuccess?.({ target: request });
      if (!continued) { this.transaction.pending -= 1; this.transaction.finish(); }
    });
    advance();
    return request;
  }
}

class FakeStore {
  constructor(definition, transaction) { this.definition = definition; this.transaction = transaction; this.keyPath = definition.keyPath; this.indexNames = names(definition.indexes); }
  createIndex(name, path) { this.definition.indexes.set(name, path); }
  get(id) { return this.transaction.request(() => copy(this.definition.records.get(id) || null)); }
  put(value) { return this.transaction.request(() => { this.definition.records.set(value.id, copy(value)); return value.id; }); }
  add(value) { return this.transaction.request(() => {
    if (this.definition.records.has(value.id)) throw new Error("duplicate key");
    this.definition.records.set(value.id, copy(value)); return value.id;
  }); }
  delete(id) { return this.transaction.request(() => this.definition.records.delete(id)); }
  index(name) {
    if (!this.definition.indexes.has(name)) throw new Error(`missing index ${name}`);
    return new FakeIndex(this.definition, name, this.transaction);
  }
}

class FakeDb {
  constructor(version = 8) { this.version = version; this.stores = new Map(); this.objectStoreNames = names(this.stores); }
  createObjectStore(name, options = {}) {
    const definition = { keyPath: options.keyPath || "id", records: new Map(), indexes: new Map() };
    this.stores.set(name, definition);
    return new FakeStore(definition, { request() {} });
  }
  transaction(storeNames) {
    const list = Array.isArray(storeNames) ? storeNames : [storeNames];
    for (const name of list) if (!this.stores.has(name)) throw new Error(`missing store ${name}`);
    return new FakeTransaction(this, list);
  }
  close() {}
}

function legacyDb() {
  const db = new FakeDb(7);
  const definitions = [
    ["reader-ink", "id", ["username"]],
    ["custom-pdfs", "id", ["username", "fingerprint"]],
    ["unknown-words", "id", ["username", "usernameResource"]],
    ["pdf-parse-cache", "cacheKey", ["fingerprint"]],
    ["exam-ink", "id", ["username", "sessionId"]],
    ["writing-ink", "id", ["username", "sessionId", "ownerRecordId"]],
    ["device-private-writing-samples", "id", ["username", "usernameQuestion"]],
  ];
  for (const [name, keyPath, indexes] of definitions) {
    const store = db.createObjectStore(name, { keyPath });
    for (const index of indexes) store.createIndex(index, index);
  }
  return db;
}

class FakeIndexedDb {
  constructor(db) { this.db = db; }
  open(_name, version) {
    const request = { result: this.db, error: null, transaction: null };
    queueMicrotask(() => {
      if (version > this.db.version) {
        request.transaction = this.db.transaction([...this.db.stores.keys()]);
        this.db.version = version;
        request.onupgradeneeded?.({ target: request });
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }
}

class MemoryStorage {
  data = new Map();
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };

const { LONG_SENTENCE_STORES: S } = await import("../src/longSentence/data.js");
const repo = await import("../src/longSentence/repository.js");
const { setCurrentUsername } = await import("../src/userData.js");
const { openWuliaoEnglishDatabase, isLongSentenceStorageAvailable, WULIAO_ENGLISH_DB_VERSION } = await import("../src/storage.js");
const { IDB_INCLUDED, createBackup, restoreBackup } = await import("../src/backup.js");

function fresh() {
  const db = new FakeDb();
  for (const name of Object.values(S)) {
    const store = db.createObjectStore(name);
    store.createIndex("username", "username");
    if (name !== S.skills) store.createIndex("usernameSession", ["username", "sessionId"]);
    else store.createIndex("usernameDue", ["username", "nextDueAt"]);
    if (name === S.sessions) store.createIndex("usernameCreated", ["username", "createdAt"]);
  }
  globalThis.indexedDB = new FakeIndexedDb(db);
  setCurrentUsername("alice");
  return db;
}

const SOURCE = { sourceReviewId: '["r","p","s"]', resourceId: "r", passageId: "p", sentenceKey: "s",
  text: "Although the report was delayed, the board approved it.", textFingerprint: "fp", status: "resolved" };

test("due skill index paginates beyond the first 500 and enforces account/date bounds", async () => {
  const db = fresh();
  const skills = db.stores.get(S.skills).records;
  for (let index = 0; index < 520; index += 1) {
    const id = `alice::a${String(index).padStart(3, "0")}`;
    skills.set(id, { id, username: "alice", nextDueAt: "2026-10-01" });
  }
  for (const [id, nextDueAt] of [["z-old", "2026-09-29"], ["z-today-1", "2026-09-30"], ["z-today-2", "2026-09-30"]]) {
    skills.set(`alice::${id}`, { id: `alice::${id}`, username: "alice", nextDueAt });
  }
  skills.set("alice::no-date", { id: "alice::no-date", username: "alice", nextDueAt: null });
  skills.set("bob::foreign", { id: "bob::foreign", username: "bob", nextDueAt: "2026-09-28" });

  assert.equal((await repo.listSkills({ limit: 500 })).some(skill => skill.id === "alice::z-old"), false);
  assert.equal((await repo.getSkill("z-old")).id, "alice::z-old");
  assert.equal((await repo.getSkill("alice::z-old")).nextDueAt, "2026-09-29");
  assert.equal(await repo.getSkill("bob::foreign"), null);
  assert.equal(await repo.getSkill("missing"), null);
  assert.deepEqual((await repo.listDueSkills({ today: "2026-09-30", limit: 2 })).map(skill => skill.id),
    ["alice::z-old", "alice::z-today-1"]);
  assert.deepEqual((await repo.listDueSkills({ today: "2026-09-30", offset: 2, limit: 2 })).map(skill => skill.id),
    ["alice::z-today-2"]);
  assert.deepEqual(await repo.listDueSkills({ today: "2026-09-30", offset: 3, limit: 2 }), []);
  assert.equal(await repo.countDueSkills({ today: "2026-09-30" }), 3);
  assert.equal(await repo.countDueSkills({ today: "2026-09-29" }), 1);
  assert.throws(() => repo.listDueSkills({ today: "2026-02-30" }), /到期日期无效/);
  assert.throws(() => repo.countDueSkills({ today: "2026-09-99" }), /到期日期无效/);
  assert.throws(() => repo.listDueSkills({ offset: -1 }), /分页参数无效/);

  setCurrentUsername("bob");
  assert.equal(await repo.getSkill("alice::z-old"), null);
  assert.deepEqual((await repo.listDueSkills({ today: "2026-09-30" })).map(skill => skill.id), ["bob::foreign"]);
  assert.equal(await repo.countDueSkills({ today: "2026-09-30" }), 1);
  setCurrentUsername("alice");
});

test("session, generated item, draft, evaluation and rating persist without touching source data", async () => {
  const db = fresh();
  const session = await repo.createSession({ sources: [SOURCE], words: [], count: 1 });
  const ready = await repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 0,
    items: [{ text: "Although the board hesitated, it approved the revised report.", structureFingerprint: "concession + main clause" }] });
  assert.equal(ready.items.length, 1);
  const { id: itemId } = ready.items[0], { id: attemptId } = ready.attempts[0];
  let attempt = await repo.saveAttempt({ sessionId: session.id, itemId, attemptId, expectedVersion: 0,
    patch: { userTranslation: "尽管董事会犹豫，它仍批准了修订后的报告。" } });
  attempt = await repo.saveAttempt({ sessionId: session.id, itemId, attemptId, expectedVersion: attempt.version,
    patch: { submittedAt: 100, submissionVersion: attempt.version + 1 } });
  const result = await repo.appendEvaluation({ sessionId: session.id, itemId, attemptId,
    evaluationVersion: 1, submissionVersion: attempt.submissionVersion, evaluation: { translationEvaluation: { structuralUnderstandingErrors: [] } } });
  assert.equal(result.alreadySaved, false);
  const disputed = await repo.setEvaluationFeedback({ evaluationId: result.evaluation.id, feedback: "incorrect" });
  assert.equal(disputed.analysisFeedback, "incorrect");
  const second = await repo.appendEvaluation({ sessionId: session.id, itemId, attemptId,
    evaluationVersion: 2, submissionVersion: attempt.submissionVersion, evaluation: { translationEvaluation: { structuralUnderstandingErrors: [] } } });
  assert.equal(second.evaluation.evaluationVersion, 2);
  const rated = await repo.rateAttempt({ sessionId: session.id, attemptId, userRating: "mastered", now: new Date(2026, 8, 29).getTime() });
  assert.equal(rated.skill.nextDueAt, "2026-10-02");
  const repeat = await repo.rateAttempt({ sessionId: session.id, attemptId, userRating: "mastered" });
  assert.equal(repeat.alreadyRated, true);
  assert.deepEqual(repeat.event, rated.event);
  assert.deepEqual(repeat.skill, rated.skill);
  assert.equal(db.stores.get(S.schedules).records.size, 1);
  const loaded = await repo.loadSession(session.id);
  assert.equal(loaded.attempts[0].userRating, "mastered");
  assert.equal(loaded.evaluations.length, 2);
  assert.equal(loaded.evaluations[0].analysisFeedback, "incorrect");
  assert.equal(db.stores.get(S.skills).records.size, 1);
  assert.deepEqual(rated.skill.sentenceHistory, [ready.items[0].text]);
  assert.equal(rated.skill.sentenceHistoryFingerprints.length, 1);
  assert.equal(rated.skill.sources[0].text, SOURCE.text);
  assert.equal(db.stores.get(S.schedules).records.size, 1);
  db.stores.get(S.ink).records.set("ink-1", { id: "ink-1", username: "alice", sessionId: session.id, ownerRecordId: attemptId });
  db.stores.get(S.ink).records.set("ink-2", { id: "ink-2", username: "alice", sessionId: session.id, ownerRecordId: "older-attempt" });
  db.stores.get(S.ink).records.set("unrelated", { id: "unrelated", username: "alice", sessionId: "other-session" });
  await repo.deleteSession(session.id);
  assert.equal(db.stores.get(S.sessions).records.size, 0);
  assert.equal(db.stores.get(S.attempts).records.size, 0);
  assert.equal(db.stores.get(S.evaluations).records.size, 0);
  assert.deepEqual([...db.stores.get(S.ink).records.keys()], ["unrelated"]);
  assert.equal(db.stores.get(S.skills).records.size, 1);
  assert.deepEqual([...db.stores.get(S.skills).records.values()][0].sentenceHistory, []);
  assert.deepEqual([...db.stores.get(S.skills).records.values()][0].sentenceHistoryFingerprints,
    rated.skill.sentenceHistoryFingerprints);
  assert.equal(db.stores.get(S.schedules).records.size, 1);
});

test("replacement preserves old item history and keeps one active item", async () => {
  fresh();
  const session = await repo.createSession({ sources: [SOURCE], count: 1 });
  await repo.updateSession({ sessionId: session.id, patch: { requestVersion: 1 }, expectedRequestVersion: 0 });
  const first = await repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 1,
    items: [{ text: "The first new sentence exists.", structureFingerprint: "relative clause" }] });
  await assert.rejects(repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 1,
    items: [{ text: "Duplicate response.", structureFingerprint: "relative clause" }] }), /已保存/);
  await repo.updateSession({ sessionId: session.id, patch: { requestVersion: 2 }, expectedRequestVersion: 1 });
  const replacement = await repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 2,
    replaceItemId: first.items[0].id,
    items: [{ text: "A different new sentence exists.", structureFingerprint: "relative clause" }] });
  const loaded = await repo.loadSession(session.id);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].id, replacement.items[0].id);
  assert.equal(loaded.historyItems[0].id, first.items[0].id);
  assert.equal(loaded.attempts.length, 2);
});

test("first validated batch remains saved when supplement fails, then second batch completes", async () => {
  fresh();
  const session = await repo.createSession({ sources: [SOURCE], count: 2 });
  await repo.updateSession({ sessionId: session.id, patch: { requestVersion: 1 }, expectedRequestVersion: 0 });
  const first = await repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 1, batchIndex: 0,
    items: [{ text: "The first validated sentence remains.", structureFingerprint: "relative clause" }] });
  assert.equal(first.session.status, "partial");
  await assert.rejects(repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 1, batchIndex: 1,
    items: [{ text: "Second sentence.", structureFingerprint: "relative clause" },
      { text: "Third sentence.", structureFingerprint: "relative clause" }] }), /超过/);
  let loaded = await repo.loadSession(session.id);
  assert.deepEqual(loaded.items.map((item) => item.text), ["The first validated sentence remains."]);
  assert.deepEqual(loaded.session.savedBatchKeys, ["1:0"]);
  const second = await repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 1, batchIndex: 1,
    items: [{ text: "The second validated sentence arrives.", structureFingerprint: "relative clause" }] });
  assert.equal(second.session.status, "ready");
  loaded = await repo.loadSession(session.id);
  assert.deepEqual(loaded.session.savedBatchKeys, ["1:0", "1:1"]);
  assert.equal(loaded.items.length, 2);
  await assert.rejects(repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 1, batchIndex: 1,
    items: [{ text: "Duplicate sentence.", structureFingerprint: "relative clause" }] }), /已保存/);
});

test("session history pages newest first by createdAt", async () => {
  fresh();
  const old = await repo.createSession({ sources: [SOURCE], count: 1, now: 100 });
  const middle = await repo.createSession({ sources: [SOURCE], count: 1, now: 200 });
  const recent = await repo.createSession({ sources: [SOURCE], count: 1, now: 300 });
  assert.deepEqual((await repo.listSessions({ limit: 2 })).map((entry) => entry.id), [recent.id, middle.id]);
  assert.deepEqual((await repo.listSessions({ offset: 2, limit: 2 })).map((entry) => entry.id), [old.id]);
});

test("stale generation and evaluation responses cannot overwrite newer versions", async () => {
  fresh();
  const session = await repo.createSession({ sources: [SOURCE], count: 1 });
  await repo.updateSession({ sessionId: session.id, patch: { requestVersion: 1 }, expectedRequestVersion: 0 });
  await assert.rejects(repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 0,
    items: [{ text: "New sentence.", structureFingerprint: "relative clause" }] }), /过期/);
  const ready = await repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 1,
    items: [{ text: "A new sentence with a relative clause, which adds detail, appears.", structureFingerprint: "relative clause" }] });
  const itemId = ready.items[0].id, attemptId = ready.attempts[0].id;
  await repo.saveAttempt({ sessionId: session.id, itemId, attemptId, expectedVersion: 0,
    patch: { userTranslation: "一个新句子出现了。", submittedAt: 10, submissionVersion: 1 } });
  await assert.rejects(repo.appendEvaluation({ sessionId: session.id, itemId, attemptId, evaluationVersion: 1,
    submissionVersion: 2, evaluation: {} }), /过期/);
  await repo.appendEvaluation({ sessionId: session.id, itemId, attemptId, evaluationVersion: 1,
    submissionVersion: 1, evaluation: {} });
  await assert.rejects(repo.appendEvaluation({ sessionId: session.id, itemId, attemptId, evaluationVersion: 1,
    submissionVersion: 1, evaluation: { different: true } }), /冲突/);
  await assert.rejects(repo.appendEvaluation({ sessionId: session.id, itemId, attemptId, evaluationVersion: 3,
    submissionVersion: 1, evaluation: {} }), /过期/);
});

test("save allowlists reject invalid types and require current attempt version", async () => {
  fresh();
  const session = await repo.createSession({ sources: [SOURCE], count: 1 });
  await assert.rejects(repo.updateSession({ sessionId: session.id, patch: { requestVersion: "1" }, expectedRequestVersion: 0 }), /字段无效/);
  await assert.rejects(repo.updateSession({ sessionId: session.id, patch: { currentItemIndex: 9 } }), /超出/);
  await repo.updateSession({ sessionId: session.id, patch: { requestVersion: 1 }, expectedRequestVersion: 0 });
  const { items, attempts } = await repo.saveGeneratedItems({ sessionId: session.id, requestVersion: 1,
    items: [{ text: "A valid sentence appears.", structureFingerprint: "relative clause" }] });
  const base = { sessionId: session.id, itemId: items[0].id, attemptId: attempts[0].id };
  await assert.rejects(repo.saveAttempt({ ...base, patch: { userTranslation: "译文" } }), /字段无效/);
  await assert.rejects(repo.saveAttempt({ ...base, expectedVersion: 0, patch: { layout: { width: -1, height: 560, version: 1 } } }), /字段无效/);
  await assert.rejects(repo.saveAttempt({ ...base, expectedVersion: 1, patch: { userTranslation: "旧响应" } }), /版本已变化/);
});

test("account switch blocks access to another user's session", async () => {
  fresh();
  const session = await repo.createSession({ sources: [SOURCE], count: 1 });
  setCurrentUsername("bob");
  await assert.rejects(repo.loadSession(session.id), /账号/);
  await assert.rejects(repo.deleteSession(session.id), /账号/);
});

test("v7 upgrade retains old data and includes all long sentence stores in backup", async () => {
  const db = legacyDb();
  db.stores.get("unknown-words").records.set("keep", { id: "keep", username: "alice", word: "keep" });
  const indexedDb = new FakeIndexedDb(db);
  const opened = await openWuliaoEnglishDatabase(indexedDb);
  opened.close();
  assert.equal(WULIAO_ENGLISH_DB_VERSION, 9);
  assert.equal(db.version, WULIAO_ENGLISH_DB_VERSION);
  assert.equal(db.stores.get("unknown-words").records.get("keep").word, "keep");
  for (const name of Object.values(S)) {
    assert.equal(db.stores.has(name), true, `${name} created`);
    assert.ok(IDB_INCLUDED["wuliao-english"][name], `${name} backed up`);
  }
});

test("failed upgrade falls back to validated v7 and blocks training writes", async () => {
  const db = legacyDb();
  const indexedDb = {
    open(_name, version) {
      const request = { result: db, error: null };
      queueMicrotask(() => {
        if (version === WULIAO_ENGLISH_DB_VERSION) { request.error = new Error("simulated upgrade abort"); request.onerror?.(); }
        else request.onsuccess?.();
      });
      return request;
    },
  };
  globalThis.indexedDB = indexedDb;
  setCurrentUsername("alice");
  const opened = await openWuliaoEnglishDatabase(indexedDb);
  opened.close();
  assert.equal(db.version, 7);
  assert.equal(isLongSentenceStorageAvailable(), false);
  await assert.rejects(repo.createSession({ sources: [SOURCE], count: 1 }), /升级失败/);
});

test("fallback rejects a v7 database with a missing required index", async () => {
  const db = legacyDb();
  db.stores.get("writing-ink").indexes.delete("ownerRecordId");
  const indexedDb = { open(_name, version) {
    const request = { result: db, error: null };
    queueMicrotask(() => {
      if (version === WULIAO_ENGLISH_DB_VERSION) { request.error = new Error("simulated upgrade abort"); request.onerror?.(); }
      else request.onsuccess?.();
    });
    return request;
  } };
  await assert.rejects(openWuliaoEnglishDatabase(indexedDb), /结构不完整/);
});

test("backup filters account, restores idempotently, and reports changed training record conflicts", async () => {
  const records = Object.values(S).map((name) => ({
    name,
    records: [
      { key: `${name}-alice`, value: { id: `${name}-alice`, username: "alice", sessionId: "s", fingerprint: "fp-a", value: 1 } },
      { key: `${name}-bob`, value: { id: `${name}-bob`, username: "bob", sessionId: "s", fingerprint: "fp-b", value: 2 } },
    ],
  }));
  const { manifest } = await createBackup({ username: "alice", sources: {
    entries: [], databases: [{ name: "wuliao-english", stores: records }],
  } });
  for (const name of Object.values(S)) {
    assert.equal(manifest.sections.indexedDB["wuliao-english"][name].length, 1);
    assert.equal(manifest.sections.indexedDB["wuliao-english"][name][0].value.username, "alice");
  }
  const stored = new Map();
  const idb = {
    async listExists(_db, store, key) { return stored.has(`${store}:${key}`); },
    async get(_db, store, key) { return stored.get(`${store}:${key}`) || null; },
    async put(_db, store, key, value) { stored.set(`${store}:${key}`, copy(value)); },
    async sampleCount() { return stored.size; },
  };
  const options = { manifest, username: "alice", existingEntries: [], writeLocal: () => {}, idb, createFile: () => ({}) };
  const first = await restoreBackup(options);
  assert.equal(first.writtenIdb, Object.values(S).length);
  const repeated = await restoreBackup(options);
  assert.equal(repeated.writtenIdb, 0);
  assert.equal(repeated.errors.length, 0);
  const sessionKey = `${S.sessions}:${S.sessions}-alice`;
  stored.set(sessionKey, { ...stored.get(sessionKey), value: 999 });
  const inkKey = `${S.ink}:${S.ink}-alice`;
  stored.set(inkKey, { ...stored.get(inkKey), fingerprint: "local-ink" });
  const conflicting = await restoreBackup(options);
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.errors.filter((error) => error.code === "conflict").length, 2);
  assert.equal(stored.get(sessionKey).value, 999);
  assert.equal(stored.get(inkKey).fingerprint, "local-ink");
});
