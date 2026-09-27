// 完形长期复习 (E 阶段) —— sidecar 数据层 + 确定性调度核心。
//
// 设计原则（与 A/B/C/D 阶段完全隔离）：
//   - clozeProgress (schemaVersion 2) 仍是"当天训练事实源"。E 不 bump 任何
//     schema，也绝不把 d1/d7 字段塞回 schemaVersion 2。
//   - 本模块是 additive sidecar：只保存【长期复习任务生命周期】与
//     【D+1/D+7 的实际作答 attempt】。不复制 firstAnswer / reviewAnswer /
//     prediction / references / translation 作为新事实源；需要时由调用方
//     显式注入。
//   - 调度只建立在【可验证本地事实】上。AI diagnosis 完全退出 target
//     selection / ranking（包括 tie-break），只允许在复习后解释与 Archive
//     展示中作为"AI 当时的推测"出现。
//   - 纯函数（selectD1Targets / selectD7Targets / deriveResolved / 统计）
//     绝不读取 localStorage：progress、officialAnswers、translation 等外部
//     状态一律通过参数显式注入，便于确定性测试。
//   - task identity 确定性：`cloze-review:d1|d7:<resourceId>:<clozeId>:<sourceDate>`
//     不依赖随机 ID / DOM / 排序 / 答案文本。
//   - ensureClozeReviewTask 是 create-once 幂等：taskKey 已存在时直接返回
//     已有任务，绝不重算或覆盖首次 materialize 的
//     targetBlankIds / targetReasons / sourceDate。
//   - D+1 的 soft limit 只限制【普通风险项】；hard-risk（高置信错误、改答后
//     错误）必须全部保留，绝不静默删除，过多时同一 task 内顺序完成。

import { getUserItem, listUserItems, setUserItem } from "./userData";
import { addCalendarDays, dateDiffDays, localDateKey } from "./readingReview";
import { effectiveConfidence } from "./clozeProgress";
import { translationEntryFor } from "./clozeTranslationProgress";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";

export const CLOZE_REVIEW_SCHEMA_VERSION = 1;
export const CLOZE_REVIEW_TASK_PREFIX = "wuliao:cloze-review-task:";
export const CLOZE_REVIEW_TASKS_UPDATED = AppEvent.CLOZE_REVIEW_TASKS_UPDATED;

export const TASK_TYPE_D1 = "d1";
export const TASK_TYPE_D7 = "d7";
export const CLOZE_REVIEW_TYPES = [TASK_TYPE_D1, TASK_TYPE_D7];

export const D1_DUE_OFFSET_DAYS = 1;
export const D7_DUE_OFFSET_DAYS = 7;

// soft limit 只限制普通风险项；hard-risk 不受此限制。
export const D1_SOFT_LIMIT = 8;

// targetReasons 取值（snapshot：当时为什么加入 D+1/D+7）。
export const REASON_HIGH_CONFIDENCE_WRONG = "high-confidence-wrong";
export const REASON_CHANGED_TO_WRONG = "changed-to-wrong";
export const REASON_FINAL_WRONG = "final-wrong";
export const REASON_SELF_CORRECTED = "self-corrected";
export const REASON_CHANGED_ANSWER = "changed-answer";
export const REASON_GUESS = "guess";
export const REASON_UNCERTAIN = "uncertain";
export const REASON_D1_CHANGED = "d1-changed";
export const REASON_D1_LOW_CONFIDENCE = "d1-low-confidence";
export const REASON_D1_SELF_RATING_UNSTABLE = "d1-self-rating-unstable";
export const REASON_D1_WRONG = "d1-wrong";
export const REASON_D7_CONFIRMATION = "d7-confirmation";
export const REASON_TRANSLATION_UNRESOLVED = "translation-unresolved";
export const REASON_ANSWERLESS_CHANGED = "answerless-changed";
export const REASON_ANSWERLESS_LOW_CONFIDENCE = "answerless-low-confidence";

// attempt 的 outcome 取值。
export const OUTCOME_CORRECT = "correct";
export const OUTCOME_WRONG = "wrong";
export const OUTCOME_STABLE = "stable";
export const OUTCOME_UNSTABLE = "unstable";

export const SELF_RATING_STABLE = "stable";
export const SELF_RATING_UNSTABLE = "unstable";
const SELF_RATINGS = [SELF_RATING_STABLE, SELF_RATING_UNSTABLE];

// ---------------- 日期与 key ----------------

export function clozeReviewTaskKey({ type, resourceId, clozeId, sourceDate }) {
  const taskType = CLOZE_REVIEW_TYPES.includes(type) ? type : TASK_TYPE_D1;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(sourceDate || "")) ? String(sourceDate) : "";
  return `cloze-review:${taskType}:${encodeURIComponent(String(resourceId || ""))}:${encodeURIComponent(String(clozeId || ""))}:${date}`;
}

function storageKeyForTask(taskKey) {
  return `${CLOZE_REVIEW_TASK_PREFIX}${String(taskKey || "")}`;
}

function normalizeTime(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

// ---------------- attempt 归一化 ----------------

function normalizeReviewAttempt(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const answer = /^[A-D]$/.test(String(raw.answer || "")) ? String(raw.answer) : "";
  const confidence = ["confident", "uncertain", "guess"].includes(raw.confidence) ? raw.confidence : "";
  const basisTypes = Array.isArray(raw.basisTypes)
    ? [...new Set(raw.basisTypes.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
  const selfRating = SELF_RATINGS.includes(raw.selfRating) ? raw.selfRating : null;
  const outcome = [
    OUTCOME_CORRECT,
    OUTCOME_WRONG,
    OUTCOME_STABLE,
    OUTCOME_UNSTABLE,
  ].includes(raw.outcome)
    ? raw.outcome
    : "";
  return {
    blankIdentity: String(raw.blankIdentity ?? ""),
    answer,
    confidence,
    basisTypes,
    selfRating,
    outcome,
    reviewedAt: normalizeTime(raw.reviewedAt) || now,
  };
}

// ---------------- task 归一化 ----------------

export function normalizeClozeReviewTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = CLOZE_REVIEW_TYPES.includes(raw.type) ? raw.type : TASK_TYPE_D1;
  const resourceId = String(raw.resourceId || "");
  const clozeId = String(raw.clozeId || "");
  if (!resourceId || !clozeId) return null;
  const sourceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.sourceDate || "")) ? String(raw.sourceDate) : localDateKey();
  const targetBlankIds = [...new Set(
    (Array.isArray(raw.targetBlankIds) ? raw.targetBlankIds : [])
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 1),
  )].sort((a, b) => a - b);
  const targetReasons = {};
  if (raw.targetReasons && typeof raw.targetReasons === "object") {
    for (const [blankId, reasons] of Object.entries(raw.targetReasons)) {
      targetReasons[blankId] = [...new Set(
        (Array.isArray(reasons) ? reasons : []).map(String).filter(Boolean),
      )];
    }
  }
  const attempts = {};
  for (const [blankId, attempt] of Object.entries(raw.attempts || {})) {
    const normalized = normalizeReviewAttempt(attempt, Date.now());
    if (normalized) attempts[blankId] = normalized;
  }
  const task = {
    schemaVersion: CLOZE_REVIEW_SCHEMA_VERSION,
    taskKey: String(raw.taskKey || ""),
    type,
    resourceId,
    clozeId,
    sourceDate,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.dueDate || "")) ? String(raw.dueDate) : sourceDate,
    createdAt: normalizeTime(raw.createdAt),
    startedAt: normalizeTime(raw.startedAt),
    completedAt: normalizeTime(raw.completedAt),
    skippedAt: normalizeTime(raw.skippedAt),
    currentIndex: Number.isInteger(Number(raw.currentIndex)) && Number(raw.currentIndex) >= 0
      ? Number(raw.currentIndex)
      : 0,
    targetBlankIds,
    targetReasons,
    attempts,
    updatedAt: normalizeTime(raw.updatedAt) || Date.now(),
  };
  if (task.currentIndex > task.targetBlankIds.length) task.currentIndex = task.targetBlankIds.length;
  return task;
}

// ---------------- 纯函数：风险分类与选择 ----------------

// 有官方答案时的单空风险分类。返回 reasons / riskScore（越小越优先）/
// isRisk / isHardRisk。AI diagnosis 不参与任何判断。
export function classifyBlankRisk(attempt, officialAnswer) {
  if (!attempt) return { reasons: [], riskScore: 0, isRisk: false, isHardRisk: false };
  const official = officialAnswer || "";
  if (!official) return { reasons: [], riskScore: 0, isRisk: false, isHardRisk: false };
  const first = attempt.firstAnswer || "";
  const review = attempt.reviewAnswer || "";
  const final = review || first;
  const confidence = effectiveConfidence(attempt);
  const reasons = [];
  let riskScore = Infinity;
  let isHardRisk = false;

  const changedToWrong = Boolean(first && review && first !== review && first === official && review !== official);
  const finalWrong = Boolean(final && final !== official);
  const highConfidenceWrong = Boolean(finalWrong && confidence === "confident");
  const selfCorrected = Boolean(first && review && first !== review && first !== official && review === official);
  const changedAnswer = Boolean(first && review && first !== review);
  const guess = confidence === "guess";
  const uncertain = confidence === "uncertain";

  if (highConfidenceWrong) {
    reasons.push(REASON_HIGH_CONFIDENCE_WRONG);
    riskScore = 10;
    isHardRisk = true;
  }
  if (changedToWrong) {
    reasons.push(REASON_CHANGED_TO_WRONG);
    riskScore = Math.min(riskScore, 20);
    isHardRisk = true;
  }
  if (finalWrong) {
    reasons.push(REASON_FINAL_WRONG);
    riskScore = Math.min(riskScore, 30);
  }
  if (selfCorrected) {
    reasons.push(REASON_SELF_CORRECTED);
    riskScore = Math.min(riskScore, 40);
  }
  if (changedAnswer) {
    reasons.push(REASON_CHANGED_ANSWER);
    riskScore = Math.min(riskScore, 50);
  }
  if (guess) {
    reasons.push(REASON_GUESS);
    riskScore = Math.min(riskScore, 60);
  }
  if (uncertain) {
    reasons.push(REASON_UNCERTAIN);
    riskScore = Math.min(riskScore, 70);
  }

  return {
    reasons,
    riskScore: reasons.length ? riskScore : Infinity,
    isRisk: reasons.length > 0,
    isHardRisk,
  };
}

// 无官方答案时的单空风险分类。只基于真实用户行为，不产生任何 correctness。
export function classifyAnswerlessBlankRisk(attempt) {
  if (!attempt) return { reasons: [], riskScore: 0, isRisk: false, isHardRisk: false };
  const first = attempt.firstAnswer || "";
  const review = attempt.reviewAnswer || "";
  const confidence = effectiveConfidence(attempt);
  const reasons = [];
  let riskScore = Infinity;
  let isHardRisk = false;

  const changedAnswer = Boolean(first && review && first !== review);
  if (changedAnswer) {
    reasons.push(REASON_ANSWERLESS_CHANGED);
    riskScore = 10;
    isHardRisk = true;
  }
  if (confidence === "guess") {
    reasons.push(REASON_ANSWERLESS_LOW_CONFIDENCE);
    riskScore = Math.min(riskScore, 20);
  }
  if (confidence === "uncertain") {
    reasons.push(REASON_UNCERTAIN);
    riskScore = Math.min(riskScore, 30);
  }

  return {
    reasons,
    riskScore: reasons.length ? riskScore : Infinity,
    isRisk: reasons.length > 0,
    isHardRisk,
  };
}

// 支持性 signal（只允许在同风险类内部 tie-break 提升，绝不单独触发）：
//   - referencesEmpty：风险空位没有任何人工 references；
//   - translationUnresolved：重点句译文尚未订正。
// 由调用方注入 supportByBlank，纯函数不读取存储。
function supportScoreFor(support) {
  if (!support || typeof support !== "object") return 0;
  let score = 0;
  if (support.referencesEmpty) score += 1;
  if (support.translationUnresolved) score += 1;
  return score;
}

// D+1 target selection（确定性、本地、无 AI）。
// 参数全部显式注入：
//   progress           — 当天 clozeProgress（normalize 后的完整对象）
//   officialAnswers    — 本地官方答案 {1:"A",...}；空对象即无答案模式
//   supportByBlank     — 可选 { [blankId]: { referencesEmpty, translationUnresolved } }
//   softLimit          — 普通风险项上限（默认 8）；hard-risk 不受限制
// 返回排序后的 [{ blankId, reasons: string[], riskScore, supportScore }]
export function selectD1Targets({
  progress,
  officialAnswers = {},
  supportByBlank = {},
  softLimit = D1_SOFT_LIMIT,
}) {
  const hasOfficial = Boolean(officialAnswers && Object.keys(officialAnswers).length > 0);
  const attempts = progress?.attempts || {};
  const candidates = [];

  for (const [numberKey, attempt] of Object.entries(attempts)) {
    const blankId = String(numberKey);
    const number = Number(numberKey);
    const classified = hasOfficial
      ? classifyBlankRisk(attempt, officialAnswers[number] || officialAnswers[numberKey] || "")
      : classifyAnswerlessBlankRisk(attempt);
    if (classified.isRisk) {
      candidates.push({
        blankId,
        number,
        reasons: classified.reasons,
        riskScore: classified.riskScore,
        isHardRisk: classified.isHardRisk,
        supportScore: supportScoreFor(supportByBlank[blankId]),
      });
      continue;
    }
    // 无答案模式：translation 仍未解决是允许的真实行为 trigger（§23）。
    if (!hasOfficial && supportByBlank[blankId]?.translationUnresolved) {
      candidates.push({
        blankId,
        number,
        reasons: [REASON_TRANSLATION_UNRESOLVED],
        riskScore: 40,
        isHardRisk: false,
        supportScore: 1,
      });
    }
  }

  // 确定性排序：风险优先级 > 支持性 signal（tie-break）> blank 编号。
  candidates.sort((a, b) => (
    a.riskScore - b.riskScore
    || b.supportScore - a.supportScore
    || a.number - b.number
  ));

  const hardRisk = candidates.filter((item) => item.isHardRisk);
  const ordinary = candidates.filter((item) => !item.isHardRisk);
  const ordinaryLimit = Math.max(0, softLimit - hardRisk.length);
  const selected = [...hardRisk, ...ordinary.slice(0, ordinaryLimit)];

  return selected.map((item) => ({
    blankId: item.blankId,
    reasons: item.reasons,
    riskScore: item.riskScore,
    supportScore: item.supportScore,
  }));
}

// D+7 retention：确认 D+1 后仍不稳定 / 需要再确认的项目。
// 有官方答案：
//   - 保留：D+1 答错 / low confidence / guess / 再次改答 / self-rating 不稳定 /
//     translation 仍未解决；
//   - 保留：D 当天高置信错误（即使 D+1 一次正确 + confident 也要 D+7 确认）；
//   - 退出：D+1 正确 + confident 且答案与 D 当天一致（非高置信错误原项）。
// 无官方答案：
//   - 保留：D+1 改答 / guess / uncertain / self-rating 不稳定 / translation 未解决；
//   - 退出：self-rating stable + confident。
// d1Task.targetReasons 提供"当时为什么进 D+1"的 snapshot（不可变历史）。
export function selectD7Targets({
  d1Task,
  progress,
  officialAnswers = {},
  supportByBlank = {},
}) {
  const hasOfficial = Boolean(officialAnswers && Object.keys(officialAnswers).length > 0);
  const attempts = progress?.attempts || {};
  const d1Attempts = d1Task?.attempts || {};
  const d1Reasons = d1Task?.targetReasons || {};
  const selected = [];

  for (const blankId of d1Task?.targetBlankIds || []) {
    const number = Number(blankId);
    const attempt = attempts[blankId];
    const d1Attempt = d1Attempts[blankId];
    const reasons = [];
    let isRisk = false;

    // D+1 缺少 attempt（异常恢复场景）：视为未稳定，保留到 D+7。
    if (!d1Attempt) {
      reasons.push(REASON_D1_LOW_CONFIDENCE);
      isRisk = true;
    }

    if (hasOfficial && d1Attempt) {
      const official = officialAnswers[number] || officialAnswers[blankId] || "";
      const originalReasons = d1Reasons[blankId] || [];
      const originalHighConfidenceWrong = originalReasons.includes(REASON_HIGH_CONFIDENCE_WRONG);
      const originalChangedToWrong = originalReasons.includes(REASON_CHANGED_TO_WRONG);
      const d1Answer = d1Attempt?.answer || "";
      const d1Confidence = d1Attempt?.confidence || "";
      const d1Outcome = d1Attempt?.outcome || "";
      const d1SelfRating = d1Attempt?.selfRating || null;
      const dDayFinal = (attempt?.reviewAnswer) || attempt?.firstAnswer || "";

      // 高置信错误 / 改答后错误：即使 D+1 一次稳定，也做 D+7 短确认。
      if (originalHighConfidenceWrong || originalChangedToWrong) {
        reasons.push(REASON_D7_CONFIRMATION);
        isRisk = true;
      }
      if (d1Outcome === OUTCOME_WRONG || (official && d1Answer && d1Answer !== official)) {
        reasons.push(REASON_D1_WRONG);
        isRisk = true;
      }
      if (d1Confidence === "guess" || d1Confidence === "uncertain") {
        reasons.push(REASON_D1_LOW_CONFIDENCE);
        isRisk = true;
      }
      if (d1Answer && dDayFinal && d1Answer !== dDayFinal) {
        reasons.push(REASON_D1_CHANGED);
        isRisk = true;
      }
      if (d1SelfRating === SELF_RATING_UNSTABLE) {
        reasons.push(REASON_D1_SELF_RATING_UNSTABLE);
        isRisk = true;
      }
      if (supportByBlank[blankId]?.translationUnresolved) {
        reasons.push(REASON_TRANSLATION_UNRESOLVED);
        isRisk = true;
      }
      if (!originalHighConfidenceWrong && !originalChangedToWrong && !isRisk) {
        const stableExit = d1Outcome === OUTCOME_CORRECT
          && d1Confidence === "confident"
          && (!d1Answer || !dDayFinal || d1Answer === dDayFinal);
        if (stableExit) continue;
      }
    } else if (d1Attempt) {
      const d1Answer = d1Attempt?.answer || "";
      const d1Confidence = d1Attempt?.confidence || "";
      const d1SelfRating = d1Attempt?.selfRating || null;
      const dDayFinal = (attempt?.reviewAnswer) || attempt?.firstAnswer || "";
      if (d1Answer && dDayFinal && d1Answer !== dDayFinal) {
        reasons.push(REASON_D1_CHANGED);
        isRisk = true;
      }
      if (d1Confidence === "guess" || d1Confidence === "uncertain") {
        reasons.push(REASON_ANSWERLESS_LOW_CONFIDENCE);
        isRisk = true;
      }
      if (d1SelfRating === SELF_RATING_UNSTABLE) {
        reasons.push(REASON_D1_SELF_RATING_UNSTABLE);
        isRisk = true;
      }
      if (supportByBlank[blankId]?.translationUnresolved) {
        reasons.push(REASON_TRANSLATION_UNRESOLVED);
        isRisk = true;
      }
      if (!isRisk) {
        const stableExit = d1SelfRating === SELF_RATING_STABLE && d1Confidence === "confident";
        if (stableExit) continue;
      }
    }

    if (isRisk) selected.push({ blankId, reasons: [...new Set(reasons)] });
  }

  selected.sort((a, b) => Number(a.blankId) - Number(b.blankId));
  return selected;
}

// ---------------- resolved 派生 ----------------

// resolved 只从 review outcome 派生，不做不可解释的持久化真源。
// 有答案：最新 attempt 必须 correct + confident（correct+uncertain / correct+guess
//   都不能判 resolved）。未进 D+7 时，以 D+1 满足退出规则为准。
// 无答案：self-rating stable + confident。
export function deriveBlankResolved({
  d1Task,
  d7Task,
  blankId,
  officialAnswers = {},
}) {
  const hasOfficial = Boolean(officialAnswers && Object.keys(officialAnswers).length > 0);
  const d1Attempt = d1Task?.attempts?.[blankId];
  const d7Attempt = d7Task?.attempts?.[blankId];
  if (!d1Attempt && !d7Attempt) return false;

  if (d7Attempt?.reviewedAt) {
    if (hasOfficial) {
      return d7Attempt.outcome === OUTCOME_CORRECT && d7Attempt.confidence === "confident";
    }
    return d7Attempt.selfRating === SELF_RATING_STABLE && d7Attempt.confidence === "confident";
  }
  if (d1Attempt?.reviewedAt) {
    if (hasOfficial) {
      return d1Attempt.outcome === OUTCOME_CORRECT && d1Attempt.confidence === "confident";
    }
    return d1Attempt.selfRating === SELF_RATING_STABLE && d1Attempt.confidence === "confident";
  }
  return false;
}

// 计算 D+1 attempt 的 outcome（有答案用本地 officialAnswer，无答案用 self-rating）。
export function computeD1AttemptOutcome({ attempt, officialAnswer, selfRating }) {
  if (officialAnswer) {
    return attempt.answer === officialAnswer ? OUTCOME_CORRECT : OUTCOME_WRONG;
  }
  return selfRating === SELF_RATING_STABLE ? OUTCOME_STABLE : OUTCOME_UNSTABLE;
}

// 计算 D+7 attempt 的 outcome。无答案时同样禁止 correctness。
export function computeD7AttemptOutcome({ attempt, officialAnswer, selfRating }) {
  if (officialAnswer) {
    return attempt.answer === officialAnswer ? OUTCOME_CORRECT : OUTCOME_WRONG;
  }
  return selfRating === SELF_RATING_STABLE ? OUTCOME_STABLE : OUTCOME_UNSTABLE;
}

// ---------------- 生命周期（storage 层） ----------------

export function getClozeReviewTask(taskKey, username) {
  if (!taskKey) return null;
  try {
    const raw = JSON.parse(getUserItem(storageKeyForTask(taskKey), username) || "");
    const task = normalizeClozeReviewTask(raw);
    if (!task) return null;
    task.taskKey = String(taskKey);
    return task;
  } catch {
    return null;
  }
}

export function listClozeReviewTasks(username) {
  try {
    return listUserItems(CLOZE_REVIEW_TASK_PREFIX, username)
      .map(({ key, value }) => {
        const taskKey = String(key || "").slice(CLOZE_REVIEW_TASK_PREFIX.length);
        if (!taskKey) return null;
        try {
          const task = normalizeClozeReviewTask(JSON.parse(value));
          if (!task) return null;
          task.taskKey = taskKey;
          return task;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function saveClozeReviewTask(task, username) {
  if (!task?.taskKey || !task.resourceId || !task.clozeId) {
    return { ok: false, error: "任务数据不完整" };
  }
  try {
    setUserItem(storageKeyForTask(task.taskKey), JSON.stringify(task), username);
    emitAppEvent(CLOZE_REVIEW_TASKS_UPDATED);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

// create-once 幂等：同一 taskKey 已存在时直接返回已有任务，绝不重算或覆盖
// targetBlankIds / targetReasons / sourceDate 等首次 materialize snapshot。
export function ensureClozeReviewTask({
  taskKey,
  type,
  resourceId,
  clozeId,
  sourceDate,
  dueDate,
  targetBlankIds = [],
  targetReasons = {},
  now = Date.now(),
  username,
}) {
  const existing = getClozeReviewTask(taskKey, username);
  if (existing) return { task: existing, created: false };

  const reasonMap = {};
  for (const item of Array.isArray(targetBlankIds) ? targetBlankIds : []) {
    const blankId = String(item);
    reasonMap[blankId] = [...new Set((targetReasons[blankId] || targetReasons[Number(blankId)] || []).map(String).filter(Boolean))];
  }
  const task = {
    schemaVersion: CLOZE_REVIEW_SCHEMA_VERSION,
    taskKey,
    type: CLOZE_REVIEW_TYPES.includes(type) ? type : TASK_TYPE_D1,
    resourceId: String(resourceId || ""),
    clozeId: String(clozeId || ""),
    sourceDate,
    dueDate,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    currentIndex: 0,
    targetBlankIds: [...new Set((Array.isArray(targetBlankIds) ? targetBlankIds : []).map(Number).filter((item) => Number.isInteger(item) && item >= 1))].sort((a, b) => a - b),
    targetReasons: reasonMap,
    attempts: {},
    updatedAt: now,
  };
  saveClozeReviewTask(task, username);
  return { task, created: true };
}

export function startClozeReviewTask(taskKey, now = Date.now(), username) {
  const task = getClozeReviewTask(taskKey, username);
  if (!task || task.completedAt != null || task.skippedAt != null) return null;
  const next = {
    ...task,
    startedAt: task.startedAt ?? now,
    updatedAt: now,
  };
  saveClozeReviewTask(next, username);
  return next;
}

// 记录一个 target blank 的 review attempt，并推进 currentIndex。
export function recordClozeReviewAttempt({
  taskKey,
  blankId,
  attempt,
  now = Date.now(),
  username,
}) {
  const task = getClozeReviewTask(taskKey, username);
  if (!task || task.completedAt != null || task.skippedAt != null) return null;
  const blankIdKey = String(blankId);
  if (!task.targetBlankIds.map(String).includes(blankIdKey)) return task;
  const normalized = normalizeReviewAttempt(
    { ...attempt, blankIdentity: blankIdKey, reviewedAt: now },
    now,
  );
  if (!normalized) return task;
  const nextAttempts = { ...(task.attempts || {}), [blankIdKey]: normalized };
  const answered = new Set(Object.keys(nextAttempts).map(String));
  let currentIndex = task.currentIndex || 0;
  while (
    currentIndex < task.targetBlankIds.length
    && answered.has(String(task.targetBlankIds[currentIndex]))
  ) {
    currentIndex += 1;
  }
  const next = {
    ...task,
    attempts: nextAttempts,
    currentIndex,
    updatedAt: now,
  };
  saveClozeReviewTask(next, username);
  return next;
}

export function completeClozeReviewTask(taskKey, now = Date.now(), username) {
  const task = getClozeReviewTask(taskKey, username);
  if (!task || task.completedAt != null || task.skippedAt != null) return null;
  const next = {
    ...task,
    currentIndex: task.targetBlankIds.length,
    completedAt: now,
    updatedAt: now,
  };
  saveClozeReviewTask(next, username);
  return next;
}

export function skipClozeReviewTask(taskKey, now = Date.now(), username) {
  const task = getClozeReviewTask(taskKey, username);
  if (!task || task.completedAt != null || task.skippedAt != null) return null;
  const next = { ...task, skippedAt: now, updatedAt: now };
  saveClozeReviewTask(next, username);
  return next;
}

export function clozeReviewTaskStatus(task, today = localDateKey()) {
  if (!task) return "scheduled";
  if (task.skippedAt != null) return "skipped";
  if (task.completedAt != null) return "completed";
  if (task.startedAt != null) return "in_progress";
  if (task.dueDate && task.dueDate < today) return "overdue";
  if (task.dueDate === today) return "due";
  return "scheduled";
}

export function clozeOverdueDays(task, today = localDateKey()) {
  if (!task || clozeReviewTaskStatus(task, today) !== "overdue") return 0;
  return Math.max(1, dateDiffDays(task.dueDate, today));
}

// 下一个未作答 target。任务无目标或全部完成时返回 null。
export function nextClozeReviewBlank(task) {
  if (!task) return null;
  const answered = new Set(Object.keys(task.attempts || {}).map(String));
  for (const blankId of task.targetBlankIds) {
    if (!answered.has(String(blankId))) return Number(blankId);
  }
  return null;
}

// D+1 到期 / D+7 到期的 date key。
export function clozeDueDateFor(type, sourceDate) {
  if (type === TASK_TYPE_D7) return addCalendarDays(sourceDate, D7_DUE_OFFSET_DAYS);
  return addCalendarDays(sourceDate, D1_DUE_OFFSET_DAYS);
}

// ---------------- 调度入口（eager，完成时调用） ----------------

// 由调用方注入的辅助状态构建器（纯函数，不读存储）：
//   referencesEmpty        — 该空没有任何人工 references（仅辅助 signal）；
//   translationUnresolved  — 该空所在句属于笔译目标且已开始翻译但尚未订正。
//                           （从未开始的"待笔译"不是 unresolved signal。）
// translationTargetKeys 为 null 时表示"所有句子都可视为目标"。
export function buildClozeSupportSignals({
  progress,
  sentenceModel,
  translationProgress,
  translationTargetKeys = null,
}) {
  const support = {};
  const attempts = progress?.attempts || {};
  for (const [blankId, attempt] of Object.entries(attempts)) {
    const sentence = sentenceModel?.blankToSentence?.[blankId];
    let translationUnresolved = false;
    if (sentence) {
      const isTarget = !translationTargetKeys || translationTargetKeys.has(sentence.sentenceKey);
      translationUnresolved = isTarget
        && translationEntryFor(translationProgress, sentence.sentenceKey).status === "translated";
    }
    support[blankId] = {
      referencesEmpty: !(attempt?.references?.length > 0),
      translationUnresolved,
    };
  }
  return support;
}

// 完形当天训练完成后 eager 创建 D+1（无目标则不创建）。幂等：已有任务直接返回。
export function scheduleClozeD1Task({
  resourceId,
  clozeId,
  completedAt = Date.now(),
  progress,
  officialAnswers = {},
  supportByBlank = {},
  username,
}) {
  const sourceDate = localDateKey(completedAt);
  const targets = selectD1Targets({ progress, officialAnswers, supportByBlank });
  if (!targets.length) return null;
  const taskKey = clozeReviewTaskKey({ type: TASK_TYPE_D1, resourceId, clozeId, sourceDate });
  const targetReasons = {};
  for (const item of targets) targetReasons[item.blankId] = item.reasons;
  const { task, created } = ensureClozeReviewTask({
    taskKey,
    type: TASK_TYPE_D1,
    resourceId,
    clozeId,
    sourceDate,
    dueDate: clozeDueDateFor(TASK_TYPE_D1, sourceDate),
    targetBlankIds: targets.map((item) => Number(item.blankId)),
    targetReasons,
    now: completedAt,
    username,
  });
  return { task, created, targets };
}

// D+1 完成后 materialize D+7（方案 B）。sourceDate 与 D+1 相同（原完成日期）。
export function scheduleClozeD7Task({
  resourceId,
  clozeId,
  sourceDate,
  d1Task,
  progress,
  officialAnswers = {},
  supportByBlank = {},
  username,
}) {
  const targets = selectD7Targets({ d1Task, progress, officialAnswers, supportByBlank });
  if (!targets.length) return null;
  const taskKey = clozeReviewTaskKey({ type: TASK_TYPE_D7, resourceId, clozeId, sourceDate });
  const targetReasons = {};
  for (const item of targets) targetReasons[item.blankId] = item.reasons;
  const { task, created } = ensureClozeReviewTask({
    taskKey,
    type: TASK_TYPE_D7,
    resourceId,
    clozeId,
    sourceDate,
    dueDate: clozeDueDateFor(TASK_TYPE_D7, sourceDate),
    targetBlankIds: targets.map((item) => Number(item.blankId)),
    targetReasons,
    now: Date.now(),
    username,
  });
  return { task, created, targets };
}
