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
  constructor(type) {
    this.type = type;
  }
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const { setCurrentUsername, setUserItem, getUserItem } = await import("../src/userData.js");
const {
  STAGES,
  flowStorageKey,
  emptyFlow,
  deriveFlow,
  getReadingFlow,
  saveReadingFlow,
  completeStage,
  isStageLocked,
  currentStageOf,
  isWorkflowCompleted,
  hasAllQuestionsAnswered,
  enterInitialStage,
  pauseTimedReading,
  resumeTimedReading,
  finishTimedReading,
  timedReadingElapsed,
  undoWorkflowCompletion,
} = await import("../src/readingFlow.js");
const { setReadingCompleted, isReadingCompleted } = await import("../src/studyRank.js");
const { hasReliableOfficialAnswer, questionCapabilities } = await import("../src/questionCapabilities.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function seedActivity(resourceId, passageId, completed, extra = {}) {
  setUserItem(`wuliao:reading-activity:${resourceId}:${passageId}`, JSON.stringify({
    resourceId,
    passageId,
    completed,
    completedAt: completed ? 5000 : null,
    ...extra,
  }));
}

function seedPosition(resourceId, passageId, anchorId) {
  setUserItem(`wuliao:deep-position:${resourceId}`, JSON.stringify({
    passageId,
    anchorId,
    scrollY: 1000,
    updatedAt: 4000,
  }));
}

function seedFirst(resourceId, passageId, answers = { 21: "A" }) {
  setUserItem(`wuliao:deep-answers:${resourceId}:${passageId}:first`, JSON.stringify(answers));
}

function seedRedo(resourceId, passageId, answers = { 21: "B" }) {
  setUserItem(`wuliao:deep-answers:${resourceId}:${passageId}:redo`, JSON.stringify(answers));
}

const RESOURCE = { id: "r1", title: "T1", year: 2020, text: 1 };
const PASSAGE = { id: "p1" };

test("新用户从导读开始，未来阶段锁定", () => {
  fresh();
  const flow = getReadingFlow("r1", "p1");
  assert.equal(currentStageOf(flow), "deep-cover");
  assert.equal(flow.stages["deep-cover"].status, "current");
  assert.equal(flow.stages["deep-first-read"].status, "pending");
  assert.equal(isStageLocked(flow, "deep-first-read"), true);
  assert.equal(isStageLocked(flow, "deep-cover"), false);
});

test("完成阶段后解锁下一阶段", () => {
  fresh();
  const flow = getReadingFlow("r1", "p1");
  const advanced = completeStage(flow, "deep-cover", 1000);
  assert.equal(advanced.stages["deep-cover"].status, "completed");
  assert.equal(advanced.stages["deep-cover"].completedAt, 1000);
  assert.equal(currentStageOf(advanced), "deep-first-read");
  assert.equal(advanced.stages["deep-first-read"].status, "current");
  assert.equal(isStageLocked(advanced, "deep-first-read"), false);
  assert.equal(isStageLocked(advanced, "deep-clean-text"), true);
});

test("未来阶段不能越级完成", () => {
  fresh();
  const flow = getReadingFlow("r1", "p1");
  const result = completeStage(flow, "deep-first-quiz", 1000);
  assert.equal(result, flow);
  assert.equal(currentStageOf(result), "deep-cover");
});

test("返回已完成阶段重复完成不会倒退 currentStage", () => {
  fresh();
  const flow = getReadingFlow("r1", "p1");
  const advanced = completeStage(flow, "deep-cover", 1000);
  const again = completeStage(advanced, "deep-cover", 2000);
  assert.equal(again, advanced);
  assert.equal(currentStageOf(again), "deep-first-read");
});

test("reading-activity completed=true 初始化为全部完成且无锁定", () => {
  fresh();
  seedActivity("r1", "p1", true);
  const flow = getReadingFlow("r1", "p1");
  assert.equal(isWorkflowCompleted(flow), true);
  assert.equal(currentStageOf(flow), "deep-review");
  for (const stage of STAGES) {
    assert.equal(flow.stages[stage.id].status, "completed");
    assert.equal(isStageLocked(flow, stage.id), false);
  }
});

test("旧 anchorId 位于 deep-translation 不会把前面阶段锁回", () => {
  fresh();
  seedPosition("r1", "p1", "deep-translation");
  const flow = getReadingFlow("r1", "p1");
  assert.equal(currentStageOf(flow), "deep-translation");
  assert.equal(flow.stages["deep-cover"].status, "completed");
  assert.equal(flow.stages["deep-first-read"].status, "completed");
  assert.equal(flow.stages["deep-clean-text"].status, "completed");
  assert.equal(flow.stages["deep-first-quiz"].status, "completed");
  assert.equal(flow.stages["deep-translation"].status, "current");
  assert.equal(isStageLocked(flow, "deep-translation"), false);
  assert.equal(isStageLocked(flow, "deep-review"), true);
});

test("旧 anchorId 位于 deep-clean-text 时限时状态为 idle 但不锁定", () => {
  fresh();
  seedPosition("r1", "p1", "deep-clean-text");
  const flow = getReadingFlow("r1", "p1");
  assert.equal(currentStageOf(flow), "deep-clean-text");
  assert.equal(flow.timedReading.phase, "idle");
  assert.equal(flow.stages["deep-first-read"].status, "completed");
  assert.equal(flow.stages["deep-clean-text"].status, "current");
  assert.equal(isStageLocked(flow, "deep-clean-text"), false);
});

test("first 作答记录把进度推进到逐段精读", () => {
  fresh();
  seedPosition("r1", "p1", "deep-cover");
  seedFirst("r1", "p1");
  const flow = getReadingFlow("r1", "p1");
  assert.equal(currentStageOf(flow), "deep-translation");
  assert.equal(flow.stages["deep-first-quiz"].status, "completed");
});

test("redo 作答记录把进度推进到重做", () => {
  fresh();
  seedFirst("r1", "p1");
  seedRedo("r1", "p1");
  const flow = getReadingFlow("r1", "p1");
  assert.equal(currentStageOf(flow), "deep-redo");
  assert.equal(flow.stages["deep-translation"].status, "completed");
  assert.equal(flow.stages["deep-redo"].status, "current");
});

test("Text 之间流程状态隔离", () => {
  fresh();
  assert.notEqual(flowStorageKey("r1", "p1"), flowStorageKey("r1", "p2"));
  seedFirst("r1", "p1");
  seedRedo("r1", "p1");
  const p1 = getReadingFlow("r1", "p1");
  const p2 = getReadingFlow("r1", "p2");
  assert.equal(currentStageOf(p1), "deep-redo");
  assert.equal(currentStageOf(p2), "deep-cover");
  assert.equal(p2.stages["deep-first-read"].status, "pending");
});

test("无题文章 first-quiz / redo 不会卡死", () => {
  fresh();
  assert.equal(hasAllQuestionsAnswered([], {}), true);
  assert.equal(hasAllQuestionsAnswered([{ number: 21 }, { number: 22 }], { 21: "A" }), false);
  assert.equal(hasAllQuestionsAnswered([{ number: 21 }, { number: 22 }], { 21: "A", 22: "B" }), true);
});

test("整篇完成仍写 reading-activity.completed 且段位读取兼容", () => {
  fresh();
  let flow = emptyFlow("r1", "p1", 0);
  for (const id of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"]) {
    flow = completeStage(flow, id, 1000);
  }
  assert.equal(isWorkflowCompleted(flow), true);
  setReadingCompleted(RESOURCE, PASSAGE, true);
  assert.equal(isReadingCompleted("r1", "p1"), true);
  const reloaded = getReadingFlow("r1", "p1");
  assert.equal(isWorkflowCompleted(reloaded), true);
  assert.equal(isStageLocked(reloaded, "deep-review"), false);
});

test("撤销整篇完成只撤销 review，保留前六阶段", () => {
  fresh();
  let flow = emptyFlow("r1", "p1", 0);
  for (const id of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"]) {
    flow = completeStage(flow, id, 1000);
  }
  const undone = undoWorkflowCompletion(flow, 2000);
  assert.equal(isWorkflowCompleted(undone), false);
  assert.equal(currentStageOf(undone), "deep-review");
  assert.equal(undone.stages["deep-review"].status, "current");
  for (const id of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo"]) {
    assert.equal(undone.stages[id].status, "completed");
  }
  setReadingCompleted(RESOURCE, PASSAGE, false);
  assert.equal(isReadingCompleted("r1", "p1"), false);
});

test("进入初做即自动计时，pause/resume/完成初做时结束计时", () => {
  fresh();
  let flow = emptyFlow("r1", "p1", 0);
  flow = completeStage(flow, "deep-cover", 1000);
  flow = completeStage(flow, "deep-first-read", 2000);
  assert.equal(currentStageOf(flow), "deep-clean-text");

  const started = enterInitialStage(flow, 3000);
  assert.equal(started.timedReading.phase, "running");
  assert.equal(started.timedReading.startedAt, 3000);
  assert.equal(started.stages["deep-clean-text"].status, "completed");
  assert.equal(currentStageOf(started), "deep-first-quiz");
  assert.equal(started.stages["deep-first-quiz"].status, "current");
  assert.equal(timedReadingElapsed(started, 3500), 500);

  const paused = pauseTimedReading(started, 4200);
  assert.equal(paused.timedReading.phase, "paused");
  assert.equal(paused.timedReading.elapsedMs, 1200);
  assert.equal(timedReadingElapsed(paused, 9000), 1200);

  const resumed = resumeTimedReading(paused, 4300);
  assert.equal(resumed.timedReading.phase, "running");
  assert.equal(resumed.timedReading.startedAt, 4300);

  const finished = finishTimedReading(resumed, 5800);
  assert.equal(finished.timedReading.phase, "done");
  assert.equal(finished.timedReading.elapsedMs, 1200 + 1500);
  assert.equal(finished.timedReading.completedAt, 5800);
  assert.equal(currentStageOf(finished), "deep-first-quiz");
  assert.equal(finished.stages["deep-first-quiz"].status, "current");
});

test("已保存 flow 优先于旧数据推导，并规范化 currentStage", () => {
  fresh();
  let flow = emptyFlow("r1", "p1", 0);
  flow = completeStage(flow, "deep-cover", 1000);
  flow = completeStage(flow, "deep-first-read", 2000);
  saveReadingFlow(flow);
  seedActivity("r1", "p1", false);
  seedPosition("r1", "p1", "deep-cover");
  const reloaded = getReadingFlow("r1", "p1");
  assert.equal(currentStageOf(reloaded), "deep-clean-text");
  assert.equal(reloaded.stages["deep-clean-text"].status, "current");
});

test("deriveFlow 对 stored 缺失阶段做兼容补齐", () => {
  fresh();
  const stored = {
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
  };
  const flow = deriveFlow({ stored, resourceId: "r1", passageId: "p1" });
  assert.equal(currentStageOf(flow), "deep-first-read");
  assert.equal(flow.stages["deep-clean-text"].status, "pending");
  assert.equal(flow.stages["deep-review"].status, "pending");
});

test("currentStage 指向 pending 阶段时仍可完成（自愈）", () => {
  fresh();
  const stored = {
    schemaVersion: 1,
    resourceId: "r1",
    passageId: "p1",
    stages: {
      "deep-cover": { status: "pending", completedAt: null },
      "deep-first-read": { status: "pending", completedAt: null },
    },
    currentStage: "deep-cover",
    timedReading: { phase: "idle", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: null },
    updatedAt: 10,
  };
  const flow = deriveFlow({ stored, resourceId: "r1", passageId: "p1" });
  assert.equal(currentStageOf(flow), "deep-cover");
  const advanced = completeStage(flow, "deep-cover", 1000);
  assert.equal(advanced.stages["deep-cover"].status, "completed");
  assert.equal(currentStageOf(advanced), "deep-first-read");
  assert.equal(advanced.stages["deep-first-read"].status, "current");
});

test("pending 且非当前阶段仍不能越级完成", () => {
  fresh();
  const flow = deriveFlow({
    stored: {
      schemaVersion: 1,
      resourceId: "r1",
      passageId: "p1",
      stages: {
        "deep-cover": { status: "completed", completedAt: 1 },
        "deep-first-read": { status: "pending", completedAt: null },
      },
      currentStage: "deep-first-read",
      timedReading: { phase: "idle", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: null },
      updatedAt: 10,
    },
    resourceId: "r1",
    passageId: "p1",
  });
  const result = completeStage(flow, "deep-first-quiz", 1000);
  assert.equal(result, flow);
  assert.equal(currentStageOf(result), "deep-first-read");
});

test("题目 capability：初做/订正隐藏 AI 与证据，重做作答后才开放深度能力", () => {
  const first = questionCapabilities({
    flowStage: "deep-first-quiz",
    correctionRevealed: false,
    hasReliableOfficialAnswer: true,
  });
  assert.equal(first.canEditAnswer, true);
  assert.equal(first.showEvidence, false);
  assert.equal(first.showAiHint, false);
  assert.equal(first.showDiagnosis, false);

  const correction = questionCapabilities({
    flowStage: "deep-first-quiz",
    correctionRevealed: true,
    hasReliableOfficialAnswer: true,
  });
  assert.equal(correction.canEditAnswer, false);
  assert.equal(correction.showCorrection, true);
  assert.equal(correction.showEvidence, false);
  assert.equal(correction.showExplanation, false);

  const redoPending = questionCapabilities({
    flowStage: "deep-redo",
    correctionRevealed: false,
    hasReliableOfficialAnswer: true,
    redoCompleted: false,
  });
  assert.equal(redoPending.showAiHint, true);
  assert.equal(redoPending.showEvidence, false);

  const redoCorrected = questionCapabilities({
    flowStage: "deep-redo",
    correctionRevealed: true,
    hasReliableOfficialAnswer: true,
    redoCompleted: true,
  });
  assert.equal(redoCorrected.showEvidence, true);
  assert.equal(redoCorrected.showDiagnosis, true);
  assert.equal(redoCorrected.showExplanation, true);
});

test("可靠答案必须同时来自 official 资源和有效答案值", () => {
  assert.equal(hasReliableOfficialAnswer({
    resource: { kind: "official" },
    officialAnswers: { 21: "C" },
    questionNumber: 21,
  }), true);
  assert.equal(hasReliableOfficialAnswer({
    resource: { kind: "custom" },
    officialAnswers: { 21: "C" },
    questionNumber: 21,
  }), false);
  assert.equal(hasReliableOfficialAnswer({
    resource: { kind: "official" },
    officialAnswers: { 21: "" },
    questionNumber: 21,
  }), false);
});
