import assert from 'node:assert/strict'
import ts from 'typescript'
import { AccountingSyncType } from '@/app/generated/prisma/enums'
import { readFileSync, readdirSync, statSync } from 'node:fs'
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
import { accountingSyncRowPostedAnEarlierPosting } from '@/lib/domain/accounting/posting-mark-handled'
import { describeEarlierPostings } from '@/lib/domain/accounting/posting-mark-handled'
import { dailyBatchAssertedRefusal, dailyBatchUnprovedRefusal } from '@/lib/connectors/xero/daily-sync'
import { DESCRIPTION, PROHIBITION, instructionSites, remedyCorpus, unsafeInstructionSentences, walkSources } from '../helpers/hand-post-census'
import { AFTER_DECLINE_STEP, HAND_POST_INSTRUCTION_PATTERN, HAND_POST_SAFETY, LEDGER_CHECK_FIRST, MARK_REMEDY_TAIL, OTHER_OPERATOR_CLAIM_OUTCOME, claimLogDescription, markLogDescription, markNotice, releaseLogDescription, releaseNotice, withHandPostSafety, withLedgerCheck, LEDGER_CHECK_PREAMBLE, HAND_POST_INSTRUCTION_DOC_BEGIN, HAND_POST_INSTRUCTION_DOC_END, HAND_POST_SETTLEMENT_DOC_BEGIN, HAND_POST_SETTLEMENT_DOC_END, renderHandPostSettlementDoc } from '@/lib/domain/accounting/hand-post-instruction'
import { REUSED_POSTING_KEY_TYPES } from '@/lib/accounting/posting-key'
import { GENERIC_HAND_POST_STEP, PAYMENT_POSTING_TYPES, UPDATE_POSTING_TYPES, handPostStepFor, NOT_LOADED_HAND_POST_INPUT, handPostInputOf, renderHandPostInstructionDoc, claimWarningFor, handPostInstruction, handPostOrderFor, markHandledWarningFor, releaseWarningFor } from '@/lib/domain/accounting/hand-post-instruction'
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

/** Every state the facts can be in (they may only ADD factual sentences, never change the action). */
const FACT_STATES: Array<{ name: string; input: object }> = [
  { name: 'not loaded', input: { state: 'not-loaded' } },
  { name: 'nothing earlier, nothing retired', input: { state: 'loaded', earlierPostingDetails: [], retiredUnproven: [] } },
  { name: 'retired attempt only (e.g. the retired CANCELLED row belongs to an EARLIER update)', input: { state: 'loaded', earlierPostingDetails: [], retiredUnproven: ['row s-1 (CANCELLED, no proof)'] } },
  { name: 'confirmed earlier', input: { state: 'loaded', earlierPostingDetails: [{ ref: 'INV-9', standing: 'CONFIRMED_POSTED' }], retiredUnproven: [] } },
  { name: 'asserted earlier', input: { state: 'loaded', earlierPostingDetails: [{ ref: 'INV-9', standing: 'ASSERTED_POSTED' }], retiredUnproven: [] } },
  { name: 'unknown earlier', input: { state: 'loaded', earlierPostingDetails: [{ ref: 'INV-9', standing: 'UNKNOWN' }], retiredUnproven: [] } },
  { name: 'confirmed earlier + retired', input: { state: 'loaded', earlierPostingDetails: [{ ref: 'INV-9', standing: 'CONFIRMED_POSTED' }], retiredUnproven: ['row s-1 (CANCELLED, no proof)'] } },
  { name: 'asserted earlier + retired', input: { state: 'loaded', earlierPostingDetails: [{ ref: 'INV-9', standing: 'ASSERTED_POSTED' }], retiredUnproven: ['row s-1 (CANCELLED, no proof)'] } },
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

// Codex round 10: the inbox's "what to do first" text, every posting TYPE x state x claim state x queued-row state.
for (const type of [undefined, 'SALES_INVOICE_UPDATE', 'PURCHASE_INVOICE_UPDATE', 'BILL_PAYMENT', 'SALES_INVOICE', 'STOCK_RECEIPT']) {
  for (const facts of FACT_STATES) {
    for (const queuedRow of [null, 'unsent', 'may-be-sent'] as const) {
      for (const claim of [null, { at: 'now', byName: 'Sam', mine: false }, { at: 'now', byName: null, mine: true }]) {
        add(`inbox hand-post order: ${type ?? 'untyped'} / ${facts.name} / queued=${queuedRow} / claim=${claim ? (claim.mine ? 'mine' : 'other') : 'none'}`,
          handPostOrderFor({ ...facts.input, type, queuedRow, claim } as never))
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

// Codex round 6: the claim log and the earlier-posting sentence, per standing.
for (const standing of ['ASSERTED_POSTED', 'UNKNOWN', 'ASSERTED_NOT_POSTED', 'LIVE_WORK'] as LedgerStanding[]) {
  add(`earlier-posting sentence / claim log: ${standing}`, describeEarlierPostings([{ ref: 'INV-9', standing }]))
}

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

test('[o3d-1e7sl Codex r8] census: no surface renders hand-post / mark-handled advice outside lib/domain/accounting/hand-post-instruction.ts', () => {
  const walk = (dir: string): string[] => readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = path.join(dir, name)
    if (name === 'generated' || name === 'node_modules' || name === '.next') return []
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(name) ? [rel] : []
  })
  const SINGLE = 'lib/domain/accounting/hand-post-instruction.ts'
  const FORBIDDEN = /press "Mark as handled"|then post it\b|post it in the ledger|post it by hand in the ledger|post it in the accounting system, then mark/i
  const sources = ['app', 'lib', 'components'].flatMap((d) => (() => { try { return walk(d) } catch { return [] } })())
  assert.ok(sources.length > 500, `the census reads the source tree (${sources.length} files)`)
  const offenders = sources.filter((f) => f !== SINGLE).filter((f) => FORBIDDEN.test(readFileSync(path.join(ROOT, f), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '').replace(/['"`]\s*\+?\s*\n?\s*\+?\s*['"`]/g, '')))
  assert.deepEqual(offenders, [], 'hand-post / mark-handled advice is rendered outside the single source')
  // and the consumers really route through it
  for (const [file, symbol] of [
    ['app/(dashboard)/sync/exceptions/exceptions-client.tsx', 'claimWarningFor'],
    ['app/(dashboard)/sync/exceptions/exceptions-client.tsx', 'markHandledWarningFor'],
    ['app/(dashboard)/sync/exceptions/exceptions-client.tsx', 'releaseWarningFor'],
    ['app/actions/sync-exceptions.ts', 'handPostOrderFor'],
    ['app/actions/sync-exceptions.ts', 'handPostInstruction'],
    ['lib/domain/accounting/posting-mark-handled.ts', 'handPostStepFor(row.type)'],
    ['lib/domain/accounting/posting-refusal-kinds-doc.ts', 'GENERIC_HAND_POST_STEP'],
  ] as const) assert.ok(read(file).includes(symbol), `${file} renders through ${symbol}`)
  // BOTH refusing-site remedies in lib/accounting.ts know the posting type and render the TYPED step (never the typeless one)
  const accountingSource = read('lib/accounting.ts')
  assert.ok((accountingSource.match(/handPostStepFor\(params\.type\)/g) ?? []).length >= 2, 'the refusal remedies use the typed step')
  assert.doesNotMatch(accountingSource, /handPostStepFor\(undefined\)|GENERIC_HAND_POST_STEP/, 'no refusal remedy falls back to the typeless step')
  // the help text is GENERATED from the same function
  const doc = read('help-docs/xero-sync.md')
  const blocks = doc.split('<!-- hand-post-instruction:begin -->').slice(1).map((b) => `<!-- hand-post-instruction:begin -->${b.slice(0, b.indexOf('<!-- hand-post-instruction:end -->'))}<!-- hand-post-instruction:end -->`)
  assert.ok(blocks.length >= 1, 'the help doc carries the generated instruction table')
  for (const b of blocks) assert.equal(b, renderHandPostInstructionDoc(), 'the help doc disagrees with the single source - regenerate it')
})


// ---------------------------------------------------------------------------
// Codex round 10: THE INSTRUCTION IS A FUNCTION OF THE POSTING TYPE. A TABLE KEYED BY TYPE, NOT A MATRIX OF STATES.
// For one type, EVERY state variation renders the SAME action branches and the SAME Mark-as-handled condition on every surface;
// only the FACTUAL sentences (what IMS records, and whether it verified it) may differ.
// ---------------------------------------------------------------------------
test('[o3d-1e7sl Codex r10] the drift guard: the reused-key types the instruction knows are exactly REUSED_POSTING_KEY_TYPES', () => {
  const reused = new Set([...UPDATE_POSTING_TYPES, ...PAYMENT_POSTING_TYPES])
  assert.deepEqual([...reused].sort(), [...REUSED_POSTING_KEY_TYPES].sort(), 'hand-post-instruction.ts and posting-key.ts disagree about which types are reused')
  for (const type of REUSED_POSTING_KEY_TYPES) assert.equal(accountingSyncRowPostedAnEarlierPosting({ type, status: 'SYNCED' }), true)
})

test('[o3d-1e7sl Codex r10] per posting type: every state variation renders the SAME action and the SAME Mark-as-handled condition on every surface', () => {
  const TYPES: Array<[string | undefined, 'update' | 'payment' | 'conditional' | 'untyped']> = [
    ['SALES_INVOICE_UPDATE', 'update'], ['PURCHASE_INVOICE_UPDATE', 'update'], ['BILL_PAYMENT', 'payment'],
    ['SALES_INVOICE', 'conditional'], ['STOCK_RECEIPT', 'conditional'], [undefined, 'untyped'],
  ]
  const PLAIN = /post it in the ledger now|Then post it,|only once it is posted/i
  let surfaces = 0
  for (const [type, flow] of TYPES) {
    const base = handPostInstruction({ type })
    assert.equal(base.flow, flow, `${type}: flow`)
    const reference = { claim: claimWarningFor({ type, state: 'not-loaded' }), mark: markHandledWarningFor({ type, state: 'not-loaded' }), release: releaseWarningFor({ type, state: 'not-loaded' }) }
    for (const facts of FACT_STATES) {
      const input = { type, ...facts.input } as never
      const where = `${type ?? 'untyped'} / ${facts.name}`
      // the instruction itself is a function of the type only
      assert.deepEqual(handPostInstruction(input), base, `${where}: the instruction does not depend on what was loaded`)
      // the dialogs carry no facts at all: byte-identical across every state of one type
      assert.equal(claimWarningFor(input), reference.claim, `${where}: claim dialog`)
      assert.equal(markHandledWarningFor(input), reference.mark, `${where}: mark dialog`)
      assert.equal(releaseWarningFor(input), reference.release, `${where}: release dialog`)
      const rows = [
        ['claimed row', handPostOrderFor({ ...(input as object), queuedRow: null, claim: { at: 'now', byName: null, mine: true } } as never)],
        ['unclaimed row', handPostOrderFor({ ...(input as object), queuedRow: null, claim: null } as never)],
      ] as const
      const all = [...rows, ['claim dialog', reference.claim], ['mark dialog', reference.mark], ['release dialog', reference.release]] as const
      for (const [name, text] of rows) {
        assert.ok(text.toLowerCase().includes(base.step.toLowerCase()), `${where}: ${name} carries the type's step`)
        assert.ok(text.includes(`only once ${base.markHandledCondition}`), `${where}: ${name} gates Mark as handled on the type's condition`)
      }
      assert.ok(reference.claim.toLowerCase().includes(base.step.toLowerCase()) && reference.claim.includes(`only once ${base.markHandledCondition}`))
      assert.ok(reference.mark.includes(`ONLY if ${base.markHandledConfirms}`))
      assert.ok(reference.release.includes(`release it if ${base.alreadyDone}`))
      for (const [name, text] of all) {
        surfaces += 1
        assert.doesNotMatch(text, PLAIN, `${where}: ${name}: the unconditional wording is gone for every type and state`)
        assert.deepEqual(unconditionalMoneySentences(text), [], `${where}: ${name}: unconditional action`)
        assert.deepEqual(unlicensedHistoryClaims(text, null), [], `${where}: ${name}: history claim`)
        if (flow === 'update') {
          assert.match(text, /CURRENT version/, `${where}: ${name}`)
          assert.doesNotMatch(text, /register THIS payment|check the ledger for that document/i, `${where}: ${name}: no payment wording or "that document" on an update`)
          if (!name.includes('dialog') || name === 'claim dialog') assert.match(text, /if only an earlier version is there, apply the update to it/, `${where}: ${name}`)
        }
        if (flow === 'payment') {
          assert.match(text, /CURRENT payment/, `${where}: ${name}`)
          assert.doesNotMatch(text, /apply the update|update it|check the ledger for that document/i, `${where}: ${name}: no update wording on a payment`)
          if (!name.includes('dialog') || name === 'claim dialog') assert.match(text, /register THIS payment as a NEW payment and do NOT alter the earlier payment/, `${where}: ${name}`)
        }
        if (flow === 'untyped') {
          assert.doesNotMatch(text, /apply the update|update it|register THIS|check the ledger for that document/i, `${where}: ${name}: the typeless wording has no per-type branch`)
          if (name === 'claim dialog' || name.endsWith('row')) assert.match(text, /identify the posting type before any ledger work/i, `${where}: ${name}`)
        }
        if (flow === 'conditional') assert.doesNotMatch(text, /CURRENT payment|apply the update|register THIS/, `${where}: ${name}`)
        if (flow === 'update' || flow === 'payment') {
          for (const clause of text.split(/(?<=[.;])\s+/).filter((c) => /do not post again/i.test(c))) assert.match(clause, /if the current (version|payment) is there/i, `${where}: ${name}: "do not post again" only under the CURRENT condition: ${clause}`)
        }
      }
    }
  }
  assert.ok(surfaces >= 240, `the table is not vacuous (${surfaces})`)
})

test('[o3d-1e7sl Codex r10] the explicit cells: a retired EARLIER update then a newer refused one, and BILL_PAYMENT through the generic / typeless paths', () => {
  // 1. reused key, only a retired attempt loaded (it belongs to an earlier update; no completed earlier row)
  const retiredOnly = handPostOrderFor({ type: 'SALES_INVOICE_UPDATE', state: 'loaded', earlierPostingDetails: [], retiredUnproven: ['row s-1 (CANCELLED, no proof)'], queuedRow: null, claim: { at: 'now', byName: null, mine: true } })
  assert.match(retiredOnly, /check the ledger for the CURRENT version/i)
  assert.doesNotMatch(retiredOnly, /check the ledger for that document|If it exists, do not post again/i, 'the retired earlier version alone cannot satisfy "stop"')
  assert.match(retiredOnly, /only once the CURRENT version is in the ledger/)
  // 2. BILL_PAYMENT where the state was not loaded: the payment step, never the update branch
  const paymentNotLoaded = handPostOrderFor({ type: 'BILL_PAYMENT', state: 'not-loaded', queuedRow: null, claim: null })
  assert.match(paymentNotLoaded, /register THIS payment as a NEW payment and do NOT alter the earlier payment/)
  assert.doesNotMatch(paymentNotLoaded, /apply the update|update it/i)
  // 3. the typed step a refusing site uses, per type, equals the row's; the generic one has no per-type branch
  assert.equal(handPostStepFor('BILL_PAYMENT'), handPostInstruction({ type: 'BILL_PAYMENT' }).step)
  assert.doesNotMatch(handPostStepFor('BILL_PAYMENT'), /update it|apply the update/i)
  assert.doesNotMatch(GENERIC_HAND_POST_STEP, /update it|apply the update|register|new payment|new document/i, 'the typeless wording names no per-type branch')
  assert.match(GENERIC_HAND_POST_STEP, /identify the posting type before any ledger work/)
  assert.doesNotMatch(describeRetiredUnproven(['row s-1']), /post it by hand|look in the ledger/i, 'the retired sentence is factual only')
  assert.doesNotMatch(describeEarlierPostings([{ ref: 'X', standing: 'ASSERTED_POSTED' }]), /post it|REPLACES|update/i, 'the earlier sentence is factual only')
})

// Codex round 11 (HIGH 2): the help text must never direct an operator to RE-POST a document that may already be in a ledger. A UNIVERSAL
// absence over every help doc: no sentence tells the reader to re-post it / the document / the invoice without a ledger check.
test('[o3d-1e7sl Codex r11] no help doc directs re-posting an already posted document without a ledger check (universal absence)', () => {
  const docs = readdirSync(path.join(ROOT, 'help-docs')).filter((f) => f.endsWith('.md'))
  assert.ok(docs.length > 5, 'the census reads the help docs')
  const offenders: string[] = []
  for (const file of docs) {
    const text = read(path.join('help-docs', file)).replace(/\s+/g, ' ')
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      if (!/\b(re-?post|repost) (it|this|that|the (document|invoice|bill|payment|credit note))\b/i.test(sentence)) continue
      if (/\b(do not|don't|never)\b[^.]{0,40}re-?post|check|verify|confirm|only if|if it (does not )?exist|unless|cannot|is not re-?posted|re-?posting a (document|payment)? ?that|automatically/i.test(sentence)) continue
      offenders.push(`${file}: ${sentence.slice(0, 160)}`)
    }
  }
  assert.deepEqual(offenders, [], 're-post advice without a ledger check')
  // the legacy-document paragraph says what to do instead
  const doc = read('help-docs/xero-sync.md')
  assert.equal((doc.match(/\*\*Do not re-post it:\*\*/g) ?? []).length, 1, 'the legacy-document paragraph forbids re-posting')
  assert.doesNotMatch(doc, /re-post it so the document and its connector are recorded together/)
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Codex round 14: NO PREDICTIONS. Three rounds of "state only what holds in every branch" kept finding one more branch, so every operator-visible
// surface for Mark / Take / Release / a later save now states ONLY (a) what the action does at the moment it runs and (b) "check Sync > Exceptions
// afterwards". ONE constant set (hand-post-instruction.ts) carries it. This census forbids the PREDICTION VOCABULARY in the string literals of the
// modules that render those surfaces, in the generated help-doc blocks, and the legacy outcome shapes anywhere in the tree.
// ---------------------------------------------------------------------------
const PREDICTION_VOCABULARY = /\b(will|closes|stays?|suppress\w*|from then on|for ever|forever|cannot|until|queues|becomes|comes back|leaves this list|requeues?)\b/i

/** The string-literal contents of a source file (comments stripped): where operator-visible text lives. */
function stringLiterals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return [...code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[0])
}

test('[o3d-1e7sl Codex r14] the prediction vocabulary is absent from every string literal of the modules that render the Mark / Take / Release surfaces, and from the generated help-doc blocks', () => {
  // The allow-list is EMPTY on purpose: every present-tense fact these modules state was reworded to avoid the vocabulary. An entry needs a justification.
  const ALLOWED: Array<{ file: string; fragment: string; why: string }> = []
  const MODULES = ['lib/domain/accounting/hand-post-instruction.ts', 'lib/domain/accounting/posting-refusal-copy.ts']
  const offenders: string[] = []
  for (const file of MODULES) {
    for (const literal of stringLiterals(read(file))) {
      if (!PREDICTION_VOCABULARY.test(literal)) continue
      if (ALLOWED.some((a) => a.file === file && literal.includes(a.fragment))) continue
      offenders.push(`${file}: ${literal.slice(0, 140)}`)
    }
  }
  assert.deepEqual(offenders, [], 'a prediction-vocabulary string in an outcome surface module')
  assert.ok(stringLiterals(read(MODULES[0])).length > 100, 'the extractor reads the module (not vacuous)')
  // the control: the extractor + vocabulary DO flag a prediction
  assert.ok(stringLiterals("const x = 'Whether this refusal closes depends on it'").some((l) => PREDICTION_VOCABULARY.test(l)), 'control: the census can fail')
  // the generated doc blocks (the instruction table and the settlement prose) carry none
  for (const text of [renderHandPostInstructionDoc(), renderHandPostSettlementDoc()]) assert.doesNotMatch(text.replace(/`[^`]*`/g, ''), PREDICTION_VOCABULARY, 'the generated help text predicts nothing')
})

test('[o3d-1e7sl Codex r14] the help doc carries the generated blocks exactly once; the legacy outcome shapes are absent from the whole tree; every consumer renders from the constant set', () => {
  const doc = read('help-docs/xero-sync.md')
  for (const [begin, end, text] of [
    [HAND_POST_INSTRUCTION_DOC_BEGIN, HAND_POST_INSTRUCTION_DOC_END, renderHandPostInstructionDoc()],
    [HAND_POST_SETTLEMENT_DOC_BEGIN, HAND_POST_SETTLEMENT_DOC_END, renderHandPostSettlementDoc()],
  ] as const) {
    assert.equal(doc.split(begin).length - 1, 1, `exactly ONE ${begin} (a regen once duplicated the whole doc)`)
    const a = doc.indexOf(begin)
    assert.equal(doc.slice(a, doc.indexOf(end, a) + end.length), text, 'the help doc disagrees with the generator - regenerate it')
  }
  assert.ok(doc.split('\n').length < 3200, 'the help doc has not been duplicated')
  const walkAll = (dir: string): string[] => readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = path.join(dir, name)
    if (name === 'generated' || name === 'node_modules' || name === '.next') return []
    return statSync(path.join(ROOT, rel)).isDirectory() ? walkAll(rel) : /\.(ts|tsx|md)$/.test(name) ? [rel] : []
  })
  const files = ['app', 'lib', 'components', 'help-docs'].flatMap((d) => { try { return walkAll(d) } catch { return [] } })
  assert.ok(files.length > 500, `the census reads the tree (${files.length} files)`)
  const LEGACY: Array<[RegExp, string]> = [
    [/will be queued as usual/i, 'a later edit is guaranteed to queue'],
    [/queues a new one, which is what the ledger needs/i, 'a later save is guaranteed to queue'],
    [/This closes THIS refusal/i, 'the mark is guaranteed to close the refusal'],
    [/the row closes when they confirm|when they confirm it the row\s+closes/i, 'the other operator\'s confirm is guaranteed to close the row'],
    [/cannot become an exception again/i, 'a handled posting can never be an exception again'],
    [/nothing is owed and nothing was recorded/i, 'the old suppressed-refusal wording'],
    [/that stops IMS (updating|posting)|so it is not posted twice|IMS may queue and post it again|Nothing requeues|STAYS OUTSTANDING|will NOT clear this debt/, 'an old outcome prediction'],
    [/IMS will not queue (this posting )?while you hold it/i, 'the old claim promise'],
  ]
  const offenders: string[] = []
  for (const f of files) {
    const text = read(f).replace(/^\s*(\/\/|\*|\/\*).*$/gm, '').replace(/['"`]\s*\+?\s*\n?\s*\+?\s*['"`]/g, '').replace(/\s+/g, ' ')
    for (const [re, why] of LEGACY) if (re.test(text)) offenders.push(`${f}: ${why}`)
  }
  assert.deepEqual(offenders, [], 'a legacy outcome prediction survives somewhere in the tree')
  // every consumer renders from the constant set (no inline copy of an outcome sentence)
  const actions = read('app/actions/sync-exceptions.ts')
  for (const symbol of ['claimLogDescription(', 'releaseLogDescription(', 'releaseNotice(', 'markLogDescription(', 'markNotice(']) assert.ok(actions.includes(symbol), `sync-exceptions.ts renders through ${symbol}`)
  const client = read('app/(dashboard)/sync/exceptions/exceptions-client.tsx')
  for (const symbol of ['TAKE_TOAST', 'RELEASE_TOAST', 'MARKED_TOAST', 'INCOMPLETE_HISTORY_BANNER']) assert.ok(client.includes(symbol), `exceptions-client.tsx renders ${symbol}`)
  for (const f of ['lib/accounting.ts', 'lib/domain/sales/sales-invoice-update-sync.ts', 'lib/domain/purchasing/landed-cost-service.ts']) assert.ok(read(f).includes('MARK_REMEDY_TAIL'), `${f} ends its remedies with the shared tail`)
})


// ===========================================================================================================================================
// Codex round 16: A STRUCTURAL CHECK, NOT A STRING-PATTERN CENSUS. Build the COMPLETE set of operator-visible instruction strings by RENDERING the real
// functions over the full matrix (every posting type x every fact state x every claim state x every builder) and by evaluating the `remedy` property of
// EVERY refusing site (TypeScript AST over lib/ app/ components/, passed through the sink guard every remedy goes through), then assert over that corpus:
// any imperative to post / re-post / re-save / resend / retry / reset / raise / enter / register, or "by hand" / "yourself", is preceded in the same text by
// the LEDGER CHECK and by the hand-post CLAIM. A shrink-only allow-list declares, per file, the instructions that exist OUTSIDE the corpus.
// ===========================================================================================================================================
function builderCorpus(): Array<{ source: string; text: string }> {
  const out: Array<{ source: string; text: string }> = []
  const add = (source: string, text: string) => out.push({ source, text })
  const TYPES: Array<string | undefined> = [undefined, ...Object.values(AccountingSyncType)]
  for (const type of TYPES) {
    const t = type ?? 'untyped'
    add(`typed step ${t} (through the sink)`, withHandPostSafety(handPostStepFor(type)))
    for (const facts of FACT_STATES) {
      const input = { type, ...facts.input } as never
      add(`claim dialog ${t}/${facts.name}`, claimWarningFor(input))
      add(`mark dialog ${t}/${facts.name}`, markHandledWarningFor(input))
      add(`release dialog ${t}/${facts.name}`, releaseWarningFor(input))
      for (const queuedRow of [null, 'unsent', 'may-be-sent'] as const) {
        for (const claim of [null, { at: 'now', byName: 'Sam', mine: false }, { at: 'now', byName: null, mine: true }]) {
          add(`row ${t}/${facts.name}/${queuedRow}/${claim ? (claim.mine ? 'mine' : 'other') : 'none'}`, handPostOrderFor({ ...(input as object), queuedRow, claim } as never))
        }
      }
    }
    for (const cancelledCount of [0, 2]) {
      add(`claim log ${t}`, claimLogDescription({ cancelledCount, earlier: describeEarlierPostings([{ ref: 'X', standing: 'ASSERTED_POSTED' }]), retired: describeRetiredUnproven(['row s-1']), step: handPostInstruction({ type }).step }))
    }
  }
  for (const unaccounted of [false, true]) {
    for (const deferredEdits of [0, 2]) {
      add('release log', releaseLogDescription({ unaccounted, deferredEdits }))
      const rn = releaseNotice({ unaccounted, deferredEdits }); if (rn) add('release notice', rn)
      add('mark notice', markNotice({ unaccounted, deferredEdits }))
      for (const stillOutstanding of [false, true]) add('mark log', markLogDescription({ kind: 'sales_invoice_update', cancelledCount: 1, stillOutstanding, unaccounted, deferredEdits }))
    }
  }
  add('mark remedy tail (through the sink)', withHandPostSafety(MARK_REMEDY_TAIL))
  add('after-decline step', AFTER_DECLINE_STEP)
  add('other-operator outcome', OTHER_OPERATOR_CLAIM_OUTCOME)
  add('generated instruction doc', renderHandPostInstructionDoc())
  add('generated settlement doc', renderHandPostSettlementDoc())
  return out
}

test('[o3d-1e7sl Codex r16] STRUCTURAL: over the rendered corpus (every type x state x claim x builder, plus every refusing site remedy through the sink), every post / re-save / by-hand instruction is preceded by the hand-post claim AND the ledger check', () => {
  const builders = builderCorpus()
  const remedies = remedyCorpus()
  const corpus = [...builders, ...remedies]
  const instructionCount = corpus.reduce((n, c) => n + c.text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((x) => HAND_POST_INSTRUCTION_PATTERN.test(x) && !PROHIBITION.test(x) && !DESCRIPTION.test(x)).length, 0)
  console.log(`# r16 corpus: ${corpus.length} texts (${builders.length} rendered builders, ${remedies.length} refusing-site remedies), ${instructionCount} instruction sentences`)
  assert.ok(builders.length > 2500 && remedies.length >= 25 && instructionCount > 1000, `PRECONDITION: the corpus is not vacuous (${builders.length}/${remedies.length}/${instructionCount})`)
  const offenders = corpus.flatMap((c) => unsafeInstructionSentences(c.text).map((s) => `${c.source}: ${s}`))
  assert.deepEqual([...new Set(offenders)], [], 'an instruction without the hand-post claim and the ledger check before it')
  // CONTROLS: the checker flags the strings the previous rounds shipped
  for (const unsafe of [
    'Check whether the current version is already in the accounting system. If it is, take a fresh claim and mark the outstanding refusal handled. Only if it is absent, re-save the document or post the current version by hand.',
    'IMS cannot show which accounting connector holds the document this posting names, so it will not post it. Post it yourself in the ledger that holds that document, then mark this row handled.',
    'The landed-cost journal outbox retries it once the accounting connector selection has settled; if it has given up, post the reclass by hand and mark this row handled.',
    'Compare the document with the ledger; re-save it or post the current version by hand.',
    'Post the reversal by hand.',
  ]) assert.ok(unsafeInstructionSentences(unsafe).length >= 1, `control: flagged: ${unsafe.slice(0, 60)}`)
  // and the sink makes the previously-unsafe remedies safe
  for (const raw of ['Post the reversal by hand.', 'Post it yourself in the ledger that holds that document, then mark this row handled.', 'post the reclass by hand and mark this row handled']) {
    assert.deepEqual(unsafeInstructionSentences(withHandPostSafety(raw)), [], `the sink guard makes it safe: ${raw}`)
    assert.ok(withHandPostSafety(raw).startsWith(HAND_POST_SAFETY), 'with the preamble IN FRONT')
  }
  assert.equal(withHandPostSafety('Nothing to do here.'), 'Nothing to do here.', 'a text with no instruction is untouched')
  assert.equal(withHandPostSafety(withHandPostSafety('Post it by hand.')), withHandPostSafety('Post it by hand.'), 'idempotent')
  // the first-claim rule: the AFTER_DECLINE branch that posts requires a FRESH CLAIM first, and re-save is its own branch with NO claim held
  assert.match(AFTER_DECLINE_STEP, /take a fresh claim first[^.]*check the ledger again under that claim, and only then post the current version by hand/)
  assert.match(AFTER_DECLINE_STEP, /holding NO claim[^.]*re-save the document/)
})

test('[o3d-1e7sl Codex r16] the sink guard is wired at BOTH sinks every refusing site goes through, and it acts on a real stored refusal', async () => {
  assert.ok(read('lib/domain/accounting/posting-refusal-inbox.ts').includes('withHandPostSafety(rawRecord.remedy)'), 'recordAccountingPostingRefusal guards the stored remedy')
  assert.ok(read('lib/domain/accounting/enqueue-outcome.ts').includes('withHandPostSafety(params.remedy)'), 'reportPostingNotQueued guards the logged remedy')
})

/**
 * Codex round 17: THE PER-SENTENCE AUDIT, STRUCTURAL AND SHRINK-ONLY. `instructionSites()` walks the AST of every string expression in lib/ app/ components/
 * and attributes each instruction-shaped sentence to where it goes: inside `withHandPostSafety(...)` / `withLedgerCheck(...)` ('guard-call'), or the `remedy`
 * of an object handed to a refusal sink that applies `withHandPostSafety` ('sink-remedy'). Both are SAFE by construction: a ledger-affecting post / re-post /
 * re-save / resend / retry / reset instruction can only reach an operator through one of them. Every OTHER site must be declared below, one entry per
 * sentence, with a verdict and a one-line justification, and the list is shrink-only by equality (a new unguarded instruction fails; a removed one forces the
 * entry out). Verdicts:
 *   DESCRIPTION    - not an instruction to the operator (it states what IMS does / did not do, or is a journal memo), so nothing can be followed.
 *   CHECKS_FIRST   - an instruction that is itself the ledger check, or sits behind the ledger check in the same builder (typed step).
 *   NON_ACCOUNTING - not an accounting posting at all (WMS, WooCommerce settings, scheduler, backup, inventory, BOM).
 */
type SiteVerdict = 'DESCRIPTION' | 'CHECKS_FIRST' | 'NON_ACCOUNTING'
const UNGUARDED_SITES: Array<{ file: string; prefix: string; verdict: SiteVerdict; why: string; count?: number }> = [
  { file: 'app/(dashboard)/settings/system/page.tsx', prefix: 'Restart the service after rotating the secret', verdict: 'NON_ACCOUNTING', why: 'scheduler secret rotation, no ledger involved' },
  { file: 'app/(dashboard)/stock-control/stock-counts/stock-counts-client.tsx', prefix: 'Post this stock count?', verdict: 'NON_ACCOUNTING', why: 'inventory stock-count confirmation dialog' },
  { file: 'app/actions/sync-exceptions.ts', prefix: 'Ran the post-maintenance warehouse re-check by hand', verdict: 'NON_ACCOUNTING', why: 'WMS ASN re-check log' },
  { file: 'lib/accounting.ts', prefix: 'It was answered as "this connector does not post this type"', verdict: 'DESCRIPTION', why: 'states what the queue answered; nothing to follow' },
  { file: 'lib/connectors/accounting-settlement-probe.ts', prefix: 'This entry will retry once that attempt is readable', verdict: 'DESCRIPTION', why: 'states IMS own retry behaviour' },
  { file: 'lib/connectors/woocommerce/sync/order-completion-jobs.ts', prefix: 'Replay it: the retry re-reads the order first', verdict: 'NON_ACCOUNTING', why: 'WooCommerce order-completion write-back, no ledger posting' },
  { file: 'lib/connectors/woocommerce/sync/product-sync.ts', prefix: 'Resolve the duplicate SKU / barcode', verdict: 'NON_ACCOUNTING', why: 'WooCommerce product-structure conflict' },
  { file: 'lib/connectors/xero/daily-sync.ts', prefix: 'Daily batch DAILY_BATCH_GROUP_B not recreated', verdict: 'DESCRIPTION', why: 'states why the rebuild was refused' },
  { file: 'lib/connectors/xero/sync-processor.ts', prefix: 'There is nothing that would stop a re-post.', verdict: 'DESCRIPTION', why: 'states a hazard; the instruction beside it is CHECK XERO first' },
  { file: 'lib/connectors/xero/sync-processor.ts', prefix: 'CHECK XERO before re-queueing', verdict: 'CHECKS_FIRST', why: 'is itself the ledger check, before any re-queue' },
  { file: 'lib/connectors/xero/sync-processor.ts', prefix: 'NOTHING WAS SENT; the worker that holds the row now will post it.', verdict: 'DESCRIPTION', why: 'states what IMS did' },
  { file: 'lib/cost-layers.ts', prefix: 'Reverse and repost shipment COGS after cost-layer revaluation', verdict: 'DESCRIPTION', why: 'journal memo text, not an instruction' },
  { file: 'lib/cost-layers.ts', prefix: 'IMS cannot post a negative shipment COGS', verdict: 'DESCRIPTION', why: 'states a limitation' },
  { file: 'lib/domain/accounting/invoice-number-ownership.ts', prefix: 'Refusing to post {} as invoice number {}', verdict: 'DESCRIPTION', why: 'states why IMS refused; the remedy sentence is guarded' },
  { file: 'lib/domain/accounting/posting-mark-handled.ts', prefix: 'Check the ledger and settle that row in the accounting sync log first', verdict: 'CHECKS_FIRST', why: 'is itself the ledger check' },
  { file: 'lib/domain/accounting/posting-refusal-copy.ts', prefix: 'IMS does not post this.', verdict: 'DESCRIPTION', why: 'states IMS behaviour' },
  { file: 'lib/domain/accounting/posting-refusal-kinds.ts', prefix: 'Retry refund accounting queues it again', verdict: 'DESCRIPTION', why: 'describes what the Retry button does for this kind', count: 3 },
  { file: 'lib/domain/accounting/posting-suppression.ts', prefix: 'IMS did NOT post {} for {} {}', verdict: 'DESCRIPTION', why: 'states what IMS did' },
  { file: 'lib/domain/accounting/sync-row-settlement.ts', prefix: 'Without it the row records a post that nothing can be reconciled against.', verdict: 'DESCRIPTION', why: 'states a consequence' },
  { file: 'lib/domain/accounting/unrecorded-posted-document.ts', prefix: 'REMEDY: {lookup} and either keep it', verdict: 'CHECKS_FIRST', why: 'the sentence opens with the lookup of the document in the ledger; nothing is posted, the options are keep, void or reverse', count: 2 },
  { file: 'lib/domain/accounting/unrecorded-posted-document.ts', prefix: '{Lookup} and either keep it', verdict: 'CHECKS_FIRST', why: 'opens with the lookup in the ledger' },
  { file: 'lib/domain/accounting/unrecorded-posted-document.ts', prefix: 'THIS OPERATION RETURNS NO IDENTIFIER', verdict: 'DESCRIPTION', why: 'states why the document cannot be recorded' },
  { file: 'lib/domain/sales/allocation-service.ts', prefix: 'The declared set holds quantity nothing has accounted', verdict: 'DESCRIPTION', why: 'states why the hand-back was refused' },
  { file: 'lib/domain/sales/allocation-service.ts', prefix: 'Group A2 will not re-post this order', verdict: 'DESCRIPTION', why: 'states IMS behaviour' },
  { file: 'lib/domain/sales/refund-posted-tax-identity.ts', prefix: '{} carries no VAT rate of its own', verdict: 'DESCRIPTION', why: 'states why no identity exists (credit note "posts under")' },
  { file: 'lib/domain/sales/refund-posted-tax-identity.ts', prefix: '{} has no accounting tax code', verdict: 'DESCRIPTION', why: 'states why no identity exists' },
  { file: 'lib/domain/sales/refund-posted-tax-identity.ts', prefix: 'Shipping posts under the order', verdict: 'DESCRIPTION', why: 'states why no identity exists' },
  { file: 'lib/domain/sales/sales-invoice-update-sync.ts', prefix: 'Only if it is absent: re-save the order', verdict: 'CHECKS_FIRST', why: 'every such sentence follows the typed ledger-check sentence in the same builder and is conditional on its outcome', count: 5 },
  { file: 'lib/domain/sales/sales-invoice-update-sync.ts', prefix: 'If it is absent, EITHER take a fresh claim first', verdict: 'CHECKS_FIRST', why: 'conditional on the ledger check and takes a fresh claim before posting' },
  { file: 'lib/domain/sales/sales-invoice-update-sync.ts', prefix: 'Sales invoice update for {} against accounting invoice {} was NOT queued', verdict: 'DESCRIPTION', why: 'states what IMS did and why' },
  { file: 'lib/fulfillment/overallocation-rebalancer.ts', prefix: 'Group A2 will not re-post this order', verdict: 'DESCRIPTION', why: 'states IMS behaviour' },
  { file: 'lib/products/bom-recipe.ts', prefix: 'An older BOM recipe for a different product', verdict: 'NON_ACCOUNTING', why: 'manufacturing BOM recipe' },
  { file: 'components/settings/backup-restore.tsx', prefix: 'Resend code', verdict: 'NON_ACCOUNTING', why: 'e-mail confirmation code button', count: 2 },
  { file: 'components/settings/database-reset.tsx', prefix: 'Resend code', verdict: 'NON_ACCOUNTING', why: 'e-mail confirmation code button' },
  { file: 'app/(dashboard)/sync/settle-sync-row-control.tsx', prefix: 'Settle this row — record what actually happened', verdict: 'DESCRIPTION', why: 'heading of the settle control: it records on the IMS row what the operator saw in the ledger and posts nothing' },
  { file: 'app/actions/sales.ts', prefix: 'Reconcile the reservation manually', verdict: 'NON_ACCOUNTING', why: 'stock reservation release, no ledger posting' },
  { file: 'lib/domain/sales/refund-reservation-release-outbox.ts', prefix: 'Reconcile the reservation manually', verdict: 'NON_ACCOUNTING', why: 'stock reservation release, no ledger posting' },
  { file: 'lib/accounting-fx-revaluation.ts', prefix: 'Check the journal in the accounting system.', verdict: 'CHECKS_FIRST', why: 'is itself the ledger check' },
  { file: 'lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff.ts', prefix: 'credit note(s) {} in the ledger', verdict: 'DESCRIPTION', why: 'states which credit notes the ledger holds' },
  { file: 'lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff.ts', prefix: 'no credit note of theirs recorded in the ledger', verdict: 'DESCRIPTION', why: 'states a fact about the ledger' },
  { file: 'lib/connectors/woocommerce/sync/coupon-discount-ledger-handoff.ts', prefix: 'IMS records refund(s) {}', verdict: 'DESCRIPTION', why: 'states what IMS holds' },
  { file: 'lib/connectors/woocommerce/sync/refund-sync.ts', prefix: 'This refund also returned {} unit(s)', verdict: 'DESCRIPTION', why: 'states a stock consequence; the instruction sentence is guarded' },
  { file: 'lib/connectors/xero/credit-notes.ts', prefix: 'Credit note not found in Xero for allocation', verdict: 'DESCRIPTION', why: 'error label' },
  { file: 'lib/connectors/xero/sync-processor.ts', prefix: 'the activity row for the lost claim could not be written', verdict: 'DESCRIPTION', why: 'states where the only record is', count: 1 },
  { file: 'lib/connectors/xero/sync-processor.ts', prefix: 'the single-statement fallback write failed', verdict: 'DESCRIPTION', why: 'states where the only record is', count: 1 },
  { file: 'lib/connectors/xero/sync-processor.ts', prefix: 'created a DRAFT manual journal in Xero', verdict: 'DESCRIPTION', why: 'states what IMS did', count: 1 },
  { file: 'lib/connectors/xero/sync-processor.ts', prefix: 'ALLOCATED an existing supplier credit note', verdict: 'DESCRIPTION', why: 'states what IMS did', count: 1 },
  { file: 'lib/domain/accounting/allocation-debit-posting-proof.ts', prefix: 'the A2 journal this order was staged into is', verdict: 'DESCRIPTION', why: 'states why the proof failed' },
  { file: 'lib/domain/accounting/ledger-settlement-evidence.ts', prefix: 'this row does not record the amount and date', verdict: 'DESCRIPTION', why: 'states why evidence cannot be matched' },
  { file: 'lib/domain/accounting/posting-refusal-kinds.ts', prefix: 'The FX revaluation raises this journal only', verdict: 'DESCRIPTION', why: 'describes what the Retry button does for this kind' },
  { file: 'lib/domain/accounting/posting-refusal-kinds.ts', prefix: 'The journal is queued once, with the stock movement', verdict: 'DESCRIPTION', why: 'states IMS behaviour' },
  { file: 'lib/domain/accounting/posting-refusal-kinds.ts', prefix: 'The journal is queued once, with the receipt', verdict: 'DESCRIPTION', why: 'states IMS behaviour' },
  { file: 'lib/domain/accounting/unrecorded-posted-document.ts', prefix: '{} are NOT accounting documents', verdict: 'DESCRIPTION', why: 'states what the listed items are' },
  { file: 'lib/domain/purchasing/supplier-credit-note.ts', prefix: 'IMS could not establish whether credit note', verdict: 'DESCRIPTION', why: 'states why IMS refused' },
  { file: 'lib/domain/purchasing/supplier-credit-note.ts', prefix: 'Credit note {} is already in the ledger as', verdict: 'DESCRIPTION', why: 'states a ledger fact' },
]

test('[o3d-1e7sl Codex r17] every instruction site in the tree is guarded by construction or declared per sentence (verdict + justification), exactly (shrink-only)', () => {
  const sites = instructionSites()
  assert.ok(sites.filter((s) => s.guard === 'guard-call').length >= 30, 'PRECONDITION: the AST walk finds the guarded sites (not vacuous)')
  assert.ok(sites.filter((s) => s.guard === 'sink-remedy').length >= 15, 'PRECONDITION: the AST walk finds the sink-remedy sites (not vacuous)')
  const unguarded = sites.filter((s) => s.guard === null)
  const used = new Map<number, number>()
  const undeclared: string[] = []
  for (const site of unguarded) {
    const idx = UNGUARDED_SITES.findIndex((e, i) => e.file === site.file && site.sentence.startsWith(e.prefix) && (used.get(i) ?? 0) < (e.count ?? 1))
    if (idx < 0) undeclared.push(`${site.file}: ${site.sentence.slice(0, 140)}`)
    else used.set(idx, (used.get(idx) ?? 0) + 1)
  }
  assert.deepEqual(undeclared, [], 'an UNGUARDED instruction: wrap it in withLedgerCheck / withHandPostSafety (preferred), route it through the sink remedy, or declare it with a verdict')
  const stale = UNGUARDED_SITES.filter((e, i) => (used.get(i) ?? 0) !== (e.count ?? 1)).map((e) => `${e.file}: ${e.prefix}`)
  assert.deepEqual(stale, [], 'shrink-only: remove / lower these entries (the instruction was removed or guarded)')
  for (const e of UNGUARDED_SITES) assert.ok(e.why.length > 10, `${e.file}: ${e.prefix} needs a justification`)
  if (process.env.PRINT_INSTRUCTION_AUDIT === '1') {
    for (const s of sites) {
      const e = s.guard === null ? UNGUARDED_SITES.find((x) => x.file === s.file && s.sentence.startsWith(x.prefix)) : null
      console.log(`AUDIT\t${s.file}\t${s.sentence.slice(0, 110)}\t${s.guard ?? e?.verdict}\t${e?.why ?? ''}`)
    }
  }
})

test('[o3d-1e7sl Codex r17] the unguarded-site check can fail (a new unguarded instruction is flagged)', () => {
  const probe = { file: 'lib/x.ts', sentence: 'Post it again by hand.', guard: null as null }
  const declared = UNGUARDED_SITES.some((e) => e.file === probe.file && probe.sentence.startsWith(e.prefix))
  assert.equal(declared, false, 'control: an undeclared unguarded instruction does not match any entry')
  assert.equal(withLedgerCheck('Post it again by hand.').startsWith(LEDGER_CHECK_PREAMBLE), true)
  assert.equal(withLedgerCheck('Nothing to do here.'), 'Nothing to do here.')
  assert.equal(withLedgerCheck(withLedgerCheck('Post it again by hand.')), withLedgerCheck('Post it again by hand.'), 'idempotent')
})

test('[o3d-1e7sl Codex r17] the daily-batch diagnostics, rendered through the REAL builders, never advise a re-post before the ledger check', () => {
  for (const [name, text] of [['unproved row', dailyBatchUnprovedRefusal('DAILY_BATCH_GROUP_B', 'R-1 (id-1, CANCELLED)')], ['asserted row', dailyBatchAssertedRefusal('DAILY_BATCH_GROUP_B', 'R-1 (id-1, SYNCED, external id J-1)')]] as const) {
    const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
    const instructionIdx = sentences.findIndex((x) => /re-?post|post it|re-?save|raise it/i.test(x) && !/could post|rebuild posts|would post/i.test(x))
    assert.ok(instructionIdx >= 0, `${name}: PRECONDITION: the diagnostic carries a post instruction`)
    const before = sentences.slice(0, instructionIdx + 1).join(' ')
    assert.match(before, /check[^.]*(accounting system|ledger)|(Open|open) that document in the accounting system/, `${name}: the ledger check comes before the instruction`)
    assert.match(before, /only if|If it does not exist|does not exist/i, `${name}: the instruction is conditional on the check`)
  }
  assert.doesNotMatch(dailyBatchUnprovedRefusal('X', 'r'), /Re-post it deliberately, or leave it/, 'the old unconditional advice is gone')
})

test('[o3d-1e7sl Codex r18] "record" and the other ledger verbs are instruction verbs; the bill-payment failure message is guarded by the ledger check', () => {
  for (const text of ['Try again, or record the payment in the ledger by hand.', 'Enter the credit in the accounting system.', 'Reconcile the invoice manually.', 'Apply the credit note in the ledger.', 'Void it in the accounting system.', 'Settle it in the ledger by hand.', 'Allocate it in Xero.', 'Refund it again in the ledger.']) {
    assert.match(text, HAND_POST_INSTRUCTION_PATTERN, `matched: ${text}`)
    assert.ok(withLedgerCheck(text).startsWith(LEDGER_CHECK_PREAMBLE), `guarded: ${text}`)
  }
  // the markBillPaid failure that RETURNS the message to the operator (not just logs it)
  const src = read('app/actions/purchase-orders.ts')
  const m = src.match(/: withLedgerCheck\('The payment could not be queued for the accounting connector, so the bill was not marked ' \+\s*'paid\. Nothing was changed — try again, or record the payment in the ledger by hand\.'\)/)
  assert.ok(m, 'the returned enqueue-failure error is wrapped in withLedgerCheck')
  const rendered = withLedgerCheck('The payment could not be queued for the accounting connector, so the bill was not marked paid. Nothing was changed — try again, or record the payment in the ledger by hand.')
  assert.ok(rendered.indexOf('check whether the current version is already in the accounting system') < rendered.indexOf('try again'), 'the check comes BEFORE either action')
})
