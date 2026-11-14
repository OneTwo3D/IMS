import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * A PENDING ADMISSION-REFUSAL ROW IS NEVER DELETED BY RETENTION, PROVEN AGAINST A REAL POSTGRES.
 *
 * An order IMS refused (excluded status, no currency) or blocked behind a guard (unmapped tax rate, a coupon
 * that does not reconcile) is recorded ONLY in this queue row, and the pull cursors have moved past it. The row
 * carries no entityId (the order does not exist in IMS), so the entityId-keyed protection does not cover it,
 * and the drain keeps it young only while sync runs. With sync off for longer than the retention window an
 * age-only sweep deleted the row, and the order was gone for good.
 *
 * This runs the REAL `purgeExpiredData` and then reads the probe rows back. Each row is seeded with a unique
 * externalId and removed afterwards, so it touches nothing else's rows.
 *
 *   * a PENDING blocked-order row, five years old      -> survives
 *   * a PENDING status-refusal row, five years old     -> survives (the pre-existing reasons too)
 *   * a SYNCED (resolved) admission row, five years old -> purged as before
 *   * an ordinary old SYNCED row                        -> purged as before (so the sweep demonstrably ran)
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
}

test('retention keeps every PENDING admission-refusal row and purges a resolved one as before', { skip }, async (t) => {
  loadEnv()
  const { db } = await import('../../lib/db/index.ts')
  const { purgeExpiredData } = await import('../../lib/data-retention.ts')
  const tag = randomUUID()
  const old = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000)
  const ids = { blocked: `ARR-blocked-${tag}`, status: `ARR-status-${tag}`, resolved: `ARR-resolved-${tag}`, plain: `ARR-plain-${tag}` }
  t.after(() => db.shoppingSyncLog.deleteMany({ where: { externalId: { in: Object.values(ids) } } }))

  const base = { connector: 'woocommerce', direction: 'FROM_CONNECTOR' as const, entityType: 'SalesOrder', createdAt: old }
  const refusal = (externalId: string, reason: string) => ({
    queue: 'wc_order_admission_refusal', reason, connector: 'woocommerce', externalOrderId: externalId,
    externalOrderNumber: '1', status: 'processing', configured: [], refusedAt: old.toISOString(), attempts: 0,
  })
  await db.shoppingSyncLog.createMany({
    data: [
      { ...base, externalId: ids.blocked, status: 'PENDING', payload: refusal(ids.blocked, 'tax_rate_unmapped') },
      { ...base, externalId: ids.status, status: 'PENDING', payload: refusal(ids.status, 'status_not_admitted') },
      { ...base, externalId: ids.resolved, status: 'SYNCED', payload: refusal(ids.resolved, 'tax_rate_unmapped') },
      { ...base, externalId: ids.plain, status: 'SYNCED', payload: { id: 1 } },
    ],
  })
  // The probe rows have the age under test, not just a createdAt default.
  assert.equal(await db.shoppingSyncLog.count({ where: { externalId: { in: Object.values(ids) }, createdAt: { lt: new Date(Date.now() - 4 * 365 * 24 * 3600 * 1000) } } }), 4)

  await purgeExpiredData()

  const left = new Set((await db.shoppingSyncLog.findMany({ where: { externalId: { in: Object.values(ids) } }, select: { externalId: true } })).map((row) => row.externalId))
  assert.equal(left.has(ids.plain), false, 'CONTROL: an ordinary old resolved row is purged, so the sweep ran and reached these rows')
  assert.equal(left.has(ids.resolved), false, 'a RESOLVED admission row expires by age as before')
  assert.equal(left.has(ids.blocked), true, 'a PENDING blocked-order row is the order\'s only record and is never purged')
  assert.equal(left.has(ids.status), true, 'and neither is a PENDING row of the pre-existing reasons')
})
