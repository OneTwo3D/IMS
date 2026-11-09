import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import * as fixtures from './po-landed-fixtures'

/**
 * A PURCHASE ORDER NAMING A TAX RATE IN OTHER CASE TAKES THAT RATE (create and edit).
 *
 * The purchase-order importer finds a rate by name ignoring case, then hands the file's own spelling to createPurchaseOrder, which looked
 * the name up exactly: an order whose tax name differed from the stored one only in case passed the importer and then took no rate at all.
 * Both writers now match the way the importer does. Real createPurchaseOrder / updatePurchaseOrder over a real PostgreSQL. Fixture names
 * are unique by entropy and never deleted (one shared database).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

test.before(async () => {
  if (!RUN) return
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
})

test('a tax name in other case resolves the stored active rate on create and on edit; an unknown name still takes none', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder, updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = `${fixtures.uid()}-taxcase`
  const rateName = `Tag Rate ${tag}`
  const rate = await db.taxRate.create({ data: { name: rateName, rate: '0.1234', usedFor: 'PURCHASE', active: true }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: `${fixtures.uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const sku = `${tag}-sku`
  const product = await db.product.create({ data: { sku, name: `taxcase ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const line = { productId: product.id, sku, productName: `taxcase ${tag}`, qty: 2, unitCostForeign: 10 }
  const base = { supplierId: supplier.id, currency: 'GBP', destinationWarehouseId: warehouse.id, pricesIncludeVat: false, taxRateValue: 0, lines: [line] }
  const lineRates = async (poId: string) => (await db.purchaseOrderLine.findMany({ where: { poId }, select: { taxRateId: true } })).map((l) => l.taxRateId)

  // Create: the stored spelling, the same name in upper case, and padded; each takes the rate.
  for (const [label, name] of [['exact', rateName], ['upper', rateName.toUpperCase()], ['padded', `  ${rateName.toLowerCase()}  `]] as const) {
    const created = await createPurchaseOrder({ ...base, reference: `${tag}-${label}`, taxRateName: name })
    assert.equal(created.success, true, `create (${label}): ${created.error}`)
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: `${tag}-${label}` }, select: { id: true } })
    assert.deepEqual(await lineRates(po.id), [rate.id], `create (${label}): the line takes the named rate`)
  }

  // Control: a name that is not a rate (not just a case difference) takes none, as before.
  const unknown = await createPurchaseOrder({ ...base, reference: `${tag}-unknown`, taxRateName: `${rateName} nope` })
  assert.equal(unknown.success, true, `create (unknown): ${unknown.error}`)
  const unknownPo = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: `${tag}-unknown` }, select: { id: true } })
  assert.deepEqual(await lineRates(unknownPo.id), [null], 'an unknown name takes no rate')

  // Edit: the draft is moved onto the rate by a differently-cased name.
  const edited = await updatePurchaseOrder(unknownPo.id, { taxRateName: rateName.toLowerCase(), lines: [line] })
  assert.equal(edited.success, true, `edit: ${edited.error}`)
  assert.deepEqual(await lineRates(unknownPo.id), [rate.id], 'edit: the line takes the named rate in other case')
})
