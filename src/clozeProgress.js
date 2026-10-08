// 完形填空作答数据（B 阶段正式版）。
//
//   - 首次答案 (firstAnswer) 与复查答案 (reviewAnswer) 必须独立保存，绝不能让
//     复查覆盖首次答案。这是硬要求——后续要据此计算"初做错误→自查纠正"或
//     "初做正确→自查改错"。
//   - 置信度同样按 attempt 隔离：firstConfidence（初做）与 reviewConfidence（复查）
//     独立保存，绝不互相覆盖。旧 A 阶段只有单一 confidence 字段，读取时归一化
//     到 firstConfidence，`confidence` 保留为只读兼容别名。
//   - firstSubmitted / reviewSubmitted 标记对应 attempt 是否已提交冻结。
//   - activeBlank 持久化当前所在空位，退出重进可以恢复。
//   - 存储 key 与阅读 / 翻译 / 复习完全隔离：`wuliao:cloze-progress:...`

import { getUserItem, setUserItem } from "./userData";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";

export const CLOZE_PROGRESS_SCHEMA_VERSION = 2;
export const CONFIDENCE_VALUES = ["confident", "uncertain", "guess"];
export const CLOZE_BASIS_TYPES = [
  { id: "context", label: "上下文" },
  { id: "logic", label: "逻辑" },
  { id: "collocation", label: "搭配" },
  { id: "grammar", label: "语法" },
  { id: "word-meaning", label: "词义" },
];
export const CLOZE_BASIS_TYPE_LABELS = Object.fromEntries(
  CLOZE_BASIS_TYPES.map((item) => [item.id, item.label]),
);
const VALID_ANSWERS = ["A", "B", "C", "D"];

export function clozeProgressStorageKey(resourceId, clozeId) {
  return `wuliao:cloze-progress:${resourceId}:${clozeId}`;
}

function readJson(key, fallback = null) {
  try {
    return JSON.parse(getUserItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

export function emptyBlankAttempt(number, blankId = "", now = Date.now()) {
  return {
    blankId: blankId || `blank-${number}`,
    number,
    firstAnswer: "",
    reviewAnswer: "",
    firstConfidence: "",
    reviewConfidence: "",
    confidence: "",
    prediction: "",
    basisTypes: [],
    references: [],
    corrected: false,
    analyzed: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyClozeProgress(resourceId, clozeId, blankNumbers = [], now = Date.now()) {
  const numbers = Array.isArray(blankNumbers) && blankNumbers.length
    ? blankNumbers
    : Array.from({ length: 20 }, (_, index) => index + 1);
  return {
    schemaVersion: CLOZE_PROGRESS_SCHEMA_VERSION,
    resourceId,
    clozeId,
    attempts: Object.fromEntries(numbers.map((number) => [number, emptyBlankAttempt(number, `blank-${number}`, now)])),
    activeBlank: numbers[0] || 1,
    firstSubmitted: false,
    reviewSubmitted: false,
    updatedAt: now,
  };
}

function normalizeBasisTypes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

export function normalizeClozeReference(value) {
  if (!value || typeof value !== "object") return null;
  const paragraphNumber = Number(value.paragraphNumber);
  const sentenceIndex = Number(value.sentenceIndex);
  const sentenceKey = String(value.sentenceKey || "").trim();
  const fingerprint = String(value.fingerprint || "").trim();
  if (!Number.isInteger(paragraphNumber) || paragraphNumber < 1) return null;
  if (!Number.isInteger(sentenceIndex) || sentenceIndex < 0) return null;
  if (!sentenceKey || !fingerprint) return null;
  return {
    paragraphNumber,
    sentenceIndex,
    sentenceKey,
    fingerprint,
    excerpt: String(value.excerpt || "").replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

function normalizeReferences(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const references = [];
  for (const item of value) {
    const reference = normalizeClozeReference(item);
    if (!reference || seen.has(reference.sentenceKey)) continue;
    seen.add(reference.sentenceKey);
    references.push(reference);
  }
  return references;
}

export function normalizeBlankAttempt(attempt, number, now = Date.now()) {
  if (!attempt || typeof attempt !== "object") return emptyBlankAttempt(number, `blank-${number}`, now);
  const firstConfidence = CONFIDENCE_VALUES.includes(attempt.firstConfidence)
    ? attempt.firstConfidence
    : CONFIDENCE_VALUES.includes(attempt.confidence)
      ? attempt.confidence
      : "";
  const reviewConfidence = CONFIDENCE_VALUES.includes(attempt.reviewConfidence)
    ? attempt.reviewConfidence
    : "";
  return {
    blankId: attempt.blankId || `blank-${number}`,
    number,
    firstAnswer: VALID_ANSWERS.includes(attempt.firstAnswer) ? attempt.firstAnswer : "",
    reviewAnswer: VALID_ANSWERS.includes(attempt.reviewAnswer) ? attempt.reviewAnswer : "",
    firstConfidence,
    reviewConfidence,
    confidence: firstConfidence,
    prediction: String(attempt.prediction ?? ""),
    basisTypes: normalizeBasisTypes(attempt.basisTypes),
    references: normalizeReferences(attempt.references),
    corrected: Boolean(attempt.corrected),
    analyzed: Boolean(attempt.analyzed),
    createdAt: Number(attempt.createdAt) || now,
    updatedAt: Number(attempt.updatedAt) || now,
  };
}

export function normalizeClozeProgress(progress, blankNumbers = []) {
  if (!progress || typeof progress !== "object") return null;
  const storedNumbers = Object.keys(progress.attempts || {}).map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const numbers = Array.isArray(blankNumbers) && blankNumbers.length
    ? blankNumbers
    : storedNumbers.length ? storedNumbers : Array.from({ length: 20 }, (_, index) => index + 1);
  const attempts = {};
  for (const number of numbers) {
    attempts[number] = normalizeBlankAttempt(progress.attempts?.[number], number);
  }
  const firstActive = Number(progress.activeBlank) || numbers[0] || 1;
  return {
    schemaVersion: CLOZE_PROGRESS_SCHEMA_VERSION,
    resourceId: String(progress.resourceId || ""),
    clozeId: String(progress.clozeId || ""),
    attempts,
    activeBlank: numbers.includes(firstActive) ? firstActive : numbers[0] || 1,
    firstSubmitted: Boolean(progress.firstSubmitted),
    reviewSubmitted: Boolean(progress.reviewSubmitted),
    updatedAt: Number(progress.updatedAt) || Date.now(),
  };
}

export function getClozeProgress(resourceId, clozeId, blankNumbers = []) {
  const stored = readJson(clozeProgressStorageKey(resourceId, clozeId), null);
  if (!stored) return emptyClozeProgress(resourceId, clozeId, blankNumbers);
  const fallback = emptyClozeProgress(resourceId, clozeId, blankNumbers);
  const normalized = {
    ...fallback,
    ...normalizeClozeProgress(stored, blankNumbers),
    resourceId: String(resourceId),
    clozeId: String(clozeId),
  };
  if (!normalized.attempts) normalized.attempts = fallback.attempts;
  for (const number of blankNumbers.length ? blankNumbers : Object.keys(fallback.attempts)) {
    const key = Number(number);
    if (!normalized.attempts[key]) normalized.attempts[key] = fallback.attempts[key];
  }
  if (!numbers(normalized).includes(normalized.activeBlank)) normalized.activeBlank = numbers(normalized)[0] || 1;
  return normalized;
}

function numbers(progress) {
  return Object.keys(progress.attempts).map(Number).sort((a, b) => a - b);
}

export function saveClozeProgress(progress, username) {
  if (!progress?.resourceId || !progress?.clozeId) return;
  setUserItem(clozeProgressStorageKey(progress.resourceId, progress.clozeId), JSON.stringify(progress), username);
  emitAppEvent(AppEvent.LEARNING_STATE_INVALIDATED);
}

function withAttempt(progress, number, mutator) {
  const next = { ...progress, attempts: { ...progress.attempts } };
  const now = Date.now();
  const existing = next.attempts[number] || emptyBlankAttempt(number, `blank-${number}`, now);
  next.attempts[number] = { ...mutator(existing), updatedAt: now };
  next.updatedAt = now;
  return next;
}

function withProgress(progress, mutator) {
  const now = Date.now();
  return { ...mutator({ ...progress, attempts: progress.attempts || {} }), updatedAt: now };
}

// 首次答案：仅设置 firstAnswer。复查永远不碰它。
export function recordFirstAnswer(progress, number, answer) {
  if (!VALID_ANSWERS.includes(answer)) return progress;
  return withAttempt(progress, number, (attempt) => ({ ...attempt, firstAnswer: answer }));
}

// 复查答案：仅设置 reviewAnswer，绝不修改 firstAnswer。
export function recordReviewAnswer(progress, number, answer) {
  if (!VALID_ANSWERS.includes(answer)) return progress;
  return withAttempt(progress, number, (attempt) => ({ ...attempt, reviewAnswer: answer }));
}

// 初做置信度：仅设置 firstConfidence（以及 A 阶段兼容别名 confidence）。
export function recordFirstConfidence(progress, number, confidence) {
  if (!CONFIDENCE_VALUES.includes(confidence)) return progress;
  return withAttempt(progress, number, (attempt) => ({
    ...attempt,
    firstConfidence: confidence,
    confidence,
  }));
}

// 复查置信度：仅设置 reviewConfidence，绝不覆盖初做置信度。
export function recordReviewConfidence(progress, number, confidence) {
  if (!CONFIDENCE_VALUES.includes(confidence)) return progress;
  return withAttempt(progress, number, (attempt) => ({ ...attempt, reviewConfidence: confidence }));
}

// A 阶段兼容：setConfidence 等价于初做置信度。
export function setConfidence(progress, number, confidence) {
  return recordFirstConfidence(progress, number, confidence);
}

export function setActiveBlank(progress, number) {
  const list = numbers(progress);
  if (!list.includes(number)) return progress;
  return withProgress(progress, (next) => ({ ...next, activeBlank: number }));
}

export function activeBlankOf(progress) {
  return progress?.activeBlank || 1;
}

export function markFirstSubmitted(progress, submitted = true) {
  return withProgress(progress, (next) => ({ ...next, firstSubmitted: Boolean(submitted) }));
}

export function markReviewSubmitted(progress, submitted = true) {
  return withProgress(progress, (next) => ({ ...next, reviewSubmitted: Boolean(submitted) }));
}

// ---------------- C 阶段逐空精析 ----------------

export function setPrediction(progress, number, prediction) {
  if (typeof prediction !== "string") return progress;
  return withAttempt(progress, number, (attempt) => ({ ...attempt, prediction }));
}

export function setBasisTypes(progress, number, basisTypes) {
  if (!Array.isArray(basisTypes)) return progress;
  return withAttempt(progress, number, (attempt) => {
    const unknown = normalizeBasisTypes(attempt.basisTypes)
      .filter((value) => !CLOZE_BASIS_TYPE_LABELS[value]);
    const known = normalizeBasisTypes(basisTypes)
      .filter((value) => CLOZE_BASIS_TYPE_LABELS[value]);
    return { ...attempt, basisTypes: [...unknown, ...known] };
  });
}

export function toggleBasisType(progress, number, basisType) {
  if (!CLOZE_BASIS_TYPE_LABELS[basisType]) return progress;
  const current = normalizeBasisTypes(progress?.attempts?.[number]?.basisTypes);
  const known = current.filter((value) => CLOZE_BASIS_TYPE_LABELS[value]);
  const nextKnown = known.includes(basisType)
    ? known.filter((value) => value !== basisType)
    : [...known, basisType];
  return setBasisTypes(progress, number, nextKnown);
}

export function setReferences(progress, number, references) {
  if (!Array.isArray(references)) return progress;
  return withAttempt(progress, number, (attempt) => ({
    ...attempt,
    references: normalizeReferences(references),
  }));
}

export function addReference(progress, number, reference) {
  const normalized = normalizeClozeReference(reference);
  if (!normalized) return progress;
  const current = normalizeReferences(progress?.attempts?.[number]?.references);
  if (current.some((item) => item.sentenceKey === normalized.sentenceKey)) return progress;
  return setReferences(progress, number, [...current, normalized]);
}

export function removeReference(progress, number, sentenceKey) {
  const key = String(sentenceKey || "");
  if (!key) return progress;
  const current = normalizeReferences(progress?.attempts?.[number]?.references);
  if (!current.some((item) => item.sentenceKey === key)) return progress;
  return setReferences(progress, number, current.filter((item) => item.sentenceKey !== key));
}

export function markCorrected(progress, number, corrected = true) {
  return withAttempt(progress, number, (attempt) => ({ ...attempt, corrected: Boolean(corrected) }));
}

export function markAllCorrected(progress, corrected = true, now = Date.now()) {
  if (!progress?.attempts) return progress;
  const attempts = {};
  for (const [number, attempt] of Object.entries(progress.attempts)) {
    attempts[number] = { ...attempt, corrected: Boolean(corrected), updatedAt: now };
  }
  return { ...progress, attempts, updatedAt: now };
}

export function markAnalyzed(progress, number, analyzed = true) {
  return withAttempt(progress, number, (attempt) => ({ ...attempt, analyzed: Boolean(analyzed) }));
}

export function analyzedBlankNumbers(progress) {
  return numbers(progress).filter((number) => progress.attempts[number]?.analyzed === true);
}

export function nextUnanalyzedBlank(progress, fromNumber) {
  const list = numbers(progress);
  const startIndex = Math.max(0, list.findIndex((number) => number >= fromNumber));
  for (let offset = 0; offset < list.length; offset += 1) {
    const number = list[(startIndex + offset) % list.length];
    if (!progress.attempts[number]?.analyzed) return number;
  }
  return null;
}

// ---------------- 纯函数统计 ----------------

// 生效置信度：复查优先，其次初做（旧记录只有初做）。
export function effectiveConfidence(attempt) {
  if (!attempt) return "";
  if (CONFIDENCE_VALUES.includes(attempt.reviewConfidence)) return attempt.reviewConfidence;
  if (CONFIDENCE_VALUES.includes(attempt.firstConfidence)) return attempt.firstConfidence;
  if (CONFIDENCE_VALUES.includes(attempt.confidence)) return attempt.confidence;
  return "";
}

export function summarizeClozeAttempts(progress, officialAnswers = {}) {
  const attempts = progress?.attempts || {};
  const list = Object.keys(attempts).map(Number).sort((a, b) => a - b);
  const total = list.length;
  let firstCompleted = 0;
  let reviewCompleted = 0;
  let firstCorrect = 0;
  let reviewCorrect = 0;
  let changed = 0;
  let selfCorrected = 0;
  let selfChangedToWrong = 0;
  let confidentWrong = 0;
  let uncertain = 0;
  let guesses = 0;

  for (const number of list) {
    const attempt = attempts[number];
    if (!attempt) continue;
    const official = officialAnswers[number] || officialAnswers[String(number)];
    const first = attempt.firstAnswer;
    const review = attempt.reviewAnswer;
    if (first) firstCompleted += 1;
    if (review) reviewCompleted += 1;
    if (official) {
      if (first === official) firstCorrect += 1;
      if (review === official) reviewCorrect += 1;
      if (first && review && first !== review) {
        changed += 1;
        if (review === official) selfCorrected += 1;
        if (first === official && review !== official) selfChangedToWrong += 1;
      }
      if (confidenceWrong(attempt, official)) confidentWrong += 1;
    }
    const confidence = effectiveConfidence(attempt);
    if (confidence === "uncertain") uncertain += 1;
    if (confidence === "guess") guesses += 1;
  }

  return {
    total,
    firstCompleted,
    reviewCompleted,
    firstCorrect,
    reviewCorrect,
    changed,
    selfCorrected,
    selfChangedToWrong,
    confidentWrong,
    uncertain,
    guesses,
  };
}

function confidenceWrong(attempt, official) {
  if (effectiveConfidence(attempt) !== "confident") return false;
  const effective = attempt.reviewAnswer || attempt.firstAnswer;
  return effective && effective !== official;
}

export function shouldDeepAnalyzeBlank(attempt, officialAnswer) {
  if (!attempt) return false;
  const official = officialAnswer || "";
  const effective = attempt.reviewAnswer || attempt.firstAnswer;
  if (effective && official && effective !== official) return true;
  if (attempt.firstAnswer && attempt.reviewAnswer && attempt.firstAnswer !== attempt.reviewAnswer) return true;
  const confidence = effectiveConfidence(attempt);
  if (confidence === "uncertain") return true;
  if (confidence === "guess") return true;
  return false;
}

export function listPriorityBlankNumbers(progress, officialAnswers = {}) {
  const attempts = progress?.attempts || {};
  return Object.keys(attempts)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((number) => {
      const attempt = attempts[number];
      return shouldDeepAnalyzeBlank(attempt, officialAnswers[number] || officialAnswers[String(number)]);
    });
}

// ---------------- B 阶段 priority（订正前不依赖官方答案） ----------------

// 订正前 priority：未完成、不确定、猜测、first/review 不一致。
// 严禁在此处读取官方答案，否则构成答案泄露。
export function listPreCorrectionPriorityBlankNumbers(progress) {
  const attempts = progress?.attempts || {};
  return Object.keys(attempts)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((number) => {
      const attempt = attempts[number];
      if (!attempt) return true;
      if (!attempt.firstAnswer) return true;
      if (progress.reviewSubmitted && !attempt.reviewAnswer) return true;
      if (attempt.firstAnswer && attempt.reviewAnswer && attempt.firstAnswer !== attempt.reviewAnswer) return true;
      const firstConfidence = attempt.firstConfidence || attempt.confidence;
      if (firstConfidence === "uncertain" || firstConfidence === "guess") return true;
      if (attempt.reviewConfidence === "uncertain" || attempt.reviewConfidence === "guess") return true;
      return false;
    });
}

// 订正后 priority：在订正前基础上加入 first/review 与官方答案不一致的空。
export function listPostCorrectionPriorityBlankNumbers(progress, officialAnswers = {}) {
  const attempts = progress?.attempts || {};
  const pre = new Set(listPreCorrectionPriorityBlankNumbers(progress));
  for (const number of Object.keys(attempts)) {
    const attempt = attempts[number];
    if (!attempt) continue;
    const official = officialAnswers[number] || officialAnswers[String(number)];
    if (!official) continue;
    if (attempt.firstAnswer && attempt.firstAnswer !== official) pre.add(Number(number));
    if (attempt.reviewAnswer && attempt.reviewAnswer !== official) pre.add(Number(number));
  }
  return [...pre].sort((a, b) => a - b);
}

export function isBlankUnanswered(attempt) {
  return !attempt || !attempt.firstAnswer;
}

export function nextUnansweredBlank(progress, fromNumber) {
  const list = numbers(progress);
  const attempts = progress?.attempts || {};
  const startIndex = list.findIndex((number) => number >= fromNumber);
  for (let index = startIndex >= 0 ? startIndex : 0; index < list.length; index += 1) {
    const number = list[index];
    if (!attempts[number]?.firstAnswer) return number;
  }
  for (let index = 0; index < startIndex && index < list.length; index += 1) {
    const number = list[index];
    if (!attempts[number]?.firstAnswer) return number;
  }
  return null;
}
