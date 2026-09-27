import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendAiHistoryMessage,
  buildExplainMessages,
  buildQuickTranslateMessages,
  callAi,
  callCachedTextAi,
  readTextAiCache,
  runQuickTranslation,
  createAiHistoryRecord,
  getAiApiKey,
  getAiModelOptions,
  getPreferredAiModel,
  listAiHistory,
  loadAiHistoryRecord,
  resolveAiModel,
  setAiApiKey,
  setPreferredAiModel,
  toggleAiHistoryFavorite,
} from "./ai";
import { getUserItem, setUserItem } from "./userData";
import { onOtherPanelOpen, openPanel } from "./panelBus";
import TranslationReviewCard from "./TranslationReviewCard";
import QuestionHintCard from "./QuestionHintCard";
import QuestionDiagnosisCard from "./QuestionDiagnosisCard";
import LearningArchivePanel from "./LearningArchivePanel";
import ClozeAiCard from "./ClozeAiCard";
import {
  TASK_QUESTION_EXPLANATION,
  TASK_QUESTION_HINT_1,
  TASK_QUESTION_HINT_2,
  TASK_QUESTION_DIAGNOSIS,
  TASK_TRANSLATION_REVIEW,
  buildQuestionDiagnosisUserMessage,
} from "./aiTasks";
import {
  buildQuestionHintUserMessage,
  runQuestionHint,
} from "./questionHintService";
import { runQuestionDiagnosis } from "./questionDiagnosisService";
import {
  buildTranslationReviewName,
  runTranslationReview,
} from "./aiReviewService";
import {
  clearLearningRecords,
  deleteLearningRecord,
  listLearningRecords,
  setLearningRecordResolved,
  updateTagStatus,
} from "./aiLearningRecords";
import {
  TASK_CLOZE_HINT_1,
  TASK_CLOZE_HINT_2,
  buildClozeAiUserMessage,
  isClozeAiTask,
} from "./clozeAiTasks";
import { runClozeAiTask } from "./clozeAiService";
import { useBackHandler } from "./ui/BackContext";
import { BACK_PRIORITY } from "./ui/backController";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent, onAppEvent } from "./events/appEvents";
import { createAiRequestLifecycle, mergeAiRequestContext } from "./aiRequestLifecycle";
import { useMotionPresence } from "./ui/useMotionPresence";

const BUTTON_POS_KEY = "wuliao:ai:button-pos";
const BUTTON_WIDTH = 54;
const BUTTON_HEIGHT = 76;
const TAP_MAX_MOVE = 10;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadPos(key, width, height) {
  try {
    const parsed = JSON.parse(getUserItem(key));
    if (!parsed || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return {
      x: clamp(parsed.x, 0, Math.max(0, window.innerWidth - width)),
      y: clamp(parsed.y, 0, Math.max(0, window.innerHeight - height)),
    };
  } catch {
    return null;
  }
}

function savePos(key, value) {
  try {
    setUserItem(key, JSON.stringify(value));
  } catch {
    // 位置保存失败不影响使用
  }
}

const SUGGESTION_TEXT = `建议先做后为ai提供以下内容：
我认为主语是：
我认为谓语是：
我认为宾语或表语是：
我识别出的从句：
我的试译：
我具体卡住的地方：`;

export default function AiFloatWindow({
  onOpenChange,
  open: controlledOpen,
  embedded = false,
  questionAnswerAccess,
  currentResourceId = "",
  available = true,
  onMarkTranslationCorrected = null,
  isTranslationCorrected = null,
  mode = "default",
  aiContext = null,
  openHistoryId = "",
  onHistoryOpenHandled = null,
  backPriorityOverride = null,
}) {
  const clozeTaskOnly = mode === "cloze-task";
  const [internalOpen, setOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const motion = useMotionPresence(open);
  const [buttonPos, setButtonPos] = useState(() => loadPos(BUTTON_POS_KEY, BUTTON_WIDTH, BUTTON_HEIGHT));
  const [messages, setMessages] = useState([]);
  const [currentRecordId, setCurrentRecordId] = useState(null);
  const [pending, setPending] = useState(null);
  const [pendingDiagnosis, setPendingDiagnosis] = useState(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLearningArchive, setShowLearningArchive] = useState(false);
  const [learningRecords, setLearningRecords] = useState([]);
  const [archiveDetailId, setArchiveDetailId] = useState(null);
  const [archiveSaveError, setArchiveSaveError] = useState(false);
  const [history, setHistory] = useState([]);
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState(getPreferredAiModel);
  const [error, setError] = useState("");
  const modelOptions = useMemo(() => {
    const options = getAiModelOptions();
    return options.includes(model) ? options : [model, ...options].filter(Boolean);
  }, [model, showSettings]);

  const busyRef = useRef(busy);
  const recordIdRef = useRef(currentRecordId);
  const pendingRef = useRef(pending);
  const messagesRef = useRef(messages);
  const dragRef = useRef(null);
  const dragFrameRef = useRef(0);
  const buttonRef = useRef(null);
  const suppressClickRef = useRef(false);
  const questionAnswerAccessRef = useRef(questionAnswerAccess);
  const availableRef = useRef(available);
  const questionHintMetaRef = useRef(null);
  const aiContextRef = useRef(aiContext);
  const lifecycleRef = useRef(null);
  const keyStatusAliveRef = useRef(true);
  if (!lifecycleRef.current) lifecycleRef.current = createAiRequestLifecycle();
  const lifecycle = lifecycleRef.current;

  // 父组件传入的 aiContext 是每次渲染新建的内联对象；直接以对象作依赖会
  // 在每次渲染触发 cleanup → setActiveContext(null) → abort 全部 in-flight。
  // 用序列化 key 稳定依赖：只有上下文真实变化时才切换并 abort（R4 修复）。
  const aiContextKey = aiContext ? JSON.stringify(aiContext) : "";
  useEffect(() => {
    const next = aiContextKey ? JSON.parse(aiContextKey) : null;
    aiContextRef.current = next;
    lifecycle.setActiveContext(next);
    return () => lifecycle.setActiveContext(null);
  }, [aiContextKey]);

  function beginRequestFor(taskType, detail = {}, controller) {
    const requestId = lifecycle.nextRequestId();
    lifecycle.beginRequest({
      requestId,
      context: mergeAiRequestContext(aiContextRef.current, { ...(detail || {}), type: taskType }),
      controller,
    });
    return requestId;
  }

  function changeOpen(next) {
    if (!next) lifecycle.cancelAll();
    if (controlledOpen === undefined) setOpen(next);
    onOpenChange?.(next);
    if (next && !embedded) openPanel("ai");
  }

  useEffect(() => {
    if (!open) lifecycle.cancelAll();
  }, [open]);

  useEffect(() => {
    if (embedded || motion.state !== "closed") return;
    setShowHistory(false);
    setShowSettings(false);
    setShowLearningArchive(false);
    setArchiveDetailId(null);
  }, [motion.state, embedded]);

  function handleBack() {
    if (archiveDetailId) {
      setArchiveDetailId(null);
      return true;
    }
    if (showLearningArchive || showHistory || showSettings) {
      setShowLearningArchive(false);
      setShowHistory(false);
      setShowSettings(false);
      setArchiveDetailId(null);
      return true;
    }
    changeOpen(false);
    return true;
  }

  useBackHandler(handleBack, {
    enabled: open,
    priority: backPriorityOverride != null
      ? backPriorityOverride
      : (showLearningArchive || showHistory || showSettings
        ? BACK_PRIORITY.drawer
        : BACK_PRIORITY.floating),
    key: `${open}:${showLearningArchive}:${showHistory}:${showSettings}:${archiveDetailId || ""}:${backPriorityOverride ?? ""}`,
  });

  // R6：局部 controlled 接线 —— 由外部（本篇学习结果 / 档案）指定要打开的
  // 历史记录 id。只打开已有记录，不触发任何新的 AI 请求，也不计费。
  const openHistoryHandledRef = useRef("");
  useEffect(() => {
    const historyId = String(openHistoryId || "");
    if (!historyId || openHistoryHandledRef.current === historyId) return;
    openHistoryHandledRef.current = historyId;
    const record = loadAiHistoryRecord(historyId);
    if (record) {
      loadHistoryRecord(historyId);
    } else {
      setError("对应 AI 历史记录已不存在");
      changeOpen(true);
    }
    onHistoryOpenHandled?.(historyId);
  }, [openHistoryId]);

  useEffect(() => embedded ? undefined : onOtherPanelOpen("ai", (panel) => {
    if (panel !== "questions") changeOpen(false); // 习题窗缩小后可与 AI 窗共存
  }), []);

  useEffect(() => () => {
    if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current);
  }, []);

  useEffect(() => {
    const clampPositions = () => {
      setButtonPos((current) => current ? {
        x: clamp(current.x, 0, Math.max(0, window.innerWidth - BUTTON_WIDTH)),
        y: clamp(current.y, 0, Math.max(0, window.innerHeight - BUTTON_HEIGHT)),
      } : current);
    };
    window.addEventListener("resize", clampPositions);
    return () => window.removeEventListener("resize", clampPositions);
  }, []);

  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { recordIdRef.current = currentRecordId; }, [currentRecordId]);
  useEffect(() => {
    if (showSettings) setModel(getPreferredAiModel());
  }, [showSettings]);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { questionAnswerAccessRef.current = questionAnswerAccess; }, [questionAnswerAccess]);
  useEffect(() => {
    availableRef.current = available;
    if (!available) changeOpen(false);
  }, [available]);

  const refreshKeyStatus = useCallback(() => {
    getAiApiKey().then((value) => {
      if (keyStatusAliveRef.current) setHasKey(Boolean(value));
    });
  }, []);

  useEffect(() => () => { keyStatusAliveRef.current = false; }, []);

  useEffect(() => {
    refreshKeyStatus();
    const onFocus = () => refreshKeyStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshKeyStatus]);

  const refreshLearningRecords = useCallback(() => {
    setLearningRecords(listLearningRecords());
  }, []);

  useEffect(() => {
    const onUpdated = () => {
      setArchiveSaveError(false);
      refreshLearningRecords();
    };
    const onSaveFailed = () => {
      setArchiveSaveError(true);
      refreshLearningRecords();
    };
    const offUpdated = onAppEvent(AppEvent.LEARNING_RECORDS_UPDATED, onUpdated);
    const offSaveFailed = onAppEvent(AppEvent.LEARNING_RECORDS_SAVE_FAILED, onSaveFailed);
    return () => {
      offUpdated();
      offSaveFailed();
    };
  }, [refreshLearningRecords]);

  const appendAssistantMessage = (recordId, assistant) => {
    setMessages((current) => [...current, assistant]);
    appendAiHistoryMessage(recordId, assistant);
  };

  const quickTargetRef = useRef(null);
  const runQuickTranslate = useCallback(async (detail, force = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError("");
    quickTargetRef.current = detail;
    const controller = new AbortController();
    const requestId = beginRequestFor("quick-translate", detail, controller);
    const current = () => !lifecycle.isContextStale(requestId);
    try {
      const response = await runQuickTranslation({ ...detail, force, signal: controller.signal, isCurrent: current,
        onNetworkStart: () => { busyRef.current = true; setBusy(true); } });
      if (!current()) return;
      const record = createAiHistoryRecord({ kind: detail.kind === "paragraph" ? "paragraph-translate" : "translate",
        text: detail.text, sentence: detail.text, chapter: detail.chapter, model: resolveAiModel("quick-translate") });
      const user = { role: "user", content: detail.text, label: detail.contextSentence ? "本句词义" : "快译" };
      const assistant = { role: "assistant", content: response.result.translation, reasoning: "", cached: response.cached, quickTranslationMeta: detail };
      setCurrentRecordId(record.id); setMessages([user, assistant]);
      appendAiHistoryMessage(record.id, user); appendAiHistoryMessage(record.id, assistant);
    } catch (reason) { if (current()) setError(`快译失败：${reason.message || reason}`); }
    finally { lifecycle.endRequest(requestId); busyRef.current = false; setBusy(false); }
  }, []);

  const runTranslationReviewInWindow = useCallback(async (detail, force = false) => {
    if (busyRef.current) return;
    setError("");
    setShowHistory(false);
    setShowSettings(false);
    setShowLearningArchive(false);
    setArchiveDetailId(null);
    const sentence = String(detail.sentence || "").trim();
    const userTranslation = String(detail.userTranslation || "").trim();
    if (!sentence || !userTranslation) {
      changeOpen(true);
      setError("缺少英文原句或你的译文，无法批改");
      return;
    }
    changeOpen(true);
    setPending(null);
    const apiKey = await getAiApiKey();

    const controller = new AbortController();
    const requestId = beginRequestFor(TASK_TRANSLATION_REVIEW, detail, controller);
    const model = resolveAiModel(TASK_TRANSLATION_REVIEW);
    const record = createAiHistoryRecord({
      kind: TASK_TRANSLATION_REVIEW,
      sentence,
      chapter: detail.chapter || "自定义",
      model,
      name: buildTranslationReviewName(detail),
    });
    setCurrentRecordId(record.id);
    const userMessage = {
      role: "user",
      content: `【英文原句】\n${sentence}\n【我的译文】\n${userTranslation}`,
      label: "翻译批改",
    };
    setMessages([userMessage]);
    appendAiHistoryMessage(record.id, userMessage);
    busyRef.current = true;
    try {
      const response = await runTranslationReview({
        detail: { ...detail, sentence, userTranslation, historyId: record.id },
        apiKey,
        onNetworkStart: () => setBusy(true),
        useCache: !force,
        signal: controller.signal,
        isCurrent: () => !lifecycle.isContextStale(requestId),
      });
      if (lifecycle.isContextStale(requestId)) return;
      if (response.status === "aborted") return;
      let assistant;
      if (response.status === "busy") {
        assistant = { role: "assistant", content: "已有相同的翻译批改正在执行，请等待完成后再查看。", label: "翻译批改" };
        setMessages((current) => [...current, assistant]);
        appendAiHistoryMessage(record.id, assistant);
        return;
      }
      if (response.status === "invalid" || response.status === "error") {
        assistant = {
          role: "assistant",
          content: `批改失败：${response.message || "请重试"}`,
          label: "翻译批改",
        };
        setMessages((current) => [...current, assistant]);
        appendAiHistoryMessage(record.id, assistant);
        return;
      }
      const reviewMeta = {
        ...detail,
        sentence,
        userTranslation,
        inputMethod: detail.inputMethod,
      };
      assistant = {
        role: "assistant",
        content: response.result?.referenceTranslation || response.raw || "",
        structured: response.result || null,
        parseFallback: response.status === "parse-failed",
        cached: response.status === "ok" && Boolean(response.cached),
        reviewMeta,
      };
      setMessages([userMessage, assistant]);
      appendAiHistoryMessage(record.id, assistant);
    } finally {
      lifecycle.endRequest(requestId);
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const runQuestionHintInWindow = useCallback(async (detail, options = {}) => {
    if (busyRef.current) return;
    setError("");
    setShowHistory(false);
    setShowSettings(false);
    setShowLearningArchive(false);
    setArchiveDetailId(null);
    const taskType = detail.type;
    const level = taskType === TASK_QUESTION_HINT_2
      ? 2
      : taskType === TASK_QUESTION_EXPLANATION
        ? 3
        : 1;
    changeOpen(true);
    if (level === 3) {
      const allowed = questionAnswerAccessRef.current?.(detail.scope, detail.questionNumber);
      if (!allowed) {
        setError("当前学习流程不允许查看完整讲解，请先在对应题卡点击「订正」。");
        return;
      }
    }
    const apiKey = await getAiApiKey();

    const effectiveDetail = detail;
    const controller = new AbortController();
    const requestId = beginRequestFor(taskType, effectiveDetail, controller);
    questionHintMetaRef.current = effectiveDetail;
    const userMessage = buildQuestionHintUserMessage(taskType, effectiveDetail);
    if (options.reset === false) {
      setMessages((current) => [...current, userMessage]);
    } else {
      setMessages([userMessage]);
    }
    busyRef.current = true;
    try {
      const response = await runQuestionHint({
        taskType,
        detail: effectiveDetail,
        apiKey,
        onNetworkStart: () => setBusy(true),
        useCache: options.force ? false : true,
        signal: controller.signal,
        isCurrent: () => !lifecycle.isContextStale(requestId),
      });
      if (lifecycle.isContextStale(requestId)) return;
      if (response.assistant) setMessages((current) => [...current, response.assistant]);
    } finally {
      lifecycle.endRequest(requestId);
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const runQuestionDiagnosisInWindow = useCallback(async (detail, options = {}) => {
    if (busyRef.current) return;
    setError("");
    setShowHistory(false);
    setShowSettings(false);
    setShowLearningArchive(false);
    setArchiveDetailId(null);
    const allowed = questionAnswerAccessRef.current?.(detail.scope, detail.questionNumber);
    if (!allowed) {
      changeOpen(true);
      setError("当前学习流程不允许查看完整讲解，请先在对应题卡点击「订正」。");
      return;
    }
    changeOpen(true);
    if (options.reset !== false) {
      setMessages([]);
      setCurrentRecordId(null);
    }
    setPendingDiagnosis({ detail, reasoning: String(detail.userReasoning || "") });
  }, []);

  async function executeDiagnosis(detail, { force = false } = {}) {
    if (busyRef.current) return;
    const allowed = questionAnswerAccessRef.current?.(detail.scope, detail.questionNumber);
    if (!allowed) {
      setError("当前学习流程不允许查看完整讲解，请先在对应题卡点击「订正」。");
      return;
    }
    busyRef.current = true;
    setError("");
    const controller = new AbortController();
    const requestId = beginRequestFor(TASK_QUESTION_DIAGNOSIS, detail, controller);
    try {
      const apiKey = await getAiApiKey();

      setPendingDiagnosis(null);
      const effectiveDetail = {
        ...detail,
        userReasoning: String(detail.userReasoning || "").trim(),
      };
      const userMessage = buildQuestionDiagnosisUserMessage(effectiveDetail);
      setMessages((current) => [...current, userMessage]);
      const response = await runQuestionDiagnosis({
        detail: effectiveDetail,
        apiKey,
        onNetworkStart: () => setBusy(true),
        useCache: !force,
        signal: controller.signal,
        isCurrent: () => !lifecycle.isContextStale(requestId),
      });
      if (lifecycle.isContextStale(requestId)) return;
      if (response.assistant) setMessages((current) => [...current, response.assistant]);
    } finally {
      lifecycle.endRequest(requestId);
      busyRef.current = false;
      setBusy(false);
    }
  }

  function startDiagnosis() {
    const target = pendingDiagnosis;
    if (!target || busyRef.current) return;
    executeDiagnosis({ ...target.detail, userReasoning: target.reasoning });
  }

  function retryDiagnosisMessage(message) {
    const meta = message?.diagnosisMeta;
    if (!meta || busyRef.current) return;
    executeDiagnosis(meta, { force: true });
  }

  function openDiagnosisReasoningFromCard(message) {
    const meta = message?.diagnosisMeta;
    if (!meta || busyRef.current) return;
    setError("");
    setPendingDiagnosis({ detail: meta, reasoning: String(meta.userReasoning || "") });
  }

  const handleHintNextLevel = useCallback((message, nextTaskType) => {
    const meta = message?.questionHintMeta || questionHintMetaRef.current;
    if (!meta) return;
    if (nextTaskType === TASK_QUESTION_EXPLANATION) {
      emitAppEvent(AppEvent.AI_HINT_NEXT, {
        type: TASK_QUESTION_EXPLANATION,
        questionId: meta.questionId,
        scope: meta.scope,
      });
      return;
    }
    runQuestionHintInWindow({ ...meta, type: nextTaskType }, { reset: false });
  }, [runQuestionHintInWindow]);

  const retryHintMessage = useCallback((message) => {
    const meta = message.questionHintMeta || questionHintMetaRef.current;
    if (!meta) return;
    runQuestionHintInWindow({ ...meta, type: meta.type }, { reset: false, force: true });
  }, [runQuestionHintInWindow]);

  const runClozeTaskInWindow = useCallback(async (requestDetail, options = {}) => {
    if (busyRef.current) return;
    const taskType = requestDetail?.type || requestDetail?.taskType;
    if (!isClozeAiTask(taskType)) return;
    if (taskType === TASK_CLOZE_HINT_2 && !options.hint2Unlocked) {
      changeOpen(true);
      setError("请先完成提示 1，再继续查看提示 2。");
      return;
    }
    const { safetyOptionTexts = [], type: _type, ...detail } = requestDetail;
    detail.taskType = taskType;
    setError("");
    setShowHistory(false);
    setShowSettings(false);
    setShowLearningArchive(false);
    setArchiveDetailId(null);
    setPending(null);
    setPendingDiagnosis(null);
    changeOpen(true);
    const apiKey = await getAiApiKey();
    if (!apiKey) {
      setError("请先在首页右上角“AI API”填入你的 AI API Key");
      return;
    }
    const model = resolveAiModel(taskType);

    let recordId = options.reset === false ? recordIdRef.current : null;
    if (!recordId) {
      const record = createAiHistoryRecord({
        kind: taskType,
        sentence: detail.currentSentence?.source || "",
        chapter: detail.chapter || "完形填空",
        model,
        name: `完形第 ${detail.blankNumber || "—"} 空 · ${taskType}`,
        metadata: {
          sourceType: "cloze",
          resourceId: String(detail.resourceId || ""),
          clozeId: String(detail.clozeId || ""),
          blankNumber: Number(detail.blankNumber) || 0,
          taskType,
        },
      });
      recordId = record.id;
      recordIdRef.current = recordId;
      setCurrentRecordId(recordId);
    }
    const userMessage = buildClozeAiUserMessage(taskType, detail);
    if (options.reset === false) setMessages((current) => [...current, userMessage]);
    else setMessages([userMessage]);
    appendAiHistoryMessage(recordId, userMessage);
    const controller = new AbortController();
    const requestId = beginRequestFor(taskType, detail, controller);
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await runClozeAiTask({
        taskType,
        detail,
        safetyOptionTexts,
        apiKey,
        model,
        useCache: !options.force,
        signal: controller.signal,
        isCurrent: () => !lifecycle.isContextStale(requestId),
      });
      if (lifecycle.isContextStale(requestId)) return;
      const assistant = {
        ...response.assistant,
        clozeSafetyOptionTexts: safetyOptionTexts,
      };
      setMessages((current) => [...current, assistant]);
      appendAiHistoryMessage(recordId, response.assistant);
    } finally {
      lifecycle.endRequest(requestId);
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const handleClozeNextHint = useCallback((message, nextTaskType) => {
    if (!message?.clozeAiMeta) return;
    runClozeTaskInWindow({
      ...message.clozeAiMeta,
      type: nextTaskType,
      taskType: nextTaskType,
      safetyOptionTexts: message.clozeSafetyOptionTexts || [],
    }, { reset: false, hint2Unlocked: true });
  }, [runClozeTaskInWindow]);

  const retryClozeMessage = useCallback((message) => {
    if (!message?.clozeAiMeta) return;
    runClozeTaskInWindow({
      ...message.clozeAiMeta,
      type: message.taskType,
      taskType: message.taskType,
      safetyOptionTexts: message.clozeSafetyOptionTexts || [],
    }, { reset: false, force: true, hint2Unlocked: message.taskType === TASK_CLOZE_HINT_2 });
  }, [runClozeTaskInWindow]);

  useEffect(() => {
    const handleRequest = (detail = {}) => {
      if (!availableRef.current) return;
      if (clozeTaskOnly) {
        if (isClozeAiTask(detail.type)) runClozeTaskInWindow(detail, { reset: detail.origin !== "window" });
        return;
      }
      if (isClozeAiTask(detail.type)) return;
      setError("");
      setShowHistory(false);
      setShowSettings(false);
      setShowLearningArchive(false);
      setArchiveDetailId(null);
      setPendingDiagnosis(null);
      if (detail.type === "explain") {
        changeOpen(true);
        setCurrentRecordId(null);
        setMessages([]);
        setPending({
          sentence: detail.sentence,
          paragraph: detail.paragraph,
          chapter: detail.chapter,
          kind: detail.kind || "sentence",
        });
        return;
      }
      if (detail.type === "translate") {
        changeOpen(true);
        setPending(null);
        runQuickTranslate({
          text: detail.text,
          kind: detail.kind,
          chapter: detail.chapter,
          contextSentence: detail.contextSentence || "",
        });
        return;
      }
      if (detail.type === TASK_TRANSLATION_REVIEW) {
        runTranslationReviewInWindow(detail);
        return;
      }
      if (detail.type === TASK_QUESTION_DIAGNOSIS) {
        runQuestionDiagnosisInWindow(detail, { reset: detail.origin !== "window" });
        return;
      }
      if (
        detail.type === TASK_QUESTION_HINT_1
        || detail.type === TASK_QUESTION_HINT_2
        || detail.type === TASK_QUESTION_EXPLANATION
      ) {
        runQuestionHintInWindow(detail, { reset: detail.origin !== "window" });
      }
    };
    return onAppEvent(AppEvent.AI_REQUEST, handleRequest);
  }, [clozeTaskOnly, runClozeTaskInWindow, runQuickTranslate, runTranslationReviewInWindow, runQuestionHintInWindow, runQuestionDiagnosisInWindow]);

  async function sendMessage() {
    const text = input.trim();
    const wantsExplain = Boolean(pendingRef.current);
    if (!text && !wantsExplain) return;
    if (busyRef.current) return;
    setError("");
    const apiKey = await getAiApiKey();
    setInput("");

    if (wantsExplain) {
      const target = pendingRef.current;
      const messagesForAi = buildExplainMessages({
        sentence: target.sentence,
        paragraph: target.paragraph,
        chapter: target.chapter,
        userInput: text,
      });
      const model = resolveAiModel("sentence-explain");
      if (!readTextAiCache({ model, messages: messagesForAi, taskType: "sentence-explain" })) setBusy(true);
      let recordId = recordIdRef.current;
      if (!recordId) {
        const record = createAiHistoryRecord({
          kind: "explain",
          sentence: target.sentence,
          chapter: target.chapter,
          model,
        });
        recordId = record.id;
        setCurrentRecordId(record.id);
      }
      const userMessage = {
        role: "user",
        content: `【句子】\n${target.sentence}${text ? `\n\n【我的分析/问题】\n${text}` : ""}`,
        label: "讲解",
      };
      setMessages([userMessage]);
      appendAiHistoryMessage(recordId, userMessage);
      setPending(null);
      const controller = new AbortController();
      const requestId = beginRequestFor("sentence-explain", { sentenceId: target.sentenceId || "" }, controller);
      try {
        const result = await callCachedTextAi({
          apiKey,
          model,
          messages: messagesForAi,
          taskType: "sentence-explain",
          signal: controller.signal,
        });
        if (lifecycle.isContextStale(requestId)) return;
        appendAssistantMessage(recordId, {
          role: "assistant",
          content: result.content,
          reasoning: result.reasoning,
        });
      } catch (reason) {
        if (lifecycle.isContextStale(requestId)) return;
        appendAssistantMessage(recordId, {
          role: "assistant",
          content: `讲解失败：${reason instanceof Error ? reason.message : String(reason)}`,
        });
      } finally {
        lifecycle.endRequest(requestId);
        setBusy(false);
      }
      return;
    }

    const model = resolveAiModel("chat");
    let recordId = recordIdRef.current;
    if (!recordId) {
      const record = createAiHistoryRecord({ kind: "chat", text, chapter: "自由提问", model });
      recordId = record.id;
      setCurrentRecordId(record.id);
    }
    const userMessage = { role: "user", content: text };
    const conversationForApi = [...messagesRef.current, userMessage].map((message) => ({
      role: message.role,
      content: String(message.content || ""),
    }));
    if (!readTextAiCache({ model, messages: conversationForApi, taskType: "chat" })) setBusy(true);
    setMessages((current) => [...current, userMessage]);
    appendAiHistoryMessage(recordId, userMessage);
    const controller = new AbortController();
    const requestId = beginRequestFor("chat", {}, controller);
    try {
      const result = await callCachedTextAi({
        apiKey,
        model,
        messages: conversationForApi,
        taskType: "chat",
        signal: controller.signal,
        isCurrent: () => !lifecycle.isContextStale(requestId),
      });
      if (lifecycle.isContextStale(requestId)) return;
      appendAssistantMessage(recordId, {
        role: "assistant",
        content: result.content,
        reasoning: result.reasoning,
      });
    } catch (reason) {
      if (lifecycle.isContextStale(requestId)) return;
      appendAssistantMessage(recordId, {
        role: "assistant",
        content: `回答失败：${reason instanceof Error ? reason.message : String(reason)}`,
      });
    } finally {
      lifecycle.endRequest(requestId);
      setBusy(false);
    }
  }

  function openHistoryPanel() {
    setHistory(listAiHistory());
    setShowSettings(false);
    setShowLearningArchive(false);
    setArchiveDetailId(null);
    setShowHistory(true);
  }

  function openLearningArchive() {
    setShowHistory(false);
    setShowSettings(false);
    setArchiveDetailId(null);
    setArchiveSaveError(false);
    refreshLearningRecords();
    setShowLearningArchive(true);
  }

  function confirmLearningTag(recordId, tagName) {
    updateTagStatus(recordId, tagName, "confirmed");
    refreshLearningRecords();
  }

  function dismissLearningTag(recordId, tagName) {
    updateTagStatus(recordId, tagName, "dismissed");
    refreshLearningRecords();
  }

  function toggleLearningResolved(recordId) {
    const record = learningRecords.find((item) => item.id === recordId);
    if (!record) return;
    setLearningRecordResolved(recordId, !record.resolved);
    refreshLearningRecords();
  }

  function deleteLearningRecordById(recordId) {
    if (!window.confirm("删除这条学习档案记录？AI 历史、译文、答案与笔迹不受影响。")) return;
    deleteLearningRecord(recordId);
    refreshLearningRecords();
  }

  function clearAllLearningRecords() {
    if (!window.confirm("清空本账号全部学习档案？只删除学习档案，不会影响 AI 历史、译文、答案与笔迹。")) return;
    clearLearningRecords();
    refreshLearningRecords();
  }

  function openHistoryForRecord(historyId) {
    const record = loadAiHistoryRecord(historyId);
    if (!record) {
      setError("对应 AI 历史记录已不存在");
      return;
    }
    setCurrentRecordId(record.id);
    setMessages((record.messages || []).map((message) => ({ ...message })));
    setPending(null);
    setPendingDiagnosis(null);
    setShowHistory(false);
    setShowSettings(false);
    setShowLearningArchive(false);
    setArchiveDetailId(null);
    changeOpen(true);
  }

  function jumpFromLearningRecord(record) {
    emitAppEvent(AppEvent.LEARNING_ARCHIVE_JUMP, {
      resourceId: record.resourceId,
      passageId: record.metadata?.passageId || "",
      sentenceId: record.sentenceId,
      questionId: record.questionId,
    });
    changeOpen(false);
  }

  function loadHistoryRecord(id) {
    const record = loadAiHistoryRecord(id);
    if (!record) return;
    setCurrentRecordId(record.id);
    setMessages((record.messages || []).map((message) => ({ ...message })));
    setPending(null);
    setPendingDiagnosis(null);
    setShowHistory(false);
    setShowLearningArchive(false);
    setArchiveDetailId(null);
    changeOpen(true);
  }

  function toggleFavorite(id) {
    toggleAiHistoryFavorite(id);
    setHistory(listAiHistory());
  }

  const lastHintMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].questionHint) return messages[index];
    }
    return null;
  }, [messages]);
  const lastHintLevel = lastHintMessage?.level || 0;

  function startDrag(event) {
    suppressClickRef.current = false;
    const rect = event.currentTarget.getBoundingClientRect();
    const base = { x: rect.left, y: rect.top };
    const pointerId = event.pointerId;
    dragRef.current = { base, startX: event.clientX, startY: event.clientY, pointerId, last: null, moved: false };
    if (typeof event.currentTarget.setPointerCapture === "function" && Number.isFinite(pointerId)) {
      try { event.currentTarget.setPointerCapture(pointerId); } catch { /* 捕获失败不影响拖动 */ }
    }
    const move = (moveEvent) => {
      const drag = dragRef.current;
      if (!drag || moveEvent.pointerId !== drag.pointerId) return;
      const next = {
        x: clamp(drag.base.x + moveEvent.clientX - drag.startX, 0, Math.max(0, window.innerWidth - BUTTON_WIDTH)),
        y: clamp(drag.base.y + moveEvent.clientY - drag.startY, 0, Math.max(0, window.innerHeight - BUTTON_HEIGHT)),
      };
      if (Math.hypot(next.x - drag.base.x, next.y - drag.base.y) > TAP_MAX_MOVE) drag.moved = true;
      drag.last = next;
      if (dragFrameRef.current) return;
      dragFrameRef.current = window.requestAnimationFrame(() => {
        dragFrameRef.current = 0;
        const active = dragRef.current;
        const node = buttonRef.current;
        if (!active?.last || !node) return;
        node.style.transform = `translate(${active.last.x - active.base.x}px, ${active.last.y - active.base.y}px)`;
      });
    };
    const end = (endEvent) => {
      const drag = dragRef.current;
      if (!drag || endEvent.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = 0;
      }
      const wasMoved = Boolean(drag.moved);
      if (drag.last) {
        const node = buttonRef.current;
        if (node) {
          node.style.left = `${drag.last.x}px`;
          node.style.top = `${drag.last.y}px`;
          node.style.right = "auto";
          node.style.transform = "";
        }
        setButtonPos(drag.last);
        savePos(BUTTON_POS_KEY, drag.last);
      }
      dragRef.current = null;
      if (!wasMoved) {
        suppressClickRef.current = true;
        changeOpen(true);
        window.setTimeout(() => { suppressClickRef.current = false; }, 350);
        return;
      }
      suppressClickRef.current = wasMoved;
      window.setTimeout(() => { suppressClickRef.current = false; }, 350);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  const buttonStyle = buttonPos
    ? { left: buttonPos.x, top: buttonPos.y }
    : undefined;

  return (
    <>
      {!embedded && motion.state === "closed" && available && !clozeTaskOnly && (
        <button
          ref={buttonRef}
          type="button"
          className="ai-float-button"
          style={buttonStyle}
          aria-label="打开 AI 悬浮窗"
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            changeOpen(true);
          }}
          onPointerDown={startDrag}
        >
          <span>AI</span>
          <strong>AI</strong>
          <small>问答</small>
        </button>
      )}
      {(embedded || motion.present) && (
        <section
          className={`ai-float-window ${showLearningArchive ? "archive-mode" : ""}`}
          data-motion-state={motion.state}
          role="dialog"
          aria-label="AI 悬浮窗"
          aria-hidden={motion.state === "closed"}
        >
          <header className="drawer-header ai-float-header">
            <div>
              <small>AI PANEL</small>
              <h2>{clozeTaskOnly ? "完形 AI" : "AI 悬浮窗"}</h2>
            </div>
            <div className="drawer-header-actions ai-float-header-actions">
              <button type="button" className="ai-float-link" onClick={openHistoryPanel}>历史记录</button>
              {!clozeTaskOnly && <button type="button" className="ai-float-link" onClick={openLearningArchive}>学习档案</button>}
              <button type="button" className="ai-float-link" onClick={() => { setShowHistory(false); setShowLearningArchive(false); setArchiveDetailId(null); setShowSettings(true); }}>设置</button>
              <button type="button" className="icon-button ai-float-close" onClick={() => changeOpen(false)} aria-label="关闭 AI 悬浮窗">×</button>
            </div>
          </header>

          {showHistory ? (
            <div className="ai-history-panel">
              <div className="ai-history-title">
                <strong>历史记录</strong>
                <button type="button" onClick={() => setShowHistory(false)}>返回</button>
              </div>
              <div className="ai-history-list">
                {history.length ? history.map((record) => (
                  <div className="ai-history-item" key={record.id}>
                    <button type="button" className="ai-history-name" onClick={() => loadHistoryRecord(record.id)}>
                      <strong>{record.name}</strong>
                      <span>{new Date(record.updatedAt || record.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                    </button>
                    <button
                      type="button"
                      className={`ai-history-favorite ${record.favorite ? "active" : ""}`}
                      onClick={() => toggleFavorite(record.id)}
                      aria-label={record.favorite ? "取消收藏" : "收藏"}
                    >{record.favorite ? "★" : "☆"}</button>
                  </div>
                )) : (
                  <p className="ai-history-empty">还没有历史记录。收藏的记录不会在 30 天后自动删除。</p>
                )}
              </div>
            </div>
          ) : showSettings ? (
            <div className="ai-settings-panel">
              <div className="ai-history-title">
                <strong>AI 设置</strong>
                <button type="button" onClick={() => setShowSettings(false)}>返回</button>
              </div>
              <label className="ai-settings-row">
                <span>讲解模型</span>
                <select value={model} onChange={(event) => {
                  setModel(setPreferredAiModel(event.target.value));
                }}>
                  {modelOptions.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
                </select>
              </label>
              <p className="ai-settings-key">模型列表由首页 AI API 设置读取；需要手动输入模型 ID 时请在那里保存。</p>
              <p className={`ai-settings-key ${hasKey ? "ready" : ""}`}>
                {hasKey ? "✓ 已配置本账号 AI API Key" : "未配置 API Key：请到首页右上角“AI API”填入"}
              </p>
              {hasKey && (
                <button type="button" className="ai-settings-clear" onClick={async () => {
                  await setAiApiKey("");
                  refreshKeyStatus();
                }}>清除本账号 API Key</button>
              )}
            </div>
          ) : showLearningArchive ? (
            <LearningArchivePanel
              records={learningRecords}
              currentResourceId={currentResourceId}
              detailId={archiveDetailId}
              onDetailChange={setArchiveDetailId}
              onBack={() => { setShowLearningArchive(false); setArchiveDetailId(null); }}
              onConfirmTag={confirmLearningTag}
              onDismissTag={dismissLearningTag}
              onToggleResolved={toggleLearningResolved}
              onDeleteRecord={deleteLearningRecordById}
              onClearAll={clearAllLearningRecords}
              onOpenHistory={openHistoryForRecord}
              onJump={jumpFromLearningRecord}
              saveError={archiveSaveError}
            />
          ) : (
            <>
              <div className="ai-float-body">
                {!messages.length && !pending && !pendingDiagnosis && !clozeTaskOnly && (
                  <div className="ai-float-suggestion">
                    <pre>{SUGGESTION_TEXT}</pre>
                  </div>
                )}
                {messages.some((message) => message.label === "翻译批改") && (
                  <p className="ai-review-privacy-note">本次会发送当前英文句子、你的文字译文和所在段落。</p>
                )}
                {messages.some((message) => message.label === "错因诊断") && (
                  <p className="ai-review-privacy-note">本次已发送当前题目、选项、你的作答、官方答案和本篇文章相关内容。</p>
                )}
                {lastHintLevel > 0 && (
                  <p className="ai-review-privacy-note">
                    {lastHintLevel === 3
                      ? "完整讲解会发送当前题目、选项、官方答案及文章内容。"
                      : "本次会发送当前题干和本篇文章相关内容，不发送官方答案。"}
                  </p>
                )}
                {messages.some((message) => message.clozeAi) && (
                  <p className="ai-review-privacy-note">
                    {messages.some((message) => message.taskType === TASK_CLOZE_HINT_1 || message.taskType === TASK_CLOZE_HINT_2)
                      ? "订正前提示只发送当前空所在句与相邻语境；不发送选项、官方答案、两次作答或信心。"
                      : "完整讲解仅使用本题、本地答案事实和你在 C 阶段手工填写的分析；AI 不会修改这些数据。"}
                  </p>
                )}
                {pending && (
                  <div className="ai-pending-sentence">
                    <small>讲解 · {pending.kind === "paragraph" ? "整段" : "句子"}</small>
                    <p>{pending.sentence}</p>
                  </div>
                )}
                {pendingDiagnosis && (
                  <div className="ai-pending-diagnosis">
                    <small>
                      错因诊断{pendingDiagnosis.detail.questionNumber ? ` · Q${pendingDiagnosis.detail.questionNumber}` : ""}
                    </small>
                    <p className="ai-pending-diagnosis-question">{pendingDiagnosis.detail.questionText || "（未提供题干）"}</p>
                    <p className="ai-review-privacy-note">本次会发送当前题目、选项、你的作答、官方答案和本篇文章相关内容。</p>
                    <textarea
                      className="ai-diagnosis-reasoning"
                      value={pendingDiagnosis.reasoning}
                      onChange={(event) => setPendingDiagnosis((current) => ({ ...current, reasoning: event.target.value }))}
                      placeholder="例如：我看到第二段出现了这个词，所以直接选了 B；或者留空，让 AI 仅根据你的作答结果进行推测。"
                      rows={3}
                    />
                    {pendingDiagnosis.reasoning.trim() && (
                      <p className="ai-review-privacy-note">你填写的作答思路也会一并发送。</p>
                    )}
                  </div>
                )}
                {messages.map((message, index) => (
                  <div className={`ai-message ${message.role === "user" ? "user" : "assistant"}`} key={`${message.role}-${index}`}>
                    {message.label && <small className="ai-message-label">{message.label}</small>}
                    {message.reasoning && (
                      <details className="ai-reasoning">
                        <summary>AI 思考过程</summary>
                        <pre>{message.reasoning}</pre>
                      </details>
                    )}
                    {message.clozeAi ? (
                      message.structured ? (
                        <ClozeAiCard
                          taskType={message.taskType}
                          result={message.structured}
                          meta={message.clozeAiMeta || {}}
                          cached={Boolean(message.cached)}
                          busy={busy}
                          onNextHint={(nextType) => handleClozeNextHint(message, nextType)}
                          onRegenerate={() => retryClozeMessage(message)}
                        />
                      ) : (
                        <div className="ai-message-content">
                          <p className="ai-hint-error-note">{message.content}{message.quickTranslationMeta && <button type="button" disabled={busy} onClick={() => runQuickTranslate(message.quickTranslationMeta, true)}>重新生成</button>}</p>
                          {message.retryable && <button type="button" className="ai-hint-retry-button" onClick={() => retryClozeMessage(message)}>重新生成</button>}
                        </div>
                      )
                    ) : message.questionDiagnosis ? (
                      message.structured ? (
                        <QuestionDiagnosisCard
                          result={message.structured}
                          meta={message.diagnosisMeta || {}}
                          cached={Boolean(message.cached)}
                          busy={busy}
                          onRegenerate={message.diagnosisMeta?.articleText
                            ? () => retryDiagnosisMessage(message)
                            : undefined}
                          onRedoWithReasoning={message.diagnosisMeta?.articleText
                            ? () => openDiagnosisReasoningFromCard(message)
                            : undefined}
                        />
                      ) : (
                        <div className="ai-message-content">
                          {message.parseFallback ? (
                            <>
                              <p className="ai-review-parse-note">本次结果未能结构化展示，以下为 AI 原始回答。</p>
                              <pre className="ai-review-raw">{message.content}</pre>
                            </>
                          ) : (
                            <p className="ai-hint-error-note">{message.content}</p>
                          )}
                          {message.retryable && message.diagnosisMeta?.articleText && (
                            <button type="button" className="ai-hint-retry-button" onClick={() => retryDiagnosisMessage(message)}>
                              重新生成
                            </button>
                          )}
                        </div>
                      )
                    ) : message.questionHint ? (
                      message.structured ? (
                        <QuestionHintCard
                          result={message.structured}
                          level={message.level}
                          cached={Boolean(message.cached)}
                          busy={busy}
                          canShowFullExplanation={
                            message.level === 2
                              ? Boolean(questionAnswerAccessRef.current?.(
                                message.questionHintMeta?.scope,
                                message.questionHintMeta?.questionNumber,
                              ))
                              : false
                          }
                          canContinue={Boolean(message.questionHintMeta?.articleText)}
                          onNextLevel={(nextType) => handleHintNextLevel(message, nextType)}
                        />
                      ) : (
                        <div className="ai-message-content">
                          {message.parseFallback ? (
                            <>
                              <p className="ai-review-parse-note">本次结果未能结构化展示，以下为 AI 原始回答。</p>
                              <pre className="ai-review-raw">{message.content}</pre>
                            </>
                          ) : (
                            <p className="ai-hint-error-note">{message.content}</p>
                          )}
                          {message.retryable && message.questionHintMeta?.articleText && (
                            <button type="button" className="ai-hint-retry-button" onClick={() => retryHintMessage(message)}>
                              重新生成
                            </button>
                          )}
                        </div>
                      )
                    ) : message.structured ? (
                      <TranslationReviewCard
                        result={message.structured}
                        userTranslation={message.reviewMeta?.userTranslation || ""}
                        cached={Boolean(message.cached)}
                        onRegenerate={() => message.reviewMeta && runTranslationReviewInWindow(message.reviewMeta, true)}
                        corrected={isTranslationCorrected
                          ? Boolean(isTranslationCorrected(message.reviewMeta?.sentenceId))
                          : false}
                        onCorrected={onMarkTranslationCorrected && message.reviewMeta
                          ? () => onMarkTranslationCorrected(message.reviewMeta)
                          : undefined}
                      />
                    ) : message.parseFallback ? (
                      <div className="ai-message-content">
                        <p className="ai-review-parse-note">本次结果未能结构化展示，以下为 AI 原始回答。</p>
                        <pre className="ai-review-raw">{message.content}</pre>
                      </div>
                    ) : (
                      <div className="ai-message-content">{message.content}</div>
                    )}
                  </div>
                ))}
                {busy && <div className="ai-thinking">AI 思考中…</div>}
              </div>
              {error && <p className="ai-float-error">{error}</p>}
              {clozeTaskOnly ? (
                <div className="ai-float-input cloze-ai-task-only-note">完形 AI 只响应当前阶段允许的任务按钮，不开放自由问答。</div>
              ) : pendingDiagnosis ? (
                <div className="ai-float-input">
                  <button type="button" className="ai-diagnosis-start-button" onClick={startDiagnosis} disabled={busy}>
                    {busy ? "正在诊断…" : "开始诊断"}
                  </button>
                  <button
                    type="button"
                    className="ai-diagnosis-cancel-button"
                    onClick={() => setPendingDiagnosis(null)}
                    disabled={busy}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <div className="ai-float-input">
                  {pending ? (
                    <textarea
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      placeholder="输入你的分析或问题（可不填，直接发送句子）"
                      rows={2}
                    />
                  ) : (
                    <textarea
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      placeholder="问 AI 任何问题…"
                      rows={2}
                    />
                  )}
                  <button type="button" onClick={sendMessage} disabled={busy}>{busy ? "…" : "发送"}</button>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
