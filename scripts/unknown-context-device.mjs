import { chromium, expect } from "@playwright/test";
import { CRBrowserContext } from "../node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/lib/server/chromium/crBrowser.js";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const [mode, folder, serial = "7VXYD24229201695"] = process.argv.slice(2);
const out = resolve(folder), adb = resolve(".android-sdk/platform-tools/adb.exe");
const run = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", windowsHide: true }).trim();
const pid = run("shell", "pidof", "com.wuliao.english").split(/\s+/)[0];
run("forward", "tcp:9334", `localabstract:webview_devtools_remote_${pid}`);
const originalInitialize = CRBrowserContext.prototype._initialize;
CRBrowserContext.prototype._initialize = function () { this._options.acceptDownloads = "internal-browser-default"; return originalInitialize.call(this); };
const browser = await chromium.connectOverCDP("http://127.0.0.1:9334");
const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("https://localhost"));
if (!page) throw Error("Production WebView page not found");
page.setDefaultTimeout(20000);
const hash = (text) => createHash("sha256").update(text).digest("hex");

async function snapshot() {
  const facts = await page.evaluate(async () => {
    const username = localStorage.getItem("kaoyan_vocab_current_user"), prefix = `wuliao:user:${encodeURIComponent(username)}:`;
    const local = Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith(prefix) && /reading-flow:|deep-answers:|question-evidence:|translation-progress:|translation-text:|study-rank/.test(key)).map((key) => [key, localStorage.getItem(key)]));
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const stores = {};
    for (const name of db.objectStoreNames) {
      stores[name] = await new Promise((resolve, reject) => { const store = db.transaction(name).objectStore(name); const r = store.indexNames.contains("username") ? store.index("username").count(username) : store.count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    }
    db.close(); return { username, url: location.href, local, stores };
  });
  return { username: facts.username, url: facts.url, pid,
    local: Object.fromEntries(Object.entries(facts.local).map(([key, value]) => [key, hash(value)])),
    stores: Object.fromEntries(Object.entries(facts.stores).map(([key, count]) => [key, { count }])) };
}

const report = { mode, device: serial, pid, checks: [], errors: [] };
try {
  if (mode === "before" || mode === "after") {
    const facts = await snapshot();
    writeFileSync(resolve(out, `device-${mode}.json`), JSON.stringify(facts, null, 2));
    if (mode === "after") {
      const before = JSON.parse(readFileSync(resolve(out, "device-before.json"), "utf8"));
      expect(facts.username).toBe(before.username);
      expect(facts.stores).toEqual(before.stores);
      for (const [key, value] of Object.entries(before.local)) expect(facts.local[key]).toBe(value);
    }
    console.log(JSON.stringify({ mode, originalAccountPresent: !!facts.username, stores: Object.fromEntries(Object.entries(facts.stores).map(([key, value]) => [key, value.count])), status: "passed" }));
  } else if (mode === "smoke") {
    page.on("pageerror", (error) => report.errors.push(error.message));
    const original = JSON.parse(readFileSync(resolve(out, "device-before.json"), "utf8"));
    report.originalAccount = original.username;
    report.account = `unknown-tabletqa-${Date.now().toString(36)}`;
    let calls = 0;
    await page.route("**/chat/completions", (route) => { calls++; return route.fulfill({ json: { choices: [{ message: { content: "本句语境测试义" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }); });
    // Switch through the real UI; all new facts belong to an isolated account.
    if (await page.locator(".reader-page").isVisible()) await page.getByRole("button", { name: "← 资料库", exact: true }).click();
    const settings = page.getByRole("button", { name: "设置", exact: true });
    if (await settings.isVisible()) await settings.click();
    else await page.getByRole("button", { name: "打开设置", exact: true }).click();
    await page.getByRole("button", { name: "切换账号", exact: true }).click();
    await page.getByRole("button", { name: "创建新账号", exact: true }).click();
    await page.locator('input[autocomplete="username"]').fill(report.account);
    await page.locator('input[type="password"]').nth(0).fill("isolated-qa-123");
    await page.locator('input[type="password"]').nth(1).fill("isolated-qa-123");
    await page.locator(".account-submit").click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("kaoyan_vocab_current_user"))).toBe(report.account);
    await page.locator(".home-page, .library-page").first().waitFor();
    const nav = page.locator(".ds-rail .ds-nav button", { hasText: "精读" }).first();
    if (await nav.isVisible()) await nav.click();
    else await page.getByRole("button", { name: /精读/ }).first().click();
    await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
    await page.locator(".reader-page").waitFor({ timeout: 90000 });
    await page.getByRole("button", { name: "开始精读", exact: true }).click();
    await page.evaluate((user) => {
      const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
      const key = Object.keys(localStorage).find((key) => key.startsWith(`${prefix}wuliao:reading-flow:`));
      const flow = JSON.parse(localStorage.getItem(key));
      const stages = ["deep-cover", "deep-first-read", "deep-clean-text", "deep-first-quiz", "deep-translation", "deep-redo", "deep-review"];
      stages.forEach((id, index) => { flow.stages[id] = { status: index < 4 ? "completed" : index === 4 ? "current" : "pending", completedAt: index < 4 ? 100 : null }; });
      flow.currentStage = "deep-translation"; flow.timedReading = { phase: "done", elapsedMs: 1000, startedAt: null, pausedAt: null, completedAt: 100 };
      localStorage.setItem(key, JSON.stringify(flow));
      localStorage.setItem(`${prefix}wuliao:ai:apikey`, "isolated-mock-key");
    }, report.account);
    await page.reload();
    await page.locator(".reader-page, .library-page").first().waitFor({ timeout: 90000 });
    if (await page.locator(".library-page").isVisible()) await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
    await page.locator(".reader-page").waitFor({ timeout: 90000 });
    // The reader reapplies its saved scroll position at 420ms after mount.
    // Wait for that existing lifecycle before choosing device input coordinates.
    await page.waitForTimeout(650);
    const cdp = await page.context().newCDPSession(page);
    async function tokens() {
      const scope = page.locator(".sentence-source [data-unknown-scope]").first();
      return scope.evaluate(async (element) => {
        await document.fonts.ready;
        element.scrollIntoView({ block: "center", behavior: "instant" });
        let lastTop = null, stable = 0;
        for (let frame = 0; frame < 120 && stable < 8; frame++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const top = element.getBoundingClientRect().top;
          stable = top === lastTop ? stable + 1 : 0; lastTop = top;
        }
        element.scrollIntoView({ block: "center", behavior: "instant" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const result = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const match of node.data.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)) {
          const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          const r = range.getBoundingClientRect(); result.push({ word: match[0], x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
        }
        return result;
      });
    }
    async function rows() {
      return page.evaluate(async (user) => {
        const db = await new Promise((resolve) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); });
        const records = await new Promise((resolve) => { const r = db.transaction("unknown-words").objectStore("unknown-words").index("username").getAll(user); r.onsuccess = () => resolve(r.result); });
        db.close(); return records;
      }, report.account);
    }
    async function pen(path) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: path[0].x, y: path[0].y, button: "left", buttons: 1, pointerType: "pen", force: 0.5 });
      for (const point of path.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, buttons: 1, pointerType: "pen", force: 0.5 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: path.at(-1).x, y: path.at(-1).y, button: "left", buttons: 0, pointerType: "pen", force: 0 });
    }
    const point = (await tokens())[3];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await rows()).length).toBe(1);
    await expect.poll(async () => (await rows())[0]?.senses[0].meaningSource).toBe("context-ai");
    report.checks.push({ name: "device touch add + contextual AI mock", status: "passed" });
    const cancelPoint = (await tokens())[3];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cancelPoint.x, y: cancelPoint.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await rows()).length).toBe(0);
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBe(0);
    await page.reload();
    await page.locator(".reader-page, .library-page").first().waitFor({ timeout: 90000 });
    if (await page.locator(".library-page").isVisible()) await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
    await page.locator(".reader-page").waitFor({ timeout: 90000 });
    await page.waitForTimeout(650);
    expect(await rows()).toHaveLength(0);
    report.checks.push({ name: "tap cancels word and highlight; reload remains cancelled", status: "passed" });
    const readd = (await tokens())[3];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: readd.x, y: readd.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await rows()).length).toBe(1);
    await page.locator(".annotation-toolbar").getByRole("button", { name: "陌生词", exact: true }).click();
    const selected = (await tokens()).slice(2, 5);
    await pen([selected[2], selected[0]]);
    await expect.poll(async () => (await rows()).find((row) => row.normalizedWord.includes(" "))?.occurrences.length).toBe(3);
    report.checks.push({ name: "synthetic reverse sparse pen phrase", status: "passed" });
    const writing = page.locator(".translation-unit textarea").first();
    const box = await writing.evaluate(async (element) => {
      element.scrollIntoView({ block: "center", behavior: "instant" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = element.getBoundingClientRect(); return { x: r.left + 40, y: r.top + 20 };
    });
    await pen([box, { x: box.x + 60, y: box.y + 15 }]);
    await expect(page.locator(".annotation-toolbar").getByRole("button", { name: "笔", exact: true })).toHaveClass(/active/);
    await expect.poll(async () => page.evaluate(async (user) => {
      const db = await new Promise((resolve) => { const r = indexedDB.open("wuliao-english"); r.onsuccess = () => resolve(r.result); });
      const records = await new Promise((resolve) => { const r = db.transaction("reader-ink").objectStore("reader-ink").index("username").getAll(user); r.onsuccess = () => resolve(r.result); });
      db.close(); return records.some((row) => JSON.parse(row.value).length > 0);
    }, report.account)).toBe(true);
    report.checks.push({ name: "unknown to pen, same stroke persisted", status: "passed" });
    await expect(page.getByText("笔迹已保存", { exact: true })).toHaveCount(0);
    report.checks.push({ name: "saved message hidden", status: "passed" });
    await page.screenshot({ path: resolve(out, "tablet-writing.png") });
    await page.reload();
    await page.locator(".reader-page, .library-page").first().waitFor({ timeout: 90000 });
    if (await page.locator(".library-page").isVisible()) await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
    await page.locator(".sentence-source [data-unknown-scope]").first().waitFor({ timeout: 90000 });
    await expect.poll(async () => (await rows()).length).toBe(2);
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBeGreaterThan(0);
    report.checks.push({ name: "device reload retains terms and saved highlights", status: "passed" });
    await page.getByRole("button", { name: "← 资料库", exact: true }).click();
    await page.locator(".unknown-library-button").click();
    await expect(page.locator(".unknown-word-card strong").filter({ hasText: new RegExp(`^${selected.map((t) => t.word).join(" ")}$`) })).toHaveCount(1);
    const switcher = page.getByRole("group", { name: "词库显示方式", exact: true });
    await expect(switcher.getByRole("button", { name: "只看释义", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".unknown-context-sentence")).toHaveCount(0);
    const savedTerms = await rows();
    await page.screenshot({ path: resolve(out, "tablet-library-meaning.png") });
    await switcher.getByRole("button", { name: "显示语境", exact: true }).click();
    await expect(page.locator(".unknown-context-sentence")).toHaveCount(2);
    expect(await rows()).toEqual(savedTerms);
    await page.screenshot({ path: resolve(out, "tablet-library-context.png") });
    await page.reload();
    await page.locator(".reader-page, .library-page").first().waitFor({ timeout: 90000 });
    if (await page.locator(".reader-page").isVisible()) await page.getByRole("button", { name: "← 资料库", exact: true }).click();
    await page.locator(".unknown-library-button").click();
    await expect(switcher.getByRole("button", { name: "显示语境", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".unknown-context-sentence")).toHaveCount(2);
    await switcher.getByRole("button", { name: "只看释义", exact: true }).click();
    await expect(page.locator(".unknown-context-sentence")).toHaveCount(0);
    expect(await rows()).toEqual(savedTerms);
    report.checks.push({ name: "meaning/context switch preserves terms and remembers preference after reload", status: "passed" });
    report.checks.push({ name: "library word and phrase visible", status: "passed" });
    await page.locator(".ds-rail .ds-nav button", { hasText: "精读" }).first().click();
    await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
    await page.locator(".reader-page").waitFor({ timeout: 90000 });
    await page.waitForTimeout(650);
    const constituent = (await tokens())[3];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: constituent.x, y: constituent.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await rows()).length).toBe(0);
    await expect.poll(() => page.evaluate(() => CSS.highlights.get("wuliao-unknown-words")?.size || 0)).toBe(0);
    report.checks.push({ name: "tap phrase constituent cancels overlapping word and entire phrase", status: "passed" });
    report.ai = { mocked: true, calls, realProvider: "not called in isolated QA account" };
    report.pen = "CDP synthetic pen; physical M-Pencil not controlled";
    expect(report.errors).toEqual([]);
    await cdp.detach();
  } else throw Error("Unknown mode");
} catch (error) {
  report.fatal = error.message;
  await page.screenshot({ path: resolve(out, "tablet-failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (mode === "smoke") {
    const before = JSON.parse(readFileSync(resolve(out, "device-before.json"), "utf8"));
    await page.unroute("**/chat/completions").catch(() => {});
    await page.evaluate((user) => { localStorage.setItem("kaoyan_vocab_current_user", user); history.replaceState(history.state, "", "/#/reading/library"); }, before.username);
    await page.reload();
    report.originalAccountRestored = await page.evaluate(() => localStorage.getItem("kaoyan_vocab_current_user")) === before.username;
    const after = await snapshot();
    expect(after.stores).toEqual(before.stores);
    for (const [key, value] of Object.entries(before.local)) expect(after.local[key]).toBe(value);
    writeFileSync(resolve(out, "device-after-smoke.json"), JSON.stringify(after, null, 2));
  }
  writeFileSync(resolve(out, `device-${mode}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
}
