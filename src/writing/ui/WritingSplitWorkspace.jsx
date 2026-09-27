import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getUserItem, setUserItem } from "../../userData.js";

export const WRITING_SPLIT_RATIO_STORAGE_KEY = "wuliao:pref:writing-split-ratio:v1";
export const WRITING_STACKED_RATIO_STORAGE_KEY = "wuliao:pref:writing-stacked-ratio:v1";
export const WRITING_SPLIT_LONG_PRESS_MS = 350;
export const WRITING_SPLIT_CANCEL_DISTANCE_PX = 8;

const DEFAULT_SPLIT_RATIO = 0.4;
const DEFAULT_STACKED_RATIO = 0.5;

function storedRatio(key, username, fallback) {
  const parsed = Number.parseFloat(getUserItem(key, username));
  return Number.isFinite(parsed) && parsed > 0.1 && parsed < 0.9 ? parsed : fallback;
}

function clampRatio(rawRatio, availableSize, minimumPixels) {
  if (!Number.isFinite(rawRatio) || availableSize <= 0) return 0.5;
  const dynamicMinimum = Math.min(minimumPixels, availableSize * 0.35);
  const minimumRatio = Math.max(0.25, dynamicMinimum / availableSize);
  return Math.min(1 - minimumRatio, Math.max(minimumRatio, rawRatio));
}

export default function WritingSplitWorkspace({
  stage,
  username,
  sourceLabel,
  sourceHint,
  sourcePane,
  workLabel,
  workHint,
  workActions,
  workPane,
  layout = "split",
}) {
  const rootRef = useRef(null);
  const sourceScrollRef = useRef(null);
  const workScrollRef = useRef(null);
  const gestureRef = useRef(null);
  const gestureFrameRef = useRef(0);
  const detachGestureListenersRef = useRef(() => {});
  const [inkDocumentHeight, setInkDocumentHeight] = useState(430);
  const [splitRatio, setSplitRatio] = useState(() => storedRatio(WRITING_SPLIT_RATIO_STORAGE_KEY, username, DEFAULT_SPLIT_RATIO));
  const [stackedRatio, setStackedRatio] = useState(() => storedRatio(WRITING_STACKED_RATIO_STORAGE_KEY, username, DEFAULT_STACKED_RATIO));
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    setSplitRatio(storedRatio(WRITING_SPLIT_RATIO_STORAGE_KEY, username, DEFAULT_SPLIT_RATIO));
    setStackedRatio(storedRatio(WRITING_STACKED_RATIO_STORAGE_KEY, username, DEFAULT_STACKED_RATIO));
  }, [username]);

  useLayoutEffect(() => {
    const sourceScroll = sourceScrollRef.current;
    const workScroll = workScrollRef.current;
    if (!sourceScroll || !workScroll) return undefined;
    let active = true;

    const measure = () => {
      if (!active) return;
      const sourceContent = sourceScroll.firstElementChild;
      const sourceStyle = sourceScroll.ownerDocument.defaultView.getComputedStyle(sourceScroll);
      const sourcePadding = (Number.parseFloat(sourceStyle.paddingTop) || 0)
        + (Number.parseFloat(sourceStyle.paddingBottom) || 0);
      const sourceContentHeight = Math.max(
        sourceContent?.scrollHeight || 0,
        sourceContent?.getBoundingClientRect().height || 0,
      ) + sourcePadding;
      const workViewportHeight = workScroll.clientHeight;
      const next = Math.ceil(Math.max(sourceContentHeight * 2, workViewportHeight, 1));
      setInkDocumentHeight((current) => Math.abs(current - next) > 1 ? next : current);
    };

    measure();
    const resizeObserver = globalThis.ResizeObserver ? new ResizeObserver(measure) : null;
    resizeObserver?.observe(sourceScroll);
    resizeObserver?.observe(workScroll);
    if (sourceScroll.firstElementChild) resizeObserver?.observe(sourceScroll.firstElementChild);
    const mutationObserver = globalThis.MutationObserver ? new MutationObserver(measure) : null;
    mutationObserver?.observe(workScroll, { childList: true, subtree: true });
    document.fonts?.ready?.then(measure).catch(() => {});
    window.addEventListener("resize", measure);
    return () => {
      active = false;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const finishGesture = useCallback((event, { cancelled = false } = {}) => {
    const gesture = gestureRef.current;
    if (!gesture || (event?.pointerId !== undefined && event.pointerId !== gesture.pointerId)) return;
    if (gesture.timer) window.clearTimeout(gesture.timer);
    if (gestureFrameRef.current) {
      window.cancelAnimationFrame(gestureFrameRef.current);
      gestureFrameRef.current = 0;
    }
    detachGestureListenersRef.current();
    detachGestureListenersRef.current = () => {};
    if (gesture.active) {
      try {
        gesture.target.releasePointerCapture?.(gesture.pointerId);
      } catch {
        // A cancelled WebView pointer may already have released capture.
      }
      const finalRatio = cancelled ? gesture.initialRatio : gesture.ratio;
      const root = rootRef.current;
      if (gesture.layout === "split") {
        root?.style.setProperty("--writing-split-source-fr", `${finalRatio * 100}fr`);
        root?.style.setProperty("--writing-split-work-fr", `${(1 - finalRatio) * 100}fr`);
        setSplitRatio(finalRatio);
      } else {
        root?.style.setProperty("--writing-stacked-source-fr", `${finalRatio * 100}fr`);
        root?.style.setProperty("--writing-stacked-work-fr", `${(1 - finalRatio) * 100}fr`);
        setStackedRatio(finalRatio);
      }
      if (!cancelled) {
        const key = gesture.layout === "split" ? WRITING_SPLIT_RATIO_STORAGE_KEY : WRITING_STACKED_RATIO_STORAGE_KEY;
        setUserItem(key, String(finalRatio), username);
      }
    }
    gestureRef.current = null;
    setResizing(false);
  }, [username]);

  const moveGesture = useCallback((event) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (!gesture.active) {
      if (distance > WRITING_SPLIT_CANCEL_DISTANCE_PX) finishGesture(event, { cancelled: true });
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    let next;
    if (gesture.layout === "split") {
      next = clampRatio((event.clientX - rect.left) / rect.width, rect.width, 220);
    } else {
      const sourceHeaderHeight = sourceScrollRef.current?.previousElementSibling?.getBoundingClientRect().height || 0;
      const workHeaderHeight = workScrollRef.current?.previousElementSibling?.getBoundingClientRect().height || 0;
      const availableHeight = Math.max(1, rect.height - sourceHeaderHeight - workHeaderHeight);
      next = clampRatio((event.clientY - rect.top - sourceHeaderHeight) / availableHeight, availableHeight, 140);
    }
    gesture.ratio = next;
    if (!gestureFrameRef.current) {
      gestureFrameRef.current = window.requestAnimationFrame(() => {
        gestureFrameRef.current = 0;
        const currentGesture = gestureRef.current;
        const currentRoot = rootRef.current;
        if (!currentGesture?.active || !currentRoot) return;
        const renderedRatio = currentGesture.ratio;
        if (currentGesture.layout === "split") {
          currentRoot.style.setProperty("--writing-split-source-fr", `${renderedRatio * 100}fr`);
          currentRoot.style.setProperty("--writing-split-work-fr", `${(1 - renderedRatio) * 100}fr`);
        } else {
          currentRoot.style.setProperty("--writing-stacked-source-fr", `${renderedRatio * 100}fr`);
          currentRoot.style.setProperty("--writing-stacked-work-fr", `${(1 - renderedRatio) * 100}fr`);
        }
      });
    }
    event.preventDefault();
    event.stopPropagation();
  }, [finishGesture]);

  const beginGesture = useCallback((event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const initialRatio = layout === "split" ? splitRatio : stackedRatio;
    const target = event.currentTarget;
    const ownerDocument = target.ownerDocument;
    const gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      initialRatio,
      ratio: initialRatio,
      layout,
      target,
      active: false,
      timer: null,
    };
    gesture.timer = window.setTimeout(() => {
      if (gestureRef.current !== gesture) return;
      gesture.active = true;
      setResizing(true);
      try {
        target.setPointerCapture?.(gesture.pointerId);
      } catch {
        // Android WebView can reject capture; document listeners remain the fallback.
      }
    }, WRITING_SPLIT_LONG_PRESS_MS);
    const onEnd = (pointerEvent) => finishGesture(pointerEvent);
    const onCancel = (pointerEvent) => finishGesture(pointerEvent, { cancelled: true });
    ownerDocument.addEventListener("pointermove", moveGesture, { passive: false });
    ownerDocument.addEventListener("pointerup", onEnd);
    ownerDocument.addEventListener("pointercancel", onCancel);
    detachGestureListenersRef.current = () => {
      ownerDocument.removeEventListener("pointermove", moveGesture);
      ownerDocument.removeEventListener("pointerup", onEnd);
      ownerDocument.removeEventListener("pointercancel", onCancel);
    };
    gestureRef.current = gesture;
  }, [finishGesture, layout, moveGesture, splitRatio, stackedRatio]);

  useEffect(() => () => {
    const gesture = gestureRef.current;
    if (gesture?.timer) window.clearTimeout(gesture.timer);
    if (gestureFrameRef.current) window.cancelAnimationFrame(gestureFrameRef.current);
    detachGestureListenersRef.current();
    gestureRef.current = null;
  }, []);

  const ratio = layout === "split" ? splitRatio : stackedRatio;
  return (
    <section
      ref={rootRef}
      className={`writing-split-workspace is-${layout} ${resizing ? "is-resizing" : ""}`.trim()}
      data-writing-stage={stage}
      data-writing-layout={layout}
      data-split-ratio={splitRatio.toFixed(4)}
      data-stacked-ratio={stackedRatio.toFixed(4)}
      style={{
        "--writing-ink-document-height": `${inkDocumentHeight}px`,
        "--writing-split-source-fr": `${splitRatio * 100}fr`,
        "--writing-split-work-fr": `${(1 - splitRatio) * 100}fr`,
        "--writing-stacked-source-fr": `${stackedRatio * 100}fr`,
        "--writing-stacked-work-fr": `${(1 - stackedRatio) * 100}fr`,
      }}
    >
      <section className="writing-split-pane writing-split-source" aria-label={sourceLabel}>
        <header><div className="writing-split-header-copy"><h2>{sourceLabel}</h2>{sourceHint ? <p>{sourceHint}</p> : null}</div></header>
        <div ref={sourceScrollRef} className="writing-split-scroll">{sourcePane}</div>
      </section>
      <div
        className="writing-split-divider"
        role="separator"
        aria-label="长按调整展示区和书写区大小"
        aria-orientation={layout === "split" ? "vertical" : "horizontal"}
        aria-valuemin={25}
        aria-valuemax={75}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={beginGesture}
      ><span aria-hidden="true" /></div>
      <section className="writing-split-pane writing-split-work" aria-label={workLabel}>
        <header>
          <div className="writing-split-header-copy"><h2>{workLabel}</h2>{workHint ? <p>{workHint}</p> : null}</div>
          {workActions ? <div className="writing-split-header-actions">{workActions}</div> : null}
        </header>
        <div ref={workScrollRef} className="writing-split-scroll">{workPane}</div>
      </section>
    </section>
  );
}
