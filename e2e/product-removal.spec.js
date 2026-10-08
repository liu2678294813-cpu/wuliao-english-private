import { test, expect } from "@playwright/test";
import { createAccount, openOfficialResource, openOfficialCloze, readDurableInkEntries } from "./helpers.js";

test("旧模拟数据保留，所有旧地址返回首页且不运行考试", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const username = await createAccount(page);
  const keys = await page.evaluate((user) => {
    const prefix = "wuliao:user:" + encodeURIComponent(user) + ":";
    const rows = {
      "wuliao:exam-session:v1:legacy": { sessionId: "legacy", status: "in_progress", startedAt: 1 },
      "wuliao:exam-session-recovery:v1:legacy": { sessionId: "legacy", status: "in_progress" },
      "wuliao:exam-result:v1:legacy": { id: "legacy", status: "submitted" },
      "wuliao:exam-handoff:v1:legacy:reading": { examResultId: "legacy", targetId: "reading:text-1", status: "selected" },
    };
    for (const [key, value] of Object.entries(rows)) localStorage.setItem(prefix + key, JSON.stringify(value));
    return Object.fromEntries(Object.keys(rows).map((key) => [prefix + key, localStorage.getItem(prefix + key)]));
  }, username);
  for (const hash of ["#/exam/library", "#/exam/history", "#/exam/cover/2023", "#/exam/session/legacy", "#/exam/result/%E0%A4", "#/exam"]) {
    await page.goto("/" + hash);
    await expect(page.locator(".home-page")).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
    await page.reload();
    await expect(page.locator(".home-page")).toBeVisible();
    await expect(page.locator(".exam-page")).toHaveCount(0);
  }
  await expect(page.getByText(/整卷模拟：/)).toHaveCount(0);
  expect(await page.evaluate((before) => Object.fromEntries(Object.keys(before).map((key) => [key, localStorage.getItem(key)])), keys)).toEqual(keys);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole("button", { name: "模拟", exact: true })).toHaveCount(0);
  }
  await page.evaluate(() => { location.hash = "#/exam/session/from-hashchange"; });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await page.evaluate(() => {
    history.pushState(null, "", "#/exam/history");
    history.pushState(null, "", location.pathname);
    history.back();
  });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await page.evaluate(() => history.forward());
  await expect(page.locator(".home-page")).toBeVisible();
  expect(errors).toEqual([]);
});

test("编辑页面进入旧模拟 hash 先保存笔迹再回首页", async ({ page }) => {
  const username = await createAccount(page);
  await openOfficialResource(page, "2007 英语（一）Text 1");
  const target = page.locator("#deep-cover .deep-cover-subtitle");
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + 20, y = box.top + box.height / 2;
    element.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerType: "pen", pointerId: 71, button: 0, buttons: 1, pressure: 0.5, clientX: x, clientY: y,
    }));
    element.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerType: "pen", pointerId: 71, buttons: 1, pressure: 0.5, clientX: x + 75, clientY: y + 4,
    }));
    element.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerType: "pen", pointerId: 71, button: 0, buttons: 0, clientX: x + 75, clientY: y + 4,
    }));
    location.hash = "#/exam/session/legacy";
  });
  await expect(page.locator(".home-page")).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await expect.poll(async () => (await readDurableInkEntries(page, username))
    .flatMap((row) => JSON.parse(row.value) || []).length).toBeGreaterThan(0);
});

test("精读无清空页面，完形保留自己的清空笔迹", async ({ page }) => {
  const username = await createAccount(page);
  await openOfficialResource(page, "2007 英语（一）Text 1");
  const toolbar = page.locator(".reader-page > .annotation-toolbar");
  await expect(toolbar.getByRole("button", { name: "清空页面", exact: true })).toHaveCount(0);
  for (const name of ["笔", "橡皮", "撤销", "陌生词"]) {
    await expect(toolbar.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.locator(".reader-header .back-button").first().click();
  await openOfficialCloze(page, "2007 英语（一）完形填空");
  await expect(page.locator(".cloze-reader-page > .annotation-toolbar").getByRole("button", { name: "清空笔迹", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始限时初做", exact: true }).click();
  await page.getByRole("button", { name: "手写批注", exact: true }).click();
  await page.locator(".cloze-passage").scrollIntoViewIfNeeded();
  await page.locator(".cloze-ink-content").evaluate((element) => {
    const box = element.getBoundingClientRect(), x = Math.max(60, box.left + 90), y = Math.max(210, box.top + 110);
    const target = document.elementFromPoint(x, y) || element;
    for (const [type, delta] of [["pointerdown", 0], ["pointermove", 30], ["pointerup", 60]]) {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 91, pointerType: "pen",
        isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, pressure: .5, clientX: x + delta, clientY: y + delta / 2 }));
    }
  });
  const clozeInk = async () => (await readDurableInkEntries(page, username))
    .filter((row) => row.key.startsWith("wuliao:cloze-ink:"))
    .flatMap((row) => JSON.parse(row.value) || []);
  await expect.poll(async () => (await clozeInk()).length).toBe(1);
  const progressBefore = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes("wuliao:cloze-progress:")));
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "清空笔迹", exact: true }).click();
  await expect.poll(clozeInk).toEqual([]);
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes("wuliao:cloze-progress:")))).toEqual(progressBefore);
  await page.reload();
  expect(await clozeInk()).toEqual([]);
});

test("真实备份恢复全部 legacy exam 数据后静默保留，schema 与运行时边界不变", async ({ page }) => {
  const username = await createAccount(page);
  const before = await page.evaluate(async (username) => {
    const prefix = "wuliao:user:" + encodeURIComponent(username) + ":";
    const keys = ["wuliao:exam-session:v1:restored", "wuliao:exam-session-recovery:v1:restored",
      "wuliao:exam-result:v1:restored", "wuliao:exam-handoff:v1:restored:reading"];
    const entries = keys.map((key, i) => ({ key: prefix + key,
      value: JSON.stringify({ id: "restored", sessionId: "restored", status: "in_progress", fingerprint: "legacy-" + i }) }));
    for (const row of entries) localStorage.setItem(row.key, row.value);
    const db = await new Promise((resolve) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); });
    const schema = { version: db.version, stores: [...db.objectStoreNames] };
    const ink = { id: username + "::restored::reading", username, sessionId: "restored", surfaceId: "reading",
      fingerprint: "old-exam-ink", sourceFingerprint: "old-source", strokes: [{ points: [{ x: .1, y: .2 }, { x: .3, y: .4 }] }] };
    const tx = db.transaction("exam-ink", "readwrite");
    tx.objectStore("exam-ink").put(ink);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
    return { entries, ink, schema };
  }, username);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const download = await downloading, chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const buffer = Buffer.concat(chunks), manifest = JSON.parse(buffer.toString("utf8"));
  expect(manifest.sections.localStorage.user.filter((row) => row.key.startsWith("wuliao:exam-"))).toHaveLength(4);
  expect(manifest.sections.indexedDB["wuliao-english"]["exam-ink"][0].value).toEqual(before.ink);
  await page.evaluate(async (entries) => {
    for (const row of entries) localStorage.removeItem(row.key);
    const db = await new Promise((resolve) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction("exam-ink", "readwrite");
    tx.objectStore("exam-ink").clear(); // only this isolated test context
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    db.close();
  }, before.entries);
  await page.locator('.settings-panel input[type="file"]').setInputFiles({ name: "legacy-exam-backup.json", mimeType: "application/json", buffer });
  await expect(page.locator(".settings-backup-status")).toContainText("备份有效");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "确认恢复（merge）", exact: true }).click();
  await expect(page.locator(".settings-backup-status")).toContainText("恢复完成");
  await page.goto("/#/exam/session/restored");
  await expect(page.locator(".home-page")).toBeVisible();
  const restored = await page.evaluate(async ({ entries, ink }) => {
    const db = await new Promise((resolve) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); });
    const schema = { version: db.version, stores: [...db.objectStoreNames] };
    const value = await new Promise((resolve) => {
      const r = db.transaction("exam-ink").objectStore("exam-ink").get(ink.id); r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return { entries: entries.map((row) => ({ key: row.key, value: localStorage.getItem(row.key) })), ink: value, schema };
  }, before);
  expect(restored).toEqual(before);
  await expect(page.getByRole("button", { name: "模拟", exact: true })).toHaveCount(0);
});
