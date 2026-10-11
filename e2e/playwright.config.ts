import { defineConfig, devices } from '@playwright/test';

// Drives the LIVE deployed app (E2E_BASE_URL), set by the CI e2e job to
// https://<app>.proappstore.online. Run locally with:
//   E2E_BASE_URL=https://<app>.proappstore.online npx playwright test
export default defineConfig({
  testDir: './specs',
  timeout: 45000,
  expect: { timeout: 15000 },
  retries: 1,
  forbidOnly: true,
  reporter: [['github'], ['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
