import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE PERIOD UNREALISED-FX REVALUATION IS RETIRED FOR XERO.
 *
 * Xero revalues open foreign-currency invoices, bills and bank balances itself (its Unrealised Currency Gains and Bank Revaluation system
 * accounts), so the cron route no longer runs the IMS sweep. It still authenticates, then answers a successful, named skip and touches
 * nothing: no database read, no rate lookup, no enqueue.
 *
 * The database, the enqueue facade and the sweep itself are replaced by doubles that THROW, so any touch fails the test rather than
 * passing quietly. [mutation: call runArApFxRevaluation from the route again (the sweep double throws); answer success: false (status is
 * not 200 / outcome failed); drop the reason]
 */

const touched: string[] = []
const trap = (what: string) => () => { touched.push(what); throw new Error(`the retired FX revaluation cron touched ${what}`) }

mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' && prop !== 'then' ? new Proxy(trap(`db.${prop}`), { get: (_f, p2) => trap(`db.${String(prop)}.${String(p2)}`) }) : undefined) }),
  },
})
mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: trap('getAccountingSettings'),
    queueAccountingSyncTxWithOutcome: trap('queueAccountingSyncTxWithOutcome'),
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: trap('getBaseCurrencyCode'), resolveBaseCurrencyCode: trap('resolveBaseCurrencyCode') } })

test('the FX revaluation cron answers a successful, named skip and reads, queues and posts NOTHING', async () => {
  const { GET } = await import('@/app/api/cron/accounting-fx-revaluation/route')
  const { UNREALISED_FX_REVALUATION_RETIRED_REASON } = await import('@/lib/accounting-fx-revaluation')
  const res = await GET(new Request('http://localhost/api/cron/accounting-fx-revaluation?date=2026-11-20'))
  const body = await res.json() as Record<string, unknown>
  assert.deepEqual(touched, [], 'nothing was read or queued')
  assert.equal(res.status, 200)
  assert.equal(body.success, true)
  assert.equal(body.skipped, true)
  assert.equal(body.reason, UNREALISED_FX_REVALUATION_RETIRED_REASON)
  assert.match(String(body.reason), /Xero revalues open foreign-currency invoices, bills and bank balances itself/)
  assert.equal(body.valuationDate, '2026-11-20')
  for (const count of ['reversed', 'revalued', 'documents', 'refused'] as const) assert.equal(body[count], 0, count)
  assert.deepEqual(body.skippedNoRate, [])
  assert.deepEqual(body.withheldSides, [])
})

test('a malformed ?date= is not an error any more: nothing is valued, so the run still skips cleanly', async () => {
  const { GET } = await import('@/app/api/cron/accounting-fx-revaluation/route')
  const res = await GET(new Request('http://localhost/api/cron/accounting-fx-revaluation?date=not-a-date'))
  const body = await res.json() as Record<string, unknown>
  assert.deepEqual(touched, [])
  assert.equal(res.status, 200)
  assert.equal(body.skipped, true)
  assert.match(String(body.valuationDate), /^\d{4}-\d{2}-\d{2}$/)
})

test('the retired result classifies as a skip, never a failure (a cron still pointing here raises no alert)', async () => {
  const { retiredArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')
  const { cronOutcome } = await import('@/lib/ops/cron-outcomes')
  assert.notEqual(cronOutcome('accounting-fx-revaluation', retiredArApFxRevaluation()), 'failed')
})
