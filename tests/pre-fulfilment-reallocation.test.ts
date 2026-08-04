import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-c9mi: a partially-allocated order crossing into PICKING / PACKING leaves the o3d-9lx
 * sweep's reach (PROCESSING + ALLOCATED) for good, while its one-shot replenishment trigger
 * has already been consumed — so the shortfall is never allocated.
 *
 * The fix is a final allocation attempt at that boundary, NOT a refusal: the existing guard
 * requires only that at least one allocation exists, which is direct evidence that picking a
 * partially allocated order is an intentional workflow. Widening the sweep was rejected in
 * the issue itself — fulfilment may already own those allocations.
 */

type Row = Record<string, unknown>

const state = {
  orders: [] as Row[],
  activity: [] as Row[],
  allocateCalls: [] as string[],
  allocateOptions: [] as Array<Record<string, unknown> | null>,
  /** Orders the coverage selector should report as short, by id. */
  short: new Set<string>(),
  /** Ids the allocator manages to fully cover on its run. */
  allocatorFixes: new Set<string>(),
  /** Ids for which the allocator throws instead of returning. */
  allocatorThrows: new Set<string>(),
  /** Ids the allocator declines under its own lock (shipment appeared). */
  allocatorRefuses: new Set<string>(),
  /** Ids whose status moved under the allocator's lock. */
  allocatorSkips: new Set<string>(),
}

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Row) => { state.activity.push(entry) } },
})

mock.module('@/lib/fulfillment/order-allocation-coverage', {
  namedExports: {
    selectOrdersNeedingAllocation: async (candidates: Array<{ id: string }>) =>
      candidates.filter((order) => state.short.has(order.id)),
  },
})

mock.module('@/app/actions/allocation', {
  namedExports: {
    autoAllocateOrder: async (orderId: string, options?: Record<string, unknown>) => {
      state.allocateCalls.push(orderId)
      state.allocateOptions.push(options ?? null)
      if (state.allocatorThrows.has(orderId)) throw new Error('allocator exploded')
      // A successful run closes the shortfall for the ids the fixture nominates.
      if (state.allocatorFixes.has(orderId)) state.short.delete(orderId)
      if (state.allocatorRefuses.has(orderId)) return { success: false, refused: true, allocationCount: 0 }
      if (state.allocatorSkips.has(orderId)) return { success: false, skipped: true, skippedStatus: 'PICKING' }
      return { success: true, allocationCount: 1 }
    },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          state.orders.find((order) => order.id === where.id) ?? null,
      },
    },
  },
})

async function loadHelper() {
  return import('@/lib/fulfillment/pre-fulfilment-reallocation')
}

function seedOrder(id: string, shipments = 0) {
  state.orders.push({
    id,
    orderNumber: `SO-${id}`,
    externalOrderNumber: null,
    refundStatus: null,
    lines: [{ id: `${id}-l1`, qty: 5, productId: 'p1' }],
    _count: { shipments },
  })
}

function reset() {
  state.orders.length = 0
  state.activity.length = 0
  state.allocateCalls.length = 0
  state.allocateOptions.length = 0
  state.short.clear()
  state.allocatorFixes.clear()
  state.allocatorThrows.clear()
  state.allocatorRefuses.clear()
  state.allocatorSkips.clear()
}

test('only a CROSSING into fulfilment counts, not any PICKING/PACKING target (o3d-c9mi)', async () => {
  const { entersFulfilment } = await loadHelper()

  // Crossing in from outside: this is the last automatic chance.
  assert.equal(entersFulfilment('ALLOCATED', 'PICKING'), true)
  assert.equal(entersFulfilment('ON_HOLD', 'PICKING'), true)
  assert.equal(entersFulfilment('ON_HOLD', 'PACKING'), true)

  // Already inside fulfilment. PICKING -> PACKING is legal and targets a fulfilment status,
  // but reallocating an order a picker is working on is exactly what the issue warns against:
  // the allocator would release, delete and recreate allocations fulfilment already owns.
  assert.equal(entersFulfilment('PICKING', 'PACKING'), false)
  assert.equal(entersFulfilment('PICKING', 'PICKING'), false)
  assert.equal(entersFulfilment('PACKING', 'PACKING'), false)

  // ALLOCATED and PROCESSING are the sweep's own set — reallocating there is its job.
  for (const target of ['ALLOCATED', 'PROCESSING', 'SHIPPED', 'ON_HOLD', 'CANCELLED', 'DRAFT']) {
    assert.equal(entersFulfilment('ALLOCATED', target), false, `${target} must not trigger the boundary attempt`)
  }
})

test('a short order gets one final allocation attempt at the boundary (o3d-c9mi)', async () => {
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o1')
  state.short.add('o1')
  state.allocatorFixes.add('o1')

  const result = await reconcileAllocationBeforeFulfilment('o1')

  assert.deepEqual(state.allocateCalls, ['o1'], 'the shortfall must trigger exactly one allocation run')
  assert.deepEqual(result, { attempted: true, stillShort: false })
  assert.equal(state.activity.length, 0, 'a closed shortfall is not a warning')
})

test('a fully covered order is left completely alone (o3d-c9mi)', async () => {
  // Re-running allocation on a covered order churns its existing allocations — the sweep
  // pre-filters them for the same reason.
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o2')

  const result = await reconcileAllocationBeforeFulfilment('o2')

  assert.deepEqual(result, { attempted: false, reason: 'fully-covered' })
  assert.deepEqual(state.allocateCalls, [], 'a covered order must not be reallocated')
})

test('an order with shipments is never reallocated (o3d-c9mi)', async () => {
  // autoAllocateOrder rebuilds OrderAllocation without touching committed ShipmentLines, so
  // reallocating here would decrement stock against stale rows.
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o3', 1)
  state.short.add('o3')

  const result = await reconcileAllocationBeforeFulfilment('o3')

  assert.deepEqual(result, { attempted: false, reason: 'has-shipments' })
  assert.deepEqual(state.allocateCalls, [], 'an order with shipments must not be reallocated')
  // ...but it is still short and still leaving the sweep's reach. Returning silently meant the
  // partial-fulfilment workflow this fix protects got neither the attempt nor the warning.
  assert.equal(state.activity.length, 1, 'a short order with shipments must still be reported')
  assert.match(String(state.activity[0]?.description), /existing shipments/)
})

test('a shortfall that survives the attempt is RECORDED, not silently dropped (o3d-c9mi)', async () => {
  // The whole point: the order proceeds into fulfilment — refusing would break partial
  // picking — but the shortfall no longer vanishes without trace.
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o4')
  state.short.add('o4') // the allocator cannot close it

  const result = await reconcileAllocationBeforeFulfilment('o4')

  assert.deepEqual(result, { attempted: true, stillShort: true })
  assert.equal(state.activity.length, 1, 'an unresolved shortfall must be recorded')
  const [entry] = state.activity
  assert.equal(entry.action, 'fulfilment_entry_under_allocated')
  assert.equal(entry.level, 'WARNING')
  assert.match(
    String(entry.description),
    /will not be allocated automatically/,
    'the record must say the shortfall is now nobody\'s job, which is the actual consequence',
  )
})

test('coverage is RE-READ after allocating, not inferred from the allocator (o3d-c9mi)', async () => {
  // autoAllocateOrder reports its own run, not the resulting coverage — it can return success
  // having allocated only part of the demand. Trusting it would report stillShort:false for an
  // order that is still short.
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o5')
  state.short.add('o5') // allocator "succeeds" but does not clear the shortfall

  const result = await reconcileAllocationBeforeFulfilment('o5')

  assert.deepEqual(result, { attempted: true, stillShort: true }, 'a successful run that left demand is still short')
})

test('a missing order is a no-op rather than a crash (o3d-c9mi)', async () => {
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()

  const result = await reconcileAllocationBeforeFulfilment('gone')

  assert.deepEqual(result, { attempted: false, reason: 'order-missing' })
  assert.deepEqual(state.allocateCalls, [])
})

test('an allocator that throws does not block the transition (o3d-c9mi)', async () => {
  // This is a backstop on the way into fulfilment. A failure to improve coverage must not
  // stop an operator moving the order — that would be a worse regression than the bug.
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o6')
  state.short.add('o6')
  state.allocatorThrows.add('o6')

  const result = await reconcileAllocationBeforeFulfilment('o6')

  assert.deepEqual(result, { attempted: true, stillShort: true }, 'a thrown allocator still reports the shortfall')
  assert.equal(state.activity.length, 1, 'and the unresolved shortfall is still recorded')
})

test('the allocator is called with every guard the boundary needs (o3d-c9mi)', async () => {
  // This call is made OUTSIDE the order lock, so each of these is what makes that safe.
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o7')
  state.short.add('o7')

  await reconcileAllocationBeforeFulfilment('o7')

  const options = state.allocateOptions[0]
  assert.ok(options, 'the allocator must be given options, not called bare')

  // Woo status mappings drive PICKING/PACKING through the sessionless transition bypass, and
  // autoAllocateOrder requires an authenticated permission. Without the token the webhook
  // path fails the permission check, the catch swallows it, and no attempt is ever made.
  assert.ok(options.internalBypassToken, 'the sessionless path needs the internal bypass token')

  // Closes the TOCTOU on the shipments read: a concurrent confirmation can create shipment
  // lines in between, and only the allocator can re-check under its own lock.
  assert.equal(options.refuseIfShipmentsExist, true, 'the allocator must re-check shipments under its lock')

  // Likewise the status: if the order reached PICKING/PACKING in between, this must become an
  // explicit no-op rather than rewriting allocations fulfilment now owns.
  assert.deepEqual(
    options.requireStatusUnderLock,
    ['PROCESSING', 'ALLOCATED', 'ON_HOLD'],
    'the allocator must refuse to run once the order is already in fulfilment, while still '
      + 'accepting every predecessor a forced Woo transition can start from',
  )
})

/**
 * The suite above drives the helper directly. These pin the PRODUCTION WIRING: without them,
 * deleting the hook in sales.ts or passing only the target status would leave every assertion
 * above green (Codex review).
 */
test('the status transition actually calls the boundary attempt, with BOTH statuses (o3d-c9mi)', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'app/actions/sales.ts'), 'utf8')

  assert.match(
    source,
    /entersFulfilment\(so\.status, targetStatus\)/,
    'the guard must consider the CURRENT status too, or PICKING -> PACKING reallocates an order being picked',
  )
  assert.match(
    source,
    /await reconcileAllocationBeforeFulfilment\(id\)/,
    'the transition must actually make the attempt',
  )

  // It has to run BEFORE the transition transaction: autoAllocateOrder opens its own
  // transaction, so calling it inside the lock would nest.
  const hookAt = source.indexOf('reconcileAllocationBeforeFulfilment(id)')
  const txAt = source.indexOf('const transitionResult = await db.$transaction')
  assert.ok(hookAt !== -1 && txAt !== -1, 'both the hook and the transition transaction must exist')
  assert.ok(hookAt < txAt, 'the attempt must precede the transition transaction, or it nests inside its lock')
})

test('a forced PROCESSING -> PICKING still gets a real attempt (o3d-c9mi)', async () => {
  // The WooCommerce mappings drive transitions through the FULL bypass, which deliberately
  // permits moves the state machine would refuse. With PROCESSING missing from the required
  // set the helper ran, the allocator skipped, and the promised attempt never happened.
  const { entersFulfilment } = await loadHelper()
  assert.equal(entersFulfilment('PROCESSING', 'PICKING'), true, 'a forced Woo transition must still qualify')

  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o8')
  state.short.add('o8')
  await reconcileAllocationBeforeFulfilment('o8')

  assert.ok(
    (state.allocateOptions[0]?.requireStatusUnderLock as string[]).includes('PROCESSING'),
    'PROCESSING must be an accepted predecessor, or the forced path allocates nothing',
  )
})

test('an allocator refusal is reported as a refusal, not a failed attempt (o3d-c9mi)', async () => {
  // It declines cleanly rather than throwing when a shipment appeared under its lock.
  // Calling that "an attempt did not close the shortfall" is untrue — nothing ran.
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o9')
  state.short.add('o9')
  state.allocatorRefuses.add('o9')

  const result = await reconcileAllocationBeforeFulfilment('o9')

  assert.deepEqual(result, { attempted: false, reason: 'refused-under-lock', stillShort: true })
  assert.match(String(state.activity[0]?.description), /shipment appeared/)
})

test('a status that moved under the allocator lock is reported as such (o3d-c9mi)', async () => {
  const { reconcileAllocationBeforeFulfilment } = await loadHelper()
  reset()
  seedOrder('o10')
  state.short.add('o10')
  state.allocatorSkips.add('o10')

  const result = await reconcileAllocationBeforeFulfilment('o10')

  assert.equal(result.attempted, false)
  assert.match(String(state.activity[0]?.description), /already PICKING/)
})

test('the under-lock recorder catches what the pre-lock attempt cannot (o3d-c9mi)', async () => {
  // The attempt must run outside the transition lock, so its inputs can be stale by the time
  // the transition commits — a source status read as PICKING, or coverage reduced afterwards
  // by the rebalancer. Detection is cheap and CAN run under the lock, so it does.
  const { recordShortfallUnderLock } = await loadHelper()
  reset()
  seedOrder('o11')
  state.short.add('o11')

  const tx = {
    salesOrder: { findUnique: async () => state.orders.find((o) => o.id === 'o11') ?? null },
  } as never

  // The real previous status, as observed under the lock, crosses into fulfilment.
  const crossed = await recordShortfallUnderLock({
    tx, orderId: 'o11', previousStatus: 'ON_HOLD', targetStatus: 'PACKING',
  })
  assert.deepEqual(crossed, { recorded: true }, 'a short crossing must always be recorded')
  assert.equal(state.activity.length, 1)

  // Already inside fulfilment: not a crossing, so not this hook's business.
  reset()
  seedOrder('o12')
  state.short.add('o12')
  const inside = await recordShortfallUnderLock({
    tx: { salesOrder: { findUnique: async () => state.orders[0] } } as never,
    orderId: 'o12', previousStatus: 'PICKING', targetStatus: 'PACKING',
  })
  assert.deepEqual(inside, { recorded: false })
  assert.equal(state.activity.length, 0)
})

test('the transition wires the under-lock recorder against the REAL previous status (o3d-c9mi)', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'app/actions/sales.ts'), 'utf8')

  const at = source.indexOf('recordShortfallUnderLock({')
  assert.notEqual(at, -1, 'the transition must record shortfalls under its lock')
  const call = source.slice(at, at + 400)
  assert.match(call, /tx: lockedTx/, 'it must read through the LOCKED client, not db')
  assert.match(call, /previousStatus: beforeStatus/, 'it must use the status observed under the lock, not the pre-read one')
})
