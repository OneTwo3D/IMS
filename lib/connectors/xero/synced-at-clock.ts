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
 *
 * TWO COLUMNS, ONE READING OF THE CLOCK (o3d-clxw round 5, Codex finding 1).
 *
 * Round 4 left one clock in the system that it could not remove: during a deploy, a worker still
 * running the PREVIOUS build writes `syncedAt` from its own host's `new Date()`, and a poller on the
 * new build compares that against a database fence. That is the cross-host comparison this file
 * exists to delete, put back by the rollout. Round 4 proposed to let such rows age past any plausible
 * skew; ageing out is not a fence, it is the same assumption about clock distance under another name.
 *
 * So the stamp now carries its own provenance, and it rides INSIDE the value rather than beside it:
 * `syncedAtDatabaseClock` gets the SAME instant as `syncedAt`, and the reader
 * (`databaseStampedCompletion` in invoice-delta.ts) accepts the row only while the two are equal.
 * A build that does not know about the marker cannot write `syncedAt` without breaking that equality
 * — it either never writes the marker at all (NULL) or moves `syncedAt` out from under a marker that
 * stays where it was. Either way the row announces itself and the verdict is withheld.
 *
 * `FROM (SELECT clock_timestamp() ...) s` and not `clock_timestamp()` written twice: `clock_timestamp()`
 * is evaluated per call, so two calls in one UPDATE yield two different instants, the equality never
 * holds, and every registration this process ever stamps would read as undecidable. One evaluation,
 * assigned to both columns, is the whole mechanism. (Both columns are `TIMESTAMP(3)`, so both round
 * the one value identically and the equality is exact rather than approximate.)
 *
 * THE EQUALITY IS ENFORCED BY THE DATABASE, AND THIS STATEMENT MUST BE THE LAST OF THE TWO (round 6,
 * Codex finding 1). Equality alone was never proof: `TIMESTAMP(3)` means any writer landing on the
 * same millisecond satisfies it, and the previous release's completion write is a read-modify-write
 * that can carry this very stamp forward onto a registration that finished later. The rule is
 * therefore a trigger (migration 20260821090000): a statement that changes `status`, `syncedAt`,
 * `externalTransactionId` or `processingStartedAt` WITHOUT assigning the marker in the same statement
 * has the marker cleared out from under it.
 *
 * That is why the caller runs the Prisma SYNCED write FIRST and this statement SECOND. The SYNCED
 * write changes the status (and often the external id) without touching the marker, so it trips the
 * trigger and clears whatever provenance the row was carrying; this statement then mints the new
 * pair, and because it assigns the marker itself the trigger does not fire on it. Swap the two and
 * the transaction would erase its own stamp — every registration undecidable, silently.
 */
export async function stampSyncedAtFromDatabaseClock(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  syncLogId: string,
): Promise<void> {
  await tx.$executeRaw`UPDATE accounting_sync_logs AS l SET "syncedAt" = s.stamp, "syncedAtDatabaseClock" = s.stamp FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS stamp) AS s WHERE l.id = ${syncLogId}`
}
