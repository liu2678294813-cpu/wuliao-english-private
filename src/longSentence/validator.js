import { sentenceTextFingerprint } from "../translationProgress.js";

// Training contracts deliberately contain no original-learning write paths.
export class LongSentenceValidationError extends Error {
  constructor(code, message) { super(message); this.name = "LongSentenceValidationError"; this.code = code; }
}
const fail = (code, message = code) => { throw new LongSentenceValidationError(code, message); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const string = value => typeof value === "string" && value.trim().length > 0;
const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const arrayOfStrings = value => Array.isArray(value) && value.every(string);
function exactKeys(value, keys, code) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) fail(code);
}
export function validateCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > 5) fail("invalid_count", "生成数量必须为 1–5 的整数");
  return count;
}
export function parseLongSentenceJson(raw) {
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { const value = JSON.parse(text); if (!object(value)) fail("invalid_json"); return value; }
  catch { fail("invalid_json", "AI 返回的 JSON 无效"); }
}
export function sourceId(source) { return String(source?.sourceReviewId || source?.sourceRef?.sourceId || source?.sourceRef || source?.id || ""); }
export function normalizeSources(sources) {
  if (!Array.isArray(sources) || !sources.length) fail("missing_sources", "请选择待掌握原句");
  const result = sources.map(source => ({ sourceReviewId: sourceId(source), text: String(source.text || source.sentence || "").trim(), ...(Number.isFinite(source.difficulty) ? { difficulty: source.difficulty } : {}) }));
  if (result.some(source => !source.sourceReviewId || !source.text) || new Set(result.map(source => source.sourceReviewId)).size !== result.length) fail("invalid_sources");
  return result;
}
export function normalizeWords(words = []) {
  if (!Array.isArray(words)) fail("invalid_words");
  return words.map(word => typeof word === "string" ? { wordId: word.toLowerCase(), word } : { wordId: String(word.wordId || word.id || word.word || ""), word: String(word.word || word.text || "").trim() }).filter(word => word.wordId && word.word);
}
// A deterministic near-copy gate: substantial retained word order, even with
// a few synonyms substituted, is not a new transfer exercise.
export function isNearCopy(left, right) {
  const a = normalize(left).split(" "), b = normalize(right).split(" ");
  if (normalize(left) === normalize(right)) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  const row = new Uint16Array(b.length + 1);
  for (let i = 0; i < a.length; i++) { let diagonal = 0; for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = a[i] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]); diagonal = old; } }
  return row[b.length] / Math.min(a.length, b.length) >= 0.78;
}
function hasSurface(text, surface) { return (` ${normalize(text)} `).includes(` ${normalize(surface)} `); }
export function validateGeneratedItem(item, { sources, words = [], excludedSentences = [], excludedFingerprints = [], skill = null }) {
  exactKeys(item, ["text", "sourceReviewIds", "targetWordUses", "structureFingerprint", "difficultyPolicy", "difficultyMetadata"], "invalid_item_schema");
  if (!string(item.text) || item.text.length > 2400 || !/[a-zA-Z]/.test(item.text) || /[\u3400-\u9fff]/u.test(item.text)) fail("invalid_english");
  if (/[\n\r]|\b(?:subject|predicate|main clause|reference translation|answer|S|V|O\/C)\s*[:=]|\[(?:S|V|O|C)\]|<\/?(?:subject|predicate|answer)>/i.test(item.text)) fail("answer_leak");
  const sourceMap = new Map(sources.map(source => [source.sourceReviewId, source]));
  if (!Array.isArray(item.sourceReviewIds) || !item.sourceReviewIds.length || item.sourceReviewIds.some(id => !sourceMap.has(id)) || new Set(item.sourceReviewIds).size !== item.sourceReviewIds.length) fail("invalid_source_refs");
  if (!string(item.structureFingerprint) || item.structureFingerprint.length > 500) fail("invalid_fingerprint");
  if (excludedFingerprints.includes(sentenceTextFingerprint(item.text))) fail("previous_training_sentence");
  const expectedFingerprint = skill && String(skill.structureFingerprint || skill);
  if (expectedFingerprint && item.structureFingerprint !== expectedFingerprint) fail("skill_mismatch");
  if ([...sources.map(source => source.text), ...excludedSentences].some(text => isNearCopy(item.text, text))) fail("copied_sentence");
  if (!Array.isArray(item.targetWordUses) || item.targetWordUses.length > 3) fail("invalid_word_usage");
  const wordMap = new Map(words.map(word => [word.wordId, word]));
  const used = new Set();
  for (const use of item.targetWordUses) {
    exactKeys(use, ["wordId", "word", "surfaceForm"], "invalid_word_usage");
    const selected = wordMap.get(use.wordId);
    if (!selected || normalize(selected.word) !== normalize(use.word) || !string(use.surfaceForm) || !hasSurface(item.text, use.surfaceForm) || used.has(use.wordId)) fail("invalid_word_usage");
    // Permit usual inflections, but not arbitrary words claimed as occurrences.
    const lemma = normalize(use.word), surface = normalize(use.surfaceForm);
    const stems = [lemma, `${lemma}s`, `${lemma}es`, `${lemma}ed`, `${lemma}d`, `${lemma}ing`, `${lemma.replace(/e$/, "")}ing`, `${lemma.replace(/y$/, "i")}ed`, `${lemma.replace(/y$/, "ie")}s`];
    if (/[aeiou][bcdfghjklmnpqrstvz]$/.test(lemma)) stems.push(`${lemma}${lemma.at(-1)}ed`, `${lemma}${lemma.at(-1)}ing`);
    if (!stems.includes(surface)) fail("invalid_word_usage");
    used.add(use.wordId);
  }
  // Declaring zero uses cannot conceal more than three selected words.
  if (words.filter(word => hasSurface(item.text, word.word)).length > 3) fail("too_many_target_words");
  if (item.difficultyPolicy !== "above_source") fail("invalid_difficulty_policy");
  const d = item.difficultyMetadata;
  exactKeys(d, ["sourceDifficulties", "sourceDifficulty", "targetDifficulty", "difficultyDelta", "addedComplexityFeatures"], "invalid_difficulty");
  // The final freeze benchmarks every selected source, even if this item's
  // actual structural lineage references only a subset of those sources.
  if (!Array.isArray(d.sourceDifficulties) || d.sourceDifficulties.length !== sourceMap.size || !arrayOfStrings(d.addedComplexityFeatures) || !d.addedComplexityFeatures.length) fail("invalid_difficulty");
  const structuralFeature = /claus|nest|embed|subordin|logic|non.?finite|particip|infinitiv|relative|apposit|parenthe|modifi|referen|anaphor|negat|concess|condition|contrast|dependenc|invers|causal|counterfact|ellipsis|(?:subject|noun).{0,20}(?:distance|separat)|backbone|从句|嵌套|嵌入|逻辑|非谓语|分词|不定式|定语|同位语|插入|修饰|指代|否定|让步|条件|转折|因果|倒装|跨距|依存|省略|主干.*(?:距离|跨度)/i;
  if (!d.addedComplexityFeatures.some(feature => structuralFeature.test(feature))) fail("nonstructural_difficulty");
  const difficultyIds = new Set();
  for (const source of d.sourceDifficulties) {
    exactKeys(source, ["sourceReviewId", "difficulty"], "invalid_difficulty");
    if (!sourceMap.has(source.sourceReviewId) || difficultyIds.has(source.sourceReviewId) || !Number.isFinite(source.difficulty) || source.difficulty < 0) fail("invalid_difficulty");
    difficultyIds.add(source.sourceReviewId);
    const supplied = sourceMap.get(source.sourceReviewId)?.difficulty;
    if (Number.isFinite(supplied) && supplied !== source.difficulty) fail("invalid_difficulty");
  }
  const baseline = Math.max(...d.sourceDifficulties.map(source => source.difficulty));
  if (![d.sourceDifficulty, d.targetDifficulty, d.difficultyDelta].every(Number.isFinite) || d.sourceDifficulty !== baseline || d.difficultyDelta !== 1 || d.targetDifficulty !== baseline + 1) fail("invalid_difficulty");
  return { ...item, text: item.text.trim() };
}
export function validateGeneratedBatch(value, { count, sources, words, excludedSentences = [], excludedFingerprints = [], skill = null }) {
  exactKeys(value, ["items"], "invalid_batch_schema");
  if (!Array.isArray(value.items)) fail("invalid_batch_schema");
  const items = [], errors = [];
  for (let index = 0; index < Math.min(value.items.length, count); index++) {
    try { items.push(validateGeneratedItem(value.items[index], { sources, words, skill, excludedFingerprints, excludedSentences: [...excludedSentences, ...items.map(item => item.text)] })); }
    catch (error) { if (!(error instanceof LongSentenceValidationError)) throw error; errors.push({ index, code: error.code }); }
  }
  if (value.items.length !== count) errors.push({ code: "wrong_count", expected: count, received: value.items.length });
  // Excess items are never silently presented as a conforming batch.
  if (value.items.length > count) fail("wrong_count");
  return { items, errors, missingCount: count - items.length };
}
export function validateEvaluation(value) {
  exactKeys(value, ["canonicalStructure", "referenceTranslation", "vocabularyNotes", "translationEvaluation"], "invalid_evaluation_schema");
  const structure = value.canonicalStructure;
  exactKeys(structure, ["mainClause", "subject", "predicate", "objectOrComplement", "clauses", "modifiers", "logicalRelations"], "invalid_structure");
  if (![structure.mainClause, structure.subject, structure.predicate].every(string) || typeof structure.objectOrComplement !== "string" || ![structure.clauses, structure.modifiers, structure.logicalRelations].every(arrayOfStrings)) fail("invalid_structure");
  if (!string(value.referenceTranslation) || !Array.isArray(value.vocabularyNotes)) fail("invalid_evaluation_schema");
  for (const note of value.vocabularyNotes) { exactKeys(note, ["word", "meaning"], "invalid_vocabulary_note"); if (!string(note.word) || !string(note.meaning)) fail("invalid_vocabulary_note"); }
  const evaluation = value.translationEvaluation;
  const issueKeys = ["structuralUnderstandingErrors", "wordMeaningErrors", "logicalRelationErrors", "chineseExpressionIssues"];
  exactKeys(evaluation, [...issueKeys, "correctPoints", "nextTrainingFocus"], "invalid_assessment");
  for (const key of issueKeys) {
    if (!Array.isArray(evaluation[key])) fail("invalid_assessment");
    for (const issue of evaluation[key]) { exactKeys(issue, ["excerpt", "explanation", "severity"], "invalid_assessment"); if (typeof issue.excerpt !== "string" || !string(issue.explanation) || !["major", "minor"].includes(issue.severity)) fail("invalid_assessment"); }
  }
  if (!arrayOfStrings(evaluation.correctPoints) || !arrayOfStrings(evaluation.nextTrainingFocus)) fail("invalid_assessment");
  return value;
}
