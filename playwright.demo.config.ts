import { defineConfig, devices } from '@playwright/test'

// TC-DEMO-04: the static demo snapshot, built by `npm run demo:snapshot` from a running demo (compose CI job)
export default defineConfig({
  testDir: 'e2e-demo',
  timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: 'demo-e2e-report.json' }]],
  use: { baseURL: 'http://127.0.0.1:4318', ...devices['Desktop Chrome'] },
  webServer: { command: 'node --experimental-strip-types --no-warnings e2e-demo/serve-static.ts dist-demo 4318', url: 'http://127.0.0.1:4318/', timeout: 30_000, reuseExistingServer: false },
})
