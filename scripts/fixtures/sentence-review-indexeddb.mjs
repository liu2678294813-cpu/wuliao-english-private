// Small transactional IndexedDB double: failures after put roll back the whole
// transaction. Browser tests separately exercise the real IndexedDB engine.
export function sentenceReviewDatabase() {
  const stores = new Map();
  let failure = null;
  const contains = values => ({ contains: name => values.has(name) });
  const db = {
    version: 9, objectStoreNames: contains(stores), close() {},
    createObjectStore(name, { keyPath = "id" } = {}) {
      const definition = { records: new Map(), indexes: new Map(), keyPath };
      stores.set(name, definition);
      return { createIndex: (index, path) => definition.indexes.set(index, path) };
    },
    transaction(selected, mode) {
      const names = Array.isArray(selected) ? selected : [selected];
      const local = new Map(names.map(name => [name, new Map(stores.get(name).records)]));
      let pending = 0, stopped = false, queued = false;
      const tx = {
        abort() { if (stopped) return; stopped = true; queueMicrotask(() => tx.onabort?.()); },
        objectStore(name) {
          const definition = stores.get(name), records = local.get(name);
          const request = action => {
            const req = {}; pending++;
            queueMicrotask(() => {
              if (stopped) return;
              try { req.result = structuredClone(action()); req.onsuccess?.({ target: req }); }
              catch (error) { req.error = error; tx.error = error; req.onerror?.(); tx.abort(); }
              pending--; finish();
            });
            return req;
          };
          return {
            keyPath: definition.keyPath, indexNames: contains(definition.indexes),
            get: key => request(() => records.get(key)), getAll: () => request(() => [...records.values()]),
            put: value => request(() => { records.set(value[definition.keyPath], structuredClone(value)); return value[definition.keyPath]; }),
            index(indexName) {
              const path = definition.indexes.get(indexName);
              if (!path) throw new Error(`Missing index ${indexName}`);
              return { getAll: query => request(() => [...records.values()].filter(value => {
                const key = Array.isArray(path) ? path.map(part => value[part]) : value[path];
                return JSON.stringify(key) === JSON.stringify(query);
              })) };
            },
          };
        },
      };
      function finish() {
        if (pending || stopped || queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (pending || stopped) return;
          if (mode === "readwrite" && failure?.(local)) {
            failure = null; tx.error = new Error("simulated quota abort after put"); tx.abort(); return;
          }
          stopped = true;
          if (mode === "readwrite") for (const [name, records] of local) stores.get(name).records = records;
          tx.oncomplete?.();
        });
      }
      queueMicrotask(finish);
      return tx;
    },
  };
  return { stores, failCommitWhen: predicate => { failure = predicate; }, indexedDb: {
    open(_name, version = db.version) {
      const request = {};
      queueMicrotask(() => {
        request.result = db;
        if (version > db.version) { db.version = version; request.onupgradeneeded?.(); }
        request.onsuccess?.();
      });
      return request;
    },
  } };
}
