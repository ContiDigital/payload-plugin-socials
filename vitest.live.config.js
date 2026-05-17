import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['dev/live.spec.ts'],
    testTimeout: 30_000,
  },
})
