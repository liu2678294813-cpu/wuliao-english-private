import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import WritingInkSurface from "../writing/WritingInkSurface.jsx";
import { AnnotationToolbar } from "../ui/AnnotationToolbar.jsx";
import { useSaveBoundary } from "../useSaveBoundary.js";
import { getUserItem, setUserItem, getCurrentUsername } from "../userData.js";
import { PEN_MODE_STORAGE_KEY, PEN_SIZE_STORAGE_KEY, normalizePenMode, normalizePenSize } from "../annotationTools.js";
import { computeFileFingerprint } from "../fingerprint.js";
import { handwritingAnswerId, handwritingSessionId, readHandwritingSession, saveHandwritingRecords, classifyHandwriting, assertHandwritingAccount } from "./handwritingStorage.js";
import { recognizeHandwriting, compareHandwriting } from "./handwritingAi.js";
import { loadHandwritingImage } from "./handwritingImage.js";
import { HANDWRITING_ROW_HEIGHT as ROW_HEIGHT, initialHandwritingScroll, runHandwritingWorkflow } from "./handwritingWorkflow.js";
import { buildVocabularyMessage, vocabularyMessageTargetOrigin } from "./vocabularyProtocol.js";
import "../writing/writing.css";
import "./handwriting.css";

const EMPTY = [];
const OVERSCAN = 6;

export function requestScreeningContext(frame) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const finish = (error, value) => { clearTimeout(timer); window.removeEventListener("message", receive); error ? reject(error) : resolve(value); };
    const receive = (event) => {
      if (event.source !== frame || event.origin !== location.origin || event.data?.namespace !== "wuliao:vocabulary" || event.data?.version !== 1 || event.data?.type !== "SCREENING_CONTEXT") return;
      const payload = event.data.payload;
      if (payload?.requestId !== requestId) return;
      if (payload.error) { finish(new Error(payload.error)); return; }
      const context = payload.context;
      if (context?.username !== getCurrentUsername() || !Number.isInteger(context.listId) || !Number.isInteger(context.round) || !Array.isArray(context.words) || context.words.length > 20000 || context.words.some((w) => typeof w.wordId !== "string" || typeof w.english !== "string" || typeof w.chinese !== "string")) {
        finish(new Error("筛选上下文无效，请重新打开筛选页")); return;
      }
      finish(null, context);
    };
    const timer = setTimeout(() => finish(new Error("筛选词库尚未就绪，请重试")), 12000);
    window.addEventListener("message", receive);
    frame?.postMessage(buildVocabularyMessage("REQUEST_SCREENING_CONTEXT", { requestId }), vocabularyMessageTargetOrigin());
  });
}

const InkRow = memo(function InkRow({ word, index, context, answer, pen, active, select, change, onInk, onMutation, onCount, register, onToolbar, onJudge, onError }) {
  const pageRef = useRef(null), handle = useRef(null);
  const pageRegions = useMemo(() => [{ pageId: "answer", ref: pageRef }], []);
  const id = handwritingAnswerId(context, word.wordId);
  useEffect(() => {
    register(word.wordId, { flush: () => handle.current?.flush?.() });
    return () => register(word.wordId, null);
  }, [register, word.wordId]);
  const toolbarChanged = useCallback(api => { handle.current = api; onToolbar(word.wordId, api); }, [onToolbar, word.wordId]);
  const inkChanged = useCallback(ref => onInk(word.wordId, ref), [onInk, word.wordId]);
  const mutated = useCallback((count, size) => onMutation(word.wordId, count, size), [onMutation, word.wordId]);
  const countChanged = useCallback(count => onCount(word.wordId, count), [onCount, word.wordId]);
  const reportError = useCallback(error => onError(error.message), [onError]);
  const masked = Boolean(answer?.masked);
  const verdict = answer?.stale ? "pending" : answer?.verdict;
  const labels = { correct: "正确 · 已加入熟知词", wrong: "错误 · 已加入生词表", unsure: "待复核", pending: "待识别 / 判断" };
  return <div className={`vocab-ink-row ${active ? "is-active" : ""} ${masked ? "is-masked" : ""}`} data-word-id={word.wordId} data-index={index}
    style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }} onFocusCapture={() => select(word.wordId)}>
    <div className="vocab-ink-row-main">
      <div className="vocab-ink-answer-area">
        <button className="vocab-ink-english" disabled={masked} aria-hidden={masked || undefined} onClick={() => {
          if (window.WuliaoPronunciation) window.WuliaoPronunciation.speak(word.english).catch(() => onError("发音暂不可用，请重试"));
          else { const speech = new SpeechSynthesisUtterance(word.english); speech.lang = "en-US"; speechSynthesis.cancel(); speechSynthesis.speak(speech); }
        }}>{word.english} <small>♪</small></button>
        <div className="vocab-ink-transcript">
          <textarea aria-label={`${word.english} 的中文意思`} disabled={masked} aria-hidden={masked || undefined} value={answer?.text || ""} placeholder="识别结果 / 键盘输入"
            onChange={e => change(word.wordId, previous => ({ text: e.target.value, textSource: "keyboard", unsure: false, stale: true, revision: previous.revision + 1 }))} />
          <span className={`vocab-verdict ${verdict || ""}`} title={answer?.reason || ""}>{labels[verdict] || ""}</span>
        </div>
        <div className="vocab-ink-pad" onPointerDownCapture={e => { if (!masked && e.pointerType !== "touch") select(word.wordId); }}>
          <WritingInkSurface username={context.username} sessionId={handwritingSessionId(context)} surfaceId={`vocabulary:${id}`} stageId={null} ownerRecordId={id}
            sourceFingerprint={context.fingerprints[word.wordId]} {...pen} readOnly={masked} pageRegions={pageRegions}
            onStrokesCountChange={countChanged} onInkRefChange={inkChanged} onInkMutation={mutated} onHint={onError}
            onToolbarApiChange={toolbarChanged} onError={reportError}>
            <div ref={pageRef} className="vocab-ink-paper" aria-label={`${word.english} 手写区域`} />
          </WritingInkSurface>
        </div>
      </div>
      <div className="vocab-ink-row-actions">
        <button onClick={() => change(word.wordId, { masked: !masked })}>{masked ? "揭开" : "遮挡"}</button>
        <select aria-label={`${word.english} 人工改判`} value="" onChange={e => { if (e.target.value) onJudge(word.wordId, e.target.value); }}>
          <option value="">人工判断</option><option value="correct">正确</option><option value="wrong">错误</option>
        </select>
      </div>
    </div>
    {answer?.referenceVisible && <div className="vocab-ink-reference" aria-label={`${word.english} 标准汉语`}><strong>标准汉语</strong> {word.chinese || "词库暂无释义"}</div>}
  </div>;
});

export default function HandwritingScreening({ frameRef, route, onUpdated }) {
  const [context, setContext] = useState(null), [answers, setAnswers] = useState({});
  const [message, setMessage] = useState("正在读取当前筛选词库…"), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [active, setActive] = useState(null), [tool, setTool] = useState("pen"), [color, setColor] = useState("#173a62");
  const [penSize, setPenSize] = useState(() => normalizePenSize(getUserItem(PEN_SIZE_STORAGE_KEY)));
  const [penMode] = useState(() => normalizePenMode(getUserItem(PEN_MODE_STORAGE_KEY)));
  const [eraserMode, setEraserMode] = useState(() => getUserItem("wuliao:pref:eraser-mode") || "normal"), [eraserSize, setEraserSize] = useState(24);
  const [toolbarApis, setToolbarApis] = useState({}), [dirtyInk, setDirtyInk] = useState(new Set()), [saveErrors, setSaveErrors] = useState(0);
  const [view, setView] = useState({ top: 0, height: 720 });
  const current = useRef({}), contextRef = useRef(null), handles = useRef(new Map()), mounted = useRef(false), controller = useRef(null);
  const saveTail = useRef(Promise.resolve()), dirty = useRef(new Set()), failed = useRef(new Set()), busyRef = useRef(false);
  const classifications = useRef(new Map()), scrollRef = useRef(null), scrollTimer = useRef(null), scrollFrame = useRef(null), restoredTop = useRef(0);
  const register = useCallback((id, handle) => { if (handle) handles.current.set(id, handle); else handles.current.delete(id); }, []);
  const onToolbar = useCallback((id, api) => setToolbarApis(previous => {
    if (previous[id] === api) return previous;
    const next = { ...previous }; if (api) next[id] = api; else delete next[id]; return next;
  }), []);
  const persist = useCallback(rows => {
    rows.forEach(row => dirty.current.add(row.wordId));
    const task = saveTail.current.catch(() => {}).then(() => saveHandwritingRecords("answers", rows)).then(() => {
      rows.forEach(row => { if (current.current[row.wordId] === row) { dirty.current.delete(row.wordId); failed.current.delete(row.wordId); } });
      if (mounted.current) setSaveErrors(failed.current.size);
    });
    saveTail.current = task;
    task.catch(() => {
      rows.forEach(row => failed.current.add(row.wordId));
      if (mounted.current) { setSaveErrors(failed.current.size); setMessage("答案保存失败，内容仍保留。请重试保存。"); }
    });
    return task;
  }, []);
  const change = useCallback((wordId, patch) => {
    const ctx = contextRef.current;
    if (!ctx || !mounted.current || getCurrentUsername() !== ctx.username) return;
    const previous = current.current[wordId] || { id: handwritingAnswerId(ctx, wordId), username: ctx.username, sessionId: handwritingSessionId(ctx), wordId, revision: 0, text: "" };
    const values = typeof patch === "function" ? patch(previous) : patch;
    if (Object.entries(values).every(([key, value]) => previous[key] === value)) return previous;
    const next = { ...previous, ...values, updatedAt: Date.now() };
    if (next.revision !== previous.revision || next.inkFingerprint !== previous.inkFingerprint) classifications.current.get(wordId)?.abort();
    current.current = { ...current.current, [wordId]: next };
    setAnswers(current.current); persist([next]); return next;
  }, [persist]);
  const onMutation = useCallback((wordId, count, size) => {
    setDirtyInk(previous => new Set([...previous, wordId]));
    change(wordId, previous => ({ strokeCount: count, inkSize: { width: size.width, height: size.height }, textSource: "handwriting", stale: true,
      ...(count === 0 ? { text: "", referenceVisible: false } : {}), revision: previous.revision + 1 }));
  }, [change]);
  const onCount = useCallback((wordId, count) => {
    if (!current.current[wordId] && !count) return;
    change(wordId, { strokeCount: count });
  }, [change]);
  const inkChange = useCallback((wordId, ref) => {
    if (!ref) return;
    setDirtyInk(previous => { if (!previous.has(wordId)) return previous; const next = new Set(previous); next.delete(wordId); return next; });
    if (current.current[wordId]?.inkFingerprint === ref.fingerprint) return;
    change(wordId, previous => ({ inkFingerprint: ref.fingerprint, inkRef: ref, textSource: previous.textSource || "handwriting", stale: true, revision: previous.revision + 1 }));
  }, [change]);
  const savePosition = useCallback(async () => {
    const ctx = contextRef.current;
    if (!ctx || getCurrentUsername() !== ctx.username) return;
    const top = scrollRef.current?.scrollTop ?? restoredTop.current;
    await saveHandwritingRecords("sessions", [{ id: handwritingSessionId(ctx), username: ctx.username, scrollTop: top,
      sourceWordIds: ctx.words.map(word => word.wordId), updatedAt: Date.now() }]);
  }, []);
  const flushAll = useCallback(async () => {
    await Promise.all([...handles.current.values()].map(handle => handle.flush?.()));
    await saveTail.current.catch(() => {});
    if (dirty.current.size) await persist([...dirty.current].map(id => current.current[id]).filter(Boolean));
    await savePosition();
  }, [persist, savePosition]);
  useSaveBoundary(flushAll);
  useEffect(() => {
    mounted.current = true; let cancelled = false;
    setContext(null); contextRef.current = null; setMessage("正在读取当前筛选词库…");
    (async () => {
      const ctx = await requestScreeningContext(frameRef.current?.contentWindow);
      const loaded = await readHandwritingSession(ctx);
      if (cancelled) return;
      ctx.fingerprints = Object.fromEntries(await Promise.all(ctx.words.map(async word => [word.wordId, await computeFileFingerprint(new TextEncoder().encode(JSON.stringify([word.wordId, word.english, word.chinese])))])));
      if (cancelled) return;
      contextRef.current = ctx; current.current = loaded.answers;
      restoredTop.current = Math.min(Math.max(0, ctx.words.length - 1) * ROW_HEIGHT, initialHandwritingScroll(loaded.session, ctx.currentIndex));
      setView(previous => ({ ...previous, top: restoredTop.current })); setAnswers(loaded.answers); setContext(ctx);
      setMessage("识别：AI 识别并判断所有新答案。对照：显示已手写单词的标准汉语，供人工判断。");
    })().catch(error => { if (!cancelled) setMessage(error.message); });
    return () => {
      cancelled = true; mounted.current = false; controller.current?.abort(); classifications.current.forEach(pending => pending.abort());
      clearTimeout(scrollTimer.current); cancelAnimationFrame(scrollFrame.current);
    };
  }, [frameRef, route, reload]);
  useLayoutEffect(() => {
    if (!context || !scrollRef.current) return;
    const element = scrollRef.current; element.scrollTop = restoredTop.current;
    const resize = () => setView({ top: element.scrollTop, height: element.clientHeight });
    resize(); const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
  }, [context]);
  const onScroll = () => {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      if (scrollRef.current) setView({ top: scrollRef.current.scrollTop, height: scrollRef.current.clientHeight });
    });
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => savePosition().catch(() => setMessage("滚动位置保存失败，请重试保存")), 250);
  };
  const same = captured => mounted.current && !controller.current?.signal.aborted && captured.username === contextRef.current?.username
    && captured.sessionId === handwritingSessionId(contextRef.current) && getCurrentUsername() === captured.username
    && current.current[captured.wordId]?.revision === captured.revision && current.current[captured.wordId]?.inkFingerprint === captured.inkFingerprint;
  const applyVerdict = async (captured, verdict, reason) => {
    if (!same(captured)) return false;
    const result = { ...captured, verdict, reason, stale: false, classified: false };
    if (verdict !== "unsure") {
      const pending = new AbortController(); classifications.current.set(captured.wordId, pending);
      try { await classifyHandwriting(contextRef.current, result, { isCurrent: () => same(captured), signal: pending.signal }); result.classified = true; }
      finally { if (classifications.current.get(captured.wordId) === pending) classifications.current.delete(captured.wordId); }
    }
    if (!same(captured)) return false;
    // Only publish verdict fields: revealing reference answers during AI work
    // must not be overwritten by an earlier captured UI state.
    change(captured.wordId, { verdict, reason, stale: false, classified: result.classified });
    await saveTail.current; onUpdated?.(); return true;
  };
  async function recognize() {
    if (busyRef.current || !context) return;
    busyRef.current = true; setBusy(true); controller.current = new AbortController();
    try {
      setMessage("正在保存笔迹…"); await flushAll(); assertHandwritingAccount(context.username);
      const signal = controller.current.signal;
      const result = await runHandwritingWorkflow({ words: context.words, read: id => current.current[id], same, change, applyVerdict, signal,
        image: answer => loadHandwritingImage(context, answer), recognize: images => recognizeHandwriting({ username: context.username, signal, images }),
        compare: answers => compareHandwriting({ username: context.username, signal, answers }), onProgress: setMessage });
      if (!mounted.current || signal.aborted) return;
      await saveTail.current;
      const error = result.errors[0];
      setMessage(result.total ? `已完成 ${result.completed} 词，待复核 ${result.unsure} 词${error ? `，失败 ${result.errors.length} 词：${error.stage} · ${error.message}。可重试识别或点击对照人工判断。` : "。"}` : "没有新增或修改的答案；已完成的词不会重复识别。请先手写或输入中文。");
    } catch (error) { if (mounted.current) setMessage(`识别未完成：${error.message}。仍可点击对照人工判断。`); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function reveal() {
    if (!context) return;
    let warning = "";
    try { await flushAll(); } catch (error) { warning = `；保存尚未完成：${error.message}`; }
    if (!mounted.current || contextRef.current !== context) return;
    const written = context.words.filter(word => current.current[word.wordId]?.strokeCount > 0);
    written.forEach(word => change(word.wordId, { referenceVisible: true }));
    setMessage(written.length ? `已展示 ${written.length} 个已手写单词的标准汉语，请自行判断正确或错误${warning}。` : "尚无手写内容，写完后再点击对照。");
  }
  async function judge(wordId, verdict) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); controller.current = new AbortController();
    try {
      await flushAll(); const answer = current.current[wordId];
      if (!answer || (!answer.strokeCount && !answer.text?.trim())) { setMessage("请先填写答案"); return; }
      await applyVerdict(answer, verdict, "用户人工判断"); setMessage("已保存人工判断并更新本轮归类。");
    } catch (error) { setMessage(error.message); } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  const api = toolbarApis[active];
  const editInk = action => { if (api) Promise.resolve(api[action]?.()).catch(error => setMessage(error.message)); };
  const pen = useMemo(() => ({ tool, color, penSize, penMode, eraserMode, eraserSize }), [tool, color, penSize, penMode, eraserMode, eraserSize]);
  const words = context?.words || EMPTY;
  const indices = useMemo(() => {
    const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(words.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);
    const result = new Set(Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i));
    words.forEach((word, index) => { if (word.wordId === active || dirtyInk.has(word.wordId)) result.add(index); });
    return [...result].sort((a, b) => a - b);
  }, [words, view, active, dirtyInk]);
  const counts = words.reduce((acc, word) => { const answer = answers[word.wordId]; acc[answer?.stale || !answer?.verdict ? "pending" : answer.verdict]++; return acc; }, { correct: 0, wrong: 0, unsure: 0, pending: 0 });
  return <section className="vocab-handwriting" aria-label="手写筛选">
    <div className="vocab-handwriting-controls">
      <div><strong>{context?.listName || "手写筛选"}</strong><small>先回忆，再核对</small></div>
      <button disabled={!context || busy} onClick={recognize}>识别</button>
      <button disabled={!context} onClick={reveal}>对照</button>
      <span>正确 {counts.correct} · 错误 {counts.wrong} · 待处理 {counts.pending + counts.unsure}</span>
    </div>
    <div className="writing-ink-composer vocab-ink-toolbar-host">
      <AnnotationToolbar tool={tool} color={color} annotations={EMPTY} canUndo={Boolean(api?.canUndo)} canClear={Boolean(api?.canClear)} onTool={setTool} onColor={setColor}
        onUndo={() => editInk("undo")} onClear={() => editInk("clear")} clearLabel="清空当前单词笔迹" penSize={penSize} onPenSize={value => { setPenSize(value); setUserItem(PEN_SIZE_STORAGE_KEY, String(value)); }}
        penMode={penMode} eraserMode={eraserMode} eraserSize={eraserSize} onEraserMode={value => { setEraserMode(value); setUserItem("wuliao:pref:eraser-mode", value); }} onEraserSize={setEraserSize} tabletInk />
    </div>
    <div className="vocab-handwriting-message" role="status">{message}
      {!context && <button onClick={() => setReload(value => value + 1)}>重试</button>}
      {saveErrors > 0 && <button onClick={() => flushAll().then(() => setMessage("已保存")).catch(error => setMessage(error.message))}>重试保存</button>}
    </div>
    <div ref={scrollRef} className="vocab-handwriting-scroll" onScroll={onScroll}>
      <div className="vocab-handwriting-list" style={{ height: words.length * ROW_HEIGHT }}>
        {indices.map(index => <InkRow key={words[index].wordId} index={index} word={words[index]} context={context} answer={answers[words[index].wordId]} active={active === words[index].wordId}
          select={setActive} pen={pen} change={change} onInk={inkChange} onMutation={onMutation} onCount={onCount} register={register} onToolbar={onToolbar} onJudge={judge} onError={setMessage} />)}
      </div>
    </div>
  </section>;
}
