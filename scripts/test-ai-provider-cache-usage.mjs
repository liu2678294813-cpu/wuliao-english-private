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
const { setCurrentUsername } = await import("../src/userData.js");
const { clearAiResultMemory } = await import("../src/aiReviewCache.js");
const { normalizeUsage, textAiCacheIdentity, callCachedTextAi } = await import("../src/aiProvider.js");
const { runQuickTranslation } = await import("../src/ai.js");
const messages = [{ role: "user", content: "Explain bank." }];
const args = () => ({ apiKey: "mock-key", model: "deepseek-chat", taskType: "chat", messages });
const response = (content, usage) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }) });
beforeEach(() => { localStorage.clear(); setCurrentUsername("provider-cache-user"); clearAiResultMemory(); });

test("DeepSeek Chat usage retains cache hit, miss and ratio", () => {
  const result = normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 10, total_tokens: 110 });
  assert.deepEqual(result.cacheUsage, { hitTokens: 80, missTokens: 20, hitRatio: 0.8 });
  assert.equal(result.total_tokens, 110);
});
test("Responses usage maps cached input tokens and derives uncached input", () => {
  const result = normalizeUsage({ input_tokens: 200, input_tokens_details: { cached_tokens: 150 }, output_tokens: 20, total_tokens: 220 });
  assert.deepEqual(result.cacheUsage, { hitTokens: 150, missTokens: 50, hitRatio: 0.75 });
  assert.equal(result.prompt_tokens, 200);
  assert.equal(result.completion_tokens, 20);
});
test("missing or unsupported cache usage remains null without errors", () => {
  assert.equal(normalizeUsage(undefined), null);
  assert.equal(normalizeUsage(null), null);
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10 }).cacheUsage, { hitTokens: null, missTokens: null, hitRatio: null });
  assert.deepEqual(normalizeUsage({}).cacheUsage, { hitTokens: null, missTokens: null, hitRatio: null });
});
test("zero usage is preserved; zero-over-zero ratio stays null", () => {
  const zero = normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 });
  assert.equal(zero.prompt_tokens, 0);
  assert.equal(zero.completion_tokens, 0);
  assert.deepEqual(zero.cacheUsage, { hitTokens: 0, missTokens: 0, hitRatio: null });
  assert.equal(normalizeUsage({ prompt_tokens: 12, prompt_cache_hit_tokens: 0 }).cacheUsage.hitRatio, 0);
});
test("cached text identity includes entire conversation, roles and message order", () => {
  const key = list => textAiCacheIdentity({ ...args(), messages: list }).fingerprint;
  const a = [{ role: "user", content: "We discuss rivers." }, { role: "assistant", content: "River banks." }, ...messages];
  const b = [{ role: "user", content: "We discuss finance." }, { role: "assistant", content: "Financial banks." }, ...messages];
  assert.notEqual(key(a), key(b));
  assert.notEqual(key(messages), key([{ role: "system", content: messages[0].content }]));
  assert.notEqual(key(a), key([...a].reverse()));
  assert.equal(key(a), key(a.map(item => ({ content: item.content, role: item.role }))));
});
test("cached text prompt version, model and temperature are identity inputs", () => {
  const key = overrides => textAiCacheIdentity({ ...args(), ...overrides }).fingerprint;
  assert.notEqual(key({ promptVersion: 1 }), key({ promptVersion: 2 }));
  assert.notEqual(key({ model: "deepseek-chat" }), key({ model: "deepseek-reasoner" }));
  assert.notEqual(key({ temperature: 0.2 }), key({ temperature: 0.6 }));
});
test("actual cached text call returns usage and makes one HTTP across repeat and restart; force makes second", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    assert.deepEqual(JSON.parse(init.body).messages, messages);
    return response(`answer-${calls}`, { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 });
  };
  try {
    const first = await callCachedTextAi(args());
    assert.deepEqual(first.usage.cacheUsage, { hitTokens: 80, missTokens: 20, hitRatio: 0.8 });
    assert.equal((await callCachedTextAi(args())).cacheSource, "memory");
    clearAiResultMemory();
    assert.equal((await callCachedTextAi(args())).cacheSource, "persistent");
    assert.equal(calls, 1);
    assert.equal((await callCachedTextAi({ ...args(), force: true })).content, "answer-2");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
test("HTTP failures and empty responses never become cached text results", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 500, json: async () => ({ error: { message: "mock failure" } }) };
    if (calls === 2) return response(" ");
    return response("valid retry");
  };
  try {
    await assert.rejects(callCachedTextAi(args()), /mock failure/);
    await assert.rejects(callCachedTextAi(args()));
    assert.equal((await callCachedTextAi(args())).content, "valid retry");
    assert.equal(calls, 3);
    await callCachedTextAi(args());
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
test("actual quick word requests dedupe while concurrent callers await the same HTTP", async () => {
  const original = globalThis.fetch;
  let release, started, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async () => { calls += 1; started(); await gate; return response("放弃"); };
  const quick = { text: "abandon", kind: "word", apiKey: "mock-key", model: "deepseek-chat", dictionary: async () => "" };
  try {
    const first = runQuickTranslation(quick);
    await ready;
    const second = runQuickTranslation({ ...quick, text: " Abandon " });
    release();
    const results = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(results.map(item => item.result.translation), ["放弃", "放弃"]);
  } finally { globalThis.fetch = original; }
});
test("actual contextual bank translations remain isolated and each repeat adds zero HTTP", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const input = JSON.parse(init.body).messages.map(item => item.content).join("\n");
    return response(input.includes("river") ? "河岸" : "银行");
  };
  const base = { text: "bank", kind: "word", apiKey: "mock-key", model: "deepseek-chat", dictionary: async () => assert.fail("contextual translation must not reuse standalone dictionary meaning") };
  const river = { ...base, contextSentence: "He sat on the bank of the river." };
  const money = { ...base, contextSentence: "She opened a bank account." };
  try {
    assert.equal((await runQuickTranslation(river)).result.translation, "河岸");
    assert.equal((await runQuickTranslation(money)).result.translation, "银行");
    assert.equal(calls, 2);
    clearAiResultMemory();
    assert.equal((await runQuickTranslation(river)).result.translation, "河岸");
    assert.equal((await runQuickTranslation(money)).result.translation, "银行");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
