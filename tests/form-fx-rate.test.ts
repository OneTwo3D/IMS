import assert from 'node:assert/strict'
import test from 'node:test'

import { MissingFxRateError } from '@/lib/currencies/fx-select'
import {
  describeFxSource, formFxRateFromError, fxBlocksSubmit, missingFormFxRate, missingFxRateMessage, repriceUnitPrice, usableRate,
  type FormFxRate,
} from '@/lib/currencies/form-fx-rate'

const ok = (rate: number): FormFxRate => ({ state: 'ok', rate, fetchedAt: '2026-11-16T00:00:00.000Z', source: 'aelia', manualOverride: false })

test('a missing rate is refused, never 1', () => {
  const m = missingFormFxRate('EUR')
  assert.equal(usableRate(m), null)
  assert.equal(fxBlocksSubmit(m), true)
  assert.match(missingFxRateMessage('EUR'), /^No exchange rate for EUR yet: rates come from the store \(Aelia\)\./)
})

test('loading blocks submit; base and a real rate do not', () => {
  assert.equal(fxBlocksSubmit(null), true)
  assert.equal(fxBlocksSubmit({ state: 'base' }), false)
  assert.equal(fxBlocksSubmit(ok(1.17)), false)
  assert.equal(usableRate({ state: 'base' }), 1)
})

test('a zero, negative or non-finite rate is unusable', () => {
  for (const r of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(fxBlocksSubmit(ok(r)), true)
})

test('only a missing-rate refusal becomes a state; anything else is rethrown', () => {
  const missing = new MissingFxRateError('Missing GBP FX rate for EUR', 'EUR', new Date(), 'no_rate', 'GBP')
  assert.equal(formFxRateFromError('EUR', missing).state, 'missing')
  assert.throws(() => formFxRateFromError('EUR', new Error('db down')), /db down/)
})

test('repriceUnitPrice restates a price through the base currency', () => {
  // GBP 10 -> EUR at 1 GBP = 1.2 EUR
  assert.equal(repriceUnitPrice(10, 1, 1.2), 12)
  // EUR 12 -> GBP
  assert.equal(repriceUnitPrice(12, 1.2, 1), 10)
  // EUR -> USD (1 GBP = 1.25 USD): 12 EUR = 10 GBP = 12.5 USD
  assert.equal(repriceUnitPrice(12, 1.2, 1.25), 12.5)
  assert.equal(repriceUnitPrice(28.8, 1, 1.17), 33.7)
})

test('repriceUnitPrice refuses an unusable rate instead of defaulting', () => {
  assert.equal(repriceUnitPrice(10, null, 1.2), null)
  assert.equal(repriceUnitPrice(10, 1, null), null)
  assert.equal(repriceUnitPrice(10, 0, 1.2), null)
  assert.equal(repriceUnitPrice(Number.NaN, 1, 1.2), null)
})

test('describeFxSource names the source', () => {
  assert.equal(describeFxSource('aelia', false), 'Aelia')
  assert.equal(describeFxSource('aelia', true), 'manual override')
  assert.equal(describeFxSource('frankfurter', false), 'ECB (frankfurter)')
})
