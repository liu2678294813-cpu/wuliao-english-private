import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentUsername, getUserItem, setUserItem } from "../userData.js";
import { isLongSentenceStorageAvailable, listUnknownWords } from "../storage.js";
import { useSaveBoundary } from "../useSaveBoundary.js";
import { useBackHandler } from "../ui/BackContext.jsx";
import { AnnotationToolbar } from "../ui/AnnotationToolbar.jsx";
import WritingInkSurface from "../writing/WritingInkSurface.jsx";
import { sentenceTextFingerprint } from "../translationProgress.js";
import { aggregateSelectedWords, groupSourcesTree, listDifficultSources, listLearnedSources, selectionState } from "./source.js";
import { LONG_SENTENCE_INK_PERSISTENCE, longSentenceInkIdentity } from "./ink.js";
import * as repository from "./repository.js";
import "./longSentence.css";

const TABS = ["生成训练", "待掌握", "待复习", "已学习", "学习记录"];
const SELECTION_KEY = "wuliao:long-sentence:selection";
const safeSelection = () => { try { return JSON.parse(getUserItem(SELECTION_KEY) || "null") || {}; } catch { return {}; } };

function SelectBox({ entries, selected, onChange, children }) {
  const input = useRef(null);
  const state = selectionState(entries, selected);
  useEffect(() => { if (input.current) input.current.indeterminate = state.indeterminate; }, [state.indeterminate]);
  return <label className="ls-select-label"><input ref={input} type="checkbox" checked={state.checked} aria-checked={state.indeterminate ? "mixed" : state.checked} disabled={!entries.length} onChange={() => onChange(entries, !state.checked)} />{children}</label>;
}

function SourceTree({ sources, selected, onChange }) {
  return <div className="ls-source-tree">{groupSourcesTree(sources).map(chapter => {
    const articles = chapter.sections.flatMap(section => section.articles.map(article => ({ ...article, label: `${section.label} · ${article.label}` })));
    const entries = articles.flatMap(article => article.sentences).filter(source => source.status === "resolved");
    return <details key={chapter.id} open><summary><SelectBox entries={entries} selected={selected} onChange={onChange}>{chapter.label}</SelectBox></summary>
      {articles.map(article => <details key={article.id} open className="ls-article"><summary><SelectBox entries={article.sentences.filter(source => source.status === "resolved")} selected={selected} onChange={onChange}>{article.label}</SelectBox></summary>
        {article.text && <details className="ls-full-text"><summary>展开全文</summary><p>{article.text}</p></details>}
        {article.sentences.map(source => <label key={source.sourceReviewId} className="ls-source-row"><input data-testid="long-sentence-source-checkbox" type="checkbox" checked={selected.includes(source.sourceReviewId)} disabled={source.status !== "resolved"} onChange={event => onChange([source], event.target.checked)} /><span>{source.text || "原句暂不可用"}{source.status !== "resolved" && <small role="status">{source.error || "来源文本已变化，请在精读中确认"}</small>}</span></label>)}
      </details>)}
    </details>;
  })}</div>;
}

function SentencePaper({ session, item, attempt, readOnly, onError, onLayout, flushRef }) {
  const username = getCurrentUsername();
  const hostRef = useRef(null);
  const pageRef = useRef(null);
  const [availableWidth, setAvailableWidth] = useState(760);
  const [api, setApi] = useState(null);
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState("#173a62");
  const [penSize, setPenSize] = useState(2.6);
  const [eraserMode, setEraserMode] = useState("normal");
  const [eraserSize, setEraserSize] = useState(24);
  const layout = attempt.layout || { width: 760, height: 560, version: 1 };
  const scale = Math.min(1, availableWidth / layout.width);
  const identity = useMemo(() => longSentenceInkIdentity({ username, sessionId: session.id, itemId: item.id, attemptId: attempt.id, sourceFingerprint: sentenceTextFingerprint(item.text) }), [username, session.id, item.id, attempt.id, item.text]);
  const regions = useMemo(() => [{ pageId: `long-sentence:${item.id}`, ref: pageRef }], [item.id]);
  useEffect(() => {
    let mounted = true;
    const observer = new ResizeObserver(entries => {
      const next = Math.max(200, entries[0].contentRect.width);
      Promise.resolve(readOnly ? null : flushRef.current?.()).then(() => { if (mounted) setAvailableWidth(next); }).catch(onError);
    });
    if (hostRef.current) observer.observe(hostRef.current);
    return () => { mounted = false; observer.disconnect(); };
  }, []);
  useEffect(() => {
    if (readOnly || attempt.layout) return;
    const width = Math.min(760, Math.max(280, hostRef.current?.clientWidth || 760));
    const height = Math.max(560, Math.ceil(item.text.length * 13 / (width - 72)) * 44 + 400);
    onLayout({ width, height, version: 1 });
  }, [attempt.id, readOnly, Boolean(attempt.layout)]);
  return <div className="ls-paper-workspace">
    {!readOnly && <AnnotationToolbar annotations={[]} tool={tool} color={color} onTool={setTool} onColor={setColor} penSize={penSize} onPenSize={setPenSize} eraserMode={eraserMode} onEraserMode={setEraserMode} eraserSize={eraserSize} onEraserSize={setEraserSize} onUndo={() => api?.undo()} onClear={() => api?.clear()} canUndo={api?.canUndo || false} canClear={api?.canClear || false} clearLabel="清空笔迹" tabletInk stageHint="直接在句纸上划分主干" />}
    <div ref={hostRef} className="ls-paper-host" style={{ height: layout.height * scale }}><div className="ls-paper-scale" style={{ width: layout.width, transform: `scale(${scale})`, transformOrigin: "top left" }}>
      <WritingInkSurface key={attempt.id} {...identity} persistence={LONG_SENTENCE_INK_PERSISTENCE} logicalSize={layout} pageRegions={regions} tool={tool} color={color} penSize={penSize} eraserMode={eraserMode} eraserSize={eraserSize} readOnly={readOnly || !attempt.layout} ariaLabel="长难句句纸手写" clearConfirmation="清空这次作答的笔迹？译文和训练记录会保留。" onToolbarApiChange={setApi} onFlushHandleChange={handle => { flushRef.current = handle; }} onError={onError}>
        <div ref={pageRef} className="ls-paper" style={{ width: layout.width, height: layout.height }}><p lang="en" data-testid="long-sentence-sentence">{item.text}</p><div className="ls-paper-lines" aria-hidden="true" /></div>
      </WritingInkSurface>
    </div></div>
  </div>;
}

function EvaluationView({ record, onFeedback, onReanalyze, busy }) {
  const evaluation = record.evaluation;
  if (!evaluation) return null;
  const structure = evaluation.canonicalStructure;
  const categories = [["结构理解", "structuralUnderstandingErrors"], ["词义", "wordMeaningErrors"], ["逻辑关系", "logicalRelationErrors"], ["中文表达", "chineseExpressionIssues"]];
  return <section data-testid="long-sentence-evaluation" className="ls-card ls-evaluation"><h3>AI 参考解析</h3>
    <p className="ls-muted">解析可能存在错误。请结合原句判断，训练自评单独保存。</p>
    <h4>参考译文</h4><p>{evaluation.referenceTranslation}</p>
    <h4>句子结构</h4><dl>{[["主句", structure.mainClause], ["主语", structure.subject], ["谓语", structure.predicate], ["宾语／补语", structure.objectOrComplement]].filter(([,text]) => text).map(([label,text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>
    {[...["clauses", "modifiers", "logicalRelations"].flatMap(key => structure[key] || [])].map((text,index) => <p key={index}>{text}</p>)}
    {!!evaluation.vocabularyNotes?.length && <><h4>词汇</h4>{evaluation.vocabularyNotes.map((word,index) => <p key={index}><strong>{word.word}</strong>：{word.meaning}</p>)}</>}
    <h4>译文反馈</h4>{categories.map(([label,key]) => evaluation.translationEvaluation[key]?.length ? <div key={key}><strong>{label}</strong>{evaluation.translationEvaluation[key].map((issue,index) => <p key={index}><span className="ls-severity">{issue.severity === "major" ? "重大" : "次要"}</span>{issue.excerpt && `「${issue.excerpt}」`}{issue.explanation}</p>)}</div> : null)}
    {evaluation.translationEvaluation.correctPoints?.map((point,index) => <p key={`correct-${index}`}>✓ {point}</p>)}
    {evaluation.translationEvaluation.nextTrainingFocus?.map((point,index) => <p key={`focus-${index}`}>下次关注：{point}</p>)}
    <div className="ls-actions"><button type="button" disabled={busy || record.analysisFeedback === "incorrect"} onClick={onFeedback}>{record.analysisFeedback === "incorrect" ? "已标记解析有误" : "解析有误"}</button><button type="button" disabled={busy} onClick={onReanalyze}>重新解析</button></div>
  </section>;
}

function HistoryAttemptView({ session, item, attempt, evaluations, onError, onClose }) {
  const historyFlushRef = useRef(null);
  return <section className="ls-card ls-history-detail" aria-label="历史作答详情">
    <div className="ls-actions"><h3>历史作答</h3><button type="button" onClick={onClose}>收起详情</button></div>
    <p className="ls-muted">{new Date(attempt.createdAt).toLocaleString()} · {attempt.userRating === "mastered" ? "已掌握" : attempt.userRating === "difficult" ? "仍困难" : "尚未自评"}</p>
    <SentencePaper key={attempt.id} session={session} item={item} attempt={attempt} readOnly onError={onError} onLayout={() => {}} flushRef={historyFlushRef} />
    <h4>当时的译文</h4><p>{attempt.userTranslation || "未填写译文"}</p>
    {evaluations.length > 0 && <div><h4>当时的 AI 参考解析</h4>{evaluations.map(record => <details key={record.id} className="ls-card"><summary>版本 {record.evaluationVersion} · {new Date(record.createdAt).toLocaleString()}{record.analysisFeedback === "incorrect" ? " · 已标记解析有误" : ""}</summary><p>{record.evaluation?.referenceTranslation || ""}</p><pre>{JSON.stringify(record.evaluation, null, 2)}</pre></details>)}</div>}
  </section>;
}

export default function LongSentencePage({ sessionId, onOpenSession, onCloseSession, originContext, onReturnToReader, onStartOriginalReview, onOpenAiSettings }) {
  const username = getCurrentUsername();
  const initial = useMemo(safeSelection, [username]);
  const [tab, setTab] = useState("生成训练");
  const [sources, setSources] = useState([]);
  const [learned, setLearned] = useState([]);
  const [unknownWords, setUnknownWords] = useState([]);
  const [selected, setSelected] = useState(initial.selected || []);
  const [deselectedWords, setDeselectedWords] = useState(initial.deselectedWords || []);
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [count, setCount] = useState(initial.count || 5);
  const [dueSkills, setDueSkills] = useState([]);
  const [dueCount, setDueCount] = useState(0);
  const [records, setRecords] = useState([]);
  const [offset, setOffset] = useState(0);
  const [bundle, setBundle] = useState(null);
  const [historyAttemptId, setHistoryAttemptId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [configureAi, setConfigureAi] = useState(false);
  const [translation, setTranslation] = useState("");
  const bundleRef = useRef(null);
  const translationRef = useRef("");
  const inkFlush = useRef(null);
  const queue = useRef(Promise.resolve());
  const lock = useRef(false);
  const alive = useRef(true);
  const saveTimer = useRef(null);
  const service = useMemo(() => {
    let instance;
    const ready = import("./ai.js").then(module => { instance = module.createLongSentenceAiService(); return instance; });
    return { generate: async input => (await ready).generate(input), evaluate: async input => (await ready).evaluate(input), cancelAll: () => instance?.cancelAll() };
  }, [username]);
  const selectionRef = useRef({ selected, deselectedWords, count });
  selectionRef.current = { selected, deselectedWords, count };
  const currentItem = bundle?.items[bundle.session.currentItemIndex || 0] || null;
  const currentAttempt = bundle?.attempts.find(attempt => attempt.id === currentItem?.attemptId) || null;
  const evaluations = bundle?.evaluations.filter(record => record.attemptId === currentAttempt?.id) || [];
  const latestEvaluation = evaluations.at(-1);
  const historyEntries = useMemo(() => {
    if (!bundle) return [];
    const allItems = bundle.allItems || [...(bundle.items || []), ...(bundle.historyItems || [])];
    const byId = new Map(allItems.map(item => [item.id, item]));
    const activeAttemptIds = new Set((bundle.items || []).map(item => item.attemptId));
    const activeItemIds = new Set((bundle.items || []).map(item => item.id));
    return (bundle.attempts || []).filter(attempt => !activeAttemptIds.has(attempt.id)).map(attempt => ({
      attempt, item: byId.get(attempt.itemId), replaced: !activeItemIds.has(attempt.itemId),
    })).filter(entry => entry.item).sort((a, b) => (b.attempt.createdAt || 0) - (a.attempt.createdAt || 0));
  }, [bundle]);
  const selectedHistory = historyEntries.find(entry => entry.attempt.id === historyAttemptId) || null;
  const words = useMemo(() => aggregateSelectedWords(unknownWords, sources, selected), [unknownWords, sources, selected]);
  const selectedWords = words.filter(word => !deselectedWords.includes(word.wordId));
  const available = isLongSentenceStorageAvailable();
  const applyBundle = useCallback(value => { bundleRef.current = value; setBundle(value); }, []);
  const showError = useCallback(reason => { if (!alive.current) return; setError(reason?.message || String(reason)); }, []);
  const enqueue = useCallback(work => {
    const next = queue.current.catch(() => {}).then(work);
    queue.current = next;
    return next;
  }, []);
  const saveDraft = useCallback(() => enqueue(async () => {
    const value = bundleRef.current;
    const item = value?.items[value.session.currentItemIndex || 0];
    const attempt = value?.attempts.find(entry => entry.id === item?.attemptId);
    if (!attempt || attempt.submittedAt || attempt.userTranslation === translationRef.current) return;
    const saved = await repository.saveAttempt({ sessionId: value.session.id, itemId: item.id, attemptId: attempt.id, expectedVersion: attempt.version, patch: { userTranslation: translationRef.current } });
    applyBundle({ ...value, attempts: value.attempts.map(entry => entry.id === saved.id ? saved : entry) });
  }), [enqueue, applyBundle]);
  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const selection = JSON.stringify(selectionRef.current);
    setUserItem(SELECTION_KEY, selection);
    if (getUserItem(SELECTION_KEY) !== selection) throw new Error("训练选择未能保存，请重试");
    await inkFlush.current?.();
    await saveDraft();
    await queue.current;
  }, [saveDraft]);
  useSaveBoundary(flush);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(saveTimer.current); service.cancelAll(); };
  }, [service]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    Promise.all([listDifficultSources({ signal: controller.signal }), listUnknownWords()]).then(([sourceList,wordList]) => {
      if (cancelled) return;
      setSources(sourceList); setUnknownWords(wordList);
      if (!initial.selected?.length && originContext?.resourceId) setSelected(sourceList.filter(source => source.status === "resolved" && source.resourceId === originContext.resourceId && (!originContext.passageId || source.passageId === originContext.passageId)).map(source => source.sourceReviewId));
    }).catch(showError).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [username]);
  useEffect(() => {
    let cancelled = false;
    setError("");
    if (!sessionId) { service.cancelAll(); applyBundle(null); setHistoryAttemptId(""); translationRef.current = ""; setTranslation(""); return; }
    if (bundleRef.current?.session.id === sessionId) return;
    setHistoryAttemptId("");
    service.cancelAll();
    setLoading(true);
    repository.loadSession(sessionId).then(value => {
      if (cancelled) return;
      if (!value?.session) throw new Error("训练记录不存在或不属于当前账号");
      applyBundle(value);
      const item = value.items[value.session.currentItemIndex || 0];
      const attempt = value.attempts.find(entry => entry.id === item?.attemptId);
      translationRef.current = attempt?.userTranslation || ""; setTranslation(translationRef.current);
    }).catch(showError).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, username]);
  useEffect(() => {
    if (sessionId) return;
    let cancelled = false;
    if (tab === "学习记录") repository.listSessions({ offset, limit: 20 }).then(value => { if (!cancelled) setRecords(value); }).catch(showError);
    if (tab === "已学习") listLearnedSources().then(value => { if (!cancelled) setLearned(value); }).catch(showError);
    if (tab === "待复习") Promise.all([repository.listDueSkills({ offset, limit: 20 }), repository.countDueSkills()]).then(([value, total]) => { if (!cancelled) { setDueSkills(value); setDueCount(total); } }).catch(showError);
    return () => { cancelled = true; };
  }, [tab, offset, sessionId]);
  const run = async action => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice(""); setConfigureAi(false);
    try { await action(); }
    catch (reason) {
      if (reason?.name !== "AbortError") {
        const { classifyLongSentenceAiError } = await import("./ai.js");
        const info = classifyLongSentenceAiError(reason);
        setError(reason?.code || reason?.status ? info.message : reason.message || info.message);
        setConfigureAi(info.configureAi);
      }
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const selectSources = (entries, checked) => setSelected(previous => [...new Set(checked ? [...previous, ...entries.map(source => source.sourceReviewId)] : previous.filter(id => !entries.some(source => source.sourceReviewId === id)))]);
  const closeSession = () => run(async () => { await flush(); onCloseSession(); });
  useBackHandler(() => { if (!sessionId) return false; if (historyAttemptId) { setHistoryAttemptId(""); return true; } closeSession(); return true; }, { enabled: Boolean(sessionId), priority: 100, key: sessionId });

  async function generate({ skill = null, extraPractice = false, replacement = false, supplement = false } = {}) {
    if (!navigator.onLine) throw Object.assign(new Error("当前离线，可继续编辑已保存的草稿"), { code: "offline" });
    await flush();
    let value = bundleRef.current;
    if (!replacement && !supplement) {
      const selectedSources = skill?.sources || sources.filter(source => source.status === "resolved" && selected.includes(source.sourceReviewId));
      if (!selectedSources.length) throw new Error("请至少选择一个可用的困难原句");
      const session = await repository.createSession({ sources: selectedSources, words: skill?.words || selectedWords, count: skill ? 1 : Number(count), originContext, skillId: skill?.id, extraPractice });
      value = { session, items: [], attempts: [], evaluations: [] };
      applyBundle(value); await onOpenSession(session.id);
    }
    const session = value.session;
    const fresh = await listDifficultSources();
    const learnedSources = await listLearnedSources();
    for (const source of session.sources) {
      const current = [...fresh, ...learnedSources].find(candidate => candidate.sourceReviewId === source.sourceReviewId);
      if (!current || current.status !== "resolved" || current.textFingerprint !== source.textFingerprint) throw new Error("训练来源已变化或无法定位，请在原资料中检查后再生成");
    }
    const currentSkill = skill || (session.skillId ? await repository.getSkill(session.skillId) : null);
    if (session.skillId && !currentSkill) throw new Error("技能记录暂不可用，请重新打开训练");
    const requestVersion = (session.requestVersion || 0) + 1;
    const savedSession = await repository.updateSession({ sessionId: session.id, expectedRequestVersion: session.requestVersion, patch: { requestVersion, status: "generating" } });
    applyBundle({ ...value, session: savedSession });
    const history = session.skillId ? await repository.listSkillItems(session.skillId) : [];
    const needed = replacement ? 1 : Math.max(1, session.count - value.items.length);
    let savedBatches = 0;
    const result = await service.generate({ sessionId: session.id, requestVersion, sources: session.sources, words: session.words, count: needed, skill: currentSkill, excludedSentences: [...session.sources.map(source => source.text), ...history.map(item => item.text), ...(currentSkill?.sentenceHistory || []), ...value.items.map(item => item.text)], excludedFingerprints: currentSkill?.sentenceHistoryFingerprints || [],
      onValidatedItems: async items => {
        await repository.saveGeneratedItems({ sessionId: session.id, requestVersion, items, batchIndex: savedBatches, replaceItemId: replacement && savedBatches === 0 ? value.items[session.currentItemIndex || 0]?.id : null });
        savedBatches += 1;
        await queue.current;
        const saved = await repository.loadSession(session.id);
        applyBundle(saved);
        const item = saved.items[saved.session.currentItemIndex || 0];
        translationRef.current = saved.attempts.find(attempt => attempt.id === item?.attemptId)?.userTranslation || "";
        setTranslation(translationRef.current);
      },
      isCurrent: () => alive.current && getCurrentUsername() === username && bundleRef.current?.session.id === session.id && bundleRef.current.session.requestVersion === requestVersion });
    if (!result.items.length) throw new Error("本次没有通过质量校验的句子，来源和草稿已保留，可手动重试。");
    await queue.current;
    applyBundle(await repository.loadSession(session.id));
    if (result.missingCount) setNotice(`已保留 ${result.items.length} 句，仍缺 ${result.missingCount} 句。可手动补齐。`);
  }

  async function submit(reanalyze = false) {
    await flush();
    let value = bundleRef.current;
    const item = value.items[value.session.currentItemIndex || 0];
    let attempt = value.attempts.find(entry => entry.id === item.attemptId);
    if (!attempt.userTranslation?.trim()) throw new Error("请先填写中文翻译");
    if (!attempt.submittedAt) {
      attempt = await repository.saveAttempt({ sessionId: value.session.id, itemId: item.id, attemptId: attempt.id, expectedVersion: attempt.version, patch: { submittedAt: Date.now(), submissionVersion: attempt.version + 1 } });
      value = { ...value, attempts: value.attempts.map(entry => entry.id === attempt.id ? attempt : entry) }; applyBundle(value);
    }
    const prior = value.evaluations.filter(record => record.attemptId === attempt.id);
    if (prior.length && !reanalyze) return;
    const evaluationVersion = prior.length + 1;
    const result = await service.evaluate({ sessionId: value.session.id, itemId: item.id, attemptId: attempt.id, evaluationVersion, submittedAt: attempt.submittedAt, generatedSentence: item.text, structureFingerprint: item.structureFingerprint, userTranslation: attempt.userTranslation, targetWordUses: item.targetWordUses, difficultyMetadata: item.difficultyMetadata, isCurrent: () => alive.current && getCurrentUsername() === username && bundleRef.current?.session.id === value.session.id && bundleRef.current.items[bundleRef.current.session.currentItemIndex || 0]?.id === item.id && bundleRef.current.attempts.find(entry => entry.id === attempt.id)?.submissionVersion === attempt.submissionVersion });
    await repository.appendEvaluation({ sessionId: value.session.id, itemId: item.id, attemptId: attempt.id, evaluationVersion, submissionVersion: attempt.submissionVersion, evaluation: result.evaluation, rawOutput: result });
    applyBundle(await repository.loadSession(value.session.id));
  }
  async function switchItem(index) {
    await flush();
    const value = bundleRef.current;
    const session = await repository.updateSession({ sessionId: value.session.id, patch: { currentItemIndex: index } });
    const next = { ...value, session }; applyBundle(next);
    const attempt = next.attempts.find(entry => entry.id === next.items[index]?.attemptId);
    translationRef.current = attempt?.userTranslation || ""; setTranslation(translationRef.current);
  }
  async function rate(userRating) {
    await flush();
    const result = await repository.rateAttempt({ sessionId: bundle.session.id, attemptId: currentAttempt.id, userRating });
    applyBundle(await repository.loadSession(bundle.session.id));
    setNotice(result.event.reason === "major_structure_or_logic_error" ? "已保留“已掌握”自评；AI 指出重大结构或逻辑问题，因此安排次日复习。" : result.event.changed === false ? "已保存额外练习，正式复习日期保持不变。" : `已保存自评，下次复习：${result.skill.nextDueAt}`);
  }
  const handleLayout = layout => enqueue(async () => {
    const value = bundleRef.current;
    if (!value) return;
    const item = value.items[value.session.currentItemIndex || 0];
    const attempt = value.attempts.find(entry => entry.id === item?.attemptId);
    if (!attempt || attempt.layout) return;
    const saved = await repository.saveAttempt({ sessionId: value.session.id, itemId: item.id, attemptId: attempt.id, expectedVersion: attempt.version, patch: { layout } });
    applyBundle({ ...value, attempts: value.attempts.map(entry => entry.id === saved.id ? saved : entry) });
  }).catch(showError);

  return <main className="long-sentence-page" data-testid="long-sentence-page" aria-busy={busy || loading}>
    <header className="ls-heading"><div><h1>长难句训练</h1><p>从你的困难原句出发，练习更高一层的句子结构。</p></div><div className="ls-actions">{onReturnToReader && (originContext || bundle?.session.originContext) && <button type="button" disabled={busy} onClick={() => run(async () => { await flush(); await onReturnToReader(originContext || bundle.session.originContext); })}>返回精读</button>}{sessionId && <button type="button" disabled={busy} onClick={closeSession}>返回训练列表</button>}</div></header>
    {error && <div className="ls-error" role="alert">{error}{configureAi && <button type="button" onClick={onOpenAiSettings}>打开 AI 设置</button>}</div>}
    {notice && <p className="ls-notice" role="status">{notice}</p>}
    {!available && <p className="ls-error" role="alert">训练数据库升级未完成，已停用新训练写入。原有学习功能仍可使用。</p>}
    {loading && <p role="status">正在读取学习记录…</p>}
    {!sessionId && <><nav className="ls-tabs" role="tablist" aria-label="长难句模块">{TABS.map(label => <button key={label} role="tab" type="button" aria-selected={tab === label} onClick={() => { setTab(label); setOffset(0); setError(""); }}>{label}</button>)}</nav>
      {tab === "生成训练" && <div className="ls-generate-grid"><section className="ls-card"><h2>选择困难原句</h2><SelectBox entries={sources.filter(source => source.status === "resolved")} selected={selected} onChange={selectSources}>全选可用原句（已选 {selected.length}）</SelectBox>{!loading && !sources.length && <p>还没有待掌握的困难句。请在精读中将原句标为“需复盘”。</p>}<SourceTree sources={sources} selected={selected} onChange={selectSources} /></section>
        <section className="ls-card"><h2>搭配陌生词</h2><p className="ls-muted">取所选文章的陌生词并集；每句自然使用其中 0–3 个。</p><label>搜索陌生词<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label><label className="ls-select-label"><input type="checkbox" checked={onlySelected} onChange={event => setOnlySelected(event.target.checked)} />只看已选</label><div className="ls-words">{words.filter(word => (!onlySelected || !deselectedWords.includes(word.wordId)) && `${word.word} ${word.meaning}`.toLowerCase().includes(query.toLowerCase())).map(word => <label className="ls-word" key={word.wordId}><input type="checkbox" checked={!deselectedWords.includes(word.wordId)} onChange={event => setDeselectedWords(previous => event.target.checked ? previous.filter(id => id !== word.wordId) : [...new Set([...previous, word.wordId])])} /><span><strong>{word.word}</strong>{word.meaning && ` · ${word.meaning}`}<small>{word.refs.length} 处文章来源</small></span></label>)}</div><label className="ls-count">训练数量<select data-testid="long-sentence-count" value={count} onChange={event => setCount(Number(event.target.value))}>{[1,2,3,4,5].map(number => <option key={number} value={number}>{number} 句</option>)}</select></label><p>难度：高于所选原句中最高难度一个结构层级。</p><button className="ls-primary" data-testid="long-sentence-generate" type="button" disabled={busy || loading || !available || !selected.length} onClick={() => run(() => generate())}>{busy ? "正在生成…" : `生成 ${count} 句训练`}</button></section></div>}
      {tab === "待掌握" && <section className="ls-card"><h2>原句待掌握 · {sources.length}</h2><p>通过原句复习中的“现在能独立理解”完成后，原句才进入已学习。</p>{sources.map(source => <article className="ls-list-row" key={source.sourceReviewId}><div><small>{source.resourceTitle} · {source.articleLabel}</small><p>{source.text || source.error}</p></div><button type="button" disabled={busy || source.status !== "resolved"} onClick={() => run(async () => { await flush(); await onStartOriginalReview(source); })}>复习原句</button></article>)}</section>}
      {tab === "待复习" && <section className="ls-card"><h2>今日到期 {dueCount} 项</h2>{dueSkills.map(skill => <article className="ls-list-row" key={skill.id}><div><p>{skill.structureFingerprint}</p><small>到期 {skill.nextDueAt} · 已练 {skill.attemptCount || 0} 次</small></div><button type="button" disabled={busy || !available} onClick={() => run(() => generate({ skill }))}>开始复习</button></article>)}{!dueCount && <p>今天没有到期的结构技能。</p>}<div className="ls-actions"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><button type="button" disabled={offset + 20 >= dueCount} onClick={() => setOffset(offset + 20)}>下一页</button></div></section>}
      {tab === "已学习" && <section className="ls-card"><h2>已学习原句 · {learned.length}</h2>{!learned.length && <p>原句复习完成后会显示在这里；旧记录缺少完成凭据的原句不会自动加入。</p>}{learned.map(source => <article className="ls-list-row" key={`${source.sourceReviewId}:${source.learnedAt}`}><div><small>{source.resourceTitle} · {source.articleLabel}</small><p>{source.text || source.sourceSnapshot?.text}</p><small>完成于 {new Date(source.learnedAt).toLocaleString()}</small>{source.status !== "resolved" && <p>{source.error || "来源暂不可用，显示完成时快照"}</p>}</div></article>)}</section>}
      {tab === "学习记录" && <section className="ls-card"><h2>训练记录</h2>{records.map(record => <article className="ls-list-row" key={record.id}><div><p>{new Date(record.createdAt).toLocaleString()}</p><small>{record.itemIds?.length || 0} 句训练 · {record.extraPractice ? "额外练习" : "正式训练"}</small></div><div className="ls-actions"><button type="button" onClick={() => onOpenSession(record.id)}>查看记录</button><button type="button" onClick={() => run(async () => { if (!window.confirm("删除这次训练、作答、解析和笔迹？原句、陌生词和技能复习安排会保留。")) return; await repository.deleteSession(record.id); setRecords(await repository.listSessions({ offset, limit: 20 })); })}>删除</button></div></article>)}{!records.length && <p>还没有训练记录。</p>}<div className="ls-actions"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><button type="button" disabled={records.length < 20} onClick={() => setOffset(offset + 20)}>下一页</button></div></section>}
    </>}
    {sessionId && bundle && <>
      {!currentItem && !loading && <section className="ls-card"><p>这次训练尚未生成可用句子。已保留来源和选择。</p><button type="button" disabled={busy || !available} onClick={() => run(() => generate({ supplement: true }))}>重试生成</button></section>}
      {currentItem && currentAttempt && <><div className="ls-session-bar"><strong>第 {(bundle.session.currentItemIndex || 0) + 1} / {bundle.items.length} 句</strong><div className="ls-actions"><button type="button" disabled={busy || !(bundle.session.currentItemIndex || 0)} onClick={() => run(() => switchItem((bundle.session.currentItemIndex || 0) - 1))}>上一句</button><button type="button" disabled={busy || (bundle.session.currentItemIndex || 0) >= bundle.items.length - 1} onClick={() => run(() => switchItem((bundle.session.currentItemIndex || 0) + 1))}>下一句</button><button type="button" disabled={busy} onClick={() => run(() => generate({ replacement: true }))}>换一句</button></div></div>
        <div className="ls-source-caption">来源：{bundle.session.sources.map(source => `${source.resourceTitle || source.resourceId} · ${source.articleLabel || source.passageId}`).join("；")}</div>
        <SentencePaper session={bundle.session} item={currentItem} attempt={currentAttempt} readOnly={busy || Boolean(currentAttempt.submittedAt)} onError={showError} onLayout={handleLayout} flushRef={inkFlush} />
        <section className="ls-card ls-answer"><label htmlFor="ls-translation">我的翻译</label><textarea id="ls-translation" data-testid="long-sentence-translation" value={translation} readOnly={busy || Boolean(currentAttempt.submittedAt)} placeholder="用中文写出你对句子的理解" onChange={event => { translationRef.current = event.target.value; setTranslation(event.target.value); clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => saveDraft().catch(showError), 350); }} />
          <div className="ls-actions"><button type="button" className="ls-primary" data-testid="long-sentence-submit" disabled={busy || !translation.trim() || Boolean(latestEvaluation)} onClick={() => run(() => submit())}>{busy ? "正在处理…" : currentAttempt.submittedAt ? "重试解析" : "提交翻译"}</button>{currentAttempt.submittedAt && <button type="button" disabled={busy} onClick={() => run(async () => { await flush(); await repository.createAttempt({ sessionId: bundle.session.id, itemId: currentItem.id }); applyBundle(await repository.loadSession(bundle.session.id)); translationRef.current = ""; setTranslation(""); })}>重新作答</button>}</div>
        </section>
        {latestEvaluation && <><EvaluationView record={latestEvaluation} busy={busy} onFeedback={() => run(async () => { await repository.setEvaluationFeedback({ evaluationId: latestEvaluation.id, feedback: "incorrect" }); applyBundle(await repository.loadSession(bundle.session.id)); })} onReanalyze={() => run(() => submit(true))} />
          <section className="ls-card"><h3>我的自评</h3>{currentAttempt.userRating ? <p>已保存：{currentAttempt.userRating === "mastered" ? "已掌握" : "仍困难"}。原句状态由原句复习独立管理。</p> : <div className="ls-actions"><button type="button" disabled={busy} onClick={() => run(() => rate("difficult"))}>仍困难</button><button type="button" disabled={busy} onClick={() => run(() => rate("mastered"))}>已掌握</button></div>}{currentAttempt.userRating && <button type="button" disabled={busy} onClick={() => run(async () => { const skill = await repository.getSkill(currentAttempt.skillId || currentItem.skillId); if (!skill) throw new Error("技能记录暂不可用"); await generate({ skill, extraPractice: true }); })}>现在再来一句</button>}</section>
        </>}
        {evaluations.length > 1 && <details className="ls-card"><summary>以前的解析（{evaluations.length - 1}）</summary>{evaluations.slice(0,-1).map(record => <div key={record.id}><small>版本 {record.evaluationVersion} · {new Date(record.createdAt).toLocaleString()}{record.analysisFeedback === "incorrect" ? " · 已报告有误" : ""}</small><p>{record.evaluation?.referenceTranslation}</p><pre>{JSON.stringify(record.evaluation,null,2)}</pre></div>)}</details>}
      </>}
      {bundle.items.length > 0 && bundle.items.length < bundle.session.count && <button type="button" disabled={busy} onClick={() => run(() => generate({ supplement: true }))}>补齐剩余训练</button>}
      {historyEntries.length > 0 && <section className="ls-card" aria-label="历史题目与作答"><h3>以前的题目与作答</h3><p className="ls-muted">选择一条记录查看当时的笔迹、译文和解析。</p>
        <div className="ls-history-list">{historyEntries.map(({ item, attempt, replaced }) => <button key={attempt.id} type="button" className="ls-list-row" style={{ width: "100%", textAlign: "left" }} aria-pressed={historyAttemptId === attempt.id} onClick={() => setHistoryAttemptId(current => current === attempt.id ? "" : attempt.id)}><span>{replaced ? "已换掉的句子" : "较早的作答"} · {new Date(attempt.createdAt).toLocaleString()}</span><span lang="en">{item.text}</span></button>)}</div>
      </section>}
      {selectedHistory && <HistoryAttemptView key={selectedHistory.attempt.id} session={bundle.session} item={selectedHistory.item} attempt={selectedHistory.attempt} evaluations={bundle.evaluations.filter(record => record.attemptId === selectedHistory.attempt.id)} onError={showError} onClose={() => setHistoryAttemptId("")} />}
    </>}
  </main>;
}
