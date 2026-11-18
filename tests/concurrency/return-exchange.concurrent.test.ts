import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * EXCHANGES INSIDE A RETURN, through the real `createRefund`, against a real PostgreSQL (scratch database). Nothing is sent anywhere: the accounting queue only writes rows and the tier has no network.
 *
 *  1. An exchange adds the replacement as NEW LINES ON THE SAME ORDER, each linked to the refund; the return side (the refund, its lines, its credit note, its status) is exactly what the same return records without an exchange; stock is released for the
 *     returned unit and reserved for the replacement (reservedQty equals the allocation rows).
 *  2. An even exchange moves no money in IMS: no payment row, the paid state untouched. A difference is shown (the preview's gross and the pure difference) and not charged: still no payment row, and no refund beyond the one recorded.
 *  3. A posted invoice's update is queued in the same transaction: HELD (the producer-side hold) only a shadow is recorded and nothing is claimable; not held, one PENDING update carries the replacement.
 *  4. The gates refuse and write nothing: a dispatched order, a warehouse order that can no longer be amended, a fully refunded order, an order the daily batch booked ahead, an invoice queued but not posted, an exchange that would still refund the order in full.
 *  5. A WooCommerce-linked order needs the acknowledgement (exactly true) and is marked edited in IMS (with the line baseline) when it has it.
 *  6. The switch off does nothing: the exchange is refused, nothing is written, an ordinary refund is unaffected.
 *  7. Permission denial: without the permission to edit, or to process, or to refund, nothing is written.
 *  8. The returns analytics show the exchange (exchanged and replacement units; the credit is not a lost sale); a refund that came with an exchange cannot be deleted.
 * Mutations: skip the gate check (arm 4 writes), drop exchangeForRefundId (arm 1 loses the link), classify before the lines are added (arm 4 "still refunds in full" and the allocation arm fail: a FULL order holds no demand).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

let permissionsAsked: string[] = []
let deniedPermissions = new Set<string>()
let depsPromise: ReturnType<typeof loadDepsOnce> | undefined
function loadDeps() { depsPromise ??= loadDepsOnce(); return depsPromise }
async function loadDepsOnce() {
  loadEnv()
  process.env.SETTINGS_ENCRYPTION_KEY ??= 'a1'.repeat(32)
  mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
  const stockSyncs: string[][] = []
  mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async (ids: string[]) => { stockSyncs.push(ids) } } })
  mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
  const realAuth = await import('@/lib/auth/server')
  const session = { user: { id: 'test-user', role: 'ADMIN' } }
  mock.module('@/lib/auth/server', {
    namedExports: {
      ...realAuth,
      requirePermission: async (permission: string) => {
        permissionsAsked.push(permission)
        if (deniedPermissions.has(permission)) throw new Error(`Forbidden: missing permission ${permission}`)
        return session
      },
      requireInternalUser: async () => session,
      requireRole: async () => session,
      requireFreshPermission: async () => session,
      freshAuthFailureResult: () => null,
    },
  })
  const [{ db }, actions, gate, exchange, analytics, deletion] = await Promise.all([
    import('@/lib/db'),
    import('@/app/actions/sales'),
    import('@/lib/domain/sales/order-edit-wms-gate'),
    import('@/lib/domain/sales/return-exchange'),
    import('@/lib/domain/sales/sales-fulfillment-analytics'),
    import('@/lib/domain/sales/refund-delete-service'),
  ])
  return { db, actions, gate, exchange, analytics, deletion, stockSyncs }
}

type World = {
  tag: string
  warehouseId: string
  p1: { id: string; sku: string }
  p2: { id: string; sku: string }
  rateName: string
  orderIds: string[]
  settingKeys: string[]
  teardown: () => Promise<void>
}

async function setSetting(w: World, key: string, value: string) {
  const { db } = await loadDeps()
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  if (!w.settingKeys.includes(key)) w.settingKeys.push(key)
}

async function seedWorld(options: { enabled?: boolean } = {}): Promise<World> {
  const { db } = await loadDeps()
  const tag = uid()
  permissionsAsked = []
  deniedPermissions = new Set()
  // The shared database may carry accounting settings an earlier file left: the world starts with none and puts them back at teardown.
  const leftover = await db.setting.findMany({ where: { OR: [{ key: { startsWith: 'xero_' } }, { key: 'plugin_xero_enabled' }, { key: 'return_exchange_enabled' }] } })
  await db.setting.deleteMany({ where: { key: { in: leftover.map((r) => r.key) } } })
  await db.user.upsert({ where: { id: 'test-user' }, create: { id: 'test-user', email: 'test-user@example.invalid', name: 'test user', passwordHash: 'x' }, update: {} })
  const rate = await db.taxRate.create({ data: { name: `ZQRX Std 20 ${tag}`, rate: '0.2', usedFor: 'SALES', taxCategory: 'STANDARD', accountingTaxType: 'OUTPUT2', active: true }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: `RX${tag.slice(0, 8)}`, name: `Return exchange ${tag}`, active: true, availableForSale: true, syncToStore: true }, select: { id: true } })
  const mk = async (k: string) => db.product.create({ data: { sku: `RX-${k}-${tag}`, name: `Return exchange ${k}`, type: 'SIMPLE', taxCategory: 'STANDARD', oversellAllowed: false }, select: { id: true, sku: true } })
  const p1 = await mk('P1')
  const p2 = await mk('P2')
  for (const p of [p1, p2]) await db.stockLevel.create({ data: { productId: p.id, warehouseId: warehouse.id, quantity: 20 } })
  const world: World = {
    tag, warehouseId: warehouse.id, p1, p2, rateName: `ZQRX Std 20 ${tag}`, orderIds: [], settingKeys: [],
    teardown: async () => {
      const ids = world.orderIds
      await db.wmsOperatorTask.deleteMany({ where: { orderId: { in: ids } } })
      await db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: ids } } })
      await db.shoppingOrderLink.deleteMany({ where: { orderId: { in: ids } } })
      await db.accountingSyncLog.deleteMany({ where: { OR: [{ referenceId: { in: ids } }, { referenceType: 'SalesOrderRefund', referenceId: { in: (await db.salesOrderRefund.findMany({ where: { orderId: { in: ids } }, select: { id: true } })).map((r) => r.id) } }] } })
      await db.returnExpectation.deleteMany({ where: { orderId: { in: ids } } })
      await db.salesOrderRefundLine.deleteMany({ where: { refund: { orderId: { in: ids } } } })
      await db.stockMovement.deleteMany({ where: { productId: { in: [p1.id, p2.id] } } })
      await db.costLayer.deleteMany({ where: { productId: { in: [p1.id, p2.id] } } })
      await db.orderAllocation.deleteMany({ where: { orderId: { in: ids } } })
      await db.shipmentLine.deleteMany({ where: { shipment: { orderId: { in: ids } } } })
      await db.shipment.deleteMany({ where: { orderId: { in: ids } } })
      await db.activityLog.deleteMany({ where: { entityId: { in: ids } } })
      await db.salesOrderLine.deleteMany({ where: { orderId: { in: ids } } })
      await db.salesOrderRefund.deleteMany({ where: { orderId: { in: ids } } })
      await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
      await db.stockLevel.deleteMany({ where: { warehouseId: warehouse.id } })
      await db.product.deleteMany({ where: { id: { in: [p1.id, p2.id] } } })
      await db.warehouse.deleteMany({ where: { id: warehouse.id } })
      await db.taxRate.deleteMany({ where: { id: rate.id } })
      await db.setting.deleteMany({ where: { key: { in: [...world.settingKeys, ...leftover.map((r) => r.key)] } } })
      for (const r of leftover) await db.setting.create({ data: { key: r.key, value: r.value } })
      await db.user.deleteMany({ where: { id: 'test-user' } })
    },
  }
  if (options.enabled !== false) await setSetting(world, 'return_exchange_enabled', 'true')
  return world
}

type Line = { p: 'p1' | 'p2'; qty: number; price?: number }

function inputFor(w: World, lines: Line[]) {
  return {
    customerName: 'Return Exchange Customer',
    customerEmail: 'rx@example.test',
    billingAddress: { line1: '1 Bill St', country: 'GB' },
    shippingAddress: { line1: '2 Ship St', country: 'GB' },
    currency: 'GBP',
    shipFromWarehouseId: w.warehouseId,
    taxRateName: w.rateName,
    taxRateValue: 0.2,
    pricesIncludeVat: false,
    shippingForeign: 5,
    notes: 'n',
    isDraft: false,
    lines: lines.map((l) => ({ productId: w[l.p].id, sku: w[l.p].sku, description: `Desc ${l.p}`, qty: l.qty, unitPriceForeign: l.price ?? 10 })),
  }
}

async function createConfirmed(w: World, lines: Line[]): Promise<string> {
  const { actions } = await loadDeps()
  const r = await actions.createSalesOrder(inputFor(w, lines) as never)
  assert.equal(r.success, true, r.error)
  w.orderIds.push(r.order!.id)
  return r.order!.id
}

/** The return of `qty` units of the order's first line, cut the way the refund dialog sends it (the server re-cuts the amounts from the stored line). */
async function returnLines(w: World, orderId: string, qty: number) {
  const { db } = await loadDeps()
  const line = await db.salesOrderLine.findFirstOrThrow({ where: { orderId, exchangeForRefundId: null }, orderBy: { id: 'asc' } })
  const net = (Number(line.totalForeign) / Number(line.qty)) * qty
  return [{ lineId: line.id, productId: line.productId, description: line.description, qty, totalForeign: net, totalBase: net, lineKind: 'sale' as const }]
}

function replacement(w: World, p: 'p1' | 'p2', qty: number, price = 10) {
  return { productId: w[p].id, qty, unitPriceForeign: price }
}

async function orderState(orderId: string) {
  const { db } = await loadDeps()
  const so = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: { orderBy: { id: 'asc' } }, refunds: true } })
  return JSON.stringify({ ...so, updatedAt: undefined })
}

async function reservation(w: World, orderId: string) {
  const { db } = await loadDeps()
  const levels = await db.stockLevel.findMany({ where: { warehouseId: w.warehouseId, productId: { in: [w.p1.id, w.p2.id] } } })
  const reserved = Object.fromEntries(levels.map((l) => [l.productId === w.p1.id ? 'p1' : 'p2', Number(l.reservedQty)]))
  const allocs = await db.orderAllocation.findMany({ where: { orderId } })
  const others = await db.orderAllocation.findMany({ where: { orderId: { in: w.orderIds.filter((o) => o !== orderId) } } })
  for (const o of others) reserved[o.productId === w.p1.id ? 'p1' : 'p2'] -= Number(o.qty)
  const allocated: Record<string, number> = { p1: 0, p2: 0 }
  for (const a of allocs) allocated[a.productId === w.p1.id ? 'p1' : 'p2'] += Number(a.qty)
  return { reserved: { p1: reserved.p1 ?? 0, p2: reserved.p2 ?? 0 }, allocated }
}

/** The warehouse's answer to the amend gate, supplied without a network (only the connector's answer is replaced). */
async function warehouseAnswers(t: { after: (fn: () => void) => void }, answer: { amendable: true } | { amendable: false; status: string }) {
  const { gate } = await loadDeps()
  const real = gate.orderEditWmsGateDeps.current
  gate.orderEditWmsGateDeps.current = { ...real, probe: async () => answer }
  t.after(() => { gate.orderEditWmsGateDeps.current = real })
}

async function enableXeroInvoicing(w: World) {
  for (const [key, value] of [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true'], ['xero_sync_sales_invoice', 'submitted'], ['xero_sales_account', '200'], ['xero_shipping_account', '260']] as Array<[string, string]>) await setSetting(w, key, value)
}

test('an exchange adds linked replacement lines on the same order; the return side is exactly the return without an exchange; stock follows', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { db, actions } = await loadDeps()
  const withExchange = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const control = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const before = await db.salesOrder.findUniqueOrThrow({ where: { id: withExchange }, select: { totalForeign: true, subtotalForeign: true, taxForeign: true, totalBase: true, status: true } })
  assert.equal(before.status, 'ALLOCATED')
  assert.equal(Number(before.totalForeign), 30, '2 x 10 + 5 shipping + 20% VAT')

  permissionsAsked = []
  const result = await actions.createRefund(withExchange, await returnLines(w, withExchange, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)] } })
  assert.equal(result.success, true, result.error)
  assert.ok(permissionsAsked.includes('sales.refund') && permissionsAsked.includes('sales.create') && permissionsAsked.includes('sales.process'), 'an exchange asks for the refund, edit and process permissions')
  assert.deepEqual(result.exchange, { lineCount: 1, replacementGrossForeign: 12 })

  const plain = await actions.createRefund(control, await returnLines(w, control, 1), 'swap')
  assert.equal(plain.success, true, plain.error)

  const order = await db.salesOrder.findUniqueOrThrow({ where: { id: withExchange }, include: { lines: { orderBy: { id: 'asc' } }, refunds: { include: { lines: true } } } })
  assert.equal(order.lines.length, 2)
  const refund = order.refunds[0]
  const linked = order.lines.filter((l) => l.exchangeForRefundId === refund.id)
  assert.equal(linked.length, 1, 'the replacement line is linked to the refund it replaces')
  assert.equal(linked[0].productId, w.p2.id)
  assert.equal(order.lines.filter((l) => l.exchangeForRefundId === null).length, 1, 'the original line is an ordinary line')
  // The order carries the replacement: +10 net, +2 VAT.
  assert.equal(Number(order.subtotalForeign), 30)
  assert.equal(Number(order.taxForeign), Number(before.taxForeign) + 2)
  assert.equal(Number(order.totalForeign), 42)
  assert.equal(order.refundStatus, 'PARTIAL', 'refunded in part: the order holds demand, so the replacement can be reserved and shipped')
  assert.equal(order.editedInImsAt, null, 'a manual order is not marked (no shop copy)')

  // THE RETURN SIDE IS UNCHANGED: the same return without an exchange records the same refund, line and credit note shape.
  const controlRefund = await db.salesOrderRefund.findFirstOrThrow({ where: { orderId: control }, include: { lines: true } })
  const shape = (r: typeof refund) => ({ total: Number(r.totalForeign), totalBase: Number(r.totalBase), basis: r.totalsBasis, source: r.source, chargeback: r.chargeback, reason: r.reason, creditNote: Boolean(r.creditNoteNumber), lines: r.lines.map((l) => ({ qty: Number(l.qty), total: Number(l.totalForeign), kind: l.lineKind })) })
  assert.deepEqual(shape(refund), shape(controlRefund))

  // Stock: the returned unit's reservation was given back, the replacement was reserved; reservedQty equals the allocation rows.
  const r = await reservation(w, withExchange)
  assert.deepEqual(r.reserved, r.allocated, 'reservedQty equals the allocation rows')
  assert.deepEqual(r.allocated, { p1: 1, p2: 1 })
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: withExchange }, select: { status: true } })).status, 'ALLOCATED', 'reserved in full again')

  const audit = await db.activityLog.findMany({ where: { entityId: withExchange, action: 'return_exchange_recorded' } })
  assert.equal(audit.length, 1)
  assert.equal(audit[0].tag, 'audit')
  assert.equal((audit[0].metadata as { refundId: string }).refundId, refund.id)
  assert.ok(await db.activityLog.findFirst({ where: { entityId: withExchange, action: 'return_exchange' } }))
})

test('an even exchange moves no money in IMS; a difference is shown and never charged or refunded', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { db, actions, exchange } = await loadDeps()
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const paymentsBefore = await db.payment.count({ where: { orderId: id } })

  // The preview prices the replacement (read only), and the difference is the pure rule over it and the credit note's gross.
  const preview = await actions.previewReturnExchange(id, [replacement(w, 'p2', 1)])
  assert.equal(preview.success, true, preview.error)
  assert.equal(preview.replacementGross, 12)
  assert.deepEqual(exchange.exchangeDifference({ replacementGross: preview.replacementGross!, creditNoteGross: 12 }), { kind: 'EVEN', amount: 0 })
  const even = await actions.createRefund(id, await returnLines(w, id, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)] } })
  assert.equal(even.success, true, even.error)
  assert.equal(await db.payment.count({ where: { orderId: id } }), paymentsBefore, 'no payment row: nothing was charged or paid out')
  const evenOrder = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { paidAt: true, unregisteredPaidAt: true, storeCreditForeign: true } })
  assert.equal(evenOrder.paidAt, null)
  assert.equal(Number(evenOrder.storeCreditForeign), 0)
  assert.equal(await db.salesOrderRefund.count({ where: { orderId: id } }), 1, 'exactly the return was recorded as a refund')

  // A difference: two replacement units (gross 24) for one returned unit (credit 12): the customer owes 12. Shown, not charged.
  const other = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const more = await actions.createRefund(other, await returnLines(w, other, 1), 'swap up', undefined, { exchange: { lines: [replacement(w, 'p2', 2)] } })
  assert.equal(more.success, true, more.error)
  assert.equal(more.exchange?.replacementGrossForeign, 24)
  const diff = exchange.exchangeDifference({ replacementGross: more.exchange!.replacementGrossForeign, creditNoteGross: 12 })
  assert.deepEqual(diff, { kind: 'CUSTOMER_OWES', amount: 12 })
  assert.match(exchange.exchangeDifferenceLabel(diff, (n) => `£${n.toFixed(2)}`), /Customer owes £12\.00\. IMS does not charge it/)
  assert.equal(await db.payment.count({ where: { orderId: other } }), 0, 'the difference was not charged: no payment row')
  assert.equal(await db.salesOrderRefund.count({ where: { orderId: other } }), 1, 'and not refunded: still the one return')
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: other }, select: { paidAt: true } })).paidAt, null)
  assert.equal(Number((await db.salesOrder.findUniqueOrThrow({ where: { id: other }, select: { totalForeign: true } })).totalForeign), 30 + 24, 'the order simply carries the replacement')
  assert.equal(exchange.exchangeDifference({ replacementGross: 6, creditNoteGross: 12 }).kind, 'REFUND_DUE')
})

test('a posted invoice: the update is queued in the same transaction; HELD only a shadow is recorded; nothing is sent', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(async () => { delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS; await w.teardown() })
  const { db, actions } = await loadDeps()
  await enableXeroInvoicing(w)
  const post = async () => {
    const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
    await db.accountingSyncLog.deleteMany({ where: { referenceId: id } })
    await db.salesOrder.update({ where: { id }, data: { accountingInvoiceId: `XERO-${uid()}`, accountingInvoiceConnector: 'xero', invoiceNumber: `INV-${uid()}` } })
    return id
  }

  const heldId = await post()
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'xero'
  const held = await actions.createRefund(heldId, await returnLines(w, heldId, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)] } })
  assert.equal(held.success, true, held.error)
  const heldRows = await db.accountingSyncLog.findMany({ where: { referenceId: heldId, type: 'SALES_INVOICE_UPDATE' } })
  assert.ok(heldRows.length > 0 && heldRows.every((r) => r.status === 'CANCELLED'), 'held: only a shadow record exists; nothing is PENDING or claimable')
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: heldId, type: 'SALES_INVOICE_UPDATE', status: { in: ['PENDING', 'PROCESSING'] } } }), 0, 'held: nothing is sent')
  assert.ok(await db.activityLog.findFirst({ where: { entityId: heldId, action: 'sales_invoice_update_shadowed' } }), 'held: the shadow is recorded')

  delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
  const liveId = await post()
  const live = await actions.createRefund(liveId, await returnLines(w, liveId, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)] } })
  assert.equal(live.success, true, live.error)
  const rows = await db.accountingSyncLog.findMany({ where: { referenceId: liveId, type: 'SALES_INVOICE_UPDATE', status: 'PENDING' } })
  assert.equal(rows.length, 1, 'one update is queued, not sent (the drain is a separate process and the tier has no network)')
  const payload = rows[0].payload as { lines: Array<{ itemCode: string; quantity: number }> }
  assert.deepEqual(payload.lines.map((l) => l.itemCode).sort(), [w.p1.sku, w.p2.sku].sort(), 'the update carries the original line and the replacement')
})

test('the gates refuse and write nothing: dispatched, a warehouse that cannot amend, fully refunded, booked ahead, an unposted invoice, an exchange that would still refund the order in full', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { db, actions } = await loadDeps()
  await warehouseAnswers(t, { amendable: true })
  const attempt = async (id: string, label: string, expected: RegExp, lines = [replacement(w, 'p2', 1)]) => {
    const state = await orderState(id)
    const reserved = await reservation(w, id)
    const outcome = await actions.createRefund(id, await returnLines(w, id, 1), 'swap', undefined, { exchange: { lines } })
    assert.equal(outcome.success, false, label)
    assert.match(String(outcome.error), expected, label)
    assert.equal(await orderState(id), state, `${label}: nothing was written (no refund, no lines, no totals)`)
    assert.deepEqual(await reservation(w, id), reserved, `${label}: the reservation is untouched`)
    assert.equal(await db.salesOrderRefund.count({ where: { orderId: id } }), 0, label)
  }

  const dispatched = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  await db.shipment.create({ data: { orderId: dispatched, warehouseId: w.warehouseId, status: 'SHIPPED' } })
  await db.salesOrder.update({ where: { id: dispatched }, data: { status: 'SHIPPED' } })
  await attempt(dispatched, 'dispatched', /cannot be recorded on this order.*dispatched/)

  const pushed = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  await db.wmsOrderPushLink.create({ data: { orderId: pushed, connector: 'mintsoft', state: 'SYNCED', externalOrderId: `MS-${w.tag}`, pushedAt: new Date() } as never })
  await warehouseAnswers(t, { amendable: false, status: 'PICKED' })
  await attempt(pushed, 'warehouse cannot amend', /AMENDMENT_NOT_APPLIED/)
  await warehouseAnswers(t, { amendable: true })

  const refunded = await createConfirmed(w, [{ p: 'p1', qty: 1 }])
  await db.salesOrder.update({ where: { id: refunded }, data: { refundStatus: 'FULL' } })
  await attempt(refunded, 'fully refunded', /already fully refunded/)

  const booked = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  await db.salesOrder.update({ where: { id: booked }, data: { revenueDeferredDate: new Date() } })
  await attempt(booked, 'booked ahead', /daily accounting batch has already booked/)

  const unposted = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  await db.accountingSyncLog.create({ data: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: unposted, connector: 'xero', status: 'PENDING', payload: {} } as never })
  await attempt(unposted, 'invoice queued but not posted', /has not been posted yet/)

  // A free replacement for the whole order would leave it fully refunded: it would hold no demand, so the replacement could not ship. Refused, and the whole refund is rolled back.
  const whole = await createConfirmed(w, [{ p: 'p1', qty: 1 }])
  const state = await orderState(whole)
  const wholeReturn = (await db.salesOrderLine.findFirstOrThrow({ where: { orderId: whole } }))
  const full = await actions.createRefund(whole, [{ lineId: wholeReturn.id, productId: wholeReturn.productId, description: 'x', qty: 1, totalForeign: 10, totalBase: 10, lineKind: 'sale' }, { lineId: null, productId: null, description: 'Shipping', qty: 0, totalForeign: 5, totalBase: 5, lineKind: 'shipping' }], 'free swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1, 0)] } })
  assert.equal(full.success, false)
  assert.match(String(full.error), /would still refund the whole order/)
  assert.equal(await orderState(whole), state, 'rolled back: the refund and the replacement are both gone')
})

test('a WooCommerce-linked order needs the acknowledgement, as exactly true, and is marked edited in IMS with the line baseline', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { db, actions } = await loadDeps()
  const linked = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  await db.shoppingOrderLink.create({ data: { orderId: linked, connector: 'woocommerce', externalOrderId: `rx-${w.tag}` } })
  await db.salesOrderLine.updateMany({ where: { orderId: linked }, data: { externalLineItemId: 4242 } })

  const state = await orderState(linked)
  for (const [label, ack] of [['absent', undefined], ['false', false], ['truthy string', 'true' as unknown as boolean]] as const) {
    const refused = await actions.createRefund(linked, await returnLines(w, linked, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)], acknowledgeShopDesync: ack } })
    assert.equal(refused.success, false, label)
    assert.match(String(refused.error), /WooCommerce keeps the original/, label)
    assert.equal(await orderState(linked), state, `${label}: nothing was written`)
  }
  const ok = await actions.createRefund(linked, await returnLines(w, linked, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)], acknowledgeShopDesync: true } })
  assert.equal(ok.success, true, ok.error)
  const row = await db.salesOrder.findUniqueOrThrow({ where: { id: linked } })
  assert.notEqual(row.editedInImsAt, null)
  const baseline = row.wcLineBaseline as { totalForeign: number; lines: Array<{ externalLineItemId: number; qty: number }> }
  assert.equal(baseline.totalForeign, 30, 'the baseline is what WooCommerce holds (the order as it was)')
  assert.deepEqual(baseline.lines.map((l) => [l.externalLineItemId, l.qty]), [[4242, 2]])
  const audit = await db.activityLog.findFirstOrThrow({ where: { entityId: linked, action: 'return_exchange_recorded' } })
  assert.equal((audit.metadata as { shopDesyncAcknowledged: boolean }).shopDesyncAcknowledged, true)
  // A manual order needs no acknowledgement (covered by the first test); an ordinary refund of the shop order still raises the "Refund in WooCommerce" task and no WooCommerce write.
  assert.equal(await db.wmsOperatorTask.count({ where: { orderId: linked, reason: 'SHOP_REFUND_DUE' } }), 1)
})

test('the switch off does nothing: the exchange is refused and nothing is written; an ordinary refund is unaffected', SKIP, async (t) => {
  const w = await seedWorld({ enabled: false })
  t.after(() => w.teardown())
  const { db, actions } = await loadDeps()
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const state = await orderState(id)
  const off = await actions.createRefund(id, await returnLines(w, id, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)] } })
  assert.equal(off.success, false)
  assert.match(String(off.error), /switched off/)
  assert.equal(await orderState(id), state, 'nothing was written')
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: id } }), 0)
  const offer = await actions.getReturnExchangeOffer(id)
  assert.deepEqual({ enabled: offer.enabled, offered: offer.offered }, { enabled: false, offered: false })
  assert.equal((await actions.previewReturnExchange(id, [replacement(w, 'p2', 1)])).success, false)
  // Switched explicitly to anything but "true" is the same as absent.
  await setSetting(w, 'return_exchange_enabled', 'false')
  assert.equal((await actions.createRefund(id, await returnLines(w, id, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)] } })).success, false)
  // The return itself, without an exchange, is exactly as before.
  const plain = await actions.createRefund(id, await returnLines(w, id, 1), 'plain return')
  assert.equal(plain.success, true, plain.error)
  assert.equal(await db.salesOrderLine.count({ where: { orderId: id, exchangeForRefundId: { not: null } } }), 0)
  assert.equal(plain.exchange, undefined)
})

test('permission denial: without the permission to edit, to process or to refund nothing is written', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { db, actions } = await loadDeps()
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const state = await orderState(id)
  for (const denied of ['sales.create', 'sales.process', 'sales.refund']) {
    deniedPermissions = new Set([denied])
    const outcome = await actions.createRefund(id, await returnLines(w, id, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)] } })
    assert.equal(outcome.success, false, denied)
    assert.match(String(outcome.error), new RegExp(`missing permission ${denied.replace('.', '\\.')}`), denied)
    assert.equal(await orderState(id), state, `${denied}: nothing was written`)
    assert.equal(await db.accountingSyncLog.count({ where: { referenceId: id } }), 0)
  }
  deniedPermissions = new Set(['sales.refund'])
  await assert.rejects(() => actions.getReturnExchangeOffer(id), /missing permission sales\.refund/)
  await assert.rejects(() => actions.previewReturnExchange(id, [replacement(w, 'p2', 1)]).then((r) => { if (!r.success) throw new Error(String(r.error)); return r }), /missing permission sales\.refund/)
})

test('an internal caller cannot record an exchange', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { actions } = await loadDeps()
  const { INTERNAL_ACTION_BYPASS } = await import('@/lib/internal-action-bypass')
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const state = await orderState(id)
  const outcome = await actions.createRefund(id, await returnLines(w, id, 1), 'swap', undefined, { internalBypassToken: INTERNAL_ACTION_BYPASS, exchange: { lines: [replacement(w, 'p2', 1)] } })
  assert.equal(outcome.success, false)
  assert.match(String(outcome.error), /only be recorded by a person/)
  assert.equal(await orderState(id), state)
})

test('the returns analytics show the exchange as returned and replaced, not as a lost sale; a refund that came with an exchange cannot be deleted', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { db, actions, analytics, deletion } = await loadDeps()
  const swapped = await createConfirmed(w, [{ p: 'p1', qty: 3 }])
  const swap = await actions.createRefund(swapped, await returnLines(w, swapped, 1), 'swap', undefined, { exchange: { lines: [replacement(w, 'p2', 1)] } })
  assert.equal(swap.success, true, swap.error)
  const lost = await createConfirmed(w, [{ p: 'p1', qty: 3 }])
  const refund = await actions.createRefund(lost, await returnLines(w, lost, 2), 'gone')
  assert.equal(refund.success, true, refund.error)

  const day = new Date().toISOString().slice(0, 10)
  const report = await analytics.getReturnsAnalyticsReport({ dateFrom: day, dateTo: day })
  const rows = report.rows.filter((r) => r.productId === w.p1.id)
  const sum = (key: 'returnedQty' | 'exchangedQty') => rows.reduce((total, r) => total + Number(r[key]), 0)
  assert.equal(sum('returnedQty'), 3, 'one swapped unit and two lost units were returned')
  assert.equal(sum('exchangedQty'), 1, 'only the swapped unit is exchanged')
  const exchangedRow = rows.find((r) => Number(r.exchangedQty) === 1)!
  assert.equal(Number(exchangedRow.lostRefundValueBase), 0, 'the swap is not a lost sale')
  assert.ok(Number(exchangedRow.exchangedRefundValueBase) > 0)
  const lostRow = rows.find((r) => Number(r.exchangedQty) === 0)!
  assert.ok(Number(lostRow.lostRefundValueBase) > 0, 'a plain return is the refund that really left')
  assert.ok(Number(report.totals.replacementQty) >= 1)
  assert.match(report.notices.join(' '), /A return recorded with an exchange is shown as exchanged/)

  const refundId = (await db.salesOrderRefund.findFirstOrThrow({ where: { orderId: swapped } })).id
  const evaluation = await deletion.evaluateRefundDeletion(db as never, refundId)
  assert.ok(evaluation.refusals.some((r) => r.code === 'exchange_refund'), 'the exchange refund is not deletable')
  const plainId = (await db.salesOrderRefund.findFirstOrThrow({ where: { orderId: lost } })).id
  assert.ok(!(await deletion.evaluateRefundDeletion(db as never, plainId)).refusals.some((r) => r.code === 'exchange_refund'))
})
