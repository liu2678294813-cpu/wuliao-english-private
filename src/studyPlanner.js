/**
 * 动态学习规划器 Study Planner - 确定性规则核心。
 *
 * 本模块是纯函数领域层：
 * - 不访问 localStorage / IndexedDB / DOM / React；
 * - 不使用 Date.now / Math.random（时间由调用方显式传入）；
 * - 决策完全由候选任务 + 优先级规则 + 时间预算决定，不调用任何 AI。
 */

import { AppEvent } from "./events/eventTypes";

export const PLANNER_SCHEMA_VERSION = 1;

/** 预算 / defer / reinclude 变化时派发的窗口事件名。 */
export const STUDY_PLAN_UPDATED = AppEvent.STUDY_PLAN_UPDATED;

export const TASK_TYPE_REVIEW = "review";
export const TASK_TYPE_CONTINUE_READING = "continue-reading";
export const TASK_TYPE_LEARNING_REVIEW = "learning-review";
export const TASK_TYPE_VOCABULARY_REVIEW = "vocabulary-review";
export const TASK_TYPE_NEW_READING = "new-reading";
export const TASK_TYPE_BLOCKED_READING = "blocked-reading";
export const TASK_TYPE_CLOZE_REVIEW = "cloze-review";
export const TASK_TYPE_EXAM_FOLLOWUP = "exam-followup";
export const TASK_TYPE_CONTINUE_WRITING = "continue-writing";
export const TASK_TYPE_WRITING_REVIEW = "writing-review";

/** 优先级层级：数字越小越优先。 */
export const TIER_OVERDUE_REVIEW = 0;
export const TIER_DUE_REVIEW = 1;
export const TIER_CONTINUE_READING = 2;
export const TIER_LEARNING_REVIEW = 3;
export const TIER_VOCABULARY_REVIEW = 3;
export const TIER_NEW_READING = 4;

/** 逾期天数参与排序的最大值：避免无限增长让极旧任务永远压死其他任务。 */
export const OVERDUE_SORT_CAP = 7;

/**
 * 全部确定性时间估算参数集中定义，禁止散落在组件里。
 * 单位：分钟。本阶段不使用实际耗时历史（只读真实状态，不制造伪数据）。
 */
export const PLANNER_DURATION_DEFAULTS = {
  nextDayReview: 15,
  sentenceRecheckBase: 8,
  sentenceRecheckPerSentence: 2,
  sentenceRecheckMax: 25,
  continueReadingByStage: {
    "deep-cover": 5,
    "deep-first-read": 10,
    "deep-clean-text": 15,
    "deep-first-quiz": 15,
    "deep-translation": 30,
    "deep-redo": 15,
    "deep-review": 15,
  },
  deepTranslationBase: 10,
  deepTranslationPerSentence: 2,
  deepTranslationMax: 45,
  learningReview: 10,
  vocabularyReviewBase: 5,
  vocabularyReviewPerWord: 0.5,
  vocabularyReviewMax: 45,
  newReading: 40,
  clozeReviewBase: 2,
  clozeReviewPerBlank: 1,
  clozeReviewMax: 15,
  examFollowup: 10,
  continueWriting: 20,
  writingReview: 15,
};

function clampMinutes(value, max) {
  const rounded = Math.max(1, Math.round(Number(value) || 0));
  return Number.isFinite(Number(max)) ? Math.min(Number(max), rounded) : rounded;
}

/**
 * 按任务类型给出确定性估算。candidate.metadata 携带结构化计数。
 */
export function estimateTaskDuration(candidate, defaults = PLANNER_DURATION_DEFAULTS) {
  const meta = candidate?.metadata || {};
  const type = candidate?.type;
  if (type === TASK_TYPE_REVIEW) {
    if (meta.taskType === "sentence_recheck") {
      const sentenceCount = Math.max(0, Number(meta.sentenceCount) || 0);
      return clampMinutes(
        defaults.sentenceRecheckBase + defaults.sentenceRecheckPerSentence * sentenceCount,
        defaults.sentenceRecheckMax,
      );
    }
    return defaults.nextDayReview;
  }
  if (type === TASK_TYPE_CONTINUE_READING) {
    const stage = meta.stageId || "deep-cover";
    const base = defaults.continueReadingByStage[stage];
    if (Number.isFinite(base)) {
      if (
        stage === "deep-translation"
        && meta.remainingSentenceCount != null
        && Number.isFinite(Number(meta.remainingSentenceCount))
      ) {
        return clampMinutes(
          defaults.deepTranslationBase
            + defaults.deepTranslationPerSentence * Math.max(0, Number(meta.remainingSentenceCount)),
          defaults.deepTranslationMax,
        );
      }
      return base;
    }
    return defaults.newReading;
  }
  if (type === TASK_TYPE_LEARNING_REVIEW) return defaults.learningReview;
  if (type === TASK_TYPE_EXAM_FOLLOWUP) return defaults.examFollowup;
  if (type === TASK_TYPE_VOCABULARY_REVIEW) {
    const dueCount = Math.max(0, Number(meta.dueCount) || 0);
    return clampMinutes(
      defaults.vocabularyReviewBase + defaults.vocabularyReviewPerWord * dueCount,
      defaults.vocabularyReviewMax,
    );
  }
  if (type === TASK_TYPE_CLOZE_REVIEW) {
    const remainingCount = Math.max(0, Number(meta.remainingCount ?? meta.targetCount) || 0);
    return clampMinutes(
      defaults.clozeReviewBase + defaults.clozeReviewPerBlank * remainingCount,
      defaults.clozeReviewMax,
    );
  }
  if (type === TASK_TYPE_CONTINUE_WRITING) return defaults.continueWriting;
  if (type === TASK_TYPE_WRITING_REVIEW) return defaults.writingReview;
  if (type === TASK_TYPE_NEW_READING) return defaults.newReading;
  return 0;
}

const REVIEW_STATUS_ORDER = { in_progress: 0, due: 1, overdue: 2 };
const TIER3_TYPE_ORDER = {
  [TASK_TYPE_LEARNING_REVIEW]: 0,
  [TASK_TYPE_VOCABULARY_REVIEW]: 1,
};

/**
 * 组内排序键（数组，逐位比较）。所有键都以 id 结尾保证全序稳定。
 */
export function sortKeyForCandidate(candidate) {
  const meta = candidate?.metadata || {};
  const tier = Number(candidate?.priorityTier);
  const id = String(candidate?.id || "");
  if (tier === TIER_OVERDUE_REVIEW) {
    return [
      tier,
      -Math.min(OVERDUE_SORT_CAP, Math.max(0, Number(candidate?.overdueDays) || 0)),
      String(candidate?.dueDate || ""),
      Number(candidate?.createdAt) || 0,
      id,
    ];
  }
  if (tier === TIER_DUE_REVIEW) {
    return [
      tier,
      REVIEW_STATUS_ORDER[meta.status] ?? 2,
      String(candidate?.dueDate || ""),
      Number(candidate?.createdAt) || 0,
      id,
    ];
  }
  if (tier === TIER_CONTINUE_READING) {
    return [
      tier,
      -(Number(meta.updatedAt) || 0),
      String(meta.resourceId || ""),
      String(meta.passageId || ""),
      id,
    ];
  }
  if (tier === TIER_LEARNING_REVIEW || tier === TIER_VOCABULARY_REVIEW) {
    return [tier, TIER3_TYPE_ORDER[candidate?.type] ?? 2, 0, id];
  }
  return [tier, 0, id];
}

export function priorityForTask(candidate) {
  return {
    tier: Number(candidate?.priorityTier) || 0,
    score: sortKeyForCandidate(candidate),
  };
}

function compareCandidates(a, b) {
  const keyA = sortKeyForCandidate(a);
  const keyB = sortKeyForCandidate(b);
  const length = Math.max(keyA.length, keyB.length);
  for (let index = 0; index < length; index += 1) {
    const x = keyA[index];
    const y = keyB[index];
    if (x === y) continue;
    if (x == null) return -1;
    if (y == null) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    const comparison = String(x).localeCompare(String(y), "zh");
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function sumMinutes(list) {
  return list.reduce((total, candidate) => total + Math.max(0, Number(candidate.estimatedMinutes) || 0), 0);
}

function describeDeferred(candidatesById, deferredTaskIds) {
  const seen = new Set();
  const output = [];
  for (const id of deferredTaskIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const candidate = candidatesById.get(String(id));
    if (candidate) output.push(candidate);
  }
  return output;
}

/**
 * 核心规划函数（纯函数）。
 *
 * 规则：
 * - 先按 Tier + 组内键稳定排序；
 * - defer 只影响当天计划，不修改任何业务状态；
 * - 无预算/不限制：输出全部推荐顺序，remainingMinutes / overBudgetMinutes 为 null；
 * - 有限预算：mandatory 全部保留（超预算不隐藏），flexible 按优先级顺序填充。
 */
export function planStudyDay(
  candidates,
  {
    date = "",
    budgetMinutes = null,
    budgetConfirmed = false,
    deferredTaskIds = [],
    completed = [],
    blocked = [],
    generatedAt = 0,
  } = {},
) {
  const list = Array.isArray(candidates) ? candidates : [];
  const sorted = [...list].sort(compareCandidates);
  const deferredSet = new Set((Array.isArray(deferredTaskIds) ? deferredTaskIds : []).map(String).filter(Boolean));
  const deferred = describeDeferred(new Map(sorted.map((candidate) => [String(candidate.id), candidate])), deferredSet);
  const active = sorted.filter((candidate) => !deferredSet.has(String(candidate.id)));
  const confirmedFinite = Boolean(budgetConfirmed) && budgetMinutes != null && Number.isFinite(Number(budgetMinutes));

  let planned = [];
  let plannedMinutes = 0;
  let mandatoryMinutes = 0;
  let remainingMinutes = null;
  let overBudgetMinutes = null;
  let overflow = [];

  if (confirmedFinite) {
    const budget = Math.max(0, Number(budgetMinutes));
    const mandatory = active.filter((candidate) => candidate.mandatory === true);
    const flexible = active.filter((candidate) => candidate.mandatory !== true);
    planned = [...mandatory];
    plannedMinutes = sumMinutes(planned);
    for (const candidate of flexible) {
      const estimate = Math.max(0, Number(candidate.estimatedMinutes) || 0);
      if (plannedMinutes + estimate <= budget) {
        planned.push(candidate);
        plannedMinutes += estimate;
      }
    }
    mandatoryMinutes = sumMinutes(mandatory);
    remainingMinutes = Math.max(0, budget - plannedMinutes);
    overBudgetMinutes = Math.max(0, plannedMinutes - budget);
    const plannedIds = new Set(planned.map((candidate) => String(candidate.id)));
    overflow = active.filter((candidate) => !plannedIds.has(String(candidate.id)));
  } else {
    planned = active;
    plannedMinutes = sumMinutes(planned);
    mandatoryMinutes = sumMinutes(active.filter((candidate) => candidate.mandatory === true));
  }

  planned.forEach((candidate, index) => {
    candidate.priorityScore = index;
  });

  return {
    date: String(date || ""),
    budgetMinutes: budgetMinutes == null ? null : Number(budgetMinutes),
    budgetConfirmed: Boolean(budgetConfirmed),
    mandatoryMinutes,
    plannedMinutes,
    remainingMinutes,
    overBudgetMinutes,
    planned,
    overflow,
    deferred,
    completed: Array.isArray(completed) ? completed : [],
    blocked: Array.isArray(blocked) ? blocked : [],
    generatedAt: Number(generatedAt) || 0,
  };
}
