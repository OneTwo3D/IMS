import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'

// Bulk actions for the sales-order list: per-row outcomes, the cap, the permission refusal, that
// bulk Advance drives the very services the order page's buttons call, and that print reads only
// the selected orders. Services and database are mocked; the guard (requirePermission) is real.

let role = 'ADMIN'
mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role, supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false },
    }),
  },
})

type Order = { id: string; orderNumber: string | null; externalOrderNumber: string | null; status: string; archived: boolean }
let orders: Order[] = []
let trackingValue: string | null = null
const findManyCalls: unknown[] = []
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findMany: async (args: { where: { id: { in: string[] } } }) => {
          findManyCalls.push(args)
          return orders.filter((o) => args.where.id.in.includes(o.id))
        },
      },
      setting: { findUnique: async () => (trackingValue === null ? null : { value: trackingValue }) },
    },
  },
})

const allocateCalls: Array<[string, unknown]> = []
const statusCalls: Array<[string, string]> = []
let allocateImpl: (id: string) => Promise<Record<string, unknown>> = async () => ({ success: true, syncProductIds: ['p1'], unallocatedQty: 0 })
let statusImpl: (id: string, target: string) => Promise<{ success: boolean; error?: string }> = async () => ({ success: true })
mock.module('@/app/actions/allocation', {
  namedExports: { autoAllocateOrder: async (id: string, opts: unknown) => { allocateCalls.push([id, opts]); return allocateImpl(id) } },
})
mock.module('@/app/actions/sales', {
  namedExports: { updateSalesOrderStatus: async (id: string, target: string) => { statusCalls.push([id, target]); return statusImpl(id, target) } },
})

const order = (id: string, status: string, extra: Partial<Order> = {}): Order => ({ id, orderNumber: `SO-${id}`, externalOrderNumber: null, status, archived: false, ...extra })

beforeEach(() => {
  role = 'ADMIN'
  orders = []
  trackingValue = null
  findManyCalls.length = 0
  allocateCalls.length = 0
  statusCalls.length = 0
  allocateImpl = async () => ({ success: true, syncProductIds: ['p1'], unallocatedQty: 0 })
  statusImpl = async () => ({ success: true })
})

test('bulk allocate: mixed selection reports done, skipped and failed per row and keeps going', async () => {
  orders = [order('a', 'PROCESSING'), order('b', 'ALLOCATED'), order('c', 'PROCESSING'), order('d', 'DRAFT'), order('e', 'PROCESSING')]
  allocateImpl = async (id) => {
    if (id === 'c') return { success: false, error: 'Error: No stock available in any warehouse', allocationCount: 0 }
    if (id === 'e') throw new Error('boom')
    return { success: true, syncProductIds: ['p1', 'p2'], unallocatedQty: 0 }
  }
  const { bulkAllocateSalesOrders } = await import('@/app/actions/sales-bulk')
  const res = await bulkAllocateSalesOrders(['a', 'b', 'c', 'd', 'e', 'ghost'])
  assert.ok(res.ok)
  const by = Object.fromEntries(res.results.map((r) => [r.id, r]))
  assert.equal(by.a.outcome, 'done')
  assert.equal(by.b.outcome, 'skipped')
  assert.match(by.b.message, /Already allocated/)
  assert.equal(by.c.outcome, 'failed')
  assert.equal(by.c.message, 'No stock available in any warehouse.')
  assert.equal(by.d.outcome, 'skipped')
  assert.match(by.d.message, /draft/)
  assert.equal(by.e.outcome, 'failed', 'a throwing order does not stop the run')
  assert.equal(by.ghost.outcome, 'failed')
  assert.deepEqual(res.counts, { done: 1, skipped: 2, failed: 3 })
  assert.deepEqual(allocateCalls.map((c) => c[0]), ['a', 'c', 'e'], 'only eligible orders reach the allocator, in order')
  assert.equal(allocateCalls[0][1], undefined, 'called exactly as the order page calls it')
})

test('bulk allocate reports a short allocation on its row', async () => {
  orders = [order('a', 'PROCESSING')]
  allocateImpl = async () => ({ success: true, syncProductIds: [], unallocatedQty: 3 })
  const { bulkAllocateSalesOrders } = await import('@/app/actions/sales-bulk')
  const res = await bulkAllocateSalesOrders(['a'])
  assert.ok(res.ok)
  assert.equal(res.results[0].outcome, 'done')
  assert.match(res.results[0].message, /3 unit\(s\) are short/)
})

test('bulk advance: each status takes its one step through the same services as the order page', async () => {
  trackingValue = 'true'
  orders = [order('d', 'DRAFT'), order('p', 'PROCESSING'), order('s', 'SHIPPED'), order('c', 'COMPLETED'), order('k', 'PICKING'), order('h', 'ON_HOLD'), order('x', 'CANCELLED'), order('z', 'SHIPPED', { archived: true })]
  statusImpl = async (id) => (id === 's' ? { success: false, error: 'This order’s EU withdrawal request was approved; its status cannot be moved backwards.' } : { success: true })
  const { bulkAdvanceSalesOrders } = await import('@/app/actions/sales-bulk')
  const res = await bulkAdvanceSalesOrders(['d', 'p', 's', 'c', 'k', 'h', 'x', 'z'])
  assert.ok(res.ok)
  const by = Object.fromEntries(res.results.map((r) => [r.id, r.outcome]))
  assert.deepEqual(by, { d: 'done', p: 'done', s: 'failed', c: 'done', k: 'skipped', h: 'skipped', x: 'skipped', z: 'skipped' })
  assert.deepEqual(statusCalls, [['d', 'PROCESSING'], ['s', 'COMPLETED'], ['c', 'DELIVERED']], 'updateSalesOrderStatus, one step, in selection order')
  assert.deepEqual(allocateCalls.map((c) => c[0]), ['p'], 'PROCESSING advances through the allocator, as the order page does')
  assert.match(res.results.find((r) => r.id === 'k')!.message, /Not in a state that can advance/)
  assert.match(res.results.find((r) => r.id === 'z')!.message, /Archived/)
})

test('bulk advance skips Delivered while delivery tracking is off', async () => {
  trackingValue = null
  orders = [order('c', 'COMPLETED')]
  const { bulkAdvanceSalesOrders } = await import('@/app/actions/sales-bulk')
  const res = await bulkAdvanceSalesOrders(['c'])
  assert.ok(res.ok)
  assert.equal(res.results[0].outcome, 'skipped')
  assert.equal(statusCalls.length, 0)
})

test('bulk advance can only ever move an order into statuses with no direct storefront write', async () => {
  const { STATUS_FLOW } = await import('@/lib/domain/sales/status-flow')
  const { BULK_ADVANCE_TARGETS } = await import('@/lib/domain/sales/bulk-actions')
  const reachable = new Set(Object.values(STATUS_FLOW).flat().map((a) => a.target))
  for (const target of reachable) assert.ok(BULK_ADVANCE_TARGETS.includes(target), `${target} is not an approved bulk target`)
  for (const forbidden of ['SHIPPED', 'CANCELLED', 'ON_HOLD']) assert.ok(!reachable.has(forbidden as never))
})

test('the cap: more than 100 orders is refused before any order is touched', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `id${i}`)
  const { bulkAllocateSalesOrders, bulkAdvanceSalesOrders } = await import('@/app/actions/sales-bulk')
  for (const run of [bulkAllocateSalesOrders, bulkAdvanceSalesOrders]) {
    const res = await run(ids)
    assert.equal(res.ok, false)
    assert.match((res as { error: string }).error, /at most 100 orders/)
  }
  assert.equal(findManyCalls.length, 0)
  assert.equal(allocateCalls.length + statusCalls.length, 0)
  // exactly 100 is accepted; duplicates count once
  orders = ids.slice(0, 100).map((id) => order(id, 'ALLOCATED'))
  const ok = await bulkAllocateSalesOrders([...ids.slice(0, 100), ...ids.slice(0, 5)])
  assert.ok(ok.ok)
  assert.equal(ok.results.length, 100)
})

test('an empty or malformed selection is refused', async () => {
  const { bulkAllocateSalesOrders } = await import('@/app/actions/sales-bulk')
  for (const bad of [[], 'x', [''], [1]] as unknown[]) {
    const res = await bulkAllocateSalesOrders(bad as string[])
    assert.equal(res.ok, false)
  }
})

test('permission refusal: a role without sales.process gets an operator message and nothing runs', async () => {
  role = 'READONLY'
  orders = [order('a', 'PROCESSING')]
  const { bulkAllocateSalesOrders, bulkAdvanceSalesOrders } = await import('@/app/actions/sales-bulk')
  for (const run of [bulkAllocateSalesOrders, bulkAdvanceSalesOrders]) {
    const res = await run(['a'])
    assert.equal(res.ok, false)
    assert.match((res as { error: string }).error, /do not have permission to process sales orders/)
  }
  assert.equal(findManyCalls.length, 0)
  assert.equal(allocateCalls.length + statusCalls.length, 0)
})

test('operator wording: driver text and permission text are never shown raw', async () => {
  const { operatorMessage } = await import('@/lib/domain/sales/bulk-actions')
  assert.equal(operatorMessage(new Error('Forbidden: missing permission sales.process')), 'You do not have permission to process sales orders.')
  assert.equal(operatorMessage('Invalid `prisma.salesOrder.update()` invocation'), 'Something went wrong. Open the order and try again.')
  assert.equal(operatorMessage('Error: Error: Cannot start picking'), 'Cannot start picking.')
  assert.equal(operatorMessage(undefined), 'Something went wrong. Open the order and try again.')
})
