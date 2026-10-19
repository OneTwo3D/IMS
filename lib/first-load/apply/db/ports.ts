/**
 * THE DATABASE PORTS: the real implementations of what the runner core is handed.
 *
 *   journal        a durable table, true compare-and-swap (journal.ts)
 *   observe        what the database holds per step, in the file's normal form (observe.ts)
 *   preflight      the rails before anything is written (rails.ts)
 *   recheckRails   the same rails again inside each step's lock (rails.ts)
 *   withStepLock   a session advisory lock per step on a pinned connection (lock.ts)
 *   execute        the application's own importers as a system actor, in calls of bounded size (execute.ts)
 *
 * The target database is whatever DATABASE_URL names, because that is where the importers write; the CLI slice is what picks and confirms it
 * (name and system id) and refuses anything but an empty or rehearsal database. These ports add the data-level refusal (rails.ts: a first run needs an empty target).
 */
import type { ApplyStepId } from '../constants'
import type { ApplyPorts } from '../orchestrate'
import type { PreparedRun } from '../prepared'
import { createExecutor } from './execute'
import { createJournal, setFactOnce } from './journal'
import { db } from '@/lib/db'
import { StepLockError, type StepLock } from '../orchestrate'
import { withStepLock } from './lock'
import { observeStep } from './observe'
import { QuiesceError, currentTaxProfiles, evaluateRails, quiesceProblems } from './rails'

export interface DbPortsOptions {
  /** Who the activity log names for the rows the importers write. */
  operator: string
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
  return {
    journal: createJournal(),
    observe: (step) => observeStep(prepared, step),
    preflight: ({ resuming }) => evaluateRails(prepared, { phase: 'preflight', resuming, step: null }),
    // A recheck happens inside a run that holds a record, so the target is by definition not "fresh": emptiness is a preflight rail only.
    recheckRails: async (step, phase) => {
      const problems = await evaluateRails(prepared, { phase: 'recheck', resuming: true, step })
      // Just before the first purchase-order write, with every rail holding: record which accounting profile each tax lookup of the file resolves to. Only the first recording counts.
      if (problems.length === 0 && step === 'purchase-orders' && phase === 'before-first-write') await setFactOnce('taxProfiles', await currentTaxProfiles(prepared))
      return problems
    },
    withStepLock,
    execute: createExecutor({ runId: prepared.manifest.runId, operator: options.operator, maxRowsPerCall: options.maxRowsPerCall, beforeCall: guardBeforeCall(prepared), afterCall: options.afterCall }),
  }
}
