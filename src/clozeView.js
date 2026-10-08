// 完形正式学习视图模型（纯函数，不依赖 React）。
//
// 职责：
//   - 把 cloze 数据结构转成稳定的连续正文渲染模型（token / blank anchor）。
//   - 定义 B 阶段正式体验所需的数据语义：
//       · 阶段权限（初做/复查/订正各自允许做什么）
//       · 官方答案隔离（订正前 view model 中不存在 officialAnswer）
//       · priority 派生（订正前不读取官方答案）
//   - 订正阶段的结果对照（first/review/official 对比）。
//
// 内置完形与自定义 PDF 完形最终都进入同一个 ClozeReader，这里提供统一的
// resource adapter 契约：`resolveClozeSource(resource)` 返回
// `{ cloze, clozeId, isOfficial, year }`。

import { getClozeOfficialAnswerKey } from "./clozeAnswerKeys";
import { verifiedOfficialAnswers } from "./import/answers.js";
import {
  effectiveConfidence,
  listPostCorrectionPriorityBlankNumbers,
  listPreCorrectionPriorityBlankNumbers,
} from "./clozeProgress";

export const CLOZE_READER_STAGES = [
  "cloze-cover",
  "cloze-first-attempt",
  "cloze-self-review",
  "cloze-correction",
  "cloze-analysis",
  "cloze-final-read",
];

export function isCorrectionStage(stageId) {
  return stageId === "cloze-correction";
}

export function isAnalysisStage(stageId) {
  return stageId === "cloze-analysis";
}

export function isFinalReadStage(stageId) {
  return stageId === "cloze-final-read";
}

export function isPostCorrectionStage(stageId) {
  return isCorrectionStage(stageId) || isAnalysisStage(stageId) || isFinalReadStage(stageId);
}

export function isReviewStage(stageId) {
  return stageId === "cloze-self-review";
}

export function isFirstAttemptStage(stageId) {
  return stageId === "cloze-first-attempt";
}

export function isReaderStage(stageId) {
  return CLOZE_READER_STAGES.includes(stageId);
}

// 阶段门禁：只有当前阶段允许编辑答案；订正起才允许接触官方答案。
export function canEditAnswers(stageId) {
  return stageId === "cloze-first-attempt" || stageId === "cloze-self-review";
}

export function canEditFirstAnswers(stageId) {
  return stageId === "cloze-first-attempt";
}

export function canEditReviewAnswers(stageId) {
  return stageId === "cloze-self-review";
}

export function canSeeOfficialAnswers(stageId) {
  return isPostCorrectionStage(stageId);
}

// 连续正文渲染模型：paragraphs -> tokens，blank 带稳定 anchor。
// 不改变原始 cloze 数据，只在运行时生成视图模型（可安全 memoize）。
export function buildClozePassageTokens(cloze) {
  const paragraphs = Array.isArray(cloze?.paragraphs) ? cloze.paragraphs : [];
  const blankToParagraph = {};
  const blankToIndex = {};
  const rendered = paragraphs.map((paragraph, paragraphIndex) => {
    const segments = Array.isArray(paragraph?.segments) ? paragraph.segments : [];
    const tokens = segments.map((segment, segmentIndex) => {
      if (segment?.type === "blank") {
        const number = Number(segment.number) || 0;
        blankToParagraph[number] = paragraphIndex;
        blankToIndex[number] = segmentIndex;
        return {
          type: "blank",
          number,
          anchor: `cloze-blank-${number}`,
          missing: Boolean(segment.missing),
        };
      }
      return { type: "text", text: String(segment?.text ?? "") };
    });
    return { number: Number(paragraph?.number) || paragraphIndex + 1, tokens };
  });
  return { paragraphs: rendered, blankToParagraph, blankToIndex };
}

// 内置 vs 自定义完形资源适配。自定义完形永远没有官方答案。
export function resolveClozeSource(resource) {
  const isOfficial = resource?.kind === "official-cloze" || Boolean(resource?.clozeSource);
  const clozeId = resource?.clozeId || (isOfficial ? `cloze-${resource?.year || ""}` : resource?.id || "custom-cloze");
  let cloze = resource?.cloze || null;
  if (!cloze && isOfficial && resource?.clozeSource) {
    cloze = null; // 由调用方通过 loadOfficialCloze 异步加载
  }
  const year = Number(resource?.year) || Number(String(resource?.id || "").match(/\d{4}/)?.[1] || 0) || 0;
  return {
    isOfficial,
    clozeId,
    year,
    cloze,
  };
}

export function clozeBlankNumbers(cloze) {
  if (Array.isArray(cloze?.blanks) && cloze.blanks.length) {
    return cloze.blanks.map((blank) => Number(blank.number)).sort((a, b) => a - b);
  }
  const model = buildClozePassageTokens(cloze);
  return Object.keys(model.blankToParagraph).map(Number).sort((a, b) => a - b);
}

export function clozeOptionText(cloze, number, key) {
  const blank = (Array.isArray(cloze?.blanks) ? cloze.blanks : []).find((item) => Number(item.number) === number);
  return blank?.options?.find((option) => option.key === key)?.text || "";
}

// 官方答案：只在订正阶段调用；否则返回 null（调用方负责隔离）。
export function officialAnswerFor(
  stageId,
  resource,
  clozeId,
  isOfficial,
  answerResolver = getClozeOfficialAnswerKey,
) {
  if (!canSeeOfficialAnswers(stageId) || !isOfficial) return null;
  if (answerResolver === getClozeOfficialAnswerKey) return verifiedOfficialAnswers(resource, "cloze");
  const year = Number(resource?.year) || Number(String(resource?.id || "").match(/\d{4}/)?.[1] || 0);
  return answerResolver({ year, clozeId });
}

// 单空结果对照（订正阶段专用）。不依赖官方答案的字段在订正前也可用。
export function buildBlankCorrectionRow(attempt, officialAnswer = "") {
  if (!attempt) return null;
  const first = attempt.firstAnswer || "";
  const review = attempt.reviewAnswer || "";
  const firstCorrect = officialAnswer ? first === officialAnswer : null;
  const reviewCorrect = officialAnswer ? review === officialAnswer : null;
  const changed = Boolean(first && review && first !== review);
  return {
    number: attempt.number,
    first,
    review,
    official: officialAnswer || "",
    firstConfidence: attempt.firstConfidence || attempt.confidence || "",
    reviewConfidence: attempt.reviewConfidence || "",
    firstCorrect,
    reviewCorrect,
    changed,
    effectiveConfidence: effectiveConfidence(attempt),
  };
}

// 订正阶段汇总（正确率等）。官方答案为 {} 时正确项为 0，仅用于无官方答案的自定义资料。
export function summarizeCorrection(progress, officialAnswers = {}) {
  const attempts = progress?.attempts || {};
  const rows = Object.keys(attempts)
    .map(Number)
    .sort((a, b) => a - b)
    .map((number) => buildBlankCorrectionRow(attempts[number], officialAnswers[number] || officialAnswers[String(number)]))
    .filter(Boolean);
  const officialCount = Object.keys(officialAnswers || {}).length;
  const firstCorrect = rows.filter((row) => row.firstCorrect === true).length;
  const reviewCorrect = rows.filter((row) => row.reviewCorrect === true).length;
  return {
    total: rows.length,
    firstCompleted: rows.filter((row) => row.first).length,
    reviewCompleted: rows.filter((row) => row.review).length,
    firstCorrect,
    reviewCorrect,
    changed: rows.filter((row) => row.changed).length,
    hasOfficial: officialCount > 0,
    accuracy: officialCount ? `${reviewCorrect}/${officialCount}` : "—",
    rows,
  };
}

// 当前 priority 列表：订正前用无官方答案版本，订正后用含答案版本。
export function priorityBlankNumbers(progress, stageId, officialAnswers = null) {
  if (!progress) return [];
  if (isPostCorrectionStage(stageId)) {
    return listPostCorrectionPriorityBlankNumbers(progress, officialAnswers || {});
  }
  return listPreCorrectionPriorityBlankNumbers(progress);
}

export function effectiveClozeAnswer(attempt, stageId) {
  if (!attempt) return "";
  if (isReviewStage(stageId)) return attempt.reviewAnswer || "";
  if (isPostCorrectionStage(stageId)) return attempt.reviewAnswer || attempt.firstAnswer || "";
  return attempt.firstAnswer || "";
}

export function effectiveClozeConfidence(attempt, stageId) {
  if (!attempt) return "";
  if (isReviewStage(stageId)) return attempt.reviewConfidence || "";
  if (isPostCorrectionStage(stageId)) {
    return attempt.reviewConfidence || attempt.firstConfidence || attempt.confidence || "";
  }
  return attempt.firstConfidence || attempt.confidence || "";
}

export function buildClozeFinalReadModel(cloze, progress, officialAnswers = {}, hasOfficial = false) {
  const paragraphs = (Array.isArray(cloze?.paragraphs) ? cloze.paragraphs : []).map((paragraph, paragraphIndex) => ({
    number: Number(paragraph?.number) || paragraphIndex + 1,
    tokens: (Array.isArray(paragraph?.segments) ? paragraph.segments : []).map((segment, segmentIndex, segments) => {
      if (segment?.type !== "blank") return { type: "text", text: String(segment?.text ?? "") };
      const number = Number(segment.number) || 0;
      const attempt = progress?.attempts?.[number];
      const answerKey = hasOfficial
        ? officialAnswers[number] || officialAnswers[String(number)] || ""
        : attempt?.reviewAnswer || attempt?.firstAnswer || "";
      const previousText = segments[segmentIndex - 1]?.type === "text"
        ? String(segments[segmentIndex - 1]?.text ?? "")
        : "";
      const nextText = segments[segmentIndex + 1]?.type === "text"
        ? String(segments[segmentIndex + 1]?.text ?? "")
        : "";
      return {
        type: "answer",
        number,
        answerKey,
        text: answerKey ? clozeOptionText(cloze, number, answerKey) : "",
        leadingSpace: Boolean(previousText && !/\s$/.test(previousText)),
        trailingSpace: Boolean(nextText && !/^\s/.test(nextText) && !/^[,.;:!?%…\)\]\}’”]/.test(nextText)),
      };
    }),
  }));
  return { paragraphs, hasOfficial };
}

// 供订正阶段比较 first -> review 的语义标签。
export function changeLabel(attempt) {
  if (!attempt) return "";
  const first = attempt.firstAnswer || "";
  const review = attempt.reviewAnswer || "";
  if (!first && !review) return "未作答";
  if (first && !review) return "复查未填";
  if (!first && review) return "复查补填";
  if (first === review) return "保持原答案";
  return `改答 ${first} → ${review}`;
}
