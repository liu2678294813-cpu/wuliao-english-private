import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createAccount, openOfficialResource, clickStageAdvance } from "./helpers.js";

const title = "2013 英语（一）Text 1";
async function reopen(page) {
  await page.reload(); await page.locator(".library-page").waitFor();
  await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
  await page.locator(".resource-card", { hasText: title }).first().locator(".resource-open").click();
  await expect(page.locator("#deep-translation")).toBeVisible();
}
async function prepare(page, count, fallback) {
  const username = await createAccount(page);
  await openOfficialResource(page, title); await clickStageAdvance(page, "开始精读");
  await page.evaluate(({ username, count }) => {
    const flowKey = Object.keys(localStorage).find(key => key.includes("wuliao:reading-flow:"));
    const flow = JSON.parse(localStorage.getItem(flowKey));
    for (const stage of ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz"]) flow.stages[stage] = { status: "completed", completedAt: 100 };
    flow.currentStage = "deep-translation"; flow.stages["deep-translation"] = { status: "current", completedAt: null };
    flow.timedReading = { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: 100 };
    localStorage.setItem(flowKey, JSON.stringify(flow));
    const key = `wuliao:deep-ink:v2:${flow.resourceId}:${flow.passageId}:deep-translation`;
    const strokes = Array.from({ length: count }, (_, i) => ({ tool: "pen", engine: "direct-ink", color: "#173a62", width: 2.6,
      points: Array.from({ length: 16 }, (_, j) => ({ x: .04 + (i % 12) * .07 + j * .0015, y: .04 + (i % 100) * .009 + Math.sin(j / 3) * .0005, pressure: .5 })) }));
    // This is a newly created, isolated test account's legacy entry. Reload
    // exercises the actual preserving hydration path before rendering it.
    localStorage.setItem(`wuliao:user:${encodeURIComponent(username)}:${key}`, JSON.stringify(strokes));
  }, { username, count });
  if (fallback) await page.addInitScript(() => { window.Worker = undefined; });
  await reopen(page);
  await expect.poll(() => page.evaluate(() => window.__deepInkRenderStats?.().strokes)).toBe(count);
  return username;
}

for (const { count, fallback } of [{ count: 500 }, { count: 2000 }, { count: 5000 }, { count: 500, fallback: true }]) {
  test(`ink session: ${count} strokes, cached scroll and new ink survive restart${fallback ? " without Worker" : ""}`, async ({ page }, testInfo) => {
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const username = await prepare(page, count, fallback);
    await page.locator("#deep-translation .translation-paragraph").first().scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => window.__deepInkRenderStats().scratchBytes)).toBe(0);
    await page.evaluate(() => {
      window.__cacheClears = new Map(); window.__cacheParses = 0;
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function(...args) {
        if (this.canvas.classList.contains("deep-ink-tile")) window.__cacheClears.set(this.canvas, (window.__cacheClears.get(this.canvas) || 0) + 1);
        return clear.apply(this,args);
      };
      const parse = JSON.parse;
      JSON.parse = function(value, ...args) { if (typeof value === "string" && value.startsWith("[{") && value.includes('"points"')) window.__cacheParses++; return parse.call(this,value,...args); };
      window.__warmScrollY = scrollY;
    });
    // Warm two nearby viewport windows, then check the second round does not
    // replay history or parse the complete ink again.
    const warmY = await page.evaluate(() => window.__warmScrollY);
    for (const top of [Math.max(0, warmY - 1400), warmY]) {
      await page.evaluate(top => window.scrollTo(0,top), top);
      await page.waitForTimeout(350);
      await expect.poll(() => page.evaluate(() => window.__deepInkRenderStats().scratchBytes)).toBe(0);
    }
    const before = await page.evaluate(() => ({ parses: window.__cacheParses,
      clears: [...window.__cacheClears.values()].reduce((sum,n)=>sum+n,0), stats: window.__deepInkRenderStats() }));
    for (const top of [Math.max(0, warmY - 1400), warmY]) {
      await page.evaluate(top => window.scrollTo(0,top), top); await page.waitForTimeout(250);
    }
    const after = await page.evaluate(() => ({ parses: window.__cacheParses,
      clears: [...window.__cacheClears.values()].reduce((sum,n)=>sum+n,0), stats: window.__deepInkRenderStats() }));
    expect(after.parses).toBe(before.parses);
    expect(after.clears).toBe(before.clears);
    await page.locator(".deep-reader-content").evaluate(element => {
      const rect = element.getBoundingClientRect(), x = rect.left + 42, y = Math.max(260,rect.top + 100);
      for (const [type, dy] of [["pointerdown",0],["pointermove",15],["pointermove",30],["pointerup",30]]) element.dispatchEvent(new PointerEvent(type,
        { bubbles:true,cancelable:true,pointerId:917,pointerType:"pen",isPrimary:true,button:0,buttons:type==="pointerup"?0:1,pressure:.5,clientX:x,clientY:y+dy }));
    });
    await expect.poll(() => page.evaluate(() => window.__deepInkRenderStats().strokes)).toBe(count + 1);
    await page.waitForTimeout(150);
    await page.screenshot({ path: testInfo.outputPath("reader-ink.png") });
    if (count === 2000) await page.screenshot({ path: "artifacts/long-sentence-ink-20261017/reader-2000-strokes.png" });
    await reopen(page);
    await expect.poll(() => page.evaluate(() => window.__deepInkRenderStats().strokes)).toBe(count + 1);
    expect(errors).toEqual([]);
    await writeFile(testInfo.outputPath("cache-result.json"), JSON.stringify({ username, count, fallback: Boolean(fallback), before, after, restartCount: count + 1, errors },null,2));
  });
}
