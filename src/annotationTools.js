import { getStroke } from "perfect-freehand";

const naturalInkOptions = {
  thinning: 0.62,
  smoothing: 0.68,
  streamline: 0.38,
  easing: (pressure) => pressure,
  start: { cap: true, taper: 0 },
  end: { cap: true, taper: 0 },
};

export const PEN_MODE_STORAGE_KEY = "wuliao:pref:pen-mode";
export const PEN_SIZE_STORAGE_KEY = "wuliao:pref:pen-size";

export function normalizePenMode(value) {
  return value === "fountain" ? "fountain" : "ballpoint";
}

export function normalizePenSize(value) {
  if (value === null || value === "") return 2.6;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 2.6;
  return Math.min(10, Math.max(1, Math.round(parsed * 2) / 2));
}

export const INK_PIXEL_RATIO_CAP = 1.5;

export function inkPixelRatio() {
  return Math.min(window.devicePixelRatio || 1, INK_PIXEL_RATIO_CAP);
}

export function resizeInkCanvas(canvas, width, height, ratio = inkPixelRatio()) {
  const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.dataset.ratio = String(ratio);
  return context;
}

export function pointerPointFromSample(sample, rect, isPen) {
  const normalized = {
    x: (sample.clientX - rect.left) / Math.max(1, rect.width),
    y: (sample.clientY - rect.top) / Math.max(1, rect.height),
  };
  if (isPen) {
    if (Number.isFinite(sample.pressure)) normalized.pressure = Math.min(1, Math.max(0, sample.pressure));
    if (Number.isFinite(sample.tiltX)) normalized.tiltX = sample.tiltX;
    if (Number.isFinite(sample.tiltY)) normalized.tiltY = sample.tiltY;
    if (Number.isFinite(sample.twist)) normalized.twist = sample.twist;
  }
  return {
    normalized,
    pixel: { x: sample.clientX - rect.left, y: sample.clientY - rect.top },
    viewport: {
      x: sample.clientX,
      y: sample.clientY,
      pressure: normalized.pressure,
      tiltX: normalized.tiltX,
      tiltY: normalized.tiltY,
      twist: normalized.twist,
    },
  };
}

export function coalescedPointerPoints(event, rect) {
  const coalesced = event.nativeEvent?.getCoalescedEvents?.();
  const samples = coalesced?.length ? coalesced : [event.nativeEvent || event];
  return samples.map((sample) => pointerPointFromSample(sample, rect, event.pointerType === "pen"));
}

export function naturalInkOutline(stroke, surfaceSize) {
  const points = (stroke.points || []).map((point) => [
    point.x * surfaceSize.width,
    point.y * surfaceSize.height,
    Number.isFinite(point.pressure) ? point.pressure : 0.5,
  ]);
  const hasRealPressure = (stroke.points || []).some((point) => Number.isFinite(point.pressure));
  return getStroke(points, {
    ...naturalInkOptions,
    size: Math.max(1, stroke.width || 1),
    simulatePressure: !hasRealPressure,
  });
}

export function svgPathFromOutline(points) {
  if (points.length < 4) return "";
  const average = (a, b) => (a + b) / 2;
  let current = points[0];
  let next = points[1];
  const third = points[2];
  let path = `M${current[0].toFixed(2)},${current[1].toFixed(2)} Q${next[0].toFixed(2)},${next[1].toFixed(2)} ${average(next[0], third[0]).toFixed(2)},${average(next[1], third[1]).toFixed(2)} T`;

  for (let index = 2; index < points.length - 1; index += 1) {
    current = points[index];
    next = points[index + 1];
    path += `${average(current[0], next[0]).toFixed(2)},${average(current[1], next[1]).toFixed(2)} `;
  }
  return `${path}Z`;
}

export function fillInkOutline(context, points) {
  if (points.length < 3) return;
  context.beginPath();
  context.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    context.quadraticCurveTo(
      current[0],
      current[1],
      (current[0] + next[0]) / 2,
      (current[1] + next[1]) / 2,
    );
  }
  context.closePath();
  context.fill();
}

export function drawInkStroke(context, stroke, width, height) {
  if (stroke.type === "text") {
    context.save();
    context.globalCompositeOperation = "source-over";
    context.fillStyle = stroke.color || "#173a62";
    context.font = `${stroke.fontSize || 18}px Georgia, "Times New Roman", serif`;
    context.textBaseline = "alphabetic";
    context.fillText(stroke.text || "", stroke.x * width, stroke.y * height);
    context.restore();
    return;
  }
  if (!stroke.points?.length) return;
  const tool = stroke.tool || (stroke.mode === "normal-eraser" ? "eraser" : stroke.mode);
  context.save();
  context.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = tool === "eraser" && stroke.version !== 2 ? stroke.width * 2.2 : stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    const pointWidth = stroke.engine === "direct-ink" && stroke.penMode === "ballpoint"
      ? stroke.width
      : strokeWidthAtPoint(stroke, point);
    const radius = Math.max(1.3, pointWidth / 2);
    context.beginPath();
    context.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
    context.fill();
  } else if (tool === "pen" && stroke.engine === "perfect-freehand") {
    fillInkOutline(context, naturalInkOutline(stroke, { width, height }));
  } else if (tool === "pen" && stroke.engine === "direct-ink" && stroke.penMode === "ballpoint") {
    context.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * width;
      const y = point.y * height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  } else if (tool === "pen" && stroke.engine === "direct-ink") {
    stroke.points.slice(1).forEach((point, index) => {
      const previous = stroke.points[index];
      context.lineWidth = (strokeWidthAtPoint(stroke, previous) + strokeWidthAtPoint(stroke, point)) / 2;
      context.beginPath();
      context.moveTo(previous.x * width, previous.y * height);
      context.lineTo(point.x * width, point.y * height);
      context.stroke();
    });
  } else if (tool === "pen" && stroke.points.some((point) => Number.isFinite(point.pressure))) {
    stroke.points.slice(1).forEach((point, index) => {
      const previous = stroke.points[index];
      context.lineWidth = (strokeWidthAtPoint(stroke, previous) + strokeWidthAtPoint(stroke, point)) / 2;
      context.beginPath();
      context.moveTo(previous.x * width, previous.y * height);
      context.lineTo(point.x * width, point.y * height);
      context.stroke();
    });
  } else {
    context.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * width;
      const y = point.y * height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    if (tool === "lasso") context.setLineDash([7, 5]);
    context.stroke();
  }
  context.restore();
}

export function renderInkLayer(canvas, strokes, width, height, ratio = Number(canvas?.dataset.ratio) || 1) {
  if (!canvas) return;
  const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(ratio, ratio);
  for (const stroke of strokes) drawInkStroke(context, stroke, width, height);
  context.restore();
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y))
        / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

// Old annotations do not contain a pressure value. Keeping their configured width
// unchanged makes the new pen data backward compatible with existing notes.
export function strokeWidthAtPoint(stroke, point) {
  if ((stroke.tool !== "pen" && stroke.mode !== "pen") || !Number.isFinite(point?.pressure)) return stroke.width;
  const pressure = Math.min(1, Math.max(0, point.pressure));
  return Math.max(0.8, stroke.width * (0.5 + pressure));
}

function pointNearPath(point, path, radiusX, radiusY) {
  return path.some((eraserPoint) => {
    const dx = (point.x - eraserPoint.x) / Math.max(radiusX, 0.0001);
    const dy = (point.y - eraserPoint.y) / Math.max(radiusY, 0.0001);
    return dx * dx + dy * dy <= 1;
  });
}

export function eraseAnnotationsAlongPath(annotations, path, eraserSize, surfaceSize) {
  const radiusX = (eraserSize / 2) / Math.max(1, surfaceSize.width);
  const radiusY = (eraserSize / 2) / Math.max(1, surfaceSize.height);
  const next = [];

  annotations.forEach((annotation) => {
    if (annotation.type === "text") {
      const fontSize = annotation.fontSize || 18;
      const boxWidth = Math.max(fontSize, (annotation.text?.length || 1) * fontSize * 0.58) / Math.max(1, surfaceSize.width);
      const boxHeight = fontSize * 1.25 / Math.max(1, surfaceSize.height);
      const touched = path.some((point) => point.x >= annotation.x - radiusX
        && point.x <= annotation.x + boxWidth + radiusX
        && point.y >= annotation.y - boxHeight - radiusY
        && point.y <= annotation.y + radiusY);
      if (!touched) next.push(annotation);
      return;
    }

    const points = annotation.points || [];
    let chunk = [];
    points.forEach((point) => {
      if (pointNearPath(point, path, radiusX, radiusY)) {
        if (chunk.length) next.push({ ...annotation, points: chunk });
        chunk = [];
      } else {
        chunk.push(point);
      }
    });
    if (chunk.length) next.push({ ...annotation, points: chunk });
  });

  return next;
}

export function eraseAnnotationsInPolygon(annotations, polygon) {
  return annotations.filter((annotation) => {
    if (annotation.type === "text") {
      return !pointInPolygon({ x: annotation.x, y: annotation.y }, polygon);
    }
    return !(annotation.points || []).some((point) => pointInPolygon(point, polygon));
  });
}
