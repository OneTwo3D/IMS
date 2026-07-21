import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { WC_WEBHOOK_EVENT_STATUS } from '@/lib/connectors/shopping-webhook-inbox'

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
  stockMovementsDeleted: number
  webhookEventsCompacted: number
  salesOrdersArchived: number
  purchaseOrdersArchived: number
  customersArchived: number
}> {
  const settings = await getRetentionSettings()
  let syncLogsDeleted = 0
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
      db.accountingSyncLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    ])
    syncLogsDeleted = wc.count + acct.count
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
      metadata: { syncLogsDeleted, stockMovementsDeleted, webhookEventsCompacted, salesOrdersArchived, purchaseOrdersArchived, customersArchived },
      resolveUser: false,
    })
  }

  return { syncLogsDeleted, stockMovementsDeleted, webhookEventsCompacted, salesOrdersArchived, purchaseOrdersArchived, customersArchived }
}
