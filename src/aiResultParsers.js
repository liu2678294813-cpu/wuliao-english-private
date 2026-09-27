import {
  DIAGNOSIS_CONFIDENCE_LEVELS,
  QUESTION_TYPES,
  TRANSLATION_REVIEW_ERROR_TAGS,
  TRAP_TYPES,
  USER_ERROR_TAGS,
} from "./aiTasks";

const TEXT_LIMIT = 4000;
const LIST_LIMIT = 40;
const SUMMARY_LEVELS = ["accurate", "mostly-accurate", "needs-revision"];
const LOGIC_TYPES = ["转折", "因果", "让步", "条件", "递进", "并列", "其他"];

function trimmed(value) {
  return String(value == null ? "" : value).trim();
}

function clipText(value) {
  const text = trimmed(value);
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
}

function sanitizeStringField(value) {
  return clipText(value);
}

function sanitizeFields(item, fields) {
  if (!item || typeof item !== "object") return null;
  const output = {};
  for (const field of fields) {
    output[field] = sanitizeStringField(item[field]);
  }
  const empty = Object.values(output).every((value) => value === "");
  return empty ? null : output;
}

function sanitizeProblemList(value, fields) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const item of value.slice(0, LIST_LIMIT)) {
    const normalized = sanitizeFields(item, fields);
    if (normalized) list.push(normalized);
  }
  return list;
}

function stripFences(text) {
  return text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractJsonText(text) {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return "";
  return text.slice(firstBrace, lastBrace + 1);
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeSummary(value) {
  if (!value || typeof value !== "object") return { level: "", comment: "" };
  const level = SUMMARY_LEVELS.includes(value.level) ? value.level : "";
  return { level, comment: sanitizeStringField(value.comment) };
}

function sanitizeMainClause(value) {
  if (!value || typeof value !== "object") return { correct: false, comment: "" };
  return {
    correct: value.correct === true,
    comment: sanitizeStringField(value.comment),
  };
}

function sanitizeLogic(value) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  output.source = sanitizeStringField(value.source);
  output.logicType = LOGIC_TYPES.includes(value.logicType) ? value.logicType : "其他";
  output.comment = sanitizeStringField(value.comment);
  return Object.values(output).every((item) => item === "") ? null : output;
}

function sanitizeErrorTags(value) {
  if (!Array.isArray(value)) return [];
  const tags = new Set();
  for (const tag of value) {
    const candidate = trimmed(tag);
    if (TRANSLATION_REVIEW_ERROR_TAGS.includes(candidate)) tags.add(candidate);
  }
  return [...tags].slice(0, LIST_LIMIT);
}

export function parseTranslationReviewResult(raw) {
  const source = String(raw == null ? "" : raw).trim();
  if (!source) return null;

  let root = tryParse(source);
  if (!root) {
    root = tryParse(stripFences(source));
  }
  if (!root) {
    root = tryParse(extractJsonText(stripFences(source)));
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;

  const clauseProblems = sanitizeProblemList(root.clauseProblems, ["source", "type", "comment"]);
  const nonFiniteProblems = sanitizeProblemList(root.nonFiniteProblems, ["source", "comment"]);
  const modifierProblems = sanitizeProblemList(root.modifierProblems, ["source", "userVersion", "comment"]);
  const referenceProblems = sanitizeProblemList(root.referenceProblems, ["source", "comment"]);
  const logicProblems = sanitizeProblemList(root.logicProblems, ["source", "logicType", "comment"]);
  const omissions = sanitizeProblemList(root.omissions, ["source", "comment"]);
  const additions = sanitizeProblemList(root.additions, ["userVersion", "comment"]);
  const wordChoiceProblems = sanitizeProblemList(root.wordChoiceProblems, ["word", "userVersion", "contextMeaning", "comment"]);
  const chineseExpressionProblems = sanitizeProblemList(root.chineseExpressionProblems, ["userVersion", "comment"]);
  const errorTags = sanitizeErrorTags(root.errorTags);

  return {
    version: 1,
    summary: sanitizeSummary(root.summary),
    mainClause: sanitizeMainClause(root.mainClause),
    clauseProblems,
    nonFiniteProblems,
    modifierProblems,
    referenceProblems,
    logicProblems,
    omissions,
    additions,
    wordChoiceProblems,
    chineseExpressionProblems,
    minimalRevision: sanitizeStringField(root.minimalRevision),
    referenceTranslation: sanitizeStringField(root.referenceTranslation),
    errorTags,
  };
}

export function reviewHasNoProblems(result) {
  if (!result) return true;
  return [
    result.clauseProblems,
    result.nonFiniteProblems,
    result.modifierProblems,
    result.referenceProblems,
    result.logicProblems,
    result.omissions,
    result.additions,
    result.wordChoiceProblems,
    result.chineseExpressionProblems,
  ].every((list) => !list || list.length === 0) && (!result.errorTags || result.errorTags.length === 0);
}

// ============================================================================
// B 阶段：阅读题 AI 三级提示解析
// ============================================================================

const QUESTION_HINT_LEVELS = [1, 2, 3];

function sanitizeStringList(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const item of value.slice(0, LIST_LIMIT)) {
    const text = sanitizeStringField(item);
    if (text) list.push(text);
  }
  return list;
}

function sanitizeQuestionHintLevel(value) {
  const level = Number(value);
  return QUESTION_HINT_LEVELS.includes(level) ? level : 0;
}

function sanitizeQuestionType(value) {
  return QUESTION_TYPES.includes(value) ? value : "其他";
}

function sanitizeTrapTypes(value) {
  if (!Array.isArray(value)) return [];
  const tags = new Set();
  for (const item of value.slice(0, LIST_LIMIT)) {
    const candidate = trimmed(item);
    if (TRAP_TYPES.includes(candidate)) tags.add(candidate);
  }
  return [...tags].slice(0, LIST_LIMIT);
}

function sanitizeLevel1QuestionHint(root) {
  const focusRaw = root.focus && typeof root.focus === "object" ? root.focus : {};
  const focus = {
    location: sanitizeStringField(focusRaw.location),
    keywords: sanitizeStringList(focusRaw.keywords),
    logicSignals: sanitizeStringList(focusRaw.logicSignals),
  };
  return {
    version: 1,
    level: 1,
    focus,
    readingDirection: sanitizeStringField(root.readingDirection),
    questionForUser: sanitizeStringField(root.questionForUser),
  };
}

function sanitizeLevel2QuestionHint(root) {
  return {
    version: 1,
    level: 2,
    questionType: sanitizeQuestionType(root.questionType),
    questionIntent: sanitizeStringField(root.questionIntent),
    paraphrases: sanitizeProblemList(root.paraphrases, ["questionExpression", "sourceExpression", "explanation"]),
    reasoningSteps: sanitizeStringList(root.reasoningSteps),
    trapTypes: sanitizeTrapTypes(root.trapTypes),
    finalCheck: sanitizeStringField(root.finalCheck),
  };
}

function sanitizeOptionAnalysis(value) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  output.option = sanitizeStringField(value.option).toUpperCase();
  output.result = value.result === "correct" ? "correct" : value.result === "wrong" ? "wrong" : "";
  output.reasonType = TRAP_TYPES.includes(value.reasonType) ? value.reasonType : "";
  output.explanation = sanitizeStringField(value.explanation);
  return output.option && output.result ? output : null;
}

function sanitizeLevel3QuestionHint(root, optionKeys) {
  const allowed = new Set(
    (Array.isArray(optionKeys) ? optionKeys : [])
      .map((key) => String(key || "").toUpperCase())
      .filter(Boolean),
  );
  let optionAnalysis = [];
  if (Array.isArray(root.optionAnalysis)) {
    optionAnalysis = root.optionAnalysis
      .map(sanitizeOptionAnalysis)
      .filter(Boolean)
      .filter((item) => !allowed.size || allowed.has(item.option));
  }
  const covered = new Set(optionAnalysis.map((item) => item.option));
  let correctAnswer = sanitizeStringField(root.correctAnswer).toUpperCase();
  if (allowed.size && !allowed.has(correctAnswer)) correctAnswer = "";
  return {
    version: 1,
    level: 3,
    questionType: sanitizeQuestionType(root.questionType),
    correctAnswer,
    coreConclusion: sanitizeStringField(root.coreConclusion),
    evidence: sanitizeProblemList(root.evidence, ["source", "explanation"]),
    paraphrases: sanitizeProblemList(root.paraphrases, ["questionExpression", "sourceExpression", "explanation"]),
    optionAnalysis,
    hasFullOptionCoverage: !allowed.size || [...allowed].every((key) => covered.has(key)),
    solvingRule: sanitizeStringField(root.solvingRule),
  };
}

export function parseQuestionHintResult(raw, level, optionKeys = null) {
  const expectedLevel = Number(level);
  if (!QUESTION_HINT_LEVELS.includes(expectedLevel)) return null;

  const source = String(raw == null ? "" : raw).trim();
  if (!source) return null;

  let root = tryParse(source);
  if (!root) root = tryParse(stripFences(source));
  if (!root) root = tryParse(extractJsonText(stripFences(source)));
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  if (sanitizeQuestionHintLevel(root.level) !== expectedLevel) return null;

  if (expectedLevel === 1) return sanitizeLevel1QuestionHint(root);
  if (expectedLevel === 2) return sanitizeLevel2QuestionHint(root);
  return sanitizeLevel3QuestionHint(root, optionKeys);
}

// ============================================================================
// C 阶段：阅读题 AI 错因诊断解析
// ============================================================================

function sanitizeDiagnosisBasis(hasUserReasoning, hasRedoAnswer) {
  if (hasUserReasoning) return "user-reasoning";
  return hasRedoAnswer ? "answers-and-redo" : "answers-only";
}

function sanitizeDiagnosisConfidence(value, hasUserReasoning) {
  const candidate = trimmed(value);
  if (!DIAGNOSIS_CONFIDENCE_LEVELS.includes(candidate)) return "low";
  // 没有用户思路时，模型只能依据作答结果推测，不允许无理由给 high。
  if (!hasUserReasoning && candidate === "high") return "medium";
  return candidate;
}

function sanitizeUserErrorTags(value) {
  if (!Array.isArray(value)) return [];
  const tags = new Set();
  for (const item of value.slice(0, LIST_LIMIT)) {
    const candidate = trimmed(item);
    if (USER_ERROR_TAGS.includes(candidate)) tags.add(candidate);
  }
  return [...tags].slice(0, LIST_LIMIT);
}

function sanitizeSelectedOptionAnalysis(value, localAnswers, optionKeys) {
  if (!Array.isArray(value)) return [];
  const allowedKeys = new Set(
    (Array.isArray(optionKeys) ? optionKeys : [])
      .map((key) => String(key || "").toUpperCase())
      .filter(Boolean),
  );
  const output = [];
  for (const item of value.slice(0, LIST_LIMIT)) {
    if (!item || typeof item !== "object") continue;
    const attempt = item.attempt === "redo" ? "redo" : item.attempt === "first" ? "first" : "";
    const localOption = String(localAnswers[attempt] || "").toUpperCase();
    if (!attempt || !/^[A-D]$/.test(localOption)) continue;
    if (allowedKeys.size && !allowedKeys.has(localOption)) continue;
    output.push({
      attempt,
      selectedOption: localOption,
      optionTrapType: TRAP_TYPES.includes(item.optionTrapType) ? item.optionTrapType : "",
      whyAttractive: sanitizeStringField(item.whyAttractive),
      whyWrong: sanitizeStringField(item.whyWrong),
    });
  }
  return output.sort((a, b) => {
    if (a.attempt === b.attempt) return 0;
    return a.attempt === "first" ? -1 : 1;
  });
}

function sanitizeInferredCause(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { summary: "", userErrorTags: [], reasoning: "", uncertainty: "" };
  }
  return {
    summary: sanitizeStringField(value.summary),
    userErrorTags: sanitizeUserErrorTags(value.userErrorTags),
    reasoning: sanitizeStringField(value.reasoning),
    uncertainty: sanitizeStringField(value.uncertainty),
  };
}

export function parseQuestionDiagnosisResult(raw, options = {}) {
  const source = String(raw == null ? "" : raw).trim();
  if (!source) return null;

  const firstAnswer = String(options.firstAnswer || "").toUpperCase();
  const redoAnswer = String(options.redoAnswer || "").toUpperCase();
  const hasFirst = /^[A-D]$/.test(firstAnswer);
  const hasRedo = /^[A-D]$/.test(redoAnswer);
  const hasUserReasoning = Boolean(options.hasUserReasoning);

  let root = tryParse(source);
  if (!root) root = tryParse(stripFences(source));
  if (!root) root = tryParse(extractJsonText(stripFences(source)));
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;

  const localAnswers = {
    first: hasFirst ? firstAnswer : "",
    redo: hasRedo ? redoAnswer : "",
  };
  return {
    version: 1,
    questionType: sanitizeQuestionType(root.questionType),
    diagnosisBasis: sanitizeDiagnosisBasis(hasUserReasoning, hasFirst && hasRedo),
    confidence: sanitizeDiagnosisConfidence(root.confidence, hasUserReasoning),
    observedFacts: sanitizeStringList(root.observedFacts),
    evidence: sanitizeProblemList(root.evidence, ["source", "explanation"]),
    paraphrases: sanitizeProblemList(root.paraphrases, ["questionExpression", "sourceExpression", "explanation"]),
    selectedOptionAnalysis: sanitizeSelectedOptionAnalysis(
      root.selectedOptionAnalysis,
      localAnswers,
      options.optionKeys,
    ),
    attemptComparison: {
      available: hasFirst && hasRedo,
      comment: sanitizeStringField(root.attemptComparison?.comment),
    },
    inferredCause: sanitizeInferredCause(root.inferredCause),
    nextTimeRule: sanitizeStringField(root.nextTimeRule),
    selfCheckQuestions: sanitizeStringList(root.selfCheckQuestions),
  };
}
