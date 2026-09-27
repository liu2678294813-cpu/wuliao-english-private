import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("R2 homepage keeps Planner as the only task surface", () => {
  const app = read("src/App.jsx");
  const todayTasks = read("src/TodayTasks.jsx");
  const planner = read("src/StudyPlannerPanel.jsx");

  // 2026-08-13：Quick Start 已按新版计划从首页删除（左侧导航与 Planner 提供入口）。
  assert.doesNotMatch(app, /className="quick-start"/);
  assert.match(app, /onOpenClozeLibrary/);
  assert.doesNotMatch(app, /StudyRankCard/);
  assert.doesNotMatch(app, /className="entry-card/);
  assert.match(todayTasks, /<StudyPlannerPanel/);
  assert.match(todayTasks, /className="today-support-links"/);
  assert.doesNotMatch(todayTasks, /ClozeReviewTaskCard/);
  assert.match(planner, /className="planner-continue-card"/);
});

test("R2 page CSS ownership does not move Home or Library rules back into AppShell", () => {
  const shell = read("src/redesign/app-shell.css");
  const pages = read("src/redesign/pages.css");
  const forbiddenShellSelector = /\.ds-shell\s+\.(?:home-|today-|entry-|study-rank|recent-|library-|year-|resource-card|vocabulary-page)/;

  assert.doesNotMatch(shell, forbiddenShellSelector);
  assert.match(pages, /\.ds-shell \.home-main/);
  assert.match(pages, /\.ds-shell \.library-page/);
  assert.doesNotMatch(pages, /\.ds-shell \.quick-start/);
  assert.match(pages, /\.ds-shell \.vocabulary-page/);
});

test("R2 tokens expose the finite spacing and semantic surface scales", () => {
  const tokens = read("src/redesign/tokens.css");

  for (const token of [
    "--ds-space-1",
    "--ds-space-8",
    "--ds-control-md",
    "--ds-radius-pill",
    "--ds-text-md",
    "--ds-title-lg",
    "--ds-surface-elevated",
    "--ds-border-strong",
    "--ds-shadow-md",
    "--ds-content-max",
  ]) {
    assert.match(tokens, new RegExp(`${token}:`));
  }
});
