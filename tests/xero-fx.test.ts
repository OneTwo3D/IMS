import assert from 'node:assert/strict'
import test from 'node:test'
import { accountingPayloadKey } from '../lib/accounting/payload-key.ts'
import { XERO_SALES_CREDIT_NOTE_TYPE } from '../lib/connectors/xero/credit-notes.ts'
import { imsRateToXeroCurrencyRate } from '../lib/connectors/xero/fx.ts'
import { buildXeroIdempotencyKey } from '../lib/connectors/xero/sync-processor.ts'

// GOLDEN VALUES CHANGED DELIBERATELY: these four arms pinned the INVERTED rate (1 / fxRateToBase). Xero's CurrencyRate is units of
// foreign per one base, the same convention as IMS's fxRateToBase (verified on the live organisation's own bills, see
// lib/connectors/xero/fx.ts and tests/connectors/xero-currency-rate-direction.test.ts), so the rate is sent as is, rounded to 6 dp.
test('sends IMS fxRateToBase as Xero CurrencyRate unchanged, never inverted', () => {
  // Base GBP, document EUR. IMS stores 1 GBP = 1.18 EUR, and so does Xero.
  const got = imsRateToXeroCurrencyRate(1.18)
  assert.equal(got, 1.18)
  assert.notEqual(got, 0.847458, 'the reciprocal is the old, wrong direction')
})

test('passes through 1.0 unchanged for same-currency invoices', () => {
  assert.equal(imsRateToXeroCurrencyRate(1), 1)
})

test('rounds to 6 decimal places to match Xero Decimal(18,6) schema', () => {
  // A stored rate with more precision than Xero accepts is rounded half up to 6dp, not sent at full float precision.
  assert.equal(imsRateToXeroCurrencyRate(1.3526509931), 1.352651)
  assert.equal(imsRateToXeroCurrencyRate(1.1835295458), 1.18353)
  assert.equal(imsRateToXeroCurrencyRate(8.937375334), 8.937375)
})

test('handles JPY-scale rates (a large rate) without losing magnitude', () => {
  // Base GBP, doc JPY. 1 GBP ≈ 190 JPY: Xero holds 190, never 1/190 ≈ 0.005263.
  assert.equal(imsRateToXeroCurrencyRate(190), 190)
  assert.equal(imsRateToXeroCurrencyRate(190.1234567), 190.123457)
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
