// Isolated WebView QA. Run only after installing and launching the QA package.
// This script never installs an APK, clears data, or touches the production package.
import { chromium, expect } from '@playwright/test';
import { CRBrowserContext } from '../node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/lib/server/chromium/crBrowser.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TRAINING_SOURCE, TRAINING_SENTENCE_B, TRAINING_SENTENCE_C, TRAINING_EVALUATION, TRAINING_FINGERPRINT, QUALITY_CORPUS, qualityItem } from './fixtures/long-sentence-quality.mjs';

const QA_PACKAGE = 'com.wuliao.english.longsentenceqa';
const PRODUCTION_PACKAGE = 'com.wuliao.english';
const PORT = '9234';
const OTHER_SOURCE = 'The students who attended the lecture understood the argument.';
const GENERATED_CANDIDATES = [
  TRAINING_SENTENCE_B, TRAINING_SENTENCE_C, QUALITY_CORPUS[1].generated, QUALITY_CORPUS[2].generated,
  'Although the investigators who had examined the surviving records acknowledged that several witnesses might have mistaken the date, their reconstruction explained why the vessel changed course before dawn.'
];
const RESOURCE = `custom-long-sentence-tablet-qa-${Date.now().toString(36)}`;
const PASSAGE = 'passage-training';
const out = resolve('output/device-qa', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(out, { recursive: true });
const adb = resolve('.android-sdk/platform-tools/adb.exe');
const adbPrefix = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
const run = (...args) => execFileSync(adb, [...adbPrefix, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
const resumedActivity = () => run('shell', 'dumpsys', 'activity', 'activities').split(/\r?\n/).find(line => line.includes('mResumedActivity:'))?.trim() || '';
async function ensureQaForeground() {
  let resumed = resumedActivity();
  if (/com\.huawei\.securitymgr|HwKeychainSaveActivity/.test(resumed)) {
    run('shell', 'input', 'keyevent', '4');
    await expect.poll(() => resumedActivity(), { timeout: 8000 }).toContain(`${QA_PACKAGE}/com.wuliao.english.MainActivity`);
    resumed = resumedActivity();
  }
  if (!resumed.includes(`${QA_PACKAGE}/com.wuliao.english.MainActivity`)) throw new Error('QA MainActivity is not the foreground activity');
  return resumed;
}
const mark = (id, status, evidence) => { const item = report.checklist.find(entry => entry.id === id); item.status = status; item.evidence = evidence; };
const loc = (page, name) => page.getByTestId(`long-sentence-${name}`);
const scoped = (user, key) => `wuliao:user:${encodeURIComponent(user)}:${key}`;
function sentenceKey(text, index) { let hash = 5381; for (const char of text.replace(/\s+/g, ' ').trim().toLowerCase()) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0; return `p1s${index + 1}:x${(hash >>> 0).toString(36)}`; }
const SOURCE_KEY = sentenceKey(TRAINING_SOURCE, 0);
const OTHER_KEY = sentenceKey(OTHER_SOURCE, 1);
const checks = [
  'QA 包及 WebView 进程隔离', '新账号与原句资料隔离', '一级入口与五个子页', '来源章节文章句子树', '来源多选和半选',
  '陌生词并集与取消选择', '1–5 句数量边界', '批量生成且难度高一层', '提交前无参考答案', '英文句纸与共享笔工具',
  '合成笔迹持久化', '撤销笔迹', '普通橡皮与自由套索', '清空笔迹', '系统旋转后逻辑布局与笔迹保留',
  '翻译草稿与提交', 'AI 参考解析', '解析有误与重新解析', '自评不修改原句', '原句正常复习',
  '已学习证据迁移', '技能到期与同结构新句', '后台恢复', '离线草稿及历史', 'Reader 返回现场', '真实 M-Pencil 手写'
];
const report = {
  package: QA_PACKAGE, productionPackage: PRODUCTION_PACKAGE, startedAt: new Date().toISOString(),
  device: null, identity: null, account: null, resourceId: RESOURCE, provider: 'Playwright intercepted text Provider; no real key or network request',
  penInput: 'CDP synthetic pointerType=pen, not physical M-Pencil evidence', deviceEvidence: {},
  checklist: checks.map((name, index) => ({ id: index + 1, name, status: 'NOT COVERED', evidence: '未执行或缺少直接证据' })),
  pageErrors: [], requestFailures: [], screenshots: [], fatal: null
};
let browser, page, cdp, forwarded = false, active = '';
const screenshot = async name => {
  if (!page) return;
  const file = resolve(out, `${name}.png`);
  await page.screenshot({ path: file }).then(() => report.screenshots.push(file));
};
async function check(id, action) {
  active = String(id);
  try { const evidence = await action(); mark(id, 'PASS', evidence || '断言通过'); }
  catch (error) { mark(id, 'FAIL', error.message); await screenshot(`failed-${id}`).catch(() => {}); throw error; }
}
async function optionalCheck(id, action) {
  try { await check(id, action); }
  catch { /* The independent remainder still produces useful device evidence. */ }
}
async function rows(store) {
  return page.evaluate(async name => {
    const db = await new Promise((resolveDb, reject) => { const req = indexedDB.open('wuliao-english'); req.onsuccess = () => resolveDb(req.result); req.onerror = () => reject(req.error); });
    try { return await new Promise((resolveRows, reject) => { const req = db.transaction(name).objectStore(name).getAll(); req.onsuccess = () => resolveRows(req.result); req.onerror = () => reject(req.error); }); }
    finally { db.close(); }
  }, store);
}
async function userRows(store, user) { return (await rows(store)).filter(row => row.username === user); }
const block = (messages, tag) => {
  const content = messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(content);
  return match ? JSON.parse(match[1]) : null;
};
async function seed(user) {
  await page.evaluate(async ({ user, resourceId, passageId, source, other, sourceKey, otherKey }) => {
    const key = value => `wuliao:user:${encodeURIComponent(user)}:${value}`, now = Date.now();
    localStorage.setItem(key('wuliao:ai:apikey'), 'isolated-intercepted-test-key');
    localStorage.setItem(key('wuliao:feature:longSentenceTrainingEnabled'), 'true');
    const entry = { translationStatus: 'corrected', reviewStatus: 'needs_review', translatedAt: now - 2000, correctedAt: now - 1000, reviewedAt: now, translationFingerprint: 'tablet-qa-fixture' };
    localStorage.setItem(key(`wuliao:translation-progress:${resourceId}:${passageId}`), JSON.stringify({ schemaVersion: 1, resourceId, passageId, updatedAt: now, sentences: { [sourceKey]: entry, [otherKey]: entry }, paragraphs: {} }));
    localStorage.setItem(key(`wuliao:deep-answers:${resourceId}:${passageId}:first`), JSON.stringify({ 1: 'B' }));
    localStorage.setItem(key(`wuliao:deep-answers:${resourceId}:${passageId}:redo`), JSON.stringify({ 1: 'C' }));
    localStorage.setItem(key(`wuliao:question-evidence:${resourceId}:${passageId}`), JSON.stringify({ schemaVersion: 2, resourceId, passageId, entries: {}, updatedAt: now }));
    const stages = ['deep-cover', 'deep-first-read', 'deep-clean-text', 'deep-first-quiz', 'deep-translation', 'deep-redo', 'deep-review'];
    localStorage.setItem(key(`wuliao:reading-flow:${resourceId}:${passageId}`), JSON.stringify({ schemaVersion: 2, resourceId, passageId, currentStage: 'deep-translation', stages: Object.fromEntries(stages.map((id, index) => [id, { status: index < 4 ? 'completed' : index === 4 ? 'current' : 'pending', completedAt: index < 4 ? now - 1000 : null }])), timedReading: { phase: 'done', elapsedMs: 1000, startedAt: now - 3000, pausedAt: null, completedAt: now - 2000 }, updatedAt: now }));
    const db = await new Promise((resolveDb, reject) => { const req = indexedDB.open('wuliao-english'); req.onsuccess = () => resolveDb(req.result); req.onerror = () => reject(req.error); });
    try { await new Promise((resolveTx, reject) => {
      const tx = db.transaction(['custom-pdfs', 'unknown-words'], 'readwrite');
      tx.objectStore('custom-pdfs').put({ id: resourceId, kind: 'custom', category: 'custom', username: user, title: '长难句平板隔离验收资料', subtitle: '测试资料', year: 2025, fingerprint: 'tablet-long-sentence-fixture', addedAt: now, conversionStatus: 'ready', size: 0, file: new Blob([], { type: 'application/pdf' }), analysis: { title: '长难句平板隔离验收资料', passages: [{ id: passageId, label: 'Text A', text: source + ' ' + other, paragraphs: [{ number: 1, text: source + ' ' + other, sentences: [source, other] }], questions: [], correctAnswers: {} }] } });
      for (const word of ['reinforce', 'constrain']) tx.objectStore('unknown-words').put({ id: `${user}:${word}`, username: user, resourceId, passageId, passageLabel: 'Text A', chapter: '2025 阅读', sourceType: 'reading', word, normalizedWord: word, meaning: word === 'reinforce' ? '加强' : '限制', occurrences: [sourceKey], createdAt: now, updatedAt: now });
      tx.oncomplete = resolveTx; tx.onerror = tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
  }, { user, resourceId: RESOURCE, passageId: PASSAGE, source: TRAINING_SOURCE, other: OTHER_SOURCE, sourceKey: SOURCE_KEY, otherKey: OTHER_KEY });
  await page.reload();
  await page.locator('.home-page').waitFor({ timeout: 30000 });
}
async function nav(label) { await page.locator('.ds-rail .ds-nav button', { hasText: label }).first().click(); }
async function penGesture(points) {
  const send = (type, [x, y]) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen' });
  await send('mouseMoved', points[0]); await send('mousePressed', points[0]);
  for (const point of points.slice(1)) await send('mouseMoved', point);
  await send('mouseReleased', points.at(-1));
}
function inkLineY(box, offset = 0) { return box.y + Math.min(Math.max(180, box.height * 0.4), box.height - 110) + offset; }
async function stroke(box, offset) {
  const y = inkLineY(box, offset), x = box.x + 28;
  await penGesture(Array.from({ length: 10 }, (_, step) => [x + step * 20, y + Math.sin(step) * 3]));
}
async function inkRows(user) { return userRows('long-sentence-ink', user); }
async function originalFacts(user) { return page.evaluate(({ prefix, resource, passage }) => Object.fromEntries(['first', 'redo'].map(stage => `wuliao:deep-answers:${resource}:${passage}:${stage}`).concat([`wuliao:question-evidence:${resource}:${passage}`, `wuliao:reading-flow:${resource}:${passage}`]).map(key => [key, localStorage.getItem(prefix + key)])), { prefix: scoped(user, ''), resource: RESOURCE, passage: PASSAGE }); }

try {
  // A QA process-specific devtools socket is the hard boundary: never forward a
  // generic WebView socket or attach to the production application PID.
  const pid = run('shell', 'pidof', QA_PACKAGE);
  if (!/^\d+$/.test(pid)) throw new Error('Isolated QA package must already be running with one PID');
  const ps = run('shell', 'ps', '-A', '-o', 'PID,NAME');
  if (!ps.split(/\r?\n/).some(line => new RegExp(`^\\s*${pid}\\s+${QA_PACKAGE.replaceAll('.', '\\.')}\\s*$`).test(line))) throw new Error('QA PID does not match the exact QA package in process list');
  const packageInfo = run('shell', 'dumpsys', 'package', QA_PACKAGE);
  if (!packageInfo.includes(`Package [${QA_PACKAGE}]`)) throw new Error('QA package is not installed');
  const productionPid = (() => { try { return run('shell', 'pidof', PRODUCTION_PACKAGE); } catch { return ''; } })();
  if (productionPid.split(/\s+/).includes(pid)) throw new Error('QA and production process identities overlap');
  report.device = { serial: run('get-serialno'), model: run('shell', 'getprop', 'ro.product.model') };
  const originalInitialize = CRBrowserContext.prototype._initialize;
  CRBrowserContext.prototype._initialize = function () { this._options.acceptDownloads = 'internal-browser-default'; return originalInitialize.call(this); };
  const existingForward = run('forward', '--list').split(/\r?\n/).find(line => line.includes(`tcp:${PORT} `));
  if (existingForward && !existingForward.endsWith(`localabstract:webview_devtools_remote_${pid}`)) throw new Error(`CDP port ${PORT} already belongs to a different socket`);
  if (!existingForward) { run('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`); forwarded = true; }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('https://localhost'));
  if (!page || !page.url().startsWith('https://localhost')) throw new Error('QA PID WebView has no https://localhost app page');
  cdp = await page.context().newCDPSession(page);
  report.identity = { qaPid: pid, productionPid: productionPid || null, pageUrl: page.url(), socket: `webview_devtools_remote_${pid}`, versionName: /versionName=([^\s]+)/.exec(packageInfo)?.[1] || null };
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('requestfailed', request => report.requestFailures.push({ url: request.url(), failure: request.failure()?.errorText }));
  page.on('dialog', dialog => dialog.type() === 'confirm' && dialog.message().includes('清空这次作答的笔迹') ? dialog.accept() : dialog.dismiss());
  await check(1, async () => { expect(report.identity.pageUrl).toMatch(/^https:\/\/localhost/); return `package=${QA_PACKAGE}; PID=${pid}; dedicated socket verified`; });

  // Re-runs can start on any authenticated QA page, including a failed
  // training session. Switch through the QA UI and create a fresh account.
  const accountCard = page.locator('.account-card');
  const switchAccount = page.getByRole('button', { name: '切换账号', exact: true });
  const settings = page.getByRole('button', { name: '设置', exact: true });
  const mobileSettings = page.getByRole('button', { name: '打开设置', exact: true });
  if (await page.locator('.reader-page').isVisible()) {
    await page.getByRole('button', { name: '长难句训练', exact: true }).click();
    await expect(loc(page, 'page')).toBeVisible();
  }
  await expect.poll(async () => await accountCard.isVisible() || await switchAccount.isVisible() || await settings.isVisible() || await mobileSettings.isVisible(), { timeout: 30000 }).toBe(true);
  if (!(await accountCard.isVisible())) {
    if (!(await switchAccount.isVisible())) {
      if (await settings.isVisible()) await settings.click();
      else await mobileSettings.click();
    }
    await switchAccount.click();
    await accountCard.waitFor({ timeout: 30000 });
  }
  if (await page.getByRole('button', { name: '创建新账号', exact: true }).isVisible()) await page.getByRole('button', { name: '创建新账号', exact: true }).click();
  // The prior account may have left a session hash in the shared WebView URL.
  // Clear only navigation before mounting the new account's WorkspaceApp.
  await page.evaluate(() => history.replaceState(history.state, '', location.pathname + location.search));
  const user = `longsentence-tabletqa-${Date.now().toString(36)}`;
  await page.locator('input[autocomplete="username"]').fill(user);
  await page.locator('input[type="password"]').nth(0).fill('isolated-qa-123');
  await page.locator('input[type="password"]').nth(1).fill('isolated-qa-123');
  await page.locator('.account-submit').click();
  await page.locator('.home-page').waitFor({ timeout: 30000 });
  report.account = user;
  await seed(user);
  const originalBefore = await originalFacts(user);
  await check(2, async () => { expect((await userRows('custom-pdfs', user)).some(row => row.id === RESOURCE)).toBe(true); return `new account ${user}; synthetic custom PDF and unknown words`; });
  const ai = { generate: 0, evaluate: 0, requests: [] };
  await page.route('https://api.deepseek.com/**', async route => {
    const body = route.request().postDataJSON(); ai.requests.push(body);
    const sources = block(body.messages, 'source_sentences');
    if (sources) {
      ai.generate++;
      const params = block(body.messages, 'generation_parameters');
      const words = block(body.messages, 'target_words') || [];
      const items = Array.from({ length: params.count }, (_, index) => {
        const item = qualityItem({ text: GENERATED_CANDIDATES[index], sourceReviewIds: sources.map(source => source.sourceReviewId), fingerprint: params.structureFingerprint || TRAINING_FINGERPRINT, uses: index === 0 ? words.slice(0, 2).map(({ wordId, word }) => ({ wordId, word, surfaceForm: word })) : [] });
        const sourceDifficulties = sources.map(source => ({ sourceReviewId: source.sourceReviewId, difficulty: source.difficulty ?? 2 }));
        const difficulty = Math.max(...sourceDifficulties.map(source => source.difficulty));
        Object.assign(item.difficultyMetadata, { sourceDifficulties, sourceDifficulty: difficulty, targetDifficulty: difficulty + 1, difficultyDelta: 1 });
        return item;
      });
      await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify({ items }) } }] } });
    } else {
      ai.evaluate++;
      await route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(TRAINING_EVALUATION) } }] } });
    }
  });
  await nav('长难句'); await expect(loc(page, 'page')).toBeVisible();
  await check(3, async () => { for (const tab of ['生成训练', '待掌握', '待复习', '已学习', '学习记录']) await expect(page.getByRole('tab', { name: tab, exact: true })).toBeVisible(); return 'all five tabs visible'; });
  await check(4, async () => { await expect(page.locator('.ls-source-tree')).toContainText('Text A'); await expect(page.locator('.ls-source-tree')).toContainText(TRAINING_SOURCE); return 'year/article/sentence tree visible'; });
  await check(5, async () => { const boxes = loc(page, 'source-checkbox'); await expect(boxes).toHaveCount(2); await boxes.first().check(); const parent = page.locator('.ls-article > summary input[type="checkbox"]').first(); await expect(parent).toHaveAttribute('aria-checked', 'mixed'); await parent.check(); await expect(boxes.nth(0)).toBeChecked(); await expect(boxes.nth(1)).toBeChecked(); return 'individual selection, parent half-select, then parent select-all'; });
  await check(6, async () => { for (const word of ['reinforce', 'constrain']) await expect(page.getByRole('checkbox', { name: new RegExp(word) })).toBeChecked(); await page.getByRole('checkbox', { name: /constrain/ }).uncheck(); await expect(page.getByRole('checkbox', { name: /constrain/ })).not.toBeChecked(); await page.getByRole('checkbox', { name: /constrain/ }).check(); return 'word union and user deselection persisted in selection'; });
  await check(7, async () => { const values = await loc(page, 'count').locator('option').evaluateAll(options => options.map(option => Number(option.value))); expect(values).toEqual([1, 2, 3, 4, 5]); await loc(page, 'count').selectOption('1'); return 'selector offers integers 1–5'; });
  await check(8, async () => {
    await loc(page, 'generate').click();
    try { await expect(loc(page, 'sentence')).toBeVisible({ timeout: 60000 }); }
    catch (error) {
      const alerts = await loc(page, 'page').locator('[role="alert"]').allTextContents();
      throw new Error(`Generate did not open a sentence: ${alerts.join(' | ') || error.message}`);
    }
    expect(ai.generate).toBe(1);
    const [item] = await userRows('long-sentence-items', user);
    expect(item.difficultyMetadata.targetDifficulty).toBeGreaterThan(item.difficultyMetadata.sourceDifficulty);
    expect(item.text).not.toBe(TRAINING_SOURCE);
    return 'one intercepted batch request, above-source metadata and distinct generated text; model quality not claimed';
  });
  await check(9, async () => { await expect(loc(page, 'evaluation')).toHaveCount(0); expect(await page.locator('body').textContent()).not.toContain(TRAINING_EVALUATION.referenceTranslation); expect(JSON.stringify(await userRows('long-sentence-items', user))).not.toContain('referenceTranslation'); return 'no answer in DOM or generated item store'; });
  await screenshot('generated-before-answer');
  const surface = page.locator('.writing-ink-surface').first(); await surface.scrollIntoViewIfNeeded();
  await check(10, async () => {
    await expect(surface).toBeVisible();
    for (const label of ['笔', '橡皮', '撤销', '清空笔迹']) await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(1);
    const toolbar = await page.locator('.ls-paper-workspace > .annotation-toolbar').boundingBox();
    const sentence = await loc(page, 'sentence').boundingBox();
    if (!toolbar || !sentence || toolbar.y + toolbar.height > sentence.y) throw new Error('共享笔工具栏遮挡英文句纸');
    return 'shared toolbar buttons accessible and toolbar ends above the English sentence';
  });
  const box = await surface.boundingBox(); if (!box) throw new Error('Sentence paper has no position');
  await check(11, async () => {
    await stroke(box, 0);
    await expect.poll(async () => (await inkRows(user)).reduce((sum, row) => sum + row.strokes.length, 0)).toBe(1);
    await stroke(box, 30);
    await expect.poll(async () => (await inkRows(user)).reduce((sum, row) => sum + row.strokes.length, 0)).toBe(2);
    return 'two sequential synthetic pen strokes persisted in long-sentence-ink, clear of the floating toolbar';
  });
  await check(12, async () => { await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await inkRows(user)).reduce((sum, row) => sum + row.strokes.length, 0)).toBe(1); return 'undo persisted one remaining stroke'; });
  await check(13, async () => {
    await page.getByRole('button', { name: '橡皮', exact: true }).click();
    await expect(page.getByRole('button', { name: '普通', exact: true })).toHaveClass(/active/);
    await stroke(box, 0);
    await expect.poll(async () => (await inkRows(user)).flatMap(row => row.strokes).filter(stroke => stroke.tool === 'eraser').length).toBe(1);
    await screenshot('normal-eraser-synthetic');
    await page.getByRole('button', { name: '笔', exact: true }).click();
    await stroke(box, 30);
    await expect.poll(async () => (await inkRows(user)).reduce((sum, row) => sum + row.strokes.length, 0)).toBe(3);
    await page.getByRole('button', { name: '橡皮', exact: true }).click();
    await page.getByRole('button', { name: '自由套索', exact: true }).click();
    await expect(page.getByRole('button', { name: '自由套索', exact: true })).toHaveClass(/active/);
    const firstLine = inkLineY(box, 0);
    await penGesture([[box.x + 14, firstLine + 17], [box.x + 230, firstLine + 17], [box.x + 230, firstLine + 52], [box.x + 14, firstLine + 52], [box.x + 14, firstLine + 17]]);
    await expect.poll(async () => (await inkRows(user)).reduce((sum, row) => sum + row.strokes.length, 0)).toBe(2);
    await screenshot('lasso-deletion-synthetic');
    return 'CDP synthetic normal eraser stroke persisted; free-lasso gesture removed a selected pen stroke; physical stylus unverified';
  });
  await check(14, async () => { await page.getByRole('button', { name: '清空笔迹', exact: true }).click(); await expect.poll(async () => (await inkRows(user)).reduce((sum, row) => sum + row.strokes.length, 0)).toBe(0); return 'clear persisted empty ink'; });
  await page.getByRole('button', { name: '笔', exact: true }).click(); await stroke(box, 0);
  await expect.poll(async () => (await inkRows(user)).reduce((sum, row) => sum + row.strokes.length, 0)).toBe(1);
  await screenshot('synthetic-ink');
  const initialLayout = (await userRows('long-sentence-attempts', user))[0]?.layout;
  const beforeRotationInk = await inkRows(user);
  await optionalCheck(15, async () => {
    const acceleration = run('shell', 'settings', 'get', 'system', 'accelerometer_rotation');
    const rotation = run('shell', 'settings', 'get', 'system', 'user_rotation');
    const beforeSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const target = rotation === '0' ? '1' : '0';
    report.deviceEvidence.rotation = { before: { acceleration, rotation, viewport: beforeSize }, target };
    const restore = (key, value) => run('shell', 'settings', value === 'null' ? 'delete' : 'put', 'system', key, ...(value === 'null' ? [] : [value]));
    try {
      run('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
      run('shell', 'settings', 'put', 'system', 'user_rotation', target);
      await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })), { timeout: 15000 }).not.toEqual(beforeSize);
      const afterSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      report.deviceEvidence.rotation.after = afterSize;
      await expect(loc(page, 'sentence')).toBeVisible();
      expect((await userRows('long-sentence-attempts', user))[0]?.layout).toEqual(initialLayout);
      expect((await inkRows(user)).map(row => row.strokes)).toEqual(beforeRotationInk.map(row => row.strokes));
      await screenshot('system-rotation');
      return `ADB user_rotation ${rotation}→${target}; WebView ${beforeSize.width}×${beforeSize.height}→${afterSize.width}×${afterSize.height}; logical layout and ink rows unchanged`;
    } finally {
      try { restore('user_rotation', rotation); } finally { restore('accelerometer_rotation', acceleration); }
      await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })), { timeout: 15000 }).toEqual(beforeSize);
    }
  });
  const originalStatus = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).sentences, scoped(user, `wuliao:translation-progress:${RESOURCE}:${PASSAGE}`));
  const translation = '尽管大气条件限制推断，天文学家的研究仍表明遥远的行星适宜居住。';
  await loc(page, 'translation').fill(translation);
  let imeShown = false;
  try {
    report.deviceEvidence.foregroundBeforeIme = resumedActivity();
    report.deviceEvidence.foregroundBeforeIme = await ensureQaForeground();
    const edit = await loc(page, 'translation').boundingBox();
    const dpr = await page.evaluate(() => devicePixelRatio);
    if (!edit) throw new Error('translation textarea has no device position');
    run('shell', 'input', 'tap', String(Math.round((edit.x + 20) * dpr)), String(Math.round((edit.y + 20) * dpr)));
    await expect.poll(() => /(?:mInputShown|isInputViewShown|mShowRequested)=true/.test(run('shell', 'dumpsys', 'input_method')), { timeout: 6000 }).toBe(true);
    imeShown = true;
    const ime = run('shell', 'dumpsys', 'input_method');
    await loc(page, 'submit').scrollIntoViewIfNeeded();
    const button = await loc(page, 'submit').boundingBox();
    const height = await page.evaluate(() => innerHeight);
    if (!button || button.y + button.height > height + 2) throw new Error('submit button is obscured by IME after scroll');
    report.deviceEvidence.ime = { status: 'PASS', indicator: /(?:mInputShown|isInputViewShown|mShowRequested)=true/.exec(ime)?.[0], buttonBottom: button.y + button.height, viewportHeight: height };
    await screenshot('ime-submit-visible');
  } catch (error) {
    report.deviceEvidence.ime = { status: imeShown ? 'FAIL' : 'NOT COVERED', reason: imeShown ? error.message : `软键盘未取得可验证显示状态：${error.message.split('\n')[0]}` };
    await screenshot('ime-not-covered').catch(() => {});
  } finally { if (imeShown) run('shell', 'input', 'keyevent', '4'); }
  await check(16, async () => { await expect(loc(page, 'translation')).toHaveValue(translation); await loc(page, 'submit').click(); await expect(loc(page, 'evaluation')).toBeVisible({ timeout: 60000 }); return 'typed translation submitted and saved'; });
  await check(17, async () => { expect(ai.evaluate).toBe(1); await expect(loc(page, 'evaluation')).toContainText('AI 参考解析'); const payload = block(ai.requests.at(-1).messages, 'evaluation_data'); expect(payload.userTranslation).toBe(translation); expect(JSON.stringify(payload)).not.toContain('strokes'); return 'single mock Evaluate; payload has translation and no ink'; });
  await check(18, async () => { await page.getByRole('button', { name: '解析有误', exact: true }).click(); await expect.poll(async () => (await userRows('long-sentence-evaluations', user))[0]?.analysisFeedback).toBe('incorrect'); await page.getByRole('button', { name: '重新解析', exact: true }).click(); await expect.poll(async () => (await userRows('long-sentence-evaluations', user)).length).toBe(2); return 'old incorrect-marked evaluation retained alongside new version'; });
  await check(19, async () => { await page.getByRole('button', { name: '已掌握', exact: true }).click(); await expect.poll(async () => (await userRows('long-sentence-attempts', user))[0]?.userRating).toBe('mastered'); const status = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).sentences, scoped(user, `wuliao:translation-progress:${RESOURCE}:${PASSAGE}`)); expect(status).toEqual(originalStatus); return 'training self-rating leaves both original sentence review states untouched'; });
  const factsAfterTraining = await originalFacts(user);
  await screenshot('rated-training');
  await nav('长难句'); await page.getByRole('tab', { name: '已学习', exact: true }).click(); await expect(loc(page, 'page')).not.toContainText(TRAINING_SOURCE);
  await page.getByRole('tab', { name: '待掌握', exact: true }).click();
  await page.getByRole('button', { name: '复习原句', exact: true }).first().click();
  await check(20, async () => { await expect(page.locator('.review-session')).toBeVisible(); await page.getByRole('button', { name: '现在能独立理解', exact: true }).click(); await expect.poll(async () => (await page.evaluate(key => JSON.parse(localStorage.getItem(key)).sentences, scoped(user, `wuliao:translation-progress:${RESOURCE}:${PASSAGE}`)))[SOURCE_KEY].reviewStatus).toBe('mastered'); return 'existing original ReviewSession mastered action'; });
  await page.getByRole('button', { name: '完成本次复查', exact: true }).click(); await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await nav('长难句'); await page.getByRole('tab', { name: '已学习', exact: true }).click();
  await check(21, async () => { await expect(loc(page, 'page')).toContainText(TRAINING_SOURCE); return 'original source enters 已学习 only after normal review completion'; });
  const factsAfterReview = await originalFacts(user);
  report.deviceEvidence.originalFacts = { status: JSON.stringify(factsAfterTraining) === JSON.stringify(originalBefore) ? 'PASS' : 'FAIL', afterOriginalReviewUnchanged: JSON.stringify(factsAfterReview) === JSON.stringify(originalBefore), keys: Object.keys(originalBefore), note: 'QA fixture only; production preservation requires separate backup/device comparison' };
  if (report.deviceEvidence.originalFacts.status === 'FAIL') report.deviceEvidence.originalFacts.reason = 'first/redo/evidence/readingFlow changed during generated training';
  await screenshot('learned-original');
  const generatedCounts = [1];
  try {
    for (const count of [2, 3, 4, 5]) {
      await nav('长难句');
      await page.getByRole('tab', { name: '生成训练', exact: true }).click();
      const sourceBoxes = loc(page, 'source-checkbox');
      await expect(sourceBoxes.first()).toBeVisible();
      if (!(await sourceBoxes.first().isChecked())) await sourceBoxes.first().check();
      await loc(page, 'count').selectOption(String(count));
      const beforeIds = new Set((await userRows('long-sentence-sessions', user)).map(session => session.id));
      await loc(page, 'generate').click();
      await expect(loc(page, 'sentence')).toBeVisible({ timeout: 60000 });
      const created = (await userRows('long-sentence-sessions', user)).find(session => !beforeIds.has(session.id));
      if (!created) throw new Error(`count ${count}: generated session not saved`);
      expect(created.count).toBe(count);
      await expect.poll(async () => (await userRows('long-sentence-items', user)).filter(item => item.sessionId === created.id).length).toBe(count);
      generatedCounts.push(count);
      await screenshot(`generated-${count}`);
    }
    report.deviceEvidence.counts = { status: 'PASS', generatedCounts, note: '1–5 each generated through isolated QA WebView with route-mocked text Provider' };
  } catch (error) {
    report.deviceEvidence.counts = { status: 'FAIL', generatedCounts, reason: error.message };
    await screenshot('generated-counts-failed').catch(() => {});
  }
  if (generatedCounts.includes(5)) {
    try {
      const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).sentences, scoped(user, `wuliao:translation-progress:${RESOURCE}:${PASSAGE}`));
      await loc(page, 'translation').fill('隔离测试：虽然资料并不完整，研究人员仍解释了结论。');
      await loc(page, 'submit').click();
      await expect(loc(page, 'evaluation')).toBeVisible({ timeout: 60000 });
      await page.getByRole('button', { name: '仍困难', exact: true }).click();
      await expect.poll(async () => (await userRows('long-sentence-attempts', user)).some(attempt => attempt.userRating === 'difficult')).toBe(true);
      const after = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).sentences, scoped(user, `wuliao:translation-progress:${RESOURCE}:${PASSAGE}`));
      expect(after).toEqual(before);
      report.deviceEvidence.ratings = { status: 'PASS', choices: ['mastered', 'difficult'], note: 'both choices saved; original sentence statuses unchanged' };
      await screenshot('rated-difficult');
    } catch (error) { report.deviceEvidence.ratings = { status: 'FAIL', reason: error.message }; await screenshot('rated-difficult-failed').catch(() => {}); }
  }
  await optionalCheck(24, async () => {
    await nav('长难句');
    await page.getByRole('tab', { name: '学习记录', exact: true }).click();
    await page.getByRole('button', { name: '查看记录', exact: true }).first().click();
    await expect(loc(page, 'sentence')).toBeVisible();
    await page.getByRole('button', { name: '重新作答', exact: true }).click();
    const offlineDraft = '离线保存的隔离测试译文';
    await cdp.send('Network.enable');
    try {
      await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      await loc(page, 'translation').fill(offlineDraft);
      await expect.poll(async () => (await userRows('long-sentence-attempts', user)).some(attempt => attempt.userTranslation === offlineDraft)).toBe(true);
    } finally {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
    await screenshot('offline-draft');
    return 'network emulation offline; translation draft persisted in isolated account';
  });
  await optionalCheck(23, async () => {
    run('shell', 'input', 'keyevent', '3');
    run('shell', 'am', 'start', '-n', `${QA_PACKAGE}/com.wuliao.english.MainActivity`);
    await expect(loc(page, 'page')).toBeVisible({ timeout: 30000 });
    await expect(loc(page, 'translation')).toHaveValue('离线保存的隔离测试译文');
    return 'QA package backgrounded and resumed; draft remains';
  });
  await optionalCheck(25, async () => {
    await nav('精读');
    await page.getByRole('tab', { name: /自定义库/ }).click();
    const card = page.locator('.resource-card', { hasText: '长难句平板隔离验收资料' }).first();
    await expect(card).toBeVisible();
    await card.locator('.resource-open').click();
    await expect(page.locator('.reader-page')).toBeVisible({ timeout: 60000 });
    const beforeHash = new URL(page.url()).hash;
    const entry = page.getByRole('button', { name: '长难句训练', exact: true });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(loc(page, 'page')).toBeVisible();
    await page.getByRole('button', { name: '返回精读', exact: true }).click();
    await expect(page.locator('.reader-page')).toBeVisible();
    expect(new URL(page.url()).hash).toBe(beforeHash);
    return 'custom Reader entry returned to same hash and visible Reader';
  });
  // This is the only step that changes device radios. Require readable prior
  // values, restore both values in finally, and never involve production data.
  let airplaneRestored = false;
  try {
    const airplaneBefore = run('shell', 'settings', 'get', 'global', 'airplane_mode_on');
    const wifiBefore = run('shell', 'settings', 'get', 'global', 'wifi_on');
    if (airplaneBefore !== '0' || !/^[01]$/.test(wifiBefore)) {
      report.deviceEvidence.airplane = { status: 'NOT COVERED', reason: `initial radio state is unsuitable or unreadable: airplane=${airplaneBefore}, wifi=${wifiBefore}` };
    } else {
      let changed = false;
      try {
        if (await page.locator('.reader-page').isVisible()) {
          await page.getByRole('button', { name: '长难句训练', exact: true }).click();
          await expect(loc(page, 'page')).toBeVisible();
        } else await nav('长难句');
        await page.getByRole('tab', { name: '学习记录', exact: true }).click();
        await page.getByRole('button', { name: '查看记录', exact: true }).first().click();
        await expect(loc(page, 'sentence')).toBeVisible();
        if (!(await loc(page, 'translation').isEditable())) await page.getByRole('button', { name: '重新作答', exact: true }).click();
        run('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'); changed = true;
        run('shell', 'svc', 'wifi', 'disable');
        await expect.poll(() => run('shell', 'settings', 'get', 'global', 'airplane_mode_on')).toBe('1');
        await expect.poll(() => run('shell', 'settings', 'get', 'global', 'wifi_on')).toBe('0');
        const flightDraft = '飞行模式中保存的隔离测试译文';
        await loc(page, 'translation').fill(flightDraft);
        await expect.poll(async () => (await userRows('long-sentence-attempts', user)).some(attempt => attempt.userTranslation === flightDraft)).toBe(true);
        await expect(loc(page, 'sentence')).toBeVisible();
        await screenshot('actual-airplane-mode-draft');
        report.deviceEvidence.airplane = { status: 'PASS', airplaneBefore, wifiBefore, airplaneDuring: '1', wifiDuring: '0', note: 'system airplane mode and Wi-Fi off; local sentence and draft remained usable' };
      } catch (error) {
        report.deviceEvidence.airplane = { status: changed ? 'FAIL' : 'NOT COVERED', reason: error.message, airplaneBefore, wifiBefore };
        await screenshot('airplane-mode-failed').catch(() => {});
      } finally {
        try {
          run('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable');
          run('shell', 'svc', 'wifi', wifiBefore === '1' ? 'enable' : 'disable');
          await expect.poll(() => run('shell', 'settings', 'get', 'global', 'airplane_mode_on')).toBe(airplaneBefore);
          await expect.poll(() => run('shell', 'settings', 'get', 'global', 'wifi_on')).toBe(wifiBefore);
          airplaneRestored = true;
        } catch (error) {
          report.deviceEvidence.airplane = { ...report.deviceEvidence.airplane, status: 'FAIL', restoreError: error.message };
        }
      }
    }
  } catch (error) { report.deviceEvidence.airplane = { status: 'NOT COVERED', reason: `radio state could not be read: ${error.message}` }; }
  if (airplaneRestored && report.deviceEvidence.airplane?.status === 'PASS') {
    try {
      await nav('长难句');
      await page.getByRole('tab', { name: '生成训练', exact: true }).click();
      const sourceBox = loc(page, 'source-checkbox').first();
      await expect(sourceBox).toBeVisible();
      if (!(await sourceBox.isChecked())) await sourceBox.check();
      await loc(page, 'count').selectOption('1');
      const previousCalls = ai.generate;
      await loc(page, 'generate').click();
      await expect(loc(page, 'sentence')).toBeVisible({ timeout: 60000 });
      expect(ai.generate).toBe(previousCalls + 1);
      report.deviceEvidence.networkRecovery = { status: 'PASS', note: 'system radios restored to original values; new Generate reached intercepted text Provider' };
      await screenshot('after-airplane-recovery');
    } catch (error) { report.deviceEvidence.networkRecovery = { status: 'FAIL', reason: error.message }; await screenshot('network-recovery-failed').catch(() => {}); }
  }
  report.checklist.find(entry => entry.id === 26).evidence = '需要人工使用实体 M-Pencil 验证触感、落点和压感；CDP 合成事件不构成证据';
  report.checklist.find(entry => entry.id === 22).evidence = '未推进本地日期并重跑同技能新句；需独立到期验收';
  expect(report.pageErrors).toEqual([]);
} catch (error) {
  report.fatal = { step: active || 'setup', message: error.message, stack: error.stack };
  await screenshot('fatal').catch(() => {});
  console.error(error);
} finally {
  try { report.identity.finalResumedActivity = await ensureQaForeground(); }
  catch (error) { report.deviceEvidence.finalForeground = { status: 'NOT COVERED', reason: error.message }; }
  report.finishedAt = new Date().toISOString();
  report.summary = Object.fromEntries(['PASS', 'FAIL', 'NOT COVERED'].map(status => [status, report.checklist.filter(item => item.status === status).length]));
  const statusFor = ids => {
    const statuses = ids.map(id => report.checklist[id - 1].status);
    return statuses.includes('FAIL') ? 'FAIL' : statuses.every(status => status === 'PASS') ? 'PASS' : 'NOT COVERED';
  };
  const acceptance = (id, name, status, evidence) => ({ id, name, status, evidence });
  report.tabletAcceptance = [
    acceptance(1, '一级“长难句”入口', statusFor([3]), 'QA WebView 一级导航及五个子页'),
    acceptance(2, '待掌握来源树', statusFor([4]), '隔离自定义资料的章节/文章/句子树'),
    acceptance(3, '已学习模块', statusFor([21]), '原句正常复习后进入已学习'),
    acceptance(4, '多选 / 全选 / 半选', statusFor([5]), '单句勾选、父级半选、父级全选三态'),
    acceptance(5, '生成 1–5', report.deviceEvidence.counts?.status || 'NOT COVERED', report.deviceEvidence.counts?.status === 'PASS' ? '隔离 QA WebView 分别实际生成 1、2、3、4、5 句，响应为 route mock' : report.deviceEvidence.counts?.reason || '未逐一验证 1–5 生成'),
    acceptance(6, '当前 Provider/Model 复用', 'NOT COVERED', '本脚本拦截请求，真实 Provider/Model 由主代理 live smoke 核验'),
    acceptance(7, '不要求第二次输入 API Key', 'NOT COVERED', '隔离账号预置假测试 Key，不能证明正式账号已有 Key 复用'),
    acceptance(8, '新句难度明显高于来源', 'NOT COVERED', '固定样本与元数据仅验证 UI/validator，不能代替真实模型质量验收'),
    acceptance(9, '提交前没有答案泄漏', statusFor([9]), 'DOM 与 generated item store 均无参考译文'),
    acceptance(10, 'M-Pencil 可以直接在英文句上划', 'NOT COVERED', 'CDP 合成 pen 不是实体 M-Pencil'),
    acceptance(11, 'Ink 不漂移', 'NOT COVERED', '系统旋转后布局和数据可核对，物理笔画落点仍需人工核验'),
    acceptance(12, '橡皮/undo/clear 可用', statusFor([12, 13, 14]), 'CDP 合成笔验证普通橡皮、自由套索、撤销与清空；实体 M-Pencil 仍未验证'),
    acceptance(13, '中文翻译输入', statusFor([16]), '隔离 WebView 中输入并提交中文译文'),
    acceptance(14, 'IME 不遮挡', report.deviceEvidence.ime?.status || 'NOT COVERED', report.deviceEvidence.ime?.status === 'PASS' ? 'ADB 点击弹出系统输入法，提交按钮滚动后在可视视口内；截图留证' : report.deviceEvidence.ime?.reason || '未取得系统输入法显示与按钮可达的双重证据'),
    acceptance(15, 'AI Evaluate', statusFor([17]), 'WebView 真实请求链，文本 Provider 响应由 route mock 截获；不代表 live Provider'),
    acceptance(16, '解析有误', statusFor([18]), '旧解析标记有误并保留，显式重新解析新增版本'),
    acceptance(17, '已掌握/仍困难', report.deviceEvidence.ratings?.status || 'NOT COVERED', report.deviceEvidence.ratings?.status === 'PASS' ? '隔离 QA 账号两种自评均持久化且原句状态未变' : report.deviceEvidence.ratings?.reason || '已掌握已执行；仍困难尚未验证'),
    acceptance(18, 'AI 生成句“已掌握”不会改变原句', statusFor([19]), '原句 translationProgress 前后精确比较'),
    acceptance(19, '原句正常复习正确后进入“已学习”', statusFor([20, 21]), 'ReviewSession 权威动作后展示已学习'),
    acceptance(20, '后台切换恢复', statusFor([23]), 'ADB HOME 后仅恢复 QA Activity，草稿仍在'),
    acceptance(21, '屏幕旋转/窗口变化', statusFor([15]), 'ADB 系统 user_rotation 切换并恢复；WebView 尺寸实变，逻辑布局和笔迹数据保留'),
    acceptance(22, 'Reader 返回位置', 'NOT COVERED', statusFor([25]) === 'PASS' ? 'Reader 返回与 hash 已核对；stage、滚动和焦点尚未逐项核对' : 'Reader 返回位置证据不完整'),
    acceptance(23, 'first/redo 未变化', report.deviceEvidence.originalFacts?.status || 'NOT COVERED', report.deviceEvidence.originalFacts?.status === 'PASS' ? '隔离账号 first/redo/questionEvidence/readingFlow 原始字节值保持一致' : report.deviceEvidence.originalFacts?.reason || '未取得前后比较'),
    acceptance(24, '飞行模式降级', report.deviceEvidence.airplane?.status || 'NOT COVERED', report.deviceEvidence.airplane?.status === 'PASS' ? 'ADB 系统飞行模式开启且 Wi-Fi 关闭；隔离账号句纸和草稿可用；已恢复原状态' : report.deviceEvidence.airplane?.reason || '未取得系统飞行模式直接证据'),
    acceptance(25, '网络恢复继续', report.deviceEvidence.networkRecovery?.status || 'NOT COVERED', report.deviceEvidence.networkRecovery?.status === 'PASS' ? '恢复原无线设置后新 Generate 请求成功到达 route mock；真实 Provider 连通性另验' : report.deviceEvidence.networkRecovery?.reason || '未取得系统网络恢复后继续训练证据'),
    acceptance(26, '旧学习数据全部保留', 'NOT COVERED', '仅正式包安装前后备份与关键记录对照可证明；由主代理完成')
  ];
  report.tabletAcceptanceSummary = Object.fromEntries(['PASS', 'FAIL', 'NOT COVERED'].map(status => [status, report.tabletAcceptance.filter(item => item.status === status).length]));
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output: out, identity: report.identity, scenarioSummary: report.summary, tabletAcceptanceSummary: report.tabletAcceptanceSummary, fatal: report.fatal?.message || null }, null, 2));
  if (browser) await browser.close().catch(() => {});
  if (forwarded) { try { run('forward', '--remove', `tcp:${PORT}`); } catch { /* preserve report */ } }
  if (report.fatal || report.pageErrors.length || report.tabletAcceptance.some(item => item.status === 'FAIL')) process.exitCode = 1;
}
