import { getCurrentUsername, getUserItem, removeUserItem, setUserItem } from "./userData";
import { classifyAiError } from "./aiError";
import { getTelemetry } from "./telemetry/telemetry";
import { fingerprintAiInput } from "./aiTasks";
import { runCachedAiResult, readAiResult } from "./aiReviewCache";
import { lookupUnknownWordMeaning } from "./unknownWords";
import {
  AI_PROVIDER_PROFILE_KEY,
  bindCredential as bindV2Credential,
  getCredential as getV2Credential,
  getProviderProfile as getV2ProviderProfile,
  normalizeUsage as normalizeProviderUsage,
  normalizeProviderEndpoint as normalizeV2ProviderEndpoint,
  saveProviderProfile as saveV2ProviderProfile,
} from "./aiProvider.js";

export {
  AI_PROVIDERS,
  ALIBABA_REGIONS,
  RUNTIME_STATUS,
  SUPPORT_STATUS,
  TRANSPORT_KINDS,
  bindCredential,
  callAi,
  callCachedTextAi,
  readTextAiCache,
  createCredentialScope,
  credentialBindingStatus,
  credentialScopeId,
  fetchProviderModels,
  getCachedProviderModels,
  getCredential,
  getProviderProfile,
  getRuntimeEvidence,
  listAiProviders,
  normalizeProviderEndpoint,
  normalizeProviderModels,
  normalizeProviderProfile,
  rebindCredential,
  recordRuntimeEvidence,
  resolveModelTransport,
  saveProviderProfile,
  testProviderConnection,
} from "./aiProvider.js";

const HISTORY_KEY = "wuliao:ai:history";
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const AI_MODEL_STORAGE_KEY = "wuliao:ai:model";
export const AI_API_CONFIG_STORAGE_KEY = "wuliao:ai:api-config";
export const AI_MODEL_CATALOG_STORAGE_KEY = "wuliao:ai:model-catalog";
export const DEFAULT_AI_API_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_AI_MODEL = "deepseek-chat";
const AI_MODEL_ID_MAX_LENGTH = 256;
const AI_MODEL_LIST_TIMEOUT_MS = 10000;

// 仅作为尚未读取接口目录时的 DeepSeek 兜底选项；并不限制用户选择
// OpenAI-compatible 接口实际返回的其它模型（例如 DeepSeek Flash）。
export const SUPPORTED_AI_MODELS = Object.freeze([
  DEFAULT_AI_MODEL,
  "deepseek-reasoner",
]);

function normalizeAiModelId(value) {
  const model = String(value || "").trim();
  return model && model.length <= AI_MODEL_ID_MAX_LENGTH && !/[\u0000-\u001f]/.test(model) ? model : "";
}

function uniqueModelIds(values) {
  const seen = new Set();
  const models = [];
  for (const value of Array.isArray(values) ? values : []) {
    const model = normalizeAiModelId(typeof value === "object" && value
      ? (value.id ?? value.name ?? value.model)
      : value);
    if (model && !seen.has(model)) {
      seen.add(model);
      models.push(model);
    }
  }
  return models;
}

export function isSupportedAiModel(value) {
  return Boolean(normalizeAiModelId(value));
}

export function getPreferredAiModel() {
  try {
    if (getUserItem(`${AI_PROVIDER_PROFILE_KEY}:text`)) {
      return getV2ProviderProfile("text")?.modelId || DEFAULT_AI_MODEL;
    }
    const value = String(getUserItem(AI_MODEL_STORAGE_KEY) || "").trim();
    return isSupportedAiModel(value) ? value : DEFAULT_AI_MODEL;
  } catch {
    return DEFAULT_AI_MODEL;
  }
}

export function setPreferredAiModel(value) {
  const model = normalizeAiModelId(value) || DEFAULT_AI_MODEL;
  try {
    if (getUserItem(`${AI_PROVIDER_PROFILE_KEY}:text`)) {
      saveV2ProviderProfile({ ...getV2ProviderProfile("text"), modelId: model });
      return model;
    }
    setUserItem(AI_MODEL_STORAGE_KEY, model);
    return model;
  } catch {
    return getPreferredAiModel();
  }
}

// 所有正式产品任务共用账号级选择。保留 taskType 参数，避免调用方各自决定
// 模型；开发者 live eval 继续走它自己的显式配置，不读取此偏好。
export function resolveAiModel(taskType = "") {
  void taskType;
  return getPreferredAiModel();
}

export function normalizeAiApiBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try { return normalizeV2ProviderEndpoint(raw).baseUrl; } catch { return ""; }
}

export function getAiApiConfig() {
  try {
    if (getUserItem(`${AI_PROVIDER_PROFILE_KEY}:text`)) {
      return { baseUrl: getV2ProviderProfile("text")?.baseUrl || DEFAULT_AI_API_BASE_URL };
    }
    const stored = JSON.parse(getUserItem(AI_API_CONFIG_STORAGE_KEY) || "{}");
    const baseUrl = normalizeAiApiBaseUrl(stored?.baseUrl);
    return { baseUrl: baseUrl || DEFAULT_AI_API_BASE_URL };
  } catch {
    return { baseUrl: DEFAULT_AI_API_BASE_URL };
  }
}

export function setAiApiConfig(value = {}) {
  const requestedBaseUrl = String(value?.baseUrl || "").trim();
  const baseUrl = requestedBaseUrl ? normalizeAiApiBaseUrl(requestedBaseUrl) : DEFAULT_AI_API_BASE_URL;
  if (!baseUrl) throw new Error("API Base URL 必须是合法的 HTTPS 地址");
  const previous = getAiApiConfig().baseUrl;
  setUserItem(AI_API_CONFIG_STORAGE_KEY, JSON.stringify({ version: 1, baseUrl }));
  if (previous !== baseUrl) removeUserItem(AI_MODEL_CATALOG_STORAGE_KEY);
  return { baseUrl };
}

export function getAiModelCatalog(baseUrl = getAiApiConfig().baseUrl) {
  const expectedBaseUrl = normalizeAiApiBaseUrl(baseUrl) || getAiApiConfig().baseUrl;
  try {
    const stored = JSON.parse(getUserItem(AI_MODEL_CATALOG_STORAGE_KEY) || "{}");
    if (stored?.baseUrl !== expectedBaseUrl) return [];
    return uniqueModelIds(stored.models);
  } catch {
    return [];
  }
}

export function setAiModelCatalog(models, { baseUrl = getAiApiConfig().baseUrl } = {}) {
  const normalizedBaseUrl = normalizeAiApiBaseUrl(baseUrl);
  if (!normalizedBaseUrl) throw new Error("无法保存模型列表：API Base URL 无效");
  const list = uniqueModelIds(models);
  setUserItem(AI_MODEL_CATALOG_STORAGE_KEY, JSON.stringify({
    version: 1,
    baseUrl: normalizedBaseUrl,
    models: list,
    updatedAt: Date.now(),
  }));
  return list;
}

export function getAiModelOptions() {
  const catalog = getAiModelCatalog();
  return uniqueModelIds([
    ...catalog,
    ...(catalog.length ? [] : SUPPORTED_AI_MODELS),
    getPreferredAiModel(),
  ]);
}

export function getAiApiCacheScope() {
  const profile = getV2ProviderProfile("text");
  return JSON.stringify([profile.providerId, profile.baseUrl, profile.transportKind, profile.credentialScopeId]);
}

function getAiApiUrl(path, baseUrl = getAiApiConfig().baseUrl) {
  return `${baseUrl}/${path}`;
}

function modelRowsFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.result?.data)) return data.result.data;
  return null;
}

export async function listAiProviderModels({
  apiKey,
  baseUrl = getAiApiConfig().baseUrl,
  timeoutMs = AI_MODEL_LIST_TIMEOUT_MS,
  signal = null,
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("请先在 AI API 设置中填写 API Key");
  const normalizedBaseUrl = normalizeAiApiBaseUrl(baseUrl);
  if (!normalizedBaseUrl) throw new Error("API Base URL 必须是合法的 HTTPS 地址");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = signal && typeof signal.aborted === "boolean" ? signal : null;
  const onExternalAbort = externalSignal
    ? () => {
      if (externalSignal.aborted) controller.abort();
    }
    : null;
  if (externalSignal && onExternalAbort) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const response = await fetch(getAiApiUrl("models", normalizedBaseUrl), {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error?.message || `模型列表请求失败（${response.status}）`);
    }
    const rows = modelRowsFromResponse(data);
    if (!rows) throw new Error("模型列表响应不是 OpenAI-compatible 的 models 格式");
    return uniqueModelIds(rows);
  } catch (reason) {
    if (controller.signal.aborted) throw new Error("读取模型列表超时，请检查网络后重试");
    throw reason;
  } finally {
    window.clearTimeout(timeout);
    if (externalSignal && onExternalAbort) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

export const EXPLAIN_SYSTEM_PROMPT = `请按英语长难句的方式讲解下面这句话，不要一开始直接给出完整翻译。
自动检索必要的上下文再进行分析
(如果用户提供了他的分析则按下面要求分析，如果没提供用户做的内容则忽略掉相关需要用户提供的分析步骤，再进行分析)
请严格按照以下顺序讲解：
先判断这句话真正的主干，明确主语、谓语、宾语或表语。
对我的分析逐项判断“对或不对”，直接指出我具体错在哪里，不要笼统地说结构复杂。
按意群给原句断句，并说明每一部分修饰谁、与谁构成关系。
标出所有从句和非谓语结构，说明其类型和句法作用，例如定语从句、同位语从句、宾语从句、状语从句、分词短语、不定式等。
说明连接词、代词和介词分别指向什么，尤其解释 that、which、it、this、as、while 等词在本句中的作用。
对我不认识或义项拿不准的单词，先判断词性和搭配，再说明为什么在本句取这个意思，不要罗列无关义项。
先按照英文结构给出贴近原文的直译，再调整为自然中文；说明从直译调整为顺译时改变了什么。
最后把句子压缩成一个可快速识别的结构公式，例如：
主句 + 定语从句 + 原因状语；
或“某人认为 + 宾语从句”。
最后总结我这次错误属于哪一类：主干识别、修饰关系、从句类型、词义选择、指代关系还是逻辑关系。
讲解时以让我以后能独立拆句为目标，不要只给标准译文。`;

function readHistory() {
  try {
    const parsed = JSON.parse(getUserItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHistory(records) {
  setUserItem(HISTORY_KEY, JSON.stringify(records));
}

export function listAiHistory() {
  const now = Date.now();
  return readHistory()
    .filter((record) => record.favorite || (now - (record.updatedAt || record.createdAt || 0)) <= HISTORY_TTL_MS)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function createAiHistoryRecord(meta) {
  const records = listAiHistory();
  const chapter = meta.chapter
    || (meta.resource?.kind === "official"
      ? `英一.${String(meta.resource.year).slice(-2)}.text${meta.resource.text}`
      : (meta.resource?.title || meta.passage?.label || "自定义"));
  const gist = String(meta.sentence || meta.text || "").replace(/\s+/g, " ").trim().slice(0, 16);
  const record = {
    id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chapter,
    name: meta.name || (gist ? `${chapter} · ${gist}` : chapter),
    sentence: meta.sentence || meta.text || "",
    kind: meta.kind || "chat",
    model: meta.model || resolveAiModel(meta.kind),
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    favorite: false,
    // 可选附加 metadata（R6）：完形 AI 记录可携带稳定身份
    // { sourceType:"cloze", resourceId, clozeId, blankNumber, taskType }，
    // 用于档案/结果页确定性关联。旧记录无此字段，阅读行为不受影响。
    metadata: meta.metadata && typeof meta.metadata === "object" ? { ...meta.metadata } : null,
  };
  records.unshift(record);
  writeHistory(records);
  return record;
}

export function appendAiHistoryMessage(id, message) {
  const records = readHistory();
  const record = records.find((item) => item.id === id);
  if (!record) return;
  record.messages.push(message);
  record.updatedAt = Date.now();
  writeHistory(records);
}

export function toggleAiHistoryFavorite(id) {
  const records = readHistory();
  const record = records.find((item) => item.id === id);
  if (!record) return false;
  record.favorite = !record.favorite;
  record.updatedAt = Date.now();
  writeHistory(records);
  return record.favorite;
}

export function loadAiHistoryRecord(id) {
  const record = readHistory().find((item) => item.id === id);
  return record || null;
}

export async function getAiApiKey() {
  const username = getCurrentUsername();
  if (!username) return "";
  if (getUserItem(`${AI_PROVIDER_PROFILE_KEY}:text`, username)) {
    return (await getV2Credential(getV2ProviderProfile("text"), { username })).value;
  }
  const secureStore = globalThis.window?.AndroidSecureStore;
  if (secureStore?.get) {
    try {
      const key = `ai:apikey:${encodeURIComponent(username)}`;
      let value = String(await secureStore.get(key) || "").trim();
      const legacyValue = (getUserItem("wuliao:ai:apikey") || "").trim();
      if (!value && legacyValue && secureStore?.set) {
        await secureStore.set(key, legacyValue);
        value = String(await secureStore.get(key) || "").trim();
      }
      if (value && legacyValue && value === legacyValue) removeUserItem("wuliao:ai:apikey");
      return value;
    } catch {
      return "";
    }
  }
  return (getUserItem("wuliao:ai:apikey") || "").trim();
}

export async function setAiApiKey(value) {
  const username = getCurrentUsername();
  if (!username) throw new Error("请先登录账号");
  if (getUserItem(`${AI_PROVIDER_PROFILE_KEY}:text`, username)) {
    await bindV2Credential(getV2ProviderProfile("text"), value, { username });
    return;
  }
  const key = `ai:apikey:${encodeURIComponent(username)}`;
  const trimmed = String(value || "").trim();
  const secureStore = globalThis.window?.AndroidSecureStore;
  if (secureStore?.set) {
    if (trimmed) {
      await secureStore.set(key, trimmed);
      if (String(await secureStore.get?.(key) || "").trim() !== trimmed) {
        throw new Error("Android 安全存储无法确认 API Key 写入");
      }
    } else await secureStore.remove?.(key);
    removeUserItem("wuliao:ai:apikey");
    return;
  }
  if (trimmed) setUserItem("wuliao:ai:apikey", trimmed);
  else removeUserItem("wuliao:ai:apikey");
}

export async function testAiApiKey(apiKey, baseUrl = getAiApiConfig().baseUrl) {
  await listAiProviderModels({ apiKey, baseUrl });
  return true;
}

// 兼容现有调用方；现在同样可验证任意 OpenAI-compatible API。
export async function testDeepSeekKey(apiKey) {
  return testAiApiKey(apiKey);
}

export async function callDeepSeek({
  apiKey,
  model = null,
  messages,
  temperature = 0.6,
  timeoutMs = 90000,
  taskType = "chat",
  signal = null,
}) {
  if (!apiKey) throw new Error("请先在 AI API 设置中填写 API Key");
  const resolvedModel = normalizeAiModelId(model) || resolveAiModel(taskType);
  const { baseUrl } = getAiApiConfig();
  const telemetry = getTelemetry();
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = signal && typeof signal.aborted === "boolean" ? signal : null;
  const onExternalAbort = externalSignal
    ? () => {
      if (externalSignal.aborted) controller.abort();
    }
    : null;
  if (externalSignal && onExternalAbort) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const response = await fetch(getAiApiUrl("chat/completions", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: resolvedModel, messages, temperature, stream: false }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data?.error?.message || `AI API 请求失败（${response.status}）`;
      const failure = new Error(message);
      failure.name = "AiProviderHttpError";
      failure.status = response.status;
      failure.providerCode = data?.error?.code || null;
      throw failure;
    }
    const choice = data?.choices?.[0];
    if (!choice?.message) throw new Error("AI API 返回为空，请重试");
    const usage = normalizeProviderUsage(data?.usage);
    telemetry.recordApiRequest({
      taskType,
      model: resolvedModel,
      status: "success",
      durationMs: performance.now() - startedAt,
      usage,
    });
    return {
      content: String(choice.message.content || ""),
      reasoning: String(choice.message.reasoning_content || choice.message.reasoning || ""),
      ...(usage ? { usage } : {}),
    };
  } catch (reason) {
    const classified = classifyAiError(reason);
    telemetry.recordApiRequest({
      taskType,
      model: resolvedModel,
      status: "error",
      category: classified.category,
      durationMs: performance.now() - startedAt,
    });
    telemetry.recordError({
      taskType,
      category: classified.category,
      message: classified.message,
      metadata: { model: resolvedModel },
    });
    throw reason;
  } finally {
    window.clearTimeout(timeout);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export function buildExplainMessages({ sentence, paragraph, chapter, userInput }) {
  const contextParts = [];
  if (chapter) contextParts.push(`【文章】${chapter}`);
  if (paragraph) contextParts.push(`【所在段落】\n${paragraph}`);
  const context = contextParts.join("\n");
  const user = [
    context ? `${context}\n` : "",
    `【句子】\n${sentence}`,
    userInput ? `\n【我的分析/问题】\n${userInput}` : "",
  ].join("");
  return [
    { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

export function buildQuickTranslateMessages(text) {
  return [
    {
      role: "system",
      content: "你是一位专业英语翻译。请把用户给出的英文翻译成自然、准确的中文。只输出译文本身，不要加任何解释、引号或额外内容。",
    },
    { role: "user", content: String(text || "") },
  ];
}

export function buildWordMeaningMessages({ word, sentence }) {
  return [
    {
      role: "system",
      content: "你是英语词汇老师。只输出这个单词在当前句子中最合适的简短中文释义（一到两个义项），不要解释、不要列举其它义项、不要输出任何其它内容。",
    },
    { role: "user", content: `单词：${word}\n所在句子：${sentence || "（无上下文）"}` },
  ];
}

export const QUICK_TRANSLATE_PROMPT_VERSION = 2;
export function normalizeQuickTranslationInput(text, kind = "sentence") {
  let value = String(text || "").normalize("NFKC").replace(/\r\n?/g, "\n").trim().replace(/[ \t\n]+/g, " ");
  if (kind === "word" && /^[A-Z]?[a-z]+(?:['’-][a-z]+)*$/.test(value)) value = value.toLowerCase();
  return value;
}
export function quickTranslationIdentity({ text, kind = "sentence", contextSentence = "", model, promptVersion = QUICK_TRANSLATE_PROMPT_VERSION }) {
  const normalizedInput = normalizeQuickTranslationInput(text, kind);
  const namespace = contextSentence ? "context-word" : `quick-${kind}`;
  const input = { taskType: namespace, text: normalizedInput, promptVersion, schemaVersion: 1 };
  if (contextSentence) input.sentence = normalizeQuickTranslationInput(contextSentence);
  if (namespace !== "quick-word") { input.model = model || resolveAiModel("quick-translate"); input.provider = getAiApiCacheScope(); }
  const fingerprint = fingerprintAiInput(input);
  return { namespace, fingerprint, identity: fingerprint, normalizedInput };
}
export function readQuickTranslationCache(options) {
  const key = quickTranslationIdentity(options);
  return readAiResult(key.namespace, key.fingerprint, key.identity);
}
export async function runQuickTranslation({ text, kind = "sentence", contextSentence = "", model,
  apiKey, signal, isCurrent, force = false, onNetworkStart, dictionary = lookupUnknownWordMeaning }) {
  const username = getCurrentUsername(), key = quickTranslationIdentity({ text, kind, contextSentence, model });
  const current = () => !signal?.aborted && username === getCurrentUsername() && (!isCurrent || isCurrent());
  if (!current()) throw new DOMException("Stale quick translation", "AbortError");
  if (!force && kind === "word" && !contextSentence && /^[a-z]+(?:['’-][a-z]+)*$/.test(key.normalizedInput)) {
    const meaning = await dictionary(key.normalizedInput).catch(() => "");
    if (!current()) throw new DOMException("Stale quick translation", "AbortError");
    if (meaning) return { result: { translation: meaning }, cached: true, source: "dictionary" };
  }
  const response = await runCachedAiResult({ ...key, username, signal, isCurrent: current, force,
    request: async ({ signal }) => {
      onNetworkStart?.();
      const { callAi } = await import("./aiProvider.js");
      const messages = contextSentence ? buildWordMeaningMessages({ word: key.normalizedInput, sentence: normalizeQuickTranslationInput(contextSentence) })
        : kind === "word" ? [{ role: "system", content: "你是英语词汇老师。请给出该词的简短、准确的常规中文释义（一到两个义项）。保留缩写和大小写的含义差别。只输出释义，不要解释或添加其它内容。" }, { role: "user", content: key.normalizedInput }]
          : buildQuickTranslateMessages(key.normalizedInput);
      const response = await callAi({ apiKey, model: model || resolveAiModel("quick-translate"), messages, temperature: 0.3, taskType: key.namespace, signal });
      return { translation: String(response.content || "").trim() };
    }, validate: result => Boolean(result?.translation?.trim()) });
  return response;
}

export async function lookupWordMeaningWithAi({ apiKey, word, sentence, model = null, signal, isCurrent }) {
  const { callCachedTextAi } = await import("./aiProvider.js");
  const result = await callCachedTextAi({
    apiKey,
    model,
    messages: buildWordMeaningMessages({ word, sentence }),
    temperature: 0.2,
    timeoutMs: 30000,
    taskType: "word-meaning",
    signal, isCurrent,
  });
  return result.content.trim();
}
