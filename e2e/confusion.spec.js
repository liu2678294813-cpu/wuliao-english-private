import { test, expect } from '@playwright/test';
import { createAccount, navTo } from './helpers.js';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const artifacts = 'output/confusion-20261013/browser';
async function setup(page) {
  const username = await createAccount(page);
  await navTo(page, '词库');
  await expect(page.locator('.vocabulary-frame.loaded')).toBeVisible();
  const frame = page.frames().find((f) => f.url().includes('/vocabulary/index.html'));
  await expect(frame.getByRole('button', { name: '混淆词', exact: true })).toBeVisible();
  return { username, frame };
}
async function seedMemory(page, username, kind = 'built-in') {
  await page.goto('/vocabulary/memorize.html');
  await expect(page.locator('.word-row').first()).toBeVisible();
  return page.evaluate(async ({ username, kind }) => {
    const map = await (await fetch('/vocabulary/word-assets.json')).json();
    const word = kind === 'built-in' ? (await import(map.chunk_000)).default.entries[0]
      : { wordId: kind === 'imported' ? 'import:confusion-test-word' : 'unknown:accept', english: 'accept', chinese: '接受' };
    const date = new Date(); const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const request = indexedDB.open('KaoyanVocabMemorizeDB');
    const db = await new Promise((r, j) => { request.onsuccess = () => r(request.result); request.onerror = () => j(request.error); });
    const tx = db.transaction(['records', 'importedWords', 'importedLists'], 'readwrite');
    const record = { username, wordId: word.wordId, listKey: kind === 'imported' ? 'import:confusion-test' : kind === 'unknown' ? 'unknown' : 'original',
      clickCount: 3, maskedAt: Date.now(), maskedDates: [today], updatedAt: Date.now(), customSentinel: 'preserve-me' };
    record.memoryKey = `${username}:${record.listKey}:${word.wordId}`;
    tx.objectStore('records').put(record);
    if (kind === 'imported') {
      tx.objectStore('importedWords').put({ ...word, username, listKey: record.listKey });
      tx.objectStore('importedLists').put({ id: record.listKey, username, listKey: record.listKey, name: '测试导入词库', wordIds: [word.wordId], createdAt: Date.now() });
    }
    await new Promise((r, j) => { tx.oncomplete = r; tx.onabort = () => j(tx.error); }); db.close();
    if (kind === 'unknown') {
      const req = indexedDB.open('wuliao-english'); const host = await new Promise((r) => { req.onsuccess = () => r(req.result); });
      const tx = host.transaction('unknown-words', 'readwrite');
      tx.objectStore('unknown-words').put({ id: 'confusion-unknown-accept', username, word: 'accept', normalizedWord: 'accept', meaning: '接受', createdAt: 1 });
      tx.objectStore('unknown-words').put({ id: 'confusion-unknown-except', username, word: 'except', normalizedWord: 'except', meaning: '除外', createdAt: 2 });
      await new Promise((r, j) => { tx.oncomplete = r; tx.onabort = () => j(tx.error); }); host.close();
    }
    return { word, record, today };
  }, { username, kind });
}
async function rows(page, username) {
  return page.evaluate(async (username) => (await import('/vocabulary/confusion-records.js')).readConfusions(username), username);
}

test('single dashboard entry, correct placement at desktop/tablet/phone, legacy records and return', async ({ page }) => {
  mkdirSync(artifacts, { recursive: true });
  const { username, frame } = await setup(page);
  for (const width of [1280, 800, 390]) {
    await page.setViewportSize({ width, height: 850 });
    const buttons = frame.locator('.embedded-dashboard-actions button');
    await expect(buttons).toHaveText(['混淆词', '词库']);
    const a = await buttons.nth(0).boundingBox(), b = await buttons.nth(1).boundingBox();
    expect(a.x + a.width).toBeLessThanOrEqual(b.x);
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    const body = await frame.evaluate(() => ({ width: document.documentElement.clientWidth,
      right: document.getElementById('embeddedDashboardLibrary').getBoundingClientRect().right }));
    expect(body.right).toBeLessThanOrEqual(body.width);
    await page.screenshot({ path: `${artifacts}/dashboard-${width}.png`, fullPage: true });
  }
  await frame.evaluate(async (username) => {
    const req = indexedDB.open('KaoyanVocabDB'); const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const tx = db.transaction('confusionPairs', 'readwrite');
    tx.objectStore('confusionPairs').add({ username, round: 2, correctEnglish: 'accept', correctChinese: '接受', sourceWord: 'except', wrongChinese: '除外', sourceWordChinese: '除外', timestamp: 1 });
    await new Promise((r) => { tx.oncomplete = r; }); db.close();
  }, username);
  await frame.getByRole('button', { name: '混淆词', exact: true }).click();
  await expect(frame.locator('.confusion-page')).toContainText('accept');
  await expect(frame.locator('.confusion-page')).toContainText('筛查第 2 轮');
  await page.screenshot({ path: `${artifacts}/confusion-phone.png`, fullPage: true });
  await frame.getByRole('button', { name: '返回词库首页' }).click();
  await expect(frame.locator('.embedded-dashboard-actions')).toBeVisible();
  await page.reload();
  await expect(page.frameLocator('.vocabulary-frame').getByRole('button', { name: '混淆词', exact: true })).toBeVisible();
});

for (const kind of ['built-in', 'imported', 'unknown']) test(`daily review records exact ${kind} distractor and preserves review history`, async ({ page }) => {
  const { username } = await setup(page);
  const seeded = await seedMemory(page, username, kind);
  await page.goto(`/vocabulary/review.html?date=${seeded.today}`);
  const wrong = page.locator('.review-option[data-correct="false"]').first();
  await expect(wrong).toBeVisible(); const chosen = await wrong.textContent();
  await wrong.click();
  await expect.poll(async () => (await rows(page, username)).rows.length).toBe(1);
  const [row] = (await rows(page, username)).rows;
  expect(row.correctEnglish).toBe(seeded.word.english);
  expect(row.wrongChinese).toBe(chosen); expect(row.sourceWordId).toBeTruthy(); expect(row.source).toBe('review');
  const recovered = await page.evaluate(async ({ username, key }) => {
    const req = indexedDB.open('KaoyanVocabMemorizeDB'); const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const r = db.transaction('records').objectStore('records').get(key);
    const row = await new Promise((resolve) => { r.onsuccess = () => resolve(r.result); }); db.close(); return row;
  }, { username, key: seeded.record.memoryKey });
  expect(recovered.clickCount).toBe(0); expect(recovered.maskedDates).toEqual(seeded.record.maskedDates);
  expect(recovered.customSentinel).toBe('preserve-me'); expect(recovered.pendingConfusions).toBeUndefined();
  await page.reload(); expect((await rows(page, username)).rows).toHaveLength(1);
  await page.goto('/vocabulary/index.html#/confusion');
  await expect(page.locator('.confusion-page tbody')).toContainText(seeded.word.english);
  await page.getByLabel('混淆记录筛选').selectOption('review');
  await expect(page.locator('.confusion-summary')).toContainText('当前显示 1 条');
});

for (const failure of ['main-open', 'acknowledgement']) test(`durable outbox survives ${failure} failure, reload, concurrent flush and newer learning changes`, async ({ page }) => {
  const { username } = await setup(page); const seeded = await seedMemory(page, username);
  await page.goto(`/vocabulary/review.html?date=${seeded.today}`);
  await expect(page.locator('.review-option').first()).toBeVisible();
  await page.evaluate((failure) => {
    if (failure === 'main-open') {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (name, ...args) => { if (name === 'KaoyanVocabDB') throw new Error('simulated unavailable'); return open(name, ...args); };
    } else {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, ...args) {
        if (this.name === 'records' && value.lastReviewResult === 'wrong' && !value.pendingConfusions) throw new Error('simulated acknowledgement failure');
        return put.call(this, value, ...args);
      };
    }
  }, failure);
  await page.locator('.review-option[data-correct="false"]').first().click();
  await expect(page.locator('#answerHint')).toContainText('同步失败');
  const eventId = await page.evaluate(async (key) => {
    const req = indexedDB.open('KaoyanVocabMemorizeDB'); const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'), reqRow = store.get(key);
    const row = await new Promise((r) => { reqRow.onsuccess = () => r(reqRow.result); });
    row.customSentinel = 'newer-learning'; store.put(row);
    await new Promise((r) => { tx.oncomplete = r; }); db.close(); return row.pendingConfusions[0].eventId;
  }, seeded.record.memoryKey);
  await page.reload();
  await page.evaluate(async (username) => { const m = await import('/vocabulary/confusion-records.js'); await Promise.all([m.flushPendingConfusions(username), m.flushPendingConfusions(username)]); }, username);
  const result = await rows(page, username); expect(result.rows).toHaveLength(1); expect(result.rows[0].eventId).toBe(eventId);
  const sentinel = await page.evaluate(async (key) => {
    const req = indexedDB.open('KaoyanVocabMemorizeDB'); const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const get = db.transaction('records').objectStore('records').get(key); const row = await new Promise((r) => { get.onsuccess = () => r(get.result); }); db.close(); return row.customSentinel;
  }, seeded.record.memoryKey);
  expect(sentinel).toBe('newer-learning');
});

test('correct and skip do not record pairs; separate repeated mistakes are retained', async ({ page }) => {
  const { username } = await setup(page); const seeded = await seedMemory(page, username);
  await page.addInitScript(() => { Math.random = () => 0.25; });
  await page.goto(`/vocabulary/review.html?date=${seeded.today}`);
  await page.locator('.review-option[data-correct="true"]').click();
  await expect(page.locator('#restartButton')).toBeVisible();
  expect((await rows(page, username)).rows).toHaveLength(0);
  await page.locator('#restartButton').click(); await page.locator('#skipButton').click();
  await expect(page.locator('#restartButton')).toBeVisible();
  expect((await rows(page, username)).rows).toHaveLength(0);
  for (let count = 1; count <= 2; count++) {
    await page.locator('#restartButton').click();
    await page.locator('.review-option[data-correct="false"]').first().click();
    await expect(page.locator('#restartButton')).toBeVisible();
    expect((await rows(page, username)).rows).toHaveLength(count);
  }
  const result = (await rows(page, username)).rows;
  expect(result[0].sourceWord).toBe(result[1].sourceWord);
  expect(result[0].eventId).not.toBe(result[1].eventId);
});

test('exact snapshot repair, account isolation, atomic clear and restore without reviving cleared events', async ({ page }) => {
  const { username } = await setup(page);
  await page.evaluate(async (username) => {
    const m = await import('/vocabulary/confusion-records.js');
    const row = m.makeConfusion({ username, eventId: 'exact-repair', source: 'screening', round: 3,
      word: { wordId: 'one', english: 'accept', chinese: '接受' }, choice: { english: 'except', chinese: '除外' } });
    const req = indexedDB.open('KaoyanVocabDB'); const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const tx = db.transaction('wordRecords', 'readwrite');
    tx.objectStore('wordRecords').add({ username, wordId: 'one', round: 3, result: 'wrong', confusion: row });
    tx.objectStore('wordRecords').add({ username, wordId: 'two', result: 'wrong' });
    tx.objectStore('wordRecords').add({ username: 'another', wordId: 'three', result: 'wrong', confusion: { ...row, username: 'another' } });
    await new Promise((r) => { tx.oncomplete = r; }); db.close();
    const first = await m.readConfusions(username); if (first.recovered !== 1) throw new Error('repair did not recover exact record');
  }, username);
  expect((await rows(page, username)).rows).toHaveLength(1);
  await page.goto('/vocabulary/index.html#/confusion');
  await expect(page.locator('.confusion-page tbody tr')).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept()); await page.getByRole('button', { name: '清除 1 条' }).click();
  await expect(page.getByRole('button', { name: '恢复上次清除' })).toBeVisible();
  await page.reload(); await expect(page.locator('.confusion-summary')).toContainText('共 0 条');
  await page.getByRole('button', { name: '恢复上次清除' }).click();
  await expect(page.locator('.confusion-page tbody tr')).toHaveCount(1);
  expect((await rows(page, username)).rows).toHaveLength(1);
});

test('screening saves the exact pair, old entry is removed, and skip creates no pair', async ({ page }) => {
  const { username, frame } = await setup(page);
  await frame.evaluate(() => { location.hash = '#/screening/1'; });
  await expect.poll(() => frame.evaluate(() => Boolean(window.__wuliaoScreeningContext))).toBe(true);
  await expect(frame.locator('main h2')).not.toHaveText('');
  const captured = await frame.evaluate(async () => {
    const context = await window.__wuliaoScreeningContext();
    const current = context.words[context.currentIndex];
    const correctMeaning = current.chinese.replace(/^[A-L][.、]\s*/, '');
    const distractor = [...document.querySelectorAll('main .grid button')]
      .find((button) => button.className.includes('cursor-pointer') && button.textContent.trim() !== correctMeaning);
    if (!distractor) throw new Error('no distractor button');
    const selected = distractor.textContent; distractor.click(); return { english: current.english, selected };
  });
  await expect.poll(async () => (await rows(page, username)).rows.length).toBe(1);
  const [row] = (await rows(page, username)).rows;
  expect(row.correctEnglish).toBe(captured.english); expect(row.wrongChinese).toBe(captured.selected); expect(row.sourceWordId).toBeTruthy();
  await expect.poll(() => frame.evaluate(async () => (await window.__wuliaoScreeningContext()).currentIndex)).toBe(1);
  await frame.getByRole('button', { name: /不会|跳过/ }).click();
  await frame.evaluate(() => window.__wuliaoFlushVocabulary());
  expect((await rows(page, username)).rows).toHaveLength(1);
  await frame.evaluate(() => { location.hash = '#/learning'; });
  await expect(frame.getByRole('button', { name: '返回', exact: true })).toBeVisible();
  await expect(frame.getByRole('button', { name: /混淆/ })).toHaveCount(0);
});

test('real backup export and restore preserve legacy pairs, pending events and learning data', async ({ browser }) => {
  mkdirSync(artifacts, { recursive: true });
  const contextA = await browser.newContext();
  // Exercise the browser download path; native OS save dialogs cannot be automated.
  await contextA.addInitScript(() => { window.showSaveFilePicker = undefined; });
  const pageA = await contextA.newPage();
  const { username } = await setup(pageA); const seeded = await seedMemory(pageA, username);
  await pageA.evaluate(async ({ username, key }) => {
    const m = await import('/vocabulary/confusion-records.js');
    const pending = m.makeConfusion({ username, eventId: 'backup-pending', source: 'review',
      word: { wordId: 'import:backup', english: 'accept', chinese: '接受' }, choice: { wordId: 'unknown:except', english: 'except', chinese: '除外' } });
    await m.saveConfusion({ ...pending, eventId: 'backup-existing', source: 'screening', round: 2 });
    const req = indexedDB.open('KaoyanVocabMemorizeDB'); const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records'), get = store.get(key);
    const row = await new Promise((r) => { get.onsuccess = () => r(get.result); });
    row.pendingConfusions = [pending]; store.put(row);
    await new Promise((r) => { tx.oncomplete = r; }); db.close();
  }, { username, key: seeded.record.memoryKey });
  await pageA.goto('/');
  await expect(pageA.locator('.home-page')).toBeVisible();
  await pageA.locator('.ds-mobile-settings, .ds-settings').first().click();
  const download = pageA.waitForEvent('download');
  await pageA.locator('.settings-action', { hasText: '导出备份' }).click();
  const backupPath = `${artifacts}/isolated-account-backup.json`;
  await (await download).saveAs(backupPath);
  const backup = await readFile(backupPath, 'utf8');
  expect(backup).toContain('backup-pending'); expect(backup).toContain('backup-existing'); expect(backup).toContain('preserve-me');
  await contextA.close();
  const contextB = await browser.newContext(), pageB = await contextB.newPage();
  await createAccount(pageB, username);
  // Upgrade/restore recipient: initialize the existing vocabulary schemas using
  // their normal pages, rather than ask backup restore to invent a new schema.
  await navTo(pageB, '词库');
  await expect(pageB.locator('.vocabulary-frame.loaded')).toBeVisible();
  await pageB.goto('/vocabulary/memorize.html');
  await expect(pageB.locator('.word-row').first()).toBeVisible();
  await pageB.goto('/'); await expect(pageB.locator('.home-page')).toBeVisible();
  await pageB.locator('.ds-mobile-settings, .ds-settings').first().click();
  await pageB.locator('.settings-panel input[type="file"]').setInputFiles(backupPath);
  await expect(pageB.locator('.settings-backup-status')).toContainText('备份有效');
  pageB.once('dialog', (dialog) => dialog.accept());
  await pageB.locator('.settings-action', { hasText: '确认恢复' }).click();
  await expect(pageB.locator('.settings-backup-status')).toContainText('恢复完成');
  const result = await rows(pageB, username);
  expect(result.rows.map((row) => row.eventId).sort()).toEqual(['backup-existing', 'backup-pending']);
  const restored = await pageB.evaluate(async (key) => {
    const req = indexedDB.open('KaoyanVocabMemorizeDB'); const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const get = db.transaction('records').objectStore('records').get(key);
    const row = await new Promise((r) => { get.onsuccess = () => r(get.result); }); db.close(); return row;
  }, seeded.record.memoryKey);
  expect(restored.maskedDates).toEqual(seeded.record.maskedDates); expect(restored.clickCount).toBe(3);
  expect(restored.customSentinel).toBe('preserve-me'); expect(restored.pendingConfusions).toBeUndefined();
  // Restoring the same old pending event again cannot duplicate its already-synced pair.
  await pageB.locator('.settings-panel input[type="file"]').setInputFiles(backupPath);
  await expect(pageB.locator('.settings-backup-status')).toContainText('备份有效');
  pageB.once('dialog', (dialog) => dialog.accept());
  await pageB.locator('.settings-action', { hasText: '确认恢复' }).click();
  await expect(pageB.locator('.settings-backup-status')).toContainText('恢复完成');
  expect((await rows(pageB, username)).rows).toHaveLength(2);
  await contextB.close();
});
