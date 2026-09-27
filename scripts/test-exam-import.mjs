import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFileFingerprint, stablePdfResourceId } from "../src/fingerprint.js";
import {
  buildImportSummary,
  clozeRawText,
  importFailureMessage,
  passageRawText,
  reparseCloze,
  reparsePassage,
  validateExamAnalysis,
} from "../src/examImport.js";
import { buildClozeFromPages } from "../src/clozeParser.js";
import { buildDeepReading } from "../src/deepReadingParser.js";
import {
  assembleReadingPageGroups,
  buildExamPageStructure,
  classifyExamPage,
} from "../src/examPageStructure.js";
import { parseCacheKey } from "../src/storage.js";
import { validateAiPdfStructure } from "../src/pdfAiStructureService.js";

const FIXTURE_DIR = join(fileURLToPath(import.meta.url), "..", "fixtures", "cloze");

// ---------------- 指纹（稳定 resourceId 基础） ----------------

test("同一内容两次计算得到相同指纹", async () => {
  const bytes = new TextEncoder().encode("same-pdf-content");
  const first = await computeFileFingerprint(bytes);
  const second = await computeFileFingerprint(bytes);
  assert.equal(first, second);
  assert.ok(/^[0-9a-f]{64}$|^fnv-/.test(first));
});

test("文件名变化不影响指纹，内容不同不碰撞", async () => {
  const a = new TextEncoder().encode("exam-paper-v1");
  const b = new TextEncoder().encode("exam-paper-v2");
  const fa = await computeFileFingerprint(a);
  const fb = await computeFileFingerprint(b);
  assert.notEqual(fa, fb);
  const fakeFile = { name: "renamed.pdf", arrayBuffer: async () => a.buffer };
  assert.equal(await computeFileFingerprint(fakeFile), fa);
});

test("稳定 resourceId 与用户绑定且可复现", () => {
  const id1 = stablePdfResourceId("abc123", "alice");
  const id2 = stablePdfResourceId("abc123", "alice");
  const id3 = stablePdfResourceId("abc123", "bob");
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
  assert.ok(id1.startsWith("custom-"));
  assert.ok(!id1.includes(Date.now().toString()), "不得包含时间戳");
});

// ---------------- 缓存键 ----------------

test("解析缓存键 = fingerprint + parserVersion", () => {
  assert.equal(parseCacheKey("fp1", 4), "fp1:4");
  assert.notEqual(parseCacheKey("fp1", 4), parseCacheKey("fp1", 5));
  assert.notEqual(parseCacheKey("fp1", 4), parseCacheKey("fp2", 4));
});

// ---------------- examImport 纯函数 ----------------

test("clozeRawText / reparseCloze 往返可重建完形", async () => {
  const raw = await readFile(join(FIXTURE_DIR, "2010-pages.json"), "utf8");
  const pages = JSON.parse(raw);
  const cloze = buildClozeFromPages(pages, "2010");
  assert.ok(cloze);
  const rawText = clozeRawText(cloze);
  const reparsed = reparseCloze(rawText, "2010");
  assert.ok(reparsed, "从正文文本应能重新解析");
  assert.equal(reparsed.blanks.length, 20);
  assert.ok(reparsed.warnings.length <= 2);
});

test("reparseCloze 对无 Section 文本返回 null", () => {
  assert.equal(reparseCloze("", "x"), null);
  assert.equal(reparseCloze("plain text without section marker", "x"), null);
});

test("reparsePassage 重建段落与题目", () => {
  const rawText = [
    "Text 1",
    "",
    "Paragraph one with enough english words to be recognized as an article paragraph.",
    "Paragraph two keeps the story going with more detail about the topic.",
    "",
    "21. What is the main idea of the passage?",
    "[A] First option",
    "[B] Second option",
    "[C] Third option",
    "[D] Fourth option",
  ].join("\n");
  const passage = reparsePassage(rawText, "1");
  assert.ok(passage);
  assert.equal(passage.label, "Text 1");
  assert.ok(passage.paragraphs.length >= 1);
  assert.ok(passage.questions.length >= 1);
});

test("validateExamAnalysis：完形/阅读结构校验", () => {
  const good = {
    clozes: [{ label: "Section I", paragraphs: [{ number: 1, text: "a b c", segments: [{ type: "blank", number: 1 }] }], blanks: [{ number: 1, options: ["A", "B", "C", "D"].map((key) => ({ key, text: key })), complete: true }] }],
    passages: [{ label: "Text 1", paragraphs: [{ number: 1, text: "hello" }], questions: [{ number: 21, options: ["A", "B", "C", "D"].map((key) => ({ key, text: key })) }] }],
  };
  const result = validateExamAnalysis(good);
  assert.equal(result.errors.length, 0);

  const bad = {
    clozes: [{ label: "Section I", paragraphs: [{ number: 1, text: "x" }], blanks: [{ number: 1 }, { number: 1 }] }],
    passages: [{ label: "Text 1", paragraphs: [], questions: [{ number: 21, options: [] }] }],
  };
  const badResult = validateExamAnalysis(bad);
  assert.ok(badResult.errors.length > 0, "缺正文/题号重复应报错");

  assert.deepEqual(validateExamAnalysis({}).errors.length > 0, true);
});

test("buildImportSummary 汇总每部分", () => {
  const summary = buildImportSummary({
    clozes: [{ label: "Section I", blanks: Array.from({ length: 20 }, () => ({ complete: true })) }],
    passages: [{ label: "Text 1", questions: [1, 2, 3, 4, 5], paragraphs: [1, 2] }],
  });
  assert.equal(summary.clozes[0].blanks, 20);
  assert.equal(summary.clozes[0].complete, 20);
  assert.equal(summary.texts[0].questions, 5);
  assert.equal(summary.texts[0].paragraphs, 2);
});

test("importFailureMessage 提供可区分的中文原因", () => {
  assert.equal(importFailureMessage({ code: "pdf-encrypted" }), "PDF 已加密，请先解除密码保护");
  assert.equal(importFailureMessage({ code: "cancelled" }), "已取消导入");
  assert.equal(importFailureMessage(new Error("boom")), "boom");
  assert.equal(importFailureMessage(null), "未知错误");
});

// ---------------- 整卷解析（fixture 驱动） ----------------

test("整卷 fixture：同时产出完形与阅读分析", async () => {
  const files = await readdir(FIXTURE_DIR);
  const pagesFile = files.find((name) => name === "2010-pages.json");
  assert.ok(pagesFile);
  const pages = JSON.parse(await readFile(join(FIXTURE_DIR, pagesFile), "utf8"));
  const analysis = buildDeepReading(pages, "2010 试卷");
  const clozes = [buildClozeFromPages(pages, "2010 试卷")].filter(Boolean);
  assert.ok(clozes.length >= 1, "应识别 Section I");
  assert.equal(clozes[0].blanks.length, 20);
  assert.ok(Array.isArray(analysis.passages));
});

test("页面分类与答案页边界：答案页只终止正文，不提升为可靠答案", () => {
  const pages = [
    { pageNumber: 1, text: "2014 National Postgraduate Entrance Examination" },
    { pageNumber: 2, text: "Text 1\nThis article contains enough English words to begin a reading passage about social policy and public choices. " + "Further context follows. ".repeat(8) },
    { pageNumber: 3, text: "21. What is the main idea?\n[A] one\n[B] two\n[C] three\n[D] four\n22. Why does the author agree?\n[A] one\n[B] two\n[C] three\n[D] four" },
    { pageNumber: 4, text: "答案速查\n21 A 22 B 23 C 24 D 25 A 26 B 27 C 28 D 29 A 30 B" },
    { pageNumber: 5, text: "Answer explanations that must not become article content." },
  ];
  assert.equal(classifyExamPage(pages[1]).type, "passage");
  assert.equal(classifyExamPage(pages[2]).type, "questions");
  const structure = buildExamPageStructure(pages);
  assert.deepEqual(structure.contentPages.map((page) => page.pageNumber), [1, 2, 3]);
  assert.deepEqual(structure.answerKeyBoundary, { pageNumber: 4 });
  assert.ok(!Object.prototype.hasOwnProperty.call(structure, "officialAnswers"));
});

test("跨页组装：文章续页与随后题目归入同一 Text，并保留来源页", () => {
  const pages = [
    { pageNumber: 2, text: "Text 1\n" + "The first page begins a long article with evidence and context. ".repeat(10) },
    { pageNumber: 3, text: "The second page continues the same article without repeating its heading. ".repeat(10) },
    { pageNumber: 4, text: "21. What follows from the passage?\n[A] Alpha\n[B] Beta\n[C] Gamma\n[D] Delta" },
    { pageNumber: 5, text: "Text 2\n" + "A different article begins here with another argument and a separate topic. ".repeat(10) },
  ];
  const groups = assembleReadingPageGroups(pages);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].sourcePages, [2, 3, 4]);
  const analysis = buildDeepReading(pages, "cross-page");
  assert.equal(analysis.passages[0].label, "Text 1");
  assert.deepEqual(analysis.passages[0].sourcePages, [2, 3, 4]);
  assert.equal(String(analysis.passages[0].questions[0].number), "21");
});

test("Part B/C/Writing 结束 Part A 组装，不污染 Text 4", () => {
  const pages = [
    { pageNumber: 10, text: "Text 4\n" + "The final Part A article continues with enough English prose for reliable parsing. ".repeat(10) },
    { pageNumber: 11, text: "36. Which statement is correct?\n[A] one\n[B] two\n[C] three\n[D] four" },
    { pageNumber: 12, text: "Part B\n41. Match each heading with the paragraph.\n[A] alpha\n[B] beta\n[C] gamma\n[D] delta" },
    { pageNumber: 13, text: "Part C\n42. Translate the underlined sentences into Chinese." },
    { pageNumber: 14, text: "Writing\n43. Write an essay." },
  ];
  const structure = buildExamPageStructure(pages);
  assert.deepEqual(structure.contentPages.map((page) => page.pageNumber), [10, 11]);
  assert.deepEqual(structure.partABoundary, { pageNumber: 12 });
  const groups = assembleReadingPageGroups(pages);
  assert.deepEqual(groups[0].sourcePages, [10, 11]);
  const analysis = buildDeepReading(pages, "part-a-boundary");
  assert.deepEqual(analysis.passages[0].sourcePages, [10, 11]);
  assert.deepEqual(analysis.passages[0].questions.map((question) => Number(question.number)), [36]);
});

test("AI 结构结果必须通过本地校验并能回溯到 OCR 原文", () => {
  const sourcePages = [{ pageNumber: 1, text: "Text 1\nA source paragraph appears here.\n21. Source question?\n[A] Alpha\n[B] Beta\n[C] Gamma\n[D] Delta" }];
  const analysis = {
    clozes: [],
    passages: [{
      label: "Text 1",
      paragraphs: [{ number: 1, text: "A source paragraph appears here." }],
      questions: [{ number: 21, stem: "Source question?", options: ["Alpha", "Beta", "Gamma", "Delta"].map((text, index) => ({ key: "ABCD"[index], text })) }],
    }],
  };
  const valid = validateAiPdfStructure(analysis, sourcePages);
  assert.equal(valid.issues.errors.length, 0);
  assert.equal(valid.unmatched.length, 0);
  analysis.passages[0].paragraphs[0].text = "Invented sentence absent from OCR.";
  assert.ok(validateAiPdfStructure(analysis, sourcePages).unmatched.length > 0);
});

test("AI fallback 只能在已有稳定 page text 后由用户按钮触发", async () => {
  const editorSource = await readFile(new URL("../src/ExamImportEditor.jsx", import.meta.url), "utf8");
  const serviceSource = await readFile(new URL("../src/pdfAiStructureService.js", import.meta.url), "utf8");
  assert.match(editorSource, /sourcePages\.length > 0/);
  assert.match(editorSource, /localParserFinishedWithLowConfidence/);
  assert.match(editorSource, /\["check", "incomplete"\]\.includes\(working\.importConfidence\?\.status\)/);
  const errorBranch = editorSource.slice(editorSource.indexOf("{error && !busy"), editorSource.indexOf("{working && !busy"));
  assert.doesNotMatch(errorBranch, /允许 AI 辅助结构识别/);
  assert.match(editorSource, /允许 AI 辅助结构识别/);
  assert.match(serviceSource, /本地 OCR 尚未获得稳定页面文本/);
  assert.match(serviceSource, /不得补写原文、选项、题号或答案/);
});

test("PDF retry 用运行代次隔离迟到的旧解析写回", async () => {
  const editorSource = await readFile(new URL("../src/ExamImportEditor.jsx", import.meta.url), "utf8");
  assert.match(editorSource, /const parseRunRef = useRef\(0\)/);
  assert.match(editorSource, /parseRunRef\.current !== runId/);
  assert.match(editorSource, /parseRunRef\.current === runId/);
  assert.doesNotMatch(editorSource, /cancelledRef/);
});

test("AI fallback 警告可见且人工确认前不能保存", async () => {
  const editorSource = await readFile(new URL("../src/ExamImportEditor.jsx", import.meta.url), "utf8");
  assert.match(editorSource, /working\?\.warnings/);
  assert.match(editorSource, /const requiresAiReview = Boolean\(working\?\.aiStructure\)/);
  assert.match(editorSource, /!requiresAiReview \|\| aiReviewConfirmed/);
  assert.match(editorSource, /我已逐项核对 AI 结构与 OCR 原文/);
  assert.match(editorSource, /请先确认人工核对/);
});
