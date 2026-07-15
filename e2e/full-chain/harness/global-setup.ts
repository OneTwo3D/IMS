/**
 * Playwright global setup/teardown for the full-chain tier (o3d-lgo.4).
 *
 * The lock MUST be released even when tests fail, time out, or the process is killed —
 * a held lock leaves stage disabled and silently not importing orders. globalTeardown
 * runs after failures, which is why the lock lives here rather than in a fixture.
 * (It cannot survive SIGKILL; that is what acquire()'s stale-lock recovery and
 * scripts/restore-stage-connectors.ts are for.)
 */
import { assertPreflight } from './preflight.ts'
import { acquire } from './quiesce.ts'
import { newRunId, runTag } from './tag.ts'

const RUN_ID_FILE = '.full-chain-run-id'

export default async function globalSetup(): Promise<void> {
  // Preflight BEFORE taking the lock: no point disabling stage to discover the tenant
  // is wrong or the queue is dirty.
  await assertPreflight()

  const runId = newRunId()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(RUN_ID_FILE, runId)
  process.env.FULL_CHAIN_RUN_ID = runId

  console.log(`\n[full-chain] run ${runTag(runId)}`)
  await acquire(runId)
  console.log('[full-chain] stage quiesced; delivery webhooks live.\n')
}

/** The run id for the current suite run, for specs that need to tag artefacts. */
export function currentRunId(): string {
  if (process.env.FULL_CHAIN_RUN_ID) return process.env.FULL_CHAIN_RUN_ID
  // Playwright workers are separate processes, so env set in globalSetup does not
  // reach them — fall back to the file globalSetup wrote.
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  return readFileSync(RUN_ID_FILE, 'utf8').trim()
}
