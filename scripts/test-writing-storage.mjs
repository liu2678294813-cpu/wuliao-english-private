import test from "node:test";
import assert from "node:assert/strict";

await import("./test-hooks.mjs");

const {
  DEVICE_PRIVATE_WRITING_SAMPLE_STORE,
  LONG_SENTENCE_STORES,
  WRITING_INK_STORE,
  WULIAO_ENGLISH_DB_VERSION,
  openWuliaoEnglishDatabase,
} = await import("../src/storage.js");
const {
  WritingAccountMismatchError,
  WritingConflictError,
  WritingDataError,
  WritingImmutableError,
  WritingRepository,
  WritingStaleRevisionError,
  assertScoreReportLineage,
  assertTranslationSnapshotLineage,
  assertTranslationUnitsMatchSample,
  canonicalWritingJson,
  computeWritingFingerprint,
  createVerifiedText,
  fingerprintWritingRecord,
  writingKeys,
  writingReviewTaskId,
} = await import("../src/writing/writingRepository.js");
const {
  WRITING_SCHEMA_VERSION,
  WritingAttemptStatus,
  WritingAttemptType,
  WritingDraftStatus,
  WritingInputMethod,
  WritingReconstructionOutcome,
  WritingReviewStatus,
  WritingReviewType,
  WritingSessionStatus,
  WritingSkeletonOutcome,
  WritingStage,
  WritingTaskType,
} = await import("../src/writing/writingModels.js");
const {
  WritingInkStaleRevisionError,
  WritingInkStorageError,
  fingerprintWritingInkSnapshot,
  getWritingInkSnapshot,
  saveWritingInkSnapshot,
  writingInkRecordId,
  writingInkRefFromSnapshot,
} = await import("../src/writing/writingInkStorage.js");

const ALICE = "alice";
const NOW = 1_800_000_000_000;

function scopedStore() {
  const values = new Map();
  const physical = (key, username) => `${username}::${key}`;
  return {
    values,
    getItem: (key, username) => values.get(physical(key, username)) ?? null,
    setItem: (key, value, username) => values.set(physical(key, username), String(value)),
    listItems: (prefix, username) => [...values.entries()]
      .filter(([key]) => key.startsWith(`${username}::${prefix}`))
      .map(([key, value]) => ({ key: key.slice(`${username}::`.length), value })),
    rawKey: physical,
  };
}

function repository(store = scopedStore(), username = ALICE) {
  return new WritingRepository({ username, getItem: store.getItem, setItem: store.setItem, listItems: store.listItems });
}

async function promptSnapshot(taskType = WritingTaskType.POSTGRAD_EN1_WRITING_A, year = 2025) {
  return fingerprintWritingRecord({
    questionId: "question-a",
    sourceType: "official",
    taskType,
    year,
    promptText: "Write a notice.",
    directions: "Write about 100 words.",
    promptKind: "notice",
    assets: [],
    maxScore: taskType === WritingTaskType.POSTGRAD_EN1_WRITING_A ? 10 : 20,
    targetWordRange: { min: 90, max: 120 },
  });
}

async function sampleEssaySnapshot() {
  return fingerprintWritingRecord({
    essayId: "essay-a",
    sourceType: "embedded",
    text: "Dear students, welcome to the club.",
    wordCount: 7,
    segments: [{ unitId: "u1", text: "Dear students," }, { unitId: "u2", text: "welcome to the club." }],
    qualityStatus: "passed",
    qualityGateVersion: "v1",
    qualityReportFingerprint: "quality-fp",
    generatorMetadata: { provider: "embedded" },
  });
}

function stageFacts(overrides = {}) {
  return {
    w1ReadingCompletedAt: null,
    w4CompareCompletedAt: null,
    w5Outcome: WritingSkeletonOutcome.NOT_REACHED,
    w5EndedAt: null,
    committedSkeletonRevisionId: null,
    w6Outcome: WritingReconstructionOutcome.NOT_REACHED,
    w6EndedAt: null,
    w6AttemptId: null,
    viewedScoreReportIds: [],
    completedByScoreReportId: null,
    ...overrides,
  };
}

async function sessionCandidate(overrides = {}) {
  const taskType = overrides.taskType || WritingTaskType.POSTGRAD_EN1_WRITING_A;
  const year = Object.prototype.hasOwnProperty.call(overrides, "year") ? overrides.year : 2025;
  return {
    schemaVersion: WRITING_SCHEMA_VERSION,
    sessionId: "session-1",
    username: ALICE,
    taskType,
    year,
    status: WritingSessionStatus.ACTIVE,
    currentStage: WritingStage.W1_SAMPLE_READING,
    promptSnapshot: await promptSnapshot(taskType, year),
    sampleEssaySnapshot: await sampleEssaySnapshot(),
    stageFacts: stageFacts(),
    createdAt: NOW,
    startedAt: NOW,
    lastActiveAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    revision: 0,
    ...overrides,
  };
}

function inkRef(overrides = {}) {
  return {
    id: "ink-1",
    surfaceId: "w2:translation:translation-1",
    revision: 1,
    fingerprint: "ink-fingerprint",
    sourceFingerprint: "source-fingerprint",
    updatedAt: NOW,
    ownerRecordId: "translation-1",
    stageId: WritingStage.W2_EN_ZH,
    ...overrides,
  };
}

function translationCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    revisionId: "translation-1",
    sessionId: "session-1",
    username: ALICE,
    revisionNumber: 1,
    status: WritingDraftStatus.DRAFT,
    basedOnRevisionId: null,
    units: [{ unitId: "u1", inputMethod: "typed", typedText: "亲爱的同学们", inkRef: null }],
    createdAt: NOW,
    updatedAt: NOW,
    committedAt: null,
    revision: 0,
    ...overrides,
  };
}

function attemptCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    attemptId: "attempt-w3",
    sessionId: "session-1",
    username: ALICE,
    attemptType: WritingAttemptType.BACK_TRANSLATION,
    stageId: WritingStage.W3_BACK_TRANSLATION,
    status: WritingAttemptStatus.DRAFTING,
    parentAttemptId: null,
    context: { translationSnapshotId: "snapshot-1" },
    inputMethod: "typed",
    typedText: "Dear students",
    inkRef: null,
    transcriptionId: null,
    verifiedText: null,
    timing: { startedAt: NOW, elapsedMs: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    rawSubmittedAt: null,
    submittedAt: null,
    revision: 0,
    ...overrides,
  };
}

function skeletonCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    revisionId: "skeleton-1",
    sessionId: "session-1",
    username: ALICE,
    revisionNumber: 1,
    status: WritingDraftStatus.DRAFT,
    basedOnRevisionId: null,
    blocks: [{ order: 0, kind: "idea", text: "invite students" }, { order: 1, kind: "logic", text: "purpose → time → contact" }],
    inkRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    committedAt: null,
    revision: 0,
    ...overrides,
  };
}

function transcriptionCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    transcriptionId: "transcription-1",
    sessionId: "session-1",
    username: ALICE,
    sourceAttemptId: "attempt-w7",
    sourceInkRef: inkRef({ id: "ink-w7", surfaceId: "w7:independent:attempt-w7", ownerRecordId: "attempt-w7", stageId: WritingStage.W7_INDEPENDENT }),
    rawTranscript: "raw words",
    segments: [{ text: "raw words" }],
    provider: "provider",
    modelId: "vision-model",
    promptVersion: "p1",
    adapterVersion: "a1",
    requestMetadata: { requestId: "r1" },
    createdAt: NOW,
    ...overrides,
  };
}

function aiArtifactCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: "artifact-1",
    sessionId: "session-1",
    username: ALICE,
    sourceAttemptId: "attempt-w3",
    artifactType: "compare_diagnosis",
    provider: "provider",
    modelId: "model",
    promptVersion: "p1",
    payloadVersion: "v1",
    result: { differences: ["word choice"] },
    createdAt: NOW,
    ...overrides,
  };
}

function learningItemCandidate(overrides = {}) {
  return {
    schemaVersion: 1,
    itemId: "item-1",
    sessionId: "session-1",
    username: ALICE,
    kind: "expression",
    sourceText: "be committed to",
    sourceUnitId: "u1",
    sourceAttemptId: null,
    origin: "user_marked",
    cueZh: "致力于",
    confirmedAt: NOW,
    ...overrides,
  };
}

function scoreCandidate(sourceAttempt, overrides = {}) {
  return {
    schemaVersion: 1,
    scoreReportId: "score-1",
    sessionId: "session-1",
    username: ALICE,
    sourceAttemptId: sourceAttempt.attemptId,
    sourceTextFingerprint: sourceAttempt.verifiedText.fingerprint,
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A,
    maxScore: 10,
    finalScore: 7,
    band: 3.5,
    zeroReason: null,
    rubricVersion: "postgrad-en1-writing-a-v1",
    promptVersion: "p1",
    provider: "provider",
    modelId: "model",
    dimensions: { content: 4, language: 3 },
    wordCount: 102,
    lengthIssue: null,
    issues: [],
    strengths: ["clear"],
    revisionAdvice: ["vary syntax"],
    handwritingAssessed: false,
    createdAt: NOW,
    ...overrides,
  };
}

function reviewTaskCandidate(reviewType, overrides = {}) {
  const sourceSessionId = overrides.sourceSessionId || "session-1";
  const defaults = {
    [WritingReviewType.D1]: {
      sourceRefs: { translationSnapshotId: "snapshot-1", learningItemIds: ["item-1"] },
      mode: null,
    },
    [WritingReviewType.D3]: {
      sourceRefs: { skeletonRevisionId: null, promptFingerprint: "prompt-fp" },
      mode: "prompt_only",
    },
    [WritingReviewType.D7]: {
      sourceRefs: { learningItemIds: ["item-1"], sourcePromptFingerprint: "prompt-fp" },
      mode: null,
    },
  }[reviewType];
  return {
    schemaVersion: 1,
    taskId: writingReviewTaskId(sourceSessionId, reviewType),
    username: ALICE,
    sourceSessionId,
    reviewType,
    scheduledDate: "2026-08-31",
    status: WritingReviewStatus.PENDING,
    ...defaults,
    activeAttemptId: null,
    completedAttemptId: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 0,
    ...overrides,
  };
}

test("A/B schema identity, canonical keys, normalized SHA-256 fingerprints", async () => {
  assert.equal(WRITING_SCHEMA_VERSION, 1);
  assert.equal(writingKeys.session("s1"), "wuliao:writing-session:v1:s1");
  assert.equal(writingKeys.translationRevision("r1"), "wuliao:writing-translation:v1:r1");
  assert.equal(writingKeys.translationSnapshot("x1"), "wuliao:writing-translation-snapshot:v1:x1");
  assert.equal(writingKeys.attempt("a1"), "wuliao:writing-attempt:v1:a1");
  assert.equal(writingKeys.transcription("t1"), "wuliao:writing-transcription:v1:t1");
  assert.equal(writingKeys.skeletonRevision("k1"), "wuliao:writing-skeleton:v1:k1");
  assert.equal(writingKeys.learningItem("l1"), "wuliao:writing-learning-item:v1:l1");
  assert.equal(writingKeys.aiArtifact("ai1"), "wuliao:writing-ai-artifact:v1:ai1");
  assert.equal(writingKeys.scoreReport("sc1"), "wuliao:writing-score:v1:sc1");
  assert.equal(writingKeys.reviewTask("rt1"), "wuliao:writing-review-task:v1:rt1");
  const a = { schemaVersion: 1, username: ALICE, nested: { z: 2, a: 1 }, fingerprint: "ignored" };
  const b = { nested: { a: 1, z: 2 }, username: ALICE, schemaVersion: 1 };
  assert.equal(canonicalWritingJson(a).includes('"fingerprint"'), true, "canonicalizer itself is lossless");
  assert.equal(await computeWritingFingerprint(a), await computeWritingFingerprint(b));
  assert.notEqual(await computeWritingFingerprint(a), await computeWritingFingerprint({ ...b, username: "bob" }));
  assert.match(await computeWritingFingerprint(a), /^[a-f0-9]{64}$/);
});

test("A schema accepts frozen nullable fields and rejects null/year or type mismatches", async () => {
  const repo = repository();
  const nullablePrompt = await fingerprintWritingRecord({ ...(await promptSnapshot(WritingTaskType.POSTGRAD_EN1_WRITING_A, null)), promptKind: null });
  const nullableSample = await fingerprintWritingRecord({ ...(await sampleEssaySnapshot()), generatorMetadata: null });
  const saved = await repo.saveSession(await sessionCandidate({
    sessionId: "session-null-year",
    year: null,
    promptSnapshot: nullablePrompt,
    sampleEssaySnapshot: nullableSample,
  }), { expectedRevision: 0 });
  assert.equal(saved.year, null);
  assert.equal(saved.promptSnapshot.year, null);
  assert.equal(saved.promptSnapshot.promptKind, null);
  assert.equal(saved.sampleEssaySnapshot.generatorMetadata, null);

  const wrongYearPrompt = await promptSnapshot(WritingTaskType.POSTGRAD_EN1_WRITING_A, 2025);
  await assert.rejects(repo.saveSession(await sessionCandidate({ sessionId: "bad-null-year", year: null, promptSnapshot: wrongYearPrompt }), { expectedRevision: 0 }), WritingDataError);
  const badPromptKind = await fingerprintWritingRecord({ ...nullablePrompt, promptKind: 7 });
  await assert.rejects(repo.saveSession(await sessionCandidate({ sessionId: "bad-prompt-kind", year: null, promptSnapshot: badPromptKind }), { expectedRevision: 0 }), WritingDataError);
  const aiSampleWithoutMetadata = await fingerprintWritingRecord({ ...(await sampleEssaySnapshot()), sourceType: "ai_generated", generatorMetadata: null });
  await assert.rejects(repo.saveSession(await sessionCandidate({ sessionId: "bad-ai-metadata", sampleEssaySnapshot: aiSampleWithoutMetadata }), { expectedRevision: 0 }), WritingDataError);
});

test("A Writing formal fingerprints fail closed when SHA-256 is unavailable", async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    await assert.rejects(computeWritingFingerprint({ value: "x" }), (error) => error instanceof WritingDataError && error.code === "fingerprint-unavailable");
    await assert.rejects(fingerprintWritingInkSnapshot({ value: "x" }), (error) => error instanceof WritingInkStorageError && error.code === "fingerprint-unavailable");
  } finally {
    Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  }
});

test("C account isolation rejects writes and scoped wrong-account payloads", async () => {
  const store = scopedStore();
  const alice = repository(store, ALICE);
  const bob = repository(store, "bob");
  const saved = await alice.saveSession(await sessionCandidate(), { expectedRevision: 0 });
  assert.equal(saved.username, ALICE);
  assert.equal(await bob.readSession(saved.sessionId), null);
  await assert.rejects(
    alice.saveSession(await sessionCandidate({ username: "bob", sessionId: "wrong-write" }), { expectedRevision: 0 }),
    WritingAccountMismatchError,
  );
  const bobSaved = await bob.saveSession(await sessionCandidate({ username: "bob" }), { expectedRevision: 0 });
  store.values.set(store.rawKey(writingKeys.session(bobSaved.sessionId), ALICE), JSON.stringify(bobSaved));
  await assert.rejects(alice.readSession(bobSaved.sessionId), WritingAccountMismatchError);
});

test("B damaged JSON, schema, identity, and fingerprint are errors rather than missing", async () => {
  const store = scopedStore();
  const repo = repository(store);
  store.values.set(store.rawKey(writingKeys.session("broken"), ALICE), "{broken-json");
  await assert.rejects(repo.readSession("broken"), (error) => error instanceof WritingDataError && error.code === "invalid-json");
  const saved = await repo.saveSession(await sessionCandidate(), { expectedRevision: 0 });
  store.values.set(store.rawKey(writingKeys.session(saved.sessionId), ALICE), JSON.stringify({ ...saved, currentStage: WritingStage.W2_EN_ZH }));
  await assert.rejects(repo.readSession(saved.sessionId), (error) => error instanceof WritingDataError && error.code === "bad-fingerprint");
  const wrongSchema = await fingerprintWritingRecord({ ...saved, schemaVersion: 2 });
  store.values.set(store.rawKey(writingKeys.session(saved.sessionId), ALICE), JSON.stringify(wrongSchema));
  await assert.rejects(repo.readSession(saved.sessionId), (error) => error instanceof WritingDataError && error.code === "wrong-schema");
  const wrongIdentity = await fingerprintWritingRecord({ ...saved, sessionId: "other-session" });
  store.values.set(store.rawKey(writingKeys.session(saved.sessionId), ALICE), JSON.stringify(wrongIdentity));
  await assert.rejects(repo.readSession(saved.sessionId), (error) => error instanceof WritingDataError && error.code === "identity-mismatch");
});

test("D mutable Repository detects post-write replacement instead of reporting success", async () => {
  const store = scopedStore();
  let tamper = true;
  const repo = new WritingRepository({
    username: ALICE,
    getItem: store.getItem,
    listItems: store.listItems,
    setItem: (key, value, username) => {
      const parsed = JSON.parse(value);
      store.setItem(key, JSON.stringify(tamper ? { ...parsed, fingerprint: "replaced" } : parsed), username);
      tamper = false;
    },
  });
  await assert.rejects(repo.saveSession(await sessionCandidate(), { expectedRevision: 0 }), WritingConflictError);
});

test("D Session expectedRevision, post-write read, append-only scores, and frozen completion evidence", async () => {
  const repo = repository();
  const created = await repo.saveSession(await sessionCandidate(), { expectedRevision: 0 });
  assert.equal(created.revision, 1);
  const updated = await repo.saveSession({
    ...created,
    currentStage: WritingStage.W2_EN_ZH,
    stageFacts: { ...created.stageFacts, w1ReadingCompletedAt: NOW + 1, viewedScoreReportIds: ["score-1"] },
    lastActiveAt: NOW + 1,
    updatedAt: NOW + 1,
  }, { expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  await assert.rejects(repo.saveSession(updated, { expectedRevision: 1 }), WritingStaleRevisionError);
  await assert.rejects(repo.saveSession({ ...updated, stageFacts: { ...updated.stageFacts, viewedScoreReportIds: [] } }, { expectedRevision: 2 }), WritingDataError);
  const completed = await repo.saveSession({
    ...updated,
    status: WritingSessionStatus.COMPLETED,
    currentStage: WritingStage.DONE,
    stageFacts: { ...updated.stageFacts, completedByScoreReportId: "score-1" },
    completedAt: NOW + 2,
    updatedAt: NOW + 2,
  }, { expectedRevision: 2 });
  const rescored = await repo.saveSession({
    ...completed,
    stageFacts: { ...completed.stageFacts, viewedScoreReportIds: ["score-1", "score-2"] },
    updatedAt: NOW + 3,
  }, { expectedRevision: 3 });
  assert.equal(rescored.stageFacts.completedByScoreReportId, "score-1");
  await assert.rejects(repo.saveSession({ ...rescored, stageFacts: { ...rescored.stageFacts, completedByScoreReportId: "score-2" } }, { expectedRevision: 4 }), WritingDataError);
});

test("D Session rejects PAUSED, invalid prompt maxScore/base64, and failed sample", async () => {
  const repo = repository();
  await assert.rejects(repo.saveSession(await sessionCandidate({ status: "PAUSED" }), { expectedRevision: 0 }), WritingDataError);
  const badPrompt = await promptSnapshot();
  const invalidPrompt = await fingerprintWritingRecord({ ...badPrompt, maxScore: 20, assets: [{ src: "data:image/png;base64,AAAA" }] });
  await assert.rejects(repo.saveSession(await sessionCandidate({ sessionId: "bad-prompt", promptSnapshot: invalidPrompt }), { expectedRevision: 0 }), WritingDataError);
  const failedSample = await fingerprintWritingRecord({ ...(await sampleEssaySnapshot()), qualityStatus: "failed" });
  await assert.rejects(repo.saveSession(await sessionCandidate({ sessionId: "bad-sample", sampleEssaySnapshot: failedSample }), { expectedRevision: 0 }), WritingDataError);
});

test("D Session freezes creation and one-way stage/completion facts", async () => {
  const repo = repository();
  const created = await repo.saveSession(await sessionCandidate({ sessionId: "session-freeze" }), { expectedRevision: 0 });
  await assert.rejects(repo.saveSession({ ...created, createdAt: NOW - 1 }, { expectedRevision: 1 }), WritingDataError);
  await assert.rejects(repo.saveSession({ ...created, startedAt: NOW - 1 }, { expectedRevision: 1 }), WritingDataError);
  const w1Done = await repo.saveSession({ ...created, stageFacts: { ...created.stageFacts, w1ReadingCompletedAt: NOW + 1 }, updatedAt: NOW + 1 }, { expectedRevision: 1 });
  await assert.rejects(repo.saveSession({ ...w1Done, stageFacts: { ...w1Done.stageFacts, w1ReadingCompletedAt: null } }, { expectedRevision: 2 }), WritingDataError);
  const w5Done = await repo.saveSession({
    ...w1Done,
    stageFacts: { ...w1Done.stageFacts, w5Outcome: WritingSkeletonOutcome.COMPLETED, w5EndedAt: NOW + 2, committedSkeletonRevisionId: "skeleton-1" },
    updatedAt: NOW + 2,
  }, { expectedRevision: 2 });
  await assert.rejects(repo.saveSession({ ...w5Done, stageFacts: { ...w5Done.stageFacts, w5Outcome: WritingSkeletonOutcome.SKIPPED, committedSkeletonRevisionId: null } }, { expectedRevision: 3 }), WritingDataError);
  const w6Done = await repo.saveSession({
    ...w5Done,
    stageFacts: { ...w5Done.stageFacts, w6Outcome: WritingReconstructionOutcome.SUBMITTED, w6EndedAt: NOW + 3, w6AttemptId: "attempt-w6" },
    updatedAt: NOW + 3,
  }, { expectedRevision: 3 });
  await assert.rejects(repo.saveSession({ ...w6Done, stageFacts: { ...w6Done.stageFacts, w6AttemptId: "other" } }, { expectedRevision: 4 }), WritingDataError);
});

test("E Translation draft autosave, stale guard, commit immutability, and frozen self-contained Snapshot", async () => {
  const repo = repository();
  const sample = await sampleEssaySnapshot();
  await repo.saveSession(await sessionCandidate({ sampleEssaySnapshot: sample }), { expectedRevision: 0 });
  const draft = await repo.saveTranslationRevision(translationCandidate(), { expectedRevision: 0 });
  assert.equal(assertTranslationUnitsMatchSample(draft, sample), true);
  const callerSample = { ...sample, segments: [{ unitId: "unknown" }] };
  await assert.rejects(repo.saveTranslationRevision(translationCandidate({ revisionId: "bad-unit", units: [{ unitId: "unknown", inputMethod: "typed", typedText: "x", inkRef: null }] }), { expectedRevision: 0, sampleEssaySnapshot: callerSample }), WritingDataError);
  const autosaved = await repo.saveTranslationRevision({ ...draft, units: [{ ...draft.units[0], typedText: "亲爱的学生们" }], updatedAt: NOW + 1 }, { expectedRevision: 1 });
  await assert.rejects(repo.saveTranslationRevision({ ...autosaved, revisionNumber: 2 }, { expectedRevision: 2 }), WritingDataError);
  await assert.rejects(repo.saveTranslationRevision({ ...autosaved, basedOnRevisionId: "other" }, { expectedRevision: 2 }), WritingDataError);
  await assert.rejects(repo.saveTranslationRevision({ ...autosaved, createdAt: NOW - 1 }, { expectedRevision: 2 }), WritingDataError);
  await assert.rejects(repo.saveTranslationRevision(autosaved, { expectedRevision: 1 }), WritingStaleRevisionError);
  const committed = await repo.saveTranslationRevision({ ...autosaved, status: WritingDraftStatus.COMMITTED, committedAt: NOW + 2, updatedAt: NOW + 2 }, { expectedRevision: 2 });
  assert.equal(committed.revision, 3);
  assert.equal((await repo.saveTranslationRevision(committed, { expectedRevision: 3 })).fingerprint, committed.fingerprint);
  await assert.rejects(repo.saveTranslationRevision({ ...committed, units: [{ ...committed.units[0], typedText: "changed" }] }, { expectedRevision: 3 }), WritingImmutableError);
  const snapshotInput = {
    schemaVersion: 1,
    snapshotId: "snapshot-1",
    sessionId: committed.sessionId,
    username: ALICE,
    translationRevisionId: committed.revisionId,
    revisionFingerprint: committed.fingerprint,
    units: committed.units.map((unit) => ({ ...unit })),
    createdAt: NOW + 3,
  };
  const snapshot = await repo.createTranslationSnapshot(snapshotInput);
  assert.equal(assertTranslationSnapshotLineage(snapshot, committed), true);
  snapshotInput.units[0].typedText = "mutated caller";
  assert.equal((await repo.readTranslationSnapshot(snapshot.snapshotId)).units[0].typedText, "亲爱的学生们");
  assert.equal((await repo.createTranslationSnapshot({ ...snapshot, fingerprint: "ignored" })).fingerprint, snapshot.fingerprint);
  await assert.rejects(repo.createTranslationSnapshot({ ...snapshot, units: [{ ...snapshot.units[0], typedText: "different" }] }), WritingConflictError);
  const callerOnlyRevision = { ...committed, revisionId: "caller-only", fingerprint: "caller-fingerprint" };
  await assert.rejects(repo.createTranslationSnapshot({ ...snapshotInput, snapshotId: "caller-only-snapshot", translationRevisionId: "caller-only", revisionFingerprint: "caller-fingerprint" }, { committedRevision: callerOnlyRevision }), WritingDataError);
});

test("E/H localStorage records reject nested strokes and Skeleton commit is immutable", async () => {
  const repo = repository();
  await assert.rejects(repo.saveTranslationRevision(translationCandidate({ units: [{ unitId: "u1", inputMethod: "handwriting", typedText: "", inkRef: { ...inkRef(), strokes: [] } }] }), { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveAttempt(attemptCandidate({ inkRef: { ...inkRef(), strokes: [] } }), { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveSkeletonRevision(skeletonCandidate({ blocks: [{ kind: "idea", text: "x", strokes: [] }] }), { expectedRevision: 0 }), WritingDataError);
  const draft = await repo.saveSkeletonRevision(skeletonCandidate(), { expectedRevision: 0 });
  await assert.rejects(repo.saveSkeletonRevision({ ...draft, revisionNumber: 2 }, { expectedRevision: 1 }), WritingDataError);
  await assert.rejects(repo.saveSkeletonRevision({ ...draft, basedOnRevisionId: "other" }, { expectedRevision: 1 }), WritingDataError);
  await assert.rejects(repo.saveSkeletonRevision({ ...draft, createdAt: NOW - 1 }, { expectedRevision: 1 }), WritingDataError);
  const committed = await repo.saveSkeletonRevision({ ...draft, status: WritingDraftStatus.COMMITTED, committedAt: NOW + 1, updatedAt: NOW + 1 }, { expectedRevision: 1 });
  await assert.rejects(repo.saveSkeletonRevision({ ...committed, blocks: [{ order: 0, kind: "keyword", text: "changed" }] }, { expectedRevision: 2 }), WritingImmutableError);
  await assert.rejects(repo.saveSkeletonRevision(skeletonCandidate({ revisionId: "bad-kind", blocks: [{ kind: "paragraph", text: "x" }] }), { expectedRevision: 0 }), WritingDataError);
});

test("E/H Translation, Skeleton, and Attempt InkRefs enforce owner/surface lineage", async () => {
  const repo = repository();
  await repo.saveSession(await sessionCandidate(), { expectedRevision: 0 });
  const validTranslationInk = inkRef();
  assert.equal((await repo.saveTranslationRevision(translationCandidate({ units: [{ unitId: "u1", inputMethod: "handwriting", typedText: "", inkRef: validTranslationInk }] }), { expectedRevision: 0 })).units[0].inkRef.ownerRecordId, "translation-1");
  await assert.rejects(repo.saveTranslationRevision(translationCandidate({ revisionId: "translation-owner-bad", units: [{ unitId: "u1", inputMethod: "handwriting", typedText: "", inkRef: inkRef({ surfaceId: "w2:translation:translation-owner-bad", ownerRecordId: "other" }) }] }), { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveTranslationRevision(translationCandidate({ revisionId: "translation-surface-bad", units: [{ unitId: "u1", inputMethod: "handwriting", typedText: "", inkRef: inkRef({ ownerRecordId: "translation-surface-bad" }) }] }), { expectedRevision: 0 }), WritingDataError);

  await assert.rejects(repo.saveSkeletonRevision(skeletonCandidate({ revisionId: "skeleton-order-missing", blocks: [{ kind: "idea", text: "x" }] }), { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveSkeletonRevision(skeletonCandidate({ revisionId: "skeleton-order-duplicate", blocks: [{ order: 0, kind: "idea", text: "x" }, { order: 0, kind: "logic", text: "y" }] }), { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveSkeletonRevision(skeletonCandidate({ revisionId: "skeleton-ink-bad", inkRef: inkRef({ surfaceId: "w5:skeleton:skeleton-ink-bad", ownerRecordId: "other", stageId: WritingStage.W5_SKELETON }) }), { expectedRevision: 0 }), WritingDataError);

  await assert.rejects(repo.saveAttempt(attemptCandidate({ attemptId: "attempt-ink-owner", inkRef: inkRef({ surfaceId: "w3:back:attempt-ink-owner", ownerRecordId: "other", stageId: WritingStage.W3_BACK_TRANSLATION }) }), { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveAttempt(attemptCandidate({ attemptId: "attempt-ink-surface", inkRef: inkRef({ surfaceId: "w7:independent:attempt-ink-surface", ownerRecordId: "attempt-ink-surface", stageId: WritingStage.W7_INDEPENDENT }) }), { expectedRevision: 0 }), WritingDataError);
});

test("F Attempt lifecycle is monotonic and submitted records are immutable", async () => {
  const repo = repository();
  const lifecycleInk = inkRef({ id: "ink-lifecycle", surfaceId: "w3:back:attempt-w3", ownerRecordId: "attempt-w3", stageId: WritingStage.W3_BACK_TRANSLATION });
  const draft = await repo.saveAttempt(attemptCandidate({ inputMethod: WritingInputMethod.HANDWRITING, typedText: null, inkRef: lifecycleInk }), { expectedRevision: 0 });
  const raw = await repo.saveAttempt({ ...draft, status: WritingAttemptStatus.RAW_SUBMITTED, rawSubmittedAt: NOW + 1, updatedAt: NOW + 1 }, { expectedRevision: 1 });
  const verifying = await repo.saveAttempt({ ...raw, status: WritingAttemptStatus.VERIFYING, transcriptionId: "transcription-1", updatedAt: NOW + 2 }, { expectedRevision: 2 });
  const verifiedText = await createVerifiedText("attempt-w3", { text: "User confirmed text.", source: "transcription", sourceTranscriptionId: "transcription-1", confirmedAt: NOW + 3 });
  const submitted = await repo.saveAttempt({ ...verifying, status: WritingAttemptStatus.SUBMITTED, verifiedText, submittedAt: NOW + 3, updatedAt: NOW + 3 }, { expectedRevision: 3 });
  assert.equal(submitted.revision, 4);
  await assert.rejects(repo.saveAttempt({ ...submitted, typedText: "changed" }, { expectedRevision: 4 }), WritingImmutableError);
});

test("F Attempt context freezes W3/W6/W7/W8 identities", async () => {
  const repo = repository();
  await assert.rejects(repo.saveAttempt(attemptCandidate({ attemptId: "bad-w3", context: {} }), { expectedRevision: 0 }), WritingDataError);
  const w6 = attemptCandidate({ attemptId: "w6-null", attemptType: WritingAttemptType.RECONSTRUCTION, stageId: WritingStage.W6_RECONSTRUCTION, context: { skeletonRevisionId: null } });
  assert.equal((await repo.saveAttempt(w6, { expectedRevision: 0 })).context.skeletonRevisionId, null);
  await assert.rejects(repo.saveAttempt({ ...w6, attemptId: "w6-missing", context: {} }, { expectedRevision: 0 }), WritingDataError);
  const verified = await createVerifiedText("w7-1", { text: "My final essay.", source: "typed", sourceTranscriptionId: null, confirmedAt: NOW });
  const w7 = attemptCandidate({ attemptId: "w7-1", attemptType: WritingAttemptType.INDEPENDENT, stageId: WritingStage.W7_INDEPENDENT, context: { promptFingerprint: "prompt-fp" }, status: WritingAttemptStatus.SUBMITTED, submittedAt: NOW, verifiedText: verified });
  assert.equal((await repo.saveAttempt(w7, { expectedRevision: 0 })).verifiedText.text, "My final essay.");
  await assert.rejects(repo.saveAttempt({ ...w7, attemptId: "w7-no-verified", verifiedText: null }, { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveAttempt(attemptCandidate({ attemptId: "w8-no-parent", attemptType: WritingAttemptType.REVISION, stageId: WritingStage.W8_SCORE_REWRITE, context: { promptFingerprint: "prompt-fp" } }), { expectedRevision: 0 }), WritingDataError);
});

test("F Attempt freezes persisted identity/context and raw submission time", async () => {
  const repo = repository();
  const w6Null = await repo.saveAttempt(attemptCandidate({
    attemptId: "w6-freeze-null",
    attemptType: WritingAttemptType.RECONSTRUCTION,
    stageId: WritingStage.W6_RECONSTRUCTION,
    context: { skeletonRevisionId: null },
    typedText: null,
    timing: null,
  }), { expectedRevision: 0 });
  assert.equal(w6Null.typedText, null);
  assert.equal(w6Null.timing, null);
  await assert.rejects(repo.saveAttempt({ ...w6Null, context: { skeletonRevisionId: "skeleton-a" } }, { expectedRevision: 1 }), WritingDataError);

  const w6Bound = await repo.saveAttempt(attemptCandidate({ attemptId: "w6-freeze-bound", attemptType: WritingAttemptType.RECONSTRUCTION, stageId: WritingStage.W6_RECONSTRUCTION, context: { skeletonRevisionId: "skeleton-a" } }), { expectedRevision: 0 });
  await assert.rejects(repo.saveAttempt({ ...w6Bound, context: { skeletonRevisionId: "skeleton-b" } }, { expectedRevision: 1 }), WritingDataError);
  await assert.rejects(repo.saveAttempt({ ...w6Bound, createdAt: NOW - 1 }, { expectedRevision: 1 }), WritingDataError);
  await assert.rejects(repo.saveAttempt({ ...w6Bound, sessionId: "other-session" }, { expectedRevision: 1 }), WritingDataError);

  const w3 = await repo.saveAttempt(attemptCandidate({ attemptId: "w3-freeze", inputMethod: WritingInputMethod.HANDWRITING, typedText: null, inkRef: inkRef({ id: "ink-w3-freeze", surfaceId: "w3:back:w3-freeze", ownerRecordId: "w3-freeze", stageId: WritingStage.W3_BACK_TRANSLATION }) }), { expectedRevision: 0 });
  await assert.rejects(repo.saveAttempt({ ...w3, context: { translationSnapshotId: "snapshot-2" } }, { expectedRevision: 1 }), WritingDataError);
  const w7 = await repo.saveAttempt(attemptCandidate({ attemptId: "w7-freeze", attemptType: WritingAttemptType.INDEPENDENT, stageId: WritingStage.W7_INDEPENDENT, context: { promptFingerprint: "prompt-a" } }), { expectedRevision: 0 });
  await assert.rejects(repo.saveAttempt({ ...w7, context: { promptFingerprint: "prompt-b" } }, { expectedRevision: 1 }), WritingDataError);
  await assert.rejects(repo.saveAttempt({ ...w7, parentAttemptId: "illegal-parent" }, { expectedRevision: 1 }), WritingDataError);

  const raw = await repo.saveAttempt({ ...w3, status: WritingAttemptStatus.RAW_SUBMITTED, rawSubmittedAt: NOW + 1, updatedAt: NOW + 1 }, { expectedRevision: 1 });
  await assert.rejects(repo.saveAttempt({ ...raw, rawSubmittedAt: NOW + 2 }, { expectedRevision: 2 }), WritingDataError);
  await assert.rejects(repo.saveAttempt({ ...raw, rawSubmittedAt: null }, { expectedRevision: 2 }), WritingDataError);
});

test("F Review Attempts use null stageId and strict D1/D3/D7 contexts", async () => {
  const repo = repository();
  const cases = [
    [WritingAttemptType.REVIEW_D1, { reviewTaskId: "task-d1", translationSnapshotId: "snapshot-1", learningItemIds: ["item-1"] }],
    [WritingAttemptType.REVIEW_D3, { reviewTaskId: "task-d3", skeletonRevisionId: null }],
    [WritingAttemptType.REVIEW_D7, { reviewTaskId: "task-d7", assignedPromptFingerprint: "assigned-prompt", learningItemIds: [] }],
  ];
  for (const [attemptType, context] of cases) {
    const attemptId = `attempt-${attemptType}`;
    const saved = await repo.saveAttempt(attemptCandidate({ attemptId, attemptType, stageId: null, context }), { expectedRevision: 0 });
    assert.equal(saved.stageId, null);
  }
  await assert.rejects(repo.saveAttempt(attemptCandidate({ attemptId: "bad-review-stage", attemptType: WritingAttemptType.REVIEW_D1, stageId: WritingStage.W7_INDEPENDENT, context: cases[0][1] }), { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveAttempt(attemptCandidate({ attemptId: "bad-d1", attemptType: WritingAttemptType.REVIEW_D1, stageId: null, context: { reviewTaskId: "task", translationSnapshotId: "snapshot" } }), { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveAttempt(attemptCandidate({ attemptId: "bad-d3", attemptType: WritingAttemptType.REVIEW_D3, stageId: null, context: { reviewTaskId: "task" } }), { expectedRevision: 0 }), WritingDataError);
  await assert.rejects(repo.saveAttempt(attemptCandidate({ attemptId: "bad-d7", attemptType: WritingAttemptType.REVIEW_D7, stageId: null, context: { reviewTaskId: "task", assignedPromptFingerprint: "fp", learningItemIds: "item" } }), { expectedRevision: 0 }), WritingDataError);
});

test("G VerifiedText rejects blank/transcription mismatch and binds fingerprint to Attempt identity", async () => {
  await assert.rejects(createVerifiedText("a1", { text: "  ", source: "typed", sourceTranscriptionId: null, confirmedAt: NOW }), WritingDataError);
  await assert.rejects(createVerifiedText("a1", { text: "words", source: "transcription", sourceTranscriptionId: null, confirmedAt: NOW }), WritingDataError);
  const a1 = await createVerifiedText("a1", { text: "same text", source: "manual_entry", sourceTranscriptionId: null, confirmedAt: NOW });
  const a2 = await createVerifiedText("a2", { text: "same text", source: "manual_entry", sourceTranscriptionId: null, confirmedAt: NOW });
  assert.notEqual(a1.fingerprint, a2.fingerprint);
  const transcribed = await createVerifiedText("a3", { text: "verified", source: "transcription", sourceTranscriptionId: "transcription-1", confirmedAt: NOW });
  assert.equal(transcribed.sourceTranscriptionId, "transcription-1");
  const repo = repository();
  await assert.rejects(repo.saveAttempt(attemptCandidate({
    attemptId: "a3",
    attemptType: WritingAttemptType.INDEPENDENT,
    stageId: WritingStage.W7_INDEPENDENT,
    context: { promptFingerprint: "prompt-fp" },
    status: WritingAttemptStatus.SUBMITTED,
    transcriptionId: "transcription-other",
    verifiedText: transcribed,
    submittedAt: NOW,
  }), { expectedRevision: 0 }), WritingDataError);
  assert.notEqual(transcriptionCandidate().rawTranscript, a1.text);
});

test("I immutable Transcription/AiArtifact/LearningItem are idempotent and conflicting changes reject", async () => {
  const repo = repository();
  const cases = [
    ["createTranscription", transcriptionCandidate(), { rawTranscript: "changed" }],
    ["createAiArtifact", aiArtifactCandidate(), { result: { differences: ["changed"] } }],
    ["createLearningItem", learningItemCandidate(), { cueZh: "不同" }],
  ];
  for (const [method, candidate, change] of cases) {
    const first = await repo[method](candidate);
    assert.equal((await repo[method]({ ...candidate })).fingerprint, first.fingerprint);
    await assert.rejects(repo[method]({ ...candidate, ...change }), WritingConflictError);
  }
  await assert.rejects(repo.createAiArtifact(aiArtifactCandidate({ artifactId: "bad-ai", result: {} })), WritingDataError);
  await assert.rejects(repo.createAiArtifact(aiArtifactCandidate({ artifactId: "failed-ai", status: "failed", error: "timeout" })), WritingDataError);
  await assert.rejects(repo.createTranscription(transcriptionCandidate({ transcriptionId: "failed-transcription", status: "failed" })), WritingDataError);
});

test("I Transcription nullable segments/empty transcript and LearningItem nullable source fields are exact", async () => {
  const repo = repository();
  for (const [transcriptionId, segments] of [["transcription-null-segments", null], ["transcription-empty-segments", []]]) {
    const saved = await repo.createTranscription(transcriptionCandidate({ transcriptionId, rawTranscript: "", segments }));
    assert.equal(saved.rawTranscript, "");
    assert.deepEqual(saved.segments, segments);
    assert.equal(saved.provider, "provider");
    assert.equal(saved.promptVersion, "p1");
  }
  await assert.rejects(repo.createTranscription(transcriptionCandidate({ transcriptionId: "transcription-owner-bad", sourceInkRef: inkRef({ id: "ink-w7", surfaceId: "w7:independent:attempt-w7", ownerRecordId: "other", stageId: WritingStage.W7_INDEPENDENT }) })), WritingDataError);
  const nullableCue = await repo.createLearningItem(learningItemCandidate({ itemId: "item-null-cue", cueZh: null }));
  assert.equal(nullableCue.cueZh, null);
  const attemptSourced = await repo.createLearningItem(learningItemCandidate({ itemId: "item-attempt-source", sourceUnitId: null, sourceAttemptId: "attempt-w7" }));
  assert.equal(attemptSourced.sourceAttemptId, "attempt-w7");
  await assert.rejects(repo.createLearningItem(learningItemCandidate({ itemId: "item-no-source", sourceUnitId: null, sourceAttemptId: null })), WritingDataError);
});

test("I Formal Vision Transcription enforces persisted Attempt lineage and Frozen page segments", async () => {
  const repo = repository();
  const sourceInk = inkRef({ id: "ink-formal-vision", surfaceId: "w7:independent:formal-vision-attempt", ownerRecordId: "formal-vision-attempt", stageId: WritingStage.W7_INDEPENDENT });
  await repo.saveAttempt(attemptCandidate({ attemptId: "formal-vision-attempt", attemptType: WritingAttemptType.INDEPENDENT, stageId: WritingStage.W7_INDEPENDENT, context: { promptFingerprint: "prompt-fp" }, inputMethod: WritingInputMethod.HANDWRITING, typedText: null, inkRef: sourceInk, status: WritingAttemptStatus.RAW_SUBMITTED, rawSubmittedAt: NOW }), { expectedRevision: 0 });
  const formal = { schemaVersion: 1, transcriptionId: "formal-vision-1", sessionId: "session-1", username: ALICE, sourceAttemptId: "formal-vision-attempt", sourceInkRef: sourceInk, sourceInkFingerprint: sourceInk.fingerprint, rawTranscript: "page one\n\npage two", segments: [{ pageId: "page-1", text: "page one", segments: [{ text: "page one", confidence: 0, unsure: false }] }, { pageId: "page-2", text: "page two", segments: [{ text: "page two", confidence: null, unsure: true }] }], provider: "openai-compatible", modelId: "vision-model", promptVersion: "writing-transcription-v1", adapterVersion: "writing-vision-openai-v1", requestMetadata: { taskId: "writing.vision.transcribe.v1", pageOrder: ["page-1", "page-2"], renderVersion: "writing-vision-render-v1", providerKind: "openai-compatible", baseUrlIdentity: "https://vision.example/v1", sourceInkFingerprint: sourceInk.fingerprint, requestContextFingerprint: "context-fingerprint" }, createdAt: NOW };
  const saved = await repo.createTranscription(formal); assert.equal(saved.rawTranscript, formal.rawTranscript); assert.equal((await repo.listTranscriptions()).length, 1);
  await assert.rejects(repo.createTranscription({ ...formal, transcriptionId: "formal-bad-confidence", segments: [{ ...formal.segments[0], segments: [{ text: "x", confidence: 2, unsure: false }] }] }), WritingDataError);
  await assert.rejects(repo.createTranscription({ ...formal, transcriptionId: "formal-bad-unsure", segments: [{ ...formal.segments[0], segments: [{ text: "x", confidence: null }] }] }), WritingDataError);
  await assert.rejects(repo.createTranscription({ ...formal, transcriptionId: "formal-bad-order", requestMetadata: { ...formal.requestMetadata, pageOrder: ["page-2", "page-1"] } }), WritingDataError);
  await assert.rejects(repo.createTranscription({ ...formal, transcriptionId: "formal-missing-attempt", sourceAttemptId: "missing", sourceInkRef: { ...sourceInk, ownerRecordId: "missing" } }), (error) => error.code === "lineage-mismatch");
});

test("I/J ScoreReport reads mandatory persisted Attempt lineage and keeps immutable rescore history", async () => {
  const repo = repository();
  const verifiedText = await createVerifiedText("attempt-score", { text: "A confirmed essay.", source: "typed", sourceTranscriptionId: null, confirmedAt: NOW });
  const sourceAttempt = await repo.saveAttempt(attemptCandidate({
    attemptId: "attempt-score",
    attemptType: WritingAttemptType.INDEPENDENT,
    stageId: WritingStage.W7_INDEPENDENT,
    context: { promptFingerprint: "prompt-fp" },
    status: WritingAttemptStatus.SUBMITTED,
    verifiedText,
    submittedAt: NOW,
  }), { expectedRevision: 0 });
  const first = await repo.createScoreReport(scoreCandidate(sourceAttempt));
  assert.equal(assertScoreReportLineage(first, sourceAttempt), true);
  assert.equal((await repo.createScoreReport(scoreCandidate(sourceAttempt))).fingerprint, first.fingerprint);
  await assert.rejects(repo.createScoreReport(scoreCandidate(sourceAttempt, { finalScore: 8 })), WritingConflictError);
  const rescore = await repo.createScoreReport(scoreCandidate(sourceAttempt, { scoreReportId: "score-2", finalScore: 8 }));
  assert.notEqual(rescore.scoreReportId, first.scoreReportId);
  await assert.rejects(repo.createScoreReport(scoreCandidate(sourceAttempt, { scoreReportId: "bad-score", finalScore: 11 })), WritingDataError);
  await assert.rejects(repo.createScoreReport(scoreCandidate(sourceAttempt, { scoreReportId: "bad-zero", finalScore: 0, band: 0, zeroReason: "because" })), WritingDataError);
  await assert.rejects(repo.createScoreReport(scoreCandidate(sourceAttempt, { scoreReportId: "bad-lineage", sourceTextFingerprint: "wrong" })), WritingDataError);
});

test("J ScoreReport rejects missing/drafting/unverified/wrong-session lineage and enforces rubric/zeroReason", async () => {
  const repo = repository();
  const fakeSource = { attemptId: "missing-attempt", verifiedText: { fingerprint: "missing-fp" } };
  await assert.rejects(repo.createScoreReport(scoreCandidate(fakeSource, { scoreReportId: "score-missing" })), (error) => error instanceof WritingDataError && error.code === "lineage-mismatch");

  const draftVerified = await createVerifiedText("draft-score-attempt", { text: "Draft text", source: "typed", sourceTranscriptionId: null, confirmedAt: NOW });
  const drafting = await repo.saveAttempt(attemptCandidate({ attemptId: "draft-score-attempt", verifiedText: draftVerified }), { expectedRevision: 0 });
  await assert.rejects(repo.createScoreReport(scoreCandidate(drafting, { scoreReportId: "score-drafting" })), WritingDataError);

  await assert.rejects(repo.saveAttempt(attemptCandidate({ attemptId: "submitted-no-verified", status: WritingAttemptStatus.SUBMITTED, submittedAt: NOW }), { expectedRevision: 0 }), WritingDataError);

  const verified = await createVerifiedText("score-contract-attempt", { text: "Verified essay", source: "typed", sourceTranscriptionId: null, confirmedAt: NOW });
  const source = await repo.saveAttempt(attemptCandidate({ attemptId: "score-contract-attempt", attemptType: WritingAttemptType.INDEPENDENT, stageId: WritingStage.W7_INDEPENDENT, context: { promptFingerprint: "prompt" }, status: WritingAttemptStatus.SUBMITTED, submittedAt: NOW, verifiedText: verified }), { expectedRevision: 0 });
  await assert.rejects(repo.createScoreReport(scoreCandidate(source, { scoreReportId: "score-wrong-session", sessionId: "other-session" })), WritingDataError);
  await assert.rejects(repo.createScoreReport(scoreCandidate(source, { scoreReportId: "score-wrong-rubric", rubricVersion: "r1" })), WritingDataError);
  const bScore = await repo.createScoreReport(scoreCandidate(source, { scoreReportId: "score-b", taskType: WritingTaskType.POSTGRAD_EN1_WRITING_B, maxScore: 20, finalScore: 12, rubricVersion: "postgrad-en1-writing-b-v1" }));
  assert.equal(bScore.rubricVersion, "postgrad-en1-writing-b-v1");
  for (const zeroReason of ["blank", "no_effective_english", "fully_off_topic"]) {
    const zero = await repo.createScoreReport(scoreCandidate(source, { scoreReportId: `score-zero-${zeroReason}`, finalScore: 0, band: 0, zeroReason }));
    assert.equal(zero.zeroReason, zeroReason);
  }
  await assert.rejects(repo.createScoreReport(scoreCandidate(source, { scoreReportId: "score-old-zero", finalScore: 0, band: 0, zeroReason: "off_topic" })), WritingDataError);
});

test("K ReviewTask IDs/mode/expectedRevision and completedAttemptId are explicit", async () => {
  const repo = repository();
  const taskId = writingReviewTaskId("session-1", WritingReviewType.D3);
  assert.equal(taskId, "writing-review:v1:session-1:d3");
  const candidate = {
    schemaVersion: 1,
    taskId,
    username: ALICE,
    sourceSessionId: "session-1",
    reviewType: WritingReviewType.D3,
    scheduledDate: "2026-08-31",
    status: WritingReviewStatus.PENDING,
    sourceRefs: { promptFingerprint: "prompt-fp", skeletonRevisionId: null },
    mode: "prompt_only",
    activeAttemptId: null,
    completedAttemptId: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 0,
  };
  const saved = await repo.saveReviewTask(candidate, { expectedRevision: 0 });
  await assert.rejects(repo.saveReviewTask(saved, { expectedRevision: 0 }), WritingStaleRevisionError);
  const completed = await repo.saveReviewTask({ ...saved, status: WritingReviewStatus.COMPLETED, completedAttemptId: "review-attempt", completedAt: NOW + 1, updatedAt: NOW + 1 }, { expectedRevision: 1 });
  await assert.rejects(repo.saveReviewTask({ ...completed, completedAttemptId: "other", updatedAt: NOW + 2 }, { expectedRevision: 2 }), WritingDataError);
  await assert.rejects(repo.saveReviewTask({ ...candidate, taskId: writingReviewTaskId("session-2", WritingReviewType.D3), sourceSessionId: "session-2", mode: null }, { expectedRevision: 0 }), WritingDataError);
});

test("K ReviewTask D1/D3/D7 sourceRefs, calendar dates, completion evidence, and identity are frozen", async () => {
  const repo = repository();
  const d1 = await repo.saveReviewTask(reviewTaskCandidate(WritingReviewType.D1), { expectedRevision: 0 });
  const d3Skeleton = await repo.saveReviewTask(reviewTaskCandidate(WritingReviewType.D3, {
    sourceSessionId: "session-d3-skeleton",
    sourceRefs: { skeletonRevisionId: "skeleton-1", promptFingerprint: "prompt-fp" },
    mode: "skeleton_only",
  }), { expectedRevision: 0 });
  const d7 = await repo.saveReviewTask(reviewTaskCandidate(WritingReviewType.D7), { expectedRevision: 0 });
  assert.equal(d1.mode, null);
  assert.equal(d3Skeleton.mode, "skeleton_only");
  assert.equal(d7.mode, null);

  await assert.rejects(repo.saveReviewTask(reviewTaskCandidate(WritingReviewType.D1, { sourceSessionId: "bad-d1-refs", sourceRefs: { translationSnapshotId: "snapshot" } })), WritingDataError);
  await assert.rejects(repo.saveReviewTask(reviewTaskCandidate(WritingReviewType.D3, { sourceSessionId: "bad-d3-mode", sourceRefs: { skeletonRevisionId: "skeleton", promptFingerprint: "fp" }, mode: "prompt_only" })), WritingDataError);
  await assert.rejects(repo.saveReviewTask(reviewTaskCandidate(WritingReviewType.D3, { sourceSessionId: "bad-d3-missing", sourceRefs: { promptFingerprint: "fp" }, mode: "prompt_only" })), WritingDataError);
  await assert.rejects(repo.saveReviewTask(reviewTaskCandidate(WritingReviewType.D7, { sourceSessionId: "bad-d7-refs", sourceRefs: { learningItemIds: [] } })), WritingDataError);
  for (const scheduledDate of ["tomorrow", "2026-99-99", "2026-02-30"]) {
    await assert.rejects(repo.saveReviewTask(reviewTaskCandidate(WritingReviewType.D1, { sourceSessionId: `bad-date-${scheduledDate}`, scheduledDate })), WritingDataError);
  }
  await assert.rejects(repo.saveReviewTask(reviewTaskCandidate(WritingReviewType.D1, { sourceSessionId: "bad-completion-time", status: WritingReviewStatus.COMPLETED, completedAttemptId: "attempt", completedAt: null })), WritingDataError);
  await assert.rejects(repo.saveReviewTask({ ...d1, scheduledDate: "2026-09-01" }, { expectedRevision: 1 }), WritingDataError);
  await assert.rejects(repo.saveReviewTask({ ...d1, sourceRefs: { ...d1.sourceRefs, learningItemIds: ["item-2"] } }, { expectedRevision: 1 }), WritingDataError);
  await assert.rejects(repo.saveReviewTask({ ...d1, createdAt: NOW - 1 }, { expectedRevision: 1 }), WritingDataError);
  const completed = await repo.saveReviewTask({ ...d1, status: WritingReviewStatus.COMPLETED, completedAttemptId: "attempt-d1", completedAt: NOW + 1, updatedAt: NOW + 1 }, { expectedRevision: 1 });
  await assert.rejects(repo.saveReviewTask({ ...completed, status: WritingReviewStatus.IN_PROGRESS, completedAttemptId: null, completedAt: null }, { expectedRevision: 2 }), WritingDataError);
});

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
    this.afterPut = null;
  }

  createIndex(name) { this.indexes.add(name); }
}

class FakeObjectStore {
  constructor(definition, transaction) {
    this.definition = definition;
    this.transaction = transaction;
    this.indexNames = definition.indexNames;
  }

  createIndex(name) { this.definition.createIndex(name); }

  get(key) {
    return this.transaction.request(() => clone(this.definition.records.get(key)) || null);
  }

  put(value) {
    return this.transaction.request(() => {
      const key = value[this.definition.keyPath];
      this.definition.records.set(key, clone(value));
      this.definition.afterPut?.(this.definition.records, key);
      return key;
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
  constructor() { this.databasesByName = new Map(); }

  seed(name, version) {
    const database = new FakeDatabase(name, version);
    this.databasesByName.set(name, database);
    return database;
  }

  open(name, version) {
    const request = { result: null, error: null, transaction: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        let database = this.databasesByName.get(name) || this.seed(name, 0);
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

function createV4Database() {
  const indexedDb = new FakeIndexedDb();
  const database = indexedDb.seed("wuliao-english", 4);
  const definitions = [
    ["custom-pdfs", "id", ["username", "fingerprint"]],
    ["unknown-words", "id", ["username", "usernameResource"]],
    ["pdf-parse-cache", "cacheKey", ["fingerprint"]],
    ["exam-ink", "id", ["username", "sessionId"]],
  ];
  for (const [name, keyPath, indexes] of definitions) {
    const store = database.createObjectStore(name, { keyPath });
    indexes.forEach((index) => store.createIndex(index));
    const key = `${name}-sentinel`;
    store.records.set(key, { [keyPath]: key, value: `keep-${name}` });
  }
  return indexedDb;
}

test("L IndexedDB v4→v9 is additive; old data survives and new training indexes are exact", async () => {
  const indexedDb = createV4Database();
  const database = await openWuliaoEnglishDatabase(indexedDb);
  assert.equal(database.version, WULIAO_ENGLISH_DB_VERSION);
  assert.equal(WULIAO_ENGLISH_DB_VERSION, 9);
  for (const name of ["custom-pdfs", "unknown-words", "pdf-parse-cache", "exam-ink"]) {
    assert.equal(database.objectStoreNames.contains(name), true);
    assert.equal(database.stores.get(name).records.values().next().value.value, `keep-${name}`);
  }
  const writingStore = database.stores.get(WRITING_INK_STORE);
  assert.equal(database.stores.get("reader-ink").keyPath, "id");
  assert.deepEqual([...database.stores.get("reader-ink").indexes], ["username"]);
  assert.equal(writingStore.keyPath, "id");
  assert.deepEqual([...writingStore.indexes].sort(), ["ownerRecordId", "sessionId", "username"]);
  const privateStore = database.stores.get(DEVICE_PRIVATE_WRITING_SAMPLE_STORE);
  assert.equal(privateStore.keyPath, "id");
  assert.deepEqual([...privateStore.indexes].sort(), ["username", "usernameQuestion"]);
  for (const name of LONG_SENTENCE_STORES) {
    const store = database.stores.get(name);
    assert.equal(store.keyPath, "id");
    const indexes = name === "long-sentence-skills" ? ["username", "usernameDue"]
      : name === "long-sentence-sessions" ? ["username", "usernameCreated", "usernameSession"]
      : name === "long-sentence-ink" ? ["ownerRecordId", "username", "usernameSession"]
        : ["username", "usernameSession"];
    assert.deepEqual([...store.indexes].sort(), indexes);
  }
  for (const name of ["import-files", "import-batches", "import-cache", "writing-materials", "material-answers", "material-explanations", "answer-evaluations", "import-receipts"]) {
    const store = database.stores.get(name);
    assert.equal(store.keyPath, "id");
    assert.deepEqual([...store.indexes].sort(), ["materialId", "username"]);
  }
  database.close();
});

function inkOptions(indexedDb, overrides = {}) {
  return {
    username: ALICE,
    sessionId: "session-1",
    surfaceId: "w7:independent:attempt-w7",
    stageId: WritingStage.W7_INDEPENDENT,
    ownerRecordId: "attempt-w7",
    sourceFingerprint: "source-a",
    strokes: [[{ x: 1, y: 2 }]],
    expectedRevision: 0,
    updatedAt: NOW,
    indexedDb,
    ...overrides,
  };
}

test("M Writing ink deterministic identity, revisions, stale/source guards, deep clone, and refs", async () => {
  const indexedDb = createV4Database();
  const firstInput = inkOptions(indexedDb);
  const first = await saveWritingInkSnapshot(firstInput);
  assert.equal(first.id, writingInkRecordId(firstInput));
  assert.equal(first.revision, 1);
  assert.equal(first.ownerRecordId, "attempt-w7");
  assert.equal(first.fingerprint, await fingerprintWritingInkSnapshot(first));
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  firstInput.strokes[0][0].x = 99;
  assert.equal((await getWritingInkSnapshot(firstInput)).snapshot.strokes[0][0].x, 1);
  await assert.rejects(saveWritingInkSnapshot(inkOptions(indexedDb, { expectedRevision: 0 })), WritingInkStaleRevisionError);
  await assert.rejects(saveWritingInkSnapshot(inkOptions(indexedDb, { expectedRevision: 1, sourceFingerprint: "source-b" })), (error) => error instanceof WritingInkStorageError && error.code === "source-mismatch");
  const second = await saveWritingInkSnapshot(inkOptions(indexedDb, { expectedRevision: 1, strokes: [[{ x: 3, y: 4 }]], updatedAt: NOW + 1 }));
  assert.equal(second.revision, 2);
  assert.deepEqual(writingInkRefFromSnapshot(second), {
    id: second.id,
    surfaceId: second.surfaceId,
    revision: 2,
    fingerprint: second.fingerprint,
    sourceFingerprint: "source-a",
    updatedAt: NOW + 1,
    ownerRecordId: "attempt-w7",
    stageId: WritingStage.W7_INDEPENDENT,
  });
});

test("M Writing ink read distinguishes missing/source-mismatch/damaged/wrong-user", async () => {
  const indexedDb = createV4Database();
  const options = inkOptions(indexedDb);
  assert.deepEqual(await getWritingInkSnapshot(options), { status: "missing", snapshot: null });
  const saved = await saveWritingInkSnapshot(options);
  assert.deepEqual(await getWritingInkSnapshot({ ...options, expectedSourceFingerprint: "other" }), { status: "source-mismatch", snapshot: null, revision: 1 });
  const definition = indexedDb.databasesByName.get("wuliao-english").stores.get(WRITING_INK_STORE);
  definition.records.set(saved.id, { ...saved, fingerprint: "tampered" });
  assert.deepEqual(await getWritingInkSnapshot(options), { status: "damaged", snapshot: null, revision: 1 });
  const wrongUserId = writingInkRecordId(options);
  const wrongUser = { ...saved, username: "bob" };
  wrongUser.fingerprint = await fingerprintWritingInkSnapshot(wrongUser);
  definition.records.set(wrongUserId, wrongUser);
  assert.deepEqual(await getWritingInkSnapshot(options), { status: "damaged", snapshot: null, revision: 1 });
});

test("M Writing ink waits for transaction completion and verifies the persisted record by re-read", async () => {
  const indexedDb = createV4Database();
  await openWuliaoEnglishDatabase(indexedDb);
  const definition = indexedDb.databasesByName.get("wuliao-english").stores.get(WRITING_INK_STORE);
  definition.afterPut = (records, key) => {
    const record = records.get(key);
    records.set(key, { ...record, fingerprint: "tampered-after-put" });
    definition.afterPut = null;
  };
  await assert.rejects(saveWritingInkSnapshot(inkOptions(indexedDb)), (error) => error instanceof WritingInkStorageError && error.code === "post-write-conflict");
});

test("M Writing ink validates every frozen surface identity and rejects stage/owner changes", async () => {
  const indexedDb = createV4Database();
  const surfaces = [
    ["w2:translation:tr1", WritingStage.W2_EN_ZH, "tr1"],
    ["w3:back:a3", WritingStage.W3_BACK_TRANSLATION, "a3"],
    ["w5:skeleton:sk1", WritingStage.W5_SKELETON, "sk1"],
    ["w6:reconstruction:a6", WritingStage.W6_RECONSTRUCTION, "a6"],
    ["w7:independent:a7", WritingStage.W7_INDEPENDENT, "a7"],
    ["w8:revision:a8", WritingStage.W8_SCORE_REWRITE, "a8"],
    ["review:D3:ar3", null, "ar3"],
  ];
  for (const [surfaceId, stageId, ownerRecordId] of surfaces) {
    const saved = await saveWritingInkSnapshot(inkOptions(indexedDb, { surfaceId, stageId, ownerRecordId }));
    assert.equal(saved.ownerRecordId, ownerRecordId);
    assert.equal(saved.stageId, stageId);
  }
  await assert.rejects(saveWritingInkSnapshot(inkOptions(indexedDb, { surfaceId: "w5:skeleton:sk2", stageId: WritingStage.W6_RECONSTRUCTION })), (error) => error.code === "invalid-stage");
  await assert.rejects(saveWritingInkSnapshot(inkOptions(indexedDb, { surfaceId: "review:D1:ar1", stageId: WritingStage.W7_INDEPENDENT, ownerRecordId: "ar1" })), (error) => error.code === "invalid-stage");
  await assert.rejects(saveWritingInkSnapshot(inkOptions(indexedDb, { ownerRecordId: "different-owner" })), (error) => error.code === "owner-mismatch");
  await assert.rejects(saveWritingInkSnapshot(inkOptions(indexedDb, { ownerRecordId: "" })), (error) => error.code === "invalid-input");
});
