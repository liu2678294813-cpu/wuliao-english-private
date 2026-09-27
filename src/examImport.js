// 整卷 PDF 导入的结构化校验 / 预览 / 人工修正辅助（纯函数）。
//
// 设计原则：
//   - 解析结果只是"候选"，保存前必须经过预览 + 校验 + 可人工修正。
//   - 完形与阅读分别校验，20 空 / 每篇 5 题只作为 warning 启发式，不是硬规则。
//   - 校验错误阻止保存；warning 允许保存但必须展示。
//   - 自定义 PDF 不得生成官方答案：解析层与编辑器都绝不猜测答案。

import { parseClozeSection } from "./clozeParser";
import { parseQuestionsFromText, splitArticleParagraphs, splitSentences } from "./deepReadingParser";

export function clozeRawText(cloze) {
  const passage = (cloze?.paragraphs || []).map((paragraph) => paragraph.text).join("\n\n");
  const optionsBlock = (cloze?.blanks || [])
    .map((blank) => `${blank.number}. ${(blank.options || []).map((option) => `[${option.key}] ${option.text || ""}`).join("  ")}`)
    .join("\n");
  return optionsBlock ? `${passage}\n\n${optionsBlock}` : passage;
}

export function reparseCloze(rawText, sourceLabel = "cloze") {
  if (!rawText || !rawText.trim()) return null;
  const parsed = parseClozeSection(rawText, sourceLabel);
  if (!parsed) return null;
  if (!parsed.detectedBlanks) return null;
  return parsed;
}

export function passageRawText(passage) {
  return (passage?.paragraphs || []).map((paragraph) => paragraph.text).join("\n\n");
}

export function reparsePassage(rawText, label) {
  if (!rawText || !rawText.trim()) return null;
  const paragraphs = splitArticleParagraphs(rawText);
  const questions = parseQuestionsFromText(rawText);
  if (!paragraphs.length && !questions.length) return null;
  return {
    id: `passage-${String(label || "x").toLowerCase()}`,
    label: label ? `Text ${label}` : "精读文章",
    paragraphs: paragraphs.map((text, paragraphIndex) => ({
      number: paragraphIndex + 1,
      text,
      sentences: splitSentences(text),
    })),
    questions: questions.map((question, questionIndex) => ({
      ...question,
      id: `q-${questionIndex}-${question.number || questionIndex + 1}`,
    })),
  };
}

// 保存前结构校验。返回 { errors, warnings }。
export function validateExamAnalysis(analysis) {
  const errors = [];
  const warnings = [];
  const clozes = Array.isArray(analysis?.clozes) ? analysis.clozes : [];
  const passages = Array.isArray(analysis?.passages) ? analysis.passages : [];

  clozes.forEach((cloze, index) => {
    const label = cloze.label || `完形 ${index + 1}`;
    if (!(cloze?.paragraphs || []).length) errors.push(`${label}：缺少正文`);
    const numbers = (cloze?.blanks || []).map((blank) => blank.number);
    const unique = new Set(numbers);
    if (unique.size !== numbers.length) errors.push(`${label}：Blank 编号重复`);
    const passageBlanks = new Set(
      (cloze?.paragraphs || []).flatMap((paragraph) => (paragraph.segments || []))
        .filter((segment) => segment.type === "blank")
        .map((segment) => segment.number),
    );
    for (const number of numbers) {
      if (!passageBlanks.has(number)) errors.push(`${label}：第 ${number} 空在正文中找不到对应 Blank`);
    }
    (cloze?.blanks || []).forEach((blank) => {
      if (!blank.complete) warnings.push(`${label}：第 ${blank.number} 空选项不完整`);
    });
    if (numbers.length !== 20) warnings.push(`${label}：题数 ${numbers.length}/20（常见为 20）`);
  });

  passages.forEach((passage, index) => {
    const label = passage.label || `Text ${index + 1}`;
    if (!(passage?.paragraphs || []).length) errors.push(`${label}：缺少正文`);
    const numbers = (passage?.questions || []).map((question) => question.number);
    if (new Set(numbers).size !== numbers.length) errors.push(`${label}：题号重复`);
    (passage?.questions || []).forEach((question) => {
      const keys = (question?.options || []).map((option) => option.key);
      if (new Set(keys).size !== keys.length) errors.push(`${label}：选项 key 重复`);
      if (!question?.options?.length) warnings.push(`${label}：题目 ${question.number} 缺少选项`);
    });
  });

  if (!clozes.length && !passages.length) errors.push("没有可保存的学习内容（未识别到完形或阅读）");
  return { errors, warnings };
}

// 结构化预览摘要：每部分题数 / 空数 / 选项完整度 / 警告。
export function buildImportSummary(analysis) {
  const clozes = (Array.isArray(analysis?.clozes) ? analysis.clozes : []).map((cloze, index) => ({
    kind: "cloze",
    label: cloze.label || `Section I ${index + 1}`,
    blanks: (cloze?.blanks || []).length,
    complete: (cloze?.blanks || []).filter((blank) => blank.complete).length,
    warnings: cloze?.warnings || [],
  }));
  const texts = (Array.isArray(analysis?.passages) ? analysis.passages : []).map((passage, index) => ({
    kind: "reading",
    label: passage.label || `Text ${index + 1}`,
    questions: (passage?.questions || []).length,
    paragraphs: (passage?.paragraphs || []).length,
  }));
  return { clozes, texts };
}

export function importFailureMessage(error) {
  if (!error) return "未知错误";
  const code = error?.code;
  const messages = {
    cancelled: "已取消导入",
    "pdf-unreadable": "PDF 无法读取，请确认文件未损坏",
    "pdf-encrypted": "PDF 已加密，请先解除密码保护",
    "pdf-corrupt": "PDF 损坏或格式不受支持",
    "no-text-layer": "PDF 没有可提取的文字层",
    "ocr-init-failed": "本地 OCR 初始化失败",
    "ocr-failed": "OCR 识别失败，请检查扫描件清晰度",
    "no-usable-content": "没有识别到完形或阅读内容",
    "no-section": "未识别到 Section I 或 Text 1–4",
    "invalid-questions": "题目结构异常（题号重复或选项缺失）",
    "storage-failed": "本地存储失败",
  };
  return messages[code] || (error?.message || String(error));
}
