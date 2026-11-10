import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

// The shopping webhook inbox's terminal writes are fenced on the claim. A worker whose PROCESSING
// claim expired can still finish later; its result must not overwrite a newer claim, a dead-letter
// or an operator replay. That is a conditional UPDATE, so it is verified against a real database.

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
}

test(
  'claim, stale reclaim, dead-letter, replay: the stale worker finishes and the replayed row is untouched',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { createShoppingWebhookEventRepository } = await import('@/lib/connectors/shopping-webhook-inbox')
    const { buildDeadShoppingWebhookReplayWhere, buildDeadShoppingWebhookReplayData } =
      await import('@/lib/domain/shopping-webhook-exception')
    const repository = createShoppingWebhookEventRepository({ client: db as never })
    const hash = `fence-${randomUUID()}`
    const t0 = new Date(Date.UTC(2026, 10, 10, 10, 0, 0))
    const staleBefore = new Date(Date.UTC(2000, 0, 1))
    let id = ''

    try {
      const created = await db.shoppingWebhookEvent.create({
        data: {
          connector: 'woocommerce', resource: 'orders', externalEventId: hash, topic: 'order.created',
          payloadHash: hash, payloadJson: { id: 1 }, originAttestation: 'unproven:not-applicable',
          status: 'PENDING', attempts: 0,
        },
      })
      id = created.id

      // worker A claims; its claim goes stale; worker B reclaims
      const claimA = await repository.claimEvent(id, t0, staleBefore)
      assert.ok(claimA)
      const claimB = await repository.claimEvent(id, new Date(t0.getTime() + 20 * 60_000), new Date(t0.getTime() + 10 * 60_000))
      assert.ok(claimB, 'a stale PROCESSING claim can be taken over')
      assert.ok(claimB.claimGeneration > claimA.claimGeneration)

      // B gives up: dead letter. The operator replays it (attempts reset to 0).
      assert.equal(await repository.markDeadLetter({ id, now: t0, error: 'held', claimGeneration: claimB.claimGeneration }), true)
      const replay = await db.shoppingWebhookEvent.updateMany({
        where: buildDeadShoppingWebhookReplayWhere(id),
        data: buildDeadShoppingWebhookReplayData(),
      })
      assert.equal(replay.count, 1)

      // B's own (duplicate) finish after the replay: same generation as the dead-letter, but the row is no longer
      // PROCESSING, so the status half of the fence refuses it
      assert.equal(await repository.markProcessed(id, t0, claimB.claimGeneration), false)
      assert.equal(await repository.markFailed({ id, now: t0, error: 'x', nextAttemptAt: t0, claimGeneration: claimB.claimGeneration }), false)
      assert.equal(await repository.markDeadLetter({ id, now: t0, error: 'x', claimGeneration: claimB.claimGeneration }), false)
      assert.equal((await db.shoppingWebhookEvent.findUniqueOrThrow({ where: { id } })).status, 'PENDING')

      // A is a straggler that finishes NOW, with every possible outcome, against a PENDING row...
      assert.equal(await repository.markProcessed(id, t0, claimA.claimGeneration), false)
      assert.equal(await repository.markFailed({ id, now: t0, error: 'x', nextAttemptAt: t0, claimGeneration: claimA.claimGeneration }), false)
      assert.equal(await repository.markDeadLetter({ id, now: t0, error: 'x', claimGeneration: claimA.claimGeneration }), false)
      let row = await db.shoppingWebhookEvent.findUniqueOrThrow({ where: { id } })
      assert.equal(row.status, 'PENDING', 'the replayed row is untouched')
      assert.equal(row.attempts, 0)
      assert.equal(row.lastError, null)

      // ...and against a fresh claim of the replayed row, whose attempts (1) equals A's original: attempts
      // alone would NOT have told the two claims apart, the claimGeneration does.
      const claimC = await repository.claimEvent(id, t0, staleBefore)
      assert.ok(claimC)
      assert.equal(claimC.attempts, claimA.attempts, 'precondition: an attempts-only fence would be fooled here')
      assert.equal(await repository.markProcessed(id, t0, claimA.claimGeneration), false)
      row = await db.shoppingWebhookEvent.findUniqueOrThrow({ where: { id } })
      assert.equal(row.status, 'PROCESSING', 'the live claim is not finished by the stale worker')

      // A straggler's FAILED and DEAD-LETTER writes cannot touch the live claim either
      assert.equal(await repository.markFailed({ id, now: t0, error: 'x', nextAttemptAt: t0, claimGeneration: claimA.claimGeneration }), false)
      assert.equal(await repository.markDeadLetter({ id, now: t0, error: 'x', claimGeneration: claimA.claimGeneration }), false)
      row = await db.shoppingWebhookEvent.findUniqueOrThrow({ where: { id } })
      assert.equal(row.status, 'PROCESSING')
      assert.equal(row.lastError, null)

      // the live claim's own finish applies, once
      assert.equal(await repository.markProcessed(id, t0, claimC.claimGeneration), true)
      assert.equal(await repository.markProcessed(id, t0, claimC.claimGeneration), false)
      row = await db.shoppingWebhookEvent.findUniqueOrThrow({ where: { id } })
      assert.equal(row.status, 'PROCESSED')
    } finally {
      if (id) await db.shoppingWebhookEvent.deleteMany({ where: { id } })
      await db.$disconnect()
    }
  },
)

test(
  'dead letters of a connector with no active drain are neither listed nor replayable',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async () => {
    loadEnv()
    const { db } = await import('@/lib/db')
    const { DEAD_SHOPPING_WEBHOOK_WHERE, buildDeadShoppingWebhookReplayWhere, buildDeadShoppingWebhookReplayData } =
      await import('@/lib/domain/shopping-webhook-exception')
    const ids: string[] = []
    try {
      for (const connector of ['woocommerce', `archived-${randomUUID().slice(0, 8)}`]) {
        const hash = `dead-${randomUUID()}`
        const row = await db.shoppingWebhookEvent.create({
          data: {
            connector, resource: 'orders', externalEventId: hash, topic: 'order.created', payloadHash: hash,
            payloadJson: {}, originAttestation: 'unproven:not-applicable', status: 'DEAD_LETTER', attempts: 24,
          },
        })
        ids.push(row.id)
      }
      // a row that is PROCESSED, or that was processed before being dead-lettered, is not replayable
      const processedId = (await db.shoppingWebhookEvent.create({
        data: {
          connector: 'woocommerce', resource: 'orders', externalEventId: `p-${randomUUID()}`, topic: 'order.created',
          payloadHash: `p-${randomUUID()}`, payloadJson: {}, originAttestation: 'unproven:not-applicable', status: 'PROCESSED', attempts: 1,
        },
      })).id
      const everProcessedId = (await db.shoppingWebhookEvent.create({
        data: {
          connector: 'woocommerce', resource: 'orders', externalEventId: `q-${randomUUID()}`, topic: 'order.created',
          payloadHash: `q-${randomUUID()}`, payloadJson: {}, originAttestation: 'unproven:not-applicable', status: 'DEAD_LETTER', attempts: 1,
          processedAt: new Date(),
        },
      })).id
      ids.push(processedId, everProcessedId)
      for (const blocked of [processedId, everProcessedId]) {
        const attempt = await db.shoppingWebhookEvent.updateMany({
          where: buildDeadShoppingWebhookReplayWhere(blocked), data: buildDeadShoppingWebhookReplayData(),
        })
        assert.equal(attempt.count, 0, 'only a dead letter that was never processed can be replayed')
      }
      const listed = await db.shoppingWebhookEvent.findMany({ where: { ...DEAD_SHOPPING_WEBHOOK_WHERE, id: { in: ids } } })
      assert.deepEqual(listed.map((row) => row.id).sort(), [ids[0], everProcessedId].sort())
      const archived = await db.shoppingWebhookEvent.updateMany({
        where: buildDeadShoppingWebhookReplayWhere(ids[1]), data: buildDeadShoppingWebhookReplayData(),
      })
      assert.equal(archived.count, 0, 'an archived connector row must not be re-queued: nothing would drain it')
    } finally {
      await db.shoppingWebhookEvent.deleteMany({ where: { id: { in: ids } } })
      await db.$disconnect()
    }
  },
)
