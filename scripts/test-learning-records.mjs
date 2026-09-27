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
  buildLearningIdentityKey,
  clearLearningRecords,
  deleteLearningRecord,
  getLearningRecordByIdentity,
  listLearningRecords,
  setLearningRecordResolved,
  updateTagStatus,
  upsertQuestionDiagnosisRecord,
  upsertTranslationReviewRecord,
} = await import("../src/aiLearningRecords.js");
const {
  filterRecordsByType,
  getOverview,
  getPendingTagEntries,
  getQuestionTypeCounts,
  getReliableTagCounts,
  getReviewSuggestions,
  getTrapCounts,
} = await import("../src/aiLearningStats.js");

const RECORDS_KEY = "wuliao:ai:learning-records";
const HISTORY_KEY = "wuliao:ai:history";
const scoped = (username, key) => `wuliao:user:${encodeURIComponent(username)}:${key}`;

function freshRecords() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

function tr(payload = {}) {
  return upsertTranslationReviewRecord({
    resourceId: "postgraduate-2018-text-2",
    chapter: "英一.18.text2",
    sentenceId: "postgraduate-2018-text-2::passage-text-2::p3s2",
    itemLabel: "第3段第2句",
    inputMethod: "typed",
    errorTags: [],
    summaryLevel: "accurate",
    sentenceSnippet: "A short sentence snippet.",
    historyId: "ai-1",
    ...payload,
  });
}

function diag(payload = {}) {
  return upsertQuestionDiagnosisRecord({
    resourceId: "postgraduate-2019-text-3",
    chapter: "英一.19.text3",
    questionId: "q-3-32-0",
    questionNumber: "32",
    passageId: "passage-text-3",
    questionType: "推理题",
    diagnosisBasis: "user-reasoning",
    confidence: "high",
    firstAnswer: "B",
    redoAnswer: "D",
    firstCorrect: false,
    redoCorrect: false,
    userErrorTags: [],
    optionTrapTypes: [],
    inferredCauseSummary: "摘要",
    observedFacts: ["第一次选择 B，官方答案为 D"],
    nextTimeRule: "先定位原文",
    historyId: "ai-2",
    ...payload,
  });
}

test("测试1 A→D：有错误标签时建立翻译记录并进入统计", () => {
  freshRecords();
  tr({ errorTags: ["修饰范围错误", "漏译"] });
  const records = listLearningRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].taskType, "translation-review");
  assert.equal(records[0].reviewCount, 1);
  assert.equal(records[0].resolved, false);
  const counts = getReliableTagCounts(records, "all");
  assert.deepEqual(
    counts.sorted.map((item) => item.name).sort(),
    ["修饰范围错误", "漏译"].sort(),
  );
  assert.equal(counts.totalRecords, 1);
  const overview = getOverview(records, "all");
  assert.equal(overview.translationReviews, 1);
  assert.equal(overview.translationWithProblems, 1);
});

test("测试2 A 无错误：记录批改次数但不计错误", () => {
  freshRecords();
  tr({ errorTags: [], summaryLevel: "accurate" });
  const records = listLearningRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].resolved, true);
  assert.equal(getReliableTagCounts(records, "all").totalRecords, 0);
  const overview = getOverview(records, "all");
  assert.equal(overview.translationReviews, 1);
  assert.equal(overview.translationWithProblems, 0);
});

test("测试3 A 重复批改：同一句只更新 reviewCount", () => {
  freshRecords();
  const first = tr({ errorTags: ["修饰范围错误"] });
  const createdAt = first.record.createdAt;
  tr({ errorTags: ["修饰范围错误", "漏译"] });
  tr({ errorTags: ["漏译"] });
  const records = listLearningRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].reviewCount, 3);
  assert.equal(records[0].createdAt, createdAt);
  assert.deepEqual(records[0].tags.map((tag) => tag.name), ["漏译"]);
});

test("测试4 C high confidence：进入可靠统计", () => {
  freshRecords();
  diag({
    userErrorTags: ["忽略转折"],
    confidence: "high",
    diagnosisBasis: "user-reasoning",
  });
  const records = listLearningRecords();
  assert.equal(records.length, 1);
  assert.deepEqual(getReliableTagCounts(records, "all").sorted, [{ name: "忽略转折", count: 1 }]);
  assert.equal(getPendingTagEntries(records, "all").length, 0);
});

test("测试5 C low confidence：保存但不进核心错因，进入待确认", () => {
  freshRecords();
  diag({
    userErrorTags: ["忽略转折"],
    confidence: "low",
    diagnosisBasis: "answers-only",
  });
  const records = listLearningRecords();
  assert.equal(records.length, 1);
  assert.equal(getReliableTagCounts(records, "all").totalRecords, 0);
  const pending = getPendingTagEntries(records, "all");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tag.name, "忽略转折");
});

test("测试6 optionTrapType 与 userErrorTags 分离", () => {
  freshRecords();
  diag({
    userErrorTags: [],
    optionTrapTypes: ["范围扩大"],
  });
  const records = listLearningRecords();
  assert.equal(getTrapCounts(records, "all").length, 1);
  assert.equal(getReliableTagCounts(records, "all").totalRecords, 0);
});

test("测试7 用户确认 low 标签后进入核心统计", () => {
  freshRecords();
  const result = diag({
    userErrorTags: ["忽略转折"],
    confidence: "low",
    diagnosisBasis: "answers-only",
  });
  const updated = updateTagStatus(result.record.id, "忽略转折", "confirmed");
  assert.equal(updated.tags[0].source, "user-confirmed");
  assert.equal(updated.tags[0].status, "confirmed");
  const records = listLearningRecords();
  assert.deepEqual(getReliableTagCounts(records, "all").sorted, [{ name: "忽略转折", count: 1 }]);
  assert.equal(getPendingTagEntries(records, "all").length, 0);
});

test("测试8 用户否定 high 标签后退出核心统计", () => {
  freshRecords();
  const result = diag({
    userErrorTags: ["过度推断"],
    confidence: "high",
  });
  updateTagStatus(result.record.id, "过度推断", "dismissed");
  const records = listLearningRecords();
  assert.equal(getReliableTagCounts(records, "all").totalRecords, 0);
  assert.equal(records[0].tags[0].status, "dismissed");
});

test("测试9 resolved：已掌握后移出待复盘但记录保留", () => {
  freshRecords();
  const result = tr({ errorTags: ["漏译"] });
  assert.equal(result.record.resolved, false);
  setLearningRecordResolved(result.record.id, true);
  const records = listLearningRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].resolved, true);
  assert.equal(filterRecordsByType(records, "review").length, 0);
});

test("测试10 resolved 后重新出现错误自动恢复待复盘", () => {
  freshRecords();
  const result = tr({ errorTags: ["漏译"] });
  setLearningRecordResolved(result.record.id, true);
  const reopened = tr({ errorTags: ["漏译"] });
  assert.equal(reopened.record.resolved, false);
  assert.equal(filterRecordsByType(listLearningRecords(), "review").length, 1);
});

test("测试11 账号隔离：B 账号看不到 A 账号记录", () => {
  freshRecords();
  tr({ errorTags: ["漏译"] });
  assert.equal(listLearningRecords().length, 1);
  setCurrentUsername("bob");
  assert.equal(listLearningRecords().length, 0);
  setCurrentUsername("alice");
  assert.equal(listLearningRecords().length, 1);
});

test("测试12 时间筛选：7天/30天/全部统计正确", () => {
  freshRecords();
  tr({ errorTags: ["漏译"] });
  tr({
    resourceId: "postgraduate-2018-text-3",
    chapter: "英一.18.text3",
    sentenceId: "postgraduate-2018-text-3::passage-text-3::p1s1",
    errorTags: ["增译"],
  });
  // 把第二条记录改成 40 天前，模拟旧数据。
  const raw = JSON.parse(globalThis.localStorage.getItem(scoped("alice", RECORDS_KEY)));
  const old = raw.find((record) => record.sentenceId.includes("passage-text-3"));
  old.createdAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
  old.updatedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
  globalThis.localStorage.setItem(scoped("alice", RECORDS_KEY), JSON.stringify(raw));

  const seven = getReliableTagCounts(listLearningRecords(), "7d");
  assert.deepEqual(seven.sorted, [{ name: "漏译", count: 1 }]);
  const thirty = getReliableTagCounts(listLearningRecords(), "30d");
  assert.deepEqual(thirty.sorted, [{ name: "漏译", count: 1 }]);
  const all = getReliableTagCounts(listLearningRecords(), "all");
  assert.equal(all.sorted.length, 2);
});

test("测试13 坏数据：档案仍能正常打开并写入", () => {
  freshRecords();
  setUserItem(RECORDS_KEY, "{not-json");
  assert.deepEqual(listLearningRecords(), []);
  const result = tr({ errorTags: ["漏译"] });
  assert.equal(result.ok, true);
  assert.equal(listLearningRecords().length, 1);
  // 数组中的坏条目被跳过
  globalThis.localStorage.setItem(
    scoped("alice", RECORDS_KEY),
    JSON.stringify([null, 42, "bad", result.record]),
  );
  assert.equal(listLearningRecords().length, 1);
});

test("测试14 localStorage 写失败：不抛错且保留旧数据", () => {
  freshRecords();
  tr({ errorTags: ["漏译"] });
  const before = listLearningRecords();
  const originalSetItem = globalThis.localStorage.setItem.bind(globalThis.localStorage);
  globalThis.localStorage.setItem = () => {
    throw new Error("quota");
  };
  try {
    const failed = tr({ errorTags: ["增译"] });
    assert.equal(failed.ok, false);
    assert.deepEqual(listLearningRecords(), before);
  } finally {
    globalThis.localStorage.setItem = originalSetItem;
  }
});

test("测试15 删除记录：不影响 AI history 等其他数据", () => {
  freshRecords();
  setUserItem(HISTORY_KEY, JSON.stringify([{ id: "h1" }]));
  const result = tr({ errorTags: ["漏译"] });
  assert.equal(deleteLearningRecord(result.record.id), true);
  assert.equal(listLearningRecords().length, 0);
  assert.equal(JSON.parse(getUserItem(HISTORY_KEY)).length, 1);
});

test("测试16 清空：只清学习档案", () => {
  freshRecords();
  setUserItem(HISTORY_KEY, JSON.stringify([{ id: "h1" }]));
  tr({ errorTags: ["漏译"] });
  diag({ userErrorTags: ["忽略转折"] });
  assert.equal(clearLearningRecords(), true);
  assert.equal(listLearningRecords().length, 0);
  assert.equal(JSON.parse(getUserItem(HISTORY_KEY)).length, 1);
});

test("扩展 C 去重：同一题重复诊断只保留一条记录", () => {
  freshRecords();
  const first = diag({ userErrorTags: ["忽略转折"], confidence: "low" });
  const createdAt = first.record.createdAt;
  diag({ userErrorTags: ["同义替换未识别"], confidence: "high", diagnosisBasis: "user-reasoning" });
  const records = listLearningRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].reviewCount, 2);
  assert.equal(records[0].createdAt, createdAt);
  assert.deepEqual(records[0].tags.map((tag) => tag.name), ["同义替换未识别"]);
});

test("扩展 确认状态跨重新诊断保留；否定状态不自动延续", () => {
  freshRecords();
  const result = diag({ userErrorTags: ["忽略转折"], confidence: "medium" });
  updateTagStatus(result.record.id, "忽略转折", "confirmed");
  const again = diag({ userErrorTags: ["忽略转折", "范围扩大"], confidence: "high" });
  assert.equal(again.record.tags.find((tag) => tag.name === "忽略转折").status, "confirmed");
  assert.equal(again.record.tags.find((tag) => tag.name === "忽略转折").source, "user-confirmed");

  const dismissed = diag({
    questionId: "q-4-33-0",
    questionNumber: "33",
    userErrorTags: ["过度推断"],
    confidence: "high",
  });
  updateTagStatus(dismissed.record.id, "过度推断", "dismissed");
  const rediagnosed = upsertQuestionDiagnosisRecord({
    resourceId: "postgraduate-2019-text-3",
    chapter: "英一.19.text3",
    questionId: "q-4-33-0",
    questionNumber: "33",
    passageId: "passage-text-4",
    questionType: "推理题",
    diagnosisBasis: "user-reasoning",
    confidence: "high",
    firstAnswer: "B",
    redoAnswer: "D",
    userErrorTags: ["过度推断"],
    optionTrapTypes: [],
  });
  assert.equal(rediagnosed.record.tags.find((tag) => tag.name === "过度推断").status, "active");
  assert.equal(rediagnosed.record.tags.find((tag) => tag.name === "过度推断").source, "ai-inferred");
});

test("扩展 统计辅助：题型统计与本周复盘建议", () => {
  freshRecords();
  diag({ questionType: "推理题", userErrorTags: ["忽略转折"], confidence: "high" });
  diag({
    questionId: "q-3-33-1",
    questionNumber: "33",
    questionType: "细节题",
    userErrorTags: ["同义替换未识别"],
    confidence: "high",
  });
  tr({ errorTags: ["修饰范围错误"] });
  const types = getQuestionTypeCounts(listLearningRecords(), "all");
  assert.deepEqual(types, [
    { name: "推理题", count: 1 },
    { name: "细节题", count: 1 },
  ]);
  const suggestions = getReviewSuggestions(listLearningRecords());
  assert.equal(suggestions.length, 3);
});

test("扩展 identityKey 生成与查找", () => {
  freshRecords();
  const identity = buildLearningIdentityKey({
    resourceId: "r",
    chapter: "c",
    taskType: "translation-review",
    itemId: "s1",
  });
  assert.equal(identity, "r||c||translation-review||s1");
  const result = tr({});
  assert.equal(getLearningRecordByIdentity(result.record.identityKey)?.id, result.record.id);
});
