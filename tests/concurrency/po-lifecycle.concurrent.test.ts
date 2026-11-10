import './scratch-database-setup' // FIRST: refuses to load unless the scratch database was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as fixtures from './po-landed-fixtures'
import type { SeededPo } from './po-landed-fixtures'

/**
 * PO LIFECYCLE: edit, close and cancel at every stage from RFQ to part-received, over a real PostgreSQL.
 *
 * Every arm drives the REAL `updatePurchaseOrder`, `advancePoStatus`, `cancelPurchaseOrder`, `receivePurchaseOrder` and
 * `returnPurchaseOrder`; orders come from the real `createPurchaseOrder`. Nothing contacts Xero, WooCommerce or Mintsoft (the accounting
 * outbox rows are only counted). Races are ORDERED, never slept: a raw session holds the `purchase_orders` row, the first action is started
 * and seen blocked behind it, then the second, then the row is released, so the lock queue (FIFO) decides which wins and the
 * test decides it. Fixture identity is randomUUID entropy; the rows stay (CI shares one database).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

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
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

const { loadEnv, enableStockReceiptPosting, seedPo, addAsn, receive, snapshotOf } = fixtures

test.before(async () => {
  if (!RUN) return
  loadEnv()
  await enableStockReceiptPosting()
})

type RawClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
}

async function rawSession(): Promise<RawClient> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  return client as unknown as RawClient
}

/**
 * Wait until `count` backends in this database are waiting on a purchase_orders row lock. NOT "blocked by the holder": the
 * second waiter queues on the first waiter's tuple lock, so only the first is blocked by the holder's pid.
 */
async function waitForBlocked(probe: RawClient, _holderPid: number, count: number) {
  const deadline = Date.now() + 20_000
  for (;;) {
    const { rows } = await probe.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
          AND a.wait_event_type = 'Lock' AND a.query ILIKE '%purchase_orders%'`,
    )
    if (Number(rows[0]!.n) >= count) return
    if (Date.now() > deadline) throw new Error(`fewer than ${count} backends blocked on the purchase_orders row within the budget`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Start `first`, see it blocked behind the held PO row, start `second`, see it blocked, release. `first` wins the lock. */
async function raced<A, B>(poId: string, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const holder = await rawSession()
  const probe = await rawSession()
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId])
    const { rows } = await holder.query('SELECT pg_backend_pid()::int AS pid')
    const holderPid = Number(rows[0]!.pid)
    const a = first()
    await waitForBlocked(probe, holderPid, 1)
    const b = second()
    await waitForBlocked(probe, holderPid, 2)
    await holder.query('COMMIT')
    return [await a, await b]
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    await Promise.all([holder.end(), probe.end()])
  }
}

async function actions() {
  const mod = await import('@/app/actions/purchase-orders')
  return { ...mod }
}

async function setStatus(poId: string, status: string) {
  const { db } = await import('@/lib/db')
  await db.purchaseOrder.update({ where: { id: poId }, data: { status: status as never } })
}

async function poState(po: SeededPo) {
  const { db } = await import('@/lib/db')
  const [row, stock, layers, reversals, nonReceiptJournals] = await Promise.all([
    db.purchaseOrder.findUniqueOrThrow({
      where: { id: po.poId },
      select: { status: true, lines: { select: { id: true, qty: true, qtyReceived: true, unitCostForeign: true }, orderBy: { id: 'asc' } } },
    }),
    db.stockLevel.findMany({ where: { warehouseId: po.warehouseId, productId: { in: po.lines.map((l) => l.productId) } }, select: { quantity: true } }),
    db.costLayer.findMany({ where: { poLineId: { in: po.lines.map((l) => l.poLineId) } }, select: { receivedQty: true, remainingQty: true } }),
    db.stockMovement.count({ where: { referenceId: po.poId, type: 'PURCHASE_REVERSAL' } }),
    db.accountingSyncLog.count({ where: { referenceId: po.poId, NOT: { type: 'STOCK_RECEIPT' } } }),
  ])
  return {
    status: row.status as string,
    lines: row.lines.map((l) => ({ id: l.id, qty: Number(l.qty), qtyReceived: Number(l.qtyReceived), price: Number(l.unitCostForeign) })),
    stock: stock.reduce((sum, s) => sum + Number(s.quantity), 0),
    layerRemaining: layers.reduce((sum, l) => sum + Number(l.remainingQty), 0),
    layerReceived: layers.reduce((sum, l) => sum + Number(l.receivedQty), 0),
    reversals,
    nonReceiptJournals,
  }
}

type Edit = Parameters<typeof import('@/app/actions/purchase-orders').updatePurchaseOrder>[1]

/** An edit request shaped like the form's: every existing line by id, with the given quantity and price. */
function editFor(po: SeededPo, spec: Array<{ qty: number; price?: number } | null>, extra: Partial<Edit> = {}): Edit {
  return {
    currency: 'GBP',
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: po.lines.flatMap((line, i) => {
      const s = spec[i]
      if (!s) return []
      return [{
        poLineId: line.poLineId,
        productId: line.productId,
        sku: line.sku,
        productName: `edited ${i}`,
        qty: s.qty,
        unitCostForeign: s.price ?? fixtures.UNIT_COST,
      }]
    }),
    ...extra,
  } as Edit
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// CLOSE / CANCEL at every stage
// ───────────────────────────────────────────────────────────────────────────────────────────────

for (const status of ['RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED'] as const) {
  test(`${status}, nothing received: Close -> CLOSED and Cancel -> CANCELLED, with no stock, layer or journal effect`, SKIP, async () => {
    const { advancePoStatus, cancelPurchaseOrder } = await actions()
    for (const intent of ['close', 'cancel'] as const) {
      const po = await seedPo(`lc-${status.toLowerCase()}-${intent}`, [10, 4])
      await setStatus(po.poId, status)
      const result = intent === 'close' ? await advancePoStatus(po.poId, 'CLOSED') : await cancelPurchaseOrder(po.poId)
      assert.equal(result.success, true, String(result.error))
      assert.equal('closedShort' in result && result.closedShort, false)
      const after = await poState(po)
      assert.equal(after.status, intent === 'close' ? 'CLOSED' : 'CANCELLED')
      assert.equal(after.stock, 0)
      assert.equal(after.layerReceived, 0)
      assert.equal(after.reversals, 0)
      assert.equal(after.nonReceiptJournals, 0, 'no accounting row is queued')
    }
  })
}

test('DRAFT can be cancelled; it has no Close', SKIP, async () => {
  const { advancePoStatus, cancelPurchaseOrder } = await actions()
  const po = await seedPo('lc-draft', [3])
  await setStatus(po.poId, 'DRAFT')
  const close = await advancePoStatus(po.poId, 'CLOSED')
  assert.equal(close.success, false)
  assert.equal((await poState(po)).status, 'DRAFT')
  assert.equal((await cancelPurchaseOrder(po.poId)).success, true)
  assert.equal((await poState(po)).status, 'CANCELLED')
})

for (const intent of ['close', 'cancel'] as const) {
  test(`part-received, ${intent}: closes SHORT — balance dropped, received stock, layers, qtyReceived and journals untouched, no reversal`, SKIP, async () => {
    const { advancePoStatus, cancelPurchaseOrder } = await actions()
    const { db } = await import('@/lib/db')
    const po = await seedPo(`lc-short-${intent}`, [100])
    const line = po.lines[0]!
    assert.equal((await receive(po, line, 60)).success, true)
    const before = await poState(po)
    assert.equal(before.status, 'PARTIALLY_RECEIVED')
    const journalsBefore = await db.accountingSyncLog.count({ where: { referenceId: po.poId } })
    const result = intent === 'close' ? await advancePoStatus(po.poId, 'CLOSED') : await cancelPurchaseOrder(po.poId)
    assert.equal(result.success, true, String(result.error))
    assert.equal(('closedShort' in result) && result.closedShort, true)
    assert.match(String(('notice' in result) && result.notice), /closed short: 40 unit\(s\) still due were dropped; the 60 unit\(s\) received stay in stock at their cost/)
    const after = await poState(po)
    assert.equal(after.status, 'CLOSED', 'a cancelled part-received order ends CLOSED')
    assert.equal(after.stock, 60, 'the received stock stays on hand')
    assert.equal(after.layerRemaining, 60, 'the cost layer is untouched')
    assert.equal(after.layerReceived, 60)
    assert.deepEqual(after.lines.map((l) => [l.qty, l.qtyReceived]), [[100, 60]], 'ordered qty is kept as the record; received is untouched')
    assert.equal(after.reversals, 0, 'no PURCHASE_REVERSAL movement')
    assert.equal(await db.accountingSyncLog.count({ where: { referenceId: po.poId } }), journalsBefore, 'no journal is queued')
    // The dropped balance is no longer expected, so a receipt for it is refused.
    const late = await receive(po, line, 10)
    assert.equal(late.success, false)
    assert.match(late.error ?? '', /cannot be received in its current status/)
    assert.equal((await poState(po)).stock, 60)
  })
}

test('closing short with a bill for more than was received succeeds and warns (billed ahead of receipt)', SKIP, async () => {
  const { advancePoStatus } = await actions()
  const { db } = await import('@/lib/db')
  const po = await seedPo('lc-billedahead', [100])
  const line = po.lines[0]!
  assert.equal((await receive(po, line, 60)).success, true)
  await db.purchaseInvoice.create({
    data: {
      poId: po.poId, invoiceDate: new Date(), subtotalForeign: 500, subtotalBase: 500, totalForeign: 500, totalBase: 500, fxRateToBase: 1,
      lines: { create: [{ poLineId: line.poLineId, qtyBilled: 100, unitCostForeign: 5, totalForeign: 500, totalBase: 500 }] },
    },
  })
  const result = await advancePoStatus(po.poId, 'CLOSED')
  assert.equal(result.success, true, String(result.error))
  assert.equal(result.warnings?.length, 1)
  assert.match(result.warnings![0]!, /billed 100, received 60 \(40 over, about 200\.00 base\)/)
  assert.equal((await poState(po)).status, 'CLOSED')
})

test('cancel with nothing received is refused while a supplier bill exists; the same bill does not stop a close-short', SKIP, async () => {
  const { cancelPurchaseOrder } = await actions()
  const { db } = await import('@/lib/db')
  const billed = await seedPo('lc-bill-cancel', [10])
  await db.purchaseInvoice.create({ data: { poId: billed.poId, invoiceDate: new Date(), subtotalForeign: 50, subtotalBase: 50, totalForeign: 50, totalBase: 50, fxRateToBase: 1 } })
  const refused = await cancelPurchaseOrder(billed.poId)
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /after supplier invoices have been recorded/)
  assert.equal((await poState(billed)).status, 'PO_SENT')

  const part = await seedPo('lc-bill-short', [10])
  assert.equal((await receive(part, part.lines[0]!, 4)).success, true)
  await db.purchaseInvoice.create({ data: { poId: part.poId, invoiceDate: new Date(), subtotalForeign: 20, subtotalBase: 20, totalForeign: 20, totalBase: 20, fxRateToBase: 1 } })
  const ok = await cancelPurchaseOrder(part.poId)
  assert.equal(ok.success, true, String(ok.error))
  assert.equal((await poState(part)).status, 'CLOSED')
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// LIVE ASN
// ───────────────────────────────────────────────────────────────────────────────────────────────

test('a live ASN refuses Close, Cancel, a line reduction, a removal and a warehouse change; a closed ASN does not', SKIP, async () => {
  const { advancePoStatus, cancelPurchaseOrder, updatePurchaseOrder } = await actions()
  const po = await seedPo('lc-asn', [10, 10])
  const [a, b] = [po.lines[0]!, po.lines[1]!]
  const asn = await addAsn(po, a, { expectedQty: 10, status: 'OPEN' })

  const close = await advancePoStatus(po.poId, 'CLOSED')
  assert.equal(close.success, false)
  assert.match(String(close.error), /Cannot close .*has an open warehouse ASN/)
  const cancel = await cancelPurchaseOrder(po.poId)
  assert.equal(cancel.success, false)
  assert.match(cancel.error ?? '', /Cannot cancel .*has an open warehouse ASN/)

  const reduce = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 5 }, { qty: 10 }]))
  assert.equal(reduce.success, false)
  assert.match(reduce.error ?? '', /open warehouse ASN \(.*OPEN\), so its quantity cannot be reduced/)
  const remove = await updatePurchaseOrder(po.poId, editFor(po, [null, { qty: 10 }]))
  assert.equal(remove.success, false)
  assert.match(remove.error ?? '', /cannot be removed/)
  const { db } = await import('@/lib/db')
  const other = await db.warehouse.create({ data: { code: `${fixtures.uid()}-W2`, name: 'other', type: 'STANDARD' }, select: { id: true } })
  const move = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 10 }, { qty: 10 }], { destinationWarehouseId: other.id }))
  assert.equal(move.success, false)
  assert.match(move.error ?? '', /destination warehouse cannot be changed while a warehouse ASN is open/)
  assert.equal((await poState(po)).status, 'PO_SENT')
  assert.deepEqual((await poState(po)).lines.map((l) => l.qty), [10, 10], 'every refusal left the lines alone')

  // Increases and the other line are fine while the ASN is live.
  const up = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 12 }, { qty: 7 }]))
  assert.equal(up.success, true, String(up.error))
  assert.deepEqual((await poState(po)).lines.map((l) => l.qty).sort(), [12, 7].sort())

  // Retire the ASN (closedAt set): the order can now be closed.
  await db.wmsAsnMap.update({ where: { id: asn.asnId }, data: { closedAt: new Date() } })
  const closed = await advancePoStatus(po.poId, 'CLOSED')
  assert.equal(closed.success, true, String(closed.error))
  void b
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// EDIT at each stage
// ───────────────────────────────────────────────────────────────────────────────────────────────

for (const status of ['RFQ_SENT', 'QUOTE_RECEIVED', 'PO_SENT', 'SHIPPED'] as const) {
  test(`${status}, nothing has touched it: the full edit applies (quantity, price, line set, warehouse, supplier reference) and totals follow`, SKIP, async () => {
    const { updatePurchaseOrder } = await actions()
    const { db } = await import('@/lib/db')
    const po = await seedPo(`ed-${status.toLowerCase()}`, [10, 4])
    await setStatus(po.poId, status)
    const warehouse = await db.warehouse.create({ data: { code: `${fixtures.uid()}-W3`, name: 'dest', type: 'STANDARD' }, select: { id: true } })
    const result = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 12, price: 7.5 }, null], { destinationWarehouseId: warehouse.id, supplierRef: 'QUOTE-1' }))
    assert.equal(result.success, true, String(result.error))
    const row = await db.purchaseOrder.findUniqueOrThrow({
      where: { id: po.poId },
      select: { status: true, supplierRef: true, destinationWarehouseId: true, subtotalForeign: true, totalForeign: true, lines: { select: { qty: true, unitCostForeign: true } } },
    })
    assert.equal(row.status, status, 'an edit does not move the status')
    assert.equal(row.supplierRef, 'QUOTE-1')
    assert.equal(row.destinationWarehouseId, warehouse.id)
    assert.equal(row.lines.length, 1)
    assert.equal(Number(row.lines[0]!.qty), 12)
    assert.equal(Number(row.lines[0]!.unitCostForeign), 7.5)
    assert.equal(Number(row.subtotalForeign), 90)
    assert.equal(Number(row.totalForeign), 90)
  })
}

test('terminal and fully-received orders cannot be edited', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  for (const status of ['RECEIVED', 'CLOSED', 'CANCELLED', 'RETURNED', 'INVOICED']) {
    const po = await seedPo(`ed-term-${status.toLowerCase()}`, [3])
    await setStatus(po.poId, status)
    const result = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 9 }]))
    assert.equal(result.success, false, status)
    assert.match(result.error ?? '', /can no longer be edited/)
    assert.equal((await poState(po)).lines[0]!.qty, 3)
  }
})

test('part-received AMEND: line ids kept; received line price locked, qty floored at received, not removable; supplier fixed; untouched line free; new line allowed', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  const { db } = await import('@/lib/db')
  const po = await seedPo('ed-amend', [100, 20])
  const [a, b] = [po.lines[0]!, po.lines[1]!]
  assert.equal((await receive(po, a, 60)).success, true)
  const idsBefore = (await poState(po)).lines.map((l) => l.id)

  const price = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 100, price: 6 }, { qty: 20 }]))
  assert.equal(price.success, false)
  assert.match(price.error ?? '', /the price is locked because this line has been received, billed or returned/)
  const below = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 59 }, { qty: 20 }]))
  assert.equal(below.success, false)
  assert.match(below.error ?? '', /cannot go below 60/)
  const removed = await updatePurchaseOrder(po.poId, editFor(po, [null, { qty: 20 }]))
  assert.equal(removed.success, false)
  assert.match(removed.error ?? '', /has been received, billed or returned, so it cannot be removed/)
  const other = await db.supplier.create({ data: { name: `${fixtures.uid()} other`, currency: 'GBP' }, select: { id: true } })
  const supplier = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 100 }, { qty: 20 }], { supplierId: other.id }))
  assert.equal(supplier.success, false)
  assert.match(supplier.error ?? '', /supplier, currency, exchange rate and VAT cannot be changed/)
  assert.deepEqual((await poState(po)).lines.map((l) => l.qty), [100, 20], 'every refusal left the lines alone')

  // Allowed: drop line A's balance (qty = received), re-price the untouched line B, add a new product.
  const product = await db.product.create({ data: { sku: `${fixtures.uid()}-new`, name: 'added later', type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true, sku: true } })
  const ok = await updatePurchaseOrder(po.poId, {
    ...editFor(po, [{ qty: 60 }, { qty: 25, price: 9 }]),
    lines: [
      ...(editFor(po, [{ qty: 60 }, { qty: 25, price: 9 }]).lines ?? []),
      { productId: product.id, sku: product.sku, productName: 'added later', qty: 3, unitCostForeign: 2 },
    ],
  })
  assert.equal(ok.success, true, String(ok.error))
  const after = await poState(po)
  assert.equal(after.status, 'PARTIALLY_RECEIVED')
  assert.ok(idsBefore.every((id) => after.lines.some((l) => l.id === id)), 'both original line ids survive the amend')
  const byId = new Map(after.lines.map((l) => [l.id, l]))
  assert.deepEqual([byId.get(a.poLineId)!.qty, byId.get(a.poLineId)!.qtyReceived, byId.get(a.poLineId)!.price], [60, 60, 5])
  assert.deepEqual([byId.get(b.poLineId)!.qty, byId.get(b.poLineId)!.price], [25, 9])
  assert.equal(after.lines.length, 3)
  const header = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { subtotalForeign: true } })
  assert.equal(Number(header.subtotalForeign), 60 * 5 + 25 * 9 + 3 * 2)
  assert.equal(after.stock, 60, 'an edit moves no stock')
  assert.equal(after.layerRemaining, 60, 'and no cost layer')
})

test('part-received AMEND: an edit that leaves nothing outstanding is refused in favour of Close', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  const po = await seedPo('ed-strand', [100])
  assert.equal((await receive(po, po.lines[0]!, 60)).success, true)
  const strand = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 60 }]))
  assert.equal(strand.success, false)
  assert.match(strand.error ?? '', /nothing outstanding on the order\. To drop the unreceived balance, use Close instead/)
  assert.equal((await poState(po)).lines[0]!.qty, 100)
})

test('part-received AMEND on an order with a cost line: quantity and line-set edits are refused, a no-op line edit and notes pass', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  const po = await seedPo('ed-cost', [100, 20])
  const [a] = [po.lines[0]!]
  const costs = [{ description: 'Freight', amountForeign: 50, vatable: false, distributionMethod: 'BY_VALUE' }]
  // The cost line is seeded directly: a full edit would rebuild the line set and leave the fixture's line ids stale.
  const { db } = await import('@/lib/db')
  await db.freightCostLine.create({
    data: { poId: po.poId, description: 'Freight', amountForeign: 50, amountBase: 50, vatable: false, distributionMethod: 'BY_VALUE', sortOrder: 0 },
  })
  assert.equal((await receive(po, a, 60)).success, true)

  const qty = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 100 }, { qty: 15 }], { additionalCosts: costs }))
  assert.equal(qty.success, false)
  assert.match(qty.error ?? '', /freight or other cost lines/)
  const repriced = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 100 }, { qty: 20, price: 9 }], { additionalCosts: costs }))
  assert.equal(repriced.success, false, 'a price change on an untouched line moves the BY_VALUE freight basis of received stock')
  assert.match(repriced.error ?? '', /quantities, prices or discounts/)
  assert.equal((await poState(po)).lines.find((l) => l.qty === 20)?.price, 5)
  const changedCost = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 100 }, { qty: 20 }], { additionalCosts: [{ ...costs[0]!, amountForeign: 80 }] }))
  assert.equal(changedCost.success, false)
  assert.match(changedCost.error ?? '', /cost of the stock and cannot be changed/)
  const ok = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 100 }, { qty: 20 }], { additionalCosts: costs, notes: 'chased supplier' }))
  assert.equal(ok.success, true, String(ok.error))
  assert.deepEqual((await poState(po)).lines.map((l) => l.qty), [100, 20])
})

test('an amend where a bill exists: billed line price locked and qty floored at billed; header money fixed', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  const { db } = await import('@/lib/db')
  const po = await seedPo('ed-billed', [10, 10])
  const a = po.lines[0]!
  await db.purchaseInvoice.create({
    data: {
      poId: po.poId, invoiceDate: new Date(), subtotalForeign: 40, subtotalBase: 40, totalForeign: 40, totalBase: 40, fxRateToBase: 1,
      lines: { create: [{ poLineId: a.poLineId, qtyBilled: 8, unitCostForeign: 5, totalForeign: 40, totalBase: 40 }] },
    },
  })
  const price = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 10, price: 6 }, { qty: 10 }]))
  assert.equal(price.success, false)
  assert.match(price.error ?? '', /price is locked/)
  const below = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 7 }, { qty: 10 }]))
  assert.equal(below.success, false)
  assert.match(below.error ?? '', /cannot go below 8/)
  const ok = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 8 }, { qty: 12, price: 6 }]))
  assert.equal(ok.success, true, String(ok.error))
  const vat = await updatePurchaseOrder(po.poId, { taxRateValue: 0.2, taxRateName: 'Std' })
  assert.equal(vat.success, false)
  const { PO_BILLED_FIGURES_EDIT_MESSAGE } = await import('@/lib/domain/purchasing/purchase-invoice-edit')
  assert.equal(vat.error, PO_BILLED_FIGURES_EDIT_MESSAGE)
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// RACES
// ───────────────────────────────────────────────────────────────────────────────────────────────

for (const intent of ['close', 'cancel'] as const) {
  test(`RACE receipt vs ${intent}: receipt wins the lock -> the receipt is kept and the order closes short`, SKIP, async () => {
    const { advancePoStatus, cancelPurchaseOrder } = await actions()
    const po = await seedPo(`race-rc-${intent}`, [100])
    const line = po.lines[0]!
    const [received, retired] = await raced(
      po.poId,
      () => receive(po, line, 60),
      () => (intent === 'close' ? advancePoStatus(po.poId, 'CLOSED') : cancelPurchaseOrder(po.poId)),
    )
    assert.equal(received.success, true, received.error)
    assert.equal(retired.success, true, String(retired.error))
    assert.equal(('closedShort' in retired) && retired.closedShort, true, 'the close saw the receipt that committed first')
    const after = await poState(po)
    assert.equal(after.status, 'CLOSED')
    assert.equal(after.stock, 60)
    assert.equal(after.layerRemaining, 60)
    assert.equal(after.reversals, 0)
  })

  test(`RACE ${intent} vs receipt: ${intent} wins the lock -> the receipt is refused and writes nothing`, SKIP, async () => {
    const { advancePoStatus, cancelPurchaseOrder } = await actions()
    const po = await seedPo(`race-${intent}-rc`, [100])
    const line = po.lines[0]!
    const [retired, received] = await raced(
      po.poId,
      () => (intent === 'close' ? advancePoStatus(po.poId, 'CLOSED') : cancelPurchaseOrder(po.poId)),
      () => receive(po, line, 60),
    )
    assert.equal(retired.success, true, String(retired.error))
    assert.equal(received.success, false)
    assert.match(received.error ?? '', /cannot be received in its current status|Cannot transition purchase order from (CLOSED|CANCELLED) to RECEIVED/)
    const after = await poState(po)
    assert.equal(after.status, intent === 'close' ? 'CLOSED' : 'CANCELLED')
    assert.equal(after.stock, 0, 'the refused receipt booked nothing')
    assert.equal(after.layerReceived, 0)
    const snap = await snapshotOf(po, line)
    assert.equal(snap.journals, 0, 'and queued no receipt journal')
  })
}

test('RACE receipt vs edit: receipt first -> an edit below what landed is refused', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  const po = await seedPo('race-rc-edit', [100])
  const line = po.lines[0]!
  const [received, edited] = await raced(po.poId, () => receive(po, line, 60), () => updatePurchaseOrder(po.poId, editFor(po, [{ qty: 50 }])))
  assert.equal(received.success, true, received.error)
  assert.equal(edited.success, false)
  assert.match(edited.error ?? '', /cannot go below 60/)
  const after = await poState(po)
  assert.deepEqual(after.lines.map((l) => [l.qty, l.qtyReceived]), [[100, 60]])
  assert.equal(after.stock, 60)
})

test('RACE edit vs receipt: edit first -> the receipt cannot exceed the reduced quantity', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  const po = await seedPo('race-edit-rc', [100])
  const line = po.lines[0]!
  const [edited, received] = await raced(po.poId, () => updatePurchaseOrder(po.poId, editFor(po, [{ qty: 50 }])), () => receive(po, line, 60))
  assert.equal(edited.success, true, String(edited.error))
  assert.equal(received.success, false, 'the receipt was prepared against the old line and quantity')
  const after = await poState(po)
  assert.equal(after.stock, 0, 'the refused receipt booked nothing')
  assert.deepEqual(after.lines.map((l) => l.qty), [50])
})

test('RACE edit vs receipt, ids preserved by an amend: the receipt is checked against the reduced outstanding', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  const po = await seedPo('race-amend-rc', [100])
  const line = po.lines[0]!
  // An ASN row (closed) makes the order non-pristine, so the edit amends in place and the line id survives.
  await addAsn(po, line, { expectedQty: 100, status: 'OPEN', closed: true })
  const [edited, received] = await raced(po.poId, () => updatePurchaseOrder(po.poId, editFor(po, [{ qty: 50 }])), () => receive(po, line, 60))
  assert.equal(edited.success, true, String(edited.error))
  assert.equal(received.success, false)
  assert.match(received.error ?? '', /Cannot receive more than outstanding qty \(50\)/)
  const after = await poState(po)
  assert.equal(after.stock, 0)
  assert.deepEqual(after.lines.map((l) => [l.id, l.qty]), [[line.poLineId, 50]])
})

test('RACE edit vs close: serialise; the loser re-reads status under the lock', SKIP, async () => {
  const { updatePurchaseOrder, advancePoStatus } = await actions()
  const closeFirst = await seedPo('race-cl-edit', [10])
  const [closed, edited] = await raced(closeFirst.poId, () => advancePoStatus(closeFirst.poId, 'CLOSED'), () => updatePurchaseOrder(closeFirst.poId, editFor(closeFirst, [{ qty: 4 }])))
  assert.equal(closed.success, true)
  assert.equal(edited.success, false)
  assert.match(edited.error ?? '', /can no longer be edited/)
  assert.equal((await poState(closeFirst)).lines[0]!.qty, 10)

  const editFirst = await seedPo('race-edit-cl', [10])
  const [e2, c2] = await raced(editFirst.poId, () => updatePurchaseOrder(editFirst.poId, editFor(editFirst, [{ qty: 4 }])), () => advancePoStatus(editFirst.poId, 'CLOSED'))
  assert.equal(e2.success, true, String(e2.error))
  assert.equal(c2.success, true)
  const after = await poState(editFirst)
  assert.equal(after.status, 'CLOSED')
  assert.equal(after.lines[0]!.qty, 4)
})

test('RACE return vs close: close first -> the return is refused and the CLOSED status is not overwritten', SKIP, async () => {
  const { advancePoStatus, returnPurchaseOrder } = await actions()
  const po = await seedPo('race-cl-ret', [10])
  const line = po.lines[0]!
  assert.equal((await receive(po, line, 6)).success, true)
  const [closed, returned] = await raced(
    po.poId,
    () => advancePoStatus(po.poId, 'CLOSED'),
    () => returnPurchaseOrder(po.poId, [{ poLineId: line.poLineId, qtyReturned: 2, warehouseId: po.warehouseId }], 'damaged'),
  )
  assert.equal(closed.success, true, String(closed.error))
  assert.equal(returned.success, false)
  assert.match(returned.error ?? '', /Cannot return from a PO in this status/)
  const after = await poState(po)
  assert.equal(after.status, 'CLOSED')
  assert.equal(after.stock, 6)
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// RETURN KEEPS THE ORDER OPEN (the balance is not stranded)
// ───────────────────────────────────────────────────────────────────────────────────────────────

test('a return on a part-received order leaves it open for receipt, edit, close and cancel while quantity is still due', SKIP, async () => {
  const { returnPurchaseOrder, advancePoStatus } = await actions()
  const po = await seedPo('ret-open', [10, 10])
  const [a, b] = [po.lines[0]!, po.lines[1]!]
  assert.equal((await receive(po, a, 5)).success, true)
  const ret = (qty: number) => returnPurchaseOrder(po.poId, [{ poLineId: a.poLineId, qtyReturned: qty, warehouseId: po.warehouseId }], 'damaged')

  assert.equal((await ret(1)).success, true)
  assert.equal((await poState(po)).status, 'PARTIALLY_RECEIVED', 'a partial return no longer moves the order to PARTIALLY_RETURNED')
  // Every received unit returned, balance still due: still open, not RETURNED.
  assert.equal((await ret(4)).success, true)
  assert.equal((await poState(po)).status, 'PARTIALLY_RECEIVED', 'returning everything received does not terminate an order with a balance due')
  // The rest can still be received.
  assert.equal((await receive(po, a, 5)).success, true)
  assert.equal((await receive(po, b, 10)).success, true)
  assert.equal((await poState(po)).status, 'RECEIVED')
  // With nothing outstanding the old behaviour holds: a return moves it on.
  assert.equal((await ret(1)).success, true)
  assert.equal((await poState(po)).status, 'PARTIALLY_RETURNED')
  const closed = await advancePoStatus(po.poId, 'CLOSED')
  assert.equal(closed.success, true, String(closed.error))
})

test('an order stranded in PARTIALLY_RETURNED by an older return can be closed or cancelled', SKIP, async () => {
  const { advancePoStatus, cancelPurchaseOrder } = await actions()
  const closeMe = await seedPo('ret-strand-close', [10])
  assert.equal((await receive(closeMe, closeMe.lines[0]!, 4)).success, true)
  await setStatus(closeMe.poId, 'PARTIALLY_RETURNED')
  assert.equal((await advancePoStatus(closeMe.poId, 'CLOSED')).success, true)
  assert.equal((await poState(closeMe)).status, 'CLOSED')

  const cancelMe = await seedPo('ret-strand-cancel', [10])
  assert.equal((await receive(cancelMe, cancelMe.lines[0]!, 4)).success, true)
  await setStatus(cancelMe.poId, 'PARTIALLY_RETURNED')
  const cancelled = await cancelPurchaseOrder(cancelMe.poId)
  assert.equal(cancelled.success, true, String(cancelled.error))
  const after = await poState(cancelMe)
  assert.equal(after.status, 'CLOSED')
  assert.equal(after.stock, 4, 'the received stock stays')
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// HEADER DISCOUNT
// ───────────────────────────────────────────────────────────────────────────────────────────────

test('a received-but-unbilled order: the header discount cannot be changed, and a line save that omits it keeps it', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  const { db } = await import('@/lib/db')
  const po = await seedPo('ed-disc-recv', [100, 20])
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { discountAmount: 10, discountStr: '10' } })
  assert.equal((await receive(po, po.lines[0]!, 60)).success, true)
  const read = () => db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { discountAmount: true, discountStr: true, totalForeign: true } })
  const before = await read()

  const changed = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 100 }, { qty: 20 }], { orderDiscountForeign: 25, orderDiscountStr: '25' }))
  assert.equal(changed.success, false)
  assert.match(changed.error ?? '', /order discount cannot be changed/)
  assert.deepEqual(await read(), before, 'a refused edit changes nothing')

  // Omitted: the stored discount is kept, not defaulted to zero, and the total reflects it.
  const omitted = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 100 }, { qty: 25 }]))
  assert.equal(omitted.success, true, String(omitted.error))
  const after = await read()
  assert.equal(Number(after.discountAmount), 10)
  assert.equal(after.discountStr, '10')
  assert.equal(Number(after.totalForeign), 100 * 5 + 25 * 5 - 10)
})

test('a billed order: a line edit that omits the order discount keeps it; changing it is refused', SKIP, async () => {
  const { updatePurchaseOrder } = await actions()
  const { db } = await import('@/lib/db')
  const { PO_BILLED_FIGURES_EDIT_MESSAGE } = await import('@/lib/domain/purchasing/purchase-invoice-edit')
  const po = await seedPo('ed-disc-bill', [10, 10])
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { discountAmount: 5, discountStr: '5' } })
  await db.purchaseInvoice.create({
    data: {
      poId: po.poId, invoiceDate: new Date(), subtotalForeign: 40, subtotalBase: 40, totalForeign: 40, totalBase: 40, fxRateToBase: 1,
      lines: { create: [{ poLineId: po.lines[0]!.poLineId, qtyBilled: 8, unitCostForeign: 5, totalForeign: 40, totalBase: 40 }] },
    },
  })
  const changed = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 10 }, { qty: 10 }], { orderDiscountForeign: 0 }))
  assert.equal(changed.success, false)
  assert.equal(changed.error, PO_BILLED_FIGURES_EDIT_MESSAGE)
  const ok = await updatePurchaseOrder(po.poId, editFor(po, [{ qty: 10 }, { qty: 12 }]))
  assert.equal(ok.success, true, String(ok.error))
  const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { discountAmount: true, discountStr: true } })
  assert.equal(Number(row.discountAmount), 5)
  assert.equal(row.discountStr, '5')
})

test('cancel is refused on a fully received order (it can only be closed)', SKIP, async () => {
  const { cancelPurchaseOrder, advancePoStatus } = await actions()
  const po = await seedPo('lc-cancel-received', [4])
  assert.equal((await receive(po, po.lines[0]!, 4)).success, true)
  assert.equal((await poState(po)).status, 'RECEIVED')
  const cancel = await cancelPurchaseOrder(po.poId)
  assert.equal(cancel.success, false)
  assert.equal((await poState(po)).status, 'RECEIVED')
  assert.equal((await advancePoStatus(po.poId, 'CLOSED')).success, true)
})
