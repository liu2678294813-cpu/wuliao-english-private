const CURRENT_USER_KEY = "kaoyan_vocab_current_user";
const MEMORY_DB_NAME = "KaoyanVocabMemorizeDB";
const MEMORY_STORE = "records";
const IMPORT_LIST_STORE = "importedLists";
const IMPORT_WORD_STORE = "importedWords";
const MEMORY_DB_VERSION = 2;
const SESSION_KEY_PREFIX = "kaoyan_vocab_daily_review:";
const AUTO_SPEAK_KEY = "wuliao:vocabulary:auto-pronounce";
const OPTION_COUNT = 12;

const accountLabel = document.getElementById("accountLabel");
const dateSelect = document.getElementById("dateSelect");
const loadingState = document.getElementById("loadingState");
const emptyState = document.getElementById("emptyState");
const quiz = document.getElementById("quiz");
const completeState = document.getElementById("completeState");
const dateName = document.getElementById("dateName");
const positionLabel = document.getElementById("positionLabel");
const correctCount = document.getElementById("correctCount");
const wrongCount = document.getElementById("wrongCount");
const progressBar = document.getElementById("progressBar");
const wordButton = document.getElementById("wordButton");
const optionGrid = document.getElementById("optionGrid");
const skipButton = document.getElementById("skipButton");
const answerHint = document.getElementById("answerHint");
const completeTitle = document.getElementById("completeTitle");
const completeSummary = document.getElementById("completeSummary");
const restartButton = document.getElementById("restartButton");
const message = document.getElementById("message");
const autoSpeakToggle = document.getElementById("autoSpeakToggle");

const state = {
  username: localStorage.getItem(CURRENT_USER_KEY) || "",
  selectedDate: "",
  groups: new Map(),
  words: [],
  currentIndex: 0,
  correct: 0,
  wrong: 0,
  answered: false,
  assetMap: {},
  wordChunks: new Map(),
};

let messageTimer = 0;
let advanceTimer = 0;

function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateName(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return `${year}年${month}月${day}日背词复习词库`;
}

function recordDates(record) {
  if (Array.isArray(record.maskedDates) && record.maskedDates.length) {
    return [...new Set(record.maskedDates.filter(Boolean))];
  }
  const timestamp = record.maskedAt || (record.clickCount >= 3 ? record.updatedAt : 0);
  return timestamp ? [localDateKey(timestamp)] : [];
}

function sessionKey() {
  return `${SESSION_KEY_PREFIX}${state.username}:${state.selectedDate}`;
}

function readSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(sessionKey()));
    return saved && typeof saved === "object" ? saved : null;
  } catch {
    return null;
  }
}

function saveSession() {
  localStorage.setItem(sessionKey(), JSON.stringify({
    currentIndex: state.currentIndex,
    correct: state.correct,
    wrong: state.wrong,
    total: state.words.length,
    updatedAt: Date.now(),
  }));
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
  utterance.rate = 0.86;
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

async function readImportedWords(wordIds = null) {
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(IMPORT_WORD_STORE, "readonly");
    const words = await requestToPromise(transaction.objectStore(IMPORT_WORD_STORE).getAll());
    const wanted = wordIds ? new Set(wordIds) : null;
    return words.filter((word) => word.username === state.username && (!wanted || wanted.has(word.wordId)));
  } finally {
    db.close();
  }
}

async function readAllUserRecords() {
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(MEMORY_STORE, "readonly");
    const records = await requestToPromise(transaction.objectStore(MEMORY_STORE).getAll());
    return records.filter((record) => record.username === state.username);
  } finally {
    db.close();
  }
}

async function downgradeWrongWord(item) {
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(MEMORY_STORE, "readwrite");
    const store = transaction.objectStore(MEMORY_STORE);
    const now = Date.now();
    item.records.forEach((record) => {
      const dates = recordDates(record);
      store.put({
        ...record,
        clickCount: Math.min(2, record.clickCount || 0),
        maskedAt: record.maskedAt || (record.clickCount >= 3 ? record.updatedAt : undefined),
        maskedDates: dates,
        lastReviewDate: state.selectedDate,
        lastReviewResult: "wrong",
        reviewedAt: now,
        updatedAt: now,
      });
    });
    await transactionDone(transaction);
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
  state.wordChunks.set(chunkIndex, module.default);
  return module.default;
}

function numericWordId(wordId) {
  const numeric = Number.parseInt(String(wordId).split("_")[1], 10);
  if (Number.isFinite(numeric)) return numeric;
  return [...String(wordId)].reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 7);
}

function chunkIndexForWordId(wordId) {
  return Math.floor(numericWordId(wordId) / 500);
}

async function loadWords(items) {
  const builtInItems = items.filter((item) => !String(item.wordId).startsWith("import:"));
  const importedItems = items.filter((item) => String(item.wordId).startsWith("import:"));
  const chunkIndexes = [...new Set(builtInItems.map((item) => chunkIndexForWordId(item.wordId)))];
  const chunks = await Promise.all(chunkIndexes.map(loadChunk));
  const wordMap = new Map();
  chunks.forEach((chunk) => chunk.entries.forEach((entry) => wordMap.set(entry.wordId, entry)));
  (await readImportedWords(importedItems.map((item) => item.wordId))).forEach((entry) => wordMap.set(entry.wordId, entry));
  return items
    .map((item) => ({ ...item, word: wordMap.get(item.wordId) }))
    .filter((item) => item.word);
}

async function choicesForWord(word) {
  let candidates;
  if (String(word.wordId).startsWith("import:")) {
    candidates = (await readImportedWords()).filter((entry) => entry.wordId !== word.wordId && entry.chinese !== word.chinese);
    if (candidates.length < OPTION_COUNT - 1) {
      const fallback = await loadChunk(0);
      candidates.push(...fallback.entries.filter((entry) => entry.chinese !== word.chinese));
    }
  } else {
    const chunk = await loadChunk(chunkIndexForWordId(word.wordId));
    candidates = chunk.entries.filter((entry) => entry.wordId !== word.wordId && entry.chinese !== word.chinese);
  }
  const choices = [];
  const usedMeanings = new Set([word.chinese]);
  const seed = numericWordId(word.wordId);
  let cursor = candidates.length ? (seed * 17 + 7) % candidates.length : 0;
  while (choices.length < OPTION_COUNT - 1 && choices.length < candidates.length) {
    const candidate = candidates[cursor];
    if (!usedMeanings.has(candidate.chinese)) {
      usedMeanings.add(candidate.chinese);
      choices.push({ chinese: candidate.chinese, correct: false });
    }
    cursor = (cursor + 37) % candidates.length;
  }
  const correctIndex = seed % (choices.length + 1);
  choices.splice(correctIndex, 0, { chinese: word.chinese, correct: true });
  return choices;
}

function buildDateGroups(records) {
  const groups = new Map();
  records.forEach((record) => {
    recordDates(record).forEach((date) => {
      if (!groups.has(date)) groups.set(date, new Map());
      const words = groups.get(date);
      if (!words.has(record.wordId)) words.set(record.wordId, { wordId: record.wordId, records: [] });
      words.get(record.wordId).records.push(record);
    });
  });
  return new Map([...groups].map(([date, words]) => [date, [...words.values()]]));
}

function populateDateSelect() {
  const today = localDateKey();
  const dates = [...new Set([today, ...state.groups.keys()])].sort((a, b) => b.localeCompare(a));
  dateSelect.replaceChildren(...dates.map((date) => {
    const option = document.createElement("option");
    option.value = date;
    option.textContent = `${formatDateName(date)}（${state.groups.get(date)?.length || 0}词）`;
    return option;
  }));
}

function setVisible(target) {
  [loadingState, emptyState, quiz, completeState].forEach((element) => element.classList.add("hidden"));
  target.classList.remove("hidden");
}

function updateCounters() {
  const total = state.words.length;
  positionLabel.textContent = `${Math.min(state.currentIndex + 1, total)} / ${total}`;
  correctCount.textContent = state.correct;
  wrongCount.textContent = state.wrong;
  progressBar.style.width = `${total ? Math.min(100, state.currentIndex / total * 100) : 0}%`;
}

function finishReview() {
  saveSession();
  completeTitle.textContent = `${formatDateName(state.selectedDate)}筛查完成`;
  completeSummary.textContent = `共 ${state.words.length} 词，正确 ${state.correct}，错误 ${state.wrong}。错误词已取消黑线并恢复为 2/3。`;
  setVisible(completeState);
}

async function renderQuestion() {
  window.clearTimeout(advanceTimer);
  if (state.currentIndex >= state.words.length) {
    finishReview();
    return;
  }
  setVisible(quiz);
  state.answered = false;
  answerHint.textContent = "";
  skipButton.disabled = false;
  dateName.textContent = formatDateName(state.selectedDate);
  updateCounters();

  const item = state.words[state.currentIndex];
  wordButton.textContent = item.word.english;
  const choices = await choicesForWord(item.word);
  optionGrid.replaceChildren(...choices.map((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "review-option";
    button.textContent = choice.chinese;
    button.dataset.correct = String(choice.correct);
    button.dataset.optionIndex = String(index);
    button.addEventListener("click", () => answerQuestion(choice, button));
    return button;
  }));
  if (localStorage.getItem(AUTO_SPEAK_KEY) === "true") speakWord(item.word.english);
}

async function answerQuestion(choice, selectedButton) {
  if (state.answered) return;
  state.answered = true;
  skipButton.disabled = true;
  const item = state.words[state.currentIndex];
  const isCorrect = choice?.correct === true;
  const buttons = [...optionGrid.querySelectorAll(".review-option")];
  buttons.forEach((button) => {
    button.disabled = true;
    if (button.dataset.correct === "true") button.classList.add("correct");
  });
  if (!isCorrect && selectedButton) selectedButton.classList.add("wrong");

  if (isCorrect) {
    state.correct += 1;
    answerHint.textContent = "正确，原黑线保持不变";
  } else {
    state.wrong += 1;
    answerHint.textContent = `正确答案：${item.word.chinese}；该词黑线已取消`;
    try {
      await downgradeWrongWord(item);
    } catch (error) {
      console.error(error);
      showMessage("取消黑线失败，请重试本词");
      state.answered = false;
      skipButton.disabled = false;
      buttons.forEach((button) => { button.disabled = false; });
      return;
    }
  }

  state.currentIndex += 1;
  updateCounters();
  saveSession();
  advanceTimer = window.setTimeout(renderQuestion, isCorrect ? 260 : 1050);
}

async function selectDate(date) {
  state.selectedDate = date;
  dateSelect.value = date;
  history.replaceState(null, "", `/vocabulary/review.html?date=${encodeURIComponent(date)}`);
  setVisible(loadingState);
  const items = state.groups.get(date) || [];
  state.words = await loadWords(items);
  const saved = readSession();
  state.currentIndex = saved?.total === state.words.length ? Math.min(saved.currentIndex || 0, state.words.length) : 0;
  state.correct = saved?.total === state.words.length ? saved.correct || 0 : 0;
  state.wrong = saved?.total === state.words.length ? saved.wrong || 0 : 0;
  if (!state.words.length) {
    setVisible(emptyState);
    return;
  }
  await renderQuestion();
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
  const records = await readAllUserRecords();
  state.groups = buildDateGroups(records);
  populateDateSelect();
  const requested = new URLSearchParams(location.search).get("date");
  const initialDate = /^\d{4}-\d{2}-\d{2}$/.test(requested || "") ? requested : localDateKey();
  await selectDate(initialDate);
}

dateSelect.addEventListener("change", () => selectDate(dateSelect.value));
autoSpeakToggle.checked = localStorage.getItem(AUTO_SPEAK_KEY) === "true";
autoSpeakToggle.addEventListener("change", () => {
  localStorage.setItem(AUTO_SPEAK_KEY, String(autoSpeakToggle.checked));
  showMessage(autoSpeakToggle.checked ? "自动读音已开启" : "自动读音已关闭");
});
wordButton.addEventListener("click", () => speakWord(wordButton.textContent));
skipButton.addEventListener("click", () => answerQuestion(null, null));
restartButton.addEventListener("click", () => {
  localStorage.removeItem(sessionKey());
  state.currentIndex = 0;
  state.correct = 0;
  state.wrong = 0;
  renderQuestion();
});
window.addEventListener("pagehide", saveSession);

initialize().catch((error) => {
  console.error(error);
  loadingState.textContent = "复习词库加载失败，请重新打开页面";
  showMessage("复习词库加载失败");
});
