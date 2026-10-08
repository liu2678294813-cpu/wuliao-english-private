import { test, expect } from "@playwright/test";
import { createAccount, openOfficialCloze, openOfficialResource, setScopedJson } from "./helpers.js";

const sizes = [[390, 844], [544, 832], [832, 544], [600, 960], [960, 600], [800, 1280], [1280, 800], [1024, 640], [1600, 900]];

async function openInkToolbar(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const username = await createAccount(page);
  const resource = "postgraduate-2007-cloze", now = Date.now();
  await setScopedJson(page, username, `wuliao:cloze-flow:${resource}:${resource}`, {
    schemaVersion: 1, resourceId: resource, clozeId: resource,
    stages: {
      "cloze-cover": { status: "completed", completedAt: now },
      "cloze-first-attempt": { status: "completed", completedAt: now },
      "cloze-self-review": { status: "current", completedAt: null },
    }, currentStage: "cloze-self-review", updatedAt: now,
    timedAttempt: { phase: "done", elapsedMs: 0, startedAt: null, pausedAt: null, completedAt: now },
  });
  await openOfficialCloze(page, "2007 英语（一）完形填空");
  const bar = page.locator(".cloze-reader-page > .annotation-toolbar");
  await expect(bar).toBeVisible();
  return bar;
}

test("floating ink toolbar remains reachable after drag and split-window resize", async ({ page }, info) => {
  const bar = await openInkToolbar(page);
  await bar.locator(".toolbar-collapse-toggle").click();
  const pill = bar.locator(".toolbar-collapse-toggle");
  const box = await pill.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(1170, 680, { steps: 10 });
  await page.mouse.up();
  await page.setViewportSize({ width: 544, height: 420 });
  await expect.poll(async () => {
    const rect = await pill.boundingBox();
    return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 545 && rect.y + rect.height <= 421;
  }).toBe(true);
  await page.screenshot({ path: info.outputPath("toolbar-resized.png") });
  await pill.click();
  await expect(bar.locator(".tool-size-range-track")).toBeVisible();
});

test("pen size slider releases when pointer ends outside its track", async ({ page }) => {
  const bar = await openInkToolbar(page);
  const slider = bar.getByRole("slider", { name: "画笔粗细" });
  const box = await slider.boundingBox(), y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 50, y + 80);
  await page.mouse.up();
  const value = await slider.getAttribute("aria-valuenow");
  await page.mouse.move(box.x + 2, y);
  await expect(slider).toHaveAttribute("aria-valuenow", value);
});

test("AI panel preserves draft when available window height is reduced", async ({ page }, info) => {
  await page.setViewportSize({ width: 832, height: 544 });
  await createAccount(page);
  await openOfficialResource(page, "2012 英语（一）Text 2");
  await page.locator(".ai-float-button").click();
  const input = page.locator(".ai-float-input textarea");
  await input.fill("compatibility draft - no API request");
  await page.setViewportSize({ width: 544, height: 360 });
  await expect(input).toHaveValue("compatibility draft - no API request");
  await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(361);
  await page.screenshot({ path: info.outputPath("ai-visual-viewport.png") });
  await page.setViewportSize({ width: 832, height: 544 });
  await expect(input).toHaveValue("compatibility draft - no API request");
});

test("floating toolbar responds to visual viewport resize without a window resize", async ({ page }) => {
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { offsetLeft: 0, offsetTop: 0, width: 1280, height: 800, scale: 1 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  });
  const bar = await openInkToolbar(page);
  await bar.locator(".toolbar-collapse-toggle").click();
  const pill = bar.locator(".toolbar-collapse-toggle"), rect = await pill.boundingBox();
  await page.mouse.move(rect.x + 20, rect.y + 20);
  await page.mouse.down();
  await page.mouse.move(1050, 680, { steps: 8 });
  await page.mouse.up();
  expect((await pill.boundingBox()).y).toBeGreaterThan(300);
  await page.evaluate(() => {
    Object.assign(visualViewport, { offsetTop: 20, offsetLeft: 15, width: 550, height: 280 });
    visualViewport.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => {
    const box = await pill.boundingBox();
    return box.x >= 15 && box.y >= 20 && box.x + box.width <= 565 && box.y + box.height <= 300;
  }).toBe(true);
});

for (const profile of [
  { name: "ordinary", width: 800, height: 1280, dpr: 1, cpu: 1, font: 1 },
  { name: "slow-cpu-font150", width: 600, height: 960, dpr: 1.875, cpu: 4, font: 1.5 },
  { name: "large-high-density-dark", width: 1600, height: 900, dpr: 3, cpu: 1, font: 1 },
]) {
  test.describe(profile.name, () => {
    test.use({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: profile.dpr,
      colorScheme: profile.name.endsWith("dark") ? "dark" : "light" });
    test("density/font and relative CPU profile keeps settings accessible", async ({ page }, info) => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
      const started = performance.now();
      await createAccount(page);
      const homeReadyMs = performance.now() - started;
      if (profile.font !== 1) {
        await page.evaluate((scale) => {
          // Browser text-size stress only; actual Android fontScale is tested on device.
          const fonts = [...document.querySelectorAll("body *")].map((element) => [element, parseFloat(getComputedStyle(element).fontSize)]);
          for (const [element, size] of fonts) if (size > 0) element.style.fontSize = `${size * scale}px`;
        }, profile.font);
      }
      await checkPage(page, info, "home-profile");
      await page.getByRole("button", { name: /^(打开 AI API 设置|AI API)$/ }).filter({ visible: true }).click();
      await expect(page.getByRole("dialog", { name: "AI API 设置" })).toBeVisible();
      await page.getByRole("tab", { name: "视觉 AI" }).click();
      await page.getByRole("tab", { name: "文本 AI" }).click();
      await page.getByRole("button", { name: "关闭 AI API 设置" }).click();
      await checkPage(page, info, "settings-closed");
      await info.attach("relative-performance", { body: JSON.stringify({ profile, homeReadyMs,
        note: "Includes account creation; browser CPU proxy, not brand-device latency or low-memory acceptance" }), contentType: "application/json" });
      await cdp.detach();
    });
  });
}

async function navigate(page, label) {
  const nav = page.locator(page.viewportSize().width <= 760 ? ".ds-bottom-nav" : ".ds-rail .ds-nav");
  await nav.getByRole("button", { name: label, exact: true }).click();
}

async function checkPage(page, info, name) {
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect.soft(bounds.scroll, `${name}: document horizontal overflow`).toBeLessThanOrEqual(bounds.width + 1);
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
}

for (const [width, height] of sizes) {
  test(`window ${width}x${height}: modules, dialogs, iframe, reader and rotation`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await createAccount(page);
    await expect(page).toHaveTitle(/无聊英语/);
    await checkPage(page, info, "home");
    await page.getByRole("button", { name: "60 分钟", exact: true }).click();
    await page.setViewportSize({ width: height, height: width });
    await expect(page.getByRole("button", { name: "60 分钟", exact: true })).toHaveClass("active");
    await page.setViewportSize({ width, height });
    await page.getByRole("button", { name: "学习档案", exact: true }).click();
    await expect(page.getByRole("button", { name: "阅读档案", exact: true })).toBeVisible();
    await checkPage(page, info, "archive-dialog");
    await page.getByRole("button", { name: "关闭学习档案入口" }).click();

    for (const label of ["写作", "长难句", "词库", "筛查", "背诵", "复习", "完形", "精读"]) {
      await navigate(page, label);
      if (["词库", "筛查", "背诵", "复习"].includes(label)) {
        const frame = page.frameLocator(".vocabulary-frame");
        await expect(frame.locator("body")).not.toBeEmpty();
        if (label === "背诵") await expect(frame.locator("#listSelect")).toBeVisible();
        const bounds = await frame.locator("body").evaluate((body) => ({ width: body.clientWidth, scroll: body.scrollWidth }));
        expect.soft(bounds.scroll, `${label}: iframe overflow`).toBeLessThanOrEqual(bounds.width + 1);
      }
      await checkPage(page, info, label);
    }
    await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
    await expect(page.locator(".reader-page")).toBeVisible({ timeout: 90000 });
    await page.getByRole("button", { name: "开始精读", exact: true }).click();
    await expect(page.locator(".deep-reader-content")).toBeVisible();
    await checkPage(page, info, "reader");
    await page.setViewportSize({ width: height, height: width });
    await expect(page.locator(".deep-reader-content")).toBeVisible();
    await checkPage(page, info, "reader-rotated");
    await page.setViewportSize({ width, height });
    const stage = await page.locator(".stage-nav .current").first().textContent();
    await page.reload();
    // Existing navigation contract: reload returns to the library, then opening
    // the same resource restores its persisted learning stage.
    await expect(page.locator(".library-page")).toBeVisible();
    await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
    await expect(page.locator(".reader-page")).toBeVisible({ timeout: 90000 });
    await expect(page.locator(".stage-nav .current").first()).toHaveText(stage);
    await checkPage(page, info, "reader-restored");
    expect(errors).toEqual([]);
  });
}
