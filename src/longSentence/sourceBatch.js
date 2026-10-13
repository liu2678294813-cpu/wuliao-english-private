export const MAX_LONG_SENTENCE_SOURCES = 6;
export const MAX_LONG_SENTENCE_WORDS = 24;

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
