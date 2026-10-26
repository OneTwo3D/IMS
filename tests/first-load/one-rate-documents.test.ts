/**
 * Owner ruling (2026-10-25): one rate means the table rate. A manual sales order and a freight PO take no typed rate; the CSV sales and purchase importers treat a stated rate as a claim to be
 * checked (FX_RATE_INVALID / FX_RATE_NOT_TABLE_RATE) and a missing rate refuses (FX_RATE_MISSING), never 1:1. Real scratch database, real actions (permission, cache and outbound hooks stubbed).
 * Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import test, { after, before, mock } from 'node:test'
import { startScratch, type Scratch } from './apply-scratch'

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

let s: Scratch
let productId: string
let supplierId: string
let warehouseId: string
let seq = 0
before(async () => {
  s = await startScratch('ims-one-rate-docs')
  await s.sql('truncate fx_rates')
  await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.30', fetchedAt: new Date(Date.now() - 3_600_000) } })
  productId = (await s.db.product.create({ data: { sku: 'ORD-1', name: 'ORD 1', type: 'SIMPLE' }, select: { id: true } })).id
  supplierId = (await s.db.supplier.create({ data: { name: 'ORD Supplier', currency: 'EUR' }, select: { id: true } })).id
  warehouseId = (await s.db.warehouse.findFirstOrThrow({ select: { id: true } })).id
})
after(async () => { await s?.stop() })

const soInput = (currency: string, extra: Record<string, unknown> = {}) => ({
  customerName: 'Rate Customer', currency, lines: [{ productId, sku: 'ORD-1', description: 'x', qty: 1, unitPriceForeign: 10 }], isDraft: true, ...extra,
})

// [mutation: read input.fxRateToBase again, or fall back to 1 when no rate is found]
test('manual sales order: a typed rate is ignored (the table rate is stored); a missing rate refuses and writes no order; the base currency is 1', async () => {
  const { createSalesOrder } = await import('@/app/actions/sales')
  const before = await s.db.salesOrder.count()
  for (const typed of [9, 1.31, 1.3, 0, -2]) {
    const r = await createSalesOrder(soInput('EUR', { fxRateToBase: typed }) as never)
    assert.equal(r.success, true, r.error)
    assert.equal(Number((await s.db.salesOrder.findUniqueOrThrow({ where: { id: r.order!.id } })).fxRateToBase), 1.3, `typed ${typed}`)
  }
  const base = await createSalesOrder(soInput('GBP', { fxRateToBase: 7 }) as never)
  assert.equal(base.success, true, base.error)
  assert.equal(Number((await s.db.salesOrder.findUniqueOrThrow({ where: { id: base.order!.id } })).fxRateToBase), 1)
  const countOk = await s.db.salesOrder.count()
  const missing = await createSalesOrder(soInput('USD', { fxRateToBase: 1.2 }) as never)
  assert.equal(missing.success, false)
  assert.match(String(missing.error), /Missing GBP FX rate for USD/, 'refused with the central lookup\'s message, not read as 1:1')
  assert.equal(await s.db.salesOrder.count(), countOk, 'no order was written')
  assert.ok(countOk > before)
})

const freightInput = async (currency: string, extra: Record<string, unknown> = {}) => {
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const goods = await createPurchaseOrder({ reference: `ORD-G-${++seq}`, supplierId, currency: 'GBP', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0, lines: [{ productId, sku: 'ORD-1', productName: 'x', qty: 1, unitCostForeign: 5 }] } as never)
  assert.equal(goods.success, true, goods.error)
  return { supplierId, currency, primaryPoIds: [goods.po!.id], costLines: [{ description: 'freight', amountForeign: 10, vatable: false, distributionMethod: 'BY_VALUE' }], ...extra }
}

// [mutation: read input.fxRateToBase again in createFreightPo]
test('freight PO: a typed rate is ignored (table rate stored); a missing rate refuses; the base currency is 1', async () => {
  const { createFreightPo } = await import('@/app/actions/purchase-orders')
  for (const typed of [9, 1.31]) {
    const r = await createFreightPo((await freightInput('EUR', { fxRateToBase: typed })) as never)
    assert.equal(r.success, true, r.error)
    assert.equal(Number((await s.db.purchaseOrder.findUniqueOrThrow({ where: { id: r.po!.id } })).fxRateToBase), 1.3, `typed ${typed}`)
  }
  const base = await createFreightPo((await freightInput('GBP', { fxRateToBase: 5 })) as never)
  assert.equal(Number((await s.db.purchaseOrder.findUniqueOrThrow({ where: { id: base.po!.id } })).fxRateToBase), 1)
  const before = await s.db.purchaseOrder.count({ where: { type: 'FREIGHT' } })
  const missing = await createFreightPo((await freightInput('USD', { fxRateToBase: 1.2 })) as never)
  assert.equal(missing.success, false)
  assert.match(String(missing.error), /Missing GBP FX rate for USD/)
  assert.equal(await s.db.purchaseOrder.count({ where: { type: 'FREIGHT' } }), before)
})

const form = (csv: string) => { const f = new FormData(); f.set('file', new File([csv], 'x.csv')); return f }
const soCsv = (currency: string, rate: string) => `orderKey,customerName,currency,fxRateToBase,sku,qty,unitPriceForeign\r\nCSVSO-${++seq},Rate Customer,${currency},${rate},ORD-1,1,10\r\n`
const poCsv = (currency: string, rate: string) => `orderKey,supplierName,currency,fxRateToBase,sku,qty,unitCostForeign\r\nCSVPO-${++seq},ORD Supplier,${currency},${rate},ORD-1,1,2\r\n`
const errorsOf = (r: unknown) => JSON.stringify((r as { errors?: unknown }).errors ?? r)

// [mutation: read non-positive as 1; accept the stated rate; default a missing rate to 1; skip the base-currency check]
test('CSV sales order import: blank and an exactly-equal rate create the order at the table rate; every other case is refused with a named code and no order is written', async () => {
  const { importSalesOrdersCsv } = await import('@/app/actions/import')
  const cases: Array<[string, string, string, RegExp | null]> = [
    ['blank', 'EUR', '', null],
    ['equal', 'EUR', '1.3', null],
    ['differs by under 1%', 'EUR', '1.31', /FX_RATE_NOT_TABLE_RATE/],
    ['zero', 'EUR', '0', /FX_RATE_INVALID/],
    ['negative', 'EUR', '-1', /FX_RATE_INVALID/],
    ['not a number', 'EUR', 'abc', /FX_RATE_INVALID/],
    ['no rate for the currency, none stated', 'USD', '', /FX_RATE_MISSING/],
    ['no rate for the currency, one stated', 'USD', '1.2', /FX_RATE_MISSING/],
    ['base currency with a rate other than 1', 'GBP', '5', /FX_RATE_NOT_TABLE_RATE/],
    ['base currency blank', 'GBP', '', null],
  ]
  let examined = 0
  for (const [label, currency, rate, refusal] of cases) {
    const before = await s.db.salesOrder.count()
    const r = await importSalesOrdersCsv(form(soCsv(currency, rate)))
    examined++
    if (refusal) {
      assert.match(errorsOf(r), refusal, label)
      assert.equal(await s.db.salesOrder.count(), before, `${label}: no order`)
    } else {
      assert.equal(await s.db.salesOrder.count(), before + 1, label)
      const created = await s.db.salesOrder.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
      assert.equal(Number(created.fxRateToBase), currency === 'GBP' ? 1 : 1.3, label)
    }
  }
  assert.equal(examined, 10)
  const preview = new FormData(); preview.set('file', new File([soCsv('EUR', '1.31')], 'x.csv')); preview.set('mode', 'preview')
  assert.match(errorsOf(await importSalesOrdersCsv(preview)), /FX_RATE_NOT_TABLE_RATE/, 'the dry run refuses it too')
})

test('CSV purchase order import carries the same codes', async () => {
  const { importPurchaseOrdersCsv } = await import('@/app/actions/import')
  assert.match(errorsOf(await importPurchaseOrdersCsv(form(poCsv('EUR', '1.31')))), /FX_RATE_NOT_TABLE_RATE/)
  assert.match(errorsOf(await importPurchaseOrdersCsv(form(poCsv('EUR', '0')))), /FX_RATE_INVALID/)
  assert.match(errorsOf(await importPurchaseOrdersCsv(form(poCsv('USD', '')))), /FX_RATE_MISSING/)
  const ok = await importPurchaseOrdersCsv(form(poCsv('EUR', '')))
  assert.equal((ok as { created?: number }).created, 1)
})
