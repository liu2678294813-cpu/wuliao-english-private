// Each word has a committed base plus replayable, optimistic operations.
// Removing a failed operation replays newer intent instead of restoring stale UI.
export function createWordSaveQueue({ read, write, display, saved, failed, busy }) {
  const queues = new Map();
  function preview(id, queue) {
    display(id, queue.operations.reduce((record, operation) => operation.apply(record), queue.base));
  }
  function enqueue(id, apply) {
    let queue = queues.get(id);
    if (!queue) { queue = { base: read(id), operations: [], running: false }; queues.set(id, queue); }
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    result.catch(() => {});
    queue.operations.push({ apply, resolve, reject, result });
    preview(id, queue); busy(true);
    if (!queue.running) pump(id, queue);
    return result;
  }
  async function pump(id, queue) {
    queue.running = true;
    while (queue.operations.length) {
      const operation = queue.operations[0], before = queue.base, next = operation.apply(before);
      try { await write(next); queue.base = next; saved(id, before, next); operation.resolve(); }
      catch (error) { failed(error); operation.reject(error); }
      queue.operations.shift();
      preview(id, queue);
    }
    queues.delete(id); busy(queues.size > 0);
  }
  return { enqueue, hasPending: () => queues.size > 0,
    async flush() {
      while (queues.size) await Promise.all([...queues.values()].flatMap((queue) => queue.operations.map((operation) => operation.result)));
    } };
}
