const optionPattern = /^(?:\[\s*([A-D])\s*\]|\(\s*([A-D])\s*\)|([A-D])[.)])\s*(.*)$/i;
const numberedQuestionPattern = /^(\d{1,3})\s*[.)]\s*(?=[A-Z"'])(.{5,})$/;
import { assembleReadingPageGroups } from "./examPageStructure.js";

const textMarkerPattern = /^\s*(?:Text|Passage)\s*([A-Za-z0-9]+)\s*$/gim;

function cleanLine(value) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\bn{5,}\b/gi, " ")
    .replace(/^\|\s*/, "")
    .replace(/([—–-])I(?=[a-z])/g, "$1")
    .replace(/([A-Za-z.]+)-\s+(?=[a-z])/g, "$1-")
    .replace(/([.!?])\s+[il|]$/, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoise(line) {
  return (
    !line ||
    /^I+$/.test(line) ||
    /^\d+$/.test(line) ||
    /ENGLISH\s*\(I\)/i.test(line) ||
    /精读全流程|共\s*\d+\s*页|4550060/i.test(line) ||
    /iXA\s*\.\d+\.\s*\([^)]*\d+\)/i.test(line) ||
    /(?:XME|EXA).{0,20}\d+\s*[RP]?\)?$/i.test(line)
  );
}

function isQuestionBlockBoundary(line) {
  return /^(?:\d+\.\d+\s|S\d+\b|第\s*\d+\s*段|本段英语原文|全文核对|再次独立作答|现在(?:开始|才看))/i.test(line);
}

function questionKey(question) {
  return `${question.number || "x"}:${question.stem.toLowerCase().replace(/\W/g, "").slice(0, 80)}`;
}

function finalizeQuestion(question, output) {
  if (!question) return;
  const options = ["A", "B", "C", "D"]
    .filter((key) => question.options[key])
    .map((key) => ({ key, text: cleanLine(question.options[key]) }));
  if (cleanLine(question.stem).length > 5 && options.length >= 3) {
    output.push({
      number: question.number || String(output.length + 1),
      stem: cleanLine(question.stem),
      options,
    });
  }
}

export function parseQuestionsFromText(rawText) {
  const output = [];
  const lines = rawText.split(/\r?\n/).map(cleanLine);
  let current = null;
  let activeOption = null;
  let pending = [];

  for (const line of lines) {
    if (isNoise(line)) continue;

    const optionMatch = line.match(optionPattern);
    if (optionMatch) {
      const key = (optionMatch[1] || optionMatch[2] || optionMatch[3]).toUpperCase();
      if (!current && key === "A" && pending.length) {
        current = { number: "", stem: pending.slice(-3).join(" "), options: {} };
      }
      if (current) {
        activeOption = key;
        current.options[key] = optionMatch[4];
      }
      pending = [];
      continue;
    }

    const questionMatch = line.match(numberedQuestionPattern);
    if (questionMatch) {
      finalizeQuestion(current, output);
      current = { number: questionMatch[1], stem: questionMatch[2], options: {} };
      activeOption = null;
      pending = [];
      continue;
    }

    if (current && activeOption === "D" && isQuestionBlockBoundary(line)) {
      finalizeQuestion(current, output);
      current = null;
      activeOption = null;
      pending = [];
      continue;
    }

    if (current) {
      if (activeOption) {
        const currentOption = cleanLine(current.options[activeOption] || "");
        const canContinue = activeOption !== "D"
          || (!/[.!?]["']?$/.test(currentOption) && /^[a-z('"-]/.test(line));
        if (canContinue) {
          current.options[activeOption] = `${current.options[activeOption]} ${line}`;
        }
      } else {
        current.stem = `${current.stem} ${line}`;
      }
    } else if (line.length > 5) {
      pending.push(line);
      if (pending.length > 4) pending.shift();
    }
  }
  finalizeQuestion(current, output);

  const unique = new Map();
  for (const question of output) {
    const key = questionKey(question);
    if (!unique.has(key)) unique.set(key, question);
  }
  return [...unique.values()];
}

function latinRatio(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return latin / Math.max(1, latin + han);
}

function looksLikeArticle(text) {
  const words = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  return words.length >= 6 && text.length >= 35 && latinRatio(text) > 0.82;
}

function isArticleNoise(line) {
  return (
    isNoise(line) ||
    /^(?:Text|Passage)\s*[A-Za-z0-9]+$/i.test(line) ||
    /^(?:Section|Part)\s+[A-Z0-9]+/i.test(line) ||
    /^(?:Directions?|Questions?|READING DEEP-DIVE WORKBOOK)\s*:?$/i.test(line) ||
    /^Read the following/i.test(line) ||
    /^Mark your answers/i.test(line)
  );
}

export function splitArticleParagraphs(rawText) {
  let text = rawText.replace(/\r/g, "");
  const firstQuestion = text.split("\n").findIndex((line) => numberedQuestionPattern.test(cleanLine(line)));
  if (firstQuestion >= 0) text = text.split("\n").slice(0, firstQuestion).join("\n");
  text = text
    .replace(/^\s*(?:Text|Passage)\s*[A-Za-z0-9]+\s*$/gim, "")
    .replace(/\[P\s*(\d+)\]/gi, "\n\n[P$1] ");

  let blocks = text.split(/\n\s*\n+/);
  if (blocks.length === 1) {
    const lines = text.split("\n");
    blocks = [];
    let current = [];
    for (const line of lines) {
      const cleaned = cleanLine(line);
      if (!cleaned) {
        if (current.length) blocks.push(current.join(" "));
        current = [];
      } else {
        current.push(cleaned);
      }
    }
    if (current.length) blocks.push(current.join(" "));
  }

  const paragraphs = [];
  for (const block of blocks) {
    const cleanedLines = block
      .split("\n")
      .map(cleanLine)
      .filter((line) => !isArticleNoise(line));
    const paragraph = cleanLine(cleanedLines.join(" ")).replace(/^\[P\d+\]\s*/i, "");
    if (looksLikeArticle(paragraph)) {
      const previous = paragraphs.at(-1);
      if (previous && !/[.!?]["']?$/.test(previous)) {
        paragraphs[paragraphs.length - 1] = `${previous} ${paragraph}`;
      } else {
        paragraphs.push(paragraph);
      }
    }
  }
  return paragraphs;
}

export function splitSentences(paragraph) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    const sentences = [...segmenter.segment(paragraph)]
      .map((item) => cleanLine(item.segment))
      .filter((sentence) => (sentence.match(/[A-Za-z]+/g) || []).length >= 1);
    if (sentences.length) return sentences;
  }
  return paragraph
    .split(/(?<=[.!?]["']?)\s+(?=[A-Z"'])/)
    .map(cleanLine)
    .filter(Boolean);
}

function mergeQuestions(target, questions) {
  const existing = new Set(target.map(questionKey));
  for (const question of questions) {
    const key = questionKey(question);
    if (!existing.has(key)) {
      target.push(question);
      existing.add(key);
    }
  }
}

function makePassage(label, paragraphs, questions, index, sourcePages = []) {
  return {
    id: `passage-${String(label || index + 1).toLowerCase()}`,
    label: label ? `Text ${label}` : `精读文章 ${index + 1}`,
    paragraphs: paragraphs.map((text, paragraphIndex) => ({
      number: paragraphIndex + 1,
      text,
      sentences: splitSentences(text),
    })),
    questions: questions.map((question, questionIndex) => ({
      ...question,
      id: `q-${index + 1}-${question.number || questionIndex + 1}-${questionIndex}`,
    })),
    sourcePages,
  };
}

function isSentenceWorksheet(paragraphs) {
  if (!paragraphs.length) return false;
  const sentenceRows = paragraphs.filter((paragraph) => {
    const text = typeof paragraph === "string" ? paragraph : paragraph.text;
    return /^S\s*\d+\b/i.test(text);
  }).length;
  return sentenceRows / paragraphs.length >= 0.35;
}

function normalizedArticle(passage) {
  return passage.paragraphs
    .map((paragraph) => paragraph.text)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function normalizePassages(passages) {
  const unique = [];
  for (const passage of passages) {
    if (isSentenceWorksheet(passage.paragraphs)) continue;
    const article = normalizedArticle(passage);
    const duplicateIndex = unique.findIndex((existing) => {
      const previous = normalizedArticle(existing);
      const shorter = previous.length <= article.length ? previous : article;
      const longer = previous.length > article.length ? previous : article;
      return shorter.length >= 300 && longer.includes(shorter) && shorter.length / longer.length >= 0.82;
    });

    if (duplicateIndex < 0) {
      unique.push(passage);
    } else if (passage.questions.length > unique[duplicateIndex].questions.length) {
      unique[duplicateIndex] = passage;
    }
  }
  return unique;
}

function fallbackPassages(pages) {
  const readingStart = Math.max(0, pages.findIndex((page) => /Reading\s+Comprehension|following\s+(?:four\s+)?texts/i.test(page.text)));
  const candidates = [];
  for (let index = readingStart; index < pages.length; index += 1) {
    const paragraphs = splitArticleParagraphs(pages[index].text);
    const length = paragraphs.join(" ").length;
    if (length >= 700 && !/Use of English|numbered blank/i.test(pages[index].text)) {
      candidates.push({ index, paragraphs });
    }
  }

  if (candidates.length) {
    return candidates.slice(0, 8).map((candidate, candidateIndex) => {
      const nextIndex = candidates[candidateIndex + 1]?.index ?? pages.length;
      const questionText = pages.slice(candidate.index, nextIndex).map((page) => page.text).join("\n\n");
      return makePassage(String(candidateIndex + 1), candidate.paragraphs, parseQuestionsFromText(questionText), candidateIndex);
    });
  }

  const best = pages
    .map((page, index) => ({ index, paragraphs: splitArticleParagraphs(page.text) }))
    .sort((a, b) => b.paragraphs.join(" ").length - a.paragraphs.join(" ").length)[0];
  if (!best || best.paragraphs.join(" ").length < 300) return [];
  const questions = parseQuestionsFromText(pages.map((page) => page.text).join("\n\n"));
  return [makePassage("", best.paragraphs, questions, 0)];
}

export function buildDeepReading(pages, documentTitle) {
  const combined = pages.map((page) => page.text).join("\n\n");
  const matches = [...combined.matchAll(textMarkerPattern)];
  const groups = new Map();

  assembleReadingPageGroups(pages).forEach((pageGroup, index) => {
    const paragraphs = splitArticleParagraphs(pageGroup.text);
    const questions = parseQuestionsFromText(pageGroup.text);
    groups.set(pageGroup.label.toLowerCase(), {
      label: pageGroup.label,
      paragraphs,
      questions,
      score: paragraphs.join(" ").length,
      order: index,
      sourcePages: pageGroup.sourcePages,
    });
  });

  matches.forEach((match, index) => {
    const label = match[1];
    const segmentEnd = matches[index + 1]?.index ?? combined.length;
    let segment = combined.slice(match.index, segmentEnd);
    segment = segment.split(/^\s*Part\s+B\b/im)[0];
    const paragraphs = splitArticleParagraphs(segment);
    const questions = parseQuestionsFromText(segment);
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { label, paragraphs: [], questions: [], score: 0, order: index, sourcePages: [] });
    const group = groups.get(key);
    const score = paragraphs.join(" ").length;
    if (score > group.score) {
      group.paragraphs = paragraphs;
      group.score = score;
    }
    mergeQuestions(group.questions, questions);
  });

  let passages = [...groups.values()]
    .filter((group) => group.score >= 300 && !isSentenceWorksheet(group.paragraphs))
    .sort((a, b) => a.order - b.order)
    .slice(0, 8)
    .map((group, index) => makePassage(group.label, group.paragraphs, group.questions, index, group.sourcePages));

  passages = normalizePassages(passages);

  if (!passages.length) passages = fallbackPassages(pages);

  return {
    version: 1,
    title: documentTitle,
    createdAt: Date.now(),
    passages,
    totals: {
      pages: pages.length,
      passages: passages.length,
      paragraphs: passages.reduce((sum, passage) => sum + passage.paragraphs.length, 0),
      sentences: passages.reduce((sum, passage) => sum + passage.paragraphs.reduce((count, paragraph) => count + paragraph.sentences.length, 0), 0),
      questions: passages.reduce((sum, passage) => sum + passage.questions.length, 0),
    },
  };
}
