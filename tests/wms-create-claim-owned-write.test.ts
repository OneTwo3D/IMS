import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * The REAL Prisma port's claim-owned compare-and-set: the write must be conditional on the link still being
 * PENDING_CREATE and still carrying the exact stamp the worker wrote at claim time, and must report whether
 * it matched. Driven against a recording database double (the predicate is what is under test).
 */

const calls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []
let matched = 1

mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsOrderPushLink: {
        updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => { calls.push(args); return { count: matched } },
      },
    },
  },
})

test('updateLinkIfCreateClaimOwned is predicated on orderId, PENDING_CREATE and the exact claim stamp, and reports a miss', async () => {
  const { createPrismaWmsOrderPushPort } = await import('../lib/domain/wms/order-push-sweep')
  const port = createPrismaWmsOrderPushPort()
  const stamp = new Date('2026-06-26T00:00:00.000Z')
  console.log('precondition (owned CAS): one update that matches, one that does not')
  matched = 1
  assert.equal(await port.updateLinkIfCreateClaimOwned!('order-1', stamp, { lastAttemptAt: null }), true)
  matched = 0
  assert.equal(await port.updateLinkIfCreateClaimOwned!('order-1', stamp, { lastAttemptAt: null }), false, 'a newer claim matches nothing: reported as not owned')
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.deepEqual(call.where, { orderId: 'order-1', state: 'PENDING_CREATE', lastAttemptAt: stamp })
  }
})
