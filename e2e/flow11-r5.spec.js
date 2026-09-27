import { test, expect } from "@playwright/test";
import {
  createAccount,
  openOfficialResource,
  openOfficialCloze,
  clickClozeAction,
  setScopedJson,
  scopedKey,
  expectNoConsoleErrors,
  navTo,
} from "./helpers.js";

// Flow 11：R5 交互与一致性收尾。
// 1) 精读工具栏收起：全宽占位释放 + 展开入口 + 正文上移
// 2) 完形资料卡真实学习状态 + D+1 待复习
// 3) 完形陌生词阶段隔离与共享陌生词库（来源筛选）
// 4) 首页最近学习统一精读 + 完形

function stageCompleted(now) {
  return { status: "completed", completedAt: now };
}

function seededAnalysisFlow(page, username, resourceId, now) {
  return setScopedJson(page, username, `wuliao:cloze-flow:${resourceId}:${resourceId}`, {
    schemaVersion: 1,
    resourceId,
    clozeId: resourceId,
    stages: {
      "cloze-cover": stageCompleted(now),
      "cloze-first-attempt": stageCompleted(now),
      "cloze-self-review": stageCompleted(now),
      "cloze-correction": stageCompleted(now),
      "cloze-analysis": { status: "current", completedAt: null },
      "cloze-final-read": { status: "pending", completedAt: null },
    },
    currentStage: "cloze-analysis",
    timedAttempt: { phase: "done", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: now },
    updatedAt: now,
  });
}

function seededFirstAttemptFlow(page, username, resourceId, now) {
  return setScopedJson(page, username, `wuliao:cloze-flow:${resourceId}:${resourceId}`, {
    schemaVersion: 1,
    resourceId,
    clozeId: resourceId,
    stages: {
      "cloze-cover": stageCompleted(now),
      "cloze-first-attempt": { status: "current", completedAt: null },
      "cloze-self-review": { status: "pending", completedAt: null },
      "cloze-correction": { status: "pending", completedAt: null },
      "cloze-analysis": { status: "pending", completedAt: null },
      "cloze-final-read": { status: "pending", completedAt: null },
    },
    currentStage: "cloze-first-attempt",
    timedAttempt: { phase: "idle", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: null },
    updatedAt: now,
  });
}

test("精读：收起顶部后完整工具保留、正文上移、可展开恢复", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await createAccount(page);
  await openOfficialResource(page, "2007 英语（一）Text 1");

  const toolbar = page.locator(".annotation-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 30000 });

  // Web reader normally does not opt into the Android presentation class.
  // Add it only in this visual-contract test; product capability detection and
  // every ink handler remain untouched.
  await toolbar.evaluate((element) => element.classList.add("tablet-ink-toolbar"));
  const toolbarVisual = await page.evaluate(() => {
    const root = document.querySelector(".annotation-toolbar.tablet-ink-toolbar");
    const direct = root?.querySelector(":scope > button:nth-of-type(2)");
    const mode = root?.querySelector(".input-mode-picker button");
    const icon = root?.querySelector(".toolbar-icon");
    const color = root?.querySelector(".color-picker button.active") || root?.querySelector(".color-picker button");
    const size = root?.querySelector(".tool-size-control");
    const track = root?.querySelector(".tool-size-range-track");
    const css = (element, pseudo = null) => element ? getComputedStyle(element, pseudo) : null;
    const colorStyle = css(color);
    const paddingX = colorStyle ? Number.parseFloat(colorStyle.paddingLeft) : -1;
    return {
      toolbarHeight: root?.getBoundingClientRect().height,
      direct: direct && { height: direct.getBoundingClientRect().height, fontSize: css(direct).fontSize, display: css(direct).display, alignItems: css(direct).alignItems },
      mode: mode && { height: mode.getBoundingClientRect().height, fontSize: css(mode).fontSize, display: css(mode).display, alignItems: css(mode).alignItems },
      icon: icon && { width: icon.getBoundingClientRect().width, height: icon.getBoundingClientRect().height },
      color: color && { width: color.getBoundingClientRect().width, height: color.getBoundingClientRect().height, paddingX, visible: color.getBoundingClientRect().width - paddingX * 2, activeInset: css(color, "::after").inset, hitInset: css(color, "::before").inset },
      size: size && { height: size.getBoundingClientRect().height, alignItems: css(size).alignItems },
      track: track && { height: track.getBoundingClientRect().height, visibleHeight: css(track, "::before").height },
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
  expect(Math.round(toolbarVisual.toolbarHeight)).toBe(42);
  for (const control of [toolbarVisual.direct, toolbarVisual.mode]) {
    expect(Math.round(control.height)).toBe(40);
    expect(control.fontSize).toBe("14px");
    // Chromium serializes inline-flex as either "inline-flex" or the modern
    // computed "flex" value; both retain the same inline button formatting.
    expect(["flex", "inline-flex"]).toContain(control.display);
    expect(control.alignItems).toBe("center");
  }
  expect(Math.round(toolbarVisual.icon.width)).toBe(19);
  expect(Math.round(toolbarVisual.icon.height)).toBe(19);
  expect(Math.round(toolbarVisual.color.width)).toBe(40);
  expect(Math.round(toolbarVisual.color.height)).toBe(40);
  expect(Math.round(toolbarVisual.color.paddingX)).toBe(9);
  expect(Math.round(toolbarVisual.color.visible)).toBe(22);
  expect(toolbarVisual.color.activeInset).toBe("5px");
  expect(toolbarVisual.color.hitInset).toBe("-2px");
  expect(Math.round(toolbarVisual.size.height)).toBe(40);
  expect(toolbarVisual.size.alignItems).toBe("center");
  expect(Math.round(toolbarVisual.track.height)).toBe(36);
  expect(toolbarVisual.track.visibleHeight).toBe("4px");
  expect(toolbarVisual.noHorizontalOverflow).toBe(true);

  const collapsedContainer = page.locator(".annotation-toolbar.collapsed");
  await expect(collapsedContainer).toHaveCount(0);

  const geometry = () => page.evaluate(() => {
    const toolbarEl = document.querySelector(".annotation-toolbar");
    const contentEl = document.querySelector(".deep-reader-content");
    const toggleEl = document.querySelector(".toolbar-collapse-toggle");
    return {
      toolbarHeight: toolbarEl ? toolbarEl.getBoundingClientRect().height : -1,
      contentTop: contentEl ? contentEl.getBoundingClientRect().top : -1,
      toggleVisible: toggleEl ? toggleEl.getBoundingClientRect().width > 0 && toggleEl.getBoundingClientRect().height > 0 : false,
      toolbarCollapsedClass: toolbarEl ? toolbarEl.classList.contains("collapsed") : false,
    };
  });

  const expanded = await geometry();
  expect(expanded.toolbarHeight).toBeGreaterThan(30);

  // 收起
  await page.locator(".toolbar-collapse-toggle").first().click();
  await expect(page.locator(".stage-nav")).toBeHidden();

  const collapsed = await geometry();
  expect(collapsed.toolbarCollapsedClass).toBe(false);
  expect(collapsed.toolbarHeight).toBeGreaterThan(30);
  await expect(toolbar.getByRole("button", { name: "笔", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "橡皮", exact: true })).toBeVisible();
  // 正文有效阅读区域明显上移
  expect(collapsed.contentTop).toBeLessThan(expanded.contentTop);

  // The reader keeps the full toolbar; its expand action retains the compact
  // 40px control geometry measured above instead of the old floating pill.
  const expand = toolbar.getByRole("button", { name: "展开顶部", exact: true });
  await expect(expand).toBeVisible();
  expect((await expand.boundingBox()).height).toBeGreaterThanOrEqual(40);

  // 展开恢复
  await expand.click();
  await expect(page.locator(".annotation-toolbar.collapsed")).toHaveCount(0, { timeout: 10000 });
  const restored = await geometry();
  expect(restored.toolbarHeight).toBeGreaterThan(30);

  // Stage chrome is hidden again; the full toolbar remains the interaction UI.
  await page.locator(".toolbar-collapse-toggle").first().click();
  await expect(page.locator(".stage-nav")).toBeHidden();
  await expect(page.locator(".reader-header")).toBeHidden();
  await expect(toolbar.getByRole("button", { name: "陌生词", exact: true })).toBeVisible();

  expect(errors, `console errors: ${errors.join(" ;; ")}`).toEqual([]);
});

test("完形资料库：卡片显示真实学习阶段与 D+1 待复习", async ({ page }) => {
  const username = await createAccount(page);
  const resourceId = "postgraduate-2007-cloze";
  const now = Date.now();

  await seededFirstAttemptFlow(page, username, resourceId, now);
  await navTo(page, "完形");
  const card = page.locator(".cloze-resource-card", { hasText: "2007 英语（一）完形填空" }).first();
  await expect(card).toBeVisible();
  await expect(card.locator(".cloze-resource-note")).toContainText("进行中 · 限时初做", { timeout: 15000 });

  // 注入 D+1 逾期任务 → 卡片切换为"待复习"优先级
  const today = await page.evaluate(() => {
    const nowDate = new Date();
    nowDate.setDate(nowDate.getDate() - 2);
    const pad = (value) => String(value).padStart(2, "0");
    return `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;
  });
  await setScopedJson(page, username, `wuliao:cloze-review-task:cloze-review:d1:${resourceId}:${resourceId}:2026-01-01`, {
    schemaVersion: 1,
    taskKey: `cloze-review:d1:${resourceId}:${resourceId}:2026-01-01`,
    type: "d1",
    resourceId,
    clozeId: resourceId,
    sourceDate: "2026-01-01",
    dueDate: today,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    skippedAt: null,
    currentIndex: 0,
    targetBlankIds: [1, 2, 3, 4, 5, 6, 7],
    targetReasons: {},
    attempts: {},
    updatedAt: now,
  });
  await page.reload();
  await navTo(page, "完形");
  const cardAfter = page.locator(".cloze-resource-card", { hasText: "2007 英语（一）完形填空" }).first();
  await expect(cardAfter.locator(".cloze-resource-note")).toContainText("D+1 待复习 · 7 空", { timeout: 15000 });

  await expectNoConsoleErrors(page);
});

test("完形陌生词：初做无入口，精析可标记，陌生词库来源筛选正确", async ({ page }) => {
  const username = await createAccount(page);
  const resourceId = "postgraduate-2007-cloze";
  const now = Date.now();

  // 初做阶段：共享工具栏无陌生词入口（两态门控：禁止查词阶段整个隐藏）
  await seededFirstAttemptFlow(page, username, resourceId, now);
  await openOfficialCloze(page, "2007 英语（一）完形填空");
  await expect(page.locator(".cloze-reader-stage")).toContainText("限时初做");
  await expect(page.locator(".cloze-reader-page > .annotation-toolbar button", { hasText: "陌生词" })).toHaveCount(0);
  await page.locator(".cloze-reader-header .back-button").click();
  await page.locator(".library-page").waitFor({ state: "visible" });

  // 精析阶段：共享工具栏陌生词完整开放（E2E dev 下离线词库降级 → prompt 人工补充）
  await seededAnalysisFlow(page, username, resourceId, now);
  await openOfficialCloze(page, "2007 英语（一）完形填空");
  await expect(page.locator(".cloze-reader-stage")).toContainText("逐空精析");
  const unknownBtn = page.locator(".cloze-reader-page > .annotation-toolbar button", { hasText: "陌生词" });
  await expect(unknownBtn).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept("测试释义"));
  await unknownBtn.click();
  await expect(unknownBtn).toHaveClass(/active/);
  await page.waitForTimeout(250); // 等 React effect 同步 surface toolRef

  // 打开分析页时 goToBlank 会 smooth 滚动；先把目标句子滚到视口中央
  // （与产品 scrollIntoView 一致），再计算单词视口坐标，避免被 sticky header
  // 遮挡或坐标过期。
  const wordPoint = await page.evaluate(() => {
    const sentence = document.querySelector(".cloze-sentence");
    if (!sentence) return null;
    sentence.scrollIntoView({ behavior: "instant", block: "center" });
    const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !/[A-Za-z]/.test(node.data || "")) node = walker.nextNode();
    if (!node) return null;
    const match = node.data.match(/[A-Za-z]+/);
    if (!match) return null;
    const range = document.createRange();
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[0].length);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  expect(wordPoint).not.toBeNull();
  await page.waitForTimeout(150); // 等滚动 settle
  await page.mouse.move(wordPoint.x, wordPoint.y);
  await page.mouse.down();
  await page.mouse.move(wordPoint.x + 1, wordPoint.y + 1, { steps: 2 });
  await page.mouse.up();
  await expect(page.locator(".toast")).toContainText("陌生词库已更新", { timeout: 10000 });

  // 返回完形资料库 → 陌生词库 → 完形筛选可见、精读筛选不可见
  await page.locator(".cloze-reader-header .back-button").click();
  await page.locator(".library-page").waitFor({ state: "visible" });
  await page.locator(".unknown-library-button").click();
  await page.locator(".unknown-library-page").waitFor({ state: "visible" });

  const clozeWords = page.locator(".unknown-word-card");
  await expect(clozeWords.first()).toBeVisible({ timeout: 15000 });

  await page.locator(".unknown-source-filter button", { hasText: "完形" }).click();
  await expect(page.locator(".unknown-word-card").first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".unknown-chapter h2").first()).toContainText("完形填空");

  await page.locator(".unknown-source-filter button", { hasText: "精读" }).click();
  await expect(page.locator(".unknown-word-card")).toHaveCount(0, { timeout: 10000 });

  await page.locator(".unknown-source-filter button", { hasText: "全部" }).click();
  await expect(page.locator(".unknown-word-card").first()).toBeVisible({ timeout: 10000 });

  await expectNoConsoleErrors(page);
});

test("首页：最近学习统一展示精读 + 完形，点击完形项可恢复", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();

  // 精读 recent（reading progress）
  await setScopedJson(page, username, "wuliao:progress:postgraduate-2012-text-3", {
    id: "postgraduate-2012-text-3",
    title: "2012 英语（一）Text 3",
    page: 2,
    total: 15,
    updatedAt: now - 2000,
  });
  // 完形训练 recent（cloze-flow）
  await seededFirstAttemptFlow(page, username, "postgraduate-2010-cloze", now);

  await page.reload();
  await page.locator(".home-page").waitFor({ timeout: 30000 });
  const recentCards = page.locator(".recent-card");
  await expect(recentCards.first()).toBeVisible({ timeout: 15000 });
  await expect(recentCards).toHaveCount(2);

  // 混排顺序：完形（更新）在前，精读在后
  await expect(recentCards.nth(0)).toContainText("完形训练");
  await expect(recentCards.nth(1)).toContainText("Text 3");

  // 点击完形项 → 恢复 ClozeReader 当前阶段
  await recentCards.nth(0).click();
  await page.locator(".cloze-reader-page").waitFor({ timeout: 60000 });
  await expect(page.locator(".cloze-reader-stage")).toContainText("限时初做", { timeout: 30000 });

  await expectNoConsoleErrors(page);
});
