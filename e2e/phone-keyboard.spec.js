import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createAccount, uniqueUsername, openOfficialResource, openOfficialCloze, clickStageAdvance, setScopedJson, readDurableInkEntries } from "./helpers.js";

const TITLE = "2007 英语（一）Text 1";
const CLOZE_ID = "postgraduate-2007-cloze";
const ANDROID_PHONE = "Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 Version/4.0 Chrome/132.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const logs = new WeakMap();

test.beforeEach(async ({ page }) => {
  const entries = { errors: [], pageErrors: [] };
  logs.set(page, entries);
  page.on("console", message => { if (message.type() === "error") entries.errors.push(message.text()); });
  page.on("pageerror", error => entries.pageErrors.push(error.message));
});

test.afterEach(async ({ page }, info) => {
  const health = { title: await page.title(), url: page.url(), errorOverlays: await page.locator("vite-error-overlay").count(), ...logs.get(page) };
  const path = info.outputPath("browser-health.json");
  await writeFile(path, JSON.stringify(health, null, 2));
  await info.attach("browser-health", { path, contentType: "application/json" });
  expect(health.title).toContain("无聊英语");
  expect(health.errorOverlays).toBe(0);
  expect(health.errors).toEqual([]);
  expect(health.pageErrors).toEqual([]);
});

async function device(page, userAgent, mobile, android) {
  await page.addInitScript(({ userAgent, mobile, android }) => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
    Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { mobile } });
  }, { userAgent, mobile, android });
}

async function platform(page, android) {
  if (android) await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
}

async function reopen(page, android) {
  await page.reload();
  await page.locator(".library-page").waitFor();
  await platform(page, android);
  await page.locator(".resource-card", { hasText: TITLE }).first().locator(".resource-open").click();
  await expect(page.locator("#deep-translation")).toBeVisible();
  await page.waitForTimeout(500);
}

async function translation(page, android) {
  const username = await createAccount(page, uniqueUsername("phone-keyboard"));
  await platform(page, android);
  await openOfficialResource(page, TITLE);
  await clickStageAdvance(page, "开始精读");
  await page.evaluate(username => {
    const prefix = `wuliao:user:${encodeURIComponent(username)}:wuliao:reading-flow:`;
    const key = Object.keys(localStorage).find(key => key.startsWith(prefix));
    const flow = JSON.parse(localStorage.getItem(key));
    for (const stage of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz"]) flow.stages[stage] = { status: "completed", completedAt: 100 };
    flow.stages["deep-translation"] = { status: "current", completedAt: null };
    flow.currentStage = "deep-translation";
    flow.timedReading = { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: 100 };
    localStorage.setItem(key, JSON.stringify(flow));
  }, username);
  await reopen(page, android);
  return username;
}

async function wordPoint(page, selector) {
  const scope = page.locator(selector).first();
  await scope.scrollIntoViewIfNeeded();
  return scope.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement.closest("[data-unknown-ignore]")) continue;
      const match = /\b(?:of|to|the|in|and)\b/i.exec(node.data);
      if (!match) continue;
      const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      const rect = range.getClientRects()[0];
      if (rect?.width) return { word: match[0], x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    }
    throw new Error("No test word was found");
  });
}

async function tap(page, point) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    await page.waitForTimeout(100);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
}

async function unknowns(page, username) {
  return page.evaluate(async username => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("wuliao-english"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise((resolve, reject) => {
      const request = db.transaction("unknown-words").objectStore("unknown-words").index("username").getAll(username);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  }, username);
}

async function savedStrokes(page, username) {
  return (await readDurableInkEntries(page, username)).flatMap(row => {
    const value = JSON.parse(row.value);
    if (Array.isArray(value)) return value;
    if (value.stageCounts) expect(Object.values(value.stageCounts).every(count => count === 0)).toBe(true);
    return [];
  });
}

async function assertKeyboardToolbar(page, width) {
  const bar = page.locator(".annotation-toolbar");
  await expect(bar.getByRole("button", { name: "键盘输入", exact: true })).toHaveClass(/active/);
  for (const name of ["手写批注", "笔", "橡皮", "撤销"]) await expect(bar.getByRole("button", { name, exact: true })).toHaveCount(0);
  const unknown = bar.getByRole("button", { name: "陌生词", exact: true });
  await expect(unknown).toBeVisible();
  const rect = await unknown.boundingBox();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
}

for (const [name, userAgent, android] of [["Android phone UI", ANDROID_PHONE, true], ["iPhone UI in Chrome", IPHONE, false]]) {
  test(`${name}: keyboard only in portrait and landscape, word taps and text survive reload`, async ({ page }, info) => {
    await device(page, userAgent, true, android);
    const username = await translation(page, android);
    for (const [width, height] of [[390, 844], [844, 390], [320, 740]]) {
      await page.setViewportSize({ width, height });
      await assertKeyboardToolbar(page, width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const field = page.locator(".translation-unit .deep-writing-lines").first();
    await expect(field).toBeEditable();
    await field.fill("手机只使用键盘，保留笔译内容");
    await page.locator(".annotation-toolbar").getByRole("button", { name: "陌生词", exact: true }).click();
    await expect(field).toBeEditable();
    await tap(page, await wordPoint(page, ".paragraph-source-repeat [data-unknown-scope]"));
    await expect.poll(async () => (await unknowns(page, username)).length).toBe(1);
    await reopen(page, android);
    await expect(field).toHaveValue("手机只使用键盘，保留笔译内容");
    await expect(field).toBeEditable();
    expect(await unknowns(page, username)).toHaveLength(1);
    expect(await savedStrokes(page, username)).toHaveLength(0);
    await page.screenshot({ path: info.outputPath("phone-keyboard.png") });
  });
}

test("Android phone UI: a pen event cannot switch keyboard translation into handwriting", async ({ page }) => {
  await device(page, ANDROID_PHONE, true, true);
  const username = await translation(page, true);
  await page.setViewportSize({ width: 390, height: 844 });
  const field = page.locator(".translation-unit .deep-writing-lines").first();
  await field.fill("原键盘译文");
  await field.scrollIntoViewIfNeeded();
  await field.evaluate(element => {
    const rect = element.getBoundingClientRect();
    for (const [type, dx] of [["pointerdown", 0], ["pointermove", 30], ["pointerup", 40]]) {
      element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 811, pointerType: "pen", button: 0,
        buttons: type === "pointerup" ? 0 : 1, pressure: .5, clientX: rect.left + 20 + dx, clientY: rect.top + 20 }));
    }
  });
  await expect(field).toBeEditable();
  await expect(field).toHaveValue("原键盘译文");
  await assertKeyboardToolbar(page, 390);
  expect(await savedStrokes(page, username)).toHaveLength(0);
});

test("Android phone UI: cloze unknown-word tap works without enabling ink", async ({ page }) => {
  await device(page, ANDROID_PHONE, true, true);
  const username = await createAccount(page, uniqueUsername("phone-cloze"));
  await platform(page, true);
  await openOfficialCloze(page, "2007");
  const now = Date.now();
  await setScopedJson(page, username, `wuliao:cloze-flow:${CLOZE_ID}:${CLOZE_ID}`, {
    schemaVersion: 1, resourceId: CLOZE_ID, clozeId: CLOZE_ID, currentStage: "cloze-analysis", updatedAt: now,
    stages: Object.fromEntries(["cloze-cover", "cloze-first-attempt", "cloze-self-review", "cloze-correction", "cloze-analysis", "cloze-final-read"].map(id => [id, { status: id === "cloze-analysis" ? "current" : id === "cloze-final-read" ? "pending" : "completed", completedAt: now }])),
    timedAttempt: { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: now },
  });
  await page.reload();
  await page.locator(".library-page").waitFor();
  await platform(page, true);
  await page.locator(".cloze-resource-card", { hasText: "2007" }).first().locator(".resource-open").click();
  await page.locator(".cloze-passage").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await assertKeyboardToolbar(page, 390);
  const closePanel = page.locator(".cloze-panel-close");
  if (await closePanel.isVisible()) await closePanel.click();
  await page.locator(".annotation-toolbar").getByRole("button", { name: "陌生词", exact: true }).click();
  const point = await wordPoint(page, ".cloze-passage [data-unknown-scope]");
  await tap(page, point);
  await expect.poll(async () => (await unknowns(page, username)).length).toBe(1);
  expect((await unknowns(page, username))[0].sourceType).toBe("cloze");
  expect(await savedStrokes(page, username)).toHaveLength(0);
});
