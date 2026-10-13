import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  rows = new Map();
  get length() { return this.rows.size; }
  key(index) { return [...this.rows.keys()][index] ?? null; }
  getItem(key) { return this.rows.get(String(key)) ?? null; }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
  removeItem(key) { this.rows.delete(String(key)); }
  clear() { this.rows.clear(); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.window = { localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
const { setCurrentUsername, getUserItem, setUserItem } = await import("../src/userData.js");
const { callAi, callCachedTextAi, normalizeProviderProfile, normalizeUsage, textAiCacheIdentity, bindCredential, saveProviderProfile } = await import("../src/aiProvider.js");
const { resolveProviderCachePolicy, providerCacheRequestFields, estimateAiTokenCost } = await import("../src/aiCachePolicy.js");
const { AI_DYNAMIC_CONTEXT_MARKER, stableAiPrefix } = await import("../src/aiPromptContext.js");
const { buildQuestionHintLevel1Messages, buildQuestionHintLevel2Messages, buildTranslationReviewMessages } = await import("../src/aiTasks.js");
const { buildClozeHintDetail, buildClozeAiMessages, TASK_CLOZE_HINT_1 } = await import("../src/clozeAiTasks.js");
const { runClozeAiTask } = await import("../src/clozeAiService.js");
const { clearAiResultMemory, runCachedAiResult, readAiResult, writeQuestionHintCache, readQuestionHintCache } = await import("../src/aiReviewCache.js");
const { recognizeHandwriting } = await import("../src/vocabulary/handwritingAi.js");
const { createLongSentenceAiService } = await import("../src/longSentence/ai.js");
const { TRAINING_SENTENCE_B, TRAINING_SOURCE, TRAINING_EVALUATION, qualityItem } = await import("./fixtures/long-sentence-quality.mjs");
const { computeAiCacheMetrics } = await import("../src/telemetry/aiCacheMetrics.js");
const { buildScorePayload } = await import("../src/writing/writingAiTasks.js");
const { writingRubricFor } = await import("../src/writing/writingRubrics.js");
const user = "cache-optimization-test";
const CHAT = "openai-chat-completions", RESPONSES = "openai-responses";
const profile = (extra = {}) => normalizeProviderProfile({ providerId: "custom", endpointKind: "custom", baseUrl: "https://cache-mock.invalid/v1", modelId: "mock-model", ...extra });
const messages = [{ role: "system", content: "Fixed rule." }, { role: "user", content: `Fixed article.${AI_DYNAMIC_CONTEXT_MARKER}Question one.` }];
const reply = (content = "valid answer", usage) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }) });
async function withFetch(mock, run) { const original = globalThis.fetch; globalThis.fetch = mock; try { return await run(); } finally { globalThis.fetch = original; } }
async function turns() { for (let i = 0; i < 15; i += 1) await Promise.resolve(); }
function gate() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
beforeEach(() => { localStorage.clear(); setCurrentUsername(user); clearAiResultMemory(); });

test("known official OpenAI Chat/Responses add only a scoped route key; other endpoints/models stay plain", () => {
  const official = profile({ providerId: "openai", endpointKind: "official", baseUrl: "https://api.openai.com/v1", modelId: "gpt-5-mini" });
  for (const transport of [CHAT, RESPONSES]) {
    const fields = providerCacheRequestFields({ profile: official, model: "gpt-5-mini", transport, messages, username: user }).fields;
    assert.deepEqual(Object.keys(fields), ["prompt_cache_key"]);
    assert.match(fields.prompt_cache_key, /^wl:[a-f0-9]{24}:[a-f0-9]{24}$/);
    assert.ok(!fields.prompt_cache_key.includes(user));
  }
  for (const [p, model, transport] of [[{ ...official, baseUrl: "https://proxy.invalid/v1" }, "gpt-5-mini", CHAT], [official, "gpt-5-mini-lookalike", CHAT], [official, "gpt-5-mini", "anthropic-messages"], [{ ...official, endpointKind: "custom" }, "gpt-5-mini", CHAT]]) {
    assert.deepEqual(providerCacheRequestFields({ profile: p, model, transport, messages, username: user }).fields, {});
  }
});
test("DeepSeek user_id is exact-model gated; Qwen/Gemini/router/Zen never gain paid explicit cache fields", () => {
  const p = profile({ providerId: "deepseek", endpointKind: "official", baseUrl: "https://api.deepseek.com" });
  assert.deepEqual(providerCacheRequestFields({ profile: p, model: "deepseek-chat", transport: CHAT, messages, username: user }).fields, {});
  assert.match(providerCacheRequestFields({ profile: p, model: "deepseek-v4-pro", transport: CHAT, messages, username: user }).fields.user_id, /^[a-f0-9]{64}$/);
  for (const [providerId, baseUrl, model] of [["alibaba", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"], ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash"], ["openrouter", "https://openrouter.ai/api/v1", "openrouter/auto"], ["opencode-zen", "https://opencode.ai/zen/v1", "gpt-5-mini"]]) {
    const value = providerCacheRequestFields({ profile: { providerId, baseUrl, endpointKind: "official" }, model, transport: CHAT, messages, username: user });
    assert.deepEqual(value.fields, {}); assert.equal(value.policy.explicitEnabled, false);
  }
  assert.equal(resolveProviderCachePolicy({ profile: p, model: "unlisted", transport: CHAT }).automatic, "unknown");
  assert.equal(resolveProviderCachePolicy({ profile: { providerId: "glm", baseUrl: "https://open.bigmodel.cn/api/paas/v4", endpointKind: "official" }, model: "glm-5.3", transport: CHAT }).automatic, "documented");
  assert.equal(resolveProviderCachePolicy({ profile: { providerId: "glm", baseUrl: "https://api.z.ai/api/paas/v4", endpointKind: "official" }, model: "glm-5.3", transport: CHAT }).automatic, "unknown");
});
test("routing groups share an article prefix across questions but separate accounts, resources and rules", () => {
  const p = { providerId: "openai", baseUrl: "https://api.openai.com/v1", endpointKind: "official" };
  const key = (m = messages, username = user) => providerCacheRequestFields({ profile: p, model: "gpt-5-mini", transport: RESPONSES, messages: m, username }).fields.prompt_cache_key;
  assert.equal(key(), key([{ ...messages[0] }, { role: "user", content: `Fixed article.${AI_DYNAMIC_CONTEXT_MARKER}Question two.` }]));
  assert.notEqual(key(), key(messages, "another-account"));
  assert.notEqual(key(), key([messages[0], { role: "user", content: `Other article.${AI_DYNAMIC_CONTEXT_MARKER}Question one.` }]));
  assert.notEqual(key(), key([{ role: "system", content: "Different phase rules." }, messages[1]]));
});
test("actual Responses field rejection retries plain once and suppresses the field for subsequent requests", async () => {
  const p = profile({ providerId: "openai", endpointKind: "official", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1-nano" });
  const bodies = [];
  await withFetch(async (url, init) => {
    assert.ok(url.endsWith("/responses")); const body = JSON.parse(init.body); bodies.push(body);
    if (bodies.length === 1) return { ok: false, status: 400, json: async () => ({ error: { param: "prompt_cache_key", message: "Unsupported parameter: prompt_cache_key" } }) };
    return { ok: true, json: async () => ({ output_text: "valid response" }) };
  }, async () => {
    const args = { profile: p, apiKey: "mock-only", model: p.modelId, messages };
    assert.equal((await callAi(args)).content, "valid response");
    assert.equal((await callAi(args)).content, "valid response");
  });
  assert.equal(bodies.length, 3); assert.ok(bodies[0].prompt_cache_key);
  assert.equal(bodies[1].prompt_cache_key, undefined); assert.equal(bodies[2].prompt_cache_key, undefined);
  assert.deepEqual(bodies[1].input, messages); assert.equal(bodies[1].model, p.modelId);
});
test("auth, rate limits, server errors and unrelated 400s never trigger compatibility retries", async () => {
  const p = profile({ providerId: "openai", endpointKind: "official", baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1-mini" });
  for (const status of [401, 429, 500, 400]) {
    let calls = 0;
    await withFetch(async () => { calls += 1; return { ok: false, status, json: async () => ({ error: { message: "model failed" } }) }; }, async () => assert.rejects(callAi({ profile: p, apiKey: "mock", messages })));
    assert.equal(calls, 1);
  }
});
test("Usage maps provider shapes, writes and reasoning without promoting missing values to zero", () => {
  const cases = [
    [{ input_tokens: 100, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } }, 100, 60, 40, 20],
    [{ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60, cache_creation_input_tokens: 20 }, completion_tokens: 5 }, 100, 60, 40, 20],
    [{ promptTokenCount: 100, cachedContentTokenCount: 60, candidatesTokenCount: 5 }, 100, 60, 40, null],
    [{ total_input_tokens: 100, total_cached_tokens: 60, total_output_tokens: 5 }, 100, 60, 40, null],
    [{ input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 5 }, 100, 60, 40, 20],
  ];
  for (const [raw, prompt, hit, miss, write] of cases) {
    const usage = normalizeUsage(raw); assert.equal(usage.prompt_tokens, prompt); assert.equal(usage.cacheUsage.hitTokens, hit); assert.equal(usage.cacheUsage.missTokens, miss); assert.equal(usage.cache_write_tokens, write);
  }
  for (const value of [null, "", false, -1]) assert.equal(normalizeUsage({ prompt_tokens: value }).prompt_tokens, null);
  assert.equal(normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 40 }).cacheUsage.hitTokens, null);
  assert.equal(normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 101 } }).cacheUsage.hitTokens, null);
  assert.equal(normalizeUsage({ cost: 0.02 }).reported_cost, 0.02);
});
test("keys include account, credential rotation, endpoint, transport, model, prompt version and image bytes", async () => {
  const p = profile(); const args = { profile: p, messages, temperature: 0 };
  const key = extra => textAiCacheIdentity({ ...args, ...extra }).fingerprint;
  const first = key({}); assert.equal(first, key({}));
  assert.notEqual(first, key({ model: "another-model" }));
  assert.notEqual(first, key({ profile: profile({ baseUrl: "https://other-mock.invalid/v1" }) }));
  assert.notEqual(first, key({ profile: { ...p, transportOverride: RESPONSES } }));
  assert.notEqual(first, key({ promptVersion: 2 })); assert.notEqual(first, key({ temperature: 0.3 }));
  assert.notEqual(key({ apiKey: "mock-one" }), key({ apiKey: "mock-two" }));
  await bindCredential(p, "mock-one"); const bound = key({});
  await bindCredential(p, "mock-two"); assert.notEqual(bound, key({}));
  setCurrentUsername("other-account"); assert.notEqual(first, key({}));
  const image = value => [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${value}` } }] }];
  assert.notEqual(key({ messages: image("AAAA") }), key({ messages: image("BBBB") }));
});
test("reading and translation prefixes are byte identical across dynamic inputs and never acquire answer data", () => {
  const context = { articleText: "An article with a contrast and a conclusion.", chapter: "Sample", resourceId: "resource-one", options: [{ key: "A", text: "SECRET_OPTION" }], officialAnswer: "SECRET_ANSWER", firstAnswer: "SECRET_USER_CHOICE" };
  for (const build of [buildQuestionHintLevel1Messages, buildQuestionHintLevel2Messages]) {
    const a = build({ ...context, questionText: "First question?" }), b = build({ ...context, questionText: "Second question?" });
    assert.deepEqual(Buffer.from(JSON.stringify(stableAiPrefix(a))), Buffer.from(JSON.stringify(stableAiPrefix(b))));
    assert.notDeepEqual(a, b); assert.doesNotMatch(JSON.stringify(a), /SECRET_/);
    assert.notDeepEqual(stableAiPrefix(a), stableAiPrefix(build({ ...context, resourceId: "resource-two", questionText: "First question?" })));
  }
  const a = buildTranslationReviewMessages({ chapter: "Sample", paragraph: context.articleText, sentence: "First sentence.", userTranslation: "第一句" });
  const b = buildTranslationReviewMessages({ chapter: "Sample", paragraph: context.articleText, sentence: "Second sentence.", userTranslation: "修改的译文" });
  assert.deepEqual(stableAiPrefix(a), stableAiPrefix(b));
});
const articleSources = [{ sentenceId: "s1", source: "We [1] the route." }, { sentenceId: "s2", source: "They [2] the coast." }];
function clozeDetail(blank = 1) { return buildClozeHintDetail({ taskType: TASK_CLOZE_HINT_1, resourceId: "r", clozeId: "c", chapter: "Sample", blankNumber: blank, currentSentence: articleSources[blank - 1], articleSources, contextSources: articleSources }); }
const clozeResult = { level: 1, focus: "观察空格前后的语法结构", grammarSignals: ["观察谓语"], logicSignals: [], selfCheckQuestion: "空格需要什么作用？" };
test("cloze whole-article prefixes stay byte stable across blanks while safety source lists remain local", () => {
  const a = buildClozeAiMessages(TASK_CLOZE_HINT_1, clozeDetail(1)), b = buildClozeAiMessages(TASK_CLOZE_HINT_1, clozeDetail(2));
  assert.deepEqual(stableAiPrefix(a), stableAiPrefix(b)); assert.notDeepEqual(a, b);
  assert.match(a[1].content, /We \[1\] the route/); assert.match(a[1].content, /They \[2\] the coast/);
  assert.doesNotMatch(JSON.stringify(a), /officialAnswer|firstAnswer|options/);
});
test("cloze cancelling one consumer preserves another consumer and caches only validated success", async () => {
  const done = gate(); let calls = 0, networkSignal;
  const controller = new AbortController(); const args = { taskType: TASK_CLOZE_HINT_1, detail: clozeDetail(), apiKey: "mock", callAi: async ({ signal }) => { calls += 1; networkSignal = signal; await done.promise; return { content: JSON.stringify(clozeResult) }; } };
  const first = runClozeAiTask({ ...args, signal: controller.signal }); await turns();
  const second = runClozeAiTask(args); await turns(); controller.abort();
  assert.equal((await first).status, "aborted"); assert.equal(networkSignal.aborted, false);
  done.resolve(); assert.equal((await second).status, "ok"); assert.equal(calls, 1);
  assert.equal((await runClozeAiTask(args)).cached, true); assert.equal(calls, 1);
});
test("optional TTL expires reusable results without deleting old data or ignoring force", async () => {
  const realNow = Date.now; let time = realNow(), calls = 0;
  Date.now = () => time;
  try {
    const args = { username: user, namespace: "ttl-test", fingerprint: "same", maxAgeMs: 100, request: async () => ({ text: `result-${++calls}` }) };
    await runCachedAiResult(args); time += 99; assert.equal((await runCachedAiResult(args)).cached, true);
    time += 2; assert.equal((await runCachedAiResult(args)).cached, false); assert.equal(calls, 2);
    assert.equal((await runCachedAiResult({ ...args, force: true })).cached, false); assert.equal(calls, 3);
    assert.ok(getUserItem("wuliao:ai:result-cache:ttl-test"));
  } finally { Date.now = realNow; }
});
test("corrupt persistence and rejected structured cache degrade to new results and leave learning records untouched", async () => {
  setUserItem("learning-record-sentinel", "unchanged");
  setUserItem("wuliao:ai:result-cache:corrupt-test", JSON.stringify({ entries: [null, { fingerprint: "same", savedAt: 1, result: null }] }));
  clearAiResultMemory(); let calls = 0;
  const args = { namespace: "corrupt-test", fingerprint: "same", request: async () => { calls += 1; return { text: "valid" }; } };
  assert.equal((await runCachedAiResult(args)).cached, false); assert.equal(calls, 1);
  writeQuestionHintCache("corrupted-schema", { correctAnswer: "A" });
  assert.equal(readQuestionHintCache("corrupted-schema", {}, value => !value.correctAnswer), null);
  assert.equal(getUserItem("learning-record-sentinel"), "unchanged");
  assert.equal(readAiResult("unknown-namespace", "missing"), null);
});
test("OCR reuses exact pixels with rebound row ids; changed pixels, force and uncertain recognition reach network", async () => {
  const p = saveProviderProfile(profile({ modality: "vision" })); await bindCredential(p, "mock-vision-key");
  let calls = 0, unsure = false;
  await withFetch(async () => { calls += 1; return reply(JSON.stringify({ items: [{ id: "0", text: "原样文字", unsure }] })); }, async () => {
    const args = { username: user, images: [{ id: "row-one", image: "data:image/png;base64,AAAA" }] };
    assert.equal((await recognizeHandwriting(args))[0].id, "row-one");
    assert.equal((await recognizeHandwriting({ ...args, images: [{ ...args.images[0], id: "row-two" }] }))[0].id, "row-two"); assert.equal(calls, 1);
    await recognizeHandwriting({ ...args, images: [{ ...args.images[0], image: "data:image/png;base64,BBBB" }] }); assert.equal(calls, 2);
    await recognizeHandwriting({ ...args, force: true }); assert.equal(calls, 3);
    unsure = true; const changed = { ...args, images: [{ ...args.images[0], image: "data:image/png;base64,CCCC" }] };
    await recognizeHandwriting(changed); await recognizeHandwriting(changed); assert.equal(calls, 5);
  });
});
const evaluationDetail = () => ({ sessionId: "s", itemId: "i", attemptId: "a", submittedAt: 1, generatedSentence: TRAINING_SENTENCE_B, structureFingerprint: qualityItem().structureFingerprint, userTranslation: "尽管存在限制，研究表明该行星适宜居住。", targetWordUses: [], difficultyMetadata: qualityItem().difficultyMetadata });
test("long-sentence evaluation validates reuse, rebinds attempt lineage, persists and respects reanalysis", async () => {
  let calls = 0; const service = createLongSentenceAiService({ getProfile: () => profile(), callAi: async () => { calls += 1; return { content: JSON.stringify(TRAINING_EVALUATION) }; } });
  const first = await service.evaluate(evaluationDetail()); assert.equal(first.cached, false);
  const second = await service.evaluate({ ...evaluationDetail(), attemptId: "b" }); assert.equal(second.cached, true); assert.equal(second.lineage.attemptId, "b"); assert.deepEqual(second.requests, []);
  clearAiResultMemory(); assert.equal((await service.evaluate({ ...evaluationDetail(), attemptId: "c" })).cacheSource, "persistent"); assert.equal(calls, 1);
  await service.evaluate({ ...evaluationDetail(), evaluationVersion: 2 }); assert.equal(calls, 2);
  await service.evaluate({ ...evaluationDetail(), userTranslation: "修改译文" }); assert.equal(calls, 3);
});
test("shared long-sentence evaluation survives cancellation in one of two training panes", async () => {
  const done = gate(); const controller = new AbortController(); let calls = 0, networkSignal;
  const create = () => createLongSentenceAiService({ getProfile: () => profile(), callAi: async ({ signal }) => { calls += 1; networkSignal = signal; await done.promise; return { content: JSON.stringify(TRAINING_EVALUATION) }; } });
  const first = create().evaluate({ ...evaluationDetail(), signal: controller.signal }); const failed = assert.rejects(first, error => error.name === "AbortError"); await turns();
  const second = create().evaluate({ ...evaluationDetail(), attemptId: "another-pane" }); await turns();
  controller.abort(); await failed; assert.equal(networkSignal.aborted, false);
  done.resolve(); assert.deepEqual((await second).evaluation, TRAINING_EVALUATION); assert.equal(calls, 1);
});
test("generation remains a fresh provider request and preserves difficulty/novelty validation", async () => {
  let calls = 0; const service = createLongSentenceAiService({ getProfile: () => profile(), callAi: async () => { calls += 1; return { content: JSON.stringify({ items: [qualityItem()] }) }; } });
  const args = { sessionId: "s", sources: [{ sourceReviewId: "source-1", text: TRAINING_SOURCE, difficulty: 2 }], words: [], count: 1 };
  await service.generate(args); await service.generate(args); assert.equal(calls, 2);
});
test("long-sentence stable input and version precede the user's changing translation", async () => {
  const requests = [];
  const service = createLongSentenceAiService({ getProfile: () => profile(), callAi: async ({ messages }) => { requests.push(messages); return { content: JSON.stringify(TRAINING_EVALUATION) }; } });
  await service.evaluate(evaluationDetail());
  await service.evaluate({ ...evaluationDetail(), userTranslation: "另一个译文" });
  const userParts = requests.map(messages => messages[1].content.split('"userTranslation"')[0]);
  assert.equal(userParts[0], userParts[1]); assert.match(userParts[0], /targetWordUses|difficultyMetadata|long-sentence.evaluate.v2/);
});
test("formal score prefix puts rubric and prompt ahead of essay while preserving exact essay fingerprints", () => {
  const promptSnapshot = { questionId: "q", fingerprint: "p", taskType: "postgrad-en1-writing-a", promptText: "Write a letter.", directions: "Use about 100 words." };
  const rubric = writingRubricFor(promptSnapshot.taskType);
  const sourceAttempt = text => ({ status: "submitted", verifiedText: { text, fingerprint: `fingerprint:${text}` } });
  const a = buildScorePayload({ promptSnapshot, sourceAttempt: sourceAttempt("First essay."), rubricVersion: rubric.rubricVersion });
  const b = buildScorePayload({ promptSnapshot, sourceAttempt: sourceAttempt("Second essay."), rubricVersion: rubric.rubricVersion });
  assert.deepEqual(Object.keys(a), ["rubricVersion", "promptSnapshot", "verifiedText"]);
  assert.equal(JSON.stringify(a).split('"verifiedText"')[0], JSON.stringify(b).split('"verifiedText"')[0]);
  assert.notEqual(a.verifiedText.fingerprint, b.verifiedText.fingerprint);
});
function metricEvent(type, usage, extra = {}) { return { eventType: type, model: "m", taskType: "task", status: "success", durationMs: 100, metadata: { providerId: "openrouter", transportKind: CHAT, accountScope: "scope", ...(usage === undefined ? {} : { usage }), ...extra } }; }
test("telemetry separates local hits/joins/network, uses token weights and marks incomplete Usage", () => {
  const events = [metricEvent("ai.result_cache.memory_hit"), metricEvent("ai.result_cache.persistent_hit"), metricEvent("ai.result_cache.miss"), metricEvent("ai.result_cache.inflight_join"), metricEvent("ai.api_request_started"), metricEvent("ai.api_request_started"), metricEvent("ai.api_request", { promptTokens: 100, cacheUsage: { hitTokens: 90, missTokens: 10 } }), metricEvent("ai.api_request", { promptTokens: 900, cacheUsage: { hitTokens: 90, missTokens: 810 } }), metricEvent("ai.api_request", null), metricEvent("ai.api_request", { promptTokens: 9000 }, { accountScope: "other-user" })];
  const [row] = computeAiCacheMetrics(events, { accountScope: "scope" });
  assert.equal(row.localHitRatio, 0.5); assert.equal(row.coalesced, 1); assert.equal(row.networkRequests, 2);
  assert.equal(row.providerHitRatio, 0.18); assert.equal(row.promptTokens, 1000); assert.equal(row.unknownUsageRequests, 1);
  assert.equal(row.providerUsageComplete, false); assert.equal(row.writeTokens, null); assert.equal(row.estimatedCost, null);
});
test("a reported router cost remains available with no token breakdown and is not fabricated for custom endpoints", () => {
  const usage = { reportedCost: 0.012 };
  const [row] = computeAiCacheMetrics([metricEvent("ai.api_request", usage)], { accountScope: "scope" });
  assert.equal(row.reportedCost, 0.012); assert.equal(row.hitTokens, null);
  const [custom] = computeAiCacheMetrics([metricEvent("ai.api_request", usage, { providerId: "custom" })], { accountScope: "scope" });
  assert.equal(custom.reportedCost, null);
});
test("complete verified cost cards separate four charges and can report negative savings from writes", () => {
  const usage = { prompt_tokens: 1000, cacheUsage: { hitTokens: 500 }, cache_write_tokens: 200, completion_tokens: 100 };
  const rates = { verified: true, source: "mock-rate-card", asOf: "2026-10-13", currency: "TEST", input: 10, read: 1, write: 20, output: 30, writeBilling: "replaces-input" };
  const result = estimateAiTokenCost(usage, rates);
  assert.equal(result.calculable, true); assert.equal(result.normalInput, 0.003); assert.equal(result.cacheRead, 0.0005); assert.equal(result.cacheWrite, 0.004); assert.equal(result.output, 0.003);
  assert.equal(estimateAiTokenCost(usage, { ...rates, write: 100 }).inputSavings < 0, true);
  assert.equal(estimateAiTokenCost(usage, { ...rates, writeBilling: "additional-to-input" }).normalInput, 0.005);
  assert.equal(estimateAiTokenCost(usage, { ...rates, writeBilling: undefined }).calculable, false);
  assert.equal(estimateAiTokenCost({ ...usage, cache_write_tokens: null }, rates).calculable, false);
  assert.equal(estimateAiTokenCost(usage, { ...rates, verified: false }).calculable, false);
  assert.equal(estimateAiTokenCost({ ...usage, cache_write_tokens: 600 }, rates).calculable, false);
});
test("billing estimates require the verified provider/model/transport/endpoint price card", () => {
  const endpointIdentity = "synthetic-endpoint-hash", usage = { promptTokens: 1000, completionTokens: 10, cacheUsage: { hitTokens: 500, missTokens: 500 }, writeTokens: 0 };
  const event = metricEvent("ai.api_request", usage, { endpointIdentity });
  const rates = { verified: true, source: "mock-rate-card", asOf: "2026-10-13", currency: "TEST", providerId: "openrouter", modelId: "m", transportKind: CHAT, endpointIdentity, input: 10, read: 1, output: 30 };
  const rateCards = { [JSON.stringify(["openrouter", "m", CHAT, endpointIdentity])]: rates };
  assert.notEqual(computeAiCacheMetrics([event], { accountScope: "scope", rateCards })[0].estimatedCost, null);
  assert.equal(computeAiCacheMetrics([{ ...event, metadata: { ...event.metadata, endpointIdentity: "other-endpoint" } }], { accountScope: "scope", rateCards })[0].estimatedCost, null);
});
test("timeout and late cancelled responses cannot become reusable text results", async () => {
  let calls = 0; const args = { profile: profile(), apiKey: "mock", messages, taskType: "cancel-test" };
  await withFetch(async () => { calls += 1; await new Promise(done => setTimeout(done, 15)); return reply("late result"); }, async () => {
    await assert.rejects(callCachedTextAi({ ...args, timeoutMs: 1 }), error => error.code === "timeout");
    const controller = new AbortController(); const pending = callCachedTextAi({ ...args, signal: controller.signal }); const failed = assert.rejects(pending, error => error.name === "AbortError"); await turns(); controller.abort(); await failed;
    await new Promise(done => setTimeout(done, 20)); assert.equal((await callCachedTextAi(args)).cached, false);
  });
  assert.equal(calls, 3);
});
