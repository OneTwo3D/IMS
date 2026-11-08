import { Prisma } from '@/app/generated/prisma/client'
import { mirroredPostStanding } from '@/lib/domain/accounting/ledger-standing'
import { HISTORICAL_BACKFILL_REVISION_ORDER_BASIS, LIVE_UNSTAMPED_WRITE_REVISION_ORDER_BASIS } from '@/lib/domain/accounting/accounting-event-mirror'

/**
 * THE DERIVED ACCOUNTING COPIES AND THE NOTIFICATION TEXT of an erased order (migration erasure_derived_copies).
 *
 *   accounting_events.linesJson                    the whole document payload, contact block included
 *   accounting_event_logs.metadata.enqueuedLinesJson  the superseded body kept when a payload changes (a third copy of the contact block)
 *   accounting_sync_logs.errorMessage              exception text; can echo the order's own contact or a THIRD PARTY's name read back out of the ledger
 *   notifications.title / .message                 free text of a notification that points at the order
 *
 * The contact rule is the SQL functions gdpr_scrub_contact / gdpr_event_keeps_contact_name: the email is always removed; the name is kept only where the copy may
 * describe a document in the ledger (the event's own evidence: status POSTED, or a document id, a revision stamp, a post basis or a connector-write revisionOrderBasis. SUPERSEDED alone is not evidence: a no-write yield records it: the event-side
 * counterpart of the ledger standing the sync-log rule reads), otherwise it becomes the placeholder. The erasure statements here and the guard triggers call the same
 * functions, so a writer that comes after the erasure is held to the same rule. After the writes the same predicates are run again; a row left over THROWS, which
 * rolls the whole erasure back.
 *
 * Rows are found by (sourceEntityType, sourceEntityId) / (referenceType, referenceId) = the order and its refunds. A SalesOrder event, a SalesOrderRefund event and the
 * sync rows of both are reached; nothing else keys an accounting row to a sales order.
 */

/**
 * The TypeScript statement of the SQL function gdpr_event_keeps_contact_name: the event's document may be in the ledger. `mirroredPostStanding` decides the
 * POSTED half (every POSTED event, whatever its basis); a document id, a revision stamp or a post basis from an actual write covers an event that posted and was
 * later superseded. The two are run over one fixture matrix by tests/concurrency/erasure-derived-copies, so they cannot drift.
 */
export function eventKeepsContactName(e: { status: string; postBasis: string | null; externalId: string | null; externalRevisionAt: Date | null; revisionOrderBasis: string | null }): boolean {
  return mirroredPostStanding(e) !== 'NOT_POSTED' || e.externalId !== null || e.externalRevisionAt !== null || e.postBasis !== null
    // The revisionOrderBasis values that mean a connector write happened (the mirror's own constants): a document id taken over by a later revision clears externalId and postBasis.
    || (ACTUAL_WRITE_REVISION_ORDER_BASES as readonly string[]).includes(e.revisionOrderBasis ?? '')
}

export const ACTUAL_WRITE_REVISION_ORDER_BASES = [LIVE_UNSTAMPED_WRITE_REVISION_ORDER_BASIS, HISTORICAL_BACKFILL_REVISION_ORDER_BASIS] as const

export const DERIVED_ERROR_MARKER = 'Text removed by GDPR erasure'

export type DerivedCopyCounts = {
  /** Accounting events whose stored document payload had its contact block scrubbed, plus event-log rows whose superseded body did. */
  accountingEventCopiesScrubbed: number
  /** Accounting sync rows whose error text was replaced by the fixed marker. */
  accountingErrorsScrubbed: number
}

export const EMPTY_DERIVED_COPY_COUNTS: DerivedCopyCounts = { accountingEventCopiesScrubbed: 0, accountingErrorsScrubbed: 0 }

type Client = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw' | 'salesOrderRefund'>

const text = (ids: string[]) => Prisma.sql`${ids}::text[]`

function scope(alias: string, typeCol: string, idCol: string, orderIds: string[], refundIds: string[]): Prisma.Sql {
  const t = Prisma.raw(`${alias}."${typeCol}"`)
  const i = Prisma.raw(`${alias}."${idCol}"`)
  return Prisma.sql`((${t} = 'SalesOrder' AND ${i} = ANY(${text(orderIds)})) OR (${t} = 'SalesOrderRefund' AND ${i} = ANY(${text(refundIds)})))`
}

const eventDirty = Prisma.sql`gdpr_contact_dirty(e."linesJson", gdpr_event_keeps_contact_name(e))`
// An event log is dirty when its superseded body still carries contact identity the rule would remove, or its message is anything but the marker (a final failure writes the raw connector error there).
const logDirty = Prisma.sql`((jsonb_typeof(l."metadata" -> 'enqueuedLinesJson') = 'object' AND gdpr_contact_dirty(l."metadata" -> 'enqueuedLinesJson', gdpr_event_keeps_contact_name(e)))
    OR (l."message" IS NOT NULL AND l."message" <> ${DERIVED_ERROR_MARKER}::text))`
const logSet = (a: string) => Prisma.raw(`"metadata" = CASE WHEN jsonb_typeof(${a}."metadata" -> 'enqueuedLinesJson') = 'object'
      THEN jsonb_set(${a}."metadata", '{enqueuedLinesJson}', gdpr_scrub_contact(${a}."metadata" -> 'enqueuedLinesJson', gdpr_event_keeps_contact_name(e))) ELSE ${a}."metadata" END,
      "message" = CASE WHEN ${a}."message" IS NULL THEN NULL ELSE '${DERIVED_ERROR_MARKER}' END`)
const errorDirty = (a: string) => Prisma.raw(`${a}."errorMessage" IS NOT NULL AND ${a}."errorMessage" <> '${DERIVED_ERROR_MARKER}'`)

/** Scrub the derived accounting copies of these orders (and their refunds). The caller owns the transaction and holds the order locks. */
export async function scrubAccountingDerivedCopiesInTx(tx: Client, orderIds: string[]): Promise<DerivedCopyCounts> {
  if (orderIds.length === 0) return { ...EMPTY_DERIVED_COPY_COUNTS }
  const refundIds = (await tx.salesOrderRefund.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })).map((r) => r.id)
  const eventScope = scope('e', 'sourceEntityType', 'sourceEntityId', orderIds, refundIds)
  const logScope = scope('e', 'sourceEntityType', 'sourceEntityId', orderIds, refundIds)
  const syncScope = scope('s', 'referenceType', 'referenceId', orderIds, refundIds)

  const events = Number(await tx.$executeRaw`
    UPDATE "accounting_events" e SET "linesJson" = gdpr_scrub_contact(e."linesJson", gdpr_event_keeps_contact_name(e))
     WHERE ${eventScope} AND jsonb_typeof(e."linesJson" -> 'contact') = 'object' AND ${eventDirty}`)
  const logs = Number(await tx.$executeRaw`
    UPDATE "accounting_event_logs" l
       SET ${logSet('l')}
      FROM "accounting_events" e
     WHERE l."accountingEventId" = e."id" AND ${logScope} AND ${logDirty}`)
  const errors = Number(await tx.$executeRaw`
    UPDATE "accounting_sync_logs" s SET "errorMessage" = ${DERIVED_ERROR_MARKER}::text WHERE ${syncScope} AND ${errorDirty('s')}`)

  const left = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT (SELECT count(*) FROM "accounting_events" e WHERE ${eventScope} AND jsonb_typeof(e."linesJson" -> 'contact') = 'object' AND ${eventDirty})
         + (SELECT count(*) FROM "accounting_event_logs" l JOIN "accounting_events" e ON e."id" = l."accountingEventId" WHERE ${logScope} AND ${logDirty})
         + (SELECT count(*) FROM "accounting_sync_logs" s WHERE ${syncScope} AND ${errorDirty('s')}) AS n`
  if (Number(left[0]?.n ?? 0) > 0) throw new Error('Derived accounting copy scrub incomplete')
  return { accountingEventCopiesScrubbed: events + logs, accountingErrorsScrubbed: errors }
}

/**
 * HOW FAR BACK THE RECONCILE LOOKS FOR ERASURES, with a margin. The reconcile is driven by the SUBJECTS (orders erased, or whose customer was erased, within this
 * window), never by the age of a row: a row that is OLD but was updated by a transaction that overlapped the erasure commit (the writer's trigger snapshot saw the
 * order live) is revisited like any other. Every derived store is searched through the subject's keys (order id, its refund ids, the order url).
 */
export const DERIVED_RECONCILE_WINDOW = Prisma.sql`interval '3 days'`
/** Rows changed per statement, and the most statements-rounds one run makes before it reports what is left instead of draining it. */
export const DERIVED_RECONCILE_BATCH = 500
export const DERIVED_RECONCILE_MAX_ROUNDS = 20

export type DerivedReconcileResult = { changed: number; remaining: number; rounds: number }

// The erased subjects of the window and their keys, as CTEs shared by every statement below.
const subjects = Prisma.sql`
  subj AS (SELECT o."id" FROM "sales_orders" o LEFT JOIN "customers" c ON c."id" = o."customerId"
            WHERE o."erasedAt" >= now() - ${DERIVED_RECONCILE_WINDOW} OR c."gdprAnonymisedAt" >= now() - ${DERIVED_RECONCILE_WINDOW}),
  refs AS (SELECT s."id" AS "refId", 'SalesOrder' AS "refType" FROM subj s
           UNION ALL SELECT r."id", 'SalesOrderRefund' FROM "sales_order_refunds" r WHERE r."orderId" IN (SELECT "id" FROM subj))`

const notificationDirty = Prisma.sql`(t."title" <> 'Notification redacted' OR t."message" <> 'The text of this notification was removed by a personal-data erasure.')`
const notificationSubject = Prisma.sql`t."actionUrl" ~ '^/sales/[^/?#]+' AND substring(t."actionUrl" from '^/sales/([^/?#]+)') IN (SELECT "id" FROM subj)`

async function remainingDerived(client: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<number> {
  const left = await client.$queryRaw<Array<{ n: bigint }>>`
    WITH ${subjects}
    SELECT (SELECT count(*) FROM "accounting_events" e JOIN refs ON refs."refType" = e."sourceEntityType" AND refs."refId" = e."sourceEntityId"
             WHERE jsonb_typeof(e."linesJson" -> 'contact') = 'object' AND ${eventDirty})
         + (SELECT count(*) FROM "accounting_event_logs" l JOIN "accounting_events" e ON e."id" = l."accountingEventId"
             JOIN refs ON refs."refType" = e."sourceEntityType" AND refs."refId" = e."sourceEntityId" WHERE ${logDirty})
         + (SELECT count(*) FROM "accounting_sync_logs" s JOIN refs ON refs."refType" = s."referenceType" AND refs."refId" = s."referenceId" WHERE ${errorDirty('s')})
         + (SELECT count(*) FROM "notifications" t WHERE ${notificationSubject} AND ${notificationDirty}) AS n`
  return Number(left[0]?.n ?? 0)
}

/**
 * Finish what the triggers could not see: rows written by a transaction that overlapped an erasure's commit. Idempotent; runs from the email-outbox cron.
 * Drains in bounded batches until nothing is left or MAX_ROUNDS is reached; the caller must treat `remaining > 0` as a failure (the cron does).
 */
export async function reconcileDerivedCopies(client: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>, batch = DERIVED_RECONCILE_BATCH, maxRounds = DERIVED_RECONCILE_MAX_ROUNDS): Promise<DerivedReconcileResult> {
  let changed = 0
  let rounds = 0
  while (rounds < maxRounds) {
    rounds += 1
    const events = Number(await client.$executeRaw`
      UPDATE "accounting_events" x SET "linesJson" = gdpr_scrub_contact(x."linesJson", gdpr_event_keeps_contact_name(x))
       WHERE x."id" IN (WITH ${subjects} SELECT e."id" FROM "accounting_events" e JOIN refs ON refs."refType" = e."sourceEntityType" AND refs."refId" = e."sourceEntityId"
                         WHERE jsonb_typeof(e."linesJson" -> 'contact') = 'object' AND ${eventDirty} LIMIT ${batch})`)
    const logs = Number(await client.$executeRaw`
      UPDATE "accounting_event_logs" x
         SET ${logSet('x')}
        FROM "accounting_events" e
       WHERE e."id" = x."accountingEventId"
         AND x."id" IN (WITH ${subjects} SELECT l."id" FROM "accounting_event_logs" l JOIN "accounting_events" e ON e."id" = l."accountingEventId"
                         JOIN refs ON refs."refType" = e."sourceEntityType" AND refs."refId" = e."sourceEntityId" WHERE ${logDirty} LIMIT ${batch})`)
    const errors = Number(await client.$executeRaw`
      UPDATE "accounting_sync_logs" x SET "errorMessage" = ${DERIVED_ERROR_MARKER}::text
       WHERE x."id" IN (WITH ${subjects} SELECT s."id" FROM "accounting_sync_logs" s JOIN refs ON refs."refType" = s."referenceType" AND refs."refId" = s."referenceId"
                         WHERE ${errorDirty('s')} LIMIT ${batch})`)
    const notes = Number(await client.$executeRaw`
      UPDATE "notifications" n SET "title" = 'Notification redacted', "message" = 'The text of this notification was removed by a personal-data erasure.'
       WHERE n."id" IN (WITH ${subjects} SELECT t."id" FROM "notifications" t WHERE ${notificationSubject} AND ${notificationDirty} LIMIT ${batch})`)
    const round = events + logs + errors + notes
    changed += round
    if (round === 0) break
  }
  return { changed, remaining: await remainingDerived(client), rounds }
}
