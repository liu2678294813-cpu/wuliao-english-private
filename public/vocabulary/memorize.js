const CURRENT_USER_KEY = "kaoyan_vocab_current_user";
const MAIN_DB_NAME = "KaoyanVocabDB";
const MEMORY_DB_NAME = "KaoyanVocabMemorizeDB";
const MEMORY_STORE = "records";
const IMPORT_LIST_STORE = "importedLists";
const IMPORT_WORD_STORE = "importedWords";
const MEMORY_DB_VERSION = 2;
const PROGRESS_KEY_PREFIX = "kaoyan_vocab_memorize_progress:";
const AUTO_SPEAK_KEY = "wuliao:vocabulary:auto-pronounce";
const ROW_HEIGHT = 76;
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
const autoSpeakToggle = document.getElementById("autoSpeakToggle");

const state = {
  username: localStorage.getItem(CURRENT_USER_KEY) || "",
  lists: [],
  words: [],
  records: new Map(),
  currentListKey: "",
  assetMap: {},
  wordChunks: new Map(),
  todayDate: "",
  todayWordIds: new Set(),
};

let messageTimer = 0;
let saveScrollFrame = 0;

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
  if (!state.username || !state.currentListKey) return;
  const progress = readProgress();
  progress.currentListKey = state.currentListKey;
  progress.scrollPositions = {
    ...(progress.scrollPositions || {}),
    [state.currentListKey]: viewport.scrollTop,
  };
  localStorage.setItem(progressStorageKey(), JSON.stringify(progress));
}

function savedScrollTop(listKey) {
  const value = readProgress().scrollPositions?.[listKey];
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function showMessage(text) {
  window.clearTimeout(messageTimer);
  message.textContent = text;
  message.classList.remove("hidden");
  messageTimer = window.setTimeout(() => message.classList.add("hidden"), 2200);
}

function speakWord(word) {
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
  const builtInIds = wordIds.filter((wordId) => !String(wordId).startsWith("import:"));
  const importedIds = wordIds.filter((wordId) => String(wordId).startsWith("import:"));
  const chunkIndexes = [...new Set(builtInIds.map(chunkIndexForWordId))];
  const chunks = await Promise.all(chunkIndexes.map(loadChunk));
  const wordMap = new Map();
  chunks.forEach((chunk) => {
    chunk.entries.forEach((entry) => wordMap.set(entry.wordId, entry));
  });
  (await readImportedWords(importedIds)).forEach((entry) => wordMap.set(entry.wordId, entry));
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
    state.todayDate = today;
    state.todayWordIds = new Set(
      records
        .filter((record) => recordDates(record).includes(today))
        .map((record) => record.wordId)
    );
    updateTodaySummary();
  } catch (error) {
    todaySummary.textContent = "今日背词 --";
    console.error(error);
  }
}

function buildMemoryRecord(wordId, clickCount, previous = {}) {
  const now = Date.now();
  const newlyMasked = clickCount >= 3 && (previous.clickCount || 0) < 3;
  const maskedAt = newlyMasked ? now : previous.maskedAt;
  const maskedDates = new Set(Array.isArray(previous.maskedDates) ? previous.maskedDates : []);
  if (!maskedDates.size && previous.maskedAt) maskedDates.add(localDateKey(previous.maskedAt));
  if (!maskedDates.size && previous.clickCount >= 3 && previous.updatedAt) {
    maskedDates.add(localDateKey(previous.updatedAt));
  }
  if (newlyMasked) maskedDates.add(localDateKey(now));
  return {
    ...previous,
    memoryKey: `${state.username}:${state.currentListKey}:${wordId}`,
    username: state.username,
    listKey: state.currentListKey,
    wordId,
    clickCount,
    maskedAt,
    maskedDates: [...maskedDates],
    updatedAt: now,
  };
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

async function clearCurrentListRecords() {
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(MEMORY_STORE, "readwrite");
    const index = transaction.objectStore(MEMORY_STORE).index("usernameList");
    const request = index.openKeyCursor(
      IDBKeyRange.only([state.username, state.currentListKey])
    );
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      transaction.objectStore(MEMORY_STORE).delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

function updateSummary() {
  const masked = [...state.records.values()].filter((record) => record.clickCount >= 3).length;
  listSummary.textContent = `共 ${state.words.length} 个单词，按词库原顺序排列`;
  maskSummary.textContent = `已遮挡 ${masked} 个`;
}

function markButtonText(clickCount) {
  return `记录 ${Math.min(3, clickCount || 0)}/3`;
}

function createRow(word, index) {
  const record = state.records.get(word.wordId);
  const currentCount = record?.clickCount || 0;
  const masked = currentCount >= 3;
  const row = document.createElement("div");
  row.className = `word-row${masked ? " masked" : ""}`;
  row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  row.dataset.wordId = word.wordId;

  const content = document.createElement("div");
  content.className = "word-content";

  const english = document.createElement("span");
  english.className = "english speakable-word";
  english.textContent = word.english;
  english.title = "点击朗读";
  english.tabIndex = masked ? -1 : 0;
  english.setAttribute("role", "button");
  english.setAttribute("aria-label", `朗读 ${word.english}`);
  english.addEventListener("click", () => {
    if (!masked) speakWord(word.english);
  });
  english.addEventListener("keydown", (event) => {
    if (!masked && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      speakWord(word.english);
    }
  });

  const chinese = document.createElement("span");
  chinese.className = "chinese";
  chinese.textContent = word.chinese;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "mark-button";
  button.textContent = markButtonText(currentCount);
  button.disabled = masked;
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    const previous = state.records.get(word.wordId)?.clickCount || 0;
    const nextCount = Math.min(3, previous + 1);
    const nextRecord = buildMemoryRecord(word.wordId, nextCount, state.records.get(word.wordId));
    state.records.set(word.wordId, nextRecord);
    try {
      await saveMemoryRecord(nextRecord);
      if (nextCount >= 3) {
        row.classList.add("masked");
        button.textContent = markButtonText(nextCount);
        if (state.todayDate === localDateKey()) {
          state.todayWordIds.add(word.wordId);
          updateTodaySummary();
        } else {
          refreshTodaySummary();
        }
      } else {
        button.textContent = markButtonText(nextCount);
        button.disabled = false;
      }
      updateSummary();
    } catch (error) {
      state.records.set(word.wordId, record);
      button.textContent = markButtonText(record?.clickCount || 0);
      button.disabled = false;
      showMessage("记录保存失败，请重试");
      console.error(error);
    }
  });

  content.append(english, chinese);
  row.append(content, button);
  return row;
}

function renderVisibleRows() {
  const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT);
  const start = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(state.words.length, start + visibleCount + OVERSCAN * 2);
  const fragment = document.createDocumentFragment();

  for (let index = start; index < end; index += 1) {
    fragment.appendChild(createRow(state.words[index], index));
  }

  rowsLayer.replaceChildren(fragment);
}

async function selectList(listKey) {
  const selected = state.lists.find((list) => list.key === listKey);
  if (!selected) return;

  saveProgress();
  state.currentListKey = listKey;
  listSelect.disabled = true;
  clearButton.disabled = true;
  listSummary.textContent = "正在加载单词…";
  maskSummary.textContent = "";

  try {
    const wordIds = selected.virtualOriginal
      ? await getOriginalWordIds()
      : selected.wordIds;
    const [words, records] = await Promise.all([
      loadWords(wordIds),
      readMemoryRecords(listKey),
    ]);
    state.words = words;
    state.records = records;
    spacer.style.height = `${state.words.length * ROW_HEIGHT}px`;
    const maxScrollTop = Math.max(0, state.words.length * ROW_HEIGHT - viewport.clientHeight);
    viewport.scrollTop = Math.min(savedScrollTop(listKey), maxScrollTop);
    renderVisibleRows();
    updateSummary();
    await refreshTodaySummary();
    saveProgress();
    history.replaceState(null, "", `/vocabulary/memorize.html?list=${encodeURIComponent(listKey)}`);
  } catch (error) {
    console.error(error);
    state.words = [];
    rowsLayer.replaceChildren();
    spacer.style.height = "0";
    listSummary.textContent = "词库加载失败";
    showMessage("词库加载失败，请重新打开页面");
  } finally {
    listSelect.disabled = false;
    clearButton.disabled = false;
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

  const requestedKey = new URLSearchParams(location.search).get("list");
  const savedListKey = readProgress().currentListKey;
  const initialKey = state.lists.some((list) => list.key === requestedKey)
    ? requestedKey
    : state.lists.some((list) => list.key === savedListKey)
      ? savedListKey
      : state.lists[0].key;
  listSelect.value = initialKey;
  await selectList(initialKey);
}

viewport.addEventListener("scroll", () => {
  renderVisibleRows();
  window.cancelAnimationFrame(saveScrollFrame);
  saveScrollFrame = window.requestAnimationFrame(saveProgress);
}, { passive: true });
window.addEventListener("resize", renderVisibleRows);
window.addEventListener("pagehide", saveProgress);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveProgress();
});
listSelect.addEventListener("change", () => selectList(listSelect.value));
autoSpeakToggle.checked = localStorage.getItem(AUTO_SPEAK_KEY) === "true";
autoSpeakToggle.addEventListener("change", () => {
  localStorage.setItem(AUTO_SPEAK_KEY, String(autoSpeakToggle.checked));
  showMessage(autoSpeakToggle.checked ? "自动读音已开启" : "自动读音已关闭");
});
clearButton.addEventListener("click", async () => {
  if (!state.currentListKey) return;
  if (!window.confirm("确定清除当前词库的全部黑线和点击记录吗？")) return;
  clearButton.disabled = true;
  try {
    await clearCurrentListRecords();
    state.records.clear();
    renderVisibleRows();
    updateSummary();
    await refreshTodaySummary();
    showMessage("当前词库的黑线已全部清除");
  } catch (error) {
    console.error(error);
    showMessage("清除失败，请重试");
  } finally {
    clearButton.disabled = false;
  }
});

initialize().catch((error) => {
  console.error(error);
  listSummary.textContent = "页面初始化失败";
  showMessage("初始化失败，请重新打开页面");
});
