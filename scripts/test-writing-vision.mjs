import test from "node:test";
import assert from "node:assert/strict";
import { AI_API_CONFIG_STORAGE_KEY, AI_MODEL_STORAGE_KEY, getAiApiConfig, getAiApiKey, getPreferredAiModel, setAiApiConfig, setAiApiKey, setPreferredAiModel } from "../src/ai.js";
import { setCurrentUsername } from "../src/userData.js";
import { WritingAiSchemaError, validateVisionPageTranscript } from "../src/writing/writingAiSchemas.js";
import { WRITING_VISION_PROBE_CACHE_KEY, getWritingVisionApiKey, getWritingVisionConfig, getWritingVisionModel, getWritingVisionProbeCache, setWritingVisionApiKey, setWritingVisionConfig, setWritingVisionModel, setWritingVisionProbeCache, writingVisionProbeIdentity } from "../src/writing/writingVisionConfig.js";
import { createOpenAiCompatibleVisionProvider } from "../src/writing/writingVisionProvider.js";
import { WritingVisionRenderError, WRITING_VISION_RENDER_HEIGHT, WRITING_VISION_RENDER_WIDTH, buildWritingVisionRenderPlan, stableWritingInkPageOrder } from "../src/writing/writingVisionRenderer.js";
import { WritingVisionAdapterError, transcribeWritingInkSnapshot } from "../src/writing/writingVisionAdapter.js";

function memoryStorage() { const rows = new Map(); return { get length() { return rows.size; }, clear: () => rows.clear(), getItem: (key) => rows.has(String(key)) ? rows.get(String(key)) : null, key: (index) => [...rows.keys()][index] ?? null, removeItem: (key) => rows.delete(String(key)), setItem: (key, value) => rows.set(String(key), String(value)) }; }
globalThis.localStorage = memoryStorage();
globalThis.window = { ...(globalThis.window || {}), localStorage: globalThis.localStorage };

function stroke(pageId, x, y) { return { coordinateSpace: "writing-page-v1", writingAnchor: { version: 1, pageId }, tool: "pen", points: [{ writingLocal: { x, y } }] }; }
const snapshot = { strokes: [stroke("page-1", 0.25, 0.4), stroke("page-2", 0.25, 0.4)] };
function page(pageId, text = `text-${pageId}`, confidence = null, unsure = false, extras = {}) { return { pageId, text, segments: [{ text, confidence, unsure }], ...extras }; }
function response(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function providerWithFetch(fetchFn, options = {}) { return createOpenAiCompatibleVisionProvider({ fetchFn, ...options }); }

test("Frozen PageTranscript accepts confidence boundaries/null and preserves verbatim text", () => {
  for (const confidence of [0, 1, null]) {
    const result = validateVisionPageTranscript(page("page-1", " I has a apple. ", confidence, confidence === null), { pageId: "page-1" });
    assert.equal(result.text, " I has a apple. "); assert.equal(result.segments[0].confidence, confidence); assert.equal(typeof result.segments[0].unsure, "boolean");
  }
});

test("Frozen PageTranscript rejects invalid confidence, missing unsure, page mismatch, and invalid segments", () => {
  for (const confidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => validateVisionPageTranscript(page("page-1", "x", confidence), { pageId: "page-1" }), WritingAiSchemaError);
  assert.throws(() => validateVisionPageTranscript({ pageId: "page-1", text: "x", segments: [{ text: "x", confidence: null }] }, { pageId: "page-1" }), WritingAiSchemaError);
  assert.throws(() => validateVisionPageTranscript(page("wrong"), { pageId: "page-1" }), WritingAiSchemaError);
  assert.throws(() => validateVisionPageTranscript({ pageId: "page-1", text: "x" }, { pageId: "page-1" }), WritingAiSchemaError);
  assert.throws(() => validateVisionPageTranscript({ pageId: "page-1", text: "x", segments: {} }, { pageId: "page-1" }), WritingAiSchemaError);
});

test("PageTranscript discards scoring, rewrite, advice, and unknown provider fields", () => {
  const result = validateVisionPageTranscript(page("page-1", "raw", null, false, { score: 20, band: 5, rewrite: "fixed", advice: ["polish"], correctedText: "fixed", futureField: true }), { pageId: "page-1" });
  assert.deepEqual(Object.keys(result).sort(), ["pageId", "segments", "text"]); assert.deepEqual(Object.keys(result.segments[0]).sort(), ["confidence", "text", "unsure"]);
});

test("Vision renderer uses stable page-local A4 canonical geometry and white background", () => {
  const plan = buildWritingVisionRenderPlan(snapshot, "page-1");
  assert.equal(plan.width, 1600); assert.equal(plan.height, Math.round(1600 * Math.sqrt(2))); assert.equal(plan.background, "white"); assert.equal(plan.renderVersion, "writing-vision-render-v1");
  assert.deepEqual(plan.strokes[0].points[0], { x: WRITING_VISION_RENDER_WIDTH * 0.25, y: WRITING_VISION_RENDER_HEIGHT * 0.4 });
  assert.equal(buildWritingVisionRenderPlan({ strokes: [...snapshot.strokes, stroke("page-3", 0.1, 0.2)] }, "page-1").strokes[0].points[0].y, plan.strokes[0].points[0].y);
});

test("Vision renderer derives deterministic logical page order independent of stroke arrival", () => {
  assert.deepEqual(stableWritingInkPageOrder({ strokes: [stroke("page-10", 0.1, 0.1), stroke("page-2", 0.1, 0.1), stroke("page-1", 0.1, 0.1)] }), ["page-1", "page-2", "page-10"]);
  assert.deepEqual(stableWritingInkPageOrder({ pageOrder: ["page-2", "page-1"], strokes: snapshot.strokes }), ["page-2", "page-1"]);
});

test("Vision renderer fails closed on every non-canonical stroke", () => {
  const invalid = { tool: "pen", points: [{ x: 2, y: 3 }] };
  assert.throws(() => stableWritingInkPageOrder({ strokes: [snapshot.strokes[0], invalid] }), (error) => error instanceof WritingVisionRenderError && error.code === "VISION_RENDER_ERROR");
  assert.throws(() => buildWritingVisionRenderPlan({ strokes: [snapshot.strokes[0], stroke("page-2", 1.1, 0.2)] }, "page-1"), WritingVisionRenderError);
});

test("Vision adapter refuses partial formal transcription, preserves order, and records versions", async () => {
  const rendered = async (_snapshot, pageId) => ({ pageId, imageBlob: new Blob([pageId], { type: "image/png" }) });
  const provider = { transcribePage: async ({ pageId }) => page(pageId, `text-${pageId}`, 0.9, false, { score: 20, rewrittenEssay: "ignored" }) };
  const result = await transcribeWritingInkSnapshot({ snapshot, provider, config: {}, apiKey: "fixture", modelId: "vision", renderPage: rendered });
  assert.deepEqual(result.pageOrder, ["page-1", "page-2"]); assert.equal(result.rawTranscript, "text-page-1\n\ntext-page-2"); assert.equal(result.promptVersion, "writing-transcription-v1"); assert.equal(result.adapterVersion, "writing-vision-openai-v1"); assert.equal(result.renderVersion, "writing-vision-render-v1");
  await assert.rejects(() => transcribeWritingInkSnapshot({ snapshot, provider: { transcribePage: async ({ pageId }) => { if (pageId === "page-2") throw Object.assign(new Error("failed"), { category: "network_error" }); return page(pageId, "ok"); } }, config: {}, apiKey: "", modelId: "vision", renderPage: rendered }), (error) => error instanceof WritingVisionAdapterError && error.code === "network_error");
});

test("Vision adapter rejects duplicate/blank caller pageOrder", async () => {
  const provider = { transcribePage: async ({ pageId }) => page(pageId) };
  await assert.rejects(() => transcribeWritingInkSnapshot({ snapshot, provider, pageOrder: ["page-1", "page-1"] }), (error) => error.code === "invalid_page_order");
  await assert.rejects(() => transcribeWritingInkSnapshot({ snapshot, provider, pageOrder: [""] }), (error) => error.code === "invalid_page_order");
});

test("Provider sends only model, verbatim prompt, pageId, and in-memory image", async () => {
  let payload;
  const provider = providerWithFetch(async (_url, init) => { payload = JSON.parse(init.body); return response(200, { choices: [{ message: { content: JSON.stringify(page("page-1", "I has a apple.")) } }] }); });
  const result = await provider.transcribePage({ config: { baseUrl: "https://vision.example/v1" }, apiKey: "secret-fixture", modelId: "vision-1", imageBlob: new Blob(["png"], { type: "image/png" }), pageId: "page-1" });
  assert.equal(result.text, "I has a apple."); const serialized = JSON.stringify(payload); const prompt = payload.messages[0].content.toLowerCase();
  for (const phrase of ["preserve exactly", "spelling", "capitalization", "punctuation", "grammatical errors", "do not correct", "do not rewrite", "confidence", "unsure"]) assert.ok(prompt.includes(phrase));
  for (const forbidden of ["sampleEssay", "translation", "skeleton", "diagnosis", "rubric", "revisionAdvice", "referenceRewrite", "verifiedText", "genericAiHistory", "secret-fixture"]) assert.equal(serialized.includes(forbidden), false);
  assert.ok(serialized.includes("page-1")); assert.ok(serialized.includes("data:image/png;base64,"));
});

test("Provider error taxonomy keeps auth/rate/provider/unsupported/network distinct", async () => {
  const cases = [[401, "bad key", "auth_error"], [403, "forbidden", "auth_error"], [429, "limited", "rate_limit"], [500, "server", "provider_error"], [503, "server", "provider_error"], [400, "model does not support image input", "unsupported"]];
  for (const [status, message, expected] of cases) { const provider = providerWithFetch(async () => response(status, { error: { message } })); await assert.rejects(() => provider.transcribePage({ config: { baseUrl: "https://vision.example/v1" }, apiKey: "x", modelId: "m", imageBlob: new Blob(["x"]), pageId: "p" }), (error) => error.category === expected); }
  const network = providerWithFetch(async () => { throw new TypeError("offline"); }); await assert.rejects(() => network.transcribePage({ config: { baseUrl: "https://vision.example/v1" }, apiKey: "x", modelId: "m", imageBlob: new Blob(["x"]), pageId: "p" }), (error) => error.category === "network_error");
});

test("Provider distinguishes external abort from internal timeout", async () => {
  const pendingFetch = (_url, { signal }) => new Promise((_resolve, reject) => { if (signal.aborted) reject(new DOMException("aborted", "AbortError")); else signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }); });
  const timed = providerWithFetch(pendingFetch, { timeoutMs: 1 }); await assert.rejects(() => timed.transcribePage({ config: { baseUrl: "https://vision.example/v1" }, apiKey: "x", modelId: "m", imageBlob: new Blob(["x"]), pageId: "p" }), (error) => error.category === "timeout");
  const controller = new AbortController(); const aborted = providerWithFetch(pendingFetch, { timeoutMs: 1000 }); const request = aborted.transcribePage({ config: { baseUrl: "https://vision.example/v1" }, apiKey: "x", modelId: "m", imageBlob: new Blob(["x"]), pageId: "p", signal: controller.signal }); controller.abort(); await assert.rejects(() => request, (error) => error.category === "abort");
});

test("WL7 probe requires exact normalized token and preserves failure taxonomy", async () => {
  for (const [content, expected] of [["WL7", "supported"], ["ABC", "invalid_response"], ["`WL7`", "supported"]]) { const provider = providerWithFetch(async () => response(200, { choices: [{ message: { content } }] })); assert.equal((await provider.probe({ config: { baseUrl: "https://vision.example/v1" }, apiKey: "x", modelId: "m", imageBlob: new Blob(["x"]) })).status, expected); }
  const limited = providerWithFetch(async () => response(429, { error: { message: "limited" } })); assert.equal((await limited.probe({ config: { baseUrl: "https://vision.example/v1" }, apiKey: "x", modelId: "m", imageBlob: new Blob(["x"]) })).status, "rate_limit");
});

test("Model listing exposes ids only and never guesses image capability from names", async () => {
  const provider = providerWithFetch(async () => response(200, { data: [{ id: "plain-chat" }, { id: "looks-like-vision" }] }));
  const models = await provider.listModels({ config: { baseUrl: "https://vision.example/v1" }, apiKey: "x" }); assert.deepEqual(models, ["plain-chat", "looks-like-vision"]); assert.equal(models.some((item) => typeof item === "object" && "supported" in item), false);
});

test("Vision config/model/key are account-scoped and isolated from Text AI", async () => {
  localStorage.clear(); setCurrentUsername("alice"); setAiApiConfig({ baseUrl: "https://text.example/v1" }); setPreferredAiModel("text-model"); await setAiApiKey("text-key"); setWritingVisionConfig({ baseUrl: "https://vision.example/v1" }); setWritingVisionModel("vision-model"); await setWritingVisionApiKey("vision-key");
  assert.equal(getAiApiConfig().baseUrl, "https://text.example/v1"); assert.equal(getPreferredAiModel(), "text-model"); assert.equal(await getAiApiKey(), "text-key"); assert.equal(getWritingVisionConfig().baseUrl, "https://vision.example/v1"); assert.equal(getWritingVisionModel(), "vision-model"); assert.equal(await getWritingVisionApiKey(), "vision-key");
  assert.notEqual(AI_API_CONFIG_STORAGE_KEY, "wuliao:writing:vision-api-config:v1"); assert.notEqual(AI_MODEL_STORAGE_KEY, "wuliao:writing:vision-model:v1"); setAiApiConfig({ baseUrl: "https://text-2.example/v1" }); setPreferredAiModel("text-model-2"); assert.equal(getWritingVisionConfig().baseUrl, "https://vision.example/v1"); assert.equal(getWritingVisionModel(), "vision-model"); setCurrentUsername("bob"); assert.equal(await getWritingVisionApiKey(), ""); assert.equal(getWritingVisionModel(), "");
});

test("Vision AndroidSecureStore key is separately namespaced and user-scoped", async () => {
  const rows = new Map(); const secureStore = { get: async (key) => rows.get(key) || "", set: async (key, value) => rows.set(key, value), remove: async (key) => rows.delete(key) };
  await setWritingVisionApiKey("alice-vision", { username: "alice", secureStore }); await setWritingVisionApiKey("bob-vision", { username: "bob", secureStore });
  assert.equal(rows.get("ai:vision-apikey:alice"), "alice-vision"); assert.equal(rows.get("ai:vision-apikey:bob"), "bob-vision"); assert.equal(rows.has("ai:apikey:alice"), false); assert.equal(await getWritingVisionApiKey({ username: "alice", secureStore }), "alice-vision");
});

test("Vision probe cache identity invalidates on model/base/adapter/key changes", async () => {
  localStorage.clear(); setCurrentUsername("alice"); const a = setWritingVisionConfig({ baseUrl: "https://vision-a.example/v1" }); setWritingVisionModel("model-a"); setWritingVisionProbeCache({ status: "supported" }, a, "model-a");
  assert.equal(getWritingVisionProbeCache(a, "model-a").status, "supported"); assert.equal(getWritingVisionProbeCache(a, "model-b"), null); const b = setWritingVisionConfig({ baseUrl: "https://vision-b.example/v1" }); assert.equal(getWritingVisionProbeCache(b, "model-a"), null); assert.notEqual(writingVisionProbeIdentity(a, "model-a"), JSON.stringify({ providerKind: a.providerKind, baseUrl: a.baseUrl, modelId: "model-a", adapterVersion: "different" })); setWritingVisionProbeCache({ status: "supported" }, b, "model-a"); await setWritingVisionApiKey("new-key"); assert.equal(getWritingVisionProbeCache(b, "model-a"), null); assert.equal(localStorage.getItem(WRITING_VISION_PROBE_CACHE_KEY), null);
});
