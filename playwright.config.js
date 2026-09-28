import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e', workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:5174', channel: 'msedge', viewport: { width: 390, height: 844 }, trace: 'retain-on-failure' },
  webServer: { command: 'node tests/start-local-ui.js', url: 'http://127.0.0.1:5174', reuseExistingServer: true },
})
