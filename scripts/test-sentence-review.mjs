import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sentenceReviewDatabase } from "./fixtures/sentence-review-indexeddb.mjs";
import { setCurrentUsername, setUserItem, getUserItem } from "../src/userData.js";
import { openWuliaoEnglishDatabase } from "../src/storage.js";
import { sentenceKeyFor, emptyProgress, loadTranslationProgress, saveTranslationProgress, setReviewStatus } from "../src/translationProgress.js";
import { ensureSentenceRecheckTask, listReviewTasks, localDateKey, addCalendarDays } from "../src/readingReview.js";
import { listWarehouseSources, beginAttempt, finishAttempt, requeueSource, originalRecords } from "../src/sentenceReview/service.js";
import { ATTEMPTS, INK, readAttempt, saveDraft, listAttempts } from "../src/sentenceReview/repository.js";
import { sentenceInkIdentity, SENTENCE_INK_PERSISTENCE } from "../src/sentenceReview/ink.js";
import { IDB_INCLUDED, createBackup, restoreBackup } from "../src/backup.js";
import { sentenceReviewHostHash, sentenceReviewRouteFromHost } from "../src/navigation.js";

class MemoryStorage {
  data = new Map();
  get length() { return this.data.size; } key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; } setItem(key, value) { this.data.set(key, String(value)); }
  removeItem(key) { this.data.delete(key); }
}
const sentences = ["Although the evidence was incomplete, the committee approved the plan.", "The students who attended the lecture understood the argument."];
const resourceId = "custom-sentence-test", passageId = "p-test";
const keys = sentences.map((text, i) => sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: i, sentenceText: text }));
let database;
beforeEach(async () => {
  globalThis.localStorage = new MemoryStorage();
  globalThis.window = { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, location: { hash: "" } };
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  database = sentenceReviewDatabase(); globalThis.indexedDB = database.indexedDb;
  setCurrentUsername("alice");
  const db = await openWuliaoEnglishDatabase(); db.close();
  database.stores.get("custom-pdfs").records.set(resourceId, { id: resourceId, kind: "custom", username: "alice", conversionStatus: "ready", title: "隔离资料",
    analysis: { passages: [{ id: passageId, label: "Text A", paragraphs: [{ number: 1, sentences }] }] } });
  const progress = emptyProgress(resourceId, passageId);
  for (const key of keys) progress.sentences[key] = { translationStatus: "corrected", reviewStatus: "needs_review", translatedAt: 1, correctedAt: 2, reviewedAt: 3, translationFingerprint: "translation-original" };
  saveTranslationProgress(progress);
});
async function source(index = 0) { return (await listWarehouseSources()).find(item => item.sentenceKey === keys[index]); }

test("additive migration, backup inclusion, and URL identity preserve every original store", async () => {
  assert.ok(database.stores.has(ATTEMPTS)); assert.ok(database.stores.has(INK));
  assert.equal(database.stores.get("custom-pdfs").records.size, 1);
  assert.ok(IDB_INCLUDED["wuliao-english"][ATTEMPTS]); assert.equal(IDB_INCLUDED["wuliao-english"][INK].mergeByFingerprint, true);
  const item = await source(); window.location.hash = sentenceReviewHostHash(item.sourceReviewId);
  assert.equal(sentenceReviewRouteFromHost().sourceId, item.sourceReviewId);
  window.location.hash = "#/sentence-library/%not-valid"; assert.equal(sentenceReviewRouteFromHost(), null);
});
test("all existing marks deduplicate, unknown sources stay visible, and same words in another article remain separate", async () => {
  assert.equal((await listWarehouseSources()).length, 2);
  setUserItem("wuliao:translation-progress:missing:passage", JSON.stringify({ resourceId: "missing", passageId: "passage", sentences: { [keys[0]]: { reviewStatus: "needs_review" } } }));
  const found = await listWarehouseSources(); assert.equal(found.length, 3);
  assert.equal(found.find(item => item.resourceId === "missing").status, "source_unavailable");
  assert.equal((await listWarehouseSources()).length, 3);
});
test("resume draft, reject stale versions, freeze completed rounds, and start a new blank round", async () => {
  const item = await source(), attempt = await beginAttempt("alice", item, "typed");
  const draft = await saveDraft("alice", attempt, { userTranslation: "本轮译文", inputMode: "typed", checked: true });
  await assert.rejects(saveDraft("alice", attempt, { userTranslation: "过期输入" }), /其他页面更新/);
  assert.equal((await beginAttempt("alice", item, "typed")).userTranslation, "本轮译文");
  const completed = await finishAttempt("alice", draft.id, "mastered");
  assert.equal(completed.status, "completed");
  await assert.rejects(saveDraft("alice", completed, { userTranslation: "不能覆盖" }), /只读/);
  const learned = await source(); assert.equal(learned.section, "learned"); assert.equal(learned.paragraphNumber, 1);
  const pending = await requeueSource("alice", learned);
  const next = await beginAttempt("alice", pending, "handwriting");
  assert.equal(next.round, 2); assert.equal(next.userTranslation, ""); assert.equal(next.checked, false);
  assert.equal((await readAttempt("alice", draft.id)).userTranslation, "本轮译文");
});
test("one sentence result never resets another sentence's existing task or original translations", async () => {
  const other = ensureSentenceRecheckTask({ resourceId, passageId, sentenceKeys: [keys[1]] }).task;
  const before = JSON.stringify(other);
  setUserItem("wuliao:deep-translation:original-sentinel", "原笔译保留");
  const attempt = await beginAttempt("alice", await source(), "typed");
  await finishAttempt("alice", attempt.id, "mastered");
  assert.equal(JSON.stringify(listReviewTasks().find(item => item.taskKey === other.taskKey)), before);
  assert.equal(loadTranslationProgress(resourceId, passageId).sentences[keys[1]].reviewStatus, "needs_review");
  assert.equal(getUserItem("wuliao:deep-translation:original-sentinel"), "原笔译保留");
});
test("difficult result schedules three calendar days later and retries do not duplicate tasks", async () => {
  const attempt = await beginAttempt("alice", await source(), "typed");
  await finishAttempt("alice", attempt.id, "difficult");
  const tasks = JSON.stringify(listReviewTasks());
  await finishAttempt("alice", attempt.id, "difficult");
  assert.equal(JSON.stringify(listReviewTasks()), tasks);
  assert.equal(listReviewTasks().find(item => item.taskKey.endsWith(":followup")).dueDate, addCalendarDays(localDateKey(), 3));
  assert.equal((await source()).section, "pending");
});
test("a failed final IndexedDB commit recovers the original mastery receipt without duplicate completion", async () => {
  const attempt = await beginAttempt("alice", await source(), "typed");
  database.failCommitWhen(stores => [...(stores.get(ATTEMPTS)?.values() || [])].some(item => item.status === "completed"));
  await assert.rejects(finishAttempt("alice", attempt.id, "mastered"), /quota abort/);
  assert.equal((await readAttempt("alice", attempt.id)).status, "committing");
  assert.equal(loadTranslationProgress(resourceId, passageId).sentences[keys[0]].reviewStatus, "mastered");
  const saved = await finishAttempt("alice", attempt.id, "mastered");
  assert.equal(saved.status, "completed"); assert.equal(listReviewTasks().length, 1);
});
test("real account boundary and a changed original source block result writes while retaining the draft", async () => {
  const attempt = await beginAttempt("alice", await source(), "typed");
  setCurrentUsername("bob"); await assert.rejects(readAttempt("alice", attempt.id), /账号已切换/);
  setCurrentUsername("alice");
  const resource = database.stores.get("custom-pdfs").records.get(resourceId);
  resource.analysis.passages[0].paragraphs[0].sentences = ["The text has changed."];
  await assert.rejects(finishAttempt("alice", attempt.id, "mastered"), /来源已变化/);
  assert.equal((await readAttempt("alice", attempt.id)).status, "draft");
  assert.equal(loadTranslationProgress(resourceId, passageId).sentences[keys[0]].reviewStatus, "needs_review");
});
test("ink transactions roll back after successful put, reject stale edits and freeze after grading", async () => {
  const attempt = await beginAttempt("alice", await source(), "handwriting"), identity = sentenceInkIdentity(attempt);
  const initial = await SENTENCE_INK_PERSISTENCE.saveSnapshot({ ...identity, strokes: [{ id: "pen-1", points: [{ x: 10, y: 20 }] }], expectedRevision: 0 });
  database.failCommitWhen(stores => stores.has(INK));
  await assert.rejects(SENTENCE_INK_PERSISTENCE.saveSnapshot({ ...identity, strokes: [], expectedRevision: 1 }), /quota abort/);
  const restored = await SENTENCE_INK_PERSISTENCE.getSnapshot({ ...identity, expectedSourceFingerprint: identity.sourceFingerprint });
  assert.equal(restored.snapshot.fingerprint, initial.fingerprint);
  const adapterRead = await SENTENCE_INK_PERSISTENCE.getSnapshot({ username: identity.username, sessionId: identity.sessionId,
    surfaceId: identity.surfaceId, expectedSourceFingerprint: identity.sourceFingerprint });
  assert.equal(adapterRead.status, "ok");
  await assert.rejects(SENTENCE_INK_PERSISTENCE.saveSnapshot({ ...identity, strokes: [], expectedRevision: 0 }), /已被更新/);
  assert.equal((await SENTENCE_INK_PERSISTENCE.getSnapshot({ ...identity, expectedSourceFingerprint: "different" })).status, "source-mismatch");
  await finishAttempt("alice", attempt.id, "mastered");
  await assert.rejects(SENTENCE_INK_PERSISTENCE.saveSnapshot({ ...identity, strokes: [], expectedRevision: 1 }), /练习已完成/);
});
test("plain mastered flags are not treated as original review completion evidence", async () => {
  saveTranslationProgress(setReviewStatus(loadTranslationProgress(resourceId, passageId), keys[0], "mastered"));
  assert.equal((await listWarehouseSources()).length, 1);
  assert.deepEqual(originalRecords(await source(1), "alice"), { translation: "", reviews: [] });
  assert.equal((await listAttempts("alice")).length, 0);
});

test("an interrupted task-side mastery confirmation is reconciled before retrying the final attempt commit", async () => {
  const attempt = await beginAttempt("alice", await source(), "typed");
  const originalSet = localStorage.setItem.bind(localStorage);
  let fail = true;
  localStorage.setItem = (key, value) => {
    if (fail && key.includes("wuliao:review-task:") && JSON.parse(value).session?.sentenceResults?.[keys[0]] === "mastered") {
      fail = false; throw new Error("task receipt save failed");
    }
    originalSet(key, value);
  };
  await assert.rejects(finishAttempt("alice", attempt.id, "mastered"), /复习记录待补全/);
  assert.equal(loadTranslationProgress(resourceId, passageId).sentences[keys[0]].reviewStatus, "mastered");
  const restored = await finishAttempt("alice", attempt.id, "mastered");
  assert.equal(restored.status, "completed"); assert.equal((await source()).section, "learned");
});

test("attempt and ink backup restores into an empty target, is idempotent, and preserves newer conflicting local data", async () => {
  const attempt = await beginAttempt("alice", await source(), "handwriting");
  const ink = await SENTENCE_INK_PERSISTENCE.saveSnapshot({ ...sentenceInkIdentity(attempt), strokes: [{ id: "ink", points: [{ x: 2, y: 3 }] }], expectedRevision: 0 });
  const { manifest } = await createBackup({ username: "alice", sources: { entries: [], databases: [{ name: "wuliao-english", stores: [
    { name: ATTEMPTS, records: [{ key: attempt.id, value: attempt }, { key: "bob", value: { ...attempt, id: "bob", username: "bob" } }] },
    { name: INK, records: [{ key: ink.id, value: ink }] },
  ] }] } });
  assert.equal(manifest.sections.indexedDB["wuliao-english"][ATTEMPTS].length, 1);
  const target = new Map(), targetKey = (db, store, key) => JSON.stringify([db, store, key]);
  const idb = { listExists: async (...args) => target.has(targetKey(...args)), get: async (...args) => target.get(targetKey(...args)),
    put: async (db, store, key, value) => target.set(targetKey(db, store, key), structuredClone(value)) };
  const restore = () => restoreBackup({ manifest, username: "alice", existingEntries: [], writeLocal() {}, idb, createFile() {} });
  const first = await restore(); assert.equal(first.ok, true); assert.equal(first.writtenIdb, 2);
  assert.equal((await restore()).writtenIdb, 0);
  const changed = { ...attempt, userTranslation: "目标端更新的练习", revision: 9 };
  target.set(targetKey("wuliao-english", ATTEMPTS, attempt.id), changed);
  const conflict = await restore(); assert.equal(conflict.ok, false);
  assert.equal(target.get(targetKey("wuliao-english", ATTEMPTS, attempt.id)).userTranslation, "目标端更新的练习");
});
