import "./pdfjs-compat.js";
import { ensureImportedListInMainDatabase } from "./imported-word-bridge.js";

const CURRENT_USER_KEY = "kaoyan_vocab_current_user";
const MEMORY_DB_NAME = "KaoyanVocabMemorizeDB";
const MEMORY_STORE = "records";
const IMPORT_LIST_STORE = "importedLists";
const IMPORT_WORD_STORE = "importedWords";
const MEMORY_DB_VERSION = 2;
const MAX_WORDS = 10000;

const accountLabel = document.getElementById("accountLabel");
const fileInput = document.getElementById("fileInput");
const filePrompt = document.getElementById("filePrompt");
const listName = document.getElementById("listName");
const parseButton = document.getElementById("parseButton");
const saveButton = document.getElementById("saveButton");
const statusText = document.getElementById("statusText");
const previewCard = document.getElementById("previewCard");
const previewTitle = document.getElementById("previewTitle");
const previewRows = document.getElementById("previewRows");
const successCard = document.getElementById("successCard");
const successText = document.getElementById("successText");
const openListLink = document.getElementById("openListLink");

const state = {
  username: localStorage.getItem(CURRENT_USER_KEY) || "",
  file: null,
  words: [],
};

function setStatus(message, error = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", error);
}

function baseName(filename) {
  return filename.replace(/\.[^.]+$/, "").trim();
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/.test(value);
}

function cleanEnglish(value) {
  return String(value || "")
    .replace(/^\s*(?:\d+[.)、]\s*)+/, "")
    .replace(/\/(?:[^/]|\\\/)+\//g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[：:；;，,\t|]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanChinese(value) {
  return String(value || "").replace(/^[\s:：;；,，|\-–—]+/, "").replace(/\s+/g, " ").trim();
}

function validEnglish(value) {
  return /[A-Za-z]/.test(value) && /^[A-Za-z][A-Za-z\s.'’\-/()]*$/.test(value) && value.length <= 100;
}

function normalizeRows(rows) {
  const seen = new Set();
  const words = [];
  rows.forEach((row) => {
    const english = cleanEnglish(row.english);
    const chinese = cleanChinese(row.chinese);
    const key = english.toLocaleLowerCase("en-US");
    if (!validEnglish(english) || !hasChinese(chinese) || seen.has(key)) return;
    seen.add(key);
    words.push({ english, chinese });
  });
  return words.slice(0, MAX_WORDS);
}

function rowsFromGrid(grid) {
  const rows = grid
    .map((row) => Array.from(row || [], (cell) => String(cell ?? "").trim()))
    .filter((row) => row.some(Boolean));
  if (!rows.length) return [];

  const headers = rows[0].map((cell) => cell.toLocaleLowerCase());
  const englishIndex = headers.findIndex((cell) => /^(english|word|words|英文|英语|单词|词汇)$/.test(cell));
  const chineseIndex = headers.findIndex((cell) => /^(chinese|meaning|translation|definition|中文|汉语|释义|意思|翻译)$/.test(cell));
  const hasHeader = englishIndex >= 0 && chineseIndex >= 0;
  const start = hasHeader ? 1 : 0;
  const left = hasHeader ? englishIndex : 0;
  const right = hasHeader ? chineseIndex : 1;
  return normalizeRows(rows.slice(start).map((row) => ({ english: row[left], chinese: row[right] })));
}

async function parseSpreadsheet(file) {
  if (!window.XLSX) throw new Error("Excel 解析组件未加载，请刷新页面后重试");
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
  const words = [];
  workbook.SheetNames.forEach((sheetName) => {
    const grid = window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: "" });
    words.push(...rowsFromGrid(grid));
  });
  return normalizeRows(words);
}

function textLinesFromPdfPage(items) {
  const lines = [];
  let current = [];
  let currentY = null;
  items.forEach((item) => {
    const text = String(item.str || "").trim();
    if (!text) return;
    const y = Number(item.transform?.[5]);
    if (current.length && Number.isFinite(y) && Number.isFinite(currentY) && Math.abs(y - currentY) > 2) {
      lines.push(current.join(" "));
      current = [];
    }
    current.push(text);
    currentY = y;
    if (item.hasEOL) {
      lines.push(current.join(" "));
      current = [];
      currentY = null;
    }
  });
  if (current.length) lines.push(current.join(" "));
  return lines;
}

function rowsFromTextLines(lines) {
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || "").trim();
    const chineseIndex = line.search(/[\u3400-\u9fff]/);
    if (chineseIndex > 0) {
      candidates.push({ english: line.slice(0, chineseIndex), chinese: line.slice(chineseIndex) });
      continue;
    }
    const next = String(lines[index + 1] || "").trim();
    if (validEnglish(cleanEnglish(line)) && hasChinese(next)) {
      candidates.push({ english: line, chinese: next });
      index += 1;
    }
  }
  return normalizeRows(candidates);
}

async function parsePdf(file) {
  const pdfjs = await import("/vocabulary/vendor/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/vocabulary/vendor/pdf.worker.compat.mjs";
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    lines.push(...textLinesFromPdfPage(content.items));
  }
  return rowsFromTextLines(lines);
}

function renderPreview() {
  previewTitle.textContent = `已识别 ${state.words.length} 词`;
  previewRows.replaceChildren(...state.words.slice(0, 20).map((word) => {
    const row = document.createElement("div");
    row.className = "preview-row";
    row.setAttribute("role", "row");
    const english = document.createElement("span");
    english.textContent = word.english;
    const chinese = document.createElement("span");
    chinese.textContent = word.chinese;
    row.append(english, chinese);
    return row;
  }));
  previewCard.classList.remove("hidden");
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

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function saveImportedList() {
  const name = listName.value.trim();
  if (!name) throw new Error("请填写词库名称");
  if (!state.words.length) throw new Error("请先识别词库内容");

  const createdAt = Date.now();
  const randomId = crypto.randomUUID?.() || `${createdAt}-${Math.random().toString(16).slice(2)}`;
  const id = `${state.username}:${randomId}`;
  const listKey = `import-${randomId}`;
  const wordIds = state.words.map((_, index) => `import:${randomId}:${index + 1}`);
  const db = await openMemoryDatabase();
  try {
    const transaction = db.transaction([IMPORT_LIST_STORE, IMPORT_WORD_STORE], "readwrite");
    transaction.objectStore(IMPORT_LIST_STORE).put({
      id,
      listKey,
      name,
      username: state.username,
      wordIds,
      sourceName: state.file.name,
      sourceType: state.file.name.split(".").pop().toLowerCase(),
      createdAt,
    });
    const wordStore = transaction.objectStore(IMPORT_WORD_STORE);
    state.words.forEach((word, index) => wordStore.put({
      ...word,
      wordId: wordIds[index],
      listId: id,
      listKey,
      username: state.username,
      createdAt,
    }));
    await transactionDone(transaction);
  } finally {
    db.close();
  }
  const mainListId = await ensureImportedListInMainDatabase({
    id,
    listKey,
    name,
    username: state.username,
    wordIds,
    sourceName: state.file.name,
    sourceType: state.file.name.split(".").pop().toLowerCase(),
    createdAt,
  });
  return { listKey, mainListId, name, count: state.words.length };
}

async function parseSelectedFile() {
  if (!state.file) return;
  parseButton.disabled = true;
  saveButton.disabled = true;
  previewCard.classList.add("hidden");
  successCard.classList.add("hidden");
  setStatus("正在本地识别文件，请稍候…");
  try {
    const extension = state.file.name.split(".").pop().toLowerCase();
    state.words = extension === "pdf" ? await parsePdf(state.file) : await parseSpreadsheet(state.file);
    if (!state.words.length) {
      throw new Error(extension === "pdf"
        ? "未识别到“英文 + 中文释义”。如果是扫描图片型 PDF，请先转成 Excel/CSV 或文字型 PDF"
        : "未识别到两列有效内容，请检查英文列和中文释义列");
    }
    renderPreview();
    saveButton.disabled = false;
    setStatus(`识别完成：${state.words.length} 词。请核对预览后保存`);
  } catch (error) {
    state.words = [];
    setStatus(error.message || "文件识别失败，请检查格式", true);
  } finally {
    parseButton.disabled = false;
  }
}

fileInput.addEventListener("change", () => {
  state.file = fileInput.files?.[0] || null;
  state.words = [];
  previewCard.classList.add("hidden");
  successCard.classList.add("hidden");
  saveButton.disabled = true;
  parseButton.disabled = !state.file;
  if (!state.file) {
    filePrompt.textContent = "选择 PDF、Excel 或 CSV";
    setStatus("尚未选择文件");
    return;
  }
  filePrompt.textContent = state.file.name;
  if (!listName.value.trim()) listName.value = baseName(state.file.name);
  setStatus(`已选择 ${(state.file.size / 1024).toFixed(1)} KB，点击“识别并预览”`);
});

parseButton.addEventListener("click", parseSelectedFile);
saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  setStatus("正在保存到当前浏览器…");
  try {
    const saved = await saveImportedList();
    successText.textContent = `${saved.name}，共 ${saved.count} 词，已加入完整词库流程，可筛查、学习、复习和导出。`;
    openListLink.href = saved.mainListId
      ? `/vocabulary/index.html#/learning/${saved.mainListId}`
      : "/vocabulary/index.html#/lists";
    successCard.classList.remove("hidden");
    setStatus("保存成功");
  } catch (error) {
    setStatus(error.message || "保存失败，请重试", true);
    saveButton.disabled = false;
  }
});

if (!state.username) {
  document.body.innerHTML = `
    <main style="padding:40px 20px;text-align:center;font-family:Arial,'Microsoft YaHei',sans-serif">
      <h2>请先登录筛查器</h2>
      <p>词库按当前本地账号隔离保存。</p>
      <p><a href="/vocabulary/index.html#/login">返回登录</a></p>
    </main>`;
} else {
  accountLabel.textContent = state.username;
}
