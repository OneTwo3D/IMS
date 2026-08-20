import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountingSyncType } from '@/app/generated/prisma/enums'
import { XERO_FOLLOW_UP_PAYLOAD_DEBT } from '@/lib/connectors/xero/followup-payload-debt'
import {
  compactedRowLostFollowUps,
  describeLostFollowUps,
} from '@/lib/domain/accounting/compacted-followup-loss'

// ---------------------------------------------------------------------------
// o3d-bqw7 / o3d-kemx — the narrowed question itself.
//
// The behavioural halves live with their callers (tests/accounting/back-reference-sweep.test.ts for
// the repair sweep, tests/accounting/followup-obligation-writers.test.ts for both processor
// short-circuits). What is asserted HERE is the rule they all read, and the two conditions besides
// the type that make it correct — because each of them, got wrong, fails in the direction that
// loses a payment silently or strands a posted row for ever.
// ---------------------------------------------------------------------------

function row(overrides: Partial<Parameters<typeof compactedRowLostFollowUps>[0]> = {}) {
  return {
    type: 'SALES_INVOICE' as const,
    externalTransactionId: 'XINV-1',
    backReferenceEvidenceCompactedAt: new Date('2026-01-05T00:00:00Z'),
    ...overrides,
  }
}

test('[o3d-bqw7] the Xero table decides EVERY sync type — a new one cannot inherit a default', () => {
  // The `Record<AccountingSyncType, …>` makes this a compile error, which is the real guard. This
  // asserts it at runtime as well, because the table is reachable through a cast (the sweep's deps
  // are cast in its own tests) and a missing key would then read as `undefined.debt` at the moment a
  // row of that type is compacted — a crash inside the settle path rather than a decision.
  const members = Object.values(AccountingSyncType)
  assert.ok(members.length > 25, `expected the real enum; saw ${members.length} members`)
  const undecided = members.filter((type) => XERO_FOLLOW_UP_PAYLOAD_DEBT[type] === undefined)
  assert.deepEqual(undecided, [], 'every AccountingSyncType must have a reviewed answer')
})

test('[o3d-bqw7] a type with no branch in enqueueFollowUps lost nothing, however compacted it is', () => {
  assert.equal(compactedRowLostFollowUps(row({ type: 'CREDIT_NOTE' }), XERO_FOLLOW_UP_PAYLOAD_DEBT), false)
  assert.equal(compactedRowLostFollowUps(row({ type: 'COGS_JOURNAL' }), XERO_FOLLOW_UP_PAYLOAD_DEBT), false)
  assert.equal(compactedRowLostFollowUps(row({ type: 'INVOICE_PAYMENT' }), XERO_FOLLOW_UP_PAYLOAD_DEBT), false)
})

test('[o3d-bqw7] a type whose follow-ups are rebuilt from columns lost nothing either', () => {
  assert.equal(
    compactedRowLostFollowUps(row({ type: 'INVOICE_PDF' }), XERO_FOLLOW_UP_PAYLOAD_DEBT),
    false,
    'INVOICE_EMAIL and WC_INVOICE_NOTE are built from the sales order row, not the payload',
  )
})

test('[o3d-bqw7] the three payload-gated types still answer YES — the safe direction is unchanged', () => {
  // `PAYLOAD_BUILT` means the TYPE can owe payload-built work, not that this row did. Whether a
  // sale registered a payment (`payload._registerPayment`) or a bill carried a supplier PDF
  // (`payload.supplierInvoicePath`) was knowable only from what compaction destroyed, so these stay
  // warned about. Narrowing that further would be under-reporting, which loses a payment in silence.
  for (const type of ['SALES_INVOICE', 'PURCHASE_INVOICE', 'PURCHASE_CREDIT_NOTE'] as const) {
    assert.equal(compactedRowLostFollowUps(row({ type }), XERO_FOLLOW_UP_PAYLOAD_DEBT), true, type)
  }
})

test('[o3d-bqw7] the STAMP is what decides, not an empty payload — an intact row is never warned about', () => {
  // The property r3 established and this must not undo: a genuinely bodyless type serialises to the
  // same `{}` a tombstone does, so only the stamp separates "there was nothing to keep" from "what
  // was here has been thrown away".
  assert.equal(
    compactedRowLostFollowUps(row({ backReferenceEvidenceCompactedAt: null }), XERO_FOLLOW_UP_PAYLOAD_DEBT),
    false,
  )
})

test('[o3d-bqw7] a compacted row with NO external id owed no payload-built follow-up to begin with', () => {
  // All three of Xero's payload-gated branches return early without `syncResult.externalId`, and the
  // external id is a column the tombstone KEEPS — so its absence is a fact we can still read after
  // compaction, and it means the enqueue would have done nothing even with the payload intact.
  assert.equal(
    compactedRowLostFollowUps(row({ externalTransactionId: null }), XERO_FOLLOW_UP_PAYLOAD_DEBT),
    false,
  )
})

test('[o3d-bqw7] describing a loss for a type that owes nothing THROWS rather than inventing a phrase', () => {
  // The warning's wording comes from the same table as the decision to warn, so the two cannot
  // disagree. A caller that reaches the builder for a debt-free type is the defect this whole change
  // removes, and it should be loud instead of producing the old catch-all sentence.
  assert.throws(
    () => describeLostFollowUps('CREDIT_NOTE', XERO_FOLLOW_UP_PAYLOAD_DEBT),
    /owes no payload-built follow-up/,
  )
  assert.match(describeLostFollowUps('PURCHASE_INVOICE', XERO_FOLLOW_UP_PAYLOAD_DEBT), /supplier-invoice attachment/)
})
