import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

import type { WmsCreateClaimOutcome } from '../../lib/domain/wms/order-push-sweep.ts'

/**
 * o3d-5r8 — the hard-delete / posting-claim protocol, proven against a real Postgres.
 *
 * deleteSalesOrder destroys the only IMS handle on anything a posting worker has put (or
 * is about to put) in an external system. The protocol is that both sides take the order's
 * row lock: the WMS push sweep claims a WmsOrderPushLink under the lock BEFORE it calls the
 * WMS, and the deleter checks for that link under the same lock before it deletes.
 *
 * The forbidden outcome is "claim succeeded AND the order was deleted" — that is exactly the
 * state where the WMS ends up holding an order IMS has no record of. This test races the two
 * paths head-on and asserts that outcome never occurs, in both interleavings.
 *
 * o3d-2k5r r4 WIDENED `claimForCreate` FROM A BOOLEAN TO {@link WmsCreateClaimOutcome}, AND THIS
 * TEST WENT ON READING IT AS ONE. `assert.equal(claimed, true)` then failed on the very outcome it
 * was asserting (`'CLAIMED' !== true`), and — far worse — the invariant above it,
 * `!(claimed && !orderExists)`, became a tautology in the wrong direction: EVERY member of the
 * union is a truthy string, so the check collapsed to `orderExists` and no longer said anything
 * about whether the claim had won. A test that reads a widened type through boolean coercion does
 * not fail loudly at the widening; it fails at whichever assertion happened to compare against a
 * literal, and the ones that only coerced go on "passing" while testing nothing.
 *
 * SO THE WIN IS DECIDED BY A TOTAL MAP OVER THE UNION, not by a truthiness test and not by
 * `!== 'CLAIMED'`. `CLAIM_IS_A_WIN` is a `Record<WmsCreateClaimOutcome, boolean>`, so the next
 * outcome added to the contract cannot compile until somebody has decided whether it means the
 * claim won this race — and an answer that is not a member of the union at all reads as
 * `undefined` and is refused at runtime rather than silently counted as a loss.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1 (needs a real Postgres). Every order it creates is
 * removed in a finally block.
 */
/**
 * Does this outcome mean the claim WON the race — i.e. a remote WMS create is now about to be made
 * on the strength of it?
 *
 * Total over the union on purpose: `Record<WmsCreateClaimOutcome, boolean>` does not compile until
 * every member has an answer, so a fourth outcome is a build failure here rather than a silent
 * "not CLAIMED, so it lost".
 */
const CLAIM_IS_A_WIN: Record<WmsCreateClaimOutcome, boolean> = {
  CLAIMED: true,
  // The order was gone, the link had moved on, or another worker's claim was still live.
  SKIPPED: false,
  // Someone else's LAPSED claim was parked as AMBIGUOUS_CREATE. Nothing is pushed for it either.
  PARKED_AMBIGUOUS: false,
}

test(
  'hard delete vs WMS create claim: exactly one wins, never both',
  { skip: process.env.RUN_DB_CONCURRENCY_TESTS !== '1' },
  async () => {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')

    const { db } = await import('../../lib/db/index.ts')
    const { createPrismaWmsOrderPushPort } = await import('../../lib/domain/wms/order-push-sweep.ts')
    const { findSalesOrderDeleteBlocker } = await import('../../lib/domain/sales/order-delete-guard.ts')

    const port = createPrismaWmsOrderPushPort()
    const outcomes: string[] = []

    // Alternate which contender reaches the lock first so both interleavings are exercised.
    for (const deleterHeadStartMs of [0, 0, 40, 40]) {
      const order = await db.salesOrder.create({
        data: {
          orderNumber: `o3d-5r8-concurrency-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          subtotalForeign: 0, totalForeign: 0, subtotalBase: 0, totalBase: 0,
        },
        select: { id: true },
      })
      try {
        // Mirrors deleteSalesOrder's transaction: lock, guard, delete — all under one lock.
        const deleter = (async () => {
          if (deleterHeadStartMs === 0) await new Promise((r) => setTimeout(r, 25))
          return db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${order.id} FOR UPDATE`
            // Widen the window: without the lock this is where a claim would slip in.
            await new Promise((r) => setTimeout(r, 30))
            const blocker = await findSalesOrderDeleteBlocker(tx, order.id, {
              revenueDeferredDate: null,
              inventoryAllocatedDate: null,
              revenueDeferredBatchRef: null,
              inventoryAllocatedBatchRef: null,
            })
            if (blocker) return 'refused' as const
            await tx.salesOrder.delete({ where: { id: order.id } })
            return 'deleted' as const
          })
        })()
        const claimer = (async () => {
          if (deleterHeadStartMs > 0) await new Promise((r) => setTimeout(r, deleterHeadStartMs))
          return port.claimForCreate(order.id, 'mintsoft', new Date())
        })()

        const [deleteOutcome, claim] = await Promise.all([deleter, claimer])
        outcomes.push(deleteOutcome)

        const orderExists = (await db.salesOrder.count({ where: { id: order.id } })) > 0
        const linkExists = (await db.wmsOrderPushLink.count({ where: { orderId: order.id } })) > 0

        const claimWon = CLAIM_IS_A_WIN[claim]
        assert.equal(
          typeof claimWon,
          'boolean',
          `claimForCreate answered ${JSON.stringify(claim)}, which is not a WmsCreateClaimOutcome this test knows — ` +
            `decide whether it wins the race against a hard delete before widening the contract again`,
        )

        // THE invariant: a WON claim means a remote WMS create is about to happen, so the order
        // must still be there to hold the resulting link. This is the assertion that has to fail
        // when both sides win, and it is the one the boolean reading had quietly disabled.
        assert.ok(!(claimWon && !orderExists), 'claimed a deleted order — the WMS would be handed an orphan')

        if (deleteOutcome === 'deleted') {
          assert.equal(orderExists, false, 'delete committed')
          assert.equal(claimWon, false, 'the claim must lose once the delete has committed')
          // WHICH loss, specifically. A delete that committed leaves no link behind, and
          // PARKED_AMBIGUOUS is written only over a LAPSED claim of someone else's — so the only
          // way to lose this race is SKIPPED. Asserting the member rather than `claimWon === false`
          // keeps the park from becoming an accepted answer here without anyone noticing.
          assert.equal(claim, 'SKIPPED', 'losing to a committed delete is a SKIP, never a park')
          assert.equal(linkExists, false, 'no link may survive a delete')
        } else {
          assert.equal(claim, 'CLAIMED', 'the delete only refuses because the claim won')
          assert.equal(orderExists, true, 'a refused delete leaves the order intact')
          assert.equal(linkExists, true, 'the winning claim persisted its link')
        }
      } finally {
        await db.wmsOrderPushLink.deleteMany({ where: { orderId: order.id } })
        await db.salesOrder.deleteMany({ where: { id: order.id } })
      }
    }

    // Both interleavings really happened — otherwise the test proves only half the protocol.
    assert.ok(outcomes.includes('deleted'), `expected at least one delete to win, got ${outcomes.join(',')}`)
    assert.ok(outcomes.includes('refused'), `expected at least one claim to win, got ${outcomes.join(',')}`)
  },
)
