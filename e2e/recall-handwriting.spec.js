import { test, expect } from "@playwright/test";
import { createAccount, navTo, setScopedJson } from "./helpers.js";

async function open(page) {
  const username = await createAccount(page);
  await navTo(page, "词库"); await expect(page.locator(".vocabulary-frame.loaded")).toBeVisible();
  await navTo(page, "筛查"); await expect(page.frameLocator(".vocabulary-frame").locator("body")).toContainText("筛查");
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  await expect(page.locator('.vocab-ink-row[data-index="0"]')).toBeVisible(); return username;
}
async function at(page, index) {
  await page.locator(".vocab-handwriting-scroll").evaluate((el, value) => { el.scrollTop = value * 120; }, index);
  const row = page.locator(`.vocab-ink-row[data-index="${index}"]`); await expect(row).toBeVisible(); return row;
}
async function ink(page) {
  return page.evaluate(async () => {
    const db = await new Promise(ok => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => ok(r.result); });
    const rows = await new Promise(ok => { const r = db.transaction("writing-ink").objectStore("writing-ink").getAll(); r.onsuccess = () => ok(r.result); });
    db.close(); return rows.filter(row => row.surfaceId.startsWith("vocabulary:"));
  });
}
async function draw(page, row, y = 25) {
  const b = await row.locator(".vocab-ink-paper").boundingBox();
  await page.mouse.move(b.x + 35, b.y + y); await page.mouse.down(); await page.mouse.move(b.x + 90, b.y + y + 5, { steps: 8 }); await page.mouse.up();
}
test("manual references reveal only written words; AI processes offscreen rows 1/35/80 and is idempotent", async ({ page }, info) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const username = await open(page);
  // Initial measurement retires buffered rows while their restores are queued.
  await page.waitForTimeout(250);
  await expect(page.locator(".vocab-handwriting-message")).not.toContainText("disposed");
  await setScopedJson(page, username, "wuliao:writing:vision-api-config:v1", { baseUrl: "https://vision.example.com/v1" });
  await setScopedJson(page, username, "wuliao:ai:api-config", { baseUrl: "https://api.deepseek.com" });
  await page.evaluate(u => {
    const prefix = `wuliao:user:${encodeURIComponent(u)}:`;
    for (const [key, value] of Object.entries({ "wuliao:writing:vision-api-key": "test", "wuliao:writing:vision-model:v1": "test-vision", "wuliao:ai:apikey": "test", "wuliao:ai:model": "deepseek-chat" })) localStorage.setItem(prefix + key, value);
  }, username);
  let visionWords = 0, judgedWords = 0;
  await page.route("https://vision.example.com/**", async route => {
    const blocks = route.request().postDataJSON().messages.at(-1).content;
    const count = blocks.filter(block => block.type === "image_url").length; visionWords += count;
    expect(count).toBeGreaterThan(0);
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items: Array.from({ length: count }, (_, i) => ({ id: String(i), text: "手写中文", unsure: false })) }) } }] } });
  });
  await page.route("https://api.deepseek.com/**", async route => {
    const rows = JSON.parse(route.request().postDataJSON().messages.at(-1).content); judgedWords += rows.length;
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items: rows.map(row => ({ id: row.id, verdict: "correct", reason: "语义一致" })) }) } }] } });
  });
  for (const index of [0, 34, 79]) await draw(page, await at(page, index));
  await expect.poll(async () => (await ink(page)).filter(row => row.strokes.length).length).toBe(3);
  expect(visionWords).toBe(0); expect(judgedWords).toBe(0);
  await page.getByRole("button", { name: "对照", exact: true }).click();
  await expect(page.locator(".vocab-handwriting-message")).toContainText("3 个已手写");
  for (const index of [0, 34, 79]) await expect((await at(page, index)).locator(".vocab-ink-reference")).toBeVisible();
  await expect((await at(page, 1)).locator(".vocab-ink-reference")).toHaveCount(0);
  expect(visionWords).toBe(0); expect(judgedWords).toBe(0);
  await page.getByRole("button", { name: "识别", exact: true }).click();
  await expect(page.locator(".vocab-handwriting-message")).toContainText("已完成 3 词");
  expect(visionWords).toBe(3); expect(judgedWords).toBe(3);
  await page.getByRole("button", { name: "识别", exact: true }).click();
  await expect(page.locator(".vocab-handwriting-message")).toContainText("没有新增");
  expect(visionWords).toBe(3); expect(judgedWords).toBe(3);
  expect(await page.locator(".vocab-ink-row").count()).toBeLessThan(30);
  await expect(page.locator(".vocab-handwriting footer")).toHaveCount(0);
  await expect(page.locator(".vocab-ink-toolbar-host .tablet-ink-toolbar")).toBeVisible();
  await page.screenshot({ path: info.outputPath("handwriting-desktop.png") });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.screenshot({ path: info.outputPath("handwriting-tablet.png") });
  const top = await page.locator(".vocab-handwriting-scroll").evaluate(el => el.scrollTop);
  await page.getByRole("button", { name: "选择模式", exact: true }).click();
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  await expect.poll(() => page.locator(".vocab-handwriting-scroll").evaluate(el => el.scrollTop)).toBe(top);
  for (const index of [0, 34, 79]) await expect((await at(page, index)).locator("textarea")).toHaveValue("手写中文");
  expect(errors).toEqual([]);
});

test("pen long press circles one stroke, resumes writing, undo works; finger scroll creates no answer revision", async ({ page }, info) => {
  await open(page); const row = await at(page, 0);
  const b = await row.locator(".vocab-ink-paper").boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen" });
  const stroke = async x => { await send("mousePressed", b.x + x, b.y + 28); await send("mouseMoved", b.x + x + 45, b.y + 28); await send("mouseReleased", b.x + x + 45, b.y + 28); };
  await stroke(35); await stroke(140);
  await expect.poll(async () => (await ink(page))[0]?.strokes.length).toBe(2);
  await send("mousePressed", b.x + 20, b.y + 15); await page.waitForTimeout(750);
  await expect(page.locator(".vocab-handwriting-message")).toContainText("临时自由套索");
  for (const [x, y] of [[90, 15], [90, 43], [20, 43], [20, 15]]) await send("mouseMoved", b.x + x, b.y + y);
  await send("mouseReleased", b.x + 20, b.y + 15);
  await expect.poll(async () => (await ink(page))[0]?.strokes.length).toBe(1);
  await stroke(230); await expect.poll(async () => (await ink(page))[0]?.strokes.length).toBe(2);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await ink(page))[0]?.strokes.length).toBe(1);
  await page.screenshot({ path: info.outputPath("long-press-undo.png") });
  const before = (await ink(page))[0];
  const second = await page.locator('.vocab-ink-row[data-index="1"] .vocab-ink-paper').boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: second.x + 80, y: second.y + 42 }] });
  for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: second.x + 80, y: second.y + 42 - i * 20 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => page.locator(".vocab-handwriting-scroll").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect((await ink(page))[0].fingerprint).toBe(before.fingerprint);
  await page.getByRole("button", { name: "选择模式", exact: true }).click();
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  expect((await ink(page))[0].strokes.length).toBe(1);
});

test("answer save failure stays retryable and manual comparison remains available without AI", async ({ page }) => {
  await open(page); const row = await at(page, 0); await draw(page, row);
  await expect.poll(async () => (await ink(page))[0]?.strokes.length).toBe(1);
  await page.evaluate(() => {
    window.__realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === "answers") throw new DOMException("test quota", "QuotaExceededError"); return window.__realPut.apply(this, args); };
  });
  await row.locator("textarea").fill("保存失败测试");
  await expect(page.getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "对照", exact: true }).click();
  await expect(row.locator(".vocab-ink-reference")).toBeVisible();
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__realPut; });
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试保存", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "选择模式", exact: true }).click();
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  await expect(page.locator('.vocab-ink-row[data-index="0"] textarea')).toHaveValue("保存失败测试");
});

test("AI settings switch independent drafts and save the key to the selected modality", async ({ page }) => {
  const username = await createAccount(page);
  await setScopedJson(page, username, "wuliao:writing:vision-api-config:v1", { baseUrl: "https://vision.example.com/v1" });
  await page.evaluate(u => {
    const p = `wuliao:user:${encodeURIComponent(u)}:`;
    localStorage.setItem(p + "wuliao:writing:vision-model:v1", "vision-original");
    localStorage.setItem(p + "wuliao:ai:model", "text-original");
  }, username);
  const requests = [];
  await page.route("https://vision.example.com/**", async route => { requests.push(route.request().headers().authorization); await route.fulfill({ json: { data: [{ id: "vision-updated" }] } }); });
  await page.getByRole("button", { name: /AI API/ }).click();
  const modal = page.locator(".ai-api-modal"), model = modal.getByLabel("Model ID（可手动输入）");
  await expect(model).toHaveValue("text-original"); await model.fill("unsaved-text-draft");
  await modal.getByRole("tab", { name: "视觉 AI" }).click();
  await expect(model).toHaveValue("vision-original"); await model.fill("vision-updated");
  await modal.locator('input[type="password"]').fill("test-vision-updated");
  await modal.getByRole("button", { name: "保存", exact: true }).click();
  await expect(modal).toContainText("已获取 1 个模型");
  await modal.getByRole("tab", { name: "文本 AI" }).click(); await expect(model).toHaveValue("text-original");
  await modal.getByRole("tab", { name: "视觉 AI" }).click(); await expect(model).toHaveValue("vision-updated");
  expect(requests).toEqual(["Bearer test-vision-updated"]);
  const stored = await page.evaluate(u => { const p = `wuliao:user:${encodeURIComponent(u)}:`; const vision = JSON.parse(localStorage.getItem(p + "wuliao:ai:provider-profile:v2:vision")); const text = JSON.parse(localStorage.getItem(p + "wuliao:ai:provider-profile:v2:text")); return { vision: vision.modality, visionModel: vision.modelId, textModel: text.modelId, visionKey: localStorage.getItem(p + "wuliao:ai:credential:v2:" + vision.credentialScopeId), textKey: localStorage.getItem(p + "wuliao:ai:credential:v2:" + text.credentialScopeId) }; }, username);
  expect(stored).toEqual({ vision: "vision", visionModel: "vision-updated", textModel: "text-original", visionKey: "test-vision-updated", textKey: null });
});
