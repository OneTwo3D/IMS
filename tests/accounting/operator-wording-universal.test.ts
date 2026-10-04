import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { describeAssertedPriorAttempt, describeBlockedPriorAttempt, describeUnresolvedPriorAttempt } from '@/lib/domain/accounting/prior-posting-evidence'
import { describeRetiredUnproven, describeSyncRowStanding, retiredUnprovenNotes } from '@/lib/domain/accounting/posting-mark-handled'
import { describeLedgerStanding, describeDocumentIdClaim } from '@/lib/domain/accounting/ledger-standing-display'
import { settlementStatus, type PaymentSyncRow } from '@/lib/domain/accounting/settlement-status'
import { describeMirrorOwnershipSkip, refuseSettlementContradictedByMirror, settlementNote } from '@/lib/domain/accounting/sync-row-settlement'
import { failedUpdateStandingNote } from '@/lib/domain/accounting/rejected-sync-warnings'
import { allocationDebitForeignLedgerReports } from '@/lib/domain/accounting/allocation-debit-passes'
import { ledgerStanding, type LedgerStanding, type LedgerStandingRow } from '@/lib/domain/accounting/ledger-standing'
import * as refusalCopy from '@/lib/domain/accounting/posting-refusal-copy'
import { handPostOrderFor } from '@/lib/domain/accounting/hand-post-order'
import { ROUND_2_SHAPE, ROUND_4_SHAPE, unconditionalMoneySentences, unlicensedHistoryClaims } from '../helpers/unconditional-instruction'

/**
 * o3d-1e7sl Codex round 3 - THE SAME UNIVERSAL-ABSENCE CHECK OVER EVERY OPERATOR STRING THIS PR TOUCHES.
 * (The delete guard's own messages are rendered in tests/sales-order-delete-guard.test.ts, the A2 refusal in
 * tests/accounting/journal-posting-proof-standing.test.ts.) A string attached to a standing the ledger did not
 * confirm may mention reversing / crediting / voiding / re-posting only conditionally on the document existing.
 */
const ROOT = process.cwd()
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
const flat = (text: string) => text.replace(/\s+/g, ' ').replace(/&quot;/g, '"')

function row(over: Partial<LedgerStandingRow>): LedgerStandingRow {
  return { status: 'CANCELLED', externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null, ...over }
}
const NON_CONFIRMED: Array<{ name: string; standing: LedgerStanding; row: LedgerStandingRow }> = [
  { name: 'ASSERTED_POSTED', standing: 'ASSERTED_POSTED', row: row({ status: 'SYNCED', externalTransactionId: 'T-1', settlementBasis: 'OPERATOR_ASSERTION' }) },
  { name: 'ASSERTED_NOT_POSTED', standing: 'ASSERTED_NOT_POSTED', row: row({ settlementBasis: 'OPERATOR_ASSERTION' }) },
  { name: 'UNKNOWN (CANCELLED)', standing: 'UNKNOWN', row: row({}) },
  { name: 'UNKNOWN (FAILED)', standing: 'UNKNOWN', row: row({ status: 'FAILED' }) },
  { name: 'LIVE_WORK', standing: 'LIVE_WORK', row: row({ status: 'PENDING' }) },
]

const strings: Array<{ where: string; text: string; allowed: RegExp | null }> = []
const add = (where: string, text: string, allowed: RegExp | null = null) => strings.push({ where, text, allowed })

for (const c of NON_CONFIRMED) {
  assert.equal(ledgerStanding(c.row), c.standing, `precondition ${c.name}`)
  add(`display badge: ${c.name}`, describeLedgerStanding(c.row).detail)
  add(`display id claim: ${c.name}`, describeDocumentIdClaim({ ...c.row, externalTransactionId: 'DOC-1' }) ?? '')
  add(`mark-handled row: ${c.name}`, describeSyncRowStanding(c.row))
  add(`retired-unproven sentence: ${c.name}`, describeRetiredUnproven(retiredUnprovenNotes([{ ...c.row, id: 's-1' }])))
}
for (const [name, id] of [['asserted-not-posted', 'OPERATOR_ASSERTION'], ['unknown', null]] as const) {
  void name; void id
}
// Codex round 5: the sync-page tooltips for a FAILED attempt whose remote outcome is unknown, and every PROVEN cause with the history it alone licenses.
add('display badge: ASSERTED_POSTED on a FAILED-then-settled attempt', describeLedgerStanding(row({ status: 'SYNCED', externalTransactionId: 'T-9', settlementBasis: 'OPERATOR_ASSERTION', errorMessage: 'socket hang up' } as never)).detail)
add('display badge: ASSERTED_NOT_POSTED on a FAILED-then-settled attempt', describeLedgerStanding(row({ status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION', errorMessage: 'socket hang up' } as never)).detail)
add('display badge: UNKNOWN on a FAILED attempt, remote outcome unknown', describeLedgerStanding(row({ status: 'FAILED', errorMessage: 'socket hang up' } as never)).detail)
assert.equal(ledgerStanding(row({ status: 'SYNCED', externalTransactionId: 'T-9', settlementBasis: 'OPERATOR_ASSERTION' })), 'ASSERTED_POSTED', 'precondition: the failed-then-settled tooltip rows have the standings they are named for')
assert.equal(ledgerStanding(row({ status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' })), 'ASSERTED_NOT_POSTED')
assert.equal(ledgerStanding(row({ status: 'FAILED' })), 'UNKNOWN')
const PROVEN_ROWS: Array<[string, LedgerStandingRow, RegExp]> = [
  ['RECORDED_PRE_CALL', row({ status: 'CANCELLED', abandonedBeforeRemoteCall: true } as never), /never sent|before the remote call|before any request was made/i],
  ['VERIFIED_REVERSAL', row({ status: 'CANCELLED', settlementBasis: 'VERIFIED_REVERSAL' } as never), /verified reversed|never made/i],
  ['REJECTED_BEFORE_POSTING', row({ status: 'FAILED', errorMessage: 'missing field' } as never), /before posting|before any request/i],
]
for (const [cause, provenRow, allowed] of PROVEN_ROWS) {
  if (ledgerStanding(provenRow) !== 'PROVEN_NOT_POSTED') continue
  add(`display badge: PROVEN_NOT_POSTED / ${cause}`, describeLedgerStanding(provenRow).detail, allowed)
}
const enq = { type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'so-1', syncLogId: 'row-1' }
add('enqueue refusal: unresolved (UNKNOWN)', describeUnresolvedPriorAttempt(enq))
add('enqueue refusal: asserted posted', describeAssertedPriorAttempt({ ...enq, externalTransactionId: 'DOC-T' }))
add('enqueue refusal: asserted NOT posted (blocked)', describeBlockedPriorAttempt(enq))
add('NOT_POSTED settlement note', settlementNote({ outcome: 'NOT_POSTED', reason: 'checked' }))
for (const postBasis of ['OPERATOR_ASSERTION', null, undefined]) {
  for (const view of [{ status: 'POSTED', externalId: 'INV-1' }, { status: 'POSTED', externalId: null }]) {
    add(`mirror contradiction (postBasis ${String(postBasis)}, id ${view.externalId})`, refuseSettlementContradictedByMirror({ outcome: 'NOT_POSTED' }, { ...view, postBasis })!.message)
  }
  add(`mirror id conflict (postBasis ${String(postBasis)})`, refuseSettlementContradictedByMirror({ outcome: 'POSTED', externalTransactionId: 'INV-2' }, { status: 'POSTED', externalId: 'INV-1', postBasis })!.message)
}
add('mirror ownership note (asserted sibling)', describeMirrorOwnershipSkip({ syncLogId: 's', status: 'SYNCED', posted: true, assertedDocument: true, sharedKey: 'k' }))
for (const standing of ['CONFIRMED_POSTED', 'ASSERTED_POSTED', 'ASSERTED_NOT_POSTED', 'UNKNOWN', 'LIVE_WORK', 'PROVEN_NOT_POSTED'] as LedgerStanding[]) add(`rejected-update note: ${standing}`, failedUpdateStandingNote(standing))
for (const state of ['asserted', 'unsettled', 'absent'] as const) {
  for (const text of allocationDebitForeignLedgerReports({
    referenceId: 'A2-2026-07-20', scheduledSweepConnector: 'xero',
    foreign: [{ order: 'SO-1', amount: 10, syncLogId: 'J-1', connector: 'other', accountCode: '631' }],
    journalState: () => state,
  })) add(`daily-batch foreign journal report: ${state}`, text)
}
// settlement verdict, both branches, every non-confirmed payment row
const payRows: Array<[string, PaymentSyncRow]> = [
  ['asserted posted', { status: 'SYNCED', externalTransactionId: 'PAY-T', settlementBasis: 'OPERATOR_ASSERTION' }],
  ['asserted not posted', { status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'OPERATOR_ASSERTION' }],
  ['unknown failed', { status: 'FAILED', externalTransactionId: null, errorMessage: 'socket hang up' }],
  ['unknown cancelled', { status: 'CANCELLED', externalTransactionId: null }],
]
for (const [name, payment] of payRows) {
  for (const paidLocally of [true, false]) {
    add(`settlement verdict ${name} paidLocally=${paidLocally}`, settlementStatus({ paidLocally, syncEnabled: true, documentPosted: true, currency: 'GBP', payment, totalForeign: 100 }).detail)
  }
}
// the settle dialog's NOT_POSTED help text and the operator-facing docs, extracted from source
/** The docs table describes every cause side by side, so it may NAME the licensed phrasings ("never sent" is the pre-call cause; "that it was never sent" is the verified-reversal row's does-not-prove cell). */
const DOCS_ALLOWED = /never sent|never-sent|before any request/i
const dialog = flat(read('app/(dashboard)/sync/settle-sync-row-control.tsx'))
const dialogText = dialog.match(/The row is CANCELLED with no external id and recorded as YOUR assertion[\s\S]*?evidence outranks an assertion\./)
assert.ok(dialogText, 'precondition: the settle dialog NOT_POSTED paragraph was extracted')
add('settle dialog NOT_POSTED help', dialogText[0])
const xeroDocs = read('help-docs/xero-sync.md')
const section = xeroDocs.slice(xeroDocs.indexOf('**What the sync pages now show: whose word a row rests on.**'), xeroDocs.indexOf('**Settling "it did not post" retires that attempt, not the document.**'))
assert.ok(section.length > 500, 'precondition: the standing section of xero-sync.md was extracted')
const didNotPost = xeroDocs.slice(xeroDocs.indexOf('- **It did NOT post**'), xeroDocs.indexOf('Read what this is, because it is not a repair.'))
assert.ok(didNotPost.length > 300, 'precondition: the did-not-post bullet was extracted')
add('help-docs/xero-sync.md standing section', flat(section), DOCS_ALLOWED)
add('help-docs/xero-sync.md did-not-post bullet', flat(didNotPost))
const sales = read('help-docs/sales.md')
for (const label of ['| Retired document that is **not proven never-sent**', '| Daily batch |']) {
  const line = sales.split('\n').find((l) => l.startsWith(label))
  assert.ok(line, `precondition: sales.md row ${label}`)
  add(`help-docs/sales.md row ${label}`, flat(line))
}

// Codex round 4: the inbox's "what to do first" text, every claim state x queued-row state x with/without a retired-unproven attempt.
for (const retiredUnproven of [[], ['row s-1 (CANCELLED, no proof)']]) {
  for (const queuedRow of [null, 'unsent', 'may-be-sent'] as const) {
    for (const claim of [null, { at: 'now', byName: 'Sam', mine: false }, { at: 'now', byName: null, mine: true }]) {
      for (const earlierPostings of [[], ['INV-9']]) {
        if (retiredUnproven.length === 0) continue // a posting with NO retired attempt is a known-outstanding obligation; its plain "post it" is the baseline, not a non-confirmed standing
        add(`inbox hand-post order: retired=${retiredUnproven.length} queued=${queuedRow} claim=${claim ? (claim.mine ? 'mine' : 'other') : 'none'} earlier=${earlierPostings.length}`,
          handPostOrderFor({ queuedRow, earlierPostings, retiredUnproven, claim }))
      }
    }
  }
}
for (const [name, text] of Object.entries(refusalCopy)) if (typeof text === 'string') add(`refusal copy: ${name}`, text, name === 'ACCOUNTING_POSTING_REFUSAL_SECTION_DETAIL' ? /Nothing was sent/ : null) // a refusal's own statement: the refusal happened before any send

test('[o3d-1e7sl Codex r4] the widened checker CAN fail: the unconditional hand-post shape and the round-2 shape are both flagged', () => {
  assert.equal(unconditionalMoneySentences(ROUND_4_SHAPE).length, 1)
  assert.equal(unconditionalMoneySentences(ROUND_2_SHAPE).length, 1)
  assert.equal(unconditionalMoneySentences('Look in the ledger and then post it by hand.').length, 1)
  assert.equal(unconditionalMoneySentences('Check the ledger for that document first; post it ONLY if it is absent.').length, 0)
  assert.equal(unconditionalMoneySentences('Posting again could create a SECOND document; it did not post.').length, 0)
})

test('[o3d-1e7sl Codex r4] a retired-unproven hand-post order, claimed or not, makes the post conditional on the document being absent and never says "post it in the ledger now"', () => {
  for (const claim of [null, { at: 'now', byName: null, mine: true }]) {
    const text = handPostOrderFor({ queuedRow: null, earlierPostings: [], retiredUnproven: ['row s-1 (CANCELLED, no proof)'], claim })
    assert.doesNotMatch(text, /post it in the ledger now/i)
    assert.doesNotMatch(text, /Then post it,/)
    assert.match(text, /check the ledger for that document first; post it ONLY if it is absent\. If it exists, do not post again/i)
    assert.deepEqual(unconditionalMoneySentences(text), [])
  }
  // and the plain (no retired attempt) order is unchanged
  assert.match(handPostOrderFor({ queuedRow: null, earlierPostings: [], retiredUnproven: [], claim: { at: 'n', byName: null, mine: true } }), /post it in the ledger now/)
})

test('[o3d-1e7sl Codex r3] every operator string for a non-CONFIRMED standing is free of unconditional reverse / credit / void / re-post instructions', () => {
  console.log(`# r3 universal strings checked: ${strings.length}`)
  assert.ok(strings.length >= 80, 'the population is not vacuous')
  const offenders = strings.map((s) => ({ where: s.where, bad: unconditionalMoneySentences(s.text) })).filter((o) => o.bad.length > 0)
  assert.deepEqual(offenders, [], 'unconditional money instruction(s) on a non-confirmed standing')
})

test('[o3d-1e7sl Codex r5] no rendered string states a history claim its standing / cause does not license (cause -> allowed history table)', () => {
  assert.deepEqual(unlicensedHistoryClaims('IMS made no call, read no document and compared no amount.', null).length, 1, 'control: "made no call" on an asserted standing is flagged')
  assert.deepEqual(unlicensedHistoryClaims('IMS never asked the accounting system.', null).length, 1, 'control: "never asked" is flagged')
  assert.deepEqual(unlicensedHistoryClaims('Never sent (recorded before the remote call).', /never sent|before the remote call/i), [], 'control: licensed by the pre-call stamp')
  assert.deepEqual(unlicensedHistoryClaims('A failed sync does not prove nothing was posted.', null), [], 'control: a negated / hedged form is not a claim')
  const offenders = strings.map((s) => ({ where: s.where, bad: unlicensedHistoryClaims(s.text, s.allowed) })).filter((o) => o.bad.length > 0)
  assert.deepEqual(offenders, [], 'a string claims a history its cause does not prove')
})
