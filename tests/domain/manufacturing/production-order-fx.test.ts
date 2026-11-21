import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { productionOrderFxActivityMetadata, productionOrderFxCreateData, resolveProductionOrderFx, type ProductionOrderFxClient } from '@/lib/domain/manufacturing/production-order-fx'
import { parseManufacturingCostLines } from '@/lib/domain/manufacturing/manufacturing-action-inputs'
import { fakeFxClient as fakeRates, type FakeFxRow } from '@/tests/helpers/fx-fake-client'

/** The FX fake plus the currencies table: every code is active unless listed in `inactive`. */
function fakeFxClient(rows: FakeFxRow[], inactive: string[] = []): ProductionOrderFxClient {
  return Object.assign(fakeRates(rows), {
    currency: { findUnique: async ({ where }: { where: { code: string } }) => ({ active: !inactive.includes(where.code) }) },
  }) as unknown as ProductionOrderFxClient
}

const ASOF = new Date('2026-06-11T00:00:00.000Z')
const row = { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.17500000', fetchedAt: new Date('2026-06-10T00:00:00.000Z'), source: 'aelia', manualOverride: false }

// [mutation: default a missing rate to 1, or fall back to the schema default]
test('no currency chosen: nothing is resolved, so the schema defaults (base, 1) stay exactly as before', async () => {
  for (const currency of [undefined, null, '', '  ']) {
    assert.deepEqual(await resolveProductionOrderFx(fakeFxClient([row]) as never, { currency, baseCurrency: 'GBP', asOf: ASOF }), { ok: true, chosen: false })
  }
})

test('base currency is rate 1 and never reads the table', async () => {
  const r = await resolveProductionOrderFx(fakeFxClient([]) as never, { currency: 'gbp', baseCurrency: 'GBP', asOf: ASOF })
  assert.ok(r.ok && r.chosen)
  assert.equal(r.currency, 'GBP')
  assert.equal(r.fxRateToBase.toString(), '1')
  assert.equal(r.source, 'base')
})

test('a foreign currency takes the table rate with its provenance', async () => {
  const r = await resolveProductionOrderFx(fakeFxClient([row]) as never, { currency: 'eur', baseCurrency: 'GBP', asOf: ASOF, expectedFxRate: 1.175 })
  assert.ok(r.ok && r.chosen)
  assert.equal(r.currency, 'EUR')
  assert.equal(r.fxRateToBase.toString(), '1.175')
  assert.equal(r.source, 'aelia')
  assert.equal(r.manualOverride, false)
  assert.equal(r.fetchedAt.toISOString(), '2026-06-10T00:00:00.000Z')
})

// [mutation: return rate 1 / skip the refusal when the table has no row]
test('a foreign currency with no table rate is a blocking refusal, never 1', async () => {
  const r = await resolveProductionOrderFx(fakeFxClient([]) as never, { currency: 'EUR', baseCurrency: 'GBP', asOf: ASOF })
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : '', /No exchange rate for EUR/)
})

test('a rate that moved since the form read it is refused with FX_RATE_CHANGED', async () => {
  const r = await resolveProductionOrderFx(fakeFxClient([row]) as never, { currency: 'EUR', baseCurrency: 'GBP', asOf: ASOF, expectedFxRate: 1.2 })
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : '', /^FX_RATE_CHANGED:/)
})

test('base cost = foreign / stored rate, exact to 4dp', async () => {
  const r = await resolveProductionOrderFx(fakeFxClient([row]) as never, { currency: 'EUR', baseCurrency: 'GBP', asOf: ASOF })
  assert.ok(r.ok && r.chosen)
  const parsed = parseManufacturingCostLines([{ description: 'Labour', amountForeign: 117.5 }], r.fxRateToBase)
  assert.ok(parsed.success)
  assert.equal(parsed.lines[0].amountBase, 100)
})

// [mutation: drop the fetchedAt <= asOf bound / pass the wrong asOf]
test('asOf is honoured: a row fetched after asOf is never chosen', async () => {
  const later = { ...row, rate: '9.99000000', fetchedAt: new Date('2026-06-12T00:00:00.000Z') }
  const r = await resolveProductionOrderFx(fakeFxClient([row, later]) as never, { currency: 'EUR', baseCurrency: 'GBP', asOf: ASOF })
  assert.ok(r.ok && r.chosen)
  assert.equal(r.fxRateToBase.toString(), '1.175')
  const onlyLater = await resolveProductionOrderFx(fakeFxClient([later]) as never, { currency: 'EUR', baseCurrency: 'GBP', asOf: ASOF })
  assert.equal(onlyLater.ok, false)
})

test('a non-string currency is a refusal, not a TypeError', async () => {
  for (const currency of [123, {}, ['EUR'], true]) {
    const r = await resolveProductionOrderFx(fakeFxClient([row]) as never, { currency, baseCurrency: 'GBP', asOf: ASOF })
    assert.equal(r.ok, false)
  }
})

test('an inactive currency with a rate row is refused; the base currency never needs the currencies table', async () => {
  const r = await resolveProductionOrderFx(fakeFxClient([row], ['EUR']) as never, { currency: 'EUR', baseCurrency: 'GBP', asOf: ASOF })
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : '', /not active/)
  const base = await resolveProductionOrderFx(fakeFxClient([], ['GBP']) as never, { currency: 'GBP', baseCurrency: 'GBP', asOf: ASOF })
  assert.ok(base.ok && base.chosen)
})

test('create data: a chosen currency carries code and rate; none chosen writes the base currency and omits the rate', async () => {
  const chosen = await resolveProductionOrderFx(fakeFxClient([row]) as never, { currency: 'EUR', baseCurrency: 'GBP', asOf: ASOF })
  assert.ok(chosen.ok)
  const data = productionOrderFxCreateData(chosen, 'GBP')
  assert.equal(data.currency, 'EUR')
  assert.equal(data.fxRateToBase?.toString(), '1.175')
  const none = await resolveProductionOrderFx(fakeFxClient([row]) as never, { currency: '', baseCurrency: 'SEK', asOf: ASOF })
  assert.ok(none.ok)
  const noneData = productionOrderFxCreateData(none, 'sek')
  assert.deepEqual(noneData, { currency: 'SEK' })
  assert.equal('fxRateToBase' in noneData, false)
})

test('activity metadata carries the rate provenance only when a currency was chosen', async () => {
  const chosen = await resolveProductionOrderFx(fakeFxClient([row]) as never, { currency: 'EUR', baseCurrency: 'GBP', asOf: ASOF })
  assert.ok(chosen.ok)
  assert.deepEqual(productionOrderFxActivityMetadata(chosen), {
    currency: 'EUR', fxRateToBase: '1.175', fxRateSource: 'aelia', fxRateManualOverride: false, fxRateFetchedAt: '2026-06-10T00:00:00.000Z',
  })
  const none = await resolveProductionOrderFx(fakeFxClient([row]) as never, { currency: null, baseCurrency: 'GBP', asOf: ASOF })
  assert.ok(none.ok)
  assert.deepEqual(productionOrderFxActivityMetadata(none), {})
})

test('the parser takes the stored Decimal exactly (no float round trip)', () => {
  const rate = new Prisma.Decimal('1.17500001')
  const parsed = parseManufacturingCostLines([{ description: 'Labour', amountForeign: 117.500001 }], rate)
  assert.ok(parsed.success)
  assert.equal(parsed.lines[0].amountBase, 100)
  assert.equal(parseManufacturingCostLines([{ description: 'x', amountForeign: 1 }], new Prisma.Decimal(0)).success, false)
})
