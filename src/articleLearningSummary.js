import { isPendingTag, isReliableTag } from "./aiLearningStats";
import { TASK_QUESTION_DIAGNOSIS, TASK_TRANSLATION_REVIEW } from "./aiTasks";
import { STAGE_LABELS, isWorkflowCompleted } from "./readingFlow";
import {
  TASK_TYPE_NEXT_DAY,
  TASK_TYPE_SENTENCE_RECHECK,
  localDateKey,
  resolveSentenceKeys,
  reviewTaskStatus,
} from "./readingReview";
import {
  compareAttempts,
  entryFor,
  questionKeyFor,
} from "./questionEvidence";
import {
  countsForPassage,
  listNeedsReviewSentenceKeys,
} from "./translationProgress";

export const REVIEW_STATUS_LABELS = {
  scheduled: "待明日",
  due: "今日到期",
  overdue: "逾期",
  in_progress: "进行中",
  completed: "已完成",
  skipped: "已跳过",
};

function countOfficial(questions, answers, correctAnswers) {
  const list = Array.isArray(questions) ? questions : [];
  let correct = 0;
  let total = 0;
  let answered = 0;
  for (const question of list) {
    const official = String(correctAnswers?.[question.number] || "").trim().toUpperCase();
    if (!official) continue;
    total += 1;
    const answer = String(answers?.[question.number] || "").trim().toUpperCase();
    if (!answer) continue;
    answered += 1;
    if (answer === official) correct += 1;
  }
  return { correct, total, answered };
}

export function getQuestionReviewStatus({
  firstAnswer = "",
  redoAnswer = "",
  officialAnswer = "",
  reviewAnswer = "",
} = {}) {
  const official = String(officialAnswer || "").trim().toUpperCase();
  if (!official) {
    return { status: "no-key", reason: "no-answer-key", corrected: false };
  }
  const first = String(firstAnswer || "").trim().toUpperCase();
  const redo = String(redoAnswer || "").trim().toUpperCase();
  const review = String(reviewAnswer || "").trim().toUpperCase();
  if (review && review !== official) {
    return { status: "review-wrong", reason: "review-answer-wrong", corrected: false };
  }
  if (redo && redo !== official) {
    return { status: "redo-wrong", reason: "redo-wrong", corrected: false };
  }
  if (redo && redo === official && first && first !== official) {
    return { status: "ok", reason: "corrected", corrected: true };
  }
  return { status: "ok", reason: "ok", corrected: false };
}

export function filterLearningRecordsForArticle(records, resourceId, passageId) {
  const list = Array.isArray(records) ? records : [];
  const targetResource = String(resourceId || "");
  const targetPassage = String(passageId || "");
  return list.filter((record) => {
    if (!record || String(record.resourceId || "") !== targetResource) return false;
    if (String(record.metadata?.passageId || "") === targetPassage) return true;
    if (record.taskType === TASK_TRANSLATION_REVIEW) {
      const sentenceId = String(record.sentenceId || record.itemId || "");
      return Boolean(targetPassage) && sentenceId.startsWith(`${targetResource}::${targetPassage}::`);
    }
    return false;
  });
}

function collectReviewAnswers(reviewTasks) {
  const byKey = {};
  for (const task of Array.isArray(reviewTasks) ? reviewTasks : []) {
    for (const [key, answer] of Object.entries(task?.session?.reviewAnswers || {})) {
      const value = String(answer || "").trim().toUpperCase();
      if (key && value) byKey[key] = value;
    }
  }
  return byKey;
}

export function buildArticleLearningSummary({
  resource,
  passage,
  flow = null,
  storedFlowExists = false,
  translationProgress = null,
  evidenceStore = null,
  firstAnswers = {},
  redoAnswers = {},
  correctAnswers = {},
  reviewTasks = [],
  unknownWords = [],
  learningRecords = [],
  today = localDateKey(),
} = {}) {
  const resourceId = String(resource?.id || "");
  const passageId = String(passage?.id || "");
  const flowCompleted = isWorkflowCompleted(flow);
  const translationCounts = countsForPassage(translationProgress, passage);
  const hasSentenceRecords = Boolean(
    translationProgress
    && typeof translationProgress === "object"
    && Object.keys(translationProgress.sentences || {}).length > 0,
  );

  const questions = Array.isArray(passage?.questions) ? passage.questions : [];
  const hasQuestions = questions.length > 0;
  const hasAnswerKey = hasQuestions && questions.some(
    (question) => String(correctAnswers?.[question.number] || "").trim(),
  );
  const first = countOfficial(questions, firstAnswers, correctAnswers);
  const redo = countOfficial(questions, redoAnswers, correctAnswers);
  const reviewAnswersByKey = collectReviewAnswers(reviewTasks);
  const questionInfo = [];
  const reviewNeeded = [];
  let answerChangedCount = 0;
  let evidenceChangedCount = 0;
  let correctedCount = 0;
  let hasEvidenceRecords = false;

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const key = questionKeyFor({
      resourceId,
      passageId,
      questionNumber: question.number,
      questionStem: question.stem,
      questionIndex: index,
    });
    const firstEntry = entryFor(evidenceStore, key, "first");
    const redoEntry = entryFor(evidenceStore, key, "redo");
    if (firstEntry || redoEntry) hasEvidenceRecords = true;
    const firstAnswer = String(firstAnswers?.[question.number] || "");
    const redoAnswer = String(redoAnswers?.[question.number] || "");
    const reviewAnswer = reviewAnswersByKey[key] || "";
    const status = getQuestionReviewStatus({
      firstAnswer,
      redoAnswer,
      officialAnswer: correctAnswers?.[question.number],
      reviewAnswer,
    });
    const comparison = compareAttempts({
      firstEntry,
      redoEntry,
      firstAnswer,
      redoAnswer,
    });
    const answerChanged = Boolean(firstAnswer.trim() && redoAnswer.trim())
      && String(firstAnswer).trim().toUpperCase() !== String(redoAnswer).trim().toUpperCase();
    const evidenceChanged = Boolean(firstEntry && redoEntry) && comparison.evidenceChanged;
    if (answerChanged) answerChangedCount += 1;
    if (evidenceChanged) evidenceChangedCount += 1;
    if (status.status === "ok" && status.corrected) correctedCount += 1;
    if (status.status === "review-wrong" || status.status === "redo-wrong") {
      reviewNeeded.push({
        question,
        questionIndex: index,
        key,
        reason: status.reason,
        status: status.status,
        reviewAnswer: status.status === "review-wrong" ? reviewAnswer : "",
      });
    }
    questionInfo.push({
      question,
      questionIndex: index,
      key,
      firstAnswer,
      redoAnswer,
      reviewAnswer,
      status,
    });
  }

  const articleWords = (Array.isArray(unknownWords) ? unknownWords : []).filter(
    (word) => String(word.resourceId || "") === resourceId
      && String(word.passageId || "") === passageId,
  );

  const articleRecords = filterLearningRecordsForArticle(learningRecords, resourceId, passageId);
  const reliableTagCounts = {};
  const reliableTagRecords = {};
  let pendingTagCount = 0;
  for (const record of articleRecords) {
    const seen = new Set();
    for (const tag of record.tags || []) {
      if (isReliableTag(tag, record)) {
        if (!seen.has(tag.name)) {
          seen.add(tag.name);
          reliableTagCounts[tag.name] = (reliableTagCounts[tag.name] || 0) + 1;
          if (!reliableTagRecords[tag.name]) reliableTagRecords[tag.name] = [];
          reliableTagRecords[tag.name].push(record);
        }
      }
      if (isPendingTag(tag, record)) pendingTagCount += 1;
    }
  }
  const reliableTags = Object.entries(reliableTagCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .map(([name, count]) => ({ name, count, records: reliableTagRecords[name] || [] }));

  const articleTasks = (Array.isArray(reviewTasks) ? reviewTasks : []).filter(
    (task) => task?.resourceId === resourceId && task?.passageId === passageId,
  );
  const nextDayTask = articleTasks.find((task) => task.type === TASK_TYPE_NEXT_DAY) || null;
  const recheckTasks = articleTasks
    .filter((task) => task.type === TASK_TYPE_SENTENCE_RECHECK)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((task) => ({
      task,
      status: reviewTaskStatus(task, today),
      sentenceCount: Array.isArray(task.sentenceKeys) ? task.sentenceKeys.length : 0,
    }));
  const nextDayStatus = nextDayTask ? reviewTaskStatus(nextDayTask, today) : null;
  const reviewLabel = nextDayTask
    ? REVIEW_STATUS_LABELS[nextDayStatus] || "未安排"
    : recheckTasks.length
      ? `困难句复查 · ${REVIEW_STATUS_LABELS[recheckTasks[0].status] || "未安排"}`
      : "未安排";

  const sentenceKeys = listNeedsReviewSentenceKeys(translationProgress);
  const packageSentences = resolveSentenceKeys(passage, sentenceKeys)
    .filter((item) => item.status === "resolved")
    .map((item) => ({
      key: item.key,
      paragraphNumber: item.paragraphNumber,
      sentenceIndex: item.sentenceIndex,
      sentenceText: item.sentenceText,
    }));

  const hasAnyRecords = Boolean(
    flowCompleted
    || hasSentenceRecords
    || hasEvidenceRecords
    || articleWords.length
    || articleRecords.length
    || articleTasks.length,
  );

  return {
    hasAnyRecords,
    flow: {
      completed: flowCompleted,
      historyOnly: flowCompleted && !storedFlowExists,
      currentStage: flow?.currentStage || "deep-cover",
      currentStageLabel: STAGE_LABELS[flow?.currentStage] || "",
      skippedStageLabels: Object.entries(flow?.stages || {}).filter(([, stage]) => stage.status === "skipped").map(([id]) => STAGE_LABELS[id] || id),
    },
    translation: {
      total: translationCounts.total,
      correctedCount: translationCounts.correctedCount,
      masteredCount: translationCounts.masteredCount,
      needsReviewCount: translationCounts.needsReviewCount,
      hasSentenceRecords,
    },
    questions: {
      hasQuestions,
      hasAnswerKey,
      hasEvidenceRecords,
      first,
      redo,
      answerChangedCount,
      evidenceChangedCount,
      correctedCount,
      reviewNeeded,
      questionInfo,
    },
    unknownWords: {
      count: articleWords.length,
      items: articleWords,
    },
    learning: {
      records: articleRecords,
      reliableTags,
      pendingTagCount,
    },
    review: {
      label: reviewLabel,
      nextDayTask,
      nextDayStatus,
      recheckTasks,
    },
    reviewPackage: {
      sentences: packageSentences,
      questions: reviewNeeded,
      words: articleWords,
      tags: reliableTags,
    },
  };
}

export function buildReviewPackage(args) {
  return buildArticleLearningSummary(args).reviewPackage;
}

export function recordIsQuestionDiagnosis(record) {
  return record?.taskType === TASK_QUESTION_DIAGNOSIS;
}
