import { Prisma } from '@/app/generated/prisma/client'
import { mirroredPostStanding } from '@/lib/domain/accounting/ledger-standing'

/**
 * THE DERIVED ACCOUNTING COPIES AND THE NOTIFICATION TEXT of an erased order (migration erasure_derived_copies).
 *
 *   accounting_events.linesJson                    the whole document payload, contact block included
 *   accounting_event_logs.metadata.enqueuedLinesJson  the superseded body kept when a payload changes (a third copy of the contact block)
 *   accounting_sync_logs.errorMessage              exception text; can echo the order's own contact or a THIRD PARTY's name read back out of the ledger
 *   notifications.title / .message                 free text of a notification that points at the order
 *
 * The contact rule is the SQL functions gdpr_scrub_contact / gdpr_event_keeps_contact_name: the email is always removed; the name is kept only where the copy may
 * describe a document in the ledger (the event's own evidence: status POSTED, or a document id, a revision stamp or a post basis. SUPERSEDED alone is not evidence: a no-write yield records it: the event-side
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
export function eventKeepsContactName(e: { status: string; postBasis: string | null; externalId: string | null; externalRevisionAt: Date | null }): boolean {
  return mirroredPostStanding(e) !== 'NOT_POSTED' || e.externalId !== null || e.externalRevisionAt !== null || e.postBasis !== null
}

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
const logDirty = Prisma.sql`jsonb_typeof(l."metadata" -> 'enqueuedLinesJson') = 'object' AND gdpr_contact_dirty(l."metadata" -> 'enqueuedLinesJson', gdpr_event_keeps_contact_name(e))`
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
       SET "metadata" = jsonb_set(l."metadata", '{enqueuedLinesJson}', gdpr_scrub_contact(l."metadata" -> 'enqueuedLinesJson', gdpr_event_keeps_contact_name(e)))
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

/** How far back the reconcile looks for a row inserted while an erasure was uncommitted. A trigger sees every committed erasure; only that window is open. */
export const DERIVED_RECONCILE_WINDOW = Prisma.sql`interval '2 days'`

/**
 * Finish what the triggers could not see: rows INSERTED while an erasure was still uncommitted. Idempotent; runs from the email-outbox cron.
 * Returns the number of rows changed and how many remain (0 after a clean run).
 */
export async function reconcileDerivedCopies(client: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>, batch = 500): Promise<{ changed: number; remaining: number }> {
  const eventsRecent = Prisma.sql`e."createdAt" >= now() - ${DERIVED_RECONCILE_WINDOW} AND gdpr_accounting_ref_erased(e."sourceEntityType", e."sourceEntityId")`
  const events = Number(await client.$executeRaw`
    UPDATE "accounting_events" x SET "linesJson" = gdpr_scrub_contact(x."linesJson", gdpr_event_keeps_contact_name(x))
     WHERE x."id" IN (SELECT e."id" FROM "accounting_events" e WHERE ${eventsRecent} AND jsonb_typeof(e."linesJson" -> 'contact') = 'object' AND ${eventDirty} LIMIT ${batch})`)
  const logs = Number(await client.$executeRaw`
    UPDATE "accounting_event_logs" x
       SET "metadata" = jsonb_set(x."metadata", '{enqueuedLinesJson}', gdpr_scrub_contact(x."metadata" -> 'enqueuedLinesJson', gdpr_event_keeps_contact_name(e)))
      FROM "accounting_events" e
     WHERE x."id" IN (SELECT l."id" FROM "accounting_event_logs" l JOIN "accounting_events" e ON e."id" = l."accountingEventId"
                       WHERE l."createdAt" >= now() - ${DERIVED_RECONCILE_WINDOW} AND gdpr_accounting_ref_erased(e."sourceEntityType", e."sourceEntityId") AND ${logDirty} LIMIT ${batch})
       AND e."id" = x."accountingEventId"`)
  const errors = Number(await client.$executeRaw`
    UPDATE "accounting_sync_logs" x SET "errorMessage" = ${DERIVED_ERROR_MARKER}::text
     WHERE x."id" IN (SELECT s."id" FROM "accounting_sync_logs" s
                       WHERE s."createdAt" >= now() - ${DERIVED_RECONCILE_WINDOW} AND ${errorDirty('s')} AND gdpr_accounting_ref_erased(s."referenceType", s."referenceId") LIMIT ${batch})`)
  const notes = Number(await client.$executeRaw`
    UPDATE "notifications" n SET "title" = 'Notification redacted', "message" = 'The text of this notification was removed by a personal-data erasure.'
     WHERE n."id" IN (SELECT t."id" FROM "notifications" t
                       WHERE t."createdAt" >= now() - ${DERIVED_RECONCILE_WINDOW} AND t."actionUrl" ~ '^/sales/[^/?#]+'
                         AND gdpr_order_id_erased(substring(t."actionUrl" from '^/sales/([^/?#]+)'))
                         AND (t."title" <> 'Notification redacted' OR t."message" <> 'The text of this notification was removed by a personal-data erasure.') LIMIT ${batch})`)
  const left = await client.$queryRaw<Array<{ n: bigint }>>`
    SELECT (SELECT count(*) FROM "accounting_events" e WHERE ${eventsRecent} AND jsonb_typeof(e."linesJson" -> 'contact') = 'object' AND ${eventDirty})
         + (SELECT count(*) FROM "accounting_sync_logs" s WHERE s."createdAt" >= now() - ${DERIVED_RECONCILE_WINDOW} AND ${errorDirty('s')} AND gdpr_accounting_ref_erased(s."referenceType", s."referenceId")) AS n`
  return { changed: events + logs + errors + notes, remaining: Number(left[0]?.n ?? 0) }
}
