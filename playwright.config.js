import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadEnv } from 'payload/node'

loadEnv(path.resolve(process.cwd(), 'dev'))

const artifactsDir =
  process.env.PLAYWRIGHT_ARTIFACTS_DIR || path.join(tmpdir(), 'payload-plugin-socials-playwright')

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './dev',
  testMatch: '**/e2e.spec.{ts,js}',
  /* Projects share one seeded user and SQLite database, so auth writes must be serialized. */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  outputDir: path.join(artifactsDir, 'test-results'),
  reporter: [
    [
      'html',
      {
        open: 'never',
        outputFolder: path.join(artifactsDir, 'playwright-report'),
      },
    ],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm dev:e2e',
    reuseExistingServer: false,
    url: 'http://localhost:3000/admin',
  },
})
