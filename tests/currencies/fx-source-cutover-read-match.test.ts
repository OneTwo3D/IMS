import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { cutoverReadMismatches } from '@/lib/currencies/aelia-cutover'
import { aeliaAnswer, createFxSourceFakeDb, type FakeFxRateRow } from '@/tests/helpers/fx-source-fake-db'

/**
 * THE CUTOVER MUST RESOLVE TO THIS READ (cutoverReadMismatches in lib/currencies/aelia-cutover.ts, used by setFxRateSource).
 * After the real lookup is run at the cutover instant, every unpinned currency must resolve to the rate and the time of the Aelia read this cutover ingested. The stored rows cannot normally make
 * the lookup differ (the ingest refuses a regression and a changed rate at one time), so the lookup is made to answer differently for one currency to prove the guard itself.
 */

const ACTIVE = [{ code: 'GBP', active: true }, { code: 'EUR', active: true }, { code: 'USD', active: true }, { code: 'NOK', active: true }]
const ecbRow = (to: string, rate: string, extra: Partial<FakeFxRateRow> = {}): FakeFxRateRow => ({ fromCurrency: 'GBP', toCurrency: to, rate, fetchedAt: new Date('2026-10-25T06:00:00Z'), source: 'frankfurter', manualOverride: false, ...extra })

let fake = createFxSourceFakeDb()
let tamper: ((code: string, outcome: Record<string, unknown>) => Record<string, unknown>) | null = null

mock.module('@/lib/db', { namedExports: { db: new Proxy({}, { get: (_t, k) => (fake.db as never)[k] }) } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/auth/server', { namedExports: { requirePermission: async () => ({ user: { id: 'u', role: 'ADMIN' } }), requireInternalUser: async () => ({ user: { id: 'u', role: 'ADMIN' } }) } })
mock.module('@/lib/settings-store', { namedExports: { getSettingValues: async () => new Map([['wc_url', 'https://shop.example.com'], ['wc_webhook_secret', 'sekret']]) } })
mock.module('@/lib/connectors/woocommerce/aelia-rates', { namedExports: { readAeliaRatesFromWc: async () => ({ ok: true, body: aeliaAnswer() }) } })
let installed = false
async function installLookup() {
  if (installed) return
  installed = true
  const realLookup = await import('@/lib/currencies/fx-lookup')
  mock.module('@/lib/currencies/fx-lookup', {
    namedExports: {
      ...realLookup,
      resolveFxRatesToBase: async (...args: Parameters<typeof realLookup.resolveFxRatesToBase>) => {
        const real = await realLookup.resolveFxRatesToBase(...args)
        if (!tamper) return real
        return new Map([...real].map(([code, o]): [string, typeof o] => [code, o.ok ? (tamper!(code, o) as typeof o) : o]))
      },
    },
  })
}

test('a cutover whose resolved rate or time differs from THIS read is refused and rolled back; the same cutover with the lookup untouched commits', async () => {
  await installLookup()
  const { setFxRateSource } = await import('@/app/actions/currencies')
  const seed = () => [ecbRow('EUR', '1.10'), ecbRow('USD', '1.25'), ecbRow('NOK', '12.1')]

  fake = createFxSourceFakeDb({ currencies: ACTIVE, rates: seed() })
  tamper = (code, o) => (code === 'EUR' ? { ...o, rate: new Prisma.Decimal('1.5') } : o)
  const rate = await setFxRateSource('aelia')
  assert.equal(rate.success, false)
  assert.match(rate.error ?? '', /EUR \(resolves to 1\.5 at 2026-10-23T23:36:05\.000Z, this read has 1\.194344/)
  assert.equal(fake.settings.has('fx_rate_source'), false)
  assert.equal(fake.rates.filter((r) => r.source === 'aelia').length, 0, 'the rows of this read were rolled back')
  assert.ok(fake.events.includes('tx.rollback'))

  fake = createFxSourceFakeDb({ currencies: ACTIVE, rates: seed() })
  tamper = (code, o) => (code === 'NOK' ? { ...o, fetchedAt: new Date('2026-10-23T23:36:06Z') } : o)
  const time = await setFxRateSource('aelia')
  assert.equal(time.success, false)
  assert.match(time.error ?? '', /NOK \(resolves to/)
  assert.equal(fake.settings.has('fx_rate_source'), false)

  // a PINNED currency is judged by the lookup alone: a differing answer for it is not this guard's business
  fake = createFxSourceFakeDb({ currencies: ACTIVE, rates: [...seed(), ecbRow('USD', '1.40', { fetchedAt: new Date('2026-10-26T00:00:00Z'), manualOverride: true })] })
  tamper = (code, o) => (code === 'USD' ? { ...o, rate: new Prisma.Decimal('9') } : o)
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })

  // a currency LABELLED pinned whose lookup resolves a non-override is refused and named
  fake = createFxSourceFakeDb({ currencies: ACTIVE, rates: [...seed(), ecbRow('USD', '1.40', { fetchedAt: new Date('2026-10-26T00:00:00Z'), manualOverride: true })] })
  tamper = (code, o) => (code === 'USD' ? { ...o, manualOverride: false, source: 'aelia' } : o)
  const label = await setFxRateSource('aelia')
  assert.equal(label.success, false)
  assert.match(label.error ?? '', /USD \(counted as pinned/)
  assert.equal(fake.settings.has('fx_rate_source'), false)

  // CONTROL: untouched lookup commits
  fake = createFxSourceFakeDb({ currencies: ACTIVE, rates: seed() })
  tamper = null
  assert.deepEqual(await setFxRateSource('aelia'), { success: true })
})

test('cutoverReadMismatches: equal rate (any trailing zeros) and time agree; a currency not in the read, a different rate or a different time is reported; pinned and failed outcomes are skipped', () => {
  const at = new Date('2026-10-23T23:36:05Z')
  type Outcome = { ok: true; rate: Prisma.Decimal; fetchedAt: Date; manualOverride: boolean } | { ok: false }
  const ok = (rate: string, fetchedAt = at, manualOverride = false): Outcome => ({ ok: true, rate: new Prisma.Decimal(rate), fetchedAt, manualOverride })
  const failed: Outcome = { ok: false }
  const read = { updatedAt: at, readRates: { EUR: '1.1900', NOK: '12.5' }, pinned: ['USD'] }
  assert.deepEqual(cutoverReadMismatches(new Map<string, Outcome>([['EUR', ok('1.19')], ['NOK', ok('12.5')], ['USD', ok('9', at, true)], ['SEK', failed]]), read), [])
  // a currency LABELLED pinned that resolves to a non-override is a disagreement
  const unpinnedLookup = cutoverReadMismatches(new Map<string, Outcome>([['USD', ok('1.3')]]), read)
  assert.equal(unpinnedLookup.length, 1)
  assert.match(unpinnedLookup[0], /^USD \(counted as pinned/)
  const bad = cutoverReadMismatches(new Map<string, Outcome>([['EUR', ok('1.2')], ['NOK', ok('12.5', new Date('2026-10-23T23:36:06Z'))], ['CHF', ok('1')]]), read)
  assert.equal(bad.length, 3)
  assert.match(bad[0], /^EUR/)
  assert.match(bad[1], /^NOK/)
  assert.match(bad[2], /^CHF \(not in this read\)/)
})
