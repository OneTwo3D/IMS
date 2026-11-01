import { db } from '@/lib/db'
import { FX_TABLE_LOCK_KEY } from '@/lib/db/advisory-locks'
import { acquirePinnedSharedAdvisoryLockWaiting, AdvisoryLockLostError, AdvisoryLockWaitTimeoutError } from '@/lib/db/pinned-advisory-lock'
import type { Prisma } from '@/app/generated/prisma/client'

/**
 * THE EXCHANGE-RATE TABLE IS HELD STILL FOR THE WHOLE OF A CSV IMPORT (see FX_TABLE_LOCK_KEY).
 *
 * WRITERS (every one in this tree takes the exclusive side through `withFxTableWriteLock`; tests/currencies/fx-table-writers-census.test.ts fails on any new writer that does not):
 *   - lib/currencies/fx-refresh.ts             the scheduled ECB fetch and "Update now" (one transaction for the whole fetch)
 *   - app/actions/currencies.ts                add-currency fetch, setManualFxRate (admin pin), clearManualFxRate; currency create/activate (not a rate writer: it takes the lock to serialise with the source switch)
 *   - app/actions/reset.ts                     NOT a writer in this sense: the factory reset empties every table, with the app stopped, behind a fresh-admin code
 *   - app/actions/company.ts                   a change of the BASE currency (the rates are measured against it)
 *   The Aelia plugin on the WooCommerce store owns its own copy of the rates in P1 and writes nothing here; an ingest of Aelia's rates into fx_rates is a writer and MUST use this helper.
 *
 * WHY THIS IS NOT A TRANSACTION AROUND THE IMPORT. The importers create each order through actions that run their own transactions on pooled connections; a wrapping transaction could not hold
 * them, and a long open transaction would pin a connection and its snapshot for the length of the file. A session-level SHARED advisory lock on a pinned connection (the same primitive the
 * accounting batches use, exclusive there) holds only a lock, not a snapshot. A writer waits for the import to finish; the importer waits up to IMPORT_WAIT_MS for a running writer.
 *
 * A DEAD LOCK CONNECTION. PostgreSQL frees a session lock the instant its connection dies, while the importer keeps writing on other connections. The importers therefore call guard.assertHeld before
 * EVERY order write and once after the last. Lost before the first write: the file is refused, nothing written. Lost later: KNOWN LIMIT, the orders already saved stay saved (a purchase order has no
 * delete, only a cancel that keeps its reference; a sales order's delete is refused once accounting has touched it, so a compensating delete cannot be guaranteed); the importer writes no more and
 * reports exactly which orders were saved and how many groups were not written, code FX_TABLE_LOCK_LOST. Re-importing the same file skips the saved orders as duplicates.
 */
const IMPORT_WAIT_MS = 30_000

export async function withFxTableWriteLock<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options: { timeout?: number } = {}): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FX_TABLE_LOCK_KEY})`
    return work(tx)
  }, { maxWait: 60_000, timeout: options.timeout ?? 10 * 60_000 })
}

/**
 * The `fetchedAt` of a row an FX writer inserts: call it INSIDE the work passed to withFxTableWriteLock, so the instant is taken after the lock is held. A stamp taken before the wait (or the
 * transaction's start) can be EARLIER than a row another writer committed while this one waited, and the earlier-dated row would lose to it though it was written later. The one exception is the
 * Aelia ingest, whose rows carry Aelia's own update time (a data time, not a write time): its ordering rests on the update time never being later than the lock-held `now` it is checked against.
 * A tie of two stamps is broken by the write order, `seq`.
 */
export function fxWriteStamp(): Date {
  return new Date()
}

export class FxTableBusyError extends Error {
  constructor() {
    super('FX_TABLE_BUSY: the exchange rates are being updated; the import was not started. Try again in a moment.')
    this.name = 'FxTableBusyError'
  }
}

/** What the held-still lock offers its work: a check that the lock is STILL held. */
export type FxTableGuard = {
  /** True once the pinned connection has failed: PostgreSQL has released the lock and a rate writer may already have run. */
  readonly lost: boolean
  /** Throws FxTableLockLostError if the lock has been lost. Call immediately before EACH write and once more after the last. */
  assertHeld: (context?: string) => void
}

/** The shared lock was lost mid-import (its pinned connection died). Importers stop writing and report precisely what was saved: code FX_TABLE_LOCK_LOST. */
export class FxTableLockLostError extends Error {
  readonly code = 'FX_TABLE_LOCK_LOST'
  constructor(detail?: string) {
    super(`FX_TABLE_LOCK_LOST: the exchange-rate table was no longer held still${detail ? ` (${detail})` : ''}; the import stopped writing.`)
    this.name = 'FxTableLockLostError'
  }
}

/**
 * Run `work` with the rate table held still (shared). Released in a finally. `work` receives a guard and MUST call guard.assertHeld before each write: if the pinned connection dies PostgreSQL
 * frees the lock at once, a writer can change fx_rates, and the importer (which writes on other connections) would otherwise carry on and leave the file partly imported.
 */
export async function withFxTableHeldStill<T>(work: (guard: FxTableGuard) => Promise<T>): Promise<T> {
  let lock
  try {
    lock = await acquirePinnedSharedAdvisoryLockWaiting(FX_TABLE_LOCK_KEY, { timeoutMs: IMPORT_WAIT_MS })
  } catch (error) {
    if (error instanceof AdvisoryLockWaitTimeoutError) throw new FxTableBusyError()
    throw error
  }
  const held = lock
  const guard: FxTableGuard = {
    get lost() { return held.lost },
    assertHeld(context?: string) {
      try {
        held.assertHeld(context)
      } catch (error) {
        if (error instanceof AdvisoryLockLostError) throw new FxTableLockLostError(context)
        throw error
      }
    },
  }
  try {
    return await work(guard)
  } finally {
    await held.release()
  }
}
