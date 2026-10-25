import { test, expect } from "@playwright/test";
import { createAccount, uniqueUsername, openOfficialResource, clickStageAdvance, navTo, readDurableInkEntries } from "./helpers.js";

const TITLE = "2007 英语（一）Text 1";

async function reopen(page) {
  await page.reload();
  await page.locator(".library-page").waitFor({ timeout: 60000 });
  await page.locator(".resource-card", { hasText: TITLE }).first().locator(".resource-open").click();
  await expect(page.locator(".reader-page")).toBeVisible({ timeout: 90000 });
  // Existing reader position restoration reapplies its anchor at 420ms.
  await page.waitForTimeout(650);
}

async function fixture(page, withAi = true, currentStage = "deep-translation") {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let calls = 0;
  await page.route("**/chat/completions", async (route) => {
    calls++;
    await route.fulfill({ json: { choices: [{ message: { content: "本句测试义" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });
  });
  const username = await createAccount(page, uniqueUsername("unknown-context"));
  await openOfficialResource(page, TITLE);
  await clickStageAdvance(page, "开始精读");
  await page.evaluate(({ username, withAi, currentStage }) => {
    const prefix = `wuliao:user:${encodeURIComponent(username)}:`;
    const key = Object.keys(localStorage).find((key) => key.startsWith(`${prefix}wuliao:reading-flow:`));
    const flow = JSON.parse(localStorage.getItem(key));
    const stages = ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"];
    stages.forEach((id, index) => { flow.stages[id] = { status: index < 4 ? "completed" : index === 4 ? "current" : "pending", completedAt: index < 4 ? 100 : null }; });
    if (currentStage !== "deep-translation") {
      // A completed workbook can be revisited at an earlier or later stage.
      // Keep the visible sentence page reached while preserving the actual task.
      stages.forEach((id) => { flow.stages[id] = { status: id === currentStage ? "current" : "completed", completedAt: id === currentStage ? null : 100 }; });
    }
    flow.currentStage = currentStage;
    flow.timedReading = currentStage === "deep-clean-text"
      ? { phase: "paused", elapsedMs: 1000, startedAt: null, pausedAt: 100, completedAt: null }
      : { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: 100 };
    localStorage.setItem(key, JSON.stringify(flow));
    if (withAi) localStorage.setItem(`${prefix}wuliao:ai:apikey`, "isolated-mock-key");
  }, { username, withAi, currentStage });
  await reopen(page);
  return { username, errors, calls: () => calls };
}

export async function readUnknown(page, username) {
  return page.evaluate(async (user) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("wuliao-english"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const records = await new Promise((resolve, reject) => { const request = db.transaction("unknown-words").objectStore("unknown-words").index("username").getAll(user); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return records;
  }, username);
}

async function points(page, scopeIndex = 0, selector = '.sentence-source [data-unknown-scope]') {
  const scope = page.locator(selector).nth(scopeIndex);
  await scope.scrollIntoViewIfNeeded();
  return scope.evaluate(async (element) => {
    await document.fonts.ready;
    element.scrollIntoView({ block: "center", behavior: "instant" });
    // Touch scroll can retain momentum. Choose coordinates only after the
    // target's geometry has stayed stable, including delayed reader restore.
    let lastTop = null, stable = 0;
    for (let frame = 0; frame < 120 && stable < 8; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const top = element.getBoundingClientRect().top;
      stable = top === lastTop ? stable + 1 : 0; lastTop = top;
    }
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of node.data.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)) {
        const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
        const rect = range.getBoundingClientRect(); result.push({ word: match[0], x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2, left: rect.left, right: rect.right });
      }
    }
    return result;
  });
}

async function penGesture(page, path) {
  const cdp = await page.context().newCDPSession(page);
  const start = path[0], end = path.at(-1);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1, pointerType: "pen", force: 0.5 });
  for (const point of path.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, buttons: 1, pointerType: "pen", force: 0.5 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, pointerType: "pen", force: 0 });
  await cdp.detach();
}

async function fingerGesture(page, start, end = start, duration = 100) {
  const cdp = await page.context().newCDPSession(page);
  const timestamp = Date.now() / 1000;
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x, y: start.y }], timestamp });
    await page.waitForTimeout(duration);
    if (end.x !== start.x || end.y !== start.y) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: end.x, y: end.y }], timestamp: timestamp + duration / 1000 - .001 });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: timestamp + duration / 1000 });
  } finally { await cdp.detach(); }
}

async function handwritingFixture(page) {
  const f = await fixture(page, false);
  await page.locator(".annotation-toolbar").getByRole("button", { name: "手写批注", exact: true }).click();
  await expect(page.locator(".deep-reader-content")).toHaveClass(/note-mode/);
  return f;
}

const INITIAL_ORIGINAL = '#deep-clean-text .clean-article [data-unknown-scope]';
const initialPoints = (page) => points(page, 0, INITIAL_ORIGINAL);

async function timedInitialFixture(page, phase = "running", aiFailure = false) {
  const errors = [], consoleErrors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  let calls = 0;
  await page.route("**/chat/completions", async (route) => {
    calls++;
    await route.fulfill({ status: 503, json: { error: { message: "isolated contextual meaning failure" } } });
  });
  const username = await createAccount(page, uniqueUsername("timed-unknown"));
  if (aiFailure) await page.evaluate((user) => {
    localStorage.setItem(`wuliao:user:${encodeURIComponent(user)}:wuliao:ai:apikey`, "isolated-mock-key");
  }, username);
  await openOfficialResource(page, TITLE);
  await clickStageAdvance(page, "开始精读");
  await clickStageAdvance(page, "完成审题，进入初做");
  if (phase === "paused") {
    await page.getByRole("button", { name: "← 资料库", exact: true }).click();
    await page.locator(".resource-card", { hasText: TITLE }).first().locator(".resource-open").click();
  }
  await expect(page.locator(`.timed-reading-timer.${phase}`)).toBeVisible();
  await page.waitForTimeout(650);
  return { username, errors, consoleErrors, calls: () => calls };
}

async function protectedInitialState(page, username) {
  return page.evaluate((user) => {
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
    return Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith(prefix)
      && /reading-flow:|answers:|translation-progress:|review-history:|question-evidence:/.test(key)));
  }, username);
}

for (const phase of ["running", "paused"]) {
  test(`timed initial ${phase}: finger marks original, preserves learning state and survives reload`, async ({ page }, info) => {
    const f = await timedInitialFixture(page, phase);
    await page.locator("#deep-first-quiz .deep-options button").first().click();
    await page.locator(".annotation-toolbar").getByRole("button", { name: "手写批注", exact: true }).click();
    await expect(page.locator(".annotation-toolbar").getByRole("button", { name: "陌生词", exact: true })).toBeVisible();
    let token = (await initialPoints(page))[4];
    const before = await protectedInitialState(page, f.username);
    const inkBefore = await readDurableInkEntries(page, f.username);
    await fingerGesture(page, token, token, 400);
    await expect.poll(async () => (await readUnknown(page, f.username)).map((r) => r.word)).toEqual([token.word]);
    const [saved] = await readUnknown(page, f.username);
    expect(saved.occurrences[0]).toMatch(/^clean:p1:/);
    expect(saved.senses[0].contextKey).toMatch(/:p1:s1$/);
    const sentence = await page.locator('[data-sentence-scope="clean:p1:s1"]').textContent();
    expect(saved.senses[0].sentence).toBe(sentence.trim());
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBe(1);
    expect(await protectedInitialState(page, f.username)).toEqual(before);
    expect(await readDurableInkEntries(page, f.username)).toEqual(inkBefore);
    await expect(page.locator(`.timed-reading-timer.${phase}`)).toBeVisible();
    await expect(page.locator(".sentence-action-bar")).toHaveCount(0);
    await expect(page.locator("#deep-first-quiz .question-ai-hint-button, #deep-first-quiz .deep-options .correct")).toHaveCount(0);
    expect(await page.locator("vite-error-overlay").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`timed-initial-${phase}.png`) });
    await reopen(page);
    expect(await readUnknown(page, f.username)).toHaveLength(1);
    token = (await initialPoints(page))[4];
    const reopenedState = await protectedInitialState(page, f.username);
    await fingerGesture(page, token);
    await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(0);
    expect(await protectedInitialState(page, f.username)).toEqual(reopenedState);
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBe(0);
    expect(await readDurableInkEntries(page, f.username)).toEqual(inkBefore);
    expect(f.errors).toEqual([]);
    expect(f.consoleErrors).toEqual([]);
  });
}

test("timed initial keyboard mode: mouse and pen tap original without changing answers or ink", async ({ page }) => {
  const f = await timedInitialFixture(page);
  await page.locator(".annotation-toolbar").getByRole("button", { name: "键盘输入", exact: true }).click();
  const tokens = await initialPoints(page), before = await protectedInitialState(page, f.username);
  const inkBefore = await readDurableInkEntries(page, f.username);
  await page.mouse.click(tokens[4].x, tokens[4].y);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  await page.mouse.click(tokens[4].x, tokens[4].y);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(0);
  await penGesture(page, [tokens[7]]);
  await expect.poll(async () => (await readUnknown(page, f.username)).map((r) => r.word)).toEqual([tokens[7].word]);
  expect(await protectedInitialState(page, f.username)).toEqual(before);
  expect(await readDurableInkEntries(page, f.username)).toEqual(inkBefore);
  expect(f.errors).toEqual([]);
  expect(f.consoleErrors).toEqual([]);
});

test("timed initial handwriting: ordinary pen writes; unknown tool selects a phrase and finger cancels it", async ({ page }, info) => {
  const f = await timedInitialFixture(page);
  const toolbar = page.locator(".annotation-toolbar");
  await toolbar.getByRole("button", { name: "手写批注", exact: true }).click();
  await toolbar.getByRole("button", { name: "笔", exact: true }).click();
  let tokens = await initialPoints(page);
  await penGesture(page, [tokens[4], { ...tokens[4], x: tokens[4].x + 30, y: tokens[4].y + 3 }]);
  const strokes = async () => (await readDurableInkEntries(page, f.username)).flatMap((r) => {
    const value = JSON.parse(r.value); return Array.isArray(value) ? value : [];
  });
  await expect.poll(async () => (await strokes()).length).toBe(1);
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  await toolbar.getByRole("button", { name: "陌生词", exact: true }).click();
  tokens = await initialPoints(page);
  const inkBefore = await readDurableInkEntries(page, f.username);
  const before = await protectedInitialState(page, f.username);
  await penGesture(page, [tokens[2], tokens[4]]);
  await expect.poll(async () => (await readUnknown(page, f.username)).map((r) => r.word)).toEqual([tokens.slice(2, 5).map((t) => t.word).join(" ")]);
  expect((await readUnknown(page, f.username))[0].occurrences).toHaveLength(3);
  await page.screenshot({ path: info.outputPath("timed-initial-phrase.png") });
  await fingerGesture(page, tokens[3]);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(0);
  expect(await protectedInitialState(page, f.username)).toEqual(before);
  expect(await readDurableInkEntries(page, f.username)).toEqual(inkBefore);
  expect(f.errors).toEqual([]);
  expect(f.consoleErrors).toEqual([]);
});

test("timed initial original: evidence selection takes priority when revisited from redo", async ({ page }) => {
  const f = await fixture(page, false, "deep-redo");
  await page.locator("#deep-redo .deep-options button").first().click();
  await page.locator(".annotation-toolbar").getByRole("button", { name: "陌生词", exact: true }).click();
  await page.locator("#deep-redo").getByRole("button", { name: "去原文定位", exact: true }).first().click();
  const editor = page.locator(".evidence-editor-bar");
  await editor.getByRole("button", { name: "句子定位", exact: true }).click();
  let tokens = await initialPoints(page);
  await fingerGesture(page, tokens[4]);
  await expect(page.locator(".evidence-sentence-chip")).toHaveCount(1);
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  await editor.getByRole("button", { name: "原文片段", exact: true }).click();
  tokens = await initialPoints(page);
  await page.mouse.move(tokens[2].left, tokens[2].y);
  await page.mouse.down();
  await page.mouse.move(tokens[4].right, tokens[4].y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".evidence-text-ranges q")).toHaveCount(1);
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  tokens = await initialPoints(page);
  await fingerGesture(page, tokens[4]);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  expect(f.errors).toEqual([]);
});

test("timed initial rejects controls, whitespace, scrolling, multiple fingers and cancelled gestures", async ({ page }) => {
  const f = await timedInitialFixture(page);
  await page.locator(".annotation-toolbar").getByRole("button", { name: "手写批注", exact: true }).click();
  let token = (await initialPoints(page))[4];
  const heading = page.locator("#deep-clean-text .clean-paragraph-heading").first();
  const box = await heading.boundingBox();
  await fingerGesture(page, { x: box.x + 10, y: box.y + box.height / 2 });
  await fingerGesture(page, { x: box.x + box.width - 5, y: box.y + box.height / 2 });
  await fingerGesture(page, token, token, 451);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y }, { x: token.x + 40, y: token.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: token.x, y: token.y - 70 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  token = (await initialPoints(page))[4];
  await fingerGesture(page, token);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  expect(f.errors).toEqual([]);
  expect(f.consoleErrors).toEqual([]);
});

test("timed initial saves a word despite contextual AI failure and keeps translation controls hidden", async ({ page }) => {
  const f = await timedInitialFixture(page, "running", true);
  const token = (await initialPoints(page))[4];
  const before = await protectedInitialState(page, f.username);
  await fingerGesture(page, token);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  await expect.poll(f.calls).toBeGreaterThan(0);
  await expect(page.locator(".sentence-action-bar")).toHaveCount(0);
  expect((await readUnknown(page, f.username))[0].senses[0].meaningSource).not.toBe("context-ai");
  expect(await protectedInitialState(page, f.username)).toEqual(before);
  expect(f.errors).toEqual([]);
  expect(f.consoleErrors.filter((message) => !message.includes("503"))).toEqual([]);
  await page.getByRole("button", { name: "← 资料库", exact: true }).click();
  await page.getByRole("button", { name: "陌生词库", exact: true }).click();
  await expect(page.locator(".unknown-word-card", { hasText: token.word })).toHaveCount(1);
});

for (const stage of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"]) {
  test(`finger adds from visible sentence when actual task is ${stage}, without changing other learning state`, async ({ page }, testInfo) => {
    const f = await fixture(page, false, stage);
    await page.locator(".annotation-toolbar").getByRole("button", { name: "手写批注", exact: true }).click();
    const protectedState = async () => page.evaluate((username) => {
      const prefix = `wuliao:user:${encodeURIComponent(username)}:`;
      return Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith(prefix)
        && /reading-flow:|answers:|translation-progress:|review-history:/.test(key)));
    }, f.username);
    let token = (await points(page))[4]; // Scroll back to the original sentence; no stage button.
    const before = await protectedState();
    const inkBefore = await readDurableInkEntries(page, f.username);
    const flowEntry = Object.entries(before).find(([key]) => key.includes("reading-flow:"));
    // The legacy clean-text stage is normalized into the initial quiz on entry.
    expect(JSON.parse(flowEntry[1]).currentStage).toBe(stage === "deep-clean-text" ? "deep-first-quiz" : stage);
    await fingerGesture(page, token);
    await expect.poll(async () => (await readUnknown(page, f.username)).map(r => r.word)).toContain(token.word);
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBe(1);
    expect(await protectedState()).toEqual(before);
    expect(await readDurableInkEntries(page, f.username)).toEqual(inkBefore);
    await page.screenshot({ path: testInfo.outputPath(`finger-stage-${stage}.png`) });
    await reopen(page);
    expect(await readUnknown(page, f.username)).toHaveLength(1);
    token = (await points(page))[4];
    await fingerGesture(page, token);
    await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(0);
    expect(await protectedState()).toEqual(before);
    expect(await readDurableInkEntries(page, f.username)).toEqual(inkBefore);
    expect(f.errors).toEqual([]);
  });
}

test("finger adds after archive sentence positioning from redo in keyboard mode without changing the task", async ({ page }) => {
  const f = await fixture(page, false, "deep-redo");
  await page.locator(".annotation-toolbar").getByRole("button", { name: "键盘输入", exact: true }).click();
  const before = await page.evaluate((username) => {
    const prefix = `wuliao:user:${encodeURIComponent(username)}:wuliao:reading-flow:`;
    const key = Object.keys(localStorage).find(key => key.startsWith(prefix));
    const value = localStorage.getItem(key);
    const flow = JSON.parse(value);
    window.dispatchEvent(new CustomEvent("wuliao:learning-archive-jump", { detail: {
      resourceId: flow.resourceId, passageId: flow.passageId,
      sentenceId: `${flow.resourceId}::${flow.passageId}::p1s1`,
    } }));
    return { key, value };
  }, f.username);
  await expect(page.locator('.stage-nav button[aria-current="step"]')).toContainText("逐段精读");
  // Sentence positioning intentionally settles at 220/500ms and then 380ms.
  // Finish that navigation before sampling the glyph coordinates for a tap.
  await page.waitForTimeout(1000);
  const token = (await points(page))[4];
  const inkBefore = await readDurableInkEntries(page, f.username);
  await fingerGesture(page, token);
  await expect.poll(async () => (await readUnknown(page, f.username)).map(r => r.word)).toContain(token.word);
  const otherTokens = await points(page);
  await page.mouse.click(otherTokens[7].x, otherTokens[7].y);
  await penGesture(page, [otherTokens[8]]);
  expect(await readUnknown(page, f.username)).toHaveLength(1);
  expect(await page.evaluate(key => localStorage.getItem(key), before.key)).toBe(before.value);
  expect(await readDurableInkEntries(page, f.username)).toEqual(inkBefore);
  expect(f.errors).toEqual([]);
});

test("finger near-hits and 400ms presses save correctly in handwriting mode", async ({ page }, testInfo) => {
  const f = await handwritingFixture(page);
  let token = (await points(page))[4];
  await fingerGesture(page, { x: token.x, y: token.y }, undefined, 400);
  await expect.poll(async () => (await readUnknown(page, f.username)).map(r => r.word)).toContain(token.word);
  for (const index of [7, 10]) {
    token = (await points(page))[index];
    const rect = await page.locator('.sentence-source [data-unknown-scope]').first().evaluate((scope, index) => {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT), ranges = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const match of node.data.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)) {
        const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
        const b = range.getBoundingClientRect(); ranges.push({ top: b.top, bottom: b.bottom });
      }
      return ranges[index];
    }, index);
    await fingerGesture(page, { x: token.x, y: index === 7 ? rect.top - 4 : rect.bottom + 4 });
    await expect.poll(async () => (await readUnknown(page, f.username)).map(r => r.word)).toContain(token.word);
  }
  expect(await readUnknown(page, f.username)).toHaveLength(3);
  expect((await readDurableInkEntries(page, f.username)).flatMap(r => {
    const value = JSON.parse(r.value); return Array.isArray(value) ? value : [];
  })).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("finger-near-hits.png") });
  await reopen(page);
  expect(await readUnknown(page, f.username)).toHaveLength(3);
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBeGreaterThanOrEqual(3);
  expect(f.errors).toEqual([]);
});

test("finger release anchors a gap to the down word and rejects a neighboring glyph", async ({ page }) => {
  const f = await handwritingFixture(page);
  const words = await points(page), token = words[8], next = words[9];
  await fingerGesture(page, { x: token.right - 1, y: token.y }, { x: next.left - .5, y: token.y });
  await expect.poll(async () => (await readUnknown(page, f.username)).map(r => r.word)).toEqual([token.word]);
  await fingerGesture(page, token);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(0);
  await fingerGesture(page, { x: token.right - 1, y: token.y }, { x: next.left + 1, y: token.y });
  await page.waitForTimeout(250);
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  await fingerGesture(page, { x: (token.right + next.left) / 2, y: token.y });
  await page.waitForTimeout(250);
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test("finger timeout, multi-touch, cancel and scroll do not add or poison the next tap", async ({ page }) => {
  const f = await handwritingFixture(page);
  let token = (await points(page))[4];
  await fingerGesture(page, token, undefined, 451);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y, id: 1 }, { x: token.x + 40, y: token.y, id: 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: token.x, y: token.y - 70 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach(); }
  token = (await points(page))[4];
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  await fingerGesture(page, token);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  expect(f.errors).toEqual([]);
});

test("100 successive finger adds and cancellations each match durable records and highlights", async ({ page }, testInfo) => {
  const f = await handwritingFixture(page), token = (await points(page))[4];
  for (let i = 0; i < 100; i++) {
    await fingerGesture(page, token, undefined, 30);
    const expected = i % 2 === 0 ? 1 : 0;
    await expect.poll(async () => (await readUnknown(page, f.username)).length, { message: `finger gesture ${i + 1}` }).toBe(expected);
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBe(expected);
  }
  expect((await readDurableInkEntries(page, f.username)).flatMap(r => {
    const value = JSON.parse(r.value); return Array.isArray(value) ? value : [];
  })).toHaveLength(0);
  expect(f.errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("finger-100-cancelled.png") });
});

test("touch adds then cancels a word, with durable highlights and contextual meaning", async ({ page }, testInfo) => {
  const f = await fixture(page);
  const token = (await points(page))[3];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  await expect.poll(async () => (await readUnknown(page, f.username))[0]?.senses[0].meaningSource).toBe("context-ai");
  const [saved] = await readUnknown(page, f.username);
  expect(saved.senses[0].contextKey).toMatch(/:p1:s1$/);
  expect(saved.senses[0].sentence).toContain(token.word);
  expect(saved.occurrences).toHaveLength(1);
  expect(f.calls()).toBe(1);
  expect(await page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size)).toBeGreaterThan(0);
  await reopen(page);
  expect(await readUnknown(page, f.username)).toEqual([saved]);
  const repeated = (await points(page))[3];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: repeated.x, y: repeated.y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBe(0);
  await reopen(page);
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  await expect(page.locator(".translation-unit textarea").first()).toBeAttached();
  await expect(page.locator(".translation-ocr-button").first()).toBeAttached();
  await expect(page.getByText("笔迹已保存", { exact: true })).toHaveCount(0);
  expect(f.errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("direct-tap.png") });
  await cdp.detach();
});

test("touching a phrase constituent cancels the whole phrase and remains cancelled after reload", async ({ page }) => {
  const f = await fixture(page);
  await page.locator(".annotation-toolbar").getByRole("button", { name: "陌生词", exact: true }).click();
  const tokens = (await points(page)).slice(2, 5);
  await penGesture(page, [tokens[0], tokens[2]]);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  const point = (await points(page))[3];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(0);
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBe(0);
  await reopen(page);
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  await page.getByRole("button", { name: "← 资料库", exact: true }).click();
  await page.getByRole("button", { name: "陌生词库", exact: true }).click();
  await expect(page.locator(".unknown-word-card")).toHaveCount(0);
  expect(f.errors).toEqual([]);
  await cdp.detach();
});

test("unknown forward/reverse sparse samples create one phrase, library edits survive reload", async ({ page }, testInfo) => {
  const f = await fixture(page);
  await page.locator(".annotation-toolbar").getByRole("button", { name: "陌生词", exact: true }).click();
  const tokens = await points(page);
  const chosen = tokens.slice(2, 5), phrase = chosen.map((p) => p.word).join(" ");
  await penGesture(page, [chosen[0], chosen[2]]);
  await testInfo.attach("phrase-first-records", { body: JSON.stringify({ chosen, records: await readUnknown(page, f.username) }), contentType: "application/json" });
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  const reverse = (await points(page)).slice(2, 5);
  await penGesture(page, [reverse[2], reverse[0]]);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  await expect.poll(async () => (await readUnknown(page, f.username))[0]?.senses[0].meaningSource).toBe("context-ai");
  const [saved] = await readUnknown(page, f.username);
  expect(saved.word).toBe(phrase); expect(saved.occurrences).toHaveLength(3);
  expect(f.calls()).toBe(1);
  await page.getByRole("button", { name: "← 资料库", exact: true }).click();
  await page.getByRole("button", { name: "陌生词库", exact: true }).click();
  const card = page.locator(".unknown-word-card", { hasText: phrase });
  await expect(card).toHaveCount(1); await expect(card).toContainText("本句测试义");
  page.once("dialog", (dialog) => dialog.accept("人工本句义"));
  await card.locator(".unknown-context-sense").click();
  await expect(card).toContainText("人工本句义");
  await page.screenshot({ path: testInfo.outputPath("phrase-library.png") });
  await page.reload();
  await page.locator(".reader-page, .library-page").first().waitFor();
  if (await page.locator(".reader-page").isVisible()) await page.getByRole("button", { name: "← 资料库", exact: true }).click();
  await page.getByRole("button", { name: "陌生词库", exact: true }).click();
  await expect(page.locator(".unknown-word-card", { hasText: phrase })).toContainText("人工本句义");
  expect(f.errors).toEqual([]);
});

test("cross-sentence gesture persists separate phrases with distinct contexts after reload", async ({ page }) => {
  const f = await fixture(page);
  await page.locator(".annotation-toolbar").getByRole("button", { name: "陌生词", exact: true }).click();
  // Compact only the fixture's writing rows so both real English sentence DOM
  // scopes fit in one viewport during a single physical coordinate gesture.
  await page.addStyleTag({ content: ".translation-unit,.sentence-work-meta{display:none!important}" });
  await points(page);
  const groups = await page.locator(".sentence-source [data-unknown-scope]").evaluateAll((scopes) => scopes.slice(0, 2).map((scope) => {
    const result = [], walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const match of node.data.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)) {
      const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      const rect = range.getBoundingClientRect(); result.push({ word: match[0], x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 });
    }
    return result;
  }));
  const first = groups[0].slice(-2), second = groups[1].slice(0, 2);
  for (const point of [...first, ...second]) expect(point.y).toBeLessThan(page.viewportSize().height);
  await penGesture(page, [...first, ...second]);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(2);
  const saved = await readUnknown(page, f.username);
  expect(saved.map((row) => row.word).sort()).toEqual([first.map((p) => p.word).join(" "), second.map((p) => p.word).join(" ")].sort());
  expect(new Set(saved.map((row) => row.senses[0].contextKey)).size).toBe(2);
  expect(saved.every((row) => row.occurrences.length === 2)).toBe(true);
  await reopen(page);
  const reloaded = await readUnknown(page, f.username);
  expect(reloaded.map((row) => row.id).sort()).toEqual(saved.map((row) => row.id).sort());
  await page.getByRole("button", { name: "← 资料库", exact: true }).click();
  await page.getByRole("button", { name: "陌生词库", exact: true }).click();
  await expect(page.locator(".unknown-word-card")).toHaveCount(2);
  expect(f.errors).toEqual([]);
});

test("pen annotation never adds a word; English whitespace stays unknown; writing falls back in same stroke", async ({ page }) => {
  const f = await fixture(page, false);
  const toolbar = page.locator(".annotation-toolbar");
  await toolbar.getByRole("button", { name: "笔", exact: true }).click();
  const tokens = await points(page);
  await penGesture(page, [tokens[2], { ...tokens[2], x: tokens[2].x + 15 }]);
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  await expect.poll(async () => (await readDurableInkEntries(page, f.username)).flatMap((r) => { const value = JSON.parse(r.value); return Array.isArray(value) ? value : []; }).length).toBeGreaterThan(0);
  await toolbar.getByRole("button", { name: "陌生词", exact: true }).click();
  const fresh = await points(page);
  const gap = { x: (fresh[1].right + fresh[2].left) / 2, y: fresh[2].y };
  await penGesture(page, [gap, fresh[2], fresh[4]]);
  await expect(toolbar.getByRole("button", { name: "陌生词", exact: true })).toHaveClass(/active/);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  const writing = page.locator(".translation-unit-tools").first();
  await writing.scrollIntoViewIfNeeded();
  const box = await writing.evaluate(async (element) => {
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    return { x: rect.right - 95, y: rect.top, height: rect.height };
  });
  const before = (await readDurableInkEntries(page, f.username)).flatMap((r) => { const value = JSON.parse(r.value); return Array.isArray(value) ? value : []; }).length;
  await penGesture(page, [{ x: box.x + 25, y: box.y + 20 }, { x: box.x + 70, y: box.y + 25 }]);
  await expect(toolbar.getByRole("button", { name: "笔", exact: true })).toHaveClass(/active/);
  await expect.poll(async () => (await readDurableInkEntries(page, f.username)).flatMap((r) => { const value = JSON.parse(r.value); return Array.isArray(value) ? value : []; }).length).toBeGreaterThan(before);
  expect(f.errors).toEqual([]);
});

test("touch movement rejects add; keyboard pen tap adds without ink", async ({ page }) => {
  const f = await fixture(page, false);
  const cdp = await page.context().newCDPSession(page);
  let token = (await points(page))[3];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: token.x, y: token.y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: token.x + 45, y: token.y + 20 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  await page.locator(".annotation-toolbar").getByRole("button", { name: "键盘输入", exact: true }).click();
  token = (await points(page))[3];
  await penGesture(page, [token]);
  await expect.poll(async () => (await readUnknown(page, f.username)).length).toBe(1);
  expect((await readDurableInkEntries(page, f.username)).flatMap((r) => { const value = JSON.parse(r.value); return Array.isArray(value) ? value : []; })).toHaveLength(0);
  await cdp.detach();
});

test("library switches meaning/context views, remembers the mode, and preserves edits and legacy records", async ({ page }, testInfo) => {
  const f = await fixture(page, false);
  await page.evaluate(async (username) => {
    const db = await new Promise((resolve) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("unknown-words", "readwrite"), store = tx.objectStore("unknown-words");
      const metadata = { username, resourceId: "legacy", passageId: "legacy", passageLabel: "兼容验收", year: 2007, chapter: "兼容验收", occurrences: [] };
      store.put({ ...metadata, id: `${username}::legacy`, word: "legacy", normalizedWord: "legacy", meaning: "旧释义" });
      store.put({ ...metadata, id: `${username}::issue`, word: "issue", normalizedWord: "issue", meaning: "问题", senses: [
        { contextKey: "s1", sentence: "This issue matters.", meaning: "问题", meaningSource: "context-ai", occurrenceIds: [] },
        { contextKey: "s2", sentence: "They issue reports.", meaning: "发行", meaningSource: "context-ai", occurrenceIds: [] },
      ] });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }); db.close();
  }, f.username);
  await page.getByRole("button", { name: "← 资料库", exact: true }).click();
  await page.getByRole("button", { name: "陌生词库", exact: true }).click();
  const issue = page.locator(".unknown-word-card", { hasText: "issue" });
  await expect(issue.locator(".unknown-context-sense")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "只看释义", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".unknown-context-sentence")).toHaveCount(0);
  await expect(issue).toContainText("问题"); await expect(issue).toContainText("发行");
  const records = await readUnknown(page, f.username);
  await page.screenshot({ path: testInfo.outputPath("library-meaning.png") });
  await page.getByRole("button", { name: "显示语境", exact: true }).click();
  await expect(issue).toContainText("This issue matters.");
  await expect(issue).toContainText("They issue reports.");
  expect(await readUnknown(page, f.username)).toEqual(records);
  await page.screenshot({ path: testInfo.outputPath("library-context.png") });
  await page.reload();
  await page.locator(".reader-page, .library-page").first().waitFor();
  if (await page.locator(".reader-page").isVisible()) await page.getByRole("button", { name: "← 资料库", exact: true }).click();
  await page.getByRole("button", { name: "陌生词库", exact: true }).click();
  await expect(page.getByRole("button", { name: "显示语境", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(issue).toContainText("This issue matters.");
  await page.getByRole("button", { name: "只看释义", exact: true }).click();
  await expect(page.locator(".unknown-context-sentence")).toHaveCount(0);
  expect(await readUnknown(page, f.username)).toEqual(records);
  page.once("dialog", (dialog) => dialog.accept("人工问题义"));
  await issue.locator(".unknown-context-sense").first().click();
  await expect(issue).toContainText("人工问题义"); await expect(issue).toContainText("发行");
  const legacy = page.locator(".unknown-word-card", { hasText: "legacy" });
  page.once("dialog", (dialog) => dialog.accept("旧义编辑"));
  await legacy.locator("button.unknown-word-copy").click();
  await expect(legacy).toContainText("旧义编辑");
  page.once("dialog", (dialog) => dialog.accept()); await legacy.locator(".unknown-word-delete").click();
  await expect(legacy).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept()); await issue.locator(".unknown-word-delete").click();
  await expect(issue).toHaveCount(0);
  expect(await readUnknown(page, f.username)).toHaveLength(0);
  expect(f.errors).toEqual([]);
});
