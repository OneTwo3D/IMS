import type { Prisma } from '@/app/generated/prisma/client'

/**
 * STAMP `synced_at` FROM THE DATABASE'S CLOCK, NOT THIS HOST'S (o3d-clxw round 4).
 *
 * `AccountingSyncLog.syncedAt` used to be written as `new Date()` — the wall clock of whichever app
 * instance happened to run the sync processor. The payment poller then compared it against `new
 * Date()` on ITS host to decide whether a registration had already posted when the ledger snapshot
 * was taken (see LedgerReadFence in invoice-delta.ts). Two machines, two free-running clocks, and one
 * of the two skew directions clears `paidAt` over a supplier payment that is still in flight — which
 * re-arms Mark Paid and pays the supplier twice.
 *
 * The comparison is now between two readings of ONE clock: the database's. This is the writing end.
 *
 * WHY `clock_timestamp()` AND NOT `now()`: PostgreSQL's `now()` / `CURRENT_TIMESTAMP` is
 * TRANSACTION-START time. This statement runs inside the transaction that marks the row SYNCED, and
 * that transaction is opened AFTER the POST to Xero returned — but `now()` would still be free to
 * report an instant before the payment existed if the transaction had been opened earlier for any
 * reason. `clock_timestamp()` is evaluated when the statement executes, so the stamp is always an
 * upper bound on when the payment reached the ledger, which is exactly what the fence needs.
 *
 * MUST be called inside the same transaction as the SYNCED write. Outside it, a crash between the two
 * would leave a SYNCED row carrying a host-clock stamp — the defect, silently restored. Inside it,
 * the two facts become durable together or not at all, and a failure rolls the registration back to
 * be retried.
 *
 * Raw SQL because Prisma has no expression form for a column default on UPDATE. The table and column
 * names are the ones `AccountingSyncLog` maps to (`@@map("accounting_sync_logs")`, `syncedAt`).
 *
 * `AT TIME ZONE 'UTC'` is not decoration: the column is `TIMESTAMP(3)` WITHOUT time zone and Prisma
 * reads it back as UTC, while `clock_timestamp()` is a `timestamptz` that would be cast using the
 * session's TimeZone. Both ends of the fence use this identical expression (see
 * `readDatabaseLedgerFence` in the poller), so the two readings are directly comparable whatever the
 * session is set to.
 */
export async function stampSyncedAtFromDatabaseClock(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  syncLogId: string,
): Promise<void> {
  await tx.$executeRaw`UPDATE accounting_sync_logs SET "syncedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = ${syncLogId}`
}
