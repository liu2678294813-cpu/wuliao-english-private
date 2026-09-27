import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClozeSentenceModel,
  buildClozeSentenceRef,
  priorityTranslationTargets,
  resolveClozeSentenceRef,
} from "../src/clozeSentences.js";

function sampleCloze() {
  return {
    paragraphs: [
      {
        number: 1,
        segments: [
          { type: "text", text: "Dr. Lee said, \"This is" },
          { type: "blank", number: 1 },
          { type: "text", text: "but it may" },
          { type: "blank", number: 2 },
          { type: "text", text: "soon.\" Next sentence!" },
        ],
      },
      {
        number: 2,
        segments: [
          { type: "text", text: "OCR   spacing stays stable near" },
          { type: "blank", number: 3 },
          { type: "text", text: "." },
        ],
      },
    ],
  };
}

test("完形句子模型支持多段、多 Blank、引号、缩写、标点和 OCR 空格", () => {
  const model = buildClozeSentenceModel(sampleCloze(), "resource-1", "cloze-1");
  assert.equal(model.paragraphs.length, 2);
  assert.equal(model.blankToSentence[1].sentenceKey, model.blankToSentence[2].sentenceKey);
  assert.deepEqual(model.blankToSentence[1].blankNumbers, [1, 2]);
  assert.match(model.blankToSentence[1].stableText, /__CLOZE_BLANK_1__/);
  assert.match(model.blankToSentence[3].excerpt, /\[3\]\./);
  assert.doesNotMatch(model.blankToSentence[3].stableText, /\s{2,}/);
});

test("答案变化和官方答案变化不参与 sentenceKey", () => {
  const first = buildClozeSentenceModel(sampleCloze(), "resource-1", "cloze-1");
  const second = buildClozeSentenceModel(sampleCloze(), "resource-1", "cloze-1");
  assert.equal(first.blankToSentence[1].sentenceKey, second.blankToSentence[1].sentenceKey);
  assert.equal(first.blankToSentence[1].fingerprint, second.blankToSentence[1].fingerprint);
});

test("同句多个 priority blank 只生成一个 translation target", () => {
  const model = buildClozeSentenceModel(sampleCloze(), "resource-1", "cloze-1");
  const targets = priorityTranslationTargets(model, [1, 2, 3]);
  assert.equal(targets.length, 2);
  const excluded = priorityTranslationTargets(model, [1, 2, 3], {
    [model.blankToSentence[1].sentenceKey]: "exclude",
  });
  assert.equal(excluded.length, 1);
  const included = priorityTranslationTargets(model, [], {
    [model.blankToSentence[3].sentenceKey]: "include",
  });
  assert.equal(included.length, 1);
});

test("cloze reference 可精确恢复且不保存 DOM", () => {
  const model = buildClozeSentenceModel(sampleCloze(), "resource-1", "cloze-1");
  const sentence = model.blankToSentence[3];
  const reference = buildClozeSentenceRef(sentence);
  assert.deepEqual(Object.keys(reference), ["paragraphNumber", "sentenceIndex", "sentenceKey", "fingerprint", "excerpt"]);
  assert.equal(resolveClozeSentenceRef(reference, model).sentenceKey, sentence.sentenceKey);
});

