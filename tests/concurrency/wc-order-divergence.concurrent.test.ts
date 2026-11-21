import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * WooCommerce-vs-IMS order divergence, end to end on a scratch database through the REAL importer: the report is read-only (the order, its lines and its
 * `updatedAt` are untouched by it), off by default, one record per order, auto-resolving, refund-aware, and a failure in it can never fail the import or
 * stop the six-field update. Nothing here reaches a network.
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

type Over = { qty?: number; unit?: number; shipping?: number; note?: string; extraLine?: boolean; noLines?: boolean; refunds?: Array<{ id: number; reason: string; total: string }> }
// One line of `qty` x `unit` ex-tax at 20% VAT, shipping 5.00 at 20% (tax 1.00); total = net + tax + shipping + shipping tax.
function payload(externalId: number, wcRateId: number, o: Over = {}) {
  const qty = o.qty ?? 1
  const unit = o.unit ?? 100
  const shipping = o.shipping ?? 5
  const net = qty * unit
  const tax = net * 0.2
  const shipTax = shipping * 0.2
  const lines: unknown[] = o.noLines ? [] : [{ id: 1, name: 'Widget', product_id: 1, variation_id: 0, quantity: qty, tax_class: '', subtotal: net.toFixed(2), subtotal_tax: tax.toFixed(2), total: net.toFixed(2), total_tax: tax.toFixed(2), sku: `NOSKU-${externalId}`, price: unit, taxes: [{ id: wcRateId, total: tax.toFixed(2), subtotal: tax.toFixed(2) }], meta_data: [] }]
  let extraNet = 0
  let extraTax = 0
  if (o.extraLine) {
    extraNet = 10
    extraTax = 2
    lines.push({ id: 2, name: 'Extra', product_id: 2, variation_id: 0, quantity: 1, tax_class: '', subtotal: '10.00', subtotal_tax: '2.00', total: '10.00', total_tax: '2.00', sku: `EXTRA-${externalId}`, price: 10, taxes: [{ id: wcRateId, total: '2.00', subtotal: '2.00' }], meta_data: [] })
  }
  const totalTax = (o.noLines ? 0 : tax) + extraTax + shipTax
  return {
    id: externalId, number: String(externalId), order_key: `wc_order_${externalId}`, status: 'processing', currency: 'GBP',
    prices_include_tax: false, customer_note: o.note ?? '', customer_id: 0, payment_method: 'bacs', payment_method_title: 'Bank', transaction_id: '',
    date_paid_gmt: null, date_created: '2026-11-02T09:00:00', date_created_gmt: '2026-11-02T09:00:00',
    date_modified: '2026-11-02T09:00:00', date_modified_gmt: '2026-11-02T09:00:00',
    billing: ADDRESS, shipping: ADDRESS, meta_data: [],
    line_items: lines, fee_lines: [],
    tax_lines: [{ id: 21, rate_code: 'GB-VAT-1', rate_id: wcRateId, label: 'VAT', compound: false, tax_total: (totalTax - shipTax).toFixed(2), shipping_tax_total: shipTax.toFixed(2), meta_data: [] }],
    shipping_lines: [{ id: 31, method_title: 'Flat', method_id: 'flat_rate', total: shipping.toFixed(2), total_tax: shipTax.toFixed(2), taxes: [{ id: wcRateId, total: shipTax.toFixed(2) }], meta_data: [] }],
    coupon_lines: [], refunds: o.refunds ?? [],
    total: ((o.noLines ? 0 : net) + extraNet + totalTax + shipping).toFixed(2), total_tax: totalTax.toFixed(2), discount_total: '0.00', discount_tax: '0.00', shipping_total: shipping.toFixed(2), shipping_tax: shipTax.toFixed(2),
  }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const db = await loadDb()
  await mockAccounting()
  const mod = await import('@/lib/connectors/woocommerce/sync/order-import')
  const div = await import('@/lib/connectors/woocommerce/sync/order-divergence')
  const wcRateId = 900_000 + Math.floor(Math.random() * 90_000)
  const externalId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000)
  const rate = await db.taxRate.create({ data: { name: `GB Standard ${randomUUID()}`, rate: 0.2, usedFor: 'SALES', accountingTaxType: 'OUTPUT2', countryCode: 'GB', taxCategory: 'STANDARD' } })
  await db.shoppingTaxRateMapping.create({ data: { connector: 'woocommerce', externalTaxRateId: String(wcRateId), externalName: 'GB VAT', externalCountry: 'GB', externalRatePct: 20, taxRateId: rate.id } })
  const warehouse = await db.warehouse.create({ data: { code: `WCD-${randomUUID().slice(0, 8)}`, name: 'Divergence test warehouse', syncToStore: true, availableForSale: true } })
  const flagBefore = await db.setting.findUnique({ where: { key: div.WC_ORDER_DIVERGENCE_SETTING } })
  let orderId: string | undefined
  t.after(async () => {
    mock.restoreAll()
    orderId ??= (await db.shoppingOrderLink.findFirst({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } }))?.orderId
    if (orderId) {
      await db.wcOrderDivergence.deleteMany({ where: { orderId } })
      await db.wcOrderDivergenceRecheck.deleteMany({ where: { orderId } })
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId } } })
      await db.salesOrderRefund.deleteMany({ where: { orderId } })
      await db.accountingSyncLog.deleteMany({ where: { referenceId: orderId } })
      await db.activityLog.deleteMany({ where: { entityId: orderId } })
      await db.salesOrderLine.deleteMany({ where: { orderId } })
      await db.salesOrder.deleteMany({ where: { id: orderId } })
    }
    await db.shoppingOrderLink.deleteMany({ where: { connector: 'woocommerce', externalOrderId: String(externalId) } })
    await db.shoppingTaxRateMapping.deleteMany({ where: { taxRateId: rate.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
    await db.taxRate.deleteMany({ where: { id: rate.id } })
    if (flagBefore) await db.setting.update({ where: { key: div.WC_ORDER_DIVERGENCE_SETTING }, data: { value: flagBefore.value } })
    else await db.setting.deleteMany({ where: { key: div.WC_ORDER_DIVERGENCE_SETTING } })
  })
  const setFlag = (on: boolean) => db.setting.upsert({ where: { key: div.WC_ORDER_DIVERGENCE_SETTING }, create: { key: div.WC_ORDER_DIVERGENCE_SETTING, value: on ? 'true' : 'false' }, update: { value: on ? 'true' : 'false' } })
  const deliver = async (o: Over) => {
    const result = await mod.importWcOrder(payload(externalId, wcRateId, o) as never)
    assert.equal(result.success, true, `delivery succeeded: ${JSON.stringify(result)}`)
    orderId ??= (await db.shoppingOrderLink.findFirstOrThrow({ where: { connector: 'woocommerce', externalOrderId: String(externalId) }, select: { orderId: true } })).orderId
    return orderId
  }
  const records = () => db.wcOrderDivergence.findMany({ where: { orderId: orderId! } })
  return { db, mod, div, setFlag, deliver, records, payload: (o: Over) => payload(externalId, wcRateId, o), get orderId() { return orderId! }, externalId }
}

test('[divergence] flag OFF (the default): an edited order is imported as before and nothing is recorded', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(false)
  await f.deliver({})
  await f.deliver({ qty: 3, shipping: 9, note: 'changed' })
  assert.equal((await f.records()).length, 0)
  assert.equal(await f.db.activityLog.count({ where: { entityId: f.orderId, action: f.div.WC_ORDER_DIVERGED_ACTION } }), 0)
  // the six-field update behaves as ever
  assert.equal((await f.db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, select: { notes: true } })).notes, 'changed')
})

test('[divergence] flag ON: no divergence, then a change records ONE row, a repeat refreshes it, and a match auto-resolves it', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  await f.deliver({})
  assert.equal((await f.records()).length, 0, 'an unchanged order records nothing')

  await f.deliver({ qty: 3 })
  const first = await f.records()
  assert.equal(first.length, 1)
  assert.equal(first[0].resolvedAt, null)
  const fields = (first[0].differences as Array<{ field: string }>).map((d) => d.field)
  assert.ok(fields.includes('LINE_QUANTITY') && fields.includes('TOTAL'), `quantity and total reported: ${fields}`)
  assert.equal(await f.db.activityLog.count({ where: { entityId: f.orderId, action: f.div.WC_ORDER_DIVERGED_ACTION } }), 1)

  await f.deliver({ qty: 3 })
  const again = await f.records()
  assert.equal(again.length, 1, 'a redelivery does not duplicate the row')
  assert.equal(again[0].id, first[0].id)
  assert.equal(again[0].seenCount, 2)
  assert.equal(await f.db.activityLog.count({ where: { entityId: f.orderId, action: f.div.WC_ORDER_DIVERGED_ACTION } }), 1, 'nor repeat the notice')

  await f.deliver({ qty: 3, shipping: 9 })
  const changed = await f.records()
  assert.equal(changed.length, 1, 'a different difference replaces the same row')
  assert.ok((changed[0].differences as Array<{ field: string }>).some((d) => d.field === 'SHIPPING'))

  await f.deliver({})
  const closed = await f.records()
  assert.equal(closed.length, 1)
  assert.notEqual(closed[0].resolvedAt, null, 'edited back: the record resolves itself')
  assert.match(String(closed[0].resolution), /matched the IMS order again/)

  await f.deliver({ unit: 120 })
  const reopened = await f.records()
  assert.equal(reopened.length, 1, 'a later difference reopens the same row')
  assert.equal(reopened[0].resolvedAt, null)
  assert.ok((reopened[0].differences as Array<{ field: string }>).some((d) => d.field === 'LINE_PRICE'))
})

test('[divergence] an added line is reported; the detector writes nothing to the order, its lines or updatedAt', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  const before = await f.db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, include: { lines: { orderBy: { id: 'asc' } } } })
  await f.div.surfaceWcOrderDivergence(f.orderId, f.payload({ extraLine: true, shipping: 7 }) as never)
  const rows = await f.records()
  assert.equal(rows.length, 1)
  const fields = (rows[0].differences as Array<{ field: string }>).map((d) => d.field)
  assert.ok(fields.includes('LINE_ADDED') && fields.includes('SHIPPING'), `added line and shipping reported: ${fields}`)
  const after = await f.db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, include: { lines: { orderBy: { id: 'asc' } } } })
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), 'SalesOrder.updatedAt is untouched, so the order is not a warehouse amend candidate')
  // `wcSeenLines` is the detection's own bookkeeping (what WooCommerce showed; written raw so updatedAt stays put), not order state: everything else is byte-identical.
  const { wcSeenLines: seenAfter, ...afterRest } = after
  const { wcSeenLines: _seenBefore, ...beforeRest } = before
  void _seenBefore
  assert.ok(seenAfter !== null, 'the seen WooCommerce lines are kept')
  assert.deepEqual(JSON.parse(JSON.stringify(afterRest)), JSON.parse(JSON.stringify(beforeRest)), 'the order and its lines are byte-identical')
})

test('[divergence] a removed line that IMS has also refunded is not a divergence; the same removal without the refund is', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({ extraLine: true })
  const lines = await f.db.salesOrderLine.findMany({ where: { orderId: f.orderId }, select: { id: true, externalLineItemId: true, totalForeign: true } })
  const extra = lines.find((l) => l.externalLineItemId === 2)!
  // WooCommerce now shows the order without the extra line.
  await f.deliver({})
  const open = await f.records()
  assert.equal(open.length, 1, 'no refund recorded: the removal is a real divergence')
  assert.ok((open[0].differences as Array<{ field: string }>).some((d) => d.field === 'LINE_REMOVED'))

  // IMS records the refund of that line (as the refund sync would); the next delivery explains the removal.
  const refund = await f.db.salesOrderRefund.create({ data: { orderId: f.orderId, totalForeign: '12.00', totalBase: '12.00', externalRefundId: 777001 } })
  await f.db.salesOrderRefundLine.create({ data: { refundId: refund.id, salesOrderLineId: extra.id, description: 'Extra', qty: '1', unitPriceForeign: '10', unitPriceBase: '10', totalForeign: '10', totalBase: '10' } })
  await f.deliver({ refunds: [{ id: 777001, reason: '', total: '-12.00' }] })
  const resolved = await f.records()
  assert.notEqual(resolved[0].resolvedAt, null, 'the refund explains the removal: the record resolves')
})

test('[divergence] a refund the payload names that IMS has not recorded defers detection and leaves the record alone', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  await f.deliver({ qty: 3 })
  assert.equal((await f.records()).length, 1)
  const before = (await f.records())[0]
  await f.deliver({ qty: 3, shipping: 9, refunds: [{ id: 888001, reason: '', total: '-5.00' }] })
  const after = (await f.records())[0]
  assert.equal(after.fingerprint, before.fingerprint, 'the deferred delivery changed nothing')
  assert.equal(after.seenCount, before.seenCount)
})

test('[divergence] a comparison deferred for an unrecorded refund is repeated after the refund sweep, so an edit in the same update is not lost', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  // The update names a refund IMS has not recorded AND carries a price/shipping edit: deferred, nothing recorded yet.
  const edited = { qty: 3, shipping: 9, refunds: [{ id: 888002, reason: '', total: '-5.00' }] }
  await f.deliver(edited)
  assert.equal((await f.records()).length, 0, 'deferred: nothing recorded by the import itself')
  // A rerun for an order that was never deferred does nothing (a refund-free order is not compared twice).
  // The refund sweep then records the refund (as syncRefundsForOrder would), and the repeat runs with the SAME payload.
  await f.db.salesOrderRefund.create({ data: { orderId: f.orderId, totalForeign: '5.00', totalBase: '5.00', externalRefundId: 888002 } })
  await f.div.rerunDeferredWcOrderDivergence(f.payload(edited) as never)
  const rows = await f.records()
  assert.equal(rows.length, 1, 'the deferred comparison ran after the refund was recorded')
  assert.equal(rows[0].resolvedAt, null)
  assert.ok((rows[0].differences as Array<{ field: string }>).some((d) => d.field === 'SHIPPING'), 'the edit that rode along with the refund is reported')
  // consumed: a second call is a no-op and does not double-count
  await f.div.rerunDeferredWcOrderDivergence(f.payload(edited) as never)
  assert.equal((await f.records())[0].seenCount, 1)
})

test('[divergence] POLL mode: a deferral is a durable row, and the next order sweep (no refund sweep) resolves it by a live read and clears it', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  const edited = { qty: 3, shipping: 9, refunds: [{ id: 888003, reason: '', total: '-5.00' }] }
  await f.deliver(edited)
  assert.equal((await f.records()).length, 0)
  assert.equal(await f.db.wcOrderDivergenceRecheck.count({ where: { orderId: f.orderId } }), 1, 'the deferral is persisted, not held in memory')
  // Refund not recorded yet: the live read still defers; an attempt is counted, the row stays.
  f.div.divergenceSeams.readLiveOrder = async () => f.payload(edited) as never
  t.after(() => { f.div.divergenceSeams.readLiveOrder = undefined })
  const first = await f.div.drainDeferredWcOrderDivergences()
  assert.deepEqual(first, { examined: 1, resolved: 0, dropped: 0 })
  assert.equal((await f.db.wcOrderDivergenceRecheck.findFirstOrThrow({ where: { orderId: f.orderId } })).attempts, 1)
  // The refund is recorded (by a webhook or reconcile); the next sweep's drain compares and clears the marker.
  await f.db.salesOrderRefund.create({ data: { orderId: f.orderId, totalForeign: '5.00', totalBase: '5.00', externalRefundId: 888003 } })
  const second = await f.div.drainDeferredWcOrderDivergences()
  assert.equal(second.resolved, 1)
  assert.equal(await f.db.wcOrderDivergenceRecheck.count({ where: { orderId: f.orderId } }), 0, 'marker cleared')
  const rows = await f.records()
  assert.equal(rows.length, 1)
  assert.ok((rows[0].differences as Array<{ field: string }>).some((d) => d.field === 'SHIPPING'))
})

test('[divergence] the deferral table is bounded: an unreadable or never-recorded refund is dropped at the attempt cap and by age, and detection OFF keeps nothing', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  await f.deliver({ qty: 3, refunds: [{ id: 888004, reason: '', total: '-5.00' }] })
  f.div.divergenceSeams.readLiveOrder = async () => null
  t.after(() => { f.div.divergenceSeams.readLiveOrder = undefined })
  await f.db.wcOrderDivergenceRecheck.update({ where: { orderId: f.orderId }, data: { attempts: f.div.RECHECK_MAX_ATTEMPTS } })
  assert.equal((await f.div.drainDeferredWcOrderDivergences()).dropped, 1, 'dropped at the attempt cap')
  await f.db.wcOrderDivergenceRecheck.create({ data: { orderId: f.orderId, externalOrderId: String(f.externalId), deferredAt: new Date(Date.now() - 20 * 86_400_000) } })
  assert.equal((await f.div.drainDeferredWcOrderDivergences()).dropped, 1, 'dropped by age')
  await f.db.wcOrderDivergenceRecheck.create({ data: { orderId: f.orderId, externalOrderId: String(f.externalId) } })
  await f.setFlag(false)
  assert.equal((await f.div.drainDeferredWcOrderDivergences()).dropped, 1, 'detection off: nothing is kept')
  assert.equal(await f.db.wcOrderDivergenceRecheck.count({ where: { orderId: f.orderId } }), 0)
})

test('[divergence] o3d-7d84p: a FAILED live read is not an attempt; it counts against its own cap and backs the row off', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  await f.deliver({ qty: 3, refunds: [{ id: 888010, reason: '', total: '-5.00' }] })
  f.div.divergenceSeams.readLiveOrder = async () => null
  t.after(() => { f.div.divergenceSeams.readLiveOrder = undefined })
  // The row's last try is set a minute back first, so "backed off" is a strict comparison (an unchanged value would pass a >=).
  await f.db.wcOrderDivergenceRecheck.update({ where: { orderId: f.orderId }, data: { lastAttemptAt: new Date(Date.now() - 60_000) } })
  const before = await f.db.wcOrderDivergenceRecheck.findFirstOrThrow({ where: { orderId: f.orderId } })
  for (let i = 0; i < 3; i++) await f.div.drainDeferredWcOrderDivergences()
  const after = await f.db.wcOrderDivergenceRecheck.findFirstOrThrow({ where: { orderId: f.orderId } })
  assert.equal(after.attempts, before.attempts, 'failed reads never use up the attempt limit')
  assert.equal(after.failedReads, 3)
  assert.ok(after.lastAttemptAt.getTime() > before.lastAttemptAt.getTime(), 'backed off: sorted behind the rows not tried')
  // A successful read counts an attempt and clears the failure streak.
  f.div.divergenceSeams.readLiveOrder = async () => f.payload({ qty: 3, refunds: [{ id: 888010, reason: '', total: '-5.00' }] }) as never
  await f.div.drainDeferredWcOrderDivergences()
  const ok = await f.db.wcOrderDivergenceRecheck.findFirstOrThrow({ where: { orderId: f.orderId } })
  assert.equal(ok.attempts, 1)
  assert.equal(ok.failedReads, 0)
})

test('[divergence] o3d-7d84p: a PERMANENTLY failing read still ends in a refused action, however the row was queued', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  await f.deliver({ qty: 3, refunds: [{ id: 888011, reason: '', total: '-5.00' }] })
  f.div.divergenceSeams.readLiveOrder = async () => { throw new Error('woocommerce down') }
  t.after(() => { f.div.divergenceSeams.readLiveOrder = undefined })
  try {
    await f.db.wcOrderDivergenceRecheck.update({ where: { orderId: f.orderId }, data: { failedReads: f.div.RECHECK_MAX_FAILED_READS - 1, deferredAt: new Date(Date.now() - 5 * 86_400_000) } })
    const last = await f.div.drainDeferredWcOrderDivergences()
    assert.equal(last.dropped, 0, 'one failure short of the cap: still retrying')
    assert.equal((await f.db.wcOrderDivergenceRecheck.findFirstOrThrow({ where: { orderId: f.orderId } })).failedReads, f.div.RECHECK_MAX_FAILED_READS)
    const capped = await f.div.drainDeferredWcOrderDivergences()
    assert.equal(capped.dropped, 1)
    assert.equal(await f.db.wcOrderDivergenceRecheck.count({ where: { orderId: f.orderId } }), 0)
    const raised = await f.db.refusedAction.findMany({ where: { entityId: f.orderId, gate: f.div.WC_AMENDMENT_RECHECK_GATE } })
    assert.equal(raised.length, 1, 'the lost comparison is a visible refused action')
  } finally {
    await f.db.refusedAction.deleteMany({ where: { entityId: f.orderId } })
    await f.db.wcOrderDivergenceRecheck.deleteMany({ where: { orderId: f.orderId } })
  }
})

test('[divergence] o3d-7d84p: a hung live read cannot hold the drain past its budget', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  await f.deliver({ qty: 3, refunds: [{ id: 888012, reason: '', total: '-5.00' }] })
  f.div.divergenceSeams.readLiveOrder = () => new Promise<never>(() => undefined) // never settles
  t.after(() => { f.div.divergenceSeams.readLiveOrder = undefined })
  const started = Date.now()
  const out = await f.div.drainDeferredWcOrderDivergences(25, { budgetMs: 1_000, readTimeoutMs: 100 })
  assert.ok(Date.now() - started < 3_000, 'returned within the budget although the read never settled')
  assert.equal(out.examined >= 1, true)
  const row = await f.db.wcOrderDivergenceRecheck.findFirstOrThrow({ where: { orderId: f.orderId } })
  assert.equal(row.attempts, 0)
  assert.ok(row.failedReads >= 1)
})

test('[divergence] a detection failure never fails the import or stops the six-field update', { skip }, async (t) => {
  const f = await fixture(t)
  await f.setFlag(true)
  await f.deliver({})
  // A real failure: the table is not there while the delivery runs.
  await f.db.$executeRawUnsafe('ALTER TABLE wc_order_divergences RENAME TO wc_order_divergences_away')
  mock.method(console, 'error', () => {})
  try {
    const orderId = await f.deliver({ qty: 3, note: 'six-field still lands' })
    const row = await f.db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { notes: true, externalOrderNumber: true } })
    assert.equal(row.notes, 'six-field still lands')
    assert.equal(row.externalOrderNumber, String(f.externalId))
  } finally {
    mock.restoreAll()
    await f.db.$executeRawUnsafe('ALTER TABLE wc_order_divergences_away RENAME TO wc_order_divergences')
  }
  assert.equal((await f.records()).length, 0, 'nothing was recorded')
})

// ---- #1055 round 2 (o3d-3xk03): through the REAL comparison, on a scratch database. Nothing reaches a network (no warehouse gate is asked on these paths). ----

test('[divergence] MEDIUM: reduce THEN restore, through the comparison: nothing differs, yet the step raises the "a person decides" task; the amendment refund is recognised by its structured flag, not by its reason', { skip }, async (t) => {
  const f = await fixture(t)
  const amend = await import('@/lib/connectors/woocommerce/sync/order-amendment')
  await f.setFlag(true)
  const before = await f.db.setting.findUnique({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING } })
  await f.db.setting.upsert({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING }, create: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING, value: 'true' }, update: { value: 'true' } })
  try {
    await f.deliver({ qty: 3 })
    await f.deliver({ qty: 3 }) // the first delivery creates the order; the comparison runs from the second
    const lineId = (await f.db.salesOrderLine.findFirstOrThrow({ where: { orderId: f.orderId, externalLineItemId: 1 }, select: { id: true } })).id
    // The seen WooCommerce lines are kept by the comparison (what an IMS edit will take as its baseline).
    const seen = await f.db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, select: { wcSeenLines: true } })
    assert.deepEqual((seen.wcSeenLines as { lines: unknown[] }).lines, [{ externalLineItemId: 1, qty: 3 }])
    await f.db.wmsOrderPushLink.create({ data: { orderId: f.orderId, connector: 'mintsoft', externalOrderId: 'MS-3XK03', externalOrderNumber: 'W-3XK03', state: 'SYNCED' } })
    // One unit refunded by the amendment step (flagged), another by an ordinary refund whose reason merely EQUALS the amendment text (not flagged).
    const mk = async (wcAmendment: boolean, reason: string) => {
      const refund = await f.db.salesOrderRefund.create({ data: { orderId: f.orderId, totalForeign: '100.00', totalBase: '100.00', reason, wcAmendment } })
      await f.db.salesOrderRefundLine.create({ data: { refundId: refund.id, salesOrderLineId: lineId, description: 'Widget', qty: '1', unitPriceForeign: '100', unitPriceBase: '100', totalForeign: '100', totalBase: '100' } })
      return refund.id
    }
    await mk(false, amend.WC_AMENDMENT_REFUND_REASON)
    const facts = await amend.defaultAmendmentDeps.loadFacts(f.orderId)
    assert.equal(facts!.amendmentRefundedQtyByLineId!.size, 0, 'the reason text alone does not make a refund an amendment refund')
    await mk(true, 'anything else')
    const flagged = await amend.defaultAmendmentDeps.loadFacts(f.orderId)
    assert.equal(Number(flagged!.amendmentRefundedQtyByLineId!.get(lineId)), 1, 'the structured flag does')

    // WooCommerce restores the quantity: it shows 3 again (IMS holds 3). No difference is left, and the task must still appear.
    await f.deliver({ qty: 3 })
    const tasks = await f.db.wmsOperatorTask.findMany({ where: { orderId: f.orderId } })
    assert.equal(tasks.length, 1, 'one operator task for the restored reduction')
    assert.match(tasks[0].queryText, /shows 3 again/)
    await f.deliver({ qty: 3 })
    assert.equal(await f.db.wmsOperatorTask.count({ where: { orderId: f.orderId } }), 1, 'a repeat delivery does not raise it twice')
  } finally {
    await f.db.wmsOperatorTask.deleteMany({ where: { orderId: f.orderId } })
    await f.db.wmsOrderPushLink.deleteMany({ where: { orderId: f.orderId } })
    if (before) await f.db.setting.update({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING }, data: { value: before.value } })
    else await f.db.setting.deleteMany({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING } })
  }
})

test('[divergence] MED (r1): the seen WooCommerce lines are written conditionally in SQL: an older delivery never overwrites a newer one; a stale-rejected delivery and one without line_items are not recorded', { skip }, async (t) => {
  const f = await fixture(t)
  const seenMod = await import('@/lib/connectors/woocommerce/sync/wc-seen-lines')
  await f.setFlag(true)
  await f.deliver({})
  const read = async () => (await f.db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, select: { wcSeenLines: true, updatedAt: true } }))
  const wcAt = (qty: number, at: string) => seenMod.buildWcSeenLines({ date_modified_gmt: at, line_items: [{ id: 1, quantity: qty }] })
  const before = await read()
  await f.div.recordWcSeenLines(f.orderId, wcAt(3, '2026-11-02T10:00:00'))
  // The older delivery commits SECOND (the race the JS pre-check cannot see): the newer state stays.
  await f.div.recordWcSeenLines(f.orderId, wcAt(5, '2026-11-02T09:30:00'))
  const after = await read()
  assert.deepEqual((after.wcSeenLines as { lines: unknown[] }).lines, [{ externalLineItemId: 1, qty: 3 }])
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), 'updatedAt untouched')
  await f.div.recordWcSeenLines(f.orderId, wcAt(4, '2026-11-02T10:00:01'))
  assert.deepEqual(((await read()).wcSeenLines as { lines: unknown[] }).lines, [{ externalLineItemId: 1, qty: 4 }], 'a newer one is stored')

  // Through the comparison: a delivery older than external_updated_at (the core update rejected it as stale) and one with no line_items are not recorded.
  await f.db.$executeRaw`UPDATE sales_orders SET wc_seen_lines = NULL WHERE id = ${f.orderId}`
  await f.db.salesOrder.update({ where: { id: f.orderId }, data: { externalUpdatedAt: new Date('2026-11-02T12:00:00Z') } })
  await f.div.surfaceWcOrderDivergence(f.orderId, { ...f.payload({ qty: 3 }), date_modified_gmt: '2026-11-02T11:00:00' } as never)
  assert.equal((await read()).wcSeenLines, null, 'a stale-rejected delivery is not recorded')
  await f.db.salesOrder.update({ where: { id: f.orderId }, data: { externalUpdatedAt: new Date('2026-11-02T09:00:00Z') } })
  const noLines = { ...f.payload({}), line_items: undefined }
  await f.div.surfaceWcOrderDivergence(f.orderId, noLines as never)
  assert.equal((await read()).wcSeenLines, null, 'a payload without line_items is not recorded')
  await f.div.surfaceWcOrderDivergence(f.orderId, { ...f.payload({ qty: 3 }), date_modified_gmt: '2026-11-02T11:00:00' } as never)
  assert.notEqual((await read()).wcSeenLines, null, 'a current delivery is recorded')
})

test('[divergence] MED (r1): an unreadable warehouse gate queues a live re-read (recheck row), and the migration backfill marks #1055 amendment refunds; soft-deleted refunds are not counted', { skip }, async (t) => {
  const f = await fixture(t)
  const amend = await import('@/lib/connectors/woocommerce/sync/order-amendment')
  const gate = await import('@/lib/domain/sales/order-edit-wms-gate')
  await f.setFlag(true)
  const before = await f.db.setting.findUnique({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING } })
  await f.db.setting.upsert({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING }, create: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING, value: 'true' }, update: { value: 'true' } })
  const originalGate = gate.orderEditWmsGateDeps.current
  try {
    await f.deliver({ qty: 3 })
    await f.deliver({ qty: 3 })
    await f.db.salesOrder.update({ where: { id: f.orderId }, data: { paidAt: new Date('2026-11-01T00:00:00Z') } })
    await f.db.wmsOrderPushLink.create({ data: { orderId: f.orderId, connector: 'mintsoft', externalOrderId: 'MS-3XK03B', externalOrderNumber: 'W-3XK03B', state: 'SYNCED' } })
    gate.orderEditWmsGateDeps.current = { ...originalGate, probe: async () => { throw new Error('warehouse down') } }
    await f.deliver({ qty: 2 })
    assert.equal(await f.db.wcOrderDivergenceRecheck.count({ where: { orderId: f.orderId } }), 1, 'a live re-read is queued')
    assert.equal(await f.db.salesOrderRefund.count({ where: { orderId: f.orderId } }), 0, 'nothing refunded')
    assert.equal(await f.db.wmsOperatorTask.count({ where: { orderId: f.orderId } }), 0, 'no task claims picking started')

    // The backfill statement (migration): a refund with the #1055 reason and no flag is marked; another reason is not. A soft-deleted amendment refund is not counted.
    const lineId = (await f.db.salesOrderLine.findFirstOrThrow({ where: { orderId: f.orderId }, select: { id: true } })).id
    const mk = async (reason: string, deletedAt: Date | null) => {
      const r = await f.db.salesOrderRefund.create({ data: { orderId: f.orderId, totalForeign: '1.00', totalBase: '1.00', reason, deletedAt } })
      await f.db.salesOrderRefundLine.create({ data: { refundId: r.id, salesOrderLineId: lineId, description: 'W', qty: '1', unitPriceForeign: '1', unitPriceBase: '1', totalForeign: '1', totalBase: '1' } })
      return r.id
    }
    const legacy = await mk(amend.WC_AMENDMENT_REFUND_REASON, null)
    const other = await mk('something else', null)
    const deleted = await mk(amend.WC_AMENDMENT_REFUND_REASON, new Date())
    const fs = await import('node:fs')
    const sql = fs.readFileSync('prisma/migrations/20261120000000_wc_amendment_round2/migration.sql', 'utf8').split('\n').find((l) => l.startsWith('UPDATE "sales_order_refunds"'))!
    await f.db.$executeRawUnsafe(sql)
    const flags = new Map((await f.db.salesOrderRefund.findMany({ where: { id: { in: [legacy, other, deleted] } }, select: { id: true, wcAmendment: true } })).map((r) => [r.id, r.wcAmendment]))
    assert.equal(flags.get(legacy), true)
    assert.equal(flags.get(other), false)
    const facts = await amend.defaultAmendmentDeps.loadFacts(f.orderId)
    assert.equal(Number(facts!.refundedQtyByLineId.get(lineId)), 2, 'the soft-deleted refund is not counted (legacy + other only)')
    assert.equal(Number(facts!.amendmentRefundedQtyByLineId!.get(lineId)), 1, 'only the live amendment refund')
  } finally {
    gate.orderEditWmsGateDeps.current = originalGate
    await f.db.wcOrderDivergenceRecheck.deleteMany({ where: { orderId: f.orderId } })
    await f.db.wmsOperatorTask.deleteMany({ where: { orderId: f.orderId } })
    await f.db.wmsOrderPushLink.deleteMany({ where: { orderId: f.orderId } })
    if (before) await f.db.setting.update({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING }, data: { value: before.value } })
    else await f.db.setting.deleteMany({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING } })
  }
})

test('[divergence] y1cqe 5: an unparseable stored or incoming `at` no longer freezes the seen state (no ::timestamp cast), and a failed write is logged', { skip }, async (t) => {
  const f = await fixture(t)
  const seenMod = await import('@/lib/connectors/woocommerce/sync/wc-seen-lines')
  await f.setFlag(true)
  await f.deliver({})
  const read = async () => (await f.db.salesOrder.findUniqueOrThrow({ where: { id: f.orderId }, select: { wcSeenLines: true } })).wcSeenLines as { at: string | null; lines: Array<{ qty: number }> }
  const wcAt = (qty: number, at: string) => seenMod.buildWcSeenLines({ date_modified_gmt: at, line_items: [{ id: 1, quantity: qty }] })
  // The stored value cannot be cast (a pre-round-2 row, an odd date_modified fallback): a later, valid delivery is still recorded.
  await f.db.$executeRaw`UPDATE sales_orders SET wc_seen_lines = '{"at":"not a date","digest":"d","lines":[{"externalLineItemId":1,"qty":1}]}'::jsonb WHERE id = ${f.orderId}`
  await f.div.recordWcSeenLines(f.orderId, wcAt(3, '2026-11-02T10:00:00'))
  assert.equal((await read()).lines[0]!.qty, 3, 'a stored value that cannot be ordered is overwritten, not a frozen state')
  // The incoming value cannot be ordered: it does not throw and does not leave the state frozen either.
  await f.div.recordWcSeenLines(f.orderId, wcAt(4, 'garbage'))
  assert.equal((await read()).lines[0]!.qty, 4)
  // Ordinary ordering still holds afterwards.
  await f.div.recordWcSeenLines(f.orderId, wcAt(6, '2026-11-02T10:00:00'))
  await f.div.recordWcSeenLines(f.orderId, wcAt(5, '2026-11-02T09:00:00'))
  assert.equal((await read()).lines[0]!.qty, 6, 'an older delivery still never overwrites a newer one')

  // A write that fails is LOGGED, not swallowed.
  const logged: unknown[][] = []
  const errorMock = mock.method(console, 'error', (...args: unknown[]) => { logged.push(args) })
  await f.db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION y1cqe_seen_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${f.orderId}' THEN RAISE EXCEPTION 'y1cqe forced failure'; END IF; RETURN NEW; END $$`)
  await f.db.$executeRawUnsafe('CREATE TRIGGER y1cqe_seen_fail_trg BEFORE UPDATE ON sales_orders FOR EACH ROW EXECUTE FUNCTION y1cqe_seen_fail()')
  try {
    await f.div.recordWcSeenLines(f.orderId, wcAt(7, '2026-11-02T11:00:00'))
  } finally {
    await f.db.$executeRawUnsafe('DROP TRIGGER IF EXISTS y1cqe_seen_fail_trg ON sales_orders')
    await f.db.$executeRawUnsafe('DROP FUNCTION IF EXISTS y1cqe_seen_fail()')
    errorMock.mock.restore()
  }
  assert.ok(logged.some((args) => String(args[0]).includes('could not record the seen WooCommerce lines')), 'the failure is logged')
})

test('[divergence] y1cqe 3+4: a recheck queued by an unreadable gate that runs out of attempts raises a refused action (not dropped silently); a re-created row is not counted as resolved', { skip }, async (t) => {
  const f = await fixture(t)
  const amend = await import('@/lib/connectors/woocommerce/sync/order-amendment')
  const gate = await import('@/lib/domain/sales/order-edit-wms-gate')
  await f.setFlag(true)
  const before = await f.db.setting.findUnique({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING } })
  await f.db.setting.upsert({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING }, create: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING, value: 'true' }, update: { value: 'true' } })
  const originalGate = gate.orderEditWmsGateDeps.current
  const open = () => f.db.refusedAction.findMany({ where: { entityType: 'SALES_ORDER', entityId: f.orderId, action: 'WC_ORDER_AMENDMENT', resolvedAt: null } })
  try {
    await f.deliver({ qty: 3 })
    await f.deliver({ qty: 3 })
    await f.db.salesOrder.update({ where: { id: f.orderId }, data: { paidAt: new Date('2026-11-01T00:00:00Z') } })
    await f.db.wmsOrderPushLink.create({ data: { orderId: f.orderId, connector: 'mintsoft', externalOrderId: 'MS-Y1CQE', externalOrderNumber: 'W-Y1CQE', state: 'SYNCED' } })
    gate.orderEditWmsGateDeps.current = { ...originalGate, probe: async () => { throw new Error('warehouse down') } }
    await f.deliver({ qty: 2 })
    const queued = await f.db.wcOrderDivergenceRecheck.findFirstOrThrow({ where: { orderId: f.orderId } })
    assert.equal(queued.fromRetry, true, 'queued by a retry outcome')

    // y1cqe 4: the live re-read still cannot decide, so the row is re-created (new id). The order is still pending, not resolved.
    f.div.divergenceSeams.readLiveOrder = async () => f.payload({ qty: 2 }) as never
    t.after(() => { f.div.divergenceSeams.readLiveOrder = undefined })
    const pending = await f.div.drainDeferredWcOrderDivergences()
    assert.equal(pending.examined, 1)
    assert.equal(pending.resolved, 0, 'a re-created recheck row is not "resolved"')
    const again = await f.db.wcOrderDivergenceRecheck.findFirstOrThrow({ where: { orderId: f.orderId } })
    assert.equal(again.attempts, 1)
    assert.equal((await open()).length, 0, 'nothing is raised while attempts remain')

    // y1cqe 3: the cap is reached: the row goes, and a visible refused action replaces it.
    await f.db.wcOrderDivergenceRecheck.update({ where: { orderId: f.orderId }, data: { attempts: f.div.RECHECK_MAX_ATTEMPTS } })
    const capped = await f.div.drainDeferredWcOrderDivergences()
    assert.equal(capped.dropped, 1)
    assert.equal(await f.db.wcOrderDivergenceRecheck.count({ where: { orderId: f.orderId } }), 0)
    const raised = await open()
    assert.equal(raised.length, 1, 'a refused action is raised for the order')
    assert.equal(raised[0]!.gate, f.div.WC_AMENDMENT_RECHECK_GATE)
    assert.equal(raised[0]!.severity, 'MEDIUM')

    // A row deferred only for an unrecorded refund (not a retry outcome) is still dropped quietly at the cap.
    await f.db.refusedAction.deleteMany({ where: { entityId: f.orderId } })
    await f.db.wcOrderDivergenceRecheck.create({ data: { orderId: f.orderId, externalOrderId: String(f.externalId), attempts: f.div.RECHECK_MAX_ATTEMPTS } })
    await f.div.drainDeferredWcOrderDivergences()
    assert.equal((await open()).length, 0, 'a refund-deferral row that never resolved owes nothing')
  } finally {
    gate.orderEditWmsGateDeps.current = originalGate
    await f.db.refusedAction.deleteMany({ where: { entityId: f.orderId } })
    await f.db.wcOrderDivergenceRecheck.deleteMany({ where: { orderId: f.orderId } })
    await f.db.wmsOperatorTask.deleteMany({ where: { orderId: f.orderId } })
    await f.db.wmsOrderPushLink.deleteMany({ where: { orderId: f.orderId } })
    if (before) await f.db.setting.update({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING }, data: { value: before.value } })
    else await f.db.setting.deleteMany({ where: { key: amend.WC_ORDER_AMENDMENT_WRITE_SETTING } })
  }
})
