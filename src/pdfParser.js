import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { buildDeepReading, normalizePassages } from "./deepReadingParser";
import { buildClozeAnalysis, normalizeCloze } from "./clozeParser";
import { computeFileFingerprint } from "./fingerprint";
import { buildPageWarnings, hasUsableContent, ocrPageNumbers, pageQuality, textContentToLayout } from "./pdfParserCore";
import { abortCheck, PdfImportError, runOcrPages } from "./ocrLifecycle";
import { buildExamPageStructure } from "./examPageStructure.js";
import { isAndroidApp } from "./platform.js";
import { PDF_PARSER_VERSION } from "./pdfParserVersion.js";

export { OCR_PAGE_TIMEOUT_MS, OCR_WORKER_INIT_TIMEOUT_MS, PdfImportError } from "./ocrLifecycle";

GlobalWorkerOptions.workerSrc = workerUrl;

export { PDF_PARSER_VERSION } from "./pdfParserVersion.js";

export const PDF_IMPORT_PHASES = {
  reading: "reading",
  fingerprint: "fingerprint",
  text: "text",
  quality: "quality",
  ocrLoading: "ocr-loading",
  ocr: "ocr",
  structure: "structure",
  done: "done",
};

function pdfAssetOptions() {
  const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
  return {
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
  };
}

async function extractTextPages(pdfDocument, onProgress, signal) {
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    abortCheck(signal);
    onProgress?.({ phase: PDF_IMPORT_PHASES.text, page: pageNumber, total: pdfDocument.numPages, percent: Math.round((pageNumber / pdfDocument.numPages) * 30) });
    let page;
    try {
      page = await pdfDocument.getPage(pageNumber);
      abortCheck(signal);
      const content = await page.getTextContent();
      abortCheck(signal);
      pages.push({ pageNumber, text: textContentToLayout(content), textSource: "text-layer" });
    } finally {
      page?.cleanup();
    }
  }
  return pages;
}

function ocrAssetOptions(onProgress, state) {
  const base = new URL(`${import.meta.env.BASE_URL}tesseract/`, window.location.href).href;
  return {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core/`,
    langPath: `${base}lang/`,
    workerBlobURL: false,
    // Android's asset packager stores `*.gz` assets without the `.gz` suffix.
    // Tesseract must therefore request `eng.traineddata` inside the native app;
    // the web build keeps requesting the checked-in `eng.traineddata.gz`.
    gzip: !isAndroidApp(),
    logger(message) {
      if (message.status === "recognizing text") {
        const overall = ((state.done + message.progress) / Math.max(1, state.totalPages));
        onProgress?.({
          phase: PDF_IMPORT_PHASES.ocr,
          page: state.currentPage,
          total: state.totalPages,
          percent: 34 + Math.round(overall * 54),
          pagePercent: Math.round(message.progress * 100),
        });
      }
    },
  };
}

async function renderOcrPage({ pdfDocument, pageNumber, worker, signal }) {
  let page;
  let canvas;
  let renderTask;
  const cancelRender = () => renderTask?.cancel();
  signal?.addEventListener("abort", cancelRender, { once: true });
  try {
    page = await pdfDocument.getPage(pageNumber);
    abortCheck(signal);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, 1400 / baseViewport.width);
    const viewport = page.getViewport({ scale });
    canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    renderTask = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport });
    await renderTask.promise;
    abortCheck(signal);
    const result = await worker.recognize(canvas, { rotateAuto: true });
    return result.data.text || "";
  } finally {
    signal?.removeEventListener("abort", cancelRender);
    page?.cleanup();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

async function ocrPages(pdfDocument, pageNumbers, onProgress, signal) {
  return runOcrPages(pdfDocument, pageNumbers, {
    onProgress,
    signal,
    createWorker: async ({ state, signal }) => {
      abortCheck(signal);
      const { createWorker } = await import("tesseract.js");
      abortCheck(signal);
      return createWorker("eng", 1, ocrAssetOptions(onProgress, state));
    },
    processPage: renderOcrPage,
  });
}

function documentTitle(file) {
  return file.name.replace(/\.pdf$/i, "").trim() || "自定义精读材料";
}

function normalizeAnalysis(analysis, pages = [], parserVersion = PDF_PARSER_VERSION) {
  const passages = normalizePassages(analysis.passages);
  const clozes = (Array.isArray(analysis.clozes) ? analysis.clozes : buildClozeAnalysis(pages, analysis.title))
    .map(normalizeCloze)
    .filter(Boolean);
  return {
    ...analysis,
    parserRevision: parserVersion,
    passages,
    clozes,
    totals: {
      ...analysis.totals,
      passages: passages.length,
      paragraphs: passages.reduce((sum, passage) => sum + passage.paragraphs.length, 0),
      sentences: passages.reduce((sum, passage) => sum + passage.paragraphs.reduce((count, paragraph) => count + paragraph.sentences.length, 0), 0),
      questions: passages.reduce((sum, passage) => sum + passage.questions.length, 0),
      clozes: clozes.length,
      clozeBlanks: clozes.reduce((sum, cloze) => sum + cloze.blanks.length, 0),
    },
  };
}

function importConfidence(analysis, quality, attemptedOcrPages) {
  const questionCount = Number(analysis?.totals?.questions || 0);
  const clozeBlanks = Number(analysis?.totals?.clozeBlanks || 0);
  const passageCount = Number(analysis?.totals?.passages || 0);
  const warningCount = Array.isArray(analysis?.warnings) ? analysis.warnings.length : 0;
  const status = clozeBlanks >= 20 && passageCount >= 4 && questionCount >= 20
    ? "good"
    : (clozeBlanks || passageCount || questionCount ? "check" : "incomplete");
  return {
    status,
    textLayerPages: quality.filter((entry) => !entry.needsOcr).length,
    ocrPages: attemptedOcrPages.size,
    clozeBlanks,
    passageCount,
    questionCount,
    warningCount,
  };
}

// SHA-256 稳定指纹；无 WebCrypto 时退化为确定性 FNV-1a（绝不为随机）。

export async function parsePdfFile(file, onProgress, {
  signal,
  parserVersion = PDF_PARSER_VERSION,
  ocrPolicy = "auto",
} = {}) {
  if (ocrPolicy !== "auto" && ocrPolicy !== "disabled") {
    throw new PdfImportError("invalid-ocr-policy", `不支持的 OCR 策略：${ocrPolicy}`);
  }
  const allowOcr = ocrPolicy === "auto";
  onProgress?.({ phase: PDF_IMPORT_PHASES.reading, page: 0, total: 0, percent: 0 });
  let data;
  try {
    data = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    throw new PdfImportError("pdf-unreadable", "PDF 文件无法读取，请确认文件未损坏", error);
  }
  abortCheck(signal);
  onProgress?.({ phase: PDF_IMPORT_PHASES.fingerprint, page: 0, total: 0, percent: 2 });
  const fingerprint = await computeFileFingerprint(data);
  abortCheck(signal);

  let loadingTask;
  let pdfDocument;
  try {
    loadingTask = getDocument({ data, ...pdfAssetOptions(), signal });
    pdfDocument = await loadingTask.promise;
  } catch (error) {
    if (signal?.aborted) throw new PdfImportError("cancelled", "已取消解析", error);
    if (error?.name === "PasswordException") {
      throw new PdfImportError("pdf-encrypted", "PDF 已加密，无法读取，请先解除密码保护", error);
    }
    throw new PdfImportError("pdf-corrupt", "PDF 文件损坏或格式不受支持，无法读取", error);
  }

  try {
    let pages = await extractTextPages(pdfDocument, onProgress, signal);
    onProgress?.({ phase: PDF_IMPORT_PHASES.quality, page: 0, total: pages.length, percent: 32 });
    const quality = pageQuality(pages);
    let method = "text";
    const warnings = buildPageWarnings(quality, allowOcr);
    const ocrNeeded = ocrPageNumbers(quality, ocrPolicy);

    const attemptedOcrPages = new Set();
    if (ocrNeeded.length) {
      const ocrResults = await ocrPages(pdfDocument, ocrNeeded, onProgress, signal);
      ocrNeeded.forEach((pageNumber) => attemptedOcrPages.add(pageNumber));
      pages = pages.map((page) => (Object.prototype.hasOwnProperty.call(ocrResults, page.pageNumber)
        ? { ...page, text: ocrResults[page.pageNumber], textSource: "ocr" }
        : page));
      method = "ocr";
    }

    onProgress?.({ phase: PDF_IMPORT_PHASES.structure, page: 0, total: pages.length, percent: 92 });
    let pageStructure = buildExamPageStructure(pages);
    let parsePages = pageStructure.contentPages;
    let analysis = normalizeAnalysis(buildDeepReading(parsePages, documentTitle(file)), parsePages, parserVersion);

    if (!hasUsableContent(analysis, ocrPolicy)) {
      const diagnostics = {
        parserVersion,
        ocrPolicy,
        pageQuality: quality,
        stablePages: parsePages.map((page) => ({ pageNumber: page.pageNumber, text: page.text, textSource: page.textSource })),
      };
      throw new PdfImportError(
        "no-usable-content",
        allowOcr
          ? "没有识别到可转换的英文文章或完形，请确认是文字型或清晰的扫描 PDF"
          : "官方精读资料解析异常，请重试；若持续出现请检查内置资料完整性",
        null,
        diagnostics,
      );
    }

    analysis.method = method;
    analysis.sourcePages = pdfDocument.numPages;
    analysis.pageRecords = pageStructure.records;
    analysis.answerKeyBoundary = pageStructure.answerKeyBoundary;
    const parserWarnings = Array.isArray(analysis.warnings) ? analysis.warnings : [];
    analysis.warnings = [...parserWarnings, ...warnings];
    if (!analysis.totals.questions && !analysis.totals.clozes) {
      analysis.warnings.push("识别到了文章，但没有找到带选项的习题");
    }
    analysis.importConfidence = importConfidence(analysis, quality, attemptedOcrPages);
    onProgress?.({ phase: PDF_IMPORT_PHASES.done, page: pdfDocument.numPages, total: pdfDocument.numPages, percent: 100 });
    return {
      analysis,
      fingerprint,
      pages: parsePages.map((page) => ({ pageNumber: page.pageNumber, text: page.text, textSource: page.textSource })),
    };
  } finally {
    if (pdfDocument) {
      try { await pdfDocument.cleanup(); } catch { /* 已清理 */ }
    }
    if (loadingTask) {
      try { await loadingTask.destroy(); } catch { /* 已销毁 */ }
    }
  }
}
