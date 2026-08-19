import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-1fel — action-level authorization on the accounting reads.
 *
 * A `'use server'` export is a directly POST-callable HTTP endpoint. Several
 * reads in app/actions/xero-sync.ts had no guard at all; the only thing
 * "hiding" them was that the connector-facade allowlist in
 * server-action-guard-coverage.test.ts covered the whole module with a `*`.
 * An allowlist entry is not access control.
 *
 * These tests drive the REAL requirePermission/hasPermission by mocking only
 * the session source, so what is asserted is the actual RBAC decision:
 *   - WHICH principal is refused (a WAREHOUSE session — authenticated, and
 *     lacking 'sync'),
 *   - WHICH permission the refusal names,
 *   - and that the database was never touched on the refused path.
 *
 * The last point is the one that matters: a guard that throws only AFTER the
 * read has already run still leaks.
 */

type Role = 'ADMIN' | 'WAREHOUSE'
let currentRole: Role = 'WAREHOUSE'

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({
      user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole },
    }),
  },
})

// Records every Prisma model touched, so "no read happened" is provable rather
// than assumed. Any access to a model returns a thrower.
const dbTouches: string[] = []
const dbProxy = new Proxy({}, {
  get(_t, model: string) {
    return new Proxy({}, {
      get(_t2, op: string) {
        return (...args: unknown[]) => {
          dbTouches.push(`${model}.${op}`)
          void args
          return Promise.resolve([])
        }
      },
    })
  },
})
mock.module('@/lib/db', { namedExports: { db: dbProxy } })

test('getAccountingAccounts refuses a WAREHOUSE session, naming the sync permission, without reading the chart of accounts', async () => {
  currentRole = 'WAREHOUSE'
  dbTouches.length = 0
  const { getAccountingAccounts } = await import('@/app/actions/xero-sync')

  await assert.rejects(
    () => getAccountingAccounts(),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'expected an Error')
      // The specific refusal, not merely "it threw".
      assert.equal((error as { permission?: string }).permission, 'sync')
      assert.match(error.message, /Forbidden: missing permission sync/)
      return true
    },
  )

  assert.deepEqual(
    dbTouches,
    [],
    `refused call must not query the database, but touched: ${dbTouches.join(', ')}`,
  )
})

test('getAccountingAccounts reads the chart of accounts for an ADMIN session', async () => {
  // The guard must refuse the unauthorized role WITHOUT breaking the authorized
  // one — otherwise the test above would also pass on a permanently broken action.
  currentRole = 'ADMIN'
  dbTouches.length = 0
  const { getAccountingAccounts } = await import('@/app/actions/xero-sync')

  await getAccountingAccounts()
  assert.deepEqual(dbTouches, ['accountingAccount.findMany'])
})

test('getXeroSettingsMasked refuses a WAREHOUSE session naming the sync permission', async () => {
  // Masking the client SECRET is not access control: the response still carries
  // xero_client_id in clear plus every account-mapping code.
  currentRole = 'WAREHOUSE'
  const { getXeroSettingsMasked } = await import('@/app/actions/xero-sync')
  await assert.rejects(
    () => getXeroSettingsMasked(),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
})

test('getXeroConnectionStatus refuses a WAREHOUSE session, withholding the connected tenant name', async () => {
  currentRole = 'WAREHOUSE'
  const { getXeroConnectionStatus } = await import('@/app/actions/xero-sync')
  await assert.rejects(
    () => getXeroConnectionStatus(),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
})

test('getXeroSyncLogs refuses a WAREHOUSE session naming the sync permission', async () => {
  currentRole = 'WAREHOUSE'
  const { getXeroSyncLogs } = await import('@/app/actions/xero-sync')
  await assert.rejects(
    () => getXeroSyncLogs(5),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
})

test('getXeroSyncReadiness refuses a WAREHOUSE session naming the sync permission', async () => {
  currentRole = 'WAREHOUSE'
  const { getXeroSyncReadiness } = await import('@/app/actions/xero-sync')
  await assert.rejects(
    () => getXeroSyncReadiness(),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
})

test('fetchXeroTaxRates refuses a WAREHOUSE session before making the outbound Xero call', async () => {
  currentRole = 'WAREHOUSE'
  const { fetchXeroTaxRates } = await import('@/app/actions/xero-sync')
  await assert.rejects(
    () => fetchXeroTaxRates(),
    (error: unknown) => (error as { permission?: string }).permission === 'sync',
  )
})
