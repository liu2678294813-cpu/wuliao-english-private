import test from "node:test";
import assert from "node:assert/strict";
import { createBackup, IDB_EXCLUDED_STORES, IDB_INCLUDED } from "../src/backup.js";
import { DEVICE_PRIVATE_WRITING_SAMPLE_STORE, WULIAO_ENGLISH_DB_VERSION } from "../src/storage.js";
import { createWritingCommandService } from "../src/writing/writingCommands.js";
import { WritingStage } from "../src/writing/writingModels.js";
import { getWritingQuestion } from "../src/writing/writingQuestionBank.js";
import {
  createWritingPrivateSamplesService,
  WRITING_PRIVATE_SAMPLE_FORMAT,
  WRITING_PRIVATE_SAMPLE_VERSION,
  WritingPrivateSampleError,
} from "../src/writing/writingPrivateSamples.js";
import { createWritingQuestionSessionService } from "../src/writing/writingQuestionSessions.js";
import { WritingRepository } from "../src/writing/writingRepository.js";

const USERNAME = "alice";
const QUESTION_ID = "postgrad-en1-2023-writing-a";
const PRIVATE_BODY_MARKER = "DEVICE_ONLY_REFERENCE_BODY must never leave this tablet.";
const SOURCE_FINGERPRINT = "9".repeat(64);
const EMPTY_CATALOG = Object.freeze({ catalogSchemaVersion: 1, catalogVersion: "test", contentHash: "", activeQuestionIds: [], retiredQuestionIds: [], retiredSamples: [], items: [] });

function payload(overrides = {}) {
  const question = getWritingQuestion(QUESTION_ID);
  return {
    format: WRITING_PRIVATE_SAMPLE_FORMAT,
    version: WRITING_PRIVATE_SAMPLE_VERSION,
    items: [{
      questionId: question.questionId,
      year: question.year,
      taskType: question.taskType,
      promptFingerprint: question.fingerprint,
      referenceEssay: PRIVATE_BODY_MARKER,
      sourceDocumentFingerprint: SOURCE_FINGERPRINT,
      sourceLabel: "private source document",
      sourceLocator: "verified writing section",
      ...overrides,
    }],
  };
}

function memoryAdapter() {
  const records = new Map();
  return {
    records,
    putRecords: async (items) => { items.forEach((item) => records.set(`${item.username}::${item.questionId}`, structuredClone(item))); },
    getRecord: async (username, questionId) => structuredClone(records.get(`${username}::${questionId}`) || null),
    listRecords: async (username) => [...records.values()].filter((record) => record.username === username).map((record) => structuredClone(record)),
  };
}

function writingRepositoryHarness() {
  const values = new Map();
  const repository = new WritingRepository({
    username: USERNAME,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    listItems: (prefix) => [...values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
  });
  const commands = createWritingCommandService({
    repository,
    getCurrentUsername: () => USERNAME,
    now: () => 123,
    emitLearningInvalidated: async () => {},
  });
  return { repository, commands };
}

test("private corpus imports atomically only after exact question identity validation", async () => {
  const memory = memoryAdapter();
  const service = createWritingPrivateSamplesService({ username: USERNAME, getCurrentUsername: () => USERNAME, catalog: EMPTY_CATALOG, ...memory, now: () => 123 });
  await assert.rejects(
    () => service.importPayload(payload({ promptFingerprint: "0".repeat(64) })),
    (error) => error instanceof WritingPrivateSampleError && error.code === "question-identity-mismatch",
  );
  assert.equal(memory.records.size, 0);
  const result = await service.importPayload(payload());
  assert.deepEqual(result, { importedCount: 1, questionIds: [QUESTION_ID] });
  assert.deepEqual(await service.listAvailableQuestionIds(), [QUESTION_ID]);
});

test("private corpus fails closed when one reference essay is reused for different prompts", async () => {
  const memory = memoryAdapter();
  const service = createWritingPrivateSamplesService({ username: USERNAME, getCurrentUsername: () => USERNAME, catalog: EMPTY_CATALOG, ...memory, now: () => 123 });
  const otherQuestion = getWritingQuestion("postgrad-en1-2023-writing-b");
  const duplicateEssayPayload = payload();
  duplicateEssayPayload.items.push({
    questionId: otherQuestion.questionId,
    year: otherQuestion.year,
    taskType: otherQuestion.taskType,
    promptFingerprint: otherQuestion.fingerprint,
    referenceEssay: PRIVATE_BODY_MARKER,
    sourceDocumentFingerprint: SOURCE_FINGERPRINT,
    sourceLabel: "private source document",
    sourceLocator: "another verified writing section",
  });
  await assert.rejects(
    () => service.importPayload(duplicateEssayPayload),
    (error) => error instanceof WritingPrivateSampleError && error.code === "duplicate-reference-essay",
  );
  assert.equal(memory.records.size, 0);
});

test("runtime snapshot is device-private, whole-document, fingerprinted, and contains no AI lineage", async () => {
  const memory = memoryAdapter();
  const service = createWritingPrivateSamplesService({ username: USERNAME, getCurrentUsername: () => USERNAME, catalog: EMPTY_CATALOG, ...memory, now: () => 123 });
  await service.importPayload(payload());
  const snapshot = await service.getSampleSnapshot(QUESTION_ID);
  assert.equal(snapshot.sourceType, "device_private");
  assert.equal(snapshot.distributionScope, "device_private");
  assert.equal(snapshot.sourceKind, "private_reference");
  assert.equal(snapshot.generatorMetadata, null);
  assert.equal(snapshot.segments.length, 1);
  assert.equal(snapshot.segments[0].text, PRIVATE_BODY_MARKER);
  assert.match(snapshot.fingerprint, /^(?:[0-9a-f]{64}|fnv-[0-9a-f]{8})$/);
});

test("private start bypasses Text AI while preserving the ordinary explicit AI path", async () => {
  const calls = [];
  const question = getWritingQuestion(QUESTION_ID);
  const privateSnapshot = {
    essayId: "device-private:fixed", sourceType: "device_private", distributionScope: "device_private", sourceKind: "private_reference",
    sourceDocumentFingerprint: SOURCE_FINGERPRINT, text: PRIVATE_BODY_MARKER, wordCount: 8,
    segments: [{ unitId: `private:${QUESTION_ID}:document`, text: PRIVATE_BODY_MARKER }], qualityStatus: "passed",
    qualityGateVersion: "device-private-import-v1", qualityReportFingerprint: "8".repeat(64), generatorMetadata: null,
  };
  const service = createWritingQuestionSessionService({
    getCurrentUsername: () => USERNAME,
    createId: (prefix) => `${prefix}:fixed`,
    privateSamples: { getSampleSnapshot: async (questionId) => { calls.push(["private", questionId]); return privateSnapshot; } },
    textAi: { getConfigurationStatus: async () => { calls.push(["preflight"]); }, generateSample: async () => { calls.push(["ai"]); } },
    commands: { startWritingSession: async (args) => { calls.push(["session", args]); return { session: { sessionId: args.sessionId } }; } },
  });
  await service.startQuestionTraining(question.questionId, { sampleSource: "device_private" });
  assert.deepEqual(calls.map(([name]) => name), ["private", "session"]);
  assert.equal(calls[1][1].sampleEssaySnapshot.sourceType, "device_private");
  assert.equal(calls[1][1].sampleEssaySnapshot.generatorMetadata, null);
});

test("private start persists a valid W1 Session through the real repository contract", async () => {
  const { repository, commands } = writingRepositoryHarness();
  const textAiCalls = [];
  const privateSnapshot = {
    essayId: "device-private:integration", sourceType: "device_private", distributionScope: "device_private", sourceKind: "private_reference",
    sourceDocumentFingerprint: SOURCE_FINGERPRINT, text: "PRIVATE_SAMPLE_ALPHA", wordCount: 2,
    segments: [{ unitId: "private:integration:document", text: "PRIVATE_SAMPLE_ALPHA" }], qualityStatus: "passed",
    qualityGateVersion: "device-private-import-v1", qualityReportFingerprint: "8".repeat(64), generatorMetadata: null,
  };
  const service = createWritingQuestionSessionService({
    commands,
    getCurrentUsername: () => USERNAME,
    createId: (prefix) => `${prefix}:integration`,
    privateSamples: { getSampleSnapshot: async () => privateSnapshot },
    textAi: {
      getConfigurationStatus: async () => { textAiCalls.push("preflight"); },
      generateSample: async () => { textAiCalls.push("generate"); },
    },
  });

  const result = await service.startQuestionTraining(QUESTION_ID, { sampleSource: "device_private" });
  const saved = await repository.readSession(result.session.sessionId);

  assert.deepEqual(textAiCalls, []);
  assert.equal(saved.currentStage, WritingStage.W1_SAMPLE_READING);
  assert.equal(saved.sampleEssaySnapshot.sourceType, "device_private");
  assert.equal(saved.sampleEssaySnapshot.generatorMetadata, null);
  assert.match(saved.sampleEssaySnapshot.fingerprint, /^(?:[0-9a-f]{64}|fnv-[0-9a-f]{8})$/);
});

test("AI start still derives object generatorMetadata from existing lineage fields", async () => {
  const question = getWritingQuestion(QUESTION_ID);
  let captured;
  const aiSnapshot = {
    essayId: "ai-sample:fixed", sourceType: "ai_generated", text: "PRIVATE_SAMPLE_BETA", wordCount: 2,
    segments: [{ unitId: "ai:fixed:document", text: "PRIVATE_SAMPLE_BETA" }], qualityStatus: "passed",
    qualityGateVersion: "sample-quality-v1", qualityReportFingerprint: "7".repeat(64),
    generatorProvider: "test-provider", generatorModelId: "test-model", criticProvider: "test-critic", criticModelId: "test-critic-model",
    generatorPromptVersion: "generator-v1", criticPromptVersion: "critic-v1",
  };
  const service = createWritingQuestionSessionService({
    getCurrentUsername: () => USERNAME,
    createId: (prefix) => `${prefix}:ai`,
    textAi: {
      getConfigurationStatus: async () => ({ apiKeyConfigured: true, baseUrlConfigured: true, modelConfigured: true }),
      generateSample: async () => ({ status: "accepted", sampleEssaySnapshot: aiSnapshot }),
    },
    commands: { startWritingSession: async (args) => { captured = args; return { session: { sessionId: args.sessionId } }; } },
  });

  await service.startQuestionTraining(question.questionId, { sampleSource: "ai_generated" });

  assert.deepEqual(captured.sampleEssaySnapshot.generatorMetadata, {
    provider: "test-provider",
    modelId: "test-model",
    criticProvider: "test-critic",
    criticModelId: "test-critic-model",
    generatorPromptVersion: "generator-v1",
    criticPromptVersion: "critic-v1",
  });
});

test("private store and private-session data are absent from app and Android backup surfaces", async () => {
  assert.ok(WULIAO_ENGLISH_DB_VERSION >= 6);
  assert.equal(IDB_INCLUDED["wuliao-english"][DEVICE_PRIVATE_WRITING_SAMPLE_STORE], undefined);
  assert.ok(IDB_EXCLUDED_STORES["wuliao-english"].includes(DEVICE_PRIVATE_WRITING_SAMPLE_STORE));
  const prefix = `wuliao:user:${encodeURIComponent(USERNAME)}:`;
  const privateSession = { sessionId: "private-session", username: USERNAME, sampleEssaySnapshot: { sourceType: "device_private", text: PRIVATE_BODY_MARKER } };
  const ordinarySession = { sessionId: "ordinary-session", username: USERNAME, sampleEssaySnapshot: { sourceType: "ai_generated", text: "ordinary sample" } };
  const result = await createBackup({
    username: USERNAME,
    sources: {
      entries: [
        { key: `${prefix}wuliao:writing-session:v1:private-session`, value: JSON.stringify(privateSession) },
        { key: `${prefix}wuliao:writing-attempt:v1:private-attempt`, value: JSON.stringify({ sessionId: "private-session", typedText: "private user draft" }) },
        { key: `${prefix}wuliao:writing-session:v1:ordinary-session`, value: JSON.stringify(ordinarySession) },
      ],
      databases: [{ name: "wuliao-english", stores: [
        { name: DEVICE_PRIVATE_WRITING_SAMPLE_STORE, records: [{ key: "private", value: { username: USERNAME, referenceEssay: PRIVATE_BODY_MARKER } }] },
        { name: "writing-ink", records: [{ key: "private-ink", value: { username: USERNAME, sessionId: "private-session" } }, { key: "ordinary-ink", value: { username: USERNAME, sessionId: "ordinary-session" } }] },
        { name: "unknown-words", records: [{ key: "private-word", value: { username: USERNAME, sessionId: "private-session", word: "private-token" } }, { key: "ordinary-word", value: { username: USERNAME, sessionId: "ordinary-session", word: "ordinary-token" } }] },
      ] }],
    },
  });
  assert.doesNotMatch(result.fileText, new RegExp(PRIVATE_BODY_MARKER));
  assert.doesNotMatch(result.fileText, /private-session|private-attempt|private-ink|private-token/);
  assert.match(result.fileText, /ordinary-session|ordinary-ink|ordinary-token/);
});
