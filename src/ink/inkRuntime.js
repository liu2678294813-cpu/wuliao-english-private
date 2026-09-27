import { createInkUndoPatch } from "./inkUndo.js";
// Shared Ink Runtime —— 从当前正式精读（CustomDeepReader）机械抽取的统一笔系统核心。
// 职责：pointer capture / 会话创建 / coalesced 采样 / 笔输入立即增量绘制 / 其他预览 rAF 批处理 /
//       pen-up 收尾（确认 committed 后清 preview）/ 长按临时橡皮 /
//       lasso / normal eraser / 结构性重绘路由 / telemetry。
// 业务差异（persistence / surface identity / 允许的辅助工具）全部由调用方通过 deps 注入：
// 本模块不感知任何 storage key、surfaceId 或业务状态。
//
// 设计约束（与精读 Golden Implementation 保持一致）：
// - 普通新增 pen stroke：append-only 提交，绝不 clear / 重画历史。
// - 只有 eraser / lasso / undo / clear / resize / 初始加载 / 历史恢复才允许结构性重绘。
// - 持久化格式与业务身份由 Surface 管理。

import {
  appendInkPointerUp,
  appendInkSamples,
  appendIncrementalInk,
  collapseTapStroke,
  createInkSession,
  endInkSession,
  drawInkTip,
  finalizeInkPath,
  inkSegments,
  inkTail,
  installPenScrollGuard,
  isActionTarget,
  isSharpTurn,
  shouldUseAppendCommit,
  startInkLongPressTimer,
  tileRangeForStroke,
  traceInkPath,
} from "../inkEngine";
import {
  coalescedPointerPoints,
  drawInkStroke,
  eraseAnnotationsAlongPath,
  eraseAnnotationsInPolygon,
  inkPixelRatio,
  pointerPointFromSample,
  renderInkLayer,
  resizeInkCanvas,
} from "../annotationTools";
import {
  clearInkTimer,
  isCurrentInkSession,
  shouldAppendPointerUpPoint,
  startInkLongPress,
  temporaryInkMode,
} from "../inkStability";
import { getTelemetry } from "../telemetry/telemetry";
import { recordInkHandoff } from "../inkDebug";

const INK_TIMING_SAMPLE_CAP = 64;

// ---------------- 纯决策辅助（可单测） ----------------

// 当前正式精读的 tool 解析：eraser + lasso 模式 → lasso。
export function resolveInkTool(tool, eraserMode) {
  return tool === "eraser" && eraserMode === "lasso" ? "lasso" : tool;
}

// 是否走 direct-ink + ballpoint 的增量渲染路径（与精读 drawViewportPreview 同一判定）。
export function isDirectInkBallpoint(active) {
  return Boolean(
    active?.sessionTool === "pen"
    && active?.stroke?.tool === "pen"
    && active?.stroke?.engine === "direct-ink"
    && active?.stroke?.penMode === "ballpoint",
  );
}

// 会话 strokeMeta：与精读 handleInkDown 完全一致（lasso 固定橙色细线、normal eraser v2）。
export function buildInkStrokeMeta({ tool, color, eraserMode, eraserSize, penSize, penMode, engineForPen }) {
  return {
    tool,
    color: tool === "lasso" ? "#e26f51" : color,
    width: tool === "eraser" ? (eraserMode === "normal" ? eraserSize : 2) : penSize,
    version: tool === "eraser" && eraserMode === "normal" ? 2 : undefined,
    engine: tool === "pen" && engineForPen ? "direct-ink" : undefined,
    penMode: tool === "pen" && engineForPen ? penMode : undefined,
  };
}

// ---------------- 生命周期控制器 ----------------
//
// createInkRuntimeController(deps) 生成一个无 React 依赖的控制器实例。
// 所有可变输入都通过 deps 上的 ref / 回调读取（调用时取最新值），因此：
// - 控制器只需创建一次（useStructuredInk 内 useRef 缓存）；
// - 业务回调（persistStrokes 等）通过 setDeps 每次渲染刷新，绝无 stale closure。
export function createInkRuntimeController(initial = {}) {
  const deps = {
    canInteract: () => true,
    surfaceSize: null,            // optional untransformed paper dimensions
    beforeSurfaceMeasure: null,   // settle an in-flight surface animation before sampling
    renderPreviewStroke: null,   // optional viewport projection for non-incremental ink
    surfaceRef: null,             // pointer 事件目标 + rect 来源（content / canvas）
    previewCanvasRef: null,
    tailCanvasRef: null,
    strokesRef: null,
    activeRef: null,
    toolRef: null,
    colorRef: null,
    penSizeRef: null,
    penModeRef: null,
    eraserModeRef: null,
    eraserSizeRef: null,
    commitAppendStroke: () => false,
    renderCommitted: () => false,
    persistStrokes: () => {},
    beforeInkDown: null,          // 特殊工具（如精读 unknown 选择）下行钩子；返回 "abort" 中断常规会话
    beforeInkMove: null,
    beforeInkFinish: null,
    onStrokeDirty: null,          // 采样/收尾后失效 bounds cache（tile 场景）
    onHint: null,
    onTemporaryEraser: null,
    toPreviewPixel: null,         // (point, active) => [x, y]；默认 canvas-local
    previewOptions: null,         // (stroke) => { lineWidth, strokeStyle, ratio }
    previewCanvasSize: null,      // () => { width, height }；默认取 canvas client 尺寸
    engineForPen: () => false,    // direct-ink 是否启用（Android App）
    geometryAdapter: null,        // 可选坐标投影；默认 identity，Pdf/Cloze/Exam 不受影响
    ...initial,
  };

  const previewClearFrameRef = { current: null };
  const previewRenderFrameRef = { current: null };
  const pendingPreviewActiveRef = { current: null };
  let pendingCommits = [];
  let pendingPersistence = null;
  const undoOperations = [];

  function rememberUndo() {
    let before = deps.strokesRef.current;
    let patch;
    const restore = deps.captureUndo?.() || (() => {
      const previous = deps.strokesRef.current;
      const restored = patch(previous);
      deps.persistStrokes(restored, { structural: true, force: true });
      deps.strokesRef.current = restored;
      if (deps.renderDeletion) deps.renderDeletion(restored, previous);
      else deps.renderCommitted();
    });
    restore.seal ||= () => { patch = createInkUndoPatch(before, deps.strokesRef.current); before = null; };
    undoOperations.push(restore);
    return restore;
  }

  function undo() {
    finishActiveForGeometryChange();
    clearPreview();
    const restore = undoOperations.at(-1);
    if (restore) { restore(); undoOperations.pop(); }
    else if (deps.strokesRef.current.length) {
      deps.persistStrokes(deps.strokesRef.current.slice(0, -1), { structural: true, force: true });
      deps.renderCommitted();
    }
  }
  let tailBounds = null;

  function clearTail() {
    const canvas = deps.tailCanvasRef?.current;
    if (canvas && tailBounds) {
      const ratio = Number(canvas.dataset.ratio) || 1;
      const left = Math.floor(tailBounds.left * ratio);
      const top = Math.floor(tailBounds.top * ratio);
      canvas.getContext("2d", { alpha: true })?.clearRect(left, top,
        Math.ceil(tailBounds.right * ratio) - left, Math.ceil(tailBounds.bottom * ratio) - top);
    }
    tailBounds = null;
  }

  function previewStyle(active) {
    return active.previewStyle || (active.previewStyle = deps.previewOptions?.(active.stroke) || {
      lineWidth: Math.max(1, active.stroke.width || 2.6), strokeStyle: active.stroke.color,
      ratio: Number(deps.previewCanvasRef?.current?.dataset.ratio) || 1,
    });
  }

  function paintCommitted(callback, ...args) {
    try { return callback(...args) === true; }
    catch {
      deps.onHint?.("笔迹仍保留，正在等待画布恢复");
      return false;
    }
  }

  function persist(next, options) {
    const restore = rememberUndo();
    const write = deps.persistStrokes;
    try {
      write(next, options);
      deps.strokesRef.current = next;
      pendingPersistence = null;
    } catch (error) {
      deps.strokesRef.current = next;
      pendingPersistence = { write, next, options };
      deps.onHint?.("笔迹暂未保存，请保留页面并重试");
      globalThis.window?.dispatchEvent?.(new Event("wuliao:save-failed"));
    } finally { restore.seal(); }
  }

  function retryPersistence() {
    if (!pendingPersistence) return;
    const { write, next, options } = pendingPersistence;
    write(next, options);
    pendingPersistence = null;
  }

  function setDeps(next) {
    Object.assign(deps, next);
    if (pendingCommits.length) retryPendingCommits();
  }

  function recordInkTelemetry(active, { finalizeMs, geometryMs, commitMs, penUpTotalMs, collapsed }) {
    try {
      const telemetry = getTelemetry();
      const durationMs = (active.telemetry?.endAt || performance.now()) - (active.telemetry?.startAt || performance.now());
      const anomaly = durationMs > 60000 || active.stroke.points.length > 3000;
      for (const [renderMs, sampleAge] of active.telemetry?.renderSamples || []) {
        telemetry.recordTiming({ metric: "ink.render", durationMs: renderMs });
        if (sampleAge !== null) telemetry.recordTiming({ metric: "ink.input-to-draw", durationMs: sampleAge });
      }
      telemetry.recordEvent({
        eventType: "ink.stroke_end",
        taskType: String(active.stroke.tool || active.sessionTool || "pen"),
        status: "ok",
        durationMs,
        metadata: {
          tool: String(active.stroke.tool || ""),
          points: active.stroke.points.length,
          coalesced: active.telemetry?.coalesced || 0,
          accepted: active.telemetry?.accepted || 0,
          finalizeMs: Math.round(finalizeMs * 100) / 100,
          geometryMs: Math.round(geometryMs * 100) / 100,
          commitMs: Math.round(commitMs * 100) / 100,
          penUpTotalMs: Math.round(penUpTotalMs * 100) / 100,
          tap: Boolean(collapsed),
          temporaryEraser: active.sessionTool === "temporary-eraser",
          anomaly,
        },
      });
      telemetry.recordTiming({ metric: "ink.stroke.finalize", durationMs: finalizeMs });
      telemetry.recordTiming({ metric: "ink.stroke.geometry", durationMs: geometryMs });
      telemetry.recordTiming({ metric: "ink.stroke.commit", durationMs: commitMs });
      telemetry.recordTiming({ metric: "ink.stroke.penup.total", durationMs: penUpTotalMs });
    } catch {
      // Telemetry 异常绝不影响笔迹主流程
    }
  }

  // 立即清空 live preview（结构性操作 / undo / clear / 非 append 提交后使用）。
  function clearPreview() {
    clearTail();
    if (previewClearFrameRef.current) {
      window.cancelAnimationFrame(previewClearFrameRef.current);
      previewClearFrameRef.current = null;
    }
    if (previewRenderFrameRef.current) window.cancelAnimationFrame(previewRenderFrameRef.current);
    previewRenderFrameRef.current = null;
    pendingPreviewActiveRef.current = null;
    const canvas = deps.previewCanvasRef?.current;
    if (canvas) renderInkLayer(canvas, [], canvas.clientWidth || 1, canvas.clientHeight || 1);
    // 失败笔画与活跃笔画分开管理；清理新笔预览不能顺带擦掉未交接的笔。
    pendingCommits = pendingCommits.filter(({ storedStroke, fingerprint }) =>
      deps.strokesRef.current.includes(storedStroke)
      || deps.strokesRef.current.some((stroke) => JSON.stringify(stroke) === fingerprint));
    for (const { preview } of pendingCommits) {
      preview.previewRenderedUntil = 0;
      drawPreview(preview);
      finalizePreview(preview);
    }
  }

  function retryPendingCommits() {
    if (!pendingCommits.length) return true;
    // 已入内存的笔画由全量回放恢复，不再以 extraStroke 重复追加。
    if (!paintCommitted(deps.renderCommitted)) return false;
    pendingCommits = [];
    const active = deps.activeRef?.current;
    clearPreview();
    if (active) {
      active.previewRenderedUntil = 0;
      drawPreview(active);
    }
    return true;
  }

  // 仅安排一次重试。仍不可用则等后续输入/布局/依赖刷新，不盲清、不忙轮询。
  function schedulePreviewClearAfterCommit() {
    if (previewRenderFrameRef.current) window.cancelAnimationFrame(previewRenderFrameRef.current);
    previewRenderFrameRef.current = null;
    pendingPreviewActiveRef.current = null;
    if (previewClearFrameRef.current) window.cancelAnimationFrame(previewClearFrameRef.current);
    previewClearFrameRef.current = window.requestAnimationFrame(() => {
      previewClearFrameRef.current = null;
      retryPendingCommits();
    });
  }

  function drawPreview(active) {
    const canvas = deps.previewCanvasRef?.current;
    if (!canvas || !active?.stroke?.points?.length) return;
    const startedAt = performance.now();
    // preview 层与 committed 层必须走同一浏览器合成通道：
    // desynchronized canvas 会绕过合成时序，抬笔清 preview 与 committed 上屏顺序
    // 在部分 WebView 上不可预期，导致"写完闪一下"。此处不使用 desynchronized。
    const context = canvas.getContext("2d", { alpha: true });
    const options = previewStyle(active);
    if (isDirectInkBallpoint(active)) {
      const toPixel = deps.toPreviewPixel
        || ((point) => [point.x * active.surface.width, point.y * active.surface.height]);
      active.previewRenderedUntil = appendIncrementalInk(
        context,
        active.stroke.points,
        active.previewRenderedUntil,
        (point) => toPixel(point, active),
        options,
      );
      clearTail();
      const tail = deps.tailCanvasRef?.current;
      if (tail) tailBounds = drawInkTip(tail.getContext("2d", { alpha: true }), active.stroke.points,
        (point) => toPixel(point, active), options);
      if (tail && active.longPress?.active && active.pointerType === "pen") {
        const [x,y] = toPixel(active.stroke.points.at(-1), active);
        const radius = 6 + (active.feedbackPressure ?? 0.5) * 6;
        const feedback = tail.getContext("2d", { alpha: true });
        feedback.save(); feedback.scale(options.ratio, options.ratio);
        feedback.strokeStyle = "#e26f51"; feedback.globalAlpha = 0.18;
        feedback.lineWidth = 1; feedback.beginPath(); feedback.arc(x,y,radius,0,Math.PI*2); feedback.stroke(); feedback.restore();
        tailBounds = { left: Math.min(tailBounds?.left ?? x, x-radius-2), top: Math.min(tailBounds?.top ?? y, y-radius-2),
          right: Math.max(tailBounds?.right ?? x, x+radius+2), bottom: Math.max(tailBounds?.bottom ?? y, y+radius+2) };
      }
    } else if (deps.toPreviewPixel && active.stroke.tool === "lasso") {
      // 视口固定预览（精读 tile 策略）：lasso 的 surface 归一化坐标必须经
      // toPreviewPixel 映射到视口像素后再绘制，否则轨迹会画在左上角错误位置。
      const context = canvas.getContext("2d", { alpha: true });
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.save();
      context.scale(options.ratio, options.ratio);
      context.globalCompositeOperation = "source-over";
      context.strokeStyle = options.strokeStyle;
      context.lineWidth = Math.max(1, options.lineWidth || 2);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.setLineDash([7, 5]);
      context.beginPath();
      active.stroke.points.forEach((point, index) => {
        const [x, y] = deps.toPreviewPixel(point, active);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      if (active.sessionTool === "temporary-eraser") {
        const point = active.stroke.points.at(-1);
        const [x, y] = deps.toPreviewPixel(point, active);
        context.setLineDash([]);
        context.globalAlpha = 0.3 + (active.feedbackPressure ?? 0.5) * 0.4;
        context.beginPath();
        context.arc(x, y, 8 + (active.feedbackPressure ?? 0.5) * 8, 0, Math.PI * 2);
        context.stroke();
      }
      context.restore();
    } else if (deps.renderPreviewStroke) {
      deps.renderPreviewStroke(canvas, active);
    } else {
      const size = deps.previewCanvasSize
        ? deps.previewCanvasSize()
        : { width: canvas.clientWidth || 1, height: canvas.clientHeight || 1 };
      renderInkLayer(canvas, [active.stroke], size.width, size.height, options.ratio);
    }
    if (!deps.toPreviewPixel && active.sessionTool === "temporary-eraser" && active.stroke.tool === "lasso") {
      const point = active.stroke.points.at(-1);
      context.save();
      context.setTransform(options.ratio, 0, 0, options.ratio, 0, 0);
      context.setLineDash([]);
      context.strokeStyle = "#e26f51";
      context.globalAlpha = 0.3 + (active.feedbackPressure ?? 0.5) * 0.4;
      context.beginPath();
      context.arc(point.x * active.surface.width, point.y * active.surface.height, 8 + (active.feedbackPressure ?? 0.5) * 8, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
    const renderMs = performance.now() - startedAt;
    const sampleAge = active.latestSampleAt == null ? null : performance.now() - active.latestSampleAt;
    // Keep only the latest bounded window on the transient session. High-rate
    // pen events must not create a timer and telemetry work for every sample.
    // The existing stroke-end task publishes these timings after drawing.
    if (active.telemetry) {
      active.telemetry.renderSamples[active.telemetry.renderSampleCount % INK_TIMING_SAMPLE_CAP] = [renderMs, sampleAge];
      active.telemetry.renderSampleCount += 1;
    }
  }

  // rAF 批处理：同帧多次 pointermove 只重绘一次，且始终以最新会话为准。
  function renderPreview(active) {
    pendingPreviewActiveRef.current = active;
    if (previewRenderFrameRef.current) return;
    previewRenderFrameRef.current = window.requestAnimationFrame(() => {
      previewRenderFrameRef.current = null;
      const pending = pendingPreviewActiveRef.current;
      pendingPreviewActiveRef.current = null;
      if (pending) drawPreview(pending);
    });
  }

  function capturePointer(event) {
    try {
      // 在 surface 上 capture：pointermove/pointerup 继续流经同一元素。
      // 捕获在 surface（而非固定 preview canvas）上，避免饿死笔迹管线。
      (deps.surfaceRef?.current || event.currentTarget)?.setPointerCapture?.(event.pointerId);
    } catch {
      // Android WebView 可能拒绝 capture；继续书写不受影响。
    }
  }

  function handlePointerDown(event) {
    if (!deps.canInteract()) return;
    if (event.pointerType === "touch") return;
    if (isActionTarget(event.target)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const previous = deps.activeRef?.current;
    if (previous) {
      if (event.pointerType !== "pen" && previous.pointerType === "pen") return;
      finishInk({ type: "pointercancel", pointerId: previous.id });
    }
    retryPendingCommits();
    event.preventDefault();
    capturePointer(event);
    if (previewClearFrameRef.current) {
      window.cancelAnimationFrame(previewClearFrameRef.current);
      previewClearFrameRef.current = null;
    }
    deps.beforeSurfaceMeasure?.();
    const rect = deps.surfaceRef?.current?.getBoundingClientRect();
    const point = pointerPointFromSample(event.nativeEvent || event, rect, event.pointerType === "pen");
    if (deps.beforeInkDown?.(event, { rect, point }) === "abort") return;
    const tool = resolveInkTool(deps.toolRef.current, deps.eraserModeRef.current);
    const engineForPen = deps.engineForPen();
    const active = createInkSession({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      point,
      rect,
      surface: deps.surfaceSize?.() || {
        width: Math.max(1, rect?.width || 1),
        height: Math.max(1, rect?.height || 1),
      },
      strokeMeta: buildInkStrokeMeta({
        tool,
        color: deps.colorRef.current,
        eraserMode: deps.eraserModeRef.current,
        eraserSize: deps.eraserSizeRef.current,
        penSize: deps.penSizeRef.current,
        penMode: deps.penModeRef.current,
        engineForPen,
      }),
    });
    try { deps.geometryAdapter?.beginStroke?.(active); }
    catch { deps.onHint?.("暂时无法获取页面位置，笔迹仍会保留"); }
    deps.activeRef.current = active;
    active.lastInputTime = point.timeStamp;
    active.lastInputPoint = point.normalized;
    active.telemetry = { startAt: performance.now(), coalesced: 0, accepted: 0, renderSamples: [], renderSampleCount: 0 };
    if (active.stroke.tool === "eraser") deps.renderCommitted(active.stroke);
    else drawPreview(active);
    startInkLongPressTimer(active, deps.activeRef, {
      eraserModeRef: deps.eraserModeRef,
      colorRef: deps.colorRef,
      eraserSizeRef: deps.eraserSizeRef,
      onTemporaryEraser: (session) => {
        session.previewStyle = null;
        clearPreview();
        renderPreview(session);
        deps.onHint?.("临时自由套索：圈选后抬笔删除");
        navigator.vibrate?.(35);
        deps.onTemporaryEraser?.(session, "lasso");
      },
    });
  }

  function handlePointerMove(event) {
    if (deps.beforeInkMove?.(event, deps.activeRef.current) === "abort") return;
    const active = deps.activeRef.current;
    if (!active || active.id !== event.pointerId) return;
    if (event.cancelable !== false) event.preventDefault();
    // 原始更新与普通 move 都可到达；按真实采样时间和属性去重。
    // 普通 move 始终保留为后备，不能只因 API 存在就丢弃它。
    const samples = coalescedPointerPoints(event, active.rect).filter((sample) => {
      if (sample.timeStamp !== null && active.lastInputTime !== null && sample.timeStamp < active.lastInputTime) return false;
      const previous = active.lastInputPoint;
      const point = sample.normalized;
      active.lastInputTime = sample.timeStamp;
      if (previous && ["x", "y", "pressure", "tiltX", "tiltY", "twist"].every((key) => previous[key] === point[key])) return false;
      active.lastInputPoint = point;
      return true;
    });
    if (!samples.length) return;
    const sampleTime = samples[samples.length - 1].timeStamp;
    const now = performance.now();
    active.latestSampleAt = sampleTime !== null && now >= sampleTime && now - sampleTime < 60000 ? sampleTime : now;
    const accepted = appendInkSamples(active, samples);
    if (active.telemetry) {
      active.telemetry.coalesced += samples.length;
      active.telemetry.accepted += accepted;
    }
    deps.onStrokeDirty?.(active.stroke);
    if (active.stroke.tool === "eraser") deps.renderCommitted(active.stroke);
    // Huawei WebView 实测：再排一次 rAF 会增加约一帧等待，即使 Canvas 绘制本身 <1 ms。
    // 已合并、去重的真实笔采样立即消费；只追加稳定段和替换尾段，不重画历史。
    else if (active.pointerType === "pen" && isDirectInkBallpoint(active)) drawPreview(active);
    else renderPreview(active);
  }

  // pointerup / pointercancel / lost-capture 统一收尾。
  function finishInk(event) {
    if (deps.beforeInkFinish?.(event, deps.activeRef.current) === "abort") return;
    const active = deps.activeRef.current;
    if (!active || active.id !== event.pointerId) return;
    // 在业务回调前解除会话；lost-capture/同步布局回调不得再次提交同一笔。
    deps.activeRef.current = null;
    const penUpStartedAt = performance.now();
    endInkSession(active);
    if (event.type === "pointerup") {
      const point = pointerPointFromSample(event.nativeEvent || event, active.rect, active.pointerType === "pen");
      if (appendInkPointerUp(active, point)) deps.onStrokeDirty?.(active.stroke);
    }
    // 先区分 tap 与 stroke：极小位移折叠为单点，避免起笔豆状小尾巴。
    const collapsed = collapseTapStroke(active);
    // 预览先补齐最后一段与抬笔尾段，再提交 committed 层，避免几何跳变。
    const finalizeStartedAt = performance.now();
    finalizePreview(active);
    const finalizeMs = performance.now() - finalizeStartedAt;
    // 普通新增笔画：append-only 提交；eraser 保持结构性重绘；lasso 特殊处理。
    // session / preview 一直使用当前 surface 的实时 content 坐标；仅在最终持久化前
    // 允许业务 Surface 把 stroke 变成自己的 canonical 坐标。
    const geometryStartedAt = performance.now();
    const previewStroke = active.stroke;
    if (active.stroke.tool !== "lasso") {
      try {
        active.stroke = deps.geometryAdapter?.finalizeStroke?.(active.stroke, { active }) || active.stroke;
      } catch {
        deps.onHint?.("笔迹保留原始坐标，页面布局恢复后重试");
      }
    }
    const geometryMs = performance.now() - geometryStartedAt;
    const isPenAppend = shouldUseAppendCommit(active.stroke);
    const commitStartedAt = performance.now();
    let penCommitReady = true;
    if (isPenAppend) {
      penCommitReady = paintCommitted(deps.commitAppendStroke, active.stroke);
      if (!penCommitReady) penCommitReady = paintCommitted(deps.renderCommitted, active.stroke);
    } else if (active.stroke.tool !== "lasso") {
      deps.renderCommitted(active.stroke);
    }
    const commitMs = performance.now() - commitStartedAt;
    if (!isPenAppend) clearPreview();
    if (active.stroke.tool === "lasso") {
      const lassoStartedAt = performance.now();
      if (active.moved && active.stroke.points.length > 2) {
        const source = deps.erasureSource?.() || deps.strokesRef.current;
        const adapter = deps.geometryAdapter;
        const projectedSources = new WeakMap();
        const projected = adapter?.projectStroke ? source.map((stroke) => {
          const view = adapter.projectStroke(stroke) || stroke;
          if (view && typeof view === "object") projectedSources.set(view, stroke);
          return view;
        }) : source;
        const keptProjected = eraseAnnotationsInPolygon(projected, active.stroke.points);
        // lasso 算法仍只过滤整条 stroke；投影仅供命中，存储必须保留 canonical 原对象。
        const next = keptProjected.map((stroke) => (
          projectedSources.get(stroke) || adapter?.canonicalFromProjected?.(stroke) || stroke
        ));
        const deleted = source.length - next.length;
        const computedAt = performance.now();
        if (deleted) {
          if (deps.persistErasure) { const restore = rememberUndo(); deps.persistErasure(next, source); restore.seal(); }
          else persist(next, { skipTileRedraw: true, structural: true });
          if (deps.renderDeletion) deps.renderDeletion(next, source);
          else deps.renderCommitted();
        }
        try {
          getTelemetry().recordTiming({ metric: "ink.lasso.compute", durationMs: computedAt - lassoStartedAt });
          getTelemetry().recordTiming({ metric: "ink.lasso.commit", durationMs: performance.now() - computedAt });
          const inputAt = Number(event.timeStamp);
          if (inputAt > 0 && inputAt <= penUpStartedAt) getTelemetry().recordTiming({ metric: "ink.lasso.input-wait", durationMs: penUpStartedAt - inputAt });
          // A paint opportunity is only a proxy; device video verifies visible latency.
          window.requestAnimationFrame(() => window.setTimeout(() => {
            try { getTelemetry().recordTiming({ metric: "ink.lasso.paint-opportunity", durationMs: performance.now() - penUpStartedAt }); } catch {}
          }, 0));
        } catch {}
        deps.onHint?.(deleted ? `已删除真实圈选范围内 ${deleted} 条笔迹` : "圈选范围内没有笔迹");
        window.setTimeout(() => deps.onHint?.(""), 1600);
      }
    } else if (active.stroke.tool === "eraser" && deps.commitEraserStroke) {
      const restore = rememberUndo();
      deps.commitEraserStroke(active.stroke);
      restore.seal();
    } else {
      persist([...deps.strokesRef.current, active.stroke], { skipTileRedraw: isPenAppend });
    }
    if (isPenAppend) {
      if (!penCommitReady) penCommitReady = paintCommitted(deps.renderCommitted);
      // committed 层已同步确认存在 → 同一渲染事务内移除 preview。
      // 若延迟到下一 rAF 才清 preview，浏览器会在 pointerup 事务后 composite 出
      // "preview + committed 同帧叠加" 的一帧（几何一致也因 alpha/抗锯齿视觉更粗），
      // 下一帧只剩 committed → 表现为抬笔"粗 → 细"闪变。
      // 只有 append commit 不可确认时才保留下一 rAF 清除的安全路径。
      if (penCommitReady) {
        clearPreview();
      } else {
        pendingCommits.push({ storedStroke: active.stroke, fingerprint: JSON.stringify(active.stroke),
          preview: { ...active, stroke: previewStroke } });
        schedulePreviewClearAfterCommit();
      }
    }
    if (active.sessionTool === "temporary-eraser") {
      deps.onHint?.("已恢复画笔");
      window.setTimeout(() => deps.onHint?.(""), 900);
    }
    const penUpTotalMs = performance.now() - penUpStartedAt;
    if (active.telemetry) active.telemetry.endAt = performance.now();
    const measurements = {
      finalizeMs,
      geometryMs,
      commitMs,
      penUpTotalMs,
      collapsed,
    };
    window.setTimeout(() => recordInkTelemetry(active, measurements), 0);
  }

  function finalizePreview(active) {
    if (!isDirectInkBallpoint(active)) return;
    const canvas = deps.previewCanvasRef?.current;
    if (!canvas) return;
    const options = previewStyle(active);
    clearTail();
    const toPixel = deps.toPreviewPixel
      || ((point) => [point.x * active.surface.width, point.y * active.surface.height]);
    active.previewRenderedUntil = finalizeInkPath(canvas.getContext("2d", { alpha: true }),
      active.stroke.points, active.previewRenderedUntil, (point) => toPixel(point, active), options);
  }

  function handlePointerUp(event) {
    finishInk(event);
  }

  function handlePointerCancel(event) {
    finishInk(event);
  }

  function attachRawInput() {
    const surface = deps.surfaceRef?.current;
    if (!surface?.addEventListener || !("onpointerrawupdate" in window)) return () => {};
    const raw = (event) => {
      if (event.pointerType === "pen" && deps.activeRef.current?.id === event.pointerId) handlePointerMove(event);
    };
    surface.addEventListener("pointerrawupdate", raw, { capture: true, passive: true });
    return () => surface.removeEventListener("pointerrawupdate", raw, true);
  }

  // Surface 几何即将切换时收尾当前会话，避免 preview 使用旧 rect。
  function finishActiveForGeometryChange() {
    const active = deps.activeRef?.current;
    if (active) finishInk({ type: "pointercancel", pointerId: active.id });
    retryPersistence();
  }

  // 卸载 / 页面离开时的兜底清理（crash / unexpected navigation fallback）。
  function dispose() {
    const active = deps.activeRef?.current;
    if (active) finishInk({ type: "pointercancel", pointerId: active.id });
    if (previewClearFrameRef.current) {
      window.cancelAnimationFrame(previewClearFrameRef.current);
      previewClearFrameRef.current = null;
    }
    if (previewRenderFrameRef.current) {
      window.cancelAnimationFrame(previewRenderFrameRef.current);
      previewRenderFrameRef.current = null;
    }
    pendingPreviewActiveRef.current = null;
  }

  return {
    setDeps,
    undo,
    canUndo: () => undoOperations.length > 0 || deps.strokesRef.current.length > 0,
    clearUndo: () => { undoOperations.length = 0; },
    clearPreview,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    finishActiveForGeometryChange,
    retryPendingCommits,
    pendingCommitCount: () => pendingCommits.length,
    attachRawInput,
    dispose,
  };
}

// 共享 Runtime 契约导出：精读 / 普通完形 / 考试四个 Surface 必须使用同一份实现。
export {
  appendInkPointerUp,
  appendInkSamples,
  appendIncrementalInk,
  collapseTapStroke,
  createInkSession,
  endInkSession,
  finalizeInkPath,
  isActionTarget,
  shouldUseAppendCommit,
  startInkLongPressTimer,
  installPenScrollGuard,
  tileRangeForStroke,
  traceInkPath,
  inkSegments,
  inkTail,
  isSharpTurn,
  eraseAnnotationsInPolygon,
  eraseAnnotationsAlongPath,
  drawInkStroke,
  renderInkLayer,
  pointerPointFromSample,
  coalescedPointerPoints,
  resizeInkCanvas,
  inkPixelRatio,
  startInkLongPress,
  clearInkTimer,
  isCurrentInkSession,
  shouldAppendPointerUpPoint,
  temporaryInkMode,
};
