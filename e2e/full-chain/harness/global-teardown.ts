/**
 * Playwright globalTeardown for the full-chain tier (o3d-lgo.4).
 *
 * Separate module because Playwright resolves globalSetup/globalTeardown as distinct
 * default-export entry points.
 *
 * This runs AFTER failures too — which is the whole reason the lock lives here rather
 * than in a fixture. A held lock leaves stage disabled and silently not importing.
 */
import { Client } from 'pg'
import { release } from './quiesce.ts'
import { voidTrackedDocuments, findStragglers } from './xero.ts'

/** Cancel any sync log this run left queued, so preflight does not wedge the next one. */
async function cancelPendingQueue(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url || url.includes('onetwo3d_ims_dev')) return // never touch stage's queue
  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    // PREPEND the teardown note; never OVERWRITE errorMessage. A row can be left queued
    // because it FAILED and is awaiting retry (retryCount > 0), and its error is the only
    // record of why. Clobbering it destroyed the evidence for exactly the class of bug
    // this suite exists to find: a STOCK_RECEIPT that failed to post looked identical to
    // one that was never attempted.
    // RETURNING scopes the report to exactly the rows THIS teardown cancelled. A
    // wall-clock window instead ("failed in the last 2 hours") re-reports earlier runs'
    // failures as though they were this run's — worse than silence, because it makes a
    // green run look broken and trains you to skim past the warnings that matter.
    // (There is no updatedAt column on this table to filter on anyway.)
    const r = await db.query<{ type: string; retryCount: number; errorMessage: string | null }>(
      `update accounting_sync_logs
          set status = 'CANCELLED',
              "errorMessage" = 'Abandoned by the full-chain e2e teardown (CANCELLED, not FAILED, so retry sweeps and error dashboards ignore it).'
                || case when "errorMessage" is null or "errorMessage" = '' then ''
                        else ' PRIOR ERROR (preserved): ' || "errorMessage" end
        where connector = 'xero' and status in ('PENDING','PROCESSING')
        returning type::text as type, "retryCount", "errorMessage"`,
    )
    if (r.rowCount) console.log(`[full-chain] cancelled ${r.rowCount} leftover queued sync log(s)`)

    // A row left queued with retryCount > 0 FAILED at least once. That is a real signal,
    // not housekeeping — surface it rather than letting the run finish quietly clean.
    for (const row of r.rows.filter((x) => x.retryCount > 0)) {
      console.warn(
        `[full-chain] WARNING: ${row.type} failed ${row.retryCount}x and never posted — ${row.errorMessage ?? '(no error)'}`,
      )
    }
  } catch (e) {
    console.warn(`[full-chain] could not clear the queue: ${e instanceof Error ? e.message : e}`)
  } finally {
    await db.end()
  }
}

export default async function globalTeardown(): Promise<void> {
  // Leave no queued work behind. A failed run can leave a PENDING sync log (e.g. an
  // invoice queued at import but never posted); preflight then blocks the NEXT run over
  // a dirty queue, so one failure wedges the suite until someone clears it by hand.
  // These rows are unambiguously ours — this database's queue is exclusive to the rig —
  // so CANCELLED is right (the schema's status for deliberately abandoned rows, kept
  // distinct from FAILED so retry sweeps and error dashboards ignore them).
  await cancelPendingQueue()

  // Xero next: the documents are the thing that pollutes the SHARED Demo ledger and
  // skews the next run's reconciliation assertions (X-02).
  try {
    const { voided, failed } = await voidTrackedDocuments()
    if (voided) console.log(`[full-chain] voided ${voided} Xero document(s)`)
    if (failed.length) {
      console.warn(`[full-chain] ${failed.length} Xero document(s) could NOT be voided — they remain in the Demo ledger.`)
    }
  } catch (e) {
    console.warn(`[full-chain] Xero teardown failed: ${e instanceof Error ? e.message : e}`)
  }

  // Report anything an earlier run abandoned. Read-only on purpose: voiding a document
  // nobody expects to disappear is worse than naming it.
  try {
    const strays = await findStragglers()
    if (strays.length) {
      console.warn(`[full-chain] stragglers from earlier runs still in the ledger:\n  ${strays.join('\n  ')}`)
    }
  } catch { /* diagnostics only */ }

  // The lock LAST, and loudly on failure: stage stays disabled until it is released.
  try {
    await release()
  } catch (e) {
    console.error(
      `\n[full-chain] *** FAILED TO RELEASE THE QUIESCE LOCK ***\n` +
        `${e instanceof Error ? e.message : e}\n` +
        `STAGE IS STILL DISABLED — not importing Woo orders, not posting to Xero.\n` +
        `Run: NODE_OPTIONS='--import tsx' node --env-file=.env scripts/restore-stage-connectors.ts\n`,
    )
    throw e
  }
}
