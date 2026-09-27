// 统一低延迟 Ink Engine：输入采样、stroke session、坐标换算、曲线构造、
// 增量绘制、pointerup 收尾、长按临时橡皮与 stylus 防滚动守卫的共享核心。
// 本模块刻意保持“纯逻辑 + 注入式 DOM 回调”，便于在 Node 中完整测试。

import {
  clearInkTimer,
  isCurrentInkSession,
  shouldAppendPointerUpPoint,
  startInkLongPress,
  temporaryInkMode,
} from "./inkStability.js";

export const TAP_MOVE_THRESHOLD_CSS_PX = 1;
export const TAP_PATH_THRESHOLD_CSS_PX = 2;
export const LONG_PRESS_MS = 465;
export const LONG_PRESS_MAX_DISPLACEMENT_CSS_PX = TAP_MOVE_THRESHOLD_CSS_PX;
export const LONG_PRESS_MAX_PATH_CSS_PX = TAP_PATH_THRESHOLD_CSS_PX;
export const MIN_SAMPLE_DISTANCE_CSS_PX = 0.25;
export const LASSO_MOVE_DISTANCE_CSS_PX = 3;
export const SHARP_TURN_DOT = -0.17;

export function smoothInkFeedbackPressure(previous, pressure) {
  const value = Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 0.5;
  return Number.isFinite(previous) ? 0.7 * previous + 0.3 * value : value;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// ---------------- 长按临时橡皮 ----------------

export function createLongPressCandidate(x, y, now = Date.now()) {
  return {
    active: true,
    startTime: now,
    startX: x,
    startY: y,
    lastX: x,
    lastY: y,
    maxDisplacement: 0,
    pathLength: 0,
  };
}

export function updateLongPressCandidate(candidate, x, y) {
  if (!candidate?.active) return candidate;
  const step = Math.hypot(x - candidate.lastX, y - candidate.lastY);
  const displacement = Math.hypot(x - candidate.startX, y - candidate.startY);
  const next = {
    ...candidate,
    lastX: x,
    lastY: y,
    maxDisplacement: Math.max(candidate.maxDisplacement, displacement),
    pathLength: candidate.pathLength + step,
  };
  if (
    next.maxDisplacement > LONG_PRESS_MAX_DISPLACEMENT_CSS_PX
    || next.pathLength > LONG_PRESS_MAX_PATH_CSS_PX
  ) {
    next.active = false;
  }
  return next;
}

export function shouldActivateTemporaryEraser(candidate, now = Date.now()) {
  return Boolean(candidate?.active) && now - candidate.startTime >= LONG_PRESS_MS;
}

// 把当前 pen session 切换为“仅本次会话”的临时橡皮/套索，不修改全局工具状态。
export function activateTemporaryEraser(active, activeRef, eraserModeRef, options = {}) {
  if (!isCurrentInkSession(activeRef, active)) return false;
  if (!active.longPress?.active || !shouldActivateTemporaryEraser(active.longPress)) return false;
  const temporaryMode = temporaryInkMode(eraserModeRef);
  const point = active.stroke.points[active.stroke.points.length - 1];
  active.sessionTool = "temporary-eraser";
  active.longPress = null;
  active.stroke = {
    tool: temporaryMode === "lasso" ? "lasso" : "eraser",
    color: temporaryMode === "lasso" ? "#e26f51" : options.colorRef.current,
    width: temporaryMode === "lasso" ? 2 : options.eraserSizeRef.current,
    version: temporaryMode === "normal" ? 2 : undefined,
    points: [point],
  };
  active.previewRenderedUntil = 0;
  options.onTemporaryEraser?.(active, temporaryMode);
  return true;
}

// 仅对“pen + 画笔”启动 465ms 长按 timer；回调先过 stale-session 与 candidate 双守卫。
export function startInkLongPressTimer(active, activeRef, options) {
  if (!active || active.pointerType !== "pen" || active.stroke.tool !== "pen") return null;
  startInkLongPress(active, activeRef, LONG_PRESS_MS, () => {
    active.timer = null;
    activateTemporaryEraser(active, activeRef, options.eraserModeRef, options);
  });
  return active.timer;
}

// ---------------- stroke session ----------------

export function createInkSession({
  pointerId,
  pointerType,
  point,
  strokeMeta,
  rect = null,
  surface = null,
  scrollY = 0,
}) {
  const width = Math.max(1, surface?.width ?? rect?.width ?? 1);
  const height = Math.max(1, surface?.height ?? rect?.height ?? 1);
  return {
    id: pointerId,
    pointerType,
    rect,
    surface: { width, height },
    scrollY,
    startPixel: point.pixel,
    lastPixel: point.pixel,
    feedbackPressure: smoothInkFeedbackPressure(null, point.normalized.pressure),
    movement: { lastPixel: point.pixel, maxDisplacement: 0, pathLength: 0 },
    moved: false,
    sessionTool: strokeMeta.tool,
    stroke: {
      ...strokeMeta,
      points: [point.normalized],
    },
    previewRenderedUntil: 0,
    timer: null,
    longPress: pointerType === "pen"
      ? createLongPressCandidate(point.pixel.x, point.pixel.y)
      : null,
  };
}

// 按序追加 coalesced 采样：去除与上一保留点距离极小的重复点，
// 但每批次最后一个采样总是保留，保证笔尖最新位置始终被记录。
export function appendInkSamples(active, samples) {
  if (!active || !samples?.length) return 0;
  let count = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    active.feedbackPressure = smoothInkFeedbackPressure(active.feedbackPressure, sample.normalized.pressure);
    const pixel = sample.pixel;
    trackInkMovement(active, pixel);
    // 包括被距离过滤掉的小采样；慢写一旦离开轻点范围，就不再恢复候选。
    if (active.longPress?.active) {
      active.longPress = updateLongPressCandidate(active.longPress, pixel.x, pixel.y);
    }
    const isBatchLast = index === samples.length - 1;
    if (
      !isBatchLast
      && distance(pixel, active.lastPixel) <= MIN_SAMPLE_DISTANCE_CSS_PX
    ) {
      continue;
    }
    active.stroke.points.push(sample.normalized);
    active.lastPixel = pixel;
    count += 1;
    if (
      !active.moved
      && distance(pixel, active.startPixel) >= LASSO_MOVE_DISTANCE_CSS_PX
    ) {
      active.moved = true;
    }
  }
  if (!active.longPress?.active && active.timer) {
    clearInkTimer(active);
  }
  return count;
}

// pointerup 真实终点：继续沿用 inkStability 的抬笔抖动过滤。
export function appendInkPointerUp(active, upPoint) {
  if (!active || !upPoint) return false;
  if (!shouldAppendPointerUpPoint(active, upPoint)) return false;
  active.stroke.points.push(upPoint.normalized);
  if (upPoint.pixel) {
    trackInkMovement(active, upPoint.pixel);
    active.lastPixel = upPoint.pixel;
  }
  return true;
}

// 所有结束路径（up/cancel/lost-capture/unmount/会话被替换）统一清理。
export function endInkSession(active) {
  if (!active) return null;
  clearInkTimer(active);
  active.longPress = null;
  return active;
}

// ---------------- 曲线构造 ----------------

export function isSharpTurn(prev, vertex, next) {
  if (!prev || !vertex || !next) return false;
  const ax = vertex.x - prev.x;
  const ay = vertex.y - prev.y;
  const bx = next.x - vertex.x;
  const by = next.y - vertex.y;
  const al = Math.hypot(ax, ay);
  const bl = Math.hypot(bx, by);
  if (al < 1e-6 || bl < 1e-6) return false;
  return (ax * bx + ay * by) / (al * bl) <= SHARP_TURN_DOT;
}

function anchor(points, index) {
  return mid(points[index], points[index + 1]);
}

// 局部二次中点插值的“常规段”列表（不含抬笔尾段）：
// 第 1 段：P0 -> mid(P0,P1)；第 k 段（k>=2）：mid(P{k-2},P{k-1}) -> mid(P{k-1},Pk)，控制点 P{k-1}。
// 顶点外部转角 >= 约 100°（dot <= SHARP_TURN_DOT）时该顶点直连，保住汉字折笔。
export function inkSegments(points) {
  const segments = [];
  const n = points.length;
  if (n < 2) return segments;
  segments.push({ type: "line", from: points[0], to: anchor(points, 0) });
  for (let j = 2; j < n; j += 1) {
    const from = anchor(points, j - 2);
    const vertex = points[j - 1];
    const to = anchor(points, j - 1);
    if (isSharpTurn(points[j - 2], vertex, points[j])) {
      segments.push({ type: "line", from, to: vertex });
      segments.push({ type: "line", from: vertex, to });
    } else {
      segments.push({ type: "quad", from, control: vertex, to });
    }
  }
  return segments;
}

// 抬笔尾段：从 mid(P{n-2},P{n-1}) 直线连到真实终点 P{n-1}，
// 与上一段在 mid 处切线连续，实时书写与最终回放共用这一规则。
export function inkTail(points) {
  const n = points.length;
  if (n < 2) return null;
  const from = anchor(points, n - 2);
  const to = points[n - 1];
  if (distance(from, to) < 1e-6) return null;
  return { type: "line", from, to };
}

// ---------------- 增量 / 整笔渲染 ----------------

function drawLine(context, from, to) {
  context.beginPath();
  context.moveTo(from[0], from[1]);
  context.lineTo(to[0], to[1]);
  context.stroke();
}

function drawQuad(context, from, control, to) {
  context.beginPath();
  context.moveTo(from[0], from[1]);
  context.quadraticCurveTo(control[0], control[1], to[0], to[1]);
  context.stroke();
}

function withInkStyle(context, ratio, options, draw) {
  context.save();
  if (ratio !== 1) context.scale(ratio, ratio);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = options.lineWidth;
  context.strokeStyle = options.strokeStyle;
  context.fillStyle = options.strokeStyle;
  draw();
  context.restore();
}

// 只追加 renderedUntil 之后的常规段，绝不 clear 或重画历史。
// 与 traceInkPath 对同一组点产生完全相同的几何命令。
export function appendIncrementalInk(context, points, renderedUntil, toPixel, options = {}) {
  if (!context || !points?.length) return renderedUntil || 0;
  let next = Math.max(0, renderedUntil || 0);
  const ratio = options.ratio || 1;
  withInkStyle(context, ratio, options, () => {
    if (next === 0) {
      // 首点只消费、不绘制独立圆点；起笔端由第一段的 round cap 自然形成。
      next = 1;
    }
    while (next < points.length) {
      const j = next;
      if (j === 1) {
        drawLine(context, toPixel(points[0]), toPixel(anchor(points, 0)));
      } else if (isSharpTurn(points[j - 2], points[j - 1], points[j])) {
        drawLine(context, toPixel(anchor(points, j - 2)), toPixel(points[j - 1]));
        drawLine(context, toPixel(points[j - 1]), toPixel(anchor(points, j - 1)));
      } else {
        drawQuad(
          context,
          toPixel(anchor(points, j - 2)),
          toPixel(points[j - 1]),
          toPixel(anchor(points, j - 1)),
        );
      }
      next += 1;
    }
  });
  return next;
}

// 收尾：补画尚未消费的常规段（例如抬笔新增的真实终点），再画抬笔尾段。
export function finalizeInkPath(context, points, renderedUntil, toPixel, options = {}) {
  if (!context || !points?.length) return renderedUntil || 0;
  if (points.length === 1) {
    drawInkTip(context, points, toPixel, options);
    return 1;
  }
  appendIncrementalInk(context, points, renderedUntil, toPixel, options);
  const tail = inkTail(points);
  if (tail) {
    withInkStyle(context, options.ratio || 1, options, () => {
      drawLine(context, toPixel(tail.from), toPixel(tail.to));
    });
  }
  return points.length;
}

// 可替换尾层：起笔立即显示标准圆点，移动时连接到最新真实点。
// 返回 CSS 像素脏区，下一次只擦除旧尾段，不重绘已经稳定的轨迹。
export function drawInkTip(context, points, toPixel, options = {}) {
  if (!context || !points?.length) return null;
  const last = toPixel(points[points.length - 1]);
  const tail = inkTail(points);
  const from = tail ? toPixel(tail.from) : last;
  withInkStyle(context, options.ratio || 1, options, () => {
    if (points.length === 1) {
      context.beginPath();
      context.arc(last[0], last[1], options.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else if (tail) drawLine(context, from, last);
  });
  const padding = options.lineWidth / 2 + 2;
  return { left: Math.min(from[0], last[0]) - padding, top: Math.min(from[1], last[1]) - padding,
    right: Math.max(from[0], last[0]) + padding, bottom: Math.max(from[1], last[1]) + padding };
}

// 整笔回放：与“增量绘制 + finalizeInkPath”完全一致。
export function traceInkPath(context, points, toPixel, options = {}) {
  if (!context || !points?.length) return;
  appendIncrementalInk(context, points, 0, toPixel, options);
  const tail = inkTail(points);
  if (tail) {
    withInkStyle(context, options.ratio || 1, options, () => {
      drawLine(context, toPixel(tail.from), toPixel(tail.to));
    });
  }
}

// ---------------- handoff 生命周期辅助 ----------------

// 普通新增 pen 笔画才能走 append-only commit；eraser/lasso 属于结构性操作。
export function shouldUseAppendCommit(stroke) {
  if (!stroke) return false;
  const tool = stroke.tool || stroke.mode;
  return tool === "pen";
}

function trackInkMovement(active, pixel) {
  const motion = active.movement || (active.movement = {
    lastPixel: active.startPixel, maxDisplacement: 0, pathLength: 0,
  });
  motion.pathLength += distance(pixel, motion.lastPixel);
  motion.maxDisplacement = Math.max(motion.maxDisplacement, distance(pixel, active.startPixel));
  motion.lastPixel = pixel;
}

// 判断整笔的范围与路径长度，闭合线或回钩回到起点也不能折叠。
export function collapseTapStroke(active, thresholdCssPx = TAP_MOVE_THRESHOLD_CSS_PX) {
  if (!active?.stroke) return false;
  const tool = active.stroke.tool || active.stroke.mode;
  if (tool !== "pen") return false;
  if (active.stroke.points.length <= 1) return false;
  if (!active.movement) {
    const width = active.rect?.width || active.surface?.width || 1;
    const height = active.rect?.height || active.surface?.height || 1;
    for (const point of active.stroke.points) {
      trackInkMovement(active, { x: point.x * width, y: point.y * height });
    }
  }
  if (active.movement.maxDisplacement > thresholdCssPx
    || active.movement.pathLength > TAP_PATH_THRESHOLD_CSS_PX) return false;
  active.stroke.points = [active.stroke.points[0]];
  active.previewRenderedUntil = 0;
  return true;
}

// 计算 stroke 归一化 bounds 影响的 tile 范围（含 overlap 缓冲），并裁剪到可见窗口。
export function tileRangeForStroke(bounds, info, { tileHeight, overlap }) {
  if (!bounds || !info || !tileHeight || !info.contentHeight) return null;
  const first = Math.max(
    info.start,
    Math.floor((bounds.minY * info.contentHeight - tileHeight - overlap) / tileHeight),
  );
  const last = Math.min(
    info.end,
    Math.floor((bounds.maxY * info.contentHeight + tileHeight + overlap) / tileHeight),
  );
  if (last < first) return null;
  return { first, last };
}

// ---------------- stylus 防滚动守卫 ----------------

export function isActionTarget(target) {
  return target instanceof Element && Boolean(
    target.closest("button, select, input[type='checkbox'], input[type='radio'], [role='button']"),
  );
}

// 把精读页已验收的窗口级守卫抽成共享实现：
// - pen 的 pointerdown/pointermove 在 capture + passive:false 下 preventDefault（页面不跟笔）；
// - 有活跃 pen session 时 touchstart/touchmove 也 preventDefault（避免并行滚动）；
// - 不改变任何 touch-action，手指正常滚动不受影响。
export function installPenScrollGuard({
  root,
  ownsPointer = () => false,
  hasActiveSession = () => false,
}) {
  const rootEl = root?.current || root;
  if (!rootEl) return () => {};
  const preventNativePenScroll = (event) => {
    if (event.pointerType !== "pen") return;
    const owns = ownsPointer(event.pointerId);
    if (!owns && !rootEl.contains(event.target)) return;
    if (!owns && isActionTarget(event.target)) return;
    if (event.cancelable) event.preventDefault();
  };
  const preventParallelTouchScroll = (event) => {
    if (!hasActiveSession()) return;
    if (event.cancelable) event.preventDefault();
  };
  const options = { capture: true, passive: false };
  window.addEventListener("pointerdown", preventNativePenScroll, options);
  window.addEventListener("pointermove", preventNativePenScroll, options);
  window.addEventListener("touchstart", preventParallelTouchScroll, options);
  window.addEventListener("touchmove", preventParallelTouchScroll, options);
  return () => {
    window.removeEventListener("pointerdown", preventNativePenScroll, true);
    window.removeEventListener("pointermove", preventNativePenScroll, true);
    window.removeEventListener("touchstart", preventParallelTouchScroll, true);
    window.removeEventListener("touchmove", preventParallelTouchScroll, true);
  };
}
