import assert from 'node:assert/strict'
import test from 'node:test'

import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { planXeroRoundingLine, predictXeroDocumentTotal, XeroRoundingUnreconcilableError } from '@/lib/connectors/xero/write-path'

/**
 * o3d-hqvrp.389 (owner decision): a Rounding line makes the Xero document total what the IMS order total is, bounded by the existing tolerance (cap 1.00).
 * Pure: the planner and the posting key only. Xero is never contacted.
 */
const RATES: Record<string, number> = { OUTPUT2: 20, NONE: 0 }
const rateOf = (t: string): number | null => RATES[t] ?? null
// The bead's example: two lines of quantity 1 at 0.025 net, 20% VAT. Xero: each line 0.03 + 0.01 tax = 0.04, so the document is 0.08. The order total is 0.06.
const lines = [
  { quantity: 1, unitAmount: 0.025, taxType: 'OUTPUT2' },
  { quantity: 1, unitAmount: 0.025, taxType: 'OUTPUT2' },
]

test('the bead example: with the order total the document gets a -0.02 Rounding line and totals 0.06', () => {
  const line = planXeroRoundingLine({ lines, lineAmountsIncludeTax: false, rateOf, account: '860', what: 'Sales invoice X', orderTotal: 0.06 })
  assert.ok(line, 'a Rounding line is planned')
  assert.equal(line.UnitAmount, -0.02)
  assert.equal(line.TaxType, 'NONE')
  assert.equal(line.AccountCode, '860')
  const after = predictXeroDocumentTotal([...lines, { quantity: 1, unitAmount: -0.02, taxType: 'NONE' }], false, rateOf)
  assert.ok(after.ok && after.total.toNumber() === 0.06)
})

test('without the order total nothing changes: a document 4dp does not alter gets no line (the original behaviour)', () => {
  assert.equal(planXeroRoundingLine({ lines, lineAmountsIncludeTax: false, rateOf, account: '860', what: 'Sales invoice X' }), null)
})

test('a document that already totals the order total gets no line', () => {
  assert.equal(planXeroRoundingLine({ lines, lineAmountsIncludeTax: false, rateOf, account: '860', what: 'Sales invoice X', orderTotal: 0.08 }), null)
})

test('the adjustment is bounded by the reconciliation tolerance: a gap beyond it is refused, nothing is posted', () => {
  assert.throws(
    () => planXeroRoundingLine({ lines, lineAmountsIncludeTax: false, rateOf, account: '860', what: 'Sales invoice X', orderTotal: 5.08 }),
    (e: unknown) => e instanceof XeroRoundingUnreconcilableError,
  )
})

test('no Rounding account mapped: refused rather than posted with a total that differs from the order', () => {
  assert.throws(() => planXeroRoundingLine({ lines, lineAmountsIncludeTax: false, rateOf, account: '', what: 'Sales invoice X', orderTotal: 0.06 }), /Rounding account/)
})

test('an unpredictable tax rate on a document 4dp does not alter is left as it was, not newly refused', () => {
  assert.equal(planXeroRoundingLine({ lines: [{ quantity: 1, unitAmount: 10, taxType: 'MYSTERY' }], lineAmountsIncludeTax: false, rateOf, account: '860', what: 'x', orderTotal: 12 }), null)
})

test('the posting key ignores orderTotal: switching the setting never changes the key of a document already queued', () => {
  const payload = { invoiceNumber: 'INV-1', lines: [{ quantity: 1, unitAmount: 0.025 }], currency: 'GBP' }
  assert.equal(accountingPayloadKey('sales-invoice:o1', { ...payload, orderTotal: 0.06 }), accountingPayloadKey('sales-invoice:o1', payload))
  // and a payload with no orderTotal hashes exactly as it always did
  assert.match(accountingPayloadKey('p', payload), /^p:[0-9a-f]{64}$/)
})
