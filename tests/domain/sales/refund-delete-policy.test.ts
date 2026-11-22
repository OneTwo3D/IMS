import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IMS_RECORDED_REFUND_SOURCE,
  REFUND_DELETE_REFUSAL_CODES,
  REFUND_DELETE_SETTING,
  creditNoteDay,
  isOnOrBeforeLockDate,
  refundDeleteEnabledFromSetting,
  refundDeleteRefusals,
  refundDispositionAfterDelete,
} from '@/lib/domain/sales/refund-delete-policy'
import { classifyRefundSyncRow } from '@/lib/domain/sales/refund-delete-service'

// o3d-ngmt.22 — the pure half of deleting a refund recorded in error.

test('the switch is off unless the setting says exactly "true"', () => {
  assert.equal(REFUND_DELETE_SETTING, 'refund_delete_enabled')
  assert.equal(refundDeleteEnabledFromSetting(undefined), false)
  assert.equal(refundDeleteEnabledFromSetting(null), false)
  assert.equal(refundDeleteEnabledFromSetting(''), false)
  assert.equal(refundDeleteEnabledFromSetting('TRUE'), false)
  assert.equal(refundDeleteEnabledFromSetting('1'), false)
  assert.equal(refundDeleteEnabledFromSetting('true'), true)
})

test('only a refund an operator recorded in IMS is deletable by source', () => {
  assert.equal(IMS_RECORDED_REFUND_SOURCE, 'MANUAL_UI')
})

test('every refusal reads as operator wording, names its remedy and never carries remote text', () => {
  const all = [
    refundDeleteRefusals.settingOff(),
    refundDeleteRefusals.orderErased(),
    refundDeleteRefusals.woocommerceOrigin(),
    refundDeleteRefusals.automaticOrigin(),
    refundDeleteRefusals.creditNoteSettled(1),
    refundDeleteRefusals.creditNoteSettled(3),
    refundDeleteRefusals.booksLocked('2026-03-01', '2026-03-31'),
    refundDeleteRefusals.stockMoved('cost layers partly consumed'),
    refundDeleteRefusals.stockUntraceable(),
    refundDeleteRefusals.storeCreditOrder(),
    refundDeleteRefusals.accountingInFlight('credit note'),
    refundDeleteRefusals.accountingUncertain('credit note'),
    refundDeleteRefusals.accountingNotQueued('credit note void', 'shadowed'),
    refundDeleteRefusals.accountingNotQueued('credit note void', 'not-configured'),
    refundDeleteRefusals.accountingNotQueued('credit note void', 'refused'),
    refundDeleteRefusals.accountingUnfinished(),
    refundDeleteRefusals.journalUnsupported('allocated inventory'),
    refundDeleteRefusals.inTransitReturn(),
    refundDeleteRefusals.warehouseReleaseInFlight(),
    refundDeleteRefusals.legacyBasis(),
    refundDeleteRefusals.exchangeRefund(),
  ]
  for (const refusal of all) {
    assert.ok(REFUND_DELETE_REFUSAL_CODES.includes(refusal.code), `${refusal.code} is a registered code`)
    assert.ok(refusal.message.length > 40, refusal.code)
    assert.match(refusal.message, /\.$/, `${refusal.code} ends as a sentence`)
    assert.doesNotMatch(refusal.message, /undefined|\[object|null/)
  }
  assert.match(refundDeleteRefusals.woocommerceOrigin().message, /WooCommerce/)
  assert.match(refundDeleteRefusals.woocommerceOrigin().message, /imported again|import it again/i)
  assert.match(refundDeleteRefusals.booksLocked('2026-03-01', '2026-03-31').message, /2026-03-31/)
  assert.match(refundDeleteRefusals.creditNoteSettled(1).message, /1 payment or allocation/)
  assert.match(refundDeleteRefusals.creditNoteSettled(2).message, /2 payments or allocations/)
  // Every registered code has a builder, so a code cannot be added without wording.
  assert.deepEqual([...new Set(all.map((refusal) => refusal.code))].sort(), [...REFUND_DELETE_REFUSAL_CODES].sort())
})

test('lock date: on or before refuses, after passes, and a missing or unreadable lock date locks nothing', () => {
  assert.equal(isOnOrBeforeLockDate('2026-03-31', '2026-03-31'), true)
  assert.equal(isOnOrBeforeLockDate('2026-03-30', '2026-03-31'), true)
  assert.equal(isOnOrBeforeLockDate('2026-04-01', '2026-03-31'), false)
  assert.equal(isOnOrBeforeLockDate('2026-03-31', ''), false)
  assert.equal(isOnOrBeforeLockDate('2026-03-31', null), false)
  assert.equal(isOnOrBeforeLockDate('2026-03-31', 'not a date'), false)
})

test('the credit note day is the payload date when readable, else the London day the refund was recorded', () => {
  const recorded = new Date('2026-05-05T23:30:00.000Z') // 00:30 London on 6 May (BST)
  assert.equal(creditNoteDay('2026-05-04', recorded), '2026-05-04')
  assert.equal(creditNoteDay(undefined, recorded), '2026-05-06')
  assert.equal(creditNoteDay('05/04/2026', recorded), '2026-05-06')
  assert.equal(creditNoteDay(undefined, new Date('2026-12-05T23:30:00.000Z')), '2026-12-05', 'GMT: the UTC day')
})

test('the refund status after a delete is recomputed from the refunds that remain, on the NET basis only', () => {
  const order = { orderTotalBase: '120.00', orderTaxBase: '20.00' }
  assert.equal(refundDispositionAfterDelete({ ...order, remaining: [] }), 'NONE')
  assert.equal(refundDispositionAfterDelete({ ...order, remaining: [{ totalBase: '40.00', totalsBasis: 'NET' }] }), 'PARTIAL')
  assert.equal(refundDispositionAfterDelete({ ...order, remaining: [{ totalBase: '60.00', totalsBasis: 'NET' }, { totalBase: '40.00', totalsBasis: 'NET' }] }), 'FULL')
  // A legacy-basis refund cannot be summed with NET ones: refuse to guess.
  assert.equal(refundDispositionAfterDelete({ ...order, remaining: [{ totalBase: '40.00', totalsBasis: null }] }), null)
  assert.equal(refundDispositionAfterDelete({ ...order, remaining: [{ totalBase: '40.00', totalsBasis: 'NET' }, { totalBase: '10', totalsBasis: 'GROSS' }] }), null)
})

const row = (over: Partial<Parameters<typeof classifyRefundSyncRow>[0]> = {}): Parameters<typeof classifyRefundSyncRow>[0] => ({
  id: 'sync-1',
  type: 'CREDIT_NOTE',
  status: 'PENDING',
  connector: 'xero',
  externalTransactionId: null,
  abandonedBeforeRemoteCall: null,
  settlementBasis: null,
  attemptRevision: 0,
  remoteAttemptedAt: null,
  attemptStampingCustodyAt: new Date('2026-01-01T00:00:00Z'),
  payload: {},
  ...over,
})

test('accounting row verdicts: unsent is retired, posted is voided, anything unproven or in flight refuses', () => {
  // Never sent, never attempted: nothing could have reached the ledger.
  assert.equal(classifyRefundSyncRow(row(), 'credit note').kind, 'retire')
  assert.equal(classifyRefundSyncRow(row({ status: 'FAILED' }), 'credit note').kind, 'retire')
  // #1127 R2: a credit note (or COGS reversal) is never stamped by the money fence, so once it has been CLAIMED (revision >= 1) a null stamp proves nothing: its
  // response may have been lost while the customer was credited in Xero. Refused, never retired, whatever its custody says.
  for (const type of ['CREDIT_NOTE', 'COGS_REVERSAL']) {
    const claimed = classifyRefundSyncRow(row({ type, status: 'FAILED', attemptRevision: 1 }), 'credit note')
    assert.equal(claimed.kind === 'refuse' && claimed.refusal.code, 'accounting_uncertain', type)
    assert.equal(classifyRefundSyncRow(row({ type, status: 'PENDING', attemptRevision: 2 }), 'credit note').kind, 'refuse', type)
  }
  // A money row is stamped before every call, so its null stamp under custody stays the proof it always was.
  assert.equal(classifyRefundSyncRow(row({ type: 'CREDIT_NOTE_ALLOCATION', status: 'FAILED', attemptRevision: 3 }), 'credit note settlement').kind, 'retire')
  // Posted.
  assert.equal(classifyRefundSyncRow(row({ status: 'SYNCED', externalTransactionId: 'cn-1' }), 'credit note').kind, 'posted')
  // In flight.
  const inFlight = classifyRefundSyncRow(row({ status: 'PROCESSING' }), 'credit note')
  assert.equal(inFlight.kind, 'refuse')
  assert.equal(inFlight.kind === 'refuse' && inFlight.refusal.code, 'accounting_in_flight')
  // A failed row that WAS attempted may have reached the ledger without IMS recording the id: not retired on a guess.
  const attempted = classifyRefundSyncRow(row({ status: 'FAILED', remoteAttemptedAt: new Date('2026-01-02T00:00:00Z') }), 'credit note')
  assert.equal(attempted.kind === 'refuse' && attempted.refusal.code, 'accounting_uncertain')
  // A row created outside attempt-stamping custody cannot prove it was never attempted.
  assert.equal(classifyRefundSyncRow(row({ attemptStampingCustodyAt: null }), 'credit note').kind, 'refuse')
  // A cancelled row proven never posted is finished business; an unproven cancel (or a shadow) may stand in the ledger.
  assert.equal(classifyRefundSyncRow(row({ status: 'CANCELLED', abandonedBeforeRemoteCall: true }), 'credit note').kind, 'ignore')
  assert.equal(classifyRefundSyncRow(row({ status: 'CANCELLED' }), 'credit note').kind, 'refuse')
})

test('a counter is never dated before what it counters: a refund deleted on the BST evening it was recorded is dated the LONDON day (not the UTC day before it)', async () => {
  const { refundDeleteCounterDate } = await import('../../../lib/domain/sales/refund-delete-policy.ts')
  // refund recorded 23:20 UTC 30 June (00:20 London 1 July): its COGS reversal / credit note are dated 2026-07-01; deleted 23:40 UTC the same night.
  const now = new Date('2026-06-30T23:40:00Z')
  assert.equal(refundDeleteCounterDate('2026-07-01', now), '2026-07-01')
  assert.notEqual(refundDeleteCounterDate('2026-07-01', now), now.toISOString().slice(0, 10), 'the UTC day would be 30 June: the previous quarter')
  assert.equal(refundDeleteCounterDate(null, now), '2026-07-01', 'no stored day: today\'s London day')
  assert.equal(refundDeleteCounterDate('not-a-day', now), '2026-07-01')
  // deleted later: today; an original dated after today (clock skew) is not countered before it
  assert.equal(refundDeleteCounterDate('2026-07-01', new Date('2026-07-09T10:00:00Z')), '2026-07-09')
  assert.equal(refundDeleteCounterDate('2026-07-03', now), '2026-07-03')
  // the credit-note fallback day is the London day too
  assert.equal(creditNoteDay(undefined, new Date('2026-06-30T23:20:00Z')), '2026-07-01')
})

test('the delete service dates every counter (COGS counter journal and its sub-ledger row, credit-note void) through refundDeleteCounterDate, never the UTC day', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../../lib/domain/sales/refund-delete-service.ts', import.meta.url), 'utf8')
  assert.equal(/toISOString\(\)\.slice\(0, ?10\)/.test(source), false, 'no UTC day derivation left in the service')
  assert.equal((source.match(/refundDeleteCounterDate\(/g) ?? []).length, 2, 'the credit-note void and the COGS counter')
  assert.match(source, /date: counterDate/)
  assert.match(source, /journalDate: counterDate/)
})
