import { estimateAiTokenCost } from "../aiCachePolicy.js";

const knownNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
function row(providerId, model, transportKind, taskType) {
  return { providerId, model, transportKind, taskType, memoryHits: 0, persistentHits: 0, repositoryHits: 0, dictionaryHits: 0,
    misses: 0, forceRefreshes: 0, coalesced: 0, networkRequests: 0, completedRequests: 0, cancelled: 0,
    usageRequests: 0, unknownUsageRequests: 0, cacheUsageRequests: 0, promptTokens: null, hitTokens: null, missTokens: null,
    writeTokens: null, outputTokens: null, reportedCost: null, costRequests: 0, estimatedCost: null,
    normalInputCost: null, cacheReadCost: null, cacheWriteCost: null, outputCost: null, inputSavings: null,
    latencyTotalMs: 0, latencySamples: 0, reasons: new Set() };
}
const add = (target, key, value) => { if (knownNumber(value)) target[key] = (target[key] || 0) + value; };

export function computeAiCacheMetrics(events, { accountScope, rateCards = {} } = {}) {
  const groups = new Map();
  for (const event of events) {
    const metadata = event.metadata || {};
    if (metadata.accountScope !== accountScope) continue;
    if (!event.eventType?.startsWith("ai.result_cache.") && !["ai.api_request_started", "ai.api_request"].includes(event.eventType)) continue;
    const providerId = metadata.providerId || "unknown", model = event.model || "unknown", transportKind = metadata.transportKind || "unknown", taskType = event.taskType || "unknown";
    const key = JSON.stringify([providerId, model, transportKind, taskType]);
    if (!groups.has(key)) groups.set(key, row(providerId, model, transportKind, taskType));
    const item = groups.get(key);
    if (metadata.policyReason) item.reasons.add(metadata.policyReason);
    const source = event.eventType.replace("ai.result_cache.", "");
    const counters = { memory_hit: "memoryHits", persistent_hit: "persistentHits", repository_hit: "repositoryHits", dictionary_hit: "dictionaryHits", miss: "misses", force_refresh: "forceRefreshes", inflight_join: "coalesced" };
    if (counters[source]) item[counters[source]] += 1;
    if (event.eventType === "ai.api_request_started") item.networkRequests += 1;
    if (event.eventType !== "ai.api_request") continue;
    item.completedRequests += 1;
    if (event.status === "cancelled") item.cancelled += 1;
    if (knownNumber(event.durationMs)) { item.latencyTotalMs += event.durationMs; item.latencySamples += 1; }
    const usage = metadata.usage;
    if (providerId === "openrouter" && knownNumber(usage?.reportedCost)) {
      add(item, "reportedCost", usage.reportedCost); item.costRequests += 1;
    }
    if (!usage || !knownNumber(usage.promptTokens)) {
      item.unknownUsageRequests += 1; item.reasons.add(event.status === "success" ? "no_input_usage_returned" : "request_failed_or_cancelled_no_usage"); continue;
    }
    item.usageRequests += 1;
    add(item, "promptTokens", usage.promptTokens); add(item, "outputTokens", usage.completionTokens);
    add(item, "writeTokens", usage.writeTokens);
    if (knownNumber(usage.cacheUsage?.hitTokens) && knownNumber(usage.cacheUsage?.missTokens) && usage.cacheUsage.hitTokens + usage.cacheUsage.missTokens === usage.promptTokens) {
      item.cacheUsageRequests += 1;
      add(item, "hitTokens", usage.cacheUsage.hitTokens); add(item, "missTokens", usage.cacheUsage.missTokens);
    } else item.reasons.add("cache_usage_missing_or_inconsistent");
    const scoped = rateCards[JSON.stringify([providerId, model, transportKind, metadata.endpointIdentity])];
    const rates = scoped && scoped.providerId === providerId && scoped.modelId === model && scoped.transportKind === transportKind &&
      metadata.endpointIdentity && scoped.endpointIdentity === metadata.endpointIdentity ? scoped : null;
    const cost = estimateAiTokenCost({ prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, cacheUsage: usage.cacheUsage, cache_write_tokens: usage.writeTokens }, rates);
    if (cost.calculable) {
      for (const [key, field] of Object.entries({ estimatedCost: "total", normalInputCost: "normalInput", cacheReadCost: "cacheRead", cacheWriteCost: "cacheWrite", outputCost: "output", inputSavings: "inputSavings" })) {
        // Savings can be negative when writes cost more than their later reuse.
        if (field === "inputSavings") item[key] = (item[key] || 0) + cost[field]; else add(item, key, cost[field]);
      }
    } else item.reasons.add("verified_billing_breakdown_unavailable");
  }
  return [...groups.values()].map(item => {
    const localHits = item.memoryHits + item.persistentHits;
    const localLookups = localHits + item.misses + item.forceRefreshes + item.coalesced;
    const measuredInput = item.hitTokens == null || item.missTokens == null ? null : item.hitTokens + item.missTokens;
    return { ...item, reasons: [...item.reasons], localHits, localLookups,
      localHitRatio: localLookups ? localHits / localLookups : null,
      providerHitRatio: measuredInput ? item.hitTokens / measuredInput : null,
      measuredInputTokens: measuredInput, providerUsageComplete: item.completedRequests > 0 && item.cacheUsageRequests === item.completedRequests,
      costComplete: item.completedRequests > 0 && item.costRequests === item.completedRequests,
      averageLatencyMs: item.latencySamples ? item.latencyTotalMs / item.latencySamples : null };
  });
}
