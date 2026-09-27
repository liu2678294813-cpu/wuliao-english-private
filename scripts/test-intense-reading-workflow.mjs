import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("限时读文保持自然段连续排版，初做阶段隐藏全局 AI 入口", () => {
  const source = readFileSync(new URL("../src/CustomDeepReader.jsx", import.meta.url), "utf8");
  assert.match(source, /className="clean-natural-paragraph"/);
  assert.doesNotMatch(source.slice(source.indexOf('id="deep-clean-text"'), source.indexOf('id="deep-first-quiz"')), /className="clean-sentence"/);
  assert.match(source, /flowCurrentStage !== "deep-clean-text"[\s\S]*?flowCurrentStage !== "deep-first-quiz"/);
});
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const {
  getCurrentUsername,
  getUserItem,
  setCurrentUsername,
  setUserItem,
} = await import("../src/userData.js");
const {
  completeStage,
  emptyFlow,
  getReadingFlow,
  saveReadingFlow,
  STAGES,
} = await import("../src/readingFlow.js");
const {
  emptyProgress,
  markCorrected,
  markTranslated,
  saveTranslationProgress,
  sentenceKeyFor,
  setReviewStatus,
} = await import("../src/translationProgress.js");
const {
  buildTextRange,
  buildTextSegment,
  emptyTextEvidenceEntry,
  emptyEvidenceStore,
  entryFor,
  entryNeedsType,
  loadEvidenceStore,
  questionKeyFor,
  saveEvidenceStore,
  setEvidence,
  setTextType,
} = await import("../src/questionEvidence.js");
const {
  buildArticleLearningSummary,
} = await import("../src/articleLearningSummary.js");
const {
  completeReviewSession,
  createNextDayReviewTask,
  listReviewTasks,
  loadReviewTask,
  reviewTaskStatus,
  startReviewSession,
  updateReviewSession,
} = await import("../src/readingReview.js");
const {
  buildTodayTasks,
  scanLearningState,
} = await import("../src/todayTasks.js");
const {
  isReadingCompleted,
} = await import("../src/studyRank.js");

const NOW_MS = new Date(2026, 7, 7, 12, 0, 0).getTime();
const NEXT_DAY_MS = NOW_MS + 86400000;
const TODAY = "2026-08-08";

const RESOURCE = { id: "r1", kind: "official", year: 2021, text: 1, title: "2021 Text 1" };

function makePassage() {
  return {
    id: "p1",
    label: "Text 1",
    paragraphs: [
      {
        number: 1,
        text: "Hello world. It is fine.",
        sentences: ["Hello world.", "It is fine."],
      },
    ],
    questions: [
      { id: "q1", number: 21, stem: "Which one is right?", options: [
        { key: "A", text: "one" },
        { key: "B", text: "two" },
        { key: "C", text: "three" },
        { key: "D", text: "four" },
      ] },
      { id: "q2", number: 22, stem: "Why is it so?", options: [
        { key: "A", text: "a" },
        { key: "B", text: "b" },
        { key: "C", text: "c" },
        { key: "D", text: "d" },
      ] },
    ],
  };
}

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function seedA(resourceId, passageId) {
  let flow = emptyFlow(resourceId, passageId, NOW_MS);
  for (const stage of STAGES) flow = completeStage(flow, stage.id, NOW_MS + 1);
  saveReadingFlow(flow);
  setUserItem(`wuliao:reading-activity:${resourceId}:${passageId}`, JSON.stringify({
    completed: true,
    completedAt: NOW_MS + 1,
  }));
  return flow;
}

function seedB(resourceId, passageId) {
  let progress = emptyProgress(resourceId, passageId);
  const key1 = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  const key2 = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 1, sentenceText: "It is fine." });
  progress = markTranslated(progress, key1);
  progress = markCorrected(progress, key1, { translationText: "你好世界。", now: NOW_MS + 10 });
  progress = setReviewStatus(progress, key1, "mastered", NOW_MS + 20);
  progress = markTranslated(progress, key2);
  progress = markCorrected(progress, key2, { translationText: "一切安好。", now: NOW_MS + 30 });
  progress = setReviewStatus(progress, key2, "needs_review", NOW_MS + 40);
  saveTranslationProgress(progress);
  return { progress, key1, key2 };
}

function seedC(resourceId, passageId, passage) {
  const firstAnswers = { 21: "A", 22: "B" };
  const redoAnswers = { 21: "B", 22: "B" };
  setUserItem(`wuliao:deep-answers:${resourceId}:${passageId}:first`, JSON.stringify(firstAnswers));
  setUserItem(`wuliao:deep-answers:${resourceId}:${passageId}:redo`, JSON.stringify(redoAnswers));
  const key = questionKeyFor({
    resourceId,
    passageId,
    questionNumber: 21,
    questionStem: passage.questions[0].stem,
    questionIndex: 0,
  });
  const firstRange = buildTextRange({ segments: [buildTextSegment({
    paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world.", startOffset: 0, endOffset: 5,
  })] });
  const redoRange = buildTextRange({ segments: [buildTextSegment({
    paragraphNumber: 1, sentenceIndex: 1, sentenceText: "It is fine.", startOffset: 0, endOffset: 10,
  })] });
  let store = emptyEvidenceStore(resourceId, passageId);
  store = setEvidence(store, key, "first", setTextType({
    ...emptyTextEvidenceEntry(NOW_MS + 50), ranges: [firstRange],
  }, "direct"));
  store = setEvidence(store, key, "redo", setTextType({
    ...emptyTextEvidenceEntry(NOW_MS + 60), ranges: [redoRange],
  }, "inference"));
  saveEvidenceStore(store);
  return { firstAnswers, redoAnswers, store, key };
}

function seedD(resourceId, passageId, sentenceKey, reviewQuestionKey) {
  const created = createNextDayReviewTask({ resourceId, passageId, now: NOW_MS });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  const started = startReviewSession(created.task.taskKey, NEXT_DAY_MS);
  assert.equal(started.ok, true);
  const updated = updateReviewSession(created.task.taskKey, {
    currentStep: "check",
    checkUnlocked: true,
    paragraphRecall: { "1": { completedAt: NEXT_DAY_MS + 1000, summary: "重新读懂" } },
    sentenceResults: { [sentenceKey]: "mastered" },
    reviewAnswers: { [reviewQuestionKey]: "C" },
  }, NEXT_DAY_MS + 2000);
  assert.equal(updated.ok, true);
  const completed = completeReviewSession(created.task.taskKey, {
    paragraphRecallCount: 1,
    masteredCount: 1,
    difficultCount: 0,
  }, NEXT_DAY_MS + 3000);
  assert.equal(completed.ok, true);
  return loadReviewTask(created.task.taskKey);
}

test("A→B→C→D→E 端到端：状态推进、数据隔离、Today Tasks 与 Summary 一致", () => {
  fresh();
  const passage = makePassage();
  const activityBefore = JSON.stringify({
    completed: true,
    completedAt: NOW_MS + 1,
  });

  // A：工作流推进到完成，并写入 reading-activity（唯一计分事实源）
  const flow = seedA(RESOURCE.id, passage.id);
  assert.equal(flow.currentStage, "deep-review");
  assert.equal(flow.stages["deep-review"].status, "completed");
  assert.equal(getReadingFlow(RESOURCE.id, passage.id).currentStage, "deep-review");
  assert.equal(isReadingCompleted(RESOURCE.id, passage.id), true);

  // B：一条 mastered、一条 needs_review
  const { progress, key1, key2 } = seedB(RESOURCE.id, passage.id);
  assert.equal(progress.sentences[key1].reviewStatus, "mastered");
  assert.equal(progress.sentences[key2].reviewStatus, "needs_review");

  // C：first / redo 答案与证据链
  const { firstAnswers, redoAnswers, store, key } = seedC(RESOURCE.id, passage.id, passage);
  assert.equal(store.questions[key].first.mode, "text");
  assert.equal(store.questions[key].first.ranges.length, 1);
  assert.equal(store.questions[key].redo.ranges.length, 1);
  assert.equal(store.questions[key].redo.textType, "inference");

  // D：生成次日任务并完成 Review Session
  const reviewTask = seedD(RESOURCE.id, passage.id, key1, key);
  assert.equal(reviewTaskStatus(reviewTask, TODAY), "completed");
  assert.equal(listReviewTasks().length, 1);
  // reviewAnswers 与 first/redo 使用同一 questionKeyFor，题号可解析
  const numberMatch = /::q(\d+)::/.exec(key);
  assert.equal(numberMatch[1], "21");

  // D 完成不写 reading-activity（不重复计分）
  assert.equal(getUserItem(`wuliao:reading-activity:${RESOURCE.id}:${passage.id}`), activityBefore);
  assert.equal(JSON.parse(getUserItem(`wuliao:deep-answers:${RESOURCE.id}:${passage.id}:first`))["21"], "A");
  assert.equal(JSON.parse(getUserItem(`wuliao:deep-answers:${RESOURCE.id}:${passage.id}:redo`))["21"], "B");

  // E：Article Learning Summary 正确聚合
  const summary = buildArticleLearningSummary({
    resource: RESOURCE,
    passage,
    flow,
    storedFlowExists: true,
    translationProgress: progress,
    evidenceStore: store,
    firstAnswers,
    redoAnswers,
    correctAnswers: { 21: "C", 22: "B" },
    reviewTasks: listReviewTasks(),
    unknownWords: [],
    learningRecords: [],
    today: TODAY,
  });
  assert.equal(summary.flow.completed, true);
  assert.equal(summary.flow.historyOnly, false);
  assert.equal(summary.translation.total, 2);
  assert.equal(summary.translation.masteredCount, 1);
  assert.equal(summary.translation.needsReviewCount, 1);
  assert.equal(summary.questions.hasEvidenceRecords, true);
  assert.equal(summary.questions.reviewNeeded.length, 1);
  assert.equal(summary.questions.reviewNeeded[0].question.number, 21);
  assert.equal(summary.review.nextDayStatus, "completed");
  assert.equal(summary.reviewPackage.questions.length, 1);
  assert.equal(summary.reviewPackage.sentences.length, 1);

  // E：Today Tasks 正确更新；完成文章不再出现在“继续精读”
  const scan = scanLearningState({ today: TODAY, force: true });
  const tasks = buildTodayTasks(scan, { resources: [RESOURCE], customPdfs: [] });
  assert.equal(tasks.continueReading, null);
  assert.equal(tasks.reviewSummary.completedCount, 1);
  assert.equal(tasks.pendingGroups.length, 1);
  assert.equal(tasks.pendingGroups[0].questionCount, 1);
  assert.equal(tasks.pendingGroups[0].resourceId, RESOURCE.id);
  assert.equal(getCurrentUsername(), "alice");
});

test("E 聚合层不拥有第二个 mastered 事实源", () => {
  fresh();
  const passage = makePassage();
  const flow = seedA(RESOURCE.id, passage.id);
  const { progress } = seedB(RESOURCE.id, passage.id);
  const { firstAnswers, redoAnswers, store } = seedC(RESOURCE.id, passage.id, passage);
  const summary = buildArticleLearningSummary({
    resource: RESOURCE,
    passage,
    flow,
    storedFlowExists: true,
    translationProgress: progress,
    evidenceStore: store,
    firstAnswers,
    redoAnswers,
    correctAnswers: { 21: "C", 22: "B" },
    reviewTasks: [],
    unknownWords: [],
    learningRecords: [],
    today: TODAY,
  });
  // masteredCount 只来自 B 的 translationProgress，而不是 E 自己存储的状态
  assert.equal(summary.translation.masteredCount, 1);
  const rawKeys = [...globalThis.localStorage.map.keys()];
  assert.ok(!rawKeys.some((item) => String(item).includes("article-mastered")));
  assert.ok(!rawKeys.some((item) => String(item).includes("summary:mastered")));
});

test("历史 completed flow 遇到 legacy global-null evidence：阶段与 completedAt 原样保留，类型不伪造", () => {
  fresh();
  const passage = makePassage();
  const completedFlow = seedA(RESOURCE.id, passage.id);
  const key = questionKeyFor({
    resourceId: RESOURCE.id,
    passageId: passage.id,
    questionNumber: 21,
    questionStem: passage.questions[0].stem,
    questionIndex: 0,
  });
  setUserItem(`wuliao:question-evidence:${RESOURCE.id}:${passage.id}`, JSON.stringify({
    schemaVersion: 1,
    resourceId: RESOURCE.id,
    passageId: passage.id,
    questions: { [key]: { first: { mode: "global", globalType: null, completedAt: NOW_MS - 50 } } },
  }));

  const reloadedFlow = getReadingFlow(RESOURCE.id, passage.id);
  assert.equal(reloadedFlow.currentStage, "deep-review");
  assert.equal(reloadedFlow.stages["deep-first-quiz"].status, "completed");
  assert.equal(
    reloadedFlow.stages["deep-first-quiz"].completedAt,
    completedFlow.stages["deep-first-quiz"].completedAt,
  );
  const evidence = entryFor(loadEvidenceStore(RESOURCE.id, passage.id), key, "first");
  assert.equal(entryNeedsType(evidence), true);
  assert.equal(evidence.globalType, null);
  assert.equal(evidence.completedAt, NOW_MS - 50);
});
