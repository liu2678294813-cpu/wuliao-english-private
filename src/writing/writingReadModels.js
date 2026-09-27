import { getCurrentUsername as readCurrentUsername } from "../userData.js";
import { createWritingCommandService } from "./writingCommands.js";
import {
  WritingAiArtifactType,
  WritingAttemptStatus,
  WritingAttemptType,
  WritingDraftStatus,
  WritingSessionStatus,
  WritingSkeletonOutcome,
  WritingStage,
} from "./writingModels.js";
import {
  assertScoreReportLineage,
  WritingAccountMismatchError,
} from "./writingRepository.js";
import { sampleEssayDocument } from "./writingDocument.js";

export class WritingReadModelError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "WritingReadModelError";
    this.code = code;
  }
}

function requiredString(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new WritingReadModelError("invalid-input", `${name} is required`);
  return result;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function timestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function byCreatedThenId(idField) {
  return (left, right) => (
    timestampValue(left?.createdAt) - timestampValue(right?.createdAt)
    || String(left?.[idField] || "").localeCompare(String(right?.[idField] || ""))
  );
}

function latest(records, idField) {
  return [...records].sort(byCreatedThenId(idField)).at(-1) || null;
}

function validRows(rows, recordType, diagnostics) {
  return (rows || []).filter((row) => {
    if (!row?.damaged) return true;
    diagnostics.push({
      code: "dependent-record-damaged",
      recordType,
      id: row.id,
      errorCode: row.errorCode || "damaged",
    });
    return false;
  });
}

function projectAttemptInput(attempt) {
  if (!attempt) return null;
  return clone({
    attemptId: attempt.attemptId,
    status: attempt.status,
    inputMethod: attempt.inputMethod,
    typedText: attempt.typedText,
    inkRef: attempt.inkRef,
    transcriptionId: attempt.transcriptionId,
    verifiedText: attempt.verifiedText,
    rawSubmittedAt: attempt.rawSubmittedAt,
    submittedAt: attempt.submittedAt,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    revision: attempt.revision,
    fingerprint: attempt.fingerprint,
  });
}

function projectTranslationRevision(revision) {
  if (!revision) return null;
  return clone({
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    status: revision.status,
    units: revision.units,
    basedOnRevisionId: revision.basedOnRevisionId,
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
    revision: revision.revision,
    fingerprint: revision.fingerprint,
  });
}

function projectTranscriptionDraft(transcription) {
  if (!transcription) return null;
  return clone({
    transcriptionId: transcription.transcriptionId,
    rawTranscript: transcription.rawTranscript,
    segments: transcription.segments,
    createdAt: transcription.createdAt,
    fingerprint: transcription.fingerprint,
  });
}

function projectTranslationSnapshot(snapshot) {
  if (!snapshot) return null;
  return clone({
    snapshotId: snapshot.snapshotId,
    translationRevisionId: snapshot.translationRevisionId,
    revisionFingerprint: snapshot.revisionFingerprint,
    units: snapshot.units,
    createdAt: snapshot.createdAt,
    fingerprint: snapshot.fingerprint,
  });
}

function transcriptionState(attempt) {
  if (!attempt) return "not_started";
  if (attempt.status === WritingAttemptStatus.RAW_SUBMITTED) return "raw_submitted";
  if (attempt.status === WritingAttemptStatus.VERIFYING) return "verifying";
  if (attempt.status === WritingAttemptStatus.SUBMITTED && attempt.verifiedText) return "confirmed";
  return "drafting";
}

function baseStageModel(sessionId, safeStage) {
  return {
    sessionId,
    safeStage,
    stage: safeStage,
    stageMetadata: {
      id: safeStage,
      terminal: safeStage === WritingStage.DONE,
    },
  };
}

function reviewSummary(tasks) {
  const summary = { pending: 0, in_progress: 0, completed: 0, dismissed: 0 };
  for (const task of tasks) {
    if (Object.prototype.hasOwnProperty.call(summary, task.status)) summary[task.status] += 1;
  }
  return summary;
}

function projectScoreSummary(score) {
  if (!score) return null;
  return clone({
    scoreReportId: score.scoreReportId,
    sourceAttemptId: score.sourceAttemptId,
    finalScore: score.finalScore,
    maxScore: score.maxScore,
    band: score.band,
    rubricVersion: score.rubricVersion,
    createdAt: score.createdAt,
  });
}

export class WritingReadModelService {
  constructor({
    repository,
    getCurrentUsername = readCurrentUsername,
    inspectWritingRecovery = null,
  } = {}) {
    if (!repository) throw new TypeError("repository is required");
    this.repository = repository;
    this.getCurrentUsername = getCurrentUsername;
    const commandService = inspectWritingRecovery
      ? null
      : createWritingCommandService({
        repository,
        getCurrentUsername,
        emitLearningInvalidated: () => {},
      });
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

  async loadWritingWorkspace({ sessionId } = {}) {
    const id = requiredString(sessionId, "sessionId");
    try {
      this._assertAccount();
      const recovery = await this.inspectWritingRecovery(id);
      const diagnostics = clone(recovery.diagnostics || []);
      const stageViewModel = await this._buildStageViewModel(recovery, diagnostics);
      return {
        sessionId: id,
        safeStage: recovery.safeStage,
        sessionRevision: recovery.session.revision,
        sessionFingerprint: recovery.session.fingerprint,
        status: diagnostics.length
          ? "damaged"
          : recovery.session.status === WritingSessionStatus.COMPLETED
            ? "completed"
            : "active",
        stageViewModel,
        diagnostics,
      };
    } catch (error) {
      const code = error?.code || "damaged";
      const accountMismatch = code === "account-mismatch" || code === "account_mismatch";
      const sourceMismatch = code === "source-mismatch" || code === "source_mismatch";
      const notFound = code === "not-found" || code === "not_found" || code === "dependent-record-missing";
      const repositoryError = code === "repository-error" || code === "repository_error" || code === "storage-error";
      return {
        sessionId: id,
        safeStage: null,
        status: accountMismatch
          ? "account_mismatch"
          : sourceMismatch
            ? "source_mismatch"
            : notFound
              ? "not_found"
              : repositoryError
                ? "repository_error"
                : "damaged",
        stageViewModel: null,
        diagnostics: [{ code, message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  async buildWritingStageViewModel({ sessionId } = {}) {
    return (await this.loadWritingWorkspace({ sessionId })).stageViewModel;
  }

  async _sessionAttempts(sessionId, diagnostics) {
    const rows = await this.repository.listAttempts();
    return validRows(rows, "Attempt", diagnostics).filter((record) => record.sessionId === sessionId);
  }

  async _buildStageViewModel(recovery, diagnostics) {
    const { session, safeStage, selectedRefs } = recovery;
    const base = baseStageModel(session.sessionId, safeStage);

    if (safeStage === WritingStage.W1_SAMPLE_READING) {
      return {
        ...base,
        promptSnapshot: clone(session.promptSnapshot),
        sampleEssaySnapshot: clone(session.sampleEssaySnapshot),
        readingCompleted: session.stageFacts.w1ReadingCompletedAt !== null,
      };
    }

    if (safeStage === WritingStage.W2_EN_ZH) {
      const revisions = validRows(
        await this.repository.listTranslationRevisions(),
        "TranslationRevision",
        diagnostics,
      ).filter((record) => record.sessionId === session.sessionId);
      const current = [...revisions].sort((a, b) => (
        a.revisionNumber - b.revisionNumber
        || String(a.revisionId).localeCompare(String(b.revisionId))
      )).at(-1) || null;
      return {
        ...base,
        promptSnapshot: clone(session.promptSnapshot),
        sampleEssayText: sampleEssayDocument(session.sampleEssaySnapshot),
        sampleSegments: clone(session.sampleEssaySnapshot.segments),
        currentTranslationRevision: projectTranslationRevision(current),
        translationInkRef: clone(current?.units?.find((unit) => unit.inkRef)?.inkRef || null),
      };
    }

    if (safeStage === WritingStage.W3_BACK_TRANSLATION) {
      const snapshot = await this.repository.readTranslationSnapshot(selectedRefs.translationSnapshotId);
      if (!snapshot) throw new WritingReadModelError("dependent-record-missing", "Safe W3 requires TranslationSnapshot");
      const attempts = await this._sessionAttempts(session.sessionId, diagnostics);
      const current = latest(attempts.filter((record) => (
        record.attemptType === WritingAttemptType.BACK_TRANSLATION
        && record.context.translationSnapshotId === snapshot.snapshotId
      )), "attemptId");
      const transcription = current?.transcriptionId
        ? await this.repository.readTranscription(current.transcriptionId)
        : null;
      return {
        ...base,
        translationSnapshot: projectTranslationSnapshot(snapshot),
        currentBackTranslationAttempt: projectAttemptInput(current),
        transcriptionDraft: projectTranscriptionDraft(transcription),
        transcriptionVerificationState: transcriptionState(current),
      };
    }

    if (safeStage === WritingStage.W4_COMPARE_DIAGNOSE) {
      const [snapshot, attempt, artifactRows] = await Promise.all([
        this.repository.readTranslationSnapshot(selectedRefs.translationSnapshotId),
        this.repository.readAttempt(selectedRefs.backTranslationAttemptId),
        this.repository.listAiArtifacts(),
      ]);
      const artifacts = validRows(artifactRows, "WritingAiArtifact", diagnostics)
        .filter((record) => record.sessionId === session.sessionId
          && record.sourceAttemptId === attempt?.attemptId
          && record.artifactType === WritingAiArtifactType.COMPARE_DIAGNOSIS);
      const latestArtifact = latest(artifacts, "artifactId");
      return {
        ...base,
        translationSnapshot: projectTranslationSnapshot(snapshot),
        submittedBackTranslation: projectAttemptInput(attempt),
        sampleEssayText: sampleEssayDocument(session.sampleEssaySnapshot),
        sampleSegments: clone(session.sampleEssaySnapshot.segments),
        compareDiagnosis: clone(latestArtifact?.result || null),
        compareDiagnosisArtifactId: latestArtifact?.artifactId || null,
        comparisonCompleted: session.stageFacts.w4CompareCompletedAt !== null,
      };
    }

    if (safeStage === WritingStage.W5_SKELETON) {
      const revisions = validRows(
        await this.repository.listSkeletonRevisions(),
        "SkeletonRevision",
        diagnostics,
      ).filter((record) => record.sessionId === session.sessionId);
      const current = [...revisions].sort((a, b) => (
        a.revisionNumber - b.revisionNumber
        || String(a.revisionId).localeCompare(String(b.revisionId))
      )).at(-1) || null;
      return {
        ...base,
        promptSnapshot: clone(session.promptSnapshot),
        currentSkeletonRevision: clone(current),
      };
    }

    if (safeStage === WritingStage.W6_RECONSTRUCTION) {
      const skeletonRevisionId = session.stageFacts.w5Outcome === WritingSkeletonOutcome.COMPLETED
        ? session.stageFacts.committedSkeletonRevisionId
        : null;
      const [attempts, skeletonRevision] = await Promise.all([
        this._sessionAttempts(session.sessionId, diagnostics),
        skeletonRevisionId ? this.repository.readSkeletonRevision(skeletonRevisionId) : null,
      ]);
      const current = latest(attempts.filter((record) => (
        record.attemptType === WritingAttemptType.RECONSTRUCTION
        && record.context.skeletonRevisionId === skeletonRevisionId
      )), "attemptId");
      return {
        ...base,
        skeletonRevisionId,
        skeletonRevision: skeletonRevision ? clone({
          revisionId: skeletonRevision.revisionId,
          blocks: skeletonRevision.blocks,
          fingerprint: skeletonRevision.fingerprint,
        }) : null,
        currentReconstructionAttempt: projectAttemptInput(current),
      };
    }

    if (safeStage === WritingStage.W7_INDEPENDENT) {
      const attempts = await this._sessionAttempts(session.sessionId, diagnostics);
      const current = latest(attempts.filter((record) => (
        record.attemptType === WritingAttemptType.INDEPENDENT
        && record.context.promptFingerprint === session.promptSnapshot.fingerprint
      )), "attemptId");
      const transcription = current?.transcriptionId
        ? await this.repository.readTranscription(current.transcriptionId)
        : null;
      return {
        ...base,
        promptSnapshot: clone(session.promptSnapshot),
        currentIndependentAttempt: projectAttemptInput(current),
        inputMethod: current?.inputMethod || null,
        inkRef: clone(current?.inkRef || null),
        transcriptionDraft: projectTranscriptionDraft(transcription),
        transcriptionVerificationState: transcriptionState(current),
        ...(current?.verifiedText ? { verifiedText: clone(current.verifiedText) } : {}),
      };
    }

    if (safeStage === WritingStage.W8_SCORE_REWRITE) {
      const attempts = await this._sessionAttempts(session.sessionId, diagnostics);
      const attemptsById = new Map(attempts.map((record) => [record.attemptId, record]));
      const independentAttempt = attemptsById.get(selectedRefs.independentAttemptId) || null;
      const scores = validRows(await this.repository.listScoreReports(), "ScoreReport", diagnostics)
        .filter((record) => record.sessionId === session.sessionId
          && record.sourceAttemptId === independentAttempt?.attemptId)
        .filter((record) => {
          try {
            return assertScoreReportLineage(record, attemptsById.get(record.sourceAttemptId));
          } catch (error) {
            diagnostics.push({ code: "lineage-mismatch", recordType: "ScoreReport", id: record.scoreReportId, errorCode: error.code || "lineage-mismatch" });
            return false;
          }
        })
        .sort(byCreatedThenId("scoreReportId"));
      const allRevisions = attempts.filter((record) => (
        record.attemptType === WritingAttemptType.REVISION
        && record.parentAttemptId === independentAttempt?.attemptId
      )).sort(byCreatedThenId("attemptId"));
      const revisions = allRevisions.filter((record) => record.status === WritingAttemptStatus.SUBMITTED);
      const revisionIds = new Set(revisions.map((record) => record.attemptId));
      const referenceRewrites = validRows(
        await this.repository.listAiArtifacts(),
        "WritingAiArtifact",
        diagnostics,
      ).filter((record) => record.sessionId === session.sessionId
        && record.artifactType === WritingAiArtifactType.REFERENCE_REWRITE
        && revisionIds.has(record.sourceAttemptId));
      return {
        ...base,
        promptSnapshot: clone(session.promptSnapshot),
        submittedIndependentAttempt: projectAttemptInput(independentAttempt),
        scoreReports: clone(scores),
        revisionAttempts: clone(revisions),
        currentRevisionAttempt: projectAttemptInput(allRevisions.at(-1) || null),
        referenceRewriteArtifacts: clone(referenceRewrites),
        scoreViewed: scores.some((score) => session.stageFacts.viewedScoreReportIds.includes(score.scoreReportId)),
      };
    }

    const [completionScore, scoreRows, reviewRows] = await Promise.all([
      selectedRefs.completionScoreReportId
        ? this.repository.readScoreReport(selectedRefs.completionScoreReportId)
        : null,
      this.repository.listScoreReports(),
      this.repository.listReviewTasks(),
    ]);
    const sessionScores = validRows(scoreRows, "ScoreReport", diagnostics)
      .filter((record) => record.sessionId === session.sessionId)
      .sort(byCreatedThenId("scoreReportId"));
    const sessionReviews = validRows(reviewRows, "WritingReviewTask", diagnostics)
      .filter((record) => record.sourceSessionId === session.sessionId);
    return {
      ...base,
      completedAt: session.completedAt,
      completionScore: clone(completionScore),
      latestScore: clone(sessionScores.at(-1) || null),
      reviewStatusSummary: reviewSummary(sessionReviews),
    };
  }

  async buildWritingLibrary() {
    this._assertAccount();
    const diagnostics = [];
    const [sessionRows, attemptRows, scoreRows, reviewRows] = await Promise.all([
      this.repository.listSessions(),
      this.repository.listAttempts(),
      this.repository.listScoreReports(),
      this.repository.listReviewTasks(),
    ]);
    const damagedItems = (sessionRows || []).filter((row) => row?.damaged).map((row) => ({
      sessionId: row.id,
      status: "damaged",
      errorCode: row.errorCode || "damaged",
    }));
    const sessions = validRows(sessionRows, "WritingSession", diagnostics);
    const attempts = validRows(attemptRows, "Attempt", diagnostics);
    const attemptsById = new Map(attempts.map((record) => [record.attemptId, record]));
    const scores = validRows(scoreRows, "ScoreReport", diagnostics).filter((score) => {
      try {
        return assertScoreReportLineage(score, attemptsById.get(score.sourceAttemptId));
      } catch (error) {
        diagnostics.push({ code: "lineage-mismatch", recordType: "ScoreReport", id: score.scoreReportId, errorCode: error.code || "lineage-mismatch" });
        return false;
      }
    });
    const reviews = validRows(reviewRows, "WritingReviewTask", diagnostics);
    const recoveries = new Map();
    await Promise.all(sessions.filter((session) => session.status === WritingSessionStatus.ACTIVE).map(async (session) => {
      try {
        recoveries.set(session.sessionId, await this.inspectWritingRecovery(session.sessionId));
      } catch (error) {
        diagnostics.push({ code: error?.code || "damaged", recordType: "WritingSession", id: session.sessionId });
      }
    }));
    const items = sessions.flatMap((session) => {
      const recovery = session.status === WritingSessionStatus.ACTIVE ? recoveries.get(session.sessionId) : null;
      if (session.status === WritingSessionStatus.ACTIVE && !recovery) {
        damagedItems.push({ sessionId: session.sessionId, status: "damaged", errorCode: "recovery-failed" });
        return [];
      }
      const sessionScores = scores.filter((score) => score.sessionId === session.sessionId)
        .sort(byCreatedThenId("scoreReportId"));
      return [{
        sessionId: session.sessionId,
        status: session.status === WritingSessionStatus.COMPLETED ? "completed" : "active",
        safeStage: session.status === WritingSessionStatus.COMPLETED ? WritingStage.DONE : recovery.safeStage,
        taskType: session.taskType,
        year: session.year,
        promptText: session.promptSnapshot.promptText,
        startedAt: session.startedAt,
        lastActiveAt: session.lastActiveAt,
        completedAt: session.completedAt,
        completionScore: projectScoreSummary(sessionScores.find((score) => score.scoreReportId === session.stageFacts.completedByScoreReportId) || null),
        latestScore: projectScoreSummary(sessionScores.at(-1) || null),
        reviewStatusSummary: reviewSummary(reviews.filter((task) => task.sourceSessionId === session.sessionId)),
      }];
    }).sort((left, right) => timestampValue(right.lastActiveAt || right.completedAt) - timestampValue(left.lastActiveAt || left.completedAt));
    return {
      activeItems: items.filter((item) => item.status === "active"),
      completedItems: items.filter((item) => item.status === "completed"),
      damagedItems,
      diagnostics,
    };
  }

  async buildWritingArchiveList() {
    this._assertAccount();
    const diagnostics = [];
    const [sessionRows, attemptRows, scoreRows, reviewRows] = await Promise.all([
      this.repository.listSessions(),
      this.repository.listAttempts(),
      this.repository.listScoreReports(),
      this.repository.listReviewTasks(),
    ]);
    const damagedSessions = (sessionRows || []).filter((row) => row?.damaged).map((row) => ({
      sessionId: row.id,
      status: "damaged",
      errorCode: row.errorCode || "damaged",
    }));
    const sessions = validRows(sessionRows, "WritingSession", diagnostics)
      .filter((session) => session.status === WritingSessionStatus.COMPLETED);
    const attempts = validRows(attemptRows, "Attempt", diagnostics);
    const attemptsById = new Map(attempts.map((record) => [record.attemptId, record]));
    const scores = validRows(scoreRows, "ScoreReport", diagnostics).filter((score) => {
      try {
        return assertScoreReportLineage(score, attemptsById.get(score.sourceAttemptId));
      } catch (error) {
        diagnostics.push({ code: "lineage-mismatch", recordType: "ScoreReport", id: score.scoreReportId, errorCode: error.code || "lineage-mismatch" });
        return false;
      }
    });
    const reviews = validRows(reviewRows, "WritingReviewTask", diagnostics);
    const items = sessions.map((session) => {
      const sessionScores = scores.filter((score) => score.sessionId === session.sessionId)
        .sort(byCreatedThenId("scoreReportId"));
      const sessionReviews = reviews.filter((task) => task.sourceSessionId === session.sessionId);
      return {
        sessionId: session.sessionId,
        taskType: session.taskType,
        year: session.year,
        completedAt: session.completedAt,
        completionScore: projectScoreSummary(sessionScores.find((score) => score.scoreReportId === session.stageFacts.completedByScoreReportId) || null),
        latestScore: projectScoreSummary(sessionScores.at(-1) || null),
        scoreCount: sessionScores.length,
        reviewStatusSummary: reviewSummary(sessionReviews),
      };
    }).sort((a, b) => timestampValue(b.completedAt) - timestampValue(a.completedAt)
      || a.sessionId.localeCompare(b.sessionId));
    return { items: [...items, ...damagedSessions], diagnostics };
  }

  async buildWritingArchiveDetail({ sessionId } = {}) {
    this._assertAccount();
    const id = requiredString(sessionId, "sessionId");
    const session = await this.repository.readSession(id);
    if (!session) throw new WritingReadModelError("dependent-record-missing", "Writing Session does not exist");
    const diagnostics = [];
    const [translationRows, snapshotRows, attemptRows, skeletonRows, scoreRows, artifactRows, learningRows, reviewRows] = await Promise.all([
      this.repository.listTranslationRevisions(),
      this.repository.listTranslationSnapshots(),
      this.repository.listAttempts(),
      this.repository.listSkeletonRevisions(),
      this.repository.listScoreReports(),
      this.repository.listAiArtifacts(),
      this.repository.listLearningItems(),
      this.repository.listReviewTasks(),
    ]);
    const attempts = validRows(attemptRows, "Attempt", diagnostics).filter((record) => record.sessionId === id);
    const attemptsById = new Map(attempts.map((record) => [record.attemptId, record]));
    const scores = validRows(scoreRows, "ScoreReport", diagnostics)
      .filter((record) => record.sessionId === id)
      .filter((record) => {
        try {
          return assertScoreReportLineage(record, attemptsById.get(record.sourceAttemptId));
        } catch (error) {
          diagnostics.push({ code: "lineage-mismatch", recordType: "ScoreReport", id: record.scoreReportId, errorCode: error.code || "lineage-mismatch" });
          return false;
        }
      }).sort(byCreatedThenId("scoreReportId"));
    const translationRevisions = validRows(translationRows, "TranslationRevision", diagnostics).filter((record) => record.sessionId === id);
    const translationSnapshots = validRows(snapshotRows, "TranslationSnapshot", diagnostics).filter((record) => record.sessionId === id);
    const skeletonRevisions = validRows(skeletonRows, "SkeletonRevision", diagnostics).filter((record) => record.sessionId === id);
    const aiArtifacts = validRows(artifactRows, "WritingAiArtifact", diagnostics).filter((record) => record.sessionId === id);
    const learningItems = validRows(learningRows, "WritingLearningItem", diagnostics).filter((record) => record.sessionId === id);
    const reviewTasks = validRows(reviewRows, "WritingReviewTask", diagnostics).filter((record) => record.sourceSessionId === id);
    return {
      sessionId: id,
      status: diagnostics.length ? "damaged" : "ok",
      taskType: session.taskType,
      year: session.year,
      completedAt: session.completedAt,
      promptSnapshot: clone(session.promptSnapshot),
      sampleEssaySnapshot: clone(session.sampleEssaySnapshot),
      translationRevisions: clone(translationRevisions),
      translationSnapshots: clone(translationSnapshots),
      attempts: clone(attempts),
      skeletonRevisions: clone(skeletonRevisions),
      completionScore: clone(scores.find((score) => score.scoreReportId === session.stageFacts.completedByScoreReportId) || null),
      latestScore: clone(scores.at(-1) || null),
      scoreTrend: clone(scores),
      aiArtifacts: clone(aiArtifacts),
      learningItems: clone(learningItems),
      reviewTasks: clone(reviewTasks),
      diagnostics,
    };
  }
}

export function createWritingReadModelService(dependencies) {
  return new WritingReadModelService(dependencies);
}
