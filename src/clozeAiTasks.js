import { getAiApiCacheScope, resolveAiModel } from "./ai";

export const TASK_CLOZE_HINT_1 = "cloze-hint-1";
export const TASK_CLOZE_HINT_2 = "cloze-hint-2";
export const TASK_CLOZE_EXPLANATION = "cloze-explanation";
export const TASK_CLOZE_DIAGNOSIS = "cloze-diagnosis";
export const TASK_CLOZE_CONTEXT_REVIEW = "cloze-context-review";

export const CLOZE_AI_TASKS = [
  TASK_CLOZE_HINT_1,
  TASK_CLOZE_HINT_2,
  TASK_CLOZE_EXPLANATION,
  TASK_CLOZE_DIAGNOSIS,
  TASK_CLOZE_CONTEXT_REVIEW,
];

export const CLOZE_AI_PROMPT_VERSION = 1;

const TASK_LABELS = {
  [TASK_CLOZE_HINT_1]: "完形提示 1",
  [TASK_CLOZE_HINT_2]: "完形提示 2",
  [TASK_CLOZE_EXPLANATION]: "完形完整讲解",
  [TASK_CLOZE_DIAGNOSIS]: "完形错因分析",
  [TASK_CLOZE_CONTEXT_REVIEW]: "完形语境复盘",
};

const BASE_SYSTEM = `你是考研英语完形填空教练。你处理的是 cloze，而不是阅读理解题。
所有 evidence 必须逐字引用用户消息中给出的【可信原文】之一，并同时返回完全一致的 sentenceId 与 source。
只输出 JSON，不要 Markdown，不要添加 JSON 之外的文字。`;

const HINT_SCHEMAS = {
  [TASK_CLOZE_HINT_1]: `{
  "level": 1,
  "focus": "应该观察的局部结构或逻辑位置，不得给答案",
  "grammarSignals": ["语法或搭配信号"],
  "logicSignals": ["上下文逻辑信号"],
  "selfCheckQuestion": "引导学习者自己判断的问题"
}`,
  [TASK_CLOZE_HINT_2]: `{
  "level": 2,
  "requiredRole": "空格所需的词性、语义角色或逻辑功能",
  "reasoningSteps": ["不含答案的推理步骤"],
  "eliminationDimensions": ["可用于自行比较选项的维度，但不得出现选项或答案"],
  "selfCheckQuestion": "最后一个自检问题"
}`,
};

const EXPLANATION_SCHEMA = `{
  "coreRequirement": "本空在句法、搭配和篇章逻辑上的核心要求",
  "grammar": "句法或固定搭配讲解",
  "contextLogic": "上下文逻辑讲解",
  "optionNotes": [{"key":"A","explanation":"仅解释该词在语境中的适配性，不返回 correct/wrong"}],
  "evidence": [{"sentenceId":"可信原文 ID","source":"逐字原文","explanation":"该证据如何支持讲解"}],
  "takeaway": "下次可复用的完形判断规则"
}`;

const DIAGNOSIS_SCHEMA = `{
  "observedPattern": "根据本地提供的作答事实描述变化，不重新判定对错",
  "likelyCause": "可能的具体错因",
  "errorTypes": ["词义辨析/固定搭配/句法约束/逻辑关系/篇章衔接/语境范围/改答策略"],
  "attemptComparison": "比较初做与复查的思路风险",
  "evidence": [{"sentenceId":"可信原文 ID","source":"逐字原文","explanation":"证据与错因的关系"}],
  "nextTimeRule": "下次可执行的检查动作",
  "selfCheckQuestions": ["复盘问题"]
}`;

const CONTEXT_SCHEMA = `{
  "contextLogic": "只复盘句法、语义与篇章衔接，不判断正确答案",
  "manualAnalysisFeedback": "只反馈学习者已写的预判、依据、原文依据和当前句译文",
  "evidence": [{"sentenceId":"可信原文 ID","source":"逐字原文","explanation":"原文如何支撑复盘"}],
  "reviewQuestions": ["帮助学习者继续人工分析的问题"]
}`;

function normalizeText(value, limit = 8000) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeSources(sources) {
  const seen = new Set();
  const result = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const sentenceId = String(source?.sentenceId || "").trim();
    const text = normalizeText(source?.source);
    if (!sentenceId || !text || seen.has(sentenceId)) continue;
    seen.add(sentenceId);
    result.push({ sentenceId, source: text });
  }
  return result.slice(0, 8);
}

function attemptFact(answer, officialAnswer) {
  const normalized = String(answer || "").toUpperCase();
  if (!/^[A-D]$/.test(normalized)) return { answered: false, answer: "", result: "unanswered" };
  return {
    answered: true,
    answer: normalized,
    result: officialAnswer ? (normalized === officialAnswer ? "correct" : "wrong") : "unknown",
  };
}

export function clozeAiAvailability({ stageId, analyzed = false, hasOfficial = false, officialAnswer = "", firstAnswer = "", reviewAnswer = "" }) {
  const base = {
    hint1: false,
    hint2: false,
    explanation: false,
    diagnosis: false,
    contextReview: false,
  };
  if (stageId === "cloze-self-review") return { ...base, hint1: true, hint2: true };
  if (stageId !== "cloze-analysis" || !analyzed) return base;
  if (!hasOfficial || !/^[A-D]$/.test(String(officialAnswer || "").toUpperCase())) {
    return { ...base, contextReview: true };
  }
  const official = String(officialAnswer).toUpperCase();
  const first = attemptFact(firstAnswer, official);
  const review = attemptFact(reviewAnswer, official);
  return {
    ...base,
    explanation: true,
    diagnosis: first.result === "wrong" || review.result === "wrong",
  };
}

export function isClozeAiTask(value) {
  return CLOZE_AI_TASKS.includes(value);
}

export function clozeAiTaskLabel(taskType) {
  return TASK_LABELS[taskType] || "完形 AI";
}

export function buildClozeHintDetail({ taskType, resourceId, clozeId, blankNumber, chapter, currentSentence, contextSources }) {
  if (![TASK_CLOZE_HINT_1, TASK_CLOZE_HINT_2].includes(taskType)) return null;
  const sentenceId = String(currentSentence?.sentenceId || "").trim();
  const sentence = normalizeText(currentSentence?.source);
  if (!sentenceId || !sentence) return null;
  return {
    taskType,
    resourceId: String(resourceId || ""),
    clozeId: String(clozeId || ""),
    blankNumber: Number(blankNumber) || 0,
    chapter: normalizeText(chapter, 240),
    currentSentence: { sentenceId, source: sentence },
    evidenceSources: normalizeSources([{ sentenceId, source: sentence }, ...(contextSources || [])]),
  };
}

export function buildClozeAnalysisDetail({
  taskType,
  resourceId,
  clozeId,
  blankNumber,
  chapter,
  currentSentence,
  evidenceSources,
  options,
  officialAnswer,
  firstAnswer,
  reviewAnswer,
  manualAnalysis,
}) {
  if (![TASK_CLOZE_EXPLANATION, TASK_CLOZE_DIAGNOSIS, TASK_CLOZE_CONTEXT_REVIEW].includes(taskType)) return null;
  const sentenceId = String(currentSentence?.sentenceId || "").trim();
  const sentence = normalizeText(currentSentence?.source);
  if (!sentenceId || !sentence) return null;
  const official = /^[A-D]$/i.test(String(officialAnswer || "")) ? String(officialAnswer).toUpperCase() : "";
  const optionList = (Array.isArray(options) ? options : [])
    .map((option) => ({ key: String(option?.key || "").toUpperCase(), text: normalizeText(option?.text, 600) }))
    .filter((option) => /^[A-D]$/.test(option.key) && option.text)
    .slice(0, 4);
  const manual = {
    prediction: normalizeText(manualAnalysis?.prediction, 1200),
    basisTypes: (Array.isArray(manualAnalysis?.basisTypes) ? manualAnalysis.basisTypes : []).map((item) => normalizeText(item, 80)).filter(Boolean).slice(0, 12),
    references: normalizeSources(manualAnalysis?.references),
    translation: normalizeText(manualAnalysis?.translation, 2400),
  };
  return {
    taskType,
    resourceId: String(resourceId || ""),
    clozeId: String(clozeId || ""),
    blankNumber: Number(blankNumber) || 0,
    chapter: normalizeText(chapter, 240),
    currentSentence: { sentenceId, source: sentence },
    evidenceSources: normalizeSources([{ sentenceId, source: sentence }, ...(evidenceSources || []), ...manual.references]),
    ...(taskType === TASK_CLOZE_CONTEXT_REVIEW ? {} : { options: optionList, officialAnswer: official }),
    ...(taskType === TASK_CLOZE_DIAGNOSIS ? {
      localAttempts: {
        first: attemptFact(firstAnswer, official),
        review: attemptFact(reviewAnswer, official),
      },
    } : {}),
    manualAnalysis: manual,
  };
}

function sourceBlock(detail) {
  return (detail.evidenceSources || [])
    .map((item) => `- sentenceId: ${item.sentenceId}\n  source: ${item.source}`)
    .join("\n");
}

function manualBlock(detail) {
  const manual = detail.manualAnalysis || {};
  return [
    `预判：${manual.prediction || "（未填写）"}`,
    `判断依据：${manual.basisTypes?.join("、") || "（未选择）"}`,
    `当前句译文：${manual.translation || "（未填写）"}`,
    `人工选取的原文依据：${manual.references?.map((item) => item.sentenceId).join("、") || "（未选择）"}`,
  ].join("\n");
}

export function buildClozeAiMessages(taskType, detail, { strict = false } = {}) {
  if (!isClozeAiTask(taskType) || !detail?.currentSentence?.sentenceId) return [];
  const strictNote = strict
    ? "\n上一次回答未通过安全或证据校验。本次严禁输出答案字母、选项原词、正确选项暗示；evidence 的 sentenceId/source 必须与可信原文逐字一致。"
    : "";
  if (taskType === TASK_CLOZE_HINT_1 || taskType === TASK_CLOZE_HINT_2) {
    const level = taskType === TASK_CLOZE_HINT_2 ? 2 : 1;
    return [
      {
        role: "system",
        content: `${BASE_SYSTEM}\n这是订正前第 ${level} 级提示。你看不到也不得猜测官方答案、选项、用户作答或信心。不得输出 A/B/C/D、选项词、答案同义改写或可唯一锁定答案的措辞。${strictNote}\n输出结构：${HINT_SCHEMAS[taskType]}`,
      },
      {
        role: "user",
        content: `【第 ${detail.blankNumber} 空；空位以 __CLOZE_BLANK_${detail.blankNumber}__ 表示】\n${detail.currentSentence.source}\n\n【可信原文】\n${sourceBlock(detail)}`,
      },
    ];
  }

  const common = `【第 ${detail.blankNumber} 空所在句】\n${detail.currentSentence.source}\n\n【可信原文】\n${sourceBlock(detail)}\n\n【C 阶段人工数据】\n${manualBlock(detail)}`;
  if (taskType === TASK_CLOZE_CONTEXT_REVIEW) {
    return [
      { role: "system", content: `${BASE_SYSTEM}\n资料没有官方答案。只能做语境复盘，严禁判断或暗示正确答案，也不要评价用户作答是否正确。${strictNote}\n输出结构：${CONTEXT_SCHEMA}` },
      { role: "user", content: common },
    ];
  }

  const options = (detail.options || []).map((option) => `${option.key}. ${option.text}`).join("\n");
  const localTruth = `【本地答案事实】\n官方答案：${detail.officialAnswer}\n选项：\n${options}`;
  if (taskType === TASK_CLOZE_EXPLANATION) {
    return [
      { role: "system", content: `${BASE_SYSTEM}\n官方答案与选项正确性由本地程序给定，你只能解释，不得自行改判。即使 JSON 中出现 correctAnswer/correct/wrong 等字段也会被丢弃。${strictNote}\n输出结构：${EXPLANATION_SCHEMA}` },
      { role: "user", content: `${common}\n\n${localTruth}` },
    ];
  }
  return [
    { role: "system", content: `${BASE_SYSTEM}\n作答对错是本地程序计算的既定事实，你只分析为什么会形成该错误，不得重新判题。不要读取或评价 confidence、corrected、analyzed。${strictNote}\n输出结构：${DIAGNOSIS_SCHEMA}` },
    { role: "user", content: `${common}\n\n${localTruth}\n\n【本地作答事实】\n${JSON.stringify(detail.localAttempts || {})}` },
  ];
}

export function buildClozeAiFingerprint(taskType, detail, model = resolveAiModel(taskType), provider = getAiApiCacheScope()) {
  const payload = JSON.stringify({
    v: CLOZE_AI_PROMPT_VERSION,
    taskType,
    provider,
    model,
    resourceId: detail?.resourceId || "",
    clozeId: detail?.clozeId || "",
    blankNumber: detail?.blankNumber || 0,
    currentSentence: detail?.currentSentence || null,
    evidenceSources: detail?.evidenceSources || [],
    options: detail?.options || [],
    officialAnswer: detail?.officialAnswer || "",
    localAttempts: detail?.localAttempts || null,
    manualAnalysis: detail?.manualAnalysis || null,
  });
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `cai${(hash >>> 0).toString(36)}`;
}

export function buildClozeAiUserMessage(taskType, detail) {
  return {
    role: "user",
    label: clozeAiTaskLabel(taskType),
    content: `第 ${detail?.blankNumber || "—"} 空 · ${detail?.currentSentence?.source || ""}`,
  };
}
