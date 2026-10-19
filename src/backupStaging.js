// Each operation owns a temporary database. No learning store is changed.
export async function openBackupStaging(indexedDb = globalThis.indexedDB) {
  if (!indexedDb) return { list: () => [], close: async () => {} };
  const name = `wuliao-backup-stage-${crypto.randomUUID()}`;
  const db = await new Promise((resolve, reject) => {
    const r = indexedDb.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('records');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  let next = 0;
  const lists = [];
  let transactions = 0;
  return {
    get transactions() { return transactions; },
    async flush() { for (const list of lists) await list.flush(); },
    list() {
      const id = next++;
      let pending = [], bytes = 0;
      const list = {
        length: 0,
        async flush() {
          if (!pending.length) return;
          const batch = pending;
          pending = []; bytes = 0;
          transactions++;
          await new Promise((resolve, reject) => {
            const tx = db.transaction('records', 'readwrite');
            for (const [index, value] of batch) tx.objectStore('records').put(value, [id, index]);
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('备份暂存失败'));
          });
        },
        async push(value) {
          const size = typeof value.value === 'string' ? value.value.length * 2 : JSON.stringify(value).length * 2;
          if (bytes + size > 4 * 1024 * 1024) await this.flush();
          pending.push([this.length++, value]); bytes += size;
          if (pending.length >= 64 || bytes >= 4 * 1024 * 1024) await this.flush();
        },
        async *[Symbol.asyncIterator]() {
          await this.flush();
          for (let start = 0; start < this.length; start += 64) {
            const rows = await new Promise((resolve, reject) => {
              const tx = db.transaction('records', 'readonly');
              const r = tx.objectStore('records').getAll(IDBKeyRange.bound([id, start], [id, Math.min(start + 63, this.length - 1)]));
              r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            });
            for (const row of rows) yield row;
          }
        },
      };
      lists.push(list);
      return list;
    },
    async close() {
      db.close();
      await new Promise((resolve, reject) => { const r = indexedDb.deleteDatabase(name); r.onsuccess = resolve; r.onerror = () => reject(r.error); r.onblocked = () => reject(new Error('备份暂存区仍被占用')); });
    },
  };
}
