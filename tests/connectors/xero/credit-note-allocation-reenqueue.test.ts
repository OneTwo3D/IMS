import assert from 'node:assert/strict'
import test from 'node:test'

import {
  selectCreditNotesNeedingAllocation,
  selectIssuingPostOriginRecord,
  type CreditNoteAllocationCandidate,
} from '@/lib/connectors/xero/sync-processor'

// audit-w77e: the cron sweep enqueues a PURCHASE_CREDIT_NOTE_ALLOCATION for posted
// credit notes whose bill synced to Xero only after the credit posted (so v08m's
// at-post enqueue was skipped). selectCreditNotesNeedingAllocation is the pure
// filter: keep posted credits that have a credit id + a bill id but NO allocation
// row yet.

function candidate(over: Partial<CreditNoteAllocationCandidate> = {}): CreditNoteAllocationCandidate {
  return {
    id: 'cn-1',
    accountingCreditNoteId: 'xero-cn-1',
    amountForeign: 120,
    purchaseInvoice: { accountingInvoiceId: 'xero-inv-1' },
    ...over,
  }
}

test('selects a posted credit with a bill id and no existing allocation row', () => {
  const out = selectCreditNotesNeedingAllocation([candidate()], new Set())
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {
    supplierCreditNoteId: 'cn-1',
    creditNoteId: 'xero-cn-1',
    accountingInvoiceId: 'xero-inv-1',
    amount: 120,
  })
})

test('skips a credit that already has an allocation row of any status', () => {
  const out = selectCreditNotesNeedingAllocation([candidate()], new Set(['cn-1']))
  assert.equal(out.length, 0)
})

test('skips when the credit or bill external id is missing (defensive)', () => {
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ accountingCreditNoteId: null })], new Set()).length, 0)
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ purchaseInvoice: null })], new Set()).length, 0)
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ purchaseInvoice: { accountingInvoiceId: null } })], new Set()).length, 0)
})

test('skips a non-positive or non-finite amount (Codex review — no useless row)', () => {
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ amountForeign: 0 })], new Set()).length, 0)
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ amountForeign: -5 })], new Set()).length, 0)
  assert.equal(selectCreditNotesNeedingAllocation([candidate({ amountForeign: Number.NaN })], new Set()).length, 0)
})

test('coerces a Decimal-like amount to a number', () => {
  const out = selectCreditNotesNeedingAllocation(
    [candidate({ amountForeign: { toString: () => '99.5' } as unknown as number })],
    new Set(),
  )
  assert.equal(out[0].amount, 99.5)
})

test('filters a mixed batch — keeps only the fillable gaps', () => {
  const batch: CreditNoteAllocationCandidate[] = [
    candidate({ id: 'a' }), // fillable
    candidate({ id: 'b' }), // already allocated
    candidate({ id: 'c', accountingCreditNoteId: null }), // not posted to Xero
    candidate({ id: 'd' }), // fillable
  ]
  const out = selectCreditNotesNeedingAllocation(batch, new Set(['b']))
  assert.deepEqual(out.map((o) => o.supplierCreditNoteId), ['a', 'd'])
})

// --- selectIssuingPostOriginRecord (Codex r4 finding 1) ---------------------------------------------
//
// The other pure half of the sweep: given the surviving PURCHASE_CREDIT_NOTE rows for one credit note,
// WHICH of them issued the document this allocation is carrying? Round 3 answered "the newest SYNCED
// one", which is an answer to a different question.
//
// REVERT EVIDENCE. A literal revert DELETES this function, so these cases are pinned by TARGETED
// MUTATION instead, and each one says which mutation it fails under.

const K = '_connectionProvenance'

test('r4: the issuing post is the row carrying the SAME document id, not the newest row of the reference', () => {
  // Mutation: match on the reference alone and take the first row → 'xero:tenant-C'.
  const origin = selectIssuingPostOriginRecord([
    { externalTransactionId: 'XCN-SECOND', payload: { [K]: 'xero:tenant-C' } },
    { externalTransactionId: 'XCN-FIRST', payload: { [K]: 'xero:tenant-A' } },
  ], 'XCN-FIRST')
  assert.equal(origin.outcome, 'inherited')
  assert.deepEqual(origin.outcome === 'inherited' ? origin.payload : null, { [K]: 'xero:tenant-A' })
})

test('r4: no row naming the document means NO issuing row — never the nearest candidate', () => {
  // Mutation: fall back to rows[0] when the pair does not match → an origin the row never came from.
  const origin = selectIssuingPostOriginRecord([
    { externalTransactionId: 'XCN-OTHER', payload: { [K]: 'xero:tenant-C' } },
  ], 'XCN-WANTED')
  assert.equal(origin.outcome, 'no-issuing-row')
})

test('r4: an empty id resolves to no issuing row rather than matching a row with no id', () => {
  // Mutation: drop the blank guard → `('' ?? '').trim() === ''` matches every id-less row.
  const origin = selectIssuingPostOriginRecord([{ externalTransactionId: null, payload: { [K]: 'xero:tenant-C' } }], '')
  assert.equal(origin.outcome, 'no-issuing-row')
})

test('r4: two rows naming ONE document against different organisations is a conflict, not a tie-break', () => {
  // Mutation: return the first stamped row instead of checking `named.size > 1` → 'xero:tenant-A' wins
  // a contradiction it is not entitled to settle.
  const origin = selectIssuingPostOriginRecord([
    { externalTransactionId: 'XCN-1', payload: { [K]: 'xero:tenant-A' } },
    { externalTransactionId: 'XCN-1', payload: { [K]: 'xero:tenant-C' } },
  ], 'XCN-1')
  assert.equal(origin.outcome, 'conflicting-origins')
  assert.deepEqual(origin.outcome === 'conflicting-origins' ? origin.recorded : [], ['xero:tenant-A', 'xero:tenant-C'])
})

test('r4: among rows describing one post, the one that RECORDED an organisation is preferred over silence', () => {
  // A retention-compacted `payload: {}` is not a disagreement — it says less about the same post.
  // Mutation: drop the rank and take rows[0] → the compacted row wins and the allocation refuses for
  // no reason.
  const origin = selectIssuingPostOriginRecord([
    { externalTransactionId: 'XCN-1', payload: {} },
    { externalTransactionId: 'XCN-1', payload: { [K]: 'xero:tenant-A' } },
  ], 'XCN-1')
  assert.deepEqual(origin.outcome === 'inherited' ? origin.payload : null, { [K]: 'xero:tenant-A' })
})

test('r4: with nothing recorded anywhere, the issuing row is still carried VERBATIM — including !disconnected', () => {
  // Inherit-never-mint: a post raised while disconnected hands that on, rather than being reborn as
  // plain absence or as whatever is connected now. Both refuse; only one of them says what happened.
  const origin = selectIssuingPostOriginRecord([
    { externalTransactionId: 'XCN-1', payload: {} },
    { externalTransactionId: 'XCN-1', payload: { [K]: '!disconnected' } },
  ], 'XCN-1')
  assert.deepEqual(origin.outcome === 'inherited' ? origin.payload : null, { [K]: '!disconnected' })
})

test('r4: an unreadable payload never outranks a readable one, and a JSON array is unreadable', () => {
  // The array hole, in the ranking: `typeof [] === 'object'` and the key lookup on it is undefined.
  const origin = selectIssuingPostOriginRecord([
    { externalTransactionId: 'XCN-1', payload: [{ [K]: 'xero:tenant-C' }] },
    { externalTransactionId: 'XCN-1', payload: {} },
  ], 'XCN-1')
  assert.deepEqual(origin.outcome === 'inherited' ? origin.payload : null, {})
})
