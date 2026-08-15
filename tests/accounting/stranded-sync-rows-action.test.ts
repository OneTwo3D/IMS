import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-osl8 item 1 — the stranded-row loader action: its permission boundary, the fact that the
// query is NOT scoped to the active connector, and the clamp on the caller-supplied limit.

class ForbiddenError extends Error {}

type FindManyArgs = {
  where: Record<string, unknown>
  orderBy: Record<string, unknown>
  take: number
  select: Record<string, boolean>
}

const state = {
  /** Permissions the caller holds. The loader needs `sync`; requireAuth alone is not enough. */
  permissions: new Set<string>(['sync']),
  /** Which accounting plugin, if any, is enabled. */
  activeConnector: null as string | null,
  /** Every findMany the loader issued. Empty proves it never reached the database. */
  queries: [] as FindManyArgs[],
  rows: [] as Record<string, unknown>[],
}

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'op-1' } }),
    requirePermission: async (permission: string) => {
      if (!state.permissions.has(permission)) throw new ForbiddenError(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'op-1' } }
    },
  },
})

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: string) => state.activeConnector === id,
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: {
        findMany: async (args: FindManyArgs) => {
          state.queries.push(args)
          return state.rows
        },
      },
    },
  },
})

async function loadLoader() {
  return (await import('@/app/actions/accounting-stranded-rows')).getStrandedAccountingSyncRows
}

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: 'log-1',
    connector: 'quickbooks',
    type: 'SALES_INVOICE',
    status: 'PROCESSING',
    referenceType: 'SalesOrder',
    referenceId: 'order-7',
    externalTransactionId: null,
    errorMessage: 'HTTP 500 from QuickBooks',
    createdAt: new Date(Date.now() - 3 * 86_400_000),
    ...over,
  }
}

test.beforeEach(() => {
  state.permissions = new Set(['sync'])
  state.activeConnector = null
  state.queries = []
  state.rows = []
})

test('the stranded loader requires the `sync` permission, and reads NOTHING without it', async () => {
  // It is an exported server action, so every authenticated session can call it directly. What
  // it returns is per-row detail — sync-log ids, referenced entity ids, external transaction
  // ids, raw connector error text, across connectors — not a summary. requireAuth would hand all
  // of that to WAREHOUSE / FINANCE / READONLY / SUPPLIER.
  const getStrandedAccountingSyncRows = await loadLoader()

  state.permissions = new Set()
  await assert.rejects(() => getStrandedAccountingSyncRows(50), /missing permission sync/)
  assert.equal(state.queries.length, 0, 'the guard must fail BEFORE the query, not filter its result')

  state.permissions = new Set(['sync'])
  assert.deepEqual(await getStrandedAccountingSyncRows(50), [])
  assert.equal(state.queries.length, 1)
})

test('the query is scoped AWAY from the active connector, oldest first', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.activeConnector = 'xero'

  await getStrandedAccountingSyncRows()
  assert.deepEqual(state.queries[0].where, {
    status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
    connector: { not: 'xero' },
  })
  // Oldest first: the longest-stuck row is the one most likely to be blocking a delete.
  assert.deepEqual(state.queries[0].orderBy, { createdAt: 'asc' })
})

test('with no accounting connector enabled, every unresolved row is stranded', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.activeConnector = null

  await getStrandedAccountingSyncRows()
  assert.deepEqual(state.queries[0].where, { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } })
})

test('the caller-supplied limit is honoured, and clamped rather than trusted', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()

  await getStrandedAccountingSyncRows()
  assert.equal(state.queries[0].take, 50, 'default')

  await getStrandedAccountingSyncRows(5)
  assert.equal(state.queries[1].take, 5)

  // A client-supplied bound: never let it become an unbounded / nonsensical read.
  await getStrandedAccountingSyncRows(100_000)
  assert.equal(state.queries[2].take, 200)

  await getStrandedAccountingSyncRows(0)
  assert.equal(state.queries[3].take, 50, 'falsy limit falls back to the default')

  await getStrandedAccountingSyncRows(-7)
  assert.equal(state.queries[4].take, 1)

  await getStrandedAccountingSyncRows(Number.NaN)
  assert.equal(state.queries[5].take, 50)
})

test('the rows come back described, with age and identifying detail', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.rows = [dbRow({ externalTransactionId: 'INV-42' })]

  const [row] = await getStrandedAccountingSyncRows()
  assert.equal(row.connector, 'quickbooks')
  assert.equal(row.status, 'PROCESSING')
  assert.equal(row.referenceType, 'SalesOrder')
  assert.equal(row.referenceId, 'order-7')
  assert.equal(row.externalTransactionId, 'INV-42')
  assert.equal(row.errorMessage, 'HTTP 500 from QuickBooks')
  assert.equal(row.ageDays, 3)
  assert.equal(typeof row.createdAt, 'string')
})
