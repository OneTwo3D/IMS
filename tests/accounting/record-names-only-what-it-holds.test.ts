import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  INCIDENT_KIND_BY_OPERATION_TYPE,
  NON_DOCUMENT_INCIDENT_WORDING,
  describePreservedUnrecordedIncidents,
  describeUnpersistedQboPost,
  describeUnrecordablePostedDocument,
  incidentKindForOperation,
  type UnrecordedIncidentCounts,
  type UnrecordedIncidentKind,
} from '@/lib/domain/accounting/unrecorded-posted-document'

// ---------------------------------------------------------------------------
// ROUND 9 (Codex HIGH #1 + MEDIUM #1) — THE RECORD MAY ONLY TELL AN OPERATOR TO USE WHAT IT KEEPS,
// AND MAY ONLY DESCRIBE WHAT THE OPERATION ACTUALLY DID.
//
// Two defects with one shape. The formatters branched on whether an IDENTIFIER was present and
// never on what the OPERATION was, so a `PURCHASE_CREDIT_NOTE_ALLOCATION` — which succeeds with no
// external id precisely because it creates an allocation rather than a document — was told to be
// found, kept or voided as a document; and the remedy for a document with no id told the operator
// to search by "the reference, the amount and the date", two of which no record builder stores and
// none of which survives a factory reset.
//
// This file asserts the general rule rather than the two instances: EVERY message this module can
// produce is generated, and any lookup attribute it names must be a key one of the two record
// builders actually writes. The retained keys are PARSED FROM THE BUILDERS, so the rule cannot be
// satisfied by editing a list in the test.
// ---------------------------------------------------------------------------

const OPERATION_TYPES = Object.keys(INCIDENT_KIND_BY_OPERATION_TYPE) as AccountingSyncType[]

const ENTRY = (type: AccountingSyncType) => ({
  id: 'log-1',
  type,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
})

/** Every message the module can produce, for every operation type and every id/row combination. */
function everyIncidentMessage(): { label: string; text: string }[] {
  const messages: { label: string; text: string }[] = []
  for (const type of OPERATION_TYPES) {
    for (const posted of [null, 'EXT-1']) {
      messages.push({
        label: `qbo ${type} posted=${String(posted)}`,
        text: describeUnpersistedQboPost({ entry: ENTRY(type), postedExternalId: posted }, new Error('write conflict')),
      })
      for (const named of [null, 'EXT-OTHER']) {
        for (const reason of ['ROW_MISSING', 'ANOTHER_DOCUMENT_NAMED'] as const) {
          messages.push({
            label: `xero ${type} posted=${String(posted)} named=${String(named)} ${reason}`,
            text: describeUnrecordablePostedDocument({
              entry: ENTRY(type), postedExternalId: posted, namedExternalId: named, reason,
            }),
          })
        }
      }
    }
  }
  const kinds: UnrecordedIncidentKind[] = [
    'LEDGER_DOCUMENT', 'LEDGER_DOCUMENT_NO_IDENTIFIER', 'LEDGER_NON_DOCUMENT',
    'NO_IDENTIFIER_SIDE_EFFECT', 'UNCLASSIFIED',
  ]
  const zero: UnrecordedIncidentCounts = {
    LEDGER_DOCUMENT: 0, LEDGER_DOCUMENT_NO_IDENTIFIER: 0, LEDGER_NON_DOCUMENT: 0,
    NO_IDENTIFIER_SIDE_EFFECT: 0, UNCLASSIFIED: 0,
  }
  for (const kind of kinds) {
    messages.push({
      label: `breadcrumb ${kind}`,
      text: describePreservedUnrecordedIncidents({ ...zero, [kind]: 1 }),
    })
  }
  messages.push({ label: 'breadcrumb all kinds', text: describePreservedUnrecordedIncidents({
    LEDGER_DOCUMENT: 1, LEDGER_DOCUMENT_NO_IDENTIFIER: 1, LEDGER_NON_DOCUMENT: 1,
    NO_IDENTIFIER_SIDE_EFFECT: 1, UNCLASSIFIED: 1,
  }) })
  return messages
}

/**
 * The attributes a wording can send an operator to look a write up BY, and the metadata key that
 * would have to be retained for the instruction to be performable. Phrase-based on purpose: the
 * defect was always a PHRASE ("its amount and its date"), never a field reference.
 */
const LOOKUP_PHRASE_TO_FIELD: Readonly<Record<string, string>> = {
  'its amount': 'amount',
  'their amount': 'amount',
  'the amount': 'amount',
  'its date': 'date',
  'their date': 'date',
  'the date': 'date',
  'ledger date': 'date',
  'its currency': 'currency',
  'the currency': 'currency',
  'invoice number': 'invoiceNumber',
  'the customer name': 'customerName',
  'the supplier name': 'supplierName',
  'the contact name': 'contactName',
}

function lookupFieldsNamedBy(message: string): string[] {
  const lower = message.toLowerCase()
  const found = new Set<string>()
  for (const [phrase, field] of Object.entries(LOOKUP_PHRASE_TO_FIELD)) {
    if (lower.includes(phrase)) found.add(field)
  }
  return [...found].sort()
}

/**
 * The metadata keys each record builder actually writes, read from its source — PER BUILDER, and
 * then intersected. The wording below is shared by both connectors, so a key only ONE of them
 * writes is not a key the wording may rely on: a QuickBooks incident would arrive without it.
 * (Asserting against the union was the first shape of this test, and dropping `referenceId` from
 * the QuickBooks builder passed it.)
 */
async function retainedMetadataKeys(): Promise<{ perBuilder: Map<string, Set<string>>; common: Set<string> }> {
  const sources: [string, string][] = [
    ['lib/connectors/xero/sync-processor.ts', 'unrecordedPostedDocumentRecord'],
    ['lib/connectors/quickbooks/sync-processor.ts', 'unpersistedQboPostRecord'],
  ]
  const perBuilder = new Map<string, Set<string>>()
  for (const [file, builder] of sources) {
    const source = await readFile(path.join(process.cwd(), file), 'utf8')
    const start = source.indexOf(`function ${builder}`)
    assert.ok(start > 0, `${builder} must still exist in ${file} — this test is about what it writes`)
    const metadataAt = source.indexOf('sanitizeActivityLogMetadata({', start)
    assert.ok(metadataAt > start, `${builder} must still build its metadata through sanitizeActivityLogMetadata`)
    const end = source.indexOf('}))', metadataAt)
    assert.ok(end > metadataAt)
    const keys = new Set<string>()
    for (const line of source.slice(metadataAt, end).split('\n')) {
      const match = /^\s{6}([A-Za-z][A-Za-z0-9_]*):/.exec(line)
      if (match) keys.add(match[1])
    }
    assert.ok(keys.size > 0, `${builder}'s metadata object could not be read`)
    perBuilder.set(builder, keys)
  }
  const [first, ...rest] = [...perBuilder.values()]
  const common = new Set([...first].filter((key) => rest.every((other) => other.has(key))))
  return { perBuilder, common }
}

// MUTATION THAT KILLS THIS (run): put "its amount and its date" back into either no-identifier
// remedy in lib/domain/accounting/unrecorded-posted-document.ts — the generated message names
// `amount` and `date`, neither of which the builders write, and the assertion fails naming the
// message. Deleting a key from `unrecordedPostedDocumentRecord`'s metadata kills it the other way.
//
// ROUTE: the messages come from the exported formatters, and the retained keys are PARSED OUT OF
// THE TWO CONNECTOR SOURCE FILES — neither side of the comparison is written down in this file, so
// it cannot pass by agreeing with itself.
test('ROUND 9 (Codex MEDIUM): no wording tells an operator to use a field the record does not retain', async () => {
  const { common: retained } = await retainedMetadataKeys()

  // NOT VACUOUS: the detector fires on the sentence that was actually shipped.
  assert.deepEqual(
    lookupFieldsNamedBy(
      'REMEDY: find the document in QuickBooks by the reference above, its amount and its date, and void any duplicate.',
    ),
    ['amount', 'date'],
    'the detector must catch the round-8 wording, or this whole test proves nothing',
  )
  assert.ok(!retained.has('amount') && !retained.has('date'), 'and neither builder retains them')

  for (const { label, text } of everyIncidentMessage()) {
    for (const field of lookupFieldsNamedBy(text)) {
      assert.ok(
        retained.has(field),
        `${label} tells the operator to use "${field}", which no record builder writes:\n${text}`,
      )
    }
  }
})

// MUTATION THAT KILLS THIS (run): drop `referenceId` (or `type`, or `syncLogId`) from the metadata
// object in either builder — the tail still promises it and the assertion fails on that key.
//
// ROUTE: the promise is read out of the SHIPPED tail string, the keys out of the SHIPPED builders,
// and the timestamp out of prisma/schema.prisma.
test('ROUND 9: every field the record promises it holds is one EVERY builder writes', async () => {
  const { perBuilder } = await retainedMetadataKeys()
  const tail = describeUnpersistedQboPost(
    { entry: ENTRY('INVOICE_PAYMENT'), postedExternalId: null },
    new Error('write conflict'),
  )
  assert.match(tail, /WHAT THIS RECORD HOLDS/, 'the tail is what makes the promise')

  // Each clause of the tail, and the key it commits the builders to.
  const promised: [RegExp, string][] = [
    [/the operation type/, 'type'],
    [/the IMS reference above/, 'referenceId'],
    [/the sync row id/, 'syncLogId'],
  ]
  for (const [clause, key] of promised) {
    assert.match(tail, clause)
    for (const [builder, keys] of perBuilder) {
      assert.ok(keys.has(key), `the tail promises ${String(clause)}, but ${builder} does not write ${key}`)
    }
  }
  for (const [builder, keys] of perBuilder) {
    assert.ok(keys.has('referenceType'), `${builder}: the reference is only usable with the type of thing it names`)
  }

  // The last clause the tail names is not metadata at all — it is the log row's own timestamp.
  assert.match(tail, /the time this record was written/)
  const schema = await readFile(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const activityLog = /model ActivityLog \{([\s\S]*?)\n\}/.exec(schema)
  assert.ok(activityLog, 'the incident is an ActivityLog row')
  assert.match(activityLog![1], /createdAt\s+DateTime/, 'and the time it was written is a column on it')
})

// MUTATION THAT KILLS THIS (run): change `incidentKindForOperation` back to the id-only question
// (`return posted ? 'LEDGER_DOCUMENT' : 'LEDGER_DOCUMENT_NO_IDENTIFIER'`) and the allocation falls
// into the document branch — "keep it" and "void it" reappear and every doesNotMatch below fails.
//
// ROUTE: the message comes from the exported Xero formatter with a real non-document operation
// type; the forbidden phrases are the ones the shipped document branch emits.
test('ROUND 9 (Codex HIGH): a Xero non-document incident with no identifier gets no document instruction', () => {
  for (const reason of ['ROW_MISSING', 'ANOTHER_DOCUMENT_NAMED'] as const) {
    const message = describeUnrecordablePostedDocument({
      entry: { id: 'log-9', type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', referenceType: 'SupplierCreditNote', referenceId: 'scn-9' },
      postedExternalId: null,
      namedExternalId: reason === 'ANOTHER_DOCUMENT_NAMED' ? 'CN-1' : null,
      reason,
    })

    // THE DEFECT: every one of these directs an operator at a document that was never created.
    assert.doesNotMatch(message, /keep it \(re-enter the reference by hand\) or void it/, reason)
    assert.doesNotMatch(message, /find it in Xero/, reason)
    assert.doesNotMatch(message, /open both ids in Xero/, reason)
    assert.doesNotMatch(message, /BOTH documents exist in Xero/, reason)
    assert.doesNotMatch(message, /POSTED as \(no id returned\)/, reason)

    // What it says instead — the allocation, and the thing that actually undoes one.
    assert.match(message, /THIS IS NOT A DOCUMENT/, reason)
    assert.match(message, /DO NOT OPEN, KEEP OR VOID EITHER THE BILL OR THE CREDIT NOTE/, reason)
    assert.match(message, /removing that allocation from the credit note in Xero/, reason)
    assert.match(message, /Xero accepted the write and no reset of ours undoes it/, reason)
  }

  // The four side-effect operations and an unknown type reach it from the same door.
  const email = describeUnrecordablePostedDocument({
    entry: { id: 'log-9', type: 'INVOICE_EMAIL', referenceType: 'SalesOrder', referenceId: 'order-9' },
    postedExternalId: null, namedExternalId: null, reason: 'ROW_MISSING',
  })
  assert.match(email, /NOTHING WAS CREATED IN XERO AT ALL/)
  assert.match(email, /IMS CANNOT CANCEL A QUEUED COPY/)
  assert.doesNotMatch(email, /find it in Xero/)

  const unknown = describeUnrecordablePostedDocument({
    entry: { id: 'log-9', type: 'FUTURE_LEDGER_THING' as AccountingSyncType, referenceType: 'SalesOrder', referenceId: 'order-9' },
    postedExternalId: 'X-1', namedExternalId: null, reason: 'ROW_MISSING',
  })
  assert.match(unknown, /DOES NOT CLASSIFY THAT OPERATION TYPE/)
  assert.match(unknown, /DO NOT ASSUME A DOCUMENT/)
  assert.doesNotMatch(unknown, /find it in Xero/)
})

// MUTATION THAT KILLS THIS (run): move any type in INCIDENT_KIND_BY_OPERATION_TYPE to
// LEDGER_NON_DOCUMENT without adding a wording entry — the build fails on the Record<> key set, and
// deleting an entry from NON_DOCUMENT_INCIDENT_WORDING fails this test's first assertion.
test('ROUND 9: every operation the map calls a non-document has its own remedy, on both connectors', () => {
  const nonDocuments = OPERATION_TYPES.filter(
    (type) => incidentKindForOperation(type, null) === 'LEDGER_NON_DOCUMENT'
      || incidentKindForOperation(type, null) === 'NO_IDENTIFIER_SIDE_EFFECT',
  ).sort()

  assert.deepEqual(Object.keys(NON_DOCUMENT_INCIDENT_WORDING).sort(), nonDocuments)
  assert.ok(nonDocuments.length >= 6, `sanity: ${nonDocuments.length} non-document operations`)

  for (const type of nonDocuments) {
    for (const posted of [null, 'EXT-1']) {
      const xero = describeUnrecordablePostedDocument({
        entry: ENTRY(type), postedExternalId: posted, namedExternalId: null, reason: 'ROW_MISSING',
      })
      const qbo = describeUnpersistedQboPost({ entry: ENTRY(type), postedExternalId: posted }, new Error('boom'))
      for (const [connector, message] of [['xero', xero], ['quickbooks', qbo]] as const) {
        assert.doesNotMatch(message, /void any duplicate\./, `${connector} ${type}`)
        assert.doesNotMatch(message, /confirm exactly one document exists/, `${connector} ${type}`)
        assert.doesNotMatch(message, /keep it \(re-enter the reference by hand\)/, `${connector} ${type}`)
      }
      // The QuickBooks four keep the o3d-qn21 replay wording they already had; the rest take the
      // shared non-document message. Either way, no document instruction.
      assert.ok(
        /NOTHING WAS CREATED IN/.test(qbo) || /NO REQUEST ID PROTECTS IT/.test(qbo) || /THIS IS NOT A DOCUMENT/.test(qbo),
        `${type} must say what it was instead of a document`,
      )
    }
  }
})

// MUTATION THAT KILLS THIS (run): restore "the copies that record tells you to count are gone with
// it and the count cannot be made after the fact" to the side-effect sentence — the verb the
// breadcrumb attributes becomes "count", and the second assertion fails against the wording that
// forbids reporting one.
//
// ROUTE: both strings are generated from the shipped module; the verb is extracted from the
// breadcrumb rather than written down here, so the two can only agree by actually agreeing.
test('ROUND 9 (Codex MEDIUM): the reset breadcrumb attributes to the incident only what the incident says', () => {
  const breadcrumb = describePreservedUnrecordedIncidents({
    LEDGER_DOCUMENT: 0, LEDGER_DOCUMENT_NO_IDENTIFIER: 0, LEDGER_NON_DOCUMENT: 0,
    NO_IDENTIFIER_SIDE_EFFECT: 1, UNCLASSIFIED: 0,
  })
  const emailRecord = describeUnpersistedQboPost(
    { entry: ENTRY('INVOICE_EMAIL'), postedExternalId: null },
    new Error('write conflict'),
  )

  const attributed = /that record tells you to ([a-z]+)/.exec(breadcrumb)
  assert.ok(attributed, 'the breadcrumb must say what the record it preserved asks for')
  const verb = attributed![1]
  assert.match(
    emailRecord,
    new RegExp(`\\b${verb}\\b`, 'i'),
    `the breadcrumb says the record tells you to "${verb}", so the record's own wording must say it`,
  )

  // THE DEFECT: the breadcrumb still described the count instruction round 7 deleted, and the reset
  // has already destroyed the rows that would settle which of the two was right.
  assert.notEqual(verb, 'count')
  assert.match(emailRecord, /DO NOT REPORT A COUNT/, 'the record forbids exactly what the breadcrumb used to attribute')
  assert.doesNotMatch(breadcrumb, /the count cannot be made/i)
  assert.match(breadcrumb, /statuses can no longer be inspected/)
})
