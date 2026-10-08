import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { computeWritingFingerprint } from "../src/writing/writingRepository.js";
import { GENERATED_WRITING_QUESTIONS } from "../src/writing/questions/generatedWritingQuestionData.js";
import {
  getWritingQuestion,
  listWritingQuestionYears,
  listWritingQuestions,
  listWritingQuestionsByYear,
  promptSnapshotForWritingQuestion,
} from "../src/writing/writingQuestionBank.js";
import { createWritingQuestionSessionService, WritingQuestionSessionError } from "../src/writing/writingQuestionSessions.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const questions = listWritingQuestions();
const audit = JSON.parse(await readFile(path.join(repositoryRoot, "scripts/fixtures/writing-question-bank-coverage.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function walkKeys(value, result = []) {
  if (!value || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    result.push(key);
    walkKeys(child, result);
  }
  return result;
}

test("source coverage accounts for every year and every official writing task", () => {
  assert.deepEqual(listWritingQuestionYears(), Array.from({ length: 23 }, (_, index) => 2023 - index));
  assert.equal(questions.length, 42);
  assert.equal(questions.filter((question) => question.taskType.endsWith("-a")).length, 19);
  assert.equal(questions.filter((question) => question.taskType.endsWith("-b")).length, 23);
  assert.deepEqual(audit.summary, {
    yearsCovered: 23, officialQuestionCount: 42, writingACount: 19, writingBCount: 23,
    visualAssetCount: 23, unmappedCount: 0, missingCount: 0,
  });
  assert.equal(audit.coverage.filter((year) => year.absentParts.some((entry) => entry.part === "A" && entry.reason === "NOT_PRESENT_IN_SOURCE")).length, 4);
  assert.deepEqual(audit.coverage.slice(0, 4).map((entry) => entry.year), [2001, 2002, 2003, 2004]);
});

test("records have stable unique identities, verified fingerprints, and deterministic newest-first order", async () => {
  assert.equal(new Set(questions.map((question) => question.questionId)).size, questions.length);
  assert.equal(new Set(questions.map((question) => question.fingerprint)).size, questions.length);
  assert.deepEqual(questions.map((question) => question.year), [...questions.map((question) => question.year)].sort((left, right) => right - left));
  for (const question of questions) {
    assert.match(question.questionId, /^postgrad-en1-20\d{2}-writing-[ab]$/);
    const { fingerprint, requiredContentPoints: _requiredContentPoints, ...snapshot } = question;
    assert.equal(await computeWritingFingerprint(snapshot), fingerprint);
    assert.equal(question.source.sourceYear, question.year);
    assert.match(question.source.sourceFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(question.source.sourceFileName, `${question.year}年真题及答案速查.pdf`);
    assert.ok(Number.isInteger(question.source.sourcePage));
  }
});

test("all visual assets are local, non-base64, source-fingerprinted files", async () => {
  const assets = questions.flatMap((question) => question.assets.map((asset) => ({ question, asset })));
  assert.equal(assets.length, 23);
  assert.equal(new Set(assets.map(({ asset }) => asset.src)).size, 23);
  assert.equal(new Set(assets.map(({ asset }) => asset.fingerprint)).size, 23);
  for (const { question, asset } of assets) {
    assert.match(asset.src, /^\/writing\/questions\/20\d{2}\/.+\.png$/);
    assert.doesNotMatch(asset.src, /^(?:data:|https?:|file:)/i);
    const bytes = await readFile(path.join(repositoryRoot, "public", ...asset.src.split("/").filter(Boolean)));
    assert.equal(hash(bytes), asset.fingerprint);
    assert.equal(question.source.sourceAssetFingerprint, asset.fingerprint);
    assert.ok(asset.alt.includes(String(question.year)));
  }
});

test("runtime question data contains no answer/sample payload or machine-specific source path", () => {
  const forbiddenKeys = new Set(["answer", "answers", "answerKey", "sampleEssay", "sampleEssaySnapshot", "referenceAnswer", "analysis"]);
  assert.deepEqual(walkKeys(questions).filter((key) => forbiddenKeys.has(key)), []);
  const serialized = JSON.stringify(questions);
  assert.doesNotMatch(serialized, /[A-Z]:\\|file:\/\/|data:[^,]*;base64|https?:\/\//i);
  assert.equal(audit.scope.answerMaterialImported, false);
});

test("read API is immutable and deterministic without I/O", () => {
  assert.equal(getWritingQuestion("postgrad-en1-2023-writing-a")?.year, 2023);
  assert.equal(getWritingQuestion("missing"), null);
  assert.deepEqual(listWritingQuestionsByYear(2001).map((question) => question.questionId), ["postgrad-en1-2001-writing-b"]);
  assert.ok(Object.isFrozen(questions));
  assert.ok(Object.isFrozen(questions[0].assets));
  assert.throws(() => { questions[0].year = 1999; }, TypeError);
  const snapshot = promptSnapshotForWritingQuestion("postgrad-en1-2023-writing-b");
  assert.ok(Object.isFrozen(snapshot));
  assert.equal("requiredContentPoints" in snapshot, false);
});

test("a frozen Session prompt remains unchanged when bundled bank source data changes", () => {
  const frozenSessionPrompt = structuredClone(promptSnapshotForWritingQuestion("postgrad-en1-2023-writing-b"));
  const originalFingerprint = frozenSessionPrompt.fingerprint;
  const generated = GENERATED_WRITING_QUESTIONS.find((question) => question.questionId === frozenSessionPrompt.questionId);
  const originalPromptText = generated.promptText;
  try {
    generated.promptText = "simulated future bank correction";
    assert.equal(frozenSessionPrompt.promptText, originalPromptText);
    assert.equal(frozenSessionPrompt.fingerprint, originalFingerprint);
  } finally {
    generated.promptText = originalPromptText;
  }
});

function acceptedSample() {
  return {
    status: "accepted",
    sampleEssaySnapshot: {
      essayId: "sample-1", sourceType: "ai_generated", text: "A fully checked sample.", wordCount: 4,
      segments: [{ unitId: "u1", text: "A fully checked sample." }], qualityStatus: "passed",
      qualityGateVersion: "gate-v1", qualityReportFingerprint: "a".repeat(64),
      generatorProvider: "test", generatorModelId: "test-model", criticProvider: "test", criticModelId: "test-model",
    },
  };
}

test("explicit start freezes the selected question only after an accepted sample", async () => {
  const calls = [];
  const service = createWritingQuestionSessionService({
    getCurrentUsername: () => "alice",
    createId: (prefix) => `${prefix}:fixed`,
    textAi: { generateSample: async (args) => { calls.push(["ai", args]); return acceptedSample(); } },
    commands: { startWritingSession: async (args) => { calls.push(["session", args]); return { session: { sessionId: args.sessionId } }; } },
  });
  const result = await service.startQuestionTraining("postgrad-en1-2023-writing-b");
  assert.equal(result.session.sessionId, "writing-session:fixed");
  assert.deepEqual(calls.map(([name]) => name), ["ai", "session"]);
  assert.equal(calls[0][1].promptSnapshot.questionId, "postgrad-en1-2023-writing-b");
  assert.equal(calls[1][1].promptSnapshot.fingerprint, calls[0][1].promptSnapshot.fingerprint);
  assert.equal(await computeWritingFingerprint({ ...calls[1][1].sampleEssaySnapshot, fingerprint: undefined }), calls[1][1].sampleEssaySnapshot.fingerprint);
});

test("AI rejection or provider failure creates no Session and remains retryable", async () => {
  for (const outcome of [async () => ({ status: "generation_failed" }), async () => { throw new Error("offline"); }]) {
    let sessionWrites = 0;
    const service = createWritingQuestionSessionService({
      getCurrentUsername: () => "alice", createId: (prefix) => `${prefix}:fixed`,
      textAi: { generateSample: outcome },
      commands: { startWritingSession: async () => { sessionWrites += 1; } },
    });
    await assert.rejects(() => service.startQuestionTraining("postgrad-en1-2023-writing-a"), WritingQuestionSessionError);
    assert.equal(sessionWrites, 0);
    assert.ok(getWritingQuestion("postgrad-en1-2023-writing-a"), "question stays available for retry");
  }
});

test("Text AI preflight blocks locally with zero provider and Session calls", async () => {
  let providerCalls = 0;
  let sessionWrites = 0;
  const service = createWritingQuestionSessionService({
    getCurrentUsername: () => "alice",
    textAi: {
      getConfigurationStatus: async () => ({
        apiKeyConfigured: false,
        baseUrlConfigured: true,
        modelConfigured: true,
      }),
      generateSample: async () => { providerCalls += 1; },
    },
    commands: { startWritingSession: async () => { sessionWrites += 1; } },
  });
  await assert.rejects(
    () => service.startQuestionTraining("postgrad-en1-2023-writing-a"),
    (error) => error instanceof WritingQuestionSessionError
      && error.code === "text_ai_not_configured"
      && /请先配置文本 AI/.test(error.message),
  );
  assert.equal(providerCalls, 0);
  assert.equal(sessionWrites, 0);
});

test("Text AI provider and quality failures retain precise user-safe categories with no partial Session", async () => {
  const cases = [
    ["auth_error", "文本 AI 认证失败，请检查 API Key"],
    ["model_unavailable", "当前文本模型不可用，请检查 Model ID"],
    ["rate_limit", "服务请求频率受限，请稍后重试"],
    ["network_error", "无法连接文本 AI 服务"],
    ["timeout", "文本 AI 请求超时，请重试"],
    ["provider_error", "文本 AI 服务暂时异常"],
    ["invalid_response", "文本 AI 返回内容无法验证，请重试"],
  ];
  for (const [code, message] of cases) {
    let sessionWrites = 0;
    const cause = Object.assign(new Error("raw provider detail must not reach UI"), { code });
    const service = createWritingQuestionSessionService({
      getCurrentUsername: () => "alice",
      textAi: {
        getConfigurationStatus: async () => ({ apiKeyConfigured: true, baseUrlConfigured: true, modelConfigured: true }),
        generateSample: async () => { throw cause; },
      },
      commands: { startWritingSession: async () => { sessionWrites += 1; } },
    });
    await assert.rejects(
      () => service.startQuestionTraining("postgrad-en1-2023-writing-a"),
      (error) => error instanceof WritingQuestionSessionError
        && error.code === code
        && error.message === message,
    );
    assert.equal(sessionWrites, 0, `${code} must not create a partial Session`);
  }

  let qualitySessionWrites = 0;
  const qualityService = createWritingQuestionSessionService({
    getCurrentUsername: () => "alice",
    textAi: {
      getConfigurationStatus: async () => ({ apiKeyConfigured: true, baseUrlConfigured: true, modelConfigured: true }),
      generateSample: async () => ({ status: "generation_failed" }),
    },
    commands: { startWritingSession: async () => { qualitySessionWrites += 1; } },
  });
  await assert.rejects(
    () => qualityService.startQuestionTraining("postgrad-en1-2023-writing-a"),
    (error) => error instanceof WritingQuestionSessionError
      && error.code === "quality_gate_exhausted"
      && error.message === "本次未生成达到训练标准的范文，请重试。",
  );
  assert.equal(qualitySessionWrites, 0);
});
