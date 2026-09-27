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

const {
  emptyClozeProgress,
  recordFirstAnswer,
  recordFirstConfidence,
  recordReviewAnswer,
  recordReviewConfidence,
} = await import("../src/clozeProgress.js");
const {
  REASON_ANSWERLESS_CHANGED,
  REASON_ANSWERLESS_LOW_CONFIDENCE,
  REASON_CHANGED_ANSWER,
  REASON_CHANGED_TO_WRONG,
  REASON_D1_CHANGED,
  REASON_D1_LOW_CONFIDENCE,
  REASON_D1_SELF_RATING_UNSTABLE,
  REASON_D1_WRONG,
  REASON_D7_CONFIRMATION,
  REASON_FINAL_WRONG,
  REASON_GUESS,
  REASON_HIGH_CONFIDENCE_WRONG,
  REASON_SELF_CORRECTED,
  REASON_TRANSLATION_UNRESOLVED,
  REASON_UNCERTAIN,
  OUTCOME_CORRECT,
  OUTCOME_STABLE,
  OUTCOME_UNSTABLE,
  OUTCOME_WRONG,
  computeD1AttemptOutcome,
  deriveBlankResolved,
  selectD1Targets,
  selectD7Targets,
} = await import("../src/clozeReview.js");

// 构造一个只有指定空位有作答的 progress。
function progressWith(entries, blankCount = 20) {
  let progress = emptyClozeProgress("r1", "c1", Array.from({ length: blankCount }, (_, i) => i + 1), 1);
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
const blankIds = (selected) => selected.map((item) => Number(item.blankId));
const reasonsOf = (selected, blankId) => selected.find((item) => String(item.blankId) === String(blankId))?.reasons || [];

// ---------------- D+1 有答案 ----------------

test("review 最终仍错进入 D+1", () => {
  const progress = progressWith([{ number: 3, first: "A", review: "B", reviewConf: "confident" }]);
  const selected = selectD1Targets({ progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [3]);
  assert.ok(reasonsOf(selected, 3).includes(REASON_FINAL_WRONG));
});

test("高置信错误进入 D+1", () => {
  const progress = progressWith([{ number: 5, first: "B", review: "B", reviewConf: "confident" }]);
  const selected = selectD1Targets({ progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [5]);
  assert.ok(reasonsOf(selected, 5).includes(REASON_HIGH_CONFIDENCE_WRONG));
});

test("first 正确 → review 改错为最高优先级 hard-risk", () => {
  const progress = progressWith([
    { number: 1, first: "A", review: "B", reviewConf: "confident" },
    { number: 2, first: "A", review: "B", reviewConf: "uncertain" },
  ]);
  const selected = selectD1Targets({ progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [1, 2]);
  assert.ok(reasonsOf(selected, 1).includes(REASON_CHANGED_TO_WRONG));
  assert.ok(reasonsOf(selected, 1).includes(REASON_HIGH_CONFIDENCE_WRONG));
});

test("first 错 → review 仍错进入", () => {
  const progress = progressWith([{ number: 4, first: "B", review: "C" }]);
  const selected = selectD1Targets({ progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [4]);
  assert.ok(reasonsOf(selected, 4).includes(REASON_FINAL_WRONG));
});

test("first 错 → review 自我纠正仍进入但优先级较低", () => {
  const progress = progressWith([
    { number: 7, first: "B", review: "A", reviewConf: "confident" },
    { number: 9, first: "B", review: "B", reviewConf: "confident" },
  ]);
  const selected = selectD1Targets({ progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [9, 7]);
  assert.ok(reasonsOf(selected, 7).includes(REASON_SELF_CORRECTED));
  assert.ok(Number(selected[0].riskScore) < Number(selected[1].riskScore));
});

test("改答（first != review）进入", () => {
  const progress = progressWith([{ number: 8, first: "A", review: "C" }]);
  const selected = selectD1Targets({ progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [8]);
  assert.ok(reasonsOf(selected, 8).includes(REASON_CHANGED_ANSWER));
});

test("guess 进入；ordinary uncertain 可以进入；稳定正确不进入", () => {
  const progress = progressWith([
    { number: 1, first: "A", review: "A", reviewConf: "guess" },
    { number: 2, first: "A", review: "A", reviewConf: "uncertain" },
    { number: 3, first: "A", review: "A", reviewConf: "confident" },
    { number: 4, first: "A", review: "A" },
  ]);
  const selected = selectD1Targets({ progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [1, 2]);
  assert.ok(reasonsOf(selected, 1).includes(REASON_GUESS));
  assert.ok(reasonsOf(selected, 2).includes(REASON_UNCERTAIN));
});

test("analyzed / AI diagnosis / basisTypes / references 单独都不触发", () => {
  let progress = progressWith([{ number: 1, first: "A", review: "A", reviewConf: "confident" }]);
  progress = {
    ...progress,
    attempts: {
      ...progress.attempts,
      "1": { ...progress.attempts["1"], analyzed: true, basisTypes: ["logic"], references: [] },
      "2": { ...progress.attempts["2"], analyzed: true, basisTypes: [], references: [] },
    },
  };
  const selected = selectD1Targets({ progress, officialAnswers: OFFICIAL });
  assert.deepEqual(selected, []);
});

test("20 空不会机械全部进入；soft limit 只限制普通项，hard-risk 全保留", () => {
  // 12 个 hard-risk + 8 个稳定正确：12 个 hard-risk 全部保留，普通项为 0。
  const entries = [];
  for (let i = 1; i <= 12; i += 1) {
    entries.push({ number: i, first: "A", review: i % 2 ? "B" : "C", reviewConf: "confident" });
  }
  for (let i = 13; i <= 20; i += 1) {
    entries.push({ number: i, first: "A", review: "A", reviewConf: "confident" });
  }
  const selected = selectD1Targets({ progress: progressWith(entries), officialAnswers: OFFICIAL });
  assert.equal(selected.length, 12);
  assert.deepEqual(blankIds(selected), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("hard-risk 少于 soft limit 时普通项补足到 8", () => {
  const entries = [];
  for (let i = 1; i <= 3; i += 1) {
    entries.push({ number: i, first: "A", review: "B", reviewConf: "confident" });
  }
  for (let i = 4; i <= 12; i += 1) {
    entries.push({ number: i, first: "A", review: "A", reviewConf: "uncertain" });
  }
  const selected = selectD1Targets({ progress: progressWith(entries), officialAnswers: OFFICIAL });
  assert.equal(selected.length, 8);
  assert.deepEqual(blankIds(selected), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("ranking deterministic：对象遍历顺序不影响结果", () => {
  const build = () => {
    let progress = progressWith([]);
    for (let i = 1; i <= 8; i += 1) {
      progress = recordFirstAnswer(progress, i, i % 2 ? "A" : "B");
      progress = recordReviewAnswer(progress, i, i % 3 ? "C" : "B");
      progress = recordReviewConfidence(progress, i, i % 2 ? "confident" : "uncertain");
    }
    return progress;
  };
  const official = { 1: "A", 2: "B", 3: "C", 4: "D", 5: "A", 6: "B", 7: "C", 8: "D" };
  const first = selectD1Targets({ progress: build(), officialAnswers: official });
  const second = selectD1Targets({ progress: build(), officialAnswers: official });
  assert.deepEqual(first, second);
});

test("supporting signal 只做同风险类内 tie-break", () => {
  const progress = progressWith([
    { number: 1, first: "A", review: "A", reviewConf: "uncertain" },
    { number: 2, first: "A", review: "A", reviewConf: "uncertain" },
  ]);
  const supportByBlank = { "1": { referencesEmpty: true, translationUnresolved: true }, "2": {} };
  const selected = selectD1Targets({ progress, officialAnswers: OFFICIAL, supportByBlank });
  assert.deepEqual(blankIds(selected), [1, 2]);
  assert.ok(selected[0].supportScore > selected[1].supportScore);
});

test("references 为空单独不触发（无风险时 support 不产生候选）", () => {
  const progress = progressWith([{ number: 1, first: "A", review: "A", reviewConf: "confident" }]);
  const selected = selectD1Targets({
    progress,
    officialAnswers: OFFICIAL,
    supportByBlank: { "1": { referencesEmpty: true } },
  });
  assert.deepEqual(selected, []);
});

// ---------------- Answerless D+1 ----------------

test("无答案：改答 / guess / uncertain / translation unresolved 可触发", () => {
  const progress = progressWith([
    { number: 1, first: "A", review: "B", reviewConf: "confident" },
    { number: 2, first: "A", review: "A", reviewConf: "guess" },
    { number: 3, first: "A", review: "A", reviewConf: "uncertain" },
    { number: 4, first: "A", review: "A", reviewConf: "confident" },
  ]);
  const selected = selectD1Targets({
    progress,
    officialAnswers: {},
    supportByBlank: { "4": { translationUnresolved: true } },
  });
  assert.deepEqual(blankIds(selected), [1, 2, 3, 4]);
  assert.ok(reasonsOf(selected, 1).includes(REASON_ANSWERLESS_CHANGED));
  assert.ok(reasonsOf(selected, 2).includes(REASON_ANSWERLESS_LOW_CONFIDENCE));
});

test("无答案：稳定 + confident 不进入；无 correctness 字段", () => {
  const progress = progressWith([{ number: 1, first: "A", review: "A", reviewConf: "confident" }]);
  const selected = selectD1Targets({ progress, officialAnswers: {} });
  assert.deepEqual(selected, []);
  const raw = JSON.stringify(selected);
  assert.ok(!raw.includes("correct"));
  assert.ok(!raw.includes("wrong"));
  assert.ok(!raw.includes("accuracy"));
});

// ---------------- D+1 attempt outcome ----------------

test("有答案 outcome 由本地 officialAnswer 计算", () => {
  assert.equal(computeD1AttemptOutcome({ attempt: { answer: "A" }, officialAnswer: "A" }), OUTCOME_CORRECT);
  assert.equal(computeD1AttemptOutcome({ attempt: { answer: "B" }, officialAnswer: "A" }), OUTCOME_WRONG);
});

// ---------------- D+7 retention ----------------

function d1TaskWith(targets, attempts = {}, reasons = {}) {
  return {
    taskKey: "cloze-review:d1:r1:c1:2026-08-01",
    type: "d1",
    resourceId: "r1",
    clozeId: "c1",
    sourceDate: "2026-08-01",
    targetBlankIds: targets,
    targetReasons: reasons,
    attempts,
  };
}

test("D+1 稳定普通项退出 D+7", () => {
  const progress = progressWith([{ number: 1, first: "B", review: "A", reviewConf: "confident" }]);
  const d1Task = d1TaskWith(
    [1],
    { "1": { answer: "A", confidence: "confident", outcome: OUTCOME_CORRECT, selfRating: "stable" } },
    { "1": [REASON_FINAL_WRONG] },
  );
  const selected = selectD7Targets({ d1Task, progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), []);
});

test("D+1 仍错进入 D+7", () => {
  const progress = progressWith([{ number: 1, first: "B", review: "B", reviewConf: "confident" }]);
  const d1Task = d1TaskWith(
    [1],
    { "1": { answer: "B", confidence: "confident", outcome: OUTCOME_WRONG, selfRating: "stable" } },
    { "1": [REASON_FINAL_WRONG] },
  );
  const selected = selectD7Targets({ d1Task, progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [1]);
  assert.ok(reasonsOf(selected, 1).includes(REASON_D1_WRONG));
});

test("D+1 low confidence / guess 进入", () => {
  const progress = progressWith([{ number: 1, first: "A", review: "A", reviewConf: "confident" }]);
  const d1Task = d1TaskWith(
    [1],
    { "1": { answer: "A", confidence: "guess", outcome: OUTCOME_CORRECT, selfRating: "stable" } },
    { "1": [REASON_GUESS] },
  );
  const selected = selectD7Targets({ d1Task, progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [1]);
  assert.ok(reasonsOf(selected, 1).includes(REASON_D1_LOW_CONFIDENCE));
});

test("D+1 再次改答（与 D 当天不一致）进入", () => {
  const progress = progressWith([{ number: 1, first: "B", review: "A", reviewConf: "confident" }]);
  const d1Task = d1TaskWith(
    [1],
    { "1": { answer: "C", confidence: "confident", outcome: OUTCOME_WRONG, selfRating: "stable" } },
    { "1": [REASON_FINAL_WRONG] },
  );
  const selected = selectD7Targets({ d1Task, progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [1]);
  assert.ok(reasonsOf(selected, 1).includes(REASON_D1_CHANGED));
});

test("D+1 self-rating 不稳定进入", () => {
  const progress = progressWith([{ number: 1, first: "A", review: "A", reviewConf: "confident" }]);
  const d1Task = d1TaskWith(
    [1],
    { "1": { answer: "A", confidence: "confident", outcome: OUTCOME_CORRECT, selfRating: "unstable" } },
    { "1": [REASON_GUESS] },
  );
  const selected = selectD7Targets({ d1Task, progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [1]);
  assert.ok(reasonsOf(selected, 1).includes(REASON_D1_SELF_RATING_UNSTABLE));
});

test("D 当天高置信错误即使 D+1 一次稳定也进入 D+7 确认", () => {
  const progress = progressWith([{ number: 1, first: "B", review: "B", reviewConf: "confident" }]);
  const d1Task = d1TaskWith(
    [1],
    { "1": { answer: "A", confidence: "confident", outcome: OUTCOME_CORRECT, selfRating: "stable" } },
    { "1": [REASON_HIGH_CONFIDENCE_WRONG] },
  );
  const selected = selectD7Targets({ d1Task, progress, officialAnswers: OFFICIAL });
  assert.deepEqual(blankIds(selected), [1]);
  assert.ok(reasonsOf(selected, 1).includes(REASON_D7_CONFIRMATION));
});

test("D+7 target 数通常少于 D+1", () => {
  const progress = progressWith([]);
  const d1Attempts = {};
  for (let i = 1; i <= 8; i += 1) {
    d1Attempts[String(i)] = { answer: "A", confidence: "confident", outcome: OUTCOME_CORRECT, selfRating: "stable" };
  }
  // 8 个 D+1 target，其中 3 个是高置信错误原项（继续 D+7），其余稳定退出。
  const reasons = {};
  for (let i = 1; i <= 8; i += 1) {
    reasons[String(i)] = i <= 3 ? [REASON_HIGH_CONFIDENCE_WRONG] : [REASON_UNCERTAIN];
  }
  const d1Task = d1TaskWith([1, 2, 3, 4, 5, 6, 7, 8], d1Attempts, reasons);
  const selected = selectD7Targets({ d1Task, progress, officialAnswers: OFFICIAL });
  assert.ok(selected.length < 8);
  assert.equal(selected.length, 3);
});

test("translation 仍未解决作为 D+7 保留信号", () => {
  const progress = progressWith([{ number: 1, first: "B", review: "A", reviewConf: "confident" }]);
  const d1Task = d1TaskWith(
    [1],
    { "1": { answer: "A", confidence: "confident", outcome: OUTCOME_CORRECT, selfRating: "stable" } },
    { "1": [REASON_FINAL_WRONG] },
  );
  const withSupport = selectD7Targets({
    d1Task,
    progress,
    officialAnswers: OFFICIAL,
    supportByBlank: { "1": { translationUnresolved: true } },
  });
  assert.deepEqual(blankIds(withSupport), [1]);
  assert.ok(reasonsOf(withSupport, 1).includes(REASON_TRANSLATION_UNRESOLVED));
});

test("无答案 D+7：stable + confident 退出，其余保留", () => {
  const progress = progressWith([{ number: 1, first: "A", review: "A", reviewConf: "confident" }]);
  const stableTask = d1TaskWith(
    [1],
    { "1": { answer: "A", confidence: "confident", outcome: OUTCOME_STABLE, selfRating: "stable" } },
    { "1": [REASON_ANSWERLESS_CHANGED] },
  );
  assert.deepEqual(blankIds(selectD7Targets({ d1Task: stableTask, progress, officialAnswers: {} })), []);
  const shakyTask = d1TaskWith(
    [1],
    { "1": { answer: "A", confidence: "uncertain", outcome: OUTCOME_UNSTABLE, selfRating: "unstable" } },
    { "1": [REASON_ANSWERLESS_CHANGED] },
  );
  const selected = selectD7Targets({ d1Task: shakyTask, progress, officialAnswers: {} });
  assert.deepEqual(blankIds(selected), [1]);
});

// ---------------- resolved 派生 ----------------

test("有答案 resolved 必须 correct + confident", () => {
  const base = { d1Task: null, d7Task: null, blankId: "1", officialAnswers: OFFICIAL };
  const attempt = (overrides) => ({ blankIdentity: "1", reviewedAt: 1, ...overrides });
  assert.equal(deriveBlankResolved({
    ...base,
    d7Task: { attempts: { "1": attempt({ answer: "A", confidence: "confident", outcome: OUTCOME_CORRECT }) } },
  }), true);
  assert.equal(deriveBlankResolved({
    ...base,
    d7Task: { attempts: { "1": attempt({ answer: "A", confidence: "uncertain", outcome: OUTCOME_CORRECT }) } },
  }), false);
  assert.equal(deriveBlankResolved({
    ...base,
    d7Task: { attempts: { "1": attempt({ answer: "A", confidence: "guess", outcome: OUTCOME_CORRECT }) } },
  }), false);
  assert.equal(deriveBlankResolved({
    ...base,
    d7Task: { attempts: { "1": attempt({ answer: "B", confidence: "confident", outcome: OUTCOME_WRONG }) } },
  }), false);
});

test("resolved 派生使用 D+7 优先于 D+1", () => {
  const d1 = { attempts: { "1": { reviewedAt: 1, answer: "A", confidence: "confident", outcome: OUTCOME_CORRECT } } };
  const d7 = { attempts: { "1": { reviewedAt: 2, answer: "B", confidence: "confident", outcome: OUTCOME_WRONG } } };
  assert.equal(deriveBlankResolved({ d1Task: d1, d7Task: d7, blankId: "1", officialAnswers: OFFICIAL }), false);
});

test("无答案 resolved 需要 stable + confident", () => {
  const d7 = { attempts: { "1": { reviewedAt: 1, answer: "A", confidence: "confident", selfRating: "stable" } } };
  assert.equal(deriveBlankResolved({ d7Task: d7, blankId: "1", officialAnswers: {} }), true);
  const shaky = { attempts: { "1": { reviewedAt: 1, answer: "A", confidence: "confident", selfRating: "unstable" } } };
  assert.equal(deriveBlankResolved({ d7Task: shaky, blankId: "1", officialAnswers: {} }), false);
});
