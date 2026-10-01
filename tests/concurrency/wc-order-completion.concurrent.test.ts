import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-zvec.15 — THE DURABLE WOOCOMMERCE ORDER-COMPLETION JOB AGAINST A REAL POSTGRES.
 *
 * The outbox claim, the retry back-off clock, the attempt bound and the idempotency key are all SQL, so
 * they are driven here for real: the assertions read the `integration_outbox` row afterwards. Only the
 * WooCommerce edge is a double — `@/lib/shopping`'s two push functions, modelled as a storefront that
 * holds a status, can fail its read, and counts the GETs and PUTs it was asked for. (The facade → connector
 * mapping of those results is tested in tests/shopping-status-push-outcome.test.ts and
 * tests/wc-ims-completion-push-guard.test.ts.) No network, no live store.
 *
 * Nothing here assumes the local rig: the database is whatever DATABASE_URL names and the scratch guard
 * has verified, rows are keyed with a per-run random id and removed afterwards, and no role or password is
 * hard-coded. Every test asserts its precondition (that the double was reached, the row really is in the
 * state the case says) so it cannot pass by examining nothing.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

type FacadeResult = { success: boolean; skipped?: boolean; error?: string; outcome?: Record<string, unknown> }

/** The storefront, as the facade sees it. */
const wc = {
  status: 'processing',
  /** When true the store keeps reporting `processing` after a PUT, which isolates the claim CAS from the
   *  "already completed" re-read: only one-sender-per-row can then hold the PUT count at 1. */
  staysProcessing: false,
  readFails: false,
  delayMs: 0,
  gets: 0,
  puts: 0,
  events: [] as string[],
}
const activity: Array<Record<string, unknown>> = []

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { activity.push(entry) } },
})
mock.module('@/lib/shopping', {
  namedExports: {
    pushOrderDeliveryMetadata: async (orderId: string) => {
      wc.events.push(`tracking:${orderId}`)
      return { success: true }
    },
    pushSalesOrderStatus: async (orderId: string, status: string): Promise<FacadeResult> => {
      wc.events.push(`status:${orderId}:${status}`)
      wc.gets++ // every attempt re-reads the storefront
      if (wc.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, wc.delayMs))
      if (wc.readFails) return { success: false, error: 'WooCommerce: HTTP 503', outcome: { kind: 'read-failed', error: 'HTTP 503' } }
      if (wc.status === 'completed') return { success: true, outcome: { kind: 'already-at-target' } }
      if (wc.status === 'cancelled') return { success: true, outcome: { kind: 'ineligible', wcStatus: 'cancelled', class: 'finalised' } }
      if (wc.status === 'on-hold') return { success: true, outcome: { kind: 'ineligible', wcStatus: 'on-hold', class: 'not-ready' } }
      wc.puts++
      if (!wc.staysProcessing) wc.status = 'completed'
      return { success: true, outcome: { kind: 'pushed' } }
    },
  },
})

function resetWc() {
  wc.status = 'processing'
  wc.staysProcessing = false
  wc.readFails = false
  wc.delayMs = 0
  wc.gets = 0
  wc.puts = 0
  wc.events.length = 0
  activity.length = 0
}

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

async function loadDeps() {
  loadEnv()
  const [{ db }, jobs, outbox] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/connectors/woocommerce/sync/order-completion-jobs'),
    import('@/lib/domain/integrations/outbox'),
  ])
  return { db, ...jobs, ...outbox }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

const runId = `zvec15-${process.pid}-${randomUUID()}`
let sequence = 0

/** A committed completion row, exactly as the shipment transaction leaves it. */
async function seedRow(deps: Deps, label: string) {
  const orderId = `${runId}-${label}-${sequence++}`
  const key = deps.wcOrderCompletionIdempotencyKey(orderId, new Date(1_760_000_000_000 + sequence))
  await deps.enqueueIntegrationOutbox({
    connector: 'woocommerce',
    operation: 'order.complete',
    idempotencyKey: key,
    payloadJson: { orderId },
    nextAttemptAt: null,
  })
  return { orderId, key }
}
const rowOf = (deps: Deps, key: string) => deps.db.integrationOutbox.findUniqueOrThrow({ where: { idempotencyKey: key } })
const cleanup = (deps: Deps) => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: runId } } })

test('o3d-zvec.15 (arm 7): a transient read failure is RETRIED on the clock and then completes — tracking before status each time', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => cleanup(deps))
  resetWc()
  const { orderId, key } = await seedRow(deps, 'transient')
  const t0 = new Date()

  // Attempt 1: the storefront read fails.
  wc.readFails = true
  const first = await deps.processWcOrderCompletionJobs({ idempotencyKeys: [key], now: t0 })
  assert.equal(first.claimed, 1, 'precondition: the row was claimed')
  assert.equal(wc.gets, 1, 'precondition: the failing read double was reached')
  assert.equal(wc.puts, 0)
  const afterFirst = await rowOf(deps, key)
  assert.equal(afterFirst.status, 'RETRYABLE_FAILED')
  assert.equal(afterFirst.attempts, 1)
  assert.ok(afterFirst.nextAttemptAt && afterFirst.nextAttemptAt.getTime() > t0.getTime(), 'a retry time was scheduled')
  assert.match(String(afterFirst.lastError), /503/)
  assert.equal(activity.filter((a) => a.action === 'wc_completion_retry' && a.level === 'WARNING').length, 1, 'a WARNING was logged')

  // Before the retry time nothing claims it (the back-off is real, not a loop).
  wc.readFails = false
  const early = await deps.processWcOrderCompletionJobs({ idempotencyKeys: [key], now: t0 })
  assert.equal(early.claimed, 0, 'not claimable before nextAttemptAt')
  assert.equal(wc.puts, 0)

  // Attempt 2, past the retry time, storefront healthy: one PUT, row SUCCEEDED.
  const second = await deps.processWcOrderCompletionJobs({ idempotencyKeys: [key], now: new Date(afterFirst.nextAttemptAt!.getTime() + 1) })
  assert.equal(second.claimed, 1)
  assert.equal(wc.puts, 1)
  assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
  assert.deepEqual(wc.events, [`tracking:${orderId}`, `status:${orderId}:SHIPPED`, `tracking:${orderId}`, `status:${orderId}:SHIPPED`], 'tracking FIRST on every attempt')
})

test('o3d-zvec.15 (arm 8): a retry RE-READS the storefront — an order cancelled in between is left alone', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => cleanup(deps))
  resetWc()
  const { key } = await seedRow(deps, 'reread')
  const t0 = new Date()

  wc.readFails = true
  await deps.processWcOrderCompletionJobs({ idempotencyKeys: [key], now: t0 })
  const afterFirst = await rowOf(deps, key)
  assert.equal(afterFirst.status, 'RETRYABLE_FAILED', 'precondition: attempt 1 failed')

  wc.readFails = false
  wc.status = 'cancelled' // an operator cancelled it while we were retrying
  await deps.processWcOrderCompletionJobs({ idempotencyKeys: [key], now: new Date(afterFirst.nextAttemptAt!.getTime() + 1) })

  assert.equal(wc.gets, 2, 'the storefront was read on EACH attempt, so a cached first status cannot pass')
  assert.equal(wc.puts, 0, 'a cancelled order is never completed')
  assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED', 'finalised is a settled outcome, not a retry')
})

test('o3d-zvec.15 (arm 8b): an order on-hold at despatch is retried, and completes if it returns to processing in time', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => cleanup(deps))
  resetWc()
  const { key } = await seedRow(deps, 'onhold')
  const t0 = new Date()

  wc.status = 'on-hold'
  await deps.processWcOrderCompletionJobs({ idempotencyKeys: [key], now: t0 })
  const afterFirst = await rowOf(deps, key)
  assert.equal(afterFirst.status, 'RETRYABLE_FAILED', 'held, not settled')
  assert.equal(wc.puts, 0)

  wc.status = 'processing'
  await deps.processWcOrderCompletionJobs({ idempotencyKeys: [key], now: new Date(afterFirst.nextAttemptAt!.getTime() + 1) })
  assert.equal(wc.puts, 1)
  assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
})

test('o3d-zvec.15 (arm 9): exactly one sender per row however many workers race, and a settled row is never re-claimed', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => cleanup(deps))
  resetWc()
  const { key } = await seedRow(deps, 'race')
  // The store keeps reporting `processing` after the PUT and the GET is slow, so the "already completed"
  // re-read cannot explain a count of 1: only the claim's compare-and-set can.
  wc.staysProcessing = true
  wc.delayMs = 250
  const WORKERS = 8

  const runs = await Promise.all(Array.from({ length: WORKERS }, () => deps.processWcOrderCompletionJobs({ idempotencyKeys: [key] })))
  const claimed = runs.reduce((sum, r) => sum + r.claimed, 0)
  assert.equal(runs.length, WORKERS, 'precondition: all workers ran')
  assert.equal(claimed, 1, `exactly one worker claimed the row (claimed=${claimed})`)
  assert.equal(wc.puts, 1, 'and exactly one PUT was sent')
  assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')

  const again = await deps.processWcOrderCompletionJobs({ idempotencyKeys: [key] })
  assert.equal(again.claimed, 0, 're-running after SUCCEEDED claims nothing')
  assert.equal(wc.puts, 1)
})

test('o3d-zvec.15 (arm 9b): the idempotency key is one row per flip — a duplicate enqueue is the same row, a re-ship is a new one', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => cleanup(deps))
  const orderId = `${runId}-key`
  const shippedAt = new Date(1_760_000_123_456)
  const stub = (tx: unknown) => Object.create(tx as object, { shoppingOrderLink: { value: { findFirst: async () => ({ id: 'link' }) } } })

  const keys = await deps.db.$transaction(async (tx) => {
    const client = stub(tx)
    const first = await deps.scheduleWcOrderCompletion(client, { orderId, shippedAt })
    const replay = await deps.scheduleWcOrderCompletion(client, { orderId, shippedAt }) // a replayed transaction
    const reship = await deps.scheduleWcOrderCompletion(client, { orderId, shippedAt: new Date(shippedAt.getTime() + 1) }) // a reopen then re-ship
    return { first, replay, reship }
  })
  assert.ok(keys.first, 'precondition: a key was returned for a linked order')
  assert.equal(keys.replay, keys.first)
  assert.notEqual(keys.reship, keys.first)
  assert.equal(await deps.db.integrationOutbox.count({ where: { idempotencyKey: { contains: orderId } } }), 2, 'two rows: one per flip')

  // An UNLINKED order writes nothing.
  const none = await deps.db.$transaction(async (tx) => {
    const client = Object.create(tx as object, { shoppingOrderLink: { value: { findFirst: async () => null } } })
    return deps.scheduleWcOrderCompletion(client, { orderId: `${orderId}-unlinked`, shippedAt })
  })
  assert.equal(none, null)
  assert.equal(await deps.db.integrationOutbox.count({ where: { idempotencyKey: { contains: `${orderId}-unlinked` } } }), 0)
})

test('o3d-zvec.15 (arm 9c): the enqueue rolls back with its transaction', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => cleanup(deps))
  const orderId = `${runId}-rollback`
  const forced = new Error('the flip failed after the enqueue')
  await assert.rejects(
    deps.db.$transaction(async (tx) => {
      const client = Object.create(tx as object, { shoppingOrderLink: { value: { findFirst: async () => ({ id: 'link' }) } } })
      const key = await deps.scheduleWcOrderCompletion(client, { orderId, shippedAt: new Date() })
      assert.ok(key, 'precondition: the row was written inside the transaction')
      throw forced
    }),
    (error: unknown) => error === forced,
  )
  assert.equal(await deps.db.integrationOutbox.count({ where: { idempotencyKey: { contains: orderId } } }), 0, 'nothing survives the rollback')
})

test('o3d-zvec.15 (arm 10): a storefront that never comes back dead-letters at the bound, with zero PUTs', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => cleanup(deps))
  resetWc()
  const { key } = await seedRow(deps, 'dead')
  wc.readFails = true
  assert.equal(deps.WC_ORDER_COMPLETION_MAX_ATTEMPTS, 8, 'the documented bound')

  let now = new Date()
  const delaysMs: number[] = []
  for (let attempt = 1; attempt <= deps.WC_ORDER_COMPLETION_MAX_ATTEMPTS + 2; attempt++) {
    const summary = await deps.processWcOrderCompletionJobs({ idempotencyKeys: [key], now })
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
  assert.equal(row.attempts, deps.WC_ORDER_COMPLETION_MAX_ATTEMPTS, 'gave up at exactly the bound')
  assert.equal(wc.puts, 0)
  assert.equal(wc.gets, deps.WC_ORDER_COMPLETION_MAX_ATTEMPTS)
  assert.equal(delaysMs.length, deps.WC_ORDER_COMPLETION_MAX_ATTEMPTS - 1, 'a retry was scheduled after every attempt but the last')
  // The stated schedule: 5, 10, 20, 40 then capped at 60 minutes (plus up to ~30 s of jitter).
  const minutes = delaysMs.map((ms) => Math.round(ms / 60_000))
  assert.deepEqual(minutes, [5, 10, 20, 40, 60, 60, 60], `back-off schedule in minutes: ${minutes.join(', ')}`)
  assert.equal(activity.filter((a) => a.action === 'wc_completion_dead_lettered' && a.level === 'ERROR').length, 1, 'an ERROR was logged once')
  assert.match(String(row.lastError), /503/)
  // The exception inbox lists exactly PERMANENT_FAILED rows (app/actions/sync-exceptions.ts).
  const listed = await deps.db.integrationOutbox.findMany({ where: { status: 'PERMANENT_FAILED', idempotencyKey: key } })
  assert.equal(listed.length, 1)
})

test('o3d-zvec.15 (arm 12): crash safety — a row committed with the flip is completed by the cron drain though the post-commit attempt never ran', { skip }, async (t) => {
  const deps = await loadDeps()
  t.after(() => cleanup(deps))
  resetWc()
  const { orderId, key } = await seedRow(deps, 'crash') // the flip committed; the process died before any attempt
  assert.equal((await rowOf(deps, key)).status, 'PENDING', 'precondition: nothing has attempted it')

  const drain = await deps.processWcOrderCompletionJobs() // what the cron calls: no keys
  assert.ok(drain.claimed >= 1, 'the drain found it')
  assert.equal(wc.puts >= 1, true)
  assert.ok(wc.events.includes(`status:${orderId}:SHIPPED`))
  assert.equal((await rowOf(deps, key)).status, 'SUCCEEDED')
})
