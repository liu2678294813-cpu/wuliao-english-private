import { useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { readProgress, saveProgress } from "./library";
import { extractQuestions } from "./questions";
import {
  coalescedPointerPoints,
  eraseAnnotationsInPolygon,
  inkPixelRatio,
  normalizePenMode,
  normalizePenSize,
  PEN_MODE_STORAGE_KEY,
  PEN_SIZE_STORAGE_KEY,
  pointerPointFromSample,
  renderInkLayer,
  resizeInkCanvas,
} from "./annotationTools";
import { isAndroidApp } from "./platform";
import { getUserItem, setUserItem } from "./userData";

GlobalWorkerOptions.workerSrc = workerUrl;

const annotationKey = (resourceId, page) => `wuliao:ink:${resourceId}:${page}`;
const answerKey = (resourceId) => `wuliao:answers:${resourceId}`;

function loadJson(key, fallback) {
  try { return JSON.parse(getUserItem(key)) || fallback; } catch { return fallback; }
}

function stageForPage(page, total) {
  if (page === 1) return "导读";
  if (page === 2) return "审题";
  if (page === 3) return "限时读文";
  if (page === 4) return "第一次作答";
  if (page >= 5 && page <= Math.max(5, total - 3)) return "逐段精读";
  if (page === total - 2) return "正式重做";
  if (page === total - 1) return "复读";
  return "全文压缩";
}

function StageNavigation({ page, total, onNavigate }) {
  const stages = [
    ["导读", 1], ["审题", 2], ["限时读文", 3], ["初做", 4], ["逐段精读", 5],
    ["重做", Math.max(5, total - 2)], ["复读", Math.max(6, total - 1)], ["压缩", total],
  ];
  const active = stageForPage(page, total);
  return (
    <nav className="stage-nav" aria-label="精读流程">
      {stages.map(([label, target], index) => (
        <button key={`${label}-${index}`} className={active.includes(label) || (active === "第一次作答" && label === "初做") || (active === "正式重做" && label === "重做") || (active === "全文压缩" && label === "压缩") ? "active" : ""} onClick={() => onNavigate(target)}>
          <span>{index + 1}</span>{label}
        </button>
      ))}
    </nav>
  );
}

export function QuestionDrawer({
  open,
  onClose,
  questions,
  parseInfo,
  answers,
  onAnswer,
  correctAnswers = {},
  correctionVisible = false,
  onToggleCorrection,
}) {
  const [expanded, setExpanded] = useState(null);
  useEffect(() => {
    if (questions.length && !questions.some((question) => question.number === expanded)) {
      setExpanded(questions[0].number);
    }
  }, [questions, expanded]);

  return (
    <aside className={`question-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="drawer-header">
        <div><small>QUESTION PANEL</small><h2>悬浮习题窗</h2></div>
        <div className="drawer-header-actions">
          {questions.length > 0 && onToggleCorrection && <button className={`correction-button ${correctionVisible ? "active" : ""}`} onClick={onToggleCorrection}>{correctionVisible ? "隐藏订正" : "订正"}</button>}
          <button className="icon-button" onClick={onClose} aria-label="关闭题窗">×</button>
        </div>
      </div>
      <div className="parse-status">
        <span className={parseInfo.status} />
        {parseInfo.status === "loading" && "正在本地识别题目…"}
        {parseInfo.status === "ready" && `已离线识别 ${questions.length} 道题`}
        {parseInfo.status === "text-only" && "已读取文字，未发现标准选择题"}
        {parseInfo.status === "scanned" && "扫描件无文字层，可阅读批注，暂不自动识题"}
      </div>
      <div className="question-list">
        {questions.map((question) => {
          const isExpanded = expanded === question.number;
          return (
            <section className={`question-item ${isExpanded ? "expanded" : ""}`} key={question.number}>
              <button className="question-stem" onClick={() => setExpanded(isExpanded ? null : question.number)}>
                <span>{question.number}</span><strong>{question.stem}</strong><i>{isExpanded ? "−" : "+"}</i>
              </button>
              {isExpanded && (
                <div className="question-options">
                  {question.options.map((option) => (
                    <button key={option.key} className={[
                      answers[question.number] === option.key ? "selected" : "",
                      correctionVisible && correctAnswers[question.number] === option.key ? "correct" : "",
                    ].filter(Boolean).join(" ")} onClick={() => onAnswer(question.number, option.key)}>
                      <span>{option.key}</span><p>{option.text}</p>
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {parseInfo.status !== "loading" && !questions.length && (
          <div className="drawer-empty"><strong>没有可展开的题目</strong><p>你仍可在 PDF 页面上直接书写。带文本层且使用 [A]–[D] 格式的题目会自动显示在这里。</p></div>
        )}
      </div>
    </aside>
  );
}

export function AnnotationToolbar({
  tool,
  color,
  annotations,
  onTool,
  onColor,
  onUndo,
  onClear,
  noteMode,
  onToggleNoteMode,
  penSize = 2.6,
  penMode = "ballpoint",
  eraserMode = "normal",
  eraserSize = 24,
  onEraserMode,
  onEraserSize,
  collapsible = false,
  onCollapsedChange,
  unknownEnabled = false,
  tabletInk = false,
}) {
  const [collapsed, setCollapsed] = useState(false);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    onCollapsedChange?.(next);
  }

  return (
    <div className={`annotation-toolbar ${collapsible && collapsed ? "collapsed" : ""} ${tabletInk ? "tablet-ink-toolbar" : ""}`} aria-label="批注工具">
      {collapsible && (
        <button
          type="button"
          className="toolbar-collapse-toggle"
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          {collapsed ? "⌄ 展开工具" : "⌃ 收起工具"}
        </button>
      )}
      {onToggleNoteMode && (
        <div className="input-mode-picker" aria-label="输入方式">
          <button className={!noteMode ? "active" : ""} onClick={() => { if (noteMode) onToggleNoteMode(); }}>⌨ 键盘输入</button>
          <button className={noteMode ? "active" : ""} onClick={() => { if (!noteMode) onToggleNoteMode(); }}>✍ 手写批注</button>
        </div>
      )}
      <button className={tool === "pen" && (noteMode ?? true) ? "active" : ""} onClick={() => onTool("pen")}><span>✎</span>笔</button>
      <button className={tool === "eraser" && (noteMode ?? true) ? "active" : ""} onClick={() => onTool("eraser")}><span>◇</span>橡皮</button>
      {unknownEnabled && <button className={tool === "unknown" && (noteMode ?? true) ? "active" : ""} onClick={() => onTool("unknown")}><span>词</span>陌生词</button>}
      {tool === "pen" && (
        <>
          {tabletInk && (
            <div className="tool-mode-picker" aria-label="画笔模式">
              <button className={penMode === "fountain" ? "active" : ""} onClick={() => onPenMode?.("fountain")}>钢笔</button>
              <button className={penMode === "ballpoint" ? "active" : ""} onClick={() => onPenMode?.("ballpoint")}>圆珠笔</button>
            </div>
          )}
          <label className="tool-size-control">粗细
            <input type="range" min="1" max="10" step="0.5" value={penSize} onChange={(event) => onPenSize?.(Number(event.target.value))} aria-label="画笔粗细" />
            <output>{penSize}</output>
          </label>
          <div className="color-picker" aria-label="笔迹颜色">
            {["#173a62", "#0b7b77", "#e26f51"].map((value) => (
              <button key={value} className={color === value ? "active" : ""} style={{ backgroundColor: value }} onClick={() => onColor(value)} aria-label={`选择颜色 ${value}`} />
            ))}
          </div>
        </>
      )}
      {tool === "eraser" && (
        <>
          <div className="tool-mode-picker" aria-label="橡皮模式">
            <button className={eraserMode === "normal" ? "active" : ""} onClick={() => onEraserMode?.("normal")}>普通</button>
            <button className={eraserMode === "lasso" ? "active" : ""} onClick={() => onEraserMode?.("lasso")}>自由套索</button>
          </div>
          {eraserMode === "normal" && (
            <label className="tool-size-control">大小
              <input type="range" min="10" max="54" step="2" value={eraserSize} onChange={(event) => onEraserSize?.(Number(event.target.value))} aria-label="普通橡皮大小" />
              <output>{eraserSize}</output>
            </label>
          )}
        </>
      )}
      <span className="toolbar-divider" />
      <button onClick={onUndo} disabled={!annotations.length}>↶ 撤销</button>
      <button onClick={onClear} disabled={!annotations.length}>清空本页</button>
      <small>{!noteMode ? "键盘输入模式：横线文本框接收文字" : tool === "unknown" ? "用笔点按或划过英文单词，自动加入陌生词库" : tool === "eraser" && eraserMode === "lasso" ? "虚线随笔尖移动，松笔后删除真实圈选范围" : tool === "pen" && penMode === "fountain" ? "钢笔直接跟随笔尖并保留笔压；长按临时橡皮" : tool === "pen" ? "圆珠笔直接跟随笔尖并保持固定粗细；长按临时橡皮" : "普通橡皮；手指仍可上下滑动"}</small>
    </div>
  );
}

export default function PdfReader({ resource, onClose }) {
  const androidApp = isAndroidApp();
  const [pdfDocument, setPdfDocument] = useState(null);
  const [page, setPage] = useState(() => Math.max(1, readProgress(resource.id)?.page || 1));
  const [total, setTotal] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [containerWidth, setContainerWidth] = useState(900);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0, ratio: 1, inkRatio: 1 });
  const [noteMode, setNoteMode] = useState(() => androidApp);
  const [tool, setTool] = useState("pen");
  const [penSize, setPenSize] = useState(() => normalizePenSize(getUserItem(PEN_SIZE_STORAGE_KEY)));
  const [penMode, setPenMode] = useState(() => normalizePenMode(getUserItem(PEN_MODE_STORAGE_KEY)));
  const [eraserMode, setEraserMode] = useState(() => getUserItem("wuliao:pref:eraser-mode") || "normal");
  const [eraserSize, setEraserSize] = useState(24);
  const [color, setColor] = useState("#173a62");
  const [annotations, setAnnotations] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [parseInfo, setParseInfo] = useState({ status: "loading" });
  const [answers, setAnswers] = useState(() => loadJson(answerKey(resource.id), {}));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hint, setHint] = useState("");
  const [topAreaCollapsed, setTopAreaCollapsed] = useState(false);

  const containerRef = useRef(null);
  const stackRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const inkCanvasRef = useRef(null);
  const inkPreviewCanvasRef = useRef(null);
  const previewRenderFrameRef = useRef(null);
  const pendingPreviewStrokeRef = useRef(null);
  const activePointerRef = useRef(null);
  const touchScrollRef = useRef(null);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const penSizeRef = useRef(penSize);
  const penModeRef = useRef(penMode);
  const eraserModeRef = useRef(eraserMode);
  const eraserSizeRef = useRef(eraserSize);
  const annotationsRef = useRef(annotations);
  const pendingAnnotationSaveRef = useRef(null);
  const annotationSaveTimerRef = useRef(null);

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { penSizeRef.current = penSize; }, [penSize]);
  useEffect(() => { penModeRef.current = penMode; }, [penMode]);
  useEffect(() => { eraserModeRef.current = eraserMode; }, [eraserMode]);
  useEffect(() => { eraserSizeRef.current = eraserSize; }, [eraserSize]);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  useEffect(() => {
    if (noteMode && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [noteMode]);

  useEffect(() => {
    const flushOnHide = () => flushPendingAnnotationSave();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushPendingAnnotationSave();
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      flushPendingAnnotationSave();
    };
  }, []);

  useEffect(() => () => {
    if (previewRenderFrameRef.current) window.cancelAnimationFrame(previewRenderFrameRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let task = null;
    const sourceUrl = new URL(resource.source, window.location.href).href;
    const pdfAssetBase = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
    setLoading(true);
    setError("");
    (async () => {
      const response = await fetch(sourceUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`PDF 文件读取失败（${response.status}）`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (cancelled) return;
      task = getDocument({
        data,
        cMapUrl: `${pdfAssetBase}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${pdfAssetBase}standard_fonts/`,
      });
      const document = await task.promise;
      if (cancelled) return;
      setPdfDocument(document);
      setTotal(document.numPages);
      setLoading(false);
      try {
        const result = await extractQuestions(document);
        if (cancelled) return;
        setQuestions(result.questions);
        setParseInfo({
          status: result.questions.length ? "ready" : result.textCharacters < 80 ? "scanned" : "text-only",
        });
      } catch {
        if (!cancelled) setParseInfo({ status: "text-only" });
      }
    })().catch((reason) => {
      if (cancelled) return;
      setError(reason?.message || "PDF 无法打开");
      setLoading(false);
    });
    return () => {
      cancelled = true;
      task?.destroy();
    };
  }, [resource.source]);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdfDocument) return undefined;
    let cancelled = false;
    let renderTask = null;
    (async () => {
      const pdfPage = await pdfDocument.getPage(page);
      if (cancelled) return;
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const displayWidth = Math.max(280, Math.min(1040, containerWidth - 32));
      const viewport = pdfPage.getViewport({ scale: displayWidth / baseViewport.width });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const inkRatio = inkPixelRatio();
      const canvas = pdfCanvasRef.current;
      const inkCanvas = inkCanvasRef.current;
      const inkPreviewCanvas = inkPreviewCanvasRef.current;
      const stack = stackRef.current;
      if (!canvas || !inkCanvas || !inkPreviewCanvas || !stack) return;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      resizeInkCanvas(inkCanvas, viewport.width, viewport.height, inkRatio);
      resizeInkCanvas(inkPreviewCanvas, viewport.width, viewport.height, inkRatio);
      stack.style.width = canvas.style.width;
      stack.style.height = canvas.style.height;
      const context = canvas.getContext("2d", { alpha: false });
      renderTask = pdfPage.render({
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      });
      await renderTask.promise;
      if (!cancelled) setCanvasSize({ width: viewport.width, height: viewport.height, ratio, inkRatio });
    })().catch((reason) => {
      if (reason?.name !== "RenderingCancelledException" && !cancelled) setError("这一页渲染失败，请重试");
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDocument, page, containerWidth]);

  useEffect(() => {
    flushPendingAnnotationSave();
    const next = loadJson(annotationKey(resource.id, page), []);
    annotationsRef.current = next;
    setAnnotations(next);
  }, [resource.id, page]);

  useEffect(() => {
    const canvas = inkCanvasRef.current;
    if (!canvas || !canvasSize.width) return;
    renderInkLayer(canvas, annotations, canvasSize.width, canvasSize.height, canvasSize.inkRatio);
  }, [annotations, canvasSize]);

  useEffect(() => {
    if (pdfDocument) saveProgress(resource, page, total);
  }, [resource, page, total, pdfDocument]);

  const stage = useMemo(() => stageForPage(page, total), [page, total]);

  function navigate(nextPage) {
    setPage(Math.max(1, Math.min(total, nextPage)));
    containerRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setAndPersistAnnotations(updater) {
    const next = typeof updater === "function" ? updater(annotationsRef.current) : updater;
    annotationsRef.current = next;
    setAnnotations(next);
    pendingAnnotationSaveRef.current = {
      key: annotationKey(resource.id, page),
      annotations: next,
    };
    if (annotationSaveTimerRef.current) window.clearTimeout(annotationSaveTimerRef.current);
    annotationSaveTimerRef.current = window.setTimeout(flushPendingAnnotationSave, 300);
  }

  function flushPendingAnnotationSave() {
    if (annotationSaveTimerRef.current) window.clearTimeout(annotationSaveTimerRef.current);
    annotationSaveTimerRef.current = null;
    const pending = pendingAnnotationSaveRef.current;
    if (!pending) return;
    setUserItem(pending.key, JSON.stringify(pending.annotations));
    pendingAnnotationSaveRef.current = null;
  }

  function pointFromEvent(event) {
    return pointerPointFromSample(event, inkCanvasRef.current.getBoundingClientRect(), event.pointerType === "pen");
  }

  function coalescedPointsFromEvent(event) {
    return coalescedPointerPoints(event, inkCanvasRef.current.getBoundingClientRect());
  }

  function clearInkPreview() {
    if (previewRenderFrameRef.current) window.cancelAnimationFrame(previewRenderFrameRef.current);
    previewRenderFrameRef.current = null;
    pendingPreviewStrokeRef.current = null;
    const canvas = inkPreviewCanvasRef.current;
    if (canvas) renderInkLayer(canvas, [], canvasSize.width, canvasSize.height, canvasSize.inkRatio);
  }

  function renderInkPreview(stroke) {
    pendingPreviewStrokeRef.current = stroke;
    if (previewRenderFrameRef.current) return;
    previewRenderFrameRef.current = window.requestAnimationFrame(() => {
      previewRenderFrameRef.current = null;
      const canvas = inkPreviewCanvasRef.current;
      const pending = pendingPreviewStrokeRef.current;
      pendingPreviewStrokeRef.current = null;
      if (!canvas || !canvasSize.width || !pending) return;
      renderInkLayer(canvas, [pending], canvasSize.width, canvasSize.height, canvasSize.inkRatio);
    });
  }

  function renderEraserPreview(stroke) {
    const canvas = inkCanvasRef.current;
    if (!canvas || !canvasSize.width) return;
    renderInkLayer(canvas, [...annotationsRef.current, stroke], canvasSize.width, canvasSize.height, canvasSize.inkRatio);
  }

  function capturePointer(event) {
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Some Android WebView interruptions reject capture; drawing can continue without it.
    }
  }

  function handlePointerDown(event) {
    if (!noteMode) return;
    if (event.pointerType === "touch") {
      event.preventDefault();
      capturePointer(event);
      touchScrollRef.current = {
        id: event.pointerId,
        startY: event.clientY,
        startScrollY: window.scrollY,
      };
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    capturePointer(event);
    const point = pointFromEvent(event);
    const active = {
      id: event.pointerId,
      startPixel: point.pixel,
      moved: false,
      temporaryEraser: false,
      stroke: {
        tool: toolRef.current === "eraser" && eraserModeRef.current === "lasso" ? "lasso" : toolRef.current,
        color: toolRef.current === "eraser" && eraserModeRef.current === "lasso" ? "#e26f51" : colorRef.current,
        width: toolRef.current === "eraser" ? (eraserModeRef.current === "normal" ? eraserSizeRef.current : 2) : penSizeRef.current,
        version: toolRef.current === "eraser" && eraserModeRef.current === "normal" ? 2 : undefined,
        engine: toolRef.current === "pen" && isAndroidApp() ? "direct-ink" : undefined,
        penMode: toolRef.current === "pen" && isAndroidApp() ? penModeRef.current : undefined,
        points: [point.normalized],
      },
      timer: null,
    };
    if (active.stroke.tool !== "eraser") renderInkPreview(active.stroke);
    if (event.pointerType === "pen" && toolRef.current === "pen") {
      active.timer = window.setTimeout(() => {
        const point = active.stroke.points[active.stroke.points.length - 1];
        const temporaryMode = eraserModeRef.current === "lasso" ? "lasso" : "normal";
        active.temporaryEraser = true;
        active.stroke = {
          tool: temporaryMode === "lasso" ? "lasso" : "eraser",
          color: temporaryMode === "lasso" ? "#e26f51" : colorRef.current,
          width: temporaryMode === "lasso" ? 2 : eraserSizeRef.current,
          version: temporaryMode === "normal" ? 2 : undefined,
          points: [point],
        };
        clearInkPreview();
        if (temporaryMode === "lasso") renderInkPreview(active.stroke);
        else renderEraserPreview(active.stroke);
        toolRef.current = "eraser";
        setTool("eraser");
        setHint(temporaryMode === "lasso" ? "临时自由套索：圈选后抬笔删除" : "临时普通橡皮：保持按压并移动");
        navigator.vibrate?.(35);
      }, 620);
    }
    activePointerRef.current = active;
  }

  function handlePointerMove(event) {
    const touchScroll = touchScrollRef.current;
    if (event.pointerType === "touch" && touchScroll?.id === event.pointerId) {
      event.preventDefault();
      window.scrollTo(0, touchScroll.startScrollY + touchScroll.startY - event.clientY);
      return;
    }
    const active = activePointerRef.current;
    if (!active || active.id !== event.pointerId) return;
    event.preventDefault();
    const points = coalescedPointsFromEvent(event);
    const point = points[points.length - 1];
    const distance = Math.hypot(point.pixel.x - active.startPixel.x, point.pixel.y - active.startPixel.y);
    if (!active.moved && distance < 3) return;
    active.moved = true;
    if (active.timer) {
      window.clearTimeout(active.timer);
      active.timer = null;
    }
    active.stroke.points.push(...points.map((sample) => sample.normalized));
    if (active.stroke.tool !== "eraser") {
      renderInkPreview(active.stroke);
      return;
    }
    renderEraserPreview(active.stroke);
  }

  function appendPointerUpPoint(active, event) {
    if (event.type !== "pointerup") return;
    const point = pointFromEvent(event);
    const last = active.stroke.points[active.stroke.points.length - 1];
    if (!last || Math.hypot(last.x - point.normalized.x, last.y - point.normalized.y) > 0.00002) {
      active.stroke.points.push(point.normalized);
    }
  }

  function finishPointer(event) {
    if (event.pointerType === "touch" && touchScrollRef.current?.id === event.pointerId) {
      event.preventDefault();
      touchScrollRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    const active = activePointerRef.current;
    if (!active || active.id !== event.pointerId) return;
    if (active.timer) window.clearTimeout(active.timer);
    appendPointerUpPoint(active, event);
    // Put the finished outline on the committed layer before removing the live layer.
    // This keeps the tip visually continuous at pen-up instead of flashing a blank frame.
    if (active.stroke.tool !== "lasso") renderEraserPreview(active.stroke);
    clearInkPreview();
    if (active.stroke.tool === "lasso") {
      if (active.moved && active.stroke.points.length > 2) {
        const next = eraseAnnotationsInPolygon(annotationsRef.current, active.stroke.points);
        const deleted = annotationsRef.current.length - next.length;
        if (deleted) setAndPersistAnnotations(next);
        setHint(deleted ? `已删除真实圈选范围内 ${deleted} 条笔迹` : "圈选范围内没有笔迹");
        window.setTimeout(() => setHint(""), 1600);
      }
      setAnnotations((current) => [...current]);
    } else {
      setAndPersistAnnotations((current) => [...current, active.stroke]);
    }
    if (active.temporaryEraser) {
      toolRef.current = "pen";
      setTool("pen");
      setHint("已恢复画笔");
      window.setTimeout(() => setHint(""), 900);
    }
    activePointerRef.current = null;
  }

  function cancelPointer(event) {
    if (event.pointerType === "touch" && touchScrollRef.current?.id === event.pointerId) {
      touchScrollRef.current = null;
      return;
    }
    finishPointer(event);
  }

  function handleAnswer(number, option) {
    setAnswers((current) => {
      const next = { ...current, [number]: option };
      setUserItem(answerKey(resource.id), JSON.stringify(next));
      return next;
    });
  }

  function clearPage() {
    if (annotations.length && window.confirm("清除这一页的全部笔迹？")) setAndPersistAnnotations([]);
  }

  function chooseEraserMode(value) {
    setEraserMode(value);
    setUserItem("wuliao:pref:eraser-mode", value);
    setTool("eraser");
  }

  function choosePenMode(value) {
    const next = normalizePenMode(value);
    setPenMode(next);
    setUserItem(PEN_MODE_STORAGE_KEY, next);
    setTool("pen");
    setNoteMode(true);
  }

  function choosePenSize(value) {
    const next = normalizePenSize(value);
    setPenSize(next);
    setUserItem(PEN_SIZE_STORAGE_KEY, String(next));
  }

  function changeTopAreaCollapsed(next) {
    const before = stackRef.current?.getBoundingClientRect().top || 0;
    setTopAreaCollapsed(next);
    window.requestAnimationFrame(() => {
      const after = stackRef.current?.getBoundingClientRect().top || 0;
      window.scrollBy({ top: after - before, behavior: "auto" });
    });
  }

  return (
    <div className={`reader-page ${androidApp ? "android-reader-page" : ""} ${topAreaCollapsed ? "top-area-collapsed" : ""}`}>
      <header className="reader-header">
        <button className="back-button light" onClick={onClose}>{androidApp ? "← 退出 PDF" : "← 资料库"}</button>
        <div className="reader-title"><small>{resource.subtitle}</small><strong>{resource.title}</strong></div>
        <div className="reader-status"><span /> 本地模式</div>
      </header>

      {androidApp && <button type="button" className="pdf-exit-button" onClick={onClose} aria-label="退出 PDF">×<span>退出 PDF</span></button>}

      <StageNavigation page={page} total={total} onNavigate={navigate} />

      <AnnotationToolbar
        tool={tool}
        color={color}
        annotations={annotations}
        noteMode={noteMode}
        onToggleNoteMode={() => setNoteMode((current) => !current)}
        onTool={(value) => { setTool(value); setNoteMode(true); }}
        onColor={(value) => { setColor(value); setTool("pen"); setNoteMode(true); }}
        penSize={penSize}
        penMode={penMode}
        eraserMode={eraserMode}
        eraserSize={eraserSize}
        onPenSize={choosePenSize}
        onPenMode={choosePenMode}
        onEraserMode={chooseEraserMode}
        onEraserSize={setEraserSize}
        onUndo={() => setAndPersistAnnotations((current) => current.slice(0, -1))}
        onClear={clearPage}
        collapsible
        onCollapsedChange={changeTopAreaCollapsed}
        tabletInk={androidApp}
      />

      <main ref={containerRef} className={`reader-main ${drawerOpen ? "drawer-open" : ""}`}>
        <div className="page-context"><span>{stage}</span><strong>第 {page} / {total} 页</strong></div>
        {loading && <div className="pdf-loading"><span /><strong>正在打开精读材料</strong><p>PDF 只在当前设备解析</p></div>}
        {error && <div className="pdf-error"><strong>没有成功打开这一页</strong><p>{error}</p></div>}
        <div ref={stackRef} className="canvas-stack" style={{ visibility: loading || error ? "hidden" : "visible" }}>
          <canvas ref={pdfCanvasRef} className="pdf-canvas" />
          <canvas
            ref={inkCanvasRef}
            className={`ink-canvas tool-${tool} ${noteMode ? "note-mode" : ""}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointer}
            onPointerCancel={cancelPointer}
            onLostPointerCapture={finishPointer}
          />
          <canvas ref={inkPreviewCanvasRef} className="ink-preview-canvas" aria-hidden="true" />
        </div>
      </main>

      <button className={`question-fab ${drawerOpen ? "hidden" : ""}`} onClick={() => setDrawerOpen(true)}>
        <span>题</span><strong>习题</strong><small>{questions.length || "·"}</small>
      </button>

      <QuestionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} questions={questions} parseInfo={parseInfo} answers={answers} onAnswer={handleAnswer} />

      <nav className="page-navigation" aria-label="翻页">
        <button onClick={() => navigate(page - 1)} disabled={page === 1}>← 上一页</button>
        <span><strong>{page}</strong> / {total}</span>
        <button onClick={() => navigate(page + 1)} disabled={page === total}>下一页 →</button>
      </nav>
      {hint && <div className="toast">{hint}</div>}
    </div>
  );
}
