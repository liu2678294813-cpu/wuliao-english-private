// One repository for screening, daily review and the confusion page.
// Existing database versions, primary keys and learning projections are unchanged.
export const PENDING_CONFUSIONS = 'pendingConfusions';
const MAIN_DB = 'KaoyanVocabDB';
const MEMORY_DB = 'KaoyanVocabMemorizeDB';

export function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export function transactionDone(tx) {
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('记录事务未完成'));
  });
  // A request can reject before callers reach their await of the transaction.
  done.catch(() => {});
  return done;
}
export function newConfusionEventId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export function makeConfusion({ username, eventId, source, word, choice, round, listId, reviewDate, timestamp = Date.now() }) {
  const english = choice?.sourceWord || choice?.english;
  if (!username || !word?.english || !english || choice.correct || choice.isCorrect || choice.isSkip) return null;
  return { username, eventId, source, correctWordId: word.wordId,
    correctEnglish: word.english, correctChinese: word.chinese || '',
    wrongChinese: choice.chinese || '', sourceWordId: choice.sourceWordId || choice.wordId,
    sourceWord: english, sourceWordChinese: choice.sourceWordChinese || choice.chinese || '',
    ...(Number.isFinite(round) ? { round } : {}), ...(listId ? { listId } : {}),
    ...(reviewDate ? { reviewDate } : {}), timestamp };
}
export function confusionMatches(row, filter = 'all') {
  if (filter === 'all') return true;
  if (filter === 'review') return row.source === 'review';
  return row.source !== 'review' && Number(row.round) === Number(filter);
}
async function openExisting(name, requiredStore, optional = false) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let missing = false;
    request.onupgradeneeded = () => { missing = true; request.transaction.abort(); };
    request.onerror = () => missing && optional ? resolve(null) : reject(request.error || new Error('数据库未就绪'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (db.objectStoreNames.contains(requiredStore)) resolve(db);
      else { db.close(); optional ? resolve(null) : reject(new Error('混淆记录存储尚未就绪')); }
    };
  });
}
// Called inside a native read/write transaction. The username scan and add share
// the transaction, so concurrent flushes cannot create duplicate event records.
export async function putConfusionInStore(store, row) {
  if (!row?.username || !row.sourceWord || !row.correctEnglish || !row.eventId) return false;
  const previous = await requestResult(store.index('username').getAll(IDBKeyRange.only(row.username)));
  if (previous.some((item) => item.eventId === row.eventId)) return false;
  const { id, ...record } = row;
  await requestResult(store.add(record));
  return true;
}
export async function saveConfusion(row) {
  if (!row?.username || !row.eventId || !row.sourceWord || !row.correctEnglish) throw new Error('混淆记录缺少单词或事件标识');
  const db = await openExisting(MAIN_DB, 'confusionPairs');
  try {
    const tx = db.transaction('confusionPairs', 'readwrite'), done = transactionDone(tx);
    const added = await putConfusionInStore(tx.objectStore('confusionPairs'), row);
    await done;
    return added;
  } finally { db.close(); }
}
export async function flushPendingConfusions(username) {
  if (!username) return;
  const db = await openExisting(MEMORY_DB, 'records', true);
  if (!db) return;
  try {
    const read = db.transaction('records', 'readonly'), readDone = transactionDone(read);
    const rows = await requestResult(read.objectStore('records').getAll());
    await readDone;
    for (const row of rows.filter((item) => item.username === username)) {
      for (const event of row[PENDING_CONFUSIONS] || []) {
        if (event.username !== username) continue;
        await saveConfusion(event);
        // Re-read before acknowledgement; never put an old learning projection
        // over a newer one written while the other database was being flushed.
        const tx = db.transaction('records', 'readwrite'), done = transactionDone(tx);
        const store = tx.objectStore('records');
        const current = await requestResult(store.get(row.memoryKey));
        if (current?.username === username) {
          const pending = (current[PENDING_CONFUSIONS] || []).filter((item) => item.eventId !== event.eventId);
          if (pending.length) current[PENDING_CONFUSIONS] = pending;
          else delete current[PENDING_CONFUSIONS];
          store.put(current);
        }
        await done;
      }
    }
  } finally { db.close(); }
}
// Only exact saved snapshots can be recovered. Old result-only records are
// deliberately left untouched: they do not identify the chosen distractor.
export async function recoverConfusionSnapshots(username) {
  const db = await openExisting(MAIN_DB, 'wordRecords');
  let recovered = 0;
  try {
    const tx = db.transaction(['wordRecords', 'confusionPairs'], 'readwrite'), done = transactionDone(tx);
    const records = await requestResult(tx.objectStore('wordRecords').getAll());
    for (const record of records) {
      if (record.username !== username || record.result !== 'wrong' || record.confusionClearedAt) continue;
      const snapshot = record.confusion;
      if (snapshot?.username === username && await putConfusionInStore(tx.objectStore('confusionPairs'), snapshot)) recovered++;
    }
    await done;
  } finally { db.close(); }
  return recovered;
}
export async function readConfusions(username) {
  await flushPendingConfusions(username);
  const recovered = await recoverConfusionSnapshots(username);
  const db = await openExisting(MAIN_DB, 'confusionPairs');
  try {
    const tx = db.transaction(['confusionPairs', 'users'], 'readonly'), done = transactionDone(tx);
    const rows = await requestResult(tx.objectStore('confusionPairs').index('username').getAll(IDBKeyRange.only(username)));
    const user = await requestResult(tx.objectStore('users').get(username));
    await done;
    return { rows: rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)), recovered, canRestore: !!user?.confusionClearUndo?.rows?.length };
  } finally { db.close(); }
}
export async function clearConfusions(username, filter) {
  await flushPendingConfusions(username);
  const db = await openExisting(MAIN_DB, 'confusionPairs');
  try {
    const tx = db.transaction(['confusionPairs', 'wordRecords', 'users'], 'readwrite'), done = transactionDone(tx);
    const store = tx.objectStore('confusionPairs');
    const rows = await requestResult(store.index('username').getAll(IDBKeyRange.only(username)));
    const removed = rows.filter((item) => confusionMatches(item, filter));
    const removedEvents = new Set();
    for (const row of removed) {
      store.delete(row.id); if (row.eventId) removedEvents.add(row.eventId);
    }
    // Keep a recovery copy. Mark exact snapshots cleared, so automatic repair
    // does not revive records that the user has explicitly cleared.
    const records = tx.objectStore('wordRecords');
    const all = await requestResult(records.getAll());
    for (const row of all) if (row.username === username && removedEvents.has(row.confusion?.eventId)) {
      row.confusionClearedAt = Date.now(); records.put(row);
    }
    // The recovery copy shares the atomic clear transaction, without a schema migration.
    const users = tx.objectStore('users'), user = await requestResult(users.get(username));
    if (!user) { tx.abort(); throw new Error('账号记录不存在，已取消清除'); }
    if (removed.length) { user.confusionClearUndo = { rows: removed, clearedAt: Date.now() }; users.put(user); }
    await done;
  } finally { db.close(); }
}
export async function restoreConfusions(username) {
  const db = await openExisting(MAIN_DB, 'confusionPairs');
  try {
    const tx = db.transaction(['confusionPairs', 'wordRecords', 'users'], 'readwrite'), done = transactionDone(tx);
    const users = tx.objectStore('users'), user = await requestResult(users.get(username));
    const rows = user?.confusionClearUndo?.rows || [];
    const events = new Set(rows.map((row) => row.eventId).filter(Boolean));
    const store = tx.objectStore('confusionPairs');
    for (const row of rows) {
      if (row.username !== username) continue;
      if (row.eventId) {
        const existing = await requestResult(store.index('username').getAll(IDBKeyRange.only(username)));
        if (existing.some((item) => item.eventId === row.eventId)) continue;
        if (!await requestResult(store.get(row.id))) store.add(row);
        else await putConfusionInStore(store, row);
      }
      else if (!await requestResult(store.get(row.id))) store.add(row);
    }
    const records = tx.objectStore('wordRecords');
    for (const row of await requestResult(records.getAll())) {
      if (row.username === username && events.has(row.confusion?.eventId)) {
        delete row.confusionClearedAt; records.put(row);
      }
    }
    if (user) { delete user.confusionClearUndo; users.put(user); }
    await done;
  } finally { db.close(); }
}
