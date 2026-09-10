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
 *   - every test asserts its PRECONDITION WAS REACHED. A race that did not race passes any
 *     assertion about its outcome, so the winner count, the loser count and the seeded row's
 *     identity are all asserted, and a round in which nobody contended fails;
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
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
/** Enough concurrent claimants that the row is genuinely fought over; the assertion is that it WAS. */
const WORKERS = 8
const STALE_LOCK_MS = 10 * 60 * 1000
/**
 * How long a third connection holds the contested row with SELECT ... FOR UPDATE.
 *
 * This is what makes the compare-and-set race DETERMINISTIC rather than hoped for. Both claimants
 * complete their candidate SELECT unblocked (a plain read is not blocked by FOR UPDATE under READ
 * COMMITTED), so both hold the row's ORIGINAL `lockedAt`; both then park on the row lock at their
 * UPDATE until the holder commits, and only then does one of their WHERE clauses still match.
 *
 * It is also what makes it MEASURABLE: a claimant that returns in less than this never reached the
 * update at all, and a test in which that happened would be asserting about something else.
 */
const HOLD_MS = 400

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
  const [{ db }, outbox, registry, admin, jobs] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/domain/integrations/outbox'),
    import('@/lib/domain/integrations/outbox-registry'),
    import('@/lib/domain/integrations/outbox-admin'),
    import('@/lib/connectors/woocommerce/sync/stock-sync-jobs'),
  ])
  return { db, ...outbox, ...registry, ...admin, ...jobs }
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
      lockedBy: 'worker-that-never-came-back',
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
  '[o3d-8td2 r3] two workers reach the same stale park, and the compare-and-set gives it to exactly one',
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
     * WHY BOTH CLAIMANTS ARE GUARANTEED TO REACH THE CAS, AND NOT MERELY LIKELY.
     *
     * An earlier draft simply fired N claims at once and asserted one winner. It passed — and it
     * proved much less than its comment claimed, because a claimant whose candidate SELECT runs
     * AFTER another has already re-locked the row sees no candidate and returns empty without ever
     * issuing an update. "Nobody else won" is then a statement about read timing, not about the
     * compare-and-set. Removing the CAS entirely from the claim did not turn that draft red.
     *
     * So the row is pinned by a third connection instead. Both claimants read it (unblocked) while
     * it still carries the dead worker's `lockedAt`, both then block on the row lock inside their
     * UPDATE, and the holder releases them together.
     */
    const holderReady = Promise.withResolvers<void>()
    const holderRelease = Promise.withResolvers<void>()
    const holder = deps.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM integration_outbox WHERE id = ${seeded.id} FOR UPDATE`
      holderReady.resolve()
      await holderRelease.promise
    }, { timeout: 20_000, maxWait: 10_000 })
    await holderReady.promise

    async function claimant(workerId: string) {
      const startedAt = Date.now()
      const claimed = await deps.claimIntegrationOutboxWork({
        connector: 'sales',
        operation: 'refund.reservation-release',
        idempotencyKeys: [key],
        limit: 1,
        workerId,
        staleLockMs: STALE_LOCK_MS,
      })
      return { workerId, claimed, elapsedMs: Date.now() - startedAt }
    }

    const race = Promise.all([claimant('racer-alpha'), claimant('racer-beta')])
    // Long enough that both claimants are demonstrably parked on the row lock before it is released.
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    holderRelease.resolve()
    await holder
    const results = await race

    const winners = results.filter((result) => result.claimed.length > 0)
    const losers = results.filter((result) => result.claimed.length === 0)
    assert.equal(winners.length, 1, `exactly one worker may hold a row; ${winners.length} did`)
    assert.equal(winners[0].claimed[0].id, seeded.id, 'the winner must be the seeded row, not some other probe')

    // THE PRECONDITION, MEASURED RATHER THAN ARGUED. Both claimants sat on the row lock for at
    // least the hold, which they could only do from INSIDE their update — so the loser was refused
    // by the compare-and-set, having already read the row as a candidate, and not by missing it.
    for (const result of results) {
      assert.ok(result.elapsedMs >= HOLD_MS,
        `${result.workerId} returned in ${result.elapsedMs}ms without waiting on the row lock, so it `
        + 'never reached the compare-and-set and this test would be asserting about read timing')
    }
    assert.equal(losers.length, 1, 'one claimant must have been refused at the CAS')

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

    // (3) DRAINS. One operator action, and the OBSERVABLE is the row's state afterwards: PENDING,
    // unlocked, due now — and carrying the WC_WEBHOOK payload the fold left, not the MANUAL one the
    // dead worker was holding. That is the finding's actual demand: the later change is not stranded.
    await deps.recoverStalledIntegrationOutboxPark({ id: folded.id })

    const drained = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: folded.id } })
    assert.equal(drained.status, 'PENDING', 'the park must be re-queued, not merely dead-lettered')
    assert.equal(drained.lockedBy, null)
    assert.equal(drained.lockedAt, null)
    assert.equal(drained.attempts, 0, 'the retry ladder restarts')
    assert.ok(drained.nextAttemptAt !== null && drained.nextAttemptAt <= new Date(), 'and it is due immediately')
    assert.deepEqual(
      drained.payloadJson,
      { productId, reason: 'WC_WEBHOOK', force: false, webhookQty: 3 },
      'the drained row carries the LATEST stock change, so the backlog behind the park is settled by it',
    )

    // ...and it has left the operator's list, which is the other half of "drained".
    const stillListed = await deps.db.integrationOutbox.findMany({ where: where as never, select: { id: true } })
    assert.ok(!stillListed.some((row) => row.id === folded.id), 'a drained park must leave the inbox')
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
      () => deps.recoverStalledIntegrationOutboxPark({ id: live.id }),
      (error: unknown) => (error as { code?: string }).code === 'processing_lock_active',
      'draining a live lock must be refused, not merely discouraged',
    )

    const after = await deps.db.integrationOutbox.findUniqueOrThrow({ where: { id: live.id } })
    assert.equal(after.status, 'PROCESSING', 'the refused action must have changed nothing')
    assert.deepEqual(after.lockedAt, live.lockedAt)
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
