import test from "node:test";
import assert from "node:assert/strict";
import { parseCandidates, parseSourceAnswers, mapAnswers } from "../src/import/parsers.js";
import { validateContent, contentIdentity, hashContent } from "../src/import/contracts.js";
import { answerReadModel, evaluateAnswers, verifiedOfficialAnswers } from "../src/import/answers.js";
import { missingQuestions, validateAiAnswers, generateReferenceAnswers } from "../src/import/ai.js";
import { detectFormat } from "../src/import/extractor.js";
import { configureQuestionlessFlow, emptyFlow, completeStage } from "../src/readingFlow.js";
import { IDB_INCLUDED, IDB_EXCLUDED_STORES } from "../src/backup.js";
import { normalizeClozeProgress, emptyClozeProgress } from "../src/clozeProgress.js";

const passage = "People learn through practice. A careful reader checks the source before drawing conclusions. Understanding a passage takes patience, because its details can support several different interpretations. Good readers preserve evidence and compare their explanations with the original sentences. They also notice how the structure connects ideas and ask clear questions when a claim is uncertain. This habit makes learning reliable and useful over time.";
const question = (n) => `${n}. What helps readers learn?\n[A] Practice and evidence\n[B] Random guesses\n[C] Ignoring details\n[D] Changing the original`;
const cloze = `Section I Use of English\n\nPeople learn __1__ practice and remember __2__ details. Reading carefully helps them become more reliable learners.\n\n1. [A] through [B] above [C] under [D] against\n2. [A] useful [B] empty [C] false [D] broken`;
const input = (text) => ({ pages: [{ pageNumber: 1, text, textSource: "text" }], assets: [] });
const opts = (target) => ({ username: "test", fingerprint: "a".repeat(64), target, title: "fixture", fileId: "file-1" });
test("same mixed file produces independent reading/cloze identities, only target content", async () => {
  const mixed = input(`${cloze}\n\nSection II Reading Comprehension\nText 1\n${passage}\n${question(21)}\nWriting A\nDirections: Write a letter.`);
  const reading = await parseCandidates(mixed, opts("reading")), blanks = await parseCandidates(mixed, opts("cloze"));
  assert.equal(reading.length, 1); assert.equal(blanks.length, 1); assert.notEqual(reading[0].id, blanks[0].id);
  assert.equal(reading[0].content.questions.length, 1); assert.equal(blanks[0].content.blanks.length, 2);
  assert.deepEqual(blanks[0].validation.errors, []);
});
test("answer block does not discard subsequent passages or writing", async () => {
  const text = `Text 1\n${passage}\n${question(21)}\n参考答案\n21. A\nText 2\n${passage.replace('People', 'Students')}\n${question(22)}\n参考答案\n22. B\nWriting B\nDirections: Write an essay about learning.\n参考范文\n${passage}`;
  const rows = await parseCandidates(input(text), opts("reading"));
  assert.equal(rows.length, 2); assert.equal(rows[0].answers[0].value, "A"); assert.equal(rows[1].answers[0].value, "B");
  assert.equal((await parseCandidates(input(text), opts("writing"))).length, 1);
});
test("duplicate question numbers across materials never match global answer by order", async () => {
  const rows = await parseCandidates(input(`Text 1\n${passage}\n${question(1)}\nText 2\n${passage}\n${question(1)}\n参考答案\n1. A`), opts("reading"));
  assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.answers[0].mappingStatus === "unresolved")); assert.ok(rows.every((r) => missingQuestions(r).length === 0));
});
test("conflicting answers and invalid option remain unresolved, valid answer needs no explanation", async () => {
  const rows = await parseCandidates(input(`Text 1\n${passage}\n${question(21)}\n${question(22)}\n参考答案\n21. A\n21. B\n22. D`), opts("reading"));
  assert.equal(rows[0].answers.filter((a) => a.mappingStatus === "matched").length, 1);
  assert.equal(rows[0].answers.find((a) => a.number === "22").reviewStatus, "confirmed");
  assert.ok(rows[0].answers.find((a) => a.number === "21").reviewStatus === "candidate");
});
test("arbitrary cloze numbers preserve Blank/Segment correspondence; no forced 20 blanks", async () => {
  const text = cloze.replaceAll('__1__', '__21__').replaceAll('__2__', '__22__').replace('\n1.', '\n21.').replace('\n2.', '\n22.');
  const [row] = await parseCandidates(input(text), opts("cloze"));
  assert.deepEqual(row.content.blanks.map((b) => b.number), [21, 22]); assert.deepEqual(row.validation.errors, []);
});
test("missing or repeated segment is a real structural error", async () => {
  const [row] = await parseCandidates(input(cloze.replace('__2__', '__1__')), opts("cloze")); assert.ok(row.validation.errors.length);
});
test("pure article has zero fake questions and question-dependent stages are skipped", async () => {
  const [row] = await parseCandidates(input(passage), opts("reading")); assert.equal(row.content.questions.length, 0);
  const flow = configureQuestionlessFlow(emptyFlow('r', 'p')); assert.equal(flow.stages['deep-first-quiz'].status, 'skipped');
  assert.equal(completeStage(flow, 'deep-cover').currentStage, 'deep-clean-text');
});
test("writing prompt-only, sample-only and complete are distinguished without AI", async () => {
  const [prompt] = await parseCandidates(input('Writing A\nDirections: Write a letter to your teacher.'), opts('writing'));
  const [sample] = await parseCandidates(input(passage), opts('writing'));
  const [both] = await parseCandidates(input(`Writing B\nDirections: Write an essay about learning.\n参考范文\n${passage}`), opts('writing'));
  assert.equal(prompt.content.referenceEssay, ''); assert.equal(sample.content.promptText, ''); assert.equal(sample.content.year, null);
  assert.ok(validateContent('writing', both.content).warnings.length === 0);
});
test("JSON validates schema, numbering and does not trust supplied official provenance", async () => {
  const content = { paragraphs: [{ number: 1, text: passage }], questions: [{ number: 1, stem: 'Which?', options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }] }] };
  const rows = await parseCandidates({ ...input(''), json: { format: 'wuliao-material-import', version: 1, items: [{ target: 'reading', title: 'source', content, answers: [{ number: 1, value: 'A', source: 'official' }] }] } }, opts('reading'));
  assert.equal(rows[0].answers[0].source, 'source_document');
  await assert.rejects(parseCandidates({ ...input(''), json: { format: 'wuliao-material-import', version: 7, items: [] } }, opts('reading')));
  await assert.rejects(parseCandidates({ ...input(''), json: { format: 'wuliao-material-import', version: 1, items: [{ target: 'other', content }] } }, opts('reading')));
});
test("reference scores are isolated and denominator includes only covered questions", async () => {
  const [row] = await parseCandidates(input(`Text 1\n${passage}\n${question(21)}\n${question(22)}\n参考答案\n21. A`), opts('reading'));
  const model = answerReadModel({ resource: { id: row.id, target: 'reading', kind: 'custom', importVersion: 'v1', year: 2023, text: 1 }, content: row.content, records: row.answers.map((a) => ({ ...a, materialId: row.id, answerId: a.questionId, revision: 1 })) });
  const scores = evaluateAnswers(model, { 21: 'A', 22: 'B' }); assert.equal(scores.official.denominator, 0); assert.equal(scores.reference.denominator, 1); assert.equal(scores.reference.correct, 1); assert.equal(model.missing.length, 1);
});
test("revocation hides latest answer without erasing earlier revisions", async () => {
  const [row] = await parseCandidates(input(`Text 1\n${passage}\n${question(21)}\n参考答案\n21. A`), opts('reading'));
  const first = { ...row.answers[0], materialId: row.id, answerId: row.answers[0].questionId, revision: 1 };
  const model = answerReadModel({ resource: { id: row.id, target: 'reading', kind: 'custom' }, content: row.content, records: [first, { ...first, revision: 2, reviewStatus: 'revoked' }] }); assert.equal(model.covered, 0); assert.equal(model.records[0].revision, 2);
});
test("AI disabled by default, rejects unknown/repeated ids and invalid answers", async () => {
  let calls = 0; await assert.rejects(generateReferenceAnswers({}, { request: async () => { calls++; } }), /确认/); assert.equal(calls, 0);
  const input = { questions: [{ questionId: 'q', number: '1', options: [{ key: 'A' }] }] };
  assert.throws(() => validateAiAnswers({ answers: [{ questionId: 'x', value: 'A', explanation: '' }] }, input));
  assert.throws(() => validateAiAnswers({ answers: [{ questionId: 'q', value: 'B', explanation: '' }] }, input));
  const valid = validateAiAnswers({ answers: [{ questionId: 'q', value: 'A', explanation: 'reason' }] }, input); assert.equal(valid[0].source, 'ai_generated'); assert.equal(valid[0].reviewStatus, 'candidate');
});
test("fingerprint excludes title and answer changes; target distinguishes identity", async () => {
  const [r] = await parseCandidates(input(passage), opts('reading'));
  assert.equal(await hashContent(contentIdentity('reading', r.content)), r.contentFingerprint);
  assert.notEqual(await hashContent(contentIdentity('cloze', r.content)), r.contentFingerprint);
});
test("format signature beats extension; invalid and oversized files fail truthfully", async () => {
  assert.equal(await detectFormat(new File(['%PDF-1.7\n'], 'renamed.txt', { type: 'text/plain' })), 'pdf');
  await assert.rejects(detectFormat(new File(['junk'], 'wrong.pdf', { type: 'application/pdf' })));
  await assert.rejects(detectFormat(new File([], 'empty.txt')));
});
test("formal import stores are backed up; caches and drafts excluded", () => {
  for (const name of ['import-files', 'writing-materials', 'material-answers', 'material-explanations', 'answer-evaluations', 'import-receipts']) assert.ok(IDB_INCLUDED['wuliao-english'][name]);
  assert.equal(IDB_INCLUDED['wuliao-english']['import-files'].includeBlob, true);
  assert.ok(IDB_EXCLUDED_STORES['wuliao-english'].includes('import-batches')); assert.ok(IDB_EXCLUDED_STORES['wuliao-english'].includes('import-cache'));
});

test("official grading requires canonical identity, never a filename year or claimed kind", () => {
  assert.deepEqual(verifiedOfficialAnswers({ id: 'custom-2021-cloze', kind: 'official-cloze', year: 2021 }, 'cloze'), {});
  assert.deepEqual(verifiedOfficialAnswers({ id: 'postgraduate-2021-text-1', kind: 'official', year: 2021, text: 1, importVersion: 'unified-v1' }, 'reading'), {});
  assert.equal(Object.keys(verifiedOfficialAnswers({ id: 'postgraduate-2021-text-1', kind: 'official', year: 2021, text: 1 }, 'reading')).length, 5);
});

test("ten questions with seven confirmed, one pending and two absent only requests two missing", async () => {
  const [candidate] = await parseCandidates(input(`Text 1\n${passage}\n${Array.from({ length: 10 }, (_, i) => question(i + 21)).join('\n')}`), opts('reading'));
  candidate.answers = [...Array.from({ length: 7 }, (_, i) => ({ number: String(i + 21), value: 'A', source: 'source_document' })), { number: '28', value: 'A', source: 'source_document', ambiguous: true }];
  candidate.answers = mapAnswers(candidate);
  assert.deepEqual(missingQuestions(candidate).map((q) => String(q.number)), ['29', '30']);
  const records = candidate.answers.map((a, i) => ({ ...a, answerId: a.questionId || `pending:${i}`, materialId: candidate.id, revision: 1 }));
  const model = answerReadModel({ resource: { id: candidate.id, target: 'reading', kind: 'custom' }, content: candidate.content, records });
  assert.equal(model.pending.length, 1); assert.equal(model.covered, 7); assert.equal(evaluateAnswers(model, {}).reference.denominator, 7); assert.equal(model.total, 10);
});

test("dynamic cloze progress survives readers that do not repeat the blank list", () => {
  const p = emptyClozeProgress('dynamic', 'dynamic', [21, 22]); p.attempts[21].firstAnswer = 'B';
  const restored = normalizeClozeProgress(p);
  assert.deepEqual(Object.keys(restored.attempts), ['21', '22']); assert.equal(restored.attempts[21].firstAnswer, 'B');
});
