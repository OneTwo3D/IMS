import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

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
 * ROUND 4 ADDS THE TWO SCENARIOS THE REMEDY ITSELF CREATED: an operator acting on a park whose
 * holder is ALIVE-BUT-PAUSED (the recovery must not put the effect back in front of a worker), and a
 * row on an operation this build has never heard of (which round 3 made unreclaimable AND invisible).
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
/** Enough concurrent claimants that the row is genuinely fought over; the assertion is that it WAS. */
const WORKERS = 8
const STALE_LOCK_MS = 10 * 60 * 1000
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
  '[o3d-8td2 r3] the park swallows later stock changes, is visible to an operator, and drains with the LATEST payload',
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

    // (3) THE OPERATOR ACTION STOPS IT, AND DOES NOT RE-RUN IT (round 4, Codex HIGH 1). Round 3
    // dead-lettered and immediately re-queued, which is the reclaim `unsafe-to-replay` exists to
    // forbid, performed by hand on the same evidence a worker is not allowed to act on.
    await deps.deadLetterStalledIntegrationOutboxPark({ id: folded.id })

    const stopped = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: folded.id } })
    assert.equal(stopped.status, 'PERMANENT_FAILED', 'the action must stop the row')
    assert.notEqual(stopped.status, 'PENDING', 'and must never put it back in front of a worker')
    assert.equal(stopped.lockedBy, null)
    assert.equal(stopped.lockedAt, null)
    assert.equal(stopped.nextAttemptAt, null, 'nothing is scheduled: the re-queue is a separate act')
    assert.match(stopped.lastError ?? '', /NOTHING HAS BEEN RE-RUN/,
      'the row must carry, in itself, the reason it was stopped and what could not be verified')

    // THE FOLDED PAYLOAD SURVIVES, which is what makes the separate re-queue worth taking: when an
    // operator does replay it, the push carries the LATEST quantity and settles the whole backlog.
    assert.deepEqual(
      stopped.payloadJson,
      { productId, reason: 'WC_WEBHOOK', force: false, webhookQty: 3 },
      'dead-lettering must not discard the changes that piled up behind the park',
    )

    // ...and it has left the stalled-park list for the failed-rows list, which is the other half of
    // "stopped": one operator surface hands it to the other.
    const stillListed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(!stillListed.some((row) => row.id === folded.id), 'a stopped park must leave the park inbox')
  },
)

test(
  '[o3d-8td2 r3] a park whose worker is still alive is neither listed nor drainable',
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

    // And the action refuses it even if a stale page offers the button — re-read and re-checked
    // against the same rule, so the affordance cannot cut under a worker that is still running.
    await assert.rejects(
      () => deps.deadLetterStalledIntegrationOutboxPark({ id: live.id }),
      (error: unknown) => (error as { code?: string }).code === 'processing_lock_active',
      'draining a live lock must be refused, not merely discouraged',
    )

    const after = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: live.id } })
    assert.equal(after.status, 'PROCESSING', 'the refused action must have changed nothing')
    assert.deepEqual(after.lockedAt, live.lockedAt)

    // AND THE ROW ROUND 3 WOULD HAVE OFFERED (round 4, Codex HIGH 1). Twelve minutes is past round
    // 3's restated ten-minute threshold and INSIDE the fifteen-minute lease `xero/accounting.post`
    // is actually drained under — a job that is not stalled at all, listed as one, with a button.
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
    await assert.rejects(
      () => deps.deadLetterStalledIntegrationOutboxPark({ id: midLease.id }),
      (error: unknown) => (error as { code?: string }).code === 'processing_lock_active',
    )
  },
)

test(
  '[o3d-8td2 r4] an operator stopping a park whose worker is ALIVE-BUT-PAUSED cannot make the effect run again',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const deps = await loadDeps()
    const productId = `8td2r4-paused-${process.pid}-${randomUUID()}`
    const key = deps.buildOutboxIdempotencyKey('woocommerce', 'stock.push', productId)
    const pausedWorker = 'wc-stock-sync'

    /**
     * THE SCENARIO THE VERDICT IS ABOUT. The holder is NOT dead. It is paused mid-`pushStockToWc`
     * — SIGSTOP, a frozen VM, a host paused in a syscall — and it will resume and finish. The only
     * evidence anyone has to the contrary is the clock, which is exactly the evidence
     * `unsafe-to-replay` says is insufficient. Nothing in this row distinguishes the two cases, and
     * that indistinguishability is the point: the test is that the action is SAFE ANYWAY.
     */
    const park = await seedStalePark(deps.db, {
      connector: 'woocommerce',
      operation: 'stock.push',
      idempotencyKey: key,
      payloadJson: { productId, reason: 'MANUAL', force: false, webhookQty: null },
      lockAgeMs: deps.ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS + 60_000,
      lockedBy: pausedWorker,
    })
    t.after(() => deps.db.integrationOutbox.deleteMany({ where: { idempotencyKey: key } }))

    // (1) THE OPERATOR ACTS, on a row the list really does show them.
    const where = deps.stalledIntegrationOutboxParkWhere()
    const listed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(listed.some((row) => row.id === park.id), 'the premise: this row is on the operator surface')
    await deps.deadLetterStalledIntegrationOutboxPark({ id: park.id })

    const stopped = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: park.id } })
    assert.equal(stopped.status, 'PERMANENT_FAILED')
    assert.notEqual(stopped.status, 'PENDING', 'the operator action must not re-queue an unsafe-to-replay row')

    // (2) THE PAUSED WORKER WAKES UP and still cannot write the row: every completion helper fences
    // on the exact (lockedBy, lockedAt) it was granted, and the dead-letter cleared both.
    await assert.rejects(
      () => deps.markIntegrationOutboxSuccess({ id: park.id, workerId: pausedWorker, lockedAt: park.lockedAt! }),
      'a resuming holder must not be able to complete a row it no longer holds',
    )

    // (3) THE ACTUAL DEMAND OF THE FINDING, asserted as the database's answer to every worker in the
    // fleet: after the operator's action, NOBODY is handed this row, so the effect the paused worker
    // may already have produced cannot be produced a second time BY THE RECOVERY. Round 3 left the
    // row PENDING here, and a PENDING stock.push is claimable by the drain's FIRST arm — nothing to
    // do with the stale-reclaim arm the declaration closes — so one of these eight would have won.
    const afterStop = await raceForRow(deps, { connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key })
    assert.equal(afterStop.winners.length, 0,
      'the operator recovery must not put an unsafe-to-replay effect back in front of a worker')
    assert.equal(afterStop.losers, WORKERS)

    // (4) NON-VACUITY, and the shape of the remedy. The re-queue still EXISTS; it is a separate,
    // deliberate act on a different surface, taken on a row that now carries a written statement of
    // what nobody could verify. Once taken, the same eight claims do take the row — so step (3)
    // measured the action, not a row that had become permanently unclaimable.
    assert.match(stopped.lastError ?? '', /Re-queueing this row runs the operation again/)
    await deps.replayIntegrationOutboxAdminRow({ id: park.id })
    const afterReplay = await raceForRow(deps, { connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key })
    assert.equal(afterReplay.winners.length, 1,
      'the deliberate second act must still be able to re-run the operation, or the park has no exit')
  },
)

test(
  '[o3d-8td2 r4] an UNREGISTERED operation crashes into a park that is both listed and stoppable',
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

    // (5) ...AND THE ACTION MUST REACH IT. Round 3's guard used the same `policy !== null` test, so
    // this call was refused as `not_a_stalled_park` for a row nothing else was going to touch either.
    const result = await deps.deadLetterStalledIntegrationOutboxPark({ id: claimed.id })
    assert.equal(result.row.status, 'PERMANENT_FAILED')
    const after = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: claimed.id } })
    assert.equal(after.status, 'PERMANENT_FAILED')
    assert.match(after.lastError ?? '', /legacy-connector\/legacy\.unregistered/)

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
