import { defineConfig } from 'vitest/config'

// Tests that drive `docker compose` (tech design v0.7.11): only in the compose CI job (npm run test:compose)
export default defineConfig({
  test: { include: ['deploy/**/*.test.ts'], testTimeout: 900_000, hookTimeout: 900_000, fileParallelism: false },
})
