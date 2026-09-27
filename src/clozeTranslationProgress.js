import { getUserItem, setUserItem } from "./userData";
import { translationTextFingerprint } from "./translationProgress";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";

export const CLOZE_TRANSLATION_SCHEMA_VERSION = 1;
const TRANSLATION_STATUSES = ["pending", "translated", "corrected"];

export function clozeTranslationStorageKey(resourceId, clozeId) {
  return `wuliao:cloze-translation:${resourceId}:${clozeId}`;
}

function normalizeTime(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function pendingEntry() {
  return {
    text: "",
    status: "pending",
    translatedAt: null,
    correctedAt: null,
    correctedFingerprint: null,
    updatedAt: null,
  };
}

export function emptyClozeTranslationProgress(resourceId, clozeId, now = Date.now()) {
  return {
    schemaVersion: CLOZE_TRANSLATION_SCHEMA_VERSION,
    resourceId: String(resourceId || ""),
    clozeId: String(clozeId || ""),
    sentences: {},
    targetOverrides: {},
    updatedAt: now,
  };
}

export function normalizeClozeTranslationProgress(raw, resourceId, clozeId) {
  const fallback = emptyClozeTranslationProgress(resourceId, clozeId);
  if (!raw || typeof raw !== "object") return fallback;
  const sentences = {};
  for (const [key, value] of Object.entries(raw.sentences || {})) {
    if (!key || !value || typeof value !== "object") continue;
    const status = TRANSLATION_STATUSES.includes(value.status) ? value.status : "pending";
    const text = String(value.text || "");
    sentences[key] = {
      text,
      status,
      translatedAt: normalizeTime(value.translatedAt),
      correctedAt: status === "corrected" ? normalizeTime(value.correctedAt) : null,
      correctedFingerprint: status === "corrected" && typeof value.correctedFingerprint === "string"
        ? value.correctedFingerprint
        : null,
      updatedAt: normalizeTime(value.updatedAt),
    };
  }
  const targetOverrides = {};
  for (const [key, value] of Object.entries(raw.targetOverrides || {})) {
    if (value === "include" || value === "exclude") targetOverrides[key] = value;
  }
  return {
    ...fallback,
    sentences,
    targetOverrides,
    updatedAt: Number(raw.updatedAt) || fallback.updatedAt,
  };
}

export function loadClozeTranslationProgress(resourceId, clozeId) {
  try {
    const raw = JSON.parse(getUserItem(clozeTranslationStorageKey(resourceId, clozeId)) || "");
    return normalizeClozeTranslationProgress(raw, resourceId, clozeId);
  } catch {
    return emptyClozeTranslationProgress(resourceId, clozeId);
  }
}

export function saveClozeTranslationProgress(progress, username) {
  if (!progress?.resourceId || !progress?.clozeId) return false;
  try {
    setUserItem(
      clozeTranslationStorageKey(progress.resourceId, progress.clozeId),
      JSON.stringify(progress),
      username,
    );
    emitAppEvent(AppEvent.LEARNING_STATE_INVALIDATED);
    return true;
  } catch {
    return false;
  }
}

function withSentence(progress, sentenceKey, mutator, now = Date.now()) {
  if (!progress || !sentenceKey) return progress;
  const current = progress.sentences?.[sentenceKey] || pendingEntry();
  return {
    ...progress,
    sentences: {
      ...(progress.sentences || {}),
      [sentenceKey]: { ...mutator(current), updatedAt: now },
    },
    updatedAt: now,
  };
}

export function translationEntryFor(progress, sentenceKey) {
  return progress?.sentences?.[sentenceKey] || pendingEntry();
}

export function setClozeTranslationText(progress, sentenceKey, text, now = Date.now()) {
  if (typeof text !== "string") return progress;
  return withSentence(progress, sentenceKey, (current) => {
    const changedAfterCorrection = current.status === "corrected"
      && translationTextFingerprint(text) !== current.correctedFingerprint;
    return {
      ...current,
      text,
      status: changedAfterCorrection ? "translated" : current.status,
      correctedAt: changedAfterCorrection ? null : current.correctedAt,
      correctedFingerprint: changedAfterCorrection ? null : current.correctedFingerprint,
    };
  }, now);
}

export function markClozeTranslationTranslated(progress, sentenceKey, now = Date.now()) {
  const current = translationEntryFor(progress, sentenceKey);
  if (!String(current.text || "").trim()) return progress;
  return withSentence(progress, sentenceKey, (entry) => ({
    ...entry,
    status: "translated",
    translatedAt: entry.translatedAt || now,
    correctedAt: null,
    correctedFingerprint: null,
  }), now);
}

export function markClozeTranslationCorrected(progress, sentenceKey, now = Date.now()) {
  const current = translationEntryFor(progress, sentenceKey);
  if (current.status !== "translated") return progress;
  return withSentence(progress, sentenceKey, (entry) => ({
    ...entry,
    status: "corrected",
    correctedAt: now,
    correctedFingerprint: translationTextFingerprint(entry.text),
  }), now);
}

export function setTranslationTargetOverride(progress, sentenceKey, override, now = Date.now()) {
  if (!progress || !sentenceKey) return progress;
  if (override !== "include" && override !== "exclude" && override !== null) return progress;
  const targetOverrides = { ...(progress.targetOverrides || {}) };
  if (override === null) delete targetOverrides[sentenceKey];
  else targetOverrides[sentenceKey] = override;
  return { ...progress, targetOverrides, updatedAt: now };
}

export function areClozeTranslationTargetsCorrected(progress, targets) {
  return (targets || []).every((sentence) => (
    translationEntryFor(progress, sentence.sentenceKey).status === "corrected"
  ));
}
