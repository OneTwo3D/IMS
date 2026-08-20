import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-nf9i + o3d-osl8 item 2 — settleAccountingSyncRow: its guard, the attempt fence it is the
// caller of (o3d-e2mz), what the operator's assertion writes, what it refuses and WHY, the shared
// mirrored accounting event, and the durability of the audit.
//
// Every refusal is asserted on its SPECIFIC code, never on bare failure: the whole point of this
// action is that "it did not work" and "it landed on a different attempt than you judged" are
// completely different facts for an operator standing in front of a ledger.

class ForbiddenError extends Error {}
class FreshAuthRequiredError extends Error {
  readonly code = 'fresh_auth_required'
  readonly reason = 'stale'
}

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
}

type EventRow = { id: string; idempotencyKey: string; status: string; externalId: string | null }

const state = {
  permissions: new Set<string>(['sync']),
  freshAuthFails: false,
  rows: [] as SyncRow[],
  events: [] as EventRow[],
  eventLogs: [] as Array<Record<string, unknown>>,
  activity: [] as Array<Record<string, unknown>>,
  /** Thrown by the NEXT accountingSyncLog.updateMany, to simulate a P2002 out of the fence. */
  throwOnSyncLogUpdate: null as unknown,
  /** Thrown by the NEXT activityLog.create, to prove the audit is not best-effort. */
  throwOnActivityCreate: null as unknown,
  transactions: 0,
}

// --- a small, honest Prisma double -----------------------------------------------------------
// Only the operators these code paths actually use. Anything else throws rather than silently
// matching everything, because a matcher that quietly ignores a `where` clause turns a test into a
// tautology — which is exactly how the previous attempt's delete-guard test passed for the wrong
// reason.

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      const branches = condition as Array<Record<string, unknown>>
      if (!branches.some((branch) => matches(row, branch))) return false
      continue
    }
    const value = row[key]
    if (condition !== null && typeof condition === 'object') {
      const test = condition as Record<string, unknown>
      const keys = Object.keys(test)
      for (const op of keys) {
        if (op === 'in') {
          if (!(test.in as unknown[]).includes(value)) return false
        } else if (op === 'not') {
          if (test.not === null ? value === null : value === test.not) return false
        } else {
          throw new Error(`test double does not implement where operator ${op}`)
        }
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

function makeClient() {
  return {
    accountingSyncLog: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = state.rows.find((r) => r.id === where.id)
        return row ? project(row as unknown as Record<string, unknown>, select) : null
      },
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        return state.rows
          .filter((r) => matches(r as unknown as Record<string, unknown>, where))
          .map((r) => project(r as unknown as Record<string, unknown>, select))
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (state.throwOnSyncLogUpdate) {
          const error = state.throwOnSyncLogUpdate
          state.throwOnSyncLogUpdate = null
          throw error
        }
        const hits = state.rows.filter((r) => matches(r as unknown as Record<string, unknown>, where))
        for (const hit of hits) Object.assign(hit, data)
        return { count: hits.length }
      },
    },
    accountingEvent: {
      findUnique: async ({ where, select }: { where: { idempotencyKey: string }; select?: Record<string, boolean> }) => {
        const event = state.events.find((e) => e.idempotencyKey === where.idempotencyKey)
        return event ? project(event as unknown as Record<string, unknown>, select) : null
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = state.events.filter((e) => matches(e as unknown as Record<string, unknown>, where))
        for (const hit of hits) Object.assign(hit, data)
        return { count: hits.length }
      },
      update: async () => { throw new Error('the guarded path must not use accountingEvent.update') },
    },
    accountingEventLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.eventLogs.push(data)
        return data
      },
    },
    activityLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.throwOnActivityCreate) {
          const error = state.throwOnActivityCreate
          state.throwOnActivityCreate = null
          throw error
        }
        state.activity.push(data)
        return data
      },
    },
  }
}

const client = makeClient()

mock.module('@/lib/auth/server', {
  namedExports: {
    requireFreshPermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new ForbiddenError(`Forbidden: missing permission ${permission}`)
      if (state.freshAuthFails) throw new FreshAuthRequiredError('Re-authentication required')
      return { user: { id: 'op-1' } }
    },
    freshAuthFailureResult: (error: unknown) =>
      error instanceof FreshAuthRequiredError
        ? { success: false, error: 'Re-authentication required', code: 'fresh_auth_required', reason: 'stale' }
        : null,
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      ...client,
      // ROLLBACK IS REAL HERE. A double whose $transaction just runs the callback cannot tell
      // "nothing was written" from "everything was written and then reported as a failure", which
      // is the single most important property of this action.
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        state.transactions += 1
        const snapshot = {
          rows: state.rows.map((r) => ({ ...r })),
          events: state.events.map((e) => ({ ...e })),
          eventLogs: [...state.eventLogs],
          activity: [...state.activity],
        }
        try {
          return await fn(client)
        } catch (error) {
          state.rows = snapshot.rows
          state.events = snapshot.events
          state.eventLogs = snapshot.eventLogs
          state.activity = snapshot.activity
          throw error
        }
      },
    },
  },
})

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

// The real activity log, so its redaction and its refusal to swallow errors are the ones under
// test. It reaches the database through @/lib/db, which is the double above.
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })

async function loadAction() {
  return (await import('@/app/actions/accounting-settlement')).settleAccountingSyncRow
}

function syncRow(over: Partial<SyncRow> = {}): SyncRow {
  return {
    id: 'log-1',
    connector: 'xero',
    type: 'INVOICE_PAYMENT',
    status: 'FAILED',
    referenceType: 'SalesOrder',
    referenceId: 'order-7',
    externalTransactionId: null,
    errorMessage: 'HTTP 500 from Xero',
    attemptRevision: 3,
    syncedAt: null,
    processingStartedAt: null,
    payload: {},
    ...over,
  }
}

function notPosted(over: Record<string, unknown> = {}) {
  return { observedStatus: 'FAILED', observedAttemptRevision: 3, outcome: 'NOT_POSTED' as const, ...over }
}

function posted(over: Record<string, unknown> = {}) {
  return {
    observedStatus: 'FAILED',
    observedAttemptRevision: 3,
    outcome: 'POSTED' as const,
    externalTransactionId: 'INV-9001',
    ...over,
  }
}

function stored(id = 'log-1') {
  const row = state.rows.find((r) => r.id === id)
  assert.ok(row, `row ${id} should exist`)
  return row
}

function settlementAudit() {
  return state.activity.filter((entry) => entry.action === 'accounting_sync_row_settled')
}

test.beforeEach(() => {
  state.permissions = new Set(['sync'])
  state.freshAuthFails = false
  state.rows = [syncRow()]
  state.events = []
  state.eventLogs = []
  state.activity = []
  state.throwOnSyncLogUpdate = null
  state.throwOnActivityCreate = null
  state.transactions = 0
})

// ---------------------------------------------------------------------------
// The guard. A 'use server' export is a public HTTP endpoint.
// ---------------------------------------------------------------------------

test('settlement needs the sync permission — an authenticated session is not enough', async () => {
  const settle = await loadAction()
  state.permissions = new Set()
  await assert.rejects(() => settle('log-1', notPosted()), ForbiddenError)
  assert.equal(stored().status, 'FAILED', 'nothing was written')
  assert.equal(state.activity.length, 0)
})

test('a stale session is returned as a step-up failure, not a crash — and writes nothing', async () => {
  const settle = await loadAction()
  state.freshAuthFails = true
  const result = await settle('log-1', notPosted())
  assert.equal(result.success, false)
  assert.equal('code' in result ? result.code : null, 'fresh_auth_required')
  assert.equal(stored().status, 'FAILED')
})

// ---------------------------------------------------------------------------
// THE FENCE — o3d-e2mz. Which ATTEMPT the decision lands on.
// ---------------------------------------------------------------------------

test('a row that has never been fence-claimed is refused as UNFENCED_ATTEMPT, not settled', async () => {
  // This is the state of EVERY row today, and permanently of every QuickBooks row: that processor
  // stamps no attempt revision. A decision that cannot be tied to an attempt cannot be shown to be
  // about the attempt it will hit, so it is refused rather than run unfenced.
  const settle = await loadAction()
  state.rows = [syncRow({ attemptRevision: 0 })]
  const result = await settle('log-1', notPosted({ observedAttemptRevision: 0 }))
  assert.equal(result.success, false)
  assert.equal('code' in result ? result.code : null, 'UNFENCED_ATTEMPT')
  assert.match('error' in result ? result.error : '', /carries no attempt revision/)
  assert.equal(stored().status, 'FAILED')
  assert.equal(state.activity.length, 0, 'a refused decision writes no audit')
})

test('a decision about an EARLIER attempt is refused as ATTEMPT_MOVED and names both attempts', async () => {
  // The defect that killed both previous attempts: retryFailed* drives FAILED -> PENDING -> FAILED,
  // so the operator's conclusion about attempt 3 would otherwise land on attempt 5 — cancelling a
  // still-ambiguous attempt and removing the order's delete protection.
  const settle = await loadAction()
  state.rows = [syncRow({ attemptRevision: 5 })]
  const result = await settle('log-1', notPosted({ observedAttemptRevision: 3 }))
  assert.equal(result.success, false)
  assert.equal('code' in result ? result.code : null, 'ATTEMPT_MOVED')
  assert.match('error' in result ? result.error : '', /moved on to attempt 5/)
  assert.match('error' in result ? result.error : '', /decision was made about attempt 3/)
  assert.equal(stored().status, 'FAILED', 'the later attempt is untouched')
  assert.equal(state.activity.length, 0)
})

test('the same attempt in a different status is refused as STATUS_MOVED', async () => {
  const settle = await loadAction()
  state.rows = [syncRow({ status: 'PROCESSING', attemptRevision: 3 })]
  const result = await settle('log-1', notPosted({ observedStatus: 'FAILED', observedAttemptRevision: 3 }))
  assert.equal(result.success, false)
  assert.equal('code' in result ? result.code : null, 'STATUS_MOVED')
  assert.match('error' in result ? result.error : '', /is now PROCESSING/)
  assert.equal(stored().status, 'PROCESSING')
})

test('a deleted row is refused as ROW_MISSING before any transaction is opened', async () => {
  const settle = await loadAction()
  state.rows = []
  const result = await settle('log-1', notPosted())
  assert.equal(result.success, false)
  assert.equal('code' in result ? result.code : null, 'ROW_MISSING')
  assert.equal(state.transactions, 0)
})

test('a landed decision BUMPS the attempt, so an in-flight worker loses its writeback', async () => {
  // The bump is what makes the collision detectable by BOTH sides: the worker's own CAS is on the
  // revision it claimed, so its late write no-ops instead of silently undoing the settlement.
  const settle = await loadAction()
  const result = await settle('log-1', notPosted())
  assert.equal(result.success, true)
  assert.equal('attemptRevision' in result ? result.attemptRevision : null, 4)
  assert.equal(stored().attemptRevision, 4)
})

// ---------------------------------------------------------------------------
// What the assertion does
// ---------------------------------------------------------------------------

test('"it did NOT post" cancels the row and leaves externalTransactionId NULL', async () => {
  const settle = await loadAction()
  const result = await settle('log-1', notPosted({ reason: 'no matching payment in the org' }))
  assert.equal(result.success, true)
  assert.equal('settledStatus' in result ? result.settledStatus : null, 'CANCELLED')
  const row = stored()
  assert.equal(row.status, 'CANCELLED')
  assert.equal(row.externalTransactionId, null, 'never writes an id — that is what unblocks the delete guard')
  assert.match(String(row.errorMessage), /verified NOT POSTED/)
  assert.match(String(row.errorMessage), /no matching payment in the org/)
})

test('"it DID post" records the document id and marks the row SYNCED', async () => {
  const settle = await loadAction()
  const result = await settle('log-1', posted())
  assert.equal(result.success, true)
  assert.equal('settledStatus' in result ? result.settledStatus : null, 'SYNCED')
  const row = stored()
  assert.equal(row.status, 'SYNCED')
  assert.equal(row.externalTransactionId, 'INV-9001')
  assert.ok(row.syncedAt instanceof Date)
})

test('a PROCESSING row on a retired connector CAN be settled (o3d-osl8 item 2)', async () => {
  // Previously refused outright. It is settleable now because the decision is fenced to one attempt
  // AND the Xero processor records a document id even after losing that fence — so a wrong guess is
  // contradicted by evidence, not silently believed.
  const settle = await loadAction()
  state.rows = [syncRow({ status: 'PROCESSING', connector: 'quickbooks', attemptRevision: 2, processingStartedAt: new Date() })]
  const result = await settle('log-1', notPosted({ observedStatus: 'PROCESSING', observedAttemptRevision: 2 }))
  assert.equal(result.success, true)
  const row = stored()
  assert.equal(row.status, 'CANCELLED')
  assert.equal(row.processingStartedAt, null, 'a settled row must not still look claimed')
})

// ---------------------------------------------------------------------------
// Refusals that are about the ROW, not the attempt
// ---------------------------------------------------------------------------

test('a PENDING row is refused on the SHOWN status, before the row is even read', async () => {
  const settle = await loadAction()
  state.rows = [syncRow({ status: 'PENDING' })]
  const result = await settle('log-1', notPosted({ observedStatus: 'PENDING' }))
  assert.equal(result.success, false)
  assert.equal('code' in result ? result.code : null, 'pending_not_settleable')
  assert.equal(state.transactions, 0, 'nothing is read or written for a status that cannot be settled')
})

test('an already-terminal row cannot have its recorded outcome rewritten', async () => {
  const settle = await loadAction()
  for (const status of ['SYNCED', 'CANCELLED']) {
    const result = await settle('log-1', notPosted({ observedStatus: status }))
    assert.equal('code' in result ? result.code : null, 'already_terminal', status)
  }
})

test('a DAILY_BATCH row is refused whatever its status or attempt', async () => {
  const settle = await loadAction()
  state.rows = [syncRow({ type: 'DAILY_BATCH_GROUP_B', attemptRevision: 4 })]
  const result = await settle('log-1', notPosted({ observedAttemptRevision: 4 }))
  assert.equal(result.success, false)
  assert.equal('code' in result ? result.code : null, 'daily_batch_not_settleable')
  assert.equal(stored().status, 'FAILED')
})

test('"it did NOT post" is refused against a row that already names a document', async () => {
  // Verified evidence outranks an unverifiable assertion, and cancelling would not even achieve what
  // the operator wants: a CANCELLED row carrying an external id STILL blocks the hard delete.
  const settle = await loadAction()
  state.rows = [syncRow({ externalTransactionId: 'INV-777' })]
  const result = await settle('log-1', notPosted())
  assert.equal(result.success, false)
  assert.equal('code' in result ? result.code : null, 'contradicts_post_evidence')
  assert.equal(stored().externalTransactionId, 'INV-777')
})

test('"it DID post" needs an id, and cannot overwrite a different one', async () => {
  const settle = await loadAction()
  const missing = await settle('log-1', posted({ externalTransactionId: '  ' }))
  assert.equal('code' in missing ? missing.code : null, 'missing_external_id')

  state.rows = [syncRow({ externalTransactionId: 'INV-111' })]
  const conflict = await settle('log-1', posted())
  assert.equal('code' in conflict ? conflict.code : null, 'external_id_conflict')
  assert.equal(stored().externalTransactionId, 'INV-111')
})

test('a malformed attempt revision is refused, not sent into a query as NaN', async () => {
  // The value goes straight into a `where` clause. A non-integer would surface as a Prisma query
  // error — an unexplained 500 on a money path — rather than as a refusal the operator can read.
  const settle = await loadAction()
  for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, '3' as unknown as number]) {
    const result = await settle('log-1', notPosted({ observedAttemptRevision: bad }))
    assert.equal(result.success, false, String(bad))
    assert.equal('code' in result ? result.code : null, 'unrecognised_outcome', String(bad))
  }
  assert.equal(state.transactions, 0)
  assert.equal(stored().status, 'FAILED')
})

test('forging a HIGHER attempt than the row carries is refused by the fence, not accepted', async () => {
  const settle = await loadAction()
  state.rows = [syncRow({ attemptRevision: 0 })]
  const result = await settle('log-1', notPosted({ observedAttemptRevision: 9 }))
  assert.equal('code' in result ? result.code : null, 'UNFENCED_ATTEMPT')
  assert.equal(stored().status, 'FAILED')
})

test('an unrecognised outcome is rejected rather than coerced', async () => {
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', observedAttemptRevision: 3, outcome: 'MAYBE' } as never)
  assert.equal('code' in result ? result.code : null, 'unrecognised_outcome')
})

// ---------------------------------------------------------------------------
// The audit — the only record of who asserted what about a ledger
// ---------------------------------------------------------------------------

test('the audit names the operator, both ends of the fence, and the failure it replaced', async () => {
  const settle = await loadAction()
  await settle('log-1', notPosted({ reason: 'checked the org' }))
  const [audit] = settlementAudit()
  assert.ok(audit, 'a settlement writes exactly one audit row')
  assert.equal(audit.userId, 'op-1')
  assert.equal(audit.level, 'WARNING')
  const metadata = audit.metadata as Record<string, unknown>
  assert.equal(metadata.observedAttemptRevision, 3)
  assert.equal(metadata.priorAttemptRevision, 3)
  assert.equal(metadata.attemptRevision, 4)
  assert.equal(metadata.priorStatus, 'FAILED')
  assert.equal(metadata.settledStatus, 'CANCELLED')
  assert.equal(metadata.outcome, 'NOT_POSTED')
  assert.equal(metadata.externalTransactionId, null)
  // The POSTED patch replaces errorMessage, so the failure that made the row need settling would
  // otherwise be destroyed by the act of settling it.
  assert.equal(metadata.priorErrorMessage, 'HTTP 500 from Xero')
  assert.match(String(audit.description), /attempt 3 -> 4/)
})

test('the audit is DURABLE: if it cannot be written, the settlement does not happen', async () => {
  // logActivity swallows its own errors so logging can never break its caller. For the only record
  // of who changed a ledger-affecting status, best-effort is too weak — the status change would
  // commit with nobody's name on it and nothing would ever say so.
  const settle = await loadAction()
  state.throwOnActivityCreate = new Error('activity log unavailable')
  await assert.rejects(() => settle('log-1', notPosted()))
  assert.equal(stored().status, 'FAILED', 'the status change rolled back with the audit')
  assert.equal(stored().attemptRevision, 3, 'and so did the attempt bump')
})

// ---------------------------------------------------------------------------
// The shared mirrored accounting event
// ---------------------------------------------------------------------------

const MIRRORED = { type: 'SALES_INVOICE', payload: { _idempotencyKey: 'doc-1', date: '2026-08-01' } }

function mirrorKeyFor(connector = 'xero') {
  return `accounting-sync:${connector}:sales_invoice:doc-1`
}

test('a non-mirrored type records `not_mirrored`, not a fictional update', async () => {
  const settle = await loadAction()
  const result = await settle('log-1', notPosted())
  assert.equal('mirror' in result ? result.mirror : null, 'not_mirrored')
  assert.equal((settlementAudit()[0].metadata as Record<string, unknown>).mirrorUpdate, 'not_mirrored')
})

test('a mirrored row VOIDs its event and records that it did', async () => {
  const settle = await loadAction()
  state.rows = [syncRow({ ...MIRRORED })]
  state.events = [{ id: 'evt-1', idempotencyKey: mirrorKeyFor(), status: 'PENDING', externalId: null }]
  const result = await settle('log-1', notPosted())
  assert.equal(result.success, true)
  assert.equal('mirror' in result ? result.mirror : null, 'updated')
  assert.equal(state.events[0].status, 'VOID')
  assert.equal((settlementAudit()[0].metadata as Record<string, unknown>).mirrorUpdate, 'updated')
})

test('a mirror that matches no event records `not_found` — the audit never asserts an update that did not happen', async () => {
  // ROUND 2, FINDING 4. The previous attempt wrote `mirrorUpdate: 'applied'` BEFORE calling the
  // updater, and the updater returned silently when no event matched. A missing mirror is a
  // SUPPORTED state, so settlement could commit an audit asserting an update that never happened.
  const settle = await loadAction()
  state.rows = [syncRow({ ...MIRRORED })]
  state.events = []
  const result = await settle('log-1', notPosted())
  assert.equal(result.success, true)
  assert.equal('mirror' in result ? result.mirror : null, 'not_found')
  const audit = settlementAudit()[0]
  assert.equal((audit.metadata as Record<string, unknown>).mirrorUpdate, 'not_found')
  assert.match(String(audit.description), /No mirrored accounting event matched this row/)
})

test('a mirror that already records a posted document REFUSES the VOID and says so', async () => {
  // The ownership read is not a lock: a sibling can post between it and this write. The guard on the
  // write is what makes the losing interleaving harmless — post evidence on the mirror is never
  // erased by an assertion.
  const settle = await loadAction()
  state.rows = [syncRow({ ...MIRRORED })]
  state.events = [{ id: 'evt-1', idempotencyKey: mirrorKeyFor(), status: 'POSTED', externalId: 'INV-500' }]
  const result = await settle('log-1', notPosted())
  assert.equal(result.success, true, 'the ROW is still genuinely settled')
  assert.equal('mirror' in result ? result.mirror : null, 'refused')
  assert.deepEqual(
    { status: state.events[0].status, externalId: state.events[0].externalId },
    { status: 'POSTED', externalId: 'INV-500' },
    'the posted document keeps its record',
  )
  assert.match(String(settlementAudit()[0].description), /already records a posted document/)
})

test('a live sibling sharing the mirror keeps it — the settlement skips, and says whose it is', async () => {
  const settle = await loadAction()
  state.rows = [
    syncRow({ ...MIRRORED }),
    syncRow({ id: 'log-2', ...MIRRORED, status: 'PENDING', attemptRevision: 0 }),
  ]
  state.events = [{ id: 'evt-1', idempotencyKey: mirrorKeyFor(), status: 'PENDING', externalId: null }]
  const result = await settle('log-1', notPosted())
  assert.equal(result.success, true)
  assert.equal('mirror' in result ? result.mirror : null, 'skipped_owned_by_another_row')
  assert.equal(state.events[0].status, 'PENDING', 'the replacement attempt keeps its mirror')
  const audit = settlementAudit()[0]
  assert.equal((audit.metadata as Record<string, unknown>).mirrorConflictSyncLogId, 'log-2')
  assert.match(String(audit.description), /still owns it/)
})

// ---------------------------------------------------------------------------
// Unique-index collisions — two causes, two remedies (round 2, finding 3)
// ---------------------------------------------------------------------------

test('a collision with a LIVE sibling row is reported as such, and rolls everything back', async () => {
  const settle = await loadAction()
  state.throwOnSyncLogUpdate = { code: 'P2002', meta: { target: 'accounting_sync_logs_followup_live_unique' }, message: 'boom' }
  const result = await settle('log-1', posted())
  assert.equal(result.success, false)
  assert.equal('code' in result ? result.code : null, 'live_row_conflict')
  assert.match('error' in result ? result.error : '', /Another LIVE sync row/)
  assert.equal(stored().status, 'FAILED')
  assert.equal(state.activity.length, 0)
})

test('a document id already mapped to another accounting event gets its OWN message', async () => {
  // Previously this hit the same catch and told the operator a LIVE SYNC ROW held their identity —
  // the wrong cause, with a remedy that cannot fix a duplicate event mapping.
  const settle = await loadAction()
  state.throwOnSyncLogUpdate = { code: 'P2002', meta: { target: ['externalSystem', 'externalId'] }, message: 'boom' }
  const result = await settle('log-1', posted())
  assert.equal('code' in result ? result.code : null, 'external_id_already_mirrored')
  assert.match('error' in result ? result.error : '', /already recorded against a DIFFERENT accounting event/)
  assert.doesNotMatch('error' in result ? result.error : '', /LIVE sync row/)
})

test('a unique violation this action does not recognise is RETHROWN, not mislabelled', async () => {
  const settle = await loadAction()
  state.throwOnSyncLogUpdate = { code: 'P2002', meta: { target: ['some_unrelated_index'] }, message: 'boom' }
  await assert.rejects(() => settle('log-1', posted()))
  assert.equal(stored().status, 'FAILED')
})
