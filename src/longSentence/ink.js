import { openWuliaoEnglishDatabase } from "../storage.js";
import { fingerprintWritingInkSnapshot, writingInkRecordId } from "../writing/writingInkStorage.js";

export const LONG_SENTENCE_INK_STORE = "long-sentence-ink";
const SCHEMA_VERSION = 1;
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw failure("invalid-input", `${name} is required`);
  return value.trim();
}

function identityFor(value) {
  const surfaceId = required(value.surfaceId, "surfaceId");
  const match = surfaceId.match(/^long-sentence:([^:]+):([^:]+)$/);
  if (!match) throw failure("invalid-surface", "Invalid long sentence ink surface");
  let itemId;
  let ownerRecordId;
  try {
    itemId = decodeURIComponent(match[1]);
    ownerRecordId = decodeURIComponent(match[2]);
  } catch {
    throw failure("invalid-surface", "Invalid long sentence ink identity encoding");
  }
  return {
    username: required(value.username, "username"),
    sessionId: required(value.sessionId, "sessionId"),
    surfaceId,
    stageId: null,
    itemId: required(itemId, "itemId"),
    ownerRecordId: required(ownerRecordId, "attemptId"),
  };
}

export function longSentenceInkIdentity({ username, sessionId, itemId, attemptId, sourceFingerprint }) {
  return {
    ...identityFor({
      username,
      sessionId,
      surfaceId: `long-sentence:${encodeURIComponent(required(itemId, "itemId"))}:${encodeURIComponent(required(attemptId, "attemptId"))}`,
    }),
    sourceFingerprint: required(sourceFingerprint, "sourceFingerprint"),
  };
}

async function transact(indexedDb, mode, action) {
  const db = await openWuliaoEnglishDatabase(indexedDb);
  try {
    if (!db.objectStoreNames.contains(LONG_SENTENCE_INK_STORE)) {
      throw failure("storage-unavailable", "长难句笔迹存储尚未就绪，请重试数据库升级。");
    }
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(LONG_SENTENCE_INK_STORE, mode);
      let result;
      let cause;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(cause || tx.error || failure("persist-failed", "长难句笔迹事务失败"));
      const control = {
        result(value) { result = value; },
        fail(error) { cause = error; tx.abort(); },
      };
      try { action(tx.objectStore(LONG_SENTENCE_INK_STORE), control); }
      catch (error) { control.fail(error); }
    });
  } finally {
    db.close();
  }
}

async function readRaw(identity, indexedDb) {
  return transact(indexedDb, "readonly", (store, control) => {
    const request = store.get(writingInkRecordId(identity));
    request.onsuccess = () => control.result(clone(request.result) || null);
    request.onerror = () => control.fail(request.error);
  });
}

async function inspect(record, identity, expectedSourceFingerprint) {
  if (!record) return { status: "missing", snapshot: null };
  const valid = record.schemaVersion === SCHEMA_VERSION
    && record.id === writingInkRecordId(identity)
    && Object.entries(identity).every(([key, value]) => record[key] === value)
    && Number.isInteger(record.revision) && record.revision > 0
    && typeof record.sourceFingerprint === "string" && Boolean(record.sourceFingerprint.trim())
    && Number.isFinite(record.updatedAt)
    && Array.isArray(record.strokes)
    && record.fingerprint === await fingerprintWritingInkSnapshot(record);
  if (!valid) return { status: "damaged", snapshot: null, revision: record.revision || null };
  if (expectedSourceFingerprint != null && record.sourceFingerprint !== expectedSourceFingerprint) {
    return { status: "source-mismatch", snapshot: null, revision: record.revision };
  }
  return { status: "ok", snapshot: clone(record) };
}

export async function getLongSentenceInkSnapshot({ indexedDb = globalThis.indexedDB, expectedSourceFingerprint = null, ...value } = {}) {
  const identity = identityFor(value);
  return inspect(await readRaw(identity, indexedDb), identity, expectedSourceFingerprint);
}

export async function saveLongSentenceInkSnapshot({
  indexedDb = globalThis.indexedDB, strokes, expectedRevision, updatedAt = Date.now(), ...value
} = {}) {
  const identity = identityFor(value);
  if (value.stageId !== null || value.ownerRecordId !== identity.ownerRecordId) {
    throw failure("identity-mismatch", "Long sentence ink must belong to its attempt");
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(strokes) || !Number.isFinite(updatedAt)) {
    throw failure("invalid-input", "Invalid long sentence ink snapshot");
  }
  const sourceFingerprint = required(value.sourceFingerprint, "sourceFingerprint");
  const initial = await inspect(await readRaw(identity, indexedDb), identity, sourceFingerprint);
  if (!["ok", "missing"].includes(initial.status)) throw failure(initial.status, "Existing ink cannot be overwritten");
  const revision = initial.snapshot?.revision || 0;
  if (revision !== expectedRevision) throw failure("stale-revision", "Ink has been updated in another view");
  const next = {
    schemaVersion: SCHEMA_VERSION,
    id: writingInkRecordId(identity),
    ...identity,
    revision: revision + 1,
    sourceFingerprint,
    strokes: clone(strokes),
    updatedAt,
  };
  next.fingerprint = await fingerprintWritingInkSnapshot(next);
  await transact(indexedDb, "readwrite", (store, control) => {
    const read = store.get(next.id);
    read.onerror = () => control.fail(read.error);
    read.onsuccess = () => {
      const current = read.result;
      if ((current?.revision || 0) !== revision || current?.fingerprint !== initial.snapshot?.fingerprint) {
        control.fail(failure("stale-revision", "Ink changed before the transaction committed"));
        return;
      }
      const write = store.put(next);
      write.onsuccess = () => control.result(next.id);
      write.onerror = () => control.fail(write.error);
    };
  });
  return clone(next);
}

export const LONG_SENTENCE_INK_PERSISTENCE = Object.freeze({
  getSnapshot: getLongSentenceInkSnapshot,
  saveSnapshot: saveLongSentenceInkSnapshot,
});
