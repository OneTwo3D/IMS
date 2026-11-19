import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * PRODUCT_NAME_REFUSED never stays open for good (review of #1077, round 2). The discrepancy used to be resolved only on a successful parity build, so it stayed open when
 * parity was switched OFF, when the product became ineligible, and when the SKU-rename early return ran, and its "the next sync renames it" text became false.
 * Real database; the Mintsoft connector and the producer seam are fakes (nothing leaves the process). Gated on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/mintsoft-name-refused-resolve.test.ts would have been skipped.')
}

const behaviour = { renamed: false, sku: '' }
let loaded: Awaited<ReturnType<typeof load>> | null = null

async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  mock.module('../../lib/connectors/mintsoft/producer-seam.ts', {
    namedExports: { mintsoftProducerSeam: async () => ({ proceed: false, shadowed: true, notice: 'test', reason: 'test', recorded: true, occurrences: 1 }) },
  })
  mock.module('@/lib/connectors/wms/registry', {
    namedExports: {
      getWmsConnector: () => ({
        async fetchProduct() { return { externalId: '168', sku: behaviour.renamed ? 'OLD-SKU' : behaviour.sku, barcode: null, raw: { ProductId: 168, SKU: behaviour.renamed ? 'OLD-SKU' : behaviour.sku } } },
        async fetchProductBySku() { return behaviour.renamed ? null : { externalId: '168', sku: behaviour.sku, barcode: null, raw: { ProductId: 168, SKU: behaviour.sku } } },
        async upsertProduct() { throw new Error('nothing may be sent in this test') },
      }),
    },
  })
  const { db } = await import('../../lib/db')
  const sync = await import('../../lib/connectors/mintsoft/sync/product-sync')
  return { db, sync }
}

async function scenario(t: { after: (fn: () => Promise<void>) => void }, options: { parity: boolean; archived?: boolean; renamed?: boolean }) {
  loaded ??= await load()
  const { db, sync } = loaded
  const tag = randomUUID().slice(0, 8)
  const warehouse = await db.warehouse.create({ data: { code: `NR${tag}`, name: `nr ${tag}`, type: 'STANDARD' }, select: { id: true } })
  const connection = await db.wmsConnection.create({ data: { connector: 'mintsoft', label: `nr-${tag}`, active: true }, select: { id: true } })
  await db.externalWmsBinding.create({ data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: `ext-${tag}`, active: true, stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: new Date() } })
  const product = await db.product.create({
    data: {
      sku: `NR-${tag}`, name: 'Name refused', type: 'SIMPLE', lifecycleStatus: options.archived ? 'ARCHIVED' : 'ACTIVE',
      wmsProductLinks: { create: [{ connector: 'mintsoft', externalProductId: '168' }] },
    },
    select: { id: true, sku: true },
  })
  const flag = await db.setting.findUnique({ where: { key: 'mintsoft_product_parity_enabled' } })
  await db.setting.upsert({ where: { key: 'mintsoft_product_parity_enabled' }, create: { key: 'mintsoft_product_parity_enabled', value: options.parity ? 'true' : 'false' }, update: { value: options.parity ? 'true' : 'false' } })
  const row = await db.wmsStockDiscrepancy.create({ data: { connector: 'mintsoft', warehouseId: warehouse.id, productId: product.id, sku: product.sku, category: 'PRODUCT_NAME_REFUSED', status: 'OPEN', message: 'refused' }, select: { id: true } })
  t.after(async () => {
    await db.wmsStockDiscrepancy.deleteMany({ where: { productId: product.id } })
    await db.wmsSyncLog.deleteMany({ where: { sku: product.sku } }).catch(() => undefined)
    await db.wmsProductLink.deleteMany({ where: { productId: product.id } })
    await db.product.deleteMany({ where: { id: product.id } })
    await db.externalWmsBinding.deleteMany({ where: { connectionId: connection.id } })
    await db.wmsConnection.deleteMany({ where: { id: connection.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    if (flag) await db.setting.update({ where: { key: 'mintsoft_product_parity_enabled' }, data: { value: flag.value } })
    else await db.setting.deleteMany({ where: { key: 'mintsoft_product_parity_enabled' } })
    behaviour.renamed = false
  })
  behaviour.renamed = Boolean(options.renamed)
  behaviour.sku = product.sku
  await sync.runMintsoftProductSyncForProduct(product.id, 'test')
  return (await db.wmsStockDiscrepancy.findUniqueOrThrow({ where: { id: row.id }, select: { status: true } })).status
}

test('[db] y1cqe 2: PRODUCT_NAME_REFUSED is resolved when parity is OFF', { skip }, async (t) => {
  assert.equal(await scenario(t, { parity: false }), 'RESOLVED')
})

test('[db] y1cqe 2: PRODUCT_NAME_REFUSED is resolved when the product becomes ineligible (archived)', { skip }, async (t) => {
  assert.equal(await scenario(t, { parity: true, archived: true }), 'RESOLVED')
})

test('[db] y1cqe 2: PRODUCT_NAME_REFUSED is resolved on the SKU-rename early return', { skip }, async (t) => {
  assert.equal(await scenario(t, { parity: true, renamed: true }), 'RESOLVED')
})
