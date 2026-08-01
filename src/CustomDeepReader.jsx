import { useEffect, useMemo, useRef, useState } from "react";
import PdfReader, { AnnotationToolbar, QuestionDrawer } from "./PdfReader";
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
import { getOfficialAnswerKey } from "./answerKeys";
import {
  isReadingCompleted,
  markReadingStarted,
  setReadingCompleted as persistReadingCompleted,
} from "./studyRank";
import { listUnknownWords, toggleUnknownWord } from "./storage";
import { lookupUnknownWordMeaning, normalizeUnknownWord } from "./unknownWords";
import { getUserItem, setUserItem } from "./userData";

function loadJson(key, fallback) {
  try { return JSON.parse(getUserItem(key)) || fallback; } catch { return fallback; }
}

function formatArticleText(value) {
  return String(value || "")
    .replace(/[—–―]/g, "--")
    .replace(/[‐‑]/g, "-")
    .replace(/(^|\s)-(?=\s|$)/g, "$1--");
}

const UNKNOWN_WORD_PATTERN = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const SAVED_UNKNOWN_HIGHLIGHT = "wuliao-unknown-words";
const ACTIVE_UNKNOWN_HIGHLIGHT = "wuliao-unknown-selecting";

function textNodesInUnknownScope(scope) {
  const nodes = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (!node.parentElement?.closest("[data-unknown-ignore]")) nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function unknownWordRanges(scope) {
  const ranges = [];
  let wordIndex = 0;
  for (const node of textNodesInUnknownScope(scope)) {
    for (const match of node.data.matchAll(UNKNOWN_WORD_PATTERN)) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      ranges.push({
        word: match[0],
        occurrenceId: `${scope.dataset.unknownScope}:${wordIndex++}`,
        range,
      });
    }
  }
  return ranges;
}

function unknownWordFromPoint(clientX, clientY) {
  const caret = document.caretPositionFromPoint?.(clientX, clientY);
  const fallback = caret ? null : document.caretRangeFromPoint?.(clientX, clientY);
  const node = caret?.offsetNode || fallback?.startContainer;
  const offset = caret?.offset ?? fallback?.startOffset;
  if (!(node instanceof Text) || !Number.isFinite(offset)) return null;
  const scope = node.parentElement?.closest("[data-unknown-scope]");
  if (!scope || node.parentElement?.closest("[data-unknown-ignore]")) return null;
  return unknownWordRanges(scope).find((token) => {
    if (token.range.startContainer !== node) return false;
    if (offset < token.range.startOffset || offset > token.range.endOffset) return false;
    return [...token.range.getClientRects()].some((rect) => (
      clientX >= rect.left - 2 && clientX <= rect.right + 2
      && clientY >= rect.top - 2 && clientY <= rect.bottom + 2
    ));
  }) || null;
}

function setUnknownHighlight(name, ranges) {
  if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== "function") return;
  if (!document.querySelector("style[data-unknown-highlight-styles]")) {
    const style = document.createElement("style");
    style.dataset.unknownHighlightStyles = "true";
    style.textContent = `
      ::highlight(${SAVED_UNKNOWN_HIGHLIGHT}) { background: rgba(226, 111, 81, 0.13); text-decoration: underline rgba(226, 111, 81, 0.8) 1.5px; }
      ::highlight(${ACTIVE_UNKNOWN_HIGHLIGHT}) { background: rgba(226, 111, 81, 0.24); text-decoration: underline #e26f51 2px; }
    `;
    document.head.append(style);
  }
  if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}

const customAnswerKey = (resourceId, passageId) => `wuliao:custom-answer-key:${resourceId}:${passageId}`;

function parseAnswerInput(value, questions) {
  const answers = {};
  const matches = String(value || "").matchAll(/(\d+)\s*[:：.\-]?\s*([A-D])/gi);
  for (const match of matches) answers[match[1]] = match[2].toUpperCase();
  if (Object.keys(answers).length) return answers;

  const letters = String(value || "").toUpperCase().replace(/[^A-D]/g, "");
  if (letters.length < questions.length) return {};
  questions.forEach((question, index) => { answers[question.number] = letters[index]; });
  return answers;
}

function SavedLines({ storageKey, lines = 2, label, inkOnly = false }) {
  const [value, setValue] = useState(() => getUserItem(storageKey) || "");
  return (
    <textarea
      className="deep-writing-lines"
      style={{ "--writing-lines": lines }}
      rows={lines}
      value={value}
      aria-label={label}
      aria-readonly={inkOnly}
      readOnly={inkOnly}
      inputMode={inkOnly ? "none" : undefined}
      spellCheck={!inkOnly}
      data-ink-only={inkOnly ? "true" : undefined}
      onChange={(event) => {
        setValue(event.target.value);
        setUserItem(storageKey, event.target.value);
      }}
    />
  );
}

function QuestionSet({ passage, answers, onAnswer, correctAnswers, correctionVisible }) {
  if (!passage.questions.length) {
    return <div className="deep-empty">未识别到这篇文章的选择题，可先完成原文精读。</div>;
  }

  return (
    <div className="deep-question-list">
      {passage.questions.map((question) => (
        <article className="deep-question-card" key={question.id}>
          <h3><span>{question.number}</span>{question.stem}</h3>
          <div className="deep-options">
            {question.options.map((option) => (
              <button
                key={option.key}
                className={[
                  answers[question.number] === option.key ? "selected" : "",
                  correctionVisible && correctAnswers[question.number] === option.key ? "correct" : "",
                ].filter(Boolean).join(" ")}
                onClick={() => onAnswer(question.number, option.key)}
              >
                <span>{option.key}</span><p>{option.text}</p>
              </button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function SectionHeading({ index, title, description, action = null }) {
  return (
    <div className="deep-section-heading">
      <span>{index}</span>
      <div className="deep-section-heading-copy"><h2>{title}</h2><p>{description}</p></div>
      {action && <div className="deep-section-heading-action">{action}</div>}
    </div>
  );
}

function PassageWorkbook({
  resource,
  passage,
  analysis,
  answers,
  onAnswer,
  redoAnswers,
  onRedoAnswer,
  correctAnswers,
  correctionVisibility,
  onToggleCorrection,
  readingCompleted,
  onToggleReadingCompleted,
  inkOnly,
}) {
  const totalSentences = useMemo(
    () => passage.paragraphs.reduce((sum, paragraph) => sum + paragraph.sentences.length, 0),
    [passage],
  );

  return (
    <>
      <section className="deep-cover deep-paper" id="deep-cover">
        <p className="eyebrow">READING DEEP-DIVE WORKBOOK</p>
        <span className="deep-cover-label">{passage.label}</span>
        <h1>{resource.title}</h1>
        <p className="deep-cover-subtitle">精读全流程：审题、读文、作答、逐句笔译、订正、重做与复读</p>
        <div className="deep-cover-stats">
          <div><strong>{passage.paragraphs.length}</strong><span>文章段落</span></div>
          <div><strong>{totalSentences}</strong><span>逐句笔译</span></div>
          <div><strong>{passage.questions.length}</strong><span>识别习题</span></div>
          <div><strong>{analysis.method === "ocr" ? "OCR" : "PDF"}</strong><span>本地识别</span></div>
        </div>
        <dl className="deep-guide-table">
          <div><dt>限时阶段</dt><dd>先看全部题干，不看选项；读文时不查词。</dd></div>
          <div><dt>笔译阶段</dt><dd>按段、按句输出自己的译文，再回原文订正。</dd></div>
          <div><dt>重做阶段</dt><dd>全文核对完成后，再统一完成全部题目。</dd></div>
          <div><dt>第二天</dt><dd>遮住笔译重读，压缩段落功能并复查错因。</dd></div>
        </dl>
        {analysis.warnings?.map((warning) => <p className="deep-warning" key={warning}>{warning}</p>)}
      </section>

      <section className="deep-paper" id="deep-first-read">
        <SectionHeading index="1" title="限时第一读：先看全部英文题干" description="只建立阅读导航，不看选项，不提前分析答案。" />
        {passage.questions.length ? (
          <div className="stem-table">
            <div className="stem-row stem-head"><span>No.</span><strong>Question stem - English only</strong><i>Signal</i></div>
            {passage.questions.map((question) => (
              <div className="stem-row" key={question.id}><span>{question.number}</span><strong>{question.stem}</strong><i /></div>
            ))}
          </div>
        ) : <div className="deep-empty">没有识别到题干，请先阅读干净原文。</div>}
        <h3 className="deep-note-title">我的英文题干导航标记</h3>
        <SavedLines storageKey={`wuliao:deep-note:${resource.id}:${passage.id}:navigation`} lines={5} label="英文题干导航标记" inkOnly={inkOnly} />
      </section>

      <section className="deep-paper" id="deep-clean-text">
        <SectionHeading index="2" title="干净原文：限时读文" description="现在开始计时。此处只保留当前 PDF 中识别到的文章原文。" />
        <div className="clean-article">
          {passage.paragraphs.map((paragraph) => (
            <p key={paragraph.number} data-unknown-scope={`clean:p${paragraph.number}`}><span data-unknown-ignore>[P{paragraph.number}]</span>{formatArticleText(paragraph.text)}</p>
          ))}
        </div>
      </section>

      <section className="deep-paper" id="deep-first-quiz">
        <SectionHeading
          index="3"
          title="第一次做题：完成全部习题"
          description="现在才看选项。需要时回到干净原文定位。"
          action={passage.questions.length > 0 && (
            <button type="button" className={`correction-button ${correctionVisibility.first ? "active" : ""}`} onClick={() => onToggleCorrection("first")}>
              {correctionVisibility.first ? "隐藏订正" : "订正"}
            </button>
          )}
        />
        <QuestionSet passage={passage} answers={answers} onAnswer={onAnswer} correctAnswers={correctAnswers} correctionVisible={correctionVisibility.first} />
      </section>

      <section className="deep-translation" id="deep-translation">
        <SectionHeading index="4" title="逐句笔译与原文订正" description="按原文段落与句子顺序逐个输出；每句下方横线数量按该句长度生成。" />
        {passage.paragraphs.map((paragraph) => (
          <article className="translation-paragraph deep-paper" key={paragraph.number}>
            <header><span>4.{paragraph.number}</span><h2>第 {paragraph.number} 段：逐句笔译与原文订正</h2></header>
            <p className="translation-tip">先写自己的译文，再回到英文标记主干、逻辑和错因。</p>
            <div className="sentence-list">
              {paragraph.sentences.map((sentence, sentenceIndex) => {
                const words = sentence.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
                const lineCount = Math.max(1, Math.min(5, Math.ceil(words.length / 14)));
                return (
                  <section className="sentence-work" key={`${paragraph.number}-${sentenceIndex}`}>
                    <div className="sentence-source"><span>S{sentenceIndex + 1}</span><p data-unknown-scope={`translation:p${paragraph.number}:s${sentenceIndex + 1}`}>{formatArticleText(sentence)}</p></div>
                    <small>我的笔译</small>
                    <SavedLines
                      storageKey={`wuliao:deep-translation:${resource.id}:${passage.id}:${paragraph.number}:${sentenceIndex}`}
                      lines={lineCount}
                      label={`第${paragraph.number}段第${sentenceIndex + 1}句笔译`}
                      inkOnly={inkOnly}
                    />
                  </section>
                );
              })}
            </div>
            <div className="paragraph-source-repeat">
              <h3>本段英语原文（按句分行）</h3>
              {paragraph.sentences.map((sentence, sentenceIndex) => (
                <p key={`${paragraph.number}-repeat-${sentenceIndex}`} data-unknown-scope={`repeat:p${paragraph.number}:s${sentenceIndex + 1}`}><span data-unknown-ignore>S{sentenceIndex + 1}</span>{formatArticleText(sentence)}</p>
              ))}
            </div>
            <h3 className="deep-note-title">段落中心思想（用一句话概括）</h3>
            <SavedLines storageKey={`wuliao:deep-summary:${resource.id}:${passage.id}:${paragraph.number}`} lines={2} label={`第${paragraph.number}段中心思想`} inkOnly={inkOnly} />
          </article>
        ))}
      </section>

      <section className="deep-paper" id="deep-redo">
        <SectionHeading
          index="5"
          title="全文核对后：正式重做"
          description="再次独立作答，只看题干和选项；需要时回原文圈出定位句。"
          action={passage.questions.length > 0 && (
            <button type="button" className={`correction-button ${correctionVisibility.redo ? "active" : ""}`} onClick={() => onToggleCorrection("redo")}>
              {correctionVisibility.redo ? "隐藏订正" : "订正"}
            </button>
          )}
        />
        <QuestionSet passage={passage} answers={redoAnswers} onAnswer={onRedoAnswer} correctAnswers={correctAnswers} correctionVisible={correctionVisibility.redo} />
      </section>

      <section className="deep-paper" id="deep-review">
        <SectionHeading index="6" title="全文压缩与第二天复读" description="不预设结构答案。请用自己的话压缩全文，第二天遮住笔译复读。" />
        <div className="compression-table">
          {passage.paragraphs.map((paragraph) => (
            <div className="compression-row" key={paragraph.number}>
              <span>P{paragraph.number}</span>
              <SavedLines storageKey={`wuliao:deep-compress:${resource.id}:${passage.id}:${paragraph.number}`} lines={2} label={`第${paragraph.number}段压缩`} inkOnly={inkOnly} />
            </div>
          ))}
        </div>
        <h3 className="deep-note-title">全文主题与作者态度</h3>
        <SavedLines storageKey={`wuliao:deep-theme:${resource.id}:${passage.id}`} lines={4} label="全文主题与作者态度" inkOnly={inkOnly} />
        <div className="review-checklist">
          <label><input type="checkbox" /> 我能用 30 秒说清全文主线</label>
          <label><input type="checkbox" /> 我能遮住答案重做全部题目</label>
          <label><input type="checkbox" /> 我已复查错因与替换词</label>
        </div>
        <div className={`reading-completion ${readingCompleted ? "completed" : ""}`}>
          <div><strong>{readingCompleted ? "本篇已计入完成阅读" : "完成全部流程后再标记"}</strong><span>用于计算本机段位与阅读完成率</span></div>
          <button type="button" onClick={onToggleReadingCompleted}>{readingCompleted ? "撤销完成" : "标记本篇完成"}</button>
        </div>
      </section>
    </>
  );
}

const inkKey = (resourceId, passageId) => `wuliao:deep-ink:${resourceId}:${passageId}`;
const answerKey = (resourceId, passageId, attempt) => `wuliao:deep-answers:${resourceId}:${passageId}:${attempt}`;
const positionKey = (resourceId) => `wuliao:deep-position:${resourceId}`;
const strokeBoundsCache = new WeakMap();

function normalizedStrokeBounds(stroke) {
  const cached = strokeBoundsCache.get(stroke);
  if (cached) return cached;
  const points = stroke.points?.length ? stroke.points : [{ x: stroke.x || 0, y: stroke.y || 0 }];
  const bounds = points.reduce((current, point) => ({
    minX: Math.min(current.minX, point.x),
    maxX: Math.max(current.maxX, point.x),
    minY: Math.min(current.minY, point.y),
    maxY: Math.max(current.maxY, point.y),
  }), { minX: 1, maxX: 0, minY: 1, maxY: 0 });
  strokeBoundsCache.set(stroke, bounds);
  return bounds;
}

function projectStrokeToViewport(stroke, contentRect) {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const project = (point) => ({
    ...point,
    x: (contentRect.left + point.x * contentRect.width) / width,
    y: (contentRect.top + point.y * contentRect.height) / height,
  });
  if (stroke.type === "text") {
    const point = project(stroke);
    return { ...stroke, x: point.x, y: point.y };
  }
  return { ...stroke, points: (stroke.points || []).map(project) };
}

export default function CustomDeepReader({ resource, onClose }) {
  const androidApp = isAndroidApp();
  const analysis = resource.analysis;
  const initialPosition = loadJson(positionKey(resource.id), {});
  const [passageIndex, setPassageIndex] = useState(() => {
    const index = analysis.passages.findIndex((item) => item.id === initialPosition.passageId);
    return Math.max(0, index);
  });
  const [showSource, setShowSource] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [topAreaCollapsed, setTopAreaCollapsed] = useState(false);
  const [activeStage, setActiveStage] = useState(() => initialPosition.anchorId || "deep-cover");
  const [noteMode, setNoteMode] = useState(() => androidApp);
  const [tool, setTool] = useState("pen");
  const [penSize, setPenSize] = useState(() => normalizePenSize(getUserItem(PEN_SIZE_STORAGE_KEY)));
  const [penMode, setPenMode] = useState(() => normalizePenMode(getUserItem(PEN_MODE_STORAGE_KEY)));
  const [eraserMode, setEraserMode] = useState(() => getUserItem("wuliao:pref:eraser-mode") || "normal");
  const [eraserSize, setEraserSize] = useState(24);
  const [color, setColor] = useState("#173a62");
  const [strokes, setStrokes] = useState([]);
  const [answers, setAnswers] = useState({});
  const [redoAnswers, setRedoAnswers] = useState({});
  const [drawerAnswers, setDrawerAnswers] = useState({});
  const [hint, setHint] = useState("");
  const [correctionVisibility, setCorrectionVisibility] = useState({
    first: false,
    redo: false,
    drawer: false,
  });
  const [customCorrectAnswers, setCustomCorrectAnswers] = useState({});
  const [readingCompleted, setReadingCompleted] = useState(false);
  const [unknownWords, setUnknownWords] = useState([]);
  const [exportingPdf, setExportingPdf] = useState(false);
  const passage = analysis.passages[passageIndex];
  const hasPassageSwitcher = analysis.passages.length > 1;
  const correctAnswers = useMemo(
    () => resource.kind === "official" ? getOfficialAnswerKey(resource) : customCorrectAnswers,
    [customCorrectAnswers, resource],
  );
  const selectedOccurrences = useMemo(
    () => new Set(unknownWords.flatMap((word) => word.occurrences || [])),
    [unknownWords],
  );
  const contentRef = useRef(null);
  const activeInkRef = useRef(null);
  const viewportInkCanvasRef = useRef(null);
  const viewportPreviewCanvasRef = useRef(null);
  const previewRenderFrameRef = useRef(null);
  const pendingPreviewActiveRef = useRef(null);
  const inkRenderFrameRef = useRef(null);
  const touchScrollRef = useRef(null);
  const strokesRef = useRef(strokes);
  const pendingStrokeSaveRef = useRef(null);
  const strokeSaveTimerRef = useRef(null);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const penSizeRef = useRef(penSize);
  const penModeRef = useRef(penMode);
  const eraserModeRef = useRef(eraserMode);
  const eraserSizeRef = useRef(eraserSize);
  const positionSaveTimerRef = useRef(null);
  const positionRestoredRef = useRef(false);
  const unknownSelectionRef = useRef(null);
  const stages = [
    ["导读", "deep-cover"], ["审题", "deep-first-read"], ["限时读文", "deep-clean-text"],
    ["初做", "deep-first-quiz"], ["逐段精读", "deep-translation"], ["重做", "deep-redo"], ["复读压缩", "deep-review"],
  ];
  const editionLabel = resource.kind === "custom"
    ? (analysis.method === "ocr" ? "本地 OCR · 结构化精读版" : "本地文本 · 结构化精读版")
    : "考研真题 · 结构化精读版";

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { penSizeRef.current = penSize; }, [penSize]);
  useEffect(() => { penModeRef.current = penMode; }, [penMode]);
  useEffect(() => { eraserModeRef.current = eraserMode; }, [eraserMode]);
  useEffect(() => { eraserSizeRef.current = eraserSize; }, [eraserSize]);
  useEffect(() => {
    if (!showSource) {
      setPenMode(normalizePenMode(getUserItem(PEN_MODE_STORAGE_KEY)));
      setPenSize(normalizePenSize(getUserItem(PEN_SIZE_STORAGE_KEY)));
    }
  }, [showSource]);
  useEffect(() => {
    if (noteMode && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }, [noteMode]);

  useEffect(() => {
    if (!noteMode) return undefined;
    const content = contentRef.current;
    if (!content) return undefined;
    const preventNativePenScroll = (event) => {
      const ownsPointer = activeInkRef.current?.id === event.pointerId
        || unknownSelectionRef.current?.id === event.pointerId;
      if (event.pointerType !== "pen" || (!ownsPointer && !content.contains(event.target))) return;
      if (isActionTarget(event.target) && !ownsPointer) return;
      if (event.cancelable) event.preventDefault();
    };
    const preventParallelTouchScroll = (event) => {
      if (!activeInkRef.current && !unknownSelectionRef.current) return;
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
  }, [noteMode]);

  useEffect(() => {
    const flushOnHide = () => flushPendingStrokeSave();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushPendingStrokeSave();
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      flushPendingStrokeSave();
    };
  }, []);

  useEffect(() => () => {
    if (previewRenderFrameRef.current) window.cancelAnimationFrame(previewRenderFrameRef.current);
  }, []);

  useEffect(() => {
    flushPendingStrokeSave();
    const nextStrokes = loadJson(inkKey(resource.id, passage.id), []);
    strokesRef.current = nextStrokes;
    setStrokes(nextStrokes);
    const savedAnswers = loadJson(answerKey(resource.id, passage.id, "first"), {});
    const legacyAnswers = resource.kind === "custom" ? {} : loadJson(`wuliao:answers:${resource.id}`, {});
    setAnswers(Object.keys(savedAnswers).length ? savedAnswers : legacyAnswers);
    setRedoAnswers(loadJson(answerKey(resource.id, passage.id, "redo"), {}));
    setDrawerAnswers(loadJson(answerKey(resource.id, passage.id, "drawer"), {}));
    setCustomCorrectAnswers(loadJson(customAnswerKey(resource.id, passage.id), {}));
    setCorrectionVisibility({ first: false, redo: false, drawer: false });
    setReadingCompleted(isReadingCompleted(resource.id, passage.id));
    markReadingStarted(resource, passage);
    clearInkPreview();
  }, [resource.id, resource.kind, passage.id]);

  useEffect(() => {
    const refresh = () => listUnknownWords().then((records) => {
      setUnknownWords(records.filter((record) => record.resourceId === resource.id && record.passageId === passage.id));
    });
    refresh();
    window.addEventListener("wuliao:unknown-words-updated", refresh);
    return () => window.removeEventListener("wuliao:unknown-words-updated", refresh);
  }, [resource.id, passage.id]);

  useEffect(() => {
    const ranges = [];
    contentRef.current?.querySelectorAll("[data-unknown-scope]").forEach((scope) => {
      unknownWordRanges(scope).forEach((token) => {
        if (selectedOccurrences.has(token.occurrenceId)) ranges.push(token.range);
      });
    });
    setUnknownHighlight(SAVED_UNKNOWN_HIGHLIGHT, ranges);
    return () => globalThis.CSS?.highlights?.delete(SAVED_UNKNOWN_HIGHLIGHT);
  });

  useEffect(() => () => {
    globalThis.CSS?.highlights?.delete(SAVED_UNKNOWN_HIGHLIGHT);
    globalThis.CSS?.highlights?.delete(ACTIVE_UNKNOWN_HIGHLIGHT);
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const resizeInkLayers = () => {
      const ratio = inkPixelRatio();
      if (viewportInkCanvasRef.current) resizeInkCanvas(viewportInkCanvasRef.current, window.innerWidth, window.innerHeight, ratio);
      if (viewportPreviewCanvasRef.current) resizeInkCanvas(viewportPreviewCanvasRef.current, window.innerWidth, window.innerHeight, ratio);
      renderCommittedInk();
    };
    const observer = new ResizeObserver(scheduleCommittedInkRender);
    observer.observe(content);
    resizeInkLayers();
    window.addEventListener("resize", resizeInkLayers);
    window.addEventListener("scroll", scheduleCommittedInkRender, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeInkLayers);
      window.removeEventListener("scroll", scheduleCommittedInkRender);
      if (inkRenderFrameRef.current) window.cancelAnimationFrame(inkRenderFrameRef.current);
      inkRenderFrameRef.current = null;
    };
  }, [passage.id, showSource]);

  useEffect(() => {
    scheduleCommittedInkRender();
  }, [strokes, drawerOpen, topAreaCollapsed]);

  useEffect(() => {
    if (positionRestoredRef.current) return;
    const saved = loadJson(positionKey(resource.id), null);
    if (!saved || saved.passageId !== passage.id) {
      positionRestoredRef.current = true;
      return;
    }
    const restore = () => {
      const anchor = document.getElementById(saved.anchorId || "deep-cover");
      const anchoredTop = anchor ? anchor.offsetTop + (saved.offset || 0) : 0;
      const exactTop = Number.isFinite(saved.scrollY) ? saved.scrollY : anchoredTop;
      window.scrollTo({ top: Math.max(0, exactTop), behavior: "auto" });
      positionRestoredRef.current = true;
    };
    const first = window.requestAnimationFrame(() => window.requestAnimationFrame(restore));
    // Web fonts and textarea sizing can settle after the first two frames.
    // Re-apply the exact position once, after layout has stabilized.
    const settled = window.setTimeout(restore, 420);
    return () => {
      window.cancelAnimationFrame(first);
      window.clearTimeout(settled);
    };
  }, [resource.id, passage.id]);

  useEffect(() => {
    const scheduleSave = () => {
      if (positionSaveTimerRef.current) return;
      positionSaveTimerRef.current = window.setTimeout(() => {
        positionSaveTimerRef.current = null;
        saveReadingPosition();
      }, 220);
    };
    const flushPosition = () => {
      if (positionSaveTimerRef.current) window.clearTimeout(positionSaveTimerRef.current);
      positionSaveTimerRef.current = null;
      saveReadingPosition();
    };
    window.addEventListener("scroll", scheduleSave, { passive: true });
    window.addEventListener("pagehide", flushPosition);
    return () => {
      window.removeEventListener("scroll", scheduleSave);
      window.removeEventListener("pagehide", flushPosition);
      flushPosition();
    };
  }, [resource.id, passage.id, activeStage]);

  useEffect(() => {
    const finishExport = (event) => {
      setExportingPdf(false);
      setHint(event.detail?.success ? `精读成品已保存：${event.detail.location || "Download/无聊英语"}` : `PDF 导出失败：${event.detail?.message || "未知错误"}`);
      window.setTimeout(() => setHint(""), 3200);
    };
    window.addEventListener("wuliao-pdf-export-result", finishExport);
    return () => window.removeEventListener("wuliao-pdf-export-result", finishExport);
  }, []);

  function jumpTo(id) {
    setActiveStage(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function saveReadingPosition() {
    const anchors = stages
      .map(([, id]) => document.getElementById(id))
      .filter(Boolean);
    const targetY = window.scrollY + 150;
    const anchor = [...anchors].reverse().find((item) => item.offsetTop <= targetY) || anchors[0];
    if (!anchor) return;
    setUserItem(positionKey(resource.id), JSON.stringify({
      passageId: passage.id,
      anchorId: anchor.id,
      offset: Math.max(0, window.scrollY - anchor.offsetTop),
      scrollY: window.scrollY,
      updatedAt: Date.now(),
    }));
  }

  function persistStrokes(next) {
    strokesRef.current = next;
    setStrokes(next);
    renderCommittedInk();
    pendingStrokeSaveRef.current = {
      key: inkKey(resource.id, passage.id),
      strokes: next,
    };
    if (strokeSaveTimerRef.current) window.clearTimeout(strokeSaveTimerRef.current);
    strokeSaveTimerRef.current = window.setTimeout(flushPendingStrokeSave, 300);
  }

  function flushPendingStrokeSave() {
    if (strokeSaveTimerRef.current) window.clearTimeout(strokeSaveTimerRef.current);
    strokeSaveTimerRef.current = null;
    const pending = pendingStrokeSaveRef.current;
    if (!pending) return;
    setUserItem(pending.key, JSON.stringify(pending.strokes));
    pendingStrokeSaveRef.current = null;
  }

  function chooseAnswer(attempt, number, option) {
    const setter = attempt === "first"
      ? setAnswers
      : attempt === "redo"
        ? setRedoAnswers
        : setDrawerAnswers;
    setter((current) => {
      const next = { ...current, [number]: option };
      setUserItem(answerKey(resource.id, passage.id, attempt), JSON.stringify(next));
      return next;
    });
  }

  function showHint(message) {
    setHint(message);
    window.setTimeout(() => setHint(""), 2200);
  }

  function toggleCorrection(scope) {
    if (correctionVisibility[scope]) {
      setCorrectionVisibility((current) => ({ ...current, [scope]: false }));
      return;
    }
    if (Object.keys(correctAnswers).length) {
      setCorrectionVisibility((current) => ({ ...current, [scope]: true }));
      return;
    }
    const value = window.prompt(
      "这份自定义资料没有识别到答案。请输入本篇答案，例如：21C 22B 23A 24C 25D；也可以只输入 CBACD。",
      "",
    );
    if (value === null) return;
    const parsed = parseAnswerInput(value, passage.questions);
    const valid = Object.fromEntries(
      Object.entries(parsed).filter(([number, answer]) => (
        passage.questions.some((question) => String(question.number) === String(number)) && /^[A-D]$/.test(answer)
      )),
    );
    if (!Object.keys(valid).length) {
      showHint("没有识别到有效答案，请按 21C 22B 或 CBACD 的格式输入");
      return;
    }
    setUserItem(customAnswerKey(resource.id, passage.id), JSON.stringify(valid));
    setCustomCorrectAnswers(valid);
    setCorrectionVisibility((current) => ({ ...current, [scope]: true }));
  }

  function toggleReadingCompleted() {
    const next = !readingCompleted;
    persistReadingCompleted(resource, passage, next);
    setReadingCompleted(next);
    showHint(next ? "已计入本机段位" : "已从完成篇数中移除");
  }

  function pointFromEvent(event) {
    return pointerPointFromSample(event, contentRef.current.getBoundingClientRect(), event.pointerType === "pen");
  }

  function coalescedPointsFromEvent(event) {
    return coalescedPointerPoints(event, contentRef.current.getBoundingClientRect());
  }

  function clearInkPreview() {
    if (previewRenderFrameRef.current) window.cancelAnimationFrame(previewRenderFrameRef.current);
    previewRenderFrameRef.current = null;
    pendingPreviewActiveRef.current = null;
    const canvas = viewportPreviewCanvasRef.current;
    if (canvas) renderInkLayer(canvas, [], window.innerWidth, window.innerHeight);
  }

  function drawViewportPreview(active) {
    const canvas = viewportPreviewCanvasRef.current;
    if (!canvas || !active.previewPoints?.length) return;
    const ratio = Number(canvas.dataset.ratio) || 1;
    const stroke = {
      ...active.stroke,
      points: active.previewPoints.map((point) => ({
        ...point,
        x: point.x / Math.max(1, window.innerWidth),
        y: point.y / Math.max(1, window.innerHeight),
      })),
    };
    renderInkLayer(canvas, [stroke], window.innerWidth, window.innerHeight, ratio);
  }

  function renderViewportPreview(active) {
    pendingPreviewActiveRef.current = active;
    if (previewRenderFrameRef.current) return;
    previewRenderFrameRef.current = window.requestAnimationFrame(() => {
      previewRenderFrameRef.current = null;
      const pending = pendingPreviewActiveRef.current;
      pendingPreviewActiveRef.current = null;
      if (pending) drawViewportPreview(pending);
    });
  }

  function renderCommittedInk(extraStroke = null) {
    const canvas = viewportInkCanvasRef.current;
    const content = contentRef.current;
    if (!canvas || !content) return;
    const contentRect = content.getBoundingClientRect();
    const visibleTop = Math.max(0, (-contentRect.top / Math.max(1, contentRect.height)) - 0.01);
    const visibleBottom = Math.min(1, ((window.innerHeight - contentRect.top) / Math.max(1, contentRect.height)) + 0.01);
    const source = extraStroke ? [...strokesRef.current, extraStroke] : strokesRef.current;
    const visible = source
      .filter((stroke) => {
        const bounds = normalizedStrokeBounds(stroke);
        return bounds.maxY >= visibleTop && bounds.minY <= visibleBottom;
      })
      .map((stroke) => projectStrokeToViewport(stroke, contentRect));
    renderInkLayer(canvas, visible, window.innerWidth, window.innerHeight);
  }

  function scheduleCommittedInkRender() {
    if (inkRenderFrameRef.current) return;
    inkRenderFrameRef.current = window.requestAnimationFrame(() => {
      inkRenderFrameRef.current = null;
      renderCommittedInk();
    });
  }

  function capturePointer(event) {
    const targets = [viewportInkCanvasRef.current, event.currentTarget].filter(Boolean);
    for (const target of targets) {
      try {
        target.setPointerCapture?.(event.pointerId);
        return;
      } catch {
        // Fall back to the original event surface when WebView rejects cross-element capture.
      }
    }
  }

  function isActionTarget(target) {
    return target instanceof Element && Boolean(target.closest("button, select, input[type='checkbox'], input[type='radio'], [role='button']"));
  }

  function collectUnknownToken(event) {
    const token = unknownWordFromPoint(event.clientX, event.clientY);
    if (!token || !unknownSelectionRef.current) return;
    unknownSelectionRef.current.tokens.set(token.occurrenceId, token);
    setUnknownHighlight(
      ACTIVE_UNKNOWN_HIGHLIGHT,
      [...unknownSelectionRef.current.tokens.values()].map((item) => item.range),
    );
  }

  async function commitUnknownSelection(selection) {
    try {
      for (const token of selection.tokens.values()) {
        const normalizedWord = normalizeUnknownWord(token.word);
        if (!normalizedWord) continue;
        let meaning = await lookupUnknownWordMeaning(token.word);
        const current = unknownWords.find((word) => word.normalizedWord === normalizedWord);
        meaning ||= current?.meaning || "";
        if (!meaning) {
          const entered = window.prompt(`离线词库没有收录 ${token.word}，请补充中文释义`, "");
          if (entered === null) continue;
          meaning = entered.trim();
        }
        await toggleUnknownWord({
          resourceId: resource.id,
          passageId: passage.id,
          passageLabel: passage.label,
          year: resource.year || null,
          chapter: resource.text ? `Text ${resource.text} · ${passage.label}` : passage.label,
          word: token.word,
          normalizedWord,
          meaning,
          occurrenceId: token.occurrenceId,
        });
      }
    } finally {
      globalThis.CSS?.highlights?.delete(ACTIVE_UNKNOWN_HIGHLIGHT);
    }
    setHint(selection.tokens.size ? "陌生词库已更新" : "笔尖没有经过英文单词");
    window.setTimeout(() => setHint(""), 1500);
  }

  function handleInkDown(event) {
    if (!noteMode) return;
    if (event.pointerType === "touch") {
      if (isActionTarget(event.target)) return;
      event.preventDefault();
      capturePointer(event);
      touchScrollRef.current = {
        id: event.pointerId,
        startY: event.clientY,
        startScrollY: window.scrollY,
      };
      return;
    }
    if (isActionTarget(event.target)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    capturePointer(event);
    if (toolRef.current === "unknown") {
      unknownSelectionRef.current = { id: event.pointerId, tokens: new Map() };
      collectUnknownToken(event);
      return;
    }
    const point = pointFromEvent(event);
    const active = {
      id: event.pointerId,
      pointerType: event.pointerType,
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
      previewPoints: [point.viewport],
      timer: null,
    };
    if (active.stroke.tool === "eraser") renderCommittedInk(active.stroke);
    else renderViewportPreview(active);
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
        active.previewPoints = active.previewPoints.slice(-1);
        if (temporaryMode === "lasso") renderViewportPreview(active);
        else renderCommittedInk(active.stroke);
        toolRef.current = "eraser";
        setTool("eraser");
        setHint(temporaryMode === "lasso" ? "临时自由套索：圈选后抬笔删除" : "临时普通橡皮：保持按压并移动");
        navigator.vibrate?.(35);
      }, 620);
    }
    activeInkRef.current = active;
  }

  function handleInkMove(event) {
    const touchScroll = touchScrollRef.current;
    if (event.pointerType === "touch" && touchScroll?.id === event.pointerId) {
      event.preventDefault();
      window.scrollTo(0, touchScroll.startScrollY + touchScroll.startY - event.clientY);
      return;
    }
    const unknownSelection = unknownSelectionRef.current;
    if (unknownSelection?.id === event.pointerId) {
      event.preventDefault();
      collectUnknownToken(event);
      return;
    }
    const active = activeInkRef.current;
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
    active.previewPoints.push(...points.map((sample) => sample.viewport));
    strokeBoundsCache.delete(active.stroke);
    if (active.stroke.tool === "eraser") renderCommittedInk(active.stroke);
    else renderViewportPreview(active);
  }

  function appendPointerUpPoint(active, event) {
    if (event.type !== "pointerup") return;
    const point = pointFromEvent(event);
    const last = active.stroke.points[active.stroke.points.length - 1];
    if (!last || Math.hypot(last.x - point.normalized.x, last.y - point.normalized.y) > 0.00002) {
      active.stroke.points.push(point.normalized);
      active.previewPoints.push(point.viewport);
      strokeBoundsCache.delete(active.stroke);
    }
  }

  function finishInk(event) {
    if (event.pointerType === "touch" && touchScrollRef.current?.id === event.pointerId) {
      event.preventDefault();
      touchScrollRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    const unknownSelection = unknownSelectionRef.current;
    if (unknownSelection?.id === event.pointerId) {
      unknownSelectionRef.current = null;
      commitUnknownSelection(unknownSelection).catch((reason) => {
        setHint(`陌生词保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
      });
      return;
    }
    const active = activeInkRef.current;
    if (!active || active.id !== event.pointerId) return;
    appendPointerUpPoint(active, event);
    // Match a native notebook's continuous pen-up: commit first, then remove the live preview.
    if (active.stroke.tool !== "lasso") renderCommittedInk(active.stroke);
    clearInkPreview();
    if (active.stroke.tool === "lasso") {
      if (active.moved && active.stroke.points.length > 2) {
        const next = eraseAnnotationsInPolygon(strokesRef.current, active.stroke.points);
        const deleted = strokesRef.current.length - next.length;
        if (deleted) persistStrokes(next);
        setHint(deleted ? `已删除真实圈选范围内 ${deleted} 条笔迹` : "圈选范围内没有笔迹");
        window.setTimeout(() => setHint(""), 1600);
      }
      renderCommittedInk();
    } else {
      persistStrokes([...strokesRef.current, active.stroke]);
    }
    if (active.temporaryEraser) {
      toolRef.current = "pen";
      setTool("pen");
      setHint("已恢复画笔");
      window.setTimeout(() => setHint(""), 900);
    }
    activeInkRef.current = null;
  }

  function cancelInk(event) {
    if (event.pointerType === "touch" && touchScrollRef.current?.id === event.pointerId) {
      touchScrollRef.current = null;
      return;
    }
    finishInk(event);
  }

  function clearNotes() {
    if (strokes.length && window.confirm("清除这篇精读的全部笔迹？")) persistStrokes([]);
  }

  function isTextEntryTarget(target) {
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLInputElement) {
      return !["button", "checkbox", "color", "radio", "range"].includes(target.type);
    }
    return target instanceof HTMLElement && target.isContentEditable;
  }

  function blockInkModeTextInput(event) {
    if (androidApp && noteMode && isTextEntryTarget(event.target)) event.preventDefault();
  }

  function redirectPenFromTextField(event) {
    if (!androidApp || event.pointerType !== "pen" || !isTextEntryTarget(event.target)) return;
    event.target.blur?.();
    if (!noteMode) {
      setNoteMode(true);
      clearInkPreview();
      setHint("检测到手写笔，已切换为原始笔迹；请继续书写");
      window.setTimeout(() => setHint(""), 1800);
    }
  }

  function chooseEraserMode(value) {
    setEraserMode(value);
    setUserItem("wuliao:pref:eraser-mode", value);
    setTool("eraser");
    setNoteMode(true);
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
    const before = contentRef.current?.getBoundingClientRect().top || 0;
    setTopAreaCollapsed(next);
    window.requestAnimationFrame(() => {
      const after = contentRef.current?.getBoundingClientRect().top || 0;
      window.scrollBy({ top: after - before, behavior: "auto" });
    });
  }

  function exportFinishedPdf() {
    if (exportingPdf) return;
    setExportingPdf(true);
    const fileName = `${resource.year || "自定义"}-${resource.text ? `Text-${resource.text}` : passage.label}-精读成品.pdf`;
    window.requestAnimationFrame(() => window.setTimeout(() => {
      if (window.AndroidPdfExporter?.exportCurrentDocument) {
        window.AndroidPdfExporter.exportCurrentDocument(fileName);
      } else {
        window.print();
        setExportingPdf(false);
      }
    }, 180));
  }

  if (showSource) {
    const referenceSource = resource.referencePdfSource || resource.source;
    return (
      <PdfReader
        resource={{
          ...resource,
          id: `${resource.id}:reference`,
          title: `${resource.title} · 原卷节选`,
          subtitle: "原卷对照 · 本篇文章与 5 道题",
          source: referenceSource,
        }}
        onClose={() => setShowSource(false)}
      />
    );
  }

  return (
    <div className={`reader-page custom-reader-page custom-workbook-page ${hasPassageSwitcher ? "has-passage-switcher" : ""} ${drawerOpen ? "drawer-open" : ""} ${topAreaCollapsed ? "top-area-collapsed" : ""} ${exportingPdf ? "exporting-pdf" : ""}`}>
      <header className="reader-header">
        <button className="back-button light" onClick={onClose}>← 资料库</button>
        <div className="reader-title"><small>{editionLabel}</small><strong>{resource.title}</strong></div>
        <div className="reader-header-actions">
          <button className="export-pdf-button" onClick={exportFinishedPdf} disabled={exportingPdf}>{exportingPdf ? "正在导出…" : "导出成品 PDF"}</button>
          <button className="source-button" onClick={() => setShowSource(true)}>查看原 PDF</button>
          <div className="reader-status"><span /> 本地模式</div>
        </div>
      </header>

      <nav className="stage-nav custom-workbook-stage" aria-label="精读流程">
        {stages.map(([label, id], index) => <button key={id} className={activeStage === id ? "active" : ""} onClick={() => jumpTo(id)}><span>{index + 1}</span>{label}</button>)}
      </nav>

      {hasPassageSwitcher && (
        <div className="passage-switcher">
          <span>已识别 {analysis.passages.length} 篇仔细阅读</span>
          <div>{analysis.passages.map((item, index) => (
            <button key={item.id} className={passageIndex === index ? "active" : ""} onClick={() => { saveReadingPosition(); positionRestoredRef.current = true; setPassageIndex(index); setActiveStage("deep-cover"); window.scrollTo({ top: 0 }); }}>{item.label}</button>
          ))}</div>
        </div>
      )}

      <AnnotationToolbar
        tool={tool}
        color={color}
        annotations={strokes}
        noteMode={noteMode}
        onToggleNoteMode={() => { setNoteMode((current) => !current); clearInkPreview(); }}
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
        onUndo={() => persistStrokes(strokesRef.current.slice(0, -1))}
        collapsible
        onCollapsedChange={changeTopAreaCollapsed}
        onClear={clearNotes}
        unknownEnabled
        tabletInk={androidApp}
      />

      <main
        ref={contentRef}
        className={`deep-reader-content ${noteMode ? "note-mode" : ""}`}
        key={passage.id}
        onPointerDownCapture={(event) => { redirectPenFromTextField(event); handleInkDown(event); }}
        onPointerMoveCapture={handleInkMove}
        onPointerUpCapture={finishInk}
        onPointerCancelCapture={cancelInk}
        onLostPointerCapture={finishInk}
        onBeforeInputCapture={blockInkModeTextInput}
        onFocusCapture={(event) => {
          if (androidApp && noteMode && isTextEntryTarget(event.target)) event.target.blur();
        }}
      >
        <PassageWorkbook
          resource={resource}
          passage={passage}
          analysis={analysis}
          answers={answers}
          onAnswer={(number, option) => chooseAnswer("first", number, option)}
          redoAnswers={redoAnswers}
          onRedoAnswer={(number, option) => chooseAnswer("redo", number, option)}
          correctAnswers={correctAnswers}
          correctionVisibility={correctionVisibility}
          onToggleCorrection={toggleCorrection}
          readingCompleted={readingCompleted}
          onToggleReadingCompleted={toggleReadingCompleted}
          inkOnly={androidApp && noteMode}
        />
      </main>
      <canvas
        ref={viewportInkCanvasRef}
        className="custom-viewport-ink-canvas"
        onPointerMove={handleInkMove}
        onPointerUp={finishInk}
        onPointerCancel={cancelInk}
        onLostPointerCapture={finishInk}
        aria-hidden="true"
      />
      <canvas ref={viewportPreviewCanvasRef} className="custom-viewport-ink-preview" aria-hidden="true" />
      <div className="print-watermark" aria-hidden="true" />

      <button className={`question-fab ${drawerOpen ? "hidden" : ""}`} onClick={() => setDrawerOpen(true)}>
        <span>题</span><strong>习题</strong><small>{passage.questions.length || "·"}</small>
      </button>
      <QuestionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        questions={passage.questions}
        parseInfo={{ status: passage.questions.length ? "ready" : "text-only" }}
        answers={drawerAnswers}
        onAnswer={(number, option) => chooseAnswer("drawer", number, option)}
        correctAnswers={correctAnswers}
        correctionVisible={correctionVisibility.drawer}
        onToggleCorrection={() => toggleCorrection("drawer")}
      />

      {hint && <div className="toast">{hint}</div>}
    </div>
  );
}
