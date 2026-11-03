import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: 'e2e-report.json' }]],
  use: { baseURL: 'http://127.0.0.1:4317', ...devices['Desktop Chrome'] },
  webServer: { command: 'npm run build && node --experimental-strip-types --no-warnings e2e/serve.ts', url: 'http://127.0.0.1:4317/', timeout: 180_000, reuseExistingServer: false },
})
