import { getCurrentUsername } from "./userData";
function validaterunQuestionDiagnosis({ taskType, detail = {} }) {
  const questionText = String(detail.questionText || "").trim();
  const articleText = String(detail.articleText || "").trim();
  const questionId = String(detail.questionId || "").trim();
  const officialAnswer = String(detail.officialAnswer || "").toUpperCase();
  const firstAnswer = String(detail.firstAnswer || "").toUpperCase();
  const redoAnswer = String(detail.redoAnswer || "").toUpperCase();
  const userReasoning = String(detail.userReasoning || "").trim();
  const userEvidence = String(detail.userEvidence || "").trim();
  const hasFirst = /^[A-D]$/.test(firstAnswer);
  const hasRedo = /^[A-D]$/.test(redoAnswer);
  const key = questionHintKey(detail);

  if (!questionText || !articleText || !questionId) {
    const message = "缺少题干或文章内容，无法生成错因诊断";
    return {
      status: "invalid",
      message,
      assistant: makeDiagnosisAssistant({ status: "invalid", message, detail }),
    };
  }
  // 答案权限：与 B 阶段完整讲解同一规则，且在构造任何含 officialAnswer 的请求之前检查。
  if (detail.canShowFullExplanation !== true || !/^[A-D]$/.test(officialAnswer)) {
    const message = "当前学习流程不允许查看完整讲解";
    return {
      status: "blocked",
      message,
      assistant: makeDiagnosisAssistant({ status: "blocked", message, detail }),
    };
  }
  if (!hasFirst && !hasRedo) {
    const message = "没有可诊断的作答记录";
    return {
      status: "invalid",
      message,
      assistant: makeDiagnosisAssistant({ status: "invalid", message, detail }),
    };
  }
  const entryLabel = getQuestionDiagnosisEntryLabel({ firstAnswer, redoAnswer, officialAnswer });
  if (!entryLabel) {
    const message = "当前作答情况无需错因诊断";
    return {
      status: "invalid",
      message,
      assistant: makeDiagnosisAssistant({ status: "invalid", message, detail }),
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
import {
  QUESTION_DIAGNOSIS_PROMPT_VERSION,
  TASK_QUESTION_DIAGNOSIS,
  buildQuestionDiagnosisFingerprint,
  buildQuestionDiagnosisMessages,
  buildQuestionDiagnosisStrictMessages,
  buildQuestionDiagnosisUserMessage,
} from "./aiTasks";
import { parseQuestionDiagnosisResult } from "./aiResultParsers";
import { readQuestionDiagnosisCacheEntry, writeQuestionDiagnosisCache } from "./aiReviewCache";
import { validateEvidenceAgainstContext } from "./questionDiagnosisEvidence";
import {
  getQuestionHintProgress,
  questionHintKey,
  rememberDiagnosisHistoryId,
} from "./questionHintService";
import { classifyAiError } from "./aiReviewService";
import { getTelemetry } from "./telemetry/telemetry";
import {
  buildLearningIdentityKey,
  getLearningRecordByIdentity,
  upsertQuestionDiagnosisRecord,
} from "./aiLearningRecords";

const DIAGNOSIS_TIMEOUT_MS = 120000;



// 入口标签：A=AI 错因诊断、B=复盘首次错因、C=AI 错因诊断、D=诊断重做错误、
// E（两次都对）/F（无作答）= null（不显示）；另支持“仅重做且错误”。
export function getQuestionDiagnosisEntryLabel({ firstAnswer, redoAnswer, officialAnswer }) {
  const first = String(firstAnswer || "").toUpperCase();
  const redo = String(redoAnswer || "").toUpperCase();
  const official = String(officialAnswer || "").toUpperCase();
  const hasFirst = /^[A-D]$/.test(first);
  const hasRedo = /^[A-D]$/.test(redo);
  if (!/^[A-D]$/.test(official)) return null;
  if (!hasFirst && !hasRedo) return null;
  const firstCorrect = hasFirst && first === official;
  const redoCorrect = hasRedo && redo === official;
  if (!hasFirst && hasRedo) return redoCorrect ? null : "AI 错因诊断";
  if (hasFirst && !hasRedo) return firstCorrect ? null : "AI 错因诊断";
  if (firstCorrect && redoCorrect) return null;
  if (!firstCorrect && redoCorrect) return "复盘首次错因";
  if (!firstCorrect && !redoCorrect) return "AI 错因诊断";
  return "诊断重做错误";
}

function stripDiagnosisMetaForHistory(assistant) {
  if (!assistant || typeof assistant !== "object") return assistant;
  const meta = assistant.diagnosisMeta;
  if (!meta || typeof meta !== "object") return assistant;
  const { articleText, ...rest } = meta;
  return { ...assistant, diagnosisMeta: rest };
}

// 只统计“错误作答”对应的选项陷阱类型；正确作答不产生陷阱数据。
function collectOptionTrapTypes(selectedOptionAnalysis, officialAnswer) {
  const official = String(officialAnswer || "").toUpperCase();
  const traps = [];
  const seen = new Set();
  for (const item of Array.isArray(selectedOptionAnalysis) ? selectedOptionAnalysis : []) {
    const option = String(item?.selectedOption || "").toUpperCase();
    if (official && option === official) continue;
    const trap = String(item?.optionTrapType || "").trim();
    if (trap && !seen.has(trap)) {
      seen.add(trap);
      traps.push(trap);
    }
  }
  return traps;
}

function writeDiagnosisRecord({
  detail,
  result,
  firstAnswer,
  redoAnswer,
  officialAnswer,
  historyId,
  backfill = false,
  savedAt = 0,
}) {
  const hasFirst = /^[A-D]$/.test(String(firstAnswer || ""));
  const hasRedo = /^[A-D]$/.test(String(redoAnswer || ""));
  return upsertQuestionDiagnosisRecord({
    resourceId: detail.resourceId,
    chapter: detail.chapter,
    questionId: detail.questionId,
    questionNumber: detail.questionNumber,
    passageId: detail.passageId,
    questionType: result?.questionType || "",
    diagnosisBasis: result?.diagnosisBasis || "",
    confidence: result?.confidence || "low",
    firstAnswer,
    redoAnswer,
    firstCorrect: hasFirst && String(firstAnswer).toUpperCase() === String(officialAnswer || "").toUpperCase(),
    redoCorrect: hasRedo && String(redoAnswer).toUpperCase() === String(officialAnswer || "").toUpperCase(),
    userErrorTags: result?.inferredCause?.userErrorTags || [],
    optionTrapTypes: collectOptionTrapTypes(result?.selectedOptionAnalysis, officialAnswer),
    inferredCauseSummary: result?.inferredCause?.summary || "",
    observedFacts: result?.observedFacts || [],
    nextTimeRule: result?.nextTimeRule || "",
    historyId,
    backfill,
    savedAt,
  });
}

function makeDiagnosisAssistant({
  status,
  result = null,
  cached = false,
  raw = "",
  message = "",
  reasoning = "",
  detail = null,
  evidenceValidated = true,
}) {
  const base = { role: "assistant", label: "错因诊断", questionDiagnosis: true };
  if (detail) base.diagnosisMeta = detail;
  if (reasoning) base.reasoning = reasoning;

  if (status === "ok") {
    return {
      ...base,
      content: "错因诊断已生成。",
      structured: result,
      cached,
      evidenceValidated: Boolean(evidenceValidated),
      retryable: !evidenceValidated,
    };
  }
  if (status === "parse-failed") {
    return { ...base, content: raw || "", parseFallback: true, retryable: true };
  }
  if (status === "busy") {
    return { ...base, content: "已有相同的错因诊断正在生成，请稍候。" };
  }
  if (status === "blocked") {
    return { ...base, content: "当前学习流程不允许查看完整讲解，请先点击「订正」。", blocked: true };
  }
  if (status === "error") {
    return { ...base, content: `错因诊断失败：${message || "请重试"}`, retryable: true };
  }
  return { ...base, content: message || "错因诊断失败，请重试。", retryable: true };
}

function persistDiagnosisHistory({ detail, model, userMessage, assistant }) {
  const key = questionHintKey(detail);
  try {
    let historyId = getQuestionHintProgress(key)?.historyId || "";
    const recordExists = historyId && listAiHistory().some((record) => record.id === historyId);
    if (recordExists) {
      appendAiHistoryMessage(historyId, userMessage);
      appendAiHistoryMessage(historyId, stripDiagnosisMetaForHistory(assistant));
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
    appendAiHistoryMessage(record.id, stripDiagnosisMetaForHistory(assistant));
    rememberDiagnosisHistoryId(key, record.id);
    return record.id;
  } catch {
    return "";
  }
}

async function executerunQuestionDiagnosis({
  detail = {},
  apiKey,
  useCache = true,
  fetcher = callAi,
  signal = null,
  isCurrent = () => true,
  onNetworkStart,
}) {
  const questionText = String(detail.questionText || "").trim();
  const articleText = String(detail.articleText || "").trim();
  const questionId = String(detail.questionId || "").trim();
  const officialAnswer = String(detail.officialAnswer || "").toUpperCase();
  const firstAnswer = String(detail.firstAnswer || "").toUpperCase();
  const redoAnswer = String(detail.redoAnswer || "").toUpperCase();
  const userReasoning = String(detail.userReasoning || "").trim();
  const userEvidence = String(detail.userEvidence || "").trim();
  const hasFirst = /^[A-D]$/.test(firstAnswer);
  const hasRedo = /^[A-D]$/.test(redoAnswer);
  const key = questionHintKey(detail);



  const model = resolveAiModel(TASK_QUESTION_DIAGNOSIS);
  const fingerprint = buildQuestionDiagnosisFingerprint({
    taskType: TASK_QUESTION_DIAGNOSIS,
    model,
    provider: getAiApiCacheScope(),
    promptVersion: QUESTION_DIAGNOSIS_PROMPT_VERSION,
    resourceId: detail.resourceId,
    chapter: detail.chapter,
    questionId,
    questionText,
    options: detail.options || [],
    officialAnswer,
    firstAnswer,
    redoAnswer,
    articleText,
    userReasoning,
    userEvidence,
  });
  const userMessage = buildQuestionDiagnosisUserMessage({ ...detail, userReasoning });


  try {
    const telemetry = getTelemetry();
    const taskMeta = {
      taskType: TASK_QUESTION_DIAGNOSIS,
      model,
      promptVersion: QUESTION_DIAGNOSIS_PROMPT_VERSION,
    };
    if (useCache) {
      const cachedEntry = readQuestionDiagnosisCacheEntry(fingerprint);
      if (cachedEntry) {
        if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
        const cached = cachedEntry.result;
        const assistant = makeDiagnosisAssistant({
          status: "ok",
          result: cached,
          cached: true,
          detail,
          evidenceValidated: cached.evidenceValidated !== false,
        });
        let historyId = getQuestionHintProgress(key)?.historyId || "";
        const recordExists = historyId && listAiHistory().some((record) => record.id === historyId);
        if (!recordExists) {
          historyId = persistDiagnosisHistory({ detail, model, userMessage, assistant });
        }
        const identity = buildLearningIdentityKey({
          resourceId: detail.resourceId,
          chapter: detail.chapter,
          taskType: TASK_QUESTION_DIAGNOSIS,
          itemId: String(questionId || ""),
        });
        if (!getLearningRecordByIdentity(identity)) {
          writeDiagnosisRecord({
            detail,
            result: cached,
            firstAnswer,
            redoAnswer,
            officialAnswer,
            historyId,
            backfill: true,
            savedAt: cachedEntry.savedAt,
          });
        }
        telemetry.recordAiTask({ ...taskMeta, status: "run", cached: true });
        telemetry.recordAiTask({
          ...taskMeta,
          status: "success",
          cached: true,
          parseSuccess: true,
          evidenceValidated: cached.evidenceValidated !== false,
        });
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

    const baseMessages = buildQuestionDiagnosisMessages({
      questionText,
      options: detail.options || [],
      officialAnswer,
      firstAnswer,
      redoAnswer,
      articleText,
      chapter: detail.chapter,
      resourceId: detail.resourceId,
      questionNumber: detail.questionNumber,
      userReasoning,
      userEvidence,
    });
    const optionKeys = (Array.isArray(detail.options) ? detail.options : [])
      .map((item) => item?.key)
      .filter(Boolean);
    const parseOptions = {
      optionKeys,
      firstAnswer,
      redoAnswer,
      hasUserReasoning: Boolean(userReasoning),
    };

  if (!apiKey) {
    const message = "请先在首页右上角“AI API”填入你的 AI API Key";
    return {
      status: "invalid",
      message,
      assistant: makeDiagnosisAssistant({ status: "invalid", message, detail }),
    };
  }

    const taskStartedAt = globalThis.performance?.now ? performance.now() : Date.now();
    let strictRetries = 0;
    let evidenceInvalid = false;
    telemetry.recordAiTask({ ...taskMeta, status: "run", cached: false });
    onNetworkStart?.();
    let response = await fetcher({
      apiKey,
      model,
      messages: baseMessages,
      temperature: 0.3,
      timeoutMs: DIAGNOSIS_TIMEOUT_MS,
      signal,
    });
    if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
    let raw = String(response.content || "");
    let reasoning = String(response.reasoning || "");
    let result = parseQuestionDiagnosisResult(raw, parseOptions);

    if (result) {
      const validation = validateEvidenceAgainstContext(result.evidence, articleText);
      if (!validation.ok) {
        evidenceInvalid = true;
        const strictResponse = await fetcher({
          apiKey,
          model,
          messages: buildQuestionDiagnosisStrictMessages(baseMessages),
          temperature: 0.2,
          timeoutMs: DIAGNOSIS_TIMEOUT_MS,
          signal,
        });
        const strictRaw = String(strictResponse.content || "");
        const strictResult = parseQuestionDiagnosisResult(strictRaw, parseOptions);
        if (strictResult) {
          strictRetries = 1;
          raw = strictRaw;
          result = strictResult;
          reasoning = String(strictResponse.reasoning || "");
        }
      }
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
      if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
      return {
        status: "parse-failed",
        fingerprint,
        raw,
        userMessage,
        assistant: makeDiagnosisAssistant({ status: "parse-failed", raw, detail }),
      };
    }

    const finalValidation = validateEvidenceAgainstContext(result.evidence, articleText);
    const invalidSources = new Set(finalValidation.invalid);
    const evidenceValidated = finalValidation.ok;
    const cleanedResult = {
      ...result,
      evidence: (Array.isArray(result.evidence) ? result.evidence : [])
        .filter((item) => !invalidSources.has(item)),
      evidenceValidated,
    };

    if (!evidenceValidated) {
      // 未通过校验时不写缓存，但仍可结构化展示清洗后的结果。
      const assistant = makeDiagnosisAssistant({
        status: "ok",
        result: cleanedResult,
        reasoning,
        detail,
        evidenceValidated: false,
      });
      const historyId = persistDiagnosisHistory({ detail, model, userMessage, assistant });
      telemetry.recordAiTask({
        ...taskMeta,
        status: "success",
        cached: false,
        retries: strictRetries,
        parseSuccess: true,
        evidenceInvalid,
        evidenceFinalFailure: evidenceInvalid,
        durationMs: (globalThis.performance?.now ? performance.now() : Date.now()) - taskStartedAt,
      });
      return {
        status: "ok",
        result: cleanedResult,
        cached: false,
        fingerprint,
        historyId,
        userMessage,
        assistant,
        evidenceValidated: false,
      };
    }

    if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
    writeQuestionDiagnosisCache(fingerprint, cleanedResult);
    const assistant = makeDiagnosisAssistant({
      status: "ok",
      result: cleanedResult,
      cached: false,
      reasoning,
      detail,
      evidenceValidated: true,
    });
    const historyId = persistDiagnosisHistory({ detail, model, userMessage, assistant });
    writeDiagnosisRecord({
      detail,
      result: cleanedResult,
      firstAnswer,
      redoAnswer,
      officialAnswer,
      historyId,
    });
    telemetry.recordAiTask({
      ...taskMeta,
      status: "success",
      cached: false,
      retries: strictRetries,
      parseSuccess: true,
      evidenceInvalid,
      evidenceFinalFailure: false,
      durationMs: (globalThis.performance?.now ? performance.now() : Date.now()) - taskStartedAt,
    });
    return {
      status: "ok",
      result: cleanedResult,
      cached: false,
      fingerprint,
      historyId,
      userMessage,
      assistant,
      evidenceValidated: true,
    };
  } catch (reason) {
    if (signal?.aborted || !isCurrent()) throw new DOMException("Stale AI request", "AbortError");
    const message = classifyAiError(reason);
    getTelemetry().recordAiTask({
      taskType: TASK_QUESTION_DIAGNOSIS,
      model,
      promptVersion: QUESTION_DIAGNOSIS_PROMPT_VERSION,
      status: "error",
      cached: false,
    });
    return {
      status: "error",
      fingerprint,
      message,
      userMessage,
      assistant: makeDiagnosisAssistant({ status: "error", message, detail }),
    };
  } finally {
  }
}


export async function runQuestionDiagnosis(options) {
  const invalid = validaterunQuestionDiagnosis(options);
  if (invalid) return invalid;
  if (!getCurrentUsername()) return { status: "invalid", message: "请先登录账号", assistant: { role: "assistant", content: "请先登录账号" } };
  const model = resolveAiModel("question-diagnosis");
  const { signal, isCurrent } = options;
  const fingerprint = fingerprintAiInput({ task: "question-diagnosis", model, provider: getAiApiCacheScope(), scope: options.detail?.scope,
    target: [options.detail?.resourceId || "", options.detail?.passageId || "", options.detail?.questionId || ""],
    messages: buildQuestionDiagnosisMessages(options.detail || {}) });
  try {
    const response = await runCachedAiResult({ namespace: "question-diagnosis", fingerprint,
      signal, isCurrent, force: options.useCache === false, networkOnly: true,
      request: ({ signal: networkSignal, isCurrent: active }) => executerunQuestionDiagnosis({ ...options, signal: networkSignal, isCurrent: active }) });
    return response.result;
  } catch (reason) {
    if (reason?.name === "AbortError") return { status: "aborted", cached: false, assistant: null };
    throw reason;
  }
}
