import { verifiedOfficialAnswers } from "./import/answers.js";
import { STAGE_IDS, STAGE_LABELS, isWorkflowCompleted } from "./readingFlow";
import {
  TASK_TYPE_NEXT_DAY,
  TASK_TYPE_SENTENCE_RECHECK,
  homeReviewSummary,
  listReviewTasks,
  localDateKey,
  reviewTaskStatus,
} from "./readingReview";
import {
  countsForPassage,
  listNeedsReviewSentenceKeys,
} from "./translationProgress";
import { getCurrentUsername, listUserItems } from "./userData";
import {
  CLOZE_REVIEW_TASKS_UPDATED,
  clozeOverdueDays,
  clozeReviewTaskStatus,
  listClozeReviewTasks,
} from "./clozeReview";
import { AppEvent } from "./events/eventTypes";

const FLOW_PREFIX = "wuliao:reading-flow:";
const ACTIVITY_PREFIX = "wuliao:reading-activity:";
const TRANSLATION_PREFIX = "wuliao:translation-progress:";
const ANSWER_PREFIX = "wuliao:deep-answers:";
const LEGACY_ANSWERS_PREFIX = "wuliao:answers:";
const WRITING_SESSION_PREFIX = "wuliao:writing-session:v1:";
const WRITING_REVIEW_TASK_PREFIX = "wuliao:writing-review-task:v1:";

const ARTICLE_SEP = "\u0000";

const SCAN_INVALIDATION_EVENTS = [
  "wuliao:review-tasks-updated",
  "wuliao:learning-records-updated",
  "wuliao:unknown-words-updated",
  "wuliao:rank-updated",
  "wuliao:account-changed",
  AppEvent.LEARNING_STATE_INVALIDATED,
  AppEvent.VOCABULARY_SESSION_UPDATED,
  CLOZE_REVIEW_TASKS_UPDATED,
];

let scanCache = null;
let scanRevision = 0;
let scanCacheInitialized = false;
let scanCount = 0;
const scanCacheEnabled = typeof document !== "undefined"
  && typeof globalThis.window !== "undefined"
  && typeof globalThis.window.addEventListener === "function";

function invalidateLearningScanCache() {
  scanRevision += 1;
  scanCache = null;
}

// R3：快照 revision / 扫描计数（仅内存运行时统计，不持久化、不暴露给普通用户）。
export function getLearningScanRevision() {
  return scanRevision;
}

export function getLearningScanCount() {
  return scanCount;
}

export function initLearningScanCache() {
  if (!scanCacheEnabled || scanCacheInitialized) return;
  scanCacheInitialized = true;
  for (const eventName of SCAN_INVALIDATION_EVENTS) {
    globalThis.window.addEventListener(eventName, invalidateLearningScanCache);
  }
}

initLearningScanCache();

function articleKey(resourceId, passageId) {
  return `${String(resourceId || "")}${ARTICLE_SEP}${String(passageId || "")}`;
}

function idsFromKeyParts(rest) {
  const separator = String(rest || "").indexOf(":");
  if (separator <= 0 || separator >= String(rest || "").length - 1) return null;
  return {
    resourceId: String(rest).slice(0, separator),
    passageId: String(rest).slice(separator + 1),
  };
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(String(value || "")) || fallback;
  } catch {
    return fallback;
  }
}

function scanWritingSummaries(username) {
  const diagnostics = [];
  const writingSessions = [];
  const writingReviewTasks = [];
  for (const { key, value } of listUserItems(WRITING_SESSION_PREFIX)) {
    const sessionId = String(key || "").slice(WRITING_SESSION_PREFIX.length);
    const record = parseJson(value, null);
    if (!record
      || record.sessionId !== sessionId
      || record.username !== username
      || record.schemaVersion !== 1
      || !/^[0-9a-f]{64}$/.test(record.fingerprint)
      || !["ACTIVE", "COMPLETED"].includes(record.status)) {
      diagnostics.push({ code: record?.username != null && record.username !== username ? "account_mismatch" : "damaged", recordType: "WritingSession", id: sessionId });
      continue;
    }
    writingSessions.push({
      sessionId,
      taskType: record.taskType,
      year: record.year,
      status: record.status,
      currentStage: record.currentStage,
      lastActiveAt: record.lastActiveAt,
      completedAt: record.completedAt,
    });
  }
  for (const { key, value } of listUserItems(WRITING_REVIEW_TASK_PREFIX)) {
    const taskId = String(key || "").slice(WRITING_REVIEW_TASK_PREFIX.length);
    const record = parseJson(value, null);
    if (!record
      || record.taskId !== taskId
      || record.username !== username
      || record.schemaVersion !== 1
      || !/^[0-9a-f]{64}$/.test(record.fingerprint)
      || !["pending", "in_progress", "completed", "dismissed"].includes(record.status)) {
      diagnostics.push({ code: record?.username != null && record.username !== username ? "account_mismatch" : "damaged", recordType: "WritingReviewTask", id: taskId });
      continue;
    }
    writingReviewTasks.push({
      taskId,
      sourceSessionId: record.sourceSessionId,
      reviewType: record.reviewType,
      scheduledDate: record.scheduledDate,
      status: record.status,
    });
  }
  writingSessions.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));
  writingReviewTasks.sort((a, b) => String(a.taskId).localeCompare(String(b.taskId)));
  return { writingSessions, writingReviewTasks, writingDiagnostics: diagnostics };
}

function buildLearningScan(today) {
  const username = getCurrentUsername();
  const flows = new Map();
  const activities = new Map();
  const progressMap = new Map();
  const firstAnswers = new Map();
  const redoAnswers = new Map();
  const legacyAnswersByResource = new Map();

  for (const { key, value } of listUserItems(FLOW_PREFIX)) {
    const ids = idsFromKeyParts(String(key || "").slice(FLOW_PREFIX.length));
    if (!ids) continue;
    const flow = parseJson(value, null);
    if (!flow || !flow.resourceId) continue;
    flows.set(articleKey(ids.resourceId, ids.passageId), flow);
  }
  for (const { key, value } of listUserItems(ACTIVITY_PREFIX)) {
    const ids = idsFromKeyParts(String(key || "").slice(ACTIVITY_PREFIX.length));
    if (!ids) continue;
    const activity = parseJson(value, null);
    if (activity) activities.set(articleKey(ids.resourceId, ids.passageId), activity);
  }
  for (const { key, value } of listUserItems(TRANSLATION_PREFIX)) {
    const ids = idsFromKeyParts(String(key || "").slice(TRANSLATION_PREFIX.length));
    if (!ids) continue;
    const progress = parseJson(value, null);
    if (progress) progressMap.set(articleKey(ids.resourceId, ids.passageId), progress);
  }
  for (const { key, value } of listUserItems(ANSWER_PREFIX)) {
    const rest = String(key || "").slice(ANSWER_PREFIX.length);
    const match = /^(.*):(first|redo|drawer)$/.exec(rest);
    if (!match) continue;
    const ids = idsFromKeyParts(match[1]);
    if (!ids) continue;
    const answers = parseJson(value, {});
    if (!answers || typeof answers !== "object") continue;
    const target = match[2] === "first" ? firstAnswers : match[2] === "redo" ? redoAnswers : null;
    if (target) target.set(articleKey(ids.resourceId, ids.passageId), answers);
  }
  for (const { key, value } of listUserItems(LEGACY_ANSWERS_PREFIX)) {
    const resourceId = String(key || "").slice(LEGACY_ANSWERS_PREFIX.length);
    if (!resourceId) continue;
    const answers = parseJson(value, {});
    if (answers && typeof answers === "object") {
      legacyAnswersByResource.set(resourceId, answers);
    }
  }
  const tasks = listReviewTasks();
  const clozeReviewTasks = listClozeReviewTasks();
  const writing = scanWritingSummaries(username);
  return {
    flows,
    activities,
    progressMap,
    firstAnswers,
    redoAnswers,
    legacyAnswersByResource,
    tasks,
    reviewSummary: homeReviewSummary(tasks, today),
    clozeReviewTasks,
    clozeReviewSummary: summarizeClozeReviewTasks(clozeReviewTasks, today),
    ...writing,
    today,
  };
}

// 完形长期复习任务汇总（d1/d7 通用，status 语义与 reading review 对齐）。
export function summarizeClozeReviewTasks(tasks, today = localDateKey()) {
  let inProgressCount = 0;
  let overdueCount = 0;
  let dueCount = 0;
  let upcomingCount = 0;
  let completedCount = 0;
  let skippedCount = 0;
  const todayItems = [];
  for (const task of tasks || []) {
    const status = clozeReviewTaskStatus(task, today);
    if (status === "in_progress") inProgressCount += 1;
    if (status === "overdue") overdueCount += 1;
    if (status === "due") dueCount += 1;
    if (status === "scheduled") upcomingCount += 1;
    if (status === "completed") completedCount += 1;
    if (status === "skipped") skippedCount += 1;
    if (status === "in_progress" || status === "overdue" || status === "due") {
      todayItems.push({ task, status });
    }
  }
  todayItems.sort((a, b) => (
    String(a.task.dueDate).localeCompare(String(b.task.dueDate))
    || (b.task.createdAt || 0) - (a.task.createdAt || 0)
  ));
  return {
    inProgressCount,
    overdueCount,
    dueCount,
    upcomingCount,
    completedCount,
    skippedCount,
    todayCount: todayItems.length,
    overdueDays: Math.max(...todayItems.map(({ task }) => clozeOverdueDays(task, today)), 0),
    todayItems,
  };
}

export function scanLearningState({ today = localDateKey(), force = false } = {}) {
  const username = getCurrentUsername();
  if (
    scanCacheEnabled
    && !force
    && scanCache
    && scanCache.username === username
    && scanCache.today === today
  ) {
    return scanCache.data;
  }
  scanCount += 1;
  const data = buildLearningScan(today);
  if (scanCacheEnabled) scanCache = { username, today, revision: scanRevision, data };
  return data;
}

function resourceTitle(resources, resourceId) {
  return (Array.isArray(resources) ? resources : []).find(
    (item) => String(item.id || "") === String(resourceId || ""),
  )?.title || "";
}

function sentenceProgressFor(scan, ids, customPdfs) {
  const custom = (Array.isArray(customPdfs) ? customPdfs : []).find(
    (item) => String(item.id || "") === String(ids.resourceId || ""),
  );
  const passage = custom?.analysis?.passages?.find(
    (item) => String(item.id || "") === String(ids.passageId || ""),
  );
  if (!passage) return null;
  const progress = scan.progressMap.get(articleKey(ids.resourceId, ids.passageId));
  const counts = countsForPassage(progress, passage);
  return {
    total: counts.total,
    correctedCount: counts.correctedCount,
  };
}

function officialAnswersFor(scan, ids, resources) {
  const resource = (Array.isArray(resources) ? resources : []).find(
    (item) => String(item.id || "") === String(ids.resourceId || ""),
  );
  if (resource && resource.kind !== "custom") {
    return verifiedOfficialAnswers(resource, "reading");
  }
  // Custom/imported PDFs remain answerless even if an older app version left an
  // answer-key record behind. A scanned answer page is not a reliable official key.
  return {};
}

function enrichContinueReading(scan, ids, flow, resources, customPdfs) {
  const stageIndex = Math.max(0, STAGE_IDS.indexOf(flow?.currentStage || "deep-cover"));
  return {
    resourceId: ids.resourceId,
    passageId: ids.passageId,
    title: resourceTitle(resources, ids.resourceId)
      || resourceTitle(customPdfs, ids.resourceId)
      || "未命名资料",
    stageId: flow?.currentStage || "deep-cover",
    stageLabel: STAGE_LABELS[flow?.currentStage] || "",
    stageIndex: stageIndex + 1,
    stageTotal: STAGE_IDS.length,
    sentenceProgress: sentenceProgressFor(scan, ids, customPdfs),
    updatedAt: Number(flow?.updatedAt) || 0,
  };
}

export function buildTodayTasks(
  scan,
  { resources = [], customPdfs = [] } = {},
) {
  const incomplete = [];
  for (const [key, flow] of scan.flows.entries()) {
    if (isWorkflowCompleted(flow)) continue;
    const [resourceId, passageId] = String(key).split(ARTICLE_SEP);
    incomplete.push({
      resourceId,
      passageId,
      flow,
      updatedAt: Number(flow.updatedAt) || 0,
    });
  }
  incomplete.sort((a, b) => b.updatedAt - a.updatedAt);

  const topIncomplete = incomplete[0] || null;
  const continueReading = topIncomplete
    ? enrichContinueReading(scan, topIncomplete, topIncomplete.flow, resources, customPdfs)
    : null;
  const moreInProgress = incomplete.slice(1).map((item) => ({
    resourceId: item.resourceId,
    passageId: item.passageId,
    title: resourceTitle(resources, item.resourceId)
      || resourceTitle(customPdfs, item.resourceId)
      || "未命名资料",
    stageLabel: STAGE_LABELS[item.flow?.currentStage] || "",
    stageIndex: Math.max(0, STAGE_IDS.indexOf(item.flow?.currentStage || "deep-cover")) + 1,
    stageTotal: STAGE_IDS.length,
    updatedAt: item.updatedAt,
  }));

  const openTaskKeys = new Set();
  const recheckCoveredKeys = new Set();
  const completedReviewWrong = new Map();
  for (const task of scan.tasks) {
    const status = reviewTaskStatus(task, scan.today);
    const key = articleKey(task.resourceId, task.passageId);
    if (status !== "completed" && status !== "skipped") {
      openTaskKeys.add(key);
      if (task.type === TASK_TYPE_SENTENCE_RECHECK) {
        for (const sentenceKey of task.sentenceKeys || []) {
          recheckCoveredKeys.add(String(sentenceKey));
        }
      }
      continue;
    }
    if (status !== "completed" || task.type !== TASK_TYPE_NEXT_DAY) continue;
    const official = officialAnswersFor(scan, task, resources);
    let wrong = 0;
    for (const [answerKey, answer] of Object.entries(task.session?.reviewAnswers || {})) {
      const match = /::q(\d+)::/.exec(String(answerKey));
      if (!match) continue;
      const officialAnswer = String(official?.[match[1]] || "").trim().toUpperCase();
      if (!officialAnswer) continue;
      if (String(answer || "").trim().toUpperCase() !== officialAnswer) wrong += 1;
    }
    if (wrong > 0) completedReviewWrong.set(key, (completedReviewWrong.get(key) || 0) + wrong);
  }

  const pendingByArticle = new Map();
  const considerPending = (ids, updatedAt) => {
    const key = articleKey(ids.resourceId, ids.passageId);
    if (openTaskKeys.has(key)) return;
    const flow = scan.flows.get(key);
    if (flow && !isWorkflowCompleted(flow)) return;
    if (!pendingByArticle.has(key)) {
      pendingByArticle.set(key, {
        resourceId: ids.resourceId,
        passageId: ids.passageId,
        difficultCount: 0,
        questionCount: 0,
        updatedAt: Math.max(0, Number(updatedAt) || 0),
      });
    }
  };

  for (const [key, progress] of scan.progressMap.entries()) {
    const [resourceId, passageId] = String(key).split(ARTICLE_SEP);
    considerPending({ resourceId, passageId }, progress.updatedAt);
    const item = pendingByArticle.get(key);
    if (!item) continue;
    item.difficultCount = listNeedsReviewSentenceKeys(progress)
      .filter((sentenceKey) => !recheckCoveredKeys.has(String(sentenceKey)))
      .length;
    item.updatedAt = Math.max(item.updatedAt, Number(progress.updatedAt) || 0);
    if (item.difficultCount === 0) pendingByArticle.delete(key);
  }

  for (const [key, answers] of scan.redoAnswers.entries()) {
    const [resourceId, passageId] = String(key).split(ARTICLE_SEP);
    const ids = { resourceId, passageId };
    considerPending(ids, 0);
    const item = pendingByArticle.get(key);
    if (!item) continue;
    const official = officialAnswersFor(scan, ids, resources);
    let wrong = 0;
    for (const [number, answer] of Object.entries(answers)) {
      const officialAnswer = String(official?.[number] || "").trim().toUpperCase();
      if (!officialAnswer) continue;
      if (String(answer || "").trim().toUpperCase() !== officialAnswer) wrong += 1;
    }
    item.questionCount += wrong;
    item.updatedAt = Math.max(item.updatedAt, Number(scan.flows.get(key)?.updatedAt) || 0);
    if (item.questionCount === 0 && item.difficultCount === 0) pendingByArticle.delete(key);
  }

  for (const [key, wrong] of completedReviewWrong.entries()) {
    const [resourceId, passageId] = String(key).split(ARTICLE_SEP);
    considerPending({ resourceId, passageId }, 0);
    const item = pendingByArticle.get(key);
    if (!item) continue;
    item.questionCount += wrong;
  }

  const pendingGroups = [...pendingByArticle.values()]
    .filter((item) => item.difficultCount > 0 || item.questionCount > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((item) => ({
      ...item,
      title: resourceTitle(resources, item.resourceId)
        || resourceTitle(customPdfs, item.resourceId)
        || "未命名资料",
    }));

  const hasAny = Boolean(
    scan.reviewSummary.todayCount > 0
    || continueReading
    || pendingGroups.length > 0,
  );

  return {
    reviewSummary: scan.reviewSummary,
    continueReading,
    moreInProgressCount: moreInProgress.length,
    moreInProgress,
    pendingGroups,
    hasAny,
    today: scan.today,
  };
}

export function buildLibraryStatusMap(
  scan,
  { resources = [] } = {},
) {
  const statuses = {};
  for (const resource of Array.isArray(resources) ? resources : []) {
    const resourceId = String(resource.id || "");
    const keys = [...scan.flows.keys()].filter(
      (key) => String(key).startsWith(`${resourceId}${ARTICLE_SEP}`),
    );
    const progressKeys = [...scan.progressMap.keys()].filter(
      (key) => String(key).startsWith(`${resourceId}${ARTICLE_SEP}`),
    );
    const answerKeys = [...scan.redoAnswers.keys()].filter(
      (key) => String(key).startsWith(`${resourceId}${ARTICLE_SEP}`),
    );
    const activityKeys = [...scan.activities.keys()].filter(
      (key) => String(key).startsWith(`${resourceId}${ARTICLE_SEP}`),
    );
    const openReview = scan.tasks.some((task) => {
      if (String(task.resourceId || "") !== resourceId) return false;
      const status = reviewTaskStatus(task, scan.today);
      return status !== "completed" && status !== "skipped";
    });
    const incompleteFlows = keys
      .map((key) => scan.flows.get(key))
      .filter((flow) => !isWorkflowCompleted(flow))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const hasCompleted = keys.some((key) => isWorkflowCompleted(scan.flows.get(key)))
      || activityKeys.some((key) => scan.activities.get(key)?.completed === true);
    let needsReviewTotal = 0;
    for (const key of progressKeys) {
      needsReviewTotal += listNeedsReviewSentenceKeys(scan.progressMap.get(key)).length;
    }
    let questionReviewTotal = 0;
    for (const key of answerKeys) {
      const [firstPart] = String(key).split(ARTICLE_SEP);
      const ids = { resourceId: firstPart, passageId: String(key).slice(firstPart.length + 1) };
      const official = officialAnswersFor(scan, ids, resources);
      for (const [number, answer] of Object.entries(scan.redoAnswers.get(key) || {})) {
        const officialAnswer = String(official?.[number] || "").trim().toUpperCase();
        if (!officialAnswer) continue;
        if (String(answer || "").trim().toUpperCase() !== officialAnswer) questionReviewTotal += 1;
      }
    }

    const hasRecords = Boolean(
      keys.length || progressKeys.length || answerKeys.length || activityKeys.length,
    );
    let label = "";
    if (openReview) {
      label = "待复读";
    } else if (incompleteFlows.length) {
      label = `进行中 · ${STAGE_LABELS[incompleteFlows[0].currentStage] || "精读"}`;
    } else if (hasCompleted) {
      const pending = needsReviewTotal + questionReviewTotal;
      label = pending > 0 ? `✓ 已完成 · 待复盘 ${pending}` : "✓ 已完成";
    } else if (hasRecords) {
      label = "已开始";
    }
    statuses[resourceId] = {
      label,
      hasRecords,
      needsReviewTotal,
      questionReviewTotal,
    };
  }
  return statuses;
}

export { TASK_TYPE_NEXT_DAY, TASK_TYPE_SENTENCE_RECHECK };
