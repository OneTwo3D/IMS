import assert from 'node:assert/strict'
import test from 'node:test'
import { accountingPayloadKey } from '../lib/accounting/payload-key.ts'
import { XERO_SALES_CREDIT_NOTE_TYPE } from '../lib/connectors/xero/credit-notes.ts'
import { imsRateToXeroCurrencyRate } from '../lib/connectors/xero/fx.ts'
import { buildXeroIdempotencyKey } from '../lib/connectors/xero/sync-processor.ts'

test('inverts IMS fxRateToBase into Xero CurrencyRate', () => {
  // Base GBP, document EUR. IMS stores 1 GBP = 1.18 EUR.
  // Xero expects 1 EUR = X GBP → 1 / 1.18 ≈ 0.847458 (6dp).
  const got = imsRateToXeroCurrencyRate(1.18)
  assert.equal(got, 0.847458)
})

test('passes through 1.0 unchanged for same-currency invoices', () => {
  assert.equal(imsRateToXeroCurrencyRate(1), 1)
})

test('rounds to 6 decimal places to match Xero Decimal(18,6) schema', () => {
  // 1 / 3 = 0.333... → must be 6dp, not full float precision.
  const got = imsRateToXeroCurrencyRate(3)
  assert.equal(got, 0.333333)
})

test('handles JPY-scale rates (very small inverted rate) without underflow', () => {
  // Base GBP, doc JPY. 1 GBP ≈ 190 JPY → 1/190 ≈ 0.005263 (6dp).
  // Make sure the rate doesn't get rounded to 0 or to a wrong order of magnitude.
  const got = imsRateToXeroCurrencyRate(190)
  assert.equal(got, 0.005263)
})

test('returns undefined for missing, zero, negative, and non-finite rates', () => {
  assert.equal(imsRateToXeroCurrencyRate(undefined), undefined)
  assert.equal(imsRateToXeroCurrencyRate(null), undefined)
  assert.equal(imsRateToXeroCurrencyRate(0), undefined)
  assert.equal(imsRateToXeroCurrencyRate(-1.5), undefined)
  assert.equal(imsRateToXeroCurrencyRate(NaN), undefined)
  assert.equal(imsRateToXeroCurrencyRate(Infinity), undefined)
})

test('uses the Xero CreditNotes sales-credit enum, not the invoice enum', () => {
  assert.equal(XERO_SALES_CREDIT_NOTE_TYPE, 'ACCRECCREDIT')
})

test('accounting payload keys include the document-stamped FX rate', () => {
  const basePayload = {
    documentId: 'po-1',
    currency: 'EUR',
    totalForeign: 100,
    lines: [{ description: 'Line', unitAmount: 100, quantity: 1 }],
  }

  const first = accountingPayloadKey('purchase-invoice:po-1', {
    ...basePayload,
    currencyRateToBase: 1.18,
  })
  const restamped = accountingPayloadKey('purchase-invoice:po-1', {
    ...basePayload,
    currencyRateToBase: 1.19,
  })
  const retry = accountingPayloadKey('purchase-invoice:po-1', {
    ...basePayload,
    currencyRateToBase: 1.18,
  })

  assert.equal(first, retry)
  assert.notEqual(first, restamped)
})

test('Xero idempotency keys prefer stable accounting payload keys when present', () => {
  const first = buildXeroIdempotencyKey('sync-log-1', 'invoice-update', {
    _idempotencyKey: 'sales-invoice-update:order-1:invoice-1:payload-a',
  })
  const retryFromDifferentLog = buildXeroIdempotencyKey('sync-log-2', 'invoice-update', {
    _idempotencyKey: 'sales-invoice-update:order-1:invoice-1:payload-a',
  })
  const changedPayload = buildXeroIdempotencyKey('sync-log-1', 'invoice-update', {
    _idempotencyKey: 'sales-invoice-update:order-1:invoice-1:payload-b',
  })

  assert.equal(first, retryFromDifferentLog)
  assert.notEqual(first, changedPayload)
  assert.equal(buildXeroIdempotencyKey('sync-log-1', 'invoice-update'), 'ims-invoice-update-sync-log-1')
})
