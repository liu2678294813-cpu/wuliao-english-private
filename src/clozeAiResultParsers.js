import {
  TASK_CLOZE_CONTEXT_REVIEW,
  TASK_CLOZE_DIAGNOSIS,
  TASK_CLOZE_EXPLANATION,
  TASK_CLOZE_HINT_1,
  TASK_CLOZE_HINT_2,
} from "./clozeAiTasks";

const TEXT_LIMIT = 4000;
const LIST_LIMIT = 20;

function text(value) {
  return String(value == null ? "" : value).trim().slice(0, TEXT_LIMIT);
}

function list(value) {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean).slice(0, LIST_LIMIT);
}

function parseJson(raw) {
  const source = String(raw == null ? "" : raw).replace(/```json|```/gi, "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function evidence(value, trustedSources) {
  const trusted = new Map((trustedSources || []).map((item) => [String(item.sentenceId), String(item.source)]));
  return (Array.isArray(value) ? value : []).map((item) => ({
    sentenceId: String(item?.sentenceId || "").trim(),
    source: text(item?.source),
    explanation: text(item?.explanation),
  })).filter((item) => trusted.get(item.sentenceId) === item.source).slice(0, LIST_LIMIT);
}

function optionNotes(value, allowedKeys) {
  const allowed = new Set(allowedKeys || []);
  return (Array.isArray(value) ? value : []).map((item) => ({
    key: String(item?.key || "").toUpperCase(),
    explanation: text(item?.explanation),
  })).filter((item) => allowed.has(item.key) && item.explanation).slice(0, 4);
}

export function parseClozeAiResult(raw, taskType, detail) {
  const root = parseJson(raw);
  if (!root) return null;
  if (taskType === TASK_CLOZE_HINT_1) {
    if (Number(root.level) !== 1) return null;
    return { version: 1, level: 1, focus: text(root.focus), grammarSignals: list(root.grammarSignals), logicSignals: list(root.logicSignals), selfCheckQuestion: text(root.selfCheckQuestion) };
  }
  if (taskType === TASK_CLOZE_HINT_2) {
    if (Number(root.level) !== 2) return null;
    return { version: 1, level: 2, requiredRole: text(root.requiredRole), reasoningSteps: list(root.reasoningSteps), eliminationDimensions: list(root.eliminationDimensions), selfCheckQuestion: text(root.selfCheckQuestion) };
  }
  const trustedEvidence = evidence(root.evidence, detail?.evidenceSources);
  if (taskType === TASK_CLOZE_EXPLANATION) {
    return {
      version: 1,
      coreRequirement: text(root.coreRequirement),
      grammar: text(root.grammar),
      contextLogic: text(root.contextLogic),
      optionNotes: optionNotes(root.optionNotes, (detail?.options || []).map((option) => option.key)),
      evidence: trustedEvidence,
      takeaway: text(root.takeaway),
    };
  }
  if (taskType === TASK_CLOZE_DIAGNOSIS) {
    return {
      version: 1,
      observedPattern: text(root.observedPattern),
      likelyCause: text(root.likelyCause),
      errorTypes: list(root.errorTypes),
      attemptComparison: text(root.attemptComparison),
      evidence: trustedEvidence,
      nextTimeRule: text(root.nextTimeRule),
      selfCheckQuestions: list(root.selfCheckQuestions),
    };
  }
  if (taskType === TASK_CLOZE_CONTEXT_REVIEW) {
    return {
      version: 1,
      contextLogic: text(root.contextLogic),
      manualAnalysisFeedback: text(root.manualAnalysisFeedback),
      evidence: trustedEvidence,
      reviewQuestions: list(root.reviewQuestions),
    };
  }
  return null;
}

export function hasAuthenticClozeEvidence(result, taskType) {
  if ([TASK_CLOZE_HINT_1, TASK_CLOZE_HINT_2].includes(taskType)) return true;
  return Array.isArray(result?.evidence) && result.evidence.length > 0;
}

function normalizeLeakText(value) {
  return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function detectClozeHintLeak(raw, optionTexts = []) {
  const source = String(raw || "");
  const reasons = [];
  if (/(?:正确|标准|应选|答案|选项)\s*(?:是|为|：|:)?\s*[A-D]\b/i.test(source) || /\b[A-D]\s*(?:项|选项)/i.test(source)) {
    reasons.push("answer-letter");
  }
  const normalized = normalizeLeakText(source);
  for (const option of optionTexts || []) {
    const candidate = normalizeLeakText(option);
    if (candidate.length >= 3 && normalized.includes(candidate)) {
      reasons.push("option-text");
      break;
    }
  }
  if (/"(?:correctAnswer|officialAnswer|answer)"\s*:/i.test(source)) reasons.push("answer-field");
  return { leaked: reasons.length > 0, reasons: [...new Set(reasons)] };
}
