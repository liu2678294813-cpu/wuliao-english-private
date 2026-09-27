// 普通完形（Cloze）手写笔迹存储适配器。
// namespace：wuliao:cloze-ink:v1:<resourceId>:<clozeId>
// 通过 getUserItem / setUserItem / removeUserItem 自然进入账号 scope 与备份枚举。
// 严禁写入 deep-ink / 普通 reader ink / exam-ink；与 clozeProgress / clozeFlow 完全隔离。
// 同一篇完形跨阶段（first-attempt → self-review → correction → analysis → final-read）
// 共享同一组 normalized strokes；D+1 / D+7 长期复习（ClozeReviewSession）不加载本数据。

import { getUserItem, removeUserItem, setUserItem } from "./userData";

export const CLOZE_INK_PREFIX = "wuliao:cloze-ink:v1:";

export function clozeInkKey(resourceId, clozeId) {
  return `${CLOZE_INK_PREFIX}${resourceId}:${clozeId}`;
}

export function loadClozeInk(resourceId, clozeId) {
  try {
    const parsed = JSON.parse(getUserItem(clozeInkKey(resourceId, clozeId)));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveClozeInk(resourceId, clozeId, strokes) {
  setUserItem(clozeInkKey(resourceId, clozeId), JSON.stringify(Array.isArray(strokes) ? strokes : []));
}

export function clearClozeInk(resourceId, clozeId) {
  removeUserItem(clozeInkKey(resourceId, clozeId));
}
