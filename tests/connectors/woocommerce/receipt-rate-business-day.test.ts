/**
 * The storefront receipt's "paid on the order's day" rate test is judged on the LONDON business day (the day the invoice and the payment are dated), not the UTC day.
 * [mutation: receiptOnOrderDay back on utcCalendarDate: cases (a) and (b) fail]
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { postedReceiptOnOrderDay, receiptOnOrderDay, resolveWcReceiptSettlementRate } from '../../../lib/connectors/woocommerce/sync/receipt-settlement-rate.ts'

const at = (iso: string): Date => new Date(iso)

test('BST evening (a): created 22:30 UTC and paid 23:10 UTC are the same UTC day but different London days: not the same day', () => {
  assert.equal(receiptOnOrderDay(at('2026-07-01T22:30:00Z'), at('2026-07-01T23:10:00Z')), false)
})

test('BST evening (b): created 23:30 UTC and paid 00:10 UTC next day are different UTC days but the same London day: the same day', () => {
  assert.equal(receiptOnOrderDay(at('2026-07-01T23:30:00Z'), at('2026-07-02T00:10:00Z')), true)
})

test('in winter (GMT) the London day is the UTC day', () => {
  assert.equal(receiptOnOrderDay(at('2026-12-01T22:30:00Z'), at('2026-12-01T23:10:00Z')), true)
  assert.equal(receiptOnOrderDay(at('2026-12-01T23:30:00Z'), at('2026-12-02T00:10:00Z')), false)
  assert.equal(receiptOnOrderDay(null, at('2026-12-01T23:10:00Z')), false, 'an unknown order instant is never the same day')
})

test('the posted-day form (the reconciliation pack) judges the London day, and the legacy form the UTC day of the order', () => {
  const created = at('2026-07-01T22:30:00Z') // 23:30 London on 1 July
  assert.equal(postedReceiptOnOrderDay(created, '2026-07-01'), true)
  assert.equal(postedReceiptOnOrderDay(created, '2026-07-02'), false)
  const createdLate = at('2026-07-01T23:30:00Z') // 00:30 London on 2 July
  assert.equal(postedReceiptOnOrderDay(createdLate, '2026-07-02'), true)
  assert.equal(postedReceiptOnOrderDay(createdLate, '2026-07-02', true), false, 'legacy: the order UTC day is 1 July')
  assert.equal(postedReceiptOnOrderDay(createdLate, '2026-07-01', true), true)
  assert.equal(postedReceiptOnOrderDay(null, '2026-07-01'), false)
})

test('the importer on a BST evening: (a) looks up the end-of-business-day rate, (b) keeps the order rate', async () => {
  const asked: string[] = []
  const lookup = async (_currency: string, asOf: Date) => { asked.push(asOf.toISOString()); return 1.4 }
  const common = { currency: 'EUR', baseCurrency: 'GBP', orderRate: 1.2, lookup }
  const a = await resolveWcReceiptSettlementRate({ ...common, orderedAt: at('2026-07-01T22:30:00Z'), datePaidGmt: '2026-07-01T23:10:00' })
  assert.equal(a, 1.4, 'a different London day: the table rate')
  assert.deepEqual(asked, ['2026-07-02T23:59:59.999Z'], 'as of the end of the London day the payment is dated on (the day R16 reads)')
  const b = await resolveWcReceiptSettlementRate({ ...common, orderedAt: at('2026-07-01T23:30:00Z'), datePaidGmt: '2026-07-02T00:10:00' })
  assert.equal(b, 1.2, 'the same London day: the order rate')
  assert.equal(asked.length, 1, 'no lookup for the same day')
})
