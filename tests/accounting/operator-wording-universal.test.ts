import assert from 'node:assert/strict'
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
    ['lib/accounting.ts', 'handPostStepFor(params.type)'],
    ['lib/domain/accounting/posting-mark-handled.ts', 'handPostStepFor(row.type)'],
    ['lib/domain/accounting/posting-refusal-kinds-doc.ts', 'GENERIC_HAND_POST_STEP'],
  ] as const) assert.ok(read(file).includes(symbol), `${file} renders through ${symbol}`)
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
