/**
 * Study Planner 数据源适配层。
 *
 * 职责：从现有业务模块（readingFlow / readingReview / aiLearningRecords /
 * 词汇真实数据库）只读读取状态，构建统一 Task Candidate。
 * 不保存任何学习完成状态，不调用 AI，不修改任何业务数据。
 */

import { STAGE_IDS, STAGE_LABELS, isWorkflowCompleted } from "./readingFlow";
import {
  TASK_TYPE_SENTENCE_RECHECK,
  listReviewTasks,
  localDateKey,
  overdueDays,
  reviewTaskStatus,
} from "./readingReview";
import { scanLearningState } from "./todayTasks";
import { countsForPassage } from "./translationProgress";
import { filterRecordsByRange, isReliableTag } from "./aiLearningStats";
import { listLearningRecords } from "./aiLearningRecords";
import { getCurrentUsername } from "./userData";
import { listCustomPdfs } from "./storage";
import {
  clozeOverdueDays,
  clozeReviewTaskStatus,
  TASK_TYPE_D1,
  TASK_TYPE_D7,
} from "./clozeReview";
import {
  TASK_TYPE_CLOZE_REVIEW,
  TASK_TYPE_EXAM_FOLLOWUP,
  TASK_TYPE_CONTINUE_READING,
  TASK_TYPE_CONTINUE_WRITING,
  TASK_TYPE_BLOCKED_READING,
  TASK_TYPE_LEARNING_REVIEW,
  TASK_TYPE_NEW_READING,
  TASK_TYPE_REVIEW,
  TASK_TYPE_VOCABULARY_REVIEW,
  TASK_TYPE_WRITING_REVIEW,
  TIER_CONTINUE_READING,
  TIER_DUE_REVIEW,
  TIER_LEARNING_REVIEW,
  TIER_NEW_READING,
  TIER_OVERDUE_REVIEW,
  TIER_VOCABULARY_REVIEW,
  estimateTaskDuration,
  planStudyDay,
} from "./studyPlanner";
import { listUserItems } from "./userData";

function buildExamFollowupCandidates() {
  const records = listUserItems("wuliao:exam-handoff:v1:");
  return records.map(({ value }) => {
    try { return JSON.parse(value); } catch { return null; }
  }).filter((record) => record && (record.status === "selected" || record.status === "started"))
    .sort((a, b) => String(a.targetId).localeCompare(String(b.targetId)))
    .slice(0, 5)
    .map((record) => {
      const started = record.status === "started";
      const candidate = {
        id: `exam-followup:${record.examResultId}:${record.targetId}`,
        type: TASK_TYPE_EXAM_FOLLOWUP,
        source: "examHandoff",
        title: record.targetId.startsWith("cloze:") ? "整卷模拟：完形回看" : "整卷模拟：阅读回看",
        subtitle: started ? "已开始的考试后续学习" : "来自整卷模拟的自选后续学习",
        mandatory: false,
        blocked: false,
        reasonCodes: [started ? "exam-followup.started" : "exam-followup.selected"],
        reasonText: started ? "继续完成已开始的考试后续学习" : "由你在成绩页主动加入",
        statusLabel: started ? "进行中" : "待开始",
        action: { type: "exam-followup", examResultId: record.examResultId, targetId: record.targetId },
        metadata: record,
        priorityTier: started ? TIER_CONTINUE_READING : TIER_LEARNING_REVIEW,
      };
      candidate.estimatedMinutes = estimateTaskDuration(candidate);
      return candidate;
    });
}
import { loadPlanState } from "./studyPlannerStorage";

export const VOCABULARY_MEMORY_DB_NAME = "KaoyanVocabMemorizeDB";
export const VOCABULARY_MEMORY_RECORD_STORE = "records";
export const VOCABULARY_SESSION_KEY_PREFIX = "kaoyan_vocab_daily_review:";

function resourceTitle(resources, customPdfs, resourceId) {
  const list = Array.isArray(resources) ? resources : [];
  const custom = Array.isArray(customPdfs) ? customPdfs : [];
  return list.find((item) => String(item.id || "") === String(resourceId || ""))?.title
    || custom.find((item) => String(item.id || "") === String(resourceId || ""))?.title
    || "";
}

function validResourceIds(resources, customPdfs) {
  return new Set([
    ...(Array.isArray(resources) ? resources : []).map((item) => String(item.id || "")),
    ...(Array.isArray(customPdfs) ? customPdfs : []).map((item) => String(item.id || "")),
  ].filter(Boolean));
}

function articleKey(resourceId, passageId) {
  return `${String(resourceId || "")}\u0000${String(passageId || "")}`;
}

function buildReviewCandidates({ scan, resources, customPdfs, today }) {
  const output = [];
  for (const task of scan.tasks || []) {
    const status = reviewTaskStatus(task, today);
    if (status !== "in_progress" && status !== "overdue" && status !== "due") continue;
    const isRecheck = task.type === TASK_TYPE_SENTENCE_RECHECK;
    const overdue = overdueDays(task, today);
    const sentenceCount = (task.sentenceKeys || []).length;
    let tier = TIER_DUE_REVIEW;
    let reasonCodes = ["review.due-today"];
    let reasonText = isRecheck ? "今天到期的困难句复查" : "今天到期的次日复读";
    let statusLabel = "今日到期";
    if (status === "overdue") {
      tier = TIER_OVERDUE_REVIEW;
      reasonCodes = ["review.overdue"];
      reasonText = `已逾期 ${overdue} 天，应优先完成`;
      statusLabel = `逾期 ${overdue} 天`;
    } else if (status === "in_progress") {
      reasonCodes = ["review.in-progress"];
      reasonText = "进行中的复读，先继续完成";
      statusLabel = "进行中";
    }
    const candidate = {
      id: `review:${task.taskKey}`,
      type: TASK_TYPE_REVIEW,
      source: "readingReview",
      title: resourceTitle(resources, customPdfs, task.resourceId) || "自定义资料",
      subtitle: isRecheck ? `困难句复查 · ${sentenceCount} 句` : "次日复读",
      dueDate: task.dueDate,
      overdueDays: overdue,
      mandatory: true,
      blocked: false,
      reasonCodes,
      reasonText,
      statusLabel,
      action: { type: "review", taskKey: task.taskKey },
      metadata: {
        taskKey: task.taskKey,
        taskType: task.type,
        resourceId: task.resourceId,
        passageId: task.passageId,
        sentenceCount,
        status,
        createdAt: task.createdAt,
        task,
      },
    };
    candidate.priorityTier = tier;
    candidate.estimatedMinutes = estimateTaskDuration(candidate);
    output.push(candidate);
  }
  return output;
}

function remainingTranslationSentences(scan, customPdfs, resourceId, passageId) {
  const custom = (Array.isArray(customPdfs) ? customPdfs : []).find(
    (item) => String(item.id || "") === String(resourceId || ""),
  );
  const passage = custom?.analysis?.passages?.find(
    (item) => String(item.id || "") === String(passageId || ""),
  );
  if (!passage) return null;
  const progress = scan.progressMap.get(articleKey(resourceId, passageId));
  const counts = countsForPassage(progress, passage);
  return Math.max(0, counts.total - counts.correctedCount);
}

function buildContinueReadingCandidates({ scan, resources, customPdfs }) {
  const valid = validResourceIds(resources, customPdfs);
  const incomplete = [];
  for (const [key, flow] of scan.flows.entries()) {
    if (isWorkflowCompleted(flow)) continue;
    const [resourceId, passageId] = String(key).split("\u0000");
    if (!valid.has(String(resourceId))) continue;
    incomplete.push({ resourceId, passageId, flow });
  }
  incomplete.sort((a, b) => {
    const diff = (b.flow?.updatedAt || 0) - (a.flow?.updatedAt || 0);
    if (diff) return diff;
    return `${a.resourceId}\u0000${a.passageId}`.localeCompare(`${b.resourceId}\u0000${b.passageId}`, "zh");
  });

  return incomplete.map(({ resourceId, passageId, flow }) => {
    const stageId = flow.currentStage || "deep-cover";
    const stageIndex = Math.max(0, STAGE_IDS.indexOf(stageId)) + 1;
    const meta = {
      resourceId,
      passageId,
      stageId,
      stageIndex,
      stageTotal: STAGE_IDS.length,
      updatedAt: Number(flow.updatedAt) || 0,
    };
    if (stageId === "deep-translation") {
      const remaining = remainingTranslationSentences(scan, customPdfs, resourceId, passageId);
      if (remaining != null) meta.remainingSentenceCount = remaining;
    }
    const candidate = {
      id: `reading:${resourceId}:${passageId}`,
      type: TASK_TYPE_CONTINUE_READING,
      source: "readingFlow",
      title: resourceTitle(resources, customPdfs, resourceId) || "未命名资料",
      subtitle: `${STAGE_LABELS[stageId] || stageId} · 第 ${stageIndex}/${STAGE_IDS.length} 阶段`,
      mandatory: false,
      blocked: false,
      reasonCodes: ["reading.in-progress"],
      reasonText: `你已开始这篇精读（${STAGE_LABELS[stageId] || stageId}），建议先继续而不是新开文章`,
      action: { type: "continue-reading", resourceId, passageId },
      metadata: meta,
    };
    candidate.priorityTier = TIER_CONTINUE_READING;
    candidate.estimatedMinutes = estimateTaskDuration(candidate);
    return candidate;
  });
}

function buildClozeReviewCandidates({ scan, resources, customPdfs, today }) {
  const output = [];
  for (const task of scan.clozeReviewTasks || []) {
    const status = clozeReviewTaskStatus(task, today);
    if (status !== "in_progress" && status !== "overdue" && status !== "due") continue;
    const isD7 = task.type === TASK_TYPE_D7;
    const overdue = clozeOverdueDays(task, today);
    const targetCount = (task.targetBlankIds || []).length;
    const remainingCount = Math.max(
      0,
      targetCount - Object.keys(task.attempts || {}).length,
    );
    let tier = TIER_DUE_REVIEW;
    let reasonCodes = ["cloze-review.due-today"];
    let reasonText = isD7 ? "今天到期的完形 D+7 确认" : "今天到期的完形 D+1 复习";
    let statusLabel = "今日到期";
    if (status === "overdue") {
      tier = TIER_OVERDUE_REVIEW;
      reasonCodes = ["cloze-review.overdue"];
      reasonText = `已逾期 ${overdue} 天，应优先完成`;
      statusLabel = `逾期 ${overdue} 天`;
    } else if (status === "in_progress") {
      reasonCodes = ["cloze-review.in-progress"];
      reasonText = "进行中的完形复习，先继续完成";
      statusLabel = "进行中";
    }
    const candidate = {
      id: `cloze-review:${task.taskKey}`,
      type: TASK_TYPE_CLOZE_REVIEW,
      source: "clozeReview",
      title: resourceTitle(resources, customPdfs, task.resourceId) || "自定义完形资料",
      subtitle: isD7 ? `完形 D+7 确认 · 剩余 ${remainingCount} 空` : `完形 D+1 复习 · 剩余 ${remainingCount} 空`,
      dueDate: task.dueDate,
      overdueDays: overdue,
      mandatory: true,
      blocked: false,
      reasonCodes,
      reasonText,
      statusLabel,
      action: { type: "cloze-review", taskKey: task.taskKey },
      metadata: {
        taskKey: task.taskKey,
        taskType: task.type,
        resourceId: task.resourceId,
        clozeId: task.clozeId,
        targetCount,
        remainingCount,
        status,
        createdAt: task.createdAt,
        task,
      },
    };
    candidate.priorityTier = tier;
    candidate.estimatedMinutes = estimateTaskDuration(candidate);
    output.push(candidate);
  }
  return output;
}

function calendarDayNumber(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const result = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(result) ? Math.floor(result / 86400000) : null;
}

export function buildWritingPlannerCandidates({ scan, today = localDateKey() } = {}) {
  const candidates = [];
  const seen = new Set();
  for (const session of scan?.writingSessions || []) {
    if (session.status !== "ACTIVE") continue;
    const candidate = {
      id: `writing:${session.sessionId}`,
      type: TASK_TYPE_CONTINUE_WRITING,
      source: "writingSession",
      title: session.year ? `${session.year} Writing` : "Writing",
      subtitle: `继续写作 · ${session.currentStage}`,
      mandatory: false,
      blocked: false,
      reasonCodes: ["writing.in-progress"],
      reasonText: "你有一篇尚未完成的写作，建议继续当前进度",
      statusLabel: "进行中",
      action: { type: "continue-writing", sessionId: session.sessionId },
      metadata: {
        sessionId: session.sessionId,
        taskType: session.taskType,
        stageId: session.currentStage,
        updatedAt: Number(session.lastActiveAt) || 0,
      },
      priorityTier: TIER_CONTINUE_READING,
    };
    candidate.estimatedMinutes = estimateTaskDuration(candidate);
    if (!seen.has(candidate.id)) {
      seen.add(candidate.id);
      candidates.push(candidate);
    }
  }
  const todayDay = calendarDayNumber(today);
  for (const task of scan?.writingReviewTasks || []) {
    if (!["pending", "in_progress"].includes(task.status)) continue;
    const scheduledDay = calendarDayNumber(task.scheduledDate);
    if (scheduledDay === null || todayDay === null) continue;
    const inProgress = task.status === "in_progress";
    if (!inProgress && scheduledDay > todayDay) continue;
    const overdue = Math.max(0, todayDay - scheduledDay);
    const isOverdue = !inProgress && overdue > 0;
    const status = inProgress ? "in_progress" : isOverdue ? "overdue" : "due";
    const candidate = {
      id: `writing-review-candidate:${task.taskId}`,
      type: TASK_TYPE_WRITING_REVIEW,
      source: "writingReviewTask",
      title: `Writing ${task.reviewType} 复习`,
      subtitle: inProgress ? "继续进行中的写作复习" : isOverdue ? `已逾期 ${overdue} 天` : "今日到期",
      dueDate: task.scheduledDate,
      overdueDays: overdue,
      mandatory: true,
      blocked: false,
      reasonCodes: [inProgress ? "writing-review.in-progress" : isOverdue ? "writing-review.overdue" : "writing-review.due-today"],
      reasonText: inProgress ? "进行中的写作复习，先继续完成" : isOverdue ? `已逾期 ${overdue} 天，应优先完成` : "今天到期的写作复习",
      statusLabel: inProgress ? "进行中" : isOverdue ? `逾期 ${overdue} 天` : "今日到期",
      action: { type: "writing-review", taskId: task.taskId, sessionId: task.sourceSessionId },
      metadata: {
        taskId: task.taskId,
        sessionId: task.sourceSessionId,
        reviewType: task.reviewType,
        status,
        createdAt: 0,
      },
      priorityTier: isOverdue ? TIER_OVERDUE_REVIEW : TIER_DUE_REVIEW,
    };
    candidate.estimatedMinutes = estimateTaskDuration(candidate);
    if (!seen.has(candidate.id)) {
      seen.add(candidate.id);
      candidates.push(candidate);
    }
  }
  return candidates;
}

function buildLearningReviewCandidate({ records, now, today }) {
  const recent = filterRecordsByRange(records, "7d", now);
  const unresolvedReliable = recent.filter((record) => (
    record.resolved !== true
    && Array.isArray(record.tags)
    && record.tags.some((tag) => isReliableTag(tag, record))
  ));
  if (!unresolvedReliable.length) return null;

  const counts = new Map();
  for (const record of unresolvedReliable) {
    const seen = new Set();
    for (const tag of record.tags || []) {
      if (isReliableTag(tag, record) && !seen.has(tag.name)) {
        seen.add(tag.name);
        counts.set(tag.name, (counts.get(tag.name) || 0) + 1);
      }
    }
  }
  const topTags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));
  const topText = topTags.length
    ? `，其中：${topTags.map((item) => `${item.name} ${item.count} 次`).join("、")}`
    : "";
  const candidate = {
    id: "learning-review:7d",
    type: TASK_TYPE_LEARNING_REVIEW,
    source: "aiLearningRecords",
    title: "复盘近期阅读 / 翻译问题",
    subtitle: `${unresolvedReliable.length} 条待复盘记录`,
    mandatory: false,
    blocked: false,
    reasonCodes: ["learning.pending-recent"],
    reasonText: `最近 7 天有 ${unresolvedReliable.length} 条待复盘记录${topText}`,
    action: { type: "learning-review" },
    metadata: {
      recordCount: unresolvedReliable.length,
      topTags,
      today,
    },
  };
  candidate.priorityTier = TIER_LEARNING_REVIEW;
  candidate.estimatedMinutes = estimateTaskDuration(candidate);
  return candidate;
}

function buildVocabularyCandidate(vocabState, today) {
  if (!vocabState?.available || vocabState.completed || !(vocabState.dueCount > 0)) return null;
  const candidate = {
    id: `vocabulary-review:${today}`,
    type: TASK_TYPE_VOCABULARY_REVIEW,
    source: "vocabulary",
    title: "今日词汇复习",
    subtitle: `${vocabState.dueCount} 词`,
    mandatory: false,
    blocked: false,
    reasonCodes: ["vocabulary.due-today"],
    reasonText: `今日词汇复习尚未完成（${vocabState.dueCount} 词）`,
    action: { type: "vocabulary-review", date: today },
    metadata: {
      dueCount: vocabState.dueCount,
      date: today,
    },
  };
  candidate.priorityTier = TIER_VOCABULARY_REVIEW;
  candidate.estimatedMinutes = estimateTaskDuration(candidate);
  return candidate;
}

function buildNewReadingCandidate() {
  const candidate = {
    id: "new-reading",
    type: TASK_TYPE_NEW_READING,
    source: "readingFlow",
    title: "开始一篇新的精读",
    subtitle: "进入资料库选文",
    mandatory: false,
    blocked: false,
    reasonCodes: ["reading.new"],
    reasonText: "没有更高优先级任务时，可开始一篇新的精读",
    action: { type: "new-reading" },
    metadata: {},
  };
  candidate.priorityTier = TIER_NEW_READING;
  candidate.estimatedMinutes = estimateTaskDuration(candidate);
  return candidate;
}

/**
 * 词汇只读适配器：按 review.js 相同语义读取「今日待复习」真实状态。
 * 不复制词汇复习算法——maskedDates 由词汇应用维护，这里只做等义读取。
 */
function recordDates(record) {
  if (Array.isArray(record.maskedDates) && record.maskedDates.length) {
    return [...new Set(record.maskedDates.filter(Boolean))];
  }
  const timestamp = record.maskedAt || (record.clickCount >= 3 ? record.updatedAt : 0);
  return timestamp ? [localDateKey(timestamp)] : [];
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("read-failed"));
  });
}

function defaultOpenVocabularyDb() {
  return new Promise((resolve, reject) => {
    const source = globalThis.indexedDB;
    if (!source || typeof source.open !== "function") {
      reject(new Error("no-indexeddb"));
      return;
    }
    const request = source.open(VOCABULARY_MEMORY_DB_NAME);
    request.onupgradeneeded = () => {
      // 只读适配：绝不创建或迁移 store。库不存在时该事件也会触发，
      // 交给 onsuccess 的 store 检查统一降级。
    };
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(VOCABULARY_MEMORY_RECORD_STORE)) {
        database.close();
        reject(new Error("missing-store"));
        return;
      }
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error("open-failed"));
  });
}

async function readVocabularyRecords(database, username) {
  const transaction = database.transaction(VOCABULARY_MEMORY_RECORD_STORE, "readonly");
  const records = await requestResult(
    transaction.objectStore(VOCABULARY_MEMORY_RECORD_STORE).getAll(),
  );
  return (Array.isArray(records) ? records : []).filter(
    (record) => record && String(record.username || "") === String(username || ""),
  );
}

function defaultReadStorage(key) {
  try {
    return globalThis.localStorage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

export async function readVocabularyTodayState({
  username = getCurrentUsername(),
  date = localDateKey(),
  openDb = defaultOpenVocabularyDb,
  readStorage = defaultReadStorage,
} = {}) {
  if (!username) return { available: false, reason: "no-account" };
  let database = null;
  try {
    database = await openDb();
    const records = await readVocabularyRecords(database, username);
    const todayWordIds = new Set();
    for (const record of records) {
      if (recordDates(record).includes(String(date))) {
        todayWordIds.add(String(record.wordId || ""));
      }
    }
    todayWordIds.delete("");
    const dueCount = todayWordIds.size;
    const rawSession = readStorage(`${VOCABULARY_SESSION_KEY_PREFIX}${username}:${date}`);
    let session = null;
    try {
      const parsed = JSON.parse(String(rawSession || ""));
      if (parsed && typeof parsed === "object") session = parsed;
    } catch {
      session = null;
    }
    const completed = Boolean(
      dueCount > 0
      && session
      && Number(session.total) === dueCount
      && Number(session.currentIndex) >= dueCount,
    );
    return {
      available: true,
      dueCount,
      completed,
      session,
      completedAt: completed ? Number(session.updatedAt) || 0 : 0,
    };
  } catch (error) {
    return {
      available: false,
      reason: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (database && typeof database.close === "function") {
      try {
        database.close();
      } catch {
        // 关闭失败不影响降级结果
      }
    }
  }
}

export async function collectStudyCandidates({
  today = localDateKey(),
  resources = [],
  customPdfs = [],
  username = getCurrentUsername(),
  now = Date.now(),
  forceScan = false,
  scan = null,
} = {}) {
  const resolvedScan = scan || scanLearningState({ today, force: forceScan });
  const vocabState = await readVocabularyTodayState({ username, date: today });
  const candidates = [];
  candidates.push(...buildReviewCandidates({ scan: resolvedScan, resources, customPdfs, today }));
  candidates.push(...buildClozeReviewCandidates({ scan: resolvedScan, resources, customPdfs, today }));
  candidates.push(...buildWritingPlannerCandidates({ scan: resolvedScan, today }));
  candidates.push(...buildContinueReadingCandidates({ scan: resolvedScan, resources, customPdfs }));
  const learning = buildLearningReviewCandidate({
    records: listLearningRecords(),
    now,
    today,
  });
  if (learning) candidates.push(learning);
  const vocabulary = buildVocabularyCandidate(vocabState, today);
  if (vocabulary) candidates.push(vocabulary);
  candidates.push(...buildExamFollowupCandidates());
  candidates.push(buildNewReadingCandidate());
  return { candidates, vocabState, scan: resolvedScan };
}

export function collectCompletedToday({
  scan,
  tasks,
  vocabState,
  resources,
  customPdfs,
  today = localDateKey(),
}) {
  const completed = [];
  for (const task of tasks || []) {
    if (task?.completedAt && localDateKey(task.completedAt) === today) {
      completed.push({
        id: `completed-review:${task.taskKey}`,
        type: TASK_TYPE_REVIEW,
        title: resourceTitle(resources, customPdfs, task.resourceId) || "自定义资料",
        subtitle: task.type === TASK_TYPE_SENTENCE_RECHECK ? "困难句复查" : "次日复读",
        completedAt: task.completedAt,
      });
    }
  }
  for (const task of scan.clozeReviewTasks || []) {
    if (task?.completedAt && localDateKey(task.completedAt) === today) {
      completed.push({
        id: `completed-cloze-review:${task.taskKey}`,
        type: TASK_TYPE_CLOZE_REVIEW,
        title: resourceTitle(resources, customPdfs, task.resourceId) || "自定义完形资料",
        subtitle: task.type === TASK_TYPE_D7 ? "完形 D+7 确认" : "完形 D+1 复习",
        completedAt: task.completedAt,
      });
    }
  }
  const valid = validResourceIds(resources, customPdfs);
  for (const [key, flow] of scan.flows.entries()) {
    if (!isWorkflowCompleted(flow)) continue;
    const [resourceId, passageId] = String(key).split("\u0000");
    if (!valid.has(String(resourceId))) continue;
    const completedAt = flow.stages?.["deep-review"]?.completedAt;
    if (completedAt && localDateKey(completedAt) === today) {
      completed.push({
        id: `completed-reading:${resourceId}:${passageId}`,
        type: TASK_TYPE_CONTINUE_READING,
        title: resourceTitle(resources, customPdfs, resourceId) || "未命名资料",
        subtitle: "整篇精读完成",
        completedAt,
      });
    }
  }
  if (vocabState?.available && vocabState.completed) {
    completed.push({
      id: `completed-vocabulary-review:${today}`,
      type: TASK_TYPE_VOCABULARY_REVIEW,
      title: "今日词汇复习",
      subtitle: "已完成",
      completedAt: vocabState.completedAt || 0,
    });
  }
  return completed.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0) || String(a.id).localeCompare(String(b.id)));
}

export function collectBlockedCandidates({ scan, resources, customPdfs }) {
  const valid = validResourceIds(resources, customPdfs);
  const blocked = [];
  for (const [key, flow] of scan.flows.entries()) {
    if (isWorkflowCompleted(flow)) continue;
    const [resourceId, passageId] = String(key).split("\u0000");
    if (!valid.has(String(resourceId))) continue;
    const currentStage = flow.currentStage || "deep-cover";
    const currentIndex = Math.max(0, STAGE_IDS.indexOf(currentStage));
    const nextStage = STAGE_IDS.slice(currentIndex + 1).find(
      (stageId) => flow.stages?.[stageId]?.status !== "completed",
    );
    if (!nextStage) continue;
    const reason = `完成「${STAGE_LABELS[currentStage] || currentStage}」后才能进行「${STAGE_LABELS[nextStage]}」`;
    blocked.push({
      id: `blocked:${resourceId}:${passageId}:${nextStage}`,
      type: TASK_TYPE_BLOCKED_READING,
      source: "readingFlow",
      title: `${resourceTitle(resources, customPdfs, resourceId) || "未命名资料"} · ${STAGE_LABELS[nextStage]}`,
      subtitle: "前置阶段未完成",
      estimatedMinutes: 0,
      priorityTier: 99,
      mandatory: false,
      blocked: true,
      blockedReason: reason,
      reasonCodes: ["blocked.next-stage"],
      reasonText: reason,
      action: { type: "continue-reading", resourceId, passageId },
      metadata: {
        resourceId,
        passageId,
        currentStage,
        nextStage,
      },
    });
  }
  return blocked.sort((a, b) => String(a.id).localeCompare(String(b.id), "zh"));
}

export async function buildPlanState({
  today = localDateKey(),
  resources = [],
  customPdfs,
  username = getCurrentUsername(),
  now = Date.now(),
  forceScan = true,
  scan = null,
} = {}) {
  const resolvedCustom = customPdfs ?? (await listCustomPdfs());
  const { candidates, vocabState, scan: resolvedScan } = await collectStudyCandidates({
    today,
    resources,
    customPdfs: resolvedCustom,
    username,
    now,
    forceScan,
    scan,
  });
  const tasks = resolvedScan.tasks || listReviewTasks();
  const completed = collectCompletedToday({
    scan: resolvedScan,
    tasks,
    vocabState,
    resources,
    customPdfs: resolvedCustom,
    today,
  });
  const blocked = collectBlockedCandidates({ scan: resolvedScan, resources, customPdfs: resolvedCustom });
  const state = loadPlanState(today);
  const plan = planStudyDay(candidates, {
    date: today,
    budgetMinutes: state.budgetMinutes,
    budgetConfirmed: state.budgetConfirmed,
    deferredTaskIds: state.deferredTaskIds,
    completed,
    blocked,
    generatedAt: now,
  });
  return { plan, state };
}

export { listReviewTasks };
