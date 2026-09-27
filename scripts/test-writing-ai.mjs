import test from "node:test";
import assert from "node:assert/strict";
import { WritingAttemptStatus, WritingAttemptType, WritingStage, WritingTaskType } from "../src/writing/writingModels.js";
import { WritingAiTask, WRITING_AI_PROMPT_VERSIONS, buildCompareDiagnosisPayload, buildSampleGenerationPayload, buildScorePayload, buildWritingAiFormatRepairPayload, buildWritingAiMessages } from "../src/writing/writingAiTasks.js";
import { createWritingAiService, WritingAiServiceError } from "../src/writing/writingAiService.js";
import { WRITING_SCORE_DIMENSIONS } from "../src/writing/writingRubrics.js";

const essay = "word ".repeat(100).trim();
const prompt = { questionId: "p1", fingerprint: "prompt-fp", taskType: WritingTaskType.POSTGRAD_EN1_WRITING_A, promptText: "Write a notice.", directions: "Write about 100 words.", assets: [] };
function attempt(id, type, stage, overrides = {}) { return { attemptId: id, username: "alice", sessionId: "s1", fingerprint: `${id}-fp`, attemptType: type, stageId: stage, status: WritingAttemptStatus.SUBMITTED, parentAttemptId: null, context: type === WritingAttemptType.BACK_TRANSLATION ? { translationSnapshotId: "t1" } : { promptFingerprint: "prompt-fp" }, verifiedText: { text: "This verified essay has a uniquely quoted sentence and another sentence.", fingerprint: `${id}-verified-fp` }, ...overrides }; }
function fixtures() {
  const w3 = attempt("w3", WritingAttemptType.BACK_TRANSLATION, WritingStage.W3_BACK_TRANSLATION); const parent = attempt("w7", WritingAttemptType.INDEPENDENT, WritingStage.W7_INDEPENDENT); const revision = attempt("w8", WritingAttemptType.REVISION, WritingStage.W8_SCORE_REWRITE, { parentAttemptId: "w7" });
  const session = { sessionId: "s1", username: "alice", fingerprint: "session-fp", promptSnapshot: prompt, sampleEssaySnapshot: { essayId: "sample-1", fingerprint: "sample-fp", text: "A full sample must never enter compare payload.", segments: [{ unitId: "u1", text: "Welcome to our club." }] } };
  const translation = { snapshotId: "t1", username: "alice", sessionId: "s1", fingerprint: "translation-fp", units: [{ unitId: "u1", typedText: "欢迎来到我们的社团" }] };
  const score = { scoreReportId: "score-parent", username: "alice", sessionId: "s1", fingerprint: "score-fp", sourceAttemptId: "w7", sourceTextFingerprint: parent.verifiedText.fingerprint, finalScore: 7, dimensions: {}, issues: [], revisionAdvice: [] };
  const artifacts = new Map(); const scores = new Map(); const attempts = new Map([["w3", w3], ["w7", parent], ["w8", revision]]);
  return { session, translation, w3, parent, revision, score, artifacts, scores, attempts, repository: { readSession: async () => session, readAttempt: async (id) => attempts.get(id) || null, readTranslationSnapshot: async () => translation, readScoreReport: async (id) => scores.get(id) || (id === "score-parent" ? score : null), readAiArtifact: async (id) => artifacts.get(id) || null, createAiArtifact: async (record) => { artifacts.set(record.artifactId, { ...record, fingerprint: `${record.artifactId}-fp` }); return artifacts.get(record.artifactId); }, createScoreReport: async (record) => { scores.set(record.scoreReportId, { ...record, fingerprint: `${record.scoreReportId}-fp` }); return scores.get(record.scoreReportId); } } }; }
function scoreResponse({ modelWordCount = false } = {}) { const dimensions = Object.fromEntries(WRITING_SCORE_DIMENSIONS.map((name) => [name, { rating: "strong", comment: "A supported judgment.", evidence: ["uniquely quoted sentence"] }])); return { finalScore: 7, band: 4, zeroReason: null, dimensions, issues: [], strengths: ["Clear purpose."], revisionAdvice: ["Vary syntax."], ...(modelWordCount ? { wordCount: 999, lengthIssue: null } : {}) }; }
function compareResponse() { return { units: [{ unitId: "u1", meaning: { status: "partial", evidence: "key intent retained" }, grammar: [], collocation: [], naturalness: [], register: [], learnablePatterns: [{ sampleExcerpt: "our club", userExcerpt: "essay", reason: "keep the noun phrase" }] }] }; }
function rewriteResponse() { return { referenceText: "A revised reference answer.", changeNotes: [{ category: "grammar", fromExcerpt: "essay", toExcerpt: "essay is", reason: "complete the clause" }], rationale: ["The rewrite retains the intended task response."] }; }
function critic({ band = 5, min = 9, max = 10, pass = true } = {}) { return { pass, predictedBand: band, predictedScoreRange: { min, max }, fatalIssues: [], defects: [], checks: { taskFulfillment: "pass", formatRegister: "not_applicable", coherence: "pass", languageAccuracy: "pass", languageRange: "pass", naturalness: "pass" } }; }
function sample() { return { taskType: prompt.taskType, promptFingerprint: prompt.fingerprint, essayText: essay, segments: [{ unitId: "u1", text: essay }] }; }
function serviceWithReplies(replies, setup = fixtures()) { const calls = []; const service = createWritingAiService({ repository: setup.repository, getCurrentUsername: async () => "alice", now: () => 1000, getApiKey: async () => "key", callAi: async (detail) => { calls.push(detail); const next = replies.shift(); if (next instanceof Error) throw next; return { content: typeof next === "string" ? next : JSON.stringify(next) }; } }); return { service, calls, setup }; }

test("Task ids stay fixed and formal payloads fence model-visible facts", () => {
  const data = fixtures(); const scorePayload = buildScorePayload({ promptSnapshot: prompt, sourceAttempt: data.parent, rubricVersion: "postgrad-en1-writing-a-v1" }); assert.deepEqual(Object.keys(scorePayload).sort(), ["promptSnapshot", "rubricVersion", "verifiedText"]);
  const comparePayload = buildCompareDiagnosisPayload({ sampleEssaySnapshot: data.session.sampleEssaySnapshot, translationSnapshot: data.translation, sourceAttempt: data.w3 }); assert.equal("text" in comparePayload.sampleEssaySnapshot, false); assert.deepEqual(Object.keys(comparePayload.sampleEssaySnapshot).sort(), ["essayId", "fingerprint", "segments"]);
  assert.equal(WritingAiTask.SCORE, "writing.score.v1"); assert.equal(WRITING_AI_PROMPT_VERSIONS.score, "writing-score-v1");
});

test("Sample generator and repair prompts state the exact root JSON contract without blank identity placeholders", () => {
  const payload = buildSampleGenerationPayload({ promptSnapshot: prompt });
  const messages = buildWritingAiMessages(WritingAiTask.SAMPLE_GENERATE, payload);
  assert.match(messages[0].content, /top-level keys exactly/i);
  assert.match(messages[0].content, /Do not wrap/i);
  const request = JSON.parse(messages[1].content);
  assert.equal(request.outputContract.taskType, prompt.taskType);
  assert.equal(request.outputContract.promptFingerprint, prompt.fingerprint);
  assert.deepEqual(request.outputContract.segments, [{ unitId: "unit-1", text: "non-empty essay segment" }]);
  assert.equal("response" in request, false);

  const repair = buildWritingAiFormatRepairPayload({
    taskType: WritingAiTask.SAMPLE_GENERATE,
    originalPayload: payload,
    invalidResponse: "bad",
  });
  assert.equal(repair.taskType, WritingAiTask.SAMPLE_GENERATE);
  assert.match(repair.instruction, /top-level keys exactly/i);
  assert.match(repair.instruction, /Do not wrap/i);
});

test("Sample critic and repair prompts state the frozen nested critic contract", () => {
  const payload = { candidate: sample(), promptSnapshot: prompt, deterministic: { pass: true, reasons: [], wordCount: 100 } };
  const messages = buildWritingAiMessages(WritingAiTask.SAMPLE_CRITIC, payload);
  assert.match(messages[0].content, /top-level keys exactly/i);
  assert.match(messages[0].content, /predictedScoreRange/i);
  assert.match(messages[0].content, /Do not return band or feedback/i);
  const request = JSON.parse(messages[1].content);
  assert.deepEqual(Object.keys(request.outputContract).sort(), ["checks", "defects", "fatalIssues", "pass", "predictedBand", "predictedScoreRange"]);
  assert.deepEqual(Object.keys(request.outputContract.checks).sort(), ["coherence", "formatRegister", "languageAccuracy", "languageRange", "naturalness", "taskFulfillment"]);

  const repair = buildWritingAiFormatRepairPayload({ taskType: WritingAiTask.SAMPLE_CRITIC, originalPayload: payload, invalidResponse: "bad" });
  assert.match(repair.instruction, /predictedScoreRange/i);
  assert.match(repair.instruction, /Do not return band or feedback/i);
});

test("Sample quality gate performs one generator format repair and persists a complete passed snapshot only in its result", async () => {
  const { service, calls } = serviceWithReplies(["not json", sample(), critic()]); const result = await service.generateSample({ promptSnapshot: prompt, sessionId: "s1", sampleEssayId: "generated-1" });
  assert.equal(calls.length, 3); assert.equal(result.status, "accepted"); assert.equal(result.sampleEssaySnapshot.sourceType, "ai_generated"); assert.equal(result.sampleEssaySnapshot.qualityStatus, "passed"); assert.equal(result.sampleEssaySnapshot.qualityGateVersion, "writing-sample-quality-gate-v1"); assert.equal(result.sampleEssaySnapshot.wordCount, 100); assert.ok(result.sampleEssaySnapshot.qualityReportFingerprint);
});

test("Sample acceptance requires critic band five, fatal-free result, and the rubric's band-five range", async () => {
  const { service, calls } = serviceWithReplies([sample(), critic({ band: 4 }), sample(), critic()]); const result = await service.generateSample({ promptSnapshot: prompt, sessionId: "s1" }); assert.equal(result.status, "accepted"); assert.equal(calls.length, 4);
});

test("Sample critic receives exactly one format repair without consuming another candidate", async () => {
  const { service, calls } = serviceWithReplies([sample(), "not json", critic()]); const result = await service.generateSample({ promptSnapshot: prompt, sessionId: "s1" }); assert.equal(result.status, "accepted"); assert.equal(calls.length, 3);
});

test("A second invalid response stops after one repair and reports the repair stage", async () => {
  const { service, calls } = serviceWithReplies(["not json", "still not json"]);
  await assert.rejects(
    () => service.generateSample({ promptSnapshot: prompt, sessionId: "s1" }),
    (error) => error instanceof WritingAiServiceError
      && error.code === "invalid_response"
      && error.requestStage === "format_repair",
  );
  assert.equal(calls.length, 2);
});

test("Provider failure is a hard sample error, never a candidate retry", async () => {
  const { service, calls } = serviceWithReplies([new Error("offline")]); await assert.rejects(() => service.generateSample({ promptSnapshot: prompt, sessionId: "s1" }), WritingAiServiceError); assert.equal(calls.length, 1);
});

test("Provider model failures retain request stage and non-secret lineage", async () => {
  const failure = Object.assign(new Error("Model Not Exist"), { status: 404 });
  const { service, calls } = serviceWithReplies([failure]);
  await assert.rejects(
    () => service.generateSample({ promptSnapshot: prompt, sessionId: "s1" }),
    (error) => error instanceof WritingAiServiceError
      && error.code === "model_unavailable"
      && error.requestStage === "generator"
      && error.taskId === WritingAiTask.SAMPLE_GENERATE
      && error.promptVersion === WRITING_AI_PROMPT_VERSIONS.sampleGenerator
      && error.provider === "https://api.deepseek.com"
      && error.modelId === "deepseek-chat",
  );
  assert.equal(calls.length, 1);
});

test("Text configuration status and probe use only Text getters and a minimal text-only request", async () => {
  const calls = [];
  const service = createWritingAiService({
    getCurrentUsername: async () => "alice",
    getApiKey: async () => "text-key",
    getApiConfig: () => ({ baseUrl: "https://text.example/v1" }),
    getModel: () => "text-model",
    callAi: async (detail) => { calls.push(detail); return { content: "OK" }; },
  });
  assert.deepEqual(await service.getConfigurationStatus(), {
    apiKeyConfigured: true,
    baseUrlConfigured: true,
    modelConfigured: true,
    baseUrl: "https://text.example/v1",
    modelId: "text-model",
  });
  const result = await service.probeTextCapability();
  assert.equal(result.status, "supported");
  assert.equal(result.baseUrl, "https://text.example/v1");
  assert.equal(result.modelId, "text-model");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskType, "writing.text.probe.v1");
  assert.deepEqual(calls[0].messages, [{ role: "user", content: "Return exactly: OK" }]);
});

test("Compare diagnoses persisted W3 facts, creates only an artifact, and repairs one malformed response", async () => {
  const { service, calls, setup } = serviceWithReplies(["bad", compareResponse()]); const saved = await service.diagnoseWritingComparison({ sessionId: "s1", backTranslationAttemptId: "w3", artifactId: "compare-1" }); assert.equal(saved.artifactType, "compare_diagnosis"); assert.equal(setup.artifacts.size, 1); const providerPayload = JSON.parse(calls[0].messages[1].content); assert.equal("text" in providerPayload.sampleEssaySnapshot, false); assert.equal(calls.length, 2);
});

test("Formal score sends exactly the minimal payload, ignores model word count, and persists only after validation", async () => {
  const { service, calls, setup } = serviceWithReplies([scoreResponse({ modelWordCount: true })]); const saved = await service.scoreWritingAttempt({ sessionId: "s1", attemptId: "w7", scoreReportId: "score-1" }); const providerPayload = JSON.parse(calls[0].messages[1].content); assert.deepEqual(Object.keys(providerPayload).sort(), ["promptSnapshot", "rubricVersion", "verifiedText"]); assert.equal(saved.wordCount, 11); assert.equal(saved.lengthIssue, "too_short"); assert.equal(setup.scores.size, 1);
});

test("Reference rewrite performs every lineage gate before provider work and stores revision source only", async () => {
  const bad = fixtures(); bad.score.sourceTextFingerprint = "wrong"; const denied = serviceWithReplies([rewriteResponse()], bad); await assert.rejects(() => denied.service.generateReferenceRewrite({ sessionId: "s1", revisionAttemptId: "w8", scoreReportId: "score-parent", artifactId: "rewrite-1" }), WritingAiServiceError); assert.equal(denied.calls.length, 0);
  const good = serviceWithReplies([rewriteResponse()]); const saved = await good.service.generateReferenceRewrite({ sessionId: "s1", revisionAttemptId: "w8", scoreReportId: "score-parent", artifactId: "rewrite-1" }); assert.equal(saved.sourceAttemptId, "w8"); const providerPayload = JSON.parse(good.calls[0].messages[1].content); assert.deepEqual(Object.keys(providerPayload.scoreReport).sort(), ["dimensions", "finalScore", "issues", "revisionAdvice"]);
});

test("Exact concurrent formal requests dedupe, while an account switch or source change turns the response stale", async () => {
  const data = fixtures(); let release; const delayed = new Promise((resolve) => { release = resolve; }); const calls = []; const service = createWritingAiService({ repository: data.repository, getCurrentUsername: async () => "alice", getApiKey: async () => "key", callAi: async (detail) => { calls.push(detail); await delayed; return { content: JSON.stringify(scoreResponse()) }; } }); const first = service.scoreWritingAttempt({ sessionId: "s1", attemptId: "w7", scoreReportId: "score-dedupe" }); const second = service.scoreWritingAttempt({ sessionId: "s1", attemptId: "w7", scoreReportId: "score-dedupe" }); release(); await Promise.all([first, second]); assert.equal(calls.length, 1);
  const parallel = fixtures(); const parallelCalls = []; const parallelService = createWritingAiService({ repository: parallel.repository, getCurrentUsername: async () => "alice", getApiKey: async () => "key", callAi: async (detail) => { parallelCalls.push(detail); return { content: JSON.stringify(scoreResponse()) }; } }); await Promise.all([parallelService.scoreWritingAttempt({ sessionId: "s1", attemptId: "w7", scoreReportId: "score-parallel-a" }), parallelService.scoreWritingAttempt({ sessionId: "s1", attemptId: "w7", scoreReportId: "score-parallel-b" })]); assert.equal(parallelCalls.length, 2);
  const stale = fixtures(); let current = "alice"; const staleService = createWritingAiService({ repository: stale.repository, getCurrentUsername: async () => current, getApiKey: async () => "key", callAi: async () => { current = "bob"; return { content: JSON.stringify(scoreResponse()) }; } }); await assert.rejects(() => staleService.scoreWritingAttempt({ sessionId: "s1", attemptId: "w7", scoreReportId: "score-stale" }), (error) => error instanceof WritingAiServiceError && error.code === "stale"); assert.equal(stale.scores.size, 0);
  const changed = fixtures(); const changedService = createWritingAiService({ repository: changed.repository, getCurrentUsername: async () => "alice", getApiKey: async () => "key", callAi: async () => { changed.parent.fingerprint = "changed-parent-fp"; return { content: JSON.stringify(scoreResponse()) }; } }); await assert.rejects(() => changedService.scoreWritingAttempt({ sessionId: "s1", attemptId: "w7", scoreReportId: "score-changed" }), (error) => error instanceof WritingAiServiceError && error.code === "stale"); assert.equal(changed.scores.size, 0);
});
