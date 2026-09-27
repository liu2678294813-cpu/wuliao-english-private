import { getUserItem, setUserItem } from "./userData";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";

export const READING_FLOW_SCHEMA_VERSION = 2;

export const STAGES = [
  { id: "deep-cover", label: "导读" },
  { id: "deep-first-read", label: "审题" },
  { id: "deep-clean-text", label: "限时读文" },
  { id: "deep-first-quiz", label: "初做" },
  { id: "deep-translation", label: "逐段精读" },
  { id: "deep-redo", label: "重做" },
  { id: "deep-review", label: "复读压缩" },
];

export const STAGE_IDS = STAGES.map((stage) => stage.id);

export const STAGE_LABELS = Object.fromEntries(STAGES.map((stage) => [stage.id, stage.label]));

const TIMED_PHASES = ["idle", "running", "paused", "done"];

export function flowStorageKey(resourceId, passageId) {
  return `wuliao:reading-flow:${resourceId}:${passageId}`;
}

function readJson(key, fallback = null) {
  try {
    return JSON.parse(getUserItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function stageIndex(stageId) {
  const index = STAGE_IDS.indexOf(stageId);
  return index < 0 ? 0 : index;
}

function normalizedStatus(value) {
  return ["completed", "current", "pending", "skipped"].includes(value) ? value : "pending";
}

function cloneFlow(flow) {
  return {
    ...flow,
    stages: Object.fromEntries(STAGES.map((stage) => [
      stage.id,
      {
        status: normalizedStatus(flow?.stages?.[stage.id]?.status),
        completedAt: flow?.stages?.[stage.id]?.completedAt != null
          && Number.isFinite(Number(flow?.stages?.[stage.id]?.completedAt))
          ? Number(flow.stages[stage.id].completedAt)
          : null,
        ...(flow?.stages?.[stage.id]?.visitedAt != null && Number.isFinite(Number(flow.stages[stage.id].visitedAt))
          ? { visitedAt: Number(flow.stages[stage.id].visitedAt) } : {}),
      },
    ])),
    timedReading: { ...(flow?.timedReading || {}) },
  };
}

export function emptyFlow(resourceId, passageId, now = Date.now()) {
  return {
    schemaVersion: READING_FLOW_SCHEMA_VERSION,
    resourceId,
    passageId,
    stages: Object.fromEntries(STAGES.map((stage) => [
      stage.id,
      {
        status: stage.id === "deep-cover" ? "current" : "pending",
        completedAt: null,
      },
    ])),
    currentStage: "deep-cover",
    timedReading: {
      phase: "idle",
      elapsedMs: 0,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
    },
    updatedAt: now,
  };
}

export function normalizeFlow(flow) {
  if (!flow) return null;
  const next = cloneFlow(flow);
  next.schemaVersion = READING_FLOW_SCHEMA_VERSION;
  next.resourceId = String(flow.resourceId || "");
  next.passageId = String(flow.passageId || "");

  const terminal = (id) => ["completed", "skipped"].includes(next.stages[id].status);
  const firstOpen = STAGES.find((stage) => !terminal(stage.id));
  // v1 inferred the stage from completion. v2 explicitly persists navigation.
  next.currentStage = Number(flow.schemaVersion) >= 2 && STAGE_IDS.includes(flow.currentStage)
    ? flow.currentStage : firstOpen ? firstOpen.id : "deep-review";
  for (const stage of STAGES) {
    if (!terminal(stage.id) && stage.id !== next.currentStage) {
      next.stages[stage.id].status = "pending";
    }
  }
  if (!terminal(next.currentStage)) {
    next.stages[next.currentStage].status = "current";
  }

  const timed = flow.timedReading || {};
  next.timedReading = {
    phase: TIMED_PHASES.includes(timed.phase) ? timed.phase : "idle",
    elapsedMs: Math.max(0, Number(timed.elapsedMs) || 0),
    startedAt: timed.startedAt != null && Number.isFinite(Number(timed.startedAt)) ? Number(timed.startedAt) : null,
    pausedAt: timed.pausedAt != null && Number.isFinite(Number(timed.pausedAt)) ? Number(timed.pausedAt) : null,
    completedAt: timed.completedAt != null && Number.isFinite(Number(timed.completedAt)) ? Number(timed.completedAt) : null,
  };
  next.updatedAt = Number(flow.updatedAt) || Date.now();
  return next;
}

export function deriveFlow({
  stored = null,
  readingActivity = null,
  position = null,
  firstAnswers = null,
  redoAnswers = null,
  resourceId = "",
  passageId = "",
  now = Date.now(),
} = {}) {
  if (stored) {
    const normalized = normalizeFlow(stored);
    if (normalized) return normalized;
  }

  if (readingActivity?.completed) {
    const flow = emptyFlow(resourceId, passageId, now);
    const completedAt = readingActivity.completedAt || now;
    for (const stage of STAGES) {
      flow.stages[stage.id] = { status: "completed", completedAt };
    }
    flow.currentStage = "deep-review";
    flow.timedReading = {
      phase: "done",
      elapsedMs: 0,
      startedAt: null,
      pausedAt: null,
      completedAt,
    };
    flow.updatedAt = now;
    return flow;
  }

  let hintIndex = 0;
  const positionMatches = Boolean(
    position
      && position.passageId === passageId
      && STAGE_IDS.includes(position.anchorId),
  );
  if (positionMatches) hintIndex = Math.max(hintIndex, stageIndex(position.anchorId));
  if (firstAnswers && Object.keys(firstAnswers).length) {
    hintIndex = Math.max(hintIndex, stageIndex("deep-translation"));
  }
  if (redoAnswers && Object.keys(redoAnswers).length) {
    hintIndex = Math.max(hintIndex, stageIndex("deep-redo"));
  }

  const flow = emptyFlow(resourceId, passageId, now);
  STAGE_IDS.forEach((id, index) => {
    if (index < hintIndex) flow.stages[id] = { status: "completed", completedAt: null };
    else if (index === hintIndex) flow.stages[id] = { status: "current", completedAt: null };
    else flow.stages[id] = { status: "pending", completedAt: null };
  });
  flow.currentStage = STAGE_IDS[hintIndex];
  if (hintIndex > stageIndex("deep-clean-text")) {
    flow.timedReading = {
      phase: "done",
      elapsedMs: 0,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
    };
  }
  flow.updatedAt = now;
  return flow;
}

export function getReadingFlow(resourceId, passageId) {
  const stored = readJson(flowStorageKey(resourceId, passageId), null);
  const readingActivity = readJson(`wuliao:reading-activity:${resourceId}:${passageId}`, null);
  const position = readJson(`wuliao:deep-position:${resourceId}`, null);
  const deepFirst = readJson(`wuliao:deep-answers:${resourceId}:${passageId}:first`, {});
  const legacyFirst = readJson(`wuliao:answers:${resourceId}`, {});
  const firstAnswers = Object.keys(deepFirst).length ? deepFirst : legacyFirst;
  const redoAnswers = readJson(`wuliao:deep-answers:${resourceId}:${passageId}:redo`, {});
  return deriveFlow({
    stored,
    readingActivity,
    position,
    firstAnswers,
    redoAnswers,
    resourceId,
    passageId,
  });
}

export function saveReadingFlow(flow) {
  if (!flow?.resourceId || !flow?.passageId) return;
  setUserItem(flowStorageKey(flow.resourceId, flow.passageId), JSON.stringify(flow));
  emitAppEvent(AppEvent.LEARNING_STATE_INVALIDATED);
}

export function currentStageOf(flow) {
  return flow?.currentStage || "deep-cover";
}

export function isStageLocked(flow, stageId) {
  if (stageId === "deep-redo") return false;
  const reached = Math.max(stageIndex(currentStageOf(flow)), ...STAGE_IDS
    .filter((id) => ["completed", "skipped"].includes(flow?.stages?.[id]?.status)
      || (flow?.stages?.[id]?.visitedAt != null && Number.isFinite(Number(flow.stages[id].visitedAt)))).map(stageIndex));
  return stageIndex(stageId) > reached;
}

export function isWorkflowCompleted(flow) {
  return Boolean(flow) && flow.stages?.["deep-review"]?.status === "completed"
    && STAGES.every((stage) => ["completed", "skipped"].includes(flow.stages?.[stage.id]?.status));
}

export function activeQuestionAttempt(flow) {
  return currentStageOf(flow) === "deep-redo" ? "redo" : "first";
}

// Explicit learning navigation; looking at source text does not call this.
export function enterReadingStage(flow, stageId, now = Date.now()) {
  if (!flow?.stages?.[stageId] || isStageLocked(flow, stageId)) return flow;
  let next = cloneFlow(flow);
  if (next.timedReading.phase === "running" && stageId !== "deep-clean-text" && stageId !== "deep-first-quiz") {
    next = pauseTimedReading(next, now);
  }
  if (stageId === "deep-redo") {
    for (const id of STAGE_IDS.slice(0, stageIndex(stageId))) {
      if (next.stages[id].status !== "completed") next.stages[id] = { status: "skipped", completedAt: null };
    }
  }
  // Reached and completed are different facts. Remember leaving an unfinished
  // stage in the canonical flow so returning to it cannot re-lock it.
  const previous = next.stages[next.currentStage];
  if (previous?.status === "current") previous.visitedAt ??= now;
  for (const id of STAGE_IDS) {
    if (id !== stageId && next.stages[id].status === "current") next.stages[id].status = "pending";
  }
  next.currentStage = stageId;
  if (next.stages[stageId].status !== "completed") next.stages[stageId] = { ...next.stages[stageId], status: "current", completedAt: null, visitedAt: next.stages[stageId].visitedAt ?? now };
  next.updatedAt = now;
  return next;
}

export function hasAllQuestionsAnswered(questions, answers) {
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) return true;
  return list.every((question) => Boolean(answers?.[question.number]));
}

export function completeStage(flow, stageId, now = Date.now()) {
  if (!flow?.stages?.[stageId]) return flow;
  if (flow.stages[stageId].status === "completed") return flow;
  const isCurrentStage = flow.currentStage === stageId || flow.stages[stageId].status === "current";
  if (!isCurrentStage) return flow;

  const next = cloneFlow(flow);
  next.stages[stageId] = { status: "completed", completedAt: now };
  const nextStage = STAGES[stageIndex(stageId) + 1];
  if (nextStage) {
    next.currentStage = nextStage.id;
    if (next.stages[nextStage.id].status !== "completed") next.stages[nextStage.id] = { status: "current", completedAt: null };
  } else {
    next.currentStage = stageId;
  }
  next.updatedAt = now;
  return next;
}

function isCleanTextCurrent(flow) {
  return flow?.currentStage === "deep-clean-text";
}

function isInitialStageCurrent(flow) {
  return flow?.currentStage === "deep-clean-text" || flow?.currentStage === "deep-first-quiz";
}

export function enterInitialStage(flow, now = Date.now()) {
  if (!isCleanTextCurrent(flow)) return flow;
  const next = cloneFlow(flow);
  if (next.timedReading.phase === "idle") {
    next.timedReading = {
      ...next.timedReading,
      phase: "running",
      elapsedMs: 0,
      startedAt: now,
      pausedAt: null,
      completedAt: null,
    };
  }
  next.stages["deep-clean-text"] = { status: "completed", completedAt: now };
  next.currentStage = "deep-first-quiz";
  next.stages["deep-first-quiz"] = { status: "current", completedAt: null };
  next.updatedAt = now;
  return next;
}

export function startTimedReading(flow, now = Date.now()) {
  if (!isCleanTextCurrent(flow) || flow.timedReading.phase !== "idle") return flow;
  const next = cloneFlow(flow);
  next.timedReading = {
    ...next.timedReading,
    phase: "running",
    elapsedMs: 0,
    startedAt: now,
    pausedAt: null,
    completedAt: null,
  };
  next.updatedAt = now;
  return next;
}

export function pauseTimedReading(flow, now = Date.now()) {
  if (!isInitialStageCurrent(flow) || flow.timedReading.phase !== "running") return flow;
  const next = cloneFlow(flow);
  const elapsed = next.timedReading.elapsedMs + Math.max(0, now - next.timedReading.startedAt);
  next.timedReading = {
    ...next.timedReading,
    phase: "paused",
    elapsedMs: elapsed,
    startedAt: null,
    pausedAt: now,
  };
  next.updatedAt = now;
  return next;
}

export function resumeTimedReading(flow, now = Date.now()) {
  if (!isInitialStageCurrent(flow) || flow.timedReading.phase !== "paused") return flow;
  const next = cloneFlow(flow);
  next.timedReading = {
    ...next.timedReading,
    phase: "running",
    startedAt: now,
    pausedAt: null,
  };
  next.updatedAt = now;
  return next;
}

export function finishTimedReading(flow, now = Date.now()) {
  if (!isInitialStageCurrent(flow)) return flow;
  const next = cloneFlow(flow);
  let elapsed = next.timedReading.elapsedMs;
  if (next.timedReading.phase === "running") {
    elapsed += Math.max(0, now - next.timedReading.startedAt);
  }
  next.timedReading = {
    ...next.timedReading,
    phase: "done",
    elapsedMs: elapsed,
    startedAt: null,
    pausedAt: null,
    completedAt: now,
  };
  if (isCleanTextCurrent(flow)) {
    next.stages["deep-clean-text"] = { status: "completed", completedAt: now };
    next.currentStage = "deep-first-quiz";
    next.stages["deep-first-quiz"] = { status: "current", completedAt: null };
  }
  next.updatedAt = now;
  return next;
}

export function timedReadingElapsed(flow, now = Date.now()) {
  const state = flow?.timedReading;
  if (!state) return 0;
  let elapsed = Math.max(0, Number(state.elapsedMs) || 0);
  if (state.phase === "running" && Number.isFinite(Number(state.startedAt))) {
    elapsed += Math.max(0, now - Number(state.startedAt));
  }
  return elapsed;
}

export function undoWorkflowCompletion(flow, now = Date.now()) {
  if (!flow) return flow;
  const next = cloneFlow(flow);
  next.stages["deep-review"] = { status: "current", completedAt: null };
  next.currentStage = "deep-review";
  next.updatedAt = now;
  return next;
}
