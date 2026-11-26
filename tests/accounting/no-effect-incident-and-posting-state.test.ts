import assert from 'node:assert/strict'
import test from 'node:test'

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  describePreservedUnrecordedIncidents,
  describeUnrecordablePostedDocument,
  incidentKindForOperation,
  type PostedOperationOutcome,
  type UnrecordedIncidentCounts,
} from '@/lib/domain/accounting/unrecorded-posted-document'

// ---------------------------------------------------------------------------------------------
// ROUND 11 (Codex HIGH + 3 MEDIUM) — AND THE TEST LESSON THAT COMES WITH THE HIGH.
//
// THE HIGH. Round 10 gave the disabled-attachment case its own WORDING and left it inside a
// generic frame that opens by asserting an external effect has happened. So an operation that made
// no request and changed nothing was described as one that had acted.
//
// ROUND 10'S TESTS ASSERTED THE OUTCOME-SPECIFIC FRAGMENTS AND PASSED. They matched "NOTHING AT
// ALL — attachment upload is turned off" and "this attempt created none" while the surrounding
// paragraphs contradicted both. A fragment cannot see its own frame. So the tests below assert
// COMPLETE GENERATED MESSAGES, byte for byte: any sentence added, removed or reworded anywhere in
// the message fails them, whether or not it happens to be the sentence the author was thinking
// about.
// ---------------------------------------------------------------------------------------------

const ATTACH = {
  id: 'log-1', type: 'BILL_ATTACHMENT' as AccountingSyncType,
  referenceType: 'PurchaseOrder', referenceId: 'po-1',
}
const UPDATE_ENTRY = {
  id: 'log-2', type: 'SALES_INVOICE_UPDATE' as AccountingSyncType,
  referenceType: 'SalesOrder', referenceId: 'order-2',
}
const ZERO: UnrecordedIncidentCounts = {
  LEDGER_DOCUMENT: 0, LEDGER_DOCUMENT_NO_IDENTIFIER: 0, LEDGER_DRAFT: 0,
  LEDGER_OUTCOME_UNRECORDED: 0, LEDGER_NON_DOCUMENT: 0, NO_IDENTIFIER_SIDE_EFFECT: 0, UNCLASSIFIED: 0,
}
const DRAFT: PostedOperationOutcome = { postingMode: 'DRAFT' }
const LIVE: PostedOperationOutcome = { postingMode: 'LIVE' }

// ---------------------------------------------------------------------------------------------
// THE WHOLE MESSAGE, NOT THE FRAGMENT (Codex round 11, HIGH).
// ---------------------------------------------------------------------------------------------

const XERO_NO_EFFECT =
  'Xero BILL_ATTACHMENT for PurchaseOrder po-1 SUCCEEDED WITHOUT MAKING ANY EXTERNAL EFFECT — '
  + 'nothing left this process and nothing in Xero changed — and IMS could not record that it '
  + 'ran. WHAT THE OPERATION DID: it did nothing at all. Attachment upload READ AS OFF FOR THIS '
  + 'CONNECTOR AT THE MOMENT THIS ATTEMPT RAN, so the handler returned success without contacting '
  + 'Xero and without uploading anything. Its sync row log-1 no longer exists, so nothing in IMS '
  + 'references it. NOTHING LEFT THIS PROCESS AND NOTHING IN XERO CHANGED. REMEDY: THERE IS '
  + 'NOTHING TO UNDO. No attachment was created, no document was created, and nothing in Xero was '
  + 'touched by this attempt. WHAT THIS RECORD HOLDS: the operation type, the IMS reference '
  + 'above, the sync row id, and the time this record was written — the write it describes was '
  + 'made in the same sync attempt. That is all of it.'

const XERO_UPDATE_DRAFT =
  'Xero SALES_INVOICE_UPDATE for SalesOrder order-2 MODIFIED the existing Xero DRAFT document INV-1 '
  + '— it is still unposted, and no balance moved, but its sync row log-2 no longer exists, so '
  + 'nothing in IMS references the draft it changed. REMEDY: NOTHING WAS CREATED AND NOTHING WAS '
  + 'POSTED. This operation changed a document that already existed, and it was sent unposted, so no '
  + 'balance moved. DO NOT VOID OR CREDIT-NOTE IT — that would act on a document that was valid '
  + 'before this attempt ran. DO NOT REVERSE IT — a reversal POSTS FOR REAL and would move accounts '
  + 'this draft never moved. AND DO NOT DELETE IT — the draft was there before this attempt and '
  + 'deleting it destroys work this attempt did not do. Find the draft it changed in Xero by the id '
  + 'above, compare it against the reference above in IMS, and correct the draft in place if the '
  + 'change should not stand; nothing further will be retried for this row. WHAT THIS RECORD HOLDS: '
  + 'the operation type, the IMS reference above, the sync row id, and the time this record was '
  + 'written — the write it describes was made in the same sync attempt. That is all of it.'

const BREADCRUMB_SIDE_EFFECTS =
  'Database reset kept 4 record(s) of things IMS did against an accounting connector and could '
  + 'never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately. 4 are NOT '
  + 'accounting documents — no invoice, bill, credit note, payment or journal was created in Xero for '
  + 'any of them. They record an effect that landed somewhere else and can repeat: a '
  + 'file attached to an EXISTING bill, an invoice PDF written over the stored copy, an invoice email '
  + 'QUEUED to a customer, a note written onto a WooCommerce order. AN ATTACHMENT RECORD IN HERE MAY '
  + 'BE A NO-OP: that handler returns success WITHOUT uploading when attachment upload is off for its '
  + 'connector. Records written since IMS began capturing that outcome say which of the two happened; '
  + 'OLDER ONES SAY THEY DO NOT KNOW, and this count does not separate them, so it cannot tell you '
  + 'how many of either there are. The queued-email one never had a remote document at all — only a '
  + 'local email-outbox row, WHICH THIS RESET HAS JUST DELETED: the outbox rows that record tells you '
  + 'to inspect are gone with it, so their statuses can no longer be inspected. Read each record. It '
  + 'says what can be done about it, and where IMS could not establish what the effect was, it says '
  + 'that instead of guessing. Nothing else in IMS references any of them any more. Search this log '
  + 'for "xero_posted_document_unrecorded".'

// MUTATION THAT KILLS THIS (run): make `nonDocumentEffectClaim` return 'MADE' unconditionally — the
// head reverts to "SUCCEEDED — the external effect has happened — but IMS could not record that it
// did" above a body saying nothing left the process, and the equality fails.
//
// ROUTE: the exported Xero formatter, same recorded outcome, different door into the module.
test('ROUND 11 (Codex HIGH): the shared non-document head is read off the outcome, not asserted', () => {
  const message = describeUnrecordablePostedDocument({
    entry: ATTACH, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
    outcome: { externalEffect: 'NONE' },
  })
  assert.equal(message, XERO_NO_EFFECT)
  assert.doesNotMatch(message, /the external effect has happened/)

  // The record that does not know says so in the head as well as in the body — the same defect one
  // notch quieter, because BILL_ATTACHMENT is the operation with two success paths.
  const unknown = describeUnrecordablePostedDocument({
    entry: ATTACH, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
  })
  assert.match(unknown, /IMS RECORDED NEITHER WHAT IT DID NOR THAT IT RAN/)
  assert.doesNotMatch(unknown, /the external effect has happened/)

  // …and an operation with no no-op success path still says the effect happened, because it did.
  // (Deleting that arm of `nonDocumentEffectClaim` would make every PDF write and queued email say
  // IMS does not know what it did, which is a falsehood in the other direction.)
  for (const type of ['INVOICE_PDF', 'INVOICE_EMAIL', 'WC_INVOICE_NOTE'] as AccountingSyncType[]) {
    const always = describeUnrecordablePostedDocument({
      entry: { ...ATTACH, type }, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
    })
    assert.match(always, /SUCCEEDED — the external effect has happened/, type)
  }
})

// ---------------------------------------------------------------------------------------------
// POSTING STATE, MODELLED INDEPENDENTLY OF OPERATION SEMANTICS (Codex round 11, MEDIUM).
// ---------------------------------------------------------------------------------------------
// MUTATION THAT KILLS THIS (run): remove 'UPDATE_DOCUMENT' from DRAFT_CAPABLE_SEMANTICS — the draft
// update classifies LEDGER_DOCUMENT again, is aggregated as a live movement, and takes the UPDATE_LIVE
// wording, so the first assertion and the whole-message equality both fail. Deleting the
// UPDATE_DOCUMENT row from DOCUMENT_WORDING_BY_SEMANTIC fails the build instead.
//
// ROUTE: the classifier and the Xero formatter are both the shipped exports; the create-then-update
// pair is the sequence an operator's `_postingMode: draft` setting actually produces, since ONE
// per-sync-type setting drives the create and the update of the same document.
test('ROUND 11 (Codex MEDIUM): a draft CREATE and a draft UPDATE are both drafts, and neither is live money', () => {
  // The create, which round 10 already got right.
  assert.equal(incidentKindForOperation('SALES_INVOICE', 'INV-1', DRAFT), 'LEDGER_DRAFT')
  // The update of that same draft, on the same setting, which round 10 called a LIVE document.
  assert.equal(incidentKindForOperation('SALES_INVOICE_UPDATE', 'INV-1', DRAFT), 'LEDGER_DRAFT')
  assert.equal(incidentKindForOperation('PURCHASE_INVOICE_UPDATE', 'INV-1', DRAFT), 'LEDGER_DRAFT')
  // With no id, the same answer: the posting state does not depend on whether an id came back.
  assert.equal(incidentKindForOperation('SALES_INVOICE_UPDATE', null, DRAFT), 'LEDGER_DRAFT')
  // A live update is still a live document, and an unrecorded mode is an unknown for an update too.
  assert.equal(incidentKindForOperation('SALES_INVOICE_UPDATE', 'INV-1', LIVE), 'LEDGER_DOCUMENT')
  assert.equal(incidentKindForOperation('SALES_INVOICE_UPDATE', 'INV-1'), 'LEDGER_OUTCOME_UNRECORDED')
  // A PAYMENT has no draft form and is not in the draft-capable set, so its answer is unchanged.
  assert.equal(incidentKindForOperation('INVOICE_PAYMENT', 'PAY-1'), 'LEDGER_DOCUMENT')

  // AND THE WHOLE MESSAGE THE DRAFT UPDATE EARNS. Its remedy is the one cell of the table that must
  // forbid deletion as well as reversal: the draft it changed stood there before the attempt ran.
  const message = describeUnrecordablePostedDocument({
    entry: UPDATE_ENTRY, postedExternalId: 'INV-1', namedExternalId: null, reason: 'ROW_MISSING',
    outcome: DRAFT,
  })
  assert.equal(message, XERO_UPDATE_DRAFT)
  assert.match(message, /AND DO NOT DELETE IT/)
  assert.doesNotMatch(message, /DELETE it if it should not exist/,
    'that is the CREATE_DRAFT remedy, and it destroys a draft this attempt did not create')
})

// MUTATION THAT KILLS THIS (run): restore "were created as DRAFTS" to the LEDGER_DRAFT sentence, or
// restore "DELETE one if it should not exist" — the first two assertions fail. Aggregating a draft
// update under LEDGER_DOCUMENT instead fails the third.
//
// ROUTE: both breadcrumbs are generated by the shipped reset formatter from counts the shipped
// classifier produces.
test('ROUND 11 (Codex MEDIUM): the reset breadcrumb stops calling a draft update real money, or a new draft', () => {
  const drafts = describePreservedUnrecordedIncidents({ ...ZERO, LEDGER_DRAFT: 3 })
  assert.match(drafts, /THEY WERE NOT ALL CREATED AS DRAFTS/)
  assert.doesNotMatch(drafts, /DELETE one if it should not exist/)
  assert.doesNotMatch(drafts, /real money in somebody else's books/)
  assert.match(drafts, /deleting one of those destroys a draft that stood there before the attempt ran/)

  // The live-document paragraph is the one a draft update used to land in, and it is exactly the
  // paragraph an operator must not read about an unposted document.
  const live = describePreservedUnrecordedIncidents({ ...ZERO, LEDGER_DOCUMENT: 1 })
  assert.match(live, /real money in somebody else's books/)
})

// ---------------------------------------------------------------------------------------------
// THE BREADCRUMB MAY NOT SPEAK FOR RECORDS THAT SAY THEY DO NOT KNOW (Codex round 11, MEDIUM).
// ---------------------------------------------------------------------------------------------
// MUTATION THAT KILLS THIS (run): restore "each record says which" to the side-effect sentence, or
// restore "Each record says what the effect was and what can be done about it" to the tail — the
// equality fails, and the two doesNotMatch assertions name which universal came back.
//
// ROUTE: the breadcrumb is generated by the shipped reset formatter; the record it speaks for is
// generated by the shipped Xero formatter with no recorded outcome, which is what a row written by
// an older binary carries.
test('ROUND 11 (Codex MEDIUM): the breadcrumb claims no more about attachment records than they say', () => {
  const crumb = describePreservedUnrecordedIncidents({ ...ZERO, NO_IDENTIFIER_SIDE_EFFECT: 4 })
  assert.equal(crumb, BREADCRUMB_SIDE_EFFECTS)

  assert.doesNotMatch(crumb, /each record says which/,
    'a record with no recorded outcome says the opposite of which')
  assert.doesNotMatch(crumb, /Each record says what the effect was/,
    'and an unclassified one cannot state an effect at all')
  assert.match(crumb, /OLDER ONES SAY THEY DO NOT KNOW/)
  assert.match(crumb, /this count does not separate them/,
    'the unknown bucket is described AND the breadcrumb admits it cannot size it')

  // THE RECORD THE BREADCRUMB IS SPEAKING FOR. It says it does not know — so the breadcrumb saying
  // "each record says which" was permanent, retention-exempt evidence of a certainty that is not in
  // the data.
  const legacy = describeUnrecordablePostedDocument({
    entry: ATTACH, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
  })
  assert.match(legacy, /IMS DID NOT RECORD WHETHER THE UPLOAD HAPPENED/)

  // And the unclassified bucket, which cannot state an effect either.
  const unclassified = describePreservedUnrecordedIncidents({ ...ZERO, UNCLASSIFIED: 2 })
  assert.match(unclassified, /cannot say which kind they are/)
  assert.doesNotMatch(unclassified, /Each record says what the effect was/)
})
