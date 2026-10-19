import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTransferController, privateHost } from './device-transfer-server.mjs';
import { makeConnection, connectionCode, parseConnection, transferCipher, sendDeviceBackup } from '../src/deviceTransfer.js';
import { createRestorePlan, applyRestorePlan, recoverRestoreHistory, recordFingerprint } from '../src/backupRestorePlan.js';
import { createBackup } from '../src/backup.js';

test('connection codes reject public targets and AEAD rejects tampering / wrong chunk / wrong session', async () => {
  const info = await makeConnection(async () => ({ id: 'a'.repeat(48), token: 'b'.repeat(48), hosts: ['192.168.1.2'], port: 12345 }));
  assert.deepEqual(parseConnection(connectionCode(info, info.hosts[0])).host, '192.168.1.2');
  assert.throws(() => parseConnection(connectionCode(info, '8.8.8.8')), /连接码/);
  assert.throws(() => parseConnection(connectionCode(info, '010.8.8.8')), /连接码/);
  assert.equal(privateHost('010.8.8.8'), false);
  assert.equal(privateHost('192.168.1.2'), true); assert.equal(privateHost('192.168.1.999'), false);
  const cipher = await transferCipher(info), bytes = new TextEncoder().encode('学习😀');
  const data = await cipher.encrypt(1, bytes);
  assert.notEqual(data, await cipher.encrypt(1, bytes), 'retry must use a fresh nonce');
  assert.deepEqual(await cipher.decrypt(1, data), bytes);
  await assert.rejects(cipher.decrypt(2, data), /解密/);
  const other = await transferCipher({ ...info, id: 'c'.repeat(48) }); await assert.rejects(other.decrypt(1, data), /解密/);
  await assert.rejects(cipher.decrypt(1, data.slice(0, -4) + 'AAAA'), /解密/);
});

test('real TCP ciphertext transfer: offer confirmation, ordering, checksum, invalid token and cleanup', async () => {
  await mkdir('artifacts/backup-transfer-20261019', { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/backup-transfer-20261019/tcp-'));
  const receiver = createTransferController({ directory, bind: '127.0.0.1', advertisedHosts: ['127.0.0.1'] });
  const sender = createTransferController({ directory: directory + '-sender' });
  try {
    const info = await makeConnection(receiver.command);
    const sending = sendDeviceBackup({ code: connectionCode(info, '127.0.0.1'), username: 'alice', appVersion: 'test', active() {}, onProgress() {}, command: sender.command,
      sources: { entries: [{ key: 'wuliao:user:alice:wuliao:reading-progress:test', value: '学习😀'.repeat(50000) }], databases: [] } });
    let status; do { await new Promise(r => setTimeout(r, 20)); status = await receiver.command('status'); } while (status.state === 'waiting');
    assert.equal(status.state, 'offered');
    await assert.rejects(sender.command('remote', { host: '127.0.0.1', port: info.port, token: 'bad', method: 'status', body: {} }), /连接码/);
    await receiver.command('accept'); await sending;
    status = await receiver.command('status'); assert.equal(status.state, 'complete');
    const cipher = await transferCipher(info);
    const finish = JSON.parse(new TextDecoder().decode(await cipher.decrypt(0xffffffff, status.finish)));
    const parts = [];
    for (let index = 0; index < status.chunks; index++) { const part = await receiver.command('read', { index }); parts.push(await cipher.decrypt(index + 1, part.data)); }
    const file = new Blob(parts); assert.equal(file.size, finish.size);
    const manifest = JSON.parse(await file.text()); assert.ok(manifest.sections.localStorage.user[0].value.includes('学习😀'));
    await assert.rejects(sender.command('remote', { host: '127.0.0.1', port: info.port, token: info.token, method: 'chunk', body: { index: 0, data: 'AAAA' } }), /完成/);
    await receiver.stop(); await assert.rejects(receiver.command('status'), /结束/);
  } finally { await receiver.stop(); await sender.stop(); await rm(directory, { recursive: true, force: true }); }
});

function adapters() {
  const local = new Map([['wuliao:user:alice:wuliao:reading-progress:test', 'old']]), idb = new Map();
  const sources = { readLocal: k => local.get(k) ?? null, writeLocal: async ({ key, value }) => local.set(key, value), removeLocal: async k => local.delete(k),
    idb: { get: async (db, store, key) => idb.get(JSON.stringify([db, store, key])) ?? null, async compareAndPut(db, store, key, value, expected, fp) {
      const id = JSON.stringify([db, store, key]); if (await fp(idb.get(id) ?? null) !== expected) throw new Error('changed'); idb.set(id, value);
    } } };
  const entries = new Map(), rows = new Map();
  const history = { async put(h) { entries.set(h.id, structuredClone(h)); }, async get(id) { return entries.get(id); }, async write(id, i, row) { rows.set(id + ':' + i, structuredClone(row)); }, async row(id, i) { return rows.get(id + ':' + i); } };
  return { local, sources, history, entries };
}
async function planFor(sources) {
  const { manifest } = await createBackup({ username: 'alice', sources: { entries: [
    { key: 'wuliao:user:alice:wuliao:reading-progress:test', value: 'new' },
    { key: 'wuliao:user:alice:wuliao:other:new', value: 'addition' },
  ], databases: [] }, serialize: false });
  return createRestorePlan({ manifest, username: 'alice', sources });
}
test('restore previews every conflict; default preserves local; explicit replacement and repeat are idempotent', async () => {
  const a = adapters(), plan = await planFor(a.sources);
  assert.deepEqual(plan.counts, { added: 1, same: 0, conflict: 1 });
  let result = await applyRestorePlan({ plan, choices: {}, ...a });
  assert.equal(result.written, 1); assert.equal(a.local.get('wuliao:user:alice:wuliao:reading-progress:test'), 'old');
  const next = await planFor(a.sources); result = await applyRestorePlan({ plan: next, choices: { reading: 'incoming' }, ...a });
  assert.equal(a.local.get('wuliao:user:alice:wuliao:reading-progress:test'), 'new');
  const repeat = await planFor(a.sources); assert.equal(repeat.counts.same, 2);
  const recovery = await recoverRestoreHistory({ id: result.id, username: 'alice', ...a }); assert.equal(recovery.restored, 1);
  assert.equal(a.local.get('wuliao:user:alice:wuliao:reading-progress:test'), 'old');
});
test('preflight changes and failed recovery persistence stop all writes; later study is preserved on recovery', async () => {
  const a = adapters(), plan = await planFor(a.sources);
  a.local.set('wuliao:user:alice:wuliao:reading-progress:test', 'later');
  await assert.rejects(applyRestorePlan({ plan, choices: { reading: 'incoming' }, ...a }), /变化/);
  assert.equal(a.local.has('wuliao:user:alice:wuliao:other:new'), false);
  const fresh = await planFor(a.sources);
  const badHistory = { ...a.history, async write() { throw Error('quota'); } };
  await assert.rejects(applyRestorePlan({ plan: fresh, choices: { reading: 'incoming' }, ...a, history: badHistory }), /quota/);
  assert.equal(a.local.get('wuliao:user:alice:wuliao:reading-progress:test'), 'later');
  const result = await applyRestorePlan({ plan: fresh, choices: { reading: 'incoming' }, ...a });
  a.local.set('wuliao:user:alice:wuliao:reading-progress:test', 'studied after import');
  const recovery = await recoverRestoreHistory({ id: result.id, username: 'alice', ...a }); assert.equal(recovery.changed, 1);
  assert.equal(a.local.get('wuliao:user:alice:wuliao:reading-progress:test'), 'studied after import');
  await assert.rejects(recoverRestoreHistory({ id: result.id, username: 'bob', ...a }), /账号/);
});
test('fingerprints compare object keys and binary contents, not filenames or attachment size alone', async () => {
  assert.equal(await recordFingerprint({ a: 1, b: 2 }), await recordFingerprint({ b: 2, a: 1 }));
  assert.notEqual(await recordFingerprint(new Blob(['abc'])), await recordFingerprint(new Blob(['abd'])));
});
