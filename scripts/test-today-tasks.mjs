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

const { setCurrentUsername, setUserItem } = await import("../src/userData.js");
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
  createNextDayReviewTask,
  ensureSentenceRecheckTask,
  scheduleManualReviewTask,
  startReviewSession,
  updateReviewSession,
  completeReviewSession,
  localDateKey,
} = await import("../src/readingReview.js");
const {
  scanLearningState,
  buildTodayTasks,
  buildLibraryStatusMap,
} = await import("../src/todayTasks.js");
const { getOfficialAnswerKey } = await import("../src/answerKeys.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function officialResource(id = "postgraduate-2021-text-1") {
  return { id, kind: "official", year: 2021, text: 1, title: "2021 Text 1" };
}

function officialAnswers() {
  return getOfficialAnswerKey(officialResource());
}

function wrongLetter(answer) {
  return answer === "A" ? "B" : "A";
}

function completedFlow(resourceId, passageId, now = Date.now()) {
  let flow = emptyFlow(resourceId, passageId, now);
  for (const stage of STAGES) flow = completeStage(flow, stage.id, now + 1);
  return flow;
}

function incompleteFlow(resourceId, passageId, now = Date.now(), currentStage = "deep-translation") {
  const flow = emptyFlow(resourceId, passageId, now);
  flow.currentStage = currentStage;
  flow.stages[currentStage] = { status: "current", completedAt: null };
  for (const stage of STAGES) {
    if (stage.id === currentStage) continue;
    if (STAGES.indexOf(stage) < STAGES.findIndex((item) => item.id === currentStage)) {
      flow.stages[stage.id] = { status: "completed", completedAt: now };
    } else {
      flow.stages[stage.id] = { status: "pending", completedAt: null };
    }
  }
  flow.updatedAt = now;
  return flow;
}

function seedFlow(resourceId, passageId, flow) {
  setUserItem(`wuliao:reading-flow:${resourceId}:${passageId}`, JSON.stringify(flow));
}

function seedNeedsReview(resourceId, passageId) {
  let progress = emptyProgress(resourceId, passageId);
  const key = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  progress = markTranslated(progress, key);
  progress = markCorrected(progress, key, { translationText: "你好。" });
  progress = setReviewStatus(progress, key, "needs_review");
  setUserItem(`wuliao:translation-progress:${resourceId}:${passageId}`, JSON.stringify(progress));
  return key;
}

function seedRedoAnswers(resourceId, passageId, answers) {
  setUserItem(`wuliao:deep-answers:${resourceId}:${passageId}:redo`, JSON.stringify(answers));
}

function seedFirstAnswers(resourceId, passageId, answers) {
  setUserItem(`wuliao:deep-answers:${resourceId}:${passageId}:first`, JSON.stringify(answers));
}

function resources() {
  return [officialResource()];
}

test("A 未完成文章 → 出现 continue reading", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", incompleteFlow("postgraduate-2021-text-1", "p1", 1000));
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.continueReading.resourceId, "postgraduate-2021-text-1");
  assert.equal(data.continueReading.stageLabel, "逐段精读");
  assert.equal(data.continueReading.stageIndex, 5);
  assert.equal(data.hasAny, true);
});

test("多篇未完成 → 最近活动文章优先", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", incompleteFlow("postgraduate-2021-text-1", "p1", 1000));
  seedFlow("r2", "p1", incompleteFlow("r2", "p1", 2000));
  const data = buildTodayTasks(scanLearningState(), { resources: [officialResource(), officialResource("r2")] });
  assert.equal(data.continueReading.resourceId, "r2");
  assert.equal(data.moreInProgressCount, 1);
  assert.equal(data.moreInProgress[0].resourceId, "postgraduate-2021-text-1");
});

test("D in_progress → 最高优先级", () => {
  fresh();
  const due = createNextDayReviewTask({ resourceId: "postgraduate-2021-text-1", passageId: "p1", now: Date.now() });
  const later = createNextDayReviewTask({ resourceId: "r2", passageId: "p1", now: Date.now() });
  startReviewSession(later.task.taskKey);
  const data = buildTodayTasks(scanLearningState(), { resources: [officialResource(), officialResource("r2")] });
  assert.equal(data.reviewSummary.todayItems[0].status, "in_progress");
  assert.equal(data.reviewSummary.todayItems[0].task.taskKey, later.task.taskKey);
  assert.equal(due.ok, true);
});

test("D overdue → 高于 due", () => {
  fresh();
  const created = createNextDayReviewTask({ resourceId: "postgraduate-2021-text-1", passageId: "p1" });
  setUserItem(
    `wuliao:review-task:${created.task.taskKey}`,
    JSON.stringify({ ...created.task, dueDate: "2026-08-01" }),
  );
  const due = scheduleManualReviewTask({ resourceId: "r2", passageId: "p1" });
  const data = buildTodayTasks(scanLearningState(), { resources: [officialResource(), officialResource("r2")] });
  assert.equal(data.reviewSummary.todayItems[0].status, "overdue");
  assert.equal(data.reviewSummary.todayItems[0].task.taskKey, created.task.taskKey);
  assert.equal(due.ok, true);
});

test("due → 正确显示", () => {
  fresh();
  scheduleManualReviewTask({ resourceId: "postgraduate-2021-text-1", passageId: "p1" });
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.reviewSummary.todayItems.length, 1);
  assert.equal(data.reviewSummary.todayItems[0].status, "due");
});

test("scheduled future task → 不进入今日任务", () => {
  fresh();
  const created = createNextDayReviewTask({ resourceId: "postgraduate-2021-text-1", passageId: "p1" });
  setUserItem(
    `wuliao:review-task:${created.task.taskKey}`,
    JSON.stringify({ ...created.task, dueDate: localDateKey(Date.now() + 3 * 86400000) }),
  );
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.reviewSummary.todayCount, 0);
  assert.equal(data.reviewSummary.upcomingCount, 1);
  assert.equal(data.hasAny, false);
});

test("needs_review sentence → 可以进入待复盘", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", completedFlow("postgraduate-2021-text-1", "p1"));
  seedNeedsReview("postgraduate-2021-text-1", "p1");
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.pendingGroups.length, 1);
  assert.equal(data.pendingGroups[0].difficultCount, 1);
  assert.equal(data.hasAny, true);
});

test("有 D article review 覆盖该文章 → 不重复显示 needs_review", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", completedFlow("postgraduate-2021-text-1", "p1"));
  seedNeedsReview("postgraduate-2021-text-1", "p1");
  scheduleManualReviewTask({ resourceId: "postgraduate-2021-text-1", passageId: "p1" });
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.pendingGroups.length, 0);
  assert.equal(data.reviewSummary.todayCount, 1);
});

test("有未来 sentence_recheck → 今天不重复显示同一句待复盘", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", completedFlow("postgraduate-2021-text-1", "p1"));
  const key = seedNeedsReview("postgraduate-2021-text-1", "p1");
  ensureSentenceRecheckTask({ resourceId: "postgraduate-2021-text-1", passageId: "p1", sentenceKeys: [key] });
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.pendingGroups.length, 0);
});

test("redo 错题 → 进入待复盘", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", completedFlow("postgraduate-2021-text-1", "p1"));
  seedFirstAnswers("postgraduate-2021-text-1", "p1", { 21: "A" });
  seedRedoAnswers("postgraduate-2021-text-1", "p1", { 21: wrongLetter(officialAnswers()["21"]) });
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.pendingGroups.length, 1);
  assert.equal(data.pendingGroups[0].questionCount, 1);
});

test("自定义 PDF 的遗留答案键不参与判错或待复盘", () => {
  fresh();
  seedFlow("c1", "p1", completedFlow("c1", "p1"));
  seedRedoAnswers("c1", "p1", { 21: "B" });
  setUserItem("wuliao:custom-answer-key:c1:p1", JSON.stringify({ 21: "A" }));
  const customPdfs = [{
    id: "c1",
    kind: "custom",
    title: "扫描自定义试卷",
    analysis: { passages: [{ id: "p1", paragraphs: [], questions: [] }] },
  }];

  const scan = scanLearningState({ force: true });
  const data = buildTodayTasks(scan, { resources: [], customPdfs });
  const library = buildLibraryStatusMap(scan, { resources: customPdfs });

  assert.equal(data.pendingGroups.length, 0);
  assert.equal(library.c1.questionReviewTotal, 0);
  assert.equal(library.c1.label, "✓ 已完成");
});

test("D reviewAnswer 错题 → 进入待复盘（任务完成后）", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", completedFlow("postgraduate-2021-text-1", "p1"));
  const created = scheduleManualReviewTask({ resourceId: "postgraduate-2021-text-1", passageId: "p1" });
  const wrong = wrongLetter(officialAnswers()["21"]);
  updateReviewSession(created.task.taskKey, {
    reviewAnswers: { "r1::p1::q21::xhash": wrong },
  });
  const started = startReviewSession(created.task.taskKey);
  completeReviewSession(started.task.taskKey);
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.reviewSummary.todayCount, 0);
  assert.equal(data.pendingGroups.length, 1);
  assert.equal(data.pendingGroups[0].questionCount, 1);
});

test("first 错 redo 对 → 默认不进入长期待复盘", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", completedFlow("postgraduate-2021-text-1", "p1"));
  seedFirstAnswers("postgraduate-2021-text-1", "p1", { 21: wrongLetter(officialAnswers()["21"]) });
  seedRedoAnswers("postgraduate-2021-text-1", "p1", { 21: officialAnswers()["21"] });
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.pendingGroups.length, 0);
});

test("完成 D task 后今日任务及时变化", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", completedFlow("postgraduate-2021-text-1", "p1"));
  seedRedoAnswers("postgraduate-2021-text-1", "p1", { 21: wrongLetter(officialAnswers()["21"]) });
  const created = scheduleManualReviewTask({ resourceId: "postgraduate-2021-text-1", passageId: "p1" });
  const before = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(before.reviewSummary.todayCount, 1);
  assert.equal(before.pendingGroups.length, 0);
  const started = startReviewSession(created.task.taskKey);
  completeReviewSession(started.task.taskKey);
  const after = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(after.reviewSummary.todayCount, 0);
  assert.equal(after.pendingGroups.length, 1);
  assert.equal(after.pendingGroups[0].questionCount, 1);
});

test("account 切换 → 任务完全隔离", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", incompleteFlow("postgraduate-2021-text-1", "p1", 1000));
  const alice = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(alice.continueReading.resourceId, "postgraduate-2021-text-1");
  setCurrentUsername("bob");
  const bob = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(bob.continueReading, null);
  assert.equal(bob.hasAny, false);
});

test("空状态：首页不出现无意义卡片", () => {
  fresh();
  const data = buildTodayTasks(scanLearningState(), { resources: resources() });
  assert.equal(data.hasAny, false);
  assert.equal(data.continueReading, null);
  assert.equal(data.pendingGroups.length, 0);
  assert.equal(data.reviewSummary.todayCount, 0);
});

test("自定义 PDF 提供句数进度", () => {
  fresh();
  seedFlow("c1", "p1", incompleteFlow("c1", "p1", 1000));
  let progress = emptyProgress("c1", "p1");
  const key = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  progress = markTranslated(progress, key);
  progress = markCorrected(progress, key, { translationText: "你好。" });
  setUserItem("wuliao:translation-progress:c1:p1", JSON.stringify(progress));
  const customPdfs = [{
    id: "c1",
    title: "自定义试卷",
    analysis: {
      passages: [{
        id: "p1",
        paragraphs: [
          { number: 1, text: "Hello world.", sentences: ["Hello world."] },
        ],
        questions: [],
      }],
    },
  }];
  const data = buildTodayTasks(scanLearningState(), { resources: [], customPdfs });
  assert.equal(data.continueReading.title, "自定义试卷");
  assert.deepEqual(data.continueReading.sentenceProgress, { total: 1, correctedCount: 1 });
});

test("library 状态图：完成 + 待复盘", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", completedFlow("postgraduate-2021-text-1", "p1"));
  seedNeedsReview("postgraduate-2021-text-1", "p1");
  const map = buildLibraryStatusMap(scanLearningState(), { resources: resources() });
  assert.equal(map["postgraduate-2021-text-1"].hasRecords, true);
  assert.equal(map["postgraduate-2021-text-1"].label, "✓ 已完成 · 待复盘 1");
});

test("library 状态图：进行中", () => {
  fresh();
  seedFlow("postgraduate-2021-text-1", "p1", incompleteFlow("postgraduate-2021-text-1", "p1", 1000, "deep-first-quiz"));
  const map = buildLibraryStatusMap(scanLearningState(), { resources: resources() });
  assert.equal(map["postgraduate-2021-text-1"].label, "进行中 · 初做");
});
