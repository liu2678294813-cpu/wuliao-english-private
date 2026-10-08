// Standalone screenshot harness for the 无聊英语 frontend redesign.
// Uses its own browser context; never touches the user's real local data.
// Usage: node wuliao-shots.mjs <outDir> [tag]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "http://127.0.0.1:5173";
const outDir = resolve(process.argv[2] || "./wuliao-shots");
const tag = process.argv[3] || "shot";
mkdirSync(outDir, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1174, height: 736 },
  phone: { width: 390, height: 844 },
  narrow: { width: 360, height: 780 },
};

const PAGES = [
  { name: "account", path: "/", selector: ".account-card", noAccount: true },
  { name: "home", path: "/", selector: ".home-page" },
  { name: "library", path: "/#library", selector: ".library-page", nav: "精读" },
  { name: "cloze", path: "/", selector: ".library-page", nav: "完形" },
  { name: "exam", path: "/", selector: ".exam-library-page", nav: "模拟" },
  { name: "vocabulary", path: "/", selector: ".vocabulary-page", nav: "词库" },
  { name: "screening", path: "/", selector: ".vocabulary-page", nav: "筛查" },
];

async function createAccount(page) {
  await page.goto(`${BASE}/`, { waitUntil: "commit", timeout: 60000 });
  await page.locator(".account-card").waitFor({ state: "visible", timeout: 30000 });
  const username = `shot-${Date.now().toString(36)}`;
  await page.locator('input[autocomplete="username"]').fill(username);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill("shotpass123");
  await passwords.nth(1).fill("shotpass123");
  await page.locator(".account-submit").click();
  await page.locator(".home-page").waitFor({ timeout: 60000 });
  // Seed a little progress so home/library show realistic (not empty) states.
  await page.evaluate(() => {
    const user = localStorage.getItem("kaoyan_vocab_current_user")?.trim() || "";
    const p = `wuliao:user:${encodeURIComponent(user)}:`;
    const now = Date.now();
    const ids = [
      ["postgraduate-2023-text-1", "2023 英语（一）Text 1", 6, 15],
      ["postgraduate-2022-text-2", "2022 英语（一）Text 2", 15, 15],
      ["postgraduate-2021-text-3", "2021 英语（一）Text 3", 3, 15],
    ];
    const recent = {};
    ids.forEach(([id, title, page_, total], i) => {
      recent[`${p}wuliao:progress:${id}`] = JSON.stringify({
        id, title, page: page_, total, updatedAt: now - i * 3600_000,
      });
    });
    Object.entries(recent).forEach(([k, v]) => localStorage.setItem(k, v));
  });
  await page.reload({ waitUntil: "commit" });
  await page.locator(".home-page").waitFor({ timeout: 60000 });
  return username;
}

async function navTo(page, label, mobile) {
  // Phone hides the rail (<=760px) and navigates from the bottom bar instead.
  const scope = mobile ? ".ds-bottom-nav" : ".ds-rail .ds-nav";
  let btn = page.locator(`${scope} button`).filter({ hasText: label }).first();
  if (mobile && (await btn.count()) === 0) {
    // Bottom nav renders leaves only; the 阅读 group collapses to its children.
    btn = page.locator(".ds-bottom-nav button").filter({ hasText: label }).first();
  }
  await btn.waitFor({ state: "visible", timeout: 45000 });
  await btn.click();
  await page.waitForTimeout(1500);
}

const only = (process.argv[4] || "").split(",").filter(Boolean);
const entries = Object.entries(VIEWPORTS).filter(([name]) => !only.length || only.includes(name));
console.log(`viewports: ${entries.map(([n]) => n).join(", ")}`);

const browser = await chromium.launch({ channel: "chrome" });

for (const [vpName, viewport] of entries) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    storageState: undefined,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror ${vpName}] ${e.message.slice(0, 140)}`));

  let username = null;
  for (const spec of PAGES) {
    try {
      if (spec.noAccount) {
        await page.goto(`${BASE}/`, { waitUntil: "commit", timeout: 60000 });
        await page.locator(spec.selector).waitFor({ timeout: 30000 });
      } else {
        if (!username) username = await createAccount(page);
        const mobile = viewport.width <= 760;
        if (spec.path && spec.path !== "/") {
          await page.goto(`${BASE}${spec.path}`, { waitUntil: "commit", timeout: 90000 });
        } else if (!page.url().includes("127.0.0.1:5173")) {
          await page.goto(`${BASE}/`, { waitUntil: "commit" });
        }
        if (spec.nav) await navTo(page, spec.nav, mobile);
        await page.locator(spec.selector).waitFor({ timeout: 45000 });
        await page.waitForTimeout(900);
      }
      const file = resolve(outDir, `${tag}-${vpName}-${spec.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      console.log(`ok  ${vpName}/${spec.name}`);
    } catch (err) {
      console.log(`ERR ${vpName}/${spec.name}: ${String(err.message).split("\n")[0].slice(0, 150)}`);
    }
  }
  await context.close();
}

await browser.close();
console.log(`\nSaved to ${outDir}`);
