import { callAi, getAiApiKey, resolveAiModel } from "./ai";
import { validateExamAnalysis } from "./examImport";

export const TASK_PDF_STRUCTURE = "pdf-structure-fallback";

function parseJsonObject(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(text);
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function claimedSourceStrings(analysis) {
  const claims = [];
  for (const passage of analysis?.passages || []) {
    for (const paragraph of passage.paragraphs || []) claims.push(paragraph?.text || paragraph);
    for (const question of passage.questions || []) {
      claims.push(question.stem || question.text);
      for (const option of question.options || []) claims.push(option.text);
    }
  }
  for (const cloze of analysis?.clozes || []) {
    for (const paragraph of cloze.paragraphs || []) claims.push(paragraph?.text || paragraph);
    for (const blank of cloze.blanks || []) {
      for (const option of blank.options || []) claims.push(option.text);
    }
  }
  return claims.map((claim) => String(claim || "").trim()).filter((claim) => claim.length >= 4);
}

export function validateAiPdfStructure(analysis, sourcePages) {
  const issues = validateExamAnalysis(analysis);
  const source = normalized(sourcePages.map((page) => page.text).join("\n"));
  const unmatched = claimedSourceStrings(analysis).filter((claim) => {
    const compact = normalized(claim);
    return compact.length >= 4 && !source.includes(compact);
  });
  return { issues, unmatched };
}

function stripAnswerFields(value) {
  if (Array.isArray(value)) return value.map(stripAnswerFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["answer", "correctAnswer", "officialAnswer", "answerKey"].includes(key))
    .map(([key, child]) => [key, stripAnswerFields(child)]));
}

export async function runPdfStructureFallback({ sourcePages, title, signal = null }) {
  if (!Array.isArray(sourcePages) || !sourcePages.length) throw new Error("本地 OCR 尚未获得稳定页面文本，不能启动 AI 结构识别");
  const apiKey = await getAiApiKey();
  if (!apiKey) throw new Error("请先在 AI API 设置中填写 DeepSeek API Key");
  const sourceText = sourcePages.map((page) => `--- PAGE ${page.pageNumber} ---\n${page.text}`).join("\n\n");
  const response = await callAi({
    apiKey,
    model: resolveAiModel(TASK_PDF_STRUCTURE),
    taskType: TASK_PDF_STRUCTURE,
    signal,
    temperature: 0.1,
    timeoutMs: 120000,
    messages: [
      { role: "system", content: "你只整理用户提供的 OCR 文本结构。只返回 JSON，不得补写原文、选项、题号或答案，不得输出官方答案。输出 {clozes:[],passages:[]}。" },
      { role: "user", content: `资料标题：${title || "自定义 PDF"}\n请按 Section I 与 Reading Part A Text 1-4 整理以下 OCR 文本。正文、题干和选项必须逐字来自输入；Part B/C/Writing/答案页不要纳入。\n\n${sourceText}` },
    ],
  });
  const parsed = stripAnswerFields(parseJsonObject(response.content));
  const analysis = { version: 1, title, createdAt: Date.now(), clozes: parsed.clozes || [], passages: parsed.passages || [] };
  const validation = validateAiPdfStructure(analysis, sourcePages);
  if (validation.issues.errors.length) throw new Error(`AI 结构未通过本地校验：${validation.issues.errors[0]}`);
  analysis.warnings = [
    "结构由用户主动允许的 AI fallback 生成，保存前必须人工核对",
    ...(validation.unmatched.length ? [`有 ${validation.unmatched.length} 项无法在 OCR 原文中逐字对应，请重点检查`] : []),
  ];
  analysis.aiStructure = { model: resolveAiModel(TASK_PDF_STRUCTURE), unmatchedCount: validation.unmatched.length };
  return analysis;
}
