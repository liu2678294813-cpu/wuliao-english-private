import { getCurrentUsername } from "./userData";
import { runCachedAiResult } from "./aiReviewCache";
import { fingerprintAiInput } from "./aiTasks";
import { callAi, getAiApiCacheScope, resolveAiModel } from "./ai";
import {
  TASK_TRANSLATION_REVIEW,
  TRANSLATION_REVIEW_PROMPT_VERSION,
  buildTranslationReviewFingerprint,
  buildTranslationReviewMessages,
} from "./aiTasks";
import { parseTranslationReviewResult } from "./aiResultParsers";
import { readReviewCacheEntry, writeReviewCache } from "./aiReviewCache";
import { classifyAiError as classifyAiErrorShared } from "./aiError";
import { getTelemetry } from "./telemetry/telemetry";
import {
  buildLearningIdentityKey,
  getLearningRecordByIdentity,
  upsertTranslationReviewRecord,
} from "./aiLearningRecords";
import { emitAppEvent } from "./events/appEvents";

const REVIEW_TIMEOUT_MS = 90000;



const runningReviews = new Set();
export function isReviewInFlight(fingerprint) {
  return runningReviews.has(fingerprint);
}

function reviewFingerprint({ sentence, paragraph, chapter, userTranslation, model }) {
  return buildTranslationReviewFingerprint({
    sentence,
    paragraph,
    chapter,
    userTranslation,
    model,
    provider: getAiApiCacheScope(),
  });
}

export function buildTranslationReviewName(detail) {
  const chapter = String(detail.chapter || "").trim();
  const item = String(detail.itemLabel || "").trim();
  const base = chapter || "精读";
  return item ? `翻译批改 · ${base} · ${item}` : `翻译批改 · ${base}`;
}

function classifyReviewError(reason) {
  return classifyAiErrorShared(reason).message;
}

function dispatchStatus(type, sentenceId) {
  if (!sentenceId) return;
  emitAppEvent(`wuliao:translation-review:${type}`, { sentenceId });
}

async function executerunTranslationReview({ detail, apiKey, useCache = true, signal = null, isCurrent = () => true, onNetworkStart }) {
  const sentence = String(detail.sentence || "").trim();
  const userTranslation = String(detail.userTranslation || "").trim();
  const paragraph = String(detail.paragraph || "").trim();
  if (!sentence || !userTranslation) {
    return { status: "invalid", message: "缺少英文原句或你的译文，无法批改" };
  }


  const model = resolveAiModel(TASK_TRANSLATION_REVIEW);
  const fingerprint = reviewFingerprint({ sentence, paragraph, chapter: detail.chapter, userTranslation, model });
  const sentenceId = detail.sentenceId;

  dispatchStatus("start", sentenceId);
  try {
    const telemetry = getTelemetry();
    const taskMeta = {
      taskType: TASK_TRANSLATION_REVIEW,
      model,
      promptVersion: TRANSLATION_REVIEW_PROMPT_VERSION,
    };
    if (useCache) {
      const cachedEntry = readReviewCacheEntry(fingerprint);
      if (cachedEntry) {
        if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
        const itemId = String(detail.sentenceId || detail.itemId || "");
        const identity = buildLearningIdentityKey({
          resourceId: detail.resourceId,
          chapter: detail.chapter,
          taskType: TASK_TRANSLATION_REVIEW,
          itemId,
        });
        if (!getLearningRecordByIdentity(identity)) {
          upsertTranslationReviewRecord({
            resourceId: detail.resourceId,
            chapter: detail.chapter,
            sentenceId: itemId,
            itemLabel: detail.itemLabel,
            inputMethod: detail.inputMethod,
            errorTags: cachedEntry.result?.errorTags || [],
            summaryLevel: cachedEntry.result?.summary?.level || "",
            sentenceSnippet: sentence,
            historyId: detail.historyId || "",
            passageId: detail.passageId || "",
            backfill: true,
            savedAt: cachedEntry.savedAt,
          });
        }
        telemetry.recordAiTask({ ...taskMeta, status: "run", cached: true });
        telemetry.recordAiTask({ ...taskMeta, status: "success", cached: true, parseSuccess: true });
        return {
          status: "ok",
          fingerprint,
          result: cachedEntry.result,
          cached: true,
          raw: cachedEntry.result,
        };
      }
    }

  if (!apiKey) {
    return { status: "invalid", message: "请先在首页右上角“AI API”填入你的 AI API Key" };
  }

    runningReviews.add(fingerprint);
    onNetworkStart?.();
    const taskStartedAt = globalThis.performance?.now ? performance.now() : Date.now();
    telemetry.recordAiTask({ ...taskMeta, status: "run", cached: false });
    const response = await callAi({
      apiKey,
      model,
      taskType: TASK_TRANSLATION_REVIEW,
      messages: buildTranslationReviewMessages({
        sentence,
        paragraph,
        chapter: detail.chapter,
        userTranslation,
      }),
      temperature: 0.2,
      timeoutMs: REVIEW_TIMEOUT_MS,
      signal,
    });
    if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");

    const raw = String(response.content || "");
    const result = parseTranslationReviewResult(raw);
    if (!result) {
      telemetry.recordAiTask({
        ...taskMeta,
        status: "parse-failed",
        cached: false,
        parseSuccess: false,
        durationMs: (globalThis.performance?.now ? performance.now() : Date.now()) - taskStartedAt,
      });
      return { status: "parse-failed", fingerprint, raw };
    }

    if (!isCurrent() || signal?.aborted) throw new DOMException("Stale AI request", "AbortError");
    writeReviewCache(fingerprint, result);
    upsertTranslationReviewRecord({
      resourceId: detail.resourceId,
      chapter: detail.chapter,
      sentenceId: detail.sentenceId || detail.itemId || "",
      itemLabel: detail.itemLabel,
      inputMethod: detail.inputMethod,
      errorTags: result.errorTags,
      summaryLevel: result.summary?.level || "",
      sentenceSnippet: sentence,
      historyId: detail.historyId || "",
      passageId: detail.passageId || "",
    });
    telemetry.recordAiTask({
      ...taskMeta,
      status: "success",
      cached: false,
      parseSuccess: true,
      durationMs: (globalThis.performance?.now ? performance.now() : Date.now()) - taskStartedAt,
    });
    return { status: "ok", fingerprint, result, cached: false, raw };
  } catch (reason) {
    if (signal?.aborted || !isCurrent()) throw new DOMException("Stale AI request", "AbortError");
    const telemetry = getTelemetry();
    telemetry.recordAiTask({
      taskType: TASK_TRANSLATION_REVIEW,
      model,
      promptVersion: TRANSLATION_REVIEW_PROMPT_VERSION,
      status: "error",
      cached: false,
    });
    return { status: "error", fingerprint, message: classifyReviewError(reason) };
  } finally {
    runningReviews.delete(fingerprint);
    dispatchStatus("finish", sentenceId);
  }
}

export { classifyAiErrorShared as classifyAiError };


export async function runTranslationReview(options) {
  if (!options.detail?.sentence?.trim() || !options.detail?.userTranslation?.trim()) return { status: "invalid", message: "缺少英文原句或你的译文，无法批改" };
  if (!getCurrentUsername()) return { status: "invalid", message: "请先登录账号", assistant: { role: "assistant", content: "请先登录账号" } };
  const model = resolveAiModel("translation-review");
  const { signal, isCurrent } = options;
  const fingerprint = fingerprintAiInput({ task: "translation-review", model, provider: getAiApiCacheScope(),
    target: [options.detail?.resourceId || "", options.detail?.passageId || "", options.detail?.sentenceId || options.detail?.itemId || ""],
    messages: buildTranslationReviewMessages(options.detail) });
  try {
    const response = await runCachedAiResult({ namespace: "translation-review", fingerprint,
      signal, isCurrent, force: options.useCache === false, networkOnly: true,
      request: ({ signal: networkSignal, isCurrent: active }) => executerunTranslationReview({ ...options, signal: networkSignal, isCurrent: active }) });
    return response.result;
  } catch (reason) {
    if (reason?.name === "AbortError") return { status: "aborted", cached: false, assistant: null };
    throw reason;
  }
}
