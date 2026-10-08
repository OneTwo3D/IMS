import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OutboundWriteHeldError, outboundWriteRefusal } from '../lib/security/outbound-write-grant'

/**
 * A partial-shipment push refused by the outbound-write hold must not count as a dispatch reconcile
 * failure: five of them in a row dead-letter the link and bell-notify every admin, about a cause (a
 * hold) that has nothing to do with the order. The real recordDispatchError is driven with a recording
 * database double; the held text is produced by the real refusal path.
 */

type Update = { where: unknown; data: Record<string, unknown> }
const updates: Update[] = []
let failureCount = 0

const linkTable = {
  update: async (args: Update) => {
    updates.push(args)
    const increment = (args.data.dispatchFailureCount as { increment?: number } | undefined)?.increment
    if (increment) failureCount += increment
    return { dispatchFailureCount: failureCount, dispatchDeadLetteredAt: null }
  },
  updateMany: async (args: Update) => { updates.push(args); return { count: 1 } },
}

mock.module('@/lib/db', { namedExports: { db: { wmsOrderPushLink: linkTable, activityLog: { create: async () => ({}) } } } })

function heldText(): string {
  const refusal = outboundWriteRefusal({ connectorName: 'WooCommerce', method: 'POST', url: 'https://shop.example.com/wp-json/oti/v1/order/1/partial-shipment', env: {} })
  assert.ok(refusal)
  return new OutboundWriteHeldError(refusal, 0).message
}

test('a held partial-shipment push records its reason, spends no dispatch failure and never dead-letters; an ordinary failure does count', async () => {
  const { createPrismaDispatchDeps, DISPATCH_MAX_CONSECUTIVE_FAILURES } = await import('../lib/domain/wms/dispatch-sweep')
  const deps = createPrismaDispatchDeps('mintsoft' as never, {} as never)
  const candidate = { linkId: 'link-1', externalOrderNumber: 'MS-1' } as never
  console.log(`precondition (dispatch streak): threshold ${DISPATCH_MAX_CONSECUTIVE_FAILURES}; ${DISPATCH_MAX_CONSECUTIVE_FAILURES * 3} held failures follow, then one ordinary failure as the control`)

  for (let i = 0; i < DISPATCH_MAX_CONSECUTIVE_FAILURES * 3; i += 1) {
    const result = await deps.recordDispatchError(candidate, `Partial-shipment push failed for part 1: ${heldText()}`)
    assert.deepEqual(result, { deadLettered: false })
  }
  assert.equal(failureCount, 0, 'no failure was spent by any held write')
  assert.ok(updates.every((update) => !('dispatchFailureCount' in update.data)), 'and none was even incremented')
  assert.match(String(updates.at(-1)?.data.dispatchLastError), /Outbound write HELD/, 'the reason is still recorded')

  await deps.recordDispatchError(candidate, 'HTTP 500: boom')
  assert.equal(failureCount, 1, 'the control: an ordinary failure DOES count')
})
