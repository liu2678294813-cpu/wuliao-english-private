import { fingerprintAiInput } from "./aiTasks.js";
import { stableAiPrefix } from "./aiPromptContext.js";

export const AI_CACHE_POLICY_VERSION = 1;
export const AI_CACHE_RESEARCH_DATE = "2026-10-13";
const CHAT = "openai-chat-completions", RESPONSES = "openai-responses";
const rejectedParameters = new Set();
const capabilityKey = ({ profile, model, transport }) => fingerprintAiInput([profile.providerId, profile.baseUrl, model, transport]);
// Exact documented families/aliases. A user supplied lookalike never opts in.
const OPENAI_CACHE_KEY_MODELS = new Set([
  "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6",
  "gpt-6.1-sol",
]);
const DEEPSEEK_USER_ID_MODELS = new Set(["deepseek-flash", "deepseek-pro", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);
const AUTOMATIC_MODELS = {
  deepseek: new Set(["deepseek-chat", "deepseek-reasoner", ...DEEPSEEK_USER_ID_MODELS]),
  gemini: new Set(["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.1-pro-preview"]),
  glm: new Set(["glm-5", "glm-4.7", "glm-4.6"]),
  alibaba: new Set(["qwen-plus", "qwen-flash"]),
};

function officialEndpoint(profile) {
  if (profile.endpointKind === "custom" || profile.providerId === "custom") return false;
  const url = String(profile.baseUrl || "").replace(/\/$/, "");
  if (profile.providerId === "openai") return url === "https://api.openai.com/v1";
  if (profile.providerId === "deepseek") return ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(url);
  if (profile.providerId === "gemini") return url === "https://generativelanguage.googleapis.com/v1beta/openai";
  if (profile.providerId === "glm") return ["https://open.bigmodel.cn/api/paas/v4", "https://api.z.ai/api/paas/v4"].includes(url);
  if (profile.providerId === "kimi") return ["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"].includes(url);
  if (profile.providerId === "openrouter") return url === "https://openrouter.ai/api/v1";
  if (profile.providerId === "opencode-zen") return url === "https://opencode.ai/zen/v1";
  if (profile.providerId === "alibaba") return /^https:\/\/(?:dashscope(?:-intl|-us)?\.aliyuncs\.com|cn-hongkong\.dashscope\.aliyuncs\.com|[a-zA-Z0-9_-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com)\/compatible-mode\/v1$/.test(url);
  return false;
}

export function resolveProviderCachePolicy({ profile, model, transport }) {
  const base = { version: AI_CACHE_POLICY_VERSION, automatic: "unknown", explicitEnabled: false, parameter: null, reason: "model_or_transport_unverified" };
  if (!officialEndpoint(profile)) return { ...base, reason: "custom_endpoint_unverified" };
  if (![CHAT, RESPONSES].includes(transport)) return { ...base, reason: "transport_unverified" };
  if (profile.providerId === "openai" && OPENAI_CACHE_KEY_MODELS.has(model)) {
    return { ...base, automatic: "documented", parameter: "prompt_cache_key", reason: "automatic_no_explicit_writes_requested" };
  }
  if (profile.providerId === "kimi" && model === "kimi-k3") return { ...base, automatic: "documented", reason: "automatic_default_ttl_no_override" };
  if (transport !== CHAT) return base;
  if (profile.providerId === "glm" && String(profile.baseUrl).replace(/\/$/, "") === "https://open.bigmodel.cn/api/paas/v4" && model === "glm-5.3") return { ...base, automatic: "documented", reason: "automatic_no_extra_parameters" };
  if (profile.providerId === "deepseek" && DEEPSEEK_USER_ID_MODELS.has(model)) {
    return { ...base, automatic: "documented", parameter: "user_id", reason: "automatic_user_isolation" };
  }
  if (AUTOMATIC_MODELS[profile.providerId]?.has(model)) return { ...base, automatic: "documented", reason: "automatic_no_extra_parameters" };
  if (profile.providerId === "openrouter") return { ...base, reason: "router_model_provider_dependent" };
  if (profile.providerId === "opencode-zen") return { ...base, reason: "zen_model_protocol_dependent" };
  return base;
}

export function providerCacheRequestFields({ profile, model, transport, messages, username }) {
  const policy = resolveProviderCachePolicy({ profile, model, transport });
  if (rejectedParameters.has(capabilityKey({ profile, model, transport }))) {
    return { policy: { ...policy, parameter: null, reason: "cache_parameter_rejected_plain_request" }, fields: {} };
  }
  if (!policy.parameter || !username) return { policy, fields: {} };
  const scope = fingerprintAiInput({ namespace: "provider-cache-v1", username, endpoint: profile.baseUrl, model });
  const group = fingerprintAiInput(stableAiPrefix(messages));
  // No username, prompt, endpoint or credential appears in a provider-visible key.
  return { policy, fields: policy.parameter === "user_id"
    ? { user_id: scope.slice(0, 64) }
    : { prompt_cache_key: `wl:${scope.slice(0, 24)}:${group.slice(0, 24)}` } };
}

// Retry only an explicit parameter rejection, never auth, quota or server errors.
// The fallback shares the caller's cancellation and total timeout budget.
export function noteRejectedCacheParameter({ profile, model, transport, fields, status, data }) {
  if (![400, 422].includes(status) || !Object.keys(fields || {}).length) return false;
  const error = data?.error;
  const message = typeof error === "string" ? error : String(error?.message || "");
  const parameter = String(error?.param || "");
  const rejected = Object.keys(fields).some(field =>
    (parameter === field || message.includes(field)) &&
    /unknown|unrecognized|unsupported|not support|not allowed|unexpected|extra inputs|不支持|未知参数|不允许/i.test(`${message} ${error?.code || ""}`));
  if (!rejected) return false;
  if (rejectedParameters.size >= 200) rejectedParameters.delete(rejectedParameters.values().next().value);
  rejectedParameters.add(capabilityKey({ profile, model, transport }));
  return true;
}

// Rate cards must state the exact model/endpoint, currency, source and date.
// This function never guesses prices or silently treats a missing write cost as 0.
export function estimateAiTokenCost(usage, rates) {
  const unknown = { calculable: false, reason: "complete_verified_rates_and_usage_required" };
  if (!usage || !rates?.verified || !rates.source || !rates.asOf || !rates.currency) return unknown;
  const p = usage.prompt_tokens, h = usage.cacheUsage?.hitTokens, w = usage.cache_write_tokens, o = usage.completion_tokens;
  const write = rates.noWriteCharge === true && w == null ? 0 : w;
  if ([p, h, write, o, rates.input, rates.read, rates.output].some(n => n == null || !Number.isFinite(n) || n < 0) || p < h + write) return unknown;
  if (write > 0 && (rates.write == null || !Number.isFinite(rates.write) || rates.write < 0)) return unknown;
  if (write > 0 && !["replaces-input", "additional-to-input"].includes(rates.writeBilling)) return unknown;
  // Some vendors include base input in the write rate; others bill both items.
  const normalTokens = p - h - (rates.writeBilling === "replaces-input" ? write : 0);
  const normalInput = normalTokens * rates.input / 1e6;
  const cacheRead = h * rates.read / 1e6, cacheWrite = write ? write * rates.write / 1e6 : 0, output = o * rates.output / 1e6;
  const total = normalInput + cacheRead + cacheWrite + output;
  return { calculable: true, estimated: true, normalInput, cacheRead, cacheWrite, output, total,
    inputSavings: p * rates.input / 1e6 - normalInput - cacheRead - cacheWrite, currency: rates.currency, source: rates.source, asOf: rates.asOf };
}
