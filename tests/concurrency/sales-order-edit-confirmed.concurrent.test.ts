import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv, uid } from './po-landed-fixtures'

/**
 * EDITING A CONFIRMED SALES ORDER, against a real database (owner ruling 2026-11-10: confirmed orders are editable after a WooCommerce-desync warning; after dispatch only addresses and notes).
 *
 *  1. A confirmed manual order is edited: lines and totals are recomputed by the create builder, the stock reservations are released and re-made (reservedQty == the allocation rows), the order keeps its identity and status, an audit
 *     entry and an activity entry are written, and the order's updatedAt moves.
 *  2. A Woo-linked order is refused without `acknowledgeShopDesync: true` (nothing is written; a truthy non-boolean does not count), and edited with it; a manual order needs no acknowledgement.
 *  3. An order with a posted invoice queues an update of it in the same transaction: with the producer-side hold ENFORCED nothing is queued (a shadow is recorded), without it a SALES_INVOICE_UPDATE row is PENDING and carries the
 *     new amounts. Nothing is sent either way (no outbound network in this tier).
 *  4. A dispatched order: its addresses and notes can be edited, its lines cannot; a partly shipped order counts as dispatched; a cancelled or delivered order refuses both.
 *  5. The edit is an amendment candidate of the warehouse push sweep (the order's updatedAt is newer than the link's push), and the candidate carries the NEW lines.
 *  6. The order lock: an edit waits for a holder of the order row lock and, after it, refuses because the order moved; edits racing the allocator leave reservedQty equal to the allocation rows.
 *  7. An edit that cannot re-reserve its stock, or cannot keep a paid order's total, changes nothing.
 * Mutations: skip the release (the line delete hits the allocation FK or the reservation doubles); skip the ack check; drop the updatedAt bump; queue the invoice update outside the transaction (arm 3 loses its atomicity).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

let permissionsAsked: string[] = []
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      permissionsAsked.push(permission)
      return { user: { id: 'test-user', role: 'ADMIN' } }
    },
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
const stockSyncs: string[][] = []
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async (ids: string[]) => { stockSyncs.push(ids) } } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

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

async function seedWorld(stock = 20): Promise<World> {
  loadEnv()
  const { db } = await import('@/lib/db')
  const tag = uid()
  await db.user.upsert({ where: { id: 'test-user' }, create: { id: 'test-user', email: 'test-user@example.invalid', name: 'test user', passwordHash: 'x' }, update: {} })
  const rate = await db.taxRate.create({ data: { name: `ZQEC Std 20 ${tag}`, rate: '0.2', usedFor: 'SALES', taxCategory: 'STANDARD', accountingTaxType: 'OUTPUT2', active: true }, select: { id: true } })
  // syncToStore so a shop-linked order can allocate from it; the only warehouse the orders name.
  const warehouse = await db.warehouse.create({ data: { code: `EC${tag.slice(0, 8)}`, name: `Edit confirmed ${tag}`, active: true, availableForSale: true, syncToStore: true }, select: { id: true } })
  const mk = async (k: string) => db.product.create({ data: { sku: `EC-${k}-${tag}`, name: `Edit confirmed ${k}`, type: 'SIMPLE', taxCategory: 'STANDARD', oversellAllowed: false }, select: { id: true, sku: true } })
  const p1 = await mk('P1')
  const p2 = await mk('P2')
  for (const p of [p1, p2]) await db.stockLevel.create({ data: { productId: p.id, warehouseId: warehouse.id, quantity: stock } })
  const world: World = {
    tag, warehouseId: warehouse.id, p1, p2, rateName: `ZQEC Std 20 ${tag}`, orderIds: [], settingKeys: [],
    teardown: async () => {
      const ids = world.orderIds
      await db.wmsOrderPushLink.deleteMany({ where: { orderId: { in: ids } } })
      await db.shoppingOrderLink.deleteMany({ where: { orderId: { in: ids } } })
      await db.accountingSyncLog.deleteMany({ where: { referenceId: { in: ids } } })
      await db.shipment.deleteMany({ where: { orderId: { in: ids } } })
      await db.activityLog.deleteMany({ where: { entityId: { in: ids } } })
      await db.salesOrderLine.deleteMany({ where: { orderId: { in: ids } } })
      await db.salesOrder.deleteMany({ where: { id: { in: ids } } })
      await db.stockLevel.deleteMany({ where: { warehouseId: warehouse.id } })
      await db.product.deleteMany({ where: { id: { in: [p1.id, p2.id] } } })
      await db.warehouse.deleteMany({ where: { id: warehouse.id } })
      await db.taxRate.deleteMany({ where: { id: rate.id } })
      await db.setting.deleteMany({ where: { key: { in: world.settingKeys } } })
      // The guard refuses a database holding users, so the acting user the mocked session names is removed again.
      await db.user.deleteMany({ where: { id: 'test-user' } })
    },
  }
  return world
}

type Line = { p: 'p1' | 'p2'; qty: number; price?: number }

function inputFor(w: World, lines: Line[], extra: Record<string, unknown> = {}) {
  return {
    customerName: 'Edit Confirmed Customer',
    customerEmail: 'ec@example.test',
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
    ...extra,
  }
}

async function versionOf(orderId: string): Promise<string> {
  const { db } = await import('@/lib/db')
  return (await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, select: { updatedAt: true } })).updatedAt.toISOString()
}

async function createConfirmed(w: World, lines: Line[], extra: Record<string, unknown> = {}): Promise<string> {
  const { createSalesOrder } = await import('@/app/actions/sales')
  const r = await createSalesOrder(inputFor(w, lines, extra) as never)
  assert.equal(r.success, true, r.error)
  w.orderIds.push(r.order!.id)
  return r.order!.id
}

/** reservedQty per product at the warehouse, and the allocation rows per product: the two must always agree. */
async function reservation(w: World, orderId: string) {
  const { db } = await import('@/lib/db')
  const levels = await db.stockLevel.findMany({ where: { warehouseId: w.warehouseId, productId: { in: [w.p1.id, w.p2.id] } } })
  const reserved = Object.fromEntries(levels.map((l) => [l.productId === w.p1.id ? 'p1' : 'p2', Number(l.reservedQty)]))
  const allocs = await db.orderAllocation.findMany({ where: { orderId } })
  // reservedQty is the warehouse's, shared by every order of the world: this order's share is what the other orders' allocation rows do not account for.
  const others = await db.orderAllocation.findMany({ where: { orderId: { in: w.orderIds.filter((o) => o !== orderId) } } })
  for (const o of others) reserved[o.productId === w.p1.id ? 'p1' : 'p2'] -= Number(o.qty)
  const allocated: Record<string, number> = { p1: 0, p2: 0 }
  for (const a of allocs) allocated[a.productId === w.p1.id ? 'p1' : 'p2'] += Number(a.qty)
  return { reserved: { p1: reserved.p1 ?? 0, p2: reserved.p2 ?? 0 }, allocated, rows: allocs.length }
}

async function snapshot(orderId: string) {
  const { db } = await import('@/lib/db')
  const so = await db.salesOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: { orderBy: { sku: 'asc' } } } })
  return JSON.stringify({ ...so, lines: so.lines.map((l) => ({ ...l, id: undefined })) })
}

test('a confirmed order is edited: lines and totals recomputed, stock released and re-reserved, audit and activity written, identity and status kept', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const before = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { status: true, orderNumber: true, totalForeign: true, updatedAt: true } })
  assert.equal(before.status, 'ALLOCATED')
  assert.deepEqual((await reservation(w, id)).reserved, { p1: 2, p2: 0 })

  permissionsAsked = []
  const edited = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 1 }, { p: 'p2', qty: 3, price: 4 }]) as never, await versionOf(id))
  assert.equal(edited.success, true, edited.error)
  assert.ok(permissionsAsked.includes('sales.create') && permissionsAsked.includes('sales.process'), 'a confirmed edit needs the permission to allocate as well')

  const after = await db.salesOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } })
  assert.equal(after.orderNumber, before.orderNumber, 'the order number is kept')
  assert.equal(after.status, 'ALLOCATED', 'the order is re-reserved, so it is ALLOCATED again')
  assert.equal(after.lines.length, 2)
  // net 1*10 + 3*4 + 5 shipping = 27, VAT 20% = 5.4, total 32.4: recomputed by the same builder create uses.
  assert.equal(Number(after.subtotalForeign), 22)
  assert.equal(Number(after.shippingForeign), 5)
  assert.equal(Number(after.totalForeign), 32.4)
  assert.ok(after.updatedAt > before.updatedAt, 'updatedAt moved: the order is an amendment candidate')
  assert.equal(after.editedInImsAt, null, 'a manual order is not marked edited-in-IMS (no shop copy to protect)')

  const r = await reservation(w, id)
  assert.deepEqual(r.reserved, { p1: 1, p2: 3 }, 'the old reservation was released and the new one made')
  assert.deepEqual(r.allocated, { p1: 1, p2: 3 }, 'reservedQty equals the allocation rows')

  const audit = await db.activityLog.findMany({ where: { entityId: id, action: 'confirmed_order_edited' } })
  assert.equal(audit.length, 1, 'one audit entry')
  assert.equal(audit[0].tag, 'audit')
  assert.equal(audit[0].userId, 'test-user')
  assert.equal(Number((audit[0].metadata as { previousTotalForeign: number }).previousTotalForeign), Number(before.totalForeign))
  assert.equal((await db.activityLog.count({ where: { entityId: id, action: 'updated' } })), 1, 'and one activity row')
  // Nothing outbound was produced (no accounting is configured in this world).
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: id } }), 0)
})

test('the desync acknowledgement: a Woo-linked order is refused without it and writes nothing; a manual order needs none', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const manual = await createConfirmed(w, [{ p: 'p1', qty: 1 }])
  const linked = await createConfirmed(w, [{ p: 'p1', qty: 1 }])
  await db.shoppingOrderLink.create({ data: { orderId: linked, connector: 'woocommerce', externalOrderId: `ec-${w.tag}` } })

  const before = await snapshot(linked)
  const reservationBefore = await reservation(w, linked)
  for (const [label, options] of [['absent', undefined], ['false', { acknowledgeShopDesync: false }], ['truthy string', { acknowledgeShopDesync: 'true' as unknown as boolean }], ['empty options', {}]] as const) {
    const refused = await updateSalesOrder(linked, inputFor(w, [{ p: 'p2', qty: 2 }]) as never, await versionOf(linked), options)
    assert.equal(refused.success, false, label)
    assert.match(String(refused.error), /WooCommerce keeps the original/, label)
    assert.equal(await snapshot(linked), before, `${label}: nothing was written`)
    assert.deepEqual(await reservation(w, linked), reservationBefore, `${label}: the reservation is untouched`)
  }

  const ok = await updateSalesOrder(linked, inputFor(w, [{ p: 'p2', qty: 2 }]) as never, await versionOf(linked), { acknowledgeShopDesync: true })
  assert.equal(ok.success, true, ok.error)
  const row = await db.salesOrder.findUniqueOrThrow({ where: { id: linked }, include: { lines: true } })
  assert.equal(row.lines[0].sku, w.p2.sku)
  assert.notEqual(row.editedInImsAt, null, 'a shop order edited in IMS is marked, so a later shop delivery does not overwrite the edit')
  const audit = await db.activityLog.findFirstOrThrow({ where: { entityId: linked, action: 'confirmed_order_edited' } })
  assert.equal((audit.metadata as { shopDesyncAcknowledged: boolean }).shopDesyncAcknowledged, true)

  const manualOk = await updateSalesOrder(manual, inputFor(w, [{ p: 'p2', qty: 1 }]) as never, await versionOf(manual))
  assert.equal(manualOk.success, true, manualOk.error)
  assert.equal((await db.salesOrder.findUniqueOrThrow({ where: { id: manual }, select: { editedInImsAt: true } })).editedInImsAt, null)
})

async function enableXeroInvoicing(w: World) {
  const { db } = await import('@/lib/db')
  const settings: Array<[string, string]> = [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true'], ['xero_sync_sales_invoice', 'submitted'], ['xero_sales_account', '200'], ['xero_shipping_account', '260']]
  for (const [key, value] of settings) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    w.settingKeys.push(key)
  }
}

test('a posted invoice: the edit queues an update of it in the same transaction; under the producer-side hold nothing is queued; nothing is sent', SKIP, async (t) => {
  process.env.SETTINGS_ENCRYPTION_KEY ??= 'a1'.repeat(32)
  const w = await seedWorld()
  t.after(async () => { delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS; await w.teardown() })
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  await enableXeroInvoicing(w)

  // A confirmed order whose invoice has posted (the column the Xero poster writes). Created BEFORE the accounting switches are read by the create path, so the create queued nothing we have to clean.
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  await db.accountingSyncLog.deleteMany({ where: { referenceId: id } })
  await db.salesOrder.update({ where: { id }, data: { accountingInvoiceId: `XERO-${w.tag}`, accountingInvoiceConnector: 'xero', invoiceNumber: `INV-${w.tag}` } })

  // HELD: the producer-side hold is enforced and no grant is given, so the update is recorded as a shadow and nothing is on the queue.
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = 'xero'
  const held = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 3 }]) as never, await versionOf(id))
  assert.equal(held.success, true, held.error)
  const heldRows = await db.accountingSyncLog.findMany({ where: { referenceId: id, type: 'SALES_INVOICE_UPDATE' } })
  assert.ok(heldRows.every((r) => r.status === 'CANCELLED' && /held on this installation/.test(String(r.errorMessage))), 'held: only a shadow record exists (CANCELLED, "Not sent by IMS"); no row is PENDING or claimable')
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: id, status: { in: ['PENDING', 'PROCESSING'] } } }), 0, 'held: nothing is queued')
  const shadow = await db.activityLog.findFirst({ where: { entityId: id, action: 'sales_invoice_update_shadowed' } })
  assert.ok(shadow, 'held: the helper recorded that the hold shadowed the update')
  // 3 x 10 + 5 shipping = 35 net, +20% VAT = 42: the edit itself committed.
  assert.equal(Number((await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { totalForeign: true } })).totalForeign), 42)

  // NOT HELD (legacy: the hold is not enforced for the destination): the update is queued PENDING in the edit's transaction, carrying the new amounts.
  delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
  const live = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 4 }]) as never, await versionOf(id))
  assert.equal(live.success, true, live.error)
  const rows = await db.accountingSyncLog.findMany({ where: { referenceId: id, type: 'SALES_INVOICE_UPDATE', status: 'PENDING' } })
  assert.equal(rows.length, 1, 'one update is queued')
  assert.equal(rows[0].status, 'PENDING', 'queued, not sent (the drain is a separate process and the tier has no network)')
  const payload = rows[0].payload as { accountingInvoiceId: string; lines: Array<{ quantity: number }> }
  assert.equal(payload.accountingInvoiceId, `XERO-${w.tag}`)
  assert.equal(payload.lines[0].quantity, 4)
})

test('an invoice that is queued but not posted refuses the edit and writes nothing', SKIP, async (t) => {
  process.env.SETTINGS_ENCRYPTION_KEY ??= 'a1'.repeat(32)
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const id = await createConfirmed(w, [{ p: 'p1', qty: 1 }])
  await db.accountingSyncLog.create({ data: { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: id, connector: 'xero', status: 'PENDING', payload: {} } as never })
  const before = await snapshot(id)
  const refused = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 2 }]) as never, await versionOf(id))
  assert.equal(refused.success, false)
  assert.match(String(refused.error), /queued for the accounting system but has not been posted yet/)
  assert.equal(await snapshot(id), before)
})

test('dispatched: addresses and notes can be edited, lines cannot; partly shipped counts as dispatched; cancelled and delivered refuse both', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { updateSalesOrder, updateSalesOrderAddressesAndNotes } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')

  const shipped = await createConfirmed(w, [{ p: 'p1', qty: 1 }])
  await db.shipment.create({ data: { orderId: shipped, warehouseId: w.warehouseId, status: 'SHIPPED' } })
  await db.salesOrder.update({ where: { id: shipped }, data: { status: 'SHIPPED' } })
  const reservationBefore = await reservation(w, shipped)
  const linesBefore = JSON.stringify((await db.salesOrderLine.findMany({ where: { orderId: shipped }, orderBy: { id: 'asc' } })))

  const lineEdit = await updateSalesOrder(shipped, inputFor(w, [{ p: 'p1', qty: 5 }]) as never, await versionOf(shipped))
  assert.equal(lineEdit.success, false)
  assert.match(String(lineEdit.error), /dispatched, so its lines can no longer be edited/)

  const addr = await updateSalesOrderAddressesAndNotes(shipped, { billingAddress: { line1: '9 New Bill Rd', country: 'GB' }, shippingAddress: { line1: '9 New Ship Rd', country: 'GB' }, notes: 'left with neighbour', internalNotes: 'check' }, await versionOf(shipped))
  assert.equal(addr.success, true, addr.error)
  const row = await db.salesOrder.findUniqueOrThrow({ where: { id: shipped } })
  assert.deepEqual(row.shippingAddress, { line1: '9 New Ship Rd', country: 'GB' })
  assert.equal(row.notes, 'left with neighbour')
  assert.equal(JSON.stringify((await db.salesOrderLine.findMany({ where: { orderId: shipped }, orderBy: { id: 'asc' } }))), linesBefore, 'the lines are untouched')
  assert.deepEqual(await reservation(w, shipped), reservationBefore, 'stock is untouched')
  assert.equal(await db.activityLog.count({ where: { entityId: shipped, action: 'order_addresses_edited', tag: 'audit' } }), 1, 'audited')

  // Partly shipped: not SHIPPED yet, but a shipment has left.
  const partly = await createConfirmed(w, [{ p: 'p1', qty: 1 }, { p: 'p2', qty: 1 }])
  await db.shipment.create({ data: { orderId: partly, warehouseId: w.warehouseId, status: 'SHIPPED' } })
  await db.salesOrder.update({ where: { id: partly }, data: { status: 'PICKING' } })
  const partlyLines = await updateSalesOrder(partly, inputFor(w, [{ p: 'p1', qty: 3 }]) as never, await versionOf(partly))
  assert.equal(partlyLines.success, false)
  assert.match(String(partlyLines.error), /dispatched/)
  assert.equal((await updateSalesOrderAddressesAndNotes(partly, { shippingAddress: { line1: 'x', country: 'GB' } }, await versionOf(partly))).success, true)

  // Cancelled and delivered: both refuse, with their own reason.
  for (const [status, reason] of [['CANCELLED', /cancelled/], ['DELIVERED', /closed/]] as const) {
    const id = await createConfirmed(w, [{ p: 'p1', qty: 1 }])
    await db.salesOrder.update({ where: { id }, data: { status } })
    const before = await snapshot(id)
    const lines = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 2 }]) as never, await versionOf(id))
    assert.equal(lines.success, false, status)
    assert.match(String(lines.error), reason, status)
    const addrs = await updateSalesOrderAddressesAndNotes(id, { shippingAddress: { line1: 'y', country: 'GB' } }, await versionOf(id))
    assert.equal(addrs.success, false, status)
    assert.match(String(addrs.error), reason, status)
    assert.equal(await snapshot(id), before, `${status}: nothing was written`)
  }
})

/** The warehouse's answer to the amend gate, supplied without a network: the real gate reads the link and asks the connector; here only the connector's answer is replaced. */
async function warehouseAnswers(t: { after: (fn: () => void) => void }, answer: { amendable: true } | { amendable: false; status: string } | 'throw'): Promise<unknown[][]> {
  const gate = await import('@/lib/domain/sales/order-edit-wms-gate')
  const real = gate.orderEditWmsGateDeps.current
  const asked: unknown[][] = []
  gate.orderEditWmsGateDeps.current = { ...real, probe: async (...args) => { asked.push(args); if (answer === 'throw') throw new Error('warehouse unreachable'); return answer } }
  t.after(() => { gate.orderEditWmsGateDeps.current = real })
  return asked
}

test('the edited order is a warehouse amendment candidate carrying the new lines; the edit writes no warehouse comment', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  await warehouseAnswers(t, { amendable: true })
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const { createPrismaWmsOrderPushPort, buildPushInput } = await import('@/lib/domain/wms/order-push-sweep')
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  // Pushed to the warehouse after the order was last touched: not due.
  await db.wmsOrderPushLink.create({ data: { orderId: id, connector: 'mintsoft', state: 'SYNCED', externalOrderId: `MS-${w.tag}`, pushedAt: new Date(Date.now() + 1000) } as never })
  const port = createPrismaWmsOrderPushPort()
  const dueBefore = (await port.updatableLinks('mintsoft', 500)).filter((l) => l.order.id === id)
  assert.equal(dueBefore.length, 0, 'nothing changed since the push')

  await new Promise((resolve) => setTimeout(resolve, 1200))
  const edited = await updateSalesOrder(id, inputFor(w, [{ p: 'p2', qty: 5 }]) as never, await versionOf(id))
  assert.equal(edited.success, true, edited.error)
  const due = (await port.updatableLinks('mintsoft', 500)).filter((l) => l.order.id === id)
  assert.equal(due.length, 1, 'the edit makes the order an amendment candidate (status PROCESSING/ALLOCATED, updatedAt after the push)')
  const input = buildPushInput({ ...due[0].order } as never, '301')
  const skus = JSON.stringify(input)
  assert.ok(skus.includes(w.p2.sku) && !skus.includes(w.p1.sku), 'the amendment is built from the new lines')
})

test('the order lock: an edit waits for a holder of the order row lock and then refuses because the order moved; edits racing the allocator keep reservedQty equal to the allocation rows', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const { autoAllocateOrder } = await import('@/app/actions/allocation')
  const { lockSalesOrder } = await import('@/lib/domain/sales/allocation-service')
  const { db } = await import('@/lib/db')

  // (a) the holder keeps the lock, changes the order (notes), and only then releases it.
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const version = await versionOf(id)
  let editSettledWhileHeld = false
  let editPromise: Promise<{ success: boolean; error?: string }> | null = null
  await db.$transaction(async (tx) => {
    await lockSalesOrder(tx, id)
    editPromise = updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 3 }]) as never, version).then((r) => { editSettledWhileHeld = true; return r })
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(editSettledWhileHeld, false, 'the edit is parked on the order lock')
    await tx.salesOrder.update({ where: { id }, data: { notes: 'changed by the holder' } })
  })
  const stale = await editPromise!
  assert.equal(stale.success, false)
  assert.match(String(stale.error), /changed by someone else/)
  assert.deepEqual((await reservation(w, id)).reserved, { p1: 2, p2: 0 }, 'the refused edit left the reservation alone')

  // (b) edits racing the allocator, each round. Whatever order they interleave in, the reservation equals the rows and the order holds exactly its lines' quantity.
  const race = await createConfirmed(w, [{ p: 'p1', qty: 1 }])
  for (let round = 1; round <= 6; round += 1) {
    const qty = round
    const [edit] = await Promise.all([
      updateSalesOrder(race, inputFor(w, [{ p: round % 2 ? 'p1' : 'p2', qty }]) as never, await versionOf(race)),
      autoAllocateOrder(race),
      autoAllocateOrder(race),
    ])
    // The edit may lose its version race to nothing here (the allocator does not bump updatedAt when it changes nothing); if it did lose, the next round still starts from a consistent order.
    assert.ok(edit.success || /changed by someone else/.test(String(edit.error)), edit.error)
    const r = await reservation(w, race)
    assert.deepEqual(r.reserved, r.allocated, `round ${round}: reservedQty equals the allocation rows`)
    const lines = await db.salesOrderLine.findMany({ where: { orderId: race } })
    assert.equal(lines.reduce((a, l) => a + Number(l.qty), 0), r.allocated.p1 + r.allocated.p2, `round ${round}: every line is reserved in full`)
  }
})

test('an edit that cannot re-reserve its stock changes nothing; a paid order keeps its total', SKIP, async (t) => {
  const w = await seedWorld(3)
  t.after(() => w.teardown())
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  const before = await snapshot(id)
  const reservationBefore = await reservation(w, id)
  const tooMany = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 50 }]) as never, await versionOf(id))
  // p1 is not oversellable: 50 cannot be reserved from 3, so the re-reservation fails and the whole edit (the release, the new lines) is rolled back.
  assert.equal(tooMany.success, false)
  assert.match(String(tooMany.error), /nothing was changed/)
  assert.equal(await snapshot(id), before, 'nothing was written')
  assert.deepEqual(await reservation(w, id), reservationBefore, 'the reservation is back as it was')

  const paid = await createConfirmed(w, [{ p: 'p1', qty: 1 }])
  await db.salesOrder.update({ where: { id: paid }, data: { paidAt: new Date(), unregisteredPaidAt: new Date() } })
  const paidBefore = await snapshot(paid)
  const dearer = await updateSalesOrder(paid, inputFor(w, [{ p: 'p1', qty: 1, price: 99 }]) as never, await versionOf(paid))
  assert.equal(dearer.success, false)
  assert.match(String(dearer.error), /leave its total/)
  assert.equal(await snapshot(paid), paidBefore)
  // Same total, different lines: allowed (a swap at the same price).
  const swap = await updateSalesOrder(paid, inputFor(w, [{ p: 'p2', qty: 1 }]) as never, await versionOf(paid))
  assert.equal(swap.success, true, swap.error)
})


// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// CODEX ROUND 1 (PR 975): Woo line identity, the invoice update, the warehouse gate.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

test('a Woo order keeps the storefront line id of every line the edit continues; only a line added in IMS has none; a later storefront refund of a removed line is quarantined, one of a kept line is linked', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const { syncWcRefund } = await import('@/lib/connectors/woocommerce/sync/refund-sync')
  const { db } = await import('@/lib/db')
  const id = await createConfirmed(w, [{ p: 'p1', qty: 3 }, { p: 'p2', qty: 2 }])
  await db.shoppingOrderLink.create({ data: { orderId: id, connector: 'woocommerce', externalOrderId: `${900000 + Math.floor(Math.random() * 99999)}` } })
  const saved = await db.salesOrderLine.findMany({ where: { orderId: id } })
  const l1 = saved.find((l) => l.productId === w.p1.id)!
  const l2 = saved.find((l) => l.productId === w.p2.id)!
  const woo1 = 710000 + Math.floor(Math.random() * 9999)
  await db.salesOrderLine.update({ where: { id: l1.id }, data: { externalLineItemId: woo1 } })
  await db.salesOrderLine.update({ where: { id: l2.id }, data: { externalLineItemId: woo1 + 1 } })
  const link = await db.shoppingOrderLink.findFirstOrThrow({ where: { orderId: id } })

  // The edit changes p1's quantity and REMOVES p2.
  const lineA = { ...inputFor(w, [{ p: 'p1', qty: 4 }]).lines[0], orderLineId: l1.id }
  const edited = await updateSalesOrder(id, { ...inputFor(w, [{ p: 'p1', qty: 4 }]), lines: [lineA] } as never, await versionOf(id), { acknowledgeShopDesync: true })
  assert.equal(edited.success, true, edited.error)
  const after = await db.salesOrderLine.findMany({ where: { orderId: id } })
  assert.equal(after.length, 1)
  assert.equal(after[0].id, l1.id, 'the continued line keeps its row')
  assert.equal(after[0].externalLineItemId, woo1, 'and its storefront line item id')
  assert.equal(Number(after[0].qty), 4, 'with the edited quantity')

  // A line added by the edit has no storefront id; a line without an orderLineId continues the saved line of its product (the id is not lost because a client omitted it).
  const added = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 5 }, { p: 'p2', qty: 1 }]) as never, await versionOf(id), { acknowledgeShopDesync: true })
  assert.equal(added.success, true, added.error)
  const after2 = await db.salesOrderLine.findMany({ where: { orderId: id } })
  assert.equal(after2.find((l) => l.productId === w.p1.id)!.externalLineItemId, woo1, 'id kept without a client-supplied orderLineId')
  assert.equal(after2.find((l) => l.productId === w.p2.id)!.externalLineItemId, null, 'a line added in IMS has no storefront id (the removed line\'s id is not reused)')
  assert.equal(after2.find((l) => l.productId === w.p2.id)!.id === l2.id, false)

  // LATER STOREFRONT REFUNDS, through the same per-refund path syncRefundsForOrder runs. The stock and the refund rows are the evidence of "no mis-match, no double cost reversal".
  const stockBefore = JSON.stringify(await db.stockLevel.findMany({ where: { warehouseId: w.warehouseId }, orderBy: { productId: 'asc' } }))
  const refundLine = (orderItemId: number, name: string) => ({ id: orderItemId + 1000, name, product_id: 1, variation_id: 0, quantity: -1, tax_class: '', subtotal: '-10.00', subtotal_tax: '-2.00', total: '-10.00', total_tax: '-2.00', taxes: [], meta_data: [{ id: 1, key: '_refunded_item_id', value: String(orderItemId) }], sku: '', price: 10 })
  const wcRefund = (refundId: number, lineItems: unknown[]) => ({ id: refundId, date_created: '2026-11-17T00:00:00', date_created_gmt: '2026-11-17T00:00:00', amount: '12.00', reason: 'r', refunded_by: 1, refunded_payment: true, meta_data: [], line_items: lineItems }) as never
  const created: unknown[][] = []
  const fakeCreate = (async (...args: unknown[]) => { created.push(args); return { success: true } }) as never

  const removedRefundId = 810000 + Math.floor(Math.random() * 9999)
  const removed = await syncWcRefund(Number(link.externalOrderId), wcRefund(removedRefundId, [refundLine(woo1 + 1, 'Desc p2')]), { createRefund: fakeCreate })
  assert.equal(removed.outcome, 'quarantined-refusal', 'a refund of a line the edit removed is not written unlinked')
  assert.match(String(removed.error), /no longer has because it was edited in IMS/)
  assert.equal(created.length, 0, 'no refund was created, so no stock return and no cost reversal can be booked (let alone twice)')
  assert.equal(await db.salesOrderRefund.count({ where: { orderId: id } }), 0)
  assert.equal(JSON.stringify(await db.stockLevel.findMany({ where: { warehouseId: w.warehouseId }, orderBy: { productId: 'asc' } })), stockBefore, 'stock untouched')
  // Delivered again, it is the same answer (a quarantined park is not re-opened, nothing is written twice).
  const again = await syncWcRefund(Number(link.externalOrderId), wcRefund(removedRefundId, [refundLine(woo1 + 1, 'Desc p2')]), { createRefund: fakeCreate })
  assert.notEqual(again.outcome, 'applied')
  assert.equal(created.length, 0)

  const keptRefundId = removedRefundId + 1
  const kept = await syncWcRefund(Number(link.externalOrderId), wcRefund(keptRefundId, [refundLine(woo1, 'Desc p1')]), { createRefund: fakeCreate })
  assert.notEqual(kept.outcome, 'quarantined-refusal', String(kept.error))
  assert.equal(created.length, 1, 'a refund of a continued line is written')
  const [, lines] = created[0] as [string, Array<{ lineId?: string; productId: string | null; qty: number }>]
  assert.equal(lines[0].lineId, l1.id, 'linked to the continued line')
  assert.equal(lines[0].productId, w.p1.id, 'with its product, so the stock return and the cost reversal are made once, for the right goods')
  await db.shoppingSyncLog.deleteMany({ where: { entityId: id } })
})

test('an invoice update that cannot be queued (the posted invoice belongs to another connector than the active one) refuses the edit and rolls everything back', SKIP, async (t) => {
  process.env.SETTINGS_ENCRYPTION_KEY ??= 'a1'.repeat(32)
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { updateSalesOrder } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  await enableXeroInvoicing(w)
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  await db.accountingSyncLog.deleteMany({ where: { referenceId: id } })
  // The invoice was posted by ANOTHER accounting connector: the update helper declines without asking the queue, which used to commit the edit with the invoice left at the old lines.
  await db.salesOrder.update({ where: { id }, data: { accountingInvoiceId: `QBO-${w.tag}`, accountingInvoiceConnector: 'quickbooks', invoiceNumber: `INV-${w.tag}` } })
  const before = await snapshot(id)
  const reservationBefore = await reservation(w, id)
  const refused = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 3 }]) as never, await versionOf(id))
  assert.equal(refused.success, false, 'the edit does not report success')
  assert.match(String(refused.error), /out of step with its total, so nothing was changed/)
  assert.match(String(refused.error), /not attempted/)
  assert.equal(await snapshot(id), before, 'the order, its lines and its totals are as they were')
  assert.deepEqual(await reservation(w, id), reservationBefore, 'the reservation is as it was')
  assert.equal(await db.accountingSyncLog.count({ where: { referenceId: id, type: 'SALES_INVOICE_UPDATE' } }), 0)
  assert.equal(await db.activityLog.count({ where: { entityId: id, action: 'confirmed_order_edited' } }), 0, 'no audit entry for an edit that did not happen')
})

test('the warehouse gate: an order pushed to the warehouse is edited only while the warehouse order is amendable; past NEW or unknown refuses lines and addresses, and writes nothing', SKIP, async (t) => {
  const w = await seedWorld()
  t.after(() => w.teardown())
  const { updateSalesOrder, updateSalesOrderAddressesAndNotes } = await import('@/app/actions/sales')
  const { db } = await import('@/lib/db')
  const id = await createConfirmed(w, [{ p: 'p1', qty: 2 }])
  await db.wmsOrderPushLink.create({ data: { orderId: id, connector: 'mintsoft', state: 'SYNCED', externalOrderId: `MS-${w.tag}`, pushedAt: new Date() } as never })
  const before = await snapshot(id)
  const reservationBefore = await reservation(w, id)

  for (const [label, answer] of [['past NEW', { amendable: false, status: 'NOT_NEW' }], ['unreadable', 'throw']] as const) {
    const asked = await warehouseAnswers(t, answer as never)
    const lines = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 5 }]) as never, await versionOf(id))
    assert.equal(lines.success, false, label)
    assert.match(String(lines.error), /^AMENDMENT_NOT_APPLIED:/, label)
    const addr = await updateSalesOrderAddressesAndNotes(id, { shippingAddress: { line1: 'x', country: 'GB' }, notes: 'late' }, await versionOf(id))
    assert.equal(addr.success, false, label)
    assert.match(String(addr.error), /^AMENDMENT_NOT_APPLIED:/, label)
    assert.deepEqual(asked.map((a) => a.slice(0, 2)), [['mintsoft', `MS-${w.tag}`], ['mintsoft', `MS-${w.tag}`]], `${label}: the warehouse was asked about its order`)
    assert.equal(await snapshot(id), before, `${label}: nothing was written`)
    assert.deepEqual(await reservation(w, id), reservationBefore, `${label}: the reservation is untouched`)
  }

  // Amendable: the edit goes through.
  await warehouseAnswers(t, { amendable: true })
  const ok = await updateSalesOrder(id, inputFor(w, [{ p: 'p1', qty: 5 }]) as never, await versionOf(id))
  assert.equal(ok.success, true, ok.error)
  assert.equal((await updateSalesOrderAddressesAndNotes(id, { notes: 'on time' }, await versionOf(id))).success, true)

  // A dispatched order is not amended by the warehouse: its address edit does not ask the gate (and is allowed even though the warehouse is past NEW).
  const shipped = await createConfirmed(w, [{ p: 'p2', qty: 1 }])
  await db.wmsOrderPushLink.create({ data: { orderId: shipped, connector: 'mintsoft', state: 'SYNCED', externalOrderId: `MS2-${w.tag}`, pushedAt: new Date() } as never })
  await db.shipment.create({ data: { orderId: shipped, warehouseId: w.warehouseId, status: 'SHIPPED' } })
  await db.salesOrder.update({ where: { id: shipped }, data: { status: 'SHIPPED' } })
  const asked = await warehouseAnswers(t, { amendable: false, status: 'NOT_NEW' })
  const addr = await updateSalesOrderAddressesAndNotes(shipped, { shippingAddress: { line1: 'after dispatch', country: 'GB' } }, await versionOf(shipped))
  assert.equal(addr.success, true, addr.error)
  assert.equal(asked.length, 0)
})
