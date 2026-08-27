import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { AccountingSyncType } from '@/app/generated/prisma/client'
import {
  describePreservedUnrecordedIncidents,
  describeUnpersistedQboPost,
  describeUnrecordablePostedDocument,
  incidentKindForOperation,
  type PostedOperationOutcome,
  type UnrecordedIncidentCounts,
} from '@/lib/domain/accounting/unrecorded-posted-document'

// ---------------------------------------------------------------------------------------------
// ROUND 10 (Codex HIGH + MEDIUM) — THE KINDS WERE EXHAUSTIVE OVER ENUM NAMES, NOT OVER OUTCOMES.
//
// Round 9 made the classifier and the formatter share one decision, which was the right move on the
// wrong axis: the decision was keyed on the OPERATION TYPE, a map that covers every member of
// `AccountingSyncType` and therefore reads as total. It is not.
//
//   • `SALES_INVOICE_UPDATE` and `PURCHASE_INVOICE_UPDATE` MODIFY a document that already existed.
//     A persistence conflict on one implies no duplicate at all, and "keep it or void it" could
//     VOID A VALID PRE-EXISTING INVOICE OR BILL.
//   • The same type that posts a live journal creates an UNPOSTED DRAFT when the row's
//     `_postingMode` is `draft`. No balance has moved; the prescribed reversal would move one, for
//     real, by exactly the amount the draft never moved.
//   • `BILL_ATTACHMENT` returns success WITHOUT uploading when attachment upload is off, so one
//     type covers "an attachment now exists on that bill" and "nothing left this process".
//
// Every test below asserts the remedy an operator is actually given, per operation semantic and per
// recorded outcome, and each names the mutation that kills it.
// ---------------------------------------------------------------------------------------------

const ENTRY = (type: AccountingSyncType) => ({
  id: 'log-1', type, referenceType: 'SalesOrder', referenceId: 'order-1',
})
const LIVE: PostedOperationOutcome = { postingMode: 'LIVE' }
const DRAFT: PostedOperationOutcome = { postingMode: 'DRAFT' }

function xero(type: AccountingSyncType, opts: {
  posted?: string | null
  named?: string | null
  reason?: 'ROW_MISSING' | 'ANOTHER_DOCUMENT_NAMED'
  outcome?: PostedOperationOutcome
} = {}): string {
  return describeUnrecordablePostedDocument({
    entry: ENTRY(type),
    postedExternalId: opts.posted === undefined ? 'EXT-1' : opts.posted,
    namedExternalId: opts.named ?? null,
    reason: opts.reason ?? 'ROW_MISSING',
    outcome: opts.outcome,
  })
}
function qbo(type: AccountingSyncType, opts: { posted?: string | null; outcome?: PostedOperationOutcome } = {}): string {
  return describeUnpersistedQboPost(
    { entry: ENTRY(type), postedExternalId: opts.posted === undefined ? 'EXT-1' : opts.posted, outcome: opts.outcome },
    new Error('write conflict'),
  )
}

/**
 * THE INSTRUCTIONS THE LIVE-DOCUMENT AND LIVE-JOURNAL BRANCHES EMIT, quoted from the shipped wording
 * rather than paraphrased. Each one destroys a document nobody created here, or moves a balance
 * nobody moved, when it reaches a reader it was not written for.
 */
const DESTRUCTIVE = [
  /keep it \(re-enter the reference manually\) or void it/,
  /void or credit the duplicate/,
  /void any duplicate/,
  /POST A REVERSING JOURNAL against it/,
  /REVERSE the duplicate with a reversing journal/,
  /REVERSE any duplicate with a reversing journal/,
  /remove or reverse the duplicate PAYMENT/,
]

// ---------------------------------------------------------------------------------------------
// CASE 1 — XERO UPDATE
// ---------------------------------------------------------------------------------------------
// MUTATION THAT KILLS THIS (run): in OPERATION_SEMANTIC_BY_TYPE, set SALES_INVOICE_UPDATE back to
// 'CREATE_DOCUMENT' — the wording reverts to "keep it (re-enter the reference manually) or void it",
// and every doesNotMatch below fails on the first message.
//
// ROUTE: the exported Xero formatter, over both refusal reasons and both id combinations. Nothing
// is stubbed; the strings compared against are the ones the shipped CREATE branch emits.
test('ROUND 10 (Codex HIGH): a Xero *_UPDATE incident never tells an operator to void the document it changed', () => {
  for (const type of ['SALES_INVOICE_UPDATE', 'PURCHASE_INVOICE_UPDATE'] as AccountingSyncType[]) {
    for (const reason of ['ROW_MISSING', 'ANOTHER_DOCUMENT_NAMED'] as const) {
      const named = reason === 'ANOTHER_DOCUMENT_NAMED' ? 'EXT-OTHER' : null
      const message = xero(type, { reason, named, outcome: LIVE })
      const where = `${type} ${reason}`

      // THE DEFECT: this attempt created nothing, so every one of these acts on a document that was
      // valid before it ran.
      for (const forbidden of DESTRUCTIVE) assert.doesNotMatch(message, forbidden, where)

      assert.match(message, /MODIFIED the existing Xero document EXT-1/, where)
      assert.match(message, /NO DOCUMENT WAS CREATED/, where)
      assert.match(message, /DO NOT VOID OR CREDIT-NOTE/, where)
      assert.match(message, /compare (it|each) against the reference above in IMS/, where)
    }
    // …and the classification itself, so the wording cannot be right by accident.
    assert.equal(incidentKindForOperation(type, 'EXT-1', LIVE), 'LEDGER_DOCUMENT')
    assert.equal(incidentKindForOperation(type, null, LIVE), 'LEDGER_DOCUMENT_NO_IDENTIFIER')
    // ROUND 11 (Codex MEDIUM) CORRECTS THE LINE THAT STOOD HERE. Round 10 wrote that "an UPDATE has
    // no draft form to be unsure about" and pinned the no-outcome case to LEDGER_DOCUMENT. Both
    // update handlers send `resolveInvoiceStatus(payload._postingMode)` exactly as the creates do,
    // so an update HAS a draft form and an unrecorded mode is an unknown here like anywhere else.
    assert.equal(incidentKindForOperation(type, 'EXT-1'), 'LEDGER_OUTCOME_UNRECORDED')
    assert.equal(incidentKindForOperation(type, 'EXT-1', DRAFT), 'LEDGER_DRAFT')
  }

  // A PAYMENT is the same class of mistake one door along: it applies to a document nobody created.
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT'] as AccountingSyncType[]) {
    const message = xero(type, { outcome: LIVE })
    for (const forbidden of DESTRUCTIVE) assert.doesNotMatch(message, forbidden, type)
    assert.match(message, /APPLIED a payment in Xero/, type)
    assert.match(message, /REMOVE OR REVERSE THAT PAYMENT/, type)
    assert.match(message, /DO NOT void or credit-note the document it was applied to/, type)
  }
})

// ---------------------------------------------------------------------------------------------
// CASE 2 — XERO DRAFT
// ---------------------------------------------------------------------------------------------
// MUTATION THAT KILLS THIS (run): delete the `if (outcome?.postingMode === 'DRAFT') return
// 'LEDGER_DRAFT'` line from `incidentKindForOperation` — a draft falls to the live document wording,
// "post a reversing journal" reappears, and both the DESTRUCTIVE scan and the DELETE assertions
// fail. Deleting DRAFT_CAPABLE_SEMANTICS' membership of POST_JOURNAL kills it the same way.
//
// ROUTE: the exported formatters with a recorded DRAFT posting mode; the forbidden phrases are the
// ones the shipped live-journal and live-create branches emit.
test('ROUND 10 (Codex HIGH): a DRAFT posting says no balances moved, and prescribes deletion not reversal', () => {
  const journal = xero('COGS_JOURNAL', { outcome: DRAFT })
  assert.match(journal, /created a DRAFT manual journal in Xero as EXT-1 — nothing was posted to the ledger/)
  assert.match(journal, /THE DRAFT MOVED NO BALANCES/)
  assert.match(journal, /DELETE it if it should not exist/)
  assert.match(journal, /DO NOT post a reversing journal/)
  assert.match(journal, /POSTS FOR REAL/)
  assert.doesNotMatch(journal, /POSTED a manual journal to the Xero ledger/)
  assert.doesNotMatch(journal, /or POST A REVERSING JOURNAL against it/)

  const invoice = xero('SALES_INVOICE', { outcome: DRAFT })
  assert.match(invoice, /created a DRAFT document in Xero as EXT-1/)
  assert.match(invoice, /DELETE it if it should not exist/)
  assert.match(invoice, /DO NOT void it, credit-note it or reverse it/)
  assert.doesNotMatch(invoice, /keep it \(re-enter the reference manually\) or void it/)

  // The conflict door and the no-id door take the same answer.
  const both = xero('SALES_INVOICE', { outcome: DRAFT, reason: 'ANOTHER_DOCUMENT_NAMED', named: 'EXT-2' })
  assert.match(both, /NEITHER DRAFT HAS MOVED A BALANCE/)
  assert.match(both, /DELETE the duplicate/)
  assert.doesNotMatch(both, /void or credit the duplicate/)

  const noId = xero('COGS_JOURNAL', { outcome: DRAFT, posted: null })
  assert.match(noId, /it moved no balances/)
  assert.doesNotMatch(noId, /reversing journal/i)

  assert.equal(incidentKindForOperation('SALES_INVOICE', 'EXT-1', DRAFT), 'LEDGER_DRAFT')
  assert.equal(incidentKindForOperation('COGS_JOURNAL', null, DRAFT), 'LEDGER_DRAFT')

  // AND THE RESET BREADCRUMB, which called every one of these real money in the books.
  const zero: UnrecordedIncidentCounts = {
    LEDGER_DOCUMENT: 0, LEDGER_DOCUMENT_NO_IDENTIFIER: 0, LEDGER_DRAFT: 0,
    LEDGER_OUTCOME_UNRECORDED: 0, LEDGER_NON_DOCUMENT: 0, NO_IDENTIFIER_SIDE_EFFECT: 0, UNCLASSIFIED: 0,
  }
  const drafts = describePreservedUnrecordedIncidents({ ...zero, LEDGER_DRAFT: 2 })
  assert.match(drafts, /2 MOVED NO BALANCES/)
  assert.match(drafts, /DO NOT void, credit-note or reverse any of them/)
  assert.doesNotMatch(drafts, /real money in somebody else's books/)
  // ROUND 11 (Codex MEDIUM): and it no longer says every one of them was CREATED as a draft, nor
  // prescribes deleting them, because a draft UPDATE modified one that stood there before.
  assert.match(drafts, /THEY WERE NOT ALL CREATED AS DRAFTS/)
  assert.doesNotMatch(drafts, /DELETE one if it should not exist/)
})

// ---------------------------------------------------------------------------------------------
// THE OUTCOME THAT WAS NOT RECORDED — the honest third answer.
// ---------------------------------------------------------------------------------------------
// MUTATION THAT KILLS THIS (run): change `if (outcome?.postingMode !== 'LIVE') return
// 'LEDGER_OUTCOME_UNRECORDED'` to default to LEDGER_DOCUMENT — an unrecorded attempt is described as
// a live posting again and every assertion below fails.
//
// ROUTE: the exported formatters with NO outcome at all, which is what a record written by an older
// binary carries.
test('ROUND 10: an attempt whose posting mode was not recorded says so, and prescribes nothing', () => {
  for (const type of ['SALES_INVOICE', 'COGS_JOURNAL'] as AccountingSyncType[]) {
    const message = xero(type, {})
    for (const forbidden of DESTRUCTIVE) assert.doesNotMatch(message, forbidden, type)
    assert.match(message, /THIS RECORD DOES NOT SAY WHETHER THAT WAS A LIVE POSTING OR A DRAFT/, type)
    assert.match(message, /it cannot say whether any balance moved/, type)
    assert.match(message, /DO NOT void, credit-note, reverse or delete anything/, type)
    assert.match(message, /Escalate this record/, type)
    assert.equal(incidentKindForOperation(type, 'EXT-1'), 'LEDGER_OUTCOME_UNRECORDED', type)
  }

  const zero: UnrecordedIncidentCounts = {
    LEDGER_DOCUMENT: 0, LEDGER_DOCUMENT_NO_IDENTIFIER: 0, LEDGER_DRAFT: 0,
    LEDGER_OUTCOME_UNRECORDED: 0, LEDGER_NON_DOCUMENT: 0, NO_IDENTIFIER_SIDE_EFFECT: 0, UNCLASSIFIED: 0,
  }
  const crumb = describePreservedUnrecordedIncidents({ ...zero, LEDGER_OUTCOME_UNRECORDED: 3 })
  assert.match(crumb, /ON RECORDS THAT DO NOT SAY WHICH/)
  assert.match(crumb, /Do not void, credit, reverse or delete anything/)
})

// ---------------------------------------------------------------------------------------------
// CASE 3 & 4 — BILL_ATTACHMENT, UPLOAD ENABLED AND UPLOAD DISABLED
// ---------------------------------------------------------------------------------------------
// MUTATION THAT KILLS THIS (run): make `nonDocumentWordingFor` ignore its outcome and always return
// the MADE variant — the disabled case claims an upload and "THERE IS NOTHING TO UNDO" disappears;
// return the UNRECORDED variant unconditionally and the enabled case stops saying the upload
// happened. Deleting `externalEffect: 'NONE'` from either connector's disabled branch kills it
// through the source assertions at the bottom of this file.
//
// ROUTE: the exported formatters, both connectors, with the handler's own recorded answer.
test('ROUND 10 (Codex MEDIUM): the attachment record states the handler outcome, including the disabled no-op', () => {
  // ROUND 12: an upload that happened is now told apart from an upload whose BILL the record can
  // name — see tests/accounting/record-reads-settings-as-history.test.ts. The round-10 property is
  // unchanged and is asserted on the named cell.
  const uploaded = xero('BILL_ATTACHMENT', {
    posted: null, outcome: { externalEffect: 'MADE', ledgerTargetId: 'XERO-BILL-7' },
  })
  assert.match(uploaded, /THE UPLOAD HAPPENED/)
  // ROUND 13 (Codex MEDIUM): the historical outcome, not a claim about what is on that bill now.
  assert.match(uploaded, /THIS ATTEMPT UPLOADED AN ATTACHMENT ONTO XERO BILL XERO-BILL-7/)
  assert.match(uploaded, /no standalone accounting document was created/)
  assert.match(uploaded, /remove the duplicate attachment/)
  // THE DEFECT: it said an upload happened AND that nothing was created at all.
  assert.doesNotMatch(uploaded, /NOTHING WAS CREATED IN XERO AT ALL/)

  const disabled = xero('BILL_ATTACHMENT', { posted: null, outcome: { externalEffect: 'NONE' } })
  assert.match(disabled, /it did nothing at all/)
  assert.match(disabled, /NOTHING LEFT THIS PROCESS AND NOTHING IN XERO CHANGED/)
  assert.match(disabled, /THERE IS NOTHING TO UNDO/)
  // THE DEFECT: it sent an operator to remove a duplicate this attempt never created.
  assert.doesNotMatch(disabled, /remove the duplicate attachment/)
  assert.doesNotMatch(disabled, /THE UPLOAD HAPPENED/)

  const unknown = xero('BILL_ATTACHMENT', { posted: null })
  assert.match(unknown, /IMS DID NOT RECORD WHETHER THE UPLOAD HAPPENED/)
  assert.match(unknown, /DO NOT REMOVE AN ATTACHMENT ON THE STRENGTH OF THIS RECORD/)
  assert.match(unknown, /escalate this record/i)

  // The QuickBooks door is the o3d-qn21 replay wording, and it splits the same three ways.
  const qboUploaded = qbo('BILL_ATTACHMENT', {
    posted: null, outcome: { externalEffect: 'MADE', ledgerTargetId: 'QBO-BILL-7' },
  })
  assert.match(qboUploaded, /uploaded to QuickBooks bill QBO-BILL-7 AGAIN, once per sweep/)
  assert.match(qboUploaded, /remove any duplicate attachment/)
  assert.doesNotMatch(qboUploaded, /unless/i)

  const qboDisabled = qbo('BILL_ATTACHMENT', { posted: null, outcome: { externalEffect: 'NONE' } })
  // ROUND 12 (Codex HIGH): the no-op claim is CONDITIONAL now — `externalEffect: NONE` says what the
  // setting read when the attempt ran, and this record outlives the setting.
  assert.match(qboDisabled, /NOTHING — PROVIDED ATTACHMENT UPLOAD IS STILL OFF WHEN THE SWEEP RUNS/)
  assert.match(qboDisabled, /it created no attachment/)
  assert.doesNotMatch(qboDisabled, /remove any duplicate attachment/)

  const qboUnknown = qbo('BILL_ATTACHMENT', { posted: null })
  assert.match(qboUnknown, /IMS DID NOT RECORD WHETHER THIS ATTEMPT UPLOADED ANYTHING/)
  assert.match(qboUnknown, /quickbooks_sync_attach_pdf/)
})

// ---------------------------------------------------------------------------------------------
// THE RECORD'S FACTS MUST BE THE CONNECTOR'S FACTS.
// ---------------------------------------------------------------------------------------------
// MUTATION THAT KILLS THIS (run): change `xeroPostingMode` to compare against 'DRAFT' (or anything
// other than 'draft') — the three predicates stop agreeing and the deepEqual fails.
//
// ROUTE: all three function bodies are READ OUT OF the shipped Xero processor. Nothing is written
// down here except the shape being compared.
test('ROUND 10: the recorded posting mode is the same predicate the request status was resolved from', async () => {
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')
  const predicates = ['xeroPostingMode', 'resolveInvoiceStatus', 'resolveJournalStatus'].map((name) => {
    const at = source.indexOf(`function ${name}(`)
    assert.ok(at > 0, `${name} must still exist — the record's mode is derived from the same test it makes`)
    const body = source.slice(at, source.indexOf('\n}', at))
    const match = /mode === '([a-z]+)'|payload\._postingMode === '([a-z]+)'/.exec(body)
    assert.ok(match, `${name} must still decide on a literal _postingMode value:\n${body}`)
    return match[1] ?? match[2]
  })
  assert.deepEqual(predicates, ['draft', 'draft', 'draft'],
    'the record would otherwise call a draft live, or a live posting a draft')
})

// MUTATION THAT KILLS THIS (run): add a `payload._postingMode` read anywhere under
// lib/connectors/quickbooks — the scan finds it and fails, which is the point: the day this
// connector honours a draft mode, resolving LIVE unconditionally becomes the same falsehood the
// Xero side was corrected for.
//
// ROUTE: every QuickBooks connector source is read from disk; the escalation's own literal is read
// out of the shipped processor.
test('ROUND 10: QuickBooks records LIVE because it has no draft form, and the day it gets one this fails', async () => {
  const { readdir } = await import('node:fs/promises')
  const dir = path.join(process.cwd(), 'lib/connectors/quickbooks')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length > 10, `sanity: ${files.length} QuickBooks connector files`)
  let sawWrite = false
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), 'utf8')
    // COMMENTS ARE NOT CODE. A prose note about the key (there is one in the processor, explaining
    // why the record resolves LIVE) must not read as this connector acting on it.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    for (const [whole] of source.matchAll(/[.\w]*_postingMode\s*[:.]?/g)) {
      // Writing the key into an outgoing payload is fine — that is the queue recording the operator
      // setting. READING it back would mean this connector acts on it.
      if (/^_postingMode\s*:/.test(whole)) { sawWrite = true; continue }
      assert.fail(`${file} reads _postingMode ("${whole}") — QuickBooks now has a posting mode, so the `
        + 'unrecorded-post record must stop resolving LIVE unconditionally')
    }
  }
  assert.ok(sawWrite, 'the scan must have seen the key at all, or it proves nothing')

  const processor = await readFile(path.join(dir, 'sync-processor.ts'), 'utf8')
  assert.match(processor, /postingMode: 'LIVE'/, 'and that is what the escalation records')

  // So no QuickBooks message can ever take a draft branch.
  for (const type of ['SALES_INVOICE', 'COGS_JOURNAL'] as AccountingSyncType[]) {
    const message = qbo(type, { outcome: { postingMode: 'LIVE' } })
    assert.doesNotMatch(message, /DRAFT/, type)
  }
})

// MUTATION THAT KILLS THIS (run): delete `externalEffect: 'NONE'` from either connector's disabled
// branch (or `'MADE'` from either upload branch) — the block scan finds a success return that says
// nothing about what left the process, and fails naming the connector.
//
// ROUTE: the BILL_ATTACHMENT case block is extracted from each shipped processor and every
// success-return inside it is inspected.
test('ROUND 10: both BILL_ATTACHMENT handlers record which of the two things they did', async () => {
  for (const file of ['lib/connectors/xero/sync-processor.ts', 'lib/connectors/quickbooks/sync-processor.ts']) {
    const source = await readFile(path.join(process.cwd(), file), 'utf8')
    const at = source.indexOf("case 'BILL_ATTACHMENT': {")
    assert.ok(at > 0, `${file} must still have a BILL_ATTACHMENT branch`)
    const block = source.slice(at, source.indexOf("case 'INVOICE_PDF': {", at))
    assert.ok(block.includes('attach_pdf'), `${file}: the branch must still read the attach setting`)
    const successes = [...block.matchAll(/return \{ success: true[^}]*\}/g)].map((m) => m[0])
    assert.equal(successes.length, 2, `${file}: expected the no-op exit and the uploaded exit\n${successes.join('\n')}`)
    for (const ret of successes) {
      assert.match(ret, /externalEffect: '(MADE|NONE)'/,
        `${file}: this success says nothing about whether anything left the process: ${ret}`)
    }
    assert.ok(successes.some((r) => r.includes("'NONE'")), `${file}: the disabled no-op must be recorded`)
    assert.ok(successes.some((r) => r.includes("'MADE'")), `${file}: the completed upload must be recorded`)
  }
})
