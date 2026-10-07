import { defineConfig, devices } from '@playwright/test'

/**
 * E2E against the real API (docker compose, dev auth) and the Vite dev server.
 * Serial: every spec shares one seeded database.
 *   docker compose up -d db api && docker compose exec api python -m app.cli dev-seed
 *   cd web && npm run e2e
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
const auth = (user: string) => `e2e/.auth/${user}.json`

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: auth('george') },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
    {
      // Pixel 5, not iPhone: WebKit-on-Windows is flaky (playbook §1.8)
      name: 'mobile',
      use: { ...devices['Pixel 5'], storageState: auth('george') },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'npm run dev', url: baseURL, reuseExistingServer: true, timeout: 90_000 },
})
