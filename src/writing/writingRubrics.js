import { WritingTaskType } from "./writingModels.js";

export const WRITING_RUBRICS = Object.freeze({
  [WritingTaskType.POSTGRAD_EN1_WRITING_A]: Object.freeze({ rubricVersion: "postgrad-en1-writing-a-v1", taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, maxScore: 10, targetWordRange: Object.freeze({ min: 90, max: 110 }) }),
  [WritingTaskType.POSTGRAD_EN1_WRITING_B]: Object.freeze({ rubricVersion: "postgrad-en1-writing-b-v1", taskType: WritingTaskType.POSTGRAD_EN1_WRITING_B, maxScore: 20, targetWordRange: Object.freeze({ min: 160, max: 200 }) }),
});

export const WRITING_SCORE_DIMENSIONS = Object.freeze(["taskFulfillment", "contentCoverage", "organizationCoherence", "languageAccuracy", "languageRange", "formatRegister"]);
export const WRITING_ZERO_REASONS = Object.freeze(["blank", "no_effective_english", "fully_off_topic"]);

export function writingRubricFor(taskType) {
  const rubric = WRITING_RUBRICS[taskType];
  if (!rubric) throw new RangeError(`Unsupported Writing rubric taskType: ${String(taskType)}`);
  return rubric;
}

export function writingRubricForVersion(rubricVersion) {
  return Object.values(WRITING_RUBRICS).find((item) => item.rubricVersion === rubricVersion) || null;
}

export function countWritingWords(text) {
  return (String(text || "").match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g) || []).length;
}

export function writingLengthIssue(text, rubric) {
  const count = countWritingWords(text);
  if (count < rubric.targetWordRange.min) return "too_short";
  if (count > rubric.targetWordRange.max) return "too_long";
  return null;
}

export function isWritingScoreInRange(score, rubric) {
  return Number.isFinite(score) && score >= 0 && score <= rubric.maxScore;
}

// Only band five has an agreed score mapping. Other bands deliberately retain
// no fabricated interval: the model's score remains subject to rubric bounds.
export function isBandFiveScoreConsistent(taskType, score) {
  if (taskType === WritingTaskType.POSTGRAD_EN1_WRITING_A) return score >= 9 && score <= 10;
  if (taskType === WritingTaskType.POSTGRAD_EN1_WRITING_B) return score >= 17 && score <= 20;
  return false;
}
