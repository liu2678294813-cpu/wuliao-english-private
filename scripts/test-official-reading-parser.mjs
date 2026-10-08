import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildDeepReading, normalizePassages } from "../src/deepReadingParser.js";
import {
  hasUsableContent,
  ocrPageNumbers,
  pageQuality,
  textContentToLayout,
} from "../src/pdfParserCore.js";
import { PdfImportError, runOcrPages } from "../src/ocrLifecycle.js";

const SAMPLE_WORKBOOKS = [
  [2007, 1],
  [2012, 3],
  [2023, 1],
];

const pdfAssets = {
  cMapUrl: pathToFileURL(`${resolve("public/pdfjs/cmaps")}/`).href,
  cMapPacked: true,
  standardFontDataUrl: pathToFileURL(`${resolve("public/pdfjs/standard_fonts")}/`).href,
};

function workbookPath(year, text) {
  return resolve(`public/library/postgraduate/${year}/${year}-text-${text}.pdf`);
}

async function readWorkbook(path) {
  const loadingTask = getDocument({ data: new Uint8Array(await readFile(path)), verbosity: 0, ...pdfAssets });
  const pdf = await loadingTask.promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        pages.push({ pageNumber, text: textContentToLayout(await page.getTextContent()) });
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } finally {
    try { await pdf.cleanup(); } catch { /* already cleaned */ }
    await loadingTask.destroy();
  }
}

function assertWorkbookStructure(year, text, pages) {
  const quality = pageQuality(pages);
  assert.equal(quality.filter((entry) => entry.needsOcr).length, 0, `${year} Text ${text} unexpectedly needs OCR`);

  const passages = normalizePassages(buildDeepReading(pages, `${year} Text ${text}`).passages);
  assert.equal(passages.length, 1, `${year} Text ${text} should contain one passage`);
  assert.ok(passages[0].paragraphs.length > 0, `${year} Text ${text} should contain paragraphs`);

  const questions = passages[0].questions;
  const expectedNumbers = Array.from({ length: 5 }, (_, index) => 21 + (text - 1) * 5 + index);
  assert.deepEqual(questions.map((question) => Number(question.number)), expectedNumbers);
  assert.ok(questions.every((question) => question.options.length === 4));
}

function wait(milliseconds = 0) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

test("official reader wires disabled OCR and preserves structural failure", async () => {
  const appSource = await readFile(resolve("src/App.jsx"), "utf8");
  const analysisSource = await readFile(resolve("src/officialAnalysis.js"), "utf8");
  assert.match(appSource, /loadOfficialAnalysis\(resource/);
  assert.match(analysisSource, /ocrPolicy:\s*["']disabled["']/);

  const lowQuality = pageQuality([{ pageNumber: 1, text: "" }]);
  assert.deepEqual(ocrPageNumbers(lowQuality, "disabled"), []);
  assert.deepEqual(ocrPageNumbers(lowQuality, "auto"), [1]);
  assert.equal(hasUsableContent({ passages: [], totals: { clozes: 1 } }, "disabled"), false);
  assert.equal(hasUsableContent({ passages: [{ paragraphs: [] }], totals: { clozes: 0 } }, "disabled"), false);
  assert.equal(hasUsableContent({ passages: [{ paragraphs: [{ text: "article" }] }], totals: { clozes: 0 } }, "disabled"), true);
});

test("official workbook samples are text-readable without OCR", async () => {
  for (const [year, text] of SAMPLE_WORKBOOKS) {
    assertWorkbookStructure(year, text, await readWorkbook(workbookPath(year, text)));
  }
});

test("all 68 official workbooks preserve parser integrity", async () => {
  let count = 0;
  for (let year = 2007; year <= 2023; year += 1) {
    for (let text = 1; text <= 4; text += 1) {
      assertWorkbookStructure(year, text, await readWorkbook(workbookPath(year, text)));
      count += 1;
    }
  }
  assert.equal(count, 68);
});

test("OCR auto path initializes, recognizes, and terminates its worker", async () => {
  const phases = [];
  let terminated = 0;
  const worker = { terminate: () => { terminated += 1; } };
  const result = await runOcrPages({}, [2], {
    onProgress: (progress) => phases.push(progress.phase),
    createWorker: async () => worker,
    processPage: async ({ pageNumber }) => `recognized-${pageNumber}`,
    workerInitTimeoutMs: 50,
    pageTimeoutMs: 50,
  });

  assert.deepEqual(result, { 2: "recognized-2" });
  assert.deepEqual(phases, ["ocr-loading", "ocr"]);
  assert.equal(terminated, 1);
});

test("OCR worker initialization timeout terminates a late worker", async () => {
  let lateResolve;
  let terminated = 0;
  const lateWorker = { terminate: () => { terminated += 1; } };
  const pending = runOcrPages({}, [1], {
    createWorker: () => new Promise((resolvePromise) => { lateResolve = resolvePromise; }),
    processPage: async () => "never reached",
    workerInitTimeoutMs: 15,
    pageTimeoutMs: 15,
  });

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof PdfImportError);
    assert.equal(error.code, "ocr-init-timeout");
    return true;
  });
  assert.equal(typeof lateResolve, "function");
  lateResolve(lateWorker);
  await wait();
  assert.equal(terminated, 1);
});

test("OCR page timeout terminates the active worker", async () => {
  let finishPage;
  let terminated = 0;
  const worker = { terminate: () => { terminated += 1; } };
  const pending = runOcrPages({}, [1], {
    createWorker: async () => worker,
    processPage: () => new Promise((resolvePromise) => { finishPage = resolvePromise; }),
    workerInitTimeoutMs: 50,
    pageTimeoutMs: 15,
  });

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof PdfImportError);
    assert.equal(error.code, "ocr-page-timeout");
    return true;
  });
  assert.equal(terminated, 1);
  finishPage("late result");
  await wait();
});

test("abort cancels OCR and terminates a late worker", async () => {
  const controller = new AbortController();
  let lateResolve;
  let terminated = 0;
  const lateWorker = { terminate: () => { terminated += 1; } };
  const pending = runOcrPages({}, [1], {
    signal: controller.signal,
    createWorker: () => new Promise((resolvePromise) => { lateResolve = resolvePromise; }),
    processPage: async () => "never reached",
    workerInitTimeoutMs: 100,
    pageTimeoutMs: 100,
  });

  await wait();
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof PdfImportError);
    assert.equal(error.code, "cancelled");
    return true;
  });
  lateResolve(lateWorker);
  await wait();
  assert.equal(terminated, 1);
});
