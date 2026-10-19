import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getUserItem, setUserItem } from "../userData.js";
import { onAppEvent } from "../events/appEvents.js";
import { AppEvent } from "../events/eventTypes.js";
import { registerPendingSave } from "../saveCoordinator.js";
import { useBackHandler } from "../ui/BackContext.jsx";
import { BACK_PRIORITY } from "../ui/backController.js";
import { AnnotationToolbar } from "../ui/AnnotationToolbar.jsx";
import WritingSplitWorkspace from "../writing/ui/WritingSplitWorkspace.jsx";
import WritingInkSurface from "../writing/WritingInkSurface.jsx";
import TranslationReviewCard from "../TranslationReviewCard.jsx";
import { isPhoneDevice } from "../inputDevicePolicy.js";
import { normalizePenSize, normalizePenMode, PEN_SIZE_STORAGE_KEY, PEN_MODE_STORAGE_KEY } from "../annotationTools.js";
import { beginAttempt, finishAttempt, listWarehouseSources, originalRecords, requeueSource } from "./service.js";
import { listAttempts, readAttempt, saveDraft } from "./repository.js";
import { SENTENCE_INK_PERSISTENCE, sentenceInkIdentity } from "./ink.js";
import "../writing/writing.css";
import "./sentenceReview.css";

const VIEW_KEY = "wuliao:sentence-review:view:v1";
const LAYOUT_KEY = "wuliao:pref:sentence-review-layout:v1";
function readView(username) {
  try { return JSON.parse(getUserItem(VIEW_KEY, username) || "{}"); } catch { return {}; }
}
function sourceLabel(source) {
  return [source.resourceTitle, source.articleLabel, Number.isFinite(source.paragraphNumber)
    ? `P${source.paragraphNumber} · S${source.sentenceIndex + 1}` : null].filter(Boolean).join(" · ");
}

function SentencePaper({ attempt, readOnly, disabled, flushRef, tools, onApi, onError, onStatus }) {
  const host = useRef(null), paper = useRef(null);
  const [width, setWidth] = useState(760);
  const size = attempt.layout;
  const identity = useMemo(() => sentenceInkIdentity(attempt), [attempt.id, attempt.username]);
  const regions = useMemo(() => [{ pageId: "sentence-paper", ref: paper }], []);
  const errorRef = useRef(onError); errorRef.current = onError;
  useEffect(() => {
    let alive = true;
    const observer = new ResizeObserver(entries => {
      const next = Math.max(180, entries[0].contentRect.width);
      Promise.resolve(flushRef.current?.()).then(() => { if (alive) setWidth(next); }).catch(error => errorRef.current(error));
    });
    observer.observe(host.current);
    return () => { alive = false; observer.disconnect(); };
  }, []);
  const scale = Math.min(1, width / size.width);
  return <div ref={host} className="sr-paper-host" style={{ height: size.height * scale }}>
    <div className="sr-paper-scale" style={{ width: size.width, transform: `scale(${scale})` }}>
      <WritingInkSurface {...identity} persistence={SENTENCE_INK_PERSISTENCE} logicalSize={size}
        readOnly={readOnly} disabled={disabled} pageRegions={regions} {...tools} ariaLabel="重难句复盘手写区"
        clearConfirmation="清空本轮复盘笔迹？其他轮次、原精读笔迹和文字译文会保留。"
        onFlushHandleChange={handle => { flushRef.current = handle; }} onToolbarApiChange={onApi} onError={onError} onStatusChange={onStatus}>
        <div ref={paper} className="sr-paper" style={{ width: size.width, height: size.height }}>
          <span>我的翻译与结构笔记 · 第 {attempt.round} 轮</span><div className="sr-paper-lines" />
        </div>
      </WritingInkSurface>
    </div>
  </div>;
}

function SentenceWorkspace({ username, source, queue, onOpen, onList, onChanged }) {
  const [attempt, setAttempt] = useState(null), attemptRef = useRef(null);
  const [history, setHistory] = useState([]), [historyId, setHistoryId] = useState("");
  const historyRef = useRef(""); historyRef.current = historyId;
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [translation, setTranslation] = useState(""), [checked, setChecked] = useState(false);
  const [mode, setMode] = useState(isPhoneDevice() ? "typed" : "handwriting");
  const [layout, setLayout] = useState(() => getUserItem(LAYOUT_KEY, username) === "stacked" ? "stacked" : "split");
  const draft = useRef({ userTranslation: "", checked: false, inputMode: mode });
  const saving = useRef(Promise.resolve()), inkFlush = useRef(null);
  const alive = useRef(true);
  const [api, setApi] = useState(null), [tool, setTool] = useState("pen"), [color, setColor] = useState("#173a62");
  const [penSize, setPenSize] = useState(() => normalizePenSize(getUserItem(PEN_SIZE_STORAGE_KEY, username)));
  const [penMode] = useState(() => normalizePenMode(getUserItem(PEN_MODE_STORAGE_KEY, username)));
  const [eraserMode, setEraserMode] = useState("normal"), [eraserSize, setEraserSize] = useState(24);
  const tools = { tool, color, penSize, penMode, eraserMode, eraserSize };

  function applyAttempt(value) {
    attemptRef.current = value; setAttempt(value);
    draft.current = { userTranslation: value?.userTranslation || "", checked: Boolean(value?.checked), inputMode: value?.inputMode || (isPhoneDevice() ? "typed" : "handwriting") };
    setTranslation(draft.current.userTranslation); setChecked(draft.current.checked); setMode(draft.current.inputMode);
  }
  const flush = useCallback(() => {
    const job = saving.current.catch(() => {}).then(async () => {
      if (!attemptRef.current || attemptRef.current.status !== "draft" || historyRef.current) return;
      await inkFlush.current?.();
      const current = attemptRef.current, patch = { ...draft.current };
      if (current.userTranslation === patch.userTranslation && current.checked === patch.checked && current.inputMode === patch.inputMode) return;
      const saved = await saveDraft(username, current, patch);
      attemptRef.current = saved;
      if (alive.current) { setAttempt(saved); setNotice("已保存"); }
    });
    saving.current = job;
    return job;
  }, [username]);
  useEffect(() => registerPendingSave(flush), [flush]);
  useEffect(() => {
    alive.current = true;
    let active = true;
    (async () => {
      const records = await listAttempts(username, source.sourceReviewId);
      const value = source.section === "learned" || source.status !== "resolved" ? records[0] || null
        : await beginAttempt(username, source, isPhoneDevice() ? "typed" : "handwriting");
      if (active) { setHistory(records); applyAttempt(value); }
    })().catch(reason => { if (active) setError(reason.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; alive.current = false; };
  }, [username, source.sourceReviewId]);
  useEffect(() => {
    const timer = setTimeout(() => flush().catch(reason => { if (alive.current) { setError(reason.message); setNotice("保存失败"); } }), 450);
    return () => clearTimeout(timer);
  }, [translation, checked, mode, flush]);

  async function run(action) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (reason) {
      if (alive.current) {
        setError(reason.message || "操作失败，请重试");
        if (attemptRef.current) {
          try { const value = await readAttempt(username, attemptRef.current.id); attemptRef.current = value; setAttempt(value); } catch { /* Preserve current draft if storage is unavailable. */ }
        }
      }
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  const back = () => run(async () => { await flush(); onList(); });
  useBackHandler(() => { back(); return true; }, { enabled: true, priority: BACK_PRIORITY.temporary, key: source.sourceReviewId });
  const viewed = historyId ? history.find(item => item.id === historyId) : attempt;
  const readOnly = Boolean(historyId) || viewed?.status !== "draft" || source.status !== "resolved";
  const currentIndex = queue.indexOf(source.sourceReviewId);
  const showRecords = Boolean(checked || (historyId && viewed?.checked));
  const comparison = useMemo(() => showRecords ? originalRecords(viewed?.source || source, username) : null,
    [showRecords, viewed?.id, source.sourceReviewId, username]);
  const loadNewRound = () => run(async () => {
    await flush();
    const pending = await requeueSource(username, source);
    setHistoryId(""); historyRef.current = "";
    const next = await beginAttempt(username, pending, isPhoneDevice() ? "typed" : "handwriting");
    applyAttempt(next); setHistory(await listAttempts(username, source.sourceReviewId)); onChanged();
  });
  async function judge(verdict) {
    await flush();
    const saved = await finishAttempt(username, attemptRef.current.id, verdict);
    applyAttempt(saved); setHistory(await listAttempts(username, source.sourceReviewId));
    setNotice(verdict === "mastered" ? "已进入已复盘" : "已保存，3 天后复查"); onChanged();
  }
  return <main className="sentence-review-workspace writing-workspace writing-stage is-compact-workspace" data-testid="sentence-review-workspace">
    <header className="sr-workspace-header">
      <button type="button" onClick={back} disabled={busy}>← 仓库</button>
      <span className="sr-position">第 {Math.max(1, currentIndex + 1)} / {queue.length || 1} 句</span>
      <span className="sr-save-state" role="status">{busy ? "正在处理…" : notice}</span>
      <div className="sr-header-actions">
        <button type="button" disabled={busy || currentIndex <= 0} onClick={() => run(async () => { await flush(); onOpen(queue[currentIndex - 1]); })}>上一句</button>
        <button type="button" disabled={busy || currentIndex < 0 || currentIndex >= queue.length - 1} onClick={() => run(async () => { await flush(); onOpen(queue[currentIndex + 1]); })}>下一句</button>
        <button type="button" aria-label="切换双区布局" onClick={() => run(async () => { await flush(); const next = layout === "split" ? "stacked" : "split"; setUserItem(LAYOUT_KEY, next, username); setLayout(next); })}>{layout === "split" ? "上下布局" : "左右布局"}</button>
      </div>
    </header>
    {error && <div className="sr-error" role="alert">{error}<button type="button" onClick={() => run(flush)}>重试保存</button></div>}
    {!readOnly && mode === "handwriting" && <div className="sr-toolbar writing-ink-composer" inert={busy}><AnnotationToolbar {...tools} annotations={[]} onTool={setTool} onColor={setColor}
      onPenSize={value => { setPenSize(value); setUserItem(PEN_SIZE_STORAGE_KEY, String(value), username); }}
      onEraserMode={setEraserMode} onEraserSize={setEraserSize} onUndo={() => api?.undo()} onClear={() => api?.clear()}
      canUndo={api?.canUndo || false} canClear={api?.canClear || false} clearLabel="清空本轮笔迹" tabletInk /></div>}
    {loading ? <p role="status">正在读取复盘记录…</p> : <WritingSplitWorkspace stage="sentence-review" username={username} layout={layout}
      preferencePrefix="wuliao:pref:sentence-review" documentHeight={1000} sourceLabel="英文原句" workLabel="我的复盘"
      sourcePane={<div className="sr-source"><small>{sourceLabel(source)}</small><p className="sr-source-text" lang="en">{source.text || viewed?.source.text || "原句暂不可用"}</p>
        {source.error && <p className="sr-source-warning">{source.error}</p>}
        {(source.paragraphText || viewed?.source.paragraphText) && <details><summary>展开所在段落</summary><p lang="en">{source.paragraphText || viewed.source.paragraphText}</p></details>}
        <button type="button" disabled={busy} onClick={() => {
          if (historyId) { setChecked(true); return; }
          draft.current.checked = true; setChecked(true);
        }}>查看原记录</button>
        {(showRecords || (historyId && checked)) && <div className="sr-original-records">
          <h3>上次笔译</h3><p>{comparison?.translation || "没有已保存的文字笔译。若原来只保留了手写笔迹，此处不自动识别。"}</p>
          <h3>历史批改</h3>{comparison?.reviews.length ? comparison.reviews.map(record => <details key={record.id}><summary>{new Date(record.updatedAt).toLocaleString()} · 已有批改</summary><TranslationReviewCard result={record.result} userTranslation={record.userTranslation} cached /></details>) : <p>没有可匹配的已保存批改。</p>}
        </div>}
      </div>}
      workActions={<div className="sr-input-modes" role="group" aria-label="复盘输入方式">{["handwriting", "typed"].map(value => <button type="button" key={value} aria-pressed={mode === value} disabled={busy || readOnly || value === "handwriting" && isPhoneDevice()}
        onClick={() => run(async () => { await flush(); draft.current.inputMode = value; setMode(value); })}>{value === "handwriting" ? "手写" : "键盘输入"}</button>)}</div>}
      workPane={<>
        {viewed ? ((historyId ? viewed.inputMode : mode) === "typed" ? <textarea className="sr-translation" aria-label="我的复盘译文" value={historyId ? viewed.userTranslation : translation} readOnly={readOnly || busy} placeholder="写下你对原句的翻译和结构理解" onChange={event => { draft.current.userTranslation = event.target.value; setTranslation(event.target.value); setNotice("待保存"); }} />
          : <SentencePaper key={viewed.id} attempt={viewed} readOnly={readOnly} disabled={busy} tools={tools} flushRef={inkFlush} onApi={setApi}
            onStatus={state => setNotice(state.status === "ok" ? "已保存" : state.status === "missing" ? "已就绪" : state.dirty ? "正在保存笔迹…" : "")}
            onError={reason => setError(reason.message || "笔迹保存失败")} />)
          : <p className="sr-empty-record">此原句已有复习凭据，尚无仓库练习。可查看原记录，或重新加入复盘。</p>}
      </>} />}
    <footer className="sr-review-footer">
      {history.length > 0 && <label className="sr-history-picker">练习记录<select aria-label="查看练习记录" value={historyId} disabled={busy} onChange={event => { const id = event.target.value; run(async () => { await flush(); setHistoryId(id); }); }}>
        <option value="">本轮练习</option>{history.filter(item => item.id !== attempt?.id).map(item => <option key={item.id} value={item.id}>第 {item.round} 轮 · {new Date(item.createdAt).toLocaleDateString()} · {item.verdict === "mastered" ? "已理解" : item.verdict === "difficult" ? "仍困难" : "草稿"}</option>)}
      </select></label>}
      <div className="sr-verdict-actions">
        {source.section === "learned" && <button type="button" disabled={busy || source.status !== "resolved"} onClick={loadNewRound}>重新加入复盘</button>}
        {attempt?.status === "completed" && !historyId && <span>{attempt.verdict === "mastered" ? "本轮：现在能独立理解" : "本轮：仍需复盘 · 3 天后复查"}</span>}
        {attempt && attempt.status !== "completed" && !historyId && <>
          <button type="button" disabled={busy || source.status !== "resolved" || attempt.status === "committing" && attempt.verdict !== "difficult"} onClick={() => run(() => judge("difficult"))}>{attempt.status === "committing" && attempt.verdict === "difficult" ? "重试保存结果" : "仍需复盘"}</button>
          <button type="button" className="sr-primary" disabled={busy || source.status !== "resolved" || attempt.status === "committing" && attempt.verdict !== "mastered"} onClick={() => run(() => judge("mastered"))}>{attempt.status === "committing" && attempt.verdict === "mastered" ? "重试保存结果" : "现在能独立理解"}</button>
        </>}
      </div>
    </footer>
  </main>;
}

export default function SentenceReviewPage({ username, sourceId, onOpenSource, onBack }) {
  const saved = useMemo(() => readView(username), [username]);
  const [section, setSection] = useState(saved.section === "learned" ? "learned" : "pending");
  const [query, setQuery] = useState(saved.query || ""), [resourceId, setResourceId] = useState(saved.resourceId || "");
  const [limit, setLimit] = useState(20), [queue, setQueue] = useState(Array.isArray(saved.queue) ? saved.queue : []);
  const [sources, setSources] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [reload, setReload] = useState(0), generation = useRef(0), list = useRef(null), scroll = useRef(saved.scroll || 0);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  useEffect(() => {
    let timer;
    const update = () => { clearTimeout(timer); timer = setTimeout(refresh, 100); };
    const unsubscribes = [AppEvent.LEARNING_STATE_INVALIDATED, AppEvent.REVIEW_TASKS_UPDATED].map(event => onAppEvent(event, update));
    return () => { clearTimeout(timer); unsubscribes.forEach(off => off()); };
  }, [refresh]);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    listWarehouseSources({ username, signal: controller.signal }).then(items => {
      if (generation.current === current) { setSources(items); setError(""); }
    }).catch(reason => { if (!controller.signal.aborted && generation.current === current) setError(reason.message); })
      .finally(() => { if (generation.current === current) setLoading(false); });
    return () => { ++generation.current; controller.abort(); };
  }, [username, reload]);
  const filtered = useMemo(() => sources.filter(source => source.section === section && (!resourceId || source.resourceId === resourceId)
    && `${source.text} ${source.resourceTitle} ${source.articleLabel}`.toLowerCase().includes(query.trim().toLowerCase())), [sources, section, resourceId, query]);
  useEffect(() => { setLimit(20); }, [section, query, resourceId]);
  useEffect(() => { setUserItem(VIEW_KEY, JSON.stringify({ section, query, resourceId, queue, scroll: scroll.current }), username); }, [username, section, query, resourceId, queue, sourceId]);
  useLayoutEffect(() => { if (!sourceId && list.current) list.current.scrollTop = scroll.current; }, [sourceId, loading]);
  const activeSource = sources.find(source => source.sourceReviewId === sourceId);
  const resources = [...new Map(sources.map(source => [source.resourceId, source.resourceTitle])).entries()];
  if (sourceId && activeSource) return <SentenceWorkspace key={`${username}:${sourceId}`} username={username} source={activeSource}
    queue={queue.includes(sourceId) ? queue : [sourceId]} onOpen={onOpenSource} onList={() => { refresh(); onOpenSource(""); }} onChanged={refresh} />;
  if (sourceId) return <main className="sentence-review-page"><button type="button" onClick={() => onOpenSource("")}>← 仓库</button><p role={error ? "alert" : "status"}>{error || (loading ? "正在定位原句…" : "当前账号没有这句的可验证记录，原有数据保持保留。")}</p></main>;
  return <main className="sentence-review-page" data-testid="sentence-library">
    <header className="sr-library-header"><button type="button" onClick={onBack}>← 返回</button><h1>重难句仓库</h1><span>{sources.length} 句</span></header>
    <div className="sr-library-controls"><div className="sr-tabs" role="tablist" aria-label="复盘状态">{[["pending", "需复盘"], ["learned", "已复盘"]].map(([id, label]) => <button type="button" key={id} role="tab" aria-selected={section === id} onClick={() => { scroll.current = 0; setSection(id); }}>{label}<span>{sources.filter(source => source.section === id).length}</span></button>)}</div>
      <input type="search" aria-label="搜索重难句" placeholder="搜索句子或资料名称" value={query} onChange={event => { scroll.current = 0; setQuery(event.target.value); }} />
      <select aria-label="筛选来源资料" value={resourceId} onChange={event => { scroll.current = 0; setResourceId(event.target.value); }}><option value="">全部资料</option>{resources.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
    </div>
    {error && <p className="sr-error" role="alert">{error}<button onClick={refresh}>重试读取</button></p>}
    <div className="sr-sentence-list" ref={list} onScroll={event => { scroll.current = event.currentTarget.scrollTop; }}>
      {loading && <p role="status">正在汇总已标记的原句…</p>}
      {!loading && !filtered.length && <div className="sr-empty"><h2>{sources.length ? "没有符合条件的句子" : "还没有收录的重难句"}</h2><p>{sources.length ? "试试其他资料或搜索词。" : "在精读中将原句标记为“需复盘”，这里会自动收录。"}</p></div>}
      {filtered.slice(0, limit).map(source => <button type="button" className="sr-sentence-card" key={source.sourceReviewId} onClick={() => { setQueue(filtered.map(item => item.sourceReviewId)); onOpenSource(source.sourceReviewId); }}>
        <span className="sr-card-meta">{sourceLabel(source)}{source.dueDate && source.section === "pending" && <span>复查 {source.dueDate}</span>}</span>
        <span className="sr-card-text" lang="en">{source.text || "原句暂不可用"}</span>
        <span className="sr-card-footer">{source.status !== "resolved" ? source.error : source.section === "learned" ? `已复盘 · ${new Date(source.learnedAt).toLocaleDateString()}` : "点击进入复盘"}<span aria-hidden="true">→</span></span>
      </button>)}
      {filtered.length > limit && <button type="button" className="sr-load-more" onClick={() => setLimit(value => value + 20)}>再显示 20 句（已显示 {limit} / {filtered.length}）</button>}
    </div>
  </main>;
}
