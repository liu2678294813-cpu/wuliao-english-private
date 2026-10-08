// Read model only. unknown-words remains the sole source of word content.
export const UNKNOWN_LIST_KEY = "unknown-words";
export const isUnknownWordId = (id) => String(id || "").startsWith("unknown:");

export function normalizeUnknownListTerm(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").toLowerCase()
    .replace(/’/g, "'").replace(/\s+/g, " ").trim()
    .replace(/^[^a-z]+|[^a-z]+$/g, "");
}

const internalMeanings = new Set(["pending-context", "context-ai", "manual-context", "dictionary-fallback"]);
const compareText = (a, b) => String(a || "") < String(b || "") ? -1 : String(a || "") > String(b || "") ? 1 : 0;
const sourceOrder = (a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0)
  || compareText(a?.id || a?.contextKey, b?.id || b?.contextKey);

export function buildUnknownWordList(records, username) {
  if (!username) return [];
  const groups = new Map();
  for (const record of (Array.isArray(records) ? records : []).filter((row) => row?.username === username).sort(sourceOrder)) {
    const term = normalizeUnknownListTerm(record.normalizedWord) || normalizeUnknownListTerm(record.word);
    if (!term) continue;
    let entry = groups.get(term);
    if (!entry) {
      entry = { wordId: "unknown:" + term, english: term, meanings: new Set() };
      groups.set(term, entry);
    }
    const addMeaning = (value) => {
      if (typeof value !== "string" || internalMeanings.has(value.trim())) return;
      for (const meaning of value.split("；").map((text) => text.trim()).filter(Boolean)) {
        if (!internalMeanings.has(meaning)) entry.meanings.add(meaning);
      }
    };
    addMeaning(record.meaning);
    for (const sense of (Array.isArray(record.senses) ? record.senses : []).filter(Boolean).sort(sourceOrder)) {
      if (sense.meaningSource !== "pending-context") addMeaning(sense.meaning);
    }
  }
  return [...groups.values()].sort((a, b) => compareText(a.english, b.english))
    .map(({ wordId, english, meanings }) => ({ wordId, english, chinese: [...meanings].join("；") }));
}

export function filterResolvableUnknownRecords(records, words) {
  const available = new Set(words.filter((word) => word.chinese).map((word) => word.wordId));
  return records.filter((record) => !isUnknownWordId(record.wordId) || available.has(record.wordId));
}

export async function readUnknownWordList(username, { indexedDB = globalThis.indexedDB } = {}) {
  const empty = (error = "") => ({ words: [], wordMap: new Map(), error });
  if (!username) return empty();
  if (!indexedDB?.open) return empty("陌生词库读取失败，请重新打开页面");
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      let missing = false, settled = false;
      const request = indexedDB.open("wuliao-english");
      request.onupgradeneeded = () => {
        missing = true;
        request.transaction.abort();
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        if (missing) resolve(null);
        else reject(request.error || new Error("open-failed"));
      };
      request.onblocked = () => {
        settled = true;
        reject(new Error("blocked"));
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        resolve(request.result);
      };
    });
    if (!db || !db.objectStoreNames.contains("unknown-words")) return empty();
    db.onversionchange = () => db.close();
    const records = await new Promise((resolve, reject) => {
      const transaction = db.transaction("unknown-words", "readonly");
      const store = transaction.objectStore("unknown-words");
      const request = store.indexNames.contains("username")
        ? store.index("username").getAll(username)
        : store.getAll();
      let rows = [];
      request.onsuccess = () => { rows = request.result; };
      request.onerror = () => reject(request.error || new Error("read-failed"));
      transaction.oncomplete = () => resolve(rows);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error("read-failed"));
    });
    const words = buildUnknownWordList(records, username);
    return { words, wordMap: new Map(words.map((word) => [word.wordId, word])), error: "" };
  } catch {
    return empty("陌生词库读取失败，请重新打开页面");
  } finally { db?.close(); }
}
