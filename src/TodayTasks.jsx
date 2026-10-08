import { useEffect, useRef, useState } from "react";
import { postgraduateResources } from "./library";
import {
  REVIEW_TASKS_UPDATED,
  addCalendarDays,
  localDateKey,
  skipReviewTask,
} from "./readingReview";
import { listCustomPdfs } from "./storage";
import ReviewTaskCard from "./ReviewTaskCard";
import Icon from "./ui/Icon";
import ModalShell from "./ui/Overlay";
import StudyPlannerPanel from "./StudyPlannerPanel";
import LearningArchiveModal from "./LearningArchiveModal";
import ClozeLearningArchiveModal from "./ClozeLearningArchiveModal";
import { skipClozeReviewTask } from "./clozeReview";
import {
  buildTodayTasks,
  scanLearningState,
} from "./todayTasks";
import {
  buildPlanState,
} from "./studyPlannerSources";
import {
  STUDY_PLAN_UPDATED,
} from "./studyPlanner";
import {
  deferPlanTask,
  loadPlanState,
  reincludePlanTask,
  setPlanBudget,
} from "./studyPlannerStorage";
import { getTelemetry } from "./telemetry/telemetry";
import { AppEvent } from "./events/eventTypes";

const PLANNER_REFRESH_EVENTS = [
  REVIEW_TASKS_UPDATED,
  AppEvent.LEARNING_RECORDS_UPDATED,
  AppEvent.UNKNOWN_WORDS_UPDATED,
  AppEvent.RANK_UPDATED,
  AppEvent.LEARNING_STATE_INVALIDATED,
  STUDY_PLAN_UPDATED,
  AppEvent.DEEP_TRANSLATION_UPDATED,
];

function recordTelemetry(eventType, metadata = {}) {
  try {
    getTelemetry().recordEvent({
      eventType,
      taskType: "planner",
      status: "run",
      metadata,
    });
  } catch {
    // Telemetry 故障绝不影响 Planner 与首页。
  }
}

function midnightDelay(now = Date.now()) {
  const date = new Date(now);
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 1, 0);
  return Math.max(1000, next.getTime() - now);
}

export default function TodayTasks({
  onReady,
  onOpenResource,
  onStartReview,
  onStartClozeReview,
  onStateChange,
  onBrowseLibrary,
  onOpenVocabularyReview,
}) {
  const [today, setToday] = useState(() => localDateKey());
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planFailed, setPlanFailed] = useState(false);
  const [data, setData] = useState(() => buildTodayTasks(
    scanLearningState({ force: true }),
    { resources: postgraduateResources, customPdfs: [] },
  ));
  const [customPdfs, setCustomPdfs] = useState([]);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [clozeArchiveOpen, setClozeArchiveOpen] = useState(false);
  const [archiveHubOpen, setArchiveHubOpen] = useState(false);
  const customPdfsRef = useRef(customPdfs);
  const todayRef = useRef(today);
  todayRef.current = today;

  function refreshData(scan) {
    const next = buildTodayTasks(
      scan,
      { resources: postgraduateResources, customPdfs: customPdfsRef.current },
    );
    setData(next);
  }

  async function refreshPlan(scan) {
    setPlanLoading(true);
    setPlanFailed(false);
    try {
      const { plan: nextPlan } = await buildPlanState({
        today: todayRef.current,
        resources: postgraduateResources,
        customPdfs: customPdfsRef.current,
        scan,
      });
      setPlan(nextPlan);
      if (nextPlan.overBudgetMinutes > 0) {
        recordTelemetry("planner.over_budget", {
          overBudgetMinutes: nextPlan.overBudgetMinutes,
        });
      }
    } catch (error) {
      console.error("Study Planner 生成失败", error);
      setPlanFailed(true);
    } finally {
      setPlanLoading(false);
    }
  }

  function retryPlan() {
    const scan = scanLearningState({ force: true });
    refreshData(scan);
    refreshPlan(scan);
  }

  async function reloadCustomPdfs() {
    const records = await listCustomPdfs();
    customPdfsRef.current = records;
    setCustomPdfs(records);
    const scan = scanLearningState({ force: true });
    refreshData(scan);
    refreshPlan(scan);
  }

  useEffect(() => {
    let active = true;
    listCustomPdfs().then((records) => {
      if (!active) return;
      customPdfsRef.current = records;
      setCustomPdfs(records);
      const scan = scanLearningState({ force: true });
      refreshData(scan);
      refreshPlan(scan);
    });

    const handleFocus = () => {
      const scan = scanLearningState({ force: true });
      refreshData(scan);
      refreshPlan(scan);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") handleFocus();
    };
    const handleReviewUpdate = () => {
      const scan = scanLearningState();
      refreshData(scan);
      refreshPlan(scan);
    };
    const handleAccount = () => {
      setPendingOpen(false);
      setArchiveOpen(false);
      setClozeArchiveOpen(false);
      setArchiveHubOpen(false);
      setToday(localDateKey());
      setCustomPdfs([]);
      customPdfsRef.current = [];
      const scan = scanLearningState({ force: true });
      refreshData(scan);
      refreshPlan(scan);
      listCustomPdfs().then((records) => {
        customPdfsRef.current = records;
        setCustomPdfs(records);
        const nextScan = scanLearningState({ force: true });
        refreshData(nextScan);
        refreshPlan(nextScan);
      });
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    for (const eventName of PLANNER_REFRESH_EVENTS) {
      window.addEventListener(eventName, handleReviewUpdate);
    }
    window.addEventListener("wuliao:account-changed", handleAccount);

    let midnightTimer = 0;
    const armMidnight = () => {
      window.clearTimeout(midnightTimer);
      midnightTimer = window.setTimeout(() => {
        setToday(localDateKey());
        handleFocus();
        armMidnight();
      }, midnightDelay());
    };
    armMidnight();

    return () => {
      active = false;
      window.clearTimeout(midnightTimer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
      for (const eventName of PLANNER_REFRESH_EVENTS) {
        window.removeEventListener(eventName, handleReviewUpdate);
      }
      window.removeEventListener("wuliao:account-changed", handleAccount);
    };
  }, []);

  useEffect(() => {
    onStateChange?.({ ...data, plan });
  }, [data, onStateChange, plan]);

  useEffect(() => {
    if (!planLoading) onReady?.();
  }, [onReady, planLoading]);

  function findResource(resourceId) {
    return postgraduateResources.find((item) => item.id === resourceId)
      || customPdfsRef.current.find((item) => item.id === resourceId)
      || null;
  }

  function handleSetBudget(minutes) {
    const result = setPlanBudget(today, minutes, { confirmed: true });
    recordTelemetry("planner.budget_changed", { budgetMinutes: result.budgetMinutes });
    refreshPlan(scanLearningState());
  }

  function handleClearBudget() {
    const result = setPlanBudget(today, null, { confirmed: false });
    recordTelemetry("planner.budget_changed", { budgetMinutes: null, confirmed: false });
    refreshPlan(scanLearningState());
  }

  function handleUseYesterday() {
    const yesterdayState = loadPlanState(addCalendarDays(today, -1));
    if (yesterdayState?.budgetMinutes != null) handleSetBudget(yesterdayState.budgetMinutes);
  }

  function handleDefer(candidate) {
    deferPlanTask(today, candidate.id);
    recordTelemetry("planner.task_deferred", { taskId: candidate.id, type: candidate.type });
    refreshPlan(scanLearningState());
  }

  function handleReinclude(candidate) {
    reincludePlanTask(today, candidate.id);
    refreshPlan(scanLearningState());
  }

  function handleSkip(candidate) {
    const taskKey = candidate.metadata?.taskKey || candidate.metadata?.task?.taskKey;
    if (!taskKey) return;
    const message = candidate.type === "cloze-review"
      ? "确认跳过这次完形复习？原有作答与分析不会受到影响。"
      : "确认跳过这次复读？原有精读记录不会受到影响。";
    if (!window.confirm(message)) return;
    const result = candidate.type === "cloze-review"
      ? skipClozeReviewTask(taskKey)
      : skipReviewTask(taskKey);
    if (!result || result.ok === false) return;
    const scan = scanLearningState({ force: true });
    refreshData(scan);
    refreshPlan(scan);
  }

  function handleStart(candidate) {
    recordTelemetry("planner.task_started", { taskId: candidate.id, type: candidate.type });
    const action = candidate.action || {};
    if (action.type === "review") {
      onStartReview(candidate.metadata?.task);
      return;
    }
    if (action.type === "cloze-review") {
      onStartClozeReview(candidate.metadata?.task);
      return;
    }
    if (action.type === "continue-reading") {
      const resource = findResource(action.resourceId);
      if (resource) onOpenResource(resource);
      return;
    }
    if (action.type === "learning-review") {
      setArchiveOpen(true);
      return;
    }
    if (action.type === "vocabulary-review") {
      onOpenVocabularyReview?.();
      return;
    }
    if (action.type === "new-reading") {
      onBrowseLibrary();
    }
  }

  const yesterdayBudget = (() => {
    const state = loadPlanState(addCalendarDays(today, -1));
    return state?.budgetMinutes != null ? state.budgetMinutes : null;
  })();

  return (
    <section className="today-tasks" aria-label="今日任务">
      <StudyPlannerPanel
        plan={plan}
        today={today}
        yesterdayBudget={yesterdayBudget}
        loading={planLoading}
        planFailed={planFailed}
        onRetryPlan={retryPlan}
        onSetBudget={handleSetBudget}
        onClearBudget={handleClearBudget}
        onUseYesterday={handleUseYesterday}
        onDefer={handleDefer}
        onReinclude={handleReinclude}
        onSkip={handleSkip}
        onStart={handleStart}
        onBrowseLibrary={onBrowseLibrary}
      />

      <div className="today-support-links" aria-label="学习记录入口">
        <ReviewTaskCard onStartReview={onStartReview} hideWhenEmpty triggerOnly />
        {data.pendingGroups.length > 0 && (
          <button type="button" className="today-support-link" onClick={() => setPendingOpen(true)}>
            待复盘 <span>{data.pendingGroups.reduce((sum, group) => sum + group.difficultCount + group.questionCount, 0)}</span>
          </button>
        )}
        <button type="button" className="today-support-link today-archive-link" onClick={() => setArchiveHubOpen(true)}>
          <Icon name="review" size={18} />学习档案
        </button>
      </div>

      {pendingOpen && (
        <div className="review-plan-backdrop" onClick={() => setPendingOpen(false)}>
          <div
            className="review-plan-modal"
            role="dialog"
            aria-modal="true"
            aria-label="待复盘列表"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div><small>PENDING REVIEW LIST</small><h2>待复盘列表</h2></div>
              <button type="button" className="icon-button" onClick={() => setPendingOpen(false)} aria-label="关闭待复盘列表">×</button>
            </header>
            <section className="review-plan-section">
              <h3>按文章分组 <span>{data.pendingGroups.length}</span></h3>
              <div className="review-plan-list">
                {data.pendingGroups.map((group) => (
                  <div className="review-plan-row" key={`${group.resourceId}:${group.passageId}`}>
                    <div>
                      <strong>{group.title}</strong>
                      <span>困难句 {group.difficultCount} · 阅读题 {group.questionCount}</span>
                    </div>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => {
                        setPendingOpen(false);
                        const resource = findResource(group.resourceId);
                        if (resource) {
                          onOpenResource(resource, {
                            summaryInitially: true,
                            reviewTab: true,
                          });
                        }
                      }}
                    >
                      进入文章复习
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}

      {archiveOpen && (
        <LearningArchiveModal onClose={() => setArchiveOpen(false)} />
      )}
      {clozeArchiveOpen && (
        <ClozeLearningArchiveModal onClose={() => setClozeArchiveOpen(false)} onStartReview={onStartClozeReview} />
      )}
      {archiveHubOpen && (
        <ModalShell open onClose={() => setArchiveHubOpen(false)} className="archive-hub-backdrop" label="学习档案入口">
          <div className="archive-hub">
            <header>
              <div><small>LEARNING ARCHIVE</small><h2>学习档案</h2></div>
              <button type="button" className="icon-button" onClick={() => setArchiveHubOpen(false)} aria-label="关闭学习档案入口">×</button>
            </header>
            <p>阅读与完形档案继续使用各自的数据记录，在这里统一进入。</p>
            <div className="archive-hub-actions">
              <button type="button" onClick={() => { setArchiveHubOpen(false); setArchiveOpen(true); }}>阅读档案</button>
              <button type="button" onClick={() => { setArchiveHubOpen(false); setClozeArchiveOpen(true); }}>完形档案</button>
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
