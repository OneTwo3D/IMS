/**
 * The lock that keeps a database reset and the promotion of a fetched invoice document from meeting halfway (see INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE).
 *
 *   reset        takes it EXCLUSIVE for its whole run, on a pinned session connection (`withInvoiceDocumentResetLock`);
 *   promotion    takes it SHARED, transaction-scoped, with the TRY form as the first statement of its transaction (`tryShareResetLock`);
 *   the fetch    asks `invoiceDocumentResetRunning` before it starts and skips while the reset holds it, so a sweep or a lazy fetch does not even call
 *                the ledger for a document it cannot store.
 * TWO KEYS, because the session lock alone is not enough: a pinned connection can drop mid-reset and PostgreSQL then frees its session lock while the deletes go on.
 *   key 0   the session lock (above), held for the whole run; `assertHeld` between the reset's stages stops it when that connection is lost.
 *   key 1   a TRANSACTION-scoped exclusive lock taken by the reset's sales-deletion transaction itself (`lockResetInTransaction`), together with a
 *           second run of the document verdict inside that transaction. A promotion takes BOTH keys shared, so one cannot commit between that verdict
 *           and the order delete even if the pinned connection is gone.
 * Either the promotion committed first (the reset's preflight then SEES the document and refuses, or deletes it on a disposable database), or the
 * reset holds the lock and the promotion stores nothing. Never a document appearing between the preflight and the deletes.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE, INVOICE_DOCUMENT_RESET_TRANSACTION_LOCK_KEY } from '@/lib/db/advisory-locks'
import { acquirePinnedAdvisoryLockWaiting, AdvisoryLockWaitTimeoutError } from '@/lib/db/pinned-advisory-lock'

export { AdvisoryLockWaitTimeoutError }

export const INVOICE_DOCUMENT_RESET_LOCK_WAIT_MS = 15_000

/** What the reset callback is given: `assertHeld` throws once the pinned connection (and with it the session lock) has been lost. */
export type HeldResetLock = { assertHeld: (context?: string) => void }

export async function withInvoiceDocumentResetLock<T>(run: (lock: HeldResetLock) => Promise<T>): Promise<T> {
  const lock = await acquirePinnedAdvisoryLockWaiting(0, { namespace: INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE, timeoutMs: INVOICE_DOCUMENT_RESET_LOCK_WAIT_MS })
  try {
    return await run({ assertHeld: (context) => lock.assertHeld(context) })
  } finally {
    await lock.release()
  }
}

/** Inside a reset's sales-deletion transaction: wait for in-flight promotions (they hold it shared for one short transaction), then keep every new one out until commit. */
export async function lockResetInTransaction(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE}::int4, ${INVOICE_DOCUMENT_RESET_TRANSACTION_LOCK_KEY}::int4)`
}

/** Inside a promotion transaction: true when BOTH shared locks were granted (no reset is running, nor deleting); released at the end of the transaction. */
export async function tryShareResetLock(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock_shared(${INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE}::int4, 0::int4)
       AND pg_try_advisory_xact_lock_shared(${INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE}::int4, ${INVOICE_DOCUMENT_RESET_TRANSACTION_LOCK_KEY}::int4) AS locked`
  return rows[0]?.locked === true
}

/** Is a reset holding the lock right now? A probe in its own short transaction (the shared lock is released with it). */
export async function invoiceDocumentResetRunning(): Promise<boolean> {
  return db.$transaction(async (tx) => !(await tryShareResetLock(tx)))
}
