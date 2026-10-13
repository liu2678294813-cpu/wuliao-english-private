import { normalizeAiApiBaseUrl } from "../ai.js";
import { WRITING_AI_PROMPT_VERSIONS } from "./writingAiTasks.js";
import { parseWritingAiJson, validateVisionPageTranscript } from "./writingAiSchemas.js";
import { getProviderProfile, normalizeProviderProfile, normalizeUsage } from "../aiProvider.js";
import { providerCacheRequestFields, noteRejectedCacheParameter } from "../aiCachePolicy.js";
import { getCurrentUsername } from "../userData.js";
import { fingerprintAiInput } from "../aiTasks.js";
import { getTelemetry } from "../telemetry/telemetry.js";

export const VisionCapabilityStatus = Object.freeze(["supported", "unsupported", "auth_error", "rate_limit", "network_error", "timeout", "provider_error", "invalid_response"]);

function responseCategory(status, message = "") {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_error";
  if (/(image|multimodal).*(unsupported|not support)|(unsupported|not support).*(image|multimodal)|does not support.*image/i.test(message)) return "unsupported";
  return "provider_error";
}
function fromError(error) {
  if (error?.category) return error.category;
  if (error?.name === "AbortError") return "abort";
  if (error instanceof TypeError) return "network_error";
  return "provider_error";
}
function cleanModelList(value) { const rows = Array.isArray(value) ? value : value?.data; return Array.isArray(rows) ? [...new Set(rows.map((item) => String(item?.id || item?.name || item || "").trim()).filter(Boolean))] : []; }
async function dataUrl(blob) { const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return `data:${blob.type || "image/png"};base64,${btoa(binary)}`; }

export function createOpenAiCompatibleVisionProvider({ fetchFn = globalThis.fetch, timeoutMs = 30000, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  if (typeof fetchFn !== "function") throw new TypeError("fetch is unavailable");
  async function request(config, apiKey, path, init, signal) {
    const baseUrl = normalizeAiApiBaseUrl(config?.baseUrl); if (!baseUrl) throw new Error("Vision base URL is required");
    const username = getCurrentUsername(), startedAt = performance.now(), telemetry = getTelemetry();
    const { taskType = "writing.vision.transcribe.v1", ...fetchInit } = init;
    const inference = path === "chat/completions";
    const configured = getProviderProfile("vision");
    const profile = configured?.baseUrl === baseUrl ? configured : normalizeProviderProfile({ providerId: "custom", endpointKind: "custom", modality: "vision", baseUrl });
    const body = inference ? JSON.parse(fetchInit.body) : null;
    const accountScope = fingerprintAiInput(["ai-cache-account-v1", username]);
    const modelId = body?.model || "";
    const cache = inference ? providerCacheRequestFields({ profile, model: modelId, transport: "openai-chat-completions", messages: body.messages, username }) : null;
    const cacheContext = { providerId: profile.providerId, transportKind: "openai-chat-completions", policyReason: cache?.policy.reason || "", accountScope,
      endpointIdentity: fingerprintAiInput([profile.providerId, baseUrl]) };
    if (inference) fetchInit.body = JSON.stringify({ ...body, ...cache.fields });
    const controller = new AbortController(); let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener?.("abort", abort, { once: true });
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimer(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
    try {
      if (controller.signal.aborted) throw new DOMException("Vision request cancelled", "AbortError");
      let response, body;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (controller.signal.aborted || username !== getCurrentUsername()) throw new DOMException("Vision request cancelled", "AbortError");
        const attemptStarted = performance.now();
        if (inference) telemetry.recordEvent({ eventType: "ai.api_request_started", taskType, model: modelId, metadata: cacheContext });
        response = await fetchFn(`${baseUrl}/${path}`, { ...fetchInit, headers: { Authorization: `Bearer ${apiKey}`, ...(fetchInit.headers || {}) }, signal: controller.signal });
        body = await response.json().catch(() => null);
        if (controller.signal.aborted || username !== getCurrentUsername()) break;
        if (attempt === 0 && inference && !response.ok && noteRejectedCacheParameter({ profile, model: modelId, transport: "openai-chat-completions", fields: cache.fields, status: response.status, data: body })) {
          telemetry.recordApiRequest({ taskType, model: modelId, status: "error", category: "cache_parameter_rejected", durationMs: performance.now() - attemptStarted, usage: normalizeUsage(body?.usage), ...cacheContext });
          const plain = JSON.parse(fetchInit.body);
          for (const field of Object.keys(cache.fields)) delete plain[field];
          fetchInit.body = JSON.stringify(plain);
          cacheContext.policyReason = "cache_parameter_rejected_plain_request";
          continue;
        }
        break;
      }
      if (controller.signal.aborted || username !== getCurrentUsername()) throw new DOMException("Vision request cancelled", "AbortError");
      if (!response.ok) { const error = new Error(body?.error?.message || `Vision request failed (${response.status})`); error.status = response.status; error.category = responseCategory(response.status, error.message); throw error; }
      if (inference) telemetry.recordApiRequest({ taskType, model: modelId, usage: normalizeUsage(body?.usage), durationMs: performance.now() - startedAt, ...cacheContext });
      return body;
    } catch (error) {
      if (error?.name === "AbortError") error.category = timedOut ? "timeout" : "abort";
      else if (!error?.category) error.category = fromError(error);
      if (inference) telemetry.recordApiRequest({ taskType, model: modelId, status: error.category === "abort" ? "cancelled" : "error", category: error.category, durationMs: performance.now() - startedAt, ...cacheContext });
      throw error;
    } finally {
      if (timer !== null) clearTimer(timer);
      signal?.removeEventListener?.("abort", abort);
    }
  }
  return Object.freeze({
    async listModels({ config, apiKey, signal }) { return cleanModelList(await request(config, apiKey, "models", { method: "GET" }, signal)); },
    async transcribePage({ config, apiKey, modelId, imageBlob, pageId, promptVersion = WRITING_AI_PROMPT_VERSIONS.transcription, signal }) {
      const imageUrl = await dataUrl(imageBlob);
      const system = `Faithfully transcribe the handwriting. Preserve exactly what the user wrote, including spelling, capitalization, punctuation, grammatical errors, and incomplete words where visible. Do not correct spelling or grammar. Do not rewrite, polish, complete missing words, infer a better sentence, score, assess quality, provide advice, or compare with a sample. Return only JSON {"pageId":"...","text":"verbatim transcription","segments":[{"text":"...","confidence":null,"unsure":false}]}. Use confidence as a number from 0 to 1 only when reliable, otherwise null; always include unsure as a boolean. Version: ${promptVersion}`;
      const body = await request(config, apiKey, "chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelId, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: [{ type: "text", text: `Transcribe pageId ${pageId}.` }, { type: "image_url", image_url: { url: imageUrl } }] }] }) }, signal);
      return validateVisionPageTranscript(parseWritingAiJson(body?.choices?.[0]?.message?.content || ""), { pageId });
    },
    async probe({ config, apiKey, modelId, imageBlob, signal }) {
      try {
        const imageUrl = await dataUrl(imageBlob);
        const body = await request(config, apiKey, "chat/completions", { method: "POST", taskType: "writing.vision.probe.v1", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelId, temperature: 0, messages: [{ role: "user", content: [{ type: "text", text: "读取图片中的 token，仅返回该 token。" }, { type: "image_url", image_url: { url: imageUrl } }] }] }) }, signal);
        const token = String(body?.choices?.[0]?.message?.content || "").trim().replace(/^['"`]|['"`]$/g, "");
        return { status: token === "WL7" ? "supported" : "invalid_response" };
      } catch (error) { return { status: error?.category || fromError(error) }; }
    },
  });
}

export async function createWl7ProbeImage({ documentRef = globalThis.document } = {}) {
  if (!documentRef?.createElement) throw new Error("Vision probe image encoder is unavailable");
  const canvas = documentRef.createElement("canvas"); canvas.width = 160; canvas.height = 80;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Vision probe canvas is unavailable");
  context.fillStyle = "white"; context.fillRect(0, 0, 160, 80); context.fillStyle = "black"; context.font = "bold 48px sans-serif"; context.fillText("WL7", 20, 58);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Vision probe encoding failed")), "image/png"));
}
