/**
 * The lock that keeps a database reset and the promotion of a fetched invoice document from meeting halfway (see INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE).
 *
 *   reset        takes it EXCLUSIVE for its whole run, on a pinned session connection (`withInvoiceDocumentResetLock`);
 *   promotion    takes it SHARED, transaction-scoped, with the TRY form as the first statement of its transaction (`tryShareResetLock`);
 *   the fetch    asks `invoiceDocumentResetRunning` before it starts and skips while the reset holds it, so a sweep or a lazy fetch does not even call
 *                the ledger for a document it cannot store.
 * Either the promotion committed first (the reset's preflight then SEES the document and refuses, or deletes it on a disposable database), or the
 * reset holds the lock and the promotion stores nothing. Never a document appearing between the preflight and the deletes.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { db } from '@/lib/db'
import { INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { acquirePinnedAdvisoryLockWaiting, AdvisoryLockWaitTimeoutError } from '@/lib/db/pinned-advisory-lock'

export { AdvisoryLockWaitTimeoutError }

export const INVOICE_DOCUMENT_RESET_LOCK_WAIT_MS = 15_000

export async function withInvoiceDocumentResetLock<T>(run: () => Promise<T>): Promise<T> {
  const lock = await acquirePinnedAdvisoryLockWaiting(0, { namespace: INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE, timeoutMs: INVOICE_DOCUMENT_RESET_LOCK_WAIT_MS })
  try {
    return await run()
  } finally {
    await lock.release()
  }
}

/** Inside a promotion transaction: true when the shared lock was granted (no reset is running); it is released at the end of the transaction. */
export async function tryShareResetLock(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock_shared(${INVOICE_DOCUMENT_RESET_LOCK_NAMESPACE}::int4, 0::int4) AS locked`
  return rows[0]?.locked === true
}

/** Is a reset holding the lock right now? A probe in its own short transaction (the shared lock is released with it). */
export async function invoiceDocumentResetRunning(): Promise<boolean> {
  return db.$transaction(async (tx) => !(await tryShareResetLock(tx)))
}
