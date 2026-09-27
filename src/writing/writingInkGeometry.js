export const WRITING_INK_COORDINATE_SPACE = "writing-page-v1";
export const WRITING_PAGE_ASPECT_RATIO = 1 / Math.sqrt(2);
export const WRITING_PAGE_CANONICAL_SIZE = Object.freeze({
  width: 1,
  height: Math.sqrt(2),
});

const WRITING_ANCHOR_VERSION = 1;
const GEOMETRY_EPSILON = 1e-7;

function positive(value, fallback = 1) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function boundedUnit(value) {
  return finite(value) && Number(value) >= 0 && Number(value) <= 1;
}

function stablePageId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rectFrom(source) {
  const value = source?.getBoundingClientRect?.() || source;
  const left = Number(value?.left);
  const top = Number(value?.top);
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function canonicalGeometryError(code, message, details = {}) {
  return new WritingInkGeometryError(code, message, details);
}

export class WritingInkGeometryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WritingInkGeometryError";
    this.code = code;
    this.details = details;
  }
}

export function measureWritingInkContainer(container, ratio = 1) {
  const rect = container?.getBoundingClientRect?.();
  return {
    width: positive(rect?.width, positive(container?.clientWidth)),
    height: positive(rect?.height, positive(container?.scrollHeight, positive(container?.clientHeight))),
    ratio: positive(ratio),
  };
}

export function writingInkPointToPixel(point, dimensions) {
  return [
    (Number(point?.x) || 0) * positive(dimensions?.width),
    (Number(point?.y) || 0) * positive(dimensions?.height),
  ];
}

export function writingPageRegionElement(region) {
  return region?.element || region?.ref?.current || null;
}

function pageRegionRect(region) {
  return rectFrom(writingPageRegionElement(region) || region?.rect);
}

export function createWritingPageGeometrySnapshot(surface, pageRegions = []) {
  const surfaceRect = rectFrom(surface);
  if (!surfaceRect) {
    throw canonicalGeometryError(
      "writing-geometry-missing-surface",
      "Writing surface geometry is unavailable",
    );
  }
  if (!Array.isArray(pageRegions)) {
    throw canonicalGeometryError(
      "writing-geometry-invalid-pages",
      "Writing pageRegions must be an array",
    );
  }

  const seenPageIds = new Set();
  const pages = pageRegions.map((region) => {
    const pageId = stablePageId(region?.pageId);
    if (!pageId) {
      throw canonicalGeometryError(
        "writing-geometry-invalid-page-id",
        "Every Writing page region requires a stable pageId",
      );
    }
    if (seenPageIds.has(pageId)) {
      throw canonicalGeometryError(
        "writing-geometry-duplicate-page-id",
        `Writing pageId must be unique: ${pageId}`,
        { pageId },
      );
    }
    seenPageIds.add(pageId);
    const viewportRect = pageRegionRect(region);
    if (!viewportRect) {
      throw canonicalGeometryError(
        "writing-geometry-invalid-page-rect",
        `Writing page geometry is unavailable: ${pageId}`,
        { pageId },
      );
    }
    const left = (viewportRect.left - surfaceRect.left) / surfaceRect.width;
    const top = (viewportRect.top - surfaceRect.top) / surfaceRect.height;
    const width = viewportRect.width / surfaceRect.width;
    const height = viewportRect.height / surfaceRect.height;
    return Object.freeze({
      pageId,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      canonicalSize: WRITING_PAGE_CANONICAL_SIZE,
    });
  });

  const signature = pages
    .map(({ pageId, left, top, width, height }) => `${pageId}:${left}:${top}:${width}:${height}`)
    .join("|");
  return Object.freeze({
    surfaceRect: Object.freeze(surfaceRect),
    pages: Object.freeze(pages),
    signature,
  });
}

function strokePoints(strokeOrPoints) {
  return Array.isArray(strokeOrPoints) ? strokeOrPoints : strokeOrPoints?.points;
}

function pageContainsPoint(page, point) {
  const x = point?.x;
  const y = point?.y;
  return finite(x)
    && finite(y)
    && x >= page.left - GEOMETRY_EPSILON
    && x <= page.right + GEOMETRY_EPSILON
    && y >= page.top - GEOMETRY_EPSILON
    && y <= page.bottom + GEOMETRY_EPSILON;
}

export function resolveWritingPage(strokeOrPoints, snapshot) {
  const points = strokePoints(strokeOrPoints);
  if (!Array.isArray(points) || points.length === 0) {
    throw canonicalGeometryError(
      "writing-geometry-no-page",
      "A committed Writing stroke must contain points before page resolution",
    );
  }
  const candidates = (snapshot?.pages || []).filter((page) => (
    points.every((point) => pageContainsPoint(page, point))
  ));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw canonicalGeometryError(
      "writing-geometry-ambiguous-page",
      "Writing stroke overlaps multiple logical page regions",
      { pageIds: candidates.map((page) => page.pageId) },
    );
  }
  throw canonicalGeometryError(
    "writing-geometry-no-page",
    "Writing stroke is not fully contained by one logical page",
  );
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

export function toWritingLocalPoint(point, page) {
  if (!page || !positive(page.width, 0) || !positive(page.height, 0) || !pageContainsPoint(page, point)) {
    throw canonicalGeometryError(
      "writing-geometry-point-outside-page",
      "Writing point is outside its resolved logical page",
      { pageId: page?.pageId || null },
    );
  }
  return {
    x: clampUnit((Number(point.x) - page.left) / page.width),
    y: clampUnit((Number(point.y) - page.top) / page.height),
  };
}

export function isVisionRenderableWritingStroke(stroke) {
  const pageId = stablePageId(stroke?.writingAnchor?.pageId);
  return stroke?.coordinateSpace === WRITING_INK_COORDINATE_SPACE
    && stroke?.writingAnchor?.version === WRITING_ANCHOR_VERSION
    && Boolean(pageId)
    && Array.isArray(stroke?.points)
    && stroke.points.length > 0
    && stroke.points.every((point) => (
      boundedUnit(point?.writingLocal?.x) && boundedUnit(point?.writingLocal?.y)
    ));
}

export function finalizeWritingStrokeGeometry(stroke, snapshot) {
  if (isVisionRenderableWritingStroke(stroke)) return stroke;
  if (stroke?.coordinateSpace === WRITING_INK_COORDINATE_SPACE) {
    throw canonicalGeometryError(
      "writing-geometry-invalid-canonical-stroke",
      "Writing stroke declares page-local geometry but is not Vision-renderable",
      { pageId: stroke?.writingAnchor?.pageId || null },
    );
  }
  const page = resolveWritingPage(stroke, snapshot);
  return {
    ...stroke,
    coordinateSpace: WRITING_INK_COORDINATE_SPACE,
    writingAnchor: {
      version: WRITING_ANCHOR_VERSION,
      pageId: page.pageId,
    },
    points: stroke.points.map((point) => ({
      ...point,
      writingLocal: toWritingLocalPoint(point, page),
    })),
  };
}

export function projectWritingLocalPoint(point, page) {
  if (!boundedUnit(point?.writingLocal?.x) || !boundedUnit(point?.writingLocal?.y)) {
    throw canonicalGeometryError(
      "writing-geometry-invalid-local-point",
      "Writing page-local coordinates must be finite values within 0..1",
      { pageId: page?.pageId || null },
    );
  }
  return {
    ...point,
    x: page.left + Number(point.writingLocal.x) * page.width,
    y: page.top + Number(point.writingLocal.y) * page.height,
  };
}

export function projectWritingStroke(stroke, snapshot) {
  if (stroke?.coordinateSpace !== WRITING_INK_COORDINATE_SPACE) return stroke;
  if (!isVisionRenderableWritingStroke(stroke)) {
    throw canonicalGeometryError(
      "writing-geometry-invalid-canonical-stroke",
      "Writing stroke declares page-local geometry but is not Vision-renderable",
      { pageId: stroke?.writingAnchor?.pageId || null },
    );
  }
  const pageId = stablePageId(stroke.writingAnchor.pageId);
  const matches = (snapshot?.pages || []).filter((page) => page.pageId === pageId);
  if (matches.length !== 1) {
    throw canonicalGeometryError(
      matches.length ? "writing-geometry-ambiguous-page" : "writing-geometry-missing-page",
      matches.length
        ? `Current Writing geometry contains duplicate pageId: ${pageId}`
        : `Current Writing geometry does not contain pageId: ${pageId}`,
      { pageId },
    );
  }
  return {
    ...stroke,
    points: stroke.points.map((point) => projectWritingLocalPoint(point, matches[0])),
  };
}

export function createWritingInkGeometryAdapter({ getSnapshot, onError = () => {} } = {}) {
  const canonicalByProjection = new WeakMap();
  const reportedByStroke = new WeakMap();

  function reportOnce(error, stroke, operation) {
    if (stroke && typeof stroke === "object") {
      const prior = reportedByStroke.get(stroke) || new Set();
      const key = `${operation}:${error.code}`;
      if (prior.has(key)) return;
      prior.add(key);
      reportedByStroke.set(stroke, prior);
    }
    onError(error, { operation, stroke });
  }

  function snapshot() {
    return typeof getSnapshot === "function" ? getSnapshot() : null;
  }

  return Object.freeze({
    finalizeStroke(stroke) {
      try {
        return finalizeWritingStrokeGeometry(stroke, snapshot());
      } catch (error) {
        const geometryError = error instanceof WritingInkGeometryError
          ? error
          : canonicalGeometryError("writing-geometry-finalize-failed", "Writing geometry finalization failed", { cause: error });
        reportOnce(geometryError, stroke, "finalize");
        return stroke;
      }
    },
    projectStroke(stroke) {
      try {
        const projected = projectWritingStroke(stroke, snapshot());
        if (projected !== stroke && projected && typeof projected === "object") {
          canonicalByProjection.set(projected, stroke);
        }
        return projected;
      } catch (error) {
        const geometryError = error instanceof WritingInkGeometryError
          ? error
          : canonicalGeometryError("writing-geometry-project-failed", "Writing geometry projection failed", { cause: error });
        reportOnce(geometryError, stroke, "project");
        return stroke;
      }
    },
    canonicalFromProjected(stroke) {
      return canonicalByProjection.get(stroke) || stroke;
    },
  });
}
