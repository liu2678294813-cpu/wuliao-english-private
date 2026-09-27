import {
  WRITING_STAGES,
  WritingStage,
  WritingReconstructionOutcome,
  WritingSkeletonOutcome,
  isTerminalWritingReconstructionOutcome,
  isTerminalWritingSkeletonOutcome,
  isValidScoreReport,
  isValidTranslationSnapshot,
  isWritingStage,
  normalizeWritingFacts,
} from "./writingModels.js";

function factsFrom(value) {
  return normalizeWritingFacts(value?.facts ?? value);
}

function currentStageFrom(value) {
  return isWritingStage(value?.currentStage)
    ? value.currentStage
    : resolveSafeWritingStage(value);
}

function stageIndex(stage) {
  return WRITING_STAGES.indexOf(stage);
}

const WRITING_TRANSITION_TARGETS = Object.freeze({
  [WritingStage.W1_SAMPLE_READING]: Object.freeze([WritingStage.W2_EN_ZH]),
  [WritingStage.W2_EN_ZH]: Object.freeze([WritingStage.W3_BACK_TRANSLATION]),
  [WritingStage.W3_BACK_TRANSLATION]: Object.freeze([WritingStage.W4_COMPARE_DIAGNOSE]),
  [WritingStage.W4_COMPARE_DIAGNOSE]: Object.freeze([WritingStage.W5_SKELETON]),
  [WritingStage.W5_SKELETON]: Object.freeze([
    WritingStage.W6_RECONSTRUCTION,
    WritingStage.W7_INDEPENDENT,
  ]),
  [WritingStage.W6_RECONSTRUCTION]: Object.freeze([WritingStage.W7_INDEPENDENT]),
  [WritingStage.W7_INDEPENDENT]: Object.freeze([WritingStage.W8_SCORE_REWRITE]),
  [WritingStage.W8_SCORE_REWRITE]: Object.freeze([WritingStage.DONE]),
  [WritingStage.DONE]: Object.freeze([]),
});

function transitionPrerequisiteMet(currentStage, requestedStage, facts) {
  const sampleReadingCompleted = facts.sampleReadingCompleted;
  const translationCompleted = sampleReadingCompleted
    && facts.translationCompleted
    && isValidTranslationSnapshot(facts.translationSnapshot);
  const backTranslationCompleted = translationCompleted && facts.backTranslationAttemptSubmitted;
  const comparisonCompleted = backTranslationCompleted && facts.comparisonCompleted;
  const skeletonTerminal = comparisonCompleted
    && isTerminalWritingSkeletonOutcome(facts.skeletonOutcome);
  const independentWritingSubmitted = skeletonTerminal
    && facts.independentAttemptSubmitted
    && facts.independentVerifiedTextPresent;

  switch (requestedStage) {
    case WritingStage.W2_EN_ZH:
      return sampleReadingCompleted;
    case WritingStage.W3_BACK_TRANSLATION:
      return translationCompleted;
    case WritingStage.W4_COMPARE_DIAGNOSE:
      return backTranslationCompleted;
    case WritingStage.W5_SKELETON:
      return comparisonCompleted;
    case WritingStage.W6_RECONSTRUCTION:
      return skeletonTerminal;
    case WritingStage.W7_INDEPENDENT:
      return skeletonTerminal && (
        currentStage === WritingStage.W5_SKELETON
        || isTerminalWritingReconstructionOutcome(facts.reconstructionOutcome)
      );
    case WritingStage.W8_SCORE_REWRITE:
      return independentWritingSubmitted;
    case WritingStage.DONE:
      return independentWritingSubmitted
        && isValidScoreReport(facts.scoreReport)
        && facts.scoreViewed;
    default:
      return false;
  }
}

export function resolveSafeWritingStage(state = {}) {
  const facts = factsFrom(state);

  if (!facts.sampleReadingCompleted) return WritingStage.W1_SAMPLE_READING;
  if (!facts.translationCompleted || !isValidTranslationSnapshot(facts.translationSnapshot)) {
    return WritingStage.W2_EN_ZH;
  }
  if (!facts.backTranslationAttemptSubmitted) return WritingStage.W3_BACK_TRANSLATION;
  if (!facts.comparisonCompleted) return WritingStage.W4_COMPARE_DIAGNOSE;
  if (!isTerminalWritingSkeletonOutcome(facts.skeletonOutcome)) {
    return WritingStage.W5_SKELETON;
  }

  if (!facts.independentAttemptSubmitted || !facts.independentVerifiedTextPresent) {
    if (isTerminalWritingReconstructionOutcome(facts.reconstructionOutcome)) {
      return WritingStage.W7_INDEPENDENT;
    }
    const persistedStage = isWritingStage(state?.currentStage) ? state.currentStage : null;
    if (
      persistedStage === WritingStage.W7_INDEPENDENT
      || persistedStage === WritingStage.W8_SCORE_REWRITE
      || persistedStage === WritingStage.DONE
    ) {
      return WritingStage.W7_INDEPENDENT;
    }
    return WritingStage.W6_RECONSTRUCTION;
  }
  if (!isValidScoreReport(facts.scoreReport) || !facts.scoreViewed) {
    return WritingStage.W8_SCORE_REWRITE;
  }
  return WritingStage.DONE;
}

export function canEnterWritingStage(state, requestedStage) {
  if (!isWritingStage(requestedStage)) return false;
  return requestedStage === resolveSafeWritingStage(state)
    || canTransitionWritingStage(state, requestedStage);
}

export function nextWritingStage(state = {}, requestedStage = null) {
  if (requestedStage && canTransitionWritingStage(state, requestedStage)) return requestedStage;
  return resolveSafeWritingStage(state);
}

export function isWritingCompleted(state = {}) {
  return resolveSafeWritingStage(state) === WritingStage.DONE;
}

export function canTransitionWritingStage(state, requestedStage) {
  if (!isWritingStage(requestedStage)) return false;
  const currentStage = currentStageFrom(state);
  if (currentStage === WritingStage.DONE) return false;
  if (!WRITING_TRANSITION_TARGETS[currentStage].includes(requestedStage)) return false;
  return transitionPrerequisiteMet(currentStage, requestedStage, factsFrom(state));
}

export function evaluateWritingTransition(state, requestedStage) {
  const currentStage = currentStageFrom(state);
  const resolvedStage = resolveSafeWritingStage(state);
  const allowed = canTransitionWritingStage(state, requestedStage);
  return {
    currentStage,
    requestedStage,
    resolvedStage,
    allowed,
    reason: allowed
      ? "allowed"
      : currentStage === WritingStage.DONE
        ? "completed-terminal"
        : !isWritingStage(requestedStage)
          ? "invalid-stage"
          : !WRITING_TRANSITION_TARGETS[currentStage].includes(requestedStage)
            ? stageIndex(requestedStage) <= stageIndex(currentStage)
              ? "backward-or-idempotent"
              : "transition-not-allowed"
            : "prerequisite-missing",
  };
}

export function canSkipSkeleton(state = {}) {
  const facts = factsFrom(state);
  return resolveSafeWritingStage(facts) === WritingStage.W5_SKELETON
    && facts.comparisonCompleted
    && facts.skeletonOutcome === WritingSkeletonOutcome.NOT_REACHED;
}

export function canSkipReconstruction(state = {}) {
  const facts = factsFrom(state);
  return resolveSafeWritingStage(facts) === WritingStage.W6_RECONSTRUCTION
    && isTerminalWritingSkeletonOutcome(facts.skeletonOutcome)
    && facts.reconstructionOutcome === WritingReconstructionOutcome.NOT_REACHED;
}
