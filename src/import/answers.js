import { getOfficialAnswerKey } from "../answerKeys.js";
import { getClozeOfficialAnswerKey } from "../clozeAnswerKeys.js";
import { getCurrentUsername, getUserItem } from "../userData.js";
import { questionsFor, hashContent, scopedId } from "./contracts.js";
import { importRepository, ANSWERS_CHANGED } from "./repository.js";
import { emitAppEvent } from "../events/appEvents.js";
import { postgraduateResources, postgraduateClozeResources } from "../library.js";
import { listClozeReviewTasks } from "../clozeReview.js";
import { listReviewTasks } from "../readingReview.js";

export function verifiedOfficialAnswers(resource, target) {
  if (!resource || resource.importVersion || resource.kind === "custom") return {};
  const catalog = target === "cloze" ? postgraduateClozeResources : postgraduateResources;
  const canonical = catalog.find((r) => r.id === resource.id);
  if (!canonical || canonical.year !== Number(resource.year) || canonical.kind !== resource.kind || target !== "cloze" && canonical.text !== Number(resource.text)) return {};
  return target === "cloze" ? getClozeOfficialAnswerKey(canonical) : getOfficialAnswerKey(canonical);
}

export function latestRevisions(records, field) {
  const map = new Map();
  for (const r of records) { const key = r[field]; if (!map.has(key) || map.get(key).revision < r.revision) map.set(key, r); }
  return [...map.values()];
}
export function answerReadModel({ resource, content, records = [], explanations = [] }) {
  const target = resource.target || (resource.kind === "official-cloze" || resource.clozeSource ? "cloze" : "reading");
  const questions = questionsFor(target, content);
  const official = verifiedOfficialAnswers(resource, target);
  const rows = latestRevisions(records.filter((r) => r.materialId === resource.id), "answerId");
  const ex = latestRevisions(explanations.filter((r) => r.materialId === resource.id), "explanationId");
  const reference = {}, perQuestion = {}, pending = rows.filter((r) => r.mappingStatus !== "matched" && r.reviewStatus !== "revoked");
  for (const q of questions) {
    const matching = rows.filter((r) => r.questionId === q.id && r.reviewStatus === "confirmed" && r.mappingStatus === "matched" && q.options.some((o) => o.key === r.value));
    const valid = matching.length && new Set(matching.map((r) => r.value)).size === 1 ? matching.sort((a, b) => (a.source === "source_document" ? -1 : 1) - (b.source === "source_document" ? -1 : 1))[0] : null;
    if (valid) reference[q.number] = valid.value;
    perQuestion[q.id] = { question: q, answer: valid, explanation: ex.filter((r) => r.questionId === q.id).sort((a, b) => b.revision - a.revision)[0]?.text || "", officialAnswer: official[q.number] || "" };
  }
  const missing = questions.filter((q) => !official[q.number] && !reference[q.number] && !rows.some((r) => r.reviewStatus !== "revoked" && (r.questionId === q.id || String(r.number) === String(q.number))));
  return { target, questions, official, reference, perQuestion, pending, records: rows, explanations: ex, missing, covered: Object.keys(official).length || Object.keys(reference).length, total: questions.length, basis: Object.keys(official).length ? "依据已核验官方答案" : "依据原文件／用户确认参考答案" };
}
export async function readMaterialAnswers(resource, content, repository = importRepository) {
  if (resource.username && resource.username !== repository.getUsername()) throw new Error("资料不属于当前账号");
  const [records, explanations] = await Promise.all([repository.list("material-answers"), repository.list("material-explanations")]);
  return answerReadModel({ resource, content, records, explanations });
}
export function evaluateAnswers(model, attempts) {
  const grade = (key, category) => {
    const pairs = model.questions.filter((q) => key[q.number]);
    return { category, correct: pairs.filter((q) => attempts?.[q.number] === key[q.number]).length, answered: pairs.filter((q) => Boolean(attempts?.[q.number])).length, denominator: pairs.length, total: model.total, basis: category === "official" ? "依据已核验官方答案" : "依据原文件／用户确认参考答案" };
  };
  return { official: grade(model.official, "official"), reference: grade(model.reference, "reference") };
}
export async function reviseMaterialAnswer({ resource, content, questionId, value, explanation, explanationSource, previousId, expectedRevision, revoke = false }, repository = importRepository) {
  const session = repository.session();
  const username = repository.getUsername(), model = await readMaterialAnswers(resource, content, repository);
  repository.assertSession(session);
  const q = model.questions.find((q) => q.id === questionId);
  if (!q || !revoke && !q.options.some((o) => o.key === value)) throw new Error("题目或选项无效");
  const previous = previousId ? model.records.find((r) => r.id === previousId) : model.records.filter((r) => r.questionId === questionId).sort((a, b) => b.revision - a.revision)[0];
  const answerId = previous?.answerId || questionId, revision = (previous?.revision || 0) + 1;
  if (expectedRevision != null && expectedRevision !== (previous?.revision || 0)) throw new Error("答案已被更新，请重新载入");
  const now = Date.now();
  // Explanation revisions are independent of answer revisions and never change grading.
  if (previous?.questionId === questionId && previous.value === value && previous.reviewStatus === "confirmed" && !revoke) {
    const current = model.explanations.filter((e) => e.questionId === questionId).sort((a, b) => b.revision - a.revision)[0];
    if (explanation != null && explanation !== (current?.text || "")) {
      await repository.transaction(["material-explanations"], "readwrite", (tx, done, guard) => {
        const store = tx.objectStore("material-explanations"), request = store.index("materialId").getAll(resource.id);
        request.onsuccess = () => { guard(); const latest = latestRevisions(request.result.filter((e) => e.username === username && e.questionId === questionId), "explanationId"); const revision = Math.max(0, ...latest.map((e) => e.revision)) + 1; const row = { id: `${resource.id}:explanation:${questionId}:v${revision}`, username, materialId: resource.id, questionId, explanationId: current?.explanationId || questionId, revision, text: explanation, source: explanationSource || "manual", editedBy: username, createdAt: now }; store.add(row); done(row); };
      }, username);
      emitAppEvent(ANSWERS_CHANGED, { materialId: resource.id });
    }
    return previous;
  }
  const source = previous?.source === "ai_generated" ? "ai_generated" : previous && (revoke || previous.value === value) ? previous.source : "manual";
  const record = { ...(previous || {}), id: `${resource.id}:answer:${answerId}:v${revision}`, username, materialId: resource.id, questionId, answerId, number: String(q.number), value: revoke ? previous?.value || value || "" : value, source, mappingStatus: "matched", reviewStatus: revoke ? "revoked" : "confirmed", ambiguous: false, revision, materialRevision: resource.materialRevision || 1, createdAt: now, editedBy: username, provenance: { ...(previous?.provenance || {}), previousId: previous?.id || null, manuallyEdited: true } };
  const explanationRow = explanation == null ? null : { id: `${record.id}:explanation`, username, materialId: resource.id, questionId, explanationId: previous?.answerId || questionId, text: explanation, source: explanationSource || "manual", revision, createdAt: now };
  await repository.transaction(["material-answers", "material-explanations"], "readwrite", (tx, done, guard) => {
    const store = tx.objectStore("material-answers");
    const request = store.index("materialId").getAll(resource.id);
    request.onsuccess = () => {
      guard();
      const latest = latestRevisions(request.result.filter((r) => r.username === username && r.answerId === answerId), "answerId")[0];
      if ((latest?.revision || 0) !== revision - 1) { tx.abort(); return; }
      store.add(record);
      if (explanationRow) {
        const exStore = tx.objectStore("material-explanations"), request = exStore.index("materialId").getAll(resource.id);
        request.onsuccess = () => { guard(); explanationRow.revision = Math.max(0, ...request.result.filter((e) => e.username === username && e.questionId === questionId).map((e) => e.revision)) + 1; explanationRow.id = `${record.id}:explanation:v${explanationRow.revision}`; exStore.add(explanationRow); done(record); };
      } else done(record);
    };
  }, username);
  const updated = await readMaterialAnswers(resource, content, repository);
  await regradeMaterial(resource, content, updated, repository);
  emitAppEvent(ANSWERS_CHANGED, { materialId: resource.id });
  return record;
}
export async function confirmAiAnswer(resource, content, candidate, repository = importRepository) {
  const session = repository.session(); repository.assertSession(session);
  const username = repository.getUsername(), question = questionsFor(resource.target, content).find((q) => q.id === candidate.questionId);
  if (!question || !question.options.some((o) => o.key === candidate.value) || candidate.source !== "ai_generated" || candidate.provenance?.inputRevision !== (resource.materialRevision || 1)) throw new Error("AI 候选已失效，请重新生成并核对");
  await repository.transaction(["material-answers", "material-explanations"], "readwrite", (tx, done, guard) => {
    const store = tx.objectStore("material-answers"), request = store.index("materialId").getAll(resource.id);
    request.onsuccess = () => {
      guard(); const rows = latestRevisions(request.result.filter((r) => r.username === username), "answerId");
      if (rows.some((r) => (r.questionId === question.id || String(r.number) === String(question.number)) && r.reviewStatus !== "revoked")) { tx.abort(); return; }
      const revision = Math.max(0, ...rows.filter((r) => r.answerId === question.id).map((r) => r.revision)) + 1;
      const { explanation, ...answer } = candidate;
      const row = { ...answer, id: `${resource.id}:answer:${question.id}:v${revision}`, username, materialId: resource.id, questionId: question.id, answerId: question.id, revision, materialRevision: resource.materialRevision || 1, reviewStatus: "confirmed", mappingStatus: "matched", createdAt: Date.now() };
      const generated = candidate.provenance?.generatedAnswer;
      if (generated && generated.value !== row.value) {
        store.add({ ...row, value: generated.value, reviewStatus: "candidate" });
        row.revision++;
        row.id = `${resource.id}:answer:${question.id}:v${row.revision}`;
        row.editedBy = username;
        row.provenance = { ...row.provenance, manuallyEdited: true };
      }
      store.add(row);
      const exStore = tx.objectStore("material-explanations"), exRequest = exStore.index("materialId").getAll(resource.id);
      exRequest.onsuccess = () => {
        guard(); let exRevision = Math.max(0, ...exRequest.result.filter((e) => e.username === username && e.questionId === question.id).map((e) => e.revision)) + 1;
        const saveExplanation = (text) => exStore.add({ id: `${row.id}:explanation:v${exRevision}`, username, materialId: resource.id, questionId: question.id, explanationId: question.id, revision: exRevision, source: "ai_generated", text, editedBy: generated && text !== generated.explanation ? username : null, createdAt: Date.now() });
        if (generated && generated.explanation !== explanation) { saveExplanation(generated.explanation || ""); exRevision++; }
        saveExplanation(explanation || ""); done(row);
      };
    };
  }, username);
  await regradeMaterial(resource, content, await readMaterialAnswers(resource, content, repository), repository);
  emitAppEvent(ANSWERS_CHANGED, { materialId: resource.id });
}
function readJson(key, username) { try { return JSON.parse(getUserItem(key, username) || "{}"); } catch { return {}; } }
export async function regradeMaterial(resource, content, model, repository = importRepository) {
  const username = repository.getUsername();
  if (!username) return;
  if (resource.username && resource.username !== username) throw new Error("资料不属于当前账号");
  const session = repository.session();
  const attempts = model.target === "cloze" ? (() => {
    const progress = readJson(`wuliao:cloze-progress:${resource.id}:${resource.id}`, username);
    return ["firstAnswer", "reviewAnswer"].map((field) => ({ name: field, answers: Object.fromEntries(Object.entries(progress.attempts || {}).map(([n, a]) => [n, a[field] || ""])) }));
  })() : ["first", "redo"].map((name) => ({ name, answers: readJson(`wuliao:deep-answers:${resource.id}:${content.id}:${name}`, username) }));
  if (model.target === "cloze") {
    for (const task of listClozeReviewTasks(username).filter((t) => t.resourceId === resource.id)) attempts.push({ name: `review:${task.key || task.taskKey}`, answers: Object.fromEntries(Object.entries(task.attempts || {}).map(([n, a]) => [n, a.answer || ""])) });
  } else {
    for (const task of listReviewTasks(username).filter((t) => t.resourceId === resource.id && t.passageId === content.id)) attempts.push({ name: `review:${task.key || task.taskKey}`, answers: task.session?.reviewAnswers || {} });
  }
  const version = await hashContent({ records: model.records.map((r) => [r.id, r.revision, r.reviewStatus]), official: model.official });
  for (const attempt of attempts) {
    if (!Object.values(attempt.answers).some(Boolean)) continue;
    const input = await hashContent(attempt.answers); const id = scopedId(username, "evaluation", resource.id, content.id, attempt.name, version, input);
    repository.assertSession(session);
    if (!await repository.get("answer-evaluations", id)) await repository.put("answer-evaluations", { id, username, materialId: resource.id, contentId: content.id, attempt: attempt.name, answerVersion: version, answerRecordIds: model.records.map((r) => r.id), gradingBasis: { official: model.official, reference: model.reference, sources: Object.fromEntries(Object.entries(model.perQuestion).filter(([, entry]) => entry.answer).map(([id, entry]) => [id, { recordId: entry.answer.id, source: entry.answer.source, revision: entry.answer.revision }])) }, answers: attempt.answers, scores: evaluateAnswers(model, attempt.answers), createdAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
// Rebuild unfinished scoring work from durable answers and existing attempts.
// Evaluation IDs make restarting this scan safe without another progress store.
export async function resumeAnswerRegrading({ signal } = {}, repository = importRepository) {
  const session = repository.session(); repository.assertSession(session);
  const materials = await repository.list("custom-pdfs");
  const errors = [];
  for (const resource of materials) {
    if (signal?.aborted) break;
    repository.assertSession(session);
    if (!resource.importVersion || resource.deletedAt) continue;
    const content = resource.target === "cloze" ? resource.analysis?.clozes?.[0] : resource.analysis?.passages?.[0];
    if (!content) continue;
    try { await regradeMaterial(resource, content, await readMaterialAnswers(resource, content, repository), repository); }
    catch (error) { repository.assertSession(session); errors.push({ materialId: resource.id, message: error.message }); }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return errors;
}
export async function verifyImportReferences(repository = importRepository) {
  const [files, reading, writing, answers, ex] = await Promise.all([repository.list("import-files"), repository.list("custom-pdfs"), repository.list("writing-materials"), repository.list("material-answers"), repository.list("material-explanations")]);
  const materialIds = new Set([...reading, ...writing].map((r) => r.id)), fileIds = new Set(files.map((r) => r.id)); const errors = [];
  for (const r of [...reading, ...writing]) if (r.sourceFileId && !fileIds.has(r.sourceFileId)) errors.push(`${r.title} 缺少来源文件`);
  for (const row of [...answers, ...ex]) if (!materialIds.has(row.materialId)) errors.push("答案或解析缺少对应资料");
  for (const row of writing) for (const asset of row.content.assets || []) if (asset.fileId && !fileIds.has(asset.fileId)) errors.push("作文缺少题图附件");
  return errors;
}
