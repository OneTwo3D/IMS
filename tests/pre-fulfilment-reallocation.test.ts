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
  // by the rebalancer. Detection CAN run under the lock, so it does.
  const { recordShortfallUnderLock } = await loadHelper()
  reset()
  seedOrder('o11')
  state.short.add('o11')

  const written: Row[] = []
  const txFor = (id: string) => ({
    salesOrder: { findUnique: async () => state.orders.find((o) => o.id === id) ?? null },
    activityLog: { create: async ({ data }: { data: Row }) => { written.push(data); return data } },
  }) as never

  const crossed = await recordShortfallUnderLock({
    tx: txFor('o11'), orderId: 'o11', previousStatus: 'ON_HOLD', targetStatus: 'PACKING',
  })
  assert.deepEqual(crossed, { recorded: true }, 'a short crossing must always be recorded')

  // Written through the TRANSACTION, not logActivity — which swallows its own insert failures
  // by design, so routing it there meant claiming recorded:true for a row that might not exist.
  assert.equal(written.length, 1, 'the record must be written through the transaction')
  assert.equal(written[0]?.action, 'fulfilment_entry_under_allocated')
  assert.equal(state.activity.length, 0, 'it must NOT go through the error-swallowing logger')
  assert.deepEqual(
    (written[0]?.metadata as Row),
    { orderId: 'o11', previousStatus: 'ON_HOLD', targetStatus: 'PACKING' },
    'the record must name the crossing it is about',
  )

  // Already inside fulfilment: not a crossing, so not this hook's business.
  reset()
  seedOrder('o12')
  state.short.add('o12')
  written.length = 0
  const inside = await recordShortfallUnderLock({
    tx: txFor('o12'), orderId: 'o12', previousStatus: 'PICKING', targetStatus: 'PACKING',
  })
  assert.deepEqual(inside, { recorded: false })
  assert.equal(written.length, 0)
})

test('a failed record fails the TRANSITION rather than being silently swallowed (o3d-c9mi)', async () => {
  // The whole point of "always recorded": if the record cannot be written, the order must not
  // quietly cross into fulfilment short anyway.
  const { recordShortfallUnderLock } = await loadHelper()
  reset()
  seedOrder('o13')
  state.short.add('o13')

  const tx = {
    salesOrder: { findUnique: async () => state.orders[0] },
    activityLog: { create: async () => { throw new Error('activity insert failed') } },
  } as never

  await assert.rejects(
    () => recordShortfallUnderLock({ tx, orderId: 'o13', previousStatus: 'ON_HOLD', targetStatus: 'PICKING' }),
    /activity insert failed/,
    'the failure must propagate and roll the transition back',
  )
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

test('the coverage selector reads EVERYTHING through one client (o3d-c9mi)', async () => {
  // The under-lock caller passes `tx`. If any read inside still goes through the global `db`,
  // two things break at once: it takes a SECOND pooled connection while the caller already
  // holds one — twenty concurrent crossings exhaust the pool and each waits for a connection
  // the others hold — and it mixes snapshots, so a KIT definition committed in between makes
  // allocations look complete against the old graph while being short against the new one.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/fulfillment/order-allocation-coverage.ts'), 'utf8')

  const body = source.slice(source.indexOf('export async function selectOrdersNeedingAllocation'))
  const globalReads = body.match(/\bawait db\.\w+/g) ?? []
  assert.deepEqual(
    globalReads,
    [],
    `every read must go through the passed client; found global reads: ${globalReads.join(', ')}`,
  )
  assert.match(body, /loadFulfillmentProductGraph\(client,/, 'the product graph must load on the caller\'s client')
})

test('an order CREATED in fulfilment is recorded, though it never transitions (o3d-z82a)', async () => {
  // The WooCommerce importer writes an operator-configured status straight into
  // SalesOrder.status, and the mapping UI offers PICKING and PACKING. Such an order never
  // transitions, so the transition-side recorder never sees it — while sitting in exactly the
  // state that record exists for: outside the sweep's set, with nothing to revisit it.
  const { recordShortfallOnDirectCreate } = await loadHelper()
  reset()
  seedOrder('o20')
  state.short.add('o20')

  const written: Row[] = []
  const tx = {
    salesOrder: { findUnique: async () => state.orders.find((o) => o.id === 'o20') ?? null },
    activityLog: { create: async ({ data }: { data: Row }) => { written.push(data); return data } },
  } as never

  assert.deepEqual(
    await recordShortfallOnDirectCreate({ tx, orderId: 'o20', createdStatus: 'PICKING' }),
    { recorded: true },
  )
  assert.equal(written.length, 1, 'the record must be written through the transaction')
  assert.equal(written[0]?.action, 'fulfilment_entry_under_allocated', 'and share the transition path\'s action')
  assert.match(String(written[0]?.description), /was created directly at PICKING/)
  assert.deepEqual(
    written[0]?.metadata,
    { orderId: 'o20', previousStatus: null, createdAtStatus: 'PICKING' },
    'previousStatus must be null rather than a fabricated one',
  )
})

test('a direct create OUTSIDE fulfilment records nothing (o3d-z82a)', async () => {
  const { recordShortfallOnDirectCreate } = await loadHelper()
  const written: Row[] = []
  for (const status of ['PROCESSING', 'ALLOCATED', 'ON_HOLD', 'DRAFT', 'CANCELLED']) {
    reset()
    seedOrder('o21')
    state.short.add('o21')
    const tx = {
      salesOrder: { findUnique: async () => state.orders[0] },
      activityLog: { create: async ({ data }: { data: Row }) => { written.push(data); return data } },
    } as never
    assert.deepEqual(
      await recordShortfallOnDirectCreate({ tx, orderId: 'o21', createdStatus: status }),
      { recorded: false },
      `${status} is inside the sweep's reach or not fulfilment — nothing to record`,
    )
  }
  assert.equal(written.length, 0)
})

test('a fully covered direct create records nothing (o3d-z82a)', async () => {
  const { recordShortfallOnDirectCreate } = await loadHelper()
  reset()
  seedOrder('o22') // not added to state.short
  const written: Row[] = []
  const tx = {
    salesOrder: { findUnique: async () => state.orders[0] },
    activityLog: { create: async ({ data }: { data: Row }) => { written.push(data); return data } },
  } as never
  assert.deepEqual(await recordShortfallOnDirectCreate({ tx, orderId: 'o22', createdStatus: 'PACKING' }), { recorded: false })
  assert.equal(written.length, 0, 'a covered order is not a shortfall')
})

test('both entry points share one record writer (o3d-z82a)', async () => {
  // Two writers of the same action string would drift; an operator searching for
  // fulfilment_entry_under_allocated must find both shapes.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/fulfillment/pre-fulfilment-reallocation.ts'), 'utf8')

  const creates = source.match(/tx\.activityLog\.create\(/g) ?? []
  assert.equal(creates.length, 1, 'there must be exactly ONE place that writes the record')
  assert.match(source, /async function writeShortfallRecord\(/, 'both entry points must delegate to it')
  for (const entry of ['recordShortfallUnderLock', 'recordShortfallOnDirectCreate']) {
    const at = source.indexOf(`export async function ${entry}(`)
    assert.notEqual(at, -1, `${entry} must exist`)
    assert.match(source.slice(at, at + 900), /return writeShortfallRecord\(/, `${entry} must delegate`)
  }
})

test('the importer records a create-at-fulfilment under the order lock (o3d-z82a)', async () => {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/woocommerce/sync/order-import.ts'), 'utf8')

  const at = source.indexOf('isFulfilmentStatus(lifecycleStatus)')
  assert.notEqual(at, -1, 'the importer must check the status it actually persisted')
  const body = source.slice(at, at + 500)
  assert.match(body, /lockSalesOrder\(tx, so\.id\)/, 'the record must be written under the order lock')
  assert.match(body, /recordShortfallOnDirectCreate\(\{ tx/, 'and through the transaction, not best-effort')

  // The importer already allocates; re-running it here would be a redundant
  // release/re-reserve cycle on an order fulfilment may already be working.
  assert.ok(
    !body.includes('reconcileAllocationBeforeFulfilment'),
    'the importer must NOT re-run allocation — it already called autoAllocateOrder',
  )

  // It must gate on the PERSISTED status, not the raw mapping: a refund disposition can
  // downgrade imsStatus to PROCESSING, and lifecycleStatus is what actually reached the row.
  assert.ok(!/isFulfilmentStatus\(imsStatus\)/.test(source), 'the gate must use the persisted status')
})
