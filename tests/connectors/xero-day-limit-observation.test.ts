import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DAY_LIMIT_OBSERVATION_FRESH_MS,
  organisationDayCallsRemaining,
  persistDayLimitObservation,
  resetDayLimitPersistThrottleForTests,
  sharedDayCallsRemaining,
} from '@/lib/connectors/xero/day-limit-observation'

/**
 * o3d-hvzdx: the organisation's Xero day allowance, shared between workers. No database: the raw client is a double that records the SQL and
 * answers what a table holding the given rows would. The database half (and the cross-worker race) is in
 * tests/concurrency/invoice-document-on-demand.concurrent.test.ts.
 */

type Row = { tenant: string; remaining: number; at: number }

function fakeClient(rows: Row[] = [], opts: { failRead?: boolean; failWrite?: boolean } = {}) {
  const writes: Array<{ tenant: string; remaining: number; at: Date }> = []
  return {
    writes,
    client: {
      $executeRaw: async (_q: TemplateStringsArray, ...values: unknown[]) => {
        if (opts.failWrite) throw new Error('db down')
        writes.push({ tenant: values[0] as string, remaining: values[1] as number, at: values[2] as Date })
        return 1
      },
      $queryRaw: async <T,>(_q: TemplateStringsArray, ...values: unknown[]) => {
        if (opts.failRead) throw new Error('db down')
        const since = (values[0] as Date).getTime()
        const fresh = rows.filter((row) => row.at >= since).map((row) => row.remaining)
        return [{ remaining: fresh.length === 0 ? null : Math.min(...fresh) }] as T
      },
    },
  }
}

test('the shared figure is the LOWEST fresh observation; stale ones are ignored; none fresh is null', async () => {
  const now = Date.now()
  const { client } = fakeClient([
    { tenant: 'a', remaining: 700, at: now - 60_000 },
    { tenant: 'b', remaining: 400, at: now - 5 * 60_000 },
    { tenant: 'c', remaining: 5, at: now - DAY_LIMIT_OBSERVATION_FRESH_MS - 1 },
  ])
  assert.equal(await sharedDayCallsRemaining(now, client), 400)
  assert.equal(await sharedDayCallsRemaining(now, fakeClient([{ tenant: 'c', remaining: 5, at: now - DAY_LIMIT_OBSERVATION_FRESH_MS - 1 }]).client), null)
})

test('a FRESH WORKER (no local figure) reads what the others saw; the lower of local and shared wins; nothing shared, or unreadable, is null (the caller waits)', async () => {
  const now = Date.now()
  const shared = fakeClient([{ tenant: 'a', remaining: 300, at: now - 1000 }]).client
  assert.equal(await organisationDayCallsRemaining(null, now, shared), 300, 'the bug: this used to be null and read as "go ahead"')
  assert.equal(await organisationDayCallsRemaining(800, now, shared), 300)
  assert.equal(await organisationDayCallsRemaining(100, now, shared), 100)
  assert.equal(await organisationDayCallsRemaining(800, now, fakeClient([]).client), null, 'a process\'s own figure alone is not taken as the organisation\'s')
  assert.equal(await organisationDayCallsRemaining(800, now, fakeClient([], { failRead: true }).client), null)
})

test('persisting is throttled per tenant, except when the figure is at the warning level; a failed write never throws', async () => {
  resetDayLimitPersistThrottleForTests()
  const t0 = 1_800_000_000_000
  const { client, writes } = fakeClient()
  assert.equal(await persistDayLimitObservation('t1', 900, t0, client), true)
  assert.equal(await persistDayLimitObservation('t1', 899, t0 + 1000, client), false, 'throttled')
  assert.equal(await persistDayLimitObservation('t2', 899, t0 + 1000, client), true, 'per tenant')
  assert.equal(await persistDayLimitObservation('t1', 90, t0 + 2000, client), true, 'a low figure is always shared')
  assert.equal(await persistDayLimitObservation('t1', 880, t0 + 20_000, client), true, 'after the interval')
  assert.deepEqual(writes.map((w) => [w.tenant, w.remaining]), [['t1', 900], ['t2', 899], ['t1', 90], ['t1', 880]])
  resetDayLimitPersistThrottleForTests()
  assert.equal(await persistDayLimitObservation('t1', 900, t0, fakeClient([], { failWrite: true }).client), false)
  assert.equal(await persistDayLimitObservation('', 900, t0, client), false)
})
