import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * THE FX SOURCE SWITCH HISTORY AND CURRENCY ACTIVATION (app/actions/currencies.ts; lib/currencies/fx-source-regime.ts; lib/currencies/fx-lookup.ts).
 *   arm 1  every switch appends one interval boundary to the history, in the switch's own transaction; after a switch BACK to ECB a lookup dated in the Aelia period still answers from Aelia rows
 *          (the later ECB row is not eligible), while a lookup after the switch back is the plain latest row
 *   arm 2  activating a currency (toggleCurrency, createCurrency) takes the FX table lock: it waits for a switch in flight, then sees the source that switch committed and, under Aelia, refuses a
 *          currency Aelia has not covered; a pin (manual override) in force now covers it
 * Real Postgres. Mutations: stop appending the history -> arm 1 reads the ECB row; take toggleCurrency / createCurrency out of the lock -> arm 2 activates while the lock is held.
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

async function waitingOnAdvisoryLock(db: { $queryRaw: <T>(q: TemplateStringsArray) => Promise<T> }): Promise<number> {
  let waiting = 0
  for (let i = 0; i < 100 && waiting === 0; i++) {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
    waiting = Number(rows[0]?.n ?? 0)
    if (waiting === 0) await new Promise((r) => setTimeout(r, 50))
  }
  return waiting
}

test('switch history keeps the Aelia period on Aelia rows after a switch back; activation is serialised with the switch and needs Aelia coverage', SKIP, async (t) => {
  loadEnv()
  const realSettings = await import('@/lib/settings-store')
  mock.module('@/lib/settings-store', {
    namedExports: {
      ...realSettings,
      getSettingValues: async () => new Map([['wc_url', 'https://shop.example.com'], ['wc_webhook_secret', 'sekret'], ['wc_fx_push_enabled', 'true']]),
    },
  })
  const { db } = await import('@/lib/db')
  const stamp = new Date(Date.now() - 60_000)
  mock.module('@/lib/connectors/woocommerce/aelia-rates', {
    namedExports: {
      readAeliaRatesFromWc: async () => {
        const active = await db.currency.findMany({ where: { active: true, code: { not: 'GBP' } }, select: { code: true } })
        return { ok: true, body: { ok: true, base: 'GBP', last_update: stamp.toISOString(), rates: active.map((c) => ({ currency: c.code, rate: '1.500000', markup: null })) } }
      },
    },
  })
  const { getBaseCurrencyCode } = await import('@/lib/base-currency')
  const { setFxRateSource, toggleCurrency, createCurrency } = await import('@/app/actions/currencies')
  const { getFxRateToBase } = await import('@/lib/currencies/fx-lookup')
  const { withFxTableWriteLock } = await import('@/lib/currencies/fx-table-lock')
  assert.equal(await getBaseCurrencyCode(), 'GBP', 'PRECONDITION: the scratch base currency is GBP')

  const keys = ['fx_rate_source', 'fx_rate_source_since', 'fx_rate_source_history', 'fx_aelia_last_update_at', 'fx_aelia_last_read_at']
  const saved = await db.setting.findMany({ where: { key: { in: keys } } })
  const existed = new Map((await db.currency.findMany({ where: { code: { in: ['EUR', 'AUD', 'NZD'] } }, select: { code: true, active: true } })).map((c) => [c.code, c.active]))
  const startedAt = new Date()
  const realGlobalFetch = globalThis.fetch
  t.after(async () => {
    globalThis.fetch = realGlobalFetch
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const s of saved) await db.setting.create({ data: { key: s.key, value: s.value } })
    await db.fxRate.deleteMany({ where: { OR: [{ source: 'aelia', fetchedAt: stamp }, { toCurrency: { in: ['EUR', 'AUD', 'NZD'] }, fetchedAt: { gte: new Date(startedAt.getTime() - 61_000) }, source: { in: ['frankfurter', 'manual', 'aelia'] } }] } })
    for (const code of ['EUR', 'AUD', 'NZD']) {
      if (!existed.has(code)) await db.currency.deleteMany({ where: { code } })
      else await db.currency.update({ where: { code }, data: { active: existed.get(code) === true } })
    }
  })
  const reset = async () => { await db.setting.deleteMany({ where: { key: { in: keys } } }) }
  const setting = async (key: string) => (await db.setting.findUnique({ where: { key } }))?.value ?? null
  await db.currency.upsert({ where: { code: 'EUR' }, update: { active: true }, create: { code: 'EUR', name: 'EUR', symbol: 'EUR', active: true } })
  for (const code of ['AUD']) await db.currency.upsert({ where: { code }, update: { active: false }, create: { code, name: code, symbol: code, active: false } })
  await db.currency.deleteMany({ where: { code: 'NZD' } })

  // ---- arm 1: the switch history
  await reset()
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  const since = new Date((await setting('fx_rate_source_since'))!)
  const history1 = JSON.parse((await setting('fx_rate_source_history'))!) as Array<{ source: string; since: string }>
  assert.deepEqual(history1.map((h) => h.source), ['aelia'], 'the first switch appended one entry')
  assert.equal(history1[0]!.since, since.toISOString(), 'the entry carries the same instant as the pair')
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.77', source: 'frankfurter', fetchedAt: since } }) // an ECB row dated after Aelia's, from the Aelia period
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(await setFxRateSource('ecb'), { success: true })
  const back = new Date((await setting('fx_rate_source_since'))!)
  const history2 = JSON.parse((await setting('fx_rate_source_history'))!) as Array<{ source: string; since: string }>
  assert.deepEqual(history2.map((h) => h.source), ['aelia', 'ecb'], 'the switch back appended a second entry')
  assert.equal(history2[1]!.since, back.toISOString())
  const inPeriod = await getFxRateToBase(db, { currency: 'EUR', asOf: new Date(back.getTime() - 1) })
  assert.equal(inPeriod.source, 'aelia', 'a document dated in the Aelia period still uses Aelia rows after the switch back')
  assert.equal(inPeriod.rate.toString(), '1.5')
  const afterBack = await getFxRateToBase(db, { currency: 'EUR', asOf: new Date(back.getTime() + 1000) })
  assert.equal(afterBack.rate.toString(), '1.77', 'CONTROL: after the switch back the plain latest row (ECB) answers')
  // a lookup before the first recorded switch keeps today's behaviour: the plain latest row at that instant
  const beforeAny = await getFxRateToBase(db, { currency: 'EUR', asOf: new Date(since.getTime() - 1) })
  assert.equal(beforeAny.fetchedAt.getTime() <= since.getTime() - 1, true)

  // ---- arm 2: activation
  await reset()
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  const refusedToggle = await toggleCurrency('AUD', true)
  assert.equal(refusedToggle.success, false)
  assert.match(refusedToggle.error ?? '', /Aelia/)
  assert.equal((await db.currency.findUnique({ where: { code: 'AUD' } }))?.active, false, 'the currency stayed inactive')
  const refusedCreate = await createCurrency({ code: 'NZD', name: 'NZD', symbol: 'NZ$' })
  assert.equal(refusedCreate.success, false)
  assert.match(refusedCreate.error ?? '', /Aelia/)
  assert.equal(await db.currency.count({ where: { code: 'NZD' } }), 0, 'the currency was not created')
  assert.equal((await toggleCurrency('AUD', false)).success, true, 'switching a currency off never needs coverage')
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'AUD', rate: '1.9', source: 'manual', manualOverride: true, fetchedAt: new Date(Date.now() - 1000) } })
  assert.deepEqual(await toggleCurrency('AUD', true), { success: true }, 'a pin in force now covers the currency')
  assert.equal((await db.currency.findUnique({ where: { code: 'AUD' } }))?.active, true)
  await db.currency.update({ where: { code: 'AUD' }, data: { active: false } })
  await db.fxRate.deleteMany({ where: { toCurrency: 'AUD', source: 'manual' } })

  // serialised with the switch: a switch holds the lock, an activation waits, then sees the source the switch committed and refuses
  await reset()
  let releaseHolder: () => void = () => {}
  const holderGate = new Promise<void>((r) => { releaseHolder = r })
  let holding: () => void = () => {}
  const holderIn = new Promise<void>((r) => { holding = r })
  const holder = withFxTableWriteLock(async (tx) => {
    holding()
    await holderGate
    const at = new Date(Date.now() - 1000).toISOString()
    await tx.setting.upsert({ where: { key: 'fx_rate_source' }, create: { key: 'fx_rate_source', value: 'aelia' }, update: { value: 'aelia' } })
    await tx.setting.upsert({ where: { key: 'fx_rate_source_since' }, create: { key: 'fx_rate_source_since', value: at }, update: { value: at } })
  })
  await holderIn
  let settled = false
  const toggled = toggleCurrency('AUD', true).then((r) => { settled = true; return r })
  assert.ok((await waitingOnAdvisoryLock(db)) >= 1, 'PRECONDITION: the activation waits on the FX table lock')
  assert.equal(settled, false)
  assert.equal((await db.currency.findUnique({ where: { code: 'AUD' } }))?.active, false)
  releaseHolder()
  await holder
  const result = await toggled
  assert.equal(result.success, false, 'the activation saw the committed Aelia source and refused')
  assert.equal((await db.currency.findUnique({ where: { code: 'AUD' } }))?.active, false)

  // create is serialised the same way
  await reset()
  let release2: () => void = () => {}
  const gate2 = new Promise<void>((r) => { release2 = r })
  let in2: () => void = () => {}
  const holder2In = new Promise<void>((r) => { in2 = r })
  const holder2 = withFxTableWriteLock(async (tx) => {
    in2()
    await gate2
    const at = new Date(Date.now() - 1000).toISOString()
    await tx.setting.upsert({ where: { key: 'fx_rate_source' }, create: { key: 'fx_rate_source', value: 'aelia' }, update: { value: 'aelia' } })
    await tx.setting.upsert({ where: { key: 'fx_rate_source_since' }, create: { key: 'fx_rate_source_since', value: at }, update: { value: at } })
  })
  await holder2In
  let created = false
  const creating = createCurrency({ code: 'NZD', name: 'NZD', symbol: 'NZ$' }).then((r) => { created = true; return r })
  assert.ok((await waitingOnAdvisoryLock(db)) >= 1, 'PRECONDITION: the create waits on the FX table lock')
  assert.equal(created, false)
  assert.equal(await db.currency.count({ where: { code: 'NZD' } }), 0)
  release2()
  await holder2
  assert.equal((await creating).success, false)
  assert.equal(await db.currency.count({ where: { code: 'NZD' } }), 0)

  // CONTROL: under ECB the same activation and creation succeed (the arms above can fail for the right reason only)
  await reset()
  globalThis.fetch = (async () => new Response(JSON.stringify({ rates: { NZD: 1.9 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  assert.deepEqual(await toggleCurrency('AUD', true), { success: true })
  assert.deepEqual(await createCurrency({ code: 'NZD', name: 'NZD', symbol: 'NZ$' }), { success: true })
  assert.equal((await db.currency.findUnique({ where: { code: 'NZD' } }))?.active, true)
})
