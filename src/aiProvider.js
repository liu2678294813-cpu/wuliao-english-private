import { getCurrentUsername, getUserItem, removeUserItem, setUserItem } from "./userData.js";
import { builtinModelRows, modelCatalogRequest, modelCatalogPage, nextModelCatalogPage } from "./aiModelCatalog.js";
import { getTelemetry } from "./telemetry/telemetry";
import { fingerprintAiInput } from "./aiTasks";
import { readAiResult, runCachedAiResult } from "./aiReviewCache";

export const AI_PROVIDER_PROFILE_KEY = "wuliao:ai:provider-profile:v2";
export const AI_PROVIDER_CATALOG_KEY = "wuliao:ai:provider-catalog:v2";
export const AI_RUNTIME_EVIDENCE_KEY = "wuliao:ai:runtime-evidence:v1";

const LEGACY_TEXT_CONFIG_KEY = "wuliao:ai:api-config";
const LEGACY_TEXT_MODEL_KEY = "wuliao:ai:model";
const LEGACY_TEXT_SECRET_KEY = "wuliao:ai:apikey";
const LEGACY_VISION_CONFIG_KEY = "wuliao:writing:vision-api-config:v1";
const LEGACY_VISION_MODEL_KEY = "wuliao:writing:vision-model:v1";
const LEGACY_VISION_SECRET_KEY = "wuliao:writing:vision-api-key";
const PROFILE_MODALITIES = new Set(["text", "vision"]);
const MODEL_ID_LIMIT = 256;
const DEFAULT_TIMEOUT_MS = 90_000;

export const TRANSPORT_KINDS = Object.freeze({
  CHAT: "openai-chat-completions",
  RESPONSES: "openai-responses",
  MESSAGES: "anthropic-messages",
  GEMINI: "native-gemini",
});

export const SUPPORT_STATUS = Object.freeze({
  SUPPORTED: "supported",
  PROBE_REQUIRED: "probe_required",
  UNSUPPORTED_PROTOCOL: "unsupported_protocol",
  UNSUPPORTED: "unsupported",
});

export const RUNTIME_STATUS = Object.freeze({
  VERIFIED: "verified",
  UNTESTED: "untested",
  RUNTIME_BLOCKED: "runtime_blocked",
  FAILED: "failed",
  UNSUPPORTED: "unsupported",
});

export const ALIBABA_REGIONS = Object.freeze([
  { id: "cn-beijing", name: "北京", sharedHost: "dashscope.aliyuncs.com", dedicated: true, trial: true },
  { id: "ap-southeast-1", name: "新加坡", sharedHost: "dashscope-intl.aliyuncs.com", dedicated: true, trial: true },
  { id: "us-east-1", name: "弗吉尼亚", sharedHost: "dashscope-us.aliyuncs.com", dedicated: true, trial: false },
  { id: "cn-hongkong", name: "香港", sharedHost: "cn-hongkong.dashscope.aliyuncs.com", dedicated: true, trial: true },
  { id: "ap-northeast-1", name: "东京", dedicated: true, trial: false },
  { id: "eu-central-1", name: "法兰克福", dedicated: true, trial: false },
]);

export const AI_PROVIDERS = Object.freeze([
  { id: "deepseek", name: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com", endpointKinds: ["official", "custom"], defaultModel: "deepseek-chat", defaultTransport: TRANSPORT_KINDS.CHAT },
  { id: "gemini", name: "Google Gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", endpointKinds: ["official", "custom"], defaultModel: "gemini-2.5-flash", defaultTransport: TRANSPORT_KINDS.CHAT },
  { id: "alibaba", name: "通义千问 · Model Studio", endpointKinds: ["workspace-dedicated", "shared", "trial", "custom"], defaultModel: "qwen-plus", defaultTransport: TRANSPORT_KINDS.CHAT },
  { id: "glm", name: "智谱 GLM", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", endpointKinds: ["china", "global", "custom"], defaultModel: "glm-4.5-flash", defaultTransport: TRANSPORT_KINDS.CHAT },
  { id: "kimi", name: "Kimi · Moonshot", defaultBaseUrl: "https://api.moonshot.cn/v1", endpointKinds: ["official", "custom"], defaultModel: "kimi-k2-0905-preview", defaultTransport: TRANSPORT_KINDS.CHAT },
  { id: "openai", name: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", endpointKinds: ["official", "custom"], defaultModel: "gpt-5-mini", defaultTransport: TRANSPORT_KINDS.RESPONSES },
  { id: "opencode-zen", name: "OpenCode Zen", defaultBaseUrl: "https://opencode.ai/zen/v1", endpointKinds: ["official"], defaultModel: "", defaultTransport: null },
  { id: "openrouter", name: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1", endpointKinds: ["official", "custom"], defaultModel: "openrouter/auto", defaultTransport: TRANSPORT_KINDS.CHAT },
  { id: "custom", name: "自定义 OpenAI-compatible", endpointKinds: ["custom"], defaultModel: "", defaultTransport: TRANSPORT_KINDS.CHAT },
]);

const providerMap = new Map(AI_PROVIDERS.map((provider) => [provider.id, provider]));

function runtimeKind() {
  return globalThis.window?.AndroidSecureStore ? "android" : "web";
}

function defaultLocalDevelopmentAllowed() {
  return Boolean(import.meta.env?.DEV);
}

function exactLoopback(hostname) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(String(hostname || "").toLowerCase());
}

function cleanBasePath(pathname) {
  let path = String(pathname || "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  path = path
    .replace(/\/(?:chat\/completions|responses|messages|models)$/i, "")
    .replace(/\/+$/, "");
  return path && path !== "/" ? path : "";
}

export function normalizeProviderEndpoint(value, { allowLocalDevelopment = defaultLocalDevelopmentAllowed() } = {}) {
  const raw = String(value || "").trim();
  if (!raw) throw providerError("invalid_endpoint", "请输入 API Base URL");
  let url;
  try { url = new URL(raw); } catch { throw providerError("invalid_endpoint", "API Base URL 无效"); }
  if (url.username || url.password) throw providerError("invalid_endpoint", "API Base URL 不得包含用户名或密码");
  const localHttp = url.protocol === "http:" && allowLocalDevelopment && exactLoopback(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw providerError("insecure_endpoint", "正式运行只允许 HTTPS；HTTP 仅限显式启用的本机开发地址");
  }
  if (!url.hostname) throw providerError("invalid_endpoint", "API Base URL 缺少主机名");
  url.hash = "";
  url.search = "";
  const normalizedBasePath = cleanBasePath(url.pathname);
  const normalizedOrigin = url.origin.toLowerCase();
  return {
    baseUrl: `${normalizedOrigin}${normalizedBasePath}`,
    normalizedOrigin,
    normalizedBasePath,
    isLocalDevelopment: localHttp,
  };
}

function providerError(code, message, extra = {}) {
  const error = new Error(message);
  error.name = "AiProviderError";
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function safeModelId(value) {
  const id = String(value || "").trim();
  return id && id.length <= MODEL_ID_LIMIT && !/[\u0000-\u001f]/.test(id) ? id : "";
}

function regionDefinition(region) {
  return ALIBABA_REGIONS.find((candidate) => candidate.id === region) || null;
}

export function resolveProviderBaseUrl(profile) {
  const provider = providerMap.get(profile?.providerId);
  if (!provider) throw providerError("provider_unsupported", "未知 Provider");
  if (profile.providerId === "alibaba") {
    if (profile.endpointKind === "custom") return normalizeProviderEndpoint(profile.baseUrl).baseUrl;
    const region = regionDefinition(profile.region);
    if (!region) throw providerError("region_required", "请选择 Alibaba 区域");
    if (profile.endpointKind === "workspace-dedicated") {
      const workspaceId = String(profile.workspaceId || "").trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/.test(workspaceId)) {
        throw providerError("workspace_required", "专属端点需要有效的 Workspace ID");
      }
      return `https://${workspaceId}.${region.id}.maas.aliyuncs.com/compatible-mode/v1`;
    }
    if (profile.endpointKind === "trial") {
      if (!region.trial) throw providerError("endpoint_unavailable", "该区域当前没有 Trial 端点");
      return `https://trial.${region.id}.maas.aliyuncs.com/compatible-mode/v1`;
    }
    if (profile.endpointKind === "shared") {
      if (!region.sharedHost) throw providerError("endpoint_unavailable", "该区域仅支持 Workspace 专属端点");
      return `https://${region.sharedHost}/compatible-mode/v1`;
    }
    throw providerError("endpoint_unavailable", "请选择 Alibaba 端点类型");
  }
  if (profile.providerId === "glm" && profile.endpointKind === "global") return "https://api.z.ai/api/paas/v4";
  if (profile.endpointKind === "custom" || !provider.defaultBaseUrl) return normalizeProviderEndpoint(profile.baseUrl).baseUrl;
  return provider.defaultBaseUrl;
}

export function createCredentialScope(profile) {
  const modality = PROFILE_MODALITIES.has(profile?.modality) ? profile.modality : null;
  if (!modality) throw providerError("invalid_profile", "AI modality 无效");
  const baseUrl = resolveProviderBaseUrl(profile);
  const endpoint = normalizeProviderEndpoint(baseUrl);
  return Object.freeze({
    providerId: String(profile.providerId),
    modality,
    endpointKind: String(profile.endpointKind || "official"),
    normalizedOrigin: endpoint.normalizedOrigin,
    normalizedBasePath: endpoint.normalizedBasePath,
    ...(profile.region ? { region: String(profile.region) } : {}),
    ...(profile.workspaceId ? { workspaceId: String(profile.workspaceId).trim() } : {}),
  });
}

export function credentialScopeId(scopeOrProfile) {
  const scope = scopeOrProfile?.normalizedOrigin ? scopeOrProfile : createCredentialScope(scopeOrProfile);
  const canonical = JSON.stringify({
    providerId: scope.providerId,
    modality: scope.modality,
    endpointKind: scope.endpointKind,
    normalizedOrigin: scope.normalizedOrigin,
    normalizedBasePath: scope.normalizedBasePath,
    region: scope.region || "",
    workspaceId: scope.workspaceId || "",
  });
  return `v2:${encodeURIComponent(canonical)}`;
}

export function normalizeProviderProfile(value = {}) {
  const modality = PROFILE_MODALITIES.has(value.modality) ? value.modality : "text";
  const provider = providerMap.get(value.providerId) || providerMap.get("deepseek");
  const endpointKind = provider.endpointKinds.includes(value.endpointKind)
    ? value.endpointKind
    : provider.endpointKinds[0];
  const draft = {
    version: 2,
    modality,
    providerId: provider.id,
    baseUrl: String(value.baseUrl || provider.defaultBaseUrl || "").trim(),
    endpointKind,
    ...(value.region ? { region: String(value.region) } : {}),
    ...(value.workspaceId ? { workspaceId: String(value.workspaceId).trim() } : {}),
    modelId: safeModelId(value.modelId) || provider.defaultModel,
    ...(Object.values(TRANSPORT_KINDS).includes(value.transportOverride)
      ? { transportOverride: value.transportOverride }
      : {}),
  };
  draft.baseUrl = resolveProviderBaseUrl(draft);
  draft.credentialScopeId = credentialScopeId(draft);
  return draft;
}

function profileStorageKey(modality) {
  return `${AI_PROVIDER_PROFILE_KEY}:${modality}`;
}

function migrateLegacyProfile(modality) {
  if (modality === "vision") {
    let config = {};
    try { config = JSON.parse(getUserItem(LEGACY_VISION_CONFIG_KEY) || "{}"); } catch { /* compatible fallback */ }
    const baseUrl = String(config?.baseUrl || "").trim();
    if (!baseUrl && !getUserItem(LEGACY_VISION_MODEL_KEY)) return null;
    return normalizeProviderProfile({
      modality,
      providerId: "custom",
      endpointKind: "custom",
      baseUrl,
      modelId: getUserItem(LEGACY_VISION_MODEL_KEY) || "",
    });
  }
  let config = {};
  try { config = JSON.parse(getUserItem(LEGACY_TEXT_CONFIG_KEY) || "{}"); } catch { /* compatible fallback */ }
  const baseUrl = String(config?.baseUrl || "https://api.deepseek.com").trim();
  return normalizeProviderProfile({
    modality,
    providerId: "deepseek",
    endpointKind: baseUrl === "https://api.deepseek.com" ? "official" : "custom",
    baseUrl,
    modelId: getUserItem(LEGACY_TEXT_MODEL_KEY) || "deepseek-chat",
  });
}

export function getProviderProfile(modality = "text") {
  if (!PROFILE_MODALITIES.has(modality)) throw providerError("invalid_profile", "AI modality 无效");
  try {
    const current = JSON.parse(getUserItem(profileStorageKey(modality)) || "null");
    if (current?.version === 2) return normalizeProviderProfile(current);
  } catch { /* read-compatible fallback */ }
  const migrated = migrateLegacyProfile(modality);
  if (migrated) {
    // Lazy, additive migration: legacy data is intentionally retained.
    setUserItem(profileStorageKey(modality), JSON.stringify(migrated));
    return migrated;
  }
  return modality === "text"
    ? normalizeProviderProfile({ modality, providerId: "deepseek", endpointKind: "official" })
    : null;
}

export function saveProviderProfile(value) {
  const next = normalizeProviderProfile(value);
  setUserItem(profileStorageKey(next.modality), JSON.stringify(next));
  return next;
}

export function listAiProviders() {
  return AI_PROVIDERS.map((provider) => ({ ...provider }));
}

function nativeCredentialKey(username, scopeId) {
  return `ai:credential:v2:${encodeURIComponent(username)}:${scopeId}`;
}

function webCredentialKey(scopeId) {
  return `wuliao:ai:credential:v2:${scopeId}`;
}

function legacySecretKey(modality) {
  return modality === "vision" ? LEGACY_VISION_SECRET_KEY : LEGACY_TEXT_SECRET_KEY;
}

export async function getCredential(profile, {
  username = getCurrentUsername(),
  secureStore = globalThis.window?.AndroidSecureStore,
  migrateLegacy = true,
} = {}) {
  if (!username) return { status: "missing", value: "", scopeId: "" };
  const normalized = normalizeProviderProfile(profile);
  const scopeId = normalized.credentialScopeId;
  const fallbackKey = webCredentialKey(scopeId);
  const legacyProfile = migrateLegacy ? migrateLegacyProfile(normalized.modality) : null;
  const legacyMigrationAllowed = legacyProfile?.credentialScopeId === scopeId;
  if (secureStore?.get) {
    const storageKey = nativeCredentialKey(username, scopeId);
    let value;
    try { value = String(await secureStore.get(storageKey) || "").trim(); }
    catch { throw providerError("secure_storage_error", "Android 安全存储读取失败"); }
    const scopedFallback = String(getUserItem(fallbackKey, username) || "").trim();
    const legacyFallback = legacyMigrationAllowed ? String(getUserItem(legacySecretKey(normalized.modality), username) || "").trim() : "";
    const plaintext = scopedFallback || legacyFallback;
    // Older Android Writing stored Vision credentials natively, not in
    // localStorage. Only migrate when its saved endpoint matches this scope;
    // never borrow a Text key or a key belonging to another endpoint/account.
    let legacyNative = "";
    if (!value && legacyMigrationAllowed && normalized.modality === "vision") {
      try { legacyNative = String(await secureStore.get(`ai:vision-apikey:${encodeURIComponent(username)}`) || "").trim(); }
      catch { throw providerError("secure_storage_error", "Android 旧版视觉密钥读取失败"); }
    }
    const migrationValue = plaintext || legacyNative;
    if (!value && migrationValue) {
      if (!secureStore.set) throw providerError("secure_storage_error", "Android 安全存储不可写，密钥迁移未完成");
      try {
        await secureStore.set(storageKey, migrationValue);
        value = String(await secureStore.get(storageKey) || "").trim();
      } catch {
        throw providerError("secure_storage_error", "Android 安全存储迁移失败；旧凭据已保留，AI 请求已阻止");
      }
      if (value !== migrationValue) throw providerError("secure_storage_error", "Android 安全存储校验失败；旧凭据已保留，AI 请求已阻止");
    }
    if (value && scopedFallback && value === scopedFallback) removeUserItem(fallbackKey, username);
    if (value && legacyFallback && value === legacyFallback) removeUserItem(legacySecretKey(normalized.modality), username);
    return { status: value ? "bound" : "missing", value, scopeId };
  }
  const value = String(getUserItem(fallbackKey, username) || "").trim();
  if (value) return { status: "bound", value, scopeId };
  const legacyValue = legacyMigrationAllowed ? String(getUserItem(legacySecretKey(normalized.modality), username) || "").trim() : "";
  if (legacyValue) {
    setUserItem(fallbackKey, legacyValue, username);
    return { status: "bound", value: legacyValue, scopeId, migrated: true };
  }
  return { status: "missing", value: "", scopeId };
}

export async function bindCredential(profile, value, {
  username = getCurrentUsername(),
  secureStore = globalThis.window?.AndroidSecureStore,
} = {}) {
  if (!username) throw providerError("login_required", "请先登录账号");
  const normalized = normalizeProviderProfile(profile);
  const scopeId = normalized.credentialScopeId;
  const credential = String(value || "").trim();
  const fallbackKey = webCredentialKey(scopeId);
  if (secureStore?.set) {
    const storageKey = nativeCredentialKey(username, scopeId);
    try {
      if (credential) {
        await secureStore.set(storageKey, credential);
        if (String(await secureStore.get?.(storageKey) || "").trim() !== credential) {
          throw new Error("read-back mismatch");
        }
      } else {
        await secureStore.remove?.(storageKey);
        if (normalized.modality === "vision" && migrateLegacyProfile("vision")?.credentialScopeId === scopeId) {
          // An explicit removal also removes this endpoint's old credential,
          // otherwise the next read would silently migrate it back again.
          await secureStore.remove?.(`ai:vision-apikey:${encodeURIComponent(username)}`);
        }
      }
    } catch {
      throw providerError("secure_storage_error", "Android 安全存储无法确认 API Key 写入");
    }
    removeUserItem(fallbackKey, username);
  } else if (credential) setUserItem(fallbackKey, credential, username);
  else removeUserItem(fallbackKey, username);
  return { status: credential ? "bound" : "missing", scopeId };
}

export async function rebindCredential(fromProfile, toProfile, options = {}) {
  const from = normalizeProviderProfile(fromProfile);
  const to = normalizeProviderProfile(toProfile);
  if (from.credentialScopeId === to.credentialScopeId) return getCredential(to, options);
  if (options.confirm !== true) throw providerError("credential_unbound", "端点身份已改变，请重新输入或明确确认重新绑定 API Key");
  const previous = await getCredential(from, { ...options, migrateLegacy: false });
  if (!previous.value) throw providerError("credential_unbound", "旧端点没有可重新绑定的 API Key");
  await bindCredential(to, previous.value, options);
  return { status: "bound", scopeId: to.credentialScopeId };
}

export function credentialBindingStatus(savedProfile, draftProfile) {
  if (!savedProfile) return "missing";
  try {
    return normalizeProviderProfile(savedProfile).credentialScopeId === normalizeProviderProfile(draftProfile).credentialScopeId
      ? "bound"
      : "unbound";
  } catch { return "unbound"; }
}

function catalogStorageKey(profile) {
  return `${AI_PROVIDER_CATALOG_KEY}:${profile.modality}:${profile.providerId}:${profile.credentialScopeId}`;
}

export function getCachedProviderModels(profile) {
  const normalized = normalizeProviderProfile(profile);
  try {
    const stored = JSON.parse(getUserItem(catalogStorageKey(normalized)) || "null");
    return stored?.version === 2 && Array.isArray(stored.models) ? stored : null;
  } catch { return null; }
}

function inferTransport(row, providerId, fallback) {
  const evidence = [row?.transportKind, row?.transport, row?.endpoint, row?.api, row?.protocol, row?.provider?.api, row?.provider?.npm]
    .filter(Boolean).join(" ").toLowerCase();
  if (/responses/.test(evidence)) return TRANSPORT_KINDS.RESPONSES;
  if (/chat.?completions|openai/.test(evidence)) return TRANSPORT_KINDS.CHAT;
  if (/messages|anthropic/.test(evidence)) return TRANSPORT_KINDS.MESSAGES;
  if (/gemini|generative-language|@ai-sdk\/google/.test(evidence)) return TRANSPORT_KINDS.GEMINI;
  if (providerId === "opencode-zen") {
    const id = String(row?.id || row?.name || "").toLowerCase();
    // Conservative fallback for the implementation-date Zen catalog. Unknown IDs stay blocked.
    if (/^(?:gpt-5|grok-|muse-spark)/.test(id)) return TRANSPORT_KINDS.RESPONSES;
    if (/^(?:claude-|qwen3\.[5-7])/.test(id)) return TRANSPORT_KINDS.MESSAGES;
    if (/^gemini-/.test(id)) return TRANSPORT_KINDS.GEMINI;
    if (/^(?:deepseek-|minimax-|glm-|kimi-|big-pickle|mimo-|ling-|nemotron-)/.test(id)) return TRANSPORT_KINDS.CHAT;
  }
  return providerId === "opencode-zen" ? null : fallback;
}

function modalityEvidence(row) {
  const input = row?.modalities?.input || row?.input_modalities || row?.architecture?.input_modalities || row?.input || [];
  const normalized = Array.isArray(input) ? input.map((item) => String(item).toLowerCase()) : [];
  return { vision: row?.supports_image_in === true || normalized.some((item) => /image|vision/.test(item)) };
}

export function normalizeProviderModels(rows, profile) {
  const normalizedProfile = normalizeProviderProfile(profile);
  const provider = providerMap.get(normalizedProfile.providerId);
  const sourceRows = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  return sourceRows.flatMap((row) => {
    const source = typeof row === "object" && row ? row : { id: row };
    const id = safeModelId(source.id ?? source.model ?? source.name);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const transportKind = inferTransport(source, provider.id, provider.defaultTransport);
    const implemented = [TRANSPORT_KINDS.CHAT, TRANSPORT_KINDS.RESPONSES].includes(transportKind);
    const modality = modalityEvidence(source);
    return [{
      id,
      name: String(source.name || id),
      transportKind: transportKind || String(source.transportKind || "unknown"),
      textStatus: source.textUnsupported ? SUPPORT_STATUS.UNSUPPORTED : implemented ? SUPPORT_STATUS.PROBE_REQUIRED : SUPPORT_STATUS.UNSUPPORTED_PROTOCOL,
      visionStatus: implemented && modality.vision ? SUPPORT_STATUS.PROBE_REQUIRED : (implemented ? SUPPORT_STATUS.UNSUPPORTED : SUPPORT_STATUS.UNSUPPORTED_PROTOCOL),
      structuredOutputStatus: implemented ? SUPPORT_STATUS.PROBE_REQUIRED : SUPPORT_STATUS.UNSUPPORTED_PROTOCOL,
      webDirectStatus: RUNTIME_STATUS.UNTESTED,
      androidStatus: RUNTIME_STATUS.UNTESTED,
    }];
  });
}

export function getBuiltinProviderModels(profile) {
  return normalizeProviderModels(builtinModelRows(profile), profile);
}

export async function fetchProviderModels(profile, {
  apiKey,
  timeoutMs = 10_000,
  signal = null,
  username = getCurrentUsername(),
} = {}) {
  const normalized = normalizeProviderProfile(profile);
  const credential = String(apiKey || "").trim() || (await getCredential(normalized, { username })).value;
  if (!credential) throw providerError("credential_unbound", "请先为当前端点绑定 API Key");
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.("abort", abort, { once: true });
  try {
    let request = modelCatalogRequest(normalized);
    const rows = [];
    const visited = new Set();
    while (request) {
      if (visited.has(request.url.href) || visited.size >= 100) throw providerError("invalid_response", "模型目录分页异常，已保留原列表");
      visited.add(request.url.href);
      const response = await fetch(request.url.href, {
        headers: request.kind === "gemini" ? { "x-goog-api-key": credential } : { Authorization: `Bearer ${credential}` },
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if ([404, 405, 501].includes(response.status)) throw providerError("catalog_unavailable", "当前端点不提供模型目录，可使用内置候选或手动输入 Model ID");
        throw httpError(response.status, data);
      }
      if (controller.signal.aborted) throw providerError("cancelled", "模型目录请求已取消");
      const page = modelCatalogPage(data, request.kind);
      rows.push(...page);
      const next = nextModelCatalogPage(data, request, rows.length);
      if (next && !page.length) throw providerError("invalid_response", "模型目录分页为空，已保留原列表");
      request = next;
    }
    const models = normalizeProviderModels(rows, normalized);
    const catalog = { version: 2, models, updatedAt: Date.now(), endpointIdentity: normalized.credentialScopeId };
    if (controller.signal.aborted) throw providerError("cancelled", "模型目录请求已取消");
    setUserItem(catalogStorageKey(normalized), JSON.stringify(catalog), username);
    return catalog;
  } catch (reason) {
    if (controller.signal.aborted) throw providerError(signal?.aborted ? "cancelled" : "timeout", signal?.aborted ? "模型目录请求已取消" : "读取模型目录超时");
    if (reason instanceof TypeError) throw providerError("runtime_network_compatibility", "浏览器未取得 HTTP 响应；可能被 CORS、DNS、TLS 或网络策略阻止", { cause: reason });
    throw reason;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abort);
  }
}

function httpError(status, data) {
  const code = status === 401 || status === 403 ? "auth_error" : status === 404 ? "model_unsupported" : status === 429 ? "rate_limit" : "provider_error";
  return providerError(code, data?.error?.message || `AI API 请求失败（${status}）`, { status, providerCode: data?.error?.code || null });
}

function modelTransport(profile, model) {
  if (profile.transportOverride) return profile.transportOverride;
  const cached = getCachedProviderModels(profile)?.models?.find((candidate) => candidate.id === model);
  return cached?.transportKind || providerMap.get(profile.providerId)?.defaultTransport;
}

export function resolveModelTransport(model, profile = getProviderProfile("text")) {
  const normalized = normalizeProviderProfile(profile);
  const transport = modelTransport(normalized, safeModelId(model) || normalized.modelId);
  if (![TRANSPORT_KINDS.CHAT, TRANSPORT_KINDS.RESPONSES].includes(transport)) {
    throw providerError("unsupported_protocol", `当前模型使用尚未实现的协议：${transport || "unknown"}`);
  }
  return transport;
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const number = (value) => value != null && Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens);
  const hit = number(usage.prompt_cache_hit_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const miss = number(usage.prompt_cache_miss_tokens) ?? (hit != null && prompt != null ? Math.max(0, prompt - hit) : null);
  return {
    prompt_tokens: prompt,
    completion_tokens: number(usage.completion_tokens ?? usage.output_tokens),
    total_tokens: number(usage.total_tokens),
    cacheUsage: { hitTokens: hit, missTokens: miss, hitRatio: hit != null && miss != null && hit + miss > 0 ? hit / (hit + miss) : null },
  };
}

function parseProviderResponse(data, transport) {
  if (transport === TRANSPORT_KINDS.CHAT) {
    const message = data?.choices?.[0]?.message;
    if (!message) throw providerError("invalid_response", "AI API 返回为空，请重试");
    return { content: String(message.content || ""), reasoning: String(message.reasoning_content || message.reasoning || "") };
  }
  const content = data?.output_text || (Array.isArray(data?.output)
    ? data.output.flatMap((item) => item?.content || []).map((item) => item?.text || item?.output_text || "").join("")
    : "");
  if (!content) throw providerError("invalid_response", "Responses API 返回为空，请重试");
  return { content: String(content), reasoning: String(data?.reasoning?.summary || "") };
}

function evidenceKey(record) {
  return encodeURIComponent(JSON.stringify([record.providerId, record.modelId, record.endpointIdentity, record.runtime, record.appVersion]));
}

export function getRuntimeEvidence(profile, modelId, { runtime = runtimeKind(), appVersion = "unknown" } = {}) {
  const normalized = normalizeProviderProfile(profile);
  try {
    return JSON.parse(getUserItem(`${AI_RUNTIME_EVIDENCE_KEY}:${evidenceKey({ providerId: normalized.providerId, modelId, endpointIdentity: normalized.credentialScopeId, runtime, appVersion })}`) || "null");
  } catch { return null; }
}

export function recordRuntimeEvidence(profile, modelId, status, { runtime = runtimeKind(), appVersion = "unknown", failureCategory } = {}) {
  const normalized = normalizeProviderProfile(profile);
  const record = {
    providerId: normalized.providerId,
    modelId,
    endpointIdentity: normalized.credentialScopeId,
    runtime,
    status,
    testedAt: Date.now(),
    appVersion,
    ...(failureCategory ? { failureCategory } : {}),
  };
  setUserItem(`${AI_RUNTIME_EVIDENCE_KEY}:${evidenceKey(record)}`, JSON.stringify(record));
  return record;
}

export async function callAi({
  profile = getProviderProfile("text"),
  apiKey,
  model,
  messages,
  temperature = 0.6,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
  appVersion = "unknown",
  taskType = "",
} = {}) {
  const startedAt = performance.now(), username = getCurrentUsername();
  const normalized = normalizeProviderProfile(profile);
  const modelId = safeModelId(model) || normalized.modelId;
  if (!modelId) throw providerError("model_unsupported", "请填写 Model ID");
  const transportKind = resolveModelTransport(modelId, normalized);
  const credential = String(apiKey || "").trim() || (await getCredential(normalized)).value;
  if (!credential) throw providerError("credential_unbound", "当前端点尚未绑定 API Key");
  const controller = new AbortController();
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.("abort", abort, { once: true });
  const requestId = globalThis.crypto?.randomUUID?.() || `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = transportKind === TRANSPORT_KINDS.RESPONSES ? "responses" : "chat/completions";
  const body = transportKind === TRANSPORT_KINDS.RESPONSES
    ? { model: modelId, input: messages, temperature }
    : { model: modelId, messages, temperature, stream: false };
  try {
    const response = await fetch(`${normalized.baseUrl}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    getTelemetry().recordTiming({ metric: "ai.request.ttfb", tags: { taskType, model: modelId, kind: "response-headers" }, durationMs: performance.now() - startedAt });
    const data = await response.json().catch(() => null);
    if (signal?.aborted || username !== getCurrentUsername()) throw new DOMException("AI request cancelled", "AbortError");
    if (!response.ok) throw httpError(response.status, data);
    const parsed = parseProviderResponse(data, transportKind);
    const usage = normalizeUsage(data?.usage);
    if (usage?.cacheUsage) {
      getTelemetry().recordEvent({ eventType: "ai.cache.provider_usage", taskType, model: modelId, metadata: usage.cacheUsage });
    }
    getTelemetry().recordApiRequest({ taskType, model: modelId, durationMs: performance.now() - startedAt, usage });
    getTelemetry().recordTiming({ metric: "ai.request.total_latency", tags: { taskType, model: modelId }, durationMs: performance.now() - startedAt });
    recordRuntimeEvidence(normalized, modelId, RUNTIME_STATUS.VERIFIED, { appVersion });
    return {
      ...parsed,
      ...(usage ? { usage } : {}),
      cacheUsage: usage?.cacheUsage || null,
      providerId: normalized.providerId,
      modelId,
      transportKind,
      requestId,
    };
  } catch (reason) {
    if (!timedOut && (signal?.aborted || reason?.name === "AbortError" || username !== getCurrentUsername())) throw new DOMException("AI request cancelled", "AbortError");
    let category = reason?.code || "provider_error";
    if (timedOut) category = "timeout";
    else if (reason instanceof TypeError) category = "runtime_network_compatibility";
    const status = category === "runtime_network_compatibility" ? RUNTIME_STATUS.RUNTIME_BLOCKED : RUNTIME_STATUS.FAILED;
    recordRuntimeEvidence(normalized, modelId, status, { appVersion, failureCategory: category });
    getTelemetry().recordApiRequest({ taskType, model: modelId, status: "error", category, durationMs: performance.now() - startedAt });
    if (category === "timeout") throw providerError("timeout", "AI 请求超时", { cause: reason });
    if (category === "runtime_network_compatibility") {
      throw providerError(category, "当前运行时未取得 HTTP 响应；可能是 CORS、DNS、TLS 或网络策略问题", { cause: reason });
    }
    throw reason;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abort);
  }
}

export async function testProviderConnection(profile, options = {}) {
  const normalized = normalizeProviderProfile(profile);
  const result = await callAi({
    ...options,
    profile: normalized,
    model: options.model || normalized.modelId,
    messages: [{ role: "user", content: "Reply with only: OK" }],
    temperature: 0,
    timeoutMs: options.timeoutMs || 30_000,
  });
  return { ...result, verified: true };
}

export function textAiCacheIdentity(options) {
  const profile = normalizeProviderProfile(options.profile || getProviderProfile("text"));
  const model = safeModelId(options.model) || profile.modelId;
  const namespace = options.cacheNamespace || options.taskType || "chat";
  const input = { task: namespace, promptVersion: options.promptVersion || 1, schemaVersion: 1,
    model, provider: [profile.providerId, profile.baseUrl, resolveModelTransport(model, profile), profile.credentialScopeId],
    messages: options.messages, temperature: options.temperature ?? 0.6 };
  const fingerprint = fingerprintAiInput(input);
  return { namespace, fingerprint, identity: fingerprint };
}
export function readTextAiCache(options) {
  const key = textAiCacheIdentity(options);
  return readAiResult(key.namespace, key.fingerprint, key.identity);
}
export async function callCachedTextAi(options) {
  const key = textAiCacheIdentity(options);
  const response = await runCachedAiResult({ ...key, signal: options.signal, isCurrent: options.isCurrent,
    force: Boolean(options.force), request: ({ signal }) => callAi({ ...options, signal }),
    validate: result => Boolean(result?.content?.trim()) });
  return { ...response.result, cached: response.cached, cacheSource: response.source };
}
