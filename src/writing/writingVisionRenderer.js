import { WRITING_INK_COORDINATE_SPACE, WRITING_PAGE_CANONICAL_SIZE, isVisionRenderableWritingStroke } from "./writingInkGeometry.js";
import { WRITING_AI_PROMPT_VERSIONS } from "./writingAiTasks.js";

export const WRITING_VISION_RENDER_WIDTH = 1600;
export const WRITING_VISION_RENDER_HEIGHT = Math.round(WRITING_VISION_RENDER_WIDTH * WRITING_PAGE_CANONICAL_SIZE.height);

function pageIdOf(stroke) { return String(stroke?.writingAnchor?.pageId || "").trim(); }

export class WritingVisionRenderError extends Error {
  constructor(message) { super(message); this.name = "WritingVisionRenderError"; this.code = "VISION_RENDER_ERROR"; }
}

function assertCanonicalStrokes(snapshot) {
  const strokes = Array.isArray(snapshot?.strokes) ? snapshot.strokes : [];
  if (strokes.some((stroke) => !isVisionRenderableWritingStroke(stroke))) {
    throw new WritingVisionRenderError("Vision rendering refuses non-canonical Writing stroke data");
  }
  return strokes;
}

function comparePageIds(left, right) {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

export function stableWritingInkPageOrder(snapshot) {
  const strokes = assertCanonicalStrokes(snapshot);
  const declared = Array.isArray(snapshot?.pageOrder) ? snapshot.pageOrder.map((id) => String(id).trim()).filter(Boolean) : [];
  if (new Set(declared).size !== declared.length) throw new WritingVisionRenderError("Writing pageOrder contains duplicate page ids");
  const discovered = [...new Set(strokes.map(pageIdOf))].filter((id) => !declared.includes(id)).sort(comparePageIds);
  return [...declared, ...discovered];
}

export function buildWritingVisionRenderPlan(snapshot, pageId) {
  if (!snapshot || snapshot.coordinateSpace && snapshot.coordinateSpace !== WRITING_INK_COORDINATE_SPACE) throw new WritingVisionRenderError("WritingInkSnapshot must use writing-page-v1 geometry");
  const id = String(pageId || "").trim(); if (!id) throw new WritingVisionRenderError("pageId is required");
  const strokes = assertCanonicalStrokes(snapshot).filter((stroke) => pageIdOf(stroke) === id);
  return {
    renderVersion: WRITING_AI_PROMPT_VERSIONS.visionRender,
    pageId: id,
    width: WRITING_VISION_RENDER_WIDTH,
    height: WRITING_VISION_RENDER_HEIGHT,
    background: "white",
    strokes: strokes.map((stroke) => ({
      tool: stroke.tool || "pen",
      color: stroke.color || "#111111",
      size: Number.isFinite(stroke.size) ? stroke.size : 4,
      points: stroke.points.map((point) => ({ x: point.writingLocal.x * WRITING_VISION_RENDER_WIDTH, y: point.writingLocal.y * WRITING_VISION_RENDER_HEIGHT })),
    })),
  };
}

export function createBrowserWritingVisionEncoder({ documentRef = globalThis.document } = {}) {
  return async function encode(plan) {
    if (!documentRef?.createElement) throw new Error("Canvas encoder is unavailable");
    const canvas = documentRef.createElement("canvas"); canvas.width = plan.width; canvas.height = plan.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas context is unavailable");
    context.fillStyle = plan.background; context.fillRect(0, 0, plan.width, plan.height); context.lineCap = "round"; context.lineJoin = "round";
    for (const stroke of plan.strokes) {
      if (!stroke.points.length) continue; context.strokeStyle = stroke.color; context.lineWidth = Math.max(1, stroke.size);
      context.beginPath(); context.moveTo(stroke.points[0].x, stroke.points[0].y); for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y); context.stroke();
    }
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Writing page PNG encoding failed")), "image/png"));
  };
}

export async function renderWritingInkPage(snapshot, pageId, { encode = createBrowserWritingVisionEncoder() } = {}) {
  const plan = buildWritingVisionRenderPlan(snapshot, pageId); const imageBlob = await encode(plan);
  if (!imageBlob || typeof imageBlob.arrayBuffer !== "function") throw new Error("Vision encoder did not return an image Blob");
  return { pageId: plan.pageId, imageBlob, plan };
}
