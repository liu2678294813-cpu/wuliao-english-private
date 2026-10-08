import { getUserItem, setUserItem } from "../userData.js";

export const LONG_SENTENCE_FLAG_KEY = "wuliao:feature:longSentenceTrainingEnabled";

export function getLongSentenceTrainingEnabled() {
  return getUserItem(LONG_SENTENCE_FLAG_KEY) !== "false";
}

export function setLongSentenceTrainingEnabled(enabled) {
  setUserItem(LONG_SENTENCE_FLAG_KEY, enabled ? "true" : "false");
  return Boolean(enabled);
}
