import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { liveMintsoftBookedInAsnRef } from '@/tests/helpers/live-mintsoft-asn-ref'
import * as fixtures from './po-landed-fixtures'
import type { SeededAsn, SeededLine, SeededPo } from './po-landed-fixtures'

/**
 * o3d-papk (round 2, Codex HIGH) — A BOOK-IN MUST NOT RECEIVE AGAINST AN ORDER THAT EXPECTS NOTHING MORE, AND MUST
 * NEVER WRITE A PURCHASE-ORDER STATUS THE WORKFLOW DOES NOT ALLOW.
 *
 * `processBookedInEvent` read the order's status and never asked whether it could be received against. A partly
 * received order cancelled while its ASN stayed open took stock, a cost layer and a journal from a later Mintsoft
 * callback and then had CANCELLED overwritten with PARTIALLY_RECEIVED / RECEIVED. The alignment and the manual
 * receipt already refuse that state (bead o3d-yaazk). The callback is now HELD FOR REVIEW with an approval-blocked
 * warning (`parent_not_receivable`) — the existing mechanism a structurally wrong callback goes through, which an
 * operator cannot approve away — and any status write goes through `validatePurchaseOrderStatusTransition`.
 *
 * Real `receivePurchaseOrder` and `processBookedInEvent` over a real PostgreSQL; Mintsoft is never contacted.
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
mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { recordWmsMutationEvent: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async () => {}, logActivityInTransaction: async () => {} },
})
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

const { loadEnv, enableStockReceiptPosting, uid, seedPo, addAsn, receive, snapshotOf } = fixtures

test.before(async () => {
  if (!RUN) return
  loadEnv()
  await enableStockReceiptPosting()
})

async function bookInEvent(asn: SeededAsn, line: SeededLine, expectedQty: number, bookedQty: number) {
  const { db } = await import('@/lib/db')
  const { processBookedInEvent } = await import('@/lib/domain/wms/booked-in-service')
  const event = await db.wmsInboundReceiptEvent.create({
    data: {
      connector: 'mintsoft', // wms-connector-boundary-ok: o3d-papk: a test fixture row, not a core flow branch
      externalEventId: `${uid()}-evt`,
      externalAsnId: asn.externalAsnId,
      payload: { asnId: asn.externalAsnId },
    },
    select: { id: true },
  })
  const remote = liveMintsoftBookedInAsnRef({
    externalAsnId: asn.externalAsnId,
    externalLineId: asn.externalAsnLineId,
    sourceLineId: line.poLineId,
    sku: line.sku,
    expectedQty,
    bookedQty,
  })
  const fetchRemoteAsn = async () => ({ ...remote, status: 'RECEIVED', raw: null })
  return {
    eventId: event.id,
    first: await processBookedInEvent(event.id, { fetchRemoteAsn }),
    approve: () => processBookedInEvent(event.id, { fetchRemoteAsn, approveReview: true }),
  }
}

async function poRow(po: SeededPo) {
  const { db } = await import('@/lib/db')
  return db.purchaseOrder.findUniqueOrThrow({ where: { id: po.poId }, select: { status: true, receivedAt: true } })
}

/** A line of 10 with 4 received by hand (so the order is PARTIALLY_RECEIVED) and an OPEN ASN expecting the other 6. */
async function seedPartlyReceivedWithOpenAsn(label: string) {
  const po = await seedPo(label, [10])
  const line = po.lines[0]!
  const manual = await receive(po, line, 4)
  assert.equal(manual.success, true, `PRECONDITION: the manual 4 is accepted: ${manual.error}`)
  const asn = await addAsn(po, line, { expectedQty: 6, status: 'OPEN' })
  // The row is sized for what was outstanding AFTER the manual 4, which is exactly what the creators record in
  // `manualQtyBaseline` (o3d-67kw3); the fixture inserts the row directly, so it states that here.
  const { db } = await import('@/lib/db')
  await db.wmsAsnLineMap.update({ where: { id: asn.asnLineMapId }, data: { manualQtyBaseline: '4.0000' } })
  const before = await snapshotOf(po, line)
  assert.equal(before.stock, 4, 'PRECONDITION: 4 in stock')
  assert.equal(before.poStatus, 'PARTIALLY_RECEIVED', 'PRECONDITION: the order is PARTIALLY_RECEIVED')
  return { po, line, asn, before }
}

for (const terminal of ['CANCELLED', 'CLOSED'] as const) {
  test(
    `R2-1 ${terminal}: a callback against a ${terminal} order is held for REVIEW, adds no stock, layer or journal, and the status is NOT overwritten`,
    SKIP,
    async () => {
      const { db } = await import('@/lib/db')
      const { po, line, asn, before } = await seedPartlyReceivedWithOpenAsn(`r21${terminal.toLowerCase()}`)
      await db.purchaseOrder.update({ where: { id: po.poId }, data: { status: terminal } })
      assert.equal((await poRow(po)).status, terminal, `PRECONDITION: the order is ${terminal} while its ASN stays open`)

      const booked = await bookInEvent(asn, line, 6, 6)
      const after = await snapshotOf(po, line)
      console.log(`# R2-1 ${terminal}: book-in -> ${booked.first.status}; stock ${before.stock}->${after.stock} layers ${before.layerCount}->${after.layerCount} journals ${before.journals}->${after.journals} qtyReceived ${before.qtyReceived}->${after.qtyReceived} poStatus ${after.poStatus}`)
      assert.equal(booked.first.status, 'requires_review', 'the callback is routed to review')
      const warnings = booked.first.status === 'requires_review' ? booked.first.dryRun.warnings : []
      assert.deepEqual(warnings, ['parent_not_receivable'], 'with the named, approval-blocked warning')
      assert.equal(after.stock, before.stock, 'NO stock was added')
      assert.equal(after.layerCount, before.layerCount, 'no cost layer')
      assert.equal(after.journals, before.journals, 'no journal')
      assert.equal(after.qtyReceived, before.qtyReceived, 'qtyReceived untouched')
      assert.equal(after.poStatus, terminal, `${terminal} is NOT overwritten`)

      const approved = await booked.approve()
      const afterApprove = await snapshotOf(po, line)
      assert.equal(approved.status, 'requires_review', 'an operator cannot approve it away: the warning is approval-blocked')
      assert.equal(afterApprove.stock, before.stock, 'still no stock after the attempted approval')
      assert.equal(afterApprove.poStatus, terminal)
      console.log(`# R2-1 ${terminal}: evaluated 1 callback + 1 attempted approval`)
    },
  )
}

test(
  'R2-2: a status the workflow does not allow is never written: an INVOICED order keeps INVOICED when a late book-in lands its units',
  SKIP,
  async () => {
    const { db } = await import('@/lib/db')
    const { po, line, asn, before } = await seedPartlyReceivedWithOpenAsn('r22')
    await db.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'INVOICED' } })

    const booked = await bookInEvent(asn, line, 6, 6)
    const after = await snapshotOf(po, line)
    console.log(`# R2-2: book-in -> ${booked.first.status}; stock ${before.stock}->${after.stock}; poStatus ${after.poStatus}`)
    assert.equal(booked.first.status, 'processed', `PRECONDITION: an INVOICED order is receivable and the book-in processed: ${JSON.stringify(booked.first)}`)
    assert.equal(after.stock, 10, 'PRECONDITION: the 6 units landed (the stock is recorded either way)')
    assert.equal(after.poStatus, 'INVOICED', 'INVOICED has no path to RECEIVED: it is not overwritten')
    console.log('# R2-2: evaluated 1 book-in against an INVOICED order')
  },
)

test(
  'R2-3 control: an ordinary PARTIALLY_RECEIVED order still receives and still advances to RECEIVED',
  SKIP,
  async () => {
    const { po, line, asn, before } = await seedPartlyReceivedWithOpenAsn('r23')
    const booked = await bookInEvent(asn, line, 6, 6)
    const after = await snapshotOf(po, line)
    assert.equal(booked.first.status, 'processed', `the book-in processed: ${JSON.stringify(booked.first)}`)
    assert.equal(after.stock, before.stock + 6)
    assert.equal(after.poStatus, 'RECEIVED')
    assert.notEqual((await poRow(po)).receivedAt, null, 'receivedAt set on the transition')
    console.log('# R2-3: evaluated 1 control receipt')
  },
)
