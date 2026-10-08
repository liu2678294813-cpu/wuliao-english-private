import { test, expect } from "@playwright/test";
import { createAccount, navTo, openOfficialCloze, openOfficialResource, setScopedJson, uniqueUsername, readDurableInkEntries } from "./helpers.js";

// Flow 16：2026-08-13 平板 UI/交互统一修正。
// 覆盖：导航/设置、底部导航 9 项、Home 删减、资料库 4/2/1 列、
// 词库/筛查单屏、完形题窗收起+笔迹不变、Lasso 预览、折叠 pill 拖拽。

const CLOZE_RESOURCE_ID = "postgraduate-2007-cloze";

function seedClozeFlow(page, username, currentStage, now, extra = {}) {
  return setScopedJson(page, username, `wuliao:cloze-flow:${CLOZE_RESOURCE_ID}:${CLOZE_RESOURCE_ID}`, {
    schemaVersion: 1,
    resourceId: CLOZE_RESOURCE_ID,
    clozeId: CLOZE_RESOURCE_ID,
    stages: {
      "cloze-cover": { status: "completed", completedAt: now },
      "cloze-first-attempt": { status: "completed", completedAt: now },
      "cloze-self-review": { status: "completed", completedAt: now },
      "cloze-correction": { status: "pending", completedAt: null },
      "cloze-analysis": { status: "pending", completedAt: null },
      "cloze-final-read": { status: "pending", completedAt: null },
      ...extra.stages,
    },
    currentStage,
    timedAttempt: { phase: "done", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: now },
    updatedAt: now,
  });
}

function seedClozeProgress(page, username, { firstSubmitted = false, attempts = {} } = {}) {
  return setScopedJson(page, username, `wuliao:cloze-progress:${CLOZE_RESOURCE_ID}:${CLOZE_RESOURCE_ID}`, {
    schemaVersion: 2,
    resourceId: CLOZE_RESOURCE_ID,
    clozeId: CLOZE_RESOURCE_ID,
    attempts,
    activeBlank: 1,
    firstSubmitted,
    reviewSubmitted: false,
    updatedAt: Date.now(),
  });
}

async function drawStroke(page, box, from = [0.25, 0.2], to = [0.45, 0.35]) {
  const startX = box.x + box.width * from[0];
  const startY = box.y + box.height * from[1];
  const endX = box.x + box.width * to[0];
  const endY = box.y + box.height * to[1];
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(450);
}

async function passageBox(page) {
  const passage = page.locator(".cloze-passage");
  await expect(passage).toBeVisible();
  return passage.boundingBox();
}

async function readClozeInkRaw(page, username) {
  return (await readDurableInkEntries(page, username)).filter(({ key }) => key.startsWith("wuliao:cloze-ink:v1:")).map(({ value }) => value);
}

async function dragPill(page, pill, dx = 90, dy = 50) {
  const box = await pill.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
}

test("导航与设置：无模拟入口，设置内可切换账号", async ({ page }) => {
  await createAccount(page);
  await expect(page.getByRole("button", { name: "模拟", exact: true })).toHaveCount(0);
  await expect(page.locator(".ds-account")).toHaveCount(0);
  await expect(page.locator(".ds-rail-footer button")).toHaveCount(2);
  await page.locator(".ds-settings").click();
  await expect(page.locator(".settings-panel")).toBeVisible();
  await expect(page.locator(".settings-section h3", { hasText: "账号" })).toBeVisible();
  await expect(page.getByRole("button", { name: "切换账号" })).toBeVisible();
});

test("Home 删减与底部导航 9 项：390 每项≥44px，320 横向滚动，544 无横向滚动", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createAccount(page);
  await expect(page.locator(".overview-local-note")).toHaveCount(0);
  await expect(page.locator(".quick-start")).toHaveCount(0);
  const buttons = page.locator(".ds-bottom-nav button");
  await expect(buttons).toHaveCount(9);
  let widths = await buttons.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(43.9);

  await page.setViewportSize({ width: 320, height: 640 });
  const nav = page.locator(".ds-bottom-nav");
  const narrow = await nav.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(narrow.scroll).toBeGreaterThan(narrow.client);
  widths = await buttons.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(43.9);

  await page.setViewportSize({ width: 544, height: 832 });
  const tablet = await nav.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(tablet.scroll).toBeLessThanOrEqual(tablet.client + 1);
});

test("精读资料库：832 横屏 4 卡一行，544 竖屏 2 卡一行", async ({ page }) => {
  await page.setViewportSize({ width: 832, height: 544 });
  await createAccount(page);
  await navTo(page, "精读");
  await page.locator(".year-group").first().waitFor({ timeout: 30000 });
  const grid = page.locator(".year-group").first().locator(".resource-grid");
  await expect(grid.locator(".resource-card")).toHaveCount(4);
  const readTops = async () => grid.locator(".resource-card").evaluateAll((cards) => cards.map((card) => {
    const rect = card.getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left) };
  }));
  const landscape = await readTops();
  expect(landscape.slice(1).every((box) => Math.abs(box.top - landscape[0].top) <= 1)).toBe(true);
  expect(landscape[1].left).toBeGreaterThan(landscape[0].left);

  await page.setViewportSize({ width: 544, height: 832 });
  const portrait = await readTops();
  expect(Math.abs(portrait[1].top - portrait[0].top) <= 1).toBe(true);
  expect(portrait[2].top).toBeGreaterThan(portrait[0].top + 10);
});

test("词库 dashboard 无最近词库且无纵向滚动；筛查无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 832, height: 544 });
  await createAccount(page);
  await navTo(page, "词库");
  const frame = page.frameLocator(".vocabulary-frame");
  await frame.locator("#root main").first().waitFor({ timeout: 30000 });
  await expect(frame.locator("body")).not.toContainText("最近词库");
  const dashboard = await frame.locator("html").evaluate((el) => {
    const doc = el.ownerDocument.documentElement;
    return { scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight };
  });
  expect(dashboard.scrollHeight).toBeLessThanOrEqual(dashboard.clientHeight + 2);

  await navTo(page, "筛查");
  await frame.locator("body").waitFor({ timeout: 15000 });
  const screening = await frame.locator("html").evaluate((el) => {
    const doc = el.ownerDocument.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
  expect(screening.scrollWidth).toBeLessThanOrEqual(screening.clientWidth + 2);
});

test("完形：题窗收起/展开 + 笔迹 persisted 不变 + Lasso 预览非空", async ({ page }) => {
  const username = await createAccount(page);
  const now = Date.now();
  await seedClozeFlow(page, username, "cloze-self-review", now, {
    stages: { "cloze-self-review": { status: "current", completedAt: null } },
  });
  await seedClozeProgress(page, username, { firstSubmitted: true, attempts: { 1: { firstAnswer: "D" } } });
  await openOfficialCloze(page, "2007 英语（一）完形填空");
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  const box = await passageBox(page);
  await drawStroke(page, box);
  const inkBefore = await readClozeInkRaw(page, username);
  expect(inkBefore.length).toBeGreaterThan(0);

  const questionPanel = page.locator(".cloze-question-panel");
  if (!(await questionPanel.isVisible())) {
    await page.locator(".cloze-panel-expand-fab").click();
  }
  await expect(questionPanel).toBeVisible();
  const passageBefore = await page.locator(".cloze-passage").evaluate(element => element.offsetWidth);
  const panelBefore = (await questionPanel.boundingBox()).width;
  expect(panelBefore).toBeGreaterThan(150);

  await page.locator(".cloze-panel-toggle", { hasText: "收起题窗" }).click();
  await expect(questionPanel).toBeHidden();
  const passageCollapsed = await page.locator(".cloze-passage").evaluate(element => element.offsetWidth);
  expect(Math.abs(passageCollapsed - passageBefore)).toBeLessThan(3);
  await expect(page.locator(".cloze-panel-expand-fab", { hasText: "展开题窗" })).toBeVisible();

  await page.locator(".cloze-panel-expand-fab").click();
  await expect(questionPanel).toBeVisible();
  const passageAfter = await page.locator(".cloze-passage").evaluate(element => element.offsetWidth);
  expect(Math.abs(passageAfter - passageBefore)).toBeLessThan(3);
  const inkAfter = await readClozeInkRaw(page, username);
  expect(inkAfter).toEqual(inkBefore);

  await page.locator(".annotation-toolbar button", { hasText: "橡皮" }).click();
  await page.locator(".annotation-toolbar .tool-mode-picker button", { hasText: "自由套索" }).click();
  const lassoBox = await passageBox(page);
  await page.mouse.move(lassoBox.x + lassoBox.width * 0.2, lassoBox.y + lassoBox.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(lassoBox.x + lassoBox.width * 0.5, lassoBox.y + lassoBox.height * 0.2, { steps: 5 });
  const previewPixels = await page.evaluate(() => {
    const canvas = document.querySelector(".cloze-ink-preview");
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 0) count += 1;
    }
    return count;
  });
  expect(previewPixels).toBeGreaterThan(0);
  await page.mouse.up();
});


test("精读：收起顶部后保留完整工具栏，轻点可展开", async ({ page }) => {
  await createAccount(page);
  await openOfficialResource(page, "2007 英语（一）Text 1");
  await expect(page.locator(".reader-page")).toBeVisible({ timeout: 120000 });
  await page.locator(".toolbar-collapse-toggle", { hasText: "收起顶部" }).click();
  const expand = page.locator(".toolbar-collapse-toggle", { hasText: /展开/ });
  await expect(expand).toBeVisible();
  await expect(page.locator(".annotation-toolbar .input-mode-picker")).toBeVisible();
  await expect(page.locator(".annotation-toolbar").getByRole("button", { name: /橡皮/ })).toBeVisible();
  await expect(page.locator(".stage-nav")).toBeHidden();
  await expect.poll(async () => (await page.locator(".annotation-toolbar").boundingBox()).y).toBeLessThanOrEqual(8);
  await expand.click();
  await expect(page.locator(".toolbar-collapse-toggle", { hasText: "收起顶部" })).toBeVisible();
});

test("品牌点击折叠为图标 rail：首页与 workspace 页均不导航，immersive 无 rail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createAccount(page);
  const rail = page.locator(".ds-rail");
  const content = page.locator(".ds-shell-content");
  const collapseAndRestore = async () => {
    await expect(rail).toBeVisible();
    const expandedLeft = (await content.boundingBox()).x;
    expect(expandedLeft).toBeGreaterThan(100);

    await page.locator(".ds-brand").click();
    await page.waitForTimeout(260);
    await expect(page.locator(".ds-shell")).toHaveClass(/ds-shell-collapsed/);
    await expect(rail).toBeVisible();
    await expect(page.locator(".ds-nav > button > span:visible")).toHaveCount(0);
    const collapsedLeft = (await content.boundingBox()).x;
    expect(collapsedLeft).toBeLessThan(expandedLeft - 100);
    const collapsedRail = await rail.boundingBox();
    expect(Math.abs(collapsedRail.width - 64)).toBeLessThanOrEqual(1);

    await page.locator(".ds-brand").click();
    await page.waitForTimeout(260);
    await expect(page.locator(".ds-shell")).not.toHaveClass(/ds-shell-collapsed/);
    const restoredLeft = (await content.boundingBox()).x;
    expect(Math.abs(restoredLeft - expandedLeft)).toBeLessThanOrEqual(1);
    expect((await rail.boundingBox()).x).toBe(0);
  };

  await collapseAndRestore();

  await navTo(page, "精读");
  await expect(page.locator(".library-page")).toBeVisible({ timeout: 30000 });
  await collapseAndRestore();
  await expect(page.locator(".library-page")).toBeVisible();

  await openOfficialResource(page, "2007 英语（一）Text 1");
  await expect(page.locator(".reader-page")).toBeVisible({ timeout: 120000 });
  await expect(page.locator(".ds-rail")).toHaveCount(0);
  await expect(page.locator(".ds-sidebar-restore")).toHaveCount(0);
});

test("移动端不出现 desktop restore，immersive reader 不渲染侧栏", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createAccount(page);
  await expect(page.locator(".ds-sidebar-restore")).toHaveCount(0);
  await expect(page.locator(".ds-rail")).toBeHidden();
  const mobileLeft = (await page.locator(".ds-shell-content").boundingBox()).x;
  expect(mobileLeft).toBe(0);
});

test("精读与完形 Toolbar 实测视觉几何一致（row/button/slider/swatch/divider ≤1px）", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const username = await createAccount(page, uniqueUsername("ui-toolbar"));

  const measure = async (toolbar) => {
    await expect(toolbar).toBeVisible({ timeout: 60000 });
    await toolbar.evaluate((element) => element.classList.add("tablet-ink-toolbar"));
    await toolbar.getByRole("button", { name: "笔", exact: true }).click();
    await expect(toolbar.locator(".color-picker button").first()).toBeVisible();
    const round = (value) => Math.round(value * 10) / 10;
    const row = await toolbar.boundingBox();
    const pen = await toolbar.getByRole("button", { name: "笔", exact: true }).boundingBox();
    const toggle = await toolbar.locator(".toolbar-collapse-toggle").boundingBox();
    const track = await toolbar.locator(".tool-size-control .tool-size-range-track").boundingBox();
    const swatch = await toolbar.locator(".color-picker button").first().boundingBox();
    const divider = await toolbar.locator(".toolbar-divider").boundingBox();
    return {
      row: round(row.height),
      penButton: [round(pen.width), round(pen.height)],
      toggle: round(toggle.height),
      sliderTrack: round(track.height),
      swatch: [round(swatch.width), round(swatch.height)],
      divider: round(divider.height),
    };
  };

  const now = Date.now();
  await seedClozeFlow(page, username, "cloze-self-review", now, {
    stages: { "cloze-self-review": { status: "current", completedAt: null } },
  });
  await seedClozeProgress(page, username, { firstSubmitted: true, attempts: { 1: { firstAnswer: "D" } } });
  await openOfficialCloze(page, "2007 英语（一）完形填空");
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  const cloze = await measure(page.locator(".cloze-reader-page > .annotation-toolbar"));
  await page.locator(".cloze-reader-header .back-button").click();
  await expect(page.locator(".library-page")).toBeVisible({ timeout: 30000 });

  await openOfficialResource(page, "2007 英语（一）Text 1");
  const reader = await measure(page.locator(".reader-page > .annotation-toolbar"));

  const samples = { 精读: reader, 完形: cloze };
  const assertWithin = (getter, label) => {
    const values = Object.entries(samples).map(([host, sample]) => [host, getter(sample)]);
    const reference = values[0][1];
    for (const [host, value] of values) {
      const delta = Array.isArray(reference)
        ? Math.max(Math.abs(value[0] - reference[0]), Math.abs(value[1] - reference[1]))
        : Math.abs(value - reference);
      expect(delta, `${label} 不一致（精读=${JSON.stringify(reference)}，${host}=${JSON.stringify(value)}）`).toBeLessThanOrEqual(1);
    }
  };
  assertWithin((sample) => sample.row, "toolbar row height");
  assertWithin((sample) => sample.penButton, "pen button box");
  assertWithin((sample) => sample.toggle, "collapse toggle height");
  assertWithin((sample) => sample.sliderTrack, "slider track height");
  assertWithin((sample) => sample.swatch, "color swatch box");
  assertWithin((sample) => sample.divider, "divider height");
});
