import { createInkUndoPatch } from "./ink/inkUndo.js";
import {
  createContext,
  forwardRef,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import PdfReader, { AnnotationToolbar, QuestionDrawer } from "./PdfReader";
import { useSaveBoundary } from "./useSaveBoundary.js";
import AiFloatWindow from "./AiFloatWindow";
import { ReaderStageMarker } from "./ui/ReaderChrome";
import { useBackHandler } from "./ui/BackContext";
import { BACK_PRIORITY } from "./ui/backController";
import { useMotionPresence } from "./ui/useMotionPresence";
import { useReaderPaperLayout } from "./ui/useReaderPaperLayout";
import TranslationTranscriptionModal from "./TranslationTranscriptionModal";
import TranslationOcrModal from "./TranslationOcrModal";
import "./translationOcr.css";
import { captureTranslationInk } from "./translationOcrImage.js";
import { translationOcrTarget, readTranslationOcr, pendingLegacyTranslation, saveConfirmedTranslation } from "./translationOcrStorage.js";
import ArticleLearningSummaryPanel from "./ArticleLearningSummary.jsx";
import {
  TASK_QUESTION_EXPLANATION,
  TASK_QUESTION_HINT_1,
  TASK_QUESTION_HINT_2,
  TASK_QUESTION_DIAGNOSIS,
  TASK_TRANSLATION_REVIEW,
} from "./aiTasks";
import { getQuestionDiagnosisEntryLabel } from "./questionDiagnosisService";
import {
  drawInkStroke,
  eraseAnnotationsInPolygon,
  inkPixelRatio,
  normalizePenMode,
  normalizePenSize,
  PEN_MODE_STORAGE_KEY,
  PEN_SIZE_STORAGE_KEY,
  resizeInkCanvas,
  renderInkLayer,
} from "./annotationTools";
import { isAndroidApp } from "./platform";
import { createDebouncedStorageWriter } from "./debouncedStorage";
import {
  passageClearableKeys,
  passageInkKey as inkKey,
  passageStageInkKey,
  passageStageInkMigrationKey,
  translationMethodKey,
  translationLegacyDismissedKey,
  translationTextKey as translationKey,
} from "./deepReaderKeys";
import {
  installPenScrollGuard,
  tileRangeForStroke,
} from "./inkEngine";
import { useStructuredInk } from "./ink/useStructuredInk";
import { exposeInkHandoffStats, recordInkHandoff } from "./inkDebug";
import { buildDeepInkRegionSnapshot, createDeepInkGeometryAdapter, deepInkPreviewLayout, deepInkPreviewPoint, reuseDeepInkGeometry } from "./deepInkGeometry";
import { createDeepInkChangeSource, createDeepInkStageCache, createDeepInkTileIndex } from "./deepInkRenderCache.js";
import { createInkTileBitmapCache, createInkTileRenderer } from "./ink/inkTileRenderer.js";
import { deepInkDigest, mergeDeepInkStrokes, partitionDeepInkByStage } from "./deepStageInk";
import { getTelemetry } from "./telemetry/telemetry";
import { getOfficialAnswerKey } from "./answerKeys";
import { hasReliableOfficialAnswer, questionCapabilities } from "./questionCapabilities";
import { listLearningRecords, updateTagStatus } from "./aiLearningRecords";
import {
  isReadingCompleted,
  markReadingStarted,
  setReadingCompleted as persistReadingCompleted,
} from "./studyRank";
import { deleteUnknownWord, listUnknownWords, toggleUnknownWord, updateUnknownWordMeaning } from "./storage";
import { lookupUnknownWordMeaning, normalizeUnknownWord } from "./unknownWords";
import {
  ACTIVE_UNKNOWN_HIGHLIGHT,
  SAVED_UNKNOWN_HIGHLIGHT,
  collectUnknownTokenInto,
  createUnknownSelectionHooks,
  highlightSavedUnknownWords,
} from "./unknownWordInteraction";
import { getCurrentUsername, getUserItem, removeUserItem, setUserItem } from "./userData";
import { backgroundSave, saveBeforeNavigation, scheduleInkSave, cancelScheduledInkSave } from "./saveCoordinator.js";
import { createInkSnapshotSerializer } from "./ink/inkSnapshot.js";
import { setUserItem as writeOwnedUserItem } from "./userData.js";
import { getAiApiKey, lookupWordMeaningWithAi } from "./ai";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";
import {
  STAGE_IDS,
  STAGE_LABELS,
  completeStage as completeFlowStage,
  enterInitialStage,
  enterReadingStage,
  activeQuestionAttempt as attemptForFlow,
  isStageLocked,
  finishTimedReading,
  flowStorageKey,
  getReadingFlow,
  isWorkflowCompleted,
  pauseTimedReading,
  resumeTimedReading,
  saveReadingFlow,
  timedReadingElapsed,
  undoWorkflowCompletion,
} from "./readingFlow";

import {
  canCompleteTranslationWorkbook,
  countsForPassage,
  handleTranslationEdited as progressHandleTranslationEdited,
  loadTranslationProgress,
  markCorrected as progressMarkCorrected,
  markParagraphCompleted,
  markTranslated as progressMarkTranslated,
  nextTranslationTodo,
  paragraphState,
  saveTranslationProgress,
  sentenceEntryFor,
  sentenceKeyFor,
  setReviewStatus as progressSetReviewStatus,
  shouldEnforceTranslationGating,
  resetPassageProgress,
} from "./translationProgress";
import {
  GLOBAL_TYPES,
  GLOBAL_TYPE_LABELS,
  TEXT_TYPES,
  addTextRange,
  addSentenceRef,
  removeSentenceRef,
  buildSentenceRef,
  compareAttempts,
  draftFromEntry,
  emptyTextEvidenceEntry,
  entryComplete,
  entryFor,
  entryNeedsType,
  entryResolutionOk,
  entrySummaryLabel,
  loadEvidenceStore,
  questionEvidenceComplete,
  questionKeyFor,
  quizCompletion,
  removeTextRange,
  resolveEntry,
  saveEvidenceStore,
  sentenceRefLabel,
  setEvidence,
  setEvidenceMode,
  setEvidenceNote,
  setGlobalType,
  setTextType,
  textRangeExcerpt,
} from "./questionEvidence";
import {
  evidenceRangeFromSelection,
  showEvidenceHighlight,
} from "./questionEvidenceHighlight";
import ReviewSession, {
  ReviewCheckPanel,
  ReviewCompleteCard,
} from "./ReviewSession";
import {
  completeReviewSession,
  createNextDayReviewTask,
  listReviewTasks,
  loadReviewTask,
  pauseReviewTiming,
  resumeReviewTiming,
  scheduleManualReviewTask,
  startReviewSession,
  TASK_TYPE_NEXT_DAY,
  wrongQuestionKeys,
} from "./readingReview";

const inkScopeStageId = (stageId) => stageId === "deep-clean-text" ? "deep-first-quiz" : stageId;
const DeepInkContext = createContext(null);

function loadJson(key, fallback) {
  try { return JSON.parse(getUserItem(key)) || fallback; } catch { return fallback; }
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatArticleText(value) {
  return String(value || "")
    .replace(/[—–―]/g, "--")
    .replace(/[‐‑]/g, "-")
    .replace(/(^|\s)-(?=\s|$)/g, "$1--");
}

// 陌生词 token 识别 / hit-test / highlight 已抽到共享模块 unknownWordInteraction.js
// （精读 / 完形共用同一套实现，禁止各自维护副本）。

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

const customAnswerKey = (resourceId, passageId) => `wuliao:custom-answer-key:${resourceId}:${passageId}`;

const translationSentenceId = (resource, passage, paragraphNumber, sentenceIndex) => `${resource.id}::${passage.id}::p${paragraphNumber}s${sentenceIndex + 1}`;

function chapterLabel(resource, passage) {
  return resource.kind === "official"
    ? `英一.${String(resource.year).slice(-2)}.text${resource.text}`
    : (resource.title || passage.label || "自定义");
}

function isEraserStroke(stroke) {
  const tool = stroke?.tool || stroke?.mode;
  return tool === "eraser" || tool === "lasso" || stroke?.mode === "normal-eraser";
}

function translationStatusLabel(entry) {
  const status = entry?.translationStatus || "pending";
  const review = entry?.reviewStatus;
  if (status === "pending") return "未译";
  if (status === "corrected") {
    if (review === "mastered") return "已掌握";
    if (review === "needs_review") return "需复盘";
    return "已订正";
  }
  return "已译";
}

function inkStrokesHitElement(strokes, element, contentEl, projectStroke = (value) => value) {
  if (!element || !contentEl) return false;
  const contentRect = contentEl.getBoundingClientRect();
  if (!contentRect.width || !contentRect.height) return false;
  // 命中必须始终基于当前 DOM；正文增高或上方内容变化时 element rect 可变，不能缓存旧归一化值。
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const region = {
    left: (rect.left - contentRect.left) / contentRect.width,
    right: (rect.right - contentRect.left) / contentRect.width,
    top: (rect.top - contentRect.top) / contentRect.height,
    bottom: (rect.bottom - contentRect.top) / contentRect.height,
  };
  return strokes.some((stroke) => {
    if (isEraserStroke(stroke)) return false;
    const bounds = normalizedStrokeBounds(projectStroke(stroke));
    return bounds.maxX >= region.left && bounds.minX <= region.right
      && bounds.maxY >= region.top && bounds.minY <= region.bottom;
  });
}

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

const ClearableTextContext = createContext(null);

const ClearableTextProvider = forwardRef(function ClearableTextProvider(
  { onPresenceChange, children },
  ref,
) {
  const entriesRef = useRef(new Map());

  const notify = useCallback(() => {
    let present = false;
    entriesRef.current.forEach((entry) => {
      if (entry.present) present = true;
    });
    onPresenceChange?.(present);
  }, [onPresenceChange]);

  const api = useMemo(() => ({
    register(key, reset) {
      entriesRef.current.set(key, { reset, present: false });
      notify();
    },
    unregister(key) {
      entriesRef.current.delete(key);
      notify();
    },
    reportPresence(key, present) {
      const entry = entriesRef.current.get(key);
      if (!entry) return;
      entry.present = Boolean(present);
      notify();
    },
    resetAll() {
      entriesRef.current.forEach((entry) => entry.reset());
      notify();
    },
  }), [notify]);

  useImperativeHandle(ref, () => ({ resetAll: api.resetAll }), [api]);

  return (
    <ClearableTextContext.Provider value={api}>
      {children}
    </ClearableTextContext.Provider>
  );
});

function useClearableTextEntry(storageKey, reset, hasValue) {
  const clearable = useContext(ClearableTextContext);

  useEffect(() => {
    if (!clearable) return undefined;
    clearable.register(storageKey, reset);
    clearable.reportPresence(storageKey, Boolean(hasValue));
    return () => clearable.unregister(storageKey);
  }, [clearable, storageKey, reset, hasValue]);
}

function useDebouncedStorageText(storageKey, delay = 300) {
  const username = getCurrentUsername();
  const writer = useMemo(() => createDebouncedStorageWriter({
      read: () => getUserItem(storageKey, username) || "",
      write: (next) => setUserItem(storageKey, next, username),
      remove: () => removeUserItem(storageKey, username),
      schedule: (callback, ms) => window.setTimeout(() => backgroundSave(callback), ms),
      cancel: (id) => window.clearTimeout(id),
      delay,
    }), [storageKey, username, delay]);
  const [value, setValueState] = useState(() => writer.latest());
  useEffect(() => { setValueState(writer.latest()); }, [writer]);

  const setValue = useCallback((next) => {
    setValueState(next);
    writer.setLatest(next);
  }, [writer]);

  const replaceValue = useCallback((next) => {
    setValueState(next);
    writer.replaceLatest(next);
  }, [writer]);

  const reset = useCallback(() => {
    setValueState("");
    writer.reset();
  }, [writer]);

  const flush = useCallback(() => {
    writer.flush();
  }, [writer]);
  useSaveBoundary(flush);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") backgroundSave(writer.flush);
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    const flushOnHide = () => backgroundSave(writer.flush);
    window.addEventListener("pagehide", flushOnHide);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushOnHide);
      backgroundSave(writer.flush);
    };
  }, [writer]);

  return { value, setValue, replaceValue, reset, flush };
}

function stableScrollToElement(element, { offset = 90, settleMs = 380, retries = 0, retryDelay = 220 } = {}) {
  if (!element) return false;
  const attempt = () => {
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      const rect = element.getBoundingClientRect();
      if (rect.top < -60 || rect.top > Math.max(120, window.innerHeight * 0.8)) {
        window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - offset), behavior: "auto" });
      }
    }, settleMs);
  };
  attempt();
  for (let index = 1; index <= retries; index += 1) {
    window.setTimeout(attempt, retryDelay * index);
  }
  return true;
}

function SavedLines({ storageKey, lines = 2, label, inkOnly = false }) {
  const { value, setValue, flush, reset } = useDebouncedStorageText(storageKey);
  useClearableTextEntry(storageKey, reset, value.trim().length > 0);
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
      }}
      onBlur={flush}
    />
  );
}

function TranslationUnit({
  resource,
  passage,
  sentence,
  paragraph,
  paragraphNumber,
  sentenceIndex,
  lines,
  projectInkStroke,
  inkOnly,
  onRequestTranscription,
  onRequestOcr,
  onValidateOcr,
  progressEntry,
  onMarkTranslated,
  onMarkCorrected,
  onSetReviewStatus,
  onTranslationEdited,
  readOnly = false,
}) {
  const storageKey = translationKey(resource.id, passage.id, paragraphNumber, sentenceIndex);
  const methodKey = translationMethodKey(resource.id, passage.id, paragraphNumber, sentenceIndex);
  const ocrIdentity = translationOcrTarget({ resourceId: resource.id, passageId: passage.id, paragraphNumber, sentenceIndex, sentence });
  const [ocrMetadata, setOcrMetadata] = useState(() => readTranslationOcr(ocrIdentity));
  const [legacyText, setLegacyText] = useState(() => pendingLegacyTranslation(ocrIdentity));
  const sentenceId = translationSentenceId(resource, passage, paragraphNumber, sentenceIndex);
  const { value, setValue, replaceValue, flush, reset: resetText } = useDebouncedStorageText(storageKey, 400);
  const translationEditTimerRef = useRef(null);
  const rootRef = useRef(null);
  const inkChanges = useContext(DeepInkContext);
  const [hasInk, setHasInk] = useState(false);
  const hasInkRef = useRef(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const resetUnit = useCallback(() => {
    if (translationEditTimerRef.current) window.clearTimeout(translationEditTimerRef.current);
    translationEditTimerRef.current = null;
    resetText();
    setOcrMetadata(null);
    setLegacyText(null);
  }, [resetText]);
  useClearableTextEntry(storageKey, resetUnit, value.trim().length > 0 || Boolean(legacyText));

  useEffect(() => {
    const syncFromStorage = (event) => {
      if (event.detail?.key !== storageKey) return;
      if (event.detail?.username && event.detail.username !== ocrIdentity.username) return;
      replaceValue(getUserItem(storageKey) || "");
      setOcrMetadata(readTranslationOcr(ocrIdentity));
      setLegacyText(pendingLegacyTranslation(ocrIdentity));
    };
    window.addEventListener("wuliao:deep-translation:updated", syncFromStorage);
    return () => window.removeEventListener("wuliao:deep-translation:updated", syncFromStorage);
  }, [storageKey, ocrIdentity.username]);

  useEffect(() => () => {
    if (translationEditTimerRef.current) window.clearTimeout(translationEditTimerRef.current);
    translationEditTimerRef.current = null;
  }, []);

  // Subscribe locally: a new stroke can change this unit's controls, but must
  // not re-render the whole workbook. Every delta is consumed, even when React
  // batches several pen-up events before committing the next render.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !inkChanges) return;
    const contentEl = root.closest(".deep-reader-content");
    const regionEl = root.closest(".sentence-work") || root;
    const update = ({ strokes, reset, added, removed }) => {
      let next = hasInkRef.current;
      if (!strokes.length) next = false;
      else if (reset || (removed.length && next)) {
        next = inkStrokesHitElement(strokes, regionEl, contentEl, projectInkStroke);
      } else if (added.length && !next) {
        next = inkStrokesHitElement(added, regionEl, contentEl, projectInkStroke);
      }
      if (next !== hasInkRef.current) {
        hasInkRef.current = next;
        setHasInk(next);
      }
    };
    const unsubscribe = inkChanges.subscribe(update);
    update({ ...inkChanges.getSnapshot(), reset: true });
    return unsubscribe;
  }, [inkChanges, projectInkStroke, storageKey]);

  useEffect(() => {
    const onStart = (event) => {
      if (event.detail?.sentenceId === sentenceId) setReviewBusy(true);
    };
    const onFinish = (event) => {
      if (event.detail?.sentenceId === sentenceId) setReviewBusy(false);
    };
    window.addEventListener("wuliao:translation-review:start", onStart);
    window.addEventListener("wuliao:translation-review:finish", onFinish);
    return () => {
      window.removeEventListener("wuliao:translation-review:start", onStart);
      window.removeEventListener("wuliao:translation-review:finish", onFinish);
    };
  }, [sentenceId]);

  const hasText = value.trim().length > 0;
  const isInkOnly = !hasText && hasInk;
  const inputMethod = getUserItem(methodKey) === "handwriting-transcribed" ? "handwriting-transcribed" : "typed";
  const chapter = chapterLabel(resource, passage);
  const itemLabel = `第${paragraphNumber}段第${sentenceIndex + 1}句`;
  const translationStatus = progressEntry?.translationStatus || "pending";
  const reviewStatus = progressEntry?.reviewStatus || null;
  const transcriptOnly = Boolean(ocrMetadata && hasInk);
  const requestInfo = () => ({ ...ocrIdentity, sentenceId, itemLabel, chapter, paragraph,
    writingElement: rootRef.current?.querySelector(".deep-writing-lines"), readOnly });
  const openOcr = (mode) => {
    flush();
    onRequestOcr({ ...requestInfo(), mode });
  };

  const handleReview = () => {
    if (reviewBusy) return;
    if (hasText) {
      flush();
      if (!onValidateOcr(requestInfo())) return;
      emitAppEvent(AppEvent.AI_REQUEST, {
        type: TASK_TRANSLATION_REVIEW,
        resourceId: resource.id,
        passageId: passage.id,
        username: ocrIdentity.username,
        chapter,
        sentenceId,
        itemLabel,
        sentence,
        paragraph,
        userTranslation: value,
        inputMethod,
      });
      return;
    }
    if (hasInk) {
      onRequestTranscription({
        storageKey,
        methodKey,
        resourceId: resource.id,
        passageId: passage.id,
        username: ocrIdentity.username,
        chapter,
        sentenceId,
        itemLabel,
        sentence,
        paragraph,
      });
      return;
    }
    emitAppEvent(AppEvent.READER_TOAST, { message: "请先输入你的译文，再提交 AI 批改" });
  };

  const handleCompleteTranslation = () => {
    if (translationStatus !== "pending") return;
    if (!inkOnly && !hasText) {
      emitAppEvent(AppEvent.READER_TOAST, { message: "请先写下自己的译文" });
      return;
    }
    onMarkTranslated();
  };

  const handleCompleteCorrection = () => {
    if (translationStatus === "translated" && onValidateOcr(requestInfo())) onMarkCorrected(value);
  };

  const scheduleTranslationEdit = (next) => {
    if (translationEditTimerRef.current) window.clearTimeout(translationEditTimerRef.current);
    translationEditTimerRef.current = window.setTimeout(() => {
      translationEditTimerRef.current = null;
      onTranslationEdited(next);
    }, 500);
  };

  const flushTranslationEdit = (next) => {
    if (translationEditTimerRef.current) window.clearTimeout(translationEditTimerRef.current);
    translationEditTimerRef.current = null;
    if (translationStatus === "corrected") onTranslationEdited(next);
  };

  return (
    <div className={`translation-unit${transcriptOnly ? " translation-has-transcript" : ""}`} ref={rootRef}>
      <textarea
        className="deep-writing-lines"
        style={{ "--writing-lines": lines }}
        rows={lines}
        value={value}
        aria-label={`第${paragraphNumber}段第${sentenceIndex + 1}句笔译`}
        aria-readonly={inkOnly || readOnly || transcriptOnly}
        readOnly={inkOnly || readOnly || transcriptOnly}
        inputMode={inkOnly ? "none" : undefined}
        spellCheck={!inkOnly}
        data-ink-only={inkOnly ? "true" : undefined}
        onChange={readOnly ? undefined : (event) => {
          setValue(event.target.value);
          if (translationStatus === "corrected") scheduleTranslationEdit(event.target.value);
        }}
        onBlur={readOnly ? undefined : (event) => {
          flush();
          flushTranslationEdit(event.target.value);
        }}
      />
      <div className="translation-unit-tools">
        <div className="translation-ocr-tools" data-unknown-ignore>
          {!readOnly && <button type="button" className="translation-ocr-button" onClick={() => openOcr("recognize")}>识别</button>}
          {(hasText || (!readOnly && legacyText)) && <button type="button" className="translation-ocr-button" onClick={() => openOcr("view")}>
            {hasText ? "查看文字" : "查看旧文字"}
          </button>}
        </div>
        {readOnly ? (
          <small className="translation-unit-hint">核对阶段只读：昨天的笔译与批改不会在此修改。</small>
        ) : translationStatus === "pending" ? (
          <button type="button" className="translation-step-button primary" onClick={handleCompleteTranslation}>
            完成笔译
          </button>
        ) : translationStatus === "translated" ? (
          <>
            <button
              type="button"
              className="translation-ai-button"
              onClick={handleReview}
              disabled={reviewBusy}
              data-has-text={hasText ? "1" : "0"}
              data-has-ink={hasInk ? "1" : "0"}
            >
              {reviewBusy ? "正在批改…" : (isInkOnly ? "录入译文后批改" : "AI 批改")}
            </button>
            <button type="button" className="translation-step-button primary" onClick={handleCompleteCorrection}>
              完成订正
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`translation-review-option ${reviewStatus === "mastered" ? "active" : ""}`}
              onClick={() => onSetReviewStatus("mastered")}
            >
              已掌握
            </button>
            <button
              type="button"
              className={`translation-review-option needs-review ${reviewStatus === "needs_review" ? "active" : ""}`}
              onClick={() => onSetReviewStatus("needs_review")}
            >
              需复盘
            </button>
          </>
        )}
        {(isInkOnly || transcriptOnly) && <small className="translation-unit-hint">AI 只读取文字译文，你的手写笔迹不会被修改。</small>}
      </div>
    </div>
  );
}

function QuestionEvidenceRow({
  passage,
  store,
  question,
  questionIndex,
  attempt,
  stageCompleted,
  onOpenEvidence,
  onViewEvidence,
  readOnly = false,
}) {
  const key = questionKeyFor({
    resourceId: store?.resourceId,
    passageId: store?.passageId,
    questionNumber: question.number,
    questionStem: question.stem,
    questionIndex,
  });
  const entry = entryFor(store, key, attempt);
  const needsType = entryNeedsType(entry);
  const stale = entry && entry.mode !== "global" ? !entryResolutionOk(entry, passage) : false;

  if (entry) {
    return (
      <div className={`evidence-card-row ${stale ? "stale" : ""} ${needsType ? "needs-type" : ""}`}>
        <span className="evidence-status">
          {stageCompleted && needsType ? "历史依据缺类型，可补充" : `原文依据 · ${entrySummaryLabel(entry)}`}
        </span>
        <span className="evidence-actions">
          {stale && <small className="evidence-stale">原文结构发生变化，旧证据无法精确恢复</small>}
          {!needsType && (
            <button type="button" className="evidence-action-button" onClick={() => onViewEvidence(question, attempt)}>
              查看
            </button>
          )}
          {!readOnly && (
            <button type="button" className={`evidence-action-button ${needsType ? "primary" : ""}`} onClick={() => onOpenEvidence(question, attempt, "card", entry.mode)}>
              {needsType ? "补充类型" : "修改"}
            </button>
          )}
        </span>
      </div>
    );
  }

  if (readOnly) {
    return (
      <div className="evidence-card-row legacy">
        <span className="evidence-status">核对阶段只读 · 未记录原文证据</span>
      </div>
    );
  }

  if (stageCompleted) {
    return (
      <div className="evidence-card-row legacy">
        <span className="evidence-status">历史作答 · 未记录原文证据</span>
        <span className="evidence-actions">
          <button type="button" className="evidence-action-button" onClick={() => onOpenEvidence(question, attempt, "card", "text")}>
            补充
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="evidence-card-row">
      <span className="evidence-status">原文证据 · 尚未标记</span>
      <span className="evidence-actions">
        <button type="button" className="evidence-action-button primary" onClick={() => onOpenEvidence(question, attempt, "card", "text")}>
          去原文定位
        </button>
        <button type="button" className="evidence-action-button" onClick={() => onOpenEvidence(question, attempt, "card", "global")}>
          全文/结构依据
        </button>
      </span>
    </div>
  );
}

function RedoComparison({
  passage,
  store,
  question,
  questionIndex,
  firstAnswers,
  redoAnswers,
  onJumpEvidence,
}) {
  const [open, setOpen] = useState(false);
  const key = questionKeyFor({
    resourceId: store?.resourceId,
    passageId: store?.passageId,
    questionNumber: question.number,
    questionStem: question.stem,
    questionIndex,
  });
  const firstEntry = entryFor(store, key, "first");
  const redoEntry = entryFor(store, key, "redo");
  const firstAnswer = String(firstAnswers?.[question.number] || "");
  const redoAnswer = String(redoAnswers?.[question.number] || "");
  const redoComplete = questionEvidenceComplete(store, key, "redo", passage) && Boolean(redoAnswer);
  if (!redoComplete) return null;
  const comparison = compareAttempts({ firstEntry, redoEntry, firstAnswer, redoAnswer });

  return (
    <div className="evidence-compare">
      <button type="button" className="evidence-compare-toggle" onClick={() => setOpen((current) => !current)}>
        <span>对比第一次</span>
        <i>{comparison.tags.join(" · ")}</i>
      </button>
      {open && (
        <div className="evidence-compare-panel">
          <div className="evidence-compare-side">
            <strong>第一次</strong>
            <span>答案：{firstAnswer || "—"}</span>
            <span>证据：{entrySummaryLabel(firstEntry) || "—"}</span>
            {firstEntry && (
              <button type="button" className="evidence-action-button" onClick={() => onJumpEvidence(question, "first")}>
                跳到首次证据
              </button>
            )}
          </div>
          <div className="evidence-compare-side">
            <strong>重做</strong>
            <span>答案：{redoAnswer || "—"}</span>
            <span>证据：{entrySummaryLabel(redoEntry) || "—"}</span>
            {redoEntry && (
              <button type="button" className="evidence-action-button" onClick={() => onJumpEvidence(question, "redo")}>
                跳到重做证据
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionSet({
  passage,
  answers,
  onAnswer,
  correctAnswers,
  correctionVisible,
  onRequestAiHint,
  getDiagnosisLabel,
  onRequestDiagnosis,
  store = null,
  attempt = "first",
  stageCompleted = false,
  onOpenEvidence = null,
  onViewEvidence = null,
  onJumpEvidence = null,
  firstAnswers = null,
  readOnly = false,
  capabilitiesForQuestion = null,
}) {
  if (!passage.questions.length) {
    return <div className="deep-empty">未识别到这篇文章的选择题，可先完成原文精读。</div>;
  }

  return (
    <div className="deep-question-list">
      {passage.questions.map((question, questionIndex) => {
        const capabilities = capabilitiesForQuestion?.(question) || {
          canEditAnswer: !readOnly,
          showCorrection: correctionVisible,
          showEvidence: Boolean(onOpenEvidence && onViewEvidence),
          showAiHint: Boolean(onRequestAiHint),
          showDiagnosis: Boolean(getDiagnosisLabel && onRequestDiagnosis),
          showAnalysis: attempt === "redo",
        };
        const answerReadOnly = readOnly || !capabilities.canEditAnswer;
        return (
        <article className="deep-question-card" key={question.id} data-question-key={questionKeyFor({
          resourceId: store?.resourceId,
          passageId: store?.passageId,
          questionNumber: question.number,
          questionStem: question.stem,
          questionIndex,
        })}>
          <h3><span>{question.number}</span>{question.stem}</h3>
          <div className="deep-options">
            {question.options.map((option) => (
              <button
                key={option.key}
                className={[
                  answers[question.number] === option.key ? "selected" : "",
                  capabilities.showCorrection && correctAnswers[question.number] === option.key ? "correct" : "",
                ].filter(Boolean).join(" ")}
                onClick={answerReadOnly ? undefined : () => onAnswer(question.number, option.key)}
                disabled={answerReadOnly}
              >
                <span>{option.key}</span><p>{option.text}</p>
              </button>
            ))}
          </div>
          <div className="question-action-row">
            {capabilities.showEvidence && onOpenEvidence && onViewEvidence && (
              <QuestionEvidenceRow
                passage={passage}
                store={store}
                question={question}
                questionIndex={questionIndex}
                attempt={attempt}
                stageCompleted={stageCompleted}
                onOpenEvidence={onOpenEvidence}
                onViewEvidence={onViewEvidence}
                readOnly={answerReadOnly}
              />
            )}
            {capabilities.showAiHint && onRequestAiHint && (
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
          </div>
          {capabilities.showAnalysis && attempt === "redo" && onJumpEvidence && (
            <RedoComparison
              passage={passage}
              store={store}
              question={question}
              questionIndex={questionIndex}
              firstAnswers={firstAnswers}
              redoAnswers={answers}
              onJumpEvidence={onJumpEvidence}
            />
          )}
        </article>
        );
      })}
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

function StageAdvance({ completed = false, disabled = false, onClick, hint = null, children }) {
  return (
    <div className="stage-advance">
      {hint && <small className="stage-advance-hint">{hint}</small>}
      <button
        type="button"
        className="stage-advance-button"
        onClick={onClick}
        disabled={completed || disabled}
      >
        {completed ? "已完成" : children}
      </button>
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
  onRequestAiHint,
  getDiagnosisLabel,
  onRequestDiagnosis,
  readingCompleted,
  onToggleReadingCompleted,
  inkOnly,
  projectInkStroke,
  onRequestTranscription,
  onRequestOcr,
  onValidateOcr,
  translationProgress,
  onMarkTranslationDone,
  onMarkSentenceCorrected,
  onSetSentenceReviewStatus,
  onTranslationEdited,
  onCompleteParagraph,
  onContinueToNextParagraph,
  onContinueNextTranslation,
  flow,
  onCompleteStage,
  onResumeTimedReading,
  timedReadingState,
  timerNow,
  evidenceStore,
  evidenceEditor,
  onCaptureEvidenceSelection,
  onUpdateEvidenceDraft,
  onOpenEvidence,
  onViewEvidence,
  onJumpEvidence,
  onFocusNextIncomplete,
  reviewReadOnly = false,
  onScheduleReview = null,
  onOpenSummary = null,
}) {
  const totalSentences = useMemo(
    () => passage.paragraphs.reduce((sum, paragraph) => sum + paragraph.sentences.length, 0),
    [passage],
  );
  const currentIndex = Math.max(0, STAGE_IDS.indexOf(flow?.currentStage || "deep-cover"));
  const stageStatus = (id) => flow?.stages?.[id]?.status || "pending";
  const stageLocked = (id) => isStageLocked(flow, id);
  const stageCompleted = (id) => stageStatus(id) === "completed";
  const timedReading = timedReadingState || {
    phase: "idle",
    elapsedMs: 0,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
  };
  const timedPhase = timedReading.phase;
  const timedReadingIsCurrent = flow?.currentStage === "deep-clean-text" || flow?.currentStage === "deep-first-quiz";
  const translationCounts = useMemo(
    () => countsForPassage(translationProgress, passage),
    [translationProgress, passage],
  );
  const paragraphStates = useMemo(
    () => new Map(passage.paragraphs.map((paragraph) => [paragraph.number, paragraphState(translationProgress, paragraph)])),
    [translationProgress, passage],
  );
  const firstAnswersComplete = passage.questions.length > 0
    && passage.questions.every((question) => Boolean(answers[question.number]));
  const redoAnswersComplete = passage.questions.length > 0
    && passage.questions.every((question) => Boolean(redoAnswers[question.number]));
  const reliableOfficialFor = (question) => hasReliableOfficialAnswer({
    resource,
    officialAnswers: correctAnswers,
    questionNumber: question.number,
  });

  return (
    <>
      <section className="deep-cover deep-paper" id="deep-cover" data-flow-locked={stageLocked("deep-cover") ? "true" : undefined}>
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
        <StageAdvance completed={stageCompleted("deep-cover")} onClick={() => onCompleteStage("deep-cover")}>
          开始精读
        </StageAdvance>
      </section>

      <section className="deep-paper" id="deep-first-read" data-flow-locked={stageLocked("deep-first-read") ? "true" : undefined}>
        <SectionHeading index="2" title="审题：先看全部英文题干" description="只建立阅读导航，不看选项，不提前分析答案。" />
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
        <StageAdvance completed={stageCompleted("deep-first-read")} onClick={() => onCompleteStage("deep-first-read")}>
          完成审题，进入初做
        </StageAdvance>
      </section>

      <section className="deep-paper" id="deep-clean-text" data-flow-locked={stageLocked("deep-clean-text") ? "true" : undefined}>
        <SectionHeading index="3①" title="限时读文" description="第三组第一步：计时阅读干净原文，不查词、不提前分析答案。" />
        {(() => (
            <>
              {timedReadingIsCurrent && (timedPhase === "running" || timedPhase === "paused") && (
                <div className={`timed-reading-timer ${timedPhase}`}>
                  <span className="timed-reading-clock">{formatClock(timedReadingElapsed(flow, timerNow))}</span>
                  {timedPhase === "paused" && (
                    <button type="button" className="timed-reading-resume" onClick={onResumeTimedReading}>
                      继续计时
                    </button>
                  )}
                  <small>限时初做中：原文与题目同时显示，完成初做时自动结束计时</small>
                </div>
              )}
              <div
                className={`clean-article ${evidenceEditor ? "evidence-select-mode" : ""}`}
                onPointerUp={(event) => {
                  if (evidenceEditor?.draft?.mode !== "text") return;
                  onCaptureEvidenceSelection?.(window.getSelection(), event.currentTarget);
                }}
              >
                {passage.paragraphs.map((paragraph) => (
                  <section className="clean-paragraph" key={paragraph.number} data-unknown-scope={`clean:p${paragraph.number}`}>
                    <header className="clean-paragraph-heading"><span data-unknown-ignore>[P{paragraph.number}]</span></header>
                    <p className="clean-natural-paragraph">
                      {paragraph.sentences.map((sentence, sentenceIndex) => (
                        <span
                          key={`${paragraph.number}-clean-s${sentenceIndex}`}
                          data-sentence-scope={`clean:p${paragraph.number}:s${sentenceIndex + 1}`}
                          onClick={() => {
                            if (evidenceEditor?.draft?.mode !== "sentences") return;
                            const ref = buildSentenceRef({ paragraphNumber: paragraph.number, sentenceIndex, sentenceText: sentence });
                            const selected = evidenceEditor.draft.references.some((item) => item.sentenceKey === ref.sentenceKey);
                            const result = selected ? { draft: removeSentenceRef(evidenceEditor.draft, ref.sentenceKey) } : addSentenceRef(evidenceEditor.draft, ref);
                            if (result.rejected) return;
                            onUpdateEvidenceDraft?.(result.draft);
                          }}
                          data-evidence-paragraph={paragraph.number}
                          data-evidence-sentence={sentenceIndex}
                        >{sentence}{" "}</span>
                      ))}
                    </p>
                  </section>
                ))}
              </div>
            </>
        ))()}
      </section>

      <section className="deep-paper" id="deep-first-quiz" data-flow-locked={stageLocked("deep-first-quiz") ? "true" : undefined}>
        <SectionHeading
          index="3②"
          title="初做"
          description="第三组第二步：独立完成全部习题；本阶段不显示证据、AI、诊断或解析。"
          action={firstAnswersComplete && (
            <button type="button" className={`correction-button ${correctionVisibility.first ? "active" : ""}`} onClick={() => onToggleCorrection("first")}>
              {correctionVisibility.first ? "隐藏订正" : "订正"}
            </button>
          )}
        />
        <QuestionSet
          passage={passage}
          answers={answers}
          onAnswer={onAnswer}
          correctAnswers={correctAnswers}
          correctionVisible={correctionVisibility.first}
          onRequestAiHint={(question) => onRequestAiHint?.(question, "first")}
          getDiagnosisLabel={(question) => getDiagnosisLabel?.(question, "first")}
          onRequestDiagnosis={(question) => onRequestDiagnosis?.(question, "first")}
          store={evidenceStore}
          attempt="first"
          stageCompleted={stageCompleted("deep-first-quiz")}
          onOpenEvidence={onOpenEvidence}
          onViewEvidence={onViewEvidence}
          readOnly={reviewReadOnly}
          capabilitiesForQuestion={(question) => questionCapabilities({
            flowStage: "deep-first-quiz",
            correctionRevealed: correctionVisibility.first,
            hasReliableOfficialAnswer: reliableOfficialFor(question),
            redoCompleted: false,
          })}
        />
        {(() => {
          const completion = quizCompletion({
            questions: passage.questions,
            answers,
            store: evidenceStore,
            attempt: "first",
            stageCompleted: stageCompleted("deep-first-quiz"),
            passage,
          });
          const missingAnswers = completion.remainingWithoutAnswer.length;
          const label = passage.questions.length
            ? completion.answerComplete
              ? "完成初做，进入逐段精读"
              : `还差 ${missingAnswers} 题作答`
            : "完成本阶段";
          const hint = passage.questions.length && !completion.answerComplete
            ? `还剩 ${completion.remainingWithoutAnswer.length} 题未作答`
            : null;
          return (
            <>
              {passage.questions.length > 0 && (
                <div className="quiz-completion-progress">
                  已作答 {completion.answeredCount}/{completion.total}
                  {!completion.answerComplete && (
                    <button type="button" onClick={() => onFocusNextIncomplete?.("first", completion)}>定位下一项</button>
                  )}
                </div>
              )}
              <StageAdvance
                completed={stageCompleted("deep-first-quiz")}
                disabled={!completion.answerComplete}
                onClick={() => onCompleteStage("deep-first-quiz")}
                hint={hint}
              >
                {label}
              </StageAdvance>
            </>
          );
        })()}
      </section>

      <section className="deep-translation" id="deep-translation" data-flow-locked={stageLocked("deep-translation") ? "true" : undefined}>
        <SectionHeading
          index="4"
          title="逐句笔译与原文订正"
          description="按原文段落与句子顺序逐个输出；每句下方横线数量按该句长度生成。"
          action={reviewReadOnly ? (
            <div className="translation-progress-summary">
              <span className="translation-progress-counts">
                已订正 {translationCounts.correctedCount}/{translationCounts.total}
                {translationCounts.needsReviewCount > 0 ? ` · 待复盘 ${translationCounts.needsReviewCount}` : ""}
              </span>
            </div>
          ) : (
            <div className="translation-progress-summary">
              <span className="translation-progress-counts">
                已订正 {translationCounts.correctedCount}/{translationCounts.total}
                {translationCounts.needsReviewCount > 0 ? ` · 待复盘 ${translationCounts.needsReviewCount}` : ""}
                {" · "}已完成段落 {translationCounts.completedParagraphCount}/{translationCounts.paragraphTotal}
              </span>
              <button type="button" className="translation-continue-button" onClick={onContinueNextTranslation}>
                继续下一句
              </button>
            </div>
          )}
        />
        {passage.paragraphs.map((paragraph) => (
          <article className="translation-paragraph deep-paper" key={paragraph.number} data-translation-paragraph={`p${paragraph.number}`}>
            <header>
              <span>4.{paragraph.number}</span>
              <h2>第 {paragraph.number} 段：逐句笔译与原文订正</h2>
              <small className="paragraph-workbook-status">
                第 {paragraph.number} 段 · {paragraphStates.get(paragraph.number)?.correctedCount || 0} / {paragraphStates.get(paragraph.number)?.total || 0} 句已订正
              </small>
            </header>
            <p className="translation-tip">先写自己的译文，再回到英文标记主干、逻辑和错因。</p>
            <div className="sentence-list">
              {paragraph.sentences.map((sentence, sentenceIndex) => {
                const words = sentence.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
                const lineCount = Math.max(1, Math.min(5, Math.ceil(words.length / 14)));
                const { key: sentenceKey, entry } = sentenceEntryFor(translationProgress, {
                  paragraphNumber: paragraph.number,
                  sentenceIndex,
                  sentenceText: sentence,
                  translationText: getUserItem(translationKey(resource.id, passage.id, paragraph.number, sentenceIndex)) || "",
                });
                return (
                  <section className="sentence-work" key={`${paragraph.number}-${sentenceIndex}`} data-translation-sentence={sentenceKey}>
                    <div className="sentence-source"><span>S{sentenceIndex + 1}</span><p data-unknown-scope={`translation:p${paragraph.number}:s${sentenceIndex + 1}`} data-sentence-scope={`translation:p${paragraph.number}:s${sentenceIndex + 1}`}>{formatArticleText(sentence)}</p></div>
                    <div className="sentence-work-meta">
                      <span>我的笔译</span>
                      <span className={`translation-status-badge ${entry.translationStatus}${entry.reviewStatus ? ` ${entry.reviewStatus}` : ""}`}>
                        S{sentenceIndex + 1}/{totalSentences} · {translationStatusLabel(entry)}
                      </span>
                    </div>
                    <TranslationUnit
                      key={`${resource.id}:${passage.id}:${sentenceKey}`}
                      resource={resource}
                      passage={passage}
                      sentence={sentence}
                      paragraph={paragraph.text}
                      paragraphNumber={paragraph.number}
                      sentenceIndex={sentenceIndex}
                      lines={lineCount}
                      projectInkStroke={projectInkStroke}
                      inkOnly={inkOnly}
                      onRequestTranscription={onRequestTranscription}
                      onRequestOcr={onRequestOcr}
                      onValidateOcr={onValidateOcr}
                      progressEntry={entry}
                      onMarkTranslated={() => onMarkTranslationDone(sentenceKey)}
                      onMarkCorrected={(text) => onMarkSentenceCorrected(
                        sentenceKey,
                        text,
                        { paragraphNumber: paragraph.number, sentenceIndex, sentenceText: sentence },
                      )}
                      onSetReviewStatus={(status) => onSetSentenceReviewStatus(sentenceKey, status)}
                      onTranslationEdited={(text) => onTranslationEdited(sentenceKey, text)}
                      readOnly={reviewReadOnly}
                    />
                  </section>
                );
              })}
            </div>
            <div className="paragraph-source-repeat">
              <h3>本段英语原文（按句分行）</h3>
              {paragraph.sentences.map((sentence, sentenceIndex) => (
                <p key={`${paragraph.number}-repeat-${sentenceIndex}`} data-unknown-scope={`repeat:p${paragraph.number}:s${sentenceIndex + 1}`} data-sentence-scope={`repeat:p${paragraph.number}:s${sentenceIndex + 1}`}><span data-unknown-ignore>S{sentenceIndex + 1}</span>{formatArticleText(sentence)}</p>
              ))}
            </div>
            <div className="paragraph-summary-row">
              <h3 className="deep-note-title">段落中心思想（用一句话概括）</h3>
            </div>
            <SavedLines storageKey={`wuliao:deep-summary:${resource.id}:${passage.id}:${paragraph.number}`} lines={2} label={`第${paragraph.number}段中心思想`} inkOnly={inkOnly} />
          </article>
        ))}
        <div data-translation-complete="true">
          {!reviewReadOnly && <StageAdvance onClick={() => onCompleteStage("deep-translation")}>进入重做</StageAdvance>}
        </div>
      </section>

      <section className="deep-paper" id="deep-redo" data-flow-locked={stageLocked("deep-redo") ? "true" : undefined}>
        <SectionHeading
          index="5"
          title="全文核对后：正式重做"
          description="再次独立作答，只看题干和选项；需要时回原文圈出定位句。"
          action={redoAnswersComplete && (
            <button type="button" className={`correction-button ${correctionVisibility.redo ? "active" : ""}`} onClick={() => onToggleCorrection("redo")}>
              {correctionVisibility.redo ? "隐藏订正" : "订正"}
            </button>
          )}
        />
        <QuestionSet
          passage={passage}
          answers={redoAnswers}
          onAnswer={onRedoAnswer}
          correctAnswers={correctAnswers}
          correctionVisible={correctionVisibility.redo}
          onRequestAiHint={(question) => onRequestAiHint?.(question, "redo")}
          getDiagnosisLabel={(question) => getDiagnosisLabel?.(question, "redo")}
          onRequestDiagnosis={(question) => onRequestDiagnosis?.(question, "redo")}
          store={evidenceStore}
          attempt="redo"
          stageCompleted={stageCompleted("deep-redo")}
          onOpenEvidence={onOpenEvidence}
          onViewEvidence={onViewEvidence}
          onJumpEvidence={onJumpEvidence}
          firstAnswers={answers}
          readOnly={reviewReadOnly}
          capabilitiesForQuestion={(question) => questionCapabilities({
            flowStage: "deep-redo",
            correctionRevealed: correctionVisibility.redo,
            hasReliableOfficialAnswer: reliableOfficialFor(question),
            redoCompleted: Boolean(redoAnswers[question.number]),
          })}
        />
        {(() => {
          const completion = quizCompletion({
            questions: passage.questions,
            answers: redoAnswers,
            store: evidenceStore,
            attempt: "redo",
            stageCompleted: stageCompleted("deep-redo"),
            passage,
          });
          const missingAnswers = completion.remainingWithoutAnswer.length;
          const missingEvidence = completion.remainingWithoutEvidence.length;
          const label = passage.questions.length
            ? completion.canComplete
              ? "完成重做，进入复读压缩"
              : missingAnswers > 0 && missingEvidence > 0
                ? `还差 ${missingAnswers} 题作答 · ${missingEvidence} 题原文依据`
                : missingAnswers > 0
                  ? `还差 ${missingAnswers} 题作答`
                  : `还差 ${missingEvidence} 题原文依据`
            : "完成本阶段";
          const hint = passage.questions.length && !completion.canComplete
            ? (!completion.answerComplete
              ? `还剩 ${completion.remainingWithoutAnswer.length} 题未作答`
              : `还有 ${completion.remainingWithoutEvidence.length} 道题没有完成原文证据定位`)
            : null;
          return (
            <>
              {passage.questions.length > 0 && (
                <div className="quiz-completion-progress">
                  已作答 {completion.answeredCount}/{completion.total} · 已补证据 {completion.evidenceCompleted}/{completion.total}
                  {!completion.canComplete && (
                    <button type="button" onClick={() => onFocusNextIncomplete?.("redo", completion)}>定位下一项</button>
                  )}
                </div>
              )}
              <StageAdvance
                completed={stageCompleted("deep-redo")}
                disabled={!completion.canComplete}
                onClick={() => onCompleteStage("deep-redo")}
                hint={hint}
              >
                {label}
              </StageAdvance>
            </>
          );
        })()}
      </section>

      <section className="deep-paper" id="deep-review" data-flow-locked={stageLocked("deep-review") ? "true" : undefined}>
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
        {!reviewReadOnly && (
          <div className={`reading-completion ${readingCompleted ? "completed" : ""}`}>
            <div><strong>{readingCompleted ? "本篇已计入完成阅读" : "完成全部流程后再标记"}</strong><span>用于计算本机段位与阅读完成率</span></div>
            <button type="button" onClick={onToggleReadingCompleted} disabled={!readingCompleted && stageLocked("deep-review")}>
              {readingCompleted ? "撤销完成" : "标记本篇完成"}
            </button>
          </div>
        )}
        {!reviewReadOnly && !readingCompleted && stageLocked("deep-review") && (
          <p className="stage-advance-hint">请先完成「{STAGE_LABELS[flow?.currentStage] || ""}」再标记本篇完成</p>
        )}
        {!reviewReadOnly && readingCompleted && onScheduleReview && (
          <button type="button" className="review-schedule-button" onClick={onScheduleReview}>
            安排一次复读
          </button>
        )}
        {!reviewReadOnly && readingCompleted && onOpenSummary && (
          <button type="button" className="review-schedule-button" onClick={onOpenSummary}>
            查看本篇学习结果
          </button>
        )}
        {reviewReadOnly && (
          <div className="reading-completion readonly">
            <div><strong>核对阶段只读</strong><span>复读完成不会改变本篇完成状态与段位计分</span></div>
          </div>
        )}
      </section>
    </>
  );
}

const answerKey = (resourceId, passageId, attempt) => `wuliao:deep-answers:${resourceId}:${passageId}:${attempt}`;
const positionKey = (resourceId) => `wuliao:deep-position:${resourceId}`;
const INK_TILE_HEIGHT = 512;
const INK_TILE_BUFFER = 768;
const INK_TILE_OVERLAP = 24;
const strokeBoundsCache = new WeakMap();

function drawTileStroke(tile, stroke, { width, height, ratio, offsetY }) {
  const context = tile.getContext("2d", { alpha: true });
  context.save();
  context.scale(ratio, ratio);
  context.translate(0, -offsetY);
  drawInkStroke(context, stroke, width, height);
  context.restore();
}

function drawTileHistory(tile, data) {
  tile.getContext("2d", { alpha: true }).clearRect(0, 0, tile.width, tile.height);
  for (const stroke of data.strokes) drawTileStroke(tile, stroke, data);
}

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

function SimplifiedExportDocument({
  resource,
  passage,
  evidenceStore,
  answers = {},
  redoAnswers = {},
  correctAnswers = {},
}) {
  const sourceLabel = resource.kind === "official"
    ? `${resource.year} 英语（一）${passage.label}`
    : (resource.title || passage.label);
  const questions = passage.questions || [];

  const lineCountFor = (sentence) => {
    const words = sentence.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
    const normalizedLength = String(sentence || "").replace(/\s+/g, " ").trim().length;
    const widthEstimate = Math.ceil(normalizedLength / 58);
    const wordEstimate = Math.ceil(words.length / 11);
    return Math.max(1, Math.min(4, Math.max(widthEstimate, wordEstimate)));
  };

  const renderQuestions = (attempt, { includeEvidence = false } = {}) => (
    questions.length ? (
      <div className="simplified-export-questions">
        {questions.map((question, questionIndex) => {
          const key = questionKeyFor({
            resourceId: resource.id,
            passageId: passage.id,
            questionNumber: question.number,
            questionStem: question.stem,
            questionIndex,
          });
           const entry = includeEvidence ? entryFor(evidenceStore, key, attempt) : null;
           const evidenceLine = entry
             ? (entry.mode === "global"
               ? entrySummaryLabel(entry)
              : entry.mode === "text"
                ? `${entrySummaryLabel(entry)}${entry.ranges.length ? ` · ${entry.ranges.map((range) => `“${textRangeExcerpt(range)}”`).join(" / ")}` : ""}`
                : `${entrySummaryLabel(entry)}${entry.references.length ? ` · ${entry.references.map((ref) => `“${ref.excerpt}”`).join(" / ")}` : ""}`)
            : "未记录原文证据";
          return (
            <article className="simplified-export-question" key={question.id}>
              <h3>{question.number}. {question.stem}</h3>
              <div className="simplified-export-options">
                {question.options.map((option) => (
                  <p key={option.key}><span>[{option.key}]</span>{option.text}</p>
                ))}
              </div>
              {(attempt === "first" ? answers[question.number] : redoAnswers[question.number]) && (
                <p className="simplified-export-answer">
                  我的作答：{attempt === "first" ? answers[question.number] : redoAnswers[question.number]}
                </p>
              )}
              {includeEvidence && entry && <p className="simplified-export-evidence">我的证据：{evidenceLine}</p>}
            </article>
          );
        })}
      </div>
    ) : (
      <p className="simplified-export-empty">未识别到这篇文章的选择题。</p>
    )
  );

  return (
    <div className="simplified-export-document" aria-hidden="true">
      <style>{`@media print { @page { @bottom-left { content: ${JSON.stringify(sourceLabel)}; } } }`}</style>
      <section className="simplified-export-module" data-export-module>
        <header className="simplified-export-heading">
          <span>1</span>
          <div><h2>文章导读</h2><p>精读全流程：审题、读文、作答、逐句笔译、订正、重做与复读。</p></div>
        </header>
        <span className="simplified-export-source">{sourceLabel}</span>
        <dl className="simplified-export-guide">
          <div><dt>限时阶段</dt><dd>先看全部题干，不看选项；读文时不查词。</dd></div>
          <div><dt>笔译阶段</dt><dd>按段、按句输出自己的译文，再回原文订正。</dd></div>
          <div><dt>重做阶段</dt><dd>全文核对完成后，再统一完成全部题目。</dd></div>
          <div><dt>第二天</dt><dd>遮住笔译重读，复查错因。</dd></div>
        </dl>
        <h2 className="simplified-export-section-title">阅读题题干</h2>
        {questions.length ? (
          <ol className="simplified-export-stems">
            {questions.map((question) => <li key={question.id}>{question.stem}</li>)}
          </ol>
        ) : (
          <p className="simplified-export-empty">未识别到这篇文章的选择题。</p>
        )}
      </section>

      <section className="simplified-export-module" data-export-module>
        <header className="simplified-export-heading">
          <span>2</span>
          <div><h2>干净原文：限时读文</h2><p>现在开始计时。此处只保留连续自然段原文。</p></div>
        </header>
        <div className="simplified-export-article">
          {passage.paragraphs.map((paragraph) => (
            <p className="simplified-export-natural-paragraph" key={paragraph.number}>
              {paragraph.sentences.map(formatArticleText).join(" ")}
            </p>
          ))}
        </div>
      </section>

      <section className="simplified-export-module" data-export-module>
        <header className="simplified-export-heading">
          <span>3</span>
          <div><h2>第一次做题：完成全部习题</h2><p>现在才看选项。需要时回到原文定位。</p></div>
        </header>
        {renderQuestions("first", { includeEvidence: false })}
      </section>

      <section className="simplified-export-module" data-export-module>
        <header className="simplified-export-heading">
          <span>4</span>
          <div><h2>逐句笔译与原文订正</h2><p>按原文段落与句子顺序逐个输出；每句下方横线数量按该句长度生成。</p></div>
        </header>
        {passage.paragraphs.map((paragraph) => (
          <div className="simplified-export-paragraph-block" key={paragraph.number}>
            <h3 className="simplified-export-paragraph-label">第 {paragraph.number} 段</h3>
            <div className="simplified-export-sentences">
              {paragraph.sentences.map((sentence, sentenceIndex) => (
                <div className="simplified-export-sentence" key={`${paragraph.number}-${sentenceIndex}`}>
                  <p className="simplified-export-sentence-en"><span>S{sentenceIndex + 1}</span>{formatArticleText(sentence)}</p>
                  <div className="simplified-export-lines">
                    {Array.from({ length: lineCountFor(sentence) }).map((_, index) => <span key={index} />)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="simplified-export-module" data-export-module>
        <header className="simplified-export-heading">
          <span>5</span>
          <div><h2>初做订正</h2><p>只核对真实初做记录与可靠官方答案，不自动补造解析。</p></div>
        </header>
        {questions.length ? (
          <div className="simplified-export-correction-list">
            {questions.map((question) => (
              <p key={`correction-${question.id}`}>
                <strong>{question.number}</strong>
                <span>初做：{answers[question.number] || "未作答"}</span>
                <span>{resource.kind === "official" && correctAnswers[question.number]
                  ? answers[question.number]
                    ? answers[question.number] === correctAnswers[question.number] ? "✓ 正确" : "✕ 错误"
                    : "未作答"
                  : "无法可靠判断对错"}</span>
                <span>可靠答案：{resource.kind === "official" && correctAnswers[question.number] ? correctAnswers[question.number] : "暂无可靠答案"}</span>
              </p>
            ))}
          </div>
        ) : <p className="simplified-export-empty">未识别到选择题。</p>}
      </section>

      <section className="simplified-export-module" data-export-module>
        <header className="simplified-export-heading">
          <span>6</span>
          <div><h2>全文核对后：正式重做</h2><p>再次独立作答，只看题干和选项；需要时回原文圈出定位句。</p></div>
        </header>
        {renderQuestions("redo", { includeEvidence: true })}
      </section>

      <section className="simplified-export-module" data-export-module>
        <header className="simplified-export-heading">
          <span>7</span>
          <div><h2>全文压缩与第二天复读</h2><p>不预设结构答案。用自己的话压缩全文，第二天遮住笔译复读。</p></div>
        </header>
        <div className="simplified-export-compress">
          {passage.paragraphs.map((paragraph) => (
            <div className="simplified-export-compress-row" key={paragraph.number}>
              <span>P{paragraph.number}</span>
              <div className="simplified-export-lines">
                {Array.from({ length: 3 }).map((_, index) => <span key={index} />)}
              </div>
            </div>
          ))}
          <div className="simplified-export-compress-row">
            <span>总</span>
            <div className="simplified-export-lines">
              {Array.from({ length: 4 }).map((_, index) => <span key={index} />)}
            </div>
          </div>
        </div>
        <div className="simplified-export-checklist">
          <p>□ 我能用 30 秒说清全文主线</p>
          <p>□ 我能遮住答案重做全部题目</p>
          <p>□ 我已复查错因与替换词</p>
        </div>
      </section>
    </div>
  );
}

const ReaderSidePanels = forwardRef(function ReaderSidePanels({
  questionAvailable, questionCount, questionDrawerProps, aiProps, activeInkRef, paperKey,
}, ref) {
  const [activePanel, setActivePanel] = useState(null);
  const layoutBridgeRef = useRef(null);
  const pendingFrameRef = useRef(0);
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;
  const displayedPanelRef = useRef("questions");
  if (activePanel) displayedPanelRef.current = activePanel;
  const displayedPanel = displayedPanelRef.current;
  const motion = useMotionPresence(Boolean(activePanel));
  useReaderPaperLayout(layoutBridgeRef, Boolean(activePanel), paperKey);

  function selectPanel(next) {
    cancelAnimationFrame(pendingFrameRef.current);
    const commit = () => {
      if (activeInkRef.current) {
        pendingFrameRef.current = requestAnimationFrame(commit);
        return;
      }
      setActivePanel(next);
    };
    commit();
  }
  useEffect(() => () => cancelAnimationFrame(pendingFrameRef.current), []);
  useEffect(() => {
    if (!questionAvailable && activePanelRef.current === "questions") selectPanel(null);
  }, [questionAvailable]);
  useImperativeHandle(ref, () => ({
    openQuestion() { if (questionAvailable) selectPanel("questions"); },
  }), [questionAvailable]);

  return (
    <>
      <span ref={layoutBridgeRef} hidden aria-hidden="true" />
      {questionAvailable && !activePanel && (
        <button className="question-fab" onClick={() => selectPanel("questions")}>
          <span>题</span><strong>习题</strong><small>{questionCount || "·"}</small>
        </button>
      )}
      {!activePanel && <button className="ai-float-button" aria-label="打开 AI 悬浮窗" onClick={() => selectPanel("ai")}>
        <span>AI</span><strong>AI</strong><small>问答</small>
      </button>}
      <aside className="reader-side-panel" data-motion-state={motion.state} aria-hidden={!motion.present} inert={!activePanel}>
        <div className="reader-side-tabs" role="tablist" aria-label="精读侧栏">
          {questionAvailable && <button id="reader-question-tab" role="tab" aria-selected={activePanel === "questions"} aria-controls="reader-question-pane" onClick={() => selectPanel("questions")}>习题</button>}
          <button id="reader-ai-tab" role="tab" aria-selected={activePanel === "ai"} aria-controls="reader-ai-pane" onClick={() => selectPanel("ai")}>AI</button>
        </div>
        <div id="reader-question-pane" className="reader-side-pane" role="tabpanel" aria-labelledby="reader-question-tab" hidden={displayedPanel === "ai"}>
          <QuestionDrawer {...questionDrawerProps} embedded open={activePanel === "questions"} onClose={() => selectPanel(null)} docked />
        </div>
        <div id="reader-ai-pane" className="reader-side-pane" role="tabpanel" aria-labelledby="reader-ai-tab" hidden={displayedPanel !== "ai"}>
          <AiFloatWindow {...aiProps} embedded open={activePanel === "ai"} onOpenChange={(next) => {
            if (next) selectPanel("ai");
            else if (activePanelRef.current === "ai") selectPanel(null);
          }} />
        </div>
      </aside>
    </>
  );
});

export default function CustomDeepReader({
  resource,
  onClose,
  reviewTaskKey = "",
  summaryInitially = false,
  summaryTabInitially = "summary",
  onRequestReview = null,
}) {
  const storageUsername = useRef(getCurrentUsername()).current;
  const setUserItem = (key, value) => writeOwnedUserItem(key, value, storageUsername);
  const androidApp = isAndroidApp();
  const analysis = resource.analysis;
  const initialPosition = loadJson(positionKey(resource.id), {});
  const [passageIndex, setPassageIndex] = useState(() => {
    const index = analysis.passages.findIndex((item) => item.id === initialPosition.passageId);
    return Math.max(0, index);
  });
  const [showSource, setShowSource] = useState(false);
  const [drawerFocusQuestionId, setDrawerFocusQuestionId] = useState(null);
  const readerPanelsRef = useRef(null);
  const [topAreaCollapsed, setTopAreaCollapsed] = useState(false);
  const [hasClearableText, setHasClearableText] = useState(false);
  const clearableTextApiRef = useRef(null);
  const [activeStage, setActiveStage] = useState(() => initialPosition.anchorId || "deep-cover");
  const [pendingStageScrollTarget, setPendingStageScrollTarget] = useState(null);
  const [flow, setFlow] = useState(() => {
    const initialPassage = analysis.passages[passageIndex] || analysis.passages[0];
    return getReadingFlow(resource.id, initialPassage?.id || "");
  });
  const [inkStageId, setInkStageId] = useState(() => inkScopeStageId(flow?.currentStage || "deep-cover"));
  const [translationProgress, setTranslationProgress] = useState(() => {
    const initialPassage = analysis.passages[passageIndex] || analysis.passages[0];
    return loadTranslationProgress(resource.id, initialPassage?.id || "");
  });
  const [evidenceStore, setEvidenceStore] = useState(() => {
    const initialPassage = analysis.passages[passageIndex] || analysis.passages[0];
    return loadEvidenceStore(resource.id, initialPassage?.id || "");
  });
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const [noteMode, setNoteMode] = useState(() => androidApp);
  const [tool, setTool] = useState("pen");
  const [penSize, setPenSize] = useState(() => normalizePenSize(getUserItem(PEN_SIZE_STORAGE_KEY)));
  const [penMode, setPenMode] = useState(() => normalizePenMode(getUserItem(PEN_MODE_STORAGE_KEY)));
  const [eraserMode, setEraserMode] = useState(() => getUserItem("wuliao:pref:eraser-mode") || "normal");
  const [eraserSize, setEraserSize] = useState(24);
  const [color, setColor] = useState("#173a62");
  const [hasActiveInk, setHasActiveInk] = useState(false);
  const hasActiveInkRef = useRef(false);
  const [hasStoredPassageInk, setHasStoredPassageInk] = useState(false);
  const [answers, setAnswers] = useState({});
  const [redoAnswers, setRedoAnswers] = useState({});

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
  const [simplifiedExport, setSimplifiedExport] = useState(null);
  const [sentenceSelection, setSentenceSelection] = useState(null);
  const [evidenceEditor, setEvidenceEditor] = useState(null);
  const evidenceEditorRef = useRef(null);
  evidenceEditorRef.current = evidenceEditor;
  const [transcriptionTarget, setTranscriptionTarget] = useState(null);
  const [ocrTarget, setOcrTarget] = useState(null);
  const ocrGenerationRef = useRef(0);
  const ocrContextRef = useRef("");
  const [reviewTask, setReviewTask] = useState(null);
  const [reviewError, setReviewError] = useState("");
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryTab, setSummaryTab] = useState("summary");
  const [summaryRecords, setSummaryRecords] = useState([]);
  const [articleReviewTasks, setArticleReviewTasks] = useState([]);
  const aiLookupChainRef = useRef(Promise.resolve());
  const unknownAiControllersRef = useRef(new Set());
  const mountedRef = useRef(true);
  const hintTimerRef = useRef(null);
  useEffect(() => () => {
    mountedRef.current = false;
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
  }, []);
  const passage = analysis.passages[passageIndex];
  const ocrContextKey = `${storageUsername}:${resource.id}:${passage.id}:${inkStageId}`;
  ocrContextRef.current = ocrContextKey;
  useEffect(() => {
    setOcrTarget(null);
    setTranscriptionTarget(null);
    return () => {
      for (const controller of unknownAiControllersRef.current) controller.abort();
      unknownAiControllersRef.current.clear();
    };
  }, [ocrContextKey]);
  const hasPassageSwitcher = analysis.passages.length > 1;
  const flowCurrentStage = flow?.currentStage || "deep-cover";
  const activeQuestionAttempt = attemptForFlow(flow);
  const drawerAnswers = activeQuestionAttempt === "redo" ? redoAnswers : answers;
  const flowCompleted = isWorkflowCompleted(flow);
  const reviewActive = Boolean(reviewTaskKey);
  const activeReviewTaskKey = reviewTask?.taskKey || "";
  const reviewCheckUnlocked = Boolean(reviewTask?.session?.checkUnlocked);
  const questionDrawerAvailable = !reviewActive || reviewCheckUnlocked;
  const reviewPositionKey = (taskKey) => `wuliao:review-position:${taskKey}`;
  const timedReadingState = flow?.timedReading || {
    phase: "idle",
    elapsedMs: 0,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
  };
  const timedReadingActive = ["deep-clean-text", "deep-first-quiz"].includes(flowCurrentStage)
    && (timedReadingState.phase === "running" || timedReadingState.phase === "paused");
  const correctAnswers = useMemo(
    () => resource.kind === "official" ? getOfficialAnswerKey(resource) : {},
    [resource],
  );
  function capabilitiesForScope(scope, questionNumber) {
    if (scope === "drawer") scope = activeQuestionAttempt;
    const flowStage = scope === "redo"
      ? "deep-redo"
      : scope === "first"
        ? (flowCurrentStage === "deep-review" ? "deep-review" : "deep-first-quiz")
        : (["deep-clean-text", "deep-first-quiz"].includes(flowCurrentStage)
          ? "deep-first-quiz"
          : flowCurrentStage);
    const redoCompleted = scope === "redo" && Boolean(redoAnswers[questionNumber]);
    return questionCapabilities({
      flowStage,
      correctionRevealed: Boolean(correctionVisibility[scope]),
      hasReliableOfficialAnswer: hasReliableOfficialAnswer({
        resource,
        officialAnswers: correctAnswers,
        questionNumber,
      }),
      redoCompleted,
    });
  }
  const selectedOccurrences = useMemo(
    () => new Set(unknownWords.flatMap((word) => word.occurrences || [])),
    [unknownWords],
  );
  const contentRef = useRef(null);
  const readerPageRef = useRef(null);
  const activeInkRef = useRef(null);
  const committedInkLayerRef = useRef(null);
  const inkTilesRef = useRef(new Map());
  const inkTileIndexRef = useRef(null);
  const inkTileRendererRef = useRef(null);
  const inkTileGeometryRef = useRef(null);
  const inkTileBitmapCacheRef = useRef(null);
  if (!inkTileBitmapCacheRef.current) {
    inkTileBitmapCacheRef.current = createInkTileBitmapCache(32 * 1024 * 1024, releaseInkTile);
  }
  const displayedInkCacheRef = useRef(null);
  const stageInkCache = useMemo(() => createDeepInkStageCache(
    (key) => getUserItem(key, storageUsername),
  ), [storageUsername, resource.id, passage.id]);
  const inkTileSyncFrameRef = useRef(null);
  const viewportPreviewCanvasRef = useRef(null);
  const inkPreviewLayoutRef = useRef(null);
  const tailCanvasRef = useRef(null);
  const inkRenderFrameRef = useRef(null);
  const inkGeometrySnapshotRef = useRef(null);
  const inkGeometryAdapterRef = useRef(null);
  const inkStageRenderPendingRef = useRef(false);
  const strokesRef = useRef([]);
  const inkChanges = useMemo(() => createDeepInkChangeSource(), [resource.id, passage.id]);
  const inkStageIdRef = useRef(inkStageId);
  const pendingStrokeSaveRef = useRef(null);
  const pendingStageEditsRef = useRef(new Map());
  const serializeInkSnapshotRef = useRef(null);
  if (!serializeInkSnapshotRef.current) serializeInkSnapshotRef.current = createInkSnapshotSerializer();
  const strokeSaveTimerRef = useRef(null);
  const toolRef = useRef(tool);
  const colorRef = useRef(color);
  const penSizeRef = useRef(penSize);
  const penModeRef = useRef(penMode);
  const eraserModeRef = useRef(eraserMode);
  const eraserSizeRef = useRef(eraserSize);
  const noteModeRef = useRef(noteMode);
  const positionSaveTimerRef = useRef(null);
  const positionRestoredRef = useRef(false);
  const reviewPositionRestoredRef = useRef(false);
  const archiveJumpHandlerRef = useRef(null);
  const unknownSelectionRef = useRef(null);
  const flowRef = useRef(flow);
  const translationProgressRef = useRef(translationProgress);
  const evidenceRef = useRef(evidenceStore);
  const evidenceHighlightCleanupRef = useRef(null);
  const evidenceHighlightTimerRef = useRef({ show: null, clear: null });
  const timedReadingActiveRef = useRef(false);
  function publishInkChange(next, delta = { reset: true }) {
    inkChanges.publish(next, delta);
    const present = next.length > 0;
    if (hasActiveInkRef.current !== present) {
      hasActiveInkRef.current = present;
      setHasActiveInk(present);
    }
  }
  function refreshInkGeometrySnapshot() {
    const next = reuseDeepInkGeometry(inkGeometrySnapshotRef.current, buildDeepInkRegionSnapshot(contentRef.current));
    inkGeometrySnapshotRef.current = next;
    return next;
  }
  if (!inkGeometryAdapterRef.current) {
    inkGeometryAdapterRef.current = createDeepInkGeometryAdapter(
      () => inkGeometrySnapshotRef.current || refreshInkGeometrySnapshot(),
      refreshInkGeometrySnapshot,
    );
  }
  const projectInkStroke = useCallback((stroke) => {
    if (!inkGeometrySnapshotRef.current) refreshInkGeometrySnapshot();
    return inkGeometryAdapterRef.current.projectStroke(stroke);
  }, []);
  if (!inkTileIndexRef.current) {
    inkTileIndexRef.current = createDeepInkTileIndex({
      tileHeight: INK_TILE_HEIGHT, overlap: INK_TILE_OVERLAP,
      projectStroke: projectInkStroke, boundsForStroke: normalizedStrokeBounds,
    });
  }
  const hasTranslationProgressState = Object.keys(translationProgress?.sentences || {}).length > 0
    || Object.keys(translationProgress?.paragraphs || {}).length > 0;
  const canClearPassage = hasActiveInk || hasStoredPassageInk || hasClearableText || hasTranslationProgressState;
  const stageGroups = [
    ["导读", ["deep-cover"]],
    ["审题", ["deep-first-read"]],
    ["初做", ["deep-clean-text", "deep-first-quiz"]],
    ["逐段精读", ["deep-translation"]],
    ["重做", ["deep-redo"]],
    ["复读压缩", ["deep-review"]],
  ];
  const flowStageGroupIndex = Math.max(0, stageGroups.findIndex(([, ids]) => ids.includes(flowCurrentStage)));
  const editionLabel = resource.kind === "custom"
    ? (analysis.method === "ocr" ? "本地 OCR · 结构化精读版" : "本地文本 · 结构化精读版")
    : "考研真题 · 结构化精读版";

  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { penSizeRef.current = penSize; }, [penSize]);
  useEffect(() => { penModeRef.current = penMode; }, [penMode]);
  useEffect(() => { eraserModeRef.current = eraserMode; }, [eraserMode]);
  useEffect(() => { eraserSizeRef.current = eraserSize; }, [eraserSize]);
  useEffect(() => { noteModeRef.current = noteMode; }, [noteMode]);

  // 共享 Ink Runtime：精读 / 普通完形 / 模拟考试使用同一份笔系统实现。
  // 精读在同一纸张层内使用固定笔迹分块与可视范围预览带。
  const inkController = useStructuredInk({
    canInteract: () => !evidenceEditorRef.current && noteModeRef.current
      && !(timedReadingActiveRef.current && toolRef.current === "unknown"),
    surfaceRef: contentRef,
    previewCanvasRef: viewportPreviewCanvasRef,
    tailCanvasRef,
    strokesRef,
    activeRef: activeInkRef,
    toolRef,
    colorRef,
    penSizeRef,
    penModeRef,
    eraserModeRef,
    eraserSizeRef,
    commitAppendStroke: appendStrokeToTiles,
    renderCommitted: renderCommittedInk,
    renderDeletion: updateTilesForStrokes,
    persistStrokes,
    erasureSource: displayedStageInk,
    persistErasure: persistVisibleErasure,
    commitEraserStroke: commitVisibleEraser,
    captureUndo: captureVisibleInkUndo,
    toPreviewPixel: viewportToPixel,
    previewOptions: viewportInkOptions,
    previewCanvasSize: () => inkPreviewLayoutRef.current,
    surfaceSize: () => ({ width: contentRef.current.offsetWidth, height: contentRef.current.offsetHeight }),
    beforeSurfaceMeasure: () => {
      contentRef.current?.dispatchEvent(new Event("reader-paper-settle"));
      syncInkPreviewLayout();
    },
    renderPreviewStroke: (canvas, active) => {
      const layout = inkPreviewLayoutRef.current;
      const scale = active.rect.width / active.surface.width / layout.scale;
      const stroke = { ...active.stroke, width: active.stroke.width * scale,
        points: active.stroke.points.map((point) => {
          const [x, y] = deepInkPreviewPoint(point, active, layout);
          return { ...point, x: x / layout.width, y: y / layout.height };
        }),
      };
      renderInkLayer(canvas, [stroke], layout.width, layout.height, inkPixelRatio());
    },
    engineForPen: () => isAndroidApp(),
    geometryAdapter: inkGeometryAdapterRef.current,
    onStrokeDirty: (stroke) => strokeBoundsCache.delete(stroke),
    // Status text must not force the full reader to render before erased ink paints.
    onHint: (message) => startTransition(() => setHint(message)),
    ...createUnknownSelectionHooks({
      toolRef,
      fallbackToPenOnPenMiss: true,
      isWritingArea: (event) => Boolean(contentRef.current?.contains(event.target)) && !event.target.closest?.("button,input,textarea:not([data-ink-only=true]),select,[contenteditable=true],[data-unknown-ignore]") && !evidenceEditorRef.current,
      onRequestPenMode: () => { toolRef.current = "pen"; noteModeRef.current = true; setTool("pen"); setNoteMode(true); },
      selectionRef: unknownSelectionRef,
      onCollect: collectUnknownToken,
      onCommit: commitUnknownSelection,
      onError: setHint,
    }),
  });
  useEffect(() => { flowRef.current = flow; }, [flow]);
  useEffect(() => { inkStageIdRef.current = inkStageId; }, [inkStageId]);
  useEffect(() => {
    switchInkStage(flowCurrentStage);
  }, [resource.id, passage.id, flowCurrentStage]);
  useEffect(() => {
    if (flowCurrentStage !== "deep-clean-text") return;
    const current = flowRef.current;
    const next = enterInitialStage(current, Date.now());
    if (next !== current) persistFlow(next);
  }, [resource.id, passage.id, flowCurrentStage]);
  useEffect(() => { translationProgressRef.current = translationProgress; }, [translationProgress]);
  useEffect(() => { evidenceRef.current = evidenceStore; }, [evidenceStore]);
  useEffect(() => { timedReadingActiveRef.current = timedReadingActive; }, [timedReadingActive]);
  useEffect(() => {
    setFlow(getReadingFlow(resource.id, passage.id));
  }, [resource.id, passage.id]);
  useEffect(() => {
    setTranslationProgress(loadTranslationProgress(resource.id, passage.id));
  }, [resource.id, passage.id]);
  useEffect(() => {
    clearEvidenceHighlight();
    const next = loadEvidenceStore(resource.id, passage.id);
    evidenceRef.current = next;
    setEvidenceStore(next);
    setEvidenceEditor(null);
  }, [resource.id, passage.id]);
  useEffect(() => () => clearEvidenceHighlight(), []);
  useEffect(() => {
    if (!reviewTaskKey) {
      setReviewTask(null);
      setReviewError("");
      return;
    }
    const task = loadReviewTask(reviewTaskKey);
    if (!task) {
      setReviewError("复读任务不存在或已失效");
      setReviewTask(null);
      return;
    }
    if (task.completedAt != null || task.skippedAt != null) {
      setReviewError("该复读任务已结束，请在首页查看完成情况");
      setReviewTask(null);
      return;
    }
    const index = analysis.passages.findIndex((item) => item.id === task.passageId);
    if (index < 0) {
      setReviewError("文章结构已变化，无法打开这篇复读");
      setReviewTask(null);
      return;
    }
    setPassageIndex(index);
    positionRestoredRef.current = true;
    reviewPositionRestoredRef.current = false;
    const started = startReviewSession(task.taskKey);
    if (!started.ok) showHint(`复读开始失败：${started.error || "存储空间不足"}`);
    setReviewTask(started.task || task);
  }, [reviewTaskKey, resource.id, analysis]);

  useEffect(() => {
    if (!summaryInitially) return undefined;
    setSummaryTab(summaryTabInitially === "review" ? "review" : "summary");
    setSummaryOpen(true);
    return undefined;
  }, [summaryInitially, summaryTabInitially]);

  useEffect(() => {
    if (!summaryOpen) return undefined;
    setSummaryRecords(listLearningRecords());
    setArticleReviewTasks(
      listReviewTasks().filter(
        (task) => task.resourceId === resource.id && task.passageId === passage.id,
      ),
    );
    return undefined;
  }, [summaryOpen, resource.id, passage.id]);

  useEffect(() => {
    if (summaryOpen) setSummaryOpen(false);
  }, [passage.id]);
  useEffect(() => {
    if (!reviewActive) return undefined;
    const handleVisibility = () => {
      const now = Date.now();
      if (document.visibilityState === "hidden") pauseReviewTiming(activeReviewTaskKey, now);
      else resumeReviewTiming(activeReviewTaskKey, now);
    };
    const handlePageHide = () => pauseReviewTiming(activeReviewTaskKey, Date.now());
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      pauseReviewTiming(activeReviewTaskKey, Date.now());
    };
  }, [reviewActive, activeReviewTaskKey]);
  useBackHandler(() => {
    if (!showSource) return false;
    setShowSource(false);
    return true;
  }, {
    enabled: showSource,
    priority: BACK_PRIORITY.temporary,
  });

  useBackHandler(() => {
    if (!evidenceEditor) return false;
    setEvidenceEditor(null);
    return true;
  }, {
    enabled: Boolean(evidenceEditor),
    priority: BACK_PRIORITY.temporary,
  });
  useEffect(() => {
    if (timedReadingState.phase !== "running") return undefined;
    setTimerNow(Date.now());
    const timer = window.setInterval(() => setTimerNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timedReadingState.phase]);
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
    const api = window.WuliaoSelectionUi;
    if (!api) return undefined;
    const inEditable = (element) => (
      element instanceof Element
        && Boolean(element.closest("input, textarea, [contenteditable]"))
    );
    const updateByFocus = () => {
      const active = document.activeElement;
      api.setSuppressSelectionMenu(!(active instanceof Element && inEditable(active)));
    };
    const updateBySelection = () => {
      const selection = window.getSelection();
      const anchor = selection && selection.anchorNode;
      api.setSuppressSelectionMenu(
        !(anchor instanceof Node
          && anchor.parentElement
          && inEditable(anchor.parentElement)),
      );
    };
    const blurOnArticleTouch = (event) => {
      if (event.target instanceof Element && inEditable(event.target)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && inEditable(active)) active.blur();
    };
    api.setSuppressSelectionMenu(true);
    document.addEventListener("focusin", updateByFocus);
    document.addEventListener("focusout", updateByFocus);
    document.addEventListener("selectionchange", updateBySelection);
    window.addEventListener("pointerdown", blurOnArticleTouch, { capture: true });
    return () => {
      document.removeEventListener("focusin", updateByFocus);
      document.removeEventListener("focusout", updateByFocus);
      document.removeEventListener("selectionchange", updateBySelection);
      window.removeEventListener("pointerdown", blurOnArticleTouch, { capture: true });
      api.setSuppressSelectionMenu(false);
    };
  }, []);

  useEffect(() => {
    if (!noteMode) return undefined;
    if (!contentRef.current) return undefined;
    return installPenScrollGuard({
      root: contentRef,
      ownsPointer: (pointerId) => activeInkRef.current?.id === pointerId
        || unknownSelectionRef.current?.id === pointerId,
      hasActiveSession: () => Boolean(activeInkRef.current || unknownSelectionRef.current),
    });
  }, [noteMode]);

  useEffect(() => {
    const flushOnHide = () => {
      flushPendingStrokeSave();
      pauseRunningTimedReading();
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        flushPendingStrokeSave();
        pauseRunningTimedReading();
      }
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      backgroundSave(flushPendingStrokeSave);
      backgroundSave(pauseRunningTimedReadingSilently);
    };
  }, [resource.id, passage.id]);

  // 共享 Runtime 的 dispose（卸载时清理 rAF 与未结束会话）由 useStructuredInk 内部注册。

  useEffect(() => {
    exposeInkHandoffStats();
  }, []);

  useEffect(() => {
    flushPendingStrokeSave();
    inkController.clearUndo();
    const nextStrokes = loadStageInk(inkStageId);
    if (nextStrokes === null) return;
    strokesRef.current = nextStrokes;
    publishInkChange(nextStrokes);
    setHasStoredPassageInk(passageHasStoredInk());
    inkController.clearPreview();
    scheduleCommittedInkRender();
  }, [resource.id, passage.id, inkStageId]);

  useEffect(() => {
    const savedAnswers = loadJson(answerKey(resource.id, passage.id, "first"), {});
    const legacyAnswers = resource.kind === "custom" ? {} : loadJson(`wuliao:answers:${resource.id}`, {});
    const legacyDrawer = loadJson(answerKey(resource.id, passage.id, "drawer"), {});
    const hasRedoHistory = flowRef.current?.stages?.["deep-redo"]?.status !== "pending"
      || Object.keys(loadJson(answerKey(resource.id, passage.id, "redo"), {})).length > 0;
    const firstExists = getUserItem(answerKey(resource.id, passage.id, "first")) !== null;
    setAnswers(firstExists ? savedAnswers : Object.keys(legacyAnswers).length ? legacyAnswers : !hasRedoHistory ? legacyDrawer : {});
    setRedoAnswers(loadJson(answerKey(resource.id, passage.id, "redo"), {}));

    setCustomCorrectAnswers(loadJson(customAnswerKey(resource.id, passage.id), {}));
    setCorrectionVisibility({ first: false, redo: false, drawer: false });
    setReadingCompleted(isReadingCompleted(resource.id, passage.id));
    markReadingStarted(resource, passage);
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
    highlightSavedUnknownWords({
      root: contentRef.current,
      selectedOccurrences,
    });
    return () => globalThis.CSS?.highlights?.delete(SAVED_UNKNOWN_HIGHLIGHT);
  });

  useEffect(() => () => {
    globalThis.CSS?.highlights?.delete(SAVED_UNKNOWN_HIGHLIGHT);
    globalThis.CSS?.highlights?.delete(ACTIVE_UNKNOWN_HIGHLIGHT);
  }, []);

  useEffect(() => {
    let timer = null;
    const handleSelection = () => {
      if (exportingPdf || simplifiedExport) return;
      if (evidenceEditor) return;
      if (reviewActive && !reviewCheckUnlocked) {
        setSentenceSelection(null);
        return;
      }
      if (timedReadingActiveRef.current) {
        setSentenceSelection(null);
        return;
      }
      const selection = window.getSelection();
      const text = selection ? selection.toString().replace(/\s+/g, " ").trim() : "";
      const content = contentRef.current;
      if (!content) return;
      if (!text) {
        setSentenceSelection(null);
        return;
      }
      const anchor = selection.anchorNode;
      if (!(anchor instanceof Node) || !content.contains(anchor)) return;
      if (anchor.parentElement?.closest?.("input, textarea, [contenteditable], .sentence-action-bar")) return;
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return;
      const paragraphElement = anchor.parentElement?.closest?.("[data-unknown-scope]");
      const paragraph = paragraphElement ? paragraphTextFromElement(paragraphElement) : text;
      setSentenceSelection({
        sentence: text,
        contextSentence: sentenceTextFromElement(anchor.parentElement.closest("[data-sentence-scope]") || paragraphElement || anchor.parentElement),
        paragraph,
        chapter: resource.kind === "official"
          ? `英一.${String(resource.year).slice(-2)}.text${resource.text}`
          : (resource.title || passage.label),
        scope: null,
        mode: /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(text) ? "word" : /[.!?](?:\s|$)/.test(text) ? ((text.match(/[.!?](?:\s|$)/g) || []).length > 1 ? "paragraph" : "sentence") : "phrase",
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      });
    };
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(handleSelection, 80);
    };
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("pointerup", schedule);
    window.addEventListener("touchend", schedule);
    return () => {
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("pointerup", schedule);
      window.removeEventListener("touchend", schedule);
    };
  }, [evidenceEditor, exportingPdf, simplifiedExport, passage.id, passage.label, resource.kind, resource.title, resource.text, resource.year, reviewActive, reviewCheckUnlocked]);

  useEffect(() => {
    if (!sentenceSelection) return undefined;
    const clear = () => clearSentenceSelection();
    window.addEventListener("scroll", clear, { passive: true });
    return () => window.removeEventListener("scroll", clear);
  }, [sentenceSelection]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const resizeInkLayers = () => {
      inkController.finishActiveForGeometryChange();
      const previousGeometry = inkGeometrySnapshotRef.current?.byId;
      const nextGeometry = refreshInkGeometrySnapshot().byId;
      syncInkPreviewLayout();
      // The keyboard changes viewport height without changing the paper.
      // Reuse its bitmaps; only newly exposed tiles need to be painted.
      syncInkTiles(previousGeometry !== nextGeometry);
    };
    const observer = new ResizeObserver(() => {
      const active = activeInkRef.current;
      if (active && (active.surface.width !== content.offsetWidth || active.surface.height !== content.offsetHeight)) {
        inkController.finishActiveForGeometryChange();
      }
      const previousGeometry = inkGeometrySnapshotRef.current?.byId;
      if (refreshInkGeometrySnapshot().byId !== previousGeometry) scheduleCommittedInkRender();
    });
    observer.observe(content);
    const syncAfterLayout = () => {
      syncInkPreviewLayout();
      syncInkTiles(false);
    };
    const finishBeforeLayout = () => inkController.finishActiveForGeometryChange();
    content.addEventListener("reader-paper-will-layout", finishBeforeLayout);
    content.addEventListener("reader-paper-layout", syncAfterLayout);
    resizeInkLayers();
    window.addEventListener("resize", resizeInkLayers);
    const syncTilesOnScroll = () => {
      if (inkTileSyncFrameRef.current) return;
      inkTileSyncFrameRef.current = window.requestAnimationFrame(() => {
        inkTileSyncFrameRef.current = null;
        if (!activeInkRef.current) syncInkPreviewLayout();
        syncInkTiles(false);
      });
    };
    window.addEventListener("scroll", syncTilesOnScroll, { passive: true });
    return () => {
      observer.disconnect();
      content.removeEventListener("reader-paper-will-layout", finishBeforeLayout);
      content.removeEventListener("reader-paper-layout", syncAfterLayout);
      window.removeEventListener("resize", resizeInkLayers);
      window.removeEventListener("scroll", syncTilesOnScroll);
      if (inkRenderFrameRef.current) window.cancelAnimationFrame(inkRenderFrameRef.current);
      inkRenderFrameRef.current = null;
      if (inkTileSyncFrameRef.current) window.cancelAnimationFrame(inkTileSyncFrameRef.current);
      inkTileSyncFrameRef.current = null;
      for (const [, tile] of [...inkTilesRef.current.entries()]) {
        tile.width = 0;
        tile.height = 0;
        tile.remove();
      }
      inkTilesRef.current.clear();
      inkTileBitmapCacheRef.current.clear();
      inkTileRendererRef.current?.dispose();
      inkTileRendererRef.current = null;
      inkTileGeometryRef.current = null;
    };
  }, [passage.id, showSource]);

  useEffect(() => {
    syncInkPreviewLayout();
    syncInkTiles(false);
  }, [topAreaCollapsed]);

  useEffect(() => {
    if (positionRestoredRef.current) return;
    if (reviewActive) return;
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
  }, [resource.id, passage.id, reviewActive]);

  useEffect(() => {
    if (!reviewActive || !activeReviewTaskKey) return;
    if (reviewPositionRestoredRef.current) return;
    const saved = loadJson(reviewPositionKey(activeReviewTaskKey), null);
    if (!saved || saved.passageId !== passage.id) {
      reviewPositionRestoredRef.current = true;
      return;
    }
    const restore = () => {
      const exactTop = Number.isFinite(saved.scrollY) ? saved.scrollY : 0;
      window.scrollTo({ top: Math.max(0, exactTop), behavior: "auto" });
      reviewPositionRestoredRef.current = true;
    };
    const first = window.requestAnimationFrame(() => window.requestAnimationFrame(restore));
    const settled = window.setTimeout(restore, 420);
    return () => {
      window.cancelAnimationFrame(first);
      window.clearTimeout(settled);
    };
  }, [reviewActive, activeReviewTaskKey, passage.id]);

  useEffect(() => {
    if (reviewActive) return undefined;
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
      backgroundSave(flushPosition);
    };
  }, [resource.id, passage.id, activeStage, reviewActive]);

  useEffect(() => {
    if (!reviewActive || !activeReviewTaskKey) return undefined;
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
      backgroundSave(flushPosition);
    };
  }, [reviewActive, activeReviewTaskKey, passage.id, reviewTask?.session?.currentStep]);

  useEffect(() => {
    const finishExport = (event) => {
      setExportingPdf(false);
      setSimplifiedExport(null);
      document.documentElement.classList.remove("wuliao-exporting");
      setHint(event.detail?.success ? `精读成品已保存：${event.detail.location || "Download/无聊英语"}` : `PDF 导出失败：${event.detail?.message || "未知错误"}`);
      window.setTimeout(() => setHint(""), 3200);
    };
    window.addEventListener("wuliao-pdf-export-result", finishExport);
    return () => {
      window.removeEventListener("wuliao-pdf-export-result", finishExport);
      document.documentElement.classList.remove("wuliao-exporting");
    };
  }, []);

  useEffect(() => {
    const onToast = (event) => {
      if (event.detail?.message) showHint(event.detail.message);
    };
    window.addEventListener("wuliao:reader-toast", onToast);
    return () => window.removeEventListener("wuliao:reader-toast", onToast);
  }, []);

  useEffect(() => {
    if (!simplifiedExport || !exportingPdf) return undefined;
    const timer = window.setTimeout(() => {
      if (window.AndroidPdfExporter?.exportCurrentDocument) {
        window.AndroidPdfExporter.exportCurrentDocument(simplifiedExport.fileName);
      } else {
        window.print();
        setExportingPdf(false);
        setSimplifiedExport(null);
        document.documentElement.classList.remove("wuliao-exporting");
      }
    }, 260);
    return () => window.clearTimeout(timer);
  }, [simplifiedExport, exportingPdf]);

  function jumpTo(id) {
    return saveBeforeNavigation(() => {
    persistFlow(enterReadingStage(flowRef.current, id));
    changeViewedStage(id, true);
    stableScrollToElement(document.getElementById(id), { retries: 1 });
    }, storageUsername);
  }
  
  function scrollToStage(id) {
      const element = document.getElementById(id);
      if (!element) return;
      stableScrollToElement(element);
    }

  function scrollToStageAfterCommit(id) {
    const element = document.getElementById(id);
    if (!element) return;
    const top = window.scrollY + element.getBoundingClientRect().top - 90;
    window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  useLayoutEffect(() => {
    if (!pendingStageScrollTarget) return;
    setPendingStageScrollTarget(null);
    scrollToStageAfterCommit(pendingStageScrollTarget);
  }, [pendingStageScrollTarget]);

  function focusQuestionInDrawer(questionId) {
    readerPanelsRef.current?.openQuestion();
    const targetId = String(questionId || "");
    if (!targetId) return;
    let attempts = 0;
    const locateQuestion = window.setInterval(() => {
      attempts += 1;
      const drawer = document.querySelector(".question-drawer.open");
      const list = drawer?.querySelector(".question-list");
      const element = list?.querySelector(`[data-question-id="${cssEscape(targetId)}"]`);
      if (element && list) {
        const isExpanded = element.classList.contains("expanded");
        if (!isExpanded && attempts < 12) {
          setDrawerFocusQuestionId(targetId);
          return;
        }
        window.clearInterval(locateQuestion);
        setDrawerFocusQuestionId(null);
        const listRect = list.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        list.scrollTop = Math.max(0, list.scrollTop + (elementRect.top - listRect.top) - 10);
        return;
      }
      if (attempts > 20) {
        window.clearInterval(locateQuestion);
        setDrawerFocusQuestionId(null);
        showHint("未找到对应题目（内容可能已变化）");
      }
    }, 90);
  }

  function jumpToQuestion(question) {
    if (!question?.id) return;
    focusQuestionInDrawer(question.id);
  }

  function jumpToSentenceByPosition(paragraphNumber, sentenceIndex) {
      const paragraph = Number(paragraphNumber) || 0;
      const sentence = Math.max(0, Number(sentenceIndex) || 0);
      changeViewedStage("deep-translation");
      window.scrollTo({ top: 0 });
      const scope = `translation:p${paragraph}:s${sentence + 1}`;
      let located = false;
      let attempts = 0;
      const scrollToSentence = () => {
        attempts += 1;
        const element = document.querySelector(`[data-sentence-scope="${cssEscape(scope)}"]`);
        if (element) {
          if (located) return;
          located = true;
          stableScrollToElement(element);
        } else if (attempts >= 2) {
          showHint("未找到对应句子（内容可能已变化）");
        }
      };
      window.setTimeout(scrollToSentence, 220);
      window.setTimeout(scrollToSentence, 500);
    }

  function openArticleSummary(tab = "summary") {
    if (exportingPdf || simplifiedExport || reviewActive) return;
    setSummaryTab(tab === "review" ? "review" : "summary");
    setSummaryOpen(true);
  }

  function handleSummaryMarkMastered(key) {
    setSentenceReviewStatus(key, "mastered");
  }

  async function handleRemoveUnknownWord(wordId) {
    try {
      await deleteUnknownWord(wordId);
    } catch {
      showHint("移出陌生词失败，请重试");
    }
  }

  function handleConfirmTag(recordId, tagName) {
    updateTagStatus(recordId, tagName, "confirmed");
    setSummaryRecords(listLearningRecords());
  }

  function handleDismissTag(recordId, tagName) {
    updateTagStatus(recordId, tagName, "dismissed");
    setSummaryRecords(listLearningRecords());
  }

  function updateTranslationProgress(next) {
    if (!next || next === translationProgressRef.current) return;
    translationProgressRef.current = next;
    setTranslationProgress(next);
    saveTranslationProgress(next);
  }

  function currentTranslationTexts() {
    const texts = {};
    for (const paragraph of passage.paragraphs) {
      for (let sentenceIndex = 0; sentenceIndex < paragraph.sentences.length; sentenceIndex += 1) {
        const key = sentenceKeyFor({
          paragraphNumber: paragraph.number,
          sentenceIndex,
          sentenceText: paragraph.sentences[sentenceIndex],
        });
        texts[key] = getUserItem(translationKey(resource.id, passage.id, paragraph.number, sentenceIndex)) || "";
      }
    }
    return texts;
  }

  function scrollWorkbookTarget(element, highlightKey) {
      if (!element) return;
      stableScrollToElement(element);
      if (!highlightKey) return;
    const targets = contentRef.current?.querySelectorAll(
      `[data-translation-sentence="${cssEscape(highlightKey)}"], [data-translation-paragraph="${cssEscape(highlightKey)}"]`,
    );
    targets?.forEach((target) => {
      target.classList.remove("workbook-highlight");
      void target.offsetWidth;
      target.classList.add("workbook-highlight");
    });
    window.setTimeout(() => {
      targets?.forEach((target) => target.classList.remove("workbook-highlight"));
    }, 2400);
  }

  function continueNextTranslation() {
    const todo = nextTranslationTodo(translationProgressRef.current, passage, currentTranslationTexts());
    if (!todo) {
      const complete = document.querySelector("[data-translation-complete]");
      if (complete) scrollWorkbookTarget(complete);
      else showHint("全部句子与段落已完成");
      return;
    }
    if (todo.type === "sentence") {
      const element = contentRef.current?.querySelector(`[data-translation-sentence="${cssEscape(todo.key)}"]`);
      scrollWorkbookTarget(element, todo.key);
      return;
    }
    const paragraphKey = `p${todo.paragraphNumber}`;
    const element = contentRef.current?.querySelector(`[data-translation-paragraph="${cssEscape(paragraphKey)}"]`);
    const firstSentence = element?.querySelector("[data-translation-sentence]");
    scrollWorkbookTarget(firstSentence || element, paragraphKey);
  }

  function continueToNextParagraph(currentNumber) {
    const next = passage.paragraphs.find(
      (item) => item.number > currentNumber && !paragraphState(translationProgressRef.current, item).completed,
    );
    if (!next) {
      continueNextTranslation();
      return;
    }
    const paragraphKey = `p${next.number}`;
    const element = contentRef.current?.querySelector(`[data-translation-paragraph="${cssEscape(paragraphKey)}"]`);
    const firstSentence = element?.querySelector("[data-translation-sentence]");
    scrollWorkbookTarget(firstSentence || element, paragraphKey);
  }

  function markTranslationDone(key) {
    const next = progressMarkTranslated(translationProgressRef.current, key, Date.now());
    updateTranslationProgress(next);
    showHint("已完成笔译，可以开始订正");
  }

  function markSentenceCorrected(key, translationText, sentenceInfo = null) {
    let progress = translationProgressRef.current;
    let current = progress.sentences?.[key];
    if (!current && sentenceInfo) {
      const derived = sentenceEntryFor(progress, {
        ...sentenceInfo,
        translationText: String(translationText || ""),
      });
      if (derived.entry.translationStatus === "translated") {
        progress = progressMarkTranslated(progress, key, Date.now());
        current = progress.sentences[key];
      }
    }
    if (!current || current.translationStatus !== "translated") {
      showHint("请先完成自己的笔译，再进行订正");
      return;
    }
    const next = progressMarkCorrected(progress, key, {
      translationText: String(translationText || ""),
      now: Date.now(),
    });
    updateTranslationProgress(next);
    showHint("已标记完成订正");
  }

  function setSentenceReviewStatus(key, status) {
    const next = progressSetReviewStatus(translationProgressRef.current, key, status, Date.now());
    updateTranslationProgress(next);
    if (status === "mastered") showHint("已标记为已掌握");
    else if (status === "needs_review") showHint("已加入待复盘");
  }

  function handleTranslationEdited(key, translationText) {
    const next = progressHandleTranslationEdited(translationProgressRef.current, key, translationText);
    if (next) {
      updateTranslationProgress(next);
      showHint("译文已修改，请重新订正");
    }
  }

  function completeParagraph(paragraphNumber) {
    const next = markParagraphCompleted(translationProgressRef.current, paragraphNumber, Date.now());
    updateTranslationProgress(next);
    showHint(`第 ${paragraphNumber} 段已完成`);
  }

  function sentenceIdToWorkbookKey(sentenceId) {
    const match = /::p(\d+)s(\d+)$/.exec(String(sentenceId || ""));
    if (!match) return null;
    const paragraphNumber = Number(match[1]);
    const sentenceIndex = Number(match[2]) - 1;
    const paragraph = passage.paragraphs.find((item) => item.number === paragraphNumber);
    const sentenceText = paragraph?.sentences?.[sentenceIndex];
    if (!sentenceText) return null;
    return sentenceKeyFor({ paragraphNumber, sentenceIndex, sentenceText });
  }

  function markCorrectedFromReviewMeta(reviewMeta) {
    const match = /::p(\d+)s(\d+)$/.exec(String(reviewMeta?.sentenceId || ""));
    if (!match) {
      showHint("未找到对应句子（内容可能已变化）");
      return;
    }
    const paragraphNumber = Number(match[1]);
    const sentenceIndex = Number(match[2]) - 1;
    const paragraph = passage.paragraphs.find((item) => item.number === paragraphNumber);
    const sentenceText = paragraph?.sentences?.[sentenceIndex];
    if (!sentenceText) {
      showHint("未找到对应句子（内容可能已变化）");
      return;
    }
    const key = sentenceKeyFor({ paragraphNumber, sentenceIndex, sentenceText });
    const current = translationProgressRef.current.sentences?.[key];
    if (current?.translationStatus === "corrected") {
      showHint("这句已经完成订正");
      return;
    }
    markSentenceCorrected(key, reviewMeta?.userTranslation || "", { paragraphNumber, sentenceIndex, sentenceText });
  }

  function isSentenceCorrected(sentenceId) {
    const key = sentenceIdToWorkbookKey(sentenceId);
    if (!key) return false;
    return translationProgressRef.current?.sentences?.[key]?.translationStatus === "corrected";
  }

  function saveReadingPosition() {
    const key = reviewActive
      ? reviewPositionKey(activeReviewTaskKey)
      : positionKey(resource.id);
    if (reviewActive) {
      setUserItem(key, JSON.stringify({
        passageId: passage.id,
        anchorId: "",
        offset: 0,
        scrollY: window.scrollY,
        updatedAt: Date.now(),
      }));
      return;
    }
    const anchors = STAGE_IDS
      .map((id) => document.getElementById(id))
      .filter((item) => Boolean(item && item.getClientRects().length > 0));
    const targetY = window.scrollY + 150;
    const anchor = [...anchors].reverse().find((item) => item.offsetTop <= targetY) || anchors[0];
    if (!anchor) return;
    setUserItem(key, JSON.stringify({
      passageId: passage.id,
      anchorId: anchor.id,
      offset: Math.max(0, window.scrollY - anchor.offsetTop),
      scrollY: window.scrollY,
      updatedAt: Date.now(),
    }));
  }

  function persistFlow(next) {
    const previousStage = flowRef.current?.currentStage;
    if (next?.currentStage && next.currentStage !== previousStage) switchInkStage(next.currentStage);
    flowRef.current = next;
    setFlow(next);
    saveReadingFlow(next);
  }

  function prepareInkScopeChange({ clearCommitted = false } = {}) {
    inkController.finishActiveForGeometryChange();
    flushPendingStrokeSave();
    if (inkRenderFrameRef.current) window.cancelAnimationFrame(inkRenderFrameRef.current);
    inkRenderFrameRef.current = null;
    if (inkTileSyncFrameRef.current) window.cancelAnimationFrame(inkTileSyncFrameRef.current);
    inkTileSyncFrameRef.current = null;
    if (clearCommitted) {
      strokesRef.current = [];
      publishInkChange([]);
      for (const tile of inkTilesRef.current.values()) {
        tile.getContext("2d")?.clearRect(0, 0, tile.width, tile.height);
      }
    }
    inkController.clearPreview();
  }

  function switchInkStage(stageId) {
    const scopeId = inkScopeStageId(stageId);
    if (!STAGE_IDS.includes(scopeId) || inkStageIdRef.current === scopeId) return;
    prepareInkScopeChange();
    const nextStrokes = loadStageInk(scopeId);
    if (nextStrokes === null) return;
    inkStageIdRef.current = scopeId;
    strokesRef.current = nextStrokes;
    publishInkChange(nextStrokes);
    setInkStageId(scopeId);
    setHasStoredPassageInk(passageHasStoredInk());
    // 新阶段 DOM 提交后刷新几何并安排历史回放；保留现有位图直到新结果就绪，
    // 由任务版本阻止旧阶段的异步结果覆盖当前画布。
    inkStageRenderPendingRef.current = true;
  }

  useLayoutEffect(() => {
    if (!inkStageRenderPendingRef.current) return;
    inkStageRenderPendingRef.current = false;
    refreshInkGeometrySnapshot();
    renderCommittedInk();
    publishInkChange(strokesRef.current);
  }, [inkStageId]);

  function changeViewedStage(stageId, saved = false) {
    if (!saved) return saveBeforeNavigation(() => changeViewedStage(stageId, true), storageUsername);
    switchInkStage(stageId);
    setActiveStage(stageId);
  }

  function passageHasStoredInk() {
    const legacy = stageInkCache.read(inkKey(resource.id, passage.id));
    if (legacy.length) return true;
    return STAGE_IDS.some((stageId) => stageInkCache.read(passageStageInkKey(resource.id, passage.id, stageId)).length > 0);
  }

  function ensureStageInkStorage() {
    const legacy = loadJson(inkKey(resource.id, passage.id), []);
    const sourceDigest = deepInkDigest(legacy);
    const migrationKey = passageStageInkMigrationKey(resource.id, passage.id);
    const cleanStageKey = passageStageInkKey(resource.id, passage.id, "deep-clean-text");
    const initialStageKey = passageStageInkKey(resource.id, passage.id, "deep-first-quiz");
    const existingCleanInk = loadJson(cleanStageKey, []);
    const existingInitialInk = loadJson(initialStageKey, []);
    const combinedInitialInk = mergeDeepInkStrokes(existingCleanInk, existingInitialInk);
    if (combinedInitialInk.length !== existingInitialInk.length) {
      try { setUserItem(initialStageKey, JSON.stringify(combinedInitialInk)); } catch { return false; }
    }
    const marker = loadJson(migrationKey, null);
    if (marker?.schemaVersion === 2 && marker.sourceDigest === sourceDigest) return true;

    const snapshot = refreshInkGeometrySnapshot();
    const { byStage, unresolved } = partitionDeepInkByStage(legacy, snapshot, STAGE_IDS);
    if (unresolved.length) {
      showHint("旧版字迹暂未分阶段：页面布局尚未稳定，请稍后重试");
      return false;
    }

    const previousValues = new Map();
    try {
      const stageCounts = {};
      for (const stageId of STAGE_IDS) {
        const key = passageStageInkKey(resource.id, passage.id, stageId);
        const previousRaw = getUserItem(key);
        previousValues.set(key, previousRaw);
        const existing = loadJson(key, []);
        const migrated = stageId === "deep-first-quiz"
          ? mergeDeepInkStrokes(byStage["deep-clean-text"], byStage["deep-first-quiz"])
          : stageId === "deep-clean-text" ? [] : byStage[stageId];
        const carry = stageId === "deep-first-quiz" ? loadJson(cleanStageKey, []) : [];
        const merged = mergeDeepInkStrokes(migrated, mergeDeepInkStrokes(carry, existing));
        stageCounts[stageId] = merged.length;
        if (merged.length || previousRaw !== null) setUserItem(key, JSON.stringify(merged));
      }
      for (const stageId of STAGE_IDS) {
        const stored = loadJson(passageStageInkKey(resource.id, passage.id, stageId), []);
        if (stored.length !== stageCounts[stageId]) throw new Error("stage ink verification failed");
      }
      setUserItem(migrationKey, JSON.stringify({
        schemaVersion: 2,
        sourceDigest,
        legacyStrokeCount: legacy.length,
        stageCounts,
        migratedAt: Date.now(),
      }));
      return true;
    } catch {
      for (const [key, previousRaw] of previousValues) {
        if (previousRaw === null) removeUserItem(key);
        else setUserItem(key, previousRaw);
      }
      showHint("阶段字迹保存空间不足，旧版字迹保持原样，未删除任何数据");
      return false;
    }
  }

  function loadStageInk(stageId) {
    if (!ensureStageInkStorage()) return null;
    const key = passageStageInkKey(resource.id, passage.id, inkScopeStageId(stageId));
    const saved = stageInkCache.read(key);
    // Prepare the immutable prefix while loading, before the first real stroke.
    if (Array.isArray(saved)) serializeInkSnapshotRef.current(key, saved);
    return saved;
  }

  function displayedStageInk(currentStageStrokes = strokesRef.current) {
    if (!inkGeometrySnapshotRef.current) refreshInkGeometrySnapshot();
    const currentScopeId = inkStageIdRef.current;
    const visibleScopeIds = [];
    const seen = new Set();
    for (const stageId of STAGE_IDS) {
      if (!inkGeometrySnapshotRef.current.byId.has(`stage:${stageId}`)) continue;
      const scopeId = inkScopeStageId(stageId);
      if (seen.has(scopeId)) continue;
      seen.add(scopeId);
      visibleScopeIds.push(scopeId);
    }
    const parts = visibleScopeIds.map((scopeId) => (
      scopeId === currentScopeId
        ? currentStageStrokes
        : stageInkCache.read(passageStageInkKey(resource.id, passage.id, scopeId))
    ));
    const cached = displayedInkCacheRef.current;
    if (cached?.parts.length === parts.length && parts.every((part, index) => part === cached.parts[index])) return cached.strokes;
    const combined = parts.length === 1 ? parts[0] : parts.flat();
    displayedInkCacheRef.current = { parts, strokes: combined };
    return combined;
  }

  function visibleInkScopes() {
    displayedStageInk();
    return [...new Set(STAGE_IDS.filter(id => inkGeometrySnapshotRef.current.byId.has(`stage:${id}`)).map(inkScopeStageId))];
  }

  function readScopeInk(scope) {
    return scope === inkStageIdRef.current ? strokesRef.current
      : stageInkCache.read(passageStageInkKey(resource.id, passage.id, scope));
  }

  function replaceScopeInk(scope, next) {
    if (readScopeInk(scope) === next) return;
    if (scope === inkStageIdRef.current) {
      persistStrokes(next, { skipTileRedraw: true, structural: true });
    } else {
      const key = passageStageInkKey(resource.id, passage.id, scope);
      stageInkCache.remember(key, getUserItem(key), next);
      pendingStageEditsRef.current.set(key, next);
      if (strokeSaveTimerRef.current) cancelScheduledInkSave(strokeSaveTimerRef.current);
      strokeSaveTimerRef.current = scheduleInkSave(flushPendingStrokeSave);
    }
  }

  function captureVisibleInkUndo() {
    let before = visibleInkScopes().map(scope => [scope, readScopeInk(scope)]);
    let patches;
    const restore = () => {
      const previous = displayedStageInk();
      for (const [scope, patch] of patches) replaceScopeInk(scope, patch(readScopeInk(scope)));
      updateTilesForStrokes(displayedStageInk(), previous);
      setHasStoredPassageInk(passageHasStoredInk());
    };
    restore.seal = () => {
      patches = before.map(([scope, strokes]) => [scope, createInkUndoPatch(strokes, readScopeInk(scope))]);
      before = null;
    };
    return restore;
  }

  function persistVisibleErasure(next, source) {
    const kept = new Set(next);
    for (const scope of visibleInkScopes()) {
      const previous = readScopeInk(scope);
      const remaining = previous.filter(stroke => kept.has(stroke));
      if (remaining.length !== previous.length) replaceScopeInk(scope, remaining);
    }
    setHasStoredPassageInk(passageHasStoredInk());
  }

  function commitVisibleEraser(stroke) {
    const previous = displayedStageInk();
    for (const scope of visibleInkScopes()) {
      const current = readScopeInk(scope);
      if (current.length) replaceScopeInk(scope, [...current, stroke]);
    }
    updateTilesForStrokes(displayedStageInk(), previous);
    setHasStoredPassageInk(passageHasStoredInk());
  }

  function pauseRunningTimedReading() {
    const current = flowRef.current;
    if (!current || !["deep-clean-text", "deep-first-quiz"].includes(current.currentStage) || current.timedReading.phase !== "running") return;
    persistFlow(pauseTimedReading(current, Date.now()));
  }

  function pauseRunningTimedReadingSilently() {
    const current = flowRef.current;
    if (!current || !["deep-clean-text", "deep-first-quiz"].includes(current.currentStage) || current.timedReading.phase !== "running") return;
    const paused = pauseTimedReading(current, Date.now());
    flowRef.current = paused;
    saveReadingFlow(paused);
  }

  function handleResumeTimedReading() {
    const current = flowRef.current;
    if (!["deep-clean-text", "deep-first-quiz"].includes(current.currentStage) || current.timedReading.phase !== "paused") return;
    persistFlow(resumeTimedReading(current, Date.now()));
    setTimerNow(Date.now());
  }

  function handleCompleteStage(stageId, saved = false) {
    if (stageId === "deep-translation") return jumpTo("deep-redo");
    if (!saved) return saveBeforeNavigation(() => handleCompleteStage(stageId, true), storageUsername);
    const current = flowRef.current;
    const now = Date.now();
    let prepared = current;
    if (stageId === "deep-first-quiz" && current.timedReading.phase !== "done") {
      prepared = finishTimedReading(current, now);
    }
    let next = completeFlowStage(prepared, stageId, now);
    if (next.currentStage === "deep-clean-text") next = enterInitialStage(next, now);
    if (next === current) return;
    persistFlow(next);
    const fromLabel = STAGE_LABELS[stageId] || stageId;
    if (next.currentStage && next.currentStage !== stageId) {
      const toLabel = STAGE_LABELS[next.currentStage] || next.currentStage;
      const viewTarget = stageId === "deep-first-read" && next.currentStage === "deep-first-quiz"
        ? "deep-clean-text"
        : next.currentStage;
      setActiveStage(viewTarget);
      setPendingStageScrollTarget(viewTarget);
      showHint(`已完成「${fromLabel}」，进入「${toLabel}」`);
    }
  }

  function persistStrokes(next, { skipTileRedraw = false, structural = false } = {}) {
    const previous = strokesRef.current;
    strokesRef.current = next;
    inkTileBitmapCacheRef.current.clear();
    const previousSet = new Set(previous);
    const nextSet = new Set(next);
    const added = next.filter((stroke) => !previousSet.has(stroke));
    const removed = previous.filter((stroke) => !nextSet.has(stroke));
    // Only units whose ink presence changes need a React update. The full
    // immutable history belongs to the canvas/save refs, not workbook state.
    startTransition(() => {
      publishInkChange(next, { added, removed });
    });
    // 普通新增笔画已在 finishInk 中 append-only 提交，跳过重复的 tile 重绘。
    if (!skipTileRedraw) updateTilesForStrokes(next, previous);
    pendingStrokeSaveRef.current = {
      key: passageStageInkKey(resource.id, passage.id, inkStageIdRef.current),
      strokes: next,
      // A structural edit before this scheduled flush invalidates the prefix.
      appendOnly: skipTileRedraw && !structural && pendingStrokeSaveRef.current?.appendOnly !== false,
      reuseUnchanged: structural || pendingStrokeSaveRef.current?.reuseUnchanged === true,
    };
    if (strokeSaveTimerRef.current) cancelScheduledInkSave(strokeSaveTimerRef.current);
    strokeSaveTimerRef.current = scheduleInkSave(flushPendingStrokeSave);
  }

  function flushPendingStrokeSave() {
    if (strokeSaveTimerRef.current) cancelScheduledInkSave(strokeSaveTimerRef.current);
    strokeSaveTimerRef.current = null;
    for (const [key, strokes] of pendingStageEditsRef.current) {
      const snapshot = serializeInkSnapshotRef.current(key, strokes, { reuseUnchanged: true });
      setUserItem(key, snapshot);
      stageInkCache.remember(key, snapshot.json, strokes);
      pendingStageEditsRef.current.delete(key);
    }
    const pending = pendingStrokeSaveRef.current;
    if (!pending) return;
    const startedAt = performance.now();
    const snapshot = serializeInkSnapshotRef.current(pending.key, pending.strokes,
      { appendOnly: pending.appendOnly, reuseUnchanged: pending.reuseUnchanged });
    setUserItem(pending.key, snapshot);
    stageInkCache.remember(pending.key, snapshot.json, pending.strokes);
    try {
      getTelemetry().recordTiming({ metric: "ink.save", durationMs: performance.now() - startedAt });
    } catch {
      // Telemetry 异常绝不影响笔迹保存
    }
    pendingStrokeSaveRef.current = null;
  }
  useSaveBoundary(() => {
    inkController.finishActiveForGeometryChange();
    flushPendingStrokeSave();
    pauseRunningTimedReadingSilently();
    saveReadingPosition();
  });

  function chooseAnswer(attempt, number, option) {
    if (attempt === "drawer") attempt = attemptForFlow(flowRef.current);
    if (attempt !== "first" && attempt !== "redo") return;
    const setter = attempt === "first" ? setAnswers : setRedoAnswers;
    setter((current) => {
      const next = { ...current, [number]: option };
      setUserItem(answerKey(resource.id, passage.id, attempt), JSON.stringify(next), storageUsername);
      return next;
    });
  }

  function evidenceKeyForQuestion(question, questionIndex = -1) {
    const index = questionIndex >= 0
      ? questionIndex
      : passage.questions.findIndex((item) => item.id === question.id);
    return questionKeyFor({
      resourceId: resource.id,
      passageId: passage.id,
      questionNumber: question.number,
      questionStem: question.stem,
      questionIndex: index,
    });
  }

  function persistEvidence(next) {
    evidenceRef.current = next;
    setEvidenceStore(next);
    saveEvidenceStore(next);
  }

  function clearEvidenceHighlight() {
    const timers = evidenceHighlightTimerRef.current;
    if (timers.show != null) window.clearTimeout(timers.show);
    if (timers.clear != null) window.clearTimeout(timers.clear);
    evidenceHighlightTimerRef.current = { show: null, clear: null };
    evidenceHighlightCleanupRef.current?.();
    evidenceHighlightCleanupRef.current = null;
  }

    function scrollToQuestionCard(questionKey) {
      const element = contentRef.current?.querySelector(`[data-question-key="${cssEscape(questionKey)}"]`);
      if (!element) return;
      stableScrollToElement(element, { offset: 110 });
    }

  function focusNextIncomplete(attempt, completion) {
    const answerMissing = completion?.remainingWithoutAnswer?.[0];
    const evidenceMissing = completion?.remainingWithoutEvidence?.[0];
    const number = answerMissing ?? evidenceMissing;
    const question = passage.questions.find((item) => String(item.number) === String(number));
    if (!question) return;
    const stageId = attempt === "redo" ? "deep-redo" : "deep-first-quiz";
    const questionKey = evidenceKeyForQuestion(question);
    changeViewedStage(stageId);
    scrollToStage(stageId);
    window.setTimeout(() => scrollToQuestionCard(questionKey), 420);
    showHint(answerMissing != null
      ? `先完成 Q${question.number} 的作答`
      : `再完成 Q${question.number} 的原文依据定位`);
  }

  function returnToEvidenceOrigin(editor) {
    if (!editor) return;
    if (editor.origin === "drawer") {
      readerPanelsRef.current?.openQuestion();
      setDrawerFocusQuestionId(editor.question.id);
      return;
    }
    const stageId = editor.attempt === "redo" ? "deep-redo" : "deep-first-quiz";
    changeViewedStage(stageId);
    scrollToStage(stageId);
    window.setTimeout(() => scrollToQuestionCard(editor.questionKey), 420);
  }

  function openEvidenceEditor(question, attempt, origin, mode = "text") {
    if (exportingPdf || simplifiedExport) return;
    if (reviewActive && !reviewCheckUnlocked) {
      showHint("复读提取阶段：先独立回忆，核对后恢复证据编辑");
      return;
    }
    const questionKey = evidenceKeyForQuestion(question);
    const existing = entryFor(evidenceRef.current, questionKey, attempt);
    const requestedMode = ["global", "sentences"].includes(mode) ? mode : "text";
    const draft = setEvidenceMode(draftFromEntry(existing, passage, { preserveSentences: true }), requestedMode);
    setEvidenceEditor({ question, questionKey, attempt, origin, draft });
    if (draft.mode !== "global") {
      changeViewedStage("deep-clean-text");
      scrollToStage("deep-clean-text");
    }
  }

  function captureEvidenceSelection(selection, articleElement) {
    const editor = evidenceEditor;
    if (!editor || editor.draft.mode !== "text") return;
    const range = evidenceRangeFromSelection(selection, articleElement, passage);
    if (!range) {
      showHint("请只选择干净原文中的连续文字");
      return;
    }
    const result = addTextRange(editor.draft, range);
    if (result.rejected) {
      showHint(result.reason === "limit" ? "每题最多保留 3 处核心原文依据" : "这段选择无法保存");
      return;
    }
    if (result.reason === "duplicate") showHint("这段原文已经选过了");
    else showHint("原文依据已加入，请选择依据类型后确认");
    setEvidenceEditor({ ...editor, draft: result.draft });
    selection?.removeAllRanges?.();
  }

  function switchEvidenceEditorMode(mode) {
    const editor = evidenceEditor;
    if (!editor) return;
    const draft = setEvidenceMode(editor.draft, mode);
    setEvidenceEditor({ ...editor, draft });
    if (mode !== "global") {
      changeViewedStage("deep-clean-text");
      scrollToStage("deep-clean-text");
    }
  }

  function clearEvidenceEditorDraft() {
    const editor = evidenceEditor;
    if (!editor) return;
    const draft = setEvidenceMode(emptyTextEvidenceEntry(), editor.draft.mode);
    setEvidenceEditor({ ...editor, draft });
  }

  function completeEvidenceEditor() {
    const editor = evidenceEditor;
    if (!editor) return;
    if (!entryComplete(editor.draft)) {
      showHint(editor.draft.mode === "global"
        ? "请先选择全文依据类型"
        : "请先选择原文片段，并选择依据类型");
      return;
    }
    if (editor.draft.mode === "text" && !entryResolutionOk(editor.draft, passage)) {
      showHint("所选原文已无法稳定定位，请重新选择至少一处完整依据");
      return;
    }
    persistEvidence(setEvidence(evidenceRef.current, editor.questionKey, editor.attempt, editor.draft));
    setEvidenceEditor(null);
    showHint(`Q${editor.question.number} ${editor.attempt === "first" ? "首次" : "重做"}证据已保存`);
    returnToEvidenceOrigin(editor);
  }

  function cancelEvidenceEditor() {
    const editor = evidenceEditor;
    if (!editor) return;
    setEvidenceEditor(null);
    returnToEvidenceOrigin(editor);
  }

  function viewEvidence(question, attempt) {
    clearEvidenceHighlight();
    const questionKey = evidenceKeyForQuestion(question);
    const entry = entryFor(evidenceRef.current, questionKey, attempt);
    if (!entry) {
      showHint("本题还没有证据");
      return;
    }
    if (entry.mode === "global") {
      if (entryNeedsType(entry)) {
        showHint("这条历史依据需补充类型后才算完成");
        return;
      }
      showHint(`证据：${entrySummaryLabel(entry) || "全文/结构依据"}`);
      return;
    }
    if (entry.mode === "text") {
      changeViewedStage("deep-clean-text");
      scrollToStage("deep-clean-text");
      evidenceHighlightTimerRef.current.show = window.setTimeout(() => {
        evidenceHighlightTimerRef.current.show = null;
        const articleElement = contentRef.current?.querySelector(".clean-article");
        const result = showEvidenceHighlight({ entry, passage, articleElement });
        if (!result.ok) {
          showHint("原文结构发生变化，旧依据无法精确恢复");
          return;
        }
        evidenceHighlightCleanupRef.current = result.clear;
        result.firstNode?.scrollIntoView({ behavior: "smooth", block: "center" });
        showHint(`${result.partial ? "部分依据已定位" : "原文依据 · 已定位"}：${entry.ranges.map(textRangeExcerpt).filter(Boolean).join(" / ")}`);
        evidenceHighlightTimerRef.current.clear = window.setTimeout(() => {
          clearEvidenceHighlight();
        }, 3600);
      }, 420);
      return;
    }
    const resolutions = resolveEntry(entry, passage);
    if (!resolutions.length || resolutions.some((item) => item.status !== "resolved")) {
      showHint("原文结构发生变化，旧证据无法精确恢复");
      return;
    }
    const targets = resolutions.map((item) => contentRef.current?.querySelector(
      `[data-sentence-scope="clean:p${item.ref.paragraphNumber}:s${item.ref.sentenceIndex + 1}"]`,
    )).filter(Boolean);
    if (!targets.length) {
      showHint("原文结构发生变化，旧证据无法精确恢复");
      return;
    }
    changeViewedStage("deep-clean-text");
    scrollToStage("deep-clean-text");
    window.setTimeout(() => {
      const first = targets[0];
      first?.scrollIntoView({ behavior: "smooth", block: "start" });
      targets.forEach((target) => {
        target.classList.remove("evidence-highlight");
        void target.offsetWidth;
        target.classList.add("evidence-highlight");
      });
      window.setTimeout(() => {
        targets.forEach((target) => target.classList.remove("evidence-highlight"));
      }, 2400);
    }, 420);
  }

  function userEvidenceTextForDiagnosis(question) {
    const lines = [];
    for (const attempt of ["first", "redo"]) {
      const questionKey = evidenceKeyForQuestion(question);
      const entry = entryFor(evidenceRef.current, questionKey, attempt);
      if (!entry) continue;
      const label = attempt === "first" ? "用户首次依据" : "用户重做依据";
      if (entry.mode === "global") {
        lines.push(`${label}：全文/结构依据${entry.globalType ? `（${GLOBAL_TYPE_LABELS[entry.globalType]}）` : ""}`);
      } else if (entry.mode === "text") {
        const excerpts = entry.ranges.map(textRangeExcerpt).filter(Boolean);
        lines.push(`${label}：${entrySummaryLabel(entry)}；${excerpts.map((text) => `“${text}”`).join("；")}`);
      } else {
        lines.push(`${label}：${entry.references.map((ref) => `${sentenceRefLabel(ref)} “${ref.excerpt}”`).join("；")}`);
      }
    }
    return lines.join("\n");
  }

  function requestQuestionHint(question, level, scope, options = {}) {
    const chapter = chapterLabel(resource, passage);
    const baseDetail = {
      resourceId: resource.id,
      passageId: passage.id,
      chapter,
      questionId: question.id,
      questionNumber: String(question.number || ""),
      questionText: String(question.stem || "").trim(),
      articleText: passage.paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
      passageLabel: passage.label,
      scope,
    };
    const capabilities = capabilitiesForScope(scope, question.number);
    const useExplanation = level === 3;

    if (useExplanation) {
      if (!capabilities.showExplanation) {
        showHint("完成重做并订正后才能查看完整讲解");
        return;
      }
      emitAppEvent(AppEvent.AI_REQUEST, {
        type: TASK_QUESTION_EXPLANATION,
        ...baseDetail,
        options: question.options || [],
        officialAnswer: correctAnswers[question.number] || "",
        firstAnswer: answers[question.number] || "",
        redoAnswer: redoAnswers[question.number] || "",
        drawerAnswer: drawerAnswers[question.number] || "",
        canShowFullExplanation: true,
        origin: options.origin || "entry",
      });
      return;
    }

    if (!capabilities.showAiHint) {
      showHint("当前阶段不开放 AI 提示");
      return;
    }

    emitAppEvent(AppEvent.AI_REQUEST, {
      type: level === 2 ? TASK_QUESTION_HINT_2 : TASK_QUESTION_HINT_1,
      ...baseDetail,
      origin: options.origin || "entry",
    });
  }

  function diagnosisLabelForScope(question, scope) {
    if (!capabilitiesForScope(scope, question.number).showDiagnosis) return null;
    return getQuestionDiagnosisEntryLabel({
      firstAnswer: answers[question.number] || "",
      redoAnswer: redoAnswers[question.number] || "",
      officialAnswer: correctAnswers[question.number] || "",
    });
  }

  function requestQuestionDiagnosis(question, scope) {
    const officialAnswer = correctAnswers[question.number] || "";
    if (!capabilitiesForScope(scope, question.number).showDiagnosis || !officialAnswer) {
      showHint("完成重做并订正后才能查看错因诊断");
      return;
    }
    const chapter = chapterLabel(resource, passage);
    emitAppEvent(AppEvent.AI_REQUEST, {
      type: TASK_QUESTION_DIAGNOSIS,
      resourceId: resource.id,
      passageId: passage.id,
      chapter,
      questionId: question.id,
      questionNumber: String(question.number || ""),
      questionText: String(question.stem || "").trim(),
      articleText: passage.paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
      passageLabel: passage.label,
      scope,
      options: question.options || [],
      officialAnswer,
      firstAnswer: answers[question.number] || "",
      redoAnswer: redoAnswers[question.number] || "",
      userEvidence: userEvidenceTextForDiagnosis(question),
      userReasoning: entryFor(evidenceRef.current, evidenceKeyForQuestion(question), scope === "drawer" ? activeQuestionAttempt : scope)?.note || "",
      canShowFullExplanation: true,
      origin: "entry",
    });
  }

  useEffect(() => {
    const handleNext = (event) => {
      const detail = event.detail || {};
      if (detail.type !== TASK_QUESTION_EXPLANATION) return;
      const question = passage.questions.find((item) => item.id === detail.questionId);
      if (!question) return;
      requestQuestionHint(question, 3, detail.scope || "first", { origin: "window" });
    };
    window.addEventListener("wuliao:ai-hint-next", handleNext);
    return () => window.removeEventListener("wuliao:ai-hint-next", handleNext);
  }, [answers, correctAnswers, correctionVisibility, drawerAnswers, flowCurrentStage, passage, redoAnswers, resource]);

  useEffect(() => {
    archiveJumpHandlerRef.current = (event) => {
      const target = event.detail || {};
      if (target.resourceId && target.resourceId !== resource.id) {
        showHint("请先打开对应资料，再回到原句/原题");
        return;
      }
      const passageId = String(target.passageId || "");
      const index = analysis.passages.findIndex((item) => item.id === passageId);
      if (index < 0) {
        showHint("未找到对应章节（内容可能已变化）");
        return;
      }
      saveReadingPosition();
      positionRestoredRef.current = true;
      setPassageIndex(index);

      if (target.questionId) {
        focusQuestionInDrawer(target.questionId);
        return;
      }

      const match = /::p(\d+)s(\d+)$/.exec(String(target.sentenceId || ""));
      if (!match) {
        showHint("该记录缺少句子定位信息");
        return;
      }
      jumpToSentenceByPosition(Number(match[1]), Number(match[2]) - 1);
    };
  });

  useEffect(() => {
    const onArchiveJump = (event) => archiveJumpHandlerRef.current?.(event);
    window.addEventListener("wuliao:learning-archive-jump", onArchiveJump);
    return () => window.removeEventListener("wuliao:learning-archive-jump", onArchiveJump);
  }, []);

  function showHint(message) {
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    setHint(message);
    hintTimerRef.current = window.setTimeout(() => {
      hintTimerRef.current = null;
      setHint("");
    }, 2200);
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
    showHint("暂无可靠答案；自定义资料不会自动判对错");
  }

  function toggleReadingCompleted() {
    if (reviewActive) {
      showHint("复读模式不会改变本篇完成状态");
      return;
    }
    if (readingCompleted) {
      persistFlow(undoWorkflowCompletion(flowRef.current, Date.now()));
      persistReadingCompleted(resource, passage, false);
      setReadingCompleted(false);
      showHint("已撤销整篇完成，前六阶段记录已保留");
      return;
    }
    const current = flowRef.current;
    if (current.currentStage !== "deep-review") {
      showHint(`请先完成「${STAGE_LABELS[current.currentStage] || current.currentStage}」`);
      return;
    }
    persistFlow(completeFlowStage(current, "deep-review", Date.now()));
    persistReadingCompleted(resource, passage, true);
    setReadingCompleted(true);
    const created = createNextDayReviewTask({
      resourceId: resource.id,
      passageId: passage.id,
    });
    if (created.ok) {
      showHint("本篇精读已完成，已计入本机段位；次日复读任务已生成");
    } else {
      showHint(`本篇已计入本机段位；次日复读任务创建失败：${created.error || "存储空间不足"}`);
    }
  }

  function handleScheduleReview() {
    const result = scheduleManualReviewTask({
      resourceId: resource.id,
      passageId: passage.id,
    });
    if (result.ok && !result.created) {
      showHint("这篇已经有复读任务，可在首页查看");
    } else if (result.ok) {
      showHint("已安排今天复读，可回首页开始");
    } else {
      showHint(`安排复读失败：${result.error || "存储空间不足"}`);
    }
  }

  function handleCompleteReview() {
    const current = reviewTask;
    if (!current) return;
    const wrongSet = wrongQuestionKeys({
      resourceId: resource.id,
      passageId: passage.id,
      questions: passage.questions,
      firstAnswers: answers,
      redoAnswers,
      correctAnswers,
    });
    const values = Object.values(current.session?.sentenceResults || {});
    const result = completeReviewSession(current.taskKey, {
      taskType: TASK_TYPE_NEXT_DAY,
      paragraphRecallCount: Object.keys(current.session?.paragraphRecall || {}).length,
      paragraphTotal: passage.paragraphs.length,
      reviewedSentenceKeys: Object.keys(current.session?.sentenceResults || {}),
      masteredCount: values.filter((value) => value === "mastered").length,
      difficultCount: values.filter((value) => value === "difficult").length,
      reviewAnswersTotal: Object.keys(current.session?.reviewAnswers || {}).length,
      reviewQuestionTotal: wrongSet.questions.length,
    });
    if (!result.ok) {
      showHint(`复读完成保存失败：${result.error || "存储空间不足"}`);
      return;
    }
    setReviewTask(result.task);
    showHint("次日复读已完成，不重复计入精读完成数");
  }

  function currentInkTileWindow() {
    // 仅兜底刷新：pen-up 事务开始时 finalizeStroke 已强制 fresh snapshot，
    // 此处不再每次全量扫描 DOM（region-v2 归一化坐标在 scroll 时不变，
    // resize / Drawer 等布局变化由 ResizeObserver 刷新）。
    if (!inkGeometrySnapshotRef.current) refreshInkGeometrySnapshot();
    const content = contentRef.current;
    if (!content) return null;
    const rect = content.getBoundingClientRect();
    const contentWidth = Math.max(1, content.offsetWidth);
    const contentHeight = Math.max(1, content.offsetHeight);
    const scale = rect.width / contentWidth;
    const localTop = (-INK_TILE_BUFFER - rect.top) / scale;
    const localBottom = (window.innerHeight + INK_TILE_BUFFER - rect.top) / scale;
    const lastIndex = Math.max(0, Math.ceil(contentHeight / INK_TILE_HEIGHT) - 1);
    return {
      start: Math.max(0, Math.floor(localTop / INK_TILE_HEIGHT)),
      end: Math.min(lastIndex, Math.floor(localBottom / INK_TILE_HEIGHT)),
      contentWidth,
      contentHeight,
      ratio: inkPixelRatio(),
    };
  }

  function tileHeightFor(index, contentHeight) {
    return Math.max(1, Math.min(INK_TILE_HEIGHT, contentHeight - index * INK_TILE_HEIGHT));
  }

  function releaseInkTile(tile) {
    inkTileRendererRef.current?.cancel(tile);
    tile.width = 0;
    tile.height = 0;
  }

  function scheduleTileHistory(tile, index, candidates, info) {
    if (!inkTileRendererRef.current) {
      inkTileRendererRef.current = createInkTileRenderer({
        createWorker: () => typeof Worker === "function" && typeof OffscreenCanvas === "function"
          ? new Worker(new URL("./ink/inkTileWorker.js", import.meta.url), { type: "module" }) : null,
        drawFallback: drawTileHistory,
        drawOverlay: drawTileStroke,
      });
    }
    inkTileRendererRef.current.paint(tile, {
      strokes: candidates.map((record) => record.stroke), width: info.contentWidth, height: info.contentHeight,
      ratio: info.ratio, offsetY: index * INK_TILE_HEIGHT, pixelWidth: tile.width, pixelHeight: tile.height,
    });
  }

  function drawInkTile(tile, index, strokes, info, dirty = null) {
    recordInkHandoff("fullRedraw");
    inkTileIndexRef.current.sync(strokes, info, inkGeometrySnapshotRef.current?.byId);
    const candidates = inkTileIndexRef.current.forTile(index);
    if (!candidates.length) {
      inkTileRendererRef.current?.cancel(tile);
      tile.getContext("2d", { alpha: true }).clearRect(0, 0, tile.width, tile.height);
      return;
    }
    if (!dirty) {
      scheduleTileHistory(tile, index, candidates, info);
      return;
    }
    const context = tile.getContext("2d", { alpha: true });
    context.save();
    if (dirty) {
      context.beginPath();
      context.rect(dirty.minX * info.contentWidth * info.ratio,
        (dirty.minY * info.contentHeight - index * INK_TILE_HEIGHT) * info.ratio,
        (dirty.maxX - dirty.minX) * info.contentWidth * info.ratio,
        (dirty.maxY - dirty.minY) * info.contentHeight * info.ratio);
      context.clip();
    }
    context.clearRect(0, 0, tile.width, tile.height);
    context.scale(info.ratio, info.ratio);
    context.translate(0, -index * INK_TILE_HEIGHT);
    for (const { stroke: projected, bounds } of candidates) {
      if (dirty) {
        const padding = Math.max(1, Number(projected.width) || 3) * 2 + 4;
        if (bounds.maxX + padding / info.contentWidth < dirty.minX
          || bounds.minX - padding / info.contentWidth > dirty.maxX
          || bounds.maxY + padding / info.contentHeight < dirty.minY
          || bounds.minY - padding / info.contentHeight > dirty.maxY) continue;
      }
      drawInkStroke(context, projected, info.contentWidth, info.contentHeight);
    }
    context.restore();
    if (inkTileRendererRef.current?.hasPending(tile)) scheduleTileHistory(tile, index, candidates, info);
  }

  function syncInkTiles(redrawAll = false, infoOverride = null) {
    const layer = committedInkLayerRef.current;
    // 同一 pen-up 事务内复用调用方已计算的 tile window，避免重复 DOM geometry 读取；
    // scroll / resize / 结构性重绘等其他路径不传 infoOverride，仍实时计算。
    const info = infoOverride || currentInkTileWindow();
    if (!layer || !info) return false;
    const previousGeometry = inkTileGeometryRef.current;
    const geometry = inkGeometrySnapshotRef.current?.byId;
    if (previousGeometry?.regions !== geometry || previousGeometry?.ratio !== info.ratio) redrawAll = true;
    inkTileGeometryRef.current = { regions: geometry, ratio: info.ratio };
    if (redrawAll) inkTileBitmapCacheRef.current.clear();
    let renderedStrokes;
    if (info.end < info.start) {
      for (const [index, tile] of [...inkTilesRef.current.entries()]) {
        tile.remove();
        if (redrawAll) releaseInkTile(tile);
        else inkTileBitmapCacheRef.current.put(index, tile);
      }
      inkTilesRef.current.clear();
      return false;
    }
    for (const [index, tile] of [...inkTilesRef.current.entries()]) {
      if (index < info.start || index > info.end) {
        tile.remove();
        inkTilesRef.current.delete(index);
        if (redrawAll) releaseInkTile(tile);
        else inkTileBitmapCacheRef.current.put(index, tile);
      }
    }
    for (let index = info.start; index <= info.end; index += 1) {
      let tile = inkTilesRef.current.get(index);
      if (!tile) {
        tile = inkTileBitmapCacheRef.current.take(index) || document.createElement("canvas");
        tile.className = "deep-ink-tile";
        tile.style.top = `${index * INK_TILE_HEIGHT}px`;
        inkTilesRef.current.set(index, tile);
        layer.append(tile);
      }
      const expectedWidth = Math.max(1, Math.floor(info.contentWidth * info.ratio));
      const expectedHeight = Math.max(1, Math.floor(tileHeightFor(index, info.contentHeight) * info.ratio));
      const geometryChanged = tile.width !== expectedWidth || tile.height !== expectedHeight;
      if (geometryChanged) resizeInkCanvas(tile, info.contentWidth, tileHeightFor(index, info.contentHeight), info.ratio);
      if (redrawAll || geometryChanged) {
        renderedStrokes ??= displayedStageInk();
        drawInkTile(tile, index, renderedStrokes, info);
      }
    }
    return true;
  }

  function redrawTilesForStroke(stroke, withExtra = false) {
    const info = currentInkTileWindow();
    if (!info || info.end < info.start) return false;
    const bounds = normalizedStrokeBounds(projectInkStroke(stroke));
    const range = tileRangeForStroke(bounds, info, {
      tileHeight: INK_TILE_HEIGHT,
      overlap: INK_TILE_OVERLAP,
    });
    if (!range) return false;
    const renderedStrokes = displayedStageInk();
    const source = withExtra ? [...renderedStrokes, stroke] : renderedStrokes;
    let painted = 0;
    for (let index = range.first; index <= range.last; index += 1) {
      const tile = inkTilesRef.current.get(index);
      if (!tile) continue;
      const padding = Math.max(1, Number(stroke.width) || 3) * 2 + 4;
      const dirty = { minX: bounds.minX - padding / info.contentWidth,
        maxX: bounds.maxX + padding / info.contentWidth,
        minY: bounds.minY - padding / info.contentHeight,
        maxY: bounds.maxY + padding / info.contentHeight };
      drawInkTile(tile, index, source, info, dirty);
      painted += 1;
    }
    return painted > 0;
  }

  // 普通新增笔画：append-only 追加到受影响 tile，不 clear、不重画历史。
  function appendStrokeToTiles(stroke) {
    const info = currentInkTileWindow();
    if (!info || info.end < info.start || !stroke?.points?.length) return false;
    syncInkTiles(false, info);
    const projected = projectInkStroke(stroke);
    const bounds = normalizedStrokeBounds(projected);
    const range = tileRangeForStroke(bounds, info, {
      tileHeight: INK_TILE_HEIGHT,
      overlap: INK_TILE_OVERLAP,
    });
    if (!range) return false;
    let painted = 0;
    for (let index = range.first; index <= range.last; index += 1) {
      const tile = inkTilesRef.current.get(index);
      if (!tile) continue;
      inkTileRendererRef.current?.append(tile, projected);
      const context = tile.getContext("2d", { alpha: true });
      context.save();
      context.scale(info.ratio, info.ratio);
      context.translate(0, -index * INK_TILE_HEIGHT);
      drawInkStroke(context, projected, info.contentWidth, info.contentHeight);
      context.restore();
      painted += 1;
    }
    if (painted > 0) recordInkHandoff("incrementalCommit");
    return painted > 0;
  }

  function renderCommittedInk(extraStroke = null) {
    if (extraStroke) {
      syncInkTiles(false);
      return redrawTilesForStroke(extraStroke, true);
    }
    return syncInkTiles(true);
  }

  function updateTilesForStrokes(nextStrokes, previousStrokes) {
    const info = currentInkTileWindow();
    if (!info) return;
    const previousSet = new Set(previousStrokes);
    const nextSet = new Set(nextStrokes);
    const added = nextStrokes.filter((stroke) => !previousSet.has(stroke));
    const removed = previousStrokes.filter((stroke) => !nextSet.has(stroke));
    const changed = [...added, ...removed];
    if (!changed.length) return;
    syncInkTiles(false);
    const renderedStrokes = displayedStageInk();
    const affected = new Set();
    const dirty = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const stroke of changed) {
      const bounds = normalizedStrokeBounds(projectInkStroke(stroke));
      const padding = Math.max(1, Number(stroke.width) || 3) * 2 + 4;
      dirty.minX = Math.min(dirty.minX, bounds.minX - padding / info.contentWidth);
      dirty.maxX = Math.max(dirty.maxX, bounds.maxX + padding / info.contentWidth);
      dirty.minY = Math.min(dirty.minY, bounds.minY - padding / info.contentHeight);
      dirty.maxY = Math.max(dirty.maxY, bounds.maxY + padding / info.contentHeight);
      const range = tileRangeForStroke(bounds, info, {
        tileHeight: INK_TILE_HEIGHT,
        overlap: INK_TILE_OVERLAP,
      });
      if (!range) continue;
      for (let index = range.first; index <= range.last; index += 1) affected.add(index);
    }
    for (const index of affected) {
      const tile = inkTilesRef.current.get(index);
      if (!tile) continue;
      drawInkTile(tile, index, renderedStrokes, info, dirty);
    }
  }

  function scheduleCommittedInkRender() {
    if (inkRenderFrameRef.current) return;
    inkRenderFrameRef.current = window.requestAnimationFrame(() => {
      inkRenderFrameRef.current = null;
      renderCommittedInk();
    });
  }

  function syncInkPreviewLayout() {
    const content = contentRef.current;
    if (!content?.offsetWidth || !content.offsetHeight) return;
    const ratio = inkPixelRatio();
    const layout = deepInkPreviewLayout(content.getBoundingClientRect(),
      { width: content.offsetWidth, height: content.offsetHeight }, window.innerHeight, ratio);
    inkPreviewLayoutRef.current = layout;
    for (const canvas of [viewportPreviewCanvasRef.current, tailCanvasRef.current]) {
      if (!canvas) continue;
      if (canvas.width !== Math.max(1, Math.floor(layout.width * ratio))
        || canvas.height !== Math.max(1, Math.floor(layout.height * ratio))
        || Number(canvas.dataset.ratio) !== ratio) {
        resizeInkCanvas(canvas, layout.width, layout.height, ratio);
      }
      canvas.style.width = `${layout.width}px`;
      canvas.style.height = `${layout.height}px`;
      // Let the common paper ancestor perform the screen transform. A separate
      // fixed canvas is rounded differently by Huawei's compositor, even when
      // its getBoundingClientRect and bitmap projection agree mathematically.
      canvas.style.top = `${layout.startY}px`;
    }
    // Resizing a bitmap clears it. Repaint any unconfirmed handoff rather than
    // letting the next stroke hide a failed commit.
    if (inkController.pendingCommitCount()) inkController.clearPreview();
  }

  function viewportToPixel(point, active) {
    return deepInkPreviewPoint(point, active, inkPreviewLayoutRef.current);
  }

  function viewportInkOptions(stroke) {
    const canvas = viewportPreviewCanvasRef.current;
    return {
      lineWidth: Math.max(1, stroke.width || 2.6),
      strokeStyle: stroke.color,
      ratio: Number(canvas?.dataset.ratio) || 1,
    };
  }

  function collectUnknownToken(event) {
    return collectUnknownTokenInto(unknownSelectionRef.current, event);
  }

  async function commitUnknownSelection(selection) {
    const context = ocrContextRef.current;
    const isCurrent = () => mountedRef.current && getCurrentUsername() === storageUsername && ocrContextRef.current === context;
    try {
      for (const token of selection.tokens.values()) {
        if (!isCurrent()) return;
        const normalizedWord = normalizeUnknownWord(token.word);
        if (!normalizedWord) continue;
        // 离线词库查找失败（如 E2E dev 下词库 chunk 不可用）→ 降级为空释义，
        // 继续走 AI / 人工补充链，绝不中止整次 commit。
        let meaning = "";
        try {
          meaning = await lookupUnknownWordMeaning(token.word);
        } catch {
          meaning = "";
        }
        if (!isCurrent()) return;
        const current = unknownWords.find((word) => word.normalizedWord === normalizedWord);
        meaning ||= current?.meaning || "";
        if (!meaning) {
          const apiKey = await getAiApiKey();
          if (!isCurrent()) return;
          if (apiKey) {
            const contextSentence = sentenceTextByOccurrence(token.occurrenceId);
            const record = await toggleUnknownWord({
              resourceId: resource.id,
              passageId: passage.id,
              passageLabel: passage.label,
              year: resource.year || null,
              chapter: resource.text ? `Text ${resource.text} · ${passage.label}` : passage.label,
              word: token.word,
              normalizedWord,
              meaning: "",
              occurrenceId: token.occurrenceId,
            });
            if (record) {
              aiLookupChainRef.current = aiLookupChainRef.current
                .then(async () => {
                  if (!isCurrent()) return;
                  const controller = new AbortController();
                  unknownAiControllersRef.current.add(controller);
                  try {
                    const aiMeaning = await lookupWordMeaningWithAi({
                      apiKey, word: token.word, sentence: contextSentence,
                      signal: controller.signal, isCurrent,
                    });
                    if (aiMeaning && isCurrent()) await updateUnknownWordMeaning(record.id, aiMeaning);
                  } finally { unknownAiControllersRef.current.delete(controller); }
                })
                .catch(() => {});
            }
            continue;
          }
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
    if (!isCurrent()) return;
    setHint(selection.tokens.size ? "陌生词库已更新" : "笔尖没有经过英文单词");
    window.setTimeout(() => setHint(""), 1500);
  }

  function clearPassage() {
    if (!canClearPassage) return;
    if (!window.confirm("清空当前精读页面中的全部手写笔迹和键盘输入？答题记录、原文证据、AI 记录和生词不会删除。")) return;

    // Retain a tombstone for ambiguous legacy text, without deleting its source.
    setUserItem(translationLegacyDismissedKey(resource.id, passage.id), "1");
    ocrGenerationRef.current += 1;
    setOcrTarget(null);
    setTranscriptionTarget(null);

    inkController.clearPreview();
    if (strokeSaveTimerRef.current) cancelScheduledInkSave(strokeSaveTimerRef.current);
    strokeSaveTimerRef.current = null;
    pendingStrokeSaveRef.current = null;
    pendingStageEditsRef.current.clear();
    inkController.clearUndo();

    const previousStrokes = displayedStageInk();
    strokesRef.current = [];
    publishInkChange([], { reset: true, removed: previousStrokes });
    clearableTextApiRef.current?.resetAll();
    passageClearableKeys(resource, passage).forEach((key) => removeUserItem(key));
    for (const stageId of STAGE_IDS) {
      stageInkCache.remember(passageStageInkKey(resource.id, passage.id, inkScopeStageId(stageId)), null, []);
    }
    setHasStoredPassageInk(false);
    syncInkTiles(true);

    const nextProgress = resetPassageProgress(translationProgressRef.current);
    translationProgressRef.current = nextProgress;
    setTranslationProgress(nextProgress);
    saveTranslationProgress(nextProgress);

    setHint("已清空当前页面的笔迹和键盘输入");
    window.setTimeout(() => setHint(""), 1800);
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
      inkController.clearPreview();
      setHint("检测到手写笔，已切换为原始笔迹；请继续书写");
      window.setTimeout(() => setHint(""), 1800);
    }
  }

  function chooseEraserMode(value) {
    eraserModeRef.current = value;
    toolRef.current = "eraser";
    noteModeRef.current = true;
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
    inkController.finishActiveForGeometryChange();
    flushPendingStrokeSave();
    const before = contentRef.current?.getBoundingClientRect().top || 0;
    setTopAreaCollapsed(next);
    window.requestAnimationFrame(() => {
      const after = contentRef.current?.getBoundingClientRect().top || 0;
      window.scrollBy({ top: after - before, behavior: "auto" });
    });
  }

  function sentenceTextFromElement(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll("[data-unknown-ignore]").forEach((node) => node.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function paragraphTextByScope(scope) {
    const match = /:p(\d+):/.exec(String(scope || ""));
    const number = match ? Number(match[1]) : 0;
    return passage.paragraphs.find((paragraph) => paragraph.number === number)?.text || "";
  }

  function paragraphTextFromElement(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll("[data-unknown-ignore]").forEach((node) => node.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function clearSentenceSelection() {
    setSentenceSelection(null);
  }

  function captureOcrTarget(info) {
    if (getCurrentUsername() !== info.username || info.resourceId !== resource.id || info.passageId !== passage.id) throw new Error("当前账号或文章已切换");
    return captureTranslationInk({ strokes: strokesRef.current, contentElement: contentRef.current,
      writingElement: info.writingElement, activeStroke: activeInkRef.current });
  }

  function requestTranslationOcr(info) {
    try {
      const generation = ocrGenerationRef.current;
      const context = ocrContextRef.current;
      const snapshot = captureOcrTarget(info);
      const metadata = readTranslationOcr(info);
      const initialText = getUserItem(info.storageKey, info.username) || "";
      const stale = metadata?.inkFingerprint && metadata.inkFingerprint !== snapshot.fingerprint;
      setOcrTarget({ ...info, snapshot, metadata, initialText, legacy: pendingLegacyTranslation(info),
        requestId: globalThis.crypto.randomUUID(),
        notice: stale ? "笔迹已更新，请重新识别，或对照原笔迹重新校对后确认保存。" : "",
        capture: () => captureOcrTarget(info),
        isCurrent: () => ocrGenerationRef.current === generation
          && ocrContextRef.current === context && getCurrentUsername() === info.username
          && info.writingElement?.isConnected,
      });
    } catch (error) { showHint(error.message); }
  }

  function validateTranslationOcr(info) {
    const metadata = readTranslationOcr(info);
    if (!metadata?.inkFingerprint) return true;
    try {
      if (captureOcrTarget(info).fingerprint === metadata.inkFingerprint) return true;
      requestTranslationOcr({ ...info, mode: "view" });
    } catch (error) { showHint(error.message); }
    return false;
  }

  function confirmOcrTranslation(target, result) {
    if (!target.isCurrent() || target.readOnly) throw new Error("当前句已关闭，请重新打开");
    const previous = sentenceEntryFor(translationProgressRef.current, { paragraphNumber: target.paragraphNumber,
      sentenceIndex: target.sentenceIndex, sentenceText: target.sentence, translationText: target.initialText });
    const value = saveConfirmedTranslation(target, result);
    const key = sentenceKeyFor({ paragraphNumber: target.paragraphNumber, sentenceIndex: target.sentenceIndex, sentenceText: target.sentence });
    // A confirmed OCR text is not an implicit "完成笔译" action. Preserve the
    // status shown before opening the dialog, including an unstored pending row.
    if (!previous.stored) {
      const progress = translationProgressRef.current;
      updateTranslationProgress({ ...progress, sentences: { ...progress.sentences, [key]: previous.entry }, updatedAt: Date.now() });
    }
    handleTranslationEdited(key, value);
    emitAppEvent(AppEvent.DEEP_TRANSLATION_UPDATED, { key: target.storageKey, username: target.username });
    setOcrTarget(null);
    showHint("电子译文已保存，可在完成笔译后点击 AI 批改");
  }

  function confirmTranscription(text) {
    const target = transcriptionTarget;
    if (!target) return;
    if (target.username !== getCurrentUsername() || target.resourceId !== resource.id || target.passageId !== passage.id) {
      setTranscriptionTarget(null);
      return;
    }
    const value = String(text || "").trim();
    if (!value) {
      showHint("请先录入文字译文后再提交");
      return;
    }
    setUserItem(target.storageKey, value);
    setUserItem(target.methodKey, "handwriting-transcribed");
    emitAppEvent(AppEvent.DEEP_TRANSLATION_UPDATED, { key: target.storageKey });
    emitAppEvent(AppEvent.AI_REQUEST, {
      type: TASK_TRANSLATION_REVIEW,
      resourceId: target.resourceId,
      passageId: target.passageId,
      chapter: target.chapter,
      sentenceId: target.sentenceId,
      itemLabel: target.itemLabel,
      sentence: target.sentence,
      paragraph: target.paragraph,
      userTranslation: value,
      inputMethod: "handwriting-transcribed",
    });
    setTranscriptionTarget(null);
  }

  function cancelTranscription() {
    setTranscriptionTarget(null);
  }

  function sentenceTextByOccurrence(occurrenceId) {
    const scope = String(occurrenceId || "").replace(/:\d+$/, "");
    const sentenceElement = contentRef.current?.querySelector(`[data-sentence-scope="${cssEscape(scope)}"]`);
    if (sentenceElement) return sentenceTextFromElement(sentenceElement);
    return paragraphTextByScope(scope);
  }

  function requestAiExplain() {
    if (!sentenceSelection) return;
    if (reviewActive && !reviewCheckUnlocked) return;
    const text = sentenceSelection.mode === "paragraph" ? sentenceSelection.paragraph : sentenceSelection.sentence;
    emitAppEvent(AppEvent.AI_REQUEST, {
      type: "explain",
      sentence: text,
      paragraph: sentenceSelection.paragraph,
      chapter: sentenceSelection.chapter,
      kind: sentenceSelection.mode,
      contextSentence: sentenceSelection.contextSentence || "",
    });
    clearSentenceSelection();
  }

  function requestAiTranslate(inContext = false) {
    if (!sentenceSelection) return;
    if (reviewActive && !reviewCheckUnlocked) return;
    const text = sentenceSelection.mode === "paragraph" ? sentenceSelection.paragraph : sentenceSelection.sentence;
    emitAppEvent(AppEvent.AI_REQUEST, {
      type: "translate",
      text,
      chapter: sentenceSelection.chapter,
      kind: sentenceSelection.mode,
      contextSentence: inContext ? sentenceSelection.contextSentence : "",
    });
    clearSentenceSelection();
  }

  function exportFinishedPdf() {
    if (exportingPdf) return;
    if (reviewActive && !reviewCheckUnlocked) return;
    setEvidenceEditor(null);
    setExportingPdf(true);
    document.documentElement.classList.add("wuliao-exporting");
    setSimplifiedExport({
      fileName: `${resource.year || "自定义"}-${resource.text ? `Text-${resource.text}` : passage.label}-精读成品.pdf`,
    });
  }

  const selectionBarStyle = sentenceSelection ? (() => {
    const rect = sentenceSelection.rect;
    const width = 106;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const above = rect.top >= 78;
    const top = above ? rect.top - 46 : rect.top + rect.height + 10;
    return { left, top };
  })() : undefined;

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
      <div ref={readerPageRef} className={`reader-page custom-reader-page custom-workbook-page ${hasPassageSwitcher ? "has-passage-switcher" : ""} ${topAreaCollapsed ? "top-area-collapsed" : ""} ${exportingPdf ? "exporting-pdf" : ""} ${simplifiedExport ? "simplified-export" : ""} ${timedReadingActive ? "timed-reading-active" : ""} ${reviewActive ? "review-mode" : ""}`}>
      <header className="reader-header">
        <button className="back-button light" onClick={onClose}>← 资料库</button>
        <div className="reader-title"><small>{editionLabel}</small><strong>{resource.title}</strong></div>
        <div className="reader-header-actions">
          {!timedReadingActive && !(reviewActive && !reviewCheckUnlocked) && (
            <button className="export-pdf-button" onClick={exportFinishedPdf} disabled={exportingPdf}>{exportingPdf ? "正在导出…" : "导出成品 PDF"}</button>
          )}
          {!timedReadingActive && !(reviewActive && !reviewCheckUnlocked) && (
            <button className="source-button" onClick={() => saveBeforeNavigation(() => setShowSource(true), storageUsername)}>查看原 PDF</button>
          )}
          <div className="reader-status"><span /> 本地模式</div>
        </div>
      </header>

      {!reviewActive && <nav className="stage-nav custom-workbook-stage" aria-label="精读流程">
        {stageGroups.map(([label, ids], index) => {
          const completed = ids.every((id) => flow.stages?.[id]?.status === "completed");
          const isCurrent = ids.includes(flowCurrentStage) && !completed;
          const locked = isStageLocked(flow, ids[0]);
          const skipped = ids.some((id) => flow.stages?.[id]?.status === "skipped");
          const targetId = ids.includes(flowCurrentStage) ? flowCurrentStage : ids[0];
          const classes = [
            ids.includes(activeStage) ? "active" : "",
            completed ? "completed" : "",
            isCurrent ? "current" : "",
            locked ? "locked" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={ids.join("+")}
              className={classes}
              aria-current={ids.includes(activeStage) ? "step" : undefined}
              aria-disabled={locked || undefined}
              onClick={() => {
                if (locked) {
                  showHint(`请先完成「${STAGE_LABELS[flowCurrentStage] || flowCurrentStage}」`);
                  return;
                }
                jumpTo(targetId);
              }}
            >
              <ReaderStageMarker index={index}>{completed ? "✓" : isCurrent ? "●" : locked ? "🔒" : index + 1}</ReaderStageMarker>
              {label}{skipped ? " · 已跳过" : ""}
            </button>
          );
        })}
        <div className="flow-task-chip">
          {flowCompleted ? (
            <>
              <span className="flow-task-done">本篇精读已完成</span>
              <button type="button" onClick={() => openArticleSummary("summary")}>
                查看本篇学习结果
              </button>
            </>
          ) : (
            <>
              <span className="flow-task-label">
                <small>当前任务</small>
                {STAGE_LABELS[flowCurrentStage] || flowCurrentStage} · 第 {flowStageGroupIndex + 1}/6 组
              </span>
              <button type="button" onClick={() => jumpTo(flowCurrentStage)}>继续</button>
            </>
          )}
        </div>
      </nav>}

      {hasPassageSwitcher && !reviewActive && (
        <div className="passage-switcher">
          <span>已识别 {analysis.passages.length} 篇仔细阅读</span>
          <div>{analysis.passages.map((item, index) => (
            <button key={item.id} className={passageIndex === index ? "active" : ""} onClick={() => saveBeforeNavigation(() => {
              saveReadingPosition();
              const current = flowRef.current;
              if (current?.currentStage === "deep-clean-text" && current.timedReading.phase === "running") {
                saveReadingFlow(pauseTimedReading(current, Date.now()));
              }
              positionRestoredRef.current = true;
              prepareInkScopeChange({ clearCommitted: true });
              inkStageIdRef.current = "deep-cover";
              setInkStageId("deep-cover");
              setPassageIndex(index);
              setActiveStage("deep-cover");
              window.scrollTo({ top: 0 });
            }, storageUsername)}>{item.label}</button>
          ))}</div>
        </div>
      )}

      {!reviewActive && (
        <AnnotationToolbar
          tool={tool}
          color={color}
          canUndo={hasActiveInk}
          noteMode={noteMode}
          onToggleNoteMode={() => { setNoteMode((current) => !current); inkController.clearPreview(); }}
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
            inkController.clearPreview();
            inkController.undo();
          }}
          canUndo={inkController.canUndo()}
          collapsible
          collapsed={topAreaCollapsed}
          collapseMode="chrome-only"
          onCollapsedChange={changeTopAreaCollapsed}
          stageHint={`${STAGE_LABELS[flowCurrentStage] || flowCurrentStage} · 第 ${flowStageGroupIndex + 1}/6 组`}
          onClear={clearPassage}
          canClear={canClearPassage}
          clearLabel="清空页面"
          unknownEnabled={!timedReadingActive}
          tabletInk={androidApp}
        />
      )}

      <ClearableTextProvider
        key={`${resource.id}:${passage.id}`}
        ref={clearableTextApiRef}
        onPresenceChange={setHasClearableText}
      >
        <DeepInkContext.Provider value={inkChanges}>
        <main
          ref={contentRef}
          className={`deep-reader-content ${reviewActive ? "review-content" : ""} ${noteMode ? "note-mode" : ""} ${simplifiedExport ? "simplified-export" : ""} ${timedReadingActive ? "timed-reading-active" : ""}`}
          key={passage.id}
          onPointerDownCapture={reviewActive ? undefined : (event) => { redirectPenFromTextField(event); inkController.handlePointerDown(event); }}
          onPointerMoveCapture={reviewActive ? undefined : (event) => {
            inkController.handlePointerMove(event);
          }}
          onPointerUpCapture={reviewActive ? undefined : (event) => { inkController.handlePointerUp(event); }}
          onPointerCancelCapture={reviewActive ? undefined : (event) => { inkController.handlePointerCancel(event); }}
          onLostPointerCapture={reviewActive ? undefined : (event) => { inkController.handlePointerUp(event); }}
          onBeforeInputCapture={reviewActive ? undefined : blockInkModeTextInput}
          onFocusCapture={reviewActive ? undefined : (event) => {
            if (androidApp && noteMode && isTextEntryTarget(event.target)) event.target.blur();
          }}
        >
        {reviewActive ? (
          reviewError && !reviewTask ? (
            <div className="review-error-panel">
              <small>REVIEW SESSION</small>
              <h2>无法打开复读</h2>
              <p>{reviewError}</p>
              <button type="button" className="primary-button" onClick={onClose}>返回首页</button>
            </div>
          ) : reviewTask?.completedAt ? (
            <ReviewCompleteCard task={reviewTask} resource={resource} passage={passage} onExit={onClose} />
          ) : reviewCheckUnlocked ? (
            <>
              <ReviewCheckPanel
                task={reviewTask}
                resource={resource}
                passage={passage}
                firstAnswers={answers}
                redoAnswers={redoAnswers}
                correctAnswers={correctAnswers}
                onComplete={handleCompleteReview}
                onExit={onClose}
              />
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
                onRequestAiHint={(question, attempt) => requestQuestionHint(question, 1, attempt)}
                getDiagnosisLabel={(question, scope) => diagnosisLabelForScope(question, scope)}
                onRequestDiagnosis={(question, scope) => requestQuestionDiagnosis(question, scope)}
                readingCompleted={readingCompleted}
                onToggleReadingCompleted={toggleReadingCompleted}
                inkOnly={androidApp && noteMode}
                projectInkStroke={projectInkStroke}
                onRequestTranscription={setTranscriptionTarget}
                onRequestOcr={requestTranslationOcr}
                onValidateOcr={validateTranslationOcr}
                translationProgress={translationProgress}
                onMarkTranslationDone={markTranslationDone}
                onMarkSentenceCorrected={markSentenceCorrected}
                onSetSentenceReviewStatus={setSentenceReviewStatus}
                onTranslationEdited={handleTranslationEdited}
                onCompleteParagraph={completeParagraph}
                onContinueToNextParagraph={continueToNextParagraph}
                onContinueNextTranslation={continueNextTranslation}
                flow={flow}
                onCompleteStage={handleCompleteStage}
                onResumeTimedReading={handleResumeTimedReading}
                timedReadingState={timedReadingState}
                timerNow={timerNow}
                evidenceStore={evidenceStore}
                evidenceEditor={evidenceEditor}
                onCaptureEvidenceSelection={captureEvidenceSelection}
                onUpdateEvidenceDraft={(draft) => setEvidenceEditor((current) => current ? ({ ...current, draft }) : current)}
                onOpenEvidence={openEvidenceEditor}
                onViewEvidence={viewEvidence}
                onJumpEvidence={viewEvidence}
                onFocusNextIncomplete={focusNextIncomplete}
                onScheduleReview={handleScheduleReview}
                onOpenSummary={() => openArticleSummary("summary")}
                reviewReadOnly
              />
            </>
          ) : (
            <ReviewSession
              task={reviewTask}
              resource={resource}
              passage={passage}
              translationProgress={translationProgress}
              correctAnswers={correctAnswers}
              firstAnswers={answers}
              redoAnswers={redoAnswers}
              onSentenceMastered={setSentenceReviewStatus}
              onTaskChanged={setReviewTask}
              onExit={onClose}
            />
          )
        ) : (
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
            onRequestAiHint={(question, attempt) => requestQuestionHint(question, 1, attempt)}
            getDiagnosisLabel={(question, scope) => diagnosisLabelForScope(question, scope)}
            onRequestDiagnosis={(question, scope) => requestQuestionDiagnosis(question, scope)}
            readingCompleted={readingCompleted}
            onToggleReadingCompleted={toggleReadingCompleted}
            inkOnly={androidApp && noteMode}
            projectInkStroke={projectInkStroke}
            onRequestTranscription={setTranscriptionTarget}
            onRequestOcr={requestTranslationOcr}
            onValidateOcr={validateTranslationOcr}
            translationProgress={translationProgress}
            onMarkTranslationDone={markTranslationDone}
            onMarkSentenceCorrected={markSentenceCorrected}
            onSetSentenceReviewStatus={setSentenceReviewStatus}
            onTranslationEdited={handleTranslationEdited}
            onCompleteParagraph={completeParagraph}
            onContinueToNextParagraph={continueToNextParagraph}
            onContinueNextTranslation={continueNextTranslation}
            flow={flow}
            onCompleteStage={handleCompleteStage}
            onResumeTimedReading={handleResumeTimedReading}
            timedReadingState={timedReadingState}
            timerNow={timerNow}
            evidenceStore={evidenceStore}
            evidenceEditor={evidenceEditor}
            onCaptureEvidenceSelection={captureEvidenceSelection}
                onUpdateEvidenceDraft={(draft) => setEvidenceEditor((current) => current ? ({ ...current, draft }) : current)}
            onOpenEvidence={openEvidenceEditor}
            onViewEvidence={viewEvidence}
            onJumpEvidence={viewEvidence}
            onFocusNextIncomplete={focusNextIncomplete}
            onScheduleReview={handleScheduleReview}
            onOpenSummary={() => openArticleSummary("summary")}
          />
        )}
        {simplifiedExport && (
          <SimplifiedExportDocument
            resource={resource}
            passage={passage}
            evidenceStore={evidenceStore}
            answers={answers}
            redoAnswers={redoAnswers}
            correctAnswers={correctAnswers}
          />
        )}
        {!reviewActive && <div ref={committedInkLayerRef} className="deep-committed-ink-layer" aria-hidden="true">
          <canvas ref={viewportPreviewCanvasRef} className="custom-viewport-ink-preview" />
          <canvas ref={tailCanvasRef} className="ink-tail-canvas custom-viewport-ink-tail" />
        </div>}
        </main>
        </DeepInkContext.Provider>
      </ClearableTextProvider>
      <div className="print-watermark" aria-hidden="true" />

      <ReaderSidePanels
        ref={readerPanelsRef}
        activeInkRef={activeInkRef}
        paperKey={`${resource.id}:${passage.id}`}
        questionAvailable={questionDrawerAvailable}
        questionCount={passage.questions.length}
        questionDrawerProps={{
          questions: passage.questions,
          parseInfo: { status: passage.questions.length ? "ready" : "text-only" },
          answers: drawerAnswers,
          onAnswer: (number, option) => chooseAnswer("drawer", number, option),
          correctAnswers,
          correctionVisible: correctionVisibility[activeQuestionAttempt],
          onToggleCorrection: passage.questions.length > 0 && passage.questions.every((question) => (
            Boolean(drawerAnswers[question.number]
              || (flowCurrentStage === "deep-redo" ? redoAnswers[question.number] : answers[question.number]))
          )) ? () => toggleCorrection(activeQuestionAttempt) : null,
          onRequestAiHint: (question) => requestQuestionHint(question, 1, activeQuestionAttempt),
          getDiagnosisLabel: (question) => diagnosisLabelForScope(question, activeQuestionAttempt),
          onRequestDiagnosis: (question) => requestQuestionDiagnosis(question, activeQuestionAttempt),
          focusQuestionId: drawerFocusQuestionId,
          evidenceForQuestion: (question) => {
            const questionKey = evidenceKeyForQuestion(question);
            const entry = entryFor(evidenceRef.current, questionKey, activeQuestionAttempt);
            return {
              label: entry ? entrySummaryLabel(entry) : "",
              hasEvidence: entryComplete(entry) && (entry?.mode !== "text" || entryResolutionOk(entry, passage)),
              legacy: !entry && flow?.stages?.["deep-first-quiz"]?.status === "completed",
            };
          },
          onRequestEvidence: (question) => {
            const questionKey = evidenceKeyForQuestion(question);
            const entry = entryFor(evidenceRef.current, questionKey, activeQuestionAttempt);
            openEvidenceEditor(question, activeQuestionAttempt, "drawer", entry?.mode || "text");
          },
          capabilitiesForQuestion: (question) => capabilitiesForScope(activeQuestionAttempt, question.number),
        }}
        aiProps={{
          questionAnswerAccess: (scope, number) => capabilitiesForScope(scope, number).showExplanation,
          currentResourceId: resource.id,
          available: (!reviewActive || reviewCheckUnlocked)
            && flowCurrentStage !== "deep-clean-text"
            && flowCurrentStage !== "deep-first-quiz",
          onMarkTranslationCorrected: markCorrectedFromReviewMeta,
          isTranslationCorrected: isSentenceCorrected,
          aiContext: { resourceId: resource.id, passageId: passage.id },
        }}
      />

      <TranslationTranscriptionModal
        open={Boolean(transcriptionTarget)}
        sentence={transcriptionTarget?.sentence || ""}
        onCancel={cancelTranscription}
        onConfirm={confirmTranscription}
      />
      {ocrTarget && <TranslationOcrModal key={ocrTarget.requestId} target={ocrTarget}
        onCancel={() => setOcrTarget(null)} onSave={confirmOcrTranslation} />}

      {sentenceSelection && !timedReadingActive && !evidenceEditor && (!reviewActive || reviewCheckUnlocked) && (
        <div className="sentence-action-bar" style={selectionBarStyle} onPointerDown={(event) => event.preventDefault()}>
          <button type="button" className="sentence-action-main" onClick={requestAiExplain}>讲解</button>
          <button type="button" className="sentence-action-main" onClick={() => requestAiTranslate()}>快译</button>
          {sentenceSelection.mode === "word" && <button type="button" className="sentence-action-main" onClick={() => requestAiTranslate(true)}>本句词义</button>}
        </div>
      )}

      {evidenceEditor && !exportingPdf && !simplifiedExport && (!reviewActive || reviewCheckUnlocked) && (
        <div className="evidence-editor-bar">
          <div className="evidence-editor-head">
            <strong>正在为 Q{evidenceEditor.question.number} 标记原文证据（{evidenceEditor.attempt === "first" ? "首次" : "重做"}）</strong>
            <span>
              {evidenceEditor.draft.mode === "text"
                ? `已选 ${evidenceEditor.draft.ranges.length} / 3 处原文`
                : evidenceEditor.draft.mode === "sentences" ? `已选 ${evidenceEditor.draft.references.length} / 3 句` : "全文/结构依据"}
            </span>
          </div>
          <div className="evidence-editor-mode">
            <button type="button" className={evidenceEditor.draft.mode === "sentences" ? "active" : ""} onClick={() => switchEvidenceEditorMode("sentences")}>句子定位</button>
            <button
              type="button"
              className={evidenceEditor.draft.mode === "text" ? "active" : ""}
              onClick={() => switchEvidenceEditorMode("text")}
            >
              原文片段
            </button>
            <button
              type="button"
              className={evidenceEditor.draft.mode === "global" ? "active" : ""}
              onClick={() => switchEvidenceEditorMode("global")}
            >
              全文/结构依据
            </button>
          </div>
          {evidenceEditor.draft.mode === "text" && (
            <div className="evidence-text-editor">
              <p>在上方干净原文中拖选连续文字；可跨句，系统会按句保存稳定位置。</p>
              <div className="evidence-text-ranges">
                {evidenceEditor.draft.ranges.map((range, index) => (
                  <span key={`${index}-${textRangeExcerpt(range)}`}>
                    <q>{textRangeExcerpt(range)}</q>
                    <button
                      type="button"
                      aria-label={`删除第 ${index + 1} 处原文依据`}
                      onClick={() => setEvidenceEditor((current) => ({
                        ...current,
                        draft: removeTextRange(current.draft, index),
                      }))}
                    >×</button>
                  </span>
                ))}
              </div>
              <div className="evidence-text-types" aria-label="原文依据类型">
                {TEXT_TYPES.map((type) => (
                  <button
                    key={type.id}
                    type="button"
                    className={evidenceEditor.draft.textType === type.id ? "active" : ""}
                    onClick={() => setEvidenceEditor((current) => ({
                      ...current,
                      draft: setTextType(current.draft, type.id),
                    }))}
                  >{type.label}</button>
                ))}
              </div>
            </div>
          )}
          {evidenceEditor.draft.mode === "sentences" && <div className="evidence-text-ranges">{evidenceEditor.draft.references.map((ref) => <button type="button" key={ref.sentenceKey} onClick={() => setEvidenceEditor((current) => ({ ...current, draft: removeSentenceRef(current.draft, ref.sentenceKey) }))}>{sentenceRefLabel(ref)} ×</button>)}</div>}
          <label>我的理解 / 判断依据（可选）<textarea className="evidence-note-input" maxLength={500} value={evidenceEditor.draft.note} onChange={(event) => setEvidenceEditor((current) => ({ ...current, draft: setEvidenceNote(current.draft, event.target.value) }))} /></label>
          {evidenceEditor.draft.mode === "global" && (
            <div className="evidence-global-types">
              {GLOBAL_TYPES.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  className={evidenceEditor.draft.globalType === type.id ? "active" : ""}
                  onClick={() => setEvidenceEditor((current) => ({
                    ...current,
                    draft: setGlobalType(current.draft, type.id),
                  }))}
                >
                  {type.label}
                </button>
              ))}

            </div>
          )}
          <div className="evidence-editor-actions">
            <button
              type="button"
              className="evidence-editor-action primary"
              onClick={completeEvidenceEditor}
              disabled={!entryComplete(evidenceEditor.draft)}
            >
              {entryComplete(evidenceEditor.draft)
                ? "确认依据"
                : evidenceEditor.draft.mode === "global" ? "请选择全文类型" : "请选择原文与类型"}
            </button>
            <button type="button" className="evidence-editor-action" onClick={clearEvidenceEditorDraft}>
              清空
            </button>
            <button type="button" className="evidence-editor-action" onClick={cancelEvidenceEditor}>
              取消
            </button>
          </div>
        </div>
      )}

      {summaryOpen && !reviewActive && (
        <ArticleLearningSummaryPanel
          open={summaryOpen}
          initialTab={summaryTab}
          onClose={() => setSummaryOpen(false)}
          resource={resource}
          passage={passage}
          flow={flow}
          storedFlowExists={Boolean(getUserItem(flowStorageKey(resource.id, passage.id)))}
          translationProgress={translationProgress}
          evidenceStore={evidenceStore}
          answers={answers}
          redoAnswers={redoAnswers}
          correctAnswers={correctAnswers}
          reviewTasks={articleReviewTasks}
          unknownWords={unknownWords}
          learningRecords={summaryRecords}
          onContinueReading={() => {
            setSummaryOpen(false);
            jumpTo(flowCurrentStage);
          }}
          onJumpToSentence={(position) => {
            setSummaryOpen(false);
            jumpToSentenceByPosition(position.paragraphNumber, position.sentenceIndex);
          }}
          onJumpToQuestion={(question) => {
            setSummaryOpen(false);
            jumpToQuestion(question);
          }}
          onMarkSentenceMastered={handleSummaryMarkMastered}
          onRemoveUnknownWord={handleRemoveUnknownWord}
          onConfirmTag={handleConfirmTag}
          onDismissTag={handleDismissTag}
          onViewEvidence={(question, attempt) => {
            setSummaryOpen(false);
            viewEvidence(question, attempt);
          }}
          onStartReview={async (task) => {
            setSummaryOpen(false);
            if (typeof onRequestReview === "function") {
              try {
                await onRequestReview(task);
              } catch {
                showHint("无法打开复读任务");
              }
            }
          }}
        />
      )}

      {hint && <div className="toast">{hint}</div>}
    </div>
  );
}
