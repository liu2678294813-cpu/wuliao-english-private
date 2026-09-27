import { EXAM_INK_STORE, openWuliaoEnglishDatabase } from "../storage";

export const EXAM_INK_SCHEMA_VERSION = 1;
export const EXAM_INK_SURFACES = Object.freeze([
  "cloze:main",
  "reading:text-1",
  "reading:text-2",
  "reading:text-3",
  "reading:text-4",
]);

// 统一 Surface Identity：所有调用方（App.jsx / ExamScreens.jsx / ExamInkSurface / 测试）
// 必须使用同一判断，不得各自实现。
// Cloze → cloze:main；Reading Text N → reading:text-N。
export function examSurfaceIdForItem(item) {
  if (item?.section === "cloze") return "cloze:main";
  const match = String(item?.resourceId || "").match(/text-(\d+)$/);
  return match ? `reading:text-${match[1]}` : null;
}

// Surface Transaction 决策（修改 4/5）：真正发生 Surface 切换时才需要 flush previous。
// 同一 Surface 内切题（如 Reading Text 1 Q21 → Q22）不得触发额外 flush。
export function examSurfaceFlushDecision(previousItem, targetItem) {
  const previousSurface = examSurfaceIdForItem(previousItem);
  const targetSurface = examSurfaceIdForItem(targetItem);
  return {
    previousSurface,
    targetSurface,
    shouldFlush: Boolean(previousSurface && targetSurface && previousSurface !== targetSurface),
  };
}

// Ink Registry（修改 7/10）：valid ref → add/update；null → 删除该 surface 的旧 entry。
export function examInkRegistryUpsert(registry, surfaceId, ref) {
  if (ref) return { ...registry, [surfaceId]: ref };
  const next = { ...registry };
  delete next[surfaceId];
  return next;
}

// flush outcome merge：把 verified inkRefs 并入 registry，并汇报 partial 状态。
export function mergeExamInkRegistryWithFlush(registry, outcome) {
  return {
    registry: { ...registry, ...(outcome?.inkRefs || {}) },
    partial: Boolean(outcome?.inkStatus === "partial"),
  };
}

export class ExamInkStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExamInkStorageError";
    this.code = code;
  }
}

export class ExamInkStaleRevisionError extends ExamInkStorageError {
  constructor(expectedRevision, actualRevision) {
    super("stale-revision", "Exam ink snapshot was changed by a newer runtime");
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new ExamInkStorageError("invalid-input", `${name} is required`);
  return normalized;
}

function assertSurfaceId(surfaceId) {
  const normalized = requiredString(surfaceId, "surfaceId");
  if (!EXAM_INK_SURFACES.includes(normalized)) {
    throw new ExamInkStorageError("invalid-surface", "Exam ink only supports cloze:main and the four reading surfaces");
  }
  return normalized;
}

function cloneStrokes(strokes) {
  if (!Array.isArray(strokes)) throw new ExamInkStorageError("invalid-strokes", "strokes must be an array");
  try {
    return JSON.parse(JSON.stringify(strokes));
  } catch {
    throw new ExamInkStorageError("invalid-strokes", "strokes must be serializable");
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv-${hash.toString(16).padStart(8, "0")}`;
}

export function examInkRecordId({ username, sessionId, surfaceId }) {
  return [username, sessionId, surfaceId]
    .map((value) => encodeURIComponent(requiredString(value, "exam ink identity")))
    .join("::");
}

export function fingerprintExamInkSnapshot(snapshot) {
  return fnv1a(stableStringify({
    schemaVersion: snapshot.schemaVersion,
    id: snapshot.id,
    username: snapshot.username,
    sessionId: snapshot.sessionId,
    surfaceId: snapshot.surfaceId,
    revision: snapshot.revision,
    sourceFingerprint: snapshot.sourceFingerprint,
    strokes: snapshot.strokes,
  }));
}

function cloneSnapshot(record) {
  return { ...record, strokes: cloneStrokes(record.strokes) };
}

function normalizeIdentity({ username, sessionId, surfaceId }) {
  return {
    username: requiredString(username, "username"),
    sessionId: requiredString(sessionId, "sessionId"),
    surfaceId: assertSurfaceId(surfaceId),
  };
}

function normalizedExpectedRevision(expectedRevision) {
  if (expectedRevision == null) return null;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new ExamInkStorageError("invalid-revision", "expectedRevision must be a non-negative integer");
  }
  return expectedRevision;
}

function runRequest(db, mode, callback) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let failure = null;
    let result = null;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    let transaction;
    try {
      transaction = db.transaction(EXAM_INK_STORE, mode);
      callback(transaction.objectStore(EXAM_INK_STORE), {
        resolve: (value) => { result = value; },
        fail: (error) => {
          failure = error;
          transaction.abort();
        },
      });
    } catch (error) {
      settle(error);
      return;
    }
    transaction.oncomplete = () => settle(null);
    transaction.onerror = () => settle(failure || transaction.error || new Error("Exam ink transaction failed"));
    transaction.onabort = () => settle(failure || transaction.error || new Error("Exam ink transaction aborted"));
  });
}

async function withExamInkDatabase(indexedDb, action) {
  const db = await openWuliaoEnglishDatabase(indexedDb);
  try {
    return await action(db);
  } finally {
    db.close();
  }
}

export async function getExamInkSnapshot({
  username,
  sessionId,
  surfaceId,
  expectedSourceFingerprint = null,
  indexedDb = globalThis.indexedDB,
} = {}) {
  const identity = normalizeIdentity({ username, sessionId, surfaceId });
  const id = examInkRecordId(identity);
  return withExamInkDatabase(indexedDb, async (db) => runRequest(db, "readonly", (store, control) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result;
      if (!record) {
        control.resolve({ status: "missing", snapshot: null });
        return;
      }
      const normalizedExpectedSource = expectedSourceFingerprint == null
        ? null
        : requiredString(expectedSourceFingerprint, "expectedSourceFingerprint");
      const validIdentity = record.id === id
        && record.username === identity.username
        && record.sessionId === identity.sessionId
        && record.surfaceId === identity.surfaceId
        && Number.isInteger(record.revision)
        && record.revision > 0
        && typeof record.sourceFingerprint === "string"
        && Array.isArray(record.strokes)
        && typeof record.fingerprint === "string";
      if (!validIdentity || record.fingerprint !== fingerprintExamInkSnapshot(record)) {
        control.resolve({
          status: "damaged",
          snapshot: null,
          revision: Number.isInteger(record.revision) && record.revision > 0 ? record.revision : null,
        });
        return;
      }
      if (normalizedExpectedSource && record.sourceFingerprint !== normalizedExpectedSource) {
        control.resolve({ status: "source-mismatch", snapshot: null, revision: record.revision });
        return;
      }
      control.resolve({ status: "ok", snapshot: cloneSnapshot(record) });
    };
    request.onerror = () => control.fail(request.error || new Error("Exam ink read failed"));
  }));
}

/**
 * expectedRevision is only a same-runtime stale-write guard. Callers must
 * invalidate and reload when a storage event or post-write verification sees
 * a newer record; this module intentionally does not claim cross-tab CAS.
 */
export async function saveExamInkSnapshot({
  username,
  sessionId,
  surfaceId,
  sourceFingerprint,
  strokes,
  expectedRevision = null,
  now = Date.now(),
  allowSourceFingerprintChange = false,
  indexedDb = globalThis.indexedDB,
} = {}) {
  const identity = normalizeIdentity({ username, sessionId, surfaceId });
  const normalizedSourceFingerprint = requiredString(sourceFingerprint, "sourceFingerprint");
  const nextStrokes = cloneStrokes(strokes);
  const expected = normalizedExpectedRevision(expectedRevision);
  const id = examInkRecordId(identity);

  return withExamInkDatabase(indexedDb, async (db) => runRequest(db, "readwrite", (store, control) => {
    const read = store.get(id);
    read.onsuccess = () => {
      const current = read.result || null;
      const actualRevision = current?.revision || 0;
      if (expected != null && actualRevision !== expected) {
        control.fail(new ExamInkStaleRevisionError(expected, actualRevision));
        return;
      }
      if (current && current.sourceFingerprint !== normalizedSourceFingerprint && !allowSourceFingerprintChange) {
        control.fail(new ExamInkStorageError("source-mismatch", "Exam ink source fingerprint does not match"));
        return;
      }
      const next = {
        schemaVersion: EXAM_INK_SCHEMA_VERSION,
        id,
        ...identity,
        revision: actualRevision + 1,
        sourceFingerprint: normalizedSourceFingerprint,
        updatedAt: Number.isFinite(now) ? now : Date.now(),
        strokes: nextStrokes,
      };
      next.fingerprint = fingerprintExamInkSnapshot(next);
      const write = store.put(next);
      write.onsuccess = () => control.resolve(cloneSnapshot(next));
      write.onerror = () => control.fail(write.error || new Error("Exam ink write failed"));
    };
    read.onerror = () => control.fail(read.error || new Error("Exam ink read failed"));
  }));
}

export function clearExamInkSnapshot(options = {}) {
  return saveExamInkSnapshot({ ...options, strokes: [], allowSourceFingerprintChange: true });
}
