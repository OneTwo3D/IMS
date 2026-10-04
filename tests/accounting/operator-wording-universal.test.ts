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
import { describeFollowUpObligationBacklogRow } from '@/lib/domain/accounting/follow-up-obligation-registry'
import { describeEarlierPostings } from '@/lib/domain/accounting/posting-mark-handled'
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
const PROVEN_ROWS: Array<[string, LedgerStandingRow, RegExp, { couldHaveReachedLedger?: boolean }]> = [
  ['RECORDED_PRE_CALL', row({ status: 'CANCELLED', abandonedBeforeRemoteCall: true } as never), /never sent|before the remote call|before any request was made/i, {}],
  ['VERIFIED_REVERSAL', row({ status: 'CANCELLED', settlementBasis: 'VERIFIED_REVERSAL' } as never), /verified reversed|never made/i, {}],
  ['REJECTED_BEFORE_POSTING', row({ status: 'FAILED', errorMessage: 'missing field' } as never), /before posting|before any request/i, { couldHaveReachedLedger: false }],
]
for (const [cause, provenRow, allowed, opts] of PROVEN_ROWS) {
  assert.equal(ledgerStanding(provenRow, opts), 'PROVEN_NOT_POSTED', `precondition: ${cause} row is proven`)
  add(`display badge: PROVEN_NOT_POSTED / ${cause}`, describeLedgerStanding(provenRow, opts).detail, allowed)
  add(`display LABEL: PROVEN_NOT_POSTED / ${cause}`, describeLedgerStanding(provenRow, opts).label ?? '', allowed)
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
      for (const earlierPostingDetails of [[], [{ ref: 'INV-9', standing: 'CONFIRMED_POSTED' as const }], [{ ref: 'INV-9', standing: 'ASSERTED_POSTED' as const }], [{ ref: 'INV-9', standing: 'UNKNOWN' as const }]]) {
        if (retiredUnproven.length === 0 && !earlierPostingDetails.some((e) => e.standing !== 'CONFIRMED_POSTED')) continue // a posting with NO retired attempt is a known-outstanding obligation; its plain "post it" is the baseline, not a non-confirmed standing
        add(`inbox hand-post order: retired=${retiredUnproven.length} queued=${queuedRow} claim=${claim ? (claim.mine ? 'mine' : 'other') : 'none'} earlier=${earlierPostingDetails.map((e) => e.standing).join('+') || 'none'}`,
          handPostOrderFor({ queuedRow, earlierPostingDetails, retiredUnproven, claim }))
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
    const text = handPostOrderFor({ queuedRow: null, earlierPostingDetails: [], retiredUnproven: ['row s-1 (CANCELLED, no proof)'], claim })
    assert.doesNotMatch(text, /post it in the ledger now/i)
    assert.doesNotMatch(text, /Then post it,/)
    assert.match(text, /check the ledger for that document first; post it ONLY if it is absent\. If it exists, do not post again/i)
    assert.deepEqual(unconditionalMoneySentences(text), [])
  }
  // and the plain (no retired attempt) order is unchanged
  assert.match(handPostOrderFor({ queuedRow: null, earlierPostingDetails: [], retiredUnproven: [], claim: { at: 'n', byName: null, mine: true } }), /post it in the ledger now/)
})

// Codex round 6: the claim log and the earlier-posting sentence, per standing.
for (const standing of ['ASSERTED_POSTED', 'UNKNOWN', 'ASSERTED_NOT_POSTED', 'LIVE_WORK'] as LedgerStanding[]) {
  add(`earlier-posting sentence / claim log: ${standing}`, describeEarlierPostings([{ ref: 'INV-9', standing }]))
}

test('[o3d-1e7sl Codex r6] an UNVERIFIED earlier posting (asserted / unproven) keeps its standing in the hand-post order and the claim log: no unconditional "replaces", no "post it in the ledger now"', () => {
  const unconditionalReplaces = (text: string) => text.split(/(?<=[.;])\s+/).filter((c) => /\bREPLACES\b/i.test(c) && !/if it exists/i.test(c))
  for (const standing of ['ASSERTED_POSTED', 'UNKNOWN'] as const) {
    for (const claim of [null, { at: 'now', byName: null, mine: true }, { at: 'now', byName: 'Sam', mine: false }]) {
      for (const queuedRow of [null, 'unsent'] as const) {
        const text = handPostOrderFor({ queuedRow, earlierPostingDetails: [{ ref: 'INV-9', standing }], retiredUnproven: [], claim })
        assert.match(text, /NOT verified/, `${standing}: says IMS has not verified the earlier document`)
        assert.match(text, /If it exists there, your hand posting REPLACES it/)
        assert.match(text, /if it is absent, post this as a new document/)
        assert.deepEqual(unconditionalReplaces(text), [], `${standing}: "replaces" only ever under "if it exists"`)
        assert.doesNotMatch(text, /ALREADY holds|REPLACES that document/, `${standing}: the confirmed-document sentence is not used`)
        if (claim === null || claim.mine) assert.doesNotMatch(text, /post it in the ledger now|Then post it,/i)
        assert.deepEqual(unconditionalMoneySentences(text), [])
      }
    }
    const log = describeEarlierPostings([{ ref: 'INV-9', standing }])
    assert.match(log, /NOT verified/)
    assert.deepEqual(unconditionalReplaces(log), [])
  }
  // a CONFIRMED earlier document keeps the existing wording
  const confirmed = describeEarlierPostings([{ ref: 'INV-9', standing: 'CONFIRMED_POSTED' }])
  assert.match(confirmed, /The ledger ALREADY holds INV-9 for this obligation \(confirmed by the connector\).*REPLACES that document/)
  assert.match(handPostOrderFor({ queuedRow: null, earlierPostingDetails: [{ ref: 'INV-9', standing: 'CONFIRMED_POSTED' }], retiredUnproven: [], claim: { at: 'n', byName: null, mine: true } }), /post it in the ledger now/)
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
  assert.equal(unlicensedHistoryClaims('That is a claim, not proof: IMS never asked the accounting system, and a lost response would leave the same row.', null).length, 1, 'control: a negation earlier in the sentence does not swallow the claim after the colon')
  assert.deepEqual(unlicensedHistoryClaims('Never sent (recorded before the remote call).', /never sent|before the remote call/i), [], 'control: licensed by the pre-call stamp')
  assert.deepEqual(unlicensedHistoryClaims('A failed sync does not prove nothing was posted.', null), [], 'control: a negated / hedged form is not a claim')
  const offenders = strings.map((s) => ({ where: s.where, bad: unlicensedHistoryClaims(s.text, s.allowed) })).filter((o) => o.bad.length > 0)
  assert.deepEqual(offenders, [], 'a string claims a history its cause does not prove')
})

// Codex round 6 - CALL-GRAPH SWEEP. Every function that reduces a sync row to an id / status / amount and then renders or decides
// must carry the STANDING through, or say why not. The reduced-row-shape census in `check:ledger-standing-readers` lists them
// (25); the ones that render or decide on an id without carrying the basis were: the earlier-postings reduction (hand-post
// order, claim log), the follow-up obligation backlog row, and the daily-batch history entry. Each keeps its standing now.
test('[o3d-1e7sl Codex r6] reductions that render an id carry the standing: follow-up backlog row and daily-batch history entry', () => {
  const base = { id: 'r1', connector: 'xero', type: 'SALES_INVOICE', status: 'SYNCED', referenceType: 'SalesOrder', referenceId: 'so-1',
    externalTransactionId: 'INV-1', backReferenceFollowUpsPendingAt: null, backReferenceFollowUpsClaimedAtDatabaseClock: null, createdAt: new Date() }
  assert.equal(describeFollowUpObligationBacklogRow({ ...base, settlementBasis: 'OPERATOR_ASSERTION' }).standingLabel, 'asserted', 'an operator-typed id is labelled in the backlog')
  assert.equal(describeFollowUpObligationBacklogRow({ ...base, settlementBasis: null }).standingLabel, null, 'a confirmed id needs no label')
  const history = read('app/actions/xero-daily-batch.ts')
  assert.match(history, /standingLabel: describeLedgerStanding\(row\)\.label/, 'the daily-batch history entry carries the standing label')
  // Codex round 6: the same history-claim class, found by the call-graph sweep outside the earlier string sets.
  for (const [file, label] of [['lib/domain/accounting/back-reference-sweep.ts', 'back-reference refusal'], ['lib/domain/accounting/deferred-trueup.ts', 'deferred true-up note'], ['lib/domain/accounting/allocation-debit-posting-proof.ts', 'A2 asserted-journal refusal']] as const) {
    assert.doesNotMatch(read(file), /Nobody called|nobody read the document|which nobody read|nobody read its lines/, `${label}: no history claim about an asserted row`)
  }
  assert.match(read('app/actions/accounting-batch.ts'), /standingLabel: entry\.standingLabel/, 'and the generic mapper passes it through')
  assert.match(read('app/(dashboard)/sync/xero-client.tsx'), /entry\.standingLabel &&/, 'and the panel renders it')
  assert.match(read('app/(dashboard)/sync/exceptions/exceptions-client.tsx'), /row\.standingLabel \?/, 'the backlog table renders it')
})
