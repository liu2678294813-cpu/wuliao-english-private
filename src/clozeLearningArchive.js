// 完形长期学习档案（E 阶段）—— 纯派生 read model。
//
// 原则：
//   - 不创建第二套 clozeLearningArchive 事实存储。所有数据派生自：
//     clozeProgress (schemaVersion 2) + clozeReview sidecar +
//     clozeTranslationProgress + cloze-flow 完成记录。
//   - correctness 只由本地 officialAnswer 计算；无答案资料禁止任何
//     correct/wrong/accuracy/错题 等表述。
//   - basisTypes 是"用户使用的依据类别"，绝不是错误类型；统计措辞必须
//     说明是"复习目标中的分布"，不能输出"你的逻辑能力差"。
//   - AI diagnosis 不属于长期事实：档案中如需展示，只作为"AI 当时的推测"
//     链接回 AI history，不进入任何统计。
//   - 纯函数（buildClozeArchiveEntry 等）不读取存储：所有输入显式注入。

import { localDateKey } from "./readingReview";
import { deriveBlankResolved } from "./clozeReview";
import { summarizeClozeAttempts } from "./clozeProgress";
import { listUserItems } from "./userData";

const CLOZE_FLOW_PREFIX = "wuliao:cloze-flow:";

export function parseClozeFlowKey(rest) {
  if (!rest) return null;
  const separator = String(rest).indexOf(":");
  if (separator <= 0 || separator >= String(rest).length - 1) return null;
  return {
    resourceId: String(rest).slice(0, separator),
    clozeId: String(rest).slice(separator + 1),
  };
}

// 枚举已完成的完形训练记录（轻量：只读 flow key + stages）。
// 不做任何 backfill / 任务生成。
export function listCompletedClozeRecords(username) {
  const records = [];
  try {
    for (const { key, value } of listUserItems(CLOZE_FLOW_PREFIX, username)) {
      const ids = parseClozeFlowKey(String(key || "").slice(CLOZE_FLOW_PREFIX.length));
      if (!ids) continue;
      let flow = null;
      try {
        flow = JSON.parse(String(value || ""));
      } catch {
        flow = null;
      }
      if (!flow || typeof flow !== "object") continue;
      const completedAt = flow.stages?.["cloze-final-read"]?.completedAt;
      if (completedAt != null && Number.isFinite(Number(completedAt))) {
        records.push({
          resourceId: ids.resourceId,
          clozeId: ids.clozeId,
          completedAt: Number(completedAt),
          sourceDate: localDateKey(Number(completedAt)),
        });
      }
    }
  } catch {
    // 读取失败返回已有记录
  }
  records.sort((a, b) => b.completedAt - a.completedAt);
  return records;
}

// 在 review tasks 中查找与本次完成对应的 D+1 / D+7 任务。
// 优先匹配 sourceDate（同一篇可能完成多次），否则取最新。
export function findClozeReviewTasksForEntry(tasks, resourceId, clozeId, sourceDate) {
  const matches = (tasks || []).filter((task) => (
    String(task.resourceId || "") === String(resourceId || "")
    && String(task.clozeId || "") === String(clozeId || "")
  ));
  const d1 = matches.find((task) => task.type === "d1" && task.sourceDate === sourceDate)
    || matches.filter((task) => task.type === "d1").sort((a, b) => (b.sourceDate || "").localeCompare(a.sourceDate || ""))[0]
    || null;
  const d7 = matches.find((task) => task.type === "d7" && task.sourceDate === sourceDate)
    || matches.filter((task) => task.type === "d7").sort((a, b) => (b.sourceDate || "").localeCompare(a.sourceDate || ""))[0]
    || null;
  return { d1Task: d1, d7Task: d7 };
}

// 单篇完形的派生档案条目。officialAnswers 为空即无答案模式。
export function buildClozeArchiveEntry({
  progress,
  translationProgress,
  d1Task = null,
  d7Task = null,
  officialAnswers = {},
  completedAt = 0,
}) {
  const hasOfficial = Boolean(officialAnswers && Object.keys(officialAnswers).length > 0);
  const attempts = progress?.attempts || {};
  const blankIds = Object.keys(attempts).map(Number).sort((a, b) => a - b);
  const summary = summarizeClozeAttempts(progress, officialAnswers);

  let finalWrong = 0;
  let finalCorrect = 0;
  let changedCount = 0;
  for (const number of blankIds) {
    const attempt = attempts[number];
    const official = hasOfficial ? (officialAnswers[number] || officialAnswers[String(number)] || "") : "";
    const effective = attempt?.reviewAnswer || attempt?.firstAnswer || "";
    if (official && effective === official) finalCorrect += 1;
    else if (official && effective) finalWrong += 1;
    if (attempt?.firstAnswer && attempt?.reviewAnswer && attempt.firstAnswer !== attempt.reviewAnswer) {
      changedCount += 1;
    }
  }

  const d1TargetCount = (d1Task?.targetBlankIds || []).length;
  const d7TargetCount = (d7Task?.targetBlankIds || []).length;
  const d1CompletedCount = (d1Task?.targetBlankIds || []).filter((id) => d1Task?.attempts?.[id]).length;
  const d7CompletedCount = (d7Task?.targetBlankIds || []).filter((id) => d7Task?.attempts?.[id]).length;
  let d1ResolvedCount = 0;
  let d7UnresolvedCount = 0;
  for (const blankId of d1Task?.targetBlankIds || []) {
    if (deriveBlankResolved({ d1Task, d7Task, blankId: String(blankId), officialAnswers })) {
      d1ResolvedCount += 1;
    }
  }
  for (const blankId of d7Task?.targetBlankIds || []) {
    const attempt = d7Task?.attempts?.[blankId];
    const resolved = deriveBlankResolved({ d1Task, d7Task, blankId: String(blankId), officialAnswers });
    if (attempt && !resolved) d7UnresolvedCount += 1;
  }

  const reviewTimes = [];
  for (const task of [d1Task, d7Task]) {
    if (!task) continue;
    for (const attempt of Object.values(task.attempts || {})) {
      if (attempt?.reviewedAt) reviewTimes.push(Number(attempt.reviewedAt));
    }
  }
  const lastReviewedAt = reviewTimes.length ? Math.max(...reviewTimes) : null;

  const blanks = blankIds.map((number) => {
    const attempt = attempts[number] || {};
    const blankId = String(number);
    const official = hasOfficial ? (officialAnswers[number] || officialAnswers[blankId] || "") : "";
    const effective = attempt.reviewAnswer || attempt.firstAnswer || "";
    const d1Attempt = d1Task?.attempts?.[blankId] || null;
    const d7Attempt = d7Task?.attempts?.[blankId] || null;
    return {
      blankId,
      number,
      firstAnswer: attempt.firstAnswer || "",
      reviewAnswer: attempt.reviewAnswer || "",
      firstConfidence: attempt.firstConfidence || attempt.confidence || "",
      reviewConfidence: attempt.reviewConfidence || "",
      prediction: attempt.prediction || "",
      basisTypes: Array.isArray(attempt.basisTypes) ? attempt.basisTypes : [],
      referencesCount: Array.isArray(attempt.references) ? attempt.references.length : 0,
      finalCorrect: hasOfficial ? Boolean(official && effective === official) : null,
      finalWrong: hasOfficial ? Boolean(official && effective && effective !== official) : null,
      changed: Boolean(attempt.firstAnswer && attempt.reviewAnswer && attempt.firstAnswer !== attempt.reviewAnswer),
      inD1: Boolean(d1Task?.targetBlankIds?.map(String).includes(blankId)),
      d1Outcome: d1Attempt?.outcome || null,
      d1ReviewedAt: d1Attempt?.reviewedAt || null,
      inD7: Boolean(d7Task?.targetBlankIds?.map(String).includes(blankId)),
      d7Outcome: d7Attempt?.outcome || null,
      d7ReviewedAt: d7Attempt?.reviewedAt || null,
      resolved: d1Task?.targetBlankIds?.map(String).includes(blankId)
        ? deriveBlankResolved({ d1Task, d7Task, blankId, officialAnswers })
        : null,
    };
  });

  return {
    completedAt,
    hasOfficial,
    total: blankIds.length,
    counts: {
      firstCompleted: summary.firstCompleted,
      reviewCompleted: summary.reviewCompleted,
      firstCorrect: hasOfficial ? summary.firstCorrect : null,
      reviewCorrect: hasOfficial ? summary.reviewCorrect : null,
      changed: changedCount,
      selfCorrected: hasOfficial ? summary.selfCorrected : null,
      changedToWrong: hasOfficial ? summary.selfChangedToWrong : null,
      highConfidenceWrong: hasOfficial ? summary.confidentWrong : null,
      finalCorrect: hasOfficial ? finalCorrect : null,
      finalWrong: hasOfficial ? finalWrong : null,
      uncertain: summary.uncertain,
      guesses: summary.guesses,
    },
    translation: {
      corrected: (translationProgress?.sentences
        ? Object.values(translationProgress.sentences).filter((entry) => entry?.status === "corrected").length
        : 0),
      translated: (translationProgress?.sentences
        ? Object.values(translationProgress.sentences).filter((entry) => entry?.status === "translated").length
        : 0),
    },
    review: {
      d1TargetCount,
      d1CompletedCount,
      d1ResolvedCount,
      d7TargetCount,
      d7CompletedCount,
      d7UnresolvedCount,
      lastReviewedAt,
    },
    blanks,
  };
}

// basisTypes 在复习目标中的分布（措辞必须是"使用依据分布"，不是错误类型）。
export function basisDistributionInReviewTargets(entries) {
  const counts = {};
  let reviewedBlankCount = 0;
  for (const entry of entries) {
    if (!entry) continue;
    for (const blank of entry.blanks || []) {
      const inReview = blank.inD1 || blank.inD7;
      if (!inReview) continue;
      reviewedBlankCount += 1;
      for (const basis of blank.basisTypes || []) {
        counts[basis] = (counts[basis] || 0) + 1;
      }
    }
  }
  return {
    reviewedBlankCount,
    distribution: Object.entries(counts)
      .map(([basis, count]) => ({ basis, count }))
      .sort((a, b) => b.count - a.count || a.basis.localeCompare(b.basis, "zh")),
  };
}
