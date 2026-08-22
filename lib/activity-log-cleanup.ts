import { db } from '@/lib/db'
import { DIRECT_CREATE_PENDING_ACTION } from '@/lib/fulfillment/pre-fulfilment-reallocation'
import {
  QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  QBO_UNSETTLED_OPERATION_ACTION,
  UNRECORDED_POSTED_DOCUMENT_ACTION,
} from '@/lib/domain/accounting/unrecorded-posted-document'

const DEFAULTS: Record<string, number> = {
  INFO: 30,
  WARNING: 60,
  ERROR: 90,
}
/**
 * Actions exempt from retention, because they are STATE rather than history.
 *
 * TWO KINDS QUALIFY, and they are exempt for opposite-looking reasons:
 *
 * (1) AN OPEN OBLIGATION, which something else must CLEAR. A direct-create marker says an order
 * entered fulfilment and its allocation coverage has not been verified yet. Deleting it does not age
 * out a record — it silently discharges the obligation, and the resolver then reads "no marker" as
 * "already resolved" and can never write the shortfall record (o3d-z82a, Codex review). For this kind
 * the clearing responsibility has to be a MECHANISM, not a hope: here it is
 * `sweepUnresolvedDirectCreateMarkers`, run from the reallocation-sweep cron, where every marker older
 * than the import's grace window is answered under the order lock and deleted on EVERY outcome —
 * covered, no demand, handed back to the sweep, recorded as a shortfall, or an order that no longer
 * exists. An earlier revision claimed this exemption was bounded when the only other resolver was a
 * WooCommerce redelivery of that same order, which for most orders never arrives; markers whose own
 * import failed to resolve them accumulated with nothing to clear them (Codex review r4).
 *
 * (2) THE ONLY SURVIVING RECORD OF SOMETHING THAT HAPPENED OUTSIDE THIS DATABASE, which nothing can
 * rebuild. `xero_posted_document_unrecorded` (o3d-550x; Codex r2, medium 1) says: a document was
 * accepted by Xero, and its sync row can never name it — either the row already names a DIFFERENT
 * document a competing worker posted, or the row is gone. Both documents are real money in the ledger.
 * Nothing in IMS points at the displaced one except this row, and nothing re-derives it: the sync row
 * names the other id and reads as perfectly settled, and no Xero call can tell which of two documents
 * for one reference was the accident. Ageing it out does not expire a log line, it converts a recorded
 * duplicate into an invisible one — the exact outcome the branch that writes it exists to prevent.
 *
 * The QuickBooks twin `quickbooks_posted_document_unrecorded` (o3d-peh1 r5) is the same kind for the
 * same reason, differing only in HOW the row came to name no document: there the id was returned and
 * could not be written down at all, rather than displaced by a competing worker.
 *
 * A kind-(2) exemption does NOT need a clearing mechanism, and demanding one would be asking for the
 * wrong thing: the resolution happens in Xero, by a person voiding or crediting the duplicate, and IMS
 * cannot observe that. What it needs instead is to be bounded, and it is — one row per incident, and an
 * incident requires a claim to age out WHILE its request is on the wire and the replacement to post and
 * record before the displaced worker returns. Each one is an operator-facing exception that somebody is
 * expected to look at. If they ever became common the correct response is to fix the duplication, not
 * to start deleting the evidence of it.
 *
 * The predicate is `<> ALL`, NOT `<> ANY`. `action <> ANY(ARRAY['a','b'])` is true when the
 * action differs from AT LEAST ONE element, so `'a' <> 'b'` alone satisfies it and a row whose
 * action IS exempt gets deleted anyway. With one entry the two forms agree, which is exactly
 * what makes it a landmine: it would work until the day someone added a second action. THIS IS THAT
 * DAY — the array below now has two entries, and `<> ALL` is what makes both of them hold.
 */
const RETAINED_ACTIONS = [
  DIRECT_CREATE_PENDING_ACTION,
  UNRECORDED_POSTED_DOCUMENT_ACTION,
  // o3d-peh1 r5 — the same kind-(2) exemption on the other connector, for the other way a real
  // document ends up unreferenced: QuickBooks accepted the post and returned an id, and the
  // transaction that would have made that id durable failed. The row names no document, so nothing
  // re-derives the identifier and no later sync attempt can: it exists only in this record.
  QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  // o3d-peh1 r6 — the same kind-(2) exemption for the operations that have NO id to lose. An
  // attachment, a PDF, an invoice email or a WooCommerce note has already happened outside this
  // database when this row is written, the sync row does not say so, and nothing re-derives it. It
  // is also the ONE record that a row is stuck holding a claim it cannot be settled out of, which
  // is the state a person has to clear by hand.
  QBO_UNSETTLED_OPERATION_ACTION,
]

const DELETE_BATCH_SIZE = 10_000
const DEFAULT_CRON_RUN_RETENTION_DAYS = 90

export type CronRunCleanupClient = {
  cronRun: {
    deleteMany(args: unknown): Promise<{ count: number }>
  }
}

async function getSetting(key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } })
  return row?.value ?? null
}

/**
 * Purge activity log entries older than their retention period.
 * Retention days are configurable via settings:
 *   activity_log_retention_info, activity_log_retention_warning, activity_log_retention_error
 * Call this on a daily schedule (e.g. cron or API route).
 */
export async function purgeExpiredActivityLogs() {
  const [infoVal, warnVal, errorVal] = await Promise.all([
    getSetting('activity_log_retention_info'),
    getSetting('activity_log_retention_warning'),
    getSetting('activity_log_retention_error'),
  ])

  const retention: Record<string, number> = {
    INFO: infoVal ? parseInt(infoVal, 10) : DEFAULTS.INFO,
    WARNING: warnVal ? parseInt(warnVal, 10) : DEFAULTS.WARNING,
    ERROR: errorVal ? parseInt(errorVal, 10) : DEFAULTS.ERROR,
  }

  const now = Date.now()
  let totalDeleted = 0

  for (const [level, days] of Object.entries(retention)) {
    if (days <= 0) continue // 0 = keep forever
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000)
    for (;;) {
      const rows = await db.$queryRaw<Array<{ count: number }>>`
        WITH deleted AS (
          DELETE FROM "activity_logs"
          WHERE id IN (
            SELECT id
            FROM "activity_logs"
            WHERE level = ${level}::"ActivityLogLevel"
              AND "createdAt" < ${cutoff}
              AND action <> ALL(${RETAINED_ACTIONS}::text[])
            ORDER BY "createdAt" ASC
            LIMIT ${DELETE_BATCH_SIZE}
          )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM deleted
      `
      const batchDeleted = rows[0]?.count ?? 0
      totalDeleted += batchDeleted
      if (batchDeleted < DELETE_BATCH_SIZE) break
    }
  }

  return { totalDeleted, retention }
}

export async function purgeExpiredCronRuns(
  options: {
    client?: CronRunCleanupClient
    now?: Date
    retentionDays?: number
  } = {},
) {
  const retentionDays = Math.floor(options.retentionDays ?? DEFAULT_CRON_RUN_RETENTION_DAYS)
  if (retentionDays <= 0) return { deleted: 0, retentionDays }

  const cutoff = new Date((options.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const result = await (options.client ?? db).cronRun.deleteMany({
    where: {
      startedAt: { lt: cutoff },
    },
  })

  return { deleted: result.count, retentionDays }
}
