import { useEffect, useState } from "react";
import { getClozeOfficialAnswerKey } from "./clozeAnswerKeys";
import {
  CLOZE_STAGES,
  completeClozeStage,
  clozeTimerElapsed,
  finishClozeTimer,
  getClozeFlow,
  pauseClozeTimer,
  resumeClozeTimer,
  saveClozeFlow,
  startClozeTimer,
} from "./clozeFlow";
import {
  getClozeProgress,
  recordFirstAnswer,
  recordReviewAnswer,
  saveClozeProgress,
  setConfidence,
  summarizeClozeAttempts,
} from "./clozeProgress";
import { loadOfficialCloze } from "./library";

function formatElapsed(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function stageClass(flow, stageId) {
  const status = flow?.stages?.[stageId]?.status || "pending";
  return `cloze-stage cloze-stage-${status}`;
}

function PassagePreview({ paragraphs }) {
  return (
    <section className="cloze-dev-section">
      <div className="cloze-dev-section-heading">
        <div>
          <small>PASSAGE</small>
          <h2>正文与空位</h2>
        </div>
        <span>{paragraphs.length} 段</span>
      </div>
      <div className="cloze-dev-passage">
        {paragraphs.map((paragraph) => (
          <p key={paragraph.number}>
            {paragraph.segments.map((segment, index) => (
              segment.type === "blank"
                ? <mark key={`${paragraph.number}-${segment.number}-${index}`}>[{segment.number}]</mark>
                : <span key={`${paragraph.number}-text-${index}`}>{segment.text} </span>
            ))}
          </p>
        ))}
      </div>
    </section>
  );
}

export default function ClozeDevViewer({ resource, onClose }) {
  const [cloze, setCloze] = useState(null);
  const [answerKey, setAnswerKey] = useState({});
  const [flow, setFlow] = useState(null);
  const [progress, setProgress] = useState(null);
  const [answerMode, setAnswerMode] = useState("first");
  const [refreshToken, setRefreshToken] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [status, setStatus] = useState("正在读取完形数据");
  const [error, setError] = useState("");
  const resourceYear = Number(resource?.year) || Number(String(resource?.id || "").match(/\d{4}/)?.[0]) || 0;
  const directAnswerKey = getClozeOfficialAnswerKey({ year: resourceYear });

  useEffect(() => {
    let cancelled = false;
    setError("");
    setStatus("正在读取完形数据");
    (async () => {
      const nextCloze = await loadOfficialCloze(resource);
      const clozeId = nextCloze.id || resource.id;
      const numbers = nextCloze.blanks.map((blank) => blank.number);
      const nextFlow = getClozeFlow(resource.id, clozeId);
      const nextProgress = getClozeProgress(resource.id, clozeId, numbers);
      if (cancelled) return;
      setCloze(nextCloze);
      setAnswerKey(directAnswerKey);
      setFlow(nextFlow);
      setProgress(nextProgress);
      setStatus("完形数据已就绪");
    })().catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus("完形数据读取失败");
      }
    });
    return () => { cancelled = true; };
  }, [refreshToken, resource, resourceYear]);

  useEffect(() => {
    if (flow?.timedAttempt?.phase !== "running") return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [flow?.timedAttempt?.phase]);

  function updateFlow(next) {
    setFlow(next);
    saveClozeFlow(next);
  }

  function updateProgress(next) {
    setProgress(next);
    saveClozeProgress(next);
  }

  function chooseAnswer(number, answer) {
    if (!progress) return;
    const next = answerMode === "first"
      ? recordFirstAnswer(progress, number, answer)
      : recordReviewAnswer(progress, number, answer);
    updateProgress(next);
  }

  function chooseConfidence(number, confidence) {
    if (!progress) return;
    updateProgress(setConfidence(progress, number, confidence));
  }

  function completeCurrentStage() {
    if (!flow) return;
    let next = flow;
    if (flow.currentStage === "cloze-first-attempt" && flow.timedAttempt.phase === "running") {
      next = finishClozeTimer(next);
    }
    updateFlow(completeClozeStage(next, next.currentStage));
  }

  function handleTimer(action) {
    if (!flow) return;
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

  if (error) {
    return (
      <div className="cloze-dev-page">
        <header className="cloze-dev-header">
          <button className="back-button" type="button" onClick={onClose}>← 资料库</button>
        </header>
        <main className="cloze-dev-main"><div className="cloze-dev-error"><strong>{status}</strong><p>{error}</p><button className="primary-button" type="button" onClick={() => setRefreshToken((value) => value + 1)}>重试</button></div></main>
      </div>
    );
  }

  if (!cloze || !flow || !progress) {
    return (
      <div className="cloze-dev-page">
        <header className="cloze-dev-header"><button className="back-button" type="button" onClick={onClose}>← 资料库</button></header>
        <main className="cloze-dev-main"><div className="cloze-dev-loading">{status}</div></main>
      </div>
    );
  }

  const stats = summarizeClozeAttempts(progress, answerKey);
  const elapsed = clozeTimerElapsed(flow, clock);
  const timerPhase = flow.timedAttempt.phase;

  return (
    <div className="cloze-dev-page">
      <header className="cloze-dev-header">
        <button className="back-button" type="button" onClick={onClose}>← 资料库</button>
        <div className="cloze-dev-header-copy"><small>DEVELOPMENT VIEWER · A STAGE</small><strong>{resource.title}</strong></div>
        <button className="cloze-dev-refresh" type="button" onClick={() => setRefreshToken((value) => value + 1)}>刷新状态</button>
      </header>

      <main className="cloze-dev-main">
        <section className="cloze-dev-hero">
          <div><small>SECTION I · USE OF ENGLISH</small><h1>完形填空精读底座</h1><p>只用于验证解析、流程与本地保存。正式训练界面将在 B 阶段替换。</p></div>
          <div className="cloze-dev-stats"><strong>{stats.firstCompleted}/20</strong><span>首答完成</span><strong>{stats.reviewCompleted}/20</strong><span>复查完成</span></div>
        </section>

        <section className="cloze-dev-flow" aria-label="完形流程">
          {CLOZE_STAGES.map((stage, index) => (
            <div className={stageClass(flow, stage.id)} key={stage.id}>
              <span>{String(index + 1).padStart(2, "0")}</span><strong>{stage.label}</strong><small>{flow.stages[stage.id].status}</small>
            </div>
          ))}
          <div className="cloze-dev-flow-actions">
            {flow.currentStage === "cloze-first-attempt" && (
              <>
                <strong className="cloze-dev-timer">{formatElapsed(elapsed)}</strong>
                {timerPhase === "idle" && <button type="button" onClick={() => handleTimer("start")}>开始计时</button>}
                {timerPhase === "running" && <button type="button" onClick={() => handleTimer("pause")}>暂停</button>}
                {timerPhase === "paused" && <button type="button" onClick={() => handleTimer("resume")}>继续</button>}
                {timerPhase !== "done" && <button type="button" onClick={() => handleTimer("finish")}>结束计时</button>}
              </>
            )}
            <button type="button" className="primary-button" onClick={completeCurrentStage}>完成当前阶段</button>
          </div>
        </section>

        <PassagePreview paragraphs={cloze.paragraphs} />

        <section className="cloze-dev-section">
          <div className="cloze-dev-section-heading">
            <div><small>LOCAL ANSWERS</small><h2>首答 / 复查</h2></div>
            <div className="cloze-dev-mode"><button className={answerMode === "first" ? "active" : ""} type="button" onClick={() => setAnswerMode("first")}>首答</button><button className={answerMode === "review" ? "active" : ""} type="button" onClick={() => setAnswerMode("review")}>复查</button></div>
          </div>
          <div className="cloze-dev-answers">
            {cloze.blanks.map((blank) => {
              const attempt = progress.attempts[blank.number];
              return (
                <article className="cloze-dev-answer" key={blank.number}>
                  <div className="cloze-dev-answer-head"><strong>第 {blank.number} 空</strong><span>官方：{answerKey[blank.number] || directAnswerKey[blank.number] || "—"}</span></div>
                  <div className="cloze-dev-options">
                    {blank.options.map((option) => {
                      const selected = (answerMode === "first" ? attempt.firstAnswer : attempt.reviewAnswer) === option.key;
                      return <button className={selected ? "selected" : ""} type="button" key={option.key} onClick={() => chooseAnswer(blank.number, option.key)}><b>{option.key}</b><span>{option.text || "（缺失）"}</span></button>;
                    })}
                  </div>
                  <div className="cloze-dev-answer-foot"><span>首答 {attempt.firstAnswer || "—"} · 复查 {attempt.reviewAnswer || "—"}</span><span className="cloze-dev-confidence">{["confident", "uncertain", "guess"].map((value) => <button className={attempt.confidence === value ? "active" : ""} type="button" key={value} onClick={() => chooseConfidence(blank.number, value)}>{value === "confident" ? "确定" : value === "uncertain" ? "不确定" : "猜测"}</button>)}</span></div>
                </article>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
