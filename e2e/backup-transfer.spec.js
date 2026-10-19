import { test, expect } from '@playwright/test';
import { createAccount, setScopedJson } from './helpers.js';
import { createBackup, browserEncodeAttachment } from '../src/backup.js';
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const folder = 'artifacts/backup-transfer-20261019';
async function settings(page) { await page.getByRole('button', { name: '设置', exact: true }).click(); await expect(page.locator('.backup-transfer')).toBeVisible(); }
test('file preview, explicit replacement, repeated import, recovery and later learning protection', async ({ page }) => {
  const user = await createAccount(page);
  await setScopedJson(page, user, 'wuliao:reading-progress:transfer-test', { title: '本机阅读', updatedAt: 1000, progress: 10 });
  await page.evaluate(async username => {
    const db = await new Promise((r, j) => { const q = indexedDB.open('wuliao-english'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    const tx = db.transaction('custom-pdfs', 'readwrite'); tx.objectStore('custom-pdfs').put({ id: 'transfer-pdf', username, title: '同名资料', file: new Blob(['oldpdf']) });
    await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); }); db.close();
  }, user);
  const { fileText } = await createBackup({ username: user, sources: { entries: [
    { key: `wuliao:user:${user}:wuliao:reading-progress:transfer-test`, value: JSON.stringify({ title: '对方阅读', updatedAt: 2000, progress: 90 }) },
    { key: `wuliao:user:${user}:wuliao:other:transfer-new`, value: '新增内容' },
  ], databases: [{ name: 'wuliao-english', stores: [{ name: 'custom-pdfs', records: [{ key: 'transfer-pdf', value: { id: 'transfer-pdf', username: user, title: '同名资料', file: new Blob(['newpdf']) } }] }] }] }, encodeAttachment: browserEncodeAttachment });
  await mkdir(folder, { recursive: true }); const path = `${folder}/isolated-import.json`; await writeFile(path, fileText);
  await settings(page); await page.locator('.backup-transfer input[type=file]').setInputFiles(path);
  await expect(page.getByLabel('导入差异预览')).toContainText('冲突 2 条');
  await expect(page.getByLabel('导入差异预览')).toContainText('本机阅读');
  await page.getByLabel('阅读、完形、翻译与笔迹的处理方式').selectOption('incoming');
  await page.getByLabel('导入资料、附件与答案（关联记录一起选择）的处理方式').selectOption('incoming');
  await page.locator('.settings-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.screenshot({ path: `${folder}/conflict-preview.png`, fullPage: true });
  page.on('dialog', d => d.accept()); await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.locator('.settings-backup-status')).toContainText('导入完成');
  expect(await page.evaluate(u => JSON.parse(localStorage.getItem(`wuliao:user:${u}:wuliao:reading-progress:transfer-test`)).progress, user)).toBe(90);
  await page.getByRole('button', { name: '导入历史与恢复' }).click();
  await page.getByRole('button', { name: '恢复被替换版本' }).first().click();
  await expect(page.locator('.settings-backup-status')).toContainText('还原 2 条');
  expect(await page.evaluate(u => JSON.parse(localStorage.getItem(`wuliao:user:${u}:wuliao:reading-progress:transfer-test`)).progress, user)).toBe(10);
  await page.reload(); await expect(page.locator('.home-page')).toBeVisible();
  await settings(page); await page.locator('.backup-transfer input[type=file]').setInputFiles(path);
  await expect(page.getByLabel('导入差异预览')).toContainText('相同 1 条');
  await page.getByRole('button', { name: '放弃预览' }).click();
});

test('mismatched primary key is rejected without changing the other existing PDF', async ({ page }) => {
  const user = await createAccount(page);
  await page.evaluate(async username => {
    const db = await new Promise((r, j) => { const q = indexedDB.open('wuliao-english'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    const tx = db.transaction('custom-pdfs', 'readwrite');
    for (const id of ['source-id', 'protected-id']) tx.objectStore('custom-pdfs').put({ id, username, title: '原资料 ' + id });
    await new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); }); db.close();
  }, user);
  const { fileText } = await createBackup({ username: user, sources: { entries: [], databases: [{ name: 'wuliao-english', stores: [{ name: 'custom-pdfs', records: [{ key: 'source-id', value: { id: 'protected-id', username: user, title: '不应写入的异常资料' } }] }] }] } });
  const path = `${folder}/isolated-mismatched-key.json`; await writeFile(path, fileText);
  await settings(page); await page.locator('.backup-transfer input[type=file]').setInputFiles(path);
  await expect(page.getByLabel('导入差异预览')).toContainText('冲突 1 条');
  await page.getByLabel('导入资料、附件与答案（关联记录一起选择）的处理方式').selectOption('incoming');
  page.on('dialog', d => d.accept()); await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.locator('.settings-backup-status')).toContainText('主键与内容 ID 不一致');
  const titles = await page.evaluate(async () => {
    const db = await new Promise(r => { const q = indexedDB.open('wuliao-english'); q.onsuccess = () => r(q.result); });
    const rows = await new Promise(r => { const q = db.transaction('custom-pdfs').objectStore('custom-pdfs').getAll(); q.onsuccess = () => r(q.result); }); db.close(); return rows.map(row => row.title).sort();
  });
  expect(titles).toEqual(['原资料 protected-id', '原资料 source-id']);
});

test('real IndexedDB batches 2048 records and preserves large Unicode ink across reads', async ({ page }) => {
  await page.goto('/');
  const source = await readFile('src/backupStaging.js', 'utf8');
  const result = await page.evaluate(async script => {
    const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
    const { openBackupStaging } = await import(url); URL.revokeObjectURL(url);
    const oldName = `wuliao-stage-baseline-${crypto.randomUUID()}`;
    const baseline = await new Promise((r, j) => { const q = indexedDB.open(oldName, 1); q.onupgradeneeded = () => q.result.createObjectStore('records'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
    const ink = '笔迹😀'.repeat(1024 * 1024);
    const baselineStarted = performance.now();
    for (let i = 0; i < 2049; i++) await new Promise((r, j) => {
      const tx = baseline.transaction('records', 'readwrite'); tx.objectStore('records').put({ key: i === 2048 ? 'large-ink' : `k${i}`, value: i === 2048 ? ink : `record-${i}` }, i);
      tx.oncomplete = r; tx.onerror = () => j(tx.error);
    });
    const baselineMilliseconds = performance.now() - baselineStarted; baseline.close();
    await new Promise((r, j) => { const q = indexedDB.deleteDatabase(oldName); q.onsuccess = r; q.onerror = () => j(q.error); });
    const stage = await openBackupStaging(), list = stage.list(); const started = performance.now();
    for (let i = 0; i < 2048; i++) await list.push({ key: `k${i}`, value: `record-${i}` });
    await list.push({ key: 'large-ink', value: ink });
    let count = 0, last; for await (const row of list) { count++; last = row; }
    const result = { count, transactions: stage.transactions, milliseconds: performance.now() - started, baselineTransactions: 2049, baselineMilliseconds, valid: last.value === ink };
    await stage.close(); return result;
  }, source);
  expect(result.count).toBe(2049); expect(result.valid).toBe(true); expect(result.transactions).toBeLessThanOrEqual(34);
  await writeFile(`${folder}/staging-benchmark.json`, JSON.stringify(result, null, 2));
});

test('two isolated Windows browser profiles exchange an encrypted backup through actual LAN endpoints', async ({ browser }) => {
  const one = await browser.newContext(), two = await browser.newContext();
  const receiver = await one.newPage(), sender = await two.newPage();
  const user = `lan-${Date.now()}`;
  try {
    await createAccount(receiver, user); await createAccount(sender, user);
    await setScopedJson(sender, user, 'wuliao:reading-progress:lan-test', { title: '跨设备笔迹与进度', progress: 87 });
    await settings(receiver); await settings(sender);
    await receiver.getByRole('button', { name: '接收其他设备数据' }).click();
    await expect(receiver.getByLabel('本机连接码')).toBeVisible();
    const code = await receiver.getByLabel('本机连接码').inputValue();
    await sender.getByLabel('另一设备的连接码').fill(code);
    await sender.getByRole('button', { name: '发送到其他设备' }).click();
    await expect(receiver.getByRole('button', { name: '确认接收', exact: true })).toBeVisible();
    await receiver.getByRole('button', { name: '确认接收', exact: true }).click();
    await expect(sender.locator('.settings-backup-status')).toContainText('发送完成', { timeout: 120000 });
    await expect(receiver.getByLabel('导入差异预览')).toBeVisible({ timeout: 120000 });
    await receiver.screenshot({ path: `${folder}/lan-received.png`, fullPage: true });
    receiver.on('dialog', d => d.accept()); await receiver.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(receiver.locator('.settings-backup-status')).toContainText('导入完成');
    expect(await receiver.evaluate(u => JSON.parse(localStorage.getItem(`wuliao:user:${u}:wuliao:reading-progress:lan-test`)).progress, user)).toBe(87);
  } finally { await one.close(); await two.close(); }
});
