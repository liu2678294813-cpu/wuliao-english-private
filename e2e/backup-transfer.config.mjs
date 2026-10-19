import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({ testDir: '.', testMatch: 'backup-transfer.spec.js', timeout: 180000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', channel: 'chrome', viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  reporter: [['list']], outputDir: '../artifacts/backup-transfer-20261019/browser-results',
  webServer: { command: 'node scripts/start.mjs', cwd: fileURLToPath(new URL('..', import.meta.url)), url: 'http://127.0.0.1:4173', reuseExistingServer: false, env: { WULIAO_NO_OPEN: '1' } },
});
