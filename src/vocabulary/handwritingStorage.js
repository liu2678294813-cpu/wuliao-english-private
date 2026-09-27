export const HANDWRITING_DB = "WuliaoVocabHandwritingDB";

export function openHandwritingDatabase(indexedDb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(HANDWRITING_DB, 1);
    request.onupgradeneeded = () => {
      for (const name of ["answers", "sessions"]) {
        const store = request.result.createObjectStore(name, { keyPath: "id" });
        store.createIndex("username", "username");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const transactionDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = tx.onerror = () => reject(tx.error || new Error("保存失败"));
});

export function assertHandwritingAccount(username) {
  if (!username || localStorage.getItem("kaoyan_vocab_current_user") !== username) throw new Error("账号已切换，请重新打开筛选页");
}

export function handwritingSessionId(context) {
  return JSON.stringify([context.username, context.listId, context.round]);
}
export function handwritingAnswerId(context, wordId) {
  return JSON.stringify([context.username, context.listId, context.round, wordId]);
}

export async function readHandwritingSession(context) {
  assertHandwritingAccount(context.username);
  const db = await openHandwritingDatabase();
  try {
    const tx = db.transaction(["answers", "sessions"], "readonly");
    const done = transactionDone(tx);
    const [all, session] = await Promise.all([
      requestResult(tx.objectStore("answers").index("username").getAll(context.username)),
      requestResult(tx.objectStore("sessions").get(handwritingSessionId(context))),
    ]);
    await done;
    assertHandwritingAccount(context.username);
    return { session, answers: Object.fromEntries(all.filter((r) => r.sessionId === handwritingSessionId(context)).map((r) => [r.wordId, r])) };
  } finally { db.close(); }
}

export async function saveHandwritingRecords(storeName, records) {
  if (!records.length) return;
  const username = records[0].username;
  assertHandwritingAccount(username);
  const db = await openHandwritingDatabase();
  try {
    assertHandwritingAccount(username);
    const tx = db.transaction(storeName, "readwrite");
    const done = transactionDone(tx);
    for (const record of records) {
      if (record.username !== username) { tx.abort(); break; }
      tx.objectStore(storeName).put(record);
    }
    await done;
  } finally { db.close(); }
}

// Both output lists and learning records are committed in one existing-vocabulary
// transaction. A stable per-answer key makes retries and manual corrections idempotent.
export async function classifyHandwriting(context, answer, { isCurrent = () => true, signal } = {}) {
  assertHandwritingAccount(context.username);
  if (!["correct", "wrong"].includes(answer.verdict)) throw new Error("待复核答案不能自动归类");
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("KaoyanVocabDB");
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("请先打开词库，再进行筛选"));
  });
  try {
    assertHandwritingAccount(context.username);
    const tx = db.transaction(["wordLists", "wordRecords"], "readwrite");
    const done = transactionDone(tx);
    const abort = () => { try { tx.abort(); } catch { /* already completed */ } };
    signal?.addEventListener("abort", abort, { once: true });
    done.finally(() => signal?.removeEventListener("abort", abort)).catch(() => {});
    const listsStore = tx.objectStore("wordLists"), recordsStore = tx.objectStore("wordRecords");
    const [lists, records] = await Promise.all([
      requestResult(listsStore.index("username").getAll(context.username)),
      requestResult(recordsStore.index("[username+wordId]").getAll([context.username, answer.wordId])),
    ]);
    if (signal?.aborted || !isCurrent() || localStorage.getItem("kaoyan_vocab_current_user") !== context.username) {
      abort();
      await done.catch(() => {});
      throw new Error("答案已修改，旧对照结果已取消");
    }
    const origin = handwritingSessionId(context);
    const target = answer.verdict === "correct" ? "familiar" : "raw";
    for (const type of ["familiar", "raw"]) {
      const existing = lists.find((list) => list.handwritingSessionId === origin && list.type === type);
      const ids = new Set(existing?.wordIds || []);
      if (type === target) ids.add(answer.wordId); else ids.delete(answer.wordId);
      if (!existing && !ids.size) continue;
      listsStore.put({ ...existing, username: context.username, type, round: context.round,
        name: existing?.name || `${type === "familiar" ? "熟知词" : "生词表"}_手写_${context.listName || "总词库"}_第${context.round}轮`,
        wordIds: [...ids], createdAt: existing?.createdAt || Date.now(), sourceListId: context.listId,
        handwritingSessionId: origin });
    }
    const existing = records.find((record) => record.handwritingAnswerId === answer.id);
    recordsStore.put({ ...existing, username: context.username, wordId: answer.wordId, round: context.round,
      result: answer.verdict, timestamp: Date.now(), handwritingAnswerId: answer.id,
      answerRevision: answer.revision, sourceListId: context.listId, reason: answer.reason || "" });
    await done;
  } finally { db.close(); }
}
