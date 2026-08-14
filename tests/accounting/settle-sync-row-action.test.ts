import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-nf9i (+ o3d-osl8 item 1) — the settlement server action itself: the CAS fence, the DURABLE
// audit (same transaction as the status change), keeping the accounting-event mirror in step
// WITHOUT clobbering an attempt that still owns it, the partial-unique-index collision on the
// POSTED branch, and the permission boundary on the stranded-row loader.
//
// The real lib/activity-log.ts is deliberately NOT mocked: the whole point of
// logActivityInTransaction is that it writes through the CALLER's transaction client, so the
// transaction stub below is what proves it.

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

class ForbiddenError extends Error {}

const state = {
  /** Permissions the caller holds. The loader needs `sync`; requireAuth alone is not enough. */
  permissions: new Set<string>(['sync']),
  row: null as SyncRow | null,
  /** What the CAS updateMany reports. 0 = another writer got there first. */
  updateCount: 1,
  /** Thrown BY the CAS updateMany, e.g. the P2002 a FAILED -> SYNCED move can raise. */
  updateThrows: null as unknown,
  /** What a post-CAS re-read finds (the PERSISTED status). */
  persistedStatus: null as string | null,
  /** Other sync rows for the same identity — candidate owners of the shared mirrored event. */
  siblings: [] as SyncRow[],
  mirrorThrows: false,
  committed: [] as Write[],
  /** Set when the stranded loader actually reaches the database. */
  strandedQueried: false,
}

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'op-1' } }),
    requirePermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new ForbiddenError(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'op-1' } }
    },
    requireFreshPermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new ForbiddenError(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'op-1' } }
    },
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/integration-plugins', {
  namedExports: { isIntegrationPluginEnabled: async () => false },
})

type SyncRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  externalTransactionId: string | null
  errorMessage: string | null
  payload: unknown
}

type Write = { kind: 'sync-update'; where: Record<string, unknown>; data: Record<string, unknown> }
  | { kind: 'activity'; data: Record<string, unknown> }
  | { kind: 'mirror'; params: Record<string, unknown> }

/** Staged inside the transaction; only appended to `committed` if the transaction resolves. */
let staged: Write[] = []

const txClient = {
  accountingSyncLog: {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (state.updateThrows) throw state.updateThrows
      staged.push({ kind: 'sync-update', where, data })
      return { count: state.updateCount }
    },
    findUnique: async () => (state.persistedStatus === null ? null : { status: state.persistedStatus }),
    // The mirror-ownership read: other rows for the same identity that are live or carry post
    // evidence. The action filters in SQL; the stub returns what it is given.
    findMany: async () => state.siblings,
  },
  activityLog: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      staged.push({ kind: 'activity', data })
      return {}
    },
  },
  accountingEvent: {},
  accountingEventLog: {},
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: {
        findUnique: async () => state.row,
        findMany: async () => { state.strandedQueried = true; return [] },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        staged = []
        try {
          const result = await fn(txClient)
          state.committed.push(...staged)
          return result
        } finally {
          staged = []
        }
      },
    },
  },
})

mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    updateMirroredAccountingEventStatus: async (_client: unknown, params: Record<string, unknown>) => {
      if (state.mirrorThrows) throw new Error('mirror exploded')
      staged.push({ kind: 'mirror', params })
    },
    // Faithful to the real one in the only respect that matters here: the payload's own
    // `_idempotencyKey` wins over the sync-log id, so two ATTEMPTS at the same document share a
    // key. Non-mirrorable types yield no key at all.
    mirroredAccountingEventIdempotencyKeys: (params: { syncLogId?: string; type: string; payload: unknown }) => {
      if (params.type === 'INVOICE_PAYMENT') return []
      const shared = (params.payload as { _idempotencyKey?: string } | null)?._idempotencyKey
      return [`mirror:${shared ?? params.syncLogId}`]
    },
  },
})

async function loadModule() {
  return await import('@/app/actions/accounting-settlement')
}

async function loadAction() {
  return (await loadModule()).settleAccountingSyncRow
}

function row(overrides: Partial<SyncRow> = {}): SyncRow {
  return {
    id: 'log-1',
    connector: 'xero',
    type: 'SALES_INVOICE',
    status: 'FAILED',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: null,
    errorMessage: 'HTTP 500 from Xero',
    payload: { date: '2026-08-01' },
    ...overrides,
  }
}

test.beforeEach(() => {
  state.permissions = new Set(['sync'])
  state.row = row()
  state.updateCount = 1
  state.updateThrows = null
  state.persistedStatus = null
  state.siblings = []
  state.mirrorThrows = false
  state.committed = []
  state.strandedQueried = false
})

const activity = () => state.committed.filter((w) => w.kind === 'activity')
const mirror = () => state.committed.filter((w) => w.kind === 'mirror')
const syncUpdate = () => state.committed.filter((w) => w.kind === 'sync-update')
const auditData = () => (activity()[0].kind === 'activity' ? activity()[0].data : {})
const auditMetadata = () => auditData().metadata as Record<string, unknown>

test('POSTED: CAS fenced on the observed status, row goes SYNCED with the external id', async () => {
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', outcome: 'POSTED', externalTransactionId: 'INV-42' })

  assert.deepEqual(result, { success: true })
  assert.deepEqual(syncUpdate()[0].kind === 'sync-update' ? syncUpdate()[0].where : null, { id: 'log-1', status: 'FAILED' })
  const data = syncUpdate()[0].kind === 'sync-update' ? syncUpdate()[0].data : {}
  assert.equal(data.status, 'SYNCED')
  assert.equal(data.externalTransactionId, 'INV-42')
})

test('the audit row is written in the SAME transaction, with the operator and the prior state', async () => {
  const settle = await loadAction()
  await settle('log-1', { observedStatus: 'FAILED', outcome: 'POSTED', externalTransactionId: 'INV-42' })

  assert.equal(activity().length, 1, 'exactly one audit row')
  const audit = auditData()
  assert.equal(audit.entityType, 'SYNC')
  assert.equal(audit.entityId, 'log-1')
  assert.equal(audit.tag, 'sync')
  assert.equal(audit.level, 'WARNING')
  assert.equal(audit.userId, 'op-1')
  assert.deepEqual(
    { ...auditMetadata() },
    {
      syncLogId: 'log-1',
      connector: 'xero',
      type: 'SALES_INVOICE',
      referenceType: 'SalesOrder',
      referenceId: 'order-1',
      priorStatus: 'FAILED',
      outcome: 'POSTED',
      externalTransactionId: 'INV-42',
      userId: 'op-1',
      priorErrorMessage: 'HTTP 500 from Xero',
      mirrorUpdate: 'applied',
      mirrorConflictSyncLogId: null,
      mirrorConflictStatus: null,
    },
  )
})

test('the audit description is redacted exactly as logActivity would redact it', async () => {
  // logActivityInTransaction must not be a redaction bypass just because it is durable.
  state.row = row({ referenceId: 'ops@example.com' })
  const settle = await loadAction()
  await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED', reason: 'checked' })

  assert.match(String(auditData().description), /\[redacted-email\]/)
  assert.doesNotMatch(String(auditData().description), /ops@example\.com/)
})

test('a lost CAS changes NOTHING and reports the PERSISTED status', async () => {
  state.updateCount = 0
  state.persistedStatus = 'SYNCED'
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED' })

  assert.equal(result.success, false)
  assert.match(String(result.error), /now SYNCED/)
  assert.equal(activity().length, 0, 'a lost CAS must leave NO audit row — nothing happened to audit')
  assert.equal(mirror().length, 0, 'and must not terminalise the mirror either')
})

test('a thrown mirror update rolls the audit row back with the status change', async () => {
  state.mirrorThrows = true
  const settle = await loadAction()
  await assert.rejects(
    () => settle('log-1', { observedStatus: 'FAILED', outcome: 'POSTED', externalTransactionId: 'INV-42' }),
    /mirror exploded/,
  )
  assert.deepEqual(
    state.committed,
    [],
    'the audit is written INSIDE the transaction, so it cannot survive a rollback of the thing it describes',
  )
})

test('the mirror is terminalised for BOTH outcomes when nothing else owns it', async () => {
  const settle = await loadAction()

  await settle('log-1', { observedStatus: 'FAILED', outcome: 'POSTED', externalTransactionId: 'INV-42' })
  let params = mirror()[0].kind === 'mirror' ? mirror()[0].params : {}
  assert.equal(params.status, 'POSTED')
  assert.equal(params.externalId, 'INV-42')
  assert.equal(params.syncLogId, 'log-1')

  state.committed = []
  await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED', reason: 'nothing in the ledger' })
  params = mirror()[0].kind === 'mirror' ? mirror()[0].params : {}
  assert.equal(params.status, 'VOID', 'a PENDING mirror left behind reads as work still owed')
  assert.equal(params.externalId, null)
})

// ---------------------------------------------------------------------------
// The settleable set: FAILED, non-batch, and nothing else
// ---------------------------------------------------------------------------

test('PENDING is rejected before any read of the row (the sweeps own it)', async () => {
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'PENDING', outcome: 'NOT_POSTED' })
  assert.equal(result.success, false)
  assert.match(String(result.error), /nothing has been sent/i)
  assert.deepEqual(state.committed, [])
})

test('PROCESSING is REFUSED, and the refusal names the in-flight claim it cannot fence', async () => {
  // The o3d-osl8 descope. A CAS on PROCESSING proves the row still says PROCESSING; it proves
  // nothing about the remote call the worker already issued. Settling it NOT_POSTED would
  // CANCEL the row, unblock the hard delete, and let the call land against a deleted order —
  // the exact stranding o3d-sref stopped the orphan sweep from causing.
  state.row = row({ status: 'PROCESSING' })
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'PROCESSING', outcome: 'NOT_POSTED', reason: 'nothing in Xero' })

  assert.equal(result.success, false)
  assert.match(String(result.error), /STILL BE IN FLIGHT/)
  assert.match(String(result.error), /generation/)
  assert.deepEqual(state.committed, [], 'refused before the transaction — no status change, no audit, no mirror')
})

test('a DAILY_BATCH row is refused even though its status is FAILED (recreate vs delete guard)', async () => {
  // CANCELLED reads as "never posted" to BOTH the batch recreators and the delete guard, so
  // settling one lets an order be hard-deleted while a recreate is still building a journal that
  // contains its value. The status here is perfectly settleable; the TYPE is what refuses it.
  state.row = row({ type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceType: 'DailyBatch', referenceId: 'A2-2026-08-02' })
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED', reason: 'not in the ledger' })

  assert.equal(result.success, false)
  assert.match(String(result.error), /DAILY BATCH/)
  assert.match(String(result.error), /delete guard/)
  assert.deepEqual(state.committed, [])
})

test('an observed status that disagrees with the persisted row is refused before the transaction', async () => {
  state.row = row({ status: 'SYNCED' })
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED' })
  assert.equal(result.success, false)
  assert.match(String(result.error), /already SYNCED/)
  assert.deepEqual(state.committed, [])
})

test('NOT_POSTED against a row carrying post evidence is refused, not silently overwritten', async () => {
  state.row = row({ externalTransactionId: 'INV-777' })
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED' })
  assert.equal(result.success, false)
  assert.match(String(result.error), /INV-777/)
  assert.deepEqual(state.committed, [])
})

// ---------------------------------------------------------------------------
// MIRROR OWNERSHIP — the mirror is shared between ATTEMPTS
// ---------------------------------------------------------------------------

test('settling an old FAILED row does NOT void the mirror a SYNCED replacement owns', async () => {
  // Mirror identity is LOGICAL: both rows carry the same payload `_idempotencyKey`, so both map
  // to ONE AccountingEvent. And they can coexist, because both partial unique indexes exclude
  // FAILED. Voiding here would mark a REAL, POSTED document as deliberately abandoned and clear
  // the external id pointing at it.
  const sharedPayload = { _idempotencyKey: 'doc-1', date: '2026-08-01' }
  state.row = row({ payload: sharedPayload })
  state.siblings = [row({ id: 'log-new', status: 'SYNCED', externalTransactionId: 'INV-9', payload: sharedPayload })]

  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED', reason: 'this attempt never landed' })

  assert.deepEqual(result, { success: true }, 'the ROW is still genuinely settled — only the shared mirror is left alone')
  assert.equal(syncUpdate().length, 1)
  assert.equal(
    syncUpdate()[0].kind === 'sync-update' ? syncUpdate()[0].data.status : null,
    'CANCELLED',
  )
  assert.equal(mirror().length, 0, 'the mirror write is SKIPPED — log-new owns that event')

  // ...and the skip is visible, in the metadata AND in the description the activity feed shows.
  assert.equal(auditMetadata().mirrorUpdate, 'skipped_owned_by_another_row')
  assert.equal(auditMetadata().mirrorConflictSyncLogId, 'log-new')
  assert.equal(auditMetadata().mirrorConflictStatus, 'SYNCED')
  assert.match(String(auditData().description), /Mirrored accounting event left untouched/)
  assert.match(String(auditData().description), /log-new/)
})

test('a DEAD sibling does not own the mirror, so the mirror is still terminalised', async () => {
  const sharedPayload = { _idempotencyKey: 'doc-1', date: '2026-08-01' }
  state.row = row({ payload: sharedPayload })
  // CANCELLED with no external id: nothing owed, nothing posted, no claim on the event.
  state.siblings = [row({ id: 'log-dead', status: 'CANCELLED', payload: sharedPayload })]

  const settle = await loadAction()
  await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED' })

  assert.equal(mirror().length, 1)
  assert.equal(auditMetadata().mirrorUpdate, 'applied')
})

test('a non-mirrored type touches no mirror at all, and the audit says so', async () => {
  // INVOICE_PAYMENT — o3d-nf9i's part-payment case — is not mirrored, so there is no event to
  // own or to write, and the ownership read is skipped entirely.
  state.row = row({ type: 'INVOICE_PAYMENT' })
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED' })

  assert.deepEqual(result, { success: true })
  assert.equal(mirror().length, 0)
  assert.equal(auditMetadata().mirrorUpdate, 'not_mirrored')
})

// ---------------------------------------------------------------------------
// The POSTED branch's partial-unique-index collision
// ---------------------------------------------------------------------------

test('a P2002 on the POSTED branch becomes an explicit result, not a hung dialog', async () => {
  // FAILED -> SYNCED re-enters both partial unique indexes (predicate
  // status IN ('PENDING','PROCESSING','SYNCED')), so a historical FAILED row collides with a
  // LIVE row for the same identity. The transaction rolls back either way; what must not happen
  // is the raw exception reaching the client, which leaves the dialog spinning with nothing said.
  state.updateThrows = Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: ['idempotencyKey'] },
  })
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', outcome: 'POSTED', externalTransactionId: 'INV-42' })

  assert.equal(result.success, false)
  assert.equal((result as { code?: string }).code, 'live_row_conflict')
  assert.match(String(result.error), /Another LIVE sync row/)
  assert.match(String(result.error), /idempotencyKey/)
  assert.match(String(result.error), /Resolve that live row first/)
  assert.match(String(result.error), /will\s+not cancel it for you/, 'IMS must not retire a possibly in-flight attempt')
  assert.deepEqual(state.committed, [], 'the whole transaction rolled back — no audit, no mirror')
})

test('any OTHER error still propagates — only a unique violation is translated', async () => {
  state.updateThrows = new Error('connection reset')
  const settle = await loadAction()
  await assert.rejects(
    () => settle('log-1', { observedStatus: 'FAILED', outcome: 'POSTED', externalTransactionId: 'INV-42' }),
    /connection reset/,
  )
})

// ---------------------------------------------------------------------------
// o3d-osl8 item 1 — the loader's permission boundary
// ---------------------------------------------------------------------------

test('the stranded loader requires the `sync` permission, and reads NOTHING without it', async () => {
  // It is an exported server action, so every authenticated session can call it directly. What
  // it returns is per-row detail — sync-log ids, referenced entity ids, external transaction
  // ids, raw connector error text, across connectors — not a summary. requireAuth would hand all
  // of that to WAREHOUSE / FINANCE / READONLY / SUPPLIER.
  const { getStrandedAccountingSyncRows } = await loadModule()

  state.permissions = new Set()
  await assert.rejects(() => getStrandedAccountingSyncRows(50), /missing permission sync/)
  assert.equal(state.strandedQueried, false, 'the guard must fail BEFORE the query, not filter its result')

  state.permissions = new Set(['sync'])
  assert.deepEqual(await getStrandedAccountingSyncRows(50), [])
  assert.equal(state.strandedQueried, true)
})
