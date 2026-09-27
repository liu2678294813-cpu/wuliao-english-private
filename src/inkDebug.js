// 开发态 Ink handoff 计数器：只在 DEV 构建暴露到 window，生产不显示任何 UI。
import { getTelemetry } from "./telemetry/telemetry";

export const inkHandoffStats = {
  fullRedrawCount: 0,
  incrementalCommitCount: 0,
  previewClearCount: 0,
};

export function recordInkHandoff(name) {
  const key = {
    fullRedraw: "fullRedrawCount",
    incrementalCommit: "incrementalCommitCount",
    previewClear: "previewClearCount",
  }[name] || name;
  if (Object.prototype.hasOwnProperty.call(inkHandoffStats, key)) {
    inkHandoffStats[key] += 1;
    try {
      getTelemetry().incrementMetric({ metric: `ink.handoff.${name}` });
    } catch {
      // Telemetry 异常绝不影响笔迹主流程
    }
  }
}

export function exposeInkHandoffStats() {
  if ((import.meta.env?.DEV || import.meta.env?.VITE_E2E_PROBES === "1") && typeof window !== "undefined") {
    window.__inkHandoffStats = inkHandoffStats;
  }
}
