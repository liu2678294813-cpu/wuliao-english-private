import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

const storage = new MemoryStorage();
globalThis.localStorage = storage;
const { scopedUserKey } = await import("../src/userData.js");
const core = await import("../src/exam/examCore.js");
const { postgraduateResources, postgraduateClozeResources } = await import("../src/library.js");
const { getOfficialAnswerKey } = await import("../src/answerKeys.js");
const { getClozeOfficialAnswerKey } = await import("../src/clozeAnswerKeys.js");

function api(username) {
  return {
    getItem: (key) => storage.getItem(scopedUserKey(key, username)),
    setItem: (key, value) => storage.setItem(scopedUserKey(key, username), value),
  };
}

function items() {
  return Array.from({ length: 40 }, (_, index) => {
    const n = index + 1;
    const cloze = n <= 20;
    const resourceId = cloze ? "postgraduate-2023-cloze" : `postgraduate-2023-text-${Math.ceil((n - 20) / 5)}`;
    return { id: cloze ? core.clozeItemId(resourceId, n) : core.readingItemId(resourceId, n), resourceId, section: cloze ? "cloze" : "reading", officialAnswer: "A" };
  });
}

test("stable ids, strict timer, raw scoring and Session snapshot overwrite", async () => {
  const session = await core.createExamSession({ username: "alice", year: 2023, items: items(), now: 1000, sessionId: "x1-test" });
  assert.equal(session.items.length, 40);
  assert.equal(core.shouldTimeOut(session, { now: 1000 + core.EXAM_DURATION_MS }), true);
  const answered = await core.answerExamItem(session, session.items[0].id, "A", { now: 2000 });
  assert.equal(core.scoreExam(answered).correct, 1);
  assert.equal(core.scoreExam(answered).unanswered, 39);
  const repository = new core.ExamSessionRepository({ username: "alice", ...api("alice") });
  await repository.write(session, { expectedRevision: undefined });
  await repository.write(answered, { expectedRevision: 0 });
  assert.equal((await repository.read("x1-test")).revision, 1);
  assert.ok(storage.getItem(scopedUserKey(core.examRecoveryKey("x1-test"), "alice")));
  await assert.rejects(() => core.answerExamItem(session, session.items[0].id, "A", { now: core.EXAM_DURATION_MS + 1000 }), core.ExamTimeoutError);
});

test("resume and delayed callbacks use wall time and fence editing before render", async () => {
  const session = await core.createExamSession({ username: "alice", year: 2023, items: items(), now: 10_000, sessionId: "x1-resume-timeout" });
  assert.equal(core.elapsedForSession(session, { now: 15_000, monotonicElapsedMs: 8_000 }), 8_000);
  assert.equal(core.reconcileSessionOnLoad(session, { now: 10_000 + core.EXAM_DURATION_MS - 1 }).action, "resume");
  const expired = core.reconcileSessionOnLoad(session, { now: 10_000 + core.EXAM_DURATION_MS + 30_000 });
  assert.equal(expired.action, "timed_out");
  assert.equal(expired.session.elapsedMs, core.EXAM_DURATION_MS);
  await assert.rejects(() => core.updateSession(expired.session, { currentItemId: expired.session.items[1].id }, { now: 10_000 + core.EXAM_DURATION_MS + 30_000 }), core.ExamTimeoutError);
});

test("Result is create-once and terminal Session freezes facts", async () => {
  const created = await core.createExamSession({ username: "alice", year: 2023, items: items(), now: 0, sessionId: "x1-result" });
  const session = await core.updateSession(created, { inkRefs: { "reading:text-1": { revision: 4, sourceFingerprint: "last-good" } } }, { now: 1 });
  const sessionRepository = new core.ExamSessionRepository({ username: "alice", ...api("alice") });
  const resultRepository = new core.ExamResultRepository({ username: "alice", ...api("alice") });
  await sessionRepository.write(session, {});
  const output = await core.submitExam({ session, sessionRepository, resultRepository, expectedRevision: 1, reason: core.ExamStatus.SUBMITTED, now: core.EXAM_DURATION_MS, flushInk: () => new Promise(() => {}) });
  assert.equal(output.session.status, core.ExamStatus.TIMED_OUT);
  assert.equal(output.result.reason, core.ExamStatus.TIMED_OUT);
  assert.equal(output.session.terminal.finalElapsedMs, core.EXAM_DURATION_MS);
  assert.equal(output.session.terminal.resultFingerprint, output.result.resultFingerprint);
  assert.equal(output.inkStatus, "flush-timeout");
  assert.deepEqual(output.result.inkRefs, session.inkRefs);
  assert.equal(core.canRebuildTerminalResult(output.session, output.result), true);
  assert.equal((await resultRepository.createOnce(output.result)).resultFingerprint, output.result.resultFingerprint);
  const rebuilt = await core.rebuildTerminalResult(output.session);
  assert.equal(rebuilt.resultFingerprint, output.result.resultFingerprint);
  assert.equal(await core.rebuildTerminalResult({ ...output.session, terminal: { ...output.session.terminal, submittedAt: output.session.terminal.submittedAt + 1 } }), null);
});

test("abandon freezes the draft without creating a Result", async () => {
  const session = await core.createExamSession({ username: "alice", year: 2023, items: items(), now: 0, sessionId: "x1-abandon" });
  const abandoned = await core.abandonExamSession(session, { now: 5000, inkRefs: { "reading:text-1": { revision: 1 } }, inkStatus: "partial" });
  assert.equal(abandoned.status, core.ExamStatus.ABANDONED);
  assert.equal(abandoned.resultRef, null);
  assert.equal(abandoned.terminal.finalElapsedMs, 5000);
});

test("handoff is bounded deterministic record and transitions are guarded", async () => {
  const target = core.deriveHandoffTargets({ scoring: { items: items().map((item, index) => ({ ...item, correct: index >= 6, itemId: item.id })) } });
  assert.equal(target.length, core.MAX_HANDOFF_TARGETS);
  assert.equal(target[0].section, "cloze");
  assert.equal(target.at(-1).focusItemIds.length, 0);
  const selected = await core.createOrUpdateHandoff({ username: "alice", examResultId: "result", targetId: "reading:postgraduate-2023-text-1" });
  const started = await core.createOrUpdateHandoff({ username: "alice", examResultId: "result", targetId: selected.targetId, status: core.HandoffStatus.STARTED, current: selected });
  assert.equal(started.revision, 2);
  assert.equal(await core.createOrUpdateHandoff({ username: "alice", examResultId: "result", targetId: selected.targetId, status: core.HandoffStatus.STARTED, current: started }), started);
  const completed = await core.createOrUpdateHandoff({ username: "alice", examResultId: "result", targetId: selected.targetId, status: core.HandoffStatus.COMPLETED, current: started });
  assert.equal(completed.status, core.HandoffStatus.COMPLETED);
  const dismissed = await core.createOrUpdateHandoff({ username: "alice", examResultId: "result", targetId: "cloze:postgraduate-2023-cloze", status: core.HandoffStatus.DISMISSED, current: await core.createOrUpdateHandoff({ username: "alice", examResultId: "result", targetId: "cloze:postgraduate-2023-cloze" }) });
  assert.equal(dismissed.status, core.HandoffStatus.DISMISSED);
  await assert.rejects(() => core.createOrUpdateHandoff({ username: "alice", examResultId: "result", targetId: selected.targetId, status: core.HandoffStatus.COMPLETED, current: selected }));
});

test("controller invalidates on storage event and expected revision only guards this runtime", async () => {
  const controller = core.createSessionController("x1-concurrent");
  assert.equal(controller.observeStorageEvent({ key: scopedUserKey(core.examSessionKey("x1-concurrent"), "alice") }, "alice"), true);
  assert.equal(controller.active, false);
  const annController = core.createSessionController("x1-concurrent");
  assert.equal(annController.observeStorageEvent({ key: scopedUserKey(core.examSessionKey("x1-concurrent"), "anna") }, "ann"), false);
  assert.equal(annController.observeResultStorageEvent({ key: scopedUserKey(core.examResultKey("x1-concurrent"), "ann") }, "ann"), true);
  assert.equal(annController.active, false);

  const session = await core.createExamSession({ username: "alice", year: 2023, items: items(), sessionId: "x1-post-write", now: 0 });
  const writerController = core.createSessionController(session.sessionId);
  const key = scopedUserKey(core.examSessionKey(session.sessionId), "alice");
  const sabotaged = {
    getItem: (logicalKey) => storage.getItem(scopedUserKey(logicalKey, "alice")),
    setItem: (logicalKey, value) => {
      storage.setItem(scopedUserKey(logicalKey, "alice"), value);
      if (scopedUserKey(logicalKey, "alice") === key) storage.setItem(key, JSON.stringify({ damaged: true }));
    },
  };
  const repository = new core.ExamSessionRepository({ username: "alice", ...sabotaged });
  await assert.rejects(() => repository.write(session, { controller: writerController }), core.ExamConflictError);
  assert.equal(writerController.active, false);
  assert.equal(writerController.invalidReason, "post-write-conflict");
});

test("all 17 official years expose local 20+20 answer keys for X1 preflight", () => {
  for (let year = 2007; year <= 2023; year += 1) {
    const cloze = postgraduateClozeResources.find((resource) => resource.year === year);
    assert.equal(Object.keys(getClozeOfficialAnswerKey(cloze)).length, 20, `${year} cloze`);
    const reading = postgraduateResources.filter((resource) => resource.year === year);
    assert.equal(reading.length, 4, `${year} reading resources`);
    for (const resource of reading) {
      const key = getOfficialAnswerKey(resource);
      assert.deepEqual(Object.keys(key).map(Number).sort((a, b) => a - b), Array.from({ length: 5 }, (_, index) => 21 + (resource.text - 1) * 5 + index));
    }
  }
});
