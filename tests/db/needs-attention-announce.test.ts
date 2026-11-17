import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE NEEDS-ATTENTION ANNOUNCER AGAINST A REAL DATABASE: the open-row predicate, the unique-key claim and the
 * transactional notification insert, using the paused-receipt category (the simplest source table). GATED on
 * RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/needs-attention-announce.test.ts would have been skipped')
}

const WMS = 'na-test-wms'
const TITLE = 'Warehouse receipt paused for review'

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { announceNeedsAttention } = await import('@/lib/domain/needs-attention/announce')
  const user = await db.user.create({ data: { email: `na-${randomUUID()}@example.test`, name: 'na', passwordHash: 'x', role: 'ADMIN' } })
  const deps = {
    db,
    activeAccountingConnector: async () => null,
    activeWmsConnector: async () => WMS,
  } as unknown as Parameters<typeof announceNeedsAttention>[0]
  const sent = () => db.notification.count({ where: { userId: user.id, title: TITLE } })
  const event = (suffix: string, processingStatus = 'REQUIRES_REVIEW') => ({
    connector: WMS, externalEventId: `na-${suffix}`, payload: {}, processingStatus,
  })
  const clean = async () => {
    await db.wmsInboundReceiptEvent.deleteMany({ where: { connector: WMS } })
    await db.needsAttentionAnnouncement.deleteMany({ where: { category: 'receiptReviews' } })
    await db.notification.deleteMany({ where: { userId: user.id } })
    await db.user.delete({ where: { id: user.id } })
  }
  return { db, deps, announceNeedsAttention, user, sent, event, clean }
}

test('only paused, unprocessed receipts of the enabled connector are announced; once each', { skip }, async (t) => {
  const { db, deps, announceNeedsAttention, sent, event, clean } = await setup()
  t.after(clean)
  await db.wmsInboundReceiptEvent.createMany({ data: [event('open1'), event('open2'), event('done', 'PROCESSED'), { ...event('other'), connector: 'na-test-other' }] })
  t.after(() => db.wmsInboundReceiptEvent.deleteMany({ where: { connector: 'na-test-other' } }))
  await announceNeedsAttention(deps)
  const rows = await db.needsAttentionAnnouncement.findMany({ where: { category: 'receiptReviews' } })
  assert.equal(rows.length, 2)
  assert.equal(await sent(), 1, 'one notification for two rows')
  await announceNeedsAttention(deps)
  assert.equal(await sent(), 1, 'nothing new, nothing sent')
})

test('cleared then re-failed is announced again; concurrent passes announce exactly once', { skip }, async (t) => {
  const { db, deps, announceNeedsAttention, sent, event, clean } = await setup()
  t.after(clean)
  await db.wmsInboundReceiptEvent.create({ data: event('flap') })
  await Promise.all([announceNeedsAttention(deps), announceNeedsAttention(deps), announceNeedsAttention(deps)])
  assert.equal(await sent(), 1, 'concurrent passes: exactly once')
  await db.wmsInboundReceiptEvent.updateMany({ where: { connector: WMS }, data: { processingStatus: 'PROCESSED', processedAt: new Date() } })
  await announceNeedsAttention(deps)
  assert.equal(await db.needsAttentionAnnouncement.count({ where: { category: 'receiptReviews' } }), 0, 'cleared row forgotten')
  await db.wmsInboundReceiptEvent.updateMany({ where: { connector: WMS }, data: { processingStatus: 'REQUIRES_REVIEW', processedAt: null } })
  await announceNeedsAttention(deps)
  assert.equal(await sent(), 2, 're-failure announced again')
})

test('5,001 announced rows do not block a new failure', { skip }, async (t) => {
  const { db, deps, announceNeedsAttention, sent, event, clean } = await setup()
  t.after(clean)
  await db.wmsInboundReceiptEvent.createMany({ data: Array.from({ length: 5001 }, (_, i) => event(`bulk${String(i).padStart(5, '0')}`)) })
  for (let i = 0; i < 27; i += 1) await announceNeedsAttention(deps)
  assert.equal(await db.needsAttentionAnnouncement.count({ where: { category: 'receiptReviews' } }), 5001)
  const before = await sent()
  await db.wmsInboundReceiptEvent.create({ data: event('zzz-new') })
  await announceNeedsAttention(deps)
  assert.equal(await sent(), before + 1)
  assert.equal(await db.needsAttentionAnnouncement.count({ where: { category: 'receiptReviews' } }), 5002)
})
