import { TASK_QUESTION_DIAGNOSIS, TASK_TRANSLATION_REVIEW } from "./aiTasks";

const DAY_MS = 24 * 60 * 60 * 1000;

export function timeRangeStart(range, now = Date.now()) {
  if (range === "all") return 0;
  if (range === "7d") return now - 7 * DAY_MS;
  return now - 30 * DAY_MS;
}

export function recordInRange(record, range, now = Date.now()) {
  return (Number(record?.updatedAt) || 0) >= timeRangeStart(range, now);
}

export function isTranslationRecord(record) {
  return record?.taskType === TASK_TRANSLATION_REVIEW;
}

export function isDiagnosisRecord(record) {
  return record?.taskType === TASK_QUESTION_DIAGNOSIS;
}

export function isReliableTag(tag, record) {
  if (!tag || tag.status === "dismissed") return false;
  if (tag.source === "user-confirmed") return true;
  if (isTranslationRecord(record)) return tag.source === "ai-direct";
  return tag.confidence !== "low";
}

export function isPendingTag(tag, record) {
  return Boolean(
    record
    && isDiagnosisRecord(record)
    && tag
    && tag.status === "active"
    && tag.source === "ai-inferred"
    && tag.confidence === "low",
  );
}

export function recordHasPendingTags(record) {
  return Array.isArray(record?.tags) && record.tags.some((tag) => isPendingTag(tag, record));
}

export function filterRecordsByRange(records, range, now = Date.now()) {
  return (Array.isArray(records) ? records : []).filter((record) => recordInRange(record, range, now));
}

export function filterRecordsByType(records, type) {
  const source = Array.isArray(records) ? records : [];
  if (type === "translation") return source.filter(isTranslationRecord);
  if (type === "reading") return source.filter(isDiagnosisRecord);
  if (type === "review") return source.filter((record) => record.resolved !== true);
  if (type === "pending") return source.filter(recordHasPendingTags);
  return source;
}

export function getOverview(records, range, now = Date.now()) {
  const filtered = filterRecordsByRange(records, range, now);
  const translationRecords = filtered.filter(isTranslationRecord);
  const diagnosisRecords = filtered.filter(isDiagnosisRecord);
  return {
    totalRecords: filtered.length,
    translationReviews: translationRecords.length,
    translationWithProblems: translationRecords.filter((record) =>
      (record.tags || []).some((tag) => tag.status !== "dismissed"),
    ).length,
    diagnosisCount: diagnosisRecords.length,
    pendingCount: filtered.filter((record) => record.resolved !== true).length,
  };
}

export function getReliableTagCounts(records, range, now = Date.now()) {
  const filtered = filterRecordsByRange(records, range, now);
  const counts = {};
  let totalRecords = 0;
  for (const record of filtered) {
    const names = new Set(
      (record.tags || [])
        .filter((tag) => isReliableTag(tag, record))
        .map((tag) => tag.name),
    );
    if (names.size) totalRecords += 1;
    for (const name of names) counts[name] = (counts[name] || 0) + 1;
  }
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .map(([name, count]) => ({ name, count }));
  return { counts, sorted, totalRecords };
}

export function getPendingTagEntries(records, range, now = Date.now()) {
  const filtered = filterRecordsByRange(records, range, now);
  const entries = [];
  for (const record of filtered) {
    for (const tag of record.tags || []) {
      if (isPendingTag(tag, record)) entries.push({ record, tag });
    }
  }
  return entries;
}

export function getTrapCounts(records, range, now = Date.now()) {
  const filtered = filterRecordsByRange(records, range, now);
  const counts = {};
  for (const record of filtered) {
    for (const trap of record.optionTrapTypes || []) {
      counts[trap] = (counts[trap] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .map(([name, count]) => ({ name, count }));
}

export function getQuestionTypeCounts(records, range, now = Date.now()) {
  const filtered = filterRecordsByRange(records, range, now).filter(isDiagnosisRecord);
  const counts = {};
  for (const record of filtered) {
    const type = record.summary?.questionType;
    if (type) counts[type] = (counts[type] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .map(([name, count]) => ({ name, count }));
}

export function getRecent7Summary(records, now = Date.now()) {
  const recent = filterRecordsByRange(records, "7d", now);
  const reliableNames = new Set();
  for (const record of recent) {
    for (const tag of record.tags || []) {
      if (isReliableTag(tag, record)) reliableNames.add(tag.name);
    }
  }
  return {
    translationCount: recent.filter(isTranslationRecord).length,
    diagnosisCount: recent.filter(isDiagnosisRecord).length,
    addedReliableTagNames: reliableNames.size,
    pendingCount: recent.filter((record) => record.resolved !== true).length,
    top: getReliableTagCounts(records, "7d", now).sorted.slice(0, 3),
  };
}

export function getReviewSuggestions(records, now = Date.now()) {
  return getReliableTagCounts(records, "7d", now).sorted.slice(0, 3);
}
