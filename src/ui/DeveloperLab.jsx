import { useCallback, useEffect, useState } from "react";
import { getAppInfo } from "../appInfo";
import { getDeveloperMode } from "../developerMode";
import { getTelemetry } from "../telemetry/telemetry";
import { runOfflineEvalSuites } from "../eval/offlineRunner";
import bundledEvalJson from "../generated/eval-latest.json";
import ModalShell from "./Overlay";

const AI_RANGES = [
  { id: "session", label: "当前会话" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
  { id: "all", label: "全部" },
];

const TABS = [
  { id: "overview", label: "概览" },
  { id: "ai", label: "AI 指标" },
  { id: "ink", label: "笔迹性能" },
  { id: "eval", label: "Eval" },
];

function count(value) {
  return value == null ? "暂无数据" : String(value);
}

function percent(value) {
  return value == null ? "暂无数据" : `${(value * 100).toFixed(1)}%`;
}

function millis(value) {
  return value == null ? "暂无数据" : `${Number(value).toFixed(1)} ms`;
}

function formatTime(value) {
  if (!value) return "暂无数据";
  try {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function MetricRow({ label, value }) {
  return (
    <div className="dev-metric-row">
      <span>{label}</span>
      <strong>{value == null ? "暂无数据" : value}</strong>
    </div>
  );
}

export default function DeveloperLab({ onClose }) {
  const info = getAppInfo();
  const [tab, setTab] = useState("overview");
  const [aiRange, setAiRange] = useState("all");
  const [snapshot, setSnapshot] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [exportMessage, setExportMessage] = useState("");
  const [exportText, setExportText] = useState("");
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalMessage, setEvalMessage] = useState("");

  const refresh = useCallback(() => {
    const telemetry = getTelemetry();
    setSnapshot({
      summary: telemetry.getTelemetrySummary(),
      ai: {
        session: telemetry.getAiMetrics({ range: "session" }),
        "7d": telemetry.getAiMetrics({ range: "7d" }),
        "30d": telemetry.getAiMetrics({ range: "30d" }),
        all: telemetry.getAiMetrics({ range: "all" }),
      },
      ink: telemetry.getInkMetrics({ range: "all" }),
      eval: telemetry.getLatestEvalSummary(),
      evalVisible: telemetry.isEvalVisible(),
      errors: telemetry.getDiagnosticsReport().recentSanitizedErrors || [],
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshTick]);

  const telemetrySummary = snapshot?.summary;
  const ai = snapshot?.ai?.[aiRange];
  const ink = snapshot?.ink;
  const bundled = bundledEvalJson || {};
  const offlineSummary = snapshot?.eval?.offline || (snapshot?.evalVisible ? bundled.offline : null);
  const liveSummary = snapshot?.evalVisible ? bundled.live : null;

  function exportDiagnostics() {
    const report = getTelemetry().getDiagnosticsReport();
    const json = JSON.stringify(report, null, 2);
    let downloaded = false;
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `wuliao-diagnostics-${Date.now()}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      downloaded = true;
    } catch {
      downloaded = false;
    }
    if (info.platform === "android") {
      // Android WebView 的 blob 下载受系统限制，始终展示可复制 JSON 作为导出载体。
      setExportText(json);
      setExportMessage("诊断报告已生成：JSON 已展示，可点击“复制 JSON”或长按复制保存");
    } else if (downloaded) {
      setExportMessage("诊断报告已导出");
      setExportText("");
    } else {
      setExportText(json);
      setExportMessage("浏览器无法直接下载，已展示 JSON 文本，请复制保存");
    }
  }

  function clearDiagnostics() {
    if (!window.confirm("仅清除诊断与性能统计，不影响任何学习数据。")) return;
    const telemetry = getTelemetry();
    telemetry.clearDiagnostics();
    telemetry.setEvalVisible(false);
    setExportMessage("");
    setExportText("");
    setRefreshTick((value) => value + 1);
  }

  function disableDeveloperMode() {
    getDeveloperMode().disable();
    onClose();
  }

  async function runOfflineEval() {
    setEvalBusy(true);
    setEvalMessage("");
    try {
      const report = await runOfflineEvalSuites();
      const telemetry = getTelemetry();
      const previous = telemetry.getLatestEvalSummary() || {};
      telemetry.setLatestEvalSummary({ ...previous, offline: report });
      telemetry.setEvalVisible(true);
      setEvalMessage(`Offline Eval 完成：${report.passed} / ${report.caseCount} 通过`);
      setRefreshTick((value) => value + 1);
    } catch (reason) {
      setEvalMessage(`Offline Eval 失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setEvalBusy(false);
    }
  }

  return (
    <ModalShell open onClose={onClose} className="dev-lab-backdrop" label="开发者实验室">
      <div className="dev-lab" onClick={(event) => event.stopPropagation()}>
        <header className="dev-lab-header">
          <div><small>DEVELOPER LAB</small><h2>开发者实验室</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭开发者实验室">×</button>
        </header>

        <nav className="dev-lab-tabs" aria-label="实验室分区">
          {TABS.map((item) => (
            <button key={item.id} type="button" className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="dev-lab-actions">
          <button type="button" onClick={exportDiagnostics}>导出诊断报告</button>
          <button type="button" onClick={clearDiagnostics}>清除诊断数据</button>
          <button type="button" onClick={disableDeveloperMode}>关闭开发者模式</button>
        </div>

        <div className="dev-lab-body">
          {tab === "overview" ? (
            <section className="dev-section">
              <h3>系统</h3>
              <MetricRow label="App Version" value={info.appVersion} />
              <MetricRow label="Build" value={info.buildId || "暂无数据"} />
              <MetricRow label="Platform" value={info.platform === "android" ? "Android" : "Web / Browser"} />
              <MetricRow label="Git Commit" value={info.gitCommit || "暂无数据"} />
              <MetricRow label="Telemetry Schema" value={telemetrySummary?.schemaVersion} />
              <MetricRow label="Telemetry 状态" value={telemetrySummary?.status === "running" ? "运行中（本地）" : "未运行"} />
              <MetricRow label="最近 flush" value={formatTime(telemetrySummary?.lastFlushAt)} />
              <MetricRow label="当前会话" value={telemetrySummary?.sessionId ? telemetrySummary.sessionId.slice(0, 8) : "暂无数据"} />
              <div className="dev-note-row">
                <span>事件 / 错误 / 样本</span>
                <strong>{count(telemetrySummary?.eventCount)} / {count(telemetrySummary?.errorCount)} / {count(telemetrySummary?.sampleCount)}</strong>
              </div>
              <button className="dev-soft-action" type="button" onClick={() => { getTelemetry().flush(); setRefreshTick((value) => value + 1); }}>
                立即 flush
              </button>

              <h3>AI 概览（全部）</h3>
              <MetricRow label="Task Runs" value={snapshot?.ai?.all?.counts?.taskRuns} />
              <MetricRow label="真实 API Requests" value={snapshot?.ai?.all?.counts?.apiRequests} />
              <MetricRow label="任务成功率" value={percent(snapshot?.ai?.all?.rates?.successRate)} />
              <MetricRow label="Cache Hit Rate" value={percent(snapshot?.ai?.all?.rates?.cacheHitRate)} />

              <h3>笔迹概览（全部）</h3>
              <MetricRow label="Stroke Count" value={ink?.strokeCount} />
              <MetricRow label="Finalize P95" value={millis(ink?.finalize?.p95)} />
              <MetricRow label="Commit P95" value={millis(ink?.commit?.p95)} />
            </section>
          ) : null}

          {tab === "ai" ? (
            <section className="dev-section">
              <div className="dev-range-tabs">
                {AI_RANGES.map((item) => (
                  <button key={item.id} type="button" className={aiRange === item.id ? "is-active" : ""} onClick={() => setAiRange(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
              <h3>任务与真实 API</h3>
              <MetricRow label="Task Runs" value={ai?.counts?.taskRuns} />
              <MetricRow label="Cache Hit" value={ai?.counts?.cacheHit} />
              <MetricRow label="Cache Miss" value={ai?.counts?.cacheMiss} />
              <MetricRow label="真实 API Requests" value={ai?.counts?.apiRequests} />
              <MetricRow label="Task Success" value={ai?.counts?.taskSuccess} />
              <MetricRow label="Task Failure" value={ai?.counts?.taskFailure} />
              <MetricRow label="Success Rate" value={percent(ai?.rates?.successRate)} />
              <MetricRow label="Failure Rate" value={percent(ai?.rates?.failureRate)} />
              <MetricRow label="Cache Hit Rate" value={percent(ai?.rates?.cacheHitRate)} />
              <h3>真实 API 性能</h3>
              <MetricRow label="样本数" value={ai?.duration?.sampleCount} />
              <MetricRow label="Average" value={millis(ai?.duration?.average)} />
              <MetricRow label="P50" value={millis(ai?.duration?.p50)} />
              <MetricRow label="P95" value={millis(ai?.duration?.p95)} />
              <MetricRow label="Max" value={millis(ai?.duration?.max)} />
              <h3>AI 结构质量</h3>
              <MetricRow label="Parse Failure" value={ai?.counts?.parseFailure} />
              <MetricRow label="Answer Leak Blocked" value={ai?.counts?.answerLeakBlocked} />
              <MetricRow label="Evidence Invalid" value={ai?.counts?.evidenceInvalid} />
              <MetricRow label="Evidence Final Failure" value={ai?.counts?.evidenceFinalFailure} />
              <MetricRow label="Strict Retry" value={ai?.counts?.strictRetry} />
              <MetricRow label="Option Coverage Incomplete" value={ai?.counts?.optionCoverageIncomplete} />
              <h3>错误分类</h3>
              <MetricRow label="Timeout" value={ai?.counts?.timeout} />
              <MetricRow label="Network" value={ai?.counts?.network} />
              <MetricRow label="Auth" value={ai?.counts?.auth} />
              <MetricRow label="Rate Limit" value={ai?.counts?.rateLimit} />
              <MetricRow label="Insufficient Balance" value={ai?.counts?.insufficientBalance} />
              <MetricRow label="Server" value={ai?.counts?.server} />
              <MetricRow label="Unknown" value={ai?.counts?.unknown} />
              <h3>Token 用量</h3>
              {ai?.tokens ? (
                <>
                  <MetricRow label="Prompt Tokens" value={ai.tokens.promptTokens} />
                  <MetricRow label="Completion Tokens" value={ai.tokens.completionTokens} />
                  <MetricRow label="Total Tokens" value={ai.tokens.totalTokens} />
                </>
              ) : (
                <p className="dev-empty">暂无数据</p>
              )}
            </section>
          ) : null}

          {tab === "ink" ? (
            <section className="dev-section">
              <MetricRow label="Stroke Count" value={ink?.strokeCount} />
              <MetricRow label="平均笔画时长" value={millis(ink?.averageStrokeDurationMs)} />
              <MetricRow label="平均采样 / 笔" value={ink?.averagePointsPerStroke == null ? "暂无数据" : `${ink.averagePointsPerStroke.toFixed(1)} 点`} />
              <MetricRow label="平均 coalesced / 笔" value={ink?.averageCoalescedPerStroke == null ? "暂无数据" : `${ink.averageCoalescedPerStroke.toFixed(1)} 点`} />
              <h3>Finalize</h3>
              <MetricRow label="样本数" value={ink?.finalize?.sampleCount} />
              <MetricRow label="Average" value={millis(ink?.finalize?.average)} />
              <MetricRow label="P50" value={millis(ink?.finalize?.p50)} />
              <MetricRow label="P95" value={millis(ink?.finalize?.p95)} />
              <MetricRow label="Max" value={millis(ink?.finalize?.max)} />
              <h3>Commit</h3>
              <MetricRow label="样本数" value={ink?.commit?.sampleCount} />
              <MetricRow label="Average" value={millis(ink?.commit?.average)} />
              <MetricRow label="P50" value={millis(ink?.commit?.p50)} />
              <MetricRow label="P95" value={millis(ink?.commit?.p95)} />
              <MetricRow label="Max" value={millis(ink?.commit?.max)} />
              <h3>Save / Render</h3>
              <MetricRow label="Save P95" value={millis(ink?.save?.p95)} />
              <MetricRow label="Render P95" value={millis(ink?.render?.p95)} />
              <h3>Handoff 计数</h3>
              <MetricRow label="Full Redraw" value={ink?.fullRedrawCount} />
              <MetricRow label="Incremental Commit" value={ink?.incrementalCommitCount} />
              <MetricRow label="Preview Clear" value={ink?.previewClearCount} />
              <MetricRow label="异常长笔画" value={ink?.anomalyCount} />
              <p className="dev-note">指标均为真实测量量；不含“笔尖输入延迟”等推算量。</p>
            </section>
          ) : null}

          {tab === "eval" ? (
            <section className="dev-section">
              <h3>Offline Eval（不联网、不消耗 API）</h3>
              {offlineSummary ? (
                <div className="dev-eval-card">
                  <MetricRow label="运行时间" value={formatTime(offlineSummary.timestamp)} />
                  <MetricRow label="Suites" value={offlineSummary.suites?.length} />
                  <MetricRow label="Passed" value={offlineSummary.passed} />
                  <MetricRow label="Failed" value={offlineSummary.failed} />
                  <MetricRow label="Pass Rate" value={percent(offlineSummary.passRate)} />
                  <MetricRow label="Duration" value={`${offlineSummary.durationMs.toFixed(1)} ms`} />
                </div>
              ) : (
                <p className="dev-empty">暂无数据</p>
              )}
              <button className="dev-soft-action" type="button" disabled={evalBusy} onClick={runOfflineEval}>
                {evalBusy ? "正在运行…" : "运行 Offline Eval"}
              </button>
              {evalMessage ? <p className="dev-message">{evalMessage}</p> : null}

              <h3>Live AI Eval（仅 CLI）</h3>
              {liveSummary ? (
                <div className="dev-eval-card">
                  <MetricRow label="运行时间" value={formatTime(liveSummary.timestamp)} />
                  <MetricRow label="Model" value={liveSummary.model || "暂无数据"} />
                  <MetricRow label="Prompt Version" value={liveSummary.promptVersion || "暂无数据"} />
                  <MetricRow label="Pass Rate" value={percent(liveSummary.passRate)} />
                </div>
              ) : (
                <p className="dev-empty">暂无数据（Live Eval 通过 pnpm eval:ai:* 命令行运行，结果随下次构建进入 App）</p>
              )}
              <p className="dev-note">页面加载绝不会自动触发任何 Live AI Eval。</p>
            </section>
          ) : null}
        </div>

        {exportMessage ? <p className="dev-message dev-message-fixed">{exportMessage}</p> : null}
        {exportText ? (
          <div className="dev-export-text">
            <textarea readOnly value={exportText} rows={12} />
            <button type="button" onClick={() => { navigator.clipboard?.writeText(exportText); setExportMessage("已复制到剪贴板"); }}>复制 JSON</button>
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}
