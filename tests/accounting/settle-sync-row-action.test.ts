import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-nf9i + o3d-osl8 — the settlement server action itself: the CAS fence, the DURABLE audit
// (same transaction as the status change), and keeping the accounting-event mirror in step.
//
// The real lib/activity-log.ts is deliberately NOT mocked: the whole point of
// logActivityInTransaction is that it writes through the CALLER's transaction client, so the
// transaction stub below is what proves it.

mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'op-1' } }),
    requireFreshPermission: async () => ({ user: { id: 'op-1' } }),
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

const state = {
  row: null as SyncRow | null,
  /** What the CAS updateMany reports. 0 = another writer got there first. */
  updateCount: 1,
  /** What a post-CAS re-read finds (the PERSISTED status). */
  persistedStatus: null as string | null,
  mirrorThrows: false,
  committed: [] as Write[],
}

/** Staged inside the transaction; only appended to `committed` if the transaction resolves. */
let staged: Write[] = []

const txClient = {
  accountingSyncLog: {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      staged.push({ kind: 'sync-update', where, data })
      return { count: state.updateCount }
    },
    findUnique: async () => (state.persistedStatus === null ? null : { status: state.persistedStatus }),
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
        findMany: async () => [],
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
  },
})

async function loadAction() {
  return (await import('@/app/actions/accounting-settlement')).settleAccountingSyncRow
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
  state.row = row()
  state.updateCount = 1
  state.persistedStatus = null
  state.mirrorThrows = false
  state.committed = []
})

const activity = () => state.committed.filter((w) => w.kind === 'activity')
const mirror = () => state.committed.filter((w) => w.kind === 'mirror')
const syncUpdate = () => state.committed.filter((w) => w.kind === 'sync-update')

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
  const audit = activity()[0].kind === 'activity' ? activity()[0].data : {}
  assert.equal(audit.entityType, 'SYNC')
  assert.equal(audit.entityId, 'log-1')
  assert.equal(audit.tag, 'sync')
  assert.equal(audit.level, 'WARNING')
  assert.equal(audit.userId, 'op-1')
  const metadata = audit.metadata as Record<string, unknown>
  assert.deepEqual(
    { ...metadata },
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
    },
  )
})

test('the audit description is redacted exactly as logActivity would redact it', async () => {
  // logActivityInTransaction must not be a redaction bypass just because it is durable.
  state.row = row({ referenceId: 'ops@example.com' })
  const settle = await loadAction()
  await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED', reason: 'checked' })

  const audit = activity()[0].kind === 'activity' ? activity()[0].data : {}
  assert.match(String(audit.description), /\[redacted-email\]/)
  assert.doesNotMatch(String(audit.description), /ops@example\.com/)
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

test('the mirror is terminalised for BOTH outcomes', async () => {
  const settle = await loadAction()

  await settle('log-1', { observedStatus: 'FAILED', outcome: 'POSTED', externalTransactionId: 'INV-42' })
  let params = mirror()[0].kind === 'mirror' ? mirror()[0].params : {}
  assert.equal(params.status, 'POSTED')
  assert.equal(params.externalId, 'INV-42')
  assert.equal(params.syncLogId, 'log-1')

  state.committed = []
  state.row = row({ status: 'PROCESSING' })
  await settle('log-1', { observedStatus: 'PROCESSING', outcome: 'NOT_POSTED', reason: 'retired tenant' })
  params = mirror()[0].kind === 'mirror' ? mirror()[0].params : {}
  assert.equal(params.status, 'VOID', 'a PENDING mirror left behind reads as work still owed')
  assert.equal(params.externalId, null)
})

test('PENDING is rejected before any read of the row (the sweeps own it)', async () => {
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'PENDING', outcome: 'NOT_POSTED' })
  assert.equal(result.success, false)
  assert.match(String(result.error), /Only FAILED and PROCESSING/)
  assert.deepEqual(state.committed, [])
})

test('an observed status that disagrees with the persisted row is refused before the transaction', async () => {
  state.row = row({ status: 'PROCESSING' })
  const settle = await loadAction()
  const result = await settle('log-1', { observedStatus: 'FAILED', outcome: 'NOT_POSTED' })
  assert.equal(result.success, false)
  assert.match(String(result.error), /now PROCESSING/)
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
