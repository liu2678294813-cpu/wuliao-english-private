// Eval CLI：
//   pnpm eval:offline            （离线，不联网、不消耗 API）
//   pnpm eval:ai -- --yes        （全部 Live 套件，真实调用 DeepSeek）
//   pnpm eval:ai:hints -- --yes
//   pnpm eval:ai:diagnosis -- --yes
//   pnpm eval:ai:translation -- --yes
// Live 需要 DEEPSEEK_API_KEY 环境变量；TTY 下会先请求确认（除非 --yes）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { runOfflineEvalSuites } from "../../src/eval/offlineRunner.js";
import {
  livePromptVersions,
  runLiveDiagnosisSuite,
  runLiveHintsSuite,
  runLiveTranslationSuite,
} from "./live.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function appVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function writeReports(report) {
  const dir = path.join(root, "eval-results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);

  const generatedPath = path.join(root, "src", "generated", "eval-latest.json");
  mkdirSync(path.dirname(generatedPath), { recursive: true });
  let existing = { offline: null, live: null };
  try {
    existing = JSON.parse(readFileSync(generatedPath, "utf8")) || existing;
  } catch {
    // 无旧文件时使用空占位
  }
  const bundle = {
    offline: report.kind === "offline" ? report : (existing.offline || null),
    live: report.kind === "live" ? report : (existing.live || null),
    generatedAt: report.timestamp,
    appVersion: report.appVersion,
  };
  writeFileSync(generatedPath, `${JSON.stringify(bundle, null, 2)}\n`);
}

function printReport(report) {
  console.log(`\nEval 报告：${report.suite} (${report.kind || "offline"})`);
  console.log(`用例 ${report.caseCount} · 通过 ${report.passed} · 失败 ${report.failed} · 通过率 ${(report.passRate * 100).toFixed(1)}% · 耗时 ${report.durationMs.toFixed(0)}ms`);
  for (const suite of report.suites || []) {
    const extras = [
      suite.parseSuccessRate != null ? `parse=${(suite.parseSuccessRate * 100).toFixed(0)}%` : "",
      suite.answerLeakRate != null ? `leak=${(suite.answerLeakRate * 100).toFixed(0)}%` : "",
      suite.evidenceValidationRate != null ? `evidence=${(suite.evidenceValidationRate * 100).toFixed(0)}%` : "",
      suite.expectedTagHitRate != null ? `tagHit=${(suite.expectedTagHitRate * 100).toFixed(0)}%` : "",
    ].filter(Boolean).join(" ");
    console.log(`- ${suite.name}: ${suite.passed}/${suite.caseCount}${extras ? ` (${extras})` : ""}`);
  }
  console.log(`报告已写入 eval-results/latest.json 与 src/generated/eval-latest.json`);
}

async function confirmLive() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.error("非交互环境运行 Live Eval 需要显式 --yes 确认。");
      resolve(false);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Live AI Eval 会真实调用 DeepSeek API，并产生 API 用量，是否继续？(y/N) ", (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer || "").trim()));
    });
  });
}

async function runLive(kind, { yes }) {
  const apiKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) {
    console.error("缺少 DEEPSEEK_API_KEY 环境变量。Live Eval 不会读取 App 本地存储的 Key。");
    process.exitCode = 1;
    return;
  }
  if (!yes) {
    const ok = await confirmLive();
    if (!ok) {
      console.error("已取消 Live AI Eval。");
      process.exitCode = 1;
      return;
    }
  }

  const timestamp = Date.now();
  const startedAt = timestamp;
  const suites = [];
  const versions = livePromptVersions();
  const runAll = kind === "ai";
  if (runAll || kind === "ai:hints") {
    const suite = await runLiveHintsSuite(apiKey);
    suite.promptVersion = versions.hints;
    suites.push(suite);
  }
  if (runAll || kind === "ai:diagnosis") {
    const suite = await runLiveDiagnosisSuite(apiKey);
    suite.promptVersion = versions.diagnosis;
    suites.push(suite);
  }
  if (runAll || kind === "ai:translation") {
    const suite = await runLiveTranslationSuite(apiKey);
    suite.promptVersion = versions.translation;
    suites.push(suite);
  }
  const passed = suites.reduce((sum, suite) => sum + suite.passed, 0);
  const caseCount = suites.reduce((sum, suite) => sum + suite.caseCount, 0);
  const report = {
    suite: "live",
    kind,
    model: "deepseek-chat",
    promptVersion: runAll ? versions : (suites[0]?.promptVersion || ""),
    timestamp,
    generatedAt: new Date(timestamp).toISOString(),
    appVersion: appVersion(),
    caseCount,
    passed,
    failed: caseCount - passed,
    passRate: caseCount ? passed / caseCount : null,
    durationMs: Date.now() - startedAt,
    suites,
  };
  writeReports(report);
  printReport(report);
}

async function runOffline() {
  const timestamp = Date.now();
  const report = await runOfflineEvalSuites();
  report.appVersion = appVersion();
  report.kind = "offline";
  report.timestamp = timestamp;
  report.generatedAt = new Date(timestamp).toISOString();
  writeReports(report);
  printReport(report);
}

const args = process.argv.slice(2);
const command = args.find((item) => !item.startsWith("--")) || "offline";
const yes = args.includes("--yes");

if (command === "offline") {
  await runOffline();
} else if (["ai", "ai:hints", "ai:diagnosis", "ai:translation"].includes(command)) {
  await runLive(command, { yes });
} else {
  console.error(`未知命令：${command}`);
  process.exitCode = 1;
}
