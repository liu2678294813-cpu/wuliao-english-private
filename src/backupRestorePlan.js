import { IDB_INCLUDED, classifyLocalKey, USER_PREFIX, decodeAttachment } from './backup.js';
import { FORMAL_IMPORT_STORES } from './import/contracts.js';
import { openBackupStaging } from './backupStaging.js';
import { UpdateBackupHash } from './updateBackupStream.js';

const encoder = new TextEncoder();
async function* canonical(value) {
  if (value instanceof Blob) {
    yield 'blob:' + value.size + ':';
    for (let i = 0; i < value.size; i += 196608) yield new Uint8Array(await value.slice(i, i + 196608).arrayBuffer());
  } else if (typeof value === 'string') {
    yield 'string:' + value.length + ':';
    for (let i = 0; i < value.length;) {
      let end = Math.min(value.length, i + 8192);
      if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
      yield JSON.stringify(value.slice(i, end)); i = end;
    }
  } else if (Array.isArray(value)) {
    yield '['; for (const item of value) { yield* canonical(item); yield ','; } yield ']';
  } else if (value && typeof value === 'object') {
    yield '{'; for (const key of Object.keys(value).sort()) { if (value[key] === undefined) continue; yield JSON.stringify(key) + ':'; yield* canonical(value[key]); yield ','; } yield '}';
  } else yield JSON.stringify(value ?? null);
}
export async function recordFingerprint(value) {
  const hash = new UpdateBackupHash();
  for await (const piece of canonical(value)) hash.update(typeof piece === 'string' ? encoder.encode(piece) : piece);
  return hash.hex();
}
function groupFor(record) {
  const text = record.key + ' ' + (record.store || '');
  if (record.store?.startsWith('sentence-review-') || /wuliao:(?:pref:)?sentence-review|review:sentence_recheck:warehouse:/.test(record.key)) return ['reading', '阅读、完形、翻译与笔迹'];
  if (record.db?.startsWith('Kaoyan') || /vocab|memory|screening|memorize/i.test(text)) return ['vocabulary', '单词与词库（关联记录一起选择）'];
  if (FORMAL_IMPORT_STORES.includes(record.store) || record.store === 'custom-pdfs' || record.store === 'writing-materials') return ['materials', '导入资料、附件与答案（关联记录一起选择）'];
  if (/writing/.test(text)) return ['writing', '作文与作文笔迹'];
  if (/long-sentence/.test(text)) return ['long-sentence', '长难句训练'];
  if (/ink|reading|deep|cloze|translation|answer/.test(text)) return ['reading', '阅读、完形、翻译与笔迹'];
  return ['other', '其他学习记录与设置'];
}
const summary = value => {
  if (typeof value === 'string') {
    try { return summary(JSON.parse(value)); } catch { return value.slice(0, 100); }
  }
  if (!value) return '无本机记录';
  const time = value.updatedAt || value.modifiedAt;
  const label = value.title || value.word || value.term || value.name || (Array.isArray(value) ? `${value.length} 项` : `${Object.keys(value).length} 个字段`);
  return `${String(label).slice(0, 80)} · ${Number.isFinite(time) ? new Date(time).toLocaleString() : '时间未知'}`;
};
export async function createRestorePlan({ manifest, username, sources, active = () => {}, onProgress = () => {} }) {
  if (manifest.accounts?.length !== 1 || manifest.accounts[0].username !== username) throw new Error('备份账号与当前账号不一致，请先创建或切换到同名账号。');
  const stage = await openBackupStaging(), rows = stage.list(), groups = new Map();
  const counts = { added: 0, same: 0, conflict: 0 }; let scanned = 0;
  const targets = new Set(), incomingTargets = new Set();
  const add = async record => {
    active(); const before = record.db ? await sources.idb.get(record.db, record.store, record.key) ?? null : sources.readLocal(record.key);
    const beforeHash = await recordFingerprint(before), incomingHash = await recordFingerprint(record.incoming);
    const kind = beforeHash === incomingHash ? 'same' : before === null ? 'added' : 'conflict'; counts[kind]++;
    if (kind !== 'same') {
      const [group, label] = groupFor(record);
      if (!groups.has(group)) groups.set(group, { id: group, label, added: 0, conflicts: 0, examples: [] });
      const g = groups.get(group); if (kind === 'conflict') g.conflicts++; else g.added++;
      if (kind === 'conflict' && g.examples.length < 3) g.examples.push({ local: summary(before), incoming: summary(record.incoming) });
      await rows.push({ ...record, beforeHash, incomingHash, kind, group });
    }
    if (++scanned % 64 === 0) onProgress(`正在比较两端记录：${scanned} 条…`);
  };
  try {
    const prefix = `${USER_PREFIX}${encodeURIComponent(username)}:`;
    for (const section of ['user', 'userRaw', 'legacy', 'device']) {
      for await (const record of manifest.sections.localStorage[section] || []) {
        const key = section === 'user' || section === 'legacy' ? prefix + record.key : record.key;
        if (targets.has(key)) {
          if (section === 'legacy') continue;
          throw new Error('备份包含重复的学习记录');
        }
        targets.add(key);
        const classification = classifyLocalKey(key, { username, legacyOwner: username });
        if (!['user', 'user-raw', 'device'].includes(classification)) continue;
        await add({ key, incoming: record.value });
      }
    }
    for (const [db, stores] of Object.entries(manifest.sections.indexedDB)) for (const [store, list] of Object.entries(stores)) {
      if (!Object.hasOwn(IDB_INCLUDED[db] || {}, store)) throw new Error('备份包含不允许恢复的数据库');
      for await (const record of list) {
        active(); if (record.value.username != null && record.value.username !== username) throw new Error('备份混入其他账号的记录');
        let incoming = record.value;
        const target = JSON.stringify([db, store, record.key]);
        if (incomingTargets.has(target)) throw new Error('备份包含重复的数据库记录');
        incomingTargets.add(target);
        if (incoming.file?.__backupAttachment) { const decoded = decodeAttachment(manifest, incoming); incoming = { ...incoming, file: new File([decoded.bytes], decoded.fileMeta.name || 'backup.pdf', { type: decoded.fileMeta.type }) }; }
        await add({ db, store, key: record.key, incoming });
      }
    }
    for (const [db, stores] of Object.entries(manifest.sections.indexedDB)) for (const [store, list] of Object.entries(stores)) {
      if (db !== 'wuliao-english') continue;
      for await (const record of list) {
        const value = record.value;
        const references = [value.sourceFileId, ...(value.content?.assets || []).map(a => a.fileId)].filter(Boolean).map(key => ['import-files', key]);
        if (value.materialId && ['material-answers', 'material-explanations', 'answer-evaluations'].includes(store)) {
          const candidates = ['custom-pdfs', 'writing-materials'];
          let found = false;
          for (const candidate of candidates) if (incomingTargets.has(JSON.stringify([db, candidate, value.materialId])) || (await sources.idb.get(db, candidate, value.materialId))?.username === username) found = true;
          if (!found) throw new Error('备份中的答案或评分缺少对应资料');
        }
        for (const [targetStore, key] of references) {
          active();
          if (!incomingTargets.has(JSON.stringify([db, targetStore, key])) && (await sources.idb.get(db, targetStore, key))?.username !== username) throw new Error('备份缺少资料引用的附件');
        }
      }
    }
    await rows.flush?.();
    return { username, counts, groups: [...groups.values()], rows, dispose: () => stage.close() };
  } catch (error) { await stage.close(); throw error; }
}

// Independent recovery database: never included in normal backups or LAN sends.
export async function openRestoreHistory(indexedDb = globalThis.indexedDB) {
  const db = await new Promise((r, j) => { const q = indexedDb.open('wuliao-transfer-recovery', 1); q.onupgradeneeded = () => { q.result.createObjectStore('history', { keyPath: 'id' }); q.result.createObjectStore('rows'); }; q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const op = (store, mode, fn) => new Promise((r, j) => { const tx = db.transaction(store, mode), q = fn(tx.objectStore(store)); tx.oncomplete = () => r(q.result); tx.onerror = () => j(tx.error); tx.onabort = () => j(tx.error || new Error('恢复资料写入失败')); });
  return {
    put: value => op('history', 'readwrite', s => s.put(value)),
    get: id => op('history', 'readonly', s => s.get(id)),
    list: async username => (await op('history', 'readonly', s => s.getAll())).filter(h => h.username === username).sort((a, b) => b.createdAt - a.createdAt),
    row: (id, index) => op('rows', 'readonly', s => s.get([id, index])),
    write: (id, index, value) => op('rows', 'readwrite', s => s.put(value, [id, index])),
    async delete(id, username) { const h = await this.get(id); if (!h || h.username !== username) throw new Error('恢复历史账号不一致'); await op('rows', 'readwrite', s => s.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))); await op('history', 'readwrite', s => s.delete(id)); },
    close: () => db.close(),
  };
}
async function readCurrent(row, sources) { return row.db ? await sources.idb.get(row.db, row.store, row.key) ?? null : sources.readLocal(row.key); }
async function conditionalWrite(row, value, expected, sources, username) {
  if (row.db) return sources.idb.compareAndPut(row.db, row.store, row.key, value, expected, recordFingerprint);
  // Local strings are read synchronously again after the async fingerprint.
  const current = sources.readLocal(row.key);
  if (await recordFingerprint(current) !== expected || sources.readLocal(row.key) !== current) throw new Error('本机记录已变化，请重新预览');
  if (value === null) await sources.removeLocal(row.key, username);
  else await sources.writeLocal({ key: row.key, value, restoringUsername: username });
}
export async function applyRestorePlan({ plan, choices, sources, history, active = () => {}, onProgress = () => {} }) {
  const id = crypto.randomUUID(), entry = { id, username: plan.username, createdAt: Date.now(), state: 'preparing', count: 0, written: 0 };
  await history.put(entry);
  try {
    // All original values must be durable and read back before the first learning write.
    for await (const row of plan.rows) {
      active(); const group = plan.groups.find(g => g.id === row.group);
      if (group.conflicts && choices[row.group] !== 'incoming') continue;
      const before = await readCurrent(row, sources);
      if (await recordFingerprint(before) !== row.beforeHash) throw new Error('预览后本机记录发生变化，请重新选择备份。');
      const index = entry.count++;
      await history.write(id, index, { ...row, before, state: 'pending' });
      const checked = await history.row(id, index);
      if (await recordFingerprint(checked.before) !== row.beforeHash || await recordFingerprint(checked.incoming) !== row.incomingHash) throw new Error('恢复资料回读校验失败，已停止导入');
    }
    entry.state = 'applying'; await history.put(entry);
    for (let index = 0; index < entry.count; index++) {
      active(); const row = await history.row(id, index);
      // Write-ahead state also covers a crash between the write and its receipt.
      row.state = 'writing'; await history.write(id, index, row);
      await conditionalWrite(row, row.incoming, row.beforeHash, sources, plan.username);
      if (await recordFingerprint(await readCurrent(row, sources)) !== row.incomingHash) throw new Error('写入后的记录校验失败');
      row.state = 'applied'; await history.write(id, index, row); entry.written++;
      onProgress(`正在导入并核验：${entry.written}/${entry.count}`);
    }
    entry.state = 'complete'; await history.put(entry); return entry;
  } catch (error) { entry.state = 'interrupted'; entry.error = error.message; await history.put(entry); throw error; }
}
export async function recoverRestoreHistory({ id, username, sources, history, active = () => {} }) {
  const entry = await history.get(id);
  if (!entry || entry.username !== username) throw new Error('恢复历史账号不一致');
  let restored = 0, changed = 0;
  for (let index = entry.count - 1; index >= 0; index--) {
    active(); const row = await history.row(id, index);
    // Added records stay: recovery never deletes subsequently used study content.
    if (!row || row.before === null || row.state === 'pending' || row.state === 'recovered') continue;
    const currentHash = await recordFingerprint(await readCurrent(row, sources));
    if (currentHash === row.beforeHash) { row.state = 'recovered'; await history.write(id, index, row); continue; }
    if (currentHash !== row.incomingHash) { changed++; continue; }
    await conditionalWrite(row, row.before, row.incomingHash, sources, username);
    if (await recordFingerprint(await readCurrent(row, sources)) !== row.beforeHash) throw new Error('恢复后校验失败');
    row.state = 'recovered'; await history.write(id, index, row); restored++;
  }
  entry.state = changed ? 'recovery-conflicts' : 'recovered'; await history.put(entry); return { restored, changed };
}
