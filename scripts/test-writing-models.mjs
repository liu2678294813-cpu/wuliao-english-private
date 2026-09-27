import test from "node:test";
import assert from "node:assert/strict";

import { buildWritingStageViewModel } from "../src/writing/writingAccessPolicy.js";
import {
  WRITING_STAGES,
  WRITING_STAGE_LABELS,
  WritingInputCapability as Capability,
  WritingReconstructionOutcome as ReconstructionOutcome,
  WritingSkeletonOutcome as SkeletonOutcome,
  WritingStage as Stage,
  assertWritingStage,
  isTerminalWritingReconstructionOutcome,
  isTerminalWritingSkeletonOutcome,
  isWritingStage,
  normalizeWritingFacts,
} from "../src/writing/writingModels.js";

const forbiddenW3 = [
  "sampleEssay",
  "sampleText",
  "sampleSegments",
  "sampleParagraphs",
  "sampleSentences",
  "sampleSkeleton",
  "originalSentenceHints",
  "referenceExpressions",
  "aiWritingHints",
  "aiSummary",
];

const forbiddenW7 = [
  "sampleEssay",
  "sampleText",
  "translation",
  "translationSnapshot",
  "backTranslation",
  "backTranslationAttempt",
  "comparison",
  "comparisonDiagnosis",
  "skeleton",
  "skeletonRevision",
  "reconstruction",
  "reconstructionAttempt",
  "aiSuggestions",
  "referenceExpressions",
  "previousWordingHints",
];

test("canonical Writing stage constants are unique, ordered, and immutable", () => {
  assert.deepEqual(WRITING_STAGES, [
    "W1_SAMPLE_READING",
    "W2_EN_ZH",
    "W3_BACK_TRANSLATION",
    "W4_COMPARE_DIAGNOSE",
    "W5_SKELETON",
    "W6_RECONSTRUCTION",
    "W7_INDEPENDENT",
    "W8_SCORE_REWRITE",
    "DONE",
  ]);
  assert.equal(new Set(WRITING_STAGES).size, 9);
  assert.equal(Object.isFrozen(Stage), true);
  assert.equal(Object.isFrozen(WRITING_STAGES), true);
  assert.equal(Object.isFrozen(Capability), true);
  assert.equal(WRITING_STAGE_LABELS[Stage.W3_BACK_TRANSLATION], "Back Translation");
});

test("W5 and W6 outcomes have distinct frozen Data Contract semantics", () => {
  assert.deepEqual(Object.values(SkeletonOutcome), [null, "completed", "skipped"]);
  assert.equal(isTerminalWritingSkeletonOutcome(SkeletonOutcome.NOT_REACHED), false);
  assert.equal(isTerminalWritingSkeletonOutcome(SkeletonOutcome.COMPLETED), true);
  assert.equal(isTerminalWritingSkeletonOutcome(SkeletonOutcome.SKIPPED), true);
  assert.deepEqual(Object.values(ReconstructionOutcome), [null, "submitted", "skipped"]);
  assert.equal(isTerminalWritingReconstructionOutcome(ReconstructionOutcome.NOT_REACHED), false);
  assert.equal(isTerminalWritingReconstructionOutcome(ReconstructionOutcome.SUBMITTED), true);
  assert.equal(isTerminalWritingReconstructionOutcome(ReconstructionOutcome.SKIPPED), true);
  assert.equal(Object.isFrozen(SkeletonOutcome), true);
  assert.equal(Object.isFrozen(ReconstructionOutcome), true);
});

test("invalid stages are rejected", () => {
  assert.equal(isWritingStage("w9"), false);
  assert.throws(() => assertWritingStage("w9"), RangeError);
  assert.throws(() => buildWritingStageViewModel({ stage: "w9" }), RangeError);
});

test("fact normalization is allow-listed and does not mutate input", () => {
  const input = {
    sampleReadingCompleted: true,
    translationCompleted: true,
    translationSnapshot: { snapshotId: "t-1" },
    skeletonOutcome: "invalid",
    reconstructionOutcome: "invalid",
    secret: "must not survive",
  };
  const before = structuredClone(input);
  const normalized = normalizeWritingFacts(input);
  assert.deepEqual(input, before);
  assert.notEqual(normalized.translationSnapshot, input.translationSnapshot);
  assert.equal(normalized.skeletonOutcome, SkeletonOutcome.NOT_REACHED);
  assert.equal(normalized.reconstructionOutcome, ReconstructionOutcome.NOT_REACHED);
  assert.equal("secret" in normalized, false);
});

test("POLICY-W1-01 W1 exposes passed sample only and fences future guidance", () => {
  const viewModel = buildWritingStageViewModel({
    stage: Stage.W1_SAMPLE_READING,
    session: {
      prompt: "Discuss the topic.",
      sampleEssay: "passed sample",
      sampleSkeleton: ["forbidden"],
      referenceExpressions: ["forbidden"],
      aiSummary: "forbidden",
      currentBackTranslationAttempt: { attemptId: "future" },
      inputCapabilities: {
        unknownWords: true,
        ink: true,
        sampleAccess: true,
        aiWritingHelp: true,
      },
    },
  });
  assert.equal(viewModel.prompt, "Discuss the topic.");
  assert.equal(viewModel.sampleEssay, "passed sample");
  assert.deepEqual(viewModel.inputCapabilities, { unknownWords: true, ink: true });
  for (const key of ["sampleSkeleton", "referenceExpressions", "aiSummary", "currentBackTranslationAttempt"]) {
    assert.equal(key in viewModel, false, `${key} must be absent`);
  }
});

test("POLICY-W3-01 W3 allow-list excludes prompt, sample English, and AI hints", () => {
  const session = {
    prompt: "Discuss the topic.",
    stageMetadata: { stepNumber: 3 },
    inputCapabilities: {
      keyboard: true,
      handwriting: true,
      visionTranscription: true,
      transcriptVerification: true,
      aiWritingHelp: true,
      sampleAccess: true,
      referenceRewrite: true,
      futureBoolean: true,
    },
    currentBackTranslationDraft: "draft",
    currentBackTranslationAttempt: { attemptId: "bt-1" },
    sampleEssay: "forbidden",
    sampleText: "forbidden",
    sampleSegments: ["forbidden"],
    sampleParagraphs: ["forbidden"],
    sampleSentences: ["forbidden"],
    sampleSkeleton: ["forbidden"],
    originalSentenceHints: ["forbidden"],
    referenceExpressions: ["forbidden"],
    aiWritingHints: ["forbidden"],
    aiSummary: "forbidden",
  };
  const viewModel = buildWritingStageViewModel({
    stage: Stage.W3_BACK_TRANSLATION,
    session,
    facts: { translationSnapshot: { snapshotId: "t-1" } },
  });
  assert.deepEqual(Object.keys(viewModel).sort(), [
    "currentBackTranslationAttempt",
    "currentBackTranslationDraft",
    "inputCapabilities",
    "stage",
    "stageMetadata",
    "translationSnapshot",
  ].sort());
  assert.equal("prompt" in viewModel, false);
  assert.deepEqual(viewModel.inputCapabilities, {
    keyboard: true,
    handwriting: true,
    visionTranscription: true,
    transcriptVerification: true,
  });
  for (const key of forbiddenW3) assert.equal(key in viewModel, false, `${key} must be absent`);
});

test("POLICY-W7-01 (SM-08) W7 keeps prompt and fences every previous product", () => {
  const session = Object.fromEntries([
    ...forbiddenW7.map((key) => [key, `forbidden:${key}`]),
    ["prompt", "Write independently."],
    ["stageMetadata", { stepNumber: 7 }],
    ["inputCapabilities", {
      keyboard: true,
      handwriting: true,
      visionTranscription: true,
      transcriptVerification: true,
      aiWritingHelp: true,
      sampleAccess: true,
      referenceRewrite: true,
      futureBoolean: true,
    }],
    ["currentIndependentDraft", "draft"],
    ["currentIndependentAttempt", { attemptId: "ind-1" }],
    ["currentWritingInkRef", { ownerRecordId: "ink-1" }],
  ]);
  const before = structuredClone(session);
  const viewModel = buildWritingStageViewModel({
    stage: Stage.W7_INDEPENDENT,
    session,
    facts: { translationSnapshot: { snapshotId: "must-not-leak" } },
  });
  assert.deepEqual(session, before);
  assert.equal(viewModel.prompt, "Write independently.");
  assert.deepEqual(viewModel.inputCapabilities, {
    keyboard: true,
    handwriting: true,
    visionTranscription: true,
    transcriptVerification: true,
  });
  assert.deepEqual(Object.keys(viewModel).sort(), [
    "currentIndependentAttempt",
    "currentIndependentDraft",
    "currentWritingInkRef",
    "inputCapabilities",
    "prompt",
    "stage",
    "stageMetadata",
  ].sort());
  for (const key of forbiddenW7) assert.equal(key in viewModel, false, `${key} must be absent`);
});

test("POLICY-W6-01 W6 skipped-skeleton path has null revision id, no prompt, and no sample", () => {
  const viewModel = buildWritingStageViewModel({
    stage: Stage.W6_RECONSTRUCTION,
    session: {
      prompt: "Reconstruct.",
      skeleton: ["must not appear after skip"],
      skeletonRevision: { id: "must-not-appear" },
      skeletonRevisionId: "must-not-appear",
      sampleEssay: "forbidden",
      sampleText: "forbidden",
      sampleSkeleton: ["forbidden"],
      currentReconstructionDraft: "draft",
    },
    facts: { skeletonOutcome: SkeletonOutcome.SKIPPED },
  });
  assert.equal(viewModel.skeletonRevisionId, null);
  for (const key of ["prompt", "skeleton", "skeletonRevision", "sampleEssay", "sampleText", "sampleSkeleton"]) {
    assert.equal(key in viewModel, false, `${key} must be absent`);
  }
  assert.equal(viewModel.currentReconstructionDraft, "draft");
});

test("POLICY-W6-02 W6 completed-skeleton path exposes only skeletonRevisionId", () => {
  const viewModel = buildWritingStageViewModel({
    stage: Stage.W6_RECONSTRUCTION,
    session: {
      skeletonRevisionId: "skeleton-revision-1",
      skeleton: { points: ["forbidden full object"] },
      skeletonRevision: { id: "forbidden full object" },
      prompt: "forbidden",
    },
    facts: { skeletonOutcome: SkeletonOutcome.COMPLETED },
  });
  assert.equal(viewModel.skeletonRevisionId, "skeleton-revision-1");
  assert.equal("skeleton" in viewModel, false);
  assert.equal("skeletonRevision" in viewModel, false);
  assert.equal("prompt" in viewModel, false);
});

test("W8 reference rewrite capability remains locked until revision submission", () => {
  const locked = buildWritingStageViewModel({
    stage: Stage.W8_SCORE_REWRITE,
    facts: { revisionAttemptSubmitted: false },
  });
  const unlocked = buildWritingStageViewModel({
    stage: Stage.W8_SCORE_REWRITE,
    facts: { revisionAttemptSubmitted: true },
  });
  assert.equal(locked.fullReferenceRewriteAllowed, false);
  assert.equal(unlocked.fullReferenceRewriteAllowed, true);
});

test("POLICY-W7-02 forbidden W7 fields are absent rather than undefined", () => {
  const viewModel = buildWritingStageViewModel({
    stage: Stage.W7_INDEPENDENT,
    session: Object.fromEntries(forbiddenW7.map((key) => [key, undefined])),
  });
  for (const key of forbiddenW7) {
    assert.equal(key in viewModel, false, `${key} must not exist`);
  }
});

test("POLICY-CAP-01 malicious boolean capabilities do not cross W3/W7 fences", () => {
  const malicious = {
    keyboard: true,
    handwriting: false,
    aiWritingHelp: true,
    sampleAccess: true,
    referenceRewrite: true,
    futureBoolean: true,
  };
  for (const stage of [Stage.W3_BACK_TRANSLATION, Stage.W7_INDEPENDENT]) {
    const viewModel = buildWritingStageViewModel({
      stage,
      session: { inputCapabilities: malicious },
    });
    assert.deepEqual(viewModel.inputCapabilities, { keyboard: true, handwriting: false });
    for (const key of ["aiWritingHelp", "sampleAccess", "referenceRewrite", "futureBoolean"]) {
      assert.equal(key in viewModel.inputCapabilities, false, `${stage}:${key} must be absent`);
    }
  }
});

test("POLICY-CAP-02 only W2/W3/W7 retain Vision and transcript capabilities", () => {
  const inputCapabilities = {
    keyboard: true,
    handwriting: true,
    ink: true,
    visionTranscription: true,
    transcriptVerification: true,
  };
  for (const stage of [Stage.W2_EN_ZH, Stage.W3_BACK_TRANSLATION, Stage.W7_INDEPENDENT]) {
    const viewModel = buildWritingStageViewModel({
      stage,
      session: { inputCapabilities },
    });
    assert.deepEqual(viewModel.inputCapabilities, inputCapabilities);
  }
});

test("POLICY-CAP-03 W5/W6/W8 reject Vision and transcript capabilities", () => {
  const inputCapabilities = {
    keyboard: true,
    handwriting: true,
    ink: true,
    visionTranscription: true,
    transcriptVerification: true,
  };
  for (const stage of [Stage.W5_SKELETON, Stage.W6_RECONSTRUCTION, Stage.W8_SCORE_REWRITE]) {
    const viewModel = buildWritingStageViewModel({
      stage,
      session: { inputCapabilities },
    });
    assert.deepEqual(viewModel.inputCapabilities, {
      keyboard: true,
      handwriting: true,
      ink: true,
    });
    assert.equal("visionTranscription" in viewModel.inputCapabilities, false);
    assert.equal("transcriptVerification" in viewModel.inputCapabilities, false);
  }
});
