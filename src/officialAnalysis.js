import { PDF_PARSER_VERSION } from "./pdfParserVersion.js";

const cache = new Map();

export function getCachedOfficialAnalysis(resourceId) {
  return cache.get(resourceId) || null;
}

export async function loadOfficialAnalysis(resource, { signal, onProgress } = {}) {
  const cached = getCachedOfficialAnalysis(resource.id);
  if (cached) return cached;
  const workbookSource = resource.workbookSource || resource.source;
  const response = await fetch(workbookSource, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`PDF 文件读取失败（${response.status}）`);
  const file = new File([await response.blob()], `${resource.year}-text-${resource.text}.pdf`, { type: "application/pdf" });
  const { parsePdfFile } = await import("./pdfParser");
  const parsed = await parsePdfFile(file, onProgress, {
    signal, parserVersion: PDF_PARSER_VERSION, ocrPolicy: "disabled",
  });
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
  cache.set(resource.id, parsed.analysis);
  return parsed.analysis;
}
