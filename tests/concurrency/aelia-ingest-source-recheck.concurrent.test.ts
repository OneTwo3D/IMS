import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * THE AELIA WRITERS RE-CHECK THE SOURCE INSIDE THE WRITE LOCK (lib/currencies/aelia-ingest.ts ingestAeliaRates / clearOverrideFromAelia; the other half of the barrier setFxRateSource sets).
 *
 * A refresh that starts while Aelia is selected may finish after setFxRateSource('ecb') committed; the ECB writer re-checks the source in the lock, and so must the Aelia ingest.
 *   arm 1  a switch back to ECB DURING an in-flight Aelia refresh (the store has answered nothing yet): the refresh writes no Aelia row
 *   arm 2  CONTROL: the same refresh with the source still aelia stores its row (so the absence in arm 1 is the guard, not the harness)
 *   arm 3  a clear of a manual override that was in flight when the source went back to ECB is refused and stores nothing; so is a clear started after the switch back
 * Real Postgres, the real lock. Mutation: drop the in-lock source re-read from the ingest / from the clear -> the matching arm sees the Aelia row.
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

test('a switch back to ECB during an in-flight Aelia refresh or override clear writes no Aelia row', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const realSettings = await import('@/lib/settings-store')
  mock.module('@/lib/settings-store', {
    namedExports: { ...realSettings, getSettingValues: async () => new Map([['wc_url', 'https://shop.example.com'], ['wc_webhook_secret', 'sekret']]) },
  })
  const startedAt = new Date()
  const stampRefresh = new Date(startedAt.getTime() - 120_000)
  const stampClear = new Date(startedAt.getTime() - 60_000)
  let stamp = stampRefresh
  let gated = false
  let readEntered: () => void = () => {}
  let readSeen = new Promise<void>((r) => { readEntered = r })
  let releaseRead: () => void = () => {}
  let readGate = new Promise<void>((r) => { releaseRead = r })
  const arm = () => {
    readSeen = new Promise<void>((r) => { readEntered = r })
    readGate = new Promise<void>((r) => { releaseRead = r })
    gated = true
  }
  mock.module('@/lib/connectors/woocommerce/aelia-rates', {
    namedExports: {
      readAeliaRatesFromWc: async () => {
        if (gated) { readEntered(); await readGate }
        const active = await db.currency.findMany({ where: { active: true, code: { not: 'GBP' } }, select: { code: true } })
        return { ok: true, body: { ok: true, base: 'GBP', last_update: stamp.toISOString(), rates: active.map((c) => ({ currency: c.code, rate: '1.500000', markup: null })) } }
      },
    },
  })
  const { getBaseCurrencyCode } = await import('@/lib/base-currency')
  const { setFxRateSource, clearManualFxRate } = await import('@/app/actions/currencies')
  const { fetchAllFxRatesInternal } = await import('@/lib/currencies/fx-refresh')
  const { clearOverrideFromAelia } = await import('@/lib/currencies/aelia-ingest')

  assert.equal(await getBaseCurrencyCode(), 'GBP', 'PRECONDITION: the scratch base currency is GBP')
  const keys = ['fx_rate_source', 'fx_rate_source_since', 'fx_aelia_last_update_at', 'fx_aelia_last_read_at']
  const saved = await db.setting.findMany({ where: { key: { in: keys } } })
  const eurExisted = (await db.currency.findUnique({ where: { code: 'EUR' }, select: { code: true } })) !== null
  await db.currency.upsert({ where: { code: 'EUR' }, update: { active: true }, create: { code: 'EUR', name: 'EUR', symbol: 'EUR', active: true } })
  t.after(async () => {
    gated = false
    releaseRead()
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    for (const s of saved) await db.setting.create({ data: { key: s.key, value: s.value } })
    await db.fxRate.deleteMany({ where: { source: 'aelia', fetchedAt: { in: [stampRefresh, stampClear] } } })
    if (!eurExisted) await db.currency.deleteMany({ where: { code: 'EUR' } })
  })
  const aeliaRows = (at: Date) => db.fxRate.count({ where: { source: 'aelia', fetchedAt: at } })
  const selectAelia = async () => {
    await db.setting.deleteMany({ where: { key: { in: keys } } })
    await db.setting.create({ data: { key: 'fx_rate_source', value: 'aelia' } })
    await db.setting.create({ data: { key: 'fx_rate_source_since', value: new Date(startedAt.getTime() - 3_600_000).toISOString() } })
  }
  assert.equal(await aeliaRows(stampRefresh), 0, 'PRECONDITION: no Aelia row at the refresh stamp')

  // ---- arm 1: the refresh is in flight (parked in its read) when the source goes back to ECB
  await selectAelia()
  stamp = stampRefresh
  arm()
  const refresh = fetchAllFxRatesInternal()
  await readSeen
  assert.deepEqual(await setFxRateSource('ecb'), { success: true })
  assert.equal((await db.setting.findUnique({ where: { key: 'fx_rate_source' } }))?.value, 'ecb')
  releaseRead()
  gated = false
  const result = await refresh
  assert.equal(result.success, false)
  assert.equal(result.error, 'The FX source is no longer Aelia; nothing was stored.', 'discarded quietly as a source change, not reported as a failed read')
  assert.equal(await aeliaRows(stampRefresh), 0, 'arm 1: no Aelia row was stored after the switch back to ECB')

  // ---- arm 2: CONTROL, same refresh with the source still aelia
  await selectAelia()
  const control = await fetchAllFxRatesInternal()
  assert.equal(control.updated.includes('EUR'), true, 'CONTROL: the refresh stores its Aelia rows while the source is aelia')
  assert.ok((await aeliaRows(stampRefresh)) >= 1)

  // ---- arm 3: an override clear in flight when the source goes back to ECB, and one started after it
  await selectAelia()
  stamp = stampClear
  arm()
  const clearing = clearManualFxRate('EUR')
  await readSeen
  assert.deepEqual(await setFxRateSource('ecb'), { success: true })
  releaseRead()
  gated = false
  const cleared = await clearing
  assert.equal(cleared.success, false)
  assert.match(cleared.error ?? '', /source_changed/)
  assert.equal(await aeliaRows(stampClear), 0, 'arm 3: the in-flight clear stored no Aelia row')
  await assert.rejects(
    clearOverrideFromAelia({ ok: true, base: 'GBP', last_update: stampClear.toISOString(), rates: [{ currency: 'EUR', rate: '1.5' }] }, 'EUR'),
    (e: Error & { reason?: string }) => e.reason === 'source_changed',
  )
  assert.equal(await aeliaRows(stampClear), 0, 'arm 3: a clear after the switch back stores nothing either')
  // CONTROL: under the Aelia source the same clear stores its row (dated by the admin action, so not at the stamp: count the newest row instead)
  await selectAelia()
  const before = await db.fxRate.count({ where: { source: 'aelia', toCurrency: 'EUR' } })
  await clearOverrideFromAelia({ ok: true, base: 'GBP', last_update: stampClear.toISOString(), rates: [{ currency: 'EUR', rate: '1.5' }] }, 'EUR')
  assert.equal(await db.fxRate.count({ where: { source: 'aelia', toCurrency: 'EUR' } }), before + 1, 'CONTROL: the clear stores its row while the source is aelia')
  await db.fxRate.deleteMany({ where: { source: 'aelia', toCurrency: 'EUR', fetchedAt: { gte: startedAt } } })
})
