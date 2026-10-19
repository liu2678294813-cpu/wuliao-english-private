import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
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
    const image = blocks.find(block => block.type === "image_url").image_url.url;
    await writeFile(info.outputPath("recognized-edge-ink.png"), Buffer.from(image.split(",")[1], "base64"));
    const imageSize = await page.evaluate(src => new Promise(resolve => {
      const img = new Image(); img.onload = () => resolve({ width: img.width, height: img.height }); img.src = src;
    }), image);
    // The first word has strokes near both vertical edges, not just the middle.
    expect(imageSize.height).toBeGreaterThan(imageSize.width);
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items: Array.from({ length: count }, (_, i) => ({ id: String(i), text: "手写中文", unsure: false })) }) } }] } });
  });
  await page.route("https://api.deepseek.com/**", async route => {
    const rows = JSON.parse(route.request().postDataJSON().messages.at(-1).content); judgedWords += rows.length;
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items: rows.map(row => ({ id: row.id, verdict: "correct", reason: "语义一致" })) }) } }] } });
  });
  for (const index of [0, 34, 79]) await draw(page, await at(page, index));
  const first = await at(page, 0);
  await draw(page, first, 4); await draw(page, first, 105);
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

test("handwriting covers row edges without moving controls and survives remount, mode switch and reload", async ({ page }, info) => {
  const errors = [], logs = []; page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) logs.push({ level: message.type(), text: message.text() }); });
  await open(page);
  expect(new URL(page.url()).hostname).toBe("127.0.0.1");
  await expect(page).toHaveTitle(/无聊英语/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const row = await at(page, 0);
  await expect(row.locator(".writing-ink-surface")).not.toHaveClass(/is-disabled/);
  const measure = () => row.evaluate(el => {
    const rect = element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return Object.fromEntries([["row", el], ...[".vocab-ink-row-main", ".vocab-ink-english", ".vocab-ink-transcript", ".vocab-ink-row-actions", ".vocab-ink-paper", ".writing-ink-content"].map(s => [s, el.querySelector(s)])].map(([key, element]) => [key, rect(element)]));
  });
  const initial = await measure();
  await info.attach("initial-geometry", { body: JSON.stringify(initial, null, 2), contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("initial-layout.png") });
  expect(initial.row.height).toBe(120);
  expect(initial[".vocab-ink-row-main"].height).toBe(78);
  expect(initial[".vocab-ink-paper"].height).toBeGreaterThanOrEqual(113);
  expect(initial[".vocab-ink-paper"].height).toBeLessThanOrEqual(114);
  expect(initial[".writing-ink-content"]).toEqual(initial[".vocab-ink-paper"]);
  expect(initial[".vocab-ink-paper"].y - initial.row.y).toBeCloseTo(3, 0);

  const cdp = await page.context().newCDPSession(page);
  const line = async (x, y) => {
    const b = await row.locator(".vocab-ink-paper").boundingBox();
    for (const [type, dx] of [["mousePressed", 0], ["mouseMoved", 22], ["mouseReleased", 22]]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: b.x + x + dx, y: b.y + y,
        button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1,
        force: type === "mouseReleased" ? 0 : 0.6, clickCount: 1, pointerType: "pen" });
    }
  };
  const b = initial[".vocab-ink-paper"];
  for (const [x, y] of [[6, 5], [b.width - 30, 5], [b.width / 2, b.height / 2], [6, b.height - 5], [b.width - 30, b.height - 5]]) await line(x, y);
  await expect.poll(async () => (await ink(page))[0]?.strokes.length).toBe(5);
  const saved = (await ink(page))[0];
  expect(saved.strokes.every(s => s.coordinateSpace === "writing-page-v1" && s.writingAnchor.pageId === "answer")).toBe(true);
  expect(saved.strokes.every(s => Math.max(...s.points.map(p => p.x)) - Math.min(...s.points.map(p => p.x)) > 0.04)).toBe(true);
  const ys = saved.strokes.flatMap(s => s.points.map(p => p.writingLocal.y));
  expect(Math.min(...ys)).toBeLessThan(0.06); expect(Math.max(...ys)).toBeGreaterThan(0.94);
  await page.getByRole("button", { name: "对照", exact: true }).click();
  await expect(row.locator(".vocab-ink-reference")).toBeVisible();
  const withReference = await measure();
  expect(withReference).toEqual(initial);
  expect(await row.locator(".vocab-ink-paper").evaluate(el => {
    const b = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(b.x + b.width / 2, b.bottom - 5));
  })).toBe(true);
  await page.screenshot({ path: info.outputPath("edge-ink-and-reference.png") });

  await at(page, 34); await at(page, 0);
  await page.getByRole("button", { name: "选择模式", exact: true }).click();
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  await expect(row).toBeVisible();
  await page.reload(); await navTo(page, "筛查");
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  await expect(row.locator(".writing-ink-surface")).not.toHaveClass(/is-disabled/);
  expect((await ink(page))[0]).toEqual(saved);

  for (const [width, height, zoom] of [[1280, 840, 1], [1100, 720, 1], [1280, 840, 0.8], [1280, 840, 1.25]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(value => { document.documentElement.style.zoom = value; }, zoom);
    await expect.poll(async () => (await measure())[".vocab-ink-paper"].height / zoom).toBeCloseTo(114, 0);
    const layout = await measure();
    expect(layout.row.height / zoom).toBeCloseTo(120, 0);
    expect(layout[".writing-ink-content"]).toEqual(layout[".vocab-ink-paper"]);
    await page.screenshot({ path: info.outputPath(`layout-${width}-${zoom}.png`) });
  }
  expect((await ink(page))[0]).toEqual(saved);
  await page.evaluate(() => { document.documentElement.style.zoom = 1; });
  await row.getByRole("button", { name: "遮挡", exact: true }).click();
  await expect(row.locator(".vocab-ink-paper")).toBeHidden();
  await expect(row.locator(".vocab-ink-reference")).toBeVisible();
  await row.getByRole("button", { name: "揭开", exact: true }).click();
  await row.locator("textarea").fill("键盘中文");
  await row.locator("select").selectOption("wrong");
  await expect(row.locator(".vocab-verdict")).toContainText("错误");
  await row.locator("select").selectOption("correct");
  await expect(row.locator(".vocab-verdict")).toContainText("正确");
  expect((await ink(page))[0]).toEqual(saved);
  await page.getByRole("button", { name: "橡皮", exact: true }).click();
  await line(6, 5);
  await expect.poll(async () => (await ink(page))[0]?.strokes.at(-1)?.tool).toBe("eraser");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(async () => (await ink(page))[0]?.strokes).toEqual(saved.strokes);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "清空当前单词笔迹", exact: true }).click();
  await expect.poll(async () => (await ink(page))[0]?.strokes.length).toBe(0);
  expect((await ink(page)).filter(snapshot => snapshot.strokes.length)).toEqual([]);
  await expect(page.locator(".vocab-handwriting-message")).not.toContainText("logical page");
  await info.attach("browser-health", { body: JSON.stringify({ url: page.url(), title: await page.title(), errors, logs }), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(logs).toEqual([]);
});

test("existing 64px handwriting adapts without rewriting its stored snapshot", async ({ page }) => {
  await open(page); const row = await at(page, 0);
  await expect(row.locator(".writing-ink-surface")).not.toHaveClass(/is-disabled/);
  // Create a real saved stroke at the old paper size, then restore today's layout.
  const oldLayout = await page.addStyleTag({ content: ".vocab-ink-pad { top: 7px !important; height: 64px !important; }" });
  await expect.poll(async () => (await row.locator(".vocab-ink-paper").boundingBox()).height).toBe(64);
  await draw(page, row);
  await expect.poll(async () => (await ink(page))[0]?.strokes.length).toBe(1);
  const saved = (await ink(page))[0];
  await oldLayout.evaluate(el => el.remove());
  await expect.poll(async () => (await row.locator(".vocab-ink-paper").boundingBox()).height).toBe(114);
  await page.getByRole("button", { name: "选择模式", exact: true }).click();
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  await expect(row.locator(".writing-ink-surface")).not.toHaveClass(/is-disabled/);
  expect((await ink(page))[0]).toEqual(saved);
  await page.reload(); await navTo(page, "筛查");
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  await expect(row.locator(".writing-ink-surface")).not.toHaveClass(/is-disabled/);
  expect((await ink(page))[0]).toEqual(saved);
  await expect(page.locator(".vocab-handwriting-message")).not.toContainText("logical page");
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
