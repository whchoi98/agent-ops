import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, fullyParallel: false, retries: 0,
  outputDir: join(tmpdir(), 'harness-component-playwright'),
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4384', headless: true,
    viewport: { width: 1280, height: 960 }, screenshot: 'only-on-failure', trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: {
    command: 'node --import tsx src/features/harness/tests/browser-fixture.ts',
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    url: 'http://127.0.0.1:4384/__harness', reuseExistingServer: false, timeout: 30000,
  },
});
