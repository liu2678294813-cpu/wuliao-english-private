import { test, expect } from "@playwright/test";
import { createAccount, openOfficialResource, navTo } from "./helpers.js";

async function drawAndReturn(page) {
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  await page.locator(".deep-paper:visible").first().scrollIntoViewIfNeeded();
  await page.locator(".deep-paper:visible").first().evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width * .2, y = Math.max(170, rect.top + 120);
    const target = document.elementFromPoint(x, y) || el;
    for (const [type, delta] of [["pointerdown", 0], ["pointermove", 24], ["pointerup", 48]]) {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 71, pointerType: "pen", isPrimary: true, buttons: type === "pointerup" ? 0 : 1, button: 0, pressure: .5, clientX: x + delta, clientY: y + delta / 2 }));
    }
    document.querySelector(".reader-header .back-button").click();
  });
}

async function ink(page, username) {
  return page.evaluate((user) => new Promise((resolve, reject) => {
    const open = indexedDB.open("wuliao-english");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("reader-ink").objectStore("reader-ink").index("username").getAll(user);
      request.onsuccess = () => { db.close(); resolve(request.result.filter((r) => r.key.startsWith("wuliao:deep-ink:v2:")).map((r) => ({ key: r.key, strokes: JSON.parse(r.value) }))); };
    };
  }), username);
}

test("20 immediate handwriting returns keep every stroke, then survive reload", async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const username = await createAccount(page);
  const title = "2007 英语（一）Text 1";
  await openOfficialResource(page, title);
  let previous = [];
  for (let index = 0; index < 20; index++) {
    await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
    const paper = page.locator(".deep-paper:visible").first();
    await paper.scrollIntoViewIfNeeded();
    // Same task dispatches pen-up and return: deliberately no debounce wait.
    await paper.evaluate((el, n) => {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width * .2;
      const y = Math.max(170, rect.top + 120) + n;
      const target = document.elementFromPoint(x, y) || el;
      for (const [type, dx, dy] of [["pointerdown", 0, 0], ["pointermove", 24, 12], ["pointerup", 48, 20]]) {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 71, pointerType: "pen", isPrimary: true, buttons: type === "pointerup" ? 0 : 1, button: 0, pressure: .5, clientX: x + dx, clientY: y + dy }));
      }
      document.querySelector(".reader-header .back-button").click();
    }, index);
    await expect(page.locator(".library-page")).toBeVisible();
    const stored = (await ink(page, username)).flatMap((r) => r.strokes);
    expect(stored).toHaveLength(index + 1);
    expect(stored.slice(0, previous.length)).toEqual(previous);
    previous = stored;
    await page.locator(".resource-card", { hasText: title }).first().locator(".resource-open").click();
    await expect(page.locator(".reader-page")).toBeVisible();
    await expect(page.locator(".annotation-toolbar button", { hasText: "撤销" })).toBeEnabled();
  }
  await page.reload();
  await expect(page.locator(".library-page")).toBeVisible();
  expect((await ink(page, username)).flatMap((r) => r.strokes)).toEqual(previous);
  expect(errors).toEqual([]);
});

test("API save auto-loads models; searchable selection and manual ID persist", async ({ page }) => {
  page.setDefaultTimeout(15000);
  await createAccount(page);
  let requests = 0;
  await page.route("https://api.deepseek.com/models", (route) => {
    requests++;
    return route.fulfill({ json: { data: [{ id: "test-model-a" }, { id: "test-model-b" }] } });
  });
  await page.getByRole("button", { name: "AI API", exact: true }).click();
  const settings = page.locator('[aria-label="文本 AI Provider 设置"]');
  await settings.locator('input[type="password"]').fill("fixture-not-a-real-key");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings.getByLabel("选择模型", { exact: true }).locator("option")).toHaveCount(3);
  await settings.getByLabel("搜索模型", { exact: true }).fill("model-b");
  await settings.getByLabel("选择模型", { exact: true }).selectOption("test-model-b");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings.locator(".provider-notice")).toContainText("配置已保存");
  await expect(settings.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  await settings.getByLabel("Model ID（可手动输入）", { exact: true }).fill("future-model-manual");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator(".home-page")).toBeVisible();
  await page.getByRole("button", { name: "AI API", exact: true }).click();
  await expect(settings.getByLabel("Model ID（可手动输入）", { exact: true })).toHaveValue("future-model-manual");
  expect(requests).toBeGreaterThanOrEqual(3);
});

test("failed IDB write blocks leaving, keeps pending stroke and retries", async ({ page }) => {
  const username = await createAccount(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    window.failInkWrites = true;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "reader-ink" && window.failInkWrites) throw new DOMException("fixture disk full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await openOfficialResource(page, "2007 英语（一）Text 1");
  await drawAndReturn(page);
  await expect(page.locator(".learning-save-status")).toContainText("保存失败");
  await expect(page.locator(".reader-page")).toBeVisible();
  expect((await ink(page, username)).flatMap((r) => r.strokes)).toHaveLength(0);
  await page.evaluate(() => { window.failInkWrites = false; });
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  // Saved status is hidden by default. Verify the commit before navigating.
  await expect.poll(async () => (await ink(page, username)).flatMap((row) => row.strokes).length).toBe(1);
  await expect(page.locator(".learning-save-status")).toHaveCount(0);
  await page.locator(".reader-header .back-button").first().click();
  await expect(page.locator(".library-page")).toBeVisible();
  expect((await ink(page, username)).flatMap((r) => r.strokes)).toHaveLength(1);
  await page.reload();
  await expect(page.locator(".library-page")).toBeVisible();
  expect((await ink(page, username)).flatMap((r) => r.strokes)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("legacy ink migrates at near-full localStorage and restores without old keys", async ({ page }) => {
  const username = await createAccount(page);
  const logicalKey = "wuliao:deep-ink:v2:legacy-resource:legacy-passage:deep-cover";
  await page.evaluate(({ user, key }) => {
    localStorage.setItem(`wuliao:user:${encodeURIComponent(user)}:${key}`, JSON.stringify([{ points: [{ x: .2, y: .3 }], fixture: "x".repeat(1200000) }]));
    // Fill only this isolated browser context until it exhibits the real failure.
    let count = 0;
    try { while (count < 80) localStorage.setItem(`quota-fixture-${count++}`, "x".repeat(64000)); } catch { /* expected quota */ }
  }, { user: username, key: logicalKey });
  await page.reload();
  await expect(page.locator(".home-page")).toBeVisible();
  const restored = await ink(page, username);
  expect(restored.find((row) => row.key === logicalKey).strokes[0].fixture.length).toBe(1200000);
  expect(await page.evaluate(({ user, key }) => localStorage.getItem(`wuliao:user:${encodeURIComponent(user)}:${key}`), { user: username, key: logicalKey })).toBeNull();
  await openOfficialResource(page, "2007 英语（一）Text 1");
  await drawAndReturn(page);
  await expect(page.locator(".library-page")).toBeVisible();
});

test("changing provider cancels stale catalog and refresh does not activate draft", async ({ page }) => {
  page.setDefaultTimeout(15000);
  const username = await createAccount(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let requested = false;
  await page.route("https://api.deepseek.com/models", async (route) => {
    requested = true;
    await held;
    await route.fulfill({ json: { data: [{ id: "stale-deepseek-model" }] } }).catch(() => {});
  });
  await page.route("https://generativelanguage.googleapis.com/v1beta/models*", (route) => route.fulfill({ json: { models: [{ name: "models/new-gemini-model", supportedGenerationMethods: ["generateContent"] }] } }));
  await page.getByRole("button", { name: "AI API", exact: true }).click();
  const settings = page.locator('[aria-label="文本 AI Provider 设置"]');
  await settings.locator('input[type="password"]').fill("fixture-a");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await settings.locator("select").first().selectOption("gemini");
  await settings.locator('input[type="password"]').fill("fixture-b");
  await settings.getByRole("button", { name: "刷新模型", exact: true }).click();
  await expect(settings.getByLabel("选择模型", { exact: true }).locator("option")).toHaveCount(2);
  release();
  await expect(settings.getByLabel("选择模型", { exact: true }).locator("option").last()).toHaveAttribute("value", "new-gemini-model");
  const selected = await page.evaluate((user) => JSON.parse(localStorage.getItem(`wuliao:user:${encodeURIComponent(user)}:wuliao:ai:provider-profile:v2:text`)).providerId, username);
  expect(selected).toBe("deepseek");
  await page.screenshot({ path: "output/save-models-20260909/desktop-model-selector.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(settings.getByLabel("选择模型", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "output/save-models-20260909/mobile-model-selector.png" });
});

test("IndexedDB ink remains compatible with backup v1 export and merge restore", async ({ page }) => {
  page.setDefaultTimeout(20000);
  const username = await createAccount(page);
  await openOfficialResource(page, "2007 英语（一）Text 1");
  await drawAndReturn(page);
  await expect(page.locator(".library-page")).toBeVisible();
  const original = await ink(page, username);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const downloadTask = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const download = await downloadTask;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const manifest = JSON.parse(buffer.toString("utf8"));
  expect(manifest.version).toBe(1);
  expect(manifest.sections.localStorage.user.some((row) => row.key === original[0].key && JSON.stringify(JSON.parse(row.value)) === JSON.stringify(original[0].strokes))).toBe(true);
  // Delete only this test context's store to simulate a restore on a clean device.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("wuliao-english");
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("reader-ink", "readwrite");
      tx.objectStore("reader-ink").clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await expect(page.locator(".library-page")).toBeVisible();
  expect(await ink(page, username)).toEqual([]);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator('.settings-panel input[type="file"]').setInputFiles({ name: "fixture-backup.json", mimeType: "application/json", buffer });
  await expect(page.locator(".settings-backup-status")).toContainText("备份有效");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "确认恢复（merge）", exact: true }).click();
  await expect(page.locator(".settings-backup-status")).toContainText("恢复完成");
  expect(await ink(page, username)).toEqual(original);
  await page.reload();
  await expect(page.locator(".library-page")).toBeVisible();
  expect(await ink(page, username)).toEqual(original);
});

test("PDF handwriting saves before exiting source view and restores visibly", async ({ page }) => {
  page.setDefaultTimeout(20000);
  const username = await createAccount(page);
  await openOfficialResource(page, "2007 英语（一）Text 1");
  await page.getByRole("button", { name: "查看原 PDF", exact: true }).click();
  await expect(page.locator(".ink-canvas")).toBeVisible();
  await page.locator(".annotation-toolbar .input-mode-picker button", { hasText: "手写批注" }).click();
  await page.locator(".ink-canvas").evaluate((canvas) => {
    const r = canvas.getBoundingClientRect();
    const y = Math.max(r.top + 50, 260), x = r.left + r.width * .3;
    for (const [type, dx] of [["pointerdown", 0], ["pointermove", 30], ["pointerup", 60]]) canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, pointerType: "pen", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x + dx, clientY: y + dx, pressure: .5 }));
    document.querySelector(".reader-header .back-button").click();
  });
  await expect(page.locator(".deep-reader-content")).toBeVisible();
  await page.getByRole("button", { name: "查看原 PDF", exact: true }).click();
  await expect(page.locator(".ink-canvas")).toBeVisible();
  await expect.poll(() => page.locator(".ink-canvas").evaluate((canvas) => {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) if (data[index]) return true;
    return false;
  })).toBe(true);
  expect(username).toBeTruthy();
});
