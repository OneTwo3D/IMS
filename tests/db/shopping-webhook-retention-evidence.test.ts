import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE HOLD ON WOOCOMMERCE ORDER EVIDENCE, PROVEN AGAINST A REAL POSTGRES (o3d-j7y4, Codex r17 HIGH).
 *
 * The thing being asserted is which rows a SQL predicate selects, and that is a property of Postgres,
 * not of anything IMS computes. A mocked `updateMany` can only show the shape of the object we handed
 * Prisma; it cannot show what `NOT (connector = $1 AND resource = $2)` does to a row, which is the
 * whole question. The sibling unit test (tests/data-retention-webhook-events.test.ts) pins that the
 * purge uses this predicate; this one pins what the predicate then does.
 *
 * IT RUNS THE REAL COMPACTION — the same `updateMany` with the same `where` and the same `data` the
 * nightly purge issues — INSIDE A TRANSACTION THAT IS ALWAYS ROLLED BACK, and narrowed by `id` to two
 * probe rows so it can never touch anything else. The final assertion is made AFTER the rollback, from
 * outside the transaction, and is the proof that the test left the database as it found it.
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

test('retention COMPACTS an ordinary expired delivery and LEAVES a WooCommerce order delivery (o3d-j7y4)', { skip }, async () => {
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
    select: { id: true },
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

  let compacted = -1
  let orderPayloadInsideTx: unknown
  let ordinaryPayloadInsideTx: unknown
  await assert.rejects(
    db.$transaction(async (tx) => {
      const result = await tx.shoppingWebhookEvent.updateMany({
        // The purge's own predicate, narrowed to the two probe rows.
        where: { ...compactableShoppingWebhookEventWhere(cutoff), id: { in: probeIds } },
        data: { payloadJson: {}, lastError: null },
      })
      compacted = result.count
      const after = await tx.shoppingWebhookEvent.findMany({
        where: { id: { in: probeIds } },
        select: { id: true, payloadJson: true },
      })
      orderPayloadInsideTx = after.find((r) => r.id === orderRow.id)?.payloadJson
      ordinaryPayloadInsideTx = after.find((r) => r.id === ordinaryRow.id)?.payloadJson
      throw new RollbackProbe('probe complete')
    }),
    RollbackProbe,
  )

  // Exactly one of the two was compacted — the ordinary one.
  assert.equal(compacted, 1, 'the compaction must select exactly one of the two probe rows')
  assert.deepEqual(ordinaryPayloadInsideTx, {}, 'an ordinary expired delivery is still emptied')
  assert.notDeepEqual(
    orderPayloadInsideTx,
    {},
    'a WooCommerce ORDER delivery must survive the retention run while o3d-j7y4 is open',
  )

  // After the rollback, from outside: both rows are exactly as they were.
  const restored = await db.shoppingWebhookEvent.findMany({
    where: { id: { in: probeIds } },
    select: { id: true, payloadJson: true },
  })
  for (const row of restored) {
    assert.notDeepEqual(row.payloadJson, {}, `probe row ${row.id} must be restored by the rollback`)
  }
})
