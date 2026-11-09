import { logActivity } from '@/lib/activity-log'
import { db } from '@/lib/db'
import { isWcOrderWebhookPrimaryActive, retryHeldWcSalesInvoiceReleases, syncNewWcOrders } from './order-import'
import { isWcProductWebhookPrimaryActive, syncAllWcProducts } from './product-sync'
import { processQueuedWcStockSyncJobs } from './stock-sync-jobs'
import { queueRefundStockCorrections } from './refund-stock-correction'
import { pushStockToWc } from './stock-sync'

const ORDER_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000
const PRODUCT_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000
const STOCK_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000
// The forceAll stock reconcile reads WooCommerce for every candidate, about 0.13 s each on the stage catalogue, while the proxy
// in front of the app cuts a cron request at 60 s. It therefore works through the catalogue in id-ordered windows, saves the
// cursor after each, and stops starting windows once the request has used this much of its time. The next run continues.
const STOCK_RECONCILE_CHUNK_SIZE = 150
const STOCK_RECONCILE_REQUEST_BUDGET_MS = 20_000
export const STOCK_RECONCILE_CURSOR_KEY = 'wc_stock_daily_reconcile_cursor'

export async function runWcReconcile(): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const results: Record<string, unknown> = {}

  const webhookPrimaryActive = await isWcOrderWebhookPrimaryActive()
  if (!webhookPrimaryActive) {
    results.orders = await syncNewWcOrders({ mode: 'poll' })
  } else {
    const lastReconcile = await db.setting.findUnique({ where: { key: 'last_wc_order_reconcile_at' } })
    const lastReconcileTs = lastReconcile?.value ? Date.parse(lastReconcile.value) : Number.NaN
    const reconcileDue = !Number.isFinite(lastReconcileTs) || (Date.now() - lastReconcileTs) >= ORDER_RECONCILE_INTERVAL_MS

    results.orders = reconcileDue
      ? await syncNewWcOrders({ mode: 'reconcile' })
      : {
          skipped: true,
          reason: 'webhook_primary_active',
          reconciliationDue: false,
          lastReconciledAt: lastReconcile?.value ?? null,
        }
  }

  // o3d-k26m.6 round 4: THE DRIVER for a sales invoice held back for its number and not released.
  // A failed release leaves the hold PENDING, and the only other thing that would ever retry it is
  // another import of that order — which happens only if WooCommerce touches the order again, and
  // the number arriving was that touch. This runs on the cron's timer instead, so a hold stuck
  // behind a disconnected accounting connector is picked up when the connector comes back rather
  // than never. Unconditional: it is a database sweep of work already owed, not a WooCommerce call.
  results.heldSalesInvoices = await retryHeldWcSalesInvoiceReleases()

  const productEnabled = await db.setting.findUnique({ where: { key: 'wc_sync_product_enabled' } })
  if (productEnabled?.value === 'true') {
    const direction = await db.setting.findUnique({ where: { key: 'wc_sync_product_direction' } })
    if (!direction?.value || direction.value === 'from_wc' || direction.value === 'both') {
      const productWebhookPrimaryActive = await isWcProductWebhookPrimaryActive()
      if (!productWebhookPrimaryActive) {
        results.products = await syncAllWcProducts({ mode: 'poll' })
      } else {
        const lastReconcile = await db.setting.findUnique({ where: { key: 'last_wc_product_reconcile_at' } })
        const lastReconcileTs = lastReconcile?.value ? Date.parse(lastReconcile.value) : Number.NaN
        const reconcileDue = !Number.isFinite(lastReconcileTs) || (Date.now() - lastReconcileTs) >= PRODUCT_RECONCILE_INTERVAL_MS

        results.products = reconcileDue
          ? await syncAllWcProducts({ mode: 'reconcile' })
          : {
              skipped: true,
              reason: 'webhook_primary_active',
              reconciliationDue: false,
              lastReconciledAt: lastReconcile?.value ?? null,
            }
      }
    }
  }

  const stockEnabled = await db.setting.findUnique({ where: { key: 'wc_stock_sync_enabled' } })
  if (stockEnabled?.value === 'true') {
    // Stock corrections that refunds still owe the store (a queue failure left them open): record their jobs first so this run processes them.
    try {
      await queueRefundStockCorrections({ limit: 50 })
    } catch (error) {
      console.error('[wc-reconcile] queueing open refund stock corrections failed', error)
    }
    const queued = await processQueuedWcStockSyncJobs({ limit: 100 })
    const lastReconcile = await db.setting.findUnique({ where: { key: 'last_wc_stock_daily_reconcile_at' } })
    const lastReconcileTs = lastReconcile?.value ? Date.parse(lastReconcile.value) : Number.NaN
    const reconcileDue = !Number.isFinite(lastReconcileTs) || (Date.now() - lastReconcileTs) >= STOCK_RECONCILE_INTERVAL_MS

    // A pass that was cut short by the request budget carries on from its cursor on the next run, whether or not 24 hours have
    // passed: the daily stamp is only written when the pass reaches the end of the catalogue.
    const cursorRow = await db.setting.findUnique({ where: { key: STOCK_RECONCILE_CURSOR_KEY } })
    let cursor: string | null = cursorRow?.value ? cursorRow.value : null
    if (reconcileDue || cursor != null) {
      let chunks = 0
      let pushed = 0
      let candidatesTotal = 0
      for (;;) {
        const stock = await pushStockToWc({
          forceAll: true,
          source: 'DAILY_RECONCILIATION',
          chunk: { afterId: cursor, limit: STOCK_RECONCILE_CHUNK_SIZE },
        })
        // A push the producer-side hold shadowed did NOT reconcile anything: the daily stamp is what makes the next 24 hours
        // "not due", so stamping it would tell the live phase's first run that stock was just reconciled. Leave the stamp alone,
        // and say so in the result. (A push the setting or the gates refused is stamped as before: that is the unchanged path.)
        // The same holds for a push the outbound-write hold refused before it read anything: nothing was reconciled.
        if (stock.shadowed === true || stock.held === true) {
          results.stock = {
            queued,
            sync: stock,
            skipped: true,
            reason: stock.held === true ? 'outbound_write_held' : 'producer_hold_shadowed',
            reconciliationDue: true,
            lastReconciledAt: lastReconcile?.value ?? null,
          }
          return results
        }
        chunks++
        pushed += stock.synced
        if (stock.chunk) {
          candidatesTotal = stock.chunk.totalCandidates
          if (stock.chunk.nextCursor != null) {
            // The window was handled and there is more catalogue behind it. Remember where, then take another window only
            // while the request is still well inside the proxy's cut-off.
            cursor = stock.chunk.nextCursor
            await db.setting.upsert({
              where: { key: STOCK_RECONCILE_CURSOR_KEY },
              create: { key: STOCK_RECONCILE_CURSOR_KEY, value: cursor },
              update: { value: cursor },
            })
            if (Date.now() - startedAt < STOCK_RECONCILE_REQUEST_BUDGET_MS) continue
            results.stock = {
              queued,
              sync: stock,
              skipped: true,
              reason: 'reconciliation_continues_next_run',
              reconciliationDue: true,
              chunks,
              synced: pushed,
              candidates: candidatesTotal,
              resumeAfter: cursor,
              lastReconciledAt: lastReconcile?.value ?? null,
            }
            return results
          }
        } else if (cursor != null || stock.aborted !== true) {
          // The window was not handled: an outage or a credentials rebind cut it short, or a SKU lookup, a preflight page or a
          // push entry in it failed. Only a gate refusal on the first window (aborted, no cursor) falls through to the legacy
          // stamp. The pass is unfinished: keep the cursor, leave the stamp, and retry this window on the next run. A product
          // that keeps failing therefore holds the pass here, so every such run says so in the activity log instead of retrying
          // silently; the manual push remains available.
          await logActivity({
            entityType: 'SYNC', action: 'stock_reconcile_window', tag: 'sync', level: 'WARNING',
            description: `Daily stock reconcile window after ${cursor ?? 'the start'} is not complete (${stock.errors.length} error(s)); the pass is held at this window and no daily stamp is written`,
            metadata: { resumeAfter: cursor, message: stock.message, errors: stock.errors.slice(0, 10) },
          })
          results.stock = {
            queued,
            sync: stock,
            skipped: true,
            reason: 'reconciliation_window_incomplete',
            errors: stock.errors.slice(0, 10),
            reconciliationDue: true,
            chunks,
            resumeAfter: cursor,
            lastReconciledAt: lastReconcile?.value ?? null,
          }
          return results
        }
        // The last window, or a refusal on the first one (which stamps exactly as before): the pass is over.
        if (cursor != null || cursorRow) await db.setting.deleteMany({ where: { key: STOCK_RECONCILE_CURSOR_KEY } })
        const now = new Date().toISOString()
        await db.setting.upsert({
          where: { key: 'last_wc_stock_daily_reconcile_at' },
          create: { key: 'last_wc_stock_daily_reconcile_at', value: now },
          update: { value: now },
        })
        results.stock = {
          queued,
          sync: stock,
          reconciledAt: now,
          ...(chunks > 1 || cursorRow ? { chunks } : {}),
        }
        break
      }
    } else {
      results.stock = {
        queued,
        skipped: true,
        reason: 'daily_reconciliation_not_due',
        reconciliationDue: false,
        lastReconciledAt: lastReconcile?.value ?? null,
      }
    }
  }

  return results
}
