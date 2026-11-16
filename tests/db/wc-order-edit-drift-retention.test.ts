import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/** An OPEN order-edit-drift row (o3d-hqvrp.84) is never aged out by retention; an unstamped or resolved look-alike is. Real Postgres, real `purgeExpiredData`. */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

test('retention keeps an open edit-drift row of any age and still purges its look-alikes', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('../../lib/db/index.ts')
  const { purgeExpiredData } = await import('../../lib/data-retention.ts')
  const tag = randomUUID()
  const old = new Date(Date.now() - 5 * 365 * 24 * 3600 * 1000)
  const ids = { open: `EDR-open-${tag}`, resolved: `EDR-resolved-${tag}`, unstamped: `EDR-unstamped-${tag}`, plain: `EDR-plain-${tag}` }
  t.after(() => db.shoppingSyncLog.deleteMany({ where: { externalId: { in: Object.values(ids) } } }))
  const base = { connector: 'woocommerce', direction: 'FROM_CONNECTOR' as const, createdAt: old }
  await db.shoppingSyncLog.createMany({
    data: [
      { ...base, externalId: ids.open, entityType: 'SalesOrderEdit', recordKind: 'wc_order_edit_drift', status: 'QUARANTINED', entityId: `o-${tag}` },
      { ...base, externalId: ids.resolved, entityType: 'SalesOrderEdit', recordKind: 'wc_order_edit_drift', status: 'SYNCED', entityId: `o-${tag}` },
      { ...base, externalId: ids.unstamped, entityType: 'SalesOrderEdit', status: 'QUARANTINED', entityId: `o-${tag}` },
      { ...base, externalId: ids.plain, entityType: 'SalesOrder', status: 'SYNCED' },
    ],
  })
  await purgeExpiredData()
  const left = new Set((await db.shoppingSyncLog.findMany({ where: { externalId: { in: Object.values(ids) } }, select: { externalId: true } })).map((r) => r.externalId))
  assert.equal(left.has(ids.plain), false, 'CONTROL: an ordinary old row is purged, so the sweep ran')
  assert.equal(left.has(ids.open), true, 'an open edit-drift row survives')
  assert.equal(left.has(ids.resolved), false)
  assert.equal(left.has(ids.unstamped), false, 'an unstamped row is not protected (the exemption is total, not three-valued)')
})
