import { memoryProgress, memoryState, advanceMemory, swipeDirection } from "./memory-modes.js";
import { withMemoryProgress } from "./memory-record.js";
import { createWordSaveQueue } from "./word-save-queue.js";
import { interactionTiming } from "./interaction-timing.js";
import { UNKNOWN_LIST_KEY, isUnknownWordId, readUnknownWordList } from "./unknown-word-list.js";
const CURRENT_USER_KEY = "kaoyan_vocab_current_user";
const MAIN_DB_NAME = "KaoyanVocabDB";
const MEMORY_DB_NAME = "KaoyanVocabMemorizeDB";
const MEMORY_STORE = "records";
const IMPORT_LIST_STORE = "importedLists";
const IMPORT_WORD_STORE = "importedWords";
const MEMORY_DB_VERSION = 2;
const PROGRESS_KEY_PREFIX = "kaoyan_vocab_memorize_progress:";
const ROW_HEIGHT = 76;
const undoButton = document.getElementById("undoButton");
let saving = false;
let bulkSaving = false;
let bulkWrite = null;
let maskedCount = 0;
const todayRecordKeys = new Map();
let loadingList = false;
let listLoadVersion = 0;
const undoStack = [];
const OVERSCAN = 8;

const listSelect = document.getElementById("listSelect");
const clearButton = document.getElementById("clearButton");
const accountLabel = document.getElementById("accountLabel");
const listSummary = document.getElementById("listSummary");
const todaySummary = document.getElementById("todaySummary");
const maskSummary = document.getElementById("maskSummary");
const viewport = document.getElementById("viewport");
const spacer = document.getElementById("spacer");
const rowsLayer = document.getElementById("rowsLayer");
const message = document.getElementById("message");
const rangeButton = document.getElementById("rangeButton");
const rangePanel = document.getElementById("rangePanel");
const rangeDescription = document.getElementById("rangeDescription");
const rangeConfirm = document.getElementById("rangeConfirm");
const rangeCancel = document.getElementById("rangeCancel");

const state = {
  username: localStorage.getItem(CURRENT_USER_KEY) || "",
  rule: localStorage.getItem(`wuliao:memory:rule:${localStorage.getItem(CURRENT_USER_KEY)}`) === "cycle" ? "cycle" : "default",
  input: localStorage.getItem(`wuliao:memory:input:${localStorage.getItem(CURRENT_USER_KEY)}`) === "swipe" ? "swipe" : "click",
  lists: [],
  words: [],
  records: new Map(),
  currentListKey: "",
  assetMap: {},
  wordChunks: new Map(),
  todayDate: "",
  todayWordIds: new Set(),
  unknownWords: [],
  unknownWordMap: new Map(),
  unknownError: "",
};

let messageTimer = 0;
let saveScrollFrame = 0;
let positionReady = false;
let rangeStart = null;
let rangeEnd = null;
let rangeSelecting = false;
const renderedRows = new Map();

function progressStorageKey() {
  return `${PROGRESS_KEY_PREFIX}${state.username}`;
}

function readProgress() {
  try {
    const progress = JSON.parse(localStorage.getItem(progressStorageKey()));
    return progress && typeof progress === "object" ? progress : {};
  } catch {
    return {};
  }
}

function saveProgress() {
  if (!positionReady || !state.username || !state.currentListKey || !state.words.length) return;
  const progress = readProgress();
  const index = Math.min(state.words.length - 1, Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT)));
  progress.currentListKey = state.currentListKey;
  progress.scrollPositions = {
    ...(progress.scrollPositions || {}),
    [state.currentListKey]: viewport.scrollTop,
  };
  progress.positionAnchors = {
    ...(progress.positionAnchors || {}),
    [state.currentListKey]: { wordId: state.words[index].wordId, index, offset: viewport.scrollTop - index * ROW_HEIGHT },
  };
  localStorage.setItem(progressStorageKey(), JSON.stringify(progress));
}

function savedScrollTop(progress, listKey, words) {
  const anchor = progress.positionAnchors?.[listKey];
  const offset = Number.isFinite(anchor?.offset) ? Math.max(0, Math.min(ROW_HEIGHT - 1, anchor.offset)) : 0;
  if (typeof anchor?.wordId === "string") {
    const index = words.findIndex((word) => word.wordId === anchor.wordId);
    if (index >= 0) return index * ROW_HEIGHT + offset;
  }
  if (Number.isInteger(anchor?.index) && anchor.index >= 0 && anchor.index < words.length) {
    return anchor.index * ROW_HEIGHT + offset;
  }
  const legacy = progress.scrollPositions?.[listKey];
  return Number.isFinite(legacy) ? Math.max(0, legacy) : 0;
}

function showMessage(text) {
  window.clearTimeout(messageTimer);
  message.textContent = text;
  message.classList.remove("hidden");
  messageTimer = window.setTimeout(() => message.classList.add("hidden"), 2200);
}

function speakWord(word) {
  if (window.WuliaoPronunciation) { window.WuliaoPronunciation.speak(word).catch(() => showMessage("发音暂不可用，请重试")); return; }
  if (window.AndroidSpeech?.speak) {
    window.AndroidSpeech.speak(word);
    return;
  }
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    showMessage("当前浏览器不支持单词朗读");
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = "en-US";
  utterance.rate = 0.85;
  window.speechSynthesis.speak(utterance);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function openExistingDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openMemoryDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MEMORY_DB_NAME, MEMORY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEMORY_STORE)) {
        const store = db.createObjectStore(MEMORY_STORE, { keyPath: "memoryKey" });
        store.createIndex("usernameList", ["username", "listKey"], { unique: false });
      }
      if (!db.objectStoreNames.contains(IMPORT_LIST_STORE)) {
        const store = db.createObjectStore(IMPORT_LIST_STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
      }
      if (!db.objectStoreNames.contains(IMPORT_WORD_STORE)) {
        const store = db.createObjectStore(IMPORT_WORD_STORE, { keyPath: "wordId" });
        store.createIndex("usernameList", ["username", "listKey"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readImportedLists() {
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(IMPORT_LIST_STORE, "readonly");
    const index = transaction.objectStore(IMPORT_LIST_STORE).index("username");
    const lists = await requestToPromise(index.getAll(state.username));
    return lists.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } finally {
    db.close();
  }
}

async function readImportedWords(wordIds) {
  if (!wordIds.length) return [];
  const wanted = new Set(wordIds);
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(IMPORT_WORD_STORE, "readonly");
    const words = await requestToPromise(transaction.objectStore(IMPORT_WORD_STORE).getAll());
    return words.filter((word) => word.username === state.username && wanted.has(word.wordId));
  } finally {
    db.close();
  }
}

async function readWordLists() {
  const db = await openExistingDatabase(MAIN_DB_NAME);
  try {
    if (!db.objectStoreNames.contains("wordLists")) return [];
    const transaction = db.transaction("wordLists", "readonly");
    const all = await requestToPromise(transaction.objectStore("wordLists").getAll());
    return all
      .filter((list) => list.username === state.username && Array.isArray(list.wordIds))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } finally {
    db.close();
  }
}

async function loadAssetMap() {
  const response = await fetch("/vocabulary/word-assets.json", { cache: "no-store" });
  if (!response.ok) throw new Error("词库文件索引加载失败");
  state.assetMap = await response.json();
}

async function loadChunk(chunkIndex) {
  if (state.wordChunks.has(chunkIndex)) return state.wordChunks.get(chunkIndex);
  const key = `chunk_${String(chunkIndex).padStart(3, "0")}`;
  const path = state.assetMap[key];
  if (!path) throw new Error(`缺少词库分块 ${key}`);
  const module = await import(path);
  const chunk = module.default;
  state.wordChunks.set(chunkIndex, chunk);
  return chunk;
}

function chunkIndexForWordId(wordId) {
  return Math.floor(Number.parseInt(String(wordId).split("_")[1], 10) / 500);
}

async function loadWords(wordIds) {
  const builtInIds = wordIds.filter((wordId) => !String(wordId).startsWith("import:") && !isUnknownWordId(wordId));
  const importedIds = wordIds.filter((wordId) => String(wordId).startsWith("import:"));
  const chunkIndexes = [...new Set(builtInIds.map(chunkIndexForWordId))];
  const chunks = await Promise.all(chunkIndexes.map(loadChunk));
  const wordMap = new Map();
  chunks.forEach((chunk) => {
    chunk.entries.forEach((entry) => wordMap.set(entry.wordId, entry));
  });
  (await readImportedWords(importedIds)).forEach((entry) => wordMap.set(entry.wordId, entry));
  wordIds.filter(isUnknownWordId).forEach((id) => {
    if (state.unknownWordMap.has(id)) wordMap.set(id, state.unknownWordMap.get(id));
  });
  return wordIds.map((wordId) => wordMap.get(wordId)).filter(Boolean);
}

async function getOriginalWordIds() {
  const chunks = await Promise.all(
    Object.keys(state.assetMap)
      .sort()
      .map((key) => loadChunk(Number.parseInt(key.slice(-3), 10)))
  );
  return chunks.flatMap((chunk) => chunk.entries.map((entry) => entry.wordId));
}

async function readMemoryRecords(listKey) {
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(MEMORY_STORE, "readonly");
    const index = transaction.objectStore(MEMORY_STORE).index("usernameList");
    const records = await requestToPromise(
      index.getAll(IDBKeyRange.only([state.username, listKey]))
    );
    return new Map(records.map((record) => [record.wordId, record]));
  } finally {
    db.close();
  }
}

async function readAllUserMemoryRecords() {
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(MEMORY_STORE, "readonly");
    const records = await requestToPromise(transaction.objectStore(MEMORY_STORE).getAll());
    return records.filter((record) => record.username === state.username);
  } finally {
    db.close();
  }
}

function recordDates(record) {
  if (Array.isArray(record.maskedDates) && record.maskedDates.length) {
    return [...new Set(record.maskedDates.filter(Boolean))];
  }
  const timestamp = record.maskedAt || (record.clickCount >= 3 ? record.updatedAt : 0);
  return timestamp ? [localDateKey(timestamp)] : [];
}

function updateTodaySummary() {
  todaySummary.textContent = `今日背词 ${state.todayWordIds.size} 个`;
}

async function refreshTodaySummary() {
  try {
    const today = localDateKey();
    const records = await readAllUserMemoryRecords();
    if (!isCurrentAccount()) return;
    state.todayDate = today;
    state.todayWordIds = new Set(
      records
        .filter((record) => recordDates(record).includes(today))
        .map((record) => record.wordId)
    );
    todayRecordKeys.clear();
    for (const record of records) {
      if (!recordDates(record).includes(today)) continue;
      if (!todayRecordKeys.has(record.wordId)) todayRecordKeys.set(record.wordId, new Set());
      todayRecordKeys.get(record.wordId).add(record.memoryKey);
    }
    updateTodaySummary();
  } catch (error) {
    todaySummary.textContent = "今日背词 --";
    console.error(error);
  }
}

async function saveMemoryRecord(record) {
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(MEMORY_STORE, "readwrite");
    transaction.objectStore(MEMORY_STORE).put(record);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

async function saveRecords(records) {
  const db = await openMemoryDatabase();
  try {
    const tx = db.transaction(MEMORY_STORE, "readwrite");
    const committed = transactionDone(tx);
    try {
      const store = tx.objectStore(MEMORY_STORE);
      for (const record of records) store.put(record);
    } catch (error) {
      tx.abort();
      await committed.catch(() => {});
      throw error;
    }
    await committed;
  } finally { db.close(); }
}

function withProgress(previous, wordId, step) {
  return withMemoryProgress(previous, wordId, step, { username: state.username, listKey: state.currentListKey });
}

function refreshModes() {
  document.querySelectorAll("[data-memory-rule]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.memoryRule === state.rule));
    button.disabled = saving || loadingList;
  });
  document.querySelectorAll("[data-memory-input]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.memoryInput === state.input));
    button.disabled = saving || loadingList;
  });
  viewport.dataset.input = state.input;
  undoButton.disabled = saving || loadingList || !undoStack.length;
  clearButton.disabled = saving || loadingList;
  listSelect.disabled = saving || loadingList;
  rangeButton.disabled = saving || loadingList;
  rangeConfirm.disabled = saving || loadingList || rangeStart === null || rangeEnd === null;
  rangeCancel.disabled = saving || loadingList;
}

function cancelRange() {
  rangeSelecting = false;
  rangeStart = null;
  rangeEnd = null;
  rangePanel.classList.add("hidden");
  rangeButton.setAttribute("aria-pressed", "false");
  renderVisibleRows(true);
  refreshModes();
}

function selectRangeEndpoint(index) {
  if (saving || loadingList || !rangeSelecting) return;
  if (rangeStart === null || rangeEnd !== null) {
    rangeStart = index;
    rangeEnd = null;
  } else {
    rangeEnd = index;
  }
  const start = state.words[rangeStart];
  const end = rangeEnd === null ? null : state.words[rangeEnd];
  rangeDescription.textContent = end
    ? `起点：${start.english}　终点：${end.english}　共 ${Math.abs(rangeEnd - rangeStart) + 1} 个词`
    : `起点：${start.english}　请选择终点`;
  renderVisibleRows(true);
  refreshModes();
}

rangeButton.addEventListener("click", () => {
  if (saving || loadingList) return;
  rangeSelecting = true;
  rangeStart = null;
  rangeEnd = null;
  rangeDescription.textContent = "请选择起点";
  rangePanel.classList.remove("hidden");
  rangeButton.setAttribute("aria-pressed", "true");
  renderVisibleRows(true);
  refreshModes();
});
rangeCancel.addEventListener("click", cancelRange);

rangeConfirm.addEventListener("click", async () => {
  if (saving || loadingList || !rangeSelecting || rangeStart === null || rangeEnd === null) return;
  bulkSaving = true;
  saving = true;
  refreshModes();
  try {
    await wordSaves.flush();
    if (state.todayDate !== localDateKey()) await refreshTodaySummary();
    const first = Math.min(rangeStart, rangeEnd);
    const last = Math.max(rangeStart, rangeEnd);
    const entries = state.words.slice(first, last + 1)
      .filter((word) => !memoryState(state.records.get(word.wordId)).locked)
      .map((word) => ({ wordId: word.wordId, step: memoryProgress(state.records.get(word.wordId)) }));
    if (entries.length) {
      const records = entries.map(({ wordId }) => withProgress(state.records.get(wordId), wordId, 5));
      bulkWrite = saveRecords(records);
      await bulkWrite;
      for (const record of records) state.records.set(record.wordId, record);
      undoStack.push(entries);
      await refreshTodaySummary();
      window.VocabularyBridge?.reportSessionUpdated?.();
    }
    const total = last - first + 1;
    cancelRange();
    showMessage(`已完成 ${entries.length} 个词，原已完成 ${total - entries.length} 个`);
  } catch (error) {
    console.error(error);
    showMessage("区间保存失败，未完成全黑，请重试");
  } finally {
    bulkWrite = null;
    bulkSaving = false;
    saving = false;
    renderVisibleRows(true);
    updateSummary();
    refreshModes();
  }
});

function updateWordRow(wordId) {
  for (const [index, row] of renderedRows) {
    if (state.words[index]?.wordId !== wordId) continue;
    const next = createRow(state.words[index], index);
    row.replaceWith(next); renderedRows.set(index, next); break;
  }
}
const wordSaves = createWordSaveQueue({
  read: (id) => state.records.get(id) || {}, write: saveMemoryRecord,
  display(id, record) {
    const before = state.records.get(id);
    maskedCount += Number(memoryState(record, state.rule).masked) - Number(memoryState(before, state.rule).masked);
    state.records.set(id, record);
    const keys = todayRecordKeys.get(id) || new Set();
    const key = `${state.username}:${state.currentListKey}:${id}`;
    if (recordDates(record).includes(state.todayDate)) keys.add(key); else keys.delete(key);
    todayRecordKeys.set(id, keys);
    if (keys.size) state.todayWordIds.add(id); else state.todayWordIds.delete(id);
    updateWordRow(id); updateTodaySummary(); updateSummary(false);
  },
  saved(id, before) {
    undoStack.push([{ wordId: id, step: memoryProgress(before, state.rule) }]);
    window.VocabularyBridge?.reportSessionUpdated?.();
  },
  failed() { showMessage("记录保存失败，已恢复对应操作，请重试"); },
  busy(value) { saving = value || bulkSaving; refreshModes(); },
});
window.__wuliaoFlushVocabulary = async () => { await Promise.all([wordSaves.flush(), bulkWrite]); saveProgress(); };
async function changeWord(wordId, direction) {
  if (!isCurrentAccount() || bulkSaving || loadingList || rangeSelecting) return;
  if (state.todayDate !== localDateKey()) {
    await wordSaves.flush(); await refreshTodaySummary();
  }
  const before = state.records.get(wordId) || {};
  if (advanceMemory(before, state.rule, direction) === memoryProgress(before, state.rule)) return;
  const timing = interactionTiming('memorize');
  const pending = wordSaves.enqueue(wordId, (record) => withProgress(record, wordId, advanceMemory(record, state.rule, direction)));
  timing.feedback();
  await timing.save(() => pending).catch(() => {});
}

function updateSummary(reconcile = true) {
  if (reconcile) {
    const records = state.currentListKey === UNKNOWN_LIST_KEY
      ? state.words.map((word) => state.records.get(word.wordId))
      : [...state.records.values()];
    maskedCount = records.filter((record) => memoryState(record, state.rule).masked).length;
  }
  listSummary.textContent = `共 ${state.words.length} 个单词，按词库原顺序排列`;
  maskSummary.textContent = `已遮挡 ${maskedCount} 个`;
  if (state.currentListKey === UNKNOWN_LIST_KEY) {
    listSummary.textContent = state.unknownError || (state.words.length
      ? "共 " + state.words.length + " 个词条，按英文排序"
      : "陌生词库为空，请在精读或完形中添加陌生词");
  }
}

function createRow(word, index) {
  const { count, masked, locked } = memoryState(state.records.get(word.wordId), state.rule);
  const row = document.createElement("div");
  row.className = `word-row${index % 2 ? " is-alternate" : ""}${masked ? " masked" : ""}${rangeSelecting && (index === rangeStart || index === rangeEnd) ? " range-selected" : ""}`;
  row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  row.dataset.wordId = word.wordId;
  const content = document.createElement("div");
  content.className = "word-content";
  const english = document.createElement("span");
  english.className = `english${masked ? "" : " speakable-word"}`;
  english.textContent = word.english;
  english.tabIndex = masked ? -1 : 0;
  if (masked) english.setAttribute("aria-hidden", "true");
  else { english.setAttribute("role", "button"); english.setAttribute("aria-label", `朗读 ${word.english}`); }
  let suppressClickUntil = 0;
  english.addEventListener("click", () => { if (!masked && Date.now() > suppressClickUntil) speakWord(word.english); });
  english.addEventListener("keydown", (event) => {
    if (!masked && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); speakWord(word.english); }
  });
  const chinese = document.createElement("span");
  chinese.className = "chinese";
  chinese.textContent = word.chinese || (isUnknownWordId(word.wordId) ? "暂无释义" : "");
  if (masked) chinese.setAttribute("aria-hidden", "true");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mark-button";
  button.textContent = rangeSelecting
    ? (rangeStart === null || rangeEnd !== null ? "设为起点" : "设为终点")
    : state.rule === "cycle" ? (locked ? "已完成 3/3" : `${masked ? "揭开" : "记录"} ${count}/3`) : `记录 ${count}/3`;
  button.disabled = bulkSaving || loadingList || (!rangeSelecting && (locked || state.input === "swipe"));
  if (!rangeSelecting && state.input === "swipe" && !locked) button.textContent = state.rule === "cycle" && masked ? "← 左滑揭开" : "右滑遮挡 →";
  button.addEventListener("click", () => rangeSelecting ? selectRangeEndpoint(index) : changeWord(word.wordId, "click"));
  let start = null;
  content.addEventListener("pointerdown", (event) => {
    if (rangeSelecting || state.input !== "swipe" || locked || bulkSaving || loadingList || !event.isPrimary || event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
  });
  content.addEventListener("pointermove", (event) => {
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.abs(dx) >= 20 && Math.abs(dx) > Math.abs(dy) * 1.7) content.setPointerCapture(event.pointerId);
    if (Math.abs(dy) > 16 && Math.abs(dy) > Math.abs(dx)) start = null;
  });
  content.addEventListener("pointercancel", () => { start = null; });
  content.addEventListener("pointerup", (event) => {
    if (!start || start.id !== event.pointerId) return;
    const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y);
    start = null;
    if (direction) { suppressClickUntil = Date.now() + 500; event.preventDefault(); changeWord(word.wordId, direction); }
  });
  content.append(english, chinese);
  row.append(content, button);
  return row;
}

function renderVisibleRows(force = false) {
  const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT);
  const start = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(state.words.length, start + visibleCount + OVERSCAN * 2);
  if (force) {
    renderedRows.clear();
    rowsLayer.replaceChildren();
  }

  for (const [index, row] of renderedRows) {
    if (index >= start && index < end) continue;
    row.remove();
    renderedRows.delete(index);
  }

  for (let index = start; index < end; index += 1) {
    if (renderedRows.has(index)) continue;
    const row = createRow(state.words[index], index);
    renderedRows.set(index, row);
    let nextRow = null;
    for (let nextIndex = index + 1; nextIndex < end; nextIndex += 1) {
      if (!renderedRows.has(nextIndex)) continue;
      nextRow = renderedRows.get(nextIndex);
      break;
    }
    rowsLayer.insertBefore(row, nextRow);
  }
}

function isCurrentAccount() {
  return state.username === (localStorage.getItem(CURRENT_USER_KEY)?.trim() || "");
}

function applyUnknownSnapshot(snapshot) {
  state.unknownWords = snapshot.words;
  state.unknownWordMap = snapshot.wordMap;
  state.unknownError = snapshot.error;
  let list = state.lists.find((item) => item.key === UNKNOWN_LIST_KEY);
  if (!list) {
    list = { key: UNKNOWN_LIST_KEY, virtualUnknown: true };
    state.lists.push(list);
  }
  list.name = "陌生词库（" + snapshot.words.length + "词）";
  list.wordIds = snapshot.words.map((word) => word.wordId);
  let option = [...listSelect.options].find((item) => item.value === UNKNOWN_LIST_KEY);
  if (!option) {
    option = document.createElement("option");
    option.value = UNKNOWN_LIST_KEY;
    listSelect.append(option);
  }
  option.textContent = list.name;
}

let unknownRefreshTask = null;
let unknownRefreshPending = false;
let unknownRefreshVersion = 0;
let initialized = false;
function requestUnknownRefresh() {
  if (!isCurrentAccount()) return Promise.resolve();
  unknownRefreshPending = true;
  ++unknownRefreshVersion;
  if (!initialized) return Promise.resolve();
  if (unknownRefreshTask || loadingList) return unknownRefreshTask || Promise.resolve();
  unknownRefreshTask = (async () => {
    while (unknownRefreshPending && isCurrentAccount()) {
      unknownRefreshPending = false;
      const refreshVersion = unknownRefreshVersion;
      await window.__wuliaoFlushVocabulary();
      const snapshot = await readUnknownWordList(state.username);
      await window.__wuliaoFlushVocabulary();
      if (!isCurrentAccount()) return;
      if (loadingList) { unknownRefreshPending = true; break; }
      if (refreshVersion !== unknownRefreshVersion) continue;
      const changed = JSON.stringify(state.unknownWords) !== JSON.stringify(snapshot.words)
        || state.unknownError !== snapshot.error;
      applyUnknownSnapshot(snapshot);
      if (changed && state.currentListKey === UNKNOWN_LIST_KEY) {
        await selectList(UNKNOWN_LIST_KEY, { refreshUnknown: false });
      }
    }
  })().catch(() => showMessage("保存或读取失败，请重试后刷新陌生词库"))
    .finally(() => {
      unknownRefreshTask = null;
      if (unknownRefreshPending && !loadingList && isCurrentAccount()) queueMicrotask(requestUnknownRefresh);
    });
  return unknownRefreshTask;
}

async function selectList(listKey, { refreshUnknown = true } = {}) {
  if (!isCurrentAccount()) return;
  if (saving || loadingList) return;
  const version = ++listLoadVersion;
  const selected = state.lists.find((list) => list.key === listKey);
  if (!selected) return;

  saveProgress();
  window.cancelAnimationFrame(saveScrollFrame);
  const savedPosition = readProgress();
  positionReady = false;
  if (rangeSelecting) cancelRange();
  undoStack.length = 0;
  loadingList = true;
  state.words = [];
  renderedRows.clear();
  rowsLayer.replaceChildren();
  spacer.style.height = "0";
  refreshModes();
  state.currentListKey = listKey;
  listSelect.disabled = true;
  clearButton.disabled = true;
  listSummary.textContent = "正在加载单词…";
  maskSummary.textContent = "";

  try {
    if (selected.virtualUnknown && refreshUnknown) {
      const snapshot = await readUnknownWordList(state.username);
      if (version !== listLoadVersion || !isCurrentAccount()) return;
      applyUnknownSnapshot(snapshot);
    }
    const wordIds = selected.virtualOriginal
      ? await getOriginalWordIds()
      : selected.wordIds;
    const [words, records] = await Promise.all([
      loadWords(wordIds),
      readMemoryRecords(listKey),
    ]);
    if (version !== listLoadVersion || !isCurrentAccount()) return;
    state.words = words;
    state.records = records;
    spacer.style.height = `${state.words.length * ROW_HEIGHT}px`;
    if (state.words.length && !viewport.clientHeight) {
      await new Promise((resolve) => {
        const observer = new ResizeObserver(() => {
          if (viewport.clientHeight) { observer.disconnect(); resolve(); }
        });
        observer.observe(viewport);
      });
    }
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    if (version !== listLoadVersion || !isCurrentAccount()) return;
    const maxScrollTop = Math.max(0, state.words.length * ROW_HEIGHT - viewport.clientHeight);
    viewport.scrollTop = Math.min(savedScrollTop(savedPosition, listKey, state.words), maxScrollTop);
    renderVisibleRows(true);
    positionReady = true;
    updateSummary();
    await refreshTodaySummary();
    if (version !== listLoadVersion || !isCurrentAccount()) return;
    saveProgress();
    history.replaceState(null, "", `/vocabulary/memorize.html?list=${encodeURIComponent(listKey)}`);
  } catch (error) {
    console.error(error);
    state.words = [];
    renderedRows.clear();
    rowsLayer.replaceChildren();
    spacer.style.height = "0";
    listSummary.textContent = "词库加载失败";
    showMessage("词库加载失败，请重新打开页面");
  } finally {
    loadingList = false;
    refreshModes();
    renderVisibleRows(true);
    if (unknownRefreshPending && !unknownRefreshTask) requestUnknownRefresh();
  }
}

async function initialize() {
  if (!state.username) {
    document.body.innerHTML = `
      <main style="padding:40px 20px;text-align:center;font-family:Arial,'Microsoft YaHei',sans-serif">
        <h2>请先登录筛查器</h2>
        <p><a href="/vocabulary/index.html#/login">返回登录</a></p>
      </main>`;
    return;
  }

  accountLabel.textContent = state.username;
  await loadAssetMap();
  const [userLists, importedLists] = await Promise.all([readWordLists(), readImportedLists()]);
  const unknownSnapshot = await readUnknownWordList(state.username);
  if (!isCurrentAccount()) return;
  const mirroredImportIds = new Set(
    userLists.map((list) => list.sourceImportId).filter(Boolean)
  );
  state.lists = [
    {
      key: "original",
      name: "原始总词库（6515词）",
      virtualOriginal: true,
      wordIds: [],
    },
    ...userLists.map((list) => ({
      key: list.sourceListKey || `list-${list.id}`,
      name: `${list.name}（${list.wordIds.length}词）`,
      wordIds: list.wordIds,
    })),
    ...importedLists.filter((list) => !mirroredImportIds.has(list.id)).map((list) => ({
      key: list.listKey,
      name: `${list.name}（导入 ${list.wordIds.length}词）`,
      wordIds: list.wordIds,
      imported: true,
    })),
  ];

  listSelect.replaceChildren(
    ...state.lists.map((list) => {
      const option = document.createElement("option");
      option.value = list.key;
      option.textContent = list.name;
      return option;
    })
  );
  applyUnknownSnapshot(unknownSnapshot);

  const requestedKey = new URLSearchParams(location.search).get("list");
  const savedListKey = readProgress().currentListKey;
  const initialKey = state.lists.some((list) => list.key === requestedKey)
    ? requestedKey
    : state.lists.some((list) => list.key === savedListKey)
      ? savedListKey
      : state.lists[0].key;
  listSelect.value = initialKey;
  await selectList(initialKey);
  initialized = true;
  if (unknownRefreshPending) requestUnknownRefresh();
}

viewport.addEventListener("scroll", () => {
  renderVisibleRows();
  if (!positionReady) return;
  window.cancelAnimationFrame(saveScrollFrame);
  saveScrollFrame = window.requestAnimationFrame(saveProgress);
}, { passive: true });
window.addEventListener("resize", renderVisibleRows);
window.addEventListener("pagehide", saveProgress);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveProgress();
  else {
    requestUnknownRefresh();
    if (!saving && !loadingList) refreshTodaySummary();
  }
});
window.addEventListener("focus", requestUnknownRefresh);
window.addEventListener("pageshow", requestUnknownRefresh);
window.addEventListener("wuliao:unknown-words-refresh", (event) => {
  if (event.detail?.username === state.username) requestUnknownRefresh();
});
window.addEventListener("storage", (event) => {
  if (event.key !== CURRENT_USER_KEY || isCurrentAccount()) return;
  ++listLoadVersion;
  ++unknownRefreshVersion;
  positionReady = false;
  unknownRefreshPending = false;
  state.unknownWords = [];
  state.unknownWordMap.clear();
  state.unknownError = "";
  state.words = [];
  rowsLayer.replaceChildren();
  listSelect.disabled = true;
  window.__wuliaoFlushVocabulary().then(() => location.reload())
    .catch(() => showMessage("保存失败，请重试后切换账号"));
});
listSelect.addEventListener("change", () => selectList(listSelect.value));
async function resetProgress(entries, remember = false) {
  if (!isCurrentAccount()) return;
  if (state.currentListKey === UNKNOWN_LIST_KEY) {
    const visibleIds = new Set(state.words.map((word) => word.wordId));
    entries = entries.filter((entry) => visibleIds.has(entry.wordId));
  }
  if (saving || loadingList || !entries.length) return;
  saving = true; bulkSaving = true;
  refreshModes();
  const records = entries.map(({ wordId, step }) => withProgress(state.records.get(wordId), wordId, step));
  const previous = entries.map(({ wordId }) => ({ wordId, step: memoryProgress(state.records.get(wordId), state.rule) }));
  try {
    bulkWrite = saveRecords(records);
    await bulkWrite;
    records.forEach((record) => state.records.set(record.wordId, record));
    if (remember) undoStack.push(previous); else undoStack.pop();
    window.VocabularyBridge?.reportSessionUpdated?.();
  } catch { showMessage("保存失败，请重试"); }
  finally { bulkWrite = null; saving = false; bulkSaving = false; renderVisibleRows(true); updateSummary(); refreshModes(); }
}
clearButton.addEventListener("click", () => {
  if (!state.currentListKey || saving) return;
  const entries = [...state.records.keys()].filter((id) => memoryProgress(state.records.get(id), state.rule) > 0).map((wordId) => ({ wordId, step: 0 }));
  resetProgress(entries, true);
});
undoButton.addEventListener("click", () => resetProgress(undoStack.at(-1) || []));
document.querySelectorAll("[data-memory-rule], [data-memory-input]").forEach((button) => button.addEventListener("click", () => {
  if (saving || loadingList) return;
  if (button.dataset.memoryRule && button.dataset.memoryRule !== state.rule) state.rule = button.dataset.memoryRule;
  if (button.dataset.memoryInput) state.input = button.dataset.memoryInput;
  localStorage.setItem(`wuliao:memory:rule:${state.username}`, state.rule);
  localStorage.setItem(`wuliao:memory:input:${state.username}`, state.input);
  refreshModes(); renderVisibleRows(true); updateSummary();
}));
refreshModes();

initialize().catch((error) => {
  console.error(error);
  listSummary.textContent = "页面初始化失败";
  showMessage("初始化失败，请重新打开页面");
});
