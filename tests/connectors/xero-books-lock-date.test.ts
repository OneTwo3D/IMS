import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// Books lock date import: the later of PeriodLockDate / EndOfYearLockDate, read-only GET, never throws,
// falls back to the stored value, and stores nothing when the read fails.

type Reply = { ok: boolean; status: number; data?: unknown; error?: string } | Error
let reply: Reply = { ok: true, status: 200, data: {} }
const getPaths: string[] = []
const upserts: Array<{ key: string; value: string }> = []
const activity: Array<{ action: string; level: string }> = []

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => {
      getPaths.push(path)
      if (reply instanceof Error) throw reply
      return reply
    },
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: { setting: { upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => { upserts.push({ key: where.key, value: create.value }) } } },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: { action: string; level: string }) => { activity.push(entry) } },
})

const loaded = import('@/lib/connectors/xero/books-lock-date')

function reset(next: Reply) {
  reply = next
  getPaths.length = 0
  upserts.length = 0
  activity.length = 0
}
const org = (organisation: Record<string, string | null>) => ({ ok: true, status: 200, data: { Organisations: [organisation] } })

test('the later of the two lock dates is the effective one, read with a plain GET /Organisation', async () => {
  const { refreshXeroBooksLockDate } = await loaded
  reset(org({ PeriodLockDate: '/Date(1774915200000+0000)/', EndOfYearLockDate: '2026-06-30T00:00:00' }))
  const result = await refreshXeroBooksLockDate('')
  assert.deepEqual(getPaths, ['Organisation'])
  assert.deepEqual(result, { lockDate: '2026-06-30', refreshed: true })
  assert.equal(upserts.find((u) => u.key === 'xero_books_lock_date')?.value, '2026-06-30')
  assert.ok(upserts.find((u) => u.key === 'xero_books_lock_date_read_at')?.value)
})

test('either date alone is used', async () => {
  const { effectiveLockDateOf } = await loaded
  assert.equal(effectiveLockDateOf({ PeriodLockDate: '2026-03-31T00:00:00' }), '2026-03-31')
  assert.equal(effectiveLockDateOf({ EndOfYearLockDate: '2025-12-31T00:00:00' }), '2025-12-31')
})

test('no lock date in Xero clears the stored one (a lifted lock is not kept)', async () => {
  const { refreshXeroBooksLockDate } = await loaded
  reset(org({}))
  const result = await refreshXeroBooksLockDate('2026-03-31')
  assert.deepEqual(result, { lockDate: null, refreshed: true })
  assert.equal(upserts.find((u) => u.key === 'xero_books_lock_date')?.value, '')
})

test('a failed read keeps the last stored value, stores nothing and logs a WARNING', async () => {
  const { refreshXeroBooksLockDate } = await loaded
  reset({ ok: false, status: 503, error: 'down' })
  assert.deepEqual(await refreshXeroBooksLockDate('2026-03-31'), { lockDate: '2026-03-31', refreshed: false })
  assert.equal(upserts.length, 0)
  assert.deepEqual(activity.map((a) => [a.action, a.level]), [['xero_books_lock_date_read_failed', 'WARNING']])
})

test('a thrown read, or an unreadable stored value, never throws and never invents a date', async () => {
  const { refreshXeroBooksLockDate } = await loaded
  reset(new Error('not connected'))
  assert.deepEqual(await refreshXeroBooksLockDate(undefined), { lockDate: null, refreshed: false })
  reset(new Error('boom'))
  assert.deepEqual(await refreshXeroBooksLockDate('garbage'), { lockDate: null, refreshed: false })
})

test('the lock date is not part of the settings save allowlist, so the form cannot write it', async () => {
  const { XERO_SETTING_KEYS } = await import('@/lib/connectors/xero/settings')
  assert.ok(!XERO_SETTING_KEYS.includes('xero_books_lock_date'))
  assert.ok(!XERO_SETTING_KEYS.includes('xero_books_lock_date_read_at'))
})

test('the settings screen line is read-only text naming the date and when it was read', async () => {
  const { describeBooksLockDate } = await import('@/app/(dashboard)/sync/xero-client')
  const fmt = (value: Date | string) => `T(${String(value)})`
  assert.equal(describeBooksLockDate('2026-03-31', '2026-11-16T02:00:00.000Z', fmt), 'Books locked up to 2026-03-31 (read from Xero T(2026-11-16T02:00:00.000Z)).')
  assert.match(describeBooksLockDate('', '2026-11-16T02:00:00.000Z', fmt), /^No books lock date set in Xero/)
  assert.match(describeBooksLockDate('', '', fmt), /not read from Xero yet/)
})
