import test from "node:test";
import assert from "node:assert/strict";
import { longSentenceSelectionLimits, assertLongSentenceSelection } from "../src/longSentence/sourceBatch.js";
import { normalizeWords, isAllowedWordForm } from "../src/longSentence/validator.js";
import { validateSourceAnalysis, validateCoverageCandidates, validateCoverageVerification, itemTrainingScope } from "../src/longSentence/coverage.js";
import { aggregateSelectedWords } from "../src/longSentence/source.js";
import { createLongSentenceAiService } from "../src/longSentence/ai.js";
import { qualityItem, TRAINING_SOURCE, TRAINING_SENTENCE_B } from "./fixtures/long-sentence-quality.mjs";

const sources = [{ sourceReviewId: "source-1", text: TRAINING_SOURCE, status: "resolved", resourceId: "r", passageId: "p" }];
const words = [{ wordId: "reinforce", word: "reinforce", meaning: "印证；加强", contextSentence: "The results reinforce our conclusion." }, { wordId: "constrain", word: "constrain", meaning: "限制" }];
const analysisRaw = () => ({ sources: [{ sourceReviewId: "source-1", difficulty: 2, requirements: [{ description: "让步从句和主句结论相对照", evidence: ["Although the evidence was incomplete", "the committee approved the plan"], relation: "让步条件不足但主句结论仍成立", commonPitfall: "把让步误解为原因" }] }] });
const analysis = () => validateSourceAnalysis(analysisRaw(), sources);
const candidate = () => qualityItem({ uses: words.map(({ wordId, word }) => ({ wordId, word, surfaceForm: word })) });
const verification = () => ({ items: [{ index: 0, natural: true, aboveSource: true, addedComplexityEvidence: ["whose instruments reinforce observations recorded decades earlier"],
  wordChecks: words.map(({ wordId, word }) => ({ wordId, surfaceForm: word, meaningMatches: true, reason: "符合原文词义" })),
  requirementChecks: [{ requirementId: analysis().sources[0].requirements[0].id, evidence: ["Although", "their findings suggest"], reason: "让步与主句结论关系完整保留" }], reason: "语义自然，且增加嵌套结构" }] });
const context = () => ({ sources: sources.map(source => ({ ...source, difficulty: 2 })), words, count: 1 });
const verifyContext = () => ({ items: [candidate()], words, requirements: analysis().sources.flatMap(source => source.requirements) });
function fixture(responses, options = {}) {
  const calls = [];
  const service = createLongSentenceAiService({ getUsername: () => "coverage-test", getProfile: () => ({ providerId: "mock", modelId: "mock" }),
    callAi: async request => { calls.push(request); const response = responses.shift(); if (response instanceof Error) throw response;
      if (typeof response === "function") return response(request); return { content: typeof response === "string" ? response : JSON.stringify(response) }; }, ...options });
  return { service, calls };
}
const detail = () => ({ sessionId: "coverage", requestVersion: 1, coverageVersion: 2, sources, words, count: 1 });

test("count-dependent caps reject overflow without sampling or mutating selection", () => {
  for (let count = 1; count <= 5; count++) {
    const limits = longSentenceSelectionLimits(count);
    assert.equal(limits.sources, Math.min(count * 2, 6)); assert.equal(limits.words, count * 3);
    const selected = Array.from({ length: limits.sources }, (_, i) => ({ id: i }));
    assert.doesNotThrow(() => assertLongSentenceSelection({ count, sources: selected, words: Array(limits.words).fill("word") }));
    assert.throws(() => assertLongSentenceSelection({ count, sources: [...selected, {}], words: [] }), /最多选择/);
    assert.throws(() => assertLongSentenceSelection({ count, sources: selected, words: Array(limits.words + 1).fill("word") }), /最多选择/);
    assert.equal(selected.length, limits.sources);
  }
});

test("source requirements need real evidence, complete IDs and their combined relationship", () => {
  assert.equal(analysis().sources[0].requirements.length, 1);
  for (const mutate of [value => value.sources.pop(), value => value.sources[0].sourceReviewId = "foreign", value => value.sources[0].requirements[0].evidence = ["invented"], value => delete value.sources[0].requirements[0].relation]) {
    const value = analysisRaw(); mutate(value); assert.throws(() => validateSourceAnalysis(value, sources));
  }
});

test("word normalization retains only word, sense and context, not incidental secrets", () => {
  const normalized = normalizeWords([{ ...words[0], apiKey: "PRIVATE", ink: "INK", userRating: "mastered" }]);
  assert.equal(normalized[0].meaning, words[0].meaning); assert.equal(normalized[0].contextSentence, words[0].contextSentence);
  assert.equal(JSON.stringify(normalized).includes("PRIVATE"), false);
  for (const [lemma, form] of [["child", "children"], ["select", "selected"], ["take into account", "took into account"], ["good", "better"]]) assert.ok(isAllowedWordForm(lemma, form));
  for (const [lemma, form] of [["economy", "economic"], ["address", "addressingness"], ["take into account", "take account"]]) assert.equal(isAllowedWordForm(lemma, form), false);
});

test("same word with distinct contextual meanings remains distinct within the training adapter", () => {
  const records = [{ resourceId: "r", passageId: "p", word: "address", senses: [
    { sentence: "We must address the issue.", meaning: "处理" }, { sentence: "Write your address here.", meaning: "地址" }] }];
  const result = aggregateSelectedWords(records, sources, ["source-1"], { bySense: true });
  assert.equal(result.length, 2); assert.equal(new Set(result.map(word => word.wordId)).size, 2);
  assert.deepEqual(new Set(result.map(word => word.meaning)), new Set(["处理", "地址"]));
  assert.equal(records[0].senses.length, 2);
});

test("valid-looking batch missing a selected word is rejected before semantic verification", () => {
  const value = candidate(); value.targetWordUses.pop();
  assert.throws(() => validateCoverageCandidates({ items: [value] }, context()), error => error.code === "coverage_incomplete");
  assert.throws(() => validateCoverageCandidates({ cannotCombine: "请增加句数" }, context()), error => error.code === "selection_incompatible");
});

test("semantic verifier must confirm every sense, exact evidence and every required relationship", () => {
  assert.equal(validateCoverageVerification(verification(), verifyContext()).complete, true);
  for (const mutate of [value => value.items[0].natural = false, value => value.items[0].aboveSource = false,
    value => value.items[0].wordChecks[0].meaningMatches = false, value => value.items[0].wordChecks.pop(),
    value => value.items[0].requirementChecks = [], value => value.items[0].requirementChecks[0].evidence = ["not in this sentence"],
    value => value.items[0].requirementChecks[0].requirementId = "foreign", value => value.items.push(value.items[0])]) {
    const value = verification(); mutate(value); assert.throws(() => validateCoverageVerification(value, verifyContext()));
  }
});

test("covered generation analyzes, generates, verifies, and only then publishes once", async () => {
  const { service, calls } = fixture([analysisRaw(), { items: [candidate()] }, verification()]);
  let publishes = 0;
  const result = await service.generate({ ...detail(), onValidatedItems: (items, metadata) => {
    publishes++; assert.equal(calls.length, 3); assert.equal(metadata.coverage.complete, true); assert.equal(items[0].trainingRequirements.length, 1);
  } });
  assert.equal(result.status, "complete"); assert.equal(publishes, 1); assert.equal(calls.length, 3);
  assert.match(JSON.stringify(calls[1].messages), /印证/); assert.match(JSON.stringify(calls[1].messages), /The results reinforce/);
});

test("missing words use one repair budget, semantic failure never publishes initial candidates", async () => {
  const bad = candidate(); bad.targetWordUses = [];
  const { service, calls } = fixture([analysisRaw(), { items: [bad] }, { items: [candidate()] }, verification()]);
  assert.equal((await service.generate(detail())).status, "complete"); assert.equal(calls.length, 4);
  const rejected = verification(); rejected.items[0].wordChecks[0].meaningMatches = false;
  const second = fixture([analysisRaw(), { items: [candidate()] }, rejected, { items: [candidate()] }, verification()]);
  let publications = 0;
  const result = await second.service.generate({ ...detail(), onValidatedItems: () => publications++ });
  assert.equal(result.status, "complete"); assert.equal(publications, 1); assert.equal(second.calls.length, 5);
});

test("second rejection retains text-only drafts and does not create a partial ready batch", async () => {
  const rejected = verification(); rejected.items[0].natural = false;
  const { service, calls } = fixture([analysisRaw(), { items: [candidate()] }, rejected, { items: [candidate()] }, rejected]);
  let publications = 0;
  await assert.rejects(service.generate({ ...detail(), onValidatedItems: () => publications++ }), error => {
    assert.equal(error.code, "coverage_incomplete"); assert.deepEqual(error.draftItems, [{ text: TRAINING_SENTENCE_B }]); return true;
  });
  assert.equal(publications, 0); assert.equal(calls.length, 5);
});

test("saved analysis can be reused, cancelled or foreign-account work cannot publish", async () => {
  const first = fixture([{ items: [candidate()] }, verification()]);
  assert.equal((await first.service.generate({ ...detail(), sourceAnalysis: analysis() })).status, "complete");
  assert.equal(first.calls.length, 2);
  let owner = "coverage-test";
  const second = fixture([analysisRaw(), () => { owner = "other"; return { content: JSON.stringify({ items: [candidate()] }) }; }], { getUsername: () => owner });
  await assert.rejects(second.service.generate(detail()), error => error.name === "AbortError");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(first.service.generate({ ...detail(), signal: controller.signal }), error => error.name === "AbortError");
});

test("one item's later practice carries only that item's actual words and source requirements", () => {
  const item = { ...candidate(), targetWordUses: [candidate().targetWordUses[0]], trainingRequirements: analysis().sources[0].requirements };
  const result = itemTrainingScope(item, { sources: [...sources, { sourceReviewId: "other" }], words: [...words, { wordId: "unused", word: "unused" }] });
  assert.deepEqual(result.words, [words[0]]); assert.equal(result.sources.length, 1); assert.equal(result.trainingRequirements.length, 1);
});
