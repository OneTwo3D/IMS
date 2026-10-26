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

// The importers' existing rule for OTHER row errors is unchanged (a valid group imports, a bad one is reported and skipped: result = created/skipped/errors). An FX error is different: it
// refuses the WHOLE file before any write, so a retry never meets half of it already saved. [mutation: the per-group order restored (check and create group by group)]
test('CSV import: a valid order followed by wrong-rate orders writes NOTHING, reports every FX error at once; an all-valid file writes all; the dry run refuses the same way', async () => {
  const { importSalesOrdersCsv, importPurchaseOrdersCsv } = await import('@/app/actions/import')
  const soRows = (rows: Array<[string, string, string]>) => `orderKey,customerName,currency,fxRateToBase,sku,qty,unitPriceForeign\r\n${rows.map(([k, c, r]) => `${k},Rate Customer,${c},${r},ORD-1,1,10`).join('\r\n')}\r\n`
  const poRows = (rows: Array<[string, string, string]>) => `orderKey,supplierName,currency,fxRateToBase,sku,qty,unitCostForeign\r\n${rows.map(([k, c, r]) => `${k},ORD Supplier,${c},${r},ORD-1,1,2`).join('\r\n')}\r\n`
  const t = ++seq
  const bad = soRows([[`ATO-OK-${t}`, 'EUR', ''], [`ATO-BAD1-${t}`, 'EUR', '1.31'], [`ATO-BAD2-${t}`, 'USD', '']])
  const before = await s.db.salesOrder.count()
  const r = await importSalesOrdersCsv(form(bad))
  assert.equal(await s.db.salesOrder.count(), before, 'nothing written: the valid first order is not saved')
  const text = errorsOf(r)
  assert.match(text, /FX_RATE_NOT_TABLE_RATE/)
  assert.match(text, /FX_RATE_MISSING/, 'both FX errors are reported together')
  const dry = new FormData(); dry.set('file', new File([bad], 'x.csv')); dry.set('mode', 'preview')
  assert.match(errorsOf(await importSalesOrdersCsv(dry)), /FX_RATE_MISSING/)
  const good = await importSalesOrdersCsv(form(soRows([[`ATO-G1-${t}`, 'EUR', ''], [`ATO-G2-${t}`, 'EUR', '1.3']])))
  assert.equal(await s.db.salesOrder.count(), before + 2, 'an all-valid file writes all')
  assert.equal(JSON.stringify((good as { errors?: unknown[] }).errors ?? []), '[]')
  // the retry of the bad file after fixing it does not hit a saved duplicate
  const fixed = await importSalesOrdersCsv(form(soRows([[`ATO-OK-${t}`, 'EUR', ''], [`ATO-BAD1-${t}`, 'EUR', ''], [`ATO-BAD2-${t}`, 'EUR', '']])))
  assert.equal(await s.db.salesOrder.count(), before + 5)
  assert.equal(JSON.stringify((fixed as { errors?: unknown[] }).errors ?? []), '[]')
  // purchase orders: the same
  const poBefore = await s.db.purchaseOrder.count()
  const poBad = poRows([[`ATP-OK-${t}`, 'EUR', ''], [`ATP-BAD-${t}`, 'EUR', '1.31']])
  assert.match(errorsOf(await importPurchaseOrdersCsv(form(poBad))), /FX_RATE_NOT_TABLE_RATE/)
  assert.equal(await s.db.purchaseOrder.count(), poBefore)
  await importPurchaseOrdersCsv(form(poRows([[`ATP-OK-${t}`, 'EUR', ''], [`ATP-G-${t}`, 'EUR', '1.3']])))
  assert.equal(await s.db.purchaseOrder.count(), poBefore + 2)
})

// [mutation: drop the expectedFxRate comparison in createSalesOrder / createPurchaseOrder]
test('the rate checked is the rate written: a table rate that moved after the check refuses the write', async () => {
  const { createSalesOrder } = await import('@/app/actions/sales')
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const so0 = await s.db.salesOrder.count()
  const so = await createSalesOrder({ ...soInput('EUR'), expectedFxRate: 1.2 } as never)
  assert.equal(so.success, false)
  assert.match(String(so.error), /FX_RATE_CHANGED/)
  assert.equal(await s.db.salesOrder.count(), so0)
  const po0 = await s.db.purchaseOrder.count()
  const po = await createPurchaseOrder({ reference: `ATO-PO-${++seq}`, supplierId, currency: 'EUR', expectedFxRate: 1.2, destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0, lines: [{ productId, sku: 'ORD-1', productName: 'x', qty: 1, unitCostForeign: 5 }] } as never)
  assert.equal(po.success, false)
  assert.match(String(po.error), /FX_RATE_CHANGED/)
  assert.equal(await s.db.purchaseOrder.count(), po0)
  const ok = await createSalesOrder({ ...soInput('EUR'), expectedFxRate: 1.3 } as never)
  assert.equal(ok.success, true, ok.error)
})
