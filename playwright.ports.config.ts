import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['browser-ports.spec.ts', 'port-discovery-settings.spec.ts'],
  timeout: 30000,
  expect: { timeout: 5000 },
  workers: 1,
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
});
