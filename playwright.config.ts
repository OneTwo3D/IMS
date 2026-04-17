import { defineConfig, devices } from '@playwright/test'
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: '.env.local', override: false })
loadDotenv({ path: '.env', override: false })

const PORT = Number(process.env.E2E_PORT ?? 3001)
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`
const webServerURL = `${baseURL.replace(/\/$/, '')}/login`

// Specs that mutate shared WooCommerce integration settings
// (wc_url / wc_consumer_key / wc_stock_sync_enabled / warehouse sync
// flags, etc.). These are unsafe to run in parallel with any other
// spec that reads those settings, so they run inside the dedicated
// `wc-isolated` project AFTER the main chromium project has fully
// completed. Add new WC-setting-mutating specs here, not to the
// main project.
const ISOLATED_SPECS = /(?:stock-sync-drift|woocommerce(?:-[\w-]+)?|security-workflows)\.spec\.ts/

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/admin.json',
      },
      dependencies: ['setup'],
      // Keep WC-setting-mutating specs out of the parallel pool. They
      // run later in `wc-isolated` with serialized ordering.
      testIgnore: ISOLATED_SPECS,
    },
    {
      // WooCommerce-setting-mutating specs. Runs strictly after
      // `chromium` completes (via `dependencies`), and disables
      // intra-file parallelism so no two tests in these specs can
      // race on shared WC integration state. The app's dev server
      // reads wc_url/credentials per request, so rewriting them
      // while chromium tests are still in flight would silently
      // corrupt those runs — `dependencies` is what prevents that.
      name: 'wc-isolated',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/admin.json',
      },
      dependencies: ['setup', 'chromium'],
      fullyParallel: false,
      testMatch: ISOLATED_SPECS,
    },
  ],
  webServer: {
    command: `npm run db:seed:e2e && npm run dev -- --hostname 0.0.0.0 --port ${PORT}`,
    url: webServerURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      AUTH_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
    },
  },
})
