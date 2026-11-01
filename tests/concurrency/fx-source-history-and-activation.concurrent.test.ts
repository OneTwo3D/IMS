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
 *   arm 3  the boundary of a switch is taken inside the lock after the wait, so a payment priced during the wait lies before it
 *   arm 4  an unreadable history refuses every lookup (fx_source_history_unreadable)
 *   arm 5  a base-currency change takes the FX lock and is refused under Aelia; it compares against the base and lock marker left by a lock holder, not the ones seen before its wait
 *   arm 6  an unreadable history refuses a source switch and is not rewritten
 *   arm 7  a cleared pin (a newer ECB row over an old manual one) is no pin under Aelia: neither activation nor a lookup uses it; a pin in force still does
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

  // ---- arm 3: the boundary of a switch is taken INSIDE the lock, after the wait. An ECB switch waits behind a lock holder; an Aelia-period payment lookup is made while it waits; the boundary
  // the switch records falls AFTER that payment's instant, and the payment's rate still comes from Aelia afterwards.
  await reset()
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  let releaseWait: () => void = () => {}
  const waitGate = new Promise<void>((r) => { releaseWait = r })
  let waitIn: () => void = () => {}
  const waitHolderIn = new Promise<void>((r) => { waitIn = r })
  const waitHolder = withFxTableWriteLock(async () => { waitIn(); await waitGate })
  await waitHolderIn
  const switching = setFxRateSource('ecb')
  assert.ok((await waitingOnAdvisoryLock(db)) >= 1, 'PRECONDITION: the ECB switch waits on the FX table lock')
  await new Promise((r) => setTimeout(r, 40))
  const paymentAt = new Date() // an Aelia-period payment recorded while the switch waits (the source is still Aelia)
  assert.equal((await getFxRateToBase(db, { currency: 'EUR', asOf: paymentAt })).source, 'aelia', 'PRECONDITION: during the wait the payment is priced from Aelia')
  await new Promise((r) => setTimeout(r, 40))
  releaseWait()
  await waitHolder
  assert.deepEqual(await switching, { success: true })
  const boundary = new Date((await setting('fx_rate_source_since'))!)
  assert.ok(boundary.getTime() > paymentAt.getTime(), `the recorded boundary (${boundary.toISOString()}) falls after the payment made during the wait (${paymentAt.toISOString()})`)
  assert.equal((await getFxRateToBase(db, { currency: 'EUR', asOf: paymentAt })).source, 'aelia', 'the payment still reads as Aelia after the switch')

  // ---- arm 4: an unreadable history refuses every lookup, whatever the current source
  await db.setting.upsert({ where: { key: 'fx_rate_source_history' }, create: { key: 'fx_rate_source_history', value: '{not json' }, update: { value: '{not json' } })
  await assert.rejects(getFxRateToBase(db, { currency: 'EUR', asOf: new Date() }), (e: Error & { reason?: string }) => e.reason === 'fx_source_history_unreadable')
  await assert.rejects(getFxRateToBase(db, { currency: 'EUR', asOf: new Date(Date.now() - 86_400_000) }), (e: Error & { reason?: string }) => e.reason === 'fx_source_history_unreadable')
  await db.setting.deleteMany({ where: { key: 'fx_rate_source_history' } })
  assert.equal((await getFxRateToBase(db, { currency: 'EUR', asOf: new Date() })).isBase, false, 'CONTROL: repaired (absent), the lookup answers again')

  // ---- arm 5: a change of the BASE currency under Aelia is refused, and takes the FX lock
  // the base currency counts as "locked" once ANY master data exists, which the rest of this tier leaves behind: the lock marker is not what is under test, so it is read from the marker alone here
  const realBaseCurrency = await import('@/lib/base-currency')
  mock.module('@/lib/base-currency', { namedExports: { ...realBaseCurrency, isBaseCurrencyLocked: async () => (await db.setting.findUnique({ where: { key: 'base_currency_locked' } }))?.value === 'true' } })
  const { updateOrganisation } = await import('@/app/actions/company')
  const orgExisted = await db.organisation.findFirst({ select: { id: true, baseCurrency: true } })
  const orgBefore = orgExisted ?? await db.organisation.create({ data: { name: 'FX test org', baseCurrency: 'GBP' }, select: { id: true, baseCurrency: true } })
  const lockedSetting = await db.setting.findUnique({ where: { key: 'base_currency_locked' } })
  const gbpExisted = (await db.currency.count({ where: { code: 'GBP' } })) > 0 // a base change (even to the current base) creates the base currency row when it is missing
  t.after(async () => {
    if (orgExisted) await db.organisation.update({ where: { id: orgBefore.id }, data: { baseCurrency: orgBefore.baseCurrency } })
    else await db.organisation.deleteMany({ where: { id: orgBefore.id } })
    if (!gbpExisted) await db.currency.deleteMany({ where: { code: 'GBP' } })
    await db.setting.deleteMany({ where: { key: 'base_currency_locked' } })
    if (lockedSetting) await db.setting.create({ data: { key: lockedSetting.key, value: lockedSetting.value } })
    await db.currency.updateMany({ where: { code: 'AUD' }, data: { active: existed.get('AUD') === true } })
  })
  await db.setting.deleteMany({ where: { key: 'base_currency_locked' } })
  await db.currency.update({ where: { code: 'AUD' }, data: { active: false } })
  await reset()
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  const refusedBase = await updateOrganisation({ baseCurrency: 'AUD' })
  assert.equal(refusedBase.success, false)
  assert.match(refusedBase.error ?? '', /Aelia/)
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, orgBefore.baseCurrency, 'the base currency was not changed')
  assert.equal((await db.currency.findUnique({ where: { code: 'AUD' } }))?.active, false, 'the would-be base currency was not activated')
  assert.equal((await updateOrganisation({ baseCurrency: orgBefore.baseCurrency })).success, true, 'setting the base to what it already is is not a change')
  // it is serialised with the source switch: a switch to Aelia holds the lock, the base change waits, then sees Aelia and refuses
  await reset()
  await db.setting.deleteMany({ where: { key: 'base_currency_locked' } }) // a base change writes the lock marker; the next arms need the base unlocked
  let releaseBase: () => void = () => {}
  const baseGate = new Promise<void>((r) => { releaseBase = r })
  let baseIn: () => void = () => {}
  const baseHolderIn = new Promise<void>((r) => { baseIn = r })
  const baseHolder = withFxTableWriteLock(async (tx) => {
    baseIn()
    await baseGate
    const at = new Date(Date.now() - 1000).toISOString()
    await tx.setting.upsert({ where: { key: 'fx_rate_source' }, create: { key: 'fx_rate_source', value: 'aelia' }, update: { value: 'aelia' } })
    await tx.setting.upsert({ where: { key: 'fx_rate_source_since' }, create: { key: 'fx_rate_source_since', value: at }, update: { value: at } })
  })
  await baseHolderIn
  let baseDone = false
  const baseChange = updateOrganisation({ baseCurrency: 'AUD' }).then((r) => { baseDone = true; return r })
  assert.ok((await waitingOnAdvisoryLock(db)) >= 1, 'PRECONDITION: the base change waits on the FX table lock')
  assert.equal(baseDone, false)
  assert.equal((await db.currency.findUnique({ where: { code: 'AUD' } }))?.active, false)
  releaseBase()
  await baseHolder
  assert.equal((await baseChange).success, false, 'the base change saw the committed Aelia source and refused')
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, orgBefore.baseCurrency)
  // the decision is made on what the lock holder left, not on what the request saw before it waited. (a) the holder moves the base to AUD and switches to Aelia; a request to put the base back to GBP
  // looked like "no change" before the wait, and must be refused after it. The base stays AUD.
  await reset()
  await db.setting.deleteMany({ where: { key: 'base_currency_locked' } })
  let releaseStale: () => void = () => {}
  const staleGate = new Promise<void>((r) => { releaseStale = r })
  let staleIn: () => void = () => {}
  const staleHolderIn = new Promise<void>((r) => { staleIn = r })
  const staleHolder = withFxTableWriteLock(async (tx) => {
    staleIn()
    await staleGate
    const at = new Date(Date.now() - 1000).toISOString()
    await tx.organisation.updateMany({ data: { baseCurrency: 'AUD' } })
    await tx.setting.upsert({ where: { key: 'fx_rate_source' }, create: { key: 'fx_rate_source', value: 'aelia' }, update: { value: 'aelia' } })
    await tx.setting.upsert({ where: { key: 'fx_rate_source_since' }, create: { key: 'fx_rate_source_since', value: at }, update: { value: at } })
  })
  await staleHolderIn
  const stale = updateOrganisation({ baseCurrency: orgBefore.baseCurrency })
  assert.ok((await waitingOnAdvisoryLock(db)) >= 1, 'PRECONDITION: the base change waits on the FX table lock')
  await new Promise((r) => setTimeout(r, 100))
  releaseStale()
  await staleHolder
  const staleResult = await stale
  assert.equal(staleResult.success, false, 'refused: the base the request compared against was stale')
  assert.match(staleResult.error ?? '', /Aelia/)
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'AUD', 'the base the holder set is untouched')
  // (b) the holder moves the base and sets the lock marker (source ECB); the request is refused as locked
  await reset()
  await db.organisation.updateMany({ data: { baseCurrency: orgBefore.baseCurrency } })
  await db.setting.deleteMany({ where: { key: 'base_currency_locked' } })
  let releaseLk: () => void = () => {}
  const lkGate = new Promise<void>((r) => { releaseLk = r })
  let lkIn: () => void = () => {}
  const lkHolderIn = new Promise<void>((r) => { lkIn = r })
  const lkHolder = withFxTableWriteLock(async (tx) => {
    lkIn()
    await lkGate
    await tx.organisation.updateMany({ data: { baseCurrency: 'AUD' } })
    await tx.setting.upsert({ where: { key: 'base_currency_locked' }, create: { key: 'base_currency_locked', value: 'true' }, update: { value: 'true' } })
  })
  await lkHolderIn
  const lkReq = updateOrganisation({ baseCurrency: 'EUR' })
  assert.ok((await waitingOnAdvisoryLock(db)) >= 1, 'PRECONDITION: the base change waits on the FX table lock')
  await new Promise((r) => setTimeout(r, 100))
  releaseLk()
  await lkHolder
  const lkResult = await lkReq
  assert.equal(lkResult.success, false)
  assert.match(lkResult.error ?? '', /locked/)
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'AUD')
  await db.organisation.updateMany({ data: { baseCurrency: orgBefore.baseCurrency } })
  await db.setting.deleteMany({ where: { key: 'base_currency_locked' } })

  // ---- arm 6: an unreadable history refuses every SOURCE SWITCH and leaves the history untouched
  await reset()
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  const goodHistory = (await setting('fx_rate_source_history'))!
  const badHistories = ['{not json', '[{"source":"gold","since":"2026-10-01T00:00:00Z"}]']
  for (const bad of badHistories) {
    await db.setting.update({ where: { key: 'fx_rate_source_history' }, data: { value: bad } })
    const refusedSwitch = await setFxRateSource('ecb')
    assert.equal(refusedSwitch.success, false)
    assert.match(refusedSwitch.error ?? '', /fx_source_history_unreadable/)
    assert.equal(await setting('fx_rate_source_history'), bad, 'the unreadable history was not rewritten')
    assert.equal(await setting('fx_rate_source'), 'aelia', 'the source did not change')
  }
  await db.setting.update({ where: { key: 'fx_rate_source_history' }, data: { value: goodHistory } })
  assert.deepEqual(await setFxRateSource('ecb'), { success: true }, 'CONTROL: repaired, the switch goes through')
  assert.deepEqual(JSON.parse((await setting('fx_rate_source_history'))!).map((h: { source: string }) => h.source), ['aelia', 'ecb'])

  // ---- arm 7: a cleared pin is no pin. Under ECB an operator pins AUD and clears it (a newer ECB row, the old manual row stays); after the switch to Aelia neither activation nor a lookup may use it.
  await reset()
  await db.currency.update({ where: { code: 'AUD' }, data: { active: false } })
  await db.fxRate.deleteMany({ where: { toCurrency: 'AUD' } })
  const now0 = Date.now()
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'AUD', rate: '1.9', source: 'manual', manualOverride: true, fetchedAt: new Date(now0 - 3000) } })
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'AUD', rate: '1.95', source: 'frankfurter', manualOverride: false, fetchedAt: new Date(now0 - 2000) } })
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
  const clearedActivation = await toggleCurrency('AUD', true)
  assert.equal(clearedActivation.success, false, 'the cleared pin does not cover the activation')
  assert.match(clearedActivation.error ?? '', /Aelia/)
  assert.equal((await db.currency.findUnique({ where: { code: 'AUD' } }))?.active, false)
  await assert.rejects(getFxRateToBase(db, { currency: 'AUD', asOf: new Date() }), (e: Error & { reason?: string }) => e.reason === 'no_rate_from_selected_source', 'the lookup does not use the old pin either')
  // an Aelia row, when there is one, answers instead
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'AUD', rate: '2.1', source: 'aelia', manualOverride: false, fetchedAt: new Date(now0 - 500) } })
  assert.equal((await getFxRateToBase(db, { currency: 'AUD', asOf: new Date() })).rate.toString(), '2.1')
  await db.fxRate.deleteMany({ where: { toCurrency: 'AUD', source: 'aelia' } })
  // a pin newer than everything is in force: activation passes and the lookup uses it
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'AUD', rate: '1.7', source: 'manual', manualOverride: true, fetchedAt: new Date(now0 - 100) } })
  assert.deepEqual(await toggleCurrency('AUD', true), { success: true }, 'a pin in force covers the activation')
  assert.equal((await getFxRateToBase(db, { currency: 'AUD', asOf: new Date() })).rate.toString(), '1.7')
  await db.currency.update({ where: { code: 'AUD' }, data: { active: false } })
  await db.fxRate.deleteMany({ where: { toCurrency: 'AUD' } })

  // CONTROL: under ECB the change goes through (so the refusals above can fail for the right reason only)
  await reset()
  await db.setting.deleteMany({ where: { key: 'base_currency_locked' } })
  assert.deepEqual(await updateOrganisation({ baseCurrency: 'AUD' }), { success: true })
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'AUD')
  assert.equal((await db.currency.findUnique({ where: { code: 'AUD' } }))?.active, true)
  await db.organisation.update({ where: { id: orgBefore.id }, data: { baseCurrency: orgBefore.baseCurrency } })
  await db.currency.update({ where: { code: 'AUD' }, data: { active: false } })
  await db.setting.deleteMany({ where: { key: 'base_currency_locked' } })

  // CONTROL: under ECB the same activation and creation succeed (the arms above can fail for the right reason only)
  await reset()
  globalThis.fetch = (async () => new Response(JSON.stringify({ rates: { NZD: 1.9 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  assert.deepEqual(await toggleCurrency('AUD', true), { success: true })
  assert.deepEqual(await createCurrency({ code: 'NZD', name: 'NZD', symbol: 'NZ$' }), { success: true })
  assert.equal((await db.currency.findUnique({ where: { code: 'NZD' } }))?.active, true)
})
