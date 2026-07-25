/**
 * Playwright global setup/teardown for the full-chain tier (o3d-lgo.4).
 *
 * The lock MUST be released even when tests fail, time out, or the process is killed —
 * a held lock leaves stage disabled and silently not importing orders. globalTeardown
 * runs after failures, which is why the lock lives here rather than in a fixture.
 * (It cannot survive SIGKILL; that is what acquire()'s stale-lock recovery and
 * scripts/restore-stage-connectors.ts are for.)
 */
import { readFileSync } from 'node:fs'
import { assertPreflight } from './preflight.ts'
import { acquire } from './quiesce.ts'
import { newRunId, runTag } from './tag.ts'

const RUN_ID_FILE = '.full-chain-run-id'

export default async function globalSetup(): Promise<void> {
  // Preflight BEFORE taking the lock: no point disabling stage to discover the tenant
  // is wrong or the queue is dirty.
  await assertPreflight()

  const runId = newRunId()
  console.log(`\n[full-chain] run ${runTag(runId)}`)

  // NOTHING SHARED IS TOUCHED BEFORE THE LOCK IS OURS (o3d-lgo.14). Everything below mutates state a
  // concurrently running suite depends on — the rig's fx_rates and the run-id file its workers read — and
  // an invocation that gets REFUSED the lock still executes every line up to the throw. Preflight above is
  // read-only, so it stays first: no point disabling stage to discover the tenant is wrong.
  await acquire(runId)
  console.log('[full-chain] stage quiesced; delivery webhooks live.')

  // Recover the FX baseline. The rig keeps fx_rates EMPTY on purpose: a foreign-currency order with no
  // seeded rate must quarantine (getFxRateToGbp throws MissingFxRateError), which OC-10/OC-17 rely on.
  // An FX test seeds exactly the rate it needs and deletes it in finally, but a crash between the INSERT
  // and that cleanup would strand an eligible rate and silently import LATER foreign orders at it. Sweep
  // any e2e-seeded rows here so every run starts from the intended empty baseline regardless of how a
  // prior run died.
  await sweepSeededFxRates()

  // The workers learn the tag from this file, so publish it only once the run is really ours.
  const { writeFileSync } = await import('node:fs')
  writeFileSync(RUN_ID_FILE, runId)
  process.env.FULL_CHAIN_RUN_ID = runId

  await warmRoutes()
  console.log('')
}

/**
 * Compile what we can before the tests start.
 *
 * The rig runs `next dev`, so the first request to a route compiles it. /login is worth
 * warming. /dashboard is NOT fully warmable from here: it is behind auth, so an
 * unauthenticated request only reaches the 307 redirect and the page itself never
 * builds — which is why warming alone did not stop auth.setup flaking, and why the
 * full-chain config also raises the test timeout to 120s.
 */
async function warmRoutes(): Promise<void> {
  const base = (process.env.E2E_BASE_URL ?? 'https://ims-e2e.onetwo3d.co.uk').replace(/\/$/, '')
  for (const path of ['/login']) {
    const started = Date.now()
    try {
      await fetch(`${base}${path}`, { signal: AbortSignal.timeout(120_000), redirect: 'manual' })
      const ms = Date.now() - started
      if (ms > 5_000) console.log(`[full-chain] warmed ${path} (${(ms / 1000).toFixed(1)}s — it was cold)`)
    } catch (e) {
      // Not fatal: the test will report the real failure better than we can here.
      console.warn(`[full-chain] could not warm ${path}: ${e instanceof Error ? e.message : e}`)
    }
  }
}

/**
 * Delete any e2e-seeded FX rates (source='e2e-fc-seed') left behind by a crashed FX test, restoring the
 * rig's empty-fx_rates baseline. Idempotent and safe: production/frankfurter rows carry a different source
 * and are never touched.
 */
async function sweepSeededFxRates(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) return
  const { Client } = await import('pg')
  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    const r = await db.query(`delete from fx_rates where source = 'e2e-fc-seed'`)
    if (r.rowCount) {
      console.log(`[full-chain] cleared ${r.rowCount} leftover e2e-seeded FX rate(s) — restoring the empty-fx_rates baseline`)
    }
  } finally {
    await db.end()
  }
}

/** The run id for the current suite run, for specs that need to tag artefacts. */
export function currentRunId(): string {
  if (process.env.FULL_CHAIN_RUN_ID) return process.env.FULL_CHAIN_RUN_ID
  // Playwright workers are separate processes, so env set in globalSetup does not
  // reach them — fall back to the file globalSetup wrote.
  return readFileSync(RUN_ID_FILE, 'utf8').trim()
}
