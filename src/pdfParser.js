import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { buildDeepReading, normalizePassages } from "./deepReadingParser";
import { isAndroidApp } from "./platform";

GlobalWorkerOptions.workerSrc = workerUrl;

function pdfAssetOptions() {
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
  return {
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
  };
}

function finishLine(lines, current) {
  if (!current.text.trim()) return;
  lines.push({ text: current.text.replace(/\s+/g, " ").trim(), y: current.y, height: current.height || 10 });
}

function textContentToLayout(content) {
  const lines = [];
  let current = { text: "", y: null, height: 10 };

  for (const item of content.items) {
    if (!("str" in item) || !item.str) continue;
    const y = item.transform?.[5] ?? current.y;
    const height = Math.abs(item.height || item.transform?.[3] || 10);
    const startsNewLine = current.text && current.y !== null && Math.abs(y - current.y) > Math.max(2.5, height * 0.4);
    if (startsNewLine) {
      finishLine(lines, current);
      current = { text: "", y, height };
    }
    if (current.y === null) current.y = y;
    current.height = Math.max(current.height, height);
    current.text += `${item.str} `;
    if (item.hasEOL) {
      finishLine(lines, current);
      current = { text: "", y: null, height: 10 };
    }
  }
  finishLine(lines, current);

  const heights = lines.map((line) => line.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  let output = "";
  lines.forEach((line, index) => {
    if (index > 0) {
      const previous = lines[index - 1];
      const gap = Math.abs(previous.y - line.y);
      output += gap > medianHeight * 1.75 ? "\n\n" : "\n";
    }
    output += line.text;
  });
  return output;
}

async function extractTextPages(pdfDocument, onProgress) {
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    onProgress?.({ phase: "text", page: pageNumber, total: pdfDocument.numPages, percent: Math.round((pageNumber / pdfDocument.numPages) * 25) });
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({ pageNumber, text: textContentToLayout(content) });
    page.cleanup();
  }
  return pages;
}

function ocrAssetOptions(onProgress, pageState) {
  const base = new URL(`${import.meta.env.BASE_URL}tesseract/`, window.location.href).href;
  return {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core/`,
    langPath: `${base}lang/`,
    workerBlobURL: false,
    gzip: true,
    logger(message) {
      if (message.status === "recognizing text") {
        const overall = ((pageState.page - 1) + message.progress) / pageState.total;
        onProgress?.({
          phase: "ocr",
          page: pageState.page,
          total: pageState.total,
          percent: 8 + Math.round(overall * 86),
          pagePercent: Math.round(message.progress * 100),
        });
      }
    },
  };
}

async function ocrPages(pdfDocument, onProgress) {
  onProgress?.({ phase: "ocr-loading", page: 0, total: pdfDocument.numPages, percent: 4 });
  const { createWorker } = await import("tesseract.js");
  const pageState = { page: 0, total: pdfDocument.numPages };
  const worker = await createWorker("eng", 1, ocrAssetOptions(onProgress, pageState));
  const pages = [];
  let foundReading = false;

  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      pageState.page = pageNumber;
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2.2, 1400 / baseViewport.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
      const result = await worker.recognize(canvas, { rotateAuto: true });
      const text = result.data.text || "";
      page.cleanup();

      if (/Reading\s+Comprehension|following\s+(?:four\s+)?texts|^\s*Text\s*1\s*$/im.test(text)) foundReading = true;
      if (foundReading && /^\s*Part\s+B\b/im.test(text)) break;
      pages.push({ pageNumber, text });
    }
  } finally {
    await worker.terminate();
  }
  return pages;
}

function documentTitle(file) {
  return file.name.replace(/\.pdf$/i, "").trim() || "自定义精读材料";
}

function hasUsableContent(analysis) {
  return analysis.passages.length > 0
    && analysis.totals.paragraphs > 0
    && (isAndroidApp() || analysis.totals.questions > 0);
}

function normalizeAnalysis(analysis) {
  const passages = normalizePassages(analysis.passages);
  return {
    ...analysis,
    parserRevision: 2,
    passages,
    totals: {
      ...analysis.totals,
      passages: passages.length,
      paragraphs: passages.reduce((sum, passage) => sum + passage.paragraphs.length, 0),
      sentences: passages.reduce((sum, passage) => sum + passage.paragraphs.reduce((count, paragraph) => count + paragraph.sentences.length, 0), 0),
      questions: passages.reduce((sum, passage) => sum + passage.questions.length, 0),
    },
  };
}

export async function parsePdfFile(file, onProgress) {
  onProgress?.({ phase: "opening", page: 0, total: 0, percent: 1 });
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = getDocument({ data, ...pdfAssetOptions() });
  const pdfDocument = await loadingTask.promise;

  try {
    let pages = await extractTextPages(pdfDocument, onProgress);
    let analysis = normalizeAnalysis(buildDeepReading(pages, documentTitle(file)));
    let method = "text";
    const textCharacters = pages.reduce((sum, page) => sum + page.text.replace(/\s/g, "").length, 0);

    if (textCharacters < 300 || !hasUsableContent(analysis)) {
      pages = await ocrPages(pdfDocument, onProgress);
      analysis = normalizeAnalysis(buildDeepReading(pages, documentTitle(file)));
      method = "ocr";
    }

    if (!analysis.passages.length || !analysis.totals.paragraphs) {
      throw new Error("没有识别到可转换的英文阅读文章");
    }

    analysis.method = method;
    analysis.sourcePages = pdfDocument.numPages;
    analysis.warnings = [];
    if (!analysis.totals.questions) analysis.warnings.push("识别到了文章，但没有找到带选项的习题");
    onProgress?.({ phase: "done", page: pdfDocument.numPages, total: pdfDocument.numPages, percent: 100 });
    return analysis;
  } finally {
    await loadingTask.destroy();
  }
}
