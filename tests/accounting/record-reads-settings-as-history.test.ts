import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  OPERATION_SEMANTIC_BY_TYPE,
  UNRECORDED_POSTED_DOCUMENT_ACTION,
  classifyUnrecordedIncident,
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
// `externalEffect: NONE` proves only that the attach-PDF setting read "false" WHEN THIS
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

// MUTATION THAT KILLS THIS (run): restore the round-11 NONE wording — "Attachment upload is
// turned off for this connector" — to the non-document BILL_ATTACHMENT.NONE `did`, and this test
// fails naming that message and the claim `is turned off`. It was RUN. The bypass is also run
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

// MUTATION THAT KILLS THIS (run): change any row-state sentence back to the present tense — e.g.
// `Sync row ${entry.id} already named …` to `already names …` in a formatter frame — and the scan
// finds "already names", naming the message.
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
// MUTATION THAT KILLS THIS (run): drop `ledgerTargetId` from the record builder's metadata
// object and the retention assertion fails naming that builder; drop it from the `MADE` cell's
// `lookup` and the declaration test in record-names-only-what-it-holds.test.ts fails instead; make
// `outcomeWordingVariant` return 'MADE' regardless of the id and the UNNAMED equality fails with
// `render` throwing on an absent slot. All three were RUN.
//
// ROUTE: the messages come from the shipped formatter; the retained keys are
// parsed out of the connector source; the payload reader is the shipped export.
test('ROUND 12 (Codex MEDIUM): after a reset, the attachment remedy names the bill or sends nobody', async () => {
  // WITH the id — the state every record written from now on is in.
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
    describeUnrecordablePostedDocument({
      entry: ATTACH, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
      outcome: { externalEffect: 'MADE' },
    }),
    XERO_MADE_UNNAMED_BILL,
  )

  // The claims the equalities above are protecting, said out loud.
  assert.match(XERO_MADE_NAMED_BILL, /THIS ATTEMPT UPLOADED AN ATTACHMENT ONTO XERO BILL XERO-BILL-77/)
  for (const unnamed of [XERO_MADE_UNNAMED_BILL]) {
    assert.match(unnamed, /DOES NOT (?:NAME|carry the id of)/)
    assert.doesNotMatch(unnamed, /open that bill/i, 'it may not send anyone to a bill it cannot name')
    assert.match(unnamed, /Escalate this record to whoever administers this installation/)
  }

  // AND THE ID IS ACTUALLY RETAINED by the record builder — parsed from its source, because a
  // remedy that spends a field the builder does not write cannot be followed.
  for (const [file, builder] of [
    ['lib/connectors/xero/sync-processor.ts', 'unrecordedPostedDocumentRecord'],
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
      ledgerTargetId: 'XERO-BILL-77',
    }),
    'NO_IDENTIFIER_SIDE_EFFECT',
  )

  // The id comes off the row's own payload — the same handle the handler uploaded against.
  assert.equal(ledgerTargetIdFromPayload({ accountingInvoiceId: 'XERO-BILL-77' }), 'XERO-BILL-77')
  assert.equal(ledgerTargetIdFromPayload({ accountingInvoiceId: '' }), null)
  assert.equal(ledgerTargetIdFromPayload({}), null)
  assert.equal(ledgerTargetIdFromPayload(null), null)
})

// MUTATION THAT KILLS THIS (run): restore "Review the tax rates in {ledger}, and correct or archive
// that rate there if this write was wrong" to NON_DOCUMENT_INCIDENT_WORDING.TAX_RATE_SYNC.remedy —
// the equality fails on the whole message, and the fence in record-names-only-what-it-holds.test.ts
// fails alongside it. Restoring "open the order in WooCommerce" to
// NON_DOCUMENT_INCIDENT_WORDING.WC_INVOICE_NOTE.remedy kills the assertion on the note message.
//
// ROUTE: both messages are generated by the shipped formatter; these are the two OTHER instances
// the re-check of every shipped remedy turned up.
test('ROUND 12 (Codex MEDIUM): the two other remedies that acted on an object the record cannot name', () => {
  const xeroNote = describeUnrecordablePostedDocument({
    entry: NOTE, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
  })
  assert.match(xeroNote, /THIS RECORD DOES NOT NAME THE WOOCOMMERCE ORDER/)
  assert.doesNotMatch(xeroNote, /open the order in WooCommerce/)

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
//   1. EVERY PATH THAT BUILDS ONE ROUTES A MISSING ID INTO THE SAFE CELL. There are two — the Xero
//      conflict transaction, and the Xero standalone re-attempt after that transaction could not
//      commit — and they resolve to ONE construction of a `PostedOperationOutcome`, because the
//      second re-renders the incident the first built. It reads the id off the sync row's own
//      PAYLOAD, so a row written before this branch existed (no `accountingInvoiceId` in its
//      payload) yields `null` and lands in the safe cell. That is asserted against the shipped sources, so a fourth path that forgets is
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
  'Xero BILL_ATTACHMENT for PurchaseOrder po-1 SUCCEEDED — the external effect has happened '
  + '— but IMS could not record that it did. REMEDY: open that bill in '
  + 'Xero and remove any duplicate attachment.'

/** The safe cell as the frame prints it. It refuses to send anybody to a bill. */
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
    remedyForStoredIncident(UNRECORDED_POSTED_DOCUMENT_ACTION, PRE_ROUND_12_METADATA),
    XERO_SAFE_CELL_REMEDY,
  )
  for (const safe of [XERO_SAFE_CELL_REMEDY]) {
    assert.doesNotMatch(safe, /open that bill|remove the duplicate|remove any duplicate/i)
    assert.match(safe, /Escalate this record to whoever administers this installation/)
  }

  // The blob's keys are the ones the shipped builder writes, except `ledgerTargetId`: the one round 12
  // added, whose ABSENCE is the whole case.

  // A RECORD WITH NO RECORDED OUTCOME AT ALL — written before round 10 — is safe by the same rule:
  // an absent key reads as "not recorded", never as a live upload.
  const { postingMode, externalEffect, ...preRound10 } = PRE_ROUND_12_METADATA
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
      UNRECORDED_POSTED_DOCUMENT_ACTION,
      { ...PRE_ROUND_12_METADATA, ledgerTargetId: 'XERO-BILL-77' },
    ),
    'REMEDY: Find that bill in Xero by the ledger document id above and remove the duplicate '
    + 'attachment. There is no document to void, and the bill itself was not created by this attempt.',
  )

  // WHAT IT REFUSES TO ANSWER FOR, rather than guessing: a document incident, whose remedy is
  // chosen by which OTHER document the row named at the moment of the conflict — a fact the
  // metadata does not carry.
  assert.equal(
    remedyForStoredIncident(UNRECORDED_POSTED_DOCUMENT_ACTION, {
      ...PRE_ROUND_12_METADATA, type: 'PURCHASE_INVOICE', postedExternalId: 'XERO-BILL-9',
    }),
    undefined,
  )
  assert.equal(remedyForStoredIncident('some_other_action', PRE_ROUND_12_METADATA), undefined)
  assert.equal(remedyForStoredIncident(UNRECORDED_POSTED_DOCUMENT_ACTION, null), undefined)
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
      action: UNRECORDED_POSTED_DOCUMENT_ACTION,
      description: ROUND_11_STORED_REMEDY,
      metadata: PRE_ROUND_12_METADATA,
    }),
    XERO_SAFE_CELL_REMEDY,
    'the stored sentence sends an operator to a bill nothing names — the current one must be shown',
  )
  assert.match(ROUND_11_STORED_REMEDY, /open that bill in Xero and remove any duplicate/,
    'not vacuous: the stored text really is the instruction this round refuses')

  // A record written by THIS version already contains it, and gets nothing added.
  const current = describeUnrecordablePostedDocument({
    entry: ATTACH, postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
    outcome: { externalEffect: 'MADE' },
  })
  assert.match(current, /THIS RECORD DOES NOT NAME THAT BILL/)
  assert.equal(
    supersedingRemedyForStoredIncident({
      action: UNRECORDED_POSTED_DOCUMENT_ACTION,
      description: current,
      metadata: { ...PRE_ROUND_12_METADATA },
    }),
    undefined,
  )
})

// MUTATION THAT KILLS THIS (run): drop `ledgerTargetId: ledgerTargetIdFromPayload(payload)` from
// the processor's `PostedOperationOutcome` construction — or replace it with the row's external
// id — and the assertion fails naming that file. RUN.
//
// ROUTE: the SHIPPED connector source. Every construction of a `PostedOperationOutcome` in the
// processor is found by the type annotation the compiler already requires, so a fourth path cannot
// be added without appearing here.
test('ROUND 13 (Codex HIGH): every path that builds one of these records reads the bill id off the payload', async () => {
  let constructions = 0
  for (const file of [
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
  // The count is the VACUITY guard (a walk that found none must fail), not a claim about how many
  // there ought to be.
  assert.equal(constructions, 1, 'the processor builds exactly one, and it was checked')

  // A payload written before this branch existed carries no `accountingInvoiceId`, and that is what
  // makes that construction land in the safe cell.
  assert.equal(ledgerTargetIdFromPayload({ supplierInvoicePath: 'uploads/bill-1.pdf' }), null)
})

// MUTATION THAT KILLS THIS (run): restore `stands: 'AN ATTACHMENT NOW EXISTS ON {LEDGER} BILL
// {ledgerTargetId}, …'` to NON_DOCUMENT_INCIDENT_WORDING.BILL_ATTACHMENT.MADE and the scan finds
// it, naming the message. RUN.
//
// ROUTE: the messages are generated by the shipped formatters over every type and
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
