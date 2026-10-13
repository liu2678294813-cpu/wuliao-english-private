import { getCurrentUsername } from "./userData.js";
import { computeFileFingerprint, stablePdfResourceId } from "./fingerprint.js";
import { AppEvent } from "./events/eventTypes.js";
import { emitAppEvent } from "./events/appEvents.js";
import { normalizeUnknownTerm } from "./unknownWords.js";
import { IMPORT_STORES } from "./import/contracts.js";

export const WULIAO_ENGLISH_DB_NAME = "wuliao-english";
export const WULIAO_ENGLISH_DB_VERSION = 9;
const STORE = "custom-pdfs";
const UNKNOWN_STORE = "unknown-words";
const CACHE_STORE = "pdf-parse-cache";
export const EXAM_INK_STORE = "exam-ink";
export const WRITING_INK_STORE = "writing-ink";
export const DEVICE_PRIVATE_WRITING_SAMPLE_STORE = "device-private-writing-samples";
export const LONG_SENTENCE_STORES = [
  "long-sentence-sessions",
  "long-sentence-items",
  "long-sentence-attempts",
  "long-sentence-skills",
  "long-sentence-evaluations",
  "long-sentence-schedules",
  "long-sentence-ink",
];
let longSentenceStorageAvailable = true;
export function isLongSentenceStorageAvailable() { return longSentenceStorageAvailable; }

function openExistingVersionSeven(indexedDb) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(WULIAO_ENGLISH_DB_NAME);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) request.transaction.abort();
    };
    request.onerror = () => reject(request.error || new Error("旧数据库无法打开"));
    request.onsuccess = () => {
      const db = request.result;
      const required = ["reader-ink", STORE, UNKNOWN_STORE, CACHE_STORE,
        EXAM_INK_STORE, WRITING_INK_STORE, DEVICE_PRIVATE_WRITING_SAMPLE_STORE];
      const expected = {
        "reader-ink": ["id", ["username"]],
        [STORE]: ["id", ["username", "fingerprint"]],
        [UNKNOWN_STORE]: ["id", ["username", "usernameResource"]],
        [CACHE_STORE]: ["cacheKey", ["fingerprint"]],
        [EXAM_INK_STORE]: ["id", ["username", "sessionId"]],
        [WRITING_INK_STORE]: ["id", ["username", "sessionId", "ownerRecordId"]],
        [DEVICE_PRIVATE_WRITING_SAMPLE_STORE]: ["id", ["username", "usernameQuestion"]],
      };
      let valid = db.version === 7 && required.every((name) => db.objectStoreNames.contains(name));
      if (valid) {
        try {
          const transaction = db.transaction(required, "readonly");
          valid = required.every((name) => {
            const store = transaction.objectStore(name);
            const [keyPath, indexes] = expected[name];
            return store.keyPath === keyPath && indexes.every((index) => store.indexNames.contains(index));
          });
        } catch { valid = false; }
      }
      if (!valid) { db.close(); reject(new Error("旧数据库结构不完整，已停止写入")); return; }
      longSentenceStorageAvailable = false;
      resolve(db);
    };
  });
}

export function openWuliaoEnglishDatabase(indexedDb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDb?.open) {
      reject(new Error("IndexedDB 不可用"));
      return;
    }
    const request = indexedDb.open(WULIAO_ENGLISH_DB_NAME, WULIAO_ENGLISH_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("reader-ink")) {
        const store = request.result.createObjectStore("reader-ink", { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
      }
      if (!request.result.objectStoreNames.contains(STORE)) {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
        store.createIndex("fingerprint", "fingerprint", { unique: false });
      } else {
        const store = request.transaction.objectStore(STORE);
        if (!store.indexNames.contains("username")) store.createIndex("username", "username", { unique: false });
        if (!store.indexNames.contains("fingerprint")) store.createIndex("fingerprint", "fingerprint", { unique: false });
      }
      if (!request.result.objectStoreNames.contains(UNKNOWN_STORE)) {
        const store = request.result.createObjectStore(UNKNOWN_STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
        store.createIndex("usernameResource", ["username", "resourceId"], { unique: false });
      }
      if (!request.result.objectStoreNames.contains(CACHE_STORE)) {
        const store = request.result.createObjectStore(CACHE_STORE, { keyPath: "cacheKey" });
        store.createIndex("fingerprint", "fingerprint", { unique: false });
      }
      if (!request.result.objectStoreNames.contains(EXAM_INK_STORE)) {
        const store = request.result.createObjectStore(EXAM_INK_STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!request.result.objectStoreNames.contains(WRITING_INK_STORE)) {
        const store = request.result.createObjectStore(WRITING_INK_STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("ownerRecordId", "ownerRecordId", { unique: false });
      }
      if (!request.result.objectStoreNames.contains(DEVICE_PRIVATE_WRITING_SAMPLE_STORE)) {
        const store = request.result.createObjectStore(DEVICE_PRIVATE_WRITING_SAMPLE_STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
        store.createIndex("usernameQuestion", ["username", "questionId"], { unique: true });
      }
      for (const name of LONG_SENTENCE_STORES) {
        if (request.result.objectStoreNames.contains(name)) continue;
        const store = request.result.createObjectStore(name, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
        if (name !== "long-sentence-skills") store.createIndex("usernameSession", ["username", "sessionId"], { unique: false });
        if (name === "long-sentence-sessions") store.createIndex("usernameCreated", ["username", "createdAt"], { unique: false });
        if (name === "long-sentence-skills") store.createIndex("usernameDue", ["username", "nextDueAt"], { unique: false });
        if (name === "long-sentence-ink") store.createIndex("ownerRecordId", "ownerRecordId", { unique: false });
      }
      for (const name of IMPORT_STORES) {
        if (request.result.objectStoreNames.contains(name)) continue;
        const store = request.result.createObjectStore(name, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
        store.createIndex("materialId", "materialId", { unique: false });
      }
    };
    request.onsuccess = () => { longSentenceStorageAvailable = true; resolve(request.result); };
    request.onerror = () => {
      if (request.error?.name === "VersionError") { reject(request.error); return; }
      openExistingVersionSeven(indexedDb).then(resolve, reject);
    };
  });
}

function runTransaction(mode, callback, storeName = STORE, indexedDb = globalThis.indexedDB) {
  return openWuliaoEnglishDatabase(indexedDb).then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = callback(transaction.objectStore(storeName));
        let result;
        let settled = false;
        const settle = (error) => {
          if (settled) return;
          settled = true;
          try {
            db.close();
          } catch {
            // 连接已关闭时忽略
          }
          if (error) reject(error);
          else resolve(result);
        };
        // request 成功不代表事务提交成功（quota / abort 可能随后发生）。
        // 以 transaction complete 为成功点；onerror / onabort 都视为失败。
        request.onsuccess = (event) => { result = event.target.result; };
        request.onerror = () => settle(request.error || transaction.error || new Error("数据库操作失败"));
        transaction.oncomplete = () => settle(null);
        transaction.onerror = () => settle(transaction.error || new Error("数据库事务失败"));
        transaction.onabort = () => settle(transaction.error || new Error("数据库事务已取消"));
      }),
  );
}

export async function putDevicePrivateWritingSample(record, indexedDb = globalThis.indexedDB) {
  return runTransaction("readwrite", (store) => store.put(record), DEVICE_PRIVATE_WRITING_SAMPLE_STORE, indexedDb);
}

export async function putDevicePrivateWritingSamples(records, indexedDb = globalThis.indexedDB) {
  const values = Array.isArray(records) ? records : [];
  if (!values.length) return 0;
  return openWuliaoEnglishDatabase(indexedDb).then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(DEVICE_PRIVATE_WRITING_SAMPLE_STORE, "readwrite");
    const store = transaction.objectStore(DEVICE_PRIVATE_WRITING_SAMPLE_STORE);
    values.forEach((record) => store.put(record));
    transaction.oncomplete = () => { db.close(); resolve(values.length); };
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error("私有范文导入失败")); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error("私有范文导入已取消")); };
  }));
}

export async function getDevicePrivateWritingSample(username, questionId, indexedDb = globalThis.indexedDB) {
  if (!username || !questionId) return null;
  return runTransaction(
    "readonly",
    (store) => store.index("usernameQuestion").get([username, questionId]),
    DEVICE_PRIVATE_WRITING_SAMPLE_STORE,
    indexedDb,
  );
}

export async function listDevicePrivateWritingSamples(username, indexedDb = globalThis.indexedDB) {
  if (!username) return [];
  return runTransaction(
    "readonly",
    (store) => store.index("username").getAll(username),
    DEVICE_PRIVATE_WRITING_SAMPLE_STORE,
    indexedDb,
  );
}

// 同一用户再次导入同一份 PDF：返回已有记录（含已完成的解析），不重复建档。
export async function addCustomPdf(file, knownFingerprint = null) {
  const username = getCurrentUsername();
  if (!username) throw new Error("请先登录账号");
  const fingerprint = knownFingerprint || await computeFileFingerprint(file);
  const existing = await runTransaction("readonly", (store) => store.index("fingerprint").get(fingerprint));
  if (existing?.username === username) return existing;
  const yearMatch = file.name.match(/(?:19|20)\d{2}/);
  const id = stablePdfResourceId(fingerprint, username);
  const record = {
    id,
    kind: "custom",
    category: "custom",
    title: file.name.replace(/\.pdf$/i, ""),
    subtitle: yearMatch ? `${yearMatch[0]} · 自定义资料` : "自定义资料",
    year: yearMatch ? Number(yearMatch[0]) : null,
    fingerprint,
    file,
    size: file.size,
    addedAt: Date.now(),
    conversionStatus: "pending",
    username,
  };
  await runTransaction("readwrite", (store) => store.put(record));
  return record;
}

export async function listCustomPdfs() {
  const username = getCurrentUsername();
  if (!username) return [];
  const records = await runTransaction("readonly", (store) => store.index("username").getAll(username));
  const files = records.some((r) => r.sourceFileId) ? await runTransaction("readonly", (store) => store.index("username").getAll(username), "import-files") : [];
  return records.filter((r) => !r.deletedAt).map((r) => r.sourceFileId ? { ...r, file: files.find((f) => f.id === r.sourceFileId)?.file || null } : r).sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteCustomPdf(id) {
  const current = await runTransaction("readonly", (store) => store.get(id));
  if (!current || current.username !== getCurrentUsername()) throw new Error("自定义 PDF 不存在");
  if (current.importVersion) {
    await runTransaction("readwrite", (store) => store.put({ ...current, deletedAt: Date.now() }));
    return;
  }
  await runTransaction("readwrite", (store) => store.delete(id));
  if (current.fingerprint) await clearParseCache(current.fingerprint);
}

export async function updateCustomPdf(id, changes) {
  const current = await runTransaction("readonly", (store) => store.get(id));
  if (!current || current.username !== getCurrentUsername()) throw new Error("自定义 PDF 不存在");
  const next = { ...current, ...changes };
  await runTransaction("readwrite", (store) => store.put(next));
  return next;
}

export async function claimLegacyCustomPdfs(username = getCurrentUsername()) {
  if (!username) return 0;
  const records = await runTransaction("readonly", (store) => store.getAll());
  const legacy = records.filter((record) => !record.username);
  for (const record of legacy) {
    await runTransaction("readwrite", (store) => store.put({ ...record, username }));
  }
  return legacy.length;
}

// ---------------- 解析缓存 ----------------
// identity = fingerprint + parserVersion。缓存只存解析结果（不含 File）。
// 人工修正后的资源保存在 custom-pdfs，不会被自动重新解析覆盖；缓存失败可
// 退化为重新解析，不阻断主流程。

export function parseCacheKey(fingerprint, parserVersion) {
  return `${fingerprint}:${parserVersion}`;
}

export async function getParseCache(fingerprint, parserVersion) {
  if (!fingerprint) return null;
  const cached = await runTransaction(
    "readonly",
    (store) => store.get(parseCacheKey(fingerprint, parserVersion)),
    CACHE_STORE,
  );
  return cached?.analysis || null;
}

export async function setParseCache(fingerprint, parserVersion, analysis) {
  if (!fingerprint || !analysis) return;
  const record = {
    cacheKey: parseCacheKey(fingerprint, parserVersion),
    fingerprint,
    parserVersion,
    analysis,
    cachedAt: Date.now(),
  };
  await runTransaction("readwrite", (store) => store.put(record), CACHE_STORE);
}

export async function clearParseCache(fingerprint) {
  if (!fingerprint) return 0;
  const records = await runTransaction(
    "readonly",
    (store) => store.index("fingerprint").getAll(fingerprint),
    CACHE_STORE,
  );
  for (const record of records) {
    await runTransaction("readwrite", (store) => store.delete(record.cacheKey), CACHE_STORE);
  }
  return records.length;
}

function unknownWordId(username, resourceId, passageId, normalizedWord) {
  return `${encodeURIComponent(username)}::${resourceId}::${passageId}::${normalizedWord}`;
}

export async function listUnknownWords() {
  const username = getCurrentUsername();
  if (!username) return [];
  const records = await runTransaction(
    "readonly",
    (store) => store.index("username").getAll(username),
    UNKNOWN_STORE,
  );
  return records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function toggleUnknownWord(entry) {
  const username = getCurrentUsername();
  if (!username) throw new Error("请先登录账号");
  const id = unknownWordId(username, entry.resourceId, entry.passageId, entry.normalizedWord);
  const current = await runTransaction("readonly", (store) => store.get(id), UNKNOWN_STORE);
  const occurrences = new Set(current?.occurrences || []);
  if (occurrences.has(entry.occurrenceId)) occurrences.delete(entry.occurrenceId);
  else occurrences.add(entry.occurrenceId);
  if (!occurrences.size) {
    await runTransaction("readwrite", (store) => store.delete(id), UNKNOWN_STORE);
    emitAppEvent(AppEvent.UNKNOWN_WORDS_UPDATED);
    return null;
  }
  const next = {
    ...(current || {}),
    ...entry,
    id,
    username,
    occurrences: [...occurrences],
    createdAt: current?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await runTransaction("readwrite", (store) => store.put(next), UNKNOWN_STORE);
  emitAppEvent(AppEvent.UNKNOWN_WORDS_UPDATED);
  return next;
}

export async function updateUnknownWordMeaning(id, meaning) {
  const current = await runTransaction("readonly", (store) => store.get(id), UNKNOWN_STORE);
  if (!current || current.username !== getCurrentUsername()) throw new Error("陌生词不存在");
  await runTransaction(
    "readwrite",
    (store) => store.put({ ...current, meaning: String(meaning || "").trim(), updatedAt: Date.now() }),
    UNKNOWN_STORE,
  );
  emitAppEvent(AppEvent.UNKNOWN_WORDS_UPDATED);
}

// A read and its merge must share a transaction: rapid adds cannot lose a sense.
async function mutateUnknownWord(id, username, mutate, isCurrent = () => true) {
  const db = await openWuliaoEnglishDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(UNKNOWN_STORE, "readwrite");
    const store = transaction.objectStore(UNKNOWN_STORE);
    let result = null;
    const request = store.get(id);
    request.onsuccess = () => {
      if (username !== getCurrentUsername() || !isCurrent()) return;
      const current = request.result;
      if (current && current.username !== username) return;
      try {
        result = mutate(current);
        if (result) store.put(result);
      } catch (reason) { transaction.abort(); reject(reason); }
    };
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onerror = transaction.onabort = () => {
      db.close(); reject(transaction.error || new Error("陌生词保存失败"));
    };
  });
}

export function upsertUnknownContextSense(current, entry, now = Date.now()) {
  const senses = [...(current?.senses || [])];
  const index = senses.findIndex((sense) => sense.contextKey === entry.contextKey);
  const previous = senses[index];
  const occurrenceIds = [...new Set([...(previous?.occurrenceIds || []), ...(entry.occurrenceIds || [])])];
  const sense = previous
    ? { ...previous, occurrenceIds, updatedAt: now }
    : { contextKey: entry.contextKey, sentence: entry.sentence, occurrenceIds,
      meaning: "", meaningSource: "pending-context", createdAt: now, updatedAt: now,
      meaningRevision: globalThis.crypto?.randomUUID?.() || `${now}:${Math.random()}` };
  if (index < 0) senses.push(sense);
  else senses[index] = sense;
  return { ...(current || {}), ...entry, senses,
    meaning: current?.meaning || senses.find((item) => item.meaning)?.meaning || "",
    occurrences: [...new Set([...(current?.occurrences || []), ...occurrenceIds])],
    createdAt: current?.createdAt || now, updatedAt: now };
}

export async function addUnknownWordContext(entry, { isCurrent } = {}) {
  const username = entry.username || getCurrentUsername();
  if (!username) throw new Error("请先登录账号");
  const normalizedWord = normalizeUnknownTerm(entry.word);
  if (!normalizedWord || !entry.contextKey || !entry.sentence) return null;
  const id = unknownWordId(username, entry.resourceId, entry.passageId, normalizedWord);
  const result = await mutateUnknownWord(id, username, (current) => upsertUnknownContextSense(current,
    { ...entry, id, username, normalizedWord }), isCurrent);
  if (result) emitAppEvent(AppEvent.UNKNOWN_WORDS_UPDATED);
  return result;
}

// A single-token gesture toggles its saved mark, including a phrase containing
// that token. Other sentence senses and legacy positions remain intact.
export async function toggleUnknownWordContext(entry, { isCurrent = () => true } = {}) {
  if (entry.occurrenceIds?.length !== 1) {
    const record = await addUnknownWordContext(entry, { isCurrent });
    return record ? { action: "added", record } : null;
  }
  const username = entry.username || getCurrentUsername();
  if (!username) throw new Error("请先登录账号");
  const normalizedWord = normalizeUnknownTerm(entry.word);
  if (!normalizedWord || !entry.contextKey || !entry.sentence) return null;
  const id = unknownWordId(username, entry.resourceId, entry.passageId, normalizedWord);
  const db = await openWuliaoEnglishDatabase();
  const result = await new Promise((resolve, reject) => {
    const transaction = db.transaction(UNKNOWN_STORE, "readwrite");
    const store = transaction.objectStore(UNKNOWN_STORE);
    const request = store.index("usernameResource").getAll([username, entry.resourceId]);
    let result = null;
    request.onsuccess = () => {
      if (username !== getCurrentUsername() || !isCurrent()) return;
      try {
        const records = request.result.filter((record) => record.passageId === entry.passageId);
        const occurrenceId = entry.occurrenceIds[0];
        const marked = records.filter((record) => record.occurrences?.includes(occurrenceId));
        if (marked.length) {
          for (const record of marked) {
            const removed = record.senses?.find((sense) => sense.contextKey === entry.contextKey
              && sense.occurrenceIds?.includes(occurrenceId));
            const removedIds = new Set(removed?.occurrenceIds || [occurrenceId]);
            const senses = record.senses?.filter((sense) => sense !== removed);
            const retainedIds = new Set(senses?.flatMap((sense) => sense.occurrenceIds || []));
            const occurrences = record.occurrences.filter((item) => !removedIds.has(item) || retainedIds.has(item));
            if (!occurrences.length) store.delete(record.id);
            else store.put({ ...record, occurrences, ...(senses ? { senses } : {}),
              meaning: senses?.length ? senses.find((sense) => sense.meaning)?.meaning || "" : record.meaning,
              updatedAt: Date.now() });
          }
          result = { action: "removed", record: null };
        } else {
          const record = upsertUnknownContextSense(records.find((record) => record.id === id),
            { ...entry, id, username, normalizedWord });
          store.put(record);
          result = { action: "added", record };
        }
      } catch (reason) { transaction.abort(); reject(reason); }
    };
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error || new Error("陌生词保存失败")); };
  });
  if (result) emitAppEvent(AppEvent.UNKNOWN_WORDS_UPDATED);
  return result;
}

export async function updateUnknownWordContextMeaning(id, contextKey, meaning, {
  username = getCurrentUsername(), meaningSource = "manual-context", expectedRevision, isCurrent,
} = {}) {
  const result = await mutateUnknownWord(id, username, (current) => {
    const index = current?.senses?.findIndex((sense) => sense.contextKey === contextKey) ?? -1;
    if (index < 0) return null; // Never recreate a deleted record or context.
    const previous = current.senses[index];
    if (expectedRevision !== undefined && previous.meaningRevision !== expectedRevision) return null;
    const senses = [...current.senses];
    senses[index] = { ...previous, meaning: String(meaning || "").trim(), meaningSource,
      meaningRevision: globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random()}`,
      updatedAt: Date.now() };
    return { ...current, senses, meaning: senses.find((sense) => sense.meaning)?.meaning || current.meaning || "",
      updatedAt: Date.now() };
  }, isCurrent);
  if (result) emitAppEvent(AppEvent.UNKNOWN_WORDS_UPDATED);
  return result;
}

export async function deleteUnknownWord(id) {
  const current = await runTransaction("readonly", (store) => store.get(id), UNKNOWN_STORE);
  if (!current || current.username !== getCurrentUsername()) throw new Error("陌生词不存在");
  await runTransaction("readwrite", (store) => store.delete(id), UNKNOWN_STORE);
  emitAppEvent(AppEvent.UNKNOWN_WORDS_UPDATED);
}
