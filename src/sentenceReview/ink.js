import { getCurrentUsername } from "../userData.js";
import { fingerprintWritingInkSnapshot, writingInkRecordId } from "../writing/writingInkStorage.js";
import { ATTEMPTS, INK, transaction } from "./repository.js";

const clone = value => structuredClone(value);
export function sentenceInkIdentity(attempt) {
  return { username: attempt.username, sessionId: attempt.sourceReviewId,
    surfaceId: `sentence-review:${attempt.id}`, ownerRecordId: attempt.id, stageId: null,
    sourceFingerprint: attempt.source.textFingerprint };
}
function identity(args) {
  const attemptId = typeof args.surfaceId === "string" && args.surfaceId.startsWith("sentence-review:")
    ? args.surfaceId.slice("sentence-review:".length) : "";
  const value = { username: args.username, sessionId: args.sessionId, surfaceId: args.surfaceId,
    ownerRecordId: attemptId, stageId: null };
  if (!value.username || !value.sessionId || !attemptId || (args.stageId !== undefined && args.stageId !== null)
    || (args.ownerRecordId !== undefined && args.ownerRecordId !== attemptId)) throw new Error("笔迹身份不完整");
  return value;
}
async function getSnapshot(args) {
  const owner = identity(args);
  const record = await transaction(INK, "readonly", owner.username, (tx, done) => {
    const request = tx.objectStore(INK).get(writingInkRecordId(owner));
    request.onsuccess = () => done(request.result || null);
  }, args.indexedDb);
  if (!record) return { status: "missing", snapshot: null };
  if (record.schemaVersion !== 1 || !Array.isArray(record.strokes) || !Number.isInteger(record.revision)
    || record.revision < 1 || Object.entries(owner).some(([key, value]) => record[key] !== value)
    || record.fingerprint !== await fingerprintWritingInkSnapshot(record)) return { status: "damaged", snapshot: null };
  if (args.expectedSourceFingerprint && args.expectedSourceFingerprint !== record.sourceFingerprint) return { status: "source-mismatch", snapshot: null };
  return { status: "ok", snapshot: record };
}
async function saveSnapshot(args) {
  const owner = identity(args);
  if (!Array.isArray(args.strokes) || !Number.isInteger(args.expectedRevision) || args.expectedRevision < 0) throw new Error("笔迹保存参数无效");
  const initial = await getSnapshot({ ...args, expectedSourceFingerprint: args.sourceFingerprint });
  if (!["missing", "ok"].includes(initial.status)) throw new Error("笔迹来源或内容已变化，不能覆盖");
  const next = { schemaVersion: 1, id: writingInkRecordId(owner), ...owner,
    sourceReviewId: owner.sessionId, sourceFingerprint: args.sourceFingerprint,
    revision: args.expectedRevision + 1, strokes: clone(args.strokes), updatedAt: Date.now() };
  next.fingerprint = await fingerprintWritingInkSnapshot(next);
  return transaction([ATTEMPTS, INK], "readwrite", owner.username, (tx, done, fail) => {
    const request = tx.objectStore(ATTEMPTS).get(owner.ownerRecordId);
    request.onsuccess = () => {
      const attempt = request.result;
      if (getCurrentUsername() !== owner.username || attempt?.username !== owner.username || attempt.status !== "draft"
        || attempt.sourceReviewId !== owner.sessionId || attempt.source.textFingerprint !== args.sourceFingerprint) {
        fail(new Error("练习已完成或笔迹身份已变化，不能写入")); return;
      }
      const store = tx.objectStore(INK), read = store.get(next.id);
      read.onsuccess = () => {
        if ((read.result?.revision || 0) !== args.expectedRevision || read.result?.fingerprint !== initial.snapshot?.fingerprint) {
          fail(new Error("笔迹已被更新，请重新载入")); return;
        }
        store.put(next); done(next);
      };
    };
  }, args.indexedDb);
}
export const SENTENCE_INK_PERSISTENCE = Object.freeze({ getSnapshot, saveSnapshot });
