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

type ActivityRow = { action: string; description: string; level?: string }

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
  description: 'Xero SALES_INVOICE for SalesOrder order-1 POSTED as INV-XERO-SECOND, but sync row log-1 '
    + 'already names a DIFFERENT document (INV-XERO-FIRST). REMEDY: open both ids in Xero.',
}

const QBO_INCIDENT: ActivityRow = {
  action: QBO_UNRECORDED_POSTED_DOCUMENT_ACTION,
  level: 'ERROR',
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
  assert.match(breadcrumb.description, /NOT ALL LEDGER DOCUMENTS/)

  // What IS true of the whole set: each one names an effect, and the record says which.
  assert.match(breadcrumb.description, /Each record says which/)
  for (const effect of ['attached to a QuickBooks bill', 'invoice PDF', 'email queued to a customer', 'WooCommerce order']) {
    assert.ok(breadcrumb.description.includes(effect), `the non-document effects are named: ${effect}`)
  }

  // And the half-truth this same reset creates: the queued copies a record tells the reader to count
  // were deleted by `emailOutbox.deleteMany({})` a few lines above the exemption.
  assert.match(breadcrumb.description, /emptied the email outbox/)

  // Unchanged: the ledger half is still stated, because it is still true of part of the set.
  assert.match(breadcrumb.description, /Xero or QuickBooks accepted and still holds/)
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
