import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorker } from "tesseract.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildDeepReading, normalizePassages } from "../src/deepReadingParser.js";
import { getOfficialAnswerKey } from "../src/answerKeys.js";

const project = resolve(".");
const sourceImages = resolve("tmp/pdfs/kaoyan-audit-source");
const outputPath = resolve("output/pdf/kaoyan-deep-reading-content-audit.json");

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
  const loadingTask = getDocument({ data: new Uint8Array(await readFile(path)) });
  const document = await loadingTask.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      pages.push({ pageNumber, text: textLayout(await page.getTextContent()) });
      page.cleanup();
    }
    return { pages, pageCount: document.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

function tokenCoverage(sourceText, workbookText) {
  const source = sourceText.toLowerCase().match(/[a-z]{4,}/g) || [];
  const workbook = new Set(workbookText.toLowerCase().match(/[a-z]{4,}/g) || []);
  return source.length
    ? Number((source.filter((word) => workbook.has(word)).length / source.length).toFixed(4))
    : 0;
}

function expectedNumbers(text) {
  const start = 21 + (text - 1) * 5;
  return Array.from({ length: 5 }, (_, index) => start + index);
}

async function main() {
  const files = await readdir(sourceImages);
  if (files.length !== 136) throw new Error(`Expected 136 source-page images, found ${files.length}`);
  const worker = await createWorker("eng", 1, {
    langPath: resolve("node_modules/.pnpm/@tesseract.js-data+eng@1.0.0/node_modules/@tesseract.js-data/eng/4.0.0_best_int"),
  });
  const entries = [];
  try {
    for (let year = 2007; year <= 2023; year += 1) {
      for (let text = 1; text <= 4; text += 1) {
        const key = `${year}-text-${text}`;
        const sourceText = `${(await worker.recognize(resolve(sourceImages, `${key}-article.png`))).data.text}\n${(await worker.recognize(resolve(sourceImages, `${key}-questions.png`))).data.text}`;
        const workbookPath = resolve(`public/library/postgraduate/${year}/${key}.pdf`);
        const parsed = await parseWorkbook(workbookPath);
        const passages = normalizePassages(buildDeepReading(parsed.pages, `${key}.pdf`).passages);
        const questions = passages.flatMap((passage) => passage.questions);
        const numbers = questions.map((question) => Number(question.number));
        const expected = expectedNumbers(text);
        const answerKey = getOfficialAnswerKey({ year, text });
        const coverage = tokenCoverage(sourceText, parsed.pages.map((page) => page.text).join("\n"));
        const valid = passages.length === 1
          && questions.length === 5
          && numbers.every((value, index) => value === expected[index])
          && questions.every((question) => question.options.length === 4)
          && Object.keys(answerKey).length === 5
          && coverage >= 0.9;
        entries.push({
          year, text,
          workbook: workbookPath.replace(project + "\\", "").replaceAll("\\", "/"),
          workbookPageCount: parsed.pageCount,
          sourceOcrTokenCoverage: coverage,
          passages: passages.length,
          questions: questions.length,
          questionNumbers: numbers,
          optionCounts: questions.map((question) => question.options.length),
          answerKey,
          status: valid ? "passed" : "needs-review",
        });
      }
    }
  } finally {
    await worker.terminate();
  }
  const failures = entries.filter((entry) => entry.status !== "passed");
  await writeFile(outputPath, JSON.stringify({
    coverage: { entries: entries.length, passed: entries.length - failures.length, failed: failures.length },
    entries,
  }, null, 2));
  if (failures.length) throw new Error(`Audit failed for ${failures.map((entry) => `${entry.year} Text ${entry.text}`).join(", ")}`);
  console.log(`Passed ${entries.length}/${entries.length} source-to-workbook audits.`);
}

await main();
