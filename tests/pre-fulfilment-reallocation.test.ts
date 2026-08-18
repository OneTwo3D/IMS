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

/** Every `$queryRaw` the sweep issues, so its ageing predicate can be asserted rather than assumed. */
const rawQueries: Array<{ sql: string; values: unknown[] }> = []
/** Orders the sweep's candidate query should return, i.e. markers already past the grace window. */
const agedMarkerOrderIds: string[] = []
/** Orders whose row lock was taken, in order. */
const lockedOrders: string[] = []
/** Per-order transaction clients the sweep should be handed. */
const sweepTxByOrder = new Map<string, unknown>()
/** Orders whose resolve transaction should blow up. */
const sweepTxThrows = new Set<string>()

mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: {
    lockSalesOrder: async (_tx: unknown, orderId: string) => { lockedOrders.push(orderId) },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrder: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          state.orders.find((order) => order.id === where.id) ?? null,
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        rawQueries.push({ sql: strings.join('?'), values })
        return agedMarkerOrderIds.map((entityId) => ({ entityId }))
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        // One client per order, in the order the sweep asks for them.
        const orderId = agedMarkerOrderIds[sweepTxHandouts++]
        if (sweepTxThrows.has(orderId)) throw new Error(`lock timeout on ${orderId}`)
        return fn(sweepTxByOrder.get(orderId) ?? {})
      },
    },
  },
})
let sweepTxHandouts = 0

async function loadHelper() {
  return import('@/lib/fulfillment/pre-fulfilment-reallocation')
}

function seedOrder(id: string, shipments = 0, status = 'PICKING') {
  state.orders.push({
    id,
    orderNumber: `SO-${id}`,
    externalOrderNumber: null,
    // ONE shape, carrying everything either question needs. The recorder used to read the order
    // twice with different selects, which forced every double to guess which read it was serving
    // from the presence of `status` in the select — a double that guessed wrong answered the
    // wrong question in silence.
    status,
    refundStatus: null,
    lines: [{ id: `${id}-l1`, qty: 5, productId: 'p1' }],
    _count: { shipments },
  })
}

function reset() {
  rawQueries.length = 0
  agedMarkerOrderIds.length = 0
  lockedOrders.length = 0
  sweepTxByOrder.clear()
  sweepTxThrows.clear()
  sweepTxHandouts = 0
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

/**
 * A transaction stub for the marker-based recorder.
 *
 * It serves the MARKER lookup, the ORDER read, the record insert and the marker delete. There is
 * deliberately nothing to discriminate any more: the recorder reads the order ONCE, so this stub
 * returns one shape and cannot answer the wrong question by mistake. The previous version keyed
 * off whether `status` appeared in the select, which quietly stopped being true the moment the
 * two reads were merged.
 */
function markerTx(
  orderId: string,
  written: Row[],
  marker: { id: string; metadata: unknown } | null = { id: 'm1', metadata: { orderId, createdAtStatus: 'PICKING' } },
) {
  const deleted: string[] = []
  const selects: Array<Record<string, unknown>> = []
  const tx = {
    activityLog: {
      findFirst: async () => marker,
      create: async ({ data }: { data: Row }) => { written.push(data); return data },
      deleteMany: async ({ where }: { where: { id: string } }) => { deleted.push(where.id); return { count: 1 } },
    },
    salesOrder: {
      findUnique: async ({ select }: { select?: Record<string, unknown> }) => {
        selects.push(select ?? {})
        return state.orders.find((o) => o.id === orderId) ?? null
      },
    },
  } as never
  return { tx, deleted, selects }
}

test('the marker carries the CREATION status, not the current one (o3d-z82a)', async () => {
  // The retry path used to infer "created in fulfilment" from the order's CURRENT status, which
  // is unsound in BOTH directions: an order created PROCESSING and later moved to PICKING by a
  // transition (which has its own recorder) would get a false "created directly at PICKING",
  // and a genuinely direct-created order that reached SHIPPED before the retry would be skipped
  // and lose its record permanently.
  const { directCreateMarker, resolveDirectCreateMarker } = await loadHelper()
  reset()
  seedOrder('o30', 0, 'PACKING')
  state.short.add('o30')

  const marker = directCreateMarker('o30', 'PICKING')
  assert.equal(marker.action, 'fulfilment_entry_pending_verification')
  assert.deepEqual(marker.metadata, { orderId: 'o30', createdAtStatus: 'PICKING' })
  assert.equal(marker.level, 'WARNING', 'an unresolved marker must itself be visible')

  // Still uncovered: the record is written, and says PICKING regardless of any later move.
  const written: Row[] = []
  const { tx, deleted } = markerTx('o30', written, { id: 'm1', metadata: marker.metadata })
  const result = await resolveDirectCreateMarker({ tx, orderId: 'o30' })

  assert.deepEqual(result, { recorded: true, resolved: true, verdict: 'uncovered' })
  assert.match(String(written[0]?.description), /was created directly at PICKING/)
  assert.deepEqual(written[0]?.metadata, {
    orderId: 'o30',
    previousStatus: null,
    createdAtStatus: 'PICKING',
    currentStatus: 'PACKING',
  })
  assert.deepEqual(deleted, ['m1'], 'the marker must be cleared in the same transaction')
})

test('the order is read ONCE, so no double has to guess which read it is serving (o3d-z82a)', async () => {
  // Two findUnique calls with different selects is what forced `markerTx` to discriminate on
  // whether `status` was in the select. That discrimination is invisible when it breaks: merge
  // the reads and a stub built for the old shape keeps answering, with the wrong row.
  const { resolveDirectCreateMarker } = await loadHelper()
  reset()
  seedOrder('o34', 0, 'PICKING')
  state.short.add('o34')
  const written: Row[] = []
  const { tx, selects } = markerTx('o34', written)

  await resolveDirectCreateMarker({ tx, orderId: 'o34' })

  assert.equal(selects.length, 1, 'exactly one order read under the lock')
  for (const field of ['status', 'lines', 'refundStatus', 'orderNumber', 'externalOrderNumber']) {
    assert.ok(field in selects[0], `the single read must carry ${field}`)
  }
})

test('no marker means already resolved, so this is safe to call repeatedly (o3d-z82a)', async () => {
  // The marker is the provenance AND the idempotency key. Counting shortfall rows instead
  // conflated this event with the transition-side record and the earlier best-effort warning,
  // so a later transition warning could suppress recovery of the original (Codex review).
  const { resolveDirectCreateMarker } = await loadHelper()
  reset()
  seedOrder('o31')
  state.short.add('o31')
  const written: Row[] = []
  const { tx, deleted } = markerTx('o31', written, null)

  assert.deepEqual(
    await resolveDirectCreateMarker({ tx, orderId: 'o31' }),
    { recorded: false, resolved: false, verdict: 'no-marker' },
  )
  assert.equal(written.length, 0)
  assert.equal(deleted.length, 0)
})

test('a marker resolved concurrently under the lock is a clean no-op, not a second record (o3d-z82a)', async () => {
  // The sweep selects a marker, then blocks on the order lock while the import that created it
  // resolves the marker and commits. When the sweep finally gets the lock the row is gone. It
  // must not read that as "nothing was ever resolved" and it must not write a second record for
  // an order whose question has already been answered once.
  const { resolveDirectCreateMarker } = await loadHelper()
  reset()
  seedOrder('o35', 0, 'PICKING')
  state.short.add('o35') // still short — so a second record WOULD be written if the guard failed
  const written: Row[] = []
  const { tx, deleted, selects } = markerTx('o35', written, null)

  const result = await resolveDirectCreateMarker({ tx, orderId: 'o35' })

  assert.deepEqual(result, { recorded: false, resolved: false, verdict: 'no-marker' })
  assert.equal(written.length, 0, 'the question was already answered; do not answer it twice')
  assert.equal(deleted.length, 0)
  assert.equal(selects.length, 0, 'and it must not even pay for the coverage read')
})

test('a covered order clears its marker without recording a shortfall (o3d-z82a)', async () => {
  const { resolveDirectCreateMarker } = await loadHelper()
  reset()
  seedOrder('o32') // not short
  const written: Row[] = []
  const { tx, deleted } = markerTx('o32', written)

  assert.deepEqual(
    await resolveDirectCreateMarker({ tx, orderId: 'o32' }),
    { recorded: false, resolved: true, verdict: 'covered' },
  )
  assert.equal(written.length, 0, 'a covered order is not a shortfall')
  assert.deepEqual(deleted, ['m1'], 'but its marker must still be cleared — coverage WAS verified')
})

test('a marker with no readable created status is still resolved, with the status unknown (o3d-z82a)', async () => {
  // It used to be left alone "so the problem stays visible". Nothing looked at it: the row was
  // exempt from retention and no mechanism cleared it, so "visible" meant an activity_logs row
  // accumulating forever. What we do NOT know is which status it was created at; that it entered
  // fulfilment uncovered is known, and is the part worth recording.
  const { resolveDirectCreateMarker } = await loadHelper()
  reset()
  seedOrder('o33', 0, 'PICKING')
  state.short.add('o33')
  const written: Row[] = []
  const { tx, deleted } = markerTx('o33', written, { id: 'm1', metadata: { orderId: 'o33' } })

  assert.deepEqual(
    await resolveDirectCreateMarker({ tx, orderId: 'o33' }),
    { recorded: true, resolved: true, verdict: 'uncovered' },
  )
  assert.match(String(written[0]?.description), /was created directly into fulfilment/)
  assert.equal((written[0]?.metadata as Row).createdAtStatus, null, 'reported as unknown, never guessed')
  assert.deepEqual(deleted, ['m1'], 'and it must terminate, or the retention exemption is unbounded')
})

test('LEAVING PICKING is not the shortfall clearing — an order still short is recorded (o3d-z82a)', async () => {
  // THE CORRECTION. The old rule discharged the marker whenever the order was no longer in
  // PICKING/PACKING, on the reasoning that "shipped already consumed what it had". It has not:
  // dispatch decrements reservedQty but RETAINS the OrderAllocation rows, so OrderAllocation.qty
  // still equals outstanding demand plus every committed shipment line. An order that shipped
  // everything it was allocated therefore reads as covered by itself — and one that still reads
  // SHORT after leaving shipped short, or was put on hold short, which is exactly the fact this
  // feature exists to record and the old rule silently threw away.
  const { resolveDirectCreateMarker } = await loadHelper()
  for (const status of ['SHIPPED', 'COMPLETED', 'DELIVERED', 'ON_HOLD']) {
    reset()
    seedOrder('o41', 0, status)
    state.short.add('o41')
    const written: Row[] = []
    const { tx, deleted } = markerTx('o41', written)

    assert.deepEqual(
      await resolveDirectCreateMarker({ tx, orderId: 'o41' }),
      { recorded: true, resolved: true, verdict: 'uncovered' },
      `${status} — the demand is still uncovered and nothing will cover it`,
    )
    assert.equal((written[0]?.metadata as Row).currentStatus, status, 'the record says where it ended up')
    assert.deepEqual(deleted, ['m1'])
  }
})

test('a CANCELLED order has no demand to cover, so nothing is recorded (o3d-z82a)', async () => {
  // The one case where silence is right, and it is a statement about DEMAND rather than about
  // which status was left. cancelSalesOrderFulfillmentState releases the reservations and DELETES
  // every OrderAllocation row, so a cancelled order reads as maximally short while owing nothing.
  const { resolveDirectCreateMarker } = await loadHelper()
  reset()
  seedOrder('o42', 0, 'CANCELLED')
  state.short.add('o42')
  const written: Row[] = []
  const { tx, deleted } = markerTx('o42', written)

  assert.deepEqual(
    await resolveDirectCreateMarker({ tx, orderId: 'o42' }),
    { recorded: false, resolved: true, verdict: 'no-demand' },
  )
  assert.equal(written.length, 0, 'no fabricated shortfall for an order that owes nothing')
  assert.deepEqual(deleted, ['m1'], 'but the marker must still be cleared, not left dangling')
})

test('an order back in the sweep\'s set is handed over, not recorded (o3d-z82a)', async () => {
  // PROCESSING and ALLOCATED are the reallocation sweep's own eligible statuses, so the order WILL
  // be revisited — and if it crosses into fulfilment again that crossing is a status transition,
  // which recordShortfallUnderLock covers. This is a handoff to a named mechanism, which is what
  // makes it a resolution rather than the assumption that leaving a status ended the question.
  const { resolveDirectCreateMarker } = await loadHelper()
  for (const status of ['PROCESSING', 'ALLOCATED']) {
    reset()
    seedOrder('o43', 0, status)
    state.short.add('o43')
    const written: Row[] = []
    const { tx, deleted } = markerTx('o43', written)

    assert.deepEqual(
      await resolveDirectCreateMarker({ tx, orderId: 'o43' }),
      { recorded: false, resolved: true, verdict: 'handed-back' },
      `${status} is inside the sweep's reach`,
    )
    assert.equal(written.length, 0)
    assert.deepEqual(deleted, ['m1'])
  }
})

test('an order that no longer exists resolves its marker instead of stranding it (o3d-z82a)', async () => {
  const { resolveDirectCreateMarker } = await loadHelper()
  reset() // nothing seeded
  const written: Row[] = []
  const { tx, deleted } = markerTx('gone-o44', written)

  assert.deepEqual(
    await resolveDirectCreateMarker({ tx, orderId: 'gone-o44' }),
    { recorded: false, resolved: true, verdict: 'order-missing' },
  )
  assert.equal(written.length, 0, 'nothing to describe')
  assert.deepEqual(deleted, ['m1'])
})

test('EVERY outcome clears the marker — that is what bounds the retention exemption (o3d-z82a)', async () => {
  // The activity-log retention exemption is only defensible if something is guaranteed to clear
  // these rows. A single verdict that returned without deleting would be an unbounded leak of
  // exempt rows, and it would look exactly like the old "left alone" branch: harmless per row,
  // permanent in aggregate.
  const { resolveDirectCreateMarker } = await loadHelper()
  const cases: Array<[string, string, boolean]> = [
    ['PICKING', 'uncovered', true],
    ['CANCELLED', 'no-demand', true],
    ['PROCESSING', 'handed-back', true],
    ['SHIPPED', 'uncovered', true],
  ]
  for (const [status, verdict] of cases) {
    reset()
    seedOrder('o45', 0, status)
    state.short.add('o45')
    const written: Row[] = []
    const { tx, deleted } = markerTx('o45', written)
    const result = await resolveDirectCreateMarker({ tx, orderId: 'o45' })
    assert.equal(result.verdict, verdict, status)
    assert.equal(result.resolved, true, `${status} must terminate`)
    assert.deepEqual(deleted, ['m1'], `${status} must clear the marker`)
  }
  // And the covered case, which has no shortfall to record.
  reset()
  seedOrder('o46', 0, 'PICKING')
  const written: Row[] = []
  const { tx, deleted } = markerTx('o46', written)
  const covered = await resolveDirectCreateMarker({ tx, orderId: 'o46' })
  assert.equal(covered.verdict, 'covered')
  assert.deepEqual(deleted, ['m1'])
})

test('the sweep only takes markers past the import\'s grace window, aged on the DB clock (o3d-z82a)', async () => {
  // The window is a SCHEDULING gate, not a verdict. Between the create transaction committing and
  // the importer's own autoAllocateOrder finishing, the order has no allocation rows at all — a
  // resolver that looked then would read "short", record a shortfall for an order about to be
  // covered, and discharge the marker so the true answer could never be written. Aged with
  // NOW() in the statement, so a skewed application clock cannot shorten it.
  const { sweepUnresolvedDirectCreateMarkers, DIRECT_CREATE_RESOLVE_GRACE_SECONDS } = await loadHelper()
  reset()

  const result = await sweepUnresolvedDirectCreateMarkers()

  assert.deepEqual(result, { scanned: 0, recorded: 0, resolved: 0, errors: 0 })
  assert.equal(rawQueries.length, 1, 'one indexed candidate query')
  const { sql, values } = rawQueries[0]
  assert.match(sql, /NOW\(\) - make_interval/, 'the cutoff must come from the database clock')
  assert.match(sql, /action = /, 'scoped to the marker action')
  assert.match(sql, /"entityType" = 'SALES_ORDER'/)
  assert.match(sql, /ORDER BY MIN\("createdAt"\) ASC/, 'oldest first, so nothing starves')
  assert.match(sql, /LIMIT /, 'bounded per tick')
  assert.ok(values.includes(DIRECT_CREATE_RESOLVE_GRACE_SECONDS), 'the grace window is the bound parameter')
  assert.ok(DIRECT_CREATE_RESOLVE_GRACE_SECONDS > 20, 'it must exceed the import\'s own 20s transaction budget')
  assert.equal(lockedOrders.length, 0, 'and nothing is locked when there is nothing to resolve')
})

test('the sweep\'s candidate query is backed by a partial index on the marker action (o3d-z82a)', async () => {
  // activity_logs is indexed on (entityType, entityId), (createdAt), (tag), (level) and
  // (level, createdAt). The sweep knows no entityId, so without a partial index on the marker
  // action this query scans 30-90 days of every action IMS takes, four times an hour, to find a
  // set that is almost always empty.
  //
  // The predicate is a SQL literal — it cannot reference the constant — so a rename would leave
  // the sweep working while silently reverting to that scan. Assert the pairing, not the index.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const { DIRECT_CREATE_PENDING_ACTION } = await loadHelper()
  const migration = await readFile(
    path.join(process.cwd(), 'prisma/migrations/20260818090000_direct_create_marker_sweep_index/migration.sql'),
    'utf8',
  )

  assert.match(migration, /CREATE INDEX "activity_logs_direct_create_marker_idx"/)
  assert.match(migration, /ON "activity_logs" \("createdAt", "entityId"\)/, 'ordered for the ageing scan and the GROUP BY')
  assert.ok(
    migration.includes(`WHERE action = '${DIRECT_CREATE_PENDING_ACTION}'`),
    'the partial predicate must be the SAME action string the sweep queries for',
  )
})

test('the sweep resolves each aged marker under its own order lock (o3d-z82a)', async () => {
  const { sweepUnresolvedDirectCreateMarkers } = await loadHelper()
  reset()
  seedOrder('sw1', 0, 'PICKING')
  seedOrder('sw2', 0, 'PICKING')
  state.short.add('sw1') // uncovered — recorded
  // sw2 is covered — resolved, not recorded
  agedMarkerOrderIds.push('sw1', 'sw2')
  const writtenA: Row[] = []
  const writtenB: Row[] = []
  sweepTxByOrder.set('sw1', markerTx('sw1', writtenA).tx)
  sweepTxByOrder.set('sw2', markerTx('sw2', writtenB).tx)

  const result = await sweepUnresolvedDirectCreateMarkers()

  assert.deepEqual(result, { scanned: 2, recorded: 1, resolved: 2, errors: 0 })
  assert.deepEqual(lockedOrders, ['sw1', 'sw2'], 'each resolve holds that order\'s row lock')
  assert.equal(writtenA.length, 1)
  assert.equal(writtenB.length, 0)
})

test('one unresolvable marker does not stop the rest of the page (o3d-z82a)', async () => {
  // A marker whose order lock cannot be taken is retried next tick; starving the page behind it
  // would be a second way for the retention exemption to grow without bound.
  const { sweepUnresolvedDirectCreateMarkers } = await loadHelper()
  reset()
  seedOrder('sw4', 0, 'PICKING')
  state.short.add('sw4')
  agedMarkerOrderIds.push('sw3', 'sw4')
  sweepTxThrows.add('sw3')
  const written: Row[] = []
  sweepTxByOrder.set('sw4', markerTx('sw4', written).tx)

  const result = await sweepUnresolvedDirectCreateMarkers()

  assert.deepEqual(result, { scanned: 2, recorded: 1, resolved: 1, errors: 1 })
  assert.equal(written.length, 1, 'the order behind the failure is still resolved')
})

test('the marker sweep is wired into the reallocation-sweep cron (o3d-z82a)', async () => {
  // It is the ONLY thing that clears a marker whose own import failed to resolve it, so an
  // unwired sweep is the retention exemption growing without bound again.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'app/api/cron/reallocation-sweep/route.ts'), 'utf8')

  assert.match(source, /sweepUnresolvedDirectCreateMarkers/, 'the route must run the marker sweep')
  const allocAt = source.indexOf('await sweepUnallocatedProcessingOrders()')
  const markerAt = source.indexOf('await sweepUnresolvedDirectCreateMarkers()')
  assert.ok(allocAt !== -1 && markerAt !== -1 && allocAt < markerAt, 'after the allocation pass')
  assert.match(source, /directCreateMarkers/, 'and its counts must be reported')
})

test('both entry points share one shortfall writer (o3d-z82a)', async () => {
  // Two writers of the same action string would drift; an operator searching for
  // fulfilment_entry_under_allocated must find both shapes.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/fulfillment/pre-fulfilment-reallocation.ts'), 'utf8')

  // Exactly one AUTHORITATIVE writer — the one that goes through the caller's transaction.
  // There is deliberately a second, best-effort emitter (warnEnteringFulfilmentShort, via
  // logActivity, from o3d-c9mi's pre-lock attempt); that one is allowed to be lost, which is
  // precisely why the authoritative path exists. Conflating the two is what made a count-based
  // idempotency check wrong, and why provenance is now keyed on the marker instead.
  const transactionalWrites = source.match(/await tx\.activityLog\.create\(/g) ?? []
  assert.equal(transactionalWrites.length, 1, 'exactly ONE place may write the record through a transaction')
  const bestEffort = source.indexOf('async function warnEnteringFulfilmentShort(')
  assert.notEqual(bestEffort, -1, 'the best-effort pre-lock warning must still exist')
  assert.match(source.slice(bestEffort, bestEffort + 500), /await logActivity\(/, 'and must remain the best-effort one')
  assert.match(source, /async function writeShortfallRecord\(/, 'both entry points must delegate to it')
  for (const entry of ['recordShortfallUnderLock', 'resolveDirectCreateMarker']) {
    const at = source.indexOf(`export async function ${entry}(`)
    assert.notEqual(at, -1, `${entry} must exist`)
    assert.match(source.slice(at, at + 2400), /writeShortfallRecord\(/, `${entry} must delegate`)
  }
})

test('the marker is written in the SAME transaction as the order (o3d-z82a)', async () => {
  // This is what makes it durable provenance rather than another thing that can be lost — and
  // what lets the resolver be non-fatal to the import.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/woocommerce/sync/order-import.ts'), 'utf8')

  const at = source.indexOf('so = await db.$transaction')
  assert.notEqual(at, -1, 'the create must run in a transaction')
  const body = source.slice(at, source.indexOf('} catch (error) {', at))
  assert.match(body, /tx\.salesOrder\.create\(/, 'the order is created in it')
  assert.match(
    body,
    /tx\.activityLog\.create\(\{ data: directCreateMarker\(created\.id, lifecycleStatus\) \}\)/,
    'and the marker with it, carrying the PERSISTED status',
  )
  assert.match(body, /isFulfilmentStatus\(lifecycleStatus\)/, 'only for an order created in fulfilment')
  assert.ok(!/directCreateMarker\(created\.id, imsStatus\)/.test(source), 'not the raw mapping status')
})

test('the create path resolves AFTER its own allocation, and only if it wrote a marker (o3d-z82a)', async () => {
  // ORDERING IS THE CORRECTNESS ARGUMENT. Before autoAllocateOrder runs, the order has no
  // allocation rows at all, so resolving there reads "short" for an order that is about to be
  // covered, writes a false record and discharges the marker permanently.
  //
  // The guard is also the whole hot-path cost: an import that wrote no marker does no work,
  // rather than issuing an indexed query to discover it has none.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/woocommerce/sync/order-import.ts'), 'utf8')

  const allocateAt = source.indexOf('const allocation = await autoAllocateOrder(so.id')
  const resolveAt = source.indexOf('await resolveDirectCreateShortfall(so.id)')
  assert.ok(allocateAt !== -1, 'the importer still makes its own allocation attempt')
  assert.ok(resolveAt !== -1, 'the create path resolves its own marker')
  assert.ok(allocateAt < resolveAt, 'and it must resolve AFTER allocating, never before')

  const guard = source.slice(source.lastIndexOf('if (', resolveAt), resolveAt)
  assert.match(guard, /isFulfilmentStatus\(lifecycleStatus\)/, 'gated by the same condition that wrote the marker')

  assert.ok(!source.includes('reconcileAllocationBeforeFulfilment'), 'the importer must NOT re-run allocation')
})

test('the resolver is non-fatal and holds the order lock (o3d-z82a)', async () => {
  // The order and its allocation are already committed when the resolver runs, so failing the
  // import undoes nothing — it only produces a retry that returns from the already-imported
  // branch without repairing anything. The marker is what makes swallowing safe: it survives as
  // a visible WARNING that coverage was never verified, and the sweep picks it up.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/woocommerce/sync/order-import.ts'), 'utf8')

  const at = source.indexOf('async function resolveDirectCreateShortfall(')
  assert.notEqual(at, -1, 'the resolver helper must exist')
  const helper = source.slice(at, at + 700)
  assert.match(helper, /catch \(error\)/, 'it must not fail the import, and must report rather than pass silently')
  assert.match(helper, /lockSalesOrder\(tx, orderId\)/, 'the resolve must hold the order lock')
  assert.match(helper, /timeout: 20_000/, "the coverage check needs more than Prisma's 5s default")

  // It takes NO status argument: provenance comes from the marker. Passing the current status
  // was the unsound inference this replaced.
  assert.match(helper, /resolveDirectCreateShortfall\(orderId: string\)/, 'no status parameter')
  assert.ok(!/resolveDirectCreateShortfall\([^)]*createdStatus/.test(source), 'no status may be threaded in')
})

test('a REDELIVERY never resolves a marker (o3d-z82a)', async () => {
  // A redelivery can arrive while the import that created the order is still between its create
  // transaction and its allocation. Resolving there answers the coverage question against an
  // order with no allocations YET: it records a shortfall that was about to be covered and
  // discharges the marker, so the real answer can never be written. A lock-free pre-check cannot
  // close that — losing the race is not what causes it; WINNING it is.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/woocommerce/sync/order-import.ts'), 'utf8')

  const redeliveryAt = source.indexOf('await updateExistingWcOrderFromPayload(existing.id, wcOrder)')
  assert.notEqual(redeliveryAt, -1)
  const redelivery = source.slice(redeliveryAt, source.indexOf('return { success: true, orderId: existing.id }', redeliveryAt))
  assert.ok(
    !redelivery.includes('await resolveDirectCreateShortfall(existing.id)'),
    'the hot redelivery path must not resolve markers',
  )
  assert.ok(
    !source.includes('hasDirectCreateMarker'),
    'and the pre-check that existed to make that resolve cheap is gone with it',
  )
})

test('clearing the marker cannot roll back the record it was written with (o3d-z82a)', async () => {
  // `delete` throws when the row is already gone — a concurrent removal would abort the
  // transaction and lose the shortfall record that had just been written, losing BOTH.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/fulfillment/pre-fulfilment-reallocation.ts'), 'utf8')

  assert.ok(
    !/tx\.activityLog\.delete\(/.test(source),
    'the marker must be cleared with deleteMany, so an already-removed row is a no-op',
  )
  assert.match(source, /tx\.activityLog\.deleteMany\(\{ where: \{ id: marker\.id \} \}\)/)
})

test('retention cleanup cannot age out an unresolved marker (o3d-z82a)', async () => {
  // The marker is STATE, not history: it says an order entered fulfilment and its coverage has
  // not been verified. Deleting it does not age out a record — it silently discharges the
  // obligation, and the resolver then reads "no marker" as "already resolved" and can never
  // write the record. WARNING rows default to 60 days.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/activity-log-cleanup.ts'), 'utf8')

  assert.match(source, /const RETAINED_ACTIONS = \[DIRECT_CREATE_PENDING_ACTION\]/, 'the marker action must be exempt')
  assert.match(source, /action <> ALL\(\$\{RETAINED_ACTIONS\}::text\[\]\)/, 'and the exemption must be in the DELETE')
  const at = source.indexOf('DELETE FROM "activity_logs"')
  assert.ok(source.indexOf('RETAINED_ACTIONS', at) !== -1, 'the exemption must apply to the deleting statement')
})

test('the retention exemption names the mechanism that bounds it (o3d-z82a)', async () => {
  // An exemption with no resolver is an unbounded leak, and it was claimed to be bounded twice
  // before it was. The comment has to name the thing that clears these rows, and that thing has
  // to exist and be exported.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const cleanup = await readFile(path.join(process.cwd(), 'lib/activity-log-cleanup.ts'), 'utf8')
  assert.match(cleanup, /sweepUnresolvedDirectCreateMarkers/, 'the bound must be named where the exemption is granted')

  const helper = await readFile(path.join(process.cwd(), 'lib/fulfillment/pre-fulfilment-reallocation.ts'), 'utf8')
  assert.match(helper, /export async function sweepUnresolvedDirectCreateMarkers\(/, 'and it must exist')
})

test('the retention exemption uses ALL, not ANY (o3d-z82a)', async () => {
  // `action <> ANY(ARRAY['a','b'])` is true when the action differs from AT LEAST ONE element,
  // so 'a' <> 'b' alone satisfies it and an exempt row is deleted anyway. With a single entry
  // the two forms agree — which is precisely what makes it a landmine: it would have worked
  // until the day someone added a second retained action, and then silently stopped.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const source = await readFile(path.join(process.cwd(), 'lib/activity-log-cleanup.ts'), 'utf8')

  // Scoped to the STATEMENT, not the file — the comment above it explains the ANY pitfall by
  // name, and an assertion that forbids the string anywhere fails on its own documentation.
  const sqlAt = source.indexOf('DELETE FROM "activity_logs"')
  const statement = source.slice(sqlAt, source.indexOf('RETURNING', sqlAt))
  assert.match(statement, /action <> ALL\(\$\{RETAINED_ACTIONS\}::text\[\]\)/, 'must be <> ALL')
  assert.ok(!/<> ANY\(/.test(statement), '<> ANY is wrong as soon as there is a second entry')
})
