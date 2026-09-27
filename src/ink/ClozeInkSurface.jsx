// 普通完形手写 Surface：使用 Shared Ink Runtime（useStructuredInk），
// 只覆盖稳定的 Cloze Passage 正文区域（Question Panel 完全不在笔迹坐标空间内）。
// 存储走独立 namespace（wuliao:cloze-ink:v1:*），与 clozeProgress/clozeFlow 隔离。
// 同一篇完形跨阶段保留笔迹；本组件在阶段切换时保持 mounted，不重载、不重建。

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStructuredInk } from "./useStructuredInk";
import { useSaveBoundary } from "../useSaveBoundary.js";
import { backgroundSave, scheduleInkSave, cancelScheduledInkSave } from "../saveCoordinator.js";
import {
  drawInkStroke,
  inkPixelRatio,
  renderInkLayer,
  resizeInkCanvas,
} from "../annotationTools";
import { installPenScrollGuard } from "../inkEngine";
import { isAndroidApp } from "../platform";
import { clearClozeInk, loadClozeInk, saveClozeInk } from "../clozeInk";


export default function ClozeInkSurface({
  resourceId,
  clozeId,
  enabled = true,
  tool = "pen",
  color = "#173a62",
  penSize = 2.6,
  penMode = "ballpoint",
  eraserMode = "normal",
  eraserSize = 24,
  onStrokesChange = null,
  onToolbarApiChange = null,
  // Shared Ink Runtime 特殊工具钩子（如陌生词选择）：透传给 useStructuredInk，
  // 由宿主 ClozeReader 提供实现（与精读同一扩展点，见 unknownWordInteraction）。
  beforeInkDown = null,
  beforeInkMove = null,
  beforeInkFinish = null,
  children,
}) {
  const rootRef = useRef(null);
  const contentRef = useRef(null);
  const committedCanvasRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const tailCanvasRef = useRef(null);
  const strokesRef = useRef([]);
  const activeRef = useRef(null);
  const dimensionsRef = useRef({ width: 1, height: 1, ratio: 1 });
  const saveTimerRef = useRef(null);
  const pendingSaveRef = useRef(null);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const penSizeRef = useRef(penSize);
  const penModeRef = useRef(penMode);
  const eraserModeRef = useRef(eraserMode);
  const eraserSizeRef = useRef(eraserSize);
  const enabledRef = useRef(enabled);
  const onToolbarApiChangeRef = useRef(onToolbarApiChange);
  const [strokes, setStrokes] = useState([]);

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { penSizeRef.current = penSize; }, [penSize]);
  useEffect(() => { penModeRef.current = penMode; }, [penMode]);
  useEffect(() => { eraserModeRef.current = eraserMode; }, [eraserMode]);
  useEffect(() => { eraserSizeRef.current = eraserSize; }, [eraserSize]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { onToolbarApiChangeRef.current = onToolbarApiChange; });

  const renderCommitted = useCallback((extraStroke = null) => {
    const canvas = committedCanvasRef.current;
    if (!canvas) return false;
    const { width, height, ratio } = dimensionsRef.current;
    if (extraStroke) return renderInkLayer(canvas, [...strokesRef.current, extraStroke], width, height, ratio);
    return renderInkLayer(canvas, strokesRef.current, width, height, ratio);
  }, []);

  // 普通新增 pen 笔画：append-only 提交，绝不 clear / 重画历史。
  const commitAppendStroke = useCallback((stroke) => {
    const canvas = committedCanvasRef.current;
    const { width, height, ratio } = dimensionsRef.current;
    if (!canvas || !width || !height) return false;
    const context = canvas.getContext("2d", { alpha: true });
    context.save();
    context.scale(ratio, ratio);
    drawInkStroke(context, stroke, width, height);
    context.restore();
    return true;
  }, []);

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      cancelScheduledInkSave(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    if (!pending) return;
    saveClozeInk(pending.resourceId, pending.clozeId, pending.strokes);
    pendingSaveRef.current = null;
  }, []);

  const persistStrokes = useCallback((next) => {
    strokesRef.current = next;
    startTransition(() => { setStrokes(next); onStrokesChange?.(next); });
    pendingSaveRef.current = { resourceId, clozeId, strokes: next };
    if (saveTimerRef.current) cancelScheduledInkSave(saveTimerRef.current);
    saveTimerRef.current = scheduleInkSave(flushPendingSave);
  }, [clozeId, flushPendingSave, onStrokesChange, resourceId]);

  const inkController = useStructuredInk({
    canInteract: () => enabledRef.current,
    surfaceRef: contentRef,
    surfaceSize: () => dimensionsRef.current,
    beforeSurfaceMeasure: () => contentRef.current?.closest(".cloze-passage-pane")
      ?.dispatchEvent(new Event("reader-paper-settle")),
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
    beforeInkDown,
    beforeInkMove,
    beforeInkFinish,
  });

  const undo = useCallback(() => {
    inkController.clearPreview();
    if (strokesRef.current.length) persistStrokes(strokesRef.current.slice(0, -1));
  }, [inkController, persistStrokes]);
  useSaveBoundary(() => {
    inkController.finishActiveForGeometryChange();
    flushPendingSave();
  });

  const clear = useCallback(() => {
    if (!strokesRef.current.length) return;
    if (!window.confirm("清空当前完形的全部手写笔迹？答题记录、翻译与陌生词不会删除。")) return;
    inkController.clearPreview();
    strokesRef.current = [];
    setStrokes([]);
    onStrokesChange?.([]);
    if (saveTimerRef.current) cancelScheduledInkSave(saveTimerRef.current);
    saveTimerRef.current = null;
    pendingSaveRef.current = null;
    clearClozeInk(resourceId, clozeId);
  }, [clozeId, inkController, onStrokesChange, resourceId]);

  useEffect(() => {
    onToolbarApiChangeRef.current?.({ undo, clear });
    return () => onToolbarApiChangeRef.current?.(null);
  }, [clear, undo]);

  // 加载：resourceId/clozeId 变化时重载（跨阶段不变化，组件保持 mounted 不触发）。
  useEffect(() => {
    let cancelled = false;
    const loaded = loadClozeInk(resourceId, clozeId);
    if (cancelled) return;
    strokesRef.current = loaded;
    setStrokes(loaded);
    onStrokesChange?.(loaded);
    requestAnimationFrame(renderCommitted);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clozeId, resourceId]);

  useEffect(() => {
    const flush = () => flushPendingSave();
    const whenHidden = () => {
      if (document.visibilityState === "hidden") flushPendingSave();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", whenHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", whenHidden);
      backgroundSave(flushPendingSave);
    };
  }, [flushPendingSave]);

  useLayoutEffect(() => {
    const resize = () => {
      const content = contentRef.current;
      if (!content) return;
      const width = Math.max(1, content.clientWidth || 1);
      const height = Math.max(1, content.scrollHeight || 1);
      const ratio = inkPixelRatio();
      const current = dimensionsRef.current;
      if (current.width === width && current.height === height && current.ratio === ratio) return;
      inkController.finishActiveForGeometryChange();
      dimensionsRef.current = { width, height, ratio };
      resizeInkCanvas(committedCanvasRef.current, width, height, ratio);
      resizeInkCanvas(previewCanvasRef.current, width, height, ratio);
      resizeInkCanvas(tailCanvasRef.current, width, height, ratio);
      renderCommitted();
    };
    resize();
    const observer = globalThis.ResizeObserver ? new ResizeObserver(resize) : null;
    if (contentRef.current && observer) observer.observe(contentRef.current);
    window.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [renderCommitted, inkController]);

  useLayoutEffect(() => {
    const paper = rootRef.current?.closest(".cloze-passage-pane");
    const finish = () => inkController.finishActiveForGeometryChange();
    paper?.addEventListener("reader-paper-will-layout", finish);
    return () => paper?.removeEventListener("reader-paper-will-layout", finish);
  }, [inkController]);

  useEffect(() => installPenScrollGuard({
    root: rootRef,
    ownsPointer: (pointerId) => activeRef.current?.id === pointerId,
    hasActiveSession: () => Boolean(activeRef.current),
  }), []);

  return (
    <section ref={rootRef} className="cloze-ink-surface" aria-label="完形手写笔迹">
      <div
        ref={contentRef}
        className="cloze-ink-content"
        onPointerDownCapture={inkController.handlePointerDown}
        onPointerMoveCapture={inkController.handlePointerMove}
        onPointerUpCapture={inkController.handlePointerUp}
        onPointerCancelCapture={inkController.handlePointerCancel}
        onLostPointerCapture={inkController.handlePointerUp}
      >
        {children}
        <canvas ref={committedCanvasRef} className="cloze-ink-canvas" aria-hidden="true" />
        <canvas ref={previewCanvasRef} className="cloze-ink-preview" aria-hidden="true" />
        <canvas ref={tailCanvasRef} className="ink-tail-canvas" aria-hidden="true" />
      </div>
    </section>
  );
}
