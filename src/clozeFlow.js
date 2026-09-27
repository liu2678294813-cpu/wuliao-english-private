// 完形填空独立流程状态机。
//
// 与阅读理解 readingFlow 完全隔离：独立的阶段语义、独立的 storage key 前缀
// (`wuliao:cloze-flow:`)、独立的限时字段 (`timedAttempt`)。允许复用 userData
// 账号隔离机制，但绝不与阅读共用 storage key。
//
// 6 阶段对应未来完形当天训练流程：
//   cloze-cover        导读
//   cloze-first-attempt 限时初做（配套 timedAttempt 计时）
//   cloze-self-review  自主复查
//   cloze-correction   统一订正
//   cloze-analysis     逐空精析
//   cloze-final-read   全文回读

import { getUserItem, setUserItem } from "./userData";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";

export const CLOZE_FLOW_SCHEMA_VERSION = 1;

export const CLOZE_STAGES = [
  { id: "cloze-cover", label: "导读" },
  { id: "cloze-first-attempt", label: "限时初做" },
  { id: "cloze-self-review", label: "自主复查" },
  { id: "cloze-correction", label: "统一订正" },
  { id: "cloze-analysis", label: "逐空精析" },
  { id: "cloze-final-read", label: "全文回读" },
];

export const CLOZE_STAGE_IDS = CLOZE_STAGES.map((stage) => stage.id);
export const CLOZE_STAGE_LABELS = Object.fromEntries(CLOZE_STAGES.map((stage) => [stage.id, stage.label]));

const TIMED_PHASES = ["idle", "running", "paused", "done"];
const TIMED_STAGE = "cloze-first-attempt";

export function clozeFlowStorageKey(resourceId, clozeId) {
  return `wuliao:cloze-flow:${resourceId}:${clozeId}`;
}

function readJson(key, fallback = null) {
  try {
    return JSON.parse(getUserItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function stageIndex(stageId) {
  const index = CLOZE_STAGE_IDS.indexOf(stageId);
  return index < 0 ? 0 : index;
}

function normalizedStatus(value) {
  return value === "completed" || value === "current" || value === "pending" ? value : "pending";
}

function cloneFlow(flow) {
  return {
    ...flow,
    stages: Object.fromEntries(CLOZE_STAGES.map((stage) => [
      stage.id,
      {
        status: normalizedStatus(flow?.stages?.[stage.id]?.status),
        completedAt: flow?.stages?.[stage.id]?.completedAt != null
          && Number.isFinite(Number(flow?.stages?.[stage.id]?.completedAt))
          ? Number(flow.stages[stage.id].completedAt)
          : null,
      },
    ])),
    timedAttempt: { ...(flow?.timedAttempt || {}) },
  };
}

export function emptyClozeFlow(resourceId, clozeId, now = Date.now()) {
  return {
    schemaVersion: CLOZE_FLOW_SCHEMA_VERSION,
    resourceId,
    clozeId,
    stages: Object.fromEntries(CLOZE_STAGES.map((stage) => [
      stage.id,
      {
        status: stage.id === "cloze-cover" ? "current" : "pending",
        completedAt: null,
      },
    ])),
    currentStage: "cloze-cover",
    timedAttempt: {
      phase: "idle",
      elapsedMs: 0,
      startedAt: null,
      pausedAt: null,
      completedAt: null,
    },
    updatedAt: now,
  };
}

export function normalizeClozeFlow(flow) {
  if (!flow) return null;
  const next = cloneFlow(flow);
  next.schemaVersion = CLOZE_FLOW_SCHEMA_VERSION;
  next.resourceId = String(flow.resourceId || "");
  next.clozeId = String(flow.clozeId || "");

  const firstOpen = CLOZE_STAGES.find((stage) => next.stages[stage.id].status !== "completed");
  next.currentStage = firstOpen ? firstOpen.id : "cloze-final-read";
  for (const stage of CLOZE_STAGES) {
    if (next.stages[stage.id].status !== "completed" && stage.id !== next.currentStage) {
      next.stages[stage.id].status = "pending";
    }
  }
  if (next.stages[next.currentStage]?.status !== "completed") {
    next.stages[next.currentStage].status = "current";
  }

  const timed = flow.timedAttempt || {};
  next.timedAttempt = {
    phase: TIMED_PHASES.includes(timed.phase) ? timed.phase : "idle",
    elapsedMs: Math.max(0, Number(timed.elapsedMs) || 0),
    startedAt: timed.startedAt != null && Number.isFinite(Number(timed.startedAt)) ? Number(timed.startedAt) : null,
    pausedAt: timed.pausedAt != null && Number.isFinite(Number(timed.pausedAt)) ? Number(timed.pausedAt) : null,
    completedAt: timed.completedAt != null && Number.isFinite(Number(timed.completedAt)) ? Number(timed.completedAt) : null,
  };
  next.updatedAt = Number(flow.updatedAt) || Date.now();
  return next;
}

export function getClozeFlow(resourceId, clozeId) {
  const stored = readJson(clozeFlowStorageKey(resourceId, clozeId), null);
  if (stored) return normalizeClozeFlow(stored);
  return emptyClozeFlow(resourceId, clozeId);
}

export function saveClozeFlow(flow) {
  if (!flow?.resourceId || !flow?.clozeId) return;
  setUserItem(clozeFlowStorageKey(flow.resourceId, flow.clozeId), JSON.stringify(flow));
  emitAppEvent(AppEvent.LEARNING_STATE_INVALIDATED);
}

export function currentClozeStageOf(flow) {
  return flow?.currentStage || "cloze-cover";
}

export function isClozeStageLocked(flow, stageId) {
  return stageIndex(stageId) > stageIndex(currentClozeStageOf(flow));
}

export function isClozeWorkflowCompleted(flow) {
  return Boolean(flow) && CLOZE_STAGES.every((stage) => flow.stages?.[stage.id]?.status === "completed");
}

export function completeClozeStage(flow, stageId, now = Date.now()) {
  if (!flow?.stages?.[stageId]) return flow;
  if (flow.stages[stageId].status === "completed") return flow;
  const isCurrentStage = flow.currentStage === stageId || flow.stages[stageId].status === "current";
  if (!isCurrentStage) return flow;

  const next = cloneFlow(flow);
  next.stages[stageId] = { status: "completed", completedAt: now };
  const nextStage = CLOZE_STAGES[stageIndex(stageId) + 1];
  if (nextStage) {
    next.currentStage = nextStage.id;
    next.stages[nextStage.id] = { status: "current", completedAt: null };
  } else {
    next.currentStage = stageId;
  }
  next.updatedAt = now;
  return next;
}

function isTimedCurrent(flow) {
  return flow?.currentStage === TIMED_STAGE;
}

export function startClozeTimer(flow, now = Date.now()) {
  if (!isTimedCurrent(flow) || flow.timedAttempt.phase !== "idle") return flow;
  const next = cloneFlow(flow);
  next.timedAttempt = {
    ...next.timedAttempt,
    phase: "running",
    elapsedMs: 0,
    startedAt: now,
    pausedAt: null,
    completedAt: null,
  };
  next.updatedAt = now;
  return next;
}

export function pauseClozeTimer(flow, now = Date.now()) {
  if (!isTimedCurrent(flow) || flow.timedAttempt.phase !== "running") return flow;
  const next = cloneFlow(flow);
  const elapsed = next.timedAttempt.elapsedMs + Math.max(0, now - next.timedAttempt.startedAt);
  next.timedAttempt = {
    ...next.timedAttempt,
    phase: "paused",
    elapsedMs: elapsed,
    startedAt: null,
    pausedAt: now,
  };
  next.updatedAt = now;
  return next;
}

export function resumeClozeTimer(flow, now = Date.now()) {
  if (!isTimedCurrent(flow) || flow.timedAttempt.phase !== "paused") return flow;
  const next = cloneFlow(flow);
  next.timedAttempt = {
    ...next.timedAttempt,
    phase: "running",
    startedAt: now,
    pausedAt: null,
  };
  next.updatedAt = now;
  return next;
}

export function finishClozeTimer(flow, now = Date.now()) {
  if (!isTimedCurrent(flow)) return flow;
  const next = cloneFlow(flow);
  let elapsed = next.timedAttempt.elapsedMs;
  if (next.timedAttempt.phase === "running") {
    elapsed += Math.max(0, now - next.timedAttempt.startedAt);
  }
  next.timedAttempt = {
    ...next.timedAttempt,
    phase: "done",
    elapsedMs: elapsed,
    startedAt: null,
    pausedAt: null,
    completedAt: now,
  };
  next.updatedAt = now;
  return next;
}

export function clozeTimerElapsed(flow, now = Date.now()) {
  const state = flow?.timedAttempt;
  if (!state) return 0;
  let elapsed = Math.max(0, Number(state.elapsedMs) || 0);
  if (state.phase === "running" && Number.isFinite(Number(state.startedAt))) {
    elapsed += Math.max(0, now - Number(state.startedAt));
  }
  return elapsed;
}

export function undoClozeWorkflowCompletion(flow, now = Date.now()) {
  if (!flow) return flow;
  const next = cloneFlow(flow);
  next.stages["cloze-final-read"] = { status: "current", completedAt: null };
  next.currentStage = "cloze-final-read";
  next.updatedAt = now;
  return next;
}