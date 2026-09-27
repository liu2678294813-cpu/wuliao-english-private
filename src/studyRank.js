import { getCurrentUsername, getUserItem, listUserItems, setUserItem } from "./userData";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";

const ACTIVITY_PREFIX = "wuliao:reading-activity:";
const MAIN_DB_NAME = "KaoyanVocabDB";
const MAIN_LIST_STORE = "wordLists";
const MEMORY_DB_NAME = "KaoyanVocabMemorizeDB";
const IMPORT_WORD_STORE = "importedWords";
const RANK_EVENT = AppEvent.RANK_UPDATED;
const VOCABULARY_TARGET = 6515;
const VOCABULARY_MAX_SCORE = 1500;
const READING_TARGET = 68;
const READING_MAX_SCORE = 1000;
const MAX_SCORE = VOCABULARY_MAX_SCORE + READING_MAX_SCORE;

export const RANKS = [
  { name: "启程", min: 0 },
  { name: "筑基", min: 250 },
  { name: "进阶", min: 625 },
  { name: "精读", min: 1000 },
  { name: "融会", min: 1500 },
  { name: "洞见", min: 2000 },
  { name: "登峰", min: 2250 },
];

function activityKey(resourceId, passageId) {
  return `${ACTIVITY_PREFIX}${resourceId}:${passageId}`;
}

function readJson(key, fallback = null) {
  try {
    return JSON.parse(getUserItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function writeActivity(resource, passage, updates) {
  const key = activityKey(resource.id, passage.id);
  const previous = readJson(key, {});
  setUserItem(key, JSON.stringify({
    ...previous,
    resourceId: resource.id,
    passageId: passage.id,
    title: resource.title,
    year: resource.year || null,
    text: resource.text || null,
    startedAt: previous.startedAt || Date.now(),
    updatedAt: Date.now(),
    ...updates,
  }));
  emitAppEvent(RANK_EVENT);
}

export function markReadingStarted(resource, passage) {  const current = readJson(activityKey(resource.id, passage.id));
  if (!current) writeActivity(resource, passage, { completed: false });
}

export function setReadingCompleted(resource, passage, completed) {
  writeActivity(resource, passage, {
    completed,
    completedAt: completed ? Date.now() : null,
  });
}

export function isReadingCompleted(resourceId, passageId) {
  return Boolean(readJson(activityKey(resourceId, passageId))?.completed);
}

function readReadingStats() {
  const records = [];
  for (const { key } of listUserItems(ACTIVITY_PREFIX)) {
    const record = readJson(key);
    if (record) records.push(record);
  }
  const started = records.length;
  const completed = records.filter((record) => record.completed).length;
  return { started, completed, completionRate: started ? completed / started : 0 };
}

// R3：复用 LearningStateSnapshot 的 activities（同一 revision 内不再重复
// 扫描 localStorage）。语义与 readReadingStats 完全一致。
function readingStatsFromSnapshot(scan) {
  const records = [];
  for (const record of scan?.activities?.values?.() || []) {
    if (record) records.push(record);
  }
  const started = records.length;
  const completed = records.filter((record) => record.completed).length;
  return { started, completed, completionRate: started ? completed / started : 0 };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openExistingDatabase(name) {
  return new Promise((resolve) => {
    let databaseWasMissing = false;
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      databaseWasMissing = true;
      request.transaction?.abort();
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      if (databaseWasMissing) {
        request.result.close();
        resolve(null);
      } else {
        resolve(request.result);
      }
    };
  });
}

async function readFamiliarWordIds(username) {
  const db = await openExistingDatabase(MAIN_DB_NAME);
  if (!db?.objectStoreNames.contains(MAIN_LIST_STORE)) {
    db?.close();
    return [];
  }
  try {
    const transaction = db.transaction(MAIN_LIST_STORE, "readonly");
    const lists = await requestToPromise(transaction.objectStore(MAIN_LIST_STORE).getAll());
    return [...new Set(
      lists
        .filter((list) => list.username === username && list.type === "familiar" && Array.isArray(list.wordIds))
        .flatMap((list) => list.wordIds)
        .filter((wordId) => typeof wordId === "string" && wordId),
    )];
  } finally {
    db.close();
  }
}

function normalizeEnglish(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
    : "";
}

async function readMainEnglishById(wordIds) {
  const chunkKeys = new Set(
    wordIds
      .map((wordId) => /^word_(\d+)$/.exec(wordId))
      .filter(Boolean)
      .map((match) => `chunk_${String(Math.floor(Number(match[1]) / 500)).padStart(3, "0")}`),
  );
  if (!chunkKeys.size) return new Map();

  const response = await fetch("/vocabulary/word-assets.json", { cache: "force-cache" });
  if (!response.ok) throw new Error(`Word asset manifest failed: ${response.status}`);
  const assets = await response.json();
  const wanted = new Set(wordIds);
  const entries = await Promise.all([...chunkKeys].map(async (chunkKey) => {
    const source = assets[chunkKey];
    if (!source) return [];
    const module = await import(/* @vite-ignore */ source);
    return module.default?.entries || [];
  }));
  return new Map(
    entries
      .flat()
      .filter((entry) => wanted.has(entry.wordId))
      .map((entry) => [entry.wordId, entry.english]),
  );
}

async function readImportedEnglishById(username, wordIds) {
  const importedIds = new Set(wordIds.filter((wordId) => wordId.startsWith("import:")));
  if (!importedIds.size) return new Map();

  const db = await openExistingDatabase(MEMORY_DB_NAME);
  if (!db?.objectStoreNames.contains(IMPORT_WORD_STORE)) {
    db?.close();
    return new Map();
  }
  try {
    const transaction = db.transaction(IMPORT_WORD_STORE, "readonly");
    const words = await requestToPromise(transaction.objectStore(IMPORT_WORD_STORE).getAll());
    return new Map(
      words
        .filter((word) => word.username === username && importedIds.has(word.wordId))
        .map((word) => [word.wordId, word.english]),
    );
  } finally {
    db.close();
  }
}

async function readFamiliarWordCount() {
  const username = getCurrentUsername();
  if (!username || !("indexedDB" in window)) return 0;
  try {
    const wordIds = await readFamiliarWordIds(username);
    const [mainEnglish, importedEnglish] = await Promise.all([
      readMainEnglishById(wordIds),
      readImportedEnglishById(username, wordIds),
    ]);
    const familiar = new Set(wordIds.map((wordId) => {
      const english = normalizeEnglish(mainEnglish.get(wordId) || importedEnglish.get(wordId));
      return english ? `word:${english}` : `id:${wordId}`;
    }));
    return familiar.size;
  } catch {
    return 0;
  }
}

function rankForScore(score) {
  const index = RANKS.findLastIndex((rank) => score >= rank.min);
  const rank = RANKS[Math.max(0, index)];
  const nextRank = RANKS[index + 1] || null;
  const progress = nextRank
    ? Math.round(((score - rank.min) / (nextRank.min - rank.min)) * 100)
    : 100;
  return { rank, nextRank, progress: Math.max(0, Math.min(100, progress)) };
}

export function calculateStudyScore(familiarWords, completed) {
  const vocabularyScore = Math.min(
    VOCABULARY_MAX_SCORE,
    Math.round((Math.max(0, familiarWords) / VOCABULARY_TARGET) * VOCABULARY_MAX_SCORE),
  );
  const readingScore = Math.min(
    READING_MAX_SCORE,
    Math.round((Math.max(0, completed) / READING_TARGET) * READING_MAX_SCORE),
  );
  return {
    score: Math.min(MAX_SCORE, vocabularyScore + readingScore),
    vocabularyScore,
    readingScore,
  };
}

export async function getStudyRank({ scan = null } = {}) {
  const [familiarWords, reading] = await Promise.all([
    readFamiliarWordCount(),
    Promise.resolve(scan ? readingStatsFromSnapshot(scan) : readReadingStats()),
  ]);
  const scores = calculateStudyScore(familiarWords, reading.completed);
  return {
    familiarWords,
    ...reading,
    ...scores,
    maxScore: MAX_SCORE,
    vocabularyTarget: VOCABULARY_TARGET,
    vocabularyMaxScore: VOCABULARY_MAX_SCORE,
    readingTarget: READING_TARGET,
    readingMaxScore: READING_MAX_SCORE,
    ...rankForScore(scores.score),
  };
}

export const studyRankEventName = RANK_EVENT;
