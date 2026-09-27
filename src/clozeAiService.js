import { callAi as callProviderAi, isSupportedAiModel, resolveAiModel } from "./ai";
import { readClozeAiCache, writeClozeAiCache } from "./clozeAiCache";
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

const inflight = new Map();

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
}) {
  if (!isClozeAiTask(taskType) || !detail) {
    return { status: "invalid", assistant: assistantFor(taskType, detail, { content: "完形 AI 请求无效。", retryable: false }) };
  }
  const resolvedModel = isSupportedAiModel(model) ? String(model).trim() : resolveAiModel(taskType);
  const fingerprint = buildClozeAiFingerprint(taskType, detail, resolvedModel);
  if (useCache) {
    const cached = readClozeAiCache(fingerprint);
    if (cached) return { status: "ok", cached: true, result: cached, assistant: assistantFor(taskType, detail, { structured: cached, cached: true }) };
  }
  if (inflight.has(fingerprint)) return inflight.get(fingerprint);

  const promise = (async () => {
    let lastRaw = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await callAi({
          apiKey,
          model: resolvedModel,
          messages: buildClozeAiMessages(taskType, detail, { strict: attempt === 1 }),
          temperature: taskType === TASK_CLOZE_HINT_1 || taskType === TASK_CLOZE_HINT_2 ? 0.25 : 0.35,
          taskType,
          signal,
        });
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
        writeClozeAiCache(fingerprint, parsed);
        return { status: "ok", cached: false, result: parsed, assistant: assistantFor(taskType, detail, { structured: parsed, reasoning: String(response?.reasoning || "") }) };
      } catch (reason) {
        return { status: "error", assistant: assistantFor(taskType, detail, { content: `请求失败：${reason instanceof Error ? reason.message : String(reason)}`, retryable: true }) };
      }
    }
    return { status: "parse-failed", raw: lastRaw, assistant: assistantFor(taskType, detail, { content: "AI 返回无法使用。", retryable: true }) };
  })().finally(() => inflight.delete(fingerprint));

  inflight.set(fingerprint, promise);
  return promise;
}

export function clearClozeAiInflightForTests() {
  inflight.clear();
}
