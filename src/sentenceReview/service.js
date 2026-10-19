import { getCurrentUsername, getUserItem } from "../userData.js";
import { listDifficultSources, listLearnedSources, sourceReviewIdFor } from "../longSentence/source.js";
import { loadTranslationProgress, saveTranslationProgress, setReviewStatus } from "../translationProgress.js";
import { listReviewTasks, localDateKey, ensureWarehouseReviewTask, markOriginalSentenceLearned,
  updateReviewSession, completeReviewSession, reconcileOriginalSentenceCompletions } from "../readingReview.js";
import { translationTextKey } from "../deepReaderKeys.js";
import { listAiHistory } from "../ai.js";
import { assertOwner, listAttempts, openAttempt, readAttempt, updateAttempt } from "./repository.js";

export function baselineFor(source) {
  const entry = loadTranslationProgress(source.resourceId, source.passageId).sentences[source.sentenceKey];
  return entry ? { translationStatus: entry.translationStatus, reviewStatus: entry.reviewStatus,
    reviewedAt: entry.reviewedAt, correctedAt: entry.correctedAt, translationFingerprint: entry.translationFingerprint } : null;
}

export async function listWarehouseSources({ username = getCurrentUsername(), attempts, ...options } = {}) {
  assertOwner(username);
  const [pending, learned, history] = await Promise.all([
    listDifficultSources(options), listLearnedSources(options), attempts ?? listAttempts(username),
  ]);
  assertOwner(username);
  const snapshots = new Map();
  for (const attempt of history) if (!snapshots.has(attempt.sourceReviewId)) snapshots.set(attempt.sourceReviewId, attempt.source);
  const tasks = listReviewTasks(username).filter(task => task.completedAt == null && task.skippedAt == null);
  const output = new Map();
  for (const [items, section] of [[learned, "learned"], [pending, "pending"]]) {
    for (const item of items) {
      const ref = item.sourceRef || item;
      const id = sourceReviewIdFor(ref);
      const snapshot = snapshots.get(id);
      const source = { ...snapshot, ...ref, ...item, sourceReviewId: id, section };
      source.text ||= snapshot?.text || item.sourceSnapshot?.text || "";
      source.resourceTitle ||= snapshot?.resourceTitle || "来源暂不可用";
      const state = baselineFor(source);
      source.markedAt = state?.reviewedAt || 0;
      source.dueDate = tasks.filter(task => task.resourceId === source.resourceId && task.passageId === source.passageId
        && task.sentenceKeys.includes(source.sentenceKey) && !task.taskKey.includes(":warehouse:"))
        .map(task => task.dueDate).sort()[0] || "";
      // Warehouse followups count; the current attempt's own task does not.
      const followup = tasks.filter(task => task.resourceId === source.resourceId && task.passageId === source.passageId
        && task.sentenceKeys.includes(source.sentenceKey) && task.taskKey.endsWith(":followup")).map(task => task.dueDate).sort()[0];
      if (followup && (!source.dueDate || followup < source.dueDate)) source.dueDate = followup;
      output.set(id, source);
    }
  }
  // Keep saved exercises inspectable even if their source was removed/edited.
  for (const [id, snapshot] of snapshots) {
    if (!output.has(id)) output.set(id, { ...snapshot, sourceReviewId: id, section: "pending",
      status: "source_unavailable", error: "原句资料或学习状态已变化，历史练习保留，当前不能提交结果" });
  }
  const today = localDateKey();
  return [...output.values()].sort((a, b) => {
    const aDue = a.dueDate && a.dueDate <= today ? a.dueDate : "9999";
    const bDue = b.dueDate && b.dueDate <= today ? b.dueDate : "9999";
    return aDue.localeCompare(bDue) || (b.learnedAt || b.markedAt || 0) - (a.learnedAt || a.markedAt || 0)
      || a.sourceReviewId.localeCompare(b.sourceReviewId);
  });
}

export function beginAttempt(username, source, inputMode) {
  assertOwner(username);
  const baseline = baselineFor(source);
  if (baseline?.reviewStatus !== "needs_review") throw new Error("原句已不在需复盘状态，请刷新仓库");
  return openAttempt(username, source, baseline, inputMode);
}

export function originalRecords(source, username) {
  assertOwner(username);
  const translation = getUserItem(translationTextKey(source.resourceId, source.passageId, source.paragraphNumber, source.sentenceIndex), username) || "";
  const records = [];
  for (const record of listAiHistory()) for (const message of record.messages || []) {
    const meta = message.reviewMeta;
    if (meta?.resourceId === source.resourceId && meta.passageId === source.passageId
      && meta.sentenceId?.endsWith(`::p${source.paragraphNumber}s${source.sentenceIndex + 1}`)
      && String(meta.sentence || "").replace(/\s+/g, " ").trim().toLowerCase() === source.text.replace(/\s+/g, " ").trim().toLowerCase()
      && message.structured) records.push({ id: record.id, updatedAt: record.updatedAt, result: message.structured, userTranslation: meta.userTranslation });
  }
  return { translation, reviews: records.sort((a, b) => b.updatedAt - a.updatedAt) };
}

export async function finishAttempt(username, attemptId, verdict) {
  assertOwner(username);
  if (!["mastered", "difficult"].includes(verdict)) throw new Error("请选择复盘结果");
  let attempt = await readAttempt(username, attemptId);
  if (attempt.status === "completed") {
    if (attempt.verdict !== verdict) throw new Error("本轮已经完成，请开始新一轮");
    return attempt;
  }
  if (attempt.status === "committing" && attempt.verdict !== verdict) throw new Error("请先重试保存本轮已选结果");
  if (attempt.status === "committing") {
    const ensured = ensureWarehouseReviewTask({ source: attempt.source, attemptId: attempt.id, username, now: attempt.resultAt });
    if (!ensured.ok) throw new Error(ensured.error);
    const recovery = reconcileOriginalSentenceCompletions(ensured.task.taskKey, username);
    if (!recovery.ok) throw new Error(recovery.error);
  }
  const fresh = (await listWarehouseSources({ username, attempts: [] })).find(source => source.sourceReviewId === attempt.sourceReviewId);
  if (fresh?.status !== "resolved" || fresh.textFingerprint !== attempt.source.textFingerprint) throw new Error("原句来源已变化，结果未写回，练习仍保留");
  assertOwner(username);
  if (attempt.status === "draft") {
    if (JSON.stringify(baselineFor(attempt.source)) !== JSON.stringify(attempt.baseline)) throw new Error("原句学习状态已变化，不能覆盖，请刷新仓库");
    attempt = await updateAttempt(username, attempt.id, attempt.revision, () => ({ status: "committing", verdict, resultAt: Date.now() }));
  }
  const ensured = ensureWarehouseReviewTask({ source: attempt.source, attemptId: attempt.id, username, now: attempt.resultAt });
  if (!ensured.ok) throw new Error(ensured.error);
  const task = ensured.task;
  if (verdict === "mastered" && task.completedAt == null) {
    const source = attempt.source;
    const saved = markOriginalSentenceLearned(task.taskKey, { key: source.sentenceKey, sentenceText: source.text,
      paragraphNumber: source.paragraphNumber, sentenceIndex: source.sentenceIndex }, attempt.resultAt, username);
    if (!saved.ok) throw new Error(saved.error);
  } else if (verdict === "difficult") {
    if (JSON.stringify(baselineFor(attempt.source)) !== JSON.stringify(attempt.baseline)) throw new Error("原句学习状态已变化，不能覆盖");
    const future = ensureWarehouseReviewTask({ source: attempt.source, attemptId: attempt.id, followup: true, now: attempt.resultAt, username });
    if (!future.ok) throw new Error(future.error);
    const saved = updateReviewSession(task.taskKey, { sentenceResults: { [attempt.source.sentenceKey]: "difficult" } }, attempt.resultAt, username);
    if (!saved.ok) throw new Error(saved.error);
  }
  if (task.completedAt == null) {
    const completed = completeReviewSession(task.taskKey, { reviewedSentenceKeys: [attempt.source.sentenceKey],
      masteredCount: verdict === "mastered" ? 1 : 0, difficultCount: verdict === "difficult" ? 1 : 0 }, attempt.resultAt, username);
    if (!completed.ok) throw new Error(completed.error);
  }
  return updateAttempt(username, attempt.id, attempt.revision, () => ({ status: "completed", completedAt: attempt.resultAt }));
}

export async function requeueSource(username, source) {
  assertOwner(username);
  // Validate again rather than trusting a stale card or historical snapshot.
  const current = (await listWarehouseSources({ username, attempts: [] })).find(item => item.sourceReviewId === source.sourceReviewId);
  assertOwner(username);
  if (current?.status !== "resolved" || current.section !== "learned") throw new Error("原句状态已变化，请刷新仓库");
  const progress = loadTranslationProgress(source.resourceId, source.passageId);
  const next = setReviewStatus(progress, source.sentenceKey, "needs_review");
  if (next === progress || !saveTranslationProgress(next)) throw new Error("重新加入复盘保存失败，请重试");
  return { ...current, section: "pending" };
}
