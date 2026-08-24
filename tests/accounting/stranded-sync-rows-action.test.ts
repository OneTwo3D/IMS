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
  /** Every count the loader issued — only expected when the list was cut short. */
  counts: [] as { where: Record<string, unknown> }[],
  /** What findMany returns. The loader over-reads by one to detect truncation. */
  rows: [] as Record<string, unknown>[],
  /** What count() returns. */
  total: 0,
  /** Sync toggles as rows in `settings`. Absent means the connector's sync is OFF (round 5). */
  settings: new Map<string, string>(),
  /** Every settings read the loader issued, so "it asked" is observable rather than assumed. */
  settingQueries: [] as { where: Record<string, unknown> }[],
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
        count: async (args: { where: Record<string, unknown> }) => {
          state.counts.push(args)
          return state.total
        },
      },
      setting: {
        findMany: async (args: { where: { key: { in: string[] } } }) => {
          state.settingQueries.push(args)
          return args.where.key.in
            .filter((key) => state.settings.has(key))
            .map((key) => ({ key, value: state.settings.get(key)! }))
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
    attemptRevision: 0,
    ...over,
  }
}

test.beforeEach(() => {
  state.permissions = new Set(['sync'])
  state.activeConnector = null
  state.queries = []
  state.counts = []
  state.rows = []
  state.total = 0
  state.settings = new Map()
  state.settingQueries = []
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
  assert.deepEqual(await getStrandedAccountingSyncRows(50), { rows: [], hasMore: false, total: 0 })
  assert.equal(state.queries.length, 1)
})

test('the loader SELECTS the attempt revision — a settlement cannot name an attempt it was never given', async () => {
  // o3d-e2mz. The per-row settlement control passes the attempt it was shown straight back as the
  // fence. If the loader does not read the column, every row reaches the UI at 0 and every
  // settlement is refused as UNFENCED_ATTEMPT — indistinguishable, from the operator's side, from
  // the feature not existing.
  const getStrandedAccountingSyncRows = await loadLoader()
  await getStrandedAccountingSyncRows()
  assert.equal(state.queries[0].select.attemptRevision, true)
})

test('a stranded row reaches the UI with its settlement affordance and the reason when it has none', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.rows = [
    dbRow({ id: 'log-unfenced', status: 'FAILED', attemptRevision: 0 }),
    dbRow({ id: 'log-settleable', status: 'PROCESSING', attemptRevision: 4 }),
  ]
  const result = await getStrandedAccountingSyncRows()

  // r3, Codex finding 3: this row used to be permanently unsettleable — and so did every other row
  // on this page, because a stranded row's connector is retired and its revision never leaves 0. It
  // is now settleable by ADOPTION, and the loader is what carries that through: the list's own
  // scoping rule (connector != the active one) IS the precondition adoption needs.
  assert.equal(result.rows[0].settleable, true)
  assert.equal(result.rows[0].requiresAttemptAdoption, true)
  assert.equal(result.rows[0].notSettleableReason, null)
  assert.match(result.rows[0].settlementCaveat ?? '', /MINTS one/)
  // A claimed-forever PROCESSING row on a retired connector — the o3d-osl8 case — now has a remedy.
  assert.equal(result.rows[1].settleable, true)
  assert.equal(result.rows[1].requiresAttemptAdoption, false, 'it names a real attempt; nothing is minted')
  assert.equal(result.rows[1].attemptRevision, 4)
  assert.match(result.rows[1].settlementCaveat ?? '', /may never have returned/)
})

test('the query is scoped AWAY from the active connector, oldest first', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.activeConnector = 'xero'

  await getStrandedAccountingSyncRows()
  assert.deepEqual(state.queries[0].where, {
    status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
    connector: { not: 'xero' },
  })
  // Oldest first: the longest-stuck row is the one most likely to be blocking a delete. Tie-
  // broken on id, because rows queued in one transaction share a createdAt and a truncated page
  // ordered on createdAt alone is non-deterministic between renders.
  assert.deepEqual(state.queries[0].orderBy, [{ createdAt: 'asc' }, { id: 'asc' }])
})

test('with no accounting connector enabled, every unresolved row is stranded', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.activeConnector = null

  await getStrandedAccountingSyncRows()
  assert.deepEqual(state.queries[0].where, { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } })
})

test('the caller-supplied limit is honoured, and clamped rather than trusted', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  // Every take is limit + 1: the extra row is the truncation probe, and is dropped before the
  // rows are returned.

  await getStrandedAccountingSyncRows()
  assert.equal(state.queries[0].take, 51, 'default')

  await getStrandedAccountingSyncRows(5)
  assert.equal(state.queries[1].take, 6)

  // A client-supplied bound: never let it become an unbounded / nonsensical read.
  await getStrandedAccountingSyncRows(100_000)
  assert.equal(state.queries[2].take, 201)

  await getStrandedAccountingSyncRows(0)
  assert.equal(state.queries[3].take, 51, 'falsy limit falls back to the default')

  await getStrandedAccountingSyncRows(-7)
  assert.equal(state.queries[4].take, 2)

  await getStrandedAccountingSyncRows(Number.NaN)
  assert.equal(state.queries[5].take, 51)
})

test('truncation is reported, not hidden — the read-only list cannot clear its own backlog', async () => {
  // The starvation: nothing on this page can settle a FAILED row (that needs the claim
  // generation, o3d-e2mz), so if the oldest `limit` rows are FAILED they never move and every
  // newer stranded row is invisible forever. Returning a bare array of the oldest `limit` said
  // nothing about that at all.
  const getStrandedAccountingSyncRows = await loadLoader()
  state.rows = Array.from({ length: 4 }, (_, i) => dbRow({ id: `log-${i}` }))
  state.total = 137

  const result = await getStrandedAccountingSyncRows(3)
  assert.equal(state.queries[0].take, 4, 'reads one more than asked, to detect the overflow')
  assert.equal(result.hasMore, true)
  assert.equal(result.rows.length, 3, 'the probe row is not shown')
  assert.equal(result.total, 137, 'the caller can say "the oldest 3 of 137", not a bare "3"')
  // The count must match the SAME predicate as the page, or the total describes a different set.
  assert.equal(state.counts.length, 1)
  assert.deepEqual(state.counts[0].where, state.queries[0].where)
})

test('a complete list costs one query — the count runs only when rows are hidden', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.rows = [dbRow({ id: 'log-0' }), dbRow({ id: 'log-1' })]

  const result = await getStrandedAccountingSyncRows(3)
  assert.equal(result.hasMore, false)
  assert.equal(result.total, 2, 'a complete list is its own total')
  assert.equal(state.counts.length, 0, 'no second query when nothing is hidden')
})

test('the rows come back described, with age and identifying detail', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.rows = [dbRow({ externalTransactionId: 'INV-42' })]

  const [row] = (await getStrandedAccountingSyncRows()).rows
  assert.equal(row.connector, 'quickbooks')
  assert.equal(row.status, 'PROCESSING')
  assert.equal(row.referenceType, 'SalesOrder')
  assert.equal(row.referenceId, 'order-7')
  assert.equal(row.externalTransactionId, 'INV-42')
  assert.equal(row.errorMessage, 'HTTP 500 from QuickBooks')
  assert.equal(row.ageDays, 3)
  assert.equal(typeof row.createdAt, 'string')
})

// ---------------------------------------------------------------------------
// ROUND 5 (Codex HIGH #1) — THE LOADER ASKS WHETHER ANYTHING CAN STILL CLAIM THESE ROWS.
//
// It used to report every row on a non-active connector as adoptable, which offered the Settle
// control for QuickBooks rows the QuickBooks Sync button can still reclaim. These drive the real
// loader and assert what it PUT ON THE ROW, not what it read.
// ---------------------------------------------------------------------------

test('[round 5] the loader reads the sync toggle for the connectors on the page, and no others', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.activeConnector = 'xero'
  state.rows = [dbRow({ connector: 'quickbooks' })]

  await getStrandedAccountingSyncRows()

  assert.equal(state.settingQueries.length, 1, 'one query, not one per row')
  assert.deepEqual(
    state.settingQueries[0].where,
    { key: { in: ['quickbooks_sync_enabled'] } },
    'only the toggle a row on this page actually needs — xero has no row here',
  )
})

test('[round 5] a page with no rows asks for no toggles at all', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.rows = []
  await getStrandedAccountingSyncRows()
  assert.deepEqual(state.settingQueries, [], 'nothing to describe means nothing to look up')
})

test('[round 5] the toggle decides whether the row is offered the settle control', async () => {
  const getStrandedAccountingSyncRows = await loadLoader()
  state.activeConnector = 'xero'
  state.rows = [dbRow({ connector: 'quickbooks', status: 'PROCESSING', attemptRevision: 0 })]

  // Still enabled: the manual Sync button would reclaim it, so adoption is withheld WITH the lever.
  state.settings = new Map([['quickbooks_sync_enabled', 'true']])
  const claimable = (await getStrandedAccountingSyncRows()).rows[0]
  assert.equal(claimable.settleable, false)
  assert.equal(claimable.requiresAttemptAdoption, false)
  assert.match(claimable.notSettleableReason ?? '', /quickbooks_sync_enabled/)

  // One variable changed.
  state.settings = new Map([['quickbooks_sync_enabled', 'false']])
  const quiesced = (await getStrandedAccountingSyncRows()).rows[0]
  assert.equal(quiesced.settleable, true)
  assert.equal(quiesced.requiresAttemptAdoption, true)
  assert.equal(quiesced.notSettleableReason, null)
})

test('[round 5] two connectors on one page get two different answers', async () => {
  // With no accounting plugin enabled, buildStrandedSyncRowWhere selects EVERY unresolved row, so
  // the page really can carry both — and one connector being quiesced says nothing about the other.
  const getStrandedAccountingSyncRows = await loadLoader()
  state.activeConnector = null
  state.rows = [
    dbRow({ id: 'log-x', connector: 'xero', status: 'PROCESSING', attemptRevision: 0 }),
    dbRow({ id: 'log-q', connector: 'quickbooks', status: 'PROCESSING', attemptRevision: 0 }),
  ]
  state.settings = new Map([['quickbooks_sync_enabled', 'true']])

  const byId = new Map((await getStrandedAccountingSyncRows()).rows.map((row) => [row.id, row]))
  assert.equal(byId.get('log-x')?.settleable, true, 'xero_sync_enabled has no row, so xero is quiesced')
  assert.equal(byId.get('log-q')?.settleable, false, 'quickbooks can still be swept by its own button')
})
