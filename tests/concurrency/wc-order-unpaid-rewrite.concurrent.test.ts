import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-zvec.7 (owner ruling 2026-11-20), end to end on a scratch database through the REAL importer and the REAL comparison: an UNPAID order edited in WooCommerce before picking is rewritten to exactly
 * WooCommerce's lines and totals behind its own switch (off = nothing happens); what cannot be mapped exactly is a refused action and writes nothing; picking started raises the operator task; a PAID order
 * is never rewritten and an increase raises a task and changes nothing. Also the o3d-hu8g9 drain fixes (age expiry without a successful read; a row that vanished during a read). Nothing reaches a network.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

let accountingMocked = false
async function mockAccounting() {
  if (accountingMocked) return
  const actual = await import('@/lib/accounting')
  mock.module('@/lib/accounting', {
    namedExports: {
      ...actual,
      getAccountingSettings: async () => ({ connector: 'xero', salesAccount: '200', shippingAccount: '260', discountAccount: '270', reverseChargeSalesTaxType: '' }),
      isAccountingSyncTypeEnabledFor: async () => false,
      queueAccountingSync: async () => ({ queued: true }),
    },
  })
  accountingMocked = true
}

async function loadDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('@/lib/db')
  return db
}

const ADDRESS = { first_name: 'A', last_name: 'B', company: '', address_1: '1 St', address_2: '', city: 'Leeds', state: '', postcode: 'LS1 1AA', country: 'GB', email: 'a@b.c', phone: '' }

type Spec = { id: number; sku: string; qty: number; unit: number; discount?: number }
type Over = { specs: Spec[]; shipping?: number; at: string; taxDelta?: number; paidAt?: string }
const two = (n: number) => n.toFixed(2)

// 20% VAT on every line and on the shipping. WooCommerce's figures: line total = subtotal - discount; tax = 20% of the line total.
function payload(externalId: number, wcRateId: number, o: Over) {
  const shipping = o.shipping ?? 5
  const lines = o.specs.map((s) => {
    const subtotal = s.qty * s.unit
    const total = subtotal - (s.discount ?? 0)
    const tax = Math.round(total * 20) / 100
    return { id: s.id, name: `Item ${s.sku}`, product_id: s.id, variation_id: 0, quantity: s.qty, tax_class: '', subtotal: two(subtotal), subtotal_tax: two(tax), total: two(total), total_tax: two(tax), sku: s.sku, price: s.unit, taxes: [{ id: wcRateId, total: two(tax), subtotal: two(tax) }], meta_data: [] }
  })
  const net = lines.reduce((s, l) => s + Number(l.total), 0)
  const lineTax = lines.reduce((s, l) => s + Number(l.total_tax), 0)
  const shipTax = Math.round(shipping * 20) / 100
  const discount = o.specs.reduce((s, x) => s + (x.discount ?? 0), 0)
  const totalTax = lineTax + shipTax + (o.taxDelta ?? 0)
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    prices_include_tax: false, customer_note: '', customer_id: 0, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: o.paidAt ?? null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00', date_modified: o.at, date_modified_gmt: o.at,
    billing: ADDRESS, shipping: ADDRESS, meta_data: [],
    line_items: lines, fee_lines: [],
    tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: two(lineTax), shipping_tax_total: two(shipTax), meta_data: [] }],
    shipping_lines: [{ id: 31, method_title: 'Flat', method_id: 'flat_rate', total: two(shipping), total_tax: two(shipTax), taxes: [{ id: wcRateId, total: two(shipTax) }], meta_data: [] }],
    coupon_lines: discount > 0 ? [{ id: 41, code: 'save', discount: two(discount), discount_tax: two(discount * 0.2), meta_data: [{ id: 1, key: 'coupon_info', value: JSON.stringify([5, 'save', 'fixed_cart', two(discount)]) }] }] : [], refunds: [],
    total: two(net + shipping + totalTax), total_tax: two(totalTax), discount_total: two(discount), discount_tax: two(discount * 0.2), shipping_total: two(shipping), shipping_tax: two(shipTax),
  }
}

const SW = { divergence: 'wc_order_divergence_detection_enabled', write: 'wc_order_amendment_write_enabled', rewrite: 'wc_order_amendment_unpaid_rewrite_enabled' } as const

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const db = await loadDb()
  await mockAccounting()
  const mod = await import('@/lib/connectors/woocommerce/sync/order-import')
  const div = await import('@/lib/connectors/woocommerce/sync/order-divergence')
  const rewriteMod = await import('@/lib/connectors/woocommerce/sync/order-unpaid-rewrite')
  const tag = randomUUID().slice(0, 8).toUpperCase()
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000)
  const rate = await db.taxRate.create({ data: { name: `GB Standard ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'GB VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `RW-${tag}`, name: 'Rewrite test warehouse', syncToStore: true, availableForSale: true } })
  const products = new Map<string, string>()
  const makeProduct = async (sku: string) => {
    const p = await db.product.create({ data: { sku: `${sku}-${tag}`, name: `Rewrite ${sku}`, type: 'SIMPLE' }, select: { id: true } })
    products.set(sku, p.id)
    return `${sku}-${tag}`
  }
  const flagsBefore = new Map<string, string | null>()
  let orderId: string | undefined
  t.after(async () => {
    mock.restoreAll()
    orderId ??= (await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } }))?.orderId
    if (orderId) {
      await db.refusedAction.deleteMany({ where: { entityId: orderId } })
      await db.shoppingSyncLog.deleteMany({ where: { entityId: orderId } })
      await db.wmsOperatorTask.deleteMany({ where: { orderId } })
      await db.wmsOrderPushLink.deleteMany({ where: { orderId } })
      await db.wcOrderDivergence.deleteMany({ where: { orderId } })
      await db.wcOrderDivergenceRecheck.deleteMany({ where: { orderId } })
      await db.orderAllocation.deleteMany({ where: { orderId } })
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId } } })
      await db.salesOrderRefund.deleteMany({ where: { orderId } })
      await db.accountingSyncLog.deleteMany({ where: { referenceId: orderId } })
      await db.activityLog.deleteMany({ where: { entityId: orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
    }
    await db.shoppingOrderLink.deleteMany({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } })
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rate.id } })
    await db.stockLevel.deleteMany({ where: { productId: { in: [...products.values()] } } }).catch(() => undefined)
    await db.product.deleteMany({ where: { id: { in: [...products.values()] } } }).catch(() => undefined)
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: rate.id } })
    for (const [key, value] of flagsBefore) {
      if (value === null) await db.setting.deleteMany({ where: { key } })
      else await db.setting.update({ where: { key }, data: { value } })
    }
  })
  const setSwitch = async (key: string, on: boolean) => {
    if (!flagsBefore.has(key)) flagsBefore.set(key, (await db.setting.findUnique({ where: { key } }))?.value ?? null)
    await db.setting.upsert({ where: { key }, create: { key, value: on ? 'true' : 'false' }, update: { value: on ? 'true' : 'false' } })
  }
  const deliver = async (o: Over) => {
    const result = await mod.importWcOrder(payload(externalId, wcRateId, o) as never)
    assert.equal(result.success, true, `delivery succeeded: ${JSON.stringify(result)}`)
    orderId ??= (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
    // A processing order imported without a WooCommerce invoice number carries a HELD sales invoice and an "owed" mark (real invoice evidence: the rewrite refuses it). These tests model an order with no invoice
    // behind it (pending payment); `keepInvoice` leaves what the import wrote.
    if (!state.keepInvoice) await clearInvoiceTraces()
    return orderId
  }
  const state = { keepInvoice: false }
  const clearInvoiceTraces = async () => {
    await db.shoppingSyncLog.deleteMany({ where: { entityType: 'SalesOrder', entityId: orderId!, connector: 'woocommerce', recordKind: { not: null } } })
    await db.salesOrder.update({ where: { id: orderId! }, data: { salesInvoiceOwedAt: null } })
  }
  const lines = () => db.salesOrderLine.findMany({ where: { orderId: orderId! }, orderBy: { externalLineItemId: 'asc' } })
  const order = () => db.salesOrder.findUniqueOrThrow({ where: { id: orderId! } })
  const refusals = () => db.refusedAction.findMany({ where: { entityId: orderId!, resolvedAt: null } })
  const rewrittenCount = () => db.activityLog.count({ where: { entityId: orderId!, action: 'wc_order_unpaid_rewritten' } })
  return { db, mod, div, rewriteMod, tag, warehouseId: warehouse.id, state, clearInvoiceTraces, setSwitch, deliver, lines, order, refusals, rewrittenCount, makeProduct, payload: (o: Over) => payload(externalId, wcRateId, o), get orderId() { return orderId! }, externalId }
}

const T1 = '2026-11-20T10:00:01'
const T2 = '2026-11-20T10:00:02'
const T3 = '2026-11-20T10:00:03'
const T4 = '2026-11-20T10:00:04'

test('[rewrite] switch ON: an unpaid order edited in WooCommerce (qty, price, tax and discount, a line added, a line removed) is rewritten to exactly WooCommerce\'s figures; an echo does nothing', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  const b = await f.makeProduct('B')
  const c = await f.makeProduct('C')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.write, false)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }, { id: 2, sku: b, qty: 1, unit: 5 }], at: T1 })
  const before = await f.lines()
  assert.equal(before.length, 2)
  const aLineId = before.find((l) => l.externalLineItemId === 1)!.id

  // WooCommerce: A 4 x 10 with a 2.00 discount (so total 38.00), B removed, C added at 7.50, shipping 6.00.
  const edit = { specs: [{ id: 1, sku: a, qty: 4, unit: 10, discount: 2 }, { id: 3, sku: c, qty: 1, unit: 7.5 }], shipping: 6, at: T2 }
  await f.deliver(edit)
  const after = await f.lines()
  assert.deepEqual(after.map((l) => l.externalLineItemId), [1, 3], 'B removed, C added')
  const lineA = after.find((l) => l.externalLineItemId === 1)!
  assert.equal(lineA.id, aLineId, 'a continued line keeps its row (a later itemised refund still finds it)')
  assert.equal(Number(lineA.qty), 4)
  assert.equal(Number(lineA.totalForeign), 38, "WooCommerce's own line total")
  assert.equal(Number(lineA.discountAmount), 2)
  assert.equal(Number(lineA.taxForeign), 7.6)
  assert.equal(lineA.productId !== null, true)
  const lineC = after.find((l) => l.externalLineItemId === 3)!
  assert.equal(Number(lineC.totalForeign), 7.5)
  assert.equal(Number(lineC.taxForeign), 1.5)
  const wc = f.payload(edit)
  const o = await f.order()
  assert.equal(Number(o.totalForeign), Number(wc.total), "the order total is WooCommerce's, not re-derived")
  assert.equal(Number(o.taxForeign), Number(wc.total_tax))
  assert.equal(Number(o.shippingForeign), 6)
  assert.equal(Number(o.subtotalForeign), 45.5)
  assert.equal(await f.rewrittenCount(), 1)
  assert.equal((await f.db.wcOrderDivergence.findFirstOrThrow({ where: { orderId: f.orderId } })).resolvedAt !== null, true, 'the divergence row is closed by the rewrite')
  assert.equal((await f.refusals()).length, 0)

  // ECHO: the same delivery again (and a later one with the same content) changes no line or figure and writes no second activity.
  const snapshot = JSON.stringify((await f.lines()).map((l) => [l.id, String(l.qty), String(l.totalForeign)]))
  await f.deliver(edit)
  await f.deliver({ ...edit, at: T3 })
  assert.equal(JSON.stringify((await f.lines()).map((l) => [l.id, String(l.qty), String(l.totalForeign)])), snapshot)
  assert.equal(await f.rewrittenCount(), 1, 'rewritten once')
})

test('[rewrite] the rewrite bumps updatedAt (so the warehouse amend sweep picks it up) and an identical payload writes nothing', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  const before = await f.order()
  await new Promise((r) => setTimeout(r, 20))
  const out = await f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, f.payload({ specs: [{ id: 1, sku: a, qty: 3, unit: 10 }], at: T2 }) as never, null)
  assert.equal(out.kind, 'rewritten')
  const after = await f.order()
  assert.ok(after.updatedAt.getTime() > before.updatedAt.getTime(), 'updatedAt moved: the order is an amend candidate (order-push-sweep updatableLinks)')
  // An identical payload is "unchanged": no write at all.
  const again = await f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, f.payload({ specs: [{ id: 1, sku: a, qty: 3, unit: 10 }], at: T3 }) as never, null)
  assert.deepEqual(again, { kind: 'unchanged' })
  assert.equal((await f.order()).updatedAt.getTime(), after.updatedAt.getTime())
})

test('[rewrite] switch OFF (the default): the same edit changes nothing in IMS', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.write, false)
  await f.setSwitch(SW.rewrite, false)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T2 })
  const l = await f.lines()
  assert.equal(Number(l[0]!.qty), 2)
  assert.equal(await f.rewrittenCount(), 0)
  assert.equal((await f.refusals()).length, 0)
  assert.equal(await f.db.wcOrderDivergence.count({ where: { orderId: f.orderId, resolvedAt: null } }), 1, 'the divergence is still reported, as before')
})

test('[rewrite] REFUSED: a tax mismatch writes nothing and raises a refused action; a corrected delivery then rewrites and closes it', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 3, unit: 10 }], at: T2, taxDelta: 0.5 }) // total_tax is 0.50 above the lines' and tax lines'
  assert.equal(Number((await f.lines())[0]!.qty), 2, 'nothing was written')
  const refused = await f.refusals()
  assert.equal(refused.length, 1)
  assert.equal(refused[0]!.action, 'WC_ORDER_REWRITE')
  assert.equal(refused[0]!.gate, 'WC_REWRITE_REFUSED')
  assert.match(refused[0]!.detail ?? '', /tax/i)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 3, unit: 10 }], at: T3 })
  assert.equal(Number((await f.lines())[0]!.qty), 3, 'a later, consistent delivery is applied (the claim was released)')
  assert.equal((await f.refusals()).length, 0, 'the refusal is overtaken')
})

test('[rewrite] REFUSED: an unknown SKU writes nothing; creating the product lets the next delivery through', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  const ghost = `GHOST-${f.tag}`
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }, { id: 2, sku: ghost, qty: 1, unit: 4 }], at: T2 })
  assert.equal((await f.lines()).length, 1)
  const refused = await f.refusals()
  assert.equal(refused.length, 1)
  assert.match(refused[0]!.detail ?? '', new RegExp(ghost))
  await f.makeProduct('GHOST') // product sku GHOST-<tag>
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }, { id: 2, sku: ghost, qty: 1, unit: 4 }], at: T3 })
  assert.equal((await f.lines()).length, 2)
})

test('[rewrite] REFUSED: a currency difference, an order edited in IMS, and an order that already has an invoice (a refused action each, nothing written)', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  const edit = f.payload({ specs: [{ id: 1, sku: a, qty: 3, unit: 10 }], at: T2 }) as unknown as Record<string, unknown>
  const direct = (p: unknown) => f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, p as never, null)
  const currency = await direct({ ...edit, currency: 'EUR' })
  assert.equal(currency.kind === 'refused' && currency.code, 'CURRENCY')

  await f.db.accountingSyncLog.create({ data: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: f.orderId, status: 'PENDING', payload: {} } })
  const invoiced = await direct(edit)
  assert.equal(invoiced.kind === 'refused' && (invoiced.code === 'INVOICED' || invoiced.code === 'BLOCKED'), true, JSON.stringify(invoiced))
  await f.db.accountingSyncLog.deleteMany({ where: { referenceId: f.orderId } })

  await f.db.salesOrder.update({ where: { id: f.orderId }, data: { editedInImsAt: new Date() } })
  const edited = await direct(edit)
  assert.equal(edited.kind === 'refused' && edited.code, 'EDITED_IN_IMS')
  assert.equal(Number((await f.lines())[0]!.qty), 2, 'nothing was written by any of them')
})

test('[rewrite] a PAID order is never rewritten (the rewrite itself skips it)', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  await f.db.salesOrder.update({ where: { id: f.orderId }, data: { paidAt: new Date('2026-11-19T00:00:00Z') } })
  const out = await f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, f.payload({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T2 }) as never, null)
  assert.equal(out.kind, 'skipped')
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T3 })
  assert.equal(Number((await f.lines())[0]!.qty), 2)
  assert.equal(await f.rewrittenCount(), 0)
})

test('[rewrite] AT PICKING the operator task is raised instead and nothing is rewritten', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  await f.db.salesOrder.update({ where: { id: f.orderId }, data: { status: 'PICKING' } })
  await f.db.wmsOrderPushLink.create({ data: { orderId: f.orderId, connector: 'mintsoft', externalOrderId: 'MS-RW1', externalOrderNumber: 'W-RW1', state: 'SYNCED' } })
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T2 })
  assert.equal(Number((await f.lines())[0]!.qty), 2, 'IMS rewrote nothing')
  const tasks = await f.db.wmsOperatorTask.findMany({ where: { orderId: f.orderId } })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.reason, 'WC_EDIT_AFTER_PICKING')
  assert.match(tasks[0]!.queryText, /Quantity of .* changed in WooCommerce: WooCommerce 5/)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T3 })
  assert.equal(await f.db.wmsOperatorTask.count({ where: { orderId: f.orderId } }), 1, 'one task per set of differences')
})

test('[paid increase] an increase on a PAID order raises a task naming the lines and the difference, and changes nothing; the write switch gates it', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.setSwitch(SW.write, false)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  await f.db.salesOrder.update({ where: { id: f.orderId }, data: { paidAt: new Date('2026-11-19T00:00:00Z') } })
  await f.db.wmsOrderPushLink.create({ data: { orderId: f.orderId, connector: 'mintsoft', externalOrderId: 'MS-RW2', externalOrderNumber: 'W-RW2', state: 'SYNCED' } })
  const o0 = await f.order()
  // Write switch OFF: nothing, even with the rewrite switch on (a paid order is not the rewrite's).
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T2 })
  assert.equal(await f.db.wmsOperatorTask.count({ where: { orderId: f.orderId } }), 0)
  await f.setSwitch(SW.write, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T3 })
  const tasks = await f.db.wmsOperatorTask.findMany({ where: { orderId: f.orderId } })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.reason, 'WC_PAID_INCREASE')
  assert.match(tasks[0]!.queryText, /quantity is 5 in WooCommerce against 2 in IMS \(3 more\)/)
  assert.match(tasks[0]!.queryText, /Order total \(including tax\) is .* in WooCommerce against .* in IMS/)
  const l = await f.lines()
  assert.equal(Number(l[0]!.qty), 2, 'the paid order is unchanged')
  assert.equal(Number((await f.order()).totalForeign), Number(o0.totalForeign))
  assert.equal(await f.db.salesOrderRefund.count({ where: { orderId: f.orderId } }), 0)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T4 })
  assert.equal(await f.db.wmsOperatorTask.count({ where: { orderId: f.orderId } }), 1, 'raised once')
})

test('[H1] paid in WooCommerce but not yet in IMS (a paid date on the payload; the receipt waits in a paid-block): lines changed, the order is NOT rewritten and the increase is a task', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.setSwitch(SW.write, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  await f.db.wmsOrderPushLink.create({ data: { orderId: f.orderId, connector: 'mintsoft', externalOrderId: 'MS-RW3', externalOrderNumber: 'W-RW3', state: 'SYNCED' } })
  // WooCommerce shows the order PAID at a higher total (qty 5): IMS records no payment (the total differs, a paid-block obligation is written), paidAt stays null.
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T2, paidAt: '2026-11-20T09:30:00' })
  const o = await f.order()
  assert.equal(o.paidAt, null, 'IMS has not recorded the payment')
  assert.equal(Number((await f.lines())[0]!.qty), 2, 'NOT rewritten up under the paid-block retry')
  assert.equal(await f.rewrittenCount(), 0)
  assert.equal(await f.rewriteMod.hasOpenPaidBlock(f.db, String(f.externalId)), true, 'the paid-block obligation is open')
  const tasks = await f.db.wmsOperatorTask.findMany({ where: { orderId: f.orderId } })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.reason, 'WC_PAID_INCREASE')
  // The rewrite itself, called directly under its lock, also refuses to act: a paid date on the payload, and an open obligation without one.
  const direct = (p: unknown) => f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, p as never, 'MS-RW3')
  assert.equal((await direct(f.payload({ specs: [{ id: 1, sku: a, qty: 6, unit: 10 }], at: T3, paidAt: '2026-11-20T09:30:00' }))).kind, 'skipped')
  assert.equal((await direct(f.payload({ specs: [{ id: 1, sku: a, qty: 6, unit: 10 }], at: T3 }))).kind, 'skipped', 'the open paid-block alone is enough')
  assert.equal(Number((await f.lines())[0]!.qty), 2)
  await f.db.shoppingSyncLog.deleteMany({ where: { connector: 'woocommerce', entityType: 'SalesOrder', externalId: String(f.externalId) } })
})

test('[M1] an order imported as processing carries a held invoice and an owed mark: the rewrite refuses it as INVOICED (the realistic case)', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  f.state.keepInvoice = true
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  const o = await f.order()
  const held = await f.db.shoppingSyncLog.count({ where: { entityType: 'SalesOrder', entityId: f.orderId, recordKind: { not: null } } })
  assert.equal(held > 0 || o.salesInvoiceOwedAt !== null, true, 'the import left invoice evidence')
  const out = await f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, f.payload({ specs: [{ id: 1, sku: a, qty: 3, unit: 10 }], at: T2 }) as never, null)
  assert.equal(out.kind === 'refused' && out.code, 'INVOICED')
  assert.equal(Number((await f.lines())[0]!.qty), 2)
})

test('[M5] each piece of invoice evidence refuses the rewrite as INVOICED, exactly', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  const edit = f.payload({ specs: [{ id: 1, sku: a, qty: 3, unit: 10 }], at: T2 })
  const direct = () => f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, edit as never, null)
  const code = (o: Awaited<ReturnType<typeof direct>>) => (o.kind === 'refused' ? o.code : o.kind)
  // Clear what the import left, so the cases below start from a rewritable order.
  await f.db.salesOrder.update({ where: { id: f.orderId }, data: { salesInvoiceOwedAt: null, invoicedAt: null, invoiceNumber: null, accountingInvoiceId: null } })
  await f.db.accountingSyncLog.deleteMany({ where: { referenceId: f.orderId } })
  const upd = (data: Record<string, unknown>) => () => f.db.salesOrder.update({ where: { id: f.orderId }, data })
  const cases: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
    ['accountingInvoiceId', upd({ accountingInvoiceId: 'INV-X' }), upd({ accountingInvoiceId: null })],
    ['SYNCED log', () => f.db.accountingSyncLog.create({ data: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: f.orderId, status: 'SYNCED', externalTransactionId: 'X-1', payload: {} } }), () => f.db.accountingSyncLog.deleteMany({ where: { referenceId: f.orderId } })],
    ['invoiceNumber', upd({ invoiceNumber: 'INV-1' }), upd({ invoiceNumber: null })],
    ['invoicedAt', upd({ invoicedAt: new Date() }), upd({ invoicedAt: null })],
    ['salesInvoiceOwedAt', upd({ salesInvoiceOwedAt: new Date() }), upd({ salesInvoiceOwedAt: null })],
    ['invoice document', () => f.db.salesOrderInvoiceDocument.create({ data: { orderId: f.orderId, kind: 'INVOICE', connector: 'woocommerce', externalDocumentId: `D-${f.tag}`, documentNumber: 'D1', externalStatus: 'x', sha256: f.tag, byteSize: 1, storedPath: 'x' } }), () => f.db.salesOrderInvoiceDocument.deleteMany({ where: { orderId: f.orderId } })],
  ]
  try {
    for (const [name, set, clear] of cases) {
      await set()
      assert.equal(code(await direct()), 'INVOICED', name)
      await clear()
    }
    assert.equal(Number((await f.lines())[0]!.qty), 2, 'nothing was written by any refusal')
    assert.equal(code(await direct()), 'rewritten', 'with no evidence the same edit rewrites')
  } finally {
    await f.db.salesOrderInvoiceDocument.deleteMany({ where: { orderId: f.orderId } })
  }
})

// ---- o3d-hu8g9: the recheck drain ----

test('[hu8g9 MED] a row that ages out WITHOUT a successful read raises the refused action; one that had successful reads and no failed ones is dropped quietly, as before', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setSwitch(SW.divergence, true)
  const a = await f.makeProduct('A')
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  const old = new Date(Date.now() - (f.div.RECHECK_MAX_AGE_DAYS + 6) * 86_400_000)
  f.div.divergenceSeams.readLiveOrder = async () => null
  t.after(() => { f.div.divergenceSeams.readLiveOrder = undefined })
  const gate = f.div.WC_AMENDMENT_RECHECK_GATE
  // Reads kept failing (3 failures, far below the 48 cap) and the row aged out: a lost comparison, and it must be visible.
  await f.db.wcOrderDivergenceRecheck.create({ data: { orderId: f.orderId, externalOrderId: String(f.externalId), deferredAt: old, failedReads: 3 } })
  const out = await f.div.drainDeferredWcOrderDivergences()
  assert.equal(out.dropped, 1)
  const raised = await f.db.refusedAction.findMany({ where: { entityId: f.orderId, gate } })
  assert.equal(raised.length, 1, 'the age-expired row with failed reads is surfaced, not dropped silently')
  assert.match(raised[0]!.detail ?? '', /could not read it back/)
  assert.doesNotMatch(raised[0]!.detail ?? '', /after 0 live re-reads/)
  await f.db.refusedAction.deleteMany({ where: { entityId: f.orderId } })
  // Successful reads behind it, none failing, deferred only for a refund that never came: owes nothing, dropped as before.
  await f.db.wcOrderDivergenceRecheck.create({ data: { orderId: f.orderId, externalOrderId: String(f.externalId), deferredAt: old, attempts: 4, failedReads: 0 } })
  assert.equal((await f.div.drainDeferredWcOrderDivergences()).dropped, 1)
  assert.equal(await f.db.refusedAction.count({ where: { entityId: f.orderId, gate } }), 0)
  // Queued by the write step (it could not decide) and aged out before any read: still surfaced, with wording that does not claim "0 live re-reads".
  await f.db.wcOrderDivergenceRecheck.create({ data: { orderId: f.orderId, externalOrderId: String(f.externalId), deferredAt: old, fromRetry: true } })
  await f.div.drainDeferredWcOrderDivergences()
  const retry = await f.db.refusedAction.findMany({ where: { entityId: f.orderId, gate } })
  assert.equal(retry.length, 1)
  assert.match(retry[0]!.detail ?? '', /before any live re-read could be made/)
})

test('[hu8g9 LOW 3] a row deleted during its live read does not abort the rest of the drain', { skip }, async (t) => {
  const f1 = await fixture(t)
  const f2 = await fixture(t)
  await f1.setSwitch(SW.divergence, true)
  const a1 = await f1.makeProduct('A')
  const a2 = await f2.makeProduct('A')
  await f1.deliver({ specs: [{ id: 1, sku: a1, qty: 2, unit: 10 }], at: T1 })
  await f2.deliver({ specs: [{ id: 1, sku: a2, qty: 2, unit: 10 }], at: T1 })
  const t0 = Date.now()
  await f1.db.wcOrderDivergenceRecheck.create({ data: { orderId: f1.orderId, externalOrderId: String(f1.externalId), lastAttemptAt: new Date(t0 - 2000) } })
  await f1.db.wcOrderDivergenceRecheck.create({ data: { orderId: f2.orderId, externalOrderId: String(f2.externalId), lastAttemptAt: new Date(t0 - 1000) } })
  const read: string[] = []
  f1.div.divergenceSeams.readLiveOrder = async (externalOrderId) => {
    read.push(externalOrderId)
    // The first row is deleted (and the order re-compared elsewhere) while its read is in flight: the update by id would have thrown P2025 and ended the drain.
    if (externalOrderId === String(f1.externalId)) {
      await f1.db.wcOrderDivergenceRecheck.deleteMany({ where: { orderId: f1.orderId } })
      return f1.payload({ specs: [{ id: 1, sku: a1, qty: 2, unit: 10 }], at: T2 }) as never
    }
    return f2.payload({ specs: [{ id: 1, sku: a2, qty: 2, unit: 10 }], at: T2 }) as never
  }
  t.after(() => { f1.div.divergenceSeams.readLiveOrder = undefined })
  const logged: unknown[][] = []
  const errorMock = mock.method(console, 'error', (...args: unknown[]) => { logged.push(args) })
  try {
    const out = await f1.div.drainDeferredWcOrderDivergences()
    assert.deepEqual(read, [String(f1.externalId), String(f2.externalId)], 'the second row was still read')
    assert.equal(out.examined, 2)
    assert.equal(logged.some((args) => String(args[0]).includes('could not drain deferred comparisons')), false, 'no P2025 aborted the drain')
  } finally { errorMock.mock.restore() }
})

// ---- o3d-ewe4y / o3d-9x6wk follow-ups (DB) ----

test('[ewe4y MED-1/2] paid in WooCommerce only: an increase and a REDUCTION are the same task (what the gateway charged), nothing is rewritten or refunded; the refund of an order paid in IMS is untouched', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.setSwitch(SW.write, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 4, unit: 10 }], at: T1 })
  await f.db.wmsOrderPushLink.create({ data: { orderId: f.orderId, connector: 'mintsoft', externalOrderId: 'MS-RW5', externalOrderNumber: 'W-RW5', state: 'SYNCED' } })
  const imsTotal = Number((await f.order()).totalForeign)
  // INCREASE: WooCommerce shows the order paid at a higher total.
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 6, unit: 10 }], at: T2, paidAt: '2026-11-20T09:30:00' })
  const increase = await f.db.wmsOperatorTask.findMany({ where: { orderId: f.orderId }, orderBy: { createdAt: 'asc' } })
  assert.equal(increase.length, 1)
  assert.equal(increase[0]!.reason, 'WC_PAID_INCREASE')
  const wcTotal = Number(f.payload({ specs: [{ id: 1, sku: a, qty: 6, unit: 10 }], at: T2 }).total)
  assert.match(increase[0]!.queryText, new RegExp(`WooCommerce shows it paid at ${wcTotal.toFixed(2)} GBP; IMS holds ${imsTotal.toFixed(2)} GBP and has not recorded the payment`))
  assert.match(increase[0]!.queryText, /Check what the payment gateway charged/)
  assert.match(increase[0]!.queryText, /If it charged the new total, edit the IMS order to match WooCommerce/)
  assert.match(increase[0]!.queryText, /quantity is 6 in WooCommerce against 4 in IMS \(2 more\)/)
  // REDUCTION: WooCommerce now shows it paid at a LOWER total (qty 2).
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T3, paidAt: '2026-11-20T09:30:00' })
  const all = await f.db.wmsOperatorTask.findMany({ where: { orderId: f.orderId }, orderBy: { createdAt: 'asc' } })
  assert.equal(all.length, 2, 'the reduction is its own task (not silently left on the list)')
  assert.equal(all[1]!.reason, 'WC_PAID_INCREASE')
  assert.match(all[1]!.queryText, /quantity is 2 in WooCommerce against 4 in IMS \(2 fewer\)/)
  assert.match(all[1]!.queryText, /If it charged the old total, refund the difference to the customer or undo the edit/)
  assert.equal(Number((await f.lines())[0]!.qty), 4, 'IMS changed nothing')
  assert.equal(await f.db.salesOrderRefund.count({ where: { orderId: f.orderId } }), 0, 'no refund: IMS holds no payment')
  assert.equal(await f.rewrittenCount(), 0)
  assert.equal((await f.order()).paidAt, null)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: '2026-11-20T10:00:05', paidAt: '2026-11-20T09:30:00' })
  assert.equal(await f.db.wmsOperatorTask.count({ where: { orderId: f.orderId } }), 2, 'raised once per set of lines')
  await f.db.shoppingSyncLog.deleteMany({ where: { connector: 'woocommerce', entityType: 'SalesOrder', externalId: String(f.externalId) } })
})

test('[ewe4y 8 / 9x6wk M3] a continued line whose PRODUCT changed keeps its row and its live pegs are ended, with wording that does not say the line was removed', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  const b = await f.makeProduct('B')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  const [line] = await f.lines()
  const supplier = await f.db.supplier.create({ data: { name: `peg supplier ${f.tag}` }, select: { id: true } })
  const po = await f.db.purchaseOrder.create({
    data: {
      reference: `RW-PO-${f.tag}`, supplierId: supplier.id, status: 'PO_SENT', currency: 'GBP', fxRateToBase: 1, subtotalForeign: 100, subtotalBase: 100, totalForeign: 100, totalBase: 100, destinationWarehouseId: f.warehouseId,
      lines: { create: [{ productId: line!.productId!, qty: 10, unitCostForeign: 10, unitCostBase: 10, totalForeign: 100, totalBase: 100 }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  t.after(async () => {
    await f.db.salesOrderLinePeg.deleteMany({ where: { purchaseOrderLineId: po.lines[0]!.id } })
    await f.db.activityLog.deleteMany({ where: { entityType: 'PURCHASE_ORDER', entityId: po.id } })
    await f.db.purchaseOrderLine.deleteMany({ where: { poId: po.id } })
    await f.db.purchaseOrder.deleteMany({ where: { id: po.id } })
    await f.db.supplier.deleteMany({ where: { id: supplier.id } })
  })
  const peg = await f.db.salesOrderLinePeg.create({ data: { salesOrderLineId: line!.id, purchaseOrderLineId: po.lines[0]!.id, qty: 2 }, select: { id: true } })
  // WooCommerce swaps the product on the same item (same id, same figures).
  await f.deliver({ specs: [{ id: 1, sku: b, qty: 2, unit: 10 }], at: T2 })
  const [after] = await f.lines()
  assert.equal(after!.id, line!.id, 'the line keeps its row')
  assert.equal(after!.productId, (await f.db.product.findFirstOrThrow({ where: { sku: b } })).id)
  const ended = await f.db.salesOrderLinePeg.findUniqueOrThrow({ where: { id: peg.id } })
  assert.notEqual(ended.endedAt, null, 'the live peg of the OLD product is ended')
  assert.equal(ended.endReason, 'SALES_LINE_REMOVED', 'the stored reason is unchanged (no enum change)')
  const entries = await f.db.activityLog.findMany({ where: { entityId: f.orderId, action: 'peg_ended' } })
  assert.equal(entries.length, 1)
  assert.match(entries[0]!.description, /the product on the sales order line was changed in WooCommerce/)
  assert.doesNotMatch(entries[0]!.description, /line was removed/)
})

test('[ewe4y 9] a held sales invoice ALONE (no owed mark, no accounting entry, no number) refuses the rewrite as INVOICED, and no evidence lets it through', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  f.state.keepInvoice = true
  await f.setSwitch(SW.divergence, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  await f.db.salesOrder.update({ where: { id: f.orderId }, data: { salesInvoiceOwedAt: null, invoicedAt: null, invoiceNumber: null, accountingInvoiceId: null } })
  await f.db.accountingSyncLog.deleteMany({ where: { referenceId: f.orderId } })
  await f.db.salesOrderInvoiceDocument.deleteMany({ where: { orderId: f.orderId } })
  const held = await f.db.shoppingSyncLog.count({ where: { entityType: 'SalesOrder', entityId: f.orderId, recordKind: { not: null } } })
  assert.ok(held > 0, 'the import left a held invoice row')
  const edit = f.payload({ specs: [{ id: 1, sku: a, qty: 3, unit: 10 }], at: T2 })
  const out = await f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, edit as never, null)
  assert.equal(out.kind === 'refused' && out.code, 'INVOICED')
  assert.match(out.kind === 'refused' ? out.detail : '', /sales invoice is held/)
  assert.equal(Number((await f.lines())[0]!.qty), 2)
  await f.clearInvoiceTraces()
  assert.equal((await f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, edit as never, null)).kind, 'rewritten', 'with the held row gone the same edit rewrites')
})

test('[ewe4y 9] a clean comparison resolves BOTH the rewrite refusal and the paid-increase refusal, and only those', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  const { recordRefusedAction } = await import('@/lib/domain/refused-actions')
  const base = { entityType: 'SALES_ORDER', entityId: f.orderId, permanence: 'RETRYABLE', severity: 'MEDIUM', detail: 'x' } as const
  await recordRefusedAction(f.db, { ...base, action: 'WC_ORDER_REWRITE', gate: 'WC_REWRITE_REFUSED' })
  await recordRefusedAction(f.db, { ...base, action: 'WC_ORDER_AMENDMENT', gate: 'WC_PAID_INCREASE' })
  await recordRefusedAction(f.db, { ...base, action: 'WC_ORDER_AMENDMENT', gate: f.div.WC_AMENDMENT_RECHECK_GATE })
  assert.equal((await f.refusals()).length, 3)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T2 }) // matches the IMS order: nothing differs
  const open = await f.refusals()
  assert.deepEqual(open.map((r) => r.gate), [f.div.WC_AMENDMENT_RECHECK_GATE], 'the rewrite refusal and the paid-increase refusal are closed; the unrelated recheck refusal is not')
})

test('[9x6wk L11 / MED-3] races under the order row lock: a despatch that commits first, and an IMS edit that commits first, both beat a waiting rewrite (it re-reads under the lock and writes nothing)', { skip }, async (t) => {
  const f = await fixture(t)
  const a = await f.makeProduct('A')
  await f.setSwitch(SW.divergence, true)
  await f.setSwitch(SW.rewrite, true)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const sleep = (ms: number) => new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), ms))
  const race = async (holderWrites: (tx: Parameters<Parameters<typeof f.db.$transaction>[0]>[0]) => Promise<void>) => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let locked!: () => void
    const lockedP = new Promise<void>((resolve) => { locked = resolve })
    const holder = f.db.$transaction(async (tx) => {
      await lockSalesOrder(tx, f.orderId)
      await holderWrites(tx)
      locked()
      await held
    }, { timeout: 30_000 })
    await lockedP
    const rewrite = f.rewriteMod.rewriteUnpaidOrderFromWc(f.orderId, f.payload({ specs: [{ id: 1, sku: a, qty: 3, unit: 10 }], at: T2 }) as never, null)
    assert.equal(await Promise.race([rewrite.then(() => 'done' as const), sleep(400)]), 'waiting', 'the rewrite waits for the order row lock')
    release()
    await holder
    return rewrite
  }
  // 1. A despatch commits while the rewrite waits.
  const afterDespatch = await race(async (tx) => { await tx.shipment.create({ data: { orderId: f.orderId, warehouseId: f.warehouseId, status: 'SHIPPED', shippedAt: new Date() } }) })
  assert.equal(afterDespatch.kind === 'refused' && afterDespatch.code, 'BLOCKED', JSON.stringify(afterDespatch))
  assert.equal(Number((await f.lines())[0]!.qty), 2, 'nothing was written over a despatched order')
  await f.db.shipment.deleteMany({ where: { orderId: f.orderId } })
  // 2. An IMS edit commits while the rewrite waits.
  const afterEdit = await race(async (tx) => { await tx.salesOrder.update({ where: { id: f.orderId }, data: { editedInImsAt: new Date() } }) })
  assert.equal(afterEdit.kind === 'refused' && afterEdit.code, 'EDITED_IN_IMS', JSON.stringify(afterEdit))
  assert.equal(Number((await f.lines())[0]!.qty), 2)
})

test('[hu8g9 LOW 2/6] the failed-read cap waits for the row\'s age, and a second drain started while one is running does nothing', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setSwitch(SW.divergence, true)
  const a = await f.makeProduct('A')
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 2, unit: 10 }], at: T1 })
  f.div.divergenceSeams.readLiveOrder = async () => null
  t.after(() => { f.div.divergenceSeams.readLiveOrder = undefined })
  const gate = f.div.WC_AMENDMENT_RECHECK_GATE
  // 48 failed reads in a day (fast-failing reads, such as a rejected key): not a lost comparison yet.
  await f.db.wcOrderDivergenceRecheck.create({ data: { orderId: f.orderId, externalOrderId: String(f.externalId), failedReads: f.div.RECHECK_MAX_FAILED_READS, deferredAt: new Date(Date.now() - 86_400_000) } })
  const young = await f.div.drainDeferredWcOrderDivergences()
  assert.equal(young.dropped, 0, 'kept: it has not waited the minimum age')
  assert.equal(await f.db.refusedAction.count({ where: { entityId: f.orderId, gate } }), 0)
  // The same row, older than the minimum age: dropped and surfaced.
  await f.db.wcOrderDivergenceRecheck.updateMany({ where: { orderId: f.orderId }, data: { deferredAt: new Date(Date.now() - (f.div.RECHECK_MIN_AGE_AT_FAILED_CAP_HOURS + 2) * 3_600_000) } })
  const old = await f.div.drainDeferredWcOrderDivergences()
  assert.equal(old.dropped, 1)
  assert.equal(await f.db.refusedAction.count({ where: { entityId: f.orderId, gate } }), 1)

  // Single flight: another session holds the drain lock; this drain reports busy and reads nothing.
  const { WC_DIVERGENCE_DRAIN_LOCK_NAMESPACE } = await import('@/lib/db/advisory-locks')
  await f.db.wcOrderDivergenceRecheck.create({ data: { orderId: f.orderId, externalOrderId: String(f.externalId) } })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let locked!: () => void
  const lockedP = new Promise<void>((resolve) => { locked = resolve })
  const holder = f.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_DIVERGENCE_DRAIN_LOCK_NAMESPACE}::int, 0)`
    locked()
    await held
  }, { timeout: 30_000 })
  await lockedP
  let reads = 0
  f.div.divergenceSeams.readLiveOrder = async () => { reads++; return null }
  const busy = await f.div.drainDeferredWcOrderDivergences()
  release()
  await holder
  assert.equal(busy.busy, true)
  assert.equal(busy.examined, 0)
  assert.equal(reads, 0)
  assert.equal((await f.db.wcOrderDivergenceRecheck.findFirstOrThrow({ where: { orderId: f.orderId } })).failedReads, 0, 'the row was left alone')
  const free = await f.div.drainDeferredWcOrderDivergences()
  assert.equal(free.busy, undefined)
  assert.equal(reads, 1, 'with the lock free the same drain reads the row')
})
