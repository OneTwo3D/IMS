import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { computeRefundRemainders, raiseRefundRemainderTasks, type RefundRemainderDeps } from '@/lib/domain/wms/refund-remainder'

// o3d-2q9vp: ordered 10, 8 shipped, 2 shipped units returned and refunded. The push sends ordered - GROSS refund = 8 (all gone), IMS still owes 2.
const line = { id: 'l1', sku: 'RED', productId: 'p1', qty: 10 }
const maps = (gross: number, netted: number, shipped: number | null) => ({
  lines: [line],
  grossRefundedByLine: new Map([['l1', gross]]),
  nettedRefundedByLine: new Map([['l1', netted]]),
  shippedByLine: shipped === null ? new Map() : new Map([['l1', shipped]]),
})

test('the example: 10 ordered, 8 shipped, 2 returned and refunded -> ask the warehouse for the remaining 2', () => {
  assert.deepEqual(computeRefundRemainders(maps(2, 0, 8)), [{ sku: 'RED', quantity: 2 }])
})

test('no remainder when the push and IMS agree: a cancellation (unshipped refund), or nothing returned', () => {
  assert.deepEqual(computeRefundRemainders(maps(2, 2, 0)), [])
  assert.deepEqual(computeRefundRemainders(maps(0, 0, 8)), [])
})

test('the warehouse order will still send what it has not despatched: only the shortfall is asked for', () => {
  // ordered 10, 4 shipped, 2 returned: pushed 8, 4 left to send by itself; IMS owes 6 -> asks for 2.
  assert.deepEqual(computeRefundRemainders(maps(2, 0, 4)), [{ sku: 'RED', quantity: 2 }])
})

test('a line whose shipped units cannot be counted (a kit) is skipped, and fee lines never count', () => {
  assert.deepEqual(computeRefundRemainders(maps(2, 0, null)), [])
  assert.deepEqual(computeRefundRemainders({ ...maps(2, 0, 8), lines: [{ ...line, sku: null }] }), [])
})

function deps(over: Partial<RefundRemainderDeps> = {}) {
  const raised: Array<Record<string, unknown>> = []
  const d: RefundRemainderDeps = {
    isEnabled: async () => true,
    candidates: async () => [{ orderId: 'o1', orderNumber: 'SO-1', externalOrderId: 'MS-1', externalOrderNumber: 'W-1', lines: [line] }],
    refundTotals: async () => ({ gross: new Map([['l1', 2]]), netted: new Map([['l1', 0]]) }),
    shipped: async () => new Map([['l1', 8]]),
    raise: async (task) => { raised.push(task as unknown as Record<string, unknown>); return true },
    ...over,
  }
  return { d, raised }
}

test('raises ONE REFUND_REMAINDER_DUE task with the SKU and quantity, and changes no quantity (there is no push call in this path)', async () => {
  const { d, raised } = deps()
  assert.deepEqual(await raiseRefundRemainderTasks('mintsoft', 50, d), { raised: 1, failed: 0 })
  assert.equal(raised[0]!.reason, 'REFUND_REMAINDER_DUE')
  assert.equal(raised[0]!.externalOrderId, 'MS-1')
  assert.match(String(raised[0]!.queryText), /2 x RED/)
  assert.match(String(raised[0]!.queryText), /changed no quantity/)
})

test('off by default: no read, no task; one failing order does not stop the others', async () => {
  const off = deps({ isEnabled: async () => false, candidates: async () => { throw new Error('must not read') } })
  assert.deepEqual(await raiseRefundRemainderTasks('mintsoft', 50, off.d), { raised: 0, failed: 0 })
  const mixed = deps({
    candidates: async () => [
      { orderId: 'bad', orderNumber: null, externalOrderId: 'X', externalOrderNumber: null, lines: [line] },
      { orderId: 'o1', orderNumber: 'SO-1', externalOrderId: 'MS-1', externalOrderNumber: null, lines: [line] },
    ],
    refundTotals: async (id) => { if (id === 'bad') throw new Error('boom'); return { gross: new Map([['l1', 2]]), netted: new Map() } },
  })
  const origError = console.error
  console.error = () => undefined
  try {
    // the failing order is COUNTED (the sweep reports it into the cron outcome), and the others still raise
    assert.deepEqual(await raiseRefundRemainderTasks('mintsoft', 50, mixed.d), { raised: 1, failed: 1 })
  } finally { console.error = origError }
})

test('a partly delivered remainder (shipped 8 then 9) is the SAME task per order and SKU, not a second "send 1" task', async () => {
  const seen = new Set<string>()
  const basisOf = async (shipped: number) => {
    const { d, raised } = deps({ shipped: async () => new Map([['l1', shipped]]) })
    await raiseRefundRemainderTasks('mintsoft', 50, d)
    return String(raised[0]!.dedupeBasis)
  }
  seen.add(await basisOf(8))
  seen.add(await basisOf(9))
  assert.equal(seen.size, 1)
})

test('a cursor pages through the orders: the next sweep continues after the last one examined, and wraps at the end', async () => {
  const all = ['o1', 'o2', 'o3', 'o4', 'o5']
  let cursor: string | null = null
  const asked: Array<string | null | undefined> = []
  const examined: string[] = []
  const { d } = deps({
    candidates: async (_c, limit, after) => {
      asked.push(after)
      return all.filter((id) => !after || id > after).slice(0, limit).map((orderId) => ({ orderId, orderNumber: orderId, externalOrderId: `MS-${orderId}`, externalOrderNumber: null, lines: [line] }))
    },
    refundTotals: async (id) => { examined.push(id); return { gross: new Map(), netted: new Map() } },
    readCursor: async () => cursor,
    writeCursor: async (_c, id) => { cursor = id },
  })
  await raiseRefundRemainderTasks('mintsoft', 2, d)
  await raiseRefundRemainderTasks('mintsoft', 2, d)
  await raiseRefundRemainderTasks('mintsoft', 2, d)
  await raiseRefundRemainderTasks('mintsoft', 2, d)
  assert.deepEqual(examined, ['o1', 'o2', 'o3', 'o4', 'o5', 'o1', 'o2'], 'the newest orders are reached, and the sweep wraps')
})

test('MEDIUM 3: a second genuine remainder on the same SKU raises a task even though the first one is done (the episode, not the SKU alone, is the dedupe key)', async () => {
  // A raise that behaves like the real one: the unique content hash is checked against EVERY earlier task, open or done.
  const seen = new Set<string>()
  const raise = async (task: { reason: string; dedupeBasis?: string; queryText: string }) => {
    const hash = createHash('sha256').update(`${task.reason}\n${task.dedupeBasis ?? task.queryText}`).digest('hex')
    if (seen.has(hash)) return false
    seen.add(hash)
    return true
  }
  // Episode 1: ordered 10, 8 shipped, 2 returned and refunded.
  const first = deps({ raise })
  assert.deepEqual(await raiseRefundRemainderTasks('mintsoft', 50, first.d), { raised: 1, failed: 0 })
  // The same facts again (and a partly delivered remainder): still the one task.
  assert.deepEqual(await raiseRefundRemainderTasks('mintsoft', 50, deps({ raise, shipped: async () => new Map([['l1', 9]]) }).d), { raised: 0, failed: 0 })
  // Episode 2: one MORE shipped unit comes back and is refunded (gross 2 -> 3, 7 now shipped-and-kept): a new task.
  const second = deps({ raise, refundTotals: async () => ({ gross: new Map([['l1', 3]]), netted: new Map([['l1', 0]]) }) })
  assert.deepEqual(await raiseRefundRemainderTasks('mintsoft', 50, second.d), { raised: 1, failed: 0 })
})
