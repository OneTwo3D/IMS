import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  classifyLedgerSettlement,
  comparableAttemptDate,
  describeAttempt,
  moneyPostDateFieldFor,
  moneyPostDateToSend,
  pinnedAttemptDate,
  settlementMarkerFor,
  type LedgerSettlementRecord,
} from '@/lib/domain/accounting/ledger-settlement-evidence'

/**
 * What the module used to export as `plannedAttemptDate`, spelt out here instead (round 7, Codex
 * HIGH #1). The production path no longer has a function that resolves a wall-clock posting date
 * on demand: the processor resolves it ONCE with `moneyPostDateToSend` and hands the value to the
 * fence, so an on-demand resolver could only be a second resolution site to drift from. The rule
 * it expressed is still worth asserting, so the composition lives in the test, where nothing pays
 * anybody.
 */
const plannedAttemptDate = (type: string, payload: unknown, now: Date): string | null => {
  const sending = moneyPostDateToSend(type, payload, now)
  return sending.ok ? comparableAttemptDate(sending.date) : null
}

/**
 * o3d-0m56 — the rule that decides whether money may move a second time.
 *
 * Every branch here has a direction: a wrong MATCH strands a payment where somebody can see it
 * and act, a wrong CLEAR posts a duplicate into the ledger that nobody is told about. So the
 * tests are written to pin the asymmetry, not merely the happy path.
 */

const attempt = { amount: 10, date: '2026-08-01', marker: null }
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
  for (const partial of [
    { amount: null, date: '2026-08-01', marker: null },
    { amount: 10, date: null, marker: null },
  ]) {
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
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { amount: 12.5, paymentDate: '2026-08-01' }), { amount: 12.5, date: '2026-08-01', marker: null })
  // Allocations carry `date`, payments carry `paymentDate`; both are sliced to 10 characters
  // exactly as the processors slice them — and each type reads ONLY its own field.
  assert.deepEqual(describeAttempt('PURCHASE_CREDIT_NOTE_ALLOCATION', { amount: 1, date: '2026-08-01T09:30:00Z' }), { amount: 1, date: '2026-08-01', marker: null })
  // A zero amount is a real request — the connectors reject an amount only when it is null.
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { amount: 0, paymentDate: '2026-08-01' }), { amount: 0, date: '2026-08-01', marker: null })
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { paymentDate: '2026-08-01' }), { amount: null, date: '2026-08-01', marker: null })
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { amount: 1 }), { amount: 1, date: null, marker: null })
  // A blank or truncated date is not a date. Slicing it anyway would produce a value that can
  // never match a real settlement, which reads as "clear" for the wrong reason.
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { amount: 1, paymentDate: '' }), { amount: 1, date: null, marker: null })
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { amount: 1, paymentDate: '2026-08' }), { amount: 1, date: null, marker: null })
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', null), { amount: null, date: null, marker: null })
})

/* --- round 6, finding 1: the date convention is PER TYPE, and there is only one of it --- */

test('each money type dates itself from ITS OWN field, never the other one (o3d-0m56 r6, CRITICAL 1)', () => {
  const now = new Date('2026-08-18T09:00:00Z')
  // THE DRIFT. Round 5's "mirror" read `paymentDate ?? date` for every type, which is neither
  // processor. A bill payment carrying the BILL's `date` and no `paymentDate` was predicted to
  // post on that day; the processor posts TODAY. The probe then looked for a settlement on a day
  // the post will never create, found none, and authorised a second payment.
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT']) {
    assert.equal(plannedAttemptDate(type, { amount: 10, date: '2026-07-04' }, now), '2026-08-18',
      `${type} does not read \`date\``)
    assert.equal(pinnedAttemptDate(type, { amount: 10, date: '2026-07-04' }), null,
      `${type} pins nothing when only \`date\` is set`)
  }
  // And the same drift the other way round: an allocation dates itself from `date`, so a stray
  // `paymentDate` on its payload is not what Xero will receive.
  assert.equal(plannedAttemptDate('PURCHASE_CREDIT_NOTE_ALLOCATION', { amount: 10, paymentDate: '2026-07-04' }, now), '2026-08-18')
  assert.equal(plannedAttemptDate('PURCHASE_CREDIT_NOTE_ALLOCATION', { amount: 10, date: '2026-07-04' }, now), '2026-07-04')
  assert.equal(pinnedAttemptDate('PURCHASE_CREDIT_NOTE_ALLOCATION', { amount: 10, paymentDate: '2026-07-04' }), null)
})

test('the date table covers every money-moving type, and nothing else (o3d-0m56 r6)', async () => {
  // A fourth money type added without a line in the table must fail VISIBLY at the post rather
  // than silently inherit a convention that may not be its own.
  const { isMoneyMovingSyncType } = await import('@/lib/domain/accounting/followup-retry-guard')
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'PURCHASE_CREDIT_NOTE_ALLOCATION']) {
    assert.ok(isMoneyMovingSyncType(type), `${type} must still be money-moving`)
    assert.notEqual(moneyPostDateFieldFor(type), null, `${type} must say which field dates it`)
  }
  assert.equal(moneyPostDateFieldFor('SALES_INVOICE'), null)
  const unmapped = moneyPostDateToSend('SOME_NEW_MONEY_TYPE', { amount: 1 }, new Date('2026-08-18T09:00:00Z'))
  assert.equal(unmapped.ok, false, 'an unmapped type cannot be dated, so it cannot be sent')
})

test('the processors take their post date from this module, not from their own expression (o3d-0m56 r6, CRITICAL 1)', async () => {
  // The only thing that makes drift IMPOSSIBLE rather than unlikely: there is no second copy to
  // drift from. A branch that recomputes `(payload.paymentDate as string)?.slice(...)` is a copy,
  // however faithful it looks on the day it is written.
  for (const file of ['lib/connectors/xero/sync-processor.ts', 'lib/connectors/quickbooks/sync-processor.ts']) {
    const source = await readFile(path.join(process.cwd(), file), 'utf8')
    assert.equal(/\(payload\.paymentDate as string\)\?\.slice/.test(source), false,
      `${file} must not compute a payment date of its own`)
    assert.equal(/\(payload\.date as string\)\?\.slice\(0, 10\) \|\| new Date\(\)/.test(source), false,
      `${file} must not compute an allocation date of its own`)
    assert.ok(source.includes('moneyPostDateToSend('), `${file} must date its money posts from the shared function`)
  }
})

// --- the date an UNSENT attempt will carry (Codex round 5, finding 1) ---

test('the date an attempt has not yet sent is the date the processor will send (o3d-0m56 r5)', () => {
  const now = new Date('2026-08-18T09:00:00Z')
  // `moneyPostDateToSend` IS what the processors put on the wire, so a row that pins a date keeps
  // it and a row that pins none will carry today — a fact about the imminent POST, not a guess,
  // and what makes such a row describable at all.
  assert.equal(plannedAttemptDate('INVOICE_PAYMENT', { amount: 1, paymentDate: '2026-08-01T00:00:00Z' }, now), '2026-08-01')
  assert.equal(plannedAttemptDate('PURCHASE_CREDIT_NOTE_ALLOCATION', { amount: 1, date: '2026-07-04' }, now), '2026-07-04')
  assert.equal(plannedAttemptDate('INVOICE_PAYMENT', { amount: 1 }, now), '2026-08-18')
  assert.equal(plannedAttemptDate('INVOICE_PAYMENT', { amount: 1, paymentDate: '' }, now), '2026-08-18')
  assert.equal(plannedAttemptDate('INVOICE_PAYMENT', null, now), '2026-08-18')
  // A date field that is SET but unreadable is not "no date": the processors send it verbatim, so
  // the post will carry something the LEDGER will normalise to a value this module cannot
  // predict. Predicting today anyway would describe an attempt that cannot exist, and a
  // description that can never match is a false clear with extra steps.
  assert.equal(plannedAttemptDate('INVOICE_PAYMENT', { amount: 1, paymentDate: '2026-08' }, now), null)
  assert.equal(plannedAttemptDate('INVOICE_PAYMENT', { amount: 1, paymentDate: 20260818 }, now), null)
  // ...and a non-string is refused OUTRIGHT rather than dated, because the processor could only
  // have thrown on it. An array is the one non-string with a `.slice`, so it used to be sent as a
  // JSON list where a date belongs.
  assert.equal(moneyPostDateToSend('INVOICE_PAYMENT', { amount: 1, paymentDate: 20260818 }, now).ok, false)
  assert.equal(moneyPostDateToSend('INVOICE_PAYMENT', { amount: 1, paymentDate: ['2026-08-18'] }, now).ok, false)
  // ...while the value that IS sent verbatim is reported verbatim: the two questions are separate.
  assert.deepEqual(moneyPostDateToSend('INVOICE_PAYMENT', { amount: 1, paymentDate: '2026-08' }, now), { ok: true, date: '2026-08' })
})

test('describeAttempt fills a missing date ONLY from postingOn (o3d-0m56 r5)', () => {
  // The option exists so the caller has to say "this attempt has not happened yet". A pinned date
  // is never overridden, because a past attempt's day is unreconstructable and substituting
  // today's would go looking for a settlement that was never created.
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { amount: 1 }, null, { postingOn: '2026-08-18' }),
    { amount: 1, date: '2026-08-18', marker: null })
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { amount: 1, paymentDate: '2026-08-01' }, null, { postingOn: '2026-08-18' }),
    { amount: 1, date: '2026-08-01', marker: null })
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { amount: 1 }, null, { postingOn: null }),
    { amount: 1, date: null, marker: null })
  assert.deepEqual(describeAttempt('INVOICE_PAYMENT', { amount: 1 }), { amount: 1, date: null, marker: null },
    'and a caller that does not opt in still gets the honest null')
})

// --- the durable mark (Codex round 3) ---

test("a settlement carrying this attempt's own mark IS this attempt (o3d-0m56)", () => {
  // Amount and date are both editable in both ledgers. Correct a committed payment's date in Xero
  // and it stops matching the attempt that created it while still paying the invoice — so a retry
  // would add a second one. The mark does not move.
  const marker = settlementMarkerFor('followup:xero:INVOICE_PAYMENT:SalesOrder:so-1:inv-9')
  const marked = { amount: 10, date: '2026-08-01', marker }

  const edited = classifyLedgerSettlement(marked, {
    ok: true,
    records: [{ amount: 999, date: '2020-01-01', id: 'PAY-1', reference: `Deposit ${marker}` }],
  })
  assert.equal(edited.outcome, 'present', 'neither field matches, and it is still the same payment')
  assert.match(edited.outcome === 'present' ? edited.detail : '', new RegExp(marker))
})

test('another entry\'s mark is not this attempt (o3d-0m56)', () => {
  const mine = settlementMarkerFor('token-a')
  const theirs = settlementMarkerFor('token-b')
  assert.notEqual(mine, theirs)
  assert.deepEqual(
    classifyLedgerSettlement({ amount: 10, date: '2026-08-01', marker: mine }, {
      ok: true,
      records: [{ amount: 4, date: '2026-07-01', reference: theirs }],
    }),
    { outcome: 'clear' },
    'a payment IMS made for something else must not strand this one',
  )
})

test('the mark is stable, short, and derived from the token (o3d-0m56)', () => {
  // It shares a user-visible reference field, so it has to stay short — and it has to be identical
  // for every attempt of the same settlement, which is what makes a retry able to find it.
  const marker = settlementMarkerFor('invoice-payment:payment:p1')
  assert.equal(marker, settlementMarkerFor('invoice-payment:payment:p1'))
  assert.match(marker, /^IMS-[0-9a-f]{12}$/)
})

test('an unmarked settlement still matches on amount and date (o3d-0m56)', () => {
  // Everything posted before IMS started marking its work — and Xero credit-note allocations,
  // which have no reference field at all — can only be recognised this way.
  const marker = settlementMarkerFor('token-a')
  assert.equal(
    classifyLedgerSettlement({ amount: 10, date: '2026-08-01', marker }, {
      ok: true,
      records: [{ amount: 10, date: '2026-08-01', reference: null }],
    }).outcome,
    'present',
  )
})
