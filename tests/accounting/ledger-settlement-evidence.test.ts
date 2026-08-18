import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyLedgerSettlement,
  describeAttempt,
  type LedgerSettlementRecord,
} from '@/lib/domain/accounting/ledger-settlement-evidence'

/**
 * o3d-0m56 — the rule that decides whether money may move a second time.
 *
 * Every branch here has a direction: a wrong MATCH strands a payment where somebody can see it
 * and act, a wrong CLEAR posts a duplicate into the ledger that nobody is told about. So the
 * tests are written to pin the asymmetry, not merely the happy path.
 */

const attempt = { amount: 10, date: '2026-08-01' }
const records = (...rows: LedgerSettlementRecord[]) => ({ ok: true as const, records: rows })

test('an empty ledger clears the attempt (o3d-0m56)', () => {
  assert.deepEqual(classifyLedgerSettlement(attempt, records()), { outcome: 'clear' })
})

test('same amount AND same date is the attempt (o3d-0m56)', () => {
  const verdict = classifyLedgerSettlement(attempt, records({ amount: 10, date: '2026-08-01', id: 'PAY-1' }))
  assert.equal(verdict.outcome, 'present')
  assert.match(verdict.outcome === 'present' ? verdict.detail : '', /10\.00 dated 2026-08-01 \(PAY-1\)/)
})

test('a settlement of the same size on ANOTHER day is not this attempt (o3d-0m56)', () => {
  // The part-payment case, and why amount alone cannot be the test: an invoice settled in two
  // instalments of the same size would otherwise refuse the second one for ever.
  assert.deepEqual(
    classifyLedgerSettlement(attempt, records({ amount: 10, date: '2026-07-01' })),
    { outcome: 'clear' },
  )
  assert.deepEqual(
    classifyLedgerSettlement(attempt, records({ amount: 40, date: '2026-08-01' })),
    { outcome: 'clear' },
  )
})

test('amounts compare to the half-penny, not exactly (o3d-0m56)', () => {
  // A ledger that rounds, or a float that does not survive a round trip, must not read as a
  // different payment.
  assert.equal(classifyLedgerSettlement(attempt, records({ amount: 10.004, date: '2026-08-01' })).outcome, 'present')
  assert.equal(classifyLedgerSettlement(attempt, records({ amount: 10.02, date: '2026-08-01' })).outcome, 'clear')
})

test('a probe that failed is UNKNOWN, never clear (o3d-0m56)', () => {
  const verdict = classifyLedgerSettlement(attempt, { ok: false, reason: 'HTTP 503' })
  assert.equal(verdict.outcome, 'unknown')
  assert.match(verdict.outcome === 'unknown' ? verdict.reason : '', /HTTP 503/)
})

test('an attempt IMS cannot describe is UNKNOWN (o3d-0m56)', () => {
  // The processors default a missing payment date to "today at post time", which cannot be
  // reconstructed afterwards — so a row that pins neither amount nor date can never be matched,
  // and must not be treated as absent from the ledger.
  for (const partial of [{ amount: null, date: '2026-08-01' }, { amount: 10, date: null }]) {
    assert.equal(classifyLedgerSettlement(partial, records()).outcome, 'unknown', JSON.stringify(partial))
  }
})

test('a ledger record IMS cannot measure is UNKNOWN (o3d-0m56)', () => {
  // A settlement that exists but cannot be read is the most dangerous shape: skipping it would
  // build a "clear" verdict out of an incomplete list.
  assert.equal(classifyLedgerSettlement(attempt, records({ amount: null, date: '2026-08-01' })).outcome, 'unknown')
  assert.equal(classifyLedgerSettlement(attempt, records({ amount: 10, date: null })).outcome, 'unknown')
})

test('the attempt is described from the payload the connector actually sends (o3d-0m56)', () => {
  assert.deepEqual(describeAttempt({ amount: 12.5, paymentDate: '2026-08-01' }), { amount: 12.5, date: '2026-08-01' })
  // Allocations carry `date`, payments carry `paymentDate`; both are sliced to 10 characters
  // exactly as the processors slice them.
  assert.deepEqual(describeAttempt({ amount: 1, date: '2026-08-01T09:30:00Z' }), { amount: 1, date: '2026-08-01' })
  // A zero amount is a real request — the connectors reject an amount only when it is null.
  assert.deepEqual(describeAttempt({ amount: 0, paymentDate: '2026-08-01' }), { amount: 0, date: '2026-08-01' })
  assert.deepEqual(describeAttempt({ paymentDate: '2026-08-01' }), { amount: null, date: '2026-08-01' })
  assert.deepEqual(describeAttempt({ amount: 1 }), { amount: 1, date: null })
  // A blank or truncated date is not a date. Slicing it anyway would produce a value that can
  // never match a real settlement, which reads as "clear" for the wrong reason.
  assert.deepEqual(describeAttempt({ amount: 1, paymentDate: '' }), { amount: 1, date: null })
  assert.deepEqual(describeAttempt({ amount: 1, paymentDate: '2026-08' }), { amount: 1, date: null })
  assert.deepEqual(describeAttempt(null), { amount: null, date: null })
})
