import { getCurrentUsername, getUserItem, setUserItem, removeUserItem } from "./userData.js";
import { translationTextKey, translationMethodKey, translationOcrKey, translationLegacyDismissedKey } from "./deepReaderKeys.js";

export function translationOcrTarget({ username = getCurrentUsername(), resourceId, passageId, paragraphNumber, sentenceIndex, sentence }) {
  if (!username || typeof resourceId !== "string" || !resourceId || typeof passageId !== "string" || !passageId) throw new Error("译文所属账号或文章无效");
  return {
    username, resourceId, passageId, paragraphNumber, sentenceIndex, sentence,
    storageKey: translationTextKey(resourceId, passageId, paragraphNumber, sentenceIndex),
    methodKey: translationMethodKey(resourceId, passageId, paragraphNumber, sentenceIndex),
    metadataKey: translationOcrKey(resourceId, passageId, paragraphNumber, sentenceIndex),
  };
}

export function readTranslationOcr(target) {
  try {
    const data = JSON.parse(getUserItem(target.metadataKey, target.username) || "null");
    return data?.version === 1 && data.sentence === target.sentence ? data : null;
  } catch { return null; }
}

export function pendingLegacyTranslation(target) {
  if (getUserItem(target.storageKey, target.username) !== null
    || getUserItem(translationLegacyDismissedKey(target.resourceId, target.passageId), target.username)) return null;
  const key = `wuliao:deep-translation:[object Object]:[object Object]:${target.paragraphNumber}:${target.sentenceIndex}`;
  const claimKey = `${key}:claimed`;
  if (getUserItem(claimKey, target.username)) return null;
  const text = getUserItem(key, target.username);
  return text?.trim() ? { key, claimKey, text } : null;
}

export function assertTranslationAccount(target) {
  if (getCurrentUsername() !== target.username) throw new Error("账号已切换，请重新打开当前句");
}

// Synchronous verified writes: the UI announces success only after all values
// can be read back. On quota/storage failure retain the previous translation.
export function saveConfirmedTranslation(target, { text, inkFingerprint = null, source = "ocr", legacy = null, expectedText } = {}) {
  assertTranslationAccount(target);
  const value = String(text || "").trim();
  if (!value) throw new Error("请先填写或校对译文");
  if (expectedText !== undefined && (getUserItem(target.storageKey, target.username) || "") !== expectedText) throw new Error("译文已在其他位置修改，请重新打开后校对");
  if (legacy && (getUserItem(legacy.key, target.username) !== legacy.text || getUserItem(legacy.claimKey, target.username))) throw new Error("旧译文已变更或已确认归属，请重新打开");
  const writes = [
    [target.metadataKey, JSON.stringify({ version: 1, sentence: target.sentence, source, inkFingerprint, confirmedAt: Date.now() })],
    [target.methodKey, "handwriting-transcribed"],
    [target.storageKey, value],
    ...(legacy ? [[legacy.claimKey, target.storageKey]] : []),
  ];
  const before = writes.map(([key]) => [key, getUserItem(key, target.username)]);
  try {
    for (const [key, next] of writes) {
      setUserItem(key, next, target.username);
      if (getUserItem(key, target.username) !== next) throw new Error("译文保存校验失败，请重试");
    }
  } catch (error) {
    for (const [key, previous] of before.reverse()) {
      try {
        if (previous === null) removeUserItem(key, target.username);
        else setUserItem(key, previous, target.username);
      } catch { /* Keep the draft open even if the underlying store is unavailable. */ }
    }
    throw new Error("译文未能完整保存，请保留当前草稿后重试", { cause: error });
  }
  return value;
}
