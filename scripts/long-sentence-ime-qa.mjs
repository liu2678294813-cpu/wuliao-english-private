// Isolated QA package only. This does not alter production data or settings.
import { chromium, expect } from '@playwright/test';
import { CRBrowserContext } from '../node_modules/.pnpm/playwright-core@1.57.0/node_modules/playwright-core/lib/server/chromium/crBrowser.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const QA_PACKAGE = 'com.wuliao.english.longsentenceqa';
const port = '9235';
const out = resolve('output/device-qa', `ime-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(out, { recursive: true });
const adb = resolve('.android-sdk/platform-tools/adb.exe');
const prefix = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : [];
const run = (...args) => execFileSync(adb, [...prefix, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
const resumed = () => run('shell', 'dumpsys', 'activity', 'activities').split(/\r?\n/).find(line => line.includes('mResumedActivity:'))?.trim() || '';
const result = { package: QA_PACKAGE, startedAt: new Date().toISOString(), status: 'NOT COVERED', evidence: {}, output: out };
let browser, forwarded = false;
try {
  const pid = run('shell', 'pidof', QA_PACKAGE);
  if (!/^\d+$/.test(pid)) throw new Error('QA process not running');
  if (run('forward', '--list').includes(`tcp:${port} `)) throw new Error(`Port ${port} is already forwarded`);
  run('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`); forwarded = true;
  const original = CRBrowserContext.prototype._initialize;
  CRBrowserContext.prototype._initialize = function () { this._options.acceptDownloads = 'internal-browser-default'; return original.call(this); };
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('https://localhost'));
  if (!page) throw new Error('QA WebView page not found on QA PID socket');
  result.evidence.pid = pid; result.evidence.url = page.url();
  result.evidence.beforeForeground = resumed();
  if (/HwKeychainSaveActivity|com\.huawei\.securitymgr/.test(result.evidence.beforeForeground)) {
    run('shell', 'input', 'keyevent', '4');
    result.evidence.dismissedHuaweiSavePrompt = true;
  }
  await expect.poll(() => resumed(), { timeout: 15000 }).toContain(`${QA_PACKAGE}/com.wuliao.english.MainActivity`);
  result.evidence.qaForeground = resumed();
  const translation = page.getByTestId('long-sentence-translation');
  if (!(await translation.isVisible())) throw new Error('QA WebView is not on a training sentence');
  if (!(await translation.isEditable())) {
    await page.getByRole('button', { name: '重新作答', exact: true }).click();
    await expect(translation).toBeEditable();
  }
  const edit = await translation.boundingBox();
  if (!edit) throw new Error('Translation textarea has no screen position');
  const dpr = await page.evaluate(() => devicePixelRatio);
  run('shell', 'input', 'tap', String(Math.round((edit.x + 20) * dpr)), String(Math.round((edit.y + 20) * dpr)));
  const imeVisible = () => /(?:mInputShown|isInputViewShown|mShowRequested)=true/.test(run('shell', 'dumpsys', 'input_method'));
  await expect.poll(imeVisible, { timeout: 8000 }).toBe(true);
  result.evidence.imeVisible = true;
  result.evidence.foregroundWithIme = resumed();
  const button = page.getByTestId('long-sentence-submit');
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  const height = await page.evaluate(() => innerHeight);
  result.evidence.submitButtonBottom = box ? box.y + box.height : null;
  result.evidence.viewportHeight = height;
  if (!box || box.y + box.height > height + 2) throw new Error('Submit button not reachable above visible viewport');
  await page.screenshot({ path: resolve(out, 'ime-submit-visible.png') });
  result.status = 'PASS';
} catch (error) {
  result.reason = error.message.split('\n')[0];
  try {
    const served = run('shell', 'dumpsys', 'input_method').split(/\r?\n/).filter(line => /mServedView=|mShowRequested=|mInputShown=/.test(line)).slice(0, 4).map(line => line.trim());
    result.evidence.inputMethodIndicators = served;
    result.evidence.finalForeground = resumed();
  } catch { /* Keep the original limitation. */ }
} finally {
  result.finishedAt = new Date().toISOString();
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (browser) await browser.close().catch(() => {});
  if (forwarded) try { run('forward', '--remove', `tcp:${port}`); } catch { /* Report is already saved. */ }
}
