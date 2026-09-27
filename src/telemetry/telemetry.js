// 统一 Telemetry 层：业务模块 → Telemetry API → LocalTelemetrySink。
// 本阶段只实现 LocalTelemetrySink；未来增加 RemoteTelemetrySink 时业务调用方零修改。

import { createTelemetryStorage, TELEMETRY_KEY } from "./telemetryStorage";
import { createEvalSummaryStore } from "./evalSummaryStore";
import { sanitizeErrorText, sanitizeMetadata, findSensitiveKeys } from "./telemetryPrivacy";
import { computeStatsFromSamples, countEvents, pushSample, sampleInRange } from "./telemetryMetrics";

const EVENT_CAP = 300;
const ERROR_CAP = 300;
const SAMPLE_CAP_PER_KEY = 500;
const SAMPLE_TOTAL_CAP = 3000;
const DEFAULT_FLUSH_DELAY_MS = 2000;

export const AI_ERROR_CATEGORIES = [
  "network",
  "timeout",
  "auth",
  "rate-limit",
  "insufficient-balance",
  "server",
  "parse",
  "invalid-response",
  "unknown",
];

function createSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultDoc(now, sessionId) {
  return {
    schemaVersion: 1,
    createdAt: now(),
    updatedAt: now(),
    lastFlushAt: 0,
    activeSessionId: sessionId,
    events: [],
    errors: [],
    samples: {},
  };
}

export function createTelemetry({
  storage,
  now = () => Date.now(),
  performanceNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()),
  // 默认（测试/未初始化）立即 flush，避免遗留挂起 timer；浏览器由 main.jsx 注入真实调度。
  schedule = (fn) => { fn(); return null; },
  cancel = () => {},
  appInfo = () => ({ appVersion: "0.0.0", buildId: "", platform: "web", gitCommit: "" }),
  sessionId = createSessionId(),
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  attachLifecycleHooks = true,
} = {}) {
  const sink = createTelemetryStorage({ storage });
  const evalStore = createEvalSummaryStore({ storage, now });
  let doc = sink.read() || defaultDoc(now, sessionId);
  if (doc.activeSessionId !== sessionId) doc.activeSessionId = sessionId;
  let flushTimer = null;
  let disposed = false;

  const trimEvents = (list, cap) => {
    if (list.length > cap) list.splice(0, list.length - cap);
    return list;
  };

  const requestFlush = () => {
    if (disposed || flushTimer !== null) return;
    flushTimer = schedule(() => {
      flushTimer = null;
      flush();
    }, flushDelayMs);
  };

  function flush() {
    if (flushTimer !== null) {
      cancel(flushTimer);
      flushTimer = null;
    }
    doc.updatedAt = now();
    doc.lastFlushAt = now();
    if (sink.write(doc)) return true;
    // 容量溢出时先压缩最旧样本，再重试一次。
    const keys = Object.keys(doc.samples);
    if (keys.length) {
      const firstKey = keys[0];
      doc.samples[firstKey] = (doc.samples[firstKey] || []).slice(-Math.max(1, Math.floor((doc.samples[firstKey] || []).length / 2)));
    }
    return sink.write(doc);
  }

  function recordEvent({
    eventType,
    taskType = "",
    status = "",
    durationMs = null,
    model = "",
    metadata = null,
  }) {
    if (disposed) return;
    doc.events.push({
      id: `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now(),
      sessionId: doc.activeSessionId,
      eventType: String(eventType || ""),
      taskType: String(taskType || ""),
      status: String(status || ""),
      durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
      model: String(model || ""),
      metadata: sanitizeMetadata(metadata),
    });
    trimEvents(doc.events, EVENT_CAP);
    requestFlush();
  }

  function recordTiming({ metric, tags = null, durationMs }) {
    if (disposed) return;
    if (!Number.isFinite(Number(durationMs))) return;
    pushSample(
      doc,
      String(metric || "timing"),
      {
        t: now(),
        v: Number(durationMs),
        sessionId: doc.activeSessionId,
        tags: sanitizeMetadata(tags),
      },
      { perKeyCap: SAMPLE_CAP_PER_KEY, totalCap: SAMPLE_TOTAL_CAP },
    );
    requestFlush();
  }

  function incrementMetric({ metric, tags = null, by = 1 }) {
    if (disposed) return;
    const amount = Number(by);
    if (!Number.isFinite(amount) || amount === 0) return;
    pushSample(
      doc,
      String(metric || "counter"),
      {
        t: now(),
        v: amount,
        sessionId: doc.activeSessionId,
        tags: sanitizeMetadata(tags),
      },
      { perKeyCap: SAMPLE_CAP_PER_KEY, totalCap: SAMPLE_TOTAL_CAP },
    );
    requestFlush();
  }

  function recordError({ taskType = "", category = "unknown", message = "", metadata = null }) {
    if (disposed) return;
    const normalizedCategory = AI_ERROR_CATEGORIES.includes(category) ? category : "unknown";
    doc.errors.push({
      id: `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now(),
      sessionId: doc.activeSessionId,
      taskType: String(taskType || ""),
      category: normalizedCategory,
      message: sanitizeErrorText(message),
      metadata: sanitizeMetadata(metadata),
    });
    trimEvents(doc.errors, ERROR_CAP);
    requestFlush();
  }

  // ------------------------- AI 可观测 -------------------------

  function recordAiTask({ taskType, model = "", promptVersion = "", status = "run", cached = false, retries = 0, parseSuccess = null, leakBlocked = false, evidenceInvalid = false, evidenceFinalFailure = false, optionCoverage = null, durationMs = null, metadata = null }) {
    recordEvent({
      eventType: "ai.task",
      taskType,
      status,
      durationMs,
      model,
      metadata: {
        ...(metadata || {}),
        promptVersion: String(promptVersion || ""),
        cached: Boolean(cached),
        retries: Number(retries) || 0,
        parseSuccess,
        leakBlocked: Boolean(leakBlocked),
        evidenceInvalid: Boolean(evidenceInvalid),
        evidenceFinalFailure: Boolean(evidenceFinalFailure),
        optionCoverage,
      },
    });
  }

  function recordApiRequest({ taskType = "", model = "", status = "success", category = "", durationMs = null, usage = null }) {
    recordEvent({
      eventType: "ai.api_request",
      taskType,
      status,
      durationMs,
      model,
      metadata: {
        category: AI_ERROR_CATEGORIES.includes(category) ? category : (category || "unknown"),
        usage: usage && typeof usage === "object" ? {
          promptTokens: Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : Number.isFinite(Number(usage.promptTokens)) ? Number(usage.promptTokens) : null,
          completionTokens: Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : Number.isFinite(Number(usage.completionTokens)) ? Number(usage.completionTokens) : null,
          totalTokens: Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : Number.isFinite(Number(usage.totalTokens)) ? Number(usage.totalTokens) : null,
          cacheUsage: usage.cacheUsage || null,
        } : null,
      },
    });
    recordTiming({ metric: "ai.api.duration", tags: { taskType, model }, durationMs });
  }

  function getAiMetrics({ range = "all", at = now() } = {}) {
    const sessionId = doc.activeSessionId;
    const taskEvents = doc.events.filter((event) => event.eventType === "ai.task" && sampleInRange(event, range, sessionId, at));
    const apiEvents = doc.events.filter((event) => event.eventType === "ai.api_request" && sampleInRange(event, range, sessionId, at));
    const durationSamples = computeStatsFromSamples(doc.samples["ai.api.duration"], range, sessionId, at);

    const taskRuns = countEvents(taskEvents, (event) => event.status === "run");
    const cacheHit = countEvents(taskEvents, (event) => event.status === "run" && event.metadata?.cached === true);
    const cacheMiss = countEvents(taskEvents, (event) => event.status === "run" && event.metadata?.cached !== true);
    const taskSuccess = countEvents(taskEvents, (event) => event.status === "success");
    const taskFailure = countEvents(taskEvents, (event) => event.status === "error" || event.status === "parse-failed");
    const parseFailure = countEvents(taskEvents, (event) => event.status === "parse-failed");
    const answerLeakBlocked = countEvents(taskEvents, (event) => event.status === "leak-blocked" || event.metadata?.leakBlocked === true);
    const strictRetry = taskEvents.reduce((sum, event) => sum + (Number(event.metadata?.retries) || 0), 0);
    const evidenceInvalid = countEvents(taskEvents, (event) => event.metadata?.evidenceInvalid === true);
    const evidenceFinalFailure = countEvents(taskEvents, (event) => event.status === "ok" && event.metadata?.evidenceFinalFailure === true);
    const optionCoverageIncomplete = countEvents(taskEvents, (event) => event.metadata?.optionCoverage === false);

    const apiRequests = apiEvents.length;
    const apiSuccess = countEvents(apiEvents, (event) => event.status === "success");
    const apiFailure = countEvents(apiEvents, (event) => event.status === "error");
    const categoryOf = (category) => countEvents(apiEvents, (event) => event.metadata?.category === category);

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let hasUsage = false;
    for (const event of apiEvents) {
      const usage = event.metadata?.usage;
      if (!usage) continue;
      hasUsage = true;
      promptTokens += Number(usage.promptTokens) || 0;
      completionTokens += Number(usage.completionTokens) || 0;
      totalTokens += Number(usage.totalTokens) || 0;
    }

    const byTaskType = {};
    for (const event of taskEvents) {
      const key = event.taskType || "unknown";
      byTaskType[key] ||= { taskRuns: 0, cacheHit: 0, cacheMiss: 0, taskSuccess: 0, taskFailure: 0, parseFailure: 0, answerLeakBlocked: 0, strictRetry: 0 };
      const item = byTaskType[key];
      if (event.status === "run") {
        item.taskRuns += 1;
        if (event.metadata?.cached === true) item.cacheHit += 1;
        else item.cacheMiss += 1;
      }
      if (event.status === "success") item.taskSuccess += 1;
      if (event.status === "error" || event.status === "parse-failed") item.taskFailure += 1;
      if (event.status === "parse-failed") item.parseFailure += 1;
      if (event.status === "leak-blocked" || event.metadata?.leakBlocked === true) item.answerLeakBlocked += 1;
      item.strictRetry += Number(event.metadata?.retries) || 0;
    }
    for (const event of apiEvents) {
      const key = event.taskType || "unknown";
      byTaskType[key] ||= { taskRuns: 0, cacheHit: 0, cacheMiss: 0, taskSuccess: 0, taskFailure: 0, parseFailure: 0, answerLeakBlocked: 0, strictRetry: 0 };
      const item = byTaskType[key];
      item.apiRequests = (item.apiRequests || 0) + 1;
      if (event.status === "success") item.apiSuccess = (item.apiSuccess || 0) + 1;
      else item.apiFailure = (item.apiFailure || 0) + 1;
    }

    const byModel = {};
    for (const event of apiEvents) {
      const key = event.model || "unknown";
      byModel[key] ||= { apiRequests: 0, apiSuccess: 0, apiFailure: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, hasUsage: false };
      const item = byModel[key];
      item.apiRequests += 1;
      if (event.status === "success") item.apiSuccess += 1;
      else item.apiFailure += 1;
      const usage = event.metadata?.usage;
      if (usage) {
        item.hasUsage = true;
        item.promptTokens += Number(usage.promptTokens) || 0;
        item.completionTokens += Number(usage.completionTokens) || 0;
        item.totalTokens += Number(usage.totalTokens) || 0;
      }
    }

    const taskOutcomeTotal = taskSuccess + taskFailure;
    return {
      range,
      counts: {
        taskRuns,
        cacheHit,
        cacheMiss,
        taskSuccess,
        taskFailure,
        apiRequests,
        apiSuccess,
        apiFailure,
        timeout: categoryOf("timeout"),
        network: categoryOf("network"),
        auth: categoryOf("auth"),
        rateLimit: categoryOf("rate-limit"),
        insufficientBalance: categoryOf("insufficient-balance"),
        server: categoryOf("server"),
        unknown: categoryOf("unknown"),
        parseFailure,
        answerLeakBlocked,
        evidenceInvalid,
        evidenceFinalFailure,
        strictRetry,
        optionCoverageIncomplete,
      },
      rates: {
        successRate: taskOutcomeTotal ? taskSuccess / taskOutcomeTotal : null,
        failureRate: taskOutcomeTotal ? taskFailure / taskOutcomeTotal : null,
        cacheHitRate: taskRuns ? cacheHit / taskRuns : null,
        apiSuccessRate: apiRequests ? apiSuccess / apiRequests : null,
      },
      tokens: hasUsage ? { promptTokens, completionTokens, totalTokens } : null,
      duration: durationSamples.count ? durationSamples : { count: 0, average: null, p50: null, p95: null, max: null, sampleCount: 0 },
      byTaskType,
      byModel,
    };
  }

  // ------------------------- 笔迹可观测 -------------------------

  function getInkMetrics({ range = "all", at = now() } = {}) {
    const sessionId = doc.activeSessionId;
    const strokes = doc.events.filter((event) => event.eventType === "ink.stroke_end" && sampleInRange(event, range, sessionId, at));
    const finalize = computeStatsFromSamples(doc.samples["ink.stroke.finalize"], range, sessionId, at);
    const commit = computeStatsFromSamples(doc.samples["ink.stroke.commit"], range, sessionId, at);
    const save = computeStatsFromSamples(doc.samples["ink.save"], range, sessionId, at);
    const render = computeStatsFromSamples(doc.samples["ink.render"], range, sessionId, at);
    const counterTotal = (metric) => {
      const samples = (doc.samples[metric] || []).filter((sample) => sampleInRange(sample, range, sessionId, at));
      return samples.reduce((sum, sample) => sum + (Number(sample.v) || 0), 0);
    };
    const pointsTotal = strokes.reduce((sum, event) => sum + (Number(event.metadata?.points) || 0), 0);
    const coalescedTotal = strokes.reduce((sum, event) => sum + (Number(event.metadata?.coalesced) || 0), 0);
    const totalDuration = strokes.reduce((sum, event) => sum + (Number(event.durationMs) || 0), 0);
    return {
      range,
      strokeCount: strokes.length,
      averageStrokeDurationMs: strokes.length ? totalDuration / strokes.length : null,
      averagePointsPerStroke: strokes.length ? pointsTotal / strokes.length : null,
      averageCoalescedPerStroke: strokes.length ? coalescedTotal / strokes.length : null,
      finalize,
      commit,
      save,
      render,
      fullRedrawCount: counterTotal("ink.handoff.fullRedraw"),
      incrementalCommitCount: counterTotal("ink.handoff.incrementalCommit"),
      previewClearCount: counterTotal("ink.handoff.previewClear"),
      anomalyCount: strokes.filter((event) => event.metadata?.anomaly === true).length,
    };
  }

  // ------------------------- 汇总 / 导出 / 清除 -------------------------

  function getTelemetrySummary() {
    const info = appInfo();
    return {
      schemaVersion: doc.schemaVersion,
      status: "running",
      sessionId: doc.activeSessionId,
      appVersion: info.appVersion,
      buildId: info.buildId,
      platform: info.platform,
      lastFlushAt: doc.lastFlushAt || null,
      eventCount: doc.events.length,
      errorCount: doc.errors.length,
      sampleCount: Object.values(doc.samples).reduce((sum, arr) => sum + arr.length, 0),
    };
  }

  function getLatestEvalSummary() {
    return evalStore.get() || null;
  }

  function getDiagnosticsReport() {
    const info = appInfo();
    const report = {
      schemaVersion: doc.schemaVersion,
      generatedAt: now(),
      appVersion: info.appVersion,
      buildId: info.buildId,
      platform: info.platform,
      gitCommit: info.gitCommit || "",
      telemetrySummary: getTelemetrySummary(),
      aiMetrics: {
        session: getAiMetrics({ range: "session" }),
        "7d": getAiMetrics({ range: "7d" }),
        "30d": getAiMetrics({ range: "30d" }),
        all: getAiMetrics({ range: "all" }),
      },
      inkMetrics: getInkMetrics({ range: "all" }),
      recentSanitizedErrors: doc.errors.slice(-50).map((error) => ({
        timestamp: error.timestamp,
        sessionId: error.sessionId,
        taskType: error.taskType,
        category: error.category,
        message: error.message,
      })),
      latestOfflineEvalSummary: evalStore.get()?.offline || null,
      latestLiveEvalSummary: evalStore.get()?.live || null,
    };
    // 导出前再次执行敏感字段清洗（双重保险）。
    return sanitizeMetadata(report, 0) || report;
  }

  function clearDiagnostics() {
    sink.remove();
    evalStore.clear();
    doc = defaultDoc(now, sessionId);
    if (flushTimer !== null) {
      cancel(flushTimer);
      flushTimer = null;
    }
  }

  function dispose() {
    disposed = true;
    if (flushTimer !== null) {
      cancel(flushTimer);
      flushTimer = null;
    }
    flush();
  }

  if (attachLifecycleHooks && typeof window !== "undefined" && typeof document !== "undefined") {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const flushOnHide = () => flush();
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", flushWhenHidden);
    // dispose 时移除监听
    const originalDispose = dispose;
    dispose = () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      originalDispose();
    };
  }

  recordEvent({
    eventType: "app.start",
    taskType: "app",
    status: "launch",
    model: appInfo().platform,
    metadata: { appVersion: appInfo().appVersion, buildId: appInfo().buildId },
  });

  return {
    recordEvent,
    recordTiming,
    incrementMetric,
    recordError,
    recordAiTask,
    recordApiRequest,
    getAiMetrics,
    getInkMetrics,
    getTelemetrySummary,
    getDiagnosticsReport,
    getLatestEvalSummary,
    setLatestEvalSummary: (value) => evalStore.set(value),
    setEvalVisible: (visible) => evalStore.setVisible(appInfo().appVersion, visible),
    isEvalVisible: () => evalStore.isVisible(appInfo().appVersion),
    clearDiagnostics,
    flush,
    dispose,
    key: TELEMETRY_KEY,
    findSensitiveKeys,
  };
}

// 默认单例：main.jsx 用真实 appInfo 初始化；Node 测试使用 createTelemetry 注入环境。
let defaultTelemetry = null;

export function initTelemetry(deps = {}) {
  if (!defaultTelemetry) defaultTelemetry = createTelemetry(deps);
  return defaultTelemetry;
}

export function getTelemetry() {
  if (!defaultTelemetry) defaultTelemetry = createTelemetry({});
  return defaultTelemetry;
}
