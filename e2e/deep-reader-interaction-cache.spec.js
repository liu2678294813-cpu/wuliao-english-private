import { test, expect } from "@playwright/test";
import { createAccount, uniqueUsername, openOfficialResource, clickStageAdvance } from "./helpers.js";

const TITLE = "2007 英语（一）Text 1";
test.use({ actionTimeout: 15000 });

async function reopen(page) {
  await page.reload();
  await page.locator(".library-page").waitFor({ timeout: 60000 });
  await page.locator(".resource-card", { hasText: TITLE }).first().locator(".resource-open").click();
  await page.locator('.reader-page, [role="alert"]').first().waitFor({ timeout: 90000 });
  await expect(page.getByRole("heading", { name: "页面遇到问题" })).toHaveCount(0);
  await expect(page.locator(".reader-page")).toBeVisible();
}

// Seeds only this test's isolated browser context, never a connected device.
async function translationFixture(page) {
  const username = await createAccount(page, uniqueUsername("reader-interaction"));
  await openOfficialResource(page, TITLE);
  await clickStageAdvance(page, "开始精读");
  const keys = await page.evaluate((user) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
    const flowKey = Object.keys(localStorage).find((key) => key.startsWith(`${prefix}wuliao:reading-flow:`));
    const flow = JSON.parse(localStorage.getItem(flowKey));
    const stages = ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"];
    for (const [index, id] of stages.entries()) flow.stages[id] = { status: index < 4 ? "completed" : index === 4 ? "current" : "pending", completedAt: index < 4 ? 100 : null };
    flow.currentStage = "deep-translation";
    flow.timedReading = { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: 100 };
    localStorage.setItem(flowKey, JSON.stringify(flow));
    const scope = `${flow.resourceId}:${flow.passageId}`;
    const first = `${prefix}wuliao:deep-answers:${scope}:first`;
    const redo = `${prefix}wuliao:deep-answers:${scope}:redo`;
    localStorage.setItem(first, JSON.stringify({ 21: "B" }));
    localStorage.setItem(redo, "{}");
    return { username: user, flow: flowKey, first, redo, progress: `${prefix}wuliao:translation-progress:${scope}`, evidence: `${prefix}wuliao:question-evidence:${scope}` };
  }, username);
  await reopen(page);
  return keys;
}

async function readJson(page, key) {
  return page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey) || "null"), key);
}

async function openDrawer(page) {
  if (!(await page.locator(".question-drawer.open").isVisible())) await page.locator(".question-fab").click();
  const item = page.locator(".question-drawer.open .question-item").first();
  if (!(await item.locator(".question-options").isVisible())) await item.locator(".question-stem").click();
  return item;
}

test("reader redo: unreached section is absent and stage navigation cannot skip translation", async ({ page }) => {
  await createAccount(page, uniqueUsername("reader-redo-gate"));
  await openOfficialResource(page, TITLE);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator("#deep-redo")).toHaveCount(0);
  const redoNav = page.locator(".stage-nav button", { hasText: "重做" });
  await expect(redoNav).toHaveAttribute("aria-disabled", "true");
  await redoNav.evaluate((button) => button.click());
  await expect(page.locator("#deep-redo")).toHaveCount(0);
  const stage = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.includes("wuliao:reading-flow:"));
    return key ? JSON.parse(localStorage.getItem(key)).currentStage : "deep-cover";
  });
  expect(stage).not.toBe("deep-redo");
});

test("reader redo: normal entry reveals cards and shares answer state with drawer", async ({ page }) => {
  const keys = await translationFixture(page);
  await expect(page.locator("#deep-redo")).toHaveCount(0);
  await clickStageAdvance(page, "进入重做");
  await expect.poll(async () => (await readJson(page, keys.flow)).currentStage).toBe("deep-redo");
  await expect(page.locator("#deep-redo")).toBeVisible();
  const item = await openDrawer(page);
  await expect(item.locator(".question-options button.selected")).toHaveCount(0);
  await expect(page.locator(".question-drawer.open .parse-status")).toHaveCount(0);
  await item.locator(".question-options button").nth(3).click();
  await expect.poll(() => readJson(page, keys.redo)).toEqual({ 21: "D" });
  await expect(page.locator("#deep-redo .deep-question-card").first().locator(".deep-options button").nth(3)).toHaveClass(/selected/);
  await page.locator("#deep-redo .deep-question-card").nth(1).locator(".deep-options button").nth(2).click();
  await openDrawer(page);
  const second = page.locator(".question-drawer.open .question-item").nth(1);
  if (!(await second.locator(".question-options").isVisible())) await second.locator(".question-stem").click();
  await expect(second.locator(".question-options button").nth(2)).toHaveClass(/selected/);
  expect(await readJson(page, keys.first)).toEqual({ 21: "B" });
  await reopen(page);
  await expect(page.locator("#deep-redo")).toBeVisible();
  expect(await readJson(page, keys.redo)).toEqual({ 21: "D", 22: "C" });
});

test("reader redo: sentence chips, selection limit, cancel and saved recovery", async ({ page }) => {
  await page.setViewportSize({ width: 832, height: 544 });
  const keys = await translationFixture(page);
  await clickStageAdvance(page, "进入重做");
  const card = page.locator("#deep-redo .deep-question-card").first();
  await card.locator(".deep-options button").first().click();
  await card.getByRole("button", { name: "去原文定位" }).click();
  const editor = page.locator(".evidence-editor-bar");
  await editor.getByRole("button", { name: "句子定位" }).click();
  const sentences = page.locator(".clean-article [data-evidence-sentence]");
  const first = sentences.nth(0);
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(first).toHaveClass(/evidence-sentence-selected/);
  await expect(editor).toContainText("已选择 1 / 3 句");
  await expect(editor.locator(".evidence-sentence-chip")).toContainText("P1 · S1");
  await expect.poll(() => editor.locator(".evidence-sentence-chip-jump").first().evaluate((button) => button.getBoundingClientRect().width)).toBeGreaterThan(150);
  expect(await first.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await expect(editor.locator(".evidence-sentence-chip")).toHaveCount(0);
  for (let i = 0; i < 3; i += 1) await sentences.nth(i).click();
  await sentences.nth(3).click();
  await expect(editor.getByRole("alert")).toContainText("每题最多选择 3 句核心依据");
  await expect(editor.locator(".evidence-sentence-chip")).toHaveCount(3);
  await editor.locator(".evidence-sentence-chip-remove").nth(2).click();
  await expect(editor.locator(".evidence-sentence-chip")).toHaveCount(2);
  await editor.getByRole("button", { name: "确认依据" }).click();
  const stored = await readJson(page, keys.evidence);
  const key = await card.getAttribute("data-question-key");
  expect(stored.questions[key].redo.references).toHaveLength(2);
  await card.getByRole("button", { name: "修改" }).click();
  await expect(editor.locator(".evidence-sentence-chip")).toHaveCount(2);
  await expect(sentences.nth(0)).toHaveAttribute("aria-pressed", "true");
  await sentences.nth(2).click();
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await card.getByRole("button", { name: "修改" }).click();
  await expect(editor.locator(".evidence-sentence-chip")).toHaveCount(2);
  expect((await readJson(page, keys.evidence)).questions[key].redo.references).toHaveLength(2);
});

test("reader interaction: drawer follows first/redo and manual redo preserves unfinished translation", async ({ page }) => {
  const keys = await translationFixture(page);
  const progress = await readJson(page, keys.progress);
  let item = await openDrawer(page);
  await expect(item.locator(".question-options button").nth(1)).toHaveClass(/selected/);
  await item.locator(".question-options button").nth(2).click();
  await expect.poll(() => readJson(page, keys.first)).toEqual({ 21: "C" });
  expect(await readJson(page, keys.redo)).toEqual({});
  await page.getByRole("button", { name: "关闭题窗", exact: true }).click();
  await clickStageAdvance(page, "进入重做");
  await expect.poll(async () => (await readJson(page, keys.flow)).currentStage).toBe("deep-redo");
  expect(await readJson(page, keys.progress)).toEqual(progress);
  expect((await readJson(page, keys.flow)).stages["deep-translation"].completedAt).not.toBeNull();
  item = await openDrawer(page);
  await expect(item.locator(".question-options button.selected")).toHaveCount(0);
  await item.locator(".question-options button").nth(3).click();
  await expect.poll(() => readJson(page, keys.redo)).toEqual({ 21: "D" });
  expect(await readJson(page, keys.first)).toEqual({ 21: "C" });
  await expect(page.locator("#deep-redo .deep-question-card").first().locator(".deep-options button").nth(3)).toHaveClass(/selected/);
  await page.getByRole("button", { name: "关闭题窗", exact: true }).click();
  await page.locator(".stage-nav button", { hasText: "逐段精读" }).click();
  await expect.poll(async () => (await readJson(page, keys.flow)).currentStage).toBe("deep-translation");
  item = await openDrawer(page);
  await expect(item.locator(".question-options button").nth(2)).toHaveClass(/selected/);
  await reopen(page);
  expect(await readJson(page, keys.first)).toEqual({ 21: "C" });
  expect(await readJson(page, keys.redo)).toEqual({ 21: "D" });
});

test("reader interaction: sentence evidence and notes stay isolated across attempts and reload", async ({ page }) => {
  const keys = await translationFixture(page);
  // First-attempt evidence is historical: the current product intentionally
  // keeps evidence tools hidden before redo. Preserve that permission boundary.
  const questionKey = await page.locator("#deep-first-quiz .deep-question-card").first().getAttribute("data-question-key");
  await page.evaluate(({ storageKey, flowKey, question }) => {
    const flow = JSON.parse(localStorage.getItem(flowKey));
    localStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 2, resourceId: flow.resourceId, passageId: flow.passageId, updatedAt: 100, questions: { [question]: { first: { mode: "global", references: [], ranges: [], textType: null, globalType: "main_idea", note: "首次：全文主旨依据", completedAt: 100 }, redo: null } } }));
  }, { storageKey: keys.evidence, flowKey: keys.flow, question: questionKey });
  await reopen(page);
  const first = (await readJson(page, keys.evidence)).questions[questionKey].first;
  const saveEvidence = async (sentence, note, attempt) => {
    const item = await openDrawer(page);
    await item.locator(".question-evidence-action").click();
    const editor = page.locator(".evidence-editor-bar");
    await expect(editor.locator(".evidence-editor-head")).toContainText(attempt);
    await editor.getByRole("button", { name: "句子定位", exact: true }).click();
    await page.locator(`[data-sentence-scope="${sentence}"]`).click();
    await editor.locator(".evidence-note-input").fill(note);
    await editor.getByRole("button", { name: "确认依据", exact: true }).click();
  };
  await clickStageAdvance(page, "进入重做");
  await expect.poll(async () => (await readJson(page, keys.flow)).currentStage).toBe("deep-redo");
  const redoItem = await openDrawer(page);
  await redoItem.locator(".question-options button").nth(2).click();
  await saveEvidence("clean:p3:s1", "重做：依据第三段", "重做");
  await reopen(page);
  const stored = await readJson(page, keys.evidence);
  expect(stored.questions[questionKey].first).toEqual(first);
  expect(stored.questions[questionKey].redo.note).toBe("重做：依据第三段");
  expect(stored.questions[questionKey].redo.mode).toBe("sentences");
  expect(stored.questions[questionKey].redo.references[0].paragraphNumber).toBe(3);
  const item = await openDrawer(page);
  await item.locator(".question-evidence-action").click();
  await expect(page.locator(".evidence-note-input")).toHaveValue("重做：依据第三段");
});

test("reader interaction: collapsing chrome retains mounted full toolbar at viewport top", async ({ page }) => {
  await translationFixture(page);
  const toolbar = page.locator(".annotation-toolbar");
  const pen = toolbar.getByRole("button", { name: "笔", exact: true });
  await pen.click();
  await pen.evaluate((element) => { element.dataset.mountSentinel = "retained"; });
  await toolbar.locator(".toolbar-collapse-toggle").click();
  await expect(pen).toBeVisible();
  await expect(pen).toHaveAttribute("data-mount-sentinel", "retained");
  await expect(toolbar.getByRole("button", { name: /橡皮/ })).toBeVisible();
  await expect(toolbar.locator(".tool-size-control")).toBeVisible();
  await expect(toolbar.locator(".color-picker")).toBeVisible();
  await expect(toolbar.getByRole("button", { name: /撤销/ })).toBeVisible();
  await expect(page.locator(".reader-header")).toBeHidden();
  await expect(page.locator(".stage-nav")).toBeHidden();
  await expect.poll(async () => (await toolbar.boundingBox()).y).toBeLessThanOrEqual(8);
  await toolbar.locator(".toolbar-collapse-toggle").click();
  await expect(page.locator(".stage-nav")).toBeVisible();
  await expect(pen).toHaveAttribute("data-mount-sentinel", "retained");
});

test("reader interaction: one synthetic pen gesture after unknown miss creates durable ink", async ({ page }, testInfo) => {
  const keys = await translationFixture(page);
  const toolbar = page.locator(".annotation-toolbar");
  await toolbar.getByRole("button", { name: "陌生词", exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => document.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "pen") window.__testPenDown = { x: event.clientX, y: event.clientY, tag: event.target.tagName, classes: event.target.className, inkOnly: event.target.getAttribute("data-ink-only") };
  }, { capture: true, once: true }));
  // Desktop translation textareas remain editable; use non-token article space
  // so this exercises the writable-body fallback rather than a text-input tap.
  const writing = page.locator(".translation-unit-tools").first();
  // Reader stage restoration and toolbar resizing can scroll after Playwright's
  // initial scrollIntoView. Verify the actual target before the sole pen down.
  let penPoint;
  await expect.poll(async () => {
    const point = await writing.evaluate(async (element) => {
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    const x = rect.right - 70;
    const y = rect.top + 20;
    const target = document.elementFromPoint(x, y);
    return { x, y, ready: y > (document.querySelector(".annotation-toolbar")?.getBoundingClientRect().bottom || 0)
      && y < innerHeight - 20 && Boolean(target?.closest(".translation-unit, .sentence-work")) };
    });
    if (point.ready) penPoint = point;
    return point.ready;
  }).toBe(true);
  const { x, y } = penPoint;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: 0.5 });
  await testInfo.attach('pen-pointerdown-hit', { body: JSON.stringify(await page.evaluate(() => window.__testPenDown), null, 2), contentType: 'application/json' });
  // Assert before pointerup: state must change inside the original pointerdown.
  await expect(toolbar.getByRole("button", { name: "笔", exact: true })).toHaveClass(/active/);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 45, y: y + 9, button: "none", buttons: 1, pointerType: "pen", force: 0.5 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 60, y: y + 12, button: "left", buttons: 0, pointerType: "pen", force: 0 });
  const readInk = () => page.evaluate(async (user) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wuliao-english"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const rows = await new Promise((resolve, reject) => { const request = db.transaction("reader-ink").objectStore("reader-ink").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    return rows.filter((row) => row.username === user && row.key.endsWith(":deep-translation")).flatMap((row) => JSON.parse(row.value));
  }, keys.username);
  await expect.poll(async () => (await readInk()).length).toBe(1);
  const canonical = await readInk();
  await toolbar.locator(".toolbar-collapse-toggle").click();
  expect(await readInk()).toEqual(canonical);
  await toolbar.locator(".toolbar-collapse-toggle").click();
  await reopen(page);
  expect(await readInk()).toEqual(canonical);
  await cdp.detach();
});
