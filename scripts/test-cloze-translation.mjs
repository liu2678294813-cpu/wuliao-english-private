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
  areClozeTranslationTargetsCorrected,
  clozeTranslationStorageKey,
  emptyClozeTranslationProgress,
  loadClozeTranslationProgress,
  markClozeTranslationCorrected,
  markClozeTranslationTranslated,
  saveClozeTranslationProgress,
  setClozeTranslationText,
  setTranslationTargetOverride,
  translationEntryFor,
} = await import("../src/clozeTranslationProgress.js");

function fresh() {
  globalThis.localStorage.clear();
  setCurrentUsername("alice");
}

const target = { sentenceKey: "cloze:x:p1s1:y" };

test("完形笔译 key 与阅读 translation namespace 隔离", () => {
  const key = clozeTranslationStorageKey("r1", "c1");
  assert.equal(key, "wuliao:cloze-translation:r1:c1");
  assert.ok(!key.includes("translation-progress"));
  assert.ok(!key.includes("deep-translation"));
});

test("pending → translated → corrected，订正后编辑回退 translated", () => {
  let progress = emptyClozeTranslationProgress("r1", "c1", 1);
  progress = setClozeTranslationText(progress, target.sentenceKey, "我的译文", 2);
  assert.equal(translationEntryFor(progress, target.sentenceKey).status, "pending");
  progress = markClozeTranslationTranslated(progress, target.sentenceKey, 3);
  assert.equal(translationEntryFor(progress, target.sentenceKey).status, "translated");
  progress = markClozeTranslationCorrected(progress, target.sentenceKey, 4);
  assert.equal(translationEntryFor(progress, target.sentenceKey).status, "corrected");
  progress = setClozeTranslationText(progress, target.sentenceKey, "修改后的译文", 5);
  assert.equal(translationEntryFor(progress, target.sentenceKey).status, "translated");
  assert.equal(translationEntryFor(progress, target.sentenceKey).correctedAt, null);
});

test("空译文不能完成笔译，target override 可加入、排除和清除", () => {
  let progress = emptyClozeTranslationProgress("r1", "c1", 1);
  assert.equal(markClozeTranslationTranslated(progress, target.sentenceKey), progress);
  progress = setTranslationTargetOverride(progress, target.sentenceKey, "include", 2);
  assert.equal(progress.targetOverrides[target.sentenceKey], "include");
  progress = setTranslationTargetOverride(progress, target.sentenceKey, "exclude", 3);
  assert.equal(progress.targetOverrides[target.sentenceKey], "exclude");
  progress = setTranslationTargetOverride(progress, target.sentenceKey, null, 4);
  assert.equal(progress.targetOverrides[target.sentenceKey], undefined);
});

test("全部重点句 corrected 才满足 analysis 翻译门槛，并可保存恢复", () => {
  fresh();
  const second = { sentenceKey: "cloze:x:p2s1:z" };
  let progress = emptyClozeTranslationProgress("r1", "c1", 1);
  for (const sentence of [target, second]) {
    progress = setClozeTranslationText(progress, sentence.sentenceKey, `译文-${sentence.sentenceKey}`, 2);
    progress = markClozeTranslationTranslated(progress, sentence.sentenceKey, 3);
  }
  progress = markClozeTranslationCorrected(progress, target.sentenceKey, 4);
  assert.equal(areClozeTranslationTargetsCorrected(progress, [target, second]), false);
  progress = markClozeTranslationCorrected(progress, second.sentenceKey, 5);
  assert.equal(areClozeTranslationTargetsCorrected(progress, [target, second]), true);
  saveClozeTranslationProgress(progress);
  const reloaded = loadClozeTranslationProgress("r1", "c1");
  assert.equal(translationEntryFor(reloaded, second.sentenceKey).status, "corrected");
  assert.equal(translationEntryFor(reloaded, target.sentenceKey).text.startsWith("译文-"), true);
});

