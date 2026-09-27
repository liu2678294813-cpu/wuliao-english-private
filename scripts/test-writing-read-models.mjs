import test from "node:test";
import assert from "node:assert/strict";

await import("./test-hooks.mjs");

const { createWritingReadModelService } = await import("../src/writing/writingReadModels.js");
const { writingKeys } = await import("../src/writing/writingRepository.js");
const {
  WritingAttemptStatus,
  WritingAttemptType,
  WritingStage,
} = await import("../src/writing/writingModels.js");
const {
  ALICE,
  NOW,
  createAttempt,
  createRepository,
  createScore,
  createSession,
  scopedStore,
  setupCompletedSession,
  setupWritingStage,
} = await import("./writing-slice7-fixtures.mjs");

function service(repository, username = () => ALICE) {
  return createWritingReadModelService({ repository, getCurrentUsername: username });
}

test("W1/W2/W5 expose only their stage-appropriate read facts", async () => {
  const w1Repository = createRepository();
  const w1 = await createSession(w1Repository);
  const w1Vm = await service(w1Repository).buildWritingStageViewModel({ sessionId: w1.sessionId });
  assert.equal(w1Vm.stage, WritingStage.W1_SAMPLE_READING);
  assert.equal(w1Vm.sampleEssaySnapshot.text.includes("SAMPLE_SECRET"), true);
  assert.equal("scoreReports" in w1Vm, false);

  const w2Repository = createRepository();
  let w2 = await createSession(w2Repository);
  w2 = await w2Repository.saveSession({
    ...w2,
    currentStage: WritingStage.W2_EN_ZH,
    stageFacts: { ...w2.stageFacts, w1ReadingCompletedAt: NOW + 1 },
    updatedAt: NOW + 1,
    lastActiveAt: NOW + 1,
  }, { expectedRevision: w2.revision });
  const w2Vm = await service(w2Repository).buildWritingStageViewModel({ sessionId: w2.sessionId });
  assert.equal(w2Vm.stage, WritingStage.W2_EN_ZH);
  assert.deepEqual(w2Vm.sampleSegments.map((unit) => unit.unitId), ["u1", "u2"]);
  assert.equal("sampleEssaySnapshot" in w2Vm, false);
  assert.equal("scoreReports" in w2Vm, false);

  const w5Repository = createRepository();
  const w5 = await setupWritingStage(w5Repository, WritingStage.W5_SKELETON);
  const w5Vm = await service(w5Repository).buildWritingStageViewModel({ sessionId: w5.session.sessionId });
  assert.equal(w5Vm.stage, WritingStage.W5_SKELETON);
  assert.equal(w5Vm.currentSkeletonRevision, null);
  assert.equal("translationSnapshot" in w5Vm, false);
  assert.equal("compareDiagnosis" in w5Vm, false);
});

function serialized(value) {
  return JSON.stringify(value);
}

test("W3 hard fence and repository read fence expose only frozen translation plus own input", async () => {
  const repository = createRepository();
  await setupWritingStage(repository, WritingStage.W3_BACK_TRANSLATION);
  const calls = { scores: 0, artifacts: 0, skeletons: 0 };
  for (const [method, key] of [["listScoreReports", "scores"], ["listAiArtifacts", "artifacts"], ["listSkeletonRevisions", "skeletons"]]) {
    const original = repository[method].bind(repository);
    repository[method] = async (...args) => { calls[key] += 1; return original(...args); };
  }
  const workspace = await service(repository).loadWritingWorkspace({ sessionId: "session-1" });
  assert.equal(workspace.safeStage, WritingStage.W3_BACK_TRANSLATION);
  assert.deepEqual(calls, { scores: 0, artifacts: 0, skeletons: 0 });
  assert.deepEqual(Object.keys(workspace.stageViewModel).sort(), [
    "currentBackTranslationAttempt",
    "safeStage",
    "sessionId",
    "stage",
    "stageMetadata",
    "transcriptionDraft",
    "transcriptionVerificationState",
    "translationSnapshot",
  ].sort());
  const text = serialized(workspace.stageViewModel);
  for (const forbidden of ["SAMPLE_SECRET", "Write a notice", "SKELETON_SECRET", "INDEPENDENT_SECRET", "scoreReports", "compareDiagnosis"]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} leaked into W3`);
  }
});

test("pointer ahead rolls back before first render", async () => {
  const repository = createRepository();
  const setup = await setupWritingStage(repository, WritingStage.W3_BACK_TRANSLATION);
  await repository.saveSession({
    ...setup.session,
    currentStage: WritingStage.W7_INDEPENDENT,
    updatedAt: NOW + 20,
    lastActiveAt: NOW + 20,
  }, { expectedRevision: setup.session.revision });
  const workspace = await service(repository).loadWritingWorkspace({ sessionId: setup.session.sessionId });
  assert.equal(workspace.safeStage, WritingStage.W3_BACK_TRANSLATION);
  assert.equal(workspace.stageViewModel.stage, WritingStage.W3_BACK_TRANSLATION);
});

test("facts ahead advance a stale pointer and W4 works without AI diagnosis", async () => {
  const repository = createRepository();
  const setup = await setupWritingStage(repository, WritingStage.W4_COMPARE_DIAGNOSE);
  await repository.saveSession({
    ...setup.session,
    currentStage: WritingStage.W3_BACK_TRANSLATION,
    updatedAt: NOW + 20,
    lastActiveAt: NOW + 20,
  }, { expectedRevision: setup.session.revision });
  const workspace = await service(repository).loadWritingWorkspace({ sessionId: setup.session.sessionId });
  assert.equal(workspace.safeStage, WritingStage.W4_COMPARE_DIAGNOSE);
  assert.equal(workspace.stageViewModel.compareDiagnosis, null);
  assert.ok(workspace.stageViewModel.sampleSegments.length > 0);
});

test("W6 binds and exposes only the exact committed skeleton needed for reconstruction", async () => {
  const repository = createRepository();
  const setup = await setupWritingStage(repository, WritingStage.W6_RECONSTRUCTION, { skeletonMode: "completed" });
  const workspace = await service(repository).loadWritingWorkspace({ sessionId: setup.session.sessionId });
  assert.equal(workspace.safeStage, WritingStage.W6_RECONSTRUCTION);
  assert.equal(workspace.stageViewModel.skeletonRevisionId, setup.skeleton.revisionId);
  assert.match(workspace.stageViewModel.skeletonRevision.blocks[0].text, /^SKELETON_SECRET/);
  const text = serialized(workspace.stageViewModel);
  for (const forbidden of ["SAMPLE_SECRET", "亲爱的同学们", "BACK_SECRET", "Write a notice"]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} leaked into W6`);
  }
});

test("W6 skipped path preserves an explicit null skeleton binding", async () => {
  const repository = createRepository();
  const setup = await setupWritingStage(repository, WritingStage.W6_RECONSTRUCTION, { skeletonMode: "skipped" });
  const vm = await service(repository).buildWritingStageViewModel({ sessionId: setup.session.sessionId });
  assert.equal(vm.skeletonRevisionId, null);
  assert.equal(vm.skeletonRevision, null);
});

test("W7 refresh contains prompt and own input only, with no prior material leakage", async () => {
  const repository = createRepository();
  const setup = await setupWritingStage(repository, WritingStage.W7_INDEPENDENT, { skeletonMode: "completed" });
  await createAttempt(repository, setup.session, {
    attemptId: "attempt-w7-draft",
    attemptType: WritingAttemptType.INDEPENDENT,
    stageId: WritingStage.W7_INDEPENDENT,
    context: { promptFingerprint: setup.session.promptSnapshot.fingerprint },
    status: WritingAttemptStatus.DRAFTING,
    typedText: "W7_OWN_DRAFT",
  });
  const vm = await service(repository).buildWritingStageViewModel({ sessionId: setup.session.sessionId });
  assert.equal(vm.currentIndependentAttempt.typedText, "W7_OWN_DRAFT");
  assert.equal(vm.transcriptionVerificationState, "drafting");
  const text = serialized(vm);
  for (const forbidden of ["SAMPLE_SECRET", "亲爱的同学们", "BACK_SECRET", "SKELETON_SECRET", "compareDiagnosis", "scoreReports", "learningItems"]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} leaked into W7`);
  }
});

test("W8 exposes submitted W7 text and complete valid score history", async () => {
  const repository = createRepository();
  const setup = await setupWritingStage(repository, WritingStage.W7_INDEPENDENT);
  const w7 = await createAttempt(repository, setup.session, {
    attemptId: "attempt-w7",
    attemptType: WritingAttemptType.INDEPENDENT,
    stageId: WritingStage.W7_INDEPENDENT,
    context: { promptFingerprint: setup.session.promptSnapshot.fingerprint },
    status: WritingAttemptStatus.SUBMITTED,
    typedText: "essay one",
    submittedText: "essay one",
  });
  const session = await repository.saveSession({
    ...setup.session,
    currentStage: WritingStage.W8_SCORE_REWRITE,
    updatedAt: NOW + 30,
    lastActiveAt: NOW + 30,
  }, { expectedRevision: setup.session.revision });
  await createScore(repository, session, w7, { scoreReportId: "score-a", finalScore: 6, createdAt: NOW + 31 });
  await createScore(repository, session, w7, { scoreReportId: "score-b", finalScore: 8, createdAt: NOW + 32 });
  await repository.saveAttempt({
    ...w7,
    attemptId: "revision-draft-resume",
    attemptType: WritingAttemptType.REVISION,
    stageId: WritingStage.W8_SCORE_REWRITE,
    status: WritingAttemptStatus.DRAFTING,
    parentAttemptId: w7.attemptId,
    context: { promptFingerprint: session.promptSnapshot.fingerprint },
    typedText: "unfinished second draft",
    verifiedText: null,
    submittedAt: null,
    createdAt: NOW + 33,
    updatedAt: NOW + 33,
    revision: 0,
  }, { expectedRevision: 0 });
  const vm = await service(repository).buildWritingStageViewModel({ sessionId: session.sessionId });
  assert.equal(vm.stage, WritingStage.W8_SCORE_REWRITE);
  assert.equal(vm.submittedIndependentAttempt.verifiedText.text, "essay one");
  assert.deepEqual(vm.scoreReports.map((score) => score.scoreReportId), ["score-a", "score-b"]);
  assert.equal(vm.currentRevisionAttempt.attemptId, "revision-draft-resume");
  assert.equal(vm.currentRevisionAttempt.typedText, "unfinished second draft");
  assert.deepEqual(vm.revisionAttempts, []);
});

test("Archive list is one-pass derived data; completion evidence stays frozen while latest score advances", async () => {
  const repository = createRepository();
  const setup = await setupCompletedSession(repository);
  await createScore(repository, setup.session, setup.w7, { scoreReportId: "score-latest", finalScore: 9, createdAt: NOW + 50 });
  const counts = { sessions: 0, attempts: 0, scores: 0, reviews: 0 };
  for (const [method, key] of [["listSessions", "sessions"], ["listAttempts", "attempts"], ["listScoreReports", "scores"], ["listReviewTasks", "reviews"]]) {
    const original = repository[method].bind(repository);
    repository[method] = async (...args) => { counts[key] += 1; return original(...args); };
  }
  const archive = await service(repository).buildWritingArchiveList();
  assert.deepEqual(counts, { sessions: 1, attempts: 1, scores: 1, reviews: 1 });
  assert.equal(archive.items.length, 1);
  assert.equal(archive.items[0].completionScore.scoreReportId, setup.score.scoreReportId);
  assert.equal(archive.items[0].latestScore.scoreReportId, "score-latest");
  assert.equal("attempts" in archive.items[0], false);
  assert.equal(serialized(archive).includes("strokes"), false);
  const detail = await service(repository).buildWritingArchiveDetail({ sessionId: setup.session.sessionId });
  assert.deepEqual(detail.scoreTrend.map((score) => score.scoreReportId), [setup.score.scoreReportId, "score-latest"]);
  assert.equal(detail.completionScore.scoreReportId, setup.score.scoreReportId);
  assert.equal(detail.latestScore.scoreReportId, "score-latest");
});

test("damaged Session and account mismatch are explicit workspace statuses", async () => {
  const store = scopedStore();
  const repository = createRepository(store);
  const setup = await setupWritingStage(repository, WritingStage.W3_BACK_TRANSLATION);
  store.values.set(store.physical(writingKeys.session(setup.session.sessionId), ALICE), "{broken");
  const damaged = await service(repository).loadWritingWorkspace({ sessionId: setup.session.sessionId });
  assert.equal(damaged.status, "damaged");
  assert.equal(damaged.stageViewModel, null);
  const mismatch = await service(repository, () => "bob").loadWritingWorkspace({ sessionId: setup.session.sessionId });
  assert.equal(mismatch.status, "account_mismatch");
  assert.equal(mismatch.stageViewModel, null);
});

test("missing Session is not silently converted into a fresh W1 workspace", async () => {
  const repository = createRepository();
  const missing = await service(repository).loadWritingWorkspace({ sessionId: "missing-session" });
  assert.equal(missing.status, "not_found");
  assert.equal(missing.safeStage, null);
  assert.equal(missing.stageViewModel, null);
});

test("Writing Library derives active and completed cards through the Read Model only", async () => {
  const repository = createRepository();
  const completed = await setupCompletedSession(repository);
  const active = await createSession(repository, {
    sessionId: "session-active",
    startedAt: NOW + 100,
    lastActiveAt: NOW + 100,
    updatedAt: NOW + 100,
  });
  const library = await service(repository).buildWritingLibrary();
  assert.deepEqual(library.activeItems.map((item) => item.sessionId), [active.sessionId]);
  assert.deepEqual(library.completedItems.map((item) => item.sessionId), [completed.session.sessionId]);
  assert.equal(library.activeItems[0].safeStage, WritingStage.W1_SAMPLE_READING);
  assert.equal(library.completedItems[0].completionScore.scoreReportId, completed.score.scoreReportId);
  assert.equal("sampleEssaySnapshot" in library.activeItems[0], false);
  assert.equal("attempts" in library.completedItems[0], false);
});
