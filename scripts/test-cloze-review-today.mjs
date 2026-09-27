import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
globalThis.indexedDB = undefined;

const { setCurrentUsername } = await import("../src/userData.js");
const {
  emptyClozeProgress,
  recordFirstAnswer,
  recordReviewAnswer,
  recordReviewConfidence,
} = await import("../src/clozeProgress.js");
const {
  TASK_TYPE_D1,
  scheduleClozeD1Task,
  startClozeReviewTask,
  recordClozeReviewAttempt,
  completeClozeReviewTask,
  scheduleClozeD7Task,
} = await import("../src/clozeReview.js");
const { scanLearningState, summarizeClozeReviewTasks } = await import("../src/todayTasks.js");
const { collectStudyCandidates, collectCompletedToday } = await import("../src/studyPlannerSources.js");
const { TASK_TYPE_CLOZE_REVIEW, TIER_OVERDUE_REVIEW, TIER_DUE_REVIEW } = await import("../src/studyPlanner.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function makeProgress() {
  let progress = emptyClozeProgress("postgraduate-2009-cloze", "cloze-2009", Array.from({ length: 20 }, (_, i) => i + 1), 1);
  progress = recordFirstAnswer(progress, 1, "A");
  progress = recordReviewAnswer(progress, 1, "B");
  progress = recordReviewConfidence(progress, 1, "confident");
  return progress;
}

const RESOURCES = [{
  id: "postgraduate-2009-cloze",
  kind: "official-cloze",
  year: 2009,
  title: "2009 英语（一）完形填空",
}];

const OFFICIAL = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, "A"]));

test("scan 读取 cloze review 任务行（不解析 cloze JSON）", () => {
  fresh();
  const scan = scanLearningState({ today: "2026-08-01", force: true });
  assert.equal(scan.clozeReviewTasks.length, 0);
  assert.ok(scan.clozeReviewSummary);
  assert.equal(scan.clozeReviewSummary.todayCount, 0);

  scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress: makeProgress(),
    officialAnswers: OFFICIAL,
  });
  const scan2 = scanLearningState({ today: "2026-08-02", force: true });
  assert.equal(scan2.clozeReviewTasks.length, 1);
  assert.equal(scan2.clozeReviewSummary.todayCount, 1);
  // 不扫描完形正文：scan 不包含 cloze-progress / cloze-flow 之外的解析
  assert.equal(scan2.clozeReviewTasks[0].targetBlankIds.length > 0, true);
});

test("planner 生成 cloze-review 候选：due/overdue/in_progress 分层", async () => {
  fresh();
  scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-07-30T10:00:00").getTime(),
    progress: makeProgress(),
    officialAnswers: OFFICIAL,
  });
  const { candidates } = await collectStudyCandidates({
    today: "2026-08-02",
    resources: RESOURCES,
    customPdfs: [],
    username: "alice",
    now: new Date("2026-08-02T12:00:00").getTime(),
    forceScan: true,
  });
  const clozeCandidates = candidates.filter((candidate) => candidate.type === TASK_TYPE_CLOZE_REVIEW);
  assert.equal(clozeCandidates.length, 1);
  const candidate = clozeCandidates[0];
  assert.equal(candidate.mandatory, true);
  assert.equal(candidate.action.type, "cloze-review");
  assert.ok(candidate.id.startsWith("cloze-review:cloze-review:d1:"));
  assert.equal(candidate.priorityTier, TIER_OVERDUE_REVIEW);
  assert.equal(candidate.overdueDays, 2);
  assert.ok(candidate.estimatedMinutes >= 2);
  // metadata 携带任务本身
  assert.equal(candidate.metadata.task.type, "d1");
});

test("Reading 原任务与 Cloze 候选互不影响（ID 不碰撞）", async () => {
  fresh();
  // 模拟一个 Reading review 任务
  const { createNextDayReviewTask } = await import("../src/readingReview.js");
  createNextDayReviewTask({
    resourceId: "postgraduate-2009-text-1",
    passageId: "p1",
    now: new Date("2026-07-30T10:00:00").getTime(),
  });
  scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-07-30T10:00:00").getTime(),
    progress: makeProgress(),
    officialAnswers: OFFICIAL,
  });
  const { candidates } = await collectStudyCandidates({
    today: "2026-08-02",
    resources: [...RESOURCES, { id: "postgraduate-2009-text-1", title: "2009 Text 1" }],
    customPdfs: [],
    username: "alice",
    now: new Date("2026-08-02T12:00:00").getTime(),
    forceScan: true,
  });
  const ids = candidates.map((candidate) => candidate.id);
  assert.equal(new Set(ids).size, ids.length);
  const reading = candidates.filter((candidate) => candidate.source === "readingReview");
  const cloze = candidates.filter((candidate) => candidate.source === "clozeReview");
  assert.equal(reading.length, 1);
  assert.equal(cloze.length, 1);
  assert.ok(!reading[0].id.includes("cloze-review"));
  assert.ok(!cloze[0].id.includes("review:next_day"));
});

test("历史 completed 数据零 backfill：不自动生成 overdue 任务", async () => {
  fresh();
  // 模拟 E 上线前已完成的完形（只有 flow 记录，没有 sidecar 任务）
  const { emptyClozeFlow, saveClozeFlow, completeClozeStage } = await import("../src/clozeFlow.js");
  let f = emptyClozeFlow("postgraduate-2010-cloze", "cloze-2010", 1000);
  for (const stage of ["cloze-cover", "cloze-first-attempt", "cloze-self-review", "cloze-correction", "cloze-analysis", "cloze-final-read"]) {
    f = completeClozeStage(f, stage, 1000 + 1);
  }
  saveClozeFlow(f);
  const scan = scanLearningState({ today: "2026-08-05", force: true });
  assert.equal(scan.clozeReviewTasks.length, 0);
  // 首页汇总不产生任何 overdue
  assert.equal(scan.clozeReviewSummary.overdueCount, 0);
  assert.equal(scan.clozeReviewSummary.todayCount, 0);
});

test("D+1 完成并 materialize D+7 后，in_progress / completed 状态正确", async () => {
  fresh();
  const d1 = scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress: makeProgress(),
    officialAnswers: OFFICIAL,
  });
  const d1Key = d1.task.taskKey;
  startClozeReviewTask(d1Key, 200);
  recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 1,
    attempt: { answer: "B", confidence: "confident", outcome: "wrong" },
    now: 300,
  });
  const d1Done = completeClozeReviewTask(d1Key, 310);
  const d7 = scheduleClozeD7Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    d1Task: d1Done,
    progress: makeProgress(),
    officialAnswers: OFFICIAL,
  });
  assert.ok(d7);
  const scan = scanLearningState({ today: "2026-08-02", force: true });
  assert.equal(scan.clozeReviewTasks.length, 2);
  const summary = summarizeClozeReviewTasks(scan.clozeReviewTasks, "2026-08-02");
  // D+1 已完成（不计入今日待办），D+7 为未来安排
  assert.equal(summary.todayCount, 0);
  assert.equal(summary.upcomingCount, 1);
  assert.equal(summary.completedCount, 1);
});

test("账号隔离：bob 看不到 alice 的完形复习任务", async () => {
  fresh();
  scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress: makeProgress(),
    officialAnswers: OFFICIAL,
  });
  const scanAlice = scanLearningState({ today: "2026-08-02", force: true });
  assert.equal(scanAlice.clozeReviewTasks.length, 1);
  globalThis.localStorage.clear();
  setCurrentUsername("bob");
  const scanBob = scanLearningState({ today: "2026-08-02", force: true });
  assert.equal(scanBob.clozeReviewTasks.length, 0);
});

test("collectCompletedToday 收录当天完成的完形复习", async () => {
  fresh();
  const d1 = scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress: makeProgress(),
    officialAnswers: OFFICIAL,
  });
  const d1Key = d1.task.taskKey;
  startClozeReviewTask(d1Key, new Date("2026-08-02T09:00:00").getTime());
  recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 1,
    attempt: { answer: "A", confidence: "confident", outcome: "correct" },
    now: new Date("2026-08-02T09:10:00").getTime(),
  });
  const done = completeClozeReviewTask(d1Key, new Date("2026-08-02T09:20:00").getTime());
  const scan = scanLearningState({ today: "2026-08-02", force: true });
  const completed = collectCompletedToday({
    scan,
    tasks: [],
    vocabState: null,
    resources: RESOURCES,
    customPdfs: [],
    today: "2026-08-02",
  });
  const clozeCompleted = completed.filter((item) => item.id.startsWith("completed-cloze-review"));
  assert.equal(clozeCompleted.length, 1);
  assert.equal(clozeCompleted[0].type, TASK_TYPE_CLOZE_REVIEW);
});
