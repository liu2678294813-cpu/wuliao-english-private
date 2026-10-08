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
const { emptyFlow, STAGES, completeStage } = await import("../src/readingFlow.js");
const {
  scheduleManualReviewTask,
  startReviewSession,
  completeReviewSession,
  localDateKey,
  addCalendarDays,
} = await import("../src/readingReview.js");
const {
  planStudyDay,
  estimateTaskDuration,
  priorityForTask,
  TASK_TYPE_REVIEW,
  TASK_TYPE_CONTINUE_READING,
  TASK_TYPE_LEARNING_REVIEW,
  TASK_TYPE_VOCABULARY_REVIEW,
  TASK_TYPE_NEW_READING,
  TIER_OVERDUE_REVIEW,
  TIER_DUE_REVIEW,
  TIER_CONTINUE_READING,
  TIER_LEARNING_REVIEW,
  TIER_NEW_READING,
  PLANNER_DURATION_DEFAULTS,
} = await import("../src/studyPlanner.js");
const {
  setPlanBudget,
  deferPlanTask,
  reincludePlanTask,
  loadPlanState,
  savePlanState,
  studyPlanStorageKey,
} = await import("../src/studyPlannerStorage.js");
const {
  collectStudyCandidates,
  collectCompletedToday,
  collectBlockedCandidates,
  readVocabularyTodayState,
  buildPlanState,
  listReviewTasks,
} = await import("../src/studyPlannerSources.js");

const TODAY = "2026-08-09";
const RECORDS_KEY = "wuliao:ai:learning-records";

test("旧 Planner 模拟任务 ID 静默保留但无可见任务，Planner 不读取 exam payload", async () => {
  fresh();
  delete globalThis.indexedDB;
  setUserItem("wuliao:exam-result:v1:legacy", JSON.stringify({ status: "submitted" }));
  setUserItem("wuliao:exam-session:v1:legacy", JSON.stringify({ status: "in_progress" }));
  const state = loadPlanState(TODAY);
  savePlanState({ ...state, deferredTaskIds: ["exam-followup:legacy"], budgetMinutes: 30, budgetConfirmed: true });
  const reads = [], storage = globalThis.localStorage, original = storage.getItem;
  storage.getItem = function (key) {
    if (String(key).includes("wuliao:exam-")) reads.push(key);
    return original.call(this, key);
  };
  try {
    const { plan, state: loaded } = await buildPlanState({ today: TODAY, resources: [officialResource()], customPdfs: [] });
    assert.ok(loaded.deferredTaskIds.includes("exam-followup:legacy"));
    assert.ok(![...plan.planned, ...plan.deferred, ...plan.completed, ...plan.overflow]
      .some((task) => String(task.id).includes("exam") || task.type === "exam-followup"));
    assert.deepEqual(reads, []);
  } finally { storage.getItem = original; }
});

function timestampFor(dateKey) {
  return new Date(`${dateKey}T12:00:00`).getTime();
}

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function officialResource(id = "r1") {
  return { id, kind: "official", year: 2021, text: 1, title: "2021 Text 1" };
}

function incompleteFlow(resourceId, passageId, now = Date.now(), currentStage = "deep-translation") {
  const flow = emptyFlow(resourceId, passageId, now);
  flow.currentStage = currentStage;
  flow.stages[currentStage] = { status: "current", completedAt: null };
  const currentIndex = STAGES.findIndex((stage) => stage.id === currentStage);
  STAGES.forEach((stage, index) => {
    if (index < currentIndex) flow.stages[stage.id] = { status: "completed", completedAt: now };
    else if (index > currentIndex) flow.stages[stage.id] = { status: "pending", completedAt: null };
  });
  flow.updatedAt = now;
  return flow;
}

function completedFlow(resourceId, passageId, now = Date.now()) {
  let flow = emptyFlow(resourceId, passageId, now);
  for (const stage of STAGES) flow = completeStage(flow, stage.id, now + 1);
  return flow;
}

function seedFlow(resourceId, passageId, flow) {
  setUserItem(`wuliao:reading-flow:${resourceId}:${passageId}`, JSON.stringify(flow));
}

function makeCandidate(overrides = {}) {
  return {
    id: "c:1",
    type: TASK_TYPE_NEW_READING,
    title: "任务",
    subtitle: "",
    estimatedMinutes: 15,
    priorityTier: TIER_NEW_READING,
    mandatory: false,
    dueDate: "",
    overdueDays: 0,
    reasonCodes: [],
    reasonText: "",
    action: {},
    metadata: {},
    ...overrides,
  };
}

function candidateIds(list) {
  return (list || []).map((item) => item.id);
}

function seedLearningRecords(records) {
  setUserItem(RECORDS_KEY, JSON.stringify(records));
}

function learningRecord(overrides = {}) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: "lr-1",
    identityKey: "r1||2021||translation-review||s1",
    key: "r1||2021||translation-review||s1",
    taskType: "translation-review",
    resourceId: "r1",
    chapter: "2021 Text 1",
    itemId: "s1",
    sentenceId: "s1",
    createdAt: now,
    updatedAt: now,
    reviewCount: 1,
    resolved: false,
    summary: {},
    tags: [],
    optionTrapTypes: [],
    errorTags: [],
    metadata: {},
    historyId: "",
    ...overrides,
  };
}

function fakeRequest(result) {
  const request = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    request.result = result;
    if (typeof request.onsuccess === "function") request.onsuccess();
  });
  return request;
}

function fakeIndexedDbWithRecords(records, { hasStore = true } = {}) {
  return {
    open() {
      const database = {
        objectStoreNames: { contains: (name) => hasStore && name === "records" },
        transaction() {
          return {
            objectStore() {
              return {
                getAll() {
                  return fakeRequest(records);
                },
              };
            },
          };
        },
        close() {},
      };
      return fakeRequest(database);
    },
  };
}

function vocabRecord(wordId, date, extra = {}) {
  return {
    username: "alice",
    memoryKey: `k:${wordId}`,
    wordId,
    listKey: "l1",
    maskedDates: [date],
    updatedAt: Date.now(),
    ...extra,
  };
}

test("稳定 Task ID：同样数据连续生成两次完全一致", async () => {
  fresh();
  const now = Date.now();
  seedFlow("r1", "p1", incompleteFlow("r1", "p1", now));
  const created = scheduleManualReviewTask({ resourceId: "r1", passageId: "p1", now: timestampFor(TODAY) });
  assert.equal(created.ok, true);
  const first = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now,
  });
  const second = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now,
  });
  assert.deepEqual(candidateIds(first.candidates), candidateIds(second.candidates));
  assert.ok(candidateIds(first.candidates).includes(`review:${created.task.taskKey}`));
  assert.ok(candidateIds(first.candidates).includes("reading:r1:p1"));
});

test("无预算：给出推荐顺序且不伪造剩余分钟", () => {
  const candidates = [
    makeCandidate({ id: "a", type: TASK_TYPE_REVIEW, priorityTier: TIER_DUE_REVIEW, mandatory: true, estimatedMinutes: 15 }),
    makeCandidate({ id: "b", type: TASK_TYPE_CONTINUE_READING, priorityTier: TIER_CONTINUE_READING, estimatedMinutes: 20 }),
    makeCandidate({ id: "c", type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING, estimatedMinutes: 40 }),
  ];
  const plan = planStudyDay(candidates, {
    date: TODAY,
    budgetMinutes: null,
    budgetConfirmed: false,
    generatedAt: 1,
  });
  assert.equal(plan.budgetConfirmed, false);
  assert.deepEqual(candidateIds(plan.planned), ["a", "b", "c"]);
  assert.equal(plan.remainingMinutes, null);
  assert.equal(plan.overBudgetMinutes, null);
  assert.equal(plan.plannedMinutes, 75);
});

test("60 分钟预算正确填充 planned / remaining", () => {
  const candidates = [
    makeCandidate({ id: "review", type: TASK_TYPE_REVIEW, priorityTier: TIER_DUE_REVIEW, mandatory: true, estimatedMinutes: 15 }),
    makeCandidate({ id: "learning", type: TASK_TYPE_LEARNING_REVIEW, priorityTier: TIER_LEARNING_REVIEW, estimatedMinutes: 10 }),
    makeCandidate({ id: "new", type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING, estimatedMinutes: 40 }),
  ];
  const plan = planStudyDay(candidates, {
    date: TODAY,
    budgetMinutes: 60,
    budgetConfirmed: true,
    generatedAt: 1,
  });
  assert.deepEqual(candidateIds(plan.planned), ["review", "learning"]);
  assert.deepEqual(candidateIds(plan.overflow), ["new"]);
  assert.equal(plan.plannedMinutes, 25);
  assert.equal(plan.remainingMinutes, 35);
  assert.equal(plan.overBudgetMinutes, 0);
  assert.equal(plan.mandatoryMinutes, 15);
});

test("强制任务超预算：全部保留并报告超预算，不隐藏", () => {
  const candidates = [
    makeCandidate({ id: "m1", type: TASK_TYPE_REVIEW, priorityTier: TIER_OVERDUE_REVIEW, mandatory: true, estimatedMinutes: 35 }),
    makeCandidate({ id: "m2", type: TASK_TYPE_REVIEW, priorityTier: TIER_DUE_REVIEW, mandatory: true, estimatedMinutes: 30 }),
    makeCandidate({ id: "new", type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING, estimatedMinutes: 40 }),
  ];
  const plan = planStudyDay(candidates, {
    date: TODAY,
    budgetMinutes: 60,
    budgetConfirmed: true,
    generatedAt: 1,
  });
  assert.deepEqual(candidateIds(plan.planned), ["m1", "m2"]);
  assert.equal(plan.plannedMinutes, 65);
  assert.equal(plan.overBudgetMinutes, 5);
  assert.equal(plan.remainingMinutes, 0);
  assert.deepEqual(candidateIds(plan.overflow), ["new"]);
});

test("逾期复读优先于今日到期 / 继续精读 / 新精读", () => {
  const candidates = [
    makeCandidate({ id: "due", type: TASK_TYPE_REVIEW, priorityTier: TIER_DUE_REVIEW, mandatory: true, dueDate: TODAY }),
    makeCandidate({ id: "continue", type: TASK_TYPE_CONTINUE_READING, priorityTier: TIER_CONTINUE_READING, metadata: { updatedAt: 1 } }),
    makeCandidate({ id: "overdue", type: TASK_TYPE_REVIEW, priorityTier: TIER_OVERDUE_REVIEW, mandatory: true, overdueDays: 2, dueDate: "2026-08-07" }),
    makeCandidate({ id: "new", type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING }),
  ];
  const plan = planStudyDay(candidates, { date: TODAY, budgetConfirmed: false, generatedAt: 1 });
  assert.deepEqual(candidateIds(plan.planned), ["overdue", "due", "continue", "new"]);
});

test("逾期天数影响组内排序且有上限", () => {
  const candidates = [
    makeCandidate({ id: "old1", type: TASK_TYPE_REVIEW, priorityTier: TIER_OVERDUE_REVIEW, mandatory: true, overdueDays: 1, dueDate: "2026-08-08" }),
    makeCandidate({ id: "old3", type: TASK_TYPE_REVIEW, priorityTier: TIER_OVERDUE_REVIEW, mandatory: true, overdueDays: 3, dueDate: "2026-08-06" }),
    makeCandidate({ id: "ancient", type: TASK_TYPE_REVIEW, priorityTier: TIER_OVERDUE_REVIEW, mandatory: true, overdueDays: 30, dueDate: "2026-07-01" }),
  ];
  const plan = planStudyDay(candidates, { date: TODAY, budgetConfirmed: false, generatedAt: 1 });
  assert.deepEqual(candidateIds(plan.planned), ["ancient", "old3", "old1"]);
});

test("今天到期复读优先于开始新精读", () => {
  const plan = planStudyDay([
    makeCandidate({ id: "new", type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING }),
    makeCandidate({ id: "due", type: TASK_TYPE_REVIEW, priorityTier: TIER_DUE_REVIEW, mandatory: true, dueDate: TODAY }),
  ], { date: TODAY, budgetConfirmed: false, generatedAt: 1 });
  assert.deepEqual(candidateIds(plan.planned), ["due", "new"]);
});

test("进行中精读优先于新精读", () => {
  const plan = planStudyDay([
    makeCandidate({ id: "new", type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING }),
    makeCandidate({ id: "continue", type: TASK_TYPE_CONTINUE_READING, priorityTier: TIER_CONTINUE_READING, metadata: { updatedAt: 9 } }),
  ], { date: TODAY, budgetConfirmed: false, generatedAt: 1 });
  assert.deepEqual(candidateIds(plan.planned), ["continue", "new"]);
});

test("依赖：前置阶段未完成不出现后续候选，blocked 说明原因", async () => {
  fresh();
  seedFlow("r1", "p1", incompleteFlow("r1", "p1", 1000, "deep-translation"));
  const { candidates, scan } = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now: 2000,
  });
  const reading = candidates.find((item) => item.type === TASK_TYPE_CONTINUE_READING);
  assert.ok(reading);
  assert.equal(reading.metadata.stageId, "deep-translation");
  assert.equal(candidates.some((item) => item.metadata?.stageId === "deep-redo"), false);
  const blocked = collectBlockedCandidates({ scan, resources: [officialResource()], customPdfs: [] });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].blocked, true);
  assert.match(blocked[0].blockedReason, /逐段精读/);
  assert.match(blocked[0].blockedReason, /重做/);
});

test("defer 只影响当天计划，不改变业务状态", async () => {
  fresh();
  const now = Date.now();
  seedFlow("r1", "p1", incompleteFlow("r1", "p1", now));
  const created = scheduleManualReviewTask({ resourceId: "r1", passageId: "p1", now });
  assert.equal(created.ok, true);
  const reviewKey = `wuliao:review-task:${created.task.taskKey}`;
  const before = getUserItem(reviewKey);

  const result = await buildPlanState({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now,
  });
  assert.ok(candidateIds(result.plan.planned).includes("new-reading"));
  deferPlanTask(TODAY, "new-reading", { now });
  const after = await buildPlanState({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now,
  });
  assert.equal(candidateIds(after.plan.planned).includes("new-reading"), false);
  assert.deepEqual(candidateIds(after.plan.deferred), ["new-reading"]);
  assert.equal(getUserItem(reviewKey), before, "defer 不得改变复读业务状态");

  reincludePlanTask(TODAY, "new-reading", { now });
  const restored = await buildPlanState({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now,
  });
  assert.ok(candidateIds(restored.plan.planned).includes("new-reading"));
});

test("昨天 defer 不影响今天", () => {
  fresh();
  setPlanBudget(TODAY, 60, { now: 1 });
  deferPlanTask(TODAY, "new-reading", { now: 2 });
  const tomorrow = addCalendarDays(TODAY, 1);
  const todayState = loadPlanState(TODAY);
  const tomorrowState = loadPlanState(tomorrow);
  assert.deepEqual(todayState.deferredTaskIds, ["new-reading"]);
  assert.equal(tomorrowState.budgetConfirmed, false);
  assert.deepEqual(tomorrowState.deferredTaskIds, []);
});

test("账号隔离：预算与 defer 互不影响", () => {
  fresh();
  setPlanBudget(TODAY, 60, { now: 1 });
  deferPlanTask(TODAY, "new-reading", { now: 2 });
  setCurrentUsername("bob");
  const bobState = loadPlanState(TODAY);
  assert.equal(bobState.budgetMinutes, null);
  assert.deepEqual(bobState.deferredTaskIds, []);
  setPlanBudget(TODAY, 120, { now: 3 });
  setCurrentUsername("alice");
  const aliceState = loadPlanState(TODAY);
  assert.equal(aliceState.budgetMinutes, 60);
  assert.deepEqual(aliceState.deferredTaskIds, ["new-reading"]);
});

test("真实完成：复读完成后自动移出待办并进入 completedToday", async () => {
  fresh();
  const now = Date.now();
  const created = scheduleManualReviewTask({ resourceId: "r1", passageId: "p1", now: timestampFor(TODAY) });
  const before = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now,
  });
  assert.ok(before.candidates.some((item) => item.id === `review:${created.task.taskKey}`));

  const started = startReviewSession(created.task.taskKey, now);
  completeReviewSession(started.task.taskKey, { summary: {} }, timestampFor(TODAY));
  const after = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now,
  });
  assert.equal(after.candidates.some((item) => item.id === `review:${created.task.taskKey}`), false);
  const tasks = listReviewTasks();
  const completed = collectCompletedToday({
    scan: after.scan,
    tasks,
    vocabState: after.vocabState,
    resources: [officialResource()],
    customPdfs: [],
    today: TODAY,
  });
  assert.ok(completed.some((item) => item.id === `completed-review:${created.task.taskKey}`));
});

test("整篇精读今天完成计入 completedToday", async () => {
  fresh();
  seedFlow("r1", "p1", completedFlow("r1", "p1", timestampFor(TODAY)));
  const { scan } = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now: Date.now(),
  });
  const completed = collectCompletedToday({
    scan,
    tasks: scan.tasks,
    vocabState: { available: false },
    resources: [officialResource()],
    customPdfs: [],
    today: TODAY,
  });
  assert.ok(completed.some((item) => item.id === "completed-reading:r1:p1"));
});

test("可靠标签进入复盘理由，低置信度未确认不算强依据", async () => {
  fresh();
  const now = Date.now();
  seedLearningRecords([
    learningRecord({
      id: "lr-high",
      taskType: "question-diagnosis",
      tags: [{ name: "同义替换未识别", source: "ai-inferred", confidence: "high", status: "active" }],
    }),
    learningRecord({
      id: "lr-translation",
      tags: [{ name: "漏译", source: "ai-direct", confidence: "high", status: "active" }],
    }),
    learningRecord({
      id: "lr-low",
      taskType: "question-diagnosis",
      tags: [{ name: "粗心", source: "ai-inferred", confidence: "low", status: "active" }],
    }),
  ]);
  const { candidates } = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now,
  });
  const learning = candidates.find((item) => item.type === TASK_TYPE_LEARNING_REVIEW);
  assert.ok(learning);
  assert.equal(learning.metadata.recordCount, 2);
  assert.match(learning.reasonText, /2 条待复盘记录/);
  assert.match(learning.reasonText, /漏译 1 次/);
  assert.match(learning.reasonText, /同义替换未识别 1 次/);
  assert.doesNotMatch(learning.reasonText, /粗心/);
});

test("只有低置信度未确认标签时不生成学习复盘任务", async () => {
  fresh();
  seedLearningRecords([
    learningRecord({
      id: "lr-low",
      taskType: "question-diagnosis",
      tags: [{ name: "粗心", source: "ai-inferred", confidence: "low", status: "active" }],
    }),
  ]);
  const { candidates } = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now: Date.now(),
  });
  assert.equal(candidates.some((item) => item.type === TASK_TYPE_LEARNING_REVIEW), false);
});

test("词汇适配器：今日有复习", async () => {
  fresh();
  globalThis.indexedDB = fakeIndexedDbWithRecords([
    vocabRecord("w1", TODAY),
    vocabRecord("w2", TODAY),
    vocabRecord("w3", "2026-08-01"),
  ]);
  const state = await readVocabularyTodayState({ username: "alice", date: TODAY });
  assert.equal(state.available, true);
  assert.equal(state.dueCount, 2);
  assert.equal(state.completed, false);
});

test("词汇适配器：今日已完成", async () => {
  fresh();
  globalThis.indexedDB = fakeIndexedDbWithRecords([
    vocabRecord("w1", TODAY),
    vocabRecord("w2", TODAY),
  ]);
  globalThis.localStorage.setItem(
    `kaoyan_vocab_daily_review:alice:${TODAY}`,
    JSON.stringify({ currentIndex: 2, total: 2, updatedAt: 1234 }),
  );
  const state = await readVocabularyTodayState({ username: "alice", date: TODAY });
  assert.equal(state.dueCount, 2);
  assert.equal(state.completed, true);
  assert.equal(state.completedAt, 1234);
});

test("词汇适配器：无账号 / DB 不可用 / 损坏都安全降级", async () => {
  fresh();
  const noAccount = await readVocabularyTodayState({ username: "", date: TODAY });
  assert.deepEqual(noAccount, { available: false, reason: "no-account" });

  const rejected = await readVocabularyTodayState({
    username: "alice",
    date: TODAY,
    openDb: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(rejected.available, false);
  assert.equal(rejected.reason, "error");

  globalThis.indexedDB = fakeIndexedDbWithRecords([], { hasStore: false });
  const missingStore = await readVocabularyTodayState({ username: "alice", date: TODAY });
  assert.equal(missingStore.available, false);
  assert.equal(missingStore.reason, "error");

  delete globalThis.indexedDB;
  const { candidates } = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now: Date.now(),
  });
  assert.equal(candidates.some((item) => item.type === TASK_TYPE_VOCABULARY_REVIEW), false);
  assert.ok(candidates.length >= 1);
});

test("词汇复习候选出现在计划中并可进入现有复习页", async () => {
  fresh();
  globalThis.indexedDB = fakeIndexedDbWithRecords([vocabRecord("w1", TODAY)]);
  const { candidates } = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now: Date.now(),
  });
  const vocabulary = candidates.find((item) => item.type === TASK_TYPE_VOCABULARY_REVIEW);
  assert.ok(vocabulary);
  assert.equal(vocabulary.id, `vocabulary-review:${TODAY}`);
  assert.equal(vocabulary.estimatedMinutes, 6);
  assert.deepEqual(vocabulary.action, { type: "vocabulary-review", date: TODAY });
});

test("删除自定义 PDF 后不生成僵尸候选", async () => {
  fresh();
  seedFlow("ghost", "p1", incompleteFlow("ghost", "p1", 1000));
  const { candidates, scan } = await collectStudyCandidates({
    today: TODAY,
    resources: [officialResource()],
    customPdfs: [],
    now: Date.now(),
  });
  assert.equal(candidates.some((item) => item.metadata?.resourceId === "ghost"), false);
  const blocked = collectBlockedCandidates({ scan, resources: [officialResource()], customPdfs: [] });
  assert.equal(blocked.some((item) => item.metadata?.resourceId === "ghost"), false);
});

test("排序稳定性：相同输入两次顺序完全一致", () => {
  const candidates = [
    makeCandidate({ id: "new", type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING }),
    makeCandidate({ id: "continue", type: TASK_TYPE_CONTINUE_READING, priorityTier: TIER_CONTINUE_READING, metadata: { updatedAt: 5 } }),
    makeCandidate({ id: "due", type: TASK_TYPE_REVIEW, priorityTier: TIER_DUE_REVIEW, mandatory: true, dueDate: TODAY }),
  ];
  const first = planStudyDay(candidates, { date: TODAY, budgetConfirmed: false, generatedAt: 1 });
  const second = planStudyDay(candidates, { date: TODAY, budgetConfirmed: false, generatedAt: 1 });
  assert.deepEqual(candidateIds(first.planned), candidateIds(second.planned));
  assert.deepEqual(first.planned.map((item) => item.priorityScore), second.planned.map((item) => item.priorityScore));
});

test("预算调整：60→120 自动增加任务，120→30 重算且不隐藏 mandatory", () => {
  const candidates = [
    makeCandidate({ id: "review", type: TASK_TYPE_REVIEW, priorityTier: TIER_OVERDUE_REVIEW, mandatory: true, estimatedMinutes: 35 }),
    makeCandidate({ id: "continue", type: TASK_TYPE_CONTINUE_READING, priorityTier: TIER_CONTINUE_READING, estimatedMinutes: 40 }),
    makeCandidate({ id: "learning", type: TASK_TYPE_LEARNING_REVIEW, priorityTier: TIER_LEARNING_REVIEW, estimatedMinutes: 10 }),
    makeCandidate({ id: "new", type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING, estimatedMinutes: 40 }),
  ];
  const sixty = planStudyDay(candidates, { date: TODAY, budgetMinutes: 60, budgetConfirmed: true, generatedAt: 1 });
  assert.deepEqual(candidateIds(sixty.planned), ["review", "learning"]);
  assert.deepEqual(candidateIds(sixty.overflow), ["continue", "new"]);

  const oneTwenty = planStudyDay(candidates, { date: TODAY, budgetMinutes: 120, budgetConfirmed: true, generatedAt: 1 });
  assert.deepEqual(candidateIds(oneTwenty.planned), ["review", "continue", "learning"]);
  assert.deepEqual(candidateIds(oneTwenty.overflow), ["new"]);
  assert.equal(oneTwenty.plannedMinutes, 85);

  const thirty = planStudyDay(candidates, { date: TODAY, budgetMinutes: 30, budgetConfirmed: true, generatedAt: 1 });
  assert.deepEqual(candidateIds(thirty.planned), ["review"]);
  assert.equal(thirty.overBudgetMinutes, 5);
  assert.equal(thirty.remainingMinutes, 0);
  assert.deepEqual(candidateIds(thirty.overflow), ["continue", "learning", "new"]);
});

test("存储往返与损坏恢复", () => {
  fresh();
  const result = savePlanState({
    date: TODAY,
    budgetMinutes: 90,
    budgetConfirmed: true,
    deferredTaskIds: ["a", "b", "a"],
    updatedAt: 7,
  });
  assert.equal(result.ok, true);
  const loaded = loadPlanState(TODAY);
  assert.equal(loaded.budgetMinutes, 90);
  assert.equal(loaded.budgetConfirmed, true);
  assert.deepEqual(loaded.deferredTaskIds, ["a", "b"]);
  assert.equal(loaded.updatedAt, 7);

  setUserItem(studyPlanStorageKey(TODAY), "{broken json");
  const corrupted = loadPlanState(TODAY);
  assert.equal(corrupted.budgetMinutes, null);
  assert.equal(corrupted.budgetConfirmed, false);
  assert.deepEqual(corrupted.deferredTaskIds, []);
});

test("跨午夜：新日期 budget / defer 完全独立，今天新到期任务出现", () => {
  fresh();
  deferPlanTask(TODAY, "new-reading", { now: 1 });
  const tomorrow = addCalendarDays(TODAY, 1);
  const tomorrowState = loadPlanState(tomorrow);
  const candidates = [
    makeCandidate({ id: "due", type: TASK_TYPE_REVIEW, priorityTier: TIER_DUE_REVIEW, mandatory: true, dueDate: tomorrow }),
    makeCandidate({ id: "new", type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING }),
  ];
  const plan = planStudyDay(candidates, {
    date: tomorrow,
    budgetMinutes: tomorrowState.budgetMinutes,
    budgetConfirmed: tomorrowState.budgetConfirmed,
    deferredTaskIds: tomorrowState.deferredTaskIds,
    generatedAt: 1,
  });
  assert.deepEqual(candidateIds(plan.planned), ["due", "new"]);
});

test("estimateTaskDuration 确定性规则", () => {
  assert.equal(estimateTaskDuration(makeCandidate({ type: TASK_TYPE_REVIEW, metadata: { taskType: "next_day_article" } })), 15);
  assert.equal(
    estimateTaskDuration(makeCandidate({ type: TASK_TYPE_REVIEW, metadata: { taskType: "sentence_recheck", sentenceCount: 3 } })),
    14,
  );
  assert.equal(
    estimateTaskDuration(makeCandidate({ type: TASK_TYPE_REVIEW, metadata: { taskType: "sentence_recheck", sentenceCount: 100 } })),
    PLANNER_DURATION_DEFAULTS.sentenceRecheckMax,
  );
  assert.equal(
    estimateTaskDuration(makeCandidate({ type: TASK_TYPE_CONTINUE_READING, metadata: { stageId: "deep-translation", remainingSentenceCount: 12 } })),
    34,
  );
  assert.equal(
    estimateTaskDuration(makeCandidate({ type: TASK_TYPE_CONTINUE_READING, metadata: { stageId: "deep-translation", remainingSentenceCount: 100 } })),
    PLANNER_DURATION_DEFAULTS.deepTranslationMax,
  );
  assert.equal(estimateTaskDuration(makeCandidate({ type: TASK_TYPE_CONTINUE_READING, metadata: { stageId: "deep-redo" } })), 15);
  assert.equal(estimateTaskDuration(makeCandidate({ type: TASK_TYPE_LEARNING_REVIEW })), 10);
  assert.equal(estimateTaskDuration(makeCandidate({ type: TASK_TYPE_VOCABULARY_REVIEW, metadata: { dueCount: 2 } })), 6);
  assert.equal(estimateTaskDuration(makeCandidate({ type: TASK_TYPE_NEW_READING })), 40);
});

test("priorityForTask 分层正确", () => {
  const overdue = priorityForTask(makeCandidate({ type: TASK_TYPE_REVIEW, priorityTier: TIER_OVERDUE_REVIEW }));
  const due = priorityForTask(makeCandidate({ type: TASK_TYPE_REVIEW, priorityTier: TIER_DUE_REVIEW }));
  const reading = priorityForTask(makeCandidate({ type: TASK_TYPE_CONTINUE_READING, priorityTier: TIER_CONTINUE_READING }));
  const learning = priorityForTask(makeCandidate({ type: TASK_TYPE_LEARNING_REVIEW, priorityTier: TIER_LEARNING_REVIEW }));
  const vocabulary = priorityForTask(makeCandidate({ type: TASK_TYPE_VOCABULARY_REVIEW, priorityTier: TIER_LEARNING_REVIEW }));
  const freshNew = priorityForTask(makeCandidate({ type: TASK_TYPE_NEW_READING, priorityTier: TIER_NEW_READING }));
  assert.deepEqual([overdue.tier, due.tier, reading.tier, learning.tier, vocabulary.tier, freshNew.tier], [0, 1, 2, 3, 3, 4]);
  assert.ok(overdue.score[0] < due.score[0]);
  assert.ok(due.score[0] < reading.score[0]);
  assert.ok(learning.score < vocabulary.score);
});

test("计划输出结构完整", () => {
  const plan = planStudyDay([], {
    date: TODAY,
    budgetConfirmed: false,
    completed: [{ id: "x" }],
    blocked: [{ id: "b" }],
    generatedAt: 42,
  });
  assert.deepEqual(Object.keys(plan).sort(), [
    "blocked",
    "budgetConfirmed",
    "budgetMinutes",
    "completed",
    "date",
    "deferred",
    "generatedAt",
    "mandatoryMinutes",
    "overBudgetMinutes",
    "overflow",
    "planned",
    "plannedMinutes",
    "remainingMinutes",
  ].sort());
  assert.equal(plan.generatedAt, 42);
  assert.equal(plan.completed.length, 1);
  assert.equal(plan.blocked.length, 1);
});
