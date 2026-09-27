import { getUserItem, setUserItem } from "./userData";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";

export const TRANSLATION_PROGRESS_SCHEMA_VERSION = 1;

const TRANSLATION_STATUSES = ["pending", "translated", "corrected"];
const REVIEW_STATUSES = ["mastered", "needs_review"];

export function translationProgressKey(resourceId, passageId) {
  return `wuliao:translation-progress:${resourceId}:${passageId}`;
}

function hashString(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return `x${(hash >>> 0).toString(36)}`;
}

export function normalizeSentenceText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function sentenceKeyFor({ paragraphNumber, sentenceIndex, sentenceText }) {
  const number = Number(paragraphNumber) || 0;
  const index = Math.max(0, Number(sentenceIndex) || 0);
  const fingerprint = hashString(normalizeSentenceText(sentenceText));
  return `p${number}s${index + 1}:${fingerprint}`;
}

export function sentenceTextFingerprint(value) {
  return hashString(normalizeSentenceText(value));
}

export function translationTextFingerprint(value) {
  return hashString(String(value || "").replace(/\s+/g, " ").trim());
}

function normalizeTime(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

export function emptyProgress(resourceId, passageId) {
  return {
    schemaVersion: TRANSLATION_PROGRESS_SCHEMA_VERSION,
    resourceId: String(resourceId || ""),
    passageId: String(passageId || ""),
    updatedAt: Date.now(),
    sentences: {},
    paragraphs: {},
  };
}

export function resetPassageProgress(progress) {
  return {
    ...emptyProgress(progress?.resourceId || "", progress?.passageId || ""),
    updatedAt: Date.now(),
  };
}

export function normalizeProgress(raw, resourceId, passageId) {
  const progress = emptyProgress(resourceId, passageId);
  if (!raw || typeof raw !== "object") return progress;
  const sentences = {};
  for (const [key, value] of Object.entries(raw.sentences || {})) {
    if (!key || !value || typeof value !== "object") continue;
    const status = TRANSLATION_STATUSES.includes(value.translationStatus)
      ? value.translationStatus
      : "pending";
    const review = REVIEW_STATUSES.includes(value.reviewStatus) ? value.reviewStatus : null;
    if (status !== "corrected") {
      sentences[key] = {
        translationStatus: status,
        reviewStatus: null,
        translatedAt: normalizeTime(value.translatedAt),
        correctedAt: null,
        reviewedAt: null,
        translationFingerprint: null,
      };
      continue;
    }
    sentences[key] = {
      translationStatus: "corrected",
      reviewStatus: review,
      translatedAt: normalizeTime(value.translatedAt),
      correctedAt: normalizeTime(value.correctedAt),
      reviewedAt: normalizeTime(value.reviewedAt),
      translationFingerprint: typeof value.translationFingerprint === "string"
        ? value.translationFingerprint
        : null,
    };
  }
  const paragraphs = {};
  for (const [number, value] of Object.entries(raw.paragraphs || {})) {
    if (value && value.completed === true) {
      paragraphs[String(number)] = {
        completed: true,
        completedAt: normalizeTime(value.completedAt),
      };
    }
  }
  return {
    ...progress,
    sentences,
    paragraphs,
    updatedAt: Number(raw.updatedAt) || progress.updatedAt,
  };
}

export function loadTranslationProgress(resourceId, passageId) {
  try {
    const raw = JSON.parse(getUserItem(translationProgressKey(resourceId, passageId)) || "");
    return normalizeProgress(raw, resourceId, passageId);
  } catch {
    return emptyProgress(resourceId, passageId);
  }
}

export function saveTranslationProgress(progress) {
  if (!progress?.resourceId || !progress?.passageId) return false;
  try {
    setUserItem(translationProgressKey(progress.resourceId, progress.passageId), JSON.stringify(progress));
    emitAppEvent(AppEvent.LEARNING_STATE_INVALIDATED);
    return true;
  } catch {
    return false;
  }
}

function cloneProgress(progress) {
  return {
    ...(progress || emptyProgress("", "")),
    sentences: { ...(progress?.sentences || {}) },
    paragraphs: { ...(progress?.paragraphs || {}) },
  };
}

function pendingEntry() {
  return {
    translationStatus: "pending",
    reviewStatus: null,
    translatedAt: null,
    correctedAt: null,
    reviewedAt: null,
    translationFingerprint: null,
  };
}

export function sentenceEntryFor(progress, { paragraphNumber, sentenceIndex, sentenceText, translationText = "" }) {
  const key = sentenceKeyFor({ paragraphNumber, sentenceIndex, sentenceText });
  const stored = progress?.sentences?.[key];
  if (stored) return { key, entry: { ...stored }, stored: true };
  if (String(translationText || "").trim()) {
    return {
      key,
      entry: { ...pendingEntry(), translationStatus: "translated" },
      stored: false,
    };
  }
  return { key, entry: pendingEntry(), stored: false };
}

export function markTranslated(progress, key, now = Date.now()) {
  if (!progress || !key) return progress;
  const current = progress.sentences?.[key];
  const next = cloneProgress(progress);
  next.sentences[key] = {
    translationStatus: "translated",
    reviewStatus: null,
    translatedAt: current?.translatedAt || now,
    correctedAt: null,
    reviewedAt: null,
    translationFingerprint: null,
  };
  next.updatedAt = now;
  return next;
}

export function markCorrected(progress, key, { translationText = "", now = Date.now() } = {}) {
  const current = progress?.sentences?.[key];
  if (!current || current.translationStatus !== "translated") return progress;
  const next = cloneProgress(progress);
  next.sentences[key] = {
    ...current,
    translationStatus: "corrected",
    correctedAt: now,
    reviewStatus: null,
    reviewedAt: null,
    translationFingerprint: translationTextFingerprint(translationText),
  };
  next.updatedAt = now;
  return next;
}

export function setReviewStatus(progress, key, reviewStatus, now = Date.now()) {
  const current = progress?.sentences?.[key];
  if (!current || current.translationStatus !== "corrected") return progress;
  const normalized = REVIEW_STATUSES.includes(reviewStatus) ? reviewStatus : null;
  if (current.reviewStatus === normalized) return progress;
  const next = cloneProgress(progress);
  next.sentences[key] = {
    ...current,
    reviewStatus: normalized,
    reviewedAt: normalized ? now : null,
  };
  next.updatedAt = now;
  return next;
}

export function handleTranslationEdited(progress, key, translationText) {
  const current = progress?.sentences?.[key];
  if (!current || current.translationStatus !== "corrected") return null;
  const fingerprint = translationTextFingerprint(translationText);
  if (fingerprint === current.translationFingerprint) return null;
  const next = cloneProgress(progress);
  next.sentences[key] = {
    ...current,
    translationStatus: "translated",
    reviewStatus: null,
    correctedAt: null,
    reviewedAt: null,
    translationFingerprint: null,
  };
  next.updatedAt = Date.now();
  return next;
}

export function markParagraphCompleted(progress, paragraphNumber, now = Date.now()) {
  if (!progress) return progress;
  const next = cloneProgress(progress);
  next.paragraphs[String(paragraphNumber)] = { completed: true, completedAt: now };
  next.updatedAt = now;
  return next;
}

export function paragraphState(progress, paragraph) {
  const sentences = Array.isArray(paragraph?.sentences) ? paragraph.sentences : [];
  const total = sentences.length;
  let correctedCount = 0;
  for (let sentenceIndex = 0; sentenceIndex < total; sentenceIndex += 1) {
    const key = sentenceKeyFor({
      paragraphNumber: paragraph.number,
      sentenceIndex,
      sentenceText: sentences[sentenceIndex],
    });
    if (progress?.sentences?.[key]?.translationStatus === "corrected") correctedCount += 1;
  }
  const allCorrected = total === 0 || correctedCount === total;
  const storedCompleted = progress?.paragraphs?.[String(paragraph.number)]?.completed === true;
  return {
    total,
    correctedCount,
    allCorrected,
    storedCompleted,
    completed: allCorrected && (storedCompleted || total === 0),
  };
}

export function countsForPassage(progress, passage) {
  const paragraphs = Array.isArray(passage?.paragraphs) ? passage.paragraphs : [];
  let total = 0;
  let translatedCount = 0;
  let correctedCount = 0;
  let masteredCount = 0;
  let needsReviewCount = 0;
  let completedParagraphCount = 0;
  for (const paragraph of paragraphs) {
    const state = paragraphState(progress, paragraph);
    total += state.total;
    correctedCount += state.correctedCount;
    if (state.completed) completedParagraphCount += 1;
    for (let sentenceIndex = 0; sentenceIndex < state.total; sentenceIndex += 1) {
      const key = sentenceKeyFor({
        paragraphNumber: paragraph.number,
        sentenceIndex,
        sentenceText: paragraph.sentences[sentenceIndex],
      });
      const entry = progress?.sentences?.[key];
      if (entry?.translationStatus === "translated") translatedCount += 1;
      if (entry?.reviewStatus === "mastered") masteredCount += 1;
      if (entry?.reviewStatus === "needs_review") needsReviewCount += 1;
    }
  }
  return {
    total,
    translatedCount,
    correctedCount,
    pendingCount: Math.max(0, total - translatedCount - correctedCount),
    masteredCount,
    needsReviewCount,
    completedParagraphCount,
    paragraphTotal: paragraphs.length,
  };
}

export function canCompleteTranslationWorkbook(progress, passage) {
  const paragraphs = Array.isArray(passage?.paragraphs) ? passage.paragraphs : [];
  if (!paragraphs.length) return true;
  return paragraphs.every((paragraph) => paragraphState(progress, paragraph).completed);
}

function implicitSentenceStatus(progress, key, translationTexts) {
  const entry = progress?.sentences?.[key];
  if (entry) return entry.translationStatus;
  return String(translationTexts?.[key] || "").trim() ? "translated" : "pending";
}

export function nextTranslationTodo(progress, passage, translationTexts = {}) {
  const paragraphs = Array.isArray(passage?.paragraphs) ? passage.paragraphs : [];
  for (const paragraph of paragraphs) {
    for (let sentenceIndex = 0; sentenceIndex < paragraph.sentences.length; sentenceIndex += 1) {
      const key = sentenceKeyFor({
        paragraphNumber: paragraph.number,
        sentenceIndex,
        sentenceText: paragraph.sentences[sentenceIndex],
      });
      if (implicitSentenceStatus(progress, key, translationTexts) === "pending") {
        return { type: "sentence", key, paragraphNumber: paragraph.number, sentenceIndex };
      }
    }
  }
  for (const paragraph of paragraphs) {
    for (let sentenceIndex = 0; sentenceIndex < paragraph.sentences.length; sentenceIndex += 1) {
      const key = sentenceKeyFor({
        paragraphNumber: paragraph.number,
        sentenceIndex,
        sentenceText: paragraph.sentences[sentenceIndex],
      });
      if (implicitSentenceStatus(progress, key, translationTexts) === "translated") {
        return { type: "sentence", key, paragraphNumber: paragraph.number, sentenceIndex };
      }
    }
  }
  for (const paragraph of paragraphs) {
    if (!paragraphState(progress, paragraph).completed) {
      return {
        type: "paragraph",
        key: `p${paragraph.number}`,
        paragraphNumber: paragraph.number,
        sentenceIndex: 0,
      };
    }
  }
  return null;
}

export function listNeedsReviewSentenceKeys(progress) {
  return Object.entries(progress?.sentences || {})
    .filter(([, entry]) => entry.reviewStatus === "needs_review")
    .map(([key]) => key);
}

export function shouldEnforceTranslationGating(flow) {
  return false;
}
