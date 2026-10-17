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
  return {
    list() {
      const id = next++;
      return {
        length: 0,
        async push(value) {
          const index = this.length;
          await new Promise((resolve, reject) => {
            const tx = db.transaction('records', 'readwrite');
            tx.objectStore('records').put(value, [id, index]);
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('备份暂存失败'));
          });
          this.length++;
        },
        async *[Symbol.asyncIterator]() {
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
    },
    async close() {
      db.close();
      await new Promise((resolve, reject) => { const r = indexedDb.deleteDatabase(name); r.onsuccess = resolve; r.onerror = () => reject(r.error); r.onblocked = () => reject(new Error('备份暂存区仍被占用')); });
    },
  };
}
