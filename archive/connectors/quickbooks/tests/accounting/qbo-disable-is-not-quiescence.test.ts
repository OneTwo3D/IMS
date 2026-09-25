import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * ROUND 7 (Codex HIGH): TURNING `quickbooks_sync_enabled` OFF IS AN ADMISSION CHECK, NOT A FENCE.
 *
 * Rounds 5 and 6 built the whole per-row remedy on one sentence — turn the toggle off and "nothing
 * further can be queued while you work", then count the queued copies, settle the row, and turn it
 * back on. This file is that sentence, executed. It drives the SHIPPED action, the SHIPPED
 * processor and the SHIPPED settlement action, and interleaves them the way two processes really
 * interleave: the operator flips the toggle in the window between the gate's READ of it and the
 * processor call that follows, and settles the row while the admitted worker is out doing the
 * external operation.
 *
 * WHAT IT PROVES, IN ORDER:
 *   1. the run keeps going and CLAIMS the row after the toggle is off (`triggerQuickBooksSync` reads
 *      the setting and then calls the processor, with nothing in between);
 *   2. its claim leaves the row PROCESSING at attempt revision 0 — `stampingCustodyOnClaim` never
 *      writes `attemptRevision` — so it is indistinguishable from the abandoned attempt the
 *      operator is looking at, and `settleAccountingSyncRow` ADOPTS it;
 *   3. `persistFreshQboPost` then updates the row BY ID ALONE and overwrites the CANCELLED
 *      settlement with SYNCED;
 *   4. and another customer email is QUEUED inside the window the record used to call quiet.
 *
 * The record therefore no longer prescribes count/settle/re-enable at all: it says turn the toggle
 * off, LEAVE it off, and escalate the row. The missing quiescence protocol is filed as o3d-4b5p.
 *
 * REVERT EVIDENCE (each verified by making that one change and re-running this file):
 *   * re-reading `quickbooks_sync_enabled` immediately before `processPendingQuickBooksSync` in
 *     app/actions/quickbooks-sync.ts and returning early fails "the toggle is an ADMISSION CHECK".
 *   * adding `attemptRevision: { increment: 1 }` to the claim's `data` in
 *     lib/connectors/quickbooks/sync-processor.ts fails "adoption cannot tell the new claim from
 *     the abandoned one" (the adoption is refused instead).
 *   * fencing `persistFreshQboPost`'s write (`updateMany` on id + status PROCESSING) fails "the
 *     writeback overwrites the settlement".
 *   * restoring "nothing further can be queued while you work" to the record fails "the record no
 *     longer promises a quiet window".
 */

type SyncRow = Record<string, unknown> & { id: string }

const CLAIM_STALE_MS = 15 * 60 * 1000
const NOW = new Date('2026-08-20T12:00:00.000Z')
/** Older than CLAIM_STALE_MS, so the sweep treats the row as an abandoned claim. */
const ABANDONED_AT = new Date(NOW.getTime() - CLAIM_STALE_MS - 60_000)

const state = {
  rows: [] as SyncRow[],
  activity: [] as Array<Record<string, unknown>>,
  settings: new Map<string, string>(),
  activeConnector: 'quickbooks' as string | null,
  emailsQueued: 0,
  /** What the operator's settlement returned, run from inside the worker's external operation. */
  settlementResult: null as { success: boolean } | null,
  /** The row as it stood the instant the operator's settlement committed. */
  rowAfterSettlement: null as SyncRow | null,
  /** The row as the admitted worker's claim left it. */
  rowAfterClaim: null as SyncRow | null,
  /** The stored value of the toggle at the moment the processor was entered. */
  toggleWhenProcessorRan: null as string | null,
}

// --------------------------------------------------------------------------- where evaluator
function matches(row: Record<string, unknown>, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true
  for (const [key, condition] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'AND') {
      if (!(condition as unknown[]).every((clause) => matches(row, clause))) return false
      continue
    }
    if (key === 'OR') {
      if (!(condition as unknown[]).some((clause) => matches(row, clause))) return false
      continue
    }
    if (key === 'NOT') {
      if (matches(row, condition)) return false
      continue
    }
    const value = row[key] ?? null
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      for (const [op, operand] of Object.entries(condition as Record<string, unknown>)) {
        if (op === 'in') { if (!(operand as unknown[]).includes(value)) return false }
        else if (op === 'notIn') { if ((operand as unknown[]).includes(value)) return false }
        else if (op === 'not') { if (operand === null ? value === null : value === operand) return false }
        else if (op === 'lt') { if (!(Number(value) < Number(operand))) return false }
        else if (op === 'lte') { if (!(Number(value) <= Number(operand))) return false }
        else if (op === 'gt') { if (!(Number(value) > Number(operand))) return false }
        else throw new Error(`test double does not implement where operator ${op}`)
      }
      continue
    }
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function project(row: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return { ...row }
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k] ?? null]))
}

const client = {
  $executeRaw: async () => 0,
  $executeRawUnsafe: async () => 0,
  accountingSyncLog: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      const row = state.rows.find((r) => r.id === where.id)
      return row ? project(row, select) : null
    },
    findFirst: async ({ where, select }: { where: unknown; select?: Record<string, boolean> }) => {
      const row = state.rows.find((r) => matches(r, where))
      return row ? project(row, select) : null
    },
    findMany: async ({ where, select }: { where?: unknown; select?: Record<string, boolean> }) =>
      state.rows.filter((r) => matches(r, where)).map((r) => project(r, select)),
    count: async ({ where }: { where?: unknown }) => state.rows.filter((r) => matches(r, where)).length,
    updateMany: async ({ where, data }: { where: unknown; data: Record<string, unknown> }) => {
      const hits = state.rows.filter((r) => matches(r, where))
      for (const hit of hits) Object.assign(hit, data)
      return { count: hits.length }
    },
    // THE WRITEBACK UNDER TEST: `where: { id }` and nothing else.
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = state.rows.find((r) => r.id === where.id)
      if (!row) throw new Error(`fake db: no sync row ${where.id}`)
      Object.assign(row, data)
      return { ...row }
    },
    create: async ({ data }: { data: SyncRow }) => { state.rows.push({ ...data }); return data },
  },
  salesOrder: {
    findUnique: async ({ select }: { where: { id: string }; select?: Record<string, boolean> }) =>
      project({ id: 'order-1', status: 'CONFIRMED', customerId: 'cust-1' }, select),
    update: async () => ({}),
  },
  accountingEvent: { findUnique: async () => null, findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  accountingEventLog: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.activity.push(data); return data } },
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
      // Rolls back on a throw, so a transaction that fails half-way cannot leave the double in a
      // state production would never reach — which would turn a broken test into a passing one.
      $transaction: async (arg: unknown) => {
        if (typeof arg !== 'function') return Promise.all(arg as unknown[])
        const snapshot = { rows: state.rows.map((r) => ({ ...r })), activity: [...state.activity] }
        try {
          return await (arg as (tx: unknown) => Promise<unknown>)(client)
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
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })
mock.module('@/lib/integration-plugins', {
  namedExports: { isIntegrationPluginEnabled: async (id: string) => state.activeConnector === id },
})
mock.module('@/lib/accounting', {
  namedExports: {
    isAccountingConnectorConnected: async () => true,
    resolveActiveAccountingConnector: async () => state.activeConnector,
    lookupPaymentAccount: async () => null,
    getPaymentAccountMap: async () => ({}),
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) },
    logActivityPersisted: async (entry: Record<string, unknown>) => { state.activity.push(entry); return true },
    logActivityInTransaction: async (_tx: unknown, entry: Record<string, unknown>) => { state.activity.push(entry) },
    redactActivityLogText: (text: string) => text,
    sanitizeActivityLogMetadata: (metadata: unknown) => metadata,
  },
})
// NOT mocked: the real accounting-event mirror runs against the double above. Stubbing it would
// have hidden the settlement action's own use of it.

/**
 * THE INTERLEAVING POINT. The worker is out performing the external operation — this is the moment
 * an operator reading the record is doing their counting and settling. The email is really queued
 * (counted here), and the operator's settlement really runs, against the shipped action.
 */
mock.module('@/lib/accounting-email', {
  namedExports: {
    sendAccountingInvoiceEmailInternal: async () => {
      state.emailsQueued += 1
      state.rowAfterClaim = { ...state.rows[0] }
      const { settleAccountingSyncRow } = await import('@/app/actions/accounting-settlement')
      state.settlementResult = await settleAccountingSyncRow('log-1', {
        observedStatus: 'PROCESSING',
        observedAttemptRevision: 0,
        outcome: 'NOT_POSTED',
      })
      state.rowAfterSettlement = { ...state.rows[0] }
      return { success: true }
    },
  },
})

/**
 * The action imports the processor through the connector's index. Only the re-export is replaced —
 * the function it calls is the REAL `processPendingQuickBooksSync`.
 */
mock.module('@/lib/connectors/quickbooks', {
  namedExports: {
    processPendingQuickBooksSync: async () => {
      state.toggleWhenProcessorRan = state.settings.get('quickbooks_sync_enabled') ?? null
      const processor = await import('@/lib/connectors/quickbooks/sync-processor')
      return processor.processPendingQuickBooksSync()
    },
    getAuthorizationUrl: async () => '',
    disconnect: async () => {},
    isConnected: async () => true,
    syncChartOfAccounts: async () => ({}),
    getQuickBooksTaxCodes: async () => [],
  },
})

function abandonedIncidentRow(): SyncRow {
  return {
    id: 'log-1',
    connector: 'quickbooks',
    type: 'INVOICE_EMAIL',
    status: 'PROCESSING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: null,
    errorMessage: null,
    // The QuickBooks processor stamps none, and neither does the claim below.
    attemptRevision: 0,
    retryCount: 0,
    syncedAt: null,
    processingStartedAt: ABANDONED_AT,
    attemptStampingCustodyAt: ABANDONED_AT,
    remoteAttemptedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    payload: { referenceId: 'order-1' },
    settlementBasis: null,
    connectionProvenance: null,
    backReferenceEvidenceCompactedAt: null,
    followUpObligationClaimedAt: null,
  }
}

/**
 * THE RACE, RUN ONCE.
 *
 * The operator turns `quickbooks_sync_enabled` off at the only instant that matters: after the
 * gate has read it and before the processor is called. That is modelled inside the setting double,
 * so the flip happens in the real window rather than being scheduled by the test.
 */
async function runTheRace() {
  state.rows = [abandonedIncidentRow()]
  state.activity = []
  state.emailsQueued = 0
  state.settlementResult = null
  state.rowAfterClaim = null
  state.rowAfterSettlement = null
  state.toggleWhenProcessorRan = null
  state.activeConnector = 'quickbooks'
  state.settings = new Map([['quickbooks_sync_enabled', 'true']])

  const originalFindUnique = client.setting.findUnique
  let flipped = false
  client.setting.findUnique = async (args: { where: { key: string } }) => {
    const result = await originalFindUnique(args)
    if (!flipped && args.where.key === 'quickbooks_sync_enabled') {
      flipped = true
      // The operator, at the worst possible instant: the gate has its answer, the run is admitted.
      // They also retire the connector, which is the other half of the old remedy's precondition.
      state.settings.set('quickbooks_sync_enabled', 'false')
      state.activeConnector = 'xero'
    }
    return result
  }
  try {
    const { triggerQuickBooksSync } = await import('@/app/actions/quickbooks-sync')
    return await triggerQuickBooksSync()
  } finally {
    client.setting.findUnique = originalFindUnique
  }
}

test('ROUND 7: the toggle is an ADMISSION CHECK — a run that passed the read claims after it is off', async () => {
  const result = await runTheRace()

  assert.equal(result.success, true, 'the gate admitted the run, and nothing stopped it afterwards')
  assert.equal(
    state.toggleWhenProcessorRan,
    'false',
    'the processor was entered while the stored toggle already said disabled',
  )
  assert.ok(state.rowAfterClaim, 'and it reached the row: the external operation was performed')
  assert.equal(state.rowAfterClaim?.status, 'PROCESSING')
  assert.notEqual(
    (state.rowAfterClaim?.processingStartedAt as Date).getTime(),
    ABANDONED_AT.getTime(),
    'the claim is a NEW one — the abandoned attempt the operator is looking at has been replaced',
  )
})

test('ROUND 7: adoption cannot tell the new claim from the abandoned one', async () => {
  await runTheRace()

  assert.equal(
    state.rowAfterClaim?.attemptRevision,
    0,
    'stampingCustodyOnClaim writes status and custody and never attemptRevision',
  )
  assert.equal(
    state.settlementResult?.success,
    true,
    'so the adoption CAS on (id, revision 0, status) matches a row a live worker is holding',
  )
  assert.equal(state.rowAfterSettlement?.status, 'CANCELLED', 'and the operator is told the row is settled')
})

test('ROUND 7: the writeback overwrites the settlement, because it updates the row by id alone', async () => {
  await runTheRace()

  assert.equal(state.rowAfterSettlement?.status, 'CANCELLED', 'the settlement really did commit first')
  assert.equal(
    state.rows[0].status,
    'SYNCED',
    'persistFreshQboPost carries no claim token, no attempt revision and no status predicate',
  )
  assert.equal(state.rows[0].syncedAt instanceof Date, true, 'the row now reads as a completed sync')
})

test('ROUND 7: another customer email is queued inside the window the record used to call quiet', async () => {
  await runTheRace()

  assert.equal(
    state.emailsQueued,
    1,
    'the replay this record exists to stop happened after the operator turned the connector off',
  )
})

test('ROUND 7: the record no longer promises a quiet window, and no longer prescribes settling', async () => {
  const { describeUnpersistedQboPost } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  const describe = (type: string) => describeUnpersistedQboPost(
    { entry: { id: 'log-1', type: type as never, referenceType: 'SalesOrder', referenceId: 'order-1' }, postedExternalId: null },
    new Error('write conflict'),
  )

  for (const type of ['INVOICE_EMAIL', 'BILL_ATTACHMENT', 'INVOICE_PDF', 'WC_INVOICE_NOTE']) {
    const description = describe(type)

    // The sentence this file disproves, and everything rounds 5 and 6 built on it.
    assert.doesNotMatch(description, /nothing further can be queued/, type)
    assert.doesNotMatch(description, /THE PER-ROW REMEDY DOES EXIST/, type)
    assert.doesNotMatch(description, /settle this row/i, type)
    assert.doesNotMatch(description, /turn quickbooks_sync_enabled back/i, type)
    assert.doesNotMatch(description, /count the queued copies/i, type)

    // What it says instead.
    assert.match(description, /TURNING IT OFF IS NOT A FENCE/, type)
    assert.match(description, /BY ID ALONE/, type)
    assert.match(description, /THEN LEAVE IT OFF/, type)
    assert.match(description, /ESCALATE sync row log-1/, type)
    assert.match(description, /o3d-4b5p/, type)
  }
})
