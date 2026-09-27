import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  TRANSLATION_PROGRESS_SCHEMA_VERSION,
  translationProgressKey,
  sentenceKeyFor,
  translationTextFingerprint,
  emptyProgress,
  normalizeProgress,
  loadTranslationProgress,
  saveTranslationProgress,
  sentenceEntryFor,
  markTranslated,
  markCorrected,
  setReviewStatus,
  handleTranslationEdited,
  markParagraphCompleted,
  paragraphState,
  countsForPassage,
  canCompleteTranslationWorkbook,
  nextTranslationTodo,
  listNeedsReviewSentenceKeys,
  shouldEnforceTranslationGating,
} = await import("../src/translationProgress.js");
const { writeReviewCache, readReviewCacheEntry } = await import("../src/aiReviewCache.js");
const {
  buildLearningIdentityKey,
  upsertTranslationReviewRecord,
  getLearningRecordByIdentity,
  listLearningRecords,
} = await import("../src/aiLearningRecords.js");
const { TASK_TRANSLATION_REVIEW } = await import("../src/aiTasks.js");
const { runTranslationReview } = await import("../src/aiReviewService.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

const RESOURCE = { id: "res-1" };
const PASSAGE = {
  id: "passage-1",
  paragraphs: [
    {
      number: 1,
      sentences: ["The first sentence is here.", "The second sentence follows."],
    },
    {
      number: 2,
      sentences: ["Another paragraph starts."],
    },
  ],
};

const S1 = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 0, sentenceText: PASSAGE.paragraphs[0].sentences[0] });
const S2 = sentenceKeyFor({ paragraphNumber: 1, sentenceIndex: 1, sentenceText: PASSAGE.paragraphs[0].sentences[1] });
const S3 = sentenceKeyFor({ paragraphNumber: 2, sentenceIndex: 0, sentenceText: PASSAGE.paragraphs[1].sentences[0] });

function baseProgress() {
  const progress = emptyProgress(RESOURCE.id, PASSAGE.id);
  progress.sentences = {};
  progress.paragraphs = {};
  return progress;
}

function correctedAll(progress = baseProgress()) {
  let next = markTranslated(progress, S1);
  next = markCorrected(next, S1, { translationText: "第一句。" });
  next = markTranslated(next, S2);
  next = markCorrected(next, S2, { translationText: "第二句。" });
  next = markTranslated(next, S3);
  next = markCorrected(next, S3, { translationText: "另一段。" });
  next = markParagraphCompleted(next, 1);
  next = markParagraphCompleted(next, 2);
  return next;
}

test("1 新句初始为 pending，且不写存储", () => {
  fresh();
  const progress = baseProgress();
  const result = sentenceEntryFor(progress, {
    paragraphNumber: 1,
    sentenceIndex: 0,
    sentenceText: PASSAGE.paragraphs[0].sentences[0],
  });
  assert.equal(result.stored, false);
  assert.equal(result.entry.translationStatus, "pending");
  assert.equal(result.entry.reviewStatus, null);
  assert.equal(getUserItem(translationProgressKey(RESOURCE.id, PASSAGE.id)), null);
});

test("2 pending→translated→corrected→mastered", () => {
  fresh();
  let progress = baseProgress();
  progress = markTranslated(progress, S1, 1000);
  assert.equal(progress.sentences[S1].translationStatus, "translated");
  assert.equal(progress.sentences[S1].translatedAt, 1000);
  progress = markCorrected(progress, S1, { translationText: "我的译文", now: 2000 });
  assert.equal(progress.sentences[S1].translationStatus, "corrected");
  assert.equal(progress.sentences[S1].correctedAt, 2000);
  progress = setReviewStatus(progress, S1, "mastered", 3000);
  assert.equal(progress.sentences[S1].reviewStatus, "mastered");
  assert.equal(progress.sentences[S1].reviewedAt, 3000);
});

test("3 pending→translated→corrected→needs_review", () => {
  fresh();
  let progress = markCorrected(markTranslated(baseProgress(), S2), S2, { translationText: "译文" });
  progress = setReviewStatus(progress, S2, "needs_review");
  assert.equal(progress.sentences[S2].reviewStatus, "needs_review");
});

test("4 mastered 与 needs_review 互斥", () => {
  fresh();
  let progress = markCorrected(markTranslated(baseProgress(), S1), S1, { translationText: "译文" });
  progress = setReviewStatus(progress, S1, "mastered");
  progress = setReviewStatus(progress, S1, "needs_review");
  assert.equal(progress.sentences[S1].reviewStatus, "needs_review");
  progress = setReviewStatus(progress, S1, "mastered");
  assert.equal(progress.sentences[S1].reviewStatus, "mastered");
  assert.equal(listNeedsReviewSentenceKeys(progress).length, 0);
});

test("5 旧键盘译文：legacy 初始化至少为 translated，不自动 corrected", () => {
  fresh();
  const progress = baseProgress();
  const result = sentenceEntryFor(progress, {
    paragraphNumber: 1,
    sentenceIndex: 0,
    sentenceText: PASSAGE.paragraphs[0].sentences[0],
    translationText: "旧译文",
  });
  assert.equal(result.entry.translationStatus, "translated");
  assert.notEqual(result.entry.translationStatus, "corrected");
  assert.equal(result.entry.reviewStatus, null);
});

test("5b legacy 已译句子：先物化 translated 条目，再完成订正", () => {
  fresh();
  const progress = baseProgress();
  const derived = sentenceEntryFor(progress, {
    paragraphNumber: 1,
    sentenceIndex: 0,
    sentenceText: PASSAGE.paragraphs[0].sentences[0],
    translationText: "旧译文",
  });
  assert.equal(derived.entry.translationStatus, "translated");
  let next = markTranslated(progress, derived.key);
  next = markCorrected(next, derived.key, { translationText: "旧译文" });
  assert.equal(next.sentences[derived.key].translationStatus, "corrected");
  assert.equal(next.sentences[derived.key].translationFingerprint, translationTextFingerprint("旧译文"));
});

test("6 已有 AI review cache 不能自动变 corrected", () => {
  fresh();
  writeReviewCache("tr-legacy-cache", { summary: { level: "accurate" } });
  const progress = baseProgress();
  const result = sentenceEntryFor(progress, {
    paragraphNumber: 1,
    sentenceIndex: 0,
    sentenceText: PASSAGE.paragraphs[0].sentences[0],
    translationText: "旧译文",
  });
  assert.equal(result.entry.translationStatus, "translated");
  assert.equal(result.entry.reviewStatus, null);
  assert.ok(readReviewCacheEntry("tr-legacy-cache"));
});

test("7 手写模式：没有文字也可人工 translated / corrected", () => {
  fresh();
  let progress = markTranslated(baseProgress(), S1);
  assert.equal(progress.sentences[S1].translationStatus, "translated");
  progress = markCorrected(progress, S1, { translationText: "" });
  assert.equal(progress.sentences[S1].translationStatus, "corrected");
  assert.equal(progress.sentences[S1].translationFingerprint, translationTextFingerprint(""));
});

test("8 无 OCR 路径：进度模块不引用任何 OCR/笔迹识别实现", () => {
  const source = readFileSync(new URL("../src/translationProgress.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /tesseract|ocr|recognize|perfect-freehand/i);
});

test("9 corrected 后键盘译文变化：回退 translated 并清 reviewStatus", () => {
  fresh();
  let progress = markCorrected(markTranslated(baseProgress(), S1), S1, { translationText: "原译文" });
  progress = setReviewStatus(progress, S1, "mastered");
  const changed = handleTranslationEdited(progress, S1, "修改后的译文");
  assert.ok(changed);
  assert.equal(changed.sentences[S1].translationStatus, "translated");
  assert.equal(changed.sentences[S1].reviewStatus, null);
  assert.equal(changed.sentences[S1].correctedAt, null);
  assert.equal(handleTranslationEdited(changed, S1, "继续修改"), null);
});

test("10 回退与状态推进不删除 AI cache / learning records", () => {
  fresh();
  writeReviewCache("tr-keep", { summary: { level: "accurate" }, errorTags: ["漏译"] });
  upsertTranslationReviewRecord({
    resourceId: RESOURCE.id,
    chapter: "英一.24.text1",
    sentenceId: `${RESOURCE.id}::${PASSAGE.id}::p1s1`,
    itemLabel: "第1段第1句",
    inputMethod: "typed",
    errorTags: ["漏译"],
    summaryLevel: "needs-revision",
    sentenceSnippet: PASSAGE.paragraphs[0].sentences[0],
    historyId: "history-1",
    passageId: PASSAGE.id,
  });
  const identity = buildLearningIdentityKey({
    resourceId: RESOURCE.id,
    chapter: "英一.24.text1",
    taskType: TASK_TRANSLATION_REVIEW,
    itemId: `${RESOURCE.id}::${PASSAGE.id}::p1s1`,
  });
  assert.ok(getLearningRecordByIdentity(identity));

  let progress = markTranslated(baseProgress(), S1);
  progress = markCorrected(progress, S1, { translationText: "原译文" });
  progress = setReviewStatus(progress, S1, "needs_review");
  progress = handleTranslationEdited(progress, S1, "新译文");
  assert.ok(readReviewCacheEntry("tr-keep"));
  assert.ok(getLearningRecordByIdentity(identity));
  assert.equal(listLearningRecords().length, 1);
});

test("11 resource / passage 之间状态隔离", () => {
  fresh();
  let progress = markCorrected(markTranslated(baseProgress(), S1), S1, { translationText: "译文" });
  saveTranslationProgress(progress);
  const loaded = loadTranslationProgress(RESOURCE.id, PASSAGE.id);
  assert.equal(loaded.sentences[S1].translationStatus, "corrected");
  const other = loadTranslationProgress("res-2", PASSAGE.id);
  assert.equal(Object.keys(other.sentences).length, 0);
  const otherPassage = loadTranslationProgress(RESOURCE.id, "passage-2");
  assert.equal(Object.keys(otherPassage.sentences).length, 0);
});

test("12 相同 paragraphIndex/sentenceIndex 但英文变化：旧状态不套用", () => {
  fresh();
  const progress = markCorrected(markTranslated(baseProgress(), S1), S1, { translationText: "旧译文" });
  const result = sentenceEntryFor(progress, {
    paragraphNumber: 1,
    sentenceIndex: 0,
    sentenceText: "The sentence was re-split differently.",
  });
  assert.equal(result.stored, false);
  assert.equal(result.entry.translationStatus, "pending");
  assert.notEqual(result.key, S1);
});

test("13 needs_review 仍允许 deep-translation 完成", () => {
  fresh();
  const progress = correctedAll();
  const withReview = setReviewStatus(progress, S1, "needs_review");
  assert.equal(canCompleteTranslationWorkbook(withReview, PASSAGE), true);
});

test("14 有 pending / translated 未订正句时不能完成", () => {
  fresh();
  const progress = correctedAll();
  const pending = { ...progress, sentences: { ...progress.sentences, [S3]: { ...progress.sentences[S3], translationStatus: "pending", reviewStatus: null } } };
  assert.equal(canCompleteTranslationWorkbook(pending, PASSAGE), false);
  const translated = { ...progress, sentences: { ...progress.sentences, [S3]: { ...progress.sentences[S3], translationStatus: "translated", reviewStatus: null } } };
  assert.equal(canCompleteTranslationWorkbook(translated, PASSAGE), false);
});

test("15 新旧文章均不因翻译进度阻止进入重做", () => {
  fresh();
  assert.equal(shouldEnforceTranslationGating({ stages: { "deep-translation": { status: "completed" } } }), false);
  assert.equal(shouldEnforceTranslationGating({ stages: { "deep-translation": { status: "current" } } }), false);
  assert.equal(shouldEnforceTranslationGating(null), false);
});

test("16 继续下一句优先级：pending → translated → 未完成段", () => {
  fresh();
  assert.deepEqual(nextTranslationTodo(baseProgress(), PASSAGE), { type: "sentence", key: S1, paragraphNumber: 1, sentenceIndex: 0 });

  let progress = markTranslated(baseProgress(), S1);
  assert.deepEqual(nextTranslationTodo(progress, PASSAGE), { type: "sentence", key: S2, paragraphNumber: 1, sentenceIndex: 1 });

  progress = markCorrected(progress, S1, { translationText: "译文" });
  assert.deepEqual(nextTranslationTodo(progress, PASSAGE), { type: "sentence", key: S2, paragraphNumber: 1, sentenceIndex: 1 });

  progress = markTranslated(progress, S2);
  progress = markCorrected(progress, S2, { translationText: "译文2" });
  assert.deepEqual(nextTranslationTodo(progress, PASSAGE), { type: "sentence", key: S3, paragraphNumber: 2, sentenceIndex: 0 });

  progress = markTranslated(progress, S3);
  progress = markCorrected(progress, S3, { translationText: "译文3" });
  assert.deepEqual(nextTranslationTodo(progress, PASSAGE), { type: "paragraph", key: "p1", paragraphNumber: 1, sentenceIndex: 0 });

  progress = markParagraphCompleted(progress, 1);
  assert.deepEqual(nextTranslationTodo(progress, PASSAGE), { type: "paragraph", key: "p2", paragraphNumber: 2, sentenceIndex: 0 });

  progress = markParagraphCompleted(progress, 2);
  assert.equal(nextTranslationTodo(progress, PASSAGE), null);

  // 旧键盘译文参与推导：有文本但未存储的句子视为 translated（第二优先级）
  const legacy = baseProgress();
  assert.deepEqual(nextTranslationTodo(legacy, PASSAGE, { [S1]: "旧译文" }), {
    type: "sentence",
    key: S2,
    paragraphNumber: 1,
    sentenceIndex: 1,
  });
  assert.deepEqual(nextTranslationTodo(legacy, PASSAGE, { [S1]: "旧译文", [S2]: "旧译文2", [S3]: "旧译文3" }), {
    type: "sentence",
    key: S1,
    paragraphNumber: 1,
    sentenceIndex: 0,
  });
});

test("17 无句子 / parser 异常时不能卡死", () => {
  fresh();
  const emptyPassage = { id: "empty", paragraphs: [] };
  assert.equal(canCompleteTranslationWorkbook(baseProgress(), emptyPassage), true);
  assert.equal(nextTranslationTodo(baseProgress(), emptyPassage), null);
  assert.deepEqual(countsForPassage(baseProgress(), emptyPassage), {
    total: 0,
    translatedCount: 0,
    correctedCount: 0,
    pendingCount: 0,
    masteredCount: 0,
    needsReviewCount: 0,
    completedParagraphCount: 0,
    paragraphTotal: 0,
  });
  const brokenPassage = { id: "broken", paragraphs: [{ number: 1 }] };
  assert.equal(paragraphState(baseProgress(), brokenPassage).completed, true);
  assert.equal(canCompleteTranslationWorkbook(baseProgress(), brokenPassage), true);
});

test("扩展 段落完成：全部订正后可完成；句子回退后自动失效", () => {
  fresh();
  let progress = markTranslated(baseProgress(), S1);
  progress = markCorrected(progress, S1, { translationText: "译文" });
  progress = markTranslated(progress, S2);
  progress = markCorrected(progress, S2, { translationText: "译文2" });
  progress = markParagraphCompleted(progress, 1);
  assert.equal(paragraphState(progress, PASSAGE.paragraphs[0]).completed, true);
  assert.equal(countsForPassage(progress, PASSAGE).completedParagraphCount, 1);
  progress = handleTranslationEdited(progress, S1, "改了");
  assert.equal(paragraphState(progress, PASSAGE.paragraphs[0]).completed, false);
});

test("扩展 存储规范化：坏数据安全降级，review 不变量保持", () => {
  fresh();
  const normalized = normalizeProgress({
    sentences: {
      [S1]: { translationStatus: "corrected", reviewStatus: "mastered", correctedAt: 5 },
      bad: { translationStatus: "corrected", reviewStatus: "needs_review", correctedAt: 6 },
      "p1s1:xyz": { translationStatus: "translated", reviewStatus: "mastered" },
      junk: "not-an-object",
    },
    paragraphs: { 1: { completed: true, completedAt: 7 } },
  }, RESOURCE.id, PASSAGE.id);
  assert.equal(normalized.schemaVersion, TRANSLATION_PROGRESS_SCHEMA_VERSION);
  assert.equal(normalized.sentences[S1].reviewStatus, "mastered");
  assert.equal(normalized.sentences["p1s1:xyz"].reviewStatus, null);
  assert.equal(normalized.sentences.junk, undefined);
  assert.equal(normalized.paragraphs["1"].completed, true);
});

for (const identityField of ["sentenceId", "itemId"]) {
  test(`结构化笔译按 ${identityField} 隔离：首请求取消后仅保存第二句学习记录`, async () => {
    fresh();
    setCurrentUsername(`review-identity-${identityField}-user`);
    const detail = { resourceId: "review-identity-resource", passageId: "review-identity-passage", chapter: "Review identity", sentence: "The same sentence appears twice.", userTranslation: "同一句话出现了两次。" };
    const firstDetail = { ...detail, [identityField]: "review-first", historyId: "history-first" };
    const secondDetail = { ...detail, [identityField]: "review-second", historyId: "history-second" };
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const controller = new AbortController();
    // Deliberately return even after abort, exercising the service's late-result guard.
    globalThis.fetch = async () => {
      calls += 1; started(); await gate;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: { level: "accurate", comment: "准确" }, errorTags: [] }) } }] }) };
    };
    try {
      const first = runTranslationReview({ detail: firstDetail, apiKey: "mock-key", signal: controller.signal });
      await ready;
      const second = runTranslationReview({ detail: secondDetail, apiKey: "mock-key" });
      await new Promise(resolve => setImmediate(resolve));
      controller.abort();
      assert.equal((await first).status, "aborted");
      release();
      assert.equal((await second).status, "ok");
      assert.equal(calls, 2);
      assert.deepEqual(listLearningRecords().map(record => ({ itemId: record.itemId, historyId: record.historyId, passageId: record.metadata.passageId })), [
        { itemId: "review-second", historyId: "history-second", passageId: detail.passageId },
      ]);
      // A completed parsed result remains reusable, but backfills its own identity.
      const third = await runTranslationReview({ detail: { ...detail, [identityField]: "review-third", historyId: "history-third" }, apiKey: "mock-key" });
      assert.equal(third.cached, true);
      assert.equal(calls, 2);
      assert.deepEqual(listLearningRecords().map(record => record.itemId).sort(), ["review-second", "review-third"]);
    } finally {
      release();
      globalThis.fetch = originalFetch;
    }
  });
}
