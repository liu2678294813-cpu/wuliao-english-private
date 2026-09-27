import test from "node:test";
import assert from "node:assert/strict";
class MemoryStorage {
  map = new Map();
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent = class { constructor() {} };
const { setCurrentUsername } = await import("../src/userData.js");
const { fetchProviderModels, getCachedProviderModels, normalizeProviderProfile, getBuiltinProviderModels, saveProviderProfile, callAi } = await import("../src/aiProvider.js");
setCurrentUsername("catalog-test");
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const profile = (providerId) => normalizeProviderProfile({ providerId, modality: "text", endpointKind: providerId === "alibaba" ? "shared" : "official", region: providerId === "alibaba" ? "ap-southeast-1" : undefined });

test("all six providers list models with the correct URL/auth and keep selected model", async () => {
  for (const id of ["deepseek", "gemini", "alibaba", "glm", "kimi", "openai"]) {
    const p = profile(id);
    saveProviderProfile(p);
    globalThis.fetch = async (url, options) => {
      const endpoint = new URL(url);
      if (id === "gemini") {
        assert.equal(endpoint.pathname, "/v1beta/models");
        assert.equal(options.headers["x-goog-api-key"], "fixture");
        assert.equal(endpoint.searchParams.has("key"), false);
        return response({ models: [{ name: "models/future-gemini", displayName: "Future", supportedGenerationMethods: ["generateContent"] }] });
      }
      assert.equal(options.headers.Authorization, "Bearer fixture");
      if (id === "alibaba") {
        assert.equal(endpoint.pathname, "/api/v1/models");
        return response({ output: { models: [{ model: "future-qwen", name: "千问候选" }], total: 1 } });
      }
      assert.equal(endpoint.pathname.endsWith("/models"), true);
      return response({ data: [{ id: `future-${id}` }] });
    };
    const catalog = await fetchProviderModels(p, { apiKey: "fixture" });
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].id.startsWith("future-"), true);
    assert.equal(catalog.models[0].textStatus, "probe_required");
  }
});
test("Gemini pagination strips only models/ prefix and caches all pages", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (calls === 1) return response({ models: [{ name: "models/model-a" }], nextPageToken: "next" });
    assert.equal(new URL(url).searchParams.get("pageToken"), "next");
    return response({ models: [{ name: "models/model-b" }] });
  };
  const result = await fetchProviderModels(profile("gemini"), { apiKey: "fixture" });
  assert.deepEqual(result.models.map((m) => m.id), ["model-a", "model-b"]);
});
test("Alibaba pagination uses total and model ID rather than display name", async () => {
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("page_no"));
    return response({ output: { total: 2, models: [{ model: `qwen-${page}`, name: `显示名称${page}` }] } });
  };
  const result = await fetchProviderModels(profile("alibaba"), { apiKey: "fixture" });
  assert.deepEqual(result.models.map((m) => m.id), ["qwen-1", "qwen-2"]);
});
test("catalog errors and cancellation preserve last good cache", async () => {
  const p = profile("gemini");
  const before = getCachedProviderModels(p);
  for (const [status, code] of [[401, "auth_error"], [404, "catalog_unavailable"], [429, "rate_limit"]]) {
    globalThis.fetch = async () => response({}, status);
    await assert.rejects(fetchProviderModels(p, { apiKey: "fixture" }), (error) => error.code === code);
  }
  const controller = new AbortController();
  globalThis.fetch = async () => { controller.abort(); return response({ models: [{ name: "models/stale" }] }); };
  await assert.rejects(fetchProviderModels(p, { apiKey: "fixture", signal: controller.signal }), (error) => error.code === "cancelled");
  assert.deepEqual(getCachedProviderModels(p), before);
  assert.ok(getBuiltinProviderModels(profile("glm")).length > 5);
});
test("manual model is sent unchanged through the selected provider", async () => {
  const p = { ...profile("deepseek"), modelId: "manually-entered-future-model" };
  saveProviderProfile(p);
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).model, p.modelId);
    return response({ choices: [{ message: { content: "fixture answer" } }] });
  };
  await callAi({ apiKey: "fixture", messages: [{ role: "user", content: "fixture" }] });
});
