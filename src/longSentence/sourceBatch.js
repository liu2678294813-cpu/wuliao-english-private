export const MAX_LONG_SENTENCE_SOURCES = 6;
export const MAX_LONG_SENTENCE_WORDS = 24;

// New training sessions never sample or silently truncate a user's selection.
export function longSentenceSelectionLimits(count) {
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new RangeError("生成数量必须为 1–5 的整数");
  return { sources: Math.min(2 * count, 6), words: 3 * count, recommendedWords: [count, 2 * count] };
}

export function assertLongSentenceSelection({ count, sources, words }) {
  const limits = longSentenceSelectionLimits(count);
  if (!sources.length) throw new Error("请至少选择一个可用的待复盘原句");
  if (sources.length > limits.sources) throw new Error(`生成 ${count} 句最多选择 ${limits.sources} 个待复盘原句；请减少原句或增加生成数量。`);
  if (words.length > limits.words) throw new Error(`生成 ${count} 句最多选择 ${limits.words} 个陌生词；请减少词汇或增加生成数量。`);
  return limits;
}

// A saved large selection is a queue, not one enormous AI prompt.
// Rotate through all selected sources without dropping the selection itself.
export function chooseLongSentenceSources(sources, cursor = 0, limit = MAX_LONG_SENTENCE_SOURCES) {
  if (!Array.isArray(sources) || !Number.isInteger(limit) || limit < 1) throw new TypeError("invalid source batch");
  if (!sources.length) return { items: [], nextCursor: 0, total: 0 };
  const offset = Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) % sources.length : 0;
  if (sources.length <= limit) return { items: sources.slice(), nextCursor: offset, total: sources.length };
  return {
    items: Array.from({ length: limit }, (_, index) => sources[(offset + index) % sources.length]),
    nextCursor: (offset + limit) % sources.length,
    total: sources.length,
  };
}

export function chooseLongSentenceWords(words, limit = MAX_LONG_SENTENCE_WORDS) {
  if (!Array.isArray(words) || !Number.isInteger(limit) || limit < 1) throw new TypeError("invalid word batch");
  return { items: words.slice(0, limit), total: words.length };
}
