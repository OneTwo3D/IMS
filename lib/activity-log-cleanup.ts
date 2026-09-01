import { db } from '@/lib/db'
import { DIRECT_CREATE_PENDING_ACTION } from '@/lib/fulfillment/pre-fulfilment-reallocation'
import { UNRECORDED_POSTED_DOCUMENT_ACTIONS } from '@/lib/domain/accounting/unrecorded-posted-document'
import { WC_REFUND_PARK_RECOVERED_ACTION } from '@/lib/domain/sales/refund-park-recovery'
import {
  WITHHELD_CLOSED_ACTIONS,
  WITHHELD_MARKER_ACTIONS,
  WITHHELD_OPEN_ACTIONS,
} from '@/lib/domain/accounting/withheld-reversal-markers'

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
 * could not be written down at all, rather than displaced by a competing worker. Both are named by
 * one value, `UNRECORDED_POSTED_DOCUMENT_ACTIONS`, and this list SPREADS it rather than listing its
 * members: an exemption written as a single constant name looks complete, compiles, passes its own
 * test, and is wrong only for the member of the pair the author was not thinking about.
 *
 * (3) EVIDENCE A LATER WRITE TO THE ACCUSED ROW CANNOT REACH. `wc_refund_park_recovered` (o3d-xnwu
 * r14; Codex r14 HIGH) says: an operator moved or dismissed a parked WooCommerce refund on this
 * `shopping_sync_logs` row. Check 7 of the 20260822120000 migration's verify.sql exists precisely
 * because THAT ROW CAN AFTERWARDS BE MADE TO LOOK INNOCENT — the predecessor's held-invoice writer
 * overwrites its payload, externalId, message and status wholesale, and every check that reads the
 * row alone then returns zero over a destroyed accounting payload. This entry is the only thing
 * left that says the row was ever recovered, and it is not history: it is the join target of a
 * correctness check that runs at a cutover, which may be a year after the recovery.
 *
 * It is a WARNING, so the default 60-day sweep would have deleted it — silently, and first for the
 * OLDEST incidents, which are the ones nobody has looked at. A check whose evidence a retention
 * cron can delete is not a check. Bounded the same way kind (2) is: one row per operator recovery
 * of a stale cross-order refund park, each of them an exception a human already had to sit in front
 * of. The other half of the fix is in the writer — `recoverParkedWcRefund` now writes this entry
 * INSIDE the recovery transaction, so the recovery cannot commit without it.
 *
 * A kind-(2) or kind-(3) exemption does NOT need a clearing mechanism, and demanding one would be
 * asking for the wrong thing: the resolution happens in Xero, by a person voiding or crediting the duplicate, and IMS
 * cannot observe that. What it needs instead is to be bounded, and it is — one row per incident, and an
 * incident requires a claim to age out WHILE its request is on the wire and the replacement to post and
 * record before the displaced worker returns. Each one is an operator-facing exception that somebody is
 * expected to look at. If they ever became common the correct response is to fix the duplication, not
 * to start deleting the evidence of it.
 *
 * The predicate is `<> ALL`, NOT `<> ANY`. `action <> ANY(ARRAY['a','b'])` is true when the
 * action differs from AT LEAST ONE element, so `'a' <> 'b'` alone satisfies it and a row whose
 * action IS exempt gets deleted anyway. With one entry the two forms agree, which is exactly
 * what makes it a landmine: it would work until the day someone added a second action. THAT DAY
 * CAME — the array below now resolves to FOUR action names, and `<> ALL` is what makes all of them
 * hold. Count the STRINGS, not the entries: one of the three entries is a spread of a two-element
 * pair, so a reader who counts entries gets three and a reader who counts exemptions gets four.
 */
// THE THREE KINDS ARE INDEPENDENT, AND THE LIST IS THE UNION OF THEM (merge of o3d-peh1 into
// o3d-xnwu). `action` is a single column, and these four strings are pairwise distinct, so no row
// can satisfy two of these exemptions and no one of them can therefore shadow another. `<> ALL` is
// also monotone in this array — every name added retains strictly more rows and deletes none that
// were being retained before — so the two branches' exemptions COMPOSE rather than compete. That is
// the property to preserve when a fourth kind arrives: append, never rewrite.
const RETAINED_ACTIONS = [
  DIRECT_CREATE_PENDING_ACTION,
  // o3d-peh1 r5 — BOTH connectors' unrecorded-document records, spread from the one place the pair
  // is named. The QuickBooks twin is the same kind-(2) exemption arrived at the other way: the post
  // was accepted and returned an id, and the transaction that would have made that id durable
  // failed, so the row names no document and no later sync attempt can re-derive the identifier.
  // Spreading the pair rather than listing its members is the point: this sweep got both because
  // both were in front of the author, and the factory reset — writing the same exemption from
  // memory — named only Xero, and so deleted every QuickBooks incident record (Codex HIGH).
  ...UNRECORDED_POSTED_DOCUMENT_ACTIONS,
  // o3d-xnwu r14 — the kind-(3) entry. Independent of the two above: it is written by
  // `recoverParkedWcRefund` about a `shopping_sync_logs` row, never by an accounting post, so it
  // cannot collide with either unrecorded-document name.
  WC_REFUND_PARK_RECOVERED_ACTION,
]

/**
 * o3d-psrx r5 (Codex HIGH 2) — THE FOURTH KIND: A ROW WHOSE RETENTION DEPENDS ON ANOTHER ROW.
 *
 * The withheld-reversal markers (lib/domain/accounting/withheld-reversal-markers.ts) are kind (1) —
 * AN OPEN OBLIGATION, which something else must clear — with one difference that stops them going in
 * `RETAINED_ACTIONS` above: they are not exempt by ACTION. A document withheld and reconsidered
 * hourly writes a new open marker every hour, and an unconditional exemption would retain all seven
 * hundred of them a month, for ever. What has to survive is ONE row: the document's CURRENT open
 * marker, and only while it is still open.
 *
 * WHAT BREAKS WITHOUT IT. The open markers are WARNING rows, so the stock sixty-day sweep deletes
 * them, oldest first — which is precisely the documents nobody has resolved. The marker IS the queue
 * entry (round 4's whole design), the reversal watermark advanced when it was written, and an
 * unchanged ledger document never re-enters the delta: delete the marker and the withheld reversal is
 * not deferred, it is abandoned, silently, with `paidAt` standing against a ledger that disagrees.
 *
 * THE RULE, and it is a rule about a PAIR of rows rather than about one row's action:
 *
 *   an OPEN row is retained    while it is the document's NEWEST open marker AND no closure for that
 *                              document is at least as new. That is `dueWithheldMarkers`' own
 *                              openness test, spelt in SQL — deliberately the same `>=` at the tie,
 *                              so a row the scan calls closed is a row this sweep may delete.
 *   a CLOSURE is retained      while any open row for that document still exists. Closures are INFO
 *                              (30 days) and open rows are WARNING (60), so without this the proof
 *                              that a document SETTLED would expire a month before the marker it
 *                              settles — and the surviving open row would then read as open again,
 *                              putting a finished document back into the round robin for ever.
 *
 * Together they converge and they terminate: while a document is open, one row survives; once it is
 * closed, the open rows age out first, and the next sweep — with no open row left to protect it —
 * lets the closure go too. Bounded by OPEN DOCUMENTS, not by incidents or by time.
 *
 * SCOPED BY CONNECTOR, matching `openWithheldDocuments`. Both pollers write the same action names and
 * each scan claims only its own connector's rows (plus, for the legacy owner, the rows written before
 * the metadata key existed). A newest-marker test that ignored the connector would let one
 * connector's fresh marker license the deletion of another connector's still-open one. `IS NOT
 * DISTINCT FROM` rather than `=`, so the pre-key NULL rows form their own group instead of matching
 * nothing and being deleted on their own evidence.
 */
const WITHHELD_OPEN_ACTION_NAMES = [...WITHHELD_OPEN_ACTIONS]
const WITHHELD_CLOSED_ACTION_NAMES = [...WITHHELD_CLOSED_ACTIONS]
const WITHHELD_ALL_ACTION_NAMES = [...WITHHELD_MARKER_ACTIONS]

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
            SELECT m.id
            FROM "activity_logs" m
            WHERE m.level = ${level}::"ActivityLogLevel"
              AND m."createdAt" < ${cutoff}
              AND m.action <> ALL(${RETAINED_ACTIONS}::text[])
              -- o3d-psrx r5 (Codex HIGH 2) — THE WITHHELD-REVERSAL MARKERS, retained by their
              -- RELATION to the document's other markers rather than by their action alone. See
              -- WITHHELD_OPEN_ACTION_NAMES above for the full argument. The action test is written
              -- FIRST so an ordinary row pays one array test and never reaches the two correlated
              -- subqueries.
              AND NOT (
                m.action = ANY(${WITHHELD_ALL_ACTION_NAMES}::text[])
                AND m."entityId" IS NOT NULL
                AND (
                  -- STILL THIS DOCUMENT'S OPEN MARKER: no newer open row, and no closure at least as
                  -- new. The >= at the tie is dueWithheldMarkers own test, so a row that scan
                  -- calls closed is exactly a row this sweep may delete.
                  (
                    m.action = ANY(${WITHHELD_OPEN_ACTION_NAMES}::text[])
                    AND NOT EXISTS (
                      SELECT 1 FROM "activity_logs" newer
                      WHERE newer."entityType" = m."entityType"
                        AND newer."entityId" = m."entityId"
                        AND newer."metadata"->>'connector' IS NOT DISTINCT FROM m."metadata"->>'connector'
                        AND (
                          (newer.action = ANY(${WITHHELD_OPEN_ACTION_NAMES}::text[]) AND newer."createdAt" > m."createdAt")
                          OR (newer.action = ANY(${WITHHELD_CLOSED_ACTION_NAMES}::text[]) AND newer."createdAt" >= m."createdAt")
                        )
                    )
                  )
                  -- OR THE PROOF THAT A DOCUMENT SETTLED, for as long as an open row it answers
                  -- survives. Closures are INFO and open rows are WARNING, so without this the proof
                  -- expires a month before the marker it settles and the survivor reads as open again.
                  OR (
                    m.action = ANY(${WITHHELD_CLOSED_ACTION_NAMES}::text[])
                    AND EXISTS (
                      SELECT 1 FROM "activity_logs" openrow
                      WHERE openrow."entityType" = m."entityType"
                        AND openrow."entityId" = m."entityId"
                        AND openrow."metadata"->>'connector' IS NOT DISTINCT FROM m."metadata"->>'connector'
                        AND openrow.action = ANY(${WITHHELD_OPEN_ACTION_NAMES}::text[])
                    )
                  )
                )
              )
            ORDER BY m."createdAt" ASC
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
