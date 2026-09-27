import { useEffect, useMemo, useState } from "react";
import { postgraduateResources } from "./library";
import { listCustomPdfs } from "./storage";
import {
  homeReviewSummary,
  listReviewTasks,
  localDateKey,
  overdueDays,
  REVIEW_TASKS_UPDATED,
  reviewTaskStatus,
  skipReviewTask,
  TASK_TYPE_SENTENCE_RECHECK,
} from "./readingReview";

function officialLabel(resource) {
  if (!resource) return null;
  return `${resource.year} Text ${resource.text}`;
}

function ReviewPlanModal({ items, today, labels, onClose, onStart, busyKey }) {
  const todayStatuses = new Set(["in_progress", "overdue", "due"]);
  const todayItems = items
    .filter(({ status }) => todayStatuses.has(status))
    .sort((a, b) => String(a.task.dueDate).localeCompare(String(b.task.dueDate)));
  const futureItems = items
    .filter(({ status }) => status === "scheduled")
    .sort((a, b) => String(a.task.dueDate).localeCompare(String(b.task.dueDate)));
  const completedItems = items
    .filter(({ status }) => status === "completed")
    .sort((a, b) => (b.task.completedAt || 0) - (a.task.completedAt || 0));

  return (
    <div className="review-plan-backdrop" onClick={onClose}>
      <div className="review-plan-modal" role="dialog" aria-modal="true" aria-label="复读计划" onClick={(event) => event.stopPropagation()}>
        <header>
          <div><small>REVIEW PLAN</small><h2>复读计划</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭复读计划">×</button>
        </header>
        <section className="review-plan-section">
          <h3>今日 · 逾期 · 进行中 <span>{todayItems.length}</span></h3>
          {!todayItems.length ? (
            <p className="review-plan-empty">今天没有需要处理的复读任务。</p>
          ) : (
            <div className="review-plan-list">
              {todayItems.map(({ task, status }) => (
                <div className="review-plan-row" key={task.taskKey}>
                  <div>
                    <strong>{labels(task)}</strong>
                    <span>
                      {task.type === TASK_TYPE_SENTENCE_RECHECK
                        ? `困难句复查 · ${task.sentenceKeys.length} 句 · 到期 ${task.dueDate}`
                        : `次日复读 · 到期 ${task.dueDate}${status === "overdue" ? ` · 已逾期 ${overdueDays(task, today)} 天` : ""}`}
                    </span>
                  </div>
                  <button type="button" className="primary-button" disabled={busyKey === task.taskKey} onClick={() => onStart(task)}>
                    {status === "in_progress" ? "继续复读" : "开始复读"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="review-plan-section">
          <h3>未来安排 <span>{futureItems.length}</span></h3>
          {!futureItems.length ? (
            <p className="review-plan-empty">没有未来任务。未来任务只作安排展示，不计入欠债。</p>
          ) : (
            <div className="review-plan-list">
              {futureItems.slice(0, 30).map(({ task }) => (
                <div className="review-plan-row future" key={task.taskKey}>
                  <div>
                    <strong>{labels(task)}</strong>
                    <span>{task.type === TASK_TYPE_SENTENCE_RECHECK
                      ? `困难句复查 · ${task.sentenceKeys.length} 句`
                      : "次日复读"} · 到期 {task.dueDate}（未来安排）</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="review-plan-section">
          <h3>已完成 <span>{completedItems.length}</span></h3>
          {!completedItems.length ? (
            <p className="review-plan-empty">还没有完成的复读记录。</p>
          ) : (
            <div className="review-plan-list">
              {completedItems.slice(0, 30).map(({ task }) => (
                <div className="review-plan-row done" key={task.taskKey}>
                  <div>
                    <strong>{labels(task)}</strong>
                    <span>{task.type === TASK_TYPE_SENTENCE_RECHECK
                      ? `困难句复查 · ${task.sentenceKeys.length} 句`
                      : "次日复读"} · 完成于 {new Date(task.completedAt).toLocaleDateString("zh-CN")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function ReviewTaskCard({ onStartReview, hideWhenEmpty = false, compact = false, hideTodayList = false, triggerOnly = false }) {
  const [tasks, setTasks] = useState([]);
  const [customTitles, setCustomTitles] = useState({});
  const [planOpen, setPlanOpen] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState("");
  const [today, setToday] = useState(() => localDateKey());

  function refresh() {
    setToday(localDateKey());
    setTasks(listReviewTasks());
    listCustomPdfs()
      .then((records) => setCustomTitles(Object.fromEntries(records.map((record) => [record.id, record.title]))))
      .catch(() => {});
  }

  useEffect(() => {
    refresh();
    window.addEventListener(REVIEW_TASKS_UPDATED, refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("wuliao:account-changed", refresh);
    return () => {
      window.removeEventListener(REVIEW_TASKS_UPDATED, refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("wuliao:account-changed", refresh);
    };
  }, []);

  const summary = useMemo(() => homeReviewSummary(tasks, today), [tasks, today]);
  const statusItems = useMemo(
    () => tasks.map((task) => ({ task, status: reviewTaskStatus(task, today) })),
    [tasks, today],
  );
  if (
    hideWhenEmpty
    && summary.todayCount === 0
    && summary.upcomingCount === 0
    && summary.completedCount === 0
    && summary.skippedCount === 0
  ) {
    return null;
  }

  const labels = (task) => {
    const official = postgraduateResources.find((resource) => resource.id === task.resourceId);
    const label = official ? officialLabel(official) : customTitles[task.resourceId];
    return label || "自定义资料";
  };

  function showNotice(message) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3200);
  }

  async function handleStart(task) {
    setBusyKey(task.taskKey);
    try {
      const opened = await onStartReview(task);
      if (!opened) showNotice("无法打开该资料：原文尚未转换或已删除");
    } finally {
      setBusyKey("");
    }
  }

  function handleSkip(task) {
    if (!window.confirm("确认跳过这次复读？原有精读记录不会受到影响。")) return;
    const result = skipReviewTask(task.taskKey);
    if (!result.ok) showNotice(`跳过失败：${result.error || "存储空间不足"}`);
  }

  if (triggerOnly) {
    return (
      <>
        <button type="button" className="today-support-link" onClick={() => setPlanOpen(true)}>
          复读安排{summary.upcomingCount > 0 ? ` · ${summary.upcomingCount}` : ""}
        </button>
        {planOpen && (
          <ReviewPlanModal
            items={statusItems}
            today={today}
            labels={labels}
            onClose={() => setPlanOpen(false)}
            onStart={handleStart}
            busyKey={busyKey}
          />
        )}
      </>
    );
  }

  return (
    <section className={`review-today-card ${compact ? "is-compact" : ""}`} aria-label="今日复读">
      <div className="review-today-heading">
        <div>
          <small>REVIEW TASKS</small>
          <h2>今日复读</h2>
        </div>
        <button type="button" className="review-plan-link" onClick={() => setPlanOpen(true)}>
          复读计划{summary.upcomingCount > 0 ? ` · ${summary.upcomingCount}` : ""}
        </button>
      </div>

      {hideTodayList ? (
        summary.todayCount > 0 ? (
          <p className="review-today-count">今日待复读 {summary.todayCount} 篇，已列入今日计划</p>
        ) : (
          <div className="review-today-empty">
            <p>今天没有到期的复读任务。</p>
            {summary.upcomingCount > 0 && <small>未来 {summary.upcomingCount} 个任务已安排，见「复读计划」。</small>}
          </div>
        )
      ) : !summary.todayCount ? (
        <div className="review-today-empty">
          <p>今天没有到期的复读任务。</p>
          {summary.upcomingCount > 0 && <small>未来 {summary.upcomingCount} 个任务已安排，见「复读计划」。</small>}
        </div>
      ) : (
        <>
          <p className="review-today-count">今日待复读 {summary.todayCount} 篇</p>
          <div className="review-today-list">
            {summary.todayItems.slice(0, 3).map(({ task, status }) => (
              <article className="review-task-row" key={task.taskKey}>
                <div className="review-task-main">
                  <strong>{labels(task)}</strong>
                  <span>
                    {task.type === TASK_TYPE_SENTENCE_RECHECK
                      ? `困难句复查 · ${task.sentenceKeys.length} 句`
                      : "次日复读 · 预计 10–15 分钟"}
                  </span>
                </div>
                <span className={`review-task-status ${status}`}>
                  {status === "in_progress"
                    ? "进行中"
                    : status === "overdue"
                      ? `已逾期 ${overdueDays(task, today)} 天`
                      : "今日到期"}
                </span>
                <div className="review-task-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busyKey === task.taskKey}
                    onClick={() => handleStart(task)}
                  >
                    {status === "in_progress" ? "继续复读" : "开始复读"}
                  </button>
                  <button type="button" className="review-skip-button" onClick={() => handleSkip(task)}>
                    跳过本次复读
                  </button>
                </div>
              </article>
            ))}
          </div>
          {summary.todayCount > 3 && (
            <p className="review-more-note">还有 {summary.todayCount - 3} 篇，见「复读计划」。</p>
          )}
        </>
      )}

      {notice && <div className="review-card-notice" role="status">{notice}</div>}
      {planOpen && (
        <ReviewPlanModal
          items={statusItems}
          today={today}
          labels={labels}
          onClose={() => setPlanOpen(false)}
          onStart={handleStart}
          busyKey={busyKey}
        />
      )}
    </section>
  );
}
