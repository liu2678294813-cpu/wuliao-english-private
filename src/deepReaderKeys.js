import { STAGE_IDS } from "./readingFlow";

/**
 * Single source of truth for deep-reader storage keys that "清空页面" is
 * allowed to remove. Everything else (answers, evidence, AI records, flow,
 * unknown words, review tasks) intentionally stays out of this module.
 */

export const deepNavigationNoteKey = (resourceId, passageId) =>
  `wuliao:deep-note:${resourceId}:${passageId}:navigation`;

export const translationTextKey = (resourceId, passageId, paragraphNumber, sentenceIndex) =>
  `wuliao:deep-translation:${resourceId}:${passageId}:${paragraphNumber}:${sentenceIndex}`;

export const translationMethodKey = (resourceId, passageId, paragraphNumber, sentenceIndex) =>
  `wuliao:deep-translation:method:${resourceId}:${passageId}:${paragraphNumber}:${sentenceIndex}`;

export const translationOcrKey = (resourceId, passageId, paragraphNumber, sentenceIndex) =>
  `wuliao:deep-translation:ocr:${resourceId}:${passageId}:${paragraphNumber}:${sentenceIndex}`;

// Deliberately survives page clearing: ambiguous legacy text must not reappear.
export const translationLegacyDismissedKey = (resourceId, passageId) =>
  `wuliao:deep-translation:legacy-dismissed:${resourceId}:${passageId}`;

export const paragraphSummaryKey = (resourceId, passageId, paragraphNumber) =>
  `wuliao:deep-summary:${resourceId}:${passageId}:${paragraphNumber}`;

export const paragraphCompressKey = (resourceId, passageId, paragraphNumber) =>
  `wuliao:deep-compress:${resourceId}:${passageId}:${paragraphNumber}`;

export const passageThemeKey = (resourceId, passageId) =>
  `wuliao:deep-theme:${resourceId}:${passageId}`;

export const passageInkKey = (resourceId, passageId) =>
  `wuliao:deep-ink:${resourceId}:${passageId}`;

export const passageStageInkKey = (resourceId, passageId, stageId) =>
  `wuliao:deep-ink:v2:${resourceId}:${passageId}:${stageId}`;

export const passageStageInkMigrationKey = (resourceId, passageId) =>
  `wuliao:deep-ink:v2-migrated:${resourceId}:${passageId}`;

export function passageClearableKeys(resource, passage) {
  const resourceId = resource?.id ?? resource?.resourceId ?? "";
  const passageId = passage?.id ?? "";
  const keys = [];
  keys.push(deepNavigationNoteKey(resourceId, passageId));

  for (const paragraph of passage?.paragraphs || []) {
    const sentences = Array.isArray(paragraph?.sentences) ? paragraph.sentences : [];
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      keys.push(translationTextKey(resourceId, passageId, paragraph.number, sentenceIndex));
      keys.push(translationMethodKey(resourceId, passageId, paragraph.number, sentenceIndex));
      keys.push(translationOcrKey(resourceId, passageId, paragraph.number, sentenceIndex));
    }
    keys.push(paragraphSummaryKey(resourceId, passageId, paragraph.number));
    keys.push(paragraphCompressKey(resourceId, passageId, paragraph.number));
  }

  keys.push(passageThemeKey(resourceId, passageId));
  keys.push(passageInkKey(resourceId, passageId));
  keys.push(passageStageInkMigrationKey(resourceId, passageId));
  STAGE_IDS.forEach((stageId) => keys.push(passageStageInkKey(resourceId, passageId, stageId)));
  return keys;
}
