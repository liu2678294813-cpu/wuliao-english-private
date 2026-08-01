const CURRENT_USER_KEY = "kaoyan_vocab_current_user";
const MEMORY_DB_NAME = "KaoyanVocabMemorizeDB";
const MEMORY_DB_VERSION = 2;
const IMPORT_LIST_STORE = "importedLists";
const IMPORT_WORD_STORE = "importedWords";
const MAIN_DB_NAME = "KaoyanVocabDB";
const MAIN_LIST_STORE = "wordLists";
const IMPORTED_WORD_PREFIX = "import:";

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
    return lists.filter((list) => list.sourceImportId || list.sourceType === "imported");
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

export async function removeFamiliarWordsFromImportedListForMainRecord(mainListId) {
  const mainList = await mainListById(mainListId);
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
    familiarWordIds = new Set(userLists
      .filter((list) => list.type === "familiar")
      .flatMap((list) => list.wordIds || []));
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
  const importedList = await importedListForMainRecord(mainList);
  if (!mainList || !importedList) {
    throw new Error("The selected list is not an imported vocabulary list");
  }

  const namePrefix = targetType === "familiar" ? "熟知词库_" : "生词库_";
  const name = `${namePrefix}${mainList.name}`;
  const database = await openExistingMainDatabase();
  if (!database) throw new Error("Vocabulary data is unavailable");

  try {
    const transaction = database.transaction(MAIN_LIST_STORE, "readwrite");
    const store = transaction.objectStore(MAIN_LIST_STORE);
    const done = transactionDone(transaction);
    const userLists = store.indexNames.contains("username")
      ? await requestResult(store.index("username").getAll(mainList.username))
      : (await requestResult(store.getAll())).filter((list) => list.username === mainList.username);
    const existing = userLists.find((list) => (
      list.derivedFromImportId === importedList.id && list.type === targetType
    ));
    const previousWordIds = existing?.wordIds || [];
    const wordIds = [...new Set([...previousWordIds, ...mainList.wordIds])];
    const added = wordIds.length - previousWordIds.length;
    const list = {
      ...(existing || {}),
      username: mainList.username,
      name,
      type: targetType,
      round: targetType === "familiar" ? Math.max(mainList.round, 1) : mainList.round,
      wordIds,
      createdAt: existing?.createdAt || Date.now(),
      derivedFromImportId: importedList.id,
      sourceType: "imported-classification",
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
