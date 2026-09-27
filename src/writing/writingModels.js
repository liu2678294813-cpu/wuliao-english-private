export const WritingStage = Object.freeze({
  W1_SAMPLE_READING: "W1_SAMPLE_READING",
  W2_EN_ZH: "W2_EN_ZH",
  W3_BACK_TRANSLATION: "W3_BACK_TRANSLATION",
  W4_COMPARE_DIAGNOSE: "W4_COMPARE_DIAGNOSE",
  W5_SKELETON: "W5_SKELETON",
  W6_RECONSTRUCTION: "W6_RECONSTRUCTION",
  W7_INDEPENDENT: "W7_INDEPENDENT",
  W8_SCORE_REWRITE: "W8_SCORE_REWRITE",
  DONE: "DONE",
});

export const WRITING_STAGES = Object.freeze([
  WritingStage.W1_SAMPLE_READING,
  WritingStage.W2_EN_ZH,
  WritingStage.W3_BACK_TRANSLATION,
  WritingStage.W4_COMPARE_DIAGNOSE,
  WritingStage.W5_SKELETON,
  WritingStage.W6_RECONSTRUCTION,
  WritingStage.W7_INDEPENDENT,
  WritingStage.W8_SCORE_REWRITE,
  WritingStage.DONE,
]);

export const WRITING_STAGE_LABELS = Object.freeze({
  [WritingStage.W1_SAMPLE_READING]: "Sample Reading",
  [WritingStage.W2_EN_ZH]: "English → Chinese Translation",
  [WritingStage.W3_BACK_TRANSLATION]: "Back Translation",
  [WritingStage.W4_COMPARE_DIAGNOSE]: "Comparison / Self-check",
  [WritingStage.W5_SKELETON]: "Skeleton",
  [WritingStage.W6_RECONSTRUCTION]: "Reconstruction",
  [WritingStage.W7_INDEPENDENT]: "Independent Essay",
  [WritingStage.W8_SCORE_REWRITE]: "Scoring / Result",
  [WritingStage.DONE]: "Completed",
});

export const WritingSkeletonOutcome = Object.freeze({
  NOT_REACHED: null,
  COMPLETED: "completed",
  SKIPPED: "skipped",
});

export const WritingReconstructionOutcome = Object.freeze({
  NOT_REACHED: null,
  SUBMITTED: "submitted",
  SKIPPED: "skipped",
});

export const WritingInputCapability = Object.freeze({
  KEYBOARD: "keyboard",
  HANDWRITING: "handwriting",
  VISION_TRANSCRIPTION: "visionTranscription",
  TRANSCRIPT_VERIFICATION: "transcriptVerification",
  UNKNOWN_WORDS: "unknownWords",
  INK: "ink",
});

export const WRITING_SCHEMA_VERSION = 1;

export const WritingTaskType = Object.freeze({
  POSTGRAD_EN1_WRITING_A: "postgrad-en1-writing-a",
  POSTGRAD_EN1_WRITING_B: "postgrad-en1-writing-b",
});

export const WritingSessionStatus = Object.freeze({
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
});

export const WritingDraftStatus = Object.freeze({
  DRAFT: "draft",
  COMMITTED: "committed",
});

export const WritingAttemptType = Object.freeze({
  BACK_TRANSLATION: "back_translation",
  RECONSTRUCTION: "reconstruction",
  INDEPENDENT: "independent",
  REVISION: "revision",
  REVIEW_D1: "review_d1",
  REVIEW_D3: "review_d3",
  REVIEW_D7: "review_d7",
});

export const WritingAttemptStatus = Object.freeze({
  DRAFTING: "drafting",
  RAW_SUBMITTED: "raw_submitted",
  VERIFYING: "verifying",
  SUBMITTED: "submitted",
});

export const WritingInputMethod = Object.freeze({
  TYPED: "typed",
  HANDWRITING: "handwriting",
  MIXED: "mixed",
});

export const WritingVerifiedTextSource = Object.freeze({
  TYPED: "typed",
  TRANSCRIPTION: "transcription",
  MANUAL_ENTRY: "manual_entry",
});

export const WritingReviewType = Object.freeze({ D1: "D1", D3: "D3", D7: "D7" });

export const WritingReviewStatus = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  DISMISSED: "dismissed",
});

export const WritingReviewMode = Object.freeze({
  SKELETON_ONLY: "skeleton_only",
  PROMPT_ONLY: "prompt_only",
});

export const WritingAiArtifactType = Object.freeze({
  COMPARE_DIAGNOSIS: "compare_diagnosis",
  REFERENCE_REWRITE: "reference_rewrite",
});

export const WritingLearningItemKind = Object.freeze({
  EXPRESSION: "expression",
  COLLOCATION: "collocation",
  STRUCTURE: "structure",
  TRANSITION: "transition",
  IDEA_PATTERN: "idea_pattern",
});

export const WritingLearningItemOrigin = Object.freeze({
  USER_MARKED: "user_marked",
  AI_SUGGESTED_CONFIRMED: "ai_suggested_confirmed",
});

function isRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptyRecord(value) {
  return isRecord(value) && Object.keys(value).length > 0;
}

export function isWritingStage(value) {
  return WRITING_STAGES.includes(value);
}

export function assertWritingStage(value) {
  if (!isWritingStage(value)) {
    throw new RangeError(`Unknown Writing stage: ${String(value)}`);
  }
  return value;
}

export function isWritingSkeletonOutcome(value) {
  return Object.values(WritingSkeletonOutcome).includes(value);
}

export function isTerminalWritingSkeletonOutcome(value) {
  return value === WritingSkeletonOutcome.COMPLETED
    || value === WritingSkeletonOutcome.SKIPPED;
}

export function normalizeWritingSkeletonOutcome(value) {
  return isWritingSkeletonOutcome(value)
    ? value
    : WritingSkeletonOutcome.NOT_REACHED;
}

export function isWritingReconstructionOutcome(value) {
  return Object.values(WritingReconstructionOutcome).includes(value);
}

export function isTerminalWritingReconstructionOutcome(value) {
  return value === WritingReconstructionOutcome.SUBMITTED
    || value === WritingReconstructionOutcome.SKIPPED;
}

export function normalizeWritingReconstructionOutcome(value) {
  return isWritingReconstructionOutcome(value)
    ? value
    : WritingReconstructionOutcome.NOT_REACHED;
}

export function isValidTranslationSnapshot(value) {
  return isNonEmptyRecord(value);
}

export function isValidScoreReport(value) {
  return isNonEmptyRecord(value);
}

export function normalizeWritingFacts(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    sampleReadingCompleted: source.sampleReadingCompleted === true,
    translationCompleted: source.translationCompleted === true,
    translationSnapshot: isValidTranslationSnapshot(source.translationSnapshot)
      ? { ...source.translationSnapshot }
      : null,
    backTranslationAttemptSubmitted: source.backTranslationAttemptSubmitted === true,
    comparisonCompleted: source.comparisonCompleted === true,
    skeletonOutcome: normalizeWritingSkeletonOutcome(source.skeletonOutcome),
    reconstructionOutcome: normalizeWritingReconstructionOutcome(source.reconstructionOutcome),
    independentAttemptSubmitted: source.independentAttemptSubmitted === true,
    independentVerifiedTextPresent: source.independentVerifiedTextPresent === true,
    scoreReport: isValidScoreReport(source.scoreReport) ? { ...source.scoreReport } : null,
    scoreViewed: source.scoreViewed === true,
    revisionAttemptSubmitted: source.revisionAttemptSubmitted === true,
  };
}

export function normalizeWritingState(value = {}) {
  const source = isRecord(value) ? value : {};
  return {
    currentStage: isWritingStage(source.currentStage)
      ? source.currentStage
      : WritingStage.W1_SAMPLE_READING,
    facts: normalizeWritingFacts(isRecord(source.facts) ? source.facts : source),
  };
}
