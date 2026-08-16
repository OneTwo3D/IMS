import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'
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
      // o3d-sref / o3d-nepa: this deletes by AGE ALONE, and that is a KNOWN, PRE-EXISTING gap in
      // the order delete guard's evidence — not one introduced here.
      //
      // A row that is unresolved (PROCESSING with a taken claim, or FAILED, which o3d-ju8t
      // established does NOT prove nothing was posted) is the guard's only evidence that a document
      // may exist in the ledger, since no externalTransactionId was ever written. Deleting it by age
      // makes the order hard-deletable again.
      //
      // An earlier revision of this branch exempted PROCESSING rows from deletion. That was
      // REVERTED: it retains the full row — payload included, holding customer names, emails and
      // financial lines — indefinitely, which contradicts the retention period the settings UI
      // promises, and every connector switch would strand more. Doing it properly needs a compacted
      // tombstone carrying only what the guard reads, which is tracked in o3d-nepa rather than
      // bolted on here.
      //
      // o3d-9kek: what this does NOT delete is UNRESOLVED BACK-REFERENCE EVIDENCE — a posted row
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
      db.accountingSyncLog.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          NOT: UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE,
        },
      }),
    ])
    syncLogsDeleted = wc.count + acct.count

    // The other half: expired-but-unresolved rows lose their CONTENT and keep their ATTRIBUTION.
    // Ordered after the delete deliberately — the two predicates are exact complements, so a row
    // belongs to one pass or the other and never both, and doing the delete first means a crash
    // between them leaves rows un-compacted (repeated next run) rather than un-deleted.
    //
    // `backReferenceEvidenceCompactedAt: null` PERMANENTLY excludes already-compacted rows, so each
    // daily run rewrites only the newly-eligible slice instead of the whole tombstone set — the
    // same shape as the o3d-ahk webhook inbox compaction below.
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
