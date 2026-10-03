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
import { unconditionalMoneySentences } from '../helpers/unconditional-instruction'

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

const strings: Array<{ where: string; text: string }> = []
const add = (where: string, text: string) => strings.push({ where, text })

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
const dialog = flat(read('app/(dashboard)/sync/settle-sync-row-control.tsx'))
const dialogText = dialog.match(/The row is CANCELLED with no external id and recorded as YOUR assertion[\s\S]*?evidence outranks an assertion\./)
assert.ok(dialogText, 'precondition: the settle dialog NOT_POSTED paragraph was extracted')
add('settle dialog NOT_POSTED help', dialogText[0])
const xeroDocs = read('help-docs/xero-sync.md')
const section = xeroDocs.slice(xeroDocs.indexOf('**What the sync pages now show: whose word a row rests on.**'), xeroDocs.indexOf('**Settling "it did not post" retires that attempt, not the document.**'))
assert.ok(section.length > 500, 'precondition: the standing section of xero-sync.md was extracted')
const didNotPost = xeroDocs.slice(xeroDocs.indexOf('- **It did NOT post**'), xeroDocs.indexOf('Read what this is, because it is not a repair.'))
assert.ok(didNotPost.length > 300, 'precondition: the did-not-post bullet was extracted')
add('help-docs/xero-sync.md standing section', flat(section))
add('help-docs/xero-sync.md did-not-post bullet', flat(didNotPost))
const sales = read('help-docs/sales.md')
for (const label of ['| Retired document that is **not proven never-sent**', '| Daily batch |']) {
  const line = sales.split('\n').find((l) => l.startsWith(label))
  assert.ok(line, `precondition: sales.md row ${label}`)
  add(`help-docs/sales.md row ${label}`, flat(line))
}

test('[o3d-1e7sl Codex r3] every operator string for a non-CONFIRMED standing is free of unconditional reverse / credit / void / re-post instructions', () => {
  console.log(`# r3 universal strings checked: ${strings.length}`)
  assert.ok(strings.length >= 50, 'the population is not vacuous')
  const offenders = strings.map((s) => ({ where: s.where, bad: unconditionalMoneySentences(s.text) })).filter((o) => o.bad.length > 0)
  assert.deepEqual(offenders, [], 'unconditional money instruction(s) on a non-confirmed standing')
})
