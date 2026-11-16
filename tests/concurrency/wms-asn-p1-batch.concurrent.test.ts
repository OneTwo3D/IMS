import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import { liveMintsoftBookedInAsnRef } from '@/tests/helpers/live-mintsoft-asn-ref'

/**
 * o3d-hqvrp.117 / .118 / .119 against a real PostgreSQL:
 *   .117 a short-delivered PO ASN can be closed, which releases the PO line for manual receipt;
 *   .118 units despatched at the WMS and not yet SHIPPED in IMS are counted as in flight;
 *   .119 an approved over-receipt receives the FULL booked quantity (stock, cost layer, PO line, ASN).
 * No network: the remote ASN is handed to the book-in as a value.
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
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

const UNIT_COST = 7

function uniqueTag(label: string): string {
  const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36).padStart(4, '0')}`.toUpperCase()
  return `P1ASN${label}${process.pid}${uid}`.replace(/[^A-Z0-9]/g, '').slice(0, 28)
}

async function seed(label: string, qty: number, opts: { asnStatus?: 'OPEN' | 'PARTIALLY_BOOKED_IN'; received?: number } = {}) {
  const { db } = await import('@/lib/db')
  const tag = uniqueTag(label)
  const received = opts.received ?? 0
  const total = qty * UNIT_COST
  const product = await db.product.create({ data: { sku: tag, name: tag, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: tag.slice(-10), name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  await db.stockLevel.create({ data: { productId: product.id, warehouseId: warehouse.id, quantity: String(received), reservedQty: '0' } })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const po = await db.purchaseOrder.create({
    data: {
      reference: tag, supplierId: supplier.id, status: received > 0 ? 'PARTIALLY_RECEIVED' : 'PO_SENT', currency: 'GBP', fxRateToBase: '1',
      subtotalForeign: total, subtotalBase: total, totalForeign: total, totalBase: total, destinationWarehouseId: warehouse.id,
      lines: { create: [{
        productId: product.id, qty: `${qty}.0000`, qtyReceived: `${received}.0000`,
        unitCostForeign: `${UNIT_COST}.000000`, unitCostBase: `${UNIT_COST}.000000`, landedUnitCostBase: `${UNIT_COST}.000000`,
        totalForeign: total, totalBase: total,
      }] },
    },
    select: { id: true, lines: { select: { id: true } } },
  })
  const asn = await db.wmsAsnMap.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: a test fixture row, not a core flow branch
      externalAsnId: tag, sourceType: 'PURCHASE_ORDER', sourceId: po.id, warehouseId: warehouse.id,
      status: opts.asnStatus ?? 'OPEN',
      lines: { create: [{
        externalAsnLineId: `${tag}-1`, sourceType: 'PURCHASE_ORDER_LINE', sourceLineId: po.lines[0]!.id,
        productId: product.id, sku: tag, expectedQty: `${qty}.0000`,
        lastProcessedReceivedQty: `${received}.0000`, qtyAccountedViaReceipt: `${received}.0000`,
      }] },
    },
    select: { id: true, lines: { select: { id: true, externalAsnLineId: true } } },
  })
  if (received > 0) {
    await db.costLayer.create({
      data: { productId: product.id, warehouseId: warehouse.id, receivedQty: `${received}.000000`, remainingQty: `${received}.000000`, unitCostBase: `${UNIT_COST}.000000`, poLineId: po.lines[0]!.id, isOpeningStock: false },
    })
  }
  return { tag, qty, productId: product.id, warehouseId: warehouse.id, poId: po.id, poLineId: po.lines[0]!.id, asnMapId: asn.id, externalAsnLineId: asn.lines[0]!.externalAsnLineId }
}

async function newEvent(tag: string) {
  const { db } = await import('@/lib/db')
  return db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: a test fixture row
      externalEventId: `${tag}-evt-${Math.random().toString(36).slice(2, 10)}`, externalAsnId: tag, payload: { asnId: tag },
    },
    select: { id: true },
  })
}

async function runBookedIn(s: { tag: string; qty: number; externalAsnLineId: string; poLineId: string }, bookedQty: number, approveReview = false, eventId?: string) {
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const id = eventId ?? (await newEvent(s.tag)).id
  const remote = liveMintsoftBookedInAsnRef({
    externalAsnId: s.tag, externalLineId: s.externalAsnLineId, sourceLineId: s.poLineId, sku: s.tag, expectedQty: s.qty, bookedQty,
  })
  const result = await processBookedInEvent(id, { approveReview, fetchRemoteAsn: async () => ({ ...remote, status: 'RECEIVED', raw: null }) })
  return { result, eventId: id }
}

test('o3d-hqvrp.119: an APPROVED over-receipt books the full quantity: stock, cost layer, PO line, closed ASN', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const s = await seed('OVR', 10)

  // Unapproved: held for review, nothing booked, and the review shows the quantity approval will book.
  const first = await runBookedIn(s, 12)
  const held = first.result as { status: string; reviewRequired?: boolean; dryRun?: { lines: Array<{ stockQtyToAdd: number }>; warnings: string[] } }
  assert.equal(held.status, 'requires_review', JSON.stringify(first.result))
  assert.ok(held.dryRun?.warnings.includes('received_over_expected'))
  assert.equal(held.dryRun?.lines[0]?.stockQtyToAdd, 12, 'the review must show what approval will book, not the clamped figure')
  assert.equal(await db.purchaseReceipt.count({ where: { poId: s.poId } }), 0)

  // Approved: the FULL 12.
  const approved = await runBookedIn(s, 12, true, first.eventId)
  assert.equal(approved.result.status, 'processed', JSON.stringify(approved.result))

  const level = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: s.productId, warehouseId: s.warehouseId } } })
  assert.equal(Number(level.quantity), 12, 'stock must hold every unit the warehouse booked in')
  const layers = await db.costLayer.findMany({ where: { poLineId: s.poLineId } })
  assert.equal(layers.length, 1)
  assert.equal(Number(layers[0]!.receivedQty), 12)
  assert.equal(Number(layers[0]!.unitCostBase), UNIT_COST, 'the excess is costed at the PO unit cost')
  const movements = await db.stockMovement.findMany({ where: { type: 'PURCHASE_RECEIPT', productId: s.productId } })
  assert.equal(movements.length, 1)
  assert.equal(Number(movements[0]!.qty), 12)
  assert.equal(Number(movements[0]!.totalValueBase), 12 * UNIT_COST)
  const line = await db.purchaseOrderLine.findUniqueOrThrow({ where: { id: s.poLineId } })
  assert.equal(Number(line.qtyReceived), 12, 'PO line accounting counts every received unit')
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: s.poId } })
  assert.equal(po.status, 'RECEIVED')
  const asnLine = await db.wmsAsnLineMap.findFirstOrThrow({ where: { asnMapId: s.asnMapId } })
  assert.equal(Number(asnLine.lastProcessedReceivedQty), 12)
  const asn = await db.wmsAsnMap.findUniqueOrThrow({ where: { id: s.asnMapId } })
  assert.equal(asn.status, 'BOOKED_IN')
  assert.notEqual(asn.closedAt, null)

  // A re-check of the same ASN reads the same 12: nothing more is booked and it is not held for review again.
  const again = await runBookedIn(s, 12)
  assert.equal(again.result.status, 'processed', JSON.stringify(again.result))
  const levelAfter = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: s.productId, warehouseId: s.warehouseId } } })
  assert.equal(Number(levelAfter.quantity), 12)
  assert.equal(await db.costLayer.count({ where: { poLineId: s.poLineId } }), 1)
})

test('o3d-hqvrp.119: a delivery at or under the expected quantity is unchanged by the over-receipt fix', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const s = await seed('EXACT', 10)
  const r = await runBookedIn(s, 10)
  assert.equal(r.result.status, 'processed', JSON.stringify(r.result))
  const level = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: s.productId, warehouseId: s.warehouseId } } })
  assert.equal(Number(level.quantity), 10)
  const asn = await db.wmsAsnMap.findUniqueOrThrow({ where: { id: s.asnMapId } })
  assert.equal(asn.status, 'BOOKED_IN')
})

test('o3d-hqvrp.117: a short-delivered ASN is closed by the operator action and its PO line is released', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { closeMintsoftAsnShort } = await import('@/app/actions/mintsoft-sync')
  const { findLiveAsnBlocks } = await import('@/lib/domain/wms/po-receipt-asn-guard')
  const { loadPurchaseOrderLineOutstandingQty } = await import('@/lib/domain/inventory/po-line-landed-quantity')
  const s = await seed('SHORT', 10, { asnStatus: 'PARTIALLY_BOOKED_IN', received: 6 })

  assert.equal((await findLiveAsnBlocks(db, [s.poLineId])).length, 1, 'PRECONDITION: the open partial ASN blocks the PO line')

  const noReason = await closeMintsoftAsnShort(s.tag, '')
  assert.equal(noReason.success, false)

  const closed = await closeMintsoftAsnShort(s.tag, 'supplier confirmed the other 4 will not ship')
  assert.equal(closed.success, true, JSON.stringify(closed))

  const asn = await db.wmsAsnMap.findUniqueOrThrow({ where: { id: s.asnMapId } })
  assert.notEqual(asn.closedAt, null)
  assert.equal((await findLiveAsnBlocks(db, [s.poLineId])).length, 0, 'manual receipt is no longer blocked')
  const outstanding = await loadPurchaseOrderLineOutstandingQty(db, [{ id: s.poLineId, qty: 10, qtyReceived: 6, poStatus: 'PARTIALLY_RECEIVED' }])
  assert.equal(outstanding.get(s.poLineId)!.qtyNumber, 4, 'the undelivered 4 are outstanding again, for a manual receipt or a new ASN')
  const level = await db.stockLevel.findUniqueOrThrow({ where: { productId_warehouseId: { productId: s.productId, warehouseId: s.warehouseId } } })
  assert.equal(Number(level.quantity), 6, 'closing short books and writes off nothing')
  assert.equal(await db.activityLog.count({ where: { entityId: s.poId, action: 'mintsoft_asn_closed_short' } }), 1)

  const twice = await closeMintsoftAsnShort(s.tag, 'again')
  assert.equal(twice.success, false)
  assert.match(String(twice.error), /already closed/)
})

test('o3d-hqvrp.117: close short refuses an OPEN ASN and an ASN with an unprocessed booked-in event', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { closeMintsoftAsnShort } = await import('@/app/actions/mintsoft-sync')
  const open = await seed('OPENASN', 10)
  const refusedOpen = await closeMintsoftAsnShort(open.tag, 'no delivery yet')
  assert.equal(refusedOpen.success, false)
  assert.match(String(refusedOpen.error), /partially booked-in/)

  const partial = await seed('EVT', 10, { asnStatus: 'PARTIALLY_BOOKED_IN', received: 6 })
  await newEvent(partial.tag) // PENDING: a booking the warehouse reported and IMS has not applied
  const refusedEvent = await closeMintsoftAsnShort(partial.tag, 'closing under an unprocessed event')
  assert.equal(refusedEvent.success, false)
  assert.match(String(refusedEvent.error), /not yet processed/)
  const asn = await db.wmsAsnMap.findUniqueOrThrow({ where: { id: partial.asnMapId } })
  assert.equal(asn.closedAt, null)
})

test('o3d-hqvrp.118: a live allocation is in flight unless its status snapshot is FRESH and not despatched', SKIP, async () => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { loadInFlightDispatch } = await import('@/lib/connectors/mintsoft/sync/in-flight-dispatch')
  const tag = uniqueTag('INFL')
  const product = await db.product.create({ data: { sku: tag, name: tag, type: 'SIMPLE' }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: tag.slice(-10), name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const now = new Date()
  const runStartedAt = new Date(now.getTime() - 60_000)
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000)

  async function order(suffix: string, qty: number, opts: { imsStatus?: 'PACKING' | 'SHIPPED'; wms?: { status: string; fetchedAt: Date }; deadLettered?: boolean; pushState?: 'SYNCED' | 'CANCELLED' }) {
    const id = `${tag}${suffix}`
    await db.salesOrder.create({
      data: {
        id, orderNumber: `IMSTEST-${id}`, status: opts.imsStatus ?? 'PACKING', currency: 'GBP', subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
        lines: { create: [{ id: `${id}L`, productId: product.id, sku: tag, description: tag, qty, unitPriceForeign: 1, unitPriceBase: 1, totalForeign: qty, totalBase: qty, cogsBase: 0 }] },
      },
    })
    await db.orderAllocation.create({ data: { orderId: id, lineId: `${id}L`, productId: product.id, warehouseId: warehouse.id, qty: String(qty) } })
    await db.wmsOrderPushLink.create({
      data: {
        orderId: id, connector: 'mintsoft', state: opts.pushState ?? 'SYNCED', externalOrderId: `ext-${id}`, externalOrderNumber: `MS-${id}`,
        ...(opts.deadLettered ? { dispatchDeadLetteredAt: new Date() } : {}),
      },
    })
    if (opts.wms) {
      await db.wmsOrderStatusSnapshot.create({
        data: { orderId: id, connector: 'mintsoft', connectorLabel: 'Mintsoft', externalOrderId: `ext-${id}`, externalOrderNumber: `MS-${id}`, status: opts.wms.status, statusLabel: opts.wms.status, fetchedAt: opts.wms.fetchedAt },
      })
    }
  }
  const load = (client: typeof db = db) => loadInFlightDispatch(client, { productId: product.id, warehouseId: warehouse.id, now, runStartedAt })

  assert.equal((await load()).qty, 0, 'no allocation, nothing in flight')
  await order('a', 2, { wms: { status: 'NEW', fetchedAt: minutesAgo(5) } })
  assert.equal((await load()).qty, 0, 'FRESH non-despatched snapshot: not held')
  await order('b', 3, { wms: { status: 'NEW', fetchedAt: minutesAgo(180) } })
  const stale = await load()
  assert.equal(stale.qty, 3, 'STALE snapshot with a live allocation: held')
  assert.deepEqual(stale.holds.map((h) => h.reason), ['status_snapshot_stale'])
  assert.match(stale.holds[0]!.orderNumber, /IMSTEST-/, 'the order that made it hold is named')
  await order('c', 4, {})
  assert.equal((await load()).qty, 7, 'MISSING snapshot: held')
  await order('d', 5, { wms: { status: 'DESPATCHED', fetchedAt: minutesAgo(2) } })
  assert.equal((await load()).qty, 12, 'FRESH despatched snapshot: held')
  await order('e', 6, { deadLettered: true, wms: { status: 'NEW', fetchedAt: minutesAgo(1) } })
  assert.equal((await load()).qty, 18, 'dispatch given up on: held')
  await order('f', 7, { imsStatus: 'SHIPPED', wms: { status: 'DESPATCHED', fetchedAt: minutesAgo(2) } })
  await order('g', 8, { pushState: 'CANCELLED' })
  assert.equal((await load()).qty, 18, 'shipped in IMS or link cancelled: not held')
  assert.equal((await loadInFlightDispatch(db, { productId: product.id, warehouseId: 'other-warehouse', now, runStartedAt })).qty, 0)
  // newer than the stock reading counts as fresh even beyond the window
  const recentRun = new Date(now.getTime() - 4 * 3600_000)
  await db.wmsOrderStatusSnapshot.update({ where: { orderId: `${tag}b` }, data: { fetchedAt: new Date(now.getTime() - 3 * 3600_000) } })
  const viaRun = await loadInFlightDispatch(db, { productId: product.id, warehouseId: warehouse.id, now, runStartedAt: recentRun })
  assert.equal(viaRun.holds.some((h) => h.orderNumber.endsWith(`${tag}b`)), false, 'a snapshot newer than the stock reading is fresh')
  // and it runs on a transaction client, which is how the decision point re-checks it
  assert.equal((await db.$transaction((tx) => load(tx as unknown as typeof db))).qty, 18)
})
