import { WritingInputMethod } from "./writingModels.js";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function sampleEssayDocument(sampleEssaySnapshot = {}) {
  const fullText = text(sampleEssaySnapshot.text);
  if (fullText) return fullText;
  return (sampleEssaySnapshot.segments || []).map((segment) => text(segment?.text)).filter(Boolean).join("\n\n");
}

export function translationDocument(units = []) {
  return (Array.isArray(units) ? units : [])
    .map((unit) => text(unit?.typedText))
    .filter(Boolean)
    .join("\n\n");
}

export function wholeDocumentTranslationUnit({
  sampleSegments = [],
  typedText = "",
  inputMethod = WritingInputMethod.TYPED,
  inkRef = null,
} = {}) {
  const unitId = text(sampleSegments[0]?.unitId);
  if (!unitId) throw new TypeError("A SampleEssay segment is required for Translation lineage");
  return { unitId, inputMethod, typedText: String(typedText || ""), inkRef };
}

export function paragraphList(value) {
  const source = text(value);
  if (!source) return [];
  return source.split(/\n\s*\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
}
