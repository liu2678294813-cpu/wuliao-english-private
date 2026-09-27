/**
 * Planner 持久化：只保存当天预算、确认状态与 deferred 列表。
 *
 * 学习完成状态绝不落在这里——Planner 不是第二个事实来源。
 * 所有读写都走 userData 的用户隔离体系，禁止绕过。
 */

import { getUserItem, setUserItem } from "./userData";
import { PLANNER_SCHEMA_VERSION, STUDY_PLAN_UPDATED } from "./studyPlanner";

export const STUDY_PLAN_PREFIX = "wuliao:study-plan:";

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(String(value || "")) || fallback;
  } catch {
    return fallback;
  }
}

export function studyPlanStorageKey(date) {
  return `${STUDY_PLAN_PREFIX}${String(date || "")}`;
}

export function emptyPlanState(date) {
  return {
    schemaVersion: PLANNER_SCHEMA_VERSION,
    date: String(date || ""),
    budgetMinutes: null,
    budgetConfirmed: false,
    deferredTaskIds: [],
    generatedAt: 0,
    updatedAt: 0,
  };
}

export function normalizePlanState(raw, date) {
  const fallback = emptyPlanState(date);
  if (!raw || typeof raw !== "object") return fallback;
  const budget = raw.budgetMinutes;
  return {
    schemaVersion: PLANNER_SCHEMA_VERSION,
    date: String(raw.date || date || ""),
    budgetMinutes: budget == null ? null : Number(budget),
    budgetConfirmed: raw.budgetConfirmed === true,
    deferredTaskIds: Array.isArray(raw.deferredTaskIds)
      ? [...new Set(raw.deferredTaskIds.map(String).filter(Boolean))]
      : [],
    generatedAt: Number(raw.generatedAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

export function loadPlanState(date, username) {
  return normalizePlanState(parseJson(getUserItem(studyPlanStorageKey(date), username), null), date);
}

export function savePlanState(state, username) {
  const normalized = normalizePlanState(state, state?.date || "");
  if (!normalized.date) return { ok: false, error: "缺少计划日期" };
  try {
    setUserItem(studyPlanStorageKey(normalized.date), JSON.stringify(normalized), username);
    notifyPlanUpdated();
    return { ok: true, state: normalized };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function setPlanBudget(date, budgetMinutes, { confirmed = true, now = Date.now() } = {}) {
  const current = loadPlanState(date);
  const next = {
    ...current,
    date,
    budgetMinutes: budgetMinutes == null ? null : Number(budgetMinutes),
    budgetConfirmed: Boolean(confirmed),
    updatedAt: now,
  };
  const result = savePlanState(next);
  return { ...result, budgetMinutes: next.budgetMinutes, budgetConfirmed: next.budgetConfirmed };
}

function uniqueIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
}

export function deferPlanTask(date, taskId, { now = Date.now() } = {}) {
  const id = String(taskId || "");
  if (!id) return { ok: false, error: "缺少任务 ID" };
  const current = loadPlanState(date);
  const next = {
    ...current,
    date,
    deferredTaskIds: uniqueIds([...(current.deferredTaskIds || []), id]),
    updatedAt: now,
  };
  const result = savePlanState(next);
  return { ...result, deferred: next.deferredTaskIds.includes(id) };
}

export function reincludePlanTask(date, taskId, { now = Date.now() } = {}) {
  const id = String(taskId || "");
  const current = loadPlanState(date);
  const next = {
    ...current,
    date,
    deferredTaskIds: uniqueIds((current.deferredTaskIds || []).filter((item) => item !== id)),
    updatedAt: now,
  };
  const result = savePlanState(next);
  return { ...result, deferred: next.deferredTaskIds.includes(id) };
}

export function notifyPlanUpdated() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  try {
    window.dispatchEvent(new CustomEvent(STUDY_PLAN_UPDATED));
  } catch {
    // 事件通知失败不影响存储本身
  }
}
