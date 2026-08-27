import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  OPERATION_SEMANTIC_BY_TYPE,
  QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  UNRECORDED_POSTED_DOCUMENT_ACTION,
  classifyUnrecordedIncident,
  describeUnpersistedQboPost,
  describeUnrecordablePostedDocument,
  ledgerTargetIdFromPayload,
  remedyForStoredIncident,
  supersedingRemedyForStoredIncident,
  type LedgerPostingMode,
  type PostedOperationOutcome,
  type RemoteEffectOutcome,
} from '@/lib/domain/accounting/unrecorded-posted-document'

// ---------------------------------------------------------------------------------------------
// ROUND 12 (Codex HIGH + MEDIUM) — A RECORDED FACT IS NOT A CURRENT ONE, AND A REMEDY MAY NOT
// NAME WHAT THE RECORD CANNOT.
//
// THE HIGH. Round 11 closed the no-effect message with "IF YOU WANT THE REPLAY TO STAY A NO-OP,
// LEAVE ATTACHMENT UPLOAD DISABLED … Leave it as it is until the write failure above is fixed."
// `externalEffect: NONE` proves only that `quickbooks_sync_attach_pdf` read "false" WHEN THIS
// ATTEMPT RAN. Nothing rereads it. This record is permanent — exempt from retention AND from the
// factory reset — and the setting is not. On an install where somebody enabled uploads in between,
// "leave it as it is" left them ON, and stale-claim recovery then uploaded an attachment on every
// sweep: the exact outcome the paragraph claimed to prevent.
//
// This is a NEW SHAPE of the defect this record keeps producing. Round 8's was an absence read as a
// negative; round 11's was a fragment contradicting its frame. This one is a RECORDED FACT READ AS
// A CURRENT ONE — and the class is wider than the one sentence, so the first test below is a fence
// over EVERY message the module can produce rather than an assertion about one of them.
//
// THE MEDIUM. `BILL_ATTACHMENT.MADE` told an operator to "open that bill" and remove an attachment
// while declaring no lookup field, and the record retained no bill id: after a factory reset the
// PurchaseOrder and the sync row are both deleted, so the operator had to guess which ledger bill
// to strip. The id is retained now, and the tests below assert the WHOLE message an operator reads
// in exactly that post-reset state — with the id, and without it.
// ---------------------------------------------------------------------------------------------

const ATTACH = {
  id: 'log-1', type: 'BILL_ATTACHMENT' as AccountingSyncType,
  referenceType: 'PurchaseOrder', referenceId: 'po-1',
}
const NOTE = {
  id: 'log-1', type: 'WC_INVOICE_NOTE' as AccountingSyncType,
  referenceType: 'SalesOrder', referenceId: 'order-1',
}
const RATE = {
  id: 'log-3', type: 'TAX_RATE_SYNC' as AccountingSyncType,
  referenceType: 'TaxRate', referenceId: 'rate-3',
}

const QBO_MADE_NAMED_BILL =
  'QuickBooks BILL_ATTACHMENT for PurchaseOrder po-1 SUCCEEDED — the external effect has '
  + 'happened — but IMS could not record that it did: Error: write conflict. THIS OPERATION '
  + 'RETURNS NO IDENTIFIER AND NO REQUEST ID PROTECTS IT: unlike a document post it is not sent '
  + 'under a derived Intuit Request-Id, so there is nothing for QuickBooks or WooCommerce or a '
  + 'mail server to deduplicate it against. Sync row log-1 was left holding this worker\'s claim, '
  + 'with no mirrored accounting event written, so once that claim goes stale THE SWEEP WILL '
  + 'RECLAIM THE ROW AND RUN THE OPERATION AGAIN OUTRIGHT — the supplier invoice PDF is uploaded '
  + 'to QuickBooks bill QBO-BILL-77 AGAIN, once per sweep, unbounded, because no retry is '
  + 'consumed while the row never leaves PROCESSING. WHAT TO DO ABOUT THE EFFECT: Find that bill '
  + 'in QuickBooks by the ledger document id above and remove any duplicate attachment. HOW TO '
  + 'STOP MORE OF IT: turn QuickBooks sync OFF. The control is the checkbox at the top of the '
  + 'SYNC tab of the QuickBooks connector panel, and it writes the setting '
  + 'quickbooks_sync_enabled. IT IS LABELLED "Enable Xero Sync" EVEN THERE, and its helper text '
  + 'says Xero too: the QuickBooks panel renders the Xero client and those two strings are '
  + 'hardcoded. The words are wrong; the checkbox is the right one. (Filed as o3d-m9wm.) The '
  + 'stale-claim sweep and the manual Sync button both READ that setting before they call the '
  + 'QuickBooks processor, so while it is off neither one STARTS another run. It stops EVERY '
  + 'QuickBooks row, not this one, and it recalls nothing already queued or already done. THEN '
  + 'LEAVE IT OFF, BECAUSE TURNING IT OFF IS NOT A FENCE. Both of those call sites read the '
  + 'setting and then call the processor with nothing in between, so a run admitted a moment '
  + 'before you flipped it keeps going: it can claim THIS row afterwards, run the operation '
  + 'again, and then write over the row — the write that records a QuickBooks post updates the '
  + 'row BY ID ALONE, with no claim token, no attempt revision and no status check, so it lands '
  + 'on whatever the row says by then. That claim also leaves the row at attempt revision 0, '
  + 'which is indistinguishable from the abandoned attempt in front of you. Nothing in IMS '
  + 'reports whether such a run is still going, so there is no moment you can point at and call '
  + 'this row quiet. SO DO NOT CLOSE THIS ROW YOURSELF, AND DO NOT TURN QUICKBOOKS SYNC BACK ON '
  + 'TO FINISH THE JOB. Leave the toggle off and ESCALATE sync row log-1, with this record, to '
  + 'whoever administers this installation: closing it safely needs someone who can read the '
  + 'database directly, and the machinery that would make an operator remedy sound is filed as '
  + 'o3d-4b5p (a quiescence fence the cron, the manual sync, the claim and the writeback all '
  + 'honour) and o3d-3lhp (a per-row remediation, and a way to cancel a queued email). ONE THING '
  + 'ON SCREEN IS ACTIVELY WRONG AND YOU WILL SEE IT: the accounting log renders a settle control '
  + 'for every FAILED or PROCESSING row, and on this one it resolves to the words "not '
  + 'settleable" with its reason as the tooltip. DO NOT FOLLOW THAT TOOLTIP. It is the generic '
  + 'reason, written for a connector that stamps attempt revisions, and it tells you to retry the '
  + 'row until it shows one: QuickBooks never stamps one, so no number of retries will ever make '
  + 'an attempt appear — and every retry is another replay of the effect above. This is the known '
  + 'hole o3d-qn21. Until the work above lands, this record is the only thing that says the '
  + 'effect repeated.'

const QBO_MADE_UNNAMED_BILL =
  'QuickBooks BILL_ATTACHMENT for PurchaseOrder po-1 SUCCEEDED — the external effect has '
  + 'happened — but IMS could not record that it did: Error: write conflict. THIS OPERATION '
  + 'RETURNS NO IDENTIFIER AND NO REQUEST ID PROTECTS IT: unlike a document post it is not sent '
  + 'under a derived Intuit Request-Id, so there is nothing for QuickBooks or WooCommerce or a '
  + 'mail server to deduplicate it against. Sync row log-1 was left holding this worker\'s claim, '
  + 'with no mirrored accounting event written, so once that claim goes stale THE SWEEP WILL '
  + 'RECLAIM THE ROW AND RUN THE OPERATION AGAIN OUTRIGHT — the supplier invoice PDF is uploaded '
  + 'to that bill in QuickBooks AGAIN, once per sweep, unbounded, because no retry is consumed '
  + 'while the row never leaves PROCESSING. WHAT TO DO ABOUT THE EFFECT: THIS RECORD DOES NOT '
  + 'NAME THE BILL THE PDF WENT ONTO, so it cannot send you to the duplicates and nothing kept '
  + 'here derives the bill. Escalate this record to whoever administers this installation. HOW TO '
  + 'STOP MORE OF IT: turn QuickBooks sync OFF. The control is the checkbox at the top of the '
  + 'SYNC tab of the QuickBooks connector panel, and it writes the setting '
  + 'quickbooks_sync_enabled. IT IS LABELLED "Enable Xero Sync" EVEN THERE, and its helper text '
  + 'says Xero too: the QuickBooks panel renders the Xero client and those two strings are '
  + 'hardcoded. The words are wrong; the checkbox is the right one. (Filed as o3d-m9wm.) The '
  + 'stale-claim sweep and the manual Sync button both READ that setting before they call the '
  + 'QuickBooks processor, so while it is off neither one STARTS another run. It stops EVERY '
  + 'QuickBooks row, not this one, and it recalls nothing already queued or already done. THEN '
  + 'LEAVE IT OFF, BECAUSE TURNING IT OFF IS NOT A FENCE. Both of those call sites read the '
  + 'setting and then call the processor with nothing in between, so a run admitted a moment '
  + 'before you flipped it keeps going: it can claim THIS row afterwards, run the operation '
  + 'again, and then write over the row — the write that records a QuickBooks post updates the '
  + 'row BY ID ALONE, with no claim token, no attempt revision and no status check, so it lands '
  + 'on whatever the row says by then. That claim also leaves the row at attempt revision 0, '
  + 'which is indistinguishable from the abandoned attempt in front of you. Nothing in IMS '
  + 'reports whether such a run is still going, so there is no moment you can point at and call '
  + 'this row quiet. SO DO NOT CLOSE THIS ROW YOURSELF, AND DO NOT TURN QUICKBOOKS SYNC BACK ON '
  + 'TO FINISH THE JOB. Leave the toggle off and ESCALATE sync row log-1, with this record, to '
  + 'whoever administers this installation: closing it safely needs someone who can read the '
  + 'database directly, and the machinery that would make an operator remedy sound is filed as '
  + 'o3d-4b5p (a quiescence fence the cron, the manual sync, the claim and the writeback all '
  + 'honour) and o3d-3lhp (a per-row remediation, and a way to cancel a queued email). ONE THING '
  + 'ON SCREEN IS ACTIVELY WRONG AND YOU WILL SEE IT: the accounting log renders a settle control '
  + 'for every FAILED or PROCESSING row, and on this one it resolves to the words "not '
  + 'settleable" with its reason as the tooltip. DO NOT FOLLOW THAT TOOLTIP. It is the generic '
  + 'reason, written for a connector that stamps attempt revisions, and it tells you to retry the '
  + 'row until it shows one: QuickBooks never stamps one, so no number of retries will ever make '
  + 'an attempt appear — and every retry is another replay of the effect above. This is the known '
  + 'hole o3d-qn21. Until the work above lands, this record is the only thing that says the '
  + 'effect repeated.'

const XERO_MADE_NAMED_BILL =
  'Xero BILL_ATTACHMENT for PurchaseOrder po-1 SUCCEEDED — the external effect has happened — '
  + 'but IMS could not record that it did. WHAT THE OPERATION DID: it uploaded a supplier-invoice '
  + 'PDF onto Xero bill XERO-BILL-77, which already existed. THE UPLOAD HAPPENED. No id came back '
  + 'for the attachment itself, because an attachment is not a document. Its sync row log-1 no '
  + 'longer exists, so nothing in IMS references it. THIS ATTEMPT UPLOADED AN ATTACHMENT ONTO '
  + 'XERO BILL XERO-BILL-77, and no standalone accounting document was created. REMEDY: Find that '
  + 'bill in '
  + 'Xero by the ledger document id above and remove the duplicate attachment. There is no '
  + 'document to void, and the bill itself was not created by this attempt. WHAT THIS RECORD '
  + 'HOLDS: the operation type, the IMS reference above, the sync row id, and the time this '
  + 'record was written — the write it describes was made in the same sync attempt. That is all '
  + 'of it.'

const XERO_MADE_UNNAMED_BILL =
  'Xero BILL_ATTACHMENT for PurchaseOrder po-1 SUCCEEDED — the external effect has happened — '
  + 'but IMS could not record that it did. WHAT THE OPERATION DID: it uploaded a supplier-invoice '
  + 'PDF onto a bill that already existed in Xero. THE UPLOAD HAPPENED. No id came back because '
  + 'an attachment is not a document, and this record does not carry the id of the bill it went '
  + 'onto either. Its sync row log-1 no longer exists, so nothing in IMS references it. THIS '
  + 'ATTEMPT UPLOADED AN ATTACHMENT ONTO A BILL IN XERO, AND THIS RECORD DOES NOT NAME THAT BILL. '
  + 'REMEDY: DO '
  + 'NOT REMOVE AN ATTACHMENT FROM A BILL THIS RECORD CANNOT NAME. The upload happened, so a '
  + 'duplicate may exist, but nothing kept here says which bill it is on and nothing kept here '
  + 'derives it. Escalate this record to whoever administers this installation. WHAT THIS RECORD '
  + 'HOLDS: the operation type, the IMS reference above, the sync row id, and the time this '
  + 'record was written — the write it describes was made in the same sync attempt. That is all '
  + 'of it.'

const QBO_WC_NOTE =
  'QuickBooks WC_INVOICE_NOTE for SalesOrder order-1 SUCCEEDED — the external effect has '
  + 'happened — but IMS could not record that it did: Error: write conflict. THIS OPERATION '
  + 'RETURNS NO IDENTIFIER AND NO REQUEST ID PROTECTS IT: unlike a document post it is not sent '
  + 'under a derived Intuit Request-Id, so there is nothing for QuickBooks or WooCommerce or a '
  + 'mail server to deduplicate it against. Sync row log-1 was left holding this worker\'s claim, '
  + 'with no mirrored accounting event written, so once that claim goes stale THE SWEEP WILL '
  + 'RECLAIM THE ROW AND RUN THE OPERATION AGAIN OUTRIGHT — a second invoice note is written onto '
  + 'the WooCommerce order, once per sweep, unbounded, because no retry is consumed while the row '
  + 'never leaves PROCESSING. WHAT TO DO ABOUT THE EFFECT: THIS RECORD DOES NOT NAME THE '
  + 'WOOCOMMERCE ORDER — it holds the IMS reference above and nothing else, and the IMS record '
  + 'that maps that reference to a WooCommerce order is deleted by a database reset. Escalate '
  + 'this record to whoever administers this installation rather than clearing notes off an order '
  + 'picked out any other way. HOW TO STOP MORE OF IT: turn QuickBooks sync OFF. The control is '
  + 'the checkbox at the top of the SYNC tab of the QuickBooks connector panel, and it writes the '
  + 'setting quickbooks_sync_enabled. IT IS LABELLED "Enable Xero Sync" EVEN THERE, and its '
  + 'helper text says Xero too: the QuickBooks panel renders the Xero client and those two '
  + 'strings are hardcoded. The words are wrong; the checkbox is the right one. (Filed as '
  + 'o3d-m9wm.) The stale-claim sweep and the manual Sync button both READ that setting before '
  + 'they call the QuickBooks processor, so while it is off neither one STARTS another run. It '
  + 'stops EVERY QuickBooks row, not this one, and it recalls nothing already queued or already '
  + 'done. THEN LEAVE IT OFF, BECAUSE TURNING IT OFF IS NOT A FENCE. Both of those call sites '
  + 'read the setting and then call the processor with nothing in between, so a run admitted a '
  + 'moment before you flipped it keeps going: it can claim THIS row afterwards, run the '
  + 'operation again, and then write over the row — the write that records a QuickBooks post '
  + 'updates the row BY ID ALONE, with no claim token, no attempt revision and no status check, '
  + 'so it lands on whatever the row says by then. That claim also leaves the row at attempt '
  + 'revision 0, which is indistinguishable from the abandoned attempt in front of you. Nothing '
  + 'in IMS reports whether such a run is still going, so there is no moment you can point at and '
  + 'call this row quiet. SO DO NOT CLOSE THIS ROW YOURSELF, AND DO NOT TURN QUICKBOOKS SYNC BACK '
  + 'ON TO FINISH THE JOB. Leave the toggle off and ESCALATE sync row log-1, with this record, to '
  + 'whoever administers this installation: closing it safely needs someone who can read the '
  + 'database directly, and the machinery that would make an operator remedy sound is filed as '
  + 'o3d-4b5p (a quiescence fence the cron, the manual sync, the claim and the writeback all '
  + 'honour) and o3d-3lhp (a per-row remediation, and a way to cancel a queued email). ONE THING '
  + 'ON SCREEN IS ACTIVELY WRONG AND YOU WILL SEE IT: the accounting log renders a settle control '
  + 'for every FAILED or PROCESSING row, and on this one it resolves to the words "not '
  + 'settleable" with its reason as the tooltip. DO NOT FOLLOW THAT TOOLTIP. It is the generic '
  + 'reason, written for a connector that stamps attempt revisions, and it tells you to retry the '
  + 'row until it shows one: QuickBooks never stamps one, so no number of retries will ever make '
  + 'an attempt appear — and every retry is another replay of the effect above. This is the known '
  + 'hole o3d-qn21. Until the work above lands, this record is the only thing that says the '
  + 'effect repeated.'

const XERO_TAX_RATE =
  'Xero TAX_RATE_SYNC for TaxRate rate-3 SUCCEEDED — the external effect has happened — but IMS '
  + 'could not record that it did. WHAT THE OPERATION DID: it wrote a TAX RATE into the Xero '
  + 'organisation. A tax rate is a setting on the organisation rather than a document, and the '
  + 'value the write returns is a tax TYPE code. Its sync row log-3 no longer exists, so nothing '
  + 'in IMS references it. THIS IS NOT A DOCUMENT. Xero accepted the write and no reset of ours '
  + 'undoes it, but nothing stands at an id, so there is nothing here to open, keep or void as '
  + 'one. REMEDY: THERE IS NOTHING TO VOID OR CREDIT — nothing was posted to a customer or a '
  + 'supplier account. THIS RECORD DOES NOT SAY WHAT THE RATE WAS BEFORE THE WRITE, so it cannot '
  + 'tell you what correcting it would restore. Escalate this record to whoever administers this '
  + 'installation. WHAT THIS RECORD HOLDS: the operation type, the IMS reference above, the sync '
  + 'row id, and the time this record was written — the write it describes was made in the same '
  + 'sync attempt. That is all of it.'

// ---------------------------------------------------------------------------------------------
// THE HIGH, AS A FENCE OVER THE WHOLE CORPUS.
// ---------------------------------------------------------------------------------------------

/**
 * A claim about the STATE of something switchable. The record may only make one CONDITIONALLY —
 * "if it is off", "while it is off", "provided it is still off" — because it read the setting once,
 * at a moment that has passed, and will be read by somebody long afterwards.
 */
const STATE_CLAIM = new RegExp([
  // "is off", "is still off", "is turned off", "are currently disabled"…
  '\\b(?:is|are)\\s+(?:still\\s+|currently\\s+|now\\s+)?(?:turned\\s+)?(?:off|enabled|disabled)\\b',
  // …and "is turned on". A BARE "is on" is deliberately NOT here: it is far more often the
  // preposition ("nothing kept here says which bill it is on"), and a fence that fires on that
  // would be pruned back within a round.
  '\\b(?:is|are)\\s+(?:still\\s+|currently\\s+|now\\s+)?turned\\s+on\\b',
  '\\bstays?\\s+(?:on|off)\\b',
].join('|'), 'gi')

/** What makes such a claim a condition rather than an assertion. A closed grammatical class. */
const CONDITIONAL = /\b(?:if|unless|while|whether|provided|providing|when|until|as long as|so long as|would|were|should)\b/i

/** Every state claim a message asserts OUTRIGHT — the conditional ones are what it is allowed. */
function stateClaimsAsserted(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(STATE_CLAIM)) {
    const at = match.index ?? 0
    const boundary = Math.max(
      ...['. ', '; ', ': ', ', ', '— '].map((mark) => text.lastIndexOf(mark, at)),
    )
    const clause = text.slice(boundary < 0 ? 0 : boundary, at)
    if (!CONDITIONAL.test(clause)) found.push(match[0])
  }
  return found
}

const OPERATION_TYPES = Object.keys(OPERATION_SEMANTIC_BY_TYPE) as AccountingSyncType[]
const OUTCOMES: (PostedOperationOutcome | undefined)[] = [
  undefined,
  { postingMode: 'LIVE' as LedgerPostingMode },
  { postingMode: 'DRAFT' as LedgerPostingMode },
  { externalEffect: 'MADE' as RemoteEffectOutcome },
  { externalEffect: 'NONE' as RemoteEffectOutcome },
  { externalEffect: 'MADE' as RemoteEffectOutcome, ledgerTargetId: 'LEDGER-BILL-1' },
  { postingMode: 'LIVE' as LedgerPostingMode, externalEffect: 'NONE' as RemoteEffectOutcome },
]

/** Every message the module can produce, over every type, id combination and outcome. */
function everyIncidentMessage(): { label: string; text: string }[] {
  const messages: { label: string; text: string }[] = []
  for (const type of OPERATION_TYPES) {
    for (const outcome of OUTCOMES) {
      const o = JSON.stringify(outcome ?? null)
      for (const posted of [null, 'EXT-1']) {
        const entry = { id: 'log-1', type, referenceType: 'SalesOrder', referenceId: 'order-1' }
        messages.push({
          label: `qbo ${type} posted=${String(posted)} outcome=${o}`,
          text: describeUnpersistedQboPost({ entry, postedExternalId: posted, outcome }, new Error('write conflict')),
        })
        for (const reason of ['ROW_MISSING', 'ANOTHER_DOCUMENT_NAMED'] as const) {
          messages.push({
            label: `xero ${type} posted=${String(posted)} ${reason} outcome=${o}`,
            text: describeUnrecordablePostedDocument({
              entry, postedExternalId: posted, namedExternalId: 'EXT-OTHER', reason, outcome,
            }),
          })
        }
      }
    }
  }
  return messages
}

// MUTATION THAT KILLS THIS (run): restore the round-11 NONE wording — put
// `effect: 'NOTHING AT ALL — attachment upload is turned off for this connector, …'` back on
// QBO_OPERATIONS_WITHOUT_REQUEST_ID.BILL_ATTACHMENT.NONE — and this test fails naming that message
// and the claim `is turned off`. Restoring the non-document NONE `did` ("Attachment upload is
// turned off for this connector") kills it the same way. Both were RUN. The bypass is also run
// inline below against the shipped checker, so weakening the checker fails this test rather than
// quietly reopening the hole.
//
// ROUTE: every message is GENERATED by the shipped formatters over every type, id combination and
// outcome. Only the grammar — the state predicates and the conditional markers — is written here.
test('ROUND 12 (Codex HIGH): no message asserts the CURRENT state of anything switchable', () => {
  const messages = everyIncidentMessage()
  assert.ok(messages.length > 500, `sanity: ${messages.length} messages were generated`)
  for (const { label, text } of messages) {
    const claims = stateClaimsAsserted(text)
    assert.deepEqual(
      claims, [],
      `${label} asserts ${claims.join(', ')} about something that can be switched after this record `
      + 'was written. This record is permanent and exempt from both retention and the factory '
      + 'reset; a setting is not. Say what was READ and WHEN, or make the claim conditional.\n'
      + text,
    )
  }

  // THE REQUIRED FAILING CASE: the shipped round-11 sentence, run against the shipped checker.
  assert.deepEqual(
    stateClaimsAsserted('Running it again does NOTHING AT ALL — attachment upload is turned off for '
      + 'this connector, so every sweep re-runs a handler that returns success.'),
    ['is turned off'],
    'the round-11 no-op claim is the finding, and it must be refused',
  )
  assert.deepEqual(
    stateClaimsAsserted('No replay creates one while that setting stays off.'), [],
    'and the conditional form of the same claim is what the record is allowed to say',
  )
})

// MUTATION THAT KILLS THIS (run): restore "IF YOU WANT THE REPLAY TO STAY A NO-OP, LEAVE ATTACHMENT
// UPLOAD DISABLED … Leave it as it is until the write failure above is fixed." to
// `describeQboNoEffectIncident` — the first two doesNotMatch assertions fail. Deleting the
// "GO AND READ … AS IT STANDS NOW" clause from the NONE `check` fails the third; deleting the
// not-a-fence clause fails the fifth.
//
// ROUTE: the message is generated by the shipped QuickBooks formatter from the handler's own
// recorded outcome. Nothing asserted here is computed from the module.
test('ROUND 12 (Codex HIGH): the no-op remedy makes the operator READ the setting, not trust it', () => {
  const message = describeUnpersistedQboPost(
    { entry: ATTACH, postedExternalId: null, outcome: { externalEffect: 'NONE' } },
    new Error('write conflict'),
  )

  // WHAT IT NO LONGER DOES: treat a value read at attempt time as the value in force now.
  assert.doesNotMatch(message, /LEAVE ATTACHMENT UPLOAD DISABLED/)
  assert.doesNotMatch(message, /Leave it as it is/)

  // WHAT IT DOES INSTEAD, in three parts, all three of which Codex asked for by name.
  assert.match(
    message, /read "false" AT THE MOMENT THIS ATTEMPT RAN, which is the only reading it ever took/,
    'the recorded value is described as HISTORICAL',
  )
  assert.match(
    message, /THEN GO AND READ quickbooks_sync_attach_pdf AS IT STANDS NOW, because this record cannot/,
    'the operator is required to verify the setting as it is',
  )
  assert.match(
    message,
    /if it is ON, the replay uploads to a bill THIS RECORD DOES NOT NAME, so there is no duplicate this record can send you to/,
    'and told that a replay it cannot send anyone to is still a replay',
  )
  assert.match(
    message,
    /TURNING IT OFF IS NOT A FENCE EITHER: the handler reads that setting and then uploads, so a run already past the read still uploads/,
    'and told that wording cannot prevent an already-admitted replay — only a real fence can',
  )
  assert.match(message, /Only closing the row stops the replay, and IMS cannot close it \(o3d-4b5p\)/)

  // AND THE REPLAY CLAIM IS CONDITIONAL, which is the whole correction in one sentence.
  assert.match(message, /NOTHING — PROVIDED ATTACHMENT UPLOAD IS STILL OFF WHEN THE SWEEP RUNS/)
})

// MUTATION THAT KILLS THIS (run): change any row-state sentence back to the present tense — e.g.
// `sync row ${entry.id} still holds this worker's claim` in `describeQboNoEffectIncident` — and the
// scan finds "still holds", naming the message.
//
// ROUTE: the messages are generated by the shipped formatters; the phrases are the ones the round-11
// code actually wrote.
test('ROUND 12: the record describes the sync row as it WAS, not as it stands', () => {
  const PRESENT_ROW_CLAIM = /\bstill (?:holds|names)\b|\bis left PROCESSING\b|\bkeeps its claim\b|\balready names\b/i
  for (const { label, text } of everyIncidentMessage()) {
    assert.doesNotMatch(
      text, PRESENT_ROW_CLAIM,
      `${label} describes the sync row in the present tense. The row can be settled, adopted or `
      + 'deleted after this record is written, and this record outlives all three.',
    )
  }

  // NOT VACUOUS: the scan matches the wording this round replaced.
  assert.match('sync row log-1 still holds this worker\'s claim', PRESENT_ROW_CLAIM)
  assert.match('but sync row log-1 already names a DIFFERENT document', PRESENT_ROW_CLAIM)
})

// ---------------------------------------------------------------------------------------------
// THE MEDIUM: THE COMPLETE REMEDY AN OPERATOR READS AFTER A RESET.
// ---------------------------------------------------------------------------------------------
// MUTATION THAT KILLS THIS (run): drop `ledgerTargetId` from either record builder's metadata
// object and the retention assertion fails naming that builder; drop it from the `MADE` cell's
// `lookup` and the declaration test in record-names-only-what-it-holds.test.ts fails instead; make
// `outcomeWordingVariant` return 'MADE' regardless of the id and the UNNAMED equality fails with
// `render` throwing on an absent slot. All three were RUN.
//
// ROUTE: the messages come from the shipped formatters on BOTH connectors; the retained keys are
// parsed out of the two connector sources; the payload reader is the shipped export.
test('ROUND 12 (Codex MEDIUM): after a reset, the attachment remedy names the bill or sends nobody', async () => {
  // WITH the id — the state every record written from now on is in.
  assert.equal(
    describeUnpersistedQboPost(
      { entry: ATTACH, postedExternalId: null, outcome: { externalEffect: 'MADE', ledgerTargetId: 'QBO-BILL-77' } },
      new Error('write conflict'),
    ),
    QBO_MADE_NAMED_BILL,
  )
  assert.equal(
    describeUnrecordablePostedDocument({
      entry: ATTACH, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
      outcome: { externalEffect: 'MADE', ledgerTargetId: 'XERO-BILL-77' },
    }),
    XERO_MADE_NAMED_BILL,
  )

  // WITHOUT it — a record written before IMS kept it. This is the post-reset state Codex named: the
  // PurchaseOrder and the sync row are gone, and the record is all there is.
  assert.equal(
    describeUnpersistedQboPost(
      { entry: ATTACH, postedExternalId: null, outcome: { externalEffect: 'MADE' } },
      new Error('write conflict'),
    ),
    QBO_MADE_UNNAMED_BILL,
  )
  assert.equal(
    describeUnrecordablePostedDocument({
      entry: ATTACH, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
      outcome: { externalEffect: 'MADE' },
    }),
    XERO_MADE_UNNAMED_BILL,
  )

  // The claims the equalities above are protecting, said out loud.
  assert.match(QBO_MADE_NAMED_BILL, /uploaded to QuickBooks bill QBO-BILL-77 AGAIN/)
  assert.match(QBO_MADE_NAMED_BILL, /Find that bill in QuickBooks by the ledger document id above/)
  assert.match(XERO_MADE_NAMED_BILL, /THIS ATTEMPT UPLOADED AN ATTACHMENT ONTO XERO BILL XERO-BILL-77/)
  for (const unnamed of [QBO_MADE_UNNAMED_BILL, XERO_MADE_UNNAMED_BILL]) {
    assert.match(unnamed, /DOES NOT (?:NAME|carry the id of)/)
    assert.doesNotMatch(unnamed, /open that bill/i, 'it may not send anyone to a bill it cannot name')
    assert.match(unnamed, /Escalate this record to whoever administers this installation/)
  }

  // AND THE ID IS ACTUALLY RETAINED, by BOTH builders — parsed from their sources, because a remedy
  // that spends a field only one connector writes cannot be followed on the other.
  for (const [file, builder] of [
    ['lib/connectors/xero/sync-processor.ts', 'unrecordedPostedDocumentRecord'],
    ['lib/connectors/quickbooks/sync-processor.ts', 'unpersistedQboPostRecord'],
  ] as [string, string][]) {
    const source = await readFile(path.join(process.cwd(), file), 'utf8')
    const start = source.indexOf(`function ${builder}`)
    assert.ok(start > 0, `${builder} must still exist in ${file}`)
    const metadataAt = source.indexOf('sanitizeActivityLogMetadata({', start)
    const end = source.indexOf('}))', metadataAt)
    assert.match(
      source.slice(metadataAt, end), /^\s{6}ledgerTargetId:/m,
      `${builder} must retain the id of the document the operation acted on`,
    )
  }

  // …and a row read back off that metadata classifies the same way the formatter did.
  assert.equal(
    classifyUnrecordedIncident({
      type: 'BILL_ATTACHMENT', postedExternalId: null, externalEffect: 'MADE',
      ledgerTargetId: 'QBO-BILL-77',
    }),
    'NO_IDENTIFIER_SIDE_EFFECT',
  )

  // The id comes off the row's own payload — the same handle the handler uploaded against.
  assert.equal(ledgerTargetIdFromPayload({ accountingInvoiceId: 'QBO-BILL-77' }), 'QBO-BILL-77')
  assert.equal(ledgerTargetIdFromPayload({ accountingInvoiceId: '' }), null)
  assert.equal(ledgerTargetIdFromPayload({}), null)
  assert.equal(ledgerTargetIdFromPayload(null), null)
})

// MUTATION THAT KILLS THIS (run): restore "open the order in WooCommerce and remove any duplicate
// note" to QBO_OPERATIONS_WITHOUT_REQUEST_ID.WC_INVOICE_NOTE.check, or "Review the tax rates in
// {ledger}, and correct or archive that rate there if this write was wrong" to
// NON_DOCUMENT_INCIDENT_WORDING.TAX_RATE_SYNC.remedy — each equality fails on the whole message,
// and the fence in record-names-only-what-it-holds.test.ts fails alongside it. Restoring the
// NON_DOCUMENT WC_INVOICE_NOTE.remedy instead kills ONLY that fence, because the QuickBooks note
// incident takes the replay frame and never renders that string — which is exactly why the fence
// covers the tables and these equalities cover the frames.
//
// ROUTE: both messages are generated by the shipped formatters; these are the two OTHER instances
// the re-check of every shipped remedy turned up.
test('ROUND 12 (Codex MEDIUM): the two other remedies that acted on an object the record cannot name', () => {
  assert.equal(
    describeUnpersistedQboPost({ entry: NOTE, postedExternalId: null }, new Error('write conflict')),
    QBO_WC_NOTE,
  )
  assert.match(QBO_WC_NOTE, /THIS RECORD DOES NOT NAME THE WOOCOMMERCE ORDER/)
  assert.doesNotMatch(QBO_WC_NOTE, /open the order in WooCommerce/)

  assert.equal(
    describeUnrecordablePostedDocument({
      entry: RATE, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
    }),
    XERO_TAX_RATE,
  )
  assert.match(XERO_TAX_RATE, /THIS RECORD DOES NOT SAY WHAT THE RATE WAS BEFORE THE WRITE/)
  assert.doesNotMatch(XERO_TAX_RATE, /correct or archive that rate/)
})

// ---------------------------------------------------------------------------------------------
// ROUND 13 (Codex HIGH) — THE CELL A LEGACY RECORD COULD NOT REACH.
//
// Round 12 built `MADE_TARGET_UNRECORDED` for "a record written before IMS kept the bill id", and
// the test above proves the FORMATTERS route into it. That is only half an answer, and the missing
// half is the one that matters: the description is rendered ONCE and stored in
// `ActivityLog.description`, nothing re-renders it, and the row is exempt from BOTH retention and
// the factory reset. Records that predate the retained id therefore never went near the new cell —
// they keep the round-11 sentence "open that bill in {ledger} and remove the duplicate attachment"
// for ever, about a bill that after a reset nothing in this installation can identify. A cell no
// existing record can reach is not a fix for existing records.
//
// SO THERE ARE TWO PROPERTIES HERE, AND THEY ARE DIFFERENT PROPERTIES.
//
//   1. EVERY PATH THAT BUILDS ONE ROUTES A MISSING ID INTO THE SAFE CELL. There are three — the
//      QuickBooks escalation, the Xero conflict transaction, and the Xero standalone re-attempt
//      after that transaction could not commit — and they resolve to TWO constructions of a
//      `PostedOperationOutcome`, because the third re-renders the incident the second built. Both
//      read the id off the sync row's own PAYLOAD, so a row written before this branch existed
//      (no `accountingInvoiceId` in its payload) yields `null` and lands in the safe cell from
//      either one. That is asserted against the shipped sources, so a fourth path that forgets is
//      a red build rather than a silent old remedy.
//   2. A RECORD ALREADY IN THE DATABASE REACHES IT WHEN IT IS READ. `remedyForStoredIncident`
//      rebuilds the remedy from the record's own metadata through the same reader the classifier
//      uses, so a stored blob selects the cell the formatter would select today: no
//      `ledgerTargetId` key selects `MADE_TARGET_UNRECORDED`, no `externalEffect` key selects
//      `UNRECORDED`, and both refuse to name a bill. /activity prints it beside the stored sentence
//      when the stored sentence is not it.
//
// WHAT IS NOT CLOSED, SAID PLAINLY: the stored text ITSELF is still wrong, and correcting it needs
// a write to a permanent record — filed as o3d-xaun, with the reason it was not made here (the
// stored sentence also carries this incident's cause, which the metadata does not).
// ---------------------------------------------------------------------------------------------

/** The metadata a record written BEFORE round 12 carries: no `ledgerTargetId` key at all. */
const PRE_ROUND_12_METADATA = Object.freeze({
  syncLogId: 'log-1',
  type: 'BILL_ATTACHMENT',
  referenceType: 'PurchaseOrder',
  referenceId: 'po-1',
  postedExternalId: null,
  postingMode: 'LIVE',
  externalEffect: 'MADE',
})

/** The remedy that record was GIVEN, which is the thing the operator is reading today. */
const ROUND_11_STORED_REMEDY =
  'QuickBooks BILL_ATTACHMENT for PurchaseOrder po-1 SUCCEEDED — the external effect has happened '
  + '— but IMS could not record that it did. WHAT TO DO ABOUT THE EFFECT: open that bill in '
  + 'QuickBooks and remove any duplicate attachment.'

/**
 * The safe cell as each connector's own frame prints it. They are different sentences because the
 * frames are: on QuickBooks the effect REPEATS once per sweep, so its "what to do" lives in the
 * replay table, and handing a QuickBooks record the Xero sentence would be a fourth wording for one
 * incident. Both refuse to send anybody to a bill.
 */
const QBO_SAFE_CELL_REMEDY =
  'WHAT TO DO ABOUT THE EFFECT: THIS RECORD DOES NOT NAME THE BILL THE PDF WENT ONTO, so it cannot '
  + 'send you to the duplicates and nothing kept here derives the bill. Escalate this record to '
  + 'whoever administers this installation.'
const XERO_SAFE_CELL_REMEDY =
  'REMEDY: DO NOT REMOVE AN ATTACHMENT FROM A BILL THIS RECORD CANNOT NAME. The upload happened, '
  + 'so a duplicate may exist, but nothing kept here says which bill it is on and nothing kept here '
  + 'derives it. Escalate this record to whoever administers this installation.'

// MUTATION THAT KILLS THIS (run): in `outcomeFromStoredMetadata`, fall back to the record's other
// id — `ledgerTargetId: typeof ledgerTargetId === 'string' ? nonEmpty(ledgerTargetId) : nonEmpty(...)`
// — or simply have `outcomeWordingVariant` answer 'MADE' whenever the effect was MADE, and the
// pre-round-12 blob renders the NAMED remedy: the first equality fails on the whole string, and the
// `{ledgerTargetId}` slot throws while rendering because the blob carries no id to put in it. RUN.
//
// ROUTE: the metadata is the shape the pre-round-12 builder wrote (its keys are parsed out of the
// SHIPPED builder below, so it cannot drift into a shape no record ever had); the remedy is
// produced by the shipped `remedyForStoredIncident`; the wording is the shipped table.
test('ROUND 13 (Codex HIGH): a record written before the bill id was retained reaches the safe cell when it is READ', async () => {
  // THE LOAD-BEARING CASE. A record built the way a pre-round-12 record was built — MADE, with no
  // `ledgerTargetId` key in its metadata at all — read back today.
  assert.equal(
    remedyForStoredIncident(QBO_UNRECORDED_POSTED_DOCUMENT_ACTION, PRE_ROUND_12_METADATA),
    QBO_SAFE_CELL_REMEDY,
  )
  assert.equal(
    remedyForStoredIncident(UNRECORDED_POSTED_DOCUMENT_ACTION, PRE_ROUND_12_METADATA),
    XERO_SAFE_CELL_REMEDY,
    'the same record on the other connector reaches the safe cell through its OWN frame',
  )
  for (const safe of [QBO_SAFE_CELL_REMEDY, XERO_SAFE_CELL_REMEDY]) {
    assert.doesNotMatch(safe, /open that bill|remove the duplicate|remove any duplicate/i)
    assert.match(safe, /Escalate this record to whoever administers this installation/)
  }

  // AND THE BLOB IS A SHAPE A RECORD REALLY HAD. Every key above except `ledgerTargetId` is one the
  // shipped builder still writes; `ledgerTargetId` is the one round 12 added, and its ABSENCE is
  // the whole case. A test whose fixture drifted into a shape no record ever carried would prove
  // nothing about the records in the database.
  const source = await readFile(
    path.join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8',
  )
  const metadataAt = source.indexOf('sanitizeActivityLogMetadata({')
  const builderKeys = source.slice(metadataAt, source.indexOf('}))', metadataAt))
  for (const key of Object.keys(PRE_ROUND_12_METADATA)) {
    assert.match(builderKeys, new RegExp(`^\\s+${key}:`, 'm'), `the builder still writes ${key}`)
  }
  assert.match(builderKeys, /^\s+ledgerTargetId:/m, 'and it writes the key this fixture omits')

  // A RECORD WITH NO RECORDED OUTCOME AT ALL — written before round 10 — is safe by the same rule:
  // an absent key reads as "not recorded", never as a live upload.
  const { postingMode, externalEffect, ...preRound10 } = PRE_ROUND_12_METADATA
  assert.equal(
    remedyForStoredIncident(QBO_UNRECORDED_POSTED_DOCUMENT_ACTION, preRound10),
    'WHAT TO DO ABOUT THE EFFECT: IMS DID NOT RECORD WHETHER THIS ATTEMPT UPLOADED ANYTHING, and it '
    + 'does not name the bill either. READ quickbooks_sync_attach_pdf AS IT STANDS NOW to learn what '
    + 'a replay would do, and escalate this record to whoever administers this installation rather '
    + 'than clearing an attachment off a bill picked out any other way.',
  )
  assert.equal(
    remedyForStoredIncident(UNRECORDED_POSTED_DOCUMENT_ACTION, preRound10),
    'REMEDY: DO NOT REMOVE AN ATTACHMENT ON THE STRENGTH OF THIS RECORD — this attempt may never '
    + 'have created one, and this record does not name the bill one would be on. Escalate this '
    + 'record to whoever administers this installation.',
  )

  // A record that DOES carry the id still gets the remedy that spends it, so this is not "always
  // refuse".
  assert.equal(
    remedyForStoredIncident(
      QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
      { ...PRE_ROUND_12_METADATA, ledgerTargetId: 'QBO-BILL-77' },
    ),
    'WHAT TO DO ABOUT THE EFFECT: Find that bill in QuickBooks by the ledger document id above and '
    + 'remove any duplicate attachment.',
  )

  // WHAT IT REFUSES TO ANSWER FOR, rather than guessing: a document incident, whose remedy is
  // chosen by which OTHER document the row named at the moment of the conflict — a fact the
  // metadata does not carry.
  assert.equal(
    remedyForStoredIncident(QBO_UNRECORDED_POSTED_DOCUMENT_ACTION, {
      ...PRE_ROUND_12_METADATA, type: 'PURCHASE_INVOICE', postedExternalId: 'QBO-BILL-9',
    }),
    undefined,
  )
  assert.equal(remedyForStoredIncident('some_other_action', PRE_ROUND_12_METADATA), undefined)
  assert.equal(remedyForStoredIncident(QBO_UNRECORDED_POSTED_DOCUMENT_ACTION, null), undefined)
})

// MUTATION THAT KILLS THIS (run): make `supersedingRemedyForStoredIncident` return the remedy
// unconditionally (drop the `description.includes` check) and the second assertion fails — every
// current record would be told it was written by an earlier version. Making it return `undefined`
// unconditionally fails the first.
//
// ROUTE: the shipped reader, against a stored description that really is the round-11 sentence and
// against one this version generates.
test('ROUND 13 (Codex HIGH): the current remedy is shown only where the stored one is not it', () => {
  assert.equal(
    supersedingRemedyForStoredIncident({
      action: QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
      description: ROUND_11_STORED_REMEDY,
      metadata: PRE_ROUND_12_METADATA,
    }),
    QBO_SAFE_CELL_REMEDY,
    'the stored sentence sends an operator to a bill nothing names — the current one must be shown',
  )
  assert.match(ROUND_11_STORED_REMEDY, /open that bill in QuickBooks and remove any duplicate/,
    'not vacuous: the stored text really is the instruction this round refuses')

  // A record written by THIS version already contains it, and gets nothing added.
  const current = describeUnpersistedQboPost(
    { entry: ATTACH, postedExternalId: null, outcome: { externalEffect: 'MADE' } },
    new Error('write conflict'),
  )
  assert.match(current, /THIS RECORD DOES NOT NAME THE BILL THE PDF WENT ONTO/)
  assert.equal(
    supersedingRemedyForStoredIncident({
      action: QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
      description: current,
      metadata: { ...PRE_ROUND_12_METADATA },
    }),
    undefined,
  )
})

// MUTATION THAT KILLS THIS (run): drop `ledgerTargetId: ledgerTargetIdFromPayload(payload)` from
// either connector's `PostedOperationOutcome` construction — or replace it with the row's external
// id — and the assertion fails naming that file. RUN on both.
//
// ROUTE: the SHIPPED connector sources. Every construction of a `PostedOperationOutcome` in either
// processor is found by the type annotation the compiler already requires, so a fourth path cannot
// be added without appearing here.
test('ROUND 13 (Codex HIGH): every path that builds one of these records reads the bill id off the payload', async () => {
  let constructions = 0
  for (const file of [
    'lib/connectors/quickbooks/sync-processor.ts',
    'lib/connectors/xero/sync-processor.ts',
  ]) {
    const source = await readFile(path.join(process.cwd(), file), 'utf8')
    const matches = [...source.matchAll(/const \w+: PostedOperationOutcome = \{([\s\S]*?)\n {2}\}/g)]
    assert.ok(matches.length > 0, `${file} must still build the outcome these records are written from`)
    for (const match of matches) {
      constructions += 1
      assert.match(
        match[1], /ledgerTargetId: ledgerTargetIdFromPayload\(payload\)/,
        `${file} builds an outcome that does not read the ledger target off the row's payload, so a `
        + 'record built from it would claim a bill it cannot name',
      )
    }
  }
  assert.equal(constructions, 2, 'both processors build exactly one, and both were checked')

  // A payload written before this branch existed carries no `accountingInvoiceId`, and that is what
  // makes both of those constructions land in the safe cell.
  assert.equal(ledgerTargetIdFromPayload({ supplierInvoicePath: 'uploads/bill-1.pdf' }), null)
})

// MUTATION THAT KILLS THIS (run): restore `stands: 'AN ATTACHMENT NOW EXISTS ON {LEDGER} BILL
// {ledgerTargetId}, …'` to NON_DOCUMENT_INCIDENT_WORDING.BILL_ATTACHMENT.MADE and the scan finds
// it, naming the message. RUN.
//
// ROUTE: the messages are generated by the shipped formatters over both connectors and every
// outcome; the phrase is the one the round-12 code actually wrote.
test('ROUND 13 (Codex MEDIUM): the record says what the attempt DID to a remote object, not what stands on one now', () => {
  // Attachment or bill existence is MUTABLE and this record is not: an operator may remove the
  // duplicate, an administrator may change the bill, the bill may be deleted — and this record
  // survives retention AND the factory reset, so a current-state claim in it outlives its own truth.
  const PRESENT_REMOTE_CLAIM = /\b(?:AN?|THE) [A-Z]+ (?:NOW |STILL )?EXISTS\b/
  for (const { label, text } of everyIncidentMessage()) {
    assert.doesNotMatch(
      text, PRESENT_REMOTE_CLAIM,
      `${label} asserts that a remote object exists NOW. This record cannot know that: it outlives `
      + 'every change anybody makes to the ledger. Say what this attempt DID instead.',
    )
  }

  // NOT VACUOUS: the scan matches the wording this round replaced.
  assert.match('AN ATTACHMENT NOW EXISTS ON XERO BILL XERO-BILL-77', PRESENT_REMOTE_CLAIM)
  assert.match('AN ATTACHMENT NOW EXISTS ON A BILL IN XERO', PRESENT_REMOTE_CLAIM)

  // AND WHAT IT SAYS INSTEAD, on both cells.
  assert.match(XERO_MADE_NAMED_BILL, /THIS ATTEMPT UPLOADED AN ATTACHMENT ONTO XERO BILL XERO-BILL-77/)
  assert.match(XERO_MADE_UNNAMED_BILL, /THIS ATTEMPT UPLOADED AN ATTACHMENT ONTO A BILL IN XERO/)

  // WHAT THIS SCAN DOES NOT COVER, said rather than implied: the DOCUMENT wordings make the same
  // kind of claim in other words — "BOTH documents exist in {ledger}", "it is still unposted", "no
  // duplicate of it exists to open" — and correcting those is not a wording change, because the
  // whole "keep it or void it" remedy is built on the document being there to keep or void. It is a
  // wider class than this finding, and it is filed as o3d-ps83 rather than half-done here.
})
