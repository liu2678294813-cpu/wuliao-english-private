import { computeFileFingerprint } from "../fingerprint.js";

export const IMPORT_VERSION = "unified-v1";
export const IMPORT_TARGETS = ["writing", "cloze", "reading"];
export const TARGET_LABELS = { writing: "作文", cloze: "完形", reading: "精读" };
export const IMPORT_LIMITS = { files: 50, fileBytes: 100 * 1024 ** 2, batchBytes: 500 * 1024 ** 2, docxBytes: 200 * 1024 ** 2, imagePixels: 24_000_000 };
export const IMPORT_STORES = ["import-files", "import-batches", "import-cache", "writing-materials", "material-answers", "material-explanations", "answer-evaluations", "import-receipts"];
export const FORMAL_IMPORT_STORES = IMPORT_STORES.filter((name) => !["import-batches", "import-cache"].includes(name));
export const plainClone = (value) => JSON.parse(JSON.stringify(value));
export function assertTarget(target) {
  if (!IMPORT_TARGETS.includes(target)) throw new Error("请选择作文、完形或精读");
  return target;
}
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const hashContent = (value) => computeFileFingerprint(new TextEncoder().encode(stableJson(value)));
export const scopedId = (username, ...parts) => [encodeURIComponent(username), ...parts].join("::");
export function questionsFor(target, content) {
  return target === "cloze" ? content?.blanks || [] : target === "reading" ? content?.questions || [] : [];
}
export function validateContent(target, content) {
  const errors = [], warnings = [];
  if (!content || typeof content !== "object" || Array.isArray(content)) return { errors: ["资料结构必须为对象"], warnings };
  if (!IMPORT_TARGETS.includes(target)) return { errors: ["资料类型无效"], warnings };
  if (target === "writing") {
    for (const field of ["promptText", "directions", "referenceEssay"]) if (content[field] != null && typeof content[field] !== "string") errors.push(`${field} 必须是文本`);
    const present = (field) => typeof content[field] === "string" && Boolean(content[field].trim());
    if (!present("promptText") && !present("referenceEssay")) errors.push("缺少作文题目和范文");
    if (content.year != null && (!Number.isInteger(content.year) || content.year < 1900)) errors.push("年份格式错误");
    if (content.taskType && !["postgrad-en1-writing-a", "postgrad-en1-writing-b"].includes(content.taskType)) errors.push("作文题型无效");
    if (!present("promptText") || !present("referenceEssay") || !content.taskType) warnings.push("待完善：补齐题目、范文及 A/B 题型后可训练");
  } else {
    if (!Array.isArray(content.paragraphs) || !content.paragraphs.length || content.paragraphs.some((p) => !p || typeof p.text !== "string" || !p.text.trim())) errors.push("缺少有效正文段落");
    const qs = questionsFor(target, content);
    if (!Array.isArray(qs)) errors.push("题目必须为数组");
    else {
      const numbers = qs.map((q) => String(q?.number));
      if (new Set(numbers).size !== numbers.length) errors.push("题号重复");
      for (const q of qs) {
        if (!q || typeof q !== "object") { errors.push("题目结构无效"); continue; }
        if (!/^\d+$/.test(String(q.number)) || Number(q.number) < 1) errors.push("题号无效");
        if (target === "reading" && (typeof q.stem !== "string" || !q.stem.trim())) errors.push(`第 ${q.number} 题缺少题干`);
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.some((o) => !o || !/^[A-D]$/.test(o.key) || typeof o.text !== "string" || !o.text.trim())) errors.push(`第 ${q.number} 题选项不完整或不属于 A–D`);
        else if (new Set(q.options.map((o) => o.key)).size !== q.options.length) errors.push(`第 ${q.number} 题选项重复`);
      }
      if (target === "cloze") {
        const segments = (Array.isArray(content.paragraphs) ? content.paragraphs : []).flatMap((p) => p?.segments || []).filter((s) => s?.type === "blank");
        const segmentNumbers = segments.map((s) => String(s.number));
        if (!qs.length || new Set(segmentNumbers).size !== segmentNumbers.length || numbers.some((n) => !segmentNumbers.includes(n)) || segmentNumbers.some((n) => !numbers.includes(n))) errors.push("正文空位与选项题号必须一一对应");
        if (segments.some((s) => s.missing)) errors.push("存在 OCR 推断空位，请对照原文修正并确认");
        if (qs.length !== 20) warnings.push(`当前 ${qs.length} 空，常见题型为 20 空`);
      }
    }
  }
  return { errors: [...new Set(errors)], warnings };
}
export function contentIdentity(target, content) {
  if (target === "writing") return { target, promptText: content.promptText?.trim() || "", referenceEssay: content.referenceEssay?.trim() || "", taskType: content.taskType || null };
  return { target, paragraphs: (content.paragraphs || []).map((p) => p.text.trim().replace(/\s+/g, " ")), questions: questionsFor(target, content).map((q) => ({ number: String(q.number), stem: q.stem || "", options: q.options })) };
}
export function writingReady(content) { return !validateContent("writing", content).errors.length && Boolean(content.promptText?.trim() && content.referenceEssay?.trim() && content.taskType); }
