// Real Android WebView acceptance. Synthetic CDP pen is explicitly not hardware
// pressure/palm-rejection/latency evidence. Production learning data is read only;
// all exercised learning actions use a new local QA account, restored in finally.
import { chromium, expect as playwrightExpect } from "@playwright/test";
import { CRBrowserContext } from "../node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/lib/server/chromium/crBrowser.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

const [serial, folder = "output/android-compat-20261008/device"] = process.argv.slice(2);
const expect = playwrightExpect.configure({ timeout: 20000 });
if (!serial) throw Error("An explicit adb serial is required");
const root = resolve("."), out = resolve(folder), rel = relative(resolve("output"), out);
if (rel.startsWith("..") || isAbsolute(rel)) throw Error("Evidence must stay inside project output");
mkdirSync(out, { recursive: true });
const adb = resolve(".android-sdk/platform-tools/adb.exe"), packageId = "com.wuliao.english";
const raw = (...args) => execFileSync(adb, ["-s", serial, ...args], { windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
const run = (...args) => raw(...args).toString("utf8").trim();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const report = { environment: "physical Android WebView", checks: [], status: "NOT_RUN", errors: [],
  penBoundary: "CDP synthetic pen only; physical M-Pencil pressure, palm rejection and latency NOT_RUN" };
const settings = Object.fromEntries(["accelerometer_rotation", "user_rotation", "font_scale"].map((name) => [name, run("shell", "settings", "get", "system", name)]));
const pid = run("shell", "pidof", packageId).split(/\s+/)[0];
run("forward", "tcp:9336", `localabstract:webview_devtools_remote_${pid}`);
// Huawei WebView 114 lacks Browser.setDownloadBehavior; use the established
// project CDP bridge workaround while keeping normal page/input APIs.
const initialize = CRBrowserContext.prototype._initialize;
CRBrowserContext.prototype._initialize = function () {
  this._options.acceptDownloads = "internal-browser-default";
  return initialize.call(this);
};
let browser, page, originalUser, originalFacts, cdp;

async function userFacts(user) {
  const facts = await page.evaluate(async (user) => {
    const digest = async (row) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(row))))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const prefix = `wuliao:user:${encodeURIComponent(user)}:`;
    const local = Object.fromEntries(Object.keys(localStorage).sort().filter((key) => key.startsWith(prefix)
      && /reading-flow:|deep-answers:|question-evidence:|translation-progress:|translation-text:|study-rank|cloze-progress:|cloze-flow:/.test(key))
      .map((key) => [key, localStorage.getItem(key)]));
    const databases = {};
    // Do not enumerate PDF/OCR caches or unscoped vendor databases: their binary
    // payloads can exhaust an older WebView when copied across the debug bridge.
    for (const { name } of (await indexedDB.databases()).filter(({ name }) => ["wuliao-english", "KaoyanVocabMemorizeDB"].includes(name))) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const stores = {};
      for (const storeName of db.objectStoreNames) {
        const indexes = db.transaction(storeName).objectStore(storeName).indexNames;
        if (!indexes.contains("username") && !indexes.contains("usernameList")) continue;
        const keys = await new Promise((resolve, reject) => {
          const store = db.transaction(storeName).objectStore(storeName);
          const r = store.indexNames.contains("username") ? store.index("username").getAllKeys(user)
            : store.index("usernameList").getAllKeys(IDBKeyRange.bound([user], [user, []]));
          r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
        });
        const rows = [];
        for (const key of keys) {
          const row = await new Promise((resolve, reject) => {
            const r = db.transaction(storeName).objectStore(storeName).get(key);
            r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
          });
          rows.push({ key, sha256: await digest(row) });
        }
        if (rows.length) stores[storeName] = rows;
      }
      db.close();
      if (Object.keys(stores).length) databases[name] = stores;
    }
    return { local, databases };
  }, user);
  return { local: hash(facts.local), databases: Object.fromEntries(Object.entries(facts.databases).map(([name, stores]) => [name,
    Object.fromEntries(Object.entries(stores).map(([name, rows]) => [name, { count: rows.length, sha256: hash(rows) }]))])) };
}

async function check(name, action) {
  const started = performance.now();
  await action();
  report.checks.push({ name, status: "PASS", durationMs: Math.round(performance.now() - started) });
}

async function navigate(label) {
  await page.locator(".ds-nav button:visible, .ds-bottom-nav button:visible").filter({ hasText: new RegExp(`^${label}$`) }).first().click();
}

async function screenshot(name) {
  // Android's compositor keeps rotating briefly after the WebView resize event.
  await page.waitForTimeout(1100);
  writeFileSync(resolve(out, `${name}.png`), raw("exec-out", "screencap", "-p"));
}

function dismissPasswordSavePrompt() {
  run("shell", "uiautomator", "dump", "/data/local/tmp/wuliao-compat-ui.xml");
  const xml = run("shell", "cat", "/data/local/tmp/wuliao-compat-ui.xml");
  if (!xml.includes("自动保存帐号密码") && !xml.includes("保存密码")) return;
  const node = xml.match(/<node\b[^>]*text="取消"[^>]*>/)?.[0];
  const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (bounds) run("shell", "input", "tap", String((+bounds[1] + +bounds[3]) / 2), String((+bounds[2] + +bounds[4]) / 2));
}

async function penStroke(surface) {
  const rect = await surface.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const x = Math.max(25, rect.x + Math.min(rect.width * .25, 180));
  const y = Math.min(viewport.height - 120, Math.max(180, rect.y + 100));
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, pointerType: "pen", force: .5 });
  for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + i * 4, y: y + i * 2, buttons: 1, pointerType: "pen", force: .5 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 48, y: y + 24, button: "left", buttons: 0, pointerType: "pen", force: 0 });
}

try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9336");
  page = browser.contexts().flatMap((context) => context.pages()).find((p) => p.url().startsWith("https://localhost"));
  if (!page) throw Error("Production WebView not found");
  page.setDefaultTimeout(25000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  cdp = await page.context().newCDPSession(page);
  report.phase = "read original account";
  originalUser = await page.evaluate(() => localStorage.getItem("kaoyan_vocab_current_user"));
  if (!originalUser) throw Error("Original signed-in account required; refusing to change unknown state");
  report.phase = "hash original account rows";
  originalFacts = await userFacts(originalUser);
  writeFileSync(resolve(out, "original-facts-before.json"), JSON.stringify(originalFacts, null, 2));
  report.android = run("shell", "getprop", "ro.build.version.release");
  report.api = run("shell", "getprop", "ro.build.version.sdk");
  report.webview = run("shell", "dumpsys", "webviewupdate");
  report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, userAgent: navigator.userAgent }));
  report.phase = "navigate to library";
  await page.goto("https://localhost/#/reading/library");
  await expect(page.locator(".library-page")).toBeVisible();
  report.phase = "switch to isolated QA account";
  await page.locator(".ds-settings:visible, .ds-mobile-settings:visible").first().click();
  await page.getByRole("button", { name: "切换账号", exact: true }).click();
  await page.getByRole("button", { name: "创建新账号", exact: true }).click();
  const qaUser = `compat-qa-${Date.now().toString(36)}`;
  await page.locator('input[autocomplete="username"]').fill(qaUser);
  await page.locator('input[type="password"]').nth(0).fill("isolated-compat-qa");
  await page.locator('input[type="password"]').nth(1).fill("isolated-compat-qa");
  await page.locator(".account-submit").click();
  await expect(page.locator(".home-page, .library-page").first()).toBeVisible();
  dismissPasswordSavePrompt();
  await navigate("首页");
  await expect(page.locator(".home-page")).toBeVisible();
  report.phase = "business checks";
  await check("home budget and learning archive", async () => {
    await page.getByRole("button", { name: "60 分钟", exact: true }).click();
    await page.getByRole("button", { name: "学习档案", exact: true }).click();
    await expect(page.getByRole("button", { name: "阅读档案", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭学习档案入口" }).click();
    await screenshot("home");
  });
  for (const label of ["词库", "筛查", "背诵", "复习", "写作", "长难句", "完形", "精读"]) {
    await check(`${label}: native WebView entry`, async () => {
      await navigate(label);
      if (["词库", "筛查", "背诵", "复习"].includes(label)) {
        await expect(page.frameLocator(".vocabulary-frame").locator("body")).not.toBeEmpty();
        if (label === "背诵") await expect(page.frameLocator(".vocabulary-frame").locator("#listSelect")).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await screenshot(`module-${label}`);
    });
  }
  await check("PDF and intensive reader load, synthetic pen persists through reload", async () => {
    await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
    await expect(page.locator(".reader-page")).toBeVisible({ timeout: 90000 });
    await page.getByRole("button", { name: "开始精读", exact: true }).click();
    await expect(page.locator(".deep-reader-content")).toBeVisible();
    await penStroke(page.locator(".deep-reader-content"));
    await expect(page.locator(".annotation-toolbar button", { hasText: "撤销" })).toBeEnabled();
    await screenshot("reader-ink");
    await page.reload();
    await expect(page.locator(".library-page")).toBeVisible();
    await page.locator(".resource-card", { hasText: "2007 英语（一）Text 1" }).first().locator(".resource-open").click();
    await expect(page.locator(".annotation-toolbar button", { hasText: "撤销" })).toBeEnabled();
  });
  await check("real Android rotations preserve reader and saved ink", async () => {
    run("shell", "settings", "put", "system", "accelerometer_rotation", "0");
    for (const rotation of [1, 0, 1, 0]) {
      run("shell", "settings", "put", "system", "user_rotation", String(rotation));
      await expect.poll(() => page.evaluate(() => innerWidth > innerHeight)).toBe(rotation === 1);
      await expect(page.locator(".annotation-toolbar button", { hasText: "撤销" })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await screenshot(`rotation-${rotation}`);
    }
  });
  await check("HOME/resume and Android low-memory notification", async () => {
    run("shell", "input", "keyevent", "KEYCODE_HOME");
    const trim = run("shell", "am", "send-trim-memory", packageId, "RUNNING_LOW");
    report.memoryPressure = { type: "Android trim notification; not a physically RAM-constrained device", response: trim };
    run("shell", "am", "start", "-W", "-n", `${packageId}/.MainActivity`);
    await expect(page.locator(".reader-page")).toBeVisible();
    await expect(page.locator(".annotation-toolbar button", { hasText: "撤销" })).toBeEnabled();
  });
  await check("hardware BACK closes reader to library", async () => {
    dismissPasswordSavePrompt();
    writeFileSync(resolve(out, "before-back-ui.xml"), raw("shell", "cat", "/data/local/tmp/wuliao-compat-ui.xml"));
    await page.evaluate(() => {
      const original = window.__wuliaoHandleHardwareBack;
      window.__compatBackCalls = [];
      window.__wuliaoHandleHardwareBack = () => {
        const handled = original();
        window.__compatBackCalls.push({ handled, at: Date.now() });
        return handled;
      };
    });
    run("shell", "input", "keyevent", "KEYCODE_BACK");
    report.hardwareBack = await page.evaluate(() => window.__compatBackCalls);
    await expect(page.locator(".library-page")).toBeVisible();
  });
  await check("writing offline session and typed draft survive WebView reload", async () => {
    await navigate("写作");
    await page.getByLabel("按年份筛选写作").selectOption("2023");
    await page.getByRole("button", { name: /查看 2023 年.*Writing A/ }).click();
    await page.locator(".writing-question-preview").getByRole("button", { name: "使用随应用范文", exact: true }).click();
    await expect(page.locator('[aria-label="当前阶段 W1"]')).toBeVisible();
    await page.getByRole("button", { name: "完成范文精读" }).click();
    const input = page.getByLabel("完整中文译文");
    await input.fill("兼容性隔离测试译文，不属于正式学习账号。");
    await input.click();
    await screenshot("writing-keyboard");
    report.ime = run("shell", "dumpsys", "input_method").split("\n").filter((line) => /mInputShown|mIsInputViewShown|mShowRequested/.test(line)).join("\n");
    await page.reload();
    await expect(page.getByLabel("完整中文译文")).toHaveValue("兼容性隔离测试译文，不属于正式学习账号。");
    await screenshot("writing-reloaded");
  });
  await check("TTS bridge invokes installed engine", async () => {
    expect(await page.evaluate(() => typeof window.AndroidSpeech?.speak)).toBe("function");
    const countStarts = () => (run("logcat", "-d", "--pid", pid, "-s", "WuliaoSpeech:I", "*:S").match(/started/g) || []).length;
    const beforeStarts = countStarts();
    await page.evaluate(() => window.AndroidSpeech.speak("compatibility"));
    await expect.poll(countStarts).toBeGreaterThan(beforeStarts);
    report.tts = "Native engine start observed; acoustic quality NOT_RUN";
  });
  expect(report.errors).toEqual([]);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.failure = error.message;
  if (page) await screenshot("failure").catch(() => {});
  process.exitCode = 1;
} finally {
  for (const [name, value] of Object.entries(settings)) {
    try {
      if (run("shell", "settings", "get", "system", name) === value) continue;
      if (value === "null") run("shell", "settings", "delete", "system", name);
      else run("shell", "settings", "put", "system", name, value);
    } catch (error) { report.restoreSettingsError = error.message; process.exitCode = 1; }
  }
  if (page && originalUser) {
    try {
      await page.evaluate((user) => { localStorage.setItem("kaoyan_vocab_current_user", user); history.replaceState(history.state, "", "/#/reading/library"); }, originalUser);
      await page.reload();
      report.originalAccountRestored = await page.evaluate(() => localStorage.getItem("kaoyan_vocab_current_user")) === originalUser;
      const after = await userFacts(originalUser);
      writeFileSync(resolve(out, "original-facts-after.json"), JSON.stringify(after, null, 2));
      report.originalLearningDataUnchanged = JSON.stringify(originalFacts) === JSON.stringify(after);
      if (!report.originalAccountRestored || !report.originalLearningDataUnchanged) throw Error("Original account/data comparison failed");
    } catch (error) { report.restorationFailure = error.message; report.status = "FAIL"; process.exitCode = 1; }
  }
  try {
    writeFileSync(resolve(out, "app-logcat.txt"), raw("logcat", "-d", "--pid", pid, "-t", "1500"));
    writeFileSync(resolve(out, "foreground.txt"), raw("shell", "dumpsys", "activity", "activities"));
  } catch { /* report retains the primary failure */ }
  writeFileSync(resolve(out, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length,
    originalAccountRestored: report.originalAccountRestored, originalLearningDataUnchanged: report.originalLearningDataUnchanged,
    failure: report.failure, restorationFailure: report.restorationFailure }));
  await cdp?.detach().catch(() => {});
  await browser?.close();
  try { run("forward", "--remove", "tcp:9336"); } catch { /* already removed */ }
}
