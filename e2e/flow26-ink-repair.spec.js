import { test, expect } from "@playwright/test";
import { createAccount, navTo, openOfficialResource, openOfficialCloze } from "./helpers.js";

// These isolated browser contexts deliberately exercise the Android direct-ink
// path. Physical M-Pencil latency remains a separate on-device measurement.
async function androidInk(page) {
  await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
}

async function exercise(page, surface, scale = 1) {
  return page.locator(surface).first().evaluate(async (element, scale) => {
    element.style.transformOrigin = "top left";
    element.style.transform = `scale(${scale})`;
    const rect = element.getBoundingClientRect();
    const x = Math.max(60, rect.left + 90), y = Math.max(210, rect.top + 110);
    const target = document.elementFromPoint(x, y) || element;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const dispatch = (type, dx, dy, pointerId = 71) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: "pen", isPrimary: true,
      button: 0, buttons: type === "pointerup" ? 0 : 1, pressure: .05,
      clientX: x + dx, clientY: y + dy,
    }));
    function inkBounds() {
      const composite = document.createElement("canvas");
      composite.width = innerWidth * 2; composite.height = innerHeight * 2;
      const context = composite.getContext("2d");
      context.scale(2, 2);
      for (const canvas of document.querySelectorAll(".deep-ink-tile,.custom-viewport-ink-preview,.cloze-ink-canvas,.cloze-ink-preview,.writing-ink-canvas,.writing-ink-preview,.ink-canvas,.ink-preview-canvas,.ink-tail-canvas")) {
        const box = canvas.getBoundingClientRect();
        if (canvas.width && canvas.height && box.width && box.height) context.drawImage(canvas, box.left, box.top, box.width, box.height);
      }
      const bytes = context.getImageData(0, 0, composite.width, composite.height).data;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
      for (let i = 3; i < bytes.length; i += 4) if (bytes[i] > 40) {
        const index = (i - 3) / 4, px = index % composite.width, py = Math.floor(index / composite.width);
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py); count++;
      }
      return { count, cx: (minX + maxX) / 4, cy: (minY + maxY) / 4 };
    }
    dispatch("pointerdown", 0, 0);
    const dot = inkBounds();
    for (const [dx, dy] of [[30, 0], [30, 30], [0, 30], [0, 0]]) dispatch("pointermove", dx, dy);
    await frame();
    const moving = inkBounds();
    dispatch("pointerup", 0, 0);
    const committed = inkBounds();
    await frame();
    // 100 total closed strokes, including consecutive pen-up/down in one task.
    for (let id = 72; id < 171; id++) {
      dispatch("pointerdown", 0, 0, id);
      for (const [dx, dy] of [[30, 0], [30, 30], [0, 30], [0, 0]]) dispatch("pointermove", dx, dy, id);
      dispatch("pointerup", 0, 0, id);
    }
    return { dot, moving, committed, target: target.outerHTML.slice(0, 500), rect: rect.toJSON() };
  }, scale);
}

async function storedStrokes(page, store = "reader-ink") {
  return page.evaluate((store) => new Promise((resolve, reject) => {
    const open = indexedDB.open("wuliao-english");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => { db.close(); resolve(request.result.flatMap((row) => { const value = row.strokes || JSON.parse(row.value || "null"); return Array.isArray(value) ? value : []; })); };
      request.onerror = () => reject(request.error);
    };
  }), store);
}

for (const scale of [.75, 1, 1.25]) {
  test(`direct pen closed strokes, immediate contact and stable handoff at ${scale * 100}%`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await createAccount(page);
    await androidInk(page);
    await openOfficialResource(page, "2007 英语（一）Text 1");
    await page.locator(".deep-paper:visible").first().scrollIntoViewIfNeeded();
    const result = await exercise(page, ".deep-reader-content", scale);
    expect(result.dot.count).toBeGreaterThan(0);
    expect(result.moving.count).toBeGreaterThan(result.dot.count * 5);
    expect(result.committed.count).toBeGreaterThan(result.dot.count * 5);
    expect(Math.abs(result.moving.cx - result.committed.cx)).toBeLessThanOrEqual(.5);
    expect(Math.abs(result.moving.cy - result.committed.cy)).toBeLessThanOrEqual(.5);
    await page.screenshot({ path: testInfo.outputPath("closed-ink.png") });
    await page.locator(".reader-header .back-button").first().click();
    await expect(page.locator(".library-page")).toBeVisible();
    const stored = await storedStrokes(page);
    expect(stored).toHaveLength(100);
    expect(stored.every((stroke) => stroke.engine === "direct-ink" && stroke.points.length >= 5)).toBe(true);
    await page.reload();
    expect(await storedStrokes(page)).toEqual(stored);
    expect(errors).toEqual([]);
  });
}

test("cloze direct pen preserves 100 closed paths and stable handoff", async ({ page }, testInfo) => {
  await createAccount(page);
  await androidInk(page);
  await openOfficialCloze(page, "2007");
  await page.getByRole("button", { name: "开始限时初做", exact: true }).click();
  await page.getByRole("button", { name: "手写批注", exact: true }).click();
  await page.locator(".cloze-passage").scrollIntoViewIfNeeded();
  const result = await exercise(page, ".cloze-ink-content");
  expect(result.dot.count, JSON.stringify(result)).toBeGreaterThan(0);
  expect(result.committed.count).toBeGreaterThan(result.dot.count * 5);
  expect(Math.abs(result.moving.cx - result.committed.cx)).toBeLessThanOrEqual(.5);
  expect(Math.abs(result.moving.cy - result.committed.cy)).toBeLessThanOrEqual(.5);
  await expect.poll(async () => (await storedStrokes(page)).length).toBe(100);
  const stored = await storedStrokes(page);
  expect(stored.every((stroke) => stroke.points.length >= 5)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("cloze-ink.png") });
  await page.reload();
  expect(await storedStrokes(page)).toEqual(stored);
});

for (const area of ["PDF", "writing"]) {
  test(`${area} direct pen: immediate contact, 100 closed paths, handoff and reload`, async ({ page }, testInfo) => {
    await createAccount(page);
    await androidInk(page);
    let selector, store;
    if (area === "PDF") {
      await openOfficialResource(page, "2007 英语（一）Text 1");
      await page.getByRole("button", { name: "查看原 PDF", exact: true }).click();
      await expect(page.locator(".ink-canvas")).toBeVisible();
      await page.getByRole("button", { name: "手写批注", exact: true }).click();
      selector = ".canvas-stack"; store = "reader-ink";
    } else {
      await navTo(page, "写作");
      await page.getByLabel("按年份筛选写作").selectOption("2023");
      await page.getByRole("button", { name: /查看 2023 年.*Writing A/ }).click();
      await page.getByRole("button", { name: "使用随应用范文", exact: true }).click();
      await page.getByRole("button", { name: "完成范文精读", exact: true }).click();
      await page.getByRole("button", { name: "手写", exact: true }).click();
      selector = ".writing-ink-content"; store = "writing-ink";
    }
    const result = await exercise(page, selector);
    expect(result.dot.count, JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.committed.count).toBeGreaterThan(result.dot.count * 5);
    expect(Math.abs(result.moving.cx - result.committed.cx)).toBeLessThanOrEqual(.5);
    expect(Math.abs(result.moving.cy - result.committed.cy)).toBeLessThanOrEqual(.5);
    await expect.poll(async () => (await storedStrokes(page, store)).length).toBe(100);
    const stored = await storedStrokes(page, store);
    expect(stored.every(s => s.engine === "direct-ink" && s.points.length >= 5)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${area}-closed-ink.png`) });
    if (area === "writing") {
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await expect.poll(async () => (await storedStrokes(page, store)).length).toBe(99);
    }
    const saved = await storedStrokes(page, store);
    await page.reload();
    expect(await storedStrokes(page, store)).toEqual(saved);
  });
}

test("deep active stroke finishes once before viewport or paper layout changes", async ({ page }) => {
  await createAccount(page);
  await androidInk(page);
  await openOfficialResource(page, "2007 英语（一）Text 1");
  await page.locator(".deep-paper:visible").first().scrollIntoViewIfNeeded();
  const input = await page.locator(".deep-reader-content").evaluate(element => {
    const r = element.getBoundingClientRect();
    const x = r.left + 90, y = Math.max(210, r.top + 110);
    const points = [[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]];
    points.forEach(([dx, dy], index) => element.dispatchEvent(new PointerEvent(index ? "pointermove" : "pointerdown", {
      bubbles: true, cancelable: true, pointerId: 812, pointerType: "pen", isPrimary: true,
      button: 0, buttons: 1, pressure: .05, clientX: x + dx, clientY: y + dy,
    })));
    return { x, y, points: points.map(([dx, dy]) => ({ x: (x + dx - r.left) / r.width, y: (y + dy - r.top) / r.height })) };
  });
  await page.setViewportSize({ width: 800, height: 1280 });
  await expect.poll(async () => (await storedStrokes(page)).length).toBe(1);
  const first = await storedStrokes(page);
  expect(first[0].points.map(({ x, y }) => ({ x, y }))).toEqual(input.points);
  await page.locator(".deep-reader-content").evaluate((element, input) => {
    element.dispatchEvent(new Event("reader-paper-will-layout"));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 812, pointerType: "pen", clientX: input.x, clientY: input.y, pressure: 0 }));
    element.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 812, pointerType: "pen" }));
  }, input);
  await page.locator(".reader-header .back-button").first().click();
  await expect(page.locator(".library-page")).toBeVisible();
  expect(await storedStrokes(page)).toEqual(first);
});
