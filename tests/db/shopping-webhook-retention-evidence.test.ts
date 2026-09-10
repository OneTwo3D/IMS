import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE HOLD ON WOOCOMMERCE ORDER EVIDENCE, PROVEN AGAINST A REAL POSTGRES (o3d-j7y4, Codex r17 HIGH;
 * r18 bounded it by a recorded cutoff, r19 withdrew that bound).
 *
 * The thing being asserted is which rows a SQL predicate selects, and that is a property of Postgres,
 * not of anything IMS computes. A mocked `updateMany` can only show the shape of the object we handed
 * Prisma; it cannot show what `NOT (connector = $1 AND resource = $2 AND receivedAt < $3)` does to a
 * row, which is the whole question. The sibling unit test (tests/data-retention-webhook-events.test.ts)
 * pins that the purge uses this predicate and that the cutoff is recorded once and never moved; this
 * one pins what the predicate then does, on the two routes that matter:
 *
 *   1. a WooCommerce ORDER delivery, however old   — HELD, and the age bound cannot reach it;
 *   2. any other delivery of the same age          — COMPACTED, exactly as before.
 *
 * The SECOND is what stops this passing vacuously. A predicate that compacted nothing at all would
 * spare the order delivery too, and the assertion below that the ordinary row IS emptied by the same
 * statement is the only thing that can tell those apart.
 *
 * IT RUNS THE REAL COMPACTION — the same `updateMany` with the same `where` and the same `data` the
 * nightly purge issues — INSIDE TRANSACTIONS THAT ARE ALWAYS ROLLED BACK, and narrowed by `id` to two
 * probe rows so it can never touch anything else. The final assertion is made AFTER the rollbacks, from
 * outside the transactions, and is the proof that the test left the database as it found it.
 *
 * ------------------------------------------------------------------------------------------------
 * IT SEEDS ITS OWN TWO ROWS, AS OF o3d-n3yt r19 (Codex r18 HIGH). It used to SELECT the probe rows out
 * of whatever the target database already held and assert that both were found. That made it
 * unrunnable on the only database CI can hand it — the freshly migrated, EMPTY `postgres:16` service
 * that `accounting-db-regressions` stands up — so enabling its gate there would have turned the job
 * red on an empty table rather than on a regression, and the gate stayed unset instead. It now INSERTs
 * both rows itself and deletes them in a `finally`, whatever the assertions do.
 *
 * THE FIXTURES USE LITERAL WIRE VALUES ('woocommerce', 'orders', 'products', 'PROCESSED') AND NOT THE
 * CONSTANTS THE MODULE UNDER TEST READS. If the seed imported `WOOCOMMERCE_CONNECTOR` from the same
 * place `compactableShoppingWebhookEventWhere` does, a change to that constant would move the fixture
 * and the predicate together and this test would stay green while every real row — written under the
 * old value — silently left the exemption. The literals are the values on the rows in production, so
 * they are what the fixture has to carry.
 *
 * BOTH ROWS ARE `connector = 'woocommerce'` and differ ONLY in `resource`. That is deliberate: it
 * isolates the exemption's `resource` conjunct, so an exemption widened to the whole connector fails
 * here (nothing would be compacted) instead of passing.
 * ------------------------------------------------------------------------------------------------
 *
 * Gated behind RUN_DB_RETENTION_TESTS=1: `npm run test:unit` has no database. Imports are RELATIVE for
 * the same reason as tests/concurrency/*.
 */

const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

/**
 * THE TRIPWIRE, MODELLED ON `REQUIRE_DB_MIGRATION_TESTS` IN THE TWO SIBLING FILES (o3d-n3yt r19).
 *
 * `REQUIRE_DB_RETENTION_TESTS=1` means "this environment PROMISED a migrated database". A
 * `RUN_DB_RETENTION_TESTS` that is not also `1` in such an environment is a wiring defect, and the
 * module refuses to load rather than reporting a green `# SKIP` inside a green job — which is exactly
 * what it did between the job being restored and this round. An unset pair is an ordinary local run
 * and still skips.
 *
 * `scripts/check-db-test-gates.mjs` is what keeps the pair wired: it reads the env assignments on
 * `npm run test:db` and the `process.env` reads in this directory, and fails if a gate here is not set
 * there with a `REQUIRE_` counterpart that something actually reads. The counterpart being read is
 * THIS block.
 */
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error(
    'REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so the test in '
    + 'tests/db/shopping-webhook-retention-evidence.test.ts would have been skipped in an '
    + 'environment that promised a migrated database. Fix the invocation (npm run test:db) rather '
    + 'than this check: a silent skip here is the Codex r18 finding on o3d-n3yt.',
  )
}

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  }
}

/** Thrown to roll the probe transaction back. Nothing else may throw it. */
class RollbackProbe extends Error {}

/**
 * Old enough that no `retention_webhook_events_months` an operator can configure leaves it inside the
 * window. Both probe rows carry it on `receivedAt` AND on `updatedAt` — the predicate's age conjunct
 * is on `updatedAt`, so that is the one that has to be past the cutoff for the test to mean anything.
 */
const LONG_EXPIRED = new Date('2020-01-01T00:00:00.000Z')

test('the hold spares a WooCommerce order delivery of any age while emptying an ordinary one beside it (o3d-j7y4)', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const { compactableShoppingWebhookEventWhere } = await import(
    '../../lib/connectors/shopping-webhook-retention.ts'
  )

  // Unique per run, so two runs against one database cannot collide on
  // @@unique([connector, resource, payloadHash]) and cannot delete each other's rows.
  const stamp = `o3d-n3yt-retention-probe-${randomUUID()}`

  // Two rows this test owns outright: one WooCommerce ORDER delivery (the evidence o3d-j7y4 needs)
  // and one WooCommerce PRODUCT delivery of the same age (what the compaction is for). Both PROCESSED,
  // both carrying a payload, so `status` and `payloadJson != {}` spare neither.
  const orderRow = await db.shoppingWebhookEvent.create({
    data: {
      connector: 'woocommerce',
      resource: 'orders',
      payloadHash: `${stamp}-orders`,
      payloadJson: { probe: stamp, currency: 'GBP' },
      status: 'PROCESSED',
      receivedAt: LONG_EXPIRED,
      processedAt: LONG_EXPIRED,
    },
    select: { id: true },
  })
  const ordinaryRow = await db.shoppingWebhookEvent.create({
    data: {
      connector: 'woocommerce',
      resource: 'products',
      payloadHash: `${stamp}-products`,
      payloadJson: { probe: stamp, sku: 'PROBE' },
      status: 'PROCESSED',
      receivedAt: LONG_EXPIRED,
      processedAt: LONG_EXPIRED,
    },
    select: { id: true },
  })
  const probeIds = [orderRow.id, ordinaryRow.id]

  try {
    // `updatedAt` is `@updatedAt`, so Prisma writes `now()` on INSERT whatever the create data says.
    // It is backdated here in SQL, and then READ BACK AND ASSERTED rather than assumed: the predicate's
    // age conjunct is on this column, and a fixture that was still young would be spared by its age
    // and would prove nothing about the hold.
    await db.$executeRaw`
      UPDATE shopping_webhook_events
         SET "updatedAt" = ${LONG_EXPIRED}, "receivedAt" = ${LONG_EXPIRED}
       WHERE id IN (${orderRow.id}, ${ordinaryRow.id})
    `
    const seeded = await db.shoppingWebhookEvent.findMany({
      where: { id: { in: probeIds } },
      select: { id: true, receivedAt: true, updatedAt: true, payloadJson: true },
    })
    assert.equal(seeded.length, 2, 'both probe rows must have been seeded')
    for (const row of seeded) {
      assert.equal(
        row.updatedAt.getTime(),
        LONG_EXPIRED.getTime(),
        `probe row ${row.id} must be backdated on updatedAt, which is the column the age conjunct reads`,
      )
      assert.equal(row.receivedAt.getTime(), LONG_EXPIRED.getTime(), `probe row ${row.id} must be backdated on receivedAt`)
      assert.notDeepEqual(row.payloadJson, {}, `probe row ${row.id} must start out carrying a payload`)
    }

    // Everything is past this cutoff, so age cannot be what spares a row: only the hold can.
    const cutoff = new Date()
    assert.ok(LONG_EXPIRED < cutoff, 'the probe rows must predate the compaction cutoff')

    /** Runs the purge's own statement, and rolls it back. */
    async function probe() {
      let compacted = -1
      let orderPayload: unknown
      let ordinaryPayload: unknown
      await assert.rejects(
        db.$transaction(async (tx) => {
          const result = await tx.shoppingWebhookEvent.updateMany({
            // The purge's own predicate, narrowed to the two probe rows.
            where: {
              ...compactableShoppingWebhookEventWhere(cutoff),
              id: { in: probeIds },
            },
            data: { payloadJson: {}, lastError: null },
          })
          compacted = result.count
          const after = await tx.shoppingWebhookEvent.findMany({
            where: { id: { in: probeIds } },
            select: { id: true, payloadJson: true },
          })
          orderPayload = after.find((r) => r.id === orderRow.id)?.payloadJson
          ordinaryPayload = after.find((r) => r.id === ordinaryRow.id)?.payloadJson
          throw new RollbackProbe('probe complete')
        }),
        RollbackProbe,
      )
      return { compacted, orderPayload, ordinaryPayload }
    }

    // THE HOLD, ON REAL ROWS IN A REAL TABLE. Both probe rows are PROCESSED, both still carry a
    // payload, both are years past the cutoff — so age spares neither of them. The order delivery
    // survives anyway; the product delivery beside it is emptied by the very same statement.
    const held = await probe()
    assert.equal(held.compacted, 1, 'exactly one of the two probe rows may be compacted')
    assert.deepEqual(held.ordinaryPayload, {}, 'an ordinary expired delivery is still emptied')
    assert.notDeepEqual(
      held.orderPayload,
      {},
      'a WooCommerce order delivery must survive the retention run whatever its age',
    )

    // After the rollbacks, from outside: both rows are exactly as they were.
    const restored = await db.shoppingWebhookEvent.findMany({
      where: { id: { in: probeIds } },
      select: { id: true, payloadJson: true },
    })
    assert.equal(restored.length, 2, 'both probe rows must still exist')
    for (const row of restored) {
      assert.notDeepEqual(row.payloadJson, {}, `probe row ${row.id} must be restored by the rollback`)
    }
  } finally {
    // The rows this test created, and only those, whatever happened above.
    await db.shoppingWebhookEvent.deleteMany({ where: { id: { in: probeIds } } })
  }
})
