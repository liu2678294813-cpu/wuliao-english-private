import { AppEvent } from "../events/eventTypes.js";
import { emitAppEvent } from "../events/appEvents.js";
import { getCurrentUsername as readCurrentUsername } from "../userData.js";
import { resolveSafeWritingStage } from "./writingDomain.js";
import {
  WRITING_SCHEMA_VERSION,
  WRITING_STAGES,
  WritingAttemptStatus,
  WritingAttemptType,
  WritingDraftStatus,
  WritingInputMethod,
  WritingReconstructionOutcome,
  WritingSessionStatus,
  WritingSkeletonOutcome,
  WritingStage,
  WritingVerifiedTextSource,
} from "./writingModels.js";
import {
  WritingAccountMismatchError,
  WritingConflictError,
  assertScoreReportLineage,
  assertTranslationSnapshotLineage,
  canonicalWritingJson,
  createVerifiedText,
} from "./writingRepository.js";

const HANDWRITTEN_INPUTS = new Set([WritingInputMethod.HANDWRITING, WritingInputMethod.MIXED]);
const SERIALIZED_COMMANDS = Object.freeze([
  "startWritingSession",
  "completeReadingAndEnterW2",
  "saveTranslationDraft",
  "saveSkeletonDraft",
  "saveAttemptDraft",
  "commitTranslationAndEnterW3",
  "submitBackTranslationAndEnterW4",
  "prepareBackTranslationHandwritingForVerification",
  "submitBackTranslationHandwritingAndEnterW4",
  "attachTranscriptionForVerification",
  "completeCompareAndEnterW5",
  "finishOrSkipSkeleton",
  "finishOrSkipReconstruction",
  "submitIndependentTyped",
  "prepareIndependentHandwritingForVerification",
  "submitIndependentHandwriting",
  "submitRevisionAttempt",
  "completeAfterScoreView",
]);

export class WritingCommandError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "WritingCommandError";
    this.code = code;
  }
}

function commandError(code, message, cause) {
  return new WritingCommandError(code, message, cause ? { cause } : undefined);
}

function requiredString(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw commandError("prerequisite-missing", `${name} is required`);
  return normalized;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function comparable(value) {
  const next = clone(value);
  if (next && typeof next === "object") {
    delete next.fingerprint;
    delete next.revision;
  }
  return next;
}

function sameValue(left, right) {
  return canonicalWritingJson(left) === canonicalWritingJson(right);
}

function sameExactInkRef(left, right) {
  return sameValue(left, right);
}

function stageIndex(stage) {
  return WRITING_STAGES.indexOf(stage);
}

function isAtOrPast(stage, target) {
  return stageIndex(stage) >= stageIndex(target);
}

function emptyStageFacts() {
  return {
    w1ReadingCompletedAt: null,
    w4CompareCompletedAt: null,
    w5Outcome: WritingSkeletonOutcome.NOT_REACHED,
    w5EndedAt: null,
    committedSkeletonRevisionId: null,
    w6Outcome: WritingReconstructionOutcome.NOT_REACHED,
    w6EndedAt: null,
    w6AttemptId: null,
    viewedScoreReportIds: [],
    completedByScoreReportId: null,
  };
}

function ensureOwnedIdentity(candidate, { username, sessionId, idField, id }) {
  const next = clone(candidate || {});
  if (next.username !== undefined && next.username !== username) throw new WritingAccountMismatchError();
  if (next.sessionId !== undefined && next.sessionId !== sessionId) {
    throw commandError("lineage-mismatch", `${idField} belongs to another Session`);
  }
  if (next[idField] !== undefined && next[idField] !== id) {
    throw commandError("conflict", `${idField} does not match the requested identity`);
  }
  next.username = username;
  next.sessionId = sessionId;
  next[idField] = id;
  return next;
}

function assertStableRecord(existing, candidate, fields, name) {
  for (const field of fields) {
    if (candidate?.[field] !== undefined && !sameValue(existing?.[field], candidate[field])) {
      throw commandError("conflict", `${name}.${field} conflicts with the persisted record`);
    }
  }
}

function assertRetryUnits(existing, candidate) {
  if (!candidate?.units) return;
  if (!Array.isArray(candidate.units) || candidate.units.length !== existing.units.length) {
    throw commandError("conflict", "Translation units conflict with the committed Revision");
  }
  for (let index = 0; index < existing.units.length; index += 1) {
    const persisted = existing.units[index];
    const requested = candidate.units[index];
    for (const field of ["unitId", "inputMethod", "typedText"]) {
      if (!sameValue(persisted[field], requested[field])) {
        throw commandError("conflict", `Translation unit ${persisted.unitId} conflicts with the committed Revision`);
      }
    }
    if (requested.inkRef !== null && requested.inkRef !== undefined && !sameValue(persisted.inkRef, requested.inkRef)) {
      throw commandError("conflict", `Translation unit ${persisted.unitId} has a conflicting inkRef`);
    }
  }
}

function inputNeedsInk(inputMethod) {
  return HANDWRITTEN_INPUTS.has(inputMethod);
}

function attemptContractForVerification(attempt) {
  return (attempt.attemptType === WritingAttemptType.BACK_TRANSLATION && attempt.stageId === WritingStage.W3_BACK_TRANSLATION)
    || (attempt.attemptType === WritingAttemptType.INDEPENDENT && attempt.stageId === WritingStage.W7_INDEPENDENT);
}

function attemptFromInput({ input, existing, username, sessionId, attemptId, attemptType, stageId, context, time }) {
  const source = ensureOwnedIdentity(input || existing || {}, { username, sessionId, idField: "attemptId", id: attemptId });
  return {
    schemaVersion: WRITING_SCHEMA_VERSION,
    attemptId,
    sessionId,
    username,
    attemptType,
    stageId,
    status: source.status || WritingAttemptStatus.DRAFTING,
    parentAttemptId: source.parentAttemptId ?? null,
    context: clone(context),
    inputMethod: source.inputMethod || WritingInputMethod.TYPED,
    typedText: source.typedText ?? null,
    inkRef: source.inkRef ?? null,
    transcriptionId: source.transcriptionId ?? null,
    verifiedText: source.verifiedText ?? null,
    timing: source.timing ?? null,
    createdAt: source.createdAt ?? time,
    updatedAt: source.updatedAt ?? time,
    rawSubmittedAt: source.rawSubmittedAt ?? null,
    submittedAt: source.submittedAt ?? null,
    revision: source.revision ?? 0,
  };
}

function damagedRows(rows, recordType, diagnostics) {
  return rows.filter((row) => {
    if (!row?.damaged) return true;
    diagnostics.push({ code: "dependent-record-damaged", recordType, id: row.id, errorCode: row.errorCode });
    return false;
  });
}

export class WritingCommandService {
  constructor({
    repository,
    getCurrentUsername = readCurrentUsername,
    now = () => Date.now(),
    flushInk = null,
    emitLearningInvalidated = (payload) => emitAppEvent(AppEvent.LEARNING_STATE_INVALIDATED, payload),
    onStep = null,
  } = {}) {
    if (!repository) throw new TypeError("repository is required");
    this.repository = repository;
    this.getCurrentUsername = getCurrentUsername;
    this.now = now;
    this.flushInk = flushInk;
    this.emitLearningInvalidated = emitLearningInvalidated;
    this.onStep = onStep;
    this.commandQueues = new Map();
    for (const methodName of SERIALIZED_COMMANDS) {
      const implementation = this[methodName].bind(this);
      this[methodName] = (args = {}) => this._enqueue(args?.sessionId || methodName, () => implementation(args));
    }
  }

  async _enqueue(key, action) {
    const previous = this.commandQueues.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.commandQueues.set(key, tail);
    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      release();
      if (this.commandQueues.get(key) === tail) this.commandQueues.delete(key);
    }
  }

  async _step(step, details = {}) {
    if (this.onStep) await this.onStep(step, details);
  }

  _assertAccount() {
    const current = String(this.getCurrentUsername?.() || "").trim();
    if (current !== this.repository.username) {
      throw commandError("account-mismatch", "The active account no longer matches this WritingRepository");
    }
  }

  async _preflight(args, sourceStage, targetStages) {
    this._assertAccount();
    const sessionId = requiredString(args?.sessionId, "sessionId");
    const recovery = await this.inspectWritingRecovery(sessionId);
    const session = recovery.session;
    if (args.sessionFingerprint !== undefined && args.sessionFingerprint !== session.fingerprint) {
      throw commandError("stale-session", "Session fingerprint is stale");
    }
    const expected = args.sessionExpectedRevision;
    if (!Number.isInteger(expected) || expected < 0) {
      throw commandError("stale-session", "sessionExpectedRevision must be a non-negative integer");
    }
    await this._step("preflight", { sessionId, persistedStage: session.currentStage, safeStage: recovery.safeStage });
    return {
      session,
      recovery,
      sourceStage,
      targetStages: Array.isArray(targetStages) ? targetStages : [targetStages],
      expectedMatches: session.revision === expected,
    };
  }

  _requireTransition(preflight, { completed = false } = {}) {
    const { session, recovery, sourceStage, targetStages, expectedMatches } = preflight;
    if (completed) return;
    if (!expectedMatches) throw commandError("stale-session", "Session revision is stale");
    if (session.status !== WritingSessionStatus.ACTIVE) {
      throw commandError("illegal-transition", "Completed Writing history cannot be rewritten");
    }
    if (session.currentStage !== sourceStage) {
      throw commandError("illegal-transition", `Expected ${sourceStage}, found ${session.currentStage}`);
    }
    if (recovery.safeStage !== sourceStage && !targetStages.includes(recovery.safeStage)) {
      const behind = stageIndex(recovery.safeStage) < stageIndex(sourceStage);
      throw commandError(behind ? "prerequisite-missing" : "illegal-transition", `Persisted facts resolve to ${recovery.safeStage}`);
    }
  }

  async _flushInk({ required, ...context }) {
    if (!required) return null;
    if (typeof this.flushInk !== "function") throw commandError("ink-flush-failed", "A Writing ink flush handle is required");
    let inkRef;
    try {
      inkRef = await this.flushInk(context);
    } catch (error) {
      throw commandError("ink-flush-failed", "Writing ink flush failed", error);
    }
    if (!inkRef || typeof inkRef !== "object") throw commandError("ink-flush-failed", "Writing ink flush returned no verified inkRef");
    await this._step("flush", context);
    return clone(inkRef);
  }

  async _readTranscriptionForAttempt(attempt, transcriptionId) {
    const transcription = await this.repository.readTranscription(requiredString(transcriptionId, "transcriptionId"));
    if (!transcription) throw commandError("dependent-record-missing", "TranscriptionRecord does not exist");
    if (transcription.username !== this.repository.username
      || transcription.sessionId !== attempt.sessionId
      || transcription.sourceAttemptId !== attempt.attemptId) {
      throw commandError("lineage-mismatch", "TranscriptionRecord belongs to another account, Session, or Attempt");
    }
    if (!attempt.inkRef || !sameExactInkRef(transcription.sourceInkRef, attempt.inkRef)
      || transcription.sourceInkFingerprint !== attempt.inkRef.fingerprint) {
      throw commandError("lineage-mismatch", "TranscriptionRecord exact InkRef does not match the Attempt");
    }
    return transcription;
  }

  async _emit(session, safeStage) {
    await this.emitLearningInvalidated({
      source: "writing-command",
      username: session.username,
      sessionId: session.sessionId,
      safeStage,
    });
    await this._step("event", { sessionId: session.sessionId, safeStage });
  }

  async _finishExisting(preflight, extra = {}) {
    await this._step("safe-stage", { sessionId: preflight.session.sessionId, safeStage: preflight.recovery.safeStage });
    await this._emit(preflight.session, preflight.recovery.safeStage);
    return { session: preflight.session, safeStage: preflight.recovery.safeStage, recovery: preflight.recovery, ...extra };
  }

  async _saveSessionLast(preflight, nextSession, extra = {}) {
    const saved = await this.repository.saveSession(nextSession, { expectedRevision: preflight.session.revision });
    await this._step("session-save", { sessionId: saved.sessionId, revision: saved.revision });
    const verified = await this.repository.readSession(saved.sessionId);
    if (!verified || verified.fingerprint !== saved.fingerprint) {
      throw commandError("dependent-record-damaged", "Session post-write verification failed");
    }
    await this._step("session-read", { sessionId: verified.sessionId, revision: verified.revision });
    const recovery = await this.inspectWritingRecovery(verified.sessionId);
    await this._step("safe-stage", { sessionId: verified.sessionId, safeStage: recovery.safeStage });
    await this._emit(verified, recovery.safeStage);
    return { session: verified, safeStage: recovery.safeStage, recovery, ...extra };
  }

  async startWritingSession({
    sessionId,
    taskType,
    year = null,
    promptSnapshot,
    sampleEssaySnapshot,
    startedAt,
  } = {}) {
    this._assertAccount();
    const id = requiredString(sessionId, "sessionId");
    const existing = await this.repository.readSession(id);
    await this._step("preflight", { sessionId: id, persistedStage: existing?.currentStage || null });
    if (existing) {
      const sameStart = startedAt === undefined || existing.startedAt === startedAt;
      const sameIdentity = existing.taskType === taskType
        && existing.year === year
        && existing.promptSnapshot.fingerprint === promptSnapshot?.fingerprint
        && existing.sampleEssaySnapshot.fingerprint === sampleEssaySnapshot?.fingerprint
        && sameStart;
      if (!sameIdentity) throw commandError("conflict", "A different Writing Session already uses this sessionId");
      const recovery = await this.inspectWritingRecovery(id);
      return this._finishExisting({ session: existing, recovery });
    }
    const time = startedAt ?? this.now();
    const candidate = {
      schemaVersion: WRITING_SCHEMA_VERSION,
      sessionId: id,
      username: this.repository.username,
      taskType,
      year,
      status: WritingSessionStatus.ACTIVE,
      currentStage: WritingStage.W1_SAMPLE_READING,
      promptSnapshot: clone(promptSnapshot),
      sampleEssaySnapshot: clone(sampleEssaySnapshot),
      stageFacts: emptyStageFacts(),
      createdAt: time,
      startedAt: time,
      lastActiveAt: time,
      updatedAt: time,
      completedAt: null,
      revision: 0,
    };
    const saved = await this.repository.saveSession(candidate, { expectedRevision: 0 });
    await this._step("session-save", { sessionId: id, revision: saved.revision });
    const verified = await this.repository.readSession(id);
    await this._step("session-read", { sessionId: id, revision: verified.revision });
    const recovery = await this.inspectWritingRecovery(id);
    await this._step("safe-stage", { sessionId: id, safeStage: recovery.safeStage });
    await this._emit(verified, recovery.safeStage);
    return { session: verified, safeStage: recovery.safeStage, recovery };
  }

  async completeReadingAndEnterW2(args = {}) {
    const preflight = await this._preflight(args, WritingStage.W1_SAMPLE_READING, WritingStage.W2_EN_ZH);
    const completed = preflight.session.stageFacts.w1ReadingCompletedAt !== null
      && isAtOrPast(preflight.session.currentStage, WritingStage.W2_EN_ZH);
    this._requireTransition(preflight, { completed });
    if (completed) return this._finishExisting(preflight);
    const time = this.now();
    return this._saveSessionLast(preflight, {
      ...preflight.session,
      currentStage: WritingStage.W2_EN_ZH,
      stageFacts: {
        ...preflight.session.stageFacts,
        w1ReadingCompletedAt: preflight.session.stageFacts.w1ReadingCompletedAt ?? time,
      },
      lastActiveAt: time,
      updatedAt: time,
    });
  }

  async saveTranslationDraft(args = {}) {
    const revisionInput = args.translationRevision || args.revision;
    const revisionId = requiredString(args.revisionId || revisionInput?.revisionId, "revisionId");
    const preflight = await this._preflight(args, WritingStage.W2_EN_ZH, WritingStage.W2_EN_ZH);
    this._requireTransition(preflight);
    const existing = await this.repository.readTranslationRevision(revisionId);
    if (existing?.status === WritingDraftStatus.COMMITTED) {
      throw commandError("illegal-transition", "Committed TranslationRevision cannot be edited as a draft");
    }
    const source = ensureOwnedIdentity(revisionInput || existing, {
      username: this.repository.username,
      sessionId: preflight.session.sessionId,
      idField: "revisionId",
      id: revisionId,
    });
    const units = clone(source.units || existing?.units || []);
    const needsInk = units.some((unit) => inputNeedsInk(unit.inputMethod));
    const flushedInkRef = await this._flushInk({
      required: Boolean(args.flushInk && needsInk),
      sessionId: preflight.session.sessionId,
      stageId: WritingStage.W2_EN_ZH,
      ownerRecordId: revisionId,
      surfaceId: `w2:translation:${revisionId}`,
      sourceRecord: existing || source,
    });
    const time = this.now();
    const candidate = {
      ...source,
      schemaVersion: WRITING_SCHEMA_VERSION,
      revisionId,
      sessionId: preflight.session.sessionId,
      username: this.repository.username,
      revisionNumber: source.revisionNumber || existing?.revisionNumber || 1,
      status: WritingDraftStatus.DRAFT,
      basedOnRevisionId: source.basedOnRevisionId ?? existing?.basedOnRevisionId ?? null,
      units: units.map((unit, index) => inputNeedsInk(unit.inputMethod)
        ? { ...unit, inkRef: flushedInkRef || unit.inkRef || existing?.units?.[index]?.inkRef || null }
        : { ...unit, inkRef: null }),
      createdAt: source.createdAt ?? existing?.createdAt ?? time,
      updatedAt: time,
      committedAt: null,
      revision: existing?.revision ?? source.revision ?? 0,
    };
    const saved = await this.repository.saveTranslationRevision(candidate, {
      expectedRevision: args.translationExpectedRevision ?? existing?.revision ?? 0,
    });
    await this._step("fact-save", { kind: "translation-draft", id: revisionId });
    return { session: preflight.session, safeStage: preflight.recovery.safeStage, translationRevision: saved };
  }

  async saveSkeletonDraft(args = {}) {
    const revisionInput = args.skeletonRevision || args.revision;
    const revisionId = requiredString(args.revisionId || revisionInput?.revisionId, "revisionId");
    const preflight = await this._preflight(args, WritingStage.W5_SKELETON, WritingStage.W5_SKELETON);
    this._requireTransition(preflight);
    const existing = await this.repository.readSkeletonRevision(revisionId);
    if (existing?.status === WritingDraftStatus.COMMITTED) {
      throw commandError("illegal-transition", "Committed SkeletonRevision cannot be edited as a draft");
    }
    const source = ensureOwnedIdentity(revisionInput || existing, {
      username: this.repository.username,
      sessionId: preflight.session.sessionId,
      idField: "revisionId",
      id: revisionId,
    });
    const flushedInkRef = await this._flushInk({
      required: Boolean(args.flushInk && args.requiresInk),
      sessionId: preflight.session.sessionId,
      stageId: WritingStage.W5_SKELETON,
      ownerRecordId: revisionId,
      surfaceId: `w5:skeleton:${revisionId}`,
      sourceRecord: existing || source,
    });
    const time = this.now();
    const candidate = {
      ...source,
      schemaVersion: WRITING_SCHEMA_VERSION,
      revisionId,
      sessionId: preflight.session.sessionId,
      username: this.repository.username,
      revisionNumber: source.revisionNumber || existing?.revisionNumber || 1,
      status: WritingDraftStatus.DRAFT,
      basedOnRevisionId: source.basedOnRevisionId ?? existing?.basedOnRevisionId ?? null,
      blocks: clone(source.blocks || []),
      inkRef: flushedInkRef || source.inkRef || existing?.inkRef || null,
      createdAt: source.createdAt ?? existing?.createdAt ?? time,
      updatedAt: time,
      committedAt: null,
      revision: existing?.revision ?? source.revision ?? 0,
    };
    const saved = await this.repository.saveSkeletonRevision(candidate, {
      expectedRevision: args.skeletonExpectedRevision ?? existing?.revision ?? 0,
    });
    await this._step("fact-save", { kind: "skeleton-draft", id: revisionId });
    return { session: preflight.session, safeStage: preflight.recovery.safeStage, skeletonRevision: saved };
  }

  async saveAttemptDraft(args = {}) {
    const stageId = args.stageId;
    const contracts = {
      [WritingStage.W3_BACK_TRANSLATION]: WritingAttemptType.BACK_TRANSLATION,
      [WritingStage.W6_RECONSTRUCTION]: WritingAttemptType.RECONSTRUCTION,
      [WritingStage.W7_INDEPENDENT]: WritingAttemptType.INDEPENDENT,
      [WritingStage.W8_SCORE_REWRITE]: WritingAttemptType.REVISION,
    };
    const attemptType = contracts[stageId];
    if (!attemptType) throw commandError("illegal-transition", "This Writing stage does not support Attempt draft autosave");
    const attemptInput = args.attempt;
    const attemptId = requiredString(args.attemptId || attemptInput?.attemptId, "attemptId");
    const preflight = await this._preflight(args, stageId, stageId);
    this._requireTransition(preflight);
    const existing = await this.repository.readAttempt(attemptId);
    if (existing && existing.status !== WritingAttemptStatus.DRAFTING) {
      return { session: preflight.session, safeStage: preflight.recovery.safeStage, attempt: existing };
    }
    const context = stageId === WritingStage.W3_BACK_TRANSLATION
      ? { translationSnapshotId: requiredString(preflight.recovery.selectedRefs.translationSnapshotId, "translationSnapshotId") }
      : stageId === WritingStage.W6_RECONSTRUCTION
        ? { skeletonRevisionId: preflight.session.stageFacts.w5Outcome === WritingSkeletonOutcome.COMPLETED
          ? preflight.session.stageFacts.committedSkeletonRevisionId
          : null }
        : { promptFingerprint: preflight.session.promptSnapshot.fingerprint };
    const time = this.now();
    let candidate = attemptFromInput({
      input: attemptInput,
      existing,
      username: this.repository.username,
      sessionId: preflight.session.sessionId,
      attemptId,
      attemptType,
      stageId,
      context,
      time,
    });
    if (stageId === WritingStage.W8_SCORE_REWRITE) {
      const parentAttemptId = requiredString(args.parentAttemptId || candidate.parentAttemptId, "parentAttemptId");
      const parent = await this.repository.readAttempt(parentAttemptId);
      if (!parent || parent.sessionId !== preflight.session.sessionId || parent.status !== WritingAttemptStatus.SUBMITTED || !parent.verifiedText) {
        throw commandError("lineage-mismatch", "Revision draft parent must be a submitted verified Attempt from the same Session");
      }
      candidate.parentAttemptId = parentAttemptId;
      candidate.inputMethod = WritingInputMethod.TYPED;
    }
    const flushedInkRef = await this._flushInk({
      required: Boolean(args.flushInk && inputNeedsInk(candidate.inputMethod)),
      sessionId: preflight.session.sessionId,
      stageId,
      ownerRecordId: attemptId,
      surfaceId: stageId === WritingStage.W3_BACK_TRANSLATION
        ? `w3:back:${attemptId}`
        : stageId === WritingStage.W6_RECONSTRUCTION
          ? `w6:reconstruction:${attemptId}`
          : stageId === WritingStage.W7_INDEPENDENT
            ? `w7:independent:${attemptId}`
            : `w8:revision:${attemptId}`,
      sourceRecord: existing || candidate,
    });
    candidate = {
      ...candidate,
      status: WritingAttemptStatus.DRAFTING,
      inkRef: flushedInkRef || candidate.inkRef || existing?.inkRef || null,
      transcriptionId: null,
      verifiedText: null,
      rawSubmittedAt: null,
      submittedAt: null,
      updatedAt: time,
      revision: existing?.revision ?? candidate.revision,
    };
    const saved = await this.repository.saveAttempt(candidate, {
      expectedRevision: args.attemptExpectedRevision ?? existing?.revision ?? 0,
    });
    await this._step("fact-save", { kind: `${attemptType}-draft`, id: attemptId });
    return { session: preflight.session, safeStage: preflight.recovery.safeStage, attempt: saved };
  }

  async commitTranslationAndEnterW3(args = {}) {
    const revisionInput = args.translationRevision || args.revision;
    const revisionId = requiredString(args.revisionId || revisionInput?.revisionId, "revisionId");
    const snapshotId = requiredString(args.snapshotId, "snapshotId");
    const preflight = await this._preflight(args, WritingStage.W2_EN_ZH, WritingStage.W3_BACK_TRANSLATION);
    let existingRevision = await this.repository.readTranslationRevision(revisionId);
    let existingSnapshot = await this.repository.readTranslationSnapshot(snapshotId);
    const selected = preflight.recovery.selectedRefs;
    const completed = isAtOrPast(preflight.session.currentStage, WritingStage.W3_BACK_TRANSLATION)
      && selected.translationRevisionId === revisionId
      && selected.translationSnapshotId === snapshotId;
    this._requireTransition(preflight, { completed });
    if (completed) {
      if (!existingRevision || !existingSnapshot) throw commandError("dependent-record-damaged", "Committed Translation facts are missing");
      assertStableRecord(existingRevision, revisionInput, ["sessionId", "username", "revisionNumber", "basedOnRevisionId", "createdAt"], "TranslationRevision");
      assertRetryUnits(existingRevision, revisionInput);
      try {
        assertTranslationSnapshotLineage(existingSnapshot, existingRevision);
      } catch (error) {
        throw commandError("dependent-record-damaged", "TranslationSnapshot verification failed", error);
      }
      return this._finishExisting(preflight, { translationRevision: existingRevision, translationSnapshot: existingSnapshot });
    }

    if (existingRevision?.status === WritingDraftStatus.COMMITTED) {
      assertStableRecord(existingRevision, revisionInput, ["sessionId", "username", "revisionNumber", "basedOnRevisionId", "createdAt"], "TranslationRevision");
      assertRetryUnits(existingRevision, revisionInput);
    } else {
      if (!revisionInput && !existingRevision) throw commandError("dependent-record-missing", "TranslationRevision input is required");
      const source = ensureOwnedIdentity(revisionInput || existingRevision, {
        username: this.repository.username,
        sessionId: preflight.session.sessionId,
        idField: "revisionId",
        id: revisionId,
      });
      const units = clone(source.units || existingRevision?.units || []);
      const needsInk = units.some((unit) => inputNeedsInk(unit.inputMethod));
      const inkRef = await this._flushInk({
        required: needsInk,
        sessionId: preflight.session.sessionId,
        stageId: WritingStage.W2_EN_ZH,
        ownerRecordId: revisionId,
        surfaceId: `w2:translation:${revisionId}`,
        sourceRecord: existingRevision || source,
      });
      const time = this.now();
      const committed = {
        ...source,
        schemaVersion: WRITING_SCHEMA_VERSION,
        revisionId,
        sessionId: preflight.session.sessionId,
        username: this.repository.username,
        status: WritingDraftStatus.COMMITTED,
        units: units.map((unit) => inputNeedsInk(unit.inputMethod) ? { ...unit, inkRef } : unit),
        createdAt: source.createdAt ?? existingRevision?.createdAt ?? time,
        updatedAt: time,
        committedAt: existingRevision?.committedAt ?? source.committedAt ?? time,
        revision: existingRevision?.revision ?? source.revision ?? 0,
      };
      const expectedRevision = args.translationExpectedRevision ?? existingRevision?.revision ?? 0;
      existingRevision = await this.repository.saveTranslationRevision(committed, { expectedRevision });
      await this._step("fact-save", { kind: "translation-revision", id: revisionId });
      existingRevision = await this.repository.readTranslationRevision(revisionId);
      if (existingRevision?.status !== WritingDraftStatus.COMMITTED) throw commandError("dependent-record-damaged", "TranslationRevision is not committed");
      await this._step("fact-read", { kind: "translation-revision", id: revisionId });
    }

    if (existingSnapshot) {
      try {
        assertTranslationSnapshotLineage(existingSnapshot, existingRevision);
      } catch (error) {
        throw commandError("conflict", "TranslationSnapshot conflicts with the committed Revision", error);
      }
    } else {
      existingSnapshot = await this.repository.createTranslationSnapshot({
        schemaVersion: WRITING_SCHEMA_VERSION,
        snapshotId,
        sessionId: preflight.session.sessionId,
        username: this.repository.username,
        translationRevisionId: revisionId,
        revisionFingerprint: existingRevision.fingerprint,
        units: clone(existingRevision.units),
        createdAt: args.snapshotCreatedAt ?? this.now(),
      });
      await this._step("fact-save", { kind: "translation-snapshot", id: snapshotId });
    }
    existingSnapshot = await this.repository.readTranslationSnapshot(snapshotId);
    try {
      assertTranslationSnapshotLineage(existingSnapshot, existingRevision);
    } catch (error) {
      throw commandError("dependent-record-damaged", "TranslationSnapshot verification failed", error);
    }
    await this._step("fact-read", { kind: "translation-snapshot", id: snapshotId });
    const time = this.now();
    return this._saveSessionLast(preflight, {
      ...preflight.session,
      currentStage: WritingStage.W3_BACK_TRANSLATION,
      lastActiveAt: time,
      updatedAt: time,
    }, { translationRevision: existingRevision, translationSnapshot: existingSnapshot });
  }

  async submitBackTranslationAndEnterW4(args = {}) {
    const attemptInput = args.attempt || args.backTranslationAttempt;
    const attemptId = requiredString(args.attemptId || attemptInput?.attemptId, "attemptId");
    const preflight = await this._preflight(args, WritingStage.W3_BACK_TRANSLATION, WritingStage.W4_COMPARE_DIAGNOSE);
    const snapshotId = requiredString(args.translationSnapshotId || preflight.recovery.selectedRefs.translationSnapshotId, "translationSnapshotId");
    let existing = await this.repository.readAttempt(attemptId);
    const completed = isAtOrPast(preflight.session.currentStage, WritingStage.W4_COMPARE_DIAGNOSE)
      && preflight.recovery.selectedRefs.backTranslationAttemptId === attemptId;
    this._requireTransition(preflight, { completed });
    if (completed) {
      if (!existing || existing.status !== WritingAttemptStatus.SUBMITTED || !existing.verifiedText) throw commandError("dependent-record-damaged", "Submitted verified Back Translation Attempt is missing");
      assertStableRecord(existing, attemptInput, ["sessionId", "username", "attemptType", "stageId", "context", "inputMethod", "typedText", "createdAt"], "Attempt");
      if (attemptInput?.inkRef && !sameValue(existing.inkRef, attemptInput.inkRef)) throw commandError("conflict", "Attempt.inkRef conflicts with the submitted record");
      return this._finishExisting(preflight, { attempt: existing });
    }
    if (existing?.status === WritingAttemptStatus.SUBMITTED) {
      assertStableRecord(existing, attemptInput, ["sessionId", "username", "attemptType", "stageId", "context", "createdAt"], "Attempt");
    } else {
      const time = this.now();
      let candidate = attemptFromInput({
        input: attemptInput,
        existing,
        username: this.repository.username,
        sessionId: preflight.session.sessionId,
        attemptId,
        attemptType: WritingAttemptType.BACK_TRANSLATION,
        stageId: WritingStage.W3_BACK_TRANSLATION,
        context: { translationSnapshotId: snapshotId },
        time,
      });
      if (inputNeedsInk(candidate.inputMethod)) throw commandError("prerequisite-missing", "Handwritten W3 must be raw-submitted and explicitly verified before W4");
      const text = requiredString(candidate.typedText, "verifiedText.text");
      const verifiedText = await createVerifiedText(attemptId, { text, source: WritingVerifiedTextSource.TYPED, sourceTranscriptionId: null, confirmedAt: time });
      const inkRef = await this._flushInk({
        required: inputNeedsInk(candidate.inputMethod),
        sessionId: candidate.sessionId,
        stageId: candidate.stageId,
        ownerRecordId: attemptId,
        surfaceId: `w3:back:${attemptId}`,
        sourceRecord: existing || candidate,
      });
      candidate = {
        ...candidate,
        status: WritingAttemptStatus.SUBMITTED,
        inkRef: inkRef || candidate.inkRef,
        verifiedText,
        updatedAt: time,
        submittedAt: candidate.submittedAt ?? time,
        revision: existing?.revision ?? candidate.revision,
      };
      existing = await this.repository.saveAttempt(candidate, { expectedRevision: args.attemptExpectedRevision ?? existing?.revision ?? 0 });
      await this._step("fact-save", { kind: "back-translation-attempt", id: attemptId });
    }
    existing = await this.repository.readAttempt(attemptId);
    if (existing?.status !== WritingAttemptStatus.SUBMITTED || !existing.verifiedText || existing.context.translationSnapshotId !== snapshotId) {
      throw commandError("dependent-record-damaged", "Back Translation Attempt verification failed");
    }
    await this._step("fact-read", { kind: "back-translation-attempt", id: attemptId });
    const time = this.now();
    return this._saveSessionLast(preflight, {
      ...preflight.session,
      currentStage: WritingStage.W4_COMPARE_DIAGNOSE,
      lastActiveAt: time,
      updatedAt: time,
    }, { attempt: existing });
  }


  async prepareBackTranslationHandwritingForVerification(args = {}) {
    const attemptInput = args.attempt || args.backTranslationAttempt;
    const attemptId = requiredString(args.attemptId || attemptInput?.attemptId, "attemptId");
    const preflight = await this._preflight(args, WritingStage.W3_BACK_TRANSLATION, WritingStage.W3_BACK_TRANSLATION);
    const snapshotId = requiredString(args.translationSnapshotId || preflight.recovery.selectedRefs.translationSnapshotId, "translationSnapshotId");
    let attempt = await this.repository.readAttempt(attemptId);
    const completed = attempt && [WritingAttemptStatus.RAW_SUBMITTED, WritingAttemptStatus.VERIFYING, WritingAttemptStatus.SUBMITTED].includes(attempt.status) && attempt.inkRef;
    this._requireTransition(preflight, { completed: Boolean(completed) });
    if (completed) return { session: preflight.session, safeStage: preflight.recovery.safeStage, recovery: preflight.recovery, attempt };
    const time = this.now();
    let candidate = attemptFromInput({ input: attemptInput, existing: attempt, username: this.repository.username, sessionId: preflight.session.sessionId, attemptId, attemptType: WritingAttemptType.BACK_TRANSLATION, stageId: WritingStage.W3_BACK_TRANSLATION, context: { translationSnapshotId: snapshotId }, time });
    candidate.inputMethod = WritingInputMethod.HANDWRITING;
    const inkRef = await this._flushInk({ required: true, sessionId: candidate.sessionId, stageId: candidate.stageId, ownerRecordId: attemptId, surfaceId: `w3:back:${attemptId}`, sourceRecord: attempt || candidate });
    candidate = { ...candidate, status: WritingAttemptStatus.RAW_SUBMITTED, inkRef, transcriptionId: null, verifiedText: null, rawSubmittedAt: candidate.rawSubmittedAt ?? time, submittedAt: null, updatedAt: time, revision: attempt?.revision ?? candidate.revision };
    attempt = await this.repository.saveAttempt(candidate, { expectedRevision: args.attemptExpectedRevision ?? attempt?.revision ?? 0 });
    if (attempt.status !== WritingAttemptStatus.RAW_SUBMITTED || !attempt.inkRef || attempt.verifiedText !== null) throw commandError("dependent-record-damaged", "Raw W3 handwriting Attempt verification failed");
    return { session: preflight.session, safeStage: preflight.recovery.safeStage, recovery: preflight.recovery, attempt };
  }

  async submitBackTranslationHandwritingAndEnterW4(args = {}) {
    const source = args.source || args.verifiedText?.source;
    if (![WritingVerifiedTextSource.MANUAL_ENTRY, WritingVerifiedTextSource.TRANSCRIPTION].includes(source)) throw commandError("prerequisite-missing", "Handwriting submission requires manual_entry or transcription verified text");
    const attemptId = requiredString(args.attemptId, "attemptId");
    const preflight = await this._preflight(args, WritingStage.W3_BACK_TRANSLATION, WritingStage.W4_COMPARE_DIAGNOSE);
    const snapshotId = requiredString(args.translationSnapshotId || preflight.recovery.selectedRefs.translationSnapshotId, "translationSnapshotId");
    let attempt = await this.repository.readAttempt(attemptId);
    const completed = attempt?.status === WritingAttemptStatus.SUBMITTED && attempt.verifiedText && isAtOrPast(preflight.session.currentStage, WritingStage.W4_COMPARE_DIAGNOSE);
    this._requireTransition(preflight, { completed });
    if (completed) return this._finishExisting(preflight, { attempt });
    if (!attempt || attempt.attemptType !== WritingAttemptType.BACK_TRANSLATION || attempt.stageId !== WritingStage.W3_BACK_TRANSLATION || attempt.context.translationSnapshotId !== snapshotId || !attempt.inkRef || ![WritingAttemptStatus.RAW_SUBMITTED, WritingAttemptStatus.VERIFYING].includes(attempt.status)) throw commandError("prerequisite-missing", "W3 handwriting Attempt is not awaiting verification");
    const transcriptionId = source === WritingVerifiedTextSource.TRANSCRIPTION ? requiredString(args.transcriptionId || args.sourceTranscriptionId, "transcriptionId") : null;
    if (transcriptionId) {
      if (attempt.status !== WritingAttemptStatus.VERIFYING || attempt.transcriptionId !== transcriptionId) throw commandError("prerequisite-missing", "Transcription must be attached before user confirmation");
      await this._readTranscriptionForAttempt(attempt, transcriptionId);
    }
    const time = this.now();
    const text = requiredString(args.text ?? args.verifiedText?.text, "verifiedText.text");
    const verifiedText = await createVerifiedText(attemptId, { text, source, sourceTranscriptionId: transcriptionId, confirmedAt: args.confirmedAt ?? time });
    attempt = await this.repository.saveAttempt({ ...attempt, status: WritingAttemptStatus.SUBMITTED, transcriptionId, verifiedText, submittedAt: attempt.submittedAt ?? time, updatedAt: time }, { expectedRevision: args.attemptExpectedRevision ?? attempt.revision });
    if (attempt.status !== WritingAttemptStatus.SUBMITTED || !attempt.verifiedText) throw commandError("dependent-record-damaged", "Verified W3 Attempt persistence failed");
    return this._saveSessionLast(preflight, { ...preflight.session, currentStage: WritingStage.W4_COMPARE_DIAGNOSE, lastActiveAt: time, updatedAt: time }, { attempt });
  }

  async attachTranscriptionForVerification(args = {}) {
    const attemptId = requiredString(args.attemptId, "attemptId");
    const transcriptionId = requiredString(args.transcriptionId, "transcriptionId");
    this._assertAccount();
    let attempt = await this.repository.readAttempt(attemptId);
    if (!attempt || !attemptContractForVerification(attempt)) throw commandError("prerequisite-missing", "Only W3/W7 handwriting Attempts can verify a transcription");
    const preflight = await this._preflight(args, attempt.stageId, attempt.stageId);
    this._requireTransition(preflight, { completed: attempt.status === WritingAttemptStatus.VERIFYING && attempt.transcriptionId === transcriptionId });
    if (![WritingAttemptStatus.RAW_SUBMITTED, WritingAttemptStatus.VERIFYING].includes(attempt.status) || !attempt.inkRef || attempt.verifiedText !== null) throw commandError("prerequisite-missing", "Attempt is not awaiting transcription verification");
    await this._readTranscriptionForAttempt(attempt, transcriptionId);
    if (attempt.status === WritingAttemptStatus.VERIFYING && attempt.transcriptionId === transcriptionId) return { session: preflight.session, safeStage: preflight.recovery.safeStage, recovery: preflight.recovery, attempt };
    attempt = await this.repository.saveAttempt({ ...attempt, status: WritingAttemptStatus.VERIFYING, transcriptionId, verifiedText: null, updatedAt: this.now() }, { expectedRevision: args.attemptExpectedRevision ?? attempt.revision });
    if (attempt.status !== WritingAttemptStatus.VERIFYING || attempt.transcriptionId !== transcriptionId || attempt.verifiedText !== null) throw commandError("dependent-record-damaged", "Attempt verification state persistence failed");
    return { session: preflight.session, safeStage: preflight.recovery.safeStage, recovery: preflight.recovery, attempt };
  }

  async completeCompareAndEnterW5(args = {}) {
    const preflight = await this._preflight(args, WritingStage.W4_COMPARE_DIAGNOSE, WritingStage.W5_SKELETON);
    const completed = preflight.session.stageFacts.w4CompareCompletedAt !== null
      && isAtOrPast(preflight.session.currentStage, WritingStage.W5_SKELETON);
    this._requireTransition(preflight, { completed });
    if (completed) return this._finishExisting(preflight);
    const time = this.now();
    return this._saveSessionLast(preflight, {
      ...preflight.session,
      currentStage: WritingStage.W5_SKELETON,
      stageFacts: {
        ...preflight.session.stageFacts,
        w4CompareCompletedAt: preflight.session.stageFacts.w4CompareCompletedAt ?? time,
      },
      lastActiveAt: time,
      updatedAt: time,
    });
  }

  async finishOrSkipSkeleton(args = {}) {
    const outcome = args.outcome;
    const nextStage = args.nextStage;
    if (![WritingSkeletonOutcome.COMPLETED, WritingSkeletonOutcome.SKIPPED].includes(outcome)) {
      throw commandError("illegal-transition", "W5 outcome must be completed or skipped");
    }
    if (![WritingStage.W6_RECONSTRUCTION, WritingStage.W7_INDEPENDENT].includes(nextStage)) {
      throw commandError("illegal-transition", "W5 nextStage must be W6_RECONSTRUCTION or W7_INDEPENDENT");
    }
    const skeletonInput = args.skeletonRevision;
    const skeletonRevisionId = outcome === WritingSkeletonOutcome.COMPLETED
      ? requiredString(args.skeletonRevisionId || skeletonInput?.revisionId, "skeletonRevisionId")
      : null;
    const w6Input = args.w6Attempt || args.reconstructionAttempt;
    const w6AttemptId = nextStage === WritingStage.W6_RECONSTRUCTION
      ? requiredString(args.w6AttemptId || w6Input?.attemptId, "w6AttemptId")
      : null;
    const preflight = await this._preflight(args, WritingStage.W5_SKELETON, [WritingStage.W6_RECONSTRUCTION, WritingStage.W7_INDEPENDENT]);
    const branchMatches = nextStage === WritingStage.W7_INDEPENDENT
      ? preflight.session.stageFacts.w6Outcome === WritingReconstructionOutcome.NOT_REACHED
      : preflight.session.currentStage === WritingStage.W6_RECONSTRUCTION
        || preflight.session.stageFacts.w6Outcome !== WritingReconstructionOutcome.NOT_REACHED;
    const completed = preflight.session.stageFacts.w5Outcome === outcome
      && preflight.session.stageFacts.committedSkeletonRevisionId === skeletonRevisionId
      && branchMatches
      && isAtOrPast(preflight.session.currentStage, nextStage);
    this._requireTransition(preflight, { completed });
    if (completed) {
      if (outcome === WritingSkeletonOutcome.COMPLETED) {
        const persistedSkeleton = await this.repository.readSkeletonRevision(skeletonRevisionId);
        if (!persistedSkeleton || persistedSkeleton.status !== WritingDraftStatus.COMMITTED) throw commandError("dependent-record-damaged", "Committed SkeletonRevision is missing");
        assertStableRecord(persistedSkeleton, skeletonInput, ["sessionId", "username", "revisionNumber", "basedOnRevisionId", "blocks", "createdAt"], "SkeletonRevision");
      }
      if (nextStage === WritingStage.W6_RECONSTRUCTION) {
        const persistedAttempt = await this.repository.readAttempt(w6AttemptId);
        if (!persistedAttempt) throw commandError("dependent-record-damaged", "W6 Attempt is missing");
        const expectedSkeletonId = outcome === WritingSkeletonOutcome.COMPLETED ? skeletonRevisionId : null;
        if (persistedAttempt.context.skeletonRevisionId !== expectedSkeletonId) throw commandError("lineage-mismatch", "W6 Attempt Skeleton binding changed");
        assertStableRecord(persistedAttempt, w6Input, ["sessionId", "username", "attemptType", "stageId", "inputMethod", "typedText", "createdAt"], "W6 Attempt");
      }
      return this._finishExisting(preflight);
    }

    if (nextStage === WritingStage.W7_INDEPENDENT) {
      const expectedSkeletonId = outcome === WritingSkeletonOutcome.COMPLETED ? skeletonRevisionId : null;
      const existingW6 = (await this.repository.listAttempts()).filter((record) => !record.damaged
        && record.sessionId === preflight.session.sessionId
        && record.attemptType === WritingAttemptType.RECONSTRUCTION
        && record.context.skeletonRevisionId === expectedSkeletonId);
      if (existingW6.length) throw commandError("conflict", "A W6 Attempt already proves that this W5 command selected the W6 branch");
    }

    let skeleton = null;
    if (outcome === WritingSkeletonOutcome.COMPLETED) {
      skeleton = await this.repository.readSkeletonRevision(skeletonRevisionId);
      if (skeleton?.status === WritingDraftStatus.COMMITTED) {
        assertStableRecord(skeleton, skeletonInput, ["sessionId", "username", "revisionNumber", "basedOnRevisionId", "blocks", "createdAt"], "SkeletonRevision");
      } else {
        if (!skeleton && !skeletonInput) throw commandError("dependent-record-missing", "SkeletonRevision input is required");
        const source = ensureOwnedIdentity(skeletonInput || skeleton, {
          username: this.repository.username,
          sessionId: preflight.session.sessionId,
          idField: "revisionId",
          id: skeletonRevisionId,
        });
        const needsInk = args.requiresInk === true || inputNeedsInk(args.inputMethod);
        const inkRef = await this._flushInk({
          required: needsInk,
          sessionId: preflight.session.sessionId,
          stageId: WritingStage.W5_SKELETON,
          ownerRecordId: skeletonRevisionId,
          surfaceId: `w5:skeleton:${skeletonRevisionId}`,
          sourceRecord: skeleton || source,
        });
        const time = this.now();
        skeleton = await this.repository.saveSkeletonRevision({
          ...source,
          schemaVersion: WRITING_SCHEMA_VERSION,
          revisionId: skeletonRevisionId,
          sessionId: preflight.session.sessionId,
          username: this.repository.username,
          status: WritingDraftStatus.COMMITTED,
          inkRef: inkRef || source.inkRef || null,
          createdAt: source.createdAt ?? skeleton?.createdAt ?? time,
          updatedAt: time,
          committedAt: skeleton?.committedAt ?? source.committedAt ?? time,
          revision: skeleton?.revision ?? source.revision ?? 0,
        }, { expectedRevision: args.skeletonExpectedRevision ?? skeleton?.revision ?? 0 });
        await this._step("fact-save", { kind: "skeleton-revision", id: skeletonRevisionId });
      }
      skeleton = await this.repository.readSkeletonRevision(skeletonRevisionId);
      if (skeleton?.status !== WritingDraftStatus.COMMITTED) throw commandError("dependent-record-damaged", "SkeletonRevision verification failed");
      await this._step("fact-read", { kind: "skeleton-revision", id: skeletonRevisionId });
    }

    let w6Attempt = null;
    if (nextStage === WritingStage.W6_RECONSTRUCTION) {
      w6Attempt = await this.repository.readAttempt(w6AttemptId);
      const time = this.now();
      const expectedSkeletonId = outcome === WritingSkeletonOutcome.COMPLETED ? skeletonRevisionId : null;
      if (w6Attempt) {
        assertStableRecord(w6Attempt, w6Input, ["sessionId", "username", "attemptType", "stageId", "createdAt"], "W6 Attempt");
        if (w6Attempt.attemptType !== WritingAttemptType.RECONSTRUCTION || w6Attempt.context.skeletonRevisionId !== expectedSkeletonId) {
          throw commandError("lineage-mismatch", "W6 Attempt is not bound to the exact W5 Skeleton outcome");
        }
      } else {
        const candidate = attemptFromInput({
          input: w6Input,
          existing: null,
          username: this.repository.username,
          sessionId: preflight.session.sessionId,
          attemptId: w6AttemptId,
          attemptType: WritingAttemptType.RECONSTRUCTION,
          stageId: WritingStage.W6_RECONSTRUCTION,
          context: { skeletonRevisionId: expectedSkeletonId },
          time,
        });
        w6Attempt = await this.repository.saveAttempt(candidate, { expectedRevision: 0 });
        await this._step("fact-save", { kind: "reconstruction-attempt", id: w6AttemptId });
      }
      w6Attempt = await this.repository.readAttempt(w6AttemptId);
      await this._step("fact-read", { kind: "reconstruction-attempt", id: w6AttemptId });
    }

    const time = this.now();
    return this._saveSessionLast(preflight, {
      ...preflight.session,
      currentStage: nextStage,
      stageFacts: {
        ...preflight.session.stageFacts,
        w5Outcome: outcome,
        w5EndedAt: preflight.session.stageFacts.w5EndedAt ?? time,
        committedSkeletonRevisionId: skeletonRevisionId,
      },
      lastActiveAt: time,
      updatedAt: time,
    }, { skeletonRevision: skeleton, reconstructionAttempt: w6Attempt });
  }

  async finishOrSkipReconstruction(args = {}) {
    const outcome = args.outcome;
    if (![WritingReconstructionOutcome.SUBMITTED, WritingReconstructionOutcome.SKIPPED].includes(outcome)) {
      throw commandError("illegal-transition", "W6 outcome must be submitted or skipped");
    }
    const attemptInput = args.attempt || args.reconstructionAttempt;
    const attemptId = outcome === WritingReconstructionOutcome.SUBMITTED
      ? requiredString(args.attemptId || attemptInput?.attemptId, "attemptId")
      : null;
    const preflight = await this._preflight(args, WritingStage.W6_RECONSTRUCTION, WritingStage.W7_INDEPENDENT);
    const completed = preflight.session.stageFacts.w6Outcome === outcome
      && preflight.session.stageFacts.w6AttemptId === attemptId
      && isAtOrPast(preflight.session.currentStage, WritingStage.W7_INDEPENDENT);
    this._requireTransition(preflight, { completed });
    if (completed) {
      const persistedAttempt = attemptId ? await this.repository.readAttempt(attemptId) : null;
      if (outcome === WritingReconstructionOutcome.SUBMITTED) {
        if (!persistedAttempt || persistedAttempt.status !== WritingAttemptStatus.SUBMITTED) throw commandError("dependent-record-damaged", "Submitted W6 Attempt is missing");
        assertStableRecord(persistedAttempt, attemptInput, ["sessionId", "username", "attemptType", "stageId", "inputMethod", "typedText", "createdAt"], "W6 Attempt");
      }
      return this._finishExisting(preflight, { attempt: persistedAttempt });
    }

    let attempt = null;
    if (outcome === WritingReconstructionOutcome.SUBMITTED) {
      const expectedSkeletonId = preflight.session.stageFacts.w5Outcome === WritingSkeletonOutcome.COMPLETED
        ? preflight.session.stageFacts.committedSkeletonRevisionId
        : null;
      attempt = await this.repository.readAttempt(attemptId);
      if (!attempt && !attemptInput) throw commandError("dependent-record-missing", "W6 Attempt does not exist");
      const time = this.now();
      let candidate = attemptFromInput({
        input: attemptInput,
        existing: attempt,
        username: this.repository.username,
        sessionId: preflight.session.sessionId,
        attemptId,
        attemptType: WritingAttemptType.RECONSTRUCTION,
        stageId: WritingStage.W6_RECONSTRUCTION,
        context: { skeletonRevisionId: expectedSkeletonId },
        time,
      });
      if (attempt && attempt.context.skeletonRevisionId !== expectedSkeletonId) {
        throw commandError("lineage-mismatch", "W6 Attempt Skeleton binding changed");
      }
      if (attempt?.status !== WritingAttemptStatus.SUBMITTED) {
        const inkRef = await this._flushInk({
          required: inputNeedsInk(candidate.inputMethod),
          sessionId: candidate.sessionId,
          stageId: candidate.stageId,
          ownerRecordId: attemptId,
          surfaceId: `w6:reconstruction:${attemptId}`,
          sourceRecord: attempt || candidate,
        });
        candidate = {
          ...candidate,
          status: WritingAttemptStatus.SUBMITTED,
          inkRef: inkRef || candidate.inkRef,
          updatedAt: time,
          submittedAt: candidate.submittedAt ?? time,
          revision: attempt?.revision ?? candidate.revision,
        };
        attempt = await this.repository.saveAttempt(candidate, { expectedRevision: args.attemptExpectedRevision ?? attempt?.revision ?? 0 });
        await this._step("fact-save", { kind: "reconstruction-attempt", id: attemptId });
      }
      attempt = await this.repository.readAttempt(attemptId);
      if (attempt?.status !== WritingAttemptStatus.SUBMITTED || attempt.context.skeletonRevisionId !== expectedSkeletonId) {
        throw commandError("dependent-record-damaged", "W6 Attempt verification failed");
      }
      await this._step("fact-read", { kind: "reconstruction-attempt", id: attemptId });
    } else if (attemptInput?.attemptId) {
      const draftAttemptId = requiredString(attemptInput.attemptId, "attempt.attemptId");
      const expectedSkeletonId = preflight.session.stageFacts.w5Outcome === WritingSkeletonOutcome.COMPLETED
        ? preflight.session.stageFacts.committedSkeletonRevisionId
        : null;
      attempt = await this.repository.readAttempt(draftAttemptId);
      if (attempt && (attempt.attemptType !== WritingAttemptType.RECONSTRUCTION
        || attempt.stageId !== WritingStage.W6_RECONSTRUCTION
        || attempt.context.skeletonRevisionId !== expectedSkeletonId)) {
        throw commandError("lineage-mismatch", "W6 draft is not bound to the current Skeleton outcome");
      }
      const time = this.now();
      let candidate = attemptFromInput({
        input: attemptInput,
        existing: attempt,
        username: this.repository.username,
        sessionId: preflight.session.sessionId,
        attemptId: draftAttemptId,
        attemptType: WritingAttemptType.RECONSTRUCTION,
        stageId: WritingStage.W6_RECONSTRUCTION,
        context: { skeletonRevisionId: expectedSkeletonId },
        time,
      });
      const inkRef = await this._flushInk({
        required: inputNeedsInk(candidate.inputMethod),
        sessionId: candidate.sessionId,
        stageId: candidate.stageId,
        ownerRecordId: draftAttemptId,
        surfaceId: `w6:reconstruction:${draftAttemptId}`,
        sourceRecord: attempt || candidate,
      });
      candidate = {
        ...candidate,
        status: WritingAttemptStatus.DRAFTING,
        inkRef: inkRef || candidate.inkRef,
        updatedAt: time,
        revision: attempt?.revision ?? candidate.revision,
      };
      attempt = await this.repository.saveAttempt(candidate, {
        expectedRevision: args.attemptExpectedRevision ?? attempt?.revision ?? 0,
      });
      await this._step("fact-save", { kind: "reconstruction-draft", id: draftAttemptId });
    }

    const time = this.now();
    return this._saveSessionLast(preflight, {
      ...preflight.session,
      currentStage: WritingStage.W7_INDEPENDENT,
      stageFacts: {
        ...preflight.session.stageFacts,
        w6Outcome: outcome,
        w6EndedAt: preflight.session.stageFacts.w6EndedAt ?? time,
        w6AttemptId: attemptId,
      },
      lastActiveAt: time,
      updatedAt: time,
    }, { attempt });
  }

  async submitIndependentTyped(args = {}) {
    return this._submitIndependent({ ...args, source: WritingVerifiedTextSource.TYPED, requireInk: false });
  }

  async prepareIndependentHandwritingForVerification(args = {}) {
    const attemptInput = args.attempt || args.independentAttempt;
    const attemptId = requiredString(args.attemptId || attemptInput?.attemptId, "attemptId");
    const preflight = await this._preflight(args, WritingStage.W7_INDEPENDENT, WritingStage.W7_INDEPENDENT);
    let attempt = await this.repository.readAttempt(attemptId);
    const completed = attempt
      && [WritingAttemptStatus.RAW_SUBMITTED, WritingAttemptStatus.VERIFYING, WritingAttemptStatus.SUBMITTED].includes(attempt.status)
      && attempt.inkRef !== null;
    this._requireTransition(preflight, { completed: completed && preflight.session.currentStage === WritingStage.W7_INDEPENDENT });
    if (completed) {
      assertStableRecord(attempt, attemptInput, ["sessionId", "username", "attemptType", "stageId", "inputMethod", "typedText", "createdAt"], "Independent Attempt");
      return { session: preflight.session, safeStage: preflight.recovery.safeStage, recovery: preflight.recovery, attempt };
    }
    const time = this.now();
    let candidate = attemptFromInput({
      input: attemptInput,
      existing: attempt,
      username: this.repository.username,
      sessionId: preflight.session.sessionId,
      attemptId,
      attemptType: WritingAttemptType.INDEPENDENT,
      stageId: WritingStage.W7_INDEPENDENT,
      context: { promptFingerprint: preflight.session.promptSnapshot.fingerprint },
      time,
    });
    if (!inputNeedsInk(candidate.inputMethod)) candidate.inputMethod = WritingInputMethod.HANDWRITING;
    const inkRef = await this._flushInk({
      required: true,
      sessionId: candidate.sessionId,
      stageId: candidate.stageId,
      ownerRecordId: attemptId,
      surfaceId: `w7:independent:${attemptId}`,
      sourceRecord: attempt || candidate,
    });
    candidate = {
      ...candidate,
      status: WritingAttemptStatus.RAW_SUBMITTED,
      inkRef,
      transcriptionId: null,
      verifiedText: null,
      rawSubmittedAt: candidate.rawSubmittedAt ?? time,
      updatedAt: time,
      revision: attempt?.revision ?? candidate.revision,
    };
    attempt = await this.repository.saveAttempt(candidate, { expectedRevision: args.attemptExpectedRevision ?? attempt?.revision ?? 0 });
    await this._step("fact-save", { kind: "independent-attempt-raw", id: attemptId });
    attempt = await this.repository.readAttempt(attemptId);
    if (attempt?.status !== WritingAttemptStatus.RAW_SUBMITTED || !attempt.inkRef) {
      throw commandError("dependent-record-damaged", "Raw handwriting Attempt verification failed");
    }
    await this._step("fact-read", { kind: "independent-attempt-raw", id: attemptId });
    return { session: preflight.session, safeStage: preflight.recovery.safeStage, recovery: preflight.recovery, attempt };
  }

  async submitIndependentHandwriting(args = {}) {
    const source = args.source || args.verifiedText?.source;
    if (![WritingVerifiedTextSource.MANUAL_ENTRY, WritingVerifiedTextSource.TRANSCRIPTION].includes(source)) {
      throw commandError("prerequisite-missing", "Handwriting submission requires manual_entry or transcription verified text");
    }
    return this._submitIndependent({ ...args, source, requireInk: true });
  }

  async _submitIndependent(args) {
    const attemptInput = args.attempt || args.independentAttempt;
    const attemptId = requiredString(args.attemptId || attemptInput?.attemptId, "attemptId");
    const preflight = await this._preflight(args, WritingStage.W7_INDEPENDENT, WritingStage.W8_SCORE_REWRITE);
    let attempt = await this.repository.readAttempt(attemptId);
    const completed = attempt?.status === WritingAttemptStatus.SUBMITTED
      && attempt.verifiedText
      && isAtOrPast(preflight.session.currentStage, WritingStage.W8_SCORE_REWRITE)
      && preflight.recovery.selectedRefs.independentAttemptId === attemptId;
    this._requireTransition(preflight, { completed });
    if (completed) {
      const requestedText = args.text ?? args.typedText ?? args.verifiedText?.text;
      if (requestedText !== undefined && attempt.verifiedText.text !== String(requestedText).trim()) {
        throw commandError("conflict", "VerifiedText conflicts with the submitted Attempt");
      }
      if (attempt.verifiedText.source !== args.source) throw commandError("conflict", "VerifiedText source conflicts with the submitted Attempt");
      const requestedTranscriptionId = args.transcriptionId || args.sourceTranscriptionId || args.verifiedText?.sourceTranscriptionId || null;
      if (requestedTranscriptionId !== null && attempt.verifiedText.sourceTranscriptionId !== requestedTranscriptionId) {
        throw commandError("conflict", "VerifiedText transcription identity conflicts with the submitted Attempt");
      }
      return this._finishExisting(preflight, { attempt });
    }
    const time = this.now();
    let candidate = attemptFromInput({
      input: attemptInput,
      existing: attempt,
      username: this.repository.username,
      sessionId: preflight.session.sessionId,
      attemptId,
      attemptType: WritingAttemptType.INDEPENDENT,
      stageId: WritingStage.W7_INDEPENDENT,
      context: { promptFingerprint: preflight.session.promptSnapshot.fingerprint },
      time,
    });
    if (args.requireInk && (!attempt?.inkRef || ![WritingAttemptStatus.RAW_SUBMITTED, WritingAttemptStatus.VERIFYING].includes(attempt.status))) {
      throw commandError("prerequisite-missing", "Handwriting Attempt must be raw-submitted with ink before verification");
    }
    const sourceTranscriptionId = args.source === WritingVerifiedTextSource.TRANSCRIPTION
      ? requiredString(args.transcriptionId || args.sourceTranscriptionId || args.verifiedText?.sourceTranscriptionId, "transcriptionId")
      : null;
    if (sourceTranscriptionId) {
      if (attempt.status !== WritingAttemptStatus.VERIFYING || attempt.transcriptionId !== sourceTranscriptionId) throw commandError("prerequisite-missing", "Transcription must be attached before user confirmation");
      await this._readTranscriptionForAttempt(attempt, sourceTranscriptionId);
    }
    const text = requiredString(args.text ?? args.typedText ?? args.verifiedText?.text ?? candidate.typedText, "verifiedText.text");
    const verifiedText = await createVerifiedText(attemptId, {
      text,
      source: args.source,
      sourceTranscriptionId,
      confirmedAt: args.confirmedAt ?? time,
    });
    candidate = {
      ...candidate,
      status: WritingAttemptStatus.SUBMITTED,
      typedText: args.source === WritingVerifiedTextSource.TYPED ? text : candidate.typedText,
      transcriptionId: sourceTranscriptionId,
      verifiedText,
      submittedAt: candidate.submittedAt ?? time,
      updatedAt: time,
      revision: attempt?.revision ?? candidate.revision,
    };
    attempt = await this.repository.saveAttempt(candidate, { expectedRevision: args.attemptExpectedRevision ?? attempt?.revision ?? 0 });
    await this._step("fact-save", { kind: "independent-attempt", id: attemptId });
    attempt = await this.repository.readAttempt(attemptId);
    if (attempt?.status !== WritingAttemptStatus.SUBMITTED || !attempt.verifiedText) {
      throw commandError("dependent-record-damaged", "Independent Attempt verification failed");
    }
    await this._step("fact-read", { kind: "independent-attempt", id: attemptId });
    return this._saveSessionLast(preflight, {
      ...preflight.session,
      currentStage: WritingStage.W8_SCORE_REWRITE,
      lastActiveAt: time,
      updatedAt: time,
    }, { attempt });
  }

  async submitRevisionAttempt(args = {}) {
    const attemptInput = args.attempt || args.revisionAttempt;
    const attemptId = requiredString(args.attemptId || attemptInput?.attemptId, "attemptId");
    const parentAttemptId = requiredString(args.parentAttemptId || attemptInput?.parentAttemptId, "parentAttemptId");
    const preflight = await this._preflight(args, WritingStage.W8_SCORE_REWRITE, WritingStage.W8_SCORE_REWRITE);
    this._requireTransition(preflight);
    const parent = await this.repository.readAttempt(parentAttemptId);
    if (!parent || parent.sessionId !== preflight.session.sessionId || parent.status !== WritingAttemptStatus.SUBMITTED || !parent.verifiedText) {
      throw commandError("lineage-mismatch", "Revision parent must be a submitted verified Attempt from the same Session");
    }
    let attempt = await this.repository.readAttempt(attemptId);
    if (attempt?.status === WritingAttemptStatus.SUBMITTED) {
      assertStableRecord(attempt, attemptInput, ["sessionId", "username", "attemptType", "stageId", "parentAttemptId", "context", "inputMethod", "typedText", "createdAt"], "Revision Attempt");
      await this._emit(preflight.session, preflight.recovery.safeStage);
      return { session: preflight.session, safeStage: preflight.recovery.safeStage, recovery: preflight.recovery, attempt };
    }
    const time = this.now();
    let candidate = attemptFromInput({
      input: attemptInput,
      existing: attempt,
      username: this.repository.username,
      sessionId: preflight.session.sessionId,
      attemptId,
      attemptType: WritingAttemptType.REVISION,
      stageId: WritingStage.W8_SCORE_REWRITE,
      context: { promptFingerprint: preflight.session.promptSnapshot.fingerprint },
      time,
    });
    candidate = {
      ...candidate,
      parentAttemptId,
      inputMethod: WritingInputMethod.TYPED,
      typedText: requiredString(args.typedText ?? candidate.typedText, "typedText"),
      status: WritingAttemptStatus.SUBMITTED,
      submittedAt: candidate.submittedAt ?? time,
      updatedAt: time,
      revision: attempt?.revision ?? candidate.revision,
    };
    candidate.verifiedText = await createVerifiedText(attemptId, {
      text: candidate.typedText,
      source: WritingVerifiedTextSource.TYPED,
      sourceTranscriptionId: null,
      confirmedAt: args.confirmedAt ?? time,
    });
    attempt = await this.repository.saveAttempt(candidate, { expectedRevision: args.attemptExpectedRevision ?? attempt?.revision ?? 0 });
    await this._step("fact-save", { kind: "revision-attempt", id: attemptId });
    attempt = await this.repository.readAttempt(attemptId);
    if (attempt?.status !== WritingAttemptStatus.SUBMITTED || !attempt.verifiedText) throw commandError("dependent-record-damaged", "Revision Attempt verification failed");
    await this._step("fact-read", { kind: "revision-attempt", id: attemptId });
    await this._emit(preflight.session, preflight.recovery.safeStage);
    return { session: preflight.session, safeStage: preflight.recovery.safeStage, recovery: preflight.recovery, attempt };
  }

  async completeAfterScoreView(args = {}) {
    const scoreReportId = requiredString(args.scoreReportId, "scoreReportId");
    const preflight = await this._preflight(args, WritingStage.W8_SCORE_REWRITE, WritingStage.DONE);
    const alreadyViewed = preflight.session.stageFacts.viewedScoreReportIds.includes(scoreReportId);
    const completed = preflight.session.status === WritingSessionStatus.COMPLETED && alreadyViewed;
    if (preflight.session.status === WritingSessionStatus.COMPLETED) {
      if (!completed && !preflight.expectedMatches) throw commandError("stale-session", "Session revision is stale");
      if (preflight.session.currentStage !== WritingStage.DONE) throw commandError("illegal-transition", "Completed Session must remain DONE");
    } else {
      this._requireTransition(preflight, { completed });
    }
    const scoreReport = await this.repository.readScoreReport(scoreReportId);
    if (!scoreReport) throw commandError("dependent-record-missing", "ScoreReport does not exist");
    if (scoreReport.sessionId !== preflight.session.sessionId) throw commandError("lineage-mismatch", "ScoreReport belongs to another Session");
    const sourceAttempt = await this.repository.readAttempt(scoreReport.sourceAttemptId);
    try {
      assertScoreReportLineage(scoreReport, sourceAttempt);
    } catch (error) {
      throw commandError("lineage-mismatch", "ScoreReport source Attempt is invalid", error);
    }
    if (alreadyViewed) return this._finishExisting(preflight, { scoreReport });
    if (!preflight.expectedMatches) throw commandError("stale-session", "Session revision is stale");
    if (preflight.session.status !== WritingSessionStatus.COMPLETED && preflight.session.currentStage !== WritingStage.W8_SCORE_REWRITE) {
      throw commandError("illegal-transition", "Score view can only complete W8 or append to completed history");
    }
    const time = this.now();
    const firstCompletion = preflight.session.status !== WritingSessionStatus.COMPLETED;
    return this._saveSessionLast(preflight, {
      ...preflight.session,
      status: firstCompletion ? WritingSessionStatus.COMPLETED : preflight.session.status,
      currentStage: WritingStage.DONE,
      stageFacts: {
        ...preflight.session.stageFacts,
        viewedScoreReportIds: [...preflight.session.stageFacts.viewedScoreReportIds, scoreReportId],
        completedByScoreReportId: preflight.session.stageFacts.completedByScoreReportId ?? scoreReportId,
      },
      completedAt: preflight.session.completedAt ?? time,
      lastActiveAt: time,
      updatedAt: time,
    }, { scoreReport });
  }

  async inspectWritingRecovery(sessionId) {
    this._assertAccount();
    const id = requiredString(sessionId, "sessionId");
    const session = await this.repository.readSession(id);
    if (!session) throw commandError("dependent-record-missing", "Writing Session does not exist");
    if (session.username !== this.repository.username) throw commandError("account-mismatch", "Session belongs to another account");
    const diagnostics = [];
    const [revisionRows, snapshotRows, attemptRows] = await Promise.all([
      this.repository.listTranslationRevisions(),
      this.repository.listTranslationSnapshots(),
      this.repository.listAttempts(),
    ]);
    const revisions = damagedRows(revisionRows, "TranslationRevision", diagnostics)
      .filter((record) => record.sessionId === id && record.status === WritingDraftStatus.COMMITTED);
    const snapshots = damagedRows(snapshotRows, "TranslationSnapshot", diagnostics).filter((record) => record.sessionId === id);
    const attempts = damagedRows(attemptRows, "Attempt", diagnostics).filter((record) => record.sessionId === id);

    let translationRevision = null;
    let translationSnapshot = null;
    if (revisions.length) {
      const highest = Math.max(...revisions.map((record) => record.revisionNumber));
      const candidates = revisions.filter((record) => record.revisionNumber === highest);
      if (candidates.length === 1) translationRevision = candidates[0];
      else diagnostics.push({ code: "recovery-conflict", recordType: "TranslationRevision", revisionNumber: highest, ids: candidates.map((record) => record.revisionId).sort() });
    }
    if (translationRevision) {
      const candidates = snapshots.filter((record) => {
        try {
          return assertTranslationSnapshotLineage(record, translationRevision) === true;
        } catch {
          return false;
        }
      });
      if (candidates.length === 1) translationSnapshot = candidates[0];
      else if (candidates.length > 1) diagnostics.push({ code: "recovery-conflict", recordType: "TranslationSnapshot", ids: candidates.map((record) => record.snapshotId).sort() });
      else if (snapshots.some((record) => record.translationRevisionId === translationRevision.revisionId)) {
        diagnostics.push({ code: "lineage-mismatch", recordType: "TranslationSnapshot", revisionId: translationRevision.revisionId });
      }
    }

    function uniqueAttempt(candidates, recordType) {
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) diagnostics.push({ code: "recovery-conflict", recordType, ids: candidates.map((record) => record.attemptId).sort() });
      return null;
    }

    const backTranslationAttempt = translationSnapshot
      ? uniqueAttempt(attempts.filter((record) => record.attemptType === WritingAttemptType.BACK_TRANSLATION
          && record.status === WritingAttemptStatus.SUBMITTED
          && record.verifiedText
          && record.context.translationSnapshotId === translationSnapshot.snapshotId), "BackTranslationAttempt")
      : null;

    let skeletonRevision = null;
    let skeletonOutcome = session.stageFacts.w5Outcome;
    if (skeletonOutcome === WritingSkeletonOutcome.COMPLETED) {
      try {
        skeletonRevision = await this.repository.readSkeletonRevision(session.stageFacts.committedSkeletonRevisionId);
        if (!skeletonRevision || skeletonRevision.sessionId !== id || skeletonRevision.status !== WritingDraftStatus.COMMITTED) {
          diagnostics.push({ code: "dependent-record-missing", recordType: "SkeletonRevision", id: session.stageFacts.committedSkeletonRevisionId });
          skeletonRevision = null;
          skeletonOutcome = WritingSkeletonOutcome.NOT_REACHED;
        }
      } catch (error) {
        diagnostics.push({ code: "dependent-record-damaged", recordType: "SkeletonRevision", id: session.stageFacts.committedSkeletonRevisionId, errorCode: error.code || "damaged" });
        skeletonOutcome = WritingSkeletonOutcome.NOT_REACHED;
      }
    }

    const expectedSkeletonId = session.stageFacts.w5Outcome === WritingSkeletonOutcome.COMPLETED
      ? session.stageFacts.committedSkeletonRevisionId
      : null;
    const reconstructionCandidates = attempts.filter((record) => record.attemptType === WritingAttemptType.RECONSTRUCTION
      && record.context.skeletonRevisionId === expectedSkeletonId);
    let reconstructionAttempt = null;
    let reconstructionOutcome = session.stageFacts.w6Outcome;
    if (session.stageFacts.w6Outcome === WritingReconstructionOutcome.SUBMITTED) {
      reconstructionAttempt = attempts.find((record) => record.attemptId === session.stageFacts.w6AttemptId) || null;
      if (!reconstructionAttempt || reconstructionAttempt.status !== WritingAttemptStatus.SUBMITTED || reconstructionAttempt.context.skeletonRevisionId !== expectedSkeletonId) {
        diagnostics.push({ code: "lineage-mismatch", recordType: "ReconstructionAttempt", id: session.stageFacts.w6AttemptId });
        reconstructionAttempt = null;
        reconstructionOutcome = WritingReconstructionOutcome.NOT_REACHED;
      }
    } else if (session.stageFacts.w6Outcome === WritingReconstructionOutcome.NOT_REACHED) {
      const submitted = reconstructionCandidates.filter((record) => record.status === WritingAttemptStatus.SUBMITTED);
      reconstructionAttempt = uniqueAttempt(submitted.length ? submitted : reconstructionCandidates, "ReconstructionAttempt");
      if (submitted.length === 1) reconstructionOutcome = WritingReconstructionOutcome.SUBMITTED;
    }

    const independentAttempt = uniqueAttempt(attempts.filter((record) => record.attemptType === WritingAttemptType.INDEPENDENT
      && record.context.promptFingerprint === session.promptSnapshot.fingerprint
      && record.status === WritingAttemptStatus.SUBMITTED
      && record.verifiedText), "IndependentAttempt");

    const attemptsById = new Map(attempts.map((record) => [record.attemptId, record]));
    const validScores = new Map();
    if (independentAttempt) {
      const scoreRows = await this.repository.listScoreReports();
      const scores = damagedRows(scoreRows, "ScoreReport", diagnostics).filter((record) => record.sessionId === id);
      for (const score of scores) {
        try {
          assertScoreReportLineage(score, attemptsById.get(score.sourceAttemptId));
          validScores.set(score.scoreReportId, score);
        } catch (error) {
          diagnostics.push({ code: "lineage-mismatch", recordType: "ScoreReport", id: score.scoreReportId, errorCode: error.code || "lineage-mismatch" });
        }
      }
    }
    let completionScore = null;
    const completionId = session.stageFacts.completedByScoreReportId;
    if (completionId && session.stageFacts.viewedScoreReportIds.includes(completionId)) completionScore = validScores.get(completionId) || null;
    if (!completionScore) {
      for (const viewedId of session.stageFacts.viewedScoreReportIds) {
        if (validScores.has(viewedId)) {
          completionScore = validScores.get(viewedId);
          break;
        }
      }
    }
    if (completionId && !completionScore) diagnostics.push({ code: "dependent-record-missing", recordType: "ScoreReport", id: completionId });

    const facts = {
      sampleReadingCompleted: session.stageFacts.w1ReadingCompletedAt !== null,
      translationCompleted: translationSnapshot !== null,
      translationSnapshot: translationSnapshot ? { snapshotId: translationSnapshot.snapshotId } : null,
      backTranslationAttemptSubmitted: backTranslationAttempt !== null,
      comparisonCompleted: session.stageFacts.w4CompareCompletedAt !== null,
      skeletonOutcome,
      reconstructionOutcome,
      independentAttemptSubmitted: independentAttempt !== null,
      independentVerifiedTextPresent: independentAttempt?.verifiedText != null,
      scoreReport: completionScore ? { scoreReportId: completionScore.scoreReportId } : null,
      scoreViewed: completionScore !== null,
      revisionAttemptSubmitted: attempts.some((record) => record.attemptType === WritingAttemptType.REVISION && record.status === WritingAttemptStatus.SUBMITTED),
    };
    const safeStage = resolveSafeWritingStage({ currentStage: session.currentStage, facts });
    return {
      session,
      persistedStage: session.currentStage,
      safeStage,
      selectedRefs: {
        translationRevisionId: translationRevision?.revisionId || null,
        translationSnapshotId: translationSnapshot?.snapshotId || null,
        backTranslationAttemptId: backTranslationAttempt?.attemptId || null,
        skeletonRevisionId: skeletonRevision?.revisionId || null,
        reconstructionAttemptId: reconstructionAttempt?.attemptId || null,
        independentAttemptId: independentAttempt?.attemptId || null,
        completionScoreReportId: completionScore?.scoreReportId || null,
      },
      diagnostics,
    };
  }
}

export function createWritingCommandService(dependencies) {
  return new WritingCommandService(dependencies);
}
