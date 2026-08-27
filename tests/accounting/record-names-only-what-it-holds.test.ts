import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  DOCUMENT_INCIDENT_WORDING,
  NON_DOCUMENT_INCIDENT_WORDING,
  OPERATION_SEMANTIC_BY_TYPE,
  RECORD_LOOKUP_FIELDS,
  describePreservedUnrecordedIncidents,
  describeUnpersistedQboPost,
  describeUnrecordablePostedDocument,
  incidentKindForOperation,
  type LedgerPostingMode,
  type PostedOperationOutcome,
  type RemoteEffectOutcome,
  type UnrecordedIncidentCounts,
  type UnrecordedIncidentKind,
} from '@/lib/domain/accounting/unrecorded-posted-document'

// ---------------------------------------------------------------------------
// THE RECORD MAY ONLY TELL AN OPERATOR TO USE WHAT IT KEEPS.
//
// ROUND 9 wrote this as a DETECTOR: a hand-written table of English phrases ("its amount", "its
// date"), scanned over every generated message. Codex's round-10 finding is that the detector is
// bypassable by writing different words — a remedy saying "search by gross total and posting day"
// names two fields no builder writes, produces an EMPTY detected-field set, and passes. Generating
// every formatter branch does not make an open-ended phrase allowlist exhaustive.
//
// ROUND 10 INVERTS IT. The wording tables DECLARE what they need (`needs`), and name a record value
// only through a `{placeholder}` the renderer resolves. This file validates the DECLARATION against
// the metadata the two builders actually write, and validates that no template names anything it did
// not declare. A remedy that needs a field the record does not hold therefore fails to compile
// (`needs: ['grossTotal']` is not a `RecordLookupField`) or fails a test here, whatever words it is
// written in.
// ---------------------------------------------------------------------------

const OPERATION_TYPES = Object.keys(OPERATION_SEMANTIC_BY_TYPE) as AccountingSyncType[]

const ENTRY = (type: AccountingSyncType) => ({
  id: 'log-1',
  type,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
})

const OUTCOMES: (PostedOperationOutcome | undefined)[] = [
  undefined,
  { postingMode: 'LIVE' as LedgerPostingMode },
  { postingMode: 'DRAFT' as LedgerPostingMode },
  { externalEffect: 'MADE' as RemoteEffectOutcome },
  { externalEffect: 'NONE' as RemoteEffectOutcome },
  { postingMode: 'LIVE' as LedgerPostingMode, externalEffect: 'MADE' as RemoteEffectOutcome },
  { postingMode: 'DRAFT' as LedgerPostingMode, externalEffect: 'NONE' as RemoteEffectOutcome },
]

/** Every message the module can produce, for every type, every id combination and every outcome. */
function everyIncidentMessage(): { label: string; text: string }[] {
  const messages: { label: string; text: string }[] = []
  for (const type of OPERATION_TYPES) {
    for (const outcome of OUTCOMES) {
      const o = JSON.stringify(outcome ?? null)
      for (const posted of [null, 'EXT-1']) {
        messages.push({
          label: `qbo ${type} posted=${String(posted)} outcome=${o}`,
          text: describeUnpersistedQboPost(
            { entry: ENTRY(type), postedExternalId: posted, outcome },
            new Error('write conflict'),
          ),
        })
        for (const named of [null, 'EXT-OTHER']) {
          for (const reason of ['ROW_MISSING', 'ANOTHER_DOCUMENT_NAMED'] as const) {
            messages.push({
              label: `xero ${type} posted=${String(posted)} named=${String(named)} ${reason} outcome=${o}`,
              text: describeUnrecordablePostedDocument({
                entry: ENTRY(type), postedExternalId: posted, namedExternalId: named, reason, outcome,
              }),
            })
          }
        }
      }
    }
  }
  const kinds: UnrecordedIncidentKind[] = [
    'LEDGER_DOCUMENT', 'LEDGER_DOCUMENT_NO_IDENTIFIER', 'LEDGER_DRAFT', 'LEDGER_OUTCOME_UNRECORDED',
    'LEDGER_NON_DOCUMENT', 'NO_IDENTIFIER_SIDE_EFFECT', 'UNCLASSIFIED',
  ]
  const zero: UnrecordedIncidentCounts = {
    LEDGER_DOCUMENT: 0, LEDGER_DOCUMENT_NO_IDENTIFIER: 0, LEDGER_DRAFT: 0,
    LEDGER_OUTCOME_UNRECORDED: 0, LEDGER_NON_DOCUMENT: 0, NO_IDENTIFIER_SIDE_EFFECT: 0,
    UNCLASSIFIED: 0,
  }
  for (const kind of kinds) {
    messages.push({
      label: `breadcrumb ${kind}`,
      text: describePreservedUnrecordedIncidents({ ...zero, [kind]: 1 }),
    })
  }
  const allOnes = Object.fromEntries(kinds.map((k) => [k, 1])) as UnrecordedIncidentCounts
  messages.push({ label: 'breadcrumb all kinds', text: describePreservedUnrecordedIncidents(allOnes) })
  return messages
}

/**
 * The metadata keys each record builder actually writes, read from its source — PER BUILDER, and
 * then intersected. The wording is shared by both connectors, so a key only ONE of them writes is
 * not a key the wording may rely on: a QuickBooks incident would arrive without it. (Asserting
 * against the UNION was the first shape of this test, and dropping `referenceId` from the
 * QuickBooks builder passed it.)
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

/** Every wording entry in the module, flattened, with the strings it can render. */
function everyWordingEntry(): { label: string; templates: string[]; needs: readonly string[] }[] {
  const out: { label: string; templates: string[]; needs: readonly string[] }[] = []
  for (const [key, w] of Object.entries(DOCUMENT_INCIDENT_WORDING)) {
    const { needs, ...rest } = w
    out.push({ label: `DOCUMENT_INCIDENT_WORDING.${key}`, templates: Object.values(rest), needs })
  }
  for (const [type, entry] of Object.entries(NON_DOCUMENT_INCIDENT_WORDING)) {
    const variants = 'did' in entry ? { '': entry } : entry
    for (const [variant, w] of Object.entries(variants)) {
      const { needs, ...rest } = w
      out.push({
        label: `NON_DOCUMENT_INCIDENT_WORDING.${type}${variant ? `.${variant}` : ''}`,
        templates: Object.values(rest),
        needs,
      })
    }
  }
  return out
}

const PLACEHOLDER = /\{([A-Za-z]+)\}/g

// MUTATION THAT KILLS THIS (run): add `'grossTotal'` to any entry's `needs` — it is not a
// `RecordLookupField`, so the BUILD fails before the test does; declare an existing field the
// builders do not both write (e.g. `'rowNamesExternalId'`, which only the Xero builder writes) and
// this test fails naming the entry. Deleting `postedExternalId` from either builder's metadata
// object kills it the other way.
//
// ROUTE: the declarations come from the SHIPPED wording tables, and the retained keys are PARSED
// OUT OF THE TWO CONNECTOR SOURCE FILES. Neither side of the comparison is written down here, so it
// cannot pass by agreeing with itself.
test('ROUND 10 (Codex MEDIUM): every field a wording DECLARES is one every record builder writes', async () => {
  const { common: retained } = await retainedMetadataKeys()

  // NOT VACUOUS: the comparison can fail. `rowNamesExternalId` is a real key of the Xero builder,
  // and it is exactly the kind of field a shared wording must not lean on.
  const { perBuilder } = await retainedMetadataKeys()
  assert.ok(
    perBuilder.get('unrecordedPostedDocumentRecord')!.has('rowNamesExternalId'),
    'the Xero builder writes rowNamesExternalId',
  )
  assert.ok(!retained.has('rowNamesExternalId'), 'and it is NOT common to both, so a declaration of it must fail')

  const entries = everyWordingEntry()
  assert.ok(entries.length >= 12, `sanity: ${entries.length} wording entries were found`)
  for (const { label, needs } of entries) {
    for (const field of needs) {
      assert.ok(
        retained.has(field),
        `${label} declares "${field}", which is not a key both record builders write`,
      )
    }
  }
})

// MUTATION THAT KILLS THIS (run): put a bare `{amount}` (or any undeclared slot) into any remedy
// string — `render` throws while generating, and the assertion below fails naming the entry. Put
// `{postedExternalId}` into a template of an entry whose `needs` omits it and the declaration
// assertion fails instead.
//
// ROUTE: the templates are read out of the SHIPPED wording tables, and the slot vocabulary out of
// the SHIPPED `RECORD_LOOKUP_FIELDS`.
test('ROUND 10: a wording names a record value only through a slot it declared, and only a real one', () => {
  const known = new Set<string>([...RECORD_LOOKUP_FIELDS, 'ledger', 'LEDGER'])
  let sawOne = false
  for (const { label, templates, needs } of everyWordingEntry()) {
    for (const template of templates) {
      for (const [, slot] of template.matchAll(PLACEHOLDER)) {
        assert.ok(known.has(slot), `${label} names the slot "${slot}", which is not a thing this record holds`)
        if (slot === 'ledger' || slot === 'LEDGER') continue
        sawOne = true
        assert.ok(
          needs.includes(slot),
          `${label} renders "{${slot}}" without declaring it in needs`,
        )
      }
    }
  }
  assert.ok(sawOne, 'the check must actually have seen a record slot, or it proves nothing')
})

// MUTATION THAT KILLS THIS (run): drop the `render(...)` call from around `w.bothExist` in the Xero
// formatter — the template's `{ledger}` reaches an operator verbatim and the scan below fails. That
// is the failure this guards: `render` itself THROWS on an unknown slot and on a declared one whose
// value is absent, so the only way a slot survives into a message is a template the formatter forgot
// to put through it. (Making `render` return the literal instead of throwing does NOT kill this
// today — no wording selects an absent slot — so that weaker mutation was rejected as evidence.)
//
// ROUTE: every message is GENERATED from the shipped formatters, over every type, id combination
// and outcome.
test('ROUND 10: no message this module can produce leaks an unresolved slot', () => {
  const messages = everyIncidentMessage()
  assert.ok(messages.length > 500, `sanity: ${messages.length} messages were generated`)
  for (const { label, text } of messages) {
    assert.doesNotMatch(text, /\{[A-Za-z]+\}/, `${label} left a slot unresolved:\n${text}`)
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

// MUTATION THAT KILLS THIS (run): move any type in OPERATION_SEMANTIC_BY_TYPE to
// 'LEDGER_NON_DOCUMENT' without adding a wording entry — the build fails on the Record<> key set,
// and deleting an entry from NON_DOCUMENT_INCIDENT_WORDING fails this test's first assertion.
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
        /NOTHING WAS CREATED IN/.test(qbo) || /NO REQUEST ID PROTECTS IT/.test(qbo)
          || /THIS IS NOT A DOCUMENT/.test(qbo) || /NOTHING LEFT THIS PROCESS/.test(qbo)
          || /IMS DID NOT RECORD WHETHER THE UPLOAD HAPPENED/.test(qbo),
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
    LEDGER_DOCUMENT: 0, LEDGER_DOCUMENT_NO_IDENTIFIER: 0, LEDGER_DRAFT: 0,
    LEDGER_OUTCOME_UNRECORDED: 0, LEDGER_NON_DOCUMENT: 0, NO_IDENTIFIER_SIDE_EFFECT: 1,
    UNCLASSIFIED: 0,
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
