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
  // Modest headroom over Playwright's 30s default. The rig now runs a PRODUCTION build
  // (`next start`), so pages are pre-compiled and serve in well under a second — the
  // on-demand compilation that made `next dev` blow past 30s (and balloon to 5.5GB) is
  // gone. Kept above the default only because this tier crosses two external systems.
  // The full-chain specs override it with their own much larger budgets.
  timeout: 60_000,
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
