import { aiRequestContext, createAiRequestLifecycle } from "../aiRequestLifecycle.js";
import { getCurrentUsername as readCurrentUsername } from "../userData.js";
import { WritingAttemptStatus, WritingAttemptType, WritingStage, WRITING_SCHEMA_VERSION } from "./writingModels.js";
import { WRITING_AI_PROMPT_VERSIONS, WritingAiTask } from "./writingAiTasks.js";
import { computeWritingFingerprint } from "./writingRepository.js";
import { getWritingInkSnapshot } from "./writingInkStorage.js";
import { transcribeWritingInkSnapshot } from "./writingVisionAdapter.js";
import {
  getWritingVisionApiKey,
  getWritingVisionConfig,
  getWritingVisionModel,
} from "./writingVisionConfig.js";
import { createOpenAiCompatibleVisionProvider } from "./writingVisionProvider.js";

const EXACT_INK_FIELDS = Object.freeze([
  "id",
  "surfaceId",
  "ownerRecordId",
  "stageId",
  "revision",
  "fingerprint",
  "sourceFingerprint",
]);

export class WritingVisionServiceError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "WritingVisionServiceError";
    this.code = code;
    this.category = cause?.category || cause?.code || code;
  }
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new WritingVisionServiceError("invalid_input", `${name} is required`);
  return text;
}

function attemptContract(attempt) {
  if (attempt?.attemptType === WritingAttemptType.BACK_TRANSLATION && attempt.stageId === WritingStage.W3_BACK_TRANSLATION) return true;
  if (attempt?.attemptType === WritingAttemptType.INDEPENDENT && attempt.stageId === WritingStage.W7_INDEPENDENT) return true;
  return false;
}

function sameInk(left, right) {
  return Boolean(left && right) && EXACT_INK_FIELDS.every((field) => left[field] === right[field]);
}

function expectedSurface(attempt) {
  return attempt.attemptType === WritingAttemptType.BACK_TRANSLATION
    ? `w3:back:${attempt.attemptId}`
    : `w7:independent:${attempt.attemptId}`;
}

function assertAttemptAndInk(attempt, ink, { username, sessionId, settle = false } = {}) {
  const code = settle ? "stale" : "source_mismatch";
  if (!attemptContract(attempt)) throw new WritingVisionServiceError(code, "Vision transcription only supports W3/W7 Attempt-backed handwriting");
  if (![WritingAttemptStatus.RAW_SUBMITTED, WritingAttemptStatus.VERIFYING].includes(attempt.status) || !attempt.inkRef) {
    throw new WritingVisionServiceError(code, "Attempt must be raw_submitted or verifying with exact InkRef");
  }
  if (attempt.username !== username || attempt.sessionId !== sessionId) throw new WritingVisionServiceError(code, "Attempt account/session lineage does not match");
  if (attempt.inkRef.ownerRecordId !== attempt.attemptId || attempt.inkRef.surfaceId !== expectedSurface(attempt) || attempt.inkRef.stageId !== attempt.stageId) {
    throw new WritingVisionServiceError(code, "Attempt InkRef identity does not match its formal surface");
  }
  if (!sameInk(attempt.inkRef, ink) || ink.username !== username || ink.sessionId !== sessionId) {
    throw new WritingVisionServiceError(code, "Persisted WritingInkSnapshot no longer matches Attempt.inkRef");
  }
}

function requestIdentity({ username, sessionId, attempt, config, modelId, requestContextFingerprint }) {
  return {
    username,
    sessionId,
    sourceAttemptId: attempt.attemptId,
    sourceInkRef: Object.fromEntries(EXACT_INK_FIELDS.map((field) => [field, attempt.inkRef[field]])),
    providerKind: config.providerKind,
    baseUrlIdentity: config.baseUrl,
    provider: config.providerKind,
    modelId,
    taskId: WritingAiTask.VISION_TRANSCRIBE,
    promptVersion: WRITING_AI_PROMPT_VERSIONS.transcription,
    adapterVersion: WRITING_AI_PROMPT_VERSIONS.visionOpenAi,
    renderVersion: WRITING_AI_PROMPT_VERSIONS.visionRender,
    requestContextFingerprint,
  };
}

function recordMatches(record, identity) {
  const metadata = record?.requestMetadata || {};
  return record?.username === identity.username
    && record?.sessionId === identity.sessionId
    && record?.sourceAttemptId === identity.sourceAttemptId
    && sameInk(record?.sourceInkRef, identity.sourceInkRef)
    && record?.sourceInkFingerprint === identity.sourceInkRef.fingerprint
    && record?.provider === identity.provider
    && record?.modelId === identity.modelId
    && record?.promptVersion === identity.promptVersion
    && record?.adapterVersion === identity.adapterVersion
    && metadata.taskId === identity.taskId
    && metadata.providerKind === identity.providerKind
    && metadata.baseUrlIdentity === identity.baseUrlIdentity
    && metadata.renderVersion === identity.renderVersion;
}

function serviceCode(error, signal) {
  if (signal?.aborted) return "abort";
  const code = error?.code || error?.category;
  if (["auth_error", "rate_limit", "network_error", "timeout", "provider_error", "unsupported", "invalid_response", "abort", "stale", "source_mismatch", "vision_not_configured", "VISION_RENDER_ERROR"].includes(code)) return code;
  return "provider_error";
}

export function createWritingVisionService({
  repository,
  getCurrentUsername = readCurrentUsername,
  getInkSnapshot = getWritingInkSnapshot,
  getConfig = getWritingVisionConfig,
  getModel = getWritingVisionModel,
  getApiKey = getWritingVisionApiKey,
  provider = createOpenAiCompatibleVisionProvider(),
  transcribeSnapshot = transcribeWritingInkSnapshot,
  lifecycle = createAiRequestLifecycle(),
  now = () => Date.now(),
} = {}) {
  if (!repository) throw new TypeError("repository is required");
  const inFlight = new Map();

  async function readSource(username, sessionId, attemptId, { settle = false } = {}) {
    const session = await repository.readSession(sessionId);
    const attempt = await repository.readAttempt(attemptId);
    if (!session || session.username !== username || !attempt) throw new WritingVisionServiceError(settle ? "stale" : "source_mismatch", "Writing Session/Attempt is missing or belongs to another account");
    const code = settle ? "stale" : "source_mismatch";
    if (!attemptContract(attempt) || ![WritingAttemptStatus.RAW_SUBMITTED, WritingAttemptStatus.VERIFYING].includes(attempt.status) || !attempt.inkRef) throw new WritingVisionServiceError(code, "Attempt is not awaiting W3/W7 handwriting transcription");
    let read;
    try { read = await getInkSnapshot({ username, sessionId, surfaceId: attempt.inkRef.surfaceId, expectedSourceFingerprint: attempt.inkRef.sourceFingerprint }); }
    catch (cause) { throw new WritingVisionServiceError(code, "Writing ink read failed", cause); }
    if (read?.status !== "ok" || !read.snapshot) throw new WritingVisionServiceError(settle ? "stale" : "source_mismatch", `Writing ink read failed: ${read?.status || "missing"}`);
    assertAttemptAndInk(attempt, read.snapshot, { username, sessionId, settle });
    return { session, attempt, ink: read.snapshot };
  }

  async function findReusable(identity, transcriptionId) {
    const existing = await repository.readTranscription(transcriptionId);
    if (existing) {
      if (recordMatches(existing, identity)) return existing;
      throw new WritingVisionServiceError("identity_conflict", "transcriptionId already belongs to a different formal target");
    }
    if (typeof repository.listTranscriptions !== "function") return null;
    const records = await repository.listTranscriptions();
    return records.find((record) => !record?.damaged && recordMatches(record, identity)) || null;
  }

  async function transcribeWritingAttempt({ sessionId, attemptId, transcriptionId, signal = null } = {}) {
    const requestedSessionId = required(sessionId, "sessionId");
    const requestedAttemptId = required(attemptId, "attemptId");
    const requestedTranscriptionId = required(transcriptionId, "transcriptionId");
    const username = required(await getCurrentUsername(), "current username");
    if (repository.username && repository.username !== username) throw new WritingVisionServiceError("source_mismatch", "Current account does not match WritingRepository");
    const source = await readSource(username, requestedSessionId, requestedAttemptId);
    const config = getConfig();
    const modelId = String(getModel() || "").trim();
    const apiKey = String(await getApiKey({ username }) || "").trim();
    if (!config?.baseUrl || !modelId || !apiKey) throw new WritingVisionServiceError("vision_not_configured", "Vision baseUrl, model, and API key are required");
    const requestContextFingerprint = await computeWritingFingerprint({
      sessionFingerprint: source.session.fingerprint,
      attemptFingerprint: source.attempt.fingerprint,
      sourceInkFingerprint: source.ink.fingerprint,
    });
    const identity = requestIdentity({ username, sessionId: requestedSessionId, attempt: source.attempt, config, modelId, requestContextFingerprint });
    const reusable = await findReusable(identity, requestedTranscriptionId);
    if (reusable) return reusable;
    const key = await computeWritingFingerprint(identity);
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = (async () => {
      const requestId = lifecycle.nextRequestId();
      const context = aiRequestContext({ resourceId: `writing:${requestedSessionId}`, passageId: source.attempt.stageId, questionId: requestedAttemptId, type: WritingAiTask.VISION_TRANSCRIBE });
      void requestId; void context;
      let result;
      try {
        result = await transcribeSnapshot({ snapshot: source.ink, provider, config, apiKey, modelId, signal });
      } catch (error) {
        throw new WritingVisionServiceError(serviceCode(error, signal), "Writing Vision transcription failed", error);
      }
      if (signal?.aborted) throw new WritingVisionServiceError("abort", "Writing Vision request was aborted");
      const settleUsername = required(await getCurrentUsername(), "current username");
      if (settleUsername !== username) throw new WritingVisionServiceError("stale", "Writing Vision response became stale after account switch");
      const settled = await readSource(username, requestedSessionId, requestedAttemptId, { settle: true });
      const settledConfig = getConfig();
      const settledModel = getModel();
      if (settled.session.fingerprint !== source.session.fingerprint
        || settled.attempt.fingerprint !== source.attempt.fingerprint
        || settled.ink.fingerprint !== source.ink.fingerprint
        || settledConfig.providerKind !== config.providerKind
        || settledConfig.baseUrl !== config.baseUrl
        || settledModel !== modelId) {
        throw new WritingVisionServiceError("stale", "Writing Vision response became stale after source/config change");
      }
      if (result.promptVersion !== identity.promptVersion || result.adapterVersion !== identity.adapterVersion || result.renderVersion !== identity.renderVersion) {
        throw new WritingVisionServiceError("stale", "Writing Vision implementation version changed during request");
      }
      const candidate = {
        schemaVersion: WRITING_SCHEMA_VERSION,
        transcriptionId: requestedTranscriptionId,
        sessionId: requestedSessionId,
        username,
        sourceAttemptId: requestedAttemptId,
        sourceInkRef: { ...source.attempt.inkRef },
        sourceInkFingerprint: source.attempt.inkRef.fingerprint,
        rawTranscript: result.rawTranscript,
        segments: result.pages,
        provider: identity.provider,
        modelId,
        promptVersion: identity.promptVersion,
        adapterVersion: identity.adapterVersion,
        requestMetadata: {
          taskId: identity.taskId,
          pageOrder: result.pageOrder,
          renderVersion: identity.renderVersion,
          providerKind: identity.providerKind,
          baseUrlIdentity: identity.baseUrlIdentity,
          sourceInkFingerprint: identity.sourceInkRef.fingerprint,
          requestContextFingerprint,
        },
        createdAt: now(),
      };
      const saved = await repository.createTranscription(candidate);
      const verified = await repository.readTranscription(saved.transcriptionId);
      if (!verified || verified.fingerprint !== saved.fingerprint) throw new WritingVisionServiceError("persistence_error", "TranscriptionRecord post-write verification failed");
      return verified;
    })();
    inFlight.set(key, pending);
    pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); }).catch(() => {});
    return pending;
  }

  return Object.freeze({ transcribeWritingAttempt });
}
