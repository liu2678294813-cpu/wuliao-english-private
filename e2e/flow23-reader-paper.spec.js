import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createAccount, openOfficialResource, uniqueUsername, readDurableInkEntries } from "./helpers.js";

async function geometry(page) {
  return page.locator(".deep-reader-content").evaluate((paper) => {
    const rect = paper.getBoundingClientRect();
    const scale = rect.width / paper.offsetWidth;
    return {
      width: paper.offsetWidth, height: paper.offsetHeight, scale,
      x: rect.x, y: rect.y, right: rect.right, scroll: window.scrollY,
      children: [...paper.querySelectorAll(".deep-paper h2, .deep-paper p")].filter((node) => node.getClientRects().length).map((node) => {
        const r = node.getBoundingClientRect();
        return [(r.x - rect.x) / scale, (r.y - rect.y) / scale, r.width / scale, r.height / scale];
      }),
    };
  });
}

async function settled(page) {
  await expect(page.locator(".deep-reader-content")).not.toHaveAttribute("data-paper-moving", "true");
  await page.waitForTimeout(40);
}

async function draw(page, points) {
  await page.locator(".deep-reader-content").evaluate(async (paper, points) => {
    const rect = paper.getBoundingClientRect();
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i];
      paper.dispatchEvent(new PointerEvent(i === 0 ? "pointerdown" : i === points.length - 1 ? "pointerup" : "pointermove", {
        bubbles: true, cancelable: true, pointerId: 77, pointerType: "pen", button: 0,
        buttons: i === points.length - 1 ? 0 : 1, pressure: .5,
        clientX: rect.left + x * rect.width, clientY: y,
      }));
      await new Promise(requestAnimationFrame);
    }
  }, points);
  await page.waitForTimeout(360);
}

async function storedInk(page, username) {
  return (await readDurableInkEntries(page, username)).filter(({ key }) => key.includes("wuliao:deep-ink:v2:")).map(({ key, value }) => [key, JSON.parse(value)]);
}

test("paper and ink keep one coordinate system through panel switching, writing and reversal", async ({ page }, testInfo) => {
  const evidenceDir = process.env.READER_QA_DIR;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1104, height: 720 });
  const username = await createAccount(page, uniqueUsername("paper"));
  await openOfficialResource(page, "2023 英语（一）Text 1");
  await page.getByRole("button", { name: "开始精读", exact: true }).click();
  // Unlock redo in this isolated test account, where answering in the drawer is allowed.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.includes("wuliao:reading-flow:"));
    const flow = JSON.parse(localStorage.getItem(key));
    let completed = true;
    for (const [id, stage] of Object.entries(flow.stages)) {
      if (id === "deep-redo") completed = false;
      stage.status = completed ? "completed" : id === "deep-redo" ? "current" : "pending";
    }
    flow.currentStage = "deep-redo";
    flow.timedReading.phase = "done";
    localStorage.setItem(key, JSON.stringify(flow));
  });
  await page.getByRole("button", { name: "← 资料库", exact: true }).click();
  await page.locator(".resource-card", { hasText: "2023 英语（一）Text 1" }).first().locator(".resource-open").click();
  await page.locator(".deep-reader-content").waitFor();
  await page.getByRole("button", { name: "手写批注" }).click();
  await settled(page);
  await draw(page, [[.2, 280], [.32, 280], [.45, 280]]);
  await draw(page, [[.25, 320], [.35, 310], [.4, 355], [.3, 365], [.26, 325]]);
  await draw(page, [[.55, 280], [.5, 340], [.6, 400]]);
  const saved = await storedInk(page, username);
  expect(saved.flatMap(([, strokes]) => strokes).length).toBeGreaterThanOrEqual(3);
  const before = await geometry(page);
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/before.png` });
  await page.locator(".question-fab").click();
  await settled(page);
  const opened = await geometry(page);
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/questions.png` });
  expect(opened.width).toBe(before.width);
  expect(opened.height).toBe(before.height);
  expect(opened.scale).toBeLessThan(1);
  expect(opened.right).toBeLessThanOrEqual((await page.locator(".reader-side-panel").boundingBox()).x - 15);
  expect(opened.children.length).toBe(before.children.length);
  opened.children.forEach((box, i) => box.forEach((value, j) => expect(Math.abs(value - before.children[i][j])).toBeLessThan(1)));
  expect(await storedInk(page, username)).toEqual(saved);

  await page.locator(".question-options button").first().click();
  await page.locator(".question-list").evaluate((node) => { node.scrollTop = 60; });
  const questionScroll = await page.locator(".question-list").evaluate((node) => node.scrollTop);
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await expect(page.locator(".ai-float-window")).toBeVisible();
  const input = page.locator(".ai-float-window textarea").last();
  await input.fill("保留这份草稿");
  if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/ai.png` });
  await page.getByRole("tab", { name: "习题", exact: true }).click();
  await expect(page.locator(".question-options button").first()).toHaveClass(/selected/);
  expect(await page.locator(".question-list").evaluate((node) => node.scrollTop)).toBe(questionScroll);
  expect((await geometry(page)).scale).toBe(opened.scale);
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await expect(input).toHaveValue("保留这份草稿");
  await page.getByRole("tab", { name: "习题", exact: true }).click();

  await draw(page, [[.25, 410], [.35, 420], [.45, 410]]);
  const afterWriting = await storedInk(page);
  expect(afterWriting.flatMap(([, strokes]) => strokes).length).toBe(saved.flatMap(([, strokes]) => strokes).length + 1);
  await page.getByRole("button", { name: "关闭题窗" }).click();
  await settled(page);
  expect((await geometry(page)).width).toBe(before.width);
  expect((await geometry(page)).scale).toBe(1);
  expect(await storedInk(page)).toEqual(afterWriting);
  await page.getByRole("button", { name: "撤销" }).click();
  await expect.poll(async () => (await storedInk(page)).flatMap(([, strokes]) => strokes).length).toBe(saved.flatMap(([, strokes]) => strokes).length);

  // Capture every frame during repeated full toggles and interrupted reversals.
  const metrics = await page.evaluate(async () => {
    const paper = document.querySelector(".deep-reader-content");
    const frames = [], longTasks = [];
    const inkBefore = { ...window.__inkHandoffStats };
    const scrollBefore = window.scrollY;
    const observer = new PerformanceObserver((entries) => longTasks.push(...entries.getEntries().map((entry) => entry.duration)));
    observer.observe({ type: "longtask" });
    let frame;
    const sample = (time) => {
      const r = paper.getBoundingClientRect();
      const child = [...paper.querySelectorAll(".deep-paper h2, .deep-paper p")].find((node) => node.getClientRects().length);
      const c = child.getBoundingClientRect();
      const s = r.width / paper.offsetWidth;
      frames.push({ time, width: paper.offsetWidth, height: paper.offsetHeight, localX: (c.x-r.x)/s, localY: (c.y-r.y)/s, tiles: paper.querySelectorAll(".deep-ink-tile").length });
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    for (let i = 0; i < 10; i++) {
      document.querySelector(".question-fab").click();
      await new Promise((resolve) => setTimeout(resolve, i % 2 ? 55 : 260));
      document.querySelector('[aria-label="关闭题窗"]').click();
      await new Promise((resolve) => setTimeout(resolve, i % 2 ? 70 : 260));
    }
    await new Promise((resolve) => setTimeout(resolve, 260));
    cancelAnimationFrame(frame);
    observer.disconnect();
    return { frames, longTasks, inkBefore, inkAfter: { ...window.__inkHandoffStats }, scrollBefore, scrollAfter: window.scrollY };
  });
  expect(metrics.frames.length).toBeGreaterThan(50);
  for (const frame of metrics.frames) {
    expect(frame.width).toBe(before.width);
    expect(frame.height).toBe(metrics.frames[0].height);
    expect(Math.abs(frame.localX - metrics.frames[0].localX)).toBeLessThan(1);
    expect(Math.abs(frame.localY - metrics.frames[0].localY)).toBeLessThan(1);
    expect(frame.tiles).toBeGreaterThan(0);
  }
  await testInfo.attach("paper-frame-metrics", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
  const gaps = metrics.frames.slice(1).map((frame, i) => frame.time - metrics.frames[i].time).sort((a,b) => a-b);
  console.log("paper performance", JSON.stringify({ p95: gaps[Math.floor(gaps.length*.95)], max: gaps.at(-1), longTasks: metrics.longTasks, inkBefore: metrics.inkBefore, inkAfter: metrics.inkAfter, scrollDelta: metrics.scrollAfter-metrics.scrollBefore }));
  if (evidenceDir) await writeFile(`${evidenceDir}/metrics.json`, JSON.stringify(metrics, null, 2));
  expect(metrics.longTasks).toEqual([]);
  expect(gaps[Math.floor(gaps.length*.95)]).toBeLessThan(34);
  expect(Math.abs(metrics.scrollAfter-metrics.scrollBefore)).toBeLessThanOrEqual(2);
  expect((await geometry(page)).scale).toBe(1);
  expect(await storedInk(page)).toEqual(saved);

  for (const viewport of [{ width: 820, height: 1180 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await settled(page);
    const closed = await geometry(page);
    await page.locator(".question-fab").click();
    await settled(page);
    const open = await geometry(page);
    expect(open.width).toBe(closed.width);
    expect(open.height).toBe(closed.height);
    if (viewport.width <= 760) expect(open.scale).toBe(1);
    const panel = await page.locator(".reader-side-panel").boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width);
    if (evidenceDir) await page.screenshot({ path: `${evidenceDir}/paper-${viewport.width}.png` });
    await testInfo.attach(`paper-${viewport.width}`, { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "关闭题窗" }).click();
    await settled(page);
  }
  await page.reload();
  await page.locator(".reader-page, .home-page, .library-page").first().waitFor();
  expect(await storedInk(page)).toEqual(saved);
  expect(errors).toEqual([]);
});

test("scaled ink preview lands on committed ink, and a panel waits for pen-up", async ({ page }) => {
  await page.setViewportSize({ width: 1104, height: 720 });
  await createAccount(page, uniqueUsername("paper-pointer"));
  await openOfficialResource(page, "2023 英语（一）Text 1");
  await page.getByRole("button", { name: "开始精读", exact: true }).click();
  await page.getByRole("button", { name: "手写批注" }).click();
  await settled(page);
  await page.locator(".question-fab").click();
  await settled(page);
  const result = await page.evaluate(async () => {
    const paper = document.querySelector(".deep-reader-content");
    const r = paper.getBoundingClientRect();
    const x = r.left + r.width * .4, y = 390;
    const dispatch = (type, clientX) => paper.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 98, pointerType: "pen", button: 0,
      buttons: type === "pointerup" ? 0 : 1, pressure: .5, clientX, clientY: y,
    }));
    const frame = () => new Promise(requestAnimationFrame);
    const alphaNear = (canvas, x, y) => {
      const ratio = Number(canvas.dataset.ratio) || 1;
      const bytes = canvas.getContext("2d").getImageData(Math.round(x*ratio)-3, Math.round(y*ratio)-3, 7, 7).data;
      return bytes.some((value, i) => i%4 === 3 && value > 30);
    };
    dispatch("pointerdown", x);
    dispatch("pointermove", x+60);
    await frame(); await frame();
    const previewCanvas = document.querySelector(".custom-viewport-ink-preview");
    const previewRect = previewCanvas.getBoundingClientRect();
    // The live band shares the paper transform: sample the screen point in its local bitmap grid.
    const previewScale = previewRect.width / parseFloat(previewCanvas.style.width);
    const preview = alphaNear(previewCanvas, (x+25-previewRect.left)/previewScale, (y-previewRect.top)/previewScale);
    document.querySelector('[aria-label="关闭题窗"]').click();
    await frame(); await frame();
    const waiting = document.querySelector('[role="tab"][aria-selected="true"]').textContent;
    const heldScale = paper.getBoundingClientRect().width / paper.offsetWidth;
    dispatch("pointerup", x+65);
    // Commit is synchronous, before the deferred panel switch can alter the pose.
    const scale = r.width / paper.offsetWidth;
    const localX = (x+25-r.left)/scale, localY = (y-r.top)/scale;
    const tile = [...paper.querySelectorAll(".deep-ink-tile")].find((node) => localY >= parseFloat(node.style.top) && localY < parseFloat(node.style.top)+parseFloat(node.style.height));
    const committed = tile && alphaNear(tile, localX, localY-parseFloat(tile.style.top));
    return { preview, committed, waiting, heldScale, initialScale: scale };
  });
  expect(result.preview).toBe(true);
  expect(result.committed).toBe(true);
  expect(result.waiting).toBe("习题");
  expect(result.heldScale).toBe(result.initialScale);
  await settled(page);
  await expect(page.locator(".reader-side-panel")).toHaveAttribute("data-motion-state", "closed");
  await expect.poll(async () => (await storedInk(page)).flatMap(([, strokes]) => strokes).length).toBe(1);

  await page.locator(".question-fab").click();
  await settled(page);
  await page.getByRole("button", { name: "橡皮", exact: true }).click();
  await page.getByRole("button", { name: "普通", exact: true }).click();
  const eraserStrokes = (await storedInk(page)).flatMap(([, strokes]) => strokes);
  const erased = await page.evaluate(async (strokes) => {
    const paper = document.querySelector(".deep-reader-content");
    const rect = paper.getBoundingClientRect();
    const point = strokes[0].points[1];
    const x = rect.left + point.x * rect.width, y = rect.top + point.y * rect.height;
    for (const type of ["pointerdown", "pointerup"]) paper.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 99, pointerType: "pen", button: 0,
      buttons: type === "pointerup" ? 0 : 1, pressure: .5, clientX: x, clientY: y,
    }));
    const localX = point.x * paper.offsetWidth, localY = point.y * paper.offsetHeight;
    const tile = [...paper.querySelectorAll(".deep-ink-tile")].find((node) => localY >= parseFloat(node.style.top) && localY < parseFloat(node.style.top)+parseFloat(node.style.height));
    const ratio = Number(tile.dataset.ratio);
    const bytes = tile.getContext("2d").getImageData(Math.round(localX*ratio)-2, Math.round((localY-parseFloat(tile.style.top))*ratio)-2, 5, 5).data;
    return bytes.every((value, i) => i%4 !== 3 || value === 0);
  }, eraserStrokes);
  expect(erased).toBe(true);
  await page.getByRole("button", { name: "撤销" }).click();
  await page.getByRole("button", { name: "关闭题窗" }).click();
  await settled(page);

  // Document boundaries must not cause a discontinuity when normalizing the transform.
  for (const fraction of [0, .5, 1]) {
    await page.evaluate((fraction) => window.scrollTo({ top: (document.documentElement.scrollHeight-innerHeight)*fraction, behavior: "instant" }), fraction);
    const jumps = await page.evaluate(async () => {
      const paper = document.querySelector(".deep-reader-content");
      const samples = [];
      let raf;
      const tick = () => {
        samples.push({ y: paper.getBoundingClientRect().top, moving: paper.dataset.paperMoving === "true" });
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      document.querySelector(".question-fab").click();
      await new Promise((resolve) => setTimeout(resolve, 320));
      document.querySelector('[aria-label="关闭题窗"]').click();
      await new Promise((resolve) => setTimeout(resolve, 320));
      cancelAnimationFrame(raf);
      return samples.slice(1).flatMap((sample, i) => !sample.moving && samples[i].moving ? [Math.abs(sample.y-samples[i].y)] : []);
    });
    expect(jumps.length).toBeGreaterThan(0);
    jumps.forEach((jump) => expect(jump).toBeLessThan(3));
  }
});
