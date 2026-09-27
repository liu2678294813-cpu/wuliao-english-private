// 完形长期复习任务卡（首页）：展示 D+1 / D+7 待办。
//
// 独立于 Reading ReviewTaskCard：完形复习围绕 Blank，语义与阅读复读不同，
// 不往 Reading 组件里塞 cloze 分支。仅展示 sidecar 已存在的任务行，
// 不做任何全库扫描 / 现场推导。

import { useEffect, useMemo, useState } from "react";
import { postgraduateClozeResources } from "./library";
import { listCustomPdfs } from "./storage";
import { localDateKey } from "./readingReview";
import {
  CLOZE_REVIEW_TASKS_UPDATED,
  clozeOverdueDays,
  clozeReviewTaskStatus,
  listClozeReviewTasks,
  skipClozeReviewTask,
  TASK_TYPE_D7,
} from "./clozeReview";

export default function ClozeReviewTaskCard({ onStartClozeReview, hideWhenEmpty = false }) {
  const [tasks, setTasks] = useState([]);
  const [customTitles, setCustomTitles] = useState({});
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState("");
  const [today, setToday] = useState(() => localDateKey());

  function refresh() {
    setToday(localDateKey());
    setTasks(listClozeReviewTasks());
    listCustomPdfs()
      .then((records) => setCustomTitles(Object.fromEntries(records.map((record) => [record.id, record.title]))))
      .catch(() => {});
  }

  useEffect(() => {
    refresh();
    window.addEventListener(CLOZE_REVIEW_TASKS_UPDATED, refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("wuliao:account-changed", refresh);
    return () => {
      window.removeEventListener(CLOZE_REVIEW_TASKS_UPDATED, refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("wuliao:account-changed", refresh);
    };
  }, []);

  const statusItems = useMemo(
    () => tasks.map((task) => ({ task, status: clozeReviewTaskStatus(task, today) })),
    [tasks, today],
  );
  const todayItems = statusItems
    .filter(({ status }) => status === "in_progress" || status === "overdue" || status === "due")
    .sort((a, b) => String(a.task.dueDate).localeCompare(String(b.task.dueDate)));
  const upcomingCount = statusItems.filter(({ status }) => status === "scheduled").length;

  if (hideWhenEmpty && todayItems.length === 0 && upcomingCount === 0) return null;

  const label = (task) => {
    const official = postgraduateClozeResources.find((resource) => resource.id === task.resourceId);
    const title = official ? official.title : customTitles[task.resourceId];
    return title || "自定义完形资料";
  };

  function showNotice(message) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3200);
  }

  async function handleStart(task) {
    setBusyKey(task.taskKey);
    try {
      const opened = await onStartClozeReview(task);
      if (!opened) showNotice("无法打开该资料：原文尚未转换或已删除");
    } finally {
      setBusyKey("");
    }
  }

  function handleSkip(task) {
    if (!window.confirm("确认跳过这次完形复习？原有作答与分析不会受到影响。")) return;
    const result = skipClozeReviewTask(task.taskKey);
    if (!result.ok) showNotice(`跳过失败：${result.error || "存储空间不足"}`);
  }

  return (
    <section className="review-today-card is-compact" aria-label="完形复习">
      <div className="review-today-heading">
        <div>
          <small>CLOZE REVIEW TASKS</small>
          <h2>完形复习</h2>
        </div>
        {upcomingCount > 0 && <span className="review-plan-link">未来 {upcomingCount} 项已安排</span>}
      </div>
      {todayItems.length === 0 ? (
        <div className="review-today-empty">
          <p>今天没有到期的完形复习任务。</p>
          <small>完成完形训练后，D+1 / D+7 复习会自动出现在这里。</small>
        </div>
      ) : (
        <>
          <p className="review-today-count">今日待复习 {todayItems.length} 篇</p>
          <div className="review-today-list">
            {todayItems.slice(0, 3).map(({ task, status }) => (
              <article className="review-task-row" key={task.taskKey}>
                <div className="review-task-main">
                  <strong>{label(task)}</strong>
                  <span>
                    {task.type === TASK_TYPE_D7
                      ? `完形 D+7 确认 · ${task.targetBlankIds.length} 空`
                      : `完形 D+1 复习 · ${task.targetBlankIds.length} 空`}
                  </span>
                </div>
                <span className={`review-task-status ${status}`}>
                  {status === "in_progress"
                    ? "进行中"
                    : status === "overdue"
                      ? `已逾期 ${clozeOverdueDays(task, today)} 天`
                      : "今日到期"}
                </span>
                <div className="review-task-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busyKey === task.taskKey}
                    onClick={() => handleStart(task)}
                  >
                    {status === "in_progress" ? "继续复习" : "开始复习"}
                  </button>
                  <button type="button" className="review-skip-button" onClick={() => handleSkip(task)}>
                    跳过本次
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {notice && <div className="review-card-notice" role="status">{notice}</div>}
    </section>
  );
}
