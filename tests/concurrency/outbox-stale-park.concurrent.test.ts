import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

// The lease map is a LEAF declaration with no db or env dependency, which is why it can be imported
// statically here while everything else in this file is loaded after `loadEnv()`.
import { INTEGRATION_OUTBOX_DRAIN_LEASES_MS } from '@/lib/domain/integrations/outbox-leases'

/**
 * o3d-8td2 round 3 (Codex HIGH + MEDIUM 2) — THE STALE-LOCK RECLAIM, AND THE PARK IT LEAVES BEHIND,
 * AGAINST A REAL POSTGRES.
 *
 * WHY THIS FILE EXISTS. The unit tests in tests/domain/integrations/outbox.test.ts drive the same
 * declarations through an in-memory client, sequentially, with the remote effects MODELLED — a field
 * assigned, an array pushed. Codex said that twice, and it was right twice: those tests establish
 * that the policy filter admits and refuses the rows it should, and they establish nothing whatever
 * about contention. Nothing in a hand-written double can lose a race, because there is no race.
 *
 * So the contention is tested here instead, where it is real:
 *
 *   - the claim is the SHIPPED SQL, issued concurrently by several workers against one row, and the
 *     assertions are reads of that row afterwards — `lockedBy`, `status`, `payloadJson` — not the
 *     state of a fake;
 *   - every test asserts its PRECONDITION WAS REACHED, and since round 4 the contention test asserts
 *     it from `pg_stat_activity` rather than from a stopwatch: a race that did not race passes any
 *     assertion about its outcome, and an elapsed time cannot tell a claimant that waited inside its
 *     UPDATE from one that was merely slow to start and never issued it (see `awaitBlockedOnHolder`);
 *   - the park is driven with the REAL enqueue path (`enqueueWcStockSyncJobs`), so the fold that
 *     strands later stock changes is the shipped fold and not a description of one.
 *
 * WHAT IS STILL NOT TESTED HERE, said plainly rather than implied by a test name. `pushStockToWc`
 * and `sendAccountingInvoiceEmailInternal` are NOT driven: the first writes to a live WooCommerce
 * store and the second sends mail to a customer, and neither has a seam that stops short of the
 * wire. The ORDERING hazard those two entries are declared `unsafe-to-replay` for — an older
 * absolute quantity arriving last, an invoice email delivered twice — is therefore argued in the
 * registry from the code, and what is PROVEN here is the gate in front of it: that no second worker
 * is ever handed the row, that the refusal comes from the declaration rather than from the clock,
 * and, for the email, that the queue it would land in carries no uniqueness to collide with.
 *
 * ROUND 4 ADDED the row on an operation this build has never heard of, which round 3 had made
 * unreclaimable AND invisible.
 *
 * ROUND 6 REMOVED THE REMEDY AND KEPT THE FINDING. Rounds 3, 4 and 5 each shipped a one-click
 * operator recovery on this list, and each drew a Codex HIGH; the last one is recorded here as a
 * test of its own (`PERMANENT_FAILED is not inert`), driven entirely through shipped paths, because
 * it is the general fact the whole remedy foundered on: no status in this system is inert, so a
 * recovery cannot be made safe by choosing a quieter one to park a row in. What is tested now is the
 * LIST — which rows it shows, which it refuses, and that it is a read. o3d-7qdb carries the rest.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
/** Enough concurrent claimants that the row is genuinely fought over; the assertion is that it WAS. */
const WORKERS = 8
const STALE_LOCK_MS = INTEGRATION_OUTBOX_DRAIN_LEASES_MS.default
/**
 * THE BARRIER, AND WHY IT IS NOT A TIMER (o3d-8td2 round 4, Codex MEDIUM).
 *
 * A third connection pins the contested row with SELECT ... FOR UPDATE. Both claimants complete
 * their candidate SELECT unblocked (a plain read is not blocked by FOR UPDATE under READ COMMITTED),
 * so both hold the row's ORIGINAL `lockedAt`; both then park on the row lock at their UPDATE, and
 * only when the holder commits does exactly one of their WHERE clauses still match.
 *
 * ROUND 3 MEASURED THAT WITH A STOPWATCH, AND THE STOPWATCH STARTED IN THE WRONG PLACE. `elapsedMs`
 * began before the candidate SELECT, so a claimant delayed by scheduling or by pool acquisition could
 * run its SELECT *after* the holder released and the winner re-locked, see no candidate, return empty
 * — and still show an elapsed time over the hold. "Both waited long enough" was therefore consistent
 * with only one of them ever reaching the compare-and-set, and deleting the CAS could still leave the
 * test green under that timing.
 *
 * So the release is gated on what the DATABASE says instead: `pg_blocking_pids` naming the holder as
 * the blocker of exactly two other backends, each of them running an UPDATE on `integration_outbox`.
 * A backend can only be blocked on that row lock from INSIDE its update, so this is direct evidence
 * that both claimants issued theirs and that the loser was refused by the compare-and-set rather than
 * by missing the row. The holder is not released until that evidence exists.
 */
const BARRIER_TIMEOUT_MS = 15_000
const BARRIER_POLL_MS = 20

type BlockedBackend = { pid: number; query: string; wait_event_type: string | null; blockers: number[] }

/**
 * Every backend whose WAIT CHAIN roots at `rootPid`, not merely those it directly blocks.
 *
 * The distinction is load-bearing and it is the first thing the barrier caught. `pg_blocking_pids`
 * for a tuple-lock waiter returns the processes holding conflicting locks AND the processes ahead of
 * it in the wait queue — so the SECOND claimant is reported as blocked by the FIRST claimant, which
 * itself holds nothing. Asking only "who does the holder block?" therefore finds one claimant and
 * misses the other, and a barrier that gave up there would have re-created the very hole it exists
 * to close, one level further down. The closure below follows the chain instead.
 */
async function blockedChainFrom(db: Db, rootPid: number): Promise<BlockedBackend[]> {
  const waiting = await db.$queryRaw<BlockedBackend[]>`
    SELECT pid::int AS pid, query, wait_event_type, pg_blocking_pids(pid)::int[] AS blockers
    FROM pg_stat_activity
    WHERE cardinality(pg_blocking_pids(pid)) > 0
  `
  const reached = new Map<number, BlockedBackend>()
  const roots = new Set<number>([rootPid])
  for (let changed = true; changed;) {
    changed = false
    for (const backend of waiting) {
      if (reached.has(backend.pid)) continue
      if (!backend.blockers.some((blocker) => roots.has(blocker))) continue
      reached.set(backend.pid, backend)
      roots.add(backend.pid)
      changed = true
    }
  }
  return [...reached.values()]
}

/**
 * Waits until Postgres reports `expected` backends waiting behind the holder, and returns them.
 *
 * Throws rather than proceeding: a test whose barrier was never reached is a test about something
 * else, and it must say so instead of asserting on an outcome it did not set up.
 */
async function awaitBlockedOnHolder(db: Db, holderPid: number, expected: number): Promise<BlockedBackend[]> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS
  let seen: BlockedBackend[] = []
  while (Date.now() < deadline) {
    seen = await blockedChainFrom(db, holderPid)
    if (seen.length >= expected) return seen
    await new Promise((resolve) => setTimeout(resolve, BARRIER_POLL_MS))
  }
  throw new Error(
    `only ${seen.length} of ${expected} claimants ever blocked behind the row lock held by backend ${holderPid}; `
    + 'without both inside their UPDATE this test would be asserting about read timing, not about the CAS',
  )
}

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-8td2 r3 concurrency test requires a Postgres DATABASE_URL')
  }
}

const probeKey = (label: string) => `8TD2R3-${label}-${process.pid}-${randomUUID()}`

async function loadDeps() {
  loadEnv()
  const [{ db }, outbox, leases, registry, admin, jobs] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/domain/integrations/outbox'),
    import('@/lib/domain/integrations/outbox-leases'),
    import('@/lib/domain/integrations/outbox-registry'),
    import('@/lib/domain/integrations/outbox-admin'),
    import('@/lib/connectors/woocommerce/sync/stock-sync-jobs'),
  ])
  return { db, ...outbox, ...leases, ...registry, ...admin, ...jobs }
}

type Deps = Awaited<ReturnType<typeof loadDeps>>
type Db = Deps['db']

/**
 * A row already held by a worker whose lock went stale — the exact state a crash leaves behind.
 *
 * `lockedBy` is the DRAIN's constant name, which is the point of the whole finding: it names the
 * duty, never the incumbent, so nothing about this row says whether its holder died or is asleep.
 */
async function seedStalePark(db: Db, input: {
  connector: string
  operation: string
  idempotencyKey: string
  payloadJson: unknown
  lockAgeMs?: number
  lockedBy?: string
}) {
  const lockedAt = new Date(Date.now() - (input.lockAgeMs ?? STALE_LOCK_MS * 3))
  return await db.integrationOutbox.create({
    data: {
      connector: input.connector,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      payloadJson: input.payloadJson as never,
      status: 'PROCESSING',
      attempts: 1,
      nextAttemptAt: null,
      lastError: null,
      lockedAt,
      lockedBy: input.lockedBy ?? 'worker-that-never-came-back',
    },
  })
}

/**
 * WORKERS concurrent claims for one row. Returns who won, and how many came back empty.
 *
 * NOTE what `losers` does and does not mean here: a claim can come back empty because its
 * compare-and-set was refused OR because its candidate read ran after somebody else re-locked the
 * row and saw nothing to claim. This helper cannot tell those apart, so it is used only where the
 * expected answer is that NOBODY wins. The test that needs a real CAS refusal pins the row on a
 * third connection and measures the wait instead.
 */
async function raceForRow(deps: Deps, row: { connector: string; operation: string; idempotencyKey: string }) {
  const results = await Promise.all(
    Array.from({ length: WORKERS }, (_, index) => deps.claimIntegrationOutboxWork({
      connector: row.connector,
      operation: row.operation,
      idempotencyKeys: [row.idempotencyKey],
      limit: 1,
      workerId: `racer-${index}`,
      staleLockMs: STALE_LOCK_MS,
    })),
  )
  const winners = results.flat()
  return { winners, losers: results.filter((claimed) => claimed.length === 0).length }
}

test(
  '[o3d-8td2 r3/r4] two workers demonstrably reach the same stale park, and the CAS gives it to exactly one',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const deps = await loadDeps()
    const key = probeKey('reclaimable')
    const seeded = await seedStalePark(deps.db, {
      connector: 'sales',
      operation: 'refund.reservation-release',
      idempotencyKey: key,
      payloadJson: { orderId: 'probe-order', refundId: 'probe-refund' },
    })
    t.after(() => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: key } }))

    // The declaration is the premise of the whole test; assert it rather than assume it.
    assert.equal(deps.integrationOutboxReplayPolicy('sales', 'refund.reservation-release'), 'local-only-guarded')

    /**
     * THE PRECONDITION IS ESTABLISHED BEFORE THE RACE IS ALLOWED TO RESOLVE, and it is established
     * by asking Postgres. See the comment on `awaitBlockedOnHolder`: round 3 asked a stopwatch that
     * started before the candidate SELECT, and that question has an affirmative answer even when a
     * claimant never issued an update at all.
     */
    const holderPid = Promise.withResolvers<number>()
    const holderRelease = Promise.withResolvers<void>()
    const holder = deps.db.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`
      await tx.$queryRaw`SELECT id FROM integration_outbox WHERE id = ${seeded.id} FOR UPDATE`
      holderPid.resolve(backend.pid)
      await holderRelease.promise
    }, { timeout: 60_000, maxWait: 10_000 })
    const pid = await holderPid.promise

    async function claimant(workerId: string) {
      const claimed = await deps.claimIntegrationOutboxWork({
        connector: 'sales',
        operation: 'refund.reservation-release',
        idempotencyKeys: [key],
        limit: 1,
        workerId,
        staleLockMs: STALE_LOCK_MS,
      })
      return { workerId, claimed }
    }

    const race = Promise.all([claimant('racer-alpha'), claimant('racer-beta')])

    // THE DATABASE'S OWN EVIDENCE. Both claimants are inside their UPDATE, waiting behind the row
    // lock this test's holder is sitting on. Nothing is released until that is true.
    let blocked: BlockedBackend[]
    try {
      blocked = await awaitBlockedOnHolder(deps.db, pid, 2)
    } catch (error) {
      holderRelease.resolve()
      await holder.catch(() => {})
      await race.catch(() => {})
      throw error
    }
    assert.equal(blocked.length, 2, `exactly two backends must be blocked by the holder; ${blocked.length} were`)
    for (const backend of blocked) {
      assert.match(backend.query, /update/i,
        `backend ${backend.pid} is blocked on a ${backend.query} — a SELECT is not blocked by FOR UPDATE, `
        + 'so this would not be a claimant inside its compare-and-set')
      assert.match(backend.query, /integration_outbox/,
        `backend ${backend.pid} is blocked on some other table: ${backend.query}`)
      assert.equal(backend.wait_event_type, 'Lock',
        `backend ${backend.pid} is waiting on ${backend.wait_event_type}, not on a lock`)
    }

    holderRelease.resolve()
    await holder
    const results = await race

    const winners = results.filter((result) => result.claimed.length > 0)
    const losers = results.filter((result) => result.claimed.length === 0)
    assert.equal(winners.length, 1, `exactly one worker may hold a row; ${winners.length} did`)
    assert.equal(winners[0].claimed[0].id, seeded.id, 'the winner must be the seeded row, not some other probe')
    assert.equal(losers.length, 1,
      'one claimant must have been refused at the compare-and-set — it was demonstrably inside its UPDATE above')

    // ASSERTED ON THE DATABASE, not on the return value: the row itself changed hands.
    const after = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: seeded.id } })
    assert.equal(after.status, 'PROCESSING')
    assert.equal(after.lockedBy, winners[0].workerId, 'the row must record the winner as its holder')
    assert.notEqual(after.lockedBy, 'worker-that-never-came-back', 'the dead holder must have been displaced')
    assert.ok(after.lockedAt !== null && after.lockedAt > seeded.lockedAt!, 'the lock must have been re-taken')
  },
)

test(
  '[o3d-8td2 r3] an unsafe-to-replay park is refused by every worker, and the refusal is the declaration',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const deps = await loadDeps()
    const parkKey = probeKey('woo-park')
    const controlKey = probeKey('woo-control')

    // Two rows IDENTICAL in every field the claim reads — same staleness, same attempts, seeded in
    // the same instant — differing only in which operation they name. Anything that separates them
    // is therefore the declaration and nothing else.
    const lockAgeMs = STALE_LOCK_MS * 3
    const park = await seedStalePark(deps.db, {
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKey: parkKey,
      payloadJson: { productId: 'probe-product', reason: 'MANUAL', force: false, webhookQty: null },
      lockAgeMs,
    })
    const control = await seedStalePark(deps.db, {
      connector: 'sales',
      operation: 'refund.reservation-release',
      idempotencyKey: controlKey,
      payloadJson: { orderId: 'probe-order', refundId: 'probe-refund' },
      lockAgeMs,
    })
    t.after(() => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { in: [parkKey, controlKey] } } }))

    // Here the read timing that weakens a bare N-way race does not matter, because the assertion is
    // that NOBODY wins: every one of the eight is refused, whichever order they arrive in, and a
    // single grant at any point in the sequence fails the test.
    const refused = await raceForRow(deps, { connector: 'woocommerce', operation: 'stock.push', idempotencyKey: parkKey })
    assert.equal(refused.winners.length, 0, 'no worker may be handed an unsafe-to-replay row')
    assert.equal(refused.losers, WORKERS, `all ${WORKERS} claims must come back empty; ${refused.losers} did`)

    // The row is UNTOUCHED in the database — still the dead worker's, still on its original lock.
    const parkAfter = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: park.id } })
    assert.equal(parkAfter.status, 'PROCESSING')
    assert.equal(parkAfter.lockedBy, 'worker-that-never-came-back')
    assert.deepEqual(parkAfter.lockedAt, park.lockedAt)

    // NON-VACUITY. The identical row under a declared-safe operation IS granted, in the same run,
    // against the same database, with the same staleness — so "stale enough" was never the question.
    const granted = await raceForRow(deps, {
      connector: 'sales',
      operation: 'refund.reservation-release',
      idempotencyKey: controlKey,
    })
    assert.equal(granted.winners.length, 1, 'the control row must be reclaimable, or this test proves nothing')
    assert.equal(granted.winners[0].id, control.id)
  },
)

test(
  '[o3d-8td2 r3] the park swallows later stock changes, is visible to an operator, and holds the LATEST payload',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const deps = await loadDeps()
    const productId = `8td2r3-product-${process.pid}-${randomUUID()}`
    const key = deps.buildOutboxIdempotencyKey('woocommerce', 'stock.push', productId)
    await seedStalePark(deps.db, {
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKey: key,
      payloadJson: { productId, reason: 'MANUAL', force: false, webhookQty: null },
    })
    t.after(() => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: key } }))

    // (1) THE FOLD, through the SHIPPED enqueue path. A later stock change for the same product does
    // not get a row of its own — it is folded into the parked one, which is why the backlog behind a
    // park is silent: `enqueueWcStockSyncJobs` returns success for work that will never happen.
    await deps.enqueueWcStockSyncJobs([productId], 'WC_WEBHOOK', { webhookQty: 3 })

    const rows = await deps.db.integrationOutbox.findMany({ where: { idempotencyKey: key } })
    assert.equal(rows.length, 1, 'the fold must not create a second row — one idempotency key, one row')
    const folded = rows[0]
    assert.equal(folded.status, 'PROCESSING', 'the enqueue leaves the park exactly where it was')
    assert.equal(folded.lockedBy, 'worker-that-never-came-back', 'and still held by a worker that will not return')
    assert.deepEqual(
      folded.payloadJson,
      { productId, reason: 'WC_WEBHOOK', force: false, webhookQty: 3 },
      'the later change was absorbed into the parked row',
    )

    // (2) VISIBLE. The exception inbox's predicate — derived from the replay declarations, not
    // written beside them — now returns this row. Before this round it returned only
    // PERMANENT_FAILED, so this row appeared on no operator surface at all.
    const where = deps.stalledIntegrationOutboxParkWhere()
    assert.ok(where, 'this build declares unsafe-to-replay operations, so the scope must exist')
    const listed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(listed.some((row) => row.id === folded.id), 'the stalled park must be listed for an operator')

    // (3) AND THE BACKLOG IS WHAT MAKES IT WORTH SHOWING. The folded payload carries the LATEST
    // quantity, so an operator who checks WooCommerce and then acts deliberately settles the whole
    // backlog in one push. Round 6 withdrew the one-click action that used to sit here; the reason
    // is o3d-7qdb, and the demonstration is the `[r6] PERMANENT_FAILED is not inert` test below.
    assert.deepEqual(
      folded.payloadJson,
      { productId, reason: 'WC_WEBHOOK', force: false, webhookQty: 3 },
      'the park must hold the changes that piled up behind it, not discard them',
    )

    // (4) NON-VACUITY of (2): the listing is answering about THIS row's lock, not saying yes to
    // every PROCESSING row. Put the lock back inside every lease and the row leaves the list.
    await deps.db.integrationOutbox.update({
      where: { id: folded.id },
      data: { lockedAt: new Date(Date.now() - 60 * 1000) },
    })
    const stillListed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(!stillListed.some((row) => row.id === folded.id),
      'a row inside its lease is a job, not an exception')
  },
)

test(
  '[o3d-8td2 r3/r6] a park whose worker is still alive is not listed, and one past every lease is',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const deps = await loadDeps()
    const key = probeKey('live-worker')
    // Locked one minute ago: PROCESSING on an unsafe-to-replay operation, but NOT stale. This is a
    // job, not an exception, and the whole safety of the affordance is that it is left alone.
    const live = await seedStalePark(deps.db, {
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKey: key,
      payloadJson: { productId: 'probe-product', reason: 'MANUAL', force: false, webhookQty: null },
      lockAgeMs: 60 * 1000,
    })
    t.after(() => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: key } }))

    const where = deps.stalledIntegrationOutboxParkWhere()
    assert.ok(where)
    const listed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(!listed.some((row) => row.id === live.id), 'a live job must not be presented as an exception')

    // NON-VACUITY: the same row, once past every lease, IS listed — so the assertion above turned on
    // the lock's age and not on some other clause quietly excluding it.
    await deps.db.integrationOutbox.update({
      where: { id: live.id },
      data: { lockedAt: new Date(Date.now() - deps.ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS - 60_000) },
    })
    const nowListed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(nowListed.some((row) => row.id === live.id), 'the listing must be able to see this row at all')
    await deps.db.integrationOutbox.update({ where: { id: live.id }, data: { lockedAt: live.lockedAt } })

    // AND THE ROW ROUND 3 WOULD HAVE LISTED (round 4, Codex HIGH 1). Twelve minutes is past round
    // 3's restated ten-minute threshold and INSIDE the fifteen-minute lease `xero/accounting.post`
    // is actually drained under — a job that is not stalled at all, shown as one.
    const midLeaseKey = probeKey('xero-mid-lease')
    const midLease = await seedStalePark(deps.db, {
      connector: 'xero',
      operation: 'accounting.post',
      idempotencyKey: midLeaseKey,
      payloadJson: { accountingSyncLogId: 'probe-log' },
      lockAgeMs: 12 * 60 * 1000,
      lockedBy: 'xero-accounting-sync',
    })
    t.after(() => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: midLeaseKey } }))

    assert.ok(12 * 60 * 1000 > 10 * 60 * 1000, 'the premise: round 3 would have called this stale')
    assert.ok(12 * 60 * 1000 < deps.INTEGRATION_OUTBOX_DRAIN_LEASES_MS.xeroAccountingEntry,
      'and the premise on the other side: the Xero worker holding it is still inside its lease')

    const midLeaseListed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(!midLeaseListed.some((row) => row.id === midLease.id),
      'a Xero row inside its own lease must not be presented as a stalled park')
  },
)

test(
  '[o3d-8td2 r6] PERMANENT_FAILED is not inert: the ordinary enqueue path puts a dead-lettered row back in front of a worker',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const deps = await loadDeps()
    const productId = `8td2r6-not-inert-${process.pid}-${randomUUID()}`
    const key = deps.buildOutboxIdempotencyKey('woocommerce', 'stock.push', productId)

    /**
     * THE FINDING THAT WITHDREW THE OPERATOR ACTION (Codex round 5 HIGH; o3d-7qdb).
     *
     * Round 4 defended a one-click dead-letter on the ground that it "produces no effect at all" —
     * that it moves a row from a status nothing acts on to a status nothing acts on. That is false,
     * and this test is the demonstration, driven entirely through SHIPPED paths: the pre-existing
     * admin exit to reach PERMANENT_FAILED, and `enqueueWcStockSyncJobs` — the same function every
     * stock change in the application calls — to bring it back.
     *
     * Nothing here tests withdrawn code. It tests the reason the code was withdrawn, so that a
     * future attempt to park a row in a "quiet" status fails here first.
     */
    const park = await seedStalePark(deps.db, {
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKey: key,
      payloadJson: { productId, reason: 'MANUAL', force: false, webhookQty: null },
      lockAgeMs: deps.ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS + 60_000,
      lockedBy: 'wc-stock-sync',
    })
    t.after(() => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: key } }))

    // (1) THE PREMISE: this row is on the operator surface, which is the whole population any
    // recovery would have acted on.
    const where = deps.stalledIntegrationOutboxParkWhere()
    const listed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(listed.some((row) => row.id === park.id), 'the premise: this row is listed')

    // (2) IT REACHES PERMANENT_FAILED — by the pre-existing exit, which is the only exit there is.
    await deps.permanentlyFailIntegrationOutboxAdminRow({ id: park.id })
    const stopped = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: park.id } })
    assert.equal(stopped.status, 'PERMANENT_FAILED')
    assert.equal(stopped.lockedAt, null)
    assert.equal(stopped.lockedBy, null)

    // (3) AND IT IS NOT INERT. One ordinary stock change on that product — a manual edit, a receipt,
    // a sales order, anything at all — and the connector's own enqueue path resets it.
    await deps.enqueueWcStockSyncJobs([productId], 'MANUAL')
    const revived = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: park.id } })
    assert.equal(revived.status, 'PENDING',
      'the WooCommerce enqueue path updates on `status: { not: PROCESSING }`, so PERMANENT_FAILED is matched and reset')
    assert.notEqual(revived.status, 'PERMANENT_FAILED')
    assert.equal(revived.attempts, 0, 'and the retry ladder is cleared too, so nothing bounds the re-run')

    // (4) WHICH MEANS A WORKER TAKES IT. Not through the stale-reclaim arm the declaration closes —
    // through the drain's ORDINARY first arm, because the row is simply PENDING again. This is the
    // replay `unsafe-to-replay` exists to prevent, reached with no operator decision and no remote
    // verification anywhere in the chain.
    const afterRevival = await raceForRow(deps, { connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key })
    assert.equal(afterRevival.winners.length, 1,
      'a dead-lettered park is handed straight back to a worker by the next ordinary stock change')

    // (5) NON-VACUITY of (3): the revival is the enqueue path's doing and not the passage of time.
    // A row left PERMANENT_FAILED with nothing enqueued against it stays put and stays unclaimable.
    const controlProductId = `8td2r6-control-${process.pid}-${randomUUID()}`
    const controlKey = deps.buildOutboxIdempotencyKey('woocommerce', 'stock.push', controlProductId)
    const control = await seedStalePark(deps.db, {
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKey: controlKey,
      payloadJson: { productId: controlProductId, reason: 'MANUAL', force: false, webhookQty: null },
      lockAgeMs: deps.ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS + 60_000,
      lockedBy: 'wc-stock-sync',
    })
    t.after(() => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: controlKey } }))
    await deps.permanentlyFailIntegrationOutboxAdminRow({ id: control.id })
    const controlRace = await raceForRow(deps, {
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKey: controlKey,
    })
    assert.equal(controlRace.winners.length, 0, 'a PERMANENT_FAILED row nobody re-enqueued is not claimable')
    assert.equal(
      (await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: control.id } })).status,
      'PERMANENT_FAILED',
    )
  },
)

test(
  '[o3d-8td2 r4/r6] an UNREGISTERED operation crashes into a park that nothing reclaims and the list shows',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const deps = await loadDeps()
    const key = probeKey('unregistered')
    const connector = 'legacy-connector'
    const operation = 'legacy.unregistered'
    t.after(() => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: key } }))

    // THE PREMISE: this build has never heard of the operation. That is not hypothetical —
    // `parseIntegrationOutboxPayload` documents the passthrough and `enqueueIntegrationOutbox` uses it.
    assert.equal(deps.integrationOutboxReplayPolicy(connector, operation), null)
    assert.equal(deps.isRegisteredOutboxOperation(connector, operation), false)

    // (1) THE SUPPORTED ENQUEUE PATH TAKES IT.
    const enqueued = await deps.enqueueIntegrationOutbox({
      connector,
      operation,
      idempotencyKey: key,
      payloadJson: { anything: 'this build cannot parse' },
    })
    assert.equal(enqueued.status, 'PENDING')

    // (2) A WORKER CLAIMS IT — the claim path supports unknown operations too, which is how the row
    // reaches PROCESSING at all — and then the process dies. The crash is modelled by backdating the
    // lock the claim really took: the holder is gone and time has passed. Nothing else is touched.
    const [claimed] = await deps.claimIntegrationOutboxWork({
      connector,
      operation,
      idempotencyKeys: [key],
      limit: 1,
      workerId: 'a-worker-that-crashed',
    })
    assert.ok(claimed, 'an unregistered operation must be claimable, or this scenario cannot arise')
    assert.equal(claimed.status, 'PROCESSING')
    await deps.db.integrationOutbox.update({
      where: { id: claimed.id },
      data: { lockedAt: new Date(Date.now() - deps.ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS - 60_000) },
    })

    // (3) NO WORKER WILL EVER TAKE IT BACK: the stale-reclaim scope fails an unknown operation
    // closed, deliberately, because "we have never heard of it" is not a reason to believe a second
    // execution is harmless.
    assert.equal(deps.integrationOutboxStaleReclaimScope(connector, operation), null)
    const refused = await raceForRow(deps, { connector, operation, idempotencyKey: key })
    assert.equal(refused.winners.length, 0, 'no worker may be handed a row whose effects this build cannot name')
    assert.equal(refused.losers, WORKERS)

    // (4) SO AN OPERATOR MUST BE SHOWN IT. Round 3's scope was exhaustive over the REGISTRY, and
    // `policy !== null` dropped exactly this row out of both sets: unreclaimable and invisible.
    const where = deps.stalledIntegrationOutboxParkWhere()
    const listed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(listed.some((row) => row.id === claimed.id),
      'a crashed unregistered row must be on the operator surface — it is on no automatic path at all')

    // (5) ...AND NOTHING MORE THAN SHOWN (round 6). The pre-existing admin exit reaches it — round
    // 3's guard would have refused it as `not_a_stalled_park`, for a row nothing else was going to
    // touch either — but that exit is an admin API call an operator makes deliberately, not a button
    // beside the row. NON-VACUITY: the row leaves the list only because something acted on it.
    await deps.permanentlyFailIntegrationOutboxAdminRow({ id: claimed.id })
    const after = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: claimed.id } })
    assert.equal(after.status, 'PERMANENT_FAILED')

    const stillListed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(!stillListed.some((row) => row.id === claimed.id))
  },
)

test(
  '[o3d-8td2 r3] the invoice-email queue carries no uniqueness a replayed send could collide with',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    const { db } = await loadDeps()

    /**
     * The `xero/accounting.post` entry rests on a claim about a table, not about a code path:
     * INVOICE_EMAIL's fence writes no dispatch record, and the effect behind it lands in
     * `EmailOutbox`, which "has no idempotency key and no unique constraint of any kind" — so a
     * second worker's insert cannot collide with the first worker's and both are delivered.
     *
     * Asked of the real catalogue rather than of the schema file, and asserted as a READ: this test
     * sends no mail and writes no row, which is the only honest way to check it. If somebody adds
     * the uniqueness the entry says is missing, this fails and the entry is due a re-read.
     */
    const uniques = await db.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT i.relname AS indexname, pg_get_indexdef(i.oid) AS indexdef
      FROM pg_class t
      JOIN pg_index ix ON ix.indrelid = t.oid
      JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE t.relname = 'email_outbox' AND ix.indisunique
    `
    // The walk really reached the table: a mistyped name would return an empty set and pass silently.
    const columns = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'email_outbox'
    `
    assert.ok(columns.length > 0, 'email_outbox must exist, or this test is asking about nothing')
    const names = columns.map((column) => column.column_name)
    assert.ok(names.includes('status'), `email_outbox should carry a status column; got ${names.join(', ')}`)

    const nonPrimary = uniques.filter((index) => !index.indexname.endsWith('_pkey'))
    assert.deepEqual(
      nonPrimary.map((index) => index.indexname),
      [],
      'EmailOutbox has no uniqueness beyond its surrogate id — a duplicated invoice email cannot be '
      + 'refused by the database, which is why xero/accounting.post is unsafe-to-replay',
    )

    // The other half of the same claim: no holder identity, so its own terminal writes are unfenced.
    assert.ok(!names.includes('lockedBy') && !names.includes('locked_by'),
      'EmailOutbox tracks processingStartedAt (a timestamp) and no holder, per o3d-alnk')
  },
)
