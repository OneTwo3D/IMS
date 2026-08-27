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

type WordingEntryView = {
  label: string
  templates: string[]
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
// ROUND 12 (Codex MEDIUM), REBUILT IN ROUND 13 (Codex HIGH) — AN ACT IS AN ACT IN ANY GRAMMAR.
//
// The lookup fence asks "does this remedy send an operator SEARCHING in its own words?". The thing
// that actually goes wrong is one step further out: DOES THIS REMEDY TELL AN OPERATOR TO ACT ON A
// SPECIFIC OBJECT THE RECORD CANNOT IDENTIFY? `open` is not a lookup verb, so
// `BILL_ATTACHMENT.MADE` shipped "open that bill in {ledger} and remove the duplicate attachment"
// with no lookup field declared and no bill id retained — and after a factory reset the
// PurchaseOrder and the sync row are both deleted, so the operator had to guess which ledger bill
// to strip an attachment off. The sweep found two more of the same shape: `WC_INVOICE_NOTE` ("open
// that order in WooCommerce") and `TAX_RATE_SYNC` ("correct or archive that rate").
//
// WHY IT IS BEING REBUILT ONE ROUND LATER. Round 12 asked the question of IMPERATIVES only, and
// wrote down, as an assertion in this file, that a GERUND is not an imperative and is not caught.
// Round 12's own new wording then used one: the `BILL_ATTACHMENT.NONE` replay check offered
// "letting the uploads happen and clearing the duplicates afterwards" — an act, on a bill that cell
// does not name, through the hole this file had just documented. That is twice in two rounds that a
// fix landed inside its own stated limitation, so the limitation is the finding. A documented hole
// in a fence is not a fence; it is a fence with a gate and a sign on it.
//
// SO THE QUESTION IS ASKED OF THE ACT, NOT OF ITS GRAMMAR. A mutating verb counts in EVERY form it
// takes — imperative, third person, past, gerund — and so do the nouns those verbs turn into. What
// makes an occurrence an INSTRUCTION rather than a description is that it takes a specific object:
// "clearing THE duplicates", "removing THAT allocation", "open THAT bill". A verb with no object
// ("a reversal POSTS FOR REAL") describes a consequence and instructs nobody. And an occurrence
// inside a NEGATION instructs nothing either — refusing to act on a thing needs no identifier for
// it — so a clause is exempt from the point where it negates: "DO NOT REMOVE AN ATTACHMENT FROM A
// BILL THIS RECORD CANNOT NAME", "there is nothing here to open, keep or void as one", "no action,
// route or screen removes an unsent row", "nothing this attempt did needs undoing".
//
// THE CLASS IS CLOSED THREE WAYS AT ONCE — the verbs are enumerated, their inflections are
// generated rather than listed, and the object and the negation are grammar. What it does NOT
// cover, stated rather than implied:
//
//   1. IT CHECKS THAT THE ENTRY CAN NAME SOMETHING, NOT THAT THE NAMED THING IS THE THING ACTED
//      ON. `PAYMENT` declares a lookup on the payment id and instructs removing the payment, which
//      is right; an entry that declared a lookup on one object and instructed action on another
//      would pass.
//   2. A CLAUSE IS EXEMPT FROM ITS FIRST NEGATION ONWARD, so a clause that refuses one act and
//      instructs another after it, in one breath, is not caught. Nothing in the shipped corpus does
//      that; it is the shape to watch for when editing one.
//   3. AN INSTRUCTION PHRASED WITHOUT ANY OF THESE VERBS still passes, for the same reason item 1
//      of the round-11 block gives: English has no closed set of ways to tell someone to do
//      something. "Go to that bill and take the second PDF off it" is not caught, and the
//      assertions at the foot of the test say so rather than leaving it to be found.
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
 * A determiner or pronoun — what makes the words after a verb A SPECIFIC OBJECT rather than a
 * consequence. This is the whole difference between "clearing the duplicates" and "a reversal
 * POSTS FOR REAL".
 */
const OBJECT = '(?:the|that|this|those|these|its|their|any|either|both|each|an|a|it|them|one)\\b'

const INSTRUCTED_ACT = new RegExp(
  `\\b(?:(${[...ACT_VERBS.map(everyFormOf), ...ACT_VERB_IRREGULARS].join('|')})\\s+${OBJECT}`
  + `|(${ACT_NOUNS.join('|')})\\s+of\\s+${OBJECT})`,
  'gi',
)

/** Where a clause stops instructing. An occurrence at or after this point is refusing, not telling. */
const NEGATION = /\b(?:not|never|no|nothing|none|cannot|neither|nor|without|rather than)\b/i

/**
 * A clause boundary, for deciding what is governed by which negation. Deliberately NOT `, ` or
 * ` or `: "DO NOT VOID, CREDIT-NOTE, REVERSE OR DELETE anything on the strength of this record" is
 * ONE prohibition, and splitting on those would orphan every verb after the first from the `not`
 * that governs them all.
 */
const CLAUSE_BOUNDARY = /(?:\.\s|;\s|:\s|—\s|\band\s)/

/** Every act these templates INSTRUCT, in whatever grammatical form they instruct it. */
function actsInstructed(templates: readonly string[]): string[] {
  const found: string[] = []
  for (const template of templates) {
    const prose = template.replace(/\{Lookup\}|\{lookup\}/g, ' ')
    for (const raw of prose.split(CLAUSE_BOUNDARY)) {
      const clause = raw.trim()
      const negation = NEGATION.exec(clause)
      const instructsUntil = negation ? negation.index : clause.length
      INSTRUCTED_ACT.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = INSTRUCTED_ACT.exec(clause)) !== null) {
        if (match.index >= instructsUntil) continue
        found.push((match[1] ?? match[2]).toLowerCase())
      }
    }
  }
  return found
}

// MUTATION THAT KILLS THIS (run): restore the shipped round-12 wording — put
// `check: '… and you are choosing between turning it off … and letting the uploads happen and '
// + 'clearing the duplicates afterwards. …'` back on
// QBO_OPERATIONS_WITHOUT_REQUEST_ID.BILL_ATTACHMENT.NONE (the cell that names no bill) and this test
// fails naming that entry and the verb `clearing`. Restoring
// PURCHASE_CREDIT_NOTE_ALLOCATION's "the only thing that undoes it is removing that allocation from
// the credit note" kills it the same way, naming `undoes, removing`; so do the three round-11
// imperatives (`open that bill`, `open that order`, `correct or archive that rate`). All of those
// mutations are ALSO run inline below against the shipped checker, so weakening the checker fails
// this test rather than quietly reopening the hole.
//
// ROUTE: the templates come from the SHIPPED wording tables — all three of them — and the
// declaration each entry is judged against is the entry's own `lookup`. Only the verb list and the
// clause grammar are written down here.
test('ROUND 13 (Codex HIGH): a remedy may only instruct an act — in ANY form — on an object the record can name', () => {
  const entries = [...everyWordingEntry(), ...everyReplayWordingEntry()]
  assert.ok(entries.length >= 16, `sanity: ${entries.length} wording entries were scanned`)

  let sawPermitted = false
  for (const { label, templates, lookup } of entries) {
    const acts = actsInstructed(templates)
    if (lookup.length > 0) {
      if (acts.length > 0) sawPermitted = true
      continue
    }
    assert.deepEqual(
      acts, [],
      `${label} instructs an operator to ${acts.join(', ')} — but it declares no lookup, so this `
      + 'record cannot name the thing being acted on. Either retain and declare an identifier for '
      + 'it, or replace the instruction with an escalation.',
    )
  }
  assert.ok(
    sawPermitted,
    'no entry that CAN name its object instructs an act on it, so the permitted half proves nothing',
  )

  // ---------------------------------------------------------------------------------------------
  // THE REQUIRED FAILING CASES — the wordings rounds 12 and 13 removed, run against the shipped
  // checker. The first two are THE ROUND-13 FINDING: an act in a form round 12's fence could not
  // see.
  // ---------------------------------------------------------------------------------------------
  assert.deepEqual(
    actsInstructed(['if it is ON, the replay uploads to the bill, and you are choosing between '
      + 'turning it off — which stops attachment uploads for EVERY bill on this connector, not this '
      + 'one — and letting the uploads happen and clearing the duplicates afterwards.']),
    ['clearing'],
    'the round-12 NONE remedy walked through the gerund hole round 12 documented, and it must be refused',
  )
  assert.deepEqual(
    actsInstructed(['Both of them existed before this operation and neither was created by it; what '
      + 'happened is that one was applied to the other, and the only thing that undoes it is '
      + 'removing that allocation from the credit note in {ledger}.']),
    ['undoes', 'removing'],
    'a gerund and a third-person present are acts too, and this entry names neither document',
  )
  assert.deepEqual(
    actsInstructed(['REMEDY: escalate this record. Removal of the duplicate is what undoes it.']),
    ['removal', 'undoes'],
    'and so is the noun the verb turns into — otherwise the fence is bypassed by nominalising',
  )
  assert.deepEqual(
    actsInstructed(['REMEDY: open that bill in {ledger} and remove the duplicate attachment. There '
      + 'is no document to void, and the bill itself was not created by this attempt.']),
    ['open', 'remove'],
    'the round-11 attachment remedy is the round-12 finding, and it must still be refused',
  )
  assert.deepEqual(
    actsInstructed(['REMEDY: open that order in WooCommerce and remove any duplicate note. There is '
      + 'nothing to void in {ledger}.']),
    ['open', 'remove'],
    'the WooCommerce note remedy is the same defect and must be refused',
  )
  assert.deepEqual(
    actsInstructed(['REMEDY: THERE IS NOTHING TO VOID OR CREDIT — nothing was posted to a customer '
      + 'or a supplier account. Review the tax rates in {ledger}, and correct or archive that rate '
      + 'there if this write was wrong.']),
    ['archive'],
    'the tax-rate remedy is the same defect and must be refused',
  )

  // A PROHIBITION IS NOT AN INSTRUCTION, and must not be caught — refusing to act on a thing needs
  // no identifier for it. This is the shipped UPDATE_DRAFT sentence.
  assert.deepEqual(
    actsInstructed(['DO NOT VOID OR CREDIT-NOTE IT — that would act on a document that was valid '
      + 'before this attempt ran. DO NOT REVERSE IT — a reversal POSTS FOR REAL.']),
    [],
    'a prohibition names an act it forbids, and forbidding needs no lookup',
  )
  // …and neither is a description of what an act WOULD cost. `a reversal` takes no object.
  assert.deepEqual(
    actsInstructed(['A reversal POSTS FOR REAL.']), [],
    'a nominalised act with no object describes a consequence and instructs nobody',
  )
  // …nor is the shipped no-effect sentence, which negates before it names the act at all.
  assert.deepEqual(
    actsInstructed(['nothing this attempt did needs undoing — it created no attachment.']), [],
    'an act named only to say nothing needs it is not an instruction to perform it',
  )

  // AND THE HOLE THAT REMAINS, ASSERTED RATHER THAN IMPLIED — item 3 of the block above.
  assert.deepEqual(
    actsInstructed(['Go to that bill and take the second PDF off it.']), [],
    'an instruction phrased without a listed verb is NOT caught — the fence closes the verb, not '
    + 'the language',
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
