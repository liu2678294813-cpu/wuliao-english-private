import { getUserItem, setUserItem } from "./userData";
import { TASK_QUESTION_DIAGNOSIS, TASK_TRANSLATION_REVIEW } from "./aiTasks";
import { emitAppEvent } from "./events/appEvents";

const RECORDS_KEY = "wuliao:ai:learning-records";
const SCHEMA_VERSION = 1;
const MAX_TAGS = 20;
const MAX_SNIPPET = 160;

const TAG_SOURCES = ["ai-direct", "ai-inferred", "user-confirmed"];
const TAG_CONFIDENCES = ["low", "medium", "high"];
const TAG_STATUSES = ["active", "confirmed", "dismissed"];

function notify(eventName) {
  emitAppEvent(eventName);
}

function normalizeTag(tag) {
  if (!tag || typeof tag !== "object") return null;
  const name = String(tag.name || "").trim();
  if (!name) return null;
  const now = Date.now();
  return {
    name,
    source: TAG_SOURCES.includes(tag.source) ? tag.source : "ai-inferred",
    confidence: TAG_CONFIDENCES.includes(tag.confidence) ? tag.confidence : "low",
    status: TAG_STATUSES.includes(tag.status) ? tag.status : "active",
    firstSeenAt: Number(tag.firstSeenAt) || now,
    lastSeenAt: Number(tag.lastSeenAt) || now,
  };
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const now = Date.now();
  const taskType = record.taskType === TASK_QUESTION_DIAGNOSIS
    ? TASK_QUESTION_DIAGNOSIS
    : TASK_TRANSLATION_REVIEW;
  const identityKey = String(record.identityKey || record.key || "");
  const tags = Array.isArray(record.tags)
    ? record.tags.map(normalizeTag).filter(Boolean)
    : [];
  const normalized = {
    schemaVersion: Number(record.schemaVersion) || SCHEMA_VERSION,
    id: String(record.id || `lr-${now}-${Math.random().toString(36).slice(2, 8)}`),
    identityKey,
    key: String(record.key || record.identityKey || ""),
    taskType,
    resourceId: String(record.resourceId || ""),
    chapter: String(record.chapter || ""),
    itemId: String(record.itemId || ""),
    sentenceId: record.sentenceId == null ? null : String(record.sentenceId),
    questionId: record.questionId == null ? null : String(record.questionId),
    questionNumber: record.questionNumber == null ? null : String(record.questionNumber),
    createdAt: Number(record.createdAt) || now,
    updatedAt: Number(record.updatedAt) || now,
    reviewCount: Math.max(1, Number(record.reviewCount) || 1),
    resolved: record.resolved === true,
    summary: record.summary && typeof record.summary === "object" && !Array.isArray(record.summary)
      ? { ...record.summary }
      : {},
    tags,
    optionTrapTypes: Array.isArray(record.optionTrapTypes)
      ? record.optionTrapTypes.map(String).filter(Boolean).slice(0, MAX_TAGS)
      : [],
    errorTags: Array.isArray(record.errorTags)
      ? record.errorTags.map(String).filter(Boolean).slice(0, MAX_TAGS)
      : [],
    metadata: record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? { ...record.metadata }
      : {},
    historyId: record.historyId ? String(record.historyId) : "",
  };

  // 兼容 A 阶段旧记录：把 errorTags 推导成结构化 tags。
  if (!normalized.tags.length && normalized.errorTags.length) {
    normalized.tags = normalized.errorTags.map((name) => ({
      name,
      source: "ai-direct",
      confidence: "high",
      status: "active",
      firstSeenAt: normalized.createdAt,
      lastSeenAt: normalized.updatedAt,
    }));
  }
  if (!normalized.sentenceId && taskType === TASK_TRANSLATION_REVIEW) {
    normalized.sentenceId = normalized.itemId || "";
  }
  if (!normalized.questionId && taskType === TASK_QUESTION_DIAGNOSIS) {
    normalized.questionId = normalized.itemId || "";
  }
  normalized.errorTags = normalized.tags
    .filter((tag) => tag.status !== "dismissed")
    .map((tag) => tag.name);
  return normalized;
}

function readRecords() {
  try {
    const parsed = JSON.parse(getUserItem(RECORDS_KEY) || "");
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeRecord).filter(Boolean);
    }
  } catch {
    // 旧数据损坏时视为空档案，不阻塞主流程
  }
  return [];
}

function writeRecords(records) {
  try {
    setUserItem(RECORDS_KEY, JSON.stringify(records));
    notify("wuliao:learning-records-updated");
    return { ok: true };
  } catch {
    notify("wuliao:learning-records-save-failed");
    return { ok: false };
  }
}

export function buildLearningIdentityKey({ resourceId, chapter, taskType, itemId }) {
  return `${String(resourceId || "")}||${String(chapter || "")}||${String(taskType || "")}||${String(itemId || "")}`;
}

export function getLearningRecordByIdentity(identityKey) {
  if (!identityKey) return null;
  return readRecords().find((record) => record.identityKey === identityKey) || null;
}

function hasActiveErrors(tags) {
  return Array.isArray(tags) && tags.some((tag) => tag.status !== "dismissed");
}

function mergeTags(existingTags, newTags) {
  const byName = new Map((existingTags || []).map((tag) => [tag.name, tag]));
  const merged = [];
  const now = Date.now();
  for (const incoming of (newTags || []).slice(0, MAX_TAGS)) {
    if (!incoming || !incoming.name) continue;
    const previous = byName.get(incoming.name);
    const keepConfirmed = previous?.status === "confirmed" && previous.source === "user-confirmed";
    merged.push({
      name: incoming.name,
      source: keepConfirmed ? "user-confirmed" : incoming.source,
      confidence: incoming.confidence,
      status: keepConfirmed ? "confirmed" : "active",
      firstSeenAt: previous?.firstSeenAt || now,
      lastSeenAt: now,
    });
  }
  return merged;
}

function upsertLearningRecord({
  identityKey,
  taskType,
  resourceId,
  chapter,
  itemId,
  sentenceId = null,
  questionId = null,
  questionNumber = null,
  summary = {},
  tags = [],
  optionTrapTypes = [],
  historyId = "",
  metadata = {},
  backfill = false,
  savedAt = 0,
}) {
  const now = Date.now();
  const records = readRecords();
  const existingIndex = records.findIndex((record) => record.identityKey === identityKey);
  const existing = existingIndex >= 0 ? records[existingIndex] : null;
  const isBackfill = Boolean(backfill) && !existing;
  const nextTags = mergeTags(existing?.tags || [], tags);
  const nextMetadata = {
    ...(existing?.metadata || {}),
    ...metadata,
  };
  const previousNames = (existing?.tags || []).map((tag) => tag.name);
  const nextNames = nextTags.map((tag) => tag.name);
  if (previousNames.length && previousNames.join("|") !== nextNames.join("|")) {
    nextMetadata.previousTagNames = previousNames;
  }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    id: existing?.id || `lr-${now}-${Math.random().toString(36).slice(2, 8)}`,
    identityKey,
    key: identityKey,
    taskType,
    resourceId: String(resourceId || ""),
    chapter: String(chapter || ""),
    itemId: String(itemId || ""),
    sentenceId,
    questionId,
    questionNumber,
    createdAt: existing?.createdAt || (isBackfill && savedAt ? Number(savedAt) : now),
    updatedAt: isBackfill && savedAt ? Number(savedAt) : now,
    reviewCount: Math.max(1, (existing?.reviewCount || 0) + (isBackfill ? 0 : 1)),
    resolved: hasActiveErrors(nextTags) ? false : true,
    summary: { ...(existing?.summary || {}), ...summary },
    tags: nextTags,
    optionTrapTypes: [...new Set(optionTrapTypes)].slice(0, MAX_TAGS),
    errorTags: nextTags.filter((tag) => tag.status !== "dismissed").map((tag) => tag.name),
    metadata: nextMetadata,
    historyId: String(historyId || existing?.historyId || ""),
  };

  if (existingIndex >= 0) records[existingIndex] = record;
  else records.unshift(record);
  const result = writeRecords(records);
  return { ok: result.ok, record };
}

export function upsertTranslationReviewRecord({
  resourceId,
  chapter,
  sentenceId,
  itemId,
  itemLabel,
  inputMethod,
  errorTags,
  summaryLevel,
  sentenceSnippet,
  historyId,
  passageId,
  backfill = false,
  savedAt = 0,
}) {
  const normalizedItemId = String(sentenceId || itemId || "");
  const now = Date.now();
  const identityKey = buildLearningIdentityKey({
    resourceId,
    chapter,
    taskType: TASK_TRANSLATION_REVIEW,
    itemId: normalizedItemId,
  });
  const tags = (Array.isArray(errorTags) ? errorTags : [])
    .slice(0, MAX_TAGS)
    .map((name) => {
      const trimmed = String(name || "").trim();
      return trimmed
        ? {
            name: trimmed,
            source: "ai-direct",
            confidence: "high",
            status: "active",
            firstSeenAt: now,
            lastSeenAt: now,
          }
        : null;
    })
    .filter(Boolean);
  const derivedPassageId = String(passageId || (normalizedItemId.split("::")[1] || ""));
  return upsertLearningRecord({
    identityKey,
    taskType: TASK_TRANSLATION_REVIEW,
    resourceId,
    chapter,
    itemId: normalizedItemId,
    sentenceId: normalizedItemId,
    questionId: null,
    questionNumber: null,
    summary: {
      level: String(summaryLevel || ""),
      itemLabel: String(itemLabel || ""),
      inputMethod: inputMethod === "handwriting-transcribed" ? "handwriting-transcribed" : "typed",
    },
    tags,
    historyId,
    metadata: {
      passageId: derivedPassageId,
      sentenceSnippet: String(sentenceSnippet || "").slice(0, MAX_SNIPPET),
    },
    backfill,
    savedAt,
  });
}

export function upsertQuestionDiagnosisRecord({
  resourceId,
  chapter,
  questionId,
  questionNumber,
  passageId,
  questionType,
  diagnosisBasis,
  confidence,
  firstAnswer,
  redoAnswer,
  firstCorrect,
  redoCorrect,
  userErrorTags,
  optionTrapTypes,
  inferredCauseSummary,
  observedFacts,
  nextTimeRule,
  historyId,
  backfill = false,
  savedAt = 0,
}) {
  const normalizedQuestionId = String(questionId || "");
  const now = Date.now();
  const identityKey = buildLearningIdentityKey({
    resourceId,
    chapter,
    taskType: TASK_QUESTION_DIAGNOSIS,
    itemId: normalizedQuestionId,
  });
  const confidenceLevel = TAG_CONFIDENCES.includes(confidence) ? confidence : "low";
  const tags = (Array.isArray(userErrorTags) ? userErrorTags : [])
    .slice(0, MAX_TAGS)
    .map((name) => {
      const trimmed = String(name || "").trim();
      return trimmed
        ? {
            name: trimmed,
            source: "ai-inferred",
            confidence: confidenceLevel,
            status: "active",
            firstSeenAt: now,
            lastSeenAt: now,
          }
        : null;
    })
    .filter(Boolean);
  return upsertLearningRecord({
    identityKey,
    taskType: TASK_QUESTION_DIAGNOSIS,
    resourceId,
    chapter,
    itemId: normalizedQuestionId,
    sentenceId: null,
    questionId: normalizedQuestionId,
    questionNumber: questionNumber == null ? null : String(questionNumber),
    summary: {
      questionType: String(questionType || ""),
      diagnosisBasis: String(diagnosisBasis || ""),
      confidence: confidenceLevel,
      firstAnswer: String(firstAnswer || ""),
      redoAnswer: String(redoAnswer || ""),
      firstCorrect: firstCorrect === true,
      redoCorrect: redoCorrect === true,
      inferredCauseSummary: String(inferredCauseSummary || "").slice(0, 300),
      observedFacts: Array.isArray(observedFacts)
        ? observedFacts.slice(0, 8).map((item) => String(item || "").slice(0, 200)).filter(Boolean)
        : [],
      nextTimeRule: String(nextTimeRule || "").slice(0, 300),
    },
    tags,
    optionTrapTypes: Array.isArray(optionTrapTypes) ? optionTrapTypes : [],
    historyId,
    metadata: {
      passageId: String(passageId || ""),
    },
    backfill,
    savedAt,
  });
}

export function updateTagStatus(recordId, tagName, status) {
  if (!recordId || !tagName) return null;
  const records = readRecords();
  const index = records.findIndex((record) => record.id === recordId);
  if (index < 0) return null;
  const record = records[index];
  const tag = (record.tags || []).find((item) => item.name === tagName);
  if (!tag) return null;
  const nextStatus = status === "dismissed" ? "dismissed" : "confirmed";
  tag.status = nextStatus;
  if (nextStatus === "confirmed") tag.source = "user-confirmed";
  const tagHistory = { ...(record.metadata?.tagHistory || {}) };
  tagHistory[tagName] = {
    ...(tagHistory[tagName] || {}),
    lastStatus: nextStatus,
    lastSeenAt: Date.now(),
  };
  record.metadata = { ...(record.metadata || {}), tagHistory };
  record.updatedAt = Date.now();
  record.errorTags = (record.tags || [])
    .filter((item) => item.status !== "dismissed")
    .map((item) => item.name);
  const result = writeRecords(records);
  return result.ok ? record : null;
}

export function setLearningRecordResolved(recordId, resolved) {
  if (!recordId) return null;
  const records = readRecords();
  const index = records.findIndex((record) => record.id === recordId);
  if (index < 0) return null;
  records[index].resolved = resolved === true;
  records[index].updatedAt = Date.now();
  const result = writeRecords(records);
  return result.ok ? records[index] : null;
}

export function deleteLearningRecord(recordId) {
  if (!recordId) return false;
  const records = readRecords();
  const next = records.filter((record) => record.id !== recordId);
  if (next.length === records.length) return false;
  return writeRecords(next).ok;
}

export function clearLearningRecords() {
  return writeRecords([]).ok;
}

export function listLearningRecords() {
  return readRecords().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// A 阶段旧接口别名：仅翻译批改使用，保留以免外部调用失效。
export function upsertReviewRecord(payload) {
  return upsertTranslationReviewRecord(payload);
}
