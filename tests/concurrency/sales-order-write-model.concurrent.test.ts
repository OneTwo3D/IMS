import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { mock } from 'node:test'
import { WRITE_CASES, type WriteCase } from '../fixtures/sales-order-write-cases'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * THE SALES-ORDER WRITE MODEL, against a real database.
 *
 *  1. BYTE-IDENTICAL CREATE. Each representative input (multi-line, discounts, shipping + fees with tax, foreign currency, VAT-inclusive and exclusive, a manual rate override, a capped order discount) is run through the real
 *     createSalesOrder and the FULL written rows (header + lines, every column except the minted ids, the order number and the timestamps) are compared with tests/fixtures/sales-order-write-model.golden.json. The golden was
 *     captured from createSalesOrder BEFORE the money / tax / FX / discount / shipping / totals block was extracted into buildSalesOrderWriteModel (UPDATE_GOLDEN=1 rewrites it; never do that to make a red run green).
 *  2. EDIT = CREATE. updateSalesOrder on a draft created with different content writes exactly the rows creating the edited order fresh writes.
 *  3. ATOMIC. The lines are replaced in the order's one transaction (a failure leaves the old lines and header untouched) and the totals are recomputed from the new lines.
 *  4. EVERY BLOCKER refuses and writes nothing.
 * Mutations: a changed rounding in the builder (arm 1 red); the edit skipping the builder (arm 2 red); the delete and the create in separate transactions (arm 3 red); a blocker check removed (arm 4 red).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const
const GOLDEN = join(process.cwd(), 'tests/fixtures/sales-order-write-model.golden.json')

let permissionDenied = false
const permissionsAsked: string[] = []
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      permissionsAsked.push(permission)
      if (permissionDenied) throw new Error('Forbidden')
      return { user: { id: 'test-user', role: 'ADMIN' } }
    },
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

type World = {
  tag: string
  products: Record<'STD1' | 'STD2' | 'RED', { id: string; sku: string }>
  rateIds: { std: string; red: string; zero: string }
  orderIds: string[]
  teardown: () => Promise<void>
}

async function seedWorld(): Promise<World> {
  loadEnv()
  const { db } = await import('@/lib/db')
  const tag = uid()
  // Rates are global (no country) so the resolver's global-by-category step answers deterministically: STANDARD 0.2, REDUCED 0.05.
  const std = await db.taxRate.create({ data: { name: `ZQWM Std 20 ${tag}`, rate: '0.2', usedFor: 'SALES', taxCategory: 'STANDARD', active: true }, select: { id: true } })
  const red = await db.taxRate.create({ data: { name: `ZQWM Red 5 ${tag}`, rate: '0.05', usedFor: 'SALES', taxCategory: 'REDUCED', active: true }, select: { id: true } })
  const zero = await db.taxRate.create({ data: { name: `ZQWM Zero ${tag}`, rate: '0', usedFor: 'SALES', taxCategory: 'ZERO', active: true }, select: { id: true } })
  const mk = async (k: string, cat: 'STANDARD' | 'REDUCED') => db.product.create({ data: { sku: `WM-${k}-${tag}`, name: `Write model ${k}`, type: 'SIMPLE', taxCategory: cat }, select: { id: true, sku: true } })
  const products = { STD1: await mk('STD1', 'STANDARD'), STD2: await mk('STD2', 'STANDARD'), RED: await mk('RED', 'REDUCED') }
  const existed = new Set((await db.currency.findMany({ where: { code: { in: ['EUR', 'USD'] } }, select: { code: true } })).map((c) => c.code))
  for (const code of ['EUR', 'USD']) await db.currency.upsert({ where: { code }, update: {}, create: { code, name: code, symbol: code } })
  const fxEur = await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.3, fetchedAt: new Date('2026-01-01T00:00:00Z'), source: 'manual', manualOverride: true }, select: { id: true } })
  const fxUsd = await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'USD', rate: 1.25, fetchedAt: new Date('2026-01-01T00:00:00Z'), source: 'manual', manualOverride: true }, select: { id: true } })
  const world: World = {
    tag, products, rateIds: { std: std.id, red: red.id, zero: zero.id }, orderIds: [],
    teardown: async () => {
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: { in: world.orderIds } } } })
      await db.salesOrderRefund.deleteMany({ where: { orderId: { in: world.orderIds } } })
      await db.salesOrderLine.deleteMany({ where: { orderId: { in: world.orderIds } } })
      await db.salesOrder.deleteMany({ where: { id: { in: world.orderIds } } })
      await db.product.deleteMany({ where: { id: { in: Object.values(products).map((p) => p.id) } } })
      await db.taxRate.deleteMany({ where: { id: { in: [std.id, red.id, zero.id] } } })
      await db.fxRate.deleteMany({ where: { id: { in: [fxEur.id, fxUsd.id] } } })
      await db.currency.deleteMany({ where: { code: { in: ['EUR', 'USD'].filter((c) => !existed.has(c)) } } })
    },
  }
  return world
}

function inputFor(w: World, c: WriteCase, extra: Record<string, unknown> = {}) {
  return {
    customerName: 'Write Model Customer',
    customerEmail: 'wm@example.test',
    billingAddress: { line1: '1 Test St', country: 'GB' },
    shippingAddress: { line1: '2 Test St', country: 'GB' },
    currency: c.currency,
    taxRateName: c.orderRate ? `${c.orderRate.name} ${w.tag}` : undefined,
    taxRateValue: c.orderRate?.value,
    pricesIncludeVat: c.pricesIncludeVat,
    shippingForeign: c.shippingForeign,
    shippingService: c.shippingService,
    fees: c.fees,
    orderDiscountForeign: c.orderDiscountForeign,
    orderDiscountStr: c.orderDiscountStr,
    notes: 'n', internalNotes: 'i', salesRep: 'rep',
    isDraft: true,
    lines: c.lines.map((l) => ({
      productId: w.products[l.product].id, sku: w.products[l.product].sku, description: `Desc ${l.product}`,
      qty: l.qty, unitPriceForeign: l.unitPriceForeign, discountAmount: l.discountAmount, discountStr: l.discountStr,
      taxRateId: l.override ? w.rateIds[l.override === 'red' ? 'red' : 'zero'] : undefined,
    })),
    ...extra,
  }
}

/** The version the form would have loaded. */
async function versionOf(orderId: string): Promise<string> {
  const { db } = await import('@/lib/db')
  return (await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { updatedAt: true } })).updatedAt.toISOString()
}

const isDecimal = (v: unknown) => v !== null && typeof v === 'object' && 'toFixed' in (v as object)

/** Every column of the order and its lines except what the database or the clock mints; ids that name seeded rows are replaced by their symbolic key and the world's tag is stripped. */
async function writtenRows(w: World, orderId: string) {
  const { db } = await import('@/lib/db')
  const so = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } })
  const strip = (v: unknown) => (typeof v === 'string' ? v.split(w.tag).join('T').replace(/-T$/, '').replace(/ T$/, '') : v)
  const sym = (id: string | null) => {
    if (!id) return null
    for (const [k, p] of Object.entries(w.products)) if (p.id === id) return k
    for (const [k, v] of Object.entries(w.rateIds)) if (v === id) return k
    return id
  }
  const header: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(so)) {
    if (['id', 'orderNumber', 'createdAt', 'updatedAt', 'lines', 'externalOrderNumber'].includes(k)) continue
    header[k] = v instanceof Date ? 'DATE' : isDecimal(v) ? String(v) : strip(v)
  }
  const lines = so.lines.map((l) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(l)) {
      if (['id', 'orderId', 'createdAt', 'updatedAt'].includes(k)) continue
      out[k] = k === 'productId' || k === 'taxRateId' ? sym(v as string | null) : isDecimal(v) ? String(v) : strip(v)
    }
    return out
  }).sort((a, b) => String(a.sku).localeCompare(String(b.sku)) || String(a.description).localeCompare(String(b.description)))
  return { header, lines }
}

test('createSalesOrder writes rows byte-identical to the golden captured before the builder extraction', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder } = await import('@/app/actions/sales')
  const actual: Record<string, unknown> = {}
  for (const c of WRITE_CASES) {
    const r = await createSalesOrder(inputFor(w, c) as never)
    assert.equal(r.success, true, `${c.key}: ${r.error}`)
    w.orderIds.push(r.order!.id)
    actual[c.key] = await writtenRows(w, r.order!.id)
  }
  const json = JSON.stringify(actual, null, 2) + '\n'
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, json)
    return
  }
  assert.deepEqual(JSON.parse(json), JSON.parse(readFileSync(GOLDEN, 'utf8')))
})

test('an edited draft writes exactly the rows creating the edited order fresh writes; identity is kept, lines are replaced, totals recomputed', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder, updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const first = WRITE_CASES[0]
  for (const target of WRITE_CASES.slice(1)) {
    const created = await createSalesOrder(inputFor(w, first, { externalOrderNumber: `WM-${w.tag}-${target.key}` }) as never)
    assert.equal(created.success, true, created.error)
    w.orderIds.push(created.order!.id)
    const before = await db.salesOrder.findUniqueOrThrow({ where: { id: created.order!.id }, include: { lines: { select: { id: true } } } })

    // Changes lines, quantities, prices, discounts, shipping, fees, currency and the tax basis in one edit.
    const edited = await updateSalesOrder(created.order!.id, inputFor(w, target) as never, await versionOf(created.order!.id))
    assert.equal(edited.success, true, `${target.key}: ${edited.error}`)

    const fresh = await createSalesOrder(inputFor(w, target) as never)
    assert.equal(fresh.success, true, fresh.error)
    w.orderIds.push(fresh.order!.id)
    assert.deepEqual(await writtenRows(w, created.order!.id), await writtenRows(w, fresh.order!.id), `${target.key}: edit = create`)

    const after = await db.salesOrder.findUniqueOrThrow({ where: { id: created.order!.id }, include: { lines: { select: { id: true } } } })
    assert.equal(after.id, before.id)
    assert.equal(after.orderNumber, before.orderNumber, 'the order number is kept')
    assert.equal(after.externalOrderNumber, before.externalOrderNumber)
    assert.equal(after.status, 'DRAFT')
    assert.equal(after.lines.length, target.lines.length)
    assert.equal(after.lines.some((l) => before.lines.some((b) => b.id === l.id)), false, 'the old lines were replaced, not kept')
    assert.notEqual(String(after.totalForeign), String(before.totalForeign), 'totals were recomputed')
    assert.equal(await db.salesOrderLine.count({ where: { orderId: after.id } }), target.lines.length, 'no old line survives')
    assert.equal(await db.activityLog.count({ where: { entityType: 'SALES_ORDER', entityId: after.id, action: 'updated' } }), 1, 'one activity entry')
  }
  assert.ok(permissionsAsked.includes('sales.create'))
})

test('the rewrite is one transaction: a line that cannot be written leaves the old lines and header untouched', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder, updateSalesOrder } = await import('@/app/actions/sales')
  const created = await createSalesOrder(inputFor(w, WRITE_CASES[0]) as never)
  assert.equal(created.success, true, created.error)
  w.orderIds.push(created.order!.id)
  const before = await writtenRows(w, created.order!.id)
  const bad = inputFor(w, WRITE_CASES[1]) as { lines: { productId: string }[] }
  bad.lines[1] = { ...bad.lines[1], productId: 'no-such-product' }
  const r = await updateSalesOrder(created.order!.id, bad as never, await versionOf(created.order!.id))
  assert.equal(r.success, false)
  assert.deepEqual(await writtenRows(w, created.order!.id), before, 'old header and lines are intact (the delete rolled back with the failed create)')
})

test('refused edits write nothing: permission, the DRAFT-only rule and each blocker', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder, updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const warehouse = await db.warehouse.create({ data: { code: `WM${w.tag.slice(0, 8)}`, name: 'WM test' }, select: { id: true } })
  t.after(async () => { await db.warehouse.deleteMany({ where: { id: warehouse.id } }) })
  const target = WRITE_CASES[2]
  const fresh = async () => {
    const r = await createSalesOrder(inputFor(w, WRITE_CASES[0]) as never)
    assert.equal(r.success, true, r.error)
    w.orderIds.push(r.order!.id)
    return r.order!.id
  }
  const refused = async (id: string, expected: RegExp, label: string) => {
    const before = await writtenRows(w, id)
    const lineIds = (await db.salesOrderLine.findMany({ where: { orderId: id }, select: { id: true }, orderBy: { id: 'asc' } })).map((l) => l.id)
    const r = await updateSalesOrder(id, inputFor(w, target) as never, await versionOf(id))
    assert.equal(r.success, false, `${label}: refused`)
    assert.match(String(r.error), expected, label)
    assert.deepEqual(await writtenRows(w, id), before, `${label}: nothing was written`)
    assert.deepEqual((await db.salesOrderLine.findMany({ where: { orderId: id }, select: { id: true }, orderBy: { id: 'asc' } })).map((l) => l.id), lineIds, `${label}: the same line rows`)
  }

  // permission
  const idPerm = await fresh()
  permissionDenied = true
  try { await refused(idPerm, /Forbidden/, 'permission') } finally { permissionDenied = false }

  // not found
  assert.match(String((await updateSalesOrder('no-such-order', inputFor(w, target) as never, new Date().toISOString())).error), /Order not found/)

  // a refund (its line link would be orphaned by the line replacement), a return expectation
  const idRefund = await fresh()
  const rline = await db.salesOrderLine.findFirstOrThrow({ where: { orderId: idRefund }, select: { id: true } })
  const refund = await db.salesOrderRefund.create({ data: { orderId: idRefund, totalForeign: 1, totalBase: 1, refundedAt: new Date() } as never, select: { id: true } })
  await db.salesOrderRefundLine.create({ data: { refundId: refund.id, salesOrderLineId: rline.id, description: 'x', qty: 1, unitPriceForeign: 1, unitPriceBase: 1, totalForeign: 1, totalBase: 1 } as never })
  await refused(idRefund, /refunds recorded/, 'refund')
  assert.equal((await db.salesOrderRefundLine.findFirstOrThrow({ where: { refundId: refund.id } })).salesOrderLineId, rline.id, 'the refund line still points at its sale line')

  // every non-draft status
  for (const status of ['PENDING_PAYMENT', 'PROCESSING', 'ALLOCATED', 'SHIPPED', 'CANCELLED'] as const) {
    const id = await fresh()
    await db.salesOrder.update({ where: { id }, data: { status } })
    await refused(id, /Only draft orders can be edited/, `status ${status}`)
  }

  // blockers on an otherwise clean draft
  const idAlloc = await fresh()
  const line = await db.salesOrderLine.findFirstOrThrow({ where: { orderId: idAlloc }, select: { id: true, productId: true } })
  await db.orderAllocation.create({ data: { orderId: idAlloc, lineId: line.id, productId: line.productId!, warehouseId: warehouse.id, qty: 1 } })
  await refused(idAlloc, /Stock is allocated/, 'allocation')

  const idShip = await fresh()
  await db.shipment.create({ data: { orderId: idShip, warehouseId: warehouse.id } })
  await refused(idShip, /shipment exists/, 'shipment')

  const idInv = await fresh()
  await db.salesOrder.update({ where: { id: idInv }, data: { accountingInvoiceId: `INV-${w.tag}` } })
  await refused(idInv, /accounting invoice has already been posted/, 'accountingInvoiceId')

  const idWms = await fresh()
  await db.wmsOrderPushLink.create({ data: { orderId: idWms, connector: 'test' } })
  await refused(idWms, /sent to the warehouse/, 'wms push')

  const idWoo = await fresh()
  await db.shoppingOrderLink.create({ data: { orderId: idWoo, connector: 'woocommerce', externalOrderId: `wm-${w.tag}` } })
  await refused(idWoo, /WooCommerce/, 'woo link')

  const idErased = await fresh()
  await db.salesOrder.update({ where: { id: idErased }, data: { erasedAt: new Date() } })
  await refused(idErased, /erased/, 'erased')
})

test('an edit that links an anonymised customer is refused and writes nothing; a live customer is linked', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder, updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const live = await db.customer.create({ data: { firstName: 'Live', lastName: w.tag }, select: { id: true } })
  const erased = await db.customer.create({ data: { firstName: 'Gone', lastName: w.tag, gdprAnonymisedAt: new Date() }, select: { id: true } })
  t.after(async () => {
    await db.salesOrderLine.deleteMany({ where: { orderId: { in: w.orderIds } } })
    await db.salesOrder.deleteMany({ where: { id: { in: w.orderIds } } })
    await db.customer.deleteMany({ where: { id: { in: [live.id, erased.id] } } })
  })
  const created = await createSalesOrder(inputFor(w, WRITE_CASES[0]) as never)
  assert.equal(created.success, true, created.error)
  w.orderIds.push(created.order!.id)
  const before = await writtenRows(w, created.order!.id)
  const refused = await updateSalesOrder(created.order!.id, inputFor(w, WRITE_CASES[0], { customerId: erased.id }) as never, await versionOf(created.order!.id))
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /anonymised/)
  assert.deepEqual(await writtenRows(w, created.order!.id), before)
  const ok = await updateSalesOrder(created.order!.id, inputFor(w, WRITE_CASES[0], { customerId: live.id }) as never, await versionOf(created.order!.id))
  assert.equal(ok.success, true, ok.error)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: created.order!.id }, select: { customerId: true } })).customerId, live.id)
})

test('a stale edit is refused under the lock and writes nothing; a reload then saves', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { createSalesOrder, updateSalesOrder, updateSalesOrderNotes } = await import('@/app/actions/sales')
  const created = await createSalesOrder(inputFor(w, WRITE_CASES[0]) as never)
  assert.equal(created.success, true, created.error)
  w.orderIds.push(created.order!.id)
  const opened = await versionOf(created.order!.id)
  // Another editor saves after this one opened the form.
  await new Promise((r) => setTimeout(r, 15))
  const other = await updateSalesOrder(created.order!.id, inputFor(w, WRITE_CASES[1]) as never, opened)
  assert.equal(other.success, true, other.error)
  const afterOther = await writtenRows(w, created.order!.id)
  const stale = await updateSalesOrder(created.order!.id, inputFor(w, WRITE_CASES[2]) as never, opened)
  assert.equal(stale.success, false)
  assert.match(String(stale.error), /changed by someone else/)
  assert.deepEqual(await writtenRows(w, created.order!.id), afterOther, 'the first editor\'s rows were not overwritten')
  // A notes save also moves the version.
  const v2 = await versionOf(created.order!.id)
  await new Promise((r) => setTimeout(r, 15))
  assert.equal((await updateSalesOrderNotes(created.order!.id, 'n2', 'i2')).success, true)
  assert.match(String((await updateSalesOrder(created.order!.id, inputFor(w, WRITE_CASES[2]) as never, v2)).error), /changed by someone else/)
  const ok = await updateSalesOrder(created.order!.id, inputFor(w, WRITE_CASES[2]) as never, await versionOf(created.order!.id))
  assert.equal(ok.success, true, ok.error)
  assert.equal((await updateSalesOrder(created.order!.id, inputFor(w, WRITE_CASES[2]) as never, 'garbage')).success, false)
})
