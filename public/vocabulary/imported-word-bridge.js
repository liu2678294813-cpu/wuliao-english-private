import { isUnknownWordId, readUnknownWordList, UNKNOWN_LIST_KEY } from "./unknown-word-list.js";

const CURRENT_USER_KEY = "kaoyan_vocab_current_user";
const MEMORY_DB_NAME = "KaoyanVocabMemorizeDB";
const MEMORY_DB_VERSION = 2;
const IMPORT_LIST_STORE = "importedLists";
const IMPORT_WORD_STORE = "importedWords";
const MAIN_DB_NAME = "KaoyanVocabDB";
const MAIN_LIST_STORE = "wordLists";
const IMPORTED_WORD_PREFIX = "import:";
export const isReadingWordList = (list) => list?.sourceType === "reading-unknown";

function requestResult(request) {
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
      const database = request.result;
      if (!database.objectStoreNames.contains("records")) {
        const store = database.createObjectStore("records", { keyPath: "memoryKey" });
        store.createIndex("usernameList", ["username", "listKey"], { unique: false });
      }
      if (!database.objectStoreNames.contains(IMPORT_LIST_STORE)) {
        const store = database.createObjectStore(IMPORT_LIST_STORE, { keyPath: "id" });
        store.createIndex("username", "username", { unique: false });
      }
      if (!database.objectStoreNames.contains(IMPORT_WORD_STORE)) {
        const store = database.createObjectStore(IMPORT_WORD_STORE, { keyPath: "wordId" });
        store.createIndex("usernameList", ["username", "listKey"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openExistingMainDatabase() {
  return new Promise((resolve, reject) => {
    let databaseWasMissing = false;
    const request = indexedDB.open(MAIN_DB_NAME);
    request.onupgradeneeded = () => {
      if (request.transaction?.db.objectStoreNames.contains(MAIN_LIST_STORE)) return;
      databaseWasMissing = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MAIN_LIST_STORE)) {
        database.close();
        resolve(null);
        return;
      }
      resolve(database);
    };
    request.onerror = () => {
      if (databaseWasMissing) {
        resolve(null);
        return;
      }
      reject(request.error);
    };
  });
}

function accountLists(store, username) {
  return store.indexNames.contains("username")
    ? requestResult(store.index("username").getAll(username))
    : requestResult(store.getAll()).then((lists) => lists.filter((list) => list.username === username));
}

async function withWordLists(mode, action, fallback = null) {
  const database = await openExistingMainDatabase();
  if (!database) return fallback;
  try {
    const transaction = database.transaction(MAIN_LIST_STORE, mode);
    const done = transactionDone(transaction);
    // Await both the result and commit, including when the IDB request fails.
    const [result] = await Promise.all([action(transaction.objectStore(MAIN_LIST_STORE)), done]);
    return result;
  } finally {
    database.close();
  }
}

export function readingListWords(list, snapshot) {
  const excluded = new Set(list?.excludedWordIds);
  return snapshot.words.filter((word) => !excluded.has(word.wordId));
}

function projectReadingList(list, snapshot) {
  return { ...list, wordIds: readingListWords(list, snapshot).map((word) => word.wordId) };
}

export async function getReadingWordList(username, { snapshot, create = false, restore = false } = {}) {
  if (!username) return null;
  snapshot ??= await readUnknownWordList(username);
  if (snapshot.error && restore) throw new Error(snapshot.error);

  // Serialize creation and changes to metadata in the existing wordLists store.
  // Reading entries and their meanings are always resolved from unknown-words.
  return withWordLists(create || restore ? "readwrite" : "readonly", async (store) => {
    const existing = (await accountLists(store, username)).find(isReadingWordList);
    if (existing) {
      if (restore && existing.hidden) {
        existing.hidden = false;
        await requestResult(store.put(existing));
      }
      return projectReadingList(existing, snapshot);
    }
    if (!(create || restore) || !snapshot.words.length) return null;
    const list = {
      username,
      name: "陌生词库",
      type: "custom",
      round: 0,
      wordIds: [],
      sourceListKey: UNKNOWN_LIST_KEY,
      sourceType: "reading-unknown",
      createdAt: Date.now(),
    };
    list.id = await requestResult(store.add(list));
    return projectReadingList(list, snapshot);
  });
}

export async function resolveVocabularyList(list) {
  if (!isReadingWordList(list)) return list;
  if (list.hidden || list.username !== localStorage.getItem(CURRENT_USER_KEY)?.trim()) return undefined;
  const snapshot = await readUnknownWordList(list.username);
  return snapshot.error ? undefined : projectReadingList(list, snapshot);
}

// Screen preparation and option generation can request the same word in parallel.
const readingWordReads = new Map();
export async function getReadingWords(wordIds) {
  const ids = [...new Set(wordIds.filter(isUnknownWordId))];
  const username = localStorage.getItem(CURRENT_USER_KEY)?.trim();
  if (!ids.length || !username) return [];
  if (!readingWordReads.has(username)) {
    readingWordReads.set(username, readUnknownWordList(username).finally(() => readingWordReads.delete(username)));
  }
  const snapshot = await readingWordReads.get(username);
  if (localStorage.getItem(CURRENT_USER_KEY)?.trim() !== username) return [];
  return ids.map((id) => snapshot.wordMap.get(id)).filter(Boolean);
}

function isUsableImportedList(list) {
  return Boolean(
    list
    && typeof list.id === "string"
    && typeof list.username === "string"
    && typeof list.name === "string"
    && Array.isArray(list.wordIds)
    && list.wordIds.every((wordId) => isImportedWordId(wordId)),
  );
}

function toWordEntry(word) {
  if (
    !word
    || !isImportedWordId(word.wordId)
    || typeof word.english !== "string"
    || typeof word.chinese !== "string"
  ) {
    return null;
  }
  return {
    wordId: word.wordId,
    english: word.english,
    chinese: word.chinese,
  };
}

async function importedListsForUser(username) {
  const database = await openMemoryDatabase();
  try {
    const transaction = database.transaction(IMPORT_LIST_STORE, "readonly");
    const store = transaction.objectStore(IMPORT_LIST_STORE);
    const done = transactionDone(transaction);
    const lists = store.indexNames.contains("username")
      ? await requestResult(store.index("username").getAll(username))
      : (await requestResult(store.getAll())).filter((list) => list.username === username);
    await done;
    return lists.filter(isUsableImportedList);
  } finally {
    database.close();
  }
}

export function isImportedWordId(wordId) {
  return typeof wordId === "string" && wordId.startsWith(IMPORTED_WORD_PREFIX);
}

export async function ensureImportedListInMainDatabase(importedList) {
  if (!isUsableImportedList(importedList)) return null;

  const database = await openExistingMainDatabase();
  if (!database) return null;

  try {
    const transaction = database.transaction(MAIN_LIST_STORE, "readwrite");
    const store = transaction.objectStore(MAIN_LIST_STORE);
    const done = transactionDone(transaction);
    const userLists = store.indexNames.contains("username")
      ? await requestResult(store.index("username").getAll(importedList.username))
      : (await requestResult(store.getAll())).filter((list) => list.username === importedList.username);
    const existing = userLists.find((list) => list.sourceImportId === importedList.id);
    const mainList = {
      ...(existing || {}),
      username: importedList.username,
      name: importedList.name,
      type: "custom",
      round: Number.isFinite(existing?.round) ? existing.round : 0,
      wordIds: [...importedList.wordIds],
      createdAt: Number(importedList.createdAt) || Date.now(),
      sourceImportId: importedList.id,
      sourceListKey: importedList.listKey,
      sourceType: "imported",
    };
    const mainListId = existing?.id
      ? (store.put(mainList), existing.id)
      : await requestResult(store.add(mainList));
    await done;
    return mainListId;
  } finally {
    database.close();
  }
}

export async function syncImportedLists(username = localStorage.getItem(CURRENT_USER_KEY) || "") {
  if (!username) return [];
  const lists = await importedListsForUser(username);
  const synced = [];
  for (const list of lists) {
    const mainListId = await ensureImportedListInMainDatabase(list);
    if (mainListId != null) synced.push({ importedListId: list.id, mainListId });
  }
  return synced;
}

export async function getImportedWords(wordIds) {
  const requestedIds = [...new Set((wordIds || []).filter(isImportedWordId))];
  if (!requestedIds.length) return [];

  const database = await openMemoryDatabase();
  try {
    const transaction = database.transaction(IMPORT_WORD_STORE, "readonly");
    const store = transaction.objectStore(IMPORT_WORD_STORE);
    const done = transactionDone(transaction);
    const words = await Promise.all(requestedIds.map((wordId) => requestResult(store.get(wordId))));
    await done;
    return words.map(toWordEntry).filter(Boolean);
  } finally {
    database.close();
  }
}

export async function getImportedWord(wordId) {
  return (await getImportedWords([wordId]))[0];
}

export async function getAllImportedWords(username = localStorage.getItem(CURRENT_USER_KEY) || "") {
  if (!username) return [];

  const database = await openMemoryDatabase();
  try {
    const transaction = database.transaction(IMPORT_WORD_STORE, "readonly");
    const store = transaction.objectStore(IMPORT_WORD_STORE);
    const done = transactionDone(transaction);
    const words = await requestResult(store.getAll());
    await done;
    return words
      .filter((word) => word.username === username)
      .map(toWordEntry)
      .filter(Boolean);
  } finally {
    database.close();
  }
}

async function mainListById(mainListId) {
  const database = await openExistingMainDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(MAIN_LIST_STORE, "readonly");
    const done = transactionDone(transaction);
    const list = await requestResult(transaction.objectStore(MAIN_LIST_STORE).get(mainListId));
    await done;
    return list || null;
  } finally {
    database.close();
  }
}

async function importedListForMainRecord(mainList) {
  if (!mainList?.username) return null;

  const database = await openMemoryDatabase();
  try {
    const transaction = database.transaction(IMPORT_LIST_STORE, "readonly");
    const store = transaction.objectStore(IMPORT_LIST_STORE);
    const done = transactionDone(transaction);
    let importedList = mainList.sourceImportId
      ? await requestResult(store.get(mainList.sourceImportId))
      : null;

    // Older imported lists did not always retain sourceImportId in KaoyanVocabDB.
    // Match their canonical record before deleting or trimming so they cannot reappear
    // during the next import-list sync.
    if (!importedList) {
      const candidates = store.indexNames.contains("username")
        ? await requestResult(store.index("username").getAll(mainList.username))
        : (await requestResult(store.getAll())).filter((list) => list.username === mainList.username);
      importedList = candidates.find((list) => (
        isUsableImportedList(list)
        && list.name === mainList.name
        && list.wordIds.length === mainList.wordIds?.length
        && list.wordIds.every((wordId) => mainList.wordIds.includes(wordId))
      )) || null;
    }

    await done;
    return importedList && isUsableImportedList(importedList) ? importedList : null;
  } finally {
    database.close();
  }
}

export async function getImportedMainLists(username = localStorage.getItem(CURRENT_USER_KEY) || "") {
  if (!username) return [];

  const database = await openExistingMainDatabase();
  if (!database) return [];
  try {
    const transaction = database.transaction(MAIN_LIST_STORE, "readonly");
    const store = transaction.objectStore(MAIN_LIST_STORE);
    const done = transactionDone(transaction);
    const lists = store.indexNames.contains("username")
      ? await requestResult(store.index("username").getAll(username))
      : (await requestResult(store.getAll())).filter((list) => list.username === username);
    await done;
    return lists.filter((list) => list.sourceImportId || list.sourceType === "imported" || (isReadingWordList(list) && !list.hidden));
  } finally {
    database.close();
  }
}

export async function renameImportedListForMainRecord(mainListId, name) {
  const mainList = await mainListById(mainListId);
  if (!mainList?.sourceImportId) return;

  const database = await openMemoryDatabase();
  try {
    const transaction = database.transaction(IMPORT_LIST_STORE, "readwrite");
    const store = transaction.objectStore(IMPORT_LIST_STORE);
    const done = transactionDone(transaction);
    const importedList = await requestResult(store.get(mainList.sourceImportId));
    if (importedList) store.put({ ...importedList, name });
    await done;
  } finally {
    database.close();
  }
}

export async function deleteImportedListForMainRecord(mainListId) {
  const mainList = await mainListById(mainListId);
  if (isReadingWordList(mainList)) {
    return withWordLists("readwrite", async (store) => {
      const current = await requestResult(store.get(mainListId));
      if (!current || current.username !== localStorage.getItem(CURRENT_USER_KEY)?.trim()) {
        throw new Error("词库已失效，请刷新后重试");
      }
      await requestResult(store.put({ ...current, hidden: true }));
      return true;
    });
  }
  const importedList = await importedListForMainRecord(mainList);
  if (!importedList) return;

  const database = await openMemoryDatabase();
  try {
    const transaction = database.transaction(IMPORT_LIST_STORE, "readwrite");
    transaction.objectStore(IMPORT_LIST_STORE).delete(importedList.id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function familiarIdsForLists(lists) {
  return new Set(lists.filter((list) => list.type === "familiar").flatMap((list) => list.wordIds || []));
}

export async function getReadingFamiliarWordIds(mainListId) {
  const list = await resolveVocabularyList(await mainListById(mainListId));
  if (!isReadingWordList(list)) throw new Error("词库已失效，请刷新后重试");
  return withWordLists("readonly", async (store) => {
    const familiar = familiarIdsForLists(await accountLists(store, list.username));
    return list.wordIds.filter((id) => familiar.has(id));
  }, []);
}

export async function removeFamiliarWordsFromImportedListForMainRecord(mainListId, confirmedWordIds) {
  const mainList = await mainListById(mainListId);
  if (isReadingWordList(mainList)) {
    const list = await resolveVocabularyList(mainList);
    if (!list) throw new Error("词库已失效，请刷新后重试");
    const confirmed = new Set(confirmedWordIds);
    return withWordLists("readwrite", async (store) => {
      const lists = await accountLists(store, list.username);
      const current = lists.find((item) => item.id === mainListId && !item.hidden);
      if (!current) throw new Error("词库已失效，请刷新后重试");
      const familiar = familiarIdsForLists(lists);
      const excluded = new Set(current.excludedWordIds);
      const candidates = list.wordIds.filter((id) => !excluded.has(id));
      const removed = candidates.filter((id) => confirmed.has(id) && familiar.has(id));
      if (removed.length) {
        await requestResult(store.put({ ...current, excludedWordIds: [...excluded, ...removed] }));
      }
      return { removed: removed.length, remaining: candidates.length - removed.length };
    });
  }
  const importedList = await importedListForMainRecord(mainList);
  if (!mainList || !importedList) {
    throw new Error("这不是可整理的导入词库");
  }

  const mainDatabase = await openExistingMainDatabase();
  if (!mainDatabase) throw new Error("词库数据暂不可用，请稍后重试");

  let familiarWordIds;
  try {
    const transaction = mainDatabase.transaction(MAIN_LIST_STORE, "readonly");
    const store = transaction.objectStore(MAIN_LIST_STORE);
    const done = transactionDone(transaction);
    const userLists = store.indexNames.contains("username")
      ? await requestResult(store.index("username").getAll(mainList.username))
      : (await requestResult(store.getAll())).filter((list) => list.username === mainList.username);
    await done;
    familiarWordIds = familiarIdsForLists(userLists);
  } finally {
    mainDatabase.close();
  }

  const remainingWordIds = mainList.wordIds.filter((wordId) => !familiarWordIds.has(wordId));
  const removed = mainList.wordIds.length - remainingWordIds.length;
  if (!removed) return { removed: 0, remaining: remainingWordIds.length };

  // Persist the canonical imported list first. If the app closes between the two
  // updates, the next sync still keeps the trimmed version instead of restoring words.
  const memoryDatabase = await openMemoryDatabase();
  try {
    const transaction = memoryDatabase.transaction(IMPORT_LIST_STORE, "readwrite");
    transaction.objectStore(IMPORT_LIST_STORE).put({ ...importedList, wordIds: remainingWordIds });
    await transactionDone(transaction);
  } finally {
    memoryDatabase.close();
  }

  const writeDatabase = await openExistingMainDatabase();
  if (!writeDatabase) throw new Error("词库数据暂不可用，请重新打开后检查");
  try {
    const transaction = writeDatabase.transaction(MAIN_LIST_STORE, "readwrite");
    const store = transaction.objectStore(MAIN_LIST_STORE);
    const current = await requestResult(store.get(mainListId));
    if (!current) throw new Error("词库不存在，请刷新后重试");
    store.put({ ...current, wordIds: remainingWordIds });
    await transactionDone(transaction);
  } finally {
    writeDatabase.close();
  }

  return { removed, remaining: remainingWordIds.length };
}

export async function addImportedWordsToClassificationList(mainListId, targetType) {
  if (![`familiar`, `raw`].includes(targetType)) {
    throw new Error("Unsupported imported-word classification");
  }

  const mainList = await mainListById(mainListId);
  const reading = isReadingWordList(mainList);
  const readingList = reading ? await resolveVocabularyList(mainList) : null;
  const importedList = reading ? null : await importedListForMainRecord(mainList);
  if (!readingList && !importedList) throw new Error("词库已失效，请刷新后重试");

  const namePrefix = targetType === "familiar" ? "熟知词库_" : "生词库_";
  const source = reading
    ? { derivedFromReadingListId: mainListId, sourceType: "reading-classification" }
    : { derivedFromImportId: importedList.id, sourceType: "imported-classification" };
  const database = await openExistingMainDatabase();
  if (!database) throw new Error("Vocabulary data is unavailable");

  try {
    const transaction = database.transaction(MAIN_LIST_STORE, "readwrite");
    const store = transaction.objectStore(MAIN_LIST_STORE);
    const done = transactionDone(transaction);
    const userLists = store.indexNames.contains("username")
      ? await requestResult(store.index("username").getAll(mainList.username))
      : (await requestResult(store.getAll())).filter((list) => list.username === mainList.username);
    const current = userLists.find((list) => list.id === mainListId && !list.hidden);
    if (!current) throw new Error("词库已失效，请刷新后重试");
    const existing = userLists.find((list) => list.type === targetType && (reading
      ? list.derivedFromReadingListId === mainListId
      : list.derivedFromImportId === importedList.id));
    const previousWordIds = existing?.wordIds || [];
    const excluded = new Set(current.excludedWordIds);
    const currentIds = reading ? readingList.wordIds.filter((id) => !excluded.has(id)) : current.wordIds;
    const wordIds = [...new Set([...previousWordIds, ...currentIds])];
    const added = wordIds.length - previousWordIds.length;
    const list = {
      ...(existing || {}),
      username: mainList.username,
      name: `${namePrefix}${current.name}`,
      type: targetType,
      round: targetType === "familiar" ? Math.max(mainList.round, 1) : mainList.round,
      wordIds,
      createdAt: existing?.createdAt || Date.now(),
      ...source,
    };
    const listId = existing?.id
      ? (store.put(list), existing.id)
      : await requestResult(store.add(list));
    await done;
    return { added, total: wordIds.length, listId };
  } finally {
    database.close();
  }
}
