import { test, expect } from "@playwright/test";
import { createAccount, openOfficialResource, clickStageAdvance, navTo, setScopedJson } from "./helpers.js";

// Flow 2：官方精读七阶段核心导航与持久化。
// cover → 题干预读 → 首次阅读 → 题目 → 翻译 → evidence/review → final。
// 交互驱动前四阶段；后三阶段用 fixture 种子验证渲染与解锁规则（业务规则不跳过）。

test("七阶段：导读→审题→初做（自动计时且原文题目同屏）交互推进与锁定规则", async ({ page }) => {
  await createAccount(page);
  await openOfficialResource(page, "2012 英语（一）Text 2");

  const stageNav = page.locator(".stage-nav.custom-workbook-stage");
  await expect(stageNav).toBeVisible();

  // 导读可见，审题被锁定隐藏
  await expect(page.locator("#deep-cover")).toBeVisible();
  await expect(page.locator("#deep-first-read")).toBeHidden();

  // cover → 题干预读
  await clickStageAdvance(page, "开始精读");
  await expect(page.locator("#deep-first-read")).toBeVisible();
  await expect(page.locator(".stem-table")).toBeVisible();

  // 题干预读 → 初做；自动开始计时，原文与题目同时显示
  await clickStageAdvance(page, "完成审题，进入初做");
  await expect(page.locator("#deep-clean-text")).toBeVisible();
  await expect(page.locator(".timed-reading-timer")).toBeVisible();
  await expect(page.locator("#deep-first-quiz")).toBeVisible();
  const initialView = await page.evaluate(() => {
    const cleanText = document.getElementById("deep-clean-text");
    const firstQuiz = document.getElementById("deep-first-quiz");
    if (!cleanText || !firstQuiz) return null;
    return {
      cleanTextTop: cleanText.getBoundingClientRect().top,
      firstQuizTop: firstQuiz.getBoundingClientRect().top,
    };
  });
  expect(initialView).not.toBeNull();
  expect(initialView.cleanTextTop).toBeGreaterThanOrEqual(0);
  expect(initialView.cleanTextTop).toBeLessThanOrEqual(180);
  expect(initialView.firstQuizTop).toBeGreaterThan(initialView.cleanTextTop);
  await expect(page.getByText("结束限时读文，进入第一次做题", { exact: true })).toHaveCount(0);

  // 初做阶段：5 道题可作答；逐段精读仍锁定
  await expect(page.locator("#deep-first-quiz")).toBeVisible();
  await expect(page.locator("#deep-first-quiz .deep-question-card")).toHaveCount(5);
  await page.locator("#deep-first-quiz .deep-question-card").first().locator(".deep-options button").first().click();
  await expect(page.locator("#deep-first-quiz .deep-question-card").first().locator(".deep-options button.selected")).toHaveCount(1);
  await expect(page.locator("#deep-translation")).toBeHidden();

  // 题目作答不能跳过证据 → 完成按钮保持禁用（业务规则）
  const advance = page.locator("#deep-first-quiz .stage-advance-button");
  await expect(advance).toBeDisabled();

  // persisted stage + refresh restore：hash 恢复来源页（资料库），重进文章恢复阶段
  await page.reload();
  await page.locator(".library-page").waitFor({ timeout: 60000 });
  const card = page.locator(".resource-card", { hasText: "2012 英语（一）Text 2" }).first();
  await card.locator(".resource-open").click();
  await page.locator(".reader-page").waitFor({ timeout: 90000 });
  await expect(page.locator("#deep-first-quiz")).toBeVisible();
  // 已作答保持
  await expect(page.locator("#deep-first-quiz .deep-question-card").first().locator(".deep-options button.selected")).toHaveCount(1);

  // Back → 资料库
  await page.locator(".reader-header .back-button").first().click();
  await page.locator(".library-page").waitFor({ state: "visible" });
});

// 回归：限时初做阶段习题悬浮窗必须真实打开（此前 FAB 可见但 Drawer 被
// !timedReadingActive 否决，形成“正文让位、面板隐藏”的 split-brain）。
test("限时初做：点击习题悬浮窗真实打开、关闭恢复、计时与阶段不受影响", async ({ page }) => {
  await page.setViewportSize({ width: 832, height: 544 });
  await createAccount(page);
  await openOfficialResource(page, "2012 英语（一）Text 2");

  await clickStageAdvance(page, "开始精读");
  await clickStageAdvance(page, "完成审题，进入初做");

  // 初做阶段前置：计时、原文、题目、习题 FAB 同屏可见
  await expect(page.locator(".timed-reading-timer")).toBeVisible();
  await expect(page.locator("#deep-clean-text")).toBeVisible();
  await expect(page.locator("#deep-first-quiz")).toBeVisible();
  await expect(page.locator(".question-fab")).toBeVisible();

  const currentStageLabel = () =>
    page.locator(".stage-nav.custom-workbook-stage button.current").innerText();
  expect(await currentStageLabel()).toContain("初做");

  // 点击习题 FAB → 真实打开 Drawer（DOM 级断言，不只看 drawerOpen state）
  const readerContent = page.locator(".deep-reader-content");
  const contentBefore = await readerContent.boundingBox();
  const layoutBefore = await readerContent.evaluate(element => ({ width: element.offsetWidth, height: element.offsetHeight }));
  await page.locator(".question-fab").click();
  const drawer = page.locator(".question-drawer.open");
  await expect(drawer).toBeVisible();
  await page.waitForTimeout(300);
  expect(await drawer.getAttribute("aria-hidden")).not.toBe("true");

  const box = await drawer.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  const viewport = page.viewportSize();
  expect(box.x + box.width).toBeGreaterThan(0);
  expect(box.x).toBeLessThan(viewport.width);
  expect(box.y + box.height).toBeGreaterThan(0);
  expect(box.y).toBeLessThan(viewport.height);
  await expect(drawer.locator(".question-item")).toHaveCount(5);

  // Existing paper layout scales the common text/ink surface for the panel.
  // Its layout dimensions stay fixed; transformed viewport bounds may move.
  const contentOpen = await readerContent.boundingBox();
  expect(await readerContent.evaluate(element => ({ width: element.offsetWidth, height: element.offsetHeight }))).toEqual(layoutBefore);
  const scale = await readerContent.evaluate(element => Number(element.dataset.paperScale));
  expect(scale).toBeGreaterThan(0);
  expect(scale).toBeLessThanOrEqual(1);
  expect(Math.abs(contentOpen.width - layoutBefore.width * scale)).toBeLessThanOrEqual(1);
  expect(contentOpen.x + contentOpen.width).toBeLessThanOrEqual(box.x - 12);
  await expect(drawer).toBeVisible();

  // 关闭 → FAB 恢复，正文不再留“只让位、无面板”的空白
  await page.locator("button[aria-label=\"关闭题窗\"]").click();
  await expect(page.locator(".question-drawer.open")).toHaveCount(0);
  await expect(page.locator(".question-fab")).toBeVisible();
  await expect(page.locator(".question-fab")).not.toHaveClass(/hidden/);
  await expect(readerContent).not.toHaveAttribute("data-paper-moving", "true");
  const contentClosed = await readerContent.boundingBox();
  expect(Math.abs(contentClosed.x - contentBefore.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(contentClosed.width - contentBefore.width)).toBeLessThanOrEqual(1);

  // 计时与阶段全程不受影响
  await expect(page.locator(".timed-reading-timer")).toBeVisible();
  await expect(page.locator("#deep-first-quiz")).toBeVisible();
  expect(await currentStageLabel()).toContain("初做");

  // 再次打开→关闭，确保可重复且无残留布局
  await page.locator(".question-fab").click();
  await expect(page.locator(".question-drawer.open")).toBeVisible();
  await page.locator("button[aria-label=\"关闭题窗\"]").click();
  await expect(page.locator(".question-drawer.open")).toHaveCount(0);
  await expect(page.locator(".question-fab")).toBeVisible();
});

// 响应式边界快速检查：Drawer 可显示且不越界（不新增 breakpoint）
test("习题悬浮窗响应式边界：760/899/1100/1400 均可显示且不出屏", async ({ page }) => {
  await createAccount(page);
  await openOfficialResource(page, "2012 英语（一）Text 2");

  for (const width of [760, 899, 1100, 1400]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(200);
    await page.locator(".question-fab").click();
    const drawer = page.locator(".question-drawer.open");
    await expect(drawer).toBeVisible();
    await page.waitForTimeout(300);
    const box = await drawer.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(box.vw + 1);
    expect(box.top).toBeGreaterThanOrEqual(-1);
    expect(box.bottom).toBeLessThanOrEqual(box.vh + 1);
    await page.locator("button[aria-label=\"关闭题窗\"]").click();
    await expect(page.locator(".question-drawer.open")).toHaveCount(0);
  }
});

test("七阶段全览：fixture 种子后全部阶段可访问（Reader Chrome 完整）", async ({ page }) => {
  const username = await createAccount(page);
  await openOfficialResource(page, "2012 英语（一）Text 2");

  // 先完成导读让 flow 落盘，动态发现真实 passageId（解析器输出可因资料而异）
  await clickStageAdvance(page, "开始精读");
  const flowKey = await page.evaluate(() => Object.keys(localStorage).find((key) => key.includes("wuliao:reading-flow:")));
  expect(flowKey).toBeTruthy();
  const passageId = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).passageId, flowKey);
  expect(passageId).toBeTruthy();

  const now = Date.now();
  const done = { status: "completed", completedAt: now };
  await page.evaluate(({ key, resourceId, passageId, now, done }) => {
    localStorage.setItem(key, JSON.stringify({
      schemaVersion: 1,
      resourceId,
      passageId,
      stages: {
        "deep-cover": done,
        "deep-first-read": done,
        "deep-clean-text": done,
        "deep-first-quiz": done,
        "deep-translation": done,
        "deep-redo": done,
        "deep-review": { status: "current", completedAt: null },
      },
      currentStage: "deep-review",
      timedReading: { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: now },
      updatedAt: now,
    }));
  }, { key: flowKey, resourceId: "postgraduate-2012-text-2", passageId, now, done });

  // 重进文章：七个阶段按钮全部可点击（无锁定）
  await page.reload();
  await page.locator(".library-page").waitFor({ timeout: 60000 });
  await page.locator(".resource-card", { hasText: "2012 英语（一）Text 2" }).first().locator(".resource-open").click();
  await page.locator(".reader-page").waitFor({ timeout: 90000 });

  const stageLabels = ["导读", "审题", "初做", "逐段精读", "重做", "复读压缩"];
  for (const label of stageLabels) {
    const button = page.locator(".stage-nav.custom-workbook-stage button", { hasText: label }).first();
    await expect(button).toBeVisible();
    expect(await button.getAttribute("aria-disabled")).toBeNull();
  }

  // 逐阶段点击 → 对应 section 可见（含翻译 / 重做 / 复读压缩）
  const stages = [
    ["导读", "#deep-cover"],
    ["审题", "#deep-first-read"],
    ["初做", "#deep-clean-text"],
    ["逐段精读", "#deep-translation"],
    ["重做", "#deep-redo"],
    ["复读压缩", "#deep-review"],
  ];
  for (const [label, selector] of stages) {
    await page.locator(".stage-nav button", { hasText: label }).first().click();
    await expect(page.locator(selector)).toBeVisible({ timeout: 10000 });
    if (label === "初做") await expect(page.locator("#deep-first-quiz")).toBeVisible({ timeout: 10000 });
  }
  await expect(page.locator("#deep-review")).toBeVisible({ timeout: 10000 });

  // Reader Chrome：批注工具栏 + 导出 + 原 PDF 入口
  await expect(page.locator(".annotation-toolbar, .deep-annotation-toolbar").first()).toBeVisible();
  await expect(page.locator("button", { hasText: "导出成品 PDF" })).toBeVisible();
  await expect(page.locator("button", { hasText: /查看.*PDF/ })).toBeVisible();

  // Back → 资料库
  await page.locator(".reader-header .back-button").first().click();
  await page.locator(".library-page").waitFor({ state: "visible" });
});
