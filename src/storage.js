import { getCurrentUsername } from "./userData";

const DB_NAME = "wuliao-english";
const DB_VERSION = 2;
const STORE = "custom-pdfs";
const UNKNOWN_STORE = "unknown-words";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
      } else {
        const store = request.transaction.objectStore(STORE);
        if (!store.indexNames.contains("username")) store.createIndex("username", "username", { unique: false });
      }
      if (!request.result.objectStoreNames.contains(UNKNOWN_STORE)) {
        const store = request.result.createObjectStore(UNKNOWN_STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
        store.createIndex("usernameResource", ["username", "resourceId"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(mode, callback, storeName = STORE) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = callback(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      }),
  );
}

export async function addCustomPdf(file) {
  const username = getCurrentUsername();
  if (!username) throw new Error("请先登录账号");
  const yearMatch = file.name.match(/(?:19|20)\d{2}/);
  const id = globalThis.crypto?.randomUUID?.() || `custom-${Date.now()}-${Math.random()}`;
  const record = {
    id,
    kind: "custom",
    category: "custom",
    title: file.name.replace(/\.pdf$/i, ""),
    subtitle: yearMatch ? `${yearMatch[0]} · 自定义资料` : "自定义资料",
    year: yearMatch ? Number(yearMatch[0]) : null,
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
  return records.sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteCustomPdf(id) {
  const current = await runTransaction("readonly", (store) => store.get(id));
  if (!current || current.username !== getCurrentUsername()) throw new Error("自定义 PDF 不存在");
  return runTransaction("readwrite", (store) => store.delete(id));
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
    window.dispatchEvent(new Event("wuliao:unknown-words-updated"));
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
  window.dispatchEvent(new Event("wuliao:unknown-words-updated"));
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
  window.dispatchEvent(new Event("wuliao:unknown-words-updated"));
}

export async function deleteUnknownWord(id) {
  const current = await runTransaction("readonly", (store) => store.get(id), UNKNOWN_STORE);
  if (!current || current.username !== getCurrentUsername()) throw new Error("陌生词不存在");
  await runTransaction("readwrite", (store) => store.delete(id), UNKNOWN_STORE);
  window.dispatchEvent(new Event("wuliao:unknown-words-updated"));
}
