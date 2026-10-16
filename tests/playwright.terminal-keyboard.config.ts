import { defineConfig } from '@playwright/test';
import { getPlaywrightBaseURL, getPlaywrightPort, getPlaywrightServerEnv } from '../playwright.shared';

const port = getPlaywrightPort();
const baseURL = getPlaywrightBaseURL(port);

export default defineConfig({
  testDir: '.',
  testMatch: ['settings.spec.ts', 'terminal-keyboard-input.spec.ts', 'terminal-keyboard-native.spec.ts'],
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL, headless: true, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: `pnpm --filter frontend exec vite --host localhost --port ${port}`,
    url: baseURL,
    env: getPlaywrightServerEnv(port),
    reuseExistingServer: !process.env.CI,
  },
  reporter: 'list',
});
