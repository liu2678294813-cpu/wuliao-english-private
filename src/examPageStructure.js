const ANSWER_KEY_HEADING = /(?:^|\n)\s*(?:参考答案|答案速查|答案解析|answer\s+key|answers?\s+and\s+explanations?)\s*[:：]?\s*(?:\n|$)/i;
const TEXT_MARKER = /(?:^|\n)\s*(?:Text|Passage)\s*([1-8])\b/gi;
const PART_A_END_HEADING = /(?:^|\n)\s*(?:Part\s+[BC]\b|Section\s+III\b|Writing\b)/i;

function normalizedText(page) {
  return String(page?.text || "").replace(/\r/g, "").trim();
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function pageLabels(text) {
  return [...text.matchAll(TEXT_MARKER)].map((match) => String(match[1]));
}

export function classifyExamPage(page) {
  const text = normalizedText(page);
  const labels = pageLabels(text);
  const words = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  const numberedItems = countMatches(text, /(?:^|\n)\s*\d{1,2}[.)]\s+/gm);
  const optionItems = countMatches(text, /(?:^|\n)\s*(?:\[?([A-D])\]?|([A-D])[.)])\s+/gm);
  const answerPairs = countMatches(text, /\b\d{1,2}\s*[.、:：-]?\s*[A-D]\b/g);

  if (ANSWER_KEY_HEADING.test(text) || (answerPairs >= 10 && words.length < 180)) {
    return { pageNumber: page.pageNumber, type: "answer-key", confidence: 0.98, labels };
  }
  if (PART_A_END_HEADING.test(text)) {
    return { pageNumber: page.pageNumber, type: "part-a-end", confidence: 0.96, labels };
  }
  if (/\b(?:Section\s+I|Use\s+of\s+English)\b/i.test(text) && (numberedItems >= 3 || optionItems >= 8)) {
    return { pageNumber: page.pageNumber, type: "cloze", confidence: 0.92, labels };
  }
  if (numberedItems >= 2 && optionItems >= 4) {
    return { pageNumber: page.pageNumber, type: "questions", confidence: 0.9, labels };
  }
  if (labels.length || words.length >= 80) {
    return { pageNumber: page.pageNumber, type: "passage", confidence: labels.length ? 0.92 : 0.72, labels };
  }
  if (/\bDirections?\b|\bRead\s+the\s+following\b|\bMark\s+your\s+answers\b/i.test(text)) {
    return { pageNumber: page.pageNumber, type: "instructions", confidence: 0.82, labels };
  }
  if (text.length >= 30) {
    return { pageNumber: page.pageNumber, type: "cover", confidence: 0.58, labels };
  }
  return { pageNumber: page.pageNumber, type: "noise", confidence: 0.9, labels };
}

export function buildExamPageStructure(pages = []) {
  const records = pages.map(classifyExamPage);
  const answerIndex = records.findIndex((record) => record.type === "answer-key");
  const beforeAnswerKey = answerIndex < 0 ? pages : pages.slice(0, answerIndex);
  const contentPages = partAContentPages(beforeAnswerKey);
  const partAEndRecord = records.find((record, index) => record.type === "part-a-end" && (answerIndex < 0 || index < answerIndex));
  return {
    records,
    contentPages,
    partABoundary: partAEndRecord ? { pageNumber: partAEndRecord.pageNumber } : null,
    answerKeyBoundary: answerIndex < 0 ? null : { pageNumber: records[answerIndex].pageNumber },
  };
}

function partAContentPages(pages = []) {
  const contentPages = [];
  for (const page of pages) {
    const text = normalizedText(page);
    const boundary = PART_A_END_HEADING.exec(text);
    if (!boundary) {
      contentPages.push(page);
      continue;
    }
    const prefix = text.slice(0, boundary.index).trim();
    if (prefix) contentPages.push({ ...page, text: prefix });
    break;
  }
  return contentPages;
}

export function assembleReadingPageGroups(pages = []) {
  const groups = [];
  let current = null;
  for (const page of partAContentPages(pages)) {
    const labels = pageLabels(normalizedText(page));
    if (labels.length) {
      if (current) groups.push(current);
      current = { label: labels[0], pages: [page] };
    } else if (current) {
      current.pages.push(page);
    }
  }
  if (current) groups.push(current);
  return groups.map((group) => ({
    ...group,
    sourcePages: group.pages.map((page) => page.pageNumber),
    text: group.pages.map((page) => page.text).join("\n\n"),
  }));
}
