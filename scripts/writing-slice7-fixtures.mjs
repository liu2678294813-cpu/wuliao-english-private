const {
  WritingRepository,
  createVerifiedText,
  fingerprintWritingRecord,
} = await import("../src/writing/writingRepository.js");
const {
  WRITING_SCHEMA_VERSION,
  WritingAttemptStatus,
  WritingAttemptType,
  WritingDraftStatus,
  WritingInputMethod,
  WritingReconstructionOutcome,
  WritingSessionStatus,
  WritingSkeletonOutcome,
  WritingStage,
  WritingTaskType,
} = await import("../src/writing/writingModels.js");

export const ALICE = "alice";
export const NOW = 1_800_000_000_000;

export function scopedStore() {
  const values = new Map();
  const physical = (key, username) => `${username}::${key}`;
  return {
    values,
    getItem: (key, username) => values.get(physical(key, username)) ?? null,
    setItem: (key, value, username) => values.set(physical(key, username), String(value)),
    listItems: (prefix, username) => [...values.entries()]
      .filter(([key]) => key.startsWith(`${username}::${prefix}`))
      .map(([key, value]) => ({ key: key.slice(`${username}::`.length), value })),
    physical,
  };
}

export function createRepository(store = scopedStore(), username = ALICE) {
  return new WritingRepository({
    username,
    getItem: store.getItem,
    setItem: store.setItem,
    listItems: store.listItems,
  });
}

export async function promptSnapshot(overrides = {}) {
  return fingerprintWritingRecord({
    questionId: "question-a",
    sourceType: "official",
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A,
    year: 2025,
    promptText: "Write a notice about the club.",
    directions: "Write about 100 words.",
    promptKind: "notice",
    assets: [],
    maxScore: 10,
    targetWordRange: { min: 90, max: 120 },
    ...overrides,
  });
}

export async function sampleEssaySnapshot(overrides = {}) {
  return fingerprintWritingRecord({
    essayId: "essay-a",
    sourceType: "embedded",
    text: "SAMPLE_SECRET Dear students, welcome to the club.",
    wordCount: 8,
    segments: [
      { unitId: "u1", text: "Dear students," },
      { unitId: "u2", text: "welcome to the club." },
    ],
    qualityStatus: "passed",
    qualityGateVersion: "v1",
    qualityReportFingerprint: "quality-fp",
    generatorMetadata: { provider: "embedded" },
    ...overrides,
  });
}

export function stageFacts(overrides = {}) {
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

export async function createSession(repository, overrides = {}) {
  const sessionId = overrides.sessionId || "session-1";
  const candidate = {
    schemaVersion: WRITING_SCHEMA_VERSION,
    sessionId,
    username: repository.username,
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A,
    year: 2025,
    status: WritingSessionStatus.ACTIVE,
    currentStage: WritingStage.W1_SAMPLE_READING,
    promptSnapshot: await promptSnapshot(),
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
  return repository.saveSession(candidate, { expectedRevision: 0 });
}

export async function createTranslation(repository, session, { revisionId = "translation-1", snapshotId = "snapshot-1" } = {}) {
  const units = [
    { unitId: "u1", inputMethod: WritingInputMethod.TYPED, typedText: "亲爱的同学们", inkRef: null },
    { unitId: "u2", inputMethod: WritingInputMethod.TYPED, typedText: "欢迎加入俱乐部", inkRef: null },
  ];
  const revision = await repository.saveTranslationRevision({
    schemaVersion: WRITING_SCHEMA_VERSION,
    revisionId,
    sessionId: session.sessionId,
    username: session.username,
    revisionNumber: 1,
    status: WritingDraftStatus.COMMITTED,
    basedOnRevisionId: null,
    units,
    createdAt: NOW + 1,
    updatedAt: NOW + 1,
    committedAt: NOW + 1,
    revision: 0,
  }, { expectedRevision: 0 });
  const snapshot = await repository.createTranslationSnapshot({
    schemaVersion: WRITING_SCHEMA_VERSION,
    snapshotId,
    sessionId: session.sessionId,
    username: session.username,
    translationRevisionId: revision.revisionId,
    revisionFingerprint: revision.fingerprint,
    units,
    createdAt: NOW + 2,
  });
  return { revision, snapshot };
}

export async function createAttempt(repository, session, {
  attemptId,
  attemptType,
  stageId,
  context,
  status = WritingAttemptStatus.DRAFTING,
  typedText = "",
  submittedText = null,
  createdAt = NOW + 3,
} = {}) {
  const verifiedText = submittedText === null
    ? null
    : await createVerifiedText(attemptId, {
      text: submittedText,
      source: "typed",
      sourceTranscriptionId: null,
      confirmedAt: createdAt,
    });
  return repository.saveAttempt({
    schemaVersion: WRITING_SCHEMA_VERSION,
    attemptId,
    sessionId: session.sessionId,
    username: session.username,
    attemptType,
    stageId,
    status,
    parentAttemptId: null,
    context,
    inputMethod: WritingInputMethod.TYPED,
    typedText,
    inkRef: null,
    transcriptionId: null,
    verifiedText,
    timing: null,
    createdAt,
    updatedAt: createdAt,
    rawSubmittedAt: null,
    submittedAt: status === WritingAttemptStatus.SUBMITTED ? createdAt : null,
    revision: 0,
  }, { expectedRevision: 0 });
}

export async function createSkeleton(repository, session, revisionId = "skeleton-1") {
  return repository.saveSkeletonRevision({
    schemaVersion: WRITING_SCHEMA_VERSION,
    revisionId,
    sessionId: session.sessionId,
    username: session.username,
    revisionNumber: 1,
    status: WritingDraftStatus.COMMITTED,
    basedOnRevisionId: null,
    blocks: [{ order: 0, kind: "idea", text: "SKELETON_SECRET invite students" }],
    inkRef: null,
    createdAt: NOW + 4,
    updatedAt: NOW + 4,
    committedAt: NOW + 4,
    revision: 0,
  }, { expectedRevision: 0 });
}

export async function createScore(repository, session, attempt, overrides = {}) {
  return repository.createScoreReport({
    schemaVersion: WRITING_SCHEMA_VERSION,
    scoreReportId: overrides.scoreReportId || "score-1",
    sessionId: session.sessionId,
    username: session.username,
    sourceAttemptId: attempt.attemptId,
    sourceTextFingerprint: attempt.verifiedText.fingerprint,
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A,
    maxScore: 10,
    finalScore: overrides.finalScore ?? 7,
    band: overrides.band ?? 3,
    zeroReason: null,
    rubricVersion: "postgrad-en1-writing-a-v1",
    promptVersion: "p1",
    provider: "fixture",
    modelId: "fixture",
    dimensions: { taskFulfillment: { rating: "adequate" } },
    wordCount: 8,
    lengthIssue: null,
    issues: [],
    strengths: [],
    revisionAdvice: [],
    handwritingAssessed: false,
    createdAt: overrides.createdAt || NOW + 7,
  });
}

export async function setupWritingStage(repository, stage, { skeletonMode = "skipped" } = {}) {
  let session = await createSession(repository);
  const translation = await createTranslation(repository, session);
  const w3 = await createAttempt(repository, session, {
    attemptId: "attempt-w3",
    attemptType: WritingAttemptType.BACK_TRANSLATION,
    stageId: WritingStage.W3_BACK_TRANSLATION,
    context: { translationSnapshotId: translation.snapshot.snapshotId },
    status: stage === WritingStage.W3_BACK_TRANSLATION ? WritingAttemptStatus.DRAFTING : WritingAttemptStatus.SUBMITTED,
    typedText: "BACK_SECRET Dear students",
    submittedText: stage === WritingStage.W3_BACK_TRANSLATION ? null : "Dear students",
  });
  let skeleton = null;
  const atLeastW5 = ![WritingStage.W3_BACK_TRANSLATION, WritingStage.W4_COMPARE_DIAGNOSE].includes(stage);
  if (atLeastW5 && skeletonMode === "completed") skeleton = await createSkeleton(repository, session);
  const stageUpdates = {
    [WritingStage.W3_BACK_TRANSLATION]: stageFacts({ w1ReadingCompletedAt: NOW + 1 }),
    [WritingStage.W4_COMPARE_DIAGNOSE]: stageFacts({ w1ReadingCompletedAt: NOW + 1 }),
    [WritingStage.W5_SKELETON]: stageFacts({ w1ReadingCompletedAt: NOW + 1, w4CompareCompletedAt: NOW + 4 }),
    [WritingStage.W6_RECONSTRUCTION]: stageFacts({
      w1ReadingCompletedAt: NOW + 1,
      w4CompareCompletedAt: NOW + 4,
      w5Outcome: skeletonMode,
      w5EndedAt: NOW + 5,
      committedSkeletonRevisionId: skeleton?.revisionId || null,
    }),
    [WritingStage.W7_INDEPENDENT]: stageFacts({
      w1ReadingCompletedAt: NOW + 1,
      w4CompareCompletedAt: NOW + 4,
      w5Outcome: skeletonMode,
      w5EndedAt: NOW + 5,
      committedSkeletonRevisionId: skeleton?.revisionId || null,
      w6Outcome: WritingReconstructionOutcome.SKIPPED,
      w6EndedAt: NOW + 6,
    }),
  };
  session = await repository.saveSession({
    ...session,
    currentStage: stage,
    stageFacts: stageUpdates[stage],
    updatedAt: NOW + 8,
    lastActiveAt: NOW + 8,
  }, { expectedRevision: session.revision });
  return { session, translation, w3, skeleton };
}

export async function setupCompletedSession(repository, { skeletonMode = "skipped" } = {}) {
  const base = await setupWritingStage(repository, WritingStage.W7_INDEPENDENT, { skeletonMode });
  const w7 = await createAttempt(repository, base.session, {
    attemptId: "attempt-w7",
    attemptType: WritingAttemptType.INDEPENDENT,
    stageId: WritingStage.W7_INDEPENDENT,
    context: { promptFingerprint: base.session.promptSnapshot.fingerprint },
    status: WritingAttemptStatus.SUBMITTED,
    typedText: "INDEPENDENT_SECRET My final essay",
    submittedText: "My final essay",
    createdAt: NOW + 8,
  });
  const score = await createScore(repository, base.session, w7);
  const session = await repository.saveSession({
    ...base.session,
    status: WritingSessionStatus.COMPLETED,
    currentStage: WritingStage.DONE,
    stageFacts: {
      ...base.session.stageFacts,
      viewedScoreReportIds: [score.scoreReportId],
      completedByScoreReportId: score.scoreReportId,
    },
    completedAt: new Date(2026, 7, 31, 23, 30).getTime(),
    updatedAt: NOW + 9,
    lastActiveAt: NOW + 9,
  }, { expectedRevision: base.session.revision });
  return { ...base, session, w7, score };
}
