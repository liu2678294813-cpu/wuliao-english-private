import { getUserItem, listUserItems, setUserItem } from "./userData";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";
import { questionKeyFor } from "./questionEvidence";
import { sentenceKeyFor } from "./translationProgress";

export const REVIEW_SCHEMA_VERSION = 1;
export const REVIEW_TASK_PREFIX = "wuliao:review-task:";
export const REVIEW_TASKS_UPDATED = AppEvent.REVIEW_TASKS_UPDATED;

export const TASK_TYPE_NEXT_DAY = "next_day_article";
export const TASK_TYPE_SENTENCE_RECHECK = "sentence_recheck";

export const REVIEW_STEPS = ["reread", "difficult_sentences", "wrong_questions", "check"];
export const RECHECK_STEPS = ["difficult_sentences", "check"];

function storageKeyForTask(taskKey) {
  return `${REVIEW_TASK_PREFIX}${String(taskKey || "")}`;
}

function normalizeTime(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : null;
}

export function localDateKey(now = Date.now()) {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addCalendarDays(dateKey, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!match) return localDateKey();
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + Number(days),
    12,
    0,
    0,
    0,
  );
  return localDateKey(date.getTime());
}

export function dateDiffDays(fromDateKey, toDateKey) {
  const from = validDateKey(fromDateKey);
  const to = validDateKey(toDateKey);
  if (!from || !to) return 0;
  const a = new Date(`${from}T12:00:00`);
  const b = new Date(`${to}T12:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function reviewTaskKey({ type, resourceId, passageId, sourceDate }) {
  const taskType = type === TASK_TYPE_SENTENCE_RECHECK ? TASK_TYPE_SENTENCE_RECHECK : TASK_TYPE_NEXT_DAY;
  return `review:${taskType}:${encodeURIComponent(String(resourceId || ""))}:${encodeURIComponent(String(passageId || ""))}:${validDateKey(sourceDate) || ""}`;
}

function emptySession(taskType, now) {
  return {
    currentStep: taskType === TASK_TYPE_SENTENCE_RECHECK ? "difficult_sentences" : "reread",
    startedAt: null,
    updatedAt: null,
    activeDurationMs: 0,
    activeSince: null,
    paragraphRecall: {},
    sentenceResults: {},
    reviewAnswers: {},
    checkUnlocked: false,
    completedAt: null,
    summary: null,
  };
}

function normalizeParagraphRecall(value) {
  if (!value || typeof value !== "object") return null;
  return {
    completedAt: normalizeTime(value.completedAt),
    summary: String(value.summary || "").slice(0, 500),
  };
}

function normalizeStringMap(raw, allowed) {
  const output = {};
  if (!raw || typeof raw !== "object") return output;
  for (const [key, value] of Object.entries(raw)) {
    if (!key) continue;
    if (Array.isArray(allowed)) {
      if (allowed.includes(value)) output[key] = value;
    } else if (allowed instanceof RegExp) {
      if (allowed.test(String(value))) output[key] = String(value);
    } else if (typeof value === "string" && value) {
      output[key] = value;
    }
  }
  return output;
}

export function normalizeTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.type === TASK_TYPE_SENTENCE_RECHECK
    ? TASK_TYPE_SENTENCE_RECHECK
    : TASK_TYPE_NEXT_DAY;
  const resourceId = String(raw.resourceId || "");
  const passageId = String(raw.passageId || "");
  if (!resourceId || !passageId) return null;
  const sessionRaw = raw.session && typeof raw.session === "object" ? raw.session : {};
  const task = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    taskKey: String(raw.taskKey || ""),
    type,
    resourceId,
    passageId,
    sourceDate: validDateKey(raw.sourceDate) || localDateKey(),
    dueDate: validDateKey(raw.dueDate) || localDateKey(),
    createdAt: normalizeTime(raw.createdAt),
    startedAt: normalizeTime(raw.startedAt),
    completedAt: normalizeTime(raw.completedAt),
    skippedAt: normalizeTime(raw.skippedAt),
    sentenceKeys: [...new Set((Array.isArray(raw.sentenceKeys) ? raw.sentenceKeys : []).map(String).filter(Boolean))],
    session: {
      currentStep: (type === TASK_TYPE_SENTENCE_RECHECK ? RECHECK_STEPS : REVIEW_STEPS)
        .includes(sessionRaw.currentStep)
        ? sessionRaw.currentStep
        : (type === TASK_TYPE_SENTENCE_RECHECK ? "difficult_sentences" : "reread"),
      startedAt: normalizeTime(sessionRaw.startedAt),
      updatedAt: normalizeTime(sessionRaw.updatedAt),
      activeDurationMs: Math.max(0, Number(sessionRaw.activeDurationMs) || 0),
      activeSince: normalizeTime(sessionRaw.activeSince),
      paragraphRecall: {},
      sentenceResults: normalizeStringMap(sessionRaw.sentenceResults, ["mastered", "difficult"]),
      reviewAnswers: normalizeStringMap(sessionRaw.reviewAnswers, /^[A-D]$/),
      checkUnlocked: Boolean(sessionRaw.checkUnlocked),
      completedAt: normalizeTime(sessionRaw.completedAt),
      summary: sessionRaw.summary && typeof sessionRaw.summary === "object"
        ? { ...sessionRaw.summary }
        : null,
    },
  };
  if (sessionRaw.paragraphRecall && typeof sessionRaw.paragraphRecall === "object") {
    for (const [number, value] of Object.entries(sessionRaw.paragraphRecall)) {
      const normalized = normalizeParagraphRecall(value);
      if (normalized) task.session.paragraphRecall[String(number)] = normalized;
    }
  }
  return task;
}

export function reviewTaskStatus(task, today = localDateKey()) {
  if (!task) return "scheduled";
  if (task.skippedAt != null) return "skipped";
  if (task.completedAt != null) return "completed";
  if (task.session?.currentStep && (task.startedAt != null || task.session.startedAt != null)) {
    return "in_progress";
  }
  if (task.dueDate && task.dueDate < today) return "overdue";
  if (task.dueDate === today) return "due";
  return "scheduled";
}

export function overdueDays(task, today = localDateKey()) {
  if (!task || reviewTaskStatus(task, today) !== "overdue") return 0;
  return Math.max(1, dateDiffDays(task.dueDate, today));
}

export function loadReviewTask(taskKey, username) {
  if (!taskKey) return null;
  try {
    const raw = JSON.parse(getUserItem(storageKeyForTask(taskKey), username) || "");
    const task = normalizeTask(raw);
    if (!task) return null;
    task.taskKey = String(taskKey);
    return task;
  } catch {
    return null;
  }
}

export function listReviewTasks(username) {
  try {
    return listUserItems(REVIEW_TASK_PREFIX, username)
      .map(({ key, value }) => {
        const taskKey = String(key || "").slice(REVIEW_TASK_PREFIX.length);
        if (!taskKey) return null;
        try {
          const task = normalizeTask(JSON.parse(value));
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

export function saveReviewTask(task, username) {
  if (!task?.taskKey || !task.resourceId || !task.passageId) {
    return { ok: false, error: "任务数据不完整" };
  }
  try {
    setUserItem(storageKeyForTask(task.taskKey), JSON.stringify(task), username);
    emitAppEvent(REVIEW_TASKS_UPDATED, { taskKey: task.taskKey });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function findTask(tasks, type, resourceId, passageId) {
  return tasks.find((task) => (
    task.type === type
    && task.resourceId === resourceId
    && task.passageId === passageId
  )) || null;
}

export function findNextDayTask(resourceId, passageId) {
  return findTask(listReviewTasks(), TASK_TYPE_NEXT_DAY, resourceId, passageId);
}

export function createNextDayReviewTask({ resourceId, passageId, now = Date.now() } = {}) {
  if (!resourceId || !passageId) return { ok: false, error: "缺少文章标识" };
  const tasks = listReviewTasks();
  const existing = findTask(tasks, TASK_TYPE_NEXT_DAY, String(resourceId), String(passageId));
  if (existing) return { ok: true, created: false, task: existing };
  const sourceDate = localDateKey(now);
  const task = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    taskKey: reviewTaskKey({
      type: TASK_TYPE_NEXT_DAY,
      resourceId,
      passageId,
      sourceDate,
    }),
    type: TASK_TYPE_NEXT_DAY,
    resourceId: String(resourceId),
    passageId: String(passageId),
    sourceDate,
    dueDate: addCalendarDays(sourceDate, 1),
    createdAt: now,
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    sentenceKeys: [],
    session: emptySession(TASK_TYPE_NEXT_DAY, now),
  };
  const result = saveReviewTask(task);
  return { ...result, created: result.ok, task: result.ok ? task : null };
}

export function scheduleManualReviewTask({ resourceId, passageId, now = Date.now() } = {}) {
  if (!resourceId || !passageId) return { ok: false, error: "缺少文章标识" };
  const tasks = listReviewTasks();
  const existing = findTask(tasks, TASK_TYPE_NEXT_DAY, String(resourceId), String(passageId));
  if (existing) return { ok: true, created: false, task: existing };
  const sourceDate = localDateKey(now);
  const task = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    taskKey: reviewTaskKey({
      type: TASK_TYPE_NEXT_DAY,
      resourceId,
      passageId,
      sourceDate,
    }),
    type: TASK_TYPE_NEXT_DAY,
    resourceId: String(resourceId),
    passageId: String(passageId),
    sourceDate,
    dueDate: sourceDate,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    sentenceKeys: [],
    session: emptySession(TASK_TYPE_NEXT_DAY, now),
  };
  const result = saveReviewTask(task);
  return { ...result, created: result.ok, task: result.ok ? task : null };
}

export function startReviewSession(taskKey, now = Date.now()) {
  const task = loadReviewTask(taskKey);
  if (!task) return { ok: false, error: "复读任务不存在" };
  if (task.completedAt != null || task.skippedAt != null) {
    return { ok: false, error: "复读任务已结束", task };
  }
  task.startedAt = task.startedAt ?? now;
  task.session.startedAt = task.session.startedAt ?? now;
  task.session.activeSince = task.session.activeSince ?? now;
  task.session.updatedAt = now;
  const result = saveReviewTask(task);
  return { ...result, task };
}

export function accumulateActiveDuration(task, now = Date.now()) {
  const session = task?.session;
  if (!session) return task;
  if (
    session.activeSince != null
    && Number.isFinite(Number(session.activeSince))
  ) {
    session.activeDurationMs = Math.max(0, session.activeDurationMs || 0)
      + Math.max(0, now - Number(session.activeSince));
  }
  session.activeSince = now;
  session.updatedAt = now;
  return task;
}

export function pauseReviewTiming(taskKey, now = Date.now()) {
  const task = loadReviewTask(taskKey);
  if (!task) return { ok: false, error: "复读任务不存在" };
  if (task.completedAt != null || task.skippedAt != null) {
    return { ok: false, error: "复读任务已结束", task };
  }
  accumulateActiveDuration(task, now);
  task.session.activeSince = null;
  const result = saveReviewTask(task);
  return { ...result, task };
}

export function resumeReviewTiming(taskKey, now = Date.now()) {
  const task = loadReviewTask(taskKey);
  if (!task) return { ok: false, error: "复读任务不存在" };
  if (task.completedAt != null || task.skippedAt != null) {
    return { ok: false, error: "复读任务已结束", task };
  }
  if (task.session.activeSince == null) {
    task.session.activeSince = now;
    task.session.updatedAt = now;
    const result = saveReviewTask(task);
    return { ...result, task };
  }
  return { ok: true, task };
}

export function updateReviewSession(taskKey, patch = {}, now = Date.now()) {
  const task = loadReviewTask(taskKey);
  if (!task) return { ok: false, error: "复读任务不存在" };
  if (task.completedAt != null || task.skippedAt != null) {
    return { ok: false, error: "复读任务已结束", task };
  }
  const session = task.session;
  accumulateActiveDuration(task, now);
  if (patch.currentStep) {
    const allowed = task.type === TASK_TYPE_SENTENCE_RECHECK ? RECHECK_STEPS : REVIEW_STEPS;
    if (allowed.includes(patch.currentStep)) session.currentStep = patch.currentStep;
  }
  if (patch.paragraphRecall && typeof patch.paragraphRecall === "object") {
    for (const [number, value] of Object.entries(patch.paragraphRecall)) {
      const normalized = normalizeParagraphRecall(value);
      if (normalized) session.paragraphRecall[String(number)] = normalized;
    }
  }
  if (patch.sentenceResults && typeof patch.sentenceResults === "object") {
    for (const [key, value] of Object.entries(patch.sentenceResults)) {
      if (key && (value === "mastered" || value === "difficult")) {
        session.sentenceResults[String(key)] = value;
      }
    }
  }
  if (patch.reviewAnswers && typeof patch.reviewAnswers === "object") {
    for (const [key, value] of Object.entries(patch.reviewAnswers)) {
      if (key && /^[A-D]$/.test(String(value))) session.reviewAnswers[String(key)] = String(value);
    }
  }
  if (patch.checkUnlocked !== undefined) session.checkUnlocked = Boolean(patch.checkUnlocked);
  const result = saveReviewTask(task);
  return { ...result, task };
}

export function completeReviewSession(taskKey, summary = {}, now = Date.now()) {
  const task = loadReviewTask(taskKey);
  if (!task) return { ok: false, error: "复读任务不存在" };
  if (task.completedAt != null) return { ok: true, task };
  accumulateActiveDuration(task, now);
  task.completedAt = now;
  task.session.completedAt = now;
  task.session.summary = {
    ...(task.session.summary || {}),
    ...(summary || {}),
  };
  const result = saveReviewTask(task);
  return { ...result, task };
}

export function skipReviewTask(taskKey, now = Date.now()) {
  const task = loadReviewTask(taskKey);
  if (!task) return { ok: false, error: "复读任务不存在" };
  if (task.completedAt != null || task.skippedAt != null) return { ok: true, task };
  task.skippedAt = now;
  task.session.updatedAt = now;
  const result = saveReviewTask(task);
  return { ...result, task };
}

export function ensureSentenceRecheckTask({
  resourceId,
  passageId,
  sentenceKeys = [],
  now = Date.now(),
  excludeTaskKey = "",
} = {}) {
  if (!resourceId || !passageId) return { ok: false, error: "缺少文章标识" };
  const keys = [...new Set((Array.isArray(sentenceKeys) ? sentenceKeys : []).map(String).filter(Boolean))];
  if (!keys.length) return { ok: false, error: "没有需要复查的句子" };
  const tasks = listReviewTasks();
  const open = tasks.find((task) => (
    task.type === TASK_TYPE_SENTENCE_RECHECK
    && task.resourceId === String(resourceId)
    && task.passageId === String(passageId)
    && task.completedAt == null
    && task.skippedAt == null
    && String(task.taskKey || "") !== String(excludeTaskKey || "")
  ));
  if (open) {
    open.sentenceKeys = [...new Set([...open.sentenceKeys, ...keys])];
    open.session.updatedAt = now;
    const result = saveReviewTask(open);
    return { ...result, task: open };
  }
  const sourceDate = localDateKey(now);
  const task = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    taskKey: reviewTaskKey({
      type: TASK_TYPE_SENTENCE_RECHECK,
      resourceId,
      passageId,
      sourceDate,
    }),
    type: TASK_TYPE_SENTENCE_RECHECK,
    resourceId: String(resourceId),
    passageId: String(passageId),
    sourceDate,
    dueDate: addCalendarDays(sourceDate, 3),
    createdAt: now,
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    sentenceKeys: keys,
    session: emptySession(TASK_TYPE_SENTENCE_RECHECK, now),
  };
  const result = saveReviewTask(task);
  return { ...result, task: result.ok ? task : null };
}

export function wrongQuestionKeys({
  resourceId = "",
  passageId = "",
  questions = [],
  firstAnswers = {},
  redoAnswers = {},
  correctAnswers = {},
} = {}) {
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) {
    return { questions: [], keys: [], skipped: true, reason: "no-questions" };
  }
  const officialCount = list.filter((question) => String(correctAnswers?.[question.number] || "").trim()).length;
  if (!officialCount) {
    return { questions: [], keys: [], skipped: true, reason: "no-answer-key" };
  }
  const selected = [];
  const keys = [];
  list.forEach((question, questionIndex) => {
    const official = String(correctAnswers[question.number] || "").trim();
    if (!official) return;
    const first = String(firstAnswers?.[question.number] || "").trim().toUpperCase();
    const redo = String(redoAnswers?.[question.number] || "").trim().toUpperCase();
    if (!first && !redo) return;
    if ((Boolean(first) && first !== official) || (Boolean(redo) && redo !== official)) {
      selected.push(question);
      keys.push(questionKeyFor({
        resourceId,
        passageId,
        questionNumber: question.number,
        questionStem: question.stem,
        questionIndex,
      }));
    }
  });
  return {
    questions: selected,
    keys,
    skipped: selected.length === 0,
    reason: selected.length === 0 ? "none-wrong" : undefined,
  };
}

export function resolveSentenceKeys(passage, keys = []) {
  const byKey = new Map();
  for (const paragraph of Array.isArray(passage?.paragraphs) ? passage.paragraphs : []) {
    for (let sentenceIndex = 0; sentenceIndex < paragraph.sentences.length; sentenceIndex += 1) {
      const sentenceText = paragraph.sentences[sentenceIndex];
      const key = sentenceKeyFor({
        paragraphNumber: paragraph.number,
        sentenceIndex,
        sentenceText,
      });
      if (!byKey.has(key)) {
        byKey.set(key, {
          paragraphNumber: paragraph.number,
          sentenceIndex,
          sentenceText,
        });
      }
    }
  }
  return [...new Set((Array.isArray(keys) ? keys : []).map(String).filter(Boolean))].map((key) => {
    const item = byKey.get(key);
    return item
      ? { key, status: "resolved", ...item }
      : { key, status: "unresolved" };
  });
}

export function homeReviewSummary(tasks = [], today = localDateKey()) {
  const classified = tasks.map((task) => ({ task, status: reviewTaskStatus(task, today) }));
  const priority = { in_progress: 0, overdue: 1, due: 2 };
  const todayItems = classified
    .filter(({ status }) => status === "in_progress" || status === "overdue" || status === "due")
    .sort((a, b) => {
      const diff = priority[a.status] - priority[b.status];
      if (diff) return diff;
      const dueDiff = String(a.task.dueDate).localeCompare(String(b.task.dueDate));
      if (dueDiff) return dueDiff;
      return (a.task.createdAt || 0) - (b.task.createdAt || 0);
    })
    .map(({ task, status }) => ({ task, status }));
  const upcoming = classified.filter(({ status, task }) => (
    status === "scheduled"
    && task.dueDate
    && task.dueDate > today
    && task.dueDate <= addCalendarDays(today, 7)
  ));
  return {
    todayItems,
    todayCount: todayItems.length,
    overdueCount: todayItems.filter(({ status }) => status === "overdue").length,
    inProgressCount: todayItems.filter(({ status }) => status === "in_progress").length,
    dueCount: todayItems.filter(({ status }) => status === "due").length,
    upcomingCount: classified.filter(({ status }) => status === "scheduled").length,
    future7Count: upcoming.length,
    future7Items: upcoming
      .sort((a, b) => String(a.task.dueDate).localeCompare(String(b.task.dueDate)))
      .map(({ task, status }) => ({ task, status })),
    completedCount: classified.filter(({ status }) => status === "completed").length,
    skippedCount: classified.filter(({ status }) => status === "skipped").length,
  };
}

export function reviewCheckUnlocked(task) {
  return Boolean(task?.session?.checkUnlocked);
}
