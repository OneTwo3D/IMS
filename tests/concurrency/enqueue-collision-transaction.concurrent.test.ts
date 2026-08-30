import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

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
 * How long the winner holds its transaction open after its INSERT. The loser is blocked on the
 * unique index for the whole of it, which is what makes the collision DETERMINISTIC and, just as
 * importantly, MEASURABLE — see the timing assertion.
 */
const HOLD_MS = 300

test(
  '[o3d-d0pd r2] a colliding enqueue leaves the outer transaction committable, and the collision is reached',
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
     * The winner then holds its transaction open for HOLD_MS after its own insert, so the loser is
     * demonstrably parked on the index rather than racing past it.
     */
    const started: Array<() => void> = []
    const bothOpen = new Promise<void>((resolve) => {
      let count = 0
      started.push(() => { if (++count === 2) resolve() })
      started.push(() => { if (++count === 2) resolve() })
    })

    async function racer(writer: string): Promise<{ writer: string; enqueueMs: number }> {
      return await db.$transaction(async (tx) => {
        // Both transactions are open before either enqueue begins.
        started.pop()!()
        await bothOpen
        const startedAt = Date.now()
        const queued = await queueAccountingSyncTx(tx, {
          type: 'COGS_REVERSAL',
          referenceType: REFERENCE_TYPE,
          referenceId,
          payload: { ...payloadFor(key, 'enqueue'), _probeWriter: writer },
          idempotencyKey: key,
        })
        const enqueueMs = Date.now() - startedAt
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
        // Held open so the loser is parked on the unique index for a measurable interval.
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
        return { writer, enqueueMs }
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

    // THE PRECONDITION WAS REACHED, MEASURED RATHER THAN ARGUED. The loser sat on the unique index
    // for the whole of the winner's hold, so its enqueue cannot have returned before the winner
    // committed — which is only possible if it INSERTED and collided. A read-and-dedupe would have
    // returned in milliseconds. Without this the test would pass just as happily against a race that
    // never raced, which is the shape of a guard that cannot fail.
    const loser = results.find((r) => r.writer !== winner)
    assert.ok(loser, 'both racers must be accounted for')
    assert.ok(loser.enqueueMs >= HOLD_MS,
      `the losing enqueue returned in ${loser.enqueueMs}ms without waiting out the winner's ${HOLD_MS}ms `
      + 'hold, so it never blocked on the unique index and the recovery path was never exercised',
    )
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
