// 离线构建：从真题 PDF（扫描件）OCR 出 Section I 完形原文 + 选项 + 答案速查，
// 用 src/clozeParser.js 解析成结构化 JSON 资产写入 public/library，并保存测试
// 夹具与一份审核报告。这只是开发期工具，不会进 App runtime。
//
// 用法：
//   node scripts/build_kaoyan_cloze_data.mjs            # 全量 2007-2023
//   node scripts/build_kaoyan_cloze_data.mjs 2010       # 仅指定年份（调试）
//
// 真题路径（用户提供）：
//   英语一 2010-2023：D:\1考研资料\英语\真题\英语一单独年份2010-2023\{year}年真题及答案速查.pdf
//   2001-2009：        D:\1考研资料\英语\真题\英语单独年份2001-2009\{year}年真题及答案速查.pdf

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCanvas, ImageData } from "../node_modules/.pnpm/@napi-rs+canvas@1.0.2/node_modules/@napi-rs/canvas/index.js";
import { buildClozeFromPages, normalizeCloze } from "../src/clozeParser.js";
import { parseClozeAnswerSheet } from "../src/clozeAnswerKeys.js";
import { getOfficialAnswerKey } from "../src/answerKeys.js";

const DOC1_DIR = "D:/1考研资料/英语/真题/英语一单独年份2010-2023";
const DOC2_DIR = "D:/1考研资料/英语/真题/英语单独年份2001-2009";
const OUT_BASE = "public/library/postgraduate";
const FIXTURE_DIR = "scripts/fixtures/cloze";
const CACHE_DIR = "tmp/cloze-ocr-cache";
const TESS_LANG = "D:/codex库/无聊英语/public/tesseract/lang";

const YEARS = Array.from({ length: 17 }, (_, i) => 2007 + i);
const ONLY_YEAR = Number(process.argv[2]) || null;
const TARGET_YEARS = ONLY_YEAR ? [ONLY_YEAR] : YEARS;

function pdfPathFor(year) {
  const dir = year >= 2010 ? DOC1_DIR : DOC2_DIR;
  return `${dir}/${year}年真题及答案速查.pdf`;
}

class CanvasFactory {
  create(w, h) {
    const c = createCanvas(w, h);
    return { canvas: c, context: c.getContext("2d") };
  }
  reset(o, w, h) { o.canvas.width = w; o.canvas.height = h; }
  destroy(o) { o.canvas.width = 0; o.canvas.height = 0; }
}

async function loadPdfDoc(path) {
  const data = new Uint8Array(await readFile(path));
  const loadingTask = getDocument({ data, verbosity: 0, canvasFactory: new CanvasFactory(), ImageData });
  const doc = await loadingTask.promise;
  return { doc, destroy: () => loadingTask.destroy() };
}

async function ocrPage(doc, worker, pageNumber, scale = 3.0) {
  const page = await doc.getPage(pageNumber);
  const vp = page.getViewport({ scale });
  const { canvas, context } = new CanvasFactory().create(Math.floor(vp.width), Math.floor(vp.height));
  await page.render({ canvasContext: context, viewport: vp }).promise;
  const buf = canvas.toBuffer("image/png");
  page.cleanup();
  canvas.width = 0; canvas.height = 0;
  const result = await worker.recognize(buf);
  return result.data.text || "";
}

async function loadCache(year) {
  const p = `${CACHE_DIR}/${year}.json`;
  if (!existsSync(p)) return null;
  try {
    const data = await readFile(p, "utf8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveCache(year, cache) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(`${CACHE_DIR}/${year}.json`, JSON.stringify(cache, null, 2), "utf8");
}

// OCR 前部（Section I 原文 + 选项），动态探测页码，遇到 Reading Comprehension 停。
async function ocrFrontSection(doc, worker) {
  const pages = [];
  for (let pn = 2; pn <= Math.min(doc.numPages, 6); pn += 1) {
    const text = await ocrPage(doc, worker, pn);
    pages.push({ pageNumber: pn, text });
    if (/Reading\s+Comprehension/i.test(text)) break;
    // 若已同时拿到原文与选项（同一页含 "1. [A]"），也停
    if (/Use\s+of\s+English/i.test(text) && /\d\.\s*\[\s*A/i.test(text)) break;
  }
  return pages;
}

// OCR 答案速查页（最后 2 页）。
async function ocrAnswerPages(doc, worker) {
  const pages = [];
  const start = Math.max(1, doc.numPages - 1);
  for (let pn = start; pn <= doc.numPages; pn += 1) {
    const text = await ocrPage(doc, worker, pn);
    pages.push({ pageNumber: pn, text });
    if (/Use\s+of\s+English/i.test(text) && /\d{1,2}\s*[.,]?\s*[A-D]/i.test(text)) break;
  }
  return pages;
}

function buildReadingExpected(resource) {
  const key = getOfficialAnswerKey(resource);
  const expected = {};
  for (const number of Object.keys(key).map(Number)) expected[number] = key[number];
  return expected;
}

function crossCheckReading(extractedReading, resource) {
  const expected = buildReadingExpected(resource);
  const keys = Object.keys(expected).map(Number).sort((a, b) => a - b);
  if (!keys.length) return { consistent: false, matched: 0, mismatched: [] };
  let matched = 0;
  const mismatched = [];
  for (const n of keys) {
    const actual = extractedReading[n];
    if (actual && actual === expected[n]) matched += 1;
    else mismatched.push({ n, expected: expected[n], actual: actual || "缺失" });
  }
  return { consistent: matched === keys.length, matched, mismatched, total: keys.length };
}

async function processYear(year, worker) {
  const pdfPath = pdfPathFor(year);
  if (!existsSync(pdfPath)) {
    return { year, status: "skip", reason: `PDF 不存在: ${pdfPath}` };
  }

  let cache = await loadCache(year);
  if (!cache) {
    const { doc, destroy } = await loadPdfDoc(pdfPath);
    try {
      console.log(`[${year}] OCR 前部...`);
      const front = await ocrFrontSection(doc, worker);
      console.log(`[${year}] OCR 答案页...`);
      const answerPages = await ocrAnswerPages(doc, worker);
      cache = { front, answerPages };
      await saveCache(year, cache);
    } finally {
      await destroy();
    }
  }

  const cloze = buildClozeFromPages(cache.front, `${year} 英语（一）Section I`);
  const normalized = cloze ? normalizeCloze(cloze) : null;

  const answerText = cache.answerPages.map((p) => p.text).join("\n\n");
  const parsed = parseClozeAnswerSheet(answerText);
  const resource = { year, text: 1 };
  const cross = crossCheckReading(parsed.reading, resource);

  return { year, status: "ok", cloze: normalized, rawCloze: cloze, parsed, cross, answerText, frontPages: cache.front };
}

function clozeKeyString(clozeAnswers) {
  let s = "";
  for (let n = 1; n <= 20; n += 1) s += (clozeAnswers[n] || "?");
  return s;
}

async function writeAsset(year, cloze) {
  const dir = `${OUT_BASE}/${year}`;
  await mkdir(dir, { recursive: true });
  const asset = {
    version: 1,
    id: `cloze-${year}`,
    year,
    label: "Section I · Use of English",
    paragraphs: cloze.paragraphs,
    blanks: cloze.blanks,
    source: { type: "official-exam-pdf", method: "offline-ocr", sourcePages: cloze.sourcePages },
    warnings: cloze.warnings,
    createdAt: Date.now(),
  };
  await writeFile(`${dir}/${year}-cloze.json`, JSON.stringify(asset, null, 2), "utf8");
}

async function writeFixtures(year, frontPages, answerText) {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(`${FIXTURE_DIR}/${year}-pages.json`, JSON.stringify(frontPages, null, 2), "utf8");
  await writeFile(`${FIXTURE_DIR}/${year}-answerpage.txt`, answerText, "utf8");
}

async function main() {
  const tesseract = await import("tesseract.js");
  const worker = await tesseract.createWorker("eng", 1, {
    langPath: TESS_LANG,
    cacheMethod: "none",
    gzip: true,
  });

  const report = [];
  try {
    for (const year of TARGET_YEARS) {
      try {
        const r = await processYear(year, worker);
        report.push(r);
        if (r.status === "skip") {
          console.log(`[${year}] 跳过：${r.reason}`);
          continue;
        }
        const c = r.cloze;
        const blanksOk = c ? c.blanks.filter((b) => b.complete).length : 0;
        const detected = c ? c.detectedBlanks : 0;
        const clozeStr = clozeKeyString(r.parsed.cloze);
        console.log(`[${year}] detected=${detected}/20 options完整=${blanksOk}/20 cloze="${clozeStr}" reading交叉=${r.cross.consistent ? "通过" : `不一致(${r.cross.mismatched.length})`}`);
        if (c) console.log(`          warnings: ${JSON.stringify(c.warnings)}`);
        if (!r.cross.consistent) {
          for (const m of r.cross.mismatched.slice(0, 5)) {
            console.log(`          阅读答案不一致 ${m.n}: 期望${m.expected} 实得${m.actual}`);
          }
        }
        if (!c) { console.log(`[${year}] 未识别到 Section I`); continue; }
        if (blanksOk < 20 || detected < 20) console.log(`[${year}] 注意：解析不完整`);

        await writeAsset(year, c);
        await writeFixtures(year, r.frontPages, r.answerText);
      } catch (e) {
        console.error(`[${year}] 失败: ${e.stack || e.message || e}`);
        report.push({ year, status: "error", message: String(e) });
      }
    }
  } finally {
    await worker.terminate();
  }

  console.log("\n==== 构建汇总 ====");
  for (const r of report.filter((x) => x.status === "ok")) {
    const c = r.cloze;
    const blanksOk = c ? c.blanks.filter((b) => b.complete).length : 0;
    console.log(
      `${r.year}: cloze="${clozeKeyString(r.parsed.cloze)}" ` +
      `cross=${r.cross.consistent ? "PASS" : "FAIL"} ` +
      `blanks=${blanksOk}/20 detected=${c ? c.detectedBlanks : 0}/20 ` +
      `warnings=${c ? c.warnings.length : 0}`,
    );
  }
  console.log("\nYEAR_CLOZE_KEYS 待回填（复制粘贴到 clozeAnswerKeys.js）：");
  for (const r of report.filter((x) => x.status === "ok")) {
    const complete = Object.keys(r.parsed.cloze).length === 20;
    console.log(`  ${r.year}: "${clozeKeyString(r.parsed.cloze)}",${complete && r.cross.consistent ? "  // 阅读交叉校验通过" : "  // 阅读交叉不一致，待复核"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});