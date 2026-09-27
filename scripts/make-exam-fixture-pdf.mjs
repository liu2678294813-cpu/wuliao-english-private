// 生成最小整卷考研英语 PDF 测试件（无外部依赖）：
// Section I 完形 + Section II Text 1–4，文字层 PDF（PDF.js 主路径）。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FIXTURE = join(process.cwd(), "scripts", "fixtures", "cloze", "2010-pages.json");
const OUT = join(process.cwd(), "tmp", "exam-fixture-2010.pdf");

function ascii(value) {
  return String(value).replace(/[^\x20-\x7e]/g, " ");
}

function escapePdfText(value) {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapText(text, maxWidth = 100) {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxWidth) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

function buildPageContent(lines) {
  const lineHeight = 16;
  return lines.map((line, index) => {
    const y = 790 - index * lineHeight;
    return `BT /F1 11 Tf 50 ${y} Td (${escapePdfText(line)}) Tj ET`;
  }).join("\n");
}

function readingLines(number, startQuestion, theme) {
  const paragraph = `${theme} is a subject that has attracted sustained attention from researchers and ordinary people alike. The evidence shows that changes in daily practice can influence institutions, communities, and individual decisions. Instead of treating the issue as a simple choice, observers compare different explanations and examine how each one works in a particular setting. This broader view helps readers understand why a familiar problem can produce different results in different places.`;
  const paragraphTwo = `The passage also emphasizes that useful solutions are rarely created in isolation. They depend on careful observation, reliable information, and a willingness to revise an earlier assumption when new facts appear. People who apply this approach do not ignore practical limits; they use those limits to decide which steps are realistic and which claims still need evidence. The discussion therefore connects a concrete example with a larger question about responsible action.`;
  const questions = [];
  for (let offset = 0; offset < 5; offset += 1) {
    const numberForQuestion = startQuestion + offset;
    questions.push(
      `${numberForQuestion}. What is the main point of the passage?`,
      "[A] A narrow historical detail",
      "[B] A reasoned explanation of the issue",
      "[C] An unrelated personal story",
      "[D] A prediction without evidence",
    );
  }
  return [`Text ${number}`, "", ...wrapText(paragraph), "", ...wrapText(paragraphTwo), "", ...questions];
}

const pagesData = JSON.parse(await readFile(FIXTURE, "utf8"));
const sectionPassageLines = String(pagesData[0]?.text || "")
  .replace(/\|/g, "")
  .split(/\r?\n/)
  .flatMap((line) => line.trim() ? wrapText(line, 100) : [""]);
const sectionOptionGroups = Array.from({ length: 20 }, (_, index) => [
    `${index + 1}. [A] option A for blank ${index + 1}`,
    "[B] option B",
    "[C] option C",
    "[D] option D",
  ]).flat();
const sectionOptionsPages = [
  ["Section I answer options", ...sectionOptionGroups.slice(0, 40)],
  ["Section I answer options continued", ...sectionOptionGroups.slice(40)],
];

const pageLines = [
  [
    "2010 National Postgraduate Entrance Examination - English I",
    "Section I Use of English",
    "Directions: Read the following text. For each numbered blank there are four choices.",
    "",
    ...sectionPassageLines,
  ],
  ...sectionOptionsPages,
  readingLines(1, 21, "Public habits"),
  readingLines(2, 26, "Digital communication"),
  readingLines(3, 31, "Environmental policy"),
  readingLines(4, 36, "Artificial intelligence"),
];

// PDF 对象布局：1 Catalog，2 Pages，随后每页一个 Page，之后一个 Font 和每页一个内容流。
const pageObjectStart = 3;
const fontObject = pageObjectStart + pageLines.length;
const streamObjectStart = fontObject + 1;
const pageRefs = pageLines.map((_, index) => `${pageObjectStart + index} 0 R`).join(" ");
const objects = [];
objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
objects[2] = `<< /Type /Pages /Kids [${pageRefs}] /Count ${pageLines.length} >>`;
for (let index = 0; index < pageLines.length; index += 1) {
  const streamRef = streamObjectStart + index;
  objects[pageObjectStart + index] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${streamRef} 0 R >>`;
}
objects[fontObject] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

let pdf = "%PDF-1.4\n";
const offsets = [];
for (let index = 1; index <= fontObject; index += 1) {
  offsets[index] = Buffer.byteLength(pdf, "ascii");
  pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
}
for (let index = 0; index < pageLines.length; index += 1) {
  const objectNumber = streamObjectStart + index;
  const stream = Buffer.from(`stream\n${buildPageContent(pageLines[index])}\nendstream`, "ascii");
  offsets[objectNumber] = Buffer.byteLength(pdf, "ascii");
  pdf += `${objectNumber} 0 obj\n<< /Length ${stream.length} >>\n${stream.toString("ascii")}\nendobj\n`;
}

const objectCount = streamObjectStart + pageLines.length;
const xrefStart = Buffer.byteLength(pdf, "ascii");
pdf += `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
for (let index = 1; index < objectCount; index += 1) {
  pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

await writeFile(OUT, Buffer.from(pdf, "ascii"));
console.log(`wrote ${OUT} (${Buffer.byteLength(pdf, "ascii")} bytes, ${pageLines.length} pages)`);
