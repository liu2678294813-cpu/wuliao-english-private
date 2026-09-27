import test from "node:test";
import assert from "node:assert/strict";

import {
  canEnterWritingStage,
  canSkipReconstruction,
  canSkipSkeleton,
  canTransitionWritingStage,
  evaluateWritingTransition,
  isWritingCompleted,
  nextWritingStage,
  resolveSafeWritingStage,
} from "../src/writing/writingDomain.js";
import {
  WritingReconstructionOutcome as ReconstructionOutcome,
  WritingSkeletonOutcome as SkeletonOutcome,
  WritingStage as Stage,
} from "../src/writing/writingModels.js";

const translationSnapshot = Object.freeze({ snapshotId: "translation-1" });
const scoreReport = Object.freeze({ reportId: "score-1" });

function facts(overrides = {}) {
  return {
    sampleReadingCompleted: false,
    translationCompleted: false,
    translationSnapshot: null,
    backTranslationAttemptSubmitted: false,
    comparisonCompleted: false,
    skeletonOutcome: SkeletonOutcome.NOT_REACHED,
    reconstructionOutcome: ReconstructionOutcome.NOT_REACHED,
    independentAttemptSubmitted: false,
    independentVerifiedTextPresent: false,
    scoreReport: null,
    scoreViewed: false,
    revisionAttemptSubmitted: false,
    ...overrides,
  };
}

const throughComparison = Object.freeze(facts({
  sampleReadingCompleted: true,
  translationCompleted: true,
  translationSnapshot,
  backTranslationAttemptSubmitted: true,
  comparisonCompleted: true,
}));

test("FLOW-01 W1 → W2 is legal after sample reading", () => {
  const state = { currentStage: Stage.W1_SAMPLE_READING, facts: facts({ sampleReadingCompleted: true }) };
  assert.equal(canTransitionWritingStage(state, Stage.W2_EN_ZH), true);
  assert.equal(nextWritingStage(state), Stage.W2_EN_ZH);
});

test("FLOW-02 (SM-01) incomplete W2 cannot enter W3", () => {
  const draftOnly = { currentStage: Stage.W2_EN_ZH, facts: facts({
    sampleReadingCompleted: true,
    translationCompleted: true,
    translationDraft: "mutable draft",
  }) };
  assert.equal(canTransitionWritingStage(draftOnly, Stage.W3_BACK_TRANSLATION), false);
  assert.equal(resolveSafeWritingStage(draftOnly), Stage.W2_EN_ZH);

  const submitted = { currentStage: Stage.W2_EN_ZH, facts: facts({
    sampleReadingCompleted: true,
    translationCompleted: true,
    translationSnapshot,
  }) };
  assert.equal(canTransitionWritingStage(submitted, Stage.W3_BACK_TRANSLATION), true);
});

test("FLOW-03 W3 → W4 requires a submitted Back Translation Attempt", () => {
  const base = facts({
    sampleReadingCompleted: true,
    translationCompleted: true,
    translationSnapshot,
  });
  assert.equal(canTransitionWritingStage(
    { currentStage: Stage.W3_BACK_TRANSLATION, facts: base },
    Stage.W4_COMPARE_DIAGNOSE,
  ), false);
  assert.equal(canTransitionWritingStage(
    { currentStage: Stage.W3_BACK_TRANSLATION, facts: { ...base, backTranslationAttemptSubmitted: true } },
    Stage.W4_COMPARE_DIAGNOSE,
  ), true);
});

test("FLOW-04 W4 AI diagnosis failure is non-blocking", () => {
  const state = {
    currentStage: Stage.W4_COMPARE_DIAGNOSE,
    facts: { ...throughComparison, aiDiagnosis: { status: "failed" } },
  };
  assert.equal(canTransitionWritingStage(state, Stage.W5_SKELETON), true);
  assert.equal(canSkipSkeleton(state), true);
});

for (const skeletonOutcome of [SkeletonOutcome.COMPLETED, SkeletonOutcome.SKIPPED]) {
  test(`FLOW-W5-TO-W6 (SM-05) W5 ${skeletonOutcome} → W6 is allowed`, () => {
    const state = { currentStage: Stage.W5_SKELETON, facts: {
      ...throughComparison,
      skeletonOutcome,
    } };
    assert.equal(canTransitionWritingStage(state, Stage.W6_RECONSTRUCTION), true);
  });

  test(`FLOW-W5-TO-W7 (SM-06) W5 ${skeletonOutcome} → W7 direct is allowed`, () => {
    const state = { currentStage: Stage.W5_SKELETON, facts: {
      ...throughComparison,
      skeletonOutcome,
    } };
    assert.equal(canTransitionWritingStage(state, Stage.W7_INDEPENDENT), true);
    assert.equal(canEnterWritingStage(state, Stage.W7_INDEPENDENT), true);
    assert.equal(nextWritingStage(state, Stage.W7_INDEPENDENT), Stage.W7_INDEPENDENT);
  });
}

test("FLOW-07 W6 submitted with a skeleton → W7", () => {
  const state = { currentStage: Stage.W6_RECONSTRUCTION, facts: {
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.COMPLETED,
    reconstructionOutcome: ReconstructionOutcome.SUBMITTED,
  } };
  assert.equal(canTransitionWritingStage(state, Stage.W7_INDEPENDENT), true);
});

test("FLOW-08 W6 submitted without a skeleton → W7", () => {
  const state = { currentStage: Stage.W6_RECONSTRUCTION, facts: {
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.SUBMITTED,
  } };
  assert.equal(canTransitionWritingStage(state, Stage.W7_INDEPENDENT), true);
});

test("FLOW-09 W6 skipped → W7", () => {
  const state = { currentStage: Stage.W6_RECONSTRUCTION, facts: {
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.COMPLETED,
    reconstructionOutcome: ReconstructionOutcome.SKIPPED,
  } };
  assert.equal(canTransitionWritingStage(state, Stage.W7_INDEPENDENT), true);
});

test("FLOW-10 both W5 outcomes and both W6 outcomes can reach W7 through W6", () => {
  for (const skeletonOutcome of [SkeletonOutcome.COMPLETED, SkeletonOutcome.SKIPPED]) {
    for (const reconstructionOutcome of [ReconstructionOutcome.SUBMITTED, ReconstructionOutcome.SKIPPED]) {
      const state = { currentStage: Stage.W6_RECONSTRUCTION, facts: {
        ...throughComparison,
        skeletonOutcome,
        reconstructionOutcome,
      } };
      assert.equal(resolveSafeWritingStage(state), Stage.W7_INDEPENDENT);
      assert.equal(canTransitionWritingStage(state, Stage.W7_INDEPENDENT), true);
    }
  }
});

test("FLOW-11 (SM-09) W7 → W8 requires submitted Attempt and verifiedText", () => {
  const readyForW7 = facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.SKIPPED,
  });
  assert.equal(canTransitionWritingStage(
    { currentStage: Stage.W7_INDEPENDENT, facts: readyForW7 },
    Stage.W8_SCORE_REWRITE,
  ), false);
  assert.equal(canTransitionWritingStage(
    { currentStage: Stage.W7_INDEPENDENT, facts: {
      ...readyForW7,
      independentAttemptSubmitted: true,
    } },
    Stage.W8_SCORE_REWRITE,
  ), false, "submitted ink/attempt without verifiedText must remain at W7");
  assert.equal(canTransitionWritingStage(
    { currentStage: Stage.W7_INDEPENDENT, facts: {
      ...readyForW7,
      independentAttemptSubmitted: true,
      independentVerifiedTextPresent: true,
    } },
    Stage.W8_SCORE_REWRITE,
  ), true);
});

test("FLOW-12 W8 → DONE requires a valid ScoreReport and scoreViewed", () => {
  const readyForW8 = facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.SKIPPED,
    independentAttemptSubmitted: true,
    independentVerifiedTextPresent: true,
  });
  assert.equal(canTransitionWritingStage(
    { currentStage: Stage.W8_SCORE_REWRITE, facts: { ...readyForW8, scoreReport } },
    Stage.DONE,
  ), false);
  assert.equal(canTransitionWritingStage(
    { currentStage: Stage.W8_SCORE_REWRITE, facts: { ...readyForW8, scoreReport, scoreViewed: true } },
    Stage.DONE,
  ), true);
});

test("FLOW-13 revision attempt is optional for Session completion", () => {
  const completeFacts = facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.SKIPPED,
    independentAttemptSubmitted: true,
    independentVerifiedTextPresent: true,
    scoreReport,
    scoreViewed: true,
    revisionAttemptSubmitted: false,
  });
  assert.equal(isWritingCompleted(completeFacts), true);
});

test("FLOW-14 DONE is terminal", () => {
  const completeFacts = facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.SKIPPED,
    independentAttemptSubmitted: true,
    independentVerifiedTextPresent: true,
    scoreReport,
    scoreViewed: true,
  });
  const state = { currentStage: Stage.DONE, facts: completeFacts };
  for (const requested of [Stage.W1_SAMPLE_READING, Stage.W7_INDEPENDENT, Stage.W8_SCORE_REWRITE]) {
    assert.equal(canTransitionWritingStage(state, requested), false);
  }
});

test("FLOW-15 topology rejects unsupported forward jumps and backwards transitions", () => {
  const w2 = { currentStage: Stage.W2_EN_ZH, facts: facts({ sampleReadingCompleted: true }) };
  assert.equal(canTransitionWritingStage(w2, Stage.W7_INDEPENDENT), false);
  const w4 = { currentStage: Stage.W4_COMPARE_DIAGNOSE, facts: facts({
    sampleReadingCompleted: true,
    translationCompleted: true,
    translationSnapshot,
    backTranslationAttemptSubmitted: true,
  }) };
  assert.equal(canTransitionWritingStage(w4, Stage.W3_BACK_TRANSLATION), false);
});

test("REC-01 missing TranslationSnapshot rolls persisted W3 back to W2", () => {
  const state = { currentStage: Stage.W3_BACK_TRANSLATION, facts: facts({
    sampleReadingCompleted: true,
    translationCompleted: true,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W2_EN_ZH);
});

test("REC-02 submitted Back Translation advances stale W3 to at least W4", () => {
  const state = { currentStage: Stage.W3_BACK_TRANSLATION, facts: facts({
    sampleReadingCompleted: true,
    translationCompleted: true,
    translationSnapshot,
    backTranslationAttemptSubmitted: true,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W4_COMPARE_DIAGNOSE);
});

test("REC-03 (Case D) persisted W7 rolls back when comparison is incomplete", () => {
  const state = { currentStage: Stage.W7_INDEPENDENT, facts: facts({
    sampleReadingCompleted: true,
    translationCompleted: true,
    translationSnapshot,
    backTranslationAttemptSubmitted: true,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.SKIPPED,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W4_COMPARE_DIAGNOSE);
});

test("REC-04 W5 skip survives safe recovery without inventing a branch choice", () => {
  const state = { currentStage: Stage.W5_SKELETON, facts: facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W6_RECONSTRUCTION);
  assert.equal(canSkipReconstruction(state), true);
});

test("REC-05 (Case C) submitted W6 resolves a stale W6 pointer to W7", () => {
  const state = { currentStage: Stage.W6_RECONSTRUCTION, facts: facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.SUBMITTED,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W7_INDEPENDENT);
});

test("REC-06 (Case E) persisted DONE without ScoreReport rolls back to W8", () => {
  const state = { currentStage: Stage.DONE, facts: facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.SKIPPED,
    independentAttemptSubmitted: true,
    independentVerifiedTextPresent: true,
    scoreViewed: true,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W8_SCORE_REWRITE);
});

test("REC-07 (Case A) current W7 with terminal W5 and no W6 outcome recovers to W7", () => {
  const state = { currentStage: Stage.W7_INDEPENDENT, facts: facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.COMPLETED,
    reconstructionOutcome: ReconstructionOutcome.NOT_REACHED,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W7_INDEPENDENT);
});

test("REC-08 (Case B) current W6 with no W6 outcome remains at W6", () => {
  const state = { currentStage: Stage.W6_RECONSTRUCTION, facts: facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.NOT_REACHED,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W6_RECONSTRUCTION);
  assert.equal(canTransitionWritingStage(state, Stage.W7_INDEPENDENT), false);
});

test("REC-09 submitted Attempt without verifiedText recovers to W7, not W8", () => {
  const state = { currentStage: Stage.W8_SCORE_REWRITE, facts: facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
    reconstructionOutcome: ReconstructionOutcome.NOT_REACHED,
    independentAttemptSubmitted: true,
    independentVerifiedTextPresent: false,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W7_INDEPENDENT);
});

test("requestedStage cannot bypass facts and canEnter exposes only the safe frontier", () => {
  const state = { currentStage: Stage.W2_EN_ZH, requestedStage: Stage.W7_INDEPENDENT, facts: facts({
    sampleReadingCompleted: true,
  }) };
  assert.equal(resolveSafeWritingStage(state), Stage.W2_EN_ZH);
  assert.equal(canEnterWritingStage(state, Stage.W7_INDEPENDENT), false);
  assert.equal(canEnterWritingStage(state, Stage.W2_EN_ZH), true);
});

test("transition evaluation is deterministic and does not mutate input", () => {
  const input = { currentStage: Stage.W5_SKELETON, facts: facts({
    ...throughComparison,
    skeletonOutcome: SkeletonOutcome.SKIPPED,
  }) };
  const before = structuredClone(input);
  const first = evaluateWritingTransition(input, Stage.W6_RECONSTRUCTION);
  const second = evaluateWritingTransition(input, Stage.W6_RECONSTRUCTION);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});
