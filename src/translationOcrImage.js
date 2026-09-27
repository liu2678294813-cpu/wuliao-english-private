import { drawInkStroke } from "./annotationTools.js";
import { buildDeepInkRegionSnapshot, projectDeepRegionStroke, strokeBoundsWithWidth } from "./deepInkGeometry.js";
import { deepInkDigest } from "./deepStageInk.js";

// Read-only export. Neither the live canvas nor canonical strokes are changed.
export function captureTranslationInk({ strokes, contentElement, writingElement, activeStroke = null }) {
  if (activeStroke) throw new Error("请先抬笔，再识别当前句");
  if (!contentElement?.contains(writingElement)) throw new Error("当前笔译区域已关闭，请重新打开");
  const geometry = buildDeepInkRegionSnapshot(contentElement);
  const content = geometry.contentRect;
  const rect = writingElement.getBoundingClientRect();
  const size = geometry.logicalRect;
  if (!content?.width || !content?.height || !rect.width || !rect.height || !size?.width || !size?.height) throw new Error("当前笔译区域不可见");
  const crop = {
    left: (rect.left - content.left) / content.width * size.width,
    top: (rect.top - content.top) / content.height * size.height,
    width: rect.width / content.width * size.width,
    height: rect.height / content.height * size.height,
  };
  const selected = [], projected = [];
  for (const original of strokes || []) {
    if (!original?.points?.length || original.type === "text" || (original.tool || original.mode) === "lasso") continue;
    const stroke = projectDeepRegionStroke(original, geometry);
    const eraser = (stroke.tool || stroke.mode) === "eraser" || stroke.mode === "normal-eraser";
    const bounds = strokeBoundsWithWidth(eraser && stroke.version !== 2 ? { ...stroke, width: stroke.width * 2.2 } : stroke, size);
    if (!bounds) throw new Error("笔迹坐标无效，请重新打开该文章");
    if (bounds.maxX * size.width < crop.left || bounds.minX * size.width > crop.left + crop.width
      || bounds.maxY * size.height < crop.top || bounds.minY * size.height > crop.top + crop.height) continue;
    selected.push(original);
    projected.push(stroke);
  }
  // Detach the export from all subsequent edits, undo operations and layout.
  return { crop, size, strokes: structuredClone(projected), fingerprint: deepInkDigest(selected) };
}

export function renderTranslationInk(snapshot, documentRef = globalThis.document) {
  const { crop, size, strokes } = snapshot;
  const ratio = Math.min(3, Math.max(2, 1000 / crop.width), 2048 / Math.max(crop.width, crop.height));
  const canvas = documentRef.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(crop.width * ratio));
  canvas.height = Math.max(1, Math.ceil(crop.height * ratio));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法生成笔迹图片");
  context.scale(ratio, ratio);
  context.translate(-crop.left, -crop.top);
  for (const stroke of strokes) drawInkStroke(context, stroke, size.width, size.height);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (data[(y * canvas.width + x) * 4 + 3] < 8) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < left) return null;
  const padding = Math.ceil(12 * ratio), output = documentRef.createElement("canvas");
  output.width = right - left + 1 + padding * 2;
  output.height = bottom - top + 1 + padding * 2;
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("无法生成笔迹图片");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, output.width, output.height);
  ctx.drawImage(canvas, left, top, right - left + 1, bottom - top + 1, padding, padding, right - left + 1, bottom - top + 1);
  return output.toDataURL("image/png");
}
