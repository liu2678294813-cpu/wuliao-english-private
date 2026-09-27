import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  normalizePenMode,
  normalizePenSize,
  PEN_MODE_STORAGE_KEY,
  PEN_SIZE_STORAGE_KEY,
} from "../../annotationTools.js";
import { getUserItem, setUserItem } from "../../userData.js";
import { AnnotationToolbar } from "../../ui/AnnotationToolbar.jsx";
import WritingInkSurface from "../WritingInkSurface.jsx";
import { useWritingStageToolbarHost } from "./WritingStageShell.jsx";

function sameIdentity(left, right) {
  return Boolean(left && right)
    && ["sessionId", "surfaceId", "stageId", "ownerRecordId"].every((key) => left[key] === right[key]);
}

export function createWritingInkFlushBridge() {
  let current = null;
  return Object.freeze({
    attach(identity, flush) {
      const entry = { identity: { ...identity }, flush };
      current = entry;
      return () => { if (current === entry) current = null; };
    },
    async flush(context = {}) {
      if (!current || typeof current.flush !== "function") throw new Error("Writing ink surface is not mounted");
      if (!sameIdentity(current.identity, context)) throw new Error("Writing ink flush target does not match the mounted surface");
      return current.flush();
    },
    getCurrentIdentity() {
      return current ? { ...current.identity } : null;
    },
  });
}

export default function WritingInkComposer({
  username,
  sessionId,
  stageId,
  ownerRecordId,
  surfaceId,
  sourceFingerprint,
  flushBridge,
  title = "手写输入",
  description = "笔迹会保存在当前写作记录中。",
  showHeading = true,
  disabled = false,
  onInkRefChange,
  pageLabel = "在这里书写",
  InkSurface = WritingInkSurface,
  Toolbar = AnnotationToolbar,
}) {
  const toolbarHost = useWritingStageToolbarHost();
  const pageRef = useRef(null);
  const pageRegions = useMemo(() => [{ pageId: "page-1", ref: pageRef }], []);
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState("#173a62");
  const [penSize, setPenSize] = useState(() => normalizePenSize(getUserItem(PEN_SIZE_STORAGE_KEY, username)));
  const [penMode] = useState(() => normalizePenMode(getUserItem(PEN_MODE_STORAGE_KEY, username)));
  const [eraserMode, setEraserMode] = useState(() => getUserItem("wuliao:pref:eraser-mode", username) || "normal");
  const [eraserSize, setEraserSize] = useState(24);
  const [toolbarApi, setToolbarApi] = useState(null);
  const [strokeCount, setStrokeCount] = useState(0);
  const [flushHandle, setFlushHandle] = useState(null);
  const [inkError, setInkError] = useState("");

  const identity = useMemo(() => ({ sessionId, surfaceId, stageId, ownerRecordId }), [ownerRecordId, sessionId, stageId, surfaceId]);

  useEffect(() => {
    if (!flushBridge || !flushHandle) return undefined;
    return flushBridge.attach(identity, flushHandle);
  }, [flushBridge, flushHandle, identity]);

  const changePenSize = useCallback((value) => {
    const next = normalizePenSize(value);
    setPenSize(next);
    setUserItem(PEN_SIZE_STORAGE_KEY, String(next), username);
  }, [username]);

  const changeEraserMode = useCallback((value) => {
    setEraserMode(value);
    setUserItem("wuliao:pref:eraser-mode", value, username);
  }, [username]);

  const handleFlushHandleChange = useCallback((handle) => {
    setFlushHandle(() => handle);
  }, []);

  const toolbar = (
    <Toolbar
      tool={tool}
      color={color}
      annotations={[]}
      canUndo={Boolean(toolbarApi?.canUndo)}
      onTool={setTool}
      onColor={setColor}
      onUndo={() => toolbarApi?.undo?.()}
      onClear={() => toolbarApi?.clear?.()}
      canClear={Boolean(toolbarApi?.canClear)}
      clearLabel="清空笔迹"
      penSize={penSize}
      onPenSize={changePenSize}
      penMode={penMode}
      eraserMode={eraserMode}
      eraserSize={eraserSize}
      onEraserMode={changeEraserMode}
      onEraserSize={setEraserSize}
      unknownEnabled={false}
      tabletInk
    />
  );

  return (
    <section className="writing-ink-composer">
      {showHeading ? <div className="writing-section-heading">
        <div><h2>{title}</h2><p>{description}</p></div>
        <span>{strokeCount ? `${strokeCount} 笔` : "空白纸"}</span>
      </div> : null}
      {!showHeading ? <span className="visually-hidden" aria-live="polite">{strokeCount ? `${strokeCount} 笔` : "空白纸"}</span> : null}
      {toolbarHost === undefined ? toolbar : toolbarHost ? createPortal(toolbar, toolbarHost) : null}
      {inkError ? <p className="writing-inline-error" role="alert">{inkError}</p> : null}
      <InkSurface
        username={username}
        sessionId={sessionId}
        surfaceId={surfaceId}
        stageId={stageId}
        ownerRecordId={ownerRecordId}
        sourceFingerprint={sourceFingerprint}
        disabled={disabled}
        tool={tool}
        color={color}
        penSize={penSize}
        penMode={penMode}
        eraserMode={eraserMode}
        eraserSize={eraserSize}
        onFlushHandleChange={handleFlushHandleChange}
        onInkRefChange={onInkRefChange}
        onToolbarApiChange={setToolbarApi}
        onStrokesCountChange={setStrokeCount}
        onError={(error) => setInkError(error?.message || "笔迹暂时无法保存")}
        pageRegions={pageRegions}
      >
        <div ref={pageRef} className="writing-paper" data-writing-page="page-1">
          <span>{pageLabel}</span>
        </div>
      </InkSurface>
    </section>
  );
}
