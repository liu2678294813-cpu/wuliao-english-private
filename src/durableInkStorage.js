// Synchronous read cache over transactional IndexedDB. Hydrate before mounting
// the workspace; consumers keep their existing logical keys (including exports).
import { isSerializedInkSnapshot } from "./ink/inkSnapshot.js";
export const DURABLE_INK_STORE = "reader-ink";
export const isDurableInkKey = (key) => /^(?:wuliao:deep-ink:|wuliao:ink:|wuliao:cloze-ink:v1:)/.test(key);
const accounts = new Map();
const subscribers = new Set();
let openDatabase;
export function configureDurableInkStorage(open) { openDatabase = open; }
const notify = () => subscribers.forEach((fn) => fn());
export function subscribeInkStorage(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
const identity = (username, key) => JSON.stringify([username, key]);

async function transaction(mode, operation) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DURABLE_INK_STORE, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("笔迹数据库写入失败"));
      tx.onabort = () => reject(tx.error || new Error("笔迹保存已取消"));
      const request = operation(tx.objectStore(DURABLE_INK_STORE));
      request.onsuccess = () => { result = request.result; };
    });
  } finally { db.close(); }
}

export function inkStorageReady(username) { return accounts.get(username)?.ready === true; }
export function readDurableInk(username, key) { return accounts.get(username)?.values.get(key) ?? null; }
export function listDurableInk(username) { return [...(accounts.get(username)?.values || [])].map(([key, value]) => ({ key, value })); }
export function inkStorageStatus(username) {
  const state = accounts.get(username);
  return state?.error ? "error" : state?.pending.size || state?.running ? "saving" : "saved";
}

export async function hydrateDurableInk(username, legacyEntries = [], removeLegacy = () => {}) {
  if (!openDatabase) throw new Error("笔迹存储尚未初始化");
  let state = accounts.get(username);
  if (state?.hydrating) return state.hydrating;
  if (state?.ready) return;
  state = { values: new Map(), pending: new Map(), ready: false, running: null, error: null };
  accounts.set(username, state);
  state.hydrating = (async () => {
    const records = await transaction("readonly", (store) => store.index("username").getAll(username));
    for (const record of records) {
      if (!isDurableInkKey(record.key) || typeof record.value !== "string") throw new Error("笔迹存档格式异常，已停止加载以保护原数据");
      JSON.parse(record.value);
      state.values.set(record.key, record.value);
    }
    for (const entry of legacyEntries.filter((entry) => isDurableInkKey(entry.key))) {
      // Invalid legacy records must not turn into an empty, writable canvas.
      JSON.parse(entry.value);
      if (!state.values.has(entry.key)) {
        const record = { id: identity(username, entry.key), username, key: entry.key, value: entry.value };
        await transaction("readwrite", (store) => store.put(record));
        const confirmed = await transaction("readonly", (store) => store.get(record.id));
        if (confirmed?.value !== entry.value) throw new Error("旧笔迹迁移校验失败，原记录已保留");
        state.values.set(entry.key, entry.value);
      }
      // Only delete the exact source value that was verified; never a newer edit.
      if (state.values.get(entry.key) === entry.value) removeLegacy(entry.key, entry.value);
    }
    state.ready = true;
    notify();
  })();
  try { await state.hydrating; }
  catch (error) { accounts.delete(username); throw error; }
  finally { state.hydrating = null; }
}

export function writeDurableInk(username, key, value) {
  const state = accounts.get(username);
  if (!state?.ready) throw new Error("笔迹尚未加载完成，请稍后重试");
  const serializedHere = isSerializedInkSnapshot(value);
  if (serializedHere) value = value.json;
  // External strings still require validation. Re-parsing locally serialized
  // history can block the next pen stroke for hundreds of milliseconds.
  if (value !== null && !serializedHere) JSON.parse(value);
  if (state.values.get(key) === value && !state.pending.has(key)) return;
  if (value === null) state.values.delete(key);
  else state.values.set(key, value);
  state.pending.set(key, { value });
  state.error = null;
  notify();
  // Start on every completed stroke; no 300 ms loss window before navigation.
  void flushDurableInk(username).catch(() => {});
}

export async function flushDurableInk(username) {
  const state = accounts.get(username);
  if (!state?.ready) return;
  if (state.running) return state.running;
  state.error = null;
  state.running = (async () => {
    while (state.pending.size) {
      const [key, pending] = state.pending.entries().next().value;
      const record = { id: identity(username, key), username, key, value: pending.value };
      await transaction("readwrite", (store) => pending.value === null ? store.delete(record.id) : store.put(record));
      if (state.pending.get(key) === pending) state.pending.delete(key);
    }
  })();
  notify();
  try { await state.running; }
  catch (error) { state.error = error; throw error; }
  finally { state.running = null; notify(); }
}

export async function reloadDurableInk(username) {
  await flushDurableInk(username);
  accounts.delete(username);
  await hydrateDurableInk(username);
}
