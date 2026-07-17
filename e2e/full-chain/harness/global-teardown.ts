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

/**
 * Cancel any sync log this run left queued, so preflight does not wedge the next one.
 * Returns anything that went wrong, rather than swallowing it (o3d-0qk).
 */
async function cancelPendingQueue(): Promise<string[]> {
  const problems: string[] = []
  const url = process.env.DATABASE_URL
  if (!url || url.includes('onetwo3d_ims_dev')) return problems // never touch stage's queue
  const db = new Client({ connectionString: url })
  // connect() INSIDE the try. It sat outside, so an unreachable Postgres threw straight out
  // of this function, past runTeardown's release() call, and left STAGE DISABLED — the exact
  // catastrophe the ordering was written to prevent (caught in review of PR #489). This
  // function's contract is to REPORT problems, never to throw one.
  try {
    await db.connect()
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
    problems.push(`could not clear the Xero sync queue: ${e instanceof Error ? e.message : e}`)
  } finally {
    // A rejecting end() would escape the finally and defeat the whole point of the try.
    await db.end().catch(() => {})
  }
  return problems
}

export type TeardownDeps = {
  cancelPendingQueue: () => Promise<string[]>
  voidTrackedDocuments: () => Promise<{ voided: number; failed: string[] }>
  findStragglers: () => Promise<string[]>
  release: () => Promise<void>
  /** Budgets, overridable so the hang tests do not have to actually wait 90 seconds. */
  budgets?: { voidMs?: number; stragglerMs?: number }
}

/**
 * How long the whole Xero clean-up may take before we stop waiting and free stage.
 *
 * Generous enough for a normal void of a dozen documents, and far short of what Xero can make
 * us wait: its client sleeps for `Retry-After` on a 429, and the DAILY limit (5,000 calls) can
 * hand back a delay measured in hours.
 */
const XERO_TEARDOWN_BUDGET_MS = 90_000

/** Diagnostics get less rope than the clean-up: they are the least important thing here. */
const STRAGGLER_BUDGET_MS = 30_000

/** Resolve to `onTimeout` rather than waiting forever. The work is abandoned, not cancelled. */
async function withBudget<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const budget = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms) })
  try {
    return await Promise.race([work, budget])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Clean up, then FAIL THE RUN if the cleanup did not hold (o3d-0qk).
 *
 * This used to catch everything and only warn, so Playwright exited 0 while the SHARED Demo
 * ledger stayed polluted — the cleanup guarantee was unenforceable, and X-02 asserts against
 * that ledger being clean. Not hypothetical: during Phase 2b a POSTED manual journal
 * stranded (voidTrackedDocuments hardcoded DELETED, which only a DRAFT accepts) and the run
 * still went green. A guarantee nothing can break is not a guarantee.
 *
 * ORDERING IS THE WHOLE DESIGN HERE. The lock is released BEFORE anything throws, because
 * the failure modes are wildly asymmetric: a polluted ledger costs a manual void, whereas a
 * held lock leaves STAGE DISABLED — not importing Woo orders, not posting to Xero — for as
 * long as nobody notices. Failing the run must never cost more than the fault it reports.
 *
 * AND THE LOCK IS NOT HOSTAGE TO XERO. Ordering alone was not enough: releasing LAST meant the
 * release waited on the void, and the void waits on Xero. When the Demo tenant rate-limited us,
 * the client slept on its Retry-After and teardown sat there for 42 MINUTES with stage disabled
 * the whole time — the exact catastrophe the ordering exists to prevent, arriving by a route the
 * ordering does not cover. Xero's daily limit can hand back a delay measured in hours.
 *
 * So the Xero clean-up now runs on a BUDGET. If it overruns we abandon it, report the residue as
 * a failure, and free stage on time. The trade is deliberate and one-directional: a document left
 * in the Demo ledger is a manual void someone does at leisure, while a held lock is a production
 * stoppage. Cleaning up must never cost more than the mess.
 *
 * Dependencies are injected so that ordering can be tested without a database, a Xero tenant
 * or a real lock — the same shape as createAdminHealthHandler({ authorize, collect }).
 */
export async function runTeardown(deps: TeardownDeps): Promise<void> {
  const problems: string[] = []

  // Leave no queued work behind. A failed run can leave a PENDING sync log (e.g. an
  // invoice queued at import but never posted); preflight then blocks the NEXT run over
  // a dirty queue, so one failure wedges the suite until someone clears it by hand.
  // These rows are unambiguously ours — this database's queue is exclusive to the rig —
  // so CANCELLED is right (the schema's status for deliberately abandoned rows, kept
  // distinct from FAILED so retry sweeps and error dashboards ignore them).
  // Wrapped even though cancelPendingQueue is contracted not to throw: deps are injectable,
  // and NOTHING before release() may be allowed to abort this function. Leaving stage
  // disabled is the worst outcome available here, so it gets belt and braces.
  try {
    problems.push(...(await deps.cancelPendingQueue()))
  } catch (e) {
    problems.push(`could not clear the Xero sync queue: ${e instanceof Error ? e.message : e}`)
  }

  // Xero next: the documents are the thing that pollutes the SHARED Demo ledger and
  // skews the next run's reconciliation assertions (X-02).
  const TIMED_OUT = { voided: -1, failed: [] as string[] }
  try {
    const voidMs = deps.budgets?.voidMs ?? XERO_TEARDOWN_BUDGET_MS
    const result = await withBudget(deps.voidTrackedDocuments(), voidMs, TIMED_OUT)
    if (result === TIMED_OUT) {
      problems.push(
        `Xero clean-up did not finish within ${voidMs / 1000}s and was ABANDONED so that stage ` +
          `could be released on time. Documents from this run are probably still in the shared Demo ledger — ` +
          `the next run's straggler scan will name them. The usual cause is a Xero rate limit: its client sleeps ` +
          `for Retry-After, and the daily 5,000-call cap can hand back hours.`,
      )
    } else {
      const { voided, failed } = result
      if (voided) console.log(`[full-chain] voided ${voided} Xero document(s)`)
      if (failed.length) {
        problems.push(
          `${failed.length} Xero document(s) could NOT be voided and REMAIN in the shared Demo ledger:\n` +
            failed.map((f) => `      ${f}`).join('\n'),
        )
      }
    }
  } catch (e) {
    problems.push(`Xero teardown failed outright: ${e instanceof Error ? e.message : e}`)
  }

  // Report anything an EARLIER run abandoned. Read-only on purpose: voiding a document
  // nobody expects to disappear is worse than naming it.
  //
  // Deliberately a warning and not a failure, unlike the above. These are somebody else's
  // mess by definition, so failing on them would paint every future run red until a human
  // intervened — punishing the next person for a fault they did not cause, which is how a
  // signal gets routinely ignored. This run answers for this run.
  try {
    // Also budgeted: it is another Xero call, and diagnostics must never delay the release.
    const strays = await withBudget(deps.findStragglers(), deps.budgets?.stragglerMs ?? STRAGGLER_BUDGET_MS, [] as string[])
    if (strays.length) {
      console.warn(`[full-chain] stragglers from earlier runs still in the ledger:\n  ${strays.join('\n  ')}`)
    }
  } catch { /* diagnostics only */ }

  // THE LOCK, ALWAYS, AND BEFORE ANY THROW: stage stays disabled until it is released.
  let releaseFailure: unknown = null
  try {
    await deps.release()
  } catch (e) {
    releaseFailure = e
    console.error(
      `\n[full-chain] *** FAILED TO RELEASE THE QUIESCE LOCK ***\n` +
        `${e instanceof Error ? e.message : e}\n` +
        `STAGE IS STILL DISABLED — not importing Woo orders, not posting to Xero.\n` +
        `Run: NODE_OPTIONS='--import tsx' node --env-file=.env scripts/restore-stage-connectors.ts\n`,
    )
    problems.push(`failed to release the quiesce lock — STAGE IS STILL DISABLED: ${e instanceof Error ? e.message : e}`)
  }

  if (!problems.length) return

  // Rethrow the original lock error when that was the only fault, so its stack survives.
  if (releaseFailure && problems.length === 1) throw releaseFailure

  throw new Error(
    `Full-chain teardown did not leave the world clean:\n  - ${problems.join('\n  - ')}\n\n` +
      `The tests themselves may well have passed; this is the CLEANUP failing. The Demo ledger is ` +
      `shared with stage, so residue skews the reconciliation sweeps (X-02) on the next run.`,
  )
}

export default async function globalTeardown(): Promise<void> {
  return runTeardown({ cancelPendingQueue, voidTrackedDocuments, findStragglers, release })
}
