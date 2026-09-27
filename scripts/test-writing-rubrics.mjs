import test from "node:test";
import assert from "node:assert/strict";
import { WritingTaskType } from "../src/writing/writingModels.js";
import { WRITING_SCORE_DIMENSIONS, countWritingWords, isBandFiveScoreConsistent, writingLengthIssue, writingRubricFor } from "../src/writing/writingRubrics.js";
import { WritingAiSchemaError, validateCompareDiagnosis, validateSampleQualityReport, validateScorePayload } from "../src/writing/writingAiSchemas.js";

const source = "This verified essay has a uniquely quoted sentence and another sentence.";
const dimensions = Object.fromEntries(WRITING_SCORE_DIMENSIONS.map((name) => [name, { rating: "strong", comment: "Evidence supports this judgment.", evidence: ["uniquely quoted sentence"] }]));
const score = () => ({ finalScore: 7, band: 4, zeroReason: null, dimensions, issues: [], strengths: ["Clear purpose."], revisionAdvice: ["Vary sentence structure."] });

test("Writing rubrics own local word count, length issue, and only band-five mapping", () => {
  const a = writingRubricFor(WritingTaskType.POSTGRAD_EN1_WRITING_A); const b = writingRubricFor(WritingTaskType.POSTGRAD_EN1_WRITING_B);
  assert.equal(a.maxScore, 10); assert.equal(b.maxScore, 20); assert.equal(countWritingWords("One well-written essay's sentence."), 4);
  assert.equal(writingLengthIssue("word ".repeat(89), a), "too_short"); assert.equal(writingLengthIssue("word ".repeat(111), a), "too_long"); assert.equal(writingLengthIssue("word ".repeat(100), a), null);
  assert.equal(isBandFiveScoreConsistent(a.taskType, 9), true); assert.equal(isBandFiveScoreConsistent(a.taskType, 8), false); assert.equal(isBandFiveScoreConsistent(b.taskType, 17), true);
});

test("Sample critic enforces the frozen nested schema and enums", () => {
  const valid = { pass: true, predictedBand: 5, predictedScoreRange: { min: 9, max: 10 }, fatalIssues: [], defects: [{ code: "none", severity: "minor", evidence: "none", repairInstruction: "none" }], checks: { taskFulfillment: "pass", formatRegister: "not_applicable", coherence: "pass", languageAccuracy: "pass", languageRange: "pass", naturalness: "pass" } };
  assert.equal(validateSampleQualityReport(valid, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A }).predictedBand, 5);
  assert.throws(() => validateSampleQualityReport({ ...valid, checks: { ...valid.checks, naturalness: "maybe" } }, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A }), WritingAiSchemaError);
  assert.throws(() => validateSampleQualityReport({ ...valid, defects: ["not structured"] }, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A }), WritingAiSchemaError);
});

test("Score rejects invented dimension shapes, invalid evidence, and band-five mismatch", () => {
  const result = validateScorePayload(score(), { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, verifiedText: source });
  assert.equal(result.wordCount, countWritingWords(source)); assert.equal(result.lengthIssue, "too_short");
  assert.throws(() => validateScorePayload({ ...score(), dimensions: { ...dimensions, extra: {} } }, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, verifiedText: source }), WritingAiSchemaError);
  assert.throws(() => validateScorePayload({ ...score(), dimensions: { ...dimensions, languageRange: { ...dimensions.languageRange, evidence: ["missing excerpt"] } } }, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, verifiedText: source }), WritingAiSchemaError);
  assert.throws(() => validateScorePayload({ ...score(), finalScore: 8, band: 5 }, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, verifiedText: source }), WritingAiSchemaError);
});

test("Score evidence and compare patterns retain source-bound excerpts", () => {
  assert.throws(() => validateScorePayload({ ...score(), dimensions: { ...dimensions, taskFulfillment: { ...dimensions.taskFulfillment, evidence: ["sentence"] } } }, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, verifiedText: "sentence sentence" }), WritingAiSchemaError);
  const sample = { segments: [{ unitId: "u1", text: "Welcome to our club." }] };
  const response = { units: [{ unitId: "u1", meaning: { status: "preserved", evidence: "same invitation" }, grammar: [], collocation: [], naturalness: [], register: [], learnablePatterns: [{ sampleExcerpt: "our club", userExcerpt: "club", reason: "keeps the target phrase" }] }] };
  assert.equal(validateCompareDiagnosis(response, { sampleEssaySnapshot: sample, verifiedText: "Welcome club members." }).units.length, 1);
  assert.throws(() => validateCompareDiagnosis({ units: [{ ...response.units[0], learnablePatterns: [{ sampleExcerpt: "not there", userExcerpt: "club", reason: "bad" }] }] }, { sampleEssaySnapshot: sample, verifiedText: "Welcome club members." }), WritingAiSchemaError);
});
