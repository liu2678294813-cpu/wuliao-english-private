import { getUserItem, setUserItem } from "./userData";
import { hasAllQuestionsAnswered } from "./readingFlow";
import {
  normalizeSentenceText,
  sentenceKeyFor,
  sentenceTextFingerprint,
} from "./translationProgress";

export const QUESTION_EVIDENCE_SCHEMA_VERSION = 2;
export const MAX_SENTENCE_EVIDENCE = 3;
export const MAX_TEXT_EVIDENCE_RANGES = 3;

export const TEXT_TYPES = [
  { id: "direct", label: "直接定位" },
  { id: "inference", label: "推理依据" },
  { id: "wording", label: "措辞对应" },
  { id: "other", label: "其他原文依据" },
];

export const TEXT_TYPE_LABELS = Object.fromEntries(
  TEXT_TYPES.map((item) => [item.id, item.label]),
);

export const GLOBAL_TYPES = [
  { id: "main_idea", label: "全文主旨" },
  { id: "attitude", label: "作者态度" },
  { id: "structure", label: "篇章结构" },
  { id: "other", label: "其他整体判断" },
];

export const GLOBAL_TYPE_LABELS = Object.fromEntries(
  GLOBAL_TYPES.map((item) => [item.id, item.label]),
);

export function evidenceStorageKey(resourceId, passageId) {
  return `wuliao:question-evidence:${resourceId}:${passageId}`;
}

function hashString(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return `x${(hash >>> 0).toString(36)}`;
}

function questionStemFingerprint(stem) {
  return hashString(String(stem || "").replace(/\s+/g, " ").trim().toLowerCase());
}

function normalizeTime(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function cleanText(value, limit = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function exactText(value, limit) {
  const text = String(value || "").slice(0, limit);
  return text.trim() ? text : "";
}

export function questionKeyFor({
  resourceId,
  passageId,
  questionNumber,
  questionStem,
  questionIndex,
}) {
  const number = String(questionNumber ?? "").trim()
    || String(Math.max(1, (Number(questionIndex) || 0) + 1));
  return `${resourceId}::${passageId}::q${number}::${questionStemFingerprint(questionStem)}`;
}

export function emptyEvidenceStore(resourceId, passageId) {
  return {
    schemaVersion: QUESTION_EVIDENCE_SCHEMA_VERSION,
    resourceId: String(resourceId || ""),
    passageId: String(passageId || ""),
    updatedAt: Date.now(),
    questions: {},
  };
}

function normalizeLegacySentenceRef(item) {
  if (!item || typeof item !== "object") return null;
  const paragraphNumber = Number(item.paragraphNumber);
  const sentenceIndex = Number(item.sentenceIndex);
  if (!Number.isInteger(paragraphNumber) || paragraphNumber < 1) return null;
  if (!Number.isInteger(sentenceIndex) || sentenceIndex < 0) return null;
  return {
    paragraphNumber,
    sentenceIndex,
    sentenceKey: String(item.sentenceKey || ""),
    fingerprint: String(item.fingerprint || ""),
    excerpt: cleanText(item.excerpt, 72),
  };
}

function normalizeTextSegment(item) {
  if (!item || typeof item !== "object") return null;
  const paragraphNumber = Number(item.paragraphNumber);
  const sentenceIndex = Number(item.sentenceIndex);
  const startOffset = Number(item.startOffset);
  const endOffset = Number(item.endOffset);
  const selectedText = exactText(item.selectedText, 1000);
  if (!Number.isInteger(paragraphNumber) || paragraphNumber < 1) return null;
  if (!Number.isInteger(sentenceIndex) || sentenceIndex < 0) return null;
  if (!Number.isInteger(startOffset) || startOffset < 0) return null;
  if (!Number.isInteger(endOffset) || endOffset <= startOffset) return null;
  if (!selectedText) return null;
  if (endOffset - startOffset !== selectedText.length) return null;
  return {
    paragraphNumber,
    sentenceIndex,
    sentenceKey: String(item.sentenceKey || ""),
    fingerprint: String(item.fingerprint || ""),
    startOffset,
    endOffset,
    selectedText,
    beforeContext: String(item.beforeContext || "").slice(-80),
    afterContext: String(item.afterContext || "").slice(0, 80),
  };
}

function normalizeTextRange(item) {
  if (!item || typeof item !== "object") return null;
  const segments = [];
  for (const segment of Array.isArray(item.segments) ? item.segments : []) {
    const normalized = normalizeTextSegment(segment);
    if (normalized) segments.push(normalized);
  }
  if (!segments.length) return null;
  return { segments };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const common = {
    note: String(raw.note || "").trim().slice(0, 500),
    completedAt: normalizeTime(raw.completedAt),
  };

  if (raw.mode === "global") {
    return {
      mode: "global",
      ranges: [],
      references: [],
      textType: null,
      globalType: GLOBAL_TYPE_LABELS[raw.globalType] ? raw.globalType : null,
      ...common,
    };
  }

  if (raw.mode === "text") {
    const ranges = [];
    for (const item of Array.isArray(raw.ranges) ? raw.ranges : []) {
      const range = normalizeTextRange(item);
      if (range) ranges.push(range);
      if (ranges.length >= MAX_TEXT_EVIDENCE_RANGES) break;
    }
    return {
      mode: "text",
      ranges,
      references: [],
      textType: TEXT_TYPE_LABELS[raw.textType] ? raw.textType : null,
      globalType: null,
      ...common,
    };
  }

  // v1 compatibility stays explicit in memory. Loading or saving another question
  // must not silently convert all historical sentence records to schema v2 text ranges.
  const references = [];
  for (const item of Array.isArray(raw.references) ? raw.references : []) {
    const normalized = normalizeLegacySentenceRef(item);
    if (normalized) references.push(normalized);
    if (references.length >= MAX_SENTENCE_EVIDENCE) break;
  }
  return {
    mode: "sentences",
    references,
    ranges: [],
    textType: null,
    globalType: null,
    ...common,
  };
}

export function normalizeEvidenceStore(raw, resourceId, passageId) {
  const store = emptyEvidenceStore(resourceId, passageId);
  if (!raw || typeof raw !== "object") return store;
  const questions = {};
  for (const [key, value] of Object.entries(raw.questions || {})) {
    if (!key || !value || typeof value !== "object") continue;
    const first = normalizeEntry(value.first);
    const redo = normalizeEntry(value.redo);
    if (first || redo) questions[key] = { first, redo };
  }
  return {
    ...store,
    questions,
    updatedAt: Number(raw.updatedAt) || store.updatedAt,
  };
}

export function loadEvidenceStore(resourceId, passageId) {
  try {
    const raw = JSON.parse(getUserItem(evidenceStorageKey(resourceId, passageId)) || "");
    return normalizeEvidenceStore(raw, resourceId, passageId);
  } catch {
    return emptyEvidenceStore(resourceId, passageId);
  }
}

export function saveEvidenceStore(store) {
  if (!store?.resourceId || !store?.passageId) return false;
  try {
    setUserItem(evidenceStorageKey(store.resourceId, store.passageId), JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function cloneStore(store) {
  return normalizeEvidenceStore(store, store?.resourceId, store?.passageId);
}

// Kept for v1 callers/tests. New reader edits start with emptyTextEvidenceEntry().
export function emptyEvidenceEntry(now = Date.now()) {
  return {
    mode: "sentences",
    references: [],
    globalType: null,
    note: "",
    completedAt: now,
  };
}

export function emptyTextEvidenceEntry(now = Date.now()) {
  return {
    mode: "text",
    ranges: [],
    textType: null,
    globalType: null,
    note: "",
    completedAt: now,
  };
}

function legacyEntryToTextDraft(entry, passage) {
  const ranges = [];
  for (const ref of entry?.references || []) {
    const resolution = resolveSentenceRef(ref, passage);
    if (resolution.status !== "resolved") continue;
    const paragraph = passage?.paragraphs?.find((item) => item.number === resolution.ref.paragraphNumber);
    const sentenceText = String(paragraph?.sentences?.[resolution.ref.sentenceIndex] || "");
    if (!sentenceText) continue;
    ranges.push(buildTextRange({
      segments: [buildTextSegment({
        paragraphNumber: resolution.ref.paragraphNumber,
        sentenceIndex: resolution.ref.sentenceIndex,
        sentenceText,
        startOffset: 0,
        endOffset: sentenceText.length,
      })],
    }));
    if (ranges.length >= MAX_TEXT_EVIDENCE_RANGES) break;
  }
  return {
    ...emptyTextEvidenceEntry(entry?.completedAt || 0),
    ranges,
    note: String(entry?.note || ""),
    legacyDraft: true,
  };
}

export function draftFromEntry(entry, passage = null, { preserveSentences = false } = {}) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return emptyTextEvidenceEntry(0);
  if (normalized.mode === "sentences" && !preserveSentences) return legacyEntryToTextDraft(normalized, passage);
  return normalized;
}

export function entryFor(store, questionKey, attempt) {
  if (attempt !== "first" && attempt !== "redo") return null;
  return normalizeEntry(store?.questions?.[questionKey]?.[attempt]) || null;
}

export function entryNeedsType(entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return false;
  if (normalized.mode === "global") return !normalized.globalType;
  if (normalized.mode === "text") return !normalized.textType;
  return false;
}

export function entryComplete(entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return false;
  if (normalized.mode === "global") return Boolean(normalized.globalType);
  if (normalized.mode === "text") {
    return Boolean(normalized.textType) && normalized.ranges.length >= 1;
  }
  return normalized.references.length >= 1;
}

export function questionEvidenceComplete(store, questionKey, attempt, passage = null) {
  const entry = entryFor(store, questionKey, attempt);
  if (!entryComplete(entry)) return false;
  return passage && entry.mode === "text" ? entryResolutionOk(entry, passage) : true;
}

export function buildSentenceRef({ paragraphNumber, sentenceIndex, sentenceText }) {
  const number = Math.max(1, Number(paragraphNumber) || 1);
  const index = Math.max(0, Number(sentenceIndex) || 0);
  const text = String(sentenceText || "");
  return {
    paragraphNumber: number,
    sentenceIndex: index,
    sentenceKey: sentenceKeyFor({ paragraphNumber: number, sentenceIndex: index, sentenceText: text }),
    fingerprint: sentenceTextFingerprint(text),
    excerpt: cleanText(text, 72),
  };
}

export function buildTextSegment({
  paragraphNumber,
  sentenceIndex,
  sentenceText,
  startOffset,
  endOffset,
}) {
  const text = String(sentenceText || "");
  const start = Math.max(0, Math.min(text.length, Number(startOffset) || 0));
  const end = Math.max(start, Math.min(text.length, Number(endOffset) || 0));
  const contextSize = 36;
  return normalizeTextSegment({
    paragraphNumber,
    sentenceIndex,
    sentenceKey: sentenceKeyFor({ paragraphNumber, sentenceIndex, sentenceText: text }),
    fingerprint: sentenceTextFingerprint(text),
    startOffset: start,
    endOffset: end,
    selectedText: text.slice(start, end),
    beforeContext: text.slice(Math.max(0, start - contextSize), start),
    afterContext: text.slice(end, Math.min(text.length, end + contextSize)),
  });
}

export function buildTextRange({ segments = [] } = {}) {
  const normalized = normalizeTextRange({ segments });
  return normalized || { segments: [] };
}

export function addTextRange(draft, range) {
  if (!draft || draft.mode !== "text") return { draft, rejected: true, reason: "mode" };
  const normalized = normalizeTextRange(range);
  if (!normalized) return { draft, rejected: true, reason: "invalid" };
  const ranges = Array.isArray(draft.ranges) ? draft.ranges : [];
  if (ranges.length >= MAX_TEXT_EVIDENCE_RANGES) return { draft, rejected: true, reason: "limit" };
  const signature = JSON.stringify(normalized.segments.map((segment) => [
    segment.sentenceKey, segment.startOffset, segment.endOffset,
  ]));
  if (ranges.some((item) => JSON.stringify(item.segments.map((segment) => [
    segment.sentenceKey, segment.startOffset, segment.endOffset,
  ])) === signature)) {
    return { draft, rejected: false, reason: "duplicate" };
  }
  return { draft: { ...draft, ranges: [...ranges, normalized] }, rejected: false, reason: "ok" };
}

export function removeTextRange(draft, rangeIndex) {
  if (!draft || draft.mode !== "text") return draft;
  return {
    ...draft,
    ranges: (Array.isArray(draft.ranges) ? draft.ranges : []).filter((_, index) => index !== rangeIndex),
  };
}

export function setTextType(draft, textType) {
  if (!draft) return draft;
  return {
    ...draft,
    mode: "text",
    references: [],
    textType: TEXT_TYPE_LABELS[textType] ? textType : null,
    globalType: null,
  };
}

export function addSentenceRef(draft, ref) {
  if (!draft || draft.mode !== "sentences") return { draft, rejected: true, reason: "mode" };
  const refs = Array.isArray(draft.references) ? draft.references : [];
  if (refs.some((item) => item.sentenceKey === ref.sentenceKey)) return { draft, rejected: false, reason: "duplicate" };
  if (refs.length >= MAX_SENTENCE_EVIDENCE) return { draft, rejected: true, reason: "limit" };
  return { draft: { ...draft, references: [...refs, ref] }, rejected: false, reason: "ok" };
}

export function removeSentenceRef(draft, sentenceKey) {
  if (!draft || draft.mode !== "sentences") return draft;
  return { ...draft, references: (draft.references || []).filter((item) => item.sentenceKey !== sentenceKey) };
}

export function setEvidenceMode(draft, mode) {
  if (!draft) return draft;
  if (mode === "global") {
    return { ...draft, mode: "global", references: [], ranges: [], textType: null };
  }
  if (mode === "sentences") {
    return { ...draft, mode: "sentences", ranges: [], textType: null, globalType: null };
  }
  return { ...draft, mode: "text", references: [], globalType: null, ranges: draft.ranges || [] };
}

export function setGlobalType(draft, globalType) {
  if (!draft) return draft;
  return {
    ...draft,
    mode: "global",
    references: [],
    ranges: [],
    textType: null,
    globalType: GLOBAL_TYPE_LABELS[globalType] ? globalType : null,
  };
}

export function setEvidenceNote(draft, note) {
  if (!draft) return draft;
  return { ...draft, note: String(note || "").slice(0, 500) };
}

export function setEvidence(store, questionKey, attempt, entry) {
  if (!store || !questionKey || (attempt !== "first" && attempt !== "redo")) return store;
  const questions = { ...(store.questions || {}) };
  const current = questions[questionKey] ? { ...questions[questionKey] } : {};
  current[attempt] = entry ? normalizeEntry(entry) : null;
  questions[questionKey] = current;
  return { ...store, schemaVersion: QUESTION_EVIDENCE_SCHEMA_VERSION, questions, updatedAt: Date.now() };
}

export function clearEvidence(store, questionKey, attempt) {
  return setEvidence(store, questionKey, attempt, null);
}

function buildPassageIndex(passage) {
  const byKey = new Map();
  const byFingerprint = new Map();
  const all = [];
  for (const paragraph of Array.isArray(passage?.paragraphs) ? passage.paragraphs : []) {
    for (let sentenceIndex = 0; sentenceIndex < paragraph.sentences.length; sentenceIndex += 1) {
      const sentenceText = paragraph.sentences[sentenceIndex];
      const key = sentenceKeyFor({ paragraphNumber: paragraph.number, sentenceIndex, sentenceText });
      const item = { paragraphNumber: paragraph.number, sentenceIndex, sentenceKey: key, sentenceText };
      byKey.set(key, item);
      const fingerprint = sentenceTextFingerprint(sentenceText);
      if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, item);
      else byFingerprint.set(fingerprint, null);
      all.push({ item, fingerprint, excerpt: normalizeSentenceText(sentenceText).slice(0, 72) });
    }
  }
  return { byKey, byFingerprint, all };
}

export function resolveSentenceRef(ref, passage) {
  if (!ref || !passage) return { status: "unresolved", reason: "missing", ref: null };
  const paragraph = passage.paragraphs.find((item) => item.number === ref.paragraphNumber);
  const sentenceText = paragraph?.sentences?.[ref.sentenceIndex];
  if (sentenceText) {
    const key = sentenceKeyFor({ paragraphNumber: ref.paragraphNumber, sentenceIndex: ref.sentenceIndex, sentenceText });
    if (key === ref.sentenceKey) return { status: "resolved", ref: { paragraphNumber: ref.paragraphNumber, sentenceIndex: ref.sentenceIndex, sentenceKey: key } };
  }
  const index = buildPassageIndex(passage);
  if (ref.sentenceKey && index.byKey.has(ref.sentenceKey)) {
    const item = index.byKey.get(ref.sentenceKey);
    return { status: "resolved", ref: { paragraphNumber: item.paragraphNumber, sentenceIndex: item.sentenceIndex, sentenceKey: item.sentenceKey } };
  }
  if (ref.fingerprint) {
    const unique = index.byFingerprint.get(ref.fingerprint);
    if (unique) return { status: "resolved", ref: { paragraphNumber: unique.paragraphNumber, sentenceIndex: unique.sentenceIndex, sentenceKey: unique.sentenceKey } };
    if (index.byFingerprint.has(ref.fingerprint)) return { status: "unresolved", reason: "ambiguous-fingerprint", ref: null };
  }
  if (ref.excerpt) {
    const normalizedExcerpt = normalizeSentenceText(ref.excerpt);
    const candidates = index.all.filter((entry) => entry.excerpt.startsWith(normalizedExcerpt));
    if (candidates.length === 1) {
      const item = candidates[0].item;
      return { status: "resolved", ref: { paragraphNumber: item.paragraphNumber, sentenceIndex: item.sentenceIndex, sentenceKey: item.sentenceKey } };
    }
    if (candidates.length > 1) return { status: "unresolved", reason: "ambiguous-excerpt", ref: null };
  }
  return { status: "unresolved", reason: "missing", ref: null };
}

function occurrenceOffsets(text, needle) {
  const offsets = [];
  let from = 0;
  while (needle && from <= text.length) {
    const found = text.indexOf(needle, from);
    if (found < 0) break;
    offsets.push(found);
    from = found + Math.max(1, needle.length);
  }
  return offsets;
}

export function resolveTextSegment(segment, passage) {
  let sentence = resolveSentenceRef({
    ...segment,
    excerpt: segment.selectedText,
  }, passage);
  if (sentence.status !== "resolved") {
    const candidates = [];
    for (const candidate of buildPassageIndex(passage).all) {
      for (const offset of occurrenceOffsets(candidate.item.sentenceText, segment.selectedText)) {
        const beforeOk = !segment.beforeContext
          || candidate.item.sentenceText.slice(Math.max(0, offset - segment.beforeContext.length), offset).endsWith(segment.beforeContext);
        const end = offset + segment.selectedText.length;
        const afterOk = !segment.afterContext
          || candidate.item.sentenceText.slice(end, end + segment.afterContext.length).startsWith(segment.afterContext);
        if (beforeOk && afterOk) candidates.push({ item: candidate.item, offset });
      }
    }
    if (candidates.length !== 1) {
      return { status: "unresolved", reason: candidates.length > 1 ? "ambiguous-selection" : sentence.reason, ref: null };
    }
    const recovered = candidates[0];
    sentence = {
      status: "resolved",
      ref: {
        paragraphNumber: recovered.item.paragraphNumber,
        sentenceIndex: recovered.item.sentenceIndex,
        sentenceKey: recovered.item.sentenceKey,
      },
    };
  }
  const paragraph = passage.paragraphs.find((item) => item.number === sentence.ref.paragraphNumber);
  const sentenceText = String(paragraph?.sentences?.[sentence.ref.sentenceIndex] || "");
  const exact = sentenceText.slice(segment.startOffset, segment.endOffset);
  if (normalizeSentenceText(exact) === normalizeSentenceText(segment.selectedText)) {
    return { status: "resolved", ref: { ...sentence.ref, startOffset: segment.startOffset, endOffset: segment.endOffset, selectedText: exact } };
  }
  const candidates = occurrenceOffsets(sentenceText, segment.selectedText).filter((offset) => {
    const before = segment.beforeContext;
    const after = segment.afterContext;
    const beforeOk = !before || sentenceText.slice(Math.max(0, offset - before.length), offset).endsWith(before);
    const end = offset + segment.selectedText.length;
    const afterOk = !after || sentenceText.slice(end, end + after.length).startsWith(after);
    return beforeOk && afterOk;
  });
  if (candidates.length === 1) {
    const startOffset = candidates[0];
    return { status: "resolved", ref: { ...sentence.ref, startOffset, endOffset: startOffset + segment.selectedText.length, selectedText: segment.selectedText } };
  }
  return { status: "unresolved", reason: candidates.length > 1 ? "ambiguous-selection" : "missing-selection", ref: null };
}

export function resolveEntry(entry, passage) {
  const normalized = normalizeEntry(entry);
  if (!normalized || normalized.mode === "global") return [];
  if (normalized.mode === "text") {
    return normalized.ranges.flatMap((range, rangeIndex) => range.segments.map((segment, segmentIndex) => ({
      ...resolveTextSegment(segment, passage),
      rangeIndex,
      segmentIndex,
    })));
  }
  return normalized.references.map((ref) => resolveSentenceRef(ref, passage));
}

export function entryResolutionOk(entry, passage) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return false;
  if (normalized.mode === "global") return Boolean(normalized.globalType);
  const resolutions = resolveEntry(normalized, passage);
  if (normalized.mode === "text") {
    return normalized.ranges.some((_, rangeIndex) => {
      const rangeResolutions = resolutions.filter((item) => item.rangeIndex === rangeIndex);
      return rangeResolutions.length > 0 && rangeResolutions.every((item) => item.status === "resolved");
    });
  }
  return resolutions.length > 0 && resolutions.every((item) => item.status === "resolved");
}

export function sentenceRefLabel(ref) {
  if (!ref) return "";
  return `P${ref.paragraphNumber} · S${ref.sentenceIndex + 1}`;
}

export function textRangeExcerpt(range) {
  return (range?.segments || []).map((segment) => segment.selectedText).join(" ").trim();
}

export function entrySummaryLabel(entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return "";
  if (normalized.mode === "global") return GLOBAL_TYPE_LABELS[normalized.globalType] || "全文/结构依据 · 需补类型";
  if (normalized.mode === "text") {
    const type = TEXT_TYPE_LABELS[normalized.textType] || "需补类型";
    return `${type} · ${normalized.ranges.length ? "已定位" : "尚未定位"}`;
  }
  return normalized.references.map(sentenceRefLabel).join(" · ");
}

export function countEvidenceComplete(questions, store, attempt) {
  const list = Array.isArray(questions) ? questions : [];
  let completed = 0;
  for (let index = 0; index < list.length; index += 1) {
    const question = list[index];
    const key = questionKeyFor({ resourceId: store?.resourceId, passageId: store?.passageId, questionNumber: question.number, questionStem: question.stem, questionIndex: index });
    if (questionEvidenceComplete(store, key, attempt)) completed += 1;
  }
  return { total: list.length, completed };
}

export function quizCompletion({ questions = [], answers = {}, store = null, attempt = "first", stageCompleted = false, passage = null } = {}) {
  const list = Array.isArray(questions) ? questions : [];
  const answerComplete = hasAllQuestionsAnswered(list, answers);
  let evidenceCompleted = 0;
  const remainingWithoutEvidence = [];
  const remainingWithoutAnswer = [];
  for (let index = 0; index < list.length; index += 1) {
    const question = list[index];
    const key = questionKeyFor({ resourceId: store?.resourceId, passageId: store?.passageId, questionNumber: question.number, questionStem: question.stem, questionIndex: index });
    if (questionEvidenceComplete(store, key, attempt, passage)) evidenceCompleted += 1;
    else remainingWithoutEvidence.push(question.number);
    if (!answers?.[question.number]) remainingWithoutAnswer.push(question.number);
  }
  const evidenceComplete = evidenceCompleted === list.length;
  return {
    total: list.length,
    answerComplete,
    evidenceComplete,
    answeredCount: list.length - remainingWithoutAnswer.length,
    evidenceCompleted,
    remainingWithoutAnswer,
    remainingWithoutEvidence,
    canComplete: Boolean(stageCompleted) || (answerComplete && evidenceComplete),
  };
}

function evidenceEquivalent(first, redo) {
  const a = normalizeEntry(first);
  const b = normalizeEntry(redo);
  if (!a && !b) return true;
  if (!a || !b || a.mode !== b.mode) return false;
  if (a.mode === "global") return a.globalType === b.globalType;
  if (a.mode === "text") {
    return a.textType === b.textType && JSON.stringify(a.ranges) === JSON.stringify(b.ranges);
  }
  return a.references.map((item) => item.sentenceKey).sort().join("\u0001")
    === b.references.map((item) => item.sentenceKey).sort().join("\u0001");
}

export function compareAttempts({ firstEntry = null, redoEntry = null, firstAnswer = "", redoAnswer = "" } = {}) {
  const answerChanged = String(firstAnswer || "") !== String(redoAnswer || "");
  const evidenceChanged = !evidenceEquivalent(firstEntry, redoEntry);
  return {
    answerChanged,
    evidenceChanged,
    tags: [answerChanged ? "答案改变" : "答案未变", evidenceChanged ? "证据改变" : "证据未变"],
  };
}
