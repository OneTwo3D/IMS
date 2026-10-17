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
import type { ApplyPorts } from '../orchestrate'
import type { PreparedRun } from '../prepared'
import { createExecutor } from './execute'
import { createJournal } from './journal'
import { withStepLock } from './lock'
import { observeStep } from './observe'
import { evaluateRails } from './rails'

export interface DbPortsOptions {
  /** Who the activity log names for the rows the importers write. */
  operator: string
  /** Test seam: the size of one importer call. */
  maxRowsPerCall?: number
}

export function createDbPorts(prepared: PreparedRun, options: DbPortsOptions): ApplyPorts {
  return {
    journal: createJournal(),
    observe: (step) => observeStep(prepared, step),
    preflight: ({ resuming }) => evaluateRails(prepared, { phase: 'preflight', resuming, step: null }),
    // A recheck happens inside a run that holds a record, so the target is by definition not "fresh": emptiness is a preflight rail only.
    recheckRails: (step) => evaluateRails(prepared, { phase: 'recheck', resuming: true, step }),
    withStepLock,
    execute: createExecutor({ runId: prepared.manifest.runId, operator: options.operator, maxRowsPerCall: options.maxRowsPerCall }),
  }
}
