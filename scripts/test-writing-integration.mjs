import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
await import("./test-hooks.mjs");

const {
  createWritingIntegrationService,
  addLocalCalendarDays,
  localCalendarDateFromTimestamp,
} = await import("../src/writing/writingIntegration.js");
const { createWritingUnknownWordsService } = await import("../src/writing/writingUnknownWords.js");
const { buildWritingPlannerCandidates } = await import("../src/studyPlannerSources.js");
const { getLearningSnapshot } = await import("../src/learningSnapshot.js");
const { setCurrentUsername, setUserItem } = await import("../src/userData.js");
const {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  createBackup,
  restoreBackup,
} = await import("../src/backup.js");
const {
  WritingConflictError,
  writingReviewTaskId,
} = await import("../src/writing/writingRepository.js");
const {
  WRITING_SCHEMA_VERSION,
  WritingLearningItemOrigin,
  WritingReviewStatus,
  WritingReviewType,
} = await import("../src/writing/writingModels.js");
const {
  ALICE,
  NOW,
  createRepository,
  scopedStore,
  setupCompletedSession,
} = await import("./writing-slice7-fixtures.mjs");

function service(repository, options = {}) {
  return createWritingIntegrationService({
    repository,
    getCurrentUsername: options.getCurrentUsername || (() => ALICE),
    now: options.now || (() => NOW + 100),
    inspectWritingRecovery: options.inspectWritingRecovery || null,
    emitLearningInvalidated: options.emitLearningInvalidated || (() => {}),
  });
}

async function compareArtifact(repository, setup) {
  return repository.createAiArtifact({
    schemaVersion: WRITING_SCHEMA_VERSION,
    artifactId: "compare-1",
    username: ALICE,
    sessionId: setup.session.sessionId,
    sourceAttemptId: setup.w3.attemptId,
    artifactType: "compare_diagnosis",
    provider: "fixture",
    modelId: "fixture",
    promptVersion: "p1",
    payloadVersion: "p1",
    result: {
      units: [{
        unitId: "u1",
        learnablePatterns: [{ sampleExcerpt: "Dear students", userExcerpt: "Dear students", reason: "stable opening" }],
      }],
    },
    createdAt: NOW + 20,
  });
}

test("local calendar helpers cross month boundaries without millisecond arithmetic", () => {
  const completed = new Date(2026, 0, 31, 23, 45).getTime();
  assert.equal(localCalendarDateFromTimestamp(completed), "2026-01-31");
  assert.equal(addLocalCalendarDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addLocalCalendarDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addLocalCalendarDays("2026-12-31", 1), "2027-01-01");
});

test("completed Session schedules exactly deterministic D1/D3/D7 tasks and retries idempotently", async () => {
  const repository = createRepository();
  const setup = await setupCompletedSession(repository);
  const events = [];
  const integration = service(repository, { emitLearningInvalidated: (payload) => events.push(payload) });
  const first = await integration.ensureWritingReviewTasksForCompletedSession({ sessionId: setup.session.sessionId });
  assert.equal(first.createdCount, 3);
  assert.deepEqual(first.tasks.map((task) => task.taskId), [
    writingReviewTaskId(setup.session.sessionId, WritingReviewType.D1),
    writingReviewTaskId(setup.session.sessionId, WritingReviewType.D3),
    writingReviewTaskId(setup.session.sessionId, WritingReviewType.D7),
  ]);
  assert.deepEqual(first.tasks.map((task) => task.scheduledDate), ["2026-09-01", "2026-09-03", "2026-09-07"]);
  assert.equal(first.tasks[0].sourceRefs.translationSnapshotId, setup.translation.snapshot.snapshotId);
  assert.deepEqual(first.tasks[0].sourceRefs.learningItemIds, []);
  assert.deepEqual(first.tasks[1].sourceRefs, { skeletonRevisionId: null, promptFingerprint: setup.session.promptSnapshot.fingerprint });
  assert.equal(first.tasks[1].mode, "prompt_only");
  assert.equal(first.tasks[2].sourceRefs.sourcePromptFingerprint, setup.session.promptSnapshot.fingerprint);
  assert.equal(events.length, 1, "one batch write emits one centralized invalidation");

  const second = await integration.ensureWritingReviewTasksForCompletedSession({ sessionId: setup.session.sessionId });
  assert.equal(second.createdCount, 0);
  assert.deepEqual(second.tasks.map((task) => task.fingerprint), first.tasks.map((task) => task.fingerprint));
  assert.equal(events.length, 1, "idempotent no-op does not emit");
  const reloaded = service(repository);
  const third = await reloaded.ensureWritingReviewTasksForCompletedSession({ sessionId: setup.session.sessionId });
  assert.equal(third.createdCount, 0);
});

test("D3 completed path freezes the exact committed skeleton and uses skeleton_only", async () => {
  const repository = createRepository();
  const setup = await setupCompletedSession(repository, { skeletonMode: "completed" });
  const result = await service(repository).ensureWritingReviewTasksForCompletedSession({ sessionId: setup.session.sessionId });
  const d3 = result.tasks.find((task) => task.reviewType === WritingReviewType.D3);
  assert.equal(d3.sourceRefs.skeletonRevisionId, setup.skeleton.revisionId);
  assert.equal(d3.mode, "skeleton_only");
});

test("non-completed Session creates no ReviewTask", async () => {
  const repository = createRepository();
  const setup = await setupCompletedSession(repository);
  const active = { ...setup.session, status: "ACTIVE", currentStage: "W8_SCORE_REWRITE", completedAt: null };
  const integration = service(repository, {
    inspectWritingRecovery: async () => ({ session: active, safeStage: "W8_SCORE_REWRITE" }),
  });
  await assert.rejects(
    integration.ensureWritingReviewTasksForCompletedSession({ sessionId: setup.session.sessionId }),
    (error) => error.code === "not-completed",
  );
  assert.equal((await repository.listReviewTasks()).length, 0);
});

test("explicit user_marked and ai_suggested_confirmed create immutable LearningItems; AI artifact alone creates none", async () => {
  const repository = createRepository();
  const setup = await setupCompletedSession(repository);
  const artifact = await compareArtifact(repository, setup);
  assert.equal((await repository.listLearningItems()).length, 0, "AI suggestion is not auto-persisted");
  const events = [];
  const integration = service(repository, { emitLearningInvalidated: (payload) => events.push(payload) });
  const user = await integration.confirmWritingLearningItem({
    itemId: "item-user",
    sessionId: setup.session.sessionId,
    sourceText: "welcome",
    sourceUnitId: "u2",
    kind: "expression",
    origin: WritingLearningItemOrigin.USER_MARKED,
  });
  assert.equal(user.item.origin, "user_marked");
  const ai = await integration.confirmWritingLearningItem({
    itemId: "item-ai",
    sessionId: setup.session.sessionId,
    sourceText: "Dear students",
    sourceUnitId: "u1",
    sourceAttemptId: setup.w3.attemptId,
    sourceArtifactId: artifact.artifactId,
    kind: "structure",
    origin: WritingLearningItemOrigin.AI_SUGGESTED_CONFIRMED,
  });
  assert.equal(ai.item.origin, "ai_suggested_confirmed");
  assert.equal(events.length, 2);
  const retry = await integration.confirmWritingLearningItem({
    itemId: "item-ai",
    sessionId: setup.session.sessionId,
    sourceText: "Dear students",
    sourceUnitId: "u1",
    sourceAttemptId: setup.w3.attemptId,
    sourceArtifactId: artifact.artifactId,
    kind: "structure",
    origin: WritingLearningItemOrigin.AI_SUGGESTED_CONFIRMED,
  });
  assert.equal(retry.created, false);
  assert.equal(events.length, 2);
});

test("AI confirmation rejects arbitrary text or missing artifact lineage", async () => {
  const repository = createRepository();
  const setup = await setupCompletedSession(repository);
  const integration = service(repository);
  await assert.rejects(integration.confirmWritingLearningItem({
    itemId: "bad-ai",
    sessionId: setup.session.sessionId,
    sourceText: "Dear students",
    sourceUnitId: "u1",
    sourceAttemptId: setup.w3.attemptId,
    kind: "structure",
    origin: WritingLearningItemOrigin.AI_SUGGESTED_CONFIRMED,
  }), (error) => error.code === "invalid-input");
  assert.equal((await repository.listLearningItems()).length, 0);
});

test("scheduler freezes confirmed LearningItem ids and reports same-id/different-content conflict", async () => {
  const repository = createRepository();
  const setup = await setupCompletedSession(repository);
  const integration = service(repository);
  await integration.confirmWritingLearningItem({
    itemId: "item-z",
    sessionId: setup.session.sessionId,
    sourceText: "welcome",
    sourceUnitId: "u2",
    kind: "expression",
    origin: WritingLearningItemOrigin.USER_MARKED,
  });
  const scheduled = await integration.ensureWritingReviewTasksForCompletedSession({ sessionId: setup.session.sessionId });
  assert.deepEqual(scheduled.tasks[0].sourceRefs.learningItemIds, ["item-z"]);
  await integration.confirmWritingLearningItem({
    itemId: "item-a",
    sessionId: setup.session.sessionId,
    sourceText: "Dear students",
    sourceUnitId: "u1",
    kind: "collocation",
    origin: WritingLearningItemOrigin.USER_MARKED,
  });
  const retry = await integration.ensureWritingReviewTasksForCompletedSession({ sessionId: setup.session.sessionId });
  assert.equal(retry.tasks[0].sourceRefs.learningItemIds.includes("item-a"), false, "existing ReviewTask sourceRefs remain frozen");

  const otherRepository = createRepository();
  const other = await setupCompletedSession(otherRepository);
  await otherRepository.saveReviewTask({
    schemaVersion: WRITING_SCHEMA_VERSION,
    taskId: writingReviewTaskId(other.session.sessionId, WritingReviewType.D1),
    username: ALICE,
    sourceSessionId: other.session.sessionId,
    reviewType: WritingReviewType.D1,
    scheduledDate: "2026-09-01",
    status: WritingReviewStatus.PENDING,
    sourceRefs: { translationSnapshotId: "different-snapshot", learningItemIds: [] },
    mode: null,
    activeAttemptId: null,
    completedAttemptId: null,
    completedAt: null,
    createdAt: other.session.completedAt,
    updatedAt: other.session.completedAt,
    revision: 0,
  }, { expectedRevision: 0 });
  await assert.rejects(
    service(otherRepository).ensureWritingReviewTasksForCompletedSession({ sessionId: other.session.sessionId }),
    WritingConflictError,
  );
});

test("account switching blocks integration writes", async () => {
  const store = scopedStore();
  const repository = createRepository(store, ALICE);
  const setup = await setupCompletedSession(repository);
  await assert.rejects(
    service(repository, { getCurrentUsername: () => "bob" }).ensureWritingReviewTasksForCompletedSession({ sessionId: setup.session.sessionId }),
    (error) => error.code === "account-mismatch",
  );
});

test("LearningStateSnapshot projects only lightweight Writing session/task summaries", () => {
  globalThis.localStorage.clear();
  setCurrentUsername(ALICE);
  setUserItem("wuliao:writing-session:v1:snapshot-session", JSON.stringify({
    schemaVersion: 1,
    sessionId: "snapshot-session",
    username: ALICE,
    taskType: "postgrad-en1-writing-a",
    year: 2026,
    status: "ACTIVE",
    currentStage: "W3_BACK_TRANSLATION",
    lastActiveAt: NOW,
    completedAt: null,
    fingerprint: "a".repeat(64),
    promptSnapshot: { promptText: "PROMPT_BODY_FORBIDDEN" },
    sampleEssaySnapshot: { text: "SAMPLE_BODY_FORBIDDEN" },
  }));
  setUserItem("wuliao:writing-review-task:v1:task-1", JSON.stringify({
    schemaVersion: 1,
    taskId: "task-1",
    username: ALICE,
    sourceSessionId: "snapshot-session",
    reviewType: "D1",
    scheduledDate: "2026-09-01",
    status: "pending",
    fingerprint: "b".repeat(64),
    sourceRefs: { secret: "FORBIDDEN" },
  }));
  setUserItem("wuliao:writing-attempt:v1:attempt-secret", JSON.stringify({ verifiedText: "ATTEMPT_BODY_FORBIDDEN" }));
  const snapshot = getLearningSnapshot({ today: "2026-09-01", force: true });
  assert.deepEqual(Object.keys(snapshot.scan.writingSessions[0]).sort(), ["completedAt", "currentStage", "lastActiveAt", "sessionId", "status", "taskType", "year"].sort());
  assert.deepEqual(Object.keys(snapshot.scan.writingReviewTasks[0]).sort(), ["reviewType", "scheduledDate", "sourceSessionId", "status", "taskId"].sort());
  const text = JSON.stringify(snapshot.scan);
  for (const forbidden of ["PROMPT_BODY_FORBIDDEN", "SAMPLE_BODY_FORBIDDEN", "ATTEMPT_BODY_FORBIDDEN", "FORBIDDEN"]) {
    assert.equal(text.includes(forbidden), false);
  }
});

test("Planner emits stable continue-writing and due/overdue/in_progress review candidates only", () => {
  const scan = {
    writingSessions: [
      { sessionId: "active", status: "ACTIVE", currentStage: "W5_SKELETON", lastActiveAt: 20, taskType: "a", year: 2026 },
      { sessionId: "done", status: "COMPLETED", currentStage: "DONE", lastActiveAt: 30, taskType: "a", year: 2026 },
    ],
    writingReviewTasks: [
      { taskId: "due", sourceSessionId: "done", reviewType: "D1", scheduledDate: "2026-09-01", status: "pending" },
      { taskId: "late", sourceSessionId: "done", reviewType: "D3", scheduledDate: "2026-08-29", status: "pending" },
      { taskId: "progress", sourceSessionId: "done", reviewType: "D7", scheduledDate: "2026-09-03", status: "in_progress" },
      { taskId: "future", sourceSessionId: "done", reviewType: "D7", scheduledDate: "2026-09-03", status: "pending" },
      { taskId: "complete", sourceSessionId: "done", reviewType: "D1", scheduledDate: "2026-09-01", status: "completed" },
      { taskId: "dismiss", sourceSessionId: "done", reviewType: "D1", scheduledDate: "2026-09-01", status: "dismissed" },
    ],
  };
  const first = buildWritingPlannerCandidates({ scan, today: "2026-09-01" });
  const second = buildWritingPlannerCandidates({ scan, today: "2026-09-01" });
  assert.deepEqual(second, first);
  assert.deepEqual(first.map((candidate) => candidate.id), [
    "writing:active",
    "writing-review-candidate:due",
    "writing-review-candidate:late",
    "writing-review-candidate:progress",
  ]);
  assert.equal(first.find((candidate) => candidate.id.endsWith("late")).metadata.status, "overdue");
  assert.equal(first.find((candidate) => candidate.id.endsWith("progress")).metadata.status, "in_progress");
});

test("Writing unknown words reuse the shared store and keep account/session/sample lineage", async () => {
  const repository = createRepository();
  const setup = await setupCompletedSession(repository);
  const saved = [];
  const bridge = createWritingUnknownWordsService({
    repository,
    getCurrentUsername: () => ALICE,
    saveSharedUnknownWord: async (entry) => { saved.push(entry); return { ...entry, id: "shared-id", username: ALICE }; },
  });
  const result = await bridge.saveWritingUnknownWord({
    sessionId: setup.session.sessionId,
    sampleEssayFingerprint: setup.session.sampleEssaySnapshot.fingerprint,
    unitId: "u1",
    sourceLabel: "Sample unit 1",
    word: "Students",
    occurrenceId: "writing:u1:0",
  });
  assert.equal(result.sourceType, "writing");
  assert.equal(result.sessionId, setup.session.sessionId);
  assert.equal(result.sampleEssayFingerprint, setup.session.sampleEssaySnapshot.fingerprint);
  assert.equal(result.unitId, "u1");
  assert.equal(saved.length, 1);
  assert.equal("unknownWords" in setup.session, false);
  await assert.rejects(createWritingUnknownWordsService({
    repository,
    getCurrentUsername: () => "bob",
    saveSharedUnknownWord: async () => null,
  }).saveWritingUnknownWord({
    sessionId: setup.session.sessionId,
    sampleEssayFingerprint: setup.session.sampleEssaySnapshot.fingerprint,
    word: "students",
    occurrenceId: "x",
  }), (error) => error.code === "account-mismatch");
});

function backupSources({ writingValue, inkFingerprint = "ink-fp" } = {}) {
  return {
    entries: [
      { key: "kaoyan_vocab_current_user", value: ALICE },
      { key: `wuliao:user:${ALICE}:wuliao:writing-session:v1:s1`, value: writingValue },
      { key: `wuliao:user:${ALICE}:wuliao:writing:vision-model-catalog:v1`, value: "catalog-secret" },
      { key: `wuliao:user:${ALICE}:wuliao:writing:vision-api-key`, value: "api-secret" },
      { key: `wuliao:user:${ALICE}:wuliao:writing-runtime:v1:image`, value: "data:image/png;base64,AAAA" },
    ],
    databases: [{
      name: "wuliao-english",
      stores: [{ name: "writing-ink", records: [{ key: "ink-1", value: { id: "ink-1", username: ALICE, fingerprint: inkFingerprint, strokes: [] } }] }],
    }],
  };
}

test("Backup v1 includes formal Writing facts/writing-ink and excludes secrets, caches and inline images", async () => {
  const writingValue = JSON.stringify({ sessionId: "s1", username: ALICE, fingerprint: "a".repeat(64) });
  const sources = backupSources({ writingValue });
  const formalKeys = [
    "wuliao:writing-translation:v1:r1",
    "wuliao:writing-translation-snapshot:v1:t1",
    "wuliao:writing-attempt:v1:a1",
    "wuliao:writing-transcription:v1:x1",
    "wuliao:writing-skeleton:v1:k1",
    "wuliao:writing-learning-item:v1:l1",
    "wuliao:writing-ai-artifact:v1:ai1",
    "wuliao:writing-score:v1:sc1",
    "wuliao:writing-review-task:v1:rt1",
  ];
  sources.entries.push(...formalKeys.map((key, index) => ({
    key: `wuliao:user:${ALICE}:${key}`,
    value: JSON.stringify({ username: ALICE, fingerprint: String(index + 1).repeat(64).slice(0, 64) }),
  })));
  const backup = await createBackup({ sources, username: ALICE });
  assert.equal(backup.manifest.format, BACKUP_FORMAT);
  assert.equal(backup.manifest.version, BACKUP_VERSION);
  assert.deepEqual(
    new Set(backup.manifest.sections.localStorage.user.map((row) => row.key)),
    new Set(["wuliao:writing-session:v1:s1", ...formalKeys]),
  );
  assert.equal(backup.manifest.sections.indexedDB["wuliao-english"]["writing-ink"].length, 1);
  const text = backup.fileText;
  for (const forbidden of ["catalog-secret", "api-secret", "data:image/png", "AAAA"]) assert.equal(text.includes(forbidden), false);
});

test("Writing restore is idempotent by fingerprint and conflicts on local/ink fingerprint mismatch", async () => {
  const incoming = JSON.stringify({ sessionId: "s1", username: ALICE, fingerprint: "a".repeat(64) });
  const backup = await createBackup({ sources: backupSources({ writingValue: incoming }), username: ALICE });
  const existingKey = `wuliao:user:${ALICE}:wuliao:writing-session:v1:s1`;
  const makeIdb = (fingerprint) => ({
    listExists: async () => true,
    get: async () => ({ id: "ink-1", username: ALICE, fingerprint }),
    put: async () => { throw new Error("must not overwrite"); },
  });
  const same = await restoreBackup({
    manifest: backup.manifest,
    username: ALICE,
    existingEntries: [{ key: existingKey, value: incoming }],
    writeLocal: () => { throw new Error("must not overwrite"); },
    idb: makeIdb("ink-fp"),
    createFile: () => null,
  });
  assert.equal(same.ok, true);
  assert.equal(same.writtenLocal, 0);
  assert.equal(same.writtenIdb, 0);

  const conflict = await restoreBackup({
    manifest: backup.manifest,
    username: ALICE,
    existingEntries: [{ key: existingKey, value: JSON.stringify({ sessionId: "s1", username: ALICE, fingerprint: "b".repeat(64) }) }],
    writeLocal: () => { throw new Error("must not overwrite"); },
    idb: makeIdb("different-ink-fp"),
    createFile: () => null,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.errors.filter((error) => error.code === "conflict").length, 2);
});
