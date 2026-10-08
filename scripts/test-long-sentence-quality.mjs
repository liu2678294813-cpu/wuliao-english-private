import test from "node:test";
import assert from "node:assert/strict";
import { QUALITY_CORPUS, qualityItem, TRAINING_EVALUATION, TRAINING_FINGERPRINT, TRAINING_SENTENCE_B, TRAINING_SOURCE } from "./fixtures/long-sentence-quality.mjs";
import { validateGeneratedItem, normalizeSources } from "../src/longSentence/validator.js";
import { createLongSentenceAiService } from "../src/longSentence/ai.js";
import { sentenceTextFingerprint } from "../src/translationProgress.js";

for (const sample of QUALITY_CORPUS) {
  test(`fixed transfer corpus: ${sample.id}`, () => {
    const candidate = qualityItem({ text: sample.generated, difficulties: [sample.sourceDifficulty] });
    candidate.difficultyMetadata.addedComplexityFeatures = [sample.feature];
    const context = { sources: [{ sourceReviewId: "source-1", text: sample.source, difficulty: sample.sourceDifficulty }], words: [] };
    assert.equal(validateGeneratedItem(candidate, context).text, sample.generated, sample.explanation);
    assert.throws(() => validateGeneratedItem({ ...candidate, text: sample.source }, context), error => error.code === "copied_sentence");
    assert.throws(() => validateGeneratedItem({ ...candidate, difficultyMetadata: { ...candidate.difficultyMetadata, targetDifficulty: sample.sourceDifficulty, difficultyDelta: 0 } }, context), error => error.code === "invalid_difficulty");
  });
}
test("difficulty metadata cannot lower the known source or present vocabulary and length as added syntax", () => {
  const context = { sources: [{ sourceReviewId: "source-1", text: TRAINING_SOURCE, difficulty: 5 }], words: [] };
  assert.throws(() => validateGeneratedItem(qualityItem(), context), error => error.code === "invalid_difficulty");
  const value = qualityItem({ difficulties: [5] });
  for (const features of [["longer sentence", "rare vocabulary"], ["词汇更生僻", "句子更长"]]) {
    value.difficultyMetadata.addedComplexityFeatures = features;
    assert.throws(() => validateGeneratedItem(value, context), error => error.code === "nonstructural_difficulty");
  }
});
test("one structural level rejects a jump of two even when target and delta are arithmetically consistent", () => {
  const candidate = qualityItem(); candidate.difficultyMetadata.targetDifficulty = 4; candidate.difficultyMetadata.difficultyDelta = 2;
  assert.throws(() => validateGeneratedItem(candidate, { sources: [{ sourceReviewId: "source-1", text: TRAINING_SOURCE, difficulty: 2 }], words: [] }), error => error.code === "invalid_difficulty");
});
test("a subset of source lineage cannot lower the baseline below the hardest selected source", () => {
  const sources = [{ sourceReviewId: "source-1", text: TRAINING_SOURCE, difficulty: 2 }, { sourceReviewId: "source-hard", text: QUALITY_CORPUS[2].generated, difficulty: 5 }];
  const candidate = qualityItem();
  assert.throws(() => validateGeneratedItem(candidate, { sources, words: [] }), error => error.code === "invalid_difficulty");
  candidate.difficultyMetadata.sourceDifficulties.push({ sourceReviewId: "source-hard", difficulty: 5 });
  assert.throws(() => validateGeneratedItem(candidate, { sources, words: [] }), error => error.code === "invalid_difficulty");
  Object.assign(candidate.difficultyMetadata, { sourceDifficulty: 5, targetDifficulty: 6 });
  assert.deepEqual(validateGeneratedItem(candidate, { sources, words: [] }).sourceReviewIds, ["source-1"]);
});
test("source projection strips answers, identity, and paragraphs while preserving the stable source id", () => {
  assert.deepEqual(normalizeSources([{ sourceReviewId: '["r","p","s"]', text: TRAINING_SOURCE, articleText: "FULL ARTICLE", firstAnswer: "B", username: "alice", apiKey: "not-a-real-key" }]), [{ sourceReviewId: '["r","p","s"]', text: TRAINING_SOURCE }]);
});
test("ordinary doubled-consonant inflection remains a genuine selected word use", () => {
  const value = qualityItem({ text: "Although the panel admitted that conclusions drawn from incomplete records could be misleading, the account which its members submitted was accepted by historians who had previously disputed its chronology.", uses: [{ wordId: "admit", word: "admit", surfaceForm: "admitted" }] });
  assert.equal(validateGeneratedItem(value, { sources: [{ sourceReviewId: "source-1", text: TRAINING_SOURCE, difficulty: 2 }], words: [{ wordId: "admit", word: "admit" }] }).targetWordUses[0].surfaceForm, "admitted");
});
test("deleted training text remains excluded by its local fingerprint without sending hashes to AI", async () => {
  const fingerprint = sentenceTextFingerprint(TRAINING_SENTENCE_B), calls = [];
  const service = createLongSentenceAiService({ getUsername: () => "alice", getProfile: () => ({ modelId: "mock", providerId: "custom" }), callAi: async detail => { calls.push(detail); return { content: JSON.stringify({ items: [qualityItem({ text: calls.length === 1 ? TRAINING_SENTENCE_B : QUALITY_CORPUS[1].generated })] }) }; } });
  const result = await service.generate({ sessionId: "s", count: 1, sources: [{ sourceReviewId: "source-1", text: TRAINING_SOURCE }], excludedFingerprints: [fingerprint] });
  assert.equal(calls.length, 2); assert.equal(result.items[0].text, QUALITY_CORPUS[1].generated);
  assert.equal(result.errors[0].code, "previous_training_sentence");
  assert.equal(JSON.stringify(calls.map(call => call.messages)).includes(fingerprint), false);
});
test("submitting a changed translation supersedes an old response even in the same item context", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const service = createLongSentenceAiService({ getUsername: () => "alice", getProfile: () => ({ modelId: "mock", providerId: "custom" }), callAi: async detail => { requests.push(detail); if (requests.length === 1) await gate; return { content: JSON.stringify(TRAINING_EVALUATION) }; } });
  const detail = { sessionId: "s", itemId: "i", attemptId: "a", submittedAt: 1, generatedSentence: TRAINING_SENTENCE_B, structureFingerprint: TRAINING_FINGERPRINT, userTranslation: "旧译文", targetWordUses: [], difficultyMetadata: qualityItem().difficultyMetadata };
  const previous = service.evaluate(detail); await Promise.resolve();
  const latest = await service.evaluate({ ...detail, userTranslation: "新译文" });
  assert.equal(requests[0].signal.aborted, true); assert.deepEqual(latest.evaluation, TRAINING_EVALUATION);
  release(); await assert.rejects(previous, error => error.name === "AbortError");
});
