import { buildDeepReading, splitArticleParagraphs, splitSentences, parseQuestionsFromText } from "../deepReadingParser.js";
import { parseClozeSection } from "../clozeParser.js";
import { reparsePassage } from "../examImport.js";
import { questionsFor, validateContent, hashContent, contentIdentity, scopedId, assertTarget, plainClone } from "./contracts.js";
import { getWritingQuestion } from "../writing/writingQuestionBank.js";
import { computeWritingFingerprint } from "../writing/writingRepository.js";

const answerHeading = /^\s*(?:#{1,6}\s*)?(?:参考答案|答案速查|答案解析|答案与解析|answer\s+key|answers?(?:\s+and\s+explanations?)?)\s*[:：]?\s*$/im;
const sectionHeading = /^\s*(?:#{1,6}\s*)?(?:Section\s+[IVIl1|]+[^\n]*|(?:Text|Passage)\s+\d+[^\n]*|Writing\s+[AB][^\n]*)$/gim;

export function parseSourceAnswers(pages) {
  const records = []; let active = false, scope = "";
  for (const page of pages) {
    const lines = String(page.text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (answerHeading.test(line)) { active = true; scope = ""; continue; }
      const scopeMatch = /^(?:#{1,6}\s*)?(?:Text|Passage)\s+(\d+)\b/i.exec(line);
      if (scopeMatch) { scope = `Text ${scopeMatch[1]}`; }
      if (/Section\s+I\b.*Use of English/i.test(line)) { scope = "cloze"; }
      if (/Section\s+II\b.*Reading/i.test(line)) { scope = "reading"; }
      const compact = /^(?:\d+\s*[.、:：)\-]?\s*[A-Z]\b[\s,，;；]*){2,}$/i.test(line);
      const labelled = /(?:正确答案|答案|answer)\s*[:：]/i.test(line);
      if (!active && !compact && !labelled) continue;
      const pairs = [...line.matchAll(/(?:^|[\s,，;；])(?:第\s*)?(\d{1,3})(?:\s*题)?\s*[.、:：)\-]?\s*(?:(?:正确答案|答案|answer)\s*[:：]?\s*)?\[?([A-Z])\]?(?=\s|$|[.,，;；:：])/gi)];
      for (const pair of pairs) {
        const remainder = line.slice((pair.index || 0) + pair[0].length).trim();
        const explanation = pairs.length === 1 ? remainder.replace(/^(?:解析|explanation)\s*[:：]?\s*/i, "") : "";
        records.push({ number: String(Number(pair[1])), value: pair[2].toUpperCase(), explanation, scope, source: "source_document", sourceLocation: { page: page.pageNumber, line: i + 1, text: line }, mappingStatus: "unresolved", reviewStatus: "candidate" });
      }
      if (active && !pairs.length && records.length && /^(?:解析|explanation)\s*[:：]/i.test(line)) records.at(-1).explanation += `${records.at(-1).explanation ? "\n" : ""}${line.replace(/^(?:解析|explanation)\s*[:：]\s*/i, "")}`;
    }
  }
  return records;
}
function bodyWithoutAnswers(text) {
  // Remove only an answer block, resume at the next explicit section. Never truncate the whole document.
  const lines = text.split(/\r?\n/); let inAnswers = false; const output = [];
  for (const line of lines) {
    if (answerHeading.test(line)) { inAnswers = true; continue; }
    if (inAnswers && /^\s*(?:#{1,6}\s*)?(?:Text\s+\d+|Passage\s+\d+|Section\s+[IVIl1|]+|Writing\s+[AB])\b/i.test(line)) inAnswers = false;
    if (!inAnswers) output.push(line);
  }
  return output.join("\n");
}
function sections(text) {
  const markers = [...text.matchAll(sectionHeading)];
  if (!markers.length) return [{ label: "", text, start: 0, end: text.length }];
  return markers.map((m, i) => ({ label: m[0].trim().replace(/^#+\s*/, ""), text: text.slice(m.index, markers[i + 1]?.index ?? text.length), start: m.index, end: markers[i + 1]?.index ?? text.length }));
}
function localWriting(text, title) {
  const year = text.match(/\b(?:19|20)\d{2}\b/); const type = /Writing\s+A\b|小作文/i.test(text) ? "postgrad-en1-writing-a" : /Writing\s+B\b|大作文/i.test(text) ? "postgrad-en1-writing-b" : null;
  const sample = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:参考范文|范文|Sample\s+(?:Essay|Answer)|Reference\s+(?:Essay|Answer)|Model\s+Essay)\s*[:：]?\s*/i.exec(text);
  let promptText = "", referenceEssay = "";
  if (sample) { promptText = text.slice(0, sample.index).replace(/^\s*(?:Writing\s+[AB]|Section\s+III[^\n]*)[^\n]*\n/i, "").trim(); referenceEssay = text.slice(sample.index + sample[0].length).trim(); }
  else if (/Directions\s*:|作文题目|Write\s+(?:an?\s+)?(?:essay|letter|notice|email)/i.test(text)) promptText = text.trim();
  else referenceEssay = text.trim();
  return { title, promptText, directions: promptText, referenceEssay, taskType: type, year: year ? Number(year[0]) : null, assets: [] };
}
function structuredItems(json, target) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("JSON 必须是结构化资料对象");
  if (json.format === "wuliao-writing-private-samples") {
    if (json.version !== 1 || !Array.isArray(json.items)) throw new Error("私有范文格式版本或 items 无效");
    return target !== "writing" ? [] : json.items.map((item) => {
      const q = getWritingQuestion(item.questionId);
      if (!q || item.year !== q.year || item.taskType !== q.taskType || item.promptFingerprint !== q.fingerprint || typeof item.referenceEssay !== "string" || !item.referenceEssay.trim() || !/^[0-9a-f]{64}$/i.test(item.sourceDocumentFingerprint || "") || typeof item.sourceLabel !== "string" || !item.sourceLabel.trim()) throw new Error("私有范文官方题目身份或来源校验失败");
      return { title: `${q.year} ${q.taskType}`, privateSource: item, content: { promptText: q.promptText, directions: q.directions, referenceEssay: item.referenceEssay, year: q.year, taskType: q.taskType, assets: q.assets, officialQuestionId: q.questionId, officialPromptFingerprint: q.fingerprint } };
    });
  }
  if (json.format != null) {
    if (json.format !== "wuliao-material-import" || json.version !== 1 || !Array.isArray(json.items)) throw new Error("不支持的 JSON 资料契约");
    const ids = new Set();
    for (const item of json.items) { assertTarget(item.target); if (item.id) { if (ids.has(item.id)) throw new Error("JSON 条目 ID 重复"); ids.add(item.id); } }
    return json.items.filter((item) => item.target === target);
  }
  if (target === "reading" && Array.isArray(json.passages)) return json.passages.map((content) => ({ content, title: content.label || json.title }));
  if (target === "cloze" && Array.isArray(json.clozes)) return json.clozes.map((content) => ({ content: { ...content, dynamicBlankNumbers: true }, title: content.label || json.title }));
  if (json.type === "cloze" && target === "cloze") return [{ content: { ...json, dynamicBlankNumbers: true }, title: json.label }];
  throw new Error("JSON 未符合导入契约，无法确认目标结构");
}
export async function parseCandidates(extracted, { username, fingerprint, target, title, fileId }) {
  assertTarget(target); const fullText = extracted.pages.map((p) => p.text).join("\n\n");
  const text = bodyWithoutAnswers(fullText), groups = sections(text); let raw = [];
  if (extracted.json) raw = structuredItems(extracted.json, target);
  else if (target === "cloze") {
    const candidates = groups.filter((g) => /Use\s+of\s+English|完形/i.test(g.label));
    for (const g of candidates.length ? candidates : !/Text\s+\d|Writing\s+[AB]/i.test(text) ? groups : []) {
      const content = parseClozeSection(g.text, title, { dynamic: true });
      if (content?.detectedBlanks) raw.push({ title: `${title} · 完形 ${raw.length + 1}`, content, locator: g });
    }
  } else if (target === "reading") {
    const candidates = groups.filter((g) => /^(?:Text|Passage)\s+\d+/i.test(g.label));
    if (candidates.length) {
      for (const g of candidates) { const content = reparsePassage(g.text, g.label.match(/\d+/)?.[0]); if (content?.paragraphs.length) raw.push({ title: `${title} · ${g.label}`, content, locator: g }); }
    } else if (!/Use of English|Writing\s+[AB]|Section\s+III/i.test(text)) {
      const analysis = buildDeepReading(extracted.pages.map((p) => ({ ...p, text: bodyWithoutAnswers(p.text) })), title);
      raw = analysis.passages.map((content) => ({ title: `${title} · ${content.label}`, content }));
      if (!raw.length) { const paragraphs = splitArticleParagraphs(text); if (paragraphs.length) raw.push({ title, content: { label: title, paragraphs: paragraphs.map((t, i) => ({ number: i + 1, text: t, sentences: splitSentences(t) })), questions: parseQuestionsFromText(text) } }); }
    }
  } else {
    const candidates = groups.filter((g) => /Writing\s+[AB]|Section\s+III.*Writing/i.test(g.label));
    raw = (candidates.length ? candidates : !/Use of English|Text\s+\d+/i.test(text) ? groups : []).map((g, i) => ({ title: `${title}${i ? ` · ${i + 1}` : ""}`, content: localWriting(g.text, title), locator: g }));
  }
  const output = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i], content = plainClone(item.content); const id = scopedId(username, target, fingerprint, `entry-${i + 1}`);
    if (item.privateSource?.referenceEssayFingerprint && item.privateSource.referenceEssayFingerprint !== await computeWritingFingerprint({ referenceEssay: content.referenceEssay })) throw new Error("私有范文内容指纹不匹配");
    const validation = validateContent(target, content);
    if (extracted.json && validation.errors.length) throw new Error(`JSON 条目 ${i + 1}：${validation.errors.join("；")}`);
    if (extracted.json) {
      for (const group of [content.paragraphs || [], questionsFor(target, content)]) { const ids = group.filter((r) => r.id).map((r) => r.id); if (new Set(ids).size !== ids.length) throw new Error("JSON 段落或题目 ID 重复"); }
      if (content.assets?.some((a) => !a || a.src && /^(?:https?:)?\/\//i.test(a.src) || a.fileId)) throw new Error("JSON 附件须通过本地文件导入，不能引用外部图片或任意数据库文件");
    }
    const sourceText = item.locator?.text || text;
    const start = fullText.indexOf(sourceText.slice(0, Math.min(120, sourceText.length)));
    const end = start >= 0 ? start + sourceText.length : -1;
    let pageOffset = 0;
    const sourcePages = extracted.pages.filter((p) => { const from = pageOffset; pageOffset += p.text.length + 2; return start >= 0 && from < end && pageOffset > start; }).map((p) => p.pageNumber);
    if (target === "writing") content.importAssetIndexes = (extracted.assets || []).map((a, index) => ({ a, index })).filter(({ a }) => raw.length === 1 || a.pageNumber && sourcePages.includes(a.pageNumber)).map(({ index }) => index);
    content.id = id;
    if (content.paragraphs) content.paragraphs.forEach((p, index) => { p.id = `${id}:p:${index + 1}`; if (target === "reading" && !Array.isArray(p.sentences)) p.sentences = splitSentences(p.text || ""); p.sentenceIds = (p.sentences || []).map((_, i) => `${p.id}:s:${i + 1}`); });
    questionsFor(target, content).forEach((q, index) => { q.id = `${id}:q:${index + 1}`; });
    const answers = item.answers == null ? [] : Array.isArray(item.answers) ? item.answers : Object.entries(item.answers).map(([number, value]) => ({ number, value }));
    for (const answer of answers) if (!answer || !/^\d+$/.test(String(answer.number)) || !/^[A-Z]$/.test(String(answer.value))) throw new Error("JSON 答案格式无效");
    output.push({ id, fileId, fingerprint, target, title: item.title || title, content, revision: 1, selected: true, contentFingerprint: await hashContent(contentIdentity(target, content)), validation: validateContent(target, content), answers: answers.map((a) => ({ ...a, source: "source_document", scope: content.label || "", sourceLocation: { file: title, entry: i + 1 }, mappingStatus: "unresolved", reviewStatus: "candidate" })), explanations: item.explanations || [], sourceLocation: { start, end, pages: sourcePages }, rawText: item.locator?.text || text, status: "review_required" });
  }
  const parsedAnswers = extracted.json ? [] : parseSourceAnswers(extracted.pages);
  for (const record of parsedAnswers) {
    const possible = output.filter((c) => questionsFor(c.target, c.content).some((q) => String(q.number) === record.number) && (!record.scope || record.scope === "reading" && c.target === "reading" || record.scope === "cloze" && c.target === "cloze" || c.content.label === record.scope));
    if (possible.length === 1) possible[0].answers.push(record);
    else if (possible.length > 1) possible.forEach((c) => c.answers.push({ ...record, ambiguous: true }));
    else if (output.length) output[0].answers.push({ ...record, ambiguous: true });
  }
  return output.map((candidate) => ({ ...candidate, answers: mapAnswers(candidate) }));
}
export function mapAnswers(candidate) {
  const qs = questionsFor(candidate.target, candidate.content);
  return (candidate.answers || []).map((record) => {
    const q = qs.find((q) => String(q.number) === String(record.number));
    const conflicts = candidate.answers.filter((a) => String(a.number) === String(record.number) && a.value !== record.value);
    const valid = q && q.options.some((o) => o.key === record.value) && !record.ambiguous && !conflicts.length;
    return { ...record, questionId: valid ? q.id : null, mappingStatus: valid ? "matched" : "unresolved", reviewStatus: valid && record.source === "source_document" ? "confirmed" : record.reviewStatus === "confirmed" && valid ? "confirmed" : "candidate" };
  });
}
