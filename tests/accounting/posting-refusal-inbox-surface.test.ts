import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-j625 r4 — THE REFUSAL REACHES THE SURFACE AN OPERATOR ACTUALLY LOOKS AT.
 *
 * The sibling tests prove a refusal is WRITTEN and that the posting being made CLEARS it. This one
 * proves the other half of the owner's decision: that the exception inbox — the page that already lists
 * work IMS owes — selects those rows, counts them in its total, and hands the operator the fields it
 * needs to act (both connectors, what stands in IMS, the remedy). Without this, "durable" would be a
 * property of a table nobody reads.
 *
 * The database is doubled by a Proxy that answers "nothing there" for every model, so the only rows in
 * the inbox are the refusals under test and every count below is attributable to them.
 */

const refusalRows = [
  {
    id: 'refusal-1',
    type: 'SALES_INVOICE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    chartConnector: 'xero',
    activeConnector: 'quickbooks',
    reason: 'retired_chart',
    committed: 'the order SO-1001 is invoiced in IMS',
    remedy: 'Re-queue the invoice from the order once the accounting connector selection has settled.',
    refusedCount: 4,
    firstRefusedAt: new Date('2026-09-10T08:00:00.000Z'),
    lastRefusedAt: new Date('2026-09-14T08:00:00.000Z'),
  },
]

/**
 * BOTH predicates, separately. A single shared field was a hole the mutation harness found: the list
 * query runs after the count, so a count with the wrong predicate was overwritten and the assertion
 * passed anyway. The count is also FILTERED here rather than canned, so a predicate that stopped
 * excluding resolved rows changes the number the page badges.
 */
/** One OPEN refusal and one already resolved, so a predicate that stops excluding resolved rows shows. */
const resolvedRow = {
  ...({} as Record<string, never>),
  id: 'refusal-resolved',
  type: 'CREDIT_NOTE',
  referenceType: 'SalesOrderRefund',
  referenceId: 'refund-9',
  chartConnector: 'xero',
  activeConnector: 'xero',
  reason: 'retired_chart',
  committed: 'the refund is recorded in IMS',
  remedy: 'nothing — this one was posted after the selection settled',
  refusedCount: 1,
  firstRefusedAt: new Date('2026-09-01T08:00:00.000Z'),
  lastRefusedAt: new Date('2026-09-01T08:00:00.000Z'),
  resolvedAt: new Date('2026-09-02T08:00:00.000Z'),
}

function matchesRefusalWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  if ('resolvedAt' in where) return row.resolvedAt === where.resolvedAt
  return true
}

const seen: { countWhere?: Record<string, unknown>; listWhere?: Record<string, unknown>; listOrderBy?: unknown; listTake?: number } = {}

const emptyModel = {
  findMany: async () => [],
  findFirst: async () => null,
  findUnique: async () => null,
  count: async () => 0,
  groupBy: async () => [],
  aggregate: async () => ({}),
  updateMany: async () => ({ count: 0 }),
}

const db = new Proxy({
  accountingPostingRefusal: {
    ...emptyModel,
    // BOTH reads are recorded, because the count and the list are separate queries and a section that
    // counted rows it did not list (or listed rows it did not count) would be the usual inbox bug.
    count: async ({ where }: { where: Record<string, unknown> }) => {
      seen.countWhere = where
      return allRows.filter((row) => matchesRefusalWhere(row, where)).length
    },
    findMany: async ({ where, orderBy, take }: { where: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
      seen.listWhere = where
      seen.listOrderBy = orderBy
      seen.listTake = take
      return allRows.filter((row) => matchesRefusalWhere(row, where))
    },
  },
  $queryRaw: async () => [],
  $queryRawUnsafe: async () => [],
  $transaction: async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : []),
} as Record<string, unknown>, {
  get: (target, key: string) => (key in target ? target[key] : emptyModel),
})

const allRows = [...refusalRows.map((row) => ({ ...row, resolvedAt: null })), resolvedRow]

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'ADMIN', supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false } }),
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })

test('[o3d-j625 r4] the exception inbox LISTS refused postings, counts them in its total, and names both connectors and the remedy', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')

  const data = await getExceptionInboxData()

  assert.equal(data.summary.accountingPostingRefusals, 1, 'counted')
  assert.equal(data.summary.total, 1, 'and counted in the inbox TOTAL — the number the page badges')
  assert.equal(data.accountingPostingRefusals.length, 1, 'and listed')
  const row = data.accountingPostingRefusals[0]
  assert.equal(row.type, 'SALES_INVOICE')
  assert.equal(row.referenceType, 'SalesOrder')
  assert.equal(row.referenceId, 'so-1')
  assert.equal(row.chartConnector, 'xero', 'the chart the payload was built from')
  assert.equal(row.activeConnector, 'quickbooks', 'AND what is active now — round 2 omitted this half')
  assert.equal(row.reason, 'retired_chart')
  assert.equal(row.committed, refusalRows[0].committed)
  assert.equal(row.remedy, refusalRows[0].remedy)
  assert.equal(row.refusedCount, 4)
  assert.equal(row.firstRefusedAt, '2026-09-10T08:00:00.000Z', 'serialised for the client')
})

test('[o3d-j625 r4/r5] only OUTSTANDING refusals are selected — a resolved one is not work', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  const data = await getExceptionInboxData()
  // o3d-j625 r5 (review M-16) — ASSERTED AS BEHAVIOUR, NOT AS A LITERAL SHAPE. r4 deep-equalled the
  // predicate object, so a semantically identical rewrite (`{ resolvedAt: { equals: null } }`) failed while a
  // predicate that stopped excluding resolved rows would have to be spelt exactly wrong to be caught. What
  // matters is which rows come back.
  assert.equal(data.summary.accountingPostingRefusals, 1, 'the resolved row is not counted')
  assert.deepEqual(data.accountingPostingRefusals.map((row) => row.id), ['refusal-1'], 'nor listed')
  assert.ok(seen.countWhere && seen.listWhere, 'and both queries were made')
})

test('[o3d-j625 r5 M-16] the section is OLDEST DEBT FIRST and capped, as its own copy claims', async () => {
  const { getExceptionInboxData } = await import('@/app/actions/sync-exceptions')
  await getExceptionInboxData()
  assert.deepEqual(seen.listOrderBy, { firstRefusedAt: 'asc' },
    'the list claims oldest first: a refusal repeating for a week is the one to look at, not the one that '
    + 'last happened to run')
  assert.equal(typeof seen.listTake, 'number', 'and it is capped like every other section')
  assert.ok((seen.listTake ?? 0) > 0)
})
