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

const { setCurrentUsername, setUserItem, getUserItem } = await import("../src/userData.js");
const {
  localDateKey,
  addCalendarDays,
  dateDiffDays,
  reviewTaskKey,
  listReviewTasks,
  loadReviewTask,
  createNextDayReviewTask,
  scheduleManualReviewTask,
  startReviewSession,
  updateReviewSession,
  completeReviewSession,
  skipReviewTask,
  saveReviewTask,
  pauseReviewTiming,
  resumeReviewTiming,
  ensureSentenceRecheckTask,
  wrongQuestionKeys,
  resolveSentenceKeys,
  homeReviewSummary,
  reviewTaskStatus,
  reviewCheckUnlocked,
  overdueDays,
  TASK_TYPE_NEXT_DAY,
  TASK_TYPE_SENTENCE_RECHECK,
} = await import("../src/readingReview.js");
const {
  emptyProgress,
  markTranslated,
  markCorrected,
  setReviewStatus,
  listNeedsReviewSentenceKeys,
  sentenceKeyFor,
} = await import("../src/translationProgress.js");
const {
  emptyEvidenceStore,
  setEvidence,
  emptyEvidenceEntry,
} = await import("../src/questionEvidence.js");
const { calculateStudyScore } = await import("../src/studyRank.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

const NOW_DAY = new Date(2026, 7, 7, 23, 59, 0).getTime(); // 2026-08-07 23:59 本地时间
const NEXT_DAY = new Date(2026, 7, 8, 12, 0, 0).getTime();

function passageWithSentences(sentencesByParagraph = [["Hello world.", "It is fine."]]) {
  return {
    id: "p1",
    paragraphs: sentencesByParagraph.map((sentences, index) => ({
      number: index + 1,
      text: sentences.join(" "),
      sentences,
    })),
    questions: [],
  };
}

test("23:59 完成文章：dueDate 是明日本地日历日而不是 +24h", () => {
  fresh();
  const sourceDate = localDateKey(NOW_DAY);
  const result = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(sourceDate, "2026-08-07");
  assert.equal(result.task.sourceDate, "2026-08-07");
  assert.equal(result.task.dueDate, "2026-08-08");
  assert.equal(addCalendarDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addCalendarDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addCalendarDays("2026-03-01", -1), "2026-02-28");
  assert.equal(dateDiffDays("2026-08-08", "2026-08-09"), 1);
});

test("重复完成事件不重复创建任务", () => {
  fresh();
  const first = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  const second = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NEXT_DAY });
  assert.equal(second.created, false);
  assert.equal(second.task.taskKey, first.task.taskKey);
  assert.equal(listReviewTasks().length, 1);
});

test("不扫描旧 completed 文章批量创建任务", () => {
  fresh();
  setUserItem("wuliao:reading-activity:r1:p1", JSON.stringify({
    resourceId: "r1",
    passageId: "p1",
    completed: true,
    completedAt: 1000,
  }));
  setUserItem("wuliao:reading-activity:r2:p2", JSON.stringify({
    resourceId: "r2",
    passageId: "p2",
    completed: true,
    completedAt: 2000,
  }));
  assert.equal(listReviewTasks().length, 0);
});

test("scheduled / due / overdue 实时推导正确", () => {
  fresh();
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  let task = created.task;
  assert.equal(reviewTaskStatus(task, "2026-08-07"), "scheduled");
  assert.equal(reviewTaskStatus(task, "2026-08-08"), "due");
  task.dueDate = "2026-08-07";
  assert.equal(reviewTaskStatus(task, "2026-08-08"), "overdue");
  assert.equal(overdueDays(task, "2026-08-09"), 2);
});

test("overdue 任务不会自动删除且仍可开始", () => {
  fresh();
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  const task = created.task;
  task.dueDate = "2026-08-06";
  saveReviewTask(task);
  assert.equal(listReviewTasks().length, 1);
  assert.equal(reviewTaskStatus(task, "2026-08-08"), "overdue");
  const started = startReviewSession(task.taskKey, NEXT_DAY);
  assert.equal(started.ok, true);
  assert.equal(reviewTaskStatus(started.task, "2026-08-08"), "in_progress");
});

test("skip 保存 skippedAt，不删除任务、不改 reading-activity", () => {
  fresh();
  setUserItem("wuliao:reading-activity:r1:p1", JSON.stringify({
    resourceId: "r1",
    passageId: "p1",
    completed: true,
    completedAt: 1000,
  }));
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  const result = skipReviewTask(created.task.taskKey, NEXT_DAY);
  assert.equal(result.ok, true);
  const reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reloaded.skippedAt, NEXT_DAY);
  assert.equal(reviewTaskStatus(reloaded, "2026-08-08"), "skipped");
  assert.equal(listReviewTasks().length, 1);
  const activity = JSON.parse(getUserItem("wuliao:reading-activity:r1:p1"));
  assert.equal(activity.completed, true);
  assert.equal(activity.completedAt, 1000);
  const again = skipReviewTask(created.task.taskKey, NEXT_DAY + 1);
  assert.equal(again.task.skippedAt, NEXT_DAY);
});

test("completed review 不改变 reading-activity，也不增加 studyRank 精读分", () => {
  fresh();
  setUserItem("wuliao:reading-activity:r1:p1", JSON.stringify({
    resourceId: "r1",
    passageId: "p1",
    completed: true,
    completedAt: 1000,
  }));
  const before = calculateStudyScore(0, 5);
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  startReviewSession(created.task.taskKey, NEXT_DAY);
  const completed = completeReviewSession(created.task.taskKey, {
    paragraphRecallCount: 2,
    masteredCount: 1,
    difficultCount: 1,
  }, NEXT_DAY + 60000);
  assert.equal(completed.ok, true);
  const reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reviewTaskStatus(reloaded, "2026-08-08"), "completed");
  const activity = JSON.parse(getUserItem("wuliao:reading-activity:r1:p1"));
  assert.equal(activity.completedAt, 1000);
  const after = calculateStudyScore(0, 5);
  assert.deepEqual(after, before);
});

test("不同 resource / passage 任务隔离", () => {
  fresh();
  createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  createNextDayReviewTask({ resourceId: "r1", passageId: "p2", now: NOW_DAY });
  createNextDayReviewTask({ resourceId: "r2", passageId: "p1", now: NOW_DAY });
  assert.equal(listReviewTasks().length, 3);
  assert.notEqual(
    reviewTaskKey({ type: TASK_TYPE_NEXT_DAY, resourceId: "r1", passageId: "p1", sourceDate: "2026-08-07" }),
    reviewTaskKey({ type: TASK_TYPE_NEXT_DAY, resourceId: "r1", passageId: "p2", sourceDate: "2026-08-07" }),
  );
});

test("不同账号任务完全隔离", () => {
  fresh();
  createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  setCurrentUsername("bob");
  assert.equal(listReviewTasks().length, 0);
  createNextDayReviewTask({ resourceId: "r2", passageId: "p2", now: NOW_DAY });
  assert.equal(listReviewTasks().length, 1);
  setCurrentUsername("alice");
  assert.equal(listReviewTasks().length, 1);
  assert.equal(listReviewTasks()[0].resourceId, "r1");
});

test("Review Session 进度刷新后恢复", () => {
  fresh();
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  const started = startReviewSession(created.task.taskKey, NEXT_DAY);
  updateReviewSession(created.task.taskKey, {
    currentStep: "difficult_sentences",
    paragraphRecall: { "1": { completedAt: NEXT_DAY, summary: "one line" } },
    sentenceResults: { [sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." })]: "mastered" },
    reviewAnswers: { "r1::p1::q21::abc": "C" },
  }, NEXT_DAY + 1000);
  const reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reloaded.session.currentStep, "difficult_sentences");
  assert.equal(reloaded.session.paragraphRecall["1"].summary, "one line");
  assert.equal(reloaded.session.reviewAnswers["r1::p1::q21::abc"], "C");
  assert.ok(Object.values(reloaded.session.sentenceResults)[0] === "mastered");
});

test("Review Session 前台计时：后台时间不累计", () => {
  fresh();
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  const started = startReviewSession(created.task.taskKey, 1000);
  assert.equal(started.task.session.activeSince, 1000);
  updateReviewSession(created.task.taskKey, {}, 5000); // 前台 4 秒后折叠
  let reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reloaded.session.activeDurationMs, 4000);
  // 模拟进入后台：暂停计时并停表
  pauseReviewTiming(created.task.taskKey, 5000);
  reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reloaded.session.activeDurationMs, 4000);
  assert.equal(reloaded.session.activeSince, null);
  // 暂停期间任何进度更新都不应把后台时间计入
  updateReviewSession(created.task.taskKey, { currentStep: "difficult_sentences" }, 7250000);
  reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reloaded.session.activeDurationMs, 4000);
  // 2 小时后台后回到前台：恢复计时，后台时间不计入
  resumeReviewTiming(created.task.taskKey, 7250000);
  reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reloaded.session.activeSince, 7250000);
  updateReviewSession(created.task.taskKey, {}, 7251000);
  reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reloaded.session.activeDurationMs, 5000);
});

test("Review Session 不修改 A workflow currentStage", () => {
  fresh();
  setUserItem("wuliao:reading-flow:r1:p1", JSON.stringify({
    schemaVersion: 1,
    resourceId: "r1",
    passageId: "p1",
    stages: {
      "deep-cover": { status: "completed", completedAt: 1 },
      "deep-first-read": { status: "current", completedAt: null },
    },
    currentStage: "deep-first-read",
    timedReading: { phase: "idle", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: null },
    updatedAt: 10,
  }));
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  updateReviewSession(created.task.taskKey, { currentStep: "wrong_questions" }, NEXT_DAY);
  const flow = JSON.parse(getUserItem("wuliao:reading-flow:r1:p1"));
  assert.equal(flow.currentStage, "deep-first-read");
  assert.equal(flow.stages["deep-first-read"].status, "current");
});

test("Review Session 不修改普通 scroll progress", () => {
  fresh();
  setUserItem("wuliao:deep-position:r1", JSON.stringify({
    passageId: "p1",
    anchorId: "deep-translation",
    scrollY: 12345,
    updatedAt: 99,
  }));
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  updateReviewSession(created.task.taskKey, { currentStep: "check" }, NEXT_DAY);
  const position = JSON.parse(getUserItem("wuliao:deep-position:r1"));
  assert.equal(position.scrollY, 12345);
});

test("reviewAnswer 不覆盖 first / redo answers", () => {
  fresh();
  setUserItem("wuliao:deep-answers:r1:p1:first", JSON.stringify({ 21: "A", 22: "B" }));
  setUserItem("wuliao:deep-answers:r1:p1:redo", JSON.stringify({ 21: "C" }));
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  updateReviewSession(created.task.taskKey, {
    reviewAnswers: { "r1::p1::q21::abc": "D" },
  }, NEXT_DAY);
  assert.deepEqual(JSON.parse(getUserItem("wuliao:deep-answers:r1:p1:first")), { 21: "A", 22: "B" });
  assert.deepEqual(JSON.parse(getUserItem("wuliao:deep-answers:r1:p1:redo")), { 21: "C" });
});

test("first / redo evidence 不被 Review Session 修改", () => {
  fresh();
  let store = emptyEvidenceStore("r1", "p1");
  store = setEvidence(store, "r1::p1::q21::abc", "first", emptyEvidenceEntry(1000));
  const rawBefore = JSON.stringify(store);
  setUserItem("wuliao:question-evidence:r1:p1", rawBefore);
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  updateReviewSession(created.task.taskKey, {
    reviewAnswers: { "r1::p1::q21::abc": "B" },
  }, NEXT_DAY);
  assert.equal(getUserItem("wuliao:question-evidence:r1:p1"), rawBefore);
});

test("B needs_review 正确进入困难句列表并解析", () => {
  fresh();
  const passage = passageWithSentences();
  let progress = emptyProgress("r1", "p1");
  progress = markTranslated(progress, sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." }), 1);
  progress = markCorrected(progress, sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." }), { translationText: "你好。", now: 2 });
  progress = setReviewStatus(progress, sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." }), "needs_review", 3);
  const keys = listNeedsReviewSentenceKeys(progress);
  assert.equal(keys.length, 1);
  const resolved = resolveSentenceKeys(passage, keys);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "resolved");
  assert.equal(resolved[0].paragraphNumber, 1);
  assert.equal(resolved[0].sentenceIndex, 0);
});

test("mastered 句子不进入困难句列表", () => {
  fresh();
  const key = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  let progress = emptyProgress("r1", "p1");
  progress = markTranslated(progress, key, 1);
  progress = markCorrected(progress, key, { translationText: "你好。", now: 2 });
  progress = setReviewStatus(progress, key, "mastered", 3);
  assert.equal(listNeedsReviewSentenceKeys(progress).length, 0);
});

test("现在能独立理解：needs_review -> mastered 并保存 reviewedAt", () => {
  fresh();
  const key = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  let progress = emptyProgress("r1", "p1");
  progress = markTranslated(progress, key, 1);
  progress = markCorrected(progress, key, { translationText: "你好。", now: 2 });
  progress = setReviewStatus(progress, key, "needs_review", 3);
  const updated = setReviewStatus(progress, key, "mastered", 4000);
  assert.equal(updated.sentences[key].reviewStatus, "mastered");
  assert.equal(updated.sentences[key].reviewedAt, 4000);
  assert.equal(updated.sentences[key].translationStatus, "corrected");
  assert.equal(updated.sentences[key].correctedAt, 2);
});

test("仍然困难：保持 needs_review，并创建 +3 日 sentence_recheck", () => {
  fresh();
  const key = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  let progress = emptyProgress("r1", "p1");
  progress = markTranslated(progress, key, 1);
  progress = markCorrected(progress, key, { translationText: "你好。", now: 2 });
  progress = setReviewStatus(progress, key, "needs_review", 3);
  assert.equal(progress.sentences[key].reviewStatus, "needs_review");
  const recheck = ensureSentenceRecheckTask({
    resourceId: "r1",
    passageId: "p1",
    sentenceKeys: [key],
    now: NOW_DAY,
  });
  assert.equal(recheck.ok, true);
  assert.equal(recheck.task.type, TASK_TYPE_SENTENCE_RECHECK);
  assert.equal(recheck.task.sourceDate, "2026-08-07");
  assert.equal(recheck.task.dueDate, "2026-08-10");
  assert.deepEqual(recheck.task.sentenceKeys, [key]);
});

test("sentence recheck 重复操作合并而不是重复创建", () => {
  fresh();
  const keyA = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  const keyB = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 1, sentenceText: "It is fine." });
  const first = ensureSentenceRecheckTask({ resourceId: "r1", passageId: "p1", sentenceKeys: [keyA], now: NOW_DAY });
  const second = ensureSentenceRecheckTask({ resourceId: "r1", passageId: "p1", sentenceKeys: [keyA, keyB], now: NEXT_DAY });
  assert.equal(second.created, undefined);
  assert.equal(second.task.taskKey, first.task.taskKey);
  assert.deepEqual(second.task.sentenceKeys.sort(), [keyA, keyB].sort());
  assert.equal(listReviewTasks().filter((t) => t.type === TASK_TYPE_SENTENCE_RECHECK).length, 1);
});

test("复查任务内部仍困难时排除当前任务并新建 +3 日任务", () => {
  fresh();
  const key = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Hello world." });
  const current = ensureSentenceRecheckTask({
    resourceId: "r1",
    passageId: "p1",
    sentenceKeys: [key],
    now: NOW_DAY,
  });
  startReviewSession(current.task.taskKey, NEXT_DAY);
  const next = ensureSentenceRecheckTask({
    resourceId: "r1",
    passageId: "p1",
    sentenceKeys: [key],
    now: NEXT_DAY,
    excludeTaskKey: current.task.taskKey,
  });
  assert.equal(next.ok, true);
  assert.notEqual(next.task.taskKey, current.task.taskKey);
  assert.equal(next.task.sourceDate, "2026-08-08");
  assert.equal(next.task.dueDate, "2026-08-11");
  assert.equal(
    listReviewTasks().filter((t) => t.type === TASK_TYPE_SENTENCE_RECHECK).length,
    2,
  );
});

test("无错题时 wrong_questions 自动跳过", () => {
  fresh();
  const result = wrongQuestionKeys({
    resourceId: "r1",
    passageId: "p1",
    questions: [
      { number: 21, stem: "What is the main idea?" },
      { number: 22, stem: "Why did the author say that?" },
    ],
    firstAnswers: { 21: "A", 22: "B" },
    redoAnswers: { 21: "A", 22: "B" },
    correctAnswers: { 21: "A", 22: "B" },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "none-wrong");
  assert.deepEqual(result.keys, []);
});

test("有错题时生成正确复查集合（first 或 redo 错）", () => {
  fresh();
  const result = wrongQuestionKeys({
    resourceId: "r1",
    passageId: "p1",
    questions: [
      { number: 21, stem: "Q21 stem?" },
      { number: 22, stem: "Q22 stem?" },
      { number: 23, stem: "Q23 stem?" },
    ],
    firstAnswers: { 21: "A", 22: "C", 23: "B" },
    redoAnswers: { 21: "A", 22: "C", 23: "D" },
    correctAnswers: { 21: "A", 22: "B", 23: "B" },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.questions.length, 2);
  assert.deepEqual(result.questions.map((q) => q.number), [22, 23]);
  assert.equal(result.keys.length, 2);
});

test("无官方答案时 wrong_questions 自动跳过并说明原因", () => {
  fresh();
  const result = wrongQuestionKeys({
    resourceId: "r1",
    passageId: "p1",
    questions: [{ number: 21, stem: "Q?" }],
    firstAnswers: { 21: "A" },
    redoAnswers: {},
    correctAnswers: {},
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no-answer-key");
});

test("check 未解锁前不能访问（reviewCheckUnlocked 边界）", () => {
  fresh();
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  assert.equal(reviewCheckUnlocked(created.task), false);
  startReviewSession(created.task.taskKey, NEXT_DAY);
  updateReviewSession(created.task.taskKey, { currentStep: "difficult_sentences" }, NEXT_DAY + 1);
  assert.equal(reviewCheckUnlocked(loadReviewTask(created.task.taskKey)), false);
});

test("主动提取步骤全部完成后 check 解锁", () => {
  fresh();
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  startReviewSession(created.task.taskKey, NEXT_DAY);
  updateReviewSession(created.task.taskKey, { currentStep: "check", checkUnlocked: true }, NEXT_DAY + 1);
  const reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reloaded.session.checkUnlocked, true);
  assert.equal(reloaded.session.currentStep, "check");
  assert.equal(reviewCheckUnlocked(reloaded), true);
});

test("Review Session 完成 -> task completed，历史 completion 不受影响", () => {
  fresh();
  setUserItem("wuliao:reading-activity:r1:p1", JSON.stringify({
    resourceId: "r1",
    passageId: "p1",
    completed: true,
    completedAt: 111,
  }));
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  startReviewSession(created.task.taskKey, NEXT_DAY);
  const completed = completeReviewSession(created.task.taskKey, {
    paragraphRecallCount: 2,
    masteredCount: 1,
    difficultCount: 1,
  }, NEXT_DAY + 1000);
  assert.equal(completed.ok, true);
  const reloaded = loadReviewTask(created.task.taskKey);
  assert.equal(reloaded.completedAt, NEXT_DAY + 1000);
  assert.equal(reloaded.session.summary.paragraphRecallCount, 2);
  assert.equal(JSON.parse(getUserItem("wuliao:reading-activity:r1:p1")).completedAt, 111);
});

test("parser 变化导致句子无法恢复 -> unresolved，不错误绑定", () => {
  fresh();
  const passage = passageWithSentences([["Different sentence now."]]);
  const oldKey = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: "Old sentence." });
  const resolved = resolveSentenceKeys(passage, [oldKey]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "unresolved");
  assert.equal(resolved[0].paragraphNumber, undefined);
});

test("手动安排旧文章复读：dueDate = 当天且幂等", () => {
  fresh();
  const first = scheduleManualReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  assert.equal(first.task.sourceDate, "2026-08-07");
  assert.equal(first.task.dueDate, "2026-08-07");
  assert.equal(reviewTaskStatus(first.task, "2026-08-07"), "due");
  const second = scheduleManualReviewTask({ resourceId: "r1", passageId: "p1", now: NEXT_DAY });
  assert.equal(second.created, false);
  assert.equal(listReviewTasks().length, 1);
});

test("首页统计：in_progress > overdue > due，未来不欠债", () => {
  fresh();
  const created = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY }); // due 08-08
  const dueTask = created.task;
  dueTask.dueDate = "2026-08-08";
  const summary = homeReviewSummary(listReviewTasks(), "2026-08-08");
  assert.equal(summary.todayCount, 1);
  assert.equal(summary.dueCount, 1);
  assert.equal(summary.upcomingCount, 0);
  createNextDayReviewTask({ resourceId: "r2", passageId: "p1", now: NEXT_DAY });
  const summary2 = homeReviewSummary(listReviewTasks(), "2026-08-08");
  assert.equal(summary2.upcomingCount, 1);
  assert.equal(summary2.future7Count, 1);
  assert.equal(summary2.todayCount, 1);
});

test("首页排序：in_progress 优先于 overdue 优先于 due，再按 dueDate", () => {
  fresh();
  const a = createNextDayReviewTask({ resourceId: "r1", passageId: "p1", now: NOW_DAY });
  const b = createNextDayReviewTask({ resourceId: "r2", passageId: "p1", now: NOW_DAY });
  const c = createNextDayReviewTask({ resourceId: "r3", passageId: "p1", now: NOW_DAY });
  a.task.dueDate = "2026-08-08";
  b.task.dueDate = "2026-08-07";
  c.task.dueDate = "2026-08-06";
  saveReviewTask(a.task);
  saveReviewTask(b.task);
  saveReviewTask(c.task);
  startReviewSession(c.task.taskKey, NEXT_DAY);
  const summary = homeReviewSummary(listReviewTasks(), "2026-08-08");
  assert.deepEqual(
    summary.todayItems.map(({ task }) => task.resourceId),
    ["r3", "r2", "r1"],
  );
});

test("taskKey 稳定且包含资源/文章/日期", () => {
  fresh();
  const key = reviewTaskKey({
    type: TASK_TYPE_NEXT_DAY,
    resourceId: "postgraduate-2021-text-3",
    passageId: "passage-3",
    sourceDate: "2026-08-07",
  });
  assert.equal(key, "review:next_day_article:postgraduate-2021-text-3:passage-3:2026-08-07");
  const key2 = reviewTaskKey({
    type: TASK_TYPE_NEXT_DAY,
    resourceId: "postgraduate-2021-text-3",
    passageId: "passage-3",
    sourceDate: "2026-08-07",
  });
  assert.equal(key, key2);
});
