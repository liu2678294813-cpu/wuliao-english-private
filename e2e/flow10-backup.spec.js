import { test, expect } from "@playwright/test";
import { createAccount, setScopedJson, scopedKey } from "./helpers.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Flow 10：Backup 端到端 —— 导出 → 校验 manifest → 独立 context 恢复 →
// 数据可见 → 重复恢复幂等。全程使用测试账号，不触碰真实用户数据。

async function openSettings(page) {
  await page.locator(".ds-mobile-settings, .ds-settings").first().click();
  await page.locator(".settings-panel").waitFor({ state: "visible" });
}

test("备份：导出 → 恢复 → 幂等（独立 context 隔离）", async ({ browser }) => {
  // ---------- context A：造数据并导出 ----------
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const userA = await createAccount(pageA);
  const today = await pageA.evaluate(() => {
    const now = new Date();
    const pad = (v) => String(v).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  });
  await setScopedJson(pageA, userA, "wuliao:reading-flow:postgraduate-2007-text-1:passage-1", {
    schemaVersion: 1,
    resourceId: "postgraduate-2007-text-1",
    passageId: "passage-1",
    currentStage: "deep-cover",
    stages: {},
    updatedAt: Date.now(),
  });
  await setScopedJson(pageA, userA, "wuliao:study-plan:" + today, { budgetMinutes: 45, budgetConfirmed: true });
  await setScopedJson(pageA, userA, "wuliao:ai:learning-records", [{ id: "lr-e2e-1", tag: "translation" }]);
  await setScopedJson(pageA, userA, "wuliao:ai:apikey", "sk-should-not-export");

  await openSettings(pageA);
  const downloadPromise = pageA.waitForEvent("download");
  await pageA.locator(".settings-action", { hasText: "导出备份" }).click();
  const download = await downloadPromise;
  const dir = await mkdtemp(join(tmpdir(), "wuliao-backup-e2e-"));
  const backupPath = join(dir, "backup.json");
  await download.saveAs(backupPath);
  const backupText = await readFile(backupPath, "utf8");
  const manifest = JSON.parse(backupText);

  // manifest 校验：格式 / 版本 / 账号 / 不含 API Key
  expect(manifest.format).toBe("wuliao-backup");
  expect(manifest.version).toBe(1);
  expect(manifest.accounts[0].username).toBe(userA);
  expect(backupText).not.toContain("sk-should-not-export");
  expect(manifest.sections.localStorage.user.some((item) => item.key.includes("reading-flow"))).toBe(true);
  expect(manifest.sections.localStorage.user.some((item) => item.key.includes("study-plan"))).toBe(true);
  expect(manifest.sections.localStorage.user.some((item) => item.key.includes("ai:learning-records"))).toBe(true);

  const statusText = await pageA.locator(".settings-backup-status").innerText();
  expect(statusText).toContain("不含 API Key");
  await contextA.close();

  // ---------- context B：同名账号恢复（账号隔离的跨账号拒绝由单测覆盖） ----------
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await createAccount(pageB, userA);
  await openSettings(pageB);

  await pageB.locator(".settings-panel input[type='file']").setInputFiles(backupPath);
  await expect(pageB.locator(".settings-backup-status")).toContainText("备份有效", { timeout: 15000 });
  await expect(pageB.locator(".settings-action", { hasText: "确认恢复" })).toBeVisible();

  // 恢复后本地数据可见（learning-records 出现在首页学习档案/本地存储）
  pageB.once("dialog", (dialog) => dialog.accept());
  await pageB.locator(".settings-action", { hasText: "确认恢复" }).click();
  await expect(pageB.locator(".settings-backup-status")).toContainText("恢复完成", { timeout: 15000 });
  const restoredText = await pageB.locator(".settings-backup-status").innerText();
  expect(restoredText).toContain("补入");

  // API Key 绝不恢复
  const keysAfter = await pageB.evaluate(() => Object.keys(localStorage));
  expect(keysAfter.some((key) => key.includes("apikey"))).toBe(false);

  // 再次导入同一备份并恢复 → 幂等（补入 0 条）
  await pageB.locator(".settings-panel input[type='file']").setInputFiles(backupPath);
  await expect(pageB.locator(".settings-backup-status")).toContainText("备份有效", { timeout: 15000 });
  pageB.once("dialog", (dialog) => dialog.accept());
  await pageB.locator(".settings-action", { hasText: "确认恢复" }).click();
  await expect(pageB.locator(".settings-backup-status")).toContainText("恢复完成", { timeout: 15000 });
  const idempotentText = await pageB.locator(".settings-backup-status").innerText();
  expect(idempotentText).toMatch(/跳过已存在|全部已存在/);
  await contextB.close();
});
