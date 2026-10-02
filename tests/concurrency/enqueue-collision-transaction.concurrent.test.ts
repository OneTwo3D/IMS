import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { backendPid, waitUntilParkedBehind, type ParkedBackend } from '@/tests/helpers/lock-wait-observer'

/**
 * o3d-d0pd r2 (Codex MEDIUM) — A COLLIDING ENQUEUE LEAVES THE CALLER'S TRANSACTION USABLE.
 *
 * `queueAccountingSyncTx` writes inside the CALLER's interactive transaction. Its catch recognises a
 * unique violation on `accounting_sync_logs_idempotency_key_uq` and answers `queued: true` — "another
 * writer got there a millisecond ago, the counterpart exists". That answer was dead code until this
 * round fixed the detection (o3d-5od: the index name never appears in `String(error)` under
 * `@prisma/adapter-pg`), which made the path REACHABLE for the first time — and reaching it was worse
 * than throwing. PostgreSQL aborts the whole transaction on a 23505, Prisma wraps no savepoint around
 * individual statements, so the caller's next statement and its COMMIT both failed with 25P02. The
 * callers that write COGS or transit subledger rows straight afterwards are precisely the ones that
 * would have hit it.
 *
 * WHAT THIS TEST ASSERTS, AND WHY IT COMMITS. A test that stopped at the enqueue's return would prove
 * nothing: the return value was ALREADY correct before the fix. The damage is entirely downstream of
 * it. So every racer here does a SUBSEQUENT WRITE after the enqueue and then COMMITS, and the
 * assertion is that the write is durable — read back on a fresh connection.
 *
 * AND IT PROVES THE COLLISION WAS ACTUALLY REACHED. A race that never raced would pass every
 * assertion below. The surviving sync row carries a marker saying WHICH writer created it: if the
 * INTERLOPER's row survived, the enqueue's own INSERT is the one that raised the 23505 and the
 * recovery path really ran. Rounds where the enqueue won are not collisions and are counted
 * separately; the test fails if no round ever collided.
 *
 * A REAL DATABASE IS THE ONLY WITNESS. The aborted-transaction state is a PostgreSQL property; a
 * hand-written double will happily keep serving queries after a thrown insert, so it cannot fail this
 * test in the way that matters.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
/** Enough attempts that the read-then-insert window is hit; the assertion is that it WAS. */
const ROUNDS = 25
const TX = { timeout: 20_000, maxWait: 10_000 }

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-d0pd r2 concurrency test requires a Postgres DATABASE_URL')
  }
}

const probeId = (label: string) => `D0PD2-${label}-${process.pid}-${randomUUID()}`

async function loadDeps() {
  loadEnv()
  const [{ db }, accounting] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/accounting'),
  ])
  return { db, queueAccountingSyncTx: accounting.queueAccountingSyncTx }
}

type Db = Awaited<ReturnType<typeof loadDeps>>['db']

/**
 * Switch Xero and COGS_REVERSAL on, so the enqueue reaches its INSERT instead of returning
 * `not-configured` first. Without this every round would pass without ever writing anything.
 */
async function enableXeroCogsReversal(db: Db): Promise<void> {
  // `plugin_xero_enabled` is the one `queueAccountingSyncTx` resolves the ACTIVE connector from
  // (isIntegrationPluginEnabled) — unlike `queueXeroSync`, which only reads `xero_sync_enabled`.
  // Getting this key wrong returns `not-configured` before anything is written, and every assertion
  // below would then hold over an enqueue that never ran.
  for (const [key, value] of [
    ['plugin_xero_enabled', 'true'],
    ['xero_sync_enabled', 'true'],
    ['xero_sync_cogs_reversal', 'submitted'],
  ] as Array<[string, string]>) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
}

/**
 * `CogsEntry` is not an order-scoped reference type, so the enqueue needs no hoisted sales-order row
 * lock; and COGS_REVERSAL is not a money-moving type, so `lockFollowUpScope` takes NOTHING. That is
 * deliberate — with the scope lock held, two writers for one key could not collide at all, and the
 * unhandled-collision path this test exists for would be unreachable.
 */
const REFERENCE_TYPE = 'CogsEntry'

function payloadFor(key: string, writer: 'enqueue' | 'interloper') {
  return {
    _idempotencyKey: key,
    _probeWriter: writer,
    narration: 'o3d-d0pd r2 collision probe',
    lines: [
      { description: 'COGS', accountCode: '310', lineAmount: -7.5 },
      { description: 'Inventory', accountCode: '630', lineAmount: 7.5 },
    ],
  }
}

/**
 * o3d-ohrk3 — THE WINNER'S HOLD IS A STATE, NOT A DURATION. It used to keep its transaction open for a
 * fixed 300ms after its INSERT and the test asserted the loser's enqueue took at least that long. A
 * loser that reached its own INSERT late (host load: checkout, transaction start) found the winner
 * already committed, READ the row and deduped without ever colliding — the recovery path under test was
 * never exercised and the assertion failed. The winner now holds its transaction until the loser is
 * OBSERVED blocked behind it (a backend whose `pg_blocking_pids` names the winner, stuck on the
 * selection lock — see FENCE_WAIT below), and fails loud, with a diagnostic, if that never happens.
 */
/**
 * WHAT THE LOSER IS ACTUALLY PARKED ON — OBSERVED, AND NOT WHAT THIS FILE'S NARRATIVE SAYS (o3d-ohrk3).
 * Since o3d-j625 r13 every enqueue takes the plugin-selection ADVISORY lock first
 * (`pinnedLedgerIsServicedUnderLock`), so the second racer blocks there, behind the first one's open
 * transaction, and never reaches the unique index while the winner is open: the observer showed
 * `wait_event=advisory`, `SELECT pg_advisory_xact_lock($1)`, nothing on the index. It then wakes after
 * the winner commits and READS the row. The assertion this test always made — the loser's enqueue
 * cannot return before the winner commits — is therefore true and is what is observed below, but the
 * 23505 / savepoint recovery path is NOT what is being waited on any more. That recovery has its own
 * DETERMINISTIC test below ("a lock-bypassing interloper ..."), which forces the 23505 and asserts it
 * was reached (o3d-l2nx6).
 */
const FENCE_WAIT = /pg_advisory_xact_lock/i

test(
  '[o3d-d0pd r2] two enqueues for one key serialise behind each other\'s open transaction, and both commit (the FENCE race; the 23505 recovery is the next test)',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, queueAccountingSyncTx } = await loadDeps()
    await enableXeroCogsReversal(db)

    const referenceId = probeId('ref')
    const key = `cogs-reversal:${referenceId}`
    t.after(async () => {
      await db.accountingEvent.deleteMany({ where: { sourceEntityId: referenceId } }).catch(() => undefined)
      await db.accountingSyncLog.deleteMany({ where: { referenceId } })
      await db.activityLog.deleteMany({ where: { entityId: { startsWith: `${referenceId}:` } } })
    })

    /**
     * WHY THE COLLISION IS GUARANTEED, AND NOT MERELY LIKELY.
     *
     * Both racers are REAL enqueues in their own interactive transactions — an earlier draft raced the
     * enqueue against a bare INSERT, and the bare INSERT won every single time, so the enqueue always
     * read the row and deduped without ever inserting. The test passed and proved nothing.
     *
     * With two transactions, PostgreSQL's isolation does the work: the winner's row is INVISIBLE to
     * the loser's SELECT until the winner COMMITS, but the unique index conflicts on it immediately.
     * So the loser reads nothing, INSERTS, and blocks on the index — and gets its 23505 the moment the
     * winner commits. The read-and-dedupe outcome is not available to it.
     *
     * The winner then holds its transaction open after its own insert until the loser is OBSERVED
     * parked on the index (o3d-ohrk3), rather than racing past it.
     */
    const started: Array<() => void> = []
    const bothOpen = new Promise<void>((resolve) => {
      let count = 0
      started.push(() => { if (++count === 2) resolve() })
      started.push(() => { if (++count === 2) resolve() })
    })

    // Set by whichever racer INSERTED FIRST, once it has seen the other parked behind it. The racer that
    // lost cannot reach the check below until the winner has committed, so it always finds this set.
    const park: { holder?: string; observed?: ParkedBackend; releasedAt?: number } = {}

    async function racer(writer: string): Promise<{ writer: string; enqueueMs: number; enqueueDoneAt: number }> {
      return await db.$transaction(async (tx) => {
        // Both transactions are open before either enqueue begins.
        const pid = await backendPid(tx)
        started.pop()!()
        await bothOpen
        const startedAt = Date.now()
        const queued = await queueAccountingSyncTx(tx, {
          type: 'COGS_REVERSAL',
          referenceType: REFERENCE_TYPE,
          referenceId,
          payload: { ...payloadFor(key, 'enqueue'), _probeWriter: writer },
          idempotencyKey: key,
          // o3d-j625 r2: required now. `plugin_xero_enabled` is set to 'true' by this file's setup, so
          // the chart check passes and the collision below is still what is being raced.
          chartConnector: 'xero',
        })
        const enqueueDoneAt = Date.now()
        const enqueueMs = enqueueDoneAt - startedAt
        // Both racers must be told the counterpart is queued: one wrote it, the other collided with it.
        assert.equal(queued, true, `${writer}: the enqueue must report the posting as queued`)
        // THE SUBSEQUENT STATEMENT. On an aborted transaction this alone raises 25P02 — which is the
        // whole defect, and why a test that stopped at the enqueue's return would prove nothing.
        await tx.activityLog.create({
          data: {
            entityType: 'SYSTEM',
            entityId: `${referenceId}:${writer}`,
            action: 'd0pd_collision_probe',
            tag: 'sync',
            level: 'INFO',
            description: `enqueue reported queued=${queued}`,
          },
        })
        // Held open until the loser is OBSERVED parked behind this transaction.
        if (!park.observed) {
          park.observed = await waitUntilParkedBehind(db, {
            holderPid: pid, waitingOn: FENCE_WAIT, describe: `enqueue-collision winner ${writer}`,
          })
          park.holder = writer
          park.releasedAt = Date.now()
        }
        return { writer, enqueueMs, enqueueDoneAt }
      }, TX)
    }

    const results = await Promise.all([racer('alpha'), racer('beta')])

    // BOTH TRANSACTIONS COMMITTED. Read back on a fresh query, after both are done. Before the
    // savepoint the loser's write and its COMMIT both failed with 25P02, so its marker never existed.
    for (const { writer } of results) {
      const committed = await db.activityLog.count({ where: { entityId: `${referenceId}:${writer}` } })
      assert.equal(committed, 1,
        `${writer}'s transaction did not commit — this is the defect: a P2002 caught inside the `
        + "caller's interactive transaction aborts it, so the write after the enqueue and the COMMIT "
        + 'both fail with 25P02',
      )
    }

    // The index held: one row for one key.
    const rows = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { payload: true } })
    assert.equal(rows.length, 1, 'exactly one row may exist for one idempotency key')
    const winner = (rows[0].payload as { _probeWriter?: string } | null)?._probeWriter
    assert.ok(winner === 'alpha' || winner === 'beta', `the surviving row must name its writer, got ${winner}`)

    // THE PRECONDITION WAS REACHED, OBSERVED RATHER THAN ARGUED. The loser was seen blocked behind the
    // winner's open transaction, so its enqueue cannot have returned before the winner committed. (It is
    // parked on the selection fence, not the unique index — see FENCE_WAIT.) A loser that arrived after
    // the winner committed is never parked, and would have passed the old timing assertion's twin
    // vacuously or failed it by latency alone.
    const loser = results.find((r) => r.writer !== winner)
    assert.ok(loser, 'both racers must be accounted for')
    assert.ok(park.observed && park.releasedAt, 'PRECONDITION: the loser was observed parked behind the winner')
    console.log(`[o3d-ohrk3 parked] collision: loser backend ${park.observed.pid} observed blocked on `
      + `\`${park.observed.query.replace(/\s+/g, ' ').slice(0, 60)}\` after ${park.observed.observedAfterMs}ms; `
      + `winner ${park.holder} released ${loser.enqueueDoneAt - park.releasedAt}ms before the loser's enqueue returned`)
    assert.equal(park.holder, winner, 'the racer that held the index is the one whose row survived')
    assert.ok(loser.enqueueDoneAt >= park.releasedAt,
      `the losing enqueue returned ${park.releasedAt - loser.enqueueDoneAt}ms BEFORE the winner released `
      + 'its transaction, so it never waited behind the winner and the collision was never raced',
    )
  },
)

test(
  '[o3d-l2nx6] a lock-bypassing interloper commits between the enqueue\'s read and its INSERT: the 23505 is raised, recovered under the savepoint, and the SAME transaction still writes and commits',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    /**
     * THE RECOVERY PATH, FORCED AND NOT RACED (o3d-l2nx6, Codex HIGH on #727).
     *
     * Since o3d-j625 r13 two ENQUEUES for one key serialise on advisory locks, so the test above can no
     * longer make one of them hit the idempotency-key unique index. A writer that takes none of those
     * locks can: a bare `accountingSyncLog.create` (a script, a repair, an older code path).
     *
     * THE ORDER, DRIVEN BY STATE (no sleep, no test seam):
     *   1. the interloper INSERTS the key in its own transaction and leaves it OPEN — uncommitted, so the
     *      enqueue's prior-attempt read (READ COMMITTED) cannot see it and finds nothing to dedupe on;
     *   2. the enqueue passes its fences and prior-attempt read, and its INSERT blocks on the unique index
     *      behind the interloper — observed through pg_blocking_pids (`wait_event=transactionid`, the
     *      INSERT statement) before anything is released;
     *   3. only then does the interloper COMMIT, so the enqueue's INSERT gets its 23505 — the read-and-
     *      dedupe outcome is NOT available to it.
     * The enqueue must recover under its savepoint, answer queued, and the caller's next statement and
     * COMMIT must succeed (without the savepoint both die with 25P02).
     */
    const { db, queueAccountingSyncTx } = await loadDeps()
    await enableXeroCogsReversal(db)
    const referenceId = probeId('forced')
    const key = `cogs-reversal:${referenceId}`
    t.after(async () => {
      await db.accountingEvent.deleteMany({ where: { sourceEntityId: referenceId } }).catch(() => undefined)
      await db.accountingSyncLog.deleteMany({ where: { referenceId } })
      await db.activityLog.deleteMany({ where: { entityId: { startsWith: `${referenceId}:` } } })
    })

    let interloperInserted!: (pid: number) => void
    const interloperHasInserted = new Promise<number>((resolve) => { interloperInserted = resolve })
    let parked: ParkedBackend | null = null

    const interloper = db.$transaction(async (tx) => {
      const pid = await backendPid(tx)
      // A BARE insert: no selection fence, no posting-key lock, no follow-up scope lock.
      await tx.accountingSyncLog.create({
        data: {
          connector: 'xero',
          type: 'COGS_REVERSAL' as const,
          status: 'PENDING' as const,
          referenceType: REFERENCE_TYPE,
          referenceId,
          payload: payloadFor(key, 'interloper'),
        },
      })
      interloperInserted(pid)
      // Held open until the enqueue is OBSERVED stuck on the unique index (its INSERT) behind us.
      parked = await waitUntilParkedBehind(db, {
        holderPid: pid, waitingOn: /INSERT INTO\s+.*accounting_sync_logs/i, describe: 'forced 23505: the enqueue\'s INSERT',
      })
    }, TX)

    let queued: boolean | null = null
    let outcome: { queued?: boolean; reason?: string } | null = null
    const enqueue = db.$transaction(async (tx) => {
      await interloperHasInserted
      queued = await queueAccountingSyncTx(tx, {
        type: 'COGS_REVERSAL',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: payloadFor(key, 'enqueue'),
        idempotencyKey: key,
        chartConnector: 'xero',
        reportOutcome: (o) => { outcome = o as never },
      })
      // THE SUBSEQUENT STATEMENT, in the same transaction, which is what the savepoint exists for.
      await tx.activityLog.create({
        data: {
          entityType: 'SYSTEM', entityId: `${referenceId}:enqueue`, action: 'l2nx6_forced_collision_probe',
          tag: 'sync', level: 'INFO', description: `enqueue reported queued=${queued}`,
        },
      })
    }, TX)

    const [interloperOutcome, enqueueOutcome] = await Promise.allSettled([interloper, enqueue])
    // The observer's diagnostic (never parked) is the root cause if there is one.
    if (interloperOutcome.status === 'rejected') throw interloperOutcome.reason
    if (enqueueOutcome.status === 'rejected') throw enqueueOutcome.reason

    // PRECONDITION: THE 23505 WAS REACHED. The enqueue's INSERT was observed blocked on the unique index
    // behind an UNCOMMITTED interloper, so its prior-attempt read had found nothing and it could only
    // finish by colliding after the interloper committed.
    assert.ok(parked, 'PRECONDITION: the enqueue INSERT was observed parked behind the interloper')
    const seen = parked as ParkedBackend
    console.log(`[o3d-l2nx6 forced 23505] enqueue backend ${seen.pid} observed blocked on the unique index `
      + `(\`${seen.query.replace(/\s+/g, ' ').slice(0, 50)}\`) after ${seen.observedAfterMs}ms, then the interloper committed`)
    assert.match(seen.query, /accounting_sync_logs/i)

    assert.equal(queued, true, 'the collision is reported as queued: the counterpart exists')
    assert.equal((outcome as { reason?: string } | null)?.reason, 'already-queued')
    // THE POINT OF THE SAVEPOINT: the write AFTER the recovered collision, and the COMMIT, both landed.
    assert.equal(await db.activityLog.count({ where: { entityId: `${referenceId}:enqueue` } }), 1,
      'the caller\'s write after the recovered 23505 must be durable: a transaction left in 25P02 cannot commit it')
    const rows = await db.accountingSyncLog.findMany({ where: { referenceId }, select: { payload: true } })
    assert.equal(rows.length, 1, 'one row for one key')
    assert.equal((rows[0].payload as { _probeWriter?: string })._probeWriter, 'interloper',
      'the surviving row is the interloper\'s: the enqueue\'s own INSERT is the one that collided')
  },
)

test(
  '[o3d-d0pd r2] the same shape WITHOUT a savepoint really does poison the transaction',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // The control, and the reason the test above is worth running. It reproduces the un-savepointed
    // catch against the SAME table and the SAME constraint, and shows the state the fix removes: the
    // duplicate is correctly recognised, and the transaction is dead anyway.
    const { db } = await loadDeps()
    const referenceId = probeId('control')
    t.after(async () => {
      await db.accountingEvent.deleteMany({ where: { sourceEntityId: referenceId } }).catch(() => undefined)
      await db.accountingSyncLog.deleteMany({ where: { referenceId } })
    })

    const row = {
      connector: 'xero',
      type: 'COGS_REVERSAL' as const,
      status: 'PENDING' as const,
      referenceType: REFERENCE_TYPE,
      referenceId,
      payload: payloadFor(`cogs-reversal:${referenceId}`, 'interloper'),
    }

    let afterCatch: string | null = null
    await db.$transaction(async (tx) => {
      await tx.accountingSyncLog.create({ data: row })
      try {
        await tx.accountingSyncLog.create({ data: row })
      } catch {
        // Exactly what the enqueue's catch does: recognise the duplicate and carry on.
      }
      // The subsequent statement every real caller makes.
      await tx.accountingSyncLog.count({ where: { referenceId } })
    }, TX).catch((error: unknown) => {
      afterCatch = error instanceof Error ? error.message : String(error)
    })

    assert.ok(afterCatch, 'the un-savepointed transaction must not have completed')
    assert.match(afterCatch, /current transaction is aborted/,
      'this is what `withSavepoint` removes from the enqueue: a caught P2002 leaves 25P02 behind, so '
      + '"detected and handled" was followed by a commit the caller could not explain')
  },
)
