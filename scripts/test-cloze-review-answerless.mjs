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
  emptyClozeProgress,
  recordFirstAnswer,
  recordFirstConfidence,
  recordReviewAnswer,
  recordReviewConfidence,
} = await import("../src/clozeProgress.js");
const {
  TASK_TYPE_D1,
  TASK_TYPE_D7,
  clozeReviewTaskKey,
  clozeReviewTaskStatus,
  getClozeReviewTask,
  listClozeReviewTasks,
  scheduleClozeD1Task,
  scheduleClozeD7Task,
  startClozeReviewTask,
  recordClozeReviewAttempt,
  completeClozeReviewTask,
  buildClozeSupportSignals,
} = await import("../src/clozeReview.js");
const { emptyClozeTranslationProgress, setClozeTranslationText, markClozeTranslationTranslated } = await import("../src/clozeTranslationProgress.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function progressWith(entries, blankCount = 20) {
  let progress = emptyClozeProgress("postgraduate-2009-cloze", "cloze-2009", Array.from({ length: blankCount }, (_, i) => i + 1), 1);
  for (const entry of entries) {
    const { number, first = "", review = "", firstConf = "", reviewConf = "" } = entry;
    if (first) progress = recordFirstAnswer(progress, number, first);
    if (review) progress = recordReviewAnswer(progress, number, review);
    if (firstConf) progress = recordFirstConfidence(progress, number, firstConf);
    if (reviewConf) progress = recordReviewConfidence(progress, number, reviewConf);
  }
  return progress;
}

const OFFICIAL = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i + 1, "A"]));

test("无答案 D+1：不产生任何 correctness / accuracy / 正确答案表述", () => {
  fresh();
  const progress = progressWith([
    { number: 1, first: "A", review: "B", reviewConf: "confident" },
    { number: 2, first: "A", review: "A", reviewConf: "guess" },
  ]);
  const scheduled = scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: {},
  });
  assert.ok(scheduled);
  assert.deepEqual(scheduled.targets.map((item) => Number(item.blankId)), [1, 2]);
  const serialized = JSON.stringify(scheduled.task);
  assert.ok(!serialized.includes("correct"));
  assert.ok(!serialized.includes("wrong"));
  assert.ok(!serialized.includes("accuracy"));
  assert.ok(!serialized.includes("officialAnswer"));
});

test("无答案 D+1 完成 → 自评稳定退出 D+7，不稳定保留", () => {
  fresh();
  // 场景1：D 当天 guess 风险 → D+1 答案一致 + confident + 自评稳定 → 退出 D+7
  const progress = progressWith([{ number: 1, first: "A", review: "A", reviewConf: "guess" }]);
  const scheduled = scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: {},
  });
  const d1Key = scheduled.task.taskKey;
  startClozeReviewTask(d1Key, 200);
  recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 1,
    attempt: { answer: "A", confidence: "confident", selfRating: "stable", outcome: "stable" },
    now: 300,
  });
  const d1Done = completeClozeReviewTask(d1Key, 310);
  const d7 = scheduleClozeD7Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    d1Task: d1Done,
    progress,
    officialAnswers: {},
  });
  assert.equal(d7, null);

  // 场景2：D 当天改答风险 → D+1 再改答 + uncertain + 自评不稳定 → D+7 保留
  const progress2 = progressWith([{ number: 1, first: "A", review: "B", reviewConf: "confident" }]);
  const d1Key2 = scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-02T10:00:00").getTime(),
    progress: progress2,
    officialAnswers: {},
  }).task.taskKey;
  recordClozeReviewAttempt({
    taskKey: d1Key2,
    blankId: 1,
    attempt: { answer: "C", confidence: "uncertain", selfRating: "unstable", outcome: "unstable" },
    now: 400,
  });
  const d1Done2 = completeClozeReviewTask(d1Key2, 410);
  const d7b = scheduleClozeD7Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-02",
    d1Task: d1Done2,
    progress: progress2,
    officialAnswers: {},
  });
  assert.ok(d7b);
  assert.equal(d7b.task.type, TASK_TYPE_D7);
  assert.deepEqual(d7b.task.targetBlankIds, [1]);
});

test("有答案 D+1：attempt outcome 来自本地 officialAnswer", () => {
  fresh();
  const progress = progressWith([{ number: 3, first: "B", review: "C", reviewConf: "confident" }]);
  const scheduled = scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: OFFICIAL,
  });
  const d1Key = scheduled.task.taskKey;
  startClozeReviewTask(d1Key, 200);
  recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 3,
    attempt: { answer: "A", confidence: "confident", outcome: "correct" },
    now: 300,
  });
  const reloaded = getClozeReviewTask(d1Key);
  assert.equal(reloaded.attempts["3"].outcome, "correct");
  assert.equal(reloaded.attempts["3"].selfRating, null);
});

test("D+1 完成且不满足退出规则 → 自动 materialize D+7（方案 B，sourceDate 不变）", () => {
  fresh();
  const progress = progressWith([
    { number: 1, first: "B", review: "B", reviewConf: "confident" },
    { number: 2, first: "A", review: "A", reviewConf: "uncertain" },
  ]);
  const scheduled = scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: OFFICIAL,
  });
  const d1Key = scheduled.task.taskKey;
  startClozeReviewTask(d1Key, 200);
  // 空1 仍是错误（高置信错误原项）→ D+7；空2 正确+confident → 退出
  recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 1,
    attempt: { answer: "A", confidence: "confident", outcome: "correct" },
    now: 300,
  });
  recordClozeReviewAttempt({
    taskKey: d1Key,
    blankId: 2,
    attempt: { answer: "A", confidence: "confident", outcome: "correct" },
    now: 310,
  });
  const d1Done = completeClozeReviewTask(d1Key, 320);
  const d7 = scheduleClozeD7Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    d1Task: d1Done,
    progress,
    officialAnswers: OFFICIAL,
  });
  assert.ok(d7);
  assert.deepEqual(d7.task.targetBlankIds, [1]);
  assert.equal(d7.task.sourceDate, "2026-08-01");
  assert.equal(d7.task.dueDate, "2026-08-08");
  // 重复 schedule 幂等
  const again = scheduleClozeD7Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    d1Task: d1Done,
    progress,
    officialAnswers: OFFICIAL,
  });
  assert.equal(again.created, false);
  assert.deepEqual(again.task.targetBlankIds, [1]);
});

test("support signals 纯注入：translation unresolved 通过参数进入，不读存储", () => {
  fresh();
  const progress = progressWith([{ number: 1, first: "A", review: "A", reviewConf: "confident" }]);
  const translation = emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1);
  const sentenceModel = { blankToSentence: {} };
  const signals = buildClozeSupportSignals({ progress, sentenceModel, translationProgress: translation, translationTargetKeys: null });
  assert.deepEqual(signals["1"], { referencesEmpty: true, translationUnresolved: false });
  // 无答案模式：translationUnresolved 是允许的 trigger
  // （已开始翻译但未订正才算 unresolved；纯"待笔译"不是）
  let startedTranslation = emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1);
  startedTranslation = setClozeTranslationText(startedTranslation, "cloze:x:p1s1:y", "我的译文", 2);
  startedTranslation = markClozeTranslationTranslated(startedTranslation, "cloze:x:p1s1:y", 3);
  const withTranslation = buildClozeSupportSignals({
    progress,
    sentenceModel: { blankToSentence: { "1": { sentenceKey: "cloze:x:p1s1:y" } } },
    translationProgress: startedTranslation,
    translationTargetKeys: new Set(["cloze:x:p1s1:y"]),
  });
  assert.equal(withTranslation["1"].translationUnresolved, true);
  const scheduled = scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: {},
    supportByBlank: withTranslation,
  });
  assert.ok(scheduled);
  assert.deepEqual(scheduled.targets.map((item) => Number(item.blankId)), [1]);
});

test("账号隔离与任务枚举：D+1/D+7 各自独立 key", () => {
  fresh();
  const progress = progressWith([{ number: 1, first: "B", review: "B", reviewConf: "confident" }]);
  scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: OFFICIAL,
  });
  assert.equal(listClozeReviewTasks("alice").length, 1);
  assert.equal(listClozeReviewTasks("bob").length, 0);
  assert.notEqual(
    clozeReviewTaskKey({ type: TASK_TYPE_D1, resourceId: "r", clozeId: "c", sourceDate: "2026-08-01" }),
    clozeReviewTaskKey({ type: TASK_TYPE_D7, resourceId: "r", clozeId: "c", sourceDate: "2026-08-01" }),
  );
});

test("无答案任务状态流转不含 correctness 判定", () => {
  fresh();
  const progress = progressWith([{ number: 1, first: "A", review: "B" }]);
  const scheduled = scheduleClozeD1Task({
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    completedAt: new Date("2026-08-01T10:00:00").getTime(),
    progress,
    officialAnswers: {},
  });
  const key = scheduled.task.taskKey;
  assert.equal(clozeReviewTaskStatus(getClozeReviewTask(key), "2026-08-01"), "scheduled");
  assert.equal(clozeReviewTaskStatus(getClozeReviewTask(key), "2026-08-02"), "due");
  assert.equal(clozeReviewTaskStatus(getClozeReviewTask(key), "2026-08-03"), "overdue");
});
