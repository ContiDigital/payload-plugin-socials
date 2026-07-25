import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['dev/live.spec.ts'],
    hookTimeout: 60_000,
    testTimeout: 10 * 60_000,
  },
})
