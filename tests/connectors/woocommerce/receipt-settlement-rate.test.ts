import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { getFxRateToBase, isMissingFxRateError } from '@/lib/currencies/fx-lookup'
import { resolveWcReceiptSettlementRate, parseWcGmtInstant } from '@/lib/connectors/woocommerce/sync/receipt-settlement-rate'
import { fakeFxClient, type FakeFxRow } from '../../helpers/fx-fake-client'

/**
 * o3d-q0x56.19 - the settlement rate of an imported WooCommerce receipt, against the REAL central lookup (fx-lookup.ts) over an in-memory
 * rate table. Mutations (each shown red, then restored):
 *  a  always-order-rate     the next-day arm returns the order's rate: the next-day arm goes red
 *  b  always-lookup         the same-day arm looks the rate up: the same-day arm goes red (the lookup finds the 21st's rate, not the order's)
 *  c  fallback-to-order     a failed next-day lookup falls back to the order's rate: the missing-rate arm goes red
 *  d  base-looked-up        a base-currency receipt is given a rate: the base arm goes red
 *  e  local-zone-date       the dates compared are the server's local day: the midnight arms go red (run under TZ=Pacific/Auckland)
 */
const row = (to: string, rate: number, iso: string): FakeFxRow => ({ fromCurrency: 'GBP', toCurrency: to, rate, fetchedAt: new Date(iso) })
const lookupOver = (rows: FakeFxRow[]) => async (currency: string, asOf: Date) =>
  (await getFxRateToBase(fakeFxClient(rows), { currency, asOf })).rate.toNumber()

const RATES: FakeFxRow[] = [
  row('USD', 1.25, '2026-10-20T06:00:00Z'), // the order's day
  row('USD', 1.31, '2026-10-21T06:00:00Z'), // the next day
]
const ORDER = new Date('2026-10-20T10:00:00Z')

async function resolve(opts: { paid: string; rows?: FakeFxRow[]; currency?: string; ordered?: Date }) {
  return resolveWcReceiptSettlementRate({
    currency: opts.currency ?? 'USD', baseCurrency: 'GBP', orderedAt: opts.ordered ?? ORDER, orderRate: 1.25,
    datePaidGmt: opts.paid, lookup: lookupOver(opts.rows ?? RATES),
  })
}

test('same business day keeps the order rate, even when a later rate row exists the same day', async () => {
  const rows = [...RATES, row('USD', 1.27, '2026-10-20T20:00:00Z')] // fetched later the same day: a lookup would return 1.27
  assert.equal(await resolve({ paid: '2026-10-20T22:00:00', rows }), 1.25)
})

test('a later business day uses the payment-date rate, not the order rate', async () => {
  assert.equal(await resolve({ paid: '2026-10-21T09:00:00' }), 1.31)
  // end of the payment day: a rate fetched late that day is the day's rate
  const rows = [...RATES, row('USD', 1.33, '2026-10-21T23:00:00Z')]
  assert.equal(await resolve({ paid: '2026-10-21T01:00:00', rows }), 1.33)
  // but not the next morning's
  const next = [...RATES, row('USD', 1.40, '2026-10-22T00:00:00Z')]
  assert.equal(await resolve({ paid: '2026-10-21T09:00:00', rows: next }), 1.31)
})

test('a later day with no usable rate is refused as foreign_payment_missing_rate, never the order rate', async () => {
  // A zero row at the payment date is "the rate" for that day and is unusable; the older good rate is not a stand-in.
  const rows = [...RATES.slice(0, 1), row('USD', 0, '2026-10-21T06:00:00Z')]
  await assert.rejects(resolve({ paid: '2026-10-21T09:00:00', rows }), (e: unknown) => {
    assert.ok(isMissingFxRateError(e))
    assert.match((e as Error).message, /^foreign_payment_missing_rate:/)
    assert.equal((e as { reason: string }).reason, 'non_positive_rate')
    assert.equal((e as { asOf?: Date }).asOf?.toISOString(), '2026-10-21T23:59:59.999Z')
    return true
  })
  // no row at all for the currency
  await assert.rejects(resolve({ paid: '2026-10-21T09:00:00', rows: [], currency: 'EUR' }), /foreign_payment_missing_rate/)
})

test('a base-currency receipt stores no settlement rate, whatever the dates', async () => {
  assert.equal(await resolve({ paid: '2026-10-20T10:00:00', currency: 'GBP' }), null)
  assert.equal(await resolve({ paid: '2026-10-25T10:00:00', currency: 'gbp', rows: [] }), null)
})

test('the day rule is the UTC calendar date of date_paid_gmt (no zone suffix is read as UTC, not the server zone)', async () => {
  assert.equal(parseWcGmtInstant('2026-10-20T23:30:00').toISOString(), '2026-10-20T23:30:00.000Z')
  assert.equal(parseWcGmtInstant('2026-10-20T23:30:00Z').toISOString(), '2026-10-20T23:30:00.000Z')
  // order at 23:50 UTC on the 20th, paid 23:59:59 the same UTC day: same day, order rate
  const lateOrder = new Date('2026-10-20T23:50:00Z')
  assert.equal(await resolve({ paid: '2026-10-20T23:59:59', ordered: lateOrder }), 1.25)
  // paid 00:00:01 UTC the next day (11 seconds later, a different business day, though the same day in UTC-1): payment-date rate
  assert.equal(await resolve({ paid: '2026-10-21T00:00:01', ordered: lateOrder }), 1.31)
})

test('an unreadable payment date is refused as foreign_payment_missing_rate', async () => {
  await assert.rejects(resolve({ paid: 'not a date' }), /foreign_payment_missing_rate/)
})

test('order-import wires the helper before the transaction and stamps the follow-up payload, with no order-rate fallback', () => {
  const src = readFileSync('lib/connectors/woocommerce/sync/order-import.ts', 'utf8')
  // two call sites: the create path (below) and the unpaid-to-paid transition of an order IMS already holds (planWcPaidTransition)
  assert.equal((src.match(/resolveWcReceiptSettlementRate\(/g) ?? []).length, 2)
  assert.ok(src.lastIndexOf('resolveWcReceiptSettlementRate({') < src.indexOf('so = await db.$transaction'), 'resolved before the write')
  assert.match(src, /settlementRateToBase: importedReceiptSettlementRate === null/)
  assert.match(src, /_paymentSettlementRateToBase:/)
  assert.doesNotMatch(src, /usableStoredFxRate\(fxRate\)\?\.toNumber\(\) \?\? null/)
})

test('the Xero follow-up takes the declared payment rate and does not fall back to the order rate when it is unusable', async () => {
  const { settlementRateFromPayload } = await import('@/lib/connectors/xero/sync-processor')
  assert.deepEqual(settlementRateFromPayload({ currencyRateToBase: 1.25, _paymentSettlementRateToBase: 1.31 }), { settlementRateToBase: 1.31 })
  assert.deepEqual(settlementRateFromPayload({ currencyRateToBase: 1.25, _paymentSettlementRateToBase: null }), {})
  assert.deepEqual(settlementRateFromPayload({ currencyRateToBase: 1.25 }), { settlementRateToBase: 1.25 }) // queued before the key existed
})
