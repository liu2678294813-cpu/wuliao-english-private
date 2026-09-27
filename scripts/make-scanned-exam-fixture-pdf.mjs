// 运行时生成、无版权内容、无文字层的扫描试卷 fixture。
// 先把排版页截图成 PNG，再把 PNG 作为整页图片打印为 PDF。
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const output = path.resolve(process.argv[2] || "tmp/pdfs/scanned-exam-fixture.pdf");
const imageDir = path.resolve("tmp/pdfs/scanned-exam-fixture-pages");
await mkdir(path.dirname(output), { recursive: true });
await mkdir(imageDir, { recursive: true });

const clozePassage = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => {
  const number = start + index;
  return `A careful learner uses <b>${number}</b> evidence before accepting a claim and records why the decision was made.`;
}).join(" ");

const clozeOptions = Array.from({ length: 20 }, (_, index) => {
  const number = index + 1;
  return `<p>${number}. [A] clear [B] hidden [C] careless [D] random</p>`;
}).join("");

const readingQuestions = (start, subject) => Array.from({ length: 5 }, (_, index) => {
  const number = start + index;
  return `<p class="question">${number}. What does the passage suggest about ${subject} ${index + 1}?
    <br>[A] It should rely on traceable evidence.
    <br>[B] It should hide the original record.
    <br>[C] It should replace review with speed.
    <br>[D] It should ignore later corrections.</p>`;
}).join("");

const readingArticle = (subject) => `
  <p>${subject} works best when people preserve observations before adding interpretations. A complete record lets another reader retrace the decision, compare the evidence, and identify which assumptions remain uncertain.</p>
  <p>The process also benefits from deliberate review. New facts may revise an earlier conclusion, but they should not erase the original source or the reason a change was made. This balance keeps the work both practical and accountable.</p>`;

const pages = [
  `<h1>Section I Use of English</h1><p>Directions: choose the best answer for each blank.</p><p>${clozePassage(1, 10)}</p>`,
  `<h2>Cloze passage continued</h2><p>${clozePassage(11, 20)}</p>`,
  `<h2>Cloze options</h2>${clozeOptions}`,
  `<h1>Section II Reading Comprehension</h1><h2>Text 1</h2>${readingArticle("A public library research service").split("</p>")[0]}</p><p>The article continues on the following page so the parser must assemble passage pages before it reads the questions.</p>`,
  `<h2>Questions 21 to 25</h2><p>The service succeeds when technology supports careful human judgment and leaves a reviewable trail.</p>${readingQuestions(21, "library research")}`,
  `<h2>Text 2</h2>${readingArticle("A long term team project")}${readingQuestions(26, "team records")}`,
  `<h2>Text 3</h2>${readingArticle("A scientific field notebook")}${readingQuestions(31, "field notes")}`,
  `<h2>Text 4</h2>${readingArticle("A responsible digital archive")}${readingQuestions(36, "digital archives")}`,
  `<h2>Part B</h2><p>Choose the best heading for each paragraph.</p><p>41. ______</p><p>42. ______</p>
   <h2>Part C Translation</h2><p>Translate the underlined sentence into Chinese.</p><p>People improve a system when they can distinguish an observed fact from an attractive explanation.</p>
   <h2>Writing</h2><p>Write an essay about responsible use of information.</p>`,
  `<h1>Answer Key</h1><p>Section I: ${Array.from({ length: 20 }, (_, index) => `${index + 1} A`).join(" ")}</p><p>Reading: ${Array.from({ length: 20 }, (_, index) => `${index + 21} A`).join(" ")}</p>`,
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1240, height: 1754 }, deviceScaleFactor: 1 });
  const imagePaths = [];
  for (let index = 0; index < pages.length; index += 1) {
    await page.setContent(`<!doctype html><style>
      html,body{margin:0;background:#fff;color:#111;font-family:Arial,sans-serif}
      main{box-sizing:border-box;width:1240px;height:1754px;padding:90px 95px;font-size:21px;line-height:1.45}
      h1{font-size:35px;margin:0 0 25px} h2{font-size:28px;margin:18px 0 16px} p{margin:0 0 12px}
      p.question{margin-bottom:14px}
      footer{position:absolute;right:105px;bottom:70px;color:#555;font-size:18px}
    </style><main>${pages[index]}<footer>Synthetic scan · ${index + 1} / ${pages.length}</footer></main>`);
    const imagePath = path.join(imageDir, `page-${String(index + 1).padStart(2, "0")}.png`);
    await page.screenshot({ path: imagePath, fullPage: false });
    imagePaths.push(imagePath);
  }
  const dataUrls = await Promise.all(imagePaths.map(async (file) => `data:image/png;base64,${(await readFile(file)).toString("base64")}`));
  await page.setContent(`<!doctype html><style>
    @page{size:A4 portrait;margin:0} html,body{margin:0} section{width:210mm;height:297mm;break-after:page}
    section:last-child{break-after:auto} img{display:block;width:210mm;height:297mm;object-fit:fill}
  </style>${dataUrls.map((url) => `<section><img alt="" src="${url}"></section>`).join("")}`, { waitUntil: "load" });
  await page.pdf({ path: output, format: "A4", printBackground: true, preferCSSPageSize: true });
} finally {
  await browser.close();
}

const data = new Uint8Array(await readFile(output));
const loadingTask = pdfjs.getDocument({ data, disableWorker: true });
const document = await loadingTask.promise;
let extractedCharacters = 0;
for (let index = 1; index <= document.numPages; index += 1) {
  const page = await document.getPage(index);
  const content = await page.getTextContent();
  extractedCharacters += content.items.map((item) => item.str).join("").trim().length;
}
const pageCount = document.numPages;
await loadingTask.destroy();
if (pageCount !== pages.length) throw new Error(`Expected ${pages.length} pages, got ${pageCount}`);
if (extractedCharacters !== 0) throw new Error(`Fixture unexpectedly has a text layer (${extractedCharacters} chars)`);
console.log(JSON.stringify({ output, pageCount, extractedCharacters }));
