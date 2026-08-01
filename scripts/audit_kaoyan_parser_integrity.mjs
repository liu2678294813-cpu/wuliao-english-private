import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildDeepReading, normalizePassages } from "../src/deepReadingParser.js";

const output = resolve("output/pdf/kaoyan-parser-integrity-audit.json");

function textLayout(content) {
  const lines = [];
  let current = { text: "", y: null, height: 10 };
  const finish = () => {
    if (current.text.trim()) lines.push({ text: current.text.replace(/\s+/g, " ").trim(), y: current.y, height: current.height || 10 });
  };
  for (const item of content.items) {
    if (!item.str) continue;
    const y = item.transform?.[5] ?? current.y;
    const height = Math.abs(item.height || item.transform?.[3] || 10);
    if (current.text && current.y !== null && Math.abs(y - current.y) > Math.max(2.5, height * 0.4)) {
      finish();
      current = { text: "", y, height };
    }
    if (current.y === null) current.y = y;
    current.height = Math.max(current.height, height);
    current.text += `${item.str} `;
    if (item.hasEOL) {
      finish();
      current = { text: "", y: null, height: 10 };
    }
  }
  finish();
  const heights = lines.map((line) => line.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 10;
  return lines.map((line, index) => (
    index && Math.abs(lines[index - 1].y - line.y) > median * 1.75 ? "\n\n" : "\n"
  ) + line.text).join("");
}

async function parse(path) {
  const task = getDocument({ data: new Uint8Array(await readFile(path)) });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      pages.push({ pageNumber: number, text: textLayout(await page.getTextContent()) });
      page.cleanup();
    }
    return normalizePassages(buildDeepReading(pages, path).passages);
  } finally {
    await task.destroy();
  }
}

const entries = [];
for (let year = 2007; year <= 2023; year += 1) {
  for (let text = 1; text <= 4; text += 1) {
    const key = `${year}-text-${text}`;
    const passages = await parse(resolve(`public/library/postgraduate/${year}/${key}.pdf`));
    const questions = passages.flatMap((passage) => passage.questions);
    const expected = Array.from({ length: 5 }, (_, index) => 21 + (text - 1) * 5 + index);
    const optionCounts = questions.map((question) => question.options.length);
    const suspiciousOptions = questions.flatMap((question) => question.options
      .filter((option) => option.text.length > 140)
      .map((option) => `${question.number}${option.key}`));
    const status = passages.length === 1
      && questions.length === 5
      && questions.every((question, index) => Number(question.number) === expected[index] && question.options.length === 4)
      && suspiciousOptions.length === 0
      ? "passed"
      : "needs-review";
    entries.push({ year, text, passages: passages.length, questions: questions.length, questionNumbers: questions.map((question) => Number(question.number)), optionCounts, suspiciousOptions, status });
  }
}

const target = entries.find((entry) => entry.year === 2012 && entry.text === 2);
const targetQuestion = await parse(resolve("public/library/postgraduate/2012/2012-text-2.pdf"));
const q30 = targetQuestion[0].questions.find((question) => question.number === "30");
const report = {
  scope: "parser output integrity after question-boundary fix",
  coverage: { entries: entries.length, passed: entries.filter((entry) => entry.status === "passed").length, failed: entries.filter((entry) => entry.status !== "passed").length },
  knownCorrection: { year: 2012, text: 2, question: 30, optionD: q30?.options.find((option) => option.key === "D")?.text || null },
  entries,
};
await writeFile(output, JSON.stringify(report, null, 2));
if (report.coverage.failed) throw new Error(`Parser integrity failed for ${report.coverage.failed} entries`);
console.log(`Passed ${report.coverage.passed}/${report.coverage.entries} parser integrity checks.`);
