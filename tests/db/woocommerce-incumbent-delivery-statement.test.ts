import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE STATEMENT THE PRE-CUTOVER VERIFICATION RUNS, AGAINST A REAL POSTGRES.
 *
 * What is asserted is which stored deliveries a JSON-path predicate selects (`payloadJson -> id = <number>`), a property of
 * Postgres and not of anything IMS computes: a mocked `findFirst` can only show the object handed to Prisma. Seeds its own
 * rows (stamped with a UUID so nothing else is touched), reads through the REAL `incumbentDeliveryWhere`, removes them.
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/woocommerce-incumbent-delivery-statement.test.ts would have been skipped.')
}

test('the statement selects the latest PROCESSED ORDER delivery of THIS id received since the despatch, and nothing else', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const [{ db }, { incumbentDeliveryWhere, classifyStoredWcOrderDelivery }] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/woocommerce/sync/incumbent-partial-shipment.ts'),
  ])
  const stamp = `incumbent-${randomUUID()}`
  const wcId = 9_000_000 + Math.floor(Math.random() * 900_000)
  t.after(() => db.shoppingWebhookEvent.deleteMany({ where: { payloadHash: { startsWith: stamp } } }))
  const at = (iso: string) => new Date(iso)
  const row = (suffix: string, over: { resource?: string; status?: string; receivedAt: Date; payload: Record<string, unknown> }) => db.shoppingWebhookEvent.create({
    data: {
      connector: 'woocommerce', resource: over.resource ?? 'orders', payloadHash: `${stamp}-${suffix}`, payloadJson: over.payload as never,
      status: over.status ?? 'PROCESSED', receivedAt: over.receivedAt,
    },
  })
  await db.$transaction([
    row('old', { receivedAt: at('2026-05-10T00:00:00Z'), payload: { id: wcId, status: 'processing' } }),
    row('partial', { receivedAt: at('2026-05-21T00:00:00Z'), payload: { id: wcId, status: 'partial-shipped' } }),
    row('latest', { receivedAt: at('2026-05-25T00:00:00Z'), payload: { id: wcId, status: 'completed' } }),
    row('other-order', { receivedAt: at('2026-05-26T00:00:00Z'), payload: { id: wcId + 1, status: 'cancelled' } }),
    row('product', { resource: 'products', receivedAt: at('2026-05-27T00:00:00Z'), payload: { id: wcId, status: 'draft' } }),
    row('pending', { status: 'PENDING', receivedAt: at('2026-05-28T00:00:00Z'), payload: { id: wcId, status: 'cancelled' } }),
  ])
  const despatch = at('2026-05-20T00:00:00Z')
  const latest = await db.shoppingWebhookEvent.findFirst({ where: incumbentDeliveryWhere(wcId, despatch), orderBy: { receivedAt: 'desc' }, select: { receivedAt: true, payloadJson: true } })
  console.log(`# incumbent statement: latest=${JSON.stringify(latest)}`)
  assert.ok(latest, 'PRECONDITION: the statement finds the seeded delivery, so the exclusions below are not vacuous')
  assert.equal((latest.payloadJson as { status: string }).status, 'completed', 'the LATEST order delivery for this id; not the other order, not a product, not an unprocessed one')
  assert.equal(classifyStoredWcOrderDelivery({ receivedAt: latest.receivedAt, status: (latest.payloadJson as { status: string }).status }, despatch).verified, true)
  // received since the despatch: a despatch after every stored delivery finds none
  assert.equal(await db.shoppingWebhookEvent.findFirst({ where: incumbentDeliveryWhere(wcId, at('2026-06-01T00:00:00Z')) }), null)
  // an id nobody stored
  assert.equal(await db.shoppingWebhookEvent.findFirst({ where: incumbentDeliveryWhere(wcId + 5, despatch) }), null)
})
