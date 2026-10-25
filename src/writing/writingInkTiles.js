import { drawInkStroke, resizeInkCanvas } from "../annotationTools.js";
import { createDeepInkTileIndex } from "../deepInkRenderCache.js";
import { createInkTileBitmapCache, createInkTileRenderer } from "../ink/inkTileRenderer.js";

export const WRITING_INK_TILE_HEIGHT = 512;
const BUFFER = 768;
const OVERLAP = 24;
const BITMAP_BYTES = 32 * 1024 * 1024;

function boundsForStroke(stroke) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const point of stroke.points || []) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return bounds;
}

function drawTileStroke(canvas, stroke, data) {
  const context = canvas.getContext("2d", { alpha: true });
  context.save();
  context.scale(data.ratio, data.ratio);
  context.translate(0, -data.offsetY);
  drawInkStroke(context, stroke, data.width, data.height);
  context.restore();
}

// Use the reader's worker, cancellation, bitmap cache and immutable tile index.
// The fallback builds a replacement in small slices, retaining visible ink
// until the complete, still-current result can replace it atomically.
export function createWritingInkTiles({ getContent, getLayer, getDimensions, getGeometry, projectStroke, createWorker }) {
  let strokes = [];
  let geometryKey = "";
  let frame = null;
  let disposed = false;
  const visible = new Map();
  const stats = { historyPaints: 0, incrementalCommits: 0, restores: 0 };
  const index = createDeepInkTileIndex({ tileHeight: WRITING_INK_TILE_HEIGHT, overlap: OVERLAP, projectStroke, boundsForStroke });
  const renderer = createInkTileRenderer({
    createWorker: createWorker || (() => getDimensions().height > WRITING_INK_TILE_HEIGHT
      && typeof Worker === "function" && typeof OffscreenCanvas === "function"
      ? new Worker(new URL("../ink/inkTileWorker.js", import.meta.url), { type: "module" }) : null),
    drawOverlay: drawTileStroke,
    drawFallback(tile, data, isCurrent) {
      const staging = tile.ownerDocument.createElement("canvas");
      staging.width = tile.width;
      staging.height = tile.height;
      let cursor = 0;
      return new Promise((resolve) => {
        const finish = () => { staging.width = 0; staging.height = 0; resolve(); };
        const step = () => {
          if (!isCurrent()) { finish(); return; }
          const started = performance.now();
          while (cursor < data.strokes.length) {
            drawTileStroke(staging, data.strokes[cursor++], data);
            if (performance.now() - started >= 4) break;
          }
          if (cursor < data.strokes.length) { requestAnimationFrame(step); return; }
          if (isCurrent()) {
            const context = tile.getContext("2d", { alpha: true });
            context.clearRect(0, 0, tile.width, tile.height);
            context.drawImage(staging, 0, 0);
          }
          finish();
        };
        requestAnimationFrame(step);
      });
    },
  });
  const release = (tile) => { renderer.cancel(tile); tile.remove(); tile.width = 0; tile.height = 0; };
  const cache = createInkTileBitmapCache(BITMAP_BYTES, release);

  function info() {
    const content = getContent();
    const { width, height, ratio } = getDimensions();
    if (!content || !getLayer() || !width || !height) return null;
    const rect = content.getBoundingClientRect();
    const scale = rect.width / width;
    if (!scale) return null;
    const scroll = content.closest(".writing-split-scroll");
    const viewport = scroll?.getBoundingClientRect();
    const top = Math.max(0, viewport?.top || 0);
    const bottom = Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight);
    return {
      contentWidth: width, contentHeight: height, ratio,
      start: Math.max(0, Math.floor(((top - rect.top) / scale - BUFFER) / WRITING_INK_TILE_HEIGHT)),
      end: Math.min(Math.ceil(height / WRITING_INK_TILE_HEIGHT) - 1,
        Math.floor(((bottom - rect.top) / scale + BUFFER) / WRITING_INK_TILE_HEIGHT)),
    };
  }

  function paint(tile, tileIndex, view) {
    const candidates = index.forTile(tileIndex);
    stats.historyPaints += 1;
    if (!candidates.length) {
      renderer.cancel(tile);
      tile.getContext("2d", { alpha: true }).clearRect(0, 0, tile.width, tile.height);
      return;
    }
    renderer.paint(tile, {
      strokes: candidates.map((record) => record.stroke),
      width: view.contentWidth, height: view.contentHeight, ratio: view.ratio,
      offsetY: tileIndex * WRITING_INK_TILE_HEIGHT,
      pixelWidth: tile.width, pixelHeight: tile.height,
      priority: Math.abs(tileIndex - (view.start + view.end) / 2),
    });
  }

  function publishStats() {
    const layer = getLayer();
    if (layer) {
      layer.dataset.historyPaints = String(stats.historyPaints);
      layer.dataset.incrementalCommits = String(stats.incrementalCommits);
      layer.dataset.cacheBytes = String(cache.bytes);
    }
  }

  function sync(reset = false) {
    if (disposed) return false;
    const view = info();
    if (!view) return false;
    const key = `${getGeometry()?.signature || ""}:${view.contentWidth}:${view.contentHeight}:${view.ratio}`;
    if (key !== geometryKey) { reset = true; geometryKey = key; }
    if (reset) {
      cache.clear();
      for (const tile of visible.values()) release(tile);
      visible.clear();
    }
    index.sync(strokes, view, geometryKey);
    for (const [tileIndex, tile] of visible) {
      if (tileIndex < view.start || tileIndex > view.end) {
        visible.delete(tileIndex);
        tile.remove();
        cache.put(tileIndex, tile);
      }
    }
    for (let tileIndex = view.start; tileIndex <= view.end; tileIndex += 1) {
      if (visible.has(tileIndex)) continue;
      let tile = cache.take(tileIndex);
      const restored = Boolean(tile);
      if (!tile) {
        tile = getLayer().ownerDocument.createElement("canvas");
        tile.className = "writing-ink-tile";
        tile.style.cssText = `position:absolute;left:0;top:${tileIndex * WRITING_INK_TILE_HEIGHT}px;pointer-events:none`;
        resizeInkCanvas(tile, view.contentWidth, Math.min(WRITING_INK_TILE_HEIGHT, view.contentHeight - tileIndex * WRITING_INK_TILE_HEIGHT), view.ratio);
      }
      tile.style.width = `${view.contentWidth}px`;
      tile.style.height = `${Math.min(WRITING_INK_TILE_HEIGHT, view.contentHeight - tileIndex * WRITING_INK_TILE_HEIGHT)}px`;
      visible.set(tileIndex, tile);
      getLayer().append(tile);
      if (restored) stats.restores += 1;
      else paint(tile, tileIndex, view);
    }
    publishStats();
    return visible.size > 0;
  }

  function affected(changed, view) {
    const result = new Set();
    for (const stroke of changed) {
      const bounds = boundsForStroke(projectStroke(stroke));
      const padding = Math.max(OVERLAP, (stroke.width || 3) * 2.2);
      const first = Math.max(0, Math.floor((bounds.minY * view.contentHeight - padding) / WRITING_INK_TILE_HEIGHT));
      const last = Math.min(Math.ceil(view.contentHeight / WRITING_INK_TILE_HEIGHT) - 1,
        Math.floor((bounds.maxY * view.contentHeight + padding) / WRITING_INK_TILE_HEIGHT));
      for (let i = first; i <= last; i += 1) result.add(i);
    }
    return result;
  }

  function update(next, { reset = false, appendPainted = false } = {}) {
    const previous = strokes;
    if (previous === next && !reset) return sync();
    strokes = next;
    const view = info();
    if (!view || reset) return sync(true);
    const before = new Set(previous);
    const after = new Set(next);
    const added = next.filter((stroke) => !before.has(stroke));
    const removed = previous.filter((stroke) => !after.has(stroke));
    const dirty = affected([...added, ...removed], view);
    cache.invalidate(dirty);
    const appended = !removed.length && next.length === previous.length + added.length
      && index.append(previous, next, added, view, geometryKey);
    if (!appended) index.sync(next, view, geometryKey);
    sync();
    if (!appendPainted || removed.length) {
      for (const i of dirty) if (visible.has(i)) paint(visible.get(i), i, view);
    }
    publishStats();
    return visible.size > 0;
  }

  return {
    sync, update,
    append(stroke) {
      if (!sync()) return false;
      const view = info();
      const projected = projectStroke(stroke);
      let painted = false;
      for (const i of affected([stroke], view)) {
        const tile = visible.get(i);
        if (!tile) continue;
        renderer.append(tile, projected);
        drawTileStroke(tile, projected, { width: view.contentWidth, height: view.contentHeight, ratio: view.ratio, offsetY: i * WRITING_INK_TILE_HEIGHT });
        painted = true;
      }
      if (painted) stats.incrementalCommits += 1;
      publishStats();
      return painted;
    },
    scheduleSync() {
      if (frame !== null || disposed) return;
      frame = requestAnimationFrame(() => { frame = null; sync(); });
    },
    getStats: () => ({ ...stats, cacheBytes: cache.bytes, visibleTiles: visible.size }),
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      cache.clear();
      for (const tile of visible.values()) release(tile);
      visible.clear();
      renderer.dispose();
    },
  };
}
