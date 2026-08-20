import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dailyBatchDateKey,
  dailyBatchReferenceWhere,
  findSalesOrderDeleteBlocker,
} from '@/lib/domain/sales/order-delete-guard'

type SyncLogRow = {
  id: string
  connector: string
  type: string
  status: string
  referenceType: string
  referenceId: string
  /** Post evidence. Present once the document exists in the ledger, regardless of status. */
  externalTransactionId?: string | null
}

type WhereNode = Record<string, unknown>

/**
 * Tiny evaluator for the exact `where` shapes order-delete-guard builds: scalar equality,
 * `{ in: [...] }`, `{ startsWith }` and `OR`. Deliberately strict — an unsupported operator
 * throws rather than silently matching, so a future guard change that emits something new
 * fails loudly here instead of quietly passing.
 */
function matches(row: SyncLogRow, where: WhereNode): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      const branches = condition as WhereNode[]
      if (!branches.some((branch) => matches(row, branch))) return false
      continue
    }
    if (key === 'AND') {
      const branches = condition as WhereNode[]
      if (!branches.every((branch) => matches(row, branch))) return false
      continue
    }
    const value = (row as unknown as Record<string, unknown>)[key]
    if (condition !== null && typeof condition === 'object') {
      const operators = condition as Record<string, unknown>
      for (const [operator, operand] of Object.entries(operators)) {
        if (operator === 'in') {
          if (!(operand as unknown[]).includes(value)) return false
        } else if (operator === 'startsWith') {
          if (typeof value !== 'string' || !value.startsWith(operand as string)) return false
        } else if (operator === 'not') {
          // Only `{ not: null }` is emitted — "carries an external id, whatever its status".
          if (operand === null) {
            if (value === null || value === undefined) return false
          } else if (value === operand) {
            return false
          }
        } else {
          throw new Error(`unsupported operator in test evaluator: ${operator}`)
        }
      }
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function makeTx(seed: {
  pushLink?: {
    state: string
    externalOrderId: string | null
    externalOrderNumber: string | null
    /** o3d-92fu: REMOTE attempts. Defaults to 0/null so every pre-existing case is unchanged. */
    attempts?: number
    pushedAt?: Date | null
  } | null
  /**
   * Shipment ids, or full rows when the test cares about Group B staging (o3d-0qoo).
   * A bare id means "never journalled", which is what every pre-existing test assumes.
   */
  shipments?: Array<string | { id: string; shipmentJournalDate?: Date | null; shipmentJournalBatchRef?: string | null }>
  syncLogs?: SyncLogRow[]
  /** Durable external-document markers on the order itself — these survive log retention. */
  order?: { accountingInvoiceId?: string | null; invoicedAt?: Date | null }
  /** Independent WMS evidence: a status snapshot can exist with no push link. */
  wmsSnapshot?: {
    connectorLabel: string
    externalOrderNumber: string
    externalOrderId: string
    statusLabel: string
    lastError?: string | null
  } | null
  /** A deliberately parked WooCommerce refund — creates no SalesOrderRefund (o3d-7yf). */
  parkedRefund?: { id: string } | null
}) {
  return {
    wmsOrderStatusSnapshot: { findUnique: async () => seed.wmsSnapshot ?? null },
    shoppingSyncLog: { findFirst: async () => seed.parkedRefund ?? null },
    salesOrder: {
      findUnique: async () => ({
        accountingInvoiceId: seed.order?.accountingInvoiceId ?? null,
        invoicedAt: seed.order?.invoicedAt ?? null,
      }),
    },
    wmsOrderPushLink: {
      findUnique: async () => (seed.pushLink ? { attempts: 0, pushedAt: null, ...seed.pushLink } : null),
    },
    shipment: {
      findMany: async () => (seed.shipments ?? []).map((shipment) => (
        typeof shipment === 'string'
          ? { id: shipment, shipmentJournalDate: null, shipmentJournalBatchRef: null }
          : { shipmentJournalDate: null, shipmentJournalBatchRef: null, ...shipment }
      )),
    },
    accountingSyncLog: {
      findFirst: async ({ where }: { where: WhereNode }) =>
        (seed.syncLogs ?? []).find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: WhereNode }) =>
        (seed.syncLogs ?? []).filter((row) => matches(row, where)),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const STAMPS = {
  revenueDeferredDate: null,
  inventoryAllocatedDate: null,
  revenueDeferredBatchRef: null,
  inventoryAllocatedBatchRef: null,
}
const A2_STAGED_AT = new Date('2026-07-20T23:15:00.000Z')
/** o3d-0qoo: stamped just after midnight by a run whose batch was keyed on the previous day. */
const PAST_MIDNIGHT = new Date('2026-07-21T00:04:00.000Z')

function syncLog(overrides: Partial<SyncLogRow>): SyncLogRow {
  return {
    id: 'log-1',
    connector: 'xero',
    type: 'SALES_INVOICE',
    status: 'PENDING',
    referenceType: 'SalesOrder',
    referenceId: 'order-1',
    externalTransactionId: null,
    ...overrides,
  }
}

test('dailyBatchDateKey maps a stage stamp to the batch UTC date, and null through', () => {
  assert.equal(dailyBatchDateKey(A2_STAGED_AT), '2026-07-20')
  assert.equal(dailyBatchDateKey('2026-07-20T23:15:00.000Z'), '2026-07-20')
  assert.equal(dailyBatchDateKey(null), null)
  assert.equal(dailyBatchDateKey(new Date('not a date')), null)
})

test('dailyBatchReferenceWhere matches both the bare and digest-suffixed referenceId shapes', () => {
  const where = dailyBatchReferenceWhere('A2', A2_STAGED_AT)
  assert.ok(where)
  // QuickBooks writes the bare `<group>-<date>`; Xero appends an 8-hex entity digest.
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-20' }), where as WhereNode), true)
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-20-1a2b3c4d' }), where as WhereNode), true)
  // A different day's batch must not match.
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-21' }), where as WhereNode), false)
  assert.equal(dailyBatchReferenceWhere('A2', null), null)
})

test('o3d-0qoo: a persisted reference is matched in ADDITION to the derived shapes', () => {
  // The union is deliberate. This guard refuses an irreversible delete, so it must never match
  // a smaller set than it did before the column existed — a persisted reference that somehow
  // disagreed with the real log would otherwise open exactly the hole it was added to close.
  const where = dailyBatchReferenceWhere('A2', PAST_MIDNIGHT, 'A2-2026-07-20-1a2b3c4d') as WhereNode
  assert.ok(where)
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-20-1a2b3c4d' }), where), true)
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-21' }), where), true)
  // Neither the stored identity nor the stamp's own day — still no match.
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-19' }), where), false)
  // A reference with no stamp at all is enough on its own.
  const refOnly = dailyBatchReferenceWhere('A2', null, 'A2-2026-07-20-1a2b3c4d') as WhereNode
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-20-1a2b3c4d' }), refOnly), true)
  assert.equal(matches(syncLog({ referenceId: 'A2-2026-07-20' }), refOnly), false)
  assert.equal(dailyBatchReferenceWhere('A2', null, null), null)
})

test('an order with no external documents is deletable', async () => {
  const blocker = await findSalesOrderDeleteBlocker(makeTx({}), 'order-1', STAMPS)
  assert.equal(blocker, null)
})

test('a WMS push link — even a pre-push PENDING_CREATE claim — blocks the delete', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ pushLink: { state: 'PENDING_CREATE', externalOrderId: null, externalOrderNumber: null } }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'wms_order_push_link')
  assert.match(blocker!.message, /warehouse management system/i)
})

test('o3d-92fu: a VALIDATION_FAILED link with NO remote attempts does NOT block the delete', async () => {
  // The push sweep writes this disposition BEFORE it claims anything and BEFORE it calls the
  // connector — buildPushInput threw on local data, so pushOrder was never invoked and no
  // remote side effect is possible. Blocking on it made a purely local data error (a line with
  // no SKU) an unrecoverable, permanently undeletable order.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ pushLink: { state: 'VALIDATION_FAILED', externalOrderId: null, externalOrderNumber: null, attempts: 0, pushedAt: null } }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker, null)
})

test('o3d-92fu: a VALIDATION_FAILED link that ALREADY spent remote attempts still blocks', async () => {
  // The state alone is not the licence. A link can reach VALIDATION_FAILED having pushed and
  // failed remotely first and only later stopped building; those calls are exactly as ambiguous
  // as any other dead letter, and the refusal must say so rather than citing the state.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ pushLink: { state: 'VALIDATION_FAILED', externalOrderId: null, externalOrderNumber: null, attempts: 3, pushedAt: null } }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'wms_order_push_link')
  assert.match(blocker!.message, /3 push attempt\(s\) were made before its payload became invalid/)
})

test('o3d-92fu: a VALIDATION_FAILED link carrying an external id still blocks', async () => {
  // Zero attempts but a remote id is a contradiction that can only mean the row was written by
  // something other than the pre-call path. Fail closed: an id is positive evidence the
  // warehouse holds this order.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ pushLink: { state: 'VALIDATION_FAILED', externalOrderId: 'wms-77', externalOrderNumber: 'WN-77', attempts: 0, pushedAt: null } }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'wms_order_push_link')
  assert.match(blocker!.message, /WN-77/)
})

test('a SYNCED WMS link names the external order in the refusal', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ pushLink: { state: 'SYNCED', externalOrderId: 'wms-9', externalOrderNumber: 'WN-9' } }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'wms_order_push_link')
  assert.match(blocker!.message, /WN-9/)
})

test('a queued (PENDING) invoice blocks the delete — the worker has not posted yet, but will', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'PENDING' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /SALES_INVOICE, PENDING/)
})

test('an in-flight (PROCESSING) and an already-posted (SYNCED) invoice both block', async () => {
  for (const status of ['PROCESSING', 'SYNCED']) {
    const blocker = await findSalesOrderDeleteBlocker(
      makeTx({ syncLogs: [syncLog({ status })] }),
      'order-1',
      STAMPS,
    )
    assert.equal(blocker?.code, 'accounting_sync_live', status)
  }
})

test('a CANCELLED sync row does not block — it was deliberately retired', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'CANCELLED' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker, null)
})

test('a FAILED sync row DOES block — it is not proof nothing was posted (o3d-ju8t)', async () => {
  // This test previously asserted the opposite. The accounting processors make the remote call
  // BEFORE persisting SYNCED and the externalTransactionId, and an exception in that persistence
  // window is caught and can later terminalise the row as FAILED — with a real document sitting
  // in the ledger. So FAILED spans "rejected before any remote mutation" and "document exists,
  // writeback failed", and nothing durable tells them apart. Permitting an irreversible delete on
  // that basis reads absence of a success marker as a positive fact about the external system.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'FAILED' })] }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /does not prove nothing was posted/)
  assert.match(blocker!.message, /may exist in the ledger/)
})

test('a live sync row for a DIFFERENT order does not block', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ referenceId: 'order-2' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker, null)
})

test('a live sync row keyed to one of the order\'s shipments blocks', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      shipments: ['ship-1'],
      syncLogs: [syncLog({ type: 'COGS_JOURNAL', referenceType: 'Shipment', referenceId: 'ship-1', status: 'SYNCED' })],
    }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'accounting_sync_live')
})

test('a POSTED A2 batch blocks even though the batch is DailyBatch-keyed, not order-keyed', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a2',
        type: 'DAILY_BATCH_INVENTORY_ALLOC',
        status: 'SYNCED',
        referenceType: 'DailyBatch',
        referenceId: 'A2-2026-07-20-1a2b3c4d',
      })],
    }),
    'order-1',
    { ...STAMPS, inventoryAllocatedDate: A2_STAGED_AT },
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
  assert.match(blocker!.message, /A2 inventory allocation/)
  assert.match(blocker!.message, /A2-2026-07-20-1a2b3c4d/)
})

test('a still-queued A2 batch blocks too — the order value is already inside the journal payload', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a2', type: 'DAILY_BATCH_INVENTORY_ALLOC', status: 'PENDING',
        referenceType: 'DailyBatch', referenceId: 'A2-2026-07-20',
      })],
    }),
    'order-1',
    { ...STAMPS, inventoryAllocatedDate: A2_STAGED_AT },
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
})

test('an A2 stamp with no matching batch log does not block (batch never queued)', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a2', type: 'DAILY_BATCH_INVENTORY_ALLOC', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A2-2026-07-19',
      })],
    }),
    'order-1',
    { ...STAMPS, inventoryAllocatedDate: A2_STAGED_AT },
  )
  assert.equal(blocker, null)
})

test('a posted A1 revenue-deferral batch blocks on the same DailyBatch-keyed rule', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a1', type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A1-2026-07-20-deadbeef',
      })],
    }),
    'order-1',
    { ...STAMPS, revenueDeferredDate: A2_STAGED_AT },
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
  assert.match(blocker!.message, /A1 revenue deferral/)
})

test('an A2 batch log of the right date but wrong TYPE does not block', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'b', type: 'DAILY_BATCH_GROUP_B', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A2-2026-07-20',
      })],
    }),
    'order-1',
    { ...STAMPS, inventoryAllocatedDate: A2_STAGED_AT },
  )
  assert.equal(blocker, null)
})

// --- o3d-0qoo: batch identity is STORED, not re-derived from the stage stamp --------------
//
// Both daily-sync implementations capture the batch date ONCE at run start and write the stage
// stamps with later new Date() calls, so a run crossing UTC midnight keys the batch on day D
// and stamps its members D+1. Every one of these cases would pass the guard before o3d-0qoo:
// the derived reference names a batch that does not exist, the guard reports no blocker, and an
// order whose value is inside a queued or posted journal is hard-deleted.

test('o3d-0qoo: an A2 batch staged across UTC midnight blocks — Xero digest reference', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a2', type: 'DAILY_BATCH_INVENTORY_ALLOC', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A2-2026-07-20-1a2b3c4d',
      })],
    }),
    'order-1',
    {
      ...STAMPS,
      inventoryAllocatedDate: PAST_MIDNIGHT,
      inventoryAllocatedBatchRef: 'A2-2026-07-20-1a2b3c4d',
    },
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
  assert.match(blocker!.message, /A2-2026-07-20-1a2b3c4d/)
})

test('o3d-0qoo: an A1 batch staged across UTC midnight blocks — bare QuickBooks reference', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a1', connector: 'quickbooks', type: 'DAILY_BATCH_REVENUE_DEFERRAL', status: 'PENDING',
        referenceType: 'DailyBatch', referenceId: 'A1-2026-07-20',
      })],
    }),
    'order-1',
    { ...STAMPS, revenueDeferredDate: PAST_MIDNIGHT, revenueDeferredBatchRef: 'A1-2026-07-20' },
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
  assert.match(blocker!.message, /A1 revenue deferral/)
})

test('o3d-0qoo: a Group B shipment batch staged across UTC midnight blocks', async () => {
  // Group B stamps the SHIPMENTS, not the order, and the shipment FK cascades — so deleting the
  // order erases the only local record of what the journal was built from.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      shipments: [{
        id: 'ship-1',
        shipmentJournalDate: PAST_MIDNIGHT,
        shipmentJournalBatchRef: 'B-2026-07-20-abcd1234',
      }],
      syncLogs: [syncLog({
        id: 'b', type: 'DAILY_BATCH_GROUP_B', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'B-2026-07-20-abcd1234',
      })],
    }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
  assert.match(blocker!.message, /B shipment revenue\/COGS/)
})

test('o3d-0qoo: a legacy row with no persisted reference still blocks via the derived key', async () => {
  // Pre-migration rows carry no batch reference and will not for as long as they exist, so the
  // derive-from-stamp path has to keep working exactly as it did.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      shipments: [{ id: 'ship-1', shipmentJournalDate: A2_STAGED_AT, shipmentJournalBatchRef: null }],
      syncLogs: [syncLog({
        id: 'b', type: 'DAILY_BATCH_GROUP_B', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'B-2026-07-20',
      })],
    }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker?.code, 'daily_batch_staged')
})

test('o3d-0qoo: a persisted reference whose batch log does not exist does NOT block', async () => {
  // Guards against the fix becoming vacuous: matching on identity must still find nothing when
  // there is nothing to find — a batch that produced no journal must not pin the order forever.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [syncLog({
        id: 'a2', type: 'DAILY_BATCH_INVENTORY_ALLOC', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'A2-2026-07-19-99999999',
      })],
    }),
    'order-1',
    {
      ...STAMPS,
      inventoryAllocatedDate: PAST_MIDNIGHT,
      inventoryAllocatedBatchRef: 'A2-2026-07-20-1a2b3c4d',
    },
  )
  assert.equal(blocker, null)
})

test('o3d-0qoo: an unjournalled shipment contributes no Group B check', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      shipments: ['ship-1'],
      syncLogs: [syncLog({
        id: 'b', type: 'DAILY_BATCH_GROUP_B', status: 'SYNCED',
        referenceType: 'DailyBatch', referenceId: 'B-2026-07-20-abcd1234',
      })],
    }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker, null)
})

// --- o3d-v7sy: evidence that survives log retention ---------------------------

test('an order carrying an accounting invoice id blocks, even with no sync logs left', async () => {
  // Every other check in this guard reads AccountingSyncLog, and purgeExpiredData deletes those
  // rows past the retention window (six months by default). An old order can therefore hold a
  // real invoice in the external ledger, have no retained sync row, and pass every other check —
  // hard-deleted, stranding the document with no IMS order behind it. accountingInvoiceId and
  // invoicedAt live on the order itself and are never purged.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [], order: { accountingInvoiceId: 'INV-2026-0042' } }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_document_exists')
  assert.match(blocker!.message, /INV-2026-0042/)
})

test('invoicedAt alone does NOT block — it is a LOCAL invoice number, not an external post', async () => {
  // generateInvoiceNumber sets invoicedAt when it merely assigns a local invoice number
  // (app/actions/sales.ts ~2680), and that action is available even with accounting sync
  // disabled. Treating it as external-post evidence would make an otherwise deletable order
  // with no payments, no sync logs and no accounting document permanently undeletable.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [], order: { invoicedAt: new Date('2025-01-01T00:00:00.000Z') } }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker, null)
})

test('a POSTED document says it needs a REVERSAL, not a cancel (o3d-v7sy)', async () => {
  // cancelOrderInvoiceSync retires PENDING / FAILED / stale-PROCESSING rows and explicitly
  // leaves SYNCED alone, because a cancel-after-post needs an explicit reversal. Telling an
  // operator to cancel a posted invoice leaves a live receivable against a CANCELLED order.
  const posted = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'SYNCED' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(posted?.code, 'accounting_sync_live')
  assert.match(posted!.message, /explicit reversal or credit note/)
  assert.match(posted!.message, /does NOT reverse a posted document/)

  // A merely QUEUED document is genuinely retired by cancelling, so that advice stays.
  const queued = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'PENDING' })] }),
    'order-1',
    STAMPS,
  )
  assert.match(queued!.message, /Cancel the order instead/)
})

test('an order with neither marker nor logs is still deletable', async () => {
  const blocker = await findSalesOrderDeleteBlocker(makeTx({ syncLogs: [] }), 'order-1', STAMPS)
  assert.equal(blocker, null)
})

test('a PENDING row that already carries an external id is treated as POSTED (o3d-v7sy)', async () => {
  // Status is not a proxy for post evidence. Xero reverts an already-posted row to PENDING when
  // follow-up work fails, KEEPING externalTransactionId — and cancelOrderInvoiceSync excludes
  // such rows. Branching on status alone would tell an operator to cancel a document that is
  // already in the ledger, leaving a live receivable against a CANCELLED order.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'PENDING', externalTransactionId: 'INV-999' })] }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /already POSTED as INV-999/)
  assert.match(blocker!.message, /does NOT reverse a posted document/)
  assert.doesNotMatch(blocker!.message, /Cancel the order instead/)
})

test('an in-flight PROCESSING row asks the operator to WAIT, not to cancel (o3d-v7sy)', async () => {
  // A freshly claimed PROCESSING row is deliberately excluded from cancellation — the remote
  // call may be in flight — so promising a cancel retires it is wrong here too.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'PROCESSING' })] }),
    'order-1',
    STAMPS,
  )

  assert.match(blocker!.message, /IN FLIGHT/)
  assert.doesNotMatch(blocker!.message, /Cancel the order instead/)
})


test('a CANCELLED row that still carries an external id BLOCKS (o3d-v7sy)', async () => {
  // The status filter used to run first, so this row was never even selected. Xero can revert a
  // posted row to PENDING when the back-reference fails, keeping the external id, and
  // cancelOrphanedAccountingSyncRows then moves it to CANCELLED without clearing that id. If the
  // back-reference failed there is no accountingInvoiceId either — so nothing would have blocked,
  // and the posted invoice would have been stranded.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'CANCELLED', externalTransactionId: 'INV-777' })] }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /already POSTED as INV-777/)
})

test('a POSTED row wins over a QUEUED one when both exist (o3d-v7sy)', async () => {
  // findFirst could return whichever row the database happened to yield, so a queued row could
  // mask a posted one and the operator would be told to cancel a document already in the ledger.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      syncLogs: [
        syncLog({ id: 'log-queued', status: 'PENDING', type: 'COGS_JOURNAL' }),
        syncLog({ id: 'log-posted', status: 'SYNCED', externalTransactionId: 'INV-888' }),
      ],
    }),
    'order-1',
    STAMPS,
  )

  assert.match(blocker!.message, /already POSTED as INV-888/, 'the most severe remedy wins')
  assert.doesNotMatch(blocker!.message, /Cancel the order instead/)
})

test('a CANCELLED row with NO external id still does not block', async () => {
  // The widened match must not turn every retired row into a blocker.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({ syncLogs: [syncLog({ status: 'CANCELLED' })] }),
    'order-1',
    STAMPS,
  )
  assert.equal(blocker, null)
})



test('a WMS status snapshot blocks even with NO push link (o3d-eu0r)', async () => {
  // WmsOrderStatusSnapshot is populated by looking storefront-linked orders up in the WMS, so it
  // can carry a confirmed externalOrderId for an order this IMS never pushed. Its FK is
  // onDelete: Cascade, so deleting would silently erase the only local record that the remote
  // order exists — leaving a live warehouse order nothing in IMS points at.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'WMS-4321',
        externalOrderId: '4321',
        statusLabel: 'Processing',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'wms_order_status_snapshot')
  assert.match(blocker!.message, /WMS-4321/)
  assert.match(blocker!.message, /erase the only local record/)
})

test('the snapshot falls back to the external id when it has no order number (o3d-eu0r)', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'ShipHero',
        externalOrderNumber: '',
        externalOrderId: 'sh-99',
        statusLabel: 'Allocated',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.match(blocker!.message, /sh-99/)
})

test('a CONFIRMED-ABSENT snapshot does NOT block (o3d-eu0r)', async () => {
  // order-status-sweep deliberately upserts a placeholder with an EMPTY externalOrderId,
  // statusLabel 'Unknown' and lastError 'Order not found in WMS' when an authoritative lookup
  // finds no order — and again after a lookup error. Nothing ever removes those rows. Treating
  // any snapshot as proof would make a storefront-linked order that never reached the WMS
  // permanently undeletable, while the refusal claimed a remote order exists.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'SO-1',
        externalOrderId: '',
        statusLabel: 'Unknown',
        lastError: 'Order confirmed absent in WMS (presence-probed)',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker, null, 'positive evidence only — an empty externalOrderId proves nothing')
})

test('an in-flight accounting document outranks WMS evidence (o3d-eu0r)', async () => {
  // Several blockers can apply at once, and their remedies are NOT interchangeable. Returning
  // the WMS one first told the operator to cancel while an accounting call was still in flight —
  // which is exactly how a cancelled IMS order ends up with a live invoice in the ledger.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'WMS-1',
        externalOrderId: '1',
        statusLabel: 'Processing',
      },
      syncLogs: [syncLog({ status: 'PROCESSING' })],
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_sync_live')
  assert.match(blocker!.message, /IN FLIGHT/)
})

test('a POSTED accounting document outranks everything else (o3d-eu0r)', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: { state: 'SYNCED', externalOrderId: 'w-1', externalOrderNumber: 'WMS-1' },
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'WMS-1',
        externalOrderId: '1',
        statusLabel: 'Processing',
      },
      order: { accountingInvoiceId: 'INV-1' },
      syncLogs: [syncLog({ status: 'PENDING' })],
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'accounting_document_exists', 'a finance reversal is the most binding remedy')
})

test('with only WMS evidence, the WMS remedy is still surfaced (o3d-eu0r)', async () => {
  // Ranking must not bury the only applicable blocker.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'WMS-7',
        externalOrderId: '7',
        statusLabel: 'Processing',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'wms_order_status_snapshot')
})

test('a snapshot from a FAILED lookup blocks — absence of an id is not absence of an order (o3d-eu0r)', async () => {
  // order-status-sweep writes an empty externalOrderId in two situations: an authoritative
  // not-found, and a lookup that ERRORED. Only the first is safe to delete on. Treating both as
  // proof-free lets a genuine warehouse order be orphaned whenever the lookup merely failed —
  // and nothing ever removes the row, so the wrong answer persists.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'SO-1',
        externalOrderId: '',
        statusLabel: 'Unknown',
        lastError: 'ETIMEDOUT contacting Mintsoft',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'wms_order_status_snapshot')
  assert.match(blocker!.message, /did not complete/)
  assert.match(blocker!.message, /ETIMEDOUT/)
})

test('a snapshot with NO error marker at all also fails closed (o3d-eu0r)', async () => {
  // An unrecognised placeholder shape must not be read as "authoritatively absent".
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'SO-1',
        externalOrderId: '',
        statusLabel: 'Unknown',
        lastError: null,
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'wms_order_status_snapshot')
  assert.match(blocker!.message, /no result recorded/)
})

test('an AMBIGUOUS lookup snapshot blocks — several orders match, so one may be real (o3d-x9nc)', async () => {
  // The paired half of the sweep change: the sweep now records ambiguity distinctly, and the
  // guard must treat anything that is not the authoritative not-found marker as unresolved.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'SO-1',
        externalOrderId: '',
        statusLabel: 'Unknown',
        lastError: 'WMS lookup ambiguous — several orders match this reference',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'wms_order_status_snapshot')
  assert.match(blocker!.message, /did not complete/)
})

test('a LEGACY not-found snapshot DOES block — it never distinguished absent from ambiguous (o3d-eu0r)', async () => {
  // Rows written before the presence probe recorded every null fetch as this literal, ambiguous
  // ones included. Accepting it would keep permitting deletion on a snapshot that cannot support
  // the conclusion. Refreshing is not a safe compatibility mechanism either — the sweep is
  // optional and batch-limited, so it may not have reached this order.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: null,
      wmsSnapshot: {
        connectorLabel: 'Mintsoft',
        externalOrderNumber: 'SO-1',
        externalOrderId: '',
        statusLabel: 'Unknown',
        lastError: 'Order not found in WMS',
      },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'wms_order_status_snapshot')
})

test('a PARKED WooCommerce refund blocks the delete, and outranks every other blocker (o3d-7yf)', async () => {
  // A park creates NO SalesOrderRefund, so the caller's `_count.refunds` check cannot see it.
  // Deleting the order cascades its ShoppingOrderLink and orphans the park, stranding a refund
  // whose money has already left the business. It outranks the rest because — unlike a WMS push
  // or queued accounting work — cancelling the order does not resolve it.
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: { state: 'SYNCED', externalOrderId: '55', externalOrderNumber: 'WMS-55' },
      parkedRefund: { id: 'log-1' },
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'parked_refund', 'the park is reported ahead of the WMS link')
  assert.match(blocker!.message, /sync exceptions inbox/)
})

test('no parked refund leaves the other blockers ranked as before (o3d-7yf)', async () => {
  const blocker = await findSalesOrderDeleteBlocker(
    makeTx({
      pushLink: { state: 'SYNCED', externalOrderId: '55', externalOrderNumber: 'WMS-55' },
      parkedRefund: null,
    }),
    'order-1',
    STAMPS,
  )

  assert.equal(blocker?.code, 'wms_order_push_link')
})
