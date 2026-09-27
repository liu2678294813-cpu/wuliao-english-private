import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSaveBoundary } from "../useSaveBoundary.js";
import { useStructuredInk } from "../ink/useStructuredInk";
import {
  drawInkStroke,
  inkPixelRatio,
  renderInkLayer,
  resizeInkCanvas,
} from "../annotationTools";
import { installPenScrollGuard } from "../inkEngine";
import { isAndroidApp } from "../platform";
import {
  ExamInkStaleRevisionError,
  clearExamInkSnapshot,
  getExamInkSnapshot,
  saveExamInkSnapshot,
} from "./examInkStorage";

function isQuotaError(error) {
  return error?.name === "QuotaExceededError" || /quota/i.test(String(error?.message || ""));
}

function inkRefFromSnapshot(snapshot, inkStatus = "complete") {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    surfaceId: snapshot.surfaceId,
    revision: snapshot.revision,
    fingerprint: snapshot.fingerprint,
    sourceFingerprint: snapshot.sourceFingerprint,
    updatedAt: snapshot.updatedAt,
    inkStatus,
  };
}

function warningForStatus(status) {
  if (status === "source-mismatch") return "此 Text 的原文版本已变化；为避免错位，不显示旧笔迹。可清空后重新开始。";
  if (status === "damaged") return "考试笔迹记录已损坏；为避免错位，不显示旧笔迹。可清空后重新开始。";
  if (status === "quota") return "笔迹存储空间不足，已停止新增笔画。可撤销、清空后重试；答题与交卷不受影响。";
  if (status === "stale") return "笔迹已被另一运行环境更新，当前页面已停止写入。请重新加载最新考试。";
  if (status === "write-error") return "笔迹暂时无法保存，已停止新增笔画；答题与交卷不受影响。";
  return "";
}

export function examInkFlushResult(surfaceId, lastRef, { writeBlocked = false, dirty = false } = {}) {
  return {
    inkRefs: lastRef ? { [surfaceId]: lastRef } : {},
    inkStatus: writeBlocked || dirty ? "partial" : "complete",
  };
}

/**
 * Exam-level ink surface（完形 / 阅读共用同一组件与同一 Shared Ink Runtime）。
 * 与普通精读 / 普通完形使用完全相同的：pointer lifecycle、coalesced 采样、normalized 坐标、
 * direct-ink、live preview、pen-up handoff、append-only commit、长按临时橡皮、
 * normal eraser、lasso eraser、undo、clear、scroll guard、resize 处理。
 * 差异仅限：Persistence Adapter（exam-ink IndexedDB）与 Surface Identity（cloze:main / reading:text-N）。
 */
export default function ExamInkSurface({
  username,
  sessionId,
  surfaceId,
  sourceFingerprint,
  disabled = false,
  tool = "pen",
  color = "#173a62",
  penSize = 2.6,
  penMode = "ballpoint",
  eraserMode = "normal",
  eraserSize = 24,
  onFlushHandleChange,
  onInkRefChange,
  onStrokesCountChange,
  onToolbarApiChange,
  children,
}) {
  const rootRef = useRef(null);
  const contentRef = useRef(null);
  const committedCanvasRef = useRef(null);
  const previewCanvasRef = useRef(null);
  const tailCanvasRef = useRef(null);
  const activeRef = useRef(null);
  const strokesRef = useRef([]);
  const lastGoodStrokesRef = useRef([]);
  const revisionRef = useRef(0);
  const lastGoodRef = useRef(null);
  const mutationRevisionRef = useRef(0);
  const dirtySinceLastSuccessRef = useRef(false);
  const saveQueueRef = useRef(Promise.resolve());
  const writeBlockedRef = useRef(false);
  const dimensionsRef = useRef({ width: 1, height: 1, ratio: 1 });
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const penSizeRef = useRef(penSize);
  const penModeRef = useRef(penMode);
  const eraserModeRef = useRef(eraserMode);
  const eraserSizeRef = useRef(eraserSize);
  const disabledRef = useRef(disabled);
  const onInkRefChangeRef = useRef(onInkRefChange);
  const onStrokesCountChangeRef = useRef(onStrokesCountChange);
  const onFlushHandleChangeRef = useRef(onFlushHandleChange);
  const onToolbarApiChangeRef = useRef(onToolbarApiChange);
  const lastToolbarApiRef = useRef(null);
  const [strokes, setStrokes] = useState([]);
  const [storageStatus, setStorageStatus] = useState("loading");

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { penSizeRef.current = penSize; }, [penSize]);
  useEffect(() => { penModeRef.current = penMode; }, [penMode]);
  useEffect(() => { eraserModeRef.current = eraserMode; }, [eraserMode]);
  useEffect(() => { eraserSizeRef.current = eraserSize; }, [eraserSize]);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => { onInkRefChangeRef.current = onInkRefChange; });
  useEffect(() => { onStrokesCountChangeRef.current = onStrokesCountChange; });
  useEffect(() => { onFlushHandleChangeRef.current = onFlushHandleChange; });

  const publishInkRef = useCallback((snapshot, inkStatus = "complete") => {
    const next = inkRefFromSnapshot(snapshot, inkStatus);
    lastGoodStrokesRef.current = snapshot?.strokes || [];
    lastGoodRef.current = next;
    onInkRefChangeRef.current?.(next);
    return next;
  }, []);

  const reportStrokesCount = useCallback((count) => {
    onStrokesCountChangeRef.current?.(count);
  }, []);

  // 结构性重绘（初始加载 / resize / undo / clear / eraser / lasso / 历史恢复）。
  const renderCommitted = useCallback((extraStroke = null) => {
    const canvas = committedCanvasRef.current;
    const { width, height, ratio } = dimensionsRef.current;
    if (!canvas) return false;
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

  const resizeCanvases = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const rect = content.getBoundingClientRect();
    const width = Math.max(1, rect.width || content.clientWidth || 1);
    const height = Math.max(1, rect.height || content.scrollHeight || 1);
    const ratio = inkPixelRatio();
    const current = dimensionsRef.current;
    if (current.width === width && current.height === height && current.ratio === ratio) return;
    inkController.finishActiveForGeometryChange();
    dimensionsRef.current = { width, height, ratio };
    resizeInkCanvas(committedCanvasRef.current, width, height, ratio);
    resizeInkCanvas(previewCanvasRef.current, width, height, ratio);
    resizeInkCanvas(tailCanvasRef.current, width, height, ratio);
    renderCommitted();
  }, [renderCommitted]);

  const blockWrites = useCallback((error) => {
    writeBlockedRef.current = true;
    if (error instanceof ExamInkStaleRevisionError || error?.code === "stale-revision") setStorageStatus("stale");
    else if (isQuotaError(error)) setStorageStatus("quota");
    else setStorageStatus("write-error");
  }, []);

  const enqueueSave = useCallback((nextStrokes, { force = false, mutationRevision = mutationRevisionRef.current } = {}) => {
    const task = saveQueueRef.current.then(async () => {
      if (writeBlockedRef.current && !force) return lastGoodRef.current;
      if (force) writeBlockedRef.current = false;
      try {
        const saved = await saveExamInkSnapshot({
          username,
          sessionId,
          surfaceId,
          sourceFingerprint,
          strokes: nextStrokes,
          expectedRevision: revisionRef.current,
        });
        revisionRef.current = saved.revision;
        if (mutationRevisionRef.current === mutationRevision) dirtySinceLastSuccessRef.current = false;
        setStorageStatus("ok");
        return publishInkRef(saved);
      } catch (error) {
        blockWrites(error);
        return lastGoodRef.current;
      }
    });
    saveQueueRef.current = task;
    return task;
  }, [blockWrites, publishInkRef, sessionId, sourceFingerprint, surfaceId, username]);

  const persistStrokes = useCallback((next, { skipTileRedraw = false } = {}) => {
    mutationRevisionRef.current += 1;
    dirtySinceLastSuccessRef.current = true;
    const mutationRevision = mutationRevisionRef.current;
    strokesRef.current = next;
    startTransition(() => { setStrokes(next); reportStrokesCount(next.length); });
    // 普通新增笔画已在 Shared Runtime 中 append-only 提交，跳过重复的结构性重绘。
    if (!skipTileRedraw) renderCommitted();
    return enqueueSave(next, { mutationRevision });
  }, [enqueueSave, renderCommitted, reportStrokesCount]);

  const inkController = useStructuredInk({
    canInteract: () => !disabledRef.current && !writeBlockedRef.current && storageStatus !== "loading",
    surfaceRef: contentRef,
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
  });

  const flush = useCallback(async () => {
    // A timeout may arrive while a stylus is still down. Preserve the sampled
    // portion of that stroke before waiting for serial IDB writes.
    if (activeRef.current) {
      // 与正式 pen-up 走同一条 Shared Runtime 收尾管线（append-only / preview 清理 / telemetry）。
      inkController.handlePointerUp({
        pointerId: activeRef.current.id,
        pointerType: activeRef.current.pointerType,
        type: "pointercancel",
        target: contentRef.current,
        nativeEvent: { pointerId: activeRef.current.id, pointerType: activeRef.current.pointerType },
      });
    }
    await saveQueueRef.current;
    return examInkFlushResult(surfaceId, lastGoodRef.current, {
      writeBlocked: writeBlockedRef.current,
      dirty: dirtySinceLastSuccessRef.current,
    });
  }, [inkController, surfaceId]);

  useSaveBoundary(async () => {
    if (dirtySinceLastSuccessRef.current && ["quota", "write-error"].includes(storageStatus)) {
      await enqueueSave(strokesRef.current, { force: true });
    }
    await flush();
    if (dirtySinceLastSuccessRef.current) {
      throw new Error("考试笔迹尚未保存，请在当前页重试保存");
    }
  });
  useEffect(() => { onToolbarApiChangeRef.current = onToolbarApiChange; });

  useEffect(() => {
    onFlushHandleChangeRef.current?.(flush);
    return () => onFlushHandleChangeRef.current?.(null);
  }, [flush, onFlushHandleChange]);

  useEffect(() => {
    let cancelled = false;
    activeRef.current = null;
    strokesRef.current = [];
    revisionRef.current = 0;
    lastGoodRef.current = null;
    lastGoodStrokesRef.current = [];
    mutationRevisionRef.current = 0;
    dirtySinceLastSuccessRef.current = false;
    writeBlockedRef.current = false;
    setStrokes([]);
    reportStrokesCount(0);
    setStorageStatus("loading");
    inkController.clearPreview();
    renderCommitted();
    getExamInkSnapshot({ username, sessionId, surfaceId, expectedSourceFingerprint: sourceFingerprint })
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.status === "ok") {
          strokesRef.current = loaded.snapshot.strokes;
          lastGoodStrokesRef.current = loaded.snapshot.strokes;
          revisionRef.current = loaded.snapshot.revision;
          setStrokes(loaded.snapshot.strokes);
          reportStrokesCount(loaded.snapshot.strokes.length);
          publishInkRef(loaded.snapshot);
          setStorageStatus("ok");
          requestAnimationFrame(renderCommitted);
          return;
        }
        if (loaded.status === "missing") {
          onInkRefChangeRef.current?.(null);
          setStorageStatus("missing");
          return;
        }
        writeBlockedRef.current = true;
        revisionRef.current = loaded.revision || 0;
        onInkRefChangeRef.current?.(null);
        setStorageStatus(loaded.status);
      })
      .catch((error) => {
        if (!cancelled) blockWrites(error);
      });
    return () => {
      cancelled = true;
      flush().catch(() => {});
    };
  }, [blockWrites, flush, inkController, publishInkRef, renderCommitted, sessionId, sourceFingerprint, surfaceId, username]);

  useLayoutEffect(() => {
    resizeCanvases();
    const content = contentRef.current;
    const observer = globalThis.ResizeObserver ? new ResizeObserver(resizeCanvases) : null;
    if (content && observer) observer.observe(content);
    window.addEventListener("resize", resizeCanvases);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resizeCanvases);
    };
  }, [resizeCanvases]);

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

  const undo = useCallback(() => {
    if (disabled || !strokesRef.current.length) return;
    persistStrokes(strokesRef.current.slice(0, -1), { force: true });
  }, [disabled, persistStrokes]);

  const clear = useCallback(() => {
    const replacingUnreadable = storageStatus === "source-mismatch" || storageStatus === "damaged";
    const message = replacingUnreadable
      ? "原笔迹无法安全叠加。确认清空并用当前 Text 重新开始吗？这会覆盖该 Text 的旧考试笔迹。"
      : "清空当前 Text 的考试笔迹？此操作只影响本次考试笔迹。";
    if (disabled || !window.confirm(message)) return;
    inkController.clearPreview();
    mutationRevisionRef.current += 1;
    const mutationRevision = mutationRevisionRef.current;
    dirtySinceLastSuccessRef.current = true;
    strokesRef.current = [];
    setStrokes([]);
    reportStrokesCount(0);
    renderCommitted();
    const task = saveQueueRef.current.then(async () => {
      writeBlockedRef.current = false;
      try {
        const saved = await clearExamInkSnapshot({
          username,
          sessionId,
          surfaceId,
          sourceFingerprint,
          expectedRevision: revisionRef.current || null,
        });
        revisionRef.current = saved.revision;
        if (mutationRevisionRef.current === mutationRevision) dirtySinceLastSuccessRef.current = false;
        setStorageStatus("ok");
        return publishInkRef(saved);
      } catch (error) {
        if (mutationRevisionRef.current === mutationRevision) {
          strokesRef.current = lastGoodStrokesRef.current;
          setStrokes(lastGoodStrokesRef.current);
          reportStrokesCount(lastGoodStrokesRef.current.length);
          renderCommitted();
          dirtySinceLastSuccessRef.current = false;
        }
        blockWrites(error);
        return lastGoodRef.current;
      }
    });
    saveQueueRef.current = task;
  }, [blockWrites, disabled, inkController, publishInkRef, renderCommitted, reportStrokesCount, sessionId, sourceFingerprint, storageStatus, surfaceId, username]);

  useEffect(() => {
    const canClear = strokes.length > 0 || storageStatus === "source-mismatch" || storageStatus === "damaged";
    const next = { undo, clear, canClear };
    const previous = lastToolbarApiRef.current;
    if (!previous || previous.undo !== undo || previous.clear !== clear || previous.canClear !== canClear) {
      lastToolbarApiRef.current = next;
      onToolbarApiChangeRef.current?.(next);
    }
    return () => {
      lastToolbarApiRef.current = null;
      onToolbarApiChangeRef.current?.(null);
    };
  }, [clear, storageStatus, strokes.length, undo]);

  const warning = warningForStatus(storageStatus);
  return (
    <section ref={rootRef} className={`exam-ink-surface ${disabled ? "is-disabled" : ""}`} aria-label="考试笔迹">
      {warning && <p className="exam-ink-warning" role="status">{warning}</p>}
      <div
        ref={contentRef}
        className="exam-ink-content"
        onPointerDownCapture={inkController.handlePointerDown}
        onPointerMoveCapture={inkController.handlePointerMove}
        onPointerUpCapture={inkController.handlePointerUp}
        onPointerCancelCapture={inkController.handlePointerCancel}
        onLostPointerCapture={inkController.handlePointerUp}
      >
        {children}
        <canvas ref={committedCanvasRef} className="exam-ink-canvas" aria-hidden="true" />
        <canvas ref={previewCanvasRef} className="exam-ink-preview" aria-hidden="true" />
        <canvas ref={tailCanvasRef} className="ink-tail-canvas" aria-hidden="true" />
      </div>
    </section>
  );
}

export { inkRefFromSnapshot, warningForStatus };
