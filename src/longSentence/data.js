import { openWuliaoEnglishDatabase } from "../storage.js";
import { getCurrentUsername } from "../userData.js";

export const LONG_SENTENCE_STORES = Object.freeze({
  sessions: "long-sentence-sessions",
  items: "long-sentence-items",
  attempts: "long-sentence-attempts",
  skills: "long-sentence-skills",
  evaluations: "long-sentence-evaluations",
  schedules: "long-sentence-schedules",
  ink: "long-sentence-ink",
});

const allowedStores = new Set(Object.values(LONG_SENTENCE_STORES));

function checkedStore(storeName) {
  if (!allowedStores.has(storeName)) throw new Error("不支持的长难句数据类型");
  return storeName;
}

function account(username) {
  const current = getCurrentUsername();
  if (!current) throw new Error("请先登录账号");
  if (username && username !== current) throw new Error("账号已切换，请重新打开长难句训练");
  return current;
}

function transactionResult(storeName, mode, issue) {
  checkedStore(storeName);
  return openWuliaoEnglishDatabase().then((db) => new Promise((resolve, reject) => {
    let transaction;
    let result;
    let settled = false;
    let forcedError = null;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      db.close();
      if (error) reject(error);
      else resolve(result);
    };
    try {
      transaction = db.transaction(storeName, mode);
      const request = issue(transaction.objectStore(storeName), (value) => { result = value; }, (error) => {
        forcedError = error;
        transaction.abort();
      });
      if (request) {
        request.onsuccess = (event) => { result = event.target.result; };
        request.onerror = () => settle(request.error || transaction.error || new Error("数据库请求失败"));
      }
      transaction.oncomplete = () => settle(null);
      transaction.onerror = () => settle(transaction.error || new Error("数据库事务失败"));
      transaction.onabort = () => settle(forcedError || transaction.error || new Error("数据库事务已取消"));
    } catch (error) {
      settle(error);
    }
  }));
}

export async function putRecord(storeName, record, { username } = {}) {
  const owner = account(username);
  if (!record || typeof record !== "object" || !record.id) throw new Error("长难句记录缺少 id");
  if (record.username && record.username !== owner) throw new Error("不能写入其他账号的记录");
  const value = { ...record, username: owner };
  await transactionResult(storeName, "readwrite", (store, _setResult, abort) => {
    if (getCurrentUsername() !== owner) throw new Error("账号已切换，请重新打开长难句训练");
    const read = store.get(value.id);
    read.onsuccess = () => {
      if (getCurrentUsername() !== owner || (read.result && read.result.username !== owner)) {
        abort(new Error("不能覆盖其他账号的记录"));
      } else {
        store.put(value);
      }
    };
    return null;
  });
  return value;
}

export async function getRecord(storeName, id, { username } = {}) {
  const owner = account(username);
  if (!id) return null;
  const value = await transactionResult(storeName, "readonly", (store) => store.get(id));
  return getCurrentUsername() === owner && value?.username === owner ? value : null;
}

export async function listRecords(storeName, { username, index = "username", key, offset = 0, limit = 50 } = {}) {
  const owner = account(username);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("分页参数无效");
  }
  if (index !== "username" && index !== "usernameSession" && index !== "usernameDue") {
    throw new Error("不支持的长难句索引");
  }
  if (index !== "username" && !key) throw new Error("缺少索引键");
  const query = index === "username" ? owner : [owner, key];
  const records = await transactionResult(storeName, "readonly", (store, setResult) => {
    const items = [];
    let skipped = 0;
    let cursorRequest;
    try {
      cursorRequest = store.index(index).openCursor(query);
    } catch (error) {
      throw new Error(`索引 ${index} 不可用：${error.message}`);
    }
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || items.length >= limit) {
        setResult(items);
        return;
      }
      if (skipped < offset) skipped += 1;
      else if (cursor.value?.username === owner) items.push(cursor.value);
      cursor.continue();
    };
    return null;
  });
  if (getCurrentUsername() !== owner) throw new Error("账号已切换，请重新打开长难句训练");
  return records || [];
}

export async function deleteRecord(storeName, id, { username } = {}) {
  const owner = account(username);
  if (!id) return false;
  return transactionResult(storeName, "readwrite", (store, setResult) => {
    if (getCurrentUsername() !== owner) throw new Error("账号已切换，请重新打开长难句训练");
    const read = store.get(id);
    read.onsuccess = () => {
      if (getCurrentUsername() !== owner || read.result?.username !== owner) {
        setResult(false);
        return;
      }
      store.delete(id);
      setResult(true);
    };
    return null;
  });
}
