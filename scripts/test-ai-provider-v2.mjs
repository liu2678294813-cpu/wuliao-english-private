import test from "node:test";
import assert from "node:assert/strict";

class MemoryStorage {
  constructor() { this.rows = new Map(); }
  get length() { return this.rows.size; }
  clear() { this.rows.clear(); }
  getItem(key) { return this.rows.has(String(key)) ? this.rows.get(String(key)) : null; }
  key(index) { return [...this.rows.keys()][index] ?? null; }
  removeItem(key) { this.rows.delete(String(key)); }
  setItem(key, value) { this.rows.set(String(key), String(value)); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.window = { localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { getUserItem, setCurrentUsername, setUserItem } = await import("../src/userData.js");
const {
  AI_PROVIDERS,
  ALIBABA_REGIONS,
  TRANSPORT_KINDS,
  bindCredential,
  callAi,
  createCredentialScope,
  credentialBindingStatus,
  getCredential,
  getProviderProfile,
  normalizeProviderEndpoint,
  normalizeProviderModels,
  normalizeProviderProfile,
  rebindCredential,
  resolveModelTransport,
  textAiCacheIdentity,
} = await import("../src/aiProvider.js");

function reset() { localStorage.clear(); setCurrentUsername("provider-v2-user"); delete window.AndroidSecureStore; }
function custom(modality, baseUrl) {
  return normalizeProviderProfile({ version: 2, modality, providerId: "custom", endpointKind: "custom", baseUrl, modelId: "model-a" });
}

test("registry includes the frozen provider set and all current Alibaba regions", () => {
  assert.deepEqual(AI_PROVIDERS.map((item) => item.id), ["deepseek", "gemini", "alibaba", "glm", "kimi", "openai", "opencode-zen", "openrouter", "custom"]);
  assert.deepEqual(ALIBABA_REGIONS.map((item) => item.id), ["cn-beijing", "ap-southeast-1", "us-east-1", "cn-hongkong", "ap-northeast-1", "eu-central-1"]);
  const dedicated = normalizeProviderProfile({ modality: "text", providerId: "alibaba", endpointKind: "workspace-dedicated", region: "eu-central-1", workspaceId: "workspace_42", modelId: "qwen-plus" });
  assert.equal(dedicated.baseUrl, "https://workspace_42.eu-central-1.maas.aliyuncs.com/compatible-mode/v1");
  assert.throws(() => normalizeProviderProfile({ modality: "text", providerId: "alibaba", endpointKind: "shared", region: "eu-central-1" }), (error) => error.code === "endpoint_unavailable");
  assert.equal(normalizeProviderProfile({ modality: "text", providerId: "alibaba", endpointKind: "shared", region: "us-east-1" }).baseUrl, "https://dashscope-us.aliyuncs.com/compatible-mode/v1");
  assert.throws(() => normalizeProviderProfile({ modality: "text", providerId: "alibaba", endpointKind: "trial", region: "us-east-1" }), (error) => error.code === "endpoint_unavailable");
});

test("endpoint parser rejects dangerous/insecure/pseudo-local URLs and permits explicit loopback development", () => {
  for (const value of ["file:///tmp/key", "data:text/plain,x", "javascript:alert(1)", "http://api.example.com/v1", "http://localhost.example.com/v1", "https://u:p@example.com/v1"]) {
    assert.throws(() => normalizeProviderEndpoint(value, { allowLocalDevelopment: true }));
  }
  assert.equal(normalizeProviderEndpoint("http://127.0.0.1:9090/v1/chat/completions", { allowLocalDevelopment: true }).baseUrl, "http://127.0.0.1:9090/v1");
  assert.throws(() => normalizeProviderEndpoint("http://127.0.0.1:9090/v1", { allowLocalDevelopment: false }), (error) => error.code === "insecure_endpoint");
});

test("credential scope changes with Custom origin/path and Alibaba region/workspace/endpoint kind", () => {
  const a = custom("text", "https://one.example/v1");
  const b = custom("text", "https://two.example/v1");
  const c = custom("text", "https://one.example/openai/v1");
  assert.notEqual(a.credentialScopeId, b.credentialScopeId);
  assert.notEqual(a.credentialScopeId, c.credentialScopeId);
  assert.equal(credentialBindingStatus(a, b), "unbound");
  const qwenA = normalizeProviderProfile({ modality: "text", providerId: "alibaba", endpointKind: "workspace-dedicated", region: "cn-beijing", workspaceId: "alpha", modelId: "qwen-plus" });
  const qwenB = normalizeProviderProfile({ ...qwenA, region: "ap-southeast-1" });
  const qwenC = normalizeProviderProfile({ ...qwenA, workspaceId: "beta" });
  assert.notDeepEqual(createCredentialScope(qwenA), createCredentialScope(qwenB));
  assert.notEqual(qwenA.credentialScopeId, qwenC.credentialScopeId);
});

test("Web credentials are account/scope isolated and cross-endpoint reuse requires explicit confirmation", async () => {
  reset();
  const a = custom("text", "https://one.example/v1");
  const b = custom("text", "https://two.example/v1");
  await bindCredential(a, "scope-a-key");
  assert.equal((await getCredential(a)).value, "scope-a-key");
  assert.equal((await getCredential(b, { migrateLegacy: false })).status, "missing");
  await assert.rejects(() => rebindCredential(a, b), (error) => error.code === "credential_unbound");
  await rebindCredential(a, b, { confirm: true });
  assert.equal((await getCredential(b, { migrateLegacy: false })).value, "scope-a-key");
});

test("Android legacy migration deletes plaintext only after native read-back verification", async () => {
  reset();
  const profile = normalizeProviderProfile({ modality: "text", providerId: "deepseek", endpointKind: "official", modelId: "deepseek-chat" });
  setUserItem("wuliao:ai:apikey", "legacy-key");
  const broken = { get: async () => "", set: async () => {}, remove: async () => {} };
  await assert.rejects(() => getCredential(profile, { secureStore: broken }), (error) => error.code === "secure_storage_error");
  assert.equal(getUserItem("wuliao:ai:apikey"), "legacy-key");
  const rows = new Map();
  const working = { get: async (key) => rows.get(key) || "", set: async (key, value) => rows.set(key, value), remove: async (key) => rows.delete(key) };
  assert.equal((await getCredential(profile, { secureStore: working })).value, "legacy-key");
  assert.equal(getUserItem("wuliao:ai:apikey"), null);
});

test("Android native Vision credential migrates only to its existing endpoint and retains rollback copy", async () => {
  reset();
  setUserItem("wuliao:writing:vision-api-config:v1", JSON.stringify({ baseUrl: "https://vision.example/v1" }));
  setUserItem("wuliao:writing:vision-model:v1", "legacy-vision");
  const oldKey = "ai:vision-apikey:provider-v2-user", rows = new Map([[oldKey, "legacy-native-vision"]]);
  const reads = [], secureStore = { get: async key => { reads.push(key); return rows.get(key) || ""; }, set: async (key, value) => rows.set(key, value), remove: async key => rows.delete(key) };
  assert.equal((await getCredential(custom("vision", "https://other.example/v1"), { secureStore })).status, "missing");
  assert.equal(reads.includes(oldKey), false);
  assert.equal((await getCredential(custom("vision", "https://vision.example/v1"), { secureStore, migrateLegacy: false })).status, "missing");
  assert.equal(reads.includes(oldKey), false);
  const profile = custom("vision", "https://vision.example/v1");
  assert.equal((await getCredential(profile, { secureStore })).value, "legacy-native-vision");
  assert.equal(rows.get(oldKey), "legacy-native-vision");
  const newKey = `ai:credential:v2:provider-v2-user:${profile.credentialScopeId}`;
  assert.equal(rows.get(newKey), "legacy-native-vision");
  rows.set(newKey, "newer-key");
  assert.equal((await getCredential(profile, { secureStore })).value, "newer-key");
  rows.delete(newKey);
  await assert.rejects(() => getCredential(profile, { secureStore: { get: secureStore.get, set: async () => {} } }), error => error.code === "secure_storage_error");
  assert.equal(rows.get(oldKey), "legacy-native-vision");
  await bindCredential(profile, "", { secureStore });
  assert.equal((await getCredential(profile, { secureStore })).status, "missing");
});

test("Android native Text credential migrates with verified scope and keeps its rollback copy", async () => {
  reset();
  const profile = getProviderProfile("text");
  const oldKey = "ai:apikey:provider-v2-user", rows = new Map([[oldKey, "legacy-native-text"]]);
  const reads = [], secureStore = { get: async key => { reads.push(key); return rows.get(key) || ""; }, set: async (key, value) => rows.set(key, value), remove: async key => rows.delete(key) };
  const other = custom("text", "https://other.example/v1");
  assert.equal((await getCredential(other, { secureStore })).status, "missing");
  assert.equal(reads.includes(oldKey), false);
  assert.equal((await getCredential(profile, { secureStore, migrateLegacy: false })).status, "missing");
  assert.equal(reads.includes(oldKey), false);
  await bindCredential(other, "", { secureStore });
  assert.equal(rows.get(oldKey), "legacy-native-text");
  assert.equal((await getCredential(profile, { secureStore, username: "another-user" })).status, "missing");
  assert.equal(reads.includes(oldKey), false);
  assert.equal((await getCredential(profile, { secureStore })).value, "legacy-native-text");
  const newKey = `ai:credential:v2:provider-v2-user:${profile.credentialScopeId}`;
  assert.equal(rows.get(newKey), "legacy-native-text");
  assert.equal(rows.get(oldKey), "legacy-native-text");
  rows.set(newKey, "newer-text-key");
  assert.equal((await getCredential(profile, { secureStore })).value, "newer-text-key");
  rows.delete(newKey);
  await assert.rejects(() => getCredential(profile, { secureStore: { get: secureStore.get, set: async () => {} } }), error => error.code === "secure_storage_error");
  assert.equal(rows.get(oldKey), "legacy-native-text");
  await bindCredential(profile, "", { secureStore });
  assert.equal(rows.has(oldKey), false);
  assert.equal((await getCredential(profile, { secureStore })).status, "missing");
});

test("legacy native migration checks the requested account configuration and URL-encodes its key", async () => {
  reset();
  const username = "另一账号: /";
  setUserItem("wuliao:ai:api-config", JSON.stringify({ baseUrl: "https://account-b.example/v1" }), username);
  const oldKey = `ai:apikey:${encodeURIComponent(username)}`, rows = new Map([[oldKey, "account-b-text-key"]]);
  const reads = [], secureStore = { get: async key => { reads.push(key); return rows.get(key) || ""; }, set: async (key, value) => rows.set(key, value), remove: async key => rows.delete(key) };
  assert.equal((await getCredential(getProviderProfile("text"), { secureStore, username })).status, "missing");
  assert.equal(reads.includes(oldKey), false);
  const profile = normalizeProviderProfile({ modality: "text", providerId: "deepseek", endpointKind: "custom", baseUrl: "https://account-b.example/v1", modelId: "deepseek-chat" });
  assert.equal((await getCredential(profile, { secureStore, username })).value, "account-b-text-key");
  assert.equal(rows.get(oldKey), "account-b-text-key");
  await bindCredential(profile, "", { secureStore, username });
  assert.equal(rows.has(oldKey), false);
});

test("legacy plaintext is never migrated to a different provider endpoint", async () => {
  reset();
  setUserItem("wuliao:ai:api-config", JSON.stringify({ version: 1, baseUrl: "https://api.deepseek.com" }));
  setUserItem("wuliao:ai:apikey", "deepseek-only-key");
  const other = custom("text", "https://other-provider.example/v1");
  const credential = await getCredential(other);
  assert.equal(credential.status, "missing");
  assert.equal(credential.value, "");
  assert.equal(getUserItem("wuliao:ai:apikey"), "deepseek-only-key");
});

test("legacy Text profile is lazily and additively mapped to DeepSeek-compatible v2", () => {
  reset();
  setUserItem("wuliao:ai:api-config", JSON.stringify({ version: 1, baseUrl: "https://api.deepseek.com" }));
  setUserItem("wuliao:ai:model", "deepseek-reasoner");
  const profile = getProviderProfile("text");
  assert.equal(profile.version, 2);
  assert.equal(profile.providerId, "deepseek");
  assert.equal(profile.modelId, "deepseek-reasoner");
  assert.ok(getUserItem("wuliao:ai:api-config"));
  assert.ok(getUserItem("wuliao:ai:model"));
});

test("OpenCode catalog preserves model transport and blocks unimplemented protocols", () => {
  reset();
  const profile = normalizeProviderProfile({ modality: "text", providerId: "opencode-zen", endpointKind: "official", modelId: "response-model" });
  const models = normalizeProviderModels([
    { id: "response-model", endpoint: "/responses" },
    { id: "chat-model", endpoint: "/chat/completions" },
    { id: "claude-model", endpoint: "/messages" },
    { id: "gemini-model", provider: { npm: "@ai-sdk/google" } },
  ], profile);
  assert.deepEqual(models.map((item) => item.transportKind), [TRANSPORT_KINDS.RESPONSES, TRANSPORT_KINDS.CHAT, TRANSPORT_KINDS.MESSAGES, TRANSPORT_KINDS.GEMINI]);
  assert.deepEqual(models.map((item) => item.textStatus), ["probe_required", "probe_required", "unsupported_protocol", "unsupported_protocol"]);
  assert.throws(() => resolveModelTransport("claude-model", { ...profile, transportOverride: TRANSPORT_KINDS.MESSAGES }), (error) => error.code === "unsupported_protocol");
  const currentCatalogFallback = normalizeProviderModels([
    { id: "gpt-5.6-sol" },
    { id: "claude-sonnet-5" },
    { id: "gemini-3.8-flash" },
    { id: "deepseek-v4-pro" },
    { id: "unknown-future-protocol" },
  ], profile);
  assert.deepEqual(currentCatalogFallback.map((item) => item.transportKind), [
    TRANSPORT_KINDS.RESPONSES,
    TRANSPORT_KINDS.MESSAGES,
    TRANSPORT_KINDS.GEMINI,
    TRANSPORT_KINDS.CHAT,
    "unknown",
  ]);
  assert.equal(currentCatalogFallback.at(-1).textStatus, "unsupported_protocol");
});

test("fetch TypeError is runtime compatibility, never auth or model unsupported", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  try {
    const profile = custom("text", "https://cors-blocked.example/v1");
    await assert.rejects(() => callAi({ profile, apiKey: "fixture", messages: [{ role: "user", content: "x" }] }), (error) => error.code === "runtime_network_compatibility");
  } finally { globalThis.fetch = originalFetch; }
});

test("explicit null omits temperature for both transports and keeps its cache identity separate", async () => {
  reset();
  const originalFetch = globalThis.fetch, bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: "OK" } }], output_text: "OK" }) };
  };
  try {
    for (const transportOverride of [TRANSPORT_KINDS.CHAT, TRANSPORT_KINDS.RESPONSES]) {
      const profile = { ...custom("text", "https://temperature.example/v1"), transportOverride };
      const options = { profile, apiKey: "fixture", messages: [{ role: "user", content: "x" }] };
      await callAi({ ...options, temperature: null }); assert.equal("temperature" in bodies.at(-1), false);
      await callAi(options); assert.equal(bodies.at(-1).temperature, 0.6);
      await callAi({ ...options, temperature: 0 }); assert.equal(bodies.at(-1).temperature, 0);
      assert.notEqual(textAiCacheIdentity({ ...options, temperature: null }).fingerprint, textAiCacheIdentity(options).fingerprint);
    }
  } finally { globalThis.fetch = originalFetch; }
});
