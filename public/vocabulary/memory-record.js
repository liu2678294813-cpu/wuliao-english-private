import { memoryProgress, memoryState } from "./memory-modes.js";

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// The same persisted projections are used by clicks, swipes, review, and bulk completion.
export function withMemoryProgress(previous, wordId, step, { username, listKey, now = Date.now() }) {
  const before = { ...previous };
  // A later learning/review action supersedes an old clear operation.
  delete before.clearUndo;
  const newlyCompleted = step === 5 && !memoryState(before).locked;
  const dates = new Set(Array.isArray(before.maskedDates) ? before.maskedDates.filter(Boolean) : []);
  if (!dates.size && before.maskedAt) dates.add(localDateKey(before.maskedAt));
  if (!dates.size && before.clickCount >= 3 && before.updatedAt) dates.add(localDateKey(before.updatedAt));
  if (newlyCompleted) dates.add(localDateKey(now));
  const count = Math.ceil(step / 2);
  return {
    ...before,
    memoryKey: `${username}:${listKey}:${wordId}`,
    username,
    listKey,
    wordId,
    legacyClickCount: before.legacyClickCount ?? before.clickCount ?? 0,
    sharedProgress: { count, masked: step % 2 === 1 },
    modeProgress: { default: step === 5 ? 1 : 0, cycle: step },
    clickCount: count,
    maskedAt: newlyCompleted ? now : before.maskedAt,
    maskedDates: [...dates],
    updatedAt: now,
  };
}

export function clearUndoEntries(records) {
  const restorable = [...records].filter((record) => {
    const undo = record.clearUndo;
    return undo && Number.isFinite(undo.batchId) && Number.isInteger(undo.step)
      && undo.step > 0 && undo.step <= 5 && undo.clearedAt === record.updatedAt
      && memoryProgress(record) === 0;
  });
  const latest = Math.max(...restorable.map((record) => record.clearUndo.batchId));
  return restorable.filter((record) => record.clearUndo.batchId === latest)
    .map((record) => ({ wordId: record.wordId, step: record.clearUndo.step, clearUndo: record.clearUndo }));
}
