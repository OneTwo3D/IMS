import baseConfig from './playwright.config'

/**
 * Config for the full-chain tier (o3d-lgo).
 *
 * Differs from the base config in three ways, each of which is load-bearing:
 *
 *  - NO webServer. The tier runs against the dedicated e2e instance
 *    (ims-e2e-dev.service, its own DB and its own Xero app), which is already up under
 *    systemd. The base webServer would start a SECOND server that loads .env — the
 *    runbook records that this silently targets the STAGE database.
 *  - globalSetup/globalTeardown take the quiesce lock, so stage cannot race the run and
 *    is restored even when tests fail.
 *  - retries: 0. A full-chain test posts real documents to a shared ledger and creates
 *    real Woo orders; a blind retry would double-post and then assert on the wrong
 *    document. Failures here are meant to be read, not retried away.
 */
const fullChainConfig = {
  ...baseConfig,
  webServer: undefined,
  retries: 0,
  // Playwright's 30s default is too short here. The rig runs `next dev`, so the FIRST
  // request to a route compiles it — /dashboard can take over 30s, and auth.setup then
  // fails on waitForURL(**\/dashboard) with a bare timeout that reads like bad
  // credentials. It is not; the page simply was not built yet. globalSetup warms what it
  // can, but /dashboard is behind auth so an unauthenticated warm only reaches the 307
  // redirect and never compiles the page itself — hence a real timeout, not a workaround.
  // The full-chain spec overrides this with its own (much larger) budget.
  timeout: 120_000,
  globalSetup: './e2e/full-chain/harness/global-setup.ts',
  globalTeardown: './e2e/full-chain/harness/global-teardown.ts',
  // Spreading baseConfig inherits ALL its projects, which would drag the entire local
  // suite (136 tests) onto the shared e2e instance behind a quiesce lock. Keep only
  // auth setup and the full-chain project itself.
  projects: (baseConfig.projects ?? []).filter((p) => p.name === 'setup' || p.name === 'full-chain'),
  use: {
    ...baseConfig.use,
    baseURL: process.env.E2E_BASE_URL ?? 'https://ims-e2e.onetwo3d.co.uk',
  },
}

export default fullChainConfig
