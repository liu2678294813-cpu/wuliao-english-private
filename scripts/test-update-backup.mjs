import test from "node:test";
import assert from "node:assert/strict";
import { readUpdateBackupSources, createBackup, parseBackup } from "../src/backup.js";

function storage(entries) {
  return { length: entries.length, key: (i) => entries[i][0], getItem: (key) => entries.find((e) => e[0] === key)?.[1] ?? null };
}
function indexedDb(databases, failingStore) {
  return { databases: async () => Object.keys(databases).map((name) => ({ name })), open(name) {
    const request = {};
    queueMicrotask(() => {
      if (!databases[name]) {
        request.transaction = { abort: () => queueMicrotask(() => request.onerror?.()) };
        request.onupgradeneeded?.(); return;
      }
      request.result = { objectStoreNames: { contains: (store) => store in databases[name] }, close() {}, transaction(store) {
        const tx = { objectStore: () => ({ openCursor() {
          const cursorRequest = {}; let i = 0;
          const next = () => queueMicrotask(() => {
            if (store === failingStore) { tx.error = Error("read failed"); tx.onabort?.(); return; }
            const row = databases[name][store][i++];
            cursorRequest.result = row ? { primaryKey: row[0], value: row[1], continue: next } : null;
            cursorRequest.onsuccess?.();
            if (!row) queueMicrotask(() => tx.oncomplete?.());
          }); next(); return cursorRequest;
        } }) }; return tx;
      } }; request.onsuccess?.();
    }); return request;
  } };
}
const entries = [["kaoyan_vocab_current_user", "alice"], ["wuliao:user:alice:wuliao:reading-flow:r", '{"stage":2}'], ["wuliao:user:bob:wuliao:cloze-progress:c", '{"answer":"A"}'], ["wuliao:user:alice:wuliao:ai:apikey", "secret"]];
const data = {
  KaoyanVocabDB: { users: [["alice", { username: "alice", passwordHash: "secret" }], ["bob", { username: "bob" }]], confusionPairs: [[7, { username: "bob", correctEnglish: "accept", sourceWord: "except" }]] },
  KaoyanVocabMemorizeDB: { records: [["a", { username: "alice", maskedDates: ["2026-10-12"], sharedProgress: { count: 5, masked: true } }], ["b", { username: "bob", maskedDates: ["2026-10-11"], sharedProgress: { count: 2, masked: false } }]] },
  "wuliao-english": { "reader-ink": [["ink", { username: "bob", key: "wuliao:deep-ink:v2:r:p:quiz", value: '{"strokes":[1]}' }]], "long-sentence-ink": [["l", { username: "alice", strokes: [2] }]] },
};
test("strict snapshot includes both accounts and non-current durable reader ink without changing account", async () => {
  const source = await readUpdateBackupSources({ storage: storage(entries), indexedDb: indexedDb(data) });
  assert.deepEqual(source.usernames, ["alice", "bob"]);
  assert.equal(source.entries.find((e) => e.key.endsWith("wuliao:deep-ink:v2:r:p:quiz")).value, '{"strokes":[1]}');
  for (const username of source.usernames) {
    const { fileText } = await createBackup({ username, sources: source }); const manifest = await parseBackup(fileText);
    assert.doesNotMatch(fileText, /secret|passwordHash/);
    assert.equal(manifest.sections.indexedDB.KaoyanVocabMemorizeDB.records.length, 1);
    assert.equal(manifest.sections.indexedDB.KaoyanVocabMemorizeDB.records[0].value.username, username);
    if (username === "bob") { assert.equal(manifest.sections.localStorage.user.length, 2); assert.equal(manifest.sections.indexedDB.KaoyanVocabDB.confusionPairs[0].key, 7); }
  }
  assert.equal(storage(entries).getItem("kaoyan_vocab_current_user"), "alice");
});
test("existing store read failure aborts backup rather than returning empty data", async () => {
  await assert.rejects(readUpdateBackupSources({ storage: storage(entries), indexedDb: indexedDb(data, "records") }), /read failed/);
});
test("missing optional databases and stores do not create storage or block valid backup", async () => {
  const result = await readUpdateBackupSources({ storage: storage(entries), indexedDb: indexedDb({ KaoyanVocabDB: { users: [["alice", { username: "alice" }]] } }) });
  assert.equal(result.databases.length, 1); assert.deepEqual(result.databases[0].stores.map((s) => s.name), ["users"]);
});
test("invalid stored durable ink aborts backup", async () => {
  const changed = structuredClone(data); changed["wuliao-english"]["reader-ink"][0][1].value = "broken";
  await assert.rejects(readUpdateBackupSources({ storage: storage(entries), indexedDb: indexedDb(changed) }));
});
test("empty account snapshot aborts the updater", async () => {
  await assert.rejects(readUpdateBackupSources({ storage: storage([]), indexedDb: indexedDb({}) }), /没有可备份/);
});
