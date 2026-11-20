import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveProductionOrderFx } from '@/lib/domain/manufacturing/production-order-fx'
import { parseManufacturingCostLines } from '@/lib/domain/manufacturing/manufacturing-action-inputs'
import { fakeFxClient } from '@/tests/helpers/fx-fake-client'

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
  const parsed = parseManufacturingCostLines([{ description: 'Labour', amountForeign: 117.5 }], r.fxRateToBase.toNumber())
  assert.ok(parsed.success)
  assert.equal(parsed.lines[0].amountBase, 100)
})
