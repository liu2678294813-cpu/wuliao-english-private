import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createBundledWritingSampleCatalog,
  serializeBundledWritingSampleCatalog,
  WRITING_SAMPLE_GENERATED_PATH,
} from "./build-writing-sample-catalog.mjs";
import { BUNDLED_WRITING_SAMPLE_CATALOG } from "../src/writing/generatedWritingSampleCatalog.js";
import {
  createWritingPrivateSamplesService,
  WRITING_BUNDLED_SAMPLE_SOURCE_TYPE,
  WRITING_PRIVATE_SAMPLE_SOURCE_TYPE,
} from "../src/writing/writingPrivateSamples.js";
import { createWritingQuestionSessionService, WritingSampleSource } from "../src/writing/writingQuestionSessions.js";
import { computeWritingFingerprint } from "../src/writing/writingRepository.js";
import { getWritingQuestion } from "../src/writing/writingQuestionBank.js";

const USERNAME = "bundled-catalog-user";

function memoryService(catalog = BUNDLED_WRITING_SAMPLE_CATALOG) {
  const records = new Map();
  const service = createWritingPrivateSamplesService({
    username: USERNAME,
    getCurrentUsername: () => USERNAME,
    catalog,
    now: () => 1,
    putRecords: async (items) => items.forEach((item) => records.set(item.questionId, structuredClone(item))),
    getRecord: async (_username, questionId) => structuredClone(records.get(questionId) || null),
    listRecords: async () => [...records.values()].map((record) => structuredClone(record)),
  });
  return { service, records };
}

function importPayload(item, referenceEssay = item.referenceEssay) {
  return {
    format: "wuliao-writing-private-samples",
    version: 1,
    items: [{
      questionId: item.questionId,
      year: item.year,
      taskType: item.taskType,
      promptFingerprint: item.promptFingerprint,
      referenceEssay,
      sourceDocumentFingerprint: item.sourceFingerprint,
      sourceLabel: item.sourceLabel,
      sourceLocator: item.sourceLocator,
    }],
  };
}

function catalogWithout(item, { retire = true } = {}) {
  const retiredSamples = retire ? [{
    questionId: item.questionId,
    promptFingerprint: item.promptFingerprint,
    referenceEssayFingerprint: item.referenceEssayFingerprint,
    sourceFingerprint: item.sourceFingerprint,
  }] : [];
  const items = BUNDLED_WRITING_SAMPLE_CATALOG.items.filter((candidate) => candidate.questionId !== item.questionId);
  return {
    ...BUNDLED_WRITING_SAMPLE_CATALOG,
    catalogVersion: "test-retirement",
    activeQuestionIds: items.map((candidate) => candidate.questionId),
    retiredQuestionIds: retiredSamples.map((candidate) => candidate.questionId),
    retiredSamples,
    items,
  };
}

test("canonical source generates the checked-in catalog byte for byte", async () => {
  const catalog = await createBundledWritingSampleCatalog();
  const generated = await readFile(WRITING_SAMPLE_GENERATED_PATH, "utf8");
  assert.equal(generated, serializeBundledWritingSampleCatalog(catalog));
  assert.equal(catalog.contentHash, BUNDLED_WRITING_SAMPLE_CATALOG.contentHash);
});

test("bundled catalog is complete, question-aligned, non-empty, and duplicate-free", async () => {
  const catalog = BUNDLED_WRITING_SAMPLE_CATALOG;
  assert.equal(catalog.catalogSchemaVersion, 1);
  assert.equal(catalog.items.length, 34);
  assert.deepEqual([...new Set(catalog.items.map((item) => item.year))].sort(), Array.from({ length: 17 }, (_, index) => 2007 + index));
  assert.equal(catalog.items.filter((item) => item.taskType.endsWith("-a")).length, 17);
  assert.equal(catalog.items.filter((item) => item.taskType.endsWith("-b")).length, 17);
  const essays = new Set();
  for (const item of catalog.items) {
    const question = getWritingQuestion(item.questionId);
    assert.ok(question);
    assert.equal(item.year, question.year);
    assert.equal(item.taskType, question.taskType);
    assert.equal(item.promptFingerprint, question.fingerprint);
    assert.ok(item.referenceEssay.trim());
    assert.equal(item.referenceEssayFingerprint, await computeWritingFingerprint({ referenceEssay: item.referenceEssay }));
    assert.ok(!essays.has(item.referenceEssayFingerprint), item.questionId);
    essays.add(item.referenceEssayFingerprint);
  }
});

test("a clean offline account discovers all APK samples without a pending Android seed", async () => {
  const { service } = memoryService();
  assert.deepEqual(await service.consumePendingAndroidSeed(), { status: "unavailable", importedCount: 0 });
  const available = await service.listAvailableSamples();
  assert.equal(available.length, 34);
  assert.ok(available.every((item) => item.sourceType === WRITING_BUNDLED_SAMPLE_SOURCE_TYPE));
  const snapshot = await service.getSampleSnapshot("postgrad-en1-2023-writing-a", { sourceType: WRITING_BUNDLED_SAMPLE_SOURCE_TYPE });
  assert.equal(snapshot.sourceType, WRITING_BUNDLED_SAMPLE_SOURCE_TYPE);
  assert.equal(snapshot.catalogContentHash, BUNDLED_WRITING_SAMPLE_CATALOG.contentHash);
  assert.equal(snapshot.segments[0].text, snapshot.text);
});

test("starting from the APK catalog freezes a complete SampleEssaySnapshot and never calls Text AI", async () => {
  const { service } = memoryService();
  let started = null;
  const sessions = createWritingQuestionSessionService({
    privateSamples: service,
    getCurrentUsername: () => USERNAME,
    createId: (prefix) => `${prefix}:bundle-test`,
    textAi: { getConfigurationStatus: () => { throw new Error("Text AI must not run"); }, generateSample: () => { throw new Error("Text AI must not run"); } },
    commands: { startWritingSession: async (args) => { started = structuredClone(args); return { session: { sessionId: args.sessionId } }; } },
  });
  await sessions.startQuestionTraining("postgrad-en1-2023-writing-a", { sampleSource: WritingSampleSource.APK_BUNDLE });
  assert.equal(started.sampleEssaySnapshot.sourceType, WRITING_BUNDLED_SAMPLE_SOURCE_TYPE);
  assert.ok(started.sampleEssaySnapshot.text.length > 0);
  assert.equal(started.sampleEssaySnapshot.segments[0].text, started.sampleEssaySnapshot.text);
  assert.equal(started.sampleEssaySnapshot.fingerprint, await computeWritingFingerprint(started.sampleEssaySnapshot));
});

test("catalog retirement hides new training while an existing frozen snapshot remains readable", async () => {
  const item = BUNDLED_WRITING_SAMPLE_CATALOG.items[0];
  const active = memoryService();
  const frozen = await active.service.getSampleSnapshot(item.questionId, { sourceType: WRITING_BUNDLED_SAMPLE_SOURCE_TYPE });
  const retired = memoryService(catalogWithout(item));
  assert.ok(!(await retired.service.listAvailableQuestionIds()).includes(item.questionId));
  await assert.rejects(() => retired.service.getSampleSnapshot(item.questionId, { sourceType: WRITING_BUNDLED_SAMPLE_SOURCE_TYPE }), /不在当前 APK 范文目录/);
  assert.equal(frozen.text, item.referenceEssay);
  assert.equal(frozen.fingerprint, await computeWritingFingerprint(frozen));
});

test("a stale legacy copy cannot bypass retirement, but a different private import is preserved", async () => {
  const item = BUNDLED_WRITING_SAMPLE_CATALOG.items[0];
  const retired = memoryService(catalogWithout(item));
  await retired.service.importPayload(importPayload(item));
  assert.ok(!(await retired.service.listAvailableQuestionIds()).includes(item.questionId));

  const privateOnly = memoryService(catalogWithout(item));
  await privateOnly.service.importPayload(importPayload(item, `${item.referenceEssay}\n\nPrivate editorial note.`));
  const available = await privateOnly.service.listAvailableSamples();
  assert.deepEqual(available.find((candidate) => candidate.questionId === item.questionId), {
    questionId: item.questionId,
    sourceType: WRITING_PRIVATE_SAMPLE_SOURCE_TYPE,
  });
  assert.equal(privateOnly.records.size, 1, "catalog filtering must not delete the private record");
});

test("an active legacy record with a different fingerprint fails closed instead of overriding the bundle", async () => {
  const item = BUNDLED_WRITING_SAMPLE_CATALOG.items[0];
  const local = memoryService();
  await local.service.importPayload(importPayload(item, `${item.referenceEssay}\n\nConflicting legacy content.`));
  assert.ok(!(await local.service.listAvailableQuestionIds()).includes(item.questionId));
  await assert.rejects(
    () => local.service.getSampleSnapshot(item.questionId, { sourceType: WRITING_BUNDLED_SAMPLE_SOURCE_TYPE }),
    (error) => error?.code === "bundled-private-conflict",
  );
});
