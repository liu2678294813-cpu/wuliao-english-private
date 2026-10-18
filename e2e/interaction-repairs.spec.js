import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createAccount, uniqueUsername, openOfficialResource, clickStageAdvance, readDurableInkEntries } from "./helpers.js";

const TITLE = "2007 英语（一）Text 1";
const browserLogs = new WeakMap();

test.beforeEach(async ({ page }) => {
  const logs = { errors: [], warnings: [] };
  browserLogs.set(page, logs);
  page.on("console", message => {
    if (message.type() === "error") logs.errors.push(message.text());
    if (message.type() === "warning") logs.warnings.push(message.text());
  });
});

test.afterEach(async ({ page }, info) => {
  const health = {
    url: page.url(), title: await page.title(),
    readerVisible: await page.locator(".reader-page").isVisible(),
    errorOverlays: await page.locator("vite-error-overlay").count(),
    ...browserLogs.get(page),
  };
  const healthPath = info.outputPath("browser-health.json");
  await writeFile(healthPath, JSON.stringify(health, null, 2));
  await info.attach("browser-health", { path: healthPath, contentType: "application/json" });
  expect(new URL(health.url).hostname).toBe("127.0.0.1");
  expect(health.title).toContain("无聊英语");
  expect(health.readerVisible).toBe(true);
  expect(health.errorOverlays).toBe(0);
  expect(health.errors).toEqual([]);
});

async function reopen(page, android) {
  await page.reload();
  await page.locator(".library-page").waitFor();
  if (android) await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
  await page.locator(".resource-card", { hasText: TITLE }).first().locator(".resource-open").click();
  await expect(page.locator("#deep-translation")).toBeVisible();
  await page.waitForTimeout(700);
}

async function fixture(page, android = false) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const username = await createAccount(page, uniqueUsername("interaction-repair"));
  if (android) await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
  await openOfficialResource(page, TITLE);
  await clickStageAdvance(page, "开始精读");
  await page.evaluate(username => {
    const prefix = `wuliao:user:${encodeURIComponent(username)}:`;
    const key = Object.keys(localStorage).find(key => key.startsWith(`${prefix}wuliao:reading-flow:`));
    const flow = JSON.parse(localStorage.getItem(key));
    for (const id of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz"]) {
      flow.stages[id] = { status: "completed", completedAt: 100 };
    }
    flow.stages["deep-translation"] = { status: "current", completedAt: null };
    flow.currentStage = "deep-translation";
    flow.timedReading = { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: 100 };
    localStorage.setItem(key, JSON.stringify(flow));
  }, username);
  await reopen(page, android);
  return { username, errors };
}

async function unknownWords(page, username) {
  return page.evaluate(async username => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("wuliao-english");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("unknown-words").objectStore("unknown-words").index("username").getAll(username);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, username);
}

async function tokenPoint(page, selector) {
  return page.locator(selector).first().evaluate(async scope => {
    await document.fonts.ready;
    scope.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const node = [...scope.childNodes].find(node => node.nodeType === Node.TEXT_NODE && /[A-Za-z]/.test(node.textContent));
    const word = [...node.data.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)][3];
    const range = document.createRange();
    range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
    const rect = range.getClientRects()[0];
    return { word: word[0], x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  });
}

async function fingerTap(page, point) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    await page.waitForTimeout(100);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
}

async function penStroke(page, field) {
  await field.scrollIntoViewIfNeeded();
  const rect = await field.boundingBox();
  const x = rect.x + 25, y = rect.y + 18;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: .5 });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + i * 5, y: y + i, buttons: 1, pointerType: "pen", force: .5 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 40, y: y + 8, button: "left", buttons: 0, pointerType: "pen", force: 0 });
  } finally { await cdp.detach(); }
}

async function strokes(page, username) {
  return (await readDurableInkEntries(page, username)).flatMap(row => {
    const value = JSON.parse(row.value); return Array.isArray(value) ? value : [];
  });
}

for (const android of [false, true]) {
  const profile = android ? "Android UI simulation" : "web";

  test(`${profile}: finger adds and cancels on both English displays, survives reload`, async ({ page }, info) => {
    const f = await fixture(page, android);
    for (const selector of [".sentence-source [data-unknown-scope]", ".paragraph-source-repeat [data-unknown-scope]"]) {
      let point = await tokenPoint(page, selector);
      await fingerTap(page, point);
      await expect.poll(async () => (await unknownWords(page, f.username)).map(row => row.word)).toContain(point.word);
      await page.screenshot({ path: info.outputPath(selector.includes("repeat") ? "repeat-added.png" : "sentence-added.png") });
      await reopen(page, android);
      expect(await unknownWords(page, f.username)).toHaveLength(1);
      point = await tokenPoint(page, selector);
      await fingerTap(page, point);
      await expect.poll(async () => (await unknownWords(page, f.username)).length).toBe(0);
    }
    expect(await strokes(page, f.username)).toHaveLength(0);
    expect(f.errors).toEqual([]);
  });

  test(`${profile}: original input/tool order is preserved and controls remain reachable`, async ({ page }, info) => {
    const f = await fixture(page, android);
    const bar = page.locator(".annotation-toolbar");
    for (const width of [390, 320, 544, 820, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await bar.evaluate(element => { element.scrollLeft = 0; });
      expect(await bar.getByRole("button").allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("键盘输入"), expect.stringContaining("手写批注"), expect.stringContaining("陌生词")]));
      const labels = await bar.getByRole("button").allTextContents();
      const index = name => labels.findIndex(label => label.trim().endsWith(name));
      expect(index("键盘输入")).toBeLessThan(index("手写批注"));
      expect(index("手写批注")).toBeLessThan(index("笔"));
      expect(index("笔")).toBeLessThan(index("橡皮"));
      expect(index("橡皮")).toBeLessThan(index("陌生词"));
      for (const name of ["笔", "橡皮", "陌生词"]) {
        const button = bar.getByRole("button", { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeVisible();
        const rect = await button.boundingBox();
        expect(rect.x, `${name} at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width, `${name} at ${width}px`).toBeLessThanOrEqual(width + 1);
      }
      if (width === 1280) {
        await bar.evaluate(element => { element.scrollLeft = 0; });
        await page.screenshot({ path: info.outputPath("toolbar-restored.png") });
      }
    }
    expect(f.errors).toEqual([]);
  });
}

test("Android UI simulation: first pen stroke from keyboard input is saved and restored", async ({ page }, info) => {
  const f = await fixture(page, true);
  const bar = page.locator(".annotation-toolbar");
  await bar.getByRole("button", { name: "键盘输入", exact: true }).click();
  const field = page.locator(".translation-unit .deep-writing-lines").first();
  await expect(field).toBeEditable();
  await field.fill("保留原有键盘笔译");
  await penStroke(page, field);
  await expect.poll(async () => (await strokes(page, f.username)).length).toBe(1);
  await expect(field).toHaveValue("保留原有键盘笔译");
  await expect(field).toHaveAttribute("readonly", "");
  expect(await unknownWords(page, f.username)).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("first-pen-stroke.png") });
  await reopen(page, true);
  expect(await strokes(page, f.username)).toHaveLength(1);
  await expect(field).toHaveValue("保留原有键盘笔译");
  expect(f.errors).toEqual([]);
});

test("Android UI simulation: switching tools finishes an interrupted stroke and finger add still works", async ({ page }) => {
  const f = await fixture(page, true);
  const field = page.locator(".translation-unit .deep-writing-lines").first();
  await field.scrollIntoViewIfNeeded();
  await field.evaluate(element => {
    const rect = element.getBoundingClientRect();
    for (const [type, dx] of [["pointerdown", 0], ["pointermove", 30]]) {
      element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 811,
        pointerType: "pen", button: 0, buttons: 1, pressure: .5, clientX: rect.left + 20 + dx, clientY: rect.top + 20 }));
    }
  });
  await page.locator(".annotation-toolbar").getByRole("button", { name: "笔", exact: true }).click();
  await expect.poll(async () => (await strokes(page, f.username)).length).toBe(1);
  const point = await tokenPoint(page, ".sentence-source [data-unknown-scope]");
  await fingerTap(page, point);
  await expect.poll(async () => (await unknownWords(page, f.username)).map(row => row.word)).toContain(point.word);
  expect(f.errors).toEqual([]);
});
