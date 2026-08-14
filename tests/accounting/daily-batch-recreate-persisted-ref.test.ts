import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-0qoo — the recreate sweep RE-POSTS journals, so it is the one consumer where getting
// batch identity wrong costs a DUPLICATE journal in the ledger.
//
// Both daily-sync runs capture the batch date ONCE at run start and write the per-row stage
// stamps with later new Date() calls. A run crossing UTC midnight therefore leaves a stamp
// on the day AFTER its batch's own date. The sweep used to bucket rows by that stamp and
// rebuild a `<group>-<stamp date>` reference — a batch that never existed — find no live log
// for it, and post the same journal a second time.
//
// It now keys off the exact referenceId persisted alongside the stamp. These tests drive the
// real sweep on both connectors against an in-memory AccountingSyncLog.

type SyncLogRow = { connector: string; type: string; referenceId: string; status: string }
type CreatedLog = { connector: string; type: string; referenceId: string; payload: Record<string, unknown> }

let salesOrderRows: { a1: unknown[]; a2: unknown[] } = { a1: [], a2: [] }
let shipmentRows: unknown[] = []
let syncLogs: SyncLogRow[] = []
const created: CreatedLog[] = []
const cogsMovements: Array<{ sourceRef: string; journalDate: unknown }> = []

function matchesRef(value: string, condition: unknown): boolean {
  if (typeof condition === 'string') return value === condition
  if (condition && typeof condition === 'object') {
    const cond = condition as { in?: string[]; startsWith?: string }
    if (Array.isArray(cond.in)) return cond.in.includes(value)
    if (typeof cond.startsWith === 'string') return value.startsWith(cond.startsWith)
  }
  return false
}

/** Minimal Prisma `where` evaluator covering exactly the shapes the sweep builds. */
function matchesLog(row: SyncLogRow, where: Record<string, any>): boolean {
  if (where.connector && row.connector !== where.connector) return false
  if (where.type && row.type !== where.type) return false
  if (where.status?.in && !where.status.in.includes(row.status)) return false
  if (where.referenceId !== undefined && !matchesRef(row.referenceId, where.referenceId)) return false
  if (where.OR && !where.OR.some((alt: any) => matchesRef(row.referenceId, alt.referenceId))) return false
  return true
}

const tx = {
  accountingSyncLog: {
    create: async ({ data }: { data: CreatedLog }) => {
      created.push({
        connector: data.connector,
        type: data.type,
        referenceId: data.referenceId,
        payload: data.payload,
      })
      return { id: `log-${created.length}` }
    },
  },
  activityLog: { create: async () => ({ id: 'activity-1' }) },
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async () => null },
      salesOrder: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          ('revenueDeferredDate' in where ? salesOrderRows.a1 : salesOrderRows.a2),
      },
      shipment: { findMany: async () => shipmentRows },
      accountingSyncLog: {
        count: async ({ where }: { where: Record<string, any> }) =>
          syncLogs.filter((row) => matchesLog(row, where)).length,
      },
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
    },
  },
})

mock.module('@/lib/domain/accounting/accounting-event-mirror', {
  namedExports: {
    mirrorAccountingSyncLogToEvent: async () => undefined,
    resetMirroredAccountingEventsToPending: async () => undefined,
    updateMirroredAccountingEventStatus: async () => undefined,
  },
})

mock.module('@/lib/connectors/xero/outbox', {
  namedExports: { scheduleXeroAccountingOutbox: async () => undefined },
})

mock.module('@/lib/domain/accounting/cogs-subledger-movement', {
  namedExports: {
    recordCogsSubledgerMovement: async (_client: unknown, args: { sourceRef: string; journalDate: unknown }) => {
      cogsMovements.push({ sourceRef: args.sourceRef, journalDate: args.journalDate })
    },
  },
})

const XERO_SETTINGS = {
  xero_sales_account: '200',
  xero_unearned_revenue_account: '830',
  xero_inventory_account: '630',
  xero_allocated_inventory_account: '631',
  xero_cogs_account: '310',
} as never

const QBO_SETTINGS = {
  quickbooks_sales_account: '200',
  quickbooks_unearned_revenue_account: '830',
  quickbooks_inventory_account: '630',
  quickbooks_allocated_inventory_account: '631',
  quickbooks_cogs_account: '310',
} as never

async function runXeroSweep() {
  const { recreateMissingDailyBatchLogs } = await import('@/lib/connectors/xero/daily-sync')
  await recreateMissingDailyBatchLogs(XERO_SETTINGS, 'GBP')
}

async function runQboSweep() {
  const { recreateMissingDailyBatchLogs } = await import('@/lib/connectors/quickbooks/daily-sync')
  await recreateMissingDailyBatchLogs(QBO_SETTINGS, 'GBP')
}

function reset() {
  salesOrderRows = { a1: [], a2: [] }
  shipmentRows = []
  syncLogs = []
  created.length = 0
  cogsMovements.length = 0
}

/** A batch that started 2026-07-20 and stamped this row after UTC midnight. */
const STAMP_NEXT_DAY = new Date('2026-07-21T00:04:11.000Z')
const XERO_A1_REF = 'A1-2026-07-20-1a2b3c4d'
const XERO_A2_REF = 'A2-2026-07-20-1a2b3c4d'
const XERO_B_REF = 'B-2026-07-20-1a2b3c4d'
const QBO_A1_REF = 'A1-2026-07-20'
const QBO_A2_REF = 'A2-2026-07-20'
const QBO_B_REF = 'B-2026-07-20'

// ---------------------------------------------------------------------------
// Xero
// ---------------------------------------------------------------------------

test('Xero: a midnight-crossing A1/A2/B row whose log is live under the PERSISTED ref is NOT recreated (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: XERO_A1_REF, unearnedRevenueAmount: 120 }]
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: XERO_A2_REF, allocationBatchAmount: 80 }]
  shipmentRows = [{ id: 'ship-1', shipmentJournalDate: STAMP_NEXT_DAY, shipmentJournalBatchRef: XERO_B_REF, revenueRecognizedAmount: 60, cogsBatchAmount: 40 }]
  // The batches ARE in the ledger — under their own 2026-07-20 identity, not the stamp's.
  syncLogs = [
    { connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: XERO_A1_REF, status: 'SYNCED' },
    { connector: 'xero', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: XERO_A2_REF, status: 'SYNCED' },
    { connector: 'xero', type: 'DAILY_BATCH_GROUP_B', referenceId: XERO_B_REF, status: 'PENDING' },
  ]

  await runXeroSweep()

  assert.deepEqual(created, [], 'recreating any of these double-posts a journal already in the ledger')
  assert.deepEqual(cogsMovements, [])
})

test('Xero: a genuinely missing log is recreated under the PERSISTED ref, dated from it (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: XERO_A1_REF, unearnedRevenueAmount: 120 }]
  syncLogs = []

  await runXeroSweep()

  assert.equal(created.length, 1)
  assert.equal(created[0].type, 'DAILY_BATCH_REVENUE_DEFERRAL')
  assert.equal(created[0].referenceId, XERO_A1_REF, 'rebuilt under the batch\'s own identity, not a second invented one')
  assert.equal(created[0].payload.date, '2026-07-20', 'journal date is the batch date, not the stage stamp')
  assert.equal(created[0].payload.reference, 'Revenue Deferral 2026-07-20')
})

test('Xero: a recreated Group B journal dates its DISPATCH subledger row from the batch (o3d-0qoo)', async () => {
  reset()
  shipmentRows = [{ id: 'ship-1', shipmentJournalDate: STAMP_NEXT_DAY, shipmentJournalBatchRef: XERO_B_REF, revenueRecognizedAmount: 60, cogsBatchAmount: 40 }]

  await runXeroSweep()

  assert.equal(created.length, 1)
  assert.equal(created[0].referenceId, XERO_B_REF)
  assert.equal(created[0].payload.date, '2026-07-20')
  assert.deepEqual(cogsMovements, [{ sourceRef: 'ship-1', journalDate: '2026-07-20' }],
    'the subledger row must not land a day after the GL journal it belongs to')
})

test('Xero: a legacy row with no persisted ref behaves exactly as before (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: null, allocationBatchAmount: 80 }]

  await runXeroSweep()

  assert.equal(created.length, 1)
  assert.equal(created[0].referenceId, 'A2-2026-07-21', 'pre-migration rows still derive from the stamp')
  assert.equal(created[0].payload.date, '2026-07-21')
})

test('Xero: a legacy row still sees a digest-suffixed live log for its derived date (scjz.37, o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: null, allocationBatchAmount: 80 }]
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: 'A2-2026-07-21-deadbeef', status: 'SYNCED' }]

  await runXeroSweep()

  assert.deepEqual(created, [], 'the derived prefix probe must survive the persisted-ref change')
})

test('Xero: a persisted-ref row ALSO honours a live log found only by the derived shape (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: XERO_A1_REF, unearnedRevenueAmount: 120 }]
  // Nothing under the persisted ref; only the old derived shape. The probe is a UNION, so
  // the sweep can never see FEWER live logs than it did before the column existed.
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-21-deadbeef', status: 'SYNCED' }]

  await runXeroSweep()

  assert.deepEqual(created, [], 'on ambiguity the sweep must assume a live log and skip')
})

test('Xero: an unparseable persisted ref falls back to the stamp instead of posting a junk date (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: 'not-a-batch-ref', unearnedRevenueAmount: 120 }]

  await runXeroSweep()

  assert.equal(created.length, 1)
  assert.equal(created[0].referenceId, 'A1-2026-07-21')
  assert.equal(created[0].payload.date, '2026-07-21')
})

test('Xero: rows of one split batch stay one journal, and a second batch keeps its own (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [
    { revenueDeferredDate: new Date('2026-07-20T23:59:50.000Z'), revenueDeferredBatchRef: XERO_A1_REF, unearnedRevenueAmount: 100 },
    { revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: XERO_A1_REF, unearnedRevenueAmount: 20 },
    { revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: 'A1-2026-07-21-99999999', unearnedRevenueAmount: 5 },
  ]

  await runXeroSweep()

  assert.deepEqual(
    created.map((log) => [log.referenceId, log.payload.date]),
    [[XERO_A1_REF, '2026-07-20'], ['A1-2026-07-21-99999999', '2026-07-21']],
  )
  assert.match(String(created[0].payload.narration), /2 order\(s\), £120\.00/)
})

// ---------------------------------------------------------------------------
// QuickBooks
// ---------------------------------------------------------------------------

test('QuickBooks: a midnight-crossing A1/A2/B row whose log is live under the PERSISTED ref is NOT recreated (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: QBO_A1_REF, unearnedRevenueAmount: 120 }]
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: QBO_A2_REF, allocationBatchAmount: 80 }]
  shipmentRows = [{ shipmentJournalDate: STAMP_NEXT_DAY, shipmentJournalBatchRef: QBO_B_REF, revenueRecognizedAmount: 60, cogsBatchAmount: 40 }]
  syncLogs = [
    { connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: QBO_A1_REF, status: 'SYNCED' },
    { connector: 'quickbooks', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: QBO_A2_REF, status: 'SYNCED' },
    { connector: 'quickbooks', type: 'DAILY_BATCH_GROUP_B', referenceId: QBO_B_REF, status: 'PENDING' },
  ]

  await runQboSweep()

  assert.deepEqual(created, [], 'recreating any of these double-posts a journal already in the ledger')
})

test('QuickBooks: a genuinely missing log is recreated under the PERSISTED ref, dated from it (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: QBO_A2_REF, allocationBatchAmount: 80 }]
  shipmentRows = [{ shipmentJournalDate: STAMP_NEXT_DAY, shipmentJournalBatchRef: QBO_B_REF, revenueRecognizedAmount: 60, cogsBatchAmount: 40 }]

  await runQboSweep()

  assert.deepEqual(
    created.map((log) => [log.type, log.referenceId, log.payload.date]),
    [
      ['DAILY_BATCH_INVENTORY_ALLOC', QBO_A2_REF, '2026-07-20'],
      ['DAILY_BATCH_GROUP_B', QBO_B_REF, '2026-07-20'],
    ],
    'rebuilt under the batch\'s own identity and dated from it, not from the stage stamp',
  )
})

test('QuickBooks: a legacy row with no persisted ref behaves exactly as before (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: null, unearnedRevenueAmount: 120 }]

  await runQboSweep()

  assert.equal(created.length, 1)
  assert.equal(created[0].referenceId, 'A1-2026-07-21', 'pre-migration rows still derive from the stamp')
  assert.equal(created[0].payload.date, '2026-07-21')
})

test('QuickBooks: a legacy row with a live log on its derived date is skipped (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: null, unearnedRevenueAmount: 120 }]
  syncLogs = [{ connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-21', status: 'SYNCED' }]

  await runQboSweep()

  assert.deepEqual(created, [])
})

test('QuickBooks: a persisted-ref row ALSO honours a live log found only by the derived shape (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: QBO_A1_REF, unearnedRevenueAmount: 120 }]
  syncLogs = [{ connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-21', status: 'SYNCED' }]

  await runQboSweep()

  assert.deepEqual(created, [], 'the probe is a UNION — it can never see fewer live logs than before')
})

test('QuickBooks: a live log for ANOTHER connector never counts as this one (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: QBO_A1_REF, unearnedRevenueAmount: 120 }]
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: QBO_A1_REF, status: 'SYNCED' }]

  await runQboSweep()

  assert.equal(created.length, 1, 'the QuickBooks ledger is still missing this journal')
  assert.equal(created[0].referenceId, QBO_A1_REF)
})
