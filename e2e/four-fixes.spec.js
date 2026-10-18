import { test, expect } from '@playwright/test';
import { createAccount, navTo, setScopedJson } from './helpers.js';
import { readFile, mkdir } from 'node:fs/promises';

const evidence = 'artifacts/four-fixes-20261018';
test('触摸设备模拟：捏合手势不放大整个页面', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 1100 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); await createAccount(page);
  const cdp = await context.newCDPSession(page);
  const initial = await page.evaluate(() => visualViewport.scale);
  await cdp.send('Input.synthesizePinchGesture', { x: 500, y: 400, scaleFactor: 2, relativeSpeed: 800, gestureSourceType: 'touch' });
  expect(await page.evaluate(() => visualViewport.scale)).toBe(initial);
  await page.screenshot({ path: `${evidence}/zoom-touch.png` });
  for (const route of ['/vocabulary/memorize.html', '/vocabulary/review.html', '/vocabulary/import.html']) {
    await page.goto(route);
    expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain('user-scalable=no');
    await cdp.send('Input.synthesizePinchGesture', { x: 500, y: 400, scaleFactor: 2, relativeSpeed: 800, gestureSourceType: 'touch' });
    expect(await page.evaluate(() => visualViewport.scale)).toBe(1);
  }
  await context.close();
});
test('筛选连续题目显示 12 个不同中文释义，双击保持页面比例', async ({ page }) => {
  await createAccount(page); await navTo(page, '筛查');
  await expect(page.locator('.vocabulary-frame.loaded')).toBeVisible();
  const frame = page.frames().find(f => f.url().includes('/vocabulary/index.html'));
  await frame.evaluate(() => { location.hash = '#/screening/1'; });
  const options = frame.locator('.grid button').filter({ has: frame.locator('span.line-clamp-3') });
  for (let i = 0; i < 12; i++) {
    await expect(options).toHaveCount(12);
    const texts = await options.allTextContents(); expect(new Set(texts.map(t => t.trim())).size).toBe(12);
    const word = await frame.locator('h2').last().innerText();
    await options.first().click();
    await expect(frame.locator('h2').last()).not.toHaveText(word);
  }
  const before = await page.evaluate(() => visualViewport.scale);
  await page.locator('.ds-brand').first().dblclick().catch(() => {});
  expect(await page.evaluate(() => visualViewport.scale)).toBe(before);
});
test('例句：范文拖选、收藏、重启、搜索、来源与删除；桌面和平板布局', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const username = await createAccount(page);
  await navTo(page, '写作');
  const examples = page.getByRole('button', { name: '例句', exact: true });
  await expect(examples).toBeVisible();
  const a = await examples.boundingBox(), b = await page.getByRole('button', { name: '浏览历年真题', exact: true }).boundingBox();
  expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThanOrEqual(2);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x);
  await page.getByRole('button', { name: '查看 2023 年小作文 · Writing A' }).click();
  await page.getByRole('button', { name: '使用随应用范文', exact: true }).click();
  await expect(page.locator('.writing-reading-sheet')).toBeVisible();
  const original = await page.locator('[data-example-text] p > span').first().innerText();
  await page.locator('[data-example-text] p > span').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '收藏到例句', exact: true }).click();
  await expect(page.getByText('已收藏到例句', { exact: true })).toBeVisible();
  await page.reload();
  await navTo(page, '写作');
  // The sidebar may retain the active session; use its back action when present.
  if (await page.locator('.writing-workspace-frame').isVisible()) await page.locator('.writing-workspace-frame .back-button').first().click();
  await page.getByRole('button', { name: '例句', exact: true }).click();
  await expect(page.locator('.writing-example-original')).toHaveText(original);
  await page.getByRole('textbox', { name: '搜索例句' }).fill('no-result-phrase');
  await expect(page.getByText('没有匹配的例句。')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索例句' }).fill('');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/examples-desktop.png` });
  await page.setViewportSize({ width: 800, height: 1100 });
  await page.screenshot({ path: `${evidence}/examples-tablet.png` });
  expect(await page.locator('.writing-example-library').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: '查看来源', exact: true }).click();
  await expect(page.locator('.writing-reading-sheet')).toBeVisible();
  await page.locator('.writing-workspace-frame .back-button').first().click();
  await page.getByRole('button', { name: '例句', exact: true }).click();
  page.once('dialog', d => d.accept());
  await page.locator('.writing-example-library').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('.writing-example-original')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.querySelector('meta[name=viewport]').content)).toContain('user-scalable=no');
});

test('备份：真实 IndexedDB 暂存、导出、隔离账号恢复和重复恢复', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => { window.showSaveFilePicker = undefined; });
  const page = await context.newPage(), user = await createAccount(page);
  const key = 'wuliao:writing-example:v1:browser-example';
  const value = { version: 1, id: 'browser-example', username: user, text: 'A saved sentence.', source: { sessionId: 'removed', documentId: 'removed:W1:0', title: '已删除的作文' }, createdAt: 1, updatedAt: 1 };
  await setScopedJson(page, user, key, value);
  await page.evaluate(async username => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('wuliao-english'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction('custom-pdfs', 'readwrite');
    tx.objectStore('custom-pdfs').put({ id: 'backup-pdf-test', username, title: '隔离附件测试', file: new Blob([new Uint8Array(8 * 1024 * 1024).fill(37)], { type: 'application/pdf' }) });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); }); db.close();
  }, user);
  await page.locator('.ds-mobile-settings, .ds-settings').first().click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const download = await downloading;
  await mkdir(evidence, { recursive: true });
  const path = `${evidence}/isolated-test-backup.json`; await download.saveAs(path);
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  expect(manifest.sections.localStorage.user.some(item => item.key === key)).toBe(true);
  await expect(page.locator('.settings-backup-status')).toContainText('已生成并发起下载');
  expect((await page.evaluate(() => indexedDB.databases())).some(db => db.name.startsWith('wuliao-backup-stage-'))).toBe(false);
  await context.close();
  const restored = await browser.newContext(), target = await restored.newPage();
  await createAccount(target, user);
  await target.locator('.ds-mobile-settings, .ds-settings').first().click();
  await target.locator('.settings-panel input[type=file]').setInputFiles(path);
  await expect(target.locator('.settings-backup-status')).toContainText('备份有效');
  for (let i = 0; i < 2; i++) {
    target.once('dialog', d => d.accept());
    await target.getByRole('button', { name: '确认恢复（merge）', exact: true }).click();
    await expect(target.locator('.settings-backup-status')).toContainText('恢复完成');
  }
  expect(JSON.parse(await target.evaluate(k => localStorage.getItem(k), `wuliao:user:${encodeURIComponent(user)}:${key}`))).toEqual(value);
  const attachment = await target.evaluate(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open('wuliao-english'); r.onsuccess = () => resolve(r.result); });
    const record = await new Promise(resolve => { const r = db.transaction('custom-pdfs').objectStore('custom-pdfs').get('backup-pdf-test'); r.onsuccess = () => resolve(r.result); }); db.close();
    return { size: record.file.size, first: (new Uint8Array(await record.file.slice(0, 1).arrayBuffer()))[0], last: (new Uint8Array(await record.file.slice(-1).arrayBuffer()))[0] };
  });
  expect(attachment).toEqual({ size: 8 * 1024 * 1024, first: 37, last: 37 });
  await target.screenshot({ path: `${evidence}/backup-restored.png` });
  await target.getByRole('button', { name: '关闭设置' }).click();
  await navTo(target, '写作'); await target.getByRole('button', { name: '例句', exact: true }).click();
  await expect(target.locator('.writing-example-original')).toHaveText('A saved sentence.');
  await target.getByRole('button', { name: '查看来源' }).click();
  await expect(target.getByRole('alert')).toContainText('来源已删除或不可访问');
  await restored.close();
});
