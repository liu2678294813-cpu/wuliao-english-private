import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSaveBoundary } from "../useSaveBoundary.js";
import { scheduleInkSave, cancelScheduledInkSave } from "../saveCoordinator.js";
import { drawInkStroke, inkPixelRatio, renderInkLayer, resizeInkCanvas } from "../annotationTools";
import { installPenScrollGuard } from "../inkEngine";
import { useStructuredInk } from "../ink/useStructuredInk";
import { isAndroidApp } from "../platform";
import {
  createWritingInkAdapter,
  WritingInkSurfaceError,
  writingInkIdentityKey,
} from "./writingInkAdapter.js";
import {
  createWritingInkGeometryAdapter,
  createWritingPageGeometrySnapshot,
  measureWritingInkContainer,
  writingInkPointToPixel,
  writingPageRegionElement,
} from "./writingInkGeometry.js";

const CONTENT_STYLE = Object.freeze({ position: "relative" });
const EMPTY_PAGE_REGIONS = Object.freeze([]);
const CANVAS_STYLE = Object.freeze({
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
});

function validLogicalSize(size) {
  return Number.isFinite(size?.width) && size.width > 0
    && Number.isFinite(size?.height) && size.height > 0;
}

// CSS scaling changes the viewport rect, but the canvas must retain paper pixels.
export function measureWritingInkSurface(container, ratio, logicalSize) {
  const measured = measureWritingInkContainer(container, ratio);
  return validLogicalSize(logicalSize)
    ? { ...measured, width: logicalSize.width, height: logicalSize.height }
    : measured;
}

function warningForStatus(status) {
  if (status === "damaged") return "手写笔迹记录已损坏；为避免误显示，当前笔迹不会挂载。";
  if (status === "source-mismatch") return "内容来源已经变化；为避免错位，旧笔迹不会挂载。";
  if (status === "stale-revision") return "笔迹已被另一运行环境更新；请重新加载后继续。";
  if (status === "persist-failed") return "笔迹暂时无法保存；当前书写仍保留，可稍后重试。";
  if (status === "restore-failed") return "笔迹暂时无法读取；请重试或重新挂载当前输入区。";
  if (status === "account-mismatch") return "当前笔迹不属于已挂载账号，已阻止显示与写入。";
  if (status === "identity-mismatch") return "当前笔迹与输入区身份不一致，已阻止显示与写入。";
  return "";
}

export default function WritingInkSurface({
  username,
  sessionId,
  surfaceId,
  stageId,
  ownerRecordId,
  sourceFingerprint,
  disabled = false,
  readOnly = false,
  tool = "pen",
  color = "#173a62",
  penSize = 2.6,
  penMode = "ballpoint",
  eraserMode = "normal",
  eraserSize = 24,
  pageRegions = EMPTY_PAGE_REGIONS,
  persistence,
  logicalSize = null,
  ariaLabel = "Writing 手写输入",
  clearConfirmation = "清空当前 Writing 输入区的全部手写笔迹？此操作不会删除 Session、Attempt 或 Revision。",
  onInkRefChange,
  onFlushHandleChange,
  onToolbarApiChange,
  onStrokesCountChange,
  onError,
  onStatusChange,
  onInkMutation,
  onHint,
  children,
}) {
  const rootRef = useRef(null);
  const contentRef = useRef(null);
  const committedCanvasRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const tailCanvasRef = useRef(null);
  const pendingAdapterSaveRef = useRef([]);
  const adapterSaveTimerRef = useRef(null);
  const activeRef = useRef(null);
  const strokesRef = useRef([]);
  const dimensionsRef = useRef({ width: 0, height: 0, ratio: 0 });
  const pageGeometryRef = useRef(null);
  const pageRegionsRef = useRef(pageRegions);
  const mountedRef = useRef(false);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const penSizeRef = useRef(penSize);
  const penModeRef = useRef(penMode);
  const eraserModeRef = useRef(eraserMode);
  const eraserSizeRef = useRef(eraserSize);
  const disabledRef = useRef(disabled);
  const readOnlyRef = useRef(readOnly);
  const onInkRefChangeRef = useRef(onInkRefChange);
  const onFlushHandleChangeRef = useRef(onFlushHandleChange);
  const onToolbarApiChangeRef = useRef(onToolbarApiChange);
  const onStrokesCountChangeRef = useRef(onStrokesCountChange);
  const onErrorRef = useRef(onError);
  const onStatusChangeRef = useRef(onStatusChange);
  const onInkMutationRef = useRef(onInkMutation);
  const onHintRef = useRef(onHint);
  const logicalSizeRef = useRef(logicalSize);
  const clearConfirmationRef = useRef(clearConfirmation);
  const requestedIdentityKeyRef = useRef("");
  const [strokes, setStrokes] = useState([]);
  const [storageStatus, setStorageStatus] = useState("idle");

  pageRegionsRef.current = pageRegions;
  logicalSizeRef.current = logicalSize;
  clearConfirmationRef.current = clearConfirmation;

  requestedIdentityKeyRef.current = writingInkIdentityKey({
    username,
    sessionId,
    surfaceId,
    stageId,
    ownerRecordId,
    sourceFingerprint,
  });

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { penSizeRef.current = penSize; }, [penSize]);
  useEffect(() => { penModeRef.current = penMode; }, [penMode]);
  useEffect(() => { eraserModeRef.current = eraserMode; }, [eraserMode]);
  useEffect(() => { eraserSizeRef.current = eraserSize; }, [eraserSize]);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);
  useEffect(() => { onInkRefChangeRef.current = onInkRefChange; });
  useEffect(() => { onFlushHandleChangeRef.current = onFlushHandleChange; });
  useEffect(() => { onToolbarApiChangeRef.current = onToolbarApiChange; });
  useEffect(() => { onStrokesCountChangeRef.current = onStrokesCountChange; });
  useEffect(() => { onErrorRef.current = onError; });
  useEffect(() => { onStatusChangeRef.current = onStatusChange; });
  useEffect(() => { onInkMutationRef.current = onInkMutation; });
  useEffect(() => { onHintRef.current = onHint; });

  const readPageGeometry = useCallback(() => (
    createWritingPageGeometrySnapshot(contentRef.current, pageRegionsRef.current)
  ), []);

  const reportGeometryError = useCallback((cause) => {
    const error = new WritingInkSurfaceError(
      "geometry-failed",
      cause?.message || "Writing page geometry failed",
      { cause },
    );
    error.geometryCode = cause?.code || "writing-geometry-unknown";
    onErrorRef.current?.(error);
  }, []);

  const geometryAdapterRef = useRef(null);
  if (!geometryAdapterRef.current) {
    geometryAdapterRef.current = createWritingInkGeometryAdapter({
      getSnapshot: () => pageGeometryRef.current,
      onError: reportGeometryError,
    });
  }
  const geometryAdapter = geometryAdapterRef.current;

  const renderCommitted = useCallback((extraStroke = null) => {
    const canvas = committedCanvasRef.current;
    const { width, height, ratio } = dimensionsRef.current;
    if (!canvas || !width || !height) return false;
    const committed = strokesRef.current.map((stroke) => geometryAdapter.projectStroke(stroke));
    const view = extraStroke
      ? [...committed, geometryAdapter.projectStroke(extraStroke)]
      : committed;
    return renderInkLayer(canvas, view, width, height, ratio);
  }, [geometryAdapter]);

  const commitAppendStroke = useCallback((stroke) => {
    const canvas = committedCanvasRef.current;
    const { width, height, ratio } = dimensionsRef.current;
    if (!canvas || !width || !height) return false;
    const context = canvas.getContext("2d", { alpha: true });
    context.save();
    context.scale(ratio, ratio);
    drawInkStroke(context, geometryAdapter.projectStroke(stroke), width, height);
    context.restore();
    return true;
  }, [geometryAdapter]);

  const adapterRef = useRef(null);
  if (!adapterRef.current) {
    adapterRef.current = createWritingInkAdapter({
      getSnapshot: persistence?.getSnapshot,
      saveSnapshot: persistence?.saveSnapshot,
      onStrokesChange: (next, meta) => {
        strokesRef.current = next;
        if (!mountedRef.current) return;
        startTransition(() => { setStrokes(next); onStrokesCountChangeRef.current?.(next.length); });
        if (!meta.skipTileRedraw) renderCommitted();
      },
      onInkRefChange: (ref) => onInkRefChangeRef.current?.(ref),
      onStatusChange: (next) => {
        if (!mountedRef.current) return;
        setStorageStatus(next.status);
        onStatusChangeRef.current?.(next);
      },
      onError: (error) => onErrorRef.current?.(error),
    });
  }
  const adapter = adapterRef.current;

  const flushAdapterChanges = useCallback(() => {
    cancelScheduledInkSave(adapterSaveTimerRef.current);
    adapterSaveTimerRef.current = null;
    while (pendingAdapterSaveRef.current.length) {
      const pending = pendingAdapterSaveRef.current[0];
      adapter.replaceCommitted(pending.next, pending.options);
      pendingAdapterSaveRef.current.shift();
    }
  }, [adapter]);

  const persistStrokes = useCallback((next, options = {}) => {
    strokesRef.current = next;
    onInkMutationRef.current?.(next.length, dimensionsRef.current);
    pendingAdapterSaveRef.current.push({ next, options });
    cancelScheduledInkSave(adapterSaveTimerRef.current);
    adapterSaveTimerRef.current = scheduleInkSave(flushAdapterChanges);
  }, [flushAdapterChanges]);

  const inkController = useStructuredInk({
    canInteract: () => {
      const mountedIdentity = adapter.getIdentity();
      return !disabledRef.current
        && !readOnlyRef.current
        && adapter.isInteractive()
        && mountedIdentity !== null
        && writingInkIdentityKey(mountedIdentity) === requestedIdentityKeyRef.current;
    },
    surfaceRef: contentRef,
    surfaceSize: validLogicalSize(logicalSize)
      ? () => ({ width: logicalSizeRef.current.width, height: logicalSizeRef.current.height })
      : null,
    previewCanvasRef,
    tailCanvasRef,
    strokesRef,
    activeRef,
    toolRef,
    colorRef,
    penSizeRef,
    penModeRef,
    eraserModeRef,
    eraserSizeRef,
    commitAppendStroke,
    renderCommitted,
    persistStrokes,
    engineForPen: () => isAndroidApp(),
    geometryAdapter,
    onHint: (hint) => onHintRef.current?.(hint),
    beforeInkDown: () => {
      try {
        pageGeometryRef.current = readPageGeometry();
      } catch (cause) {
        pageGeometryRef.current = null;
        reportGeometryError(cause);
      }
    },
    toPreviewPixel: (point) => writingInkPointToPixel(point, dimensionsRef.current),
  });

  const finalizeActive = useCallback(() => {
    if (activeRef.current) inkController.finishActiveForGeometryChange();
    flushAdapterChanges();
  }, [inkController, flushAdapterChanges]);

  const flush = useCallback(async (context = {}) => {
    finalizeActive();
    try {
      return await adapter.flush(context);
    } catch (cause) {
      if (cause instanceof WritingInkSurfaceError && cause.code === "flush-failed") throw cause;
      throw new WritingInkSurfaceError("flush-failed", "Writing ink flush failed", {
        cause,
        identity: adapter.getIdentity(),
      });
    }
  }, [adapter, finalizeActive]);

  useSaveBoundary(flush);
  const undo = useCallback(() => {
    if (disabledRef.current || readOnlyRef.current) return false;
    finalizeActive();
    inkController.clearPreview();
    const changed = adapter.undo();
    if (changed) onInkMutationRef.current?.(strokesRef.current.length, dimensionsRef.current);
    return changed;
  }, [adapter, inkController, finalizeActive]);

  const clear = useCallback(() => {
    finalizeActive();
    if (disabledRef.current || readOnlyRef.current || !adapter.getState().canClear) return false;
    if (!window.confirm(clearConfirmationRef.current)) return false;
    inkController.clearPreview();
    const changed = adapter.clear();
    if (changed) onInkMutationRef.current?.(strokesRef.current.length, dimensionsRef.current);
    return changed;
  }, [adapter, inkController, finalizeActive]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    adapter.attach({
      username,
      sessionId,
      surfaceId,
      stageId,
      ownerRecordId,
      sourceFingerprint,
    }, { beforeDetach: finalizeActive }).catch((cause) => {
      // Virtual rows can leave the viewport before their queued attach runs.
      // That retired surface must not overwrite the current page's status.
      if (!mountedRef.current) return;
      onErrorRef.current?.(cause instanceof WritingInkSurfaceError
        ? cause
        : new WritingInkSurfaceError("restore-failed", "Writing ink attach failed", { cause }));
    });
  }, [adapter, finalizeActive, ownerRecordId, sessionId, sourceFingerprint, stageId, surfaceId, username]);

  useEffect(() => {
    onFlushHandleChangeRef.current?.(flush);
    return () => onFlushHandleChangeRef.current?.(null);
  }, [flush]);

  useEffect(() => {
    const api = {
      undo,
      clear,
      flush,
      canUndo: strokes.length > 0,
      canClear: strokes.length > 0,
      status: storageStatus,
    };
    onToolbarApiChangeRef.current?.(api);
    return () => onToolbarApiChangeRef.current?.(null);
  }, [clear, flush, storageStatus, strokes.length, undo]);

  useLayoutEffect(() => {
    const resize = () => {
      const content = contentRef.current;
      if (!content) return;
      const next = measureWritingInkSurface(content, inkPixelRatio(), logicalSizeRef.current);
      const current = dimensionsRef.current;
      let nextPageGeometry = null;
      try {
        nextPageGeometry = readPageGeometry();
      } catch (cause) {
        reportGeometryError(cause);
      }
      const dimensionsChanged = next.width !== current.width
        || next.height !== current.height
        || next.ratio !== current.ratio;
      const pageGeometryChanged = nextPageGeometry?.signature !== pageGeometryRef.current?.signature;
      if (!dimensionsChanged && !pageGeometryChanged) return;
      finalizeActive();
      pageGeometryRef.current = nextPageGeometry;
      dimensionsRef.current = next;
      if (dimensionsChanged) {
        resizeInkCanvas(committedCanvasRef.current, next.width, next.height, next.ratio);
        resizeInkCanvas(previewCanvasRef.current, next.width, next.height, next.ratio);
        resizeInkCanvas(tailCanvasRef.current, next.width, next.height, next.ratio);
      }
      renderCommitted();
    };
    resize();
    const observer = globalThis.ResizeObserver ? new ResizeObserver(resize) : null;
    if (contentRef.current && observer) observer.observe(contentRef.current);
    for (const region of Array.isArray(pageRegions) ? pageRegions : EMPTY_PAGE_REGIONS) {
      const element = writingPageRegionElement(region);
      if (element && observer) observer.observe(element);
    }
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [finalizeActive, logicalSize?.width, logicalSize?.height, pageRegions, readPageGeometry, renderCommitted, reportGeometryError]);

  useEffect(() => installPenScrollGuard({
    root: rootRef,
    ownsPointer: (pointerId) => activeRef.current?.id === pointerId,
    hasActiveSession: () => Boolean(activeRef.current),
  }), []);

  useEffect(() => {
    const flushOnPageHide = () => { flush().catch(() => {}); };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush().catch(() => {});
    };
    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [flush]);

  useEffect(() => () => {
    adapter.dispose().catch((cause) => onErrorRef.current?.(
      cause instanceof WritingInkSurfaceError
        ? cause
        : new WritingInkSurfaceError("flush-failed", "Writing ink unmount flush failed", { cause }),
    ));
  }, [adapter]);

  const warning = warningForStatus(storageStatus);
  return (
    <section
      ref={rootRef}
      className={`writing-ink-surface ${disabled || readOnly ? "is-disabled" : ""}`}
      aria-label={ariaLabel}
      aria-readonly={readOnly || undefined}
    >
      {warning ? <p className="writing-ink-warning" role="alert">{warning}</p> : null}
      <div
        ref={contentRef}
        className="writing-ink-content"
        style={validLogicalSize(logicalSize) ? { ...CONTENT_STYLE, width: logicalSize.width, height: logicalSize.height } : CONTENT_STYLE}
        onPointerDownCapture={inkController.handlePointerDown}
        onPointerMoveCapture={inkController.handlePointerMove}
        onPointerUpCapture={inkController.handlePointerUp}
        onPointerCancelCapture={inkController.handlePointerCancel}
        onLostPointerCapture={inkController.handlePointerUp}
      >
        {children}
        <canvas ref={committedCanvasRef} className="writing-ink-canvas" style={CANVAS_STYLE} aria-hidden="true" />
        <canvas ref={previewCanvasRef} className="writing-ink-preview" style={CANVAS_STYLE} aria-hidden="true" />
        <canvas ref={tailCanvasRef} className="ink-tail-canvas" style={CANVAS_STYLE} aria-hidden="true" />
      </div>
    </section>
  );
}

export { warningForStatus };
