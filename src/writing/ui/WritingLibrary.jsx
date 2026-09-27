import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAppEvent } from "../../events/appEvents.js";
import { AppEvent } from "../../events/eventTypes.js";
import { WRITING_STAGE_SHORT, WRITING_STAGE_TITLES } from "./WritingStageShell.jsx";
import "../writing.css";

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function SessionCard({ item, onOpen }) {
  const score = item.latestScore || item.completionScore;
  return (
    <article className="writing-library-card">
      <button type="button" onClick={() => onOpen?.(item.sessionId)} aria-label={`打开写作训练：${item.promptText || item.taskType}`}>
        <header>
          <span>{item.status === "completed" ? "已完成" : `${WRITING_STAGE_SHORT[item.safeStage]} · 进行中`}</span>
          <time>{formatDate(item.completedAt || item.lastActiveAt || item.startedAt)}</time>
        </header>
        <h3>{item.promptText || `${item.year || ""} ${item.taskType || "写作训练"}`.trim()}</h3>
        <p>{item.status === "completed" ? "查看完成摘要与评分记录" : `继续${WRITING_STAGE_TITLES[item.safeStage] || "写作训练"}`}</p>
        <footer>
          <small>{item.year || "年份未标注"} · {item.taskType || "写作"}</small>
          {score ? <strong>{score.finalScore}<span> / {score.maxScore}</span></strong> : <b aria-hidden="true">→</b>}
        </footer>
      </button>
    </article>
  );
}

function taskLabel(taskType) {
  return taskType?.endsWith("-a") ? "小作文 · Writing A" : "大作文 · Writing B";
}

function QuestionCard({ question, selected, onSelect }) {
  const part = question.taskType.endsWith("-a") ? "A" : "B";
  return (
    <article className={`resource-card writing-question-card${selected ? " is-selected" : ""}`}>
      <div className="resource-card-top"><span className="resource-badge">英语一</span></div>
      <button
        type="button"
        className="resource-open"
        aria-expanded={selected}
        aria-label={`查看 ${question.year} 年${taskLabel(question.taskType)}`}
        onClick={() => onSelect(question.questionId)}
      >
        <strong>{question.year} 英语（一）写作</strong>
        <span className="resource-number">{part}</span>
        <span>{part === "A" ? `Part A · ${question.promptKind === "notice" ? "通知" : question.promptKind === "email" ? "邮件" : "书信"}` : "Part B · 图画作文"}</span>
      </button>
      <div className="resource-meta"><span>官方真题</span><span>原卷第 {question.source.sourcePage} 页</span></div>
      <div className="progress-track" aria-hidden="true"><span /></div>
    </article>
  );
}

function QuestionBank({ services, onOpenSession, onConfigureTextAi }) {
  const years = services?.questionBank?.listYears?.() || [];
  const [year, setYear] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [availableSamples, setAvailableSamples] = useState([]);
  const [startState, setStartState] = useState({ status: "idle", questionId: "", sampleSource: "", error: "", code: "" });
  const startLock = useRef(false);
  const questions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (services?.questionBank?.list?.() || []).filter((question) => {
      if (year !== "all" && question.year !== Number(year)) return false;
      if (!normalizedQuery) return true;
      return `${question.year} ${taskLabel(question.taskType)} ${question.promptText}`.toLowerCase().includes(normalizedQuery);
    });
  }, [query, services, year]);
  const grouped = useMemo(() => questions.reduce((result, question) => {
    (result[question.year] ||= []).push(question);
    return result;
  }, {}), [questions]);
  const selected = selectedId ? services?.questionBank?.get?.(selectedId) : null;
  const selectedSample = selected ? availableSamples.find((item) => item.questionId === selected.questionId) : null;
  const hasLocalSample = Boolean(selectedSample);

  useEffect(() => {
    let active = true;
    (async () => {
      await services?.privateSamplesReady;
      const samples = services?.privateSamples?.listAvailableSamples
        ? await services.privateSamples.listAvailableSamples()
        : (await services?.privateSamples?.listAvailableQuestionIds?.() || []).map((questionId) => ({ questionId, sourceType: "device_private" }));
      if (active) setAvailableSamples(samples);
    })().catch(() => { if (active) setAvailableSamples([]); });
    return () => { active = false; };
  }, [services]);

  const start = async (sampleSource = "ai_generated") => {
    if (!selected || startLock.current) return;
    startLock.current = true;
    setStartState({ status: "loading", questionId: selected.questionId, sampleSource, error: "", code: "" });
    try {
      const result = await services.questionSessions.startQuestionTraining(selected.questionId, { sampleSource });
      setStartState({ status: "idle", questionId: "", sampleSource: "", error: "", code: "" });
      onOpenSession?.(result.session.sessionId);
    } catch (error) {
      setStartState({ status: "failed", questionId: selected.questionId, sampleSource, error: error?.message || "启动失败，没有创建训练记录。请重试。", code: error?.code || "" });
    } finally {
      startLock.current = false;
    }
  };

  if (!years.length) return null;
  return (
    <section className="writing-question-bank" id="writing-question-bank" aria-labelledby="writing-question-bank-title">
      <header className="writing-question-bank-header">
        <div><small>OFFICIAL ARCHIVE · 2001—2023</small><h2 id="writing-question-bank-title">考研英语（一）历年写作真题</h2></div>
        <span>{services.questionBank.list().length} 道官方题目</span>
      </header>
      <div className="library-tools writing-question-tools">
        <label className="search-box"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedId(""); }} placeholder="搜索年份、Writing A / B 或题干" /></label>
        <select id="writing-question-year" value={year} aria-label="按年份筛选写作" onChange={(event) => { setYear(event.target.value); setSelectedId(""); setStartState({ status: "idle", questionId: "", sampleSource: "", error: "", code: "" }); }}>
          <option value="all">全部年份 · 2001–2023</option>
          {years.map((item) => <option key={item} value={item}>{item} 年</option>)}
        </select>
        <span className="result-count">{questions.length} 篇</span>
      </div>
      <div className="year-groups writing-question-years">
        {Object.entries(grouped).sort(([left], [right]) => Number(right) - Number(left)).map(([groupYear, yearQuestions]) => (
          <section className="year-group" key={groupYear}>
            <div className="year-heading"><strong>{groupYear}</strong><span>{yearQuestions.length} 篇</span></div>
            <div className="resource-grid">
              {yearQuestions.map((question) => <QuestionCard key={question.questionId} question={question} selected={selectedId === question.questionId} onSelect={(questionId) => { setSelectedId(questionId); setStartState({ status: "idle", questionId: "", sampleSource: "", error: "", code: "" }); }} />)}
            </div>
            {selected?.year === Number(groupYear) ? <article className="writing-question-preview" aria-live="polite">
              <header><div><small>{selected.year} · QUESTION {selected.source.sourceQuestionNumber}</small><h3>{taskLabel(selected.taskType)}</h3></div><strong>{selected.maxScore}<span> 分</span></strong></header>
              <div className="writing-question-copy"><p>{selected.promptText}</p><p>{selected.directions}</p></div>
              {selected.assets.map((asset) => <figure key={asset.assetId}><img src={asset.src} alt={asset.alt} loading="lazy" /><figcaption>原卷题图 · 第 {selected.source.sourcePage} 页</figcaption></figure>)}
              <footer>
                <div><small>训练建议字数</small><strong>{selected.targetWordRange.min}—{selected.targetWordRange.max} words</strong></div>
                <div className="writing-question-start-buttons">
                  {hasLocalSample ? <button type="button" className="primary-button" disabled={startState.status === "loading"} onClick={() => start(selectedSample.sourceType)}>{startState.status === "loading" && startState.sampleSource === selectedSample.sourceType ? "正在载入参考范文…" : selectedSample.sourceType === "apk_bundle" ? "使用随应用范文" : "使用设备私有参考范文"}</button> : null}
                  <button type="button" className={hasLocalSample ? "writing-button-secondary" : "primary-button"} disabled={startState.status === "loading"} onClick={() => start("ai_generated")}>{startState.status === "loading" && startState.sampleSource === "ai_generated" ? "正在生成合格范文…" : hasLocalSample ? "使用 AI 生成范文" : "用这道题开始训练"}</button>
                </div>
              </footer>
              {startState.status === "failed" && startState.questionId === selected.questionId ? <div className="writing-question-start-error" role="alert"><strong>训练尚未创建</strong>{startState.code === "text_ai_not_configured" ? <><p>需要先配置“文本 AI”。</p><p>写作训练的范文生成、对照分析和评分使用文本 AI；“多模态 / 手写识别 AI”只用于手写作文识别。</p><p>请前往：AI API → 文本 AI，完成 Base URL、API Key 和 Model 配置。</p></> : <p>{startState.error}</p>}<div className="writing-question-start-actions">{["text_ai_not_configured", "auth_error", "model_unavailable"].includes(startState.code) && onConfigureTextAi ? <button type="button" onClick={onConfigureTextAi}>去配置文本 AI</button> : null}<button type="button" onClick={() => start(startState.sampleSource || "ai_generated")}>重试</button></div></div> : null}
            </article> : null}
          </section>
        ))}
        {!questions.length ? <div className="writing-library-empty"><strong>没有匹配的官方作文</strong><p>调整年份或搜索词后重试；原卷中不存在的题型不会补写。</p></div> : null}
      </div>
    </section>
  );
}

export default function WritingLibrary({ services, username, onOpenSession, onCreateSession, onConfigureTextAi }) {
  const [state, setState] = useState({ status: "loading", model: null, error: "" });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = generation.current + 1;
    generation.current = current;
    setState({ status: "loading", model: null, error: "" });
    try {
      if (!username || !services?.readModels?.buildWritingLibrary) throw new Error("missing-service");
      const model = await services.readModels.buildWritingLibrary();
      if (generation.current === current) setState({ status: "ready", model, error: "" });
    } catch (error) {
      if (generation.current === current) setState({ status: "failed", model: null, error: "写作库暂时无法读取，请稍后重试。" });
    }
  }, [services, username]);

  useEffect(() => {
    load();
    return () => { generation.current += 1; };
  }, [load]);

  useEffect(() => onAppEvent(AppEvent.ACCOUNT_CHANGED, load), [load]);

  const model = state.model;
  return (
    <main className="writing-library">
      <header className="writing-library-hero">
        <div>
          <p>WRITING LAB</p>
          <h1>写作训练</h1>
        </div>
        <button type="button" className="primary-button" onClick={() => document.getElementById("writing-question-bank")?.scrollIntoView?.({ behavior: "smooth", block: "start" })}>浏览历年真题</button>
      </header>

      <QuestionBank services={services} onOpenSession={onOpenSession} onConfigureTextAi={onConfigureTextAi} />

      {state.status === "loading" ? <section className="writing-library-state"><span className="writing-loader" />正在核对本账号的写作记录…</section> : null}
      {state.status === "failed" ? <section className="writing-library-state is-error"><strong>{state.error}</strong><button type="button" onClick={load}>重新载入</button></section> : null}
      {state.status === "ready" ? (
        <>
          <section className="writing-library-section">
            <div className="writing-library-heading"><div><small>CONTINUE</small><h2>继续训练</h2></div><span>{model.activeItems.length} 项</span></div>
            {model.activeItems.length ? <div className="writing-library-grid">{model.activeItems.map((item) => <SessionCard key={item.sessionId} item={item} onOpen={onOpenSession} />)}</div> : <div className="writing-library-empty"><strong>当前没有进行中的训练</strong><p>从已冻结的写作题目入口开始一场新训练。</p></div>}
          </section>
          <section className="writing-library-section">
            <div className="writing-library-heading"><div><small>ARCHIVE</small><h2>已完成</h2></div><span>{model.completedItems.length} 项</span></div>
            {model.completedItems.length ? <div className="writing-library-grid">{model.completedItems.map((item) => <SessionCard key={item.sessionId} item={item} onOpen={onOpenSession} />)}</div> : <div className="writing-library-empty"><strong>还没有完成记录</strong><p>完成评分查看后，本次训练会留在这里。</p></div>}
          </section>
          {model.damagedItems.length ? <section className="writing-library-damaged" role="status"><strong>{model.damagedItems.length} 条记录未展示</strong><p>这些记录未通过恢复校验。系统没有猜测阶段，也没有自动修改数据。</p></section> : null}
        </>
      ) : null}
    </main>
  );
}
