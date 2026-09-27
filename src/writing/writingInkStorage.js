import { computeFileFingerprint } from "../fingerprint.js";
import { WRITING_INK_STORE, openWuliaoEnglishDatabase } from "../storage.js";
import { WRITING_SCHEMA_VERSION, WRITING_STAGES, WritingStage } from "./writingModels.js";

export const WRITING_INK_SCHEMA_VERSION = WRITING_SCHEMA_VERSION;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const SURFACE_PATTERNS = Object.freeze([
  { pattern: /^vocabulary:(.+)$/, stageId: null },
  { pattern: /^w2:translation:(.+)$/, stageId: WritingStage.W2_EN_ZH },
  { pattern: /^w3:back:(.+)$/, stageId: WritingStage.W3_BACK_TRANSLATION },
  { pattern: /^w5:skeleton:(.+)$/, stageId: WritingStage.W5_SKELETON },
  { pattern: /^w6:reconstruction:(.+)$/, stageId: WritingStage.W6_RECONSTRUCTION },
  { pattern: /^w7:independent:(.+)$/, stageId: WritingStage.W7_INDEPENDENT },
  { pattern: /^w8:revision:(.+)$/, stageId: WritingStage.W8_SCORE_REWRITE },
  { pattern: /^review:(D1|D3|D7):(.+)$/, stageId: null },
]);

export class WritingInkStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WritingInkStorageError";
    this.code = code;
  }
}

export class WritingInkStaleRevisionError extends WritingInkStorageError {
  constructor(expectedRevision, actualRevision) {
    super("stale-revision", "Writing ink snapshot was changed by a newer runtime");
    this.name = "WritingInkStaleRevisionError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function requiredString(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new WritingInkStorageError("invalid-input", `${name} is required`);
  return normalized;
}

function cloneJson(value, name) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new WritingInkStorageError("invalid-input", `${name} must be JSON serializable`);
  }
}

function cloneStrokes(strokes) {
  if (!Array.isArray(strokes)) throw new WritingInkStorageError("invalid-strokes", "strokes must be an array");
  return cloneJson(strokes, "strokes");
}

function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function surfaceContract(surfaceId) {
  const normalized = requiredString(surfaceId, "surfaceId");
  for (const contract of SURFACE_PATTERNS) {
    const result = normalized.match(contract.pattern);
    if (result) return { surfaceId: normalized, contract, ownerRecordId: result[result.length - 1] };
  }
  throw new WritingInkStorageError("invalid-surface", "Unsupported Writing ink surfaceId");
}

function normalizeIdentity({ username, sessionId, surfaceId, stageId, ownerRecordId }) {
  const surface = surfaceContract(surfaceId);
  let normalizedStageId = null;
  if (surface.contract.stageId === null) {
    if (stageId !== null) throw new WritingInkStorageError("invalid-stage", "Review ink stageId must be null");
  } else {
    normalizedStageId = requiredString(stageId, "stageId");
    if (!WRITING_STAGES.includes(normalizedStageId) || normalizedStageId === WritingStage.DONE) {
      throw new WritingInkStorageError("invalid-stage", "stageId must be an active canonical Writing stage");
    }
    if (surface.contract.stageId !== normalizedStageId) {
      throw new WritingInkStorageError("invalid-stage", "stageId does not match surfaceId");
    }
  }
  const normalizedOwnerRecordId = requiredString(ownerRecordId, "ownerRecordId");
  if (surface.ownerRecordId !== normalizedOwnerRecordId) {
    throw new WritingInkStorageError("owner-mismatch", "ownerRecordId must match the surface identity");
  }
  return {
    username: requiredString(username, "username"),
    sessionId: requiredString(sessionId, "sessionId"),
    surfaceId: surface.surfaceId,
    stageId: normalizedStageId,
    ownerRecordId: normalizedOwnerRecordId,
  };
}

function normalizeReadIdentity({ username, sessionId, surfaceId }) {
  return {
    username: requiredString(username, "username"),
    sessionId: requiredString(sessionId, "sessionId"),
    surfaceId: surfaceContract(surfaceId).surfaceId,
  };
}

function normalizeExpectedRevision(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new WritingInkStorageError("invalid-revision", "expectedRevision must be a non-negative integer");
  }
  return value;
}

export function writingInkRecordId({ username, sessionId, surfaceId }) {
  return [username, sessionId, surfaceId]
    .map((value) => encodeURIComponent(requiredString(value, "Writing ink identity")))
    .join("::");
}

export async function fingerprintWritingInkSnapshot(snapshot) {
  const value = cloneJson(snapshot, "WritingInkSnapshot");
  delete value.fingerprint;
  const fingerprint = await computeFileFingerprint(new TextEncoder().encode(canonicalJson(value)));
  if (!SHA256_PATTERN.test(fingerprint)) {
    throw new WritingInkStorageError("fingerprint-unavailable", "SHA-256 is unavailable for Writing ink fingerprints");
  }
  return fingerprint;
}

export function writingInkRefFromSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    surfaceId: snapshot.surfaceId,
    revision: snapshot.revision,
    fingerprint: snapshot.fingerprint,
    sourceFingerprint: snapshot.sourceFingerprint,
    updatedAt: snapshot.updatedAt,
    ownerRecordId: snapshot.ownerRecordId,
    stageId: snapshot.stageId,
  };
}

function runRequest(db, mode, callback) {
  return new Promise((resolve, reject) => {
    let result;
    let failure = null;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    let transaction;
    try {
      transaction = db.transaction(WRITING_INK_STORE, mode);
      callback(transaction.objectStore(WRITING_INK_STORE), {
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
    transaction.onerror = () => settle(failure || transaction.error || new WritingInkStorageError("transaction-error", "Writing ink transaction failed"));
    transaction.onabort = () => settle(failure || transaction.error || new WritingInkStorageError("transaction-abort", "Writing ink transaction aborted"));
  });
}

async function withDatabase(indexedDb, action) {
  const database = await openWuliaoEnglishDatabase(indexedDb);
  try {
    return await action(database);
  } finally {
    database.close();
  }
}

function readRaw(id, indexedDb) {
  return withDatabase(indexedDb, (database) => runRequest(database, "readonly", (store, control) => {
    const request = store.get(id);
    request.onsuccess = () => control.resolve(request.result ? cloneJson(request.result, "WritingInkSnapshot") : null);
    request.onerror = () => control.fail(request.error || new WritingInkStorageError("read-error", "Writing ink read failed"));
  }));
}

async function inspectRecord(record, identity, expectedSourceFingerprint = null) {
  if (!record) return { status: "missing", snapshot: null };
  const id = writingInkRecordId(identity);
  const valid = record.schemaVersion === WRITING_INK_SCHEMA_VERSION
    && record.id === id
    && record.username === identity.username
    && record.sessionId === identity.sessionId
    && record.surfaceId === identity.surfaceId
    && (record.stageId === null || (typeof record.stageId === "string" && WRITING_STAGES.includes(record.stageId) && record.stageId !== WritingStage.DONE))
    && typeof record.ownerRecordId === "string"
    && record.ownerRecordId.trim()
    && Number.isInteger(record.revision)
    && record.revision > 0
    && typeof record.sourceFingerprint === "string"
    && record.sourceFingerprint.trim()
    && Array.isArray(record.strokes)
    && ((typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)) || (typeof record.updatedAt === "string" && record.updatedAt.trim()))
    && typeof record.fingerprint === "string";
  if (!valid || record.fingerprint !== await fingerprintWritingInkSnapshot(record)) {
    return { status: "damaged", snapshot: null, revision: Number.isInteger(record.revision) && record.revision > 0 ? record.revision : null };
  }
  try {
    const normalized = normalizeIdentity(record);
    if (normalized.ownerRecordId !== record.ownerRecordId) throw new Error("owner mismatch");
  } catch {
    return { status: "damaged", snapshot: null, revision: record.revision };
  }
  if (expectedSourceFingerprint !== null && record.sourceFingerprint !== requiredString(expectedSourceFingerprint, "expectedSourceFingerprint")) {
    return { status: "source-mismatch", snapshot: null, revision: record.revision };
  }
  return { status: "ok", snapshot: cloneJson(record, "WritingInkSnapshot") };
}

export async function getWritingInkSnapshot({
  username,
  sessionId,
  surfaceId,
  expectedSourceFingerprint = null,
  indexedDb = globalThis.indexedDB,
} = {}) {
  const identity = normalizeReadIdentity({ username, sessionId, surfaceId });
  const record = await readRaw(writingInkRecordId(identity), indexedDb);
  return inspectRecord(record, identity, expectedSourceFingerprint);
}

export async function saveWritingInkSnapshot({
  username,
  sessionId,
  surfaceId,
  stageId,
  ownerRecordId,
  sourceFingerprint,
  strokes,
  expectedRevision,
  updatedAt = Date.now(),
  indexedDb = globalThis.indexedDB,
} = {}) {
  const identity = normalizeIdentity({ username, sessionId, surfaceId, stageId, ownerRecordId });
  const source = requiredString(sourceFingerprint, "sourceFingerprint");
  const expected = normalizeExpectedRevision(expectedRevision);
  const nextStrokes = cloneStrokes(strokes);
  if (!((typeof updatedAt === "number" && Number.isFinite(updatedAt)) || (typeof updatedAt === "string" && updatedAt.trim()))) {
    throw new WritingInkStorageError("invalid-input", "updatedAt is invalid");
  }
  const id = writingInkRecordId(identity);
  const initialRecord = await readRaw(id, indexedDb);
  const initial = await inspectRecord(initialRecord, identity);
  if (initial.status === "damaged") throw new WritingInkStorageError("damaged", "Existing Writing ink snapshot is damaged");
  const actualRevision = initial.snapshot?.revision || 0;
  if (actualRevision !== expected) throw new WritingInkStaleRevisionError(expected, actualRevision);
  if (initial.snapshot && initial.snapshot.sourceFingerprint !== source) {
    throw new WritingInkStorageError("source-mismatch", "Writing ink source fingerprint does not match");
  }
  if (initial.snapshot && initial.snapshot.ownerRecordId !== identity.ownerRecordId) {
    throw new WritingInkStorageError("owner-mismatch", "Writing ink ownerRecordId cannot change");
  }
  const next = {
    schemaVersion: WRITING_INK_SCHEMA_VERSION,
    id,
    ...identity,
    revision: actualRevision + 1,
    sourceFingerprint: source,
    strokes: nextStrokes,
    updatedAt,
  };
  next.fingerprint = await fingerprintWritingInkSnapshot(next);

  await withDatabase(indexedDb, (database) => runRequest(database, "readwrite", (store, control) => {
    const read = store.get(id);
    read.onsuccess = () => {
      const current = read.result || null;
      const currentRevision = current?.revision || 0;
      if (currentRevision !== actualRevision) {
        control.fail(new WritingInkStaleRevisionError(expected, currentRevision));
        return;
      }
      if (current && current.fingerprint !== initial.snapshot?.fingerprint) {
        control.fail(new WritingInkStorageError("damaged", "Writing ink changed before save"));
        return;
      }
      if (current && current.sourceFingerprint !== source) {
        control.fail(new WritingInkStorageError("source-mismatch", "Writing ink source fingerprint does not match"));
        return;
      }
      const write = store.put(next);
      write.onsuccess = () => control.resolve(next.id);
      write.onerror = () => control.fail(write.error || new WritingInkStorageError("write-error", "Writing ink write failed"));
    };
    read.onerror = () => control.fail(read.error || new WritingInkStorageError("read-error", "Writing ink read failed"));
  }));

  const verified = await getWritingInkSnapshot({ username, sessionId, surfaceId, expectedSourceFingerprint: source, indexedDb });
  if (verified.status !== "ok" || verified.snapshot.revision !== next.revision || verified.snapshot.fingerprint !== next.fingerprint) {
    throw new WritingInkStorageError("post-write-conflict", "Writing ink post-write verification failed");
  }
  return verified.snapshot;
}
