import "./readableStreamCompat";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./redesign/tokens.css";
import "./redesign/app-shell.css";
import "./redesign/pages.css";
import "./redesign/reader.css";
import "./redesign/home-approved-a.css";
import "./redesign/study-approved-a.css";
import { initTelemetry } from "./telemetry/telemetry";
import { getAppInfo } from "./appInfo";

// telemetry.js 默认使用“立即 flush”以便 Node 测试无遗留 timer；浏览器必须注入
// 真实调度，否则每次 recordTiming / incrementMetric 都会同步 JSON.stringify + 写
// localStorage（约 30ms），污染 ink pointermove / pen-up 热路径造成卡顿。
initTelemetry({
  appInfo: getAppInfo,
  schedule: (fn, delay) => window.setTimeout(fn, delay),
  cancel: (id) => window.clearTimeout(id),
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
