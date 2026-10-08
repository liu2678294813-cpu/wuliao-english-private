import { importRepository } from "../import/repository.js";
import { writingReady, validateContent } from "../import/contracts.js";
import { computeWritingFingerprint } from "./writingRepository.js";
import { listWritingQuestions } from "./writingQuestionBank.js";

export async function startImportedWriting(material, services) {
  if (!writingReady(material.content)) throw new Error("请先补齐作文题目、范文和 A/B 题型");
  const current = await importRepository.get("writing-materials", material.id);
  if (!current || current.materialRevision !== material.materialRevision) throw new Error("作文已更新，请重新打开");
  const c = current.content; const a = c.taskType === "postgrad-en1-writing-a";
  let prompt = { questionId: current.id, promptText: c.promptText, directions: c.directions || c.promptText, promptKind: null, sourceType: "manual_import", taskType: c.taskType, year: c.year ?? null, maxScore: a ? 10 : 20, assets: c.assets || [], targetWordRange: a ? { min: 100, max: 120 } : { min: 160, max: 200 } };
  // Only exact identity can associate with the official bank. Custom identity remains independent.
  const exact = listWritingQuestions().find((q) => q.year === c.year && q.taskType === c.taskType && q.promptText === c.promptText && q.directions === c.directions && q.fingerprint === c.officialPromptFingerprint);
  if (exact) prompt.officialQuestionId = exact.questionId;
  prompt = { ...prompt, fingerprint: await computeWritingFingerprint(prompt) };
  const paragraphs = c.referenceEssay.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
  let sample = { essayId: `${current.id}:sample:${current.materialRevision}`, sourceType: c.sampleSource === "ai_generated" ? "ai_generated" : "manual_import", text: c.referenceEssay, wordCount: (c.referenceEssay.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length, segments: paragraphs.map((text, i) => ({ unitId: `${current.id}:sample:p:${i + 1}`, text })), qualityStatus: "passed", qualityGateVersion: "unified-import-local-v1", qualityReportFingerprint: await computeWritingFingerprint({ validation: validateContent("writing", c), materialRevision: current.materialRevision, contentFingerprint: current.contentFingerprint }), generatorMetadata: c.sampleSource === "ai_generated" ? c.generatorMetadata : null, sourceDocumentFingerprint: current.fingerprint };
  sample = { ...sample, fingerprint: await computeWritingFingerprint(sample) };
  return services.commands.startWritingSession({ sessionId: `writing-session:${crypto.randomUUID()}`, taskType: c.taskType, year: c.year ?? null, promptSnapshot: prompt, sampleEssaySnapshot: sample });
}
