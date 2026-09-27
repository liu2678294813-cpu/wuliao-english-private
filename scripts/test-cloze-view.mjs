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
  buildBlankCorrectionRow,
  buildClozeFinalReadModel,
  buildClozePassageTokens,
  canEditAnswers,
  canEditFirstAnswers,
  canEditReviewAnswers,
  canSeeOfficialAnswers,
  changeLabel,
  clozeBlankNumbers,
  isCorrectionStage,
  isPostCorrectionStage,
  effectiveClozeAnswer,
  effectiveClozeConfidence,
  officialAnswerFor,
  priorityBlankNumbers,
  resolveClozeSource,
  summarizeCorrection,
} = await import("../src/clozeView.js");
const {
  emptyClozeProgress,
  recordFirstAnswer,
  recordFirstConfidence,
  recordReviewAnswer,
  recordReviewConfidence,
  setActiveBlank,
  markFirstSubmitted,
  markReviewSubmitted,
} = await import("../src/clozeProgress.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function sampleCloze() {
  return {
    id: "cloze-2007",
    paragraphs: [
      {
        number: 1,
        segments: [
          { type: "text", text: "People have always" },
          { type: "blank", number: 1 },
          { type: "text", text: "that the world is getting smaller." },
        ],
      },
      {
        number: 2,
        segments: [
          { type: "text", text: "But few" },
          { type: "blank", number: 2 },
          { type: "text", text: "how fast." },
        ],
      },
    ],
    blanks: Array.from({ length: 20 }, (_, index) => ({
      id: `blank-${index + 1}`,
      number: index + 1,
      options: ["A", "B", "C", "D"].map((key) => ({ key, text: `option-${key}` })),
      complete: true,
    })),
  };
}

test("连续正文模型：保留段落顺序，blank 有稳定 anchor", () => {
  const model = buildClozePassageTokens(sampleCloze());
  assert.equal(model.paragraphs.length, 2);
  assert.equal(model.paragraphs[0].tokens[0].type, "text");
  assert.equal(model.paragraphs[0].tokens[1].type, "blank");
  assert.equal(model.paragraphs[0].tokens[1].number, 1);
  assert.equal(model.paragraphs[0].tokens[1].anchor, "cloze-blank-1");
  assert.equal(model.blankToParagraph[2], 1);
});

test("内置完形与自定义完形使用同一资源契约", () => {
  const official = resolveClozeSource({ id: "postgraduate-2007-cloze", year: 2007, clozeSource: "/x.json" });
  assert.equal(official.isOfficial, true);
  assert.equal(official.year, 2007);
  const custom = resolveClozeSource({ id: "custom-abc", analysis: { clozes: [sampleCloze()] } });
  assert.equal(custom.isOfficial, false);
  assert.ok(!custom.year || custom.year === 0);
});

test("阶段权限：初做只允许 first，复查只允许 review，订正不可编辑", () => {
  assert.equal(canEditFirstAnswers("cloze-first-attempt"), true);
  assert.equal(canEditReviewAnswers("cloze-first-attempt"), false);
  assert.equal(canEditFirstAnswers("cloze-self-review"), false);
  assert.equal(canEditReviewAnswers("cloze-self-review"), true);
  assert.equal(canEditAnswers("cloze-correction"), false);
  assert.equal(canEditAnswers("cloze-cover"), false);
});

test("官方答案隔离：订正前拿不到，订正后才能获得", () => {
  assert.equal(canSeeOfficialAnswers("cloze-first-attempt"), false);
  assert.equal(canSeeOfficialAnswers("cloze-self-review"), false);
  assert.equal(isCorrectionStage("cloze-correction"), true);
  assert.equal(isCorrectionStage("cloze-analysis"), false);
  assert.equal(isPostCorrectionStage("cloze-correction"), true);
  assert.equal(isPostCorrectionStage("cloze-analysis"), true);
  assert.equal(isPostCorrectionStage("cloze-final-read"), true);
  assert.equal(canSeeOfficialAnswers("cloze-correction"), true);
  assert.equal(canSeeOfficialAnswers("cloze-analysis"), true);
  assert.equal(canSeeOfficialAnswers("cloze-final-read"), true);
  const keys = officialAnswerFor("cloze-correction", { id: "postgraduate-2007-cloze", year: 2007 }, "cloze-2007", true);
  assert.ok(keys && keys[1], "订正阶段应返回官方答案");
  assert.equal(officialAnswerFor("cloze-self-review", { id: "postgraduate-2007-cloze", year: 2007 }, "cloze-2007", true), null);
  assert.equal(officialAnswerFor("cloze-correction", { id: "custom-abc" }, "custom-abc", false), null, "自定义完形没有官方答案");
});

test("pre-correction 不调用答案 resolver，三个 post-correction 阶段才调用", () => {
  let calls = 0;
  const resolver = () => { calls += 1; return { 1: "A" }; };
  const resource = { id: "postgraduate-2007-cloze", year: 2007 };
  for (const stage of ["cloze-cover", "cloze-first-attempt", "cloze-self-review"]) {
    assert.equal(officialAnswerFor(stage, resource, "cloze-2007", true, resolver), null);
  }
  assert.equal(calls, 0);
  for (const stage of ["cloze-correction", "cloze-analysis", "cloze-final-read"]) {
    assert.equal(officialAnswerFor(stage, resource, "cloze-2007", true, resolver)[1], "A");
  }
  assert.equal(calls, 3);
});

test("订正对照行：first/review/official 独立比较", () => {
  const attempt = { number: 3, firstAnswer: "A", reviewAnswer: "C", firstConfidence: "confident", reviewConfidence: "guess" };
  const row = buildBlankCorrectionRow(attempt, "C");
  assert.equal(row.first, "A");
  assert.equal(row.review, "C");
  assert.equal(row.firstCorrect, false);
  assert.equal(row.reviewCorrect, true);
  assert.equal(row.changed, true);
  assert.equal(changeLabel(attempt), "改答 A → C");
  assert.equal(changeLabel({ number: 1, firstAnswer: "A", reviewAnswer: "A" }), "保持原答案");
});

test("订正汇总：正确率与变化统计", () => {
  fresh();
  let progress = emptyClozeProgress("r1", "c1", [1, 2, 3, 4], 0);
  progress = recordFirstAnswer(progress, 1, "A");
  progress = recordReviewAnswer(progress, 1, "B");
  progress = recordFirstAnswer(progress, 2, "B");
  progress = recordReviewAnswer(progress, 2, "B");
  const official = { 1: "A", 2: "B" };
  const summary = summarizeCorrection(progress, official);
  assert.equal(summary.total, 4);
  assert.equal(summary.firstCorrect, 2);
  assert.equal(summary.reviewCorrect, 1);
  assert.equal(summary.changed, 1);
  assert.equal(summary.hasOfficial, true);
  assert.equal(summary.accuracy, "1/2");
});

test("priority：订正前不依赖官方答案", () => {
  fresh();
  let progress = emptyClozeProgress("r1", "c1", [1, 2, 3], 0);
  // 1 未作答；2 uncertain；3 已答确定
  progress = recordFirstConfidence(progress, 2, "uncertain");
  progress = recordFirstAnswer(progress, 3, "A");
  progress = recordFirstConfidence(progress, 3, "confident");
  const before = priorityBlankNumbers(progress, "cloze-first-attempt", null);
  assert.deepEqual(before, [1, 2]);
});

test("priority：订正后加入错误项", () => {
  fresh();
  let progress = emptyClozeProgress("r1", "c1", [1, 2], 0);
  progress = recordFirstAnswer(progress, 1, "A");
  progress = recordFirstConfidence(progress, 1, "confident");
  progress = recordFirstAnswer(progress, 2, "B");
  progress = recordFirstConfidence(progress, 2, "confident");
  const after = priorityBlankNumbers(progress, "cloze-correction", { 1: "C", 2: "B" });
  assert.deepEqual(after, [1], "官方答案错误的空进入 priority，正确的空不进入");
});

test("priority 阶段矩阵：analysis/final-read 不退回 pre-correction", () => {
  fresh();
  let progress = emptyClozeProgress("r1", "c1", [1, 2], 0);
  progress = recordFirstAnswer(progress, 1, "A");
  progress = recordFirstConfidence(progress, 1, "confident");
  progress = recordFirstAnswer(progress, 2, "B");
  progress = recordFirstConfidence(progress, 2, "confident");
  const official = { 1: "C", 2: "B" };
  for (const stage of ["cloze-cover", "cloze-first-attempt", "cloze-self-review"]) {
    assert.deepEqual(priorityBlankNumbers(progress, stage, official), []);
  }
  for (const stage of ["cloze-correction", "cloze-analysis", "cloze-final-read"]) {
    assert.deepEqual(priorityBlankNumbers(progress, stage, official), [1]);
  }
});

test("post-correction 生效答案与置信度统一使用 review 优先", () => {
  const attempt = {
    firstAnswer: "A",
    reviewAnswer: "C",
    firstConfidence: "confident",
    reviewConfidence: "uncertain",
  };
  assert.equal(effectiveClozeAnswer(attempt, "cloze-first-attempt"), "A");
  assert.equal(effectiveClozeAnswer(attempt, "cloze-self-review"), "C");
  for (const stage of ["cloze-correction", "cloze-analysis", "cloze-final-read"]) {
    assert.equal(effectiveClozeAnswer(attempt, stage), "C");
    assert.equal(effectiveClozeConfidence(attempt, stage), "uncertain");
  }
});

test("final-read 官方用答案文本，自定义只用用户最终选择且保留未答空", () => {
  const cloze = sampleCloze();
  let progress = emptyClozeProgress("r1", "c1", [1, 2], 0);
  progress = recordFirstAnswer(progress, 1, "A");
  progress = recordReviewAnswer(progress, 1, "C");
  const official = buildClozeFinalReadModel(cloze, progress, { 1: "B", 2: "D" }, true);
  assert.equal(official.paragraphs[0].tokens[1].text, "option-B");
  const custom = buildClozeFinalReadModel(cloze, progress, {}, false);
  assert.equal(custom.paragraphs[0].tokens[1].text, "option-C");
  assert.equal(custom.paragraphs[1].tokens[1].text, "");
  assert.equal(official.paragraphs[0].tokens[1].leadingSpace, true);
  assert.equal(official.paragraphs[0].tokens[1].trailingSpace, true);
  const punctuationCloze = {
    ...cloze,
    paragraphs: [{ number: 1, segments: [
      { type: "text", text: "It was" },
      { type: "blank", number: 1 },
      { type: "text", text: ", however." },
    ] }],
  };
  const punctuation = buildClozeFinalReadModel(punctuationCloze, progress, { 1: "B" }, true);
  assert.equal(punctuation.paragraphs[0].tokens[1].trailingSpace, false, "标点前不能插入额外空格");
});

test("first/review 置信度互不覆盖", () => {
  fresh();
  let progress = emptyClozeProgress("r1", "c1", [1], 0);
  progress = recordFirstConfidence(progress, 1, "confident");
  progress = recordReviewConfidence(progress, 1, "guess");
  assert.equal(progress.attempts[1].firstConfidence, "confident");
  assert.equal(progress.attempts[1].reviewConfidence, "guess");
});

test("提交状态与 activeBlank 持久化", () => {
  fresh();
  let progress = emptyClozeProgress("r1", "c1", [1, 2, 3], 0);
  progress = setActiveBlank(progress, 2);
  progress = markFirstSubmitted(progress, true);
  progress = markReviewSubmitted(progress, true);
  assert.equal(progress.activeBlank, 2);
  assert.equal(progress.firstSubmitted, true);
  assert.equal(progress.reviewSubmitted, true);
});

test("clozeBlankNumbers 从 blanks 或正文 tokens 推导", () => {
  assert.deepEqual(clozeBlankNumbers(sampleCloze()), Array.from({ length: 20 }, (_, index) => index + 1));
  const partial = { paragraphs: [{ number: 1, segments: [{ type: "blank", number: 5 }] }] };
  assert.deepEqual(clozeBlankNumbers(partial), [5]);
});
