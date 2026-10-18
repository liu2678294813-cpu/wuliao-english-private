import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createAccount, navTo, openOfficialResource } from './helpers.js';

const evidence = 'artifacts/ui-refresh-20261018/screens';
async function shot(page, name) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${name}.png` });
}

test('quiet UI: all navigation, aligned home actions, compact pages and isolated persistence', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await createAccount(page);
  await expect(page.locator('.overview-metrics article')).toHaveCount(6);
  const date = await page.locator('.home-greeting time').boundingBox();
  const archive = await page.getByRole('button', { name: '学习档案', exact: true }).boundingBox();
  expect(Math.abs(date.y + date.height / 2 - archive.y - archive.height / 2)).toBeLessThanOrEqual(2);
  expect(date.x + date.width).toBeLessThan(archive.x);
  await page.getByRole('button', { name: '60 分钟', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '60 分钟', exact: true })).toHaveClass('active');
  await shot(page, '01-home');
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await expect(page.locator('#unified-import-panel')).toBeVisible();
  await shot(page, '22-import');
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('button', { name: '学习档案', exact: true }).click();
  await expect(page.getByRole('button', { name: '阅读档案', exact: true })).toBeVisible();
  await shot(page, '24-archive');
  await page.getByRole('button', { name: '关闭学习档案入口' }).click();
  for (const [label, selector, file] of [
    ['精读', '.library-page', '02-reading-library'],
    ['完形', '.library-page', '04-cloze-library'],
    ['长难句', '.long-sentence-page', '07-long-sentences'],
    ['写作', '.writing-library', '09-writing'],
    ['词库', '.vocabulary-frame.loaded', '13-vocabulary'],
    ['筛查', '.vocabulary-frame.loaded', '15-screening'],
    ['背诵', '.vocabulary-frame.loaded', '16-memorize'],
    ['复习', '.vocabulary-frame.loaded', '17-review'],
  ]) {
    await navTo(page, label); await expect(page.locator(selector)).toBeVisible();
    if (label === '背诵') await expect(page.frameLocator('.vocabulary-frame').locator('.word-row').first()).toBeVisible();
    if (label === '词库') await expect(page.frameLocator('.vocabulary-frame').locator('main')).toContainText('总词汇量');
    await shot(page, file);
    if (label === '写作') {
      const allCount = await page.locator('.writing-question-card').count();
      await page.getByRole('button', { name: '小作文', exact: true }).click();
      const smallCount = await page.locator('.writing-question-card').count();
      expect(smallCount).toBeGreaterThan(0); expect(smallCount).toBeLessThan(allCount);
      await page.getByRole('button', { name: '大作文', exact: true }).click();
      expect(await page.locator('.writing-question-card').count() + smallCount).toBe(allCount);
      await page.getByRole('button', { name: '全部', exact: true }).click();
      await page.getByRole('combobox', { name: '按作文题材筛选' }).selectOption('notice');
      await expect(page.locator('.writing-question-card').first()).toContainText('通知');
      await page.getByRole('combobox', { name: '按作文题材筛选' }).selectOption('all');
      await expect(page.locator('.writing-question-card')).toHaveCount(allCount);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.locator('.ds-settings').click();
  await expect(page.locator('.settings-panel')).toBeVisible(); await shot(page, '25-settings');
  expect(await page.locator('.settings-header h2').evaluate(e => getComputedStyle(e).color)).toBe('rgb(37, 43, 48)');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.locator('.ds-ai-api').click();
  await expect(page.locator('.ai-api-modal')).toBeVisible(); await shot(page, '26-ai');
  await page.getByRole('button', { name: '关闭 AI API 设置', exact: true }).click();
  await navTo(page, '首页');
  for (const width of [820, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('button', { name: '导入', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '自定义', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await shot(page, `home-${width}`);
  }
  expect(errors).toEqual([]);
});

test('quiet reader: preserved toolbar, monochrome handwriting, collapse and slider', async ({ page }) => {
  await createAccount(page);
  await openOfficialResource(page, '2023 英语（一）Text 1');
  const toolbar = page.locator('.annotation-toolbar');
  await expect(toolbar.getByRole('button', { name: '手写批注' }).locator('svg use')).toHaveAttribute('href', '/ui-icons.svg#handwriting');
  await expect(page.getByText('本地模式', { exact: true })).toHaveCount(0);
  await expect(page.getByText('当前任务', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
  await shot(page, '03-reading-cover');
  await toolbar.getByRole('button', { name: '手写批注', exact: true }).click();
  await expect(toolbar.getByRole('button', { name: '手写批注', exact: true })).toHaveClass('active');
  const slider = toolbar.getByRole('slider').first();
  await slider.focus();
  const before = Number(await slider.getAttribute('aria-valuenow'));
  await slider.press('ArrowRight');
  expect(Number(await slider.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
  await toolbar.getByRole('button', { name: '键盘输入', exact: true }).click();
  await expect(toolbar.getByRole('button', { name: '键盘输入', exact: true })).toHaveClass('active');
  await page.getByRole('button', { name: '开始精读', exact: true }).click();
  await page.locator('.question-fab').click();
  await expect(page.locator('.reader-side-panel')).toHaveAttribute('data-motion-state', 'open');
  await shot(page, '03b-reading-questions');
  await toolbar.getByRole('button', { name: '收起顶部' }).click();
  await expect(toolbar.getByRole('button', { name: '展开顶部' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '手写批注' })).toBeVisible();
  await shot(page, 'reading-collapsed');
  await toolbar.getByRole('button', { name: '展开顶部' }).click();
});
