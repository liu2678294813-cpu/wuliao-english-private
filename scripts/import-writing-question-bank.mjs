import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writingQuestionSources } from "./writing-question-source.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_OLD = "D:\\1考研资料\\英语\\真题\\英语单独年份2001-2009";
const DEFAULT_NEW = "D:\\1考研资料\\英语\\真题\\英语一单独年份2010-2023";
const RENDER_DPI = 220;

function argument(name, fallback) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function taskType(part) {
  return `postgrad-en1-writing-${part}`;
}

function questionId(year, part) {
  return `postgrad-en1-${year}-writing-${part}`;
}

function sourceDirectory(year, oldDirectory, newDirectory) {
  return year <= 2009 ? oldDirectory : newDirectory;
}

function pageDimensions(pdfPath, pageNumber) {
  const result = execFileSync("pdfinfo", ["-f", String(pageNumber), "-l", String(pageNumber), pdfPath], { encoding: "utf8" });
  const pageCount = Number(result.match(/^Pages:\s+(\d+)/m)?.[1]);
  const size = result.match(new RegExp(`^Page\\s+${pageNumber}\\s+size:\\s+([0-9.]+)\\s+x\\s+([0-9.]+)\\s+pts`, "m"))
    || result.match(/^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m);
  if (!Number.isInteger(pageCount) || !size) throw new Error(`Unable to inspect PDF page ${pageNumber}: ${pdfPath}`);
  return { pageCount, widthPoints: Number(size[1]), heightPoints: Number(size[2]) };
}

async function renderAsset({ pdfPath, pageNumber, crop, outputPath }) {
  const { widthPoints, heightPoints } = pageDimensions(pdfPath, pageNumber);
  const pageWidth = Math.round(widthPoints * RENDER_DPI / 72);
  const pageHeight = Math.round(heightPoints * RENDER_DPI / 72);
  const [left, top, width, height] = crop;
  const x = Math.max(0, Math.round(pageWidth * left));
  const y = Math.max(0, Math.round(pageHeight * top));
  const cropWidth = Math.min(pageWidth - x, Math.round(pageWidth * width));
  const cropHeight = Math.min(pageHeight - y, Math.round(pageHeight * height));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const prefix = outputPath.replace(/\.png$/i, "");
  execFileSync("pdftoppm", [
    "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", "-png",
    "-r", String(RENDER_DPI), "-x", String(x), "-y", String(y),
    "-W", String(cropWidth), "-H", String(cropHeight), pdfPath, prefix,
  ], { stdio: "pipe" });
  await access(outputPath);
  return { width: cropWidth, height: cropHeight, sha256: sha256(await readFile(outputPath)) };
}

function makeSnapshot({ year, part, task, asset, source }) {
  const snapshot = {
    questionId: questionId(year, part),
    promptText: task.promptText,
    directions: task.directions,
    promptKind: task.promptKind,
    sourceType: "official",
    taskType: taskType(part),
    year,
    maxScore: part === "a" ? 10 : 20,
    targetWordRange: part === "a" ? { min: 90, max: 110 } : { min: 160, max: 200 },
    assets: asset ? [{
      assetId: `${questionId(year, part)}-prompt`,
      kind: "source_picture",
      src: asset.src,
      alt: `${year} 年英语（一）写作题原卷图画`,
      fingerprint: asset.sha256,
    }] : [],
    source,
  };
  return { ...snapshot, fingerprint: sha256(canonical(snapshot)) };
}

async function inventoryDirectory(directory, selectedYears) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map(async (entry) => {
    const bytes = await readFile(path.join(directory, entry.name));
    const year = Number(entry.name.match(/^(\d{4})/)?.[1]);
    return {
      fileName: entry.name,
      year: Number.isInteger(year) ? year : null,
      sha256: sha256(bytes),
      role: selectedYears.has(year) && entry.name === writingQuestionSources[year]?.sourceFileName
        ? "selected_source"
        : (year >= 2001 && year <= 2023 ? "duplicate_candidate" : "out_of_scope"),
    };
  }));
}

async function main() {
  const oldDirectory = path.resolve(argument("--source-2001-2009", DEFAULT_OLD));
  const newDirectory = path.resolve(argument("--source-2010-2023", DEFAULT_NEW));
  const runtimePath = path.join(repositoryRoot, "src", "writing", "questions", "generatedWritingQuestionData.js");
  const outputRoot = path.join(repositoryRoot, "public", "writing", "questions");
  const auditRoot = path.join(repositoryRoot, "scripts", "output");
  const years = Object.keys(writingQuestionSources).map(Number).sort((a, b) => a - b);
  const records = [];
  const coverage = [];

  await rm(outputRoot, { recursive: true, force: true });
  for (const year of years) {
    const definition = writingQuestionSources[year];
    const pdfPath = path.join(sourceDirectory(year, oldDirectory, newDirectory), definition.sourceFileName);
    const pdfBytes = await readFile(pdfPath);
    const sourceFingerprint = sha256(pdfBytes);
    if (sourceFingerprint !== definition.sourceSha256) throw new Error(`Source fingerprint mismatch for ${year}`);
    const dimensions = pageDimensions(pdfPath, definition.sourcePage);
    if (dimensions.pageCount !== definition.pageCount) throw new Error(`Page count mismatch for ${year}: ${dimensions.pageCount}`);

    let asset = null;
    if (definition.tasks.b) {
      const relative = `/writing/questions/${year}/${questionId(year, "b")}/prompt.png`;
      const destination = path.join(repositoryRoot, "public", ...relative.split("/").filter(Boolean));
      const rendered = await renderAsset({ pdfPath, pageNumber: definition.sourcePage, crop: definition.assetCrop, outputPath: destination });
      asset = { ...rendered, src: relative };
    }

    const presentParts = [];
    for (const part of ["a", "b"]) {
      const task = definition.tasks[part];
      if (!task) continue;
      presentParts.push(part.toUpperCase());
      const source = {
        sourceYear: year,
        sourceFileName: definition.sourceFileName,
        sourcePage: definition.sourcePage,
        sourceSection: year <= 2004 ? "Section III Writing" : `Section III Writing, Part ${part.toUpperCase()}`,
        sourceQuestionNumber: year <= 2004 ? 46 : (part === "a" ? 51 : 52),
        sourceFingerprint,
        sourceAssetFingerprint: part === "b" ? asset.sha256 : null,
      };
      const promptSnapshot = makeSnapshot({ year, part, task, asset: part === "b" ? asset : null, source });
      records.push({ ...promptSnapshot, requiredContentPoints: task.requiredContentPoints });
    }
    coverage.push({
      year,
      sourceFileName: definition.sourceFileName,
      sourcePage: definition.sourcePage,
      sourceFingerprint,
      presentParts,
      absentParts: definition.tasks.a ? [] : [{ part: "A", reason: "NOT_PRESENT_IN_SOURCE" }],
      officialQuestionCount: presentParts.length,
      visualAssetCount: definition.tasks.b ? 1 : 0,
    });
  }

  records.sort((left, right) => right.year - left.year || left.taskType.localeCompare(right.taskType));
  const ids = records.map((record) => record.questionId);
  const fingerprints = records.map((record) => record.fingerprint);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate questionId detected");
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("Duplicate prompt fingerprint detected");

  const selectedYears = new Set(years);
  const inventory = [
    ...(await inventoryDirectory(oldDirectory, selectedYears)).map((item) => ({ ...item, sourceGroup: "2001-2009" })),
    ...(await inventoryDirectory(newDirectory, selectedYears)).map((item) => ({ ...item, sourceGroup: "2010-2023" })),
  ];
  for (const candidate of inventory.filter((item) => item.role === "duplicate_candidate")) {
    const primary = inventory.find((item) => item.year === candidate.year && item.role === "selected_source");
    candidate.byteIdenticalToSelected = primary ? candidate.sha256 === primary.sha256 : false;
  }

  const audit = {
    schemaVersion: 1,
    scope: { years: { min: 2001, max: 2023 }, sourcePolicy: "local_pdf_only", answerMaterialImported: false },
    summary: {
      yearsCovered: coverage.length,
      officialQuestionCount: records.length,
      writingACount: records.filter((record) => record.taskType.endsWith("-a")).length,
      writingBCount: records.filter((record) => record.taskType.endsWith("-b")).length,
      visualAssetCount: records.reduce((sum, record) => sum + record.assets.length, 0),
      unmappedCount: 0,
      missingCount: 0,
    },
    coverage,
    inventory,
  };
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await mkdir(auditRoot, { recursive: true });
  await writeFile(runtimePath, `// Generated by scripts/import-writing-question-bank.mjs. Do not edit by hand.\nexport const GENERATED_WRITING_QUESTIONS = ${JSON.stringify(records, null, 2)};\n`, "utf8");
  await writeFile(path.join(auditRoot, "writing-question-bank-audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  process.stdout.write(`Imported ${records.length} official writing questions across ${coverage.length} years (${audit.summary.visualAssetCount} source visuals).\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
