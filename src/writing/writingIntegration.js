import { AppEvent } from "../events/eventTypes.js";
import { emitAppEvent } from "../events/appEvents.js";
import { getCurrentUsername as readCurrentUsername } from "../userData.js";
import { createWritingCommandService } from "./writingCommands.js";
import {
  WRITING_SCHEMA_VERSION,
  WritingAiArtifactType,
  WritingAttemptStatus,
  WritingAttemptType,
  WritingDraftStatus,
  WritingLearningItemOrigin,
  WritingReviewMode,
  WritingReviewStatus,
  WritingReviewType,
  WritingSessionStatus,
  WritingSkeletonOutcome,
  WritingStage,
} from "./writingModels.js";
import {
  canonicalWritingJson,
  fingerprintWritingRecord,
  WritingAccountMismatchError,
  WritingConflictError,
  writingReviewTaskId,
} from "./writingRepository.js";

export class WritingIntegrationError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "WritingIntegrationError";
    this.code = code;
  }
}

function requiredString(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new WritingIntegrationError("invalid-input", `${name} is required`);
  return result;
}

function nullableString(value, name) {
  if (value === null || value === undefined) return null;
  return requiredString(value, name);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function timestampDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new WritingIntegrationError("invalid-completion", "Session.completedAt is invalid");
  }
  return date;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function localCalendarDateFromTimestamp(value) {
  const date = timestampDate(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addLocalCalendarDays(value, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match || !Number.isInteger(days)) {
    throw new WritingIntegrationError("invalid-calendar-date", "A YYYY-MM-DD date and integer day offset are required");
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
    throw new WritingIntegrationError("invalid-calendar-date", "Calendar date is invalid");
  }
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function validRows(rows, recordType) {
  const damaged = (rows || []).find((row) => row?.damaged);
  if (damaged) {
    throw new WritingIntegrationError(
      "dependent-record-damaged",
      `${recordType} ${damaged.id || ""} is damaged`,
    );
  }
  return rows || [];
}

function sameSourceFields(existing, requested) {
  return canonicalWritingJson(existing) === canonicalWritingJson(requested);
}

export class WritingIntegrationService {
  constructor({
    repository,
    getCurrentUsername = readCurrentUsername,
    now = () => Date.now(),
    inspectWritingRecovery = null,
    emitLearningInvalidated = (payload) => emitAppEvent(AppEvent.LEARNING_STATE_INVALIDATED, payload),
  } = {}) {
    if (!repository) throw new TypeError("repository is required");
    this.repository = repository;
    this.getCurrentUsername = getCurrentUsername;
    this.now = now;
    this.emitLearningInvalidated = emitLearningInvalidated;
    const commandService = inspectWritingRecovery
      ? null
      : createWritingCommandService({ repository, getCurrentUsername, emitLearningInvalidated: () => {} });
    this.inspectWritingRecovery = inspectWritingRecovery
      || ((sessionId) => commandService.inspectWritingRecovery(sessionId));
  }

  _assertAccount() {
    const current = requiredString(this.getCurrentUsername?.(), "current username");
    if (current !== this.repository.username) {
      throw new WritingAccountMismatchError("The active account no longer matches this WritingRepository");
    }
    return current;
  }

  async _emit(source, details) {
    await this.emitLearningInvalidated({
      source,
      username: this.repository.username,
      ...details,
    });
  }

  async _validatedLearningItems(session) {
    const items = validRows(await this.repository.listLearningItems(), "WritingLearningItem")
      .filter((item) => item.sessionId === session.sessionId)
      .sort((a, b) => String(a.itemId).localeCompare(String(b.itemId)));
    const units = new Map(session.sampleEssaySnapshot.segments.map((unit) => [unit.unitId, unit]));
    for (const item of items) {
      if (item.sourceUnitId !== null) {
        const unit = units.get(item.sourceUnitId);
        if (!unit || !String(unit.text || "").includes(item.sourceText)) {
          throw new WritingIntegrationError("lineage-mismatch", `LearningItem ${item.itemId} has invalid sourceUnit lineage`);
        }
      }
      if (item.sourceAttemptId !== null) {
        const attempt = await this.repository.readAttempt(item.sourceAttemptId);
        const sourceText = attempt?.verifiedText?.text || attempt?.typedText || "";
        if (!attempt
          || attempt.username !== session.username
          || attempt.sessionId !== session.sessionId
          || attempt.status !== WritingAttemptStatus.SUBMITTED
          || !String(sourceText).includes(item.sourceText)) {
          throw new WritingIntegrationError("lineage-mismatch", `LearningItem ${item.itemId} has invalid sourceAttempt lineage`);
        }
      }
    }
    return items;
  }

  async _ensureReviewTask(candidate) {
    const existing = await this.repository.readReviewTask(candidate.taskId);
    if (existing) {
      const stableFieldsMatch = ["taskId", "sourceSessionId", "reviewType", "scheduledDate", "mode", "createdAt"]
        .every((field) => existing[field] === candidate[field]);
      let sourceRefsMatch = false;
      if (candidate.reviewType === WritingReviewType.D1) {
        sourceRefsMatch = existing.sourceRefs.translationSnapshotId === candidate.sourceRefs.translationSnapshotId
          && existing.sourceRefs.learningItemIds.every((id) => candidate.sourceRefs.learningItemIds.includes(id));
      } else if (candidate.reviewType === WritingReviewType.D3) {
        sourceRefsMatch = sameSourceFields(existing.sourceRefs, candidate.sourceRefs);
      } else if (candidate.reviewType === WritingReviewType.D7) {
        sourceRefsMatch = existing.sourceRefs.sourcePromptFingerprint === candidate.sourceRefs.sourcePromptFingerprint
          && existing.sourceRefs.learningItemIds.every((id) => candidate.sourceRefs.learningItemIds.includes(id));
      }
      if (stableFieldsMatch && sourceRefsMatch) return { task: existing, created: false };
      throw new WritingConflictError(`ReviewTask ${candidate.taskId} conflicts with its frozen source facts`);
    }
    const saved = await this.repository.saveReviewTask(candidate, { expectedRevision: 0 });
    const verified = await this.repository.readReviewTask(saved.taskId);
    if (!verified || verified.fingerprint !== saved.fingerprint) {
      throw new WritingIntegrationError("post-write-conflict", `ReviewTask ${saved.taskId} failed verification`);
    }
    return { task: verified, created: true };
  }

  async ensureWritingReviewTasksForCompletedSession({ sessionId } = {}) {
    this._assertAccount();
    const id = requiredString(sessionId, "sessionId");
    const recovery = await this.inspectWritingRecovery(id);
    const session = recovery.session;
    if (session.status !== WritingSessionStatus.COMPLETED || recovery.safeStage !== WritingStage.DONE) {
      throw new WritingIntegrationError("not-completed", "Review tasks require a completed Session with safeStage DONE");
    }
    const completionDate = localCalendarDateFromTimestamp(session.completedAt);
    const translationSnapshotId = recovery.selectedRefs.translationSnapshotId;
    const translationSnapshot = translationSnapshotId
      ? await this.repository.readTranslationSnapshot(translationSnapshotId)
      : null;
    if (!translationSnapshot || translationSnapshot.sessionId !== id || translationSnapshot.username !== session.username) {
      throw new WritingIntegrationError("lineage-mismatch", "D1 requires the canonical W3 TranslationSnapshot lineage");
    }

    const learningItems = await this._validatedLearningItems(session);
    const learningItemIds = learningItems.map((item) => item.itemId);
    let skeletonRevisionId = null;
    let d3Mode = WritingReviewMode.PROMPT_ONLY;
    if (session.stageFacts.w5Outcome === WritingSkeletonOutcome.COMPLETED) {
      skeletonRevisionId = session.stageFacts.committedSkeletonRevisionId;
      const skeleton = await this.repository.readSkeletonRevision(skeletonRevisionId);
      if (!skeleton
        || skeleton.username !== session.username
        || skeleton.sessionId !== id
        || skeleton.status !== WritingDraftStatus.COMMITTED
        || skeleton.revisionId !== recovery.selectedRefs.skeletonRevisionId) {
        throw new WritingIntegrationError("lineage-mismatch", "D3 requires the exact committed SkeletonRevision");
      }
      d3Mode = WritingReviewMode.SKELETON_ONLY;
    } else if (session.stageFacts.w5Outcome !== WritingSkeletonOutcome.SKIPPED) {
      throw new WritingIntegrationError("lineage-mismatch", "Completed Session has no terminal W5 outcome");
    }

    const createdAt = session.completedAt;
    const base = {
      schemaVersion: WRITING_SCHEMA_VERSION,
      username: session.username,
      sourceSessionId: id,
      status: WritingReviewStatus.PENDING,
      activeAttemptId: null,
      completedAttemptId: null,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
      revision: 0,
    };
    const candidates = [
      {
        ...base,
        taskId: writingReviewTaskId(id, WritingReviewType.D1),
        reviewType: WritingReviewType.D1,
        scheduledDate: addLocalCalendarDays(completionDate, 1),
        mode: null,
        sourceRefs: { translationSnapshotId, learningItemIds },
      },
      {
        ...base,
        taskId: writingReviewTaskId(id, WritingReviewType.D3),
        reviewType: WritingReviewType.D3,
        scheduledDate: addLocalCalendarDays(completionDate, 3),
        mode: d3Mode,
        sourceRefs: { skeletonRevisionId, promptFingerprint: session.promptSnapshot.fingerprint },
      },
      {
        ...base,
        taskId: writingReviewTaskId(id, WritingReviewType.D7),
        reviewType: WritingReviewType.D7,
        scheduledDate: addLocalCalendarDays(completionDate, 7),
        mode: null,
        sourceRefs: { learningItemIds, sourcePromptFingerprint: session.promptSnapshot.fingerprint },
      },
    ];

    const results = [];
    let createdCount = 0;
    for (const candidate of candidates) {
      const result = await this._ensureReviewTask(candidate);
      results.push(result.task);
      if (result.created) createdCount += 1;
    }
    if (createdCount > 0) {
      await this._emit("writing-review-scheduler", { sessionId: id, taskIds: results.map((task) => task.taskId) });
    }
    return { sessionId: id, tasks: results, createdCount };
  }

  async confirmWritingLearningItem({
    itemId,
    sessionId,
    sourceText,
    sourceUnitId = null,
    sourceAttemptId = null,
    sourceArtifactId = null,
    kind,
    origin,
    cueZh = null,
    confirmedAt = null,
  } = {}) {
    this._assertAccount();
    const id = requiredString(itemId, "itemId");
    const targetSessionId = requiredString(sessionId, "sessionId");
    const text = requiredString(sourceText, "sourceText");
    const unitId = nullableString(sourceUnitId, "sourceUnitId");
    const attemptId = nullableString(sourceAttemptId, "sourceAttemptId");
    if (unitId === null && attemptId === null) {
      throw new WritingIntegrationError("lineage-mismatch", "LearningItem requires sourceUnitId or sourceAttemptId");
    }
    if (!Object.values(WritingLearningItemOrigin).includes(origin)) {
      throw new WritingIntegrationError("invalid-origin", "LearningItem origin must be an explicit confirmation origin");
    }
    const session = await this.repository.readSession(targetSessionId);
    if (!session) throw new WritingIntegrationError("dependent-record-missing", "Writing Session does not exist");
    const unit = unitId === null
      ? null
      : session.sampleEssaySnapshot.segments.find((entry) => entry.unitId === unitId) || null;
    if (unitId !== null && (!unit || !String(unit.text || "").includes(text))) {
      throw new WritingIntegrationError("lineage-mismatch", "sourceText does not belong to sourceUnitId");
    }
    const attempt = attemptId === null ? null : await this.repository.readAttempt(attemptId);
    if (attemptId !== null) {
      const attemptText = attempt?.verifiedText?.text || attempt?.typedText || "";
      if (!attempt
        || attempt.username !== session.username
        || attempt.sessionId !== targetSessionId
        || attempt.status !== WritingAttemptStatus.SUBMITTED
        || !String(attemptText).includes(text)) {
        throw new WritingIntegrationError("lineage-mismatch", "sourceText does not belong to the submitted sourceAttemptId");
      }
    }
    if (origin === WritingLearningItemOrigin.AI_SUGGESTED_CONFIRMED) {
      const artifactId = requiredString(sourceArtifactId, "sourceArtifactId");
      const artifact = await this.repository.readAiArtifact(artifactId);
      const matchingUnit = artifact?.result?.units?.find((entry) => entry.unitId === unitId);
      const suggested = matchingUnit?.learnablePatterns?.some((pattern) => (
        pattern.sampleExcerpt === text || pattern.userExcerpt === text
      ));
      if (!artifact
        || artifact.username !== session.username
        || artifact.sessionId !== targetSessionId
        || artifact.sourceAttemptId !== attemptId
        || artifact.artifactType !== WritingAiArtifactType.COMPARE_DIAGNOSIS
        || !suggested) {
        throw new WritingIntegrationError("lineage-mismatch", "AI suggestion is not bound to the supplied Attempt/unit/artifact lineage");
      }
    }

    const existing = await this.repository.readLearningItem(id);
    const effectiveConfirmedAt = existing?.confirmedAt ?? confirmedAt ?? this.now();
    const candidate = {
      schemaVersion: WRITING_SCHEMA_VERSION,
      itemId: id,
      username: session.username,
      sessionId: targetSessionId,
      sourceText: text,
      sourceUnitId: unitId,
      sourceAttemptId: attemptId,
      kind,
      origin,
      cueZh: cueZh === null ? null : String(cueZh),
      confirmedAt: effectiveConfirmedAt,
    };
    if (existing) {
      const requested = await fingerprintWritingRecord(candidate);
      if (requested.fingerprint === existing.fingerprint) return { item: existing, created: false };
      throw new WritingConflictError(`LearningItem ${id} conflicts with its immutable confirmation`);
    }
    const saved = await this.repository.createLearningItem(candidate);
    const verified = await this.repository.readLearningItem(id);
    if (!verified || verified.fingerprint !== saved.fingerprint) {
      throw new WritingIntegrationError("post-write-conflict", `LearningItem ${id} failed verification`);
    }
    await this._emit("writing-learning-item-confirmation", { sessionId: targetSessionId, itemId: id });
    return { item: verified, created: true };
  }

  async updateWritingReviewTask({
    taskId,
    expectedRevision,
    status,
    activeAttemptId = undefined,
    completedAttemptId = undefined,
    completedAt = undefined,
  } = {}) {
    this._assertAccount();
    const id = requiredString(taskId, "taskId");
    const current = await this.repository.readReviewTask(id);
    if (!current) throw new WritingIntegrationError("dependent-record-missing", "Writing ReviewTask does not exist");
    if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw new WritingIntegrationError("stale-revision", "ReviewTask expectedRevision is stale");
    }
    const next = {
      ...current,
      status,
      activeAttemptId: activeAttemptId === undefined ? current.activeAttemptId : activeAttemptId,
      completedAttemptId: completedAttemptId === undefined ? current.completedAttemptId : completedAttemptId,
      completedAt: completedAt === undefined ? current.completedAt : completedAt,
      updatedAt: this.now(),
    };
    delete next.fingerprint;
    if (status === WritingReviewStatus.COMPLETED) {
      const attempt = await this.repository.readAttempt(next.completedAttemptId);
      const expectedType = {
        [WritingReviewType.D1]: WritingAttemptType.REVIEW_D1,
        [WritingReviewType.D3]: WritingAttemptType.REVIEW_D3,
        [WritingReviewType.D7]: WritingAttemptType.REVIEW_D7,
      }[current.reviewType];
      if (!attempt
        || attempt.username !== current.username
        || attempt.sessionId !== current.sourceSessionId
        || attempt.attemptType !== expectedType
        || attempt.status !== WritingAttemptStatus.SUBMITTED
        || attempt.context.reviewTaskId !== current.taskId) {
        throw new WritingIntegrationError("lineage-mismatch", "Completed ReviewTask requires its submitted review Attempt");
      }
    }
    const saved = await this.repository.saveReviewTask(next, { expectedRevision });
    const verified = await this.repository.readReviewTask(id);
    if (!verified || verified.fingerprint !== saved.fingerprint) {
      throw new WritingIntegrationError("post-write-conflict", `ReviewTask ${id} failed verification`);
    }
    await this._emit("writing-review-task", { sessionId: current.sourceSessionId, taskId: id, status: verified.status });
    return verified;
  }
}

export function createWritingIntegrationService(dependencies) {
  return new WritingIntegrationService(dependencies);
}
