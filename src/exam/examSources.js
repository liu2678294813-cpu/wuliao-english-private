import { PDF_PARSER_VERSION, parsePdfFile } from "../pdfParser";
import { computeFileFingerprint } from "../fingerprint";
import { loadOfficialCloze, postgraduateClozeResources, postgraduateResources } from "../library";
import { getOfficialAnswerKey } from "../answerKeys";
import { getClozeOfficialAnswerKey } from "../clozeAnswerKeys";
import { clozeItemId, readingItemId } from "./examCore";

function normalizeOptions(options) { return (options || []).map((option, index) => ({ key: String(option?.key || option?.label || "ABCD"[index]), text: String(option?.text || option?.value || "") })); }

function passageForResource(passages, expectedNumbers) {
  const matching = (passages || []).filter((passage) => {
    const numbers = new Set((passage.questions || []).map((question) => Number(question.number)));
    return expectedNumbers.every((number) => numbers.has(number));
  });
  if (matching.length !== 1) throw new Error("阅读文章无法唯一定位，已停止创建考试");
  return matching[0];
}

export async function preflightX1Paper(year, { signal, onProgress } = {}) {
  const clozeResource = postgraduateClozeResources.find((resource) => Number(resource.year) === Number(year));
  const readingResources = postgraduateResources.filter((resource) => Number(resource.year) === Number(year)).sort((a, b) => a.text - b.text);
  if (!clozeResource || readingResources.length !== 4) throw new Error("该年份的 X1 官方资源不完整");
  onProgress?.("加载完形题");
  const cloze = await loadOfficialCloze(clozeResource);
  const clozeKey = getClozeOfficialAnswerKey(clozeResource);
  const clozePassageText = (cloze.paragraphs || []).map((paragraph) => paragraph.text || "").filter(Boolean).join("\n\n");
  // 完形 Surface 的稳定 source fingerprint：复用项目统一 computeFileFingerprint，
  // 不新增 Exam/Cloze 专用哈希。正文文字 / Blank number / 选项任一变化都会改变指纹，
  // 防止旧考试笔迹错误叠加到新版正文。禁止随机值 / 时钟值 / 运行时 ID。
  const clozePassageFingerprint = await computeFileFingerprint(new TextEncoder().encode(JSON.stringify({
    resourceId: clozeResource.id,
    passageText: clozePassageText,
    blanks: (cloze.blanks || []).map((blank) => ({
      number: blank.number,
      options: normalizeOptions(blank.options),
    })),
  })));
  const clozeItems = (cloze.blanks || []).map((blank, index) => ({
    id: clozeItemId(clozeResource.id, blank.number), resourceId: clozeResource.id, section: "cloze", options: normalizeOptions(blank.options), stem: `第 ${blank.number} 空`, ...(index === 0 ? { passageText: clozePassageText, passageSegments: cloze.paragraphs || [], passageFingerprint: clozePassageFingerprint } : {}), officialAnswer: clozeKey[blank.number], blankNumber: blank.number,
  }));
  const readingItems = [];
  for (const resource of readingResources) {
    onProgress?.(`解析 Text ${resource.text}`);
    const response = await fetch(resource.workbookSource || resource.source, { cache: "no-store", signal });
    if (!response.ok) throw new Error(`Text ${resource.text} PDF 读取失败（${response.status}）`);
    const file = new File([await response.blob()], `${year}-text-${resource.text}.pdf`, { type: "application/pdf" });
    const parsed = await parsePdfFile(file, undefined, { signal, parserVersion: PDF_PARSER_VERSION, ocrPolicy: "disabled" });
    const answerKey = getOfficialAnswerKey(resource);
    const expectedNumbers = Object.keys(answerKey).map(Number).sort((a, b) => a - b);
    if (expectedNumbers.length !== 5) throw new Error(`Text ${resource.text} 官方答案不完整`);
    const passage = passageForResource(parsed.analysis?.passages, expectedNumbers);
    const questions = passage?.questions || [];
    const selected = questions.filter((question) => expectedNumbers.includes(Number(question.number))).sort((a, b) => Number(a.number) - Number(b.number));
    if (selected.length !== 5 || new Set(selected.map((question) => Number(question.number))).size !== 5) throw new Error(`Text ${resource.text} 题号不完整或重复`);
    const passageText = String(
      passage.text
      || passage.content
      || (passage.paragraphs || []).map((paragraph) => paragraph.text || "").filter(Boolean).join("\n\n"),
    ).trim();
    if (!passageText) throw new Error(`Text ${resource.text} 正文为空，已停止创建考试`);
    const passageFingerprint = await computeFileFingerprint(new TextEncoder().encode(JSON.stringify({ resourceId: resource.id, passageText, questions: selected.map((question) => ({ number: question.number, stem: question.stem || question.question || "", options: normalizeOptions(question.options) })) })));
    selected.forEach((question, index) => readingItems.push({
      id: readingItemId(resource.id, question.number), resourceId: resource.id, section: "reading", options: normalizeOptions(question.options), stem: question.stem || question.question || "", ...(index === 0 ? { passageText, passageFingerprint } : { passageFingerprint }), officialAnswer: answerKey[question.number], passageId: passage.id, questionId: question.id, stemFingerprint: question.stemFingerprint || "",
    }));
  }
  const items = [...clozeItems, ...readingItems];
  if (items.length !== 40 || items.some((item) => !item.officialAnswer || item.options.length !== 4)) {
    throw new Error("该年份缺少可核验的官方答案或四选项；不会创建半成品考试");
  }
  return { year: Number(year), items, sourceFingerprint: await computeFileFingerprint(new TextEncoder().encode(JSON.stringify(items))), resources: { cloze: clozeResource, reading: readingResources } };
}
