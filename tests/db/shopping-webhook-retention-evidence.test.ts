import assert from 'node:assert/strict'
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

test('the hold spares a WooCommerce order delivery of any age while emptying an ordinary one beside it (o3d-j7y4)', { skip }, async () => {
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

  // THE HOLD, ON REAL ROWS. Both probe rows are PROCESSED, both still carry a payload, and the age
  // cutoff is `now` — so age spares neither of them. The order delivery survives anyway; the ordinary
  // delivery beside it is emptied by the very same statement.
  const held = await probe()
  assert.equal(held.compacted, 1, 'exactly one of the two probe rows may be compacted')
  assert.deepEqual(held.ordinaryPayload, {}, 'an ordinary expired delivery is still emptied')
  assert.notDeepEqual(
    held.orderPayload,
    {},
    'a WooCommerce order delivery must survive the retention run whatever its age',
  )

  // AND THE ORDER ROW USED IS AN OLD ONE — asserted, not hoped for. A probe row that happened to be
  // young would be spared by its age and would prove nothing about the hold. `receivedAt` is only read
  // here, to establish that this row is genuinely past the window the operator configured.
  assert.ok(
    orderRow.receivedAt < cutoff,
    'the order probe row must predate the compaction cutoff, or its survival says nothing',
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
})
