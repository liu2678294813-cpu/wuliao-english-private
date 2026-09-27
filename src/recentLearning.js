// 首页"最近学习"统一派生：精读 + 完形训练 + 完形复习。
//
// 原则：
//   - 不新增完成事实存储，不解析正文 / 官方完形 JSON。
//   - 时间源：阅读 progress.updatedAt；完形 flow.updatedAt /
//     cloze-final-read.completedAt；复习 task.updatedAt / attempts.reviewedAt。
//   - 已删除的自定义资源不产生 ghost 项（只统计传入的现有资源集合）。
//   - 同一资源多个 recent 事件取最新一个；最后按 updatedAt 混排截断。

import { getCurrentUsername, listUserItems } from "./userData";
import { getRecentProgress } from "./library";
import { CLOZE_STAGE_LABELS, normalizeClozeFlow } from "./clozeFlow";
import { listClozeReviewTasks } from "./clozeReview";
import { listCompletedClozeRecords } from "./clozeLearningArchive";

export const CLOZE_FLOW_PREFIX = "wuliao:cloze-flow:";

function parseFlowKey(rest) {
  if (!rest) return null;
  const separator = String(rest).indexOf(":");
  if (separator <= 0 || separator >= String(rest).length - 1) return null;
  return {
    resourceId: String(rest).slice(0, separator),
    clozeId: String(rest).slice(separator + 1),
  };
}

// 轻量扫描完形 flow（只读 key + 阶段状态，不加载正文）。
export function scanClozeFlows(username = getCurrentUsername()) {
  const flows = new Map();
  if (!username) return flows;
  try {
    for (const { key, value } of listUserItems(CLOZE_FLOW_PREFIX, username)) {
      const ids = parseFlowKey(String(key || "").slice(CLOZE_FLOW_PREFIX.length));
      if (!ids) continue;
      try {
        const flow = normalizeClozeFlow(JSON.parse(String(value || "")));
        if (flow) flows.set(ids.resourceId, flow);
      } catch {
        // 忽略损坏记录
      }
    }
  } catch {
    // 读取失败返回已有结果
  }
  return flows;
}

// 统一最近学习流：reading / cloze-training / cloze-review 三种条目。
export function buildRecentLearning({
  resources = [],
  customResources = [],
  limit = 3,
  excludeResourceIds = [],
  username = getCurrentUsername(),
}) {
  const allResources = [...resources, ...customResources];
  const byResource = new Map();
  const record = (item) => {
    const existing = byResource.get(item.resource.id);
    if (!existing || item.updatedAt > existing.updatedAt) byResource.set(item.resource.id, item);
  };

  for (const { resource, progress } of getRecentProgress()) {
    record({
      type: "reading",
      resource,
      progress,
      updatedAt: Number(progress.updatedAt) || 0,
    });
  }

  for (const [resourceId, flow] of scanClozeFlows(username)) {
    const resource = allResources.find((item) => String(item.id) === resourceId);
    if (!resource) continue;
    record({
      type: "cloze-training",
      resource,
      flow,
      stageLabel: CLOZE_STAGE_LABELS[flow.currentStage] || flow.currentStage || "",
      updatedAt: Number(flow.updatedAt) || 0,
    });
  }

  for (const task of listClozeReviewTasks(username)) {
    const resource = allResources.find((item) => String(item.id) === String(task.resourceId));
    if (!resource) continue;
    const reviewedTimes = Object.values(task.attempts || {})
      .map((attempt) => Number(attempt?.reviewedAt) || 0);
    record({
      type: "cloze-review",
      resource,
      task,
      updatedAt: Math.max(Number(task.updatedAt) || 0, ...reviewedTimes),
    });
  }

  const excluded = new Set((excludeResourceIds || []).map(String));
  return [...byResource.values()]
    .filter((item) => !excluded.has(String(item.resource.id)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

// 已完成完形数量（official + custom，过滤已删除资源 ghost count）。
export function completedClozeCount({
  resources = [],
  customResources = [],
  username = getCurrentUsername(),
}) {
  const valid = new Set([...resources, ...customResources].map((item) => String(item.id)));
  return listCompletedClozeRecords(username)
    .filter((record) => valid.has(String(record.resourceId)))
    .length;
}
