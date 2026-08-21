import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { UNRECORDED_POSTED_DOCUMENT_ACTION } from '@/lib/domain/accounting/unrecorded-posted-document'
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

function actionOf(where: unknown): { not?: string; is?: string } {
  const action = (where as { action?: unknown } | undefined)?.action
  if (typeof action === 'string') return { is: action }
  if (action && typeof action === 'object' && typeof (action as { not?: unknown }).not === 'string') {
    return { not: (action as { not: string }).not }
  }
  return {}
}

const activityLog = {
  deleteMany: async (args?: { where?: unknown }) => {
    state.deleted.push('activityLog')
    state.activityDeleteArgs = args
    const filter = actionOf(args?.where)
    const before = state.activity.length
    state.activity = state.activity.filter((row) => (filter.not ? row.action === filter.not : false))
    return { count: before - state.activity.length }
  },
  count: async (args?: { where?: unknown }) => {
    const filter = actionOf(args?.where)
    return state.activity.filter((row) => (filter.is ? row.action === filter.is : true)).length
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

test('Codex r3 medium: the exemption is in the DELETE, not a filter applied afterwards', async () => {
  reset([INCIDENT])

  await runReset('transactions')

  assert.deepEqual(
    state.activityDeleteArgs,
    { where: { action: { not: UNRECORDED_POSTED_DOCUMENT_ACTION } } },
    'the reset must never issue an unrestricted activityLog.deleteMany({})',
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
