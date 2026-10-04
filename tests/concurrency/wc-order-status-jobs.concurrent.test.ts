import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import { assertWcAttemptMayWrite, currentWcAttemptSignal } from '@/lib/connectors/woocommerce/attempt-fence'
import { waitUntilParkedBehind } from '../helpers/lock-wait-observer'

/**
 * o3d-6ldlj — THE DURABLE WOOCOMMERCE CANCEL / HOLD JOBS AGAINST A REAL POSTGRES.
 *
 * The outbox claim, the back-off clock, the attempt bound, the idempotency key, the order-lock ordering and the
 * transaction the enqueue lives in are all SQL, so they are driven here for real: the assertions read the
 * `integration_outbox` and `sales_orders` rows afterwards. Only the WooCommerce edge is a double —
 * `@/lib/shopping`'s `pushSalesOrderStatus`, modelled as a storefront that holds a status, can fail its read,
 * can be PAUSED inside a request by a deferred promise (never a sleep), and counts the GETs and PUTs it was asked
 * for. (The facade -> connector mapping and the classifier are tested in tests/wc-ims-status-push-guard.test.ts and
 * tests/wc-status-push-eligibility.test.ts.) `scheduleShoppingOrderStatusPush` and
 * `processShoppingOrderStatusPushes` are the REAL jobs behind the facade's names, so the real action
 * (`applySalesOrderStatusTransition`) enqueues and drains real rows. No network, no live store: the repo's
 * outbound-network trap is loaded by `npm run test:concurrency`.
 *
 * Nothing here assumes the local rig: the database is whatever DATABASE_URL names and the scratch guard has
 * verified, fixtures carry a per-run random id and are removed afterwards, and no role or password is
 * hard-coded. Every test asserts its precondition (the double was reached, the row really is in the state the
 * case says) so it cannot pass by examining nothing.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

type FacadeResult = { success: boolean; skipped?: boolean; error?: string; outcome?: Record<string, unknown> }
type Gate = { mode: 'honour' | 'ignore'; reached: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }

/** The storefront, as the facade sees it. */
const wc = {
  status: 'processing',
  /** The store keeps reporting its old status after a PUT: isolates the claim CAS / ownership check from an
   *  "already at target" re-read. */
  staysAtStatus: false,
  readFails: false,
  gets: 0,
  puts: 0,
  events: [] as string[],
  /** The status push resolves to this shape instead of the storefront model. */
  statusOverride: null as FacadeResult | null,
  /** A PAUSED WooCommerce request, consumed by the first status push only. `honour` ends when the attempt signal
   *  aborts (as a real aborted fetch does); `ignore` models a request that does not notice. */
  gate: null as Gate | null,
}
const activity: Array<Record<string, unknown>> = []
/** When set, logActivity THROWS for this action: models the process failing after the transaction committed. */
const activityFault = { action: null as string | null }

function newGate(mode: Gate['mode']): Gate {
  return { mode, reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
}

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => {
      // Only the INFO audit row written after the commit: the action's own error handler logs the same action at ERROR.
      if (activityFault.action !== null && entry.action === activityFault.action && entry.level !== 'ERROR') throw new Error('forced failure after the commit')
      activity.push(entry)
    },
    logActivityInTransaction: async () => {},
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })

function classify(status: string, target: 'cancelled' | 'on-hold'): FacadeResult | null {
  if (status === target) return { success: true, outcome: { kind: 'already-at-target' } }
  if (status === 'completed' || status === 'refunded' || (status === 'cancelled' && target === 'on-hold')) {
    return { success: true, outcome: { kind: 'ineligible', wcStatus: status, class: 'finalised' } }
  }
  if (status === 'partial-shipped') return { success: true, outcome: { kind: 'ineligible', wcStatus: status, class: 'needs-operator' } }
  if (status === 'weird-custom') return { success: true, outcome: { kind: 'ineligible', wcStatus: status, class: 'unknown' } }
  return null
}

mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => {},
    pushOrderDeliveryMetadata: async () => ({ success: true, skipped: true }),
    processShoppingOrderCompletions: async () => ({}),
    scheduleShoppingOrderCompletion: async () => null,
    // The REAL jobs behind the facade's names.
    scheduleShoppingOrderStatusPush: async (tx: never, input: { orderId: string; target: 'CANCELLED' | 'ON_HOLD'; flippedAt: Date }) => {
      const jobs = await import('@/lib/connectors/woocommerce/sync/order-status-jobs')
      return input.target === 'CANCELLED' ? jobs.scheduleWcOrderCancel(tx, input) : jobs.scheduleWcOrderHold(tx, input)
    },
    processShoppingOrderStatusPushes: async (options?: object) => {
      const jobs = await import('@/lib/connectors/woocommerce/sync/order-status-jobs')
      return jobs.processWcOrderStatusJobs(options)
    },
    pushSalesOrderStatus: async (orderId: string, status: string): Promise<FacadeResult> => {
      wc.events.push(`status:${orderId}:${status}`)
      wc.gets++ // every attempt re-reads the storefront
      if (wc.statusOverride) return wc.statusOverride
      const gate = wc.gate
      if (gate) {
        wc.gate = null // first push only
        gate.reached.resolve()
        const signal = currentWcAttemptSignal()
        try {
          await new Promise<void>((resolve, reject) => {
            void gate.release.promise.then(resolve)
            if (gate.mode === 'honour') {
              if (signal?.aborted) reject(new Error('WooCommerce request aborted at the attempt deadline'))
              signal?.addEventListener('abort', () => reject(new Error('WooCommerce request aborted at the attempt deadline')), { once: true })
            } else {
              // A request that does not notice the deadline ends when the harness says so; the harness says so
              // once the deadline has fired, so the request runs on PAST it.
              signal?.addEventListener('abort', () => gate.release.resolve(), { once: true })
            }
          })
        } catch (error) {
          const message = (error as Error).message
          return { success: false, error: message, outcome: { kind: 'error', error: message } }
        }
      }
      if (wc.readFails) return { success: false, error: 'WooCommerce: HTTP 503', outcome: { kind: 'read-failed', error: 'HTTP 503' } }
      const target = status === 'CANCELLED' ? 'cancelled' : 'on-hold'
      const verdict = classify(wc.status, target)
      if (verdict) return verdict
      // What the connector does right before its PUT.
      try { await assertWcAttemptMayWrite() } catch (error) {
        const message = (error as Error).message
        return { success: false, error: message, outcome: { kind: 'error', error: message } }
      }
      wc.puts++
      if (!wc.staysAtStatus) wc.status = target
      return { success: true, outcome: { kind: 'pushed' } }
    },
  },
})

function pauseNextRequest(mode: Gate['mode']): Gate {
  const gate = newGate(mode)
  wc.gate = gate
  return gate
}

function resetWc() {
  wc.status = 'processing'
  wc.staysAtStatus = false
  wc.readFails = false
  wc.gets = 0
  wc.puts = 0
  wc.events.length = 0
  wc.statusOverride = null
  wc.gate = null
  activity.length = 0
  activityFault.action = null
}

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

async function loadDeps() {
  loadEnv()
  const [{ db }, jobs, outbox, allocation, bypass] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/connectors/woocommerce/sync/order-status-jobs'),
    import('@/lib/domain/integrations/outbox'),
    import('@/lib/domain/sales/allocation-service'),
    import('@/lib/sales/status-transition-bypass'),
  ])
  return { db, ...jobs, ...outbox, lockSalesOrder: allocation.lockSalesOrder, INTERNAL_STATUS_TRANSITION_BYPASS: bypass.INTERNAL_STATUS_TRANSITION_BYPASS }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

type Kind = {
  name: 'cancel' | 'hold'
  operation: 'order.cancel' | 'order.hold'
  workerId: string
  ims: 'CANCELLED' | 'ON_HOLD'
  wcTarget: 'cancelled' | 'on-hold'
  schedule: Deps['scheduleWcOrderCancel']
  process: Deps['processWcOrderCancelJobs']
}
const kindsOf = (deps: Deps): Kind[] => [
  { name: 'cancel', operation: 'order.cancel', workerId: 'woocommerce-order-cancel', ims: 'CANCELLED', wcTarget: 'cancelled', schedule: deps.scheduleWcOrderCancel, process: deps.processWcOrderCancelJobs },
  { name: 'hold', operation: 'order.hold', workerId: 'woocommerce-order-hold', ims: 'ON_HOLD', wcTarget: 'on-hold', schedule: deps.scheduleWcOrderHold, process: deps.processWcOrderHoldJobs },
]

const runId = `6ldlj-${process.pid}-${randomUUID()}`
let sequence = 0

/** A real SalesOrder (status as the case says) with, optionally, a WooCommerce link. */
async function seedOrder(deps: Deps, label: string, status: string, options: { linked?: boolean } = {}) {
  const { Prisma } = await import('@/app/generated/prisma/client')
  const n = sequence++
  const order = await deps.db.salesOrder.create({
    data: {
      orderNumber: `${runId}-${label}-${n}`,
      status: status as never,
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('10'),
      totalForeign: new Prisma.Decimal('10'),
      subtotalBase: new Prisma.Decimal('10'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('10'),
    },
    select: { id: true },
  })
  if (options.linked !== false) {
    await deps.db.shoppingOrderLink.create({
      data: { orderId: order.id, connector: 'woocommerce', externalOrderId: `${runId}-${label}-${n}-ext` },
    })
  }
  return order.id
}
const setImsStatus = (deps: Deps, orderId: string, status: string) => deps.db.salesOrder.update({ where: { id: orderId }, data: { status: status as never } })

/** A committed row, exactly as the flipping transaction leaves it. */
async function seedRow(deps: Deps, kind: Kind, label: string, orderStatus: string = kind.ims) {
  const orderId = await seedOrder(deps, label, orderStatus)
  const flippedAt = new Date(1_760_000_000_000 + sequence)
  const ref = await deps.db.$transaction((tx) => kind.schedule(tx, { orderId, flippedAt }))
  assert.ok(ref, `precondition: the linked order ${label} got a job`)
  return { orderId, key: ref.key, flippedAt }
}
const rowOf = (deps: Deps, key: string) => deps.db.integrationOutbox.findUniqueOrThrow({ where: { idempotencyKey: key } })
const outboxCountFor = (deps: Deps, orderId: string) => deps.db.integrationOutbox.count({ where: { idempotencyKey: { contains: orderId } } })
/** The order ids are cuids, not run-prefixed, so a row is found by ITS ORDER, not by the run id. */
async function cleanupRowsOf(deps: Deps, orderIds: string[]) {
  for (const orderId of orderIds) await deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: orderId } } })
}

/** Wait for a CONDITION (never to order two racing actors). Bounded. */
async function until(predicate: () => Promise<boolean>, what: string, budgetMs = 8_000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// Every test cleans the order rows it created, and the outbox rows keyed on those order ids.
const createdOrders: string[] = []
async function newOrder(deps: Deps, label: string, status: string, options?: { linked?: boolean }) {
  const id = await seedOrder(deps, label, status, options)
  createdOrders.push(id)
  return id
}
async function newRow(deps: Deps, kind: Kind, label: string, orderStatus?: string) {
  const seeded = await seedRow(deps, kind, label, orderStatus)
  createdOrders.push(seeded.orderId)
  return seeded
}
async function teardown(deps: Deps) {
  await cleanupRowsOf(deps, createdOrders.splice(0))
  await deps.db.salesOrder.deleteMany({ where: { orderNumber: { startsWith: runId } } })
}
test('o3d-6ldlj (arm 7): a transient read failure is RETRIED on the clock and then pushed — for cancel and hold', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    resetWc()
    const { orderId, key } = await newRow(deps, kind, `transient-${kind.name}`)
    const t0 = new Date()

    wc.readFails = true
    const first = await kind.process({ idempotencyKeys: [key], now: t0 })
    assert.equal(first.claimed, 1, `${kind.name}: precondition: the row was claimed`)
    assert.equal(wc.gets, 1, `${kind.name}: precondition: the failing read double was reached`)
    assert.equal(wc.puts, 0)
    const afterFirst = await rowOf(deps, key)
    assert.equal(afterFirst.status, 'RETRYABLE_FAILED')
    assert.equal(afterFirst.attempts, 1)
    assert.ok(afterFirst.nextAttemptAt && afterFirst.nextAttemptAt.getTime() > t0.getTime(), 'a retry time was scheduled')
    assert.match(String(afterFirst.lastError), /503/)
    assert.equal(activity.filter((a) => a.action === `wc_${kind.name}_retry` && a.level === 'WARNING').length, 1, 'a WARNING was logged')

    wc.readFails = false
    const early = await kind.process({ idempotencyKeys: [key], now: t0 })
    assert.equal(early.claimed, 0, 'not claimable before nextAttemptAt (the back-off is real)')

    const second = await kind.process({ idempotencyKeys: [key], now: new Date(afterFirst.nextAttemptAt!.getTime() + 1) })
    assert.equal(second.claimed, 1)
    assert.equal(wc.puts, 1, `${kind.name}: one PUT once the storefront is readable`)
    assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
    assert.deepEqual(wc.events, [`status:${orderId}:${kind.ims}`, `status:${orderId}:${kind.ims}`], 'every attempt re-reads the storefront')
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 8): IMS SUPERSESSION — a hold that was released, or an order since cancelled, sends ZERO WooCommerce requests', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  const [, hold] = kindsOf(deps)
  const cases: Array<{ name: string; imsNow: string }> = [
    { name: 'hold released back to PROCESSING', imsNow: 'PROCESSING' },
    { name: 'held order then CANCELLED', imsNow: 'CANCELLED' },
  ]
  let evaluated = 0
  for (const c of cases) {
    resetWc()
    const { key } = await newRow(deps, hold, `superseded-${evaluated}`, c.imsNow) // the order is NOT ON_HOLD any more
    const run = await hold.process({ idempotencyKeys: [key] })
    assert.equal(run.claimed, 1, `${c.name}: precondition: the row was claimed`)
    assert.equal(wc.gets, 0, `${c.name}: ZERO WooCommerce reads`)
    assert.equal(wc.puts, 0, `${c.name}: ZERO WooCommerce writes`)
    assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED', `${c.name}: superseded is a settled outcome`)
    assert.equal(activity.filter((a) => a.action === 'wc_status_push_superseded').length, 1, `${c.name}: recorded, and says only that THIS attempt sent nothing`)
    assert.match(String(activity.find((a) => a.action === 'wc_status_push_superseded')?.description), /This attempt sent nothing to WooCommerce/)
    evaluated++
  }
  assert.equal(evaluated, 2)

  // An order that no longer exists in IMS has nothing to push either.
  resetWc()
  const { orderId, key } = await newRow(deps, hold, 'superseded-deleted')
  await deps.db.salesOrder.delete({ where: { id: orderId } })
  await hold.process({ idempotencyKeys: [key] })
  assert.equal(wc.gets, 0)
  assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
})

test('o3d-6ldlj (arm 8b): hold then cancel — the hold job is superseded and only the cancel is pushed', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  const [cancel, hold] = kindsOf(deps)
  resetWc()
  const orderId = await newOrder(deps, 'hold-then-cancel', 'ON_HOLD')
  const holdRef = await deps.db.$transaction((tx) => hold.schedule(tx, { orderId, flippedAt: new Date(1_760_000_100_000) }))
  await setImsStatus(deps, orderId, 'CANCELLED')
  const cancelRef = await deps.db.$transaction((tx) => cancel.schedule(tx, { orderId, flippedAt: new Date(1_760_000_200_000) }))
  assert.ok(holdRef && cancelRef && holdRef.key !== cancelRef.key, 'precondition: two distinct rows for the order')

  await hold.process({ idempotencyKeys: [holdRef.key] })
  assert.equal(wc.gets, 0, 'the hold job touched WooCommerce not at all')
  await cancel.process({ idempotencyKeys: [cancelRef.key] })
  assert.equal(wc.puts, 1, 'exactly the cancel was pushed')
  assert.equal(wc.status, 'cancelled')
  assert.deepEqual([(await rowOf(deps, holdRef.key)).status, (await rowOf(deps, cancelRef.key)).status], ['SUCCEEDED', 'SUCCEEDED'])
})

test('o3d-6ldlj (arm 8c): IMS supersession DURING the attempt — a hold released while the request is in flight is not written, then settles as superseded', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  const [, hold] = kindsOf(deps)
  resetWc()
  const { orderId, key } = await newRow(deps, hold, 'mid-attempt')
  const gate = pauseNextRequest('ignore')

  const attempt = hold.process({ idempotencyKeys: [key], attemptDeadlineMs: 600_000 })
  await gate.reached.promise
  assert.equal(wc.gets, 1, 'precondition: the attempt is paused INSIDE its WooCommerce request')
  assert.equal((await rowOf(deps, key)).status, 'PROCESSING', 'and still owns its row')
  // The operator releases the hold in IMS while the request is in flight; the deadline is far away and the row is
  // still ours, so ONLY the IMS re-read before the PUT can stop the write.
  await setImsStatus(deps, orderId, 'PROCESSING')
  gate.release.resolve()
  const run = await attempt
  assert.equal(run.claimed, 1)
  assert.equal(wc.puts, 0, 'the write was refused: IMS no longer wants it')
  const row = await rowOf(deps, key)
  assert.equal(row.status, 'RETRYABLE_FAILED')
  assert.match(String(row.lastError), /no longer in the status being pushed/)

  // The next attempt settles it as superseded, with zero further WooCommerce requests.
  const getsBefore = wc.gets
  await hold.process({ idempotencyKeys: [key], now: new Date(row.nextAttemptAt!.getTime() + 1) })
  assert.equal(wc.gets, getsBefore, 'the retry never reached WooCommerce')
  assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
})

test('o3d-6ldlj (arm 9): a FINALISED storefront order is left alone — success, a WARNING, and NO exception', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    const finalised = kind.name === 'cancel' ? ['completed', 'refunded'] : ['completed', 'refunded', 'cancelled']
    for (const slug of finalised) {
      resetWc()
      wc.status = slug
      const { key } = await newRow(deps, kind, `final-${kind.name}-${slug}`)
      await kind.process({ idempotencyKeys: [key] })
      assert.equal(wc.gets, 1, `${kind.name}/${slug}: precondition: the storefront was read`)
      assert.equal(wc.puts, 0, `${kind.name}/${slug}: nothing was written over it`)
      assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED', `${kind.name}/${slug}: settled, not an exception`)
      const warn = activity.filter((a) => a.action === 'wc_status_push_left_alone')
      assert.equal(warn.length, 1, `${kind.name}/${slug}: a WARNING says the two systems may disagree`)
      assert.equal(warn[0].level, 'WARNING')
      assert.match(String(warn[0].description), /did not change WooCommerce/)
      evaluated++
    }
  }
  assert.equal(evaluated, 5)
})

test('o3d-6ldlj (arm 10): a partial-shipped / withdrawal order NEEDS AN OPERATOR — immediate PERMANENT_FAILED with explanatory text, zero PUTs, and Replay re-checks', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    resetWc()
    wc.status = 'partial-shipped'
    const { key } = await newRow(deps, kind, `operator-${kind.name}`)
    const run = await kind.process({ idempotencyKeys: [key] })
    assert.equal(wc.gets, 1, `${kind.name}: precondition: the storefront was read`)
    assert.equal(wc.puts, 0)
    assert.equal(run.deadLettered, 1)
    const row = await rowOf(deps, key)
    assert.equal(row.status, 'PERMANENT_FAILED', `${kind.name}: straight to the exception inbox`)
    assert.equal(row.attempts, 1, 'not retried: retrying cannot change a stable refusal')
    assert.match(String(row.lastError), /part-shipped or EU-withdrawal/)
    assert.match(String(row.lastError), /this attempt did not change WooCommerce/, 'accurate: the connector refused BEFORE any PUT of this attempt, and says no more than that')
    assert.equal(activity.filter((a) => a.action === `wc_${kind.name}_dead_lettered` && a.level === 'ERROR').length, 1)

    // The operator resolves it in the storefront and presses Replay: the retry re-reads and pushes.
    wc.status = 'processing'
    await deps.db.integrationOutbox.update({ where: { idempotencyKey: key }, data: { status: 'PENDING', attempts: 0, lastError: null, lockedAt: null, lockedBy: null } })
    await kind.process({ idempotencyKeys: [key] })
    assert.equal(wc.puts, 1, `${kind.name}: pushed after the operator's Replay`)
    assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 11): skipped / not-applicable / no outcome / failures / unknown are NOT success; only pushed, already-at-target and finalised are', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  const retrying: Array<{ name: string; result: FacadeResult }> = [
    { name: 'no runnable connector (skipped)', result: { success: true, skipped: true } },
    { name: 'skipped even with a pushed outcome attached (isolates the skipped check from the no-outcome check)', result: { success: true, skipped: true, outcome: { kind: 'pushed' } } },
    { name: 'not-applicable outcome', result: { success: true, outcome: { kind: 'not-applicable' } } },
    { name: 'success with no outcome at all', result: { success: true } },
    { name: 'write-failed outcome', result: { success: false, error: 'HTTP 500', outcome: { kind: 'write-failed', error: 'HTTP 500' } } },
    { name: 'a success:true that carries a read-failed outcome (isolates the outcome switch from the success flag)', result: { success: true, outcome: { kind: 'read-failed', error: 'HTTP 503' } } },
    { name: 'a success:true that carries an error outcome', result: { success: true, outcome: { kind: 'error', error: 'boom' } } },
    { name: 'unknown status class', result: { success: true, outcome: { kind: 'ineligible', wcStatus: 'foo', class: 'unknown' } } },
    { name: 'not-ready class', result: { success: true, outcome: { kind: 'ineligible', wcStatus: 'foo', class: 'not-ready' } } },
  ]
  const settled: Array<{ name: string; result: FacadeResult }> = [
    { name: 'pushed', result: { success: true, outcome: { kind: 'pushed' } } },
    { name: 'already-at-target', result: { success: true, outcome: { kind: 'already-at-target' } } },
    { name: 'ineligible finalised', result: { success: true, outcome: { kind: 'ineligible', wcStatus: 'completed', class: 'finalised' } } },
  ]
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    for (const c of retrying) {
      resetWc()
      const { key } = await newRow(deps, kind, `map-retry-${kind.name}-${evaluated}`)
      wc.statusOverride = c.result
      const first = await kind.process({ idempotencyKeys: [key] })
      assert.equal(first.claimed, 1, `${kind.name}/${c.name}: precondition: claimed and the override reached`)
      assert.equal(wc.gets, 1)
      const row = await rowOf(deps, key)
      assert.equal(row.status, 'RETRYABLE_FAILED', `${kind.name}/${c.name}: must retry, not SUCCEEDED (was ${row.status})`)
      assert.equal(row.attempts, 1)
      // Restoring the connector pushes it.
      wc.statusOverride = null
      await kind.process({ idempotencyKeys: [key], now: new Date(row.nextAttemptAt!.getTime() + 1) })
      assert.equal(wc.puts, 1, `${kind.name}/${c.name}: pushed once the connector is back`)
      assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
      evaluated++
    }
    for (const c of settled) {
      resetWc()
      const { key } = await newRow(deps, kind, `map-ok-${kind.name}-${evaluated}`)
      wc.statusOverride = c.result
      await kind.process({ idempotencyKeys: [key] })
      assert.equal(wc.gets, 1, `${kind.name}/${c.name}: precondition`)
      assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED', `${kind.name}/${c.name}`)
      evaluated++
    }
  }
  assert.equal(evaluated, 2 * (retrying.length + settled.length))
})

test('o3d-6ldlj (arm 12): exactly one sender per row however many workers race (immediate attempts AND the cron drain), and a settled row is never re-claimed', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    resetWc()
    const { key } = await newRow(deps, kind, `race-${kind.name}`)
    // The store keeps reporting `processing` after the PUT and the winner is PARKED inside its request until the
    // seven losers have all returned, so neither an "already at target" re-read nor timing can explain a PUT count
    // of 1: only the claim's compare-and-set can.
    wc.staysAtStatus = true
    const gate = pauseNextRequest('ignore')
    const WORKERS = 8
    const drain = () => deps.processWcOrderStatusJobs({ idempotencyKeys: [key] })
    const cronDrain = () => deps.processWcOrderStatusJobs() // what the cron calls: no keys
    const all = Array.from({ length: WORKERS }, (_, i) => (i === 0 ? cronDrain() : drain()))
    const settled = new Set<number>()
    all.forEach((promise, i) => { void promise.then(() => settled.add(i)) })
    await gate.reached.promise
    // Whoever won the claim is parked inside its request; the other seven return without sending.
    await until(async () => settled.size === WORKERS - 1, 'the seven losing workers to return')
    gate.release.resolve()
    const results = await Promise.all(all)
    const claimed = results.reduce((sum, r) => sum + r.claimed, 0)
    assert.ok(claimed >= 1, 'precondition: someone claimed it')
    assert.equal(claimed, 1, `${kind.name}: exactly one worker claimed the row (claimed=${claimed})`)
    assert.equal(wc.puts, 1, `${kind.name}: and exactly one PUT was sent`)
    assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
    const again = await deps.processWcOrderStatusJobs({ idempotencyKeys: [key] })
    assert.equal(again.claimed, 0, 're-running after SUCCEEDED claims nothing')
    assert.equal(wc.puts, 1)
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 13): the idempotency key is one row per flip — a replay is the same row, hold -> release -> hold is two; unlinked orders get none', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  const [cancel, hold] = kindsOf(deps)
  const orderId = await newOrder(deps, 'keys', 'PROCESSING')
  const flippedAt = new Date(1_760_000_123_456)

  const keys = await deps.db.$transaction(async (tx) => {
    const first = await hold.schedule(tx, { orderId, flippedAt })
    const replay = await hold.schedule(tx, { orderId, flippedAt }) // a replayed transaction
    const second = await hold.schedule(tx, { orderId, flippedAt: new Date(flippedAt.getTime() + 1) }) // hold -> release -> hold
    const cancelRef = await cancel.schedule(tx, { orderId, flippedAt })
    return { first, replay, second, cancelRef }
  })
  assert.ok(keys.first && keys.replay && keys.second && keys.cancelRef, 'precondition: keys were returned for a linked order')
  assert.equal(keys.replay.key, keys.first.key)
  assert.notEqual(keys.second.key, keys.first.key)
  assert.notEqual(keys.cancelRef.key, keys.first.key, 'cancel and hold never share a row')
  assert.equal(keys.first.operation, 'order.hold')
  assert.equal(await outboxCountFor(deps, orderId), 3, 'three rows: two holds (one per flip) and one cancel')
  // The key carries a STRING epoch: two flips inside one day are two rows (a Date part would truncate to the day).
  assert.match(keys.first.key, new RegExp(`^woocommerce:order\\.hold:${orderId}:${flippedAt.getTime()}$`))

  const unlinked = await newOrder(deps, 'keys-unlinked', 'PROCESSING', { linked: false })
  const none = await deps.db.$transaction((tx) => hold.schedule(tx, { orderId: unlinked, flippedAt }))
  assert.equal(none, null)
  assert.equal(await outboxCountFor(deps, unlinked), 0)
})

test('o3d-6ldlj (arm 14): the enqueue rolls back with its transaction', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    const orderId = await newOrder(deps, `rollback-${kind.name}`, kind.ims)
    const forced = new Error('the flip failed after the enqueue')
    await assert.rejects(
      deps.db.$transaction(async (tx) => {
        const ref = await kind.schedule(tx, { orderId, flippedAt: new Date() })
        assert.ok(ref, 'precondition: the row was written inside the transaction')
        throw forced
      }),
      (error: unknown) => error === forced,
    )
    assert.equal(await outboxCountFor(deps, orderId), 0, `${kind.name}: nothing survives the rollback`)
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 15): a storefront that never comes back dead-letters at the bound on the 5/10/20/40/60/60/60 minute schedule, with zero PUTs', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  assert.equal(deps.WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS, 8, 'the documented bound')
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    resetWc()
    const { key } = await newRow(deps, kind, `dead-${kind.name}`)
    wc.readFails = true

    let now = new Date()
    const delaysMs: number[] = []
    for (let attempt = 1; attempt <= deps.WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS + 2; attempt++) {
      const summary = await kind.process({ idempotencyKeys: [key], now })
      const row = await rowOf(deps, key)
      if (summary.claimed === 0) {
        assert.equal(row.status, 'PERMANENT_FAILED', 'once dead-lettered nothing claims it again')
        break
      }
      assert.equal(row.attempts, attempt, `attempt ${attempt} was recorded`)
      if (row.nextAttemptAt) {
        delaysMs.push(row.nextAttemptAt.getTime() - now.getTime())
        now = new Date(row.nextAttemptAt.getTime() + 1)
      }
    }
    const row = await rowOf(deps, key)
    assert.equal(row.status, 'PERMANENT_FAILED')
    assert.equal(row.attempts, deps.WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS, 'gave up at exactly the bound')
    assert.equal(wc.puts, 0)
    assert.equal(wc.gets, deps.WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS)
    const minutes = delaysMs.map((ms) => Math.round(ms / 60_000))
    assert.deepEqual(minutes, [5, 10, 20, 40, 60, 60, 60], `${kind.name}: back-off schedule in minutes: ${minutes.join(', ')}`)
    assert.equal(activity.filter((a) => a.action === `wc_${kind.name}_dead_lettered` && a.level === 'ERROR').length, 1, 'an ERROR was logged once')
    assert.match(String(row.lastError), /503/)
    assert.match(String(activity.find((a) => a.action === `wc_${kind.name}_dead_lettered`)?.description), /may not reflect/)
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 16): crash safety — a row committed with the flip is pushed by the cron drain though the post-commit attempt never ran', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    resetWc()
    const { orderId, key } = await newRow(deps, kind, `crash-${kind.name}`) // the flip committed; the process died before any attempt
    assert.equal((await rowOf(deps, key)).status, 'PENDING', 'precondition: nothing has attempted it')
    const drain = await deps.processWcOrderStatusJobs() // what the cron calls: no keys
    assert.ok(drain.claimed >= 1, 'the drain found it')
    assert.ok(wc.events.includes(`status:${orderId}:${kind.ims}`))
    assert.equal(wc.puts >= 1, true)
    assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
    evaluated++
  }
  assert.equal(evaluated, 2)
})

async function claimAndAge(deps: Deps, kind: Kind, key: string, t0: Date, ageMs = 3_600_000) {
  const [claimed] = await deps.claimIntegrationOutboxWork({
    connector: 'woocommerce', operation: kind.operation, idempotencyKeys: [key],
    limit: 1, workerId: kind.workerId, maxAttempts: deps.WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS, now: t0,
  })
  assert.ok(claimed, 'precondition: the row is claimed')
  await deps.db.integrationOutbox.update({ where: { idempotencyKey: key }, data: { lockedAt: new Date(t0.getTime() - ageMs) } })
}

test('o3d-6ldlj (arm 17): a claim whose worker died is surfaced as PERMANENT_FAILED, never re-driven; the message does NOT claim nothing was sent; Replay pushes it', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    resetWc()
    const { orderId, key } = await newRow(deps, kind, `killed-${kind.name}`)
    const fresh = await newRow(deps, kind, `fresh-claim-${kind.name}`)
    const t0 = new Date()
    await claimAndAge(deps, kind, key, t0)
    const [freshClaim] = await deps.claimIntegrationOutboxWork({
      connector: 'woocommerce', operation: kind.operation, idempotencyKeys: [fresh.key],
      limit: 1, workerId: kind.workerId, maxAttempts: deps.WC_ORDER_STATUS_PUSH_MAX_ATTEMPTS, now: t0,
    })
    assert.ok(freshClaim, 'precondition: the second claim is recent (inside the lease)')
    assert.equal((await rowOf(deps, key)).status, 'PROCESSING')

    const drain = await deps.processWcOrderStatusJobs({ now: t0 })
    assert.equal(wc.puts, 0, 'the unsafe-to-replay row is NOT re-driven automatically')
    const parked = await rowOf(deps, key)
    assert.equal(parked.status, 'PERMANENT_FAILED', 'surfaced in Sync > Exceptions, not stuck PROCESSING')
    assert.match(String(parked.lastError), /NOT known whether WooCommerce changed/)
    assert.doesNotMatch(String(parked.lastError), /nothing was sent|was not sent|never sent/i, 'must never assert what is not known')
    assert.equal(drain.deadLettered >= 1, true)
    const activityRow = activity.find((a) => a.action === `wc_${kind.name}_dead_lettered` && a.entityId === orderId)
    assert.ok(activityRow, 'an ERROR is logged for the parked order')
    assert.doesNotMatch(String(activityRow.description), /nothing was sent|was not sent|never sent/i)
    assert.equal((await rowOf(deps, fresh.key)).status, 'PROCESSING', 'a claim still inside its lease is left alone')

    await deps.db.integrationOutbox.update({ where: { idempotencyKey: key }, data: { status: 'PENDING', attempts: 0, lastError: null, lockedAt: null, lockedBy: null } })
    await kind.process({ idempotencyKeys: [key], now: t0 })
    assert.equal(wc.puts, 1, 'the Replay re-reads both systems and pushes exactly once')
    assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 17b): a slow worker that finishes while the park is waiting wins — the park is a compare-and-set, not an overwrite', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    resetWc()
    const { key } = await newRow(deps, kind, `slow-worker-${kind.name}`)
    const t0 = new Date()
    await claimAndAge(deps, kind, key, t0)

    // The "dead" worker is only slow: it holds the row and is about to record success.
    const holderReady = Promise.withResolvers<number>()
    const holderGo = Promise.withResolvers<void>()
    const holder = deps.db.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
      await tx.$queryRaw`SELECT id FROM integration_outbox WHERE "idempotencyKey" = ${key} FOR UPDATE`
      holderReady.resolve(pid)
      await holderGo.promise
      await tx.integrationOutbox.update({ where: { idempotencyKey: key }, data: { status: 'SUCCEEDED', lockedAt: null, lockedBy: null } })
    }, { timeout: 30_000 })
    const holderPid = await holderReady.promise

    const parking = deps.parkStaleWcOrderStatusClaims(t0, [kind.name === 'cancel' ? deps.WC_ORDER_CANCEL_JOB : deps.WC_ORDER_HOLD_JOB])
    // Release the holder only once the park's UPDATE is demonstrably blocked behind it.
    const parked = await waitUntilParkedBehind(deps.db, { holderPid, waitingOn: /integration_outbox/i, describe: `${kind.name} park behind the slow worker` })
    assert.ok(parked.pid > 0, 'precondition: the park really was waiting on the row the slow worker holds')
    holderGo.resolve()
    await holder
    const count = await parking

    assert.equal(count, 0, 'the park lost the race and did nothing')
    assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED', 'the slow worker\'s success stands')
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 18): a PAUSED request is aborted at the attempt deadline — no PUT, a retryable row; a request that ignores the deadline still cannot PUT', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  const [cancel] = kindsOf(deps)
  resetWc()
  const honour = await newRow(deps, cancel, 'paused-honour')
  pauseNextRequest('honour') // never released: only the deadline can end it
  const run = await cancel.process({ idempotencyKeys: [honour.key], attemptDeadlineMs: 100 })
  assert.equal(run.claimed, 1, 'precondition: claimed')
  assert.equal(wc.gets, 1, 'precondition: the paused request was reached')
  assert.equal(wc.puts, 0)
  const honourRow = await rowOf(deps, honour.key)
  assert.equal(honourRow.status, 'RETRYABLE_FAILED')
  assert.match(String(honourRow.lastError), /abort|deadline/i)

  resetWc()
  const ignore = await newRow(deps, cancel, 'paused-ignore')
  pauseNextRequest('ignore') // runs on past the deadline, then continues to the write
  await cancel.process({ idempotencyKeys: [ignore.key], attemptDeadlineMs: 100 })
  assert.equal(wc.gets, 1, 'precondition: the request ran to its end')
  assert.equal(wc.puts, 0, 'the pre-write deadline check refused the PUT')
  const ignoreRow = await rowOf(deps, ignore.key)
  assert.equal(ignoreRow.status, 'RETRYABLE_FAILED', 'and the row is still ours (not parked), so only the deadline can explain it')
  assert.match(String(ignoreRow.lastError), /deadline passed/)
})

test('o3d-6ldlj (arm 19): park + Replay while a worker is paused completes EXACTLY ONCE — the paused worker never PUTs (ownership isolated: deadline far, IMS still wants it)', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const kind of kindsOf(deps)) {
    resetWc()
    const { key } = await newRow(deps, kind, `park-replay-${kind.name}`)
    // The store keeps reporting `processing` after B's PUT, so "already at target" cannot explain A's silence.
    wc.staysAtStatus = true
    const gate = pauseNextRequest('ignore')

    const a = kind.process({ idempotencyKeys: [key], attemptDeadlineMs: 600_000 })
    await gate.reached.promise
    assert.equal(wc.gets, 1, 'precondition: A is inside its paused request')
    assert.equal((await rowOf(deps, key)).status, 'PROCESSING')

    await deps.db.integrationOutbox.update({ where: { idempotencyKey: key }, data: { lockedAt: new Date(Date.now() - 3_600_000) } })
    assert.equal(await deps.parkStaleWcOrderStatusClaims(new Date()), 1, 'precondition: parked')
    await deps.db.integrationOutbox.update({ where: { idempotencyKey: key }, data: { status: 'PENDING', attempts: 0, lastError: null, lockedAt: null, lockedBy: null } })
    await kind.process({ idempotencyKeys: [key] })
    assert.equal(wc.puts, 1, 'precondition: B pushed it')
    assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')

    gate.release.resolve() // A wakes up and must not write
    const aRun = await a
    assert.equal(wc.puts, 1, `${kind.name}: exactly one PUT in total: the paused worker was refused`)
    assert.equal(aRun.claimed, 1)
    assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED', 'and its late result did not disturb the settled row')
    evaluated++
  }
  assert.equal(evaluated, 2)
})

// ---------------------------------------------------------------------------------------------------------------
// The REAL action: applySalesOrderStatusTransition enqueues INSIDE the locked transaction.
// ---------------------------------------------------------------------------------------------------------------

async function transition(deps: Deps, orderId: string, target: string, options: { pushStatusToWooCommerce?: boolean }) {
  const { applySalesOrderStatusTransition } = await import('@/app/actions/sales')
  return applySalesOrderStatusTransition(orderId, target as never, undefined, {
    ...options,
    internalBypassToken: deps.INTERNAL_STATUS_TRANSITION_BYPASS,
  })
}
const rowsForOrder = (deps: Deps, orderId: string) => deps.db.integrationOutbox.findMany({
  where: { idempotencyKey: { contains: orderId } },
  select: { operation: true, status: true, idempotencyKey: true },
})

test('o3d-6ldlj (arm 20): a manual CANCEL / HOLD enqueues in the locked transaction and the post-commit attempt pushes it', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  const cases = [
    { target: 'CANCELLED', from: 'PROCESSING', operation: 'order.cancel', wc: 'cancelled' },
    { target: 'ON_HOLD', from: 'PROCESSING', operation: 'order.hold', wc: 'on-hold' },
  ]
  let evaluated = 0
  for (const c of cases) {
    resetWc()
    const orderId = await newOrder(deps, `action-${c.target}`, c.from)
    assert.equal((await rowsForOrder(deps, orderId)).length, 0, 'precondition: no row before the transition')
    const result = await transition(deps, orderId, c.target, { pushStatusToWooCommerce: true })
    assert.deepEqual(result, { success: true })
    assert.equal((await deps.db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })).status, c.target)
    const rows = await rowsForOrder(deps, orderId)
    assert.equal(rows.length, 1, `${c.target}: exactly one durable row`)
    assert.equal(rows[0].operation, c.operation)
    // The un-awaited immediate attempt completes it.
    await until(async () => (await rowsForOrder(deps, orderId))[0].status === 'SUCCEEDED', `${c.target} immediate attempt`)
    assert.equal(wc.puts, 1, `${c.target}: one PUT`)
    assert.equal(wc.status, c.wc)
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 21): NO row — and no WooCommerce request — for a WooCommerce-driven transition (pushStatusToWooCommerce:false), an unlinked order, or a status with no storefront job', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  resetWc()
  let evaluated = 0
  // The exact options withdrawal.ts and order-status.ts pass: pushStatusToWooCommerce:false.
  for (const target of ['CANCELLED', 'ON_HOLD']) {
    const orderId = await newOrder(deps, `no-push-${target}`, 'PROCESSING')
    const result = await transition(deps, orderId, target, { pushStatusToWooCommerce: false })
    assert.deepEqual(result, { success: true })
    assert.equal((await deps.db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })).status, target, `${target}: precondition: the flip itself happened`)
    assert.equal((await rowsForOrder(deps, orderId)).length, 0, `${target}: pushStatusToWooCommerce:false creates NO row`)
    evaluated++
  }
  for (const target of ['CANCELLED', 'ON_HOLD']) {
    const orderId = await newOrder(deps, `unlinked-${target}`, 'PROCESSING', { linked: false })
    const result = await transition(deps, orderId, target, { pushStatusToWooCommerce: true })
    assert.deepEqual(result, { success: true })
    assert.equal((await deps.db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })).status, target)
    assert.equal((await rowsForOrder(deps, orderId)).length, 0, `${target}: an unlinked order creates NO row`)
    evaluated++
  }
  const other = await newOrder(deps, 'other-status', 'PROCESSING')
  assert.deepEqual(await transition(deps, other, 'ALLOCATED', { pushStatusToWooCommerce: true }), { success: true })
  assert.equal((await rowsForOrder(deps, other)).length, 0, 'a status with no storefront equivalent creates no row')
  evaluated++
  assert.equal(wc.gets, 0, 'and not one WooCommerce request was made')
  assert.equal(evaluated, 5)
})

test('o3d-6ldlj (arm 22): the enqueue is atomic with the flip — a commit that fails AFTER the enqueue leaves neither the row nor the new status', { skip }, async (t) => {
  const deps = await loadDeps()
  const created: string[] = []
  t.after(async () => {
    for (const name of created) {
      await deps.db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON sales_orders`)
      await deps.db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`)
    }
    await teardown(deps)
  })
  let evaluated = 0
  for (const c of [{ target: 'CANCELLED' }, { target: 'ON_HOLD' }]) {
    resetWc()
    const orderId = await newOrder(deps, `commit-fail-${c.target}`, 'PROCESSING')
    assert.match(orderId, /^[a-z0-9]+$/, 'precondition: the id is safe to inline into the trigger body')
    const name = `zz_o3d6ldlj_${c.target.toLowerCase()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    created.push(name)
    // A DEFERRED constraint trigger fires at COMMIT, after every statement of the transaction (including the
    // enqueue) has run, and only for this one order, so it cannot touch another test's rows.
    await deps.db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${orderId}' THEN RAISE EXCEPTION 'forced commit failure for o3d-6ldlj'; END IF; RETURN NEW; END $$`)
    await deps.db.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON sales_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`)

    const result = await transition(deps, orderId, c.target, { pushStatusToWooCommerce: true })
    assert.equal(result.success, false, `${c.target}: precondition: the transaction failed at commit`)
    assert.match(String(result.error), /forced commit failure/)
    assert.equal((await deps.db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })).status, 'PROCESSING', `${c.target}: the flip rolled back`)
    assert.equal((await rowsForOrder(deps, orderId)).length, 0, `${c.target}: and so did the durable row`)
    assert.equal(wc.gets, 0, 'and no push was attempted for a flip that did not happen')

    // Control: with the trigger gone the identical call commits, the row exists and the push runs.
    await deps.db.$executeRawUnsafe(`DROP TRIGGER ${name} ON sales_orders`)
    const retry = await transition(deps, orderId, c.target, { pushStatusToWooCommerce: true })
    assert.deepEqual(retry, { success: true })
    assert.equal((await rowsForOrder(deps, orderId)).length, 1, `${c.target}: control: the same call writes its row when the commit succeeds`)
    await until(async () => (await rowsForOrder(deps, orderId))[0].status === 'SUCCEEDED', `${c.target} control attempt`)
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 22b): the row is DURABLE WITH THE FLIP — a failure AFTER the commit (before any attempt) leaves the flip and the row, and the cron drain pushes it', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  let evaluated = 0
  for (const c of [{ target: 'CANCELLED', operation: 'order.cancel', wc: 'cancelled' }, { target: 'ON_HOLD', operation: 'order.hold', wc: 'on-hold' }]) {
    resetWc()
    const orderId = await newOrder(deps, `post-commit-fail-${c.target}`, 'PROCESSING')
    // The action's own post-commit audit row throws: the action reports failure although the transaction committed,
    // and the process "dies" before the post-commit attempt is made.
    activityFault.action = 'status_changed'
    const result = await transition(deps, orderId, c.target, { pushStatusToWooCommerce: true })
    activityFault.action = null
    assert.equal(result.success, false, `${c.target}: precondition: the action failed AFTER committing`)
    assert.match(String(result.error), /forced failure after the commit/)
    assert.equal((await deps.db.salesOrder.findUniqueOrThrow({ where: { id: orderId } })).status, c.target, `${c.target}: the flip is committed`)
    const rows = await rowsForOrder(deps, orderId)
    assert.equal(rows.length, 1, `${c.target}: and so is the durable row (enqueued INSIDE the transaction, not after it)`)
    assert.equal(rows[0].operation, c.operation)
    assert.equal(rows[0].status, 'PENDING', 'precondition: nothing attempted it')
    assert.equal(wc.gets, 0)

    const drain = await deps.processWcOrderStatusJobs() // the cron
    assert.ok(drain.claimed >= 1)
    assert.equal(wc.status, c.wc, `${c.target}: the drain pushed it`)
    assert.equal((await rowsForOrder(deps, orderId))[0].status, 'SUCCEEDED')
    evaluated++
  }
  assert.equal(evaluated, 2)
})

test('o3d-6ldlj (arm 23): the enqueue happens under the ORDER LOCK — a transition parked behind another holder of the lock has written no row until it gets it', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => teardown(deps))
  resetWc()
  const orderId = await newOrder(deps, 'lock-order', 'PROCESSING')
  const holderReady = Promise.withResolvers<number>()
  const holderGo = Promise.withResolvers<void>()
  const holder = deps.db.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
    await deps.lockSalesOrder(tx, orderId)
    holderReady.resolve(pid)
    await holderGo.promise
  }, { timeout: 30_000 })
  const holderPid = await holderReady.promise

  const action = transition(deps, orderId, 'ON_HOLD', { pushStatusToWooCommerce: true })
  await waitUntilParkedBehind(deps.db, { holderPid, waitingOn: /sales_orders|pg_advisory|FOR UPDATE/i, describe: 'the hold transition behind the order lock' })
  assert.equal((await rowsForOrder(deps, orderId)).length, 0, 'precondition: parked on the lock, so no row exists yet')
  holderGo.resolve()
  await holder
  assert.deepEqual(await action, { success: true })
  const rows = await rowsForOrder(deps, orderId)
  assert.equal(rows.length, 1, 'the row appears with the flip, once the lock was obtained')
  await until(async () => (await rowsForOrder(deps, orderId))[0].status === 'SUCCEEDED', 'the immediate attempt')
})
