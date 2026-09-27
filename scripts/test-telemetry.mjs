import test from "node:test";
import assert from "node:assert/strict";

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    _store: store,
  };
}

function createTelemetryWith(storage) {
  return createTelemetry({ storage, schedule: (fn) => { fn(); return null; }, cancel: () => {} });
}

const { createTelemetry } = await import("../src/telemetry/telemetry.js");
const { classifyAiError } = await import("../src/aiError.js");
const { sanitizeMetadata } = await import("../src/telemetry/telemetryPrivacy.js");

test("Counter 正确：run/cache hit/miss 分开计数", () => {
  const telemetry = createTelemetryWith(memoryStorage());
  telemetry.recordAiTask({ taskType: "question-hint-1", status: "run", cached: true });
  telemetry.recordAiTask({ taskType: "question-hint-1", status: "run", cached: false });
  telemetry.recordAiTask({ taskType: "question-hint-1", status: "run", cached: false });
  const metrics = telemetry.getAiMetrics({ range: "all" });
  assert.equal(metrics.counts.taskRuns, 3);
  assert.equal(metrics.counts.cacheHit, 1);
  assert.equal(metrics.counts.cacheMiss, 2);
});

test("Timing 正确：count/average/P50/P95/max", () => {
  const telemetry = createTelemetryWith(memoryStorage());
  for (const value of [10, 20, 30, 40]) {
    telemetry.recordTiming({ metric: "ai.api.duration", tags: { taskType: "chat", model: "deepseek-chat" }, durationMs: value });
  }
  const metrics = telemetry.getAiMetrics({ range: "all" });
  assert.equal(metrics.duration.count, 4);
  assert.equal(metrics.duration.average, 25);
  assert.equal(metrics.duration.p50, 20);
  assert.equal(metrics.duration.p95, 40);
  assert.equal(metrics.duration.max, 40);
});

test("无数据时返回 null 而不是 0", () => {
  const telemetry = createTelemetryWith(memoryStorage());
  const metrics = telemetry.getAiMetrics({ range: "all" });
  assert.equal(metrics.duration.average, null);
  assert.equal(metrics.duration.p50, null);
  assert.equal(metrics.duration.p95, null);
  assert.equal(metrics.duration.max, null);
  assert.equal(metrics.rates.successRate, null);
});

test("malformed storage 自动恢复", () => {
  const storage = memoryStorage({ "wuliao:telemetry:v1": "{oops not json" });
  const telemetry = createTelemetryWith(storage);
  assert.equal(telemetry.getTelemetrySummary().schemaVersion, 1);
});

test("容量限制：每指标上限与总量上限生效", () => {
  const storage = memoryStorage();
  const telemetry = createTelemetryWith(storage);
  for (let index = 0; index < 700; index += 1) {
    telemetry.recordTiming({ metric: "ai.api.duration", durationMs: index });
  }
  const metrics = telemetry.getAiMetrics({ range: "all" });
  assert.ok(metrics.duration.sampleCount <= 500);

  const telemetry2 = createTelemetryWith(memoryStorage());
  for (let metric = 0; metric < 8; metric += 1) {
    for (let index = 0; index < 500; index += 1) {
      telemetry2.recordTiming({ metric: `m${metric}`, durationMs: index });
    }
  }
  assert.ok(telemetry2.getTelemetrySummary().sampleCount <= 3000);
});

test("clear telemetry 正确且不影响学习数据", () => {
  const storage = memoryStorage({
    "wuliao:user:u:learning": "keep-me",
    "wuliao:ai:history": "[]",
  });
  const telemetry = createTelemetryWith(storage);
  telemetry.recordAiTask({ taskType: "chat", status: "run", cached: false });
  telemetry.clearDiagnostics();
  const metrics = telemetry.getAiMetrics({ range: "all" });
  assert.equal(metrics.counts.taskRuns, 0);
  assert.equal(storage.getItem("wuliao:user:u:learning"), "keep-me");
  assert.equal(storage.getItem("wuliao:ai:history"), "[]");
  assert.equal(storage.getItem("wuliao:telemetry:v1"), null);
});

test("report export 正确且无敏感字段", () => {
  const telemetry = createTelemetryWith(memoryStorage());
  telemetry.recordEvent({
    eventType: "ai.task",
    taskType: "chat",
    status: "success",
    metadata: { apiKey: "sk-abc123", prompt: "完整 prompt 内容", userTranslation: "用户译文" },
  });
  const report = telemetry.getDiagnosticsReport();
  const json = JSON.stringify(report);
  assert.ok(!json.includes("sk-abc123"));
  assert.ok(!json.includes("完整 prompt 内容"));
  assert.ok(!json.includes("用户译文"));
  assert.ok(report.schemaVersion === 1);
  assert.ok(report.telemetrySummary);
  assert.ok(report.aiMetrics);
  assert.ok(report.inkMetrics);
  assert.ok(Array.isArray(report.recentSanitizedErrors));
});

test("隐私清洗：敏感字段被遮蔽", () => {
  const cleaned = sanitizeMetadata({
    apiKey: "sk-abc",
    headers: { authorization: "Bearer xyz" },
    nested: { password: "p", pin: "123", safe: "ok" },
  });
  assert.equal(cleaned.apiKey, "[redacted]");
  assert.equal(cleaned.headers.authorization, "[redacted]");
  assert.equal(cleaned.nested.password, "[redacted]");
  assert.equal(cleaned.nested.pin, "[redacted]");
  assert.equal(cleaned.nested.safe, "ok");
});

test("Task Run 与 API Request 不混算", () => {
  const telemetry = createTelemetryWith(memoryStorage());
  telemetry.recordAiTask({ taskType: "question-hint-1", status: "run", cached: false });
  telemetry.recordApiRequest({
    taskType: "question-hint-1",
    model: "deepseek-chat",
    status: "success",
    durationMs: 100,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const metrics = telemetry.getAiMetrics({ range: "all" });
  assert.equal(metrics.counts.taskRuns, 1);
  assert.equal(metrics.counts.apiRequests, 1);
  assert.equal(metrics.tokens.promptTokens, 10);
  assert.equal(metrics.tokens.completionTokens, 5);
  assert.equal(metrics.tokens.totalTokens, 15);
});

test("Cache Hit 不算真实 API Request", () => {
  const telemetry = createTelemetryWith(memoryStorage());
  telemetry.recordAiTask({ taskType: "translation-review", status: "run", cached: true });
  telemetry.recordAiTask({ taskType: "translation-review", status: "success", cached: true, parseSuccess: true });
  const metrics = telemetry.getAiMetrics({ range: "all" });
  assert.equal(metrics.counts.cacheHit, 1);
  assert.equal(metrics.counts.apiRequests, 0);
  assert.equal(metrics.rates.cacheHitRate, 1);
});

test("Timeout / Network 分类", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(classifyAiError(abort).category, "timeout");
  assert.equal(classifyAiError(new TypeError("fetch failed")).category, "network");
  assert.equal(classifyAiError(new Error("429 Too Many Requests")).category, "rate-limit");
  assert.equal(classifyAiError(new Error("Insufficient Balance")).category, "insufficient-balance");
  assert.equal(classifyAiError(new Error("401 Unauthorized")).category, "auth");
  assert.equal(classifyAiError(new Error("502 Bad Gateway")).category, "server");
});

test("Usage 缺失时安全忽略", () => {
  const telemetry = createTelemetryWith(memoryStorage());
  telemetry.recordApiRequest({ taskType: "chat", model: "deepseek-chat", status: "success", durationMs: 50 });
  const metrics = telemetry.getAiMetrics({ range: "all" });
  assert.equal(metrics.tokens, null);
  assert.equal(metrics.counts.apiRequests, 1);
});
