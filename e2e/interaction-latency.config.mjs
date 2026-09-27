import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: ['interaction-latency.spec.js','vocabulary-upgrade.spec.js'],
  timeout: 180000, expect: { timeout: 15000 }, workers: 1, reporter: 'list',
  outputDir: '../output/interaction-tests',
  use: { baseURL:'http://127.0.0.1:5200', channel:'chrome', viewport:{width:1280,height:840},
    screenshot:'only-on-failure',trace:'retain-on-failure' } });
