import test from "node:test";
import assert from "node:assert/strict";
import { computeWritingFingerprint } from "../src/writing/writingRepository.js";
import { WritingAttemptStatus, WritingAttemptType, WritingInputMethod, WritingStage } from "../src/writing/writingModels.js";
import { createWritingVisionService, WritingVisionServiceError } from "../src/writing/writingVisionService.js";

const NOW = 1_800_000_000_000;
const CONFIG = Object.freeze({ providerKind: "openai-compatible", baseUrl: "https://vision.example/v1", transportVersion: "writing-vision-openai-v1" });

function stroke(pageId) { return { coordinateSpace: "writing-page-v1", writingAnchor: { version: 1, pageId }, tool: "pen", points: [{ writingLocal: { x: 0.1, y: 0.2 } }] }; }
function inkRef(attemptId, stageId, revision = 1) { const prefix = stageId === WritingStage.W3_BACK_TRANSLATION ? "w3:back" : "w7:independent"; return { id: `alice::s1::${prefix}:${attemptId}`, surfaceId: `${prefix}:${attemptId}`, ownerRecordId: attemptId, stageId, revision, fingerprint: `ink-fp-${attemptId}-${revision}`, sourceFingerprint: `source-fp-${attemptId}`, updatedAt: NOW }; }
function attempt(id = "w7", stageId = WritingStage.W7_INDEPENDENT) { const type = stageId === WritingStage.W3_BACK_TRANSLATION ? WritingAttemptType.BACK_TRANSLATION : WritingAttemptType.INDEPENDENT; return { schemaVersion: 1, attemptId: id, username: "alice", sessionId: "s1", fingerprint: `${id}-attempt-fp`, attemptType: type, stageId, status: WritingAttemptStatus.RAW_SUBMITTED, inputMethod: WritingInputMethod.HANDWRITING, inkRef: inkRef(id, stageId), transcriptionId: null, verifiedText: null, context: type === WritingAttemptType.BACK_TRANSLATION ? { translationSnapshotId: "t1" } : { promptFingerprint: "prompt-fp" }, rawSubmittedAt: NOW, submittedAt: null } ; }
function session() { return { schemaVersion: 1, sessionId: "s1", username: "alice", fingerprint: "session-fp", currentStage: WritingStage.W7_INDEPENDENT }; }
function snapshotFor(sourceAttempt) { return { schemaVersion: 1, username: "alice", sessionId: "s1", ...sourceAttempt.inkRef, strokes: [stroke("page-2"), stroke("page-1")] }; }
function resultFor(sourceInk) { void sourceInk; return { pageOrder: ["page-1", "page-2"], pages: [{ pageId: "page-1", text: "I has", segments: [{ text: "I has", confidence: 0.8, unsure: false }] }, { pageId: "page-2", text: "a apple.", segments: [{ text: "a apple.", confidence: null, unsure: true }] }], rawTranscript: "I has\n\na apple.", promptVersion: "writing-transcription-v1", adapterVersion: "writing-vision-openai-v1", renderVersion: "writing-vision-render-v1" }; }

function harness({ attempts: suppliedAttempts = [attempt()], transcribe = null } = {}) {
  let currentUsername = "alice"; let config = { ...CONFIG }; let modelId = "vision-model"; let apiKey = "vision-key"; let providerCalls = 0;
  const currentSession = session(); const attempts = new Map(suppliedAttempts.map((row) => [row.attemptId, row])); const inks = new Map(suppliedAttempts.map((row) => [row.attemptId, snapshotFor(row)])); const transcriptions = new Map();
  const repository = {
    username: "alice",
    readSession: async () => structuredClone(currentSession),
    readAttempt: async (id) => attempts.has(id) ? structuredClone(attempts.get(id)) : null,
    readTranscription: async (id) => transcriptions.has(id) ? structuredClone(transcriptions.get(id)) : null,
    listTranscriptions: async () => [...transcriptions.values()].map((row) => structuredClone(row)),
    createTranscription: async (candidate) => { const saved = { ...structuredClone(candidate), fingerprint: await computeWritingFingerprint(candidate) }; transcriptions.set(saved.transcriptionId, saved); return structuredClone(saved); },
  };
  const getInkSnapshot = async ({ surfaceId }) => { const row = [...inks.values()].find((item) => item.surfaceId === surfaceId); return row ? { status: "ok", snapshot: structuredClone(row) } : { status: "missing", snapshot: null }; };
  const transcribeSnapshot = async (detail) => { providerCalls += 1; return transcribe ? transcribe(detail, api) : resultFor(detail.snapshot); };
  const api = {
    repository, attempts, inks, transcriptions, currentSession,
    get providerCalls() { return providerCalls; },
    setUsername: (value) => { currentUsername = value; },
    setConfig: (value) => { config = { ...config, ...value }; },
    setModel: (value) => { modelId = value; },
    setApiKey: (value) => { apiKey = value; },
  };
  api.service = createWritingVisionService({ repository, getCurrentUsername: () => currentUsername, getInkSnapshot, getConfig: () => ({ ...config }), getModel: () => modelId, getApiKey: async () => apiKey, provider: {}, transcribeSnapshot, now: () => NOW });
  return api;
}

test("Formal Vision Service persists exact Attempt→Ink lineage and no user confirmation", async () => {
  const h = harness(); const beforeSession = structuredClone(h.currentSession); const beforeAttempt = structuredClone(h.attempts.get("w7"));
  const saved = await h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: "tr-1" });
  assert.equal(saved.sourceAttemptId, "w7"); assert.deepEqual(saved.sourceInkRef, beforeAttempt.inkRef); assert.equal(saved.sourceInkFingerprint, beforeAttempt.inkRef.fingerprint); assert.equal(saved.provider, "openai-compatible"); assert.equal(saved.modelId, "vision-model");
  assert.equal(saved.promptVersion, "writing-transcription-v1"); assert.equal(saved.adapterVersion, "writing-vision-openai-v1"); assert.equal(saved.requestMetadata.renderVersion, "writing-vision-render-v1"); assert.deepEqual(saved.requestMetadata.pageOrder, ["page-1", "page-2"]); assert.equal(saved.rawTranscript, "I has\n\na apple.");
  const persisted = JSON.stringify(saved); for (const forbidden of ["data:image", "base64", "Authorization", "apiKey", "score", "rewrite", "advice"]) assert.equal(persisted.includes(forbidden), false);
  assert.deepEqual(h.currentSession, beforeSession); assert.deepEqual(h.attempts.get("w7"), beforeAttempt); assert.equal(h.attempts.get("w7").verifiedText, null);
});

test("Formal Vision Service rejects missing config without Text-key fallback", async () => {
  for (const missing of ["baseUrl", "model", "key"]) { const h = harness(); if (missing === "baseUrl") h.setConfig({ baseUrl: "" }); if (missing === "model") h.setModel(""); if (missing === "key") h.setApiKey(""); await assert.rejects(() => h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: `tr-${missing}` }), (error) => error instanceof WritingVisionServiceError && error.code === "vision_not_configured"); assert.equal(h.providerCalls, 0); }
});

test("Exact InkRef fence rejects id/surface/owner/stage/revision/fingerprint/source mismatch", async () => {
  for (const field of ["id", "surfaceId", "ownerRecordId", "stageId", "revision", "fingerprint", "sourceFingerprint"]) {
    const h = harness(); const ink = h.inks.get("w7"); ink[field] = field === "revision" ? 2 : `wrong-${field}`;
    await assert.rejects(() => h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: `tr-${field}` }), (error) => error.code === "source_mismatch"); assert.equal(h.providerCalls, 0);
  }
});

test("Settle fence drops Ink/Attempt/Session/account/model/baseUrl/provider changes", async () => {
  const mutations = {
    inkRevision: (h) => { h.inks.get("w7").revision += 1; }, inkFingerprint: (h) => { h.inks.get("w7").fingerprint = "changed"; }, attempt: (h) => { h.attempts.get("w7").fingerprint = "changed"; }, session: (h) => { h.currentSession.fingerprint = "changed"; }, account: (h) => h.setUsername("bob"), model: (h) => h.setModel("model-b"), baseUrl: (h) => h.setConfig({ baseUrl: "https://other.example/v1" }), provider: (h) => h.setConfig({ providerKind: "other" }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const h = harness({ transcribe: async (_detail, api) => { mutate(api); return resultFor(); } });
    await assert.rejects(() => h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: `tr-${name}` }), (error) => error.code === "stale"); assert.equal(h.transcriptions.size, 0);
  }
});

test("Exact completed tuple reuses immutable TranscriptionRecord without provider cost", async () => {
  const h = harness(); const first = await h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: "tr-first" }); h.attempts.get("w7").status = WritingAttemptStatus.VERIFYING; h.attempts.get("w7").transcriptionId = first.transcriptionId; h.attempts.get("w7").fingerprint = "verifying-attempt-fp"; const second = await h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: "tr-second" });
  assert.equal(second.transcriptionId, first.transcriptionId); assert.equal(h.providerCalls, 1); assert.equal(h.transcriptions.size, 1);
  h.setModel("vision-model-b"); const third = await h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: "tr-third" }); assert.equal(third.transcriptionId, "tr-third"); assert.equal(h.providerCalls, 2); assert.equal(h.transcriptions.size, 2);
});

test("Duplicate exact in-flight requests share one provider call; different Attempts run independently", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; }); const w3 = attempt("w3", WritingStage.W3_BACK_TRANSLATION); const h = harness({ attempts: [attempt(), w3], transcribe: async (detail) => { await gate; return resultFor(detail.snapshot); } });
  const a = h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: "tr-a" }); const b = h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: "tr-a" }); await Promise.resolve(); await Promise.resolve(); release(); const [first, second] = await Promise.all([a, b]); assert.equal(first.fingerprint, second.fingerprint); assert.equal(h.providerCalls, 1);
  await Promise.all([h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: "tr-w7-new" }), h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w3", transcriptionId: "tr-w3" })]); assert.equal(h.providerCalls, 2);
});

test("Partial page/provider failure creates no formal record and preserves all user facts", async () => {
  const h = harness({ transcribe: async () => { throw Object.assign(new Error("page-2 failed"), { code: "network_error" }); } }); const beforeSession = structuredClone(h.currentSession); const beforeAttempt = structuredClone(h.attempts.get("w7")); const beforeInk = structuredClone(h.inks.get("w7"));
  await assert.rejects(() => h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: "tr-fail" }), (error) => error.code === "network_error"); assert.equal(h.transcriptions.size, 0); assert.deepEqual(h.currentSession, beforeSession); assert.deepEqual(h.attempts.get("w7"), beforeAttempt); assert.deepEqual(h.inks.get("w7"), beforeInk);
});

test("Vision Service preserves auth/rate/network/timeout/provider/unsupported/invalid/abort semantics", async () => {
  for (const code of ["auth_error", "rate_limit", "network_error", "timeout", "provider_error", "unsupported", "invalid_response"]) { const h = harness({ transcribe: async () => { throw Object.assign(new Error(code), { code }); } }); await assert.rejects(() => h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: `tr-${code}` }), (error) => error.code === code); assert.equal(h.transcriptions.size, 0); }
  const controller = new AbortController(); const h = harness({ transcribe: async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); } }); await assert.rejects(() => h.service.transcribeWritingAttempt({ sessionId: "s1", attemptId: "w7", transcriptionId: "tr-abort", signal: controller.signal }), (error) => error.code === "abort"); assert.equal(h.transcriptions.size, 0);
});
