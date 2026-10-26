import { db } from '@/lib/db'
import { FX_TABLE_LOCK_KEY } from '@/lib/db/advisory-locks'
import { acquirePinnedSharedAdvisoryLockWaiting, AdvisoryLockWaitTimeoutError } from '@/lib/db/pinned-advisory-lock'
import type { Prisma } from '@/app/generated/prisma/client'

/**
 * THE EXCHANGE-RATE TABLE IS HELD STILL FOR THE WHOLE OF A CSV IMPORT (see FX_TABLE_LOCK_KEY).
 *
 * WRITERS (every one in this tree takes the exclusive side through `withFxTableWriteLock`; tests/currencies/fx-table-writers-census.test.ts fails on any new writer that does not):
 *   - lib/currencies/fx-refresh.ts             the scheduled ECB fetch and "Update now" (one transaction for the whole fetch)
 *   - app/actions/currencies.ts                add-currency fetch, setManualFxRate (admin pin), clearManualFxRate
 *   - app/actions/reset.ts                     the factory reset that empties fx_rates
 *   - app/actions/company.ts                   a change of the BASE currency (the rates are measured against it)
 *   The Aelia plugin on the WooCommerce store owns its own copy of the rates in P1 and writes nothing here; an ingest of Aelia's rates into fx_rates is a writer and MUST use this helper.
 *
 * WHY THIS IS NOT A TRANSACTION AROUND THE IMPORT. The importers create each order through actions that run their own transactions on pooled connections; a wrapping transaction could not hold
 * them, and a long open transaction would pin a connection and its snapshot for the length of the file. A session-level SHARED advisory lock on a pinned connection (the same primitive the
 * accounting batches use, exclusive there) holds only a lock, not a snapshot. A writer waits for the import to finish; the importer waits up to IMPORT_WAIT_MS for a running writer.
 */
const IMPORT_WAIT_MS = 30_000

export async function withFxTableWriteLock<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options: { timeout?: number } = {}): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FX_TABLE_LOCK_KEY})`
    return work(tx)
  }, { maxWait: 60_000, timeout: options.timeout ?? 10 * 60_000 })
}

export class FxTableBusyError extends Error {
  constructor() {
    super('FX_TABLE_BUSY: the exchange rates are being updated; the import was not started. Try again in a moment.')
    this.name = 'FxTableBusyError'
  }
}

/** Run `work` with the rate table held still (shared). Released in a finally. */
export async function withFxTableHeldStill<T>(work: () => Promise<T>): Promise<T> {
  let lock
  try {
    lock = await acquirePinnedSharedAdvisoryLockWaiting(FX_TABLE_LOCK_KEY, { timeoutMs: IMPORT_WAIT_MS })
  } catch (error) {
    if (error instanceof AdvisoryLockWaitTimeoutError) throw new FxTableBusyError()
    throw error
  }
  try {
    return await work()
  } finally {
    await lock.release()
  }
}
