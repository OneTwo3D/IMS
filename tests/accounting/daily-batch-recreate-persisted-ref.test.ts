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

type SyncLogRow = {
  connector: string
  type: string
  referenceId: string
  status: string
  // o3d-o97 r6: the two facts the Xero sweep judges a non-live row by. Optional, so every existing
  // fixture keeps meaning "no external id, and no record that the call was never made".
  externalTransactionId?: string | null
  abandonedBeforeRemoteCall?: boolean | null
  id?: string
}
type CreatedLog = { connector: string; type: string; referenceId: string; payload: Record<string, unknown> }

let salesOrderRows: { a1: unknown[]; a2: unknown[] } = { a1: [], a2: [] }
let shipmentRows: unknown[] = []
let syncLogs: SyncLogRow[] = []
const created: CreatedLog[] = []
const cogsMovements: Array<{ sourceRef: string; journalDate: unknown }> = []

/** The only referenceId predicates the two sweeps emit: exact, `in`, or `startsWith`. */
type RefCondition = string | { in?: string[]; startsWith?: string }

function matchesRef(value: string, condition: RefCondition | undefined): boolean {
  if (typeof condition === 'string') return value === condition
  if (condition && typeof condition === 'object') {
    if (Array.isArray(condition.in)) return condition.in.includes(value)
    if (typeof condition.startsWith === 'string') return value.startsWith(condition.startsWith)
  }
  return false
}

/**
 * Minimal Prisma `where` evaluator covering exactly the shapes the sweep builds.
 * Typed rather than `any` so a shape the sweep starts emitting that this does not model
 * fails to compile here instead of silently evaluating to "no match" (which would read as
 * "no live log" — the direction that double-posts a journal).
 */
type LogWhere = {
  connector?: string
  type?: string
  status?: { in?: string[] }
  referenceId?: RefCondition
  OR?: Array<{ referenceId?: RefCondition }>
}

function matchesLog(row: SyncLogRow, where: LogWhere): boolean {
  if (where.connector && row.connector !== where.connector) return false
  if (where.type && row.type !== where.type) return false
  if (where.status?.in && !where.status.in.includes(row.status)) return false
  if (where.referenceId !== undefined && !matchesRef(row.referenceId, where.referenceId)) return false
  if (where.OR && !where.OR.some((alt) => matchesRef(row.referenceId, alt.referenceId))) return false
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
      // o3d-19gy: the daily batch stamps the connection it was composed against onto each queued
      // payload, so the double has to have one — a batch built against no connection would be a
      // different scenario from the one these tests are about.
      accountingToken: { findUnique: async () => ({ tenantId: 'tenant-A' }) },
      salesOrder: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          const rows = 'revenueDeferredDate' in where ? salesOrderRows.a1 : salesOrderRows.a2
          // o3d-o97 r3: the A2 sweep now excludes fully-refunded orders, so the mock has to honour
          // that predicate — modelling it as "no filter" would make the exclusion untestable and
          // read as if every row were still a candidate.
          const refundStatus = where.refundStatus as { not?: string } | undefined
          if (!refundStatus?.not) return rows
          return rows.filter((row) => (row as { refundStatus?: string }).refundStatus !== refundStatus.not)
        },
      },
      shipment: { findMany: async () => shipmentRows },
      accountingSyncLog: {
        count: async ({ where }: { where: LogWhere }) =>
          syncLogs.filter((row) => matchesLog(row, where)).length,
        // o3d-o97 r6: the Xero sweep no longer filters by status in the query — it READS the rows
        // and judges them, so a cancelled row can no longer vanish from the probe's result set.
        findMany: async ({ where }: { where: LogWhere }) =>
          syncLogs.filter((row) => matchesLog(row, where)).map((row, index) => ({
            id: row.id ?? `log-${index}`,
            referenceId: row.referenceId,
            status: row.status,
            externalTransactionId: row.externalTransactionId ?? null,
            abandonedBeforeRemoteCall: row.abandonedBeforeRemoteCall ?? null,
          })),
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

async function runXeroSweep(): Promise<string[]> {
  const { recreateMissingDailyBatchLogs } = await import('@/lib/connectors/xero/daily-sync')
  return recreateMissingDailyBatchLogs(XERO_SETTINGS, 'GBP')
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

test('Xero: a persisted-ref row is NOT vouched for by another batch\'s log on the stamp date (o3d-0qoo r1)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: XERO_A1_REF, unearnedRevenueAmount: 120 }]
  // The only live log belongs to the 2026-07-21 batch. Our row was staged into the
  // 2026-07-20 batch and merely STAMPED on the 21st (midnight crossing). This log is
  // therefore a DIFFERENT batch's, and until o3d-0qoo r1 the derived probe matched it and
  // suppressed the recreate — the 07-20 journal stayed missing, silently.
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-21-deadbeef', status: 'SYNCED' }]

  await runXeroSweep()

  assert.equal(created.length, 1, 'a known identity is only vouched for by its OWN log')
  assert.equal(created[0].referenceId, XERO_A1_REF)
  assert.equal(created[0].payload.date, '2026-07-20')
})

// --- o3d-0qoo r1: the split-batch understatement (Codex adversarial review) ---
//
// Xero's live writer stamps `<group>-<date>-<8 hex digest>`, so ONE date can carry several
// batches — a window split (takeDailyBatchWindow) posts a second batch the same day with a
// different entity digest. The recreate probe used to widen every bucket to the derived
// `<group>-<date>` key AND its `<key>-` prefix, which matches BOTH digests. A live A1-D-aaaa
// then made a MISSING A1-D-bbbb look live: no recreate, no report, an understated ledger.

test('Xero: a SPLIT A1 batch recreates ONLY the missing half (o3d-0qoo r1)', async () => {
  reset()
  salesOrderRows.a1 = [
    // Split one — its log is live.
    { revenueDeferredDate: new Date('2026-07-20T09:00:00.000Z'), revenueDeferredBatchRef: 'A1-2026-07-20-aaaaaaaa', unearnedRevenueAmount: 100 },
    { revenueDeferredDate: new Date('2026-07-20T09:00:01.000Z'), revenueDeferredBatchRef: 'A1-2026-07-20-aaaaaaaa', unearnedRevenueAmount: 40 },
    // Split two — SAME group, SAME date, SAME stamp day, no log at all.
    { revenueDeferredDate: new Date('2026-07-20T17:30:00.000Z'), revenueDeferredBatchRef: 'A1-2026-07-20-bbbbbbbb', unearnedRevenueAmount: 25 },
  ]
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-20-aaaaaaaa', status: 'SYNCED' }]

  await runXeroSweep()

  assert.equal(created.length, 1, 'exactly one recreate: the live split must not be re-posted, the missing one must not be skipped')
  assert.equal(created[0].referenceId, 'A1-2026-07-20-bbbbbbbb', 'the missing split is rebuilt under its OWN identity')
  assert.equal(created[0].payload.date, '2026-07-20')
  assert.match(String(created[0].payload.narration), /1 order\(s\), £25\.00/, 'only the missing split\'s value')
})

test('Xero: a SPLIT A1 batch is skipped entirely once BOTH halves are live (o3d-0qoo r1)', async () => {
  reset()
  salesOrderRows.a1 = [
    { revenueDeferredDate: new Date('2026-07-20T09:00:00.000Z'), revenueDeferredBatchRef: 'A1-2026-07-20-aaaaaaaa', unearnedRevenueAmount: 100 },
    { revenueDeferredDate: new Date('2026-07-20T17:30:00.000Z'), revenueDeferredBatchRef: 'A1-2026-07-20-bbbbbbbb', unearnedRevenueAmount: 25 },
  ]
  syncLogs = [
    { connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-20-aaaaaaaa', status: 'SYNCED' },
    { connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-20-bbbbbbbb', status: 'PENDING' },
  ]

  await runXeroSweep()

  assert.deepEqual(created, [], 'narrowing the probe must not start double-posting live batches')
})

test('Xero: a SPLIT Group B batch recreates only the missing half, with only its shipments (o3d-0qoo r1)', async () => {
  reset()
  shipmentRows = [
    { id: 'ship-live', shipmentJournalDate: new Date('2026-07-20T09:00:00.000Z'), shipmentJournalBatchRef: 'B-2026-07-20-aaaaaaaa', revenueRecognizedAmount: 60, cogsBatchAmount: 40 },
    { id: 'ship-missing', shipmentJournalDate: new Date('2026-07-20T19:00:00.000Z'), shipmentJournalBatchRef: 'B-2026-07-20-bbbbbbbb', revenueRecognizedAmount: 10, cogsBatchAmount: 7 },
  ]
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_GROUP_B', referenceId: 'B-2026-07-20-aaaaaaaa', status: 'SYNCED' }]

  await runXeroSweep()

  assert.equal(created.length, 1)
  assert.equal(created[0].referenceId, 'B-2026-07-20-bbbbbbbb')
  assert.equal(created[0].payload.date, '2026-07-20')
  assert.deepEqual(
    cogsMovements,
    [{ sourceRef: 'ship-missing', journalDate: '2026-07-20' }],
    'the live split\'s shipment must not be re-journaled, the missing one must be',
  )
})

test('Xero: a SPLIT A2 batch recreates only the missing half (o3d-0qoo r1)', async () => {
  reset()
  salesOrderRows.a2 = [
    { inventoryAllocatedDate: new Date('2026-07-20T09:00:00.000Z'), inventoryAllocatedBatchRef: 'A2-2026-07-20-aaaaaaaa', allocationBatchAmount: 80 },
    { inventoryAllocatedDate: new Date('2026-07-20T19:00:00.000Z'), inventoryAllocatedBatchRef: 'A2-2026-07-20-bbbbbbbb', allocationBatchAmount: 15 },
  ]
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: 'A2-2026-07-20-aaaaaaaa', status: 'PENDING' }]

  await runXeroSweep()

  assert.equal(created.length, 1)
  assert.equal(created[0].referenceId, 'A2-2026-07-20-bbbbbbbb')
  assert.match(String(created[0].payload.narration), /1 order\(s\), £15\.00/)
})

// --- The mirror image: the scjz.37 digest probe must SURVIVE for derived identities ---

test('Xero: a LEGACY row on the same date as a live digest-suffixed log is still treated as live (scjz.37, o3d-0qoo r1)', async () => {
  reset()
  // Pre-migration row: no persisted ref, so its identity is only APPROXIMATED from the
  // stamp. The live batch's own referenceId carries a digest we cannot know, so the bare
  // key never matches it exactly — only the `<key>-` prefix does. Losing that probe would
  // double-post a journal already in the ledger, which is the failure the narrowing must
  // not cause.
  salesOrderRows.a1 = [{ revenueDeferredDate: new Date('2026-07-20T09:00:00.000Z'), revenueDeferredBatchRef: null, unearnedRevenueAmount: 120 }]
  salesOrderRows.a2 = [{ inventoryAllocatedDate: new Date('2026-07-20T09:00:00.000Z'), inventoryAllocatedBatchRef: null, allocationBatchAmount: 80 }]
  shipmentRows = [{ id: 'ship-legacy', shipmentJournalDate: new Date('2026-07-20T09:00:00.000Z'), shipmentJournalBatchRef: null, revenueRecognizedAmount: 60, cogsBatchAmount: 40 }]
  syncLogs = [
    { connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-20-aaaaaaaa', status: 'SYNCED' },
    { connector: 'xero', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: 'A2-2026-07-20-bbbbbbbb', status: 'SYNCED' },
    { connector: 'xero', type: 'DAILY_BATCH_GROUP_B', referenceId: 'B-2026-07-20-cccccccc', status: 'PENDING' },
  ]

  await runXeroSweep()

  assert.deepEqual(created, [], 'a bucket with no known identity must keep the wide digest-prefix probe')
  assert.deepEqual(cogsMovements, [], 'and must not write a duplicate DISPATCH subledger row')
})

test('Xero: an UNPARSEABLE persisted ref still widens to the derived digest probe (o3d-0qoo r1)', async () => {
  // Each of these fails parseDailyBatchReference for a different reason — unpadded month,
  // wrong group prefix, uppercase digest — so the bucket's identity is NOT known and it
  // must fall back to the wide derived probe rather than trusting the junk string.
  for (const badRef of ['A1-2026-7-20', 'INVRECON-2026-07-20', 'A1-2026-07-20-ABCDEF12']) {
    reset()
    salesOrderRows.a1 = [{ revenueDeferredDate: new Date('2026-07-20T09:00:00.000Z'), revenueDeferredBatchRef: badRef, unearnedRevenueAmount: 120 }]
    syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-20-aaaaaaaa', status: 'SYNCED' }]

    await runXeroSweep()

    assert.deepEqual(created, [], `an unparseable ref (${badRef}) must not narrow the probe and double-post`)
  }
})

test('Xero: an UNPARSEABLE persisted ref is still probed for EXACTLY on top of the derived key (o3d-0qoo r1)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: new Date('2026-07-20T09:00:00.000Z'), revenueDeferredBatchRef: 'INVRECON-2026-07-20', unearnedRevenueAmount: 120 }]
  // The live log sits under the junk string ITSELF, a shape neither the bare derived key
  // 'A1-2026-07-20' nor its 'A1-2026-07-20-' prefix can reach. Only the exact candidate
  // finds it — proving the unparseable ref is still contributed to `exact`.
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'INVRECON-2026-07-20', status: 'SYNCED' }]

  await runXeroSweep()

  assert.deepEqual(created, [], 'an unparseable ref only ever WIDENS its bucket\'s probe')
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

// o3d-0qoo r1 on the QuickBooks side.
//
// QuickBooks' live writer stamps the BARE `<group>-<date>` (no entity digest), so two
// same-date batches share one referenceId and a digest split cannot arise here. The same
// defect still does: a persisted `A1-2026-07-20` bucket whose rows were stamped after UTC
// midnight also probed the derived `A1-2026-07-21`, which is a REAL and DIFFERENT daily
// batch's identity on this connector. A live 07-21 log therefore vouched for a missing
// 07-20 one, and the 07-20 journal was never rebuilt — the same silent understatement.

test('QuickBooks: a persisted-ref row is NOT vouched for by the NEXT DAY\'s batch log (o3d-0qoo r1)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: QBO_A1_REF, unearnedRevenueAmount: 120 }]
  syncLogs = [{ connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-21', status: 'SYNCED' }]

  await runQboSweep()

  assert.equal(created.length, 1, 'A1-2026-07-21 is another batch — it cannot stand in for A1-2026-07-20')
  assert.equal(created[0].referenceId, QBO_A1_REF)
  assert.equal(created[0].payload.date, '2026-07-20')
})

test('QuickBooks: one live batch and one missing batch on adjacent days recreates exactly one (o3d-0qoo r1)', async () => {
  reset()
  salesOrderRows.a1 = [
    // Batch 2026-07-20, stamped after midnight. Its log is MISSING.
    { revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: QBO_A1_REF, unearnedRevenueAmount: 120 },
    // Batch 2026-07-21, stamped the same day. Its log is LIVE.
    { revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: 'A1-2026-07-21', unearnedRevenueAmount: 55 },
  ]
  syncLogs = [{ connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-21', status: 'SYNCED' }]

  await runQboSweep()

  assert.deepEqual(
    created.map((log) => [log.referenceId, log.payload.date, log.payload.narration]),
    [[QBO_A1_REF, '2026-07-20', 'Recreated revenue deferral batch: 1 order(s), £120.00']],
    'only the missing batch, carrying only its own value',
  )
})

test('QuickBooks: a missing Group B batch is not vouched for by the next day\'s live one (o3d-0qoo r1)', async () => {
  reset()
  shipmentRows = [
    { shipmentJournalDate: STAMP_NEXT_DAY, shipmentJournalBatchRef: QBO_B_REF, revenueRecognizedAmount: 60, cogsBatchAmount: 40 },
    { shipmentJournalDate: STAMP_NEXT_DAY, shipmentJournalBatchRef: 'B-2026-07-21', revenueRecognizedAmount: 5, cogsBatchAmount: 3 },
  ]
  syncLogs = [{ connector: 'quickbooks', type: 'DAILY_BATCH_GROUP_B', referenceId: 'B-2026-07-21', status: 'SYNCED' }]

  await runQboSweep()

  assert.deepEqual(
    created.map((log) => [log.type, log.referenceId, log.payload.date]),
    [['DAILY_BATCH_GROUP_B', QBO_B_REF, '2026-07-20']],
  )
})

test('QuickBooks: a missing A2 batch is not vouched for by the next day\'s live one (o3d-0qoo r1)', async () => {
  reset()
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: QBO_A2_REF, allocationBatchAmount: 80 }]
  syncLogs = [{ connector: 'quickbooks', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: 'A2-2026-07-21', status: 'SYNCED' }]

  await runQboSweep()

  assert.equal(created.length, 1)
  assert.equal(created[0].referenceId, QBO_A2_REF)
  assert.equal(created[0].payload.date, '2026-07-20')
})

test('QuickBooks: a persisted-ref batch whose OWN log is live is still skipped (o3d-0qoo r1)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: QBO_A1_REF, unearnedRevenueAmount: 120 }]
  syncLogs = [
    { connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: QBO_A1_REF, status: 'PENDING' },
    { connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-21', status: 'SYNCED' },
  ]

  await runQboSweep()

  assert.deepEqual(created, [], 'narrowing the probe must not start double-posting live batches')
})

test('QuickBooks: a LEGACY row on the same date as a live log is still treated as live (o3d-0qoo r1)', async () => {
  reset()
  // No persisted ref → identity unknown → keeps the wide derived probe. Losing it would
  // double-post a journal already in the ledger.
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: null, unearnedRevenueAmount: 120 }]
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: null, allocationBatchAmount: 80 }]
  shipmentRows = [{ shipmentJournalDate: STAMP_NEXT_DAY, shipmentJournalBatchRef: null, revenueRecognizedAmount: 60, cogsBatchAmount: 40 }]
  syncLogs = [
    { connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-21', status: 'SYNCED' },
    { connector: 'quickbooks', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: 'A2-2026-07-21', status: 'SYNCED' },
    { connector: 'quickbooks', type: 'DAILY_BATCH_GROUP_B', referenceId: 'B-2026-07-21', status: 'PENDING' },
  ]

  await runQboSweep()

  assert.deepEqual(created, [], 'a bucket with no known identity must keep the derived probe')
})

test('QuickBooks: an UNPARSEABLE persisted ref still widens to the derived probe (o3d-0qoo r1)', async () => {
  for (const badRef of ['A1-2026-7-20', 'INVRECON-2026-07-20', 'A1-2026-07-20-ABCDEF12']) {
    reset()
    salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: badRef, unearnedRevenueAmount: 120 }]
    syncLogs = [{ connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-21', status: 'SYNCED' }]

    await runQboSweep()

    assert.deepEqual(created, [], `an unparseable ref (${badRef}) must not narrow the probe and double-post`)
  }
})

test('QuickBooks: a live log for ANOTHER connector never counts as this one (o3d-0qoo)', async () => {
  reset()
  salesOrderRows.a1 = [{ revenueDeferredDate: STAMP_NEXT_DAY, revenueDeferredBatchRef: QBO_A1_REF, unearnedRevenueAmount: 120 }]
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: QBO_A1_REF, status: 'SYNCED' }]

  await runQboSweep()

  assert.equal(created.length, 1, 'the QuickBooks ledger is still missing this journal')
  assert.equal(created[0].referenceId, QBO_A1_REF)
})

// ---------------------------------------------------------------------------
// o3d-o97 r3 — a debit nothing will ever relieve must not be rebuilt.
// ---------------------------------------------------------------------------

test('o3d-o97 r3: a FULLY REFUNDED order never has its A2 journal recreated, on either connector', async () => {
  // Group A2 and Group B both exclude `refundStatus: FULL` for ever, so an A2 debit posted under
  // a fully-refunded order has nothing left in IMS that can relieve it. That used to be
  // unreachable here because the refund path always cleared the A2 stamp; it is reachable now,
  // because a refund that CANNOT account for the debit deliberately KEEPS the stamp so the
  // standing invariants can still report the order to a human.
  //
  // The A2 log below is CANCELLED and carries the orphan sweep's `abandonedBeforeRemoteCall` record,
  // so o3d-o97 r6 has positive evidence the journal never reached a ledger and would otherwise
  // rebuild it. Without the refundStatus exclusion the sweep would answer the refund's refusal by
  // posting a brand-new, permanently unrelievable debit under the very order being held open for
  // someone to resolve.
  for (const [label, ref, run] of [
    ['xero', XERO_A2_REF, runXeroSweep],
    ['quickbooks', QBO_A2_REF, runQboSweep],
  ] as const) {
    reset()
    salesOrderRows.a2 = [{
      inventoryAllocatedDate: STAMP_NEXT_DAY,
      inventoryAllocatedBatchRef: ref,
      allocationBatchAmount: 80,
      refundStatus: 'FULL',
    }]
    syncLogs = [{ connector: label, type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: ref, status: 'CANCELLED', abandonedBeforeRemoteCall: true }]

    await run()

    assert.deepEqual(created, [], `${label}: no A2 journal may be rebuilt for a fully-refunded order`)
  }

  // The mirror, so the exclusion is a filter rather than a blanket refusal: the SAME row on a
  // partially-refunded order still gets its missing journal rebuilt, for the full £80.
  reset()
  salesOrderRows.a2 = [{
    inventoryAllocatedDate: STAMP_NEXT_DAY,
    inventoryAllocatedBatchRef: XERO_A2_REF,
    allocationBatchAmount: 80,
    refundStatus: 'PARTIAL',
  }]
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: XERO_A2_REF, status: 'CANCELLED', abandonedBeforeRemoteCall: true }]

  await runXeroSweep()

  assert.equal(created.length, 1, 'a partially-refunded order is still inside both windows')
  assert.equal(created[0].type, 'DAILY_BATCH_INVENTORY_ALLOC')
  const debit = (created[0].payload.lines as Array<{ accountCode?: string; debit?: number }>)
    .find((line) => line.accountCode === '631' && line.debit != null)
  assert.equal(debit?.debit, 80)
})

// ---------------------------------------------------------------------------
// o3d-o97 r6 — A CANCELLED LOG IS NOT PROOF THE BATCH MUST BE POSTED AGAIN
//
// r5 made CANCELLED stop being proof that a debit DID NOT post, everywhere a refund or an un-stage
// reads it. The recreate sweep read the SAME status as proof it MUST post again: CANCELLED was not
// in ('PENDING','PROCESSING','SYNCED'), so the probe's query returned nothing, so the batch was
// rebuilt. Two readers, opposite conclusions, one fact — and this is the reader that writes to a
// real ledger, so where the other one stranded pounds this one DOUBLES them.
//
// WORKED (the assertions below are this, at 1/1 scale): A2 stages an order into journal J for £80
// and J reaches Xero. J is later marked CANCELLED — by the orphan sweep during a connector switch,
// or by an operator. The next daily run finds the order still stamped, sees no "live" log, and
// queues a SECOND £80 DR Allocated Inventory / CR Inventory. The account then holds £160 for £80 of
// allocations while the order records one £80 share, so the eventual refund can only reverse half.
// r5 made this MORE reachable, not less: it stopped the un-stage sites clearing the stamp on a
// cancelled journal, so those orders now STAY in this sweep's candidate set.
// ---------------------------------------------------------------------------

test('Xero: a CANCELLED A2 log blocks the rebuild and is REPORTED, not silently skipped (o3d-o97 r6)', async () => {
  reset()
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: XERO_A2_REF, allocationBatchAmount: 80 }]
  // Cancelled with NO record of why: the row does not say the remote call was never made, so it may
  // already be in the ledger.
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: XERO_A2_REF, status: 'CANCELLED', id: 'log-a2-J' }]

  const refusals = await runXeroSweep()

  assert.deepEqual(created, [], 'rebuilding here posts a second £80 DR Allocated Inventory for one £80 allocation')
  assert.equal(refusals.length, 1, 'the refusal must reach the run, or the double-post is only avoided silently')
  assert.match(refusals[0], /DAILY_BATCH_INVENTORY_ALLOC/)
  assert.match(refusals[0], /log-a2-J, CANCELLED/, 'the refusal names the row a human has to go and settle')
})

test('Xero: a CANCELLED Group B log blocks the rebuild AND its DISPATCH subledger row (o3d-o97 r6)', async () => {
  reset()
  shipmentRows = [{ id: 'ship-1', shipmentJournalDate: STAMP_NEXT_DAY, shipmentJournalBatchRef: XERO_B_REF, revenueRecognizedAmount: 60, cogsBatchAmount: 40 }]
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_GROUP_B', referenceId: XERO_B_REF, status: 'CANCELLED', id: 'log-b-J' }]

  const refusals = await runXeroSweep()

  assert.deepEqual(created, [], 'a second Group B journal would re-recognise £60 of revenue and re-book £40 of COGS')
  assert.deepEqual(cogsMovements, [], 'and the subledger row must not be written for a journal that was not raised')
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], /log-b-J, CANCELLED/)
})

test('Xero: a CANCELLED log the orphan sweep recorded as PRE-CALL is still rebuilt, for its own amount (o3d-o97 r6)', async () => {
  reset()
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: XERO_A2_REF, allocationBatchAmount: 80 }]
  // `abandonedBeforeRemoteCall` is written ONLY by cancelOrphanedRowsUnderLock, whose predicate is
  // `status = 'PENDING'` — provably pre-call, nothing was sent. That is positive evidence, so the
  // journal genuinely is in no ledger and the batch may be raised.
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_INVENTORY_ALLOC', referenceId: XERO_A2_REF, status: 'CANCELLED', abandonedBeforeRemoteCall: true }]

  const refusals = await runXeroSweep()

  assert.deepEqual(refusals, [], 'proved pre-call is not a refusal')
  assert.equal(created.length, 1, 'refusing here would strand every batch lost to a connector switch')
  const debit = (created[0].payload.lines as Array<{ accountCode?: string; debit?: number }>)
    .find((line) => line.accountCode === '631' && line.debit != null)
  assert.equal(debit?.debit, 80, 'rebuilt for the batch\'s own £80, not a re-valued figure')
})

test('Xero: an external transaction id outranks a pre-call claim written over the top of it (o3d-o97 r6)', async () => {
  reset()
  salesOrderRows.a2 = [{ inventoryAllocatedDate: STAMP_NEXT_DAY, inventoryAllocatedBatchRef: XERO_A2_REF, allocationBatchAmount: 80 }]
  // The id exists only because the remote call RETURNED, so it is the ledger's own receipt. A row
  // that carries one and also claims to be pre-call is contradicting itself, and the receipt wins.
  syncLogs = [{
    connector: 'xero',
    type: 'DAILY_BATCH_INVENTORY_ALLOC',
    referenceId: XERO_A2_REF,
    status: 'CANCELLED',
    abandonedBeforeRemoteCall: true,
    externalTransactionId: 'xero-manual-journal-77',
    id: 'log-a2-K',
  }]

  const refusals = await runXeroSweep()

  assert.deepEqual(created, [], 'the journal is in Xero — rebuilding it is a duplicate whatever the row now claims')
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], /external id xero-manual-journal-77/)
})

test('Xero: one cancelled split blocks only ITS half — the other half still rebuilds (o3d-o97 r6)', async () => {
  reset()
  salesOrderRows.a1 = [
    { revenueDeferredDate: new Date('2026-07-20T09:00:00.000Z'), revenueDeferredBatchRef: 'A1-2026-07-20-aaaaaaaa', unearnedRevenueAmount: 100 },
    { revenueDeferredDate: new Date('2026-07-20T17:30:00.000Z'), revenueDeferredBatchRef: 'A1-2026-07-20-bbbbbbbb', unearnedRevenueAmount: 25 },
  ]
  syncLogs = [{ connector: 'xero', type: 'DAILY_BATCH_REVENUE_DEFERRAL', referenceId: 'A1-2026-07-20-aaaaaaaa', status: 'CANCELLED', id: 'log-a1-aaaa' }]

  const refusals = await runXeroSweep()

  assert.equal(created.length, 1, 'the block is per batch identity, not a blanket stop on the run')
  assert.equal(created[0].referenceId, 'A1-2026-07-20-bbbbbbbb')
  assert.match(String(created[0].payload.narration), /1 order\(s\), £25\.00/)
  assert.equal(refusals.length, 1)
  assert.match(refusals[0], /log-a1-aaaa, CANCELLED/)
})
