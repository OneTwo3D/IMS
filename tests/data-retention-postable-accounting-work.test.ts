import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { POSTABLE_ACCOUNTING_SYNC_STATUSES } from '@/lib/domain/accounting/postable-sync-statuses'

/**
 * o3d-nepa / o3d-y14, Codex round 1 finding 2. RETENTION COULD DELETE A CLAIMED JOB, DEFEATING THE
 * LIVE-ROW COUNT.
 *
 * `purgeExpiredData` hard-deleted accounting sync logs by AGE ALONE, explicitly including
 * PROCESSING rows. The coupon backfill's fence counts live SALES_INVOICE rows under the order lock
 * and declines to correct an order that has any — which is only meaningful if the row's existence
 * tracks the worker's ability to post:
 *
 *      worker                          retention                    backfill
 *      ------                          ---------                    --------
 *      claim old job, read payload
 *                                      delete it (older than cutoff)
 *                                                                   LOCK order
 *                                                                   count live rows -> 0
 *                                                                   correct + STAMP as fixed
 *      post the in-memory payload
 *      -> remote write happened; its status update fails; nothing records the document.
 *
 * The same count backs the sales-order hard-delete guard, and o3d-ju8t established that FAILED does
 * not prove nothing was posted. So the exemption covers every status a document can still be posted
 * from, keyed on the SHARED constant both readers use — the sets drifting apart is how the hole
 * reopens silently.
 *
 * The `deleteMany` double below EVALUATES the predicate against a row store instead of capturing
 * arguments. A double that only recorded the `where` object could not tell an exemption that works
 * from one whose statuses are spelled slightly differently.
 */

type SyncRow = { id: string; createdAt: Date; status: string; externalTransactionId?: string | null }

const store = {
  settingRows: [] as Array<{ key: string; value: string }>,
  accounting: [] as SyncRow[],
}

function noopDelegate() {
  return {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 0 }),
    findMany: async () => [],
  }
}

function matches(row: SyncRow, where: { createdAt?: { lt: Date }; status?: { notIn?: string[]; in?: string[] } }): boolean {
  if (where.createdAt && !(row.createdAt.getTime() < where.createdAt.lt.getTime())) return false
  if (where.status?.notIn && where.status.notIn.includes(row.status)) return false
  if (where.status?.in && !where.status.in.includes(row.status)) return false
  return true
}

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findMany: async () => store.settingRows },
      shoppingSyncLog: noopDelegate(),
      accountingSyncLog: {
        ...noopDelegate(),
        deleteMany: async ({ where }: { where: Parameters<typeof matches>[1] }) => {
          const survivors = store.accounting.filter((row) => !matches(row, where))
          const deleted = store.accounting.length - survivors.length
          store.accounting = survivors
          return { count: deleted }
        },
        count: async ({ where }: { where: { status: { in: string[] } } }) =>
          store.accounting.filter((row) => where.status.in.includes(row.status)).length,
      },
      stockMovement: noopDelegate(),
      cogsEntry: noopDelegate(),
      costLayer: noopDelegate(),
      salesOrder: noopDelegate(),
      purchaseOrder: noopDelegate(),
      customer: noopDelegate(),
      shoppingWebhookEvent: noopDelegate(),
    },
  },
})

async function loadPurge() {
  return (await import('@/lib/data-retention')).purgeExpiredData
}

const OLD = new Date('2020-01-01T00:00:00.000Z')

function seed() {
  store.settingRows = [{ key: 'retention_sync_logs_months', value: '6' }]
  store.accounting = [
    { id: 'pending', createdAt: OLD, status: 'PENDING' },
    { id: 'processing', createdAt: OLD, status: 'PROCESSING' },
    { id: 'failed', createdAt: OLD, status: 'FAILED' },
    { id: 'synced', createdAt: OLD, status: 'SYNCED', externalTransactionId: 'XERO-1' },
    { id: 'cancelled', createdAt: OLD, status: 'CANCELLED' },
  ]
}

test('expired work that can STILL BE POSTED survives the purge (Codex r1 F2)', async () => {
  const purgeExpiredData = await loadPurge()
  seed()

  await purgeExpiredData()

  assert.deepEqual(
    store.accounting.map((row) => row.id).sort(),
    ['failed', 'pending', 'processing'],
    'PENDING/PROCESSING/FAILED are unfinished jobs, not history',
  )
})

test('settled work is still expired by age — the exemption is not a blanket one (Codex r1 F2)', async () => {
  // Without this, "never delete anything" would pass the test above and quietly disable retention.
  const purgeExpiredData = await loadPurge()
  seed()

  const result = await purgeExpiredData()

  assert.equal(result.syncLogsDeleted, 2, 'SYNCED and CANCELLED still expire')
  assert.ok(!store.accounting.some((row) => row.id === 'synced'))
  assert.ok(!store.accounting.some((row) => row.id === 'cancelled'))
})

test('a PROCESSING row an operator later resolves DOES expire afterwards (Codex r1 F2)', async () => {
  // The exemption is about postability, not about age: a row leaves it the moment it settles, so
  // this does not grow without bound and does not need a second clock.
  const purgeExpiredData = await loadPurge()
  seed()

  await purgeExpiredData()
  const claimed = store.accounting.find((row) => row.id === 'processing')
  assert.ok(claimed)
  claimed.status = 'SYNCED'
  await purgeExpiredData()

  assert.ok(!store.accounting.some((row) => row.id === 'processing'))
})

test('a young live row is untouched regardless — the cutoff still applies', async () => {
  const purgeExpiredData = await loadPurge()
  seed()
  store.accounting.push({ id: 'fresh-synced', createdAt: new Date(), status: 'SYNCED' })

  await purgeExpiredData()

  assert.ok(store.accounting.some((row) => row.id === 'fresh-synced'))
})

test('the claim -> retention -> backfill interleaving no longer reads zero (Codex r1 F2)', async () => {
  // The whole failure, in order. A worker claims an old invoice job and reads its payload;
  // retention runs; the backfill then counts live rows under the order lock. If the row is gone the
  // count is zero, the order is corrected and STAMPED, and the worker still posts the old payload.
  const purgeExpiredData = await loadPurge()
  const { db } = await import('@/lib/db')
  seed()
  store.accounting = [{ id: 'invoice-job', createdAt: OLD, status: 'PENDING' }]

  // 1. the worker claims it and holds the payload in memory
  const claimed = store.accounting[0]
  claimed.status = 'PROCESSING'
  const heldPayload = { discountAmount: 10 }

  // 2. retention runs
  await purgeExpiredData()

  // 3. the backfill counts what the fence counts
  const liveJobs = await db.accountingSyncLog.count({
    where: { status: { in: [...POSTABLE_ACCOUNTING_SYNC_STATUSES] } },
  })

  assert.equal(liveJobs, 1, 'the worker that can still post is still visible, so the fence declines')
  assert.equal(heldPayload.discountAmount, 10, 'and that payload is exactly what it would have posted')
})

test('the exemption uses the SAME constant the coupon backfill counts on (Codex r1 F2)', async () => {
  // Two independent spellings of this set is how the hole reopens: retention would delete a status
  // the fence still counts, and nothing would fail.
  const { LIVE_SALES_INVOICE_STATUSES } = await import(
    '@/lib/connectors/woocommerce/sync/coupon-discount-backfill'
  )

  assert.deepEqual([...LIVE_SALES_INVOICE_STATUSES], [...POSTABLE_ACCOUNTING_SYNC_STATUSES])

  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(process.cwd(), 'lib/data-retention.ts'), 'utf8')
  assert.match(src, /POSTABLE_ACCOUNTING_SYNC_STATUSES/, 'retention imports it rather than restating it')
  assert.doesNotMatch(
    src.slice(src.indexOf('db.accountingSyncLog.deleteMany'), src.indexOf('syncLogsDeleted = wc.count')),
    /'PROCESSING'/,
    'and does not spell the statuses out locally',
  )
})
