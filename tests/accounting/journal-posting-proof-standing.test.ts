import assert from 'node:assert/strict'
import { unconditionalMoneySentences } from '../helpers/unconditional-instruction'
import test from 'node:test'

import {
  assertedJournalRemedy,
  isAssertedJournalRefusal,
  proveAllocationDebitPosting,
  proveJournalPosting,
  type JournalProofRow,
} from '@/lib/domain/accounting/allocation-debit-posting-proof'
import { ledgerStanding } from '@/lib/domain/accounting/ledger-standing'

/**
 * o3d-3la07 (M8 / M9) - WHAT PROVES A JOURNAL'S AMOUNT: A CONFIRMED, SETTLED ROW. NEVER AN ASSERTION.
 *
 * `proveJournalPosting` reads the credit / debit a journal moved off its OWN payload lines, and every
 * relief figure in the refund path and in the A2 reverser rests on it. An operator-typed document id
 * (SYNCED + OPERATOR_ASSERTION + id) settles the row without IMS ever reading the ledger, and its
 * `payload` is what was QUEUED - so it proves no AMOUNT (D2), however legible its lines are. The proof
 * therefore requires `ledgerStanding === CONFIRMED_POSTED` AND SYNCED.
 *
 * Each case names the standing it was built for and ASSERTS the standing (`ledgerStanding`) so the
 * fixture cannot silently be a different row than its label.
 */

const LINES = { lines: [{ accountCode: '631', debit: 0, credit: 20 }] }

function row(over: Partial<JournalProofRow> & Pick<JournalProofRow, 'status'>): JournalProofRow {
  return {
    externalTransactionId: null,
    abandonedBeforeRemoteCall: null,
    settlementBasis: null,
    payload: LINES,
    ...over,
  }
}

const STANDINGS: Array<{ standing: string; row: JournalProofRow; proves: boolean; asserted: boolean }> = [
  { standing: 'CONFIRMED_POSTED', row: row({ status: 'SYNCED', externalTransactionId: 'JNL-1' }), proves: true, asserted: false },
  // An id-less SYNCED (truth-table row 7) is the connector's own writeback too.
  { standing: 'CONFIRMED_POSTED', row: row({ status: 'SYNCED' }), proves: true, asserted: false },
  { standing: 'ASSERTED_POSTED', row: row({ status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: 'OPERATOR_ASSERTION' }), proves: false, asserted: true },
  { standing: 'ASSERTED_NOT_POSTED', row: row({ status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' }), proves: false, asserted: false },
  { standing: 'PROVEN_NOT_POSTED', row: row({ status: 'CANCELLED', settlementBasis: 'VERIFIED_REVERSAL' }), proves: false, asserted: false },
  { standing: 'UNKNOWN', row: row({ status: 'SYNCED', settlementBasis: 'SOMETHING_NEW' }), proves: false, asserted: false },
  { standing: 'LIVE_WORK', row: row({ status: 'PENDING' }), proves: false, asserted: false },
]

for (const testCase of STANDINGS) {
  test(`proveJournalPosting ${testCase.standing} (${testCase.row.status}${testCase.row.externalTransactionId ? '+id' : ''}): ${testCase.proves ? 'PROVES the £20' : 'proves nothing'}`, () => {
    assert.equal(ledgerStanding(testCase.row), testCase.standing, 'PRECONDITION: the fixture is the standing its label names')
    const proof = proveJournalPosting([testCase.row], '631', 'credit')
    if (testCase.proves) {
      assert.deepEqual(proof, { kind: 'proved', amount: 20 })
    } else {
      assert.equal(proof.kind, 'unproved')
      assert.equal(proof.kind === 'unproved' && proof.asserted === true, testCase.asserted, 'the assertion is named only for an asserted row')
    }
    console.log(`proof ${testCase.standing}: ${proof.kind}`)
  })
}

test('[isolating arm] an ASSERTED_POSTED row with perfectly LEGIBLE lines is still unproved - legibility is not standing', () => {
  const asserted = row({ status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: 'OPERATOR_ASSERTION' })
  assert.deepEqual(proveJournalPosting([{ ...asserted }], '631', 'credit').kind, 'unproved')
  // The SAME lines on a CONFIRMED row prove: the lines are not what differs.
  assert.deepEqual(proveJournalPosting([row({ status: 'SYNCED', externalTransactionId: 'JNL-1' })], '631', 'credit'), { kind: 'proved', amount: 20 })
  console.log('isolating arm: identical legible lines, asserted -> unproved, confirmed -> proved')
})

test('[isolating arm] a COMPACTED confirmed row is illegible, an asserted one with the same compaction is unproved first', () => {
  assert.deepEqual(proveJournalPosting([row({ status: 'SYNCED', externalTransactionId: 'JNL-1', payload: {} })], '631', 'credit'), { kind: 'illegible' })
  assert.equal(
    proveJournalPosting([row({ status: 'SYNCED', externalTransactionId: 'T', settlementBasis: 'OPERATOR_ASSERTION', payload: {} })], '631', 'credit').kind,
    'unproved',
    'standing is asked before legibility: an assertion is never "illegible" (which a caller resolves to the recorded figure)',
  )
})

test('a list is proved only if EVERY row proves: a confirmed row cannot vouch for an asserted sibling', () => {
  const proof = proveJournalPosting([
    row({ status: 'SYNCED', externalTransactionId: 'JNL-1' }),
    row({ status: 'SYNCED', externalTransactionId: 'TYPED-2', settlementBasis: 'OPERATOR_ASSERTION' }),
  ], '631', 'credit')
  assert.equal(proof.kind, 'unproved')
  assert.equal(proof.kind === 'unproved' && proof.asserted, true)
})

test('SYNCED is kept beside the standing: a non-SYNCED row that merely carries a connector id (truth-table row 6) is not widened into proof', () => {
  const failedWithId = row({ status: 'FAILED', externalTransactionId: 'JNL-9' })
  assert.equal(ledgerStanding(failedWithId), 'CONFIRMED_POSTED', 'PRECONDITION: the module calls this a ledger fact')
  assert.equal(proveJournalPosting([failedWithId], '631', 'credit').kind, 'unproved', 'this proof has always refused it, and still does')
})

// ---------------------------------------------------------------------------------------------
// proveAllocationDebitPosting: the EXISTENCE check (D2) and the AMOUNT proof are two different questions
// ---------------------------------------------------------------------------------------------

const PASS = { amount: 20, syncLogId: 'j-1', connector: 'xero', accountCode: '631', batchRef: 'A2-2026-07-20-aa', at: '2026-07-20T00:00:00.000Z' }
const ORDER = {
  inventoryAllocatedDate: new Date('2026-07-20T00:00:00.000Z'),
  allocationBatchAmount: 20,
  allocationBatchPasses: [PASS],
  allocationBatchSyncLogId: 'j-1',
  allocationBatchConnector: 'xero',
  allocationBatchAccountCode: '631',
}

async function proveWith(journal: JournalProofRow & { connector?: string | null }) {
  const client = {
    accountingSyncLog: {
      // The A2 DEBIT proof reads the journal's DR to Allocated Inventory (the credit proof above reads the CR).
      findUnique: async () => ({ connector: 'xero', ...journal, payload: { lines: [{ accountCode: '631', debit: 20, credit: 0 }] } }),
    },
  }
  return proveAllocationDebitPosting(client as never, ORDER, { activeConnector: 'xero' as const, allocatedInventoryAccount: '631' })
}

test('proveAllocationDebitPosting CONFIRMED_POSTED: posted', async () => {
  const proof = await proveWith(row({ status: 'SYNCED', externalTransactionId: 'JNL-1' }))
  assert.equal(proof.kind, 'posted')
  console.log('A2 proof CONFIRMED_POSTED: posted')
})

test('proveAllocationDebitPosting ASSERTED_POSTED with LEGIBLE lines: REFUSED, and the reason says an operator asserted it (existence passes, amount does not)', async () => {
  const proof = await proveWith(row({ status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: 'OPERATOR_ASSERTION' }))
  assert.equal(proof.kind, 'refused')
  assert.match(proof.kind === 'refused' ? proof.reason : '', /OPERATOR typing in a document id/)
  assert.doesNotMatch(proof.kind === 'refused' ? proof.reason : '', /nothing has been debited/, 'the existence check did NOT call it absent')
  console.log('A2 proof ASSERTED_POSTED: refused (assertion wording)')
})

const A2_REFUSALS: Array<{ standing: string; row: JournalProofRow; reason: RegExp }> = [
  { standing: 'ASSERTED_NOT_POSTED', row: row({ status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' }), reason: /is CANCELLED, not SYNCED/ },
  { standing: 'PROVEN_NOT_POSTED', row: row({ status: 'CANCELLED', settlementBasis: 'VERIFIED_REVERSAL' }), reason: /is CANCELLED, not SYNCED/ },
  { standing: 'UNKNOWN', row: row({ status: 'SYNCED', settlementBasis: 'SOMETHING_NEW' }), reason: /settlement basis is not one this build recognises/ },
  { standing: 'LIVE_WORK', row: row({ status: 'PENDING' }), reason: /is PENDING, not SYNCED/ },
]

for (const testCase of A2_REFUSALS) {
  test(`proveAllocationDebitPosting ${testCase.standing}: REFUSED with the status refusal`, async () => {
    assert.equal(ledgerStanding(testCase.row), testCase.standing, 'PRECONDITION: the fixture is the standing its label names')
    const proof = await proveWith(testCase.row)
    assert.equal(proof.kind, 'refused')
    assert.match(proof.kind === 'refused' ? proof.reason : '', testCase.reason)
    console.log(`A2 proof ${testCase.standing}: refused`)
  })
}

test('an asserted CANCELLED + id row (the cancelled-sale settlement) is ASSERTED_POSTED: existence passes, the amount proof refuses it', async () => {
  const cancelledWithId = row({ status: 'CANCELLED', externalTransactionId: 'TYPED-C', settlementBasis: 'OPERATOR_ASSERTION' })
  assert.equal(ledgerStanding(cancelledWithId), 'ASSERTED_POSTED')
  const proof = await proveWith(cancelledWithId)
  assert.equal(proof.kind, 'refused')
  assert.match(proof.kind === 'refused' ? proof.reason : '', /OPERATOR typing in a document id/)
})

// ---------------------------------------------------------------------------------------------
// Codex round 2 (HIGH 2): "nothing was debited" is said ONLY of a PROVEN_NOT_POSTED journal.
// ---------------------------------------------------------------------------------------------

const WORDING: Array<{ standing: string; row: JournalProofRow; says: RegExp; neverNothingDebited: boolean }> = [
  // A recorded PRE-CALL abandonment is the only PROVEN cause that may say "never posted / nothing debited".
  { standing: 'PROVEN_NOT_POSTED (recorded pre-call)', row: row({ status: 'CANCELLED', abandonedBeforeRemoteCall: true }), says: /PROVEN never to have posted — nothing has been debited/, neverNothingDebited: false },
  // A VERIFIED REVERSAL can keep the id of a journal that DID post and was later reversed (Codex round 1, o3d-1e7sl).
  { standing: 'PROVEN_NOT_POSTED (verified reversal)', row: row({ status: 'CANCELLED', externalTransactionId: 'JNL-REAL', settlementBasis: 'VERIFIED_REVERSAL' }), says: /verified reversed in the ledger and is no longer present there\. It may have been posted earlier/, neverNothingDebited: true },
  { standing: 'ASSERTED_NOT_POSTED', row: row({ status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' }), says: /UNPROVEN[\s\S]*CHECK Xero for that journal[\s\S]*If it exists there[\s\S]*If it does not exist/, neverNothingDebited: true },
  { standing: 'UNKNOWN (CANCELLED, no proof)', row: row({ status: 'CANCELLED' }), says: /UNPROVEN[\s\S]*CHECK Xero/, neverNothingDebited: true },
  { standing: 'UNKNOWN (FAILED, no id)', row: row({ status: 'FAILED' }), says: /is FAILED, not SYNCED — whether it reached the ledger is UNPROVEN[\s\S]*CHECK Xero/, neverNothingDebited: true },
  { standing: 'CONFIRMED_POSTED but never settled (FAILED + connector id)', row: row({ status: 'FAILED', externalTransactionId: 'JNL-9' }), says: /UNPROVEN[\s\S]*CHECK Xero/, neverNothingDebited: true },
  { standing: 'LIVE_WORK', row: row({ status: 'PENDING' }), says: /still queued or in flight, so nothing has been confirmed as debited yet/, neverNothingDebited: true },
]

for (const testCase of WORDING) {
  test(`[Codex r2 HIGH 2] A2 refusal wording for ${testCase.standing}: ${testCase.neverNothingDebited ? 'never claims "nothing was debited"' : 'may say it, because it is PROVEN'}`, async () => {
    const proof = await proveWith(testCase.row)
    assert.equal(proof.kind, 'refused')
    const reason = proof.kind === 'refused' ? proof.reason : ''
    assert.match(reason, testCase.says)
    if (testCase.neverNothingDebited) assert.doesNotMatch(reason, /nothing has been debited|never to have posted/)
    assert.equal(isAssertedJournalRefusal(reason), false, 'and it does not trigger the asserted-journal remedy')
    // Codex round 3: UNIVERSAL absence over the complete reason - no unconditional reverse/credit/void/re-post sentence on a non-proven standing.
    if (testCase.neverNothingDebited) assert.deepEqual(unconditionalMoneySentences(reason), [], `${testCase.standing}: unconditional money instruction`)
    console.log(`wording ${testCase.standing}: ${reason.slice(0, 110)}`)
  })
}

// ---------------------------------------------------------------------------------------------
// Codex round 2 (HIGH 1): the remedy for a PARTIAL refund names only what that refund withheld.
// ---------------------------------------------------------------------------------------------

const FIGURES = { recordedDebit: 24, relieved: 4, open: 20 }

test('[Codex r3 HIGH] assertedJournalRemedy: partial prescribes the LESSER of the withheld figure and the open balance, and states all three', () => {
  // Binding cap: lines value 40, open balance 24 -> credit 24, never 40.
  const binding = assertedJournalRemedy({ full: false, withheldAmount: 40, openBalance: { recordedDebit: 24, relieved: 0, open: 24 } })
  assert.match(binding, /Refunded units value £40\.00; open A2 balance £24\.00 \(recorded debit £24\.00 less relief already credited £0\.00\); credit the LESSER: DR Inventory \/ CR Allocated Inventory £24\.00/)
  assert.match(binding, /do NOT credit more than the open balance/i)
  assert.match(binding, /If you already applied a manual credit for this order, deduct it/)
  assert.doesNotMatch(binding, /CR Allocated Inventory £40/)
  // Non-binding: 10 of 40 -> 10.
  const loose = assertedJournalRemedy({ full: false, withheldAmount: 10, openBalance: { recordedDebit: 40, relieved: 0, open: 40 } })
  assert.match(loose, /Refunded units value £10\.00; open A2 balance £40\.00[^;]*; credit the LESSER: DR Inventory \/ CR Allocated Inventory £10\.00/)
  // Open balance already zero -> credit nothing.
  assert.match(assertedJournalRemedy({ full: false, withheldAmount: 10, openBalance: { recordedDebit: 10, relieved: 10, open: 0 } }), /CR Allocated Inventory £0\.00/)
  console.log('remedy: binding cap -> 24 (not 40); non-binding -> 10; exhausted -> 0')
})

test('[Codex r3 HIGH] assertedJournalRemedy: no figure when the withheld amount or the open balance cannot be established (partial); full states the open balance', () => {
  for (const params of [
    { full: false, withheldAmount: null, openBalance: FIGURES },
    { full: false, withheldAmount: 0.004, openBalance: FIGURES },
    { full: false, withheldAmount: 10, openBalance: null },
    { full: false, withheldAmount: null, openBalance: null },
  ]) {
    const text = assertedJournalRemedy(params)
    assert.match(text, /could not establish the figure for this refund, so none is given/)
    assert.match(text, /credit the lesser, and do NOT credit the order's whole A2 debit/)
    assert.doesNotMatch(text, /£\d/, `no figure: ${JSON.stringify(params)}`)
    assert.match(text, /deduct it/)
  }
  const full = assertedJournalRemedy({ full: true, withheldAmount: null, openBalance: FIGURES })
  assert.match(full, /CR Allocated Inventory £20\.00: the open A2 balance £20\.00 \(recorded debit £24\.00 less relief already credited £4\.00\); do not credit more than the open balance/)
  const fullUnknown = assertedJournalRemedy({ full: true, withheldAmount: null, openBalance: null })
  assert.match(fullUnknown, /the open balance could not be established here, so none is given/)
  assert.doesNotMatch(fullUnknown, /£\d/)
})

test('allocationOpenBalance and cappedAllocationCredit are the posting path\'s own expressions', async () => {
  const { allocationOpenBalance, cappedAllocationCredit } = await import('@/lib/domain/accounting/allocation-debit-posting-proof')
  const { toDecimal } = await import('@/lib/domain/math/decimal')
  assert.equal(allocationOpenBalance(24, 4), 20)
  assert.equal(allocationOpenBalance(10, 30), 0, 'floored at zero')
  assert.equal(allocationOpenBalance(40, 0.01), 39.99)
  assert.equal(cappedAllocationCredit(toDecimal(40), 24).toNumber(), 24)
  assert.equal(cappedAllocationCredit(toDecimal(10), 40).toNumber(), 10)
})
