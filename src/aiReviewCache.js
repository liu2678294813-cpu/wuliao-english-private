import { getCurrentUsername, getUserItem, setUserItem } from "./userData";
import { getTelemetry } from "./telemetry/telemetry";
export const AI_RESULT_CACHE_LIMITS = Object.freeze({ memoryEntries: 300, memoryBytes: 4 * 1024 * 1024, persistentBytes: 2 * 1024 * 1024, wordEntries: 300, otherEntries: 100, structuredEntries: 50 });
const legacyKeys = { "translation-review": "wuliao:ai:translation-review-cache", "question-hint": "wuliao:ai:question-hint-cache", "question-diagnosis": "wuliao:ai:question-diagnosis-cache", "cloze-task": "wuliao:ai:cloze-task-cache" };
const INDEX = "wuliao:ai:result-cache-index";
const stores = new Map(), hot = new Map(), indexes = new Map(), flights = new Map();
globalThis.window?.addEventListener?.("wuliao:account-changed", () => {
  clearAiResultMemory();
  for (const [key, flight] of flights) {
    if (![...flight.consumers].some((consumer) => consumer.valid())) {
      flight.controller.abort();
      flights.delete(key);
    }
  }
});
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const storageKey = namespace => Object.hasOwn(legacyKeys, namespace) ? legacyKeys[namespace] : `wuliao:ai:result-cache:${namespace}`;
const scopeKey = (username, namespace) => JSON.stringify([username, namespace]);
const hotKey = (username, namespace, fingerprint) => JSON.stringify([username, namespace, fingerprint]);
function metric(type, namespace, context = {}, username = getCurrentUsername()) {
  try { getTelemetry().recordAiCacheEvent({ source: type, namespace, username, ...context, taskType: context?.taskType || namespace }); } catch {}
}
function readJson(key, username, fallback) { try { return JSON.parse(getUserItem(key, username) || "null") || fallback; } catch { return fallback; } }
function store(namespace, username) {
  const key = scopeKey(username, namespace);
  if (!stores.has(key)) {
    const data = readJson(storageKey(namespace), username, { entries: [] });
    const entries = Array.isArray(data?.entries) ? data.entries.filter(item => item && typeof item.fingerprint === "string" && item.result != null && Number.isFinite(item.savedAt)) : [];
    stores.set(key, { entries });
  }
  return stores.get(key);
}
function memoryPut(key, entry) {
  hot.delete(key); hot.set(key, entry);
  let size = [...hot.values()].reduce((sum, item) => sum + bytes(item), 0);
  while (hot.size > AI_RESULT_CACHE_LIMITS.memoryEntries || size > AI_RESULT_CACHE_LIMITS.memoryBytes) {
    const oldest = hot.keys().next().value; size -= bytes(hot.get(oldest)); hot.delete(oldest);
  }
}
export function clearAiResultMemory() { hot.clear(); stores.clear(); indexes.clear(); }
export function readAiResult(namespace, fingerprint, identity = fingerprint, username = getCurrentUsername(), { maxAgeMs, cacheContext, record = true } = {}) {
  if (!username || !fingerprint) return null;
  const fresh = entry => maxAgeMs == null || (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && Date.now() - entry.savedAt < maxAgeMs);
  const key = hotKey(username, namespace, fingerprint), cached = hot.get(key);
  if (cached && (cached.identity ?? cached.fingerprint) === identity && fresh(cached)) {
    cached.lastUsedAt = Date.now(); hot.delete(key); hot.set(key, cached); if (record) metric("memory_hit", namespace, cacheContext || cached.cacheContext, username);
    return { result: cached.result, savedAt: cached.savedAt, source: "memory" };
  }
  const entry = store(namespace, username).entries.find(item => item.fingerprint === fingerprint && (item.identity ?? item.fingerprint) === identity);
  if (!entry || !fresh(entry)) return null;
  entry.lastUsedAt = Date.now(); memoryPut(key, entry); if (record) metric("persistent_hit", namespace, cacheContext || entry.cacheContext, username);
  return { result: entry.result, savedAt: entry.savedAt, source: "persistent" };
}
function writeResult(namespace, fingerprint, identity, result, username, cacheContext) {
  if (!username || !fingerprint || result == null) return;
  const entry = { fingerprint, identity, result, savedAt: Date.now(), lastUsedAt: Date.now(), ...(cacheContext ? { cacheContext } : {}) }, data = store(namespace, username);
  // Large transient responses are useful in memory but must not evict all common queries.
  if (bytes(entry) > AI_RESULT_CACHE_LIMITS.persistentBytes - 32 * 1024) {
    memoryPut(hotKey(username, namespace, fingerprint), entry); metric("memory_only", namespace, cacheContext, username); return;
  }
  data.entries = data.entries.filter(item => item.fingerprint !== fingerprint); data.entries.push(entry);
  const limit = namespace === "quick-word" ? AI_RESULT_CACHE_LIMITS.wordEntries : legacyKeys[namespace] ? AI_RESULT_CACHE_LIMITS.structuredEntries : AI_RESULT_CACHE_LIMITS.otherEntries;
  data.entries.sort((a,b) => (a.lastUsedAt || a.savedAt || 0) - (b.lastUsedAt || b.savedAt || 0));
  while (data.entries.length > limit) { data.entries.shift(); metric("eviction", namespace); }
  if (!indexes.has(username)) {
    const rawIndex = readJson(INDEX, username, {});
    const index = Object.fromEntries(Object.entries(rawIndex && typeof rawIndex === "object" && !Array.isArray(rawIndex) ? rawIndex : {})
      .filter(([ns, size]) => /^[a-zA-Z0-9.-]+$/.test(ns) && typeof size === "number" && Number.isFinite(size) && size >= 0));
    for (const [ns,key] of Object.entries(legacyKeys)) {
      const raw = getUserItem(key, username);
      if (raw && index[ns] == null) index[ns] = new TextEncoder().encode(raw).length;
    }
    indexes.set(username, index);
  }
  const index = indexes.get(username); index[namespace] = bytes(data);
  while (Object.values(index).reduce((sum, n) => sum + Number(n || 0), 0) > AI_RESULT_CACHE_LIMITS.persistentBytes - 32 * 1024) {
    const candidates = Object.keys(index).map(ns => {
      const data = store(ns, username);
      data.entries.sort((a,b) => (a.lastUsedAt || a.savedAt || 0) - (b.lastUsedAt || b.savedAt || 0));
      return { ns, data };
    }).filter(item => item.data.entries.length);
    candidates.sort((a,b) => (a.data.entries[0].lastUsedAt || a.data.entries[0].savedAt || 0) - (b.data.entries[0].lastUsedAt || b.data.entries[0].savedAt || 0));
    const oldest = candidates[0]; if (!oldest) break;
    const removed = oldest.data.entries.shift(); hot.delete(hotKey(username, oldest.ns, removed.fingerprint));
    index[oldest.ns] = bytes(oldest.data); metric("eviction", oldest.ns);
    try { setUserItem(storageKey(oldest.ns), JSON.stringify(oldest.data), username); } catch {}
  }
  try { setUserItem(storageKey(namespace), JSON.stringify(data), username); setUserItem(INDEX, JSON.stringify(index), username); } catch {}
  memoryPut(hotKey(username, namespace, fingerprint), entry);
}
const aborted = () => new DOMException("AI request consumer is no longer current", "AbortError");
function waitForPrevious(previous, signal) {
  if (previous.controller.signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { cleanup(); resolve(); };
    const cancel = () => { cleanup(); reject(aborted()); };
    const cleanup = () => {
      previous.controller.signal.removeEventListener("abort", finish);
      signal.removeEventListener("abort", cancel);
    };
    previous.controller.signal.addEventListener("abort", finish, { once: true });
    signal.addEventListener("abort", cancel, { once: true });
    previous.promise.then(finish, finish);
    if (signal.aborted) cancel();
  });
}
export async function runCachedAiResult({ namespace, fingerprint, identity = fingerprint, username = getCurrentUsername(), signal, isCurrent = () => true, force = false, request, validate = result => result != null, cacheable = () => true, networkOnly = false, maxAgeMs, cacheContext }) {
  const valid = () => !signal?.aborted && isCurrent() && username === getCurrentUsername();
  if (!valid()) throw aborted();
  const key = hotKey(username, namespace, fingerprint) + ":" + identity, existing = flights.get(key);
  if (!force && !existing && !networkOnly) {
    const hit = readAiResult(namespace, fingerprint, identity, username, { maxAgeMs, cacheContext, record: false });
    let usable = false;
    try { usable = Boolean(hit && validate(hit.result) && cacheable(hit.result)); } catch {}
    if (usable) { metric(`${hit.source}_hit`, namespace, cacheContext, username); return { ...hit, cached: true }; }
    if (hit) metric("invalid_entry", namespace, cacheContext, username);
  }
  let flight = existing;
  if (!flight || (force && !flight.force)) {
    if (!networkOnly || force) metric(force ? "force_refresh" : "miss", namespace, cacheContext, username);
    const previous = flight, controller = new AbortController();
    flight = { controller, consumers: new Set(), force: Boolean(force), promise: null };
    const currentFlight = flight; flights.set(key, flight);
    const active = () => [...currentFlight.consumers].some(consumer => consumer.valid());
    flight.promise = Promise.resolve().then(async () => {
      if (previous) await waitForPrevious(previous, controller.signal);
      if (!active()) throw aborted();
      const result = await request({ signal: controller.signal, isCurrent: active });
      if (!active() || controller.signal.aborted) throw aborted();
      if (!validate(result)) throw new Error("AI result validation failed");
      if (!networkOnly && cacheable(result)) {
        try { writeResult(namespace, fingerprint, identity, result, username, cacheContext); } catch { metric("write_failed", namespace, cacheContext, username); }
      }
      return result;
    }).finally(() => { if (flights.get(key) === currentFlight) flights.delete(key); });
    flight.promise.catch(() => {});
  } else metric("inflight_join", namespace, cacheContext, username);
  const consumer = { valid }; flight.consumers.add(consumer);
  const joined = Boolean(existing && !(force && !existing.force));
  return new Promise((resolve, reject) => {
    const remove = () => { flight.consumers.delete(consumer); signal?.removeEventListener?.("abort", cancel); if (![...flight.consumers].some(item => item.valid())) { flight.controller.abort(); if (flights.get(key) === flight) flights.delete(key); } };
    const cancel = () => { remove(); reject(aborted()); };
    signal?.addEventListener?.("abort", cancel, { once: true });
    flight.promise.then(result => { if (!valid()) { remove(); reject(aborted()); return; } remove(); resolve({ result, cached: false, source: joined ? "inflight" : "network" }); }, reason => { remove(); reject(reason); });
  });
}
function readStructuredResult(namespace, fingerprint, cacheContext, validate = () => true) {
  let result = readAiResult(namespace, fingerprint, fingerprint, getCurrentUsername(), { cacheContext, record: false });
  if (result) {
    let usable = false;
    try { usable = Boolean(validate(result.result)); } catch {}
    if (!usable) { metric("invalid_entry", namespace, cacheContext); result = null; }
    else if (cacheContext) metric(`${result.source}_hit`, namespace, cacheContext);
  }
  if (!result && cacheContext) metric("miss", namespace, cacheContext);
  return result;
}
export const readReviewCacheEntry = (fp,context,validate) => readStructuredResult("translation-review", fp, context,validate);
export const readReviewCache = fp => readReviewCacheEntry(fp)?.result || null;
export const writeReviewCache = (fp,result,context) => writeResult("translation-review",fp,fp,result,getCurrentUsername(),context);
export const readQuestionHintCache = (fp,context,validate) => readStructuredResult("question-hint",fp,context,validate)?.result || null;
export const writeQuestionHintCache = (fp,result,context) => writeResult("question-hint",fp,fp,result,getCurrentUsername(),typeof context === "object" ? context : undefined);
export const readQuestionDiagnosisCacheEntry = (fp,context,validate) => readStructuredResult("question-diagnosis",fp,context,validate);
export const readQuestionDiagnosisCache = fp => readQuestionDiagnosisCacheEntry(fp)?.result || null;
export const writeQuestionDiagnosisCache = (fp,result,context) => writeResult("question-diagnosis",fp,fp,result,getCurrentUsername(),context);
export const writeClozeResult = (fp,result) => writeResult("cloze-task",fp,fp,result,getCurrentUsername());
