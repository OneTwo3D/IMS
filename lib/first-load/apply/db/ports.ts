/**
 * THE DATABASE PORTS: the real implementations of what the runner core is handed.
 *
 *   journal        a durable table, true compare-and-swap (journal.ts)
 *   observe        what the database holds per step, in the file's normal form (observe.ts)
 *   preflight      the rails before anything is written (rails.ts)
 *   recheckRails   the same rails again inside each step's lock (rails.ts)
 *   withStepLock   a session advisory lock per step on a pinned connection (lock.ts)
 *   execute        the application's own importers as a system actor, in calls of bounded size (execute.ts)
 *   verify         the post-run verification and census (verify.ts); supplied when the caller gives `verification`
 *
 * The target database is whatever DATABASE_URL names, because that is where the importers write; the CLI slice is what picks and confirms it
 * (name and system id) and refuses anything but an empty or rehearsal database. These ports add the data-level refusal (rails.ts: a first run needs an empty target).
 */
import type { ApplyStepId } from '../constants'
import type { ApplyPorts, RailTally } from '../orchestrate'
import type { PreparedRun } from '../prepared'
import { createExecutor } from './execute'
import { createJournal, setFactOnce } from './journal'
import { db } from '@/lib/db'
import { StepLockError, type StepLock } from '../orchestrate'
import { withStepLock } from './lock'
import { observeStep } from './observe'
import { QuiesceError, currentTaxProfiles, evaluateRailResults, quiesceProblems, type RailResult } from './rails'
import type { PreloadReaders } from './preload-rails'
import { DATABASE_READ_FAILED } from './observe'
import { ObservationError } from '../residual'
import { captureBaseline, createVerifier, type VerifyDeps } from './verify'

/** The run-record fact that names the restore point taken before the first write (recorded once). */
export const RESTORE_POINT_FACT = 'restorePoint'

export interface DbPortsOptions {
  /** Who the activity log names for the rows the importers write. */
  operator: string
  /**
   * What the post-run verification needs. Without it the ports supply no `verify`, and a finished load ends APPLIED_UNVERIFIED (exit 8), which is not a success.
   * With it the census baseline is recorded at the start of the first step.
   */
  verification?: VerifyDeps
  /** The restore point the command took before this load: recorded once on the run record, so a resume can find and check it. */
  restorePoint?: { path: string; sha256: string; bytes: number }
  /** Test seam: the readers of the pre-load rails (crontab, connector settings). The command passes none and the real ones are used. */
  preload?: PreloadReaders
  /** Test seam: the size of one importer call. */
  maxRowsPerCall?: number
  /** Test seam: awaited after each importer call. */
  afterCall?: (step: ApplyStepId, call: number) => Promise<void>
}

/** Before every importer call: the step lock is live (pg_locks), and the run record is still this load's and still running. */
function guardBeforeCall(prepared: PreparedRun) {
  return async (_step: ApplyStepId, lock: StepLock): Promise<void> => {
    if (!lock) throw new StepLockError('lost')
    await lock.assertLive()
    // And again nobody else is connected: a session that appears between two calls stops the file before the next one.
    if ((await quiesceProblems()).length > 0) throw new QuiesceError()
    let row
    try {
      row = await db.firstLoadApplyRun.findFirst({ select: { manifestDigest: true, runId: true, status: true } })
    } catch {
      throw new StepLockError('unavailable')
    }
    if (row === null || row.manifestDigest !== prepared.manifestDigest || row.runId !== prepared.manifest.runId || row.status !== 'RUNNING') throw new StepLockError('lost')
  }
}

export function createDbPorts(prepared: PreparedRun, options: DbPortsOptions): ApplyPorts {
  // Every evaluation of every rail, kept for the report: a rail that refused ONCE during the run is refused in the report, whatever a later evaluation said.
  const tally = new Map<string, RailTally>()
  const note = (results: RailResult[]): string[] => {
    for (const r of results) {
      const t = tally.get(r.id) ?? { id: r.id, evaluations: 0, refusals: 0, detail: '' }
      t.evaluations += 1
      if (r.problems.length > 0) t.refusals += 1
      if (r.detail !== '') t.detail = r.detail
      tally.set(r.id, t)
    }
    return results.flatMap((r) => r.problems)
  }
  return {
    journal: createJournal(),
    observe: (step) => observeStep(prepared, step),
    railTally: () => [...tally.values()],
    preflight: async ({ resuming }) => note(await evaluateRailResults(prepared, { phase: 'preflight', resuming, step: null }, options.preload)),
    // A recheck happens inside a run that holds a record, so the target is by definition not "fresh": emptiness is a preflight rail only.
    recheckRails: async (step, phase) => {
      const problems = note(await evaluateRailResults(prepared, { phase: 'recheck', resuming: true, step }, options.preload))
      // The census starting point: once, after the rails passed at the start of a step and before any importer call of it. The first step of the first attempt records it; later calls change nothing.
      if (problems.length === 0 && phase === 'step-start' && (options.verification || options.restorePoint)) {
        try {
          if (options.verification) await captureBaseline()
          if (options.restorePoint) await setFactOnce(RESTORE_POINT_FACT, options.restorePoint)
        } catch {
          throw new ObservationError(DATABASE_READ_FAILED)
        }
      }
      // Just before the first purchase-order write, with every rail holding: record which accounting profile each tax lookup of the file resolves to. Only the first recording counts.
      if (problems.length === 0 && step === 'purchase-orders' && phase === 'before-first-write') await setFactOnce('taxProfiles', await currentTaxProfiles(prepared))
      return problems
    },
    withStepLock,
    verify: options.verification ? createVerifier(options.verification.preload === undefined && options.preload !== undefined ? { ...options.verification, preload: options.preload } : options.verification) : undefined,
    execute: createExecutor({ runId: prepared.manifest.runId, operator: options.operator, maxRowsPerCall: options.maxRowsPerCall, beforeCall: guardBeforeCall(prepared), afterCall: options.afterCall }),
  }
}
