import { IMPORT_LIMITS, IMPORT_VERSION, hashContent } from "./contracts.js";
import { abortCheck, runOcrPages } from "../ocrLifecycle.js";

export async function detectFormat(file) {
  if (!file.size || file.size > IMPORT_LIMITS.fileBytes) throw new Error("文件为空或超过 100 MiB，请拆分后导入");
  const bytes = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const head = new TextDecoder().decode(bytes);
  if (head.includes("%PDF-")) return "pdf";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && /\.docx$/i.test(file.name)) return "docx";
  if (/\.(txt|md|markdown|json)$/i.test(file.name) || /^text\//.test(file.type)) {
    if (bytes.some((b) => b === 0) && ![0xff, 0xfe].includes(bytes[0])) throw new Error("文件内容不是可读取文本");
    return /\.json$/i.test(file.name) || /^\s*[\[{]/.test(head.replace(/^\uFEFF/, "")) ? "json" : "text";
  }
  throw Object.assign(new Error("不支持的文件格式或文件签名与类型不符"), { code: "unsupported" });
}
function checkDocxZip(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  let offset = bytes.length - 22;
  for (; offset >= Math.max(0, bytes.length - 65557); offset--) if (view.getUint32(offset, true) === 0x06054b50) break;
  if (offset < 0) throw new Error("DOCX ZIP 目录损坏");
  const count = view.getUint16(offset + 10, true); let pos = view.getUint32(offset + 16, true), size = 0;
  if (count > 10000 || pos >= offset) throw new Error("DOCX 目录超过限制");
  const names = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50) throw new Error("DOCX 目录无效");
    const unpacked = view.getUint32(pos + 24, true); size += unpacked;
    const len = view.getUint16(pos + 28, true), extra = view.getUint16(pos + 30, true), comment = view.getUint16(pos + 32, true);
    const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + len)); names.push(name);
    if (view.getUint16(pos + 8, true) & 1) throw new Error("DOCX 已加密");
    if (size > IMPORT_LIMITS.docxBytes) throw new Error("DOCX 解压后超过 200 MiB，请拆分");
    pos += 46 + len + extra + comment;
  }
  if (!names.includes("word/document.xml") || !names.includes("[Content_Types].xml")) throw new Error("文件不是有效 DOCX");
}
async function extractDocx(file, signal) {
  const buffer = await file.arrayBuffer(); checkDocxZip(buffer); abortCheck(signal);
  const mammoth = await import("mammoth/mammoth.browser.js"), api = mammoth.default || mammoth;
  const assets = [];
  const result = await api.convertToHtml({ arrayBuffer: buffer }, { externalFileAccess: false, convertImage: api.images.imgElement(async (image) => {
    if (!/^image\/(png|jpeg)$/.test(image.contentType)) return { src: "", alt: "不支持的题图格式" };
    const data = await image.read("base64");
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: image.contentType });
    const bitmap = await createImageBitmap(blob);
    try { if (bitmap.width * bitmap.height > IMPORT_LIMITS.imagePixels) throw new Error("DOCX 图片超过像素限制"); } finally { bitmap.close(); }
    const key = `docx-image-${assets.length + 1}`; assets.push({ name: key, file: blob, block: null }); return { src: key };
  }) });
  abortCheck(signal);
  const doc = new DOMParser().parseFromString(result.value, "text/html");
  const blocks = [];
  for (const element of doc.body.children) {
    const text = element.tagName === "TABLE" ? [...element.querySelectorAll("tr")].map((row) => [...row.children].map((cell) => cell.textContent).join("\t")).join("\n") : ["OL", "UL"].includes(element.tagName) ? [...element.children].map((li) => li.textContent).join("\n") : element.textContent;
    for (const img of element.querySelectorAll("img")) { const asset = assets.find((a) => a.name === img.getAttribute("src")); if (asset) asset.block = blocks.length; }
    if (text.trim()) blocks.push({ index: blocks.length, kind: element.tagName.toLowerCase(), text: text.trim() });
  }
  return { pages: [{ pageNumber: 1, text: blocks.map((b) => b.text).join("\n\n"), textSource: "docx", blocks }], assets, warnings: result.messages.map((m) => m.message) };
}
export async function extractFile(file, { signal, onProgress, target, encoding = "utf-8" } = {}) {
  abortCheck(signal); const format = await detectFormat(file); onProgress?.({ phase: "extracting", format });
  if (format === "pdf") {
    const { parsePdfFile } = await import("../pdfParser.js");
    return { ...await parsePdfFile(file, onProgress, { signal, extractionOnly: true, ocrLanguages: "eng+chi_sim", includeImages: target === "writing" }), format };
  }
  if (format === "docx") return { ...await extractDocx(file, signal), format };
  if (format === "image") {
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width * bitmap.height > IMPORT_LIMITS.imagePixels) throw new Error("图片超过 2400 万像素，请缩小后导入");
      const { ocrAssetOptions } = await import("../pdfParser.js");
      const text = await runOcrPages(null, [1], { signal, onProgress, createWorker: async ({ state }) => {
        const { createWorker } = await import("tesseract.js"); return createWorker("eng+chi_sim", 1, ocrAssetOptions(onProgress, state));
      }, processPage: async ({ worker }) => {
        const canvas = document.createElement("canvas"); const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.ceil(bitmap.width * scale); canvas.height = Math.ceil(bitmap.height * scale);
        try { canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height); return (await worker.recognize(canvas)).data.text; }
        finally { canvas.width = 0; canvas.height = 0; }
      } });
      return { format, pages: [{ pageNumber: 1, text: text[1], textSource: "ocr" }], assets: target === "writing" ? [{ file, name: file.name, pageNumber: 1 }] : [], warnings: [] };
    } finally { bitmap.close(); }
  }
  const bytes = await file.arrayBuffer(); let text;
  try { const bom = new Uint8Array(bytes); const decoder = bom[0] === 0xff && bom[1] === 0xfe ? "utf-16le" : bom[0] === 0xfe && bom[1] === 0xff ? "utf-16be" : encoding; text = new TextDecoder(decoder, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { throw Object.assign(new Error("文本编码无法解码，请选择 UTF-8、GB18030 或 UTF-16 后重试"), { code: "encoding" }); }
  abortCheck(signal);
  if (!text.trim()) throw new Error("文件没有可读取内容");
  if (format === "json") { const json = JSON.parse(text); return { format, json, pages: [{ pageNumber: 1, text, textSource: "json" }], assets: [], warnings: [] }; }
  const blocks = []; let line = 1;
  for (const [index, block] of text.split(/(?<=\n)\s*\n/).entries()) { const lines = block.split(/\r?\n/).length; blocks.push({ index, text: block, startLine: line, endLine: line + lines - 1, kind: /^\s*#{1,6}\s/.test(block) ? "heading" : "paragraph" }); line += lines; }
  return { format, pages: [{ pageNumber: 1, text, textSource: "text", blocks }], assets: [], warnings: [] };
}
export const extractionCacheId = (username, fingerprint, target) => hashContent({ username, fingerprint, extractor: IMPORT_VERSION, ocr: "eng+chi_sim-local-v1", images: target === "writing" });
