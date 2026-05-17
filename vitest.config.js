import path from 'path'
import { loadEnv } from 'payload/node'
import { fileURLToPath } from 'url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default defineConfig(() => {
  loadEnv(path.resolve(dirname, './dev'))

  return {
    plugins: [
      tsconfigPaths({
        ignoreConfigErrors: true,
      }),
    ],
    test: {
      coverage: {
        exclude: [
          'src/**/*.{test,spec}.ts',
          'src/**/__tests__/**',
          'src/**/*.tsx',
          'src/exports/**',
          'src/types/**',
        ],
        include: ['src/**/*.ts'],
        provider: 'v8',
        reporter: ['text', 'lcov'],
        // Floors sit a few points below the current actuals (lines ~92,
        // statements ~90, functions ~87, branches ~80 once the analytics +
        // scheduled-sync coverage landed). They guard against regression
        // without being brittle. Raise them as coverage climbs; never lower
        // silently.
        thresholds: {
          branches: 78,
          functions: 85,
          lines: 89,
          statements: 87,
        },
      },
      environment: 'node',
      // Fast, deterministic, DB-free unit suite is the backbone. The
      // Payload-boot integration spec (dev/) is added once the dev harness
      // config is repaired; the Playwright e2e spec runs via `pnpm test:e2e`.
      exclude: ['**/node_modules/**', '**/dist/**', 'dev/e2e.spec.ts', 'dev/int.spec.ts'],
      hookTimeout: 30_000,
      include: ['src/**/*.{test,spec}.ts'],
      testTimeout: 30_000,
    },
  }
})
