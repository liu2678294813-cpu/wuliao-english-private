import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

class MemoryStorage {
  rows = new Map();
  reads = 0;
  failWrites = false;
  get length() { return this.rows.size; }
  key(index) { return [...this.rows.keys()][index] ?? null; }
  getItem(key) { this.reads += 1; return this.rows.get(String(key)) ?? null; }
  setItem(key, value) {
    if (this.failWrites) throw new DOMException("Storage full", "QuotaExceededError");
    this.rows.set(String(key), String(value));
  }
  removeItem(key) { this.rows.delete(String(key)); }
  clear() { this.rows.clear(); this.reads = 0; this.failWrites = false; }
}

globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.window = { localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { setCurrentUsername } = await import("../src/userData.js");
const {
  runCachedAiResult,
  readAiResult,
  clearAiResultMemory,
  AI_RESULT_CACHE_LIMITS,
} = await import("../src/aiReviewCache.js");
const { normalizeQuickTranslationInput, quickTranslationIdentity, runQuickTranslation, saveProviderProfile } = await import("../src/ai.js");
const { sha256AiInput, stableAiIdentity } = await import("../src/aiTasks.js");

const username = "result-cache-user";
const translation = { translation: "放弃；抛弃" };
function options(overrides = {}) {
  return {
    namespace: "quick-word", fingerprint: "word-abandon-v1", identity: "quick-word:v1:abandon",
    username, request: async () => translation,
    validate: (result) => Boolean(result?.translation?.trim()), ...overrides,
  };
}
function read(overrides = {}) {
  const args = options(overrides);
  return readAiResult(args.namespace, args.fingerprint, args.identity, args.username);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Explicit microtask turns allow request registration without timing-sensitive sleeps.
async function settle() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

beforeEach(() => {
  localStorage.clear();
  setCurrentUsername(username);
  clearAiResultMemory();
});

test("first request reaches network; repeat returns L1 with zero additional requests", async () => {
  let calls = 0;
  const args = options({ request: async () => { calls += 1; return translation; } });
  const first = await runCachedAiResult(args);
  const second = await runCachedAiResult(args);
  assert.equal(calls, 1);
  assert.equal(first.source, "network");
  assert.equal(first.cached, false);
  assert.equal(second.source, "memory");
  assert.equal(second.cached, true);
  assert.deepEqual(second.result, translation);
});

test("clearing runtime state preserves L2; persistent read promotes result into L1", async () => {
  await runCachedAiResult(options());
  clearAiResultMemory();
  const restored = await runCachedAiResult(options({ request: () => assert.fail("persistent hit must not call provider") }));
  assert.equal(restored.source, "persistent");
  assert.equal(restored.cached, true);
  assert.deepEqual(restored.result, translation);
  assert.equal(read().source, "memory");
});

test("hot read does not parse persistent JSON again", async () => {
  await runCachedAiResult(options());
  const originalParse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => { parses += 1; return originalParse(...args); };
  try { for (let index = 0; index < 5; index += 1) assert.deepEqual(read().result, translation); }
  finally { JSON.parse = originalParse; }
  assert.equal(parses, 0);
});

test("namespace and complete identity prevent accidental collisions", async () => {
  await runCachedAiResult(options());
  assert.equal(read({ namespace: "context-word" }), null);
  assert.equal(read({ identity: "quick-word:v2:abandon" }), null);
  assert.equal(read({ fingerprint: "different-fingerprint" }), null);
});

test("L1 and L2 remain account isolated", async () => {
  await runCachedAiResult(options());
  setCurrentUsername("other-user");
  assert.equal(read({ username: "other-user" }), null);
  clearAiResultMemory();
  assert.equal(read({ username: "other-user" }), null);
  setCurrentUsername(username);
  assert.deepEqual(read().result, translation);
});

test("two simultaneous callers share one request and both receive the result", async () => {
  const gate = deferred();
  let calls = 0;
  const args = options({ request: () => { calls += 1; return gate.promise; } });
  const first = runCachedAiResult(args);
  const second = runCachedAiResult(args);
  await settle();
  assert.equal(calls, 1);
  gate.resolve(translation);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((item) => item.result), [translation, translation]);
  assert.ok(results.some((item) => item.source === "inflight"));
});

test("one consumer abort does not abort a still-needed shared network request", async () => {
  const gate = deferred();
  const cancelled = new AbortController();
  let networkSignal;
  const request = ({ signal }) => { networkSignal = signal; return gate.promise; };
  const first = runCachedAiResult(options({ request, signal: cancelled.signal }));
  const rejected = assert.rejects(first);
  const second = runCachedAiResult(options({ request }));
  await settle();
  cancelled.abort();
  await settle();
  assert.equal(networkSignal.aborted, false);
  gate.resolve(translation);
  await rejected;
  assert.deepEqual((await second).result, translation);
  assert.deepEqual(read().result, translation);
});

test("all consumers abort: late provider success must not enter cache", async () => {
  const gate = deferred();
  const controller = new AbortController();
  let networkSignal;
  const running = runCachedAiResult(options({ signal: controller.signal, request: ({ signal }) => { networkSignal = signal; return gate.promise; } }));
  const rejected = assert.rejects(running);
  await settle();
  controller.abort();
  await settle();
  assert.equal(networkSignal.aborted, true);
  gate.resolve(translation);
  await rejected;
  await settle();
  assert.equal(read(), null);
  clearAiResultMemory();
  assert.equal(read(), null);
});

test("cancelled flight cannot capture an immediate retry or overwrite its fresh result when old provider resolves late", async () => {
  const oldGate = deferred();
  const controller = new AbortController();
  let calls = 0;
  const old = runCachedAiResult(options({
    signal: controller.signal,
    // Deliberately ignore AbortSignal to exercise an uncooperative transport.
    request: () => { calls += 1; return oldGate.promise; },
  }));
  const oldRejected = assert.rejects(old, error => error.name === "AbortError");
  await settle();
  assert.equal(calls, 1);
  controller.abort();
  await oldRejected;
  const fresh = { translation: "新请求的有效结果" };
  const retry = runCachedAiResult(options({ request: async () => { calls += 1; return fresh; } }));
  await settle();
  // This assertion occurs before resolving the old transport: retry must not
  // wait for, or join, the aborted flight.
  assert.equal(calls, 2);
  assert.deepEqual((await retry).result, fresh);
  assert.deepEqual(read().result, fresh);
  oldGate.resolve({ translation: "不应覆盖缓存的迟到旧结果" });
  await settle();
  assert.deepEqual(read().result, fresh);
  clearAiResultMemory();
  assert.deepEqual(read().result, fresh);
});

test("already aborted caller cannot consume cached result or initiate provider", async () => {
  await runCachedAiResult(options());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCachedAiResult(options({ signal: controller.signal, request: () => assert.fail("aborted provider call") })));
});

test("stale consumer cannot write a late successful result", async () => {
  const gate = deferred();
  let current = true;
  const running = runCachedAiResult(options({ isCurrent: () => current, request: () => gate.promise }));
  const rejected = assert.rejects(running);
  await settle();
  current = false;
  gate.resolve(translation);
  await rejected;
  assert.equal(read(), null);
});

test("account switch during request cannot write into either account", async () => {
  const gate = deferred();
  const running = runCachedAiResult(options({ request: () => gate.promise }));
  const rejected = assert.rejects(running);
  await settle();
  setCurrentUsername("other-user");
  gate.resolve(translation);
  await rejected;
  assert.equal(read({ username: "other-user" }), null);
  setCurrentUsername(username);
  assert.equal(read(), null);
});

test("force bypasses cache and replaces current identity after success", async () => {
  await runCachedAiResult(options());
  const fresh = { translation: "放弃；舍弃" };
  let calls = 0;
  const result = await runCachedAiResult(options({ force: true, request: async () => { calls += 1; return fresh; } }));
  assert.equal(calls, 1);
  assert.equal(result.cached, false);
  assert.deepEqual(read().result, fresh);
  clearAiResultMemory();
  assert.deepEqual(read().result, fresh);
});

test("force queues behind normal flight; concurrent forced callers share one fresh request", async () => {
  const original = deferred();
  const fresh = deferred();
  let calls = 0;
  const request = () => { calls += 1; return calls === 1 ? original.promise : fresh.promise; };
  const normal = runCachedAiResult(options({ request }));
  await settle();
  const forcedA = runCachedAiResult(options({ request, force: true }));
  const forcedB = runCachedAiResult(options({ request, force: true }));
  await settle();
  assert.equal(calls, 1);
  original.resolve(translation);
  await normal;
  await settle();
  assert.equal(calls, 2);
  const changed = { translation: "新译文" };
  fresh.resolve(changed);
  const results = await Promise.all([forcedA, forcedB]);
  assert.deepEqual(results.map((item) => item.result), [changed, changed]);
  assert.deepEqual(read().result, changed);
});

test("queued force starts when previous consumer aborts even if previous transport never settles", async () => {
  const oldGate = deferred();
  const controller = new AbortController();
  let calls = 0;
  const normal = runCachedAiResult(options({ signal: controller.signal, request: () => { calls += 1; return oldGate.promise; } }));
  const cancelled = assert.rejects(normal, error => error.name === "AbortError");
  await settle();
  const fresh = { translation: "强制请求的新结果" };
  const forced = runCachedAiResult(options({ force: true, request: async () => { calls += 1; return fresh; } }));
  await settle();
  assert.equal(calls, 1);
  controller.abort();
  await cancelled;
  await settle();
  assert.equal(calls, 2, "force must start before the uncooperative old transport settles");
  assert.deepEqual((await forced).result, fresh);
  oldGate.resolve({ translation: "已取消的旧结果" });
  await settle();
  clearAiResultMemory();
  assert.deepEqual(read().result, fresh);
});

test("cancelling queued force rejects immediately without starting its network request", async () => {
  const oldGate = deferred();
  const forceController = new AbortController();
  let calls = 0, forceSettled = false;
  const normal = runCachedAiResult(options({ request: () => { calls += 1; return oldGate.promise; } }));
  await settle();
  const forced = runCachedAiResult(options({ force: true, signal: forceController.signal, request: async () => { calls += 1; return { translation: "不应请求" }; } }));
  const cancelled = assert.rejects(forced, error => { forceSettled = true; return error.name === "AbortError"; });
  await settle();
  forceController.abort();
  await settle();
  assert.equal(forceSettled, true, "queued force should reject while previous transport remains unresolved");
  assert.equal(calls, 1);
  oldGate.resolve(translation);
  await Promise.all([normal, cancelled]);
  await settle();
  assert.equal(calls, 1, "cancelled force must not start after old request completes");
  assert.deepEqual(read().result, translation);
});

test("network error is not cached and next call retries", async () => {
  await assert.rejects(runCachedAiResult(options({ request: async () => { throw new Error("network failed"); } })), /network failed/);
  assert.equal(read(), null);
  assert.equal((await runCachedAiResult(options())).source, "network");
});

test("empty and schema-invalid results are rejected without cache writes", async () => {
  for (const invalid of [null, {}, { translation: " " }]) {
    await assert.rejects(runCachedAiResult(options({ request: async () => invalid })));
    assert.equal(read(), null);
  }
});

test("force failure preserves the previous valid cache entry", async () => {
  await runCachedAiResult(options());
  await assert.rejects(runCachedAiResult(options({ force: true, request: async () => { throw new Error("failed refresh"); } })));
  assert.deepEqual(read().result, translation);
});

test("storage quota failure still returns a valid network result", async () => {
  localStorage.failWrites = true;
  try { assert.deepEqual((await runCachedAiResult(options())).result, translation); }
  finally { localStorage.failWrites = false; }
});

test("word persistent namespace is bounded and recently read entry survives LRU eviction", async () => {
  const limit = AI_RESULT_CACHE_LIMITS.wordEntries;
  const item = (index) => options({ fingerprint: `word-${index}`, identity: `word:${index}` });
  for (let index = 0; index < limit; index += 1) await runCachedAiResult(item(index));
  assert.ok(read(item(0)));
  await runCachedAiResult(item(limit));
  clearAiResultMemory();
  assert.ok(read(item(0)), "recently accessed word must survive");
  assert.equal(read(item(1)), null, "least recently used word must be evicted");
  assert.ok(read(item(limit)));
});

test("large results cannot grow persistent storage beyond global byte budget", async () => {
  const large = { translation: "译".repeat(40_000) };
  for (let index = 0; index < 40; index += 1) {
    await runCachedAiResult(options({ namespace: index % 2 ? "quick-paragraph" : "quick-sentence", fingerprint: `large-${index}`, identity: `large:${index}`, request: async () => large }));
  }
  // The budget belongs to AI result caches, not unrelated telemetry or learning data.
  // Include the cache index, legacy structured namespaces, and storage key bytes.
  const cacheRows = [...localStorage.rows].filter(([key]) => /:ai:(?:result-cache(?::|-index)|translation-review-cache|question-hint-cache|question-diagnosis-cache)/.test(key));
  assert.ok(cacheRows.length > 0, "must measure real AI cache storage");
  const bytes = cacheRows.reduce((sum, [key, value]) => sum + Buffer.byteLength(key + value), 0);
  assert.ok(bytes <= AI_RESULT_CACHE_LIMITS.persistentBytes, `AI cache and index used ${bytes} bytes`);
});

test("global byte eviction uses actual last access across namespaces, including unsorted read updates", async () => {
  const originalNow = Date.now;
  let tick = 1_000_000;
  Date.now = () => ++tick;
  const large = { translation: "x".repeat(Math.floor((AI_RESULT_CACHE_LIMITS.persistentBytes - 32 * 1024) / 3) - 2048) };
  const item = (namespace, id) => options({ namespace, fingerprint: `global-lru-${id}`, identity: `global-lru:${id}`, request: async () => large });
  const a0 = item("quick-sentence", "a0");
  const a1 = item("quick-sentence", "a1");
  const b0 = item("quick-paragraph", "b0");
  const b1 = item("quick-paragraph", "b1");
  try {
    await runCachedAiResult(a0);
    await runCachedAiResult(a1);
    await runCachedAiResult(b0);
    assert.ok(read(a0)); // Update the first element without writing its namespace.
    await runCachedAiResult(b1); // Exceeds global budget and should evict a1.
    clearAiResultMemory();
    assert.ok(read(a0), "recently read first element must not be mistaken for oldest");
    assert.equal(read(a1), null, "actual oldest entry across namespaces must be evicted");
    assert.ok(read(b0));
    assert.ok(read(b1));
  } finally { Date.now = originalNow; }
});

test("memory entry budget is shared across namespaces and promotes LRU reads", async () => {
  const namespaces = ["quick-word", "quick-phrase", "quick-sentence", "quick-paragraph"];
  const item = (index) => options({ namespace: namespaces[index % namespaces.length], fingerprint: `hot-${index}`, identity: `hot:${index}` });
  for (let index = 0; index < AI_RESULT_CACHE_LIMITS.memoryEntries; index += 1) await runCachedAiResult(item(index));
  assert.equal(read(item(0)).source, "memory");
  await runCachedAiResult(item(AI_RESULT_CACHE_LIMITS.memoryEntries));
  assert.equal(read(item(0)).source, "memory", "recently accessed result should remain hot");
  assert.equal(read(item(1)).source, "persistent", "oldest L1 result should be evicted but remain durable");
});

test("memory byte budget evicts large old results", async () => {
  const large = { translation: "x".repeat(256 * 1024) };
  const count = Math.ceil(AI_RESULT_CACHE_LIMITS.memoryBytes / Buffer.byteLength(JSON.stringify(large))) + 2;
  for (let index = 0; index < count; index += 1) {
    await runCachedAiResult(options({ fingerprint: `memory-large-${index}`, identity: `memory-large:${index}`, request: async () => large }));
  }
  const oldest = read({ fingerprint: "memory-large-0", identity: "memory-large:0" });
  assert.notEqual(oldest?.source, "memory");
  assert.equal(read({ fingerprint: `memory-large-${count - 1}`, identity: `memory-large:${count - 1}` }).source, "memory");
});

test("quick word normalization merges safe spelling variants but preserves acronym semantics", () => {
  for (const word of [" abandon ", "Abandon", "abandon", "Ａｂａｎｄｏｎ"]) {
    assert.equal(normalizeQuickTranslationInput(word, "word"), "abandon");
  }
  assert.notEqual(quickTranslationIdentity({ text: "US", kind: "word" }).fingerprint, quickTranslationIdentity({ text: "us", kind: "word" }).fingerprint);
});

test("sentence normalization preserves punctuation, negation, and sentence order", () => {
  assert.equal(normalizeQuickTranslationInput("  He\t did not\r\nleave. "), "He did not leave.");
  const identity = text => quickTranslationIdentity({ text }).fingerprint;
  assert.notEqual(identity("He did not leave."), identity("He did leave."));
  assert.notEqual(identity("He left?"), identity("He left."));
  assert.notEqual(identity("A. B."), identity("B. A."));
});

test("word identity shares compatible models while contextual and sentence results stay model isolated", () => {
  const word = { text: "bank", kind: "word" };
  assert.equal(quickTranslationIdentity({ ...word, model: "model-a" }).fingerprint, quickTranslationIdentity({ ...word, model: "model-b" }).fingerprint);
  const context = { ...word, contextSentence: "He sat on the bank of the river." };
  assert.notEqual(quickTranslationIdentity({ ...context, model: "model-a" }).fingerprint, quickTranslationIdentity({ ...context, model: "model-b" }).fingerprint);
  assert.notEqual(quickTranslationIdentity({ text: "He left.", model: "model-a" }).fingerprint, quickTranslationIdentity({ text: "He left.", model: "model-b" }).fingerprint);
});

test("context, prompt version, task namespace and provider each isolate incompatible translations", () => {
  const base = { text: "bank", kind: "word", model: "model-a" };
  const standalone = quickTranslationIdentity(base);
  const river = quickTranslationIdentity({ ...base, contextSentence: "He sat on the bank of the river." });
  const financial = quickTranslationIdentity({ ...base, contextSentence: "She opened a bank account." });
  assert.equal(standalone.namespace, "quick-word");
  assert.equal(river.namespace, "context-word");
  assert.equal(new Set([standalone.fingerprint, river.fingerprint, financial.fingerprint]).size, 3);
  assert.notEqual(quickTranslationIdentity({ ...base, promptVersion: 3 }).fingerprint, quickTranslationIdentity({ ...base, promptVersion: 4 }).fingerprint);
  assert.notEqual(quickTranslationIdentity({ text: "in fact", kind: "phrase" }).fingerprint, quickTranslationIdentity({ text: "in fact", kind: "sentence" }).fingerprint);
  const context = { ...base, contextSentence: "She opened a bank account." };
  saveProviderProfile({ modality: "text", providerId: "custom", endpointKind: "custom", baseUrl: "https://one.example/v1", modelId: "model-a" });
  const first = quickTranslationIdentity(context);
  saveProviderProfile({ modality: "text", providerId: "custom", endpointKind: "custom", baseUrl: "https://two.example/v1", modelId: "model-a" });
  assert.notEqual(first.fingerprint, quickTranslationIdentity(context).fingerprint);
});

test("fingerprint SHA-256 agrees with Node for Unicode and multi-block inputs", () => {
  for (const input of ["", "abandon", "银行；河岸", "He did not leave.\n".repeat(300)]) {
    assert.equal(sha256AiInput(input), createHash("sha256").update(input).digest("hex"));
  }
  assert.equal(stableAiIdentity({ b: 2, a: ["x", "y"] }), stableAiIdentity({ a: ["x", "y"], b: 2 }));
  assert.notEqual(stableAiIdentity(["x", "y"]), stableAiIdentity(["y", "x"]));
});

test("quick word static dictionary hit needs no API key, provider call, or fake loading", async () => {
  let lookups = 0;
  const result = await runQuickTranslation({
    text: " Abandon ", kind: "word", dictionary: async word => { lookups += 1; assert.equal(word, "abandon"); return "放弃"; },
    onNetworkStart: () => assert.fail("dictionary hit must not show network loading"),
  });
  assert.equal(lookups, 1);
  assert.equal(result.source, "dictionary");
  assert.deepEqual(result.result, { translation: "放弃" });
});

test("quick word dictionary miss uses exactly one HTTP across normalized repeats and restart; force requests again", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0, loading = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ choices: [{ message: { content: calls === 1 ? "放弃" : "舍弃" } }] }) };
  };
  const args = { text: "abandon", kind: "word", model: "deepseek-chat", apiKey: "test-key", dictionary: async () => "", onNetworkStart: () => { loading += 1; } };
  try {
    assert.equal((await runQuickTranslation(args)).source, "network");
    assert.equal((await runQuickTranslation({ ...args, text: " Abandon " })).source, "memory");
    clearAiResultMemory();
    assert.equal((await runQuickTranslation(args)).source, "persistent");
    assert.equal(calls, 1);
    assert.equal(loading, 1);
    const forced = await runQuickTranslation({ ...args, force: true });
    assert.deepEqual(forced.result, { translation: "舍弃" });
    assert.equal(calls, 2);
    assert.equal(loading, 2);
  } finally { globalThis.fetch = originalFetch; }
});
