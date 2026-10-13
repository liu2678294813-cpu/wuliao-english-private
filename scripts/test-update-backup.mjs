import test from "node:test";
import assert from "node:assert/strict";
import { readUpdateBackupSources, createBackup, parseBackup } from "../src/backup.js";
import { UpdateBackupHash, hashUpdateAttachment, writeStreamedUpdateBackup } from "../src/updateBackupStream.js";
import { createHash } from "node:crypto";

test("streamed SHA-256 matches independent vectors at padding and chunk boundaries", () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 65537]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 251), hash = new UpdateBackupHash();
    for (let offset = 0; offset < length; offset += 17) hash.update(bytes.subarray(offset, offset + 17));
    assert.equal(hash.hex(), createHash('sha256').update(bytes).digest('hex'), String(length));
  }
});

test("update backup streams a real attachment with bounded reads, valid Backup v1 checksum and native readback hash", async () => {
  const data = Uint8Array.from({ length: 1024 * 1024 + 5 }, (_, i) => i % 251);
  const original = new Blob([data], { type: 'application/pdf' });
  let maxRead = 0;
  const blob = { size: original.size, type: original.type, arrayBuffer() { throw Error('whole attachment read'); },
    slice(start, end) { maxRead = Math.max(maxRead, end - start); return original.slice(start, end); } };
  const sources = { entries: [], databases: [{ name: 'wuliao-english', stores: [{ name: 'custom-pdfs', records: [{ key: 'pdf', value: { id: 'pdf', username: 'alice', file: blob } }] }] }] };
  const blobs = new Map();
  const built = await createBackup({ sources, username: 'alice', encodeAttachment: async value => { blobs.set('att-1', value); return hashUpdateAttachment(value, () => {}); } });
  const metadata = await parseBackup(built.fileText), chunks = [];
  let offset = 0, completed = false;
  const plugin = {
    async writeBackupChunk(part) { const bytes = Buffer.from(part.data, 'base64'); assert.equal(part.offset, offset); assert.ok(bytes.length <= 192 * 1024); chunks.push(bytes); offset += bytes.length; },
    async finishBackupAccount(part) { assert.equal(part.sha256, createHash('sha256').update(Buffer.concat(chunks)).digest('hex')); completed = true; return { verified: true }; },
  };
  await writeStreamedUpdateBackup({ manifest: metadata, blobs, plugin, backupId: 'test', accountIndex: 0, active() {} });
  const parsed = await parseBackup(Buffer.concat(chunks).toString('utf8'));
  assert.deepEqual(Buffer.from(parsed.attachments['att-1'].data, 'base64'), Buffer.from(data));
  assert.equal(parsed.attachments['att-1'].sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(parsed.attachments['att-1'].size, data.length);
  assert.equal(parsed.sections.indexedDB['wuliao-english']['custom-pdfs'][0].value.file.__backupAttachment, 'att-1');
  assert.ok(maxRead <= 96 * 1024); assert.ok(completed);
});

test("streamed backup stops when cancelled or native readback verification fails", async () => {
  const manifest = (await createBackup({ sources: { entries: [], databases: [] }, username: 'alice' })).manifest;
  const options = { manifest, blobs: new Map(), backupId: 'test', accountIndex: 0 };
  await assert.rejects(writeStreamedUpdateBackup({ ...options, plugin: { writeBackupChunk() { throw Error('should not write'); } }, active() { throw Error('cancelled'); } }), /cancelled/);
  await assert.rejects(writeStreamedUpdateBackup({ ...options, plugin: { async writeBackupChunk() {}, async finishBackupAccount() { return { verified: false }; } }, active() {} }), /校验/);
});

test("large durable ink is escaped in bounded pieces without serializing the whole account, including Unicode boundaries", async () => {
  const ink = 'a'.repeat(8191) + '😀\\\"\n' + '笔迹\\\"\n'.repeat(300000) + '\ud800';
  const sources = { entries: [{ key: 'wuliao:user:alice:wuliao:deep-ink:v2:fixture', value: ink }], databases: [] };
  const stringify = JSON.stringify, chunks = [];
  let built;
  JSON.stringify = function(value, ...args) {
    if (typeof value === 'string') assert.ok(value.length <= 8192, 'large string encoded in one call');
    if (value?.format === 'wuliao-backup') throw Error('whole account serialization');
    return stringify.call(this, value, ...args);
  };
  try {
    built = await createBackup({ sources, username: 'alice', serialize: false });
    assert.equal(built.fileText, undefined);
    await writeStreamedUpdateBackup({ manifest: built.manifest, blobs: new Map(), backupId: 'test', accountIndex: 0, active() {}, plugin: {
      async writeBackupChunk(part) { const bytes = Buffer.from(part.data, 'base64'); assert.ok(bytes.length <= 192 * 1024); chunks.push(bytes); },
      async finishBackupAccount(part) { assert.equal(part.sha256, createHash('sha256').update(Buffer.concat(chunks)).digest('hex')); return { verified: true }; },
    } });
  } finally { JSON.stringify = stringify; }
  const parsed = await parseBackup(Buffer.concat(chunks).toString('utf8'));
  assert.equal(parsed.sections.localStorage.user[0].value, ink);
});

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
