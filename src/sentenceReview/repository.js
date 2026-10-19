import { openWuliaoEnglishDatabase } from "../storage.js";
import { getCurrentUsername } from "../userData.js";

export const ATTEMPTS = "sentence-review-attempts";
export const INK = "sentence-review-ink";
export function assertOwner(username) {
  if (!username || username !== getCurrentUsername()) throw new Error("账号已切换，请重新打开复盘");
}

// Resolve on commit, never on a successful put request alone.
export async function transaction(stores, mode, username, issue, indexedDb = globalThis.indexedDB) {
  assertOwner(username);
  const db = await openWuliaoEnglishDatabase(indexedDb);
  try {
    return await new Promise((resolve, reject) => {
      let result, cause;
      const tx = db.transaction(stores, mode);
      const fail = error => { cause = error; tx.abort(); };
      tx.oncomplete = () => {
        try { assertOwner(username); resolve(result); } catch (error) { reject(error); }
      };
      tx.onerror = tx.onabort = () => reject(cause || tx.error || new Error("复盘记录保存失败"));
      try { issue(tx, value => { result = value; }, fail); } catch (error) { fail(error); }
    });
  } finally { db.close(); }
}

export function listAttempts(username, sourceReviewId) {
  return transaction(ATTEMPTS, "readonly", username, (tx, done) => {
    const store = tx.objectStore(ATTEMPTS);
    const request = sourceReviewId ? store.index("usernameSource").getAll([username, sourceReviewId]) : store.index("username").getAll(username);
    request.onsuccess = () => done(request.result.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)));
  });
}

export function readAttempt(username, id) {
  return transaction(ATTEMPTS, "readonly", username, (tx, done, fail) => {
    const request = tx.objectStore(ATTEMPTS).get(id);
    request.onsuccess = () => request.result?.username === username ? done(request.result) : fail(new Error("复盘记录不存在或不属于当前账号"));
  });
}

export function openAttempt(username, source, baseline, inputMode) {
  if (source.status !== "resolved" || !source.text) throw new Error(source.error || "原句暂不可用");
  return transaction(ATTEMPTS, "readwrite", username, (tx, done, fail) => {
    const store = tx.objectStore(ATTEMPTS);
    const request = store.index("usernameSource").getAll([username, source.sourceReviewId]);
    request.onsuccess = () => {
      try {
        assertOwner(username);
        const drafts = request.result.filter(item => item.status !== "completed"
          && item.source.textFingerprint === source.textFingerprint && JSON.stringify(item.baseline) === JSON.stringify(baseline));
        const draft = drafts.sort((a, b) => b.createdAt - a.createdAt)[0];
        if (draft) {
          done(draft); return;
        }
        const now = Date.now();
        const value = { schemaVersion: 1, id: `sr-${crypto.randomUUID()}`, username,
          sourceReviewId: source.sourceReviewId, source: { ...source, articleText: undefined }, baseline,
          round: request.result.length + 1, userTranslation: "", inputMode, checked: false,
          status: "draft", verdict: null, createdAt: now, updatedAt: now, revision: 1,
          layout: { width: 760, height: 1000, version: 1 } };
        store.put(value); done(value);
      } catch (error) { fail(error); }
    };
  });
}

export function updateAttempt(username, id, revision, update) {
  return transaction(ATTEMPTS, "readwrite", username, (tx, done, fail) => {
    const store = tx.objectStore(ATTEMPTS), request = store.get(id);
    request.onsuccess = () => {
      try {
        assertOwner(username);
        const current = request.result;
        if (!current || current.username !== username) throw new Error("复盘记录不属于当前账号");
        if (current.revision !== revision) throw new Error("记录已在其他页面更新，请重新载入");
        if (current.status === "completed") throw new Error("已完成的练习只读，请开始新一轮");
        const patch = update(current);
        const next = { ...current, ...patch, revision: revision + 1, updatedAt: Date.now() };
        store.put(next); done(next);
      } catch (error) { fail(error); }
    };
  });
}

export function saveDraft(username, attempt, patch) {
  return updateAttempt(username, attempt.id, attempt.revision, current => {
    if (current.status !== "draft") throw new Error("结果尚在保存，请先重试结果保存");
    return { userTranslation: String(patch.userTranslation ?? current.userTranslation),
      inputMode: patch.inputMode === "typed" ? "typed" : "handwriting", checked: Boolean(patch.checked) };
  });
}
