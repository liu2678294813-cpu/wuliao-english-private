import { splitSentences } from "./deepReadingParser";
import { sentenceTextFingerprint } from "./translationProgress";

const BLANK_PATTERN = /__CLOZE_BLANK_(\d+)__/g;

function placeholderFor(number) {
  return `__CLOZE_BLANK_${number}__`;
}

function paragraphStableText(paragraph) {
  return (Array.isArray(paragraph?.segments) ? paragraph.segments : [])
    .map((segment) => (
      segment?.type === "blank"
        ? placeholderFor(Number(segment.number) || 0)
        : String(segment?.text ?? "")
    ))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceTokens(stableText) {
  const tokens = [];
  let cursor = 0;
  BLANK_PATTERN.lastIndex = 0;
  for (const match of stableText.matchAll(BLANK_PATTERN)) {
    if (match.index > cursor) tokens.push({ type: "text", text: stableText.slice(cursor, match.index) });
    tokens.push({ type: "blank", number: Number(match[1]) });
    cursor = match.index + match[0].length;
  }
  if (cursor < stableText.length) tokens.push({ type: "text", text: stableText.slice(cursor) });
  return tokens;
}

function sentenceExcerpt(stableText) {
  return stableText
    .replace(BLANK_PATTERN, (_, number) => `[${number}]`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function clozeSentenceKeyFor({ resourceId, clozeId, paragraphNumber, sentenceIndex, stableText }) {
  const source = sentenceTextFingerprint(`${resourceId}::${clozeId}`);
  const fingerprint = sentenceTextFingerprint(stableText);
  return `cloze:${source}:p${paragraphNumber}s${sentenceIndex + 1}:${fingerprint}`;
}

export function buildClozeSentenceModel(cloze, resourceId, clozeId) {
  const paragraphs = [];
  const blankToSentence = {};
  const sentenceByKey = {};
  const sourceParagraphs = Array.isArray(cloze?.paragraphs) ? cloze.paragraphs : [];

  sourceParagraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphNumber = Number(paragraph?.number) || paragraphIndex + 1;
    const stableParagraph = paragraphStableText(paragraph);
    const split = splitSentences(stableParagraph);
    const sentenceTexts = split.length ? split : (stableParagraph ? [stableParagraph] : []);
    const sentences = sentenceTexts.map((stableText, sentenceIndex) => {
      const tokens = sentenceTokens(stableText);
      const blankNumbers = tokens.filter((token) => token.type === "blank").map((token) => token.number);
      const fingerprint = sentenceTextFingerprint(stableText);
      const sentenceKey = clozeSentenceKeyFor({
        resourceId,
        clozeId,
        paragraphNumber,
        sentenceIndex,
        stableText,
      });
      const sentence = {
        paragraphNumber,
        sentenceIndex,
        sentenceKey,
        fingerprint,
        stableText,
        excerpt: sentenceExcerpt(stableText),
        blankNumbers,
        tokens,
        anchor: `cloze-sentence-${paragraphNumber}-${sentenceIndex + 1}`,
      };
      sentenceByKey[sentenceKey] = sentence;
      for (const number of blankNumbers) blankToSentence[number] = sentence;
      return sentence;
    });
    paragraphs.push({ number: paragraphNumber, sentences });
  });

  return { paragraphs, blankToSentence, sentenceByKey };
}

export function buildClozeSentenceRef(sentence) {
  if (!sentence?.sentenceKey) return null;
  return {
    paragraphNumber: sentence.paragraphNumber,
    sentenceIndex: sentence.sentenceIndex,
    sentenceKey: sentence.sentenceKey,
    fingerprint: sentence.fingerprint,
    excerpt: sentence.excerpt,
  };
}

export function resolveClozeSentenceRef(reference, model) {
  if (!reference || !model) return null;
  const exact = model.sentenceByKey?.[reference.sentenceKey];
  if (exact && exact.fingerprint === reference.fingerprint) return exact;
  const paragraph = model.paragraphs?.find((item) => item.number === reference.paragraphNumber);
  const indexed = paragraph?.sentences?.[reference.sentenceIndex];
  if (indexed?.fingerprint === reference.fingerprint) return indexed;
  const matches = (model.paragraphs || [])
    .flatMap((item) => item.sentences || [])
    .filter((sentence) => sentence.fingerprint === reference.fingerprint);
  return matches.length === 1 ? matches[0] : null;
}

export function priorityTranslationTargets(model, priorityBlankNumbers = [], targetOverrides = {}) {
  const targetKeys = new Set();
  for (const number of priorityBlankNumbers) {
    const sentence = model?.blankToSentence?.[number];
    if (sentence) targetKeys.add(sentence.sentenceKey);
  }
  for (const [sentenceKey, override] of Object.entries(targetOverrides || {})) {
    if (!model?.sentenceByKey?.[sentenceKey]) continue;
    if (override === "include") targetKeys.add(sentenceKey);
    if (override === "exclude") targetKeys.delete(sentenceKey);
  }
  return (model?.paragraphs || [])
    .flatMap((paragraph) => paragraph.sentences || [])
    .filter((sentence) => targetKeys.has(sentence.sentenceKey));
}

