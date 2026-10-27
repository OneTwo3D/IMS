import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * THE FX SOURCE CUTOVER BARRIER (app/actions/currencies.ts setFxRateSource; lib/currencies/fx-refresh.ts; lib/connectors/woocommerce/fx-rates.ts; lib/currencies/fx-table-lock.ts).
 *
 * setFxRateSource changes the source and its instant under the EXCLUSIVE FX table lock. The rate push holds the lock SHARED from its source check through its POST; every ECB write re-reads the
 * source inside the exclusive lock.
 *   arm 1  a switch to Aelia DURING a push blocks on the advisory lock until the push completes (it was sent under the old source); after the switch commits a push sends nothing
 *   arm 2  a switch to Aelia DURING an ECB refresh (frankfurter already answered) means the refresh stores no ECB row
 * Real Postgres. Mutations: take the switch out of the lock -> arm 1 sees the switch commit while the POST is still in flight; drop the in-lock source re-read from the refresh -> arm 2 stores the ECB rows.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/shopping', { namedExports: { pushFxRatesToConnectors: async () => [], enqueueStockSync: async () => {} } })
mock.module('@/lib/connectors/woocommerce/sync/order-import', { namedExports: { retryPendingWcOrdersWaitingForFx: async () => ({ attempted: 0, imported: 0, stillPending: 0, failed: 0 }) } })

let posts = 0
let enteredPost: () => void = () => {}
const postEntered = new Promise<void>((r) => { enteredPost = r })
let releasePost: () => void = () => {}
const postGate = new Promise<void>((r) => { releasePost = r })
let gatePosts = false

async function waitingOnAdvisoryLock(db: { $queryRaw: <T>(q: TemplateStringsArray) => Promise<T> }): Promise<number> {
  let waiting = 0
  for (let i = 0; i < 100 && waiting === 0; i++) {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
    waiting = Number(rows[0]?.n ?? 0)
    if (waiting === 0) await new Promise((r) => setTimeout(r, 50))
  }
  return waiting
}

test('a switch to Aelia during a rate push waits for the push; after it commits no POST is sent. A switch during an ECB refresh means no ECB row is stored', SKIP, async (t) => {
  loadEnv()
  const realSettings = await import('@/lib/settings-store')
  mock.module('@/lib/settings-store', {
    namedExports: {
      ...realSettings,
      getSettingValues: async () => new Map([['wc_url', 'https://shop.example.com'], ['wc_webhook_secret', 'sekret'], ['wc_fx_push_enabled', 'true']]),
    },
  })
  const realFetch = await import('@/lib/security/connector-fetch')
  mock.module('@/lib/security/connector-fetch', {
    namedExports: {
      ...realFetch,
      connectorFetch: async () => {
        posts += 1
        if (gatePosts) { enteredPost(); await postGate }
        return new Response(JSON.stringify({ ok: true, pushed: 1 }), { status: 200 })
      },
    },
  })
  const { db } = await import('@/lib/db')
  const { getBaseCurrencyCode } = await import('@/lib/base-currency')
  const { pushFxRatesToWc } = await import('@/lib/connectors/woocommerce/fx-rates')
  const { setFxRateSource } = await import('@/app/actions/currencies')
  const { fetchAllFxRatesInternal } = await import('@/lib/currencies/fx-refresh')

  assert.equal(await getBaseCurrencyCode(), 'GBP', 'PRECONDITION: the scratch base currency is GBP')
  const keys = ['fx_rate_source', 'fx_rate_source_since']
  const saved = await db.setting.findMany({ where: { key: { in: keys } } })
  const eurExisted = (await db.currency.findUnique({ where: { code: 'EUR' }, select: { code: true } })) !== null
  await db.currency.upsert({ where: { code: 'EUR' }, update: { active: true }, create: { code: 'EUR', name: 'EUR', symbol: 'EUR', active: true } })
  const realGlobalFetch = globalThis.fetch
  const startedAt = new Date()
  t.after(async () => {
    globalThis.fetch = realGlobalFetch
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const s of saved) await db.setting.create({ data: { key: s.key, value: s.value } })
    await db.fxRate.deleteMany({ where: { toCurrency: 'EUR', source: 'frankfurter', fetchedAt: { gte: startedAt } } })
    if (!eurExisted) await db.currency.deleteMany({ where: { code: 'EUR' } })
  })
  const reset = async () => { await db.setting.deleteMany({ where: { key: { in: keys } } }) }
  const source = async () => (await db.setting.findUnique({ where: { key: 'fx_rate_source' } }))?.value ?? null

  // ---- arm 1: the push
  await reset()
  gatePosts = true
  const push = pushFxRatesToWc([{ fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.19, fetchedAt: '2026-10-23T23:36:05Z' }])
  await postEntered // the push holds the table lock (shared) and is inside its POST
  let switched = false
  const sw = setFxRateSource('aelia').then((r) => { switched = true; return r })
  assert.ok((await waitingOnAdvisoryLock(db)) >= 1, 'PRECONDITION: the switch is blocked on the advisory lock while the push is in flight')
  assert.equal(switched, false)
  assert.equal(await source(), null, 'the source has not changed')
  assert.equal(posts, 1)
  releasePost()
  const pushed = await push
  assert.deepEqual(pushed, { supported: true, pushed: 1, errors: [] }, 'the push finished under the old source')
  assert.deepEqual(await sw, { success: true })
  assert.equal(await source(), 'aelia')
  assert.ok((await db.setting.findUnique({ where: { key: 'fx_rate_source_since' } }))?.value, 'the instant was written with the source')
  gatePosts = false
  const after = await pushFxRatesToWc([{ fromCurrency: 'GBP', toCurrency: 'EUR', rate: 1.19, fetchedAt: '2026-10-23T23:36:05Z' }])
  assert.equal(after.supported, false)
  assert.equal(posts, 1, 'no POST after the switch committed')

  // ---- arm 2: the ECB refresh
  await reset()
  let ecbEntered: () => void = () => {}
  const ecbSeen = new Promise<void>((r) => { ecbEntered = r })
  let ecbRelease: () => void = () => {}
  const ecbGate = new Promise<void>((r) => { ecbRelease = r })
  globalThis.fetch = (async () => {
    ecbEntered()
    await ecbGate
    return new Response(JSON.stringify({ rates: { EUR: 1.11 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const refresh = fetchAllFxRatesInternal()
  await ecbSeen // frankfurter is being asked; the refresh holds no lock yet
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  ecbRelease()
  const result = await refresh
  assert.equal(result.success, false)
  assert.equal(await db.fxRate.count({ where: { toCurrency: 'EUR', source: 'frankfurter', fetchedAt: { gte: startedAt } } }), 0, 'no ECB row was stored after the switch')

  // CONTROL: with the source still ecb the same refresh stores its row, so the count above can be non-zero
  await reset()
  globalThis.fetch = (async () => new Response(JSON.stringify({ rates: { EUR: 1.11 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const control = await fetchAllFxRatesInternal()
  assert.equal(control.success, true)
  assert.equal(await db.fxRate.count({ where: { toCurrency: 'EUR', source: 'frankfurter', fetchedAt: { gte: startedAt } } }), 1, 'CONTROL: the refresh stores its ECB row when the source is ecb')
})
