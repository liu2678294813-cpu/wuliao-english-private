import { test, expect } from '@playwright/test';
import { createAccount, navTo } from './helpers.js';

test('unified full build retains bundled content and the unified confusion workspace', async ({ page }) => {
  await createAccount(page);
  await expect(page.getByRole('button', { name: '导入', exact: true })).toBeVisible();
  for (const label of ['精读', '完形']) {
    await navTo(page, label);
    await expect(page.locator('.resource-card').first()).toBeVisible();
    await expect(page.locator('.library-count strong')).toHaveText(/^[1-9]\d*$/);
    await expect(page.getByRole('tablist', { name: '题库分类' })).toBeVisible();
  }
  await navTo(page, '写作');
  await expect(page.locator('.writing-question-bank')).toBeVisible();
  await expect(page.locator('.writing-imported-materials')).toContainText('请从首页导入');
  await navTo(page, '词库');
  const frame = page.frameLocator('.vocabulary-frame');
  await expect(frame.locator('.embedded-dashboard-actions button')).toHaveText(['混淆词', '词库']);
  await frame.getByRole('button', { name: '混淆词', exact: true }).click();
  await expect(frame.locator('.confusion-summary')).toContainText('共 0 条');
  await page.screenshot({ path: 'output/ai-cache-20261013/browser/full-content-confusion.png', fullPage: true });
});
