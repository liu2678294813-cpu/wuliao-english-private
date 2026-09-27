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
  CLOZE_STAGES,
  CLOZE_STAGE_IDS,
  clozeFlowStorageKey,
  emptyClozeFlow,
  normalizeClozeFlow,
  getClozeFlow,
  saveClozeFlow,
  completeClozeStage,
  currentClozeStageOf,
  isClozeStageLocked,
  isClozeWorkflowCompleted,
  startClozeTimer,
  pauseClozeTimer,
  resumeClozeTimer,
  finishClozeTimer,
  clozeTimerElapsed,
  undoClozeWorkflowCompletion,
} = await import("../src/clozeFlow.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

const RESOURCE_ID = "postgraduate-2023-text-1";
const CLOZE_ID = "cloze-2023";

test("默认阶段为 cloze-cover，后续阶段锁定", () => {
  fresh();
  const flow = getClozeFlow(RESOURCE_ID, CLOZE_ID);
  assert.equal(currentClozeStageOf(flow), "cloze-cover");
  assert.equal(flow.stages["cloze-cover"].status, "current");
  assert.equal(flow.stages["cloze-first-attempt"].status, "pending");
  assert.equal(isClozeStageLocked(flow, "cloze-first-attempt"), true);
  assert.equal(isClozeStageLocked(flow, "cloze-cover"), false);
});

test("完成阶段后解锁下一阶段", () => {
  fresh();
  const flow = getClozeFlow(RESOURCE_ID, CLOZE_ID);
  const advanced = completeClozeStage(flow, "cloze-cover", 1000);
  assert.equal(advanced.stages["cloze-cover"].status, "completed");
  assert.equal(currentClozeStageOf(advanced), "cloze-first-attempt");
  assert.equal(advanced.stages["cloze-first-attempt"].status, "current");
  assert.equal(isClozeStageLocked(advanced, "cloze-first-attempt"), false);
  assert.equal(isClozeStageLocked(advanced, "cloze-self-review"), true);
});

test("未来阶段不能越级完成", () => {
  fresh();
  const flow = getClozeFlow(RESOURCE_ID, CLOZE_ID);
  const result = completeClozeStage(flow, "cloze-self-review", 1000);
  assert.equal(result, flow);
  assert.equal(currentClozeStageOf(result), "cloze-cover");
});

test("返回已完成阶段重复完成不会倒退", () => {
  fresh();
  const flow = getClozeFlow(RESOURCE_ID, CLOZE_ID);
  const advanced = completeClozeStage(flow, "cloze-cover", 1000);
  const again = completeClozeStage(advanced, "cloze-cover", 2000);
  assert.equal(again, advanced);
  assert.equal(currentClozeStageOf(again), "cloze-first-attempt");
});

test("流程完成：全部 6 阶段 completed", () => {
  fresh();
  let flow = emptyClozeFlow(RESOURCE_ID, CLOZE_ID, 0);
  for (const id of CLOZE_STAGE_IDS) {
    flow = completeClozeStage(flow, id, 1000);
  }
  assert.equal(isClozeWorkflowCompleted(flow), true);
  assert.equal(currentClozeStageOf(flow), "cloze-final-read");
  for (const stage of CLOZE_STAGES) {
    assert.equal(flow.stages[stage.id].status, "completed");
    assert.equal(isClozeStageLocked(flow, stage.id), false);
  }
});

test("限时初做计时 start/pause/resume/finish 基于时间戳计算", () => {
  fresh();
  let flow = getClozeFlow(RESOURCE_ID, CLOZE_ID);
  flow = completeClozeStage(flow, "cloze-cover", 1000);
  assert.equal(currentClozeStageOf(flow), "cloze-first-attempt");

  const started = startClozeTimer(flow, 3000);
  assert.equal(started.timedAttempt.phase, "running");
  assert.equal(started.timedAttempt.startedAt, 3000);
  assert.equal(clozeTimerElapsed(started, 3500), 500);

  const paused = pauseClozeTimer(started, 4200);
  assert.equal(paused.timedAttempt.phase, "paused");
  assert.equal(paused.timedAttempt.elapsedMs, 1200);
  assert.equal(clozeTimerElapsed(paused, 9000), 1200);

  const resumed = resumeClozeTimer(paused, 4300);
  assert.equal(resumed.timedAttempt.phase, "running");
  assert.equal(resumed.timedAttempt.startedAt, 4300);

  const finished = finishClozeTimer(resumed, 5800);
  assert.equal(finished.timedAttempt.phase, "done");
  assert.equal(finished.timedAttempt.elapsedMs, 2700);
  assert.equal(finished.timedAttempt.completedAt, 5800);
});

test("计时仅在 cloze-first-attempt 阶段可用", () => {
  fresh();
  const flow = getClozeFlow(RESOURCE_ID, CLOZE_ID);
  assert.equal(currentClozeStageOf(flow), "cloze-cover");
  const started = startClozeTimer(flow, 1000);
  assert.equal(started, flow, "非限时阶段 start 应返回原 flow");
  assert.equal(started.timedAttempt.phase, "idle");
});

test("存储 key 与阅读 reading-flow 完全隔离", () => {
  const clozeKey = clozeFlowStorageKey("r1", "c1");
  assert.ok(clozeKey.startsWith("wuliao:cloze-flow:"));
  assert.ok(!clozeKey.includes("reading-flow"));
});

test("不同 resource / cloze 之间流程状态隔离", () => {
  fresh();
  let flow1 = getClozeFlow("r1", "c1");
  flow1 = completeClozeStage(flow1, "cloze-cover", 1000);
  saveClozeFlow(flow1);
  const flow2 = getClozeFlow("r1", "c2");
  assert.equal(currentClozeStageOf(flow2), "cloze-cover");
  assert.equal(flow2.stages["cloze-first-attempt"].status, "pending");
  const reloaded = getClozeFlow("r1", "c1");
  assert.equal(currentClozeStageOf(reloaded), "cloze-first-attempt");
});

test("保存后刷新可恢复流程状态", () => {
  fresh();
  let flow = getClozeFlow(RESOURCE_ID, CLOZE_ID);
  flow = completeClozeStage(flow, "cloze-cover", 1000);
  flow = completeClozeStage(flow, "cloze-first-attempt", 2000);
  saveClozeFlow(flow);
  const reloaded = getClozeFlow(RESOURCE_ID, CLOZE_ID);
  assert.equal(currentClozeStageOf(reloaded), "cloze-self-review");
  assert.equal(reloaded.stages["cloze-cover"].status, "completed");
  assert.equal(reloaded.stages["cloze-first-attempt"].status, "completed");
});

test("normalizeClozeFlow 对缺失阶段做兼容补齐", () => {
  fresh();
  const stored = {
    schemaVersion: 1,
    resourceId: "r1",
    clozeId: "c1",
    stages: {
      "cloze-cover": { status: "completed", completedAt: 1 },
      "cloze-first-attempt": { status: "current", completedAt: null },
    },
    currentStage: "cloze-first-attempt",
    timedAttempt: { phase: "idle", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: null },
    updatedAt: 10,
  };
  const flow = normalizeClozeFlow(stored);
  assert.equal(currentClozeStageOf(flow), "cloze-first-attempt");
  assert.equal(flow.stages["cloze-self-review"].status, "pending");
  assert.equal(flow.stages["cloze-final-read"].status, "pending");
});

test("不读写 reading-flow storage key", () => {
  fresh();
  getClozeFlow(RESOURCE_ID, CLOZE_ID);
  const keys = [...globalThis.localStorage.map.keys()];
  assert.ok(keys.every((k) => !k.includes("reading-flow")), "不应写入 reading-flow key");
});

test("撤销整篇完成只撤销 final-read，保留前五阶段", () => {
  fresh();
  let flow = emptyClozeFlow(RESOURCE_ID, CLOZE_ID, 0);
  for (const id of CLOZE_STAGE_IDS) {
    flow = completeClozeStage(flow, id, 1000);
  }
  assert.equal(isClozeWorkflowCompleted(flow), true);
  const undone = undoClozeWorkflowCompletion(flow, 2000);
  assert.equal(isClozeWorkflowCompleted(undone), false);
  assert.equal(currentClozeStageOf(undone), "cloze-final-read");
  assert.equal(undone.stages["cloze-final-read"].status, "current");
  for (const id of CLOZE_STAGE_IDS.slice(0, 5)) {
    assert.equal(undone.stages[id].status, "completed");
  }
});