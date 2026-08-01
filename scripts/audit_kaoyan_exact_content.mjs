import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorker } from "tesseract.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildDeepReading, normalizePassages, parseQuestionsFromText } from "../src/deepReadingParser.js";

const root = resolve(".");
const imageRoot = resolve("tmp/pdfs/kaoyan-audit-source");
const output = resolve("output/pdf/kaoyan-exact-content-audit.json");

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

async function parseWorkbook(path) {
  const task = getDocument({ data: new Uint8Array(await readFile(path)) });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      pages.push({ pageNumber: number, text: textLayout(await page.getTextContent()) });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[“”‘’'"`]/g, "").replace(/[^a-z0-9]+/g, "");
}

function similarity(left, right) {
  const a = normalized(left);
  const b = normalized(right);
  if (a === b) return 1;
  if (!a || !b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = a[i - 1] === b[j - 1]
        ? diagonal
        : 1 + Math.min(diagonal, previous[j], previous[j - 1]);
      diagonal = above;
    }
  }
  return Number((1 - previous[b.length] / Math.max(a.length, b.length)).toFixed(4));
}

function questionMap(questions) {
  return new Map(questions.map((question) => [String(question.number), question]));
}

async function main() {
  const files = await readdir(imageRoot);
  if (files.length !== 136) throw new Error(`Expected 136 rendered source pages, found ${files.length}`);
  const worker = await createWorker("eng", 1, {
    langPath: resolve("node_modules/.pnpm/@tesseract.js-data+eng@1.0.0/node_modules/@tesseract.js-data/eng/4.0.0_best_int"),
  });
  const entries = [];
  try {
    for (let year = 2007; year <= 2023; year += 1) {
      for (let text = 1; text <= 4; text += 1) {
        const key = `${year}-text-${text}`;
        const sourceOcr = (await worker.recognize(resolve(imageRoot, `${key}-questions.png`))).data.text;
        const sourceQuestions = questionMap(parseQuestionsFromText(sourceOcr));
        const workbookPath = resolve(`public/library/postgraduate/${year}/${key}.pdf`);
        const pages = await parseWorkbook(workbookPath);
        const analysis = normalizePassages(buildDeepReading(pages, key).passages);
        const workbookQuestions = questionMap(analysis.flatMap((passage) => passage.questions));
        const expectedStart = 21 + (text - 1) * 5;
        const questionChecks = [];
        for (let number = expectedStart; number < expectedStart + 5; number += 1) {
          const sourceQuestion = sourceQuestions.get(String(number));
          const workbookQuestion = workbookQuestions.get(String(number));
          const options = ["A", "B", "C", "D"].map((keyName) => {
            const sourceOption = sourceQuestion?.options.find((option) => option.key === keyName)?.text || "";
            const workbookOption = workbookQuestion?.options.find((option) => option.key === keyName)?.text || "";
            return {
              key: keyName,
              similarity: similarity(sourceOption, workbookOption),
              sourceOcr: sourceOption,
              workbook: workbookOption,
            };
          });
          questionChecks.push({
            number,
            stemSimilarity: similarity(sourceQuestion?.stem, workbookQuestion?.stem),
            options,
            sourceFound: Boolean(sourceQuestion),
            workbookFound: Boolean(workbookQuestion),
          });
        }
        const weakChecks = questionChecks.flatMap((question) => [
          ...(question.stemSimilarity < 0.85 ? [{ number: question.number, field: "stem", similarity: question.stemSimilarity }] : []),
          ...question.options.filter((option) => option.similarity < 0.85).map((option) => ({ number: question.number, field: option.key, similarity: option.similarity })),
        ]);
        entries.push({ year, text, workbook: workbookPath.replace(`${root}\\`, "").replaceAll("\\", "/"), questionChecks, weakChecks, status: weakChecks.length ? "needs-review" : "passed" });
        console.log(`${key}: ${weakChecks.length ? `review ${weakChecks.length}` : "passed"}`);
      }
    }
  } finally {
    await worker.terminate();
  }
  const failures = entries.filter((entry) => entry.status !== "passed");
  await writeFile(output, JSON.stringify({ coverage: { entries: entries.length, passed: entries.length - failures.length, failed: failures.length }, entries }, null, 2));
  if (failures.length) throw new Error(`Exact-content audit needs review for ${failures.map((entry) => `${entry.year} Text ${entry.text}`).join(", ")}`);
  console.log(`Passed ${entries.length}/${entries.length} exact-content audits.`);
}

await main();
