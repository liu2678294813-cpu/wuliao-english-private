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

const { setCurrentUsername } = await import("../src/userData.js");
const {
  CLOZE_REVIEW_TASK_PREFIX,
  TASK_TYPE_D1,
  TASK_TYPE_D7,
  clozeDueDateFor,
  clozeReviewTaskKey,
  clozeReviewTaskStatus,
  completeClozeReviewTask,
  ensureClozeReviewTask,
  getClozeReviewTask,
  listClozeReviewTasks,
  nextClozeReviewBlank,
  recordClozeReviewAttempt,
  skipClozeReviewTask,
  startClozeReviewTask,
} = await import("../src/clozeReview.js");

function fresh(user = "alice") {
  globalThis.localStorage.clear();
  setCurrentUsername(user);
}

const d1Key = clozeReviewTaskKey({
  type: TASK_TYPE_D1,
  resourceId: "postgraduate/2009",
  clozeId: "cloze-2009",
  sourceDate: "2026-08-01",
});

test("stable task identity 与日期语义", () => {
  assert.equal(
    d1Key,
    "cloze-review:d1:postgraduate%2F2009:cloze-2009:2026-08-01",
  );
  assert.ok(!d1Key.includes("review:next_day_article"));
  assert.equal(clozeDueDateFor(TASK_TYPE_D1, "2026-08-01"), "2026-08-02");
  assert.equal(clozeDueDateFor(TASK_TYPE_D7, "2026-08-01"), "2026-08-08");
  assert.ok(clozeReviewTaskKey({
    type: TASK_TYPE_D7,
    resourceId: "r",
    clozeId: "c",
    sourceDate: "2026-08-01",
  }).startsWith("cloze-review:d7:"));
});

test("ensure 是 create-once 幂等：不覆盖首次 materialize snapshot", () => {
  fresh();
  const first = ensureClozeReviewTask({
    taskKey: d1Key,
    type: TASK_TYPE_D1,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [3, 5, 8],
    targetReasons: { 3: ["high-confidence-wrong"], 5: ["final-wrong"], 8: ["uncertain"] },
    now: 100,
  });
  assert.equal(first.created, true);
  assert.deepEqual(first.task.targetBlankIds, [3, 5, 8]);

  // 重新 ensure（例如再次进入 final-read / 重复完成）：直接返回已有任务。
  const again = ensureClozeReviewTask({
    taskKey: d1Key,
    type: TASK_TYPE_D1,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-09-01",
    dueDate: "2026-09-02",
    targetBlankIds: [1, 2],
    targetReasons: { 1: ["changed-answer"] },
    now: 999,
  });
  assert.equal(again.created, false);
  assert.deepEqual(again.task.targetBlankIds, [3, 5, 8]);
  assert.equal(again.task.sourceDate, "2026-08-01");
  assert.equal(again.task.dueDate, "2026-08-02");
  assert.deepEqual(again.task.targetReasons[3], ["high-confidence-wrong"]);
  assert.equal(again.task.createdAt, 100);
});

test("生命周期：scheduled → due → in_progress → completed，overdue 不丢", () => {
  fresh();
  ensureClozeReviewTask({
    taskKey: d1Key,
    type: TASK_TYPE_D1,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [1, 2],
    targetReasons: { 1: ["guess"], 2: ["uncertain"] },
    now: 100,
  });
  assert.equal(clozeReviewTaskStatus(getClozeReviewTask(d1Key), "2026-08-01"), "scheduled");
  assert.equal(clozeReviewTaskStatus(getClozeReviewTask(d1Key), "2026-08-02"), "due");
  assert.equal(clozeReviewTaskStatus(getClozeReviewTask(d1Key), "2026-08-03"), "overdue");
  // overdue 不丢：任务仍然存在且仍可开始
  const started = startClozeReviewTask(d1Key, 200);
  assert.equal(clozeReviewTaskStatus(started, "2026-08-05"), "in_progress");
  assert.equal(nextClozeReviewBlank(started), 1);
});

test("recordClozeReviewAttempt 写入 sidecar，不触碰当天 progress 字段", () => {
  fresh();
  ensureClozeReviewTask({
    taskKey: d1Key,
    type: TASK_TYPE_D1,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [3],
    targetReasons: { 3: ["final-wrong"] },
    now: 100,
  });
  startClozeReviewTask(d1Key, 150);
  const updated = recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 3,
    attempt: { answer: "B", confidence: "confident", basisTypes: ["context"], selfRating: "stable" },
    now: 200,
  });
  assert.deepEqual(updated.attempts["3"], {
    blankIdentity: "3",
    answer: "B",
    confidence: "confident",
    basisTypes: ["context"],
    selfRating: "stable",
    outcome: "",
    reviewedAt: 200,
  });
  // sidecar 里没有当天事实源字段
  const serialized = JSON.stringify(updated);
  assert.ok(!serialized.includes("firstAnswer"));
  assert.ok(!serialized.includes("reviewAnswer"));
  assert.ok(!serialized.includes("prediction"));
  assert.ok(!serialized.includes("references"));
  assert.ok(!serialized.includes("translation"));
  // 推进后无剩余 target
  assert.equal(nextClozeReviewBlank(updated), null);
});

test("reload 可恢复：currentIndex 与 attempts 持久化", () => {
  fresh();
  ensureClozeReviewTask({
    taskKey: d1Key,
    type: TASK_TYPE_D1,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [1, 2, 3],
    targetReasons: { 1: ["guess"], 2: ["uncertain"], 3: ["final-wrong"] },
    now: 100,
  });
  startClozeReviewTask(d1Key, 150);
  recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 1,
    attempt: { answer: "A", confidence: "uncertain", selfRating: "unstable" },
    now: 200,
  });
  const reloaded = getClozeReviewTask(d1Key);
  assert.equal(reloaded.currentIndex, 1);
  assert.equal(nextClozeReviewBlank(reloaded), 2);
  assert.equal(reloaded.attempts["1"].answer, "A");
});

test("完成任务后状态 completed；跳过任务状态 skipped；完成后不可再作答", () => {
  fresh();
  ensureClozeReviewTask({
    taskKey: d1Key,
    type: TASK_TYPE_D1,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [1],
    targetReasons: { 1: ["guess"] },
    now: 100,
  });
  startClozeReviewTask(d1Key, 150);
  recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 1,
    attempt: { answer: "A", confidence: "confident" },
    now: 200,
  });
  const done = completeClozeReviewTask(d1Key, 210);
  assert.equal(clozeReviewTaskStatus(done, "2026-08-02"), "completed");
  // 完成后再次 record 返回 null（不再允许）
  assert.equal(recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 1,
    attempt: { answer: "B" },
    now: 220,
  }), null);

  fresh("bob");
  ensureClozeReviewTask({
    taskKey: d1Key,
    type: TASK_TYPE_D1,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [1],
    targetReasons: { 1: ["guess"] },
    now: 300,
  });
  const skipped = skipClozeReviewTask(d1Key, 310);
  assert.equal(clozeReviewTaskStatus(skipped, "2026-08-02"), "skipped");
  assert.equal(startClozeReviewTask(d1Key, 320), null);
});

test("账号隔离：alice 的任务对 bob 不可见", () => {
  fresh("alice");
  ensureClozeReviewTask({
    taskKey: d1Key,
    type: TASK_TYPE_D1,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    dueDate: "2026-08-02",
    targetBlankIds: [1],
    targetReasons: { 1: ["guess"] },
    now: 100,
  });
  assert.equal(listClozeReviewTasks("alice").length, 1);
  fresh("bob");
  assert.equal(listClozeReviewTasks("bob").length, 0);
  assert.equal(getClozeReviewTask(d1Key, "bob"), null);
});

test("key 前缀与 Reading review-task 前缀不碰撞", () => {
  assert.equal(CLOZE_REVIEW_TASK_PREFIX, "wuliao:cloze-review-task:");
  // listUserItems 按完整前缀匹配：Reading 前缀不会扫到 cloze review key。
  assert.ok(!"wuliao:review-task:".startsWith(CLOZE_REVIEW_TASK_PREFIX));
  assert.ok(!CLOZE_REVIEW_TASK_PREFIX.startsWith("wuliao:review-task:"));
  assert.ok(!d1Key.startsWith("review:"));
});

test("D+7 任务可独立创建（方案 B：D+1 完成时才 materialize）", () => {
  fresh();
  const d7Key = clozeReviewTaskKey({
    type: TASK_TYPE_D7,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
  });
  const created = ensureClozeReviewTask({
    taskKey: d7Key,
    type: TASK_TYPE_D7,
    resourceId: "postgraduate/2009",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    dueDate: "2026-08-08",
    targetBlankIds: [3],
    targetReasons: { 3: ["d7-confirmation"] },
    now: 500,
  });
  assert.equal(created.created, true);
  assert.equal(created.task.type, TASK_TYPE_D7);
  assert.equal(created.task.dueDate, "2026-08-08");
});
