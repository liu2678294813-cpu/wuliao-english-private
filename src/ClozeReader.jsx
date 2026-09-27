import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSaveBoundary } from "./useSaveBoundary.js";
import { backgroundSave } from "./saveCoordinator.js";
import { getCurrentUsername } from "./userData.js";
import {
  CLOZE_STAGES,
  clozeTimerElapsed,
  completeClozeStage,
  finishClozeTimer,
  getClozeFlow,
  pauseClozeTimer,
  resumeClozeTimer,
  saveClozeFlow,
  startClozeTimer,
} from "./clozeFlow";
import {
  CLOZE_BASIS_TYPES,
  CLOZE_BASIS_TYPE_LABELS,
  activeBlankOf,
  addReference,
  analyzedBlankNumbers,
  getClozeProgress,
  isBlankUnanswered,
  markAllCorrected,
  markAnalyzed,
  markCorrected,
  markFirstSubmitted,
  markReviewSubmitted,
  nextUnanalyzedBlank,
  nextUnansweredBlank,
  recordFirstAnswer,
  recordFirstConfidence,
  recordReviewAnswer,
  recordReviewConfidence,
  removeReference,
  saveClozeProgress,
  setActiveBlank,
  setPrediction,
  toggleBasisType,
} from "./clozeProgress";
import {
  buildBlankCorrectionRow,
  canEditFirstAnswers,
  canEditReviewAnswers,
  canSeeOfficialAnswers,
  changeLabel,
  clozeBlankNumbers,
  clozeOptionText,
  effectiveClozeAnswer,
  effectiveClozeConfidence,
  isAnalysisStage,
  isCorrectionStage,
  isFinalReadStage,
  isFirstAttemptStage,
  isPostCorrectionStage,
  isReviewStage,
  officialAnswerFor,
  priorityBlankNumbers,
} from "./clozeView";
import {
  buildClozeSentenceModel,
  buildClozeSentenceRef,
  priorityTranslationTargets,
  resolveClozeSentenceRef,
} from "./clozeSentences";
import {
  areClozeTranslationTargetsCorrected,
  loadClozeTranslationProgress,
  markClozeTranslationCorrected,
  markClozeTranslationTranslated,
  saveClozeTranslationProgress,
  setClozeTranslationText,
  setTranslationTargetOverride,
  translationEntryFor,
} from "./clozeTranslationProgress";
import { loadOfficialCloze } from "./library";
import {
  buildClozeSupportSignals,
  scheduleClozeD1Task,
} from "./clozeReview";
import AiFloatWindow from "./AiFloatWindow.jsx";
import { onOtherPanelOpen, openPanel } from "./panelBus";
import { useBackHandler } from "./ui/BackContext";
import { BACK_PRIORITY } from "./ui/backController";
import { useMotionPresence } from "./ui/useMotionPresence";
import { useReaderPaperLayout } from "./ui/useReaderPaperLayout";
import {
  TASK_CLOZE_CONTEXT_REVIEW,
  TASK_CLOZE_DIAGNOSIS,
  TASK_CLOZE_EXPLANATION,
  TASK_CLOZE_HINT_1,
  buildClozeAnalysisDetail,
  buildClozeHintDetail,
  clozeAiAvailability,
} from "./clozeAiTasks";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";
import { listUnknownWords, toggleUnknownWord, updateUnknownWordMeaning } from "./storage";
import { buildClozeUnknownEntry } from "./clozeUnknownWords";
import { lookupUnknownWordMeaning, normalizeUnknownWord } from "./unknownWords";
import {
  ACTIVE_UNKNOWN_HIGHLIGHT,
  SAVED_UNKNOWN_HIGHLIGHT,
  collectUnknownTokenInto,
  createUnknownSelectionHooks,
  highlightSavedUnknownWords,
} from "./unknownWordInteraction";
import { getAiApiKey, lookupWordMeaningWithAi } from "./ai";
import { AnnotationToolbar } from "./ui/AnnotationToolbar";
import ClozeInkSurface from "./ink/ClozeInkSurface";
import {
  normalizePenMode,
  normalizePenSize,
  PEN_MODE_STORAGE_KEY,
  PEN_SIZE_STORAGE_KEY,
} from "./annotationTools";
import { getUserItem, setUserItem } from "./userData";
import { isAndroidApp } from "./platform";

const SAVE_DELAY_MS = 320;

function formatElapsed(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function confidenceLabel(value) {
  if (value === "confident") return "确定";
  if (value === "uncertain") return "犹豫";
  if (value === "guess") return "猜测";
  return "";
}

function statusLabel(status) {
  if (status === "translated") return "已完成笔译，待订正";
  if (status === "corrected") return "已完成订正";
  return "待笔译";
}

function answerMark(answer, correct) {
  if (!answer) return "—";
  if (correct === true) return `${answer} ✓`;
  if (correct === false) return `${answer} ✗`;
  return answer;
}

export default function ClozeReader({ resource, onClose, onShowLearningSummary = null }) {
  const storageUsername = useRef(getCurrentUsername()).current;
  const [cloze, setCloze] = useState(null);
  const [isOfficial, setIsOfficial] = useState(false);
  const [clozeId, setClozeId] = useState("");
  const [flow, setFlow] = useState(null);
  const [progress, setProgress] = useState(null);
  const [translationProgress, setTranslationProgress] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const [status, setStatus] = useState("正在读取完形数据");
  const [error, setError] = useState("");
  // Preserve the initial open preference; panel toggles transform paper and ink together.
  const [panelOpen, setPanelOpen] = useState(() => (
    typeof window === "undefined" || window.innerWidth >= 1400
  ));
  const panelMotion = useMotionPresence(panelOpen);
  const [answerDisplayMode, setAnswerDisplayMode] = useState("key");
  const [referenceMode, setReferenceMode] = useState(false);
  const [analysisFilter, setAnalysisFilter] = useState("all");
  const [loadAttempt, setLoadAttempt] = useState(0);
  // 陌生词模式由共享工具栏 tool==="unknown" 驱动（与精读同一语义），
  // 不再维护独立的 unknownMode 布尔开关。
  const [unknownWords, setUnknownWords] = useState([]);
  const [hint, setHint] = useState("");
  // 共享笔工具栏状态：工具偏好与精读共用同一批 storage key（Tool preferences = shared）。
  const [inkTool, setInkTool] = useState("pen");
  const [inkColor, setInkColor] = useState("#173a62");
  // 输入模式与精读同一语义：Android 默认手写批注，可切键盘输入；
  // 切换只影响交互截获，不清笔迹 / 不 reload / 不改 activeBlank 与答案。
  const [inkNoteMode, setInkNoteMode] = useState(() => isAndroidApp());
  const [inkPenSize, setInkPenSize] = useState(() => normalizePenSize(getUserItem(PEN_SIZE_STORAGE_KEY)));
  const [inkPenMode, setInkPenMode] = useState(() => normalizePenMode(getUserItem(PEN_MODE_STORAGE_KEY)));
  const [inkEraserMode, setInkEraserMode] = useState(() => getUserItem("wuliao:pref:eraser-mode") || "normal");
  const [inkEraserSize, setInkEraserSize] = useState(24);
  const [inkCollapsed, setInkCollapsed] = useState(false);
  const [clozeInkStrokes, setClozeInkStrokes] = useState([]);
  const clozeInkApiRef = useRef(null);
  const inkToolRef = useRef(inkTool);
  const unknownSelectionRef = useRef(null);
  // AI 释义链串行化（与精读 aiLookupChainRef 同语义）：快速连续划词时
  // 释义补充按顺序执行，避免并发 updateUnknownWordMeaning 互相覆盖。
  const aiLookupChainRef = useRef(Promise.resolve());
  const progressRef = useRef(null);
  const translationRef = useRef(null);
  const progressSaveTimerRef = useRef(null);
  const translationSaveTimerRef = useRef(null);
  const aliveRef = useRef(true);
  const handleClozeToolbarApiChange = useCallback((api) => {
    clozeInkApiRef.current = api;
  }, []);

  // StrictMode 会先执行一次 cleanup 再重放 effect：effect body 必须把
  // aliveRef 重置为 true，否则 mounted guard 会永久失效。
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => { inkToolRef.current = inkTool; }, [inkTool]);

  const loadEffectKey = `${resource.id}:${resource.clozeSource || "custom"}`;

  function flushPendingWrites() {
    if (progressSaveTimerRef.current !== null) {
      window.clearTimeout(progressSaveTimerRef.current);
      progressSaveTimerRef.current = null;
    }
    if (translationSaveTimerRef.current !== null) {
      window.clearTimeout(translationSaveTimerRef.current);
      translationSaveTimerRef.current = null;
    }
    if (progressRef.current) saveClozeProgress(progressRef.current, storageUsername);
    if (translationRef.current && !saveClozeTranslationProgress(translationRef.current, storageUsername)) throw new Error("完形翻译保存失败，请重试");
  }
  useSaveBoundary(flushPendingWrites);

  useEffect(() => {
    const handlePageHide = () => backgroundSave(flushPendingWrites);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      backgroundSave(flushPendingWrites);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError("");
    setStatus("正在读取完形数据");
    setReferenceMode(false);
    setAnalysisFilter("all");
    // 完形资料加载 watchdog：本地 JSON 读取异常或网络被阻塞时不得永久
    // 停留在 loading；超时后走 error 分支并可重试（R4）。
    const watchdog = window.setTimeout(() => {
      if (cancelled) return;
      setError("完形资料读取超时，请重试");
      setStatus("完形数据读取失败");
    }, 20000);
    (async () => {
      let nextCloze;
      let nextIsOfficial = false;
      let nextClozeId = "";
      const customCloze = resource.analysis?.clozes?.[0];
      if (customCloze) {
        nextCloze = customCloze;
        // Custom cloze attempts have historically been keyed by resource id.
        // Keep that identity stable even when the parsed cloze gains its own id.
        nextClozeId = resource.id;
      } else if (resource.clozeSource) {
        nextCloze = await loadOfficialCloze(resource);
        nextIsOfficial = true;
        nextClozeId = nextCloze.id || resource.id;
      } else {
        throw new Error("完形资料缺少正文数据");
      }
      const numbers = clozeBlankNumbers(nextCloze);
      const nextFlow = getClozeFlow(resource.id, nextClozeId);
      const nextProgress = getClozeProgress(resource.id, nextClozeId, numbers);
      const nextTranslation = loadClozeTranslationProgress(resource.id, nextClozeId);
      if (cancelled) return;
      progressRef.current = nextProgress;
      translationRef.current = nextTranslation;
      setCloze(nextCloze);
      setIsOfficial(nextIsOfficial);
      setClozeId(nextClozeId);
      setFlow(nextFlow);
      setProgress(nextProgress);
      setTranslationProgress(nextTranslation);
      setStatus("完形数据已就绪");
    })().catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus("完形数据读取失败");
      }
    }).finally(() => window.clearTimeout(watchdog));
    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
    };
  }, [loadEffectKey, resource.id, resource.analysis, resource.clozeSource, loadAttempt]);

  useEffect(() => {
    if (flow?.timedAttempt?.phase !== "running") return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [flow?.timedAttempt?.phase]);

  // 共享陌生词库（IndexedDB `unknown-words`）：只读当前资源的记录。
  // 阶段隔离在 UI / toggle 入口层实施，这里只负责数据加载与事件刷新。
  useEffect(() => {
    let cancelled = false;
    const load = () => listUnknownWords()
      .then((items) => {
        if (cancelled) return;
        setUnknownWords(items.filter((item) => String(item.resourceId || "") === String(resource.id)));
      })
      .catch(() => {});
    load();
    const handle = () => load();
    window.addEventListener(AppEvent.UNKNOWN_WORDS_UPDATED, handle);
    return () => {
      cancelled = true;
      window.removeEventListener(AppEvent.UNKNOWN_WORDS_UPDATED, handle);
    };
  }, [resource.id]);

  function updateFlow(next) {
    setFlow(next);
    saveClozeFlow(next);
  }

  function updateProgress(next, { deferred = false } = {}) {
    progressRef.current = next;
    setProgress(next);
    if (!deferred) {
      if (progressSaveTimerRef.current !== null) window.clearTimeout(progressSaveTimerRef.current);
      progressSaveTimerRef.current = null;
      backgroundSave(() => saveClozeProgress(next, storageUsername));
      return;
    }
    if (progressSaveTimerRef.current !== null) window.clearTimeout(progressSaveTimerRef.current);
    progressSaveTimerRef.current = window.setTimeout(() => {
      progressSaveTimerRef.current = null;
      if (progressRef.current) backgroundSave(() => saveClozeProgress(progressRef.current, storageUsername));
    }, SAVE_DELAY_MS);
  }

  function updateTranslation(next, { deferred = false } = {}) {
    translationRef.current = next;
    setTranslationProgress(next);
    if (!deferred) {
      if (translationSaveTimerRef.current !== null) window.clearTimeout(translationSaveTimerRef.current);
      translationSaveTimerRef.current = null;
      backgroundSave(() => {
        if (!saveClozeTranslationProgress(next, storageUsername)) throw new Error("完形翻译保存失败");
      });
      return;
    }
    if (translationSaveTimerRef.current !== null) window.clearTimeout(translationSaveTimerRef.current);
    translationSaveTimerRef.current = window.setTimeout(() => {
      translationSaveTimerRef.current = null;
      if (translationRef.current) backgroundSave(() => {
        if (!saveClozeTranslationProgress(translationRef.current, storageUsername)) throw new Error("完形翻译保存失败");
      });
    }, SAVE_DELAY_MS);
  }

  function closeReader() {
    onClose();
  }

  function showHint(message) {
    setHint(message);
    window.setTimeout(() => setHint(""), 1600);
  }

  function chooseInkPenSize(value) {
    const next = normalizePenSize(value);
    setInkPenSize(next);
    setUserItem(PEN_SIZE_STORAGE_KEY, String(next));
  }

  function chooseInkPenMode(value) {
    const next = normalizePenMode(value);
    setInkPenMode(next);
    setUserItem(PEN_MODE_STORAGE_KEY, next);
    setInkTool("pen");
  }

  function chooseInkEraserMode(value) {
    setInkEraserMode(value);
    setUserItem("wuliao:pref:eraser-mode", value);
    setInkTool("eraser");
  }

  function refreshClozeUnknownWords() {
    listUnknownWords()
      .then((items) => {
        if (!aliveRef.current) return;
        setUnknownWords(items.filter((item) => String(item.resourceId || "") === String(resource.id)));
      })
      .catch(() => {});
  }

  function sentenceSourceText(sentence) {
    return (sentence?.tokens || [])
      .map((token) => (token.type === "text" ? token.text : "____"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 逐空精析 / 全文回读：完整开放（离线释义 → AI → 人工补充），
  // 释义链实现见 commitClozeUnknownSelection（与精读同链）。

  // 陌生词选择：与精读完全同一套 Shared Ink Runtime beforeInk* 钩子语义。
  // 收集（划过单词）→ 抬笔 commit（释义链：已有记录 → 离线词库 → AI → 人工补充）。
  function collectClozeUnknownToken(event) {
    collectUnknownTokenInto(unknownSelectionRef.current, event);
  }

  function sentenceByClozeOccurrence(occurrenceId) {
    const sentenceKey = String(occurrenceId || "").replace(/:\d+$/, "");
    if (!sentenceModel?.sentenceByKey) return null;
    return sentenceModel.sentenceByKey[sentenceKey] || null;
  }

  async function commitClozeUnknownSelection(selection) {
    try {
      for (const token of selection.tokens.values()) {
        const normalizedWord = normalizeUnknownWord(token.word);
        if (!normalizedWord || !aliveRef.current) continue;
        // 离线词库查找失败（如 E2E dev 下词库 chunk 不可用）→ 降级为空释义，
        // 继续走 AI / 人工补充链，绝不中止整次 commit（与精读同语义）。
        let meaning = "";
        try {
          meaning = await lookupUnknownWordMeaning(token.word);
        } catch {
          meaning = "";
        }
        const current = unknownWords.find((word) => word.normalizedWord === normalizedWord);
        meaning ||= current?.meaning || "";
        if (!meaning) {
          const apiKey = await getAiApiKey();
          if (apiKey) {
            const sentence = sentenceByClozeOccurrence(token.occurrenceId);
            const record = await toggleUnknownWord(buildClozeUnknownEntry({
              resource,
              word: token.word,
              normalizedWord,
              occurrenceId: token.occurrenceId,
              meaning: "",
            }));
            if (record && aliveRef.current) {
              // 与精读同语义：AI 释义补全入串行链（mounted guard + catch 兜底），
              // 不在 commit 主流程内阻塞后续 token。
              aiLookupChainRef.current = aiLookupChainRef.current
                .then(async () => {
                  if (!aliveRef.current) return;
                  const aiMeaning = await lookupWordMeaningWithAi({
                    apiKey,
                    word: token.word,
                    sentence: sentenceSourceText(sentence),
                  });
                  if (aiMeaning && aliveRef.current) await updateUnknownWordMeaning(record.id, aiMeaning);
                })
                .catch(() => {});
            }
            continue;
          }
          const entered = window.prompt(`离线词库没有收录 ${token.word}，请补充中文释义`, "");
          if (entered === null) continue;
          meaning = entered.trim();
        }
        await toggleUnknownWord(buildClozeUnknownEntry({
          resource,
          word: token.word,
          normalizedWord,
          occurrenceId: token.occurrenceId,
          meaning,
        }));
      }
    } finally {
      globalThis.CSS?.highlights?.delete(ACTIVE_UNKNOWN_HIGHLIGHT);
    }
    if (!aliveRef.current) return;
    refreshClozeUnknownWords();
    showHint(selection.tokens.size ? "陌生词库已更新" : "笔尖没有经过英文单词");
  }

  const clozeUnknownHooks = createUnknownSelectionHooks({
    toolRef: inkToolRef,
    selectionRef: unknownSelectionRef,
    onCollect: collectClozeUnknownToken,
    onCommit: commitClozeUnknownSelection,
    onError: showHint,
  });

  function toggleQuestionPanel() {
    if (!panelOpen) openPanel("cloze-questions");
    setPanelOpen((value) => !value);
  }

  useEffect(() => onOtherPanelOpen("cloze-questions", (panel) => {
    if (panel === "ai") setPanelOpen(false);
  }), []);

  useBackHandler(() => {
    if (!panelOpen) return false;
    setPanelOpen(false);
    return true;
  }, {
    enabled: panelOpen,
    priority: BACK_PRIORITY.drawer,
  });

  const stageId = flow?.currentStage || "cloze-cover";
  const numbers = useMemo(() => (cloze ? clozeBlankNumbers(cloze) : []), [cloze]);
  const sentenceModel = useMemo(
    () => buildClozeSentenceModel(cloze, resource.id, clozeId),
    [cloze, resource.id, clozeId],
  );
  const officialAnswers = useMemo(
    () => (canSeeOfficialAnswers(stageId)
      ? officialAnswerFor(stageId, resource, clozeId, isOfficial) || {}
      : null),
    [stageId, resource, clozeId, isOfficial],
  );
  const priorityList = useMemo(
    () => priorityBlankNumbers(progress, stageId, officialAnswers),
    [progress, stageId, officialAnswers],
  );
  const prioritySet = useMemo(() => new Set(priorityList), [priorityList]);
  // 陌生词两态门控（产品决策）：禁止查词的阶段（初做/复查/订正）整个入口隐藏；
  // 允许的阶段（逐空精析/全文回读）100% 使用精读完整能力。不存在 mark-only 中间态。
  const unknownWordsVisible = isAnalysisStage(stageId) || isFinalReadStage(stageId);
  const unknownWordOccurrences = useMemo(
    () => new Set(unknownWords.flatMap((item) => item.occurrences || [])),
    [unknownWords],
  );
  // 陌生词记录刷新 + saved highlight：允许陌生词的阶段才读取与高亮
  // （与 ink frame loop 完全解耦；不绑定每帧读取 IndexedDB）。
  useEffect(() => {
    if (!unknownWordsVisible) return undefined;
    refreshClozeUnknownWords();
    window.addEventListener("wuliao:unknown-words-updated", refreshClozeUnknownWords);
    return () => window.removeEventListener("wuliao:unknown-words-updated", refreshClozeUnknownWords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.id, unknownWordsVisible]);

  useEffect(() => {
    if (!unknownWordsVisible) return undefined;
    highlightSavedUnknownWords({
      root: document,
      selectedOccurrences: unknownWordOccurrences,
    });
    return () => globalThis.CSS?.highlights?.delete(SAVED_UNKNOWN_HIGHLIGHT);
  });

  // 纵深门控：进入禁止陌生词的阶段时，若 inkTool 残留 "unknown"（如跨阶段切换
  // 时 tool 未重置），立即退回 pen——runtime 层即使收到划线也不收集陌生词。
  useEffect(() => {
    if (!unknownWordsVisible && inkTool === "unknown") setInkTool("pen");
  }, [unknownWordsVisible, inkTool]);

  const translationTargets = useMemo(
    () => priorityTranslationTargets(
      sentenceModel,
      priorityList,
      translationProgress?.targetOverrides || {},
    ),
    [sentenceModel, priorityList, translationProgress?.targetOverrides],
  );
  const translationTargetSet = useMemo(
    () => new Set(translationTargets.map((sentence) => sentence.sentenceKey)),
    [translationTargets],
  );

  const readerPageRef = useRef(null);
  const paperReady = Boolean(cloze && flow && progress && translationProgress && !error);
  useReaderPaperLayout(readerPageRef, panelOpen, `${clozeId}:${paperReady}:${inkCollapsed}`, {
    pageSelector: ".cloze-reader-page",
    paperSelector: ".cloze-passage-pane",
  });

  if (error) {
    return (
      <div className="cloze-reader-page">
        <ReaderHeader resource={resource} onClose={closeReader} note="C 阶段正式训练" />
        <main className="cloze-reader-main">
          <div className="cloze-reader-error">
            <strong>{status}</strong>
            <p>{error}</p>
            <button type="button" className="primary-button" onClick={() => setLoadAttempt((value) => value + 1)}>重新加载</button>
          </div>
        </main>
      </div>
    );
  }

  if (!cloze || !flow || !progress || !translationProgress) {
    return (
      <div className="cloze-reader-page">
        <ReaderHeader resource={resource} onClose={closeReader} note="C 阶段正式训练" />
        <main className="cloze-reader-main"><div className="cloze-reader-loading">{status}</div></main>
      </div>
    );
  }

  const elapsed = clozeTimerElapsed(flow, clock);
  const timerPhase = flow.timedAttempt.phase;
  const activeBlank = activeBlankOf(progress);
  const activeSentence = sentenceModel.blankToSentence[activeBlank] || null;
  const analyzedCount = analyzedBlankNumbers(progress).length;
  const analysisRemaining = numbers.length - analyzedCount;
  const translationRemaining = translationTargets.filter((sentence) => (
    translationEntryFor(translationProgress, sentence.sentenceKey).status !== "corrected"
  )).length;
  const analysisComplete = analysisRemaining === 0
    && areClozeTranslationTargetsCorrected(translationProgress, translationTargets);
  const firstRemaining = numbers.filter((number) => isBlankUnanswered(progress.attempts[number])).length;
  const reviewRemaining = numbers.filter((number) => !progress.attempts[number]?.reviewAnswer).length;
  // 注意：本段位于 early-return 之后，不能使用 hooks；finalReadAnswers 为普通派生值。
  const finalReadAnswers = isFinalReadStage(stageId) ? (() => {
    const hasOfficial = Boolean(isOfficial && officialAnswers && Object.keys(officialAnswers).length);
    const answers = {};
    const optionTexts = {};
    numbers.forEach((number) => {
      const attempt = progress.attempts[number] || {};
      const key = hasOfficial
        ? (officialAnswers[number] || officialAnswers[String(number)] || "")
        : (attempt.reviewAnswer || attempt.firstAnswer || "");
      answers[number] = key;
      optionTexts[number] = key ? clozeOptionText(cloze, number, key) : "";
    });
    return { answers, optionTexts, hasOfficial };
  })() : null;
  const activeAttempt = progress.attempts[activeBlank] || {};
  const activeOfficial = officialAnswers?.[activeBlank] || officialAnswers?.[String(activeBlank)] || "";
  const activeHasOfficial = Boolean(isOfficial && activeOfficial);
  const activeAiAvailability = clozeAiAvailability({
    stageId,
    analyzed: Boolean(activeAttempt.analyzed),
    hasOfficial: activeHasOfficial,
    officialAnswer: activeOfficial,
    firstAnswer: activeAttempt.firstAnswer,
    reviewAnswer: activeAttempt.reviewAnswer,
  });

  function answer(number) {
    return effectiveClozeAnswer(progress.attempts[number], stageId);
  }

  function confidenceOf(number) {
    return effectiveClozeConfidence(progress.attempts[number], stageId);
  }

  function chooseAnswer(number, optionKey) {
    if (isFirstAttemptStage(stageId)) {
      const wasUnanswered = isBlankUnanswered(progress.attempts[number]);
      let next = recordFirstAnswer(progress, number, optionKey);
      // 首次填入时继续保留自动跳到下一未答空；用户返回已答空改选时，
      // 留在当前题确认新选项，不能把“自动跳题”误当成答案已冻结。
      if (wasUnanswered) {
        const nextBlank = nextUnansweredBlank(next, number + 1);
        if (nextBlank != null) next = setActiveBlank(next, nextBlank);
      }
      updateProgress(next);
      return;
    }
    if (isReviewStage(stageId)) updateProgress(recordReviewAnswer(progress, number, optionKey));
  }

  function chooseConfidence(number, confidence) {
    if (isFirstAttemptStage(stageId)) {
      updateProgress(recordFirstConfidence(progress, number, confidence));
      return;
    }
    if (isReviewStage(stageId)) updateProgress(recordReviewConfidence(progress, number, confidence));
  }

  function goToBlank(number) {
    flushPendingWrites();
    updateProgress(setActiveBlank(progress, number));
    setReferenceMode(false);
    setPanelOpen(true);
    window.setTimeout(() => {
      document.getElementById(`cloze-blank-${number}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  }

  function toggleSentenceReference(sentence) {
    if (!isAnalysisStage(stageId) || !referenceMode || !sentence) return;
    const attempt = progress.attempts[activeBlank];
    const exists = attempt?.references?.some((item) => item.sentenceKey === sentence.sentenceKey);
    const next = exists
      ? removeReference(progress, activeBlank, sentence.sentenceKey)
      : addReference(progress, activeBlank, buildClozeSentenceRef(sentence));
    updateProgress(next);
  }

  function jumpToReference(reference) {
    const sentence = resolveClozeSentenceRef(reference, sentenceModel);
    if (!sentence) return;
    document.getElementById(sentence.anchor)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function handleTimer(action) {
    const now = Date.now();
    const next = action === "start"
      ? startClozeTimer(flow, now)
      : action === "pause"
        ? pauseClozeTimer(flow, now)
        : action === "resume"
          ? resumeClozeTimer(flow, now)
          : finishClozeTimer(flow, now);
    updateFlow(next);
  }

  function completeStage() {
    if (isFirstAttemptStage(stageId)) {
      let nextFlow = flow;
      if (nextFlow.timedAttempt.phase === "running") nextFlow = finishClozeTimer(nextFlow);
      updateFlow(completeClozeStage(nextFlow, stageId));
      updateProgress(markFirstSubmitted(progress, true));
      return;
    }
    if (isReviewStage(stageId)) {
      updateFlow(completeClozeStage(flow, stageId));
      updateProgress(markReviewSubmitted(progress, true));
      return;
    }
    if (isCorrectionStage(stageId)) {
      updateProgress(markAllCorrected(progress, true));
      updateFlow(completeClozeStage(flow, stageId));
      return;
    }
    if (isAnalysisStage(stageId)) {
      if (!analysisComplete) return;
      flushPendingWrites();
      updateFlow(completeClozeStage(flow, stageId));
      return;
    }
    if (isFinalReadStage(stageId)) {
      const now = Date.now();
      flushPendingWrites();
      const nextFlow = completeClozeStage(flow, stageId, now);
      updateFlow(nextFlow);
      scheduleClozeD1AfterCompletion(nextFlow);
      onClose();
      // R6：完成现有 flow 后展示"本篇学习结果"（不新增阶段、不改变 completedAt）。
      onShowLearningSummary?.(resource.id, clozeId);
      return;
    }
    updateFlow(completeClozeStage(flow, stageId));
  }

  // E 阶段：当天训练完成后 eager 创建 D+1 长期复习任务。
  // 只基于本地确定性事实（progress / officialAnswer / translation 状态），
  // AI diagnosis 不参与；ensure 幂等，重复完成不会覆盖首次 snapshot。
  function scheduleClozeD1AfterCompletion(completedFlow) {
    try {
      const completedAt = completedFlow?.stages?.["cloze-final-read"]?.completedAt || Date.now();
      const hasOfficial = isOfficial && Object.keys(officialAnswers || {}).length > 0;
      const supportByBlank = buildClozeSupportSignals({
        progress: progressRef.current,
        sentenceModel,
        translationProgress: translationRef.current,
        translationTargetKeys: translationTargetSet,
      });
      const scheduled = scheduleClozeD1Task({
        resourceId: resource.id,
        clozeId,
        completedAt,
        progress: progressRef.current,
        officialAnswers: hasOfficial ? officialAnswers : {},
        supportByBlank,
      });
    } catch {
      // 长期复习任务创建失败不应阻断当天训练完成流程。
    }
  }

  function completeActiveAnalysis(analyzed) {
    let next = markAnalyzed(progress, activeBlank, analyzed);
    let nextBlank = null;
    if (analyzed) {
      nextBlank = nextUnanalyzedBlank(next, activeBlank + 1);
      if (nextBlank != null) next = setActiveBlank(next, nextBlank);
    }
    updateProgress(next);
    if (nextBlank != null) {
      window.setTimeout(() => {
        document.getElementById(`cloze-blank-${nextBlank}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
    }
  }

  function requestClozeAi(taskType) {
    if (!activeSentence) return;
    const allSentences = sentenceModel.paragraphs.flatMap((paragraph) => paragraph.sentences || []);
    const activeIndex = allSentences.findIndex((sentence) => sentence.sentenceKey === activeSentence.sentenceKey);
    const contextSources = allSentences
      .slice(Math.max(0, activeIndex - 1), activeIndex + 2)
      .map((sentence) => ({ sentenceId: sentence.sentenceKey, source: sentence.stableText }));
    const currentSentence = { sentenceId: activeSentence.sentenceKey, source: activeSentence.stableText };
    const blank = (cloze.blanks || []).find((item) => Number(item.number) === activeBlank);
    const safetyOptionTexts = (blank?.options || []).map((option) => option.text).filter(Boolean);
    let detail = null;

    if (taskType === TASK_CLOZE_HINT_1) {
      if (!activeAiAvailability.hint1) return;
      detail = buildClozeHintDetail({
        taskType,
        resourceId: resource.id,
        clozeId,
        blankNumber: activeBlank,
        chapter: resource.title,
        currentSentence,
        contextSources,
      });
    } else {
      const allowed = taskType === TASK_CLOZE_EXPLANATION
        ? activeAiAvailability.explanation
        : taskType === TASK_CLOZE_DIAGNOSIS
          ? activeAiAvailability.diagnosis
          : taskType === TASK_CLOZE_CONTEXT_REVIEW && activeAiAvailability.contextReview;
      if (!allowed) return;
      const resolvedReferences = (activeAttempt.references || [])
        .map((reference) => resolveClozeSentenceRef(reference, sentenceModel))
        .filter(Boolean)
        .map((sentence) => ({ sentenceId: sentence.sentenceKey, source: sentence.stableText }));
      const currentTranslation = translationEntryFor(translationProgress, activeSentence.sentenceKey);
      detail = buildClozeAnalysisDetail({
        taskType,
        resourceId: resource.id,
        clozeId,
        blankNumber: activeBlank,
        chapter: resource.title,
        currentSentence,
        evidenceSources: contextSources,
        options: blank?.options || [],
        officialAnswer: activeOfficial,
        firstAnswer: activeAttempt.firstAnswer,
        reviewAnswer: activeAttempt.reviewAnswer,
        manualAnalysis: {
          prediction: activeAttempt.prediction,
          basisTypes: activeAttempt.basisTypes,
          references: resolvedReferences,
          translation: currentTranslation.text,
        },
      });
    }
    if (!detail) return;
    emitAppEvent(AppEvent.AI_REQUEST, {
      ...detail,
      type: taskType,
      safetyOptionTexts,
    });
  }

  const navigationNumbers = isAnalysisStage(stageId)
    && analysisFilter === "priority"
    && priorityList.length
    ? priorityList
    : numbers;

  return (
    <div ref={readerPageRef} className={`cloze-reader-page ${inkCollapsed ? "top-area-collapsed" : ""}`}>
      <ReaderHeader
        resource={resource}
        onClose={closeReader}
        stageId={stageId}
        priorityCount={priorityList.length}
        answerDisplayMode={isFinalReadStage(stageId) ? "" : answerDisplayMode}
        onAnswerDisplayMode={isFinalReadStage(stageId)
          ? null
          : () => setAnswerDisplayMode((value) => (value === "key" ? "text" : "key"))}
      />

      {/* 共享笔工具栏：与精读 / 模拟考试同一组件、同一视觉契约；位于页面 Header 之后、正文之前。 */}
      <AnnotationToolbar
        tool={inkTool}
        color={inkColor}
        annotations={clozeInkStrokes}
        noteMode={inkNoteMode}
        onToggleNoteMode={() => { setInkNoteMode((value) => !value); }}
        onTool={(value) => { setInkTool(value); setInkNoteMode(true); }}
        onColor={(value) => { setInkColor(value); setInkTool("pen"); setInkNoteMode(true); }}
        penSize={inkPenSize}
        penMode={inkPenMode}
        eraserMode={inkEraserMode}
        eraserSize={inkEraserSize}
        onPenSize={chooseInkPenSize}
        onPenMode={chooseInkPenMode}
        onEraserMode={chooseInkEraserMode}
        onEraserSize={setInkEraserSize}
        onUndo={() => clozeInkApiRef.current?.undo()}
        onClear={() => clozeInkApiRef.current?.clear()}
        canClear={clozeInkStrokes.length > 0}
        clearLabel="清空笔迹"
        collapsible
        collapsed={inkCollapsed}
        onCollapsedChange={setInkCollapsed}
        stageHint={CLOZE_STAGES.find((stage) => stage.id === stageId)?.label || ""}
        unknownEnabled={unknownWordsVisible}
        tabletInk={isAndroidApp()}
      />

      <main className="cloze-reader-main">
        <div className={`cloze-reader-layout ${panelOpen ? "" : "panel-collapsed"}`}>
          <section className="cloze-passage-pane" aria-label="完形正文">
            {isFinalReadStage(stageId) ? (
              <div className="cloze-final-banner">
                <div><small>FINAL READ</small><h1>全文回读</h1><p>重新完整读一遍文章，关注语义与逻辑，不再做题。正文 Blank 位置保持稳定，悬停可查看选项文字。</p></div>
                {!finalReadAnswers?.hasOfficial && (
                  <div className="cloze-final-warning">此自定义资料无官方答案，正文按你的最终选择展示，不代表正确答案。</div>
                )}
              </div>
            ) : (
              <>
                {isFirstAttemptStage(stageId) && (
                  <div className="cloze-timer-bar">
                    <strong>{formatElapsed(elapsed)}</strong>
                    {timerPhase === "idle" && <button type="button" onClick={() => handleTimer("start")}>开始计时</button>}
                    {timerPhase === "running" && <button type="button" onClick={() => handleTimer("pause")}>暂停</button>}
                    {timerPhase === "paused" && <button type="button" onClick={() => handleTimer("resume")}>继续</button>}
                    <span>剩余未答 {firstRemaining} 空</span>
                  </div>
                )}
                {isReviewStage(stageId) && (
                  <div className="cloze-timer-bar">
                    <span>自主复查 · 修改只影响复查答案，初做答案保持不变</span>
                    <span>复查未填 {reviewRemaining} 空</span>
                  </div>
                )}
                {isCorrectionStage(stageId) && (
                  <div className="cloze-timer-bar">
                    <span>统一订正 · 两次作答已冻结，整体核对后进入逐空精析</span>
                    <span>{officialAnswers && Object.keys(officialAnswers).length ? "官方答案对照" : "自定义资料无官方答案"}</span>
                  </div>
                )}
                {isAnalysisStage(stageId) && (
                  <div className="cloze-analysis-summary">
                    <div><strong>逐空精析</strong><span>已完成 {analyzedCount} / {numbers.length}</span></div>
                    <div><span>重点空 {priorityList.length}</span><span>重点句待订正 {translationRemaining}</span></div>
                    <div className="cloze-analysis-filter">
                      <button type="button" className={analysisFilter === "all" ? "is-active" : ""} onClick={() => setAnalysisFilter("all")}>全部</button>
                      <button
                        type="button"
                        className={analysisFilter === "priority" ? "is-active" : ""}
                        onClick={() => {
                          setAnalysisFilter("priority");
                          if (priorityList.length && !prioritySet.has(activeBlank)) goToBlank(priorityList[0]);
                        }}
                      >重点</button>
                    </div>
                  </div>
                )}
                {priorityList.length > 0 && (
                  <div className="cloze-priority-bar">
                    <span>重点 {priorityList.length}</span>
                    {priorityList.map((number) => (
                      <button type="button" key={number} onClick={() => goToBlank(number)}>{number}</button>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* 手写笔迹 Surface：只覆盖稳定正文区域（Question Panel 不进入笔迹坐标空间）。
                所有正式阶段（初做→复查→订正→精析→回读）共用同一 canonical passage geometry。 */}
            <ClozeInkSurface
              resourceId={resource.id}
              clozeId={clozeId}
              enabled={stageId !== "cloze-cover" && inkNoteMode}
              tool={inkTool}
              color={inkColor}
              penSize={inkPenSize}
              penMode={inkPenMode}
              eraserMode={inkEraserMode}
              eraserSize={inkEraserSize}
              onStrokesChange={setClozeInkStrokes}
              onToolbarApiChange={handleClozeToolbarApiChange}
              beforeInkDown={unknownWordsVisible ? clozeUnknownHooks.beforeInkDown : null}
              beforeInkMove={unknownWordsVisible ? clozeUnknownHooks.beforeInkMove : null}
              beforeInkFinish={unknownWordsVisible ? clozeUnknownHooks.beforeInkFinish : null}
            >
              <ClozePassage
                cloze={cloze}
                model={sentenceModel}
                progress={progress}
                activeBlank={activeBlank}
                prioritySet={prioritySet}
                answer={answer}
                answerDisplayMode={answerDisplayMode}
                confidenceOf={confidenceOf}
                referenceMode={referenceMode}
                activeReferences={progress.attempts[activeBlank]?.references || []}
                onGoToBlank={goToBlank}
                onSentenceReference={toggleSentenceReference}
                finalRead={isFinalReadStage(stageId)}
                finalAnswers={finalReadAnswers?.answers || null}
                finalOptionTexts={finalReadAnswers?.optionTexts || null}
              />
            </ClozeInkSurface>

            {isFinalReadStage(stageId) ? null : (
              <div className="cloze-stage-actions">
                {stageId === "cloze-cover" && <button type="button" className="primary-button" onClick={completeStage}>开始限时初做</button>}
                {isFirstAttemptStage(stageId) && (
                  <button type="button" className="primary-button" onClick={completeStage}>
                    {firstRemaining ? `提交并进入复查（${firstRemaining} 空未答将标记为重点）` : "提交并进入复查"}
                  </button>
                )}
                {isReviewStage(stageId) && (
                  <button type="button" className="primary-button" onClick={completeStage}>
                    {reviewRemaining ? `完成复查并订正（${reviewRemaining} 空未填）` : "完成复查并进入订正"}
                  </button>
                )}
                {isCorrectionStage(stageId) && (
                  <button type="button" className="primary-button" onClick={completeStage}>完成订正，进入逐空精析</button>
                )}
                {isAnalysisStage(stageId) && (
                  <div className="cloze-analysis-complete">
                    <span>
                      {analysisRemaining > 0
                        ? `还有 ${analysisRemaining} 空未完成精析`
                        : translationRemaining > 0
                          ? `还有 ${translationRemaining} 个重点句未完成订正`
                          : "逐空精析与重点句笔译已完成"}
                    </span>
                    <button type="button" className="primary-button" disabled={!analysisComplete} onClick={completeStage}>进入全文回读</button>
                  </div>
                )}
              </div>
            )}
          </section>

          <aside
            className={`cloze-question-panel reader-side-panel ${panelMotion.visible ? "is-open" : ""}`}
            data-motion-state={panelMotion.state}
            aria-hidden={panelMotion.state === "closed"}
            aria-label={isFinalReadStage(stageId) ? "回读面板" : isAnalysisStage(stageId) ? "精析工作区" : "题目窗"}
          >
            <button type="button" className="cloze-panel-toggle" onClick={toggleQuestionPanel} aria-expanded={panelOpen}>
              {panelOpen
                ? (isAnalysisStage(stageId) ? "收起工作区" : "收起题窗")
                : (isAnalysisStage(stageId) ? "展开工作区" : "展开题窗")}
            </button>
            {isFinalReadStage(stageId) ? (
              <FinalReadPanel
                completed={flow.stages?.["cloze-final-read"]?.status === "completed"}
                onComplete={completeStage}
              />
            ) : isAnalysisStage(stageId) ? (
              <AnalysisPanel
                cloze={cloze}
                progress={progress}
                translationProgress={translationProgress}
                officialAnswers={officialAnswers || {}}
                hasOfficial={isOfficial && Object.keys(officialAnswers || {}).length > 0}
                activeBlank={activeBlank}
                activeSentence={activeSentence}
                navigationNumbers={navigationNumbers}
                priorityList={priorityList}
                translationTargetSet={translationTargetSet}
                referenceMode={referenceMode}
                onReferenceMode={() => setReferenceMode((value) => !value)}
                onPrediction={(value) => updateProgress(setPrediction(progress, activeBlank, value), { deferred: true })}
                onToggleBasis={(value) => updateProgress(toggleBasisType(progress, activeBlank, value))}
                onRemoveReference={(key) => updateProgress(removeReference(progress, activeBlank, key))}
                onJumpReference={jumpToReference}
                onCorrected={(value) => updateProgress(markCorrected(progress, activeBlank, value))}
                onAnalyzed={completeActiveAnalysis}
                onGoTo={goToBlank}
                onClosePanel={() => setPanelOpen(false)}
                aiAvailability={activeAiAvailability}
                onAiRequest={requestClozeAi}
                onToggleTranslationTarget={() => {
                  if (!activeSentence) return;
                  const override = translationTargetSet.has(activeSentence.sentenceKey) ? "exclude" : "include";
                  updateTranslation(setTranslationTargetOverride(translationProgress, activeSentence.sentenceKey, override));
                }}
                onTranslationText={(value) => {
                  if (!activeSentence) return;
                  updateTranslation(
                    setClozeTranslationText(translationProgress, activeSentence.sentenceKey, value),
                    { deferred: true },
                  );
                }}
                onTranslationBlur={flushPendingWrites}
                onMarkTranslated={() => {
                  if (!activeSentence) return;
                  updateTranslation(markClozeTranslationTranslated(translationProgress, activeSentence.sentenceKey));
                }}
                onMarkTranslationCorrected={() => {
                  if (!activeSentence) return;
                  updateTranslation(markClozeTranslationCorrected(translationProgress, activeSentence.sentenceKey));
                }}
              />
            ) : (
              <QuestionPanel
                cloze={cloze}
                progress={progress}
                stageId={stageId}
                officialAnswers={officialAnswers || {}}
                hasOfficial={isOfficial && Object.keys(officialAnswers || {}).length > 0}
                activeBlank={activeBlank}
                onChoose={chooseAnswer}
                onConfidence={chooseConfidence}
                onGoTo={goToBlank}
                onClosePanel={() => setPanelOpen(false)}
                aiAvailability={activeAiAvailability}
                onAiRequest={requestClozeAi}
              />
            )}
          </aside>
        </div>
        {!panelOpen && (
          <button type="button" className="cloze-panel-expand-fab" onClick={toggleQuestionPanel}>
            展开题窗
          </button>
        )}
      </main>
      <AiFloatWindow
        mode="cloze-task"
        available={isReviewStage(stageId) || isAnalysisStage(stageId)}
        currentResourceId={resource.id}
        aiContext={{ resourceId: resource.id, clozeId }}
      />
      {hint && <div className="toast">{hint}</div>}
    </div>
  );
}

function ReaderHeader({
  resource,
  onClose,
  stageId = "",
  priorityCount = null,
  note = "",
  answerDisplayMode = "",
  onAnswerDisplayMode = null,
}) {
  return (
    <header className="cloze-reader-header">
      <button className="back-button" type="button" onClick={onClose}>← 返回</button>
      <div className="cloze-reader-title">
        <small>CLOZE · USE OF ENGLISH</small>
        <strong>{resource.title}</strong>
        {stageId && <span className="cloze-reader-stage">{CLOZE_STAGES.find((stage) => stage.id === stageId)?.label}</span>}
      </div>
      <div className="cloze-reader-header-actions">
        {onAnswerDisplayMode && (
          <button
            type="button"
            className="cloze-answer-display-toggle"
            aria-label="切换正文答案显示"
            aria-pressed={answerDisplayMode === "text"}
            onClick={onAnswerDisplayMode}
          >
            正文：{answerDisplayMode === "text" ? "选项内容" : "ABCD"}
          </button>
        )}
        {priorityCount != null ? <span className="cloze-reader-priority" title="重点空">重点 {priorityCount}</span> : note && <span>{note}</span>}
      </div>
    </header>
  );
}

function ClozePassage({
  cloze,
  model,
  progress,
  activeBlank,
  prioritySet,
  answer,
  answerDisplayMode,
  confidenceOf,
  referenceMode,
  activeReferences,
  onGoToBlank,
  onSentenceReference,
  finalRead = false,
  finalAnswers = null,
  finalOptionTexts = null,
}) {
  const referenceKeys = new Set(activeReferences.map((item) => item.sentenceKey));
  // Canonical Cloze Passage Geometry：
  // - Blank 始终为“题号 + 字母/—”，宽度稳定，不随答案/显示模式/阶段变化；
  // - answerDisplayMode="text" 的完整选项文字通过绝对定位 popover 展示，绝不改变正文 inline flow；
  // - final-read 与其余正式阶段使用同一正文 renderer（不重建排版）。
  // 陌生词：每个句子 span 是独立 [data-unknown-scope]（scope id = sentence.sentenceKey，
  // 其本身已含 cloze: 前缀；occurrenceId = `${sentenceKey}:${wordIndex}`，与精读同一
  // hit-test / highlight 机制，且 sentenceByClozeOccurrence 可经去尾部数字精确反查）；
  // Blank chip 用 [data-unknown-ignore] 排除（字母/占位符不是英文单词）。
  return (
    <article className={`cloze-passage ${referenceMode ? "is-reference-mode" : ""}`}>
      {model.paragraphs.map((paragraph) => (
        <p key={paragraph.number}>
          {paragraph.sentences.map((sentence, sentenceIndex) => {
            const isReference = referenceKeys.has(sentence.sentenceKey);
            return (
              <span
                id={sentence.anchor}
                key={sentence.sentenceKey}
                className={`cloze-sentence ${isReference ? "is-reference" : ""}`}
                role={referenceMode ? "button" : undefined}
                tabIndex={referenceMode ? 0 : undefined}
                data-unknown-scope={sentence.sentenceKey}
                data-sentence-scope={sentence.sentenceKey}
                onClick={() => { if (!finalRead) onSentenceReference(sentence); }}
                onKeyDown={(event) => {
                  if (!finalRead && referenceMode && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onSentenceReference(sentence);
                  }
                }}
              >
                {sentence.tokens.map((token, index) => {
                  if (token.type === "text") {
                    return <span key={`${sentence.sentenceKey}-t${index}`}>{token.text}</span>;
                  }
                  const chosen = answer(token.number);
                  const letter = finalRead && finalAnswers?.[token.number] ? finalAnswers[token.number] : chosen;
                  const optionText = chosen ? clozeOptionText(cloze, token.number, chosen) : "";
                  // “正文：选项内容”是触屏可见的正文显示模式，不能只把文字放进 hover
                  // popover：平板没有 hover，用户会误以为切换按钮失效。初做 / 复查只用
                  // 自己已经选过的 optionText，不读取或泄露官方答案。
                  const inlineOptionText = !finalRead && answerDisplayMode === "text" ? optionText : "";
                  const popoverText = finalRead
                    ? (finalOptionTexts?.[token.number] || optionText)
                    : "";
                  const confidence = confidenceOf(token.number);
                  const attempt = progress.attempts[token.number] || {};
                  const cls = [
                    "cloze-blank",
                    inlineOptionText ? "is-answer-text" : "",
                    !finalRead && token.number === activeBlank ? "is-active" : "",
                    letter ? "is-answered" : "",
                    confidence ? `is-${confidence}` : "",
                    prioritySet.has(token.number) ? "is-priority" : "",
                    attempt.analyzed && !finalRead ? "is-analyzed" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <button
                      id={finalRead ? undefined : `cloze-blank-${token.number}`}
                      type="button"
                      className={cls}
                      key={`cloze-blank-${token.number}`}
                      tabIndex={finalRead ? -1 : 0}
                      data-unknown-ignore
                      aria-label={`第 ${token.number} 空${letter ? `，已作答 ${letter}${inlineOptionText || popoverText ? `，选项：${inlineOptionText || popoverText}` : ""}` : "，未作答"}`}
                      onClick={(event) => {
                        if (finalRead) return;
                        event.stopPropagation();
                        if (referenceMode) onSentenceReference(sentence);
                        else onGoToBlank(token.number);
                      }}
                    >
                      <b>{token.number}</b>
                      {letter ? <em>{inlineOptionText || letter}</em> : <i>—</i>}
                      {popoverText && <span className="cloze-blank-popover" role="tooltip">{popoverText}</span>}
                    </button>
                  );
                })}
                {sentenceIndex < paragraph.sentences.length - 1 ? " " : ""}
              </span>
            );
          })}
        </p>
      ))}
    </article>
  );
}

function AttemptSummary({ attempt, official, hasOfficial }) {
  const row = buildBlankCorrectionRow(attempt, hasOfficial ? official : "");
  return (
    <div className="cloze-correction-block">
      <div className="cloze-correction-official">
        <span>{hasOfficial ? "官方答案" : "答案状态"}</span>
        <strong>{hasOfficial ? official || "—" : "无官方答案"}</strong>
      </div>
      <div className="cloze-correction-compare">
        <span>初做 {answerMark(attempt.firstAnswer, row?.firstCorrect)} · {confidenceLabel(attempt.firstConfidence || attempt.confidence) || "未标记"}</span>
        <span>复查 {answerMark(attempt.reviewAnswer, row?.reviewCorrect)} · {confidenceLabel(attempt.reviewConfidence) || "未标记"}</span>
        <span>{changeLabel(attempt)}</span>
      </div>
      {!hasOfficial && <p className="cloze-no-answer-note">此自定义资料没有可靠官方答案，只展示你的真实作答变化，不判断对错。</p>}
    </div>
  );
}

function QuestionPanel({
  cloze,
  progress,
  stageId,
  officialAnswers,
  hasOfficial,
  activeBlank,
  onChoose,
  onConfidence,
  onGoTo,
  onClosePanel,
  aiAvailability,
  onAiRequest,
}) {
  const numbers = clozeBlankNumbers(cloze);
  const index = numbers.indexOf(activeBlank);
  const previous = numbers[index - 1];
  const next = numbers[index + 1];
  const attempt = progress.attempts[activeBlank] || {};
  const selected = effectiveClozeAnswer(attempt, stageId);
  const official = officialAnswers[activeBlank] || officialAnswers[String(activeBlank)] || "";
  const canEdit = canEditFirstAnswers(stageId) || canEditReviewAnswers(stageId);

  return (
    <div className="cloze-question-card">
      <PanelHeading activeBlank={activeBlank} numbers={numbers} onGoTo={onGoTo} />
      {isPostCorrectionStage(stageId) && <AttemptSummary attempt={attempt} official={official} hasOfficial={hasOfficial} />}
      {isPostCorrectionStage(stageId) && !canEdit && <ReadOnlyAnswerNotice hasOfficial={hasOfficial} />}
      <OptionList cloze={cloze} activeBlank={activeBlank} selected={selected} canEdit={canEdit} onChoose={onChoose} />
      {canEdit && (
        <div className="cloze-confidence-row" aria-label="判断程度">
          {["confident", "uncertain", "guess"].map((value) => {
            const active = (isReviewStage(stageId) ? attempt.reviewConfidence : attempt.firstConfidence || attempt.confidence) === value;
            return <button type="button" key={value} className={active ? "is-active" : ""} onClick={() => onConfidence(activeBlank, value)}>{confidenceLabel(value)}</button>;
          })}
        </div>
      )}
      {isPostCorrectionStage(stageId) && !canEdit && (
        <div className="cloze-confidence-readonly">
          初做 {confidenceLabel(attempt.firstConfidence || attempt.confidence) || "—"}<span>·</span>复查 {confidenceLabel(attempt.reviewConfidence) || "—"}
        </div>
      )}
      {isReviewStage(stageId) && aiAvailability?.hint1 && (
        <section className="cloze-ai-entry">
          <div><small>AI HINT</small><strong>卡住时先看方向，不看答案</strong></div>
          <button type="button" onClick={() => onAiRequest(TASK_CLOZE_HINT_1)}>提示 1</button>
          <small>提示请求不发送选项、官方答案、作答或信心；提示 2 在提示 1 内继续。</small>
        </section>
      )}
      <div className="cloze-question-foot"><span>{index + 1} / {numbers.length}</span><button type="button" className="cloze-panel-close" onClick={onClosePanel}>收起</button></div>
    </div>
  );
}

function PanelHeading({ activeBlank, numbers, onGoTo }) {
  const index = numbers.indexOf(activeBlank);
  return (
    <div className="cloze-question-head">
      <small>QUESTION</small>
      <strong>第 {activeBlank} 空</strong>
      <span className="cloze-question-nav">
        <button type="button" disabled={index <= 0} onClick={() => onGoTo(numbers[index - 1])}>上一空</button>
        <button type="button" disabled={index < 0 || index >= numbers.length - 1} onClick={() => onGoTo(numbers[index + 1])}>下一空</button>
      </span>
    </div>
  );
}

function OptionList({ cloze, activeBlank, selected, canEdit = false, onChoose = () => {} }) {
  const blank = (cloze.blanks || []).find((item) => Number(item.number) === activeBlank);
  return (
    <div className="cloze-question-options">
      {(blank?.options || []).map((option) => (
        <button
          type="button"
          className={`cloze-option ${selected === option.key ? "is-chosen" : ""} ${canEdit ? "" : "is-readonly"}`}
          key={option.key}
          disabled={!canEdit}
          onClick={() => onChoose(activeBlank, option.key)}
        >
          <b>{option.key}</b><span>{option.text || "（选项缺失）"}</span>
        </button>
      ))}
    </div>
  );
}

function ReadOnlyAnswerNotice({ hasOfficial }) {
  return (
    <div className="cloze-answer-readonly-note" role="status">
      {hasOfficial
        ? "初做和复查答案已锁定，避免订正阶段改写原始作答。现在请核对官方答案与两次作答的差异；核对完成后，进入“逐空精析”。"
        : "初做和复查答案已锁定。现在请核对两次作答变化并完成统一订正；完成后进入“逐空精析”。"}
    </div>
  );
}

function AnalysisPanel({
  cloze,
  progress,
  translationProgress,
  officialAnswers,
  hasOfficial,
  activeBlank,
  activeSentence,
  navigationNumbers,
  priorityList,
  translationTargetSet,
  referenceMode,
  onReferenceMode,
  onPrediction,
  onToggleBasis,
  onRemoveReference,
  onJumpReference,
  onCorrected,
  onAnalyzed,
  onGoTo,
  onClosePanel,
  onToggleTranslationTarget,
  onTranslationText,
  onTranslationBlur,
  onMarkTranslated,
  onMarkTranslationCorrected,
  aiAvailability,
  onAiRequest,
}) {
  const attempt = progress.attempts[activeBlank] || {};
  const official = officialAnswers[activeBlank] || officialAnswers[String(activeBlank)] || "";
  const selected = attempt.reviewAnswer || attempt.firstAnswer || "";
  const isPriority = priorityList.includes(activeBlank);
  const isTranslationTarget = activeSentence && translationTargetSet.has(activeSentence.sentenceKey);
  const translation = activeSentence ? translationEntryFor(translationProgress, activeSentence.sentenceKey) : null;
  const knownBasis = new Set(CLOZE_BASIS_TYPES.map((item) => item.id));
  const unknownBasis = (attempt.basisTypes || []).filter((value) => !knownBasis.has(value));

  return (
    <div className="cloze-question-card cloze-analysis-card">
      <PanelHeading activeBlank={activeBlank} numbers={navigationNumbers} onGoTo={onGoTo} />
      <div className="cloze-analysis-badges">
        <span className={isPriority ? "is-priority" : ""}>{isPriority ? "重点空" : "普通空"}</span>
        <span className={attempt.corrected ? "is-complete" : ""}>{attempt.corrected ? "已核对" : "未标记核对"}</span>
        <span className={attempt.analyzed ? "is-complete" : ""}>{attempt.analyzed ? "已精析" : "待精析"}</span>
      </div>
      {activeSentence && <div className="cloze-analysis-context"><small>所在句</small><p>{activeSentence.excerpt}</p></div>}
      <AttemptSummary attempt={attempt} official={official} hasOfficial={hasOfficial} />
      <ReadOnlyAnswerNotice />
      <OptionList cloze={cloze} activeBlank={activeBlank} selected={selected} />

      <label className="cloze-analysis-field">
        <span>本空预判</span>
        <textarea value={attempt.prediction || ""} onChange={(event) => onPrediction(event.target.value)} onBlur={onTranslationBlur} placeholder="写下本空真正应该表达什么，不由程序自动生成" />
      </label>

      <div className="cloze-analysis-field">
        <span>判断依据</span>
        <div className="cloze-basis-grid">
          {CLOZE_BASIS_TYPES.map((item) => (
            <button type="button" key={item.id} className={attempt.basisTypes?.includes(item.id) ? "is-active" : ""} onClick={() => onToggleBasis(item.id)}>{item.label}</button>
          ))}
        </div>
        {unknownBasis.length > 0 && <small>历史依据：{unknownBasis.map((value) => CLOZE_BASIS_TYPE_LABELS[value] || value).join("、")}</small>}
      </div>

      <div className="cloze-analysis-field">
        <div className="cloze-field-heading"><span>原文依据</span><button type="button" className={referenceMode ? "is-active" : ""} onClick={onReferenceMode}>{referenceMode ? "结束选句" : "选择原文依据"}</button></div>
        {referenceMode && <small>点击左侧正文中的句子即可添加或取消。</small>}
        <div className="cloze-reference-list">
          {(attempt.references || []).map((reference) => (
            <div key={reference.sentenceKey}>
              <button type="button" onClick={() => onJumpReference(reference)}>第 {reference.paragraphNumber} 段第 {reference.sentenceIndex + 1} 句 · {reference.excerpt}</button>
              <button type="button" aria-label="删除原文依据" onClick={() => onRemoveReference(reference.sentenceKey)}>×</button>
            </div>
          ))}
          {!attempt.references?.length && <small>尚未选择原文依据。</small>}
        </div>
      </div>

      <div className="cloze-analysis-status-actions">
        <button type="button" onClick={() => onCorrected(!attempt.corrected)}>{attempt.corrected ? "取消本空已核对" : "标记本空已核对"}</button>
        <button type="button" className={attempt.analyzed ? "" : "primary-button"} onClick={() => onAnalyzed(!attempt.analyzed)}>{attempt.analyzed ? "取消完成精析" : "完成本空精析"}</button>
      </div>

      <section className="cloze-ai-entry cloze-ai-analysis-entry">
        <div><small>AI REVIEW</small><strong>完形专属 AI</strong></div>
        {!attempt.analyzed ? (
          <p>先完成本空人工精析；标记“完成本空精析”后才开放 AI。</p>
        ) : hasOfficial ? (
          <div className="cloze-ai-entry-actions">
            {aiAvailability?.explanation && <button type="button" onClick={() => onAiRequest(TASK_CLOZE_EXPLANATION)}>完整讲解</button>}
            {aiAvailability?.diagnosis && <button type="button" onClick={() => onAiRequest(TASK_CLOZE_DIAGNOSIS)}>错因分析</button>}
            {!aiAvailability?.diagnosis && <small>初做与复查没有错误作答，本空不生成错因分析。</small>}
          </div>
        ) : (
          <div className="cloze-ai-entry-actions">
            {aiAvailability?.contextReview && <button type="button" onClick={() => onAiRequest(TASK_CLOZE_CONTEXT_REVIEW)}>语境复盘</button>}
            <small>此资料无官方答案，只复盘语境与人工分析，不判断正确答案。</small>
          </div>
        )}
      </section>

      {activeSentence && (
        <section className="cloze-target-translation">
          <div className="cloze-field-heading">
            <div><small>TARGETED TRANSLATION</small><strong>重点句定点笔译</strong></div>
            <button type="button" onClick={onToggleTranslationTarget}>{isTranslationTarget ? "移出重点句" : "加入重点句"}</button>
          </div>
          {isTranslationTarget ? (
            <>
              <p>{activeSentence.excerpt}</p>
              <small>关联 Blank：{activeSentence.blankNumbers.map((number) => `第 ${number} 空`).join("、")}</small>
              <textarea value={translation?.text || ""} onChange={(event) => onTranslationText(event.target.value)} onBlur={onTranslationBlur} placeholder="输入自己的中文译文" />
              <div className="cloze-translation-actions">
                <span className={`status-${translation?.status || "pending"}`}>{statusLabel(translation?.status)}</span>
                <button type="button" disabled={!String(translation?.text || "").trim()} onClick={onMarkTranslated}>完成笔译</button>
                <button type="button" disabled={translation?.status !== "translated"} onClick={onMarkTranslationCorrected}>完成订正</button>
              </div>
            </>
          ) : <p className="cloze-translation-empty">此句当前不属于重点句；可手动加入后进行笔译。</p>}
        </section>
      )}

      <div className="cloze-question-foot"><span>{activeBlank} / {clozeBlankNumbers(cloze).length}</span><button type="button" className="cloze-panel-close" onClick={onClosePanel}>收起</button></div>
    </div>
  );
}

function FinalReadPanel({ completed, onComplete }) {
  return (
    <div className="cloze-question-card cloze-final-panel">
      <small>FINAL READ</small>
      <strong>全文回读</strong>
      <p>关注全文语义与逻辑衔接，不再做题。正文 Blank 保持稳定位置，悬停 Blank 可查看选项文字。</p>
      <div className="cloze-stage-actions">
        <button type="button" className="primary-button" onClick={onComplete}>
          {completed ? "返回完形资料库" : "完成全文回读"}
        </button>
      </div>
    </div>
  );
}
