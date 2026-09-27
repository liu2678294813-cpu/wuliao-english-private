import { test, expect } from "@playwright/test";
import { createAccount, openOfficialResource, clickStageAdvance } from "./helpers.js";
import { build } from "../node_modules/.pnpm/node_modules/esbuild/lib/main.js";

test("actual Canvas export preserves erasure, scale, crop boundaries and region-v2 ink", async ({ page }) => {
  const bundle = await build({ stdin: { contents: 'import {captureTranslationInk,renderTranslationInk} from "./src/translationOcrImage.js"; window.__ocrImageTest={captureTranslationInk,renderTranslationInk};', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser" });
  await page.goto("/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(() => {
    const content = document.createElement("div");
    content.style.cssText = "position:fixed;left:10px;top:20px;width:500px;height:1200px;transform-origin:0 0";
    content.innerHTML = '<section data-translation-sentence="sample" style="position:absolute;left:20px;top:100px;width:200px;height:80px"><div id="ocr-crop" style="width:200px;height:80px"></div></section>';
    document.body.append(content);
    const writingElement = content.querySelector("#ocr-crop");
    const make = (y, tool = "pen", width = 3) => ({ tool, version: 2, width, color: "#134578", engine: "direct-ink", penMode: "ballpoint", points: [{ x: 30 / 500, y: y / 1200 }, { x: 80 / 500, y: y / 1200 }] });
    const render = strokes => window.__ocrImageTest.renderTranslationInk(window.__ocrImageTest.captureTranslationInk({ strokes, contentElement: content, writingElement }));
    const original = make(130), erased = make(130, "eraser", 24), rewritten = make(155);
    const before = JSON.stringify([original, erased, rewritten]);
    const single = render([original]);
    const outsideExcluded = render([make(50), original, make(240)]);
    const erasedImage = render([original, erased]);
    const rewriteMatches = render([original, erased, rewritten]) === render([rewritten]);
    content.style.transform = "scale(.75)";
    const scaled = render([original]);
    content.style.transform = "";
    const canonical = { ...original, coordinateSpace: "deep-region-v2", deepAnchor: { version: 2, regionId: "translation-sentence:sample" }, points: original.points.map(p => ({ x: .9, y: .9, deepLocal: { x: (p.x * 500 - 20) / 200, y: (p.y * 1200 - 100) / 80 } })) };
    const anchored = render([canonical]);
    const immutable = before === JSON.stringify([original, erased, rewritten]);
    content.remove();
    return { single, outsideExcluded, erasedImage, rewriteMatches, scaled, anchored, immutable };
  });
  expect(result.single).toMatch(/^data:image\/png/);
  expect(result.outsideExcluded).toBe(result.single);
  expect(result.erasedImage).toBe(null);
  expect(result.rewriteMatches).toBe(true);
  expect(result.scaled).toBe(result.single);
  expect(result.anchored).toBe(result.single);
  expect(result.immutable).toBe(true);
});

async function openTranslation(page) {
  const username = await createAccount(page);
  await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
  await openOfficialResource(page, "2013 英语（一）Text 1");
  await clickStageAdvance(page, "开始精读");
  await page.evaluate(u => {
    const key = Object.keys(localStorage).find(k => k.includes("wuliao:reading-flow:"));
    const flow = JSON.parse(localStorage.getItem(key));
    const now = Date.now();
    for (const id of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz"]) flow.stages[id] = { status: "completed", completedAt: now };
    flow.stages["deep-translation"] = { status: "current", completedAt: null };
    flow.currentStage = "deep-translation";
    flow.timedReading = { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: now };
    localStorage.setItem(key, JSON.stringify(flow));
    const prefix = `wuliao:user:${encodeURIComponent(u)}:`;
    localStorage.setItem(prefix + "wuliao:writing:vision-api-config:v1", JSON.stringify({ baseUrl: "https://vision.example.com/v1" }));
    localStorage.setItem(prefix + "wuliao:writing:vision-api-key", "test-not-a-real-key");
    localStorage.setItem(prefix + "wuliao:writing:vision-model:v1", "test-vision");
    localStorage.setItem(prefix + "wuliao:ai:api-config", JSON.stringify({ baseUrl: "https://text.example.com/v1" }));
    localStorage.setItem(prefix + "wuliao:ai:apikey", "test-not-a-real-key");
    localStorage.setItem(prefix + "wuliao:ai:model", "test-text");
  }, username);
  await page.reload();
  await page.locator(".library-page").waitFor();
  await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
  await page.locator(".resource-card", { hasText: "2013 英语（一）Text 1" }).first().locator(".resource-open").click();
  await expect(page.locator("#deep-translation")).toBeVisible();
  const unit = page.locator("#deep-translation .translation-unit").first();
  await unit.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  return { username, unit };
}

async function draw(unit, { x = 30, y = 17 } = {}) {
  await unit.locator(".deep-writing-lines").evaluate((element, { x, y }) => {
    const rect = element.getBoundingClientRect();
    const send = (type, dx, dy) => element.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 811, pointerType: "pen", isPrimary: true,
      button: 0, buttons: type === "pointerup" ? 0 : 1, pressure: .5,
      clientX: rect.left + x + dx, clientY: rect.top + y + dy,
    }));
    send("pointerdown", 0, 0);
    for (const [dx, dy] of [[10, 0], [20, 0], [20, 12], [10, 12], [0, 12]]) send("pointermove", dx, dy);
    send("pointerup", 0, 12);
  }, { x, y });
}

async function ink(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wuliao-english"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const rows = await new Promise((resolve, reject) => { const request = db.transaction("reader-ink").objectStore("reader-ink").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    return rows.map(({ key, value }) => ({ key, value })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  });
}

async function textRecords(page) {
  return page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => /:wuliao:deep-translation:[^:]+:[^:]+:\d+:\d+$/.test(k)).map(k => [k, localStorage.getItem(k)])));
}

async function mockVision(page, handler = null) {
  const requests = [];
  await page.route("https://vision.example.com/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
    requests.push(route.request().postDataJSON());
    if (handler) return handler(route);
    return route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ text: "技术改变了我们的生活。", unsure: false }) } }] } });
  });
  return requests;
}

test("recognize → edit → save → manual review preserves raw ink, dimensions and sentence ownership", async ({ page }, info) => {
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const { unit } = await openTranslation(page);
  const requests = await mockVision(page);
  let reviews = 0;
  await page.route("https://text.example.com/**", route => { reviews++; return route.fulfill({ status: 503, json: { error: { message: "QA stops after verifying the review input" } } }); });
  await draw(unit);
  await expect(unit.locator(".translation-unit-hint")).toBeVisible();
  await page.waitForTimeout(800);
  const beforeInk = await ink(page);
  expect(beforeInk.length).toBeGreaterThan(0);
  const beforeRect = await unit.locator(".deep-writing-lines").boundingBox();
  const beforeSentence = await unit.evaluate(el => el.closest(".sentence-work").getBoundingClientRect().height);
  await unit.getByRole("button", { name: "识别", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "笔译识别与校对" });
  await expect(dialog.locator("textarea")).toHaveValue("技术改变了我们的生活。");
  await expect(dialog.locator("img")).toBeVisible();
  expect(await textRecords(page)).toEqual({});
  expect(reviews).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].messages[1].content).toHaveLength(1);
  await dialog.locator("textarea").fill("技术改变我们的日常生活。");
  await page.screenshot({ path: info.outputPath("ocr-correction.png") });
  await dialog.getByRole("button", { name: "确认保存" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(unit.locator("textarea")).toHaveValue("技术改变我们的日常生活。");
  expect(Object.values(await textRecords(page))).toEqual(["技术改变我们的日常生活。"]);
  expect(await ink(page)).toEqual(beforeInk);
  expect(await unit.evaluate(el => el.closest(".sentence-work").getBoundingClientRect().height)).toBe(beforeSentence);
  expect((await unit.locator(".deep-writing-lines").boundingBox()).height).toBe(beforeRect.height);
  expect(await unit.locator("textarea").evaluate(el => getComputedStyle(el).color)).toBe("rgba(0, 0, 0, 0)");
  expect(reviews).toBe(0);
  await unit.getByRole("button", { name: "完成笔译", exact: true }).click();
  await page.evaluate(() => { window.__ocrReviewEvents = []; window.addEventListener("wuliao:ai-request", e => window.__ocrReviewEvents.push(e.detail)); });
  await unit.getByRole("button", { name: "AI 批改", exact: true }).click();
  await expect.poll(() => reviews).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("original-ink-preserved.png") });
  expect(errors).toEqual([]);
});

test("blank row avoids requests; cancel and late responses never save", async ({ page }) => {
  const { unit } = await openTranslation(page);
  let resolveRequest;
  const requests = await mockVision(page, route => new Promise(resolve => { resolveRequest = async () => { await route.fulfill({ json: { choices: [{ message: { content: '{"text":"过期结果","unsure":false}' } }] } }).catch(() => {}); resolve(); }; }));
  await unit.getByRole("button", { name: "识别", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "笔译识别与校对" });
  await expect(dialog.getByRole("alert")).toContainText("没有可识别");
  expect(requests).toHaveLength(0);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await draw(unit);
  await unit.getByRole("button", { name: "识别", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await resolveRequest();
  await page.waitForTimeout(200);
  expect(await textRecords(page)).toEqual({});
  await expect(dialog).toHaveCount(0);
});

test("recognition failure retains manual editing, existing text and read-back errors keep draft open", async ({ page }) => {
  const { unit } = await openTranslation(page);
  await draw(unit);
  await mockVision(page, route => route.fulfill({ status: 503, json: { error: { message: "测试网络失败" } } }));
  await unit.getByRole("button", { name: "识别", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "笔译识别与校对" });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.locator("textarea").fill("手工校对的译文");
  await page.evaluate(() => { window.__ocrWrite = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key.includes("wuliao:deep-translation:ocr:")) throw new Error("quota"); return window.__ocrWrite.call(this, key, value); }; });
  await dialog.getByRole("button", { name: "确认保存" }).click();
  await expect(dialog.getByRole("alert")).toContainText("未能完整保存");
  await expect(dialog.locator("textarea")).toHaveValue("手工校对的译文");
  expect(await textRecords(page)).toEqual({});
  await page.evaluate(() => { Storage.prototype.setItem = window.__ocrWrite; delete window.__ocrWrite; });
  await dialog.getByRole("button", { name: "确认保存" }).click();
  await expect(dialog).toHaveCount(0);
  await unit.getByRole("button", { name: "识别", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(unit.locator("textarea")).toHaveValue("手工校对的译文");
});

test("updated ink requires rechecking before review; phone controls fit and do not resize the writing region", async ({ page }, info) => {
  const { unit } = await openTranslation(page);
  await mockVision(page);
  await draw(unit);
  await unit.getByRole("button", { name: "识别", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "笔译识别与校对" });
  await expect(dialog.locator("textarea")).toHaveValue("技术改变了我们的生活。");
  await dialog.getByRole("button", { name: "确认保存" }).click();
  await unit.getByRole("button", { name: "完成笔译", exact: true }).click();
  await draw(unit, { x: 85 });
  await unit.getByRole("button", { name: "AI 批改", exact: true }).click();
  await expect(dialog.locator(".translation-ocr-notice")).toContainText("笔迹已更新");
  await dialog.getByRole("button", { name: "确认保存" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await unit.scrollIntoViewIfNeeded();
  const boxes = await unit.locator("button").evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, ...n.getBoundingClientRect().toJSON() })));
  for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(390); }
  for (const a of boxes) for (const b of boxes) if (a.text !== b.text) {
    expect(Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 0 || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 0).toBe(true);
  }
  await page.screenshot({ path: info.outputPath("ocr-phone.png") });
  await unit.getByRole("button", { name: "查看文字", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: info.outputPath("ocr-phone-dialog.png") });
});

test("ink changes and account switches reject in-flight OCR responses", async ({ page }) => {
  const { unit } = await openTranslation(page);
  const releases = [];
  const requests = await mockVision(page, route => new Promise(resolve => {
    releases.push(async () => { await route.fulfill({ json: { choices: [{ message: { content: '{"text":"过期识别文字","unsure":false}' } }] } }).catch(() => {}); resolve(); });
  }));
  await draw(unit);
  await unit.getByRole("button", { name: "识别", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "笔译识别与校对" });
  await expect.poll(() => requests.length).toBe(1);
  await draw(unit, { x: 100 });
  await releases[0]();
  await expect(dialog.getByRole("alert")).toContainText("笔迹已更新");
  await expect(dialog.locator("textarea")).toHaveValue("");
  await dialog.getByRole("button", { name: "重新识别", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await page.evaluate(() => { localStorage.setItem("kaoyan_vocab_current_user", "ocr-other-account"); });
  await releases[1]();
  // The provider may reject the account switch before the modal's own guard.
  // Both paths must discard the late result, including the editable draft.
  await expect(dialog.getByRole("alert")).toContainText(/账号已切换|AI request cancelled/);
  await expect(dialog.locator("textarea")).toHaveValue("");
  // textRecords scans every account namespace, not only the active account.
  expect(await textRecords(page)).toEqual({});
});

test("legacy binding stays explicit and clearing cannot resurrect it", async ({ page }) => {
  const { username, unit } = await openTranslation(page);
  await page.evaluate(u => {
    localStorage.setItem(`wuliao:user:${encodeURIComponent(u)}:wuliao:deep-translation:[object Object]:[object Object]:1:0`, "旧译文需要确认归属");
  }, username);
  // Remount to simulate opening an article with existing legacy records.
  await page.locator(".reader-header .back-button").first().click();
  await page.locator(".resource-card", { hasText: "2013 英语（一）Text 1" }).first().locator(".resource-open").click();
  await unit.scrollIntoViewIfNeeded();
  await expect(unit.locator("textarea")).toHaveValue("");
  await unit.getByRole("button", { name: "查看旧文字", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "笔译识别与校对" });
  await expect(dialog.locator("textarea")).toHaveValue("");
  await dialog.getByRole("button", { name: "这是本句译文，使用并校对", exact: true }).click();
  await dialog.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(unit.locator("textarea")).toHaveValue("旧译文需要确认归属");
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "清空页面", exact: true }).click();
  await expect(unit.locator("textarea")).toHaveValue("");
  await expect(unit.getByRole("button", { name: "查看旧文字", exact: true })).toHaveCount(0);
  expect(Object.keys(await textRecords(page)).filter(k => !k.includes("[object Object]"))).toEqual([]);
  expect(await page.evaluate(u => localStorage.getItem(`wuliao:user:${encodeURIComponent(u)}:wuliao:deep-translation:[object Object]:[object Object]:1:0`), username)).toBe("旧译文需要确认归属");
});

test("leaving an article cancels pending OCR and the same sentence position in another article stays separate", async ({ page }) => {
  const { unit } = await openTranslation(page);
  let release;
  const requests = await mockVision(page, route => new Promise(resolve => {
    release = async () => { await route.fulfill({ json: { choices: [{ message: { content: '{"text":"第一篇的迟到结果","unsure":false}' } }] } }).catch(() => {}); resolve(); };
  }));
  await draw(unit);
  await unit.getByRole("button", { name: "识别", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  // Trigger the existing navigation handler while the modal is pending.
  await page.locator(".reader-header .back-button").first().evaluate(button => button.click());
  await expect(page.locator(".library-page")).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.includes("wuliao:reading-flow:postgraduate-2013-text-1:"));
    localStorage.setItem(key.replace("postgraduate-2013-text-1", "postgraduate-2014-text-1"), localStorage.getItem(key));
  });
  await page.locator(".resource-card", { hasText: "2014 英语（一）Text 1" }).first().locator(".resource-open").click();
  await expect(page.locator("#deep-translation")).toBeVisible();
  await release();
  await expect(page.getByRole("dialog", { name: "笔译识别与校对" })).toHaveCount(0);
  const second = page.locator("#deep-translation .translation-unit").first();
  await expect(second.locator("textarea")).toHaveValue("");
  expect(await textRecords(page)).toEqual({});
  await second.scrollIntoViewIfNeeded();
  await second.getByRole("button", { name: "识别", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "笔译识别与校对" });
  await expect(dialog.getByRole("alert")).toContainText("没有可识别");
  await dialog.locator("textarea").fill("这是第二篇的确认译文");
  await dialog.getByRole("button", { name: "确认保存", exact: true }).click();
  const records = await textRecords(page);
  expect(Object.keys(records)).toHaveLength(1);
  expect(Object.keys(records)[0]).toContain("postgraduate-2014-text-1:passage-1:1:0");
  await page.locator(".reader-header .back-button").first().click();
  await page.locator(".resource-card", { hasText: "2013 英语（一）Text 1" }).first().locator(".resource-open").click();
  await expect(unit.locator("textarea")).toHaveValue("");
});

test("editing confirmed electronic text invalidates the old correction without changing ink", async ({ page }) => {
  const { unit } = await openTranslation(page);
  await mockVision(page);
  await draw(unit);
  await unit.getByRole("button", { name: "识别", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "笔译识别与校对" });
  await expect(dialog.locator("textarea")).toHaveValue("技术改变了我们的生活。");
  await dialog.getByRole("button", { name: "确认保存", exact: true }).click();
  await unit.getByRole("button", { name: "完成笔译", exact: true }).click();
  await unit.getByRole("button", { name: "完成订正", exact: true }).click();
  await expect(unit.getByRole("button", { name: "已掌握", exact: true })).toBeVisible();
  const before = await ink(page);
  await unit.getByRole("button", { name: "查看文字", exact: true }).click();
  await dialog.locator("textarea").fill("科技改变了人们的生活。");
  await dialog.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(unit.getByRole("button", { name: "完成订正", exact: true })).toBeVisible();
  await expect(unit.getByRole("button", { name: "已掌握", exact: true })).toHaveCount(0);
  expect(await ink(page)).toEqual(before);
});
