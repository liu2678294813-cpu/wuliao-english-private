import { callAi as callProviderAi, isSupportedAiModel, resolveAiModel } from "./ai";
import { clearAiResultMemory, runCachedAiResult } from "./aiReviewCache";
import { getCurrentUsername } from "./userData.js";
import { getProviderProfile, resolveModelTransport } from "./aiProvider.js";
import { fingerprintAiInput } from "./aiTasks.js";
import {
  TASK_CLOZE_HINT_1,
  TASK_CLOZE_HINT_2,
  buildClozeAiFingerprint,
  buildClozeAiMessages,
  clozeAiTaskLabel,
  isClozeAiTask,
} from "./clozeAiTasks";
import {
  detectClozeHintLeak,
  hasAuthenticClozeEvidence,
  parseClozeAiResult,
} from "./clozeAiResultParsers";

function assistantFor(taskType, detail, payload) {
  return {
    role: "assistant",
    label: clozeAiTaskLabel(taskType),
    clozeAi: true,
    taskType,
    clozeAiMeta: detail,
    ...payload,
  };
}

export async function runClozeAiTask({
  taskType,
  detail,
  safetyOptionTexts = [],
  apiKey,
  model = null,
  useCache = true,
  callAi = callProviderAi,
  signal = null,
  isCurrent = () => true,
}) {
  if (!isClozeAiTask(taskType) || !detail) {
    return { status: "invalid", assistant: assistantFor(taskType, detail, { content: "完形 AI 请求无效。", retryable: false }) };
  }
  const resolvedModel = isSupportedAiModel(model) ? String(model).trim() : resolveAiModel(taskType);
  const profile = getProviderProfile("text");
  const fingerprint = fingerprintAiInput({ base: buildClozeAiFingerprint(taskType, detail, resolvedModel),
    messages: buildClozeAiMessages(taskType, detail), safetyOptionTexts, binding: apiKey ? fingerprintAiInput(apiKey) : "bound-profile" });
  const hints = [TASK_CLOZE_HINT_1, TASK_CLOZE_HINT_2].includes(taskType);
  if (hints && ["options", "officialAnswer", "firstAnswer", "reviewAnswer", "localAttempts", "manualAnalysis"].some(key => detail[key] != null)) {
    return { status: "invalid", assistant: assistantFor(taskType, detail, { content: "提示不允许携带答案或作答数据。", retryable: false }) };
  }
  const username = getCurrentUsername();
  const current = () => username === getCurrentUsername() && isCurrent() && !signal?.aborted;
  const request = async ({ signal: networkSignal, isCurrent: active }) => {
    let lastRaw = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await callAi({
          apiKey,
          profile,
          model: resolvedModel,
          messages: buildClozeAiMessages(taskType, detail, { strict: attempt === 1 }),
          temperature: taskType === TASK_CLOZE_HINT_1 || taskType === TASK_CLOZE_HINT_2 ? 0.25 : 0.35,
          taskType,
          signal: networkSignal,
        });
        if (networkSignal.aborted || !active()) throw new DOMException("Stale cloze request", "AbortError");
        lastRaw = String(response?.content || "");
        if ([TASK_CLOZE_HINT_1, TASK_CLOZE_HINT_2].includes(taskType)) {
          const leak = detectClozeHintLeak(lastRaw, safetyOptionTexts);
          if (leak.leaked) {
            if (attempt === 0) continue;
            return { status: "unsafe", assistant: assistantFor(taskType, detail, { content: "提示可能泄露答案，已拦截；请重试。", retryable: true, leakReasons: leak.reasons }) };
          }
        }
        const parsed = parseClozeAiResult(lastRaw, taskType, detail);
        const evidenceOk = parsed && hasAuthenticClozeEvidence(parsed, taskType);
        if (!parsed || !evidenceOk) {
          if (attempt === 0) continue;
          return { status: "parse-failed", raw: lastRaw, assistant: assistantFor(taskType, detail, { content: "AI 返回未通过结构或原文证据校验，已拦截。", retryable: true }) };
        }
        return { status: "ok", cached: false, result: parsed, assistant: assistantFor(taskType, detail, { structured: parsed, reasoning: String(response?.reasoning || "") }) };
      } catch (reason) {
        if (reason?.name === "AbortError" || networkSignal.aborted || !active()) throw new DOMException("Cloze request cancelled", "AbortError");
        return { status: "error", assistant: assistantFor(taskType, detail, { content: `请求失败：${reason instanceof Error ? reason.message : String(reason)}`, retryable: true }) };
      }
    }
    return { status: "parse-failed", raw: lastRaw, assistant: assistantFor(taskType, detail, { content: "AI 返回无法使用。", retryable: true }) };
  };
  try {
    const response = await runCachedAiResult({ namespace: "cloze-task", fingerprint, username, signal, isCurrent: current,
      force: !useCache, cacheContext: { providerId: profile.providerId, model: resolvedModel, transportKind: resolveModelTransport(resolvedModel, profile), taskType },
      request, cacheable: value => value?.status === "ok",
      validate: value => value?.status !== "ok" || (Boolean(parseClozeAiResult(JSON.stringify(value.result), taskType, detail)) && hasAuthenticClozeEvidence(value.result, taskType) && (!hints || !detectClozeHintLeak(JSON.stringify(value.result), safetyOptionTexts).leaked)) });
    const value = response.result;
    return { ...value, cached: response.cached, cacheSource: response.source,
      assistant: { ...value.assistant, ...(response.cached ? { cached: true } : {}) } };
  } catch (reason) {
    if (reason?.name === "AbortError") return { status: "aborted", cached: false, assistant: null };
    throw reason;
  }
}

export function clearClozeAiInflightForTests() {
  clearAiResultMemory();
}
