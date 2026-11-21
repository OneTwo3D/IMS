import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-hu8g9 follow-ups on the deferred-comparison drain, without a database: single flight, a failure that is reported, the failed-read cap that waits for the row's age, and the request abort.

const state: { locked: boolean; settingThrows: boolean; findManyArgs: Array<Record<string, unknown>>; txCalls: number; rows: Array<Record<string, unknown>> } = { locked: true, settingThrows: false, findManyArgs: [], txCalls: 0, rows: [] }
const tx = { $queryRaw: async () => [{ locked: state.locked }] }
const fakeDb = {
  $transaction: async (fn: (t: typeof tx) => Promise<unknown>, options?: { timeout?: number }) => { state.txCalls++; state.findManyArgs.push({ txOptions: options }); return fn(tx) },
  setting: { findUnique: async () => { if (state.settingThrows) throw new Error('db down'); return { value: 'true' } } },
  wcOrderDivergenceRecheck: {
    deleteMany: async () => ({ count: 0 }),
    updateMany: async () => ({ count: 1 }),
    findMany: async (args: Record<string, unknown>) => { state.findManyArgs.push(args); return args.orderBy ? state.rows : [] },
    count: async () => 0,
  },
}
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
// The transport the live read goes through (the seam is left unset in the tests that use it): records what it was called with.
const wcFetchCalls: Array<{ path: string; signal: AbortSignal | undefined }> = []
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, _params: unknown, _creds: unknown, options?: { signal?: AbortSignal }) => {
      wcFetchCalls.push({ path, signal: options?.signal })
      return new Promise<never>(() => undefined) // never answers: only the deadline ends the read
    },
  },
})

async function load() {
  return import('@/lib/connectors/woocommerce/sync/order-divergence')
}

test('single flight: a drain that does not get the lock does nothing and says it was busy', async () => {
  const div = await load()
  state.locked = false
  state.settingThrows = false
  state.findManyArgs = []
  const out = await div.drainDeferredWcOrderDivergences()
  assert.deepEqual(out, { examined: 0, resolved: 0, dropped: 0, busy: true })
  assert.equal(state.findManyArgs.filter((a) => a.where || a.orderBy).length, 0, 'no row was read or dropped')
})

test('a drain that fails is reported (failed: true) rather than only logged, and never throws', async () => {
  const div = await load()
  state.locked = true
  state.settingThrows = true
  const errors = mock.method(console, 'error', () => undefined)
  try {
    const out = await div.drainDeferredWcOrderDivergences()
    assert.equal(out.failed, true)
    assert.equal(out.busy, undefined)
  } finally { errors.mock.restore(); state.settingThrows = false }
})

test('the failed-read cap drops a row only once it has also waited 72 hours; the age cap and the attempt cap are unchanged', async () => {
  const div = await load()
  state.locked = true
  state.findManyArgs = []
  state.rows = []
  const before = Date.now()
  await div.drainDeferredWcOrderDivergences()
  const expiredQuery = state.findManyArgs.find((a) => a.where && !a.orderBy)!
  const or = (expiredQuery.where as { OR: Array<Record<string, unknown>> }).OR
  assert.equal(or.length, 3)
  assert.deepEqual(Object.keys(or[0]!), ['deferredAt'])
  assert.deepEqual(or[1], { attempts: { gte: div.RECHECK_MAX_ATTEMPTS } })
  const failed = or[2] as { failedReads: { gte: number }; deferredAt: { lt: Date } }
  assert.equal(failed.failedReads.gte, div.RECHECK_MAX_FAILED_READS)
  const cutoffAge = before - failed.deferredAt.lt.getTime()
  assert.ok(cutoffAge >= div.RECHECK_MIN_AGE_AT_FAILED_CAP_HOURS * 3_600_000 - 1_000 && cutoffAge < div.RECHECK_MIN_AGE_AT_FAILED_CAP_HOURS * 3_600_000 + 60_000, 'the row must have waited the minimum age')
  assert.equal(div.RECHECK_MIN_AGE_AT_FAILED_CAP_HOURS, 72)
})

test('a live read that outlives its timeout has its REQUEST aborted, not just abandoned', async () => {
  const div = await load()
  state.locked = true
  state.rows = [{ id: 'r1', orderId: 'o1', externalOrderId: '9', attempts: 0, failedReads: 0, fromRetry: false }]
  let seen: AbortSignal | undefined
  div.divergenceSeams.readLiveOrder = (_id, signal) => new Promise<never>(() => { seen = signal })
  try {
    const out = await div.drainDeferredWcOrderDivergences(25, { budgetMs: 2_000, readTimeoutMs: 50 })
    assert.equal(out.examined, 1)
    assert.ok(seen, 'the read was given a signal')
    assert.equal(seen!.aborted, true, 'aborted at the deadline')
  } finally { div.divergenceSeams.readLiveOrder = undefined; state.rows = [] }
})

test('the budget is checked before every new read, so rows that no longer fit are left for the next run', async () => {
  const div = await load()
  state.locked = true
  state.rows = ['r1', 'r2', 'r3'].map((id, i) => ({ id, orderId: `o${i}`, externalOrderId: String(i), attempts: 0, failedReads: 0, fromRetry: false }))
  const reads: string[] = []
  div.divergenceSeams.readLiveOrder = async (id) => { reads.push(id); await new Promise((r) => setTimeout(r, 250)); return null }
  try {
    // Budget 500 ms, a read may take 200 ms: the first starts at 0 (200 <= 600), the second at ~200 (400), the third would start at ~400 and need 200 more (600 > 500): it must not start.
    const out = await div.drainDeferredWcOrderDivergences(25, { budgetMs: 500, readTimeoutMs: 200 })
    assert.deepEqual(reads, ['0', '1'])
    assert.equal(out.examined, 2)
  } finally { div.divergenceSeams.readLiveOrder = undefined; state.rows = [] }
})

test('o3d-0ged2 LOW 12: the live read hands its abort signal to the WooCommerce transport (the deadline aborts the real request, not only the wait)', async () => {
  const div = await load()
  state.locked = true
  state.rows = [{ id: 'r1', orderId: 'o1', externalOrderId: '9', attempts: 0, failedReads: 0, fromRetry: false }]
  wcFetchCalls.length = 0
  div.divergenceSeams.readLiveOrder = undefined
  try {
    const out = await div.drainDeferredWcOrderDivergences(25, { budgetMs: 2_000, readTimeoutMs: 50 })
    assert.equal(out.examined, 1)
    assert.equal(wcFetchCalls.length, 1)
    assert.equal(wcFetchCalls[0]!.path, '/orders/9')
    assert.ok(wcFetchCalls[0]!.signal instanceof AbortSignal, 'a signal reached the transport')
    assert.equal(wcFetchCalls[0]!.signal!.aborted, true, 'and it was aborted at the deadline')
  } finally { state.rows = [] }
})

test('o3d-0ged2 LOW 12: a failure of the drain\'s own lock transaction (not only of the work inside it) is reported as failed, and never throws', async () => {
  const div = await load()
  const failing = { ...tx, $queryRaw: async () => { throw new Error('connection lost') } }
  const original = fakeDb.$transaction
  fakeDb.$transaction = async (fn: (t: typeof tx) => Promise<unknown>) => fn(failing as unknown as typeof tx)
  const errors = mock.method(console, 'error', () => undefined)
  try {
    const out = await div.drainDeferredWcOrderDivergences()
    assert.deepEqual(out, { examined: 0, resolved: 0, dropped: 0, failed: true })
  } finally { errors.mock.restore(); fakeDb.$transaction = original }
})
