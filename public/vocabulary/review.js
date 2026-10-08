import { withMemoryProgress } from "./memory-record.js";
import { isUnknownWordId, readUnknownWordList, filterResolvableUnknownRecords } from "./unknown-word-list.js";

const CURRENT_USER_KEY = "kaoyan_vocab_current_user";
const MEMORY_DB_NAME = "KaoyanVocabMemorizeDB";
const MEMORY_STORE = "records";
const IMPORT_LIST_STORE = "importedLists";
const IMPORT_WORD_STORE = "importedWords";
const MEMORY_DB_VERSION = 2;
const SESSION_KEY_PREFIX = "kaoyan_vocab_daily_review:";
const AUTO_SPEAK_KEY = "wuliao:vocabulary:auto-pronounce";
const OPTION_COUNT = 12;
const DISTRACTOR_COUNT = OPTION_COUNT - 1;
const DISTRACTOR_POOL_LIMIT = 96;
const CONFUSING_DISTRACTOR_COUNT = Math.round(DISTRACTOR_COUNT * 0.64);
const CONFUSING_SCORE_THRESHOLD = 0.28;

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
  unknownWords: [],
  unknownWordMap: new Map(),
};

let messageTimer = 0;
let advanceTimer = 0;
let reviewVersion = 0;
let pendingReviewWrite = null;
let reviewRefreshTask = null;
let reviewRefreshPending = false;
let reviewRefreshVersion = 0;
let initialized = false;
const isCurrentAccount = () => state.username === (localStorage.getItem(CURRENT_USER_KEY)?.trim() || "");

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
    wordIds: state.words.map((item) => item.wordId),
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

async function readImportedWords(wordIds = null, listKey = null) {
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction(IMPORT_WORD_STORE, "readonly");
    const store = transaction.objectStore(IMPORT_WORD_STORE);
    const request = listKey && store.indexNames.contains("usernameList")
      ? store.index("usernameList").getAll(IDBKeyRange.only([state.username, listKey]))
      : store.getAll();
    const words = await requestToPromise(request);
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
        ...withMemoryProgress(record, record.wordId, 0, { username: record.username, listKey: record.listKey, now }),
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

function normalizedMeaning(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s、，,；;：:。.!！?？/\\|()[\]{}<>《》“”‘’]/g, "");
}

function meaningTokens(value) {
  return String(value ?? "")
    .toLocaleLowerCase()
    .split(/[\s、，,；;：:。.!！?？/\\|()[\]{}<>《》“”‘’]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function chineseCharacters(value) {
  return new Set([...String(value ?? "")].filter((character) => /[\u3400-\u9fff]/u.test(character)));
}

function overlapRatio(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  left.forEach((value) => {
    if (right.has(value)) overlap += 1;
  });
  return overlap / Math.min(left.size, right.size);
}

function chineseMeaningOverlap(target, candidate) {
  const targetMeaning = String(target?.chinese ?? "");
  const candidateMeaning = String(candidate?.chinese ?? "");
  if (!targetMeaning || !candidateMeaning) return 0;
  const tokenOverlap = overlapRatio(
    new Set(meaningTokens(targetMeaning)),
    new Set(meaningTokens(candidateMeaning)),
  );
  const characterOverlap = overlapRatio(
    chineseCharacters(targetMeaning),
    chineseCharacters(candidateMeaning),
  );
  return Math.min(1, Math.max(tokenOverlap, characterOverlap * 0.65));
}

function normalizedEnglish(value) {
  return String(value ?? "").toLocaleLowerCase().replace(/[^a-z]/g, "");
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[left.length - index - 1] === right[right.length - index - 1]) index += 1;
  return index;
}

function englishFormSimilarity(target, candidate) {
  const left = normalizedEnglish(target?.english);
  const right = normalizedEnglish(candidate?.english);
  if (!left || !right) return 0;
  const minimumLength = Math.min(left.length, right.length);
  if (minimumLength < 3) return 0;
  const prefixScore = commonPrefixLength(left, right) / minimumLength;
  const suffixScore = commonSuffixLength(left, right) / minimumLength;
  const lengthScore = 1 - Math.abs(left.length - right.length) / Math.max(left.length, right.length);
  return Math.min(1, Math.max(prefixScore, suffixScore * 0.9) * 0.8 + lengthScore * 0.2);
}

function sourceKeys(value) {
  if (!value || typeof value !== "object") return [];
  return ["listKey", "chunkKey", "chunk", "chunkIndex"]
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => ({ key, value: value[key] }))
    .filter(({ value }) => value !== undefined && value !== null && String(value) !== "")
    .map(({ key, value: source }) => {
      return `${key === "listKey" ? "list" : "chunk"}:${String(source)}`;
    });
}

function sourceKeysForWord(word, context = {}) {
  const directKeys = [...sourceKeys(word), ...sourceKeys(context)];
  const recordKeys = Array.isArray(context.records)
    ? context.records.flatMap((record) => sourceKeys(record))
    : [];
  const keys = [...directKeys, ...recordKeys];
  if (!keys.length && word?.wordId && !String(word.wordId).startsWith("import:")) {
    keys.push(`chunk:${chunkIndexForWordId(word.wordId)}`);
  }
  return [...new Set(keys)];
}

function singleImportedListKey(word, context = {}) {
  const keys = [
    word?.listKey,
    context?.listKey,
    ...(Array.isArray(context.records) ? context.records.map((record) => record?.listKey) : []),
  ]
    .filter((value) => value !== undefined && value !== null && String(value) !== "")
    .map((value) => String(value));
  const unique = [...new Set(keys)];
  return unique.length === 1 ? unique[0] : null;
}

function sharesSource(target, candidate, context = {}) {
  const targetKeys = sourceKeysForWord(target, context);
  const candidateKeys = sourceKeysForWord(candidate);
  return targetKeys.some((key) => candidateKeys.includes(key));
}

function distractorScore(target, candidate, context = {}) {
  const meaningScore = chineseMeaningOverlap(target, candidate);
  const formScore = englishFormSimilarity(target, candidate);
  const sourceScore = sharesSource(target, candidate, context) ? 0.12 : 0;
  return Math.min(1, meaningScore * 0.62 + formScore * 0.38 + sourceScore);
}

function randomUnit(rng) {
  const value = Number(rng?.());
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999999, Math.max(0, value));
}

function sampleWithoutReplacement(items, count, rng) {
  const pool = [...items];
  const selected = [];
  const targetCount = Math.min(Math.max(0, count), pool.length);
  for (let index = 0; index < targetCount; index += 1) {
    const offset = index + Math.floor(randomUnit(rng) * (pool.length - index));
    [pool[index], pool[offset]] = [pool[offset], pool[index]];
    selected.push(pool[index]);
  }
  return selected;
}

function candidatePool(target, candidates, rng) {
  const usedMeanings = new Set([normalizedMeaning(target?.chinese)]);
  const eligible = [];
  for (const candidate of candidates || []) {
    const meaning = normalizedMeaning(candidate?.chinese);
    if (!candidate?.wordId || candidate.wordId === target?.wordId || !meaning || usedMeanings.has(meaning)) {
      continue;
    }
    usedMeanings.add(meaning);
    eligible.push(candidate);
  }
  return sampleWithoutReplacement(eligible, DISTRACTOR_POOL_LIMIT, rng);
}

function selectDistractors(target, candidates, { rng = Math.random, context = {} } = {}) {
  const scored = candidatePool(target, candidates, rng)
    .map((candidate) => ({ candidate, score: distractorScore(target, candidate, context) }));
  const confusing = scored
    .filter((entry) => entry.score >= CONFUSING_SCORE_THRESHOLD)
    .sort((left, right) => right.score - left.score);
  const random = scored.filter((entry) => entry.score < CONFUSING_SCORE_THRESHOLD);
  const selected = [];
  const selectedIds = new Set();
  const add = (entries) => {
    entries.forEach((entry) => {
      if (selected.length >= DISTRACTOR_COUNT || selectedIds.has(entry.candidate.wordId)) return;
      selected.push(entry.candidate);
      selectedIds.add(entry.candidate.wordId);
    });
  };

  const confusingCount = Math.min(CONFUSING_DISTRACTOR_COUNT, confusing.length);
  add(sampleWithoutReplacement(confusing.slice(0, Math.max(confusingCount * 2, confusingCount)), confusingCount, rng));
  add(sampleWithoutReplacement(random, DISTRACTOR_COUNT - selected.length, rng));
  if (selected.length < DISTRACTOR_COUNT) {
    add(sampleWithoutReplacement(
      scored.filter((entry) => !selectedIds.has(entry.candidate.wordId)),
      DISTRACTOR_COUNT - selected.length,
      rng,
    ));
  }
  return selected;
}

function shuffle(items, rng) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const offset = Math.floor(randomUnit(rng) * (index + 1));
    [shuffled[index], shuffled[offset]] = [shuffled[offset], shuffled[index]];
  }
  return shuffled;
}

async function loadWords(items) {
  const builtInItems = items.filter((item) => !String(item.wordId).startsWith("import:") && !isUnknownWordId(item.wordId));
  const importedItems = items.filter((item) => String(item.wordId).startsWith("import:"));
  const chunkIndexes = [...new Set(builtInItems.map((item) => chunkIndexForWordId(item.wordId)))];
  const chunks = await Promise.all(chunkIndexes.map(loadChunk));
  const wordMap = new Map();
  chunks.forEach((chunk) => chunk.entries.forEach((entry) => wordMap.set(entry.wordId, entry)));
  (await readImportedWords(importedItems.map((item) => item.wordId))).forEach((entry) => wordMap.set(entry.wordId, entry));
  for (const item of items.filter((entry) => isUnknownWordId(entry.wordId))) {
    const word = state.unknownWordMap.get(item.wordId);
    if (word?.chinese) wordMap.set(item.wordId, word);
  }
  return items
    .map((item) => ({ ...item, word: wordMap.get(item.wordId) }))
    .filter((item) => item.word);
}

async function choicesForWord(word, context = {}) {
  let candidates;
  if (isUnknownWordId(word.wordId)) {
    candidates = state.unknownWords.filter((entry) => entry.chinese && entry.wordId !== word.wordId && entry.chinese !== word.chinese);
    const primary = selectDistractors(word, candidates, { context });
    if (primary.length < DISTRACTOR_COUNT) {
      const fallback = await loadChunk(0);
      const meanings = new Set([word.chinese, ...primary.map((entry) => entry.chinese)]);
      primary.push(...selectDistractors(word, fallback.entries.filter((entry) => !meanings.has(entry.chinese)), { context })
        .slice(0, DISTRACTOR_COUNT - primary.length));
    }
    return shuffle([...primary.map((entry) => ({ chinese: entry.chinese, correct: false })),
      { chinese: word.chinese, correct: true }], Math.random);
  } else if (String(word.wordId).startsWith("import:")) {
    candidates = (await readImportedWords(null, singleImportedListKey(word, context)))
      .filter((entry) => entry.wordId !== word.wordId && entry.chinese !== word.chinese);
    if (candidates.length < DISTRACTOR_COUNT) {
      const fallback = await loadChunk(0);
      candidates.push(...fallback.entries.filter((entry) => entry.chinese !== word.chinese));
    }
  } else {
    const chunk = await loadChunk(chunkIndexForWordId(word.wordId));
    candidates = chunk.entries.filter((entry) => entry.wordId !== word.wordId && entry.chinese !== word.chinese);
  }
  const rng = Math.random;
  const choices = selectDistractors(word, candidates, { rng, context })
    .map((candidate) => ({ chinese: candidate.chinese, correct: false }));
  choices.push({ chinese: word.chinese, correct: true });
  return shuffle(choices, rng);
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
  completeSummary.textContent = `共 ${state.words.length} 词，正确 ${state.correct}，错误 ${state.wrong}。错误词已取消黑线并恢复为 0/3。`;
  setVisible(completeState);
  window.VocabularyBridge?.reportSessionUpdated?.();
}

async function renderQuestion() {
  if (!isCurrentAccount()) return;
  const version = reviewVersion;
  window.clearTimeout(advanceTimer);
  if (state.currentIndex >= state.words.length) {
    finishReview();
    return;
  }
  setVisible(quiz);
  state.answered = false;
  answerHint.textContent = "";
  skipButton.disabled = true;
  optionGrid.replaceChildren();
  dateName.textContent = formatDateName(state.selectedDate);
  updateCounters();

  const item = state.words[state.currentIndex];
  wordButton.textContent = item.word.english;
  const choices = await choicesForWord(item.word, item);
  if (!isCurrentAccount() || version !== reviewVersion || state.words[state.currentIndex] !== item) return;
  optionGrid.replaceChildren(...choices.map((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "review-option";
    button.textContent = choice.chinese;
    button.dataset.correct = String(choice.correct);
    button.dataset.optionIndex = String(index);
    button.addEventListener("click", () => {
      if (version === reviewVersion && state.words[state.currentIndex] === item) answerQuestion(choice, button);
    });
    return button;
  }));
  skipButton.disabled = false;
  if (localStorage.getItem(AUTO_SPEAK_KEY) === "true") speakWord(item.word.english);
}

async function answerQuestion(choice, selectedButton) {
  if (!isCurrentAccount() || state.answered || pendingReviewWrite) return;
  const version = reviewVersion;
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
    try {
      pendingReviewWrite = downgradeWrongWord(item);
      await pendingReviewWrite;
    } catch (error) {
      console.error(error);
      showMessage("取消黑线失败，请重试本词");
      state.answered = false;
      skipButton.disabled = false;
      buttons.forEach((button) => { button.disabled = false; });
      return;
    } finally {
      pendingReviewWrite = null;
    }
    if (!isCurrentAccount() || version !== reviewVersion) return;
    state.wrong += 1;
    answerHint.textContent = `正确答案：${item.word.chinese}；该词黑线已取消`;
  }

  state.currentIndex += 1;
  updateCounters();
  saveSession();
  advanceTimer = window.setTimeout(renderQuestion, isCorrect ? 260 : 1050);
}

async function selectDate(date, { preserveWordId = "", previousIndex = 0 } = {}) {
  if (!isCurrentAccount()) return;
  const version = ++reviewVersion;
  state.selectedDate = date;
  dateSelect.value = date;
  history.replaceState(null, "", `/vocabulary/review.html?date=${encodeURIComponent(date)}`);
  setVisible(loadingState);
  const items = state.groups.get(date) || [];
  const words = await loadWords(items);
  if (!isCurrentAccount() || version !== reviewVersion) return;
  state.words = words;
  const saved = readSession();
  const sameWords = saved?.total === state.words.length && (Array.isArray(saved.wordIds)
    ? saved.wordIds.every((wordId, index) => wordId === state.words[index]?.wordId)
    : !state.words.some((item) => isUnknownWordId(item.wordId)));
  state.currentIndex = sameWords ? Math.min(saved.currentIndex || 0, state.words.length) : 0;
  state.correct = sameWords ? saved.correct || 0 : 0;
  state.wrong = sameWords ? saved.wrong || 0 : 0;
  if (preserveWordId) {
    const index = state.words.findIndex((item) => item.wordId === preserveWordId);
    state.currentIndex = index >= 0 ? index : Math.min(previousIndex, state.words.length);
  }
  if (!state.words.length) {
    setVisible(emptyState);
    return;
  }
  await renderQuestion();
}

async function readCurrentReviewSources() {
  const [records, snapshot] = await Promise.all([
    readAllUserRecords(), readUnknownWordList(state.username),
  ]);
  return { snapshot, groups: buildDateGroups(filterResolvableUnknownRecords(records, snapshot.words)) };
}

function requestReviewRefresh() {
  if (!isCurrentAccount()) return Promise.resolve();
  reviewRefreshPending = true;
  ++reviewRefreshVersion;
  if (!initialized) return Promise.resolve();
  if (reviewRefreshTask) return reviewRefreshTask;
  reviewRefreshTask = (async () => {
    while (reviewRefreshPending && isCurrentAccount()) {
      reviewRefreshPending = false;
      const refreshVersion = reviewRefreshVersion;
      if (pendingReviewWrite) await pendingReviewWrite;
      const sources = await readCurrentReviewSources();
      if (!isCurrentAccount()) return;
      if (refreshVersion !== reviewRefreshVersion) continue;
      const changed = JSON.stringify([...state.groups]) !== JSON.stringify([...sources.groups])
        || JSON.stringify(state.unknownWords) !== JSON.stringify(sources.snapshot.words);
      state.unknownWords = sources.snapshot.words;
      state.unknownWordMap = sources.snapshot.wordMap;
      if (sources.snapshot.error) showMessage(sources.snapshot.error);
      if (!changed) continue;
      const preserveWordId = state.words[state.currentIndex]?.wordId || "";
      const previousIndex = state.currentIndex;
      window.clearTimeout(advanceTimer);
      state.groups = sources.groups;
      populateDateSelect();
      await selectDate(state.selectedDate || localDateKey(), { preserveWordId, previousIndex });
    }
  })().catch(() => showMessage("复习词库刷新失败，请重新打开页面"))
    .finally(() => { reviewRefreshTask = null; });
  return reviewRefreshTask;
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
  const sources = await readCurrentReviewSources();
  if (!isCurrentAccount()) return;
  state.unknownWords = sources.snapshot.words;
  state.unknownWordMap = sources.snapshot.wordMap;
  state.groups = sources.groups;
  if (sources.snapshot.error) showMessage(sources.snapshot.error);
  populateDateSelect();
  const requested = new URLSearchParams(location.search).get("date");
  const initialDate = /^\d{4}-\d{2}-\d{2}$/.test(requested || "") ? requested : localDateKey();
  await selectDate(initialDate);
  initialized = true;
  if (reviewRefreshPending) requestReviewRefresh();
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
window.addEventListener("focus", requestReviewRefresh);
window.addEventListener("pageshow", () => { if (state.selectedDate) requestReviewRefresh(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.selectedDate) requestReviewRefresh();
});
window.addEventListener("wuliao:unknown-words-refresh", (event) => {
  if (event.detail?.username === state.username && state.selectedDate) requestReviewRefresh();
});
window.addEventListener("storage", (event) => {
  if (event.key !== CURRENT_USER_KEY || isCurrentAccount()) return;
  ++reviewVersion;
  ++reviewRefreshVersion;
  window.clearTimeout(advanceTimer);
  reviewRefreshPending = false;
  state.unknownWords = [];
  state.unknownWordMap.clear();
  setVisible(loadingState);
  Promise.resolve(pendingReviewWrite).then(() => location.reload())
    .catch(() => showMessage("保存失败，请重试后切换账号"));
});

initialize().catch((error) => {
  console.error(error);
  loadingState.textContent = "复习词库加载失败，请重新打开页面";
  showMessage("复习词库加载失败");
});
