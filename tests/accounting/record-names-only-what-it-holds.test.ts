import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  DOCUMENT_INCIDENT_WORDING,
  NON_DOCUMENT_INCIDENT_WORDING,
  OPERATION_SEMANTIC_BY_TYPE,
  QBO_OPERATIONS_WITHOUT_REQUEST_ID,
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
//                         Fourteen lines, capped, each naming the IMS-LOCAL object it points at,
//                         from a closed union type that HAS NO MEMBER for a remote object.
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
// not a verb nobody thought of — and it is the last residue. The structured answer, where a
// directive's target kind, locality and permitted action are TYPED and the prose is generated from
// them, is Codex's own recommendation and is filed as o3d-cvyv.
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
 * THE IMS-LOCAL OBJECTS A RECORD THAT CAN NAME NOTHING IS STILL ALLOWED TO POINT AT.
 *
 * A closed union, and the whole safety property is in what it does NOT have: there is no member for
 * a bill, an invoice, a ledger document, a WooCommerce order — for anything in somebody else's
 * system. An instruction at one of those cannot be given a target, so it cannot be written down
 * here, so it cannot ship. That is the difference between this and five rounds of regex: the
 * category is absent from the type rather than excluded by a pattern.
 */
type LocalObject =
  | 'the invoice PDF IMS stored against the order'
  | 'the local EmailOutbox rows'
  | 'the plugin setting quickbooks_sync_attach_pdf'
  | 'the plugin setting quickbooks_sync_enabled'
  | 'this record and its sync row'

/**
 * THE COMPLETE INVENTORY OF WHAT A LOOKUP-LESS RECORD TELLS AN OPERATOR TO DO. Every one is at an
 * object IMS itself holds and this message names, every one is read-only or a switch on IMS's own
 * setting, and the cap is the review: a sixteenth line means somebody decided to add an instruction
 * to a record that can name nothing, and has to raise the cap in front of a reviewer to do it.
 */
const LOCAL_DIRECTIONS: readonly { object: LocalObject; span: string }[] = [
  // The PDF IMS downloaded and stored against the order. Local file, read-only, and the message
  // prints the IMS reference that reaches it.
  {
    object: 'the invoice PDF IMS stored against the order',
    span: 'confirm the invoice PDF stored against the order is the document you expect',
  },
  // The local EmailOutbox rows, by that table's own columns — every one walked into the schema in
  // rounds 6 through 9. Reads only: EmailOutbox has no state that means "cancelled", and the record
  // says so in prose rather than instructing one.
  {
    object: 'the local EmailOutbox rows',
    span: "Inspect the outbox rows for this order and read each row's status, attempts, lastError and sentAt.",
  },
  {
    object: 'the local EmailOutbox rows',
    span: "Then INSPECT the outbox: query it for kind ACCOUNTING_INVOICE, referenceType SalesOrder, referenceId = the order id (no page in IMS lists them) and read each row's status, attempts, lastError, createdAt and sentAt.",
  },
  {
    object: 'the local EmailOutbox rows',
    span: 'so re-run the query rather than treating one result as the final list',
  },
  {
    object: 'the local EmailOutbox rows',
    span: 'Read them by status, lastError and time',
  },
  // The two plugin settings. Reading one is read-only; turning one off writes an IMS row and
  // touches nothing in anybody else's system — and the record says in prose, at length, that the
  // switch is an admission check rather than a fence.
  {
    object: 'the plugin setting quickbooks_sync_enabled',
    span: 'TURN THE LEVER BELOW OFF FIRST, so that no NEW run is admitted',
  },
  {
    object: 'the plugin setting quickbooks_sync_attach_pdf',
    span: 'THEN GO AND READ quickbooks_sync_attach_pdf AS IT STANDS NOW',
  },
  {
    object: 'the plugin setting quickbooks_sync_attach_pdf',
    span: 'READ quickbooks_sync_attach_pdf AS IT STANDS NOW to learn what a replay would do',
  },
  {
    object: 'the plugin setting quickbooks_sync_enabled',
    span: 'HOW TO STOP MORE OF IT: turn {ledger} sync OFF. The control is the checkbox at the top of the SYNC tab of the {ledger} connector panel, and it writes the setting quickbooks_sync_enabled.',
  },
  {
    object: 'the plugin setting quickbooks_sync_enabled',
    span: 'THEN LEAVE IT OFF, BECAUSE TURNING IT OFF IS NOT A FENCE.',
  },
  // The escalation, in the four shapes the module writes it. Its object is this record and the sync
  // row this message names — both IMS's own.
  {
    object: 'this record and its sync row',
    span: 'Leave the toggle off and ESCALATE sync row {syncRowId}, with this record, to whoever administers this installation',
  },
  {
    object: 'this record and its sync row',
    span: 'Fix the failure named above, and ESCALATE sync row {syncRowId}, with this record, to whoever administers this installation',
  },
  {
    object: 'this record and its sync row',
    span: 'Escalate this record to whoever administers this installation',
  },
  {
    object: 'this record and its sync row',
    span: 'escalate this record to whoever administers this installation',
  },
]

/** The most instructions a record that can name nothing may carry. Raising this IS the decision. */
const LOCAL_DIRECTION_CAP = 14

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
  ...LOCAL_DIRECTIONS.map(({ span }) => span), ...BREADCRUMB_DIRECTIONS, ...RECORD_PROSE,
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
      + '(and then only at an object in the LocalObject union, which has no member for anything in '
      + 'another system), in BREADCRUMB_DIRECTIONS if it belongs to the reset breadcrumb, or in '
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

// MUTATION THAT KILLS THIS (run): add a sixteenth line to LOCAL_DIRECTIONS and the cap fails. RUN.
// Change any line's `object` to a remote one and the BUILD fails — `LocalObject` has no such
// member, which is the point of it being a union rather than a string. Put a mutation lexeme in one
// — 'and remove the duplicate' — and the read-only assertion fails naming it.
//
// ROUTE: the list is read here; the corpus is the SHIPPED per-incident messages, breadcrumbs
// excluded, so a line that only ever appears in the breadcrumb cannot hide in this list.
test('ROUND 16: the complete instruction inventory of a record that can name nothing', () => {
  const incidents = lookupLessMessages().filter(({ label }) => !label.startsWith('breadcrumb'))
  assert.ok(incidents.length > 0, 'sanity: per-incident messages were rendered')

  assert.ok(
    LOCAL_DIRECTIONS.length <= LOCAL_DIRECTION_CAP,
    `${LOCAL_DIRECTIONS.length} instructions on records that can name nothing — the cap is `
    + `${LOCAL_DIRECTION_CAP}, and raising it is the decision, not a formality`,
  )

  for (const { object, span } of LOCAL_DIRECTIONS) {
    assert.deepEqual(
      mutationLexemes([span], []), [],
      `"${span}" instructs a MUTATION on a record that can name no object — a permitted local `
      + "instruction may read, inspect, confirm or move IMS's own switch, and nothing else",
    )
    assert.ok(
      incidents.some(({ text }) => text.includes(span)),
      `"${span}" appears in no shipped incident message — delete it rather than leaving an `
      + 'exemption nothing is standing in',
    )
    assert.ok(object.length > 0, `"${span}" must name the local object it points at`)
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
