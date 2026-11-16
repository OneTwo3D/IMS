import assert from 'node:assert/strict'
import test from 'node:test'

import { formFxRateFromError } from '@/lib/currencies/form-fx-rate-server'
import { MissingFxRateError } from '@/lib/currencies/fx-select'
import {
  convertAnchored, convertDiscountAnchored, describeFxSource, fxBlocksSubmit, fxRateChangedMessage, isFxRateChangedError, repriceDiscountStr, missingFormFxRate, missingFxRateMessage, repriceUnitPrice, usableRate,
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

test('discounts: a percentage stays, an absolute amount is restated, blank stays blank', () => {
  assert.equal(repriceDiscountStr('10%', 1, 1.2), '10%')
  assert.equal(repriceDiscountStr('', 1, 1.2), '')
  assert.equal(repriceDiscountStr('5', 1, 1.2), '6')
  assert.equal(repriceDiscountStr('6', 1.2, 1), '5')
  assert.equal(repriceDiscountStr('abc', 1, 1.2), 'abc')
  assert.equal(repriceDiscountStr('5', 1, null), '5')
})

test('the rate-changed refusal is recognised by its code', () => {
  assert.equal(isFxRateChangedError('FX_RATE_CHANGED: the EUR table rate moved from 1.1 to 1.2 since it was checked; nothing was written'), true)
  assert.equal(isFxRateChangedError('Missing GBP FX rate'), false)
  assert.equal(isFxRateChangedError(undefined), false)
})

test('A -> B -> A returns the original price (no compounding rounding)', () => {
  const rates = [1, 1.17, 0.8333, 1.3]
  for (const start of [28.8, 9.99, 0.07, 1234.56]) {
    let value = start
    let anchor = undefined as ReturnType<typeof convertAnchored>['anchor']
    let from = rates[0]
    for (const to of [1.17, 0.8333, 1.3, 1.17, 1]) {
      const r = convertAnchored(value, anchor, from, to)
      value = r.value
      anchor = r.anchor
      from = to
    }
    assert.equal(value, start)
  }
})

test('an edited field restarts from what it shows', () => {
  const a = convertAnchored(10, undefined, 1, 1.2) // 12
  const edited = convertAnchored(20, a.anchor, 1.2, 1) // user typed 20, not 12
  assert.equal(edited.value, 16.67)
})

test('discount anchors: percentage kept, absolute round-trips', () => {
  const a = convertDiscountAnchored('3.33', undefined, 1, 1.17)
  const b = convertDiscountAnchored(a.value, a.anchor, 1.17, 1)
  assert.equal(b.value, '3.33')
  assert.equal(convertDiscountAnchored('10%', undefined, 1, 1.17).value, '10%')
})

test('the rate-changed refusal text carries the code and both rates', () => {
  const m = fxRateChangedMessage('USD', 1.25, 1.3)
  assert.equal(isFxRateChangedError(m), true)
  assert.match(m, /USD table rate moved from 1.25 to 1.3/)
})
