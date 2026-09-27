import { drawInkStroke } from "../annotationTools.js";
import { getWritingInkSnapshot } from "../writing/writingInkStorage.js";
import { isVisionRenderableWritingStroke } from "../writing/writingInkGeometry.js";

export function handwritingImageStroke(stroke) {
  if (isVisionRenderableWritingStroke(stroke)) {
    return { ...stroke, points: stroke.points.map(point => ({ ...point, x: point.writingLocal.x, y: point.writingLocal.y })) };
  }
  // Earlier single-row canvases stored normalized x/y directly. In particular,
  // ordinary erasers and strokes crossing the row edge have no page anchor.
  // Render them exactly as the on-screen canvas does, letting the canvas clip
  // outside points. Never reinterpret a damaged canonical stroke as legacy.
  if (!stroke?.coordinateSpace && stroke?.points?.length && stroke.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return stroke;
  throw new Error("笔迹坐标无效，请重新打开该单词");
}

export function renderHandwritingImage(snapshot, size, documentRef = document) {
  const width = Math.max(1, size?.width || 368), height = Math.max(1, size?.height || 64);
  const ratio = Math.max(2, 1000 / width);
  const canvas = documentRef.createElement("canvas");
  canvas.width = Math.ceil(width * ratio); canvas.height = Math.ceil(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法生成笔迹图片");
  ctx.scale(ratio, ratio);
  for (const stroke of snapshot.strokes) {
    drawInkStroke(ctx, handwritingImageStroke(stroke), width, height);
  }
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (pixels[(y * canvas.width + x) * 4 + 3] < 8) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < left) return null;
  const padding = Math.ceil(12 * ratio), output = documentRef.createElement("canvas");
  output.width = right - left + 1 + padding * 2; output.height = bottom - top + 1 + padding * 2;
  const target = output.getContext("2d");
  target.fillStyle = "white"; target.fillRect(0, 0, output.width, output.height);
  target.drawImage(canvas, left, top, right - left + 1, bottom - top + 1, padding, padding, right - left + 1, bottom - top + 1);
  return output.toDataURL("image/png");
}

export async function loadHandwritingImage(context, answer) {
  const { status, snapshot } = await getWritingInkSnapshot({ username: context.username, sessionId: answer.sessionId,
    surfaceId: `vocabulary:${answer.id}`, expectedSourceFingerprint: context.fingerprints[answer.wordId] });
  if (status !== "ok") throw new Error(`笔迹尚未保存或无法读取（${status}），请重试保存`);
  if (snapshot.fingerprint !== answer.inkFingerprint) throw new Error("笔迹已更新，请重新点击识别");
  return renderHandwritingImage(snapshot, answer.inkSize);
}
