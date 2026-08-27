import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  UNRECORDED_POSTED_DOCUMENT_ACTION,
  UNRECORDED_POSTED_DOCUMENT_ACTIONS,
} from '@/lib/domain/accounting/unrecorded-posted-document'
import { DIRECT_CREATE_PENDING_ACTION } from '@/lib/fulfillment/pre-fulfilment-reallocation'

// ---------------------------------------------------------------------------
// Codex r3, medium — A FACTORY RESET WAS DESTROYING THE EVIDENCE OF A LIVE REMOTE DOCUMENT.
//
// `xero_posted_document_unrecorded` says a document was ACCEPTED BY XERO and its sync row can never name
// it. That sentence is what earned it an exemption from the 90-day retention sweep, and it does not stop
// being true because an operator reset this database: the document is in somebody else's ledger, no
// reset of ours voids it, and nothing in IMS re-derives it.
//
// Round 3's reviewer was asked about exactly this and answered that the reset "deletes the sync rows
// too", so the record has nothing to point at. Read the other way round that is the argument FOR keeping
// it: afterwards there is no sync row, no accounting event and no external id anywhere in IMS, so this
// is not one of several traces of the document — it is the only one there has ever been, and its wording
// is self-contained (both ids, the reference, the remedy).
//
// The exemption's OTHER half is deliberately not kept, and that asymmetry is the test: a direct-create
// marker is an open obligation about a sales order this reset is deleting, so it goes.
//
// Codex HIGH — AND IT WAS ONLY EVER HALF DONE. The exemption named ONE constant, the Xero one, which
// is why it read as correct: it compiled, the tests below passed, and every sentence written about it
// was true. The QuickBooks incident carries its OWN action name, so `{ not: <the Xero string> }`
// deleted all of them — and that row is the only thing naming a document QuickBooks accepted and IMS
// could not write down. The reset was destroying the evidence while logging that it had kept it.
//
// The fix is the pair as a value (`UNRECORDED_POSTED_DOCUMENT_ACTIONS`), so the delete, the count and
// the breadcrumb all read the same list, and the tests below now assert the QuickBooks record survives
// the same three resets the Xero one does.
// ---------------------------------------------------------------------------

type ActivityRow = { action: string; description: string; level?: string; metadata?: unknown }

const state = {
  activity: [] as ActivityRow[],
  /** Every model a deleteMany was issued against, in order. */
  deleted: [] as string[],
  /** The argument the activity-log delete was given. */
  activityDeleteArgs: null as unknown,
}

function reset(rows: ActivityRow[]) {
  state.activity = [...rows]
  state.deleted = []
  state.activityDeleteArgs = null
}

/**
 * The activity-log filter, read the way Prisma would. `notIn`/`in` are what the reset issues now that
 * the exemption is a PAIR — the old single-string `not`/equality forms are still understood here so
 * that a regression back to naming one action is caught by the surviving-record assertions rather
 * than by this helper silently ignoring the argument.
 */
function actionOf(where: unknown): { keep?: string[]; select?: string[] } {
  const action = (where as { action?: unknown } | undefined)?.action
  if (typeof action === 'string') return { select: [action] }
  if (action && typeof action === 'object') {
    const record = action as { not?: unknown; notIn?: unknown; in?: unknown }
    if (typeof record.not === 'string') return { keep: [record.not] }
    if (Array.isArray(record.notIn)) return { keep: record.notIn.filter((value): value is string => typeof value === 'string') }
    if (Array.isArray(record.in)) return { select: record.in.filter((value): value is string => typeof value === 'string') }
  }
  return {}
}

const activityLog = {
  deleteMany: async (args?: { where?: unknown }) => {
    state.deleted.push('activityLog')
    state.activityDeleteArgs = args
    const filter = actionOf(args?.where)
    const before = state.activity.length
    state.activity = state.activity.filter((row) => (filter.keep ? filter.keep.includes(row.action) : false))
    return { count: before - state.activity.length }
  },
  count: async (args?: { where?: unknown }) => {
    const filter = actionOf(args?.where)
    return state.activity.filter((row) => (filter.select ? filter.select.includes(row.action) : true)).length
  },
  // Round 6: the breadcrumb can no longer be written from an integer — which sentence each row
  // earns is decided by its own metadata, so the reset reads the rows.
  findMany: async (args?: { where?: unknown; select?: Record<string, boolean> }) => {
    const filter = actionOf(args?.where)
    return state.activity
      .filter((row) => (filter.select ? filter.select.includes(row.action) : true))
      .map((row) => (args?.select ? { metadata: row.metadata ?? null } : { ...row }))
  },
  create: async ({ data }: { data: ActivityRow }) => {
    state.activity.push(data)
    return data
  },
}

const model = (name: string) => ({
  deleteMany: async () => { state.deleted.push(name); return { count: 0 } },
  updateMany: async () => ({ count: 0 }),
  count: async () => 0,
  findMany: async () => [],
  findUnique: async () => null,
  create: async () => ({}),
  upsert: async () => ({}),
})

const client: Record<string, unknown> = new Proxy({}, {
  get(_target, prop: string) {
    if (prop === 'activityLog') return activityLog
    if (prop === '$transaction') return async (fn: (tx: unknown) => Promise<unknown>) => fn(client)
    if (prop === 'then') return undefined
    return model(prop)
  },
})

mock.module('@/lib/db', { namedExports: { db: client } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/integration-plugin-selection-lock', {
  namedExports: { lockIntegrationPluginSelection: async () => {} },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshAdmin: async () => ({ user: { id: 'admin-1', email: 'admin@example.test' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/destructive-action-confirm', {
  namedExports: {
    consumeDestructiveActionCode: async () => true,
    issueDestructiveActionCode: async () => ({ success: true }),
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (params: ActivityRow) => { state.activity.push(params) },
  },
})

const INCIDENT: ActivityRow = {
  action: UNRECORDED_POSTED_DOCUMENT_ACTION,
  level: 'ERROR',
  // `unrecordedPostedDocumentRecord` writes metadata.type from entry.type. Round 6 classifies on it,
  // and round 8 also reads `postedExternalId` — which that builder writes too, and which this
  // fixture's own description names, so the two halves of the record agree.
  metadata: { type: 'SALES_INVOICE', syncLogId: 'log-1', postedExternalId: 'INV-XERO-SECOND' },
  description: 'Xero SALES_INVOICE for SalesOrder order-1 POSTED as INV-XERO-SECOND, but sync row log-1 '
    + 'already names a DIFFERENT document (INV-XERO-FIRST). REMEDY: open both ids in Xero.',
}

const QBO_INCIDENT: ActivityRow = {
  action: QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  level: 'ERROR',
  // `unpersistedQboPostRecord` writes the same fields. A SALES_INVOICE is a real ledger document,
  // and this one came back with an id.
  metadata: { type: 'SALES_INVOICE', syncLogId: 'log-2', postedExternalId: 'QBO-INV-9' },
  description: 'QuickBooks SALES_INVOICE for SalesOrder order-2 POSTED as QBO-INV-9, but IMS could not '
    + 'record that id. REMEDY: open the id above in QuickBooks.',
}

const ORDINARY: ActivityRow = { action: 'order_created', level: 'INFO', description: 'ordinary history' }
const MARKER: ActivityRow = { action: DIRECT_CREATE_PENDING_ACTION, level: 'WARNING', description: 'open obligation' }

async function runReset(level: 'transactions' | 'products' | 'full') {
  const { resetDatabase } = await import('@/app/actions/reset')
  return resetDatabase(level, 'code-123456')
}

test('Codex r3 medium: a transaction reset keeps the record of a document that exists in Xero', async () => {
  reset([INCIDENT, ORDINARY, MARKER])

  const result = await runReset('transactions')

  assert.equal(result.success, true)
  const kept = state.activity.filter((row) => row.action === UNRECORDED_POSTED_DOCUMENT_ACTION)
  assert.equal(kept.length, 1, 'the document is still in Xero after the reset, so its only record must be too')
  assert.match(kept[0].description, /INV-XERO-SECOND/, 'and it still names both documents')
  assert.match(kept[0].description, /INV-XERO-FIRST/)
  assert.ok(
    !state.activity.some((row) => row.action === 'order_created'),
    'while ordinary history goes, which is the whole point of a reset',
  )
  assert.ok(
    !state.activity.some((row) => row.action === DIRECT_CREATE_PENDING_ACTION),
    'and so does the retention exemption\'s other half: an obligation about an order this reset deleted',
  )
})

test('Codex HIGH: a transaction reset keeps the QUICKBOOKS record too', async () => {
  // THE DEFECT, DIRECTLY. The QuickBooks incident is the same kind of thing as the Xero one — a
  // document a remote ledger accepted that nothing in IMS names — and it is the ONLY record of it.
  // Under the single-constant exemption `{ not: <the Xero action> }` matched it and deleted it, and
  // the reset then logged a breadcrumb saying the evidence had been preserved.
  reset([QBO_INCIDENT, ORDINARY])

  const result = await runReset('transactions')

  assert.equal(result.success, true)
  const kept = state.activity.filter((row) => row.action === QBO_UNRECORDED_POSTED_DOCUMENT_ACTION)
  assert.equal(kept.length, 1, 'the document is still in QuickBooks after the reset, so its only record must be too')
  assert.match(kept[0].description, /QBO-INV-9/, 'and it still names the identifier that exists nowhere else')
  assert.ok(!state.activity.some((row) => row.action === 'order_created'), 'ordinary history still goes')
})

test('Codex HIGH: BOTH connectors\' records survive the same reset, and are counted together', async () => {
  // The pair read as one list, on the delete AND on the count that feeds the breadcrumb. A fix that
  // exempted both but counted one would under-report the preserved evidence in the only place an
  // operator is told it exists.
  reset([INCIDENT, QBO_INCIDENT, ORDINARY, MARKER])

  await runReset('full')

  assert.deepEqual(
    state.activity.filter((row) => UNRECORDED_POSTED_DOCUMENT_ACTIONS.includes(row.action)).map((row) => row.action).sort(),
    [...UNRECORDED_POSTED_DOCUMENT_ACTIONS].sort(),
    'one record per connector, both still here',
  )
  const breadcrumb = state.activity.find((row) => row.action === 'database_reset_preserved_unrecorded_documents')
  assert.ok(breadcrumb)
  assert.match(breadcrumb.description, /2 record/, 'the count covers both, so the breadcrumb is not half a report')
  assert.match(breadcrumb.description, new RegExp(UNRECORDED_POSTED_DOCUMENT_ACTION), 'and names the Xero action')
  assert.match(breadcrumb.description, new RegExp(QBO_UNRECORDED_POSTED_DOCUMENT_ACTION), 'and the QuickBooks one')
  assert.deepEqual(
    (breadcrumb as unknown as { metadata?: { actions?: string[] } }).metadata?.actions,
    [...UNRECORDED_POSTED_DOCUMENT_ACTIONS],
    'the metadata carries the whole list, so the breadcrumb is searchable for either',
  )
})

test('Codex MEDIUM (round 3): the breadcrumb describes the WHOLE preserved set, not only the ledger half', async () => {
  // Folding the pair into one exemption made this sentence speak for both action names at once, and
  // it kept the Xero wording: "documents that IMS posted to an accounting ledger … those documents
  // still exist in Xero or QuickBooks". The QuickBooks action does not mean only that. The SAME name
  // is written for the four no-identifier operations — a bill attachment, a stored invoice PDF, an
  // invoice email QUEUED to a customer, a note on a WooCommerce order — none of which is a ledger
  // document, and one of which has not finished happening. A reader told to go and look in the
  // ledger for those finds nothing, and concludes the record is stale.
  reset([INCIDENT, QBO_INCIDENT])

  await runReset('full')

  const breadcrumb = state.activity.find((row) => row.action === 'database_reset_preserved_unrecorded_documents')
  assert.ok(breadcrumb)

  // The claim that was false of part of the set.
  assert.doesNotMatch(
    breadcrumb.description,
    /Those documents still exist in Xero or QuickBooks/,
    'that is true of the Xero records and of a QuickBooks document post — and of nothing else preserved here',
  )
  assert.match(breadcrumb.description, /THEY ARE NOT ALL THE SAME KIND OF THING/)

  // What IS true of the whole set: each one names an effect, and the record says which.
  assert.match(breadcrumb.description, /Each record says what the effect was/)

  // Unchanged: the ledger half is still stated, because BOTH fixtures here are ledger documents.
  assert.match(breadcrumb.description, /Xero or QuickBooks accepted and still holds/)
  assert.match(breadcrumb.description, /^Database reset kept 2 record/)

  // ROUND 6 (Codex MEDIUM): and because both of them ARE ledger documents, the side-effect sentence
  // must not appear at all. Round 3's hedge emitted it unconditionally over a single count, so this
  // very reset asserted that some preserved record was a queued email, a WooCommerce note or a bill
  // attachment when none of them was.
  assert.doesNotMatch(breadcrumb.description, /are NOT ledger documents/)
  for (const effect of ['attached to a QuickBooks bill', 'WooCommerce order', 'email-outbox row']) {
    assert.ok(!breadcrumb.description.includes(effect), `nothing here is one of those: ${effect}`)
  }
})

test('Codex r3 medium + HIGH: the exemption is in the DELETE, and it names the whole pair', async () => {
  reset([INCIDENT])

  await runReset('transactions')

  assert.deepEqual(
    state.activityDeleteArgs,
    { where: { action: { notIn: [...UNRECORDED_POSTED_DOCUMENT_ACTIONS] } } },
    'the reset must never issue an unrestricted activityLog.deleteMany({}), and never name one of a pair',
  )
  const exempted = (state.activityDeleteArgs as { where: { action: { notIn: string[] } } }).where.action.notIn
  assert.ok(exempted.includes(UNRECORDED_POSTED_DOCUMENT_ACTION))
  assert.ok(exempted.includes(QBO_UNRECORDED_POSTED_DOCUMENT_ACTION))
  assert.ok(
    !exempted.includes(DIRECT_CREATE_PENDING_ACTION),
    'and the pair is NOT the retention sweep\'s whole exempt list — the open obligation still goes',
  )
})

test('Codex r3 medium: the reset still resets — the sync rows themselves go', async () => {
  // The exemption is narrow on purpose. It is not "keep the audit log"; it is "keep the one row that
  // describes something outside this database".
  reset([INCIDENT])

  await runReset('transactions')

  assert.ok(state.deleted.includes('accountingSyncLog'), 'the Xero sync rows are cleared as before')
  assert.ok(state.deleted.includes('salesOrder'))
  assert.ok(state.deleted.includes('activityLog'))
})

test('Codex r3 medium: a FULL reset keeps it too, and leaves a breadcrumb saying where to look', async () => {
  // A full reset severs the Xero connection; it does not void the documents posted through it.
  reset([INCIDENT])

  await runReset('full')

  assert.equal(
    state.activity.filter((row) => row.action === UNRECORDED_POSTED_DOCUMENT_ACTION).length,
    1,
    'a factory reset is a stronger eraser than a 90-day sweep, not a weaker one',
  )
  const breadcrumb = state.activity.find((row) => row.action === 'database_reset_preserved_unrecorded_documents')
  assert.ok(breadcrumb, 'the preservation must be visible without knowing to look for it')
  assert.match(breadcrumb.description, /1 record/, 'saying how many were kept')
  assert.match(breadcrumb.description, new RegExp(UNRECORDED_POSTED_DOCUMENT_ACTION), 'and what to search for')
  assert.equal(breadcrumb.level, 'WARNING')
})

test('Codex r3 medium: a reset with nothing to preserve says nothing', async () => {
  reset([ORDINARY])

  await runReset('transactions')

  assert.ok(
    !state.activity.some((row) => row.action === 'database_reset_preserved_unrecorded_documents'),
    'a breadcrumb on every reset would be noise, and would stop meaning anything when it mattered',
  )
})

// ---------------------------------------------------------------------------
// ROUND 6 (Codex MEDIUM): THE BREADCRUMB WAS STILL ASSERTING A REMOTE DOCUMENT THAT NEVER EXISTED.
//
// Round 3 replaced one false sentence with a hedge — "THEY ARE NOT ALL LEDGER DOCUMENTS. Some name a
// document … The rest name an effect …" — over a SINGLE count. True of the set, useless about any
// member of it, and on an install whose only preserved incident is an `INVOICE_EMAIL` it is worse
// than useless: it asserts that some of them are documents standing in a ledger when none of them
// is. `INVOICE_EMAIL` creates only a local `EmailOutbox` row — which this same reset deleted a few
// statements earlier — and no QuickBooks document at all. This breadcrumb is exempt from retention
// and from the reset, so that assertion is permanent.
//
// The counts are now classified from each record's own `metadata.type`, and a kind with nothing in
// it emits NO sentence.
//
// REVERT EVIDENCE (each verified by putting that one thing back and re-running this file):
//   * restoring the single `activityLog.count` + the round-3 hedge fails "an INVOICE_EMAIL incident
//     is NOT described as a document standing in a ledger" on the ledger sentence.
//   * making `classifyUnrecordedIncident` return 'LEDGER_DOCUMENT' for an unreadable metadata fails
//     "a record with no readable type is counted apart rather than guessed".
//   * dropping INVOICE_EMAIL from QBO_OPERATIONS_WITHOUT_REQUEST_ID fails the same first test.
// ---------------------------------------------------------------------------

const QBO_EMAIL_INCIDENT: ActivityRow = {
  action: QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  level: 'ERROR',
  metadata: { type: 'INVOICE_EMAIL', syncLogId: 'log-3' },
  description: 'QuickBooks INVOICE_EMAIL for SalesOrder order-3 SUCCEEDED — the external effect has '
    + 'happened — but IMS could not record that it did.',
}

const QBO_UNTYPED_INCIDENT: ActivityRow = {
  action: QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  level: 'ERROR',
  metadata: null,
  description: 'QuickBooks incident whose metadata did not survive.',
}

test('ROUND 6: an INVOICE_EMAIL incident is NOT described as a document standing in a ledger', async () => {
  reset([QBO_EMAIL_INCIDENT])

  await runReset('full')

  const kept = state.activity.filter((row) => row.action === QBO_UNRECORDED_POSTED_DOCUMENT_ACTION)
  assert.equal(kept.length, 1, 'it is still preserved — it is the only thing saying the effect repeated')

  const breadcrumb = state.activity.find((row) => row.action === 'database_reset_preserved_unrecorded_documents')
  assert.ok(breadcrumb)

  // THE DEFECT: not one word claiming a document exists somewhere to go and look for.
  assert.doesNotMatch(
    breadcrumb.description,
    /Xero or QuickBooks accepted and still holds/,
    'no ledger document was ever created for this incident',
  )
  assert.doesNotMatch(breadcrumb.description, /real money in somebody else's books/)

  // What it says instead.
  assert.match(breadcrumb.description, /1 are NOT ledger documents and created nothing in Xero or QuickBooks/)
  assert.match(
    breadcrumb.description,
    /only a local email-outbox row, WHICH THIS RESET HAS JUST DELETED/,
    'and it says the count that record asks for can no longer be made',
  )

  const metadata = (breadcrumb as unknown as { metadata?: Record<string, unknown> }).metadata
  assert.equal(metadata?.ledgerDocuments, 0, 'the count that would have been asserted is zero, and is stated as zero')
  assert.equal(metadata?.noIdentifierSideEffects, 1)
  assert.equal(metadata?.unclassified, 0)
  assert.equal(metadata?.preserved, 1, 'the total still reconciles with the parts')
})

test('ROUND 6: a mixed set gets one truthful count per kind, not one number and a hedge', async () => {
  reset([INCIDENT, QBO_INCIDENT, QBO_EMAIL_INCIDENT])

  await runReset('full')

  const breadcrumb = state.activity.find((row) => row.action === 'database_reset_preserved_unrecorded_documents')
  assert.ok(breadcrumb)
  assert.match(breadcrumb.description, /^Database reset kept 3 record/)
  assert.match(breadcrumb.description, /2 name a DOCUMENT Xero or QuickBooks accepted and still holds/)
  assert.match(breadcrumb.description, /1 are NOT ledger documents/)

  const metadata = (breadcrumb as unknown as { metadata?: Record<string, unknown> }).metadata
  assert.equal(metadata?.ledgerDocuments, 2)
  assert.equal(metadata?.noIdentifierSideEffects, 1)
  assert.equal(metadata?.unclassified, 0)
})

test('ROUND 6: a record with no readable type is counted apart rather than guessed', async () => {
  // Guessing is exactly how the false assertion was made in the first place. An unreadable record
  // gets its own sentence and its own number, and neither of the other two sentences appears.
  reset([QBO_UNTYPED_INCIDENT])

  await runReset('full')

  const breadcrumb = state.activity.find((row) => row.action === 'database_reset_preserved_unrecorded_documents')
  assert.ok(breadcrumb)
  assert.doesNotMatch(breadcrumb.description, /Xero or QuickBooks accepted and still holds/)
  assert.doesNotMatch(breadcrumb.description, /are NOT ledger documents/)
  assert.match(breadcrumb.description, /1 carry no operation type this version of IMS has classified/)

  const metadata = (breadcrumb as unknown as { metadata?: Record<string, unknown> }).metadata
  assert.equal(metadata?.unclassified, 1)
  assert.equal(metadata?.ledgerDocuments, 0)
  assert.equal(metadata?.noIdentifierSideEffects, 0)
})

test('ROUND 6: the classifier keys on the OPERATION TYPE, not on the connector that wrote it', async () => {
  const { classifyUnrecordedIncident, QBO_NO_IDENTIFIER_OPERATION_TYPES } =
    await import('@/lib/domain/accounting/unrecorded-posted-document')

  // The four are no-identifier operations wherever they run — an `AccountingSyncType` is shared, so
  // keying on the ACTION would reproduce the original mistake with the connectors swapped.
  for (const type of QBO_NO_IDENTIFIER_OPERATION_TYPES) {
    assert.equal(classifyUnrecordedIncident({ type }), 'NO_IDENTIFIER_SIDE_EFFECT', type)
  }
  assert.deepEqual(
    [...QBO_NO_IDENTIFIER_OPERATION_TYPES].sort(),
    ['BILL_ATTACHMENT', 'INVOICE_EMAIL', 'INVOICE_PDF', 'WC_INVOICE_NOTE'],
    'derived from the wording table, so a fifth operation moves both readers at once',
  )

  // ROUND 8: a document kind needs the recorded id as well as the operation semantics.
  assert.equal(classifyUnrecordedIncident({ type: 'SALES_INVOICE', postedExternalId: 'INV-1' }), 'LEDGER_DOCUMENT')
  assert.equal(classifyUnrecordedIncident({ type: 'PURCHASE_INVOICE', postedExternalId: 'BILL-1' }), 'LEDGER_DOCUMENT')

  for (const unreadable of [null, undefined, 'INVOICE_EMAIL', 42, [], {}, { type: '' }, { type: 7 }]) {
    assert.equal(classifyUnrecordedIncident(unreadable), 'UNCLASSIFIED', JSON.stringify(unreadable) ?? 'undefined')
  }
})

// ---------------------------------------------------------------------------
// ROUND 7 (Codex MEDIUM): THE FALLBACK POINTED THE WRONG WAY, AND A REAL XERO OPERATION PROVED IT.
//
// Round 6 asked one question — "is this one of the four no-identifier operations?" — and sent every
// other readable type to LEDGER_DOCUMENT. `PURCHASE_CREDIT_NOTE_ALLOCATION` is a type Xero
// processes SUCCESSFULLY and deliberately returns no external id for: "the allocation is a
// sub-resource of the credit note, not a standalone document" (xero/sync-processor.ts). Its
// preserved incident was therefore being counted as a document standing in Xero, carrying real
// money, openable by id — three false statements in the one record that outlives a factory reset.
//
// The classification is now an EXHAUSTIVE map over AccountingSyncType, and an unknown type is
// UNCLASSIFIED. That is the same defect round 6 fixed pointing the other way: default to the humble
// answer, not the confident one.
//
// REVERT EVIDENCE (each verified by making that one change and re-running this file):
//   * restoring the `QBO_NO_IDENTIFIER_OPERATION_TYPES.includes(type) ? … : 'LEDGER_DOCUMENT'`
//     fallback fails "a Xero credit-note ALLOCATION is not described as a document standing in a
//     ledger" and "an unknown type is UNCLASSIFIED, not a document".
//   * moving PURCHASE_CREDIT_NOTE_ALLOCATION to LEDGER_DOCUMENT in the map fails the first of those.
//   * deleting a member from the map fails "the map classifies every AccountingSyncType" (and the
//     build, which is the point of the Record<> type).
// ---------------------------------------------------------------------------

const XERO_ALLOCATION_INCIDENT: ActivityRow = {
  action: UNRECORDED_POSTED_DOCUMENT_ACTION,
  level: 'ERROR',
  metadata: { type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', syncLogId: 'log-9' },
  description: 'Xero PURCHASE_CREDIT_NOTE_ALLOCATION for SupplierCreditNote scn-9 POSTED, but IMS '
    + 'could not record it.',
}

test('ROUND 7: a Xero credit-note ALLOCATION is not described as a document standing in a ledger', async () => {
  reset([XERO_ALLOCATION_INCIDENT])

  await runReset('full')

  const kept = state.activity.filter((row) => row.action === UNRECORDED_POSTED_DOCUMENT_ACTION)
  assert.equal(kept.length, 1, 'still preserved — the allocation moved money and no reset undoes it')

  const breadcrumb = state.activity.find((row) => row.action === 'database_reset_preserved_unrecorded_documents')
  assert.ok(breadcrumb)

  // THE DEFECT: an allocation has no document id, so none of this may be said about it.
  assert.doesNotMatch(breadcrumb.description, /Xero or QuickBooks accepted and still holds/)
  assert.doesNotMatch(breadcrumb.description, /Open the id in that system/)
  assert.doesNotMatch(breadcrumb.description, /real money in somebody else's books/)
  // Nor is it one of the four: something DID reach the ledger.
  assert.doesNotMatch(breadcrumb.description, /created nothing in Xero or QuickBooks/)

  assert.match(breadcrumb.description, /1 record a write Xero or QuickBooks ACCEPTED that is NOT a standalone document/)
  assert.match(breadcrumb.description, /has NO id to open/)

  const metadata = (breadcrumb as unknown as { metadata?: Record<string, unknown> }).metadata
  assert.equal(metadata?.ledgerDocuments, 0, 'the count that would have been asserted is zero, and is stated as zero')
  assert.equal(metadata?.ledgerNonDocuments, 1)
  assert.equal(metadata?.noIdentifierSideEffects, 0)
  assert.equal(metadata?.unclassified, 0)
  assert.equal(metadata?.preserved, 1)
})

test('ROUND 7: an unknown type is UNCLASSIFIED, not a document', async () => {
  const { classifyUnrecordedIncident } = await import('@/lib/domain/accounting/unrecorded-posted-document')

  // A type from a schema newer than this binary, a truncated string, a renamed member.
  for (const type of ['FUTURE_LEDGER_THING', 'SALES_INVOICE_V2', 'PURCHASE_INVOIC', 'sales_invoice']) {
    assert.equal(classifyUnrecordedIncident({ type }), 'UNCLASSIFIED', type)
  }
  // And the one that made the point.
  assert.equal(classifyUnrecordedIncident({ type: 'PURCHASE_CREDIT_NOTE_ALLOCATION' }), 'LEDGER_NON_DOCUMENT')
  assert.equal(classifyUnrecordedIncident({ type: 'TAX_RATE_SYNC' }), 'LEDGER_NON_DOCUMENT')
})

test('ROUND 7: the map classifies every AccountingSyncType, read from the schema itself', async () => {
  // The compiler already enforces this through Record<AccountingSyncType, …>. This reads the enum
  // from prisma/schema.prisma so the guarantee does not depend on the generated client being in
  // step with the schema, and so a member added to the schema fails a TEST as well as the build.
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const { INCIDENT_KIND_BY_OPERATION_TYPE } = await import('@/lib/domain/accounting/unrecorded-posted-document')

  const schema = await readFile(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const block = /enum AccountingSyncType \{([\s\S]*?)\n\}/.exec(schema)
  assert.ok(block, 'the enum must still be in the schema')
  const members = block![1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line))

  assert.ok(members.length > 25, `sanity: the enum parsed to ${members.length} members`)
  assert.deepEqual(
    members.filter((member) => !(member in INCIDENT_KIND_BY_OPERATION_TYPE)),
    [],
    'every operation type must have a classification — an unmapped one silently becomes UNCLASSIFIED',
  )
  assert.deepEqual(
    Object.keys(INCIDENT_KIND_BY_OPERATION_TYPE).filter((key) => !members.includes(key)),
    [],
    'and the map must not carry a type the schema no longer has',
  )
})

test('ROUND 7: the two non-document types are exactly the ones the breadcrumb sentence names', async () => {
  // The LEDGER_NON_DOCUMENT sentence enumerates its members ("a credit note APPLIED to a bill, a
  // tax rate written into the organisation"). That is exact today and would quietly stop being
  // exact if a third member were added, so the drift is caught here rather than in a reset.
  const { INCIDENT_KIND_BY_OPERATION_TYPE } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  const nonDocuments = Object.entries(INCIDENT_KIND_BY_OPERATION_TYPE)
    .filter(([, kind]) => kind === 'LEDGER_NON_DOCUMENT')
    .map(([type]) => type)
    .sort()
  assert.deepEqual(nonDocuments, ['PURCHASE_CREDIT_NOTE_ALLOCATION', 'TAX_RATE_SYNC'])
})

test('ROUND 7: the four no-identifier types in the map are the four in the wording table', async () => {
  // Two derivations of the same set — the wording table and the semantic map — must not drift, or
  // the record would describe an operation one way and count it another.
  const { INCIDENT_KIND_BY_OPERATION_TYPE, QBO_NO_IDENTIFIER_OPERATION_TYPES } =
    await import('@/lib/domain/accounting/unrecorded-posted-document')
  const fromMap = Object.entries(INCIDENT_KIND_BY_OPERATION_TYPE)
    .filter(([, kind]) => kind === 'NO_IDENTIFIER_SIDE_EFFECT')
    .map(([type]) => type)
    .sort()
  assert.deepEqual(fromMap, [...QBO_NO_IDENTIFIER_OPERATION_TYPES].sort())
})

test('ROUND 7: a mixed set counts all four kinds apart', async () => {
  reset([INCIDENT, QBO_EMAIL_INCIDENT, XERO_ALLOCATION_INCIDENT, QBO_UNTYPED_INCIDENT])

  await runReset('full')

  const breadcrumb = state.activity.find((row) => row.action === 'database_reset_preserved_unrecorded_documents')
  assert.ok(breadcrumb)
  assert.match(breadcrumb.description, /^Database reset kept 4 record/)

  const metadata = (breadcrumb as unknown as { metadata?: Record<string, unknown> }).metadata
  assert.equal(metadata?.ledgerDocuments, 1)
  assert.equal(metadata?.ledgerNonDocuments, 1)
  assert.equal(metadata?.noIdentifierSideEffects, 1)
  assert.equal(metadata?.unclassified, 1)
  assert.equal(metadata?.preserved, 4, 'the total still reconciles with the parts')
})

// ---------------------------------------------------------------------------
// ROUND 8 (Codex MEDIUM): CLASSIFIED AS OPENABLE WHEN NO IDENTIFIER WAS EVER RETURNED.
//
// The map answers "what does a successful handler for this type RETURN?", and for every document
// type the answer is "an id". It was the ONLY question asked, so a record that carries no id was
// still counted as a `LEDGER_DOCUMENT` and earned the breadcrumb sentence that ends "Open the id in
// that system" — an instruction to open something the record does not contain, in the one record
// that survives a factory reset.
//
// A record with no id is REACHABLE, not hypothetical. Both QuickBooks payment handlers return
// `{ success: true, externalId: res.data?.Payment?.Id }` / `?.BillPayment?.Id` — a deeply-optional
// read with no presence check — and `persistFreshQboPostOrEscalate` is called with
// `syncResult.externalId ?? null`, so a successful post with no id escalates here as
// `postedExternalId: null`. The Xero side reaches it from the other direction: `postedExternalId`
// is nullable on `UnrecordablePostedDocument` and its wording already prints "(no id returned)".
//
// The classification now depends on the operation semantics AND the recorded result.
// ---------------------------------------------------------------------------

/** A QuickBooks INVOICE_PAYMENT that succeeded and returned no id — the shape the handler can produce. */
const QBO_DOCUMENT_WITHOUT_ID_INCIDENT: ActivityRow = {
  action: QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  level: 'ERROR',
  metadata: { type: 'INVOICE_PAYMENT', syncLogId: 'log-9', postedExternalId: null },
  description: 'QuickBooks INVOICE_PAYMENT for SalesOrder order-9 POSTED as (no id returned).',
}

// MUTATION THAT KILLS THIS: delete the `postedExternalId` branch from `classifyUnrecordedIncident`
// (return `kind` directly) — every assertion below the first pair fails with 'LEDGER_DOCUMENT'.
// Narrowing the check to `postedExternalId !== undefined` fails the `null` and `''` cases, which are
// the two the shipped writers actually produce. Both were run.
test('ROUND 8: a document type with no recorded identifier is NOT classified as openable', async () => {
  const { classifyUnrecordedIncident } = await import('@/lib/domain/accounting/unrecorded-posted-document')

  // With an id, nothing changes.
  assert.equal(
    classifyUnrecordedIncident({ type: 'INVOICE_PAYMENT', postedExternalId: 'PAY-1' }),
    'LEDGER_DOCUMENT',
  )

  // Without one — in each of the three shapes the writers can produce: the key absent (the JSON
  // round-trip in `unpersistedQboPostRecord` drops an `undefined`), an explicit null (what
  // `syncResult.externalId ?? null` writes), and an empty string.
  for (const metadata of [
    { type: 'INVOICE_PAYMENT' },
    { type: 'INVOICE_PAYMENT', postedExternalId: null },
    { type: 'INVOICE_PAYMENT', postedExternalId: '' },
    { type: 'BILL_PAYMENT', postedExternalId: null },
    { type: 'SALES_INVOICE', postedExternalId: null },
  ]) {
    assert.equal(
      classifyUnrecordedIncident(metadata),
      'LEDGER_DOCUMENT_NO_IDENTIFIER',
      JSON.stringify(metadata),
    )
  }

  // The downgrade applies ONLY to the document kinds. The others are the ones whose id is EXPECTED
  // to be absent, and their sentences never promised one — moving them would be a fresh falsehood.
  assert.equal(classifyUnrecordedIncident({ type: 'PURCHASE_CREDIT_NOTE_ALLOCATION' }), 'LEDGER_NON_DOCUMENT')
  assert.equal(classifyUnrecordedIncident({ type: 'TAX_RATE_SYNC', postedExternalId: null }), 'LEDGER_NON_DOCUMENT')
  assert.equal(classifyUnrecordedIncident({ type: 'INVOICE_EMAIL' }), 'NO_IDENTIFIER_SIDE_EFFECT')
  assert.equal(classifyUnrecordedIncident({ type: 'FUTURE_THING', postedExternalId: 'X' }), 'UNCLASSIFIED')
})

// MUTATION THAT KILLS THIS: fold LEDGER_DOCUMENT_NO_IDENTIFIER back into LEDGER_DOCUMENT anywhere —
// in the classifier, or by deleting the new `if (counts.LEDGER_DOCUMENT_NO_IDENTIFIER > 0)` block so
// the row falls through uncounted. The first makes "Open the id in that system" reappear and fails
// the doesNotMatch; the second breaks the `preserved` / per-kind reconciliation. Both were run.
test('ROUND 8: the breadcrumb for such a record does not tell an operator to open an id', async () => {
  reset([QBO_DOCUMENT_WITHOUT_ID_INCIDENT])

  await runReset('full')

  const breadcrumb = state.activity.find((row) => row.action === 'database_reset_preserved_unrecorded_documents')
  assert.ok(breadcrumb)

  // THE DEFECT: the openable-document sentence, earned by a record with nothing to open.
  assert.doesNotMatch(breadcrumb.description, /Open the id in that system/)
  assert.doesNotMatch(breadcrumb.description, /Xero or QuickBooks accepted and still holds/)

  // What it says instead — the write is still real, and that is still stated.
  assert.match(breadcrumb.description, /1 are the same kind of write/)
  assert.match(breadcrumb.description, /ON A RECORD THAT CARRIES NO ID/)
  assert.match(breadcrumb.description, /DO NOT GO LOOKING FOR AN ID/)
  assert.match(breadcrumb.description, /^Database reset kept 1 record/)

  const metadata = (breadcrumb as unknown as { metadata?: Record<string, unknown> }).metadata
  assert.equal(metadata?.ledgerDocuments, 0, 'it is not counted among the ones that can be opened')
  assert.equal(metadata?.ledgerDocumentsWithoutIdentifier, 1)
  assert.equal(metadata?.ledgerNonDocuments, 0, 'nor demoted to a kind whose write is not a document')
  assert.equal(metadata?.noIdentifierSideEffects, 0)
  assert.equal(metadata?.unclassified, 0)
  assert.equal(metadata?.preserved, 1)
})

// MUTATION THAT KILLS THIS: restore the unconditional 'REMEDY: open the id above in QuickBooks' tail
// to `describeUnpersistedQboPost` — the doesNotMatch fails on the no-id incident. Run.
test('ROUND 8: the per-incident record stops promising an id it does not carry', async () => {
  const { describeUnpersistedQboPost, describeUnrecordablePostedDocument } =
    await import('@/lib/domain/accounting/unrecorded-posted-document')

  const withoutId = describeUnpersistedQboPost(
    { entry: { id: 'log-9', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-9' }, postedExternalId: null },
    new Error('write conflict'),
  )
  assert.doesNotMatch(withoutId, /open the id above in QuickBooks/)
  assert.match(withoutId, /THE RESPONSE CARRIED NO ID EITHER/)
  assert.match(withoutId, /find the document in QuickBooks by the reference above, its amount and its date/)

  // With an id, the remedy that WAS performable is unchanged.
  const withId = describeUnpersistedQboPost(
    { entry: { id: 'log-9', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-9' }, postedExternalId: 'PAY-1' },
    new Error('write conflict'),
  )
  assert.match(withId, /open the id above in QuickBooks/)
  assert.doesNotMatch(withId, /THE RESPONSE CARRIED NO ID EITHER/)

  // The Xero record has the same hole and the same fix.
  const xeroNoId = describeUnrecordablePostedDocument({
    entry: { id: 'log-8', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-8' },
    postedExternalId: null,
    reason: 'ROW_MISSING',
    namedExternalId: null,
  })
  assert.doesNotMatch(xeroNoId, /find it in Xero by the id above/)
  assert.match(xeroNoId, /NO ID WAS RETURNED, so there is nothing to open/)

  const xeroBothIds = describeUnrecordablePostedDocument({
    entry: { id: 'log-8', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-8' },
    postedExternalId: 'INV-SECOND',
    reason: 'ANOTHER_DOCUMENT_NAMED',
    namedExternalId: 'INV-FIRST',
  })
  assert.match(xeroBothIds, /open both ids in Xero/)

  const xeroOneId = describeUnrecordablePostedDocument({
    entry: { id: 'log-8', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-8' },
    postedExternalId: null,
    reason: 'ANOTHER_DOCUMENT_NAMED',
    namedExternalId: 'INV-FIRST',
  })
  assert.doesNotMatch(xeroOneId, /open both ids in Xero/)
  assert.match(xeroOneId, /ONE OF THE TWO IDS IS NOT RECORDED HERE/)
})
