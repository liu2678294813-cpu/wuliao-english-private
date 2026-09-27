import { countWritingWords, writingRubricFor } from "./writingRubrics.js";

export const WritingAiTask = Object.freeze({ SAMPLE_GENERATE: "writing.sample.generate.v1", SAMPLE_CRITIC: "writing.sample.critic.v1", COMPARE_DIAGNOSIS: "writing.compare.diagnosis.v1", SCORE: "writing.score.v1", REFERENCE_REWRITE: "writing.reference-rewrite.v1", VISION_TRANSCRIBE: "writing.vision.transcribe.v1" });
export const WRITING_AI_PROMPT_VERSIONS = Object.freeze({ sampleGenerator: "writing-sample-generator-v1", sampleCritic: "writing-sample-critic-v1", sampleQualityGate: "writing-sample-quality-gate-v1", compareDiagnosis: "writing-compare-diagnosis-v1", score: "writing-score-v1", referenceRewrite: "writing-reference-rewrite-v1", transcription: "writing-transcription-v1", visionOpenAi: "writing-vision-openai-v1", visionRender: "writing-vision-render-v1" });
export const WRITING_AI_TASK_IDS = Object.freeze(Object.values(WritingAiTask));
export function isWritingAiTask(value) { return WRITING_AI_TASK_IDS.includes(value); }
function plain(value) { return value && typeof value === "object" && !Array.isArray(value); }
function required(value, name) { const text = String(value || "").trim(); if (!text) throw new TypeError(`${name} is required`); return text; }
function verified(attempt, name) { if (!plain(attempt) || attempt.status !== "submitted" || !plain(attempt.verifiedText)) throw new TypeError(`${name} requires a submitted verified Attempt`); return { text: required(attempt.verifiedText.text, `${name}.verifiedText.text`), fingerprint: required(attempt.verifiedText.fingerprint, `${name}.verifiedText.fingerprint`) }; }
function promptFields(promptSnapshot) { if (!plain(promptSnapshot)) throw new TypeError("promptSnapshot is required"); return { questionId: promptSnapshot.questionId, fingerprint: promptSnapshot.fingerprint, taskType: promptSnapshot.taskType, promptText: required(promptSnapshot.promptText, "promptSnapshot.promptText"), directions: required(promptSnapshot.directions, "promptSnapshot.directions") }; }

export function buildSampleGenerationPayload({ promptSnapshot, requiredContentPoints = [] } = {}) {
  const prompt = promptFields(promptSnapshot); const rubric = writingRubricFor(prompt.taskType);
  return { taskType: rubric.taskType, promptFingerprint: prompt.fingerprint, year: promptSnapshot.year, promptText: prompt.promptText, directions: prompt.directions, assets: Array.isArray(promptSnapshot.assets) ? promptSnapshot.assets.map((asset) => ({ description: String(asset?.description || asset?.alt || asset?.label || "").trim() })) : [], requiredContentPoints: Array.isArray(requiredContentPoints) ? requiredContentPoints.map((item) => String(item).trim()).filter(Boolean) : [], targetWordRange: rubric.targetWordRange, targetQualityBand: 5, generatorPromptVersion: WRITING_AI_PROMPT_VERSIONS.sampleGenerator };
}

export function buildCompareDiagnosisPayload({ sampleEssaySnapshot, translationSnapshot, sourceAttempt } = {}) {
  const verifiedText = verified(sourceAttempt, "Compare diagnosis"); if (!plain(sampleEssaySnapshot) || !plain(translationSnapshot)) throw new TypeError("Compare diagnosis requires persisted sample and translation snapshot"); if (sourceAttempt.context?.translationSnapshotId !== translationSnapshot.snapshotId) throw new TypeError("Compare diagnosis lineage does not match translation snapshot");
  return { sampleEssaySnapshot: { essayId: required(sampleEssaySnapshot.essayId, "sampleEssaySnapshot.essayId"), fingerprint: required(sampleEssaySnapshot.fingerprint, "sampleEssaySnapshot.fingerprint"), segments: (sampleEssaySnapshot.segments || []).map(({ unitId, text }) => ({ unitId: required(unitId, "sample unitId"), text: required(text, "sample unit text") })) }, translationSnapshot: { snapshotId: required(translationSnapshot.snapshotId, "translationSnapshot.snapshotId"), fingerprint: required(translationSnapshot.fingerprint, "translationSnapshot.fingerprint"), units: (translationSnapshot.units || []).map(({ unitId, typedText }) => ({ unitId: required(unitId, "translation unitId"), typedText: String(typedText || "") })) }, backTranslationAttempt: { attemptId: required(sourceAttempt.attemptId, "sourceAttempt.attemptId"), verifiedText }, promptVersion: WRITING_AI_PROMPT_VERSIONS.compareDiagnosis };
}

export function buildScorePayload({ promptSnapshot, sourceAttempt, rubricVersion } = {}) {
  const prompt = promptFields(promptSnapshot); const verifiedText = verified(sourceAttempt, "Formal score"); const rubric = writingRubricFor(prompt.taskType); if (rubricVersion !== rubric.rubricVersion) throw new TypeError("rubricVersion does not match prompt taskType");
  return { promptSnapshot: prompt, verifiedText, rubricVersion };
}

export function buildReferenceRewritePayload({ promptSnapshot, revisionAttempt, scoreReport } = {}) {
  const prompt = promptFields(promptSnapshot); const verifiedText = verified(revisionAttempt, "Reference rewrite"); if (!plain(scoreReport)) throw new TypeError("Reference rewrite requires scoreReport");
  return { promptSnapshot: prompt, revisionAttempt: { attemptId: required(revisionAttempt.attemptId, "revisionAttempt.attemptId"), verifiedText }, scoreReport: { finalScore: scoreReport.finalScore, dimensions: scoreReport.dimensions, issues: scoreReport.issues, revisionAdvice: scoreReport.revisionAdvice }, promptVersion: WRITING_AI_PROMPT_VERSIONS.referenceRewrite };
}

export function buildWritingAiFormatRepairPayload({ taskType, originalPayload, invalidResponse }) {
  const sampleInstruction = "Return a root JSON object with top-level keys exactly taskType, promptFingerprint, essayText, and segments. Do not wrap it in response, result, data, output, or Markdown. Echo taskType and promptFingerprint exactly from originalPayload. segments must be a non-empty array of {unitId,text} objects covering the essay.";
  const criticInstruction = "Return a root JSON object with top-level keys exactly pass, predictedBand, predictedScoreRange, fatalIssues, defects, and checks. Do not return band or feedback. Do not wrap it in response, result, data, output, or Markdown. predictedScoreRange must have integer min/max; defects must contain {code,severity,evidence,repairInstruction}; checks must contain the six requested check keys.";
  const instruction = taskType === WritingAiTask.SAMPLE_GENERATE ? sampleInstruction : taskType === WritingAiTask.SAMPLE_CRITIC ? criticInstruction : "Return the same task result as one JSON object matching the requested schema. Do not change the task or add prose.";
  return { taskType, formatRepair: true, instruction, originalPayload, invalidResponse: String(invalidResponse || "").slice(0, 12000) };
}

export function validateSampleCandidateDeterministically(candidate, { taskType, promptFingerprint = "" } = {}) {
  const reasons = []; if (!plain(candidate)) return { pass: false, reasons: ["candidate_not_object"], wordCount: 0 }; const essayText = String(candidate.essayText || "").trim(); const rubric = writingRubricFor(taskType); const wordCount = countWritingWords(essayText);
  if (!essayText) reasons.push("empty_essay"); if (/\b(as an ai|language model|ai assistant)\b/i.test(essayText)) reasons.push("ai_meta_talk"); if (candidate.taskType !== taskType) reasons.push("task_type_mismatch"); if (promptFingerprint && candidate.promptFingerprint !== promptFingerprint) reasons.push("prompt_identity_mismatch"); const buffer = taskType.endsWith("writing-a") ? 10 : 5; if (wordCount < rubric.targetWordRange.min - buffer || wordCount > rubric.targetWordRange.max + buffer) reasons.push("word_count_out_of_range"); if (/\b(score|band|评分|点评|批改|explanation|analysis)\s*[:：]/i.test(essayText)) reasons.push("non_essay_material"); if (taskType.endsWith("writing-a") && /\bdear\s+(sir|madam)|yours\s+(sincerely|faithfully)/i.test(essayText)) reasons.push("wrong_format_for_writing_a"); if (taskType.endsWith("writing-b") && /\bdear\s+(sir|madam)|yours\s+(sincerely|faithfully)/i.test(essayText)) reasons.push("wrong_format_for_writing_b");
  return { pass: reasons.length === 0, reasons, wordCount };
}

export function buildWritingAiMessages(task, payload) {
  const jsonOnly = "Only return one JSON object. Do not use Markdown or add prose outside JSON.";
  if (task === WritingAiTask.SAMPLE_GENERATE) {
    const source = payload?.formatRepair ? payload.originalPayload : payload;
    const outputContract = { taskType: source.taskType, promptFingerprint: source.promptFingerprint, essayText: "complete essay text", segments: [{ unitId: "unit-1", text: "non-empty essay segment" }] };
    const contract = "Return a root JSON object with top-level keys exactly taskType, promptFingerprint, essayText, and segments. Echo taskType and promptFingerprint exactly. Do not wrap the object in response, result, data, output, or Markdown. segments must be a non-empty array of {unitId,text} objects that divide the complete essay into meaningful ordered units.";
    return [{ role: "system", content: `You write a high-quality postgraduate English sample essay. ${contract} ${jsonOnly}` }, { role: "user", content: JSON.stringify({ ...payload, outputContract }) }];
  }
  if (task === WritingAiTask.SAMPLE_CRITIC) {
    const outputContract = { pass: "boolean", predictedBand: "integer 0..5", predictedScoreRange: { min: "integer within rubric", max: "integer within rubric and >= min" }, fatalIssues: ["string"], defects: [{ code: "string", severity: "fatal | major | minor", evidence: "string", repairInstruction: "string" }], checks: { taskFulfillment: "pass | fail | not_applicable", formatRegister: "pass | fail | not_applicable", coherence: "pass | fail | not_applicable", languageAccuracy: "pass | fail | not_applicable", languageRange: "pass | fail | not_applicable", naturalness: "pass | fail | not_applicable" } };
    const contract = "Return a root JSON object with top-level keys exactly pass, predictedBand, predictedScoreRange, fatalIssues, defects, and checks. Do not return band or feedback. Do not wrap the object in response, result, data, output, or Markdown. Use integer scores, arrays for fatalIssues/defects, and all six check keys. Assess every value independently; the outputContract contains type descriptions, not suggested scores.";
    return [{ role: "system", content: `Independently assess the candidate. A pass requires band 5, no fatal issue, and the task's band-five score range. ${contract} ${jsonOnly}` }, { role: "user", content: JSON.stringify({ ...payload, outputContract }) }];
  }
  if (task === WritingAiTask.SCORE) return [{ role: "system", content: `Score only the supplied verified essay under the supplied rubric. Diagnostics do not mechanically determine the final score. ${jsonOnly}` }, { role: "user", content: JSON.stringify(payload) }];
  return [{ role: "system", content: jsonOnly }, { role: "user", content: JSON.stringify(payload) }];
}
