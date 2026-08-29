import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE HOLD ON WOOCOMMERCE ORDER EVIDENCE, PROVEN AGAINST A REAL POSTGRES (o3d-j7y4, Codex r17 HIGH,
 * bounded in r18).
 *
 * The thing being asserted is which rows a SQL predicate selects, and that is a property of Postgres,
 * not of anything IMS computes. A mocked `updateMany` can only show the shape of the object we handed
 * Prisma; it cannot show what `NOT (connector = $1 AND resource = $2 AND receivedAt < $3)` does to a
 * row, which is the whole question. The sibling unit test (tests/data-retention-webhook-events.test.ts)
 * pins that the purge uses this predicate and that the cutoff is recorded once and never moved; this
 * one pins what the predicate then does, on all three of the routes that matter:
 *
 *   1. an order delivery received BEFORE the cutoff  — HELD, whatever its age;
 *   2. an order delivery received AFTER the cutoff   — COMPACTED, like any other delivery;
 *   3. an installation with NO cutoff recorded yet    — every order delivery HELD.
 *
 * IT RUNS THE REAL COMPACTION — the same `updateMany` with the same `where` and the same `data` the
 * nightly purge issues — INSIDE TRANSACTIONS THAT ARE ALWAYS ROLLED BACK, and narrowed by `id` to two
 * probe rows so it can never touch anything else. The final assertion is made AFTER the rollbacks, from
 * outside the transactions, and is the proof that the test left the database as it found it.
 *
 * Gated behind RUN_DB_RETENTION_TESTS=1: `npm run test:unit` has no database. Imports are RELATIVE for
 * the same reason as tests/concurrency/*.
 */

const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  }
}

/** Thrown to roll the probe transaction back. Nothing else may throw it. */
class RollbackProbe extends Error {}

test('the hold spares PRE-cutoff order evidence, releases POST-cutoff deliveries, and holds everything before a cutoff exists (o3d-j7y4)', { skip }, async () => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const { compactableShoppingWebhookEventWhere } = await import(
    '../../lib/connectors/shopping-webhook-retention.ts'
  )

  // Two REAL rows, both PROCESSED and both carrying a payload: one WooCommerce ORDER delivery (the
  // evidence o3d-j7y4 needs) and one ordinary delivery of any other kind (what the compaction is for).
  const [orderRow] = await db.shoppingWebhookEvent.findMany({
    where: {
      connector: 'woocommerce',
      resource: 'orders',
      status: 'PROCESSED',
      NOT: { payloadJson: { equals: {} } },
    },
    select: { id: true, receivedAt: true },
    take: 1,
  })
  const [ordinaryRow] = await db.shoppingWebhookEvent.findMany({
    where: {
      status: 'PROCESSED',
      resource: { not: 'orders' },
      NOT: { payloadJson: { equals: {} } },
    },
    select: { id: true },
    take: 1,
  })
  // The preconditions, asserted rather than assumed: with either row missing this test proves nothing.
  assert.ok(orderRow, 'no uncompacted WooCommerce order delivery to protect — nothing under test')
  assert.ok(ordinaryRow, 'no uncompacted ordinary delivery — the compaction half proves nothing')

  // Everything is past this cutoff, so age cannot be what spares a row: only the hold can.
  const cutoff = new Date()
  const probeIds = [orderRow.id, ordinaryRow.id]

  /** Runs the purge's own statement under one evidence cutoff, and rolls it back. */
  async function probe(evidenceCutoff: Date | null) {
    let compacted = -1
    let orderPayload: unknown
    let ordinaryPayload: unknown
    await assert.rejects(
      db.$transaction(async (tx) => {
        const result = await tx.shoppingWebhookEvent.updateMany({
          // The purge's own predicate, narrowed to the two probe rows.
          where: {
            ...compactableShoppingWebhookEventWhere(cutoff, evidenceCutoff),
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

  // 1. PRE-CUTOFF. The cutoff is one millisecond after this delivery arrived, so it is evidence and is
  //    spared — while the ordinary delivery beside it is emptied by the same statement.
  const preCutoff = await probe(new Date(orderRow.receivedAt.getTime() + 1))
  assert.equal(preCutoff.compacted, 1, 'exactly one of the two probe rows may be compacted')
  assert.deepEqual(preCutoff.ordinaryPayload, {}, 'an ordinary expired delivery is still emptied')
  assert.notDeepEqual(
    preCutoff.orderPayload,
    {},
    'an order delivery received BEFORE the cutoff must survive the retention run',
  )

  // 2. POST-CUTOFF. The same row, against a cutoff at its own receipt instant: `receivedAt < cutoff` is
  //    false, so it is NOT exempt and compacts exactly like the ordinary delivery. This is the half
  //    that proves the hold has an end — without it the exemption would be indefinite.
  const postCutoff = await probe(orderRow.receivedAt)
  assert.equal(postCutoff.compacted, 2, 'both probe rows compact once the order delivery is post-cutoff')
  assert.deepEqual(postCutoff.orderPayload, {}, 'an order delivery received AFTER the cutoff is emptied')
  assert.deepEqual(postCutoff.ordinaryPayload, {})

  // 3. NO CUTOFF RECORDED. Nothing can be dated yet, so nothing WooCommerce sent about an order is
  //    destroyed — the fail-safe direction, and the state a fresh installation is in until its first
  //    nightly run records a cutoff.
  const noCutoff = await probe(null)
  assert.equal(noCutoff.compacted, 1, 'with no cutoff, only the ordinary delivery compacts')
  assert.notDeepEqual(noCutoff.orderPayload, {}, 'with no cutoff every order delivery is held')
  assert.deepEqual(noCutoff.ordinaryPayload, {})

  // After the rollbacks, from outside: both rows are exactly as they were.
  const restored = await db.shoppingWebhookEvent.findMany({
    where: { id: { in: probeIds } },
    select: { id: true, payloadJson: true },
  })
  assert.equal(restored.length, 2, 'both probe rows must still exist')
  for (const row of restored) {
    assert.notDeepEqual(row.payloadJson, {}, `probe row ${row.id} must be restored by the rollback`)
  }
})
