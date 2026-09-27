// 纯聚合函数：count / average / P50 / P95 / max。
// 无数据时必须返回 null，禁止把“无数据”显示成 0。

export const DAY_MS = 24 * 60 * 60 * 1000;

export function timeRangeStart(range, now = Date.now()) {
  if (range === "session") return 0;
  if (range === "all") return 0;
  if (range === "7d") return now - 7 * DAY_MS;
  if (range === "30d") return now - 30 * DAY_MS;
  return 0;
}

export function sampleInRange(sample, range, sessionId, now = Date.now()) {
  if (!sample) return false;
  if (range === "session") return Boolean(sessionId) && sample.sessionId === sessionId;
  return Number(sample.t || 0) >= timeRangeStart(range, now);
}

export function filterSamples(samples, range, sessionId, now = Date.now()) {
  return (Array.isArray(samples) ? samples : []).filter((sample) => sampleInRange(sample, range, sessionId, now));
}

function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const index = Math.max(0, Math.min(n - 1, Math.ceil((p / 100) * n) - 1));
  return sorted[index];
}

export function computeStats(values) {
  const list = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (!list.length) {
    return { count: 0, average: null, p50: null, p95: null, max: null };
  }
  const sorted = [...list].sort((a, b) => a - b);
  const sum = list.reduce((total, value) => total + value, 0);
  return {
    count: list.length,
    average: sum / list.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

export function computeStatsFromSamples(samples, range, sessionId, now = Date.now()) {
  const kept = filterSamples(samples, range, sessionId, now);
  return {
    ...computeStats(kept.map((sample) => sample.v)),
    sampleCount: kept.length,
  };
}

// 追加样本并执行容量控制：每指标上限 perKeyCap，总样本上限 totalCap，超限丢最旧。
export function pushSample(store, key, sample, { perKeyCap = 500, totalCap = 3000 } = {}) {
  const bucket = store.samples[key] || (store.samples[key] = []);
  bucket.push(sample);
  if (bucket.length > perKeyCap) {
    bucket.splice(0, bucket.length - perKeyCap);
  }
  let total = Object.values(store.samples).reduce((sum, arr) => sum + arr.length, 0);
  if (total > totalCap) {
    for (const bucketKey of Object.keys(store.samples)) {
      const arr = store.samples[bucketKey];
      const excess = total - totalCap;
      const drop = Math.min(arr.length, excess);
      if (drop > 0) {
        arr.splice(0, drop);
        total -= drop;
      }
      if (total <= totalCap) break;
    }
  }
  return store;
}

export function countEvents(events, predicate) {
  return (Array.isArray(events) ? events : []).filter(predicate).length;
}
