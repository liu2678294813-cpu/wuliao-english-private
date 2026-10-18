import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createAccount, openOfficialResource, clickStageAdvance } from "./helpers.js";

const title = "2013 英语（一）Text 1";
async function reopen(page) {
  await page.reload(); await page.locator(".library-page").waitFor();
  await page.evaluate(() => { window.Capacitor.getPlatform = () => "android"; });
  await page.locator(".resource-card", { hasText: title }).first().locator(".resource-open").click();
  await expect(page.locator("#deep-translation")).toBeVisible();
  await page.locator(".deep-reader-content").evaluate(element => {
    element.dispatchEvent(new Event("reader-paper-will-layout"));
    element.style.minHeight = "9000px";
    element.dispatchEvent(new Event("reader-paper-layout"));
    window.dispatchEvent(new Event("resize"));
  });
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
    // The reader reapplies its saved position after 420ms. In the faster
    // no-Worker path, that restore must finish before warming remote tiles.
    await page.waitForTimeout(500);
    await page.locator("#deep-translation .translation-paragraph").first().scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => window.__deepInkRenderStats().scratchBytes)).toBe(0);
    // Use two explicit paper positions. The reader can restore scroll after
    // opening; a paragraph that is already visible does not guarantee a remote
    // viewport has ever existed, especially during dense-history startup.
    const requestedY = await page.locator(".deep-reader-content").evaluate(element => Math.round(Math.min(
      scrollY + element.getBoundingClientRect().top + Math.min(3500, Math.max(0, element.offsetHeight - 800)),
      document.documentElement.scrollHeight - innerHeight)));
    await page.evaluate(top => window.scrollTo(0, top), requestedY);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(requestedY);
    await page.waitForTimeout(350);
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
      if (top !== warmY) await page.evaluate(() => { window.__priorInkTiles = [...document.querySelectorAll(".deep-ink-tile")]; });
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
    const retained = await page.locator(".deep-reader-content").evaluate(element => {
      const rect = element.getBoundingClientRect(), x = rect.left + 42, y = Math.max(260,rect.top + 100);
      const localY = (y - rect.top) * element.offsetHeight / rect.height;
      const unaffected = (window.__priorInkTiles || []).filter(canvas => !canvas.isConnected && Math.abs(parseFloat(canvas.style.top) - localY) > 1600);
      for (const [type, dy] of [["pointerdown",0],["pointermove",15],["pointermove",30],["pointerup",30]]) element.dispatchEvent(new PointerEvent(type,
        { bubbles:true,cancelable:true,pointerId:917,pointerType:"pen",isPrimary:true,button:0,buttons:type==="pointerup"?0:1,pressure:.5,clientX:x,clientY:y+dy }));
      return { tested: unaffected.length, preserved: unaffected.filter(canvas => canvas.width > 0 && canvas.height > 0).length,
        localY, priorTiles: (window.__priorInkTiles || []).map(canvas => ({ top: parseFloat(canvas.style.top), connected: canvas.isConnected })) };
    });
    await writeFile(testInfo.outputPath("cache-probe.json"), JSON.stringify({ warmY, before, after, retained }, null, 2));
    expect(retained.tested).toBeGreaterThan(0);
    expect(retained.preserved).toBe(retained.tested);
    await expect.poll(() => page.evaluate(() => window.__deepInkRenderStats().strokes)).toBe(count + 1);
    await page.waitForTimeout(150);
    await page.screenshot({ path: testInfo.outputPath("reader-ink.png") });
    if (count === 2000) await page.screenshot({ path: "artifacts/long-sentence-ink-20261017/reader-2000-strokes.png" });
    await reopen(page);
    await expect.poll(() => page.evaluate(() => window.__deepInkRenderStats().strokes)).toBe(count + 1);
    expect(errors).toEqual([]);
    const evidence = JSON.stringify({ username, count, fallback: Boolean(fallback), warmY, before, after, retained, restartCount: count + 1, errors },null,2);
    await writeFile(testInfo.outputPath("cache-result.json"), evidence);
    await writeFile(`artifacts/long-sentence-ink-20261017/ink-${count}${fallback ? "-fallback" : ""}.json`, evidence);
  });
}
