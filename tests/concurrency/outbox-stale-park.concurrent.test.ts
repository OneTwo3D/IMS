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
 * and, for the email, that the uniqueness the queue DOES now carry (o3d-alnk's partial index on the
 * undelivered statuses) stops at delivery, so a replay that arrives after the first copy was sent
 * is still accepted — which is what keeps `xero/accounting.post` unsafe-to-replay.
 *
 * ROUND 4 ADDED the row on an operation this build has never heard of, which round 3 had made
 * unreclaimable AND invisible.
 *
 * ROUND 8 WITHDREW THE OPERATOR SURFACE ENTIRELY AND KEPT THE FINDINGS. Rounds 3-5 each shipped a
 * one-click recovery on a derived list of these parks and each drew a Codex HIGH; round 6 removed
 * the button, round 7 removed the copy pointing at the same act by hand, and round 7's review then
 * found the GUARDS around what was left incomplete in their own turn. Five HIGHs in four rounds, so
 * the list, its guidance and its guards are gone (o3d-7qdb).
 *
 * What is still tested here is the part that does not depend on any surface: that no second worker
 * is handed the row, that the refusal comes from the declaration rather than from the clock, that a
 * park really does swallow later stock changes, and — as a test of its own, driven entirely through
 * shipped paths — that `PERMANENT_FAILED is not inert`. That last one is the general fact the whole
 * remedy foundered on, and it is exactly what a future attempt must fail against first: no status in
 * this system is inert, so a recovery cannot be made safe by choosing a quieter one to park a row in.
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
  '[o3d-8td2 r3/r8] the park swallows later stock changes and holds the LATEST payload, seen by nobody',
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

    // (2) AND NOBODY IS TOLD (o3d-8td2 r8). Rounds 3-7 followed this assertion with a listing check:
    // the exception inbox's derived predicate returned this row, closing round 2's "the park is
    // invisible" HIGH. That whole surface was withdrawn — the listing, its guidance and the guards
    // around them (o3d-7qdb) — so the row this test just built is once again on no operator surface
    // anybody watches, and every later stock change for the product waits behind it. Nothing here
    // can assert that absence usefully; it is recorded so the gap is not mistaken for coverage.
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

    // (1) THE PREMISE: a stalled park, its lock past every declared lease — the exact population any
    // recovery would have acted on. Rounds 3-7 asserted it was LISTED here; round 8 withdrew the
    // listing (o3d-7qdb), and the row's shape is the premise that actually matters.
    assert.equal(park.status, 'PROCESSING')
    assert.ok(park.lockedAt && park.lockedAt.getTime() < Date.now() - deps.ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS)

    // (2) IT REACHES PERMANENT_FAILED — by the pre-existing admin mutation, which is not an exit at
    // all, as (3) and (4) go on to show.
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
  '[o3d-8td2 r4/r8] an UNREGISTERED operation crashes into a park that nothing reclaims and nothing shows',
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

    // (4) AND NOTHING SHOWS IT EITHER (o3d-8td2 r8). Rounds 4-7 ended here by asserting the derived
    // exception-inbox listing returned this row — the case that surface existed for, since round 3
    // had made an unregistered park both unreclaimable AND invisible. The surface was withdrawn in
    // round 8 (o3d-7qdb), so an unregistered park is once again unreclaimable and invisible. What
    // this branch fixes is (3): it is refused by the DECLARATION's fail-closed rule, not by luck.
  },
)

test(
  "[o3d-8td2 r3 / o3d-alnk] the invoice-email queue's uniqueness stops at delivery, which is not where the hazard is",
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db } = await loadDeps()

    /**
     * WHAT THIS TEST USED TO SAY, AND WHY IT HAD TO CHANGE (o3d-alnk).
     *
     * Round 3 asserted that `email_outbox` carried NO uniqueness at all, and the `xero/accounting.post`
     * entry leaned on exactly that: "`EmailOutbox` has no idempotency key and no unique constraint of
     * any kind", so worker B's insert cannot collide with worker A's and both are delivered. It closed
     * with a standing instruction — "if somebody adds the uniqueness the entry says is missing, this
     * fails and the entry is due a re-read".
     *
     * Somebody did. o3d-alnk's `email_outbox_undelivered_reference_uq` is a PARTIAL unique index on
     * (kind, referenceType, referenceId) WHERE status IN ('PENDING','PROCESSING'), and this is the
     * re-read it asked for. THE VERDICT IS UNCHANGED, and it is important to be exact about why,
     * because the old reason is now false and a false reason is not a reason:
     *
     *   THE INDEX REFUSES A DUPLICATE UNDELIVERED *ROW*. IT CANNOT REFUSE A DUPLICATE *SEND*.
     *
     * Those come apart at the only moment that matters — AND NOT AS OFTEN AS THIS USED TO SAY
     * (Codex round 19, MEDIUM). This paragraph used to have the drain emptying the queue well inside
     * the reclaim window, and worker A's copy therefore delivered by the time worker B replays. The
     * cadences are the other way round, and they are in the repo: the reclaim window
     * is ADMIN_OUTBOX_STALE_PROCESSING_LOCK_MS = INTEGRATION_OUTBOX_MAX_LEASE_MS = 900_000 ms,
     * FIFTEEN MINUTES (`xeroAccountingEntry` in lib/domain/integrations/outbox-leases.ts), and the
     * email drain is documented HOURLY (help-docs/settings.md, the `/api/cron/email-outbox` cron-table
     * row). Fifteen minutes is INSIDE the hour, so B's replay usually meets a copy that is still
     * PENDING and the index REFUSES it. What the index leaves open is the timing that
     * CROSSES A DRAIN: once a drain settles A's copy to SENT, a SENT row is outside the predicate, B's
     * insert is accepted, and the customer is emailed a second time. That gap is what this test
     * drives below, and it is what decides the verdict; the RATE was the only thing wrong.
     *
     * AND NO CONSTRAINT IN THE CURRENT SCHEMA CLOSES THE REMAINDER — a fact about this schema, not
     * about constraints (Codex round 16, MEDIUM). This paragraph used to say that no constraint on
     * this table COULD have closed it, because a send is not a database write and refusing a second
     * ROW does not unsend a mail already on the wire. That is true of the index we HAVE, whose
     * predicate ends at delivery; it is false as a general claim. A LIFETIME uniqueness key on
     * (kind, referenceType, referenceId), or an upstream-effect idempotency key written at the
     * enqueue, would refuse worker B's ENQUEUE — and an enqueue refused before it happens needs
     * nothing unsent. Neither is taken here: the invoice-email fence passes no `createDispatchWrite`,
     * the gap o3d-8td2's audit recorded and o3d-scyw now carries. What this test establishes is
     * therefore the schema as it stands, and nothing about what a schema could do.
     * POST_EFFECT.INVOICE_EMAIL is still right about the OTHER half — a mail already handed to the
     * transport cannot be recalled, whatever is written afterwards.
     *
     * ASSERTED AS A READ PLUS ONE ROLLED-BACK WRITE. The old test would not write here at all, for a
     * good reason: a committed PENDING row in this table is a mail the drain will send. That reason is
     * respected. The rows this test commits are SENT, which `processPendingEmailOutbox`'s findMany
     * never selects (it takes PENDING, or PROCESSING gone stale), and the one PENDING insert — the
     * insert that carries the whole finding — happens inside a transaction that is always rolled back.
     * No mail can leave, and the gap is PROVEN rather than described from the index definition.
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

    // (1) THE UNIQUENESS THAT NOW EXISTS IS THE UNDELIVERED-REFERENCE INDEX, AND NOTHING ELSE. If a
    // later branch adds a unique key this argument has not been told about — one covering SENT, or an
    // idempotency key — this fails, and the entry is due the same re-read round 3 asked for.
    const nonPrimary = uniques.filter((index) => !index.indexname.endsWith('_pkey'))
    assert.deepEqual(
      nonPrimary.map((index) => index.indexname),
      ['email_outbox_undelivered_reference_uq'],
      'the only uniqueness on email_outbox should be o3d-alnk\'s partial undelivered-reference index',
    )

    // (2) AND IT IS PARTIAL, SCOPED TO THE UNDELIVERED STATUSES. This is the claim the verdict rests
    // on, so it is read off the catalogue rather than trusted from the migration file.
    const [undeliveredIndex] = nonPrimary
    assert.match(undeliveredIndex.indexdef, /WHERE .*status = ANY \(ARRAY\['PENDING'.*'PROCESSING'/,
      `the index must be scoped to the undelivered statuses; got ${undeliveredIndex.indexdef}`)

    /**
     * (3) THE GAP ITSELF, DRIVEN. A delivered first copy, then the replay's insert — and the database
     * accepts it. Asserting (2) alone would prove an ADJACENT property: that the index definition
     * SAYS it is partial. What decides the verdict is what the table DOES with a second row once the
     * first is SENT, and that is only knowable by trying it.
     */
    const reference = `o3d-8td2-replay-gap-${randomUUID()}`
    t.after(() => db.emailOutbox.deleteMany({ where: { referenceId: reference } }))

    const delivered = await db.emailOutbox.create({
      data: {
        kind: 'ACCOUNTING_INVOICE',
        toEmail: 'nobody@example.invalid',
        subject: 'the first copy, already delivered',
        html: 'queued',
        referenceType: 'SalesOrder',
        referenceId: reference,
        status: 'SENT',
        sentAt: new Date(),
      },
    })
    // THE PRECONDITION WAS REACHED: the first copy really is outside the index's predicate. Without
    // this, a row that failed to reach SENT would make the insert below succeed for the wrong reason.
    assert.equal(delivered.status, 'SENT', 'the first copy must be DELIVERED, or this proves nothing')

    let secondRowWasAccepted = false
    const ROLLBACK = new Error('o3d-alnk: deliberate rollback — this PENDING row must never commit')
    await assert.rejects(
      db.$transaction(async (tx) => {
        // The replay's enqueue, verbatim in shape: same kind, same reference, PENDING because that is
        // what a fresh enqueue is. If the index covered SENT this would raise P2002 instead.
        await tx.emailOutbox.create({
          data: {
            kind: 'ACCOUNTING_INVOICE',
            toEmail: 'nobody@example.invalid',
            subject: 'the replay, which the customer would receive as a second invoice',
            html: 'queued',
            referenceType: 'SalesOrder',
            referenceId: reference,
            status: 'PENDING',
          },
        })
        secondRowWasAccepted = true
        throw ROLLBACK
      }),
      (error: unknown) => error === ROLLBACK,
      'the transaction must fail with OUR rollback: any other error means the insert was refused, '
      + 'and the whole finding would be the opposite of what is recorded',
    )
    assert.equal(secondRowWasAccepted, true,
      'a replay after delivery must be ACCEPTED by email_outbox — this is why xero/accounting.post '
      + 'is unsafe-to-replay: the index refuses a duplicate undelivered row, never a duplicate send')

    // AND NOTHING COMMITTED. The rollback is the safety property this test rests on, so it is checked
    // rather than assumed: one row for this reference, the delivered one, and nothing for the drain.
    const survivors = await db.emailOutbox.findMany({ where: { referenceId: reference } })
    assert.deepEqual(survivors.map((row) => row.status), ['SENT'],
      'the rolled-back PENDING row must not have committed — a committed one is a mail that would be sent')

    // (4) THE OTHER HALF OF THE OLD CLAIM IS ALSO GONE, AND IT DOES NOT CHANGE THE VERDICT EITHER.
    // The entry used to add that EmailOutbox "has no holder identity — processingStartedAt is a
    // timestamp, not a lockedBy — and every terminal write is an unfenced update({ where: { id } })".
    // o3d-alnk gave it both: a per-claim `lockedBy` token and terminal writes that compare-and-set on
    // it. That closes the queue's OWN re-arming race. It says nothing about a second row arriving
    // after the first was delivered, which is the hazard above, and which no fence inside this queue
    // can see — the two workers racing there are in the INTEGRATION outbox, one reclaim apart.
    assert.ok(names.includes('lockedBy'),
      `email_outbox must carry the o3d-alnk holder identity; got ${names.join(', ')}`)
  },
)
