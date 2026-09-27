import { useState } from "react";
import { TASK_TYPE_CLOZE_REVIEW, TASK_TYPE_EXAM_FOLLOWUP, TASK_TYPE_REVIEW } from "./studyPlanner";

const BUDGET_PRESETS = [30, 60, 90, 120];

function actionLabel(candidate) {
  // 2026-08-13 UI 统一：只统一“进入某项学习内容”的主 CTA；管理动作不在此统一。
  return "学习";
}

function PlannerTaskRow({ candidate, onStart, onDefer, onSkip }) {
  const canSkip = candidate.type === TASK_TYPE_REVIEW || candidate.type === TASK_TYPE_CLOZE_REVIEW || candidate.type === TASK_TYPE_EXAM_FOLLOWUP;
  return (
    <article className="planner-task-row">
      <div className="planner-task-main">
        <strong>{candidate.title}</strong>
        <span className="planner-task-subtitle">
          {candidate.subtitle}
          {candidate.statusLabel ? ` · ${candidate.statusLabel}` : ""}
        </span>
        <small className="planner-task-reason">{candidate.reasonText}</small>
      </div>
      <div className="planner-task-side">
        <span className="planner-task-estimate">预计 {candidate.estimatedMinutes} 分钟</span>
        <div className="planner-task-actions">
          <button type="button" className="primary-button" onClick={() => onStart(candidate)}>
            {actionLabel(candidate)}
          </button>
          <button
            type="button"
            className="planner-defer-button"
            onClick={() => onDefer(candidate)}
            title="今天暂不安排（不影响真实学习状态）"
          >
            今天暂不安排
          </button>
          {canSkip && (
            <button type="button" className="planner-skip-button" onClick={() => onSkip(candidate)}>
              {candidate.type === TASK_TYPE_EXAM_FOLLOWUP ? (candidate.metadata?.status === "started" ? "标记完成" : "忽略") : "跳过本次"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function PlannerOverflowRow({ candidate, onDefer, onSkip }) {
  const canSkip = candidate.type === TASK_TYPE_REVIEW || candidate.type === TASK_TYPE_CLOZE_REVIEW || candidate.type === TASK_TYPE_EXAM_FOLLOWUP;
  return (
    <article className="planner-task-row is-overflow">
      <div className="planner-task-main">
        <strong>{candidate.title}</strong>
        <span className="planner-task-subtitle">
          {candidate.subtitle}
          {candidate.statusLabel ? ` · ${candidate.statusLabel}` : ""}
        </span>
        <small className="planner-task-reason">{candidate.reasonText}</small>
      </div>
      <div className="planner-task-side">
        <span className="planner-task-estimate">预计 {candidate.estimatedMinutes} 分钟</span>
        <button
          type="button"
          className="planner-defer-button"
          onClick={() => onDefer(candidate)}
          title="今天暂不安排（不影响真实学习状态）"
        >
          今天暂不安排
        </button>
        {canSkip && (
          <button type="button" className="planner-skip-button" onClick={() => onSkip(candidate)}>
            {candidate.type === TASK_TYPE_EXAM_FOLLOWUP ? (candidate.metadata?.status === "started" ? "标记完成" : "忽略") : "跳过本次"}
          </button>
        )}
      </div>
    </article>
  );
}

function DeferredRow({ candidate, onReinclude }) {
  return (
    <article className="planner-task-row is-deferred">
      <div className="planner-task-main">
        <strong>{candidate.title}</strong>
        <span className="planner-task-subtitle">{candidate.subtitle}</span>
      </div>
      <div className="planner-task-side">
        <button type="button" className="primary-button" onClick={() => onReinclude(candidate)}>
          重新加入
        </button>
      </div>
    </article>
  );
}

export default function StudyPlannerPanel({
  plan,
  today,
  yesterdayBudget,
  loading = false,
  planFailed = false,
  onRetryPlan = null,
  onSetBudget,
  onClearBudget,
  onUseYesterday,
  onDefer,
  onReinclude,
  onSkip,
  onStart,
  onBrowseLibrary,
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [blockedOpen, setBlockedOpen] = useState(false);

  if (loading) {
    return (
      <section className="study-planner" aria-label="今日计划">
        <div className="today-tasks-heading">
          <div>
            <small>STUDY PLAN</small>
            <h2>今日计划</h2>
          </div>
        </div>
        <div className="today-tasks-empty">正在生成今日学习计划…</div>
      </section>
    );
  }
  if (!plan) {
    return (
      <section className="study-planner" aria-label="今日计划">
        <div className="today-tasks-heading">
          <div>
            <small>STUDY PLAN</small>
            <h2>今日计划</h2>
          </div>
        </div>
        <div className="today-tasks-empty">
          今日计划生成失败，请稍后重试或刷新页面。
          {planFailed && onRetryPlan && (
            <button type="button" className="primary-button today-plan-retry" onClick={onRetryPlan}>
              重新生成
            </button>
          )}
        </div>
      </section>
    );
  }

  const confirmed = plan.budgetConfirmed;
  const unlimited = confirmed && plan.budgetMinutes == null;
  const finite = confirmed && plan.budgetMinutes != null;
  const overBudget = finite && plan.overBudgetMinutes > 0;
  const selectedPreset = finite ? BUDGET_PRESETS.includes(plan.budgetMinutes) : false;
  const completedCount = plan.completed?.length || 0;
  const activeCount = plan.planned.length + plan.overflow.length;
  const blockedCount = plan.blocked?.length || 0;
  const continueCandidate = plan.planned.find((candidate) => candidate.type === "continue-reading")
    || plan.overflow.find((candidate) => candidate.type === "continue-reading")
    || null;
  const visiblePlanned = plan.planned.filter((candidate) => candidate !== continueCandidate);
  const visibleOverflow = plan.overflow.filter((candidate) => candidate !== continueCandidate);

  const budgetLabel = () => {
    if (!confirmed) return "未设置预算 · 当前为推荐顺序";
    if (unlimited) return `今天不限制 · 已安排 ${plan.plannedMinutes} 分钟`;
    return `已安排 ${plan.plannedMinutes} 分钟 · 剩余 ${plan.remainingMinutes} 分钟`;
  };

  function handleCustomSubmit() {
    const minutes = Math.round(Number(customValue));
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 480) return;
    onSetBudget(minutes);
    setCustomOpen(false);
    setCustomValue("");
  }

  function handleDefer(candidate) {
    if (candidate.mandatory) {
      const ok = window.confirm(
        `「${candidate.title}」仍处于${candidate.overdueDays > 0 ? "逾期/到期" : "到期"}状态，只是不再计入今天当前计划，不会改变真实学习记录。确定今天暂不安排？`,
      );
      if (!ok) return;
    }
    onDefer(candidate);
  }

  return (
    <section className="study-planner" aria-label="今日计划">
      <div className="today-tasks-heading study-planner-heading">
        <div>
          <small>STUDY PLAN</small>
          <h2>今日计划</h2>
        </div>
        <span className="study-planner-date">{today}</span>
      </div>

      <div className="study-planner-budget">
        <div className="study-planner-budget-line">
          <strong>{confirmed ? "今天可学习" : "设置今天可用时间"}</strong>
          {confirmed && (
            <button type="button" className="today-more-link" onClick={onClearBudget}>
              清除今日预算
            </button>
          )}
          {yesterdayBudget != null && !confirmed && (
            <button type="button" className="today-more-link" onClick={onUseYesterday}>
              沿用昨天 {yesterdayBudget} 分钟
            </button>
          )}
        </div>
        <div className="study-planner-budget-options" role="group" aria-label="时间预算">
          {BUDGET_PRESETS.map((minutes) => (
            <button
              type="button"
              key={minutes}
              className={finite && plan.budgetMinutes === minutes ? "active" : ""}
              onClick={() => onSetBudget(minutes)}
            >
              {minutes} 分钟
            </button>
          ))}
          <button
            type="button"
            className={customOpen || (finite && !selectedPreset) ? "active" : ""}
            onClick={() => setCustomOpen((value) => !value)}
          >
            自定义{finite && !selectedPreset ? ` · ${plan.budgetMinutes}` : ""}
          </button>
          <button
            type="button"
            className={unlimited ? "active" : ""}
            onClick={() => onSetBudget(null)}
          >
            不限制
          </button>
        </div>
        {customOpen && (
          <div className="study-planner-custom">
            <input
              type="number"
              min="5"
              max="480"
              step="5"
              value={customValue}
              placeholder="5–480 分钟"
              onChange={(event) => setCustomValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleCustomSubmit();
              }}
              aria-label="自定义学习分钟数"
            />
            <button type="button" className="primary-button" onClick={handleCustomSubmit}>
              确定
            </button>
          </div>
        )}
      </div>

      <div className={`study-planner-summary ${overBudget ? "is-over-budget" : ""}`}>
        <span>{budgetLabel()}</span>
        {completedCount > 0 && <span>今日已完成 {completedCount} 项</span>}
        {activeCount > 0 && <span>待完成 {activeCount} 项</span>}
      </div>

      {overBudget && (
        <p className="study-planner-over-budget" role="status">
          今日优先任务预计 {plan.plannedMinutes} 分钟，超过你的 {plan.budgetMinutes} 分钟预算{" "}
          {plan.overBudgetMinutes} 分钟。强制任务不会因此被隐藏。
        </p>
      )}

      {plan.planned.length === 0 && plan.overflow.length === 0 && plan.deferred.length === 0 ? (
        <div className="today-tasks-empty planner-empty-state">
          <p>今天没有待办，挑一篇安静读完。后续进度与复盘会自动回到这里。</p>
          {onBrowseLibrary && (
            <button type="button" className="today-library-cta" onClick={onBrowseLibrary}>
              去资料库
            </button>
          )}
        </div>
      ) : (
        <div className="study-planner-sections">
          {continueCandidate && (
            <article className="planner-continue-card">
              <div className="planner-continue-main">
                <small>CONTINUE LEARNING</small>
                <h3>继续学习</h3>
                <strong>{continueCandidate.title}</strong>
                <span>{continueCandidate.subtitle}</span>
              </div>
              <div className="planner-continue-side">
                <span>预计 {continueCandidate.estimatedMinutes} 分钟</span>
                <div>
                  <button type="button" className="primary-button" onClick={() => onStart(continueCandidate)}>
                    学习
                  </button>
                  <button type="button" className="planner-defer-button" onClick={() => onDefer(continueCandidate)}>
                    今天暂不安排
                  </button>
                </div>
              </div>
            </article>
          )}

          {visiblePlanned.length > 0 && (
            <section className="study-planner-section">
              <h3>已安排</h3>
              <div className="study-planner-list">
                {visiblePlanned.map((candidate) => (
                  <PlannerTaskRow
                    key={candidate.id}
                    candidate={candidate}
                    onStart={onStart}
                    onDefer={handleDefer}
                    onSkip={onSkip}
                  />
                ))}
              </div>
            </section>
          )}

          {visibleOverflow.length > 0 && (
            <section className="study-planner-section">
              <h3>时间不足 · 未安排</h3>
              <div className="study-planner-list">
                {visibleOverflow.map((candidate) => (
                  <PlannerOverflowRow
                    key={candidate.id}
                    candidate={candidate}
                    onDefer={handleDefer}
                    onSkip={onSkip}
                  />
                ))}
              </div>
            </section>
          )}

          {plan.deferred.length > 0 && (
            <section className="study-planner-section">
              <h3>今天暂不安排</h3>
              <div className="study-planner-list">
                {plan.deferred.map((candidate) => (
                  <DeferredRow
                    key={candidate.id}
                    candidate={candidate}
                    onReinclude={onReinclude}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {blockedCount > 0 && (
        <section className="study-planner-blocked">
          <button
            type="button"
            className="study-planner-blocked-toggle"
            onClick={() => setBlockedOpen((value) => !value)}
            aria-expanded={blockedOpen}
          >
            为什么还不能做（{blockedCount}）
          </button>
          {blockedOpen && (
            <ul className="study-planner-blocked-list">
              {plan.blocked.slice(0, 5).map((item) => (
                <li key={item.id}>{item.blockedReason}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
