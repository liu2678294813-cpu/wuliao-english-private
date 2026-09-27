// Cloze (Section I · Use of English) parser.
//
// 考研英语一 Section I 是一篇约 240–280 词、带 20 个编号空的文章，后接 20 题
// 每题 A/B/C/D 四选项。本解析器从 PDF 文本层或 OCR 得到的 `pages` 文本中定位
// Section I、还原正文空位、解析选项，输出稳定的结构化数据。
//
// 设计原则：
//   1. 不复用阅读理解的 parseQuestionsFromText，完形有自己独立的版式。
//   2. 空位识别基于“严格递增 1→20 序列 + 整词匹配”，避免误把正文中的真实
//      数字（如 “20 million”“1830”“I.Q.”）或页码当作空位。
//   3. 容忍 OCR 噪声：`_ 4`、`__14`、`[ B]`、`[DD]`、跨行、`~~`、尾部 `|`、
//      页眉页脚混入、Section II 被 OCR 成 Section I 等。
//   4. 永不抛异常：缺失 Section I 返回 null；部分残缺返回带 warnings 的结果。

const CLOZE_SCHEMA_VERSION = 1;
const BLANK_COUNT = 20;

const SECTION_HEADER = /(^|\n)\s*Section\s+[Il1|]{1,3}\s+Use\s+of\s+English/i;
const SECTION_END = /Reading\s+Comprehension/i;
const POINTS_MARK = /\(?\s*10\s*points\s*\)?/i;
const QUESTION_START = /^(\d{1,2})\s*[.)]\s*(?=\[)/;
const OPTION_MARKER = /\[\s*([A-D])\s*\1?\s*\]/g;
const CJK_CHAR = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;
const FOOTER_NOISE = /^\S*[\u2014\u2013\-]\S*\s+\d{1,2}\s*[.)]\s*\(?[\w\s\d]*\)?\s*$/i;
const UNDERLINE_ONLY = /^_+$/;
const BLANK_TOKEN = /^_*(\d{1,2})_*$/;

function cleanClozeLine(value) {
  if (!value) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2014/g, "—")
    .replace(/\u2013/g, "-")
    .replace(/([A-Za-z.])-[ \t]*(?=[a-z])/g, "$1-")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// 只在“题号开头 + A-D 选项标记”这条窄语境中修复真实 OCR 变体。
// 不按年份/空号分支，也不对正文做全局字符替换，避免把正常的 |、I、数字 7
// 改成题目结构。
function normalizeOptionOcrLine(value) {
  let line = cleanClozeLine(value);
  if (!line) return "";

  // 页边竖线可能粘在题号前；逗号可能被识成题号句点。
  line = line.replace(/^\|\s*(?=\d{1,2}\s*[.,)])/, "");
  line = line.replace(/^(\d{1,2})\s*,\s*(?=(?:\[\s*\|?\s*[A-D]|\|\s*[A-D]))/i, "$1. ");

  // 首题的数字 1 偶尔被 OCR 成 I / l / Cl，仅在后面紧跟选项时修复。
  line = line.replace(/^(?:I|l|Cl)\s*[.)]\s*(?=(?:\[\s*\|?\s*[A-D]|\|\s*[A-D]))/i, "1. ");

  // 括号内部的竖线、重复字母和相邻噪声： [| C]、[C|]、[DD]、[CJ]。
  line = line.replace(/\[\s*\|?\s*([A-D])\s*(?:\1|[|J])?\s*\]/gi, "[$1]");
  // 左方括号漏识别： | B] / | | D]。
  line = line.replace(/(^|\s)\|\s*(?:\|\s*)?([A-D])\s*\]/gi, "$1[$2]");
  // 右方括号被识成 7：只在本行已经具备选项结构时接受 A7-D7。
  if (/\[[A-D]\]/i.test(line)) {
    line = line.replace(/(^|\s)([A-D])7(?=\s|$)/gi, "$1[$2]");
  }
  return cleanClozeLine(line);
}

function cleanOptionText(value) {
  return cleanClozeLine(value).replace(/^[|~]+\s*|\s*[|~]+$/g, "").trim();
}

function latinRatio(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const han = (text.match(/[\u2e80-\u9fff]/g) || []).length;
  return latin / Math.max(1, latin + han);
}

function looksLikePassage(text) {
  const words = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  return words.length >= 6 && text.length >= 30 && latinRatio(text) > 0.7;
}

function isPassageNoise(line) {
  const cleaned = cleanClozeLine(line);
  if (!cleaned) return true;
  if (CJK_CHAR.test(cleaned)) return true;
  if (/^(?:Section|Part|Directions)\b/i.test(cleaned)) return true;
  if (/^\d{1,3}\s*[.)]\s*$/.test(cleaned)) return true;
  if (FOOTER_NOISE.test(cleaned)) return true;
  return false;
}

function combinePages(pages) {
  if (!Array.isArray(pages)) return { text: "", ranges: [] };
  const text = pages.map((page) => String(page?.text ?? "")).join("\n\n");
  let offset = 0;
  const ranges = pages.map((page) => {
    const start = offset;
    const pageText = String(page?.text ?? "");
    offset += pageText.length + 2;
    return { pageNumber: page?.pageNumber ?? null, start, end: start + pageText.length };
  });
  return { text, ranges };
}

function pageNumbersFor(ranges, start, end) {
  return ranges
    .filter((range) => range.end >= start && range.start <= end)
    .map((range) => range.pageNumber)
    .filter((value) => value != null);
}

function locateSection(text) {
  const header = SECTION_HEADER.exec(text);
  if (!header) return null;
  let start = header.index + (header[1] ? header[1].length : 0);
  const lineStart = text.lastIndexOf("\n", start - 1);
  start = lineStart >= 0 ? lineStart + 1 : start;

  const after = text.slice(start);
  const endMatch = SECTION_END.exec(after);
  const end = endMatch ? start + endMatch.index : text.length;

  return { start, end };
}

function stripDirections(sectionText) {
  const directions = /Directions\s*:?/i.exec(sectionText);
  if (!directions) {
    const headerEnd = /Use\s+of\s+English/i.exec(sectionText);
    if (headerEnd) {
      const after = sectionText.slice(headerEnd.index + headerEnd[0].length);
      const points = POINTS_MARK.exec(after);
      return points ? after.slice(points.index + points[0].length) : after;
    }
    return sectionText;
  }
  const afterDirections = sectionText.slice(directions.index);
  const points = POINTS_MARK.exec(afterDirections);
  return points ? afterDirections.slice(points.index + points[0].length) : afterDirections;
}

function splitOptionsBoundary(passageAndOptions) {
  const lines = passageAndOptions.split(/\r?\n/);
  let optionsStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const normalizedLine = normalizeOptionOcrLine(lines[index]);
    if (QUESTION_START.test(normalizedLine) && /\[A\]/i.test(normalizedLine)) {
      optionsStart = index;
      break;
    }
  }
  if (optionsStart < 0) return { passageText: passageAndOptions, optionsText: "" };
  return {
    passageText: lines.slice(0, optionsStart).join("\n"),
    optionsText: lines.slice(optionsStart).join("\n"),
  };
}

function joinParagraph(block) {
  const lines = block.split(/\r?\n/).map(cleanClozeLine).filter((line) => line && !isPassageNoise(line));
  return cleanClozeLine(lines.join(" "));
}

function buildSegments(paragraphText, expectedStart) {
  const tokens = paragraphText.split(/\s+/).filter((token) => token.length > 0);
  const segments = [];
  let textBuffer = "";
  let expected = expectedStart;
  let nextMissed = null;

  const flushText = () => {
    if (textBuffer.trim()) segments.push({ type: "text", text: textBuffer.trim() });
    textBuffer = "";
  };

  for (const token of tokens) {
    if (UNDERLINE_ONLY.test(token)) continue;
    const blankMatch = token.match(BLANK_TOKEN);
    if (blankMatch) {
      const digits = blankMatch[1];
      const number = Number(digits);
      const hasUnderscores = /^_|_$/.test(token);
      if (number === expected) {
        flushText();
        segments.push({ type: "blank", number });
        expected += 1;
        continue;
      }
      // OCR 把 "__7__" 识成 "__71__" 之类：下划线包裹时允许尾部噪声数字。
      if (hasUnderscores && digits.length > String(expected).length && digits.startsWith(String(expected))) {
        flushText();
        segments.push({ type: "blank", number: expected });
        expected += 1;
        continue;
      }
      // 如果遇到比期望更大的编号（期望的空被 OCR 漏掉），先插入受限数量的
      // 占位空，再继续消费当前编号；不能丢掉这个已识别编号，否则后续会整体错位。
      if (number > expected && number <= expected + 3 && number <= BLANK_COUNT) {
        flushText();
        while (expected < number) {
          segments.push({ type: "blank", number: expected, missing: true });
          nextMissed = nextMissed || expected;
          expected += 1;
        }
        segments.push({ type: "blank", number });
        expected = number + 1;
        continue;
      }
    }
    textBuffer = textBuffer ? `${textBuffer} ${token}` : token;
  }
  flushText();
  return { segments, nextExpected: expected, missedAt: nextMissed };
}

function parsePassage(passageText) {
  const blocks = passageText.split(/\n\s*\n+/).map((block) => block).filter(Boolean);
  const paragraphs = [];
  let expected = 1;
  let missedAt = null;

  for (let index = 0; index < blocks.length; index += 1) {
    let block = blocks[index];
    // 若上一段还未出现空、当前块头噪声行干扰，则与上一段拼接重试
    const joined = joinParagraph(block);
    if (!looksLikePassage(joined)) {
      if (paragraphs.length && expected < BLANK_COUNT) {
        const previous = paragraphs[paragraphs.length - 1];
        previous.text = cleanClozeLine(`${previous.text} ${joined}`);
      }
      continue;
    }
    const { segments, nextExpected, missedAt: blockMissed } = buildSegments(joined, expected);
    if (segments.length) {
      paragraphs.push({ number: paragraphs.length + 1, text: joined, segments });
      expected = nextExpected;
      if (blockMissed && !missedAt) missedAt = expected - 1;
    }
  }

  return { paragraphs, nextExpected: expected, missedAt };
}

function parseOptions(optionsText) {
  const lines = optionsText.split(/\r?\n/).map(normalizeOptionOcrLine).filter(Boolean);
  const blanks = [];
  let current = null;
  let currentKey = null;

  const finalize = () => {
    if (current) blanks.push(current);
    current = null;
    currentKey = null;
  };

  for (const line of lines) {
    if (CJK_CHAR.test(line) || isPassageNoise(line)) continue;
    const startMatch = line.match(QUESTION_START);
    if (startMatch) {
      finalize();
      current = { number: Number(startMatch[1]), options: {} };
    }
    if (!current) continue;

    let lastIndex = 0;
    let match;
    const cleanedLine = line.replace(/[~|]+\s*$/g, "").replace(/\s{2,}/g, " ").trim();
    OPTION_MARKER.lastIndex = 0;
    while ((match = OPTION_MARKER.exec(cleanedLine)) !== null) {
      const key = match[1].toUpperCase();
      const text = cleanOptionText(cleanedLine.slice(lastIndex, match.index));
      if (currentKey && text) current.options[currentKey] = text;
      currentKey = key;
      lastIndex = match.index + match[0].length;
    }
    if (currentKey) {
      const tail = cleanOptionText(cleanedLine.slice(lastIndex));
      if (tail) current.options[currentKey] = `${current.options[currentKey] || ""} ${tail}`.trim();
    }
    // 行内残留非选项文本（未被任何 marker 包夹）忽略
    lastIndex = 0;
  }
  finalize();

  const result = [];
  for (let number = 1; number <= BLANK_COUNT; number += 1) {
    const found = blanks.find((blank) => blank.number === number);
    const options = ["A", "B", "C", "D"].map((key) => ({
      key,
      text: cleanOptionText(found?.options?.[key] || ""),
    }));
    result.push({
      id: `blank-${number}`,
      number,
      options,
      complete: options.every((option) => option.text.length > 0),
    });
  }
  return result;
}

export function parseClozeSection(rawSectionText, sourceLabel = "cloze") {
  const warnings = [];
  if (!rawSectionText || !rawSectionText.trim()) return null;

  // 若输入含 Reading Comprehension（调用方未预先截断），在此截断到完形段。
  let sectionText = rawSectionText;
  const endMatch = SECTION_END.exec(sectionText);
  if (endMatch) sectionText = sectionText.slice(0, endMatch.index);

  const passageAndOptions = stripDirections(sectionText);
  const { passageText, optionsText } = splitOptionsBoundary(passageAndOptions);

  const { paragraphs, nextExpected, missedAt } = parsePassage(passageText);
  if (missedAt) warnings.push(`正文空位 ${missedAt} 可能被 OCR 漏掉，已插入占位空`);
  if (nextExpected <= BLANK_COUNT) warnings.push(`正文仅识别到 ${nextExpected - 1} 个空位（期望 ${BLANK_COUNT}）`);

  const blanks = parseOptions(optionsText);
  const completeCount = blanks.filter((blank) => blank.complete).length;
  if (completeCount < BLANK_COUNT) {
    warnings.push(`选项完整题数 ${completeCount}/${BLANK_COUNT}`);
  }

  const detectedBlanks = paragraphs
    .flatMap((paragraph) => paragraph.segments)
    .filter((segment) => segment.type === "blank").length;

  return {
    schemaVersion: CLOZE_SCHEMA_VERSION,
    type: "cloze",
    label: "Section I · Use of English",
    sourceLabel,
    paragraphs,
    blanks,
    detectedBlanks,
    warnings,
  };
}

export function buildClozeFromPages(pages, documentTitle = "") {
  if (!Array.isArray(pages) || !pages.length) return null;
  const { text, ranges } = combinePages(pages);
  const located = locateSection(text);
  if (!located) return null;

  const sectionText = text.slice(located.start, located.end);
  const sourcePages = pageNumbersFor(ranges, located.start, located.end);
  const cloze = parseClozeSection(sectionText, documentTitle);
  if (!cloze) return null;
  cloze.sourcePages = sourcePages;
  return cloze;
}

export function buildClozeAnalysis(pages, documentTitle = "") {
  const cloze = buildClozeFromPages(pages, documentTitle);
  return cloze ? [cloze] : [];
}

export function normalizeCloze(cloze) {
  if (!cloze || typeof cloze !== "object") return null;
  const paragraphs = Array.isArray(cloze.paragraphs)
    ? cloze.paragraphs.map((paragraph, index) => ({
      number: Number(paragraph?.number) || index + 1,
      text: String(paragraph?.text ?? ""),
      segments: Array.isArray(paragraph?.segments)
        ? paragraph.segments.map((segment) => ({
          type: segment?.type === "blank" ? "blank" : "text",
          number: segment.type === "blank" ? Number(segment.number) || 0 : undefined,
          text: segment.type === "text" ? String(segment.text ?? "") : undefined,
          missing: segment?.missing ? true : undefined,
        })).filter((segment) => segment.type === "text" ? segment.text : true)
        : [],
    }))
    : [];

  const blanks = Array.from({ length: BLANK_COUNT }, (_, index) => {
    const number = index + 1;
    const existing = (Array.isArray(cloze.blanks) ? cloze.blanks : []).find(
      (blank) => Number(blank?.number) === number,
    );
    const options = ["A", "B", "C", "D"].map((key) => {
      const option = (existing?.options || []).find((entry) => entry?.key === key);
      return { key, text: option ? String(option.text ?? "") : "" };
    });
    return { id: `blank-${number}`, number, options, complete: options.every((opt) => opt.text) };
  });

  return {
    schemaVersion: CLOZE_SCHEMA_VERSION,
    type: "cloze",
    label: cloze.label || "Section I · Use of English",
    sourceLabel: cloze.sourceLabel || "",
    sourcePages: Array.isArray(cloze.sourcePages) ? cloze.sourcePages : [],
    paragraphs,
    blanks,
    detectedBlanks: Number(cloze.detectedBlanks) || 0,
    warnings: Array.isArray(cloze.warnings) ? cloze.warnings : [],
  };
}
