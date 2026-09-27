import { getCurrentUsername, getUserItem, removeUserItem, setUserItem } from "../userData.js";
import { normalizeAiApiBaseUrl } from "../ai.js";
import { AI_PROVIDER_PROFILE_KEY, bindCredential, getCredential, getProviderProfile } from "../aiProvider.js";

export const WRITING_VISION_API_CONFIG_KEY = "wuliao:writing:vision-api-config:v1";
export const WRITING_VISION_MODEL_KEY = "wuliao:writing:vision-model:v1";
export const WRITING_VISION_MODEL_CATALOG_KEY = "wuliao:writing:vision-model-catalog:v1";
export const WRITING_VISION_PROBE_CACHE_KEY = "wuliao:writing:vision-probe-cache:v1";
export const WRITING_VISION_SECRET_KEY = "wuliao:writing:vision-api-key";
export const WRITING_VISION_TRANSPORT_VERSION = "writing-vision-openai-v1";

const DEFAULT_CONFIG = Object.freeze({ providerKind: "openai-compatible", baseUrl: "", transportVersion: WRITING_VISION_TRANSPORT_VERSION });

function model(value) { const result = String(value || "").trim(); return result && result.length <= 256 && !/[\u0000-\u001f]/.test(result) ? result : ""; }
function configKey() { return WRITING_VISION_API_CONFIG_KEY; }
function probeIdentity(config, modelId) { return JSON.stringify({ providerKind: config.providerKind, baseUrl: config.baseUrl, modelId, adapterVersion: config.transportVersion }); }

export function getWritingVisionConfig() {
  if (getUserItem(`${AI_PROVIDER_PROFILE_KEY}:vision`)) {
    const profile = getProviderProfile("vision");
    if (profile) return { providerKind: "openai-compatible", baseUrl: profile.baseUrl, transportVersion: WRITING_VISION_TRANSPORT_VERSION };
  }
  try {
    const stored = JSON.parse(getUserItem(configKey()) || "{}");
    const baseUrl = normalizeAiApiBaseUrl(stored?.baseUrl);
    return { providerKind: stored?.providerKind === "openai-compatible" ? "openai-compatible" : DEFAULT_CONFIG.providerKind, baseUrl, transportVersion: WRITING_VISION_TRANSPORT_VERSION };
  } catch { return { ...DEFAULT_CONFIG }; }
}

export function setWritingVisionConfig(value = {}) {
  const baseUrl = String(value.baseUrl || "").trim() ? normalizeAiApiBaseUrl(value.baseUrl) : "";
  if (String(value.baseUrl || "").trim() && !baseUrl) throw new Error("Vision base URL 必须是合法的 http(s) 地址");
  const next = { providerKind: value.providerKind === "openai-compatible" ? "openai-compatible" : DEFAULT_CONFIG.providerKind, baseUrl, transportVersion: WRITING_VISION_TRANSPORT_VERSION };
  const before = getWritingVisionConfig();
  setUserItem(configKey(), JSON.stringify(next));
  if (before.providerKind !== next.providerKind || before.baseUrl !== next.baseUrl) {
    removeUserItem(WRITING_VISION_MODEL_CATALOG_KEY); removeUserItem(WRITING_VISION_PROBE_CACHE_KEY);
  }
  return next;
}

export function getWritingVisionModel() {
  if (getUserItem(`${AI_PROVIDER_PROFILE_KEY}:vision`)) return model(getProviderProfile("vision")?.modelId);
  return model(getUserItem(WRITING_VISION_MODEL_KEY));
}
export function setWritingVisionModel(value) { const next = model(value); if (next) setUserItem(WRITING_VISION_MODEL_KEY, next); else removeUserItem(WRITING_VISION_MODEL_KEY); removeUserItem(WRITING_VISION_PROBE_CACHE_KEY); return next; }

export function getWritingVisionModelCatalog(config = getWritingVisionConfig()) {
  try { const stored = JSON.parse(getUserItem(WRITING_VISION_MODEL_CATALOG_KEY) || "{}"); return stored?.baseUrl === config.baseUrl && stored?.providerKind === config.providerKind && Array.isArray(stored.models) ? stored.models.map(model).filter(Boolean) : []; } catch { return []; }
}
export function setWritingVisionModelCatalog(models, config = getWritingVisionConfig()) {
  const unique = [...new Set((Array.isArray(models) ? models : []).map(model).filter(Boolean))];
  setUserItem(WRITING_VISION_MODEL_CATALOG_KEY, JSON.stringify({ providerKind: config.providerKind, baseUrl: config.baseUrl, models: unique, updatedAt: Date.now() })); return unique;
}

export function getWritingVisionProbeCache(config = getWritingVisionConfig(), modelId = getWritingVisionModel()) {
  try { const stored = JSON.parse(getUserItem(WRITING_VISION_PROBE_CACHE_KEY) || "{}"); return stored?.identity === probeIdentity(config, modelId) ? stored.result || null : null; } catch { return null; }
}
export function setWritingVisionProbeCache(result, config = getWritingVisionConfig(), modelId = getWritingVisionModel()) {
  const stored = { identity: probeIdentity(config, modelId), result: { ...result, cachedAt: Date.now() } }; setUserItem(WRITING_VISION_PROBE_CACHE_KEY, JSON.stringify(stored)); return stored.result;
}

function secureKey(username) { return `ai:vision-apikey:${encodeURIComponent(username)}`; }
export async function getWritingVisionApiKey({ username = getCurrentUsername(), secureStore = globalThis.window?.AndroidSecureStore } = {}) {
  if (!username) return "";
  if (getUserItem(`${AI_PROVIDER_PROFILE_KEY}:vision`, username)) {
    return (await getCredential(getProviderProfile("vision"), { username, secureStore })).value;
  }
  if (secureStore?.get) {
    try {
      const key = secureKey(username);
      let value = String(await secureStore.get(key) || "").trim();
      const legacyValue = String(getUserItem(WRITING_VISION_SECRET_KEY, username) || "").trim();
      if (!value && legacyValue && secureStore?.set) {
        await secureStore.set(key, legacyValue);
        value = String(await secureStore.get(key) || "").trim();
      }
      if (value && legacyValue && value === legacyValue) removeUserItem(WRITING_VISION_SECRET_KEY, username);
      return value;
    } catch { return ""; }
  }
  // Web fallback is account-isolated but is not encrypted secure storage.
  return String(getUserItem(WRITING_VISION_SECRET_KEY, username) || "").trim();
}
export async function setWritingVisionApiKey(value, { username = getCurrentUsername(), secureStore = globalThis.window?.AndroidSecureStore } = {}) {
  if (!username) throw new Error("请先登录账号"); const key = String(value || "").trim();
  if (getUserItem(`${AI_PROVIDER_PROFILE_KEY}:vision`, username)) {
    await bindCredential(getProviderProfile("vision"), key, { username, secureStore });
    removeUserItem(WRITING_VISION_PROBE_CACHE_KEY, username);
    return;
  }
  if (secureStore?.set) {
    const storageKey = secureKey(username);
    if (key) {
      await secureStore.set(storageKey, key);
      if (String(await secureStore.get?.(storageKey) || "").trim() !== key) throw new Error("Android 安全存储无法确认 Vision API Key 写入");
    } else await secureStore.remove?.(storageKey);
    removeUserItem(WRITING_VISION_SECRET_KEY, username);
    removeUserItem(WRITING_VISION_PROBE_CACHE_KEY, username);
    return;
  }
  if (key) setUserItem(WRITING_VISION_SECRET_KEY, key, username); else removeUserItem(WRITING_VISION_SECRET_KEY, username);
  removeUserItem(WRITING_VISION_PROBE_CACHE_KEY, username);
}

export function writingVisionProbeIdentity(config, modelId) { return probeIdentity(config, modelId); }
