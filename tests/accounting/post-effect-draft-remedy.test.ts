import assert from 'node:assert/strict'
import test from 'node:test'

import { postEffectFor } from '@/lib/connectors/xero/sync-processor'
import {
  DRAFT_CAPABLE_SEMANTIC_LIST,
  OPERATION_SEMANTIC_BY_TYPE,
  operationSemanticFor,
} from '@/lib/domain/accounting/unrecorded-posted-document'
import type { AccountingSyncType } from '@/app/generated/prisma/client'

/**
 * o3d-d3re — THE FENCE-LOSS REMEDY MUST NOT SEND AN OPERATOR TO CREDIT-NOTE A DRAFT.
 *
 * `postEffectFor` decides the sentence `reportPostOnMovedAttempt` puts into the
 * `xero_sync_post_fenced_out` escalation — a permanent, operator-facing instruction. It used to
 * apply the draft wording only where the TYPE's live wording happened to be the journal one, so an
 * invoice, bill or credit note created on `_postingMode: 'draft'` earned "The document is in the
 * ledger: void or credit-note it there if it should not exist". Neither half is true, and the
 * second half is the trap: A CREDIT NOTE POSTS FOR REAL, so following the advice books a real
 * credit of exactly the amount the draft never moved.
 *
 * THE MATRIX IS WALKED, NOT SAMPLED. Every member of `AccountingSyncType` is asked in both modes,
 * from the enum rather than from a list written here — a type added next month is covered without
 * an edit, which is how the journal-only branch survived being widened in the sibling.
 *
 * The WIRING (that the escalation reads this function at all) is pinned separately and end to end,
 * by the two draft/submitted journal tests in tests/accounting/xero-sync-attempt-fence.test.ts,
 * which drive the real `processPendingXeroSync` loop.
 */

const ALL_TYPES = Object.keys(OPERATION_SEMANTIC_BY_TYPE) as AccountingSyncType[]

/**
 * The three LIVE instructions, each of which moves real money when followed. A draft remedy may
 * name them ONLY inside a prohibition — which is why this test does not grep for them.
 *
 * PROSE MATCHING WAS THE FIRST VERSION OF THIS TEST AND IT WAS WRONG IN THE INSTRUCTIVE DIRECTION:
 * `/credit-note it/` matched "Do NOT void it, credit-note it or reverse it", so the fixed remedy
 * failed its own test for containing the warning. A phrase allowlist cannot tell an instruction
 * from its prohibition, which is exactly the argument unrecorded-posted-document.ts makes against
 * inspecting remedy prose at all. The structural assertion below is the real one.
 */
const LIVE_INSTRUCTIONS = [
  /void or credit-note it there/,
  /post a reversing journal there/,
]

const DRAFT_CAPABLE = (type: AccountingSyncType): boolean =>
  (DRAFT_CAPABLE_SEMANTIC_LIST as readonly string[]).includes(operationSemanticFor(type) ?? '')

test('o3d-d3re: the matrix under test is the real enum, and it is not empty', () => {
  // The whole file is a sweep over this list. If it were short — or if `_postingMode` stopped
  // reaching the function — every assertion below would pass over nothing.
  assert.ok(ALL_TYPES.length >= 25, `expected the full AccountingSyncType enum, saw ${ALL_TYPES.length}`)
  const draftCapable = ALL_TYPES.filter(
    (type) => (DRAFT_CAPABLE_SEMANTIC_LIST as readonly string[]).includes(operationSemanticFor(type) ?? ''),
  )
  assert.ok(draftCapable.length >= 20, `expected many draft-capable types, saw ${draftCapable.length}`)
  // AND THE TWO SIDES MUST BOTH BE POPULATED, or "every draft-capable type" is a claim about six
  // journals and "every other type" is a claim about nothing.
  assert.ok(ALL_TYPES.length - draftCapable.length >= 5, 'the non-draft-capable side must be populated too')
})

test('o3d-d3re: the posting mode CHANGES the answer for every draft-capable type', () => {
  // THE DEFECT, STATED STRUCTURALLY AND WITHOUT READING ANY PROSE. `_postingMode: 'draft'` produced
  // a different remedy for the six journal types and an IDENTICAL one for the invoice, bill,
  // credit-note and both *_UPDATE types — although every one of those handlers resolves its Xero
  // status from that same setting. Whatever the wording, the two answers must differ.
  for (const type of ALL_TYPES) {
    if (!DRAFT_CAPABLE(type)) continue
    assert.notDeepEqual(
      postEffectFor(type, { _postingMode: 'draft' } as never),
      postEffectFor(type, {} as never),
      `${type} (${operationSemanticFor(type)}) reads its Xero status from _postingMode, so a draft `
      + 'attempt left an UNPOSTED document behind and cannot earn the live remedy',
    )
  }
})

test('o3d-d3re: a draft remedy states that nothing moved, and never INSTRUCTS a ledger action', () => {
  for (const type of ALL_TYPES) {
    if (!DRAFT_CAPABLE(type)) continue
    const semantic = operationSemanticFor(type)
    const { effect, remedy } = postEffectFor(type, { _postingMode: 'draft' } as never)
    for (const instruction of LIVE_INSTRUCTIONS) {
      assert.doesNotMatch(remedy, instruction,
        `${type} (${semantic}) on draft carries a LIVE instruction: ${remedy}`)
    }
    assert.match(remedy, /no balances have moved/,
      `${type} (${semantic}) on draft must say no balances moved: ${remedy}`)
    // AND IT MUST WARN, not merely omit. The trap this issue is about is an operator reaching for
    // the reversal themselves; a remedy that simply says nothing about it leaves them to it.
    assert.match(remedy, /Do NOT/,
      `${type} (${semantic}) on draft must warn against the reversal, not just omit it: ${remedy}`)
    assert.match(effect, /DRAFT/,
      `${type} (${semantic}) on draft must describe a draft effect: ${effect}`)
  }
})

test('o3d-d3re: a draft CREATE says DELETE it; a draft UPDATE says CORRECT it and must NOT say delete', () => {
  // The one draft wording that must not say "delete": the document an UPDATE changed stood there
  // before this attempt ran, so deleting it destroys work this row never created. Same conclusion,
  // same reasoning, as the sibling record's UPDATE_DRAFT.
  const create = postEffectFor('SALES_INVOICE', { _postingMode: 'draft' } as never)
  assert.match(create.remedy, /DELETE the draft/)
  assert.match(create.remedy, /a credit note POSTS FOR REAL/)

  const update = postEffectFor('SALES_INVOICE_UPDATE', { _postingMode: 'draft' } as never)
  assert.match(update.remedy, /correct it in Xero/)
  assert.match(update.remedy, /Do NOT delete it/)

  const journal = postEffectFor('COGS_JOURNAL', { _postingMode: 'draft' } as never)
  assert.match(journal.remedy, /DELETE the draft/)
  assert.match(journal.remedy, /a reversal posts for real/i)
})

test('o3d-d3re: on a live posting mode, every type keeps the wording it had', () => {
  // The counter-guard. A draft wording leaking onto a document that really is in the ledger is the
  // same defect with the sign reversed: deleting a posted invoice is not an option, and telling an
  // operator it moved no balances is false.
  for (const mode of [undefined, 'submitted', 'authorised']) {
    for (const type of ALL_TYPES) {
      const { effect, remedy } = postEffectFor(type, { _postingMode: mode } as never)
      assert.doesNotMatch(effect, /DRAFT/, `${type} on _postingMode=${String(mode)} claimed a draft effect`)
      assert.doesNotMatch(remedy, /it was created unposted|no balances have moved/i,
        `${type} on _postingMode=${String(mode)} claimed nothing reached the ledger`)
    }
  }
  assert.match(postEffectFor('SALES_INVOICE', {} as never).remedy, /void or credit-note it there/)
  assert.match(postEffectFor('COGS_JOURNAL', {} as never).remedy, /post a reversing journal there/)
})

test('o3d-d3re: types with NO draft form keep their live wording on `draft` too', () => {
  // A Xero payment has no draft status and no status is resolved for it; an attachment, a PDF, an
  // email and a note reach no ledger at all. Their wording is already right, and giving them a
  // draft variant would be a new falsehood rather than a fix.
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'INVOICE_PDF', 'INVOICE_EMAIL',
    'WC_INVOICE_NOTE', 'BILL_ATTACHMENT', 'TAX_RATE_SYNC', 'PURCHASE_CREDIT_NOTE_ALLOCATION'] as AccountingSyncType[]) {
    assert.deepEqual(
      postEffectFor(type, { _postingMode: 'draft' } as never),
      postEffectFor(type, {} as never),
      `${type} has no draft form, so the mode must change nothing about its remedy`,
    )
  }
})
