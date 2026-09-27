// 完形本篇学习结果 + 长期档案总览（R6）—— 纯派生 view model。
//
// 原则：
//   - 不创建第二套事实存储。所有数据派生自 cloze-flow / clozeProgress /
//     clozeReview sidecar / clozeTranslationProgress / unknown-words /
//     本地 officialAnswer（如存在）。
//   - 复用 buildClozeArchiveEntry / summarizeClozeAttempts /
//     deriveBlankResolved / clozeReviewTaskStatus，不在 summary / UI 层
//     重复实现既有算法。
//   - correctness 只存在于 hasOfficial 数据；无答案资料禁止出现
//     正确/错误/错题/正确率/高置信错误/改答后错 等表述。
//   - AI history 只按稳定 metadata（sourceType=cloze + resourceId +
//     clozeId + blankNumber）确定性索引并链接，不进入任何统计 / resolved /
//     调度；旧记录无 metadata 一律不关联。
//   - 纯函数不读取存储：所有输入显式注入。

import { effectiveConfidence } from "./clozeProgress";
import { clozeReviewTaskStatus } from "./clozeReview";
import { buildClozeArchiveEntry } from "./clozeLearningArchive";

export const CLOZE_AI_SOURCE_TYPE = "cloze";

export const CLOZE_REVIEW_REASON_LABELS = {
  "high-confidence-wrong": "高置信错误",
  "changed-to-wrong": "改答后错",
  "final-wrong": "最终仍错",
  "self-corrected": "自查纠正",
  "changed-answer": "改答",
  guess: "猜测",
  uncertain: "犹豫",
  "d1-wrong": "D+1 仍错",
  "d1-low-confidence": "D+1 低置信",
  "d1-changed": "D+1 改答",
  "d1-self-rating-unstable": "D+1 自评不稳",
  "d7-confirmation": "高置信错误复查",
  "translation-unresolved": "译文未订正",
  "answerless-changed": "改答",
  "answerless-low-confidence": "低置信",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function clozeRangeStart(range, now = Date.now()) {
  if (range === "all") return 0;
  if (range === "7d") return now - 7 * DAY_MS;
  return now - 30 * DAY_MS;
}

export function clozeYearOfResourceId(resourceId) {
  const match = String(resourceId || "").match(/\d{4}/);
  const resource = Number(match ? match[0] : 0);
  return Number.isInteger(resource) && resource >= 1900 ? resource : null;
}

function blankEffectiveConfidence(blank) {
  return effectiveConfidence({
    firstConfidence: blank?.firstConfidence || "",
    reviewConfidence: blank?.reviewConfidence || "",
    confidence: blank?.firstConfidence || "",
  });
}

function translatedCount(translationProgress) {
  const sentences = translationProgress?.sentences || {};
  return Object.values(sentences).filter((entry) => entry?.status === "translated").length;
}

function correctedCount(translationProgress) {
  const sentences = translationProgress?.sentences || {};
  return Object.values(sentences).filter((entry) => entry?.status === "corrected").length;
}

// ---------------- AI history 索引（确定性，无 fuzzy match） ----------------

// 只索引带稳定 cloze metadata 的记录。返回 Map<"resourceId|clozeId|blank", links[]>。
// reading / 自由提问 / 无 metadata 的旧记录不会进入索引。
export function indexClozeAiHistory(records) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const meta = record?.metadata;
    if (!meta || typeof meta !== "object" || String(meta.sourceType || "") !== CLOZE_AI_SOURCE_TYPE) continue;
    const resourceId = String(meta.resourceId || "");
    const clozeId = String(meta.clozeId || "");
    const blankNumber = Number(meta.blankNumber);
    if (!resourceId || !clozeId || !Number.isInteger(blankNumber) || blankNumber < 1) continue;
    if (!record?.id) continue;
    const key = `${resourceId}|${clozeId}|${blankNumber}`;
    const list = map.get(key) || [];
    list.push({
      id: String(record.id),
      taskType: String(meta.taskType || record.kind || ""),
      name: String(record.name || ""),
      createdAt: Number(record.createdAt) || 0,
      updatedAt: Number(record.updatedAt) || 0,
    });
    map.set(key, list);
  }
  for (const list of map.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return map;
}

export function aiHistoryKey(resourceId, clozeId, blankNumber) {
  return `${String(resourceId || "")}|${String(clozeId || "")}|${Number(blankNumber) || 0}`;
}

// ---------------- 单篇学习结果 ----------------

// 输入全部显式注入。resource 只用于标题 / 年份；officialAnswers 为空即无答案模式。
// resourceId 为显式身份回退：resource 无法解析（如自定义资料读取失败）时仍能
// 保持确定性 identity（AI history 关联 / 陌生词聚合不丢失）。
export function buildClozeLearningSummary({
  resource = null,
  resourceId: resourceIdProp = "",
  clozeId = "",
  completedAt = 0,
  progress = null,
  translationProgress = null,
  d1Task = null,
  d7Task = null,
  officialAnswers = {},
  unknownWords = [],
  aiHistoryRecords = [],
  today = "",
}) {
  const resourceId = String(resource?.id || resourceIdProp || "");
  const entry = buildClozeArchiveEntry({
    progress,
    translationProgress,
    d1Task,
    d7Task,
    officialAnswers,
    completedAt,
  });
  const hasOfficial = entry.hasOfficial;
  const attempts = progress?.attempts || {};
  const blanksWithNumbers = Object.keys(attempts).map(Number).sort((a, b) => a - b);
  const aiIndex = indexClozeAiHistory(aiHistoryRecords);
  const aiKeyOf = (blankNumber) => aiHistoryKey(resourceId, clozeId, blankNumber);

  const analysis = {
    total: blanksWithNumbers.length,
    analyzed: blanksWithNumbers.filter((number) => attempts[number]?.analyzed === true).length,
    predictions: blanksWithNumbers.filter((number) => String(attempts[number]?.prediction || "").trim()).length,
    withBasis: blanksWithNumbers.filter((number) => (attempts[number]?.basisTypes || []).length > 0).length,
    withReferences: blanksWithNumbers.filter((number) => (attempts[number]?.references || []).length > 0).length,
    translation: {
      translated: translatedCount(translationProgress),
      corrected: correctedCount(translationProgress),
    },
  };

  const confidence = {
    confident: blanksWithNumbers.filter((number) => effectiveConfidence(attempts[number]) === "confident").length,
    uncertain: blanksWithNumbers.filter((number) => effectiveConfidence(attempts[number]) === "uncertain").length,
    guesses: blanksWithNumbers.filter((number) => effectiveConfidence(attempts[number]) === "guess").length,
  };

  const clozeUnknownWords = (Array.isArray(unknownWords) ? unknownWords : []).filter((word) => (
    String(word?.sourceType || "") === CLOZE_AI_SOURCE_TYPE
    && String(word?.resourceId || "") === resourceId
    && String(word?.clozeId || "") === String(clozeId || resourceId)
  ));

  const item = {
    record: { resourceId, clozeId, completedAt, sourceDate: "" },
    entry,
    d1Task,
    d7Task,
    title: resource?.title || resourceId,
    year: resource?.year || clozeYearOfResourceId(resourceId),
    officialAnswers,
  };

  const review = buildClozeReviewView(entry, d1Task, d7Task, today);
  const priorityReview = buildClozePriorityReviewItems([item], { today });

  const blanks = entry.blanks.map((blank) => {
    const official = hasOfficial ? (officialAnswers[blank.number] || officialAnswers[blank.blankId] || "") : "";
    const first = blank.firstAnswer;
    const review = blank.reviewAnswer;
    return {
      ...blank,
      officialAnswer: hasOfficial ? official : "",
      changedToWrong: hasOfficial
        ? Boolean(first && review && first !== review && first === official && review !== official)
        : null,
      selfCorrected: hasOfficial
        ? Boolean(first && review && first !== review && first !== official && review === official)
        : null,
      highConfidenceWrong: hasOfficial
        ? Boolean(blank.finalWrong && blankEffectiveConfidence(blank) === "confident")
        : null,
      aiHistory: aiIndex.get(aiKeyOf(blank.number)) || [],
    };
  });

  const aiTotal = blanks.reduce((sum, blank) => sum + blank.aiHistory.length, 0);

  return {
    resourceId,
    clozeId,
    title: item.title,
    year: item.year,
    completedAt,
    hasOfficial,
    counts: entry.counts,
    confidence,
    translation: entry.translation,
    analysis,
    unknownWords: {
      count: clozeUnknownWords.length,
      items: clozeUnknownWords,
    },
    review,
    priorityReview,
    blanks,
    aiHistoryTotal: aiTotal,
  };
}

function buildClozeReviewView(entry, d1Task, d7Task, today = "") {
  const r = entry.review;
  const viewD1 = taskView(d1Task, r.d1TargetCount, r.d1CompletedCount, r.d1ResolvedCount, today);
  const viewD7 = taskView(d7Task, r.d7TargetCount, r.d7CompletedCount, r.d7TargetCount - r.d7UnresolvedCount, today);
  const inReviewBlanks = entry.blanks.filter((blank) => blank.inD1 || blank.inD7);
  const longTermStable = inReviewBlanks.filter((blank) => blank.resolved === true).length;
  return {
    d1: viewD1,
    d7: viewD7,
    longTerm: {
      total: inReviewBlanks.length,
      stable: longTermStable,
      unstable: inReviewBlanks.length - longTermStable,
      lastReviewedAt: r.lastReviewedAt,
    },
  };
}

function taskView(task, targetCount, completedCount, resolvedCount, today = "") {
  if (!task) {
    return {
      exists: false,
      task: null,
      taskKey: "",
      taskType: "",
      status: "none",
      dueDate: "",
      targetCount: 0,
      completedCount: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
    };
  }
  const status = today ? clozeReviewTaskStatus(task, today) : clozeReviewTaskStatus(task);
  return {
    exists: true,
    task,
    taskKey: task.taskKey,
    taskType: task.type,
    status,
    dueDate: String(task.dueDate || ""),
    targetCount,
    completedCount,
    resolvedCount,
    unresolvedCount: Math.max(0, targetCount - resolvedCount),
  };
}

// ---------------- 长期档案总览 / 筛选 / 优先复盘 ----------------

// 每个 item 的形状（档案 modal 统一构建）：
//   { record: { resourceId, clozeId, completedAt, sourceDate },
//     entry: buildClozeArchiveEntry(...), d1Task, d7Task, title, year, officialAnswers }
export function filterClozeArchiveEntries(items, { range = "all", status = "all", year = "all", now = Date.now() } = {}) {
  const source = Array.isArray(items) ? items : [];
  const rangeStart = clozeRangeStart(range, now);
  return source.filter((item) => {
    if (Number(item.record?.completedAt) < rangeStart) return false;
    if (year !== "all") {
      const itemYear = Number(item.year) || null;
      if (year === "custom") {
        if (itemYear != null) return false;
      } else if (itemYear !== Number(year)) {
        return false;
      }
    }
    if (status === "all") return true;
    const entry = item.entry;
    if (status === "pending-review") {
      return [item.d1Task, item.d7Task].some((task) => (
        ["due", "overdue", "in_progress"].includes(clozeReviewTaskStatus(task))
      ));
    }
    if (status === "unresolved") {
      return (entry?.blanks || []).some((blank) => (blank.inD1 || blank.inD7) && blank.resolved === false);
    }
    if (status === "high-confidence-wrong") {
      return Boolean(entry?.hasOfficial && entry.counts?.highConfidenceWrong > 0);
    }
    if (status === "changed-to-wrong") {
      return Boolean(entry?.hasOfficial && entry.counts?.changedToWrong > 0);
    }
    return true;
  });
}

// 总览指标。correctness 聚合分母只含 hasOfficial 记录；无官方资料时不产生
// correctness 指标。resolved 按各自规则跨两种资料聚合为"长期已稳定"。
export function buildClozeArchiveOverview(items, { range = "all", now = Date.now() } = {}) {
  const filtered = filterClozeArchiveEntries(items, { range, now });
  const overview = {
    range,
    completedCount: filtered.length,
    awaitingReviewCount: 0,
    unstableBlankCount: 0,
    selfCorrectedCount: 0,
    highConfidenceWrongCount: 0,
    changedToWrongCount: 0,
    official: {
      present: false,
      entryCount: 0,
      finalCorrectTotal: 0,
      finalWrongTotal: 0,
    },
    longTerm: { stable: 0, total: 0 },
    d1: { stable: 0, target: 0 },
    d7: { stable: 0, target: 0 },
    translationCorrected: 0,
    lastReviewedAt: null,
  };
  for (const item of filtered) {
    const entry = item.entry;
    if (!entry) continue;
    if ([item.d1Task, item.d7Task].some((task) => (
      ["due", "overdue", "in_progress"].includes(clozeReviewTaskStatus(task))
    ))) overview.awaitingReviewCount += 1;
    for (const blank of entry.blanks || []) {
      if ((blank.inD1 || blank.inD7) && blank.resolved === false) overview.unstableBlankCount += 1;
    }
    overview.selfCorrectedCount += entry.counts.selfCorrected || 0;
    overview.translationCorrected += entry.translation?.corrected || 0;
    if (entry.hasOfficial) {
      overview.highConfidenceWrongCount += entry.counts.highConfidenceWrong || 0;
      overview.changedToWrongCount += entry.counts.changedToWrong || 0;
      overview.official.present = true;
      overview.official.entryCount += 1;
      overview.official.finalCorrectTotal += entry.counts.finalCorrect || 0;
      overview.official.finalWrongTotal += entry.counts.finalWrong || 0;
    }
    overview.longTerm.stable += entry.blanks.filter((blank) => blank.resolved === true).length;
    overview.longTerm.total += entry.blanks.filter((blank) => blank.inD1 || blank.inD7).length;
    overview.d1.stable += entry.review.d1ResolvedCount;
    overview.d1.target += entry.review.d1TargetCount;
    overview.d7.stable += Math.max(0, entry.review.d7TargetCount - entry.review.d7UnresolvedCount);
    overview.d7.target += entry.review.d7TargetCount;
    if (entry.review.lastReviewedAt != null) {
      overview.lastReviewedAt = Math.max(overview.lastReviewedAt ?? 0, entry.review.lastReviewedAt);
    }
  }
  return overview;
}

// 最近 7 天紧凑事实（R6 只做复盘，不做 analytics）。
export function buildClozeRecent7(items, { now = Date.now() } = {}) {
  const week = filterClozeArchiveEntries(items, { range: "7d", now });
  let d1BlankCount = 0;
  let d7BlankCount = 0;
  let unstableBlankCount = 0;
  for (const item of week) {
    const entry = item.entry;
    if (!entry) continue;
    d1BlankCount += entry.review.d1TargetCount;
    d7BlankCount += entry.review.d7TargetCount;
    for (const blank of entry.blanks || []) {
      if ((blank.inD1 || blank.inD7) && blank.resolved === false) unstableBlankCount += 1;
    }
  }
  return {
    completedCount: week.length,
    d1BlankCount,
    d7BlankCount,
    unstableBlankCount,
  };
}

// 优先复盘列表：严格基于事实派生，不使用 AI diagnosis，不用 basisTypes 推断
// 能力弱点。排序确定性：D+7 未稳定 > 需要行动的复习 > D+1 未稳定 >
// 高置信错误 > 改答后错 > 译文未订正；同级按最后复习时间新近 / 空号升序。
export function buildClozePriorityReviewItems(items, { today = "" } = {}) {
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const entry = item.entry;
    if (!entry) continue;
    const resourceId = String(item.record?.resourceId || "");
    const clozeId = String(item.record?.clozeId || "");
    const sourceDate = String(item.record?.sourceDate || "");
    const title = item.title || resourceId;
    const base = { resourceId, clozeId, sourceDate, title, record: item.record };

    const taskStatusOf = (task) => (today ? clozeReviewTaskStatus(task, today) : clozeReviewTaskStatus(task));
    const d7Task = item.d7Task;
    const d1Task = item.d1Task;
    const lastOf = (task) => {
      let last = null;
      for (const attempt of Object.values(task?.attempts || {})) {
        if (attempt?.reviewedAt != null) last = Math.max(last ?? 0, Number(attempt.reviewedAt));
      }
      return last;
    };
    const reasonsOf = (task, blankId) => {
      const reasons = Array.isArray(task?.targetReasons?.[blankId]) ? task.targetReasons[blankId] : [];
      return [...new Set(reasons.map(String).filter(Boolean))];
    };
    const blankOf = (blankId) => entry.blanks.find((blank) => String(blank.blankId) === String(blankId));

    const pushBlank = ({ blankId, reasons, tier, statusKey, task, lastReviewedAt = null }) => {
      const deduped = [...new Set((reasons || []).map(String).filter(Boolean))];
      if (!deduped.length) return;
      result.push({
        key: `${resourceId}:${clozeId}:${sourceDate}:blank:${blankId}`,
        kind: "blank",
        blankId: Number(blankId),
        reasons: deduped,
        tier,
        statusKey,
        lastReviewedAt,
        taskKey: task?.taskKey || "",
        taskType: task?.type || "",
        ...base,
      });
    };

    // Tier 1：D+7 已进入且仍未稳定。
    if (d7Task) {
      for (const blankId of d7Task.targetBlankIds || []) {
        const blank = blankOf(blankId);
        if (!blank || blank.resolved !== false) continue;
        const reasons = [
          ...reasonsOf(d7Task, blankId),
          ...reasonsOf(d1Task, blankId),
          "d7-unresolved",
        ];
        pushBlank({ blankId, reasons, tier: 1, statusKey: "d7-unresolved", task: d7Task, lastReviewedAt: lastOf(d7Task) });
      }
    }

    // Tier 2：overdue / due / in_progress 的复习任务（行动优先）。
    for (const task of [d1Task, d7Task]) {
      if (!task) continue;
      const status = taskStatusOf(task);
      if (!["overdue", "due", "in_progress"].includes(status)) continue;
      for (const blankId of task.targetBlankIds || []) {
        const attempt = task.attempts?.[blankId];
        if (attempt && blankOf(blankId)?.resolved === true) continue;
        const reasons = [...reasonsOf(task, blankId), `task-${status}`];
        pushBlank({ blankId, reasons, tier: 2, statusKey: `task-${status}`, task, lastReviewedAt: lastOf(task) });
      }
    }

    // Tier 3：D+1 已复习但仍未稳定，且未进入 D+7。
    if (d1Task && !d7Task) {
      for (const blankId of d1Task.targetBlankIds || []) {
        const blank = blankOf(blankId);
        if (!blank || blank.resolved !== false || !d1Task.attempts?.[blankId]) continue;
        pushBlank({
          blankId,
          reasons: [...reasonsOf(d1Task, blankId), "d1-unresolved"],
          tier: 3,
          statusKey: "d1-unresolved",
          task: d1Task,
          lastReviewedAt: lastOf(d1Task),
        });
      }
    }

    // Tier 4/5：有官方答案的当天风险事实（未进入长期任务也显示）。
    if (entry.hasOfficial) {
      for (const blank of entry.blanks || []) {
        if (blank.inD1 || blank.inD7) continue;
        const confident = blankEffectiveConfidence(blank) === "confident";
        if (blank.finalWrong && confident) {
          pushBlank({ blankId: blank.blankId, reasons: ["high-confidence-wrong"], tier: 4, statusKey: "high-confidence-wrong" });
        } else if (blank.finalWrong) {
          pushBlank({ blankId: blank.blankId, reasons: ["final-wrong"], tier: 5, statusKey: "final-wrong" });
        }
      }
    }

    // Tier 6：译文未订正（task 快照中带 translation-unresolved 的空）。
    for (const task of [d7Task, d1Task]) {
      if (!task) continue;
      for (const blankId of task.targetBlankIds || []) {
        const reasons = reasonsOf(task, blankId);
        if (!reasons.includes("translation-unresolved")) continue;
        const key = `${resourceId}:${clozeId}:${sourceDate}:blank:${blankId}`;
        if (result.some((item) => item.key === key)) continue;
        pushBlank({ blankId, reasons: ["translation-unresolved"], tier: 6, statusKey: "translation-unresolved", task });
      }
    }
  }

  result.sort((a, b) => (
    a.tier - b.tier
    || (b.lastReviewedAt ?? 0) - (a.lastReviewedAt ?? 0)
    || a.blankId - b.blankId
    || a.resourceId.localeCompare(b.resourceId)
    || a.clozeId.localeCompare(b.clozeId)
  ));
  return result;
}
