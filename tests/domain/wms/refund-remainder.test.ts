import assert from 'node:assert/strict'
import test from 'node:test'
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
  assert.equal(await raiseRefundRemainderTasks('mintsoft', 50, d), 1)
  assert.equal(raised[0]!.reason, 'REFUND_REMAINDER_DUE')
  assert.equal(raised[0]!.externalOrderId, 'MS-1')
  assert.match(String(raised[0]!.queryText), /2 x RED/)
  assert.match(String(raised[0]!.queryText), /changed no quantity/)
})

test('off by default: no read, no task; one failing order does not stop the others', async () => {
  const off = deps({ isEnabled: async () => false, candidates: async () => { throw new Error('must not read') } })
  assert.equal(await raiseRefundRemainderTasks('mintsoft', 50, off.d), 0)
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
    assert.equal(await raiseRefundRemainderTasks('mintsoft', 50, mixed.d), 1)
  } finally { console.error = origError }
})
