import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key) {
    return this.map.has(String(key)) ? this.map.get(String(key)) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }

  clear() {
    this.map.clear();
  }
}

globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail || null;
  }
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const { setCurrentUsername } = await import("../src/userData.js");
const {
  emptyFlow,
  STAGES,
  completeStage,
} = await import("../src/readingFlow.js");
const {
  emptyProgress,
  markTranslated,
  markCorrected,
  setReviewStatus,
  sentenceKeyFor,
} = await import("../src/translationProgress.js");
const {
  buildSentenceRef,
  emptyEvidenceStore,
  questionKeyFor,
  setEvidence,
} = await import("../src/questionEvidence.js");
const {
  buildArticleLearningSummary,
  getQuestionReviewStatus,
  filterLearningRecordsForArticle,
} = await import("../src/articleLearningSummary.js");
const { TASK_QUESTION_DIAGNOSIS, TASK_TRANSLATION_REVIEW } = await import("../src/aiTasks.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function makeResource() {
  return { id: "r1", kind: "official", year: 2021, text: 3, title: "2021 Text 3" };
}

function makePassage({ questions = [] } = {}) {
  return {
    id: "p1",
    label: "Text 3",
    paragraphs: [
      {
        number: 1,
        text: "Hello world. It is fine.",
        sentences: ["Hello world.", "It is fine."],
      },
    ],
    questions,
  };
}

function completedFlow(resourceId, passageId, now = Date.now()) {
  let flow = emptyFlow(resourceId, passageId, now);
  for (const stage of STAGES) flow = completeStage(flow, stage.id, now + 1);
  return flow;
}

function twoSentenceProgress(resourceId, passageId) {
  let progress = emptyProgress(resourceId, passageId);
  const key1 = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  const key2 = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 1, sentenceText: "It is fine." });
  progress = markTranslated(progress, key1);
  progress = markCorrected(progress, key1, { translationText: "你好世界。" });
  progress = setReviewStatus(progress, key1, "mastered");
  progress = markTranslated(progress, key2);
  progress = markCorrected(progress, key2, { translationText: "一切安好。" });
  progress = setReviewStatus(progress, key2, "needs_review");
  return progress;
}

function baseArgs(overrides = {}) {
  return {
    resource: makeResource(),
    passage: makePassage(),
    flow: completedFlow("r1", "p1"),
    storedFlowExists: true,
    translationProgress: twoSentenceProgress("r1", "p1"),
    evidenceStore: emptyEvidenceStore("r1", "p1"),
    firstAnswers: {},
    redoAnswers: {},
    correctAnswers: { 21: "A", 22: "B" },
    reviewTasks: [],
    unknownWords: [],
    learningRecords: [],
    ...overrides,
  };
}

test("B mastered / needs_review 数量正确", () => {
  fresh();
  const summary = buildArticleLearningSummary(baseArgs());
  assert.equal(summary.translation.total, 2);
  assert.equal(summary.translation.masteredCount, 1);
  assert.equal(summary.translation.needsReviewCount, 1);
  assert.equal(summary.translation.hasSentenceRecords, true);
});

test("first / redo 正确率正确", () => {
  fresh();
  const questions = [
    { id: "q1", number: 21, stem: "Which one?", options: [] },
    { id: "q2", number: 22, stem: "Why?", options: [] },
  ];
  const summary = buildArticleLearningSummary(baseArgs({
    passage: makePassage({ questions }),
    firstAnswers: { 21: "A", 22: "C" },
    redoAnswers: { 21: "A", 22: "B" },
    correctAnswers: { 21: "A", 22: "B" },
  }));
  assert.deepEqual(summary.questions.first, { correct: 1, total: 2, answered: 2 });
  assert.deepEqual(summary.questions.redo, { correct: 2, total: 2, answered: 2 });
});

test("first 错 redo 对：标记为已纠正且不进入待复盘", () => {
  fresh();
  const questions = [
    { id: "q1", number: 21, stem: "Which one?", options: [] },
    { id: "q2", number: 22, stem: "Why?", options: [] },
  ];
  const summary = buildArticleLearningSummary(baseArgs({
    passage: makePassage({ questions }),
    firstAnswers: { 21: "B", 22: "B" },
    redoAnswers: { 21: "A", 22: "B" },
    correctAnswers: { 21: "A", 22: "B" },
  }));
  assert.equal(summary.questions.correctedCount, 1);
  assert.equal(summary.questions.reviewNeeded.length, 0);
});

test("redo 错：进入 needs_review question", () => {
  fresh();
  const questions = [
    { id: "q1", number: 21, stem: "Which one?", options: [] },
  ];
  const summary = buildArticleLearningSummary(baseArgs({
    passage: makePassage({ questions }),
    firstAnswers: { 21: "B" },
    redoAnswers: { 21: "C" },
    correctAnswers: { 21: "A" },
  }));
  assert.equal(summary.questions.reviewNeeded.length, 1);
  assert.equal(summary.questions.reviewNeeded[0].reason, "redo-wrong");
  assert.equal(summary.reviewPackage.questions.length, 1);
});

test("D reviewAnswer 再错：优先进入 needs_review", () => {
  fresh();
  const questions = [
    { id: "q1", number: 21, stem: "Which one?", options: [] },
  ];
  const passage = makePassage({ questions });
  const key = questionKeyFor({
    resourceId: "r1",
    passageId: "p1",
    questionNumber: 21,
    questionStem: "Which one?",
    questionIndex: 0,
  });
  const reviewTask = {
    taskKey: "review:next_day_article:r1:p1:2026-08-07",
    type: "next_day_article",
    resourceId: "r1",
    passageId: "p1",
    session: {
      reviewAnswers: { [key]: "D" },
    },
  };
  const summary = buildArticleLearningSummary(baseArgs({
    passage,
    firstAnswers: { 21: "B" },
    redoAnswers: { 21: "A" },
    correctAnswers: { 21: "A" },
    reviewTasks: [reviewTask],
  }));
  assert.equal(summary.questions.reviewNeeded.length, 1);
  assert.equal(summary.questions.reviewNeeded[0].status, "review-wrong");
  assert.equal(summary.questions.reviewNeeded[0].reason, "review-answer-wrong");
});

test("答案改变与证据改变按确定规则统计", () => {
  fresh();
  const questions = [
    { id: "q1", number: 21, stem: "Which one?", options: [] },
  ];
  const passage = makePassage({ questions });
  const store = emptyEvidenceStore("r1", "p1");
  const key = questionKeyFor({
    resourceId: "r1",
    passageId: "p1",
    questionNumber: 21,
    questionStem: "Which one?",
    questionIndex: 0,
  });
  const firstRef = buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  const redoRef = buildSentenceRef({ paragraphNumber: 1, sentenceIndex: 1, sentenceText: "It is fine." });
  const withEvidence = setEvidence(
    setEvidence(store, key, "first", {
      mode: "sentences",
      references: [firstRef],
      globalType: null,
      note: "",
    }),
    key,
    "redo",
    {
      mode: "sentences",
      references: [redoRef],
      globalType: null,
      note: "",
    },
  );
  const summary = buildArticleLearningSummary(baseArgs({
    passage,
    evidenceStore: withEvidence,
    firstAnswers: { 21: "A" },
    redoAnswers: { 21: "B" },
    correctAnswers: { 21: "A" },
  }));
  assert.equal(summary.questions.answerChangedCount, 1);
  assert.equal(summary.questions.evidenceChangedCount, 1);
});

test("unknown words 按 resource/passage 隔离", () => {
  fresh();
  const summary = buildArticleLearningSummary(baseArgs({
    unknownWords: [
      { resourceId: "r1", passageId: "p1", normalizedWord: "hello" },
      { resourceId: "r1", passageId: "p2", normalizedWord: "other" },
      { resourceId: "r2", passageId: "p1", normalizedWord: "wrong" },
    ],
  }));
  assert.equal(summary.unknownWords.count, 1);
  assert.equal(summary.unknownWords.items[0].normalizedWord, "hello");
  assert.equal(summary.reviewPackage.words.length, 1);
});

test("learning records 按 resource/passage 隔离", () => {
  fresh();
  const records = [
    {
      id: "lr1",
      taskType: TASK_TRANSLATION_REVIEW,
      resourceId: "r1",
      sentenceId: "r1::p1::p1s1",
      metadata: { passageId: "p1" },
      tags: [{ name: "词义选择错误", source: "ai-direct", confidence: "high", status: "active" }],
    },
    {
      id: "lr2",
      taskType: TASK_QUESTION_DIAGNOSIS,
      resourceId: "r1",
      metadata: { passageId: "p2" },
      tags: [],
    },
    {
      id: "lr3",
      taskType: TASK_QUESTION_DIAGNOSIS,
      resourceId: "r2",
      metadata: { passageId: "p1" },
      tags: [],
    },
  ];
  const summary = buildArticleLearningSummary(baseArgs({ learningRecords: records }));
  assert.equal(summary.learning.records.length, 1);
  assert.equal(summary.learning.records[0].id, "lr1");
  assert.equal(filterLearningRecordsForArticle(records, "r1", "p1").length, 1);
});

test("低置信度未确认 AI 标签不能混进可靠错误统计", () => {
  fresh();
  const records = [
    {
      id: "lr-low",
      taskType: TASK_QUESTION_DIAGNOSIS,
      resourceId: "r1",
      metadata: { passageId: "p1" },
      tags: [
        { name: "过度推断", source: "ai-inferred", confidence: "low", status: "active" },
      ],
    },
  ];
  const summary = buildArticleLearningSummary(baseArgs({ learningRecords: records }));
  assert.equal(summary.learning.reliableTags.length, 0);
  assert.equal(summary.learning.pendingTagCount, 1);
});

test("历史已完成文章没有 B/C/D 数据时不报错", () => {
  fresh();
  const summary = buildArticleLearningSummary({
    resource: makeResource(),
    passage: makePassage(),
    flow: completedFlow("r1", "p1"),
    storedFlowExists: false,
    translationProgress: null,
    evidenceStore: null,
    firstAnswers: {},
    redoAnswers: {},
    correctAnswers: { 21: "A", 22: "B" },
    reviewTasks: [],
    unknownWords: [],
    learningRecords: [],
  });
  assert.equal(summary.flow.completed, true);
  assert.equal(summary.flow.historyOnly, true);
  assert.equal(summary.translation.hasSentenceRecords, false);
  assert.equal(summary.translation.masteredCount, 0);
  assert.equal(summary.questions.hasEvidenceRecords, false);
  assert.equal(summary.review.label, "未安排");
});

test("无题文章不报错且隐藏题目数据", () => {
  fresh();
  const summary = buildArticleLearningSummary(baseArgs({
    passage: makePassage({ questions: [] }),
    correctAnswers: {},
  }));
  assert.equal(summary.questions.hasQuestions, false);
  assert.equal(summary.questions.hasAnswerKey, false);
  assert.deepEqual(summary.questions.first, { correct: 0, total: 0, answered: 0 });
});

test("无 AI record 不报错", () => {
  fresh();
  const summary = buildArticleLearningSummary(baseArgs({ learningRecords: [] }));
  assert.equal(summary.learning.records.length, 0);
  assert.equal(summary.learning.reliableTags.length, 0);
});

test("聚合是同步纯函数，不产生 AI 请求字段", () => {
  fresh();
  const summary = buildArticleLearningSummary(baseArgs());
  assert.equal(typeof summary.reviewPackage.sentences.length, "number");
  assert.equal("aiRequest" in summary, false);
  assert.equal("score" in summary, false);
});

test("getQuestionReviewStatus 规则表", () => {
  assert.equal(getQuestionReviewStatus({ officialAnswer: "A" }).status, "ok");
  assert.equal(getQuestionReviewStatus({ officialAnswer: "A", redoAnswer: "B" }).status, "redo-wrong");
  assert.equal(
    getQuestionReviewStatus({ officialAnswer: "A", redoAnswer: "B", reviewAnswer: "B" }).status,
    "review-wrong",
  );
  assert.equal(
    getQuestionReviewStatus({ officialAnswer: "A", firstAnswer: "B", redoAnswer: "A" }).corrected,
    true,
  );
  assert.equal(getQuestionReviewStatus({ officialAnswer: "" }).status, "no-key");
});
