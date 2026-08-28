import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  DOCUMENT_INCIDENT_WORDING,
  NON_DOCUMENT_INCIDENT_WORDING,
  OPERATION_SEMANTIC_BY_TYPE,
  QBO_OPERATIONS_WITHOUT_REQUEST_ID,
  RECORD_LOOKUP_FIELDS,
  PostedDocumentEvidenceUnwritten,
  describePreservedUnrecordedIncidents,
  describeUnburiedOutboxJobForUnwrittenEvidence,
  describeUnpersistedQboPost,
  describeUnrecordablePostedDocument,
  describeUnrecordedPostedDocumentRecordedOutOfTransaction,
  incidentKindForOperation,
  type LedgerPostingMode,
  type PostedOperationOutcome,
  type RemoteEffectOutcome,
  type UnrecordedIncidentCounts,
  type UnrecordedIncidentKind,
} from '@/lib/domain/accounting/unrecorded-posted-document'
import {
  LEAVE_THE_TOGGLE_OFF_THEN_ESCALATE,
  LOCAL_DIRECTION_CAP,
  LOCAL_DIRECTION_SEQUENCES,
  LOCAL_DIRECTIONS,
  LOCAL_TARGET,
  renderLocalDirection,
  renderLocalDirectionSequence,
  type LocalDirection,
  type LocalDirectionContext,
  type LocalDirectionSequence,
} from '@/lib/domain/accounting/local-operator-direction'

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

/**
 * ROUND 17 (Codex MEDIUM): THE TYPES THIS BINARY DOES NOT CLASSIFY.
 *
 * `AccountingSyncType` is a Prisma enum, so a newer release can persist a value this build has no
 * `OPERATION_SEMANTIC_BY_TYPE` row for, and both formatters have a frame for exactly that — the
 * `UNCLASSIFIED_MARKER` branch, which this file already treats as a supported forward-skew path
 * (the round-9 test drives `FUTURE_LEDGER_THING` through it by hand).
 *
 * But the CORPUS was built from `Object.keys(OPERATION_SEMANTIC_BY_TYPE)`, so every message it
 * generated was classified, the unclassified filter in `lookupLessMessages()` matched nothing, and
 * the two unclassified frames were never decomposed against the three reviewed lists. New wording
 * in either of them could have reintroduced a remote instruction without failing round 16 at all.
 * They are in the corpus now.
 */
const UNCLASSIFIED_OPERATION_TYPES = ['FUTURE_LEDGER_THING'] as unknown as AccountingSyncType[]

const EVERY_GENERATED_TYPE: AccountingSyncType[] = [...OPERATION_TYPES, ...UNCLASSIFIED_OPERATION_TYPES]

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
  // ROUND 12: with and without the id of the document the operation acted ON. Without these the
  // `{ledgerTargetId}` slot and the lookup clause built from it are never rendered here, and the
  // unresolved-slot check below would pass by never reaching them.
  { ledgerTargetId: 'LEDGER-BILL-1' },
  { externalEffect: 'MADE' as RemoteEffectOutcome, ledgerTargetId: 'LEDGER-BILL-1' },
  {
    postingMode: 'LIVE' as LedgerPostingMode,
    externalEffect: 'MADE' as RemoteEffectOutcome,
    ledgerTargetId: 'LEDGER-BILL-1',
  },
]

/** Every message the module can produce, for every type, every id combination and every outcome. */
function everyIncidentMessage(): { label: string; text: string }[] {
  const messages: { label: string; text: string }[] = []
  for (const type of EVERY_GENERATED_TYPE) {
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
            const incident = {
              entry: ENTRY(type), postedExternalId: posted, namedExternalId: named, reason, outcome,
            }
            messages.push({
              label: `xero ${type} posted=${String(posted)} named=${String(named)} ${reason} outcome=${o}`,
              text: describeUnrecordablePostedDocument(incident),
            })
            // ROUND 18 (Codex MEDIUM): THE WRAPPERS AN OPERATOR ACTUALLY RECEIVES. Each of these
            // APPENDS to the base wording above, on a durable recovery surface, and each was outside
            // the corpus — so an instruction added to any of the three suffixes needed no allowlist
            // change to pass every round-17 assertion. They are constructed here now, from the
            // production producers, so the closure below reads the COMPLETE emitted message.
            const unwritten = new PostedDocumentEvidenceUnwritten(incident, new Error('write conflict'))
            messages.push({
              label: `unwritten ${type} posted=${String(posted)} named=${String(named)} ${reason} outcome=${o}`,
              // The outbox job's failure column and the process log — `markXeroOutboxPermanent(job,
              // error.operatorMessage)` and `console.error` in escalateUnwrittenPostedEvidence.
              text: unwritten.operatorMessage,
            })
            messages.push({
              label: `out-of-transaction ${type} posted=${String(posted)} named=${String(named)} ${reason} outcome=${o}`,
              // The standalone ActivityLog row escalateUnwrittenPostedEvidence writes.
              text: describeUnrecordedPostedDocumentRecordedOutOfTransaction(incident, new Error('write conflict')),
            })
            for (const recordFiled of [true, false]) {
              messages.push({
                label: `burial-failed recordFiled=${String(recordFiled)} ${type} posted=${String(posted)} `
                  + `named=${String(named)} ${reason} outcome=${o}`,
                // The XeroOutboxBurialError that fails the RUN, carrying the wording with it.
                text: describeUnburiedOutboxJobForUnwrittenEvidence({
                  operatorMessage: unwritten.operatorMessage,
                  jobId: 'outbox-1',
                  lastFailure: new Error('write conflict'),
                  recordFiled,
                }),
              })
            }
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

type WordingEntryView = {
  label: string
  templates: string[]
  /**
   * ROUND 15: the same strings KEYED BY FIELD. The round-14 fence judges an entry as a bag of
   * prose, which is right for "may this entry name an act at all". The directive fence below has to
   * separate the fields that TELL THE OPERATOR WHAT TO DO from the ones that say what happened, and
   * a flattened array cannot.
   */
  fields: Record<string, string>
  needs: readonly string[]
  lookup: readonly string[]
}

/** Every wording entry in the module, flattened, with the strings it can render. */
function everyWordingEntry(): WordingEntryView[] {
  const out: WordingEntryView[] = []
  for (const [key, w] of Object.entries(DOCUMENT_INCIDENT_WORDING)) {
    const { needs, lookup, ...rest } = w
    out.push({
      label: `DOCUMENT_INCIDENT_WORDING.${key}`,
      templates: Object.values(rest),
      fields: rest as Record<string, string>,
      needs,
      lookup: lookup ?? [],
    })
  }
  for (const [type, entry] of Object.entries(NON_DOCUMENT_INCIDENT_WORDING)) {
    const variants = 'did' in entry ? { '': entry } : entry
    for (const [variant, w] of Object.entries(variants)) {
      const { needs, lookup, ...rest } = w
      out.push({
        label: `NON_DOCUMENT_INCIDENT_WORDING.${type}${variant ? `.${variant}` : ''}`,
        templates: Object.values(rest),
        fields: rest as Record<string, string>,
        needs,
        lookup: lookup ?? [],
      })
    }
  }
  return out
}

/**
 * THE THIRD WORDING TABLE, WHICH ROUND 11 NAMED AS A HOLE AND ROUND 12 PUT INSIDE THE FENCE.
 *
 * `QBO_OPERATIONS_WITHOUT_REQUEST_ID` is shipped operator prose exactly like the other two — it is
 * what the QuickBooks frames print under "WHAT A REPLAY WOULD COST" and "WHAT TO DO ABOUT THE
 * EFFECT" — and round 11 left it outside every check here, writing that the hole was "named rather
 * than left to be found". It had a live instance in it: `BILL_ATTACHMENT.MADE.check` said "open the
 * bill in QuickBooks and delete any duplicate attachment" about a bill nothing in the record named.
 */
function everyReplayWordingEntry(): WordingEntryView[] {
  const out: WordingEntryView[] = []
  for (const [type, entry] of Object.entries(QBO_OPERATIONS_WITHOUT_REQUEST_ID)) {
    if (!entry) continue
    const variants = 'effect' in entry ? { '': entry } : entry
    for (const [variant, w] of Object.entries(variants)) {
      const { needs, lookup, ...rest } = w
      out.push({
        label: `QBO_OPERATIONS_WITHOUT_REQUEST_ID.${type}${variant ? `.${variant}` : ''}`,
        templates: Object.values(rest),
        fields: rest as Record<string, string>,
        needs: needs ?? [],
        lookup: lookup ?? [],
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// ROUND 11 (Codex MEDIUM) — THE THIRD GENERATION OF THIS INVARIANT, AND THE HONEST ACCOUNT OF IT.
//
// WHY THERE IS A THIRD. Round 9 scanned generated messages for a hand-written table of English
// FIELD PHRASES ("its amount", "its date") and was bypassable by writing different words. Round 10
// inverted it into a DECLARATION (`needs`) checked against what the two record builders write — and
// was bypassable by not declaring anything: adding "search by gross total and posting day" to a
// remedy introduces no placeholder, leaves `needs` truthful, compiles, and passes. Both generations
// enumerated an OPEN class (the ways to name a datum) and called it closed.
//
// WHAT IS DIFFERENT NOW. The lookup clause is not prose. `lookupInstruction` in the module owns the
// WHOLE clause — the verb, the ledger and the criterion — and builds it from the entry's declared
// `lookup: RecordLookupField[]` against the values THIS incident carries. So:
//
//   • a criterion that is not a `RecordLookupField` does not compile;
//   • a `RecordLookupField` the two builders do not BOTH write fails the declaration test below;
//   • a field whose value is absent on this incident THROWS while rendering, and the test that
//     generates every message for every combination turns that into a red build;
//   • and the fence below refuses any template that contains a LOOKUP VERB in its own words, which
//     leaves `{lookup}` as the only way a remedy can send an operator to go and find something.
//
// THE VERB LIST IS A CLOSED GRAMMATICAL CLASS, not an open list of data names. That is the whole
// improvement: you cannot instruct a search without instructing a search, and the instruction is
// what is enumerated, rather than the thing searched on.
//
// WHAT THIS PROVABLY DOES NOT COVER. Said plainly, because shipping a third version that implies
// closure it does not have is the defect, not the wording:
//
//   1. A LOOKUP EXPRESSED WITHOUT ANY OF THESE VERBS still passes. "Go to the invoice whose gross
//      total is the one on the order" names a criterion and contains no listed verb. English has no
//      closed set of ways to name a datum, and these remedies are hand-written operator prose that
//      could not be generated from a grammar without losing what ten rounds of review put into them.
//      What is enforced is that the DIRECT forms — find / search / locate / look up / query /
//      filter / retrieve / trace / identify — cannot be written at all.
//   2. PROSE MAY STILL NAME A VALUE THIS MESSAGE HAS ALREADY PRINTED. "open both ids", "the
//      reference above", "the id above" are deliberate and permitted: they point at text the reader
//      already has, not at data they must go and find. A field the record does NOT print cannot be
//      named this way and still be usable, but nothing here stops the sentence being written.
//   3. IT COVERS THE TWO INCIDENT WORDING TABLES, NOT EVERY STRING IN THE MODULE. The formatter
//      frames and `QBO_OPERATIONS_WITHOUT_REQUEST_ID`'s `check` are outside it. That is deliberate
//      for the `check`: it instructs a query of the LOCAL EmailOutbox table by that table's own
//      columns, which is a different act from looking this incident's effect up in a ledger, and
//      every column it names was walked into the schema in rounds 6 through 9. It is a hole all the
//      same, and it is named here rather than left to be found.
//
// The mutation Codex asked for is a REQUIRED FAILING CASE below, run against the shipped checker,
// so the bypass this round closes cannot quietly reopen.
// ---------------------------------------------------------------------------------------------

/**
 * The direct ways English instructs a lookup. Closed by grammar rather than by data vocabulary —
 * see the block above for exactly what that does and does not buy.
 */
const LOOKUP_VERB =
  /\b(?:find|finds|finding|search|searches|searching|locate|locates|locating|look|looks|looking|query|queries|querying|filter|filters|filtering|retrieve|retrieves|retrieving|trace|traces|tracing|identify|identifies|identifying)\b/gi

/** Every lookup verb a set of templates writes in its own words. `{lookup}` carries none. */
function lookupVerbsWrittenInProse(templates: readonly string[]): string[] {
  const found: string[] = []
  for (const template of templates) {
    // The generated clause is the permitted route, so its own placeholder is not prose. Everything
    // else in the template is.
    const prose = template.replace(/\{Lookup\}|\{lookup\}/g, ' ')
    for (const [verb] of prose.matchAll(LOOKUP_VERB)) found.push(verb)
  }
  return found
}

const PLACEHOLDER = /\{([A-Za-z]+)\}/g

// MUTATION THAT KILLS THIS (run): add `'grossTotal'` to any entry's `needs` or `lookup` — it is not
// a `RecordLookupField`, so the BUILD fails before the test does; declare an existing field the
// builders do not both write (e.g. `'rowNamesExternalId'`, which only the Xero builder writes) and
// this test fails naming the entry. Deleting `postedExternalId` from the QuickBooks builder's
// metadata object kills it the other way, and was RUN: it fails here with
// 'DOCUMENT_INCIDENT_WORDING.CREATE_LIVE declares "postedExternalId", which is not a key both
// record builders write'.
//
// ROUND 11, THE OTHER HALF: declaring a `lookup` field the INCIDENT does not carry — e.g. adding
// `'syncLogId'` to CREATE_LIVE's lookup, which both builders do write but which no formatter puts
// in the slots — is caught one test along instead, because `lookupInstruction` throws while
// rendering. RUN: it fails 'ROUND 10: no message this module can produce leaks an unresolved slot'.
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

  // ROUND 12: the replay table is in here now. Its `BILL_ATTACHMENT.MADE` entry is what declares
  // `ledgerTargetId`, so this assertion is what proves BOTH record builders retain the bill id the
  // remedy sends an operator to — parsed out of the two connector sources, not written down here.
  const entries = [...everyWordingEntry(), ...everyReplayWordingEntry()]
  assert.ok(entries.length >= 16, `sanity: ${entries.length} wording entries were found`)
  for (const { label, needs, lookup } of entries) {
    // ROUND 11: `lookup` is held to the same rule as `needs`, and for the same reason — the clause
    // it generates is rendered on BOTH connectors' doors, so a key only one builder writes would
    // produce a lookup instruction that cannot be followed on the other.
    for (const field of [...needs, ...lookup]) {
      assert.ok(
        retained.has(field),
        `${label} declares "${field}", which is not a key both record builders write`,
      )
    }
  }
  assert.ok(
    entries.some((entry) => entry.lookup.length > 0),
    'no entry declares a lookup at all, so this half of the check proves nothing',
  )
})

// MUTATION THAT KILLS THIS (run): put a bare `{amount}` (or any undeclared slot) into any remedy
// string — `render` throws while generating, and the assertion below fails naming the entry. Put
// `{postedExternalId}` into a template of an entry whose `needs` omits it and the declaration
// assertion fails instead.
//
// ROUTE: the templates are read out of the SHIPPED wording tables, and the slot vocabulary out of
// the SHIPPED `RECORD_LOOKUP_FIELDS`.
test('ROUND 10: a wording names a record value only through a slot it declared, and only a real one', () => {
  const known = new Set<string>([...RECORD_LOOKUP_FIELDS, 'ledger', 'LEDGER', 'lookup', 'Lookup'])
  let sawOne = false
  let sawLookup = false
  for (const { label, templates, needs, lookup } of [...everyWordingEntry(), ...everyReplayWordingEntry()]) {
    for (const template of templates) {
      for (const [, slot] of template.matchAll(PLACEHOLDER)) {
        assert.ok(known.has(slot), `${label} names the slot "${slot}", which is not a thing this record holds`)
        if (slot === 'ledger' || slot === 'LEDGER') continue
        // ROUND 11: the generated lookup clause is declared through `lookup`, not `needs` — it names
        // no record value directly, it names the FIELDS the renderer may build a criterion from.
        if (slot === 'lookup' || slot === 'Lookup') {
          sawLookup = true
          assert.ok(
            lookup.length > 0,
            `${label} renders "{${slot}}" without declaring a lookup field for it`,
          )
          continue
        }
        sawOne = true
        assert.ok(
          needs.includes(slot),
          `${label} renders "{${slot}}" without declaring it in needs`,
        )
      }
    }
  }
  assert.ok(sawOne, 'the check must actually have seen a record slot, or it proves nothing')
  assert.ok(sawLookup, 'and a generated lookup clause, or the round-11 half proves nothing')

  // The other direction: a declaration nobody renders is a declaration nobody checks.
  for (const { label, templates, lookup } of [...everyWordingEntry(), ...everyReplayWordingEntry()]) {
    if (lookup.length === 0) continue
    assert.ok(
      templates.some((template) => /\{Lookup\}|\{lookup\}/.test(template)),
      `${label} declares a lookup no template renders`,
    )
  }
})

// MUTATION THAT KILLS THIS (run): write a lookup instruction into any remedy in either wording
// table — e.g. append "search by gross total and posting day" to
// DOCUMENT_INCIDENT_WORDING.CREATE_LIVE.remedyRowGone. The first assertion fails naming the entry
// and the verb. That mutation is ALSO run inline below against the shipped checker, so this test
// cannot become vacuous by the checker being weakened rather than the corpus being cleaned.
//
// ROUTE: the templates are read out of the SHIPPED wording tables. The verb list is the only thing
// written down here, and it is a grammatical class rather than a list of data names — read the
// block above this file's helpers for exactly what that does and does not cover.
test('ROUND 11 (Codex MEDIUM): only the renderer may instruct a lookup, never a remedy in its own words', () => {
  // ROUND 12: the replay table is scanned too, minus ONE named string. Round 11 exempted the WHOLE
  // table on the strength of `INVOICE_EMAIL.check` instructing a query of the LOCAL EmailOutbox by
  // its own columns — a different act from looking this incident's effect up in a ledger. That
  // reasoning covers exactly that one string, and covering the table with it is how
  // `BILL_ATTACHMENT.MADE.check` came to say "open the bill" unchecked.
  const EXEMPT = 'QBO_OPERATIONS_WITHOUT_REQUEST_ID.INVOICE_EMAIL'
  const replay = everyReplayWordingEntry()
  const exempt = replay.find((entry) => entry.label === EXEMPT)
  assert.ok(exempt, 'the exemption must name an entry that exists')
  assert.notDeepEqual(
    lookupVerbsWrittenInProse(exempt!.templates), [],
    'and it must still NEED the exemption — if it no longer writes a lookup verb, delete the '
    + 'exemption rather than keeping a hole nothing is standing in',
  )
  const entries = [...everyWordingEntry(), ...replay.filter((entry) => entry.label !== EXEMPT)]
  assert.ok(entries.length >= 15, `sanity: ${entries.length} wording entries were scanned`)
  for (const { label, templates } of entries) {
    const verbs = lookupVerbsWrittenInProse(templates)
    assert.deepEqual(
      verbs, [],
      `${label} instructs a lookup in its own words (${verbs.join(', ')}). `
      + 'A remedy may only send an operator looking through {lookup}, which is generated from the '
      + 'fields this record is declared to hold.',
    )
  }

  // ---------------------------------------------------------------------------------------------
  // THE REQUIRED FAILING CASE (Codex, round 11). This is the exact bypass round 10 claimed to have
  // eliminated and had not: it introduces no placeholder, leaves `needs` and `lookup` truthful, and
  // compiles. It is run here against the SHIPPED checker so that weakening the checker fails this
  // test rather than quietly reopening the hole.
  // ---------------------------------------------------------------------------------------------
  const shipped = DOCUMENT_INCIDENT_WORDING.CREATE_LIVE.remedyRowGone
  assert.deepEqual(lookupVerbsWrittenInProse([shipped]), [], 'the entry being mutated must start clean')

  const grossTotalBypass = `${shipped} If that fails, search by gross total and posting day.`
  assert.deepEqual(
    lookupVerbsWrittenInProse([grossTotalBypass]), ['search'],
    'the gross-total/posting-day remedy is the round-10 bypass and it must be refused',
  )

  // …and the paraphrases of it, so the case is not passing on one word.
  for (const [prose, expected] of [
    ['Look it up using the gross total and the posting day.', ['Look']],
    ['Locate the bill by its supplier reference.', ['Locate']],
    ['Query the ledger for a document with that net amount.', ['Query']],
    ['Filter the invoice list on the posting day.', ['Filter']],
  ] as [string, string[]][]) {
    assert.deepEqual(lookupVerbsWrittenInProse([prose]), expected, prose)
  }

  // AND THE HOLE, ASSERTED RATHER THAN IMPLIED. This one gets through, and a reader of this file is
  // entitled to know that before trusting the invariant. It is item 1 of the block above.
  assert.deepEqual(
    lookupVerbsWrittenInProse(['Go to the invoice whose gross total matches the order.']), [],
    'a lookup phrased without any of the direct verbs is NOT caught — the fence closes the verb, '
    + 'not the language, and this assertion exists so that claim is documented rather than assumed',
  )
})

// ---------------------------------------------------------------------------------------------
// ROUND 14 (Codex HIGH) — THE DEFAULT IS NOW "NO", AND THE EXCEPTIONS ARE WRITTEN DOWN.
//
// FOUR ROUNDS OF THE SAME SHAPE. Round 9 enumerated field phrases and was walked around by writing
// different words. Round 10 enumerated declarations and was walked around by declaring nothing.
// Round 12 enumerated imperatives and was walked around by a gerund — in its own new wording, one
// round later. Round 13 enumerated every inflection and asked GRAMMAR whether an occurrence took a
// specific object, and Codex walked around that in four ways at once:
//
//   • "remove YOUR duplicate attachment"      — a possessive is a determiner the list did not have;
//   • "remove attachments FROM THAT BILL"     — the object is named after a preposition;
//   • "remove ONLY that attachment"           — a modifier sits between the verb and the determiner;
//   • "WITHOUT DELAY, remove that attachment" — `without` was read as a negation and suppressed the
//                                               rest of the clause.
//
// EVERY ONE OF THOSE USES AN ENUMERATED VERB ON A CONCRETE TARGET. They are not the admitted
// unlisted-verb hole; they are the fence failing at its own job. THE DIAGNOSIS IS THEREFORE NOT THAT
// THE HEURISTIC NEEDS A FIFTH PATCH. English scope analysis is the wrong tool: the ways to name an
// object are an OPEN class, so a detector of "does this name an object" can only ever chase them.
//
// SO THE DEFAULT IS INVERTED. A wording entry that declares no `lookup` cannot name any object at
// all, so IT MAY NOT CONTAIN A MUTATION LEXEME — in any grammar, with any object or none, inside a
// negation or outside one. Not "unless it looks like a description"; not at all.
//
// THE ONLY EXCEPTIONS ARE ENUMERATED, BELOW, AS EXACT STRINGS. A prohibition ("DO NOT VOID IT",
// "there is nothing to undo") genuinely needs to name the act it refuses, and refusing needs no
// identifier — but it is now admitted ONE STRING AT A TIME rather than recognised by a rule.
// `PROHIBITION_TEMPLATES` is a closed allowlist: a new prohibition is a deliberate, reviewable line
// in this file, and an edit to a shipped one fails until the line is updated to match. That is the
// whole point — the wording of these sentences has been rewritten twelve times, and a sentence that
// must match a reviewed template is cheaper than a sentence that must survive a parser.
//
// WHAT THE INVERSION BUYS, ITEM BY ITEM AGAINST THE OLD LIST:
//
//   • The four constructions above now fail, and so does every construction nobody has thought of,
//     because none of them is on the allowlist. There is no grammar left to walk around.
//   • Round 13's item 2 — "a clause is exempt from its first negation onward, so a clause that
//     refuses one act and instructs another in one breath is not caught" — IS GONE. Only the exact
//     enumerated span is removed from the prose; anything written next to it is still scanned.
//
// WHAT IT STILL DOES NOT BUY, STATED RATHER THAN IMPLIED:
//
//   1. THE VERB LIST IS STILL A LIST. An instruction phrased without one of these lexemes passes —
//      "Go to that bill and take the second PDF off it" is not caught. English has no closed set of
//      ways to tell someone to do something. What is different is that this is now the ONLY hole
//      rather than one of four, and it is asserted at the foot of the test rather than described.
//   2. AN ENUMERATED TEMPLATE IS TRUSTED VERBATIM. The allowlist is where the review happens, so a
//      badly chosen entry launders whatever it contains. Three checks below make that harder — each
//      template must contain a mutation lexeme (or it is exempting nothing), must contain a refusal
//      (or it is not a prohibition), and must actually appear in the shipped corpus (or it is a hole
//      nothing is standing in) — but none of them replaces reading the line.
//   3. IT CHECKS THAT THE ENTRY CAN NAME SOMETHING, NOT THAT THE NAMED THING IS THE THING ACTED ON.
//      An entry that declared a lookup on one object and instructed an act on another would pass.
//      Unchanged from round 13, and it is what Codex's longer-term remedy — structured instructions
//      whose target must reference a declared field — would close. Filed as o3d-cvyv; it is a
//      rewrite of all three wording tables and both formatters, not a fence change.
// ---------------------------------------------------------------------------------------------

/** Verbs that CHANGE something in somebody else's system. Closed, and enumerated. */
const ACT_VERBS = [
  'open', 'remove', 'delete', 'void', 'reverse', 'correct', 'archive', 'cancel', 'credit-note',
  'amend', 'edit', 'detach', 'undo', 'clear', 'strip',
] as const
/** The forms the rule below cannot generate from the stem: irregulars and doubled consonants. */
const ACT_VERB_IRREGULARS = ['undid', 'undone', 'cancelling', 'cancelled', 'stripping', 'stripped']
/** The same acts written as nouns — the other half of "in any grammatical form". */
const ACT_NOUNS = [
  'removal', 'deletion', 'reversal', 'correction', 'cancellation', 'amendment', 'archival',
  'detachment',
]

/**
 * Every inflection of one verb, GENERATED. A hand-written list of forms is the same open class the
 * round-9 phrase list was: it is bypassable by conjugating.
 */
function everyFormOf(verb: string): string {
  const stem = verb.endsWith('e') ? verb.slice(0, -1) : verb
  return `${stem}(?:e|es|ed|ing|d|s)?`
}

/**
 * A MUTATION LEXEME: one of those acts, in any form, WITH NO REGARD TO WHAT IS AROUND IT. There is
 * no object rule and no negation rule here, and that absence is the round-14 fix — every rule about
 * the surrounding words was a place to walk through.
 */
const MUTATION_LEXEME = new RegExp(
  `\\b(?:${[...ACT_VERBS.map(everyFormOf), ...ACT_VERB_IRREGULARS, ...ACT_NOUNS].join('|')})\\b`,
  'gi',
)

/**
 * THE CLOSED ALLOWLIST. Every string a lookup-less entry is permitted to say a mutation lexeme
 * inside, verbatim and case-sensitive. Each one is a REFUSAL or a statement of incapacity: it names
 * an act in order to forbid it, or to say the record cannot support it. Adding a line here is the
 * review; the checks in the test hold each line to the three properties in the block above.
 */
const PROHIBITION_TEMPLATES: readonly string[] = [
  // NOT_A_DOCUMENT_STANDS / NOTHING_CREATED_STANDS — shared by several entries.
  '{ledger} accepted the write and no reset of ours undoes it, but nothing stands at an id, so '
  + 'there is nothing here to open, keep or void as one',
  'there is no document there to open',
  // The unknown-posting-state remedies (DOCUMENT_INCIDENT_WORDING.OUTCOME_UNRECORDED, UPDATE_UNRECORDED).
  'DO NOT void, credit-note, reverse or delete anything on the strength of this record',
  // PURCHASE_CREDIT_NOTE_ALLOCATION.
  'DO NOT OPEN, KEEP OR VOID EITHER THE BILL OR THE CREDIT NOTE ON THE STRENGTH OF THIS RECORD',
  // TAX_RATE_SYNC.
  'THERE IS NOTHING TO VOID OR CREDIT',
  'so it cannot tell you what correcting it would restore',
  // BILL_ATTACHMENT, the three cells that cannot name a bill.
  'DO NOT REMOVE AN ATTACHMENT FROM A BILL THIS RECORD CANNOT NAME',
  'DO NOT REMOVE AN ATTACHMENT ON THE STRENGTH OF THIS RECORD',
  'THERE IS NOTHING TO UNDO',
  'nothing this attempt did needs undoing',
  'rather than clearing an attachment off a bill picked out any other way',
  // INVOICE_PDF and WC_INVOICE_NOTE.
  'There is nothing to void in {ledger}',
  'rather than clearing notes off an order picked out any other way',
  // INVOICE_EMAIL, both tables.
  'IMS CANNOT CANCEL A QUEUED COPY',
  'no action, route or screen removes an unsent row',
]

/** What makes an allowlist line a PROHIBITION rather than an exemption for an instruction. */
const REFUSAL = /\b(?:not|never|no|nothing|none|cannot|neither|nor|rather than|instead of)\b/i

/**
 * Every mutation lexeme a set of templates writes OUTSIDE an enumerated prohibition.
 *
 * `allowed` is a parameter so the tests can run the shipped corpus against an EMPTY allowlist and
 * prove the allowlist is what is carrying it, rather than the corpus happening to be clean.
 */
function mutationLexemes(
  templates: readonly string[],
  allowed: readonly string[] = PROHIBITION_TEMPLATES,
): string[] {
  const found: string[] = []
  for (const template of templates) {
    // The generated clause is the permitted route, so its own placeholder is not prose.
    let prose = template.replace(/\{Lookup\}|\{lookup\}/g, ' ')
    // EXACT, CASE-SENSITIVE, WHOLE-STRING removal. Not a pattern: a prohibition that has been
    // reworded no longer matches its line, and fails until the line is updated to match it.
    // ROUND 15: LONGEST FIRST. Exact removal is order-dependent — 'there is no document there to
    // open' is a substring of nothing here today, but a short line that happens to sit inside a long
    // one would consume half of it and leave the remainder unmatched, failing on prose that IS
    // enumerated. Sorting makes the allowlist a set rather than a sequence.
    for (const prohibition of [...allowed].sort((a, b) => b.length - a.length)) {
      prose = prose.split(prohibition).join(' ')
    }
    MUTATION_LEXEME.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MUTATION_LEXEME.exec(prose)) !== null) found.push(match[0].toLowerCase())
  }
  return found
}

/**
 * ROUND 13'S FENCE, KEPT AS THE COUNTER-EXAMPLE AND NOTHING ELSE.
 *
 * It is dead to the corpus check above. It survives so that the four constructions Codex walked
 * through can be run against BOTH fences in one assertion pair: the old one finds nothing in them,
 * the new one refuses them. Relaxing the guard back to this — the exact regression this round
 * exists to prevent — turns those pairs red.
 */
const LEGACY_OBJECT = '(?:the|that|this|those|these|its|their|any|either|both|each|an|a|it|them|one)\\b'
const LEGACY_INSTRUCTED_ACT = new RegExp(
  `\\b(?:(${[...ACT_VERBS.map(everyFormOf), ...ACT_VERB_IRREGULARS].join('|')})\\s+${LEGACY_OBJECT}`
  + `|(${ACT_NOUNS.join('|')})\\s+of\\s+${LEGACY_OBJECT})`,
  'gi',
)
const LEGACY_NEGATION = /\b(?:not|never|no|nothing|none|cannot|neither|nor|without|rather than)\b/i
const LEGACY_CLAUSE_BOUNDARY = /(?:\.\s|;\s|:\s|—\s|\band\s)/
function legacyActsInstructed(templates: readonly string[]): string[] {
  const found: string[] = []
  for (const template of templates) {
    const prose = template.replace(/\{Lookup\}|\{lookup\}/g, ' ')
    for (const raw of prose.split(LEGACY_CLAUSE_BOUNDARY)) {
      const clause = raw.trim()
      const negation = LEGACY_NEGATION.exec(clause)
      const instructsUntil = negation ? negation.index : clause.length
      LEGACY_INSTRUCTED_ACT.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = LEGACY_INSTRUCTED_ACT.exec(clause)) !== null) {
        if (match.index >= instructsUntil) continue
        found.push((match[1] ?? match[2]).toLowerCase())
      }
    }
  }
  return found
}

/** The templates of every entry that declares no lookup — the corpus this fence governs. */
function lookupLessTemplates(): { label: string; templates: string[] }[] {
  return [...everyWordingEntry(), ...everyReplayWordingEntry()]
    .filter((entry) => entry.lookup.length === 0)
    .map(({ label, templates }) => ({ label, templates }))
}

// MUTATION THAT KILLS THIS (run): write ANY act into a lookup-less entry, in any grammar the four
// previous rounds argued about — append 'Escalate this record, and remove your duplicate
// attachment.' to NON_DOCUMENT_INCIDENT_WORDING.WC_INVOICE_NOTE.remedy and this test fails naming
// that entry and `remove`. RUN, and it is the round-13 finding: the same string passes
// `legacyActsInstructed` untouched. Deleting any line of PROHIBITION_TEMPLATES kills it the other
// way — RUN with 'THERE IS NOTHING TO UNDO' removed, it fails naming
// NON_DOCUMENT_INCIDENT_WORDING.BILL_ATTACHMENT.NONE and `undo` — which is what proves the shipped
// corpus is passing through the allowlist rather than past it.
//
// ROUTE: the templates come from the SHIPPED wording tables — all three of them — and the
// declaration each entry is judged against is the entry's own `lookup`. The verb list and the
// allowlist are the only things written down here, and both are closed sets.
test('ROUND 14 (Codex HIGH): an entry that declares no lookup may not contain a mutation lexeme at all', () => {
  const entries = [...everyWordingEntry(), ...everyReplayWordingEntry()]
  assert.ok(entries.length >= 16, `sanity: ${entries.length} wording entries were scanned`)

  let sawPermitted = false
  for (const { label, templates, lookup } of entries) {
    if (lookup.length > 0) {
      // An entry that CAN name its object is judged by the round-10/11 declaration tests instead.
      if (mutationLexemes(templates).length > 0) sawPermitted = true
      continue
    }
    const lexemes = mutationLexemes(templates)
    assert.deepEqual(
      lexemes, [],
      `${label} writes the mutation lexeme(s) ${lexemes.join(', ')} while declaring no lookup, so `
      + 'this record cannot name the thing they act on. Either retain and declare an identifier for '
      + 'it, replace the instruction with an escalation, or — if the sentence REFUSES the act rather '
      + 'than instructing it — enumerate it verbatim in PROHIBITION_TEMPLATES.',
    )
  }
  assert.ok(
    sawPermitted,
    'no entry that CAN name its object instructs an act on it, so the permitted half proves nothing',
  )

  // NOT VACUOUS: the shipped corpus passes THROUGH the allowlist, not past it. With no exceptions
  // enumerated, the same entries are full of lexemes.
  const bare = lookupLessTemplates().flatMap(({ templates }) => mutationLexemes(templates, []))
  assert.ok(
    bare.length >= 10,
    `the allowlist must be doing work: with it empty the lookup-less corpus yields ${bare.length} lexemes`,
  )
})

// MUTATION THAT KILLS THIS (run): add a line to PROHIBITION_TEMPLATES that is not a prohibition —
// 'remove the duplicate attachment from that bill' — and the refusal assertion fails naming it. RUN.
// Deleting a line that no shipped entry contains is caught by the third assertion, which is the
// round-11 "an exemption must still be needed" rule applied to this allowlist.
//
// ROUTE: the allowlist is read here, the corpus out of the SHIPPED wording tables.
test('ROUND 14: every enumerated exception is a prohibition, and one the shipped corpus still needs', () => {
  const corpus = lookupLessTemplates().flatMap(({ templates }) => templates)
  assert.ok(corpus.length > 20, `sanity: ${corpus.length} lookup-less templates were scanned`)

  for (const prohibition of PROHIBITION_TEMPLATES) {
    assert.ok(
      prohibition.length >= 20,
      `"${prohibition}" is too short to be a reviewable template — an allowlist of fragments is the `
      + 'open blacklist this round replaced, inverted',
    )
    assert.notDeepEqual(
      mutationLexemes([prohibition], []), [],
      `"${prohibition}" contains no mutation lexeme, so it exempts nothing and should be deleted`,
    )
    assert.match(
      prohibition, REFUSAL,
      `"${prohibition}" names an act without refusing it — an exception may only be a prohibition`,
    )
    assert.ok(
      corpus.some((template) => template.includes(prohibition)),
      `"${prohibition}" appears in no lookup-less wording — delete it rather than leaving a hole `
      + 'nothing is standing in',
    )
  }

  // AND THE TEMPLATES ARE EXACT, NOT PATTERNS. One word changed and the exception is gone.
  const edited = 'DO NOT REMOVE AN ATTACHMENT FROM A BILL THIS RECORD CANNOT IDENTIFY'
  assert.deepEqual(
    mutationLexemes([edited]), ['remove'],
    'a reworded prohibition must fail until its line is updated — otherwise the allowlist is a '
    + 'pattern, and a pattern is what the last four rounds were',
  )
})

// MUTATION THAT KILLS THIS (run): relax the guard back to the round-13 heuristic — make
// `mutationLexemes` return `legacyActsInstructed(templates)` — and this test fails on the FIRST
// half of the first pair, `remove your duplicate attachment`, because the old fence finds nothing
// in any of these five. RUN, and it takes three of the other round-14 tests down with it. That is
// exactly the relaxation this round exists to prevent, and these are the constructions Codex
// walked through it with.
//
// ROUTE: run against the SHIPPED checker. The constructions are written here because they are the
// wordings that must NEVER be shippable, not wordings that are shipped.
test('ROUND 14 (Codex HIGH): the four constructions the round-13 grammar could not see', () => {
  for (const [construction, expected] of [
    // A POSSESSIVE. `your` was not in round 13's determiner list, and the list of determiners is as
    // open as everything else about naming an object.
    ['REMEDY: remove your duplicate attachment.', ['remove']],
    // THE OBJECT AFTER A PREPOSITION. The words following the verb are a bare plural.
    ['REMEDY: remove attachments from that bill.', ['remove']],
    // A MODIFIER BETWEEN THE VERB AND THE DETERMINER.
    ['REMEDY: remove only that attachment.', ['remove']],
    // `without`, NOT NEGATING. Round 13 suppressed the rest of the clause from the first negation
    // word onward, and read this one as a refusal.
    ['REMEDY: Without delay, remove that attachment.', ['remove']],
    // …and the same for `rather than`, which round 13 also treated as a negation wherever it fell.
    ['REMEDY: Rather than waiting for the next sweep, delete that duplicate.', ['delete']],
  ] as [string, string[]][]) {
    assert.deepEqual(
      mutationLexemes([construction]), expected,
      `${construction} instructs a mutation and must be refused`,
    )
    assert.deepEqual(
      legacyActsInstructed([construction]), [],
      `${construction} is one of the round-13 findings — the old fence must be shown to miss it, or `
      + 'this case is not evidence of anything',
    )
  }
})

// MUTATION THAT KILLS THIS (run): as the round-14 corpus test — these are the same checker, and any
// weakening of it that lets a removed wording back in fails here first.
//
// ROUTE: run against the SHIPPED checker, on the wordings rounds 12, 13 and 14 removed.
test('ROUND 14: every wording the previous rounds removed is still refused', () => {
  for (const [prose, expected] of [
    // ROUND 13's two findings: an act in a form round 12's fence could not see.
    ['if it is ON, the replay uploads to the bill, and you are choosing between turning it off — '
      + 'which stops attachment uploads for EVERY bill on this connector, not this one — and letting '
      + 'the uploads happen and clearing the duplicates afterwards.', ['clearing']],
    ['Both of them existed before this operation and neither was created by it; what happened is '
      + 'that one was applied to the other, and the only thing that undoes it is removing that '
      + 'allocation from the credit note in {ledger}.', ['undoes', 'removing']],
    // The nominalisation.
    ['REMEDY: escalate this record. Removal of the duplicate is what undoes it.', ['removal', 'undoes']],
    // ROUND 12's three: imperatives on an object no lookup names.
    ['REMEDY: open that bill in {ledger} and remove the duplicate attachment. There is no document '
      + 'to void, and the bill itself was not created by this attempt.', ['open', 'remove', 'void']],
    ['REMEDY: open that order in WooCommerce and remove any duplicate note. There is nothing to void '
      + 'in {ledger}.', ['open', 'remove']],
    ['REMEDY: THERE IS NOTHING TO VOID OR CREDIT — nothing was posted to a customer or a supplier '
      + 'account. Review the tax rates in {ledger}, and correct or archive that rate there if this '
      + 'write was wrong.', ['correct', 'archive']],
  ] as [string, string[]][]) {
    assert.deepEqual(mutationLexemes([prose]), expected, prose)
  }

  // THE COST OF THE INVERSION, ASSERTED SO IT IS NOT DISCOVERED. Sentences round 13 admitted by
  // rule — a prohibition, a consequence with no object — are now refused BY DEFAULT, and reach a
  // shipped entry only by being enumerated. This is the shipped UPDATE_DRAFT prohibition, which is
  // permitted there because that entry declares a lookup; written into a lookup-less entry, it
  // would have to be added to PROHIBITION_TEMPLATES first.
  assert.deepEqual(
    mutationLexemes(['DO NOT VOID OR CREDIT-NOTE IT — that would act on a document that was valid '
      + 'before this attempt ran. DO NOT REVERSE IT — a reversal POSTS FOR REAL.']),
    ['void', 'credit-note', 'reverse', 'reversal'],
    'a prohibition is no longer admitted by a rule — it is admitted one enumerated line at a time',
  )
  // …and the enumerated ones are admitted, which is the other half of that claim.
  assert.deepEqual(
    mutationLexemes(['REMEDY: THERE IS NOTHING TO UNDO. No attachment was created, no document was '
      + 'created, and nothing in {ledger} was touched by this attempt.']),
    [],
    'the shipped BILL_ATTACHMENT.NONE remedy is on the allowlist and must pass',
  )
  assert.notDeepEqual(
    mutationLexemes(['REMEDY: THERE IS NOTHING TO UNDO. No attachment was created, no document was '
      + 'created, and nothing in {ledger} was touched by this attempt.'], []),
    [],
    'and it must pass BECAUSE of the allowlist, not because it is clean',
  )

  // AND THE HOLE THAT REMAINS, ASSERTED RATHER THAN IMPLIED — item 1 of the block above.
  assert.deepEqual(
    mutationLexemes(['Go to that bill and take the second PDF off it.']), [],
    'an instruction phrased without a listed lexeme is NOT caught — the fence closes the verb, not '
    + 'the language, and it is now the only hole rather than one of four',
  )
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
    assert.doesNotMatch(message, /keep it \(re-enter the reference manually\) or void it/, reason)
    assert.doesNotMatch(message, /find it in Xero/, reason)
    assert.doesNotMatch(message, /open both ids in Xero/, reason)
    assert.doesNotMatch(message, /BOTH documents exist in Xero/, reason)
    assert.doesNotMatch(message, /POSTED as \(no id returned\)/, reason)

    // What it says instead — the allocation, and the thing that actually undoes one.
    assert.match(message, /THIS IS NOT A DOCUMENT/, reason)
    assert.match(message, /DO NOT OPEN, KEEP OR VOID EITHER THE BILL OR THE CREDIT NOTE/, reason)
    // ROUND 13: the clause that named the undo — "the only thing that undoes it is removing that
    // allocation from the credit note" — is DELETED, not softened. It told an operator to act on a
    // credit note this record does not name, in the gerund form round 12's fence could not see.
    assert.doesNotMatch(message, /removing that allocation/, reason)
    assert.match(message, /what happened is that one was applied to the other\. Escalate this record/, reason)
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
        assert.doesNotMatch(message, /keep it \(re-enter the reference manually\)/, `${connector} ${type}`)
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

// =============================================================================================
// ROUND 15 (Codex HIGH x2) — THE FENCE MOVES TO THE SHIPPED MESSAGE, AND FROM THE VERB TO THE
// OBJECT.
//
// TWO FINDINGS, AND THEY ARE THE SAME MISTAKE TWICE: the check was aimed at something ADJACENT to
// the thing that matters.
//
// FINDING 1 — IT SCANNED THE TABLES, NOT THE MESSAGE. `lookupLessTemplates()` reads the three
// wording tables. What an operator reads is what the FORMATTERS emit, and they concatenate their
// own prose around those entries. So every word the frames contribute was outside the fence, and
// Codex named a live instance: the QuickBooks frame ends every no-request-id record with "o3d-3lhp
// (a per-row remediation, and A WAY TO CANCEL A QUEUED EMAIL)". Delete the two enumerated email
// prohibitions and the round-14 test still passes while the shipped message still says `cancel`.
// Twelve rounds of these records have gone wrong in the FRAMING at least as often as in the table.
//
// FINDING 2 — THE VERB LIST WAS STILL A LIST. Round 14 admitted this in writing: an instruction
// phrased without one of the fifteen stems passes. "Go to that bill and take the second PDF off it"
// is not caught, and the same corpus already writes mutations as `APPLIED`, `wrote`, bare `CREDIT`
// and `TURN … OFF`. A documented hole is not enough when the hole IS the invariant.
//
// THE FIX FOR BOTH IS ONE IDEA: STOP ENUMERATING THE OPEN HALF OF THE SENTENCE.
//
// English has no closed set of ways to tell somebody to do something — four rounds of chasing that
// is what rounds 9 through 14 were. But it has a CLOSED SET OF THINGS THIS MODULE CAN TELL THEM TO
// DO IT TO. The objects that live in somebody else’s system are a fixed vocabulary: bill,
// invoice, credit note, journal, payment, tax rate, document, attachment, order, and the systems
// themselves. An instruction to act on one of them must SAY WHICH ONE, or the operator cannot go
// anywhere; and to say which one it must use that vocabulary, or name the ledger, or point at it
// ("there"). So the fence is pointed at the OBJECT, where the class is closed, instead of at the
// VERB, where it never was.
//
// "Go to that bill and take the second PDF off it" contains no listed verb and is refused anyway,
// because it says `bill`.
//
// THE INVARIANT, WHOLE, IN ONE SENTENCE. In the prose that tells an operator what to do, on an
// entry that declares no lookup:
//
//   • a span that names an ACT must be an enumerated PROHIBITION, and a prohibition must REFUSE
//     (round 14, unchanged);
//   • a span that names a REMOTE OBJECT must be an enumerated STATEMENT that contains no act and
//     does refuse or disclaim, or one of a SHORT, capped list of instructions at a LOCAL object;
//   • therefore no sentence can direct an act at an object the record cannot name — whatever verb
//     it uses, because the verb is no longer what is being asked about.
//
// WHAT THIS COSTS, SAID PLAINLY. The residue is not a language hole any more, it is a REVIEW GATE:
// Codex’s sentence can only ship by being added to `LOCAL_INSTRUCTION_TEMPLATES`, which is capped,
// commented per line, and required to contain no act. That is a deliberate, reviewable line in this
// file rather than a verb nobody thought of. The structured declared-target model (o3d-cvyv) would
// replace the gate with a type; it is a rewrite of all three tables and both formatters, and it is
// not what closes THIS hole — this does.
// =============================================================================================

/**
 * The fixture ledger identifiers. A rendered message containing one of these CAN name its object,
 * so the round-10/11 declaration tests govern it; one that contains none is the corpus here.
 *
 * This is the property of the SHIPPED MESSAGE, deliberately, rather than a walk back to the entry
 * that produced it. Finding 1 is precisely that the message is more than its entry.
 */
const LEDGER_ID_FIXTURES = ['EXT-1', 'EXT-OTHER', 'LEDGER-BILL-1']

/**
 * Put the per-incident values BACK into placeholder form, so one frame sentence is one line here.
 * The sync row id and the ledger name vary per message and per connector; the sentence does not.
 */
function normaliseRenderedValues(text: string): string {
  return text
    .split('log-1').join('{syncRowId}')
    .split('QuickBooks').join('{ledger}')
    .split('Xero').join('{ledger}')
    .split('QUICKBOOKS').join('{LEDGER}')
    .split('XERO').join('{LEDGER}')
}

/** Every message this module can produce that names no ledger identifier at all. */
function everyNamelessMessage(): { label: string; text: string }[] {
  return everyIncidentMessage()
    .filter(({ text }) => !LEDGER_ID_FIXTURES.some((id) => text.includes(id)))
    .map(({ label, text }) => ({ label, text: normaliseRenderedValues(text) }))
}

/**
 * THE SPANS THE FORMATTERS THEMSELVES CONTRIBUTE, verbatim. Same closed-allowlist discipline as
 * `PROHIBITION_TEMPLATES`, and held to the same shape of check below: each must contain a mutation
 * lexeme (or it exempts nothing), each must still appear in a shipped INCIDENT message (or it is a
 * hole nothing stands in), and each must either name no remote object at all or refuse — the same
 * rule the wording tables are held to, applied to the prose the formatters add around them.
 *
 * These four are the frames’ own sentences. They were never scanned before this round.
 */
const FRAME_TEMPLATES: readonly string[] = [
  'AND THE RESPONSE CARRIED NO ID EITHER, so there is nothing to open — do not go looking for '
    + 'one.',
  'NO ID WAS RETURNED, so there is nothing to open — do not go looking for one.',
  'ONE OF THE TWO IDS IS NOT RECORDED HERE, so they cannot both be opened.',
  'Leave the toggle off and ESCALATE sync row {syncRowId}, with this record, to whoever '
    + 'administers this installation: closing it safely needs someone who can read the database '
    + 'directly, and the machinery that would make an operator remedy sound is filed as o3d-4b5p (a '
    + 'quiescence fence the cron, the manual sync, the claim and the writeback all honour) and '
    + 'o3d-3lhp (a per-row remediation, and a way to cancel a queued email).',
  // ROUND 17 (Codex MEDIUM): the unclassified frame's refusal. It names three acts — open, keep,
  // void — and refuses all three in the same breath, which is the only reason a record that can
  // establish nothing is allowed to mention them at all. It was outside every scan until the
  // corpus started generating unclassified types.
  'DO NOT ASSUME A DOCUMENT. This record will not tell you to open, keep or void one, because it '
    + 'cannot establish that there is one.',
]

/**
 * THE RESET BREADCRUMB IS A DIFFERENT ARTEFACT, and it is kept in its own list because its
 * justification is different.
 *
 * It is not a record of one incident. It COUNTS the records a factory reset preserved and sends the
 * reader to them, and each of those records carries its own identifier or says in its own words
 * that it does not. So "Open the id in that system" is true where the breadcrumb says it and would
 * be a lie in any per-incident message — which is exactly what the check below asserts: every line
 * here must appear in the breadcrumb and in NO incident message. Mixing the two lists would let a
 * breadcrumb sentence launder an instruction into a record that can name nothing.
 */
const RESET_BREADCRUMB_TEMPLATES: readonly string[] = [
  'name a LIVE effect {ledger} or {ledger} accepted and still holds — real money in somebody '
    + 'else\'s books, which no reset of ours undoes.',
  'Open the id in that system, and read the record itself for what the operation actually did '
    + 'before you void, credit or reverse anything.',
  'are the same kind of write — a DOCUMENT {ledger} or {ledger} accepted, which no reset of '
    + 'ours voids — ON A RECORD THAT CARRIES NO ID.',
  'DO NOT GO LOOKING FOR AN ID: there is none to open.',
  'DO NOT void, credit-note or reverse any of them: a reversal POSTS FOR REAL, and would move '
    + 'the accounts by exactly the amount the draft never moved.',
  'THEY WERE NOT ALL CREATED AS DRAFTS: this count also holds documents that were MODIFIED '
    + 'while unposted, and deleting one of those destroys a draft that stood there before the '
    + 'attempt ran.',
  'Read the record itself before deleting anything.',
  'Do not void, credit, reverse or delete anything on the strength of these.',
  'record a write {ledger} or {ledger} ACCEPTED that is NOT a standalone document and has NO id '
    + 'to open — a credit note APPLIED to a bill, a tax rate written into the organisation.',
  'The write stands and no reset of ours undoes it, and the allocation moved money.',
  'The queued-email one never had a remote document at all — only a local email-outbox row, '
    + 'WHICH THIS RESET HAS JUST DELETED: the outbox rows that record tells you to inspect are gone '
    + 'with it, so their statuses can no longer be inspected.',
]

// MUTATION THAT KILLS THIS (run): delete `'IMS CANNOT CANCEL A QUEUED COPY'` and
// `'no action, route or screen removes an unsent row'` from PROHIBITION_TEMPLATES — the round-14
// test goes on passing, because it reads the tables, and THIS one fails naming the rendered
// QuickBooks INVOICE_EMAIL message and `cancel`, which is Codex’s live route. RUN. Deleting any
// FRAME_TEMPLATES line kills it the other way — RUN with the o3d-3lhp sentence removed, it fails on
// `cancel` in the frame tail, which is the word no table contains.
//
// ROUTE: the corpus is `everyIncidentMessage()` — the SHIPPED formatter output for every type,
// every outcome and every id combination — not the wording tables.
test('ROUND 15 (Codex HIGH): the fence scans the SHIPPED OPERATOR MESSAGE, frames included', () => {
  const messages = everyNamelessMessage()
  assert.ok(messages.length > 500, `sanity: ${messages.length} nameless messages were scanned`)
  const allowed = [...PROHIBITION_TEMPLATES, ...FRAME_TEMPLATES, ...RESET_BREADCRUMB_TEMPLATES]

  for (const { label, text } of messages) {
    const lexemes = mutationLexemes([text], allowed)
    assert.deepEqual(
      lexemes, [],
      `${label} tells an operator about the act(s) ${lexemes.join(', ')} in a message that names no `
      + 'ledger identifier, so nothing in it says which object they would act on. Either the record '
      + 'must retain and print an identifier, or the sentence must be an escalation, or — if it '
      + 'REFUSES the act — it must be enumerated in PROHIBITION_TEMPLATES, FRAME_TEMPLATES or '
      + 'RESET_BREADCRUMB_TEMPLATES.',
    )
  }

  // NOT VACUOUS: the rendered corpus passes THROUGH the allowlist, not past it.
  const bare = messages.flatMap(({ text }) => mutationLexemes([text], []))
  assert.ok(
    bare.length >= 500,
    `the allowlist must be doing work: with it empty the rendered corpus yields ${bare.length} lexemes`,
  )
  // AND THE FRAME LIST IS DOING ITS OWN SHARE — the tables alone do not carry the frames.
  const tablesOnly = messages.flatMap(({ text }) => mutationLexemes([text], PROHIBITION_TEMPLATES))
  assert.ok(
    tablesOnly.length > 0,
    'with only the wording-table prohibitions allowed the rendered corpus must still show lexemes, '
    + 'or FRAME_TEMPLATES is standing in front of nothing and finding 1 was not real',
  )
})

// MUTATION THAT KILLS THIS (run): add a line to FRAME_TEMPLATES that names a remote object without
// refusing — 'take the second PDF off that bill in the ledger' — and the third assertion fails
// naming it. RUN. Moving any RESET_BREADCRUMB_TEMPLATES line into FRAME_TEMPLATES fails the
// second, because no incident message contains it — RUN with 'Read the record itself before
// deleting anything.' moved across.
//
// ROUTE: both lists are read here; the corpus is the SHIPPED rendered messages, split by the
// formatter that produced them.
test('ROUND 15: every enumerated frame span is one the shipped frames still say, and says nothing new', () => {
  const rendered = everyIncidentMessage().map(({ label, text }) => ({
    label, text: normaliseRenderedValues(text),
  }))
  const breadcrumbs = rendered.filter(({ label }) => label.startsWith('breadcrumb'))
  const incidents = rendered.filter(({ label }) => !label.startsWith('breadcrumb'))
  assert.ok(breadcrumbs.length > 0 && incidents.length > 0, 'sanity: both surfaces were rendered')

  for (const frame of FRAME_TEMPLATES) {
    assert.ok(frame.length >= 20, `"${frame}" is too short to be a reviewable template`)
    assert.notDeepEqual(
      mutationLexemes([frame], []), [],
      `"${frame}" contains no mutation lexeme, so it exempts nothing and should be deleted`,
    )
    assert.ok(
      incidents.some(({ text }) => text.includes(frame)),
      `"${frame}" appears in no rendered incident message — delete it rather than leaving a hole `
      + 'nothing is standing in',
    )
    // ROUND 15 ALSO ASKED HERE WHETHER THE FRAME NAMED A REMOTE OBJECT, using the closed noun list
    // Codex then walked through. That question is gone rather than re-asked: round 16 requires
    // every word of a frame to be a reviewed span, which is a stronger claim than any list of nouns
    // could support and does not depend on recognising one.
  }

  for (const summary of RESET_BREADCRUMB_TEMPLATES) {
    assert.ok(summary.length >= 20, `"${summary}" is too short to be a reviewable template`)
    assert.notDeepEqual(
      mutationLexemes([summary], []), [],
      `"${summary}" contains no mutation lexeme, so it exempts nothing and should be deleted`,
    )
    assert.ok(
      breadcrumbs.some(({ text }) => text.includes(summary)),
      `"${summary}" appears in no rendered reset breadcrumb — delete it`,
    )
    // THE WHOLE JUSTIFICATION FOR THE SECOND LIST. These sentences are about records that carry
    // their own ids. Let one reach a per-incident message and it becomes an instruction about an
    // object that message cannot name, which is the thing this file exists to prevent.
    assert.ok(
      !incidents.some(({ text }) => text.includes(summary)),
      `"${summary}" is exempted as reset-breadcrumb prose but a per-incident message says it too — `
      + 'move it to FRAME_TEMPLATES, where it must refuse if it names a remote object',
    )
  }
})

// MUTATION THAT KILLS THIS (run): drop the `.sort((a, b) => b.length - a.length)` from
// `mutationLexemes` and this test fails with ['void']. RUN. Nothing in the shipped allowlists nests
// today, so the ordering is invisible to every other test here — which is exactly why it gets one
// of its own rather than a comment claiming it matters.
//
// ROUTE: the SHIPPED stripper, on an allowlist whose short line sits inside its long one.
test('ROUND 15: allowlist removal is a set, not a sequence — the longest span goes first', () => {
  const nested = ['open', 'do not open or void it']
  assert.deepEqual(
    mutationLexemes(['do not open or void it'], nested), [],
    'stripping the short span first consumes the middle of the long one, which then matches '
    + 'nothing — and the fence fails on prose that IS enumerated',
  )
})

// =============================================================================================
// ROUND 16 (the decision) — A LOOKUP-LESS RECORD MAY NOT INSTRUCT AN ACTION ON A REMOTE OBJECT
// AT ALL, IN ANY WORDING. NOT FENCED. NOT ENUMERATED. ABSENT.
//
// FIVE FENCES IN FIVE ROUNDS, ALL DEFEATED, AND ALWAYS THE SAME WAY. Round 9 enumerated field
// PHRASES; round 10 the DECLARATION; round 13 the imperative POSITION and the gerunds; round 14 a
// closed VERB list; round 15 a closed OBJECT-NOUN list. Codex walked through every one of them, and
// the sentence it walked through the last one with is the argument against a sixth:
//
//     "In your books, use the IMS reference above to reach the matching entry and take the second
//      PDF off it."
//
// No listed verb. No listed noun. A complete, performable instruction to remove a document from a
// ledger record this message cannot name. Codex's verdict: "Extending this noun regex cannot
// establish closure because synonyms, descriptions, and anaphora remain open." That is correct, and
// it is correct about every future list too — English has no closed set of ways to say WHICH thing,
// any more than it has one for what to DO to it.
//
// AND THE TWO ROUND-15 FIXES WERE NEVER COMPOSED. The object fence read `remedy`/`check` off the
// wording tables; the rendered-message test called only the mutation-lexeme checker. So the same
// sentence in a formatter FRAME, or in an `effect`, `did`, `stands` or `bothExist` field, passed
// both — one because the checker never saw those surfaces, the other because it was looking for a
// verb that is not in the sentence.
//
// -------------------------------------------------------------------------------------------
// SO THE INSTRUCTION IS REMOVED RATHER THAN FENCED, AND THE CHECK IS CLOSURE RATHER THAN A FENCE.
// -------------------------------------------------------------------------------------------
// A record that cannot name its object may say what happened, may say what is NOT known, may REFUSE
// an act — and, for what it CAN name, may give a small, listed set of local, read-only
// instructions. It may not send anybody to a remote object. Not with an allowed verb, not with an
// allowed noun, not with a synonym, a description or a pronoun: there is no such sentence to write,
// so there is nothing left for a grammar to be wrong about.
//
// WHAT THE CHECK IS. Not "does this text contain a bad thing" — that is the question that has been
// answered wrongly five times. It is: IS EVERY WORD OF THIS MESSAGE ONE THAT WAS REVIEWED? Every
// lookup-less rendered message — formatter frames and every table field included, which is the
// composition Codex named — must decompose ENTIRELY into three hand-written lists in this file:
//
//   LOCAL_DIRECTIONS      the complete inventory of what these records tell an operator to DO.
//                         Fourteen entries, capped. ROUND 17: they are {action, target} STRUCTURES
//                         with no free-text field, and their prose is generated from them, so the
//                         closed target union produces the sentence instead of labelling it.
//   BREADCRUMB_DIRECTIONS the reset breadcrumb's own instructions, which may point at a ledger
//                         because the records it counts carry their own ids — held to appearing in
//                         the breadcrumb and in NO per-incident message.
//   RECORD_PROSE          everything else these messages say: statements of fact, statements of
//                         incapacity, refusals. Not one of them instructs.
//
// A word that is in none of them fails the test. Codex's sentence therefore fails wherever it is
// put — a frame, an `effect` field, a `remedy` — not because of what it says but because nobody
// reviewed it. There is no vocabulary to extend and no grammar to walk around, because nothing is
// being parsed.
//
// WHAT IT COSTS, PLAINLY. An operator reading a lookup-less incident is told what happened, what is
// known, what is NOT known, and to escalate — instead of being handed a remote action they might
// perform against the wrong document. For a record that is exempt from retention and from the
// factory reset, and outlives everything else in this system, being useless is recoverable and
// being wrong is not.
//
// AND WHAT IT DOES NOT BUY, STATED RATHER THAN IMPLIED. Closure makes an UNREVIEWED sentence
// impossible; it cannot make a REVIEWED one right. Somebody may still add an instruction to
// RECORD_PROSE and mis-call it prose. That is a deliberate line in this file with a diff attached,
// not a verb nobody thought of — and it is the last residue.
//
// ROUND 17 TOOK THE STRUCTURED ANSWER FOR THE DIRECTIONS. Codex's finding on round 16 was that the
// closed target union was never coupled to the instruction text: `object` was hand-written beside a
// hand-written `span`, and `object.length > 0` was the only thing joining them, so a direction could
// declare a local target and instruct something else entirely. LOCAL_DIRECTIONS are now typed
// {action, target} values whose prose is GENERATED (see `renderLocalDirection`), which is the shape
// filed as o3d-cvyv, scoped to the fourteen directions rather than the whole module. RECORD_PROSE
// and BREADCRUMB_DIRECTIONS are still reviewed lists of sentences, and that is the residue above.
//
// NOTHING HAD TO BE REMOVED FROM THE SHIPPED TEXT TO GET HERE. Every span below was read against
// this rule, and rounds 12 to 15 had already deleted the three instructions that broke it ("open
// that bill", "open the order in WooCommerce", "correct or archive that rate"). What round 16
// changes is that there is now no wording in which one can come back.
// =============================================================================================

/** The fields that decide WHICH wording entry a message is: the ones that tell an operator what to do. */
const IDENTITY_FIELDS = new Set([
  'remedy', 'remedyRowGone', 'remedyDuplicate', 'remedyIdUnrecorded', 'check',
])

/** The branch that has no wording entry at all — an operation type this binary does not classify. */
const UNCLASSIFIED_MARKER = 'THIS VERSION OF IMS DOES NOT CLASSIFY THAT OPERATION TYPE'

const OPERATION_TYPES_LONGEST_FIRST = [...EVERY_GENERATED_TYPE].sort((a, b) => b.length - a.length)

/**
 * Put EVERY per-incident value back into placeholder form, not only the two round 15 did. The
 * closure below compares whole spans, so a value that varies per message — the cause, the
 * reference, the operation type, an external id the message itself calls "not a document id" —
 * would otherwise make one reviewed sentence look like forty unreviewed ones.
 */
function normaliseIncidentValues(text: string): string {
  let t = normaliseRenderedValues(text)
    .split('Error: write conflict').join('{cause}')
    // ROUND 18: the outbox job the burial-failure message names. A fixture id like any other.
    .split('outbox-1').join('{outboxJobId}')
    .split('SalesOrder order-1').join('{reference}')
    .split('EXT-OTHER').join('{namedExternalId}')
    .split('EXT-1').join('{postedExternalId}')
  for (const type of OPERATION_TYPES_LONGEST_FIRST) {
    t = t.split(`${type} for {reference}`).join('{type} for {reference}')
  }
  return t
}

/**
 * EVERY SHIPPED MESSAGE A LOOKUP-LESS ENTRY CAN PRODUCE — selected from the ENTRY, not from the
 * message's appearance.
 *
 * Round 15 selected on "the message contains no fixture id", which is a property of the message and
 * was the right correction to make then. It is not enough: a lookup-less NON-DOCUMENT entry renders
 * inside a message that DOES print an external id — the frame's own sentence saying that id is not
 * a document id — and that message was outside round 15's corpus while carrying the same
 * instruction. So the corpus is the union: every message that renders a lookup-less entry's
 * directive field, every message that names no identifier at all, the unclassified branch that has
 * no entry, and the reset breadcrumbs.
 */
function lookupLessMessages(): { label: string; text: string }[] {
  const identity = [...everyWordingEntry(), ...everyReplayWordingEntry()]
    .filter((entry) => entry.lookup.length === 0)
    .flatMap(({ fields }) => Object.entries(fields)
      .filter(([field, value]) => IDENTITY_FIELDS.has(field) && typeof value === 'string')
      .map(([, value]) => normaliseIncidentValues(value)))
  return everyIncidentMessage()
    .filter(({ label, text }) => label.startsWith('breadcrumb')
      || text.includes(UNCLASSIFIED_MARKER)
      || !LEDGER_ID_FIXTURES.some((id) => text.includes(id))
      || identity.some((span) => normaliseIncidentValues(text).includes(span)))
    .map(({ label, text }) => ({ label, text: normaliseIncidentValues(text) }))
}

/**
 * ROUND 18 (Codex HIGH): THE MODEL MOVED INTO PRODUCTION, so what follows validates the SHIPPED
 * record rather than a rebuild of it.
 *
 * `LocalDirection`, `LOCAL_TARGET` and `renderLocalDirection` were declared HERE through round 17.
 * The coupling that round claimed was therefore about a fixture: the assertion was that the
 * generated span appeared somewhere inside independently written production prose, so a formatter
 * could carry the span and extend the same instruction with a remote action, and the type-checker
 * would have constrained only the test's own rebuild. They live in
 * lib/domain/accounting/local-operator-direction.ts now, and the formatters COMPOSE the shipped
 * sentence from `renderLocalDirection(...)` — see the r18 coupling test below, which reads the
 * production source for the composition rather than reading the prose for the words.
 *
 * The renderer takes a CONTEXT (the ledger's display name, the sync row id) because those are the
 * two values a direction's prose varies by; the corpus is normalised back into `{ledger}` and
 * `{syncRowId}`, so this file renders with the placeholder context and compares like with like.
 */
const LOCAL_DIRECTION_CONTEXT: LocalDirectionContext = { ledger: '{ledger}', syncRowId: '{syncRowId}' }

/**
 * EVERY STRING THE DIRECTION RENDERER CAN EMIT, WRITTEN OUT AND REVIEWED (round 20, Codex HIGH).
 *
 * ROUND 19 DERIVED THIS LIST FROM THE RENDERER — `LOCAL_DIRECTIONS.map(renderLocalDirection)` — and
 * that is the vacuity `RECORD_PROSE` is duplicated by hand to avoid, arriving in the one place the
 * file had stopped applying it. Codex's route, in full: append "Go to that bill and take the second
 * PDF off it." to the ESCALATE branch of the production renderer. The round-19 one-action proof
 * passes it (it contains no other direction whole, names no other target's anchor, and neither `go`
 * nor `take` is on the twelve-verb banlist), and the corpus closure below passes it too — because
 * the span it strips from the shipped message is whatever the renderer now returns. The generator
 * was introduced to make prose safe, and its output had become the one unreviewed surface in the
 * file.
 *
 * SO THE OUTPUT IS THE INVENTORY. Fourteen directions and one sequence, each written out verbatim
 * beside the direction that produces it, and the renderer is held to EXACT EQUALITY with them (see
 * the round-20 test). A sentence the renderer emits that is not here fails twice over: the equality
 * assertion names the branch, and the corpus closure stops accounting for the words. Updating this
 * list is where the new sentence gets read — which is the whole of the discipline the reviewed prose
 * lists already run on.
 *
 * `{ledger}` and `{syncRowId}` are the placeholders `LOCAL_DIRECTION_CONTEXT` substitutes, so an
 * entry shows exactly where the message's own values land and nothing else.
 */
const RENDERED_DIRECTIONS: readonly { direction: LocalDirection; text: string }[] = [
  {
    direction: { action: 'CONFIRM', target: 'ORDER_INVOICE_PDF' },
    text: 'confirm the invoice PDF stored against the order is the document you expect',
  },
  {
    direction: { action: 'INSPECT', target: 'EMAIL_OUTBOX_ROWS', form: 'THIS_ORDERS_ROWS' },
    text: "Inspect the outbox rows for this order and read each row's status, attempts, lastError and sentAt.",
  },
  {
    direction: { action: 'INSPECT', target: 'EMAIL_OUTBOX_ROWS', form: 'BY_KIND_AND_REFERENCE' },
    text: 'Then INSPECT the outbox: query it for kind ACCOUNTING_INVOICE, referenceType SalesOrder, referenceId '
      + "= the order id (no page in IMS lists them) and read each row's status, attempts, lastError, createdAt "
      + 'and sentAt.',
  },
  {
    direction: { action: 'RE_READ', target: 'EMAIL_OUTBOX_ROWS' },
    text: 'so re-run the query rather than treating one result as the final list',
  },
  {
    direction: { action: 'READ', target: 'EMAIL_OUTBOX_ROWS' },
    text: 'Read them by status, lastError and time',
  },
  {
    direction: { action: 'TURN_OFF', target: 'SETTING_SYNC_ENABLED', control: 'LEVER_BELOW' },
    text: 'TURN THE LEVER BELOW OFF FIRST, so that no NEW run is admitted',
  },
  {
    direction: { action: 'READ_SETTING', target: 'SETTING_ATTACH_PDF', form: 'THEN_GO_AND_READ_IT' },
    text: 'THEN GO AND READ quickbooks_sync_attach_pdf AS IT STANDS NOW',
  },
  {
    direction: { action: 'READ_SETTING', target: 'SETTING_ATTACH_PDF', form: 'TO_LEARN_WHAT_A_REPLAY_WOULD_DO' },
    text: 'READ quickbooks_sync_attach_pdf AS IT STANDS NOW to learn what a replay would do',
  },
  {
    direction: { action: 'TURN_OFF', target: 'SETTING_SYNC_ENABLED', control: 'CONNECTOR_PANEL_CHECKBOX' },
    text: 'HOW TO STOP MORE OF IT: turn {ledger} sync OFF. The control is the checkbox at the top of the SYNC '
      + 'tab of the {ledger} connector panel, and it writes the setting quickbooks_sync_enabled.',
  },
  {
    direction: { action: 'LEAVE_OFF', target: 'SETTING_SYNC_ENABLED', form: 'NOT_A_FENCE' },
    text: 'THEN LEAVE IT OFF, BECAUSE TURNING IT OFF IS NOT A FENCE.',
  },
  {
    direction: { action: 'LEAVE_OFF', target: 'SETTING_SYNC_ENABLED', form: 'BEFORE_ESCALATION' },
    text: 'Leave the toggle off',
  },
  {
    direction: { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'SYNC_ROW' },
    text: 'ESCALATE sync row {syncRowId}, with this record, to whoever administers this installation',
  },
  {
    direction: { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'RECORD_ONLY', caseForm: 'SENTENCE' },
    text: 'Escalate this record to whoever administers this installation',
  },
  {
    direction: { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'RECORD_ONLY', caseForm: 'CLAUSE' },
    text: 'escalate this record to whoever administers this installation',
  },
]

/**
 * The sequences, likewise written out. The conjunction that joins the elements is prose an operator
 * reads and is contributed by `renderLocalDirectionSequence` rather than by either element, so it
 * has to be reviewed as prose and not inferred from the two halves.
 */
const RENDERED_DIRECTION_SEQUENCES: readonly { sequence: LocalDirectionSequence; text: string }[] = [
  {
    sequence: LEAVE_THE_TOGGLE_OFF_THEN_ESCALATE,
    text: 'Leave the toggle off and ESCALATE sync row {syncRowId}, with this record, to whoever administers '
      + 'this installation',
  },
]

/**
 * The spans the corpus closure is allowed to strip — TAKEN FROM THE REVIEWED INVENTORY, never from
 * the renderer. That substitution is the round-20 fix: the closure now accounts for the sentences
 * somebody read, so a renderer whose output has drifted from them stops being accounted for at all.
 */
const LOCAL_DIRECTION_SPANS: readonly string[] = [
  ...RENDERED_DIRECTIONS.map((entry) => entry.text),
  ...RENDERED_DIRECTION_SEQUENCES.map((entry) => entry.text),
]

/**
 * THE RESET BREADCRUMB'S OWN INSTRUCTIONS, WHICH ARE ALLOWED TO POINT AT A LEDGER.
 *
 * It is not a record of one incident: it COUNTS the records a reset preserved and sends the reader
 * to them, and each of those records carries its own identifier or says in its own words that it
 * does not. "Open the id in that system" is true where the breadcrumb says it and would be a lie in
 * any per-incident message — which is what the test below asserts, line by line. Mixing the two
 * lists is how a breadcrumb sentence would launder an instruction into a record that can name
 * nothing.
 */
const BREADCRUMB_DIRECTIONS: readonly string[] = [
  'Open the id in that system, and read the record itself for what the operation actually did before you void, credit or reverse anything.',
  'Read the record itself before deleting anything.',
  'Read those records themselves before assuming any of them.',
  'Read those records themselves;',
  'Escalate them.',
  'Read each record.',
  // The breadcrumb sends the reader to the activity log it is a breadcrumb FOR. It is local and
  // read-only, and it is here rather than in LOCAL_DIRECTIONS because no per-incident message says
  // it — a line that only the breadcrumb ships is guarded by the breadcrumb's own rule.
  'Search this log for "xero_posted_document_unrecorded" or "quickbooks_posted_document_unrecorded".',
]

/**
 * EVERYTHING ELSE THESE MESSAGES SAY, VERBATIM.
 *
 * Statements of what happened, statements of what this record cannot establish, and refusals. Every
 * line was read against the rule at the top of this section; none of them instructs anything. They
 * are duplicated here rather than read out of the module ON PURPOSE — an allowlist derived from the
 * text it is checking allows whatever that text becomes, which is the vacuity every generation of
 * this invariant has had to be argued out of. A reword in the module fails this list until somebody
 * updates it, and updating it is where the sentence gets read.
 */
const RECORD_PROSE: readonly string[] = [
  // ROUND 18 (Codex MEDIUM): THE THREE WRAPPER SUFFIXES. Each appends to the base wording on a
  // durable recovery surface — the outbox job's failure column and the process log, the standalone
  // activity-log row written when the transactional one could not be, and the message that fails the
  // run when the job could not even be buried. None of them was in the corpus, so none of them was
  // ever decomposed against these lists; all three are prose about what happened and what is no
  // longer written down, and none of them instructs anything.
  ' AND THIS RECORD COULD NOT BE SAVED: {cause}. The identifier above exists only in this message.',
  ' (Recorded outside its own transaction, which could not be committed: {cause}.)',
  ' THE OUTBOX JOB {outboxJobId} COULD NOT BE BURIED EITHER: {cause}. The incident IS on record in the activity log, and the next run reads it before completing this job, so the reclaim will bury the job rather than complete it.',
  ' THE OUTBOX JOB {outboxJobId} COULD NOT BE BURIED EITHER: {cause}. NOTHING WAS WRITTEN DOWN: not the record, not the job. This message is the only copy of the identifier, and a reclaim of this job will find a settled row and complete it as a success.',
  ". AND IMS CANNOT NARROW IT: no outbox row records the sync attempt that queued it, so nothing attributes a copy to this incident; the authenticated accounting-invoice email action writes the identical shape, so ordinary operator sends are in the same result; a SENT row has already gone; and A FAILED ROW IS NOT PROOF THAT NOTHING WENT — it means IMS HOLDS NO DURABLE CONFIRMATION OF DELIVERY. NO FAILED ROW PROVES A COPY WAS NEVER SENT, WHATEVER ITS lastError SAYS — NOT EVEN \"Suppressed recipient:\". The sender stamps SENT only after the transport call has returned, and that stamp is inside the same try whose catch writes FAILED on the fifth attempt (and PENDING before it, which sends the copy again), so a copy that WAS delivered and could not be stamped ends up FAILED; a send is judged from the transport error alone, which cannot say whether the server had already accepted the message; and the suppression check that writes that prefix runs at the top of the sweep, reads only the suppression table, and overwrites whatever the row already carried — so it speaks for the attempt that wrote it and for no attempt before it. IMS keeps no per-attempt outcome, so no row can be read backwards into its own history (o3d-ch0h).",
  "Database reset kept 1 record(s) of things IMS did against an accounting connector and could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately. 1 are NOT accounting documents — no invoice, bill, credit note, payment or journal was created in {ledger} or {ledger} for any of them. They record an effect that landed somewhere else and can repeat: a file attached to an EXISTING bill, an invoice PDF written over the stored copy, an invoice email QUEUED to a customer, a note written onto a WooCommerce order. AN ATTACHMENT RECORD IN HERE MAY BE A NO-OP: that handler returns success WITHOUT uploading when attachment upload is off for its connector. Records written since IMS began capturing that outcome say which of the two happened; OLDER ONES SAY THEY DO NOT KNOW, and this count does not separate them, so it cannot tell you how many of either there are. The queued-email one never had a remote document at all — only a local email-outbox row, WHICH THIS RESET HAS JUST DELETED: the outbox rows that record tells you to inspect are gone with it, so their statuses can no longer be inspected.",
  "do not go looking for a document. 1 are NOT accounting documents — no invoice, bill, credit note, payment or journal was created in {ledger} or {ledger} for any of them. They record an effect that landed somewhere else and can repeat: a file attached to an EXISTING bill, an invoice PDF written over the stored copy, an invoice email QUEUED to a customer, a note written onto a WooCommerce order. AN ATTACHMENT RECORD IN HERE MAY BE A NO-OP: that handler returns success WITHOUT uploading when attachment upload is off for its connector. Records written since IMS began capturing that outcome say which of the two happened; OLDER ONES SAY THEY DO NOT KNOW, and this count does not separate them, so it cannot tell you how many of either there are. The queued-email one never had a remote document at all — only a local email-outbox row, WHICH THIS RESET HAS JUST DELETED: the outbox rows that record tells you to inspect are gone with it, so their statuses can no longer be inspected. 1 carry no operation type this version of IMS has classified, so it cannot say which kind they are.",
  ": closing it safely needs someone who can read the database directly, and the machinery that would make an operator remedy sound is filed as o3d-4b5p (a quiescence fence the cron, the manual sync, the claim and the writeback all honour) and o3d-3lhp (a per-row remediation, and a way to cancel a queued email). ONE THING ON SCREEN IS ACTIVELY WRONG AND YOU WILL SEE IT: the accounting log renders a settle control for every FAILED or PROCESSING row, and on this one it resolves to the words \"not settleable\" with its reason as the tooltip. DO NOT FOLLOW THAT TOOLTIP. It is the generic reason, written for a connector that stamps attempt revisions, and it tells you to retry the row until it shows one: {ledger} never stamps one, so no number of retries will ever make an attempt appear — and every retry is another replay of the effect above. This is the known hole o3d-qn21. Until the work above lands, this record is the only thing that says the effect repeated.",
  "Both of those call sites read the setting and then call the processor with nothing in between, so a run admitted a moment before you flipped it keeps going: it can claim THIS row afterwards, run the operation again, and then write over the row — the write that records a {ledger} post updates the row BY ID ALONE, with no claim token, no attempt revision and no status check, so it lands on whatever the row says by then. That claim also leaves the row at attempt revision 0, which is indistinguishable from the abandoned attempt in front of you. Nothing in IMS reports whether such a run is still going, so there is no moment you can point at and call this row quiet. SO DO NOT CLOSE THIS ROW YOURSELF, AND DO NOT TURN {LEDGER} SYNC BACK ON TO FINISH THE JOB.",
  ": closing it safely needs someone who can read the database directly (o3d-4b5p, o3d-3lhp). ONE THING ON SCREEN IS ACTIVELY WRONG AND YOU WILL SEE IT: the accounting log renders a settle control for every FAILED or PROCESSING row, and on this one it resolves to the words \"not settleable\" with its reason as the tooltip. DO NOT FOLLOW THAT TOOLTIP. It tells you to retry the row until it shows an attempt revision, and the {ledger} claim never stamps one, so no number of retries will ever make an attempt appear. This is the known hole o3d-qn21. WHAT THIS RECORD HOLDS: the operation type, the IMS reference above, the sync row id, and the time this record was written — the write it describes was made in the same sync attempt. That is all of it.",
  "Database reset kept 1 record(s) of things IMS did against an accounting connector and could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately. 1 MOVED NO BALANCES — the posting mode on those rows was `draft`, so what they wrote sits UNPOSTED in {ledger}. DO NOT void, credit-note or reverse any of them: a reversal POSTS FOR REAL, and would move the accounts by exactly the amount the draft never moved. THEY WERE NOT ALL CREATED AS DRAFTS: this count also holds documents that were MODIFIED while unposted, and deleting one of those destroys a draft that stood there before the attempt ran.",
  ", because this record cannot: if it is off, the replay above stays a no-op and there is nothing to change; if it is ON, the replay uploads to a bill THIS RECORD DOES NOT NAME, so there is no duplicate this record can send you to. The one lever here is that setting, and it stops attachment uploads for EVERY bill on this connector rather than for this one. TURNING IT OFF IS NOT A FENCE EITHER: the handler reads that setting and then uploads, so a run already past the read still uploads, and nothing in IMS reports whether one is. Only closing the row stops the replay, and IMS cannot close it (o3d-4b5p)",
  "{ledger} {type} for {reference} SUCCEEDED — the external effect has happened — but IMS could not record that it did: {cause}. THIS OPERATION RETURNS NO IDENTIFIER AND NO REQUEST ID PROTECTS IT: unlike a document post it is not sent under a derived Intuit Request-Id, so there is nothing for {ledger} or WooCommerce or a mail server to deduplicate it against. Sync row {syncRowId} was left holding this worker's claim, with no mirrored accounting event written, so once that claim goes stale THE SWEEP WILL RECLAIM THE ROW AND RUN THE OPERATION AGAIN OUTRIGHT —",
  "{ledger} {type} for {reference} MADE NO EXTERNAL EFFECT. The handler returned success WITHOUT ACTING: no request was sent, nothing was created, changed, uploaded or emailed, and nothing in {ledger} or anywhere else is different because this attempt ran. WHAT COULD NOT BE RECORDED IS THAT IT RAN AT ALL: {cause}. WHAT A REPLAY WOULD COST: sync row {syncRowId} was left holding this worker's claim, with no mirrored accounting event written, so once that claim goes stale the sweep will reclaim the row and run the operation again. Running it again does",
  ", but IMS could not record the post: {cause}. Sync row {syncRowId} was left naming no document, so nothing in IMS pointed at this one and no mirrored accounting event was written for it — deliberately, because a FAILED one would deny a document that exists. The row was left holding its claim and will be re-attempted once that claim goes stale; that attempt re-posts under the SAME Intuit Request-Id, so it should be deduplicated rather than duplicated. AND THE RESPONSE CARRIED NO ID EITHER, so there is nothing to open — do not go looking for one.",
  "REMEDY: NO DOCUMENT WAS CREATED — this operation changed one that already existed, so there is no duplicate of it in existence and nothing this attempt brought into being. WHAT THIS RECORD DOES NOT SAY is whether the document it changed is LIVE or an UNPOSTED DRAFT: the update is sent with a status resolved from the same posting-mode setting the create uses, and IMS did not record which was in force for this attempt. So it cannot say whether any balance moved. DO NOT void, credit-note, reverse or delete anything on the strength of this record.",
  ". DO NOT TURN {LEDGER} SYNC OFF FOR THIS ONE. That switch is the containment lever for an incident where something DID reach {ledger}. There is nothing here to contain, and turning it off stops EVERY {ledger} row on this installation — invoices, bills, payments and journals with nothing to do with this row — for as long as it stays off. WHAT IS ACTUALLY WRONG IS THE WRITE, NOT THE OPERATION: sync row {syncRowId} was left PROCESSING at attempt revision 0 with no mirrored event, and nothing in IMS will settle it.",
  "IT IS LABELLED \"Enable {ledger} Sync\" EVEN THERE, and its helper text says {ledger} too: the {ledger} panel renders the {ledger} client and those two strings are hardcoded. The words are wrong; the checkbox is the right one. (Filed as o3d-m9wm.) The stale-claim sweep and the manual Sync button both READ that setting before they call the {ledger} processor, so while it is off neither one STARTS another run. It stops EVERY {ledger} row, not this one, and it recalls nothing already queued or already done.",
  "REMEDY: THIS RECORD DOES NOT SAY WHETHER THAT WAS A LIVE POSTING OR A DRAFT. This operation creates a live ledger document on one posting-mode setting and an UNPOSTED DRAFT on the other, and IMS did not record which was used for this attempt — so it cannot say whether any balance moved. DO NOT void, credit-note, reverse or delete anything on the strength of this record: the remedy for a live posting is the one that does the most damage to a draft, and the other way round.",
  "Database reset kept 1 record(s) of things IMS did against an accounting connector and could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately. 1 name a LIVE effect {ledger} or {ledger} accepted and still holds — real money in somebody else's books, which no reset of ours undoes. THEY ARE NOT ALL NEW DOCUMENTS: this count also holds documents that were MODIFIED rather than created, and payments applied to documents nobody created here.",
  "Database reset kept 7 record(s) of things IMS did against an accounting connector and could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately. 1 name a LIVE effect {ledger} or {ledger} accepted and still holds — real money in somebody else's books, which no reset of ours undoes. THEY ARE NOT ALL NEW DOCUMENTS: this count also holds documents that were MODIFIED rather than created, and payments applied to documents nobody created here.",
  "Database reset kept 1 record(s) of things IMS did against an accounting connector and could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately. 1 are from operations that create a LIVE ledger document on one posting-mode setting and an UNPOSTED DRAFT on the other, ON RECORDS THAT DO NOT SAY WHICH. IMS cannot tell you whether those balances moved. Do not void, credit, reverse or delete anything on the strength of these.",
  ", but IMS could not record the post: {cause}. Sync row {syncRowId} was left naming no document, so nothing in IMS pointed at this one and no mirrored accounting event was written for it — deliberately, because a FAILED one would deny a document that exists. The row was left holding its claim and will be re-attempted once that claim goes stale; that attempt re-posts under the SAME Intuit Request-Id, so it should be deduplicated rather than duplicated.",
  "1 MOVED NO BALANCES — the posting mode on those rows was `draft`, so what they wrote sits UNPOSTED in {ledger}. DO NOT void, credit-note or reverse any of them: a reversal POSTS FOR REAL, and would move the accounts by exactly the amount the draft never moved. THEY WERE NOT ALL CREATED AS DRAFTS: this count also holds documents that were MODIFIED while unposted, and deleting one of those destroys a draft that stood there before the attempt ran.",
  "Database reset kept 1 record(s) of things IMS did against an accounting connector and could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately. 1 record a write {ledger} or {ledger} ACCEPTED that is NOT a standalone document and has NO id to open — a credit note APPLIED to a bill, a tax rate written into the organisation. The write stands and no reset of ours undoes it, and the allocation moved money.",
  "Database reset kept 1 record(s) of things IMS did against an accounting connector and could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately. 1 are the same kind of write — a DOCUMENT {ledger} or {ledger} accepted, which no reset of ours voids — ON A RECORD THAT CARRIES NO ID. DO NOT GO LOOKING FOR AN ID: there is none to open.",
  "NOTHING — PROVIDED ATTACHMENT UPLOAD IS STILL OFF WHEN THE SWEEP RUNS. What this record knows is that quickbooks_sync_attach_pdf read \"false\" AT THE MOMENT THIS ATTEMPT RAN, which is the only reading it ever took. If that setting is on by the time the row is reclaimed, every sweep uploads the supplier invoice PDF to the bill instead",
  "this operation succeeds by QUEUEING, not by sending, and IMS CANNOT CANCEL A QUEUED COPY. EmailOutbox has four states — PENDING, PROCESSING, SENT, FAILED — none of which means \"deliberately not delivered\", and no action, route or screen removes an unsent row, so there is nothing to press.",
  "Database reset kept 1 record(s) of things IMS did against an accounting connector and could never record. THEY ARE NOT ALL THE SAME KIND OF THING, so they are counted separately. 1 carry no operation type this version of IMS has classified, so it cannot say which kind they are.",
  "1 are from operations that create a LIVE ledger document on one posting-mode setting and an UNPOSTED DRAFT on the other, ON RECORDS THAT DO NOT SAY WHICH. IMS cannot tell you whether those balances moved. Do not void, credit, reverse or delete anything on the strength of these.",
  "it either uploaded a supplier-invoice PDF onto a bill that already existed in {ledger} or did nothing at all — the handler skips the upload and STILL RETURNS SUCCESS when the attachment-upload setting reads as off, and this record does not say which of the two this attempt was",
  ", and note that nothing further will be retried for this row. WHAT THIS RECORD HOLDS: the operation type, the IMS reference above, the sync row id, and the time this record was written — the write it describes was made in the same sync attempt. That is all of it.",
  "{ledger} {type} for {reference} SUCCEEDED, but IMS RECORDED NEITHER WHAT IT DID NOR THAT IT RAN — this operation has a success path that acts and a success path that does nothing, and this record does not say which one this attempt took. WHAT THE OPERATION DID:",
  ", and note that no further sync attempt will touch either. WHAT THIS RECORD HOLDS: the operation type, the IMS reference above, the sync row id, and the time this record was written — the write it describes was made in the same sync attempt. That is all of it.",
  "1 record a write {ledger} or {ledger} ACCEPTED that is NOT a standalone document and has NO id to open — a credit note APPLIED to a bill, a tax rate written into the organisation. The write stands and no reset of ours undoes it, and the allocation moved money.",
  "; nothing further will be retried for this row. WHAT THIS RECORD HOLDS: the operation type, the IMS reference above, the sync row id, and the time this record was written — the write it describes was made in the same sync attempt. That is all of it.",
  "either the supplier invoice PDF is uploaded to that bill in {ledger} AGAIN once per sweep, or nothing happens at all — which of the two depends on quickbooks_sync_attach_pdf as it stands when the sweep runs, and this record carries no reading of it",
  "; no further sync attempt will touch either. WHAT THIS RECORD HOLDS: the operation type, the IMS reference above, the sync row id, and the time this record was written — the write it describes was made in the same sync attempt. That is all of it.",
  "it uploaded a supplier-invoice PDF onto a bill that already existed in {ledger}. THE UPLOAD HAPPENED. No id came back because an attachment is not a document, and this record does not carry the id of the bill it went onto either",
  "REMEDY: DO NOT OPEN, KEEP OR VOID EITHER THE BILL OR THE CREDIT NOTE ON THE STRENGTH OF THIS RECORD. Both of them existed before this operation and neither was created by it; what happened is that one was applied to the other.",
  "REMEDY: THERE IS NOTHING TO VOID OR CREDIT — nothing was posted to a customer or a supplier account. THIS RECORD DOES NOT SAY WHAT THE RATE WAS BEFORE THE WRITE, so it cannot tell you what correcting it would restore.",
  "REMEDY: IMS CANNOT CANCEL A QUEUED COPY — EmailOutbox has four states (PENDING, PROCESSING, SENT, FAILED), none of which means \"deliberately not delivered\", and no action, route or screen removes an unsent row.",
  "REMEDY: THIS RECORD DOES NOT NAME THE WOOCOMMERCE ORDER. It holds the IMS reference above and nothing else, and the IMS record that maps that reference to a WooCommerce order does not survive a database reset.",
  ". WHAT THIS RECORD HOLDS: the operation type, the IMS reference above, the sync row id, and the time this record was written — the write it describes was made in the same sync attempt. That is all of it.",
  "THIS RECORD DOES NOT NAME THE WOOCOMMERCE ORDER — it holds the IMS reference above and nothing else, and the IMS record that maps that reference to a WooCommerce order does not survive a database reset.",
  "WHAT THIS RECORD HOLDS: the operation type, the IMS reference above, the sync row id, and the time this record was written — the write it describes was made in the same sync attempt. That is all of it.",
  "REMEDY: DO NOT REMOVE AN ATTACHMENT FROM A BILL THIS RECORD CANNOT NAME. The upload happened, so a duplicate may exist, but nothing kept here says which bill it is on and nothing kept here derives it.",
  "{ledger} {type} for {reference} SUCCEEDED WITHOUT MAKING ANY EXTERNAL EFFECT — nothing left this process and nothing in {ledger} changed — and IMS could not record that it ran. WHAT THE OPERATION DID:",
  "it did nothing at all. Attachment upload READ AS OFF FOR THIS CONNECTOR AT THE MOMENT THIS ATTEMPT RAN, so the handler returned success without contacting {ledger} and without uploading anything",
  "it APPLIED an already-posted supplier credit note to an already-posted bill. An allocation is a sub-resource of the credit note, not a standalone document, and {ledger} returns no id for one",
  "1 are the same kind of write — a DOCUMENT {ledger} or {ledger} accepted, which no reset of ours voids — ON A RECORD THAT CARRIES NO ID. DO NOT GO LOOKING FOR AN ID: there is none to open.",
  "A FAILED ROW IS NOT PROOF THAT NOTHING WENT, whatever its lastError says: IMS keeps no per-attempt outcome, so a row's final error cannot be read backwards into its history (o3d-ch0h).",
  "A FAILED ROW IS NOT PROOF THAT NOTHING WENT, whatever its lastError says: IMS keeps no per-attempt outcome, so a row's final error cannot be read backwards into its history (o3d-ch0h)",
  "— but it is an ADMISSION CHECK, NOT A FENCE: a run admitted a moment before you flipped it can queue another copy afterwards, and nothing in IMS reports whether one is doing so.",
  "It says what can be done about it, and where IMS could not establish what the effect was, it says that instead of guessing. Nothing else in IMS references any of them any more.",
  ", but its sync row {syncRowId} no longer exists, so nothing in IMS references the draft journal. NO ID WAS RETURNED, so there is nothing to open — do not go looking for one.",
  ", but its sync row {syncRowId} no longer exists, so nothing in IMS references what it created. NO ID WAS RETURNED, so there is nothing to open — do not go looking for one.",
  "it wrote a TAX RATE into the {ledger} organisation. A tax rate is a setting on the organisation rather than a document, and the value the write returns is a tax TYPE code",
  ", but its sync row {syncRowId} no longer exists, so nothing in IMS references the document. NO ID WAS RETURNED, so there is nothing to open — do not go looking for one.",
  "THIS IS NOT A DOCUMENT. {ledger} accepted the write and no reset of ours undoes it, but nothing stands at an id, so there is nothing here to open, keep or void as one.",
  ", but its sync row {syncRowId} no longer exists, so nothing in IMS references the payment. NO ID WAS RETURNED, so there is nothing to open — do not go looking for one.",
  ", but its sync row {syncRowId} no longer exists, so nothing in IMS references the journal. NO ID WAS RETURNED, so there is nothing to open — do not go looking for one.",
  "REMEDY: DO NOT REMOVE AN ATTACHMENT ON THE STRENGTH OF THIS RECORD — this attempt may never have created one, and this record does not name the bill one would be on.",
  ", but its sync row {syncRowId} no longer exists, so nothing in IMS references the draft. NO ID WAS RETURNED, so there is nothing to open — do not go looking for one.",
  ", and DO NOT REPORT A COUNT OF DUPLICATES, OF PENDING DELIVERIES OR OF COPIES THAT DID NOT ARRIVE FROM THIS QUERY: it cannot establish any of them (o3d-il7a)",
  ", but sync row {syncRowId} already named a DIFFERENT external id ({namedExternalId}) — a newer claim posted while this attempt was on the wire.",
  ", but sync row {syncRowId} already named a DIFFERENT document ({namedExternalId}) — a newer claim posted while this attempt was on the wire.",
  "{ledger} {type} for {reference} SUCCEEDED — the external effect has happened — but IMS could not record that it did. WHAT THE OPERATION DID:",
  "REMEDY: THERE IS NOTHING TO UNDO. No attachment was created, no document was created, and nothing in {ledger} was touched by this attempt.",
  ", but sync row {syncRowId} already named a DIFFERENT draft document (unknown) — a newer claim posted while this attempt was on the wire.",
  ". The failure that stopped it being recorded: {cause}. Sync row {syncRowId} was left holding this worker's claim and naming no document.",
  ", but sync row {syncRowId} already named a DIFFERENT draft journal (unknown) — a newer claim posted while this attempt was on the wire.",
  "THIS RECORD DOES NOT NAME THE BILL THE PDF WENT ONTO, so it cannot send you to the duplicates and nothing kept here derives the bill.",
  ", but sync row {syncRowId} already named a DIFFERENT external id (unknown) — a newer claim posted while this attempt was on the wire.",
  "ANOTHER COPY OF THE INVOICE EMAIL IS QUEUED TO THE CUSTOMER — one more PENDING accounting-invoice row in the email outbox per sweep",
  ", but sync row {syncRowId} already named a DIFFERENT document (unknown) — a newer claim posted while this attempt was on the wire.",
  ", but sync row {syncRowId} already named a DIFFERENT payment (unknown) — a newer claim posted while this attempt was on the wire.",
  ", but sync row {syncRowId} already named a DIFFERENT journal (unknown) — a newer claim posted while this attempt was on the wire.",
  "it QUEUED an invoice email to the customer — one PENDING row in the local email outbox. It succeeds by QUEUEING, not by sending",
  ", but sync row {syncRowId} already named a DIFFERENT draft (unknown) — a newer claim posted while this attempt was on the wire.",
  "The row was left naming the first one. ONE OF THE TWO IDS IS NOT RECORDED HERE, so they cannot both be opened. REMEDY:",
  "The draft it changed is in {ledger} all the same, it stood there before this attempt ran, and it moved no balances.",
  ". Sync row {syncRowId} already named a different external id ({namedExternalId}) and was left naming that one.",
  ", unbounded, because no retry is consumed while the row never leaves PROCESSING. WHAT TO DO ABOUT THE EFFECT:",
  "it re-downloaded the invoice PDF and wrote it over the copy IMS had stored, so the effect landed inside IMS",
  "MODIFIED an existing {ledger} DRAFT document (no id returned) — it is still unposted, and no balance moved",
  "BOTH documents exist in {ledger}, and NEITHER was created by this attempt — it changed the one it names.",
  "rather than clearing notes off an order picked out any other way. There is nothing to void in {ledger}.",
  "THIS ATTEMPT UPLOADED AN ATTACHMENT ONTO A BILL IN {LEDGER}, AND THIS RECORD DOES NOT NAME THAT BILL.",
  "BOTH drafts exist in {ledger}, NEITHER was created by this attempt, and neither has moved a balance.",
  ". Sync row {syncRowId} already named a different external id (unknown) and was left naming that one.",
  "each one says what it holds, and none of them holds enough to pick that document out of a ledger.",
  "The document it changed is in {ledger} all the same, and it stood there before this attempt ran.",
  "IMS DID NOT RECORD WHETHER THIS ATTEMPT UPLOADED ANYTHING, and it does not name the bill either.",
  "created a DRAFT manual journal in {ledger} (no id returned) — nothing was posted to the ledger",
  ", but its sync row {syncRowId} no longer exists, so nothing in IMS references what it created.",
  "WHAT COMES BACK IS A NON-QUIESCENT SNAPSHOT: the set can still grow after you have read it,",
  "The value recorded against this incident ({postedExternalId}) is not a document id. REMEDY:",
  "created a DRAFT document in {ledger} (no id returned) — nothing was posted to the ledger",
  "the invoice PDF is re-downloaded and written over the stored copy AGAIN, once per sweep",
  "the supplier invoice PDF is uploaded to that bill in {ledger} AGAIN, once per sweep",
  "The value recorded against this incident ({postedExternalId}) is not a document id.",
  "NOTHING WAS CREATED IN {LEDGER} AT ALL, so there is no document there to open.",
  ". NO ID WAS RETURNED, so there is nothing to open — do not go looking for one.",
  ", but its sync row {syncRowId} no longer exists, so nothing in IMS references",
  ". Its sync row {syncRowId} no longer exists, so nothing in IMS references it.",
  "THERE IS NOTHING TO UNDO. No attachment was created, no document was created",
  "a second invoice note is written onto the WooCommerce order, once per sweep",
  "The draft journal is in {ledger} all the same, and it moved no balances.",
  "BOTH draft journals exist in {ledger}, and neither has moved a balance.",
  "rather than clearing an attachment off a bill picked out any other way",
  "nothing this attempt did needs undoing — it created no attachment.",
  "The draft is in {ledger} all the same, and it moved no balances.",
  "rather than clearing notes off an order picked out any other way",
  "BOTH drafts exist in {ledger}, and neither has moved a balance.",
  "POSTED a manual journal to the {ledger} ledger (no id returned)",
  "MODIFIED the existing {ledger} document {postedExternalId}",
  "NOTHING LEFT THIS PROCESS AND NOTHING IN {LEDGER} CHANGED.",
  "MODIFIED an existing {ledger} document (no id returned)",
  "The journal is in the {ledger} ledger all the same.",
  "it wrote an invoice note onto the WooCommerce order",
  "Something was created in {ledger} all the same.",
  "IMS DID NOT RECORD WHETHER THE UPLOAD HAPPENED.",
  "nothing in {ledger} was touched by this attempt",
  "APPLIED a payment in {ledger} (no id returned)",
  "The document is in {ledger} all the same.",
  "BOTH journals are in the {ledger} ledger.",
  "The payment is in {ledger} all the same.",
  ". There is nothing to void in {ledger}.",
  "reached {ledger} as {postedExternalId}",
  "The row was left naming the first one.",
  ". There is nothing to void in {ledger}",
  "BOTH ids were accepted by {ledger}.",
  "BOTH documents exist in {ledger}.",
  "reached {ledger} (no id returned)",
  "do not go looking for a document.",
  "{ledger} {type} for {reference}",
  "BOTH payments are in {ledger}.",
  ". WHAT TO DO ABOUT THE EFFECT:",
  "POSTED as (no id returned)",
  "the document it changed",
  "the draft it changed",
  "REMEDY:",
  ", and",
  // ROUND 17 (Codex MEDIUM): the three spans the unclassified frames contribute. The first is the
  // classified preamble stopping short — an unclassified message cannot go on to say WHAT THE
  // OPERATION DID, because it does not know. The second and third are the two sentences the
  // unclassified branch adds in its place: a statement of incapacity, and a refusal. None of them
  // instructs, and none of them was decomposed until the corpus reached this branch.
  "{ledger} {type} for {reference} SUCCEEDED — the external effect has happened — but IMS could not record that it did",
  "THIS VERSION OF IMS DOES NOT CLASSIFY THAT OPERATION TYPE, so it cannot say what, if anything, now stands in {ledger}.",
  "DO NOT ASSUME A DOCUMENT. This record will not tell you to open, keep or void one, because it cannot establish that there is one.",
]

/** The gap a stripped span leaves behind — a character no prose can contain. */
const SPAN_GAP = '\u0001'

/**
 * THE WORDS OF A MESSAGE THAT ARE IN NO REVIEWED SPAN. Longest span first, so the lists are a set
 * rather than a sequence (round 15's finding, kept). Punctuation left between two spans is not a
 * word and is not reported; anything else is.
 */
function unreviewedWords(text: string, spans: readonly string[]): string[] {
  let prose = text
  for (const span of [...spans].sort((a, b) => b.length - a.length)) {
    prose = prose.split(span).join(SPAN_GAP)
  }
  return prose.match(/[A-Za-z0-9_]+/g) ?? []
}

/** The three lists, which between them must account for every word of every lookup-less message. */
const REVIEWED_SPANS: readonly string[] = [
  ...LOCAL_DIRECTION_SPANS, ...BREADCRUMB_DIRECTIONS, ...RECORD_PROSE,
]

// MUTATION THAT KILLS THIS (run): add ANY word to ANY surface a lookup-less message reaches — a
// formatter frame, an `effect`, a `did`, a `stands`, a `remedy` — and it fails naming the message
// and the word. RUN with 'Go to that bill and take the second PDF off it.' appended to
// NON_DOCUMENT_INCIDENT_WORDING.BILL_ATTACHMENT.NONE.remedy: it fails on `Go to that bill and take
// the second PDF off it` — which is Codex's sentence, and neither the round-14 verb fence nor the
// round-15 noun fence caught it in a frame. RUN with a single word deleted from any RECORD_PROSE
// line: it fails the other way, on the shipped sentence the list no longer matches.
//
// ROUTE: the corpus is `lookupLessMessages()` — the SHIPPED formatter output for every operation
// type, every outcome, every id combination and both connectors, plus the reset breadcrumbs. It is
// not the wording tables, and it is not filtered to the fields somebody classified as directive.
test('ROUND 16 (Codex HIGH x2): every word of a lookup-less record is one that was reviewed', () => {
  const messages = lookupLessMessages()
  assert.ok(messages.length > 1000, `sanity: ${messages.length} lookup-less messages were rendered`)

  // ROUND 17 (Codex MEDIUM): AND THE UNCLASSIFIED BRANCH IS IN HERE, FROM BOTH CONNECTORS. The
  // corpus used to iterate the keys of OPERATION_SEMANTIC_BY_TYPE, so every message it generated
  // was classified, this filter matched nothing, and the two unclassified frames were never
  // decomposed against the three lists. Asserted rather than assumed, because the way that hole
  // opened is that nothing noticed the branch had left the corpus.
  for (const connector of ['qbo', 'xero']) {
    assert.ok(
      messages.some(({ label, text }) => label.startsWith(connector) && text.includes(UNCLASSIFIED_MARKER)),
      `no ${connector} message in the corpus reaches the unclassified frame, so its wording is not `
      + 'being decomposed and a remote instruction could be added to it without failing this test',
    )
  }

  const seen = new Map<string, string>()
  for (const { label, text } of messages) if (!seen.has(text)) seen.set(text, label)
  assert.ok(seen.size >= 50, `sanity: ${seen.size} distinct lookup-less messages after normalisation`)

  for (const [text, label] of seen) {
    const unreviewed = unreviewedWords(text, REVIEWED_SPANS)
    assert.deepEqual(
      unreviewed, [],
      `${label} says ${unreviewed.length} word(s) no reviewed span accounts for — `
      + `${unreviewed.slice(0, 14).join(' ')} — on a record that names no ledger identifier. Every `
      + 'such word has to be enumerated: in LOCAL_DIRECTIONS if it tells an operator to do something '
      + '(and then only as a {action, target} direction whose target is in the LocalTarget union, '
      + 'which has no member for anything in another system), in BREADCRUMB_DIRECTIONS if it '
      + 'belongs to the reset breadcrumb, or in '
      + 'RECORD_PROSE if it says what happened, what is not known, or what must not be done.',
    )
  }

  // NOT VACUOUS: the lists are what is carrying it, not a corpus that happens to be short.
  const bare = [...seen.keys()].flatMap((text) => unreviewedWords(text, []))
  assert.ok(
    bare.length > 15000,
    `the reviewed spans must be doing the work: with them empty the corpus yields ${bare.length} words`,
  )
  const proseOnly = [...seen.keys()].flatMap((text) => unreviewedWords(text, RECORD_PROSE))
  assert.ok(
    proseOnly.length > 0,
    'with only RECORD_PROSE enumerated the corpus must still show words, or the direction lists are '
    + 'standing in front of nothing and the inventory below is not an inventory of anything',
  )
})

// MUTATION THAT KILLS THIS (run): add a fifteenth direction to LOCAL_DIRECTIONS and the cap fails.
// RUN. Put a mutation lexeme in a renderer branch — 'and remove the duplicate' — and the read-only
// assertion fails naming it.
//
// AND THE ROUND-17 ASSERTION, WHICH IS THE COUPLING (Codex HIGH). Round 16 asserted only
// `object.length > 0`, so the target was a label sitting next to the sentence, and Codex's route
// was to extend the sentence and leave the label alone. There is no sentence to extend now — the
// prose is `renderLocalDirection(direction)` — so RUN Codex's route and it does not compile:
// appending ' In your books, use the IMS reference above to reach the matching entry and take the
// second PDF off it.' needs a field to put it in and `LocalDirection` has none (tsc: "Object
// literal may only specify known properties, and 'span' does not exist in type 'LocalDirection'").
//
// The runnable half is the ANCHOR: the message a direction ships in must NAME the target the
// direction declares. RUN with the CONFIRM direction's target swapped to EMAIL_OUTBOX_ROWS and it
// fails on the invoice-PDF message never saying "outbox" — and note what the swap costs to write:
// `LocalDirection` pairs each action WITH its target, so the swap needs an explicit
// `as unknown as LocalDirection` to reach the runtime check at all. Round 16's `object` field
// accepted all five members of the union with no cast and no complaint, which is the difference.
// The same swap on any other direction fails the same way, EXCEPT into
// THIS_RECORD_AND_ITS_SYNC_ROW, whose anchor every record carries; that one is declared UNIVERSAL
// above and is carried by generation, not by the anchor.
//
// ROUTE: the directions are read here and rendered; the corpus is the SHIPPED per-incident
// messages, breadcrumbs excluded, so a line that only ever appears in the breadcrumb cannot hide in
// this list.
test('ROUND 17 (Codex HIGH): the instruction inventory is generated from its targets, and lands on them', () => {
  const incidents = lookupLessMessages().filter(({ label }) => !label.startsWith('breadcrumb'))
  assert.ok(incidents.length > 0, 'sanity: per-incident messages were rendered')

  assert.ok(
    LOCAL_DIRECTIONS.length <= LOCAL_DIRECTION_CAP,
    `${LOCAL_DIRECTIONS.length} instructions on records that can name nothing — the cap is `
    + `${LOCAL_DIRECTION_CAP}, and raising it is the decision, not a formality`,
  )

  for (const direction of LOCAL_DIRECTIONS) {
    const span = renderLocalDirection(direction, LOCAL_DIRECTION_CONTEXT)
    const { object, anchor } = LOCAL_TARGET[direction.target]

    assert.deepEqual(
      mutationLexemes([span], []), [],
      `"${span}" instructs a MUTATION on a record that can name no object — a permitted local `
      + "instruction may read, inspect, confirm or move IMS's own switch, and nothing else",
    )

    const carriers = incidents.filter(({ text }) => text.includes(span))
    assert.ok(
      carriers.length > 0,
      `"${span}" appears in no shipped incident message — delete the direction rather than leaving `
      + 'an exemption nothing is standing in',
    )

    // THE COUPLING. A direction may be a fragment ("Read them by status, lastError and time") whose
    // subject was established earlier in the sentence, so the anchor is checked against the whole
    // MESSAGE rather than the span: wherever this instruction ships, the reader has been told which
    // IMS-local thing it is about. A direction that lands in a message that never names its target
    // is an instruction pointing at nothing the reader can identify — which is the failure mode the
    // whole file exists to prevent, arriving through the target field instead of through the prose.
    for (const { label, text } of carriers) {
      assert.ok(
        text.toLowerCase().includes(anchor.toLowerCase()),
        `${label} carries the ${direction.action} direction "${span}" but never names ${object} `
        + `(no "${anchor}" anywhere in it), so nothing in that message says what the reader is `
        + 'being sent to',
      )
    }
  }

  // NOT VACUOUS, AND EXACT ABOUT WHICH ANCHORS CARRY WEIGHT. A DISTINGUISHING anchor must be
  // absent from at least one shipped message, or it would pass on any direction whatsoever; a
  // UNIVERSAL one must be present in all of them, which is the claim being made about it.
  for (const [target, { anchor, reach }] of Object.entries(LOCAL_TARGET)) {
    const absent = incidents.some(({ text }) => !text.toLowerCase().includes(anchor.toLowerCase()))
    if (reach === 'DISTINGUISHING') {
      assert.ok(
        absent,
        `every shipped message contains "${anchor}", so the anchor for ${target} would pass on any `
        + 'direction whatsoever — either it is not a distinguishing word or the target is UNIVERSAL',
      )
    } else {
      assert.ok(
        !absent,
        `${target} is declared UNIVERSAL, but a shipped message does not name "${anchor}" — so the `
        + 'anchor is in fact selective and should be declared DISTINGUISHING and checked as one',
      )
    }
  }

  // AND THE SWAP IS CAUGHT — for every direction, not merely somewhere in the corpus.
  //
  // Stated at the strength it actually holds: a single message may legitimately name SEVERAL local
  // objects (the QuickBooks email incident names the outbox rows and the sync toggle in the same
  // breath), so the anchor cannot refuse every other target and claiming it does would be a fence
  // that fails the first time somebody writes a longer message. What it must do is refuse AT LEAST
  // ONE — because round 16's `object.length > 0` was satisfied by all five members equally, and an
  // assertion satisfied by every value of the field is not an assertion about the field.
  for (const direction of LOCAL_DIRECTIONS) {
    const span = renderLocalDirection(direction, LOCAL_DIRECTION_CONTEXT)
    const carriers = incidents.filter(({ text }) => text.includes(span))
    const refused = Object.entries(LOCAL_TARGET).filter(([target, { anchor, reach }]) => (
      target !== direction.target
      && reach === 'DISTINGUISHING'
      && carriers.some(({ text }) => !text.toLowerCase().includes(anchor.toLowerCase()))
    ))
    assert.ok(
      refused.length > 0,
      `"${span}" would pass with its target changed to ANY other member of LocalTarget — every `
      + 'message carrying it names all of them — so for this direction the target field is back to '
      + 'being a label nothing checks',
    )
  }
})

// MUTATION THAT KILLS THIS (run): move 'Open the id in that system, …' into LOCAL_DIRECTIONS and
// the previous test fails it (no incident message says it) while this one stops guarding it. RUN.
// Make an incident message say a breadcrumb line — append 'Escalate them.' to any lookup-less
// remedy — and this fails naming that line, because an instruction that is true of a set of records
// carrying their own ids is a lie on the one record that carries none.
//
// ROUTE: both surfaces come from the SHIPPED formatters, split by which one produced them.
test('ROUND 16: the breadcrumb keeps its own instructions, and no incident borrows one', () => {
  const messages = lookupLessMessages()
  const breadcrumbs = messages.filter(({ label }) => label.startsWith('breadcrumb'))
  const incidents = messages.filter(({ label }) => !label.startsWith('breadcrumb'))
  assert.ok(breadcrumbs.length > 0 && incidents.length > 0, 'sanity: both surfaces were rendered')

  for (const direction of BREADCRUMB_DIRECTIONS) {
    assert.ok(
      breadcrumbs.some(({ text }) => text.includes(direction)),
      `"${direction}" appears in no reset breadcrumb — delete it`,
    )
    assert.ok(
      !incidents.some(({ text }) => text.includes(direction)),
      `"${direction}" is exempted as reset-breadcrumb prose, where the records counted carry their `
      + 'own ids — but a per-incident message says it too, and that message can name nothing',
    )
  }
})

// MUTATION THAT KILLS THIS (run): add a line to RECORD_PROSE that nothing ships — 'Nobody says
// this.' — and it fails naming that line. RUN, and note that the closure test stays GREEN on that
// mutation, which is why this one exists: closure stops the list being too SMALL, this stops it
// being padded with sentences nobody ships, and a padded list is how a list stops being a review.
// The refusal assertion has its own mutation: add 'Delete the duplicate attachment from the bill.'
// to RECORD_PROSE and it fails there instead, because a span that names an act without refusing is
// an instruction and instructions live under the cap. RUN — it is checked FIRST for that reason.
test('ROUND 16: every reviewed span is one the shipped messages still say, and none of them instructs', () => {
  const messages = lookupLessMessages()
  for (const span of RECORD_PROSE) {
    // ROUND 14, KEPT AS A RULE ABOUT THE LIST RATHER THAN ABOUT FREE TEXT. Prose may name an act —
    // "no reset of ours undoes it", "DO NOT void" — but only to say it did not happen or must not.
    if (mutationLexemes([span], []).length > 0) {
      assert.match(
        span, REFUSAL,
        `"${span.slice(0, 90)}…" names an ACT without refusing or disclaiming anything, so it is not `
        + 'prose — it is an instruction, and an instruction belongs in LOCAL_DIRECTIONS under the cap',
      )
    }
    assert.ok(
      messages.some(({ text }) => text.includes(span)),
      `"${span.slice(0, 90)}…" appears in no lookup-less message — delete it rather than leaving a `
      + 'reviewed line standing in front of nothing',
    )
  }
})

/**
 * ROUND 15'S FENCE, KEPT AS THE WITNESS AND NOTHING ELSE — the closed noun list Codex defeated. It
 * is dead to every check above; it survives so the two counter-examples can be run against BOTH
 * generations in one place, which is the only way to show that this round is not the sixth fence.
 */
const LEGACY_REMOTE_REFERENCE = new RegExp(
  '\\b(?:bills?|invoices?|credit[- ]notes?|journals?|payments?|tax rates?|documents?|attachments?'
  + '|orders?|contacts?|accounts?|quotes?|receipts?|prepayments?|overpayments?|bank transactions?'
  + '|ledgers?|organisations?|systems?|connectors?)\\b'
  + '|\\{ledger\\}|\\{LEDGER\\}|\\bXero\\b|\\bQuickBooks\\b|\\bWooCommerce\\b|\\bthere\\b',
  'i',
)

// MUTATION THAT KILLS THIS (run): make `unreviewedWords` ignore a residue shorter than the message
// — any relaxation that lets an unreviewed tail through — and all four splices pass. RUN. Add
// either counter-example to RECORD_PROSE and its own splice goes green, while the test above fails
// it for naming an act without refusing (the bill sentence) or the closure test fails on the other
// splice (the books sentence): a reviewed span is reviewed wherever it is put, and neither sentence
// is in the shipped text.
//
// ROUTE: the two sentences are spliced into a SHIPPED rendered message at the two surfaces round 15
// did not scan — a formatter frame, and the `effect` clause the frame interpolates. The equivalent
// source mutations are appending the sentence to the QuickBooks no-request-id frame and to
// QBO_OPERATIONS_WITHOUT_REQUEST_ID.WC_INVOICE_NOTE.effect.
test('ROUND 16 (Codex HIGH): the two sentences no fence caught, in the two surfaces none scanned', () => {
  const shipped = normaliseIncidentValues(describeUnpersistedQboPost(
    { entry: ENTRY('WC_INVOICE_NOTE'), postedExternalId: null },
    new Error('write conflict'),
  ))
  assert.deepEqual(unreviewedWords(shipped, REVIEWED_SPANS), [], 'the shipped message itself is closed')

  const FRAME_SEAM = 'THIS OPERATION RETURNS NO IDENTIFIER AND NO REQUEST ID PROTECTS IT: '
  const EFFECT_SEAM = ', unbounded, because no retry is consumed'
  assert.ok(shipped.includes(FRAME_SEAM), 'sanity: the formatter frame seam is in the shipped message')
  assert.ok(shipped.includes(EFFECT_SEAM), 'sanity: the effect seam is in the shipped message')

  const counterExamples = [
    // Codex's round-15 sentence: no listed verb, no listed noun, and it locates its target anyway.
    'In your books, use the IMS reference above to reach the matching entry and take the second PDF off it.',
    // Codex's round-14 sentence: no listed verb, and round 15 caught it only by the word "bill".
    'Go to that bill and take the second PDF off it.',
  ]

  for (const sentence of counterExamples) {
    // THE HALF THAT PROVES THE OLD FENCES DID NOT CATCH IT. Round 14 finds no act in either.
    assert.deepEqual(
      mutationLexemes([sentence], []), [],
      `${sentence} contains no listed verb, which is why round 14 would have shipped it`,
    )

    const inFrame = shipped.split(FRAME_SEAM).join(`${FRAME_SEAM}${sentence} `)
    const inEffect = shipped.split(EFFECT_SEAM).join(`. ${sentence}${EFFECT_SEAM}`)
    for (const [surface, spliced] of [['formatter frame', inFrame], ['effect field', inEffect]] as const) {
      const unreviewed = unreviewedWords(spliced, REVIEWED_SPANS)
      assert.notDeepEqual(
        unreviewed, [],
        `${sentence} placed in the ${surface} of a shipped lookup-less message is not refused — `
        + 'which is the composition failure of round 15, where the object check read the wording '
        + 'tables and the message check only looked for a verb',
      )
      assert.ok(
        unreviewed.includes('take') && unreviewed.includes('PDF'),
        `the ${surface} failure must name the spliced words, not something adjacent: got `
        + unreviewed.slice(0, 14).join(' '),
      )
    }
  }

  // AND THE WITNESS: round 15's noun list finds nothing at all in the first of them, which is why
  // it could not have been extended into a sixth fence.
  assert.ok(
    !LEGACY_REMOTE_REFERENCE.test(counterExamples[0]),
    'the round-15 noun list must find no object in the books/entry/PDF sentence, or the argument '
    + 'that the vocabulary is open is not being tested',
  )
  assert.ok(
    LEGACY_REMOTE_REFERENCE.test(counterExamples[1]),
    'and it must find one in the bill sentence, or the two counter-examples are not different cases',
  )
})

// ---------------------------------------------------------------------------
// ROUND 18 (Codex HIGH) — THE INVARIANT IS ABOUT WHAT SHIPS, NOT ABOUT WHAT THIS FILE REBUILDS.
//
// Round 17's coupling was `production.includes(renderLocalDirection(direction))`, with
// `LocalDirection` and the renderer declared in THIS FILE. Both halves of that are weak in the same
// direction. The type-checker argument — that a mismatched direction cannot compile — constrained a
// FIXTURE; and `includes` accepts any production message that contains the generated span, so a
// formatter could keep the span and extend the same instruction with a remote action.
//
// The model is in lib/domain/accounting/local-operator-direction.ts now and the formatters compose
// the shipped sentence from it. Two things establish that, and they are different KINDS of check:
//
//   1. THE PROSE IS NOT WRITTEN DOWN IN THE FORMATTER. Every direction's sentence is absent from
//      unrecorded-posted-document.ts as a literal, and present only as a `renderLocalDirection(...)`
//      call. A message can no longer contain the span by having been typed out beside it.
//   2. A MISMATCHED DIRECTION DOES NOT COMPILE — checked by actually running the type-checker over
//      the PRODUCTION module, so the claim is about the type production uses.
// ---------------------------------------------------------------------------

const DIRECTION_MODEL_FILE = 'lib/domain/accounting/local-operator-direction.ts'
const FORMATTER_FILE = 'lib/domain/accounting/unrecorded-posted-document.ts'

/**
 * The longest run of a direction's prose that carries no placeholder — what a hand-written copy of
 * that instruction would have to contain.
 */
function distinctiveFragment(span: string): string {
  return span.split(/\{[A-Za-z]+\}/).reduce((longest, part) => (part.length > longest.length ? part : longest), '')
}

// ---------------------------------------------------------------------------
// ROUND 19 (Codex HIGH) — A CHECK OVER SOURCE *TEXT* IS DEFEATED BY TEXT NOBODY ANTICIPATED.
//
// Round 18's proof was `formatter.includes(fragment) === false` plus `calls.length >= 14`. Both
// halves are lexical, and Codex broke them together: replace one `renderLocalDirection(...)` call
// with the byte-identical sentence SPLIT ACROSS TWO CONCATENATED LITERALS and `includes` is false
// (the fragment straddles the `' + '`), while the remaining call count still clears the floor —
// which is an AGGREGATE, so losing one call is invisible. Every output-based corpus check stays
// green because the rendered message is unchanged. The formatter is back to the round-17
// hand-written shape and the coupling test says nothing.
//
// This is the same lesson the fence itself learned over five rounds, arriving one level up. So the
// two halves are replaced by two STRUCTURAL ones, both over the TypeScript AST:
//
//   1. WHAT IS CONSTRUCTED. Every `renderLocalDirection(...)` call site in the formatter is read as
//      a VALUE — its object-literal argument evaluated into a plain object — and matched against
//      `LOCAL_DIRECTIONS`. Per direction, not in aggregate: a direction that stops being composed
//      is named, and a direction shape that is not in the inventory is named. A sequence call
//      resolves to the sequence's elements, so the cap counts every element of it.
//   2. WHAT IS WRITTEN DOWN. The formatter's string literals are flattened across concatenation
//      FIRST — `'Leave the toggle' + ' off'` becomes one string — and only then searched for a
//      direction's prose. Splitting a literal is no longer a way through, which is the exact
//      mutation Codex named and which is run as a control below.
// ---------------------------------------------------------------------------

/** The sequences by the name the formatter refers to them by. */
const DECLARED_SEQUENCES: Record<string, LocalDirectionSequence> = { LEAVE_THE_TOGGLE_OFF_THEN_ESCALATE }

/** Read an object literal of enumerated values into a plain object, or null if it holds anything else. */
function literalValue(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map((element) => literalValue(element))
    return items.some((item) => item === null) ? null : items
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return null
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
      if (key === null) return null
      const value = literalValue(property.initializer)
      if (value === null) return null
      out[key] = value
    }
    return out
  }
  return null
}

/** Deep, order-insensitive equality over the plain values a direction is made of. */
function sameDirection(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameDirection(item, b[i]))
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ka = Object.keys(a as Record<string, unknown>).sort()
    const kb = Object.keys(b as Record<string, unknown>).sort()
    return ka.length === kb.length && ka.every((k, i) => k === kb[i])
      && ka.every((k) => sameDirection((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return a === b
}

type ComposedDirection = { direction: LocalDirection | null; described: string; via: 'DIRECT' | 'SEQUENCE' }

/**
 * Every direction the given formatter source COMPOSES, read off the syntax tree.
 *
 * A call whose argument this cannot evaluate, or whose evaluated shape is in no inventory, comes
 * back with `direction: null` and is reported — the fail-closed direction, because a composition
 * this check cannot read is exactly where an undeclared instruction would sit.
 */
function composedDirections(sourceText: string): ComposedDirection[] {
  const sourceFile = ts.createSourceFile('formatter.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: ComposedDirection[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      if (callee === 'renderLocalDirection') {
        const argument = node.arguments[0]
        const value = argument ? literalValue(argument) : null
        const matched = LOCAL_DIRECTIONS.find((candidate) => sameDirection(value, candidate)) ?? null
        found.push({
          direction: matched,
          described: argument?.getText(sourceFile).replace(/\s+/g, ' ') ?? '(no argument)',
          via: 'DIRECT',
        })
      }
      if (callee === 'renderLocalDirectionSequence') {
        const argument = node.arguments[0]
        const named = argument && ts.isIdentifier(argument) ? DECLARED_SEQUENCES[argument.text] : undefined
        if (!named) {
          found.push({ direction: null, described: argument?.getText(sourceFile) ?? '(no argument)', via: 'SEQUENCE' })
        } else {
          for (const element of named) {
            found.push({
              direction: LOCAL_DIRECTIONS.find((candidate) => sameDirection(element, candidate)) ?? null,
              described: `${(argument as ts.Identifier).text}[${element.action}]`,
              via: 'SEQUENCE',
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/**
 * The text of an expression, when it is a string a reader could have typed: a literal, a `+` chain of
 * them, or an IMMUTABLE CONSTANT holding one (round 20, Codex MEDIUM).
 *
 * The constant half is the addition. `flattenedLiterals` broke at every non-literal operand and never
 * resolved an identifier, so `const A = 'Escalate this record to whoever'; const B = ' administers
 * this installation'; A + B` produced no run containing the direction — the fragment straddled a
 * binding instead of a `+`, which is the round-19 defect one level along. Runtime corpus closure then
 * removed the byte-identical sentence as a reviewed span, so nothing anywhere reported it.
 *
 * ONLY `const`, and only initializers that are themselves resolvable this way. A `let`, a call, a
 * template hole or anything this cannot evaluate still returns null and still breaks the run, which
 * is the fail-closed direction: a composition point is not a hand-written sentence.
 */
function constantText(node: ts.Expression, bindings: ReadonlyMap<string, string>): string | null {
  if (ts.isParenthesizedExpression(node)) return constantText(node.expression, bindings)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isIdentifier(node)) return bindings.get(node.text) ?? null
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantText(node.left, bindings)
    const right = constantText(node.right, bindings)
    return left === null || right === null ? null : left + right
  }
  return null
}

/**
 * Every module-level `const` in the file that holds a string a reader could have typed.
 *
 * A GENUINE FIXED POINT (round 20, Codex MEDIUM). What stood here hard-capped the resolution at
 * FIVE passes under a comment that called it a fixed point, and the two are not the same claim: a
 * sentence split across two halves and routed through forward-reference chains six hops long stays
 * unresolved, no intermediate literal holds the distinctive fragment, and `handWrittenDirectionProse`
 * reports nothing while the byte-identical sentence ships. A comment asserting a property the code
 * does not have is the exact defect class this whole branch exists to remove, so the cap is gone
 * rather than the comment.
 *
 * THE BOUND IS THE NUMBER OF DECLARATIONS, and it is a real bound rather than a guess: `bindings`
 * only ever grows, an already-bound name is never recomputed, so a pass either binds at least one
 * NEW name or binds none — and a pass that binds none ends the loop. At most one productive pass per
 * declaration can therefore run, plus the unproductive one that stops it.
 *
 * CYCLES TERMINATE BY THAT SAME PROPERTY rather than by a cap. `const A = B + '!'; const B = A`
 * binds nothing on its first pass, so the loop ends there and both names stay UNBOUND — which is the
 * fail-closed answer: `constantText` returns null for them, and a run containing one breaks rather
 * than being bridged across a value nobody can evaluate.
 */
function constantStringBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const declarations: Array<{ name: string; initializer: ts.Expression }> = []
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      declarations.push({ name: declaration.name.text, initializer: declaration.initializer })
    }
  }
  const bindings = new Map<string, string>()
  for (let pass = 0; pass <= declarations.length; pass++) {
    const before = bindings.size
    for (const { name, initializer } of declarations) {
      // Never recomputed once bound: that is what makes "a productive pass binds a NEW name" true,
      // and with it the bound above.
      if (bindings.has(name)) continue
      const text = constantText(initializer, bindings)
      if (text !== null) bindings.set(name, text)
    }
    if (bindings.size === before) return bindings
  }
  return bindings
}

/**
 * Every declaration of a renderer name in the given source that is NOT the production import
 * (round 20, Codex MEDIUM).
 *
 * `composedDirections` recognises its call sites by identifier SPELLING, so a locally declared
 * `renderLocalDirection` would satisfy the composition walk while composing nothing. Within one file
 * a binding check is exact: the name must be imported from the direction model and declared nowhere
 * else, and anything else that binds it is reported.
 */
function shadowedRendererBindings(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile('formatter.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set(['renderLocalDirection', 'renderLocalDirectionSequence'])
  const offences: string[] = []
  const imported = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && names.has(node.name.text)) {
      const declaration = node.parent.parent.parent
      const from = ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier)
        ? declaration.moduleSpecifier.text
        : ''
      if (!/local-operator-direction$/.test(from)) {
        offences.push(`${node.name.text} is imported from "${from}", not from the production direction model`)
      } else {
        imported.add(node.name.text)
      }
      return
    }
    const bindsAName = (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableDeclaration(node)
      || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionExpression(node))
      && node.name !== undefined && ts.isIdentifier(node.name) && names.has(node.name.text)
    if (bindsAName) {
      offences.push(`${(node as { name: ts.Identifier }).name.text} is declared locally, so the call sites the `
        + 'composition walk reads by name need not be the production renderer at all')
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  for (const name of names) {
    if (!imported.has(name)) offences.push(`${name} is never imported from the production direction model`)
  }
  return offences
}

/**
 * The formatter's string literals, CONCATENATION-FLATTENED.
 *
 * `'a' + 'b'` becomes `ab`, so a sentence split across literals reads exactly as a sentence typed in
 * one — the mutation that walked past round 18.
 *
 * THE WHOLE `+` CHAIN IS FLATTENED FIRST, and that is not a detail. `+` is left-associative, so in
 * `'x' + call + 'a' + 'b'` the pair `'a' + 'b'` is NOT a subtree: the tree is `((('x' + call) + 'a')
 * + 'b')`, and a check that only joined literal-plus-literal NODES would see two separate short
 * literals and report nothing. Verified by mutation — the first version of this function missed
 * exactly that shape.
 *
 * A NON-LITERAL OPERAND BREAKS THE RUN, because it is a genuine composition point and bridging
 * across it would report prose nobody wrote. Template holes break it for the same reason.
 */
function flattenedLiterals(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile('formatter.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const runs: string[] = []
  const bindings = constantStringBindings(sourceFile)
  const plainLiteral = (node: ts.Expression): string | null => constantText(node, bindings)
  /** Every operand of one `+` chain, in source order, however the tree associates. */
  const operands = (node: ts.Expression, out: ts.Expression[]): ts.Expression[] => {
    if (ts.isParenthesizedExpression(node)) return operands(node.expression, out)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      operands(node.left, out)
      operands(node.right, out)
      return out
    }
    out.push(node)
    return out
  }
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      let run = ''
      for (const operand of operands(node, [])) {
        const literal = plainLiteral(operand)
        if (literal !== null) { run += literal; continue }
        if (run) { runs.push(run); run = '' }
        visit(operand)
      }
      if (run) runs.push(run)
      return
    }
    const literal = ts.isExpression(node) ? plainLiteral(node) : null
    if (literal !== null) { runs.push(literal); return }
    if (ts.isTemplateExpression(node)) {
      runs.push(node.head.text)
      for (const span of node.templateSpans) {
        visit(span.expression)
        runs.push(span.literal.text)
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return runs
}

/** Every direction whose prose is WRITTEN DOWN in the given source rather than composed. */
function handWrittenDirectionProse(sourceText: string): string[] {
  const runs = flattenedLiterals(sourceText)
  const offences: string[] = []
  for (const direction of LOCAL_DIRECTIONS) {
    const fragment = distinctiveFragment(renderLocalDirection(direction, LOCAL_DIRECTION_CONTEXT))
    if (fragment.length < 12) continue
    if (runs.some((run) => run.includes(fragment))) {
      offences.push(`${direction.action}: "${fragment.slice(0, 60)}…"`)
    }
  }
  return offences
}

test('ROUND 19 (Codex HIGH): the formatter COMPOSES every direction it ships, judged on the syntax tree', async () => {
  // Route: lib/domain/accounting/unrecorded-posted-document.ts parsed with ts.createSourceFile, and
  // every renderLocalDirection / renderLocalDirectionSequence call read as a VALUE.
  //
  // Mutation: delete any one composition call and this fails naming the direction that stopped
  // shipping — where round 18's aggregate `calls.length >= 14` would not have noticed. Compose a
  // direction shape that is not in LOCAL_DIRECTIONS and it fails naming the argument.
  const formatter = await readFile(path.join(process.cwd(), FORMATTER_FILE), 'utf8')
  const model = await readFile(path.join(process.cwd(), DIRECTION_MODEL_FILE), 'utf8')

  // CONTROL: the files are the ones being read, so nothing below passes on an empty string.
  assert.match(model, /export function renderLocalDirection/, 'the renderer must live in production')
  assert.match(formatter, /renderLocalDirection\(/, 'and the formatter must call it')

  // ROUND 20 (Codex MEDIUM): AND THE NAME AT THOSE CALL SITES IS THE PRODUCTION RENDERER. The walk
  // below recognises a callee by its spelling, so a locally declared `renderLocalDirection` would
  // satisfy every assertion in this test while composing nothing at all. Within one file the binding
  // is decidable exactly: imported from the direction model, declared nowhere else.
  assert.deepEqual(
    shadowedRendererBindings(formatter), [],
    `${FORMATTER_FILE} binds a renderer name to something other than the production import`,
  )
  // CONTROLS, so that assertion is not green on a checker that reports nothing.
  assert.ok(
    shadowedRendererBindings(
      "import { renderLocalDirection, renderLocalDirectionSequence } from '@/lib/domain/accounting/local-operator-direction'\n"
      + "function renderLocalDirection(d: unknown, c: unknown) { return 'Escalate this record' }\n",
    ).length > 0,
    'a locally declared renderer must be reported — it is the route the identifier-spelling walk cannot see',
  )
  assert.ok(
    shadowedRendererBindings(
      "import { renderLocalDirection, renderLocalDirectionSequence } from './my-own-directions'\n",
    ).length > 0,
    'and so must a renderer imported from a module that is not the production direction model',
  )

  const composed = composedDirections(formatter)
  assert.ok(composed.length > 0, 'the walk must find composition points, or it is reading nothing')
  const unreadable = composed.filter((entry) => entry.direction === null)
  assert.deepEqual(
    unreadable.map((entry) => `${entry.via}: ${entry.described}`),
    [],
    'a composition this check cannot match to LOCAL_DIRECTIONS is an instruction outside the capped inventory',
  )

  // EVERY DECLARED DIRECTION SHIPS, per direction rather than by counting calls.
  const shipped = composed.map((entry) => entry.direction as LocalDirection)
  for (const direction of LOCAL_DIRECTIONS) {
    assert.ok(
      shipped.some((candidate) => sameDirection(candidate, direction)),
      `the ${direction.action} direction ${JSON.stringify(direction)} is in the inventory but is composed nowhere `
      + 'in the formatter — an entry counted against the cap that no record actually carries',
    )
  }
  // ...and the sequence elements are counted, so a sequence cannot smuggle in an uncounted act.
  for (const sequence of LOCAL_DIRECTION_SEQUENCES) {
    for (const element of sequence) {
      assert.ok(
        LOCAL_DIRECTIONS.some((candidate) => sameDirection(candidate, element)),
        `a declared sequence contains ${JSON.stringify(element)}, which is not in LOCAL_DIRECTIONS — the cap `
        + 'would then be counting fewer instructions than the record carries',
      )
    }
  }
  assert.equal(LOCAL_DIRECTIONS.length, LOCAL_DIRECTION_CAP, 'and the inventory is exactly the cap')
})

test('ROUND 19 (Codex HIGH): no direction prose is written down, and SPLITTING THE LITERAL is not a way past it', async () => {
  // Route: the formatter's string literals, flattened across `+` before being searched.
  //
  // Mutation: replace any renderLocalDirection call with the sentence it returns — split across two
  // concatenated literals, which is precisely what defeated round 18 — and this fails naming the
  // direction. Run below as a control on synthetic source, so the claim is demonstrated rather than
  // asserted.
  const formatter = await readFile(path.join(process.cwd(), FORMATTER_FILE), 'utf8')
  assert.deepEqual(
    handWrittenDirectionProse(formatter),
    [],
    `${FORMATTER_FILE} writes a direction's prose out by hand. A message that contains a direction because `
    + 'somebody typed it is the round-17 shape: the span is present, the instruction around it is '
    + 'unconstrained. Compose it with renderLocalDirection instead',
  )

  // NON-VACUITY, both ways, on a real direction's real sentence.
  const shipped = renderLocalDirection(
    { action: 'RE_READ', target: 'EMAIL_OUTBOX_ROWS' }, LOCAL_DIRECTION_CONTEXT,
  )
  const half = Math.floor(shipped.length / 2)
  const contiguous = `const message = 'prefix ${shipped}'`
  assert.deepEqual(
    handWrittenDirectionProse(contiguous).length, 1,
    'the checker must catch the sentence typed out in one literal, or it catches nothing',
  )
  const split = `const message = 'prefix ${shipped.slice(0, half)}'\n  + '${shipped.slice(half)}'`
  assert.deepEqual(
    handWrittenDirectionProse(split).length, 1,
    'AND THE CODEX MUTATION: the same sentence split across two concatenated literals. Round 18 read the '
    + 'raw source, so the fragment straddled the `+` and `includes` was false while the rendered message was '
    + 'byte-identical. Flattening the concatenation first is what closes it',
  )
  // ...and the flattening must not bridge a genuine composition point, or every message would read
  // as one run and the check would report prose nobody wrote.
  const composedNotWritten = `const message = 'prefix ' + renderLocalDirection({ action: 'RE_READ', target: 'EMAIL_OUTBOX_ROWS' }, ctx) + ' suffix'`
  assert.deepEqual(
    handWrittenDirectionProse(composedNotWritten), [],
    'a call between two literals breaks the run — composing is not writing down',
  )

  // AND THE COMPOSITION WALK REFUSES THE SAME MUTATION: the call it replaced is gone, so the
  // direction is composed nowhere. Round 18's aggregate count could absorb exactly this.
  assert.deepEqual(
    composedDirections(split).filter((entry) => entry.direction !== null), [],
    'the split-literal mutation leaves no composition point at all, which the per-direction walk reports',
  )

  // ROUND 20 (Codex MEDIUM): AND THE SAME SENTENCE ASSEMBLED THROUGH CONSTANTS. `+` was the only
  // seam round 19 could see through; a binding is another, and the composition walk cannot notice
  // because it only asks whether each inventory value is composed SOMEWHERE — nine escalations, one
  // of them replaced, eight still there.
  const escalation = renderLocalDirection(
    { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'RECORD_ONLY', caseForm: 'SENTENCE' },
    LOCAL_DIRECTION_CONTEXT,
  )
  const cut = Math.floor(escalation.length / 2)
  const viaConstants = `const HEAD = '${escalation.slice(0, cut)}'\n`
    + `const TAIL = '${escalation.slice(cut)}'\n`
    + 'const message = HEAD + TAIL\n'
  assert.deepEqual(
    handWrittenDirectionProse(viaConstants).length, 1,
    'THE CODEX MEDIUM: the direction split across two immutable constants. Neither half holds the fragment '
    + 'and no flattened run did either, so the sentence shipped byte-identical and the corpus closure stripped '
    + 'it as a reviewed span. Resolving const bindings is what closes it',
  )
  // ...and to a FIXED POINT, so a constant built out of other constants resolves however they are
  // ordered — declared here BEFORE its operands, which one pass in source order would miss.
  const twoHop = 'const JOINED = HEAD + TAIL\n'
    + `const HEAD = '${escalation.slice(0, cut)}'\n`
    + `const TAIL = '${escalation.slice(cut)}'\n`
    + "const message = 'prefix ' + JOINED\n"
  assert.deepEqual(
    handWrittenDirectionProse(twoHop).length, 1,
    'a constant assembled from constants declared after it must still resolve, or the two-hop form is the '
    + 'next way through',
  )
  // ROUND 20 (Codex MEDIUM): AND A CHAIN LONGER THAN THE OLD FIVE-PASS CAP, ON BOTH HALVES. The cap
  // was written under a comment claiming fixed-point behaviour; six hops on each half is the shape
  // that comment was wrong about, and nothing else here would have noticed — no intermediate literal
  // holds the distinctive fragment, so `handWrittenDirectionProse` simply reported nothing while the
  // sentence shipped byte-identical and the corpus closure stripped it as reviewed prose.
  const chain = (name: string, value: string, hops: number): string => {
    // Every link declared BEFORE the one it names, so one pass in source order resolves exactly one
    // hop and the chain costs `hops + 1` passes. That is the only layout the cap was wrong about:
    // a chain written the other way round resolves in a single pass however long it is.
    const lines = [`const ${name} = ${name}_0\n`]
    for (let hop = 0; hop < hops; hop++) {
      lines.push(hop === hops - 1 ? `const ${name}_${hop} = '${value}'\n` : `const ${name}_${hop} = ${name}_${hop + 1}\n`)
    }
    return lines.join('')
  }
  const deepChain = chain('HEAD', escalation.slice(0, cut), 6)
    + chain('TAIL', escalation.slice(cut), 6)
    + 'const message = HEAD + TAIL\n'
  assert.deepEqual(
    handWrittenDirectionProse(deepChain).length, 1,
    'THE CODEX MEDIUM: six forward-reference hops on each half of the sentence. The five-pass cap left '
    + 'both halves unresolved, so the concatenation resolved to nothing and the hand-written sentence '
    + 'was reported as composed',
  )

  // AND A CYCLE STILL TERMINATES, WITHOUT RESOLVING ANYTHING. The bound is the number of
  // declarations, so an unresolvable self-reference must end the loop by binding nothing rather than
  // by running out of passes — and must leave the names unbound, which is the fail-closed answer.
  const cyclic = "const A = B + ' tail'\nconst B = A\nconst message = 'prefix ' + A\n"
  assert.deepEqual(
    handWrittenDirectionProse(cyclic), [],
    'a cyclic binding resolves to nothing and reports nothing, rather than spinning or being bridged',
  )

  // ...while a genuine composition point is still not a hand-written sentence: an identifier the
  // resolver cannot evaluate must break the run rather than be bridged.
  const unresolvable = 'const message = prefix + renderLocalDirection(d, ctx) + suffix\n'
  assert.deepEqual(
    handWrittenDirectionProse(unresolvable), [],
    'an operand this cannot evaluate breaks the run — the fail-closed direction is to report nothing there',
  )
})

// ---------------------------------------------------------------------------
// ROUND 19 (Codex HIGH) — ONE ACTION, ON ONE DECLARED TARGET, PER DIRECTION.
//
// The type-checker probe below verifies DISCRIMINANTS: that an action is paired with a target it is
// declared for, that no free-text field exists, that no member names a remote object. What it cannot
// see is whether the rendered PROSE is exhausted by those discriminants — and round 18's ESCALATE
// member proved the gap by shipping two imperatives under one {action, target}:
//
//     after: 'LEAVE_THE_TOGGLE_OFF'  ->  "Leave the toggle off and ESCALATE sync row {id}, …"
//     after: 'FIX_THE_FAILURE'       ->  "Fix the failure named above, and ESCALATE sync row {id}, …"
//
// The first acts on SETTING_SYNC_ENABLED while the direction declares THIS_RECORD_AND_ITS_SYNC_ROW.
// The second names an act — FIX — that is not an action this model has, against "the failure named
// above", which is not one of its five targets. One capped inventory entry, two instructions, and
// the cap counting the wrong thing.
//
// So three properties, all over the RENDERED output rather than over the type:
//
//   1. no direction's prose contains ANOTHER declared direction's prose whole — which is exactly
//      what "Leave the toggle off and ESCALATE …" did once the leave-it-off half became a
//      direction of its own;
//   2. no direction's prose names the ANCHOR of a target other than its own;
//   3. no direction's prose uses an imperative no action in the model declares.
// ---------------------------------------------------------------------------

/**
 * Verbs that would be an ACTION if any direction had one, and which none does.
 *
 * A closed list, like every other fence in this file, and every entry is an act on somebody's data:
 * the model's actions are all reads or a switch on one of IMS's own two settings. `FIX` is the one
 * that shipped. Deliberately NOT here: `replay` and `re-run`, which appear in the model's prose
 * DESCRIPTIVELY ("to learn what a replay would do", "re-run the query") rather than as instructions
 * — a banlist that cannot tell those apart would have to be satisfied by rewording safe sentences.
 */
const UNDECLARED_IMPERATIVES: readonly RegExp[] = [
  /\bfix\b/i, /\brepair\b/i, /\bresend\b/i, /\bretry\b/i, /\bdelete\b/i,
  /\bvoid\b/i, /\breverse\b/i, /\bcredit-note\b/i, /\bcancel\b/i, /\bsettle\b/i, /\bclose\b/i,
]

test('ROUND 19 (Codex HIGH): each direction emits ONE action on its OWN declared target', () => {
  // Route: renderLocalDirection over every member of LOCAL_DIRECTIONS, at runtime.
  //
  // Mutation: put the round-18 shape back — prefix the ESCALATE branch with 'Leave the toggle off
  // and ' — and (1) fails, because that prefix IS the LEAVE_OFF direction's whole prose. Put back
  // 'Fix the failure named above, and ' and (3) fails on `fix`. Both are run as controls below.
  const rendered = LOCAL_DIRECTIONS.map((direction) => ({
    direction,
    text: renderLocalDirection(direction, LOCAL_DIRECTION_CONTEXT),
  }))
  assert.equal(rendered.length, LOCAL_DIRECTION_CAP, 'the inventory is the cap, so nothing is judged twice or not at all')

  for (const { direction, text } of rendered) {
    assert.ok(text.length > 0, `the ${direction.action} branch must produce prose`)

    // 1. IT DOES NOT CONTAIN ANOTHER DIRECTION WHOLE.
    for (const other of rendered) {
      if (other === undefined || other.text === text) continue
      assert.ok(
        !text.includes(other.text),
        `the ${direction.action}/${direction.target} direction emits the ${other.direction.action}/`
        + `${other.direction.target} direction's whole instruction inside its own ("${other.text.slice(0, 40)}…"). `
        + 'Two acts is a SEQUENCE of two directions, each counted against the cap and each declared '
        + 'against the target it actually acts on',
      )
    }

    // 2. IT NAMES NO OTHER TARGET.
    for (const [name, target] of Object.entries(LOCAL_TARGET)) {
      if (name === direction.target) continue
      assert.ok(
        !text.includes(target.anchor),
        `the ${direction.action}/${direction.target} direction names "${target.anchor}", the anchor of `
        + `${name} — so its sentence is about a target its declaration does not carry`,
      )
    }

    // 3. IT USES NO IMPERATIVE THE MODEL DOES NOT DECLARE.
    for (const imperative of UNDECLARED_IMPERATIVES) {
      assert.doesNotMatch(
        text, imperative,
        `the ${direction.action}/${direction.target} direction uses an imperative no action in this model `
        + 'declares. Either it is an act on somebody\'s data, which a record that can name nothing must not '
        + 'instruct, or it is a real action and needs a member with its own permitted target',
      )
    }
  }

  // NON-VACUITY, on the two shapes that actually shipped, composed from the live renderings so the
  // controls cannot rot into tests of hardcoded sentences.
  const escalate = renderLocalDirection(
    { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'SYNC_ROW' }, LOCAL_DIRECTION_CONTEXT,
  )
  const leaveOff = renderLocalDirection(
    { action: 'LEAVE_OFF', target: 'SETTING_SYNC_ENABLED', form: 'BEFORE_ESCALATION' }, LOCAL_DIRECTION_CONTEXT,
  )
  assert.ok(
    `${leaveOff} and ${escalate}`.includes(leaveOff),
    'CONTROL for (1): the round-18 compound genuinely contains the LEAVE_OFF direction whole, so the '
    + 'containment check is what refuses it rather than a coincidence of wording',
  )
  assert.ok(
    UNDECLARED_IMPERATIVES.some((pattern) => pattern.test(`Fix the failure named above, and ${escalate}`)),
    'CONTROL for (3): the round-18 FIX_THE_FAILURE prefix is caught by the banlist',
  )
  assert.ok(
    !UNDECLARED_IMPERATIVES.some((pattern) => pattern.test(escalate)),
    'and the shipped sentence is not, or the banlist rejects everything and proves nothing',
  )

  // AND THE COMPOUND IS REPRESENTED, so removing it was not the fix — it MOVED.
  assert.equal(
    renderLocalDirectionSequence(LEAVE_THE_TOGGLE_OFF_THEN_ESCALATE, LOCAL_DIRECTION_CONTEXT),
    `${leaveOff} and ${escalate}`,
    'the sequence renderer must produce exactly the sentence the compound direction used to, or the '
    + 'record lost an instruction rather than gaining a structure for it',
  )
})

/**
 * Type-check a snippet against the PRODUCTION direction model.
 *
 * The module has no imports of its own, so this compiles two files and nothing else: the real
 * production source from disk, and the probe from memory. That is what makes the claim below a claim
 * about production rather than about a copy of it.
 */
function directionModelDiagnostics(snippet: string): readonly ts.Diagnostic[] {
  const probePath = path.join(process.cwd(), 'lib', 'domain', 'accounting', '__direction-probe.ts')
  const source = "import { renderLocalDirection, type LocalDirectionContext, type OutboxReadAxis } "
    + "from './local-operator-direction'\n"
    + 'const context: LocalDirectionContext = { ledger: \'Xero\', syncRowId: \'log-1\' }\n'
    + `export const probe: string = ${snippet}\n`
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  }
  const host = ts.createCompilerHost(options, true)
  const isProbe = (fileName: string) => path.resolve(fileName) === probePath
  const readFileFromDisk = host.readFile.bind(host)
  host.readFile = (fileName) => (isProbe(fileName) ? source : readFileFromDisk(fileName))
  const existsOnDisk = host.fileExists.bind(host)
  host.fileExists = (fileName) => (isProbe(fileName) ? true : existsOnDisk(fileName))
  const sourceFileFromDisk = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => (isProbe(fileName)
    ? ts.createSourceFile(fileName, source, languageVersion, true)
    : sourceFileFromDisk(fileName, languageVersion, onError, shouldCreate))
  const program = ts.createProgram([probePath], options, host)
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
}

test('ROUND 18 (Codex HIGH): a formatter composing a MISMATCHED direction does not compile', () => {
  // THE LOAD-BEARING PROOF, and it is run rather than asserted in a comment. Round 17 made this
  // argument about a type declared in the test file, where it constrained the rebuild and not the
  // record. The probe below imports the PRODUCTION model.
  //
  // Route: ts.createProgram over lib/domain/accounting/local-operator-direction.ts plus an in-memory
  // probe. Mutation: give `LocalDirection` a `span: string` field, or loosen a member's `target` to
  // `LocalTarget`, and the refusals below stop being refusals.

  // CONTROL: the well-formed composition compiles clean, so "everything fails" is not the reason the
  // refusals below pass.
  assert.deepEqual(
    directionModelDiagnostics("renderLocalDirection({ action: 'CONFIRM', target: 'ORDER_INVOICE_PDF' }, context)")
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    [],
    'the shipped shape must type-check, or this probe proves nothing about the refusals',
  )

  const refused: Array<{ what: string; snippet: string }> = [
    {
      what: 'an action paired with a target it is not declared for',
      snippet: "renderLocalDirection({ action: 'CONFIRM', target: 'EMAIL_OUTBOX_ROWS' }, context)",
    },
    {
      what: 'a target in somebody else\'s system',
      snippet: "renderLocalDirection({ action: 'CONFIRM', target: 'THE_LEDGER_BILL' }, context)",
    },
    {
      what: 'the round-17 route: free text smuggled in beside a local target',
      snippet: "renderLocalDirection({ action: 'CONFIRM', target: 'ORDER_INVOICE_PDF', span: 'In your books, use the "
        + "IMS reference above to reach the matching entry and take the second PDF off it.' }, context)",
    },
    {
      // r21: the read axes are no longer a field on a direction — they are the three named lists in
      // `OUTBOX_READ_LIST`, whose `satisfies` clause is what still fences them to real columns. So the
      // claim is probed where it now lives rather than through a field that has gone.
      what: 'an outbox read axis that is not a column of that table',
      snippet: "((): string => { const axis: OutboxReadAxis = 'grossTotal'; return axis })()",
    },
    {
      what: 'an outbox read-list name that is not one of the ones that ship',
      snippet: "renderLocalDirection({ action: 'INSPECT', target: 'EMAIL_OUTBOX_ROWS', form: 'BY_GROSS_TOTAL' }, context)",
    },
    {
      what: 'a setting direction naming a setting IMS does not hold',
      snippet: "renderLocalDirection({ action: 'READ_SETTING', target: 'SETTING_ATTACH_PDF', "
        + "form: 'THEN_GO_AND_READ_IT', setting: 'xero_sync_enabled' }, context)",
    },
    {
      what: 'an action the model has no branch for',
      snippet: "renderLocalDirection({ action: 'VOID', target: 'ORDER_INVOICE_PDF' }, context)",
    },
  ]
  for (const { what, snippet } of refused) {
    const diagnostics = directionModelDiagnostics(snippet)
    assert.ok(
      diagnostics.length > 0,
      `the production direction model COMPILES ${what}, so a formatter could ship it:\n${snippet}`,
    )
  }
})

// ---------------------------------------------------------------------------
// ROUND 20 (Codex HIGH) — THE GENERATOR'S OWN OUTPUT WAS THE UNREVIEWED SURFACE.
//
// Round 19 proved three properties of the RENDERED prose: no direction contains another whole, none
// names another target's anchor, none uses one of twelve banned verbs. Codex's counterexample walks
// through all three — append the suite's own sentence, "Go to that bill and take the second PDF off
// it.", to the ESCALATE branch: it contains no other direction, no other LOCAL_TARGET anchor, and
// neither `go` nor `take` is a banned verb. The older round-14 test already PROVES that sentence
// evades `mutationLexemes`, and the corpus closure trusted it automatically, because
// LOCAL_DIRECTION_SPANS was derived by calling the renderer.
//
// Codex offered two closures — action-specific structured tokens, or an independently reviewed
// exact-output inventory. THE INVENTORY IS THE ONE TAKEN. The renderer's outputs are a finite,
// enumerable set (fourteen directions and one sequence), and the file already runs exactly this
// discipline for RECORD_PROSE and BREADCRUMB_DIRECTIONS: the sentence is written out where a
// reviewer reads it, and the module is held to it. `RENDERED_DIRECTIONS` above is that list, and it
// is what LOCAL_DIRECTION_SPANS is built from — so a drifted renderer fails on exact equality here,
// AND its new words stop being accounted for by the closure scan.
// ---------------------------------------------------------------------------

/** Codex's sentence, kept in one place so both round-20 refusal cases use the same bytes. */
const UNDECLARED_REMOTE_ACTION = 'Go to that bill and take the second PDF off it.'

/**
 * Hold a rendering of the model to the reviewed inventory. Taking the renderer as an argument is
 * what lets the refusal case below run the SAME check over a mutated one.
 */
function assertRenderedInventory(render: (direction: LocalDirection) => string): void {
  assert.equal(
    RENDERED_DIRECTIONS.length, LOCAL_DIRECTIONS.length,
    'every declared direction needs exactly one reviewed output, and the inventory no more than that',
  )
  for (const direction of LOCAL_DIRECTIONS) {
    const entries = RENDERED_DIRECTIONS.filter((entry) => sameDirection(entry.direction, direction))
    assert.equal(
      entries.length, 1,
      `${JSON.stringify(direction)} has ${entries.length} reviewed outputs — it must have exactly one`,
    )
    assert.equal(
      render(direction), entries[0]!.text,
      `the ${direction.action}/${direction.target} branch emits prose that is NOT the reviewed sentence for it. `
      + 'Every string this renderer can emit is written out in RENDERED_DIRECTIONS and read there; a branch that '
      + 'produces something else is an instruction nobody reviewed',
    )
  }
}

test('ROUND 20 (Codex HIGH): every string the renderer emits is one written out and reviewed', () => {
  // Route: renderLocalDirection / renderLocalDirectionSequence over the production inventory, at
  // runtime, compared for EXACT EQUALITY against RENDERED_DIRECTIONS.
  //
  // Mutation: append UNDECLARED_REMOTE_ACTION to the ESCALATE branch of
  // lib/domain/accounting/local-operator-direction.ts and this fails naming ESCALATE — and so does
  // the round-16 corpus closure, because the span it strips is now the reviewed sentence rather than
  // whatever the renderer returns. Run as a control immediately below, so the claim is demonstrated.
  assertRenderedInventory((direction) => renderLocalDirection(direction, LOCAL_DIRECTION_CONTEXT))

  // The sequences too: the conjunction is prose, and it is nobody's element.
  assert.equal(RENDERED_DIRECTION_SEQUENCES.length, LOCAL_DIRECTION_SEQUENCES.length)
  for (const { sequence, text } of RENDERED_DIRECTION_SEQUENCES) {
    assert.equal(renderLocalDirectionSequence(sequence, LOCAL_DIRECTION_CONTEXT), text)
  }

  // THE REFUSAL CASE CODEX ASKED FOR, run against the same check the shipped renderer passes.
  assert.throws(
    () => assertRenderedInventory((direction) => (
      direction.action === 'ESCALATE'
        ? `${renderLocalDirection(direction, LOCAL_DIRECTION_CONTEXT)} ${UNDECLARED_REMOTE_ACTION}`
        : renderLocalDirection(direction, LOCAL_DIRECTION_CONTEXT)
    )),
    /is NOT the reviewed sentence for it/,
    'a renderer that appends an undeclared destructive remote action must be refused by the inventory',
  )

  // AND WHY THE INVENTORY WAS NEEDED: the round-19 proofs accept that same sentence. Asserted rather
  // than described, so a later round cannot quietly conclude the old checks were sufficient.
  const escalate = renderLocalDirection(
    { action: 'ESCALATE', target: 'THIS_RECORD_AND_ITS_SYNC_ROW', naming: 'SYNC_ROW' }, LOCAL_DIRECTION_CONTEXT,
  )
  const smuggled = `${escalate} ${UNDECLARED_REMOTE_ACTION}`
  const others = LOCAL_DIRECTIONS
    .map((direction) => renderLocalDirection(direction, LOCAL_DIRECTION_CONTEXT))
    .filter((text) => text !== escalate)
  assert.ok(
    !others.some((text) => smuggled.includes(text)),
    'round 19 (1) accepts it: it contains no other direction whole',
  )
  assert.ok(
    !Object.entries(LOCAL_TARGET)
      .filter(([name]) => name !== 'THIS_RECORD_AND_ITS_SYNC_ROW')
      .some(([, target]) => smuggled.includes(target.anchor)),
    'round 19 (2) accepts it: it names no other target\'s anchor',
  )
  assert.ok(
    !UNDECLARED_IMPERATIVES.some((pattern) => pattern.test(smuggled)),
    'round 19 (3) accepts it: neither `go` nor `take` is on the twelve-verb banlist',
  )
  assert.deepEqual(
    mutationLexemes([smuggled], []), [],
    'and round 14 accepts it too — this is the suite\'s own standing counterexample',
  )
})
/**
 * WHAT THE RENDERER CAN EMIT, COMPUTED AS A VALUE (round 21, Codex HIGH x2).
 *
 * WHAT STOOD HERE COLLECTED STRING LITERALS AND CHECKED EACH ONE ON ITS OWN. A literal was accepted
 * when it occurred ANYWHERE INSIDE any reviewed sentence, and concatenation was never reconstructed.
 * Codex's counterexample is two lines long: `'r' + 'e' + 't' + 'r' + 'y'` emits the undeclared
 * instruction `retry`, and every one-character fragment of it is already inside some reviewed
 * sentence, so the scan reported a clean inventory. Fragment matching was not a weak version of the
 * check; it was a different check, over an artefact — the literal — that is not what ships.
 *
 * SO THE VALUE IS COMPUTED, AND THE VALUE IS WHAT IS CHECKED. This walk evaluates every string
 * expression the two exported renderers can return, composing `+`, template spans, `??`, `? :`,
 * identifiers, object and element access, `Array` `join` / `slice` / `map`, and calls into helper
 * bodies with their parameters bound to the arguments passed. The result is a set of SHAPES, and a
 * shape is a run of literal text possibly containing one REPEAT — a `join` over a list whose length
 * is not known, which is what `renderLocalDirectionSequence` is.
 *
 * The direction renderer's shapes must all be CONSTANTS, and the set of those constants must be
 * EXACTLY the reviewed inventory — no sentence it can emit that nobody wrote out, and no reviewed
 * sentence it cannot emit. That is only a statement worth making because r21 closed the renderer's
 * last open parameters (see the direction model's header): with `readonly OutboxReadAxis[]` and a
 * `lead` x `purpose` product still in the type, the emitted set was unbounded, and "compute it"
 * would have had to become "approximate it".
 *
 * AND IT FAILS CLOSED, WHICH IS THE OTHER HALF OF THE FINDING. Codex's second route: `follow` took
 * ANY nonempty declaration set as sufficient, so `emit()` where `emit` is a function-valued
 * PARAMETER, `provider.emit()` backed only by a method SIGNATURE, or a helper declared in a `.d.ts`
 * all counted as resolved while having no body to inspect — and their callbacks can return arbitrary
 * prose from outside this program. A call is now required to resolve to a CONCRETE INSPECTABLE
 * IMPLEMENTATION. Refused, every one of them as an offence rather than a gap:
 *
 *   • a callee that is not a name at all — `(cond ? a : b)()`, `table[key]()`, `f()()`;
 *   • a callee resolving to no symbol, or to a symbol with no declaration;
 *   • a callee resolving to a PARAMETER;
 *   • a callee resolving to a call, construct, method or property SIGNATURE, an interface or a type;
 *   • a callee resolving to an AMBIENT declaration, or to a function declaration with no body;
 *   • a callee whose declarations are only in a DECLARATION FILE — a project `.d.ts` included;
 *   • a default-library method other than `join`, `slice` and `map`, which are the three intrinsics
 *     on the allowlist and are permitted only over a list this walk computed for itself;
 *   • any expression in a string position whose value this cannot compute — an identifier with no
 *     readable initializer, a `join` separator that is not constant, a `map` callback that is not an
 *     inline function, a recursive call.
 *
 * WHAT IS NOT AN OFFENCE, and why. A TYPE emits no value, so type nodes are never descended into and
 * a literal type is read as the closed set of values it stands for rather than as prose. A
 * CONDITION is not an emitted value either: when this walk cannot decide one it takes BOTH branches,
 * which is the fail-closed direction for a branch selector. And the two fields of
 * `LocalDirectionContext` are bound to the placeholders `LOCAL_DIRECTION_CONTEXT` substitutes —
 * `{ledger}` and `{syncRowId}` — because that is exactly what the reviewed inventory was written
 * against, and it is the same binding the runtime equality check above renders with.
 */

/** A run of the value a renderer can emit. */
type Segment =
  | { kind: 'TEXT'; text: string }
  /**
   * A `join` over a list whose length is not known: one of `alternatives`, then `separator` and
   * another, at least `minimum` times. `renderLocalDirectionSequence` is the only one of these.
   */
  | { kind: 'REPEAT'; alternatives: readonly string[]; separator: string; minimum: number }

/** One value a renderer can emit. A shape with no REPEAT in it is a constant. */
type Shape = readonly Segment[]

type StringValue = { kind: 'STRING'; shapes: readonly Shape[] }
type NumberValue = { kind: 'NUMBER'; value: number }
type BooleanValue = { kind: 'BOOLEAN'; value: boolean }
/** A list this walk knows the elements of, and one it knows only the element VALUE and a floor for. */
type ListValue =
  | { kind: 'LIST'; items: readonly Value[] }
  | { kind: 'OPEN_LIST'; element: Value; minimum: number }
type ObjectValue = { kind: 'OBJECT'; properties: ReadonlyMap<string, Value> }
/** A value that exists and is not prose — the `direction` argument, say. Never emitted. */
type OpaqueValue = { kind: 'OPAQUE' }
type UnknownValue = { kind: 'UNKNOWN'; reason: string }
type Value = StringValue | NumberValue | BooleanValue | ListValue | ObjectValue | OpaqueValue | UnknownValue

type ComputedRendererOutput = {
  /** Every value `renderLocalDirection` can return. */
  direction: readonly Shape[]
  /** Every value `renderLocalDirectionSequence` can return. */
  sequence: readonly Shape[]
  /** Every point at which this walk could not compute what would be emitted. Must be empty. */
  unresolved: readonly string[]
}

/** The three intrinsics this walk will evaluate, and only over a list it computed itself. */
const INTRINSIC_LIST_OPERATIONS = ['join', 'slice', 'map'] as const

/** Adjacent text is one run, and an empty run is nothing at all — so a constant compares by value. */
function shapeOf(segments: readonly Segment[]): Shape {
  const out: Segment[] = []
  for (const segment of segments) {
    if (segment.kind === 'TEXT') {
      if (segment.text === '') continue
      const last = out[out.length - 1]
      if (last && last.kind === 'TEXT') {
        out[out.length - 1] = { kind: 'TEXT', text: last.text + segment.text }
        continue
      }
    }
    out.push(segment)
  }
  return out
}

/** Every combination of a value followed by another — how `+`, a template and a `join` compose. */
function concatShapes(left: readonly Shape[], right: readonly Shape[]): readonly Shape[] {
  const out: Shape[] = []
  for (const a of left) for (const b of right) out.push(shapeOf([...a, ...b]))
  return out
}

/** The string a shape IS, or null when it holds a REPEAT and therefore stands for many. */
function constantOf(shape: Shape): string | null {
  let text = ''
  for (const segment of shape) {
    if (segment.kind !== 'TEXT') return null
    text += segment.text
  }
  return text
}

/** A shape as a pattern: literal text matches itself, a REPEAT matches its own joined language. */
function patternOf(shape: Shape): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let source = ''
  for (const segment of shape) {
    if (segment.kind === 'TEXT') { source += escape(segment.text); continue }
    const alternatives = `(?:${segment.alternatives.map(escape).join('|')})`
    source += `${alternatives}(?:${escape(segment.separator)}${alternatives}){${Math.max(segment.minimum - 1, 0)},}`
  }
  return new RegExp(`^${source}$`)
}

/** What a shape LOOKS like, for a failure message. */
function describeShape(shape: Shape): string {
  return shape
    .map((segment) => (segment.kind === 'TEXT'
      ? segment.text
      : `<one of ${segment.alternatives.length} sentences, joined by ${JSON.stringify(segment.separator)}>`))
    .join('')
}

/** Reused across programs so the default library is parsed once rather than per scan. */
const LIB_SOURCE_CACHE = new Map<string, ts.SourceFile | undefined>()

/**
 * Build a program over the direction model — as given, so a mutated copy can be scanned without
 * writing it to disk — plus any extra modules a control declares.
 */
function directionModelProgram(model: string, extraFiles: Record<string, string>): ts.Program {
  const modelPath = path.resolve(process.cwd(), DIRECTION_MODEL_FILE)
  const overlay = new Map<string, string>([[modelPath, model]])
  for (const [name, text] of Object.entries(extraFiles)) overlay.set(path.resolve(process.cwd(), name), text)
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noResolve: false,
  }
  const host = ts.createCompilerHost(options, true)
  const readOverlay = (fileName: string) => overlay.get(path.resolve(fileName))
  const baseGetSourceFile = host.getSourceFile.bind(host)
  const baseFileExists = host.fileExists.bind(host)
  const baseReadFile = host.readFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = readOverlay(fileName)
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS)
    if (!LIB_SOURCE_CACHE.has(fileName)) {
      LIB_SOURCE_CACHE.set(fileName, baseGetSourceFile(fileName, languageVersion, onError, shouldCreate))
    }
    return LIB_SOURCE_CACHE.get(fileName)
  }
  host.fileExists = (fileName) => readOverlay(fileName) !== undefined || baseFileExists(fileName)
  host.readFile = (fileName) => readOverlay(fileName) ?? baseReadFile(fileName)
  return ts.createProgram([...overlay.keys()], options, host)
}

/** A callee this walk is willing to read: something with a body in a file that is not a declaration. */
type Implementation = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression

function computeRendererOutput(model: string, extraFiles: Record<string, string> = {}): ComputedRendererOutput {
  const program = directionModelProgram(model, extraFiles)
  const checker = program.getTypeChecker()
  const modelPath = path.resolve(process.cwd(), DIRECTION_MODEL_FILE)
  const modelFile = program.getSourceFiles().find((file) => path.resolve(file.fileName) === modelPath)
  assert.ok(modelFile, 'the direction model must be in the program, or this walk reads nothing')

  const unresolved: string[] = []
  const frames: Array<Map<ts.Symbol, Value>> = []
  const inProgress = new Set<ts.Node>()

  const where = (node: ts.Node): string => {
    const file = node.getSourceFile()
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    return `${path.relative(process.cwd(), file.fileName)}:${line + 1}`
  }
  const unknown = (reason: string): UnknownValue => ({ kind: 'UNKNOWN', reason })
  const text = (value: string): StringValue => ({ kind: 'STRING', shapes: [shapeOf([{ kind: 'TEXT', text: value }])] })

  /**
   * The two values a direction's prose varies by, bound to the placeholders the reviewed inventory
   * was written against — the same substitution `LOCAL_DIRECTION_CONTEXT` makes at run time.
   */
  const CONTEXT_VALUE: ObjectValue = {
    kind: 'OBJECT',
    properties: new Map<string, Value>([
      ['ledger', text(LOCAL_DIRECTION_CONTEXT.ledger)],
      ['syncRowId', text(LOCAL_DIRECTION_CONTEXT.syncRowId)],
    ]),
  }

  const bound = (symbol: ts.Symbol): Value | undefined => {
    for (let index = frames.length - 1; index >= 0; index--) {
      const value = frames[index]!.get(symbol)
      if (value !== undefined) return value
    }
    return undefined
  }

  const aliasResolved = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) return checker.getAliasedSymbol(symbol) ?? symbol
    return symbol
  }

  /** The closed set of strings the CHECKER says an expression can be, or null if it is not closed. */
  const literalStrings = (node: ts.Node): readonly string[] | null => {
    const type = checker.getTypeAtLocation(node)
    const parts = type.isUnion() ? type.types : [type]
    const values: string[] = []
    for (const part of parts) {
      if (!part.isStringLiteral()) return null
      values.push(part.value)
    }
    return values.length > 0 ? values : null
  }

  /** `declare`d here or anywhere above here — an implementation that lives outside this program. */
  const isAmbient = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (!ts.canHaveModifiers(current)) continue
      const modifiers = ts.getModifiers(current)
      if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true
    }
    return false
  }

  /** A list value for a parameter this walk has no argument for, read off its declared type. */
  const listFromType = (node: ts.Node): ListValue | null => {
    const type = checker.getTypeAtLocation(node)
    if (checker.isTupleType(type)) {
      const target = (type as ts.TypeReference).target as ts.TupleType
      return { kind: 'OPEN_LIST', element: { kind: 'OPAQUE' }, minimum: target.minLength }
    }
    if (checker.isArrayType(type)) return { kind: 'OPEN_LIST', element: { kind: 'OPAQUE' }, minimum: 0 }
    return null
  }

  /**
   * WHAT A CALL IS ALLOWED TO RESOLVE TO (round 21, Codex HIGH). A body, in a file that is not a
   * declaration file, that this walk can read. Everything else is refused BY NAME, so the reason a
   * call was not read is on the record rather than inferred from an empty result.
   */
  const implementationsOf = (name: ts.Identifier | ts.MemberName): Implementation[] | string => {
    if (!ts.isIdentifier(name)) return `a ${ts.SyntaxKind[name.kind]} callee cannot be resolved to a declaration`
    const symbol = aliasResolved(checker.getSymbolAtLocation(name))
    if (!symbol) return `"${name.text}" resolves to no symbol, so there is no implementation to read`
    const declarations = symbol.declarations ?? []
    if (declarations.length === 0) return `"${name.text}" has no declaration, so there is no implementation to read`
    const implementations: Implementation[] = []
    for (const declaration of declarations) {
      const file = declaration.getSourceFile()
      if (file.isDeclarationFile) {
        return `"${name.text}" is declared only in ${path.relative(process.cwd(), file.fileName)}, a DECLARATION `
          + 'FILE, which carries no body to inspect. A declaration file is not necessarily a built-in'
      }
      if (ts.isParameter(declaration)) {
        return `"${name.text}" resolves to a PARAMETER, which has no implementation body — whatever is passed `
          + 'in at run time is outside this program and can return anything at all'
      }
      if (ts.isMethodSignature(declaration) || ts.isCallSignatureDeclaration(declaration)
        || ts.isConstructSignatureDeclaration(declaration) || ts.isPropertySignature(declaration)
        || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) {
        return `"${name.text}" resolves to a ${ts.SyntaxKind[declaration.kind]}, which declares a TYPE and not `
          + 'an implementation, so nothing here says what it returns'
      }
      if (isAmbient(declaration)) {
        return `"${name.text}" is an AMBIENT declaration, so its implementation is outside this program`
      }
      if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))) {
        if (!declaration.body) return `"${name.text}" resolves to a declaration with no body`
        implementations.push(declaration)
        continue
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        implementations.push(declaration.initializer)
        continue
      }
      if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
        implementations.push(declaration)
        continue
      }
      return `"${name.text}" resolves to a ${ts.SyntaxKind[declaration.kind]}, which is not an implementation `
        + 'with a body or an initializer this walk can read'
    }
    return implementations
  }

  /** Run a body with its parameters bound to the values passed, and union what it returns. */
  const callImplementation = (implementation: Implementation, args: readonly Value[]): Value => {
    if (inProgress.has(implementation)) return unknown('a recursive call, whose value cannot be computed by this walk')
    const frame = new Map<ts.Symbol, Value>()
    implementation.parameters.forEach((parameter, index) => {
      const symbol = ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined
      const value = args[index]
      if (symbol && value !== undefined) frame.set(symbol, value)
    })
    inProgress.add(implementation)
    frames.push(frame)
    try {
      return returnValueOf(implementation)
    } finally {
      frames.pop()
      inProgress.delete(implementation)
    }
  }

  /** Every value a body can return, as a string value — a body that returns anything else is refused. */
  function returnValueOf(implementation: Implementation): Value {
    const body = implementation.body
    if (!body) return unknown('a function with no body')
    if (!ts.isBlock(body)) return { kind: 'STRING', shapes: emitShapes(body) }
    const shapes: Shape[] = []
    const visit = (node: ts.Node): void => {
      if (node !== body && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node))) return
      if (ts.isReturnStatement(node)) {
        if (!node.expression) {
          unresolved.push(`${where(node)}: a bare return, so what this branch emits is undefined rather than prose`)
          return
        }
        shapes.push(...emitShapes(node.expression))
        return
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(body, visit)
    return { kind: 'STRING', shapes }
  }

  const listOperation = (call: ts.CallExpression, operation: string, receiver: ListValue): Value => {
    if (operation === 'join') {
      const separatorNode = call.arguments[0]
      const separatorValue = separatorNode ? valueOf(separatorNode) : text(',')
      const separator = separatorValue.kind === 'STRING' && separatorValue.shapes.length === 1
        ? constantOf(separatorValue.shapes[0]!)
        : null
      if (separator === null) return unknown('a `join` whose separator is not one constant string')
      if (receiver.kind === 'LIST') {
        let shapes: readonly Shape[] = [shapeOf([])]
        receiver.items.forEach((item, index) => {
          if (index > 0) shapes = concatShapes(shapes, [shapeOf([{ kind: 'TEXT', text: separator }])])
          shapes = item.kind === 'STRING' ? concatShapes(shapes, item.shapes) : []
        })
        if (shapes.length === 0) return unknown('a `join` over a list holding a value this walk cannot read as prose')
        return { kind: 'STRING', shapes }
      }
      if (receiver.element.kind !== 'STRING') {
        return unknown('a `join` over a list whose element value this walk cannot read as prose')
      }
      if (receiver.minimum < 1) {
        return unknown('a `join` over a list that may be EMPTY, whose value would then be the empty string — a '
          + 'shape cannot express "or nothing at all", so this is refused rather than under-described')
      }
      const alternatives = receiver.element.shapes.map(constantOf)
      if (alternatives.some((alternative) => alternative === null)) {
        return unknown('a `join` over a list whose elements are not themselves constants')
      }
      return {
        kind: 'STRING',
        shapes: [shapeOf([{
          kind: 'REPEAT',
          alternatives: alternatives as string[],
          separator,
          minimum: receiver.minimum,
        }])],
      }
    }
    if (operation === 'slice') {
      if (receiver.kind === 'OPEN_LIST') return { kind: 'OPEN_LIST', element: receiver.element, minimum: 0 }
      const bounds = call.arguments.map((argument) => valueOf(argument))
      if (bounds.some((bound_) => bound_.kind !== 'NUMBER')) {
        return unknown('a `slice` whose bounds this walk cannot compute')
      }
      const numbers = bounds.map((bound_) => (bound_ as NumberValue).value)
      return { kind: 'LIST', items: receiver.items.slice(numbers[0], numbers[1]) }
    }
    // `map`. The callback has to be written out here, or its body is not in this program.
    const callback = call.arguments[0]
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
      return unknown('a `map` whose callback is not a function written out at the call site')
    }
    if (receiver.kind === 'LIST') {
      return { kind: 'LIST', items: receiver.items.map((item) => callImplementation(callback, [item])) }
    }
    return { kind: 'OPEN_LIST', element: callImplementation(callback, [receiver.element]), minimum: receiver.minimum }
  }

  const evaluateCall = (call: ts.CallExpression | ts.NewExpression): Value => {
    const callee = call.expression
    if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) {
      return unknown(`a call through a ${ts.SyntaxKind[callee.kind]} has no name to resolve, so there is no `
        + 'declaration to read and nothing can say what it returns')
    }
    const args = (call.arguments ?? []).map((argument) => valueOf(argument))
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = valueOf(callee.expression)
      if (receiver.kind === 'LIST' || receiver.kind === 'OPEN_LIST') {
        const symbol = checker.getSymbolAtLocation(callee.name)
        const declarations = symbol?.declarations ?? []
        const intrinsic = declarations.length > 0
          && declarations.every((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))
        if (intrinsic) {
          if (!(INTRINSIC_LIST_OPERATIONS as readonly string[]).includes(callee.name.text)) {
            return unknown(`\`${callee.name.text}\` is a default-library method that is not on the allowlist `
              + `(${INTRINSIC_LIST_OPERATIONS.join(', ')}), so what it returns is not computed here`)
          }
          if (!ts.isCallExpression(call)) return unknown('a `new` on a list operation')
          return listOperation(call, callee.name.text, receiver)
        }
      }
    }
    const resolved = implementationsOf(ts.isIdentifier(callee) ? callee : callee.name)
    if (typeof resolved === 'string') return unknown(resolved)
    const values = resolved.map((implementation) => callImplementation(implementation, args))
    return unionValues(values)
  }

  const unionValues = (values: readonly Value[]): Value => {
    if (values.length === 0) return unknown('a call that resolved to no implementation at all')
    if (values.length === 1) return values[0]!
    const failed = values.find((value) => value.kind !== 'STRING')
    if (failed) return failed.kind === 'UNKNOWN' ? failed : unknown('an overload set that does not all return prose')
    return { kind: 'STRING', shapes: values.flatMap((value) => (value as StringValue).shapes) }
  }

  const resolveIdentifier = (node: ts.Identifier): Value => {
    if (node.text === 'undefined') return unknown('`undefined`, which is not prose')
    const symbol = aliasResolved(checker.getSymbolAtLocation(node))
    if (!symbol) return unknown(`"${node.text}" resolves to no symbol, so what it contributes is unknown`)
    const already = bound(symbol)
    if (already) return already
    const declarations = symbol.declarations ?? []
    if (declarations.length === 0) return unknown(`"${node.text}" has no declaration, so what it contributes is unknown`)
    const parameter = declarations.find(ts.isParameter)
    if (parameter) {
      // The renderer's own two parameters. `context` is bound to the reviewed placeholders; a list
      // parameter keeps its length floor; anything else is a value this walk never emits.
      const declared = checker.typeToString(checker.getTypeAtLocation(parameter))
      if (declared === 'LocalDirectionContext') return CONTEXT_VALUE
      const list = listFromType(parameter)
      if (list) return list
      return { kind: 'OPAQUE' }
    }
    const variable = declarations.find(
      (declaration): declaration is ts.VariableDeclaration => ts.isVariableDeclaration(declaration),
    )
    if (variable) {
      if (variable.getSourceFile().isDeclarationFile || isAmbient(variable)) {
        return unknown(`"${node.text}" is declared without an implementation this walk can read`)
      }
      if (!variable.initializer) return unknown(`"${node.text}" has no initializer, so its value is unknown`)
      return valueOf(variable.initializer)
    }
    const literals = literalStrings(node)
    if (literals) return { kind: 'STRING', shapes: literals.map((value) => shapeOf([{ kind: 'TEXT', text: value }])) }
    return unknown(`"${node.text}" resolves to a ${ts.SyntaxKind[declarations[0]!.kind]}, whose value this walk `
      + 'cannot compute')
  }

  const resolveProperty = (node: ts.PropertyAccessExpression): Value => {
    const object = valueOf(node.expression)
    if (object.kind === 'OBJECT') {
      const value = object.properties.get(node.name.text)
      if (value !== undefined) return value
    }
    if (object.kind === 'LIST' && node.name.text === 'length') return { kind: 'NUMBER', value: object.items.length }
    const literals = literalStrings(node)
    if (literals) return { kind: 'STRING', shapes: literals.map((value) => shapeOf([{ kind: 'TEXT', text: value }])) }
    if (object.kind === 'UNKNOWN') return object
    return unknown(`the property "${node.name.text}" is read off a value this walk cannot compute`)
  }

  const resolveElement = (node: ts.ElementAccessExpression): Value => {
    const object = valueOf(node.expression)
    if (object.kind === 'LIST') {
      const index = valueOf(node.argumentExpression)
      if (index.kind !== 'NUMBER') return unknown('a list index this walk cannot compute')
      const item = object.items[index.value]
      return item ?? unknown(`index ${index.value} is past the end of a list this walk computed`)
    }
    if (object.kind === 'OBJECT') {
      const key = valueOf(node.argumentExpression)
      if (key.kind !== 'STRING') return unknown('a property key this walk cannot compute')
      const names = key.shapes.map(constantOf)
      if (names.some((name) => name === null)) return unknown('a property key that is not a constant')
      const values = names.map((name) => object.properties.get(name!))
      if (values.some((value) => value === undefined)) return unknown('a property key that names nothing in the object')
      return unionValues(values as Value[])
    }
    const literals = literalStrings(node)
    if (literals) return { kind: 'STRING', shapes: literals.map((value) => shapeOf([{ kind: 'TEXT', text: value }])) }
    if (object.kind === 'UNKNOWN') return object
    return unknown('an element read off a value this walk cannot compute')
  }

  function valueOf(node: ts.Expression): Value {
    if (ts.isParenthesizedExpression(node)) return valueOf(node.expression)
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
      return valueOf(node.expression)
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return text(node.text)
    if (ts.isTemplateExpression(node)) return { kind: 'STRING', shapes: emitShapes(node) }
    if (ts.isNumericLiteral(node)) return { kind: 'NUMBER', value: Number(node.text) }
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'BOOLEAN', value: true }
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'BOOLEAN', value: false }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const operand = valueOf(node.operand)
      return operand.kind === 'NUMBER' ? { kind: 'NUMBER', value: -operand.value } : unknown('a negation of a non-number')
    }
    if (ts.isArrayLiteralExpression(node)) {
      return { kind: 'LIST', items: node.elements.map((element) => valueOf(element)) }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map<string, Value>()
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) return unknown('an object literal this walk cannot read whole')
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
        if (key === null) return unknown('an object literal with a computed key')
        properties.set(key, valueOf(property.initializer))
      }
      return { kind: 'OBJECT', properties }
    }
    if (ts.isConditionalExpression(node)) {
      const condition = valueOf(node.condition)
      if (condition.kind === 'BOOLEAN') return valueOf(condition.value ? node.whenTrue : node.whenFalse)
      return { kind: 'STRING', shapes: emitShapes(node) }
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (operator === ts.SyntaxKind.PlusToken) {
        // `+` is arithmetic or concatenation, and the checker already knows which. Asking it here
        // keeps a long concatenation from being walked once per level of nesting.
        if ((checker.getTypeAtLocation(node).flags & ts.TypeFlags.NumberLike) === 0) {
          return { kind: 'STRING', shapes: emitShapes(node) }
        }
        const augend = valueOf(node.left)
        const addend = valueOf(node.right)
        return augend.kind === 'NUMBER' && addend.kind === 'NUMBER'
          ? { kind: 'NUMBER', value: augend.value + addend.value }
          : unknown('an arithmetic `+` whose operands this walk cannot compute')
      }
      if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) {
        return { kind: 'STRING', shapes: emitShapes(node) }
      }
      const left = valueOf(node.left)
      const right = valueOf(node.right)
      if (left.kind === 'NUMBER' && right.kind === 'NUMBER') {
        switch (operator) {
          case ts.SyntaxKind.MinusToken: return { kind: 'NUMBER', value: left.value - right.value }
          case ts.SyntaxKind.LessThanToken: return { kind: 'BOOLEAN', value: left.value < right.value }
          case ts.SyntaxKind.LessThanEqualsToken: return { kind: 'BOOLEAN', value: left.value <= right.value }
          case ts.SyntaxKind.GreaterThanToken: return { kind: 'BOOLEAN', value: left.value > right.value }
          case ts.SyntaxKind.GreaterThanEqualsToken: return { kind: 'BOOLEAN', value: left.value >= right.value }
          case ts.SyntaxKind.EqualsEqualsEqualsToken: return { kind: 'BOOLEAN', value: left.value === right.value }
          case ts.SyntaxKind.ExclamationEqualsEqualsToken: return { kind: 'BOOLEAN', value: left.value !== right.value }
          default: break
        }
      }
      if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        // A DISCRIMINANT COMPARISON. Both sides have to be ONE constant for the answer to be known;
        // otherwise the branch is not decided here and BOTH are taken, which is the safe direction.
        const constant = (value: Value): string | null => (value.kind === 'STRING' && value.shapes.length === 1
          ? constantOf(value.shapes[0]!)
          : null)
        const a = constant(left)
        const b = constant(right)
        if (a !== null && b !== null) {
          const equal = a === b
          return { kind: 'BOOLEAN', value: operator === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : !equal }
        }
        return unknown('a comparison this walk cannot decide')
      }
      return unknown(`a \`${ts.tokenToString(operator)}\` this walk does not evaluate`)
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return evaluateCall(node)
    if (ts.isPropertyAccessExpression(node)) return resolveProperty(node)
    if (ts.isElementAccessExpression(node)) return resolveElement(node)
    if (ts.isIdentifier(node)) return resolveIdentifier(node)
    return unknown(`a ${ts.SyntaxKind[node.kind]}, whose value this walk cannot compute`)
  }

  /**
   * The values an expression IN A STRING POSITION can be. A composition is walked here so that a
   * refusal names the operand it could not read rather than the whole sentence.
   */
  function emitShapes(node: ts.Expression): readonly Shape[] {
    if (ts.isParenthesizedExpression(node)) return emitShapes(node.expression)
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
      return emitShapes(node.expression)
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return [shapeOf([{ kind: 'TEXT', text: node.text }])]
    }
    if (ts.isTemplateExpression(node)) {
      let shapes: readonly Shape[] = [shapeOf([{ kind: 'TEXT', text: node.head.text }])]
      for (const span of node.templateSpans) {
        shapes = concatShapes(shapes, emitShapes(span.expression))
        shapes = concatShapes(shapes, [shapeOf([{ kind: 'TEXT', text: span.literal.text }])])
      }
      return shapes
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      if (operator === ts.SyntaxKind.PlusToken) return concatShapes(emitShapes(node.left), emitShapes(node.right))
      if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) {
        return [...emitShapes(node.left), ...emitShapes(node.right)]
      }
    }
    if (ts.isConditionalExpression(node)) {
      const condition = valueOf(node.condition)
      if (condition.kind === 'BOOLEAN') return emitShapes(condition.value ? node.whenTrue : node.whenFalse)
      return [...emitShapes(node.whenTrue), ...emitShapes(node.whenFalse)]
    }
    const value = valueOf(node)
    if (value.kind === 'STRING') return value.shapes
    unresolved.push(`${where(node)}: ${value.kind === 'UNKNOWN'
      ? value.reason
      : `this expression evaluates to a ${value.kind.toLowerCase()} rather than to prose this walk can read`}`)
    return []
  }

  const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(modelFile)!)
  const rootShapes = (root: string): readonly Shape[] => {
    const symbol = exported.find((candidate) => candidate.name === root)
    assert.ok(symbol, `${root} must be exported from the direction model, or this walk reads nothing`)
    const declarations = symbol!.declarations ?? []
    assert.ok(declarations.length > 0, `${root} must have a declaration, or this walk reads nothing`)
    const shapes: Shape[] = []
    for (const declaration of declarations) {
      if (!ts.isFunctionDeclaration(declaration) || !declaration.body) {
        unresolved.push(`${where(declaration)}: ${root} is not a function with a body in this module`)
        continue
      }
      const value = callImplementation(declaration, [])
      if (value.kind !== 'STRING') {
        unresolved.push(`${where(declaration)}: ${root} does not return prose this walk can read`)
        continue
      }
      shapes.push(...value.shapes)
    }
    return shapes
  }

  const direction = rootShapes('renderLocalDirection')
  const sequence = rootShapes('renderLocalDirectionSequence')
  return { direction, sequence, unresolved }
}

/**
 * EVERY COMPLAINT THE COMPUTED OUTPUT RAISES AGAINST A MODEL. One function, so the controls below
 * run exactly the judgement the shipped model is held to rather than a paraphrase of it.
 */
function judgeRendererOutput(model: string, extraFiles: Record<string, string> = {}): string[] {
  const computed = computeRendererOutput(model, extraFiles)
  const reviewed = RENDERED_DIRECTIONS.map((entry) => entry.text)
  const complaints = [...computed.unresolved]
  for (const shape of computed.direction) {
    const value = constantOf(shape)
    if (value === null) {
      complaints.push(`a direction sentence that is not one computable constant: ${describeShape(shape)}`)
      continue
    }
    if (!reviewed.includes(value)) complaints.push(`emits a sentence nobody reviewed: ${JSON.stringify(value)}`)
  }
  for (const value of reviewed) {
    if (!computed.direction.some((shape) => constantOf(shape) === value)) {
      complaints.push(`a reviewed sentence this renderer cannot emit: ${JSON.stringify(value)}`)
    }
  }
  for (const shape of computed.sequence) {
    for (const segment of shape) {
      if (segment.kind !== 'REPEAT') continue
      for (const alternative of segment.alternatives) {
        if (!reviewed.includes(alternative)) {
          complaints.push(`a sequence joins a sentence nobody reviewed: ${JSON.stringify(alternative)}`)
        }
      }
    }
  }
  for (const { text } of RENDERED_DIRECTION_SEQUENCES) {
    if (!computed.sequence.some((shape) => patternOf(shape).test(text))) {
      complaints.push(`a reviewed sequence this renderer cannot emit: ${JSON.stringify(text)}`)
    }
  }
  return complaints
}

test('ROUND 21 (Codex HIGH): the VALUE of every string the renderer can emit is a reviewed sentence', async () => {
  // Route: a ts.Program over lib/domain/accounting/local-operator-direction.ts, from which
  // `computeRendererOutput` evaluates every string expression the two exported renderers can return
  // — composing `+`, template spans, `??`, `? :`, object and element access, `join`/`slice`/`map`
  // and calls into helper bodies with their parameters bound — and compares THE VALUE against
  // RENDERED_DIRECTIONS.
  //
  // Mutation: change any branch's prose, in any way, anywhere it is composed from, and this fails
  // naming the value it now emits. Nine controls below (A-I), including the two Codex named.
  const model = await readFile(path.join(process.cwd(), DIRECTION_MODEL_FILE), 'utf8')
  const computed = computeRendererOutput(model)

  assert.deepEqual(
    computed.unresolved, [],
    'THE FAIL-CLOSED HALF: the renderer reaches a value this walk cannot compute, so what it emits there is '
    + 'unknown — and an unknown is not an absence. Make the call resolve to an implementation with a body, '
    + 'or take it out of the renderer',
  )

  // (1) EVERY VALUE IS A CONSTANT. The direction renderer takes no free parameter, so there is
  // nothing left for it to emit that a reader cannot be shown in full.
  assert.deepEqual(
    computed.direction.filter((shape) => constantOf(shape) === null).map(describeShape), [],
    'a direction sentence is not one computable constant. Every parameter a direction carries is enumerated, '
    + 'so an unbounded value here means one of them stopped being',
  )

  // (2) AND THE SET OF THEM IS THE REVIEWED INVENTORY, BOTH WAYS.
  const reviewed = RENDERED_DIRECTIONS.map((entry) => entry.text)
  const emitted = [...new Set(computed.direction.map((shape) => constantOf(shape)!))]
  assert.ok(emitted.length >= LOCAL_DIRECTIONS.length, `only ${emitted.length} values were computed — the walk read nothing`)
  assert.deepEqual(
    emitted.filter((value) => !reviewed.includes(value)), [],
    'the renderer can emit a sentence that is in no reviewed sentence. Write it into RENDERED_DIRECTIONS, '
    + 'where somebody reads it, or take it out of the renderer. THIS IS THE CHECK THAT REPLACED FRAGMENT '
    + 'MATCHING: the value is computed and compared whole, so a sentence assembled out of separately '
    + 'innocuous literals is refused on what it composes to',
  )
  assert.deepEqual(
    reviewed.filter((value) => !emitted.includes(value)), [],
    'a sentence is written out in RENDERED_DIRECTIONS that the renderer cannot produce at all — the '
    + 'inventory has drifted from the module, and a reviewed list nothing is held to reviews nothing',
  )
  assert.equal(
    emitted.length, RENDERED_DIRECTIONS.length,
    'and the two are the same size, so the inventory is the emitted set rather than a superset of it',
  )

  // (3) THE SEQUENCE RENDERER, whose value is a `join` over a list whose length the type does not
  // fix. Its shape is therefore a REPEAT rather than a constant — and every sentence it can join is
  // a reviewed one, and the conjunction it contributes is the reviewed one.
  assert.ok(computed.sequence.length > 0, 'the sequence renderer must have been read')
  const repeats = computed.sequence.flatMap((shape) => shape.filter((segment) => segment.kind === 'REPEAT'))
  assert.equal(
    repeats.length, 1,
    'the sequence renderer must compute to exactly one REPEAT — a `join` over a list whose length its type '
    + 'does not fix. Without one the loop below judges nothing and the pattern match below is over a constant',
  )
  assert.equal(
    repeats[0]!.kind === 'REPEAT' && repeats[0]!.alternatives.length, RENDERED_DIRECTIONS.length,
    'and it joins the whole direction inventory, so every sentence a sequence can carry is judged',
  )
  assert.equal(
    repeats[0]!.kind === 'REPEAT' && repeats[0]!.minimum, 2,
    'and at least two of them, which is what `LocalDirectionSequence` declares',
  )
  for (const shape of computed.sequence) {
    for (const segment of shape) {
      if (segment.kind !== 'REPEAT') continue
      assert.deepEqual(
        segment.alternatives.filter((alternative) => !reviewed.includes(alternative)), [],
        'the sequence renderer joins a sentence that is in no reviewed sentence',
      )
    }
  }
  for (const { sequence, text } of RENDERED_DIRECTION_SEQUENCES) {
    assert.ok(
      computed.sequence.some((shape) => patternOf(shape).test(text)),
      `the reviewed sequence for ${JSON.stringify(sequence.map((element) => element.action))} is not in the `
      + 'language the sequence renderer produces — its conjunction or one of its elements has drifted',
    )
  }

  // The shipped model raises nothing at all, judged by the same function the controls use.
  assert.deepEqual(judgeRendererOutput(model), [], 'the shipped model must pass the judgement the controls fail')

  // ---------------------------------------------------------------------------------------------
  // CONTROLS. Each is a mutation of the production model, run through the same judgement.
  // ---------------------------------------------------------------------------------------------

  // (A) THE CODEX SPLIT-LITERAL COUNTEREXAMPLE, AND IT IS THE LOAD-BEARING ONE. An undeclared
  // instruction assembled from fragments that are each already inside a reviewed sentence.
  const splitLiteral = model.replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "      return 'confirm the invoice PDF stored against the order is the document you expect'"
    + " + '.' + ' ' + 'r' + 'e' + 't' + 'r' + 'y' + '.'",
  )
  assert.notEqual(splitLiteral, model, 'the split-literal mutation must actually have been applied')
  const splitComplaints = judgeRendererOutput(splitLiteral)
  assert.ok(
    splitComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('retry')),
    'CONTROL, THE CODEX ROUTE: an instruction composed out of one-character literals must be refused on the '
    + `value it composes to. Saw: ${JSON.stringify(splitComplaints)}`,
  )
  // ...AND THE RULE IT REPLACED ACCEPTS IT, asserted rather than described — every fragment of the
  // smuggled instruction occurs inside some reviewed sentence, so a scan that judged literals one at
  // a time reported a clean inventory while `retry` shipped.
  for (const fragment of ['.', ' ', 'r', 'e', 't', 'y']) {
    assert.ok(
      LOCAL_DIRECTION_SPANS.some((span) => span.includes(fragment)),
      `the round-20 fragment rule accepts "${fragment}" — which is why judging literals separately could `
      + 'never have caught the instruction they compose',
    )
  }
  // ...and the sentence they compose to is one no other check in this file refuses either.
  assert.ok(
    UNDECLARED_IMPERATIVES.some((pattern) => pattern.test('retry')),
    'the imperative banlist does hold `retry` — so the reason it shipped was that nothing ran the banlist '
    + 'against a value nobody had computed',
  )

  // (B) A CALLEE THAT RESOLVES TO A PARAMETER — THE OTHER LOAD-BEARING ONE. There is no body here to
  // inspect: what `emit` is bound to at run time is decided outside this program.
  const viaParameterCallee = model.replace(
    "    case 'RE_READ':\n      return 'so re-run the query rather than treating one result as the final list'",
    "    case 'RE_READ':\n      return viaCallback(() => 'so re-run the query rather than treating one result "
    + "as the final list')",
  ).replace(
    'function andList(',
    'function viaCallback(emit: () => string): string {\n  return emit()\n}\n\nfunction andList(',
  )
  assert.notEqual(viaParameterCallee, model, 'the parameter-callee mutation must actually have been applied')
  const parameterComplaints = judgeRendererOutput(viaParameterCallee)
  assert.ok(
    parameterComplaints.some((complaint) => complaint.includes('has no implementation body')),
    'CONTROL, THE CODEX ROUTE: a call through a function-valued PARAMETER must be REFUSED, not counted as '
    + 'resolved. A parameter has a declaration and no body, which is exactly the confusion that let an '
    + `unreadable callee pass as a read one. Saw: ${JSON.stringify(parameterComplaints)}`,
  )

  // (C) A CALLEE BACKED ONLY BY A METHOD SIGNATURE. Same defect wearing an interface.
  const viaMethodSignature = model.replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    '      return remoteWriter.emit()',
  ).replace(
    'function andList(',
    'interface RemoteWriter {\n  emit(): string\n}\ndeclare const remoteWriter: RemoteWriter\n\nfunction andList(',
  )
  assert.notEqual(viaMethodSignature, model, 'the method-signature mutation must actually have been applied')
  const signatureComplaints = judgeRendererOutput(viaMethodSignature)
  assert.ok(
    signatureComplaints.some((complaint) => complaint.includes('declares a TYPE and not an implementation')),
    `CONTROL: an interface-typed callee declares a TYPE, not an implementation. Saw: ${JSON.stringify(signatureComplaints)}`,
  )

  // (D) A HELPER DECLARED IN A PROJECT `.d.ts`. The blanket declaration-file skip that stood here
  // treated every one of these as a built-in; a project declaration file is nothing of the kind.
  const ambientPath = 'lib/domain/accounting/__scan-control-ambient-helper.d.ts'
  const viaDeclarationFile = "import { remoteRemediation } from './__scan-control-ambient-helper'\n"
    + model.replace(
      "      return 'confirm the invoice PDF stored against the order is the document you expect'",
      '      return remoteRemediation()',
    )
  assert.notEqual(viaDeclarationFile, model, 'the declaration-file mutation must actually have been applied')
  const declarationComplaints = judgeRendererOutput(viaDeclarationFile, {
    [ambientPath]: 'export declare function remoteRemediation(): string\n',
  })
  assert.ok(
    declarationComplaints.some((complaint) => complaint.includes('a DECLARATION FILE, which carries no body')),
    `CONTROL: a project .d.ts helper carries no body to inspect. Saw: ${JSON.stringify(declarationComplaints)}`,
  )

  // (E) A CALL THROUGH A VALUE RATHER THAN A NAME. The shape nobody thought of arrives here.
  const viaUnnamedCallee = model.replace(
    "    case 'RE_READ':\n      return 'so re-run the query rather than treating one result as the final list'",
    "    case 'RE_READ':\n      return (true ? andList : andList)(OUTBOX_READ_LIST.WHEN_NARROWING_IS_IMPOSSIBLE)",
  )
  assert.notEqual(viaUnnamedCallee, model, 'the unnamed-callee mutation must actually have been applied')
  const unnamedComplaints = judgeRendererOutput(viaUnnamedCallee)
  assert.ok(
    unnamedComplaints.some((complaint) => complaint.includes('has no name to resolve')),
    `CONTROL: a call through an expression is refused rather than skipped. Saw: ${JSON.stringify(unnamedComplaints)}`,
  )

  // (F) A SENTENCE APPENDED TO A REACHABLE BRANCH — the round-20 route, still refused.
  const appended = model.replace(
    'return `ESCALATE sync row ${context.syncRowId}, with this record, ${administrator}`',
    'return `ESCALATE sync row ${context.syncRowId}, with this record, ${administrator}. ' + UNDECLARED_REMOTE_ACTION + '`',
  )
  assert.notEqual(appended, model, 'the appended-sentence mutation must actually have been applied')
  assert.ok(
    judgeRendererOutput(appended).some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL: a destructive sentence appended to a reachable branch is refused on the value it produces',
  )

  // (G) A SENTENCE PARKED IN A STATIC METHOD, AND ONE IN ANOTHER MODULE. Both are implementations
  // with bodies, so both are READ — and both are then refused on the value they contribute, which is
  // the difference between resolving a call and merely naming one.
  const viaStaticMethod = model.replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    '      return RemoteInstruction.render()',
  ).replace(
    'function andList(',
    'class RemoteInstruction {\n  static render(): string {\n    return \''
    + UNDECLARED_REMOTE_ACTION + "'\n  }\n}\n\nfunction andList(",
  )
  assert.notEqual(viaStaticMethod, model, 'the static-method mutation must actually have been applied')
  const staticComplaints = judgeRendererOutput(viaStaticMethod)
  assert.deepEqual(
    staticComplaints.filter((complaint) => complaint.includes('resolves to')), [],
    'the static method must be READ rather than refused — resolving through symbols is what reaches it',
  )
  assert.ok(
    staticComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    `CONTROL: and what it returns is then judged as a value. Saw: ${JSON.stringify(staticComplaints)}`,
  )

  const helperPath = 'lib/domain/accounting/__scan-control-remote-helper.ts'
  const viaImportedHelper = "import { remoteRemediation } from './__scan-control-remote-helper'\n"
    + model.replace(
      "      return 'confirm the invoice PDF stored against the order is the document you expect'",
      '      return remoteRemediation()',
    )
  assert.notEqual(viaImportedHelper, model, 'the imported-helper mutation must actually have been applied')
  assert.ok(
    judgeRendererOutput(viaImportedHelper, {
      [helperPath]: "export function remoteRemediation(): string {\n  return '" + UNDECLARED_REMOTE_ACTION + "'\n}\n",
    }).some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL: a helper in another module is followed through its import alias and judged on what it returns',
  )

  // (I) AND A REVIEWED SENTENCE THAT STOPS BEING EMITTABLE IS AN OFFENCE TOO. An inventory nothing is
  // held to reviews nothing: a branch quietly collapsed into another leaves a sentence sitting in
  // RENDERED_DIRECTIONS that no longer describes anything the module does.
  const collapsedBranch = model.replace(
    "      return `${direction.caseForm === 'SENTENCE' ? 'Escalate' : 'escalate'} this record ${administrator}`",
    '      return `Escalate this record ${administrator}`',
  )
  assert.notEqual(collapsedBranch, model, 'the collapsed-branch mutation must actually have been applied')
  assert.ok(
    judgeRendererOutput(collapsedBranch).some((complaint) => complaint.startsWith('a reviewed sentence this renderer '
      + 'cannot emit') && complaint.includes('escalate this record')),
    'CONTROL: the inventory is held to the module in BOTH directions — a reviewed sentence the renderer can no '
    + 'longer produce is drift, not tidying',
  )

  // (H) AND THE SEQUENCE RENDERER'S OWN CONJUNCTION IS PROSE. It belongs to neither element, so it
  // has to be refused when it changes into an instruction.
  const viaSequenceConjunction = model.replace(
    ".join(' and ')",
    ".join(' and then delete the other one and ')",
  )
  assert.notEqual(viaSequenceConjunction, model, 'the conjunction mutation must actually have been applied')
  assert.ok(
    judgeRendererOutput(viaSequenceConjunction).some((complaint) => complaint.includes('reviewed sequence')),
    'CONTROL: the conjunction the sequence renderer contributes is judged too, because it is nobody\'s element',
  )
})
