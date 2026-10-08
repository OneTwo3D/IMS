/**
 * The in-application half of the WooCommerce initial-import rehearsal (scripts/rehearse-woo-import.ts).
 *
 * It runs the application's OWN code, through the application's own database client, against the
 * throwaway cluster named by DATABASE_URL in its environment, and the fake store named by
 * REHEARSAL_STORE_URL. One phase per invocation; each prints exactly one line, `REHEARSAL_DRIVER {json}`,
 * and exits 0. Any failure is a thrown error and exit 1.
 *
 *   prepare        create the IMS-side fixtures (products, stock, tax mappings, FX rate, the WooCommerce
 *                  connection settings, the order-status selection)
 *   import         run the REAL initial-import pass (`runInitialImport`), as a rehearsal (no stamp) or as the
 *                  real thing (stamp)
 *   try-start      call the button's own entry point (`startInitialImport`) and say whether it ran
 *   retry-rows     list the orders the import refused that have a durable retry row (the pending-FX queue)
 *   land-stock     put stock into IMS AFTER the import, then trigger allocation by the routes production uses
 *
 * It never contacts anything but the fake store: the connector reads its URL and credentials from the
 * settings this script wrote, exactly as it does in production.
 */
import { db } from '@/lib/db'
import { serializeSettingValue } from '@/lib/settings-store'

const FIXTURE_SKUS = {
  stocked: 'REH-A-STOCKED',
  unstocked: 'REH-B-UNSTOCKED',
  plenty: 'REH-C-PLENTY',
} as const

/** Stock the IMS side starts with. A is short on purpose (an order wants 50), B has none, C is plenty until the bulk orders. */
const OPENING_STOCK: Record<string, { qty: number; unitCost: number }> = {
  [FIXTURE_SKUS.stocked]: { qty: 6, unitCost: 4 },
  [FIXTURE_SKUS.plenty]: { qty: 100, unitCost: 5 },
}

function emit(payload: unknown): void {
  console.log(`REHEARSAL_DRIVER ${JSON.stringify(payload)}`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function upsertSetting(key: string, value: string): Promise<void> {
  const stored = serializeSettingValue(key, value)
  await db.setting.upsert({ where: { key }, create: { key, value: stored }, update: { value: stored } })
}

async function prepare(): Promise<void> {
  const url = requireEnv('REHEARSAL_STORE_URL')
  const key = requireEnv('REHEARSAL_STORE_KEY')
  const secret = requireEnv('REHEARSAL_STORE_SECRET')
  const statuses = JSON.parse(requireEnv('REHEARSAL_STORE_STATUSES')) as string[]

  // The seeded default warehouse is NOT storefront-synced; the import files orders against the
  // storefront-synced one, so an operator ticks it before the first import. The rehearsal does the same.
  const warehouse = await db.warehouse.findFirstOrThrow({ where: { isDefault: true } })
  await db.warehouse.update({ where: { id: warehouse.id }, data: { syncToStore: true } })

  const products: Record<string, string> = {}
  for (const sku of Object.values(FIXTURE_SKUS)) {
    const product = await db.product.upsert({ where: { sku }, create: { sku, name: `Rehearsal ${sku}` }, update: {} })
    products[sku] = product.id
  }

  const { applyOpeningStock } = await import('@/lib/domain/inventory/opening-stock')
  const { lockStockLevelRow } = await import('@/lib/cost-layers')
  for (const [sku, stock] of Object.entries(OPENING_STOCK)) {
    await db.$transaction(async (tx) => {
      await lockStockLevelRow(tx, products[sku]!, warehouse.id)
      await applyOpeningStock({ tx, productId: products[sku]!, warehouseId: warehouse.id, qty: stock.qty, unitCostBase: stock.unitCost, note: 'rehearsal opening stock' })
    })
  }
  // The unstocked SKU exists with a zero stock row, as a product that sold out would.
  await db.$transaction(async (tx) => { await lockStockLevelRow(tx, products[FIXTURE_SKUS.unstocked]!, warehouse.id) })

  // WooCommerce tax-rate ids 1 and 2 are mapped; 99 deliberately is not.
  const standard = await db.taxRate.findFirstOrThrow({ where: { name: 'UK Standard Rate (20%)' } })
  const reduced = await db.taxRate.findFirstOrThrow({ where: { name: 'UK Reduced Rate (5%)' } })
  for (const [externalId, name, pct, taxRateId] of [['1', 'VAT', '20', standard.id], ['2', 'Reduced rate VAT', '5', reduced.id]] as const) {
    await db.shoppingTaxRateMapping.upsert({
      where: { connector_externalTaxRateId: { connector: 'woocommerce', externalTaxRateId: externalId } },
      create: { connector: 'woocommerce', externalTaxRateId: externalId, externalName: name, externalCountry: 'GB', externalRatePct: pct, taxRateId },
      update: { taxRateId },
    })
  }

  // 1 GBP = 1.25 EUR, dated before every fixture order.
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.25', fetchedAt: new Date('2026-08-01T00:00:00Z'), source: 'manual', manualOverride: true } })

  await upsertSetting('wc_url', url)
  await upsertSetting('wc_consumer_key', key)
  await upsertSetting('wc_consumer_secret', secret)
  await upsertSetting('wc_sync_order_statuses', JSON.stringify(statuses))

  emit({ phase: 'prepare', warehouseId: warehouse.id, products, openingStock: OPENING_STOCK })
}

async function readStamp(): Promise<{ completed: string | null; cursor: string | null }> {
  const rows = await db.setting.findMany({ where: { key: { in: ['wc_initial_import_completed', 'last_wc_order_sync_at'] } } })
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? null
  return { completed: get('wc_initial_import_completed'), cursor: get('last_wc_order_sync_at') }
}

async function importPhase(mode: 'rehearsal' | 'real'): Promise<void> {
  const { runInitialImport, getInitialImportProgress } = await import('@/lib/connectors/woocommerce/sync/initial-import')
  const before = await readStamp()
  const progress = {
    status: 'running' as const,
    message: 'Preparing active order import…',
    activeOrdersImported: 0,
    activeOrdersSkipped: 0,
    totalOrders: 0,
    currentPage: 0,
    totalPages: 0,
    errors: [] as string[],
  }
  const result = await runInitialImport(progress, { stampCompletion: mode === 'real' })
  const after = await readStamp()
  const persisted = await getInitialImportProgress()
  emit({
    phase: 'import',
    mode,
    stampBefore: before,
    stampAfter: after,
    outcome: result.outcome,
    stamped: result.stamped,
    statuses: result.statuses,
    unrecordedRefusals: result.unrecordedRefusals,
    progress: result.progress,
    persistedStatus: persisted.status,
  })
}

async function tryStart(): Promise<void> {
  // The button's own entry point. It declines when the stamp is set; otherwise it schedules the pass with
  // next/server's `after`, which needs a request scope this process does not have, so it throws there:
  // either way the answer to "did the pass start" is whether the progress row says running.
  const { startInitialImport, getInitialImportProgress } = await import('@/lib/connectors/woocommerce/sync/initial-import')
  const before = await getInitialImportProgress()
  let threw: string | null = null
  try {
    await startInitialImport()
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  const after = await getInitialImportProgress()
  emit({ phase: 'try-start', progressBefore: before.status, progressAfter: after.status, threw, stamp: await readStamp() })
}

/** Orders the import refused for a reason that leaves a durable retry row: the pending-FX queue, by the application's own predicate. */
async function retryRows(): Promise<void> {
  const { pendingFxQueueWhere } = await import('@/lib/connectors/woocommerce/sync/order-import')
  const rows = await db.shoppingSyncLog.findMany({ where: pendingFxQueueWhere(), select: { externalId: true } })
  emit({ phase: 'retry-rows', externalOrderIds: rows.map((row) => Number(row.externalId)) })
}

async function landStock(): Promise<void> {
  const landing = JSON.parse(requireEnv('REHEARSAL_LANDING')) as Array<{ sku: string; qty: number; unitCost: number }>
  const warehouse = await db.warehouse.findFirstOrThrow({ where: { isDefault: true } })
  const { applyStockAdjustment } = await import('@/lib/domain/inventory/stock-adjustment-apply')
  const { allocateBackordersForProducts } = await import('@/lib/fulfillment/backorder-allocator')
  const { sweepUnallocatedProcessingOrders } = await import('@/lib/fulfillment/reallocation-sweep')

  // Orders with a PRODUCT line whose allocation is short of the quantity ordered: the ones waiting for stock.
  const snapshot = async () => {
    const rows = await db.$queryRawUnsafe<Array<{ orderNumber: string; status: string }>>(`
      select so."externalOrderNumber" as "orderNumber", so.status::text as status
        from sales_orders so
       where exists (
         select 1 from sales_order_lines sol
          where sol."orderId" = so.id and sol."productId" is not null
            and sol.qty > coalesce((select sum(oa.qty) from order_allocations oa where oa."lineId" = sol.id), 0) + 0.0001)
       order by so."externalOrderNumber"`)
    return rows
  }

  const beforeLandingRows = await snapshot()
  const statusByOrder = Object.fromEntries(beforeLandingRows.map((r) => [r.orderNumber, r.status]))
  const beforeLanding = beforeLandingRows.map((r) => r.orderNumber)
  const productIds: string[] = []
  for (const item of landing) {
    const product = await db.product.findUniqueOrThrow({ where: { sku: item.sku }, select: { id: true } })
    productIds.push(product.id)
    await db.$transaction(async (tx) => {
      await applyStockAdjustment({ tx, productId: product.id, warehouseId: warehouse.id, qty: item.qty, unitCostBase: item.unitCost, note: 'rehearsal: stock lands after the import' })
    })
  }
  // Stock is on the shelf and NOTHING has been told: this is what a bare stock write does.
  const afterLandingBeforeTrigger = (await snapshot()).map((r) => r.orderNumber)

  // The call the stock-adjustment, purchase-receipt and transfer-receipt actions make after they add stock.
  const backorders = await allocateBackordersForProducts(productIds, { source: 'stock_adjustment', referenceLabel: 'rehearsal' })
  const afterBackorderAllocator = (await snapshot()).map((r) => r.orderNumber)

  // The cron route that catches whatever the event-driven call left behind.
  const sweep = await sweepUnallocatedProcessingOrders({ limit: 500 })
  const afterSweep = (await snapshot()).map((r) => r.orderNumber)

  emit({ phase: 'land-stock', landing, statusByOrder, beforeLanding, afterLandingBeforeTrigger, backorders, afterBackorderAllocator, sweep, afterSweep })
}

async function main(): Promise<void> {
  const phase = process.argv[2]
  try {
    if (phase === 'prepare') await prepare()
    else if (phase === 'import-rehearsal') await importPhase('rehearsal')
    else if (phase === 'import-real') await importPhase('real')
    else if (phase === 'try-start') await tryStart()
    else if (phase === 'retry-rows') await retryRows()
    else if (phase === 'land-stock') await landStock()
    else throw new Error(`unknown phase ${phase ?? '(none)'}`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
