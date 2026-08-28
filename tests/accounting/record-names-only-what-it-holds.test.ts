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
 * THE CONTEXTS THE RUNTIME PASS SAMPLES. Both connector names this installation runs, crossed with
 * two sync row ids — one the fixture's, one that is not (round 23, Codex HIGH).
 *
 * IT IS AT MODULE SCOPE BECAUSE THE THING IT IS EVIDENCE FOR IS ELSEWHERE (round 24, Codex HIGH).
 * `ledger` has two values and both are sampled, so a branch keyed on it cannot escape a runtime
 * pass. `syncRowId` is a database id: UNBOUNDED, so any finite sample leaves branches keyed on it
 * unexercised, and no number of samples closes that. Control (L) in the round-21 test takes exactly
 * that route and is held to these same four contexts, so "the sampled pass cannot see it" is
 * asserted against the sample the pass actually uses rather than against a description of it.
 */
const RUNTIME_CONTEXTS: readonly LocalDirectionContext[] = [
  { ledger: 'QuickBooks', syncRowId: 'log-1' },
  { ledger: 'Xero', syncRowId: 'log-1' },
  { ledger: 'QuickBooks', syncRowId: 'sync-row-742' },
  { ledger: 'Xero', syncRowId: 'sync-row-742' },
]

/**
 * A SYNC ROW ID NO PASS IN THIS FILE EVER RENDERS WITH, and a real one: 32 hex characters is what
 * the table holds. Control (L)'s laundered branch is keyed on it, which is what makes that control
 * a demonstration that a finite sample of an unbounded id closes nothing.
 */
const OFF_SAMPLE_SYNC_ROW = 'sync-row-9c2f41d0e7b84a15'

/**
 * THE REVIEWED SENTENCE AS ONE PARTICULAR CONTEXT WOULD PRINT IT (round 23, Codex HIGH).
 *
 * ROUND 22 COMPARED THE OTHER WAY ROUND. It rendered with a real connector name and pushed the
 * OUTPUT back through `normaliseRenderedValues`, which maps BOTH 'QuickBooks' and 'Xero' onto the
 * same `{ledger}`. That is lossy in exactly the direction that matters: a branch that hard-codes
 * one connector's name is normalised into the other's reviewed sentence and passes, so the runtime
 * pass could not see a wrong-connector sentence even while it was rendering one. The same holds for
 * the sync row id, whose only sampled value was the fixture's own.
 *
 * So the substitution runs on the EXPECTED text, to the exact values this pass supplied, and the
 * comparison is made on the renderer's own bytes. A sentence that differs from a reviewed one only
 * by which connector it names now differs from what it is compared against, by those same bytes.
 */
function substitutePlaceholders(text: string, context: LocalDirectionContext): string {
  // A placeholder this substitution does not know would be compared against a sentence nobody can
  // produce, which is a silently unfalsifiable comparison rather than a failing one.
  const unknownPlaceholder = text
    .split('{ledger}').join('')
    .split('{LEDGER}').join('')
    .split('{syncRowId}').join('')
    .match(/\{[A-Za-z]\w*\}/)
  assert.equal(
    unknownPlaceholder, null,
    `the reviewed sentence ${JSON.stringify(text)} carries a placeholder this substitution does not know `
    + `(${unknownPlaceholder?.[0]}), so comparing against it would compare against a sentence the renderer `
    + 'cannot produce with any context at all',
  )
  return text
    .split('{ledger}').join(context.ledger)
    .split('{LEDGER}').join(context.ledger.toUpperCase())
    .split('{syncRowId}').join(context.syncRowId)
}

/**
 * Hold a rendering of the model to the reviewed inventory. Taking the renderer as an argument is
 * what lets the refusal case below run the SAME check over a mutated one; taking `expected` is what
 * lets a real-context pass compare against the reviewed sentence WITH THIS CONTEXT'S VALUES IN IT
 * (round 23, Codex HIGH) rather than against a normalised copy of the output.
 */
function assertRenderedInventory(
  render: (direction: LocalDirection) => string,
  expected: (text: string) => string = (text) => text,
): void {
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
      render(direction), expected(entries[0]!.text),
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

  // AND WITH THE REAL VALUES PRODUCTION SUPPLIES (round 22, Codex HIGH), compared against the
  // reviewed sentence WITH THOSE VALUES SUBSTITUTED INTO IT (round 23, Codex HIGH). The placeholder
  // context is a FIXTURE: a branch selected by comparing `context.ledger` against 'QuickBooks' or
  // 'Xero' is never taken while it is what renders, so rendering only with it leaves exactly the
  // branch production takes unexercised. Round 22 fixed that by normalising the output, which maps
  // both connector names onto one placeholder and so cannot tell them apart — control (L) below.
  //
  // The sync row id is sampled at a value that is NOT the fixture's for the same reason: coverage
  // that only ever passes 'log-1' cannot see a branch keyed on it (Codex, round 23).
  for (const runtime of RUNTIME_CONTEXTS) {
    assertRenderedInventory(
      (direction) => renderLocalDirection(direction, runtime),
      (text) => substitutePlaceholders(text, runtime),
    )
    for (const { sequence, text } of RENDERED_DIRECTION_SEQUENCES) {
      assert.equal(
        renderLocalDirectionSequence(sequence, runtime), substitutePlaceholders(text, runtime),
        'a sequence renders something other than its reviewed sentence once real values are in the context',
      )
    }
  }

  // (L) A CONNECTOR-MISMATCHED SENTENCE (round 23, Codex HIGH), and the one control here that is
  // about the COMPARISON rather than about the renderer. This renderer prints the QuickBooks-named
  // sentence for one direction while the context it was handed says Xero — which is what a branch
  // pruned by an asserted discriminant ships at run time.
  const xeroRuntime: LocalDirectionContext = { ledger: 'Xero', syncRowId: 'log-1' }
  const quickBooksRuntime: LocalDirectionContext = { ledger: 'QuickBooks', syncRowId: 'log-1' }
  const wrongConnector = (direction: LocalDirection): string => renderLocalDirection(
    direction,
    direction.action === 'TURN_OFF' && direction.control === 'CONNECTOR_PANEL_CHECKBOX'
      ? quickBooksRuntime
      : xeroRuntime,
  )
  assert.throws(
    () => assertRenderedInventory(wrongConnector, (text) => substitutePlaceholders(text, xeroRuntime)),
    /is NOT the reviewed sentence for it/,
    'CONTROL: a sentence naming the WRONG connector for the context it was rendered with must be refused. The '
    + 'reviewed text carries this pass\'s own values, so the only output that matches is the one that printed '
    + 'them',
  )
  // ...AND NORMALISATION ACCEPTED IT, asserted rather than described — the same shape as (J). The
  // round-22 comparison, run over the SAME mutated renderer, passes: `normaliseRenderedValues` maps
  // 'QuickBooks' and 'Xero' onto one `{ledger}`, so the wrong connector's sentence is rewritten into
  // the reviewed one before anything looks at it. That is the mutation of the CHECK itself.
  assertRenderedInventory((direction) => normaliseRenderedValues(wrongConnector(direction)))

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
 * which is the fail-closed direction for a branch selector.
 *
 * AND THE TWO CONTEXT FIELDS ARE SYMBOLIC, NOT CONCRETE (round 22, Codex HIGH). They used to be
 * bound to the literal strings `{ledger}` and `{syncRowId}` — the placeholders
 * `LOCAL_DIRECTION_CONTEXT` substitutes — because those are what the reviewed inventory is written
 * against. But a literal is a value this walk KNOWS, so `context.ledger === 'QuickBooks'` folded to
 * FALSE and the arm behind it was PRUNED: a branch reachable only at run time (production supplies
 * `ledger: 'QuickBooks'` and `ledger: 'Xero'`) was never evaluated, and whatever it emitted was
 * never compared against the inventory. That is the defect this walk exists to remove, one level in
 * — the checks it replaced could not SEE certain output; this one DECIDED IT DID NOT EXIST.
 *
 * So a context field is a `SYMBOL` segment. It still renders as its placeholder wherever it is
 * concatenated (`renderedOf`), so the inventory comparison is unchanged; but it is not a constant
 * (`constantOf` returns null), so any comparison or other control-flow use of it is INDETERMINATE
 * and both arms are evaluated and both outputs judged. THE RULE, stated once: a value that is
 * unknown at analysis time must make its condition indeterminate, NEVER false.
 *
 * The only other stand-ins this walk binds are already sound under that rule. A ROOT parameter with
 * no argument is `OPAQUE` (never a string, so never one constant, so never decidable) — and since
 * round 25 only a root gets one at all; a list
 * parameter becomes an `OPEN_LIST` carrying only its type's length FLOOR, and reading `.length` off
 * one is `UNKNOWN` rather than a number; a discriminant read off an `OPAQUE` value is resolved from
 * the CHECKER's literal type, which folds only when the type itself admits exactly one string AND
 * `literalOrigin` can trace that type to a declaration nobody asserted into existence — knowledge
 * about the program, rather than a stand-in for a runtime value. That second condition is the one
 * every round on this axis has been about, and the ENUMERATION below — not a claim that the latest
 * fix "reaches every path" — is what says where it is now demanded and where it is not.
 *
 * AND A CALL BOUNDARY IS NOT A LAUNDERING STEP (round 24, Codex HIGH). Rounds 22 and 23 each closed
 * one place where a TYPE stood in for a VALUE, and each left the next one open. Codex's third route
 * on the same axis went through a HELPER: assert at the ARGUMENT, and what the walk reads on the
 * other side is the PARAMETER's declared type — which round 23 trusted unconditionally, because a
 * parameter annotation is normally somebody's own contract. Two things had to be wrong at once:
 *
 *   • THE ORDER. `resolveProperty`/`resolveElement` consulted the checker-literal fallback BEFORE
 *     propagating an `UNKNOWN` receiver, so a value this walk had already refused came back
 *     concrete off its own declaration. That is now the first thing either of them does, and it is
 *     unconditional: an unknown receiver makes its property unknown, whatever the type says. This
 *     is the invariant, not a case — it deletes an ordering rather than adding an exception.
 *   • THE TRUST. A parameter's declared literal type is honest exactly as far as the ARGUMENT bound
 *     to it is, so `originFrames` carries each argument's provenance into the frame and
 *     `symbolOrigin` reads it back. A parameter with NO entry was never given an argument — it is a
 *     root this walk supplied itself, and its annotation is the module's own word. That is what
 *     keeps `direction.target` folding, and it is why the computed set is still one sentence per
 *     direction rather than every branch taken both ways.
 *
 * ONE FIX WOULD NOT HAVE DONE. Codex's own route is closed by either; the receiver in it is
 * `UNKNOWN`. But assert over `direction` instead and the receiver is `OPAQUE`, so propagation never
 * fires and only provenance refuses it. Control (L) holds both halves, each against the evaluator
 * that lacked it.
 *
 * AND AN ABSENCE IS NOT A POSITIVE FACT (round 25, Codex HIGH). Round 24's rule for the other side
 * of the boundary was: "a parameter with no origin entry was never given an argument, so it is a
 * root this walk supplied itself, so its declared type is the module's own word". That reads TRUST
 * OUT OF AN ABSENCE, and the absence has more than one cause. An INTERNAL CALL THAT OMITS AN
 * ARGUMENT does not leave the parameter unbound: JavaScript evaluates the parameter's DEFAULT
 * INITIALIZER, which is an expression like any other and can be an `as`. So the assertion simply
 * moved from the call site into the parameter list, nothing was recorded for it, and the
 * manufactured literal was trusted for exactly the reason round 24 wrote down. Two changes, and the
 * second is the general one:
 *
 *   • DEFAULTS ARE MODELLED. `callImplementation` binds parameters in order inside the frame: an
 *     argument when there is one, otherwise the initializer's VALUE and the initializer's
 *     PROVENANCE, read by the same `argumentOrigin` a written-out argument goes through. An
 *     omitted argument is not a missing binding; it is a binding to the default.
 *   • THE TRUSTED SET IS WRITTEN DOWN. `ANALYZER_ROOT_RENDERERS` names the two renderers
 *     `rootShapes` calls with no arguments, and `analyzerRoots` holds exactly their parameters.
 *     Those are the only argument-less parameters this walk will invent a value for or trust an
 *     annotation on. Every other parameter carries provenance or is UNKNOWN — including one left
 *     unbound because the call omitted an optional argument, which is `undefined` at run time and
 *     is not a value anybody's annotation describes.
 *
 * AND THE ANALYZER'S OWN ENTRY IS NOT A CALL THAT OMITTED SOMETHING (round 26, Codex HIGH).
 * Modelling defaults is right at an INTERNAL call and wrong one call further out. `rootShapes`
 * calls each exported renderer with `[]` — not because a caller left arguments off, but because
 * this walk is standing in for EVERY caller there can be. Round 25 ran that through the same code
 * path, so a root parameter carrying a default was bound to that default for the whole analysis,
 * and a discriminant the CALLER chooses became a constant the walk had already decided:
 * `mode: 'REVIEWED' | 'UNREVIEWED' = 'REVIEWED'` on the exported renderer pruned every branch
 * behind `mode === 'UNREVIEWED'`, and the inventory reported clean over prose it never read.
 *
 *   • ROOT ENTRY SEEDS, IT DOES NOT EVALUATE. `callImplementation` takes an `entry` of `'ROOT'` or
 *     `'INTERNAL'`. At `'ROOT'` nothing is bound at all, so every parameter falls to the abstract
 *     root value `resolveIdentifier` invents for the names in `analyzerRoots` — the reviewed
 *     context, a list keeping only its length floor, or OPAQUE. An OPAQUE decides no comparison, so
 *     both arms are walked. At `'INTERNAL'`, defaults are modelled exactly as round 25 left them.
 *
 * The two rules are independent and control (N) says so with assertions: round 25's route goes
 * through an internal omitted argument and is still refused; round 26's route is one round 25
 * OPENED — round 24's binding already walked both arms of it — and is closed only by the root-entry
 * distinction.
 *
 * AND THE ROOT DROPS THE DEFAULT'S VALUE, NOT ITS PROVENANCE (round 27, Codex HIGH). Round 26's
 * early return dropped two different things and only one of them should have been dropped. There
 * are two maps here and they answer two questions:
 *
 *   `frame`        WHAT IS this parameter. Not binding it at root entry is the round-26 fix and it
 *                  is right: the caller chooses the value, so the walk must not decide it.
 *   `originFrame`  HOW FAR is this parameter's DECLARED TYPE to be trusted. Round 24's answer is
 *                  "exactly as far as whatever would bind it is", and a DEFAULT INITIALIZER is one
 *                  of the things that would.
 *
 * Returning before recording anything left the parameter looking like a root nothing had ever
 * touched, `symbolOrigin` read that absence as the module's own word, and `resolveProperty`'s
 * checker-literal fallback re-concretized a property straight off the annotation. So
 * `options: { mode: 'REVIEWED' } = ({ mode: 'UNREVIEWED' } as unknown as { mode: 'REVIEWED' })`
 * folded `options.mode` to `'REVIEWED'` and pruned the arm every omitted-argument call takes at run
 * time — the same type-stands-in-for-value hole as rounds 22-26, reopened at the entry the fix for
 * round 26 created.
 *
 * THE FIX IS THE RULE, NOT A SIXTH ARM. `callImplementation`'s root branch still binds no value and
 * now records `argumentOrigin(parameter.initializer)` — the same provenance reader a written-out
 * argument goes through, at the one binding site round 26 stopped looking at. A default with clean
 * provenance records `null` and changes nothing, and the shipped renderers declare no defaults at
 * all, so the computed inventory is untouched: fourteen shapes, fourteen distinct sentences,
 * fourteen reviewed, nothing unresolved — the same numbers every round since 21.
 *
 * Control (O) is the route, and its sequence renderer passes the safe value EXPLICITLY so that the
 * only path to the pruned arm is the root: with the argument omitted there too, round 25's internal
 * default modelling would surface the sentence through the sequence and the control would be about
 * round 25 instead.
 *
 * AND AN ELEMENT ACCESS HAS TWO EXPRESSIONS IN IT, NOT ONE (round 28, Codex HIGH). Rounds 22-27
 * are one pattern stated six times: a rule demands provenance at the position it was written for,
 * and ONE ADJACENT EXPRESSION POSITION IS NEVER ASKED. Receiver properties, then call arguments,
 * then default initializers, then root-entry initializers — and now the KEY. `literalOrigin` traced
 * the RECEIVER of `a[k]` and returned; nothing ever looked at `k`. So
 * `direction[(context.syncRowId === OFF_SAMPLE ? 'action' : 'target') as 'target']` types as
 * exactly `"ORDER_INVOICE_PDF"` with no diagnostic at all, the comparison against that value folds
 * TRUE, and the arm an off-sample id takes at run time is pruned — on an OPAQUE root, with no call,
 * no argument, no default and nothing UNKNOWN, so not one of the five earlier fixes can reach it.
 * `keyOrigin` is the fix: the key is asked the same question the receiver is.
 *
 * AND A DECLARATION CAN HOLD AN EXPRESSION TOO (round 29, Codex HIGH). Round 28 ended with a gap
 * NAMED rather than closed: `symbolOrigin` trusted a class `PropertyDeclaration` on its annotation
 * alone, without reading its initializer, which is exactly the trust round 27 removed from a
 * parameter's default. The reason given for leaving it was that a class identifier resolves to a
 * `ClassDeclaration` `resolveIdentifier` cannot compute and a `new` resolves to one
 * `implementationsOf` refuses, so the receiver would be UNKNOWN and round 24's propagation would
 * kill the access before any annotation was read.
 *
 * THE DISCLOSURE IS WHY THE ROUTE WAS FOUND, AND THE REASON IS WHAT FAILED. The fence quoted above
 * covers the receivers you have to EVALUATE. The ROOTS produce a different kind: `rootShapes`
 * trusts every parameter of the two renderer roots, and `resolveIdentifier` hands a non-context,
 * non-list root straight back as OPAQUE. AN OPAQUE RECEIVER IS NOT AN UNKNOWN ONE — propagation
 * never fires on it, which is the very thing controls (N), (O) and (P) each say in their own words.
 * So a class-TYPED root parameter reads the annotation with no class identifier and no `new`
 * evaluated anywhere: `class C { readonly mode: 'REVIEWED' = 'UNREVIEWED' as unknown as 'REVIEWED' }`
 * folds `render.mode` to `'REVIEWED'`, and the arm every caller takes at run time is pruned.
 *
 * THE FIX IS THE CRITERION, NOT THE CASE. `symbolOrigin` accepted six declaration kinds
 * unconditionally, and the criterion it needed is structural: FOUR of them — property signature,
 * interface, type alias, type parameter — are type-position syntax from end to end, so there is
 * nowhere in them an `as` could be written and nothing whose runtime value could disagree. The
 * other TWO — a class field and an enum member — PAIR AN ANNOTATION WITH AN EXPRESSION, which is
 * the pairing every round since 23 has been about. Those two now take the same initializer trace a
 * variable does; one with no initializer is refused, because the annotation is then backed by
 * nothing this walk reads; and an AMBIENT one is refused outright, for the reason
 * `resolveIdentifier` already refuses an ambient variable — its value lives in code this program
 * does not contain.
 *
 * THE ENUM MEMBER IS THE SAME RULE AND A DIFFERENT REACH. Round 28 held it closed for the round-28
 * reason, so it was open for the round-28 reason — but not in the same shape. TypeScript refuses a
 * computed value in a string enum outright (TS18033), so an enum member's initializer cannot carry
 * an assertion at all and (Q)'s exact route has no enum form. What it does have is the AMBIENT one,
 * reached the same way — a root parameter typed `typeof E` — and control (Q3) takes it. A read
 * through the enum OBJECT is genuinely UNKNOWN, because `resolveIdentifier` cannot compute an
 * `EnumDeclaration`; (Q3) asserts that too, since it is the receiver round 28's argument was
 * actually about and the one the roots do not produce.
 *
 * SO HERE IS THE ENUMERATION, RE-DERIVED RATHER THAN RE-STATED — because a table that was wrong
 * once can be wrong twice, and the row that was wrong was wrong in a way the table's own shape
 * hid. Every position that can produce a CONCRETE value from a CHECKER TYPE, which is the only
 * place a type can stand in for a value. (1)-(4) are `a.n`; (5)-(10) are `a[k]`; (11) is a bare
 * identifier, and the table used to stop at ten.
 *
 *    (1) `a`, OBJECT branch      VALUE-COMPUTED. The walk computed the receiver itself; no checker
 *                                type is consulted, and `valueOf` unwraps an `as` to compute what
 *                                is underneath it. Nothing to demand.
 *    (2) `a`, LIST `.length`     VALUE-COMPUTED — a number this walk counted.
 *    (3) `a`, checker fold       DEMANDED, `literalOrigin` (rounds 23-27).
 *    (4) `n`, the property name  DEMANDED, `symbolOrigin`. `n` is an identifier and never an
 *                                expression, so nothing can be asserted at the access site; what
 *                                CAN be asserted is the declaration it resolves to — see the
 *                                sub-table below, which is where round 28's error actually lived.
 *    (5) `a`, LIST branch        VALUE-COMPUTED.
 *    (6) `k`, LIST branch        NOT DEMANDED, AND SOUND — re-derived, not carried over. The branch
 *                                requires a NUMBER, and this walk produces a NUMBER in exactly four
 *                                places: a numeric literal, a unary minus, `+`/`-` over two
 *                                NUMBERs, and `LIST.length`. `checkerLiterals` yields only STRING,
 *                                so no checker type can manufacture an index.
 *    (7) `a`, OBJECT branch      VALUE-COMPUTED.
 *    (8) `k`, OBJECT branch      VALUE-COMPUTED, and demanded wherever computing it consults the
 *                                checker — the key goes through `valueOf`, which reaches a checker
 *                                literal only via (3), (4), (9), (10) or (11). A key with more than
 *                                one shape unions BOTH properties rather than choosing one.
 *    (9) `a`, checker fold       DEMANDED, `literalOrigin`.
 *   (10) `k`, checker fold       DEMANDED as of round 28, `keyOrigin`.
 *   (11) a bare IDENTIFIER       DEMANDED, `literalOrigin` — and this row is NEW, because the
 *                                round-28 table scoped itself to `resolveProperty` and
 *                                `resolveElement` while `checkerLiterals` has a THIRD caller:
 *                                `resolveIdentifier`'s fall-through, for a name that is neither a
 *                                bound parameter nor a variable. That is not an edge: a DESTRUCTURED
 *                                name is a `BindingElement` and lands here, so round 23's own Codex
 *                                route — `const { ledger } = context as { ledger: 'QuickBooks' }` —
 *                                runs through position (11) and not through (3) or (4) at all.
 *                                Instrumenting the walk over this file's controls reaches it with
 *                                `ledger` as a `BindingElement`, and with a `ClassDeclaration` and
 *                                an `EnumDeclaration` receiver. The table was not merely short at
 *                                the edge; it omitted the position its earliest control uses.
 *
 * AND THE SUB-TABLE THE ROWS ABOVE DELEGATE TO, which round 28 did not write down and which is
 * where its one wrong justification was. (3), (4), (9), (10) and (11) all end in `symbolOrigin`,
 * and `symbolOrigin` decides by DECLARATION KIND:
 *
 *   REFUSED, always            a binding element (its type is whatever it was destructured out of
 *                              was declared OR asserted to have — round 23).
 *   REFUSED unless the
 *   argument was honest        a parameter — `originFrames` carries the argument's provenance, a
 *                              default's provenance is carried at both entries, and only the roots
 *                              in `analyzerRoots` are trusted unbacked (rounds 24-27).
 *   TRACED to its initializer  a variable, a property assignment, and — as of round 29 — a class
 *                              field and an enum member. No initializer, or an ambient one, is
 *                              refused rather than trusted.
 *   ACCEPTED on annotation     a property signature, an interface, a type alias, a type parameter.
 *                              These four hold NO EXPRESSION ANYWHERE, so there is nothing in them
 *                              to assert. That is the criterion; "the receiver would be UNKNOWN"
 *                              was not, and it is what round 28 used for the two kinds above it.
 *   REFUSED by name            everything else, and `literalOrigin` is DEFAULT-DENY around it.
 *
 * WHAT ELSE RESTED ON THE RECEIVER ARGUMENT: nothing. Re-derived row by row — (1), (2), (5), (7)
 * and (8) consult no checker type at all, so no provenance question arises; (6) is the closed count
 * of NUMBER producers above; (3), (4), (9), (10) and (11) all DEMAND provenance and differ only in
 * which expression they demand it of. The receiver-UNKNOWN argument appeared exactly once, in the
 * sub-table, for exactly the two kinds that carry an expression — and both are now traced instead.
 * `literalOrigin` staying DEFAULT-DENY is what makes eleven a closed count rather than a sample: it
 * admits six syntactic forms and refuses every other by name, and of the six only parenthesis,
 * non-null, property access and element access have sub-expressions at all.
 *
 * `contextBinding` exists ONLY so a control can re-run this walk with the pre-fix concrete binding
 * and demonstrate that the branch is pruned again. Nothing else passes anything but `'SYMBOLIC'`.
 */

/** A run of the value a renderer can emit. */
type Segment =
  | { kind: 'TEXT'; text: string }
  /**
   * A VALUE THAT IS NOT KNOWN UNTIL RUN TIME (round 22, Codex HIGH) — a field of
   * `LocalDirectionContext`. It RENDERS as `placeholder`, which is the form the reviewed inventory
   * is written in, and that is the ONLY thing it may be used for. It is deliberately NOT a `TEXT`
   * run: a `TEXT` run is a string this walk KNOWS, and knowing it makes a comparison against it
   * decidable. See `constantOf` against `renderedOf` below — the whole of the fix is that those two
   * are different functions.
   */
  | { kind: 'SYMBOL'; name: string; placeholder: string }
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

/**
 * How the two `LocalDirectionContext` fields are bound. `'SYMBOLIC'` is what ships and what every
 * judgement uses; `'CONCRETE'` reproduces the round-21 binding — the fields as the literal strings
 * `{ledger}` and `{syncRowId}` — and exists only so control (J) can show what that binding let past.
 */
type ContextBinding = 'SYMBOLIC' | 'CONCRETE'

/**
 * WHETHER A CHECKER LITERAL TYPE IS FOLDED ON ITS PROVENANCE OR ON THE CHECKER'S WORD ALONE.
 * `'TRACKED'` is what ships and what every judgement uses. The other two reproduce the two fixes'
 * predecessors so a control can show what each let past:
 *
 *   • `'UNTRACKED'` is the round-22 fold — any single-literal checker type becomes a concrete
 *     string, wherever it came from. Control (K).
 *   • `'CALL_LOCAL'` is the round-23 fold — provenance is traced AT THE NODE, but it stops at a
 *     call boundary: a parameter's declared literal type is taken as honest no matter what was
 *     passed in. Control (L).
 */
type LiteralProvenance = 'TRACKED' | 'CALL_LOCAL' | 'UNTRACKED'

/**
 * WHETHER AN UNKNOWN RECEIVER SHORT-CIRCUITS ITS PROPERTY ACCESS (round 24, Codex HIGH).
 * `'PROPAGATED'` is what ships and what every judgement uses: a property read off a value this walk
 * does not know is UNKNOWN, full stop, before anything asks the checker what the property's type
 * says. `'DEFERRED'` reproduces the round-23 ordering — the checker-literal fallback was consulted
 * FIRST, so an unknown receiver could hand back a concrete string — and exists only so control (L)
 * can show what that ordering let past.
 */
type ReceiverPropagation = 'PROPAGATED' | 'DEFERRED'

/**
 * WHAT AN OMITTED ARGUMENT BINDS ITS PARAMETER TO (round 25, Codex HIGH).
 *
 * `'MODELLED'` is what ships and what every judgement uses: JavaScript evaluates the parameter's
 * DEFAULT INITIALIZER when the argument is omitted, so the parameter takes that expression's value
 * AND that expression's provenance. `'UNBOUND'` reproduces the round-24 binding — an omitted
 * argument recorded nothing at all, so the parameter fell through to the argument-less case and was
 * read as a root this walk had supplied itself. Control (M) shows what that let past.
 */
type DefaultBinding = 'MODELLED' | 'UNBOUND'

/**
 * WHICH ARGUMENT-LESS PARAMETERS THIS WALK TRUSTS (round 25, Codex HIGH).
 *
 * `'NAMED'` is what ships: the ONLY parameters this walk may invent a value for are the ones it
 * creates itself, at the calls in `rootShapes` — the parameters of `ANALYZER_ROOT_RENDERERS`, held
 * in `analyzerRoots` and named there. `'INFERRED'` reproduces round 24's rule, which read trust out
 * of an ABSENCE: "no origin entry, so nobody passed one, so this walk must have made it". That
 * inference is false for every other way a parameter can go unbound — a default initializer above
 * all — and an absence is not a positive fact. Control (M) shows the difference.
 */
type RootTrust = 'NAMED' | 'INFERRED'

/**
 * WHAT A ROOT-ENTRY PARAMETER BINDS TO (round 26, Codex HIGH).
 *
 * `rootShapes` calls each exported renderer with NO arguments — but it is not a caller that omitted
 * them. It is this walk creating an ABSTRACT entry, standing for every call any formatter can
 * write. Round 25 taught `callImplementation` that an omitted argument takes its parameter's
 * default, which is exactly right AT AN INTERNAL CALL and exactly wrong here: the analyzer's own
 * `[]` then looked like a real omission, and a root parameter with a default was pinned to that
 * default's value for the whole analysis.
 *
 * That prunes. `mode: 'REVIEWED' | 'UNREVIEWED' = 'REVIEWED'` binds `mode` to `'REVIEWED'`, the
 * comparison `mode === 'UNREVIEWED'` becomes a DECIDED false, and the branch behind it is never
 * walked — while any formatter may pass `'UNREVIEWED'` and get the sentence it emits. The
 * inventory then reports clean over prose it never read.
 *
 * `'ABSTRACT'` is what ships: at root entry NOTHING is bound, so every root parameter falls to the
 * abstract root value `resolveIdentifier` invents for the names in `analyzerRoots` — the reviewed
 * context, a list keeping only its length floor, or OPAQUE. An OPAQUE discriminant decides no
 * comparison, so both arms are taken, which is the only safe reading of a value the caller
 * chooses. `'DEFAULTED'` reproduces round 25's behaviour and exists only so control (N) can show
 * what it pruned.
 */
type RootEntry = 'ABSTRACT' | 'DEFAULTED'

/**
 * WHETHER THE ROOT CARRIES ITS DEFAULT'S PROVENANCE (round 27, Codex HIGH).
 *
 * `'CARRIED'` is what ships, and it is round 24's rule reaching the one binding site round 26
 * stopped looking at. `'DROPPED'` reproduces round 26 and exists only so control (O) can show what
 * it folded. See the block above `RootEntry` and the root branch of `callImplementation`.
 */
type RootProvenance = 'CARRIED' | 'DROPPED'

/**
 * WHETHER THE KEY OF AN ELEMENT ACCESS MUST BE HONEST TOO (round 28, Codex HIGH).
 *
 * `'DEMANDED'` is what ships and what every judgement uses: `a[k]` folds to a checker literal only
 * when BOTH `a` and `k` trace to a declaration nobody asserted into existence. `'IGNORED'`
 * reproduces rounds 22-27, every one of which asked the receiver and never the key — so
 * `direction[(...) as 'target']` folded off an OPAQUE root. Control (P) shows what it let past.
 */
type KeyProvenance = 'DEMANDED' | 'IGNORED'

/**
 * WHETHER A DECLARATION THAT CARRIES AN INITIALIZER IS TRUSTED ON ITS ANNOTATION (round 29, Codex
 * HIGH).
 *
 * `'DEMANDED'` is what ships: a class `PropertyDeclaration` and an `EnumMember` pair an annotation
 * with an EXPRESSION, so — like a variable, a property assignment and a parameter default before
 * them — the annotation is honest exactly as far as that expression is, and a member declared
 * without an implementation this walk can read is honest not at all. `'IGNORED'` reproduces rounds
 * 22-28, every one of which let both kinds through on the annotation alone. Control (Q) shows what
 * that let past.
 */
type FieldProvenance = 'DEMANDED' | 'IGNORED'

/**
 * THE ROOTS THIS WALK CREATES, BY NAME. `rootShapes` calls exactly these two with no arguments, so
 * exactly their parameters are values this walk supplied and whose declared types are therefore the
 * module's own word about itself. Everything else in the program is reached through a call, and
 * carries provenance or is unknown.
 */
const ANALYZER_ROOT_RENDERERS = ['renderLocalDirection', 'renderLocalDirectionSequence'] as const

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

/**
 * THE STRING A SHAPE *IS* — null when any part of it is not known at analysis time, which a SYMBOL
 * and a REPEAT both are. This is the DECIDABILITY question: a `===` may only be folded when both
 * sides are one of these, so a comparison against a context field is indeterminate and both arms of
 * the conditional it selects get evaluated.
 */
function constantOf(shape: Shape): string | null {
  let text = ''
  for (const segment of shape) {
    if (segment.kind !== 'TEXT') return null
    text += segment.text
  }
  return text
}

/**
 * THE STRING A SHAPE *RENDERS AS* — a SYMBOL contributes its placeholder, because `{ledger}` and
 * `{syncRowId}` are exactly what the reviewed inventory was written against. Null only for a REPEAT,
 * which stands for many strings rather than one.
 *
 * This is the JUDGEMENT question, and it is a different question from the one above. A context field
 * renders as a placeholder AND is undecidable in a condition; collapsing the two into one notion is
 * what let a runtime-only branch be pruned (round 22, Codex HIGH).
 */
function renderedOf(shape: Shape): string | null {
  let text = ''
  for (const segment of shape) {
    if (segment.kind === 'TEXT') { text += segment.text; continue }
    if (segment.kind === 'SYMBOL') { text += segment.placeholder; continue }
    return null
  }
  return text
}

/** A shape as a pattern: literal text matches itself, a REPEAT matches its own joined language. */
function patternOf(shape: Shape): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let source = ''
  for (const segment of shape) {
    if (segment.kind === 'TEXT') { source += escape(segment.text); continue }
    if (segment.kind === 'SYMBOL') { source += escape(segment.placeholder); continue }
    const alternatives = `(?:${segment.alternatives.map(escape).join('|')})`
    source += `${alternatives}(?:${escape(segment.separator)}${alternatives}){${Math.max(segment.minimum - 1, 0)},}`
  }
  return new RegExp(`^${source}$`)
}

/** What a shape LOOKS like, for a failure message. */
function describeShape(shape: Shape): string {
  return shape
    .map((segment) => {
      if (segment.kind === 'TEXT') return segment.text
      if (segment.kind === 'SYMBOL') return segment.placeholder
      return `<one of ${segment.alternatives.length} sentences, joined by ${JSON.stringify(segment.separator)}>`
    })
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

/**
 * The semantic complaints the COMPILER makes about a model — so a control can establish that its
 * mutation is one the type-checker admits, rather than a shape no diff could ever take.
 */
function modelDiagnostics(model: string, extraFiles: Record<string, string> = {}): string[] {
  const program = directionModelProgram(model, extraFiles)
  const modelPath = path.resolve(process.cwd(), DIRECTION_MODEL_FILE)
  const modelFile = program.getSourceFiles().find((file) => path.resolve(file.fileName) === modelPath)
  return program.getSemanticDiagnostics(modelFile).map((diagnostic) => (
    ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  ))
}

/** A callee this walk is willing to read: something with a body in a file that is not a declaration. */
type Implementation = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression

/**
 * ONE ARGUMENT AT A CALL: its value, AND where the literal type of the expression that produced it
 * came from (round 24, Codex HIGH). The second half is the whole point — a value crossing a call
 * boundary used to shed its history and pick up the parameter's declared type instead.
 */
type Argument = { readonly value: Value; readonly origin: string | null }

function computeRendererOutput(
  model: string,
  extraFiles: Record<string, string> = {},
  contextBinding: ContextBinding = 'SYMBOLIC',
  literalProvenance: LiteralProvenance = 'TRACKED',
  receiverPropagation: ReceiverPropagation = 'PROPAGATED',
  defaultBinding: DefaultBinding = 'MODELLED',
  rootTrust: RootTrust = 'NAMED',
  rootEntry: RootEntry = 'ABSTRACT',
  rootProvenance: RootProvenance = 'CARRIED',
  keyProvenance: KeyProvenance = 'DEMANDED',
  fieldProvenance: FieldProvenance = 'DEMANDED',
): ComputedRendererOutput {
  const program = directionModelProgram(model, extraFiles)
  const checker = program.getTypeChecker()
  const modelPath = path.resolve(process.cwd(), DIRECTION_MODEL_FILE)
  const modelFile = program.getSourceFiles().find((file) => path.resolve(file.fileName) === modelPath)
  assert.ok(modelFile, 'the direction model must be in the program, or this walk reads nothing')

  const unresolved: string[] = []
  const frames: Array<Map<ts.Symbol, Value>> = []
  /**
   * WHERE A PARAMETER'S DECLARED LITERAL TYPE ACTUALLY CAME FROM (round 24, Codex HIGH). One entry
   * per bound parameter, pushed and popped with `frames`: the reason its ARGUMENT's literal type is
   * not honest, or null when it is. A parameter with no entry is one this walk supplied itself —
   * the renderers' own roots — and its declared contract is the module's own word, which is what
   * makes reading `direction.target` off it sound.
   */
  const originFrames: Array<Map<ts.Symbol, string | null>> = []
  /**
   * THE TRUSTED SET, WRITTEN DOWN RATHER THAN INFERRED (round 25, Codex HIGH). Round 24 decided a
   * parameter was analyzer-created by observing that no argument had been recorded for it — an
   * absence read as a positive fact, and false the moment a call omits an argument that has a
   * default. `rootShapes` puts the parameters of `ANALYZER_ROOT_RENDERERS` in here, and those are
   * the only ones for which this walk will invent a value or trust a declared type unbacked by an
   * argument.
   */
  const analyzerRoots = new Set<ts.Symbol>()
  const inProgress = new Set<ts.Node>()

  const where = (node: ts.Node): string => {
    const file = node.getSourceFile()
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    return `${path.relative(process.cwd(), file.fileName)}:${line + 1}`
  }
  const unknown = (reason: string): UnknownValue => ({ kind: 'UNKNOWN', reason })
  const text = (value: string): StringValue => ({ kind: 'STRING', shapes: [shapeOf([{ kind: 'TEXT', text: value }])] })

  /** A value that RENDERS as `placeholder` and is otherwise not known — see the `SYMBOL` segment. */
  const symbolic = (name: string, placeholder: string): StringValue => (
    { kind: 'STRING', shapes: [shapeOf([{ kind: 'SYMBOL', name, placeholder }])] }
  )

  /**
   * The two values a direction's prose varies by. SYMBOLIC (round 22, Codex HIGH): they render as
   * the placeholders the reviewed inventory is written against, and they decide no condition, so a
   * branch selected by comparing one against a real ledger name is evaluated on BOTH arms.
   */
  const contextField = (name: string, placeholder: string): StringValue => (
    contextBinding === 'SYMBOLIC' ? symbolic(name, placeholder) : text(placeholder)
  )
  const CONTEXT_VALUE: ObjectValue = {
    kind: 'OBJECT',
    properties: new Map<string, Value>([
      ['ledger', contextField('context.ledger', LOCAL_DIRECTION_CONTEXT.ledger)],
      ['syncRowId', contextField('context.syncRowId', LOCAL_DIRECTION_CONTEXT.syncRowId)],
    ]),
  }

  const bound = (symbol: ts.Symbol): Value | undefined => {
    for (let index = frames.length - 1; index >= 0; index--) {
      const value = frames[index]!.get(symbol)
      if (value !== undefined) return value
    }
    return undefined
  }

  /** The argument provenance carried into a bound parameter, or undefined if it was never bound. */
  const boundOrigin = (symbol: ts.Symbol): string | null | undefined => {
    for (let index = originFrames.length - 1; index >= 0; index--) {
      const frame = originFrames[index]!
      if (frame.has(symbol)) return frame.get(symbol) ?? null
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

  /**
   * WHERE A CHECKER LITERAL TYPE CAME FROM (round 23, Codex HIGH).
   *
   * Reading a discriminant off a value this walk holds only as OPAQUE is sound when the literal
   * type is DECLARED — a property signature of the closed union this module writes down. Round 22
   * said as much, and said it too broadly: "knowledge about the program, not a stand-in for a
   * runtime value" is true ONLY when the literal type has honest provenance. An `as` assertion
   * MANUFACTURES a literal type out of a value that is not known until run time, and the checker
   * reports the manufactured one exactly as confidently as the declared one. So
   * `const { ledger } = context as { ledger: 'QuickBooks'; syncRowId: string }` restores precisely
   * the pruning round 22 closed: `ledger` is then ONE literal, a comparison against another
   * connector's name folds FALSE, and the arm production takes at run time is never computed.
   *
   * These two answer WHERE: null when the provenance is clean, and the reason to refuse otherwise.
   * A refusal makes the value UNKNOWN, which makes its comparison indeterminate, which takes BOTH
   * arms — the same safe direction a SYMBOL takes. THE RULE IS THE ROUND-22 ONE, one level in: a
   * value whose type this walk did not itself receive from a declaration must make its condition
   * indeterminate, NEVER false.
   */
  function literalOrigin(node: ts.Node, seen: Set<ts.Node>): string | null {
    if (seen.has(node)) return 'a literal type whose origin leads back to itself, so it cannot be traced'
    seen.add(node)
    // `(x)` and `x!` cannot invent a literal that was not already in the type underneath them.
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
      return literalOrigin(node.expression, seen)
    }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      return 'a literal type MANUFACTURED by an assertion over a value this walk does not know. An assertion '
        + 'is a claim about run time; the checker reports it as confidently as a declared type, and folding it '
        + 'would decide away the branch production actually takes'
    }
    if (ts.isPropertyAccessExpression(node)) {
      return literalOrigin(node.expression, seen) ?? symbolOrigin(node.name, seen)
    }
    // BOTH HALVES OF AN ELEMENT ACCESS, NOT JUST THE RECEIVER (round 28, Codex HIGH). `a[k]` has
    // TWO expressions in it and its literal type is chosen by BOTH. Every round from 22 to 27
    // traced the receiver and never once asked the key, so an assertion on the KEY manufactured a
    // literal type exactly the way an assertion on the value did — see `keyOrigin`.
    if (ts.isElementAccessExpression(node)) {
      return literalOrigin(node.expression, seen) ?? keyOrigin(node.argumentExpression, seen)
    }
    if (ts.isIdentifier(node)) return symbolOrigin(node, seen)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return null
    return `a ${ts.SyntaxKind[node.kind]}, whose literal type this walk cannot trace to a declaration`
  }

  function symbolOrigin(name: ts.MemberName, seen: Set<ts.Node>): string | null {
    const symbol = aliasResolved(checker.getSymbolAtLocation(name))
    if (!symbol) return `"${name.text}" resolves to no symbol, so where its literal type came from is unknown`
    const declarations = symbol.declarations ?? []
    if (declarations.length === 0) {
      return `"${name.text}" has no declaration, so where its literal type came from is unknown`
    }
    for (const declaration of declarations) {
      // A BINDING ELEMENT is INDETERMINATE, always. Its literal type is whatever the value it was
      // destructured out of was declared OR ASSERTED to have, and that assertion is not on this
      // node — there is nothing here to read it off. This is Codex's route.
      if (ts.isBindingElement(declaration)) {
        return `"${name.text}" is a BINDING ELEMENT: its literal type is whatever the value it was destructured `
          + 'out of was declared OR ASSERTED to have, so it is not knowledge about the program'
      }
      // A PARAMETER IS HONEST ONLY AS FAR AS WHAT WAS PASSED INTO IT (round 24, Codex HIGH). Its
      // declared type is a contract, and a contract is knowledge about the program exactly while
      // nobody has ASSERTED their way through it. Round 23 allowed a parameter unconditionally, so
      // `helper(context as { syncRowId: 'claimed-row' })` laundered a manufactured literal across
      // the call boundary and came out the other side as a declaration this walk trusted. So the
      // argument's provenance is carried in at the call (`originFrames`) and read back here.
      //
      // A parameter with no entry had nothing bind it at all — no argument AND no default — so it is
      // a root this walk supplied itself, and its declared type is the module's own word. That is
      // what keeps `direction.target` folding, which is what keeps the computed set one sentence per
      // direction. Since round 27 the "no default" half is real rather than assumed: a root
      // parameter that HAS a default records that default's provenance even though its value is not
      // bound, so an absence here means an absence of both.
      if (ts.isParameter(declaration)) {
        const carried = boundOrigin(symbol)
        if (carried) {
          return `"${name.text}" is a PARAMETER bound to an argument whose own literal type is not honest: ${carried}`
        }
        // NO ENTRY IS NOT A LICENCE (round 25, Codex HIGH). Round 24 read the absence as "nobody
        // passed one, so this walk supplied it", and that inference is false for an internal call
        // with an OMITTED argument: JavaScript evaluates the parameter's default, which can be an
        // assertion. Defaults are modelled at the call now (see `callImplementation`), and the
        // trusted set is the one this walk wrote down rather than the one it can no longer
        // distinguish from an omission.
        if (carried === undefined && rootTrust === 'NAMED' && !analyzerRoots.has(symbol)) {
          return `"${name.text}" is a PARAMETER with no argument traced into it and is not one this walk created `
            + `as a root (${ANALYZER_ROOT_RENDERERS.join(', ')}), so its declared literal type is a contract `
            + 'somebody may have asserted their way through rather than knowledge about the program'
        }
        continue
      }
      // THE HONEST PROVENANCE, and the only one that folds: a type annotation somebody wrote down
      // in a declaration THAT CANNOT CARRY AN EXPRESSION AT ALL. A property signature of the closed
      // direction union, an interface, a type alias, a type parameter — every one of them is
      // type-position syntax from end to end, so there is nowhere in it an `as` could have been
      // written and nothing whose runtime value could disagree with what it says.
      // `direction.target` and `direction.form` are these, and nothing else here is.
      //
      // THAT — not "the receiver would be UNKNOWN" — IS THE CRITERION (round 29, Codex HIGH). Round
      // 28 kept `PropertyDeclaration` and `EnumMember` in this list and defended them with a
      // reachability argument about their receivers. The criterion the list actually needs is
      // structural, and it splits these six exactly: four kinds hold no expression, and two do.
      if (ts.isPropertySignature(declaration) || ts.isTypeAliasDeclaration(declaration)
        || ts.isInterfaceDeclaration(declaration) || ts.isTypeParameterDeclaration(declaration)) {
        continue
      }
      // A DECLARATION THAT PAIRS AN ANNOTATION WITH AN EXPRESSION IS HONEST ONLY AS FAR AS THAT
      // EXPRESSION IS (round 29, Codex HIGH). A class FIELD and an ENUM MEMBER are that pairing, and
      // rounds 23-27 are one sentence about it: the annotation is what the checker reports, the
      // expression is what runs. `class C { mode: 'REVIEWED' = 'UNREVIEWED' as unknown as
      // 'REVIEWED' }` is (O)'s asserted default, one declaration kind further along.
      //
      // ROUND 28 NAMED THIS POSITION AND ARGUED IT UNREACHABLE, AND THE ARGUMENT WAS WRONG. It said
      // a class identifier resolves to a `ClassDeclaration` this walk cannot compute and a `new`
      // resolves to one `implementationsOf` refuses, so the receiver is UNKNOWN and round 24's
      // propagation kills the access. That fence covers a different receiver class from the one the
      // ROOTS produce: `rootShapes` trusts every parameter of the two renderer roots, and
      // `resolveIdentifier` hands a non-context, non-list root back as OPAQUE. An OPAQUE receiver is
      // not an UNKNOWN one — propagation never fires — so a class-typed root parameter reads the
      // annotation with no class identifier and no `new` evaluated anywhere. See control (Q).
      //
      // So both kinds go through the same initializer trace a variable does, and an AMBIENT one —
      // `declare enum`, a member of a `.d.ts` — is refused outright: its value lives in code this
      // program does not contain, which is the same reason `resolveIdentifier` refuses an ambient
      // variable rather than reading its declared type as a value.
      if (ts.isPropertyDeclaration(declaration) || ts.isEnumMember(declaration)) {
        if (fieldProvenance === 'IGNORED') continue
        const kind = ts.SyntaxKind[declaration.kind]
        if (declaration.getSourceFile().isDeclarationFile || isAmbient(declaration)) {
          return `"${name.text}" is a ${kind} declared without an implementation this walk can read, so its `
            + 'literal type is a claim about code this program does not contain'
        }
        if (!declaration.initializer) {
          return `"${name.text}" is a ${kind} with no initializer, so its literal type is an annotation and `
            + 'whatever assigns it is not read here'
        }
        const inner = literalOrigin(declaration.initializer, seen)
        if (inner) return inner
        continue
      }
      // A value whose type is its initializer's is honest exactly as far as that initializer is.
      if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) {
        if (!declaration.initializer) {
          return `"${name.text}" has no initializer, so where its literal type came from is unknown`
        }
        const inner = literalOrigin(declaration.initializer, seen)
        if (inner) return inner
        continue
      }
      return `"${name.text}" resolves to a ${ts.SyntaxKind[declaration.kind]}, whose literal type this walk `
        + 'cannot trace to a declaration'
    }
    return null
  }

  /**
   * WHERE THE KEY OF AN ELEMENT ACCESS CAME FROM (round 28, Codex HIGH).
   *
   * `a[k]`'s literal type is a function of TWO expressions, and rounds 22-27 each demanded
   * provenance of the one they were written for. `literalOrigin` traced the RECEIVER and stopped,
   * so a key nobody could compute manufactured the same trusted literal every earlier round was
   * about: `direction[(context.syncRowId === OFF_SAMPLE ? 'action' : 'target') as 'target']` types
   * as exactly `"ORDER_INVOICE_PDF"`, with no diagnostic, while at run time the key is chosen by an
   * unbounded id. The receiver is an OPAQUE root, so no earlier fix reaches it — there is no call,
   * no argument, no default, and nothing UNKNOWN to propagate.
   *
   * THE RULE IS THE SAME ONE, ASKED OF THE OTHER HALF: a key this walk cannot trace to a
   * declaration nobody asserted into existence makes the access indeterminate. `keyOrigin` is
   * `literalOrigin` plus the one form a key may take that a value position never needs — an INDEX
   * WRITTEN OUT IN SOURCE, which names exactly what it says and was manufactured by nobody.
   */
  function keyOrigin(node: ts.Expression, seen: Set<ts.Node>): string | null {
    if (keyProvenance === 'IGNORED') return null
    if (ts.isParenthesizedExpression(node)) return keyOrigin(node.expression, seen)
    if (ts.isNumericLiteral(node)) return null
    return literalOrigin(node, seen)
  }

  /**
   * The closed set of strings the checker says an expression can be, AS A VALUE — folded to text
   * only when `literalOrigin` says the type was declared rather than asserted into existence.
   */
  const checkerLiterals = (node: ts.Expression): Value | null => {
    const literals = literalStrings(node)
    if (literals === null) return null
    const manufactured = literalProvenance === 'UNTRACKED' ? null : literalOrigin(node, new Set())
    if (manufactured !== null) return unknown(`this walk will not fold a checker literal here: ${manufactured}`)
    return { kind: 'STRING', shapes: literals.map((value) => shapeOf([{ kind: 'TEXT', text: value }])) }
  }

  /**
   * The provenance an ARGUMENT carries into the parameter it binds. `'CALL_LOCAL'` and `'UNTRACKED'`
   * carry nothing, which is round 23 — see `LiteralProvenance` and control (L).
   */
  const argumentOrigin = (node: ts.Expression): string | null => (
    literalProvenance === 'TRACKED' ? literalOrigin(node, new Set()) : null
  )

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

  /**
   * Run a body with its parameters bound to the values passed, and union what it returns.
   *
   * `entry` says WHO IS CALLING. `'INTERNAL'` is a call the program itself writes, and an argument
   * it omits takes the parameter's default, as JavaScript does. `'ROOT'` is this walk creating the
   * abstract entry in `rootShapes`: the empty argument list there is not an omission by anybody, so
   * nothing is bound and every parameter falls to the abstract root value — see `RootEntry`.
   */
  const callImplementation = (
    implementation: Implementation,
    args: readonly Argument[],
    entry: 'ROOT' | 'INTERNAL' = 'INTERNAL',
  ): Value => {
    if (inProgress.has(implementation)) return unknown('a recursive call, whose value cannot be computed by this walk')
    const frame = new Map<ts.Symbol, Value>()
    const originFrame = new Map<ts.Symbol, string | null>()
    inProgress.add(implementation)
    frames.push(frame)
    originFrames.push(originFrame)
    try {
      // BOUND IN PARAMETER ORDER, INSIDE THE FRAME, because that is the order and the scope the
      // language uses: a default initializer sees the parameters to its left.
      implementation.parameters.forEach((parameter, index) => {
        const symbol = ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined
        if (!symbol) return
        const argument = args[index]
        if (argument !== undefined) {
          frame.set(symbol, argument.value)
          // Recorded even when it is null, so a bound parameter says "an argument was passed and it
          // was honest" rather than falling back to "this walk supplied this root itself".
          originFrame.set(symbol, argument.origin)
          return
        }
        // NOT AT THE ANALYZER'S OWN ROOT (round 26, Codex HIGH). `rootShapes` passes `[]` because
        // this walk is standing in for EVERY caller, not because a caller omitted anything — so a
        // root parameter's default is one value among the many a formatter may pass, and binding it
        // here decides a discriminant the caller actually chooses. Left unbound, the parameter
        // falls to `resolveIdentifier`'s abstract root value; an OPAQUE one decides no comparison,
        // so both arms of every branch keyed on it are walked.
        if (entry === 'ROOT' && rootEntry === 'ABSTRACT') {
          // THE VALUE IS NOT BOUND — AND THE PROVENANCE STILL IS (round 27, Codex HIGH).
          //
          // Round 26 returned here and recorded nothing, which drops TWO different things at once
          // and only one of them should be dropped. `frame` answers "what IS this parameter"; not
          // binding it is the round-26 fix and it is right — the caller chooses the value, so the
          // walk must not decide it. `originFrame` answers a different question: "how far is this
          // parameter's DECLARED TYPE to be trusted". Round 24's rule for that is that a
          // parameter's annotation is honest exactly as far as whatever would bind it is, and a
          // default initializer is one of the things that would. Dropping the initializer's
          // provenance therefore left the parameter looking like a root nothing had ever touched,
          // and `symbolOrigin` reads that absence as the module's own word — after which
          // `resolveProperty`'s checker-literal fallback re-concretizes a property off the
          // annotation the initializer asserted into existence. `options: { mode: 'REVIEWED' } =
          // ({ mode: 'UNREVIEWED' } as unknown as { mode: 'REVIEWED' })` folds `options.mode` to
          // `'REVIEWED'` and prunes the arm every omitted-argument call takes at run time.
          //
          // So the ONE RULE — a declared type is trusted only as far as what bound the value is —
          // is applied on this path too, and the two maps go back to answering their own questions.
          // A default with clean provenance records `null` and changes nothing: the shipped
          // renderers declare no defaults at all, so the computed inventory is untouched.
          if (rootProvenance === 'CARRIED' && parameter.initializer) {
            originFrame.set(symbol, argumentOrigin(parameter.initializer))
          }
          return
        }
        // AN OMITTED ARGUMENT TAKES THE DEFAULT'S VALUE AND THE DEFAULT'S PROVENANCE (round 25,
        // Codex HIGH). Round 24 recorded nothing here, so the parameter arrived at `symbolOrigin`
        // looking exactly like a root this walk had created — and `helper()` with
        // `claimed: T = context as { syncRowId: 'claimed-row' }` laundered a manufactured literal
        // through the omission. The initializer IS the argument in that call; it is evaluated as
        // one, and `argumentOrigin` reads its provenance the same way a written-out argument's is
        // read.
        if (defaultBinding === 'MODELLED' && parameter.initializer) {
          frame.set(symbol, valueOf(parameter.initializer))
          originFrame.set(symbol, argumentOrigin(parameter.initializer))
          return
        }
        // No argument and no default: `undefined` at run time. Nothing is recorded, and the
        // argument-less case in `resolveIdentifier`/`symbolOrigin` decides what that is worth —
        // which, unless this is one of the roots this walk created, is nothing.
      })
      return returnValueOf(implementation)
    } finally {
      originFrames.pop()
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

  const listOperation = (
    call: ts.CallExpression,
    operation: string,
    receiver: ListValue,
    receiverOrigin: string | null,
  ): Value => {
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
      // `renderedOf`, not `constantOf`: an element carrying a context placeholder is one sentence a
      // reviewer has read, and it is only a REPEAT — many sentences — that cannot be joined here.
      const alternatives = receiver.element.shapes.map(renderedOf)
      if (alternatives.some((alternative) => alternative === null)) {
        return unknown('a `join` over a list whose elements do not each render as one sentence')
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
    // The element inherits the RECEIVER's provenance: `(rows as { form: 'X' }[]).map(...)` is the
    // same laundering as passing an asserted value directly, one indirection along.
    if (receiver.kind === 'LIST') {
      return {
        kind: 'LIST',
        items: receiver.items.map((item) => callImplementation(callback, [{ value: item, origin: receiverOrigin }])),
      }
    }
    return {
      kind: 'OPEN_LIST',
      element: callImplementation(callback, [{ value: receiver.element, origin: receiverOrigin }]),
      minimum: receiver.minimum,
    }
  }

  const evaluateCall = (call: ts.CallExpression | ts.NewExpression): Value => {
    const callee = call.expression
    if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) {
      return unknown(`a call through a ${ts.SyntaxKind[callee.kind]} has no name to resolve, so there is no `
        + 'declaration to read and nothing can say what it returns')
    }
    const args: readonly Argument[] = (call.arguments ?? []).map((argument) => (
      { value: valueOf(argument), origin: argumentOrigin(argument) }
    ))
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
          return listOperation(call, callee.name.text, receiver, argumentOrigin(callee.expression))
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
      // ONLY A ROOT THIS WALK CREATED GETS A VALUE INVENTED FOR IT (round 25, Codex HIGH). Any
      // other parameter that reached here was left unbound by a call — no argument and no default
      // — so at run time it is `undefined`, and inventing an OPAQUE root for it hands a value this
      // walk knows nothing about the standing of one it made itself.
      if (rootTrust === 'NAMED' && !analyzerRoots.has(symbol)) {
        return unknown(`"${node.text}" is a PARAMETER no call bound and this walk did not create as a root `
          + `(${ANALYZER_ROOT_RENDERERS.join(', ')}), so what it contributes is unknown`)
      }
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
    const literals = checkerLiterals(node)
    if (literals) return literals
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
    // THE INVARIANT (round 24, Codex HIGH), and it comes FIRST. An unknown receiver makes its
    // property unknown, whatever the property's DECLARED type says: a type describes what a value
    // may be, and this walk is computing what it IS. Asking the checker before propagating let a
    // value this walk had already given up on come back concrete off its own declaration.
    if (receiverPropagation === 'PROPAGATED' && object.kind === 'UNKNOWN') return object
    const literals = checkerLiterals(node)
    if (literals) return literals
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
    // The same invariant, through the other syntax — see `resolveProperty`.
    if (receiverPropagation === 'PROPAGATED' && object.kind === 'UNKNOWN') return object
    const literals = checkerLiterals(node)
    if (literals) return literals
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
        // NOT DECIDED, so not decided AGAINST either. A context field reaches here (it renders as a
        // placeholder but is no constant), and so does anything else this walk does not know: the
        // conditional above will take both arms, which is the only safe reading of a value that is
        // chosen at run time.
        return unknown('a comparison this walk cannot decide, so the branch it selects is taken both ways')
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
  const rootShapes = (root: (typeof ANALYZER_ROOT_RENDERERS)[number]): readonly Shape[] => {
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
      // THE ROOT CREATION, AND THE ONLY ONE. These parameters get no argument because this walk
      // is the caller; they are named here so that "argument-less and therefore trustworthy" is a
      // set somebody wrote down rather than a conclusion drawn from a missing map entry.
      for (const parameter of declaration.parameters) {
        const parameterSymbol = ts.isIdentifier(parameter.name)
          ? checker.getSymbolAtLocation(parameter.name)
          : undefined
        if (parameterSymbol) analyzerRoots.add(parameterSymbol)
      }
      const value = callImplementation(declaration, [], 'ROOT')
      if (value.kind !== 'STRING') {
        unresolved.push(`${where(declaration)}: ${root} does not return prose this walk can read`)
        continue
      }
      shapes.push(...value.shapes)
    }
    return shapes
  }

  const direction = rootShapes(ANALYZER_ROOT_RENDERERS[0])
  const sequence = rootShapes(ANALYZER_ROOT_RENDERERS[1])
  return { direction, sequence, unresolved }
}

/**
 * EVERY COMPLAINT THE COMPUTED OUTPUT RAISES AGAINST A MODEL. One function, so the controls below
 * run exactly the judgement the shipped model is held to rather than a paraphrase of it.
 */
function judgeRendererOutput(
  model: string,
  extraFiles: Record<string, string> = {},
  contextBinding: ContextBinding = 'SYMBOLIC',
  literalProvenance: LiteralProvenance = 'TRACKED',
  receiverPropagation: ReceiverPropagation = 'PROPAGATED',
  defaultBinding: DefaultBinding = 'MODELLED',
  rootTrust: RootTrust = 'NAMED',
  rootEntry: RootEntry = 'ABSTRACT',
  rootProvenance: RootProvenance = 'CARRIED',
  keyProvenance: KeyProvenance = 'DEMANDED',
  fieldProvenance: FieldProvenance = 'DEMANDED',
): string[] {
  const computed = computeRendererOutput(
    model, extraFiles, contextBinding, literalProvenance, receiverPropagation, defaultBinding, rootTrust,
    rootEntry, rootProvenance, keyProvenance, fieldProvenance,
  )
  const reviewed = RENDERED_DIRECTIONS.map((entry) => entry.text)
  const complaints = [...computed.unresolved]
  for (const shape of computed.direction) {
    const value = renderedOf(shape)
    if (value === null) {
      complaints.push(`a direction sentence that is not one computable constant: ${describeShape(shape)}`)
      continue
    }
    if (!reviewed.includes(value)) complaints.push(`emits a sentence nobody reviewed: ${JSON.stringify(value)}`)
  }
  for (const value of reviewed) {
    if (!computed.direction.some((shape) => renderedOf(shape) === value)) {
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
  // naming the value it now emits. Twelve controls below (A-L), including the five Codex named.
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
    computed.direction.filter((shape) => renderedOf(shape) === null).map(describeShape), [],
    'a direction sentence is not one computable constant. Every parameter a direction carries is enumerated, '
    + 'so an unbounded value here means one of them stopped being',
  )

  // (2) AND THE SET OF THEM IS THE REVIEWED INVENTORY, BOTH WAYS.
  const reviewed = RENDERED_DIRECTIONS.map((entry) => entry.text)
  const emitted = [...new Set(computed.direction.map((shape) => renderedOf(shape)!))]
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

  // (J) A BRANCH SELECTED BY A CONTEXT VALUE — THE ROUND-22 ROUTE (Codex HIGH), and the one control
  // here that is about the EVALUATOR rather than about the renderer. `context.ledger` is not known
  // until run time; production supplies 'QuickBooks' and 'Xero'. While the walk bound that field to
  // the concrete string `{ledger}`, this comparison folded to FALSE, the QuickBooks arm was PRUNED,
  // and the instruction behind it was never compared against the inventory by anything.
  const viaRuntimeLedger = model.replace(
    "    case 'CONFIRM':\n      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "    case 'CONFIRM':\n      return context.ledger === 'QuickBooks'\n        ? '" + UNDECLARED_REMOTE_ACTION
    + "'\n        : 'confirm the invoice PDF stored against the order is the document you expect'",
  )
  assert.notEqual(viaRuntimeLedger, model, 'the runtime-ledger mutation must actually have been applied')
  const runtimeLedgerComplaints = judgeRendererOutput(viaRuntimeLedger)
  assert.ok(
    runtimeLedgerComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL: a branch reachable only at run time — selected by comparing a context field against a real '
    + 'ledger name — must be EVALUATED, not decided away. Both arms are taken because the comparison is '
    + `indeterminate, and both outputs are judged. Saw: ${JSON.stringify(runtimeLedgerComplaints)}`,
  )

  // ...AND THE BINDING IS WHAT CATCHES IT, asserted rather than described. Re-run the SAME judgement
  // over the SAME mutated renderer with the context fields bound to concrete strings — the round-21
  // representation — and it reports a clean inventory while the QuickBooks arm ships. That is the
  // mutation of the evaluator itself, and it is the reason `constantOf` and `renderedOf` are two
  // functions rather than one.
  assert.deepEqual(
    judgeRendererOutput(viaRuntimeLedger, {}, 'CONCRETE'), [],
    'THE PRE-FIX BINDING MUST STILL LET IT THROUGH — if concrete binding also refused this, control (J) '
    + 'would be passing for some other reason and would prove nothing about the symbolic representation',
  )

  // ...and neither does binding it to the OTHER real ledger name rescue the concrete reading: pick a
  // stand-in and you have chosen which runtime branch to be blind to, whichever one you pick.
  const viaRuntimeLedgerXero = model.replace(
    "    case 'CONFIRM':\n      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "    case 'CONFIRM':\n      return context.ledger === 'Xero'\n        ? '" + UNDECLARED_REMOTE_ACTION
    + "'\n        : 'confirm the invoice PDF stored against the order is the document you expect'",
  )
  assert.notEqual(viaRuntimeLedgerXero, model, 'the Xero runtime-ledger mutation must actually have been applied')
  assert.ok(
    judgeRendererOutput(viaRuntimeLedgerXero).some((complaint) => complaint.startsWith('emits a sentence nobody '
      + 'reviewed') && complaint.includes('take the second PDF off it')),
    'CONTROL: and the same for the other ledger this installation runs',
  )
  assert.deepEqual(judgeRendererOutput(viaRuntimeLedgerXero, {}, 'CONCRETE'), [])

  // ...and the same route through the OTHER context field, so the fix is the representation and not
  // one special-cased property name.
  const viaRuntimeSyncRow = model.replace(
    "    case 'CONFIRM':\n      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "    case 'CONFIRM':\n      return context.syncRowId === 'log-1'\n        ? '" + UNDECLARED_REMOTE_ACTION
    + "'\n        : 'confirm the invoice PDF stored against the order is the document you expect'",
  )
  assert.notEqual(viaRuntimeSyncRow, model, 'the runtime-syncRowId mutation must actually have been applied')
  assert.ok(
    judgeRendererOutput(viaRuntimeSyncRow).some((complaint) => complaint.startsWith('emits a sentence nobody '
      + 'reviewed') && complaint.includes('take the second PDF off it')),
    'CONTROL: `syncRowId` is a runtime value too, and it selects a branch the same way',
  )
  assert.deepEqual(judgeRendererOutput(viaRuntimeSyncRow, {}, 'CONCRETE'), [])

  // (K) A DISCRIMINANT LAUNDERED THROUGH AN ASSERTION — THE ROUND-23 ROUTE (Codex HIGH), and the
  // second control here about the EVALUATOR. Round 22 made `context.ledger` symbolic, so comparing
  // against it is indeterminate. THIS MUTATION NEVER COMPARES AGAINST IT: it destructures the field
  // through an `as` that CLAIMS the value is one literal, and the checker then reports that literal
  // exactly as confidently as it reports a declared one. Fold it and the arm production takes at
  // run time is pruned again, precisely as it was before round 22.
  const viaAssertedBinding = model.replace(
    "    case 'CONFIRM':\n      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "    case 'CONFIRM': {\n"
    + "      const { ledger } = context as { ledger: 'QuickBooks'; syncRowId: string }\n"
    + "      const otherLedger: string = 'Xero'\n"
    + "      return ledger === otherLedger\n"
    + "        ? '" + UNDECLARED_REMOTE_ACTION + "'\n"
    + "        : 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + '    }',
  )
  assert.notEqual(viaAssertedBinding, model, 'the asserted-binding mutation must actually have been applied')
  // AND IT IS A MUTATION THE COMPILER ADMITS, which is what makes it a route rather than a typo:
  // `otherLedger` is `string`, so this is not the "have no overlap" comparison TypeScript rejects.
  assert.deepEqual(
    modelDiagnostics(viaAssertedBinding), modelDiagnostics(model),
    'the asserted-binding mutation must type-check exactly as the shipped model does, or it is not a route '
    + 'anybody could take',
  )
  const assertedBindingComplaints = judgeRendererOutput(viaAssertedBinding)
  assert.ok(
    assertedBindingComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL: a discriminant whose single-literal type was MANUFACTURED by an `as` over runtime context must be '
    + 'INDETERMINATE — both arms taken, both outputs judged. A checker literal is knowledge about the program '
    + `only when it came from a declaration. Saw: ${JSON.stringify(assertedBindingComplaints)}`,
  )

  // ...AND THE PROVENANCE-BLIND FOLD IS WHAT CATCHES IT, asserted rather than described — the same
  // shape as (J). Re-run the SAME judgement over the SAME mutated renderer with checker literals
  // folded on the checker's word alone, which is the round-22 rule, and it reports a clean inventory
  // while the run-time Xero pass ships Codex's sentence.
  assert.deepEqual(
    judgeRendererOutput(viaAssertedBinding, {}, 'SYMBOLIC', 'UNTRACKED'), [],
    'THE PRE-FIX FOLD MUST STILL LET IT THROUGH — if provenance-blind folding also refused this, control (K) '
    + 'would be passing for some other reason and would prove nothing about tracking provenance',
  )

  // ...and the honest folds are STILL folded, or (K) was bought by refusing everything: the shipped
  // model above raised nothing, and it only computes one sentence per direction because
  // `direction.target`, `direction.form`, `direction.control` and `direction.caseForm` are read from
  // the closed union's own property signatures.
  assert.equal(
    emitted.length, RENDERED_DIRECTIONS.length,
    'a declared discriminant must still fold — if provenance tracking refused those too, every branch would be '
    + 'taken both ways and the computed set would be wider than the inventory',
  )

  // ...and a context field still RENDERS as its placeholder, which is the half that must NOT have
  // changed: every reviewed sentence that carries one is still emittable, and the shipped model
  // above raised nothing. Held here explicitly so a later round cannot "fix" the symbol by dropping
  // the placeholder and quietly turn the inventory comparison vacuous.
  assert.ok(
    reviewed.some((value) => value.includes('{ledger}')) && reviewed.some((value) => value.includes('{syncRowId}')),
    'the inventory must still contain placeholder-bearing sentences, or (J) is checking nothing',
  )
  assert.ok(
    emitted.some((value) => value.includes('{ledger}')) && emitted.some((value) => value.includes('{syncRowId}')),
    'and the walk must still COMPUTE them with the placeholders in place — a symbol that renders as nothing '
    + 'would make every context-bearing sentence unemittable rather than undecidable',
  )

  // (L) A DISCRIMINANT LAUNDERED ACROSS A HELPER BOUNDARY — THE ROUND-24 ROUTE (Codex HIGH), and
  // the third control here about the EVALUATOR. Round 23 refused to fold a literal type an `as`
  // had manufactured — AT THE NODE THE ASSERTION IS ON. This mutation puts a call between the two:
  // the assertion is on the ARGUMENT, and what the walk reads inside the helper is the PARAMETER's
  // declared type, which round 23's allowlist trusted unconditionally. Two things had to be wrong
  // at once for it to work, and each is fixed and controlled separately below.
  //
  // (L1) IS THE ORDERING. `JSON.parse(...)` is a value this walk has already given up on: it
  // resolves to a declaration file, so it is UNKNOWN. But `resolveProperty` asked the checker what
  // `runtime.syncRowId` is DECLARED to be before propagating that UNKNOWN, so a value the walk had
  // refused came back concrete off its own parameter's type.
  const viaRuntimeCopy = model.replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    '      return fromRuntimeCopy(JSON.parse(JSON.stringify(context)) as { syncRowId: \'claimed-row\' })',
  ).replace(
    'function andList(',
    "function fromRuntimeCopy(runtime: { syncRowId: 'claimed-row' }): string {\n"
    + "  const offSampleRow: string = '" + OFF_SAMPLE_SYNC_ROW + "'\n"
    + '  return runtime.syncRowId === offSampleRow\n'
    + "    ? '" + UNDECLARED_REMOTE_ACTION + "'\n"
    + "    : 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + '}\n\nfunction andList(',
  )
  assert.notEqual(viaRuntimeCopy, model, 'the runtime-copy mutation must actually have been applied')
  // AND IT IS A MUTATION THE COMPILER ADMITS, byte for byte the same diagnostics as the shipped
  // model: `JSON.parse` is `any`, so the assertion is legal, and `offSampleRow` is `string`, so the
  // comparison is not the "have no overlap" one TypeScript rejects.
  assert.deepEqual(
    modelDiagnostics(viaRuntimeCopy), modelDiagnostics(model),
    'the runtime-copy mutation must type-check exactly as the shipped model does, or it is not a route '
    + 'anybody could take',
  )
  const runtimeCopyComplaints = judgeRendererOutput(viaRuntimeCopy)
  assert.ok(
    runtimeCopyComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL: a property read off a receiver this walk holds as UNKNOWN must stay UNKNOWN. A type says what a '
    + 'value MAY be; this walk is computing what it IS, and consulting the declaration instead re-concretizes '
    + `exactly the value the walk had already refused. Saw: ${JSON.stringify(runtimeCopyComplaints)}`,
  )
  // ...AND THE PRE-FIX ORDERING LETS IT THROUGH, asserted rather than described — the same shape as
  // (J) and (K). Re-run the SAME judgement over the SAME mutated renderer with the round-23
  // evaluator: the checker-literal fallback consulted before the UNKNOWN propagates, and provenance
  // traced only as far as the call boundary. It reports a clean inventory while the sentence ships.
  assert.deepEqual(
    judgeRendererOutput(viaRuntimeCopy, {}, 'SYMBOLIC', 'CALL_LOCAL', 'DEFERRED'), [],
    'THE ROUND-23 EVALUATOR MUST STILL LET IT THROUGH — if it also refused this, control (L) would be passing '
    + 'for some other reason and would prove nothing about either fix',
  )
  // ...and EACH FIX ALONE closes this particular route, which is why (1) was taken as the invariant
  // rather than as one more case: propagating the UNKNOWN removes the ordering, and carrying the
  // argument's provenance removes the trust. Both are asserted, so neither can rot into decoration.
  assert.ok(
    judgeRendererOutput(viaRuntimeCopy, {}, 'SYMBOLIC', 'CALL_LOCAL', 'PROPAGATED').length > 0,
    'propagating the UNKNOWN receiver must close this route on its own',
  )
  assert.ok(
    judgeRendererOutput(viaRuntimeCopy, {}, 'SYMBOLIC', 'TRACKED', 'DEFERRED').length > 0,
    'and so must carrying the argument\'s provenance across the call boundary, on its own',
  )

  // ...AND THE RUNTIME PASS CANNOT SEE IT, asserted against the sample that pass actually uses.
  // The laundered branch is keyed on a sync row id, and sync row ids are unbounded: hand-run the
  // mutated renderer over all four RUNTIME_CONTEXTS and every one reports the reviewed inventory,
  // because none of them is the id the branch is keyed on. That is the whole reason this route has
  // to be closed statically — no finite sample of an unbounded id closes it.
  assert.ok(
    !RUNTIME_CONTEXTS.some((context) => context.syncRowId === OFF_SAMPLE_SYNC_ROW)
      && LOCAL_DIRECTION_CONTEXT.syncRowId !== OFF_SAMPLE_SYNC_ROW,
    'the off-sample id must be off-sample, or the demonstration below is about nothing',
  )
  const laundered = (direction: LocalDirection, context: LocalDirectionContext): string => (
    direction.action === 'CONFIRM' && context.syncRowId === OFF_SAMPLE_SYNC_ROW
      ? UNDECLARED_REMOTE_ACTION
      : renderLocalDirection(direction, context)
  )
  assert.equal(RUNTIME_CONTEXTS.length, 4, 'the four sampled contexts, unchanged')
  for (const context of RUNTIME_CONTEXTS) {
    assertRenderedInventory(
      (direction) => laundered(direction, context),
      (text) => substitutePlaceholders(text, context),
    )
  }
  const offSampleContext: LocalDirectionContext = { ledger: 'Xero', syncRowId: OFF_SAMPLE_SYNC_ROW }
  assert.throws(
    () => assertRenderedInventory(
      (direction) => laundered(direction, offSampleContext),
      (text) => substitutePlaceholders(text, offSampleContext),
    ),
    /is NOT the reviewed sentence for it/,
    'and the SAME renderer refused the moment the id is one nobody sampled — so what the four contexts '
    + 'established was the ids they carry, not the renderer',
  )

  // (L2) IS THE TRUST, and it is the half that survives (1). Here the laundered receiver is not
  // UNKNOWN at all: `direction` is an OPAQUE root, so propagating unknown never fires, and the
  // parameter's asserted literal type folds exactly as before. THIS ONE FIRES AT RUN TIME — the
  // assertion claims every escalation names its sync row, and two of the fourteen do not.
  const viaAssertedArgument = model.replace(
    "    case 'ESCALATE': {\n"
    + "      const administrator = 'to whoever administers this installation'\n"
    + "      if (direction.naming === 'SYNC_ROW') {\n"
    + '        return `ESCALATE sync row ${context.syncRowId}, with this record, ${administrator}`\n'
    + '      }\n'
    + "      return `${direction.caseForm === 'SENTENCE' ? 'Escalate' : 'escalate'} this record ${administrator}`\n"
    + '    }',
    "    case 'ESCALATE': {\n"
    + "      const administrator = 'to whoever administers this installation'\n"
    + '      return fromAssertedEscalation(\n'
    + "        direction as { action: 'ESCALATE'; target: 'THIS_RECORD_AND_ITS_SYNC_ROW'; naming: 'SYNC_ROW' },\n"
    + "        direction.naming === 'SYNC_ROW'\n"
    + '          ? `ESCALATE sync row ${context.syncRowId}, with this record, ${administrator}`\n'
    + "          : `${direction.caseForm === 'SENTENCE' ? 'Escalate' : 'escalate'} this record ${administrator}`,\n"
    + '      )\n'
    + '    }',
  ).replace(
    'function andList(',
    'function fromAssertedEscalation(\n'
    + "  claimed: { action: 'ESCALATE'; target: 'THIS_RECORD_AND_ITS_SYNC_ROW'; naming: 'SYNC_ROW' },\n"
    + '  reviewed: string,\n'
    + '): string {\n'
    + "  const recordOnly: string = 'RECORD_ONLY'\n"
    + "  return claimed.naming === recordOnly ? '" + UNDECLARED_REMOTE_ACTION + "' : reviewed\n"
    + '}\n\nfunction andList(',
  )
  assert.notEqual(viaAssertedArgument, model, 'the asserted-argument mutation must actually have been applied')
  assert.deepEqual(
    modelDiagnostics(viaAssertedArgument), modelDiagnostics(model),
    'the asserted-argument mutation must type-check exactly as the shipped model does — the asserted type IS '
    + 'one member of the union being asserted from, so this is an assertion TypeScript allows',
  )
  const assertedArgumentComplaints = judgeRendererOutput(viaAssertedArgument)
  assert.ok(
    assertedArgumentComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL, THE CODEX ROUTE: a parameter\'s declared literal type is knowledge about the program only as far '
    + 'as the ARGUMENT bound to it is. An `as` at the call site manufactures the parameter\'s contract, and the '
    + `helper boundary is not a laundering step. Saw: ${JSON.stringify(assertedArgumentComplaints)}`,
  )
  // ...AND PROPAGATING THE UNKNOWN DOES NOT CLOSE IT, which is the answer to "is (2) still needed":
  // the receiver here is OPAQUE, not UNKNOWN, so fix (1) never fires and the fold happens anyway.
  assert.deepEqual(
    judgeRendererOutput(viaAssertedArgument, {}, 'SYMBOLIC', 'CALL_LOCAL', 'PROPAGATED'), [],
    'THE ORDERING FIX ALONE MUST STILL LET THIS THROUGH — it is why argument provenance is carried as well as '
    + 'the UNKNOWN propagated. If this were also refused, carrying provenance would be dead weight',
  )
  assert.deepEqual(
    judgeRendererOutput(viaAssertedArgument, {}, 'SYMBOLIC', 'CALL_LOCAL', 'DEFERRED'), [],
    'and so must the round-23 evaluator entire',
  )
  // ...and this one the runtime pass WOULD have caught, which is the difference between the two
  // halves of (L) stated as an assertion rather than left to the reader: it fires for every context,
  // so it is only the STATIC reach that (L2) is about. (L1) is the one no sampling closes.
  const launderedEscalation = (direction: LocalDirection, context: LocalDirectionContext): string => (
    direction.action === 'ESCALATE' && direction.naming === 'RECORD_ONLY'
      ? UNDECLARED_REMOTE_ACTION
      : renderLocalDirection(direction, context)
  )
  for (const context of RUNTIME_CONTEXTS) {
    assert.throws(
      () => assertRenderedInventory(
        (direction) => launderedEscalation(direction, context),
        (text) => substitutePlaceholders(text, context),
      ),
      /is NOT the reviewed sentence for it/,
    )
  }

  // (M) AN OMITTED ARGUMENT, WHOSE DEFAULT CARRIES THE ASSERTION — THE ROUND-25 ROUTE (Codex HIGH),
  // and the fourth control here about the EVALUATOR. Round 24 closed the laundering that goes
  // through a written-out argument by carrying its provenance into the parameter. It then read the
  // ABSENCE of such an entry as a positive fact: "no origin recorded, so nobody passed one, so this
  // walk supplied this root itself and its declared type is the module's own word". That inference
  // is false for an INTERNAL CALL WITH AN OMITTED ARGUMENT. JavaScript does not leave the parameter
  // unbound: it evaluates the parameter's DEFAULT INITIALIZER, and that initializer is an
  // expression like any other — it can be an `as`. So the assertion moves from the call site to the
  // parameter list, the walk records nothing for it, and the manufactured literal is trusted for
  // exactly the reason round 24 wrote down.
  //
  // (M1) THE DEFAULT. `claimed` is never passed; its default asserts the real context into a
  // literal `syncRowId`, and the branch keyed on that literal is pruned. At run time `claimed` IS
  // the context, so the branch is live for any id — including one nobody sampled.
  const viaDefaultedParameter = model.replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    '      return fromDefaultedContext(context)',
  ).replace(
    'function andList(',
    'function fromDefaultedContext(\n'
    + '  runtime: LocalDirectionContext,\n'
    + "  claimed: { syncRowId: 'claimed-row' } = runtime as { syncRowId: 'claimed-row' },\n"
    + '): string {\n'
    + "  const offSampleRow: string = '" + OFF_SAMPLE_SYNC_ROW + "'\n"
    + '  return claimed.syncRowId === offSampleRow\n'
    + "    ? '" + UNDECLARED_REMOTE_ACTION + "'\n"
    + "    : 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + '}\n\nfunction andList(',
  )
  assert.notEqual(viaDefaultedParameter, model, 'the defaulted-parameter mutation must actually have been applied')
  // AND IT IS A MUTATION THE COMPILER ADMITS, byte for byte the same diagnostics as the shipped
  // model: `LocalDirectionContext` is comparable to `{ syncRowId: 'claimed-row' }`, so the
  // assertion is legal, and `offSampleRow` is `string`, so the comparison is not the "have no
  // overlap" one TypeScript rejects.
  assert.deepEqual(
    modelDiagnostics(viaDefaultedParameter), modelDiagnostics(model),
    'the defaulted-parameter mutation must type-check exactly as the shipped model does, or it is not a route '
    + 'anybody could take',
  )
  const defaultedComplaints = judgeRendererOutput(viaDefaultedParameter)
  assert.ok(
    defaultedComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL, THE CODEX ROUTE: an omitted argument takes its parameter\'s DEFAULT — the default\'s value and '
    + 'the default\'s provenance. A parameter list is not a laundering step, and "no argument was recorded" is '
    + `not a licence to trust the annotation. Saw: ${JSON.stringify(defaultedComplaints)}`,
  )
  // ...AND THE ROUND-24 EVALUATOR LETS IT THROUGH, asserted rather than described — the same shape
  // as (J), (K) and (L). Re-run the SAME judgement over the SAME mutated renderer with an omitted
  // argument binding nothing and trust inferred from that absence: a clean inventory, while the
  // sentence ships.
  assert.deepEqual(
    judgeRendererOutput(viaDefaultedParameter, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'UNBOUND', 'INFERRED'), [],
    'THE ROUND-24 EVALUATOR MUST STILL LET IT THROUGH — if it also refused this, control (M) would be passing '
    + 'for some other reason and would prove nothing about either half',
  )
  assert.deepEqual(
    judgeRendererOutput(viaDefaultedParameter, {}, 'SYMBOLIC', 'CALL_LOCAL', 'DEFERRED', 'UNBOUND', 'INFERRED'), [],
    'and so must the round-23 evaluator entire',
  )
  // ...and EITHER HALF ALONE closes THIS route, which is stated rather than implied: modelling the
  // default binds `claimed` to the context and its symbolic id, and naming the trusted roots makes
  // an unbound non-root parameter unknown. (M2) below is the route only the second half closes, so
  // neither is decoration.
  assert.ok(
    judgeRendererOutput(viaDefaultedParameter, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'INFERRED').length > 0,
    'modelling default-parameter semantics must close this route on its own',
  )
  assert.ok(
    judgeRendererOutput(viaDefaultedParameter, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'UNBOUND', 'NAMED').length > 0,
    'and so must reserving argument-less trust to the roots this walk names, on its own',
  )
  // ...AND THE RUNTIME PASS CANNOT SEE IT, asserted against the sample that pass actually uses. The
  // laundered branch is keyed on a sync row id exactly as (L1)'s is — the same run-time behaviour,
  // reached through a parameter default instead of an argument — so the same `laundered` renderer
  // measures it: all four sampled contexts report the reviewed inventory, and the off-sample id
  // does not.
  assert.equal(RUNTIME_CONTEXTS.length, 4, 'the four sampled contexts, unchanged')
  for (const context of RUNTIME_CONTEXTS) {
    assertRenderedInventory(
      (direction) => laundered(direction, context),
      (text) => substitutePlaceholders(text, context),
    )
  }
  assert.throws(
    () => assertRenderedInventory(
      (direction) => laundered(direction, offSampleContext),
      (text) => substitutePlaceholders(text, offSampleContext),
    ),
    /is NOT the reviewed sentence for it/,
    'and the SAME renderer refused the moment the id is one nobody sampled — no finite sample of an '
    + 'unbounded id closes this route, which is why it has to be closed statically',
  )

  // (M2) THE PARAMETER WITH NO ARGUMENT AND NO DEFAULT, which is the half modelling defaults does
  // NOT reach. TypeScript admits the call because the parameter is optional; the walk then invents
  // an OPAQUE root for it and folds its asserted annotation. What ships is not an unreviewed
  // sentence but a renderer that cannot emit the reviewed one at all — `claimed` is `undefined` at
  // run time and `claimed!.syncRowId` throws — and round 24's evaluator reports a clean inventory
  // for it. THAT is why the trusted set has to be written down: the walk was not distinguishing
  // "this walk created this value" from "nobody gave this value to anybody".
  const viaArgumentlessParameter = model.replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    '      return fromArgumentlessParameter()',
  ).replace(
    'function andList(',
    "function fromArgumentlessParameter(claimed?: { syncRowId: 'claimed-row' }): string {\n"
    + "  const offSampleRow: string = '" + OFF_SAMPLE_SYNC_ROW + "'\n"
    + '  return claimed!.syncRowId === offSampleRow\n'
    + "    ? '" + UNDECLARED_REMOTE_ACTION + "'\n"
    + "    : 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + '}\n\nfunction andList(',
  )
  assert.notEqual(viaArgumentlessParameter, model, 'the argument-less-parameter mutation must actually have been applied')
  assert.deepEqual(
    modelDiagnostics(viaArgumentlessParameter), modelDiagnostics(model),
    'the argument-less-parameter mutation must type-check exactly as the shipped model does — an optional '
    + 'parameter may be omitted, and the non-null assertion is one TypeScript allows',
  )
  const argumentlessComplaints = judgeRendererOutput(viaArgumentlessParameter)
  assert.ok(
    argumentlessComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL: an unbound parameter that is not one of the roots this walk created must be UNKNOWN, so the '
    + 'comparison it decides is indeterminate and BOTH arms are computed — rather than the arm its own '
    + `annotation picks. Saw: ${JSON.stringify(argumentlessComplaints)}`,
  )
  // ...AND MODELLING DEFAULTS DOES NOT CLOSE IT, which is the answer to "is naming the roots still
  // needed": there is no default here to evaluate, so that half never fires and the fold happens
  // exactly as it did in round 24.
  assert.deepEqual(
    judgeRendererOutput(viaArgumentlessParameter, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'INFERRED'), [],
    'MODELLING DEFAULTS ALONE MUST STILL LET THIS THROUGH — it is why the trusted root set is named as well as '
    + 'defaults modelled. If this were also refused, naming the roots would be dead weight',
  )
  assert.deepEqual(
    judgeRendererOutput(viaArgumentlessParameter, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'UNBOUND', 'INFERRED'), [],
    'and the round-24 evaluator entire reports the same clean inventory for a renderer that throws',
  )

  // (M3) AND THE REFUSAL NAMES THE SET, which is the difference between a trusted set that is
  // WRITTEN DOWN and one inferred from a missing map entry. Put the unbound parameter's field
  // straight into the prose and the reason lands in `unresolved`, where a reader is told which
  // parameter was refused and which roots this walk does create. Asserted so that a later round
  // cannot quietly go back to inferring trust while the complaint text still reads the same.
  const viaArgumentlessProse = model.replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    '      return fromArgumentlessProse()',
  ).replace(
    'function andList(',
    "function fromArgumentlessProse(claimed?: { syncRowId: 'claimed-row' }): string {\n"
    + '  return `confirm the invoice PDF stored against the order is the document you expect'
    + '${claimed!.syncRowId}`\n'
    + '}\n\nfunction andList(',
  )
  assert.notEqual(viaArgumentlessProse, model, 'the argument-less prose mutation must actually have been applied')
  assert.deepEqual(
    modelDiagnostics(viaArgumentlessProse), modelDiagnostics(model),
    'the argument-less prose mutation must type-check exactly as the shipped model does',
  )
  const argumentlessProse = computeRendererOutput(viaArgumentlessProse)
  assert.ok(
    argumentlessProse.unresolved.some((reason) => reason.includes('"claimed" is a PARAMETER no call bound')
      && reason.includes('renderLocalDirection, renderLocalDirectionSequence')),
    'the refusal must NAME the parameter and the roots this walk creates, so the trusted set is readable at '
    + `the point of refusal rather than implied by an absence. Saw: ${JSON.stringify(argumentlessProse.unresolved)}`,
  )
  // ...and round 24 folded it to the annotation instead, shipping a sentence built out of a literal
  // type nobody's argument ever carried.
  assert.ok(
    judgeRendererOutput(viaArgumentlessProse, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'UNBOUND', 'INFERRED')
      .some((complaint) => complaint.includes('claimed-row')),
    'the round-24 walk must have folded the asserted annotation into the prose, or (M3) is about nothing',
  )

  // (N) THE DEFAULT ON A ROOT PARAMETER — THE ROUND-26 ROUTE (Codex HIGH), and the control about
  // WHO THE CALLER IS rather than about what a call carries.
  //
  // Round 25 taught `callImplementation` that an omitted argument takes its parameter's default.
  // That is right at an internal call and wrong at the analyzer's own entry: `rootShapes` passes
  // `[]` because this walk stands in for EVERY formatter that can call the renderer, not because
  // some caller left an argument out. The two were the same code path, so a root parameter with a
  // default was pinned to that default for the entire analysis — and a discriminant the CALLER
  // chooses became a constant the walk had decided.
  //
  // The route is one line of ordinary TypeScript: give the exported renderer a defaulted mode and
  // key a branch on it. Every existing caller still compiles, every existing caller still gets the
  // reviewed sentence, and a formatter that passes the other value gets prose the inventory never
  // read.
  const viaDefaultedRootParameter = model.replace(
    'export function renderLocalDirection(direction: LocalDirection, context: LocalDirectionContext): string {',
    'export function renderLocalDirection(\n'
    + '  direction: LocalDirection,\n'
    + '  context: LocalDirectionContext,\n'
    + "  mode: 'REVIEWED' | 'UNREVIEWED' = 'REVIEWED',\n"
    + '): string {',
  ).replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "      return mode === 'UNREVIEWED'\n"
    + "        ? '" + UNDECLARED_REMOTE_ACTION + "'\n"
    + "        : 'confirm the invoice PDF stored against the order is the document you expect'",
  )
  assert.notEqual(viaDefaultedRootParameter, model, 'the defaulted-root-parameter mutation must actually have been applied')
  // AND IT IS A MUTATION THE COMPILER ADMITS, byte for byte the same diagnostics as the shipped
  // model: the new parameter has a default, so every existing call site still type-checks, and the
  // comparison is between two members of the same declared union.
  assert.deepEqual(
    modelDiagnostics(viaDefaultedRootParameter), modelDiagnostics(model),
    'the defaulted-root-parameter mutation must type-check exactly as the shipped model does, or it is not a '
    + 'route anybody could take',
  )
  const defaultedRootComplaints = judgeRendererOutput(viaDefaultedRootParameter)
  assert.ok(
    defaultedRootComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL, THE CODEX ROUTE: a parameter of a ROOT renderer is a value the caller chooses, whatever default '
    + 'its declaration carries. The analyzer\'s own empty argument list is not an omission, so the default is '
    + `not evaluated and the branch keyed on it is walked both ways. Saw: ${JSON.stringify(defaultedRootComplaints)}`,
  )
  // ...AND THE ROUND-25 EVALUATOR LETS IT THROUGH, asserted rather than described — the same shape
  // as (J) through (M). Re-run the SAME judgement over the SAME mutated renderer with root entry
  // evaluating defaults: a clean inventory, while the sentence ships.
  assert.deepEqual(
    judgeRendererOutput(viaDefaultedRootParameter, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'DEFAULTED'),
    [],
    'THE ROUND-25 EVALUATOR MUST STILL LET IT THROUGH — if it also refused this, control (N) would be passing '
    + 'for some other reason and would prove nothing',
  )
  // ...AND IT IS A ROUTE ROUND 25 OPENED, which is worth stating plainly rather than leaving as an
  // apology: with round 24's binding — an omitted argument binds NOTHING — the root parameter fell
  // straight through to the abstract root value and both arms were already walked. Round 25 was
  // right about internal calls and applied its rule one call too far; the fix is a distinction, not
  // a retreat.
  assert.ok(
    judgeRendererOutput(viaDefaultedRootParameter, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'UNBOUND', 'NAMED', 'DEFAULTED')
      .some((complaint) => complaint.includes('take the second PDF off it')),
    'the round-24 binding must already have refused this — it is what shows round 25 OPENED this route rather '
    + 'than leaving it open, and therefore that the fix belongs at the root-entry distinction',
  )
  // ...AND MODELLING DEFAULTS AT INTERNAL CALLS IS STILL LOAD-BEARING, so round 26 did not undo
  // round 25 while fixing it: (M1)'s route goes through an INTERNAL call with an omitted argument,
  // and it must still be refused with root entry abstract.
  assert.ok(
    judgeRendererOutput(viaDefaultedParameter).length > 0,
    'ROUND 25 MUST STILL HOLD — (M1) goes through an internal omitted argument, and making root entry abstract '
    + 'must not have stopped defaults being modelled where a caller really did omit one',
  )
  // ...and the ROUND-25 rule is what refuses (M1): with root entry abstract AND internal defaults
  // unbound, (M1) is through again. Two rules, each doing its own work.
  assert.deepEqual(
    judgeRendererOutput(viaDefaultedParameter, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'UNBOUND', 'INFERRED', 'ABSTRACT'),
    [],
    'and with internal defaults unbound again (M1) is through, so the two rules are not one rule written twice',
  )

  // (O) THE ASSERTED DEFAULT ON A ROOT PARAMETER — THE ROUND-27 ROUTE (Codex HIGH), and the same
  // axis for the sixth time: a TYPE standing in for a VALUE.
  //
  // Round 26 stopped the analyzer's own `[]` from being read as an omission, so a root parameter
  // is no longer PINNED to its default. But it returned before recording anything at all, and the
  // parameter's DECLARED TYPE was then trusted for exactly round 24's reason — nothing had been
  // traced into it, so it looked like a root this walk supplied itself. `resolveProperty`'s
  // checker-literal fallback then recovered a single literal off that annotation and the branch
  // keyed on it was pruned again, one level further out than round 25 closed it.
  //
  // The route is compiler-clean and needs no helper: the default is an object whose ASSERTED type
  // is a single literal and whose VALUE is the other one. Every existing caller omits the argument,
  // so every existing caller evaluates that object and takes the prohibited arm at run time, while
  // the analyzer reads the annotation and reports a clean inventory.
  const viaAssertedRootDefault = model.replace(
    'export function renderLocalDirection(direction: LocalDirection, context: LocalDirectionContext): string {',
    'export function renderLocalDirection(\n'
    + '  direction: LocalDirection,\n'
    + '  context: LocalDirectionContext,\n'
    + "  options: { mode: 'REVIEWED' } = ({ mode: 'UNREVIEWED' } as unknown as { mode: 'REVIEWED' }),\n"
    + '): string {',
  ).replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "      return options.mode === 'REVIEWED'\n"
    + "        ? 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + "        : '" + UNDECLARED_REMOTE_ACTION + "'",
  ).replace(
    // THE SEQUENCE PASSES THE SAFE VALUE EXPLICITLY, which is what makes this a route through the
    // ROOT and nothing else. Round 25 models an omitted argument at an INTERNAL call, so if the
    // sequence omitted it too, round 25 would evaluate the asserted object there and the sentence
    // would surface through the sequence renderer no matter what the root did — and the control
    // would be about round 25 rather than about round 27. Passing `{ mode: 'REVIEWED' }` is also
    // the realistic shape of the mistake: the caller inside the module is careful, and the DEFAULT
    // is what every caller outside it gets.
    'return sequence.map((direction) => renderLocalDirection(direction, context)).join(\' and \')',
    "return sequence.map((direction) => renderLocalDirection(direction, context, { mode: 'REVIEWED' })).join(' and ')",
  )
  assert.notEqual(viaAssertedRootDefault, model, 'the asserted-root-default mutation must actually have been applied')
  // AND THE COMPILER ADMITS IT, byte for byte: the parameter has a default so every existing call
  // site still type-checks, the assertion goes through `unknown` so it is a legal one, and the
  // comparison is between the declared literal and itself.
  assert.deepEqual(
    modelDiagnostics(viaAssertedRootDefault), modelDiagnostics(model),
    'the asserted-root-default mutation must type-check exactly as the shipped model does, or it is not a '
    + 'route anybody could take',
  )
  const assertedRootComplaints = judgeRendererOutput(viaAssertedRootDefault)
  assert.ok(
    assertedRootComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL, THE CODEX ROUTE: an OPAQUE root parameter whose default ASSERTED its declared type is not a '
    + 'parameter whose annotation is the module\'s own word. The initializer\'s provenance is carried even '
    + `though its value is not, so the fold is refused and both arms are walked. Saw: ${JSON.stringify(assertedRootComplaints)}`,
  )
  // ...and the refusal says WHY, at the point of refusal, rather than the branch merely happening
  // to be walked for some unrelated reason.
  assert.ok(
    computeRendererOutput(viaAssertedRootDefault).unresolved.length === 0,
    'the asserted-root-default mutation must still COMPUTE — the complaint is the sentence it emits, not a '
    + 'value this walk gave up on',
  )
  // ...AND THE ROUND-26 EVALUATOR LETS IT THROUGH, asserted rather than described — the same shape
  // as (J) through (N). Re-run the SAME judgement over the SAME mutated renderer with the root
  // dropping its default's provenance: a clean inventory, while the sentence ships.
  assert.deepEqual(
    judgeRendererOutput(viaAssertedRootDefault, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'ABSTRACT', 'DROPPED'),
    [],
    'THE ROUND-26 EVALUATOR MUST STILL LET IT THROUGH — if it also refused this, control (O) would be passing '
    + 'for some other reason and would prove nothing',
  )
  // ...AND IT IS NOT CLOSED BY ANY OF THE FIVE FIXES THAT CAME BEFORE IT, which is what makes it a
  // sixth round rather than a regression of one of them. Provenance tracking at CALL boundaries
  // (round 24) never sees this argument, because there is no call and no argument; receiver
  // propagation (round 24) never fires, because the receiver is OPAQUE and not UNKNOWN; modelling
  // defaults at internal calls (round 25) is about a different entry; and naming the trusted root
  // set (round 25) is what makes this parameter trusted in the first place.
  assert.deepEqual(
    judgeRendererOutput(viaAssertedRootDefault, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'UNBOUND', 'NAMED', 'ABSTRACT', 'DROPPED'),
    [],
    'round 24\'s unbound-default rule must not close this on its own, or the round-27 distinction is not what '
    + 'is doing the work',
  )
  assert.deepEqual(
    judgeRendererOutput(viaAssertedRootDefault, {}, 'SYMBOLIC', 'TRACKED', 'DEFERRED', 'MODELLED', 'NAMED', 'ABSTRACT', 'DROPPED'),
    [],
    'and neither must receiver propagation — the receiver here is OPAQUE, not UNKNOWN, which is exactly why '
    + 'round 24\'s ordering fix cannot reach it',
  )
  // ...AND THE FIX DOES NOT UNDO ROUND 26. A root parameter whose default is CLEAN is still not
  // pinned to it: (N)'s route carries no assertion, so carrying its provenance records `null` and
  // the branch is still walked both ways for the round-26 reason.
  assert.ok(
    judgeRendererOutput(viaDefaultedRootParameter)
      .some((complaint) => complaint.includes('take the second PDF off it')),
    'ROUND 26 MUST STILL HOLD — a clean default on a root parameter is still not a value the caller did not '
    + 'choose, and carrying provenance must not have turned that back into a fold',
  )
  // ...AND THE RUNTIME PASS CANNOT SEE IT EITHER: the sample calls the renderer the way every
  // caller does, which is with the argument omitted — and at run time that evaluates the asserted
  // object and takes the arm the analyzer had pruned. The sample is judged against the inventory
  // and passes, because the sentence it never reaches is the one that is not in it.
  for (const context of RUNTIME_CONTEXTS) {
    assertRenderedInventory(
      (direction) => renderLocalDirection(direction, context),
      (text) => substitutePlaceholders(text, context),
    )
  }
  // (P) THE ASSERTED COMPUTED KEY — THE ROUND-28 ROUTE (Codex HIGH), and the seventh appearance of
  // one axis: a TYPE standing in for a VALUE.
  //
  // Rounds 22-27 each demanded provenance at the position the round was written for and left one
  // ADJACENT expression position unasked. `literalOrigin` traced the RECEIVER of an element access
  // and never the KEY, so an assertion on the key manufactured the same trusted literal every
  // earlier round was about — and it does it with no call, no argument, no default and no UNKNOWN
  // receiver, which is why not one of the five earlier fixes reaches it.
  //
  // The key is chosen at RUN TIME by the sync row id, which is unbounded. The checker is told it is
  // `'target'`; sampled ids do read `target` and render the reviewed sentence; an off-sample id
  // reads `action` and the comparison goes the other way.
  const viaAssertedKey = model.replace(
    "    case 'CONFIRM':\n"
    + "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "    case 'CONFIRM':\n"
    + "      return direction[(context.syncRowId === '" + OFF_SAMPLE_SYNC_ROW + "' ? 'action' : 'target') as 'target']\n"
    + "        === 'ORDER_INVOICE_PDF'\n"
    + "        ? 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + "        : '" + UNDECLARED_REMOTE_ACTION + "'",
  )
  assert.notEqual(viaAssertedKey, model, 'the asserted-key mutation must actually have been applied')
  // AND THE COMPILER ADMITS IT, byte for byte. The asserted type is one member of the union being
  // asserted from, so the assertion is one TypeScript allows outright; the access then types as
  // `direction['target']`, which in this narrowed branch is exactly `'ORDER_INVOICE_PDF'`, and the
  // comparison is between that literal and itself.
  assert.deepEqual(
    modelDiagnostics(viaAssertedKey), modelDiagnostics(model),
    'the asserted-key mutation must type-check exactly as the shipped model does, or it is not a route '
    + 'anybody could take',
  )
  const assertedKeyComplaints = judgeRendererOutput(viaAssertedKey)
  assert.ok(
    assertedKeyComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL, THE CODEX ROUTE: an element access has TWO expressions in it and its literal type is chosen by '
    + 'both. Demanding provenance of the receiver and not of the key left the key free to manufacture the '
    + `literal. Saw: ${JSON.stringify(assertedKeyComplaints)}`,
  )
  // ...and the refusal is a REFUSAL TO FOLD, not a value this walk gave up on: the walk still
  // computes every sentence, it just takes both arms of the comparison it cannot decide.
  assert.deepEqual(
    computeRendererOutput(viaAssertedKey).unresolved, [],
    'the asserted-key mutation must still COMPUTE — the complaint is the sentence it emits, not an expression '
    + 'this walk could not read',
  )
  // ...AND THE PRE-FIX ANALYZER REPORTS IT CLEAN, asserted rather than described — the same shape as
  // (J) through (O). Re-run the SAME judgement over the SAME mutated renderer with every round-22-to-27
  // fix in place and only the key's provenance ignored: no complaint at all, while the sentence ships.
  assert.deepEqual(
    judgeRendererOutput(
      viaAssertedKey, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'ABSTRACT', 'CARRIED', 'IGNORED',
    ),
    [],
    'THE PRE-FIX ANALYZER MUST STILL LET IT THROUGH — if it also refused this, control (P) would be passing '
    + 'for some other reason and would prove nothing',
  )
  // ...AND NONE OF THE SIX FIXES THAT CAME BEFORE IT CLOSES IT, which is what makes this a seventh
  // round rather than a regression of one of them. Each is turned OFF in turn with the key rule ON:
  // if any of them were what refuses this route, one of these would come back clean.
  const withoutEachEarlierFix = [
    ['receiver propagation (round 24)', judgeRendererOutput(viaAssertedKey, {}, 'SYMBOLIC', 'TRACKED', 'DEFERRED')],
    ['argument provenance (round 24)', judgeRendererOutput(viaAssertedKey, {}, 'SYMBOLIC', 'CALL_LOCAL', 'PROPAGATED')],
    ['modelled defaults (round 25)', judgeRendererOutput(
      viaAssertedKey, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'UNBOUND',
    )],
    ['the named root set (round 25)', judgeRendererOutput(
      viaAssertedKey, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'INFERRED',
    )],
    ['abstract root entry (round 26)', judgeRendererOutput(
      viaAssertedKey, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'DEFAULTED',
    )],
    ['root default provenance (round 27)', judgeRendererOutput(
      viaAssertedKey, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'ABSTRACT', 'DROPPED',
    )],
  ] as const
  assert.equal(
    withoutEachEarlierFix.length, 6,
    'all six earlier fixes must be switched off in turn, or this loop is a claim about a subset of them',
  )
  for (const [what, complaints] of withoutEachEarlierFix) {
    assert.ok(
      complaints.some((complaint) => complaint.includes('take the second PDF off it')),
      `THE KEY RULE IS WHAT CLOSES THIS: with ${what} switched off it is still refused, so it is not that fix `
      + 'wearing a new coat',
    )
  }
  // ...AND THE FIX DOES NOT UNDO ANY OF THEM. The six routes those controls are about are still
  // refused with the key rule in place — asserted here so that "keep all existing controls passing"
  // is a statement this control makes rather than one a reader has to take on trust.
  const earlierRoutes = [
    ['(L1) the runtime copy', viaRuntimeCopy],
    ['(L2) the asserted argument', viaAssertedArgument],
    ['(M) the asserted default', viaDefaultedParameter],
    ['(N) the defaulted root parameter', viaDefaultedRootParameter],
    ['(O) the asserted root default', viaAssertedRootDefault],
  ] as const
  assert.equal(earlierRoutes.length, 5, 'every earlier Codex route is re-judged here, not a sample of them')
  for (const [what, mutated] of earlierRoutes) {
    assert.ok(
      judgeRendererOutput(mutated).length > 0,
      `${what} must still be refused — demanding provenance of a key must not have loosened anything else`,
    )
  }
  // ...AND THE RUNTIME PASS CANNOT SEE IT, asserted against the sample that pass actually uses. The
  // key is chosen by a sync row id and sync row ids are unbounded: hand-run the mutated renderer's
  // own selection over all four RUNTIME_CONTEXTS and every one reports the reviewed inventory,
  // because none of them is the id the key is chosen by. That is the whole reason this route has to
  // be closed statically — no finite sample of an unbounded id closes it.
  const byAssertedKey = (direction: LocalDirection, context: LocalDirectionContext): string => (
    direction.action === 'CONFIRM'
      ? (direction[(context.syncRowId === OFF_SAMPLE_SYNC_ROW ? 'action' : 'target') as 'target'] as string)
        === 'ORDER_INVOICE_PDF'
        ? renderLocalDirection(direction, context)
        : UNDECLARED_REMOTE_ACTION
      : renderLocalDirection(direction, context)
  )
  assert.equal(RUNTIME_CONTEXTS.length, 4, 'the four sampled contexts, unchanged')
  for (const context of RUNTIME_CONTEXTS) {
    assertRenderedInventory(
      (direction) => byAssertedKey(direction, context),
      (text) => substitutePlaceholders(text, context),
    )
  }
  const offSampleKeyContext: LocalDirectionContext = { ledger: 'QuickBooks', syncRowId: OFF_SAMPLE_SYNC_ROW }
  assert.throws(
    () => assertRenderedInventory(
      (direction) => byAssertedKey(direction, offSampleKeyContext),
      (text) => substitutePlaceholders(text, offSampleKeyContext),
    ),
    /is NOT the reviewed sentence for it/,
    'and the SAME renderer refused the moment the id is one nobody sampled — so what the four contexts '
    + 'established was the ids they carry, not the renderer',
  )

  // (Q) THE CLASS FIELD READ OFF A ROOT PARAMETER — THE ROUND-29 ROUTE (Codex HIGH), and the eighth
  // appearance of one axis: a TYPE standing in for a VALUE.
  //
  // ROUND 28 DISCLOSED THIS POSITION RATHER THAN CLOSING IT, and gave a reason for believing it
  // unreachable: a class identifier resolves to a `ClassDeclaration` this walk cannot compute, and a
  // `new` resolves to one `implementationsOf` refuses, so the receiver is UNKNOWN and round 24's
  // propagation kills the access before the annotation is read. THE REASON WAS WRONG, and wrong in a
  // way worth writing down rather than quietly patching: it fences the receivers you have to
  // EVALUATE, and the ROOTS produce a different kind. `rootShapes` trusts every parameter of the two
  // renderer roots, and `resolveIdentifier` hands a non-context, non-list root straight back as
  // OPAQUE. An OPAQUE receiver is not an UNKNOWN one, so propagation never fires.
  //
  // So the route evaluates no class identifier and no `new` anywhere: a class-TYPED root parameter
  // whose field is ANNOTATED as one literal and INITIALIZED to the other through an assertion. It is
  // (O)'s asserted default one declaration kind further along, and no fix from rounds 22 to 28
  // reaches it — there is no call at the root, no argument, no default, no UNKNOWN and no key.
  const viaClassFieldAnnotation = model.replace(
    'export function renderLocalDirection(direction: LocalDirection, context: LocalDirectionContext): string {',
    'export class RenderMode {\n'
    + "  readonly mode: 'REVIEWED' = 'UNREVIEWED' as unknown as 'REVIEWED'\n"
    + '}\n'
    + '\n'
    + 'export function renderLocalDirection(\n'
    + '  direction: LocalDirection,\n'
    + '  context: LocalDirectionContext,\n'
    + '  render: RenderMode,\n'
    + '): string {',
  ).replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "      return render.mode === 'REVIEWED'\n"
    + "        ? 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + "        : '" + UNDECLARED_REMOTE_ACTION + "'",
  ).replace(
    // THE SEQUENCE FORWARDS ITS OWN ROOT PARAMETER, which is what keeps this a route through a class
    // FIELD and nothing else. An argument of `new RenderMode()` here would be refused by round 24's
    // argument provenance — a `NewExpression` is not a literal type this walk can trace — and the
    // control would then pass for round 24's reason with the field rule doing nothing. Forwarding a
    // root parameter carries provenance `null`, so both renderers reach the field the same way: an
    // OPAQUE receiver whose annotation is read.
    'export function renderLocalDirectionSequence(\n'
    + '  sequence: LocalDirectionSequence,\n'
    + '  context: LocalDirectionContext,\n'
    + '): string {\n'
    + "  return sequence.map((direction) => renderLocalDirection(direction, context)).join(' and ')",
    'export function renderLocalDirectionSequence(\n'
    + '  sequence: LocalDirectionSequence,\n'
    + '  context: LocalDirectionContext,\n'
    + '  render: RenderMode,\n'
    + '): string {\n'
    + "  return sequence.map((direction) => renderLocalDirection(direction, context, render)).join(' and ')",
  )
  // ALL THREE EDITS LANDED. `notEqual` alone would pass on one of them, and a route that changed the
  // renderer but not the sequence is a different control from the one this comment describes.
  for (const fragment of [
    "readonly mode: 'REVIEWED' = 'UNREVIEWED' as unknown as 'REVIEWED'",
    "return render.mode === 'REVIEWED'",
    'renderLocalDirection(direction, context, render)',
  ]) {
    assert.ok(
      viaClassFieldAnnotation.includes(fragment),
      `the class-field mutation must actually have been applied — missing ${JSON.stringify(fragment)}`,
    )
  }
  // AND THE COMPILER ADMITS IT, byte for byte the same diagnostics as the shipped model: the
  // assertion goes through `unknown` so it is a legal one, the field's declared type is the literal
  // the comparison is against, and both call sites pass the new parameter.
  assert.deepEqual(
    modelDiagnostics(viaClassFieldAnnotation), modelDiagnostics(model),
    'the class-field mutation must type-check exactly as the shipped model does, or it is not a route anybody '
    + 'could take',
  )
  const classFieldComplaints = judgeRendererOutput(viaClassFieldAnnotation)
  assert.ok(
    classFieldComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL, THE CODEX ROUTE: a class FIELD pairs an annotation with an expression, so the annotation is '
    + 'honest only as far as that expression is. Read off an OPAQUE root parameter there is no receiver to '
    + `propagate and no argument to trace, so the field's own initializer is the only thing left to ask. Saw: ${
      JSON.stringify(classFieldComplaints)}`,
  )
  // ...and the walk still COMPUTES every sentence — the complaint is the prose it emits, not an
  // expression it gave up on, so the branch is walked both ways for this reason and not by accident.
  assert.deepEqual(
    computeRendererOutput(viaClassFieldAnnotation).unresolved, [],
    'the class-field mutation must still COMPUTE — the complaint is the sentence it emits, not an expression '
    + 'this walk could not read',
  )
  // ...AND THE PRE-FIX ANALYZER REPORTS IT CLEAN, asserted rather than described — the same shape as
  // (J) through (P). Re-run the SAME judgement over the SAME mutated renderer with every round-22-to-28
  // fix in place and only the field's provenance ignored: no complaint at all, while the sentence ships.
  assert.deepEqual(
    judgeRendererOutput(
      viaClassFieldAnnotation, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'ABSTRACT', 'CARRIED',
      'DEMANDED', 'IGNORED',
    ),
    [],
    'THE PRE-FIX ANALYZER MUST STILL LET IT THROUGH — if it also refused this, control (Q) would be passing '
    + 'for some other reason and would prove nothing',
  )
  // ...AND NONE OF THE SEVEN FIXES THAT CAME BEFORE IT CLOSES IT, which is what makes this an eighth
  // round rather than a regression of one of them — and, specifically, what disproves round 28's
  // reachability argument: receiver propagation is in that list.
  const withoutEachFixBeforeTheField = [
    ['receiver propagation (round 24)', judgeRendererOutput(
      viaClassFieldAnnotation, {}, 'SYMBOLIC', 'TRACKED', 'DEFERRED',
    )],
    ['argument provenance (round 24)', judgeRendererOutput(
      viaClassFieldAnnotation, {}, 'SYMBOLIC', 'CALL_LOCAL', 'PROPAGATED',
    )],
    ['modelled defaults (round 25)', judgeRendererOutput(
      viaClassFieldAnnotation, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'UNBOUND',
    )],
    ['the named root set (round 25)', judgeRendererOutput(
      viaClassFieldAnnotation, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'INFERRED',
    )],
    ['abstract root entry (round 26)', judgeRendererOutput(
      viaClassFieldAnnotation, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'DEFAULTED',
    )],
    ['root default provenance (round 27)', judgeRendererOutput(
      viaClassFieldAnnotation, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'ABSTRACT', 'DROPPED',
    )],
    ['key provenance (round 28)', judgeRendererOutput(
      viaClassFieldAnnotation, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'ABSTRACT', 'CARRIED',
      'IGNORED',
    )],
  ] as const
  assert.equal(
    withoutEachFixBeforeTheField.length, 7,
    'all seven earlier fixes must be switched off in turn, or this loop is a claim about a subset of them',
  )
  for (const [what, complaints] of withoutEachFixBeforeTheField) {
    assert.ok(
      complaints.some((complaint) => complaint.includes('take the second PDF off it')),
      `THE FIELD RULE IS WHAT CLOSES THIS: with ${what} switched off it is still refused, so it is not that fix `
      + 'wearing a new coat',
    )
  }
  // ...AND THE RUNTIME PASS DOES SEE THIS ONE, which is worth stating rather than borrowing (P)'s
  // sentence. The field is a constant, so every caller that reaches CONFIRM gets the prohibited
  // sentence and any sample that renders it fails. What the analyzer must not do is report the
  // inventory CLEAN over it — a clean static report is what makes the sampled pass look redundant.
  // (Q2) is the same position with no sample able to see it at all.
  const byClassField = (direction: LocalDirection, context: LocalDirectionContext): string => (
    direction.action === 'CONFIRM' ? UNDECLARED_REMOTE_ACTION : renderLocalDirection(direction, context)
  )
  assert.throws(
    () => assertRenderedInventory(
      (direction) => byClassField(direction, RUNTIME_CONTEXTS[0]!),
      (text) => substitutePlaceholders(text, RUNTIME_CONTEXTS[0]!),
    ),
    /is NOT the reviewed sentence for it/,
    'the mutated renderer emits the prohibited sentence at run time for every caller, so this route is one a '
    + 'sample DOES catch — what the control is about is the analyzer reporting clean over it',
  )

  // (Q2) THE SAME FIELD WITH NO INITIALIZER AT ALL, assigned in the constructor from the sync row id
  // — the half of the round-29 rule that "recursively check the initializer" does not reach, and the
  // one no sample closes.
  //
  // A class field may be annotated and never initialized where it is declared. Its literal type is
  // then an annotation backed by nothing this walk reads, and whatever assigns it may be keyed on a
  // value that is unbounded at run time. REQUIRING the initializer is what refuses this; tracing one
  // would find nothing to trace.
  const viaClassFieldWithoutInitializer = model.replace(
    'export function renderLocalDirection(direction: LocalDirection, context: LocalDirectionContext): string {',
    'export class RenderMode {\n'
    + "  readonly mode: 'REVIEWED'\n"
    + '\n'
    + '  constructor(syncRowId: string) {\n'
    + "    this.mode = (syncRowId === '" + OFF_SAMPLE_SYNC_ROW + "' ? 'UNREVIEWED' : 'REVIEWED') as 'REVIEWED'\n"
    + '  }\n'
    + '}\n'
    + '\n'
    + 'export function renderLocalDirection(\n'
    + '  direction: LocalDirection,\n'
    + '  context: LocalDirectionContext,\n'
    + '  render: RenderMode,\n'
    + '): string {',
  ).replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "      return render.mode === 'REVIEWED'\n"
    + "        ? 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + "        : '" + UNDECLARED_REMOTE_ACTION + "'",
  ).replace(
    'export function renderLocalDirectionSequence(\n'
    + '  sequence: LocalDirectionSequence,\n'
    + '  context: LocalDirectionContext,\n'
    + '): string {\n'
    + "  return sequence.map((direction) => renderLocalDirection(direction, context)).join(' and ')",
    'export function renderLocalDirectionSequence(\n'
    + '  sequence: LocalDirectionSequence,\n'
    + '  context: LocalDirectionContext,\n'
    + '  render: RenderMode,\n'
    + '): string {\n'
    + "  return sequence.map((direction) => renderLocalDirection(direction, context, render)).join(' and ')",
  )
  for (const fragment of [
    "readonly mode: 'REVIEWED'\n",
    'constructor(syncRowId: string) {',
    "return render.mode === 'REVIEWED'",
    'renderLocalDirection(direction, context, render)',
  ]) {
    assert.ok(
      viaClassFieldWithoutInitializer.includes(fragment),
      `the uninitialized-field mutation must actually have been applied — missing ${JSON.stringify(fragment)}`,
    )
  }
  assert.deepEqual(
    modelDiagnostics(viaClassFieldWithoutInitializer), modelDiagnostics(model),
    'the uninitialized-field mutation must type-check exactly as the shipped model does — a `readonly` field '
    + 'assigned in the constructor is definitely assigned, and the assertion narrows a union to one of its own '
    + 'members',
  )
  const uninitializedFieldComplaints = judgeRendererOutput(viaClassFieldWithoutInitializer)
  assert.ok(
    uninitializedFieldComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL: a class field with NO initializer is an annotation this walk has no expression for, so it cannot '
    + `be folded either. Saw: ${JSON.stringify(uninitializedFieldComplaints)}`,
  )
  assert.deepEqual(
    judgeRendererOutput(
      viaClassFieldWithoutInitializer, {}, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'ABSTRACT',
      'CARRIED', 'DEMANDED', 'IGNORED',
    ),
    [],
    'THE PRE-FIX ANALYZER MUST STILL LET IT THROUGH, or (Q2) proves nothing',
  )
  // ...AND NO SAMPLE CLOSES IT. The field is assigned from the sync row id, and sync row ids are
  // unbounded: hand-run the mutated renderer's own selection over all four RUNTIME_CONTEXTS and
  // every one reports the reviewed inventory, because none of them carries the id the constructor
  // keys on. That is the whole reason this position has to be closed statically.
  const byUninitializedField = (direction: LocalDirection, context: LocalDirectionContext): string => (
    direction.action === 'CONFIRM' && context.syncRowId === OFF_SAMPLE_SYNC_ROW
      ? UNDECLARED_REMOTE_ACTION
      : renderLocalDirection(direction, context)
  )
  assert.equal(RUNTIME_CONTEXTS.length, 4, 'the four sampled contexts, unchanged')
  for (const context of RUNTIME_CONTEXTS) {
    assertRenderedInventory(
      (direction) => byUninitializedField(direction, context),
      (text) => substitutePlaceholders(text, context),
    )
  }
  const offSampleFieldContext: LocalDirectionContext = { ledger: 'Xero', syncRowId: OFF_SAMPLE_SYNC_ROW }
  assert.throws(
    () => assertRenderedInventory(
      (direction) => byUninitializedField(direction, offSampleFieldContext),
      (text) => substitutePlaceholders(text, offSampleFieldContext),
    ),
    /is NOT the reviewed sentence for it/,
    'and the SAME renderer refused the moment the id is one nobody sampled — so what the four contexts '
    + 'established was the ids they carry, not the renderer',
  )

  // (Q3) THE ENUM MEMBER, which round 28 held closed for the same wrong reason and which is
  // therefore open for the same reason.
  //
  // An enum member's initializer cannot carry an assertion — TypeScript refuses a computed value in
  // a string enum outright (TS18033) — so (Q)'s exact shape is not available here. What IS available
  // is the same position reached through a root parameter typed `typeof E`, over an AMBIENT enum:
  // its members are values in code this program does not contain. The declaration says `'REVIEWED'`;
  // the module that ships the implementation says whatever it says, and this walk has never read it.
  // That is the reason `resolveIdentifier` already refuses an ambient VARIABLE rather than reading
  // its declared type as a value, applied to the one declaration kind that had been exempt from it.
  const AMBIENT_MODE_FILE = 'lib/domain/accounting/ambient-render-mode.d.ts'
  const ambientMode = { [AMBIENT_MODE_FILE]: "declare enum AmbientRenderMode { MODE = 'REVIEWED' }\n" }
  const viaAmbientEnumMember = model.replace(
    'export function renderLocalDirection(direction: LocalDirection, context: LocalDirectionContext): string {',
    'export function renderLocalDirection(\n'
    + '  direction: LocalDirection,\n'
    + '  context: LocalDirectionContext,\n'
    + '  render: typeof AmbientRenderMode,\n'
    + '): string {',
  ).replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "      return (render.MODE as string) === 'REVIEWED'\n"
    + "        ? 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + "        : '" + UNDECLARED_REMOTE_ACTION + "'",
  ).replace(
    'export function renderLocalDirectionSequence(\n'
    + '  sequence: LocalDirectionSequence,\n'
    + '  context: LocalDirectionContext,\n'
    + '): string {\n'
    + "  return sequence.map((direction) => renderLocalDirection(direction, context)).join(' and ')",
    'export function renderLocalDirectionSequence(\n'
    + '  sequence: LocalDirectionSequence,\n'
    + '  context: LocalDirectionContext,\n'
    + '  render: typeof AmbientRenderMode,\n'
    + '): string {\n'
    + "  return sequence.map((direction) => renderLocalDirection(direction, context, render)).join(' and ')",
  )
  assert.ok(
    viaAmbientEnumMember.includes("(render.MODE as string) === 'REVIEWED'")
      && viaAmbientEnumMember.includes('renderLocalDirection(direction, context, render)'),
    'the ambient-enum-member mutation must actually have been applied',
  )
  assert.deepEqual(
    modelDiagnostics(viaAmbientEnumMember, ambientMode), modelDiagnostics(model),
    'the ambient-enum-member mutation must type-check exactly as the shipped model does, or it is not a route '
    + 'anybody could take',
  )
  const ambientEnumComplaints = judgeRendererOutput(viaAmbientEnumMember, ambientMode)
  assert.ok(
    ambientEnumComplaints.some((complaint) => complaint.startsWith('emits a sentence nobody reviewed')
      && complaint.includes('take the second PDF off it')),
    'CONTROL: an ENUM MEMBER declared without an implementation this walk can read is a claim about code this '
    + `program does not contain, so its literal type is not knowledge about the program. Saw: ${
      JSON.stringify(ambientEnumComplaints)}`,
  )
  assert.deepEqual(
    judgeRendererOutput(
      viaAmbientEnumMember, ambientMode, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'ABSTRACT',
      'CARRIED', 'DEMANDED', 'IGNORED',
    ),
    [],
    'THE PRE-FIX ANALYZER MUST STILL LET IT THROUGH — the enum member folded on its annotation exactly as the '
    + 'class field did, or (Q3) proves nothing',
  )
  // ...and the receiver here is an OPAQUE ROOT PARAMETER and not the enum object, which is what
  // makes it a route at all: a bare `AmbientRenderMode.MODE` goes through `resolveIdentifier`, which
  // cannot compute an `EnumDeclaration` and returns UNKNOWN, and round 24's propagation ends it
  // before any member is read. Asserted, because that distinction IS round 28's mistake restated for
  // the other declaration kind — one receiver class was fenced and the other was assumed to be the
  // same one.
  const viaEnumObjectDirectly = model.replace(
    "      return 'confirm the invoice PDF stored against the order is the document you expect'",
    "      return (AmbientRenderMode.MODE as string) === 'REVIEWED'\n"
    + "        ? 'confirm the invoice PDF stored against the order is the document you expect'\n"
    + "        : '" + UNDECLARED_REMOTE_ACTION + "'",
  )
  assert.ok(
    judgeRendererOutput(
      viaEnumObjectDirectly, ambientMode, 'SYMBOLIC', 'TRACKED', 'PROPAGATED', 'MODELLED', 'NAMED', 'ABSTRACT',
      'CARRIED', 'DEMANDED', 'IGNORED',
    ).some((complaint) => complaint.includes('take the second PDF off it')),
    'the PRE-FIX analyzer must already refuse the enum read through the enum OBJECT — that is the receiver '
    + 'round 28\'s argument was about, and it is not the one the roots produce',
  )

  // ...AND THE FIX DOES NOT UNDO ANY OF THE SEVEN. The routes those controls are about are still
  // refused with the field rule in place — asserted here so that "keep all existing controls
  // passing" is a statement this control makes rather than one a reader has to take on trust.
  const routesBeforeTheField = [
    ['(L1) the runtime copy', viaRuntimeCopy],
    ['(L2) the asserted argument', viaAssertedArgument],
    ['(M) the asserted default', viaDefaultedParameter],
    ['(N) the defaulted root parameter', viaDefaultedRootParameter],
    ['(O) the asserted root default', viaAssertedRootDefault],
    ['(P) the asserted key', viaAssertedKey],
  ] as const
  assert.equal(routesBeforeTheField.length, 6, 'every earlier Codex route is re-judged here, not a sample of them')
  for (const [what, mutated] of routesBeforeTheField) {
    assert.ok(
      judgeRendererOutput(mutated).length > 0,
      `${what} must still be refused — demanding provenance of a class field must not have loosened anything else`,
    )
  }
  // ...and the SHIPPED model is still clean, which is the other direction of the same statement: the
  // renderers declare no class field and no enum member, so the rule refuses nothing they emit.
  assert.deepEqual(
    judgeRendererOutput(model), [],
    'the shipped renderers must still report a clean inventory under the field rule, or round 29 has narrowed '
    + 'what this walk can READ rather than what it will TRUST',
  )
})
