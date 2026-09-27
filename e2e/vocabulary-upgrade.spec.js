import { test, expect } from "@playwright/test";
import { createAccount, navTo, setScopedJson } from "./helpers.js";

async function setup(page) {
  const username = await createAccount(page);
  await navTo(page, "词库");
  await expect(page.locator(".vocabulary-frame.loaded")).toBeVisible();
  await page.waitForFunction(() => indexedDB.databases().then((dbs) => dbs.some((d) => d.name === "KaoyanVocabDB")));
  return username;
}

test("背词四种组合、循环锁定、撤销、清除与刷新", async ({ page }) => {
  await setup(page);
  await page.goto("/vocabulary/memorize.html");
  const row = page.locator(".word-row").first();
  await expect(row).toBeVisible();
  for (let count = 1; count <= 3; count++) {
    await row.locator(".mark-button").click();
    await expect(row.locator(".mark-button")).toContainText(`${count}/3`);
    if (count < 3) await expect(row).not.toHaveClass(/masked/);
  }
  await expect(row).toHaveClass(/masked/);
  await page.locator("#undoButton").click();
  await expect(row).not.toHaveClass(/masked/);
  await page.locator("#clearButton").click();
  await page.locator('[data-memory-rule="cycle"]').click();
  for (let i = 1; i <= 5; i++) {
    await row.locator(".mark-button").click();
    if (i % 2) await expect(row).toHaveClass(/masked/); else await expect(row).not.toHaveClass(/masked/);
  }
  await expect(row.locator(".mark-button")).toBeDisabled();
  await page.reload();
  await expect(row).toHaveClass(/masked/);
  await page.locator("#clearButton").click();
  await expect(row).not.toHaveClass(/masked/);
  await page.locator('[data-memory-input="swipe"]').click();
  await page.evaluate(() => { window.__testSpoken = []; window.WuliaoPronunciation = { speak: async (word) => window.__testSpoken.push(word) }; });
  await row.locator(".english").click();
  await expect.poll(() => page.evaluate(() => window.__testSpoken.length)).toBe(1);
  const swipe = async (reverse = false) => {
    const box = await row.locator(".word-content").boundingBox();
    const left = box.x + 120, right = box.x + 300, y = box.y + box.height / 2;
    await page.mouse.move(reverse ? right : left, y); await page.mouse.down();
    await page.mouse.move(reverse ? left : right, y, { steps: 10 }); await page.mouse.up();
  };
  for (let i = 0; i < 5; i++) { await swipe(i % 2 === 1); await expect(row).toHaveClass(i % 2 === 0 ? /masked/ : /word-row(?!.*masked)/); }
  await swipe(true); await expect(row).toHaveClass(/masked/);
  await page.locator('[data-memory-rule="default"]').click();
  await expect(row).toHaveClass(/masked/);
  await page.locator("#clearButton").click(); await swipe(); await expect(row).toHaveClass(/masked/);
  await page.screenshot({ path: "output/vocabulary-modes.png" });
});

async function handwriting(page) {
  await navTo(page, "筛查");
  const frame = page.frameLocator(".vocabulary-frame");
  await expect(frame.locator("body")).toContainText("筛查");
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  await expect(page.locator(".vocab-ink-row").first()).toBeVisible({ timeout: 30000 });
}

test("首次备份后手写数据库仍可正常保存", async ({ page }) => {
  await setup(page);
  await page.locator(".ds-mobile-settings, .ds-settings").first().click();
  await expect(page.locator(".settings-panel")).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.locator(".settings-action", { hasText: "导出备份" }).click();
  await downloaded;
  const stores = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("WuliaoVocabHandwritingDB");
    request.onsuccess = () => { const db = request.result; resolve([...db.objectStoreNames]); db.close(); };
    request.onerror = () => reject(request.error);
  }));
  expect(stores).toEqual(["answers", "sessions"]);
  await page.reload();
  await handwriting(page);
  await page.locator(".vocab-ink-row textarea").first().fill("备份后仍可写入");
  await page.waitForTimeout(500);
  await page.reload();
  await handwriting(page);
  await expect(page.locator(".vocab-ink-row textarea").first()).toHaveValue("备份后仍可写入");
});

test("手写筛选保留键盘输入、笔迹、遮挡，未经点击不调用AI", async ({ page }) => {
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  let requests = 0; page.on("request", (r) => { if (/chat\/completions|\/responses$/.test(r.url())) requests++; });
  await setup(page); await handwriting(page);
  const row = page.locator(".vocab-ink-row").first();
  await row.locator("textarea").fill("测试中文");
  await row.getByRole("button", { name: "遮挡", exact: true }).click();
  await expect(row).toHaveClass(/is-masked/);
  await row.getByRole("button", { name: "揭开", exact: true }).click();
  await expect(row.locator("textarea")).toHaveValue("测试中文");
  const box = await row.locator(".vocab-ink-paper").boundingBox();
  await page.mouse.move(box.x + 25, box.y + 22); await page.mouse.down(); await page.mouse.move(box.x + 95, box.y + 23, { steps: 15 }); await page.mouse.up();
  await page.locator(".vocab-handwriting-scroll").evaluate(el => { el.scrollTop = 4000; el.dispatchEvent(new Event("scroll")); });
  await page.locator(".vocab-handwriting-scroll").evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await expect(row.locator("textarea")).toHaveValue("测试中文");
  // Committed ink saves after a paint frame and the adapter's 250 ms debounce.
  // Assert durable IndexedDB data after virtualization, not a single read that
  // can race the scheduled write immediately after pointerup.
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); });
    const data = await new Promise((resolve) => { const r = db.transaction("writing-ink").objectStore("writing-ink").getAll(); r.onsuccess = () => resolve(r.result); });
    db.close(); return data.filter((r) => r.surfaceId.startsWith("vocabulary:")).reduce((n, r) => n + r.strokes.length, 0);
  })).toBeGreaterThan(0);
  expect(requests).toBe(0);
  await page.screenshot({ path: "output/vocabulary-handwriting-desktop.png" });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.screenshot({ path: "output/vocabulary-handwriting-tablet.png" });
  await page.getByRole("button", { name: "选择模式", exact: true }).click();
  await page.getByRole("button", { name: "手写模式", exact: true }).click();
  await expect(row.locator("textarea")).toHaveValue("测试中文");
  expect(errors).toEqual([]);
});

test("识别完成判断与归类、重复调用去重、人工改判仅改变本轮结果", async ({ page }) => {
  const username = await setup(page);
  // A local test credential and intercepted provider response; no paid service is called.
  await setScopedJson(page, username, "wuliao:ai:api-config", { baseUrl: "https://api.deepseek.com" });
  await page.evaluate((u) => {
    const prefix = `wuliao:user:${encodeURIComponent(u)}:`;
    localStorage.setItem(prefix + "wuliao:ai:apikey", "test-only-not-a-real-key");
    localStorage.setItem(prefix + "wuliao:ai:model", "deepseek-chat");
  }, username);
  let calls = 0;
  await page.route("https://api.deepseek.com/**", async (route) => {
    calls++;
    const body = route.request().postDataJSON();
    const rows = JSON.parse(body.messages.at(-1).content);
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items: rows.map((r, i) => ({ id: r.id, verdict: i === 0 ? "correct" : "wrong", reason: i === 0 ? "同义表达" : "意思相反" })) }) } }] } });
  });
  await handwriting(page);
  const rows = page.locator(".vocab-ink-row");
  await rows.nth(0).locator("textarea").fill("放弃");
  await rows.nth(1).locator("textarea").fill("反义测试");
  await page.getByRole("button", { name: "对照", exact: true }).click();
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "识别", exact: true }).click();
  await expect(rows.nth(0)).toContainText("已加入熟知词");
  await expect(rows.nth(1)).toContainText("已加入生词表");
  await page.getByRole("button", { name: "对照", exact: true }).click();
  await expect(page.getByRole("button", { name: "对照", exact: true })).toBeEnabled();
  await rows.nth(0).locator("select").selectOption("wrong");
  await expect(rows.nth(0)).toContainText("已加入生词表");
  const result = await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open("KaoyanVocabDB"); r.onsuccess = () => resolve(r.result); });
    const read = (name) => new Promise((resolve) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); });
    const lists = await read("wordLists"), records = await read("wordRecords"); db.close();
    return { lists: lists.filter((r) => r.handwritingSessionId).map((r) => ({ type: r.type, ids: r.wordIds })), records: records.filter((r) => r.handwritingAnswerId) };
  });
  expect(result.records).toHaveLength(2);
  expect(result.lists.find((r) => r.type === "familiar").ids).toHaveLength(0);
  expect(result.lists.find((r) => r.type === "raw").ids).toHaveLength(2);
});

test("识别严格按按钮触发，判断失败保留转录，迟到结果不覆盖键盘修改", async ({ page }) => {
  const username = await setup(page);
  await setScopedJson(page, username, "wuliao:writing:vision-api-config:v1", { baseUrl: "https://vision.example.com/v1" });
  await page.evaluate((u) => {
    const prefix = `wuliao:user:${encodeURIComponent(u)}:`;
    localStorage.setItem(prefix + "wuliao:writing:vision-api-key", "test-only-not-a-real-key");
    localStorage.setItem(prefix + "wuliao:writing:vision-model:v1", "test-vision");
  }, username);
  let calls = 0, release, prompt;
  await page.route("https://vision.example.com/**", async (route) => {
    calls++; prompt = route.request().postDataJSON();
    if (calls === 2) await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items: [{ id: "0", text: "远方", unsure: false }] }) } }] } });
  });
  await handwriting(page);
  const row = page.locator(".vocab-ink-row").first();
  const word = await row.locator(".vocab-ink-english").innerText();
  const draw = async () => {
    const box = await row.locator(".vocab-ink-paper").boundingBox();
    await page.mouse.move(box.x + 30, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 110, box.y + 35, { steps: 12 }); await page.mouse.up();
  };
  await draw(); expect(calls).toBe(0);
  await page.getByRole("button", { name: "识别", exact: true }).click();
  await expect(row.locator("textarea")).toHaveValue("远方");
  expect(JSON.stringify(prompt)).not.toContain(word.replace(/\s*♪$/, "").trim());
  await expect(row).not.toContainText("已加入");
  await expect(page.getByRole("button", { name: "识别", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "识别", exact: true }).click();
  await expect(page.getByRole("button", { name: "识别", exact: true })).toBeEnabled();
  expect(calls).toBe(1);
  await draw();
  await page.getByRole("button", { name: "识别", exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await row.locator("textarea").fill("用户修改后的意思");
  release();
  await expect(page.getByRole("button", { name: "识别", exact: true })).toBeEnabled();
  await expect(row.locator("textarea")).toHaveValue("用户修改后的意思");
  await draw();
  await row.locator("textarea").fill("画完立即键盘修改");
  await page.getByRole("button", { name: "识别", exact: true }).click();
  await expect(page.getByRole("button", { name: "识别", exact: true })).toBeEnabled();
  expect(calls).toBe(2);
  await expect(row.locator("textarea")).toHaveValue("画完立即键盘修改");
});

test("归类事务排队时修改答案，中止过期归类写入", async ({ page }) => {
  const username = await setup(page);
  await setScopedJson(page, username, "wuliao:ai:api-config", { baseUrl: "https://api.deepseek.com" });
  await page.evaluate((u) => {
    const p = `wuliao:user:${encodeURIComponent(u)}:`;
    localStorage.setItem(p + "wuliao:ai:apikey", "test-only-not-a-real-key");
    localStorage.setItem(p + "wuliao:ai:model", "deepseek-chat");
  }, username);
  let calls = 0;
  await page.route("https://api.deepseek.com/**", async (route) => {
    calls++;
    const rows = JSON.parse(route.request().postDataJSON().messages.at(-1).content);
    await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items: rows.map((r) => ({ id: r.id, verdict: "correct", reason: "测试结果" })) }) } }] } });
  });
  await handwriting(page);
  const row = page.locator(".vocab-ink-row").first();
  await row.locator("textarea").fill("原答案");
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open("KaoyanVocabDB"); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction(["wordLists", "wordRecords"], "readwrite");
    let keep = true;
    window.__releaseClassificationLock = () => { keep = false; };
    const spin = () => { const r = tx.objectStore("wordLists").get(-1); r.onsuccess = () => { if (keep) spin(); }; };
    spin(); tx.oncomplete = () => db.close();
  });
  await page.getByRole("button", { name: "识别", exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await row.locator("textarea").fill("修改后的答案");
  await page.evaluate(() => window.__releaseClassificationLock());
  await expect(page.getByRole("button", { name: "识别", exact: true })).toBeEnabled();
  const count = await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open("KaoyanVocabDB"); r.onsuccess = () => resolve(r.result); });
    const all = await new Promise((resolve) => { const r = db.transaction("wordRecords").objectStore("wordRecords").getAll(); r.onsuccess = () => resolve(r.result); });
    db.close(); return all.filter((r) => r.handwritingAnswerId).length;
  });
  expect(count).toBe(0);
  await expect(row.locator("textarea")).toHaveValue("修改后的答案");
});
