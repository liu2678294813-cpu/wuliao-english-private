import { packInkTileStrokes } from "./inkTileTransfer.js";

// One worker job at a time, coalesced per tile. Appended live strokes are painted
// immediately by the caller and replayed over the completed history bitmap.
// Deletion/layout replaces the job; a late result can never resurrect old ink.
export function createInkTileRenderer({ createWorker, drawFallback, drawOverlay }) {
  let worker;
  let disabled = false;
  let disposed = false;
  let active = null;
  let sequence = 0;
  const pending = new Map();
  const queued = new Map();

  function fallback() {
    disabled = true;
    worker?.terminate();
    worker = null;
    active = null;
    const jobs = [...pending.values()];
    pending.clear();
    queued.clear();
    for (const job of jobs) drawFallback(job.tile, { ...job.data, strokes: [...job.data.strokes, ...job.appended] });
  }

  function pump() {
    if (active || disposed || !queued.size) return;
    const job = queued.values().next().value;
    queued.delete(job.tile);
    active = job;
    try {
      const packed = packInkTileStrokes(job.data.strokes);
      worker.postMessage({ ...job.data, ...packed, id: job.id }, [packed.pointData.buffer]);
    }
    catch { fallback(); }
  }

  function receive({ data }) {
    const job = active;
    if (!job || job.id !== data.id) { data.bitmap?.close(); return; }
    if (data.failed) { fallback(); return; }
    try {
      if (!disposed && pending.get(job.tile) === job) {
        const context = job.tile.getContext("2d", { alpha: true });
        context.save();
        try {
          context.setTransform(1, 0, 0, 1, 0, 0);
          context.clearRect(0, 0, job.tile.width, job.tile.height);
          context.drawImage(data.bitmap, 0, 0);
        } finally { context.restore(); }
        for (const stroke of job.appended) drawOverlay(job.tile, stroke, job.data);
        pending.delete(job.tile);
      }
    } catch {
      fallback();
    } finally { data.bitmap?.close(); }
    active = null;
    pump();
  }

  return {
    paint(tile, data) {
      if (disposed) return;
      if (!worker && !disabled) {
        try {
          worker = createWorker();
          if (worker) { worker.onmessage = receive; worker.onerror = fallback; }
          else disabled = true;
        } catch { disabled = true; }
      }
      if (disabled) { drawFallback(tile, data); return; }
      const job = { id: ++sequence, tile, data, appended: [] };
      pending.set(tile, job);
      queued.set(tile, job);
      pump();
    },
    append(tile, stroke) { pending.get(tile)?.appended.push(stroke); },
    hasPending(tile) { return pending.has(tile); },
    cancel(tile) { pending.delete(tile); queued.delete(tile); },
    dispose() {
      disposed = true;
      pending.clear(); queued.clear(); active = null;
      worker?.terminate();
    },
  };
}

export function createInkTileBitmapCache(maxBytes, release) {
  const entries = new Map();
  let bytes = 0;
  const take = (index) => {
    const entry = entries.get(index);
    if (!entry) return null;
    entries.delete(index);
    bytes -= entry.bytes;
    return entry.tile;
  };
  const clear = () => {
    for (const entry of entries.values()) release(entry.tile);
    entries.clear(); bytes = 0;
  };
  return {
    take, clear,
    put(index, tile) {
      const old = take(index);
      if (old && old !== tile) release(old);
      const size = tile.width * tile.height * 4;
      entries.set(index, { tile, bytes: size }); bytes += size;
      while (bytes > maxBytes) release(take(entries.keys().next().value));
    },
    get bytes() { return bytes; },
  };
}
