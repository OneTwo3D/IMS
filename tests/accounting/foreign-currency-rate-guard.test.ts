import assert from 'node:assert/strict'
import test from 'node:test'

import { foreignCurrencyRateRefusal, isUsableImsRate, FOREIGN_RATE_DOCUMENT_TYPES, FOREIGN_RATE_PAYMENT_TYPES, needsForeignRate } from '@/lib/domain/accounting/foreign-currency-rate-guard'
import { isForeignCurrency, xeroCurrencyRateOrRefuse, imsRateToXeroCurrencyRate } from '@/lib/connectors/xero/fx'

/**
 * o3d-q0x56.2 / .3 - the PURE decisions behind the enqueue refusal and the connector refusal.
 *
 * Named mutations (each shown red, restored from a copy, md5-verified):
 *  a  payment-types-unguarded   FOREIGN_RATE_PAYMENT_TYPES loses a member: the "every type" arm goes red
 *  b  document-types-unguarded  FOREIGN_RATE_DOCUMENT_TYPES loses a member: the "every type" arm goes red
 *  c  blank-currency-foreign    isForeignCurrency answers true for a blank code: the "no currency is not foreign" arm goes red
 *  d  payment-reads-document-rate  the payment guard reads currencyRateToBase: the "document rate is not a payment rate" arm goes red
 */

test('the guard covers exactly these types', () => {
  assert.deepEqual([...FOREIGN_RATE_DOCUMENT_TYPES].sort(), ['CREDIT_NOTE', 'PURCHASE_CREDIT_NOTE', 'PURCHASE_INVOICE', 'PURCHASE_INVOICE_UPDATE', 'SALES_INVOICE', 'SALES_INVOICE_UPDATE'])
  assert.deepEqual([...FOREIGN_RATE_PAYMENT_TYPES].sort(), ['BILL_PAYMENT', 'INVOICE_PAYMENT'])
  assert.equal(needsForeignRate('COGS_JOURNAL'), false)
  assert.equal(needsForeignRate('REALISED_FX_JOURNAL'), false)
})

const ref = { referenceType: 'X', referenceId: 'x-1', baseCurrency: 'GBP' }

for (const type of [...FOREIGN_RATE_DOCUMENT_TYPES]) {
  test(`${type}: foreign without a usable rate is refused by name; with one, and in base, it is not`, () => {
    for (const rate of [undefined, null, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, '', 'abc', true, {}, [], 1e12]) {
      const refusal = foreignCurrencyRateRefusal({ type, ...ref, payload: { currency: 'EUR', currencyRateToBase: rate } })
      assert.ok(refusal, `${String(rate)} must refuse`)
      assert.equal(refusal!.reason, 'foreign_document_missing_rate')
      assert.match(refusal!.message, /EUR/)
      assert.match(refusal!.message, /XE\.com/)
      assert.match(refusal!.remedy, /rate/)
    }
    assert.equal(foreignCurrencyRateRefusal({ type, ...ref, payload: { currency: 'EUR', currencyRateToBase: 1.17 } }), null)
    assert.equal(foreignCurrencyRateRefusal({ type, ...ref, payload: { currency: 'EUR', currencyRateToBase: '1.17' } }), null)
    assert.equal(foreignCurrencyRateRefusal({ type, ...ref, payload: { currency: 'GBP' } }), null)
    assert.equal(foreignCurrencyRateRefusal({ type, ...ref, payload: { currency: 'gbp', currencyRateToBase: 1 } }), null)
  })
}

for (const type of [...FOREIGN_RATE_PAYMENT_TYPES]) {
  test(`${type}: a foreign payment needs ITS OWN settlement rate; a document rate does not stand in for it`, () => {
    for (const rate of [undefined, null, 0, -2, Number.NaN, '', 'abc', false]) {
      const refusal = foreignCurrencyRateRefusal({ type, ...ref, payload: { currency: 'USD', settlementRateToBase: rate, currencyRateToBase: 1.3 } })
      assert.ok(refusal, `${String(rate)} must refuse`)
      assert.equal(refusal!.reason, 'foreign_payment_missing_rate')
    }
    assert.equal(foreignCurrencyRateRefusal({ type, ...ref, payload: { currency: 'USD', settlementRateToBase: 1.25 } }), null)
    assert.equal(foreignCurrencyRateRefusal({ type, ...ref, payload: { currency: 'GBP' } }), null)
  })
}

test('a payload with no currency is not foreign (Xero books it in the base currency); other types are never touched', () => {
  assert.equal(foreignCurrencyRateRefusal({ type: 'SALES_INVOICE', ...ref, payload: {} }), null)
  assert.equal(foreignCurrencyRateRefusal({ type: 'SALES_INVOICE', ...ref, payload: { currency: '   ' } }), null)
  assert.equal(foreignCurrencyRateRefusal({ type: 'COGS_JOURNAL', ...ref, payload: { currency: 'EUR' } }), null)
  assert.equal(isForeignCurrency(undefined, 'GBP'), false)
  assert.equal(isForeignCurrency('', 'GBP'), false)
  assert.equal(isForeignCurrency('EUR', 'GBP'), true)
  assert.equal(isForeignCurrency(' eur', 'gbp'), true)
  assert.equal(isForeignCurrency('gbp', ' GBP'), false)
})

test('isUsableImsRate and the 1/rate conversion agree', () => {
  assert.equal(isUsableImsRate(1.17), true)
  assert.equal(isUsableImsRate('1.17'), true)
  assert.equal(isUsableImsRate(1e12), false, 'a rate whose inverse rounds to zero at 6 dp cannot be sent')
  assert.equal(imsRateToXeroCurrencyRate(1.17), 0.854701)
  assert.equal(imsRateToXeroCurrencyRate(1e12), 0)
})

test('xeroCurrencyRateOrRefuse: usable converts; base-without-rate is undefined; foreign-without-rate throws', () => {
  const ok = (rateToBase: number | undefined, currency = 'EUR') => xeroCurrencyRateOrRefuse({ currency, baseCurrency: 'GBP', rateToBase, what: 'doc' })
  assert.equal(ok(1.25), 0.8)
  assert.equal(ok(undefined, 'GBP'), undefined)
  assert.equal(ok(undefined, ''), undefined)
  assert.equal(ok(1, 'GBP'), 1)
  assert.throws(() => ok(undefined), /EUR but carries no usable IMS rate to GBP/)
  assert.throws(() => ok(0), /found 0/)
})
