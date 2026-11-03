import { defineConfig } from 'vitest/config'

export default defineConfig({
  // database tests run a 12-stage pipeline (E3); under a full parallel run one Case can take longer than the 5 s default
  test: { include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'parser/**/*.test.ts', 'eval/*.test.ts'], testTimeout: 20_000 },
})
