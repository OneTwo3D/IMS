import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// (header replaced)
// THE DAILY BATCH THROUGH THE PRODUCER SEAM: THE DIFFERENTIAL AT THE CALLER THAT HAS NO FACADE.
//
// `createPendingSyncLog` (lib/connectors/xero/daily-sync.ts) writes the batch journal's sync row, schedules its outbox
// job and mirrors it to an accounting event. With the producer-side hold enforced and nothing granted (the P0/P1
// posture) it must do NONE of the last two and write only the CANCELLED / HELD_SHADOW row; with the switch off, or fully
// granted, it must do exactly what it did before. The same Group B run is made in each state and the rows, outbox calls
// and mirror calls are compared. Named mutations (shown red in the PR, restored from a copy, md5-verified):
//   a  schedule-anyway   createPendingSyncLog schedules the outbox job for a shadow: the "no outbox job" arm goes red
//   b  mirror-a-shadow   it mirrors the shadow to an accounting event: the "no event" arm goes red
//   c  seam-bypassed     createAccountingSyncLogRow stops asking the seam: the shadow arm goes red

const BATCH_DAY = '2026-07-20'

const created: Array<{ type: string; referenceId: string; payload: Record<string, unknown>; status?: string; settlementBasis?: string | null; abandonedBeforeRemoteCall?: boolean | null; errorMessage?: string | null }> = []
const outboxCalls: string[] = []
const mirrorCalls: string[] = []
let shadowUpserts = 0
/** FAILED batch journals the daily run finds, and the ids it puts back to PENDING. */
let failedBatchLogs: Array<{ id: string; type: string; referenceId: string; payload: Record<string, unknown> }> = []
const requeued: string[] = []
const activity: Array<Record<string, unknown>> = []

const SHIPMENT = {
  id: 'ship-1',
  orderId: 'order-1',
  warehouseId: 'wh-1',
  createdAt: new Date(`${BATCH_DAY}T08:00:00.000Z`),
  cogsBatchAmount: 40,
  lines: [
    {
      id: 'sl-1',
      lineId: 'line-1',
      productId: 'prod-1',
      qty: 2,
      costLayerSnapshot: [{ costLayerId: 'cl-1', qty: '2.000000', unitCostBase: '20.000000' }],
      line: { id: 'line-1', productId: 'prod-1', qty: 2, totalBase: 100 },
    },
  ],
  order: {
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    status: 'PICKING',
    refundStatus: 'NONE',
    totalBase: 100,
    unearnedRevenueAmount: 100,
    lines: [{ id: 'line-1', productId: 'prod-1', qty: 2, totalBase: 100 }],
    shipments: [{ id: 'ship-1', status: 'SHIPPED', shipmentJournalDate: null, revenueRecognizedAmount: null }],
  },
}

const tx = {
  shipment: { findMany: async () => [SHIPMENT], update: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
  orderAllocation: { findMany: async () => [], update: async () => ({}) },
  shipmentLine: { findMany: async () => [], update: async () => ({}) },
  salesOrderRefundLine: { findMany: async () => [] },
  salesOrderRefund: { findMany: async () => [] },
  salesOrder: { findMany: async () => [], update: async () => ({}) },
  costLayer: { update: async () => ({}) },
  accountingSyncLog: {
    findMany: async (args?: { where?: { status?: string } }) => (args?.where?.status === 'FAILED' ? failedBatchLogs : []),
    updateMany: async (args: { where: { id?: { in: string[] }; status?: string }; data: { status?: string } }) => {
      if (args.data?.status === 'PENDING') requeued.push(...(args.where.id?.in ?? []))
      return { count: 0 }
    },
    create: async ({ data }: { data: { type: string; referenceId: string; payload: Record<string, unknown>; status?: string; settlementBasis?: string | null; abandonedBeforeRemoteCall?: boolean | null; errorMessage?: string | null } }) => {
      created.push({ type: data.type, referenceId: data.referenceId, payload: data.payload, status: data.status, settlementBasis: data.settlementBasis, abandonedBeforeRemoteCall: data.abandonedBeforeRemoteCall, errorMessage: data.errorMessage })
      return { id: `log-${created.length}` }
    },
  },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
  $queryRaw: async (query: unknown) => {
    const text = Array.isArray(query) ? query.join('?') : String((query as { strings?: string[] }).strings?.join('?') ?? '')
    if (!text.includes('outbound_shadow_writes')) return []
    shadowUpserts += 1
    return [{ id: `shadow-${shadowUpserts}`, inserted: true, occurrences: 1, accounting_sync_log_id: null, sync_row_exists: false }]
  },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      salesOrder: { findMany: async () => [] },
      shipment: { findMany: async () => [] },
      accountingSyncLog: { count: async () => 0 },
      accountingToken: { findUnique: async () => ({ tenantId: 'tenant-A' }) },
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    },
  },
})
mock.module('@/lib/db/pinned-advisory-lock', {
  namedExports: {
    acquirePinnedAdvisoryLockOrNull: async () => ({ assertHeld: () => undefined, release: async () => undefined }),
  },
})
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_sync_enabled: 'true',
      xero_sales_account: '200',
      xero_unearned_revenue_account: '830',
      xero_inventory_account: '630',
      xero_allocated_inventory_account: '631',
      xero_cogs_account: '310',
      xero_rounding_difference_account: '',
      xero_transit_account: '',
    }),
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (params: Record<string, unknown>) => { activity.push(params) } },
})
mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    mirrorAccountingSyncLogToEvent: async (_tx: unknown, params: { syncLogId: string }) => { mirrorCalls.push(params.syncLogId) },
    resetMirroredAccountingEventsToPending: async () => undefined,
    updateMirroredAccountingEventStatus: async () => undefined,
  },
})
mock.module('@/lib/connectors/xero/outbox', { namedExports: { scheduleXeroAccountingOutbox: async (_tx: unknown, params: { accountingSyncLogId: string }) => { outboxCalls.push(params.accountingSyncLogId) } } })
mock.module('@/lib/products/kit-fulfillment', {
  namedExports: {
    loadFulfillmentProductGraph: async () => ({}),
    expandFulfillmentRequirementsDecimal: (productId: string) => new Map([[productId, 1]]),
  },
})
for (const [path, load, build] of [
  ['@/lib/domain/accounting/inventory-gl-reconciliation', 'loadInventoryGlReconciliation', 'buildInventoryReconciliationSweepJournal'],
  ['@/lib/domain/accounting/cogs-gl-reconciliation', 'loadCogsGlReconciliation', 'buildCogsReconciliationSweepJournal'],
  ['@/lib/domain/accounting/transit-gl-reconciliation', 'loadTransitGlReconciliation', 'buildTransitReconciliationSweepJournal'],
] as const) {
  mock.module(path, { namedExports: { [load]: async () => null, [build]: () => null } })
}
mock.module('@/lib/domain/accounting/cogs-subledger-movement', {
  namedExports: { recordCogsSubledgerMovement: async () => undefined },
})


const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM']
const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'

async function runBatch(env: Record<string, string>): Promise<void> {
  created.length = 0
  outboxCalls.length = 0
  mirrorCalls.length = 0
  requeued.length = 0
  shadowUpserts = 0
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)
  try {
    const { runDailyBatchSync } = await import('@/lib/connectors/xero/daily-sync')
    const result = await runDailyBatchSync()
    assert.deepEqual(result.errors, [], 'the run must actually complete')
    assert.equal(result.groupB, 1, 'PRECONDITION: one shipment journaled, so the Group B journal row was produced')
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

function groupB() {
  const journals = created.filter((log) => log.type === 'DAILY_BATCH_GROUP_B')
  assert.equal(journals.length, 1, 'PRECONDITION: exactly one Group B journal row was written')
  return journals[0]!
}

test('DIFFERENTIAL, switch OFF: the batch journal is a PENDING row with its outbox job and its accounting event, exactly as before', async () => {
  await runBatch({})
  const journal = groupB()
  console.log(`# switch off: status=${journal.status} basis=${journal.settlementBasis} outbox=${outboxCalls.length} mirror=${mirrorCalls.length} shadowUpserts=${shadowUpserts}`)
  assert.equal(journal.status, 'PENDING')
  assert.equal(journal.settlementBasis, undefined)
  assert.equal(outboxCalls.length, 1)
  assert.equal(mirrorCalls.length, 1)
  assert.equal(shadowUpserts, 0)
})

test('DIFFERENTIAL, switch ON and nothing granted (P0/P1): the batch journal is a CANCELLED shadow with NO outbox job and NO accounting event, and the shadow is recorded', async () => {
  await runBatch({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' })
  const journal = groupB()
  console.log(`# switch on, ungranted: status=${journal.status} basis=${journal.settlementBasis} flag=${journal.abandonedBeforeRemoteCall} outbox=${outboxCalls.length} mirror=${mirrorCalls.length} shadowUpserts=${shadowUpserts}`)
  assert.equal(journal.status, 'CANCELLED')
  assert.equal(journal.settlementBasis, 'HELD_SHADOW')
  assert.equal(journal.abandonedBeforeRemoteCall, true)
  assert.match(String(journal.errorMessage), /^Not sent by IMS: writes to Xero are held on this installation/)
  assert.equal(outboxCalls.length, 0, 'a shadow is never given an outbox job')
  assert.equal(mirrorCalls.length, 0, 'a shadow is never an accounting event')
  assert.ok(shadowUpserts >= 1, 'the shadow was recorded')
  // The business consequence of the batch is unchanged (the order is stamped, the arithmetic is the same): the hold changes
  // what is QUEUED, not what the batch computes.
  assert.equal(journal.payload.batchGroup, 'B')
})

test('DIFFERENTIAL, switch ON and fully granted with the batch dated after the cut-off: the journal is LIVE and identical to the switch-off run', async () => {
  await runBatch({})
  const off = { ...groupB(), referenceId: 'x' }
  const offCalls = [outboxCalls.length, mirrorCalls.length]
  await runBatch({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: '2020-01-01T00:00:00Z' })
  const on = { ...groupB(), referenceId: 'x' }
  console.log(`# fully granted: status=${on.status} outbox=${outboxCalls.length} mirror=${mirrorCalls.length}`)
  assert.deepEqual(on, off)
  assert.deepEqual([outboxCalls.length, mirrorCalls.length], offCalls)
  assert.equal(shadowUpserts, 0)
})

test('THE RE-QUEUE: the daily run puts a FAILED batch journal back to PENDING when the hold is off or the decision is LIVE, and does NOT when the decision is SHADOW', async () => {
  failedBatchLogs = [{ id: 'failed-1', type: 'DAILY_BATCH_GROUP_B', referenceId: 'B-2026-01-01-abcd1234', payload: { date: '2026-01-01' } }]
  try {
    await runBatch({})
    const off = [...requeued]
    await runBatch({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' })
    const held = [...requeued]
    await runBatch({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: '2020-01-01T00:00:00Z' })
    const granted = [...requeued]
    console.log(`# re-queue: off=${JSON.stringify(off)} enforced-ungranted=${JSON.stringify(held)} granted=${JSON.stringify(granted)}`)
    assert.deepEqual(off, ['failed-1'], 'PRECONDITION: with the hold off the failed journal IS re-queued, so "not re-queued" below is not vacuous')
    assert.deepEqual(held, [], 'a held batch is not made claimable again')
    assert.deepEqual(granted, ['failed-1'], 'granted, IMS-owned and dated after the cut-off: LIVE, so it is re-queued exactly as with the hold off')
  } finally { failedBatchLogs = [] }
})
