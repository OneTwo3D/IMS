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
type Over = { specs: Spec[]; shipping?: number; at: string; taxDelta?: number }
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
    date_paid_gmt: null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00', date_modified: o.at, date_modified_gmt: o.at,
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
    return orderId
  }
  const lines = () => db.salesOrderLine.findMany({ where: { orderId: orderId! }, orderBy: { externalLineItemId: 'asc' } })
  const order = () => db.salesOrder.findUniqueOrThrow({ where: { id: orderId! } })
  const refusals = () => db.refusedAction.findMany({ where: { entityId: orderId!, resolvedAt: null } })
  const rewrittenCount = () => db.activityLog.count({ where: { entityId: orderId!, action: 'wc_order_unpaid_rewritten' } })
  return { db, mod, div, rewriteMod, tag, setSwitch, deliver, lines, order, refusals, rewrittenCount, makeProduct, payload: (o: Over) => payload(externalId, wcRateId, o), get orderId() { return orderId! }, externalId }
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
  assert.match(tasks[0]!.queryText, /quantity is 5 in WooCommerce against 2 in IMS \(3 more\)/)
  assert.match(tasks[0]!.queryText, /Order total \(including tax\) is .* in WooCommerce against .* in IMS/)
  const l = await f.lines()
  assert.equal(Number(l[0]!.qty), 2, 'the paid order is unchanged')
  assert.equal(Number((await f.order()).totalForeign), Number(o0.totalForeign))
  assert.equal(await f.db.salesOrderRefund.count({ where: { orderId: f.orderId } }), 0)
  await f.deliver({ specs: [{ id: 1, sku: a, qty: 5, unit: 10 }], at: T4 })
  assert.equal(await f.db.wmsOperatorTask.count({ where: { orderId: f.orderId } }), 1, 'raised once')
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
