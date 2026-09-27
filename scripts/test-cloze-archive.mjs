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
  recordReviewAnswer,
  recordFirstConfidence,
  recordReviewConfidence,
  setPrediction,
  setBasisTypes,
  addReference,
} = await import("../src/clozeProgress.js");
const { emptyClozeTranslationProgress, setClozeTranslationText, markClozeTranslationTranslated, markClozeTranslationCorrected } = await import("../src/clozeTranslationProgress.js");
const { emptyClozeFlow, completeClozeStage, saveClozeFlow } = await import("../src/clozeFlow.js");
const { TASK_TYPE_D1, TASK_TYPE_D7, ensureClozeReviewTask } = await import("../src/clozeReview.js");
const {
  buildClozeArchiveEntry,
  basisDistributionInReviewTargets,
  findClozeReviewTasksForEntry,
  listCompletedClozeRecords,
  parseClozeFlowKey,
} = await import("../src/clozeLearningArchive.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function makeProgress() {
  let progress = emptyClozeProgress("postgraduate-2009-cloze", "cloze-2009", Array.from({ length: 3 }, (_, i) => i + 1), 1);
  progress = recordFirstAnswer(progress, 1, "A"); // 对
  progress = recordReviewAnswer(progress, 1, "A");
  progress = recordFirstConfidence(progress, 1, "confident");
  progress = recordReviewConfidence(progress, 1, "confident");
  progress = recordFirstAnswer(progress, 2, "B"); // 高置信错误
  progress = recordReviewAnswer(progress, 2, "B");
  progress = recordFirstConfidence(progress, 2, "confident");
  progress = recordReviewConfidence(progress, 2, "confident");
  progress = recordFirstAnswer(progress, 3, "B"); // first 错 → review 自查纠正
  progress = recordReviewAnswer(progress, 3, "A");
  progress = recordReviewConfidence(progress, 3, "uncertain");
  progress = setPrediction(progress, 3, "词义题");
  progress = setBasisTypes(progress, 3, ["logic"]);
  progress = addReference(progress, 3, {
    paragraphNumber: 1,
    sentenceIndex: 0,
    sentenceKey: "cloze:x:p1s1:y",
    fingerprint: "y",
    excerpt: "The ____ was important",
  });
  return progress;
}

const OFFICIAL = { 1: "A", 2: "A", 3: "A" };

test("parseClozeFlowKey 与已完成记录枚举", () => {
  fresh();
  assert.deepEqual(parseClozeFlowKey("postgraduate-2009-cloze:cloze-2009"), {
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
  });
  assert.equal(parseClozeFlowKey("onlyone"), null);
  assert.equal(parseClozeFlowKey(":empty"), null);

  let flow = emptyClozeFlow("postgraduate-2009-cloze", "cloze-2009", 1000);
  for (const stage of ["cloze-cover", "cloze-first-attempt", "cloze-self-review", "cloze-correction", "cloze-analysis", "cloze-final-read"]) {
    flow = completeClozeStage(flow, stage, 1000);
  }
  saveClozeFlow(flow);
  const records = listCompletedClozeRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].resourceId, "postgraduate-2009-cloze");
  assert.equal(records[0].sourceDate, "1970-01-01");
  // 未完成 flow 不出现
  let partial = emptyClozeFlow("postgraduate-2010-cloze", "cloze-2010", 1000);
  partial = completeClozeStage(partial, "cloze-cover", 1000);
  saveClozeFlow(partial);
  assert.equal(listCompletedClozeRecords().length, 1);
});

test("有答案档案：正确率与风险统计全部派生自本地 officialAnswer", () => {
  fresh();
  const progress = makeProgress();
  const entry = buildClozeArchiveEntry({
    progress,
    translationProgress: emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1),
    officialAnswers: OFFICIAL,
    completedAt: 1000,
  });
  assert.equal(entry.hasOfficial, true);
  assert.equal(entry.counts.firstCompleted, 3);
  assert.equal(entry.counts.reviewCompleted, 3);
  assert.equal(entry.counts.finalCorrect, 2);
  assert.equal(entry.counts.finalWrong, 1);
  assert.equal(entry.counts.highConfidenceWrong, 1);
  assert.equal(entry.counts.selfCorrected, 1);
  assert.equal(entry.counts.changedToWrong, 0);
  assert.equal(entry.counts.changed, 1);
  const blank2 = entry.blanks.find((blank) => blank.number === 2);
  assert.equal(blank2.finalWrong, true);
  assert.equal(blank2.resolved, null); // 未进入 D+1
  const blank3 = entry.blanks.find((blank) => blank.number === 3);
  assert.equal(blank3.referencesCount, 1);
  assert.deepEqual(blank3.basisTypes, ["logic"]);
  assert.equal(blank3.prediction, "词义题");
});

test("无答案档案：不产生任何 correctness / accuracy", () => {
  fresh();
  const progress = makeProgress();
  const entry = buildClozeArchiveEntry({
    progress,
    translationProgress: emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1),
    officialAnswers: {},
    completedAt: 1000,
  });
  assert.equal(entry.hasOfficial, false);
  assert.equal(entry.counts.finalCorrect, null);
  assert.equal(entry.counts.finalWrong, null);
  assert.equal(entry.counts.highConfidenceWrong, null);
  assert.equal(entry.counts.selfCorrected, null);
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes("accuracy"));
  assert.ok(!serialized.includes("correctCount"));
  assert.ok(!serialized.includes("wrongCount"));
  // 改答 / 置信度仍可统计
  assert.equal(entry.counts.changed, 1);
  assert.equal(entry.counts.uncertain, 1);
});

test("D+1 / D+7 outcome 正确进入档案；resolved 派生", () => {
  fresh();
  const progress = makeProgress();
  const d1Task = {
    taskKey: "cloze-review:d1:postgraduate-2009-cloze:cloze-2009:2026-08-01",
    type: TASK_TYPE_D1,
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    targetBlankIds: [2, 3],
    targetReasons: { 2: ["high-confidence-wrong"], 3: ["self-corrected"] },
    attempts: {
      "2": { answer: "A", confidence: "confident", outcome: "correct", reviewedAt: 100 },
      "3": { answer: "B", confidence: "confident", outcome: "wrong", reviewedAt: 100 },
    },
  };
  const d7Task = {
    taskKey: "cloze-review:d7:postgraduate-2009-cloze:cloze-2009:2026-08-01",
    type: TASK_TYPE_D7,
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    sourceDate: "2026-08-01",
    targetBlankIds: [2, 3],
    targetReasons: { 2: ["d7-confirmation"], 3: ["d1-wrong"] },
    attempts: {
      "2": { answer: "A", confidence: "confident", outcome: "correct", reviewedAt: 200 },
      "3": { answer: "B", confidence: "confident", outcome: "wrong", reviewedAt: 200 },
    },
  };
  const entry = buildClozeArchiveEntry({
    progress,
    translationProgress: emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1),
    d1Task,
    d7Task,
    officialAnswers: OFFICIAL,
    completedAt: 1000,
  });
  assert.equal(entry.review.d1TargetCount, 2);
  assert.equal(entry.review.d1CompletedCount, 2);
  assert.equal(entry.review.d1ResolvedCount, 1); // 空2 稳定；空3 D+7 仍错
  assert.equal(entry.review.d7TargetCount, 2);
  assert.equal(entry.review.d7CompletedCount, 2);
  assert.equal(entry.review.d7UnresolvedCount, 1);
  assert.equal(entry.review.lastReviewedAt, 200);
  const blank2 = entry.blanks.find((blank) => blank.number === 2);
  assert.equal(blank2.resolved, true);
  const blank3 = entry.blanks.find((blank) => blank.number === 3);
  assert.equal(blank3.resolved, false);
});

test("findClozeReviewTasksForEntry 按 sourceDate 匹配", () => {
  const tasks = [
    {
      type: "d1",
      resourceId: "postgraduate-2009-cloze",
      clozeId: "cloze-2009",
      sourceDate: "2026-07-01",
      taskKey: "k1",
    },
    {
      type: "d1",
      resourceId: "postgraduate-2009-cloze",
      clozeId: "cloze-2009",
      sourceDate: "2026-08-01",
      taskKey: "k2",
    },
  ];
  const matched = findClozeReviewTasksForEntry(tasks, "postgraduate-2009-cloze", "cloze-2009", "2026-08-01");
  assert.equal(matched.d1Task.taskKey, "k2");
  const fallback = findClozeReviewTasksForEntry(tasks, "postgraduate-2009-cloze", "cloze-2009", "2026-09-01");
  assert.equal(fallback.d1Task.taskKey, "k2");
  assert.equal(fallback.d7Task, null);
});

test("basis 分布是依据统计而非错误类型；措辞不产生能力推断", () => {
  const entries = [
    {
      blanks: [
        { inD1: true, inD7: false, basisTypes: ["logic", "context"] },
        { inD1: false, inD7: false, basisTypes: ["logic"] },
        { inD1: true, inD7: true, basisTypes: ["grammar"] },
      ],
    },
  ];
  const stats = basisDistributionInReviewTargets(entries);
  assert.equal(stats.reviewedBlankCount, 2);
  const logic = stats.distribution.find((item) => item.basis === "logic");
  assert.equal(logic.count, 1); // 空1 计入一次
  assert.equal(stats.distribution.length, 3);
  const serialized = JSON.stringify(stats);
  assert.ok(!serialized.includes("错误"));
  assert.ok(!serialized.includes("能力差"));
});

test("档案不复制 first/review 为新真源：仍可从 progress 读取", () => {
  fresh();
  const progress = makeProgress();
  const entry = buildClozeArchiveEntry({
    progress,
    translationProgress: emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1),
    officialAnswers: OFFICIAL,
    completedAt: 1000,
  });
  // entry 内含 per-blank 快照（展示用），但不存在独立持久化层：
  // 断言没有引入新的 storage key 或 schema
  const storageKeys = [...globalThis.localStorage.map.keys()];
  assert.equal(storageKeys.some((key) => key.includes("clozeLearningArchive")), false);
  assert.equal(storageKeys.some((key) => key.includes("cloze-archive")), false);
});

test("译文统计：corrected / translated 计数", () => {
  fresh();
  const progress = makeProgress();
  let translation = emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1);
  translation = setClozeTranslationText(translation, "cloze:x:p1s1:y", "译文一", 2);
  translation = markClozeTranslationTranslated(translation, "cloze:x:p1s1:y", 3);
  translation = markClozeTranslationCorrected(translation, "cloze:x:p1s1:y", 4);
  translation = setClozeTranslationText(translation, "cloze:x:p1s2:z", "译文二", 5);
  translation = markClozeTranslationTranslated(translation, "cloze:x:p1s2:z", 6);
  const entry = buildClozeArchiveEntry({
    progress,
    translationProgress: translation,
    officialAnswers: OFFICIAL,
    completedAt: 1000,
  });
  assert.equal(entry.translation.corrected, 1);
  assert.equal(entry.translation.translated, 1);
});
