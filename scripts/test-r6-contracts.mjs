// R6 · 完形学习结果与长期档案升级契约测试。
//
// 覆盖：
//   A. 本篇学习结果（有答案 / 无答案 / 旧 completed / D+1/D+7 状态视图）
//   B. 长期档案筛选（时间 / 状态 / 年份）
//   C. 总览聚合（correctness 分母只含官方资料；resolved 跨类型聚合）
//   D. 优先复盘（排序 / 原因去重 / 不使用 AI 推测与 basisTypes 推断）
//   E. AI history 确定性索引（不串空 / 不串篇 / reading 不进入 / 无 metadata 不 fuzzy）
//   F. UI 语义（无答案 DOM 无 correctness 文案；AI 区域标注"AI 当时的推测"）
//   G. 精读工具栏折叠 pill 几何契约（左上角、无全宽占位、不与阶段提示相交）

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createViteModuleRunner } from "./vite-module-runner.mjs";

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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");

const { setCurrentUsername, setUserItem } = await import("../src/userData.js");
const {
  emptyClozeProgress,
  recordFirstAnswer,
  recordReviewAnswer,
  recordFirstConfidence,
  recordReviewConfidence,
  markAnalyzed,
  setPrediction,
  setBasisTypes,
  addReference,
  saveClozeProgress,
} = await import("../src/clozeProgress.js");
const {
  emptyClozeTranslationProgress,
  setClozeTranslationText,
  markClozeTranslationTranslated,
  markClozeTranslationCorrected,
  saveClozeTranslationProgress,
} = await import("../src/clozeTranslationProgress.js");
const {
  ensureClozeReviewTask,
  startClozeReviewTask,
  completeClozeReviewTask,
  recordClozeReviewAttempt,
  TASK_TYPE_D1,
  TASK_TYPE_D7,
} = await import("../src/clozeReview.js");
const {
  buildClozeLearningSummary,
  buildClozeArchiveOverview,
  buildClozePriorityReviewItems,
  buildClozeRecent7,
  filterClozeArchiveEntries,
  indexClozeAiHistory,
  clozeYearOfResourceId,
} = await import("../src/clozeLearningSummary.js");
const { buildClozeArchiveEntry } = await import("../src/clozeLearningArchive.js");
const { localDateKey } = await import("../src/readingReview.js");

const OFFICIAL = { 1: "A", 2: "A", 3: "A" };

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function makeProgress({ analyzed = [] } = {}) {
  let progress = emptyClozeProgress("postgraduate-2009-cloze", "cloze-2009", [1, 2, 3], 1);
  progress = recordFirstAnswer(progress, 1, "A");
  progress = recordReviewAnswer(progress, 1, "A");
  progress = recordFirstConfidence(progress, 1, "confident");
  progress = recordReviewConfidence(progress, 1, "confident");
  progress = recordFirstAnswer(progress, 2, "B");
  progress = recordReviewAnswer(progress, 2, "B");
  progress = recordFirstConfidence(progress, 2, "confident");
  progress = recordReviewConfidence(progress, 2, "confident");
  progress = recordFirstAnswer(progress, 3, "B");
  progress = recordReviewAnswer(progress, 3, "A");
  progress = recordReviewConfidence(progress, 3, "uncertain");
  progress = setPrediction(progress, 1, "词义辨析");
  progress = setBasisTypes(progress, 1, ["grammar", "logic"]);
  progress = addReference(progress, 1, {
    paragraphNumber: 1,
    sentenceIndex: 0,
    sentenceKey: "cloze:x:p1s1:y",
    fingerprint: "y",
    excerpt: "The ____ was important",
  });
  for (const number of analyzed) progress = markAnalyzed(progress, number, true);
  return progress;
}

function makeTranslation({ corrected = true } = {}) {
  let progress = emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1);
  progress = setClozeTranslationText(progress, "cloze:x:p1s1:y", "这句话很重要");
  progress = markClozeTranslationTranslated(progress, "cloze:x:p1s1:y");
  if (corrected) progress = markClozeTranslationCorrected(progress, "cloze:x:p1s1:y");
  return progress;
}

function makeOfficialResource() {
  return { id: "postgraduate-2009-cloze", kind: "official-cloze", year: 2009, title: "2009 英语（一）完形填空", clozeSource: "/x.json" };
}

function makeItem(overrides = {}) {
  const progress = overrides.progress || makeProgress();
  const entry = overrides.entry || null;
  const officialAnswers = overrides.officialAnswers !== undefined ? overrides.officialAnswers : OFFICIAL;
  const completedAt = overrides.completedAt || 1000;
  return {
    record: {
      resourceId: overrides.resourceId || "postgraduate-2009-cloze",
      clozeId: overrides.clozeId || "cloze-2009",
      completedAt,
      sourceDate: "1970-01-01",
    },
    title: overrides.title || "2009 英语（一）完形填空",
    year: overrides.year !== undefined ? overrides.year : 2009,
    d1Task: overrides.d1Task || null,
    d7Task: overrides.d7Task || null,
    officialAnswers,
    entry: entry || buildClozeArchiveEntrySafe(progress, completedAt, officialAnswers, overrides.d1Task, overrides.d7Task),
  };
}

function buildClozeArchiveEntrySafe(progress, completedAt, officialAnswers, d1Task, d7Task) {
  return buildClozeArchiveEntry({
    progress,
    translationProgress: emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1),
    d1Task,
    d7Task,
    officialAnswers,
    completedAt,
  });
}

function makeD1Task({ resolvedBlankIds = [], unresolvedBlankIds = [], dueDate = "1970-01-02", completed = false, started = false, reasons = {} } = {}) {
  const targetBlankIds = [...resolvedBlankIds, ...unresolvedBlankIds].sort((a, b) => a - b);
  const attempts = {};
  const now = 2000;
  for (const blankId of resolvedBlankIds) {
    attempts[String(blankId)] = {
      blankIdentity: String(blankId),
      answer: OFFICIAL[blankId] || "A",
      confidence: "confident",
      selfRating: "stable",
      outcome: "correct",
      reviewedAt: now,
    };
  }
  for (const blankId of unresolvedBlankIds) {
    attempts[String(blankId)] = {
      blankIdentity: String(blankId),
      answer: "B",
      confidence: "uncertain",
      selfRating: "unstable",
      outcome: "wrong",
      reviewedAt: now,
    };
  }
  return {
    taskKey: `cloze-review:d1:postgraduate-2009-cloze:cloze-2009:1970-01-01`,
    schemaVersion: 1,
    type: TASK_TYPE_D1,
    resourceId: "postgraduate-2009-cloze",
    clozeId: "cloze-2009",
    sourceDate: "1970-01-01",
    dueDate,
    createdAt: 1000,
    startedAt: started ? 1500 : null,
    completedAt: completed ? 2000 : null,
    skippedAt: null,
    currentIndex: targetBlankIds.length,
    targetBlankIds,
    targetReasons: reasons,
    attempts,
    updatedAt: 2000,
  };
}

function makeD7Task({ resolvedBlankIds = [], unresolvedBlankIds = [], dueDate = "1970-01-08", completed = false } = {}) {
  const task = makeD1Task({ resolvedBlankIds, unresolvedBlankIds, dueDate, completed });
  return { ...task, taskKey: task.taskKey.replace(":d1:", ":d7:"), type: TASK_TYPE_D7 };
}

// ---------------- A. 本篇学习结果 ----------------

test("A1 有答案 summary：correctness 与精析完成度全部派生", () => {
  fresh();
  const progress = makeProgress({ analyzed: [1, 2] });
  const summary = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [],
  });
  assert.equal(summary.hasOfficial, true);
  assert.equal(summary.counts.finalCorrect, 2);
  assert.equal(summary.counts.finalWrong, 1);
  assert.equal(summary.counts.selfCorrected, 1);
  assert.equal(summary.counts.changedToWrong, 0);
  assert.equal(summary.counts.highConfidenceWrong, 1);
  assert.equal(summary.counts.changed, 1);
  assert.equal(summary.analysis.analyzed, 2);
  assert.equal(summary.analysis.total, 3);
  assert.equal(summary.analysis.predictions, 1);
  assert.equal(summary.analysis.withBasis, 1);
  assert.equal(summary.analysis.withReferences, 1);
  assert.equal(summary.analysis.translation.corrected, 1);
  assert.equal(summary.analysis.translation.translated, 0);
  assert.equal(summary.confidence.confident, 2);
  assert.equal(summary.confidence.uncertain, 1);
  const blank2 = summary.blanks.find((blank) => blank.number === 2);
  assert.equal(blank2.highConfidenceWrong, true);
  assert.equal(blank2.officialAnswer, "A");
  assert.equal(blank2.finalWrong, true);
  const blank3 = summary.blanks.find((blank) => blank.number === 3);
  assert.equal(blank3.selfCorrected, true);
  assert.equal(blank3.changedToWrong, false);
  // 未进入长期复习：resolved 为 null
  assert.equal(summary.blanks[0].resolved, null);
  assert.equal(summary.review.d1.exists, false);
  assert.equal(summary.review.d7.exists, false);
  assert.equal(summary.review.longTerm.total, 0);
});

test("A2 无答案 summary：不存在任何 correctness 字段与语义", () => {
  fresh();
  const progress = makeProgress({});
  const summary = buildClozeLearningSummary({
    resource: { id: "custom-x", kind: "custom", title: "自定义完形" },
    clozeId: "custom-x",
    completedAt: 1000,
    progress,
    translationProgress: emptyClozeTranslationProgress("custom-x", "custom-x", 1),
    officialAnswers: {},
    unknownWords: [],
    aiHistoryRecords: [],
  });
  assert.equal(summary.hasOfficial, false);
  assert.equal(summary.counts.highConfidenceWrong, null);
  assert.equal(summary.counts.changedToWrong, null);
  assert.equal(summary.counts.selfCorrected, null);
  assert.equal(summary.counts.finalCorrect, null);
  assert.equal(summary.counts.finalWrong, null);
  assert.equal(summary.counts.firstCorrect, null);
  assert.equal(summary.counts.reviewCorrect, null);
  assert.equal(summary.counts.changed, 1);
  assert.equal(summary.confidence.confident, 2);
  assert.equal(summary.confidence.guesses, 0);
  for (const blank of summary.blanks) {
    assert.equal(blank.officialAnswer, "");
    assert.equal(blank.highConfidenceWrong, null);
    assert.equal(blank.changedToWrong, null);
    assert.equal(blank.finalWrong, null);
    assert.equal(blank.finalCorrect, null);
  }
  // 无答案时 correctness 相关 UI flag 不存在
  assert.equal("finalCorrect" in summary.counts ? summary.counts.finalCorrect : null, null);
});

test("A3 旧 completed（无 D+1/D+7）可生成结果且不创建任何任务", () => {
  fresh();
  const progress = makeProgress({});
  saveClozeProgress(progress);
  saveClozeTranslationProgress(makeTranslation());
  const keyCountBefore = globalThis.localStorage.length;
  const summary = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [],
  });
  assert.equal(summary.review.d1.exists, false);
  assert.equal(summary.review.d7.exists, false);
  assert.equal(summary.review.longTerm.total, 0);
  assert.equal(globalThis.localStorage.length, keyCountBefore, "build summary 不得写任何存储");
  // 档案入口打开历史记录也不产生 task
  assert.equal(
    [...Array(globalThis.localStorage.length).keys()].filter((index) => globalThis.localStorage.key(index).includes("cloze-review-task")).length,
    0,
  );
});

test("A4 D+1/D+7 状态视图：future / due / in_progress / completed / completed-unresolved", () => {
  fresh();
  const progress = makeProgress({});
  // 使用应用真实的本地日期键，避免 UTC 日期在凌晨时段（UTC 前一天）误判为 overdue。
  const today = localDateKey(new Date());
  const nextDay = localDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000));

  // due（今天到期）D+1：2 空完成，1 空稳定
  const d1 = makeD1Task({
    resolvedBlankIds: [1],
    unresolvedBlankIds: [2],
    dueDate: today,
  });
  let summary = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    d1Task: d1,
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [],
  });
  assert.equal(summary.review.d1.status, "due");
  assert.equal(summary.review.d1.targetCount, 2);
  assert.equal(summary.review.d1.completedCount, 2);
  assert.equal(summary.review.d1.resolvedCount, 1);
  assert.equal(summary.review.d1.unresolvedCount, 1);
  assert.equal(summary.review.longTerm.total, 2);
  assert.equal(summary.review.longTerm.stable, 1);

  // in_progress
  const d1Started = { ...d1, startedAt: 1500, dueDate: "1970-01-01" };
  summary = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    d1Task: d1Started,
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [],
  });
  assert.equal(summary.review.d1.status, "in_progress");

  // completed（已完成）
  const d1Completed = { ...d1, completedAt: 2000, dueDate: "1970-01-01" };
  summary = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    d1Task: d1Completed,
    d7Task: makeD7Task({ resolvedBlankIds: [1, 2], dueDate: "1970-01-08", completed: true }),
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [],
  });
  assert.equal(summary.review.d1.status, "completed");
  assert.equal(summary.review.d7.status, "completed");
  assert.equal(summary.review.d7.resolvedCount, 2);
  assert.equal(summary.review.d7.unresolvedCount, 0);

  // completed 但 D+7 仍未稳定：不自动创建新任务
  const d7Unresolved = makeD7Task({ resolvedBlankIds: [1], unresolvedBlankIds: [2], dueDate: "1970-01-08", completed: true });
  const keyCountBefore = globalThis.localStorage.length;
  summary = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    d1Task: d1Completed,
    d7Task: d7Unresolved,
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [],
  });
  assert.equal(summary.review.d7.status, "completed");
  assert.equal(summary.review.d7.unresolvedCount, 1);
  assert.equal(globalThis.localStorage.length, keyCountBefore, "不得创建 D+14 / 重启 task");
  // 仍不稳定空可见
  const unstable = summary.blanks.filter((blank) => (blank.inD1 || blank.inD7) && blank.resolved === false);
  assert.equal(unstable.length, 1);
  assert.equal(unstable[0].number, 2);

  // future（未到期）只展示日期信息
  const d7Future = makeD7Task({ resolvedBlankIds: [1], unresolvedBlankIds: [2], dueDate: nextDay });
  summary = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    d1Task: d1Completed,
    d7Task: d7Future,
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [],
  });
  assert.equal(summary.review.d7.status, "scheduled");
  assert.equal(summary.review.d7.dueDate, nextDay);
});

test("A5 陌生词按 resourceId + clozeId + sourceType=cloze 聚合", () => {
  fresh();
  const summary = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress: makeProgress({}),
    translationProgress: emptyClozeTranslationProgress("postgraduate-2009-cloze", "cloze-2009", 1),
    officialAnswers: OFFICIAL,
    unknownWords: [
      { resourceId: "postgraduate-2009-cloze", clozeId: "cloze-2009", sourceType: "cloze", word: "despite" },
      { resourceId: "postgraduate-2009-cloze", clozeId: "cloze-2009", word: "legacy-no-source-type" },
      { resourceId: "postgraduate-2009-cloze", clozeId: "other", sourceType: "cloze", word: "other-cloze" },
      { resourceId: "other-resource", clozeId: "cloze-2009", sourceType: "cloze", word: "other-resource" },
    ],
    aiHistoryRecords: [],
  });
  assert.equal(summary.unknownWords.count, 1);
  assert.equal(summary.unknownWords.items[0].word, "despite");
});

// ---------------- B. 长期档案筛选 ----------------

test("B1 时间筛选：7d / 30d / all 以 completedAt 为基准", () => {
  fresh();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const items = [
    makeItem({ completedAt: now - 1 * day }),
    makeItem({ completedAt: now - 20 * day, resourceId: "custom-2", clozeId: "custom-2", year: null, title: "自定义 2" }),
    makeItem({ completedAt: now - 100 * day, resourceId: "custom-3", clozeId: "custom-3", year: null, title: "自定义 3" }),
  ];
  assert.equal(filterClozeArchiveEntries(items, { range: "7d", now }).length, 1);
  assert.equal(filterClozeArchiveEntries(items, { range: "30d", now }).length, 2);
  assert.equal(filterClozeArchiveEntries(items, { range: "all", now }).length, 3);
});

test("B2 状态筛选：待复习 / 仍不稳定 / 高置信错误 / 改答后错", () => {
  fresh();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const progress = makeProgress({});
  const withD1 = makeItem({
    completedAt: now - 1 * day,
    d1Task: makeD1Task({ resolvedBlankIds: [1], unresolvedBlankIds: [2], dueDate: "2000-01-01" }),
  });
  const answerlessUnstable = makeItem({
    completedAt: now - 2 * day,
    resourceId: "custom-1",
    clozeId: "custom-1",
    year: null,
    officialAnswers: {},
    progress,
  });
  const answerlessPlain = makeItem({
    completedAt: now - 3 * day,
    resourceId: "custom-2",
    clozeId: "custom-2",
    year: null,
    officialAnswers: {},
    progress: makeProgress({ analyzed: [1, 2, 3] }),
  });
  const items = [withD1, answerlessUnstable, answerlessPlain];
  assert.equal(filterClozeArchiveEntries(items, { range: "all", status: "all", now }).length, 3);
  assert.equal(filterClozeArchiveEntries(items, { range: "all", status: "pending-review", now }).length, 1);
  assert.equal(filterClozeArchiveEntries(items, { range: "all", status: "unresolved", now }).length, 1);
  // 高置信错误 / 改答后错：只有 hasOfficial 记录进入，无答案资料不得混入
  const hcw = filterClozeArchiveEntries(items, { range: "all", status: "high-confidence-wrong", now });
  assert.equal(hcw.length, 1);
  assert.equal(hcw[0].record.resourceId, "postgraduate-2009-cloze");
});

test("B3 年份筛选：官方年份与自定义分离", () => {
  fresh();
  const items = [
    makeItem({ resourceId: "postgraduate-2009-cloze", clozeId: "cloze-2009", year: 2009 }),
    makeItem({ resourceId: "postgraduate-2020-cloze", clozeId: "cloze-2020", year: 2020 }),
    makeItem({ resourceId: "custom-1", clozeId: "custom-1", year: null }),
  ];
  assert.equal(filterClozeArchiveEntries(items, { range: "all", year: "all" }).length, 3);
  assert.equal(filterClozeArchiveEntries(items, { range: "all", year: "2009" }).length, 1);
  assert.equal(filterClozeArchiveEntries(items, { range: "all", year: "custom" }).length, 1);
  assert.equal(clozeYearOfResourceId("postgraduate-2020-cloze"), 2020);
  assert.equal(clozeYearOfResourceId("custom-abc"), null);
});

// ---------------- C. 总览聚合 ----------------

test("C1 correctness 分母只含官方资料；无答案资料不进入 correctness", () => {
  fresh();
  const official = makeItem({});
  const answerless = makeItem({
    resourceId: "custom-1",
    clozeId: "custom-1",
    year: null,
    officialAnswers: {},
  });
  const overview = buildClozeArchiveOverview([official, answerless], { range: "all" });
  assert.equal(overview.official.present, true);
  assert.equal(overview.official.entryCount, 1);
  assert.equal(overview.official.finalCorrectTotal, 2);
  assert.equal(overview.official.finalWrongTotal, 1);
  assert.equal(overview.highConfidenceWrongCount, 1);
  assert.equal(overview.changedToWrongCount, 0);
  assert.equal(overview.selfCorrectedCount, 1);
  assert.equal(overview.completedCount, 2);
});

test("C2 全部无答案：不产生 correctness 指标，resolved 仍按各自规则聚合", () => {
  fresh();
  const a1 = makeItem({ resourceId: "custom-1", clozeId: "custom-1", year: null, officialAnswers: {} });
  const a2 = makeItem({ resourceId: "custom-2", clozeId: "custom-2", year: null, officialAnswers: {} });
  const overview = buildClozeArchiveOverview([a1, a2], { range: "all" });
  assert.equal(overview.official.present, false);
  assert.equal(overview.official.finalCorrectTotal, 0);
  assert.equal(overview.official.finalWrongTotal, 0);
  assert.equal(overview.highConfidenceWrongCount, 0);
  assert.equal(overview.longTerm.total, 0);
  assert.equal(overview.completedCount, 2);
});

test("C3 最近 7 天紧凑事实", () => {
  fresh();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const items = [
    makeItem({ completedAt: now - 1 * day, d1Task: makeD1Task({ resolvedBlankIds: [1], unresolvedBlankIds: [2] }) }),
    makeItem({ completedAt: now - 40 * day }),
  ];
  const recent7 = buildClozeRecent7(items, { now });
  assert.equal(recent7.completedCount, 1);
  assert.equal(recent7.d1BlankCount, 2);
  assert.equal(recent7.d7BlankCount, 0);
  assert.equal(recent7.unstableBlankCount, 1);
});

// ---------------- D. 优先复盘 ----------------

test("D1 排序：D+7 未稳定 > 需要行动 > D+1 未稳定 > 高置信错误；原因去重", () => {
  fresh();
  const progress = makeProgress({});
  const now = Date.now();
  const d7Item = makeItem({
    completedAt: now,
    d1Task: makeD1Task({ resolvedBlankIds: [1], unresolvedBlankIds: [2], completed: true }),
    d7Task: makeD7Task({ resolvedBlankIds: [1], unresolvedBlankIds: [2] }),
  });
  const dueItem = makeItem({
    completedAt: now - 1000,
    resourceId: "postgraduate-2010-cloze",
    clozeId: "cloze-2010",
    d1Task: makeD1Task({ resolvedBlankIds: [1], unresolvedBlankIds: [2], dueDate: "2000-01-01" }),
  });
  const d1UnstableItem = makeItem({
    completedAt: now - 2000,
    resourceId: "postgraduate-2011-cloze",
    clozeId: "cloze-2011",
    d1Task: makeD1Task({ resolvedBlankIds: [1], unresolvedBlankIds: [2], completed: true }),
  });
  const hcwItem = makeItem({ completedAt: now - 3000, resourceId: "postgraduate-2012-cloze", clozeId: "cloze-2012", d1Task: null, d7Task: null });

  const items = [hcwItem, d1UnstableItem, dueItem, d7Item];
  const list = buildClozePriorityReviewItems(items, { today: "1970-01-02" });
  // d7 未稳定 1 + 逾期任务 1 + d1 未稳定 1 + 高置信错误 1
  assert.ok(list.length >= 4, `expected priority items, got ${list.length}`);
  for (const item of list) assert.ok(item.record, "优先复盘项必须携带 record（供打开本篇结果）");
  // tier 顺序确定
  const tierOrder = list.map((item) => item.tier);
  assert.deepEqual(tierOrder, [...tierOrder].sort((a, b) => a - b));
  assert.equal(list[0].statusKey, "d7-unresolved");
  assert.equal(list[0].resourceId, "postgraduate-2009-cloze");
  // 原因去重：同一空多个原因去重后显示
  for (const item of list) {
    assert.equal(item.reasons.length, new Set(item.reasons).size, `reasons 已去重: ${item.reasons}`);
    for (const reason of item.reasons) {
      assert.ok(!/ai/i.test(reason), "不使用 AI 相关原因");
      assert.ok(!/basis/i.test(reason), "不使用 basisTypes 推断原因");
    }
  }
});

test("D2 优先复盘不使用 AI diagnosis 与 basisTypes 能力推断", () => {
  fresh();
  const progress = makeProgress({ analyzed: [1, 2, 3] });
  const item = makeItem({
    d1Task: makeD1Task({
      resolvedBlankIds: [1],
      unresolvedBlankIds: [2],
      completed: true,
      reasons: { "2": ["guess", "guess", "d1-wrong"] },
    }),
  });
  const list = buildClozePriorityReviewItems([item], { today: "1970-01-03" });
  const blank2 = list.find((entry) => entry.blankId === 2);
  assert.ok(blank2);
  assert.deepEqual(blank2.reasons.sort(), ["d1-wrong", "d1-unresolved", "guess"].sort());
});

// ---------------- E. AI history 索引 ----------------

test("E1 只按稳定 cloze metadata 索引；不串空 / 不串篇 / reading 不进入", () => {
  fresh();
  const now = Date.now();
  const records = [
    {
      id: "h1", name: "完形第 8 空", kind: "cloze-explanation", createdAt: now, updatedAt: now,
      metadata: { sourceType: "cloze", resourceId: "postgraduate-2009-cloze", clozeId: "cloze-2009", blankNumber: 8, taskType: "cloze-explanation" },
    },
    {
      id: "h2", name: "完形第 9 空", kind: "cloze-diagnosis", createdAt: now, updatedAt: now,
      metadata: { sourceType: "cloze", resourceId: "postgraduate-2009-cloze", clozeId: "cloze-2009", blankNumber: 9, taskType: "cloze-diagnosis" },
    },
    {
      id: "h3", name: "其它篇第 8 空", kind: "cloze-explanation", createdAt: now, updatedAt: now,
      metadata: { sourceType: "cloze", resourceId: "postgraduate-2010-cloze", clozeId: "cloze-2010", blankNumber: 8, taskType: "cloze-explanation" },
    },
    { id: "h4", name: "阅读讲解", kind: "explain", createdAt: now, updatedAt: now, metadata: null },
    { id: "h5", name: "旧完形记录（无 metadata）", kind: "cloze-explanation", createdAt: now, updatedAt: now },
    { id: "h6", name: "异常 blank 0", kind: "cloze-explanation", createdAt: now, updatedAt: now,
      metadata: { sourceType: "cloze", resourceId: "postgraduate-2009-cloze", clozeId: "cloze-2009", blankNumber: 0, taskType: "cloze-explanation" } },
  ];
  const index = indexClozeAiHistory(records);
  const blank8 = index.get("postgraduate-2009-cloze|cloze-2009|8") || [];
  assert.equal(blank8.length, 1);
  assert.equal(blank8[0].id, "h1");
  // 不串空
  assert.equal((index.get("postgraduate-2009-cloze|cloze-2009|9") || []).length, 1);
  // 不串篇
  assert.equal((index.get("postgraduate-2010-cloze|cloze-2010|8") || []).length, 1);
  // reading 与无 metadata 旧记录不进入
  assert.equal(index.size, 3);
});

test("E2 AI history 不进入任何统计；过期/缺失不影响 summary", () => {
  fresh();
  const progress = makeProgress({});
  const withRecords = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [
      {
        id: "h1", name: "完形第 1 空", kind: "cloze-explanation", createdAt: 1, updatedAt: 1,
        metadata: { sourceType: "cloze", resourceId: "postgraduate-2009-cloze", clozeId: "cloze-2009", blankNumber: 1, taskType: "cloze-explanation" },
      },
    ],
  });
  const withoutRecords = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [],
  });
  assert.equal(withRecords.aiHistoryTotal, 1);
  assert.equal(withRecords.blanks.find((blank) => blank.number === 1).aiHistory.length, 1);
  // 不影响统计
  assert.deepEqual(withRecords.counts, withoutRecords.counts);
  assert.deepEqual(withRecords.review, withoutRecords.review);
  assert.deepEqual(withRecords.analysis, withoutRecords.analysis);
  assert.deepEqual(withRecords.priorityReview, withoutRecords.priorityReview);
  // 缺失（load 返回 null）时 summary 不报错
  const missing = buildClozeLearningSummary({
    resource: makeOfficialResource(),
    clozeId: "cloze-2009",
    completedAt: 1000,
    progress,
    translationProgress: makeTranslation(),
    officialAnswers: OFFICIAL,
    unknownWords: [],
    aiHistoryRecords: [{ id: "ghost", name: "", kind: "", createdAt: 0, updatedAt: 0, metadata: { sourceType: "cloze", resourceId: "postgraduate-2009-cloze", clozeId: "cloze-2009", blankNumber: 99, taskType: "" } }],
  });
  assert.equal(missing.blanks.length, 3);
});

// ---------------- F. UI 语义（jsdom 渲染） ----------------

test("F1 无答案资料 DOM 中不出现 correctness 文案；AI 区域有标注", async () => {
  const { JSDOM } = await import("jsdom");
  const { default: React, act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of ["window", "document", "localStorage", "CustomEvent", "Event", "MouseEvent", "HTMLElement", "Node"]) {
    globalThis[key] = dom.window[key];
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = (timer) => clearTimeout(timer);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};

  const vite = await createViteModuleRunner(root);
  try {
    const { default: ClozeSummaryPanel } = await vite.import("/src/ClozeSummaryPanel.jsx");
    const { setCurrentUsername: setUser } = await vite.import("/src/userData.js");
    const clozeProgressModule = await vite.import("/src/clozeProgress.js");
    const translationModule = await vite.import("/src/clozeTranslationProgress.js");
    const { setUserItem } = await vite.import("/src/userData.js");

    fresh();
    setUser("alice");
    let progress = clozeProgressModule.emptyClozeProgress("custom-x", "custom-x", [1, 2], 1);
    progress = clozeProgressModule.recordFirstAnswer(progress, 1, "A");
    progress = clozeProgressModule.recordReviewAnswer(progress, 1, "B");
    progress = clozeProgressModule.recordFirstConfidence(progress, 1, "confident");
    progress = clozeProgressModule.recordReviewConfidence(progress, 1, "guess");
    progress = clozeProgressModule.recordFirstAnswer(progress, 2, "C");
    progress = clozeProgressModule.recordReviewAnswer(progress, 2, "C");
    progress = clozeProgressModule.recordFirstConfidence(progress, 2, "uncertain");
    clozeProgressModule.saveClozeProgress(progress);
    translationModule.saveClozeTranslationProgress(translationModule.emptyClozeTranslationProgress("custom-x", "custom-x", 1));

    // 注入带稳定 metadata 的完形 AI history（第 2 空）
    const now = Date.now();
    setUserItem("wuliao:ai:history", JSON.stringify([{
      id: "ai-ui-1",
      name: "完形第 2 空 · cloze-diagnosis",
      chapter: "完形填空",
      sentence: "sentence",
      kind: "cloze-diagnosis",
      model: "deepseek-chat",
      messages: [{ role: "assistant", content: "推测内容" }],
      createdAt: now,
      updatedAt: now,
      favorite: false,
      metadata: { sourceType: "cloze", resourceId: "custom-x", clozeId: "custom-x", blankNumber: 2, taskType: "cloze-diagnosis" },
    }]));

    const container = document.getElementById("root");
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(ClozeSummaryPanel, {
        resourceId: "custom-x",
        clozeId: "custom-x",
        completedAt: 1000,
        onClose() {},
      }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    // ModalShell 通过 portal 渲染到 document.body
    let panel = null;
    for (let attempt = 0; attempt < 20 && !panel; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      panel = document.querySelector(".cloze-summary-panel");
    }
    assert.ok(panel, "本篇结果应渲染");
    // 展开"逐空详情"后才显示空位级 AI 链接
    const expandButtons = [...document.querySelectorAll(".cloze-summary-blanks-tools button")];
    const expand = expandButtons.find((button) => button.textContent.includes("展开"));
    assert.ok(expand, "应存在展开按钮");
    await act(async () => { expand.click(); await new Promise((resolve) => setTimeout(resolve, 30)); });
    const text = document.body.textContent;
    for (const forbidden of ["正确率", "错题", "高置信错误", "改答后错", "最终正确", "复查正确", "答对", "答错", "初做正确", "官方答案："]) {
      assert.ok(!text.includes(forbidden), `无答案 DOM 不应出现「${forbidden}」`);
    }
    // 无答案提示语必须出现（"官方答案"一词只允许出现在该提示中）
    assert.ok(text.includes("此资料没有可靠官方答案"), "无答案提示必须置顶可见");
    assert.equal(text.split("官方答案").length, 2, "「官方答案」只能出现在无答案提示语中");
    // AI 区域必须标注"AI 当时的推测"，且不进入统计
    assert.ok(text.includes("AI 当时的推测 · 1 条"), "AI 历史链接应出现");
    assert.ok(text.includes("不作为长期事实统计"), "AI 免责标注必须出现");
    await act(async () => { root.unmount(); });
  } finally {
    await vite.close();
  }
});

// ---------------- G. 精读工具栏折叠 pill 几何契约 ----------------

test("G1 折叠 pill 钉在 Reader 左上角、非全宽、不与阶段提示相交", () => {
  const source = read("src/redesign/reader.css");
  assert.match(source, /\.annotation-toolbar\.collapsed \.toolbar-collapse-toggle/);
  assert.match(source, /position: fixed/);
  assert.match(source, /min-height: 44px/);
  assert.match(source, /min-width: 118px/);
  // 不允许宽度 100% 的文档流占位
  assert.doesNotMatch(source, /\.annotation-toolbar\.collapsed \.toolbar-collapse-toggle\s*\{[^}]*width: 100%/s);
  assert.match(source, /\.annotation-toolbar\.collapsed/);
  assert.match(source, /height: 0 !important/);
  // 阶段提示与 pill 使用间距分开（left 偏移而非叠放）
  const hintRule = source.match(/\.annotation-toolbar\.collapsed \.toolbar-stage-hint\s*\{([^}]*)\}/s);
  assert.ok(hintRule, "stage hint 规则存在");
  assert.match(hintRule[1], /left: calc/);
  assert.match(hintRule[1], /128px/);
  // safe-area 遵守
  assert.match(source, /env\(safe-area-inset-top/);
});
