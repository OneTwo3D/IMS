/**
 * Owner ruling (2026-10-25): "one rate means the table rate". A purchase order's rate is ALWAYS the central fx_rates rate; a user-supplied rate is ignored (create,
 * edit: there is no such input) or refused (the CSV importer: a stated rate that is not the table rate). Run over a real scratch database with the REAL actions (permission, cache and
 * outbound hooks stubbed, as tests/concurrency does). Every arm names the mutation that turns it red.
 */
import assert from 'node:assert/strict'
import test, { after, before, mock } from 'node:test'
import { mintSystemImportContext } from '../../lib/first-load/apply/system-import-capability.ts'
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
let supplierId: string
let productId: string
let warehouseId: string
let seq = 0
const system = () => mintSystemImportContext({ runId: 'po-table-rate', operator: 'Test' })

before(async () => {
  s = await startScratch('ims-po-table-rate')
  await s.sql('truncate fx_rates')
  const base = new Date(Date.now() - 3_600_000)
  for (const [at, rate] of [[new Date('2026-09-10T06:00:00Z'), '1.20'], [new Date('2026-09-12T06:00:00Z'), '1.40'], [base, '1.30']] as const) {
    await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate, fetchedAt: at } })
  }
  supplierId = (await s.db.supplier.create({ data: { name: 'PTR Supplier', currency: 'EUR' }, select: { id: true } })).id
  productId = (await s.db.product.create({ data: { sku: 'PTR-1', name: 'PTR 1', type: 'SIMPLE' }, select: { id: true } })).id
  warehouseId = (await s.db.warehouse.findFirstOrThrow({ select: { id: true } })).id
})
after(async () => { await s?.stop() })

const input = (extra: Record<string, unknown> = {}) => ({
  reference: `PTR-${++seq}`, supplierId, currency: 'EUR', destinationWarehouseId: warehouseId, pricesIncludeVat: false, taxRateValue: 0,
  lines: [{ productId, sku: 'PTR-1', productName: 'PTR 1', qty: 2, unitCostForeign: 5 }], ...extra,
})
const stored = async (id: string) => Number((await s.db.purchaseOrder.findUniqueOrThrow({ where: { id }, select: { fxRateToBase: true } })).fxRateToBase)
const create = async (extra: Record<string, unknown>, ctx?: ReturnType<typeof system>) => {
  const { createPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const r = await createPurchaseOrder(input(extra) as never, ctx)
  assert.equal(r.success, true, r.error)
  return r.po!.id
}

// [mutation: honour a rate field on create (input.fxRateToBase wins), or any tolerance band]
test('create: a user-supplied rate (any value, near or far) is ignored; the order is stored at the table rate now', async () => {
  for (const stray of [9, 1.31, 1.3]) assert.equal(await stored(await create({ fxRateToBase: stray })), 1.3, `stray ${stray}`)
  assert.equal(await stored(await create({ fxRateToBase: 9 }, system())), 1.3, 'also for a system import with no instant')
})

// [mutation: honour fxRateAsOf for every caller, or ignore it for a system import]
test('create: only a system import (the first load) may price an order at an earlier instant; a web caller\'s instant is ignored', async () => {
  const asOf = new Date('2026-09-15T23:59:59.999Z')
  assert.equal(await stored(await create({ fxRateAsOf: asOf }, system())), 1.4, 'the end of 2026-09-15: the 09-12 row')
  assert.equal(await stored(await create({ fxRateAsOf: asOf })), 1.3, 'a web caller gets now')
})

// [mutation: skip manualOverride rows, or read the first row instead of the latest]
test('a manual override row pinned in fx_rates is the latest row, so it IS the rate of the next order; clearing it (a newer feed row) restores the feed', async () => {
  const pin = await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.55', fetchedAt: new Date(Date.now() - 1000), source: 'manual', manualOverride: true } })
  assert.equal(await stored(await create({ fxRateToBase: 1.3 })), 1.55)
  await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.32', fetchedAt: new Date(Date.now() - 500), source: 'frankfurter', manualOverride: false } })
  assert.equal(await stored(await create({})), 1.32)
  await s.db.fxRate.deleteMany({ where: { OR: [{ id: pin.id }, { rate: '1.32' }] } })
  assert.equal(await stored(await create({})), 1.3)
})

// [mutation: re-resolve on every edit that sends a currency (so a draft\'s stored rate moves), or honour a rate field on edit]
test('edit: a draft keeps its stored rate unless the currency changes or refreshFxRate is true; a stray rate field is ignored', async () => {
  const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const id = await create({})
  assert.equal(await stored(id), 1.3)
  const later = await s.db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.60', fetchedAt: new Date(Date.now() - 100) } })
  try {
    const edit = await updatePurchaseOrder(id, { currency: 'EUR', notes: 'x', fxRateToBase: 9 } as never)
    assert.equal(edit.success, true, edit.error)
    assert.equal(await stored(id), 1.3, 'same currency, stray rate: the stored rate stays')
    const refresh = await updatePurchaseOrder(id, { currency: 'EUR', fxRateToBase: 9, refreshFxRate: true } as never)
    assert.equal(refresh.success, true, refresh.error)
    assert.equal(await stored(id), 1.6, 'refreshFxRate re-reads the table, never the typed number')
    const toBase = await updatePurchaseOrder(id, { currency: 'GBP', fxRateToBase: 9 } as never)
    assert.equal(toBase.success, true, toBase.error)
    assert.equal(await stored(id), 1, 'a currency change re-resolves (base = 1)')
  } finally { await s.db.fxRate.delete({ where: { id: later.id } }) }
})

const csv = (rate: string, createdOn = '') => new File([`orderKey,supplierName,currency,fxRateToBase,destinationWarehouseCode,sku,qty,unitCostForeign,createdOn\r\nCSV-${++seq},PTR Supplier,EUR,${rate},,PTR-1,1,2,${createdOn}\r\n`], 'po.csv')
const form = (file: File, mode?: string) => { const f = new FormData(); f.set('file', file); if (mode) f.set('mode', mode); return f }

// [mutation: store the CSV\'s rate, compare within a tolerance, or compare with the wrong instant]
test('the CSV importer refuses a stated rate that is not exactly the table rate and stores the table rate for a blank or equal one; a system import prices at the end of createdOn', async () => {
  const { importPurchaseOrdersCsv } = await import('@/app/actions/import')
  const rateOf = async (key: string) => (await s.db.purchaseOrder.findUnique({ where: { reference: key }, select: { fxRateToBase: true } }))?.fxRateToBase
  const key = () => `CSV-${seq}`
  const typed = await importPurchaseOrdersCsv(form(csv('1.31')))
  assert.match(JSON.stringify(typed.errors ?? typed), /always the table rate/, 'a typed rate within 1% of the table is still refused')
  assert.equal(await rateOf(key()), undefined, 'no order was created')
  const blank = await importPurchaseOrdersCsv(form(csv('')))
  assert.equal((blank as { created?: number }).created, 1)
  assert.equal(Number(await rateOf(key())), 1.3)
  const equal = await importPurchaseOrdersCsv(form(csv('1.3')))
  assert.equal((equal as { created?: number }).created, 1)
  assert.equal(Number(await rateOf(key())), 1.3)
  const dated = await importPurchaseOrdersCsv(form(csv('1.4', '2026-09-15')), system())
  assert.equal((dated as { created?: number }).created, 1, JSON.stringify(dated))
  assert.equal(Number(await rateOf(key())), 1.4, 'the first load\'s rate is the table rate at the end of the created day')
  const wrongDay = await importPurchaseOrdersCsv(form(csv('1.3', '2026-09-15')), system())
  assert.match(JSON.stringify(wrongDay.errors ?? wrongDay), /always the table rate/, 'today\'s rate is not the rate at the created day')
  const webDated = await importPurchaseOrdersCsv(form(csv('1.4', '2026-09-15')))
  assert.match(JSON.stringify(webDated.errors ?? webDated), /always the table rate/, 'a web import ignores createdOn and is held to now\'s rate')
  const preview = await importPurchaseOrdersCsv(form(csv('1.31'), 'preview'))
  assert.match(JSON.stringify(preview), /always the table rate/, 'the dry run refuses it too')
})
