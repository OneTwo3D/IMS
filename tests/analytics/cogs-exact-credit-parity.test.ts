import assert from 'node:assert/strict'
import test from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import {
  addExactCredit,
  emptyExactCredit,
  exactUnabsorbedInterval,
  exactUnplacedInterval,
  sumExactCredits,
  type ExactCredit,
} from '@/lib/domain/inventory/inventory-costing-reports'
import type { ExactFigure } from '@/lib/domain/math/exact-figure'
import {
  addCredit,
  emptyCredits,
  mergeCredits,
  offRowCreditSummary,
  unplacedCreditInterval,
  type CreditBuckets,
} from '@/lib/domain/sales/refund-credit-buckets'

/**
 * THE COGS REPORT'S EXACT CREDIT BUCKETS ARE THE SHARED DECIMAL ONES, ENTRY FOR ENTRY (review of o3d-rv4a
 * r6, L3).
 *
 * The COGS report keeps its own exact copy of the credit-bucket substrate (inventory-costing-reports.ts:
 * ExactCredit, addExactCredit, exactUnplacedInterval, exactUnabsorbedInterval, sumExactCredits), because
 * it shares a line's credit by quantity and a Decimal share flipped a verdict. A second copy is exactly
 * what drifts, so this ties it to the original in refund-credit-buckets.ts, which the Decimal reports
 * still use. On inputs where Decimal arithmetic is exact (stored four-decimal amounts, no division), the
 * two must agree on EVERY field: the three signed buckets, the three positive parts, both placement
 * flags, the unplaced interval on each figure basis, the merge, and the unabsorbed / off-row interval.
 */

type Entry = { basis: string | null; amount: string }

const FIXTURES: Entry[][] = [
  [],
  [{ basis: 'NET', amount: '100' }],
  [{ basis: 'GROSS', amount: '120' }],
  [{ basis: null, amount: '50.5' }],
  [{ basis: 'GROSS', amount: '120' }, { basis: 'GROSS', amount: '-120' }],
  [{ basis: null, amount: '-7.0001' }, { basis: 'NET', amount: '-3' }, { basis: 'GROSS', amount: '0' }],
  [{ basis: 'nonsense', amount: '9.9999' }, { basis: 'NET', amount: '0' }, { basis: null, amount: '0' }],
  [{ basis: 'NET', amount: '10' }, { basis: 'GROSS', amount: '-4' }, { basis: null, amount: '6' }, { basis: 'GROSS', amount: '2.5' }],
  [{ basis: 'GROSS', amount: '-0.0001' }, { basis: 'GROSS', amount: '0.0001' }, { basis: null, amount: '-12345678901234.5678' }],
]

function decimalOf(entries: Entry[]): CreditBuckets {
  const buckets = emptyCredits()
  for (const entry of entries) addCredit(buckets, entry.basis, entry.amount)
  return buckets
}

function exactOf(entries: Entry[]): ExactCredit {
  const credit = emptyExactCredit()
  for (const entry of entries) addExactCredit(credit, entry.basis, entry.amount)
  return credit
}

function same(exact: ExactFigure, decimal: Prisma.Decimal, what: string): void {
  assert.ok(new Prisma.Decimal(exact.exactString()).eq(decimal), `${what}: exact ${exact.exactString()} vs Decimal ${decimal.toString()}`)
}

function assertParity(exact: ExactCredit, decimal: CreditBuckets, label: string): number {
  let compared = 0
  for (const field of ['net', 'gross', 'unknown', 'netPositive', 'grossPositive', 'unknownPositive'] as const) {
    same(exact[field], decimal[field], `${label} ${field}`)
    compared += 1
  }
  assert.equal(exact.netBasisComplete, decimal.netBasisComplete, `${label} netBasisComplete`)
  assert.equal(exact.grossBasisComplete, decimal.grossBasisComplete, `${label} grossBasisComplete`)
  for (const basis of ['NET', 'GROSS'] as const) {
    const e = exactUnplacedInterval(exact, basis)
    const d = unplacedCreditInterval(decimal, basis)
    same(e.lower, d.lower, `${label} unplaced ${basis} lower`)
    same(e.upper, d.upper, `${label} unplaced ${basis} upper`)
    compared += 2
  }
  // `offRowCreditSummary` is `net + unplaced(NET)` at both ends — the unabsorbed interval on the NET basis.
  const offRow = offRowCreditSummary(decimal).interval
  const unabsorbed = exactUnabsorbedInterval(exact, 'NET')
  same(unabsorbed.lower, offRow.lower, `${label} unabsorbed lower`)
  same(unabsorbed.upper, offRow.upper, `${label} unabsorbed upper`)
  return compared + 2
}

test('addExactCredit and its intervals equal addCredit and its intervals on every fixture', () => {
  let compared = 0
  for (const [index, entries] of FIXTURES.entries()) {
    compared += assertParity(exactOf(entries), decimalOf(entries), `fixture ${index}`)
  }
  // The flags must actually vary across the fixtures, or "they agree" says nothing about them.
  const flags = new Set(FIXTURES.map((entries) => `${exactOf(entries).netBasisComplete}/${exactOf(entries).grossBasisComplete}`))
  assert.ok(flags.size >= 3, `placement flags seen: ${[...flags].join(', ')}`)
  assert.equal(compared, FIXTURES.length * 12)
})

test('sumExactCredits equals mergeCredits over every pair of fixtures', () => {
  let pairs = 0
  for (const a of FIXTURES) {
    for (const b of FIXTURES) {
      const merged = decimalOf(a)
      mergeCredits(merged, decimalOf(b))
      assertParity(sumExactCredits([exactOf(a), exactOf(b)]), merged, 'pair')
      pairs += 1
    }
  }
  assert.equal(pairs, FIXTURES.length ** 2)
})
