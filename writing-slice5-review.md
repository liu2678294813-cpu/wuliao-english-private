# Writing Slice 5 / Early Vision — Read-only Gate Review

## 1. Baseline

- Repository: `D:\\codex库\\无聊英语`
- Branch: `codex/study-planner`
- HEAD: `28b6817330809fde85563ef18ca35a5d5cf8d0ec`
- Slice start backup: `%TEMP%\\wuliao-writing-slice5-20260828-140833`
- Baseline was heavily dirty: tracked modifications plus untracked `src/writing/`, Exam files, and test files already existed. The backup preserves `tracked.diff`, `staged.diff`, `status.txt`, `untracked.txt`, `package.json`, and a selected `preexisting` copy.
- No staged changes were recorded at the baseline.

This review performed read-only inspection and test execution. The only new file is this review package.

## 2. Actual Slice 5 Diff Boundary

Relative to the Slice-start backup, not Git HEAD:

| Category | Files |
|---|---|
| FILES ADDED | `src/writing/writingRubrics.js`, `writingAiTasks.js`, `writingAiSchemas.js`, `writingAiService.js`, `writingVisionConfig.js`, `writingVisionProvider.js`, `writingVisionRenderer.js`, `writingVisionAdapter.js`, `scripts/test-writing-rubrics.mjs`, `test-writing-ai.mjs`, `test-writing-vision.mjs` |
| FILES MODIFIED | `src/writing/writingRepository.js`; `package.json` |
| FILES DELETED | None |

The baseline copy confirms the original Slice 1–4 Writing files existed before this work. The backup does not contain content snapshots for arbitrary pre-existing untracked Exam/UI files; only their pre-existing paths are recorded in `untracked.txt`.

## 3. Text AI Files

Complete current source, including current Slice 5 Text AI tests, follows.

### `src/writing/writingRubrics.js`

SHA-256: `088D563E37A5C8B5C7CE0CAC780C9385A41CC321D9FD6F4A4ACC6EEE76A01414`

```js
import { WritingTaskType } from "./writingModels.js";

export const WRITING_RUBRICS = Object.freeze({
  [WritingTaskType.POSTGRAD_EN1_WRITING_A]: Object.freeze({
    rubricVersion: "postgrad-en1-writing-a-v1",
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A,
    maxScore: 10,
    targetWordRange: Object.freeze({ min: 90, max: 110 }),
  }),
  [WritingTaskType.POSTGRAD_EN1_WRITING_B]: Object.freeze({
    rubricVersion: "postgrad-en1-writing-b-v1",
    taskType: WritingTaskType.POSTGRAD_EN1_WRITING_B,
    maxScore: 20,
    targetWordRange: Object.freeze({ min: 160, max: 200 }),
  }),
});

export const WRITING_SCORE_DIMENSIONS = Object.freeze([
  "taskFulfillment",
  "contentCoverage",
  "organizationCoherence",
  "languageAccuracy",
  "languageRange",
  "formatRegister",
]);

// The persisted repository remains the final record validator. These are the
// only model-facing zero reasons; technical failures never become a score.
export const WRITING_ZERO_REASONS = Object.freeze([
  "blank",
  "no_effective_english",
  "fully_off_topic",
]);

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

export function isWritingScoreInRange(score, rubric) {
  return Number.isFinite(score) && score >= 0 && score <= rubric.maxScore;
}
```

### `src/writing/writingAiTasks.js`

SHA-256: `4D17813BB010A10C88001DEBA53C2A26D9E348FBCFE8F83D12061E059D641D39`

```js
import { countWritingWords, writingRubricFor } from "./writingRubrics.js";

export const WritingAiTask = Object.freeze({
  SAMPLE_GENERATE: "writing.sample.generate.v1",
  SAMPLE_CRITIC: "writing.sample.critic.v1",
  COMPARE_DIAGNOSIS: "writing.compare.diagnosis.v1",
  SCORE: "writing.score.v1",
  REFERENCE_REWRITE: "writing.reference-rewrite.v1",
  VISION_TRANSCRIBE: "writing.vision.transcribe.v1",
});

export const WRITING_AI_PROMPT_VERSIONS = Object.freeze({
  sampleGenerator: "writing-sample-generator-v1",
  sampleCritic: "writing-sample-critic-v1",
  sampleQualityGate: "writing-sample-quality-gate-v1",
  compareDiagnosis: "writing-compare-diagnosis-v1",
  score: "writing-score-v1",
  referenceRewrite: "writing-reference-rewrite-v1",
  transcription: "writing-transcription-v1",
  visionOpenAi: "writing-vision-openai-v1",
  visionRender: "writing-vision-render-v1",
});

export const WRITING_AI_TASK_IDS = Object.freeze(Object.values(WritingAiTask));

export function isWritingAiTask(value) {
  return WRITING_AI_TASK_IDS.includes(value);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

export function buildSampleGenerationPayload({ promptSnapshot, requiredContentPoints = [] } = {}) {
  if (!plain(promptSnapshot)) throw new TypeError("promptSnapshot is required");
  const rubric = writingRubricFor(promptSnapshot.taskType);
  return {
    taskType: rubric.taskType,
    year: promptSnapshot.year,
    promptText: required(promptSnapshot.promptText, "promptSnapshot.promptText"),
    directions: required(promptSnapshot.directions, "promptSnapshot.directions"),
    assets: Array.isArray(promptSnapshot.assets) ? promptSnapshot.assets.map((asset) => ({
      description: String(asset?.description || asset?.alt || asset?.label || "").trim(),
    })) : [],
    requiredContentPoints: Array.isArray(requiredContentPoints) ? requiredContentPoints.map((item) => String(item).trim()).filter(Boolean) : [],
    targetWordRange: rubric.targetWordRange,
    targetQualityBand: 5,
    generatorPromptVersion: WRITING_AI_PROMPT_VERSIONS.sampleGenerator,
  };
}

export function buildCompareDiagnosisPayload({ sampleEssaySnapshot, translationSnapshot, sourceAttempt } = {}) {
  if (!plain(sampleEssaySnapshot) || !plain(translationSnapshot) || !plain(sourceAttempt)) throw new TypeError("Compare diagnosis requires persisted sample, translation snapshot, and source attempt");
  if (sourceAttempt.status !== "submitted" || !sourceAttempt.verifiedText?.text) throw new TypeError("Compare diagnosis requires a submitted verified W3 attempt");
  if (sourceAttempt.context?.translationSnapshotId !== translationSnapshot.snapshotId) throw new TypeError("Compare diagnosis lineage does not match translation snapshot");
  return {
    sampleEssaySnapshot: { essayId: sampleEssaySnapshot.essayId, fingerprint: sampleEssaySnapshot.fingerprint, text: sampleEssaySnapshot.text },
    translationSnapshot: { snapshotId: translationSnapshot.snapshotId, fingerprint: translationSnapshot.fingerprint, segments: translationSnapshot.segments },
    sourceAttempt: { attemptId: sourceAttempt.attemptId, verifiedText: sourceAttempt.verifiedText },
    promptVersion: WRITING_AI_PROMPT_VERSIONS.compareDiagnosis,
  };
}

export function buildScorePayload({ promptSnapshot, sourceAttempt, rubricVersion } = {}) {
  if (!plain(promptSnapshot) || !plain(sourceAttempt)) throw new TypeError("Score requires promptSnapshot and sourceAttempt");
  if (sourceAttempt.status !== "submitted") throw new TypeError("Formal score requires a submitted Attempt");
  const verifiedText = sourceAttempt.verifiedText;
  if (!plain(verifiedText) || !String(verifiedText.text || "").trim() || !String(verifiedText.fingerprint || "").trim()) {
    throw new TypeError("Formal score requires persisted verifiedText");
  }
  const rubric = writingRubricFor(promptSnapshot.taskType);
  if (rubricVersion !== rubric.rubricVersion) throw new TypeError("rubricVersion does not match prompt taskType");
  return {
    promptSnapshot: {
      questionId: promptSnapshot.questionId,
      fingerprint: promptSnapshot.fingerprint,
      taskType: promptSnapshot.taskType,
      promptText: promptSnapshot.promptText,
      directions: promptSnapshot.directions,
    },
    verifiedText: { text: verifiedText.text, fingerprint: verifiedText.fingerprint },
    rubricVersion,
  };
}

export function buildReferenceRewritePayload({ promptSnapshot, revisionAttempt, scoreReport } = {}) {
  if (!plain(revisionAttempt) || revisionAttempt.status !== "submitted" || !revisionAttempt.verifiedText?.text) {
    throw new TypeError("Reference rewrite requires a submitted revision Attempt with verifiedText");
  }
  if (!plain(promptSnapshot) || !plain(scoreReport)) throw new TypeError("Reference rewrite requires promptSnapshot and scoreReport");
  return {
    promptSnapshot: { questionId: promptSnapshot.questionId, fingerprint: promptSnapshot.fingerprint, promptText: promptSnapshot.promptText, directions: promptSnapshot.directions },
    revisionAttempt: { attemptId: revisionAttempt.attemptId, verifiedText: revisionAttempt.verifiedText },
    scoreReport,
    promptVersion: WRITING_AI_PROMPT_VERSIONS.referenceRewrite,
  };
}

export function validateSampleCandidateDeterministically(candidate, { taskType, promptFingerprint = "" } = {}) {
  const reasons = [];
  if (!plain(candidate)) return { pass: false, reasons: ["candidate_not_object"], wordCount: 0 };
  const essayText = String(candidate.essayText || "").trim();
  const rubric = writingRubricFor(taskType);
  const wordCount = countWritingWords(essayText);
  if (!essayText) reasons.push("empty_essay");
  if (/\b(as an ai|language model|ai assistant)\b/i.test(essayText)) reasons.push("ai_meta_talk");
  if (candidate.taskType !== taskType) reasons.push("task_type_mismatch");
  if (promptFingerprint && candidate.promptFingerprint !== promptFingerprint) reasons.push("prompt_identity_mismatch");
  const buffer = taskType.endsWith("writing-a") ? 10 : 5;
  if (wordCount < rubric.targetWordRange.min - buffer || wordCount > rubric.targetWordRange.max + buffer) reasons.push("word_count_out_of_range");
  if (/\b(score|band|评分|点评|批改|explanation|analysis)\s*[:：]/i.test(essayText)) reasons.push("non_essay_material");
  if (taskType.endsWith("writing-a") && /\bdear\s+(sir|madam)|yours\s+(sincerely|faithfully)/i.test(essayText)) reasons.push("wrong_format_for_writing_a");
  if (taskType.endsWith("writing-b") && /\bdear\s+(sir|madam)|yours\s+(sincerely|faithfully)/i.test(essayText)) reasons.push("wrong_format_for_writing_b");
  return { pass: reasons.length === 0, reasons, wordCount };
}

export function buildWritingAiMessages(task, payload) {
  const jsonOnly = "Only return one JSON object. Do not use Markdown or add prose outside JSON.";
  if (task === WritingAiTask.SAMPLE_GENERATE) return [
    { role: "system", content: `You write a high-quality postgraduate English sample essay. ${jsonOnly}` },
    { role: "user", content: JSON.stringify({ ...payload, response: { taskType: "", promptFingerprint: "", essayText: "", segments: [] } }) },
  ];
  if (task === WritingAiTask.SAMPLE_CRITIC) return [
    { role: "system", content: `You independently assess whether the candidate meets the supplied writing task. ${jsonOnly}` },
    { role: "user", content: JSON.stringify(payload) },
  ];
  if (task === WritingAiTask.SCORE) return [
    { role: "system", content: `Score only the provided verified essay under the provided rubric. Diagnostics do not mechanically determine the final score. ${jsonOnly}` },
    { role: "user", content: JSON.stringify(payload) },
  ];
  return [
    { role: "system", content: `${jsonOnly}` },
    { role: "user", content: JSON.stringify(payload) },
  ];
}
```

### `src/writing/writingAiSchemas.js`

SHA-256: `E6E6ADA71CF9654C053FECBC0F4A308D3D4224E397DEB3B4D99F13A18D4627AA`

```js
import { WRITING_SCORE_DIMENSIONS, WRITING_ZERO_REASONS, countWritingWords, writingRubricFor } from "./writingRubrics.js";

export class WritingAiSchemaError extends Error {
  constructor(message, code = "invalid_response") { super(message); this.name = "WritingAiSchemaError"; this.code = code; }
}

function object(value, name = "response") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WritingAiSchemaError(`${name} must be a JSON object`);
  return value;
}
function text(value, name, { optional = false } = {}) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result && !optional) throw new WritingAiSchemaError(`${name} is required`);
  return result;
}
function array(value, name) { if (!Array.isArray(value)) throw new WritingAiSchemaError(`${name} must be an array`); return value; }
function integer(value, name, min, max) { if (!Number.isInteger(value) || value < min || value > max) throw new WritingAiSchemaError(`${name} is invalid`); return value; }

export function parseWritingAiJson(raw) {
  const source = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const first = source.indexOf("{"); const last = source.lastIndexOf("}");
  if (first < 0 || last < first) throw new WritingAiSchemaError("Response contains no JSON object");
  try { return object(JSON.parse(source.slice(first, last + 1))); } catch { throw new WritingAiSchemaError("Response JSON is invalid"); }
}

export function validateSampleCandidate(value) {
  const item = object(value);
  const segments = array(item.segments, "segments").map((segment, index) => {
    const row = object(segment, `segments[${index}]`);
    return { unitId: text(row.unitId, `segments[${index}].unitId`), text: text(row.text, `segments[${index}].text`) };
  });
  if (!segments.length) throw new WritingAiSchemaError("segments must not be empty");
  return { taskType: text(item.taskType, "taskType"), promptFingerprint: text(item.promptFingerprint, "promptFingerprint"), essayText: text(item.essayText, "essayText"), segments };
}

export function validateSampleQualityReport(value, { taskType } = {}) {
  const item = object(value); const rubric = writingRubricFor(taskType);
  const range = object(item.predictedScoreRange, "predictedScoreRange");
  const min = integer(range.min, "predictedScoreRange.min", 0, rubric.maxScore);
  const max = integer(range.max, "predictedScoreRange.max", min, rubric.maxScore);
  const checks = object(item.checks, "checks");
  for (const key of ["taskFulfillment", "formatRegister", "coherence", "languageAccuracy", "languageRange", "naturalness"]) text(checks[key], `checks.${key}`);
  return { pass: item.pass === true, predictedBand: integer(item.predictedBand, "predictedBand", 0, 5), predictedScoreRange: { min, max }, fatalIssues: array(item.fatalIssues, "fatalIssues").map((x) => text(x, "fatalIssue")), defects: array(item.defects, "defects").map((x) => text(x, "defect")), checks };
}

export function validateCompareDiagnosis(value) {
  const item = object(value);
  return { differences: array(item.differences, "differences").map((entry, index) => {
    const row = object(entry, `differences[${index}]`);
    return { category: text(row.category, "difference.category"), explanation: text(row.explanation, "difference.explanation") };
  }) };
}

export function validateScorePayload(value, { taskType, verifiedText } = {}) {
  const item = object(value); const rubric = writingRubricFor(taskType);
  const finalScore = Number(item.finalScore);
  if (!Number.isFinite(finalScore) || finalScore < 0 || finalScore > rubric.maxScore) throw new WritingAiSchemaError("finalScore is out of rubric range");
  const zeroReason = item.zeroReason == null ? null : text(item.zeroReason, "zeroReason");
  if (finalScore === 0 && !WRITING_ZERO_REASONS.includes(zeroReason)) throw new WritingAiSchemaError("A zero score needs a valid zeroReason");
  if (finalScore !== 0 && zeroReason !== null) throw new WritingAiSchemaError("A non-zero score must not have zeroReason");
  const dimensions = object(item.dimensions, "dimensions");
  for (const name of WRITING_SCORE_DIMENSIONS) {
    const dimension = object(dimensions[name], `dimensions.${name}`);
    integer(dimension.rating, `dimensions.${name}.rating`, 0, 5); text(dimension.comment, `dimensions.${name}.comment`);
    if (!Array.isArray(dimension.evidenceIds)) throw new WritingAiSchemaError(`dimensions.${name}.evidenceIds must be an array`);
  }
  return { finalScore, band: integer(item.band, "band", 0, 5), wordCount: countWritingWords(verifiedText), lengthIssue: text(item.lengthIssue, "lengthIssue", { optional: true }) || null, dimensions, issues: array(item.issues, "issues"), strengths: array(item.strengths, "strengths"), revisionAdvice: array(item.revisionAdvice, "revisionAdvice"), zeroReason };
}

export function validateReferenceRewrite(value) {
  const item = object(value); return { rewrittenEssay: text(item.rewrittenEssay, "rewrittenEssay"), notes: array(item.notes, "notes").map((x) => text(x, "note")) };
}

export function validateVisionPageTranscript(value, { pageId } = {}) {
  const item = object(value); if (pageId && item.pageId !== pageId) throw new WritingAiSchemaError("Vision pageId does not match request");
  return { pageId: text(item.pageId, "pageId"), transcript: text(item.transcript, "transcript", { optional: true }), segments: Array.isArray(item.segments) ? item.segments.map((row, index) => ({ text: text(object(row, `segments[${index}]`).text, `segments[${index}].text`) })) : [] };
}
```

### `src/writing/writingAiService.js`

SHA-256: `9C43FF70564215A0B4DEF4796CE8AE99B4B38E3E87E1BB4D33641D0902F559E7`

```js
import { callDeepSeek, getAiApiConfig, getAiApiKey, resolveAiModel } from "../ai.js";
import { createAiRequestLifecycle, aiRequestContext } from "../aiRequestLifecycle.js";
import { classifyAiError } from "../aiError.js";
import { WritingAiTask, WRITING_AI_PROMPT_VERSIONS, buildCompareDiagnosisPayload, buildReferenceRewritePayload, buildSampleGenerationPayload, buildScorePayload, buildWritingAiMessages, validateSampleCandidateDeterministically } from "./writingAiTasks.js";
import { WritingAiSchemaError, parseWritingAiJson, validateCompareDiagnosis, validateReferenceRewrite, validateSampleCandidate, validateSampleQualityReport, validateScorePayload } from "./writingAiSchemas.js";
import { writingRubricFor } from "./writingRubrics.js";
import { WRITING_SCHEMA_VERSION, WritingAiArtifactType } from "./writingModels.js";

export class WritingAiServiceError extends Error { constructor(code, message, cause = null) { super(message); this.name = "WritingAiServiceError"; this.code = code; this.cause = cause; } }

function errorCode(reason) {
  if (reason instanceof WritingAiSchemaError) return "invalid_response";
  const category = classifyAiError(reason).category;
  return ({ auth: "auth_error", "rate-limit": "rate_limit", network: "network_error", timeout: "timeout", server: "provider_error" })[category] || "provider_error";
}
function contextFor({ sessionId, stageId, targetId, taskType }) { return aiRequestContext({ resourceId: `writing:${sessionId}`, passageId: stageId, questionId: targetId, type: taskType }); }

// These are candidates only. The caller must persist them through the Writing
// Repository; this service never writes a Session, Attempt, or user text.
export function createScoreReportCandidate({ scoreReportId, username, sessionId, sourceAttempt, promptSnapshot, result, lineage, createdAt = Date.now() } = {}) {
  const rubric = writingRubricFor(promptSnapshot?.taskType);
  if (!sourceAttempt?.verifiedText?.fingerprint) throw new TypeError("ScoreReport requires persisted verifiedText lineage");
  return { schemaVersion: WRITING_SCHEMA_VERSION, scoreReportId, username, sessionId, sourceAttemptId: sourceAttempt.attemptId, sourceTextFingerprint: sourceAttempt.verifiedText.fingerprint, taskType: rubric.taskType, rubricVersion: rubric.rubricVersion, promptVersion: lineage?.promptVersion || WRITING_AI_PROMPT_VERSIONS.score, provider: lineage?.provider, modelId: lineage?.modelId, maxScore: rubric.maxScore, ...result, handwritingAssessed: false, createdAt };
}

export function createWritingAiArtifactCandidate({ artifactId, username, sessionId, sourceAttemptId, artifactType, result, lineage, createdAt = Date.now() } = {}) {
  if (!Object.values(WritingAiArtifactType).includes(artifactType)) throw new TypeError("Unsupported Writing AI artifact type");
  return { schemaVersion: WRITING_SCHEMA_VERSION, artifactId, username, sessionId, sourceAttemptId, artifactType, provider: lineage?.provider, modelId: lineage?.modelId, promptVersion: lineage?.promptVersion, payloadVersion: lineage?.promptVersion, result, createdAt };
}

export function createTranscriptionCandidate({ transcriptionId, username, sessionId, sourceAttemptId, sourceInkRef, result, provider, modelId, createdAt = Date.now() } = {}) {
  if (!sourceInkRef?.fingerprint) throw new TypeError("Transcription requires sourceInkRef lineage");
  return { schemaVersion: WRITING_SCHEMA_VERSION, transcriptionId, username, sessionId, sourceAttemptId, sourceInkRef, sourceInkFingerprint: sourceInkRef.fingerprint, provider, modelId, promptVersion: result?.promptVersion || WRITING_AI_PROMPT_VERSIONS.transcription, adapterVersion: result?.adapterVersion || WRITING_AI_PROMPT_VERSIONS.visionOpenAi, rawTranscript: result?.rawTranscript, segments: result?.pages || null, requestMetadata: { pageOrder: result?.pageOrder || [] }, createdAt };
}

export function createWritingAiService({ callAi = callDeepSeek, getApiKey = getAiApiKey, lifecycle = createAiRequestLifecycle(), now = () => Date.now() } = {}) {
  async function invoke({ taskType, payload, sessionId, stageId, targetId, signal = null }) {
    const context = contextFor({ sessionId, stageId, targetId, taskType }); lifecycle.setActiveContext(context);
    const controller = new AbortController();
    const bridge = () => controller.abort(); if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener("abort", bridge, { once: true }); }
    const requestId = lifecycle.nextRequestId(); lifecycle.beginRequest({ requestId, context, controller });
    try {
      const apiKey = await getApiKey(); const modelId = resolveAiModel(taskType); const provider = getAiApiConfig().baseUrl;
      const response = await callAi({ apiKey, model: modelId, messages: buildWritingAiMessages(taskType, payload), temperature: taskType === WritingAiTask.SAMPLE_GENERATE ? 0.5 : 0.2, taskType, signal: controller.signal });
      if (lifecycle.isContextStale(requestId)) throw new WritingAiServiceError("stale", "Writing AI response is stale");
      return { raw: String(response?.content || ""), provider, modelId, requestId, createdAt: now() };
    } catch (reason) { if (reason instanceof WritingAiServiceError) throw reason; throw new WritingAiServiceError(signal?.aborted ? "abort" : errorCode(reason), "Writing AI request failed", reason); }
    finally { lifecycle.endRequest(requestId); if (signal) signal.removeEventListener("abort", bridge); }
  }
  return Object.freeze({
    setActiveContext(detail) { return lifecycle.setActiveContext(contextFor(detail)); }, lifecycle,
    async generateSample({ promptSnapshot, requiredContentPoints, sessionId, stageId = "W1_SAMPLE_READING", targetId = "sample" }) {
      const generation = buildSampleGenerationPayload({ promptSnapshot, requiredContentPoints });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const generated = await invoke({ taskType: WritingAiTask.SAMPLE_GENERATE, payload: generation, sessionId, stageId, targetId: `${targetId}:${attempt}` });
        const candidate = validateSampleCandidate(parseWritingAiJson(generated.raw));
        const deterministic = validateSampleCandidateDeterministically(candidate, { taskType: promptSnapshot.taskType, promptFingerprint: promptSnapshot.fingerprint });
        if (!deterministic.pass) continue;
        const criticPayload = { candidate, promptSnapshot, deterministic, criticPromptVersion: WRITING_AI_PROMPT_VERSIONS.sampleCritic };
        const criticized = await invoke({ taskType: WritingAiTask.SAMPLE_CRITIC, payload: criticPayload, sessionId, stageId, targetId: `${targetId}:${attempt}:critic` });
        const qualityReport = validateSampleQualityReport(parseWritingAiJson(criticized.raw), { taskType: promptSnapshot.taskType });
        if (qualityReport.pass) return { status: "accepted", candidate, qualityReport, lineage: { provider: generated.provider, modelId: generated.modelId, promptVersion: WRITING_AI_PROMPT_VERSIONS.sampleGenerator } };
      }
      return { status: "generation_failed" };
    },
    async score({ promptSnapshot, sourceAttempt, sessionId, stageId = "W8_SCORE_REWRITE", targetId = sourceAttempt?.attemptId }) {
      const rubric = writingRubricFor(promptSnapshot?.taskType); const payload = buildScorePayload({ promptSnapshot, sourceAttempt, rubricVersion: rubric.rubricVersion });
      const result = await invoke({ taskType: WritingAiTask.SCORE, payload, sessionId, stageId, targetId });
      return { result: validateScorePayload(parseWritingAiJson(result.raw), { taskType: promptSnapshot.taskType, verifiedText: sourceAttempt.verifiedText.text }), lineage: { provider: result.provider, modelId: result.modelId, promptVersion: WRITING_AI_PROMPT_VERSIONS.score } };
    },
    async compareDiagnosis({ sampleEssaySnapshot, translationSnapshot, sourceAttempt, sessionId, stageId = "W4_COMPARE_DIAGNOSE", targetId = sourceAttempt?.attemptId }) {
      const payload = buildCompareDiagnosisPayload({ sampleEssaySnapshot, translationSnapshot, sourceAttempt }); const result = await invoke({ taskType: WritingAiTask.COMPARE_DIAGNOSIS, payload, sessionId, stageId, targetId });
      return { result: validateCompareDiagnosis(parseWritingAiJson(result.raw)), lineage: { provider: result.provider, modelId: result.modelId, promptVersion: WRITING_AI_PROMPT_VERSIONS.compareDiagnosis } };
    },
    async referenceRewrite({ promptSnapshot, revisionAttempt, scoreReport, sessionId, stageId = "W8_SCORE_REWRITE", targetId = revisionAttempt?.attemptId }) {
      const payload = buildReferenceRewritePayload({ promptSnapshot, revisionAttempt, scoreReport }); const result = await invoke({ taskType: WritingAiTask.REFERENCE_REWRITE, payload, sessionId, stageId, targetId });
      return { result: validateReferenceRewrite(parseWritingAiJson(result.raw)), lineage: { provider: result.provider, modelId: result.modelId, promptVersion: WRITING_AI_PROMPT_VERSIONS.referenceRewrite } };
    },
  });
}
```

### `scripts/test-writing-rubrics.mjs`

SHA-256: `C90287ACA0BBCDCA1E16756E24B5EA58D1CC40FC993CA3904B303093068F1ABD`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { WritingTaskType } from "../src/writing/writingModels.js";
import { WRITING_SCORE_DIMENSIONS, countWritingWords, writingRubricFor } from "../src/writing/writingRubrics.js";
import { WritingAiSchemaError, validateScorePayload } from "../src/writing/writingAiSchemas.js";

const dimensions = Object.fromEntries(WRITING_SCORE_DIMENSIONS.map((name) => [name, { rating: 5, comment: "evidence-based", evidenceIds: [] }]));

test("Writing rubrics preserve frozen score ranges", () => {
  assert.equal(writingRubricFor(WritingTaskType.POSTGRAD_EN1_WRITING_A).maxScore, 10);
  assert.equal(writingRubricFor(WritingTaskType.POSTGRAD_EN1_WRITING_B).maxScore, 20);
  assert.equal(countWritingWords("One well-written essay's sentence."), 4);
});

test("Score schema bounds band and final score without mechanically summing dimensions", () => {
  const source = "A short verified English essay.";
  const score = validateScorePayload({ finalScore: 7, band: 4, dimensions, issues: [], strengths: [], revisionAdvice: [], zeroReason: null }, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, verifiedText: source });
  assert.equal(score.finalScore, 7);
  assert.throws(() => validateScorePayload({ finalScore: 11, band: 5, dimensions, issues: [], strengths: [], revisionAdvice: [], zeroReason: null }, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, verifiedText: source }), WritingAiSchemaError);
  assert.throws(() => validateScorePayload({ finalScore: 0, band: 0, dimensions, issues: [], strengths: [], revisionAdvice: [], zeroReason: "network_error" }, { taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, verifiedText: source }), WritingAiSchemaError);
});
```

### `scripts/test-writing-ai.mjs`

SHA-256: `DB13EC76361010B9BC89C57FF55553296F9CDE13C7F96B1B6E7D9F86F116E1DE`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { WritingAttemptStatus, WritingTaskType } from "../src/writing/writingModels.js";
import { WritingAiTask, WRITING_AI_PROMPT_VERSIONS, buildReferenceRewritePayload, buildScorePayload, validateSampleCandidateDeterministically } from "../src/writing/writingAiTasks.js";

const prompt = { questionId: "p1", fingerprint: "prompt-fp", taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, promptText: "Write.", directions: "Directions", assets: [] };
const attempt = { attemptId: "attempt-1", status: WritingAttemptStatus.SUBMITTED, verifiedText: { text: "A verified essay.", fingerprint: "verified-fp" } };

test("Writing task ids and prompt versions are fixed", () => {
  assert.equal(WritingAiTask.SCORE, "writing.score.v1");
  assert.equal(WRITING_AI_PROMPT_VERSIONS.score, "writing-score-v1");
});

test("Formal score payload fences all non-verified sources", () => {
  const payload = buildScorePayload({ promptSnapshot: prompt, sourceAttempt: attempt, rubricVersion: "postgrad-en1-writing-a-v1" });
  assert.deepEqual(Object.keys(payload).sort(), ["promptSnapshot", "rubricVersion", "verifiedText"]);
  assert.throws(() => buildScorePayload({ promptSnapshot: prompt, sourceAttempt: { ...attempt, verifiedText: null }, rubricVersion: "postgrad-en1-writing-a-v1" }));
  assert.equal("sampleEssay" in payload, false);
  assert.equal("rawTranscript" in payload, false);
});

test("Reference rewrite requires a submitted revision and sample gate rejects unsafe candidates", () => {
  assert.throws(() => buildReferenceRewritePayload({ promptSnapshot: prompt, revisionAttempt: { ...attempt, status: "drafting" }, scoreReport: {} }));
  assert.equal(validateSampleCandidateDeterministically({ taskType: prompt.taskType, promptFingerprint: prompt.fingerprint, essayText: "As an AI, I cannot write this.", segments: [] }, { taskType: prompt.taskType, promptFingerprint: prompt.fingerprint }).pass, false);
  assert.equal(validateSampleCandidateDeterministically({ taskType: prompt.taskType, promptFingerprint: prompt.fingerprint, essayText: "word ".repeat(98), segments: [] }, { taskType: prompt.taskType, promptFingerprint: prompt.fingerprint }).pass, true);
});
```


## 4. Text AI Task Catalog

| Task | Task ID | Prompt version | Provider path | Formal output |
|---|---|---|---|---|
| Sample Generator | `writing.sample.generate.v1` | `writing-sample-generator-v1` | `createWritingAiService().invoke → callDeepSeek` | Runtime accepted candidate only; no SampleEssaySnapshot builder/persistence is wired |
| Sample Critic | `writing.sample.critic.v1` | `writing-sample-critic-v1` | Same invoke path | Runtime `SampleQualityReport`; no formal record |
| Compare Diagnosis | `writing.compare.diagnosis.v1` | `writing-compare-diagnosis-v1` | Same invoke path | `createWritingAiArtifactCandidate` helper only; caller must persist |
| Formal Score | `writing.score.v1` | `writing-score-v1` | Same invoke path | `createScoreReportCandidate` helper only; caller must call Repository |
| Reference Rewrite | `writing.reference-rewrite.v1` | `writing-reference-rewrite-v1` | Same invoke path | `createWritingAiArtifactCandidate` helper only; caller must persist |

There is no separate critic storage record.

## 5. Sample Gate

| Audit item | Current implementation |
|---|---|
| Generator input builder | `buildSampleGenerationPayload` |
| Deterministic gate | `validateSampleCandidateDeterministically` |
| Local word count | `countWritingWords` using `/[A-Za-z]+(?:['-][A-Za-z]+)*/g` |
| Critic validator | `validateSampleQualityReport` |
| PASS predicate | `deterministic.pass` then `qualityReport.pass` |
| Retry loop | `generateSample` `for (let attempt = 1; attempt <= 3; ...)` |
| Max candidate budget | 3 |
| Failed candidate handling | It is only a local value; no Session/Snapshot/history write occurs in this service |
| Passed snapshot material builder | Not implemented. The service returns `{ status: "accepted", candidate, qualityReport, lineage }`; no SampleEssaySnapshot is built or persisted |

Answers:

- A. Generator and critic are independent requests: **YES**. They use different task IDs and invoke calls.
- B. Maximum 3 candidates: **YES**.
- C. Provider/network failure treated as quality failure: **NO**. It throws `WritingAiServiceError`; it does not advance the candidate loop.
- D. Rejected candidate can write a formal SampleSnapshot through this service: **NO**; this service has no persistence. A wider integration caller is not present to audit.
- E. Critic band required to be band 5: **NO**. `predictedBand` is validated as integer 0–5 and acceptance only checks `pass === true`.
- F. Quality gate version: `writing-sample-quality-gate-v1` is declared, but is not placed into an accepted snapshot or used as an acceptance predicate.

No JSON format-repair retry exists. Invalid generator/critic JSON throws `invalid_response` immediately; repair budget is **0**.

## 6. Compare Fence

The exact provider payload is returned by `buildCompareDiagnosisPayload`:

```js
{
  sampleEssaySnapshot: { essayId, fingerprint, text },
  translationSnapshot: { snapshotId, fingerprint, segments },
  sourceAttempt: { attemptId, verifiedText },
  promptVersion: "writing-compare-diagnosis-v1"
}
```

The allow-list builder is `buildCompareDiagnosisPayload`.

| Potential provider input | Result |
|---|---|
| skeleton | NO |
| W6 reconstruction | NO |
| W7 independent | NO |
| score | NO |
| reference rewrite | NO |
| future fields | NO |

The current builder requires a submitted source attempt and a matching `context.translationSnapshotId`, but it does not itself re-read repository records or assert the attempt type is W3.

## 7. Score Fence

The exact provider payload top-level key set is:

```text
promptSnapshot, verifiedText, rubricVersion
```

`promptSnapshot` contains only `questionId, fingerprint, taskType, promptText, directions`; `verifiedText` contains only `text, fingerprint`.

| Field/data | Status |
|---|---|
| rawTranscript | ABSENT |
| transcription | ABSENT |
| InkRef | ABSENT |
| strokes | ABSENT |
| WritingInkSnapshot | ABSENT |
| image/png | ABSENT |
| SampleEssaySnapshot | ABSENT |
| sample essay | ABSENT |
| TranslationSnapshot | ABSENT |
| back translation | ABSENT |
| compare diagnosis | ABSENT |
| SkeletonRevision | ABSENT |
| W6 reconstruction | ABSENT |
| previous AI advice | ABSENT |
| reference rewrite | ABSENT |
| generic AI history | ABSENT |

## 8. Score Schema / Rubric

- Rubric mapping:
  - `postgrad-en1-writing-a → postgrad-en1-writing-a-v1 → maxScore 10 → target range 90–110`
  - `postgrad-en1-writing-b → postgrad-en1-writing-b-v1 → maxScore 20 → target range 160–200`
- Dimension keys: `taskFulfillment`, `contentCoverage`, `organizationCoherence`, `languageAccuracy`, `languageRange`, `formatRegister`.
- Rating enum: integer 0–5.
- Band enum: integer 0–5.
- ZeroReason enum: `blank`, `no_effective_english`, `fully_off_topic`.
- `finalScore`: finite number in 0…rubric max; it is not computed from dimensions.
- Formal `wordCount`: local `countWritingWords(verifiedText)`; model wordCount is ignored because it is not read.
- `lengthIssue`: optional model string; there is no local classification algorithm.
- Evidence validation: each dimension requires an `evidenceIds` array, but IDs are not checked against a source set and no duplicate-excerpt resolution policy exists.
- Repository additionally requires `handwritingAssessed === false`, immutable ScoreReports, matching persisted submitted Attempt, and matching `sourceTextFingerprint`.

## 9. Reference Rewrite

Actual prerequisite in `buildReferenceRewritePayload`:

- revision attempt status is `submitted`: **YES**
- revision verifiedText exists: **YES**
- promptSnapshot exists: **YES**
- scoreReport is a plain object: **YES**
- independent Attempt submitted: **NOT CHECKED**
- valid persisted ScoreReport exists: **NOT CHECKED**
- revision parentAttemptId matches: **NOT CHECKED**
- provider called before this builder passes: **NO**; the builder executes before `invoke`.

Exact provider payload:

```js
{
  promptSnapshot: { questionId, fingerprint, promptText, directions },
  revisionAttempt: { attemptId, verifiedText },
  scoreReport,
  promptVersion: "writing-reference-rewrite-v1"
}
```

## 10. Lifecycle / Stale / Repair

- Shared lifecycle reused: **YES**, imported as `createAiRequestLifecycle`.
- Mapping: `resourceId = writing:<sessionId>`, `passageId = stageId`, `questionId = targetId`.
- AbortSignal: **YES**. An internal controller signal is passed to `callDeepSeek`; external signal aborts that controller.
- Stale: **YES before return**. `lifecycle.isContextStale(requestId)` is checked after transport settle and before returning a result.
- Source fingerprint snapshot: provider payload includes the supplied persisted verifiedText fingerprint, but the service does **not** independently snapshot/re-read it after settle.
- Account switch check: service has **no explicit account check/re-read**. Repository checks account and score lineage when a caller later invokes `createScoreReport`.
- Duplicate in-flight policy: **no service-level deduplication**. Same target calls are both registered; shared lifecycle only aborts a different target at the same location.
- Invalid-schema repair count: 0.
- Network/auth/429/5xx format repair: **NO**; errors are classified and thrown, not repaired.
- Formal persistence: service never directly persists; it exposes candidate helpers. Therefore the requested `settle → re-read → Repository create...` chain is not implemented end-to-end by this Slice.

## 11. Formal Persistence

| AI task | Success formal record from current service | Failure formal record |
|---|---|---|
| Sample generation | None; runtime result only | None |
| Compare diagnosis | Candidate helper only; no automatic Repository call | None |
| Formal score | Candidate helper only; no automatic Repository call | None |
| Reference rewrite | Candidate helper only; no automatic Repository call | None |
| Vision transcription | Candidate helper only; no automatic Repository call | None |

Within this service, `failed`, `stale`, `abort`, and invalid schema return/throw before a candidate result is returned: **NO SUCCESS ARTIFACT**. Source/account changes are not independently re-read by the service; the existing Repository protects the later persisted ScoreReport lineage, but the caller/integration is absent. Thus a complete formal persistence guarantee cannot be established from this Slice alone.

Score formal answers:

- raw transcript can become Score source: **NO** through `buildScorePayload`.
- ink can become Score source: **NO** through `buildScorePayload`.
- model wordCount becomes formal wordCount: **NO**.
- AI failure generates `finalScore = 0`: **NO** in this service.
- `handwritingAssessed` fixed false in candidate: **YES**.
- rescore creates new immutable ScoreReport: **Repository behavior YES when caller supplies a new `scoreReportId`; service does not orchestrate rescore**.

## 12. Repository Diff

Exact Slice 5 delta in `src/writing/writingRepository.js`:

```diff
@@ -590,6 +590,10 @@ async function validateTranscription(record, id, username) {
   requiredString(record.sourceAttemptId, "sourceAttemptId");
   assert(record.sourceInkRef !== null, "Successful TranscriptionRecord requires sourceInkRef");
   assertInkRef(record.sourceInkRef, "sourceInkRef", { ownerRecordId: record.sourceAttemptId });
+  if (Object.prototype.hasOwnProperty.call(record, "sourceInkFingerprint")) {
+    requiredString(record.sourceInkFingerprint, "sourceInkFingerprint");
+    assert(record.sourceInkFingerprint === record.sourceInkRef.fingerprint, "sourceInkFingerprint does not match sourceInkRef", "lineage-mismatch");
+  }
   assert(typeof record.rawTranscript === "string", "rawTranscript must be a string");
```

1. Strengthening only: **YES**. If the optional field is supplied, it must agree with the existing `sourceInkRef.fingerprint`.
2. Slice 2 Repository schema changed: **NO mandatory schema change**; the new field is optional.
3. Existing validator relaxed: **NO**.
4. `createScoreReport` lineage changed: **NO**.
5. Immutable / expectedRevision behavior changed: **NO**.

## 13. Early Vision Files

> **EARLY VISION IMPLEMENTATION**  
> **NOT PART OF SLICE 5 GATE**

Complete current Vision source and current Vision test follow.

### `src/writing/writingVisionConfig.js`

SHA-256: `D087772F8CAEDFC6777944D142163C6B9B1ABF40B90A2702CE76D61640C704E9`

```js
import { getCurrentUsername, getUserItem, removeUserItem, setUserItem } from "../userData.js";
import { normalizeAiApiBaseUrl } from "../ai.js";

export const WRITING_VISION_API_CONFIG_KEY = "wuliao:writing:vision-api-config:v1";
export const WRITING_VISION_MODEL_KEY = "wuliao:writing:vision-model:v1";
export const WRITING_VISION_MODEL_CATALOG_KEY = "wuliao:writing:vision-model-catalog:v1";
export const WRITING_VISION_PROBE_CACHE_KEY = "wuliao:writing:vision-probe-cache:v1";
export const WRITING_VISION_SECRET_KEY = "wuliao:writing:vision-api-key";
export const WRITING_VISION_TRANSPORT_VERSION = "writing-vision-openai-v1";

const DEFAULT_CONFIG = Object.freeze({ providerKind: "openai-compatible", baseUrl: "", transportVersion: WRITING_VISION_TRANSPORT_VERSION });

function model(value) { const result = String(value || "").trim(); return result && result.length <= 256 && !/[\u0000-\u001f]/.test(result) ? result : ""; }
function configKey() { return WRITING_VISION_API_CONFIG_KEY; }
function probeIdentity(config, modelId) { return JSON.stringify({ providerKind: config.providerKind, baseUrl: config.baseUrl, modelId, adapterVersion: config.transportVersion }); }

export function getWritingVisionConfig() {
  try {
    const stored = JSON.parse(getUserItem(configKey()) || "{}");
    const baseUrl = normalizeAiApiBaseUrl(stored?.baseUrl);
    return { providerKind: stored?.providerKind === "openai-compatible" ? "openai-compatible" : DEFAULT_CONFIG.providerKind, baseUrl, transportVersion: WRITING_VISION_TRANSPORT_VERSION };
  } catch { return { ...DEFAULT_CONFIG }; }
}

export function setWritingVisionConfig(value = {}) {
  const baseUrl = String(value.baseUrl || "").trim() ? normalizeAiApiBaseUrl(value.baseUrl) : "";
  if (String(value.baseUrl || "").trim() && !baseUrl) throw new Error("Vision base URL 必须是合法的 http(s) 地址");
  const next = { providerKind: value.providerKind === "openai-compatible" ? "openai-compatible" : DEFAULT_CONFIG.providerKind, baseUrl, transportVersion: WRITING_VISION_TRANSPORT_VERSION };
  const before = getWritingVisionConfig();
  setUserItem(configKey(), JSON.stringify(next));
  if (before.providerKind !== next.providerKind || before.baseUrl !== next.baseUrl) {
    removeUserItem(WRITING_VISION_MODEL_CATALOG_KEY); removeUserItem(WRITING_VISION_PROBE_CACHE_KEY);
  }
  return next;
}

export function getWritingVisionModel() { return model(getUserItem(WRITING_VISION_MODEL_KEY)); }
export function setWritingVisionModel(value) { const next = model(value); if (next) setUserItem(WRITING_VISION_MODEL_KEY, next); else removeUserItem(WRITING_VISION_MODEL_KEY); removeUserItem(WRITING_VISION_PROBE_CACHE_KEY); return next; }

export function getWritingVisionModelCatalog(config = getWritingVisionConfig()) {
  try { const stored = JSON.parse(getUserItem(WRITING_VISION_MODEL_CATALOG_KEY) || "{}"); return stored?.baseUrl === config.baseUrl && stored?.providerKind === config.providerKind && Array.isArray(stored.models) ? stored.models.map(model).filter(Boolean) : []; } catch { return []; }
}
export function setWritingVisionModelCatalog(models, config = getWritingVisionConfig()) {
  const unique = [...new Set((Array.isArray(models) ? models : []).map(model).filter(Boolean))];
  setUserItem(WRITING_VISION_MODEL_CATALOG_KEY, JSON.stringify({ providerKind: config.providerKind, baseUrl: config.baseUrl, models: unique, updatedAt: Date.now() })); return unique;
}

export function getWritingVisionProbeCache(config = getWritingVisionConfig(), modelId = getWritingVisionModel()) {
  try { const stored = JSON.parse(getUserItem(WRITING_VISION_PROBE_CACHE_KEY) || "{}"); return stored?.identity === probeIdentity(config, modelId) ? stored.result || null : null; } catch { return null; }
}
export function setWritingVisionProbeCache(result, config = getWritingVisionConfig(), modelId = getWritingVisionModel()) {
  const stored = { identity: probeIdentity(config, modelId), result: { ...result, cachedAt: Date.now() } }; setUserItem(WRITING_VISION_PROBE_CACHE_KEY, JSON.stringify(stored)); return stored.result;
}

function secureKey(username) { return `ai:vision-apikey:${encodeURIComponent(username)}`; }
export async function getWritingVisionApiKey({ username = getCurrentUsername(), secureStore = globalThis.window?.AndroidSecureStore } = {}) {
  if (!username) return "";
  if (secureStore?.get) { try { return String(await secureStore.get(secureKey(username)) || "").trim(); } catch { return ""; } }
  // Web fallback is account-isolated but is not encrypted secure storage.
  return String(getUserItem(WRITING_VISION_SECRET_KEY, username) || "").trim();
}
export async function setWritingVisionApiKey(value, { username = getCurrentUsername(), secureStore = globalThis.window?.AndroidSecureStore } = {}) {
  if (!username) throw new Error("请先登录账号"); const key = String(value || "").trim();
  if (secureStore?.set) { if (key) await secureStore.set(secureKey(username), key); else await secureStore.remove?.(secureKey(username)); return; }
  if (key) setUserItem(WRITING_VISION_SECRET_KEY, key, username); else removeUserItem(WRITING_VISION_SECRET_KEY, username);
}

export function writingVisionProbeIdentity(config, modelId) { return probeIdentity(config, modelId); }
```

### `src/writing/writingVisionProvider.js`

SHA-256: `72F2BD0EB7BF2A441B2B6D49EB4211746E38C5370D4CDAD3C268203E2EC9C040`

```js
import { normalizeAiApiBaseUrl } from "../ai.js";
import { WRITING_AI_PROMPT_VERSIONS } from "./writingAiTasks.js";
import { parseWritingAiJson, validateVisionPageTranscript } from "./writingAiSchemas.js";

export const VisionCapabilityStatus = Object.freeze(["supported", "unsupported", "auth_error", "rate_limit", "network_error", "timeout", "provider_error", "invalid_response"]);

function responseCategory(status, message = "") {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_error";
  if (/image.*(unsupported|not support)|multimodal.*(unsupported|not support)/i.test(message)) return "unsupported";
  return "provider_error";
}
function fromError(error) {
  if (error?.name === "AbortError") return "timeout";
  if (error instanceof TypeError) return "network_error";
  return "provider_error";
}
function cleanModelList(value) { const rows = Array.isArray(value) ? value : value?.data; return Array.isArray(rows) ? [...new Set(rows.map((item) => String(item?.id || item?.name || item || "").trim()).filter(Boolean))] : []; }
async function dataUrl(blob) { const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return `data:${blob.type || "image/png"};base64,${btoa(binary)}`; }

export function createOpenAiCompatibleVisionProvider({ fetchFn = globalThis.fetch } = {}) {
  if (typeof fetchFn !== "function") throw new TypeError("fetch is unavailable");
  async function request(config, apiKey, path, init, signal) {
    const baseUrl = normalizeAiApiBaseUrl(config?.baseUrl); if (!baseUrl) throw new Error("Vision base URL is required");
    const response = await fetchFn(`${baseUrl}/${path}`, { ...init, headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) }, signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) { const error = new Error(body?.error?.message || `Vision request failed (${response.status})`); error.status = response.status; error.category = responseCategory(response.status, error.message); throw error; }
    return body;
  }
  return Object.freeze({
    async listModels({ config, apiKey, signal }) { return cleanModelList(await request(config, apiKey, "models", { method: "GET" }, signal)); },
    async transcribePage({ config, apiKey, modelId, imageBlob, pageId, promptVersion = WRITING_AI_PROMPT_VERSIONS.transcription, signal }) {
      const imageUrl = await dataUrl(imageBlob);
      const body = await request(config, apiKey, "chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelId, temperature: 0, messages: [{ role: "system", content: `Faithfully transcribe this handwriting image. Return only JSON {pageId, transcript, segments}. Do not score, correct, rewrite, or add advice. Version: ${promptVersion}` }, { role: "user", content: [{ type: "text", text: `Transcribe pageId ${pageId}.` }, { type: "image_url", image_url: { url: imageUrl } }] }] }) }, signal);
      return validateVisionPageTranscript(parseWritingAiJson(body?.choices?.[0]?.message?.content || ""), { pageId });
    },
    async probe({ config, apiKey, modelId, imageBlob, signal }) {
      try {
        const imageUrl = await dataUrl(imageBlob);
        const body = await request(config, apiKey, "chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelId, temperature: 0, messages: [{ role: "user", content: [{ type: "text", text: "读取图片中的 token，仅返回该 token。" }, { type: "image_url", image_url: { url: imageUrl } }] }] }) }, signal);
        const token = String(body?.choices?.[0]?.message?.content || "").trim().replace(/^['"`]|['"`]$/g, "");
        return { status: token === "WL7" ? "supported" : "invalid_response" };
      } catch (error) { return { status: error?.category || fromError(error) }; }
    },
  });
}

export async function createWl7ProbeImage({ documentRef = globalThis.document } = {}) {
  if (!documentRef?.createElement) throw new Error("Vision probe image encoder is unavailable");
  const canvas = documentRef.createElement("canvas"); canvas.width = 160; canvas.height = 80;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Vision probe canvas is unavailable");
  context.fillStyle = "white"; context.fillRect(0, 0, 160, 80); context.fillStyle = "black"; context.font = "bold 48px sans-serif"; context.fillText("WL7", 20, 58);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Vision probe encoding failed")), "image/png"));
}
```

### `src/writing/writingVisionRenderer.js`

SHA-256: `E226707109245DF451205BA73659BB336E6C86EA9F58F364C444E4F37A7F6BF9`

```js
import { WRITING_INK_COORDINATE_SPACE, WRITING_PAGE_CANONICAL_SIZE, isVisionRenderableWritingStroke } from "./writingInkGeometry.js";
import { WRITING_AI_PROMPT_VERSIONS } from "./writingAiTasks.js";

export const WRITING_VISION_RENDER_WIDTH = 1600;
export const WRITING_VISION_RENDER_HEIGHT = Math.round(WRITING_VISION_RENDER_WIDTH * WRITING_PAGE_CANONICAL_SIZE.height);

function pageIdOf(stroke) { return String(stroke?.writingAnchor?.pageId || "").trim(); }

export function stableWritingInkPageOrder(snapshot) {
  const strokes = Array.isArray(snapshot?.strokes) ? snapshot.strokes : [];
  const declared = Array.isArray(snapshot?.pageOrder) ? snapshot.pageOrder.map((id) => String(id).trim()).filter(Boolean) : [];
  const discovered = strokes.filter(isVisionRenderableWritingStroke).map(pageIdOf).filter(Boolean);
  return [...new Set([...declared, ...discovered])];
}

export function buildWritingVisionRenderPlan(snapshot, pageId) {
  if (!snapshot || snapshot.coordinateSpace && snapshot.coordinateSpace !== WRITING_INK_COORDINATE_SPACE) throw new TypeError("WritingInkSnapshot must use writing-page-v1 geometry");
  const id = String(pageId || "").trim(); if (!id) throw new TypeError("pageId is required");
  const strokes = (Array.isArray(snapshot.strokes) ? snapshot.strokes : []).filter((stroke) => pageIdOf(stroke) === id);
  if (strokes.some((stroke) => !isVisionRenderableWritingStroke(stroke))) throw new TypeError("Vision rendering refuses non-canonical Writing stroke data");
  return {
    adapterVersion: WRITING_AI_PROMPT_VERSIONS.visionRender,
    pageId: id,
    width: WRITING_VISION_RENDER_WIDTH,
    height: WRITING_VISION_RENDER_HEIGHT,
    background: "white",
    strokes: strokes.map((stroke) => ({
      tool: stroke.tool || "pen",
      color: stroke.color || "#111111",
      size: Number.isFinite(stroke.size) ? stroke.size : 4,
      points: stroke.points.map((point) => ({ x: point.writingLocal.x * WRITING_VISION_RENDER_WIDTH, y: point.writingLocal.y * WRITING_VISION_RENDER_HEIGHT })),
    })),
  };
}

export function createBrowserWritingVisionEncoder({ documentRef = globalThis.document } = {}) {
  return async function encode(plan) {
    if (!documentRef?.createElement) throw new Error("Canvas encoder is unavailable");
    const canvas = documentRef.createElement("canvas"); canvas.width = plan.width; canvas.height = plan.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas context is unavailable");
    context.fillStyle = plan.background; context.fillRect(0, 0, plan.width, plan.height); context.lineCap = "round"; context.lineJoin = "round";
    for (const stroke of plan.strokes) {
      if (!stroke.points.length) continue; context.strokeStyle = stroke.color; context.lineWidth = Math.max(1, stroke.size);
      context.beginPath(); context.moveTo(stroke.points[0].x, stroke.points[0].y); for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y); context.stroke();
    }
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Writing page PNG encoding failed")), "image/png"));
  };
}

export async function renderWritingInkPage(snapshot, pageId, { encode = createBrowserWritingVisionEncoder() } = {}) {
  const plan = buildWritingVisionRenderPlan(snapshot, pageId); const imageBlob = await encode(plan);
  if (!imageBlob || typeof imageBlob.arrayBuffer !== "function") throw new Error("Vision encoder did not return an image Blob");
  return { pageId: plan.pageId, imageBlob, plan };
}
```

### `src/writing/writingVisionAdapter.js`

SHA-256: `44570603B041316B510A45E2AD9A523F1EA54644B571EA704DF94E074E3C9217`

```js
import { WRITING_AI_PROMPT_VERSIONS } from "./writingAiTasks.js";
import { validateVisionPageTranscript } from "./writingAiSchemas.js";
import { renderWritingInkPage, stableWritingInkPageOrder } from "./writingVisionRenderer.js";

export class WritingVisionAdapterError extends Error {
  constructor(code, message, cause = null) { super(message); this.name = "WritingVisionAdapterError"; this.code = code; this.cause = cause; }
}

export async function transcribeWritingInkSnapshot({ snapshot, provider, config, apiKey, modelId, signal, renderPage = renderWritingInkPage, pageOrder = null } = {}) {
  if (!provider?.transcribePage) throw new TypeError("Vision provider.transcribePage is required");
  const pages = pageOrder || stableWritingInkPageOrder(snapshot);
  if (!pages.length) throw new WritingVisionAdapterError("no_pages", "Writing ink contains no canonical pages");
  const transcripts = [];
  for (const pageId of pages) {
    let rendered;
    try {
      rendered = await renderPage(snapshot, pageId);
      const output = await provider.transcribePage({ config, apiKey, modelId, imageBlob: rendered.imageBlob, pageId, promptVersion: WRITING_AI_PROMPT_VERSIONS.transcription, signal });
      transcripts.push(validateVisionPageTranscript(output, { pageId }));
    } catch (cause) {
      // Do not return a partial formal transcription. The successful temporary
      // page values stay only in this call frame for an explicit retry.
      throw new WritingVisionAdapterError(cause?.code || "transcription_failed", `Vision transcription failed for ${pageId}`, cause);
    } finally {
      try { rendered?.imageBlob?.close?.(); } catch { /* Blob has no required close API */ }
    }
  }
  return { pageOrder: [...pages], pages: transcripts, rawTranscript: transcripts.map((item) => item.transcript).join("\n\n"), promptVersion: WRITING_AI_PROMPT_VERSIONS.transcription, adapterVersion: WRITING_AI_PROMPT_VERSIONS.visionOpenAi };
}
```

### `scripts/test-writing-vision.mjs`

SHA-256: `13958B11FEE2E5DC619315B8F9D46E1FA6AD019661D2F1B2F64FE0DE38285CDA`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { WritingTaskType } from "../src/writing/writingModels.js";
import { WRITING_VISION_RENDER_HEIGHT, WRITING_VISION_RENDER_WIDTH, buildWritingVisionRenderPlan } from "../src/writing/writingVisionRenderer.js";
import { transcribeWritingInkSnapshot } from "../src/writing/writingVisionAdapter.js";
import { WritingVisionAdapterError } from "../src/writing/writingVisionAdapter.js";

function stroke(pageId, x, y) { return { coordinateSpace: "writing-page-v1", writingAnchor: { version: 1, pageId }, tool: "pen", points: [{ writingLocal: { x, y } }] }; }
const snapshot = { strokes: [stroke("page-1", 0.25, 0.4), stroke("page-2", 0.25, 0.4)] };

test("Vision renderer uses page-local A4 canonical geometry only", () => {
  const plan = buildWritingVisionRenderPlan(snapshot, "page-1");
  assert.equal(plan.width, 1600); assert.equal(plan.height, Math.round(1600 * Math.sqrt(2))); assert.equal(plan.background, "white");
  assert.deepEqual(plan.strokes[0].points[0], { x: WRITING_VISION_RENDER_WIDTH * 0.25, y: WRITING_VISION_RENDER_HEIGHT * 0.4 });
  assert.equal(buildWritingVisionRenderPlan({ strokes: [...snapshot.strokes, stroke("page-3", 0.1, 0.2)] }, "page-1").strokes[0].points[0].y, plan.strokes[0].points[0].y);
});

test("Vision adapter refuses partial formal transcription and preserves stable order", async () => {
  const rendered = async (_snapshot, pageId) => ({ pageId, imageBlob: new Blob([pageId], { type: "image/png" }) });
  const provider = { transcribePage: async ({ pageId }) => ({ pageId, transcript: `text-${pageId}`, segments: [], score: 20, rewrittenEssay: "ignored" }) };
  const result = await transcribeWritingInkSnapshot({ snapshot, provider, config: {}, apiKey: "not logged", modelId: "vision", renderPage: rendered });
  assert.deepEqual(result.pageOrder, ["page-1", "page-2"]); assert.equal(result.rawTranscript, "text-page-1\n\ntext-page-2");
  await assert.rejects(() => transcribeWritingInkSnapshot({ snapshot, provider: { transcribePage: async ({ pageId }) => { if (pageId === "page-2") throw new Error("failed"); return { pageId, transcript: "ok", segments: [] }; } }, config: {}, apiKey: "", modelId: "vision", renderPage: rendered }), WritingVisionAdapterError);
});
```


## 14. Vision Boundary

| Component | Implemented | Responsibility |
|---|---:|---|
| independent Vision config | YES | separate provider/base URL/model/catalog/probe cache keys |
| API key storage | YES | AndroidSecureStore namespace, user-scoped web fallback |
| model/baseURL | YES | Vision-only config APIs |
| capability probe | YES | local canvas WL7 image, provider probe |
| provider | YES | OpenAI-compatible list/transcribe/probe |
| page renderer | YES | page-local canonical strokes to in-memory PNG Blob |
| transcription adapter | YES | all-pages-or-no-result runtime transcription |
| verifiedText confirmation | NO | adapter creates raw transcript candidate only; confirmation remains outside it |

Answers:

1. Vision/Text config separation: **YES**.
2. Vision only transcription: **YES**, by provider prompt and transcript schema.
3. Vision scoring/editing capability: **NO**. Extra provider score/rewrite fields are discarded by `validateVisionPageTranscript`.
4. Vision request can include SampleEssay: **NO** in provider/adapter call shape.
5. Rubric/score: **NO**.
6. Skeleton/diagnosis/advice: **NO**.
7. Renderer uses only `writing-page-v1`: **YES**; it requires canonical strokes and projects `writingLocal` into a 1600 × round(1600 × √2) white page.
8. PNG only memory: **YES**; returned Blob is not written to storage.
9. PNG/base64 persisted: **NO**.
10. Transcription turns directly into verifiedText: **NO**.
11. Live WL7 capability mechanism implemented: **YES**.
12. Real provider capability verified: **NO**. Fake-provider contract tests only.

The web fallback is account-isolated but not encrypted secure storage. `backup.js` was unchanged; its existing secret-key pattern matches `wuliao:writing:vision-api-key`, so this key is excluded from backup.

## 15. Android Out-of-order Operations

This section records prior operations only. No Android command ran during this review.

| Operation | Recorded result |
|---|---|
| web build | succeeded |
| `android:sync` | succeeded |
| `assembleDebug` | succeeded |
| `adb install -r` | succeeded on `7VXYD24229201695` |
| launch | `am start -W` Status ok; warm launch 824 ms |

- uninstall executed: **NO**
- `pm clear` executed: **NO**
- versionName/versionCode changed: **NO**; observed `1.0.56 (57)`
- Android source modified by Slice 5: **NO**
- MainActivity modified by Slice 5: **NO**
- native plugin changed by Slice 5: **NO**
- build/output artifacts only from Android actions: **YES**

**OUT-OF-ORDER VALIDATION** — not a final Android gate.

## 16. 903/905 → 912/912 Root Cause

Current evidence rejects the claimed `912 / 912` result.

1. Current `corepack pnpm test:ui-polish` result: **26 tests; 24 pass; 2 fail**.
2. The two failures are exactly:
   - `Exam Library 按钮统一与作答页 Chrome 结构`: `ExamScreens.jsx` lacks `exam-status-bar`.
   - `Exam 次级按钮 / 题号 / 冷色收口与 CSS ownership`: `exam.css` lacks `--exam-status-height`.
3. `test:all` still explicitly contains `scripts/test-ui-polish-20260813.mjs`; therefore cause C (test removed from full suite) is **NO**.
4. The Slice-start `untracked.txt` already lists `scripts/test-ui-polish-20260813.mjs`, `src/exam/ExamScreens.jsx`, and `src/exam/exam.css`. The Slice-start backup has no content copies for these pre-existing untracked files, so their byte-for-byte start/current comparison is unavailable.
5. The only recorded Slice 5 code changes are the Writing files, `writingRepository.js`, and `package.json`; the package diff merely appends three Writing tests and preserves `--test-concurrency=2`.

Classification: **F — reporting/verification error, with evidence**. The prior `912/912` claim was inconsistent with the actual current targeted source assertions. The two UI failures have not disappeared; they are reproducible. It is not evidence that Slice 5 changed the Exam UI or tests.

## 17. Test Inventory

| Command / scope | Tests | Pass | Fail |
|---|---:|---:|---:|
| Writing Flow | 28 | 28 | 0 |
| Writing Models | 14 | 14 | 0 |
| Writing Storage | 28 | 28 | 0 |
| Writing Commands | 38 | 38 | 0 |
| Writing Ink | 28 | 28 | 0 |
| Writing Text AI: rubrics | 2 | 2 | 0 |
| Writing Text AI: service/tasks | 3 | 3 | 0 |
| Writing Vision-related | 2 | 2 | 0 |
| Shared AI lifecycle | 10 | 10 | 0 |
| AI model preference | 4 | 4 | 0 |
| UI polish targeted | 26 | 24 | 2 |
| Exam Ink Surface targeted | 6 | 6 | 0 |
| Exam Question Drawer targeted | 5 | 5 | 0 |
| Full `test:all` (prior recorded run, corroborated by current UI failure) | 912 | 910 | 2 |

## 18. Shared AI File Hashes

All compared byte-for-byte equal to the Slice-start backup:

| File | Current SHA-256 | Baseline equal |
|---|---|---:|
| `src/ai.js` | `720CFB9A0B87692CF94981F53DAF0F4B4106D6EC195D982C7CFFD9B9F4F80778` | YES |
| `src/aiRequestLifecycle.js` | `CDAF910CA375A58A74AFC508E99854C510046606522D34EBA23A63F3630E6B1E` | YES |
| `src/aiError.js` | `1A1AF96A93501B5FF543AB258BD7927D868717D60BB4BA459E567319767E2B2C` | YES |
| `src/userData.js` | `4FE263A99080C8DDDDA728D60616101DCA182EFA660821EB06BA3B2F3A1B6126` | YES |
| `src/storage.js` | `0C710C506CB45A4CA5220F52A756797D561AB9E71D7731B833249B8E58FA4A50` | YES |
| `src/backup.js` | `565F94A6324FD5548D9EB9F3F99985D2DBD7A9876261D6CFE272B308775FC1BA` | YES |

## 19. Deviations

- The Slice has **not** completed an end-to-end formal persistence integration. Service methods return validated results/candidates but do not call Repository.
- No settle-time source/account re-read occurs in the service.
- Reference rewrite does not establish persisted ScoreReport validity, independent-attempt status, or parentAttemptId lineage.
- Critic acceptance does not require predicted band 5.
- The declared quality-gate version has no persisted formal output.
- Schema validation has no repair retry.
- Duplicate same-target Writing AI requests are not deduplicated.
- Vision was implemented early and is intentionally excluded from the Slice 5 gate per this review instruction.
- Existing Exam UI failures remain; full suite is not green.

## 20. Unresolved Risks

1. A future integration could persist candidate helpers without adding the required source/account re-read and task-specific lineage checks.
2. The service's score fence is strong at payload construction, but no call-site integration proves all callers use it.
3. The model-derived `lengthIssue` and unverified `evidenceIds` need a frozen policy before formal scoring is accepted.
4. Vision live provider behavior, image payload compatibility, and Android secure-storage behavior with a real credential remain unverified.
5. The existing two Exam UI failures must be resolved independently; they are unrelated to the current Writing code boundary by available evidence.
6. AR NUMBER SOURCE NOT PRESENT IN WORKTREE.

REVIEW PACKAGE COMPLETE
