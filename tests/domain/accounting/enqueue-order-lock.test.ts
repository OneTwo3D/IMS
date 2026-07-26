import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAccountingEnqueueOrderScope } from '@/lib/domain/accounting/enqueue-order-guard'

// o3d-3zgy. o3d-hrak made queueXeroSync / queueQuickBooksSync take the sales-order row lock in the
// same transaction that writes the AccountingSyncLog, so an enqueue serialises against a hard
// delete. queueAccountingSyncTx is the OTHER enqueue path: it writes inside a CALLER's transaction,
// so it cannot take that lock itself — doing so would take it LATE, after stock-level locks are
// already held, inverting the lockSalesOrder-then-lockStockLevels ordering allocation-service
// establishes, and deadlocking against the allocation path. Trading a rare race for a routine hang
// is not a fix.
//
// So the caller hoists the lock and this path ASSERTS they did, defaulting to enforcement so a new
// order-scoped caller cannot silently reopen the race.

function makeTx(seed: {
  shipmentOrderId?: string | null
  orderExists?: boolean
}) {
  return {
    shipment: {
      findUnique: async () => seed.shipmentOrderId === undefined
        ? null
        : (seed.shipmentOrderId === null ? null : { orderId: seed.shipmentOrderId }),
    },
    salesOrder: {
      findUnique: async () => (seed.orderExists === false ? null : { id: 'order-1' }),
    },
  } as never
}

test('a PurchaseOrder reference is not order-scoped — nothing to lock (o3d-3zgy)', async () => {
  // The distinction matters: conflating "not order-scoped" with "order deleted" would skip
  // legitimate purchase-order enqueues entirely.
  const scope = await resolveAccountingEnqueueOrderScope(
    makeTx({}),
    { referenceType: 'PurchaseOrder', referenceId: 'po-1' },
  )
  assert.deepEqual(scope, { scope: 'none' })
})

test('a ProductionOrder reference is not order-scoped either (o3d-3zgy)', async () => {
  const scope = await resolveAccountingEnqueueOrderScope(
    makeTx({}),
    { referenceType: 'ProductionOrder', referenceId: 'mo-1' },
  )
  assert.deepEqual(scope, { scope: 'none' })
})

test('a SalesOrder reference resolves to itself (o3d-3zgy)', async () => {
  const scope = await resolveAccountingEnqueueOrderScope(
    makeTx({ orderExists: true }),
    { referenceType: 'SalesOrder', referenceId: 'order-1' },
  )
  assert.deepEqual(scope, { scope: 'order', orderId: 'order-1' })
})

test('a Shipment reference resolves THROUGH to its order (o3d-3zgy)', async () => {
  // A shipment is order-scoped indirectly: the lock that protects it is on the order, so the
  // reference has to be followed before the scope is known.
  const scope = await resolveAccountingEnqueueOrderScope(
    makeTx({ shipmentOrderId: 'order-1', orderExists: true }),
    { referenceType: 'Shipment', referenceId: 'ship-1' },
  )
  assert.deepEqual(scope, { scope: 'order', orderId: 'order-1' })
})

test('a deleted order reports DELETED, distinctly from not-order-scoped (o3d-3zgy)', async () => {
  // These must not collapse: 'none' means proceed, 'deleted' means the sync row would be orphaned
  // against a reference nothing can resolve — the o3d-hrak race the lock exists to close.
  const scope = await resolveAccountingEnqueueOrderScope(
    makeTx({ orderExists: false }),
    { referenceType: 'SalesOrder', referenceId: 'order-gone' },
  )
  assert.deepEqual(scope, { scope: 'deleted' })
})

test('a shipment whose order is already gone reports DELETED (o3d-3zgy)', async () => {
  const scope = await resolveAccountingEnqueueOrderScope(
    makeTx({ shipmentOrderId: null }),
    { referenceType: 'Shipment', referenceId: 'ship-orphan' },
  )
  assert.deepEqual(scope, { scope: 'deleted' })
})

test('resolving the scope takes NO lock — that is the whole point (o3d-3zgy)', async () => {
  // The lock-taking sibling (lockOrderForAccountingEnqueue) is for enqueue paths that own their
  // transaction. This one must stay lock-free, or it would reintroduce the late-lock deadlock it
  // exists to avoid.
  const raw: string[] = []
  const tx = {
    $queryRaw: async (...args: unknown[]) => { raw.push(String(args[0])); return [] },
    shipment: { findUnique: async () => ({ orderId: 'order-1' }) },
    salesOrder: { findUnique: async () => ({ id: 'order-1' }) },
  } as never

  await resolveAccountingEnqueueOrderScope(tx, { referenceType: 'Shipment', referenceId: 'ship-1' })

  assert.equal(raw.length, 0, 'no raw query — so no FOR UPDATE could have been issued')
})

test('lockSalesOrder registers the lock so the enqueue assertion can see it (o3d-3zgy)', async () => {
  // Postgres cannot answer "does this transaction hold that row lock?" — an uncontended
  // SELECT ... FOR UPDATE records it in the tuple header, not pg_locks. So the assertion relies on
  // an in-process registry that lockSalesOrder populates.
  //
  // The consequence, and the reason every raw `SELECT id FROM sales_orders ... FOR UPDATE` in the
  // codebase was converted to this helper: a lock taken by hand-written SQL would be invisible here
  // and the assertion would reject a caller that was in fact correct.
  const { lockSalesOrder, hasLockedSalesOrder } = await import('@/lib/domain/sales/allocation-service')

  const tx = { $queryRaw: async () => [{ id: 'order-1' }] } as never

  assert.equal(hasLockedSalesOrder(tx, 'order-1'), false, 'nothing locked yet')
  await lockSalesOrder(tx, 'order-1')
  assert.equal(hasLockedSalesOrder(tx, 'order-1'), true, 'the lock is now visible to the assertion')
  assert.equal(hasLockedSalesOrder(tx, 'order-2'), false, 'and it is per-order, not a blanket flag')

  // Per transaction, too: a different transaction object must not inherit the claim.
  const other = { $queryRaw: async () => [] } as never
  assert.equal(hasLockedSalesOrder(other, 'order-1'), false, 'not shared across transactions')
})

test('a FAILED lock does not register (o3d-3zgy)', async () => {
  // Registering before the lock succeeded would let the assertion pass on a transaction that never
  // actually held anything — worse than no assertion, because it would look verified.
  const { lockSalesOrder, hasLockedSalesOrder } = await import('@/lib/domain/sales/allocation-service')

  const tx = { $queryRaw: async () => { throw new Error('deadlock detected') } } as never

  await assert.rejects(() => lockSalesOrder(tx, 'order-1'))
  assert.equal(hasLockedSalesOrder(tx, 'order-1'), false, 'a lock that threw is not recorded')
})

test('every acknowledged unlocked enqueue site carries a reason (o3d-3zgy)', async () => {
  // The opt-out exists because ONE path cannot hoist the lock: the landed-cost revaluation
  // discovers affected shipments mid-transaction, after stock locks are held, so locking the order
  // there inverts the ordering and can deadlock. That gap is acknowledged in code rather than left
  // silent, and this pins the count so a second one cannot appear unnoticed.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const files = ['lib/cost-layers.ts', 'lib/accounting.ts', 'app/actions/sales.ts']
  let sites = 0
  for (const file of files) {
    const src = readFileSync(join(process.cwd(), file), 'utf8')
    // Count USES, not the parameter declaration or the doc comment in accounting.ts.
    sites += (src.match(/^\s+unlockedOrderScopeReason:/gm) ?? []).length
  }

  assert.equal(sites, 1, `expected exactly one acknowledged unlocked enqueue site, found ${sites}`)
})
