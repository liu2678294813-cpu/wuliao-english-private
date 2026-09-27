// Live AI Eval：真实调用 DeepSeek，可能产生费用。
// 绝不进入 test:all；只允许开发者主动运行。

import {
  buildQuestionDiagnosisMessages,
  buildQuestionHintLevel1Messages,
  buildQuestionHintLevel2Messages,
  buildTranslationReviewMessages,
  QUESTION_DIAGNOSIS_PROMPT_VERSION,
  QUESTION_HINT_PROMPT_VERSION,
  TRANSLATION_REVIEW_PROMPT_VERSION,
  TRANSLATION_REVIEW_ERROR_TAGS,
  USER_ERROR_TAGS,
} from "../../src/aiTasks.js";
import {
  parseQuestionDiagnosisResult,
  parseQuestionHintResult,
  parseTranslationReviewResult,
  reviewHasNoProblems,
} from "../../src/aiResultParsers.js";
import { validateHintNoAnswerLeak } from "../../src/questionHintSafety.js";
import { validateEvidenceAgainstContext } from "../../src/questionDiagnosisEvidence.js";
import {
  DIAGNOSIS_LIVE_CASE,
  HINT_LIVE_CASE,
  TRANSLATION_CASES,
} from "../../src/eval/fixtures.js";

const API_BASE = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";

function truncate(text, limit = 160) {
  const value = String(text == null ? "" : text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export async function askDeepSeek({ apiKey, messages, temperature = 0.3, timeoutMs = 90000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, messages, temperature, stream: false }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error?.message || `DeepSeek 请求失败（${response.status}）`);
    }
    const choice = data?.choices?.[0];
    if (!choice?.message) throw new Error("DeepSeek 返回为空");
    return {
      content: String(choice.message.content || ""),
      reasoning: String(choice.message.reasoning_content || ""),
      usage: data?.usage || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function whitelisted(tags, allowed) {
  return (Array.isArray(tags) ? tags : []).every((tag) => allowed.includes(tag));
}

function makeSuite(id, name, cases, extraRates = {}) {
  const passed = cases.filter((item) => item.pass).length;
  const failed = cases.length - passed;
  return {
    id,
    name,
    caseCount: cases.length,
    passed,
    failed,
    passRate: cases.length ? passed / cases.length : null,
    parseSuccessRate: extraRates.parseSuccessRate ?? null,
    answerLeakRate: extraRates.answerLeakRate ?? null,
    evidenceValidationRate: extraRates.evidenceValidationRate ?? null,
    expectedTagHitRate: extraRates.expectedTagHitRate ?? null,
  };
}

async function runHintLevel(apiKey, level) {
  const messages = level === 1
    ? buildQuestionHintLevel1Messages(HINT_LIVE_CASE)
    : buildQuestionHintLevel2Messages(HINT_LIVE_CASE);
  try {
    const response = await askDeepSeek({ apiKey, messages, temperature: 0.3 });
    const raw = String(response.content || "");
    const result = parseQuestionHintResult(raw, level);
    const leak = validateHintNoAnswerLeak(raw, level);
    const contentOk = level === 1
      ? Boolean(result?.focus?.location && result.questionForUser)
      : Boolean(result?.questionType && Array.isArray(result.reasoningSteps));
    return {
      name: `Live 一级/二级提示 level ${level}`,
      pass: Boolean(result) && leak.ok && contentOk,
      detail: result ? `parse=ok leak=${leak.ok}` : "parse failed",
    };
  } catch (reason) {
    return { name: `Live 提示 level ${level}`, pass: false, detail: truncate(reason instanceof Error ? reason.message : String(reason)) };
  }
}

export async function runLiveHintsSuite(apiKey) {
  const cases = [];
  let parseSuccess = 0;
  for (const level of [1, 2]) {
    const result = await runHintLevel(apiKey, level);
    if (result.detail.startsWith("parse=ok")) parseSuccess += 1;
    cases.push(result);
  }
  return makeSuite("live-hints", "Live 提示质量", cases, {
    parseSuccessRate: parseSuccess / 2,
    answerLeakRate: cases.filter((item) => item.pass).length / 2,
  });
}

export async function runLiveDiagnosisSuite(apiKey) {
  const messages = buildQuestionDiagnosisMessages({
    questionText: DIAGNOSIS_LIVE_CASE.questionText,
    options: DIAGNOSIS_LIVE_CASE.options,
    officialAnswer: DIAGNOSIS_LIVE_CASE.officialAnswer,
    firstAnswer: DIAGNOSIS_LIVE_CASE.firstAnswer,
    redoAnswer: DIAGNOSIS_LIVE_CASE.redoAnswer,
    articleText: DIAGNOSIS_LIVE_CASE.articleText,
    chapter: DIAGNOSIS_LIVE_CASE.chapter,
    resourceId: DIAGNOSIS_LIVE_CASE.resourceId,
    questionNumber: DIAGNOSIS_LIVE_CASE.questionNumber,
  });
  try {
    const response = await askDeepSeek({ apiKey, messages, temperature: 0.3 });
    const raw = String(response.content || "");
    const parseOptions = {
      optionKeys: DIAGNOSIS_LIVE_CASE.options.map((item) => item.key),
      firstAnswer: DIAGNOSIS_LIVE_CASE.firstAnswer,
      redoAnswer: DIAGNOSIS_LIVE_CASE.redoAnswer,
      hasUserReasoning: false,
    };
    const result = parseQuestionDiagnosisResult(raw, parseOptions);
    const validation = result ? validateEvidenceAgainstContext(result.evidence, DIAGNOSIS_LIVE_CASE.articleText) : null;
    const whitelistOk = result
      && whitelisted(result.inferredCause.userErrorTags, USER_ERROR_TAGS)
      && result.selectedOptionAnalysis.every((item) => !item.optionTrapType || ["偷换概念", "范围扩大", "范围缩小", "因果倒置", "过度推断", "无中生有", "以偏概全", "忽略否定", "忽略程度限定", "忽略转折", "作者态度误判", "把例子当主旨"].includes(item.optionTrapType));
    const pass = Boolean(result) && Boolean(validation?.ok) && whitelistOk && result.confidence !== "high";
    return makeSuite("live-diagnosis", "Live 错因诊断", [{
      name: "Live 错因诊断",
      pass,
      detail: result ? `parse=ok evidence=${validation?.ok ? "valid" : "invalid"} confidence=${result.confidence}` : "parse failed",
    }], { parseSuccessRate: result ? 1 : 0, evidenceValidationRate: validation?.ok ? 1 : 0 });
  } catch (reason) {
    return makeSuite("live-diagnosis", "Live 错因诊断", [{
      name: "Live 错因诊断",
      pass: false,
      detail: truncate(reason instanceof Error ? reason.message : String(reason)),
    }]);
  }
}

export async function runLiveTranslationSuite(apiKey) {
  const cases = [];
  let expectedTagHitCount = 0;
  let expectedTagCases = 0;
  let parseSuccess = 0;
  for (const item of TRANSLATION_CASES) {
    try {
      const messages = buildTranslationReviewMessages({
        sentence: item.sentence,
        paragraph: item.paragraph || "",
        chapter: "Eval Fixture",
        userTranslation: item.userTranslation,
      });
      const response = await askDeepSeek({ apiKey, messages, temperature: 0.2 });
      const raw = String(response.content || "");
      const result = parseTranslationReviewResult(raw);
      if (result) parseSuccess += 1;
      const whitelistOk = result && whitelisted(result.errorTags, TRANSLATION_REVIEW_ERROR_TAGS);
      let contentOk = true;
      let detail = "parse failed";
      if (result) {
        detail = `parse=ok tags=${JSON.stringify(result.errorTags)}`;
        if (item.expectedTags.length === 0) {
          contentOk = result.errorTags.length === 0 && reviewHasNoProblems(result);
        } else {
          expectedTagCases += 1;
          if (item.expectedTags.some((tag) => result.errorTags.includes(tag))) {
            expectedTagHitCount += 1;
            contentOk = true;
          } else {
            contentOk = false;
          }
        }
      }
      cases.push({
        name: `Live 翻译 fixture：${item.label}`,
        pass: Boolean(result) && whitelistOk && contentOk,
        detail,
      });
    } catch (reason) {
      cases.push({
        name: `Live 翻译 fixture：${item.label}`,
        pass: false,
        detail: truncate(reason instanceof Error ? reason.message : String(reason)),
      });
    }
  }
  return makeSuite("live-translation", "Live 翻译批改", cases, {
    parseSuccessRate: parseSuccess / TRANSLATION_CASES.length,
    expectedTagHitRate: expectedTagCases ? expectedTagHitCount / expectedTagCases : null,
  });
}

export function livePromptVersions() {
  return {
    translation: TRANSLATION_REVIEW_PROMPT_VERSION,
    hints: QUESTION_HINT_PROMPT_VERSION,
    diagnosis: QUESTION_DIAGNOSIS_PROMPT_VERSION,
  };
}
