// 精读专属的 region-v2 坐标适配。Shared Ink Runtime 只消费这个可选 adapter，
// 不了解 DOM、storage key 或精读业务。

const LOCAL_REGION_SELECTOR = [
  "[data-sentence-scope]",
  "[data-translation-sentence]",
  "[data-translation-paragraph]",
  "[data-question-key]",
].join(", ");

const STAGE_REGION_SELECTOR = ".deep-paper[id], .deep-translation[id]";

function finite(value) {
  return Number.isFinite(value);
}

// A viewport-sized live band on the committed paper's bitmap grid. Starting the
// band at a whole bitmap row preserves the tile phase without allocating a
// canvas for the entire (potentially very long) document.
export function deepInkPreviewLayout(rect, surface, viewportHeight, ratio) {
  const scale = rect.width / surface.width;
  const startY = Math.min(Math.max(0, surface.height - 1),
    Math.floor(Math.max(0, -rect.top / scale) * ratio) / ratio);
  const top = rect.top + startY * scale;
  return {
    left: rect.left, top, startY, scale, width: surface.width,
    height: Math.max(1, Math.min(surface.height - startY,
      Math.ceil(Math.max(1, viewportHeight - top) / scale * ratio) / ratio)),
  };
}

export function deepInkPreviewPoint(point, active, layout) {
  const scale = active.rect.width / active.surface.width;
  return [
    (active.rect.left - layout.left + point.x * active.surface.width * scale) / layout.scale,
    (active.rect.top - layout.top + point.y * active.surface.height * scale) / layout.scale,
  ];
}

function normalizedRect(rect, contentRect) {
  if (!rect?.width || !rect?.height || !contentRect?.width || !contentRect?.height) return null;
  return {
    left: (rect.left - contentRect.left) / contentRect.width,
    top: (rect.top - contentRect.top) / contentRect.height,
    right: (rect.right - contentRect.left) / contentRect.width,
    bottom: (rect.bottom - contentRect.top) / contentRect.height,
  };
}

function regionIdFor(element) {
  if (element.dataset.sentenceScope) return `sentence:${element.dataset.sentenceScope}`;
  if (element.dataset.translationSentence) return `translation-sentence:${element.dataset.translationSentence}`;
  if (element.dataset.translationParagraph) return `translation-paragraph:${element.dataset.translationParagraph}`;
  if (element.dataset.questionKey) return `question:${element.dataset.questionKey}`;
  return element.id ? `stage:${element.id}` : "";
}

function regionPriority(element) {
  if (element.dataset.sentenceScope || element.dataset.translationSentence || element.dataset.questionKey) return 0;
  if (element.dataset.translationParagraph) return 1;
  return 2;
}

function stageIdForElement(element) {
  const stage = element.matches?.(STAGE_REGION_SELECTOR)
    ? element
    : element.closest?.(STAGE_REGION_SELECTOR);
  return stage?.id || "";
}

export function buildDeepInkRegionSnapshot(contentEl) {
  if (!contentEl) return { contentRect: null, regions: [], byId: new Map() };
  const contentRect = contentEl.getBoundingClientRect();
  const seen = new Set();
  const elements = [
    ...contentEl.querySelectorAll(LOCAL_REGION_SELECTOR),
    ...contentEl.querySelectorAll(STAGE_REGION_SELECTOR),
  ];
  const regions = [];
  for (const element of elements) {
    const id = regionIdFor(element);
    if (!id || seen.has(id)) continue;
    const rect = normalizedRect(element.getBoundingClientRect(), contentRect);
    if (!rect) continue;
    seen.add(id);
    regions.push({ id, stageId: stageIdForElement(element), ...rect, priority: regionPriority(element) });
  }
  const logicalRect = { width: contentEl.offsetWidth || contentRect.width, height: contentEl.offsetHeight || contentRect.height };
  return { contentRect, logicalRect, regions, byId: new Map(regions.map((region) => [region.id, region])) };
}

// Scrolling and uniform paper transforms change screen coordinates, not ink
// coordinates. Keep region identity stable across subpixel rounding noise so
// every pen-down does not reproject all historical points.
export function reuseDeepInkGeometry(previous, next) {
  if (!previous?.logicalRect || !next?.logicalRect
    || previous.logicalRect.width !== next.logicalRect.width
    || previous.logicalRect.height !== next.logicalRect.height
    || previous.regions.length !== next.regions.length) return next;
  const { width, height } = next.logicalRect;
  const unchanged = next.regions.every((region, index) => {
    const old = previous.regions[index];
    return old.id === region.id && old.stageId === region.stageId && old.priority === region.priority
      && Math.abs(old.left - region.left) * width < 0.01
      && Math.abs(old.right - region.right) * width < 0.01
      && Math.abs(old.top - region.top) * height < 0.01
      && Math.abs(old.bottom - region.bottom) * height < 0.01;
  });
  return unchanged ? { ...next, regions: previous.regions, byId: previous.byId } : next;
}

export function strokeBoundsWithWidth(stroke, contentRect) {
  const points = stroke?.points || [];
  if (!points.length || !contentRect?.width || !contentRect?.height) return null;
  const width = Math.max(0, Number(stroke.width) || 0);
  const padX = width / 2 / contentRect.width;
  const padY = width / 2 / contentRect.height;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!finite(point?.x) || !finite(point?.y)) return null;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

function contains(region, bounds) {
  return region.left <= bounds.minX && region.top <= bounds.minY
    && region.right >= bounds.maxX && region.bottom >= bounds.maxY;
}

function area(region) {
  return Math.max(0, region.right - region.left) * Math.max(0, region.bottom - region.top);
}

export function selectDeepInkRegion(stroke, snapshot) {
  const bounds = strokeBoundsWithWidth(stroke, snapshot?.logicalRect || snapshot?.contentRect);
  if (!bounds) return null;
  const candidates = (snapshot?.regions || []).filter((region) => contains(region, bounds));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => a.priority - b.priority || area(a) - area(b))[0];
}

function intersectionArea(region, bounds) {
  const width = Math.max(0, Math.min(region.right, bounds.maxX) - Math.max(region.left, bounds.minX));
  const height = Math.max(0, Math.min(region.bottom, bounds.maxY) - Math.max(region.top, bounds.minY));
  return width * height;
}

function centerDistance(region, bounds) {
  const regionX = (region.left + region.right) / 2;
  const regionY = (region.top + region.bottom) / 2;
  const strokeX = (bounds.minX + bounds.maxX) / 2;
  const strokeY = (bounds.minY + bounds.maxY) / 2;
  return Math.hypot(regionX - strokeX, regionY - strokeY);
}

export function stageIdForDeepInkStroke(stroke, snapshot) {
  const anchorId = String(stroke?.deepAnchor?.regionId || "");
  if (anchorId.startsWith("stage:")) return anchorId.slice("stage:".length);

  const bounds = strokeBoundsWithWidth(stroke, snapshot?.logicalRect || snapshot?.contentRect);
  const stages = (snapshot?.regions || []).filter((region) => region.id.startsWith("stage:") && region.stageId);
  if (bounds && stages.length) {
    const containing = stages.filter((region) => contains(region, bounds));
    if (containing.length) return containing.sort((a, b) => area(a) - area(b))[0].stageId;
    const ranked = stages
      .map((region) => ({ region, overlap: intersectionArea(region, bounds), distance: centerDistance(region, bounds) }))
      .sort((a, b) => b.overlap - a.overlap || a.distance - b.distance);
    if (ranked[0]) return ranked[0].region.stageId;
  }

  return snapshot?.byId?.get(anchorId)?.stageId || "";
}

export function finalizeDeepRegionStroke(stroke, snapshot) {
  if (!stroke?.points?.length || stroke.tool === "lasso") return stroke;
  const region = selectDeepInkRegion(stroke, snapshot);
  const width = region?.right - region?.left;
  const height = region?.bottom - region?.top;
  if (!region || width <= 0 || height <= 0) return stroke;
  return {
    ...stroke,
    coordinateSpace: "deep-region-v2",
    deepAnchor: { version: 2, regionId: region.id },
    points: stroke.points.map((point) => ({
      ...point,
      // x/y 永远保留 v1 content-global fallback；deepLocal 才是 v2 canonical 真值。
      deepLocal: { x: (point.x - region.left) / width, y: (point.y - region.top) / height },
    })),
  };
}

export function projectDeepRegionStroke(stroke, snapshot) {
  if (stroke?.coordinateSpace !== "deep-region-v2" || !stroke?.deepAnchor?.regionId) return stroke;
  const region = snapshot?.byId?.get(stroke.deepAnchor.regionId);
  const width = region?.right - region?.left;
  const height = region?.bottom - region?.top;
  if (!region || width <= 0 || height <= 0) return stroke;
  const points = stroke.points || [];
  if (!points.every((point) => finite(point?.deepLocal?.x) && finite(point?.deepLocal?.y))) return stroke;
  return {
    ...stroke,
    points: points.map((point) => ({
      ...point,
      x: region.left + point.deepLocal.x * width,
      y: region.top + point.deepLocal.y * height,
    })),
  };
}

export function createDeepInkGeometryAdapter(getSnapshot, refreshSnapshot = null) {
  const sources = new WeakMap();
  const sessions = new WeakMap();
  const projections = new WeakMap();
  return {
    beginStroke(active) {
      sessions.set(active, refreshSnapshot?.() || getSnapshot());
    },
    finalizeStroke(stroke, { active } = {}) {
      // 采样与 canonical 转换使用同一份起笔快照；布局中途变化不能重新解释旧坐标。
      const captured = active && sessions.get(active);
      if (active) sessions.delete(active);
      return finalizeDeepRegionStroke(stroke, captured || refreshSnapshot?.() || getSnapshot());
    },
    projectStroke(stroke) {
      const snapshot = getSnapshot();
      const cached = projections.get(stroke);
      const region = snapshot?.byId?.get(stroke.deepAnchor?.regionId);
      // Snapshots are refreshed at pen-down, including when only scrolling.
      // Projection depends on the anchor rectangle, not snapshot object identity.
      const rect = region ? [region.left, region.top, region.right, region.bottom].join(':') : '';
      if (cached && cached.rect === rect && cached.points === stroke.points) return cached.projected;
      const projected = projectDeepRegionStroke(stroke, snapshot);
      projections.set(stroke, { rect, points: stroke.points, projected });
      if (projected !== stroke) sources.set(projected, stroke);
      return projected;
    },
    canonicalFromProjected(stroke) {
      return sources.get(stroke) || stroke;
    },
  };
}

export function deriveReaderPanelOffset({ workspaceRect, contentRect, panelRects = [], gap = 14, minLeftMargin = 8, maxShift = 170 }) {
  if (!workspaceRect || !contentRect || !panelRects.length) return 0;
  const visiblePanels = panelRects.filter((rect) => rect?.width > 0 && rect?.height > 0);
  if (!visiblePanels.length) return 0;
  const nearestPanelLeft = Math.min(...visiblePanels.map((rect) => rect.left));
  const required = Math.max(0, contentRect.right - nearestPanelLeft + gap);
  const capacity = Math.max(0, contentRect.left - workspaceRect.left - minLeftMargin);
  const distance = Math.min(required, capacity, Math.max(0, maxShift));
  return distance === 0 ? 0 : -distance;
}
