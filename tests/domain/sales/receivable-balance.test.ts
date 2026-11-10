import assert from 'node:assert/strict'
import test from 'node:test'
import { receivableBalance, type ReceivableOrder } from '@/lib/domain/sales/receivable-balance'

const d = (s: string) => new Date(`${s}T12:00:00.000Z`)
const CUT = d('2026-06-30')
const pay = (amount: number, at = '2026-06-10', extra: Record<string, unknown> = {}) => ({ amount, currency: 'GBP', refundId: null, paidAt: d(at), ...extra })
const out = (amount: number, at = '2026-06-20') => ({ amount: -amount, currency: 'GBP', refundId: 'r1', paidAt: d(at) })
const gross = (totalBase: number, at = '2026-06-15') => ({ totalBase, totalsBasis: 'GROSS', lines: [], refundedAt: d(at) })
const order = (over: Partial<ReceivableOrder> = {}): ReceivableOrder => ({ totalBase: 100, totalForeign: 100, currency: 'GBP', paidAt: null, payments: [], refunds: [], ...over })

type Case = { name: string; order: ReceivableOrder; asOf?: Date; balance: number; status: 'outstanding' | 'credit' | 'settled'; bound?: 'exact' | 'upper' | 'indeterminate' }
const CASES: Case[] = [
  { name: 'unpaid', order: order(), balance: 100, status: 'outstanding' },
  { name: 'part-paid', order: order({ payments: [pay(40)] }), balance: 60, status: 'outstanding' },
  { name: 'fully paid', order: order({ payments: [pay(100)] }), balance: 0, status: 'settled' },
  { name: 'paid-held with no payment rows', order: order({ paidAt: d('2026-06-05') }), balance: 0, status: 'settled' },
  { name: 'paid-held, then cash refunded out', order: order({ paidAt: d('2026-06-05'), payments: [out(30)] }), balance: 30, status: 'outstanding' },
  { name: 'paid-held but the payment row exists: rows decide', order: order({ paidAt: d('2026-06-05'), payments: [pay(60)] }), balance: 40, status: 'outstanding' },
  { name: 'unpaid + credit', order: order({ refunds: [gross(30)] }), balance: 70, status: 'outstanding' },
  { name: 'fully credited unpaid', order: order({ refunds: [gross(100)] }), balance: 0, status: 'settled' },
  { name: 'paid + credit, no refund: customer credit balance', order: order({ payments: [pay(100)], refunds: [gross(20)] }), balance: -20, status: 'credit' },
  { name: 'paid + credit + cash refund = settled', order: order({ payments: [pay(100), out(20)], refunds: [gross(20)] }), balance: 0, status: 'settled' },
  { name: 'part-paid + refund-out', order: order({ payments: [pay(60), out(10)] }), balance: 50, status: 'outstanding' },
  { name: 'refund-out recorded positive is still a refund-out', order: order({ payments: [pay(100), { amount: 20, currency: 'GBP', refundId: 'r1', paidAt: d('2026-06-20') }] }), balance: 20, status: 'outstanding' },
  { name: 'USD order booked at 0.8 with a $50 receipt owes 40', order: order({ totalBase: 80, totalForeign: 100, currency: 'USD', payments: [{ amount: 50, currency: 'USD', refundId: null, paidAt: d('2026-06-10') }] }), balance: 40, status: 'outstanding' },
  { name: 'a stored settlement rate beats the booked rate', order: order({ totalBase: 80, totalForeign: 100, currency: 'USD', payments: [{ amount: 50, currency: 'USD', refundId: null, paidAt: d('2026-06-10'), settlementRateToBase: 0.9 }] }), balance: 35, status: 'outstanding' },
  { name: 'a payment in another currency with no rate is indeterminate', order: order({ totalBase: 80, totalForeign: 100, currency: 'USD', payments: [{ amount: 50, currency: 'EUR', refundId: null, paidAt: d('2026-06-10') }] }), balance: 40, status: 'outstanding', bound: 'indeterminate' },
  { name: 'unplaceable positive credit: counts 0 and the balance is an upper bound', order: order({ refunds: [{ totalBase: 10, totalsBasis: null, lines: [], refundedAt: d('2026-06-15') }] }), balance: 100, status: 'outstanding', bound: 'upper' },
  { name: 'unplaceable non-positive credit is indeterminate', order: order({ refunds: [{ totalBase: -5, totalsBasis: null, lines: [], refundedAt: d('2026-06-15') }] }), balance: 100, status: 'outstanding', bound: 'indeterminate' },
  { name: 'a later payment is outside the cutoff', order: order({ payments: [pay(100, '2026-07-02')] }), balance: 100, status: 'outstanding' },
  { name: 'a later credit is outside the cutoff', order: order({ refunds: [gross(100, '2026-07-02')] }), balance: 100, status: 'outstanding' },
  { name: 'a later cash refund is outside the cutoff', order: order({ payments: [pay(100), out(100, '2026-07-02')] }), balance: 0, status: 'settled' },
  { name: 'paidAt after the cutoff does not settle it', order: order({ paidAt: d('2026-07-02') }), balance: 100, status: 'outstanding' },
  { name: 'a payment exactly at the cutoff instant counts', order: order({ payments: [{ amount: 100, currency: 'GBP', refundId: null, paidAt: CUT }] }), balance: 0, status: 'settled' },
  { name: 'a zero foreign total falls back to a rate of 1', order: order({ totalBase: 80, totalForeign: 0, payments: [pay(30)] }), balance: 50, status: 'outstanding' },
  { name: 'exactly one penny owed is settled', order: order({ payments: [pay(99.99)] }), balance: 0.01, status: 'settled' },
  { name: 'two pence owed is outstanding', order: order({ payments: [pay(99.98)] }), balance: 0.02, status: 'outstanding' },
  { name: 'exactly one penny over-received is settled', order: order({ payments: [pay(100.01)] }), balance: -0.01, status: 'settled' },
  { name: 'two pence over-received is a credit balance', order: order({ payments: [pay(100.02)] }), balance: -0.02, status: 'credit' },
  { name: 'rounding noise under a penny is settled', order: order({ payments: [pay(99.996)] }), balance: 0, status: 'settled' },
]

for (const c of CASES) {
  test(`receivableBalance: ${c.name}`, () => {
    const r = receivableBalance(c.order, c.asOf ?? CUT)
    assert.equal(r.balance, c.balance)
    assert.equal(r.status, c.status)
    assert.equal(r.bound, c.bound ?? 'exact')
  })
}

test('receivableBalance: the same order read at an earlier cutoff differs', () => {
  const o = order({ payments: [pay(100, '2026-06-20')], refunds: [gross(10, '2026-06-25')] })
  assert.equal(receivableBalance(o, d('2026-06-15')).balance, 100)
  assert.equal(receivableBalance(o, d('2026-06-22')).balance, 0)
  assert.equal(receivableBalance(o, d('2026-06-30')).balance, -10)
})

test('receivableBalance: dateless rows count as already happened', () => {
  const r = receivableBalance(order({ payments: [{ amount: 30, refundId: null }], refunds: [{ totalBase: 10, totalsBasis: 'GROSS', lines: [] }] }), CUT)
  assert.equal(r.balance, 60)
})
