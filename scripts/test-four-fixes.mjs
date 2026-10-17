import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBackup, browserEncodeAttachment, restoreBackup } from '../src/backup.js';
import { exportManualBackup, parseBackupFile, openBackupDestination } from '../src/manualBackup.js';
import { createScreeningController } from '../public/vocabulary/screening-controller.js';
import { uniqueScreeningOptions, displayMeaning } from '../public/vocabulary/screening-options.js';
import { listExamples, saveExample, deleteExample } from '../src/writing/writingExamples.js';

function sink() {
  const parts = []; let length = 0, finished = false, aborted = false;
  return { parts, get finished() { return finished; }, get aborted() { return aborted; }, saved: true, backupId: 'test',
    async abort() { aborted = true; }, plugin: {
      async writeBackupChunk({ data, offset }) { assert.equal(offset, length); const bytes = Buffer.from(data, 'base64'); assert.ok(bytes.length <= 192 * 1024); parts.push(bytes); length += bytes.length; },
      async finishBackupAccount({ sha256 }) { const hash = createHash('sha256'); for (const part of parts) hash.update(part); assert.equal(hash.digest('hex'), sha256); finished = true; return { verified: true }; },
    }, file() { return new Blob(parts); },
  };
}
const fixtures = (file, ink = '笔迹😀\\"\n') => ({ entries: [{ key: 'wuliao:user:alice:wuliao:ink:test', value: ink }],
  databases: [{ name: 'wuliao-english', stores: [{ name: 'custom-pdfs', records: [{ key: 'pdf', value: { id: 'pdf', username: 'alice', file } }] }] }] });

test('manual v1 export and chunked restore preserve 100 MiB attachment and Unicode ink without whole-file reads', async () => {
  const block = new Uint8Array(1024 * 1024).fill(37), file = new Blob(Array(100).fill(block), { type: 'application/pdf' });
  const ink = 'a'.repeat(8191) + '😀\\"\n笔迹'.repeat(10000) + '\ud800';
  const destination = sink();
  const { counts } = await exportManualBackup({ username: 'alice', appVersion: 'test', sources: fixtures(file, ink), destination });
  assert.equal(counts.customPdfs, 1); assert.ok(destination.finished);
  const output = destination.file();
  const parsed = await parseBackupFile({ size: output.size, slice: (...args) => output.slice(...args), text() { throw Error('whole read'); } });
  assert.equal(parsed.sections.localStorage.user[0].value, ink);
  assert.equal(parsed.attachments['att-1'].blob.size, file.size);
  const local = new Map(), records = new Map();
  const writeLocal = async ({ key, value }) => local.set(key, value); writeLocal.read = key => local.get(key);
  const idb = { async listExists(db, store, key) { return records.has(key); }, async put(db, store, key, value) { records.set(key, value); }, async get(db, store, key) { return records.get(key); } };
  const options = { manifest: parsed, username: 'alice', existingEntries: [], writeLocal, idb, createFile: (meta, bytes) => new Blob([bytes], { type: meta.type }) };
  const first = await restoreBackup(options); assert.equal(first.ok, true); assert.equal(first.writtenLocal, 1); assert.equal(first.writtenIdb, 1);
  assert.equal(records.get('pdf').file.size, file.size);
  const hash = createHash('sha256'); for (let offset = 0; offset < file.size; offset += block.length) hash.update(new Uint8Array(await records.get('pdf').file.slice(offset, offset + block.length).arrayBuffer()));
  assert.equal(hash.digest('hex'), parsed.attachments['att-1'].sha256);
  const second = await restoreBackup({ ...options, existingEntries: [...local].map(([key, value]) => ({ key, value })) });
  assert.equal(second.writtenLocal + second.writtenIdb, 0);
  await assert.rejects(restoreBackup({ ...options, username: 'bob' }), /账号/);
  await parsed.dispose();
});

test('legacy v1, corrupt attachment, truncation, checksum mismatch and cancellation', async () => {
  const { fileText } = await createBackup({ sources: fixtures(new Blob(['abc😀'])), username: 'alice', encodeAttachment: browserEncodeAttachment });
  const parsed = await parseBackupFile(new Blob([fileText])); assert.equal(parsed.attachments['att-1'].blob.size, 7); await parsed.dispose();
  await assert.rejects(parseBackupFile(new Blob([fileText.slice(0, -2)])), /截断|格式/);
  await assert.rejects(parseBackupFile(new Blob([fileText.replace('笔迹', '修改')])), /校验/);
  const bad = JSON.parse(fileText); bad.attachments['att-1'].size++;
  await assert.rejects(parseBackupFile(new Blob([JSON.stringify(bad)])), /附件/);
  const destination = sink();
  await assert.rejects(exportManualBackup({ username: 'alice', destination, sources: fixtures(new Blob(['x'])), active() { throw Error('cancelled'); } }), /cancelled/);
  assert.ok(destination.aborted); assert.equal(destination.finished, false);
});

test('12 visible meanings stay unique through prefixes, whitespace, fallback and shuffle', () => {
  assert.equal(displayMeaning(' A.  改善；提高\u200b '), '改善；提高');
  const word = { wordId: 'word', english: 'improve', chinese: 'A. 改善；提高' };
  const pool = ['改善；提高', ' B、改善；提高 ', ...Array.from({ length: 30 }, (_, i) => `含义${i}`)].flatMap((chinese, i) => [{ chinese, sourceWord: `w${i}`, sourceWordId: `id${i}` }, { chinese: `C. ${chinese}`, sourceWord: `w${i}` }]);
  for (let i = 0; i < 200; i++) {
    const options = uniqueScreeningOptions(word, pool, { similar: () => true });
    assert.equal(options.length, 12); assert.equal(new Set(options.map(o => o.chinese)).size, 12); assert.equal(options.filter(o => o.isCorrect).length, 1);
    assert.equal(options.find(o => o.isCorrect).chinese, '改善；提高');
  }
  assert.throws(() => uniqueScreeningOptions(word, pool.slice(0, 3)), /不足 12/);
});

test('insufficient options can retry or skip without recording a wrong answer', async () => {
  const saved = []; let available = false;
  const controller = createScreeningController({ skipId: 'skip',
    async load() { return { username: 'alice', round: 1, sessionKey: 'a', currentIndex: 0, sourceWordIds: ['a', 'b'], correctIds: [], wrongIds: [] }; },
    async word(id) { return { english: id }; },
    async options(id) { if (!available && id === 'a') throw Object.assign(Error('不足 12'), { code: 'insufficient-meanings' }); return [{ id: 'yes', chinese: '有效释义', isCorrect: true }]; },
    async save(session, record) { saved.push({ session, record }); }, error(message) { throw Error(message); },
  }, () => {});
  await controller.start('alice', 1, 0); assert.equal(controller.getState().optionError, '不足 12');
  available = true; await controller.retry(); assert.equal(controller.getState().optionError, '');
  available = false; await controller.retry(); await controller.answer('skip');
  assert.equal(saved[0].record, null); assert.equal(saved[0].session.wrongIds.length, 0);
  assert.equal(controller.getState().currentIndex, 1); controller.dispose();
});

test('desktop file writer verifies saved bytes and rejects corrupted readback', async () => {
  let parts = [], corrupt = false;
  globalThis.showSaveFilePicker = async () => ({
    async createWritable() { parts = []; return { async write(bytes) { parts.push(bytes); }, async close() {}, async abort() {} }; },
    async getFile() { return new Blob(corrupt ? ['corrupt'] : parts); },
  });
  try {
    const destination = await openBackupDestination('backup.json');
    const result = await exportManualBackup({ username: 'alice', sources: fixtures(new Blob(['sample'])), destination });
    assert.equal(result.saved, true);
    corrupt = true;
    await assert.rejects(exportManualBackup({ username: 'alice', sources: fixtures(new Blob(['sample'])), destination: await openBackupDestination('backup.json') }), /回读校验失败/);
  } finally { delete globalThis.showSaveFilePicker; }
});

test('examples persist per account, deduplicate source, survive source removal, and retain deletion tombstones', () => {
  const map = new Map([['kaoyan_vocab_current_user', 'alice']]);
  globalThis.localStorage = { get length() { return map.size; }, key: i => [...map.keys()][i], getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
  const source = { sessionId: 's1', documentId: 's1:W1:0', title: '2023 范文' };
  const first = saveExample('alice', { text: 'Learning changes our lives.', source });
  assert.equal(saveExample('alice', { text: 'Learning changes our lives.', source }).duplicate, true);
  saveExample('alice', { text: 'Learning changes our lives.', source: { ...source, documentId: 's2:W1:0' } });
  assert.equal(listExamples('alice').length, 2);
  deleteExample('alice', first.item.id); assert.equal(listExamples('alice').length, 1);
  assert.ok([...map.values()].some(value => value.includes('deletedAt')));
  map.set('kaoyan_vocab_current_user', 'bob'); assert.equal(listExamples('bob').length, 0);
  assert.throws(() => saveExample('alice', { text: 'wrong account', source }), /账号/);
  delete globalThis.localStorage;
});
