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
        // Browser components are exercised by Playwright; these thresholds
        // measure the server and pure-model TypeScript surface.
        thresholds: {
          branches: 78,
          functions: 85,
          lines: 89,
          statements: 87,
        },
      },
      environment: 'node',
      // Payload boot coverage lives under src; browser behavior runs through Playwright.
      exclude: ['**/node_modules/**', '**/dist/**', 'dev/e2e.spec.ts', 'dev/int.spec.ts'],
      hookTimeout: 30_000,
      include: ['src/**/*.{test,spec}.ts'],
      testTimeout: 30_000,
    },
  }
})
