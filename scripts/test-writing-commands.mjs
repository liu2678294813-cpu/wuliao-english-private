import test from "node:test";
import assert from "node:assert/strict";

await import("./test-hooks.mjs");

const {
  WritingCommandError,
  WritingCommandService,
} = await import("../src/writing/writingCommands.js");
const {
  WritingRepository,
  createVerifiedText,
  fingerprintWritingRecord,
  writingKeys,
} = await import("../src/writing/writingRepository.js");
const {
  WritingAttemptStatus,
  WritingAttemptType,
  WritingDraftStatus,
  WritingInputMethod,
  WritingReconstructionOutcome,
  WritingSkeletonOutcome,
  WritingStage,
  WritingTaskType,
} = await import("../src/writing/writingModels.js");

const USERNAME = "command-user";
const BASE_TIME = 1_900_000_000_000;

function memoryStore() {
  const values = new Map();
  const physicalKey = (key, username) => `${username}::${key}`;
  return {
    values,
    physicalKey,
    getItem: (key, username) => values.get(physicalKey(key, username)) ?? null,
    setItem: (key, value, username) => values.set(physicalKey(key, username), String(value)),
    listItems: (prefix, username) => [...values.entries()]
      .filter(([key]) => key.startsWith(`${username}::${prefix}`))
      .map(([key, value]) => ({ key: key.slice(`${username}::`.length), value })),
  };
}

async function promptSnapshot() {
  return fingerprintWritingRecord({
    questionId: "command-question",
    sourceType: "official",
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A,
    year: 2026,
    promptText: "Write a notice.",
    directions: "Write about 100 words.",
    promptKind: "notice",
    assets: [],
    maxScore: 10,
    targetWordRange: { min: 90, max: 120 },
  });
}

async function sampleSnapshot() {
  return fingerprintWritingRecord({
    essayId: "command-sample",
    sourceType: "embedded",
    text: "Dear students, join our club.",
    wordCount: 5,
    segments: [
      { unitId: "unit-1", text: "Dear students," },
      { unitId: "unit-2", text: "join our club." },
    ],
    qualityStatus: "passed",
    qualityGateVersion: "v1",
    qualityReportFingerprint: "quality-fingerprint",
    generatorMetadata: { provider: "embedded" },
  });
}

function translationRevision(overrides = {}) {
  return {
    schemaVersion: 1,
    revisionId: "translation-1",
    sessionId: "session-1",
    username: USERNAME,
    revisionNumber: 1,
    status: WritingDraftStatus.DRAFT,
    basedOnRevisionId: null,
    units: [
      { unitId: "unit-1", inputMethod: WritingInputMethod.TYPED, typedText: "亲爱的同学们", inkRef: null },
      { unitId: "unit-2", inputMethod: WritingInputMethod.TYPED, typedText: "加入我们的社团", inkRef: null },
    ],
    createdAt: BASE_TIME + 10,
    updatedAt: BASE_TIME + 10,
    committedAt: null,
    revision: 0,
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    schemaVersion: 1,
    attemptId: "attempt-w3",
    sessionId: "session-1",
    username: USERNAME,
    attemptType: WritingAttemptType.BACK_TRANSLATION,
    stageId: WritingStage.W3_BACK_TRANSLATION,
    status: WritingAttemptStatus.DRAFTING,
    parentAttemptId: null,
    context: { translationSnapshotId: "snapshot-1" },
    inputMethod: WritingInputMethod.TYPED,
    typedText: "Dear students, join our club.",
    inkRef: null,
    transcriptionId: null,
    verifiedText: null,
    timing: null,
    createdAt: BASE_TIME + 20,
    updatedAt: BASE_TIME + 20,
    rawSubmittedAt: null,
    submittedAt: null,
    revision: 0,
    ...overrides,
  };
}

function skeletonRevision(overrides = {}) {
  return {
    schemaVersion: 1,
    revisionId: "skeleton-1",
    sessionId: "session-1",
    username: USERNAME,
    revisionNumber: 1,
    status: WritingDraftStatus.DRAFT,
    basedOnRevisionId: null,
    blocks: [
      { order: 0, kind: "idea", text: "invite students" },
      { order: 1, kind: "logic", text: "purpose → time → contact" },
    ],
    inkRef: null,
    createdAt: BASE_TIME + 30,
    updatedAt: BASE_TIME + 30,
    committedAt: null,
    revision: 0,
    ...overrides,
  };
}

function reconstructionAttempt(overrides = {}) {
  return attempt({
    attemptId: "attempt-w6",
    attemptType: WritingAttemptType.RECONSTRUCTION,
    stageId: WritingStage.W6_RECONSTRUCTION,
    context: { skeletonRevisionId: null },
    typedText: "Dear students, please join our club.",
    createdAt: BASE_TIME + 40,
    updatedAt: BASE_TIME + 40,
    ...overrides,
  });
}

function independentAttempt(overrides = {}) {
  return attempt({
    attemptId: "attempt-w7",
    attemptType: WritingAttemptType.INDEPENDENT,
    stageId: WritingStage.W7_INDEPENDENT,
    context: { promptFingerprint: "replaced-by-command" },
    typedText: "Dear students, our club welcomes you.",
    createdAt: BASE_TIME + 50,
    updatedAt: BASE_TIME + 50,
    ...overrides,
  });
}

function scoreReport(sourceAttempt, overrides = {}) {
  return {
    schemaVersion: 1,
    scoreReportId: "score-1",
    sessionId: sourceAttempt.sessionId,
    username: USERNAME,
    sourceAttemptId: sourceAttempt.attemptId,
    sourceTextFingerprint: sourceAttempt.verifiedText.fingerprint,
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A,
    maxScore: 10,
    finalScore: 8,
    band: 4,
    zeroReason: null,
    rubricVersion: "postgrad-en1-writing-a-v1",
    promptVersion: "p1",
    provider: "fixture",
    modelId: "fixture-model",
    dimensions: { content: 4, language: 4 },
    wordCount: 100,
    lengthIssue: null,
    issues: [],
    strengths: ["clear"],
    revisionAdvice: ["vary syntax"],
    handwritingAssessed: false,
    createdAt: BASE_TIME + 100,
    ...overrides,
  };
}

function fakeInkRef(surfaceId, ownerRecordId, stageId, overrides = {}) {
  return {
    id: `ink:${ownerRecordId}`,
    surfaceId,
    revision: 1,
    fingerprint: `ink-fingerprint:${ownerRecordId}`,
    sourceFingerprint: `source:${ownerRecordId}`,
    updatedAt: BASE_TIME + 5,
    ownerRecordId,
    stageId,
    ...overrides,
  };
}

async function harness() {
  const store = memoryStore();
  const repository = new WritingRepository({
    username: USERNAME,
    getItem: store.getItem,
    setItem: store.setItem,
    listItems: store.listItems,
  });
  let activeUsername = USERNAME;
  let clock = BASE_TIME;
  let armedStep = null;
  let eventFailure = false;
  let flushFailure = false;
  const log = [];
  const events = [];
  const flushes = [];
  const service = new WritingCommandService({
    repository,
    getCurrentUsername: () => activeUsername,
    now: () => { clock += 1; return clock; },
    flushInk: async (context) => {
      log.push("flush-call");
      flushes.push(context);
      if (flushFailure) {
        flushFailure = false;
        throw new Error("injected flush failure");
      }
      return {
        id: `ink:${context.ownerRecordId}`,
        surfaceId: context.surfaceId,
        revision: 1,
        fingerprint: `ink-fingerprint:${context.ownerRecordId}`,
        sourceFingerprint: context.sourceRecord?.fingerprint || `source:${context.ownerRecordId}`,
        updatedAt: clock,
        ownerRecordId: context.ownerRecordId,
        stageId: context.stageId,
      };
    },
    emitLearningInvalidated: async (payload) => {
      log.push("event-call");
      if (eventFailure) {
        eventFailure = false;
        throw new Error("injected event failure");
      }
      events.push(payload);
    },
    onStep: async (step, details) => {
      log.push(`${step}:${details.kind || ""}`);
      if (armedStep && armedStep(step, details)) {
        armedStep = null;
        throw new Error(`injected crash after ${step}`);
      }
    },
  });
  return {
    store,
    repository,
    service,
    log,
    events,
    flushes,
    armStep: (step, predicate = () => true) => { armedStep = (actual, details) => actual === step && predicate(details); },
    failEvent: () => { eventFailure = true; },
    failFlush: () => { flushFailure = true; },
    switchAccount: (username) => { activeUsername = username; },
  };
}

async function startSession(h, sessionId = "session-1") {
  return h.service.startWritingSession({
    sessionId,
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A,
    year: 2026,
    promptSnapshot: await promptSnapshot(),
    sampleEssaySnapshot: await sampleSnapshot(),
    startedAt: BASE_TIME,
  });
}

async function toW2(h) {
  let result = await startSession(h);
  result = await h.service.completeReadingAndEnterW2({ sessionId: "session-1", sessionExpectedRevision: result.session.revision });
  return result;
}

async function toW3(h) {
  let result = await toW2(h);
  result = await h.service.commitTranslationAndEnterW3({
    sessionId: "session-1",
    sessionExpectedRevision: result.session.revision,
    revisionId: "translation-1",
    snapshotId: "snapshot-1",
    translationRevision: translationRevision(),
  });
  return result;
}

async function toW4(h) {
  let result = await toW3(h);
  result = await h.service.submitBackTranslationAndEnterW4({
    sessionId: "session-1",
    sessionExpectedRevision: result.session.revision,
    attemptId: "attempt-w3",
    translationSnapshotId: "snapshot-1",
    attempt: attempt(),
  });
  return result;
}

async function toW5(h) {
  let result = await toW4(h);
  result = await h.service.completeCompareAndEnterW5({ sessionId: "session-1", sessionExpectedRevision: result.session.revision });
  return result;
}

async function directToW7(h) {
  let result = await toW5(h);
  result = await h.service.finishOrSkipSkeleton({
    sessionId: "session-1",
    sessionExpectedRevision: result.session.revision,
    outcome: WritingSkeletonOutcome.SKIPPED,
    nextStage: WritingStage.W7_INDEPENDENT,
  });
  return result;
}

test("START_SESSION and W1 are account-safe and idempotent with frozen first timestamp", async () => {
  const h = await harness();
  const started = await startSession(h);
  const repeatedStart = await startSession(h);
  assert.equal(repeatedStart.session.fingerprint, started.session.fingerprint);
  const w2 = await h.service.completeReadingAndEnterW2({ sessionId: "session-1", sessionExpectedRevision: started.session.revision });
  const completedAt = w2.session.stageFacts.w1ReadingCompletedAt;
  const repeated = await h.service.completeReadingAndEnterW2({ sessionId: "session-1", sessionExpectedRevision: started.session.revision });
  assert.equal(repeated.session.revision, w2.session.revision);
  assert.equal(repeated.session.stageFacts.w1ReadingCompletedAt, completedAt);
  h.switchAccount("other-user");
  await assert.rejects(
    h.service.completeReadingAndEnterW2({ sessionId: "session-1", sessionExpectedRevision: w2.session.revision }),
    (error) => error instanceof WritingCommandError && error.code === "account-mismatch",
  );
});

test("W2 facts-first order is explicit and handwriting flush binds one verified inkRef", async () => {
  const h = await harness();
  const w2 = await toW2(h);
  h.log.length = 0;
  const mixed = translationRevision({
    units: [
      { unitId: "unit-1", inputMethod: WritingInputMethod.MIXED, typedText: "亲爱的同学们", inkRef: null },
      { unitId: "unit-2", inputMethod: WritingInputMethod.HANDWRITING, typedText: "", inkRef: null },
    ],
  });
  const result = await h.service.commitTranslationAndEnterW3({
    sessionId: "session-1",
    sessionExpectedRevision: w2.session.revision,
    revisionId: "translation-1",
    snapshotId: "snapshot-1",
    translationRevision: mixed,
  });
  assert.equal(result.session.currentStage, WritingStage.W3_BACK_TRANSLATION);
  assert.equal(result.translationRevision.units[0].inkRef.fingerprint, result.translationRevision.units[1].inkRef.fingerprint);
  const ordered = h.log.filter((entry) => !entry.startsWith("flush-call") && !entry.startsWith("event-call"));
  assert.deepEqual(ordered, [
    "preflight:",
    "flush:",
    "fact-save:translation-revision",
    "fact-read:translation-revision",
    "fact-save:translation-snapshot",
    "fact-read:translation-snapshot",
    "session-save:",
    "session-read:",
    "safe-stage:",
    "event:",
  ]);
});

test("W2 crash matrix preserves facts and retry converges to one Revision/Snapshot/W3", async (t) => {
  const cases = [
    ["flush failure", async (h) => h.failFlush(), true],
    ["after flush", async (h) => h.armStep("flush"), true],
    ["after Translation commit", async (h) => h.armStep("fact-save", (details) => details.kind === "translation-revision"), false],
    ["after Snapshot create", async (h) => h.armStep("fact-save", (details) => details.kind === "translation-snapshot"), false],
    ["after Session save", async (h) => h.armStep("session-save"), false],
    ["event failure", async (h) => h.failEvent(), false],
  ];
  for (const [name, arm, handwriting] of cases) {
    await t.test(name, async () => {
      const h = await harness();
      const w2 = await toW2(h);
      const revision = handwriting
        ? translationRevision({ units: [
            { unitId: "unit-1", inputMethod: WritingInputMethod.HANDWRITING, typedText: "", inkRef: null },
            { unitId: "unit-2", inputMethod: WritingInputMethod.TYPED, typedText: "加入我们的社团", inkRef: null },
          ] })
        : translationRevision();
      const command = {
        sessionId: "session-1",
        sessionExpectedRevision: w2.session.revision,
        revisionId: "translation-1",
        snapshotId: "snapshot-1",
        translationRevision: revision,
      };
      await arm(h);
      await assert.rejects(h.service.commitTranslationAndEnterW3(command));
      const retried = await h.service.commitTranslationAndEnterW3(command);
      assert.equal(retried.session.currentStage, WritingStage.W3_BACK_TRANSLATION);
      const revisions = (await h.repository.listTranslationRevisions()).filter((row) => !row.damaged);
      const snapshots = (await h.repository.listTranslationSnapshots()).filter((row) => !row.damaged);
      assert.equal(revisions.length, 1);
      assert.equal(snapshots.length, 1);
      const doubled = await h.service.commitTranslationAndEnterW3(command);
      assert.equal(doubled.session.revision, retried.session.revision);
      assert.equal((await h.repository.listTranslationSnapshots()).length, 1);
    });
  }
});

test("W2 dependency write failures leave Session at W2 and are retryable", async () => {
  const h = await harness();
  const w2 = await toW2(h);
  const command = {
    sessionId: "session-1",
    sessionExpectedRevision: w2.session.revision,
    revisionId: "translation-1",
    snapshotId: "snapshot-1",
    translationRevision: translationRevision(),
  };
  const originalCommit = h.repository.saveTranslationRevision.bind(h.repository);
  let failCommit = true;
  h.repository.saveTranslationRevision = async (...args) => {
    if (failCommit) { failCommit = false; throw new Error("commit failure"); }
    return originalCommit(...args);
  };
  await assert.rejects(h.service.commitTranslationAndEnterW3(command));
  assert.equal((await h.repository.readSession("session-1")).currentStage, WritingStage.W2_EN_ZH);
  const originalSnapshot = h.repository.createTranslationSnapshot.bind(h.repository);
  let failSnapshot = true;
  h.repository.createTranslationSnapshot = async (...args) => {
    if (failSnapshot) { failSnapshot = false; throw new Error("snapshot failure"); }
    return originalSnapshot(...args);
  };
  await assert.rejects(h.service.commitTranslationAndEnterW3(command));
  assert.equal((await h.repository.readSession("session-1")).currentStage, WritingStage.W2_EN_ZH);
  const originalSessionSave = h.repository.saveSession.bind(h.repository);
  let failSessionSave = true;
  h.repository.saveSession = async (candidate, options) => {
    if (failSessionSave && candidate.currentStage === WritingStage.W3_BACK_TRANSLATION) {
      failSessionSave = false;
      throw new Error("session save failure");
    }
    return originalSessionSave(candidate, options);
  };
  await assert.rejects(h.service.commitTranslationAndEnterW3(command));
  assert.equal((await h.repository.readSession("session-1")).currentStage, WritingStage.W2_EN_ZH);
  assert.equal((await h.service.commitTranslationAndEnterW3(command)).session.currentStage, WritingStage.W3_BACK_TRANSLATION);
});

test("concurrent W2 double click serializes by Session and creates no duplicate immutable fact", async () => {
  const h = await harness();
  const w2 = await toW2(h);
  const command = {
    sessionId: "session-1",
    sessionExpectedRevision: w2.session.revision,
    revisionId: "translation-1",
    snapshotId: "snapshot-1",
    translationRevision: translationRevision(),
  };
  const [first, second] = await Promise.all([
    h.service.commitTranslationAndEnterW3(command),
    h.service.commitTranslationAndEnterW3(command),
  ]);
  assert.equal(first.session.currentStage, WritingStage.W3_BACK_TRANSLATION);
  assert.equal(second.session.fingerprint, first.session.fingerprint);
  assert.equal((await h.repository.listTranslationRevisions()).length, 1);
  assert.equal((await h.repository.listTranslationSnapshots()).length, 1);
});

test("W3 handwriting requires raw → transcription → verifying → explicit confirmation before W4", async () => {
  const h = await harness();
  const w3 = await toW3(h);
  const prepare = {
    sessionId: "session-1",
    sessionExpectedRevision: w3.session.revision,
    attemptId: "attempt-w3",
    translationSnapshotId: "snapshot-1",
    attempt: attempt({ inputMethod: WritingInputMethod.HANDWRITING, typedText: null }),
  };
  h.failFlush();
  await assert.rejects(h.service.prepareBackTranslationHandwritingForVerification(prepare), (error) => error.code === "ink-flush-failed");
  assert.equal((await h.repository.readSession("session-1")).currentStage, WritingStage.W3_BACK_TRANSLATION);
  const raw = await h.service.prepareBackTranslationHandwritingForVerification(prepare);
  assert.equal(raw.attempt.status, WritingAttemptStatus.RAW_SUBMITTED); assert.equal(raw.attempt.verifiedText, null); assert.equal(raw.session.currentStage, WritingStage.W3_BACK_TRANSLATION);
  const transcription = await h.repository.createTranscription({ schemaVersion: 1, transcriptionId: "transcription-w3", sessionId: "session-1", username: USERNAME, sourceAttemptId: "attempt-w3", sourceInkRef: raw.attempt.inkRef, sourceInkFingerprint: raw.attempt.inkRef.fingerprint, rawTranscript: "AI raw text", segments: null, provider: "fixture", modelId: "vision", promptVersion: "p1", adapterVersion: "a1", requestMetadata: {}, createdAt: BASE_TIME + 90 });
  const attached = await h.service.attachTranscriptionForVerification({ sessionId: "session-1", sessionExpectedRevision: w3.session.revision, attemptId: "attempt-w3", transcriptionId: transcription.transcriptionId });
  assert.equal(attached.attempt.status, WritingAttemptStatus.VERIFYING); assert.equal(attached.attempt.verifiedText, null); assert.equal(attached.session.currentStage, WritingStage.W3_BACK_TRANSLATION);
  const submitted = await h.service.submitBackTranslationHandwritingAndEnterW4({ sessionId: "session-1", sessionExpectedRevision: w3.session.revision, attemptId: "attempt-w3", translationSnapshotId: "snapshot-1", source: "transcription", transcriptionId: transcription.transcriptionId, text: "User corrected text." });
  assert.equal(submitted.session.currentStage, WritingStage.W4_COMPARE_DIAGNOSE); assert.equal(submitted.attempt.verifiedText.text, "User corrected text."); assert.notEqual(submitted.attempt.verifiedText.text, transcription.rawTranscript);
  assert.equal((await h.repository.listAttempts()).filter((row) => row.attemptId === "attempt-w3").length, 1);
});

test("W4 explicit completion is first-timestamp preserving and ignores AI diagnosis state", async () => {
  const h = await harness();
  const w4 = await toW4(h);
  const command = { sessionId: "session-1", sessionExpectedRevision: w4.session.revision };
  const first = await h.service.completeCompareAndEnterW5(command);
  const ended = first.session.stageFacts.w4CompareCompletedAt;
  const second = await h.service.completeCompareAndEnterW5(command);
  assert.equal(second.session.stageFacts.w4CompareCompletedAt, ended);
  assert.equal(second.session.revision, first.session.revision);
});

test("W5 four branches bind exact Skeleton/null and direct W7 creates no W6 Attempt", async (t) => {
  for (const outcome of [WritingSkeletonOutcome.COMPLETED, WritingSkeletonOutcome.SKIPPED]) {
    for (const nextStage of [WritingStage.W6_RECONSTRUCTION, WritingStage.W7_INDEPENDENT]) {
      await t.test(`${outcome} -> ${nextStage}`, async () => {
        const h = await harness();
        const w5 = await toW5(h);
        const command = {
          sessionId: "session-1",
          sessionExpectedRevision: w5.session.revision,
          outcome,
          nextStage,
          ...(outcome === WritingSkeletonOutcome.COMPLETED
            ? { skeletonRevisionId: "skeleton-1", skeletonRevision: skeletonRevision() }
            : {}),
          ...(nextStage === WritingStage.W6_RECONSTRUCTION
            ? { w6AttemptId: "attempt-w6", w6Attempt: reconstructionAttempt() }
            : {}),
        };
        const result = await h.service.finishOrSkipSkeleton(command);
        assert.equal(result.session.currentStage, nextStage);
        assert.equal(result.session.stageFacts.w5Outcome, outcome);
        assert.equal(result.session.stageFacts.committedSkeletonRevisionId, outcome === WritingSkeletonOutcome.COMPLETED ? "skeleton-1" : null);
        const w6 = await h.repository.readAttempt("attempt-w6");
        if (nextStage === WritingStage.W6_RECONSTRUCTION) {
          assert.equal(w6.context.skeletonRevisionId, outcome === WritingSkeletonOutcome.COMPLETED ? "skeleton-1" : null);
          assert.equal(w6.status, WritingAttemptStatus.DRAFTING);
        } else {
          assert.equal(w6, null);
        }
        const repeated = await h.service.finishOrSkipSkeleton(command);
        assert.equal(repeated.session.revision, result.session.revision);
      });
    }
  }
});

test("W5 crash after Skeleton and W6 draft reuses both before Session-last", async () => {
  const h = await harness();
  const w5 = await toW5(h);
  const command = {
    sessionId: "session-1",
    sessionExpectedRevision: w5.session.revision,
    outcome: WritingSkeletonOutcome.COMPLETED,
    nextStage: WritingStage.W6_RECONSTRUCTION,
    skeletonRevisionId: "skeleton-1",
    skeletonRevision: skeletonRevision(),
    w6AttemptId: "attempt-w6",
    w6Attempt: reconstructionAttempt(),
  };
  h.armStep("fact-read", (details) => details.kind === "reconstruction-attempt");
  await assert.rejects(h.service.finishOrSkipSkeleton(command));
  assert.equal((await h.repository.readSession("session-1")).currentStage, WritingStage.W5_SKELETON);
  assert.equal((await h.repository.readSkeletonRevision("skeleton-1")).status, WritingDraftStatus.COMMITTED);
  assert.equal((await h.repository.readAttempt("attempt-w6")).status, WritingAttemptStatus.DRAFTING);
  const retried = await h.service.finishOrSkipSkeleton(command);
  assert.equal(retried.session.currentStage, WritingStage.W6_RECONSTRUCTION);
  assert.equal((await h.repository.listAttempts()).filter((row) => row.attemptId === "attempt-w6").length, 1);
});

test("W6 submit/skip reach W7; skip preserves draft and submitted path freezes exact binding", async (t) => {
  for (const outcome of [WritingReconstructionOutcome.SUBMITTED, WritingReconstructionOutcome.SKIPPED]) {
    await t.test(outcome, async () => {
      const h = await harness();
      const w5 = await toW5(h);
      const w6 = await h.service.finishOrSkipSkeleton({
        sessionId: "session-1",
        sessionExpectedRevision: w5.session.revision,
        outcome: WritingSkeletonOutcome.SKIPPED,
        nextStage: WritingStage.W6_RECONSTRUCTION,
        w6AttemptId: "attempt-w6",
        w6Attempt: reconstructionAttempt(outcome === WritingReconstructionOutcome.SKIPPED ? {
          inputMethod: WritingInputMethod.HANDWRITING,
          typedText: null,
          inkRef: fakeInkRef("w6:reconstruction:attempt-w6", "attempt-w6", WritingStage.W6_RECONSTRUCTION),
        } : {}),
      });
      const draftBefore = await h.repository.readAttempt("attempt-w6");
      const command = {
        sessionId: "session-1",
        sessionExpectedRevision: w6.session.revision,
        outcome,
        ...(outcome === WritingReconstructionOutcome.SUBMITTED
          ? { attemptId: "attempt-w6", attempt: reconstructionAttempt() }
          : {}),
      };
      const result = await h.service.finishOrSkipReconstruction(command);
      assert.equal(result.session.currentStage, WritingStage.W7_INDEPENDENT);
      assert.equal(result.session.stageFacts.w6AttemptId, outcome === WritingReconstructionOutcome.SUBMITTED ? "attempt-w6" : null);
      const persisted = await h.repository.readAttempt("attempt-w6");
      assert.equal(persisted.context.skeletonRevisionId, null);
      assert.equal(persisted.status, outcome === WritingReconstructionOutcome.SUBMITTED ? WritingAttemptStatus.SUBMITTED : draftBefore.status);
      assert.equal(persisted.typedText, draftBefore.typedText);
      assert.deepEqual(persisted.inkRef, draftBefore.inkRef);
      const repeated = await h.service.finishOrSkipReconstruction(command);
      assert.equal(repeated.session.revision, result.session.revision);
    });
  }
});

test("W7 typed creates one confirmed VerifiedText and enters W8 idempotently", async () => {
  const h = await harness();
  const w7 = await directToW7(h);
  const command = {
    sessionId: "session-1",
    sessionExpectedRevision: w7.session.revision,
    attemptId: "attempt-w7",
    attempt: independentAttempt(),
    typedText: "Dear students, our club welcomes you.",
  };
  const first = await h.service.submitIndependentTyped(command);
  assert.equal(first.session.currentStage, WritingStage.W8_SCORE_REWRITE);
  assert.equal(first.attempt.verifiedText.source, "typed");
  const confirmedAt = first.attempt.verifiedText.confirmedAt;
  const repeated = await h.service.submitIndependentTyped(command);
  assert.equal(repeated.attempt.verifiedText.confirmedAt, confirmedAt);
  assert.equal(repeated.attempt.fingerprint, first.attempt.fingerprint);
});

test("W7 handwriting raw/verify split rejects raw transcript, wrong lineage, then accepts manual and future transcription fixtures", async (t) => {
  await t.test("manual fallback", async () => {
    const h = await harness();
    const w7 = await directToW7(h);
    const raw = await h.service.prepareIndependentHandwritingForVerification({
      sessionId: "session-1",
      sessionExpectedRevision: w7.session.revision,
      attemptId: "attempt-w7",
      attempt: independentAttempt({ inputMethod: WritingInputMethod.HANDWRITING, typedText: null }),
    });
    assert.equal(raw.attempt.status, WritingAttemptStatus.RAW_SUBMITTED);
    assert.equal(raw.session.currentStage, WritingStage.W7_INDEPENDENT);
    await assert.rejects(h.service.submitIndependentHandwriting({
      sessionId: "session-1",
      sessionExpectedRevision: w7.session.revision,
      attemptId: "attempt-w7",
      source: "transcription",
      text: "raw transcript only",
      transcriptionId: "missing",
    }), (error) => error.code === "prerequisite-missing");
    const submitted = await h.service.submitIndependentHandwriting({
      sessionId: "session-1",
      sessionExpectedRevision: w7.session.revision,
      attemptId: "attempt-w7",
      source: "manual_entry",
      text: "User confirmed final handwriting text.",
    });
    assert.equal(submitted.session.currentStage, WritingStage.W8_SCORE_REWRITE);
    assert.equal(submitted.attempt.verifiedText.source, "manual_entry");
    assert.deepEqual(submitted.attempt.inkRef, raw.attempt.inkRef);
    const repeated = await h.service.submitIndependentHandwriting({
      sessionId: "session-1",
      sessionExpectedRevision: w7.session.revision,
      attemptId: "attempt-w7",
      source: "manual_entry",
      text: "User confirmed final handwriting text.",
    });
    assert.equal(repeated.attempt.fingerprint, submitted.attempt.fingerprint);
  });

  await t.test("future transcription fixture and invalid lineage", async () => {
    const h = await harness();
    const w7 = await directToW7(h);
    const raw = await h.service.prepareIndependentHandwritingForVerification({
      sessionId: "session-1",
      sessionExpectedRevision: w7.session.revision,
      attemptId: "attempt-w7",
      attempt: independentAttempt({ inputMethod: WritingInputMethod.HANDWRITING, typedText: null }),
    });
    const badAttemptTranscription = {
      schemaVersion: 1,
      transcriptionId: "transcription-wrong-attempt",
      sessionId: "session-1",
      username: USERNAME,
      sourceAttemptId: "another-attempt",
      sourceInkRef: { ...raw.attempt.inkRef, ownerRecordId: "another-attempt" },
      sourceInkFingerprint: raw.attempt.inkRef.fingerprint,
      rawTranscript: "text",
      segments: null,
      provider: "fixture",
      modelId: "vision",
      promptVersion: "p1",
      adapterVersion: "a1",
      requestMetadata: {},
      createdAt: BASE_TIME + 90,
    };
    await h.repository.createTranscription(badAttemptTranscription);
    await assert.rejects(h.service.attachTranscriptionForVerification({
      sessionId: "session-1",
      sessionExpectedRevision: w7.session.revision,
      attemptId: "attempt-w7",
      transcriptionId: "transcription-wrong-attempt",
    }), (error) => error.code === "lineage-mismatch");
    const wrongInk = await h.repository.createTranscription({
      ...badAttemptTranscription,
      transcriptionId: "transcription-wrong-ink",
      sourceAttemptId: "attempt-w7",
      sourceInkRef: { ...raw.attempt.inkRef, fingerprint: "different-ink-fingerprint" },
      sourceInkFingerprint: "different-ink-fingerprint",
    });
    await assert.rejects(h.service.attachTranscriptionForVerification({
      sessionId: "session-1",
      sessionExpectedRevision: w7.session.revision,
      attemptId: "attempt-w7",
      transcriptionId: wrongInk.transcriptionId,
    }), (error) => error.code === "lineage-mismatch");
    const valid = await h.repository.createTranscription({
      ...badAttemptTranscription,
      transcriptionId: "transcription-valid",
      sourceAttemptId: "attempt-w7",
      sourceInkRef: raw.attempt.inkRef,
      sourceInkFingerprint: raw.attempt.inkRef.fingerprint,
    });
    const attached = await h.service.attachTranscriptionForVerification({ sessionId: "session-1", sessionExpectedRevision: w7.session.revision, attemptId: "attempt-w7", transcriptionId: valid.transcriptionId });
    assert.equal(attached.attempt.status, WritingAttemptStatus.VERIFYING); assert.equal(attached.attempt.verifiedText, null); assert.equal(attached.session.currentStage, WritingStage.W7_INDEPENDENT);
    const submitted = await h.service.submitIndependentHandwriting({
      sessionId: "session-1",
      sessionExpectedRevision: w7.session.revision,
      attemptId: "attempt-w7",
      source: "transcription",
      transcriptionId: valid.transcriptionId,
      text: "User confirmed transcription.",
    });
    assert.equal(submitted.attempt.verifiedText.sourceTranscriptionId, valid.transcriptionId);
  });
});

test("W8 revision remains W8; score view completes without revision and rescore freezes first evidence", async () => {
  const h = await harness();
  const w7 = await directToW7(h);
  const w8 = await h.service.submitIndependentTyped({
    sessionId: "session-1",
    sessionExpectedRevision: w7.session.revision,
    attemptId: "attempt-w7",
    attempt: independentAttempt(),
    typedText: "Dear students, our club welcomes you.",
  });
  await assert.rejects(h.service.completeAfterScoreView({
    sessionId: "session-1",
    sessionExpectedRevision: w8.session.revision,
    scoreReportId: "missing-score",
  }), (error) => error.code === "dependent-record-missing");
  assert.equal((await h.repository.readSession("session-1")).currentStage, WritingStage.W8_SCORE_REWRITE);
  const otherSession = await h.service.startWritingSession({
    sessionId: "session-2",
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A,
    year: 2026,
    promptSnapshot: await promptSnapshot(),
    sampleEssaySnapshot: await sampleSnapshot(),
    startedAt: BASE_TIME,
  });
  const otherVerified = await createVerifiedText("attempt-other-session", {
    text: "Other Session essay.", source: "typed", sourceTranscriptionId: null, confirmedAt: BASE_TIME + 99,
  });
  const otherAttempt = await h.repository.saveAttempt(attempt({
    attemptId: "attempt-other-session",
    sessionId: "session-2",
    attemptType: WritingAttemptType.INDEPENDENT,
    stageId: WritingStage.W7_INDEPENDENT,
    context: { promptFingerprint: otherSession.session.promptSnapshot.fingerprint },
    status: WritingAttemptStatus.SUBMITTED,
    verifiedText: otherVerified,
    submittedAt: BASE_TIME + 99,
  }), { expectedRevision: 0 });
  const otherScore = await h.repository.createScoreReport(scoreReport(otherAttempt, {
    scoreReportId: "score-other-session",
    sessionId: "session-2",
  }));
  await assert.rejects(h.service.completeAfterScoreView({
    sessionId: "session-1",
    sessionExpectedRevision: w8.session.revision,
    scoreReportId: otherScore.scoreReportId,
  }), (error) => error.code === "lineage-mismatch");
  const score1 = await h.repository.createScoreReport(scoreReport(w8.attempt));
  const done = await h.service.completeAfterScoreView({
    sessionId: "session-1",
    sessionExpectedRevision: w8.session.revision,
    scoreReportId: score1.scoreReportId,
  });
  assert.equal(done.session.currentStage, WritingStage.DONE);
  assert.equal(done.session.stageFacts.completedByScoreReportId, "score-1");
  const completedAt = done.session.completedAt;
  const score2 = await h.repository.createScoreReport(scoreReport(w8.attempt, { scoreReportId: "score-2", finalScore: 9, createdAt: BASE_TIME + 101 }));
  const rescored = await h.service.completeAfterScoreView({
    sessionId: "session-1",
    sessionExpectedRevision: done.session.revision,
    scoreReportId: score2.scoreReportId,
  });
  assert.deepEqual(rescored.session.stageFacts.viewedScoreReportIds, ["score-1", "score-2"]);
  assert.equal(rescored.session.stageFacts.completedByScoreReportId, "score-1");
  assert.equal(rescored.session.completedAt, completedAt);
  const repeated = await h.service.completeAfterScoreView({
    sessionId: "session-1",
    sessionExpectedRevision: done.session.revision,
    scoreReportId: score1.scoreReportId,
  });
  assert.equal(repeated.session.stageFacts.completedByScoreReportId, "score-1");
});

test("W8 typed revision is a formal submitted fact but never completes Session", async () => {
  const h = await harness();
  const w7 = await directToW7(h);
  const w8 = await h.service.submitIndependentTyped({
    sessionId: "session-1",
    sessionExpectedRevision: w7.session.revision,
    attemptId: "attempt-w7",
    attempt: independentAttempt(),
    typedText: "Dear students, our club welcomes you.",
  });
  const result = await h.service.submitRevisionAttempt({
    sessionId: "session-1",
    sessionExpectedRevision: w8.session.revision,
    attemptId: "attempt-w8-revision",
    parentAttemptId: "attempt-w7",
    typedText: "Dear students, we warmly welcome you to our club.",
  });
  assert.equal(result.session.currentStage, WritingStage.W8_SCORE_REWRITE);
  assert.equal(result.session.status, "ACTIVE");
  assert.equal(result.attempt.attemptType, WritingAttemptType.REVISION);
  assert.equal(result.attempt.status, WritingAttemptStatus.SUBMITTED);
  assert.equal(result.attempt.verifiedText.source, "typed");
  assert.equal(result.attempt.verifiedText.text, "Dear students, we warmly welcome you to our club.");
});

test("Recovery derives safe stages from persisted facts, never UI state or deletion", async (t) => {
  await t.test("REC-CMD-01 Session W3 missing Snapshot -> W2", async () => {
    const h = await harness();
    const w2 = await toW2(h);
    await h.repository.saveSession({ ...w2.session, currentStage: WritingStage.W3_BACK_TRANSLATION, updatedAt: BASE_TIME + 200 }, { expectedRevision: w2.session.revision });
    assert.equal((await h.service.inspectWritingRecovery("session-1")).safeStage, WritingStage.W2_EN_ZH);
  });

  await t.test("REC-CMD-02 Snapshot ahead of Session -> W3 without duplicate", async () => {
    const h = await harness();
    const w2 = await toW2(h);
    const command = { sessionId: "session-1", sessionExpectedRevision: w2.session.revision, revisionId: "translation-1", snapshotId: "snapshot-1", translationRevision: translationRevision() };
    h.armStep("fact-read", (details) => details.kind === "translation-snapshot");
    await assert.rejects(h.service.commitTranslationAndEnterW3(command));
    assert.equal((await h.service.inspectWritingRecovery("session-1")).safeStage, WritingStage.W3_BACK_TRANSLATION);
    await h.service.commitTranslationAndEnterW3(command);
    assert.equal((await h.repository.listTranslationSnapshots()).length, 1);
  });

  await t.test("REC-CMD-03 submitted W3 Attempt ahead -> W4", async () => {
    const h = await harness();
    const w3 = await toW3(h);
    const command = { sessionId: "session-1", sessionExpectedRevision: w3.session.revision, attemptId: "attempt-w3", translationSnapshotId: "snapshot-1", attempt: attempt() };
    h.armStep("fact-read", (details) => details.kind === "back-translation-attempt");
    await assert.rejects(h.service.submitBackTranslationAndEnterW4(command));
    assert.equal((await h.service.inspectWritingRecovery("session-1")).safeStage, WritingStage.W4_COMPARE_DIAGNOSE);
  });

  await t.test("REC-CMD-04/05 direct W7 and unfinished W6 stay on their safe branch", async () => {
    const direct = await harness();
    assert.equal((await directToW7(direct)).safeStage, WritingStage.W7_INDEPENDENT);
    const throughW6 = await harness();
    const w5 = await toW5(throughW6);
    const w6 = await throughW6.service.finishOrSkipSkeleton({
      sessionId: "session-1", sessionExpectedRevision: w5.session.revision,
      outcome: "skipped", nextStage: WritingStage.W6_RECONSTRUCTION,
      w6AttemptId: "attempt-w6", w6Attempt: reconstructionAttempt(),
    });
    assert.equal(w6.safeStage, WritingStage.W6_RECONSTRUCTION);
  });

  await t.test("REC-CMD-06 submitted W6 ahead -> W7", async () => {
    const h = await harness();
    const w5 = await toW5(h);
    const w6 = await h.service.finishOrSkipSkeleton({
      sessionId: "session-1", sessionExpectedRevision: w5.session.revision,
      outcome: "skipped", nextStage: WritingStage.W6_RECONSTRUCTION,
      w6AttemptId: "attempt-w6", w6Attempt: reconstructionAttempt(),
    });
    const command = { sessionId: "session-1", sessionExpectedRevision: w6.session.revision, outcome: "submitted", attemptId: "attempt-w6", attempt: reconstructionAttempt() };
    h.armStep("fact-read", (details) => details.kind === "reconstruction-attempt");
    await assert.rejects(h.service.finishOrSkipReconstruction(command));
    assert.equal((await h.service.inspectWritingRecovery("session-1")).safeStage, WritingStage.W7_INDEPENDENT);
  });

  await t.test("REC-CMD-07 raw W7 stays W7; REC-CMD-08 verified submitted W7 ahead -> W8", async () => {
    const rawHarness = await harness();
    const rawW7 = await directToW7(rawHarness);
    await rawHarness.service.prepareIndependentHandwritingForVerification({
      sessionId: "session-1", sessionExpectedRevision: rawW7.session.revision,
      attemptId: "attempt-w7", attempt: independentAttempt({ inputMethod: "handwriting", typedText: null }),
    });
    assert.equal((await rawHarness.service.inspectWritingRecovery("session-1")).safeStage, WritingStage.W7_INDEPENDENT);

    const typedHarness = await harness();
    const typedW7 = await directToW7(typedHarness);
    const command = { sessionId: "session-1", sessionExpectedRevision: typedW7.session.revision, attemptId: "attempt-w7", attempt: independentAttempt(), typedText: "Dear students, our club welcomes you." };
    typedHarness.armStep("fact-read", (details) => details.kind === "independent-attempt");
    await assert.rejects(typedHarness.service.submitIndependentTyped(command));
    assert.equal((await typedHarness.service.inspectWritingRecovery("session-1")).safeStage, WritingStage.W8_SCORE_REWRITE);
  });

  await t.test("REC-CMD-09/10 ahead Session and damaged fact roll backward with diagnostics and no deletion", async () => {
    const h = await harness();
    const w3 = await toW3(h);
    const rawKey = h.store.physicalKey(writingKeys.translationSnapshot("snapshot-1"), USERNAME);
    const before = h.store.values.get(rawKey);
    const parsed = JSON.parse(before);
    h.store.values.set(rawKey, JSON.stringify({ ...parsed, fingerprint: "damaged" }));
    const recovery = await h.service.inspectWritingRecovery("session-1");
    assert.equal(recovery.safeStage, WritingStage.W2_EN_ZH);
    assert.equal(recovery.diagnostics.some((entry) => entry.code === "dependent-record-damaged"), true);
    assert.equal(h.store.values.has(rawKey), true);
    assert.equal((await h.repository.readSession("session-1")).currentStage, WritingStage.W3_BACK_TRANSLATION);
  });

  await t.test("REC-CMD-11 history remains; REC-CMD-12 account switch rejects", async () => {
    const h = await harness();
    await directToW7(h);
    const countBefore = h.store.values.size;
    await h.service.inspectWritingRecovery("session-1");
    assert.equal(h.store.values.size, countBefore);
    h.switchAccount("switched-user");
    await assert.rejects(h.service.inspectWritingRecovery("session-1"), (error) => error.code === "account-mismatch");
  });
});

test("same identity with changed immutable content conflicts and stale Session is rejected", async () => {
  const h = await harness();
  const w3 = await toW3(h);
  await assert.rejects(h.service.commitTranslationAndEnterW3({
    sessionId: "session-1",
    sessionExpectedRevision: w3.session.revision - 1,
    revisionId: "translation-1",
    snapshotId: "snapshot-1",
    translationRevision: translationRevision({ units: [
      { unitId: "unit-1", inputMethod: "typed", typedText: "冲突", inkRef: null },
      { unitId: "unit-2", inputMethod: "typed", typedText: "加入我们的社团", inkRef: null },
    ] }),
  }), (error) => error.code === "conflict");
  await assert.rejects(h.service.submitBackTranslationAndEnterW4({
    sessionId: "session-1",
    sessionExpectedRevision: w3.session.revision - 1,
    attemptId: "attempt-w3",
    translationSnapshotId: "snapshot-1",
    attempt: attempt(),
  }), (error) => error.code === "stale-session");
});

test("editable W2/W3 drafts autosave behind commands and preserve their exact identities", async () => {
  const h = await harness();
  const w2 = await toW2(h);
  const firstTranslation = await h.service.saveTranslationDraft({
    sessionId: "session-1",
    sessionExpectedRevision: w2.session.revision,
    revisionId: "translation-draft-resume",
    translationRevision: translationRevision({
      revisionId: "translation-draft-resume",
      units: [
        { unitId: "unit-1", inputMethod: WritingInputMethod.TYPED, typedText: "返回前草稿", inkRef: null },
        { unitId: "unit-2", inputMethod: WritingInputMethod.TYPED, typedText: "仍应恢复", inkRef: null },
      ],
    }),
    translationExpectedRevision: 0,
  });
  assert.equal(firstTranslation.translationRevision.revisionId, "translation-draft-resume");
  assert.equal(firstTranslation.translationRevision.units[0].typedText, "返回前草稿");
  assert.equal((await h.repository.readTranslationRevision("translation-draft-resume")).revision, 1);

  const w3 = await toW3(await harness());
  const h3 = await harness();
  const enteredW3 = await toW3(h3);
  const savedAttempt = await h3.service.saveAttemptDraft({
    sessionId: "session-1",
    sessionExpectedRevision: enteredW3.session.revision,
    stageId: WritingStage.W3_BACK_TRANSLATION,
    attemptId: "attempt-resume",
    attempt: attempt({ attemptId: "attempt-resume", typedText: "Back draft before Library" }),
    attemptExpectedRevision: 0,
  });
  assert.equal(w3.safeStage, WritingStage.W3_BACK_TRANSLATION);
  assert.equal(savedAttempt.attempt.attemptId, "attempt-resume");
  assert.equal(savedAttempt.attempt.typedText, "Back draft before Library");
  assert.equal((await h3.repository.readAttempt("attempt-resume")).status, WritingAttemptStatus.DRAFTING);
});
