import { WRITING_SCORE_DIMENSIONS, WRITING_ZERO_REASONS, countWritingWords, isBandFiveScoreConsistent, isWritingScoreInRange, writingLengthIssue, writingRubricFor } from "./writingRubrics.js";

export class WritingAiSchemaError extends Error { constructor(message, code = "invalid_response") { super(message); this.name = "WritingAiSchemaError"; this.code = code; } }

function object(value, name = "response") { if (!value || typeof value !== "object" || Array.isArray(value)) throw new WritingAiSchemaError(`${name} must be a JSON object`); return value; }
function exactKeys(value, keys, name) { const actual = Object.keys(object(value, name)).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new WritingAiSchemaError(`${name} has an invalid shape`); }
function text(value, name, { optional = false } = {}) { const result = typeof value === "string" ? value.trim() : ""; if (!result && !optional) throw new WritingAiSchemaError(`${name} is required`); return result; }
function array(value, name) { if (!Array.isArray(value)) throw new WritingAiSchemaError(`${name} must be an array`); return value; }
function integer(value, name, min, max) { if (!Number.isInteger(value) || value < min || value > max) throw new WritingAiSchemaError(`${name} is invalid`); return value; }
function enumValue(value, name, choices) { if (!choices.includes(value)) throw new WritingAiSchemaError(`${name} is invalid`); return value; }
function uniqueExcerpt(excerpt, source, name) { const value = text(excerpt, name); if (source.indexOf(value) < 0 || source.indexOf(value) !== source.lastIndexOf(value)) throw new WritingAiSchemaError(`${name} must be one exact, unique source substring`); return value; }

export function parseWritingAiJson(raw) {
  const source = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""); const first = source.indexOf("{"); const last = source.lastIndexOf("}");
  if (first < 0 || last < first) throw new WritingAiSchemaError("Response contains no JSON object");
  try { return object(JSON.parse(source.slice(first, last + 1))); } catch { throw new WritingAiSchemaError("Response JSON is invalid"); }
}

export function validateSampleCandidate(value) {
  const item = object(value); exactKeys(item, ["taskType", "promptFingerprint", "essayText", "segments"], "sample candidate");
  const segments = array(item.segments, "segments").map((segment, index) => { exactKeys(segment, ["unitId", "text"], `segments[${index}]`); return { unitId: text(segment.unitId, `segments[${index}].unitId`), text: text(segment.text, `segments[${index}].text`) }; });
  if (!segments.length || new Set(segments.map((item) => item.unitId)).size !== segments.length) throw new WritingAiSchemaError("segments must be non-empty with unique unit ids");
  return { taskType: text(item.taskType, "taskType"), promptFingerprint: text(item.promptFingerprint, "promptFingerprint"), essayText: text(item.essayText, "essayText"), segments };
}

export function validateSampleQualityReport(value, { taskType } = {}) {
  const item = object(value); exactKeys(item, ["pass", "predictedBand", "predictedScoreRange", "fatalIssues", "defects", "checks"], "sample critic"); const rubric = writingRubricFor(taskType);
  if (typeof item.pass !== "boolean") throw new WritingAiSchemaError("sample critic.pass must be boolean");
  exactKeys(item.predictedScoreRange, ["min", "max"], "predictedScoreRange"); const min = integer(item.predictedScoreRange.min, "predictedScoreRange.min", 0, rubric.maxScore); const max = integer(item.predictedScoreRange.max, "predictedScoreRange.max", min, rubric.maxScore);
  exactKeys(item.checks, ["taskFulfillment", "formatRegister", "coherence", "languageAccuracy", "languageRange", "naturalness"], "checks"); const checks = Object.fromEntries(Object.entries(item.checks).map(([key, entry]) => [key, enumValue(entry, `checks.${key}`, ["pass", "fail", "not_applicable"])]));
  const defects = array(item.defects, "defects").map((row, index) => { exactKeys(row, ["code", "severity", "evidence", "repairInstruction"], `defects[${index}]`); return { code: text(row.code, `defects[${index}].code`), severity: enumValue(row.severity, `defects[${index}].severity`, ["fatal", "major", "minor"]), evidence: text(row.evidence, `defects[${index}].evidence`), repairInstruction: text(row.repairInstruction, `defects[${index}].repairInstruction`) }; });
  return { pass: item.pass, predictedBand: integer(item.predictedBand, "predictedBand", 0, 5), predictedScoreRange: { min, max }, fatalIssues: array(item.fatalIssues, "fatalIssues").map((entry, index) => text(entry, `fatalIssues[${index}]`)), defects, checks };
}

export function validateCompareDiagnosis(value, { sampleEssaySnapshot, verifiedText } = {}) {
  const item = object(value); exactKeys(item, ["units"], "compare diagnosis"); const sampleById = new Map((sampleEssaySnapshot?.segments || []).map((unit) => [unit.unitId, unit.text])); const userText = String(verifiedText || ""); const seen = new Set();
  const rows = array(item.units, "units").map((row, index) => {
    exactKeys(row, ["unitId", "meaning", "grammar", "collocation", "naturalness", "register", "learnablePatterns"], `units[${index}]`); const unitId = text(row.unitId, `units[${index}].unitId`); if (!sampleById.has(unitId) || seen.has(unitId)) throw new WritingAiSchemaError("Compare unitId must be a unique sample segment id"); seen.add(unitId);
    exactKeys(row.meaning, ["status", "evidence"], `units[${index}].meaning`); const explain = (name) => array(row[name], `units[${index}].${name}`).map((entry, itemIndex) => { exactKeys(entry, ["excerpt", "explanation", "suggestion"], `${name}[${itemIndex}]`); return { excerpt: text(entry.excerpt, `${name}.excerpt`), explanation: text(entry.explanation, `${name}.explanation`), suggestion: text(entry.suggestion, `${name}.suggestion`) }; });
    const patterns = array(row.learnablePatterns, `units[${index}].learnablePatterns`); if (patterns.length > 5) throw new WritingAiSchemaError("learnablePatterns may contain at most five items");
    return { unitId, meaning: { status: enumValue(row.meaning.status, `units[${index}].meaning.status`, ["preserved", "partial", "distorted"]), evidence: text(row.meaning.evidence, `units[${index}].meaning.evidence`) }, grammar: explain("grammar"), collocation: explain("collocation"), naturalness: explain("naturalness"), register: explain("register"), learnablePatterns: patterns.map((entry, itemIndex) => { exactKeys(entry, ["sampleExcerpt", "userExcerpt", "reason"], `learnablePatterns[${itemIndex}]`); const sampleExcerpt = text(entry.sampleExcerpt, "learnablePatterns.sampleExcerpt"); if (!sampleById.get(unitId).includes(sampleExcerpt)) throw new WritingAiSchemaError("sampleExcerpt must belong to its sample unit"); const userExcerpt = text(entry.userExcerpt, "learnablePatterns.userExcerpt", { optional: true }); if (userExcerpt && !userText.includes(userExcerpt)) throw new WritingAiSchemaError("userExcerpt must be an exact W3 substring"); return { sampleExcerpt, userExcerpt, reason: text(entry.reason, "learnablePatterns.reason") }; }) };
  });
  return { units: rows };
}

export function validateScorePayload(value, { taskType, verifiedText } = {}) {
  const item = object(value); const scoreKeys = Object.keys(item).sort(); const acceptedScoreKeys = ["finalScore", "band", "zeroReason", "dimensions", "issues", "strengths", "revisionAdvice", "wordCount", "lengthIssue"].sort(); if (!["finalScore", "band", "zeroReason", "dimensions", "issues", "strengths", "revisionAdvice"].every((key) => scoreKeys.includes(key)) || scoreKeys.some((key) => !acceptedScoreKeys.includes(key))) throw new WritingAiSchemaError("score response has an invalid shape"); const rubric = writingRubricFor(taskType); const finalScore = item.finalScore; if (typeof finalScore !== "number" || !isWritingScoreInRange(finalScore, rubric)) throw new WritingAiSchemaError("finalScore is out of rubric range"); const band = integer(item.band, "band", 0, 5); if (band === 5 && !isBandFiveScoreConsistent(taskType, finalScore)) throw new WritingAiSchemaError("Band five score is inconsistent with its rubric"); const zeroReason = item.zeroReason === null ? null : enumValue(item.zeroReason, "zeroReason", WRITING_ZERO_REASONS); if ((finalScore === 0) !== (zeroReason !== null)) throw new WritingAiSchemaError("zero-score semantics are invalid");
  exactKeys(item.dimensions, WRITING_SCORE_DIMENSIONS, "dimensions"); const source = String(verifiedText || ""); const dimensions = Object.fromEntries(WRITING_SCORE_DIMENSIONS.map((name) => { const dimension = item.dimensions[name]; exactKeys(dimension, ["rating", "comment", "evidence"], `dimensions.${name}`); return [name, { rating: enumValue(dimension.rating, `dimensions.${name}.rating`, ["excellent", "strong", "adequate", "weak", "critical"]), comment: text(dimension.comment, `dimensions.${name}.comment`), evidence: array(dimension.evidence, `dimensions.${name}.evidence`).map((entry, index) => uniqueExcerpt(entry, source, `dimensions.${name}.evidence[${index}]`)) }]; }));
  const issues = array(item.issues, "issues").map((issue, index) => { exactKeys(issue, ["severity", "category", "excerpt", "explanation", "suggestion"], `issues[${index}]`); return { severity: enumValue(issue.severity, `issues[${index}].severity`, ["major", "minor"]), category: text(issue.category, `issues[${index}].category`), excerpt: uniqueExcerpt(issue.excerpt, source, `issues[${index}].excerpt`), explanation: text(issue.explanation, `issues[${index}].explanation`), suggestion: text(issue.suggestion, `issues[${index}].suggestion`) }; });
  return { finalScore, band, zeroReason, dimensions, issues, strengths: array(item.strengths, "strengths").map((entry, index) => text(entry, `strengths[${index}]`)), revisionAdvice: array(item.revisionAdvice, "revisionAdvice").map((entry, index) => text(entry, `revisionAdvice[${index}]`)), wordCount: countWritingWords(source), lengthIssue: writingLengthIssue(source, rubric) };
}

export function validateReferenceRewrite(value) { const item = object(value); exactKeys(item, ["referenceText", "changeNotes", "rationale"], "reference rewrite"); return { referenceText: text(item.referenceText, "referenceText"), changeNotes: array(item.changeNotes, "changeNotes").map((entry, index) => { exactKeys(entry, ["category", "fromExcerpt", "toExcerpt", "reason"], `changeNotes[${index}]`); return { category: text(entry.category, `changeNotes[${index}].category`), fromExcerpt: text(entry.fromExcerpt, `changeNotes[${index}].fromExcerpt`), toExcerpt: text(entry.toExcerpt, `changeNotes[${index}].toExcerpt`), reason: text(entry.reason, `changeNotes[${index}].reason`) }; }), rationale: array(item.rationale, "rationale").map((entry, index) => text(entry, `rationale[${index}]`)) }; }

export function validateVisionPageTranscript(value, { pageId } = {}) {
  const item = object(value);
  const actualPageId = text(item.pageId, "pageId");
  if (pageId && actualPageId !== pageId) throw new WritingAiSchemaError("Vision pageId does not match request");
  if (typeof item.text !== "string") throw new WritingAiSchemaError("text must be a string");
  const segments = array(item.segments, "segments").map((row, index) => {
    const segment = object(row, `segments[${index}]`);
    if (typeof segment.text !== "string") throw new WritingAiSchemaError(`segments[${index}].text must be a string`);
    const confidence = segment.confidence;
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new WritingAiSchemaError(`segments[${index}].confidence is invalid`);
    }
    if (typeof segment.unsure !== "boolean") throw new WritingAiSchemaError(`segments[${index}].unsure must be boolean`);
    return { text: segment.text, confidence, unsure: segment.unsure };
  });
  return { pageId: actualPageId, text: item.text, segments };
}
