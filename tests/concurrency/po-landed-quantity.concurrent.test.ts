import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import * as fixtures from './po-landed-fixtures'
import type { SeededLine, SeededPo, SeededAsn } from './po-landed-fixtures'

/**
 * o3d-papk (6a) — A PURCHASE-ORDER LINE HAS LANDED WHEN THE WMS ALIGNMENT SAYS SO, NOT ONLY WHEN
 * `qtyReceived` DOES.
 *
 * SEQUENCE A (the defect, normal operation, no race). PO line qty 10. The ASN push failed and left a
 * CREATE_PENDING reservation carrying the line at 10. Six units arrive and the WMS stock-sync ALIGNMENT
 * credits the reservation: stock +6, a cost layer, a STOCK_RECEIPT journal — and `qtyReceived` stays 0,
 * because alignment has never written it. `receivePurchaseOrder` asked only `qty - qtyReceived`, so the
 * operator's manual receipt of 10 was ACCEPTED: stock 16 for 10 physical units, a second layer and a second
 * journal.
 *
 * EVERY arm here runs the REAL alignment (`applyMintsoftAlignmentForProduct`), the REAL manual receipt
 * (`receivePurchaseOrder`) and the REAL webhook book-in (`processBookedInEvent`) over a real PostgreSQL. The
 * purchase orders are built by the real `createPurchaseOrder`. Mintsoft is never contacted: alignment takes
 * its delta as an argument and the book-in is handed a normalised ASN.
 *
 * The identity of every fixture comes from `randomUUID()`, entropy FIRST and never truncated (o3d-kx1uy):
 * CI runs one shared database and these rows are never deleted.
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
mock.module('@/lib/domain/wms/mutation-audit', {
  namedExports: { recordWmsMutationEvent: async () => {} },
})
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

const { loadEnv, enableStockReceiptPosting, uid, seedPo, addAsn, alignUp, receive, bookIn, snapshotOf } = fixtures

test.before(async () => {
  if (!RUN) return
  loadEnv()
  await enableStockReceiptPosting()
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A2 — THE MANUAL RECEIPT AFTER A REAL ALIGNMENT (the Sequence A regression)
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A2: a manual receipt after a REAL alignment (which did not write qtyReceived) is capped by what has landed: 10 refused, 4 accepted, PO RECEIVED',
  SKIP,
  async () => {
    const po = await seedPo('a2', [10])
    const line = po.lines[0]!
    const asn = await addAsn(po, line, { expectedQty: 10, status: 'CREATE_PENDING' })

    const aligned = await alignUp(po, line, { delta: 6, imsQty: 0 })
    const afterAlign = await snapshotOf(po, line)
    // PRECONDITIONS, so the arm cannot pass over a fixture that never aligned anything.
    assert.equal(aligned.applied, true, `PRECONDITION: the alignment must have applied: ${JSON.stringify(aligned)}`)
    assert.equal(afterAlign.stock, 6, 'PRECONDITION: alignment brought 6 units into stock')
    assert.equal(afterAlign.qtyReceived, 0, 'PRECONDITION: alignment does not write qtyReceived (the defect)')
    assert.equal(afterAlign.credits.get(asn.asnLineMapId)?.snapshot, 6, 'PRECONDITION: the ASN row carries the 6-unit credit')
    assert.equal(afterAlign.layerCount, 1, 'PRECONDITION: alignment laid one cost layer')

    const tooMuch = await receive(po, line, 10)
    const afterTooMuch = await snapshotOf(po, line)
    console.log(`# SEQUENCE A: manual receipt of 10 after 6 aligned -> success=${tooMuch.success} stock=${afterTooMuch.stock} layers=${afterTooMuch.layerCount} movements=${afterTooMuch.movementCount} journals=${afterTooMuch.journals} qtyReceived=${afterTooMuch.qtyReceived} error=${tooMuch.error ?? ''}`)
    assert.equal(tooMuch.success, false, `a receipt of 10 against a line with 6 already landed must be refused (stock is now ${afterTooMuch.stock} for 10 physical units)`)
    assert.match(tooMuch.error ?? '', /outstanding qty \(4\)/)
    assert.equal(afterTooMuch.stock, 6, 'the refused receipt moved no stock')
    assert.equal(afterTooMuch.layerCount, 1, 'the refused receipt laid no layer')
    assert.equal(afterTooMuch.journals, afterAlign.journals, 'the refused receipt queued no journal')

    const exact = await receive(po, line, 4)
    assert.equal(exact.success, true, `the outstanding 4 must be accepted: ${exact.error}`)
    const final = await snapshotOf(po, line)
    assert.equal(final.stock, 10)
    assert.equal(final.qtyReceived, 4)
    assert.equal(final.poStatus, 'RECEIVED', 'every unit has landed, so the PO is RECEIVED')
    console.log('# A2: evaluated 1 aligned-then-received line (refused 10, accepted 4)')
  },
)

test(
  'A2 isolating arm: the credit sits ONLY on a closed (retired) row, and still caps the receipt',
  SKIP,
  async () => {
    const po = await seedPo('a2closed', [10])
    const line = po.lines[0]!
    // No open row at all: a retired reservation whose credit is the only evidence that 6 units landed.
    const closed = await addAsn(po, line, { expectedQty: 10, closed: true, viaSnapshot: 6 })
    const before = await snapshotOf(po, line)
    assert.equal(before.credits.get(closed.asnLineMapId)?.snapshot, 6, 'PRECONDITION: the closed row carries the credit')
    assert.equal(before.qtyReceived, 0, 'PRECONDITION: qtyReceived is zero')

    const tooMuch = await receive(po, line, 10)
    assert.equal(tooMuch.success, false, 'a receipt of 10 must be refused when 6 landed through a CLOSED row')
    assert.match(tooMuch.error ?? '', /outstanding qty \(4\)/)
    const ok = await receive(po, line, 4)
    assert.equal(ok.success, true, `4 is outstanding: ${ok.error}`)
    console.log('# A2 isolating: evaluated 1 closed-row credit')
  },
)

// o3d-67kw3 is no longer a known-failing case here: it is fixed (book-in reconciliation, commit C1) and guarded by
// 'A-D3' in tests/concurrency/po-asn-creator.concurrent.test.ts, which drives the REAL creator.

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A3 — THE ALIGNMENT PLANNER'S PO LINE CAP
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A3: alignment against a FULLY RECEIVED PO line is refused: no stock movement, layer or journal',
  SKIP,
  async () => {
    const po = await seedPo('a3full', [10])
    const line = po.lines[0]!
    const asn = await addAsn(po, line, { expectedQty: 10 })
    const received = await receive(po, line, 10)
    assert.equal(received.success, true, `PRECONDITION: the manual receipt must succeed: ${received.error}`)
    const before = await snapshotOf(po, line)
    // PRECONDITIONS: the ASN row still has all its own room (so only the LINE cap can refuse), the line is
    // fully received, and the ASN is open.
    assert.equal(before.credits.get(asn.asnLineMapId)?.snapshot, 0, 'PRECONDITION: the ASN row is uncredited, so its own residue is 10')
    assert.equal(before.qtyReceived, 10, 'PRECONDITION: the line is fully received')
    assert.equal(before.stock, 10)

    const result = await alignUp(po, line, { delta: 5, imsQty: 10 })
    const after = await snapshotOf(po, line)
    console.log(`# A3: delta 5 against a fully received line -> applied=${result.applied} stock ${before.stock}->${after.stock} layers ${before.layerCount}->${after.layerCount} movements ${before.movementCount}->${after.movementCount} journals ${before.journals}->${after.journals}`)
    assert.equal(result.applied, false, `alignment must refuse: ${JSON.stringify(result)}`)
    assert.equal(after.stock, before.stock, 'no stock moved')
    assert.equal(after.layerCount, before.layerCount, 'no cost layer was laid')
    assert.equal(after.movementCount, before.movementCount, 'no stock movement was written')
    assert.equal(after.journals, before.journals, 'no STOCK_RECEIPT journal was queued')
    assert.equal(after.credits.get(asn.asnLineMapId)?.snapshot, 0, 'the ASN row was not credited')
    console.log('# A3 evaluated 1 fully received line against an ASN row with residue 10')
  },
)

test(
  'A3 isolating arm: ASN residue large, LINE residue small: the allocation equals the LINE residue',
  SKIP,
  async () => {
    const po = await seedPo('a3small', [10])
    const line = po.lines[0]!
    const asn = await addAsn(po, line, { expectedQty: 10 })
    assert.equal((await receive(po, line, 7)).success, true, 'PRECONDITION: the manual receipt of 7 must succeed')
    const base = await snapshotOf(po, line)
    assert.equal(base.stock, 7)
    assert.equal(base.credits.get(asn.asnLineMapId)?.snapshot, 0, 'PRECONDITION: the ASN row has residue 10 (uncredited); the line has residue 3')

    // 5 > the line's 3: the plan cannot explain the delta and must refuse it WHOLE.
    const tooMuch = await alignUp(po, line, { delta: 5, imsQty: 7 })
    const afterTooMuch = await snapshotOf(po, line)
    assert.equal(tooMuch.applied, false, `a 5-unit delta exceeds the line residue 3: ${JSON.stringify(tooMuch)}`)
    assert.match(String((tooMuch as { reason?: string }).reason), /only explain 3 of the 5/)
    assert.equal(afterTooMuch.stock, 7)
    assert.equal(afterTooMuch.layerCount, base.layerCount)

    // 3 == the line's residue: allocated exactly, and the credit is exactly 3 although the ASN row had room for 10.
    const exact = await alignUp(po, line, { delta: 3, imsQty: 7 })
    const afterExact = await snapshotOf(po, line)
    assert.equal(exact.applied, true, `a 3-unit delta equals the line residue: ${JSON.stringify(exact)}`)
    assert.equal(afterExact.credits.get(asn.asnLineMapId)?.snapshot, 3, 'the allocation equals the LINE residue')
    assert.equal(afterExact.stock, 10)

    // Now the line is fully landed (7 received + 3 aligned): one more unit is refused.
    const over = await alignUp(po, line, { delta: 1, imsQty: 10 })
    assert.equal(over.applied, false, 'nothing left on the line')
    assert.equal((await snapshotOf(po, line)).stock, 10)
    console.log('# A3 isolating: evaluated 3 deltas (5 refused, 3 applied, 1 refused) against line residue 3')
  },
)

test(
  'A3 landed-based cap: two open ASN rows on ONE line share the LINE residue (landed, not qty - qtyReceived)',
  SKIP,
  async () => {
    const po = await seedPo('a3two', [10])
    const line = po.lines[0]!
    const first = await addAsn(po, line, { expectedQty: 10, createdAt: new Date(Date.now() - 60_000) })
    const second = await addAsn(po, line, { expectedQty: 10 })
    const one = await alignUp(po, line, { delta: 6, imsQty: 0 })
    assert.equal(one.applied, true, `PRECONDITION: the first alignment must apply: ${JSON.stringify(one)}`)
    const mid = await snapshotOf(po, line)
    assert.equal(mid.credits.get(first.asnLineMapId)?.snapshot, 6, 'PRECONDITION: 6 landed through the older row')
    assert.equal(mid.qtyReceived, 0, 'PRECONDITION: qtyReceived is still 0, so qty - qtyReceived would say 10 outstanding')

    // 6 more would exceed the line: 4 are outstanding. Using qty - qtyReceived (10) the second row would
    // happily take them and the line would land 12 of 10.
    const two = await alignUp(po, line, { delta: 6, imsQty: 6 })
    const afterTwo = await snapshotOf(po, line)
    assert.equal(two.applied, false, `only 4 units remain on the line: ${JSON.stringify(two)}`)
    assert.equal(afterTwo.stock, 6)
    assert.equal(afterTwo.credits.get(second.asnLineMapId)?.snapshot, 0, 'the second row took nothing')
    const three = await alignUp(po, line, { delta: 4, imsQty: 6 })
    assert.equal(three.applied, true, `the outstanding 4 aligns: ${JSON.stringify(three)}`)
    assert.equal((await snapshotOf(po, line)).stock, 10)
    console.log('# A3 two-row arm: evaluated 3 deltas over 2 open ASN rows on one line')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A4 — A CANCELLED / CLOSED PO IS REFUSED AS 'unusable', NEVER 'raced'
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A4: a CANCELLED purchase order is refused as unusable and a healthy sibling still aligns, and keeps aligning',
  SKIP,
  async () => {
    const cancelled = await seedPo('a4x', [10], 'CANCELLED')
    const healthy = await seedPo('a4y', [10], 'PO_SENT', cancelled)
    const cancelledLine = cancelled.lines[0]!
    const healthyLine = healthy.lines[0]!
    // The cancelled order's ASN is OLDER, so an unfiltered planner would choose it first.
    const cancelledAsn = await addAsn(cancelled, cancelledLine, { expectedQty: 10, createdAt: new Date(Date.now() - 120_000) })
    const healthyAsn = await addAsn(healthy, healthyLine, { expectedQty: 10 })
    const { db } = await import('@/lib/db')
    const status = await db.purchaseOrder.findUniqueOrThrow({ where: { id: cancelled.poId }, select: { status: true } })
    assert.equal(status.status, 'CANCELLED', 'PRECONDITION: the first order is CANCELLED')
    assert.equal(cancelledLine.productId, healthyLine.productId, 'PRECONDITION: both orders carry the SAME product')

    const first = await alignUp(healthy, healthyLine, { delta: 5, imsQty: 0 })
    const afterFirst = await snapshotOf(healthy, healthyLine)
    console.log(`# A4: mixed world delta 5 -> applied=${first.applied}`)
    assert.equal(first.applied, true, `the healthy sibling must still align: ${JSON.stringify(first)}`)
    assert.equal(afterFirst.credits.get(healthyAsn.asnLineMapId)?.snapshot, 5, 'the healthy order took the units')
    const cancelledSnap = await snapshotOf(cancelled, cancelledLine)
    assert.equal(cancelledSnap.credits.get(cancelledAsn.asnLineMapId)?.snapshot, 0, 'the CANCELLED order took nothing')
    assert.equal(afterFirst.stock, 5)

    // KEEPS aligning: a cancelled order's ASN is never closed, so a refusal that were terminal ('raced') would
    // block this product for ever.
    const second = await alignUp(healthy, healthyLine, { delta: 3, imsQty: 5 })
    assert.equal(second.applied, true, `and again: ${JSON.stringify(second)}`)
    assert.equal((await snapshotOf(healthy, healthyLine)).stock, 8)
    console.log('# A4 evaluated 2 sweeps over a mixed world (1 cancelled + 1 healthy order)')
  },
)

test(
  'A4 only the cancelled order: refused as unusable, naming its status, not as raced',
  SKIP,
  async () => {
    const cancelled = await seedPo('a4only', [10], 'CANCELLED')
    const line = cancelled.lines[0]!
    await addAsn(cancelled, line, { expectedQty: 10 })
    const result = await alignUp(cancelled, line, { delta: 5, imsQty: 0 })
    const reason = String((result as { reason?: string }).reason)
    assert.equal(result.applied, false)
    assert.match(reason, /purchase order .* is CANCELLED/)
    assert.doesNotMatch(reason, /created after this run took its|measured before/, 'unusable, never raced')
    assert.equal((await snapshotOf(cancelled, line)).stock, 0)
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A7 — STATUS DERIVATION BY LANDED, in the manual receipt and in the book-in
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A7 manual receipt: a line landed through alignment counts toward RECEIVED',
  SKIP,
  async () => {
    const po = await seedPo('a7m', [10, 5])
    const [l1, l2] = [po.lines[0]!, po.lines[1]!]
    await addAsn(po, l1, { expectedQty: 10 })
    const aligned = await alignUp(po, l1, { delta: 10, imsQty: 0 })
    const mid = await snapshotOf(po, l1)
    assert.equal(aligned.applied, true, `PRECONDITION: line one aligned fully: ${JSON.stringify(aligned)}`)
    assert.equal(mid.qtyReceived, 0, 'PRECONDITION: line one has qtyReceived 0 (landed 10)')

    const manual = await receive(po, l2, 5)
    assert.equal(manual.success, true, `receipt of line two: ${manual.error}`)
    const after = await snapshotOf(po, l2)
    console.log(`# A7 manual: poStatus=${after.poStatus}`)
    assert.equal(after.poStatus, 'RECEIVED', 'both lines have landed (10 aligned + 5 received)')
  },
)

test(
  'A7 book-in: a line landed through alignment counts toward RECEIVED',
  SKIP,
  async () => {
    const po = await seedPo('a7b', [10, 5])
    const [l1, l2] = [po.lines[0]!, po.lines[1]!]
    await addAsn(po, l1, { expectedQty: 10 })
    const aligned = await alignUp(po, l1, { delta: 10, imsQty: 0 })
    assert.equal(aligned.applied, true, `PRECONDITION: line one aligned fully: ${JSON.stringify(aligned)}`)
    assert.equal((await snapshotOf(po, l1)).qtyReceived, 0, 'PRECONDITION: line one has qtyReceived 0 (landed 10)')
    const asn2 = await addAsn(po, l2, { expectedQty: 5 })
    const status = await bookIn(asn2, l2, 5, 5)
    const after = await snapshotOf(po, l2)
    console.log(`# A7 book-in: bookIn=${status} poStatus=${after.poStatus} lineTwoQtyReceived=${after.qtyReceived}`)
    assert.equal(after.qtyReceived, 5, 'PRECONDITION: the book-in landed line two')
    assert.equal(after.poStatus, 'RECEIVED', 'both lines have landed')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A5 — THE ARCHIVE READER: getProductIncomingStock
// ───────────────────────────────────────────────────────────────────────────────────────────────
async function incomingFor(productId: string) {
  const { getProductIncomingStock } = await import('@/lib/domain/inventory/product-lifecycle-archive')
  return getProductIncomingStock(productId)
}

test(
  'A5: a PO line landed by alignment is counted ONCE: its outstanding in the purchaseOrders arm, its mirror ASN row not at all',
  SKIP,
  async () => {
    const po = await seedPo('a5', [10])
    const line = po.lines[0]!
    // OPEN is one of the statuses the wmsAsn arm counts, so the mirror row WOULD be counted if not excluded.
    await addAsn(po, line, { expectedQty: 10, status: 'OPEN' })
    const aligned = await alignUp(po, line, { delta: 6, imsQty: 0 })
    assert.equal(aligned.applied, true, `PRECONDITION: 6 of 10 aligned: ${JSON.stringify(aligned)}`)
    assert.equal((await snapshotOf(po, line)).qtyReceived, 0, 'PRECONDITION: qtyReceived is 0')

    const incoming = await incomingFor(line.productId)
    console.log(`# A5: incoming ${JSON.stringify(incoming)}`)
    assert.equal(Number(incoming.purchaseOrders), 4, 'outstanding is qty - landed = 4 (the old arm said 10)')
    assert.equal(Number(incoming.wmsAsn), 0, 'the ASN row mirrors the PO line the first arm counted, so it adds nothing')
    assert.equal(Number(incoming.total), 4, '4 units are still coming, not 14')
  },
)

test(
  'A5 isolating arm: an ASN row whose order is NOT counted above (cancelled, ASN left open) still counts on its own',
  SKIP,
  async () => {
    const po = await seedPo('a5x', [10], 'CANCELLED')
    const line = po.lines[0]!
    await addAsn(po, line, { expectedQty: 10, status: 'OPEN' })
    const incoming = await incomingFor(line.productId)
    assert.equal(Number(incoming.purchaseOrders), 0, 'PRECONDITION: a cancelled order is not in the purchaseOrders arm')
    assert.equal(Number(incoming.wmsAsn), 10, 'the row is the only evidence something is due, so it is NOT excluded')
    console.log('# A5 isolating: evaluated 1 ASN row on a cancelled order')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A5b — THE products.ts INCOMING BADGES (display): ONE ARM PER READER
// ───────────────────────────────────────────────────────────────────────────────────────────────
/** 6 of a 10-unit line landed through alignment; qtyReceived 0. The badge must say 4, not 10. */
async function seedSixOfTenAligned(label: string) {
  const po = await seedPo(label, [10])
  const line = po.lines[0]!
  await addAsn(po, line, { expectedQty: 10, status: 'OPEN' })
  const aligned = await alignUp(po, line, { delta: 6, imsQty: 0 })
  assert.equal(aligned.applied, true, `PRECONDITION: 6 of 10 aligned: ${JSON.stringify(aligned)}`)
  assert.equal((await snapshotOf(po, line)).qtyReceived, 0, 'PRECONDITION: qtyReceived is 0, so qty - qtyReceived says 10')
  return { po, line }
}

test('A5b listProducts: the incoming badge counts what is still on order (4), not 10', SKIP, async () => {
  const { line } = await seedSixOfTenAligned('a5blist')
  const { listProducts } = await import('@/app/actions/products')
  const result = await listProducts({ search: line.sku, type: 'ALL' })
  const row = result.products.find((p) => p.id === line.productId)
  assert.ok(row, 'PRECONDITION: the product is in the list')
  console.log(`# A5b list: incomingStock=${row.incomingStock} over ${result.products.length} listed product(s)`)
  assert.equal(row.incomingStock, '4.00')
})

test('A5b getProduct: the top-level and per-warehouse PO figures count 4, not 10', SKIP, async () => {
  const { po, line } = await seedSixOfTenAligned('a5bget')
  const { getProduct } = await import('@/app/actions/products')
  const detail = await getProduct(line.productId)
  assert.ok(detail, 'PRECONDITION: the product exists')
  const warehouseRow = detail.stockByWarehouse.find((w) => w.warehouseId === po.warehouseId)
  assert.ok(warehouseRow, 'PRECONDITION: the destination warehouse has a row')
  console.log(`# A5b getProduct: incomingStock=${detail.incomingStock} warehouse incomingPoQty=${warehouseRow.incomingPoQty}`)
  assert.equal(warehouseRow.incomingPoQty, '4.00')
  assert.equal(detail.incomingStock, '4.00')
})

test('A5b getProduct variants: a variant\'s incoming badge counts 4, not 10', SKIP, async () => {
  const { line } = await seedSixOfTenAligned('a5bvar')
  const { db } = await import('@/lib/db')
  const parent = await db.product.create({
    data: { sku: `${uid()}-papk-parent`, name: 'papk variable parent', type: 'VARIABLE', countryOfOrigin: 'CN' },
    select: { id: true },
  })
  await db.product.update({ where: { id: line.productId }, data: { parentId: parent.id } })
  const { getProduct } = await import('@/app/actions/products')
  const detail = await getProduct(parent.id)
  assert.ok(detail, 'PRECONDITION: the parent exists')
  const variant = detail.variants.find((v) => v.id === line.productId)
  assert.ok(variant, 'PRECONDITION: the PO product is a variant of the parent')
  console.log(`# A5b variants: variant incomingStock=${variant.incomingStock} over ${detail.variants.length} variant(s)`)
  assert.equal(variant.incomingStock, '4.00')
})

test('A5b getIncomingDetails: the drill-through row says 4, not 10', SKIP, async () => {
  const { po, line } = await seedSixOfTenAligned('a5bdet')
  const { getIncomingDetails } = await import('@/app/actions/products')
  const rows = await getIncomingDetails(line.productId, po.warehouseId)
  console.log(`# A5b details: ${rows.length} row(s) qty=${rows.map((r) => r.qty).join(',')}`)
  assert.equal(rows.length, 1, 'PRECONDITION: one purchase-order row')
  assert.equal(rows[0]!.qty, 4)
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A2c — THE IN-TRANSACTION READ: a credit that lands AFTER the early check but BEFORE the PO lock is granted
// ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Poll the server's own report that a backend is blocked BY `holderPid` on a purchase_orders statement. Keyed on
 * the holder's pid, so another test file's lock waits (CI runs one shared database) can never satisfy it.
 */
async function waitForBackendBlockedBy(holderPid: number, timeoutMs = 20_000): Promise<number> {
  const { db } = await import('@/lib/db')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await db.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND ${holderPid}::int = ANY (pg_blocking_pids(pid))
        AND query ILIKE '%purchase_orders%'`
    if (rows.length > 0) return rows[0]!.pid
    if (Date.now() > deadline) throw new Error(`no backend is blocked by pid ${holderPid} on a purchase_orders statement`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test(
  'A2c: the outstanding check is re-read UNDER the PO lock: a credit committed while the receipt waits for the lock refuses it',
  SKIP,
  async () => {
    const { db } = await import('@/lib/db')
    const po = await seedPo('a2c', [10])
    const line = po.lines[0]!
    const asn = await addAsn(po, line, { expectedQty: 10 })

    let receipt: Promise<{ success: boolean; error?: string }> | null = null
    let blockedPid = 0
    await db.$transaction(async (tx) => {
      // Hold the PO row, so the receipt passes its UNLOCKED early check (landed 0, outstanding 10) and then
      // WAITS for this lock inside its transaction.
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${po.poId} FOR UPDATE`
      const [{ pid: holderPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      receipt = receive(po, line, 10)
      blockedPid = await waitForBackendBlockedBy(holderPid)
      // The credit lands while the receipt is parked: 6 units aligned, exactly as the alignment writes them.
      await tx.wmsAsnLineMap.update({
        where: { id: asn.asnLineMapId },
        data: { qtyAccountedViaSnapshot: { increment: '6.0000' } },
      })
    }, { timeout: 30_000 })
    const result = await receipt!
    const after = await snapshotOf(po, line)
    console.log(`# A2c: receipt parked on backend ${blockedPid}; after the credit committed -> success=${result.success} stock=${after.stock} error=${result.error ?? ''}`)
    assert.ok(blockedPid > 0, 'PRECONDITION: the receipt really was blocked on the PO lock when the credit landed')
    assert.equal(result.success, false, 'the in-transaction read sees the credit and refuses 10 against an outstanding 4')
    assert.match(result.error ?? '', /outstanding qty \(4\)/)
    assert.equal(after.stock, 0, 'no stock moved')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// A8 — detectReceiptTimingConflict (the align-down receipt-timing guard)
// ───────────────────────────────────────────────────────────────────────────────────────────────
test(
  'A8: the receipt-timing conflict counts a PO line as outstanding by LANDED, and not at all once it is fully landed',
  SKIP,
  async () => {
    const { detectReceiptTimingConflict } = await import('@/lib/connectors/mintsoft/sync/stock-sync')
    // POSITIVE CONTROL: a line with units genuinely still due and an open ASN that still expects them: a conflict.
    const open = await seedPo('a8open', [10])
    const openLine = open.lines[0]!
    await addAsn(open, openLine, { expectedQty: 10 })
    const control = await detectReceiptTimingConflict(open.binding as never, openLine.productId, 3)
    assert.match(String(control), /still has 10 pending receipt/, 'PRECONDITION (control): an outstanding line with an open ASN IS a timing conflict')

    // FULLY LANDED through alignment (qtyReceived 0): nothing is due, so no timing conflict.
    const landedPo = await seedPo('a8landed', [10])
    const landedLine = landedPo.lines[0]!
    await addAsn(landedPo, landedLine, { expectedQty: 10, viaSnapshot: 10 })
    // The row's own remainingExpected (expected - lastProcessedReceivedQty = 10) is positive, so ONLY the
    // line's outstanding quantity can say "nothing due".
    const landedVerdict = await detectReceiptTimingConflict(landedPo.binding as never, landedLine.productId, 3)
    assert.equal((await snapshotOf(landedPo, landedLine)).qtyReceived, 0, 'PRECONDITION: qtyReceived is 0')
    assert.equal(landedVerdict, null, 'a fully landed line is not "still due in"')

    // A CANCELLED order expects nothing either.
    const cancelled = await seedPo('a8cancel', [10], 'CANCELLED')
    const cancelledLine = cancelled.lines[0]!
    await addAsn(cancelled, cancelledLine, { expectedQty: 10 })
    assert.equal(await detectReceiptTimingConflict(cancelled.binding as never, cancelledLine.productId, 3), null)
    console.log('# A8: evaluated 3 lines (1 control, 1 fully landed, 1 cancelled)')
  },
)

// ───────────────────────────────────────────────────────────────────────────────────────────────
// C3 — THE ALIGNMENT ADVANCES THE ORDER'S STATUS FROM WHAT HAS LANDED (Codex MEDIUM)
// ───────────────────────────────────────────────────────────────────────────────────────────────
async function poRow(po: SeededPo) {
  const { db } = await import('@/lib/db')
  return db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { status: true, receivedAt: true } })
}

test(
  'C3-1: a purchase order completed ONLY by alignment becomes PARTIALLY_RECEIVED, then RECEIVED with receivedAt set',
  SKIP,
  async () => {
    const po = await seedPo('c31', [10, 5])
    const [l1, l2] = [po.lines[0]!, po.lines[1]!]
    await addAsn(po, l1, { expectedQty: 10, status: 'OPEN' })
    await addAsn(po, l2, { expectedQty: 5, status: 'OPEN' })
    const start = await poRow(po)
    assert.equal(start.status, 'PO_SENT', 'PRECONDITION: the order starts PO_SENT')

    const first = await alignUp(po, l1, { delta: 10, imsQty: 0 })
    assert.equal(first.applied, true, `PRECONDITION: line one aligned: ${JSON.stringify(first)}`)
    const afterFirst = await poRow(po)
    assert.equal((await snapshotOf(po, l1)).qtyReceived, 0, 'PRECONDITION: line one has qtyReceived 0 (landed through alignment only)')
    assert.equal(afterFirst.status, 'PARTIALLY_RECEIVED', 'one of two lines has landed')
    assert.equal(afterFirst.receivedAt, null, 'not received yet')

    const second = await alignUp(po, l2, { delta: 5, imsQty: 0 })
    assert.equal(second.applied, true, `PRECONDITION: line two aligned: ${JSON.stringify(second)}`)
    assert.equal((await snapshotOf(po, l2)).qtyReceived, 0, 'PRECONDITION: line two has qtyReceived 0 as well (every line landed through alignment only)')
    const afterSecond = await poRow(po)
    console.log(`# C3-1: status after line one ${afterFirst.status}, after line two ${afterSecond.status}, receivedAt ${afterSecond.receivedAt ? 'set' : 'null'}`)
    assert.equal(afterSecond.status, 'RECEIVED', 'every line has landed: the order is RECEIVED')
    assert.notEqual(afterSecond.receivedAt, null, 'receivedAt is set')
    console.log('# C3-1: evaluated 2 alignments on a 2-line order')
  },
)

test(
  'C3-2: the alignment never regresses an order: a RECEIVED order whose lines read partly landed stays RECEIVED',
  SKIP,
  async () => {
    const { db } = await import('@/lib/db')
    const po = await seedPo('c32', [10])
    const line = po.lines[0]!
    await addAsn(po, line, { expectedQty: 10, status: 'OPEN' })
    // The shape that would regress: an order already past PARTIALLY_RECEIVED (here RECEIVED, e.g. closed out by
    // an operator) while the line has room left. The derivation says PARTIALLY_RECEIVED; the workflow must refuse it.
    await db.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'RECEIVED', receivedAt: new Date('2026-01-01T00:00:00Z') } })

    const aligned = await alignUp(po, line, { delta: 4, imsQty: 0 })
    assert.equal(aligned.applied, true, `PRECONDITION: the alignment applied (4 of 10 landed): ${JSON.stringify(aligned)}`)
    assert.equal((await snapshotOf(po, line)).stock, 4, 'PRECONDITION: 4 units are in stock')
    const after = await poRow(po)
    console.log(`# C3-2: status ${after.status} after a partial alignment on a RECEIVED order`)
    assert.equal(after.status, 'RECEIVED', 'RECEIVED is not regressed to PARTIALLY_RECEIVED')
    assert.equal(after.receivedAt?.toISOString(), '2026-01-01T00:00:00.000Z', 'receivedAt is untouched')
    console.log('# C3-2: evaluated 1 forward-only guard')
  },
)

test(
  'C3-3: a partial alignment moves PO_SENT to PARTIALLY_RECEIVED (and an order that is not receivable is left alone)',
  SKIP,
  async () => {
    const { db } = await import('@/lib/db')
    const po = await seedPo('c33', [10])
    const line = po.lines[0]!
    await addAsn(po, line, { expectedQty: 10, status: 'OPEN' })
    const aligned = await alignUp(po, line, { delta: 4, imsQty: 0 })
    assert.equal(aligned.applied, true, `PRECONDITION: applied: ${JSON.stringify(aligned)}`)
    assert.equal((await poRow(po)).status, 'PARTIALLY_RECEIVED', '4 of 10 landed: PARTIALLY_RECEIVED')

    const invoiced = await seedPo('c33i', [10])
    const invoicedLine = invoiced.lines[0]!
    await addAsn(invoiced, invoicedLine, { expectedQty: 10, status: 'OPEN' })
    await db.purchaseOrder.update({ where: { id: invoiced.poId }, data: { status: 'INVOICED' } })
    const second = await alignUp(invoiced, invoicedLine, { delta: 10, imsQty: 0 })
    assert.equal(second.applied, true, `PRECONDITION: applied against the invoiced order: ${JSON.stringify(second)}`)
    assert.equal((await poRow(invoiced)).status, 'INVOICED', 'INVOICED has no path back to RECEIVED: left alone')
    console.log('# C3-3: evaluated 2 orders (PO_SENT -> PARTIALLY_RECEIVED, INVOICED untouched)')
  },
)
