// Per-reader caches. Storage strings and completed strokes remain immutable;
// a changed value/layout invalidates only the derived data, never the saved ink.
export function createDeepInkChangeSource() {
  let snapshot = { strokes: [], reset: true, added: [], removed: [] };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    publish(strokes, { reset = false, added = [], removed = [] } = {}) {
      snapshot = { strokes, reset, added, removed };
      for (const listener of listeners) listener(snapshot);
    },
  };
}

export function createDeepInkStageCache(read, parse = JSON.parse) {
  const entries = new Map();
  return {
    read(key) {
      const raw = read(key);
      const cached = entries.get(key);
      if (cached && cached.raw === raw) return cached.strokes;
      const strokes = raw == null ? [] : parse(raw);
      if (!Array.isArray(strokes)) throw new TypeError("Invalid stage ink snapshot");
      entries.set(key, { raw, strokes });
      return strokes;
    },
    remember(key, raw, strokes) {
      entries.set(key, { raw, strokes });
    },
  };
}

// Build the tile membership once per ink/layout revision. Scrolling then visits
// only the strokes in newly visible tiles, in the original compositing order.
export function createDeepInkTileIndex({ tileHeight, overlap, projectStroke, boundsForStroke }) {
  let previous = null;
  let buckets = new Map();
  const records = new WeakMap();
  const empty = [];
  return {
    sync(strokes, info, geometry) {
      const { contentWidth, contentHeight } = info;
      if (previous?.strokes === strokes && previous.geometry === geometry
        && previous.width === contentWidth && previous.height === contentHeight) return;
      const nextBuckets = new Map();
      const last = Math.max(0, Math.ceil(contentHeight / tileHeight) - 1);
      for (const source of strokes) {
        let record = records.get(source);
        if (!record || record.geometry !== geometry || record.points !== source.points) {
          const stroke = projectStroke(source);
          record = { geometry, points: source.points, stroke, bounds: boundsForStroke(stroke) };
          records.set(source, record);
        }
        // Include wide legacy erasers at seams as well as ordinary pen strokes.
        const padding = Math.max(overlap, (Number(source.width) || 3) * 2.2);
        const first = Math.max(0, Math.floor((record.bounds.minY * contentHeight - padding) / tileHeight));
        const end = Math.min(last, Math.floor((record.bounds.maxY * contentHeight + padding) / tileHeight));
        for (let index = first; index <= end; index += 1) {
          if (!nextBuckets.has(index)) nextBuckets.set(index, []);
          nextBuckets.get(index).push(record);
        }
      }
      buckets = nextBuckets;
      previous = { strokes, geometry, width: contentWidth, height: contentHeight };
    },
    forTile(index) { return buckets.get(index) || empty; },
  };
}
