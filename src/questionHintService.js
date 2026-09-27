import { getCurrentUsername } from "./userData";
function validaterunQuestionHint({ taskType, detail = {} }) {
  const level = levelForTask(taskType);
  const questionText = String(detail.questionText || "").trim();
  const articleText = String(detail.articleText || "").trim();
  const questionId = String(detail.questionId || "").trim();
  const key = questionHintKey(detail);

  if (level < 3 && (detail.options || detail.officialAnswer || detail.firstAnswer || detail.redoAnswer || detail.drawerAnswer)) {
    const message = "一级/二级提示不允许携带选项或答案数据";
    return {
      status: "invalid",
      message,
      assistant: makeAssistant({ status: "invalid", taskType, level, message, detail }),
    };
  }
  if (!questionText || !articleText || !questionId) {
    const message = "缺少题干或文章内容，无法生成提示";
    return {
      status: "invalid",
      message,
      assistant: makeAssistant({ status: "invalid", taskType, level, message, detail }),
    };
  }
  if (level === 3 && (!detail.canShowFullExplanation || !detail.officialAnswer)) {
    return {
      status: "blocked",
      message: "当前学习流程不允许查看完整讲解",
      assistant: makeAssistant({ status: "blocked", taskType, level, detail }),
    };
  }
  return null;
}

import { runCachedAiResult } from "./aiReviewCache";
import { fingerprintAiInput } from "./aiTasks";
import {
  appendAiHistoryMessage,
  callAi,
  createAiHistoryRecord,
  getAiApiCacheScope,
  listAiHistory,
  resolveAiModel,
} from "./ai";
import { getUserItem, setUserItem } from "./userData";
import {
  QUESTION_HINT_PROMPT_VERSION,
  TASK_QUESTION_EXPLANATION,
  TASK_QUESTION_HINT_1,
  TASK_QUESTION_HINT_2,
  buildQuestionExplanationMessages,
  buildQuestionHintFingerprint,
  buildQuestionHintLevel1Messages,
  buildQuestionHintLevel2Messages,
  buildQuestionHintStrictMessages,
} from "./aiTasks";
import { parseQuestionHintResult } from "./aiResultParsers";
import { validateHintNoAnswerLeak } from "./questionHintSafety";
import { readQuestionHintCache, writeQuestionHintCache } from "./aiReviewCache";
import { classifyAiError } from "./aiReviewService";
import { getTelemetry } from "./telemetry/telemetry";

const PROGRESS_KEY = "wuliao:ai:question-hint-progress";
const HINT_TIMEOUT_MS = 60000;
const EXPLANATION_TIMEOUT_MS = 120000;



const HINT_TASK_INFO = {
  [TASK_QUESTION_HINT_1]: { label: "AI 提示", prefix: "请求一级提示" },
  [TASK_QUESTION_HINT_2]: { label: "再提示一步", prefix: "请求二级提示" },
  [TASK_QUESTION_EXPLANATION]: { label: "查看完整讲解", prefix: "请求完整讲解" },
};

function levelForTask(taskType) {
  if (taskType === TASK_QUESTION_HINT_2) return 2;
  if (taskType === TASK_QUESTION_EXPLANATION) return 3;
  return 1;
}

export function questionHintKey({ resourceId, chapter, questionId }) {
  return `${String(resourceId || "")}||${String(chapter || "")}||${String(questionId || "")}`;
}

function readProgress() {
  try {
    const parsed = JSON.parse(getUserItem(PROGRESS_KEY) || "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // 旧数据损坏时重新开始
  }
  return {};
}

function writeProgress(data) {
  try {
    setUserItem(PROGRESS_KEY, JSON.stringify(data));
  } catch {
    // 写入失败不影响主流程
  }
}

export function getQuestionHintProgress(key) {
  return readProgress()[key] || null;
}

// C 阶段错因诊断与 B 阶段提示共用同一道题的 question-help 历史：
// 只更新 historyId，不改动 highestUnlockedLevel，避免破坏 B 的解锁进度语义。
export function rememberDiagnosisHistoryId(key, historyId) {
  if (!key || !historyId) return;
  const progress = readProgress();
  const previous = progress[key] || {};
  progress[key] = {
    ...previous,
    historyId,
    updatedAt: Date.now(),
  };
  writeProgress(progress);
}

function rememberSuccess({ key, taskType, historyId }) {
  const progress = readProgress();
  const previous = progress[key] || {};
  progress[key] = {
    highestUnlockedLevel: Math.max(Number(previous.highestUnlockedLevel) || 0, levelForTask(taskType)),
    historyId: historyId || previous.historyId || "",
    updatedAt: Date.now(),
  };
  writeProgress(progress);
}

export function buildQuestionHintUserMessage(taskType, detail) {
  const info = HINT_TASK_INFO[taskType] || HINT_TASK_INFO[TASK_QUESTION_HINT_1];
  const number = detail?.questionNumber ? `Q${String(detail.questionNumber)}` : "";
  const text = String(detail?.questionText || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    role: "user",
    content: `${info.prefix}${number ? ` ${number}` : ""}${text ? `：${text}` : ""}`,
    label: info.label,
  };
}

function stripMetaForHistory(meta) {
  const { articleText, ...rest } = meta || {};
  return rest;
}

function makeAssistant({
  status,
  taskType,
  level,
  result = null,
  cached = false,
  raw = "",
  message = "",
  reasoning = "",
  detail = null,
}) {
  const label = HINT_TASK_INFO[taskType]?.label || "AI 提示";
  const base = { role: "assistant", label, questionHint: true, level };
  if (detail) base.questionHintMeta = detail;
  if (reasoning) base.reasoning = reasoning;

  if (status === "ok") {
    if (level === 3) {
      return {
        ...base,
        content: `完整讲解已生成${result?.correctAnswer ? `，正确答案 ${result.correctAnswer}` : ""}。`,
        structured: result,
        cached,
      };
    }
    return {
      ...base,
      content: result?.questionForUser || result?.readingDirection || "提示已生成。",
      structured: result,
      cached,
    };
  }
  if (status === "leak-blocked") {
    return { ...base, content: "本次 AI 提示可能直接泄露答案，已自动拦截。", retryable: true };
  }
  if (status === "parse-failed") {
    if (level >= 3) {
      return { ...base, content: raw || "", parseFallback: true, retryable: true };
    }
    return { ...base, content: "本次提示格式异常，请重新生成。", retryable: true };
  }
  if (status === "busy") {
    return { ...base, content: "已有相同的提示正在生成，请稍候。" };
  }
  if (status === "blocked") {
    return { ...base, content: "当前学习流程不允许查看完整讲解，请先点击「订正」。", blocked: true };
  }
  if (status === "error") {
    return { ...base, content: `提示生成失败：${message || "请重试"}`, retryable: true };
  }
  return { ...base, content: message || "提示生成失败，请重试。", retryable: true };
}

function buildMessagesFor(taskType, detail) {
  const common = {
    questionText: detail.questionText,
    articleText: detail.articleText,
    chapter: detail.chapter,
    resourceId: detail.resourceId,
  };
  if (taskType === TASK_QUESTION_HINT_1) return buildQuestionHintLevel1Messages(common);
  if (taskType === TASK_QUESTION_HINT_2) return buildQuestionHintLevel2Messages(common);
  return buildQuestionExplanationMessages({
    ...common,
    options: detail.options || [],
    officialAnswer: detail.officialAnswer || "",
    firstAnswer: detail.firstAnswer || "",
    redoAnswer: detail.redoAnswer || "",
    drawerAnswer: detail.drawerAnswer || "",
  });
}

function persistHistory({ taskType, detail, model, userMessage, assistant }) {
  const key = questionHintKey(detail);
  try {
    let historyId = readProgress()[key]?.historyId || "";
    const recordExists = historyId && listAiHistory().some((record) => record.id === historyId);
    if (recordExists) {
      appendAiHistoryMessage(historyId, userMessage);
      appendAiHistoryMessage(historyId, stripMetaForHistory(assistant));
      return historyId;
    }
    const record = createAiHistoryRecord({
      kind: "question-help",
      chapter: String(detail.chapter || "自定义"),
      model,
      name: `阅读提示 · ${String(detail.chapter || "自定义")} · Q${String(detail.questionNumber || "")}`,
      sentence: String(detail.questionText || ""),
    });
    appendAiHistoryMessage(record.id, userMessage);
    appendAiHistoryMessage(record.id, stripMetaForHistory(assistant));
    return record.id;
  } catch {
    return readProgress()[key]?.historyId || "";
  }
}

async function executerunQuestionHint({
  taskType,
  detail = {},
  apiKey,
  useCache = true,
  fetcher = callAi,
  signal = null,
  isCurrent = () => true,
  onNetworkStart,
}) {
  const level = levelForTask(taskType);
  const questionText = String(detail.questionText || "").trim();
  const articleText = String(detail.articleText || "").trim();
  const questionId = String(detail.questionId || "").trim();
  const key = questionHintKey(detail);



  const model = resolveAiModel(taskType);
  const fingerprint = buildQuestionHintFingerprint({
    taskType,
    model,
    provider: getAiApiCacheScope(),
    promptVersion: QUESTION_HINT_PROMPT_VERSION,
    resourceId: detail.resourceId,
    chapter: detail.chapter,
    questionId,
    questionText,
    articleText,
    options: detail.options || [], officialAnswer: detail.officialAnswer || "",
    firstAnswer: detail.firstAnswer || "", redoAnswer: detail.redoAnswer || "", drawerAnswer: detail.drawerAnswer || "", attempt: detail.scope || "",
  });
  const userMessage = buildQuestionHintUserMessage(taskType, detail);


  try {
    const telemetry = getTelemetry();
    const taskMeta = { taskType, model, promptVersion: QUESTION_HINT_PROMPT_VERSION };
    if (useCache) {
      const cached = readQuestionHintCache(fingerprint);
      if (cached) {
        if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
        const assistant = makeAssistant({
          status: "ok",
          taskType,
          level,
          result: cached,
          cached: true,
          detail,
        });
        let historyId = readProgress()[key]?.historyId || "";
        const recordExists = historyId && listAiHistory().some((record) => record.id === historyId);
        if (!recordExists) {
          historyId = persistHistory({ taskType, detail, model, userMessage, assistant });
          rememberSuccess({ key, taskType, historyId });
        }
        telemetry.recordAiTask({ ...taskMeta, status: "run", cached: true });
        telemetry.recordAiTask({ ...taskMeta, status: "success", cached: true, parseSuccess: true });
        return {
          status: "ok",
          result: cached,
          cached: true,
          fingerprint,
          historyId,
          userMessage,
          assistant,
        };
      }
    }

    const baseMessages = buildMessagesFor(taskType, detail);
    const optionKeys = level === 3
      ? (Array.isArray(detail.options) ? detail.options.map((item) => item?.key).filter(Boolean) : [])
      : null;

  if (!apiKey) {
    const message = "请先在首页右上角“AI API”填入你的 AI API Key";
    return {
      status: "invalid",
      message,
      assistant: makeAssistant({ status: "invalid", taskType, level, message, detail }),
    };
  }

    const taskStartedAt = globalThis.performance?.now ? performance.now() : Date.now();
    let strictRetries = 0;
    telemetry.recordAiTask({ ...taskMeta, status: "run", cached: false });
    onNetworkStart?.();
    let response = await fetcher({
      apiKey,
      model,
      messages: baseMessages,
      temperature: 0.3,
      timeoutMs: level === 3 ? EXPLANATION_TIMEOUT_MS : HINT_TIMEOUT_MS,
      signal,
    });
    if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
    let raw = String(response.content || "");
    let reasoning = String(response.reasoning || "");
    let result = parseQuestionHintResult(raw, level, optionKeys);

    if (result && level < 3 && !validateHintNoAnswerLeak(raw, level).ok) {
      const strictResponse = await fetcher({
        apiKey,
        model,
        messages: buildQuestionHintStrictMessages(taskType, baseMessages),
        temperature: 0.2,
        timeoutMs: HINT_TIMEOUT_MS,
        signal,
      });
      if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
      const strictRaw = String(strictResponse.content || "");
      const strictResult = parseQuestionHintResult(strictRaw, level, optionKeys);
      if (!strictResult || !validateHintNoAnswerLeak(strictRaw, level).ok) {
        telemetry.recordAiTask({
          ...taskMeta,
          status: "leak-blocked",
          cached: false,
          retries: 1,
          parseSuccess: false,
          leakBlocked: true,
          durationMs: (globalThis.performance?.now ? performance.now() : Date.now()) - taskStartedAt,
        });
        return {
          status: "leak-blocked",
          fingerprint,
          userMessage,
          assistant: makeAssistant({ status: "leak-blocked", taskType, level, detail }),
        };
      }
      strictRetries = 1;
      raw = strictRaw;
      result = strictResult;
      reasoning = String(strictResponse.reasoning || "");
    }

    if (!result) {
      telemetry.recordAiTask({
        ...taskMeta,
        status: "parse-failed",
        cached: false,
        retries: strictRetries,
        parseSuccess: false,
        durationMs: (globalThis.performance?.now ? performance.now() : Date.now()) - taskStartedAt,
      });
      return {
        status: "parse-failed",
        fingerprint,
        raw,
        userMessage,
        assistant: makeAssistant({ status: "parse-failed", taskType, level, raw, detail }),
      };
    }

    if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
    writeQuestionHintCache(fingerprint, result, level);
    const assistant = makeAssistant({
      status: "ok",
      taskType,
      level,
      result,
      cached: false,
      reasoning,
      detail,
    });
    const historyId = persistHistory({ taskType, detail, model, userMessage, assistant });
    rememberSuccess({ key, taskType, historyId });
    telemetry.recordAiTask({
      ...taskMeta,
      status: "success",
      cached: false,
      retries: strictRetries,
      parseSuccess: true,
      optionCoverage: level === 3 ? result.hasFullOptionCoverage : null,
      durationMs: (globalThis.performance?.now ? performance.now() : Date.now()) - taskStartedAt,
    });
    return {
      status: "ok",
      result,
      cached: false,
      fingerprint,
      historyId,
      userMessage,
      assistant,
    };
  } catch (reason) {
    if (signal?.aborted || !isCurrent()) throw new DOMException("Stale AI request", "AbortError");
    const message = classifyAiError(reason);
    getTelemetry().recordAiTask({
      taskType,
      model,
      promptVersion: QUESTION_HINT_PROMPT_VERSION,
      status: "error",
      cached: false,
    });
    return {
      status: "error",
      fingerprint,
      message,
      userMessage,
      assistant: makeAssistant({ status: "error", taskType, level, message, detail }),
    };
  } finally {
  }
}


export async function runQuestionHint(options) {
  const invalid = validaterunQuestionHint(options);
  if (invalid) return invalid;
  if (!getCurrentUsername()) return { status: "invalid", message: "请先登录账号", assistant: { role: "assistant", content: "请先登录账号" } };
  const model = resolveAiModel(options.taskType || "question-hint");
  const { signal, isCurrent } = options;
  const fingerprint = fingerprintAiInput({ task: options.taskType || "question-hint", model, provider: getAiApiCacheScope(), scope: options.detail?.scope,
    target: [options.detail?.resourceId || "", options.detail?.passageId || "", options.detail?.questionId || ""],
    messages: buildMessagesFor(options.taskType, options.detail || {}) });
  try {
    const response = await runCachedAiResult({ namespace: options.taskType || "question-hint", fingerprint,
      signal, isCurrent, force: options.useCache === false, networkOnly: true,
      request: ({ signal: networkSignal, isCurrent: active }) => executerunQuestionHint({ ...options, signal: networkSignal, isCurrent: active }) });
    return response.result;
  } catch (reason) {
    if (reason?.name === "AbortError") return { status: "aborted", cached: false, assistant: null };
    throw reason;
  }
}
