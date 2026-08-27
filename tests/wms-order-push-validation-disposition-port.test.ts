import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-2k5r — THE REAL PRISMA PORT, not a fake that reimplements it.
 *
 * The o3d-92fu suite drives `runWmsOrderPushSweepCore` through a hand-written port whose
 * `recordValidationFailure` returns a seeded boolean. That proves what the SWEEP does with the
 * answer and nothing about how the answer is produced — so the row lock, the concurrency guard
 * and the eligibility predicate, which are exactly the three things the comments say make this
 * safe, were asserted by nothing.
 *
 * These tests exercise `createPrismaWmsOrderPushPort()` itself against a recording db.
 */

type Row = Record<string, unknown>

const state = {
  link: null as Row | null,
  lockedRows: [{ id: 'so-1' }] as Array<{ id: string }>,
  rawQueries: [] as string[],
  upserts: [] as Array<{ where: Row; create: Row; update: Row }>,
  findManyArgs: [] as Row[],
  countArgs: [] as Row[],
  salesOrderFindManyArgs: [] as Row[],
  updateManyArgs: [] as Row[],
  updateManyCount: 1,
}

function reset() {
  state.link = null
  state.lockedRows = [{ id: 'so-1' }]
  state.rawQueries = []
  state.upserts = []
  state.findManyArgs = []
  state.countArgs = []
  state.salesOrderFindManyArgs = []
  state.updateManyArgs = []
  state.updateManyCount = 1
}

const tx = {
  $queryRaw: async (strings: TemplateStringsArray) => {
    state.rawQueries.push(strings.join('?').replace(/\s+/g, ' ').trim())
    return state.lockedRows
  },
  wmsOrderPushLink: {
    findUnique: async () => state.link,
    upsert: async (args: { where: Row; create: Row; update: Row }) => {
      state.upserts.push(args)
      return {}
    },
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      wmsOrderPushLink: {
        findMany: async (args: Row) => { state.findManyArgs.push(args); return [] },
        count: async (args: Row) => { state.countArgs.push(args); return 0 },
        updateMany: async (args: Row) => {
          state.updateManyArgs.push(args)
          return { count: state.updateManyCount }
        },
      },
      salesOrder: {
        findMany: async (args: Row) => { state.salesOrderFindManyArgs.push(args); return [] },
      },
    },
  },
})

const AT = new Date('2026-08-24T12:00:00.000Z')
const FRESH_CLAIM = new Date(AT.getTime() - 60_000)        // 1 min old — inside the 5-min lease
const EXPIRED_CLAIM = new Date(AT.getTime() - 10 * 60_000) // 10 min old — the lease has lapsed

async function port() {
  const mod = await import('../lib/domain/wms/order-push-sweep.ts')
  return mod.createPrismaWmsOrderPushPort()
}

test('o3d-2k5r port: the disposition is written under the sales_orders ROW LOCK', async () => {
  reset()
  const ok = await (await port()).recordValidationFailure('so-1', 'mintsoft', 'no SKU', AT)

  assert.equal(ok, true)
  // The lock is what makes this serialise with deleteSalesOrder and claimForCreate rather than
  // merely race them. Without FOR UPDATE the guard below is decoration.
  assert.equal(state.rawQueries.length, 1)
  assert.match(state.rawQueries[0], /SELECT id FROM sales_orders WHERE id = \? FOR UPDATE/)
})

test('o3d-2k5r port: an order deleted under the lock is refused, and nothing is written', async () => {
  reset()
  state.lockedRows = []

  assert.equal(await (await port()).recordValidationFailure('so-1', 'mintsoft', 'no SKU', AT), false)
  assert.equal(state.upserts.length, 0)
})

test('o3d-2k5r port: with NO existing link the disposition is CREATED at attempts 0 — the only pre-call proof', async () => {
  reset()
  const p = await port()
  const { provesNoRemoteWmsCall } = await import('../lib/domain/wms/order-push-sweep.ts')

  assert.equal(await p.recordValidationFailure('so-1', 'mintsoft', 'no SKU', AT), true)
  assert.equal(state.upserts.length, 1)
  const created = state.upserts[0].create
  assert.equal(created.state, 'VALIDATION_FAILED')
  assert.equal(created.attempts, 0)
  // And that row is exactly what the hard-delete guard is allowed to let go.
  assert.equal(
    provesNoRemoteWmsCall({ state: 'VALIDATION_FAILED', attempts: created.attempts as number, pushedAt: null, externalOrderId: null }),
    true,
  )
})

test('o3d-2k5r port: a FRESH claim is REFUSED — the disposition never overwrites a live push', async () => {
  reset()
  state.link = { state: 'PENDING_CREATE', attempts: 0, lastAttemptAt: FRESH_CLAIM }

  // A worker is inside pushOrder right now. Writing here would both destroy its claim state and
  // move its lease clock forward, and the cron rate-limits sweeps without serialising them.
  assert.equal(await (await port()).recordValidationFailure('so-1', 'mintsoft', 'no SKU', AT), false)
  assert.equal(state.upserts.length, 0)
})

test('o3d-2k5r port: an EXPIRED claim is converted, and marked AMBIGUOUS so the delete guard refuses', async () => {
  reset()
  state.link = { state: 'PENDING_CREATE', attempts: 0, lastAttemptAt: EXPIRED_CLAIM }
  const { provesNoRemoteWmsCall, AMBIGUOUS_ATTEMPTS } = await import('../lib/domain/wms/order-push-sweep.ts')

  assert.equal(await (await port()).recordValidationFailure('so-1', 'mintsoft', 'no SKU', AT), true)
  assert.equal(state.upserts.length, 1)
  const updated = state.upserts[0].update
  assert.equal(updated.state, 'VALIDATION_FAILED')
  // THE CRITICAL ASSERTION. The claim was written immediately before a remote call and the
  // increment that would have recorded it does not survive a process kill, so attempts 0 must NOT
  // be carried through — it would read as "provably nothing was sent".
  assert.equal(updated.attempts, AMBIGUOUS_ATTEMPTS)
  assert.equal(
    provesNoRemoteWmsCall({ state: 'VALIDATION_FAILED', attempts: updated.attempts as number, pushedAt: null, externalOrderId: null }),
    false,
  )
})

test('o3d-2k5r port: converting an expired claim never LOWERS a real attempt count', async () => {
  reset()
  state.link = { state: 'PENDING_CREATE', attempts: 4, lastAttemptAt: EXPIRED_CLAIM }

  assert.equal(await (await port()).recordValidationFailure('so-1', 'mintsoft', 'no SKU', AT), true)
  // Four remote failures already spent; the floor must not reset the retry ladder to 1.
  assert.equal(state.upserts[0].update.attempts, 4)
})

test('o3d-2k5r port: a link that has MOVED ON is refused whatever its lease looks like', async () => {
  const p = await port()
  for (const linkState of ['SYNCED', 'PENDING_VERIFY', 'DEAD_LETTER', 'HELD', 'CANCELLED']) {
    reset()
    // A stale lastAttemptAt would pass the lease predicate — the state check has to come first,
    // or a SYNCED link is stamped VALIDATION_FAILED with a live warehouse order behind it.
    state.link = { state: linkState, attempts: 0, lastAttemptAt: EXPIRED_CLAIM }
    assert.equal(await p.recordValidationFailure('so-1', 'mintsoft', 'no SKU', AT), false, linkState)
    assert.equal(state.upserts.length, 0, linkState)
  }
})

test('o3d-2k5r port: revalidatableLinks uses the SAME order eligibility as createCandidates', async () => {
  reset()
  const p = await port()
  await p.createCandidates('mintsoft', ['wh-1'], 25)
  await p.revalidatableLinks!('mintsoft', ['wh-1'], 25)

  const candidateWhere = state.salesOrderFindManyArgs[0].where as Row
  const revalidateWhere = (state.findManyArgs[0].where as Row).order as Row

  // Promoting an order createCandidates would NOT accept parks it in PENDING_CREATE, which the
  // hard-delete guard blocks on — re-closing the door for an order that never reached the WMS.
  // Compared field by field so a new eligibility rule added to one side fails here.
  for (const key of ['status', 'paidAt', 'refundStatus', 'withdrawalHoldAt', 'withdrawalApprovedAt', 'shipFromWarehouseId']) {
    assert.deepEqual(revalidateWhere[key], candidateWhere[key], key)
  }
  assert.equal((state.findManyArgs[0].where as Row).state, 'VALIDATION_FAILED')
})

test('o3d-2k5r r2 port: updateLinkIfState is a COMPARE-AND-SET on the state, not a bare update', async () => {
  reset()
  const ok = await (await port()).updateLinkIfState('link-1', 'VALIDATION_FAILED', {
    state: 'PENDING_CREATE', lastError: null, lastAttemptAt: null,
  })

  assert.equal(ok, true)
  assert.equal(state.updateManyArgs.length, 1)
  // The predicate is the whole point. `update({ where: { id } })` cannot express it, which is
  // why this goes through the many-form: without `state` in the where, an overlapping sweep
  // stamps a pre-push state over a link another worker has already claimed and pushed, and the
  // create pass — whose candidate query selects on state alone — pushes the SAME order again.
  assert.deepEqual(state.updateManyArgs[0].where, { id: 'link-1', state: 'VALIDATION_FAILED' })
  assert.deepEqual(state.updateManyArgs[0].data, { state: 'PENDING_CREATE', lastError: null, lastAttemptAt: null })
})

test('o3d-2k5r r2 port: a CAS that matched no row reports false — the caller must not count it', async () => {
  reset()
  state.updateManyCount = 0
  assert.equal(
    await (await port()).updateLinkIfState('link-1', 'VALIDATION_FAILED', { state: 'PENDING_CREATE' }),
    false,
  )
})

test('o3d-2k5r r2 port: revalidatableLinks filters on the SHARED no-WMS-order columns, and selects them', async () => {
  reset()
  const { NO_WMS_ORDER_COLUMNS } = await import('../lib/domain/wms/order-push-sweep.ts')
  await (await port()).revalidatableLinks!('mintsoft', ['wh-1'], 25)

  const args = state.findManyArgs[0]
  const where = args.where as Row
  // Not "pushedAt: null, externalOrderId: null" restated here — the SAME object the re-queue
  // guard reads, so a column added to the rule is added to the query by construction. A link
  // the hard-delete guard refuses to let go of must never occupy a slot in this bounded batch:
  // nothing in the pass re-stamps a skipped link, and the ordering is lastAttemptAt-nulls-first,
  // so a handful of them would sit at the head of the queue and starve the promotable tail.
  for (const [column, value] of Object.entries(NO_WMS_ORDER_COLUMNS)) {
    assert.deepEqual(where[column], value, column)
  }
  // And the COUNT must apply the same filter, or the overflow notice reports a backlog that
  // includes rows this pass can never act on.
  for (const [column, value] of Object.entries(NO_WMS_ORDER_COLUMNS)) {
    assert.deepEqual((state.countArgs[0].where as Row)[column], value, `count: ${column}`)
  }
  // Selected as well as filtered, so the core decides with the shared predicate rather than
  // trusting this port to have filtered.
  const select = args.select as Row
  for (const column of Object.keys(NO_WMS_ORDER_COLUMNS)) {
    assert.equal(select[column], true, `select: ${column}`)
  }
})
