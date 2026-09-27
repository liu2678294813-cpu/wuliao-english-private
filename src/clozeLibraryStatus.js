// 完形资料卡学习状态 —— 纯派生 read model。
//
// 原则：
//   - 不新增"完形卡片状态"存储，不解析任何正文 / 官方完形 JSON。
//   - 只轻量扫描 cloze-flow / cloze-progress / cloze-review-task 三个前缀，
//     一次遍历 → Map，供官方与自定义卡片共用。
//   - 状态优先级：进行中的复习 > 逾期 / 今日到期的 D+1 / D+7 > 训练进行中 >
//     已完成 / 已稳定 > 尚未开始。
//   - 无官方答案资料只显示阶段与任务事实，绝不出现正确率 / 错题 / 对错。

import { getCurrentUsername, listUserItems } from "./userData";
import {
  CLOZE_STAGE_LABELS,
  isClozeWorkflowCompleted,
  normalizeClozeFlow,
} from "./clozeFlow";
import {
  TASK_TYPE_D1,
  TASK_TYPE_D7,
  clozeReviewTaskStatus,
  listClozeReviewTasks,
} from "./clozeReview";
import { localDateKey } from "./readingReview";

export const CLOZE_FLOW_PREFIX = "wuliao:cloze-flow:";
export const CLOZE_PROGRESS_PREFIX = "wuliao:cloze-progress:";

export const CLOZE_CARD_STATE = Object.freeze({
  REVIEW_IN_PROGRESS: "review-in-progress",
  REVIEW_DUE: "review-due",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  NOT_STARTED: "not-started",
});

export function parseClozeFlowKey(rest) {
  if (!rest) return null;
  const separator = String(rest).indexOf(":");
  if (separator <= 0 || separator >= String(rest).length - 1) return null;
  return {
    resourceId: String(rest).slice(0, separator),
    clozeId: String(rest).slice(separator + 1),
  };
}

// 单篇完形的资料卡状态（纯函数，输入全部显式注入）。
export function deriveClozeCardStatus({
  flow = null,
  progress = null,
  reviewTasks = [],
  resource = null,
  today = localDateKey(),
}) {
  const resourceId = String(resource?.id || "");
  const tasks = (reviewTasks || []).filter((task) => (
    String(task.resourceId || "") === resourceId
  ));
  const completed = isClozeWorkflowCompleted(flow);
  const currentStage = completed ? "" : String(flow?.currentStage || "");

  const attempts = progress?.attempts || {};
  const blankNumbers = Object.keys(attempts)
    .map(Number)
    .filter((number) => Number.isInteger(number) && number >= 1);
  const analyzedCount = blankNumbers.filter((number) => attempts[number]?.analyzed).length;
  const totalBlanks = blankNumbers.length
    || resource?.analysis?.clozes?.[0]?.blanks?.length
    || null;

  const inProgressTask = tasks.find((task) => clozeReviewTaskStatus(task, today) === "in_progress") || null;
  const dueTasks = tasks.filter((task) => {
    const status = clozeReviewTaskStatus(task, today);
    return status === "due" || status === "overdue";
  });
  const dueD1 = dueTasks.find((task) => task.type === TASK_TYPE_D1) || null;
  const dueD7 = dueTasks.find((task) => task.type === TASK_TYPE_D7) || null;

  const stageLabel = CLOZE_STAGE_LABELS[currentStage] || currentStage;
  let state = CLOZE_CARD_STATE.NOT_STARTED;
  let label = "尚未开始";
  let dueLabel = null;
  let stable = false;

  if (inProgressTask) {
    state = CLOZE_CARD_STATE.REVIEW_IN_PROGRESS;
    label = `进行中 · ${inProgressTask.type === TASK_TYPE_D7 ? "D+7" : "D+1"} 复习`;
  } else if (dueD1 || dueD7) {
    state = CLOZE_CARD_STATE.REVIEW_DUE;
    const countOf = (task) => (task?.targetBlankIds || []).length;
    const parts = [];
    if (dueD1) parts.push(`D+1 待复习 · ${countOf(dueD1)} 空`);
    if (dueD7) parts.push(`D+7 待复习 · ${countOf(dueD7)} 空`);
    label = parts.join(" · ");
    dueLabel = label;
  } else if (completed) {
    state = CLOZE_CARD_STATE.COMPLETED;
    const d7 = tasks.find((task) => task.type === TASK_TYPE_D7);
    const allCompleted = tasks.length > 0
      && tasks.every((task) => clozeReviewTaskStatus(task, today) === "completed");
    stable = Boolean(d7 && allCompleted);
    label = stable ? "✓ 已完成 · 已稳定" : "✓ 已完成";
  } else if (flow) {
    state = CLOZE_CARD_STATE.IN_PROGRESS;
    if (currentStage === "cloze-analysis") {
      const total = totalBlanks || blankNumbers.length;
      label = total ? `进行中 · 逐空精析 ${analyzedCount}/${total}` : "进行中 · 逐空精析";
    } else {
      label = `进行中 · ${stageLabel || "训练中"}`;
    }
  }

  return {
    resourceId,
    state,
    label,
    dueLabel,
    currentStage,
    stageLabel,
    analyzedCount,
    totalBlanks,
    hasFlow: Boolean(flow),
    hasProgress: Boolean(progress),
    stable,
    completed,
  };
}

// 一次轻量扫描 → Map<resourceId, cardStatus>。只读三个前缀，不加载完形 JSON。
export function scanClozeLibraryStatuses({
  resources,
  username = getCurrentUsername(),
  today = localDateKey(),
}) {
  const result = new Map();
  if (!username || !Array.isArray(resources) || !resources.length) return result;

  const flows = new Map();
  const progresses = new Map();
  try {
    for (const { key, value } of listUserItems(CLOZE_FLOW_PREFIX, username)) {
      const ids = parseClozeFlowKey(String(key || "").slice(CLOZE_FLOW_PREFIX.length));
      if (!ids) continue;
      try {
        const flow = normalizeClozeFlow(JSON.parse(String(value || "")));
        if (flow) flows.set(ids.resourceId, flow);
      } catch {
        // 忽略损坏记录
      }
    }
    for (const { key, value } of listUserItems(CLOZE_PROGRESS_PREFIX, username)) {
      const ids = parseClozeFlowKey(String(key || "").slice(CLOZE_PROGRESS_PREFIX.length));
      if (!ids) continue;
      try {
        const progress = JSON.parse(String(value || ""));
        if (progress && typeof progress === "object") progresses.set(ids.resourceId, progress);
      } catch {
        // 忽略损坏记录
      }
    }
  } catch {
    // 读取失败时返回已有结果
  }

  const reviewTasks = listClozeReviewTasks(username);
  for (const resource of resources) {
    result.set(resource.id, deriveClozeCardStatus({
      flow: flows.get(String(resource.id)) || null,
      progress: progresses.get(String(resource.id)) || null,
      reviewTasks,
      resource,
      today,
    }));
  }
  return result;
}
