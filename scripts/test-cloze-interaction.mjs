import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  emptyClozeProgress,
  getClozeProgress,
  recordFirstAnswer,
  recordReviewAnswer,
  saveClozeProgress,
  setActiveBlank,
} from "../src/clozeProgress.js";
import { canEditFirstAnswers, canEditReviewAnswers } from "../src/clozeView.js";
import { setCurrentUsername } from "../src/userData.js";

globalThis.localStorage = new class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(String(key)) ?? null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}();

const resourceId = "cloze-interaction-test";
const blankNumbers = [1, 2, 3];

test("完形改选覆盖当前阶段字段、持久化且不混写两次答案", () => {
  localStorage.clear();
  setCurrentUsername("cloze-ui-test-user");
  let progress = emptyClozeProgress(resourceId, resourceId, blankNumbers, 100);
  progress = recordReviewAnswer(progress, 1, "D");
  progress = recordFirstAnswer(progress, 1, "B");
  progress = setActiveBlank(progress, 2);
  saveClozeProgress(progress);

  progress = getClozeProgress(resourceId, resourceId, blankNumbers);
  assert.equal(progress.attempts[1].firstAnswer, "B");
  assert.equal(progress.attempts[1].reviewAnswer, "D");
  assert.equal(progress.activeBlank, 2);

  progress = setActiveBlank(progress, 1);
  progress = recordFirstAnswer(progress, 1, "A");
  saveClozeProgress(progress);
  progress = getClozeProgress(resourceId, resourceId, blankNumbers);
  assert.equal(progress.attempts[1].firstAnswer, "A", "提交前 B→A 必须覆盖 firstAnswer");
  assert.equal(progress.attempts[1].reviewAnswer, "D", "改选不得覆盖 reviewAnswer");
  assert.equal(progress.activeBlank, 1, "返回已答空改选后留在当前空");

  progress = recordReviewAnswer(progress, 1, "C");
  saveClozeProgress(progress);
  const reloaded = getClozeProgress(resourceId, resourceId, blankNumbers);
  assert.equal(reloaded.attempts[1].firstAnswer, "A");
  assert.equal(reloaded.attempts[1].reviewAnswer, "C");
});

test("ClozeReader 选项 wiring 与阶段只读门控保持真实 DOM 契约", () => {
  const source = readFileSync(new URL("../src/ClozeReader.jsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{\(\) => onChoose\(activeBlank, option\.key\)\}/);
  assert.match(source, /selected === option\.key \? "is-chosen"/);
  assert.match(source, /const wasUnanswered = isBlankUnanswered\(progress\.attempts\[number\]\)/);
  assert.match(source, /if \(wasUnanswered\)[\s\S]*?nextUnansweredBlank/);
  assert.equal(canEditFirstAnswers("cloze-first-attempt"), true);
  assert.equal(canEditReviewAnswers("cloze-self-review"), true);
  assert.equal(canEditFirstAnswers("cloze-correction"), false);
  assert.equal(canEditReviewAnswers("cloze-analysis"), false);
});
