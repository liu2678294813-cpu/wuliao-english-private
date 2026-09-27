import { useEffect, useMemo, useRef, useState } from "react";
import { EXAM_DURATION_MS } from "./examCore";
import { AnnotationToolbar } from "../ui/AnnotationToolbar";
import Icon from "../ui/Icon";
import {
  normalizePenMode,
  normalizePenSize,
  PEN_MODE_STORAGE_KEY,
  PEN_SIZE_STORAGE_KEY,
} from "../annotationTools";
import { getUserItem, setUserItem } from "../userData";
import { isAndroidApp } from "../platform";

const pad = (value) => String(value).padStart(2, "0");
export function examTimeText(remainingMs) {
  const seconds = Math.max(0, Math.ceil(Number(remainingMs || 0) / 1000));
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export function ExamLibrary({ years = [], activeSession = null, onStart, onContinue, onAbandon, onHistory, completedCount = 0, latestResult = null }) {
  return (
    <main className="exam-page exam-library-page">
      <div className="exam-library-heading-row">
        <div className="exam-library-heading">
          <p className="exam-eyebrow">X1 MOCK EXAM</p>
          <h1>整卷模拟</h1>
          <p className="exam-library-desc">仅含完形填空与 Reading Part A Text 1–4，共 40 题；严格 100 分钟。</p>
          <p className="exam-library-summary">已完成 {completedCount} 次{latestResult ? ` · 最近 ${latestResult.year}：${latestResult.scoring.correct}/${latestResult.scoring.total}` : ""}</p>
        </div>
        <button type="button" className="exam-secondary-action" onClick={onHistory} aria-label="历史成绩">
          <Icon name="review" size={16} />历史成绩
        </button>
      </div>
      {activeSession && (
        <div className="exam-library-actions">
          <button className="primary-button" onClick={onContinue}>继续未完成考试</button>
          <button className="exam-danger-button" onClick={onAbandon}>放弃本次考试</button>
        </div>
      )}
      <div className="exam-year-grid">
        {years.map((year) => (
          <button key={year} className="exam-year-card" disabled={Boolean(activeSession)} onClick={() => onStart(year)}>
            <strong>{year}</strong>
            <span>40题 · 100分钟</span>
          </button>
        ))}
      </div>
    </main>
  );
}

export function ExamCover({ year, loading, error, onBegin, onBack }) {
  return <main className="exam-page"><button className="back-button" onClick={onBack}>返回</button><p className="exam-eyebrow">{year} ENGLISH I</p><h1>开始 X1 整卷模拟</h1><ul><li>完形 20 题</li><li>阅读 Text 1–4，20 题</li><li>严格 100 分钟，切到后台继续计时</li></ul>{error && <p role="alert">{error}</p>}<button className="primary-button" disabled={loading || Boolean(error)} onClick={onBegin}>{loading ? "正在核验 40 题…" : "开始计时"}</button></main>;
}

// 共享笔工具栏状态：工具偏好与精读 / 普通完形共用同一批 storage key。
export function ExamSession({ session, disabled = false, conflictMessage = "", onReload, onAnswer, onNavigate, onSubmit, onTimeout, onBack = null, ExamInkSurface = null, examInkProps = null, ExamQuestionDrawer = null }) {
  const [now, setNow] = useState(Date.now());
  const [inkTool, setInkTool] = useState("pen");
  const [inkColor, setInkColor] = useState("#173a62");
  const [inkPenSize, setInkPenSize] = useState(() => normalizePenSize(getUserItem(PEN_SIZE_STORAGE_KEY)));
  const [inkPenMode, setInkPenMode] = useState(() => normalizePenMode(getUserItem(PEN_MODE_STORAGE_KEY)));
  const [inkEraserMode, setInkEraserMode] = useState(() => getUserItem("wuliao:pref:eraser-mode") || "normal");
  const [inkEraserSize, setInkEraserSize] = useState(24);
  const [inkCollapsed, setInkCollapsed] = useState(false);
  const [inkStrokeCount, setInkStrokeCount] = useState(0);
  const [inkToolbarApi, setInkToolbarApi] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const inkApiRef = useRef(null);
  useEffect(() => { setNow(Date.now()); }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(timer); }, []);
  const elapsed = Math.max(session.elapsedMs || 0, now - session.startedAt);
  const remaining = Math.max(0, EXAM_DURATION_MS - elapsed);
  useEffect(() => { if (!disabled && remaining === 0 && session.status === "in_progress") onTimeout?.(); }, [disabled, remaining, onTimeout, session.status]);
  useEffect(() => {
    if (disabled || session.status !== "in_progress") return undefined;
    const deadlineMs = Math.max(0, EXAM_DURATION_MS - Math.max(session.elapsedMs || 0, Date.now() - session.startedAt));
    const timer = window.setTimeout(() => onTimeout?.(), deadlineMs);
    return () => window.clearTimeout(timer);
  }, [disabled, onTimeout, session.elapsedMs, session.startedAt, session.status]);
  const item = session.items.find((entry) => entry.id === session.currentItemId) || session.items[0];
  const index = session.items.findIndex((entry) => entry.id === item.id);
  const answer = session.answers?.[item.id] || "";
  const readingItems = item.section === "reading" ? session.items.filter((entry) => entry.resourceId === item.resourceId) : [item];
  const sharedPassage = session.items.find((entry) => entry.resourceId === item.resourceId && entry.passageText)?.passageText || "";
  const clozeSegments = session.items.find((entry) => entry.section === "cloze" && entry.passageSegments)?.passageSegments || [];
  const clozePassage = item.section === "cloze" && clozeSegments.length ? <article className="exam-passage">{clozeSegments.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{(paragraph.segments || []).map((segment, index) => {
    if (segment.type !== "blank") return <span key={index}>{segment.text} </span>;
    const target = session.items.find((entry) => entry.blankNumber === segment.number);
    const selectedKey = session.answers?.[target?.id];
    const displayText = target?.options?.find((option) => option.key === selectedKey)?.text || "__";
    return <button key={index} className="exam-inline-blank" disabled={disabled} onClick={() => { if (target) onNavigate(target.id); }}>{segment.number} {displayText}</button>;
  })}</p>)}</article> : sharedPassage ? <article className="exam-passage">{sharedPassage}</article> : null;
  const body = <>{clozePassage}{readingItems.map((question) => { const selected = session.answers?.[question.id] || ""; return <section key={question.id} className={`exam-question ${question.id === item.id ? "current" : ""}`}><p>{question.order}. {question.stem || `第 ${question.order} 题`}</p><div className="exam-options">{(question.options || []).map((option) => <button key={option.key} disabled={disabled} className={selected === option.key ? "selected" : ""} onClick={() => onAnswer(question.id, option.key)}>{option.key}. {option.text}</button>)}</div></section>; })}</>;
  const inkSurface = ExamInkSurface ? <ExamInkSurface
    session={session}
    item={item}
    {...(examInkProps?.(item) || {})}
    tool={inkTool}
    color={inkColor}
    penSize={inkPenSize}
    penMode={inkPenMode}
    eraserMode={inkEraserMode}
    eraserSize={inkEraserSize}
    onStrokesCountChange={setInkStrokeCount}
    onToolbarApiChange={(api) => { inkApiRef.current = api; setInkToolbarApi(api); }}
  >{body}</ExamInkSurface> : body;
  const confirmSubmit = () => { const unanswered = session.items.filter((entry) => !session.answers?.[entry.id]).length; if (!unanswered || window.confirm(`还有 ${unanswered} 题未答，确认交卷？`)) onSubmit?.(); };
  const textNumber = item.resourceId?.match(/-text-(\d+)/)?.[1] || "";
  const sectionLabel = item.section === "cloze" ? "完形填空" : `Text ${textNumber}`;
  const sessionTitle = `${session.year} 英语（一） · ${sectionLabel}`;
  const answeredCount = session.items.filter((entry) => session.answers?.[entry.id]).length;
  return <main className={`exam-page exam-session ${disabled ? "is-locked" : ""} ${inkCollapsed ? "top-area-collapsed" : ""}`}>
    <header className="exam-session-header">
      <button type="button" className="back-button" onClick={onBack} aria-label="返回考试资料库">← 返回</button>
      <div className="exam-session-title">
        <strong>{sessionTitle}</strong>
        <small>第 {index + 1} 题 · {sectionLabel}</small>
      </div>
      <div className="exam-session-actions">
        <time aria-label="剩余时间">{examTimeText(remaining)}</time>
        <button disabled={disabled} onClick={confirmSubmit}>交卷</button>
      </div>
    </header>
    <div className="exam-status-bar" role="status">
      <span>已答 {answeredCount} / {session.items.length}</span>
      <strong>当前第 {index + 1} 题</strong>
      <span>{sectionLabel}</span>
    </div>
    {/* 共享笔工具栏：与精读 / 普通完形同一组件同一视觉契约；位于题号导航上方。 */}
    <AnnotationToolbar
      tool={inkTool}
      color={inkColor}
      annotations={inkStrokeCount > 0 ? [{ count: inkStrokeCount }] : []}
      onTool={(value) => { setInkTool(value); }}
      onColor={(value) => { setInkColor(value); setInkTool("pen"); }}
      penSize={inkPenSize}
      penMode={inkPenMode}
      eraserMode={inkEraserMode}
      eraserSize={inkEraserSize}
      onPenSize={(value) => { const next = normalizePenSize(value); setInkPenSize(next); setUserItem(PEN_SIZE_STORAGE_KEY, String(next)); }}
      onPenMode={(value) => { const next = normalizePenMode(value); setInkPenMode(next); setUserItem(PEN_MODE_STORAGE_KEY, next); setInkTool("pen"); }}
      onEraserMode={(value) => { setInkEraserMode(value); setUserItem("wuliao:pref:eraser-mode", value); setInkTool("eraser"); }}
      onEraserSize={setInkEraserSize}
      onUndo={() => inkApiRef.current?.undo()}
      onClear={() => inkApiRef.current?.clear()}
      canClear={Boolean(inkToolbarApi?.canClear)}
      clearLabel={item.section === "cloze" ? "清空笔迹" : "清空本 Text"}
      collapsible
      collapsed={inkCollapsed}
      onCollapsedChange={setInkCollapsed}
      unknownEnabled={false}
      tabletInk={isAndroidApp()}
    />
    {disabled && <p className="exam-conflict" role="alert">{conflictMessage || "考试数据已变更，当前页面已锁定。"} <button type="button" onClick={onReload}>重新加载最新进度</button></p>}
    <nav className="exam-navigator" aria-label="题号导航">{session.items.map((entry, order) => <button key={entry.id} disabled={disabled} className={`${entry.id === item.id ? "active" : ""} ${session.answers?.[entry.id] ? "answered" : ""}`} onClick={() => onNavigate(entry.id)}>{order + 1}</button>)}</nav>
    {inkSurface}
    <footer><button disabled={disabled || index <= 0} onClick={() => onNavigate(session.items[index - 1].id)}>上一题</button><button disabled={disabled || index >= session.items.length - 1} onClick={() => onNavigate(session.items[index + 1].id)}>下一题</button></footer>
    {ExamQuestionDrawer && item.section === "reading" && (
      <ExamQuestionDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        questions={readingItems}
        answers={session.answers || {}}
        onChoose={(questionId, optionKey) => onAnswer(questionId, optionKey)}
        disabled={disabled}
      />
    )}
  </main>;
}

export function ExamResult({ result, onHandoff, onStartHandoff, onHistory, onBack }) {
  const [selected, setSelected] = useState([]);
  const [saved, setSaved] = useState([]);
  const targets = useMemo(() => result.handoffTargets || [], [result]);
  const byText = Object.values(result.scoring.items.reduce((map, item) => { if (item.section === "reading") { const value = map[item.resourceId] || { correct: 0, total: 0 }; value.total += 1; value.correct += Number(item.correct); map[item.resourceId] = value; } return map; }, {}));
  const missed = result.scoring.items.filter((item) => !item.correct);
  const sections = result.scoring.sections || {};
  const saveHandoffs = async () => {
    await onHandoff?.(selected);
    setSaved(selected);
  };
  return (
    <main className="exam-page exam-result-page">
      <p className="exam-eyebrow">{result.year} · 模拟考试完成</p>
      <h1>考试结果</h1>
      <p className="exam-result-note">本结果仅统计本 App 已接入的完形与 Reading Part A。</p>
      <div className="exam-result-metrics">
        <div className="exam-metric-card exam-score"><strong>{result.scoring.correct} / {result.scoring.total}</strong><span>总成绩</span></div>
        <div className="exam-metric-card"><strong>{sections.cloze?.correct ?? 0} / {sections.cloze?.total ?? 0}</strong><span>完形</span></div>
        <div className="exam-metric-card"><strong>{sections.reading?.correct ?? 0} / {sections.reading?.total ?? 0}</strong><span>阅读</span></div>
        <div className="exam-metric-card"><strong>{examTimeText(result.finalElapsedMs)}</strong><span>用时</span></div>
      </div>
      <div className="exam-result-breakdown">
        <div className="exam-breakdown-row"><span>完形填空</span><span>{sections.cloze?.correct ?? 0} / {sections.cloze?.total ?? 0}</span></div>
        {byText.map((entry, index) => (
          <div className="exam-breakdown-row" key={index}><span>Reading Text {index + 1}</span><span>{entry.correct} / {entry.total}</span></div>
        ))}
        <div className="exam-breakdown-row"><span>未答</span><span>{result.scoring.unanswered}</span></div>
      </div>
      {missed.length > 0 && (
        <details className="exam-result-missed">
          <summary>错题与未答（{missed.length}）</summary>
          {missed.map((item) => <p key={item.itemId}>{item.questionNumber}. {item.unanswered ? "未答" : `你选 ${item.answer} · 答案 ${item.officialAnswer}`}</p>)}
        </details>
      )}
      {targets.map((target) => (
        <div key={target.targetId} className="exam-handoff-row">
          <label><input type="checkbox" checked={selected.includes(target.targetId)} onChange={() => setSelected((current) => current.includes(target.targetId) ? current.filter((id) => id !== target.targetId) : [...current, target.targetId])} />{target.section === "cloze" ? "完形填空" : target.resourceId}{target.focusItemIds.length ? ` · ${target.focusItemIds.length} 个待回看` : " · 可加入后续学习"}</label>
          {saved.includes(target.targetId) && <button type="button" className="exam-secondary-action" onClick={() => onStartHandoff?.(target)}>开始学习</button>}
        </div>
      ))}
      <div className="exam-result-actions">
        <button className="primary-button" disabled={!selected.length} onClick={saveHandoffs}>加入后续学习</button>
        <button className="exam-secondary-action" onClick={onHistory}>历史成绩</button>
        <button className="exam-secondary-action" onClick={onBack}>返回资料库</button>
      </div>
    </main>
  );
}

export function ExamHistory({ results = [], onOpen, onBack }) {
  const formatDate = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  return (
    <main className="exam-page exam-history-page">
      <button className="back-button" onClick={onBack}>返回</button>
      <h1>历史成绩</h1>
      {results.length ? (
        <div className="exam-history-list">
          {results.map((result) => {
            const scoring = result.scoring;
            const sections = scoring?.sections || {};
            return (
              <button key={result.id || result.sessionId} className="exam-history-row" disabled={!scoring} onClick={() => scoring && onOpen(result)}>
                <span className="exam-history-row-main">
                  <strong>{result.year || "—"}</strong>
                  {result.damaged ? (
                    <span className="exam-history-note">损坏记录（只读）</span>
                  ) : result.status === "abandoned" ? (
                    <span className="exam-history-note">已放弃 · 已用 {examTimeText(result.terminal?.finalElapsedMs || result.elapsedMs)}</span>
                  ) : (
                    <>
                      <span className="exam-history-score">{scoring.correct} / {scoring.total} · {examTimeText(result.finalElapsedMs)}</span>
                      <span className="exam-history-sections">完形 {sections.cloze?.correct ?? "—"}/{sections.cloze?.total ?? "—"} · 阅读 {sections.reading?.correct ?? "—"}/{sections.reading?.total ?? "—"}</span>
                    </>
                  )}
                </span>
                <span className="exam-history-meta">
                  {formatDate(result.submittedAt)}
                  {scoring ? ` · ${result.reason === "timed_out" ? "到时交卷" : "手动交卷"}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      ) : <p className="exam-history-empty">还没有已交卷的模拟。</p>}
    </main>
  );
}
