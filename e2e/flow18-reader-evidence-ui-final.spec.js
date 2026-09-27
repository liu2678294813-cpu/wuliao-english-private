import { test, expect } from "@playwright/test";
import {
  clickStageAdvance,
  createAccount,
  navTo,
  openOfficialResource,
  setScopedJson,
  uniqueUsername,
  readDurableInkEntries,
} from "./helpers.js";

const RESOURCE_TITLE = "2007 英语（一）Text 1";

async function reopenResource(page) {
  await page.reload();
  await page.locator(".library-page").waitFor({ timeout: 60000 });
  await page.locator(".resource-card", { hasText: RESOURCE_TITLE }).first().locator(".resource-open").click();
  await page.locator(".reader-page").waitFor({ timeout: 120000 });
}

async function reachFirstQuiz(page) {
  await clickStageAdvance(page, "开始精读");
  await clickStageAdvance(page, "完成审题，进入初做");
  await expect(page.locator(".timed-reading-timer")).toBeVisible();
  await expect(page.locator("#deep-clean-text")).toBeVisible();
  await expect(page.locator("#deep-first-quiz")).toBeVisible();
}

async function bootstrapReaderState(page, username) {
  await clickStageAdvance(page, "开始精读");
  const state = await page.evaluate((user) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
    const fullFlowKey = Object.keys(localStorage).find((key) => key.startsWith(`${prefix}wuliao:reading-flow:`));
    const flow = JSON.parse(localStorage.getItem(fullFlowKey));
    const questionKey = document.querySelector("#deep-first-quiz .deep-question-card")?.dataset.questionKey || "";
    return {
      flow,
      flowKey: fullFlowKey.slice(prefix.length),
      evidenceKey: `wuliao:question-evidence:${flow.resourceId}:${flow.passageId}`,
      questionKey,
    };
  }, username);
  expect(state.questionKey).toBeTruthy();
  return state;
}

function firstQuizFlow(flow, now, completed = false) {
  const done = (completedAt = now) => ({ status: "completed", completedAt });
  return {
    ...flow,
    stages: {
      ...flow.stages,
      "deep-cover": done(),
      "deep-first-read": done(),
      "deep-clean-text": done(),
      "deep-first-quiz": completed ? done(now) : { status: "current", completedAt: null },
      "deep-translation": completed ? { status: "current", completedAt: null } : { status: "pending", completedAt: null },
      "deep-redo": { status: "pending", completedAt: null },
      "deep-review": { status: "pending", completedAt: null },
    },
    currentStage: completed ? "deep-translation" : "deep-first-quiz",
    timedReading: { phase: "done", elapsedMs: 1200, startedAt: null, pausedAt: null, completedAt: now - 10 },
    updatedAt: now,
  };
}

function redoFlow(flow, now, completed = false) {
  const done = (completedAt = now) => ({ status: "completed", completedAt });
  return {
    ...flow,
    stages: {
      ...flow.stages,
      "deep-cover": done(),
      "deep-first-read": done(),
      "deep-clean-text": done(),
      "deep-first-quiz": done(),
      "deep-translation": done(),
      "deep-redo": completed ? done(now) : { status: "current", completedAt: null },
      "deep-review": completed ? { status: "current", completedAt: null } : { status: "pending", completedAt: null },
    },
    currentStage: completed ? "deep-review" : "deep-redo",
    timedReading: { phase: "done", elapsedMs: 1200, startedAt: null, pausedAt: null, completedAt: now - 10 },
    updatedAt: now,
  };
}

async function captureCrossSentenceSelection(page) {
  return page.locator(".clean-article").evaluate((article) => {
    const paragraphs = [...article.querySelectorAll("[data-evidence-paragraph][data-evidence-sentence]")]
      .filter((node) => node.firstChild?.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 24);
    if (paragraphs.length < 2) return false;
    const first = paragraphs[0].firstChild;
    const second = paragraphs[1].firstChild;
    const range = document.createRange();
    range.setStart(first, Math.max(0, first.data.length - 18));
    range.setEnd(second, Math.min(18, second.data.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    article.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    return true;
  });
}

async function readDeepInk(page, username, stageId = "deep-cover") {
  const record = (await readDurableInkEntries(page, username)).find(({ key }) => key.startsWith("wuliao:deep-ink:v2:") && key.endsWith(`:${stageId}`));
  return record ? JSON.parse(record.value) : [];
}

async function inkCentroid(page) {
  return page.evaluate(() => {
    const tiles = [...document.querySelectorAll(".deep-ink-tile")];
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (const tile of tiles) {
      const rect = tile.getBoundingClientRect();
      const data = tile.getContext("2d").getImageData(0, 0, tile.width, tile.height).data;
      for (let index = 3; index < data.length; index += 4) {
        if (!data[index]) continue;
        const pixel = (index - 3) / 4;
        sx += rect.left + (pixel % tile.width) / tile.width * rect.width;
        sy += rect.top + Math.floor(pixel / tile.width) / tile.height * rect.height;
        count += 1;
      }
    }
    return count ? { x: sx / count, y: sy / count, count } : null;
  });
}

async function inkPixelCountInElement(page, selector) {
  return page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!target) return 0;
    const targetRect = target.getBoundingClientRect();
    let count = 0;
    for (const tile of document.querySelectorAll(".deep-ink-tile")) {
      const rect = tile.getBoundingClientRect();
      const data = tile.getContext("2d").getImageData(0, 0, tile.width, tile.height).data;
      for (let index = 3; index < data.length; index += 4) {
        if (!data[index]) continue;
        const pixel = (index - 3) / 4;
        const x = rect.left + (pixel % tile.width) / tile.width * rect.width;
        const y = rect.top + Math.floor(pixel / tile.width) / tile.height * rect.height;
        if (x >= targetRect.left && x <= targetRect.right && y >= targetRect.top && y <= targetRect.bottom) count += 1;
      }
    }
    return count;
  }, selector);
}

async function drawReaderStroke(page, box, yOffset = 0) {
  const x = box.x + box.width * 0.3;
  const y = box.y + box.height * 0.58 + yOffset;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 72, y + 18, { steps: 8 });
  await page.mouse.up();
}

test("精读 Ink：撤销和清空只作用当前 Surface，刷新后为空且流程数据不变", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("reader-clear"));
  await openOfficialResource(page, RESOURCE_TITLE);
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  const stage = page.locator("#deep-cover");
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  const flowBefore = await page.evaluate((user) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:wuliao:reading-flow:`;
    const key = Object.keys(localStorage).find((entry) => entry.startsWith(prefix));
    return key ? localStorage.getItem(key) : null;
  }, username);

  await drawReaderStroke(page, box);
  await expect.poll(async () => (await readDeepInk(page, username)).length).toBe(1);
  await page.locator(".reader-page > .annotation-toolbar button", { hasText: "撤销" }).click();
  await expect.poll(async () => (await readDeepInk(page, username)).length).toBe(0);
  await drawReaderStroke(page, box);
  await drawReaderStroke(page, box, 34);
  await expect.poll(async () => (await readDeepInk(page, username)).length).toBe(2);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".reader-page > .annotation-toolbar button", { hasText: "清空页面" }).click();
  await expect.poll(async () => (await readDeepInk(page, username)).length).toBe(0);
  const flowAfter = await page.evaluate((user) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:wuliao:reading-flow:`;
    const key = Object.keys(localStorage).find((entry) => entry.startsWith(prefix));
    return key ? localStorage.getItem(key) : null;
  }, username);
  expect(flowAfter).toBe(flowBefore);
  await reopenResource(page);
  expect(await readDeepInk(page, username)).toEqual([]);
});

test("Flow18 Evidence v2：重做后原生跨句选择、类型、双进度、定位优先级与 reload 高亮", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("flow18-evidence"));
  await openOfficialResource(page, RESOURCE_TITLE);
  const state = await bootstrapReaderState(page, username);
  await setScopedJson(page, username, state.flowKey, redoFlow(state.flow, Date.now(), false));
  await reopenResource(page);

  const cards = page.locator("#deep-redo .deep-question-card");
  for (let index = 0; index < 5; index += 1) {
    await cards.nth(index).locator(".deep-options button").first().click();
  }
  const firstCard = cards.first();
  const firstQuestionNumber = (await firstCard.locator("h3 > span").innerText()).trim();
  const secondQuestionNumber = (await cards.nth(1).locator("h3 > span").innerText()).trim();
  await firstCard.getByRole("button", { name: "去原文定位" }).click();
  await expect(page.locator(".evidence-editor-bar")).toBeVisible();
  expect(await captureCrossSentenceSelection(page)).toBe(true);
  await expect(page.locator(".evidence-editor-head")).toContainText("已选 1 / 3");
  await page.getByRole("button", { name: "推理依据", exact: true }).click();
  await page.getByRole("button", { name: "确认依据", exact: true }).click();
  await expect(firstCard.locator(".evidence-status")).toContainText("推理依据");

  const progress = page.locator("#deep-redo .quiz-completion-progress");
  await expect(progress).toContainText("已作答 5/5 · 已补证据 1/5");
  await expect(page.locator("#deep-redo .stage-advance-button")).toContainText("还差 4 题原文依据");
  await progress.getByRole("button", { name: "定位下一项" }).click();
  await expect(page.locator(".toast")).toContainText(`再完成 Q${secondQuestionNumber} 的原文依据定位`);

  const stored = await page.evaluate((user) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:wuliao:question-evidence:`;
    const key = Object.keys(localStorage).find((item) => item.startsWith(prefix));
    return JSON.parse(localStorage.getItem(key));
  }, username);
  const entry = Object.values(stored.questions)[0].redo;
  expect(stored.schemaVersion).toBe(2);
  expect(entry.mode).toBe("text");
  expect(entry.textType).toBe("inference");
  expect(entry.ranges[0].segments.length).toBeGreaterThanOrEqual(2);

  await reopenResource(page);
  const restoredCard = page.locator("#deep-redo .deep-question-card").first();
  await restoredCard.getByRole("button", { name: "查看", exact: true }).click();
  await expect.poll(() => page.evaluate(() => ({
    custom: Boolean(globalThis.CSS?.highlights?.has("wuliao-question-evidence")),
    fallback: document.querySelectorAll(".evidence-highlight-fallback").length,
  }))).toEqual(expect.objectContaining({ custom: true }));
});

test("Flow18 legacy global null：初做历史证据保留但不再参与当前 gate", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("flow18-legacy-current"));
  await openOfficialResource(page, RESOURCE_TITLE);
  const state = await bootstrapReaderState(page, username);
  const now = Date.now();
  await setScopedJson(page, username, state.flowKey, firstQuizFlow(state.flow, now, false));
  await setScopedJson(page, username, state.evidenceKey, {
    schemaVersion: 1,
    resourceId: state.flow.resourceId,
    passageId: state.flow.passageId,
    updatedAt: now,
    questions: { [state.questionKey]: { first: { mode: "global", references: [], globalType: null, note: "legacy", completedAt: now }, redo: null } },
  });

  await reopenResource(page);
  const firstCard = page.locator("#deep-first-quiz .deep-question-card").first();
  await expect(firstCard.locator(".evidence-card-row")).toHaveCount(0);
  await expect(page.locator("#deep-first-quiz .quiz-completion-progress")).toContainText("已作答 0/5");
  const raw = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `wuliao:user:${encodeURIComponent(username)}:${state.evidenceKey}`);
  expect(raw.questions[state.questionKey].first.globalType).toBeNull();
});

test("Flow18 legacy historical：已完成初做不回退、不改 completedAt、不伪造类型", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("flow18-legacy-done"));
  await openOfficialResource(page, RESOURCE_TITLE);
  const state = await bootstrapReaderState(page, username);
  const completedAt = 1786666123456;
  await setScopedJson(page, username, state.flowKey, firstQuizFlow(state.flow, completedAt, true));
  await setScopedJson(page, username, state.evidenceKey, {
    schemaVersion: 1,
    resourceId: state.flow.resourceId,
    passageId: state.flow.passageId,
    updatedAt: completedAt,
    questions: { [state.questionKey]: { first: { mode: "global", references: [], globalType: null, note: "legacy", completedAt }, redo: null } },
  });

  await reopenResource(page);
  const firstCard = page.locator("#deep-first-quiz .deep-question-card").first();
  await expect(firstCard.locator(".evidence-card-row")).toHaveCount(0);
  const raw = await page.evaluate(({ flowKey, evidenceKey }) => ({
    flow: JSON.parse(localStorage.getItem(flowKey)),
    evidence: JSON.parse(localStorage.getItem(evidenceKey)),
  }), {
    flowKey: `wuliao:user:${encodeURIComponent(username)}:${state.flowKey}`,
    evidenceKey: `wuliao:user:${encodeURIComponent(username)}:${state.evidenceKey}`,
  });
  expect(raw.flow.currentStage).toBe("deep-translation");
  expect(raw.flow.stages["deep-first-quiz"].status).toBe("completed");
  expect(raw.flow.stages["deep-first-quiz"].completedAt).toBe(completedAt);
  expect(raw.evidence.questions[state.questionKey].first.globalType).toBeNull();
});

test("Flow18 panel geometry + region-v2：平板避让、宽屏固定槽位，panel 后落笔随 anchor 投影", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const username = await createAccount(page, uniqueUsername("flow18-ink"));
  await openOfficialResource(page, RESOURCE_TITLE);
  const content = page.locator(".deep-reader-content");
  const baseline = await content.boundingBox();
  const unscaled = await content.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight }));

  await page.locator(".question-fab").click();
  await expect(page.locator(".question-drawer.open")).toBeVisible();
  await page.waitForTimeout(220);
  const questionOpen = await content.boundingBox();
  const questionBox = await page.locator(".question-drawer.open").boundingBox();
  expect(questionOpen.width).toBeLessThan(baseline.width - 10);
  const openedLayout = await content.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight, scale: el.getBoundingClientRect().width / el.offsetWidth }));
  expect(openedLayout.width).toBe(unscaled.width);
  expect(openedLayout.height).toBe(unscaled.height);
  expect(questionOpen.height).toBeCloseTo(unscaled.height * openedLayout.scale, 0);
  expect(questionOpen.x).toBeLessThan(baseline.x - 40);
  expect(questionOpen.x + questionOpen.width).toBeLessThanOrEqual(questionBox.x - 12);

  // Current reader uses one side panel with question/AI tabs; switching tabs
  // preserves the same paper layout and does not require a hidden launch FAB.
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "AI 悬浮窗" })).toBeVisible();
  await page.waitForTimeout(200);
  for (const viewport of [
    { width: 832, height: 544 },
    { width: 1024, height: 700 },
    { width: 1680, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(180);
    const articleBox = await content.boundingBox();
    const aiBox = await page.getByRole("dialog", { name: "AI 悬浮窗" }).boundingBox();
    if (viewport.width <= 760) {
      expect(aiBox.x).toBeLessThan(articleBox.x + articleBox.width);
    } else {
      expect(articleBox.x + articleBox.width).toBeLessThanOrEqual(aiBox.x - 14);
    }
    expect(articleBox.width).toBeGreaterThan(400);
  }

  await page.getByRole("button", { name: "关闭 AI 悬浮窗" }).click();
  await expect(page.locator(".reader-side-panel")).toHaveAttribute("data-motion-state", "closed");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(200);
  await page.locator(".question-fab").click();
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  const stage = page.locator("#deep-cover");
  await stage.scrollIntoViewIfNeeded();
  const stageBox = await stage.boundingBox();
  const contentBox = await content.boundingBox();
  const start = { x: stageBox.x + stageBox.width * 0.28, y: stageBox.y + stageBox.height * 0.62 };
  const end = { x: start.x + 80, y: start.y + 24 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const ink = await readDeepInk(page, username);
  expect(ink).toHaveLength(1);
  expect(ink[0].coordinateSpace).toBe("deep-region-v2");
  expect(ink[0].deepAnchor).toEqual({ version: 2, regionId: "stage:deep-cover" });
  expect(ink[0].points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.deepLocal?.x) && Number.isFinite(point.deepLocal?.y))).toBe(true);
  expect(Math.abs(ink[0].points[0].x - (start.x - contentBox.x) / contentBox.width)).toBeLessThan(0.035);

  await expect.poll(() => inkCentroid(page)).not.toBeNull();
  const before = await inkCentroid(page);
  const beforeStage = await stage.boundingBox();
  const canonical = JSON.stringify(ink[0]);

  // AI 浮窗与顶部工具栏联动：收起后释放垂直空间，展开后恢复；canonical Ink 不变。
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "AI 悬浮窗" })).toBeVisible();
  const aiBeforeCollapse = await page.getByRole("dialog", { name: "AI 悬浮窗" }).boundingBox();
  const toolbar = page.locator(".reader-page > .annotation-toolbar");
  await toolbar.locator(".toolbar-collapse-toggle", { hasText: "收起顶部" }).evaluate((button) => button.click());
  await page.waitForTimeout(250);
  const aiCollapsed = await page.getByRole("dialog", { name: "AI 悬浮窗" }).boundingBox();
  expect(aiCollapsed.y).toBeLessThan(aiBeforeCollapse.y);
  expect(aiCollapsed.height).toBeGreaterThan(aiBeforeCollapse.height);
  expect(JSON.stringify((await readDeepInk(page, username))[0])).toBe(canonical);
  await toolbar.locator(".toolbar-collapse-toggle", { hasText: "展开顶部" }).evaluate((button) => button.click());
  await page.waitForTimeout(250);
  const aiRestored = await page.getByRole("dialog", { name: "AI 悬浮窗" }).boundingBox();
  expect(Math.abs(aiRestored.y - aiBeforeCollapse.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(aiRestored.height - aiBeforeCollapse.height)).toBeLessThanOrEqual(2);
  expect(JSON.stringify((await readDeepInk(page, username))[0])).toBe(canonical);
  await page.getByRole("button", { name: "关闭 AI 悬浮窗" }).click();

  // Closing the panel also animates the shared paper/ink transform. Compare
  // anchor-relative pixels only after that transform has settled.
  await expect(content).not.toHaveAttribute("data-paper-moving", "true");
  const beforeSpacer = await inkCentroid(page);
  const beforeStageSpacer = await stage.boundingBox();

  await stage.evaluate((element) => {
    const spacer = document.createElement("div");
    spacer.dataset.flow18Spacer = "true";
    spacer.style.height = "96px";
    element.parentNode.insertBefore(spacer, element);
  });
  await page.waitForTimeout(350);
  const after = await inkCentroid(page);
  const afterStage = await stage.boundingBox();
  expect(after).not.toBeNull();
  expect(after.y - beforeSpacer.y).toBeGreaterThan(80);
  expect(Math.abs((after.y - afterStage.y) - (beforeSpacer.y - beforeStageSpacer.y))).toBeLessThan(4);
  expect(JSON.stringify((await readDeepInk(page, username))[0])).toBe(canonical);

  await reopenResource(page);
  await expect.poll(() => inkCentroid(page)).not.toBeNull();
  const reloaded = await inkCentroid(page);
  const reloadedStage = await page.locator("#deep-cover").boundingBox();
  expect(Math.abs((reloaded.y - reloadedStage.y) - (beforeSpacer.y - beforeStageSpacer.y))).toBeLessThan(4);
  expect(JSON.stringify((await readDeepInk(page, username))[0])).toBe(canonical);
});

test("Flow18 阶段字迹：20 笔无逐笔 full redraw，进下一阶段隐藏，返回与 reload 恢复", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const username = await createAccount(page, uniqueUsername("flow18-stage-ink"));
  await openOfficialResource(page, RESOURCE_TITLE);
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  const stage = page.locator("#deep-cover");
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  const beforeStats = await page.evaluate(() => ({ ...(window.__inkHandoffStats || {}) }));
  for (let index = 0; index < 20; index += 1) {
    const x = box.x + 100 + (index % 5) * 55;
    const y = box.y + 330 + Math.floor(index / 5) * 24;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 28, y + 7, { steps: 3 });
    await page.mouse.up();
  }
  await expect.poll(async () => (await readDeepInk(page, username)).length).toBe(20);
  const afterStats = await page.evaluate(() => ({ ...(window.__inkHandoffStats || {}) }));
  expect(afterStats.incrementalCommitCount - beforeStats.incrementalCommitCount).toBe(20);
  expect(afterStats.fullRedrawCount - beforeStats.fullRedrawCount).toBe(0);
  await expect.poll(() => inkCentroid(page)).not.toBeNull();

  await clickStageAdvance(page, "开始精读");
  await expect.poll(() => inkPixelCountInElement(page, "#deep-first-read")).toBe(0);
  expect(await readDeepInk(page, username, "deep-first-read")).toEqual([]);

  const reviewStage = page.locator("#deep-first-read");
  await reviewStage.scrollIntoViewIfNeeded();
  const reviewBox = await reviewStage.boundingBox();
  await page.mouse.move(reviewBox.x + 160, reviewBox.y + 210);
  await page.mouse.down();
  await page.mouse.move(reviewBox.x + 210, reviewBox.y + 222, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await readDeepInk(page, username, "deep-first-read")).length).toBe(1);
  await expect.poll(() => inkPixelCountInElement(page, "#deep-first-read")).toBeGreaterThan(0);

  await clickStageAdvance(page, "完成审题，进入初做");
  await expect(page.locator(".timed-reading-timer")).toBeVisible();
  await expect(page.locator("#deep-clean-text")).toBeVisible();
  await expect(page.locator("#deep-first-quiz")).toBeVisible();
  await expect.poll(() => inkPixelCountInElement(page, "#deep-clean-text")).toBe(0);
  await expect.poll(() => inkPixelCountInElement(page, "#deep-first-quiz")).toBe(0);
  expect(await readDeepInk(page, username, "deep-first-quiz")).toEqual([]);

  // 用户直接向上划回已完成阶段时，不需要点击导航切换存储键；
  // 该阶段字迹仍应按原页面位置渲染，同时当前流程仍停留在“初做”。
  await reviewStage.scrollIntoViewIfNeeded();
  await expect.poll(() => inkPixelCountInElement(page, "#deep-first-read")).toBeGreaterThan(0);
  await expect(page.locator(".stage-nav .current").first()).toContainText("初做");

  await page.locator('.custom-workbook-stage button', { hasText: "审题" }).click();
  await expect.poll(() => inkPixelCountInElement(page, "#deep-first-read")).toBeGreaterThan(0);
  expect(await readDeepInk(page, username, "deep-first-read")).toHaveLength(1);

  await page.locator('.custom-workbook-stage button', { hasText: "初做" }).click();
  await expect.poll(() => inkPixelCountInElement(page, "#deep-clean-text")).toBe(0);
  await expect.poll(() => inkPixelCountInElement(page, "#deep-first-quiz")).toBe(0);
  expect(await readDeepInk(page, username, "deep-first-quiz")).toEqual([]);

  await reopenResource(page);
  await expect(page.locator(".stage-nav .current").first()).toContainText("初做");
  await expect.poll(() => inkPixelCountInElement(page, "#deep-clean-text")).toBe(0);
  await expect.poll(() => inkPixelCountInElement(page, "#deep-first-quiz")).toBe(0);

  await page.locator('.custom-workbook-stage button', { hasText: "导读" }).click();
  await expect.poll(() => inkPixelCountInElement(page, "#deep-cover")).toBeGreaterThan(0);
  expect(await readDeepInk(page, username, "deep-cover")).toHaveLength(20);
});

test("Flow18 旧字迹迁移：原键不变、按 anchor 分入阶段键并写入校验标记", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("flow18-legacy-ink"));
  await openOfficialResource(page, RESOURCE_TITLE);
  await clickStageAdvance(page, "开始精读");
  const seeded = await page.evaluate((user) => {
    const userPrefix = `wuliao:user:${encodeURIComponent(user)}:`;
    const flowKey = Object.keys(localStorage).find((key) => key.startsWith(`${userPrefix}wuliao:reading-flow:`));
    const flow = JSON.parse(localStorage.getItem(flowKey));
    const legacyKey = `${userPrefix}wuliao:deep-ink:${flow.resourceId}:${flow.passageId}`;
    const v2Prefix = `${userPrefix}wuliao:deep-ink:v2`;
    Object.keys(localStorage).filter((key) => key.startsWith(v2Prefix)).forEach((key) => localStorage.removeItem(key));
    const stroke = (regionId, y) => ({
      tool: "pen",
      color: "#173a62",
      width: 2.6,
      coordinateSpace: "deep-region-v2",
      deepAnchor: { version: 2, regionId },
      points: [
        { x: 0.2, y, pressure: 0.5, deepLocal: { x: 0.2, y } },
        { x: 0.3, y: y + 0.03, pressure: 0.5, deepLocal: { x: 0.3, y: y + 0.03 } },
      ],
    });
    const strokes = [
      stroke("stage:deep-cover", 0.25),
      stroke("stage:deep-clean-text", 0.45),
    ];
    const raw = JSON.stringify(strokes);
    localStorage.setItem(legacyKey, raw);
    return { legacyKey, raw, resourceId: flow.resourceId, passageId: flow.passageId };
  }, username);

  await reopenResource(page);
  expect(await readDeepInk(page, username, "deep-cover")).toHaveLength(1);
  expect(await readDeepInk(page, username, "deep-clean-text")).toEqual([]);
  expect(await readDeepInk(page, username, "deep-first-quiz")).toHaveLength(1);
  const migrated = await page.evaluate(({ user, seededState }) => {
    const userPrefix = `wuliao:user:${encodeURIComponent(user)}:`;
    const markerKey = `${userPrefix}wuliao:deep-ink:v2-migrated:${seededState.resourceId}:${seededState.passageId}`;
    return {
      legacyRaw: localStorage.getItem(seededState.legacyKey),
      marker: JSON.parse(localStorage.getItem(markerKey)),
    };
  }, { user: username, seededState: seeded });
  const durableLegacy = (await readDurableInkEntries(page, username)).find(({ key }) => key === `wuliao:deep-ink:${seeded.resourceId}:${seeded.passageId}`);
  const durableMarker = (await readDurableInkEntries(page, username)).find(({ key }) => key === `wuliao:deep-ink:v2-migrated:${seeded.resourceId}:${seeded.passageId}`);
  migrated.marker = durableMarker ? JSON.parse(durableMarker.value) : migrated.marker;
  expect(durableLegacy?.value ?? migrated.legacyRaw).toBe(seeded.raw);
  expect(migrated.marker.schemaVersion).toBe(2);
  expect(migrated.marker.legacyStrokeCount).toBe(2);
  expect(migrated.marker.stageCounts["deep-cover"]).toBe(1);
  expect(migrated.marker.stageCounts["deep-first-quiz"]).toBe(1);
});

test("Flow18 全局 UI：Home 档案、Settings 小高滚动/PIN、Library sticky action strip", async ({ page }) => {
  await page.setViewportSize({ width: 832, height: 544 });
  await createAccount(page, uniqueUsername("flow18-global"));

  const archive = page.locator(".today-archive-link");
  const archiveBox = await archive.boundingBox();
  expect(archiveBox.height).toBeGreaterThanOrEqual(40);
  expect(await archive.locator("svg, .app-icon").count()).toBeGreaterThan(0);
  await archive.click();
  await expect(page.getByRole("dialog", { name: "学习档案入口" })).toBeVisible();
  await page.getByRole("button", { name: "关闭学习档案入口" }).click();

  await page.locator(".ds-mobile-settings:visible, .ds-settings:visible").click();
  const panel = page.locator(".settings-panel");
  const body = page.locator(".settings-body");
  await expect(panel).toBeVisible();
  const scrollMetrics = await body.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  const headerTop = (await page.locator(".settings-header").boundingBox()).y;
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect((await page.locator(".settings-header").boundingBox()).y).toBeCloseTo(headerTop, 0);
  const version = page.locator(".settings-version");
  for (let index = 0; index < 7; index += 1) await version.click();
  await expect(page.locator(".settings-pin-backdrop")).toBeVisible();
  const panelBox = await panel.boundingBox();
  const pinBox = await page.locator(".settings-pin-backdrop").boundingBox();
  expect(Math.abs(pinBox.x - panelBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(pinBox.y - panelBox.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(pinBox.width - panelBox.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(pinBox.height - panelBox.height)).toBeLessThanOrEqual(2);
  await page.locator(".settings-pin-actions").getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "关闭设置" }).click();

  await navTo(page, "精读");
  const strip = page.locator(".library-action-strip");
  await expect(strip).toBeVisible();
  const top = (await strip.boundingBox()).y;
  const style = await strip.evaluate((el) => {
    const computed = getComputedStyle(el);
    const channels = computed.backgroundColor.match(/[\d.]+/g)?.map(Number) || [];
    return {
      backdrop: computed.backdropFilter,
      background: computed.backgroundColor,
      backgroundAlpha: channels.length >= 4 ? channels[3] : 1,
    };
  });
  expect(style.backdrop).toBe("none");
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.backgroundAlpha).toBe(1);
  const actionBoxes = await strip.locator("button").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  }));
  expect(actionBoxes).toHaveLength(2);
  expect(actionBoxes.every((box) => box.height >= 40 && Math.abs(box.top - actionBoxes[0].top) <= 1)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(150);
  expect((await strip.boundingBox()).y).toBeCloseTo(top, 0);
});

test("Flow18 词库遮挡：2/3 → 3/3 即时去朗读语义且 reload 持久", async ({ page }) => {
  await createAccount(page, uniqueUsername("flow18-vocab"));
  await navTo(page, "背诵");
  const frame = page.frameLocator(".vocabulary-frame");
  const row = frame.locator(".word-row").first();
  const mark = row.locator(".mark-button");
  await expect(mark).toBeVisible({ timeout: 90000 });
  await mark.click();
  await expect(mark).toHaveText("记录 1/3");
  await mark.click();
  await expect(mark).toHaveText("记录 2/3");
  const english = row.locator(".english");
  await expect(english).toHaveClass(/speakable-word/);
  await expect(english).toHaveAttribute("role", "button");
  await expect(english).toHaveAttribute("tabindex", "0");

  await mark.click();
  await expect(row).toHaveClass(/masked/);
  await expect(english).not.toHaveClass(/speakable-word/);
  await expect(english).not.toHaveAttribute("role", "button");
  await expect(english).toHaveAttribute("tabindex", "-1");
  await expect(english).toHaveAttribute("aria-hidden", "true");
  await expect(mark).toBeDisabled();

  await page.locator(".vocabulary-frame").evaluate((iframe) => iframe.contentWindow.location.reload());
  const restoredRow = frame.locator(".word-row").first();
  await expect(restoredRow).toHaveClass(/masked/, { timeout: 90000 });
  await expect(restoredRow.locator(".english")).not.toHaveClass(/speakable-word/);
  await expect(restoredRow.locator(".english")).toHaveAttribute("tabindex", "-1");
  await expect(restoredRow.locator(".mark-button")).toBeDisabled();
});
