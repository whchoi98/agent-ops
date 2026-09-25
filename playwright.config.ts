import { defineConfig, devices } from '@playwright/test';

const dataDir = `.data/e2e/${Date.now().toString(36)}-${process.pid}`;
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4329',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node dist/server/index.js demo --port 4329 --data-dir ${dataDir}`,
    url: 'http://127.0.0.1:4329/api/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
