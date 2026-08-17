import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'
import { POSTABLE_ACCOUNTING_SYNC_STATUSES } from '@/lib/domain/accounting/postable-sync-statuses'
import {
  UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE,
  backReferenceEvidenceTombstone,
} from '@/lib/domain/accounting/back-reference-sweep'

const RETENTION_KEYS = [
  'retention_sales_orders_months',
  'retention_purchase_orders_months',
  'retention_customers_months',
  'retention_stock_movements_months',
  'retention_sync_logs_months',
  'retention_webhook_events_months',
] as const

const DEFAULTS: Record<string, number> = {
  retention_sales_orders_months: 0,
  retention_purchase_orders_months: 0,
  retention_customers_months: 0,
  retention_stock_movements_months: 0,
  retention_sync_logs_months: 6,
  // o3d-ahk: COMPACT succeeded shopping-webhook-inbox rows after N months — clear the bulky payloadJson
  // to reclaim storage while KEEPING the (connector, resource, payloadHash) row as an idempotency
  // tombstone (deleting it would let a redelivered/replayed old payload reprocess). Default 3 months.
  // Only PROCESSED rows are compacted; DEAD_LETTER (failed, unresolved) and PENDING/FAILED (undelivered)
  // are left fully intact for investigation/replay.
  retention_webhook_events_months: 3,
}

async function getRetentionSettings(): Promise<Record<string, number>> {
  const rows = await db.setting.findMany({
    where: { key: { in: [...RETENTION_KEYS] } },
  })
  const result: Record<string, number> = {}
  for (const key of RETENTION_KEYS) {
    const row = rows.find((r) => r.key === key)
    const parsed = row ? Number.parseInt(row.value, 10) : DEFAULTS[key]
    result[key] = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULTS[key]
  }
  return result
}

function monthsAgo(months: number): Date {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return d
}

/**
 * Purge or archive expired data based on retention settings.
 * - Sync logs & stock movements: hard-deleted
 * - Sales orders, purchase orders, customers: soft-archived (archived = true)
 * Call on a daily schedule via /api/cron/activity-cleanup.
 */
export async function purgeExpiredData(): Promise<{
  syncLogsDeleted: number
  /** Expired-but-unresolved accounting sync rows reduced to an attribution-only tombstone (o3d-9kek). */
  backReferenceEvidenceCompacted: number
  stockMovementsDeleted: number
  webhookEventsCompacted: number
  salesOrdersArchived: number
  purchaseOrdersArchived: number
  customersArchived: number
}> {
  const settings = await getRetentionSettings()
  let syncLogsDeleted = 0
  let backReferenceEvidenceCompacted = 0
  let stockMovementsDeleted = 0
  let webhookEventsCompacted = 0
  let salesOrdersArchived = 0
  let purchaseOrdersArchived = 0
  let customersArchived = 0

  // Sync logs — hard delete
  const syncMonths = settings.retention_sync_logs_months
  if (syncMonths > 0) {
    const cutoff = monthsAgo(syncMonths)
    const [wc, acct] = await Promise.all([
      db.shoppingSyncLog.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          // o3d-w00 / o3d-iup / o3d-7yf: never retention-delete an UNRESOLVED WooCommerce refund park
          // (PENDING/FAILED amount-mismatch or QUARANTINED monetary-only). Each is a refund whose money
          // already left the business but has no SalesOrderRefund / credit note yet; deleting it erases the
          // only record of an unaccounted refund and defeats the deletion/rebind guards that rely on it.
          // It must persist until an operator resolves it (which flips it to SYNCED, after which it expires
          // normally). Now that upsertRefundPark dedups parks to one row per refund, excluding PENDING/
          // FAILED no longer risks the unbounded growth that scoped this to QUARANTINED before. entityId:
          // not null also skips the entity-less missing-FX queue rows.
          NOT: {
            connector: 'woocommerce',
            direction: 'FROM_CONNECTOR',
            entityType: 'SalesOrder',
            status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
            entityId: { not: null },
          },
        },
      }),
      // o3d-nepa / o3d-y14: age alone NEVER expires accounting work that can still be posted.
      //
      // A PENDING, PROCESSING or FAILED row is not a log of something that happened — it is an
      // UNFINISHED JOB carrying the payload a worker will post from. Deleting one does not merely
      // lose an audit trail:
      //
      //   • Both processors read the sync row and its payload BEFORE they conditionally claim it,
      //     so a worker can be holding the payload in memory while retention removes the row. The
      //     remote call then still happens, and there is nothing left to record that it did — its
      //     own status write-back fails against a row that no longer exists.
      //   • Anything that reasons about "is there live accounting work for this order" reads this
      //     table. `applyWcCouponCorrection` (o3d-y14) counts these statuses under the sales-order
      //     row lock and declines to correct an order that has any, because a queued payload is a
      //     SNAPSHOT built from the pre-correction amount. A retention pass that deletes the row
      //     turns that decided fact into a false one: the backfill counts zero, permanently stamps
      //     the order as corrected, and the worker still posts the understated invoice. The same
      //     count backs the hard-delete guard (o3d-sref, o3d-ju8t: FAILED does not prove nothing
      //     was posted).
      //
      // So the exemption is keyed on the SHARED constant both readers use — if the two sets ever
      // drift the hole reopens silently, which is why neither side spells the statuses out.
      //
      // AN EARLIER REVISION of this branch exempted PROCESSING only, and was reverted on the
      // grounds that retaining whole rows contradicts the retention period the settings UI
      // promises. That objection is answered by fixing the PROMISE rather than the data, because
      // there is no version of this that keeps both: a compacted payload cannot be posted, so
      // retaining unfinished work whole is the only shape that works. What is retained is bounded
      // by the OUTSTANDING WORK BACKLOG (visible and actionable on the failed-sync dashboard), not
      // by history — every row leaves the exemption the moment it reaches SYNCED or CANCELLED, and
      // is then expired by age normally. components/settings/data-retention.tsx says so.
      // o3d-9kek: what this ALSO does not delete is UNRESOLVED BACK-REFERENCE EVIDENCE — a posted row
      // whose repair sweep has not reached a verdict on it. Deleting one of those does not just
      // lose an audit trail: deleting a COMPETING sibling turns an ambiguity the sweep was
      // refusing to guess at into an apparent certainty (one unlinked bill, one surviving
      // claimant), and the sweep then attributes an external id whose competitor it can no longer
      // see. Nothing downstream can detect that, because the surviving state is genuinely
      // indistinguishable from an unambiguous one.
      //
      // Those rows are COMPACTED instead (below), not exempted. An earlier revision of this branch
      // exempted them outright and called it bounded because "the sweep stamps every row it
      // settles". It is not bounded: a permanently ambiguous row is never stamped by design, a
      // disconnected connector's rows are never swept at all, and no QuickBooks sweep existed, so
      // full payloads — customer names, emails, addresses, financial lines — could outlive the
      // configured retention period indefinitely. That is the same defect as the reverted
      // PROCESSING exemption above, and it is fixed the same way the o3d-nepa note prescribes: a
      // compacted tombstone carrying only what a later reader must be able to see.
      //
      // BOTH CLAUSES ARE LOAD-BEARING AND NEITHER SUBSUMES THE OTHER. They answer different
      // questions about different rows, and the two sets only partly overlap:
      //
      //   status ∈ POSTABLE      — "can a document still be posted FROM this row?" PENDING has no
      //                            externalTransactionId at all, so the back-reference predicate
      //                            never sees it; without this clause a PENDING SALES_INVOICE is
      //                            still deleted by age and the o3d-y14 count still reads zero.
      //   NOT UNRESOLVED_…        — "is this row the only evidence that a document was posted
      //                            without being linked?" That set is SYNCED/FAILED-with-an-id, so
      //                            it covers SYNCED rows this clause deliberately does not.
      //
      // Their intersection (FAILED carrying an external id) is retained by both and then COMPACTED
      // by the pass below, which blanks the payload. That is safe rather than a contradiction: an
      // external id means the document already posted, and both processors short-circuit to the
      // follow-ups instead of re-posting when `externalTransactionId` is set, so no blanked payload
      // is ever sent. What matters to o3d-y14 is that the ROW SURVIVES — the fence COUNTS rows, it
      // does not read their payloads, so a compacted row still blocks the correction exactly as an
      // intact one does.
      db.accountingSyncLog.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          status: { notIn: [...POSTABLE_ACCOUNTING_SYNC_STATUSES] },
          NOT: UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE,
        },
      }),
    ])
    syncLogsDeleted = wc.count + acct.count

    // The other half: expired-but-unresolved rows lose their CONTENT and keep their ATTRIBUTION.
    // Ordered after the delete deliberately — the two predicates are MUTUALLY EXCLUSIVE (the delete
    // requires NOT UNRESOLVED_…, this one requires it), so no row can be both deleted and compacted,
    // and doing the delete first means a crash between them leaves rows un-compacted (repeated next
    // run) rather than un-deleted. They are no longer exact COMPLEMENTS, because o3d-y14 also holds
    // POSTABLE rows back from the delete: a PENDING job is now in neither pass, which is the
    // intended outcome — it is unfinished work, so it is neither expired nor stripped of the payload
    // it will post from.
    //
    // `backReferenceEvidenceCompactedAt: null` PERMANENTLY excludes already-compacted rows from THIS
    // PASS, so each daily run rewrites only the newly-eligible slice instead of the whole tombstone
    // set — the same shape as the o3d-ahk webhook inbox compaction below.
    //
    // It does NOT exclude them from the repair sweep (o3d-9kek r4 finding 3). An earlier revision
    // did, which meant retention silently RETIRED unresolved repair work: compaction is scheduled by
    // age and says nothing about repairability, so an ambiguity that cleared after the horizon was
    // never reconsidered and a transiently failing back-reference was never repaired. A tombstone
    // keeps every column the id write needs and stays a candidate for it; what is genuinely lost is
    // only the payload-dependent follow-ups, which the sweep discards under an explicit terminal
    // policy and warns about.
    const { count: compacted } = await db.accountingSyncLog.updateMany({
      where: {
        createdAt: { lt: cutoff },
        ...UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE,
        backReferenceEvidenceCompactedAt: null,
      },
      data: backReferenceEvidenceTombstone(new Date()),
    })
    backReferenceEvidenceCompacted = compacted
  }

  // Shopping webhook inbox — COMPACT succeeded rows (o3d-ahk). Clear the bulky payloadJson to reclaim
  // storage but KEEP the row: its (connector, resource, payloadHash) unique key is the inbox's
  // idempotency record, so deleting it would let a redelivered or replayed old payload be accepted as
  // new and reprocessed (re-applying stale addresses/status, re-enqueueing stock). Only PROCESSED rows
  // are compacted; DEAD_LETTER (failed/unresolved — the only record of the failed event) and
  // PENDING/FAILED (undelivered work) are left fully intact. The `payloadJson != {}` predicate
  // PERMANENTLY excludes already-compacted rows, so each daily run only touches the newly-eligible set
  // (a day's worth of rows crossing the cutoff) rather than rewriting the whole retained tombstone set.
  const webhookMonths = settings.retention_webhook_events_months
  if (webhookMonths > 0) {
    const cutoff = monthsAgo(webhookMonths)
    const { count } = await db.shoppingWebhookEvent.updateMany({
      where: {
        status: WC_WEBHOOK_EVENT_STATUS.processed,
        updatedAt: { lt: cutoff },
        NOT: { payloadJson: { equals: {} } },
      },
      data: { payloadJson: {}, lastError: null },
    })
    webhookEventsCompacted = count
  }

  // Stock movements — hard delete (exclude historical import types)
  const movementMonths = settings.retention_stock_movements_months
  if (movementMonths > 0) {
    const cutoff = monthsAgo(movementMonths)
    const movementIds = (await db.stockMovement.findMany({
      where: {
        createdAt: { lt: cutoff },
        NOT: { referenceType: { in: ['WcHistorical', 'WcInitialImport', 'CsvHistorical'] } },
      },
      select: { id: true },
    })).map((row) => row.id)

    if (movementIds.length > 0) {
      await db.cogsEntry.deleteMany({
        where: { movementId: { in: movementIds } },
      })
      await db.costLayer.updateMany({
        where: { adjustmentMovementId: { in: movementIds } },
        data: { adjustmentMovementId: null },
      })
      const { count } = await db.stockMovement.deleteMany({
        where: { id: { in: movementIds } },
      })
      stockMovementsDeleted = count
    }
  }

  // Sales orders — soft archive terminal-status orders
  const soMonths = settings.retention_sales_orders_months
  if (soMonths > 0) {
    const cutoff = monthsAgo(soMonths)
    const { count } = await db.salesOrder.updateMany({
      where: {
        createdAt: { lt: cutoff },
        // Terminal lifecycle, or any refunded order (refund state is now orthogonal).
        OR: [
          { status: { in: ['COMPLETED', 'DELIVERED', 'CANCELLED'] } },
          { refundStatus: { not: 'NONE' } },
        ],
        archived: false,
      },
      data: { archived: true },
    })
    salesOrdersArchived = count
  }

  // Purchase orders — soft archive terminal-status POs
  const poMonths = settings.retention_purchase_orders_months
  if (poMonths > 0) {
    const cutoff = monthsAgo(poMonths)
    const { count } = await db.purchaseOrder.updateMany({
      where: {
        createdAt: { lt: cutoff },
        status: { in: ['RECEIVED', 'CLOSED', 'INVOICED', 'PARTIALLY_RETURNED', 'RETURNED', 'CANCELLED'] },
        archived: false,
      },
      data: { archived: true },
    })
    purchaseOrdersArchived = count
  }

  // Customers — soft archive inactive customers with no unarchived orders
  const custMonths = settings.retention_customers_months
  if (custMonths > 0) {
    const cutoff = monthsAgo(custMonths)
    const { count } = await db.customer.updateMany({
      where: {
        updatedAt: { lt: cutoff },
        archived: false,
        salesOrders: { none: { archived: false } },
      },
      data: { archived: true },
    })
    customersArchived = count
  }

  // Log activity for each type that had changes
  const parts: string[] = []
  if (syncLogsDeleted > 0) parts.push(`${syncLogsDeleted} sync logs deleted`)
  if (backReferenceEvidenceCompacted > 0) parts.push(`${backReferenceEvidenceCompacted} unresolved back-reference sync logs compacted`)
  if (stockMovementsDeleted > 0) parts.push(`${stockMovementsDeleted} stock movements deleted`)
  if (webhookEventsCompacted > 0) parts.push(`${webhookEventsCompacted} webhook events compacted`)
  if (salesOrdersArchived > 0) parts.push(`${salesOrdersArchived} sales orders archived`)
  if (purchaseOrdersArchived > 0) parts.push(`${purchaseOrdersArchived} purchase orders archived`)
  if (customersArchived > 0) parts.push(`${customersArchived} customers archived`)

  if (parts.length > 0) {
    await logActivity({
      entityType: 'SYSTEM',
      action: 'cleanup',
      tag: 'system',
      description: `Data retention cleanup: ${parts.join(', ')}`,
      metadata: { syncLogsDeleted, backReferenceEvidenceCompacted, stockMovementsDeleted, webhookEventsCompacted, salesOrdersArchived, purchaseOrdersArchived, customersArchived },
      resolveUser: false,
    })
  }

  return { syncLogsDeleted, backReferenceEvidenceCompacted, stockMovementsDeleted, webhookEventsCompacted, salesOrdersArchived, purchaseOrdersArchived, customersArchived }
}
