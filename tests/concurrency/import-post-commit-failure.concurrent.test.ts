import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * A COMMITTED ORDER IS NEVER REPORTED AS SKIPPED. createPurchaseOrder / createSalesOrder commit the document and then do more work (supplier last price, allocation, activity). When that later work
 * fails the importer used to count the group skipped and leave its id out of the result, while a retry skipped the saved order as a duplicate: a saved order nobody was told about.
 *
 *   PO arm:    the supplier_products write fails AFTER the commit (a real trigger on the scratch DB) -> created, id listed, warning names the price; a retry skips it as a duplicate that is already listed.
 *   Sales arm: allocation throws after the order is saved -> created, warning names the allocation; a retry skips it as a duplicate.
 * Mutations: PO - make the price upsert unguarded again (the create returns failure); sales - remove the importer's allocation catch.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

let failAllocation = false

test('an order that committed is reported created with its warning, and a retry skips it as a listed duplicate', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const realAlloc = await import('@/app/actions/allocation')
  mock.module('@/app/actions/allocation', {
    namedExports: {
      ...realAlloc,
      autoAllocateOrder: async (...args: Parameters<typeof realAlloc.autoAllocateOrder>) => {
        if (failAllocation) throw new Error('allocation exploded')
        return realAlloc.autoAllocateOrder(...args)
      },
    },
  })
  const { importSalesOrdersCsv, importPurchaseOrdersCsv } = await import('@/app/actions/import')

  const eurExisted = (await db.currency.findUnique({ where: { code: 'EUR' }, select: { code: true } })) !== null
  await db.currency.upsert({ where: { code: 'EUR' }, update: {}, create: { code: 'EUR', name: 'EUR', symbol: 'EUR' } })
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.3, fetchedAt: new Date(Date.now() - 2000), source: 'manual', manualOverride: true } })
  const product = await db.product.create({ data: { sku: 'PCF-' + uid(), name: 'post commit', type: 'SIMPLE' }, select: { id: true, sku: true } })
  const supplier = await db.supplier.create({ data: { name: 'PCF Supplier ' + uid(), currency: 'EUR' }, select: { id: true, name: true } })
  const tag = uid()
  t.after(async () => {
    await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS pcf_block_price ON supplier_products')
    await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS pcf_block_price()')
    const sos = (await db.salesOrder.findMany({ where: { externalOrderNumber: { startsWith: `PCF${tag}` } }, select: { id: true } })).map((r) => r.id)
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: sos } } })
    await db.salesOrder.deleteMany({ where: { id: { in: sos } } })
    const pos = (await db.purchaseOrder.findMany({ where: { reference: { startsWith: `PCF${tag}` } }, select: { id: true } })).map((r) => r.id)
    await db.purchaseOrderLine.deleteMany({ where: { poId: { in: pos } } })
    await db.purchaseOrder.deleteMany({ where: { id: { in: pos } } })
    await db.supplierProduct.deleteMany({ where: { supplierId: supplier.id } })
    await db.supplier.deleteMany({ where: { id: supplier.id } }).catch(() => undefined)
    await db.product.deleteMany({ where: { id: product.id } }).catch(() => undefined)
    await db.fxRate.deleteMany({ where: { toCurrency: 'EUR' } })
    if (!eurExisted) await db.currency.deleteMany({ where: { code: 'EUR' } })
  })
  const form = (csv: string) => { const f = new FormData(); f.set('file', new File([csv], 'x.csv')); return f }
  const errs = (r: unknown) => ((r as { errors?: string[] }).errors ?? []).join('\n')

  // ---- purchase order: the supplier price write fails after the commit
  await db.$executeRawUnsafe(`CREATE FUNCTION pcf_block_price() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'supplier price blocked'; END $$`)
  await db.$executeRawUnsafe('CREATE TRIGGER pcf_block_price BEFORE INSERT OR UPDATE ON supplier_products FOR EACH ROW EXECUTE FUNCTION pcf_block_price()')
  const poKey = `PCF${tag}P`
  const poCsv = `orderKey,supplierName,currency,fxRateToBase,sku,qty,unitCostForeign\r\n${poKey},${supplier.name},EUR,,${product.sku},1,2\r\n`
  const r1 = (await importPurchaseOrdersCsv(form(poCsv))) as { created?: number; skipped?: number }
  const po = await db.purchaseOrder.findFirst({ where: { reference: poKey }, select: { id: true } })
  assert.ok(po, 'the PO committed')
  assert.equal(r1.created, 1, 'PO counted as created')
  assert.equal(r1.skipped, 0, 'PO not counted skipped')
  assert.match(errs(r1), new RegExp(`Purchase order "${poKey}" \\(id ${po!.id}\\) WAS CREATED, but: supplier last price NOT updated`), 'the warning names the saved id and what did not happen')
  const r2 = await importPurchaseOrdersCsv(form(poCsv))
  assert.match(errs(r2), /already exists/, 'retry skips it as a duplicate')
  assert.equal(await db.purchaseOrder.count({ where: { reference: poKey } }), 1)
  await db.$executeRawUnsafe('DROP TRIGGER pcf_block_price ON supplier_products')

  // ---- sales order: allocation fails after the save
  failAllocation = true
  const soKey = `PCF${tag}S`
  const soCsv = `orderKey,customerName,currency,fxRateToBase,sku,qty,unitPriceForeign\r\n${soKey},PCF,EUR,,${product.sku},1,10\r\n`
  const s1 = (await importSalesOrdersCsv(form(soCsv))) as { created?: number; skipped?: number }
  const so = await db.salesOrder.findFirst({ where: { externalOrderNumber: soKey }, select: { id: true } })
  assert.ok(so, 'the order committed')
  assert.equal(s1.created, 1)
  assert.equal(s1.skipped, 0)
  assert.match(errs(s1), new RegExp(`Sales order "${soKey}" \\(id ${so!.id}\\) WAS CREATED, but: stock was NOT allocated`))
  const s2 = await importSalesOrdersCsv(form(soCsv))
  assert.match(errs(s2), /already exists/, 'retry skips it as a duplicate')
  assert.equal(await db.salesOrder.count({ where: { externalOrderNumber: soKey } }), 1)
  failAllocation = false
})
