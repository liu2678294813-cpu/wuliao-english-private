import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createAccount, openOfficialResource, uniqueUsername } from "../e2e/helpers.js";

const baseURL = process.env.WULIAO_PREVIEW_URL || "http://127.0.0.1:5200";
const outputDir = path.resolve("test-results", "pdf-export-smoke");
const variants = ["short", "normal", "long"];
const moduleHeadings = [
  "文章导读", "干净原文：限时读文", "第一次做题：完成全部习题",
  "逐句笔译与原文订正", "初做订正", "全文核对后：正式重做", "全文压缩与第二天复读",
];
const moduleFooters = ["文章导读", "限时读文", "第一次做题", "逐句笔译", "初做订正", "正式重做", "第二天复读"];
const documentIdentity = "2007 英语（一）Text 1";

async function isPreviewReady() {
  try {
    const response = await fetch(`${baseURL}/`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensurePreviewServer() {
  if (await isPreviewReady()) return null;
  if (process.env.WULIAO_PREVIEW_URL) {
    throw new Error(`WULIAO_PREVIEW_URL is not reachable: ${baseURL}`);
  }
  const viteEntry = path.resolve("node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [
    viteEntry,
    "--config", "vite.app.config.js",
    "preview",
    "--host", "127.0.0.1",
    "--port", "5200",
    "--strictPort",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let startupOutput = "";
  child.stdout.on("data", (chunk) => { startupOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { startupOutput += String(chunk); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Preview server exited before readiness (${child.exitCode}):\n${startupOutput}`);
    }
    if (await isPreviewReady()) return child;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`Preview server did not become ready:\n${startupOutput}`);
}

async function inspectPdf(file) {
  const data = new Uint8Array(await readFile(file));
  const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
  const document = await loadingTask.promise;
  const pages = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({
      width: viewport.width,
      height: viewport.height,
      text: content.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim(),
    });
  }
  await loadingTask.destroy();
  if (pages.some((page) => Math.abs(page.width / page.height - 210 / 297) > 0.01)) {
    throw new Error(`${file}: generated page is not A4 portrait`);
  }
  if (pages.some((page) => !page.text)) throw new Error(`${file}: generated a blank page`);
  pages.forEach((page, index) => {
    const compactText = page.text.replace(/\s+/g, "");
    if (!compactText.includes(documentIdentity.replace(/\s+/g, ""))) {
      throw new Error(`${file}: page ${index + 1} is missing document identity footer`);
    }
    if (!compactText.includes(`${index + 1}/${pages.length}`)) {
      throw new Error(`${file}: page ${index + 1} is missing its page-number footer`);
    }
    if (!moduleFooters.some((label) => page.text.includes(label))) {
      throw new Error(`${file}: page ${index + 1} is missing its module footer`);
    }
  });
  const headingPages = moduleHeadings.map((heading) => pages.findIndex((page) => page.text.includes(heading)));
  if (headingPages.some((index) => index < 0)) {
    throw new Error(`${file}: missing module heading(s): ${JSON.stringify(headingPages)}`);
  }
  if (headingPages.some((pageIndex, index) => index > 0 && pageIndex <= headingPages[index - 1])) {
    throw new Error(`${file}: major modules do not start on distinct new pages: ${headingPages.join(",")}`);
  }
  if (pages.some((page) => page.text.includes("我的证据"))) {
    throw new Error(`${file}: initial-answer pages unexpectedly contain evidence prompts`);
  }
  if (pages.length > 40) throw new Error(`${file}: unreasonable page count ${pages.length}`);
  return { pageCount: pages.length, headingPages: headingPages.map((index) => index + 1) };
}

await mkdir(outputDir, { recursive: true });
const previewProcess = await ensurePreviewServer();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await createAccount(page, uniqueUsername("export-pdf"));
  await openOfficialResource(page, "2007 英语（一）Text 1");
  await page.evaluate(() => { window.AndroidPdfExporter = { exportCurrentDocument() {} }; });
  await page.getByRole("button", { name: "导出成品 PDF" }).click();
  const documentLocator = page.locator(".simplified-export-document");
  await documentLocator.waitFor({ state: "visible", timeout: 30000 });

  const metrics = await documentLocator.evaluate((document) => ({
    modules: document.querySelectorAll(".simplified-export-module").length,
    questionCount: document.querySelectorAll(".simplified-export-module:nth-of-type(3) .simplified-export-question").length,
    paragraphCount: document.querySelectorAll(".simplified-export-natural-paragraph").length,
    initialEvidenceRows: document.querySelectorAll(".simplified-export-module:nth-of-type(3) .simplified-export-evidence").length,
    translationLineCounts: [...document.querySelectorAll(".simplified-export-lines")].map((node) => node.children.length),
    naturalParagraphChildren: [...document.querySelectorAll(".simplified-export-natural-paragraph")].map((node) => node.children.length),
    text: document.innerText,
  }));
  if (metrics.modules !== 7) throw new Error(`Expected 7 export modules, got ${metrics.modules}`);
  if (metrics.questionCount !== 5) throw new Error(`Expected 5 questions, got ${metrics.questionCount}`);
  if (metrics.paragraphCount !== 5) throw new Error(`Expected 5 natural paragraphs, got ${metrics.paragraphCount}`);
  if (metrics.naturalParagraphChildren.some((count) => count !== 0)) throw new Error("Timed article contains sentence-level block wrappers");
  if (metrics.initialEvidenceRows !== 0) throw new Error("Initial-answer export unexpectedly contains evidence rows");
  if (!metrics.translationLineCounts.length || metrics.translationLineCounts.some((count) => count < 1 || count > 4)) {
    throw new Error(`Invalid translation line counts: ${metrics.translationLineCounts.join(",")}`);
  }
  if (!metrics.text.includes("第一次做题") || !metrics.text.includes("全文核对后：正式重做")) {
    throw new Error("Export is missing required learning modules");
  }

  const baseMarkup = await documentLocator.innerHTML();
  const results = [];
  await page.emulateMedia({ media: "print" });
  for (const variant of variants) {
    await documentLocator.evaluate((document, { markup, mode }) => {
      document.innerHTML = markup;
      const natural = [...document.querySelectorAll(".simplified-export-natural-paragraph")];
      const translations = [...document.querySelectorAll(".simplified-export-paragraph-block")];
      if (mode === "short") {
        natural.slice(1).forEach((node) => node.remove());
        translations.slice(1).forEach((node) => node.remove());
      } else if (mode === "long") {
        const article = document.querySelector(".simplified-export-article");
        const translationModule = document.querySelector(".simplified-export-module:nth-of-type(4)");
        natural.forEach((node) => {
          const clone = node.cloneNode(true);
          clone.append(` ${"This deliberately long sentence verifies that print layout keeps prose continuous while allowing the browser to wrap it naturally across the available width. ".repeat(5)}`);
          article?.append(clone);
        });
        translations.forEach((node) => translationModule?.append(node.cloneNode(true)));
      }
    }, { markup: baseMarkup, mode: variant });
    const output = path.join(outputDir, `${variant}.pdf`);
    await page.pdf({
      path: output,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    });
    results.push({ variant, output, ...(await inspectPdf(output)) });
  }
  console.log(JSON.stringify({ baseURL, metrics: { ...metrics, text: undefined }, results }, null, 2));
  await context.close();
} finally {
  await browser.close();
  previewProcess?.kill();
}
