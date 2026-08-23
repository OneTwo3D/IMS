import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-peh1 ROUND 3 (Codex HIGH): EVERY STEP OF THE REMEDY, WALKED AGAINST THE SHIPPED CODE.
 *
 * The QuickBooks unrecorded-post escalation told an operator to cancel the queued outbox rows and
 * then settle the sync row. NEITHER STEP EXISTED. This is the third remedy on this branch written
 * without being tried, so this file does not assert wording against wording: for each instruction
 * the message gives or withholds, it EXERCISES THE CORRESPONDING SHIPPED CODE and asserts what that
 * code actually does.
 *
 *   1. CANCEL — the outbox's own status enum, read from the generated client, is the whole
 *      vocabulary available for "deliberately not delivered". There is no such value.
 *   2. SETTLE — the real `settleAccountingSyncRow` is driven against EXACTLY the row the incident
 *      describes (QuickBooks, PROCESSING, no attempt revision, QuickBooks active) and refuses it.
 *   3. "MARK IT FAILED" — a settlement that DOES succeed is run, both ways, to show the only two
 *      statuses it can produce.
 *   4. THE LEVER THE MESSAGE DOES NAME — the accounting-sync cron is called with
 *      `quickbooks_sync_enabled` off, and returns before the processor is reached.
 *
 * REVERT EVIDENCE (each verified by putting that one thing back and re-running this file):
 *   * restoring the old INVOICE_EMAIL `check` (…"keep at most the one copy…and cancel the rest")
 *     fails "the message does not tell an operator to cancel a queued copy".
 *   * restoring the old tail ("then settle sync row X by hand (mark it SYNCED, or FAILED…)")
 *     fails "the message does not tell an operator to settle a QuickBooks row" and
 *     "the message does not offer FAILED as a settlement outcome".
 *   * deleting the `quickbooks_sync_enabled` sentence from the tail fails
 *     "the ONE lever the message names is the one that actually stops the sweep".
 */

// ---------------------------------------------------------------------------
// A database double that serves the settlement action AND the cron route
// ---------------------------------------------------------------------------

class ForbiddenError extends Error {}

type SyncRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  attemptRevision: number
  syncedAt: Date | null
  processingStartedAt: Date | null
  payload: unknown
  settlementBasis: string | null
}

const state = {
  rows: [] as SyncRow[],
  activity: [] as Array<Record<string, unknown>>,
  settings: new Map<string, string>(),
  activeConnector: 'quickbooks' as string | null,
  /** Set if anything ever reaches the QuickBooks processor — it must not, once sync is off. */
  processorRan: false,
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    const value = row[key]
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      for (const [op, operand] of Object.entries(condition as Record<string, unknown>)) {
        if (op === 'in') { if (!(operand as unknown[]).includes(value)) return false }
        else if (op === 'not') { if (operand === null ? value === null : value === operand) return false }
        else throw new Error(`test double does not implement where operator ${op}`)
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function project<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]))
}

const client = {
  accountingSyncLog: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = state.rows.find((r) => r.id === where.id)
      return row ? project(row as unknown as Record<string, unknown>, select) : null
    },
    findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
      state.rows.filter((r) => matches(r as unknown as Record<string, unknown>, where))
        .map((r) => project(r as unknown as Record<string, unknown>, select)),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hits = state.rows.filter((r) => matches(r as unknown as Record<string, unknown>, where))
      for (const hit of hits) Object.assign(hit, data)
      return { count: hits.length }
    },
  },
  salesOrder: {
    findUnique: async ({ select }: { where: { id: string }; select?: Record<string, boolean> }) =>
      project({ status: 'CONFIRMED' } as Record<string, unknown>, select),
  },
  accountingEvent: {
    findUnique: async () => null,
    updateMany: async () => ({ count: 0 }),
  },
  accountingEventLog: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  activityLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => { state.activity.push(data); return data },
  },
  // The cron's landed-cost outbox drain runs before the connector branch and is guarded by its own
  // try/catch; an empty claim keeps its noise out of this file without changing what is under test.
  integrationOutbox: { findMany: async () => [] },
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = state.settings.get(where.key)
      return value === undefined ? null : { key: where.key, value }
    },
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...client,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const snapshot = { rows: state.rows.map((r) => ({ ...r })), activity: [...state.activity] }
        try {
          return await fn(client)
        } catch (error) {
          state.rows = snapshot.rows
          state.activity = snapshot.activity
          throw error
        }
      },
    },
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshPermission: async () => ({ user: { id: 'op-1' } }),
    requirePermission: async () => ({ user: { id: 'op-1' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: { lockSalesOrder: async () => {} },
})
mock.module('@/lib/integration-plugins', {
  namedExports: { isIntegrationPluginEnabled: async (id: string) => state.activeConnector === id },
})

// The cron's own gates, so the test is about the sync toggle and nothing else.
mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
mock.module('@/lib/cron-rate-limit', {
  namedExports: { CRON_RATE_LIMIT_FIVE_MINUTE_MAX: 15, enforceCronRateLimit: async () => null },
})
mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingConnectorConnected: async () => true,
    resolveActiveAccountingConnector: async () => state.activeConnector,
  },
})
// If the gate ever lets the run through, this is what would have re-run the operation.
mock.module('@/lib/connectors/quickbooks/sync-processor', {
  namedExports: {
    processPendingQuickBooksSync: async () => {
      state.processorRan = true
      return { processed: 0, succeeded: 0, failed: 0 }
    },
  },
})

/** EXACTLY the row the incident describes: a QuickBooks no-identifier operation left claimed. */
function incidentRow(over: Partial<SyncRow> = {}): SyncRow {
  return {
    id: 'log-1',
    connector: 'quickbooks',
    type: 'INVOICE_EMAIL',
    status: 'PROCESSING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: null,
    errorMessage: null,
    // The QuickBooks processor stamps none, so the row sits here permanently.
    attemptRevision: 0,
    syncedAt: null,
    processingStartedAt: new Date('2026-08-01T00:00:00.000Z'),
    payload: {},
    settlementBasis: null,
    ...over,
  }
}

async function incidentMessage(type = 'INVOICE_EMAIL') {
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  return describeUnpersistedQboPost(
    { entry: { id: 'log-1', type: type as never, referenceType: 'SalesOrder', referenceId: 'order-1' }, postedExternalId: null },
    new Error('write conflict'),
  )
}

test.beforeEach(() => {
  state.rows = [incidentRow()]
  state.activity = []
  state.settings = new Map()
  state.activeConnector = 'quickbooks'
  state.processorRan = false
})

// ---------------------------------------------------------------------------
// STEP 1 — "cancel the queued outbox rows"
// ---------------------------------------------------------------------------

test('STEP 1: the outbox has no state that means “deliberately not delivered” (o3d-peh1 round 3)', async () => {
  const { EmailOutboxStatus } = await import('@/app/generated/prisma/client')
  const values = Object.values(EmailOutboxStatus as Record<string, string>)

  // The whole vocabulary. Read from the generated client rather than quoted from the schema, so a
  // value added later shows up here rather than in an operator's hands.
  assert.deepEqual(values.sort(), ['FAILED', 'PENDING', 'PROCESSING', 'SENT'])
  assert.equal(
    values.some((value) => /CANCEL|ABANDON|DISCARD|SUPPRESS|HELD|VOID/i.test(value)),
    false,
    'a cancel needs a state to move the row INTO, and there is none',
  )

  // FAILED is not that state: the sender writes it for a suppressed recipient and for an exhausted
  // retry, so an operator's cancel would be indistinguishable from a delivery failure.
  assert.ok(values.includes('FAILED'))
})

test('STEP 1: the message does not tell an operator to cancel a queued copy (o3d-peh1 round 3)', async () => {
  const description = await incidentMessage()

  assert.doesNotMatch(description, /cancel the rest/, 'there is no operation that cancels one')
  assert.doesNotMatch(description, /keep at most the one copy/)
  // What it says instead — the impossibility, named.
  assert.match(description, /IMS CANNOT CANCEL A QUEUED COPY/)
  assert.match(description, /every copy already queued WILL be delivered/)

  // And it still says what CAN be done, with the query that selects the rows queueEmail writes.
  for (const fragment of ['kind ACCOUNTING_INVOICE', 'referenceType SalesOrder', 'referenceId = the order id']) {
    assert.ok(description.includes(fragment), `counting them is still performable, and needs ${fragment}`)
  }
  assert.match(description, /tell the customer how many copies are on their way/)
})

// ---------------------------------------------------------------------------
// STEP 2 — "then settle the row"
// ---------------------------------------------------------------------------

test('STEP 2: the settlement action refuses THIS row, run against the shipped action (o3d-peh1 round 3)', async () => {
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')

  const result = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING',
    observedAttemptRevision: 0,
    outcome: 'NOT_POSTED',
  })

  assert.equal(result.success, false, 'the remedy told an operator to do this; the action says no')
  assert.equal('code' in result ? result.code : null, 'UNFENCED_ATTEMPT')
  assert.match('error' in result ? result.error : '', /carries no attempt revision/)

  // Nothing was written, so the row goes on being reclaimed — which is the point.
  assert.equal(state.rows[0].status, 'PROCESSING')
  assert.equal(state.activity.length, 0)
})

test('STEP 2: it is refused because QuickBooks is ACTIVE, not because it is unreachable (o3d-peh1 round 3)', async () => {
  // The adoption escape hatch exists for a row belonging to a RETIRED connector. It can never apply
  // to this incident: the connector that produced it is by definition the running one. Flipping the
  // active connector is the only difference between these two runs.
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')

  state.activeConnector = 'xero'
  const adopted = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING', observedAttemptRevision: 0, outcome: 'NOT_POSTED',
  })
  assert.equal(adopted.success, true, 'a retired-connector row CAN be adopted — so the refusal above is the active-connector rule')

  state.rows = [incidentRow()]
  state.activeConnector = 'quickbooks'
  const refused = await settleAccountingSyncRow('log-1', {
    observedStatus: 'PROCESSING', observedAttemptRevision: 0, outcome: 'NOT_POSTED',
  })
  assert.equal('code' in refused ? refused.code : null, 'UNFENCED_ATTEMPT')
})

test('STEP 2: the message does not tell an operator to settle a QuickBooks row (o3d-peh1 round 3)', async () => {
  for (const type of ['INVOICE_EMAIL', 'BILL_ATTACHMENT', 'INVOICE_PDF', 'WC_INVOICE_NOTE']) {
    const description = await incidentMessage(type)
    assert.doesNotMatch(description, /then settle sync row log-1 by hand/, `${type} still names an unperformable step`)
    assert.match(description, /WHAT YOU CANNOT DO: settle sync row log-1 by hand/, type)
    assert.match(description, /UNFENCED_ATTEMPT/, type)
  }
})

// ---------------------------------------------------------------------------
// STEP 3 — "mark it SYNCED, or FAILED if the operation must not run again"
// ---------------------------------------------------------------------------

test('STEP 3: a settlement that DOES succeed can only produce SYNCED or CANCELLED (o3d-peh1 round 3)', async () => {
  const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')
  // A fenced row on a retired connector — the one shape this action does settle — so the two
  // outcomes are observed rather than read off a type.
  state.activeConnector = 'xero'

  state.rows = [incidentRow({ connector: 'quickbooks', status: 'FAILED', attemptRevision: 4, type: 'INVOICE_PAYMENT' })]
  const notPosted = await settleAccountingSyncRow('log-1', {
    observedStatus: 'FAILED', observedAttemptRevision: 4, outcome: 'NOT_POSTED',
  })
  assert.equal(notPosted.success, true)
  assert.equal(state.rows[0].status, 'CANCELLED', 'NOT_POSTED does not reach FAILED')

  state.rows = [incidentRow({ connector: 'quickbooks', status: 'FAILED', attemptRevision: 4, type: 'INVOICE_PAYMENT' })]
  const posted = await settleAccountingSyncRow('log-1', {
    observedStatus: 'FAILED', observedAttemptRevision: 4, outcome: 'POSTED', externalTransactionId: 'INV-9001',
  })
  assert.equal(posted.success, true)
  assert.equal(state.rows[0].status, 'SYNCED', 'POSTED does not reach FAILED either')
})

test('STEP 3: the message does not offer FAILED as a settlement outcome (o3d-peh1 round 3)', async () => {
  const description = await incidentMessage()
  assert.doesNotMatch(description, /mark it SYNCED, or FAILED/)
  assert.match(description, /its only two outcomes are SYNCED and CANCELLED/)
})

// ---------------------------------------------------------------------------
// STEP 4 — the one lever the message DOES name
// ---------------------------------------------------------------------------

test('STEP 4: the ONE lever the message names is the one that actually stops the sweep (o3d-peh1 round 3)', async () => {
  const description = await incidentMessage()
  assert.match(description, /quickbooks_sync_enabled/, 'the message must name the lever it claims exists')

  const { GET } = await import('@/app/api/cron/accounting-sync/route')

  // Off — which is what the message tells the operator to do.
  state.settings = new Map()
  const skipped = await (await GET(new Request('https://ims.test/api/cron/accounting-sync'))).json()
  assert.deepEqual(skipped, { skipped: true, reason: 'QuickBooks sync disabled' })
  assert.equal(state.processorRan, false, 'the stale-claim sweep never reaches the row, so the effect stops repeating')

  // On — the control run, so the assertion above is about the toggle and not about the double.
  state.settings = new Map([['quickbooks_sync_enabled', 'true']])
  await GET(new Request('https://ims.test/api/cron/accounting-sync'))
  assert.equal(state.processorRan, true, 'with the toggle on, the sweep does run — which is why turning it off is the lever')
})

test('STEP 4: the message says the lever is BLUNT, because it stops every QuickBooks row (o3d-peh1 round 3)', async () => {
  const description = await incidentMessage()
  assert.match(description, /stops EVERY QuickBooks row, not this one/)
  assert.match(description, /recalls nothing already queued or already done/)
  // And it points at the filed work rather than implying the hole is closed.
  assert.match(description, /o3d-3lhp/)
})
