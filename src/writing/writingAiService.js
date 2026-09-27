import { callAi as callProviderAi, getAiApiConfig, getAiApiKey, resolveAiModel } from "../ai.js";
import { createAiRequestLifecycle, aiRequestContext } from "../aiRequestLifecycle.js";
import { classifyAiError } from "../aiError.js";
import { computeWritingFingerprint } from "./writingRepository.js";
import { WritingAiTask, WRITING_AI_PROMPT_VERSIONS, buildCompareDiagnosisPayload, buildReferenceRewritePayload, buildSampleGenerationPayload, buildScorePayload, buildWritingAiFormatRepairPayload, buildWritingAiMessages, validateSampleCandidateDeterministically } from "./writingAiTasks.js";
import { WritingAiSchemaError, parseWritingAiJson, validateCompareDiagnosis, validateReferenceRewrite, validateSampleCandidate, validateSampleQualityReport, validateScorePayload } from "./writingAiSchemas.js";
import { isBandFiveScoreConsistent, writingRubricFor } from "./writingRubrics.js";
import { WRITING_SCHEMA_VERSION, WritingAiArtifactType, WritingAttemptStatus, WritingAttemptType, WritingStage } from "./writingModels.js";

export class WritingAiServiceError extends Error { constructor(code, message, cause = null, metadata = {}) { super(message); this.name = "WritingAiServiceError"; this.code = code; this.cause = cause; Object.assign(this, metadata); } }
function errorCode(reason) {
  if (reason instanceof WritingAiSchemaError) return "invalid_response";
  if (["auth_error", "rate_limit", "network_error", "timeout", "provider_error", "model_unavailable", "invalid_response", "text_ai_not_configured"].includes(reason?.code)) return reason.code;
  const status = Number(reason?.status);
  const message = String(reason?.message || "");
  if ((status === 400 || status === 404) && /(?:model.{0,40}(?:not found|not exist|invalid|unsupported|unavailable)|unknown model)/i.test(message)) return "model_unavailable";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_error";
  const category = classifyAiError(reason).category;
  return ({ auth: "auth_error", "rate-limit": "rate_limit", network: "network_error", timeout: "timeout", server: "provider_error", "invalid-response": "invalid_response" })[category] || "provider_error";
}
function contextFor({ sessionId, stageId, targetId, taskType }) { return aiRequestContext({ resourceId: `writing:${sessionId}`, passageId: stageId, questionId: targetId, type: taskType }); }
function required(value, name) { const result = String(value || "").trim(); if (!result) throw new WritingAiServiceError("invalid_input", `${name} is required`); return result; }
function same(value, expected) { return value === expected; }
function snapshotRecord(record) { return { fingerprint: record?.fingerprint || null, verifiedFingerprint: record?.verifiedText?.fingerprint || null }; }
function snapshotMatches(left, right) { return same(left?.fingerprint, right?.fingerprint) && same(left?.verifiedFingerprint, right?.verifiedFingerprint); }
function requestStage(taskType, targetId) { if (String(targetId || "").endsWith(":format-repair")) return "format_repair"; if (taskType === WritingAiTask.SAMPLE_GENERATE) return "generator"; if (taskType === WritingAiTask.SAMPLE_CRITIC) return "critic"; return "provider"; }
function promptVersionFor(taskType) { return ({ [WritingAiTask.SAMPLE_GENERATE]: WRITING_AI_PROMPT_VERSIONS.sampleGenerator, [WritingAiTask.SAMPLE_CRITIC]: WRITING_AI_PROMPT_VERSIONS.sampleCritic, [WritingAiTask.COMPARE_DIAGNOSIS]: WRITING_AI_PROMPT_VERSIONS.compareDiagnosis, [WritingAiTask.SCORE]: WRITING_AI_PROMPT_VERSIONS.score, [WritingAiTask.REFERENCE_REWRITE]: WRITING_AI_PROMPT_VERSIONS.referenceRewrite })[taskType] || ""; }

export function createScoreReportCandidate({ scoreReportId, username, sessionId, sourceAttempt, promptSnapshot, result, lineage, createdAt = Date.now() } = {}) {
  const rubric = writingRubricFor(promptSnapshot?.taskType); if (!sourceAttempt?.verifiedText?.fingerprint) throw new TypeError("ScoreReport requires persisted verifiedText lineage");
  return { schemaVersion: WRITING_SCHEMA_VERSION, scoreReportId, username, sessionId, sourceAttemptId: sourceAttempt.attemptId, sourceTextFingerprint: sourceAttempt.verifiedText.fingerprint, taskType: rubric.taskType, rubricVersion: rubric.rubricVersion, promptVersion: lineage?.promptVersion || WRITING_AI_PROMPT_VERSIONS.score, provider: lineage?.provider, modelId: lineage?.modelId, maxScore: rubric.maxScore, ...result, handwritingAssessed: false, createdAt };
}
export function createWritingAiArtifactCandidate({ artifactId, username, sessionId, sourceAttemptId, artifactType, result, lineage, createdAt = Date.now() } = {}) {
  if (!Object.values(WritingAiArtifactType).includes(artifactType)) throw new TypeError("Unsupported Writing AI artifact type"); return { schemaVersion: WRITING_SCHEMA_VERSION, artifactId, username, sessionId, sourceAttemptId, artifactType, provider: lineage?.provider, modelId: lineage?.modelId, promptVersion: lineage?.promptVersion, payloadVersion: lineage?.promptVersion, result, createdAt };
}
// Vision is intentionally untouched in this Text-AI-only completion fix.
export function createTranscriptionCandidate({ transcriptionId, username, sessionId, sourceAttemptId, sourceInkRef, result, provider, modelId, createdAt = Date.now() } = {}) {
  if (!sourceInkRef?.fingerprint) throw new TypeError("Transcription requires sourceInkRef lineage"); return { schemaVersion: WRITING_SCHEMA_VERSION, transcriptionId, username, sessionId, sourceAttemptId, sourceInkRef, sourceInkFingerprint: sourceInkRef.fingerprint, provider, modelId, promptVersion: result?.promptVersion || WRITING_AI_PROMPT_VERSIONS.transcription, adapterVersion: result?.adapterVersion || WRITING_AI_PROMPT_VERSIONS.visionOpenAi, rawTranscript: result?.rawTranscript, segments: result?.pages || null, requestMetadata: { pageOrder: result?.pageOrder || [] }, createdAt };
}

export function createWritingAiService({ callAi = callProviderAi, getApiKey = getAiApiKey, getApiConfig = getAiApiConfig, getModel = resolveAiModel, lifecycle = createAiRequestLifecycle(), now = () => Date.now(), repository = null, getCurrentUsername = null } = {}) {
  const inFlight = new Map();
  async function textConfiguration() {
    const apiKey = String(await getApiKey() || "").trim();
    const baseUrl = String(getApiConfig()?.baseUrl || "").trim();
    const modelId = String(getModel(WritingAiTask.SAMPLE_GENERATE) || "").trim();
    return { apiKey, baseUrl, modelId };
  }
  function assertTextConfiguration(config) {
    if (!config.apiKey || !config.baseUrl || !config.modelId) {
      throw new WritingAiServiceError("text_ai_not_configured", "Text AI baseUrl, API key, and model are required");
    }
  }
  async function invoke({ taskType, payload, sessionId, stageId, targetId, signal = null, temperature = null }) {
    // Formal Writing tasks use immutable source snapshots for staleness. They
    // must not share the UI lifecycle's location-level replacement semantics:
    // different score/artifact identities are explicitly allowed in parallel.
    const controller = new AbortController(); const bridge = () => controller.abort(); if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener("abort", bridge, { once: true }); }
    const requestId = lifecycle.nextRequestId(); let config = null;
    try { config = { apiKey: String(await getApiKey() || "").trim(), baseUrl: String(getApiConfig()?.baseUrl || "").trim(), modelId: String(getModel(taskType) || "").trim() }; assertTextConfiguration(config); const response = await callAi({ apiKey: config.apiKey, model: config.modelId, messages: buildWritingAiMessages(taskType, payload), temperature: temperature ?? (taskType === WritingAiTask.SAMPLE_GENERATE ? 0.5 : 0.1), taskType, signal: controller.signal }); return { raw: String(response?.content || ""), provider: config.baseUrl, modelId: config.modelId, requestId, createdAt: now() }; }
    catch (reason) { if (reason instanceof WritingAiServiceError) throw reason; throw new WritingAiServiceError(signal?.aborted ? "abort" : errorCode(reason), "Writing AI request failed", reason, { requestStage: requestStage(taskType, targetId), provider: config?.baseUrl || "", modelId: config?.modelId || "", taskId: taskType, promptVersion: promptVersionFor(taskType) }); }
    finally { if (signal) signal.removeEventListener("abort", bridge); }
  }
  async function invokeValidated(detail, validate) {
    const first = await invoke(detail);
    try { return { value: validate(parseWritingAiJson(first.raw)), lineage: first }; }
    catch (reason) {
      if (!(reason instanceof WritingAiSchemaError)) throw reason;
      const repaired = await invoke({ ...detail, payload: buildWritingAiFormatRepairPayload({ taskType: detail.taskType, originalPayload: detail.payload, invalidResponse: first.raw }), targetId: `${detail.targetId}:format-repair`, temperature: 0.1 });
      try { return { value: validate(parseWritingAiJson(repaired.raw)), lineage: repaired, repaired: true }; }
      catch (repairReason) {
        if (!(repairReason instanceof WritingAiSchemaError)) throw repairReason;
        throw new WritingAiServiceError("invalid_response", "Writing AI format repair failed validation", repairReason, { requestStage: "format_repair", provider: repaired.provider, modelId: repaired.modelId, taskId: detail.taskType, promptVersion: promptVersionFor(detail.taskType) });
      }
    }
  }
  async function identity() { if (!repository || typeof getCurrentUsername !== "function") throw new WritingAiServiceError("configuration", "Formal Writing AI requires repository and getCurrentUsername"); return required(await getCurrentUsername(), "current username"); }
  async function loadSession(username, sessionId) { const session = await repository.readSession(sessionId); if (!session || session.username !== username) throw new WritingAiServiceError("lineage_mismatch", "Session is missing or belongs to another account"); return session; }
  async function loadAttempt(username, sessionId, attemptId) { const attempt = await repository.readAttempt(attemptId); if (!attempt || attempt.username !== username || attempt.sessionId !== sessionId) throw new WritingAiServiceError("lineage_mismatch", "Attempt is missing or does not belong to this session"); return attempt; }
  function submittedVerified(attempt, label) { if (attempt.status !== WritingAttemptStatus.SUBMITTED || !attempt.verifiedText?.text || !attempt.verifiedText?.fingerprint) throw new WritingAiServiceError("lineage_mismatch", `${label} requires submitted verified text`); return attempt; }
  async function settled(username, entries) { if (await identity() !== username) throw new WritingAiServiceError("stale", "Writing AI response became stale after account switch"); for (const entry of entries) { const next = await entry.read(); if (!snapshotMatches(snapshotRecord(next), entry.snapshot)) throw new WritingAiServiceError("stale", "Writing AI response became stale after source data changed"); } }
  function dedupe(key, work) { if (inFlight.has(key)) return inFlight.get(key); const pending = Promise.resolve().then(work); inFlight.set(key, pending); pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); }).catch(() => {}); return pending; }
  function samplePass(report, taskType) { return report.pass === true && report.predictedBand === 5 && report.fatalIssues.length === 0 && isBandFiveScoreConsistent(taskType, report.predictedScoreRange.min) && isBandFiveScoreConsistent(taskType, report.predictedScoreRange.max); }

  return Object.freeze({
    setActiveContext(detail) { return lifecycle.setActiveContext(contextFor(detail)); }, lifecycle,
    async getConfigurationStatus() {
      const config = await textConfiguration();
      return { apiKeyConfigured: Boolean(config.apiKey), baseUrlConfigured: Boolean(config.baseUrl), modelConfigured: Boolean(config.modelId), baseUrl: config.baseUrl, modelId: config.modelId };
    },
    async probeTextCapability({ signal = null } = {}) {
      const config = await textConfiguration();
      assertTextConfiguration(config);
      try {
        const response = await callAi({ apiKey: config.apiKey, model: config.modelId, messages: [{ role: "user", content: "Return exactly: OK" }], temperature: 0, timeoutMs: 15000, taskType: "writing.text.probe.v1", signal });
        if (String(response?.content || "").trim() !== "OK") throw new WritingAiSchemaError("Text AI probe returned an invalid response");
        return { status: "supported", baseUrl: config.baseUrl, modelId: config.modelId };
      } catch (reason) {
        if (reason instanceof WritingAiServiceError) throw reason;
        throw new WritingAiServiceError(signal?.aborted ? "abort" : errorCode(reason), "Text AI capability probe failed", reason, { requestStage: "preflight", provider: config.baseUrl, modelId: config.modelId, taskId: "writing.text.probe.v1", promptVersion: "writing-text-probe-v1" });
      }
    },
    async generateSample({ promptSnapshot, requiredContentPoints, sessionId, stageId = "W1_SAMPLE_READING", targetId = "sample", sampleEssayId = null }) {
      const generation = buildSampleGenerationPayload({ promptSnapshot, requiredContentPoints });
      for (let candidateNumber = 1; candidateNumber <= 3; candidateNumber += 1) {
        const generated = await invokeValidated({ taskType: WritingAiTask.SAMPLE_GENERATE, payload: generation, sessionId, stageId, targetId: `${targetId}:${candidateNumber}` }, validateSampleCandidate); const candidate = generated.value; const deterministic = validateSampleCandidateDeterministically(candidate, { taskType: promptSnapshot.taskType, promptFingerprint: promptSnapshot.fingerprint }); if (!deterministic.pass) continue;
        const criticPayload = { candidate, promptSnapshot: { fingerprint: promptSnapshot.fingerprint, taskType: promptSnapshot.taskType, promptText: promptSnapshot.promptText, directions: promptSnapshot.directions }, deterministic, criticPromptVersion: WRITING_AI_PROMPT_VERSIONS.sampleCritic };
        const criticized = await invokeValidated({ taskType: WritingAiTask.SAMPLE_CRITIC, payload: criticPayload, sessionId, stageId, targetId: `${targetId}:${candidateNumber}:critic` }, (value) => validateSampleQualityReport(value, { taskType: promptSnapshot.taskType })); const qualityReport = criticized.value; if (!samplePass(qualityReport, promptSnapshot.taskType)) continue;
        const qualityReportFingerprint = await computeWritingFingerprint(qualityReport); const sampleEssaySnapshot = { essayId: sampleEssayId || `ai-sample:${promptSnapshot.fingerprint}`, sourceType: "ai_generated", text: candidate.essayText, wordCount: deterministic.wordCount, segments: candidate.segments, qualityStatus: "passed", generatorProvider: generated.lineage.provider, generatorModelId: generated.lineage.modelId, criticProvider: criticized.lineage.provider, criticModelId: criticized.lineage.modelId, generatorPromptVersion: WRITING_AI_PROMPT_VERSIONS.sampleGenerator, criticPromptVersion: WRITING_AI_PROMPT_VERSIONS.sampleCritic, qualityGateVersion: WRITING_AI_PROMPT_VERSIONS.sampleQualityGate, qualityReportFingerprint };
        return { status: "accepted", candidateCount: candidateNumber, candidate, qualityReport, sampleEssaySnapshot };
      }
      return { status: "generation_failed", candidateCount: 3 };
    },
    async diagnoseWritingComparison({ sessionId, backTranslationAttemptId, artifactId }) {
      const username = await identity(); const session = await loadSession(username, sessionId); const attempt = await loadAttempt(username, sessionId, backTranslationAttemptId); submittedVerified(attempt, "Compare diagnosis"); if (attempt.attemptType !== WritingAttemptType.BACK_TRANSLATION || attempt.stageId !== WritingStage.W3_BACK_TRANSLATION) throw new WritingAiServiceError("lineage_mismatch", "Compare diagnosis requires a W3 back-translation Attempt"); const snapshotId = required(attempt.context?.translationSnapshotId, "translationSnapshotId"); const translationSnapshot = await repository.readTranslationSnapshot(snapshotId); if (!translationSnapshot || translationSnapshot.username !== username || translationSnapshot.sessionId !== sessionId) throw new WritingAiServiceError("lineage_mismatch", "Translation snapshot is not from this session");
      const baseline = { session: snapshotRecord(session), attempt: snapshotRecord(attempt), translation: snapshotRecord(translationSnapshot) }; const key = ["compare", username, sessionId, backTranslationAttemptId, artifactId, session.fingerprint, attempt.fingerprint, attempt.verifiedText.fingerprint, translationSnapshot.fingerprint].join(":"); return dedupe(key, async () => { const existing = await repository.readAiArtifact(artifactId); if (existing) { if (existing.username === username && existing.sessionId === sessionId && existing.sourceAttemptId === backTranslationAttemptId && existing.artifactType === WritingAiArtifactType.COMPARE_DIAGNOSIS) return existing; throw new WritingAiServiceError("identity_conflict", "artifactId already belongs to a different record"); }
        const payload = buildCompareDiagnosisPayload({ sampleEssaySnapshot: session.sampleEssaySnapshot, translationSnapshot, sourceAttempt: attempt }); const answer = await invokeValidated({ taskType: WritingAiTask.COMPARE_DIAGNOSIS, payload, sessionId, stageId: WritingStage.W4_COMPARE_DIAGNOSE, targetId: artifactId }, (value) => validateCompareDiagnosis(value, { sampleEssaySnapshot: session.sampleEssaySnapshot, verifiedText: attempt.verifiedText.text })); await settled(username, [{ read: () => repository.readSession(sessionId), snapshot: baseline.session }, { read: () => repository.readAttempt(backTranslationAttemptId), snapshot: baseline.attempt }, { read: () => repository.readTranslationSnapshot(snapshotId), snapshot: baseline.translation }]); return repository.createAiArtifact(createWritingAiArtifactCandidate({ artifactId, username, sessionId, sourceAttemptId: backTranslationAttemptId, artifactType: WritingAiArtifactType.COMPARE_DIAGNOSIS, result: answer.value, lineage: { provider: answer.lineage.provider, modelId: answer.lineage.modelId, promptVersion: WRITING_AI_PROMPT_VERSIONS.compareDiagnosis }, createdAt: now() })); });
    },
    async scoreWritingAttempt({ sessionId, attemptId, scoreReportId }) {
      const username = await identity(); const session = await loadSession(username, sessionId); const attempt = submittedVerified(await loadAttempt(username, sessionId, attemptId), "Formal score"); const rubric = writingRubricFor(session.promptSnapshot.taskType); const baseline = { session: snapshotRecord(session), attempt: snapshotRecord(attempt) }; const key = ["score", username, sessionId, attemptId, scoreReportId, session.fingerprint, attempt.fingerprint, attempt.verifiedText.fingerprint].join(":"); return dedupe(key, async () => { const existing = await repository.readScoreReport(scoreReportId); if (existing) { if (existing.username === username && existing.sessionId === sessionId && existing.sourceAttemptId === attemptId && existing.sourceTextFingerprint === attempt.verifiedText.fingerprint) return existing; throw new WritingAiServiceError("identity_conflict", "scoreReportId already belongs to a different record"); }
        const payload = buildScorePayload({ promptSnapshot: session.promptSnapshot, sourceAttempt: attempt, rubricVersion: rubric.rubricVersion }); const answer = await invokeValidated({ taskType: WritingAiTask.SCORE, payload, sessionId, stageId: WritingStage.W8_SCORE_REWRITE, targetId: scoreReportId }, (value) => validateScorePayload(value, { taskType: session.promptSnapshot.taskType, verifiedText: attempt.verifiedText.text })); await settled(username, [{ read: () => repository.readSession(sessionId), snapshot: baseline.session }, { read: () => repository.readAttempt(attemptId), snapshot: baseline.attempt }]); return repository.createScoreReport(createScoreReportCandidate({ scoreReportId, username, sessionId, sourceAttempt: attempt, promptSnapshot: session.promptSnapshot, result: answer.value, lineage: { provider: answer.lineage.provider, modelId: answer.lineage.modelId, promptVersion: WRITING_AI_PROMPT_VERSIONS.score }, createdAt: now() })); });
    },
    async generateReferenceRewrite({ sessionId, revisionAttemptId, scoreReportId, artifactId }) {
      const username = await identity(); const session = await loadSession(username, sessionId); const revision = submittedVerified(await loadAttempt(username, sessionId, revisionAttemptId), "Reference rewrite"); if (revision.attemptType !== WritingAttemptType.REVISION || revision.stageId !== WritingStage.W8_SCORE_REWRITE || !revision.parentAttemptId) throw new WritingAiServiceError("lineage_mismatch", "Reference rewrite requires a submitted revision with a parent"); const parent = submittedVerified(await loadAttempt(username, sessionId, revision.parentAttemptId), "Reference rewrite parent"); if (parent.attemptType !== WritingAttemptType.INDEPENDENT) throw new WritingAiServiceError("lineage_mismatch", "Reference rewrite parent must be independent writing"); const scoreReport = await repository.readScoreReport(scoreReportId); if (!scoreReport || scoreReport.username !== username || scoreReport.sessionId !== sessionId || scoreReport.sourceAttemptId !== parent.attemptId || scoreReport.sourceTextFingerprint !== parent.verifiedText.fingerprint) throw new WritingAiServiceError("lineage_mismatch", "Score report does not belong to the independent parent text");
      const baseline = { session: snapshotRecord(session), revision: snapshotRecord(revision), parent: snapshotRecord(parent), score: snapshotRecord(scoreReport) }; const key = ["rewrite", username, sessionId, revisionAttemptId, scoreReportId, artifactId, session.fingerprint, revision.fingerprint, revision.verifiedText.fingerprint, parent.fingerprint, parent.verifiedText.fingerprint, scoreReport.fingerprint].join(":"); return dedupe(key, async () => { const existing = await repository.readAiArtifact(artifactId); if (existing) { if (existing.username === username && existing.sessionId === sessionId && existing.sourceAttemptId === revisionAttemptId && existing.artifactType === WritingAiArtifactType.REFERENCE_REWRITE) return existing; throw new WritingAiServiceError("identity_conflict", "artifactId already belongs to a different record"); }
        const payload = buildReferenceRewritePayload({ promptSnapshot: session.promptSnapshot, revisionAttempt: revision, scoreReport }); const answer = await invokeValidated({ taskType: WritingAiTask.REFERENCE_REWRITE, payload, sessionId, stageId: WritingStage.W8_SCORE_REWRITE, targetId: artifactId }, validateReferenceRewrite); await settled(username, [{ read: () => repository.readSession(sessionId), snapshot: baseline.session }, { read: () => repository.readAttempt(revisionAttemptId), snapshot: baseline.revision }, { read: () => repository.readAttempt(parent.attemptId), snapshot: baseline.parent }, { read: () => repository.readScoreReport(scoreReportId), snapshot: baseline.score }]); return repository.createAiArtifact(createWritingAiArtifactCandidate({ artifactId, username, sessionId, sourceAttemptId: revisionAttemptId, artifactType: WritingAiArtifactType.REFERENCE_REWRITE, result: answer.value, lineage: { provider: answer.lineage.provider, modelId: answer.lineage.modelId, promptVersion: WRITING_AI_PROMPT_VERSIONS.referenceRewrite }, createdAt: now() })); });
    },
  });
}
