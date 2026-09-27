import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { readProgress, saveProgress } from "./library";
import { extractQuestions } from "./questions";
import { AnnotationToolbar } from "./ui/AnnotationToolbar";
import {
  drawInkStroke,
  eraseAnnotationsInPolygon,
  inkPixelRatio,
  normalizePenMode,
  normalizePenSize,
  PEN_MODE_STORAGE_KEY,
  PEN_SIZE_STORAGE_KEY,
  renderInkLayer,
  resizeInkCanvas,
} from "./annotationTools";
import { isAndroidApp } from "./platform";
import { ReaderStageMarker } from "./ui/ReaderChrome";
import { installPenScrollGuard } from "./inkEngine";
import { useStructuredInk } from "./ink/useStructuredInk";
import { exposeInkHandoffStats, recordInkHandoff } from "./inkDebug";
import { getTelemetry } from "./telemetry/telemetry";
import { getUserItem, setUserItem } from "./userData";
import { onOtherPanelOpen, openPanel } from "./panelBus";
import { useBackHandler } from "./ui/BackContext";
import { BACK_PRIORITY } from "./ui/backController";
import { useMotionPresence } from "./ui/useMotionPresence";

GlobalWorkerOptions.workerSrc = workerUrl;

import { useSaveBoundary } from "./useSaveBoundary.js";
import { backgroundSave, saveBeforeNavigation, scheduleInkSave, cancelScheduledInkSave } from "./saveCoordinator.js";
import { getCurrentUsername, setUserItem as writeOwnedUserItem } from "./userData.js";
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
          <ReaderStageMarker index={index} />{label}
        </button>
      ))}
    </nav>
  );
}

export function QuestionDrawer({
  embedded = false,
  open,
  onClose,
  questions,
  parseInfo,
  answers,
  onAnswer,
  correctAnswers = {},
  correctionVisible = false,
  onToggleCorrection,
  onRequestAiHint,
  getDiagnosisLabel,
  onRequestDiagnosis,
  docked = true,
  onDockedChange,
  avoidAiWindow = false,
  focusQuestionId = null,
  evidenceForQuestion = null,
  onRequestEvidence = null,
  capabilitiesForQuestion = null,
}) {
  const [expanded, setExpanded] = useState(null);
  const [pos, setPos] = useState(() => {
    try {
      const parsed = JSON.parse(getUserItem("wuliao:question-drawer-pos"));
      return parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y) ? parsed : null;
    } catch {
      return null;
    }
  });
  const posRef = useRef(pos);
  const drawerRef = useRef(null);
  const dragRef = useRef(null);
  const dragFrameRef = useRef(0);
  const defaultLeft = avoidAiWindow ? 12 : Math.max(12, window.innerWidth - 340 - 16);
  const motion = useMotionPresence(open);

  useEffect(() => {
    if (open && !embedded) openPanel("questions");
  }, [open, embedded]);

  useEffect(() => embedded ? undefined : onOtherPanelOpen("questions", (panel) => {
    if (!open) return;
    if (panel === "ai") return; // AI 窗打开时保持共存，由外层自动切到缩小模式
    onClose();
  }), [open, onClose, embedded]);

  useBackHandler(() => {
    if (!open) return false;
    onClose();
    return true;
  }, {
    enabled: open,
    priority: BACK_PRIORITY.drawer,
  });

  useEffect(() => { posRef.current = pos; }, [pos]);

  useEffect(() => () => {
    if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current);
  }, []);

  function startDrawerDrag(event) {
    if (event.target.closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const drawerRect = drawerRef.current?.getBoundingClientRect();
    const baseLeft = drawerRect?.left ?? posRef.current?.x ?? defaultLeft;
    const baseTop = drawerRect?.top ?? posRef.current?.y ?? 90;
    drawerRef.current?.setAttribute("data-dragging", "true");
    dragRef.current = { startX, startY, baseLeft, baseTop };
    const move = (moveEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = {
        x: Math.min(Math.max(0, drag.baseLeft + moveEvent.clientX - drag.startX), Math.max(0, window.innerWidth - 340)),
        y: Math.min(Math.max(0, drag.baseTop + moveEvent.clientY - drag.startY), Math.max(0, window.innerHeight - 96)),
      };
      drag.next = next;
      posRef.current = next;
      if (dragFrameRef.current) return;
      dragFrameRef.current = window.requestAnimationFrame(() => {
        dragFrameRef.current = 0;
        const active = dragRef.current;
        const node = drawerRef.current;
        if (!active?.next || !node) return;
        node.style.transform = `translate(${active.next.x - active.baseLeft}px, ${active.next.y - active.baseTop}px)`;
      });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = 0;
      }
      const next = dragRef.current?.next || posRef.current;
      if (next && drawerRef.current) {
        drawerRef.current.style.left = `${next.x}px`;
        drawerRef.current.style.top = `${next.y}px`;
        drawerRef.current.style.transform = "";
        setPos(next);
      }
      drawerRef.current?.removeAttribute("data-dragging");
      dragRef.current = null;
      if (next) setUserItem("wuliao:question-drawer-pos", JSON.stringify(next));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  useEffect(() => {
    if (questions.length && !questions.some((question) => question.number === expanded)) {
      setExpanded(questions[0].number);
    }
  }, [questions, expanded]);

  useEffect(() => {
    if (!focusQuestionId) return;
    const question = questions.find((item) => item.id === focusQuestionId);
    if (question) setExpanded(question.number);
  }, [focusQuestionId, questions]);

  return (
    <aside
      ref={drawerRef}
      className={`question-drawer ${motion.visible ? "open" : ""} ${docked ? "docked" : "floating"}`}
      data-motion-state={motion.state}
      style={motion.present && !docked ? { left: pos?.x ?? defaultLeft, top: pos?.y ?? 90, right: "auto", bottom: "auto" } : undefined}
      aria-hidden={motion.state === "closed"}
    >
      <div className="drawer-header" onPointerDown={docked ? undefined : startDrawerDrag}>
        <div><small>QUESTION PANEL</small><h2>悬浮习题窗</h2></div>
        <div className="drawer-header-actions">
          {!avoidAiWindow && onDockedChange && <button className="drawer-mode-button" onClick={() => onDockedChange(!docked)}>{docked ? "缩小" : "放大"}</button>}
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
          const capabilities = capabilitiesForQuestion?.(question) || {
            canEditAnswer: true,
            showCorrection: correctionVisible,
            showEvidence: Boolean(onRequestEvidence && evidenceForQuestion),
            showAiHint: Boolean(onRequestAiHint),
            showDiagnosis: Boolean(getDiagnosisLabel && onRequestDiagnosis),
          };
          return (
            <section className={`question-item ${isExpanded ? "expanded" : ""}`} key={question.number} data-question-id={question.id}>
              <button className="question-stem" onClick={() => setExpanded(isExpanded ? null : question.number)}>
                <strong>{question.number}. {question.stem}</strong><i>{isExpanded ? "−" : "+"}</i>
              </button>
              {isExpanded && (
                <div className="question-options">
                  {question.options.map((option) => (
                    <button key={option.key} className={[
                      answers[question.number] === option.key ? "selected" : "",
                      capabilities.showCorrection && correctAnswers[question.number] === option.key ? "correct" : "",
                    ].filter(Boolean).join(" ")} disabled={!capabilities.canEditAnswer} onClick={() => capabilities.canEditAnswer && onAnswer(question.number, option.key)}>
                      <span>{option.key}</span><p>{option.text}</p>
                    </button>
                  ))}
                </div>
              )}
              {isExpanded && capabilities.showAiHint && onRequestAiHint && (
                <div className="question-ai-hint-row">
                  <button type="button" className="question-ai-hint-button" onClick={() => onRequestAiHint(question)}>
                    AI 提示
                  </button>
                  {capabilities.showDiagnosis && getDiagnosisLabel && onRequestDiagnosis && (() => {
                    const diagnosisLabel = getDiagnosisLabel(question);
                    return diagnosisLabel ? (
                      <button
                        type="button"
                        className="question-ai-hint-button question-diagnosis-button"
                        onClick={() => onRequestDiagnosis(question)}
                      >
                        {diagnosisLabel}
                      </button>
                    ) : null;
                  })()}
                </div>
              )}
              {isExpanded && capabilities.showEvidence && onRequestEvidence && evidenceForQuestion && (() => {
                const evidence = evidenceForQuestion(question);
                if (!evidence) return null;
                const label = evidence.hasEvidence
                  ? `原文证据 · ${evidence.label || "已标记"}`
                  : (evidence.legacy ? "历史作答 · 未记录原文证据" : "原文证据 · 尚未标记");
                return (
                  <div className="question-evidence-row">
                    <span>{label}</span>
                    <button
                      type="button"
                      className="question-evidence-action"
                      onClick={() => onRequestEvidence(question)}
                    >
                      {evidence.hasEvidence ? "查看原文/修改" : "去原文定位"}
                    </button>
                  </div>
                );
              })()}
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

// 兼容旧 import：共享 Toolbar 已抽至 src/ui/AnnotationToolbar.jsx（唯一实现）。
export { AnnotationToolbar };
export default function PdfReader({ resource, onClose }) {
  const storageUsername = useRef(getCurrentUsername()).current;
  const setUserItem = (key, value) => writeOwnedUserItem(key, value, storageUsername);
  const closeAfterSave = () => saveBeforeNavigation(onClose, storageUsername);
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
  const [drawerDocked, setDrawerDocked] = useState(() => loadJson("wuliao:question-drawer-mode", "docked") !== "floating");
  const [hint, setHint] = useState("");
  const [topAreaCollapsed, setTopAreaCollapsed] = useState(false);
  const [reloadAttempt, setReloadAttempt] = useState(0);

  const containerRef = useRef(null);
  const stackRef = useRef(null);
  const pdfCanvasRef = useRef(null);
  const inkCanvasRef = useRef(null);
  const inkPreviewCanvasRef = useRef(null);
  const tailCanvasRef = useRef(null);
  const activePointerRef = useRef(null);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const penSizeRef = useRef(penSize);
  const penModeRef = useRef(penMode);
  const eraserModeRef = useRef(eraserMode);
  const eraserSizeRef = useRef(eraserSize);
  const noteModeRef = useRef(noteMode);
  const annotationsRef = useRef(annotations);
  const pendingAnnotationSaveRef = useRef(null);
  const annotationSaveTimerRef = useRef(null);

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { penSizeRef.current = penSize; }, [penSize]);
  useEffect(() => { penModeRef.current = penMode; }, [penMode]);
  useEffect(() => { eraserModeRef.current = eraserMode; }, [eraserMode]);
  useEffect(() => { eraserSizeRef.current = eraserSize; }, [eraserSize]);
  useEffect(() => { noteModeRef.current = noteMode; }, [noteMode]);
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
      backgroundSave(flushPendingAnnotationSave);
    };
  }, []);

  // 共享 Ink Runtime 的 dispose（卸载时清理 rAF 与未结束会话）由 useStructuredInk 内部注册。

  useEffect(() => {
    exposeInkHandoffStats();
  }, []);

  useEffect(() => {
    if (!noteMode || !containerRef.current) return undefined;
    return installPenScrollGuard({
      root: containerRef,
      ownsPointer: (pointerId) => activePointerRef.current?.id === pointerId,
      hasActiveSession: () => Boolean(activePointerRef.current),
    });
  }, [noteMode]);

  // 共享 Ink Runtime：与精读 / 普通完形 / 模拟考试使用同一份笔系统实现。
  // PdfReader 使用单 committed canvas 策略（append-only 提交 + 结构性整层重绘）。
  const inkController = useStructuredInk({
    canInteract: () => noteModeRef.current,
    surfaceRef: inkCanvasRef,
    previewCanvasRef: inkPreviewCanvasRef,
    tailCanvasRef,
    strokesRef: annotationsRef,
    activeRef: activePointerRef,
    toolRef,
    colorRef,
    penSizeRef,
    penModeRef,
    eraserModeRef,
    eraserSizeRef,
    commitAppendStroke: commitStrokeToCommittedLayer,
    renderCommitted: (extraStroke = null) => {
      return extraStroke ? renderEraserPreview(extraStroke) : redrawCommittedLayer();
    },
    persistStrokes: (next) => { setAndPersistAnnotations(next); },
    engineForPen: () => isAndroidApp(),
    onHint: setHint,
  });

  useEffect(() => {
    let cancelled = false;
    let task = null;
    const controller = new AbortController();
    const sourceUrl = new URL(resource.source, window.location.href).href;
    const pdfAssetBase = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
    setLoading(true);
    setError("");
    (async () => {
      const response = await fetch(sourceUrl, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`PDF 文件读取失败（${response.status}）`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (cancelled) return;
      task = getDocument({
        data,
        cMapUrl: `${pdfAssetBase}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${pdfAssetBase}standard_fonts/`,
        signal: controller.signal,
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
      if (cancelled || reason?.name === "AbortError") return;
      setError(reason?.message || "PDF 无法打开");
      setLoading(false);
    });
    return () => {
      cancelled = true;
      controller.abort();
      task?.destroy();
    };
  }, [resource.source, reloadAttempt]);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdfDocument) return undefined;
    inkController.finishActiveForGeometryChange();
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
      resizeInkCanvas(tailCanvasRef.current, viewport.width, viewport.height, inkRatio);
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
    // 只由页面渲染/尺寸/加载变化触发整层重绘；普通新增笔画由 append-only commit 完成。
    const canvas = inkCanvasRef.current;
    if (!canvas || !canvasSize.width) return;
    redrawCommittedLayer();
  }, [canvasSize, page, resource.id]);

  useEffect(() => {
    if (pdfDocument) saveProgress(resource, page, total);
  }, [resource, page, total, pdfDocument]);

  const stage = useMemo(() => stageForPage(page, total), [page, total]);

  function navigate(nextPage) {
    void saveBeforeNavigation(() => {
      setPage(Math.max(1, Math.min(total, nextPage)));
      containerRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, storageUsername);
  }

  function setAndPersistAnnotations(updater) {
    const next = typeof updater === "function" ? updater(annotationsRef.current) : updater;
    annotationsRef.current = next;
    startTransition(() => setAnnotations(next));
    pendingAnnotationSaveRef.current = {
      key: annotationKey(resource.id, page),
      annotations: next,
    };
    if (annotationSaveTimerRef.current) cancelScheduledInkSave(annotationSaveTimerRef.current);
    annotationSaveTimerRef.current = scheduleInkSave(flushPendingAnnotationSave);
  }

  function flushPendingAnnotationSave() {
    if (annotationSaveTimerRef.current) cancelScheduledInkSave(annotationSaveTimerRef.current);
    annotationSaveTimerRef.current = null;
    const pending = pendingAnnotationSaveRef.current;
    if (!pending) return;
    const startedAt = performance.now();
    setUserItem(pending.key, JSON.stringify(pending.annotations));
    try {
      getTelemetry().recordTiming({ metric: "ink.save", durationMs: performance.now() - startedAt });
    } catch {
      // Telemetry 异常绝不影响笔迹保存
    }
    pendingAnnotationSaveRef.current = null;
  }
  useSaveBoundary(() => {
    inkController.finishActiveForGeometryChange();
    flushPendingAnnotationSave();
  });

  function renderEraserPreview(stroke) {
    recordInkHandoff("fullRedraw");
    const canvas = inkCanvasRef.current;
    if (!canvas || !canvasSize.width) return false;
    return renderInkLayer(canvas, [...annotationsRef.current, stroke], canvasSize.width, canvasSize.height, canvasSize.inkRatio);
  }

  // 普通新增笔画：append-only，直接绘制这一条 stroke，不 clear、不重画历史。
  function commitStrokeToCommittedLayer(stroke) {
    recordInkHandoff("incrementalCommit");
    const canvas = inkCanvasRef.current;
    if (!canvas || !canvasSize.width || !canvasSize.height || !stroke?.points?.length) return false;
    const context = canvas.getContext("2d", { alpha: true });
    context.save();
    context.scale(canvasSize.inkRatio, canvasSize.inkRatio);
    drawInkStroke(context, stroke, canvasSize.width, canvasSize.height);
    context.restore();
    return true;
  }

  // 结构性变化（初始加载/页面变化/resize/undo/clear/删除）才整层重绘。
  function redrawCommittedLayer() {
    recordInkHandoff("fullRedraw");
    const canvas = inkCanvasRef.current;
    if (!canvas || !canvasSize.width) return false;
    return renderInkLayer(canvas, annotationsRef.current, canvasSize.width, canvasSize.height, canvasSize.inkRatio);
  }

  function handleAnswer(number, option) {
    setAnswers((current) => {
      const next = { ...current, [number]: option };
      setUserItem(answerKey(resource.id), JSON.stringify(next));
      return next;
    });
  }

  function clearPage() {
    if (annotations.length && window.confirm("清除这一页的全部笔迹？")) {
      setAndPersistAnnotations([]);
      redrawCommittedLayer();
    }
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

  function changeDrawerDocked(next) {
    setDrawerDocked(next);
    setUserItem("wuliao:question-drawer-mode", next ? "docked" : "floating");
  }

  return (
    <div className={`reader-page ${androidApp ? "android-reader-page" : ""} ${topAreaCollapsed ? "top-area-collapsed" : ""} ${drawerOpen ? "drawer-open" : ""} ${drawerOpen && drawerDocked ? "drawer-docked" : ""}`}>
      <header className="reader-header">
        <button className="back-button light" onClick={closeAfterSave}>{androidApp ? "← 退出 PDF" : "← 资料库"}</button>
        <div className="reader-title"><small>{resource.subtitle}</small><strong>{resource.title}</strong></div>
        <div className="reader-status"><span /> 本地模式</div>
      </header>

      {androidApp && <button type="button" className="pdf-exit-button" onClick={closeAfterSave} aria-label="退出 PDF">×<span>退出 PDF</span></button>}

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
        onUndo={() => {
          setAndPersistAnnotations((current) => current.slice(0, -1));
          redrawCommittedLayer();
        }}
        onClear={clearPage}
        collapsible
        collapsed={topAreaCollapsed}
        collapseMode="chrome-only"
        onCollapsedChange={changeTopAreaCollapsed}
        stageHint={stage}
        tabletInk={androidApp}
      />

      <main ref={containerRef} className={`reader-main ${drawerOpen ? "drawer-open" : ""} ${drawerOpen && drawerDocked ? "drawer-docked" : ""}`}>
        <div className="page-context"><span>{stage}</span><strong>第 {page} / {total} 页</strong></div>
        {loading && <div className="pdf-loading"><span /><strong>正在打开精读材料</strong><p>PDF 只在当前设备解析</p></div>}
        {error && <div className="pdf-error"><strong>没有成功打开这一页</strong><p>{error}</p><button type="button" className="primary-button" onClick={() => setReloadAttempt((value) => value + 1)}>重新加载</button></div>}
        <div ref={stackRef} className="canvas-stack" style={{ visibility: loading || error ? "hidden" : "visible" }}>
          <canvas ref={pdfCanvasRef} className="pdf-canvas" />
          <canvas
            ref={inkCanvasRef}
            className={`ink-canvas tool-${tool} ${noteMode ? "note-mode" : ""}`}
            onPointerDown={inkController.handlePointerDown}
            onPointerMove={inkController.handlePointerMove}
            onPointerUp={inkController.handlePointerUp}
            onPointerCancel={inkController.handlePointerCancel}
            onLostPointerCapture={inkController.handlePointerUp}
          />
          <canvas ref={inkPreviewCanvasRef} className="ink-preview-canvas" aria-hidden="true" />
          <canvas ref={tailCanvasRef} className="ink-tail-canvas" aria-hidden="true" />
        </div>
      </main>

      <button className={`question-fab ${drawerOpen ? "hidden" : ""}`} onClick={() => setDrawerOpen(true)}>
        <span>题</span><strong>习题</strong><small>{questions.length || "·"}</small>
      </button>

      <QuestionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} questions={questions} parseInfo={parseInfo} answers={answers} onAnswer={handleAnswer} docked={drawerDocked} onDockedChange={changeDrawerDocked} />

      <nav className="page-navigation" aria-label="翻页">
        <button onClick={() => navigate(page - 1)} disabled={page === 1}>← 上一页</button>
        <span><strong>{page}</strong> / {total}</span>
        <button onClick={() => navigate(page + 1)} disabled={page === total}>下一页 →</button>
      </nav>
      {hint && <div className="toast">{hint}</div>}
    </div>
  );
}
