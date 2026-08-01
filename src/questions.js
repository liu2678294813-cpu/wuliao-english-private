import { parseQuestionsFromText } from "./deepReadingParser";

export async function extractQuestions(pdfDocument) {
  const byKey = new Map();
  let textCharacters = 0;

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      pageText += item.str;
      pageText += item.hasEOL ? "\n" : " ";
    }
    textCharacters += pageText.replace(/\s/g, "").length;
    for (const question of parseQuestionsFromText(pageText)) {
      const key = `${question.number}:${question.stem}`;
      if (!byKey.has(key)) byKey.set(key, question);
    }
    if (byKey.size >= 5) break;
  }

  return {
    questions: [...byKey.values()],
    textCharacters,
  };
}
